import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInTemp, createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import { JSONFilePreset } from "lowdb/node";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import archiver from "archiver";
import dayjs from "dayjs";

const execAsync = promisify(exec);
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// Shell参数转义函数 - 防止命令注入
const shellEscape = (arg: string): string => {
  // 移除危险字符，防止命令注入
  return arg.replace(/[`$!\\]/g, '\\$&')
            .replace(/['"]/g, '\\$&')
            .replace(/[\r\n]/g, '');
};

// 验证路径安全性
function validatePath(pathStr: string): boolean {
  if (!pathStr || typeof pathStr !== "string") return false;
  // 检查危险字符
  const dangerousChars = /[;&|`$(){}[\]<>'"\\]/;
  if (dangerousChars.test(pathStr)) return false;
  // 检查路径遍历
  if (pathStr.includes("../") || pathStr.includes("..\\")) return false;
  return true;
}

// 端口验证函数
const validatePort = (port: string): number | null => {
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return null;
  }
  return portNum;
};

// 检查端口是否被占用
async function checkPortInUse(port: number): Promise<{ inUse: boolean; processInfo?: string }> {
  try {
    // 使用netstat检查端口占用情况
    const { stdout } = await execAsync(`netstat -tlnp 2>/dev/null | grep ":${port} "`);
    if (stdout.trim()) {
      // 解析进程信息
      const lines = stdout.trim().split('\n');
      const processInfos: string[] = [];
      
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 7) {
          const protocol = parts[0];
          const address = parts[3];
          const processInfo = parts[6];
          
          let processName = '未知进程';
          if (processInfo && processInfo !== '-') {
            const pid = processInfo.split('/')[0];
            if (pid && pid !== '-') {
              try {
                const { stdout: nameOutput } = await execAsync(`ps -p ${pid} -o comm= 2>/dev/null || echo "未知"`);
                processName = nameOutput.trim() || '未知进程';
              } catch {
                processName = '未知进程';
              }
            }
          }
          
          processInfos.push(`${protocol} ${address} (${processName})`);
        }
      }
      
      return {
        inUse: true,
        processInfo: processInfos.join(', ')
      };
    }
    
    return { inUse: false };
  } catch (error) {
    // 如果netstat失败，尝试使用ss命令
    try {
      const { stdout } = await execAsync(`ss -tlnp 2>/dev/null | grep ":${port} "`);
      if (stdout.trim()) {
        return {
          inUse: true,
          processInfo: '端口被占用 (详细信息获取失败)'
        };
      }
      return { inUse: false };
    } catch {
      // 如果两个命令都失败，尝试简单的端口连接测试
      try {
        await execAsync(`timeout 2 bash -c "</dev/tcp/localhost/${port}" 2>/dev/null`);
        return {
          inUse: true,
          processInfo: '端口被占用 (无法获取进程信息)'
        };
      } catch {
        return { inUse: false };
      }
    }
  }
};

// 密码复杂度验证
const validatePassword = (password: string): boolean => {
  return password.length >= 8;
};

// 配置键定义
const CONFIG_KEYS = {
  TARGET_CHAT: "ssh_target_chat",
  SSH_PORT: "ssh_ssh_port",
  PASSWORD_AUTH: "ssh_password_auth",
  PUBKEY_AUTH: "ssh_pubkey_auth"
};

// 默认配置
const DEFAULT_CONFIG: Record<string, string> = {
  [CONFIG_KEYS.TARGET_CHAT]: "me",
  [CONFIG_KEYS.SSH_PORT]: "22",
  [CONFIG_KEYS.PASSWORD_AUTH]: "no",
  [CONFIG_KEYS.PUBKEY_AUTH]: "yes"
};

// 配置管理器
class ConfigManager {
  private static db: any = null;
  private static initialized = false;
  private static initLock = false;  // 添加锁防止并发初始化
  private static configPath: string;

  private static async init(): Promise<void> {
    if (this.initialized) return;
    
    // 简单的锁机制防止并发初始化
    while (this.initLock) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    if (this.initialized) return;
    this.initLock = true;
    
    try {
      this.configPath = path.join(
        createDirectoryInAssets("sshkey"),
        "sshkey_config.json"
      );
      this.db = await JSONFilePreset<Record<string, any>>(
        this.configPath,
        { ...DEFAULT_CONFIG }
      );
      this.initialized = true;
    } catch (error) {
      console.error("[ssh] 初始化配置失败:", error);
    } finally {
      this.initLock = false;
    }
  }

  static async get(key: string, defaultValue?: string): Promise<string> {
    await this.init();
    if (!this.db) return defaultValue || DEFAULT_CONFIG[key] || "";
    const value = this.db.data[key];
    return value ?? defaultValue ?? DEFAULT_CONFIG[key] ?? "";
  }

  static async set(key: string, value: string): Promise<boolean> {
    await this.init();
    if (!this.db) return false;
    try {
      this.db.data[key] = value;
      await this.db.write();
      return true;
    } catch (error) {
      console.error(`[ssh] 设置配置失败 ${key}:`, error);
      return false;
    }
  }
}

// 帮助文本
// SSH服务重启通用函数
const restartSSHService = async (): Promise<{ success: boolean; command?: string }> => {
  const commands = [
    "systemctl restart sshd",
    "systemctl restart ssh",
    "service sshd restart",
    "service ssh restart",
    "/etc/init.d/ssh restart"
  ];
  
  for (const cmd of commands) {
    try {
      await execAsync(cmd);
      return { success: true, command: cmd };
    } catch {
      continue;
    }
  }
  return { success: false };
};

// SSH配置修改通用函数
const modifySSHConfig = async (
  key: string,
  value: string,
  backup: boolean = true
): Promise<string> => {
  const timestamp = dayjs().format("YYYYMMDD_HHmmss");
  
  if (backup) {
    await execAsync(`cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup.${timestamp}`);
  }
  
  // 使用安全的配置修改方式
  const escapedKey = shellEscape(key);
  const escapedValue = shellEscape(value);
  
  // 修改或添加配置
  await execAsync(`sed -i 's/^#*${escapedKey} .*/${escapedKey} ${escapedValue}/' /etc/ssh/sshd_config`);
  
  // 确保没有重复配置
  await execAsync(`grep -q '^${escapedKey} ${escapedValue}$' /etc/ssh/sshd_config || echo '${escapedKey} ${escapedValue}' >> /etc/ssh/sshd_config`);
  
  // 验证配置文件语法
  await execAsync(`sshd -t`);
  
  return timestamp;
};

const help_text = `🔐 <b>SSH管理插件</b>

<b>密钥管理：</b>
• <code>${mainPrefix}ssh</code> - 生成新SSH密钥对(追加模式)
• <code>${mainPrefix}ssh gen</code> - 生成新SSH密钥对(追加模式)
• <code>${mainPrefix}ssh gen replace</code> - 生成新密钥并替换所有旧密钥
• <code>${mainPrefix}ssh gen add</code> - 生成新密钥并追加到现有密钥
• <code>${mainPrefix}ssh keys</code> - 查看当前授权的所有密钥
• <code>${mainPrefix}ssh keys clear</code> - 清空所有授权密钥

<b>服务器配置：</b>
• <code>${mainPrefix}ssh passwd &lt;新密码&gt;</code> - 修改root密码
• <code>${mainPrefix}ssh port &lt;端口号&gt;</code> - 修改SSH端口
• <code>${mainPrefix}ssh pwauth on/off</code> - 开启/关闭密码登录
• <code>${mainPrefix}ssh keyauth on/off</code> - 开启/关闭密钥登录  
• <code>${mainPrefix}ssh rootlogin on/off/keyonly</code> - 控制root登录方式
• <code>${mainPrefix}ssh open &lt;端口&gt;</code> - 开放防火墙端口
• <code>${mainPrefix}ssh close &lt;端口&gt;</code> - 关闭防火墙端口
• <code>${mainPrefix}ssh restart</code> - 重启SSH服务

<b>管理命令：</b>
• <code>${mainPrefix}ssh set @username</code> - 设置发送到指定用户
• <code>${mainPrefix}ssh set me</code> - 重置为默认发送到收藏夹
• <code>${mainPrefix}ssh info</code> - 查看SSH状态和配置
• <code>${mainPrefix}ssh help</code> - 显示此帮助

<b>示例：</b>
<code>${mainPrefix}ssh gen replace</code> - 生成新密钥并清空旧密钥
<code>${mainPrefix}ssh keys</code> - 查看所有授权密钥
<code>${mainPrefix}ssh port 2222</code> - 修改SSH端口为2222`;

class SSHPlugin extends Plugin {
  description: string = `SSH管理和服务器配置\n\n${help_text}`;

  cmdHandlers = {
    ssh: async (msg: Api.Message) => {
      await this.handleSSH(msg);
    }
  };

  // 主命令处理器
  private async handleSSH(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    // 检查执行权限 - 只能在收藏夹或指定会话执行
    const isPrivate = msg.isPrivate;
    const chatId = msg.chatId?.toString();
    const userId = msg.senderId?.toString();
    const targetChat = await ConfigManager.get(CONFIG_KEYS.TARGET_CHAT);
    
    // 检查是否在允许的位置执行
    let canExecute = false;
    
    if (isPrivate && chatId === userId) {
      // 收藏夹
      canExecute = true;
    } else if (targetChat !== "me" && chatId === targetChat) {
      // 指定的目标会话
      canExecute = true;
    }
    
    if (!canExecute) {
      await msg.edit({
        text: "🔒 <b>权限限制</b>\n\n此SSH管理插件只能在以下位置执行：\n• 收藏夹\n• 已设置的目标会话\n\n💡 当前目标: <code>" + (targetChat === "me" ? "收藏夹" : targetChat) + "</code>\n⚠️ 请在允许的位置使用此插件",
        parseMode: "html"
      });
      return;
    }

    const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
    const parts = lines?.[0]?.split(/\s+/) || [];
    const [, ...args] = parts;
    const sub = (args[0] || "").toLowerCase();

    try {
      if (!sub) {
        // 无参数时默认生成SSH密钥
        await this.generateSSHKeys(msg, client);
        return;
      }

      if (sub === "help" || sub === "h") {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }

      switch (sub) {
        case "gen":
        case "generate":
          // 检查是否有子命令
          const genMode = args[1]?.toLowerCase();
          if (genMode === "replace") {
            await this.generateSSHKeys(msg, client, "replace");
          } else if (genMode === "add") {
            await this.generateSSHKeys(msg, client, "add");
          } else {
            await this.generateSSHKeys(msg, client, "add"); // 默认追加模式
          }
          break;

        case "keys":
          const keysAction = args[1]?.toLowerCase();
          if (keysAction === "clear") {
            await this.clearAuthorizedKeys(msg);
          } else {
            await this.listAuthorizedKeys(msg);
          }
          break;

        case "passwd":
        case "password":
          await this.changePassword(msg, args.slice(1));
          break;

        case "port":
          await this.changeSSHPort(msg, args[1]);
          break;

        case "pwauth":
          await this.togglePasswordAuth(msg, args[1]);
          break;

        case "keyauth":
          await this.toggleKeyAuth(msg, args[1]);
          break;

        case "rootlogin":
          await this.toggleRootLogin(msg, args[1]);
          break;

        case "open":
          await this.openPort(msg, args[1]);
          break;

        case "close":
          await this.closePort(msg, args[1]);
          break;

        case "set":
          await this.setTarget(msg, args.slice(1).join(" "));
          break;

        case "info":
          await this.showInfo(msg);
          break;

        case "restart":
          await this.restartSSH(msg);
          break;

        default:
          await msg.edit({
            text: `❌ <b>未知命令:</b> <code>${htmlEscape(sub)}</code>\n\n💡 使用 <code>${mainPrefix}ssh help</code> 查看帮助`,
            parseMode: "html"
          });
      }
    } catch (error: any) {
      console.error("[ssh] 执行失败:", error);
      await msg.edit({
        text: `❌ <b>执行失败:</b> ${htmlEscape(error.message || "未知错误")}`,
        parseMode: "html"
      });
    }
  }

  // 生成SSH密钥
  private async generateSSHKeys(msg: Api.Message, client: any, mode: "add" | "replace" = "add"): Promise<void> {
    await msg.edit({ text: "🔄 正在生成SSH密钥对...", parseMode: "html" });

    const timestamp = dayjs().format("YYYYMMDD_HHmmss");
    const workDir = path.join(createDirectoryInTemp("sshkey"), `keys_${timestamp}`);
    const keyName = `ssh_key_${timestamp}`;

    try {
      // 创建工作目录
      fs.mkdirSync(workDir, { recursive: true });

      // 生成RSA密钥对 - 使用验证过的路径
      if (!validatePath(keyName)) {
        throw new Error("密钥名称包含非法字符");
      }
      const keyPath = path.join(workDir, keyName);
      const escapedPath = shellEscape(keyPath);
      const escapedComment = shellEscape(`generated_${timestamp}`);
      
      await execAsync(`ssh-keygen -t rsa -b 4096 -f ${escapedPath} -N "" -C ${escapedComment}`);

      // 读取密钥文件
      const privateKey = fs.readFileSync(keyPath, "utf-8");
      const publicKey = fs.readFileSync(`${keyPath}.pub`, "utf-8");

      // 尝试转换为PPK格式
      let ppkKey = "";
      try {
        await execAsync(`puttygen ${escapedPath} -o ${escapedPath}.ppk`);
        ppkKey = fs.readFileSync(`${keyPath}.ppk`, "utf-8");
      } catch {
        console.log("[ssh] PPK转换失败，跳过");
      }

      // 获取服务器信息
      const hostname = (await execAsync("hostname")).stdout.trim();
      const ipAddress = (await execAsync("curl -s ifconfig.me || echo '未知'")).stdout.trim();

      // 创建信息文件
      const infoText = `SSH密钥信息\n生成时间: ${dayjs().format("YYYY-MM-DD HH:mm:ss")}\n服务器: ${hostname}\nIP地址: ${ipAddress}\n\n文件说明:\n- ${keyName}: RSA私钥 (OpenSSH格式)\n- ${keyName}.pub: RSA公钥\n${ppkKey ? `- ${keyName}.ppk: RSA私钥 (PuTTY格式)\n` : ""}\n使用方法:\n1. 将公钥内容添加到目标服务器的 ~/.ssh/authorized_keys 文件中\n2. 使用OpenSSH客户端时使用 ${keyName} 私钥文件\n${ppkKey ? `3. 使用PuTTY/WinSCP等工具时使用 ${keyName}.ppk 文件\n` : ""}\n公钥内容:\n${publicKey}`;

      fs.writeFileSync(path.join(workDir, "key_info.txt"), infoText);

      // 创建压缩包
      const archivePath = path.join(workDir, "ssh_keys_package.zip");
      await this.createArchive(workDir, archivePath, [
        keyName,
        `${keyName}.pub`,
        ppkKey ? `${keyName}.ppk` : null,
        "key_info.txt"
      ].filter(Boolean) as string[]);

      // 更新authorized_keys
      await execAsync(`mkdir -p /root/.ssh && chmod 700 /root/.ssh`);
      
      if (mode === "replace") {
        // 替换模式：先清空文件，再写入新密钥
        await execAsync(`> /root/.ssh/authorized_keys`); // 先清空文件
        await msg.edit({ text: "🔄 已清空旧密钥，正在设置新密钥...", parseMode: "html" });
        // 使用printf避免echo的转义问题，并确保以换行符结尾
        await execAsync(`printf '%s\n' ${shellEscape(publicKey.trim())} > /root/.ssh/authorized_keys`);
      } else {
        // 追加模式：添加到现有密钥
        await execAsync(`printf '%s\n' ${shellEscape(publicKey.trim())} >> /root/.ssh/authorized_keys`);
      }
      
      await execAsync(`chmod 600 /root/.ssh/authorized_keys`);

      // 获取目标会话
      const targetChat = await ConfigManager.get(CONFIG_KEYS.TARGET_CHAT);
      let peer: any;

      if (targetChat === "me") {
        peer = "me";
      } else {
        try {
          peer = await client.getEntity(targetChat);
        } catch {
          peer = "me";
          await msg.reply({ 
            message: `⚠️ 无法找到指定会话 ${targetChat}，已发送到收藏夹`,
            parseMode: "html"
          });
        }
      }

      // 发送文件
      await client.sendFile(peer, {
        file: new CustomFile(
          "ssh_keys_package.zip",
          fs.statSync(archivePath).size,
          "",
          fs.readFileSync(archivePath)
        ),
        caption: `🔐 <b>SSH密钥包</b> - ${hostname} - ${timestamp}\n\n<b>包含文件：</b>\n• RSA私钥 (OpenSSH格式)\n• RSA公钥\n${ppkKey ? "• RSA私钥 (PPK格式)\n" : ""}• 使用说明\n\n⚠️ <b>请妥善保管私钥文件</b>`,
        parseMode: "html"
      });

      const modeText = mode === "replace" ? "已替换所有旧密钥" : "已追加到现有密钥";
      
      await msg.edit({
        text: `✅ <b>SSH密钥生成成功</b>\n\n📁 已发送到: ${targetChat === "me" ? "收藏夹" : htmlEscape(targetChat)}\n🔑 公钥${modeText}: /root/.ssh/authorized_keys\n\n<b>公钥内容：</b>\n<code>${htmlEscape(publicKey)}</code>`,
        parseMode: "html"
      });

      // 清理临时文件
      fs.rmSync(workDir, { recursive: true, force: true });

    } catch (error: any) {
      // 清理临时文件
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  // 查看授权密钥列表
  private async listAuthorizedKeys(msg: Api.Message): Promise<void> {
    await msg.edit({ text: "🔄 正在查看授权密钥...", parseMode: "html" });

    try {
      const authorizedKeysPath = "/root/.ssh/authorized_keys";
      
      // 检查文件是否存在
      try {
        await execAsync(`test -f ${authorizedKeysPath}`);
      } catch {
        await msg.edit({
          text: "❌ <b>未找到授权密钥文件</b>\n\n文件路径: <code>/root/.ssh/authorized_keys</code>\n状态: 不存在",
          parseMode: "html"
        });
        return;
      }

      // 读取并解析密钥
      const { stdout } = await execAsync(`cat ${authorizedKeysPath}`);
      const keys = stdout.trim().split('\n').filter(line => line.trim() && !line.startsWith('#'));
      
      if (keys.length === 0) {
        await msg.edit({
          text: "📋 <b>授权密钥列表</b>\n\n当前没有任何授权密钥",
          parseMode: "html"
        });
        return;
      }

      let keyList = "📋 <b>授权密钥列表</b>\n\n";
      keyList += `📊 <b>总计:</b> ${keys.length} 个密钥\n\n`;
      
      keys.forEach((key, index) => {
        const parts = key.trim().split(' ');
        const keyType = parts[0] || '未知类型';
        const comment = parts[2] || '无备注';
        const keyPreview = parts[1] ? `${parts[1].substring(0, 20)}...` : '无效密钥';
        
        keyList += `🔑 <b>密钥 ${index + 1}:</b>\n`;
        keyList += `   类型: <code>${keyType}</code>\n`;
        keyList += `   备注: <code>${htmlEscape(comment)}</code>\n`;
        keyList += `   预览: <code>${keyPreview}</code>\n\n`;
      });
      
      keyList += `💡 <b>提示:</b> 使用 <code>${mainPrefix}ssh keys clear</code> 清空所有密钥`;

      await msg.edit({
        text: keyList,
        parseMode: "html"
      });
      
    } catch (error: any) {
      throw new Error(`查看授权密钥失败: ${error.message}`);
    }
  }

  // 清空授权密钥
  private async clearAuthorizedKeys(msg: Api.Message): Promise<void> {
    await msg.edit({ text: "⚠️ 正在清空所有授权密钥...", parseMode: "html" });

    try {
      const authorizedKeysPath = "/root/.ssh/authorized_keys";
      
      // 备份现有密钥
      const timestamp = dayjs().format("YYYYMMDD_HHmmss");
      try {
        await execAsync(`cp ${authorizedKeysPath} ${authorizedKeysPath}.backup.${timestamp}`);
      } catch {
        // 文件不存在时忽略备份错误
      }
      
      // 清空密钥文件
      await execAsync(`mkdir -p /root/.ssh && chmod 700 /root/.ssh`);
      await execAsync(`> ${authorizedKeysPath}`);
      await execAsync(`chmod 600 ${authorizedKeysPath}`);

      await msg.edit({
        text: `✅ <b>授权密钥已清空</b>\n\n🗂️ 备份文件: <code>${authorizedKeysPath}.backup.${timestamp}</code>\n\n⚠️ <b>警告:</b> 所有SSH密钥登录已失效，请确保有其他方式访问服务器`,
        parseMode: "html"
      });
      
    } catch (error: any) {
      throw new Error(`清空授权密钥失败: ${error.message}`);
    }
  }

  // 修改root密码
  private async changePassword(msg: Api.Message, args: string[]): Promise<void> {
    const newPassword = args.join(" ").trim();
    
    if (!newPassword) {
      await msg.edit({
        text: `❌ <b>请提供新密码</b>\n\n示例: <code>${mainPrefix}ssh passwd 新密码123</code>`,
        parseMode: "html"
      });
      return;
    }

    // 验证密码复杂度
    if (!validatePassword(newPassword)) {
      await msg.edit({
        text: `❌ <b>密码不符合要求</b>\n\n密码长度至少8位`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: "🔄 正在修改root密码...", parseMode: "html" });

    try {
      // 使用转义的密码防止命令注入
      const escapedPassword = shellEscape(newPassword);
      await execAsync(`echo "root:${escapedPassword}" | chpasswd`);

      // 不显示明文密码
      await msg.edit({
        text: `✅ <b>root密码修改成功</b>\n\n⚠️ 请妥善保管新密码`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`修改密码失败: ${error.message}`);
    }
  }

  // 修改SSH端口
  private async changeSSHPort(msg: Api.Message, portStr: string): Promise<void> {
    const port = validatePort(portStr);
    
    if (!port) {
      await msg.edit({
        text: `❌ <b>无效的端口号</b>\n\n端口范围: 1-65535\n示例: <code>${mainPrefix}ssh port 2222</code>`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: `🔄 正在检查端口 ${port} 是否可用...`, parseMode: "html" });

    try {
      // 获取当前SSH端口，用于后续关闭旧端口防火墙
      const currentPort = await ConfigManager.get(CONFIG_KEYS.SSH_PORT, "22");
      
      // 检查端口冲突（跳过当前SSH端口检查）
      if (String(port) !== currentPort) {
        const portCheck = await checkPortInUse(port);
        if (portCheck.inUse) {
          await msg.edit({
            text: `❌ <b>端口冲突检测失败</b>\n\n端口 <code>${port}</code> 已被占用\n进程信息: <code>${htmlEscape(portCheck.processInfo || '未知')}</code>\n\n💡 <b>建议:</b>\n• 选择其他端口号\n• 停止占用该端口的服务\n• 使用 <code>netstat -tlnp | grep :${port}</code> 查看详情`,
            parseMode: "html"
          });
          return;
        }
      }
      
      await msg.edit({ text: `🔄 端口 ${port} 可用，正在修改SSH配置...`, parseMode: "html" });
      
      // 使用通用函数修改SSH配置
      const timestamp = await modifySSHConfig("Port", String(port));
      
      await msg.edit({ text: `🔄 SSH配置已更新，正在开放防火墙端口 ${port}...`, parseMode: "html" });
      
      // 自动开放新端口的防火墙
      try {
        await execAsync(`iptables -I INPUT -p tcp --dport ${port} -j ACCEPT`);
        await execAsync(`iptables -I INPUT -p udp --dport ${port} -j ACCEPT`);
        
        // 尝试保存iptables规则
        try {
          await execAsync(`iptables-save > /etc/iptables/rules.v4`);
        } catch {
          try {
            await execAsync(`service iptables save`);
          } catch {
            console.log("[ssh] 无法持久化iptables规则");
          }
        }
      } catch (firewallError: any) {
        console.warn("[ssh] 防火墙端口开放失败:", firewallError.message);
      }
      
      await msg.edit({ text: `🔄 防火墙已配置，正在重启SSH服务...`, parseMode: "html" });
      
      // 重启SSH服务使配置生效
      const restartResult = await restartSSHService();
      if (!restartResult.success) {
        throw new Error("无法重启SSH服务");
      }
      
      // 保存配置到插件数据库
      await ConfigManager.set(CONFIG_KEYS.SSH_PORT, String(port));

      // 提供关闭旧端口的提示
      let oldPortWarning = "";
      if (currentPort !== "22" && currentPort !== String(port)) {
        oldPortWarning = `\n\n💡 <b>提示:</b> 旧端口 ${currentPort} 的防火墙规则仍然开放\n如需关闭请执行: <code>${mainPrefix}ssh close ${currentPort}</code>`;
      }

      await msg.edit({
        text: `✅ <b>SSH端口修改成功</b>\n\n🔧 新端口: <code>${port}</code>\n🛡️ 防火墙: 已自动开放 TCP/UDP ${port}\n📄 备份文件: /etc/ssh/sshd_config.backup.${timestamp}${oldPortWarning}\n\n⚠️ <b>重要:</b> 请用新端口测试连接后再断开当前会话`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`修改SSH端口失败: ${error.message}`);
    }
  }

  // 开关密码登录
  private async togglePasswordAuth(msg: Api.Message, mode: string): Promise<void> {
    const enable = mode === "on" || mode === "enable" || mode === "yes";
    const disable = mode === "off" || mode === "disable" || mode === "no";
    
    if (!enable && !disable) {
      await msg.edit({
        text: `❌ <b>无效的参数</b>\n\n使用: <code>${mainPrefix}ssh pwauth on</code> 或 <code>${mainPrefix}ssh pwauth off</code>`,
        parseMode: "html"
      });
      return;
    }

    const action = enable ? "开启" : "关闭";
    await msg.edit({ text: `🔄 正在${action}密码登录...`, parseMode: "html" });

    try {
      const authValue = enable ? "yes" : "no";
      
      // 使用通用函数修改SSH配置
      const timestamp = await modifySSHConfig("PasswordAuthentication", authValue);
      
      // 同时设置相关安全选项
      await modifySSHConfig("ChallengeResponseAuthentication", "no", false);
      await modifySSHConfig("UsePAM", enable ? "yes" : "no", false);
      
      // 重启SSH服务使配置生效
      const restartResult = await restartSSHService();
      if (!restartResult.success) {
        throw new Error("无法重启SSH服务");
      }
      
      // 保存配置到插件数据库
      await ConfigManager.set(CONFIG_KEYS.PASSWORD_AUTH, authValue);

      await msg.edit({
        text: `✅ <b>密码登录已${action}</b>\n\n当前状态: ${enable ? "✅ 已开启" : "❌ 已关闭"}\n备份文件: /etc/ssh/sshd_config.backup.${timestamp}`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`${action}密码登录失败: ${error.message}`);
    }
  }

  // 开关密钥登录
  private async toggleKeyAuth(msg: Api.Message, mode: string): Promise<void> {
    const enable = mode === "on" || mode === "enable" || mode === "yes";
    const disable = mode === "off" || mode === "disable" || mode === "no";
    
    if (!enable && !disable) {
      await msg.edit({
        text: `❌ <b>无效的参数</b>\n\n使用: <code>${mainPrefix}ssh keyauth on</code> 或 <code>${mainPrefix}ssh keyauth off</code>`,
        parseMode: "html"
      });
      return;
    }

    const action = enable ? "开启" : "关闭";
    await msg.edit({ text: `🔄 正在${action}密钥登录...`, parseMode: "html" });

    try {
      const authValue = enable ? "yes" : "no";
      
      // 使用通用函数修改SSH配置
      const timestamp = await modifySSHConfig("PubkeyAuthentication", authValue);
      
      // 同时设置相关安全选项
      if (enable) {
        // 开启密钥登录时确保相关设置正确
        await modifySSHConfig("AuthorizedKeysFile", "/root/.ssh/authorized_keys", false);
      }
      
      // 重启SSH服务使配置生效
      const restartResult = await restartSSHService();
      if (!restartResult.success) {
        throw new Error("无法重启SSH服务");
      }
      
      // 保存配置到插件数据库
      await ConfigManager.set(CONFIG_KEYS.PUBKEY_AUTH, authValue);

      let warningText = "";
      if (!enable) {
        warningText = "\n\n⚠️ <b>警告</b>: 关闭密钥登录可能会造成无法使用SSH密钥连接";
      }

      await msg.edit({
        text: `✅ <b>密钥登录已${action}</b>\n\n当前状态: ${enable ? "✅ 已开启" : "❌ 已关闭"}\n备份文件: /etc/ssh/sshd_config.backup.${timestamp}${warningText}`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`${action}密钥登录失败: ${error.message}`);
    }
  }

  // 开关Root登录
  private async toggleRootLogin(msg: Api.Message, mode: string): Promise<void> {
    const enable = mode === "on" || mode === "enable" || mode === "yes";
    const disable = mode === "off" || mode === "disable" || mode === "no";
    const keyOnly = mode === "keyonly" || mode === "key-only" || mode === "keys";
    
    if (!enable && !disable && !keyOnly) {
      await msg.edit({
        text: `❌ <b>无效的参数</b>\n\n用法:\n• <code>${mainPrefix}ssh rootlogin on</code> - 允许所有root登录方式\n• <code>${mainPrefix}ssh rootlogin off</code> - 完全禁止root登录\n• <code>${mainPrefix}ssh rootlogin keyonly</code> - 仅允许密钥登录root`,
        parseMode: "html"
      });
      return;
    }

    let action: string;
    let authValue: string;
    
    if (enable) {
      action = "开启所有Root登录方式";
      authValue = "yes";
    } else if (keyOnly) {
      action = "设置Root仅密钥登录";
      authValue = "prohibit-password";
    } else {
      action = "完全禁止Root登录";
      authValue = "no";
    }

    await msg.edit({ text: `🔄 正在${action}...`, parseMode: "html" });

    try {
      // 检查当前是否有其他登录方式
      if (disable) {
        // 完全禁用root登录前检查是否有其他用户
        try {
          const { stdout: users } = await execAsync(`getent passwd | awk -F: '$3 >= 1000 && $3 != 65534 { print $1 }' | head -5`);
          const userList = users.trim().split('\n').filter(u => u.trim());
          
          if (userList.length === 0) {
            await msg.edit({
              text: `⚠️ <b>安全警告</b>\n\n检测到系统中没有普通用户账户！\n完全禁用root登录可能导致无法访问服务器。\n\n💡 <b>建议选择:</b>\n• 使用 <code>${mainPrefix}ssh rootlogin keyonly</code> (推荐)\n• 先创建普通用户再禁用root\n\n<b>继续禁用请再次确认:</b>\n<code>${mainPrefix}ssh rootlogin off</code>`,
              parseMode: "html"
            });
            return;
          }
        } catch {
          // 检查失败时给出警告
          await msg.edit({
            text: `⚠️ <b>无法检测用户账户</b>\n\n建议使用 <code>${mainPrefix}ssh rootlogin keyonly</code> 而不是完全禁用\n\n如需继续禁用root登录:\n<code>${mainPrefix}ssh rootlogin off</code>`,
            parseMode: "html"
          });
          return;
        }
      }
      
      // 使用通用函数修改SSH配置
      const timestamp = await modifySSHConfig("PermitRootLogin", authValue);
      
      // 重启SSH服务使配置生效
      const restartResult = await restartSSHService();
      if (!restartResult.success) {
        throw new Error("无法重启SSH服务");
      }
      
      let statusText: string;
      let securityTip: string;
      
      if (enable) {
        statusText = "✅ 允许所有登录方式";
        securityTip = "⚠️ <b>安全提示:</b> 已开启所有root登录方式，建议使用强密码";
      } else if (keyOnly) {
        statusText = "🔐 仅允许密钥登录";
        securityTip = "🛡️ <b>安全提示:</b> Root密码登录已禁用，仅允许SSH密钥登录";
      } else {
        statusText = "❌ 完全禁止登录";
        securityTip = "🛡️ <b>安全提示:</b> Root登录已完全禁用，请确保有其他用户账户可用";
      }
      
      await msg.edit({
        text: `✅ <b>Root登录配置已更新</b>\n\n状态: ${statusText}\n配置值: <code>PermitRootLogin ${authValue}</code>\n备份文件: /etc/ssh/sshd_config.backup.${timestamp}\n\n${securityTip}`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`配置Root登录失败: ${error.message}`);
    }
  }

  // 重启SSH服务
  private async restartSSH(msg: Api.Message): Promise<void> {
    await msg.edit({ text: "🔄 正在重启SSH服务...", parseMode: "html" });

    try {
      // 使用通用函数重启SSH服务
      const restartResult = await restartSSHService();
      
      if (!restartResult.success) {
        throw new Error("无法重启SSH服务，请检查系统类型");
      }

      // 验证SSH服务状态
      let sshStatus = "未知";
      try {
        await execAsync("systemctl is-active --quiet sshd || systemctl is-active --quiet ssh");
        sshStatus = "✅ 运行中";
      } catch {
        try {
          await execAsync("pgrep sshd");
          sshStatus = "✅ 运行中";
        } catch {
          sshStatus = "❌ 未运行";
        }
      }

      await msg.edit({
        text: `✅ <b>SSH服务重启成功</b>\n\n重启命令: <code>${restartResult.command}</code>\n服务状态: ${sshStatus}\n\n💡 建议重启后验证SSH连接`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`重启SSH服务失败: ${error.message}`);
    }
  }

  // 开放防火墙端口
  private async openPort(msg: Api.Message, portStr: string): Promise<void> {
    const port = validatePort(portStr);
    
    if (!port) {
      await msg.edit({
        text: `❌ <b>无效的端口号</b>\n\n端口范围: 1-65535\n示例: <code>${mainPrefix}ssh open 80</code>`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: `🔄 正在开放端口 ${port}...`, parseMode: "html" });

    try {
      // 使用iptables开放端口
      await execAsync(`iptables -I INPUT -p tcp --dport ${port} -j ACCEPT`);
      await execAsync(`iptables -I INPUT -p udp --dport ${port} -j ACCEPT`);
      
      // 尝试保存iptables规则
      try {
        await execAsync(`iptables-save > /etc/iptables/rules.v4`);
      } catch {
        // 某些系统可能没有这个目录
        try {
          await execAsync(`service iptables save`);
        } catch {
          console.log("[sshkey] 无法持久化iptables规则");
        }
      }

      await msg.edit({
        text: `✅ <b>端口 ${port} 已开放</b>\n\n协议: TCP/UDP\n\n💡 提示: 规则已添加到iptables，重启后可能需要重新设置`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`开放端口失败: ${error.message}`);
    }
  }

  // 关闭防火墙端口
  private async closePort(msg: Api.Message, portStr: string): Promise<void> {
    const port = validatePort(portStr);
    
    if (!port) {
      await msg.edit({
        text: `❌ <b>无效的端口号</b>\n\n端口范围: 1-65535\n示例: <code>${mainPrefix}ssh close 80</code>`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: `🔄 正在关闭端口 ${port}...`, parseMode: "html" });

    try {
      // 使用iptables关闭端口
      await execAsync(`iptables -D INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || true`);
      await execAsync(`iptables -D INPUT -p udp --dport ${port} -j ACCEPT 2>/dev/null || true`);
      
      // 添加拒绝规则
      await execAsync(`iptables -A INPUT -p tcp --dport ${port} -j DROP`);
      await execAsync(`iptables -A INPUT -p udp --dport ${port} -j DROP`);
      
      // 尝试保存iptables规则
      try {
        await execAsync(`iptables-save > /etc/iptables/rules.v4`);
      } catch {
        try {
          await execAsync(`service iptables save`);
        } catch {
          console.log("[sshkey] 无法持久化iptables规则");
        }
      }

      await msg.edit({
        text: `✅ <b>端口 ${port} 已关闭</b>\n\n协议: TCP/UDP\n\n💡 提示: 规则已添加到iptables，重启后可能需要重新设置`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`关闭端口失败: ${error.message}`);
    }
  }

  // 设置接收目标
  private async setTarget(msg: Api.Message, target: string): Promise<void> {
    if (!target) {
      await msg.edit({
        text: `❌ <b>请提供目标</b>\n\n示例:\n<code>${mainPrefix}ssh set me</code> - 重置为默认发送到收藏夹\n<code>${mainPrefix}ssh set @username</code> - 设置发送到指定用户\n<code>${mainPrefix}ssh set -1001234567890</code> - 设置发送到指定群组/频道`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: `🔄 正在设置接收目标为: ${target}...`, parseMode: "html" });

    try {
      // 验证目标是否有效
      if (target !== "me") {
        const client = await getGlobalClient();
        if (client) {
          try {
            await client.getEntity(target);
          } catch {
            await msg.edit({
              text: `⚠️ <b>无法验证目标有效性</b>\n\n目标 <code>${htmlEscape(target)}</code> 可能无效，但配置已保存。\n\n发送时如果失败将自动使用收藏夹。`,
              parseMode: "html"
            });
            await ConfigManager.set(CONFIG_KEYS.TARGET_CHAT, target);
            return;
          }
        }
      }

      // 保存配置
      await ConfigManager.set(CONFIG_KEYS.TARGET_CHAT, target);

      await msg.edit({
        text: `✅ <b>接收目标已设置</b>\n\n目标: <code>${htmlEscape(target)}</code>\n\n${target === "me" ? "密钥将发送到收藏夹" : "密钥将发送到指定会话"}`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`设置目标失败: ${error.message}`);
    }
  }

  // 显示配置信息
  private async showInfo(msg: Api.Message): Promise<void> {
    await msg.edit({ text: "🔄 正在获取SSH状态信息...", parseMode: "html" });

    try {
      // 获取插件配置
      const targetChat = await ConfigManager.get(CONFIG_KEYS.TARGET_CHAT);
      const sshPort = await ConfigManager.get(CONFIG_KEYS.SSH_PORT);
      const passwordAuth = await ConfigManager.get(CONFIG_KEYS.PASSWORD_AUTH);
      const pubkeyAuth = await ConfigManager.get(CONFIG_KEYS.PUBKEY_AUTH);

      // 获取当前SSH服务状态
      let sshStatus = "未知";
      try {
        await execAsync("systemctl is-active --quiet sshd || systemctl is-active --quiet ssh");
        sshStatus = "✅ 运行中";
      } catch {
        try {
          await execAsync("pgrep sshd");
          sshStatus = "✅ 运行中";
        } catch {
          sshStatus = "❌ 未运行";
        }
      }

      // 从sshd_config读取实际配置
      let actualPasswordAuth = "未知";
      let rootLogin = "未知";
      let actualPubkeyAuth = "未知";
      let actualPort = "未知";
      
      try {
        const configContent = (await execAsync("cat /etc/ssh/sshd_config")).stdout;
        
        // 检查密码认证
        const passwordAuthMatch = configContent.match(/^\s*PasswordAuthentication\s+(yes|no)/mi);
        actualPasswordAuth = passwordAuthMatch ? 
          (passwordAuthMatch[1].toLowerCase() === "yes" ? "✅ 已开启" : "❌ 已关闭") : "🟡 默认(通常开启)";
        
        // 检查Root登录
        const rootLoginMatch = configContent.match(/^\s*PermitRootLogin\s+(yes|no|prohibit-password|forced-commands-only)/mi);
        if (rootLoginMatch) {
          const value = rootLoginMatch[1].toLowerCase();
          switch (value) {
            case "yes":
              rootLogin = "✅ 允许(全权限)";
              break;
            case "no":
              rootLogin = "❌ 禁止";
              break;
            case "prohibit-password":
              rootLogin = "🔑 仅密钥";
              break;
            case "forced-commands-only":
              rootLogin = "⚠️ 仅命令";
              break;
          }
        } else {
          rootLogin = "🟡 默认(通常允许)";
        }
        
        // 检查密钥认证
        const pubkeyAuthMatch = configContent.match(/^\s*PubkeyAuthentication\s+(yes|no)/mi);
        actualPubkeyAuth = pubkeyAuthMatch ? 
          (pubkeyAuthMatch[1].toLowerCase() === "yes" ? "✅ 已开启" : "❌ 已关闭") : "🟡 默认(通常开启)";
        
        // 检查端口
        const portMatch = configContent.match(/^\s*Port\s+(\d+)/mi);
        actualPort = portMatch ? portMatch[1] : "22(默认)";
        
      } catch (error) {
        console.log("[ssh] 无法读取sshd_config:", error);
      }

      // 检查authorized_keys文件
      let keyCount = 0;
      try {
        const keysContent = (await execAsync("wc -l /root/.ssh/authorized_keys 2>/dev/null || echo '0'")).stdout;
        keyCount = parseInt(keysContent.trim()) || 0;
      } catch {
        keyCount = 0;
      }

      // 获取防火墙规则数量
      let iptablesInfo = "";
      try {
        const result = await execAsync("iptables -L INPUT -n | wc -l");
        const ruleCount = parseInt(result.stdout.trim()) - 2; // 减去标题行
        iptablesInfo = `\n防火墙规则: ${ruleCount > 0 ? ruleCount + " 条" : "无限制"}`;
      } catch {
        iptablesInfo = "";
      }

      // 获取系统信息
      let systemInfo = "";
      try {
        const hostname = (await execAsync("hostname")).stdout.trim();
        const uptime = (await execAsync("uptime -p 2>/dev/null || echo '未知'")).stdout.trim();
        systemInfo = `\n\n<b>系统信息：</b>\n主机名: <code>${hostname}</code>\n运行时间: ${uptime}`;
      } catch {
        systemInfo = "";
      }

      await msg.edit({
        text: `📊 <b>SSH状态信息</b>\n\n<b>SSH服务状态：</b>\n服务状态: ${sshStatus}\n端口: <code>${actualPort}</code>\n\n<b>认证配置：</b>\n密码登录: ${actualPasswordAuth}\nRoot登录: ${rootLogin}\n密钥登录: ${actualPubkeyAuth}\n已授权密钥: ${keyCount} 个${iptablesInfo}\n\n<b>插件配置：</b>\n接收目标: <code>${htmlEscape(targetChat)}</code>\n${targetChat === "me" ? "(发送到收藏夹)" : "(发送到指定会话)"}\n\n<b>相关文件：</b>\n• SSH配置: /etc/ssh/sshd_config\n• 授权密钥: /root/.ssh/authorized_keys${systemInfo}`,
        parseMode: "html"
      });
    } catch (error: any) {
      throw new Error(`获取SSH状态信息失败: ${error.message}`);
    }
  }

  // 创建压缩包
  private async createArchive(sourceDir: string, outputPath: string, files: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', {
        zlib: { level: 9 } // 最高压缩级别
      });

      output.on('close', () => {
        console.log(`[ssh] 压缩包创建成功: ${archive.pointer()} bytes`);
        resolve();
      });

      archive.on('error', (err) => {
        reject(err);
      });

      archive.pipe(output);

      // 添加文件到压缩包
      for (const file of files) {
        const filePath = path.join(sourceDir, file);
        if (fs.existsSync(filePath)) {
          archive.file(filePath, { name: file });
        }
      }

      archive.finalize();
    });
  }
}

export default new SSHPlugin();


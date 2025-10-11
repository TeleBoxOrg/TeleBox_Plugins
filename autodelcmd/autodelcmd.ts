//@ts-nocheck
import { Api } from "telegram";
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import fs from "fs/promises";
import path from "path";

// HTML转义工具（每个插件必须实现）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

const CONFIG_FILE_PATH = path.join(
  process.cwd(),
  "temp",
  "autodelcmd_config.json"
);

interface ExitMessageData {
  cid?: number;
  mid?: number;
}

interface AutoDeleteConfig {
  exitMsg?: ExitMessageData;
}

class AutoDeleteService {
  private client: any;
  private config: AutoDeleteConfig = {};

  constructor(client: any) {
    this.client = client;
  }

  public async initialize() {
    await this.loadConfig();
    await this.autoDeleteOnStartup();
  }

  private async loadConfig() {
    try {
      await fs.access(CONFIG_FILE_PATH);
      const data = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
      this.config = JSON.parse(data);
    } catch (error) {
      console.log("[autodelcmd] 未找到配置，使用默认配置。");
    }
  }

  private async saveConfig() {
    try {
      await fs.mkdir(path.dirname(CONFIG_FILE_PATH), { recursive: true });
      await fs.writeFile(
        CONFIG_FILE_PATH,
        JSON.stringify(this.config, null, 2)
      );
    } catch (error) {
      console.error("[autodelcmd] 保存配置失败:", error);
    }
  }

  private async autoDeleteOnStartup() {
    const data = this.config.exitMsg || {};
    const cid = data.cid || 0;
    const mid = data.mid || 0;

    if (data && cid && mid) {
      try {
        const message = await this.client.getMessages(cid, { ids: [mid] });
        if (message && message[0]) {
          await this.delayDelete(message[0], 10);
        }
        // 清除已处理的退出消息
        this.config.exitMsg = undefined;
        await this.saveConfig();
      } catch (error) {
        console.log("[autodelcmd] 删除退出消息时出错:", error);
      }
    }
  }

  private async delayDelete(msg: Api.Message, seconds: number) {
    console.log(`[autodelcmd] 设置定时器: ${seconds} 秒后删除消息 ID ${msg.id}`);
    setTimeout(async () => {
      try {
        console.log(`[autodelcmd] 正在删除消息 ID ${msg.id}`);
        await msg.delete({ revoke: true });
        console.log(`[autodelcmd] 成功删除消息 ID ${msg.id}`);
      } catch (error: any) {
        console.error(`[autodelcmd] 删除消息 ID ${msg.id} 失败:`, error.message);
      }
    }, seconds * 1000);
  }

  public async handleCommandPostprocess(
    msg: Api.Message,
    command: string,
    parameters?: string[]
  ) {
    // 只处理自己发出的消息
    if (!msg.out) return;

    console.log(`[autodelcmd] 处理命令: ${command}, 参数: ${JSON.stringify(parameters)}`);

    // 针对特定命令的自动删除逻辑
    
    // tpm 命令特殊处理：s, search, ls, i, install 参数时 120秒，其他 10秒
    if (command === "tpm") {
      if (parameters && parameters.length > 0 && ["s", "search", "ls", "i", "install"].includes(parameters[0])) {
        console.log(`[autodelcmd] 将在 120 秒后删除消息 (${command} ${parameters[0]})`);
        await this.delayDelete(msg, 120);
      } else {
        console.log(`[autodelcmd] 将在 10 秒后删除消息 (${command})`);
        await this.delayDelete(msg, 10);
      }
    }
    // 其他 10秒删除的命令
    else if (["lang", "alias", "reload"].includes(command)) {
      console.log(`[autodelcmd] 将在 10 秒后删除消息 (${command})`);
      await this.delayDelete(msg, 10);
    }
    // 120秒删除的命令
    else if (["h", "help", "dc", "ip", "ping", "pingdc", "sysinfo", "whois", "bf", "update", "trace","service"].includes(command)) {
      console.log(`[autodelcmd] 将在 120 秒后删除消息 (${command})`);
      await this.delayDelete(msg, 120);
    }
    // s, speedtest, spt, v 命令：删除命令及相关响应
    else if (["s", "speedtest", "spt", "v"].includes(command)) {
      console.log(`[autodelcmd] 将在 120 秒后删除消息及相关响应 (${command})`);
      try {
        const chatId = msg.chatId || msg.peerId;
        const messages = await this.client.getMessages(chatId, { limit: 100 });

        // 查找最近的自己发出的消息并删除
        for (const message of messages) {
          if (message.out && message.id !== msg.id) {
            await this.delayDelete(message, 120);
            break;
          }
        }
        // 删除命令消息本身
        await this.delayDelete(msg, 120);
      } catch (error) {
        console.error("[autodelcmd] 处理消息时出错:", error);
      }
    }
  }

  public async saveExitMessage(chatId: number, messageId: number) {
    this.config.exitMsg = { cid: chatId, mid: messageId };
    await this.saveConfig();
  }
}

// 全局服务实例
let serviceInstance: AutoDeleteService | null = null;

class AutoDeletePlugin extends Plugin {
  description: string = `🗑️ 自动删除命令消息插件

**功能说明:**
- 自动监听并延迟删除特定命令的消息
- 支持所有配置的自定义前缀
- 支持不同命令的不同延迟时间
- 启动时自动清理退出消息

**自动删除规则:**
• 短延迟 (10秒): 
  - lang, alias, reload
  - tpm (除了 tpm s / tpm search / tpm ls / tpm i / tpm install)

• 长延迟 (120秒):
  - h, help, dc, ip, ping, pingdc, sysinfo, whois, bf, update, trace
  - tpm s, tpm search, tpm ls, tpm i, tpm install
  - s, speedtest, spt, v (同时删除响应消息)

**使用方法:**
插件会在后台自动运行，无需手动触发。
会自动检测当前配置的所有前缀（可通过 prefix 命令管理）。
加载插件后，符合规则的命令消息将自动延迟删除。`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {};

  // 监听所有消息，实现命令后处理
  listenMessageHandler = async (msg: Api.Message) => {
    try {
      // 只处理自己发出的消息
      if (!msg.out) return;
      
      // 检查消息是否以命令前缀开头
      const messageText = msg.message?.trim() || "";
      if (!messageText) return;
      
      // 获取当前配置的前缀列表
      const currentPrefixes = getPrefixes();
      
      // 检查消息是否以任何一个配置的前缀开头
      let matchedPrefix: string | null = null;
      for (const prefix of currentPrefixes) {
        if (messageText.startsWith(prefix)) {
          matchedPrefix = prefix;
          break;
        }
      }
      
      // 如果没有匹配的前缀，跳过处理
      if (!matchedPrefix) return;

      const client = await getGlobalClient();
      if (!client) return;

      // 初始化服务实例
      if (!serviceInstance) {
        serviceInstance = new AutoDeleteService(client);
        await serviceInstance.initialize();
        console.log("[autodelcmd] 服务实例已初始化");
      }

      // 手动解析命令和参数
      const parts = messageText.trim().split(/\s+/);
      // 移除前缀获取命令名 (例如 ".tpm" -> "tpm")
      const commandWithPrefix = parts[0];
      const command = commandWithPrefix.substring(matchedPrefix.length); // 移除匹配的前缀
      const parameters = parts.slice(1); // 其余都是参数
      
      if (!command) return; // 如果只有前缀没有命令，跳过
      
      console.log(`[autodelcmd] 检测到命令: ${command}, 参数: ${JSON.stringify(parameters)}, 前缀: ${matchedPrefix}, 原始消息: ${messageText}`);

      // 处理命令后删除
      await serviceInstance.handleCommandPostprocess(msg, command, parameters);
    } catch (error) {
      console.error("[autodelcmd] listenMessageHandler 错误:", error);
    }
  };
}

export default new AutoDeletePlugin();


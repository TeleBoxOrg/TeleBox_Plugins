import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import { getGlobalClient } from "@utils/globalClient";
import * as fs from "fs/promises";
import * as path from "path";
import axios from "axios";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";

import { exec } from "child_process";
import { promisify } from "util";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "openlist";
const commandName = `${mainPrefix}${pluginName}`;

const execAsync = promisify(exec);
const GH_BASE_DOWNLOAD = "https://github.com/OpenListTeam/OpenList/releases/latest/download";

const helpText = `⚙️ <b>OpenList 管理插件</b>

<b>📝 功能描述:</b>
• 📦 <b>安装/管理</b>：一键安装、更新、卸载、修改端口
• 💾 <b>配置管理</b>：备份和恢复 OpenList 配置
• 🔑 <b>账户管理</b>：修改用户名和密码
• 📁 <b>文件保存</b>：快速保存文件到指定目录

<b>🔧 使用方法:</b>
• <code>${commandName} install [目录]</code> - 安装
• <code>${commandName} update</code> - 更新
• <code>${commandName} uninstall</code> - 卸载
• <code>${commandName} status</code> - 查看状态
• <code>${commandName} setport [端口]</code> - 修改端口

• <code>${commandName} backup</code> - 备份配置
• <code>${commandName} restore [备份名]</code> - 恢复配置

• <code>${commandName} admin setuser [用户名]</code>
• <code>${commandName} admin setpass [密码]</code>
• <code>${commandName} admin random</code>
• <code>${commandName} login [用户] [密码]</code> - 手动配置账号信息
• <code>${commandName} setdefault [路径]</code> - 设置默认保存路径 (不填则恢复默认)

• <code>${commandName} save [路径]</code> - (回复文件) 保存到 Openlist 目录 (指定路径则上传到挂载盘)

<b>💡 示例:</b>
• <code>${commandName} install /data/openlist</code>
• <code>${commandName} setport 5255</code>
`;

class OpenListPlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  description: string = `\nOpenList 管理\n\n${helpText}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    openlist: async (msg: Api.Message) => {
      await this.handleCommand(msg);
    },
    op: async (msg: Api.Message) => {
      await this.handleCommand(msg);
    },
  };

  private async handleCommand(msg: Api.Message) {
    const args = (msg.message || "").trim().split(/\s+/);
    const sub = args[1] || "";

    switch (sub) {
      case "install":
        if (!(await this.isSavedMessages(msg))) {
          await msg.edit({ text: "⚠️ 此命令仅限在「收藏夹」中使用" });
          return;
        }
        await msg.edit({ text: "正在准备安装..." });
        await this.handleInstall(msg, args[2]);
        break;
      case "update":
        if (!(await this.isSavedMessages(msg))) {
          await msg.edit({ text: "⚠️ 此命令仅限在「收藏夹」中使用" });
          return;
        }
        await msg.edit({ text: "正在准备更新..." });
        await this.handleUpdate(msg);
        break;
      case "uninstall":
        if (!(await this.isSavedMessages(msg))) {
          await msg.edit({ text: "⚠️ 此命令仅限在「收藏夹」中使用" });
          return;
        }
        await msg.edit({ text: "正在准备卸载..." });
        await this.handleUninstall(msg);
        break;
      case "status":
        if (!(await this.isSavedMessages(msg))) {
          await msg.edit({ text: "⚠️ 此命令仅限在「收藏夹」中使用" });
          return;
        }
        await this.handleStatus(msg);
        break;
      case "backup":
        if (!(await this.isSavedMessages(msg))) {
          await msg.edit({ text: "⚠️ 此命令仅限在「收藏夹」中使用" });
          return;
        }
        await msg.edit({ text: "正在准备备份..." });
        await this.handleBackup(msg);
        break;
      case "restore":
        if (!(await this.isSavedMessages(msg))) {
          await msg.edit({ text: "⚠️ 此命令仅限在「收藏夹」中使用" });
          return;
        }
        await msg.edit({ text: "正在准备恢复..." });
        await this.handleRestore(msg, args[2]);
        break;
      case "admin":
        if (!(await this.isSavedMessages(msg))) {
          await msg.edit({ text: "⚠️ 此命令仅限在「收藏夹」中使用" });
          return;
        }
        await this.handleAdmin(msg, args.slice(2));
        break;
      case "setport":
        if (!(await this.isSavedMessages(msg))) {
          await msg.edit({ text: "⚠️ 此命令仅限在「收藏夹」中使用" });
          return;
        }
        await this.handleSetPort(msg, args[2]);
        break;
      case "save":
        await this.handleSave(msg, args[2]);
        break;
      case "login":
        if (!(await this.isSavedMessages(msg))) {
          await msg.edit({ text: "⚠️ 此命令仅限在「收藏夹」中使用" });
          return;
        }
        await this.handleLogin(msg, args[2], args[3]);
        break;
      case "setdefault":
        await this.handleSetDefault(msg, args[2]);
        break;
      default:
        await msg.edit({ text: helpText, parseMode: "html" });
    }
  }

  private async handleInstall(msg: Api.Message, dirArg?: string) {
    try {
      if (process.platform !== "linux") {
        await msg.edit({ text: "仅支持 Linux（systemd）环境" });
        return;
      }

      const hasSystemd = await this.hasCmd("systemctl");
      const hasCurl = await this.hasCmd("curl");
      const hasTar = await this.hasCmd("tar");
      if (!hasSystemd || !hasCurl || !hasTar) {
        const missing = [
          !hasSystemd ? "systemctl" : "",
          !hasCurl ? "curl" : "",
          !hasTar ? "tar" : "",
        ]
          .filter(Boolean)
          .join(", ");
        await msg.edit({ text: `缺少依赖：${missing}` });
        return;
      }

      const arch = this.mapArch(process.arch);
      if (!arch) {
        await msg.edit({ text: `暂不支持当前架构：${process.arch}` });
        return;
      }

      let installBase = dirArg && dirArg.trim() ? dirArg.trim() : "/opt/openlist";
      const installPath = this.normalizeInstallPath(installBase);

      if (await this.fileExists(`${installPath}/openlist`)) {
        await msg.edit({ text: `检测到已安装于：${installPath}\n请使用：${commandName} update` });
        return;
      }

      await msg.edit({ text: `开始安装到：${installPath}` });
      await execAsync(`mkdir -p "${installPath}"`);

      const tarPath = "/tmp/openlist.tar.gz";
      const url = `${GH_BASE_DOWNLOAD}/openlist-linux-musl-${arch}.tar.gz`;
      await execAsync(
        `curl -L --connect-timeout 10 --retry 3 --retry-delay 3 "${url}" -o "${tarPath}"`
      );
      await execAsync(`tar zxf "${tarPath}" -C "${installPath}/"`);
      await execAsync(`chmod +x "${installPath}/openlist"`);

      const serviceContent = [
        "[Unit]",
        "Description=OpenList service",
        "After=network.target",
        "",
        "[Service]",
        "Type=simple",
        `WorkingDirectory=${installPath}`,
        `ExecStart=${installPath}/openlist server`,
        "KillMode=process",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ].join("\n");

      await execAsync(
        `bash -lc 'cat > /etc/systemd/system/openlist.service <<\"EOF\"\n${serviceContent}\nEOF'`
      );
      await execAsync(`systemctl daemon-reload`);
      await execAsync(`systemctl enable openlist`);
      await execAsync(`systemctl restart openlist`);

      const { stdout: randOut } = await execAsync(
        `bash -lc 'cd "${installPath}" && ./openlist admin random 2>&1 || true'`
      );
      const userMatch = randOut.match(/username:\s*(\S+)/i);
      const passMatch = randOut.match(/password:\s*(\S+)/i);
      const username = userMatch ? userMatch[1] : "";
      const password = passMatch ? passMatch[1] : "";

      // 自动保存初始凭证
      if (username && password) {
        await this.updateStoredCredentials(username, password);
      }

      const { stdout: verOut } = await execAsync(
        `bash -lc '"${installPath}/openlist" version 2>&1 || true'`
      );
      const verMatch = verOut.match(/Version:\s*([^\s]+)/);
      const version = verMatch ? verMatch[1] : "";

      let ip = "";
      try {
        const { stdout } = await execAsync(
          `bash -lc 'hostname -I 2>/dev/null | awk "{print $1}"'`
        );
        ip = (stdout || "").trim();
      } catch {}

      const lines: string[] = [];
      lines.push("安装完成");
      if (version) lines.push(`版本: ${version}`);
      lines.push(`目录: ${installPath}`);
      lines.push(`访问: http://${ip || "<服务器IP>"}:5244/`);
      if (username && password) {
        lines.push(`账号: ${username}`);
        lines.push(`密码: ${password}`);
      }
      await msg.edit({ text: lines.join("\n") });
    } catch (error: any) {
      await msg.edit({ text: `安装失败: ${error?.message || error}` });
    }
  }

  private async handleUpdate(msg: Api.Message) {
    try {
      if (process.platform !== "linux") {
        await msg.edit({ text: "仅支持 Linux（systemd）环境" });
        return;
      }

      const hasSystemd = await this.hasCmd("systemctl");
      const hasCurl = await this.hasCmd("curl");
      const hasTar = await this.hasCmd("tar");
      if (!hasSystemd || !hasCurl || !hasTar) {
        const missing = [
          !hasSystemd ? "systemctl" : "",
          !hasCurl ? "curl" : "",
          !hasTar ? "tar" : "",
        ]
          .filter(Boolean)
          .join(", ");
        await msg.edit({ text: `缺少依赖：${missing}` });
        return;
      }

      const arch = this.mapArch(process.arch);
      if (!arch) {
        await msg.edit({ text: `暂不支持当前架构：${process.arch}` });
        return;
      }

      const installPath = await this.detectInstalledPath();
      if (!(await this.fileExists(`${installPath}/openlist`))) {
        await msg.edit({ text: `未检测到已安装版本。可使用：${commandName} install` });
        return;
      }

      await msg.edit({ text: "开始更新..." });
      const tarPath = "/tmp/openlist.tar.gz";
      const url = `${GH_BASE_DOWNLOAD}/openlist-linux-musl-${arch}.tar.gz`;
      await execAsync(
        `curl -L --connect-timeout 10 --retry 3 --retry-delay 3 "${url}" -o "${tarPath}"`
      );

      await execAsync(`systemctl stop openlist || true`);
      await execAsync(`cp "${installPath}/openlist" /tmp/openlist.bak || true`);
      await execAsync(`tar zxf "${tarPath}" -C "${installPath}/"`);
      await execAsync(`chmod +x "${installPath}/openlist"`);
      await execAsync(`systemctl restart openlist`);

      const { stdout: verOut } = await execAsync(
        `bash -lc '"${installPath}/openlist" version 2>&1 || true'`
      );
      const verMatch = verOut.match(/Version:\s*([^\s]+)/);
      const version = verMatch ? verMatch[1] : "";
      await msg.edit({ text: `更新完成${version ? `，版本: ${version}` : ""}` });
    } catch (error: any) {
      await msg.edit({ text: `更新失败: ${error?.message || error}` });
    }
  }

  private async handleUninstall(msg: Api.Message) {
    try {
      if (process.platform !== "linux") {
        await msg.edit({ text: "仅支持 Linux（systemd）环境" });
        return;
      }

      const installPath = await this.detectInstalledPath();
      const existed = await this.fileExists(`${installPath}/openlist`);
      await execAsync(`systemctl stop openlist || true`);
      await execAsync(`systemctl disable openlist || true`);
      await execAsync(`rm -f /etc/systemd/system/openlist.service || true`);
      await execAsync(`systemctl daemon-reload || true`);
      if (existed) {
        await execAsync(`rm -rf "${installPath}"`);
      }
      await msg.edit({ text: "已卸载" });
    } catch (error: any) {
      await msg.edit({ text: `卸载失败: ${error?.message || error}` });
    }
  }

  private async handleBackup(msg: Api.Message) {
    try {
      const installPath = await this.detectInstalledPath();
      if (!(await this.dirExists(`${installPath}/data`))) {
        await msg.edit({ text: `未找到配置目录：${installPath}/data` });
        return;
      }

      const backupBaseDir = "/opt/openlist_backups";
      const { stdout: dateOut } = await execAsync(
        `bash -lc 'date +%Y%m%d_%H%M%S'`
      );
      const backupDir = `${backupBaseDir}/backup_${(dateOut || "").trim()}`;
      await execAsync(`mkdir -p "${backupDir}"`);
      await execAsync(`cp -r "${installPath}/data" "${backupDir}/"`);

      await msg.edit({ text: `备份成功\n目录: ${backupDir}` });
    } catch (error: any) {
      await msg.edit({ text: `备份失败: ${error?.message || error}` });
    }
  }

  private async handleRestore(msg: Api.Message, backupName?: string) {
    try {
      const installPath = await this.detectInstalledPath();
      const backupBaseDir = "/opt/openlist_backups";
      let targetBackupDir = "";

      if (backupName) {
        targetBackupDir = `${backupBaseDir}/${backupName}`;
      } else {
        const { stdout: latestOut } = await execAsync(
          `bash -lc 'ls -t "${backupBaseDir}" 2>/dev/null | head -n1'`
        );
        const latest = (latestOut || "").trim();
        if (!latest) {
          await msg.edit({ text: `未找到任何备份于：${backupBaseDir}` });
          return;
        }
        targetBackupDir = `${backupBaseDir}/${latest}`;
      }

      if (!(await this.dirExists(`${targetBackupDir}/data`))) {
        await msg.edit({ text: `无效的备份目录：${targetBackupDir}` });
        return;
      }

      await msg.edit({ text: `将从 ${targetBackupDir} 恢复...` });
      await execAsync(`systemctl stop openlist || true`);
      await execAsync(`cp -r "${targetBackupDir}/data" "${installPath}/"`);
      await execAsync(`systemctl start openlist`);

      await msg.edit({ text: "恢复成功" });
    } catch (error: any) {
      await msg.edit({ text: `恢复失败: ${error?.message || error}` });
    }
  }

  private async handleAdmin(msg: Api.Message, adminArgs: string[]) {
    try {
      const installPath = await this.detectInstalledPath();
      if (!(await this.fileExists(`${installPath}/openlist`))) {
        await msg.edit({ text: "未检测到 OpenList 安装" });
        return;
      }

      const sub = adminArgs[0] || "";
      const arg = adminArgs[1] || "";
      let cmd = "";

      // 记录需要更新的凭证
      let newUser = "";
      let newPass = "";

      switch (sub) {
        case "setuser":
          if (!arg) {
            await msg.edit({ text: "用法: admin setuser [新用户名]" });
            return;
          }
          cmd = `admin setuser "${arg}"`;
          newUser = arg;
          break;
        case "setpass":
          if (!arg) {
            await msg.edit({ text: "用法: admin setpass [新密码]" });
            return;
          }
          cmd = `admin set "${arg}"`; // 原脚本中使用 'set' 而非 'setpass'
          newPass = arg;
          break;
        case "random":
          cmd = "admin random";
          break;
        default:
          await msg.edit({ text: helpText, parseMode: "html" });
          return;
      }

      await msg.edit({ text: `正在执行: ${cmd}` });
      const { stdout } = await execAsync(
        `bash -lc 'cd "${installPath}" && ./openlist ${cmd} 2>&1'`
      );

      // 如果是 random，解析输出
      if (sub === "random") {
        const userMatch = stdout.match(/username:\s*(\S+)/i);
        const passMatch = stdout.match(/password:\s*(\S+)/i);
        if (userMatch) newUser = userMatch[1];
        if (passMatch) newPass = passMatch[1];
      }

      // 更新本地凭证
      if (newUser || newPass) {
        await this.updateStoredCredentials(newUser, newPass);
        await msg.edit({ text: `执行结果:\n\n<pre>${(stdout || "").trim()}</pre>\n\n✅ 凭证已同步更新`, parseMode: "html" });
      } else {
        await msg.edit({ text: `执行结果:\n\n<pre>${(stdout || "").trim()}</pre>`, parseMode: "html" });
      }
    } catch (error: any) {
      await msg.edit({ text: `管理命令失败: ${error?.message || error}` });
    }
  }

  private async handleLogin(msg: Api.Message, user?: string, pass?: string) {
    if (!user || !pass) {
      await msg.edit({ text: `用法: ${commandName} login [用户名] [密码]` });
      return;
    }
    await this.updateStoredCredentials(user, pass);
    await msg.edit({ text: "✅ 账号信息已保存，可以尝试上传文件了。" });
  }

  private async handleSetDefault(msg: Api.Message, path?: string) {
    const db = await this.getDb();
    if (!path) {
      // 清空默认路径，恢复为宿主机路径
      await db.update((data) => {
        data.defaultPath = "";
      });
      await msg.edit({ text: "✅ 默认上传路径已清空，将恢复为宿主机 /root/Openlist 路径。" });
      return;
    }
    await db.update((data) => {
      data.defaultPath = path;
    });
    await msg.edit({ text: `✅ 默认上传路径已设置为: ${path}\n\n现在使用 ${commandName} save 时若不指定路径，将默认上传到此位置。` });
  }

  private async updateStoredCredentials(user?: string, pass?: string) {
    const db = await this.getDb();
    await db.update((data) => {
      if (user) data.username = user;
      if (pass) data.password = pass;
    });
  }

  private async getDb() {
    const dbPath = path.join(createDirectoryInAssets("openlist"), "credentials.json");
    return await JSONFilePreset(dbPath, { username: "", password: "", defaultPath: "" });
  }


  private async handleSetPort(msg: Api.Message, port?: string) {
    try {
      if (!port || !/^\d+$/.test(port)) {
        await msg.edit({ text: `用法: ${commandName} setport [端口号]` });
        return;
      }

      const installPath = await this.detectInstalledPath();
      const configPath = `${installPath}/data/config.json`;
      if (!(await this.fileExists(configPath))) {
        await msg.edit({ text: "未找到配置文件，请先确保 OpenList 已成功运行一次。" });
        return;
      }

      await msg.edit({ text: `正在修改端口为 ${port}...` });
      await execAsync(`systemctl stop openlist || true`);
      // 使用 sed 安全地替换端口号
      await execAsync(
        `sed -i 's/"port": *[0-9]*/"port": ${port}/g' "${configPath}"`
      );
      await execAsync(`systemctl start openlist`);

      await msg.edit({ text: `端口已修改为 ${port}，服务已重启。` });
    } catch (error: any) {
      await msg.edit({ text: `端口修改失败: ${error?.message || error}` });
    }
  }

  private async handleSave(msg: Api.Message, targetPath?: string) {
    try {
      const replyToMsg = await msg.getReplyMessage();
      if (!replyToMsg || !replyToMsg.media) {
        await msg.edit({ text: "请回复一个文件、图片或视频来保存。" });
        return;
      }

      // 确定最终保存路径
      let finalPath = targetPath;
      if (!finalPath) {
        // 尝试读取默认路径
        const db = await this.getDb();
        finalPath = db.data.defaultPath || "";
      }

      const media = replyToMsg.media;
      let fileName = "";

      if (media instanceof Api.MessageMediaPhoto) {
        fileName = `photo_${Date.now()}.jpg`;
      } else if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
        const doc = media.document;
        const fileNameAttr = doc.attributes.find(
          (attr): attr is Api.DocumentAttributeFilename =>
            attr instanceof Api.DocumentAttributeFilename
        );

        if (fileNameAttr) {
          fileName = fileNameAttr.fileName;
        } else {
          // 根据 mimeType 推断后缀
          let ext = "";
          switch (doc.mimeType) {
            case "video/mp4": ext = ".mp4"; break;
            case "video/x-matroska": ext = ".mkv"; break;
            case "video/quicktime": ext = ".mov"; break;
            case "audio/mpeg": ext = ".mp3"; break;
            case "audio/ogg": ext = ".ogg"; break;
            case "audio/x-wav": ext = ".wav"; break;
            case "image/jpeg": ext = ".jpg"; break;
            case "image/png": ext = ".png"; break;
            case "image/webp": ext = ".webp"; break;
            case "image/gif": ext = ".gif"; break;
            case "application/pdf": ext = ".pdf"; break;
            case "application/zip": ext = ".zip"; break;
            default: ext = "";
          }
          fileName = `file_${Date.now()}${ext}`;
        }
      } else {
        // 其他媒体类型，暂时命名为 media_xxx
        fileName = `media_${Date.now()}`;
      }

      await msg.edit({ text: `正在下载: ${fileName}` });

      const client = await getGlobalClient();
      const buffer = await client.downloadMedia(replyToMsg.media);

      if (!buffer || !(buffer instanceof Buffer)) {
        await msg.edit({ text: "文件下载失败或格式不支持。" });
        return;
      }

      if (finalPath) {
        await this.uploadToOpenList(msg, buffer, fileName, finalPath);
      } else {
        const saveDir = "/root/Openlist";
        await fs.mkdir(saveDir, { recursive: true });
        const savePath = path.join(saveDir, fileName);
        await fs.writeFile(savePath, buffer);
        await msg.edit({ text: `文件已保存到: ${savePath}` });
      }
    } catch (error: any) {
      await msg.edit({ text: `文件保存失败: ${error?.message || error}` });
    }
  }

  private async uploadToOpenList(msg: Api.Message, buffer: Buffer, fileName: string, targetDir: string) {
    try {
      await msg.edit({ text: "正在登录 OpenList API..." });
      const credentials = await this.getOpenListCredentials();
      if (!credentials) {
        throw new Error("未找到 OpenList 凭证。\n请使用以下命令手动配置：\n`op login [用户名] [密码]`");
      }

      const token = await this.getOpenListToken(credentials.username, credentials.password);
      if (!token) {
        throw new Error("登录 OpenList 失败");
      }

      // 处理路径，确保是 API 友好的格式
      let fullPath = path.join(targetDir, fileName).replace(/\\/g, "/");
      if (!fullPath.startsWith("/")) fullPath = "/" + fullPath;
      // 移除多余的斜杠
      fullPath = fullPath.replace(/\/+/g, "/");

      await msg.edit({ text: `正在上传到: ${fullPath}` });

      const apiUrl = "http://127.0.0.1:5244/api/fs/put";
      
      // 注意：Header 中的中文路径需要编码
      await axios.put(apiUrl, buffer, {
        headers: {
          "Authorization": token,
          "File-Path": encodeURIComponent(fullPath),
          "path": encodeURIComponent(fullPath), 
          "Content-Type": "application/octet-stream",
          "As-Task": "false"
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });

      await msg.edit({ text: `✅ 文件已上传到 OpenList: ${fullPath}` });

    } catch (error: any) {
      console.error("OpenList Upload Error:", error);
      const errMsg = error?.response?.data?.message || error.message || "未知错误";
      throw new Error(`上传失败: ${errMsg}`);
    }
  }

  private async getOpenListCredentials() {
    // 1. Get DB credentials
    let dbUser = "";
    let dbPass = "";
    try {
      const db = await this.getDb();
      dbUser = db.data.username;
      dbPass = db.data.password;
    } catch (e) {}

    // 2. Get Config credentials
    let configUser = "";
    let configPass = "";
    const installPath = await this.detectInstalledPath();
    const configPath = `${installPath}/data/config.json`;

    if (await this.fileExists(configPath)) {
      try {
        let configContent = "";
        try {
          configContent = await fs.readFile(configPath, "utf-8");
        } catch {
          const { stdout } = await execAsync(`cat "${configPath}" 2>/dev/null`);
          configContent = stdout;
        }

        if (configContent) {
          const config = JSON.parse(configContent);
          if (config.users && config.users.length > 0) {
            configUser = config.users[0].username;
            configPass = config.users[0].password;
          }
        }
      } catch (e) {
        console.error("Error reading config:", e);
      }
    }

    // 3. Merge (Prefer DB)
    // If DB is missing username but has password (e.g. after setpass), use config username
    const finalUser = dbUser || configUser;
    // If DB is missing password but has username (e.g. after setuser), use config password (if available/valid)
    const finalPass = dbPass || configPass;

    if (finalUser && finalPass) {
      // Auto-sync if we had to combine sources
      if (!dbUser || !dbPass) {
        await this.updateStoredCredentials(finalUser, finalPass);
      }
      return { username: finalUser, password: finalPass };
    }
    
    return null;
  }

  private async getOpenListToken(username: string, password: string): Promise<string> {
    try {
      const response = await axios.post("http://127.0.0.1:5244/api/auth/login", {
        username,
        password
      });
      if (response.data && response.data.code === 200) {
        return response.data.data.token;
      }
      throw new Error(response.data?.message || "Login failed");
    } catch (error) {
      throw error;
    }
  }

  private async handleStatus(msg: Api.Message) {
    try {
      if (process.platform !== "linux") {
        await msg.edit({ text: "仅支持 Linux（systemd）环境" });
        return;
      }
      const installPath = await this.detectInstalledPath();
      const installed = await this.fileExists(`${installPath}/openlist`);
      const { stdout: activeOut } = await execAsync(
        `bash -lc 'systemctl is-active openlist 2>/dev/null || true'`
      );
      const status = (activeOut || "").trim() || "unknown";

      const { stdout: portOut } = await execAsync(
        `bash -lc '(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep -q ":5244" && echo listen || echo closed'`
      );
      const port = (portOut || "").trim();

      let version = "";
      if (installed) {
        try {
          const { stdout: verOut } = await execAsync(
            `bash -lc '"${installPath}/openlist" version 2>&1 | grep -E "^Version:" || true'`
          );
          const m = verOut.match(/Version:\s*([^\s]+)/);
          version = m ? m[1] : "";
        } catch {}
      }

      let publicIp = "";
      try {
        const { stdout: ipOut } = await execAsync(
          `bash -lc 'curl -s4 --connect-timeout 5 ip.sb || curl -s4 --connect-timeout 5 ifconfig.me'`
        );
        publicIp = (ipOut || "").trim();
      } catch {}

      const lines: string[] = [];
      lines.push(`<b>状态:</b> ${installed ? `已安装` : "未安装"}`);
      lines.push(`<b>服务:</b> ${status}`);
      if (version) lines.push(`<b>版本:</b> ${version}`);
      lines.push(`<b>端口:</b> ${port}`);
      if (publicIp && port === "listen") {
        lines.push(`<b>链接:</b> <a href="http://${publicIp}:5244/">http://${publicIp}:5244/</a>`);
      }

      // 显示用户账户信息
      const configPath = `${installPath}/data/config.json`;
      if (await this.fileExists(configPath)) {
        try {
          const configContent = await fs.readFile(configPath, "utf-8");
          const config = JSON.parse(configContent);
          if (config.users && config.users.length > 0) {
            lines.push("\n<b>账户信息:</b>");
            config.users.forEach((user: any, index: number) => {
              lines.push(`${index + 1}. <b>用户:</b> ${user.username} | <b>密码:</b> ${user.password}`);
            });
          }
        } catch (e) {
          lines.push("\n无法解析账户信息。");
        }
      }

      await msg.edit({ text: lines.join("\n"), parseMode: "html" });
    } catch (error: any) {
      await msg.edit({ text: `状态获取失败: ${error?.message || error}` });
    }
  }

  private mapArch(nodeArch: string): string | null {
    const map: Record<string, string> = {
      x64: "amd64",
      arm64: "arm64",
      s390x: "s390x",
      loong64: "loong64",
    };
    return map[nodeArch] || null;
  }

  private normalizeInstallPath(input: string): string {
    let p = input.replace(/\/+$/, "");
    if (!p.endsWith("/openlist")) p = `${p}/openlist`;
    return p;
  }

  private async detectInstalledPath(): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `bash -lc 'grep -E "^WorkingDirectory=" /etc/systemd/system/openlist.service 2>/dev/null | head -n1 | cut -d= -f2'`
      );
      const p = (stdout || "").trim();
      if (p) return p;
    } catch {}
    return "/opt/openlist";
  }

  private async hasCmd(cmd: string): Promise<boolean> {
    try {
      await execAsync(`bash -lc 'command -v ${cmd} >/dev/null 2>&1'`);
      return true;
    } catch {
      return false;
    }
  }

  private async dirExists(path: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `bash -lc '[ -d "${path}" ] && echo 1 || echo 0'`
      );
      return stdout.trim() === "1";
    } catch {
      return false;
    }
  }

  private async isSavedMessages(msg: Api.Message): Promise<boolean> {
    const client = await getGlobalClient();
    const me = await client?.getMe();
    if (!me || !msg.peerId) return false;

    return (
      "userId" in msg.peerId &&
      msg.peerId.userId?.toString() === me.id.toString()
    );
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `bash -lc '[ -f "${path}" ] && echo 1 || echo 0'`
      );
      return stdout.trim() === "1";
    } catch {
      return false;
    }
  }
}

export default new OpenListPlugin();

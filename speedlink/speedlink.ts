/**
 * SpeedLink Multi-Server Management Plugin for TeleBox
 *
 * Version: 5.7.0 (Command Renamed)
 * Features:
 * - Renamed command to `speedlink` (alias `sl`).
 * - Safe renaming procedure with backup/restore.
 * - Smart, sequential, and privacy-respecting server listing.
 * - Automatically generates and saves a unique encryption key.
 * - Auto-installs dependencies on first run.
 */

import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import path from "path";
import * as fs from "fs";
import axios from "axios";
import crypto from 'crypto';

const execAsync = promisify(exec);

// --- 接口与类型定义 ---
interface ServerConfig {
    id: number;
    name: string;
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key';
    credentials: string;
}

interface SpeedtestResult {
    isp: string;
    server: { id: number; name: string; location: string };
    interface: { externalIp: string; name: string };
    ping: { latency: number; jitter: number };
    download: { bandwidth: number; bytes: number };
    upload: { bandwidth: number; bytes: number };
    timestamp: string;
    result: { url: string };
}

// --- 依赖状态管理 ---
let dependenciesInstalled = false;
let isInstalling = false;

try {
    require.resolve('better-sqlite3');
    execSync('command -v sshpass');
    dependenciesInstalled = true;
} catch (e) {
    dependenciesInstalled = false;
}

// --- 异步安装函数 ---
async function installDependencies(msg: Api.Message): Promise<void> {
    isInstalling = true;
    try {
        console.log("SpeedLink Plugin: Starting async dependency installation...");
        try { require.resolve('better-sqlite3'); } catch (e) {
            console.log("[INSTALLING] 'better-sqlite3' not found. Installing via npm...");
            await execAsync('npm install better-sqlite3');
            console.log("[SUCCESS] Installed 'better-sqlite3'.");
        }
        try { execSync('command -v sshpass'); } catch(e) {
            console.log("[INSTALLING] 'sshpass' not found. Installing via system package manager...");
            if (fs.existsSync('/usr/bin/apt-get')) {
                await execAsync('sudo apt-get update && sudo apt-get install -y sshpass');
            } else if (fs.existsSync('/usr/bin/yum')) {
                await execAsync('sudo yum install -y sshpass');
            } else { throw new Error('Unsupported package manager.'); }
            console.log("[SUCCESS] Installed 'sshpass'.");
        }
        await msg.edit({
            text: "✅ <b>依赖安装完成！</b>\n\n为了使插件生效，请现在<b>重启TeleBox</b>。\n重启后即可正常使用所有 <code>sl</code> 指令。",
            parseMode: "html"
        });
        dependenciesInstalled = false; 
    } catch (error: any) {
        console.error("[FATAL] Dependency installation failed:", error);
        await msg.edit({
            text: `❌ <b>依赖自动安装失败！</b>\n\n请检查服务器后台日志获取详细错误信息，并尝试手动安装依赖。`,
            parseMode: "html"
        });
    } finally {
        isInstalling = false;
    }
}

// --- 依赖加载 ---
let Database: any = null;
if (dependenciesInstalled) {
    Database = require('better-sqlite3');
}

// --- 辅助函数 ---
function createDirectoryInAssets(dir: string): string {
  const assetsRoot = path.join(__dirname, '..', 'assets');
  if (!fs.existsSync(assetsRoot)) fs.mkdirSync(assetsRoot, { recursive: true });
  const fullPath = path.join(assetsRoot, dir);
  if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
  return fullPath;
}

// --- 常量与路径 ---
const PLUGIN_NAME = path.basename(__filename, path.extname(__filename));
const ASSETS_DIR = createDirectoryInAssets(PLUGIN_NAME);
const DB_PATH = path.join(ASSETS_DIR, 'servers.db');
const KEY_PATH = path.join(ASSETS_DIR, 'secret.key');

// --- 自动主密钥管理 ---
function getEncryptionKey(): string {
  if (fs.existsSync(KEY_PATH)) {
    return fs.readFileSync(KEY_PATH, 'utf-8');
  } else {
    const newKey = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(KEY_PATH, newKey, 'utf-8');
    console.log(`SpeedLink Plugin (${PLUGIN_NAME}): New encryption key generated.`);
    return newKey;
  }
}

const ENCRYPTION_KEY = getEncryptionKey();
const IV_LENGTH = 16;
let db: any = null;
if (Database) {
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, host TEXT NOT NULL,
        port INTEGER NOT NULL, username TEXT NOT NULL, auth_method TEXT NOT NULL, credentials TEXT NOT NULL
      )
    `);
}

function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text: string): string {
  try {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift()!, 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString();
  } catch (error) {
    throw new Error("Failed to decrypt credentials. The key file may have been changed/deleted.");
  }
}

function htmlEscape(text: string): string {
  return text?.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") || '';
}

async function unitConvert(bytes: number, isBytes: boolean = false): Promise<string> {
    const power = 1000; let value = bytes; let unitIndex = 0;
    const units = isBytes ? ["B", "KB", "MB", "GB", "TB"] : ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
    if (!isBytes) value *= 8;
    while (value >= power && unitIndex < units.length - 1) { value /= power; unitIndex++; }
    return `${(Math.round(value * 100) / 100)}${units[unitIndex]}`;
}

async function getIpApi(ip: string) {
    try {
        const response = await axios.get(`http://ip-api.com/json/${ip}?fields=as,countryCode`);
        const data = response.data;
        const asInfo = data.as?.split(" ")[0] || "";
        const ccFlag = data.countryCode ? String.fromCodePoint(...data.countryCode.toUpperCase().split("").map((c: string) => 127397 + c.charCodeAt(0))) : "";
        return { asInfo, ccFlag };
    } catch { return { asInfo: "", ccFlag: "" }; }
}

async function saveSpeedtestImage(url: string): Promise<string | null> {
  try {
    const imageUrl = url + ".png";
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const imagePath = path.join(ASSETS_DIR, "speedtest_result.png");
    fs.writeFileSync(imagePath, response.data);
    return imagePath;
  } catch (error) {
    console.error("Failed to save speedtest image:", error);
    return null;
  }
}

const HELP_TEXT = `
本插件可以对本机或多台远程服务器进行网络速度测试，并支持保存和管理服务器配置。

<b>⚠️ 远程服务器要求</b>
为了测试远程服务器，您必须首先在该服务器上安装 <b>Ookla Speedtest CLI</b>。
- <b>Debian/Ubuntu 系统:</b>
<pre><code>curl -sL https://.../script.deb.sh | sudo bash
sudo apt-get install speedtest</code></pre>
- <b>CentOS/RHEL 系统:</b>
<pre><code>curl -sL https://.../script.rpm.sh | sudo bash
sudo yum install speedtest</code></pre>
---
<b>服务器管理指令:</b>

- <b>添加服务器 (密码认证):</b>
  <code>sl add &lt;别名&gt; &lt;user@host:port&gt; password &lt;密码&gt;</code>
  <i>示例:</i> <code>sl add 东京-甲骨文 root@1.2.3.4:22 password MyPassword123</code>

- <b>添加服务器 (密钥认证):</b>
  <code>sl add &lt;别名&gt; &lt;user@host:port&gt; key &lt;私钥路径&gt;</code>
  <i>注意: 私钥路径是指在<b>运行TeleBox的服务器上</b>的绝对路径。</i>
  <i>示例:</i> <code>sl add 法兰克福-谷歌 ubuntu@5.6.7.8:22 key /root/.ssh/id_rsa</code>

- <b>查看服务器列表:</b> <code>sl list</code>
- <b>删除服务器:</b> <code>sl del &lt;显示序号&gt;</code>
---
<b>执行测速指令:</b>

- <b>远程测速:</b> <code>sl &lt;显示序号&gt;</code>
- <b>本机测速:</b> <code>sl local</code>
---
<b>备份与恢复:</b>

- <b>备份:</b> <code>sl backup</code>
  (将数据备份到您的收藏夹)

- <b>恢复:</b> 回复备份文件, 发送 <code>sl restore confirm</code>
  (此操作将覆盖现有数据, 请谨慎使用)
`;

// --- 主处理函数 ---
const speedtest = async (msg: Api.Message): Promise<void> => {
  if (!dependenciesInstalled) {
    if (isInstalling) {
      await msg.edit({ text: "⏳ <b>依赖已在安装中...</b>", parseMode: "html" });
    } else {
      await msg.edit({ text: "首次运行，正在自动安装依赖...", parseMode: "html" });
      installDependencies(msg);
    }
    return;
  }

  const args = msg.message.slice(2).split(" ").slice(1);
  const command = args[0] || "";

  try {
    if (command === "add" || command === "list" || command === "del" || command === "backup" || command === "restore") {
        if (command === "add") {
            const [name, connection, authMethod, ...creds] = args.slice(1);
            const credential = creds.join(' ');
            if (!name || !connection || !authMethod || !credential || !['password', 'key'].includes(authMethod)) {
                await msg.edit({ text: `❌ <b>参数错误</b>\n\n${HELP_TEXT}`, parseMode: "html" }); return;
            }
            const [username, hostWithPort] = connection.split('@');
            const [host, portStr] = hostWithPort.split(':');
            const port = parseInt(portStr);
            if (!username || !host || !port) {
                await msg.edit({ text: `❌ <b>连接格式错误</b>`, parseMode: "html" }); return;
            }
            const storedCredential = authMethod === 'password' ? encrypt(credential) : credential;
            try {
                db.prepare('INSERT INTO servers (name, host, port, username, auth_method, credentials) VALUES (?, ?, ?, ?, ?, ?)').run(name, host, port, username, authMethod, storedCredential);
                await msg.edit({ text: `✅ 服务器 <b>${htmlEscape(name)}</b> 添加成功！`, parseMode: "html" });
            } catch (err: any) { await msg.edit({ text: `❌ 添加失败: <code>${htmlEscape(err.message)}</code>`, parseMode: "html" }); }
        } else if (command === "list") {
            const servers: ServerConfig[] = db.prepare('SELECT * FROM servers ORDER BY id').all();
            if (servers.length === 0) { await msg.edit({ text: "ℹ️ 未配置任何远程服务器。", parseMode: "html" }); return; }
            const serverList = servers.map((s: ServerConfig, i: number) => `<code>${i + 1}</code> - <b>${htmlEscape(s.name)}</b>`).join('\n');
            await msg.edit({ text: `<b>已配置的服务器列表:</b>\n${serverList}`, parseMode: "html" });
        } else if (command === "del") {
            const displayId = parseInt(args[1]);
            if (isNaN(displayId) || displayId < 1) { await msg.edit({ text: "❌ 请提供有效的显示序号。", parseMode: "html" }); return; }
            const servers: ServerConfig[] = db.prepare('SELECT * FROM servers ORDER BY id').all();
            const serverToDelete = servers[displayId - 1];
            if (!serverToDelete) { await msg.edit({ text: `❌ 未找到显示序号为 ${displayId} 的服务器。`, parseMode: "html" }); return; }
            const info = db.prepare('DELETE FROM servers WHERE id = ?').run(serverToDelete.id);
            await msg.edit({ text: info.changes > 0 ? `✅ 服务器 <b>${htmlEscape(serverToDelete.name)}</b> (显示序号 ${displayId}) 已删除。` : `❌ 删除失败。`, parseMode: "html" });
        } else if (command === "backup") {
            if (!fs.existsSync(DB_PATH)) { await msg.edit({ text: `❌ 数据库文件不存在，无法备份。`, parseMode: "html" }); return; }
            await msg.edit({ text: `⚙️ 正在准备备份文件...`, parseMode: "html" });
            const date = new Date().toISOString().split('T')[0];
            const backupFilename = `${PLUGIN_NAME}_backup_${date}.db`;
            await msg.client?.sendFile('me', { file: DB_PATH, caption: `SpeedLink 插件服务器数据备份\n日期: ${date}`, attributes: [new Api.DocumentAttributeFilename({ fileName: backupFilename })] });
            await msg.edit({ text: `✅ 备份成功！\n\n文件已发送至您的<b>收藏夹 (Saved Messages)</b>。`, parseMode: "html" });
        } else if (command === "restore") {
            if (!msg.isReply) { await msg.edit({ text: `❌ <b>恢复失败</b>\n\n请回复一个备份文件来执行此命令。`, parseMode: "html" }); return; }
            if (args[1] !== 'confirm') {
                await msg.edit({ text: `⚠️ <b>请确认操作！</b>\n\n此操作将用备份文件覆盖当前的服务器列表，现有数据将丢失。\n\n请回复备份文件并使用 <code>sl restore confirm</code> 来确认。`, parseMode: "html" }); return;
            }
            const repliedMsg = await msg.getReplyMessage();
            if (!repliedMsg?.document) { await msg.edit({ text: `❌ <b>恢复失败</b>\n\n您回复的消息不包含文件。`, parseMode: "html" }); return; }

            await msg.edit({ text: `⚙️ 正在从备份文件恢复数据...`, parseMode: "html" });
            const buffer = await msg.client?.downloadMedia(repliedMsg.media);
            if (buffer) {
                if (fs.existsSync(DB_PATH)) { fs.renameSync(DB_PATH, DB_PATH + '.bak'); }
                fs.writeFileSync(DB_PATH, buffer);
                await msg.edit({ text: `✅ <b>恢复成功！</b>\n\n数据已从备份文件导入。请**重启TeleBox**以应用更改。`, parseMode: "html" });
            } else {
                await msg.edit({ text: `❌ <b>恢复失败</b>\n\n无法下载备份文件。`, parseMode: "html" });
            }
        }
        return;
    }

    // --- Speed Test Execution ---
    let isRemote = false;
    let serverConfig: ServerConfig | null = null;
    let initialText: string;

    if (command === "" || command === "local") {
        isRemote = false;
        initialText = "⚡️ 正在进行<b>本机</b>速度测试...";
    } else if (!isNaN(parseInt(command))) {
        isRemote = true;
        const displayId = parseInt(command);
        if (displayId < 1) { await msg.edit({ text: "❌ 请提供有效的显示序号。" }); return; }
        const servers: ServerConfig[] = db.prepare('SELECT * FROM servers ORDER BY id').all();
        serverConfig = servers[displayId - 1];
        if (!serverConfig) { await msg.edit({ text: `❌ 未找到显示序号为 ${displayId} 的服务器。` }); return; }
        initialText = `⚡️ 正在为服务器 <b>${htmlEscape(serverConfig.name)}</b> 进行远程测速...`;
    } else {
       await msg.edit({ text: `<b>指令无效</b>\n\n${HELP_TEXT}`, parseMode: "html" });
       return;
    }
    
    await msg.edit({ text: initialText, parseMode: "html" });

    try {
        const speedtestCmd = `speedtest --accept-license --accept-gdpr -f json`;
        let finalCommand;

        if (isRemote && serverConfig) {
            if (serverConfig.auth_method === 'password') {
                const password = decrypt(serverConfig.credentials);
                finalCommand = `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh -p ${serverConfig.port} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${serverConfig.username}@${serverConfig.host} '${speedtestCmd}'`;
            } else {
                finalCommand = `ssh -i ${serverConfig.credentials} -p ${serverConfig.port} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${serverConfig.username}@${serverConfig.host} '${speedtestCmd}'`;
            }
        } else {
            finalCommand = speedtestCmd;
        }
        
        const { stdout } = await execAsync(finalCommand, { timeout: 300000 });
        const jsonStartIndex = stdout.indexOf('{');
        if (jsonStartIndex === -1) throw new Error("Speedtest did not return valid JSON.");
        const result: SpeedtestResult = JSON.parse(stdout.substring(jsonStartIndex));
        
        const { asInfo, ccFlag } = await getIpApi(result.interface.externalIp);
        
        const caption = [
          `<b>⚡️SPEEDTEST by OOKLA</b> ${ccFlag}`,
          `<code>Name</code>  <code>${htmlEscape(result.isp)} ${asInfo}</code>`,
          `<code>Node</code>  <code>${result.server.id} - ${htmlEscape(result.server.name)} - ${htmlEscape(result.server.location)}</code>`,
          `<code>Conn</code>  <code>Multi - IPv${result.interface.externalIp.includes(':') ? '6' : '4'} - ${htmlEscape(result.interface.name)}</code>`,
          `<code>Ping</code>  <code>⇔${result.ping.latency.toFixed(3)}ms ±${result.ping.jitter.toFixed(3)}ms</code>`,
          `<code>Rate</code>  <code>↓${await unitConvert(result.download.bandwidth)} ↑${await unitConvert(result.upload.bandwidth)}</code>`,
          `<code>Data</code>  <code>↓${await unitConvert(result.download.bytes, true)} ↑${await unitConvert(result.upload.bytes, true)}</code>`,
          `<code>Time</code>  <code>${result.timestamp.replace('T', ' ').replace('Z', '')}</code>`
        ].join("\n");

        const imagePath = await saveSpeedtestImage(result.result.url);
        if (imagePath && fs.existsSync(imagePath)) {
            await msg.client?.sendFile(msg.peerId, { file: imagePath, caption: caption, parseMode: "html" });
            await msg.delete();
            fs.unlinkSync(imagePath);
        } else {
            await msg.edit({ text: caption, parseMode: "html" });
        }
    } catch (error: any) {
        let errorMsg = String(error.stderr || error.message || error);
        await msg.edit({ text: `❌ <b>速度测试失败</b>\n\n<code>${htmlEscape(errorMsg)}</code>`, parseMode: "html" });
    }
  } catch (error: any) {
    console.error(`SpeedLink Plugin (${PLUGIN_NAME}) critical error:`, error);
    await msg.edit({ text: `❌ <b>插件发生严重错误</b>\n\n<code>${htmlEscape(String(error))}</code>`, parseMode: "html" });
  }
};

// --- 插件类定义 ---
class SpeedlinkPlugin extends Plugin {
  description: string = `⚡️ 网络速度测试工具 (多服务器/自动密钥版)\n\n${HELP_TEXT}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = { 
    speedlink: speedtest,
    sl: speedtest 
  };
}

export default new SpeedlinkPlugin();

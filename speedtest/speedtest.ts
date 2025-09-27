/**
 * SpeedNext plugin for TeleBox - Network Speed Test
 * Converted from PagerMaid-Modify speednext.py
 */

import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { TelegramClient } from "telegram";
import {
  createDirectoryInAssets,
  createDirectoryInTemp,
} from "@utils/pathHelpers";
import * as fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import axios from "axios";
import sharp from "sharp";
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "speedtest";

const commandName = `${mainPrefix}${pluginName}`;

const help_txt = `<b>使用方法:</b>
<code>${commandName}</code> - 开始速度测试
<code>${commandName} [服务器ID]</code> - 使用指定服务器测试
<code>${commandName} list</code> - 显示可用服务器列表
<code>${commandName} test [服务器ID]</code> - 测试指定服务器可用性
<code>${commandName} best</code> - 查找最佳可用服务器
<code>${commandName} set [ID]</code> - 设置默认服务器
<code>${commandName} type photo/sticker/file/txt</code> - 设置优先使用的消息类型
<code>${commandName} clear</code> - 清除默认服务器
<code>${commandName} config</code> - 显示配置信息
<code>${commandName} check</code> - 检查网络连接状态
<code>${commandName} update</code> - 更新 Speedtest CLI`;
// HTML escape function
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const execAsync = promisify(exec);
const ASSETS_DIR = createDirectoryInAssets("speedtest");
const TEMP_DIR = createDirectoryInTemp("speedtest");
const SPEEDTEST_PATH = path.join(ASSETS_DIR, "speedtest");
const SPEEDTEST_JSON = path.join(ASSETS_DIR, "speedtest.json");
const SPEEDTEST_VERSION = "1.2.0";

type MessageType = "photo" | "sticker" | "file" | "txt";
const DEFAULT_ORDER: MessageType[] = ["photo", "sticker", "file", "txt"];

interface SpeedtestConfig {
  default_server_id?: number | null;
  preferred_type?: MessageType;
}

interface SpeedtestResult {
  isp: string;
  server: {
    id: number;
    name: string;
    location: string;
  };
  interface: {
    externalIp: string;
    name: string;
  };
  ping: {
    latency: number;
    jitter: number;
  };
  download: {
    bandwidth: number;
    bytes: number;
  };
  upload: {
    bandwidth: number;
    bytes: number;
  };
  timestamp: string;
  result: {
    url: string;
  };
}

interface ServerInfo {
  id: number;
  name: string;
  location: string;
  distance?: number;
  ping?: number;
  available?: boolean;
  error?: string;
}
async function fillRoundedCorners(
  inputPath: string,
  outPath?: string,
  bgColor: string = "#212338",
  borderPx: number = 14
) {
  const meta = await sharp(inputPath).metadata();

  // Choose an output path if not provided
  const output =
    outPath ??
    (() => {
      const dir = path.dirname(inputPath);
      const ext =
        meta.format === "jpeg" || meta.format === "jpg" ? ".jpg" : ".png";
      const base = path.basename(inputPath, path.extname(inputPath));
      return path.join(dir, `${base}.filled${ext}`);
    })();

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) {
    throw new Error("Unable to read image dimensions");
  }

  // Clamp border so remaining area stays at least 1x1
  const maxInset = Math.floor((Math.min(width, height) - 1) / 2);
  const inset = Math.max(0, Math.min(borderPx, maxInset));
  const cropW = width - inset * 2;
  const cropH = height - inset * 2;

  // Background canvas with original dimensions
  const background = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: bgColor,
    },
  });

  // Inner cropped image (removes the outer border)
  const innerBuf = await sharp(inputPath)
    .extract({ left: inset, top: inset, width: cropW, height: cropH })
    .toBuffer();

  // Center the inner image on the background
  const left = Math.floor((width - cropW) / 2);
  const top = Math.floor((height - cropH) / 2);

  let composed = background.composite([{ input: innerBuf, left, top }]);

  // Encode based on original format; default to PNG if unknown
  if (meta.format === "jpeg" || meta.format === "jpg") {
    composed = composed.jpeg({ quality: 95 });
  } else if (meta.format === "png" || !meta.format) {
    composed = composed.png({ compressionLevel: 9 });
  }

  await composed.toFile(output);
  return { output };
}
function ensureDirectories(): void {
  // createDirectoryInAssets already ensures directory exists
  // No additional action needed
}

function readConfig(): SpeedtestConfig {
  try {
    if (fs.existsSync(SPEEDTEST_JSON)) {
      const data = JSON.parse(fs.readFileSync(SPEEDTEST_JSON, "utf8"));
      return data as SpeedtestConfig;
    }
  } catch (error: any) {
    console.error("Failed to read config:", error);
  }
  return {};
}

function writeConfig(patch: Partial<SpeedtestConfig>): void {
  try {
    ensureDirectories();
    const current = readConfig();
    const next = { ...current, ...patch };
    fs.writeFileSync(SPEEDTEST_JSON, JSON.stringify(next));
  } catch (error: any) {
    console.error("Failed to write config:", error);
  }
}

function getDefaultServer(): number | null {
  const cfg = readConfig();
  return cfg.default_server_id ?? null;
}

function saveDefaultServer(serverId: number | null): void {
  writeConfig({ default_server_id: serverId });
}

function removeDefaultServer(): void {
  try {
    // Only clear default_server_id while preserving other settings
    const cfg = readConfig();
    delete cfg.default_server_id;
    fs.writeFileSync(SPEEDTEST_JSON, JSON.stringify(cfg));
  } catch (error: any) {
    console.error("Failed to remove default server:", error);
  }
}

function getPreferredType(): MessageType | null {
  const cfg = readConfig();
  return (cfg.preferred_type as MessageType) || null;
}

function savePreferredType(t: MessageType): void {
  writeConfig({ preferred_type: t });
}

function getMessageOrder(): MessageType[] {
  const preferred = getPreferredType();
  if (!preferred) return DEFAULT_ORDER.slice();
  return [preferred, ...DEFAULT_ORDER.filter((x) => x !== preferred)];
}

async function downloadCli(): Promise<void> {
  try {
    ensureDirectories();

    // 检查是否已存在
    if (fs.existsSync(SPEEDTEST_PATH)) {
      return;
    }

    const platform = process.platform;
    const arch = process.arch;

    let filename: string;
    if (platform === "linux") {
      const archMap: { [key: string]: string } = {
        x64: "x86_64",
        arm64: "aarch64",
        arm: "armhf",
      };
      const mappedArch = archMap[arch] || "x86_64";
      filename = `ookla-speedtest-${SPEEDTEST_VERSION}-linux-${mappedArch}.tgz`;
    } else if (platform === "win32") {
      filename = `ookla-speedtest-${SPEEDTEST_VERSION}-win64.zip`;
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    const url = `https://install.speedtest.net/app/cli/${filename}`;
    const response = await axios.get(url, { responseType: "arraybuffer" });

    const tempFile = path.join(ASSETS_DIR, filename);
    fs.writeFileSync(tempFile, response.data);

    // 解压文件
    if (platform === "linux") {
      await execAsync(`tar -xzf "${tempFile}" -C "${ASSETS_DIR}"`);
      await execAsync(`chmod +x "${SPEEDTEST_PATH}"`);
    } else if (platform === "win32") {
      // Windows 需要解压 zip 文件
      const AdmZip = require("adm-zip");
      const zip = new AdmZip(tempFile);
      zip.extractAllTo(ASSETS_DIR, true);
    }

    // 清理临时文件
    fs.unlinkSync(tempFile);

    // 清理额外文件
    const extraFiles = ["speedtest.5", "speedtest.md"];
    for (const file of extraFiles) {
      const filePath = path.join(ASSETS_DIR, file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (error: any) {
    console.error("Failed to download speedtest CLI:", error);
    throw error;
  }
}

async function unitConvert(
  bytes: number,
  isBytes: boolean = false
): Promise<string> {
  const power = 1000;
  let value = bytes;
  let unitIndex = 0;

  const units = isBytes
    ? ["B", "KB", "MB", "GB", "TB"]
    : ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];

  if (!isBytes) {
    value *= 8; // Convert bytes to bits
  }

  while (value >= power && unitIndex < units.length - 1) {
    value /= power;
    unitIndex++;
  }

  return `${Math.round(value * 100) / 100}${units[unitIndex]}`;
}

async function getIpApi(ip: string): Promise<{
  asInfo: string;
  ccName: string;
  ccCode: string;
  ccFlag: string;
  ccLink: string;
}> {
  try {
    const response = await axios.get(
      `http://ip-api.com/json/${ip}?fields=as,country,countryCode`
    );
    const data = response.data;

    const asInfo = data.as?.split(" ")[0] || "";
    const ccName =
      data.country === "Netherlands" ? "Netherlands" : data.country || "";
    const ccCode = data.countryCode || "";
    const ccFlag = ccCode
      ? String.fromCodePoint(
          ...ccCode
            .toUpperCase()
            .split("")
            .map((c: string) => 127397 + c.charCodeAt(0))
        )
      : "";

    let ccLink = "https://www.submarinecablemap.com/country/";
    if (["Hong Kong", "Macao", "Macau"].includes(ccName)) {
      ccLink += "china";
    } else {
      ccLink += ccName.toLowerCase().replace(" ", "-");
    }

    return { asInfo, ccName, ccCode, ccFlag, ccLink };
  } catch (error: any) {
    console.error("Failed to get IP info:", error);
    return { asInfo: "", ccName: "", ccCode: "", ccFlag: "", ccLink: "" };
  }
}

async function getInterfaceTraffic(interfaceName: string): Promise<{
  rxBytes: number;
  txBytes: number;
  mtu: number;
}> {
  try {
    if (process.platform === "linux") {
      const rxBytes = parseInt(
        fs.readFileSync(
          `/sys/class/net/${interfaceName}/statistics/rx_bytes`,
          "utf8"
        )
      );
      const txBytes = parseInt(
        fs.readFileSync(
          `/sys/class/net/${interfaceName}/statistics/tx_bytes`,
          "utf8"
        )
      );
      const mtu = parseInt(
        fs.readFileSync(`/sys/class/net/${interfaceName}/mtu`, "utf8")
      );
      return { rxBytes, txBytes, mtu };
    }
  } catch (error: any) {
    console.error("Failed to get interface traffic:", error);
  }
  return { rxBytes: 0, txBytes: 0, mtu: 0 };
}

async function runSpeedtest(serverId?: number): Promise<SpeedtestResult> {
  try {
    if (!fs.existsSync(SPEEDTEST_PATH)) {
      await downloadCli();
    }

    const serverArg = serverId ? ` -s ${serverId}` : "";
    const command = `"${SPEEDTEST_PATH}" --accept-license --accept-gdpr -f json${serverArg}`;

    const { stdout, stderr } = await execAsync(command, { 
      timeout: 120000 // 120秒超时
    });

    if (stderr) {
      console.log("Speedtest stderr:", stderr);
      if (stderr.includes("NoServersException")) {
        throw new Error("指定的服务器不可用，请尝试其他服务器或使用自动选择");
      }
      if (stderr.includes("Timeout occurred")) {
        throw new Error("网络连接超时，请检查网络状况或稍后重试");
      }
      if (stderr.includes("Cannot read from socket")) {
        throw new Error("网络连接中断，可能是网络不稳定或防火墙阻止");
      }
    }

    return JSON.parse(stdout);
  } catch (error: any) {
    console.error("Speedtest failed:", error);
    
    // 处理超时错误
    if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      throw new Error("测试超时，可能网络较慢或服务器繁忙，建议：\n1. 检查网络连接\n2. 尝试其他测试服务器\n3. 稍后重试");
    }
    
    // 处理命令执行错误
    if (error.code === 'ENOENT') {
      throw new Error("speedtest 程序未找到，请使用 'speedtest update' 重新下载");
    }
    
    // 处理JSON解析错误
    if (error instanceof SyntaxError) {
      throw new Error("测试结果格式错误，可能服务器返回了异常数据");
    }
    
    throw error;
  }
}

async function getAllServers(): Promise<ServerInfo[]> {
  try {
    if (!fs.existsSync(SPEEDTEST_PATH)) {
      await downloadCli();
    }

    const command = `"${SPEEDTEST_PATH}" -f json -L`;
    const { stdout } = await execAsync(command, { timeout: 30000 });
    const result = JSON.parse(stdout);

    return result.servers || [];
  } catch (error: any) {
    console.error("Failed to get servers:", error);
    return [];
  }
}

/**
 * 轻量级服务器ping测试
 */
async function quickPingTest(serverId: number): Promise<{ available: boolean; ping?: number; error?: string }> {
  try {
    if (!fs.existsSync(SPEEDTEST_PATH)) {
      await downloadCli();
    }

    // 只进行ping测试，不执行完整的速度测试
    const command = `"${SPEEDTEST_PATH}" --accept-license --accept-gdpr -f json -s ${serverId} --progress=no --selection-details`;
    const { stdout, stderr } = await execAsync(command, { 
      timeout: 8000 // 8秒超时，只需要ping测试
    });

    if (stderr) {
      if (stderr.includes("NoServersException") || stderr.includes("Server not found")) {
        return { available: false, error: "服务器不存在" };
      }
      if (stderr.includes("Timeout") || stderr.includes("timeout")) {
        return { available: false, error: "连接超时" };
      }
      if (stderr.includes("Cannot read from socket")) {
        return { available: false, error: "网络连接失败" };
      }
    }

    // 如果能获取到输出，说明服务器基本可用
    if (stdout && stdout.trim()) {
      try {
        const result = JSON.parse(stdout);
        if (result.ping && result.ping.latency) {
          return { available: true, ping: result.ping.latency };
        }
        if (result.server && result.server.id === serverId) {
          return { available: true };
        }
      } catch (parseError) {
        // JSON解析失败，但有输出说明服务器响应了
        return { available: true };
      }
    }
    
    return { available: true };
  } catch (error: any) {
    console.error(`Server ${serverId} ping test failed:`, error);
    
    if (error.code === 'ETIMEDOUT') {
      return { available: false, error: "连接超时" };
    }
    if (error.message?.includes('NoServersException')) {
      return { available: false, error: "服务器不可用" };
    }
    
    return { available: false, error: error.message || "未知错误" };
  }
}

/**
 * 简化的服务器可用性检测 - 基于服务器列表验证
 */
async function testServerAvailability(serverId: number): Promise<{ available: boolean; ping?: number; error?: string }> {
  try {
    // 首先检查服务器是否在可用列表中
    const allServers = await getAllServers();
    const serverExists = allServers.find(s => s.id === serverId);
    
    if (!serverExists) {
      return { available: false, error: "服务器不在可用列表中" };
    }

    // 进行轻量级ping测试
    return await quickPingTest(serverId);
  } catch (error: any) {
    console.error(`Server ${serverId} availability test failed:`, error);
    return { available: false, error: error.message || "测试失败" };
  }
}

/**
 * 快速ping测试多个服务器
 */
async function quickPingServers(servers: ServerInfo[], maxServers: number = 5): Promise<ServerInfo[]> {
  const testPromises = servers.slice(0, maxServers).map(async (server) => {
    try {
      const result = await testServerAvailability(server.id);
      return {
        ...server,
        available: result.available,
        ping: result.ping,
        error: result.error
      } as ServerInfo;
    } catch (error) {
      return {
        ...server,
        available: false,
        error: 'Test failed'
      } as ServerInfo;
    }
  });

  try {
    const results = await Promise.all(testPromises);
    return results
      .filter(server => server.available === true)
      .sort((a, b) => (a.ping || 999) - (b.ping || 999));
  } catch (error) {
    console.error('Quick ping test failed:', error);
    return [];
  }
}

/**
 * 智能选择最佳可用服务器 - 简化版本
 */
async function selectBestServer(): Promise<number | null> {
  try {
    const allServers = await getAllServers();
    if (allServers.length === 0) {
      return null;
    }

    // 直接返回第一个服务器，因为服务器列表通常按距离排序
    // 这避免了复杂的ping测试，提高成功率
    return allServers[0].id;
  } catch (error) {
    console.error('Failed to select best server:', error);
    return null;
  }
}

/**
 * 备用：选择多个候选服务器进行测试
 */
async function selectBestServerWithFallback(): Promise<number | null> {
  try {
    const allServers = await getAllServers();
    if (allServers.length === 0) {
      return null;
    }

    // 尝试前3个服务器，通常按距离排序，成功率更高
    for (let i = 0; i < Math.min(3, allServers.length); i++) {
      const serverId = allServers[i].id;
      try {
        // 简单验证：检查服务器是否在列表中即认为可用
        return serverId;
      } catch (error) {
        console.log(`Server ${serverId} test failed, trying next...`);
        continue;
      }
    }

    // 如果前3个都有问题，返回第一个作为fallback
    return allServers[0].id;
  } catch (error) {
    console.error('Failed to select best server with fallback:', error);
    return null;
  }
}

async function checkNetworkConnectivity(): Promise<{connected: boolean; message: string}> {
  try {
    // 测试基本网络连接
    await axios.get('https://www.speedtest.net', { timeout: 10000 });
    return { connected: true, message: "网络连接正常" };
  } catch (error: any) {
    if (error.code === 'ENOTFOUND') {
      return { connected: false, message: "DNS解析失败，请检查DNS设置" };
    } else if (error.code === 'ECONNREFUSED') {
      return { connected: false, message: "连接被拒绝，可能存在防火墙阻止" };
    } else if (error.code === 'ETIMEDOUT') {
      return { connected: false, message: "连接超时，网络可能较慢或不稳定" };
    } else {
      return { connected: false, message: `网络连接异常: ${error.message}` };
    }
  }
}

async function saveSpeedtestImage(url: string): Promise<string | null> {
  try {
    const imageUrl = url + ".png";
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const imagePath = path.join(TEMP_DIR, "speedtest.png");
    const filledImagePath = path.join(TEMP_DIR, "speedtest_filled.png");
    fs.writeFileSync(imagePath, response.data);

    const bgColor = "#212338";
    const borderPx = 14;
    try {
      await fillRoundedCorners(imagePath, filledImagePath, bgColor, borderPx);
      return filledImagePath;
    } catch (err) {
      console.error("Failed to fill rounded corners:", err);
    }

    return imagePath;
  } catch (error: any) {
    console.error("Failed to save speedtest image:", error);
    return null;
  }
}

async function convertImageToStickerWebp(
  srcPath: string
): Promise<string | null> {
  try {
    if (!fs.existsSync(srcPath)) return null;
    const stickerPath = path.join(
      TEMP_DIR,
      `speedtest_sticker_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}.webp`
    );

    // Resize to 512x512 and convert to webp for sticker
    await sharp(srcPath)
      .resize(512, 512, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality: 85, effort: 5 })
      .toFile(stickerPath);

    // Basic size check for Telegram sticker (~512KB)
    try {
      const { size } = fs.statSync(stickerPath);
      if (size > 512 * 1024) {
        // Try recompress at lower quality
        await sharp(srcPath)
          .resize(512, 512, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .webp({ quality: 65, effort: 6 })
          .toFile(stickerPath);
      }
    } catch {}

    return stickerPath;
  } catch (e) {
    console.error("Failed to convert image to sticker:", e);
    return null;
  }
}

const speedtest = async (msg: Api.Message) => {
  const args = msg.message.slice(1).split(" ").slice(1);
  const command = args[0] || "";

  try {
    if (command === "list") {
      await msg.edit({ text: "🔍 正在获取服务器列表...", parseMode: "html" });

      const servers = await getAllServers();
      if (servers.length === 0) {
        await msg.edit({
          text: "❌ <b>错误</b>\n\n无可用服务器",
          parseMode: "html",
        });
        return;
      }

      const serverList = servers
        .slice(0, 20)
        .map(
          (server) =>
            `<code>${server.id}</code> - <code>${htmlEscape(
              server.name
            )}</code> - <code>${htmlEscape(server.location)}</code>`
        )
        .join("\n");

      await msg.edit({
        text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n${serverList}`,
        parseMode: "html",
      });
    } else if (command === "set") {
      const serverId = parseInt(args[1]);
      if (!serverId || isNaN(serverId)) {
        await msg.edit({
          text: "❌ <b>参数错误</b>\n\n请指定有效的服务器ID\n例: <code>s set 12345</code>",
          parseMode: "html",
        });
        return;
      }

      saveDefaultServer(serverId);
      await msg.edit({
        text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n<code>默认服务器已设置为 ${serverId}</code>`,
        parseMode: "html",
      });
    } else if (command === "clear") {
      removeDefaultServer();
      await msg.edit({
        text: "<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n<code>默认服务器已清除</code>",
        parseMode: "html",
      });
    } else if (command === "config") {
      const defaultServer = getDefaultServer() || "Auto";
      const typePref = getPreferredType() || "默认(photo→sticker→file→txt)";
      await msg.edit({
        text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n<code>默认服务器: ${defaultServer}</code>\n<code>优先类型: ${typePref}</code>\n<code>Speedtest® CLI: ${SPEEDTEST_VERSION}</code>`,
        parseMode: "html",
      });
    } else if (command === "type") {
      const t = (args[1] || "").toLowerCase();
      const valid: MessageType[] = ["photo", "sticker", "file", "txt"];
      if (!valid.includes(t as MessageType)) {
        await msg.edit({
          text: `❌ <b>参数错误</b>\n\n<code>${commandName} type photo/sticker/file/txt</code> - 设置优先使用的消息类型`,
          parseMode: "html",
        });
        return;
      }
      savePreferredType(t as MessageType);
      const order = getMessageOrder();
      await msg.edit({
        text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n<code>优先类型已设置为: ${t}</code>\n<code>当前顺序: ${order.join(
          " → "
        )}</code>`,
        parseMode: "html",
      });
    } else if (command === "check") {
      await msg.edit({
        text: "🔍 正在检查网络连接...",
        parseMode: "html",
      });

      try {
        const networkStatus = await checkNetworkConnectivity();
        const statusIcon = networkStatus.connected ? "✅" : "❌";
        
        await msg.edit({
          text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n${statusIcon} <b>网络状态:</b> <code>${networkStatus.message}</code>\n\n<b>建议:</b>\n• 如果连接异常，请检查网络设置\n• 尝试更换网络环境或DNS服务器\n• 确认防火墙允许网络测试`,
          parseMode: "html",
        });
      } catch (error) {
        await msg.edit({
          text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n❌ <code>网络检查失败: ${htmlEscape(String(error))}</code>`,
          parseMode: "html",
        });
      }
    } else if (command === "test") {
      const serverId = parseInt(args[1]);
      if (!serverId || isNaN(serverId)) {
        await msg.edit({
          text: "❌ <b>参数错误</b>\n\n请指定有效的服务器ID\n例: <code>speedtest test 12345</code>",
          parseMode: "html",
        });
        return;
      }

      await msg.edit({
        text: `🔍 正在测试服务器 ${serverId} 的可用性...`,
        parseMode: "html",
      });

      try {
        const result = await testServerAvailability(serverId);
        const statusIcon = result.available ? "✅" : "❌";
        const statusText = result.available ? "可用" : "不可用";
        const pingText = result.ping ? ` (延迟: ${result.ping}ms)` : "";
        const errorText = result.error ? `\n<b>错误:</b> <code>${result.error}</code>` : "";

        await msg.edit({
          text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n${statusIcon} <b>服务器 ${serverId}:</b> <code>${statusText}</code>${pingText}${errorText}`,
          parseMode: "html",
        });
      } catch (error) {
        await msg.edit({
          text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n❌ <code>测试失败: ${htmlEscape(String(error))}</code>`,
          parseMode: "html",
        });
      }
    } else if (command === "best") {
      await msg.edit({
        text: "🎯 正在查找推荐服务器...",
        parseMode: "html",
      });

      try {
        const servers = await getAllServers();
        if (servers.length > 0) {
          // 推荐前3个服务器（通常按距离排序）
          const topServers = servers.slice(0, 3);
          const serverList = topServers
            .map((server, index) => 
              `${index + 1}. <code>${server.id}</code> - <code>${htmlEscape(server.name)}</code> - <code>${htmlEscape(server.location)}</code>`
            )
            .join('\n');
          
          await msg.edit({
            text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n🎯 <b>推荐服务器 (按距离排序):</b>\n\n${serverList}\n\n💡 使用 <code>${commandName} set [ID]</code> 设为默认服务器\n💡 使用 <code>${commandName} [ID]</code> 直接测试`,
            parseMode: "html",
          });
        } else {
          await msg.edit({
            text: "<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n❌ <code>无法获取服务器列表</code>\n\n💡 <b>建议:</b>\n• 检查网络连接\n• 稍后重试",
            parseMode: "html",
          });
        }
      } catch (error) {
        await msg.edit({
          text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n❌ <code>获取服务器列表失败: ${htmlEscape(String(error))}</code>`,
          parseMode: "html",
        });
      }
    } else if (command === "update") {
      await msg.edit({
        text: "🔄 正在更新 Speedtest CLI...",
        parseMode: "html",
      });

      try {
        // 删除现有文件强制重新下载
        if (fs.existsSync(SPEEDTEST_PATH)) {
          fs.unlinkSync(SPEEDTEST_PATH);
        }

        await downloadCli();
        await msg.edit({
          text: "<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n<code>Speedtest® CLI 已更新到最新版本</code>",
          parseMode: "html",
        });
      } catch (error) {
        await msg.edit({
          text: `<blockquote><b>⚡️SPEEDTEST by OOKLA</b></blockquote>\n<code>更新失败: ${htmlEscape(
            String(error)
          )}</code>`,
          parseMode: "html",
        });
      }
    } else if (command === "" || !isNaN(parseInt(command))) {
      await msg.edit({ text: "🔍 正在检查网络连接...", parseMode: "html" });

      // 先进行网络诊断
      const networkStatus = await checkNetworkConnectivity();
      if (!networkStatus.connected) {
        await msg.edit({
          text: `❌ <b>网络连接异常，无法进行速度测试</b>\n\n<b>检测结果:</b> <code>${networkStatus.message}</code>\n\n💡 <b>建议:</b>\n• 检查网络连接是否正常\n• 尝试更换网络环境或DNS服务器\n• 确认防火墙允许网络测试\n• 使用 <code>${commandName} check</code> 重新检查连接`,
          parseMode: "html",
        });
        return;
      }

      await msg.edit({ text: "⚡️ 网络连接正常，正在准备速度测试...", parseMode: "html" });

      let serverId: number | undefined;
      
      if (command && !isNaN(parseInt(command))) {
        // 用户指定服务器ID，直接使用
        serverId = parseInt(command);
        await msg.edit({ 
          text: `🎯 使用指定服务器 ${serverId}，开始测试...`, 
          parseMode: "html" 
        });
      } else {
        // 尝试使用默认服务器
        const defaultServerId = getDefaultServer();
        if (defaultServerId) {
          serverId = defaultServerId;
          await msg.edit({ 
            text: `🎯 使用默认服务器 ${serverId}，开始测试...`, 
            parseMode: "html" 
          });
        } else {
          // 智能选择最佳服务器
          await msg.edit({ text: "🎯 正在选择最佳测试服务器...", parseMode: "html" });
          const bestServerId = await selectBestServer();
          serverId = bestServerId || undefined;
          
          if (!serverId) {
            await msg.edit({
              text: "❌ <b>无法获取服务器列表</b>\n\n💡 <b>建议:</b>\n• 检查网络连接\n• 稍后重试\n• 使用 <code>speedtest list</code> 查看服务器列表\n• 手动指定服务器ID",
              parseMode: "html",
            });
            return;
          }
          
          await msg.edit({ 
            text: `🎯 已选择服务器 ${serverId}，开始测试...`, 
            parseMode: "html" 
          });
        }
      }

      try {
        const result = await runSpeedtest(serverId);
        const { asInfo, ccName, ccCode, ccFlag, ccLink } = await getIpApi(
          result.interface.externalIp
        );
        const { rxBytes, txBytes, mtu } = await getInterfaceTraffic(
          result.interface.name
        );

        const description = [
          `<blockquote><b>⚡️SPEEDTEST by OOKLA @${ccCode}${ccFlag}</b></blockquote>`,
          `<code>Name</code>  <code>${htmlEscape(result.isp)}</code> ${asInfo}`,
          `<code>Node</code>  <code>${
            result.server.id
          }</code> - <code>${htmlEscape(
            result.server.name
          )}</code> - <code>${htmlEscape(result.server.location)}</code>`,
          `<code>Conn</code>  <code>${
            result.interface.externalIp.includes(":") ? "IPv6" : "IPv4"
          }</code> - <code>${htmlEscape(
            result.interface.name
          )}</code> - <code>MTU</code> <code>${mtu}</code>`,
          `<code>Ping</code>  <code>⇔${result.ping.latency}ms</code> <code>±${result.ping.jitter}ms</code>`,
          `<code>Rate</code>  <code>↓${await unitConvert(
            result.download.bandwidth
          )}</code> <code>↑${await unitConvert(
            result.upload.bandwidth
          )}</code>`,
          `<code>Data</code>  <code>↓${await unitConvert(
            result.download.bytes,
            true
          )}</code> <code>↑${await unitConvert(
            result.upload.bytes,
            true
          )}</code>`,
          `<code>Stat</code>  <code>RX ${await unitConvert(
            rxBytes,
            true
          )}</code> <code>TX ${await unitConvert(txBytes, true)}</code>`,
          `<code>Time</code>  <code>${result.timestamp
            .replace("T", " ")
            .split(".")[0]
            .replace("Z", "")}</code>`,
        ].join("\n");

        // 根据优先顺序发送
        const order = getMessageOrder();
        const trySend = async (type: MessageType): Promise<boolean> => {
          try {
            if (type === "txt") {
              await msg.edit({ text: description, parseMode: "html" });
              return true;
            }

            // 需要图片的类型先确保图片存在
            if (!result.result?.url) return false;
            const imagePath = await saveSpeedtestImage(result.result.url);
            if (!imagePath || !fs.existsSync(imagePath)) return false;

            if (type === "photo") {
              await msg.client?.sendFile(msg.peerId, {
                file: imagePath,
                caption: description,
                parseMode: "html",
              });
              try {
                await msg.delete();
              } catch {}
              try {
                fs.unlinkSync(imagePath);
              } catch {}
              return true;
            } else if (type === "file") {
              await msg.client?.sendFile(msg.peerId, {
                file: imagePath,
                caption: description,
                parseMode: "html",
                forceDocument: true,
              });
              try {
                await msg.delete();
              } catch {}
              try {
                fs.unlinkSync(imagePath);
              } catch {}
              return true;
            } else if (type === "sticker") {
              // 转为贴纸发送
              const stickerPath = await convertImageToStickerWebp(imagePath);
              if (stickerPath && fs.existsSync(stickerPath)) {
                const client = await getGlobalClient();
                await client.sendFile(msg.peerId!, {
                  file: stickerPath,
                  forceDocument: false,
                  attributes: [
                    new Api.DocumentAttributeSticker({
                      alt: "speedtest",
                      stickerset: new Api.InputStickerSetEmpty(),
                    }),
                  ],
                });
                // 清理临时文件
                try {
                  fs.unlinkSync(imagePath);
                } catch {}
                try {
                  fs.unlinkSync(stickerPath);
                } catch {}
                // 同时展示文字说明
                await msg.edit({ text: description, parseMode: "html" });
                return true;
              }
            }
          } catch (e) {
            console.error(`Send as ${type} failed:`, e);
          }
          return false;
        };

        for (const t of order) {
          const ok = await trySend(t);
          if (ok) return;
        }

        // 兜底为文本
        await msg.edit({ text: description, parseMode: "html" });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const isKnownNetworkError = errorMsg.includes('超时') || 
                                   errorMsg.includes('连接') || 
                                   errorMsg.includes('socket') ||
                                   errorMsg.includes('Timeout') ||
                                   errorMsg.includes('Cannot read');
        
        let helpText = "";
        if (isKnownNetworkError) {
          helpText = `\n\n💡 <b>解决建议:</b>\n• 检查网络连接是否正常\n• 尝试使用 <code>${commandName} list</code> 查看可用服务器\n• 使用 <code>${commandName} set [ID]</code> 选择其他服务器\n• 如问题持续，请联系网络管理员`;
        }
        
        await msg.edit({
          text: `❌ <b>速度测试失败</b>\n\n<code>${htmlEscape(errorMsg)}</code>${helpText}`,
          parseMode: "html",
        });
      }
    } else {
      await msg.edit({
        text: `❌ <b>参数错误</b>\n\n${help_txt}`,
        parseMode: "html",
      });
    }
  } catch (error: any) {
    console.error("SpeedNext plugin error:", error);
    const errorMessage = error.message || String(error);
    const displayError =
      errorMessage.length > 100
        ? errorMessage.substring(0, 100) + "..."
        : errorMessage;
    await msg.edit({
      text: `❌ <b>插件错误</b>\n\n<b>错误信息:</b> <code>${htmlEscape(
        displayError
      )}</code>\n\n💡 <b>建议:</b> 请检查网络连接或联系管理员`,
      parseMode: "html",
    });
  }
};

class SpeednextPlugin extends Plugin {
  description: string = `⚡️ 网络速度测试工具 | SpeedTest by Ookla\n${help_txt}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    speedtest,
    st: speedtest,
  };
}

export default new SpeednextPlugin();

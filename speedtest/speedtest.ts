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
<code>${commandName} set [ID]</code> - 设置默认服务器
<code>${commandName} type photo/sticker/file/txt</code> - 设置优先使用的消息类型
<code>${commandName} clear</code> - 清除默认服务器
<code>${commandName} config</code> - 显示配置信息
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

    const { stdout, stderr } = await execAsync(command);

    if (stderr && stderr.includes("NoServersException")) {
      throw new Error("Unable to connect to the specified server");
    }

    return JSON.parse(stdout);
  } catch (error: any) {
    console.error("Speedtest failed:", error);
    throw error;
  }
}

async function getAllServers(): Promise<ServerInfo[]> {
  try {
    if (!fs.existsSync(SPEEDTEST_PATH)) {
      await downloadCli();
    }

    const command = `"${SPEEDTEST_PATH}" -f json -L`;
    const { stdout } = await execAsync(command);
    const result = JSON.parse(stdout);

    return result.servers || [];
  } catch (error: any) {
    console.error("Failed to get servers:", error);
    return [];
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
      await msg.edit({ text: "⚡️ 正在进行速度测试...", parseMode: "html" });

      const serverId =
        command && !isNaN(parseInt(command))
          ? parseInt(command)
          : getDefaultServer();

      try {
        const result = await runSpeedtest(serverId || undefined);
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
        await msg.edit({
          text: `❌ <b>速度测试失败</b>\n\n<code>${htmlEscape(
            String(error)
          )}</code>`,
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

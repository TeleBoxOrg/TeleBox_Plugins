import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import axios from "axios";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { createDirectoryInAssets } from "@utils/pathHelpers";

interface NeZhaConfig {
  url: string;
  secret: string;
  configPath?: string;
  serviceMonitor?: boolean;
}

interface ServerHost {
  platform?: string;
  cpu?: string[];
  mem_total?: number;
  disk_total?: number;
  version?: string;
}

interface ServerState {
  cpu?: number;
  mem_used?: number;
  swap_used?: number;
  disk_used?: number;
  net_in_speed?: number;
  net_out_speed?: number;
  net_in_transfer?: number;
  net_out_transfer?: number;
  load_1?: number;
  load_5?: number;
  load_15?: number;
  uptime?: number;
  tcp_conn_count?: number;
  udp_conn_count?: number;
  process_count?: number;
}

interface ServerGeoIP {
  ip?: {
    ipv4_addr?: string;
    ipv6_addr?: string;
  };
  country_code?: string;
}

interface Server {
  id: number;
  name: string;
  display_index?: number;
  host?: ServerHost;
  state?: ServerState;
  geoip?: ServerGeoIP;
  last_active?: string;
}

interface ApiResponse {
  success: boolean;
  data?: Server[];
  error?: string;
}

interface ServiceMonitorItem {
  monitor_id: number;
  server_id: number;
  monitor_name: string;
  server_name: string;
  created_at: number[];
  avg_delay: number[];
}

interface ServiceMonitorData {
  success: boolean;
  data?: ServiceMonitorItem[];
}

let configCache: NeZhaConfig | null = null;
let configDir: string = "";
let configFile: string = "";

function getConfigPath(): string {
  if (!configDir) {
    configDir = createDirectoryInAssets("nezha");
    configFile = path.join(configDir, "config.json");
  }
  return configFile;
}

function loadConfig(): NeZhaConfig | null {
  if (configCache) return configCache;
  try {
    const file = getConfigPath();
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf-8");
      configCache = JSON.parse(content);
      return configCache;
    }
  } catch {}
  return null;
}

function saveConfig(config: NeZhaConfig): void {
  try {
    const file = getConfigPath();
    fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf-8");
    configCache = config;
  } catch (e) {
    console.error("Failed to save nezha config:", e);
  }
}

function htmlEscape(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}

function formatSpeed(bytes: number): string {
  return formatBytes(bytes) + "/s";
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}时`);
  if (minutes > 0) parts.push(`${minutes}分`);
  return parts.join("") || "0分";
}

function getStatusEmoji(isOnline: boolean): string {
  return isOnline ? "🟢" : "🔴";
}

function getUsageBar(percent: number): string {
  const filled = Math.round(percent / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function generateJWT(secret: string, userId: string = "1"): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    user_id: userId,
    orig_iat: now,
    exp: now + 3600,
    ip: "",
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${headerB64}.${payloadB64}.${signature}`;
}

function readSecretFromConfig(configPath: string): string | null {
  try {
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const content = fs.readFileSync(configPath, "utf-8");
    const config = yaml.load(content) as any;
    return config?.jwt_secret_key || config?.jwtSecretKey || null;
  } catch {
    return null;
  }
}

async function fetchServers(config: NeZhaConfig): Promise<Server[]> {
  let secret = config.secret;

  if (config.configPath) {
    const fileSecret = readSecretFromConfig(config.configPath);
    if (fileSecret) {
      secret = fileSecret;
    }
  }

  const token = generateJWT(secret);
  const apiUrl = config.url.replace(/\/$/, "") + "/api/v1/server";
  const response = await axios.get<ApiResponse>(apiUrl, {
    timeout: 15000,
    headers: {
      Cookie: `nz-jwt=${token}`,
      "User-Agent": "TeleBox-NeZha-Plugin/1.0",
    },
  });

  if (response.data.success && response.data.data) {
    return response.data.data;
  }
  if (Array.isArray(response.data)) {
    return response.data;
  }
  throw new Error((response.data as any).error || "获取服务器列表失败");
}

function isServerOnline(server: Server): boolean {
  if (!server.last_active) return false;
  const lastActive = new Date(server.last_active).getTime();
  const now = Date.now();
  return now - lastActive < 60000;
}

async function fetchServiceMonitor(
  config: NeZhaConfig,
  serverId: number
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  try {
    let secret = config.secret;
    if (config.configPath) {
      const fileSecret = readSecretFromConfig(config.configPath);
      if (fileSecret) secret = fileSecret;
    }
    const token = generateJWT(secret);
    const apiUrl = config.url.replace(/\/$/, "") + `/api/v1/service/${serverId}`;
    const response = await axios.get<ServiceMonitorData>(apiUrl, {
      timeout: 10000,
      headers: {
        Cookie: `nz-jwt=${token}`,
        "User-Agent": "TeleBox-NeZha-Plugin/1.0",
      },
    });
    if (response.data.success && response.data.data) {
      for (const item of response.data.data) {
        if (item.monitor_name && item.avg_delay && item.avg_delay.length > 0) {
          const latestDelay = item.avg_delay[item.avg_delay.length - 1];
          result.set(item.monitor_name, latestDelay);
        }
      }
    }
  } catch (error: any) {
    console.error(`[NeZha Debug] Service monitor API error for server ${serverId}:`, error.message || error);
  }
  return result;
}

function getCountryFlag(code?: string): string {
  if (!code) return "";
  const flags: Record<string, string> = {
    us: "🇺🇸", jp: "🇯🇵", hk: "🇭🇰", sg: "🇸🇬", kr: "🇰🇷", tw: "🇹🇼",
    de: "🇩🇪", gb: "🇬🇧", fr: "🇫🇷", nl: "🇳🇱", au: "🇦🇺", ca: "🇨🇦",
    cn: "🇨🇳", ru: "🇷🇺", in: "🇮🇳", br: "🇧🇷",
  };
  return flags[code.toLowerCase()] || "";
}

function formatServerInfo(
  server: Server,
  serviceData?: Map<string, number>
): string {
  const online = isServerOnline(server);
  const state = server.state;
  const host = server.host;
  const flag = getCountryFlag(server.geoip?.country_code);

  let title = `${getStatusEmoji(online)} ${flag} <b>${htmlEscape(server.name)}</b>`;

  if (serviceData && serviceData.size > 0) {
    const monitors: string[] = [];
    serviceData.forEach((delay, name) => {
      const delayMs = delay.toFixed(1);
      monitors.push(`${name}:${delayMs}ms`);
    });
    title += `\n📶 ${monitors.join(" | ")}`;
  }

  if (!online) {
    title += ` (离线)`;
    return title;
  }

  if (state) {
    const cpuPercent = state.cpu?.toFixed(1) || "0";
    const memPercent =
      host?.mem_total && state.mem_used
        ? ((state.mem_used / host.mem_total) * 100).toFixed(1)
        : "0";
    const diskPercent =
      host?.disk_total && state.disk_used
        ? ((state.disk_used / host.disk_total) * 100).toFixed(1)
        : "0";

    let details = `├ CPU: ${getUsageBar(parseFloat(cpuPercent))} ${cpuPercent}%\n`;
    details += `├ 内存: ${getUsageBar(parseFloat(memPercent))} ${memPercent}%`;
    if (state.mem_used && host?.mem_total) {
      details += ` (${formatBytes(state.mem_used)}/${formatBytes(host.mem_total)})`;
    }
    details += `\n`;
    details += `├ 硬盘: ${getUsageBar(parseFloat(diskPercent))} ${diskPercent}%`;
    if (state.disk_used && host?.disk_total) {
      details += ` (${formatBytes(state.disk_used)}/${formatBytes(host.disk_total)})`;
    }
    details += `\n`;
    details += `├ 网络: ↑${formatSpeed(state.net_out_speed || 0)} ↓${formatSpeed(state.net_in_speed || 0)}\n`;
    details += `├ 流量: ↑${formatBytes(state.net_out_transfer || 0)} ↓${formatBytes(state.net_in_transfer || 0)}\n`;
    details += `└ 运行: ${formatUptime(state.uptime || 0)}`;

    return `${title}\n<blockquote expandable>${details}</blockquote>`;
  }

  return title;
}

const nezha = async (msg: Api.Message) => {
  try {
    const args = msg.message.slice(1).split(" ").slice(1);
    const subCmd = args[0]?.toLowerCase();

    if (subCmd === "service") {
      const toggle = args[1]?.toLowerCase();
      const config = loadConfig();
      if (!config) {
        await msg.edit({
          text: "❌ 请先配置哪吒监控",
          parseMode: "html",
        });
        return;
      }
      if (toggle === "on") {
        config.serviceMonitor = true;
        saveConfig(config);
        await msg.edit({
          text: "✅ 服务监控已开启",
          parseMode: "html",
        });
      } else if (toggle === "off") {
        config.serviceMonitor = false;
        saveConfig(config);
        await msg.edit({
          text: "✅ 服务监控已关闭",
          parseMode: "html",
        });
      } else {
        const status = config.serviceMonitor !== false ? "开启" : "关闭";
        await msg.edit({
          text: `📶 服务监控当前状态: <b>${status}</b>\n\n用法: <code>nezha service on/off</code>`,
          parseMode: "html",
        });
      }
      return;
    }

    if (subCmd === "set") {
      const url = args[1];
      const secretOrPath = args[2];

      if (!url || !secretOrPath) {
        await msg.edit({
          text: `❌ <b>设置哪吒监控</b>

<b>用法:</b>
<code>nezha set [面板地址] [JWT Secret]</code>
<code>nezha set [面板地址] [config.yaml路径]</code>

<b>示例:</b>
<code>nezha set https://nezha.example.com your_jwt_secret</code>
<code>nezha set https://nezha.example.com /opt/nezha/data/config.yaml</code>

<b>说明:</b>
• 可直接填写 jwt_secret_key
• 或填写 config.yaml 路径，自动读取 secret`,
          parseMode: "html",
        });
        return;
      }

      let config: NeZhaConfig;
      let secret: string;

      if (
        secretOrPath.endsWith(".yaml") ||
        secretOrPath.endsWith(".yml") ||
        secretOrPath.startsWith("/")
      ) {
        const fileSecret = readSecretFromConfig(secretOrPath);
        if (!fileSecret) {
          await msg.edit({
            text: `❌ <b>配置文件读取失败</b>

无法从 <code>${htmlEscape(secretOrPath)}</code> 读取 jwt_secret_key

请检查文件路径是否正确`,
            parseMode: "html",
          });
          return;
        }
        secret = fileSecret;
        config = { url, secret, configPath: secretOrPath };
      } else {
        secret = secretOrPath;
        config = { url, secret };
      }

      await msg.edit({ text: "🔍 正在验证配置..." });

      try {
        await fetchServers(config);
        saveConfig(config);
        await msg.edit({
          text: `✅ <b>哪吒监控配置成功</b>

<b>面板地址:</b> <code>${htmlEscape(url)}</code>
<b>认证方式:</b> ${config.configPath ? "配置文件自动读取" : "JWT Secret"}

使用 <code>nezha</code> 查看服务器状态`,
          parseMode: "html",
        });
      } catch (error: any) {
        await msg.edit({
          text: `❌ <b>配置验证失败</b>

<b>错误:</b> ${htmlEscape(error.message)}

请检查面板地址和 Secret 是否正确`,
          parseMode: "html",
        });
      }
      return;
    }

    const config = loadConfig();

    if (!config) {
      await msg.edit({
        text: `📊 <b>哪吒监控插件</b>

<b>首次使用请先配置:</b>
<code>nezha set [面板地址] [JWT Secret]</code>
<code>nezha set [面板地址] [config.yaml路径]</code>

<b>示例:</b>
<code>nezha set https://nezha.example.com your_secret</code>
<code>nezha set https://nezha.example.com /opt/nezha/data/config.yaml</code>`,
        parseMode: "html",
      });
      return;
    }

    await msg.edit({ text: "🔍 正在获取服务器状态..." });

    const servers = await fetchServers(config);

    const serviceDataMap = new Map<number, Map<string, number>>();
    if (config.serviceMonitor !== false) {
      const onlineServers = servers.filter(isServerOnline);
      await Promise.all(
        onlineServers.map(async (server) => {
          const data = await fetchServiceMonitor(config, server.id);
          if (data.size > 0) {
            serviceDataMap.set(server.id, data);
          }
        })
      );
    }

    if (!servers.length) {
      await msg.edit({
        text: "📊 <b>哪吒监控</b>\n\n暂无服务器数据",
        parseMode: "html",
      });
      return;
    }

    servers.sort((a, b) => {
      const aOnline = isServerOnline(a);
      const bOnline = isServerOnline(b);
      if (aOnline !== bOnline) return bOnline ? 1 : -1;
      return (a.display_index || 0) - (b.display_index || 0);
    });

    const onlineCount = servers.filter(isServerOnline).length;
    const totalCount = servers.length;

    let resultText = `📊 <b>哪吒监控</b> (${onlineCount}/${totalCount} 在线)\n\n`;
    resultText += servers
      .map((s) => formatServerInfo(s, serviceDataMap.get(s.id)))
      .join("\n\n");

    if (resultText.length > 4000) {
      const onlineOnly = servers.filter(isServerOnline);
      resultText = `📊 <b>哪吒监控</b> (${onlineCount}/${totalCount} 在线)\n\n`;
      resultText += onlineOnly
        .map((s) => formatServerInfo(s, serviceDataMap.get(s.id)))
        .join("\n\n");

      if (totalCount - onlineCount > 0) {
        resultText += `\n\n🔴 还有 ${totalCount - onlineCount} 台服务器离线`;
      }
    }

    await msg.edit({
      text: resultText,
      parseMode: "html",
    });
  } catch (error: any) {
    console.error("NeZha plugin error:", error);
    await msg.edit({
      text: `❌ <b>获取失败</b>

<b>错误:</b> ${htmlEscape(error.message || "未知错误")}

请检查网络连接或重新配置`,
      parseMode: "html",
    });
  }
};

class NeZhaPlugin extends Plugin {
  description: string = `
哪吒监控插件：
- nezha - 查看所有服务器状态
- nezha set [地址] [Secret/配置文件路径] - 配置哪吒面板
- nezha service on/off - 开启/关闭服务监控显示

支持直接填写 jwt_secret_key 或 config.yaml 路径自动读取
  `;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    nezha,
  };
}

export default new NeZhaPlugin();

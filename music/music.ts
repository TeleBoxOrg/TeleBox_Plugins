/**
 * Music Plugin for TeleBox
 * Professional YouTube audio downloader with AI-enhanced search
 * @version 3.0.0
 * @author TeleBox Team
 */

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import {
  createDirectoryInAssets,
  createDirectoryInTemp,
} from "@utils/pathHelpers";
import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as https from "https";
import * as http from "http";
import { JSONFilePreset } from "lowdb/node";

const execAsync = promisify(exec);

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      }[m] || m)
  );

// 消息长度限制
const MAX_MESSAGE_LENGTH = 4096;

// 获取命令前缀，参考 kitt.ts
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "music";
const commandName = `${mainPrefix}${pluginName}`;

// ==================== Configuration ====================
const CONFIG = {
  PATHS: {
    CONFIG: path.join(
      createDirectoryInAssets(`${pluginName}`),
      `${pluginName}_config.json`
    ),
    TEMP: createDirectoryInTemp("music"),
    // 移除缓存目录，禁用缓存功能
  },
  DEFAULTS: {
    API_URL: "https://generativelanguage.googleapis.com",
    MODEL: "gemini-2.0-flash",
    TIMEOUT: 30000,
  },
  KEYS: {
    API: "music_gemini_api_key",
    COOKIE: "music_ytdlp_cookie",
    PROXY: "music_ytdlp_proxy",
    BASE_URL: "music_gemini_base_url",
    MODEL: "music_gemini_model",
    AUDIO_QUALITY: "music_audio_quality",
    TEMPERATURE: "music_gemini_temperature",
    TOP_P: "music_gemini_top_p",
    TOP_K: "music_gemini_top_k",
  },
};

// 默认配置（包含所有配置键）
const DEFAULT_CONFIG: Record<string, string> = {
  [CONFIG.KEYS.BASE_URL]: "https://generativelanguage.googleapis.com",
  [CONFIG.KEYS.MODEL]: "gemini-2.0-flash",
  [CONFIG.KEYS.COOKIE]: "",
  [CONFIG.KEYS.API]: "",
  [CONFIG.KEYS.PROXY]: "",
  [CONFIG.KEYS.AUDIO_QUALITY]: "", // 空则不指定，保持最佳可用
  [CONFIG.KEYS.TEMPERATURE]: "0.1", // 低温度提高准确性
  [CONFIG.KEYS.TOP_P]: "0.8", // 适中的核采样
  [CONFIG.KEYS.TOP_K]: "10", // 限制候选词提高准确性
};

// ==================== Types ====================
// 历史版本存储为分组字段，这里保留兼容；新版本统一为顶级键存储
type LegacyConfigData = {
  apiKeys?: Record<string, string>;
  cookies?: Record<string, string>;
  settings?: Record<string, any>;
} & Record<string, any>;

interface SongInfo {
  title: string;
  artist: string;
  album?: string;
  thumbnail?: string;
  duration?: number; // 单位：秒
}

// ==================== Dependency Manager ====================
class DependencyManager {
  // 依赖通过项目 package.json 管理，避免运行时安装
  private static requiredPackages: string[] = [];

  static async checkAndInstallDependencies(): Promise<boolean> {
    for (const pkg of this.requiredPackages) {
      if (!this.isPackageInstalled(pkg)) {
        console.log(`[music] Installing ${pkg}...`);
        try {
          await execAsync(`npm install ${pkg}`);
          console.log(`[music] ${pkg} installed successfully`);
        } catch (error) {
          console.error(`[music] Failed to install ${pkg}:`, error);
          return false;
        }
      }
    }
    return true;
  }

  private static async isPackageInstalled(
    packageName: string
  ): Promise<boolean> {
    try {
      const packagePath = path.join(process.cwd(), "node_modules", packageName);
      await fs.promises.access(packagePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  static async checkYtDlp(): Promise<boolean> {
    const commands = [
      "yt-dlp --version",
      "python3 -m yt_dlp --version",
      "python -m yt_dlp --version",
    ];

    for (const cmd of commands) {
      try {
        await execAsync(cmd);
        console.log(`[music] yt-dlp found: ${cmd}`);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  static async checkFfmpeg(): Promise<boolean> {
    try {
      await execAsync("ffmpeg -version");
      console.log("[Music] FFmpeg 已就绪");
      return true;
    } catch {
      console.log("[Music] FFmpeg 未找到");
      return false;
    }
  }
}

// ==================== Utilities ====================
class Utils {
  static escape(text: string): string {
    return text.replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#x27;",
        }[m] || m)
    );
  }

  static sanitizeFilename(name: string): string {
    return name
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50);
  }

  static async fileExists(path: string): Promise<boolean> {
    try {
      await fs.promises.access(path);
      return true;
    } catch {
      return false;
    }
  }

  static formatSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  static formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  // 解析多种时长表示："mm:ss"、"hh:mm:ss"、"225"、"225s"、"3分45秒"
  static parseDuration(input: string): number | undefined {
    if (!input) return undefined;
    const txt = String(input).trim();

    // 纯数字（秒）或带 s 后缀
    const secNum = /^\d+(?:\.\d+)?s?$/i;
    if (secNum.test(txt)) {
      const v = parseFloat(txt.replace(/s$/i, ""));
      return Number.isFinite(v) ? Math.round(v) : undefined;
    }

    // 中文格式：3分45秒 / 1小时2分3秒
    const zh = /(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分)?\s*(?:(\d+)\s*秒)?/;
    const zhMatch = txt.match(zh);
    if (zhMatch && (zhMatch[1] || zhMatch[2] || zhMatch[3])) {
      const h = parseInt(zhMatch[1] || "0", 10);
      const m = parseInt(zhMatch[2] || "0", 10);
      const s = parseInt(zhMatch[3] || "0", 10);
      return h * 3600 + m * 60 + s;
    }

    // 冒号分隔：hh:mm:ss 或 mm:ss
    const parts = txt
      .split(":")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 2 || parts.length === 3) {
      const nums = parts.map((p) => parseInt(p, 10));
      if (nums.every((n) => Number.isFinite(n))) {
        let h = 0,
          m = 0,
          s = 0;
        if (nums.length === 3) {
          [h, m, s] = nums as [number, number, number];
        } else {
          [m, s] = nums as [number, number];
        }
        return h * 3600 + m * 60 + s;
      }
    }

    return undefined;
  }
}

// ==================== Configuration Manager ====================
class ConfigManager {
  private static db: any = null;
  private static initialized = false;

  private static async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // 确保目录存在
      const configDir = path.dirname(CONFIG.PATHS.CONFIG);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // 文件不存在时以扁平结构初始化
      const defaultData: Record<string, any> = { ...DEFAULT_CONFIG };

      this.db = await JSONFilePreset<LegacyConfigData>(
        CONFIG.PATHS.CONFIG,
        defaultData
      );
      this.initialized = true;
      // console.log("[music] 配置管理器初始化成功 (lowdb)");
    } catch (error) {
      console.error("[music] 初始化配置失败:", error);
    }
  }

  static async get(key: string, defaultValue?: string): Promise<string> {
    await this.init();
    if (!this.db) {
      return defaultValue || DEFAULT_CONFIG[key] || "";
    }

    // 优先读取顶级键
    if (
      Object.prototype.hasOwnProperty.call(this.db.data, key) &&
      typeof this.db.data[key] !== "undefined"
    ) {
      return this.db.data[key] ?? defaultValue ?? DEFAULT_CONFIG[key] ?? "";
    }

    // 兼容历史结构
    try {
      const legacy = this.db.data as LegacyConfigData;
      if (legacy.settings && typeof legacy.settings[key] !== "undefined") {
        return (
          legacy.settings[key] ?? defaultValue ?? DEFAULT_CONFIG[key] ?? ""
        );
      }
      if (key === CONFIG.KEYS.API && legacy.apiKeys) {
        return legacy.apiKeys[key] ?? defaultValue ?? "";
      }
      if (key === CONFIG.KEYS.COOKIE && legacy.cookies) {
        return legacy.cookies[key] ?? defaultValue ?? "";
      }
      // 历史遗留别名
      if (key === CONFIG.KEYS.API && legacy.settings?.apikey) {
        return legacy.settings.apikey ?? defaultValue ?? "";
      }
    } catch {}

    return defaultValue || DEFAULT_CONFIG[key] || "";
  }

  static async set(key: string, value: string): Promise<boolean> {
    await this.init();
    if (!this.db) return false;

    try {
      // 统一以顶级键存储（不迁移历史数据，仅写入新键）
      this.db.data[key] = value;

      await this.db.write(); // 自动保存
      return true;
    } catch (error) {
      console.error(`[music] 设置配置失败 ${key}:`, error);
      return false;
    }
  }

  static async remove(key: string): Promise<boolean> {
    await this.init();
    if (!this.db) return false;

    try {
      if (Object.prototype.hasOwnProperty.call(this.db.data, key)) {
        delete this.db.data[key];
      }
      await this.db.write();
      return true;
    } catch (error) {
      console.error(`[Music] Failed to remove ${key}:`, error);
      return false;
    }
  }

  static async getAll(): Promise<Record<string, any>> {
    await this.init();
    if (!this.db) return {};
    // 导出所有配置键，优先顶级，其次兼容历史结构
    const keys = [
      CONFIG.KEYS.BASE_URL,
      CONFIG.KEYS.MODEL,
      CONFIG.KEYS.COOKIE,
      CONFIG.KEYS.API,
      CONFIG.KEYS.PROXY,
      CONFIG.KEYS.AUDIO_QUALITY,
      CONFIG.KEYS.TEMPERATURE,
      CONFIG.KEYS.TOP_P,
      CONFIG.KEYS.TOP_K,
    ];
    const result: Record<string, any> = {};
    for (const k of keys) {
      result[k] = await this.get(k, DEFAULT_CONFIG[k] ?? "");
    }
    return result;
  }

  static async delete(key: string): Promise<boolean> {
    await this.init();
    if (!this.db) return false;

    try {
      if (Object.prototype.hasOwnProperty.call(this.db.data, key)) {
        delete this.db.data[key];
      }

      await this.db.write(); // 自动保存
      return true;
    } catch (error) {
      console.error(`[music] 删除配置失败 ${key}:`, error);
      return false;
    }
  }
}

// ==================== HTTP Client ====================
class HttpClient {
  static cleanResponseText(text: string): string {
    if (!text) return text;
    return text
      .replace(/^\uFEFF/, "")
      .replace(/\uFFFD/g, "")
      .replace(/[\uFFFC\uFFFF\uFFFE]/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replace(/[\uDC00-\uDFFF]/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
      .normalize("NFKC");
  }

  static async makeRequest(url: string, options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const { method = "GET", headers = {}, data, timeout = 30000 } = options;
      const isHttps = url.startsWith("https:");
      const client = isHttps ? https : http;

      const req = client.request(
        url,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "TeleBox/1.0",
            ...headers,
          },
          timeout,
        },
        (res: any) => {
          res.setEncoding("utf8");
          let body = "";
          let dataLength = 0;
          const maxResponseSize = 10 * 1024 * 1024;

          res.on("data", (chunk: string) => {
            dataLength += chunk.length;
            if (dataLength > maxResponseSize) {
              req.destroy();
              reject(new Error("响应数据过大"));
              return;
            }
            body += chunk;
          });

          res.on("end", () => {
            try {
              const cleanBody = HttpClient.cleanResponseText(body);
              const parsedData = cleanBody ? JSON.parse(cleanBody) : {};
              resolve({
                status: res.statusCode || 0,
                data: parsedData,
                headers: res.headers,
              });
            } catch (error) {
              resolve({
                status: res.statusCode || 0,
                data: HttpClient.cleanResponseText(body),
                headers: res.headers,
              });
            }
          });
        }
      );

      req.on("error", (error: any) => {
        reject(new Error(`网络请求失败: ${error.message}`));
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("请求超时"));
      });

      if (data) {
        if (typeof data === "object") {
          const jsonData = JSON.stringify(data);
          req.write(jsonData);
        } else if (typeof data === "string") {
          req.write(data);
        }
      }

      req.end();
    });
  }
}

// ==================== Gemini Client ====================
class GeminiClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string | null) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? DEFAULT_CONFIG[CONFIG.KEYS.BASE_URL];
  }

  async searchMusic(query: string): Promise<string> {
    const model = await ConfigManager.get(CONFIG.KEYS.MODEL);
    const url = `${this.baseUrl}/v1beta/models/${model}:generateContent`;
    
    // 获取准确率调节参数
    const temperature = parseFloat(await ConfigManager.get(CONFIG.KEYS.TEMPERATURE, "0.1"));
    const topP = parseFloat(await ConfigManager.get(CONFIG.KEYS.TOP_P, "0.5"));
    const topK = parseInt(await ConfigManager.get(CONFIG.KEYS.TOP_K, "5"), 10);
    
    console.log(`[Music] Gemini参数: temperature=${temperature}, topP=${topP}, topK=${topK}`);

    const systemPrompt = `只输出以下3行，且不要任何其他内容。若未知则留空：

歌曲名: 
歌手: 
专辑: `;

    const userPrompt = `精准识别这个查询的歌曲信息："${query}"
要求：
1. 自动纠正拼写错误和识别拼音繁体
2. 返回最广为人知的版本
3. 歌手必须是最准确的演唱者，不能有任何错误
4. 只填写确定的信息，如果没有找到歌曲则用用户输入作为歌曲名
5. 歌手名和歌曲名必须转换为繁体中文输出`;

    const headers: Record<string, string> = {
      "x-goog-api-key": this.apiKey,
    };

    const requestData = {
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }],
        },
      ],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature: temperature,
        topP: topP,
        topK: topK,
        maxOutputTokens: 200,
      },
      tools: [{ googleSearch: {} }],
      safetySettings: [
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_CIVIC_INTEGRITY",
      ].map((category) => ({ category, threshold: "BLOCK_NONE" })),
    };

    const response = await HttpClient.makeRequest(url, {
      method: "POST",
      headers,
      data: requestData,
    });

    if (response.status !== 200 || response.data?.error) {
      const errorMessage =
        response.data?.error?.message ||
        response.data?.error ||
        `HTTP错误: ${response.status}`;
      throw new Error(errorMessage);
    }

    const rawText =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return HttpClient.cleanResponseText(rawText);
  }
}

// ==================== Cookie Converter ====================
class CookieConverter {
  // 检测并转换各种格式的 Cookie 为 Netscape 格式
  static convertToNetscape(input: string): string {
    // 清理输入
    input = input.trim();

    // 1. 如果已经是 Netscape 格式（包含制表符分隔的7个字段）
    if (this.isNetscapeFormat(input)) {
      return input;
    }

    // 2. JSON 格式的 Cookie（从浏览器开发者工具导出）
    if (this.isJsonFormat(input)) {
      return this.convertJsonToNetscape(input);
    }

    // 3. 浏览器 Cookie 字符串格式（key=value; key2=value2）
    if (this.isBrowserStringFormat(input)) {
      return this.convertBrowserStringToNetscape(input);
    }

    // 4. EditThisCookie 扩展格式
    if (this.isEditThisCookieFormat(input)) {
      return this.convertEditThisCookieToNetscape(input);
    }

    // 5. 简单的 key=value 对（每行一个）
    if (this.isSimpleKeyValueFormat(input)) {
      return this.convertSimpleKeyValueToNetscape(input);
    }

    // 如果无法识别格式，尝试作为 Netscape 格式返回
    return input;
  }

  private static isNetscapeFormat(input: string): boolean {
    const lines = input
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"));
    if (lines.length === 0) return false;

    // Netscape 格式每行应该有 7 个制表符分隔的字段
    return lines.every((line) => {
      const fields = line.split("\t");
      return fields.length === 7;
    });
  }

  private static isJsonFormat(input: string): boolean {
    try {
      const parsed = JSON.parse(input);
      return (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed[0].hasOwnProperty("name") &&
        parsed[0].hasOwnProperty("value")
      );
    } catch {
      return false;
    }
  }

  private static convertJsonToNetscape(input: string): string {
    try {
      const cookies = JSON.parse(input);
      const netscapeLines: string[] = [
        "# Netscape HTTP Cookie File",
        "# This file was generated by TeleBox Music Plugin",
        "",
      ];

      for (const cookie of cookies) {
        const domain = cookie.domain || ".youtube.com";
        const flag = domain.startsWith(".") ? "TRUE" : "FALSE";
        const path = cookie.path || "/";
        const secure = cookie.secure ? "TRUE" : "FALSE";
        const expiry =
          cookie.expirationDate ||
          cookie.expires ||
          Math.floor(Date.now() / 1000) + 31536000; // 1 year from now
        const name = cookie.name || "";
        const value = cookie.value || "";

        if (name && value) {
          netscapeLines.push(
            `${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${name}\t${value}`
          );
        }
      }

      return netscapeLines.join("\n");
    } catch (error) {
      console.error("Failed to convert JSON to Netscape:", error);
      return input;
    }
  }

  private static isBrowserStringFormat(input: string): boolean {
    // 检查是否包含 key=value; 格式
    return input.includes("=") && (input.includes(";") || input.includes("="));
  }

  private static convertBrowserStringToNetscape(input: string): string {
    const netscapeLines: string[] = [
      "# Netscape HTTP Cookie File",
      "# This file was generated by TeleBox Music Plugin",
      "",
    ];

    // 分割 cookie 字符串
    const cookies = input.split(/;\s*/).filter((c) => c.includes("="));

    for (const cookie of cookies) {
      const [name, ...valueParts] = cookie.split("=");
      const value = valueParts.join("="); // 处理值中包含 = 的情况

      if (name && value) {
        // YouTube cookies 默认设置
        const domain = ".youtube.com";
        const flag = "TRUE";
        const path = "/";
        const secure = "TRUE";
        const expiry = Math.floor(Date.now() / 1000) + 31536000; // 1 year

        netscapeLines.push(
          `${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${name.trim()}\t${value.trim()}`
        );
      }
    }

    return netscapeLines.join("\n");
  }

  private static isEditThisCookieFormat(input: string): boolean {
    // EditThisCookie 通常导出为带特定字段的 JSON
    try {
      const parsed = JSON.parse(input);
      return (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        (parsed[0].hasOwnProperty("storeId") ||
          parsed[0].hasOwnProperty("sameSite"))
      );
    } catch {
      return false;
    }
  }

  private static convertEditThisCookieToNetscape(input: string): string {
    // 使用相同的 JSON 转换逻辑
    return this.convertJsonToNetscape(input);
  }

  private static isSimpleKeyValueFormat(input: string): boolean {
    const lines = input.split("\n").filter((line) => line.trim());
    return (
      lines.length > 0 &&
      lines.every((line) => {
        return line.includes("=") && !line.includes("\t");
      })
    );
  }

  private static convertSimpleKeyValueToNetscape(input: string): string {
    const netscapeLines: string[] = [
      "# Netscape HTTP Cookie File",
      "# This file was generated by TeleBox Music Plugin",
      "",
    ];

    const lines = input.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      const [name, ...valueParts] = line.split("=");
      const value = valueParts.join("=");

      if (name && value) {
        const domain = ".youtube.com";
        const flag = "TRUE";
        const path = "/";
        const secure = "TRUE";
        const expiry = Math.floor(Date.now() / 1000) + 31536000;

        netscapeLines.push(
          `${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${name.trim()}\t${value.trim()}`
        );
      }
    }

    return netscapeLines.join("\n");
  }
}

// ==================== Helper Functions ====================
async function extractSongInfo(
  geminiResponse: string,
  userInput: string
): Promise<{
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}> {
  const lines = geminiResponse.split("\n").map((line) => line.trim());
  let title = "";
  let artist = "";
  let album = "";
  let durationSec: number | undefined;

  for (const line of lines) {
    if (line.startsWith("歌曲名:") || line.startsWith("歌曲名：")) {
      title = line.replace(/歌曲名[:：]\s*/, "").trim();
    } else if (line.startsWith("歌手:") || line.startsWith("歌手：")) {
      artist = line.replace(/歌手[:：]\s*/, "").trim();
    } else if (line.startsWith("专辑:") || line.startsWith("专辑：")) {
      album = line.replace(/专辑[:：]\s*/, "").trim();
    }
  }

  // 返回结果，空值不返回
  return {
    title: title || userInput, // 如果没有识别到歌曲名，使用用户输入
    artist: artist || "Youtube Music", // 如果没有识别到歌手，使用 Youtube Music
    album: album || undefined,
    duration: durationSec,
  };
}

// ==================== Downloader ====================
class Downloader {
  private tempDir: string;

  constructor() {
    this.tempDir = CONFIG.PATHS.TEMP;
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async checkDependencies(): Promise<{ ytdlp: boolean; ffmpeg: boolean }> {
    const result = { ytdlp: false, ffmpeg: false };

    // Check yt-dlp with multiple methods
    const ytdlpCommands = [
      "yt-dlp --version",
      "python3 -m yt_dlp --version",
      "python -m yt_dlp --version",
      "youtube-dl --version", // Fallback to youtube-dl
    ];

    for (const cmd of ytdlpCommands) {
      try {
        await execAsync(cmd);
        result.ytdlp = true;
        console.log(`[Music] Found yt-dlp via: ${cmd.split(" ")[0]}`);
        break;
      } catch {}
    }

    // Check FFmpeg
    try {
      await execAsync("ffmpeg -version");
      result.ffmpeg = true;
      // 静默检查，不输出日志
    } catch {
      console.log("[Music] FFmpeg 未找到，音频处理功能受限");
    }

    return result;
  }

  async search(query: string, minDurationSec?: number): Promise<string | null> {
    try {
      const cookie = await ConfigManager.get(CONFIG.KEYS.COOKIE);
      const proxy = await ConfigManager.get(CONFIG.KEYS.PROXY);

      // 使用AI识别歌手和歌曲名，构建最终搜索词
      let finalQuery = query;
      try {
        const apiKey = await ConfigManager.get(CONFIG.KEYS.API);
        if (apiKey && apiKey.trim()) {
          const baseUrl = await ConfigManager.get(CONFIG.KEYS.BASE_URL);
          const gemini = new GeminiClient(apiKey, baseUrl);
          const aiResponse = await gemini.searchMusic(query);
          const songInfo = await extractSongInfo(aiResponse, query);
          
          // 构建搜索词：歌手 + 歌曲名 + Lyrics
          if (songInfo.artist && songInfo.title) {
            finalQuery = `${songInfo.artist} ${songInfo.title} Lyrics`;
            console.log(`[Music] AI构建搜索词: ${finalQuery}`);
          }
        }
      } catch (error) {
        console.log(`[Music] AI识别失败，使用原始搜索词: ${error}`);
      }

      // Escape query for shell
      const safeQuery = finalQuery.replace(/"/g, '\\"');

      // Try multiple search methods
      const commands = [];
      // 使用 ytsearch1 获取第一个结果，并输出 JSON 供筛选
      const baseCmd = `"ytsearch1:${safeQuery}" --dump-json --no-warnings --skip-download`;

      // Add authentication parameters
      let authParams = "";
      if (cookie && cookie.trim()) {
        const cookieFile = path.join(this.tempDir, "cookies.txt");
        await fs.promises.writeFile(cookieFile, this.convertCookie(cookie));
        authParams += ` --cookies "${cookieFile}"`;
      }
      if (proxy) authParams += ` --proxy "${proxy}"`;

      // Build command list with fallbacks
      commands.push(
        `yt-dlp ${baseCmd} --prefer-insecure --legacy-server-connect${authParams}`
      );
      commands.push(`python3 -m yt_dlp ${baseCmd}${authParams}`);
      commands.push(`python -m yt_dlp ${baseCmd}${authParams}`);

      let stdout = "";
      for (const cmd of commands) {
        try {
          // 增加maxBuffer以处理更多搜索结果的输出
          const result = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 }); // 10MB
          stdout = result.stdout;
          console.log(`[Music] Search successful with: ${cmd.split(" ")[0]}`);
          break;
        } catch (error) {
          console.error(error);
          console.log(`[Music] Search failed with: ${cmd.split(" ")[0]}`);
        }
      }

      if (!stdout.trim()) return null;

      // 解析 JSON 行
      type Cand = {
        id?: string;
        title?: string;
        uploader?: string;
        duration?: number;
        webpage_url?: string;
        url?: string;
      };
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      const items: Cand[] = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === "object") {
            if (Array.isArray(obj.entries)) {
              for (const e of obj.entries) {
                items.push(e as Cand);
              }
            } else {
              items.push(obj as Cand);
            }
          }
        } catch {
          // 忽略非 JSON 行
        }
      }

      if (!items.length) return null;

      // 构建候选含 URL + 时长
      let candidates = items
        .map((it) => {
          const id = it.id;
          const url =
            it.webpage_url ||
            (it.url && /^https?:/.test(it.url)
              ? it.url
              : id
              ? `https://www.youtube.com/watch?v=${id}`
              : undefined);
          const dur = typeof it.duration === "number" ? it.duration : undefined;
          return url
            ? {
                url,
                id,
                duration: dur,
                title: it.title || "",
                uploader: it.uploader || "",
              }
            : null;
        })
        .filter(Boolean) as {
        url: string;
        id?: string;
        duration?: number;
        title: string;
        uploader: string;
      }[];

      // 直接返回第一个符合时长要求的结果
      for (const candidate of candidates) {
        // 检查时长是否符合要求（不超过15分钟）
        if (typeof candidate.duration === "number" && candidate.duration <= 15 * 60) {
          console.log(`[Music] 选中第一个结果: ${candidate.title} (时长: ${candidate.duration}s)`);
          return candidate.url;
        }
      }

      console.log(`[Music] 没有找到符合时长要求的结果`);
      return null;
    } catch (error) {
      console.error("[Music] Search error:", error);
      return null;
    }
  }

  private convertCookie(cookie: string): string {
    // Simple cookie format converter
    if (cookie.includes("\t")) {
      // Already in Netscape format
      return cookie;
    }

    // Convert from key=value format to Netscape
    const lines = ["# Netscape HTTP Cookie File", ""];
    const pairs = cookie.split(/;\s*/).filter((p) => p.includes("="));

    for (const pair of pairs) {
      const [name, value] = pair.split("=");
      if (name && value) {
        // YouTube cookie defaults
        lines.push(
          `.youtube.com\tTRUE\t/\tTRUE\t${
            Math.floor(Date.now() / 1000) + 31536000
          }\t${name.trim()}\t${value.trim()}`
        );
      }
    }

    return lines.join("\n");
  }

  async download(
    url: string,
    metadata?: SongInfo
  ): Promise<{ audioPath: string | null; thumbnailPath?: string }> {
    try {
      const filename = metadata
        ? `${Utils.sanitizeFilename(metadata.artist)}_${Utils.sanitizeFilename(
            metadata.title
          )}`
        : `download_${Date.now()}`;

      // 每次下载到临时目录，确保全新下载
      const timestamp = Date.now();
      const outputPath = path.join(
        this.tempDir,
        `${filename}_${timestamp}.%(ext)s`
      );
      const thumbnailPath = path.join(
        this.tempDir,
        `${filename}_${timestamp}_thumb.jpg`
      );
      const cookie = await ConfigManager.get(CONFIG.KEYS.COOKIE);
      const proxy = await ConfigManager.get(CONFIG.KEYS.PROXY);

      // Prepare authentication
      let authParams = "";
      if (cookie && cookie.trim()) {
        const cookieFile = path.join(this.tempDir, "cookies.txt");
        await fs.promises.writeFile(cookieFile, this.convertCookie(cookie));
        authParams += ` --cookies "${cookieFile}"`;
      }
      if (proxy) authParams += ` --proxy "${proxy}"`;

      // 先获取视频信息和缩略图
      let hasThumbnail = false;
      let videoInfo: any = null;

      // 获取视频元数据
      try {
        const infoCmd = `yt-dlp --dump-json --no-warnings${authParams} "${url}"`;
        const { stdout } = await execAsync(infoCmd);
        videoInfo = JSON.parse(stdout);

        // 从视频信息中补充元数据（不覆盖已有的）
        if (videoInfo) {
          // 如果没有传入元数据，从视频信息创建
          if (!metadata) {
            metadata = {
              title: videoInfo.title || videoInfo.track || "Unknown",
              artist:
                videoInfo.artist ||
                videoInfo.uploader ||
                videoInfo.channel ||
                "Unknown Artist",
              album: videoInfo.album || undefined,
            };
          } else {
            // 如果已有元数据（比如从AI获取的），只补充缺失的字段
            if (!metadata.title && videoInfo.title) {
              metadata.title = videoInfo.title;
            }
            if (metadata.artist === "Unknown Artist" && videoInfo.artist) {
              metadata.artist = videoInfo.artist;
            }
            if (!metadata.album && videoInfo.album) {
              metadata.album = videoInfo.album;
            }
          }
          console.log(
            `[music] 元数据: ${metadata.artist} - ${metadata.title}${
              metadata.album ? " - " + metadata.album : ""
            }`
          );
        }
      } catch (error) {
        console.log("[music] 无法获取视频信息，使用已有元数据");
      }

      // 下载缩略图
      try {
        const thumbCmd = `yt-dlp --write-thumbnail --skip-download -o "${thumbnailPath.replace(
          ".jpg",
          ""
        )}"${authParams} "${url}"`;
        await execAsync(thumbCmd);

        // 检查各种可能的缩略图格式
        const possibleExts = [".jpg", ".jpeg", ".png", ".webp"];
        for (const ext of possibleExts) {
          const possiblePath = thumbnailPath.replace(".jpg", ext);
          if (fs.existsSync(possiblePath)) {
            // 如果不是jpg，转换为jpg
            if (ext !== ".jpg") {
              await execAsync(
                `ffmpeg -i "${possiblePath}" -vf "scale=320:320:force_original_aspect_ratio=increase,crop=320:320" "${thumbnailPath}" -y`
              );
              fs.unlinkSync(possiblePath);
            } else {
              // 调整大小为正方形
              await execAsync(
                `ffmpeg -i "${possiblePath}" -vf "scale=320:320:force_original_aspect_ratio=increase,crop=320:320" "${thumbnailPath}_temp.jpg" -y`
              );
              fs.renameSync(`${thumbnailPath}_temp.jpg`, thumbnailPath);
            }
            hasThumbnail = true;
            console.log(`[music] 缩略图已下载: ${thumbnailPath}`);
            break;
          }
        }
      } catch (error) {
        console.log("[music] 缩略图下载失败，继续下载音频");
      }

      // 读取用户配置的音频质量（可为空）
      const configuredQuality = await ConfigManager.get(
        CONFIG.KEYS.AUDIO_QUALITY
      );
      const qualityArg = configuredQuality
        ? ` --audio-quality ${configuredQuality}`
        : "";
      // 用户显式设置音质时，使用 mp3 以确保质量参数生效；否则保持最佳可用格式
      const audioFormat = configuredQuality ? "mp3" : "best";

      // Build command list with fallbacks - 优化音频格式选择
      const commands = [
        // 优先下载最高质量的音频
        `yt-dlp -x --audio-format ${audioFormat}${qualityArg} --extract-audio --embed-metadata --add-metadata -o "${outputPath}" --prefer-insecure --legacy-server-connect${authParams} "${url}"`,
        // Python 模块方式
        `python3 -m yt_dlp -x --audio-format ${audioFormat}${qualityArg} --extract-audio --embed-metadata --add-metadata -o "${outputPath}"${authParams} "${url}"`,
        `python -m yt_dlp -x --audio-format ${audioFormat}${qualityArg} --extract-audio --embed-metadata --add-metadata -o "${outputPath}"${authParams} "${url}"`,
      ];

      // 尝试多种下载策略
      let success = false;
      let lastError: any = null;

      for (const cmd of commands) {
        try {
          console.log(`[music] 尝试下载命令: ${cmd.split(" ")[0]}`);
          const { stdout, stderr } = await execAsync(cmd);
          console.log(`[music] 下载成功`);
          success = true;
          break;
        } catch (error: any) {
          lastError = error;
          console.log(`[music] 下载失败: ${error.message}`);
          continue;
        }
      }

      if (!success) {
        console.error("[music] 所有下载策略失败:", lastError?.message);
        return { audioPath: null };
      }

      // 查找下载的文件（按音质优先级排序）
      const files = await fs.promises.readdir(this.tempDir);
      const audioExtensions = [
        ".flac",
        ".wav",
        ".m4a",
        ".opus",
        ".aac",
        ".mp3",
        ".ogg",
        ".webm",
      ];

      // 按优先级查找文件
      for (const ext of audioExtensions) {
        const audioFile = files.find((f) => {
          const hasFilename = f.startsWith(filename);
          const hasExt = f.toLowerCase().endsWith(ext);
          return hasFilename && hasExt;
        });

        if (audioFile) {
          const filePath = path.join(this.tempDir, audioFile);
          const stats = await fs.promises.stat(filePath);
          const formatInfo = this.getFormatInfo(ext);
          console.log(
            `[music] 下载完成: ${audioFile} (${Utils.formatSize(
              stats.size
            )}, ${formatInfo})`
          );

          // 嵌入元数据和封面
          const finalPath = await this.embedMetadata(
            filePath,
            metadata,
            hasThumbnail ? thumbnailPath : undefined
          );

          return {
            audioPath: finalPath,
            thumbnailPath: hasThumbnail ? thumbnailPath : undefined,
          };
        }
      }

      return { audioPath: null };
    } catch (error) {
      console.error("[music] 下载失败:", error);
      return { audioPath: null };
    }
  }

  private getFormatInfo(ext: string): string {
    const formatMap: Record<string, string> = {
      ".flac": "FLAC无损",
      ".wav": "WAV无损",
      ".m4a": "M4A高质量",
      ".opus": "OPUS高效",
      ".aac": "AAC高质量",
      ".mp3": "MP3兼容",
      ".ogg": "OGG开源",
      ".webm": "WebM",
    };
    return formatMap[ext] || ext.toUpperCase();
  }

  private async embedMetadata(
    audioPath: string,
    metadata?: SongInfo,
    thumbnailPath?: string
  ): Promise<string> {
    // 如果没有元数据和封面，直接返回原文件
    if (!metadata && !thumbnailPath) {
      console.log("[music] 没有元数据和封面，跳过嵌入");
      return audioPath;
    }

    // 打印要嵌入的元数据
    if (metadata) {
      console.log("[music] 准备嵌入元数据:");
      console.log(`  - 标题: ${metadata.title || "无"}`);
      console.log(`  - 艺术家: ${metadata.artist || "无"}`);
      console.log(`  - 专辑: ${metadata.album || "无"}`);
    }

    // OPUS 格式特殊处理 - 转换为 MP3 以确保兼容性
    const ext = path.extname(audioPath).toLowerCase();
    if (ext === ".opus") {
      console.log("[music] OPUS 格式：转换为 MP3 以确保 Telegram 兼容性");
      const mp3Path = await this.embedMetadataOnly(audioPath, metadata);

      // 如果有缩略图，为 MP3 嵌入封面
      if (
        thumbnailPath &&
        fs.existsSync(thumbnailPath) &&
        mp3Path.endsWith(".mp3")
      ) {
        return this.embedCoverToMp3(mp3Path, metadata, thumbnailPath);
      }
      return mp3Path;
    }

    try {
      const ext = path.extname(audioPath).toLowerCase();
      const outputPath = audioPath.replace(ext, `_tagged${ext}`);

      // 构建FFmpeg命令 - 添加静默模式
      let ffmpegCmd = `ffmpeg -loglevel error -i "${audioPath}"`;

      // 添加封面（如果有）
      if (thumbnailPath && fs.existsSync(thumbnailPath)) {
        ffmpegCmd += ` -i "${thumbnailPath}"`;
      }

      // 复制音频流 - 保持原始编码
      ffmpegCmd += " -c:a copy";

      // 添加元数据
      if (metadata) {
        if (metadata.title && metadata.title !== "Unknown") {
          ffmpegCmd += ` -metadata title="${metadata.title.replace(
            /"/g,
            '\\"'
          )}"`;
          console.log(`[music] 添加标题: ${metadata.title}`);
        }
        if (metadata.artist && metadata.artist !== "Unknown Artist") {
          ffmpegCmd += ` -metadata artist="${metadata.artist.replace(
            /"/g,
            '\\"'
          )}"`;
          console.log(`[music] 添加艺术家: ${metadata.artist}`);
        }
        if (metadata.album) {
          ffmpegCmd += ` -metadata album="${metadata.album.replace(
            /"/g,
            '\\"'
          )}"`;
          console.log(`[music] 添加专辑: ${metadata.album}`);
        }
        // 添加更多元数据
        ffmpegCmd += ` -metadata comment="Downloaded by TeleBox Music Plugin"`;
        ffmpegCmd += ` -metadata date="${new Date().getFullYear()}"`;
      }

      // 嵌入封面
      if (thumbnailPath && fs.existsSync(thumbnailPath)) {
        // 对于不同格式使用不同的封面嵌入方法
        if (ext === ".mp3") {
          ffmpegCmd +=
            " -map 0:a -map 1:v -c:v mjpeg -disposition:v attached_pic";
        } else if (ext === ".m4a" || ext === ".mp4" || ext === ".aac") {
          ffmpegCmd +=
            " -map 0:a -map 1:v -c:v copy -disposition:v attached_pic";
        } else if (ext === ".flac") {
          ffmpegCmd +=
            " -map 0:a -map 1:v -c:v png -disposition:v attached_pic";
        } else if (ext === ".opus") {
          // OPUS 格式保持原始格式，不嵌入封面避免格式转换
          ffmpegCmd += " -map 0:a -c:a copy";
          // OPUS 格式的封面需要特殊处理，暂时跳过
          console.log("[music] OPUS 格式暂不支持封面嵌入，保持原始格式");
        } else if (ext === ".ogg") {
          // OGG Vorbis 格式
          ffmpegCmd += " -map 0:a";
        } else {
          // 其他格式尝试标准方法
          ffmpegCmd += " -map 0:a";
          if (thumbnailPath) {
            ffmpegCmd += " -map 1:v -c:v copy -disposition:v attached_pic";
          }
        }
      } else {
        // 没有封面时只映射音频流
        ffmpegCmd += " -map 0:a";
      }

      // 输出文件 - 让 FFmpeg 根据扩展名自动选择容器
      // 这里不再强制使用 `-f auto`（无效），仅在特殊需要时才指定格式。
      ffmpegCmd += ` -y "${outputPath}"`;

      console.log("[music] 正在嵌入元数据和封面...");
      const { stderr } = await execAsync(ffmpegCmd);

      // 检查输出文件是否创建成功
      if (!fs.existsSync(outputPath)) {
        console.error("[music] FFmpeg 输出文件未创建");
        if (stderr) console.error("[music] FFmpeg 错误:", stderr);
        return audioPath;
      }

      // 检查新文件大小
      const newSize = fs.statSync(outputPath).size;
      if (newSize === 0) {
        console.error("[music] FFmpeg 输出文件为空");
        fs.unlinkSync(outputPath);
        return audioPath;
      }

      // 删除原文件，重命名新文件
      fs.unlinkSync(audioPath);
      fs.renameSync(outputPath, audioPath);

      console.log("[music] 元数据和封面嵌入成功");
      return audioPath;
    } catch (error) {
      console.error("[music] 元数据嵌入失败:", error);
      // 如果失败，返回原文件
      return audioPath;
    }
  }

  private async embedMetadataOnly(
    audioPath: string,
    metadata?: SongInfo
  ): Promise<string> {
    // OPUS 格式转换为 MP3 以确保 Telegram 兼容性
    if (!metadata) {
      console.log("[music] OPUS: 没有元数据，跳过嵌入");
      return audioPath;
    }

    console.log("[music] OPUS 转换为 MP3 并嵌入元数据...");

    try {
      const ext = path.extname(audioPath).toLowerCase();
      // 转换为 MP3 格式
      const outputPath = audioPath.replace(ext, "_converted.mp3");

      // 使用 FFmpeg 转换为 MP3 并嵌入元数据
      let ffmpegCmd = `ffmpeg -loglevel error -i "${audioPath}"`;

      // 设置 MP3 编码参数 - 高质量
      ffmpegCmd += " -c:a libmp3lame -b:a 320k";

      // 添加元数据
      if (metadata.title && metadata.title !== "Unknown") {
        ffmpegCmd += ` -metadata title="${metadata.title.replace(
          /"/g,
          '\\"'
        )}"`;
        console.log(`[music] 添加标题: ${metadata.title}`);
      }
      if (metadata.artist && metadata.artist !== "Unknown Artist") {
        ffmpegCmd += ` -metadata artist="${metadata.artist.replace(
          /"/g,
          '\\"'
        )}"`;
        console.log(`[music] 添加艺术家: ${metadata.artist}`);
      }
      if (metadata.album) {
        ffmpegCmd += ` -metadata album="${metadata.album.replace(
          /"/g,
          '\\"'
        )}"`;
        console.log(`[music] 添加专辑: ${metadata.album}`);
      }

      // 添加 ID3v2 标签版本
      ffmpegCmd += " -id3v2_version 3";

      // 输出文件
      ffmpegCmd += ` -y "${outputPath}"`;

      console.log("[music] 执行 FFmpeg 转换命令...");
      const { stderr } = await execAsync(ffmpegCmd);
      if (stderr) {
        console.log("[music] FFmpeg 输出:", stderr);
      }

      // 验证输出文件
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        console.error("[music] 转换失败");
        return audioPath;
      }

      // 删除原 OPUS 文件
      fs.unlinkSync(audioPath);

      const newSize = fs.statSync(outputPath).size;
      console.log(`[music] OPUS 转 MP3 成功 (${Utils.formatSize(newSize)})`);
      return outputPath;
    } catch (error) {
      console.error("[music] OPUS 转换错误:", error);
      return audioPath;
    }
  }

  private async embedCoverToMp3(
    mp3Path: string,
    metadata?: SongInfo,
    thumbnailPath?: string
  ): Promise<string> {
    // 为 MP3 文件嵌入封面
    if (!thumbnailPath || !fs.existsSync(thumbnailPath)) {
      return mp3Path;
    }

    try {
      const outputPath = mp3Path.replace(".mp3", "_final.mp3");

      // 使用 FFmpeg 嵌入封面
      let ffmpegCmd = `ffmpeg -loglevel error -i "${mp3Path}" -i "${thumbnailPath}"`;
      ffmpegCmd += " -map 0:a -map 1:v";
      ffmpegCmd += " -c:a copy -c:v mjpeg";
      ffmpegCmd += " -disposition:v attached_pic";

      // 保留元数据
      if (metadata) {
        if (metadata.title) {
          ffmpegCmd += ` -metadata title="${metadata.title.replace(
            /"/g,
            '\\"'
          )}"`;
        }
        if (metadata.artist) {
          ffmpegCmd += ` -metadata artist="${metadata.artist.replace(
            /"/g,
            '\\"'
          )}"`;
        }
        if (metadata.album) {
          ffmpegCmd += ` -metadata album="${metadata.album.replace(
            /"/g,
            '\\"'
          )}"`;
        }
      }

      ffmpegCmd += " -id3v2_version 3";
      ffmpegCmd += ` -y "${outputPath}"`;

      console.log("[music] 嵌入封面到 MP3...");
      await execAsync(ffmpegCmd);

      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(mp3Path);
        console.log("[music] MP3 封面嵌入成功");
        return outputPath;
      }

      return mp3Path;
    } catch (error) {
      console.error("[music] MP3 封面嵌入失败:", error);
      return mp3Path;
    }
  }

  async cleanCache(hours: number = 24): Promise<void> {
    // 清理临时文件，而不是缓存
    const now = Date.now();
    const maxAge = hours * 60 * 60 * 1000;

    try {
      const files = await fs.promises.readdir(this.tempDir);
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stats = await fs.promises.stat(filePath);
        if (now - stats.mtimeMs > maxAge) {
          await fs.promises.unlink(filePath);
          console.log(`[music] Cleaned old temp file: ${file}`);
        }
      }
    } catch (error) {
      console.error("[music] Clean temp files error:", error);
    }
  }
}

// ==================== Main Plugin ====================
class MusicPlugin extends Plugin {
  private static initialized = false;
  private downloader: Downloader;

  async initialize(): Promise<void> {
    if (MusicPlugin.initialized) return;

    console.log("[music] 初始化 Music Plugin...");

    // 检查并安装依赖
    const depsInstalled = await DependencyManager.checkAndInstallDependencies();
    if (!depsInstalled) {
      console.error("[music] 依赖安装失败");
    }

    // 检查 yt-dlp
    const ytdlpAvailable = await DependencyManager.checkYtDlp();
    if (!ytdlpAvailable) {
      console.warn("[music] yt-dlp 未安装，请手动安装: pip install yt-dlp");
    }

    const ffmpegInstalled = await DependencyManager.checkFfmpeg();
    if (!ffmpegInstalled) {
      console.warn("[music] ffmpeg 未安装，音频转换功能受限");
    }

    MusicPlugin.initialized = true;
  }

  public name = "music";
  public description: string;
  public cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>>;

  constructor() {
    super();
    this.description = `🎵 <b>音乐下载助手</b>

<b>使用方法：</b>
<code>${commandName} 周杰伦 晴天</code> - 搜索下载
<code>${commandName} https://...</code> - 链接下载

<b>配置管理：</b>
<code>${commandName} config</code> - 查看当前配置
<code>${commandName} set cookie [值]</code> - 设置YouTube Cookie
<code>${commandName} set proxy [地址]</code> - 设置代理服务器
<code>${commandName} set api_key [密钥]</code> - 设置Gemini API Key
<code>${commandName} set base_url [地址]</code> - 设置Gemini Base URL
<code>${commandName} set model [模型]</code> - 设置Gemini模型
<code>${commandName} set quality [音质]</code> - 自定义音频质量 (如: 320k / 192k / 0..10)
<code>${commandName} clear</code> - 清理临时文件

<b>配置说明：</b>
• <code>cookie</code> - 绕过地区限制，提升下载成功率
• <code>proxy</code> - 网络代理地址 (如: socks5://127.0.0.1:1080)
• <code>quality</code> - 音质：支持 <code>320k/256k/192k/128k</code> 等比特率，或 <code>0..10</code> (VBR，数字越小越好)

<b>解决YouTube访问问题：</b>

🚀 <b>方案1 - WARP+ (推荐)：</b>
<pre>wget -N https://gitlab.com/fscarmen/warp/-/raw/main/menu.sh && bash menu.sh e</pre>

🔧 <b>方案2 - WireProxy：</b>
<pre># 安装 WireProxy
wget -N https://gitlab.com/fscarmen/warp/-/raw/main/menu.sh && bash menu.sh w

# 配置代理（WireProxy 默认端口 40000）
${commandName} set proxy socks5://127.0.0.1:40000</pre>

💡 <i>直接输入歌名即可快速搜索下载</i>`;

    this.downloader = new Downloader();
    this.downloader.cleanCache().catch(() => {});

    // 注册命令处理器
    this.cmdHandlers = {
      music: this.execute.bind(this),
    };
  }

  async execute(msg: Api.Message): Promise<void> {
    const args = msg.text?.split(" ").slice(1) || [];

    if (!args.length || args[0] === "help") {
      // 编辑原消息而不是回复
      await msg.edit({ text: this.description, parseMode: "html" });
      return;
    }

    const command = args[0].toLowerCase();

    switch (command) {
      case "config":
        await this.handleConfig(msg);
        break;

      case "set":
        await this.handleSet(msg, args.slice(1));
        break;

      case "clear":
        await this.handleClear(msg);
        break;

      default:
        await this.handleDownload(msg, args.join(" "));
    }
  }

  private async handleConfig(msg: Api.Message): Promise<void> {
    const cookie = await ConfigManager.get(CONFIG.KEYS.COOKIE);
    const proxy = await ConfigManager.get(CONFIG.KEYS.PROXY);
    const apiKey = await ConfigManager.get(CONFIG.KEYS.API);
    const baseUrl = await ConfigManager.get(CONFIG.KEYS.BASE_URL);
    const model = await ConfigManager.get(CONFIG.KEYS.MODEL);
    const quality = await ConfigManager.get(CONFIG.KEYS.AUDIO_QUALITY);

    const status = `⚙️ <b>当前配置</b>

${cookie ? "✅" : "⚪"} <b>Cookie:</b> ${cookie ? "已设置" : "未设置"}
${proxy ? "✅" : "⚪"} <b>代理:</b> ${proxy ? Utils.escape(proxy) : "未配置"}
${apiKey ? "✅" : "⚪"} <b>AI搜索:</b> ${apiKey ? "已启用" : "未配置"}
🎚️ <b>音频质量:</b> <code>${Utils.escape(quality || "自动(最佳可用)")}</code>
🔧 <b>Gemini Base URL:</b> <code>${Utils.escape(baseUrl || "")}</code>
🧠 <b>Gemini Model:</b> <code>${Utils.escape(model || "")}</code>

💡 <i>使用 <code>${commandName} set [配置项] [值]</code> 修改配置</i>`;

    // 编辑原消息而不是回复
    await msg.edit({ text: status, parseMode: "html" });
  }

  private async handleSet(msg: Api.Message, args: string[]): Promise<void> {
    if (args.length < 2) {
      // 编辑原消息而不是回复
      await msg.edit({
        text: `❌ <b>参数不足</b>

<b>正确格式：</b>
<code>${commandName} set cookie [YouTube Cookie]</code>
<code>${commandName} set proxy [代理地址]</code>
<code>${commandName} set api_key [Gemini API密钥]</code>
<code>${commandName} set base_url [Gemini Base URL]</code>
<code>${commandName} set model [Gemini 模型]</code>
<code>${commandName} set quality [音质]</code>

<b>代理配置示例：</b>
<code>${commandName} set proxy socks5://127.0.0.1:1080</code>
<code>${commandName} set proxy http://127.0.0.1:8080</code>
<code>${commandName} set proxy socks5://127.0.0.1:40000</code> (WireProxy)

<b>音质示例：</b>
<code>${commandName} set quality 320k</code>
<code>${commandName} set quality 192k</code>
<code>${commandName} set quality 0</code> (VBR 最高质量)`,
        parseMode: "html",
      });
      return;
    }

    const [rawKey, ...valueParts] = args;
    const value = valueParts.join(" ");

    // 将用户友好键映射为内部存储键
    const keyMap: Record<string, string> = {
      cookie: CONFIG.KEYS.COOKIE,
      proxy: CONFIG.KEYS.PROXY,
      api_key: CONFIG.KEYS.API,
      base_url: CONFIG.KEYS.BASE_URL,
      baseurl: CONFIG.KEYS.BASE_URL,
      model: CONFIG.KEYS.MODEL,
      quality: CONFIG.KEYS.AUDIO_QUALITY,
    };
    const normalized = keyMap[rawKey.toLowerCase()] || rawKey;

    // 针对音质做输入规范化与校验
    let finalValue = value;
    if (normalized === CONFIG.KEYS.AUDIO_QUALITY) {
      const v = value.trim().toLowerCase();
      // 接受 0..10 或 Xk / Xkbps / Xkb
      const vbrMatch = /^(?:[0-9]|10)$/.test(v);
      const kbpsMatch = /^(\d{2,3})\s*(k|kb|kbps)?$/.exec(v);
      if (vbrMatch) {
        finalValue = v; // VBR 等级
      } else if (kbpsMatch) {
        // 规范化为 128k 格式
        const kb = parseInt(kbpsMatch[1], 10);
        if ([64, 96, 128, 160, 192, 256, 320].includes(kb)) {
          finalValue = `${kb}k`;
        } else {
          await msg.edit({
            text: `❌ <b>音质无效</b>\n\n支持 <code>0..10</code> 或 <code>128k/192k/256k/320k</code>`,
            parseMode: "html",
          });
          return;
        }
      } else if (v === "" || v === "auto" || v === "best") {
        // 清空 = 自动(最佳可用)
        finalValue = "";
      } else {
        await msg.edit({
          text: `❌ <b>音质无效</b>\n\n支持 <code>0..10</code> 或 <code>128k/192k/256k/320k</code>`,
          parseMode: "html",
        });
        return;
      }
    }

    const success = await ConfigManager.set(normalized, finalValue);

    if (success) {
      // 根据不同的配置项给出友好提示
      let successMsg = `✅ <b>配置已更新</b>\n\n`;

      switch (rawKey.toLowerCase()) {
        case "cookie":
          successMsg += `🍪 YouTube Cookie 已设置\n现在可以绕过地区限制了`;
          break;
        case "proxy":
          successMsg += `🌐 代理服务器已配置\n地址: <code>${Utils.escape(
            value
          )}</code>`;
          break;
        case "api_key":
          successMsg += `🤖 AI 搜索功能已启用\n可以更智能地搜索音乐了`;
          break;
        case "base_url":
        case "baseurl":
          successMsg += `🔧 Gemini Base URL 已设置\n地址: <code>${Utils.escape(
            value
          )}</code>`;
          break;
        case "model":
          successMsg += `🧠 Gemini 模型已设置\n模型: <code>${Utils.escape(
            value
          )}</code>`;
          break;
        case "quality":
          successMsg += `🎚️ 音质已设置\n当前: <code>${Utils.escape(
            finalValue || "自动(最佳可用)"
          )}</code>`;
          break;
        default:
          successMsg += `<code>${Utils.escape(rawKey)}</code> 已成功设置`;
      }

      await msg.edit({
        text: successMsg,
        parseMode: "html",
      });
    } else {
      await msg.edit({
        text: `❌ <b>配置失败</b>\n\n无法设置 <code>${Utils.escape(
          rawKey
        )}</code>`,
        parseMode: "html",
      });
    }
  }

  private async handleClear(msg: Api.Message): Promise<void> {
    // 编辑原消息而不是回复
    await msg.edit({
      text: "🧹 <b>正在清理...</b>",
      parseMode: "html",
    });

    await this.downloader.cleanCache(0);

    await msg.edit({
      text: "✨ <b>清理完成</b>\n\n临时文件已全部删除",
      parseMode: "html",
    });
  }

  private async handleDownload(msg: Api.Message, query: string): Promise<void> {
    // 确保插件已初始化
    await this.initialize();

    const client = await getGlobalClient();
    if (!client) {
      // 编辑原消息而不是回复
      await msg.edit({ text: "❌ <b>客户端未初始化</b>", parseMode: "html" });
      return;
    }

    // 检查 yt-dlp 是否可用
    const ytdlpAvailable = await DependencyManager.checkYtDlp();
    if (!ytdlpAvailable) {
      await msg.edit({
        text: "❌ <b>缺少必要组件</b>\n\n请安装 yt-dlp：\n<code>pip install yt-dlp</code>",
        parseMode: "html",
      });
      return;
    }

    // Check dependencies
    const deps = await this.downloader.checkDependencies();
    if (!deps.ytdlp) {
      await msg.edit({
        text: "❌ <b>缺少下载器</b>\n\n请先安装 yt-dlp",
        parseMode: "html",
      });
      return;
    }

    // 先编辑原消息显示处理中
    await msg.edit({
      text: "🎵 <b>处理中...</b>",
      parseMode: "html",
    });

    // 创建一个状态消息用于后续更新
    const statusMsg = msg;

    try {
      let url: string | null = null;
      let metadata: SongInfo | undefined;

      // Check if input is URL
      if (query.includes("youtube.com") || query.includes("youtu.be")) {
        url = query;
      } else {
        // 解析查询获取元数据（可能使用 AI）
        metadata = await this.parseQuery(query);
        console.log(
          `[music] 查询解析结果: ${metadata.artist} - ${metadata.title}`
        );

        // 显示AI识别结果
        const recognitionText = metadata.album
          ? `${metadata.artist} - ${metadata.title} - ${metadata.album}`
          : `${metadata.artist} - ${metadata.title}`;

        await statusMsg.edit({
          text: `🤖 <b>AI 识别结果:</b> ${Utils.escape(recognitionText)}`,
          parseMode: "html",
        });

        // 使用 yt-dlp 搜索，加入"動態歌詞"关键词
        const searchQuery = `${recognitionText} 動態歌詞`;
        url = await this.downloader.search(searchQuery, metadata.duration);
      }

      if (!url) {
        await statusMsg.edit({
          text: "😔 <b>未找到相关音乐</b>\n\n请尝试更换关键词",
          parseMode: "html",
        });
        return;
      }

      // Download
      await statusMsg.edit({
        text: `⬇️ <b>下载中...</b>`,
        parseMode: "html",
      });

      // 传递元数据给下载器
      console.log(
        `[music] 开始下载，元数据: ${metadata?.artist || "无"} - ${
          metadata?.title || "无"
        }`
      );
      const downloadResult = await this.downloader.download(url, metadata);

      if (!downloadResult.audioPath) {
        await statusMsg.edit({
          text: `❌ <b>下载失败</b>\n\n请检查链接或稍后重试`,
          parseMode: "html",
        });
        return;
      }

      // Upload
      await statusMsg.edit({
        text: `📤 <b>上传中...</b>`,
        parseMode: "html",
      });

      const stats = await fs.promises.stat(downloadResult.audioPath);

      // 准备发送参数
      const fileName = path.basename(downloadResult.audioPath);
      const sendParams: any = {
        file: downloadResult.audioPath,
        replyTo: msg.id,
        forceDocument: false, // 作为音频发送而不是文档
        // 不添加 caption，只发送音频文件
        attributes: [
          new Api.DocumentAttributeAudio({
            voice: false,
            duration: metadata?.duration
              ? Math.max(0, Math.floor(metadata.duration))
              : 0,
            title: metadata?.title || "Audio",
            performer: metadata?.artist || "Unknown Artist",
            waveform: undefined,
          }),
          new Api.DocumentAttributeFilename({
            fileName: fileName,
          }),
        ],
      };

      // 如果有缩略图，添加到发送参数中
      if (
        downloadResult.thumbnailPath &&
        fs.existsSync(downloadResult.thumbnailPath)
      ) {
        sendParams.thumb = downloadResult.thumbnailPath;
      }

      // 发送音频文件，元数据和缩略图已嵌入
      await client.sendFile(msg.chatId!, sendParams);

      // 删除状态消息
      await statusMsg.delete();

      // 清理临时文件
      setTimeout(() => {
        try {
          if (
            downloadResult.audioPath &&
            fs.existsSync(downloadResult.audioPath)
          ) {
            fs.unlinkSync(downloadResult.audioPath);
          }
          if (
            downloadResult.thumbnailPath &&
            fs.existsSync(downloadResult.thumbnailPath)
          ) {
            fs.unlinkSync(downloadResult.thumbnailPath);
          }
        } catch (error) {
          console.log("[music] 清理临时文件失败:", error);
        }
      }, 5000);
    } catch (error: any) {
      if (statusMsg) {
        await statusMsg.edit({
          text: `❌ <b>Error:</b> ${Utils.escape(
            error.message || "Unknown error"
          )}`,
          parseMode: "html",
        });
      }
    }
  }

  private async parseQuery(query: string): Promise<SongInfo> {
    // 改进的查询解析，支持多种格式
    // 格式1: "歌手 - 歌名"
    // 格式2: "歌名 歌手"
    // 格式3: "歌名"

    // 尝试解析 "歌手 - 歌名" 格式
    if (query.includes(" - ")) {
      const parts = query.split(" - ");
      return {
        artist: parts[0].trim(),
        title: parts[1].trim(),
        album: parts[2]?.trim(), // 支持 "歌手 - 歌名 - 专辑" 格式
      };
    }

    // 尝试使用 AI 解析（如果配置了 API key）
    const apiKey = await ConfigManager.get(CONFIG.KEYS.API);
    if (apiKey) {
      try {
        console.log("[music] 使用 AI 解析歌曲信息...");
        const baseUrl = await ConfigManager.get(CONFIG.KEYS.BASE_URL);
        const gemini = new GeminiClient(apiKey, baseUrl);
        const aiResponse = await gemini.searchMusic(query);
        const songInfo = await extractSongInfo(aiResponse, query);
        console.log(
          `[music] AI 识别结果: ${songInfo.artist} - ${songInfo.title}${
            songInfo.album ? " - " + songInfo.album : ""
          }`
        );
        return songInfo;
      } catch (error) {
        console.log("[music] AI 解析失败，使用默认解析:", error);
      }
    } else {
      console.log("[music] 未配置 Gemini API，使用默认解析");
    }

    // 默认解析
    return {
      title: query,
      artist: "Unknown Artist",
    };
  }
}

export default new MusicPlugin();

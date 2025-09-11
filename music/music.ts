/**
 * Music downloader plugin for TeleBox
 *
 * Provides YouTube music search and download functionality with native TeleBox integration.
 * Enhanced with Gemini AI for intelligent music metadata extraction.
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
import { exec } from "child_process";
import { promisify } from "util";
import * as https from "https";
import * as http from "http";
import { JSONFilePreset } from "lowdb/node";

const pluginName = "music";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const commandName = `${mainPrefix}${pluginName}`;

const filePath = path.join(
  createDirectoryInAssets(`${pluginName}`),
  `${pluginName}_config.json`
);
type MusicDB = Record<string, any>;
async function getDB() {
  const db = await JSONFilePreset<MusicDB>(filePath, {});
  return db;
}
function getArgFromMsg(msg: Api.Message | string, n: number): string {
  return (typeof msg === "string" ? msg : msg?.message || "")
    .replace(new RegExp(`^\\S+${Array(n).fill("\\s+\\S+").join("")}`), "")
    .trim();
}
const execAsync = promisify(exec);

// Gemini 与 yt-dlp 配置键
const GEMINI_CONFIG_KEYS = {
  API_KEY: "music_gemini_api_key",
  BASE_URL: "music_gemini_base_url",
  MODEL: "music_gemini_model",
} as const;
const YTDLP_CONFIG_KEYS = {
  COOKIE: "music_ytdlp_cookie",
} as const;

// 默认配置
const GEMINI_DEFAULT_CONFIG = {
  [GEMINI_CONFIG_KEYS.BASE_URL]: "https://generativelanguage.googleapis.com",
  [GEMINI_CONFIG_KEYS.MODEL]: "gemini-2.0-flash",
};

// Gemini 配置管理器 (lowdb)
class GeminiConfigManager {
  static async get(key: string, defaultValue?: string): Promise<string> {
    try {
      const db = await getDB();
      const val = db.data[key];
      if (val !== undefined && val !== "") return String(val);
    } catch (error) {
      console.error("[music] 读取配置失败:", error);
    }
    return (
      defaultValue ??
      (GEMINI_DEFAULT_CONFIG as Record<string, string>)[key] ??
      ""
    );
  }

  static async set(key: string, value: string): Promise<void> {
    try {
      const db = await getDB();
      db.data[key] = value;
      await db.write();
    } catch (error) {
      console.error("[music] 保存配置失败:", error);
    }
  }
}

// HTTP 客户端
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

// Gemini 客户端
class GeminiClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string | null) {
    this.apiKey = apiKey;
    this.baseUrl =
      baseUrl ?? GEMINI_DEFAULT_CONFIG[GEMINI_CONFIG_KEYS.BASE_URL];
  }

  async searchMusic(query: string): Promise<string> {
    const model = await GeminiConfigManager.get(GEMINI_CONFIG_KEYS.MODEL);
    const url = `${this.baseUrl}/v1beta/models/${model}:generateContent`;

    // 内置提示词，专门用于音乐元数据提取
    const systemPrompt = `你是一个专业的音乐信息助手。用户会提供歌曲相关的查询，你需要返回准确的歌曲元数据信息。
请严格按照以下格式返回信息，不要包含任何其他内容：

歌曲名: [歌曲名称]
歌手: [演唱者姓名]
专辑: [专辑名称]
发行时间: [发行日期]
流派: [音乐流派]

如果某些信息不确定，请使用"未知"。请确保返回最广为人知的版本信息。`;

    const userPrompt = `${query} 这首歌曲最火的演唱者，以及一些歌曲元数信息，要能够写入歌曲的格式，不允许有其他信息`;

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
      generationConfig: {},
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

// 从 Gemini 响应中提取歌曲信息
function extractSongInfo(geminiResponse: string): {
  title: string;
  artist: string;
  album?: string;
  date?: string;
  genre?: string;
} {
  const lines = geminiResponse.split("\n");
  let title = "";
  let artist = "";
  let album = "";
  let date = "";
  let genre = "";

  for (const line of lines) {
    if (line.includes("歌曲名:") || line.includes("歌曲名：")) {
      title = line.replace(/歌曲名[:：]\s*/, "").trim();
    } else if (line.includes("歌手:") || line.includes("歌手：")) {
      artist = line.replace(/歌手[:：]\s*/, "").trim();
    } else if (line.includes("专辑:") || line.includes("专辑：")) {
      album = line.replace(/专辑[:：]\s*/, "").trim();
    } else if (line.includes("发行时间:") || line.includes("发行时间：")) {
      date = line.replace(/发行时间[:：]\s*/, "").trim();
    } else if (line.includes("流派:") || line.includes("流派：")) {
      genre = line.replace(/流派[:：]\s*/, "").trim();
    }
  }

  // 如果没有找到，尝试其他格式
  if (!title && geminiResponse.includes("《")) {
    const match = geminiResponse.match(/《([^》]+)》/);
    if (match) title = match[1];
  }

  return {
    title: title || "未知歌曲",
    artist: artist || "未知歌手",
    album: album && album !== "未知" ? album : undefined,
    date: date && date !== "未知" ? date : undefined,
    genre: genre && genre !== "未知" ? genre : undefined,
  };
}

// 检测并自动安装依赖工具
async function checkAndInstallDependencies(
  msg?: Api.Message
): Promise<{ ytdlp: boolean; ffmpeg: boolean }> {
  const result = { ytdlp: false, ffmpeg: false };

  // 检测 yt-dlp - 尝试多种方式
  try {
    await execAsync("yt-dlp --version");
    result.ytdlp = true;
  } catch {
    try {
      // 尝试 Python 模块方式
      await execAsync("python -m yt_dlp --version");
      result.ytdlp = true;
    } catch {
      try {
        // 尝试 Python3 模块方式
        await execAsync("python3 -m yt_dlp --version");
        result.ytdlp = true;
      } catch {
        console.log("[music] yt-dlp not found, attempting to install...");

        // 尝试自动安装 yt-dlp
        if (msg) {
          await msg.edit({
            text: "🔧 <b>正在自动安装 yt-dlp...</b>\n\n⏳ 请稍候，首次运行需要安装依赖",
            parseMode: "html",
          });
        }

        try {
          // 尝试使用 pip3 安装
          await execAsync("pip3 install -U yt-dlp --break-system-packages", {
            timeout: 60000,
          });
          console.log("[music] yt-dlp installed successfully via pip3");
          result.ytdlp = true;
        } catch {
          try {
            // 如果失败，尝试不带 --break-system-packages
            await execAsync("pip3 install -U yt-dlp", { timeout: 60000 });
            console.log(
              "[music] yt-dlp installed successfully via pip3 (without break-system-packages)"
            );
            result.ytdlp = true;
          } catch (error) {
            console.error("[music] Failed to install yt-dlp:", error);
          }
        }
      }
    }
  }

  // 检测 FFmpeg
  try {
    await execAsync("ffmpeg -version");
    result.ffmpeg = true;
  } catch {
    console.log("[music] FFmpeg not found, attempting to install...");

    // 尝试自动安装 FFmpeg
    if (msg) {
      await msg.edit({
        text: "🔧 <b>正在自动安装 FFmpeg...</b>\n\n⏳ 音频转换需要此组件",
        parseMode: "html",
      });
    }

    try {
      // 检测系统类型并安装
      if (process.platform === "linux") {
        try {
          // 尝试使用 apt (Debian/Ubuntu)
          await execAsync("sudo apt update && sudo apt install -y ffmpeg", {
            timeout: 120000,
          });
          console.log("[music] FFmpeg installed successfully via apt");
          result.ffmpeg = true;
        } catch {
          try {
            // 尝试使用 yum (CentOS/RHEL)
            await execAsync("sudo yum install -y ffmpeg", { timeout: 120000 });
            console.log("[music] FFmpeg installed successfully via yum");
            result.ffmpeg = true;
          } catch {
            console.log("[music] Could not install FFmpeg automatically");
          }
        }
      } else if (process.platform === "darwin") {
        // macOS
        try {
          await execAsync("brew install ffmpeg", { timeout: 120000 });
          console.log("[music] FFmpeg installed successfully via brew");
          result.ffmpeg = true;
        } catch {
          console.log("[music] Could not install FFmpeg via brew");
        }
      } else if (process.platform === "win32") {
        // Windows
        try {
          await execAsync("winget install ffmpeg", { timeout: 120000 });
          console.log("[music] FFmpeg installed successfully via winget");
          result.ffmpeg = true;
        } catch {
          console.log("[music] Could not install FFmpeg via winget");
        }
      }
    } catch (error) {
      console.error("[music] Failed to install FFmpeg:", error);
    }
  }

  // 如果成功安装了依赖，显示成功消息
  if (msg && result.ytdlp && result.ffmpeg) {
    await msg.edit({
      text: "✅ <b>依赖安装完成</b>\n\n🎵 音乐下载器已准备就绪",
      parseMode: "html",
    });
    await new Promise((resolve) => setTimeout(resolve, 1500)); // 短暂显示成功消息
  }

  return result;
}

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

interface AudioFormat {
  format_id: string;
  ext: string;
  abr?: number;
  tbr?: number;
  acodec: string;
  vcodec?: string;
}

class MusicDownloader {
  private musicDir: string;
  private tempDir: string;

  constructor() {
    this.musicDir = createDirectoryInAssets("music_cache");
    this.tempDir = createDirectoryInTemp("music");
    this.ensureDirectories();
    // 同步 lowdb 中的 Cookie 到文件（若存在）
    this.syncCookieFromDBToFile().catch(() => {});
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.musicDir)) {
      fs.mkdirSync(this.musicDir, { recursive: true });
    }
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  safeFilename(filename: string): string {
    return filename
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50);
  }

  get tempDirPath(): string {
    return this.tempDir;
  }

  private async syncCookieFromDBToFile(): Promise<void> {
    try {
      const db = await getDB();
      const cookie = db.data[YTDLP_CONFIG_KEYS.COOKIE];
      if (cookie && typeof cookie === "string" && cookie.trim()) {
        const cookieFile = path.join(this.tempDir, "cookies.txt");
        if (!fs.existsSync(cookieFile)) {
          fs.writeFileSync(cookieFile, cookie, "utf-8");
          console.log("[music] 从 lowdb 恢复 yt-dlp Cookie");
        }
      }
    } catch (e) {
      console.debug("[music] 无法从 lowdb 同步 Cookie:", e);
    }
  }

  async searchYoutube(query: string): Promise<string | null> {
    try {
      // 直接使用传入的查询，不再额外添加关键词
      const searchQuery = query;

      // 尝试多种调用方式
      const commands = [
        `yt-dlp "ytsearch:${searchQuery}" --get-id --no-playlist --no-warnings`,
        `python -m yt_dlp "ytsearch:${searchQuery}" --get-id --no-playlist --no-warnings`,
        `python3 -m yt_dlp "ytsearch:${searchQuery}" --get-id --no-playlist --no-warnings`,
      ];

      let stdout = "";
      for (const cmd of commands) {
        try {
          const result = await execAsync(cmd);
          stdout = result.stdout;
          break;
        } catch {
          continue;
        }
      }

      const videoId = stdout.trim();
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
      return null;
    } catch (error) {
      console.error("YouTube search failed:", error);
      return null;
    }
  }

  async downloadAudio(
    url: string,
    outputPath: string,
    metadata?: {
      title?: string;
      artist?: string;
      album?: string;
      date?: string;
      genre?: string;
    }
  ): Promise<boolean> {
    try {
      const cookieFile = path.join(this.tempDir, "cookies.txt");
      // 若本地 cookies.txt 不存在，则尝试从 lowdb 恢复
      if (!fs.existsSync(cookieFile)) {
        try {
          const db = await getDB();
          const cookie = db.data[YTDLP_CONFIG_KEYS.COOKIE];
          if (cookie && typeof cookie === "string" && cookie.trim()) {
            fs.writeFileSync(cookieFile, cookie, "utf-8");
            console.log("[music] 已从 lowdb 写入 cookies.txt");
          }
        } catch (e) {
          console.debug("[music] 恢复 Cookie 失败:", e);
        }
      }
      let cookieArg = "";

      if (fs.existsSync(cookieFile)) {
        cookieArg = `--cookies "${cookieFile}"`;
      }

      // 构建元数据参数
      let metadataArgs = "";
      if (metadata) {
        // 清洗元数据，移除可能导致问题的字符
        const cleanValue = (val: string) =>
          val.replace(/"/g, "").replace(/'/g, "").replace(/\\/g, "");

        if (metadata.title) {
          metadataArgs += ` --postprocessor-args "-metadata title='${cleanValue(
            metadata.title
          )}'"`;
        }
        if (metadata.artist) {
          metadataArgs += ` --postprocessor-args "-metadata artist='${cleanValue(
            metadata.artist
          )}'"`;
        }
        if (metadata.album) {
          metadataArgs += ` --postprocessor-args "-metadata album='${cleanValue(
            metadata.album
          )}'"`;
        }
        if (metadata.date) {
          metadataArgs += ` --postprocessor-args "-metadata date='${cleanValue(
            metadata.date
          )}'"`;
        }
        if (metadata.genre) {
          metadataArgs += ` --postprocessor-args "-metadata genre='${cleanValue(
            metadata.genre
          )}'"`;
        }
      }

      // 添加缩略图参数
      const thumbnailArgs =
        " --embed-thumbnail --write-thumbnail --convert-thumbnails jpg";

      // Try multiple command formats
      const commands = [
        `yt-dlp "${url}" -f "bestaudio[ext=m4a]/bestaudio/best[height<=480]" -x --audio-format mp3 --audio-quality 0 --embed-metadata --add-metadata${thumbnailArgs} -o "${outputPath}" --no-playlist --no-warnings ${cookieArg}${metadataArgs}`,
        `python -m yt_dlp "${url}" -f "bestaudio[ext=m4a]/bestaudio/best[height<=480]" -x --audio-format mp3 --audio-quality 0 --embed-metadata --add-metadata${thumbnailArgs} -o "${outputPath}" --no-playlist --no-warnings ${cookieArg}${metadataArgs}`,
        `python3 -m yt_dlp "${url}" -f "bestaudio[ext=m4a]/bestaudio/best[height<=480]" -x --audio-format mp3 --audio-quality 0 --embed-metadata --add-metadata${thumbnailArgs} -o "${outputPath}" --no-playlist --no-warnings ${cookieArg}${metadataArgs}`,
      ];

      let success = false;
      for (const cmd of commands) {
        try {
          console.log(`Trying: ${cmd.split(" ")[0]}...`);
          await execAsync(cmd);
          success = true;
          break;
        } catch {
          continue;
        }
      }

      if (!success) {
        return false;
      }

      // Find the downloaded file (should be .mp3 now)
      const baseFileName = path.basename(outputPath).replace(".%(ext)s", "");
      const outputDir = path.dirname(outputPath);
      const files = fs
        .readdirSync(outputDir)
        .filter((f) => f.startsWith(baseFileName) && f.endsWith(".mp3"));

      if (files.length > 0) {
        console.log(`Downloaded audio file: ${files[0]}`);
        return true;
      }

      // Fallback: check for any audio files with similar name
      const allFiles = fs
        .readdirSync(outputDir)
        .filter(
          (f) =>
            f.includes(baseFileName.substring(0, 10)) &&
            (f.endsWith(".mp3") ||
              f.endsWith(".m4a") ||
              f.endsWith(".webm") ||
              f.endsWith(".opus"))
        );

      if (allFiles.length > 0) {
        console.log(`Found fallback audio file: ${allFiles[0]}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error("Audio download failed:", error);
      return false;
    }
  }

  async saveAudioLocally(
    tempFile: string,
    title: string,
    artist: string
  ): Promise<string> {
    const safeTitle = this.safeFilename(title);
    const safeArtist = this.safeFilename(artist);
    const filename = `${safeArtist}_${safeTitle}.mp3`;
    const targetPath = path.join(this.musicDir, filename);

    // Copy file to music directory
    fs.copyFileSync(tempFile, targetPath);

    return targetPath;
  }

  async setCookie(cookieContent: string): Promise<boolean> {
    try {
      const cookieFile = path.join(this.tempDir, "cookies.txt");
      fs.writeFileSync(cookieFile, cookieContent, "utf-8");
      // 同步到 lowdb 持久化
      const db = await getDB();
      db.data[YTDLP_CONFIG_KEYS.COOKIE] = cookieContent;
      await db.write();
      return true;
    } catch (error) {
      console.error("Failed to set cookie:", error);
      return false;
    }
  }

  cleanupTempFiles(pattern?: string): void {
    try {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        // Skip cookies.txt
        if (file === "cookies.txt") continue;

        // If pattern provided, only delete matching files
        if (pattern && !file.includes(pattern)) continue;

        const filePath = path.join(this.tempDir, file);
        try {
          fs.unlinkSync(filePath);
          console.debug(`Cleaned up: ${file}`);
        } catch (err) {
          console.debug(`Failed to delete ${file}:`, err);
        }
      }
    } catch (error) {
      console.debug("Error cleaning temp files:", error);
    }
  }
}

// Global downloader instance
const downloader = new MusicDownloader();

// 帮助文档
const help_text = `🎵 <b>YouTube 音乐下载器</b>

<b>📝 功能描述:</b>
智能搜索下载 YouTube 高品质音频

<b>🔧 使用方法:</b>
• <code>${mainPrefix}music &lt;关键词&gt;</code> - 搜索下载音乐
• <code>${mainPrefix}music &lt;YouTube链接&gt;</code> - 直接下载
• <code>${mainPrefix}music save</code> - 保存音频到本地
• <code>${mainPrefix}music cookie &lt;内容&gt;</code> - 设置Cookie
• <code>${mainPrefix}music clear</code> - 清理临时文件
• <code>${mainPrefix}music apikey &lt;密钥&gt;</code> - 设置Gemini API Key
• <code>${mainPrefix}music model &lt;名称&gt;</code> - 设置Gemini模型
• <code>${mainPrefix}music baseurl &lt;地址&gt;</code> - 设置Gemini Base URL
• <code>${mainPrefix}music config</code> - 查看当前配置
• <code>${mainPrefix}music help</code> - 显示帮助

<b>💡 示例:</b>
• <code>${mainPrefix}music 美人鱼 林俊杰</code>
• <code>${mainPrefix}music 周杰伦 晴天</code>

<b>🌐 网络加速:</b>
<code>wget -N https://gitlab.com/fscarmen/warp/-/raw/main/menu.sh && bash menu.sh e</code>`;

class MusicPlugin extends Plugin {
  description: string = help_text;

  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    music: async (msg: Api.Message, trigger?: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      // 参数解析（严格按acron.ts模式）
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();

      try {
        // 无参数时显示错误提示
        if (!sub) {
          await msg.edit({
            text: `❌ <b>缺少参数</b>\n\n🎯 <b>快速开始：</b>\n• <code>${mainPrefix}music 歌手名 歌曲名</code>\n• <code>${mainPrefix}music help</code> 查看完整说明\n\n💡 <b>提示：</b> 支持中英文搜索和 YouTube 链接`,
            parseMode: "html",
          });
          return;
        }

        // 明确请求帮助时才显示
        if (sub === "help" || sub === "h") {
          await msg.edit({
            text: help_text,
            parseMode: "html",
          });
          return;
        }

        // 保存功能
        if (sub === "save") {
          await this.handleSaveCommand(msg);
          return;
        }

        // Cookie设置功能
        if (sub === "cookie") {
          const cookieContent = getArgFromMsg(msg, 1);
          await this.handleCookieCommand(msg, cookieContent);
          return;
        }

        // Gemini API Key 设置功能
        if (sub === "apikey") {
          const apiKey = args.slice(1).join(" ").trim();
          await this.handleApiKeyCommand(msg, apiKey);
          return;
        }

        // 清理功能
        if (sub === "clear") {
          await this.handleClearCommand(msg);
          return;
        }

        // 设置 Gemini 模型
        if (sub === "model") {
          const model = args.slice(1).join(" ").trim();
          await this.handleModelCommand(msg, model);
          return;
        }

        // 设置 Gemini Base URL
        if (sub === "baseurl") {
          const url = args.slice(1).join(" ").trim();
          await this.handleBaseUrlCommand(msg, url);
          return;
        }

        // 显示配置
        if (sub === "config") {
          await this.handleConfigCommand(msg);
          return;
        }

        // 默认为音乐搜索下载
        const query = args.join(" ").trim();
        if (!query) {
          await msg.edit({
            text: `❌ <b>搜索内容为空</b>\n\n🎯 <b>正确用法：</b>\n<code>${mainPrefix}music &lt;关键词或YouTube链接&gt;</code>\n\n💡 <b>示例：</b>\n• <code>${mainPrefix}music 周杰伦 稻香</code>\n• <code>${mainPrefix}music https://youtu.be/xxxxx</code>`,
            parseMode: "html",
          });
          return;
        }

        await this.handleMusicDownload(msg, query);
      } catch (error: any) {
        console.error("[music] 插件执行失败:", error);
        const errorMsg = error.message || String(error);
        const displayError =
          errorMsg.length > 150 ? errorMsg.substring(0, 150) + "..." : errorMsg;
        await msg.edit({
          text: `❌ <b>系统异常</b>\n\n🔍 <b>错误信息:</b> <code>${htmlEscape(
            displayError
          )}</code>\n\n🛠️ <b>建议操作:</b>\n• 🔄 重新尝试操作\n• 🌐 检查网络连接\n• 🔧 确认依赖工具已安装\n• 📞 联系管理员获取技术支持`,
          parseMode: "html",
        });
      }
    },
  };

  private async handleMusicDownload(
    msg: Api.Message,
    query: string
  ): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    // 检测并自动安装依赖
    const deps = await checkAndInstallDependencies(msg);
    if (!deps.ytdlp) {
      await msg.edit({
        text: `❌ <b>依赖安装失败</b>\n\n🔧 <b>yt-dlp 需要手动安装</b>\n\n📦 <b>一键安装命令:</b>\n<code>sudo apt update && sudo apt install -y ffmpeg && pip3 install -U yt-dlp --break-system-packages</code>\n\n📦 <b>其他安装方式:</b>\n• <b>Windows:</b>\n  <code>winget install yt-dlp</code>\n• <b>macOS:</b>\n  <code>brew install yt-dlp</code>\n• <b>手动下载:</b>\n  <code>sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp</code>\n  <code>sudo chmod a+rx /usr/local/bin/yt-dlp</code>\n\n💡 <b>提示:</b> 安装后重新运行命令即可使用`,
        parseMode: "html",
      });
      return;
    }

    if (!deps.ffmpeg) {
      console.log("[music] FFmpeg not installed - MP3 conversion may not work");
      // 继续执行，但可能无法转换格式
    }

    // Check if it's a direct link
    const urlPattern =
      /https?:\/\/(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)/;
    let url: string;
    let finalSearchQuery = query;
    let songInfo: {
      title: string;
      artist: string;
      album?: string;
      date?: string;
      genre?: string;
    } | null = null;

    if (urlPattern.test(query)) {
      url = query;
    } else {
      // 尝试使用 Gemini AI 获取歌曲信息
      const apiKey = await GeminiConfigManager.get(GEMINI_CONFIG_KEYS.API_KEY);
      if (apiKey) {
        try {
          await msg.edit({
            text: "🤖 <b>AI 分析中...</b>\n\n🎵 正在识别歌曲信息",
            parseMode: "html",
          });

          const baseUrl = await GeminiConfigManager.get(
            GEMINI_CONFIG_KEYS.BASE_URL
          );
          const geminiClient = new GeminiClient(apiKey, baseUrl || undefined);
          const geminiResponse = await geminiClient.searchMusic(query);

          // 提取歌曲信息
          songInfo = extractSongInfo(geminiResponse);

          // 显示识别结果
          let infoText = `🤖 <b>AI 识别结果</b>\n\n🎵 歌曲: ${htmlEscape(
            songInfo.title
          )}\n🎤 歌手: ${htmlEscape(songInfo.artist)}`;
          if (songInfo.album)
            infoText += `\n💿 专辑: ${htmlEscape(songInfo.album)}`;
          if (songInfo.date)
            infoText += `\n📅 发行: ${htmlEscape(songInfo.date)}`;
          if (songInfo.genre)
            infoText += `\n🎭 流派: ${htmlEscape(songInfo.genre)}`;
          infoText += `\n\n🔍 正在搜索歌词版...`;

          await msg.edit({ text: infoText, parseMode: "html" });

          // 使用提取的信息构建更精准的搜索查询
          finalSearchQuery = `${songInfo.title} ${songInfo.artist} 动态歌词 歌词版`;
          console.log(`[music] AI 优化搜索: ${finalSearchQuery}`);
        } catch (error: any) {
          console.log(
            "[music] Gemini AI 处理失败，使用原始查询:",
            error.message
          );
          // 如果 AI 失败，继续使用原始查询
          await msg.edit({
            text: "🔍 <b>搜索中...</b>\n\n🎵 正在 YouTube 上查找最佳匹配",
            parseMode: "html",
          });
        }
      } else {
        // 没有设置 API Key，直接进行搜索
        await msg.edit({
          text: "🔍 <b>搜索中...</b>\n\n🎵 正在 YouTube 上查找最佳匹配",
          parseMode: "html",
        });
      }

      // Search YouTube
      const searchResult = await downloader.searchYoutube(finalSearchQuery);
      if (!searchResult) {
        await msg.edit({
          text: `❌ <b>搜索无结果</b>\n\n🔍 <b>查询内容:</b> <code>${htmlEscape(
            query
          )}</code>\n\n🛠️ <b>解决方案:</b>\n• 🤖 <b>启用AI:</b> 使用 <code>${mainPrefix}music apikey</code> 设置 Gemini API\n• 🌐 <b>网络问题:</b> 启用 WARP+ 或稳定代理\n  <code>wget -N https://gitlab.com/fscarmen/warp/-/raw/main/menu.sh && bash menu.sh e</code>\n• 🔑 <b>访问限制:</b> 使用 <code>${mainPrefix}music cookie</code> 设置 YouTube Cookie\n• 📝 <b>关键词优化:</b> 尝试"歌手名+歌曲名"格式\n• 🔄 <b>重试:</b> 稍后再次尝试搜索\n\n💡 <b>提示:</b> 某些地区需要 WARP+ 才能正常访问 YouTube`,
          parseMode: "html",
        });
        return;
      }
      url = searchResult;
    }

    await msg.edit({
      text: "📥 <b>开始下载</b>\n\n🎵 正在获取最佳音质版本...",
      parseMode: "html",
    });

    // Generate temp file path
    const safeQuery = downloader.safeFilename(query);
    const tempFile = path.join(downloader.tempDirPath, `${safeQuery}.%(ext)s`);

    // Download audio with metadata if available
    const success = await downloader.downloadAudio(
      url,
      tempFile,
      songInfo || undefined
    );
    if (!success) {
      const deps = await checkAndInstallDependencies();
      let ffmpegHint = "";
      if (!deps.ffmpeg) {
        ffmpegHint =
          "\n\n🎵 <b>FFmpeg 未安装 (音频转换可能失败):</b>\n• <code>apt install ffmpeg</code> (Linux)\n• <code>brew install ffmpeg</code> (macOS)\n• <code>winget install ffmpeg</code> (Windows)";
      }

      await msg.edit({
        text: `❌ <b>下载失败</b>\n\n🛠️ <b>常见解决方案:</b>\n• 🌐 <b>网络问题:</b> 启用 WARP+ 或更换网络环境\n  <code>wget -N https://gitlab.com/fscarmen/warp/-/raw/main/menu.sh && bash menu.sh e</code>\n• 🔑 <b>访问受限:</b> 使用 <code>${mainPrefix}music cookie &lt;Netscape格式Cookie&gt;</code>\n• 🚫 <b>内容限制:</b> 视频可能有地区/年龄限制\n• 🔄 <b>工具更新:</b> 确保 yt-dlp 为最新版本\n  <code>pip3 install -U yt-dlp --break-system-packages</code>${ffmpegHint}\n\n💡 <b>重要提示:</b>\n• YouTube 在某些地区需要 WARP+ 访问\n• Cookie 必须是 Netscape HTTP Cookie 格式\n• 建议使用官方 YouTube 链接`,
        parseMode: "html",
      });
      return;
    }

    // Find downloaded file
    const tempDir = downloader.tempDirPath;
    const files = fs.readdirSync(tempDir);

    // Look for MP3 files first, then fallback to other formats
    let downloadedFiles = files.filter(
      (file) => file.startsWith(safeQuery) && file.endsWith(".mp3")
    );

    if (downloadedFiles.length === 0) {
      // Fallback to any audio format
      downloadedFiles = files.filter(
        (file) =>
          file.startsWith(safeQuery) &&
          (file.endsWith(".m4a") ||
            file.endsWith(".webm") ||
            file.endsWith(".opus") ||
            file.endsWith(".mp3"))
      );
    }

    if (downloadedFiles.length === 0) {
      // Final fallback: look for any file containing part of the query
      downloadedFiles = files.filter(
        (file) =>
          file.includes(safeQuery.substring(0, 10)) &&
          (file.endsWith(".mp3") ||
            file.endsWith(".m4a") ||
            file.endsWith(".webm") ||
            file.endsWith(".opus"))
      );
    }

    if (downloadedFiles.length === 0) {
      await msg.edit({
        text: `❌ <b>文件处理异常</b>\n\n🔍 <b>问题分析:</b>\n• 下载过程可能被中断\n• 文件格式转换失败\n• 磁盘空间不足\n\n🛠️ <b>解决建议:</b>\n• 🔄 重新尝试下载\n• 💾 检查磁盘剩余空间\n• 🌐 确保网络连接稳定\n• 🔧 更新 yt-dlp 和 FFmpeg\n\n📊 <b>调试信息:</b>\n• 查询: <code>${htmlEscape(
          safeQuery
        )}</code>\n• 临时目录文件: <code>${htmlEscape(
          files.slice(0, 3).join(", ")
        )}${files.length > 3 ? "..." : ""}</code>`,
        parseMode: "html",
      });
      return;
    }

    const audioFile = path.join(tempDir, downloadedFiles[0]);
    console.log(`Using audio file: ${audioFile}`);

    try {
      await msg.edit({
        text: "📤 <b>准备发送</b>\n\n🎵 正在上传高品质音频文件...",
        parseMode: "html",
      });

      // 使用AI提供的元数据，如果没有AI数据则使用清洗后的默认值
      let audioTitle = query;
      let audioPerformer = "YouTube Music";

      if (songInfo) {
        // 如果有AI识别的元数据，使用它们
        audioTitle = songInfo.title;
        audioPerformer = songInfo.artist;
      } else {
        // 没有AI数据时，清洗用户输入作为歌曲名
        audioTitle = query.trim();
        audioPerformer = "YouTube Music";
      }

      // 查找缩略图文件
      const baseFileName = path.basename(audioFile, ".mp3");
      const audioDir = path.dirname(audioFile);
      const thumbJpg = path.join(audioDir, `${baseFileName}.jpg`);
      const thumbWebp = path.join(audioDir, `${baseFileName}.webp`);
      const thumbPng = path.join(audioDir, `${baseFileName}.png`);

      let thumbPath: string | undefined;
      if (fs.existsSync(thumbJpg)) {
        thumbPath = thumbJpg;
        console.log(`[music] 找到缩略图: ${thumbJpg}`);
      } else if (fs.existsSync(thumbWebp)) {
        thumbPath = thumbWebp;
        console.log(`[music] 找到缩略图: ${thumbWebp}`);
      } else if (fs.existsSync(thumbPng)) {
        thumbPath = thumbPng;
        console.log(`[music] 找到缩略图: ${thumbPng}`);
      } else {
        console.log(`[music] 未找到缩略图`);
      }

      // Send audio file with clean metadata and thumbnail
      await client.sendFile(msg.peerId, {
        file: audioFile,
        thumb: thumbPath,
        attributes: [
          new Api.DocumentAttributeAudio({
            duration: 0,
            title: audioTitle,
            performer: audioPerformer,
          }),
        ],
        replyTo: msg.replyToMsgId,
        forceDocument: false,
      });

      await msg.delete();
      console.log(`Successfully sent audio: ${query}`);
    } catch (error: any) {
      console.error("Failed to send audio:", error);
      const errorMessage = error.message || String(error);
      const displayError =
        errorMessage.length > 100
          ? errorMessage.substring(0, 100) + "..."
          : errorMessage;
      await msg.edit({
        text: `❌ <b>发送失败</b>\n\n🔍 <b>错误详情:</b> <code>${htmlEscape(
          displayError
        )}</code>\n\n🛠️ <b>可能原因:</b>\n• 📁 文件过大 (超过 Telegram 限制)\n• 🎵 音频格式不被支持\n• 🌐 网络上传中断\n• 💾 临时存储空间不足\n\n💡 <b>解决方案:</b>\n• 尝试下载较短的音频片段\n• 检查网络连接稳定性\n• 清理临时文件释放空间`,
        parseMode: "html",
      });
    } finally {
      // Cleanup temp files including thumbnails
      downloader.cleanupTempFiles(safeQuery);

      // 额外清理缩略图文件
      const tempDir = downloader.tempDirPath;
      const thumbnailPatterns = [".jpg", ".webp", ".png"];
      for (const pattern of thumbnailPatterns) {
        try {
          const files = fs
            .readdirSync(tempDir)
            .filter((f) => f.includes(safeQuery) && f.endsWith(pattern));
          for (const file of files) {
            const filePath = path.join(tempDir, file);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              console.log(`[music] 清理缩略图: ${file}`);
            }
          }
        } catch {
          // 忽略清理错误
        }
      }
    }
  }

  private async handleSaveCommand(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;

    const reply = await msg.getReplyMessage();
    if (!reply || !reply.document) {
      await msg.edit({
        text: `❌ <b>操作错误</b>\n\n🎯 <b>正确用法:</b>\n1️⃣ 回复任意音频消息\n2️⃣ 发送 <code>${mainPrefix}music save</code>\n\n💡 <b>支持格式:</b> MP3, M4A, FLAC, WAV 等\n\n📁 <b>保存位置:</b> 本地音乐收藏夹`,
        parseMode: "html",
      });
      return;
    }

    try {
      // Get file info
      let title = "Unknown";
      let artist = "Unknown";

      if (reply.document.attributes) {
        for (const attr of reply.document.attributes) {
          if (attr instanceof Api.DocumentAttributeAudio) {
            title = attr.title || "Unknown";
            artist = attr.performer || "Unknown";
            break;
          }
        }
      }

      await msg.edit({
        text: "💾 <b>保存中...</b>\n\n📁 正在添加到本地音乐收藏",
        parseMode: "html",
      });

      // Create temp file
      const tempFile = path.join(
        downloader.tempDirPath,
        `temp_save_${msg.id}.mp3`
      );

      // Download file to temp location
      await client.downloadMedia(reply, { outputFile: tempFile });

      // Save to local storage
      const savedPath = await downloader.saveAudioLocally(
        tempFile,
        title,
        artist
      );

      await msg.edit({
        text: `✅ <b>保存完成</b>\n\n📁 <b>文件信息:</b>\n• 名称: <code>${htmlEscape(
          path.basename(savedPath)
        )}</code>\n• 路径: <code>${htmlEscape(
          path.dirname(savedPath)
        )}</code>\n\n🎵 <b>音频详情:</b>\n• 标题: ${htmlEscape(
          title
        )}\n• 艺术家: ${htmlEscape(artist)}\n\n💡 文件已永久保存到本地收藏`,
        parseMode: "html",
      });
      console.log(`Audio saved to: ${savedPath}`);
    } catch (error: any) {
      console.error("Save command failed:", error);
      const errorMessage = error.message || String(error);
      const displayError =
        errorMessage.length > 100
          ? errorMessage.substring(0, 100) + "..."
          : errorMessage;
      await msg.edit({
        text: `❌ <b>保存失败</b>\n\n🔍 <b>错误详情:</b> <code>${htmlEscape(
          displayError
        )}</code>\n\n🛠️ <b>解决方案:</b>\n• 💾 检查磁盘剩余空间\n• 🔐 确认文件夹写入权限\n• 📁 检查目标路径是否存在\n• 🔄 重新尝试保存操作`,
        parseMode: "html",
      });
    } finally {
      // Cleanup temp file
      try {
        const tempFile = path.join(
          downloader.tempDirPath,
          `temp_save_${msg.id}.mp3`
        );
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private async handleCookieCommand(
    msg: Api.Message,
    cookieContent: string
  ): Promise<void> {
    if (!cookieContent) {
      await msg.edit({
        text: `❌ <b>Cookie 内容为空</b>\n\n🔑 <b>使用方法:</b>\n<code>${mainPrefix}music cookie &lt;Netscape格式Cookie&gt;</code>\n\n📋 <b>获取步骤 (推荐使用浏览器插件):</b>\n1️⃣ 登录 YouTube 网页版\n2️⃣ 安装浏览器插件 "Get cookies.txt LOCALLY"\n3️⃣ 点击插件图标，选择 "Export as Netscape"\n4️⃣ 复制导出的 Cookie 内容\n\n📝 <b>手动获取 (开发者工具):</b>\n1️⃣ 按 F12 打开开发者工具\n2️⃣ Application → Cookies → youtube.com\n3️⃣ 导出为 Netscape HTTP Cookie 格式\n\n⚠️ <b>重要:</b> 必须是 Netscape 格式，不是普通 Cookie 字符串\n💡 <b>用途:</b> 突破年龄限制、登录限制和地区限制`,
        parseMode: "html",
      });
      return;
    }

    try {
      const success = await downloader.setCookie(cookieContent);
      if (success) {
        await msg.edit({
          text: "✅ <b>Cookie 配置成功</b>\n\n🔓 <b>已解锁功能:</b>\n• 年龄受限内容访问\n• 需要登录的视频\n• 地区限制内容\n• 高清音质选项\n\n⏰ <b>有效期:</b> 持久保存 (lowdb)\n🔁 <b>重启:</b> 将自动恢复到 cookies.txt\n🔒 <b>隐私:</b> 仅本地存储，不会上传",
          parseMode: "html",
        });
      } else {
        await msg.edit({
          text: "❌ <b>Cookie 设置失败</b>\n\n🔍 <b>可能原因:</b>\n• Cookie 格式不正确\n• 包含无效字符\n• 文件写入权限不足\n\n💡 <b>建议:</b> 确保复制完整且有效的 YouTube Cookie",
          parseMode: "html",
        });
      }
    } catch (error: any) {
      console.error("Cookie command failed:", error);
      const errorMessage = error.message || String(error);
      const displayError =
        errorMessage.length > 100
          ? errorMessage.substring(0, 100) + "..."
          : errorMessage;
      await msg.edit({
        text: `❌ <b>Cookie 配置异常</b>\n\n🔍 <b>错误详情:</b> <code>${htmlEscape(
          displayError
        )}</code>\n\n🛠️ <b>解决方案:</b>\n• 检查 Cookie 格式完整性\n• 确认文件系统写入权限\n• 重新获取有效的 YouTube Cookie`,
        parseMode: "html",
      });
    }
  }

  private async handleModelCommand(
    msg: Api.Message,
    model: string
  ): Promise<void> {
    if (!model) {
      const current = await GeminiConfigManager.get(GEMINI_CONFIG_KEYS.MODEL);
      await msg.edit({
        text: `🧠 <b>Gemini 模型</b>\n\n当前: <code>${htmlEscape(
          current
        )}</code>\n\n设置: <code>${mainPrefix}music model &lt;名称&gt;</code>\n示例: <code>${mainPrefix}music model gemini-2.0-flash</code>`,
        parseMode: "html",
      });
      return;
    }
    await GeminiConfigManager.set(GEMINI_CONFIG_KEYS.MODEL, model);
    await msg.edit({
      text: `✅ <b>Gemini 模型已更新</b>\n\n🧠 当前: <code>${htmlEscape(
        model
      )}</code>`,
      parseMode: "html",
    });
  }

  private async handleBaseUrlCommand(
    msg: Api.Message,
    baseUrl: string
  ): Promise<void> {
    if (!baseUrl) {
      const current = await GeminiConfigManager.get(
        GEMINI_CONFIG_KEYS.BASE_URL
      );
      await msg.edit({
        text: `🌐 <b>Gemini Base URL</b>\n\n当前: <code>${htmlEscape(
          current
        )}</code>\n\n设置: <code>${mainPrefix}music baseurl &lt;地址&gt;</code>\n示例: <code>${mainPrefix}music baseurl https://generativelanguage.googleapis.com</code>`,
        parseMode: "html",
      });
      return;
    }

    if (!/^https?:\/\//i.test(baseUrl)) {
      await msg.edit({
        text: `❌ <b>URL 格式无效</b>\n\n示例: <code>https://generativelanguage.googleapis.com</code>`,
        parseMode: "html",
      });
      return;
    }

    await GeminiConfigManager.set(GEMINI_CONFIG_KEYS.BASE_URL, baseUrl);
    await msg.edit({
      text: `✅ <b>Base URL 已更新</b>\n\n🌐 当前: <code>${htmlEscape(
        baseUrl
      )}</code>`,
      parseMode: "html",
    });
  }

  private async handleConfigCommand(msg: Api.Message): Promise<void> {
    const apiKey = await GeminiConfigManager.get(GEMINI_CONFIG_KEYS.API_KEY);
    const baseUrl = await GeminiConfigManager.get(GEMINI_CONFIG_KEYS.BASE_URL);
    const model = await GeminiConfigManager.get(GEMINI_CONFIG_KEYS.MODEL);
    const db = await getDB();
    const hasCookie = Boolean(
      db.data[YTDLP_CONFIG_KEYS.COOKIE] &&
        String(db.data[YTDLP_CONFIG_KEYS.COOKIE]).trim()
    );

    const maskedKey = apiKey
      ? apiKey.substring(0, 8) + "..." + apiKey.substring(apiKey.length - 4)
      : "未设置";

    await msg.edit({
      text: `⚙️ <b>Music 配置</b>\n\n🤖 <b>Gemini</b>\n• API Key: <code>${htmlEscape(
        maskedKey
      )}</code>\n• Base URL: <code>${htmlEscape(
        baseUrl
      )}</code>\n• Model: <code>${htmlEscape(
        model
      )}</code>\n\n🍪 <b>yt-dlp Cookie</b>\n• 状态: ${
        hasCookie ? "<b>已配置</b>" : "<b>未配置</b>"
      }`,
      parseMode: "html",
    });
  }

  private async handleClearCommand(msg: Api.Message): Promise<void> {
    try {
      await msg.edit({
        text: "🧹 <b>清理中...</b>\n\n📁 正在清理临时下载文件",
        parseMode: "html",
      });

      // Clear temp files (preserve cookies.txt)
      downloader.cleanupTempFiles();

      await msg.edit({
        text: "✅ <b>清理完成</b>\n\n🗑️ <b>已清理:</b> 所有临时下载文件\n🔒 <b>已保留:</b> YouTube Cookie 配置\n💾 <b>已释放:</b> 磁盘存储空间\n\n💡 建议定期清理以保持最佳性能",
        parseMode: "html",
      });
      console.log("Music downloader temp files cleaned");
    } catch (error: any) {
      console.error("Clear command failed:", error);
      const errorMessage = error.message || String(error);
      const displayError =
        errorMessage.length > 100
          ? errorMessage.substring(0, 100) + "..."
          : errorMessage;
      await msg.edit({
        text: `❌ <b>清理异常</b>\n\n🔍 <b>错误详情:</b> <code>${htmlEscape(
          displayError
        )}</code>\n\n🛠️ <b>可能原因:</b>\n• 文件正在被其他程序使用\n• 缺少文件删除权限\n• 临时目录访问受限\n\n💡 <b>建议:</b> 手动清理或重启程序后重试`,
        parseMode: "html",
      });
    }
  }

  private async handleApiKeyCommand(
    msg: Api.Message,
    apiKey: string
  ): Promise<void> {
    if (!apiKey) {
      // 显示当前配置状态
      const currentKey = await GeminiConfigManager.get(
        GEMINI_CONFIG_KEYS.API_KEY
      );
      const baseUrl = await GeminiConfigManager.get(
        GEMINI_CONFIG_KEYS.BASE_URL
      );
      const model = await GeminiConfigManager.get(GEMINI_CONFIG_KEYS.MODEL);

      if (currentKey) {
        const maskedKey =
          currentKey.substring(0, 8) +
          "..." +
          currentKey.substring(currentKey.length - 4);
        await msg.edit({
          text: `🤖 <b>Gemini AI 配置</b>\n\n🔑 <b>API Key:</b> <code>${maskedKey}</code>\n🌐 <b>Base URL:</b> <code>${htmlEscape(
            baseUrl
          )}</code>\n🧠 <b>模型:</b> <code>${htmlEscape(
            model
          )}</code>\n\n✅ AI 功能已启用\n\n💡 <b>使用方法:</b>\n• 更新密钥: <code>${mainPrefix}music apikey &lt;新密钥&gt;</code>\n• 清除密钥: <code>${mainPrefix}music apikey clear</code>`,
          parseMode: "html",
        });
      } else {
        await msg.edit({
          text: `🤖 <b>Gemini AI 未配置</b>\n\n❌ 当前未设置 API Key\n\n🔧 <b>设置方法:</b>\n<code>${mainPrefix}music apikey &lt;你的API密钥&gt;</code>\n\n📝 <b>获取 API Key:</b>\n1. 访问 <a href="https://aistudio.google.com/app/apikey">Google AI Studio</a>\n2. 登录 Google 账号\n3. 点击 "Create API Key"\n4. 复制生成的密钥\n\n🎯 <b>AI 功能优势:</b>\n• 智能识别歌曲最火版本\n• 自动提取准确的歌曲信息\n• 精准搜索歌词版视频\n• 提升搜索成功率`,
          parseMode: "html",
        });
      }
      return;
    }

    // 清除 API Key
    if (apiKey.toLowerCase() === "clear") {
      await GeminiConfigManager.set(GEMINI_CONFIG_KEYS.API_KEY, "");
      await msg.edit({
        text: `✅ <b>API Key 已清除</b>\n\n🔒 Gemini AI 功能已禁用\n\n💡 重新启用: <code>${mainPrefix}music apikey &lt;密钥&gt;</code>`,
        parseMode: "html",
      });
      return;
    }

    // 验证 API Key 格式
    if (apiKey.length < 20 || !/^[A-Za-z0-9_-]+$/.test(apiKey)) {
      await msg.edit({
        text: `❌ <b>API Key 格式无效</b>\n\n🔍 <b>问题:</b> 密钥格式不正确\n\n📝 <b>正确格式:</b>\n• 长度至少 20 个字符\n• 只包含字母、数字、下划线和连字符\n\n💡 <b>提示:</b> 请从 Google AI Studio 复制完整的 API Key`,
        parseMode: "html",
      });
      return;
    }

    // 测试 API Key
    try {
      await msg.edit({
        text: "🔄 <b>验证 API Key...</b>\n\n🤖 正在连接 Gemini AI 服务",
        parseMode: "html",
      });

      const baseUrl = await GeminiConfigManager.get(
        GEMINI_CONFIG_KEYS.BASE_URL
      );
      const testClient = new GeminiClient(apiKey, baseUrl || undefined);
      await testClient.searchMusic("测试");

      // 保存配置
      await GeminiConfigManager.set(GEMINI_CONFIG_KEYS.API_KEY, apiKey);

      await msg.edit({
        text: `✅ <b>API Key 配置成功</b>\n\n🤖 Gemini AI 功能已启用\n\n🎯 <b>已解锁功能:</b>\n• 智能歌曲识别\n• 自动元数据提取\n• 精准歌词版搜索\n• AI 增强搜索\n\n💡 <b>使用示例:</b>\n<code>${mainPrefix}music 美人鱼 林俊杰</code>\n\nAI 将自动识别并搜索最佳版本！`,
        parseMode: "html",
      });
    } catch (error: any) {
      console.error("[music] API Key 验证失败:", error);
      const errorMsg = error.message || String(error);

      let errorHint = "";
      if (errorMsg.includes("403") || errorMsg.includes("401")) {
        errorHint = "\n\n🔑 可能是无效的 API Key";
      } else if (errorMsg.includes("429")) {
        errorHint = "\n\n⏱️ API 配额已用完";
      } else if (errorMsg.includes("网络")) {
        errorHint = "\n\n🌐 网络连接问题";
      }

      await msg.edit({
        text: `❌ <b>API Key 验证失败</b>\n\n🔍 <b>错误:</b> <code>${htmlEscape(
          errorMsg.substring(0, 100)
        )}</code>${errorHint}\n\n🛠️ <b>解决方案:</b>\n• 确认 API Key 正确无误\n• 检查网络连接\n• 确认 API 配额未用完\n• 重新生成新的 API Key\n\n📝 <b>获取新密钥:</b>\n<a href="https://aistudio.google.com/app/apikey">Google AI Studio</a>`,
        parseMode: "html",
      });
    }
  }
}

export default new MusicPlugin();

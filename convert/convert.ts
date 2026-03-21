import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import axios from "axios";
import Database from "better-sqlite3";
import { Converter } from "opencc-js";

const execAsync = promisify(exec);

// --- Basic Setup ---
const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";
const toSimplified = Converter({ from: "tw", to: "cn" });

const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#x27;",
  }[m] || m));

// --- Gemini AI Configuration & Client ---
const dbDir = path.join(process.cwd(), "assets", "convert");
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}
const GEMINI_CONFIG_DB_PATH = path.join(dbDir, "gemini_config.db");
const GEMINI_API_KEY = "convert_gemini_api_key";

class GeminiConfigManager {
  private static db: Database.Database;
  private static initialized = false;

  private static init(): void {
    if (this.initialized) return;
    try {
      this.db = new Database(GEMINI_CONFIG_DB_PATH);
      this.db.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      this.initialized = true;
    } catch (error) {
      console.error("[convert] Failed to initialize Gemini config DB:", error);
    }
  }

  static get(key: string): string {
    this.init();
    if (!this.db) {
        console.error("[convert] DB not initialized, cannot get config.");
        return "";
    }
    try {
      const row = this.db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
      return row ? row.value : "";
    } catch (error) {
      console.error("[convert] Failed to read config:", error);
      return "";
    }
  }

  static set(key: string, value: string): void {
    this.init();
    if (!this.db) {
        console.error("[convert] DB not initialized, cannot set config.");
        return;
    }
    try {
      this.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).run(key, value);
    } catch (error) {
      console.error("[convert] Failed to save config:", error);
    }
  }
}

class GeminiClient {
    private apiKey: string;
    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    async searchMusic(query: string): Promise<string> {
        const model = "gemini-1.5-flash-latest";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        
        const systemPrompt = toSimplified(`You are a music information expert. Return information in the following format ONLY, without any other text:

歌曲名: [Song Title]
歌手: [Artist Name]
专辑: [Album Name]

If info is unknown, use "未知".`);
        
        const userPrompt = toSimplified(`Find precise info for this song: '${query}'. Correct typos and find the most famous version. If not found, use user's query '${query}' as the song title.`);

        const requestData = {
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            tools: [{ "google_search": {} }],
        };

        try {
            const response = await axios.post(url, requestData, {
                headers: { "x-goog-api-key": this.apiKey, "Content-Type": "application/json" },
                timeout: 30000,
            });
            return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } catch (error: any) {
            const errorMsg = error.response?.data?.error?.message || error.message;
            throw new Error(`Gemini API Error: ${errorMsg}`);
        }
    }
}

// --- Helper Functions ---
interface SongInfo {
    title: string;
    artist: string;
    album: string;
}

function extractSongInfo(response: string, userInput: string): SongInfo {
    const lines = response.split('\n');
    let title = '', artist = '', album = '';
    for (const line of lines) {
        if (line.includes('歌曲名')) { title = line.split(/[:：]/)[1]?.trim(); }
        else if (line.includes('歌手')) { artist = line.split(/[:：]/)[1]?.trim(); }
        else if (line.includes('专辑')) { album = line.split(/[:：]/)[1]?.trim(); }
    }
    return {
        title: title || userInput,
        artist: artist || '未知',
        album: album || '未知',
    };
}

async function searchAndDownloadCover(query: string, savePath: string): Promise<boolean> {
    try {
        const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1`;
        const { data } = await axios.get(searchUrl);
        if (data.results && data.results.length > 0) {
            let imageUrl = data.results[0].artworkUrl100;
            if (imageUrl) {
                imageUrl = imageUrl.replace('100x100bb.jpg', '600x600bb.jpg');
                const response = await axios.get(imageUrl, { responseType: 'stream' });
                const writer = fs.createWriteStream(savePath);
                response.data.pipe(writer);
                return new Promise((resolve, reject) => {
                    writer.on('finish', () => resolve(true));
                    writer.on('error', () => reject(false));
                });
            }
        }
    } catch (error) {
        console.error("Cover search failed:", error);
    }
    return false;
}


// --- Main Converter Class ---
class VideoConverter {
  public readonly tempDir: string;

  constructor() {
    this.tempDir = path.join(process.cwd(), "temp", "convert");
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  safeFilename(filename: string): string {
    return filename
      .replace(/[^\w\s.-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 100);
  }

  async convertVideoToMp3(inputPath: string, outputPath: string): Promise<boolean> {
    try {
      const cmd = `ffmpeg -i "${inputPath}" -vn -acodec libmp3lame -q:a 2 -y "${outputPath}"`;
      await execAsync(cmd, { timeout: 300000 });
      return fs.existsSync(outputPath);
    } catch (error) {
      console.error("Video conversion failed:", error);
      return false;
    }
  }
  
  async addMetadataAndCover(inputMp3: string, outputPath: string, metadata: SongInfo, coverPath?: string): Promise<boolean> {
    try {
        let cmd = `ffmpeg -i "${inputMp3}" -c:a copy -id3v2_version 3`;
        if (coverPath) {
            cmd += ` -i "${coverPath}" -map 0:a -map 1:v -disposition:v:0 attached_pic`;
        }
        cmd += ` -metadata title="${metadata.title.replace(/"/g, '\\"')}"`;
        cmd += ` -metadata artist="${metadata.artist.replace(/"/g, '\\"')}"`;
        cmd += ` -metadata album="${metadata.album.replace(/"/g, '\\"')}"`;
        cmd += ` -y "${outputPath}"`;
        
        await execAsync(cmd, { timeout: 120000 });
        return fs.existsSync(outputPath);
    } catch (error) {
        console.error("Failed to add metadata:", error);
        return false;
    }
  }


  async getVideoDuration(filePath: string): Promise<number> {
    try {
      const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
      const { stdout } = await execAsync(cmd);
      return parseFloat(stdout.trim()) || 0;
    } catch (error) {
      console.error("Failed to get video duration:", error);
      return 0;
    }
  }

  cleanupTempFiles(...files: (string | undefined)[]): void {
    for (const file of files) {
        if (file && fs.existsSync(file)) {
            try {
                fs.unlinkSync(file);
            } catch (err) {
                console.debug(`Failed to delete temp file ${path.basename(file)}:`, err);
            }
        }
    }
  }

  cleanupAllTempFiles(): void {
    try {
        const files = fs.readdirSync(this.tempDir);
        for (const file of files) {
            fs.unlinkSync(path.join(this.tempDir, file));
        }
    } catch (error) {
        console.debug("Error cleaning up temp directory:", error);
    }
  }
}

// --- Plugin Definition ---
const converter = new VideoConverter();

const help_text = toSimplified(`🎬 <b>视频转音频 AI 助手</b>

<b>✅ 功能:</b>
 • <b>AI 智能识别:</b> 使用 <code>u</code> 参数，AI 将自动查找最匹配的歌曲元数据和封面。
 • <b>自定义文件名:</b> 不使用 <code>u</code> 参数时，可直接指定输出的 MP3 文件名。
 • <b>高质量转换:</b> 将视频的音轨转换为高质量的 MP3 文件。
 • <b>元数据嵌入:</b> AI 模式下，会自动将歌曲名、歌手、专辑和封面嵌入文件。

<b>📝 命令用法:</b>

 • <b>AI 智能转换 (推荐):</b>
   <code>${mainPrefix}convert u &lt;歌曲名&gt;</code>
   示例: <code>${mainPrefix}convert u 稻香</code>

 • <b>标准转换 (自定义文件名):</b>
   <code>${mainPrefix}convert [文件名]</code>
   示例: <code>${mainPrefix}convert 周杰伦-稻香-演唱会版</code>
   <i>注意: 如果不提供文件名，将使用视频原名。</i>

 • <b>AI 功能配置:</b>
   <code>${mainPrefix}convert apikey &lt;你的 Gemini API Key&gt;</code>
   <code>${mainPrefix}convert apikey</code> (查看当前 Key)
   <code>${mainPrefix}convert apikey clear</code> (清除 Key)

 • <b>其他命令:</b>
   <code>${mainPrefix}convert clear</code> (清理临时文件)
   `);

class ConvertPlugin extends Plugin {
  cleanup(): void {
  }

  description: string = help_text;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    convert: async (msg: Api.Message) => {
        const parts = msg.text?.trim()?.split(/\s+/) || [];
        const args = parts.slice(1);
        const subCommand = (args[0] || "").toLowerCase();

        try {
            if (subCommand === "help" || subCommand === "h" || args.length === 0 && !msg.replyTo) {
                await msg.edit({ text: help_text, parseMode: "html" });
            } else if (subCommand === "clear") {
                await this.handleClearCommand(msg);
            } else if (subCommand === "apikey") {
                await this.handleApiKeyCommand(msg, args.slice(1).join(" "));
            } else {
                await this.handleVideoConversion(msg, args);
            }
        } catch (error: any) {
            console.error("[convert] Plugin execution failed:", error);
            await msg.edit({
                text: `❌ <b>插件执行失败:</b> ${htmlEscape(error.message)}`,
                parseMode: "html"
            });
        }
    }
  };

  private async handleVideoConversion(msg: Api.Message, args: string[]): Promise<void> {
    const client = await getGlobalClient();
    const reply = await msg.getReplyMessage();

    if (!client || !reply || (!reply.document && !reply.video)) {
      await msg.edit({ text: `❌ <b>使用错误</b>\n\n请回复一个视频消息后再使用此命令。\n\n请回复一个视频消息后再试。`, parseMode: "html" });
      return;
    }
    
    const doc = reply.video || reply.document;
    const fileNameAttr = doc?.attributes?.find((a: any) => a.fileName) as Api.DocumentAttributeFilename | undefined;
    const originalFileName = fileNameAttr?.fileName || "video.mp4";

    await msg.edit({ text: "📥 正在下载视频...", parseMode: "html" });
    
    const timestamp = Date.now();
    const tempVideoPath = path.join(converter.tempDir, `${timestamp}_video`);
    const tempAudioPath = path.join(converter.tempDir, `${timestamp}.mp3`);
    let finalAudioPath = tempAudioPath;
    let tempCoverPath: string | undefined;

    try {
        await client.downloadMedia(reply, { outputFile: tempVideoPath });
        if (!fs.existsSync(tempVideoPath)) throw new Error("视频下载失败");

        await msg.edit({ text: "🔄 正在转换为 MP3...", parseMode: "html" });
        if (!await converter.convertVideoToMp3(tempVideoPath, tempAudioPath)) {
            throw new Error("视频转换失败，请检查 FFmpeg 是否已安装");
        }

        const useAi = (args[0] || "").toLowerCase() === 'u';
        const userQuery = useAi ? args.slice(1).join(' ') : args.join(' ');
        
        let audioFileName: string;
        let songInfo: SongInfo = { title: "", artist: "", album: "" };

        if (useAi && userQuery) {
            const apiKey = GeminiConfigManager.get(GEMINI_API_KEY);
            if (!apiKey) throw new Error("Gemini API Key 未设置。\n请使用 <code>${mainPrefix}convert apikey &lt;key&gt;</code> 命令设置。");

            await msg.edit({ text: "🤖 AI 正在识别歌曲信息...", parseMode: "html" });
            const gemini = new GeminiClient(apiKey);
            const aiResponse = await gemini.searchMusic(userQuery);
            songInfo = extractSongInfo(aiResponse, userQuery);

            await msg.edit({ text: `🎵 AI 识别结果:\n<b>歌名:</b> ${htmlEscape(songInfo.title)}\n<b>歌手:</b> ${htmlEscape(songInfo.artist)}\n\n正在查找封面...` , parseMode: "html"});
            
            tempCoverPath = path.join(converter.tempDir, `${timestamp}.jpg`);
            const coverFound = await searchAndDownloadCover(`${songInfo.title} ${songInfo.artist}`, tempCoverPath);
            if (!coverFound) tempCoverPath = undefined;
            
            await msg.edit({ text: "✍️ 正在写入元数据...", parseMode: "html" });
            const tempFinalAudioPath = path.join(converter.tempDir, `${timestamp}_final.mp3`);
            if (await converter.addMetadataAndCover(tempAudioPath, tempFinalAudioPath, songInfo, tempCoverPath)) {
                finalAudioPath = tempFinalAudioPath;
            }
            audioFileName = `${converter.safeFilename(songInfo.title)} - ${converter.safeFilename(songInfo.artist)}.mp3`;

        } else if (userQuery) {
            audioFileName = `${converter.safeFilename(userQuery)}.mp3`;
            songInfo.title = userQuery;
        } else {
            audioFileName = `${converter.safeFilename(originalFileName.replace(/\.[^.]+$/, ""))}.mp3`;
            songInfo.title = originalFileName.replace(/\.[^.]+$/, "");
        }

        await msg.edit({ text: "📤 正在发送文件...", parseMode: "html" });
        const duration = await converter.getVideoDuration(tempVideoPath);
        
        await client.sendFile(msg.peerId, {
            file: finalAudioPath,
            thumb: tempCoverPath,
            attributes: [
              new Api.DocumentAttributeAudio({
                duration: Math.round(duration),
                title: songInfo.title || path.basename(audioFileName, '.mp3'),
                performer: songInfo.artist || "Video Converter",
              }),
            ],
            replyTo: msg.id,
            forceDocument: false,
        });

        await msg.delete();

    } catch (error: any) {
        console.error("Conversion failed:", error);
        await msg.edit({ text: `❌ <b>转换失败</b>\n\n<b>错误:</b> ${htmlEscape(error.message)}`, parseMode: "html" });
    } finally {
        converter.cleanupTempFiles(tempVideoPath, tempAudioPath, finalAudioPath, tempCoverPath);
    }
  }

  private async handleClearCommand(msg: Api.Message): Promise<void> {
    await msg.edit({ text: "🧹 正在清理临时文件...", parseMode: "html" });
    converter.cleanupAllTempFiles();
    await msg.edit({ text: "✅ 临时文件已清理", parseMode: "html" });
  }

  private async handleApiKeyCommand(msg: Api.Message, apiKey: string): Promise<void> {
    if (!apiKey) {
      const currentKey = GeminiConfigManager.get(GEMINI_API_KEY);
      const text = currentKey
        ? `🔑 当前 API Key: <code>...${currentKey.slice(-4)}</code>`
        : "❌ 未设置 API Key。";
      await msg.edit({ text, parseMode: "html" });
      return;
    }
    if (apiKey.toLowerCase() === "clear") {
      GeminiConfigManager.set(GEMINI_API_KEY, "");
      await msg.edit({ text: "✅ API Key 已清除。" });
      return;
    }
    GeminiConfigManager.set(GEMINI_API_KEY, apiKey);
    await msg.edit({ text: "✅ API Key 已保存。" });
  }
}

export default new ConvertPlugin();

import { Api } from "telegram";
import { Plugin } from "@utils/pluginBase";
import { exec } from "child_process";
import util from "util";
import fs from "fs";
import path from "path";
import axios from "axios";
import { Converter } from "opencc-js";
import * as https from "https";
import * as http from "http";
import Database from "better-sqlite3";

const execPromise = util.promisify(exec);

const DOWNLOAD_TEMP_PATH = path.join(process.cwd(), "temp", "youtube");
const BIN_DIR = path.join(process.cwd(), "assets", "ytdlp");
const YTDLP_PATH = path.join(BIN_DIR, "yt-dlp");

const toSimplified = Converter({ from: "tw", to: "cn" });

const HELP_TEXT = toSimplified(
`🎵 YouTube 音乐下载器

✅ 功能:
  • 智能识别: 输入歌名，AI 自动查找最匹配的元数据 (需配置API Key)。
  • 手动指定: 使用 "歌名-歌手" 格式精确控制元数据。
  • 自动下载: 获取最佳音质并嵌入封面和歌曲信息。
  • 自我更新: 通过命令可更新下载核心，解决下载问题。

📝 命令用法:

  • 搜索下载 (AI或标准模式):
    .yt <搜索关键词>
    示例: .yt 稻香

  • 指定下载 (手动指定元数据):
    .yt <歌名>-<歌手>
    示例: .yt 晴天-周杰伦

  • AI 功能配置:
    .yt apikey <你的API密钥>
    .yt apikey
    .yt apikey clear

  • 核心更新 (更新下载核心):
    .yt update
`
);

const GEMINI_CONFIG_KEYS = {
    API_KEY: "ytdlp_gemini_api_key",
    BASE_URL: "ytdlp_gemini_base_url",
    MODEL: "ytdlp_gemini_model",
    TEMPERATURE: "ytdlp_gemini_temperature",
    TOP_P: "ytdlp_gemini_top_p",
    TOP_K: "ytdlp_gemini_top_k",
};

const GEMINI_DEFAULT_CONFIG: Record<string, string> = {
    [GEMINI_CONFIG_KEYS.BASE_URL]: "https://generativelanguage.googleapis.com",
    [GEMINI_CONFIG_KEYS.MODEL]: "gemini-2.0-flash",
    [GEMINI_CONFIG_KEYS.TEMPERATURE]: "0.2",
    [GEMINI_CONFIG_KEYS.TOP_P]: "0.8",
    [GEMINI_CONFIG_KEYS.TOP_K]: "40",
};

const GEMINI_CONFIG_DB_PATH = path.join(process.cwd(), "assets", "ytdlp_gemini_config.db");
if (!fs.existsSync(path.dirname(GEMINI_CONFIG_DB_PATH))) {
    fs.mkdirSync(path.dirname(GEMINI_CONFIG_DB_PATH), { recursive: true });
}

class GeminiConfigManager {
    private static db: Database.Database;
    private static initialized = false;
    private static init(): void {
        if (this.initialized) return;
        try {
            this.db = new Database(GEMINI_CONFIG_DB_PATH);
            this.db.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
            this.initialized = true;
        } catch (error) { console.error("[yt-dlp] 初始化 Gemini 配置数据库失败:", error); }
    }
    static get(key: string, defaultValue?: string): string {
        this.init();
        try {
            const row = this.db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
            return row ? row.value : (defaultValue || GEMINI_DEFAULT_CONFIG[key] || "");
        } catch (error) { console.error("[yt-dlp] 读取配置失败:", error); return ""; }
    }
    static set(key: string, value: string): void {
        this.init();
        try {
            this.db.prepare(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`).run(key, value);
        } catch (error) { console.error("[yt-dlp] 保存配置失败:", error); }
    }
}

class HttpClient {
    static cleanResponseText(text: string): string {
        if (!text) return text;
        return text.replace(/^\uFEFF/, '').normalize('NFKC');
    }
    static async makeRequest(url: string, options: any = {}): Promise<any> {
        const { method = 'GET', headers = {}, data, timeout = 30000 } = options;
        return new Promise((resolve, reject) => {
            try {
                const parsed = new URL(url);
                const client = parsed.protocol === 'https:' ? https : http;
                const requestOptions: any = { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: parsed.pathname + (parsed.search || ''), method, headers: { ...headers }, timeout };
                let bodyStr: string | undefined;
                if (data !== undefined) {
                    bodyStr = typeof data === 'string' ? data : JSON.stringify(data);
                    if (!requestOptions.headers['Content-Type']) { requestOptions.headers['Content-Type'] = 'application/json'; }
                    requestOptions.headers['Content-Length'] = Buffer.byteLength(bodyStr);
                }
                const req = client.request(requestOptions, (res: any) => {
                    res.setEncoding('utf8');
                    let body = '';
                    res.on('data', (chunk: string) => { body += chunk; });
                    res.on('end', () => {
                        const cleaned = HttpClient.cleanResponseText(body || '');
                        try {
                            const parsedJson = JSON.parse(cleaned);
                            resolve({ status: res.statusCode || 0, data: parsedJson });
                        } catch (err) {
                            resolve({ status: res.statusCode || 0, data: cleaned });
                        }
                    });
                });
                req.on('error', (e: Error) => reject(new Error(`网络请求失败: ${e.message}`)));
                req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
                if (bodyStr) req.write(bodyStr);
                req.end();
            } catch (e: any) {
                reject(new Error(`请求失败: ${e.message || e}`));
            }
        });
    }
}

class GeminiClient {
    private apiKey: string;
    private baseUrl: string;
    constructor(apiKey: string, baseUrl?: string | null) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl ?? GEMINI_DEFAULT_CONFIG[GEMINI_CONFIG_KEYS.BASE_URL];
    }
    async searchMusic(query: string): Promise<string> {
        const model = GeminiConfigManager.get(GEMINI_CONFIG_KEYS.MODEL);
        const url = `${this.baseUrl}/v1beta/models/${model}:generateContent`;

        const systemPrompt = toSimplified(`你是一个专业的音乐信息助手。
严格按照以下格式返回信息，不要包含任何其他内容：

歌曲名: [歌曲名称]
歌手: [演唱者姓名]
专辑: [专辑名称]

如果某些信息不确定，请使用"未知"。`);

        const userPrompt = toSimplified(`请精准识别这个查询的歌曲信息：'${query}'
要求：
1. 自动纠正可能的拼写错误。
2. 返回最广为人知的版本。
3. 如果找不到，歌曲名部分请直接使用用户输入 '${query}'。`);

        const temperature = parseFloat(GeminiConfigManager.get(GEMINI_CONFIG_KEYS.TEMPERATURE));
        const topP = parseFloat(GeminiConfigManager.get(GEMINI_CONFIG_KEYS.TOP_P));
        const topK = parseInt(GeminiConfigManager.get(GEMINI_CONFIG_KEYS.TOP_K), 10);

        const requestData = {
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                temperature: temperature,
                topP: topP,
                topK: topK,
                maxOutputTokens: 256,
            },
            tools: [{ "google_search": {} }],
            safetySettings: [
                "HARM_CATEGORY_HATE_SPEECH",
                "HARM_CATEGORY_DANGEROUS_CONTENT",
                "HARM_CATEGORY_HARASSMENT",
                "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            ].map((category) => ({ category, threshold: "BLOCK_NONE" })),
        };
        
        const headers = {
            "x-goog-api-key": this.apiKey,
            "Content-Type": "application/json",
        };

        const response = await HttpClient.makeRequest(url, { method: 'POST', headers: headers, data: requestData });
        
        if (response.status !== 200 || response.data?.error) {
            throw new Error(response.data?.error?.message || `HTTP错误: ${response.status}`);
        }
        return HttpClient.cleanResponseText(response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '');
    }
}

function extractSongInfo(geminiResponse: string, userInput: string): { title: string; artist: string; album?: string } {
    const lines = geminiResponse.split('\n');
    let title = '', artist = '', album = '';
    for (const line of lines) {
        if (line.includes('歌曲名:') || line.includes('歌曲名：')) { title = line.replace(/歌曲名[:：]\s*/, '').trim(); }
        else if (line.includes('歌手:') || line.includes('歌手：')) { artist = line.replace(/歌手[:：]\s*/, '').trim(); }
        else if (line.includes('专辑:') || line.includes('专辑：')) { album = line.replace(/专辑[:：]\s*/, '').trim(); }
    }
    const finalTitle = title || userInput;
    const finalArtist = artist || '未知歌手';

    return { title: finalTitle, artist: finalArtist, album: album && album !== '未知' ? album : undefined };
}

function normalizeTextForFile(text: string): string {
    return (text || "未知").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim()
        .replace(/[–—‐‑‒⁃−➖﹘﹣]/g, "-").replace(/^[-_\s]+|[-_\s]+$/g, "")
        .replace(/[\\/\?%\*:|"<>]/g, "_").replace(/[ _]{2,}/g, " ")
        .slice(0, 120).replace(/[ .]+$/g, "") || "未知";
}

function buildNormalizedFileName(artist: string, title: string): string {
    return `${normalizeTextForFile(title)} - ${normalizeTextForFile(artist)}`;
}

async function downloadYtDlp(msg: Api.Message, isUpdate: boolean = false): Promise<void> {
    if (isUpdate && fs.existsSync(YTDLP_PATH)) {
        fs.unlinkSync(YTDLP_PATH);
    }
    await msg.edit({ text: toSimplified("正在下载最新版 yt-dlp...") });
    try {
        const response = await axios.get("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp", { responseType: "stream" });
        await new Promise<void>((resolve, reject) => {
            const writer = fs.createWriteStream(YTDLP_PATH);
            response.data.pipe(writer);
            writer.on("finish", resolve).on("error", reject);
        });
        fs.chmodSync(YTDLP_PATH, 0o755);
    } catch (error) {
        throw new Error(toSimplified(`yt-dlp 下载失败: ${error}`));
    }
}

async function ensureYtDlpExists(msg: Api.Message): Promise<void> {
    if (fs.existsSync(YTDLP_PATH)) return;
    await msg.edit({ text: toSimplified("首次运行，正在为您自动安装 yt-dlp...") });
    if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
    await downloadYtDlp(msg);
    await msg.edit({ text: toSimplified("yt-dlp 安装成功！") });
}

async function handleUpdateCommand(msg: Api.Message): Promise<void> {
    const backupPath = `${YTDLP_PATH}.backup`;
    try {
        await msg.edit({ text: toSimplified("正在检查并更新 yt-dlp...") });
        if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
        
        // 备份旧版本
        if (fs.existsSync(YTDLP_PATH)) {
            fs.copyFileSync(YTDLP_PATH, backupPath);
        }
        
        await downloadYtDlp(msg, true);
        
        // 获取版本号
        try {
            const { stdout } = await execPromise(`${YTDLP_PATH} --version`);
            const version = stdout.trim();
            await msg.edit({ text: toSimplified(`✅ yt-dlp 已更新至最新版本！\n\n当前版本: ${version}`) });
        } catch {
            await msg.edit({ text: toSimplified("✅ yt-dlp 已更新至最新版本！") });
        }
        
        // 删除备份
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    } catch (error: any) {
        // 恢复备份
        if (fs.existsSync(backupPath)) {
            fs.copyFileSync(backupPath, YTDLP_PATH);
            fs.chmodSync(YTDLP_PATH, 0o755);
            fs.unlinkSync(backupPath);
        }
        throw error;
    }
}

async function getVideoInfo(query: string): Promise<{ title: string; uploader: string; duration: number } | null> {
    try {
        const { stdout } = await execPromise(`${YTDLP_PATH} "ytsearch1:${query}" -j --no-download --no-warnings --no-check-certificate`);
        if (!stdout) return null;
        const videoData = JSON.parse(stdout.trim().split("\n").pop()!);
        if (videoData?.title) {
            return {
                title: videoData.title.trim(),
                uploader: (videoData.uploader || videoData.channel || "").trim(),
                duration: videoData.duration || 0,
            };
        }
    } catch (error) {
        console.error("获取视频信息失败:", error);
    }
    return null;
}

function parseVideoTitle(rawTitle: string, uploader: string): { songTitle: string; artistName: string } {
    const cleanTitle = rawTitle.replace(/(\[|\(|【)[^\]】)]*(Official|Video|MV|HD|4K|Lyric|Subtitles|官方|正式|歌詞|字幕|動態|高清|音质|版本)[^\]】)]*(\]|\)|】)/gi, "").trim();
    const separators = ["-", "–", "—", "|", "·"];
    for (const sep of separators) {
        if (cleanTitle.includes(sep)) {
            const parts = cleanTitle.split(sep).map(p => p.trim()).filter(Boolean);
            if (parts.length >= 2) return { artistName: parts[0], songTitle: parts.slice(1).join(' ') };
        }
    }
    const cleanUploader = uploader.replace(/(\s*Official\s*|\s*MV\s*|官方频道)/gi, "").trim();
    return { songTitle: cleanTitle, artistName: cleanUploader || "未知艺术家" };
}

async function downloadAndUploadSong(msg: Api.Message, songQuery: string, preferredTitle?: string, preferredArtist?: string) {
    if (!fs.existsSync(DOWNLOAD_TEMP_PATH)) fs.mkdirSync(DOWNLOAD_TEMP_PATH, { recursive: true });
    let songTitle: string, artistName: string, albumName: string | undefined, finalSearchQuery = songQuery, videoDuration: number = 0;

    if (preferredTitle && preferredArtist) {
        songTitle = preferredTitle;
        artistName = preferredArtist;
        finalSearchQuery = `${artistName} ${songTitle}`;
        await msg.edit({ text: toSimplified("检测到手动指定元数据，开始搜索...") });
    } else {
        const apiKey = GeminiConfigManager.get(GEMINI_CONFIG_KEYS.API_KEY);
        if (apiKey) {
            try {
                await msg.edit({ text: toSimplified("🤖 AI 正在识别歌曲信息...") });
                const aiResponse = await new GeminiClient(apiKey).searchMusic(songQuery);
                const songInfo = extractSongInfo(aiResponse, songQuery);
                if (songInfo.title && songInfo.artist) {
                    songTitle = songInfo.title;
                    artistName = songInfo.artist;
                    albumName = songInfo.album;
                    finalSearchQuery = `${artistName} ${songTitle}`;
                    await msg.edit({ text: toSimplified(`🤖 AI 识别结果\n🎵 歌曲: ${songTitle}\n🎤 歌手: ${artistName}\n\n🔍 正在搜索...`) });
                    const videoInfo = await getVideoInfo(finalSearchQuery);
                    if (!videoInfo) throw new Error(toSimplified("AI识别成功，但未找到可下载的视频源。"));
                    videoDuration = videoInfo.duration;
                } else { throw new Error("AI 返回信息不足，使用标准解析"); }
            } catch (error: any) {
                console.warn("[yt-dlp] AI 处理失败:", error.message);
                await msg.edit({ text: toSimplified("AI 识别失败，转为标准搜索...") });
              const videoInfo = await getVideoInfo(songQuery);
              if (!videoInfo) throw new Error(toSimplified("未找到相关歌曲。"));
                ({ songTitle, artistName } = parseVideoTitle(videoInfo.title, videoInfo.uploader));
              videoDuration = videoInfo.duration;
            }
        } else {
            await msg.edit({ text: toSimplified("正在搜索歌曲信息...") });
            const videoInfo = await getVideoInfo(songQuery);
            if (!videoInfo) throw new Error(toSimplified("未找到相关歌曲。"));
            ({ songTitle, artistName } = parseVideoTitle(videoInfo.title, videoInfo.uploader));
            videoDuration = videoInfo.duration;
        }
    }

    songTitle = toSimplified(songTitle);
    artistName = toSimplified(artistName);
    if(albumName) albumName = toSimplified(albumName);

    const cleanFileName = buildNormalizedFileName(artistName, songTitle);
    const outputTemplate = path.join(DOWNLOAD_TEMP_PATH, `${cleanFileName}.%(ext)s`);
    const escapedTitle = songTitle.replace(/"/g, '\\"');
    const escapedArtist = artistName.replace(/"/g, '\\"');
    
    let command = `${YTDLP_PATH} "ytsearch1:${finalSearchQuery}" -x --audio-format mp3 --audio-quality 0 --embed-thumbnail --write-thumbnail --convert-thumbnails jpg -o "${outputTemplate}" --metadata "title=${escapedTitle}" --metadata "artist=${escapedArtist}" --no-warnings --no-check-certificate --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --extractor-args "youtube:player_client=android,web"`;

    if (albumName) {
        const escapedAlbum = albumName.replace(/"/g, '\\"');
        command += ` --metadata "album=${escapedAlbum}"`;
    }

    await msg.edit({ text: `正在下载: ${songTitle}\n歌手: ${artistName}` });

    try {
        await execPromise(command, { timeout: 180000 }); 
    } catch (error: any) {
        const errorMessage = error.stderr || error.message || "未知错误";
        if (errorMessage.includes("HTTP Error 403")) {
            throw new Error(toSimplified("下载失败：YouTube拒绝了请求(403)。这通常是由于下载核心版本过旧。\n\n请尝试使用 `.yt update` 命令更新后再试。"));
        }
        throw new Error(toSimplified(`yt-dlp 执行失败: ${errorMessage}`));
    }

    const downloadedFilePath = path.join(DOWNLOAD_TEMP_PATH, `${cleanFileName}.mp3`);
    if (!fs.existsSync(downloadedFilePath)) throw new Error(toSimplified("未找到下载的音频文件。"));

    await msg.edit({ text: toSimplified("准备上传...") });
    const thumbPath = [".jpg", ".webp", ".png"].map(ext => path.join(DOWNLOAD_TEMP_PATH, `${cleanFileName}${ext}`)).find(p => fs.existsSync(p));

    const attributes = [
        new Api.DocumentAttributeAudio({
            title: songTitle,
            performer: artistName,
            duration: Math.round(videoDuration),
        }),
    ];

    try {
        await msg.client?.sendFile(msg.peerId, {
            file: downloadedFilePath,
            thumb: thumbPath,
            attributes: attributes,
            forceDocument: false, 
        });
    } catch (uploadError) {
        console.error("音频作为 'Audio' 上传失败, 尝试作为 'Document' 上传:", uploadError);
        await msg.client?.sendFile(msg.peerId, {
            file: downloadedFilePath,
            thumb: thumbPath,
            forceDocument: true,
        });
    }

    await msg.delete();
    fs.unlinkSync(downloadedFilePath);
    if (thumbPath) fs.unlinkSync(thumbPath);
}

async function handleApiKeyCommand(msg: Api.Message, apiKey: string): Promise<void> {
    if (!apiKey) {
        const currentKey = GeminiConfigManager.get(GEMINI_CONFIG_KEYS.API_KEY);
        if (currentKey) {
            const maskedKey = currentKey.substring(0, 4) + "..." + currentKey.substring(currentKey.length - 4);
            await msg.edit({ text: toSimplified(`🤖 Gemini AI 已配置\n\n当前 Key: ${maskedKey}\n\n要更新, 请使用 .yt apikey <新密钥>\n要清除, 请使用 .yt apikey clear`) });
        } else {
            await msg.edit({ text: toSimplified(`🤖 Gemini AI 未配置\n\n使用方法: .yt apikey <你的API密钥>`) });
        }
        return;
    }
    if (apiKey.toLowerCase() === "clear") {
        GeminiConfigManager.set(GEMINI_CONFIG_KEYS.API_KEY, "");
        await msg.edit({ text: toSimplified(`✅ API Key 已清除。`) });
        return;
    }
    try {
        await msg.edit({ text: toSimplified("🔄 正在验证 API Key...") });
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const res = await HttpClient.makeRequest(url, { method: 'GET' });
        if (res?.status === 200 && Array.isArray(res.data?.models)) {
            GeminiConfigManager.set(GEMINI_CONFIG_KEYS.API_KEY, apiKey);
            await msg.edit({ text: toSimplified(`✅ API Key 配置成功！`) });
        } else {
            throw new Error(res?.data?.error?.message || `验证失败: ${res?.status}`);
        }
    } catch (error: any) {
        console.error("[yt-dlp] API Key 验证失败:", error);
        await msg.edit({ text: toSimplified(`❌ API Key 验证失败\n\n错误: ${error.message}`) });
    }
}

const yt = async (msg: Api.Message) => {
    try {
        const args = msg.message.split(" ").slice(1).join(" ") || "";
        const command = args.trim().toLowerCase();
        
        if (!args.trim()) {
            await msg.edit({ text: HELP_TEXT });
            return;
        }

        if (command === 'update') {
            await handleUpdateCommand(msg);
            return;
        }

        const parts = args.trim().split(/\s+/);
        if (parts[0].toLowerCase() === 'apikey') {
            await handleApiKeyCommand(msg, parts.slice(1).join(" ").trim());
            return;
        }
        await ensureYtDlpExists(msg);
        let preferredTitle: string | undefined, preferredArtist: string | undefined;
        const sepParts = args.trim().split(/\s*[-–—|·\/\\]\s*/g);
        if (sepParts.length >= 2) {
            preferredTitle = sepParts[0].trim();
            preferredArtist = sepParts.slice(1).join(" ").trim();
        }
        await downloadAndUploadSong(msg, args.trim(), preferredTitle, preferredArtist);
    } catch (error: any) {
        console.error("YouTube music download error:", error);
        await msg.edit({ text: toSimplified(`下载失败\n原因: ${(error as Error).message}`), linkPreview: false });
    }
};

class YtMusicPlugin extends Plugin {
    description: string = HELP_TEXT;
    cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = { yt };
}

export default new YtMusicPlugin();

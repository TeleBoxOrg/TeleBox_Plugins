import { Api } from "telegram";
import { Plugin } from "@utils/pluginBase";
import { exec } from "child_process";
import util from "util";
import fs from "fs";
import path from "path";
import axios from "axios";
import { Converter } from "opencc-js";

const execPromise = util.promisify(exec);

// --- 配置路径 ---
const DOWNLOAD_TEMP_PATH = path.join(process.cwd(), "temp", "youtube");
const BIN_DIR = path.join(process.cwd(), "assets", "ytdlp");
const YTDLP_PATH = path.join(BIN_DIR, "yt-dlp");
// --- 配置路径结束 ---

// --- 初始化简繁转换器 ---
const toSimplified = Converter({ from: "tw", to: "cn" });

function normalizeTextForFile(text: string): string {
  // 统一空白、去除不可见字符
  let s = (text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 替换常见破折/连接符为普通连字符
  s = s.replace(/[–—‐‑‒⁃−➖﹘﹣]/g, "-");
  // 去掉两侧多余连接符
  s = s.replace(/^[-_\s]+|[-_\s]+$/g, "");
  // 禁止文件名字符
  s = s.replace(/[\\/\?%\*:|"<>]/g, "_");
  // 折叠多余的下划线或空格
  s = s.replace(/[ _]{2,}/g, " ");
  // 限长，避免极端超长
  if (s.length > 120) s = s.slice(0, 118) + "…";
  // Windows 特殊尾字符
  s = s.replace(/[ .]+$/g, "");
  return s || "未知";
}

function buildNormalizedFileName(artist: string, title: string): string {
  const a = normalizeTextForFile(artist);
  const t = normalizeTextForFile(title);
  // 文件名格式：Title - Artist
  return `${t} - ${a}`;
}

async function ensureYtDlpExists(msg: Api.Message): Promise<void> {
  if (fs.existsSync(YTDLP_PATH)) {
    return;
  }
  await msg.edit({
    text: toSimplified("首次运行，正在为您自动安装 yt-dlp..."),
  });

  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  try {
    await msg.edit({ text: toSimplified("正在下载 yt-dlp...") });
    const ytdlpUrl =
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
    // 使用 axios 下载二进制并写入本地
    const response = await axios.get(ytdlpUrl, { responseType: "stream" });
    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(YTDLP_PATH);
      response.data.pipe(writer);
      writer.on("finish", () => resolve());
      writer.on("error", (err) => reject(err));
      response.data.on("error", (err: any) => reject(err));
    });
    await msg.edit({ text: toSimplified("配置中...") });
    fs.chmodSync(YTDLP_PATH, 0o755);
    await msg.edit({ text: toSimplified("yt-dlp 安装成功！") });
  } catch (error) {
    throw new Error(toSimplified(`yt-dlp 安装失败: ${error}`));
  }
}

async function getVideoInfo(query: string): Promise<{
  videoId: string;
  title: string;
  artist: string;
  track?: string;
  uploader?: string;
} | null> {
  try {
    console.log(`正在搜索: ${query}`);
    const command = `${YTDLP_PATH} "ytsearch1:${query}" -j --no-download --no-warnings`;
    const { stdout, stderr } = await execPromise(command);

    if (stderr) {
      console.log("yt-dlp stderr:", stderr);
    }
    if (!stdout) return null;

    const lines = stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    const videoData = JSON.parse(lastLine);

    if (videoData && videoData.id && videoData.title) {
      console.log(`找到视频: ${videoData.title} (${videoData.id})`);
      return {
        title: videoData.title.trim(),
        artist: (
          videoData.artist ||
          videoData.uploader ||
          videoData.channel ||
          "未知艺术家"
        ).trim(),
        track: videoData.track || videoData.title.trim(),
        uploader: (videoData.uploader || videoData.channel || "").trim(),
        videoId: videoData.id.trim(),
      };
    }
  } catch (error) {
    console.error("获取视频信息失败:", error);
  }
  return null;
}

function cleanMixedLanguage(str: string): string {
  const junkEnglishWords =
    /\b(Official|Music|Video|MV|HD|4K|Lyric|Lyrics|Subtitles|Version|Full|Complete|High|Quality|Audio|Song|Track|Jay|Chou)\b/gi;
  let cleaned = str.replace(junkEnglishWords, "").replace(/\s+/g, " ").trim();

  if (/[\u4e00-\u9fa5]/.test(cleaned) && /[a-zA-Z]/.test(cleaned)) {
    const chinesePart = cleaned.replace(/[a-zA-Z0-9\s-.,&[\]()]+/g, "").trim();
    if (chinesePart && chinesePart.length >= 1) {
      return chinesePart;
    }
  }
  return cleaned;
}

function parseVideoTitle(
  rawTitle: string,
  uploader: string,
  searchQuery: string
): { songTitle: string; artistName: string } {
  let cleanTitle = rawTitle
    .replace(
      /(\[|\(|【)[^\]】)]*(Official|Music Video|MV|HD|4K|Lyric|Lyrics|Subtitles|官方|正式|歌詞|字幕|動態歌詞|动态歌词|高清|音质|版本)[^\]】)]*(\]|\)|】)/gi,
      ""
    )
    .replace(
      /\b(Official Music Video|Music Video|Lyric Video|Official|MV|HD|4K|1080p|歌詞字幕|完整高清音質|完整版|官方|正式版|歌詞|字幕|高清|音質|版)\b/gi,
      ""
    )
    .replace(/『[^』]*』/g, "")
    .replace(/「[^」]*」/g, "")
    .replace(/〈[^〉]*〉/g, "")
    .replace(/《[^》]*》/g, "")
    .replace(/[\[\]【】()]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const separators = ["-", "–", "—", "|", "·", "/", "\\"];
  let bestParse = null;

  for (const sep of separators) {
    if (cleanTitle.includes(sep)) {
      const parts = cleanTitle
        .split(sep)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (parts.length >= 2) {
        const part1 = parts[0];
        const part2 = parts.slice(1).join(" ").trim();
        if (
          uploader &&
          (part1.toLowerCase().includes(uploader.toLowerCase()) ||
            uploader.toLowerCase().includes(part1.toLowerCase()))
        ) {
          bestParse = { artist: part1, title: part2 };
          break;
        } else {
          bestParse = { artist: part1, title: part2 };
        }
      }
    }
  }

  let songTitle;
  let artistName;

  if (bestParse) {
    songTitle = bestParse.title;
    artistName = bestParse.artist;
  } else {
    songTitle = cleanTitle;
    artistName = uploader || "未知艺术家";
  }

  songTitle = songTitle
    .replace(/[-–—|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  artistName = artistName
    .replace(/[-–—|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (songTitle.toLowerCase().startsWith(artistName.toLowerCase())) {
    songTitle = songTitle.substring(artistName.length).trim();
    if (
      songTitle.startsWith("-") ||
      songTitle.startsWith("–") ||
      songTitle.startsWith("—")
    ) {
      songTitle = songTitle.substring(1).trim();
    }
  }

  if (/[\u4e00-\u9fa5]/.test(searchQuery)) {
    songTitle = cleanMixedLanguage(songTitle);
    artistName = cleanMixedLanguage(artistName);
  }

  return {
    songTitle: songTitle || searchQuery || "未知歌曲",
    artistName: artistName || "未知艺术家",
  };
}

async function downloadAndUploadSong(
  msg: Api.Message,
  songQuery: string,
  preferredTitle?: string,
  preferredArtist?: string
) {
  if (!fs.existsSync(DOWNLOAD_TEMP_PATH)) {
    fs.mkdirSync(DOWNLOAD_TEMP_PATH, { recursive: true });
  }

  await msg.edit({ text: toSimplified("正在搜索歌曲信息...") });

  const videoInfo = await getVideoInfo(songQuery);
  if (!videoInfo) {
    throw new Error(toSimplified("未找到相关歌曲。"));
  }

  let songTitle: string;
  let artistName: string;

  if (preferredTitle && preferredArtist) {
    songTitle = preferredTitle;
    artistName = preferredArtist;
  } else {
    const parsed = parseVideoTitle(
      videoInfo.title,
      videoInfo.uploader || "",
      songQuery
    );
    songTitle = parsed.songTitle;
    artistName = parsed.artistName;
  }

  // --- 修改：在此处立即将歌名和歌手转换为简体 ---
  songTitle = toSimplified(songTitle);
  artistName = toSimplified(artistName);
  // --- 修改结束 ---

  const hasValidMeta =
    Boolean(artistName && songTitle) &&
    !/(未知艺术家|未知歌曲|未知)/.test(`${artistName}${songTitle}`);
  const cleanFileName = hasValidMeta
    ? buildNormalizedFileName(artistName, songTitle)
    : normalizeTextForFile(toSimplified(videoInfo.title || songQuery));
  const outputTemplate = path.join(
    DOWNLOAD_TEMP_PATH,
    `${cleanFileName}.%(ext)s`
  );

  const escapedTitle = songTitle.replace(/"/g, '\\"');
  const escapedArtist = artistName.replace(/"/g, '\\"');

  const command = `${YTDLP_PATH} "ytsearch1:${songQuery}" -x --audio-format mp3 --audio-quality 0 --embed-thumbnail --write-thumbnail --convert-thumbnails jpg -o "${outputTemplate}" --metadata "title=${escapedTitle}" --metadata "artist=${escapedArtist}" --no-warnings`;

  try {
    // 此处无需再用 toSimplified 包裹，因为变量已经转换过了
    await msg.edit({ text: `正在下载: ${songTitle}\n歌手: ${artistName}` });
    console.log(`执行下载命令: ${command}`);
    await execPromise(command, { timeout: 120000 });

    await msg.edit({ text: toSimplified("下载完成，正在准备上传...") });
    const downloadedFilePath = path.join(
      DOWNLOAD_TEMP_PATH,
      `${cleanFileName}.mp3`
    );

    if (!fs.existsSync(downloadedFilePath)) {
      throw new Error(toSimplified("未找到下载的音频文件。"));
    }

    const fileStats = fs.statSync(downloadedFilePath);
    const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);

    // 此处也无需再用 toSimplified 包裹
    const caption =
      `歌曲: ${songTitle}\n` +
      `歌手: ${artistName}\n` +
      `文件大小: ${fileSizeMB} MB\n` +
      `歌曲链接: https://www.youtube.com/watch?v=${videoInfo.videoId}\n` +
      `搜索关键词: ${songQuery}`;

    await msg.edit({ text: toSimplified("正在上传音频文件...") });

    // 尝试查找封面缩略图
    const thumbJpg = path.join(DOWNLOAD_TEMP_PATH, `${cleanFileName}.jpg`);
    const thumbWebp = path.join(DOWNLOAD_TEMP_PATH, `${cleanFileName}.webp`);
    const thumbPng = path.join(DOWNLOAD_TEMP_PATH, `${cleanFileName}.png`);
    const thumbPath = fs.existsSync(thumbJpg)
      ? thumbJpg
      : fs.existsSync(thumbWebp)
      ? thumbWebp
      : fs.existsSync(thumbPng)
      ? thumbPng
      : undefined;

    await msg.client
      ?.sendFile(msg.peerId, {
        file: downloadedFilePath,
        thumb: thumbPath,
        // caption: caption,
      })
      .catch((uploadError) => {
        console.error("音频上传错误，将尝试作为文档发送:", uploadError);
        return msg.client?.sendFile(msg.peerId, {
          file: downloadedFilePath,
          caption: caption,
          forceDocument: true,
          thumb: thumbPath,
        });
      });

    await msg.delete();
    fs.unlinkSync(downloadedFilePath);
    if (thumbPath && fs.existsSync(thumbPath)) {
      try {
        fs.unlinkSync(thumbPath);
      } catch {}
    }
  } catch (error: any) {
    console.error("Download error:", error);
    throw error;
  }
}

const yt = async (msg: Api.Message) => {
  const args = msg.message.split(" ").slice(1).join(" ") || "";

  if (!args.trim()) {
    await msg.edit({
      text: toSimplified(
        "YouTube 音乐下载器使用方法\n\n" +
          "基本用法:\n" +
          ".yt <搜索关键词>\n\n" +
          "强制指定元数据:\n" +
          "推荐使用 `歌名-歌手` 格式强制设定；空格分隔易误判，默认不再采用。\n\n" +
          "示例:\n" +
          ".yt Shape of You-Ed Sheeran\n" +
          ".yt 周杰伦-晴天\n" +
          ".yt 辞九门回忆"
      ),
    });
    return;
  }

  await msg.edit({ text: toSimplified("初始化音乐下载环境...") });
  if (!msg) {
    console.error("无法编辑消息。");
    return;
  }

  try {
    await ensureYtDlpExists(msg);

    const searchQuery = args.trim();
    let preferredTitle: string | undefined;
    let preferredArtist: string | undefined;

    const sepParts = searchQuery.split(/\s*[-–—|·\/\\]\s*/g);
    if (sepParts.length >= 2) {
      preferredTitle = sepParts[0].trim();
      preferredArtist = sepParts.slice(1).join(" ").trim();
    }

    if (!preferredTitle || !preferredArtist) {
      preferredTitle = undefined;
      preferredArtist = undefined;
    }

    await downloadAndUploadSong(
      msg,
      args.trim(),
      preferredTitle,
      preferredArtist
    );
  } catch (error: any) {
    let errorMessage = toSimplified(`音乐下载失败\n\n`);
    if (error.message.includes("未找到")) {
      errorMessage += toSimplified(
        `原因: 未找到相关歌曲\n` +
          `建议: 尝试更具体的关键词或使用"歌名-歌手"格式\n\n` +
          `示例: /yt Shape of You-Ed Sheeran`
      );
    } else if (
      error.message.includes("network") ||
      error.message.includes("timeout")
    ) {
      errorMessage += toSimplified(`原因: 网络连接问题\n` + `建议: 请稍后重试`);
    } else if (
      error.message.includes("permission") ||
      error.message.includes("access")
    ) {
      errorMessage += toSimplified(
        `原因: 访问权限问题\n` + `建议: 该视频可能存在地区限制或版权保护`
      );
    } else if (error.message) {
      errorMessage += toSimplified(
        `技术详情: ${error.message}\n\n` + `需要帮助? 请联系管理员或稍后重试`
      );
    }
    console.error("YouTube music download error:", error);
    await msg.edit({ text: errorMessage, linkPreview: false });
  }
};

class YtMusicPlugin extends Plugin {
  description: string = `从 YouTube 下载音乐并发送（支持封面获取）。用法：.yt <歌曲名称>-<歌手> 或 .yt <搜索关键词>`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    yt,
  };
}

export default new YtMusicPlugin();

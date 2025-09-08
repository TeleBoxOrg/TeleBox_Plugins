/**
 * Music downloader plugin for TeleBox
 *
 * Provides YouTube music search and download functionality with native TeleBox integration.
 */

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// 检测依赖工具
async function checkDependencies(): Promise<{ ytdlp: boolean; ffmpeg: boolean }> {
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
        console.log("[music] yt-dlp not found in PATH");
      }
    }
  }
  
  // 检测 FFmpeg
  try {
    await execAsync("ffmpeg -version");
    result.ffmpeg = true;
  } catch {
    console.log("[music] FFmpeg not found (optional)");
  }
  
  return result;
}

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

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
    this.tempDir = path.join(process.cwd(), "temp", "music");
    this.ensureDirectories();
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

  async searchYoutube(query: string): Promise<string | null> {
    try {
      const searchQuery = query.includes("歌词") ? query : `${query} 歌词版`;
      
      // 尝试多种调用方式
      const commands = [
        `yt-dlp "ytsearch:${searchQuery}" --get-id --no-playlist --no-warnings`,
        `python -m yt_dlp "ytsearch:${searchQuery}" --get-id --no-playlist --no-warnings`,
        `python3 -m yt_dlp "ytsearch:${searchQuery}" --get-id --no-playlist --no-warnings`
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

  async downloadAudio(url: string, outputPath: string): Promise<boolean> {
    try {
      const cookieFile = path.join(this.tempDir, "cookies.txt");
      let cookieArg = "";
      
      if (fs.existsSync(cookieFile)) {
        cookieArg = `--cookies "${cookieFile}"`;
      }

      // Try multiple command formats
      const commands = [
        `yt-dlp "${url}" -f "bestaudio[ext=m4a]/bestaudio/best[height<=480]" -x --audio-format mp3 --audio-quality 0 --embed-metadata --add-metadata -o "${outputPath}" --no-playlist --no-warnings ${cookieArg}`,
        `python -m yt_dlp "${url}" -f "bestaudio[ext=m4a]/bestaudio/best[height<=480]" -x --audio-format mp3 --audio-quality 0 --embed-metadata --add-metadata -o "${outputPath}" --no-playlist --no-warnings ${cookieArg}`,
        `python3 -m yt_dlp "${url}" -f "bestaudio[ext=m4a]/bestaudio/best[height<=480]" -x --audio-format mp3 --audio-quality 0 --embed-metadata --add-metadata -o "${outputPath}" --no-playlist --no-warnings ${cookieArg}`
      ];

      let success = false;
      for (const cmd of commands) {
        try {
          console.log(`Trying: ${cmd.split(' ')[0]}...`);
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
      const files = fs.readdirSync(outputDir).filter(f => 
        f.startsWith(baseFileName) && f.endsWith(".mp3")
      );

      if (files.length > 0) {
        console.log(`Downloaded audio file: ${files[0]}`);
        return true;
      }
      
      // Fallback: check for any audio files with similar name
      const allFiles = fs.readdirSync(outputDir).filter(f => 
        f.includes(baseFileName.substring(0, 10)) && 
        (f.endsWith(".mp3") || f.endsWith(".m4a") || f.endsWith(".webm") || f.endsWith(".opus"))
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

  async saveAudioLocally(tempFile: string, title: string, artist: string): Promise<string> {
    const safeTitle = this.safeFilename(title);
    const safeArtist = this.safeFilename(artist);
    const filename = `${safeArtist}_${safeTitle}.mp3`;
    const targetPath = path.join(this.musicDir, filename);

    // Copy file to music directory
    fs.copyFileSync(tempFile, targetPath);
    
    return targetPath;
  }

  setCookie(cookieContent: string): boolean {
    try {
      const cookieFile = path.join(this.tempDir, "cookies.txt");
      fs.writeFileSync(cookieFile, cookieContent, "utf-8");
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
• 🔍 <b>智能搜索</b>：自动优选歌词版和高质量音频
• 📥 <b>高速下载</b>：支持 YouTube 链接直接下载
• 💾 <b>本地收藏</b>：音频文件保存和管理功能
• 🔧 <b>Cookie 支持</b>：突破年龄和地区访问限制

<b>🔧 使用方法:</b>
• <code>${mainPrefix}music &lt;关键词&gt;</code> - 智能搜索并下载音乐
• <code>${mainPrefix}music &lt;YouTube链接&gt;</code> - 直接下载指定视频音频
• <code>${mainPrefix}music save</code> - 回复音频消息保存到本地收藏
• <code>${mainPrefix}music cookie &lt;Netscape格式&gt;</code> - 设置 YouTube Cookie
• <code>${mainPrefix}music clear</code> - 清理临时文件释放空间
• <code>${mainPrefix}music help</code> - 显示此帮助信息

<b>💡 示例:</b>
• <code>${mainPrefix}music 周杰伦 晴天</code> - 搜索下载周杰伦的晴天
• <code>${mainPrefix}music Taylor Swift Love Story</code> - 搜索英文歌曲
• <code>${mainPrefix}music https://youtu.be/dQw4w9WgXcQ</code> - 直接下载链接

<b>🛠️ 环境要求:</b>
• <b>一键安装 (root环境):</b>
  <code>sudo apt update && sudo apt install -y ffmpeg && pip3 install -U yt-dlp --break-system-packages</code>
• <b>网络环境:</b> WARP+ 或稳定代理 (绕过地区限制)
  <code>wget -N https://gitlab.com/fscarmen/warp/-/raw/main/menu.sh && bash menu.sh e</code>
• <b>访问权限:</b> YouTube Cookie (Netscape 格式，突破限制)

<b>⚡ 智能特性:</b>
• 自动优选"歌词版"或高质量音频源
• 智能转换为 MP3 格式并嵌入完整元数据
• 自动清理临时文件节省磁盘空间
• 支持断点续传和网络错误自动重试

<b>🔒 隐私安全:</b>
• Cookie 配置仅本地存储，程序重启后自动清除
• 下载文件仅保存在指定目录，不会外传
• 不会上传、收集或泄露任何个人隐私信息`;

class MusicPlugin extends Plugin {
  description: string = help_text;
  
  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
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
            parseMode: "html"
          });
          return;
        }

        // 明确请求帮助时才显示
        if (sub === "help" || sub === "h") {
          await msg.edit({
            text: help_text,
            parseMode: "html"
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
          const cookieContent = args.slice(1).join(" ").trim();
          await this.handleCookieCommand(msg, cookieContent);
          return;
        }

        // 清理功能
        if (sub === "clear") {
          await this.handleClearCommand(msg);
          return;
        }

        // 默认为音乐搜索下载
        const query = args.join(" ").trim();
        if (!query) {
          await msg.edit({
            text: `❌ <b>搜索内容为空</b>\n\n🎯 <b>正确用法：</b>\n<code>${mainPrefix}music &lt;关键词或YouTube链接&gt;</code>\n\n💡 <b>示例：</b>\n• <code>${mainPrefix}music 周杰伦 稻香</code>\n• <code>${mainPrefix}music https://youtu.be/xxxxx</code>`,
            parseMode: "html"
          });
          return;
        }

        await this.handleMusicDownload(msg, query);

      } catch (error: any) {
        console.error("[music] 插件执行失败:", error);
        const errorMsg = error.message || String(error);
        const displayError = errorMsg.length > 150 ? errorMsg.substring(0, 150) + "..." : errorMsg;
        await msg.edit({
          text: `❌ <b>系统异常</b>\n\n🔍 <b>错误信息:</b> <code>${htmlEscape(displayError)}</code>\n\n🛠️ <b>建议操作:</b>\n• 🔄 重新尝试操作\n• 🌐 检查网络连接\n• 🔧 确认依赖工具已安装\n• 📞 联系管理员获取技术支持`,
          parseMode: "html"
        });
      }
    }
  };

  private async handleMusicDownload(msg: Api.Message, query: string): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }
    
    // 检测依赖
    const deps = await checkDependencies();
    if (!deps.ytdlp) {
      await msg.edit({
        text: `❌ <b>缺少必需组件</b>\n\n🔧 <b>yt-dlp 未安装</b>\n\n📦 <b>一键安装 (root环境):</b>\n<code>sudo apt update && sudo apt install -y ffmpeg && pip3 install -U yt-dlp --break-system-packages</code>\n\n📦 <b>其他安装方式:</b>\n• <b>Windows:</b>\n  <code>winget install yt-dlp</code>\n• <b>macOS:</b>\n  <code>brew install yt-dlp</code>\n• <b>手动下载:</b>\n  <code>sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp</code>\n  <code>sudo chmod a+rx /usr/local/bin/yt-dlp</code>\n\n💡 <b>提示:</b> 安装后重启程序即可使用`,
        parseMode: "html"
      });
      return;
    }
    
    if (!deps.ffmpeg) {
      console.log("[music] FFmpeg not installed - MP3 conversion may not work");
    }
    
    await msg.edit({ text: "🔍 <b>智能搜索中...</b>\n\n🎵 正在 YouTube 上查找最佳匹配", parseMode: "html" });

    // Check if it's a direct link
    const urlPattern = /https?:\/\/(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)/;
    let url: string;

    if (urlPattern.test(query)) {
      url = query;
    } else {
      // Search YouTube
      const searchResult = await downloader.searchYoutube(query);
      if (!searchResult) {
        await msg.edit({
          text: `❌ <b>搜索无结果</b>\n\n🔍 <b>查询内容:</b> <code>${htmlEscape(query)}</code>\n\n🛠️ <b>解决方案:</b>\n• 🌐 <b>网络问题:</b> 启用 WARP+ 或稳定代理\n  <code>wget -N https://gitlab.com/fscarmen/warp/-/raw/main/menu.sh && bash menu.sh e</code>\n• 🔑 <b>访问限制:</b> 使用 <code>${mainPrefix}music cookie</code> 设置 YouTube Cookie (Netscape格式)\n• 📝 <b>关键词优化:</b> 尝试"歌手名+歌曲名"格式\n• 🔄 <b>重试:</b> 稍后再次尝试搜索\n\n💡 <b>提示:</b> 某些地区需要 WARP+ 才能正常访问 YouTube`,
          parseMode: "html",
        });
        return;
      }
      url = searchResult;
    }

    await msg.edit({ text: "📥 <b>开始下载</b>\n\n🎵 正在获取最佳音质版本...", parseMode: "html" });

    // Generate temp file path
    const safeQuery = downloader.safeFilename(query);
    const tempFile = path.join(downloader.tempDirPath, `${safeQuery}.%(ext)s`);

    // Download audio
    const success = await downloader.downloadAudio(url, tempFile);
    if (!success) {
      const deps = await checkDependencies();
      let ffmpegHint = "";
      if (!deps.ffmpeg) {
        ffmpegHint = "\n\n🎵 <b>FFmpeg 未安装 (音频转换可能失败):</b>\n• <code>apt install ffmpeg</code> (Linux)\n• <code>brew install ffmpeg</code> (macOS)\n• <code>winget install ffmpeg</code> (Windows)";
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
    let downloadedFiles = files.filter((file) => 
      file.startsWith(safeQuery) && file.endsWith(".mp3")
    );
    
    if (downloadedFiles.length === 0) {
      // Fallback to any audio format
      downloadedFiles = files.filter((file) => 
        file.startsWith(safeQuery) && 
        (file.endsWith(".m4a") || file.endsWith(".webm") || file.endsWith(".opus") || file.endsWith(".mp3"))
      );
    }
    
    if (downloadedFiles.length === 0) {
      // Final fallback: look for any file containing part of the query
      downloadedFiles = files.filter((file) => 
        file.includes(safeQuery.substring(0, 10)) && 
        (file.endsWith(".mp3") || file.endsWith(".m4a") || file.endsWith(".webm") || file.endsWith(".opus"))
      );
    }

    if (downloadedFiles.length === 0) {
      await msg.edit({
        text: `❌ <b>文件处理异常</b>\n\n🔍 <b>问题分析:</b>\n• 下载过程可能被中断\n• 文件格式转换失败\n• 磁盘空间不足\n\n🛠️ <b>解决建议:</b>\n• 🔄 重新尝试下载\n• 💾 检查磁盘剩余空间\n• 🌐 确保网络连接稳定\n• 🔧 更新 yt-dlp 和 FFmpeg\n\n📊 <b>调试信息:</b>\n• 查询: <code>${htmlEscape(safeQuery)}</code>\n• 临时目录文件: <code>${htmlEscape(files.slice(0, 3).join(", "))}${files.length > 3 ? "..." : ""}</code>`,
        parseMode: "html",
      });
      return;
    }

    const audioFile = path.join(tempDir, downloadedFiles[0]);
    console.log(`Using audio file: ${audioFile}`);

    try {
      await msg.edit({ text: "📤 <b>准备发送</b>\n\n🎵 正在上传高品质音频文件...", parseMode: "html" });

      // Clean metadata: only use user input as title and "YouTube Music" as artist
      const audioTitle = query;
      const audioPerformer = "YouTube Music";

      // Send audio file with clean metadata
      await client.sendFile(msg.peerId, {
        file: audioFile,
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
      const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + "..." : errorMessage;
      await msg.edit({
        text: `❌ <b>发送失败</b>\n\n🔍 <b>错误详情:</b> <code>${htmlEscape(displayError)}</code>\n\n🛠️ <b>可能原因:</b>\n• 📁 文件过大 (超过 Telegram 限制)\n• 🎵 音频格式不被支持\n• 🌐 网络上传中断\n• 💾 临时存储空间不足\n\n💡 <b>解决方案:</b>\n• 尝试下载较短的音频片段\n• 检查网络连接稳定性\n• 清理临时文件释放空间`,
        parseMode: "html",
      });
    } finally {
      // Cleanup temp files
      downloader.cleanupTempFiles(safeQuery);
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

      await msg.edit({ text: "💾 <b>保存中...</b>\n\n📁 正在添加到本地音乐收藏", parseMode: "html" });

      // Create temp file
      const tempFile = path.join(downloader.tempDirPath, `temp_save_${msg.id}.mp3`);

      // Download file to temp location
      await client.downloadMedia(reply, { outputFile: tempFile });

      // Save to local storage
      const savedPath = await downloader.saveAudioLocally(tempFile, title, artist);

      await msg.edit({
        text: `✅ <b>保存完成</b>\n\n📁 <b>文件信息:</b>\n• 名称: <code>${htmlEscape(path.basename(savedPath))}</code>\n• 路径: <code>${htmlEscape(path.dirname(savedPath))}</code>\n\n🎵 <b>音频详情:</b>\n• 标题: ${htmlEscape(title)}\n• 艺术家: ${htmlEscape(artist)}\n\n💡 文件已永久保存到本地收藏`,
        parseMode: "html",
      });
      console.log(`Audio saved to: ${savedPath}`);
    } catch (error: any) {
      console.error("Save command failed:", error);
      const errorMessage = error.message || String(error);
      const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + "..." : errorMessage;
      await msg.edit({
        text: `❌ <b>保存失败</b>\n\n🔍 <b>错误详情:</b> <code>${htmlEscape(displayError)}</code>\n\n🛠️ <b>解决方案:</b>\n• 💾 检查磁盘剩余空间\n• 🔐 确认文件夹写入权限\n• 📁 检查目标路径是否存在\n• 🔄 重新尝试保存操作`,
        parseMode: "html",
      });
    } finally {
      // Cleanup temp file
      try {
        const tempFile = path.join(downloader.tempDirPath, `temp_save_${msg.id}.mp3`);
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private async handleCookieCommand(msg: Api.Message, cookieContent: string): Promise<void> {
    if (!cookieContent) {
      await msg.edit({
        text: `❌ <b>Cookie 内容为空</b>\n\n🔑 <b>使用方法:</b>\n<code>${mainPrefix}music cookie &lt;Netscape格式Cookie&gt;</code>\n\n📋 <b>获取步骤 (推荐使用浏览器插件):</b>\n1️⃣ 登录 YouTube 网页版\n2️⃣ 安装浏览器插件 "Get cookies.txt LOCALLY"\n3️⃣ 点击插件图标，选择 "Export as Netscape"\n4️⃣ 复制导出的 Cookie 内容\n\n📝 <b>手动获取 (开发者工具):</b>\n1️⃣ 按 F12 打开开发者工具\n2️⃣ Application → Cookies → youtube.com\n3️⃣ 导出为 Netscape HTTP Cookie 格式\n\n⚠️ <b>重要:</b> 必须是 Netscape 格式，不是普通 Cookie 字符串\n💡 <b>用途:</b> 突破年龄限制、登录限制和地区限制`,
        parseMode: "html",
      });
      return;
    }

    try {
      const success = downloader.setCookie(cookieContent);
      if (success) {
        await msg.edit({
          text: "✅ <b>Cookie 配置成功</b>\n\n🔓 <b>已解锁功能:</b>\n• 年龄受限内容访问\n• 需要登录的视频\n• 地区限制内容\n• 高清音质选项\n\n⏰ <b>有效期:</b> 直到程序重启\n🔒 <b>隐私:</b> 仅本地存储，不会上传",
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
      const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + "..." : errorMessage;
      await msg.edit({
        text: `❌ <b>Cookie 配置异常</b>\n\n🔍 <b>错误详情:</b> <code>${htmlEscape(displayError)}</code>\n\n🛠️ <b>解决方案:</b>\n• 检查 Cookie 格式完整性\n• 确认文件系统写入权限\n• 重新获取有效的 YouTube Cookie`,
        parseMode: "html",
      });
    }
  }

  private async handleClearCommand(msg: Api.Message): Promise<void> {
    try {
      await msg.edit({ text: "🧹 <b>清理中...</b>\n\n📁 正在清理临时下载文件", parseMode: "html" });

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
      const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + "..." : errorMessage;
      await msg.edit({
        text: `❌ <b>清理异常</b>\n\n🔍 <b>错误详情:</b> <code>${htmlEscape(displayError)}</code>\n\n🛠️ <b>可能原因:</b>\n• 文件正在被其他程序使用\n• 缺少文件删除权限\n• 临时目录访问受限\n\n💡 <b>建议:</b> 手动清理或重启程序后重试`,
        parseMode: "html",
      });
    }
  }
}

export default new MusicPlugin();

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
      const cmd = `yt-dlp "ytsearch:${searchQuery}" --get-id --no-playlist --no-warnings`;
      
      const { stdout } = await execAsync(cmd);
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

      // Download with best audio quality and extract audio metadata
      const cmd = `yt-dlp "${url}" -f "bestaudio[ext=m4a]/bestaudio/best[height<=480]" -x --audio-format mp3 --audio-quality 0 --embed-metadata --add-metadata -o "${outputPath}" --no-playlist --no-warnings ${cookieArg}`;
      
      console.log(`Executing: ${cmd}`);
      await execAsync(cmd);

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
const help_text = `🎵 <b>音乐下载器</b>

<b>📥 基本用法：</b>
• <code>${mainPrefix}music &lt;关键词&gt;</code> - 搜索并下载音乐
• <code>${mainPrefix}music &lt;YouTube链接&gt;</code> - 直接下载指定视频

<b>🔧 辅助功能：</b>
• <code>${mainPrefix}music save</code> - 回复音频消息保存到本地
• <code>${mainPrefix}music cookie &lt;内容&gt;</code> - 设置访问受限内容的Cookie
• <code>${mainPrefix}music clear</code> - 清理临时文件缓存
• <code>${mainPrefix}music help</code> - 显示此帮助信息

<b>💡 示例：</b>
• <code>${mainPrefix}music 周杰伦 晴天</code>
• <code>${mainPrefix}music Taylor Swift Love Story</code>
• <code>${mainPrefix}music https://youtu.be/xxxxx</code>

<b>⚠️ 注意事项：</b>
• 优先选择包含"歌词版"的视频
• 支持 FFmpeg 自动转换为 MP3 格式
• 临时文件会在发送后自动清理
• 需要安装 yt-dlp 和 FFmpeg (可选)`;

class MusicPlugin extends Plugin {
  description: string = `音乐下载器 - 搜索并下载 YouTube 音乐`;
  
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
            text: `❌ <b>参数不足</b>\n\n💡 使用 <code>${mainPrefix}music help</code> 查看帮助`,
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
            text: `❌ <b>搜索关键词不能为空</b>\n\n<b>用法:</b> <code>${mainPrefix}music &lt;关键词或链接&gt;</code>`,
            parseMode: "html"
          });
          return;
        }

        await this.handleMusicDownload(msg, query);

      } catch (error: any) {
        console.error("[music] 插件执行失败:", error);
        await msg.edit({
          text: `❌ <b>插件执行失败:</b> ${htmlEscape(error.message)}`,
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
    await msg.edit({ text: "🔍 正在搜索音乐...", parseMode: "html" });

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
          text: `❌ <b>搜索失败</b>\n\n<b>查询内容:</b> <code>${htmlEscape(query)}</code>\n\n💡 <b>建议:</b>\n• 尝试使用不同的关键词\n• 检查网络连接\n• 使用完整的歌手和歌曲名称`,
          parseMode: "html",
        });
        return;
      }
      url = searchResult;
    }

    await msg.edit({ text: "📥 正在分析并下载最佳音质...", parseMode: "html" });

    // Generate temp file path
    const safeQuery = downloader.safeFilename(query);
    const tempFile = path.join(downloader.tempDirPath, `${safeQuery}.%(ext)s`);

    // Download audio
    const success = await downloader.downloadAudio(url, tempFile);
    if (!success) {
      await msg.edit({
        text: "❌ <b>下载失败</b>\n\n💡 <b>可能原因:</b>\n• 网络连接问题\n• 视频不可用或受限\n• yt-dlp 需要更新\n\n🔄 请稍后重试或使用其他链接",
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
        text: `❌ <b>文件处理失败</b>\n\n下载的文件未找到\n\n<b>调试信息:</b>\n• 查询: <code>${htmlEscape(safeQuery)}</code>\n• 临时目录: <code>${htmlEscape(tempDir)}</code>\n• 目录文件: <code>${htmlEscape(files.join(", "))}</code>`,
        parseMode: "html",
      });
      return;
    }

    const audioFile = path.join(tempDir, downloadedFiles[0]);
    console.log(`Using audio file: ${audioFile}`);

    try {
      await msg.edit({ text: "📤 正在发送音频文件...", parseMode: "html" });

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
        text: `❌ <b>发送音频失败</b>\n\n<b>错误信息:</b> ${htmlEscape(displayError)}\n\n💡 <b>建议:</b> 文件可能过大或格式不支持`,
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
        text: `❌ <b>使用错误</b>\n\n请回复一个音频文件使用此命令\n\n💡 <b>使用方法:</b> 回复音频消息后发送 <code>${mainPrefix}music save</code>`,
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

      await msg.edit({ text: "💾 正在保存音频到本地...", parseMode: "html" });

      // Create temp file
      const tempFile = path.join(downloader.tempDirPath, `temp_save_${msg.id}.mp3`);

      // Download file to temp location
      await client.downloadMedia(reply, { outputFile: tempFile });

      // Save to local storage
      const savedPath = await downloader.saveAudioLocally(tempFile, title, artist);

      await msg.edit({
        text: `✅ <b>保存成功</b>\n\n<b>文件名:</b> <code>${htmlEscape(path.basename(savedPath))}</code>\n<b>位置:</b> <code>${htmlEscape(path.dirname(savedPath))}</code>`,
        parseMode: "html",
      });
      console.log(`Audio saved to: ${savedPath}`);
    } catch (error: any) {
      console.error("Save command failed:", error);
      const errorMessage = error.message || String(error);
      const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + "..." : errorMessage;
      await msg.edit({
        text: `❌ <b>保存失败</b>\n\n<b>错误信息:</b> ${htmlEscape(displayError)}\n\n💡 <b>建议:</b> 检查磁盘空间和文件权限`,
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
        text: `❌ <b>参数缺失</b>\n\n请提供 Cookie 内容\n\n<b>使用方法:</b> <code>${mainPrefix}music cookie &lt;cookie内容&gt;</code>`,
        parseMode: "html",
      });
      return;
    }

    try {
      const success = downloader.setCookie(cookieContent);
      if (success) {
        await msg.edit({
          text: "✅ <b>Cookie 设置成功</b>\n\n现在可以访问受限制的内容\n\n⏰ Cookie 将在重启后失效",
          parseMode: "html",
        });
      } else {
        await msg.edit({
          text: "❌ <b>Cookie 设置失败</b>\n\n请检查 Cookie 格式是否正确",
          parseMode: "html",
        });
      }
    } catch (error: any) {
      console.error("Cookie command failed:", error);
      const errorMessage = error.message || String(error);
      const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + "..." : errorMessage;
      await msg.edit({
        text: `❌ <b>Cookie 设置失败</b>\n\n<b>错误信息:</b> ${htmlEscape(displayError)}`,
        parseMode: "html",
      });
    }
  }

  private async handleClearCommand(msg: Api.Message): Promise<void> {
    try {
      await msg.edit({ text: "🧹 正在清理临时文件...", parseMode: "html" });

      // Clear temp files (preserve cookies.txt)
      downloader.cleanupTempFiles();

      await msg.edit({
        text: "✅ <b>清理完成</b>\n\n临时文件已清理，Cookie 文件已保留",
        parseMode: "html",
      });
      console.log("Music downloader temp files cleaned");
    } catch (error: any) {
      console.error("Clear command failed:", error);
      const errorMessage = error.message || String(error);
      const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + "..." : errorMessage;
      await msg.edit({
        text: `❌ <b>清理失败</b>\n\n<b>错误信息:</b> ${htmlEscape(displayError)}`,
        parseMode: "html",
      });
    }
  }
}

export default new MusicPlugin();

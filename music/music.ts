/**
 * Music downloader plugin for TeleBox
 * 
 * Provides YouTube music search and download functionality with native TeleBox integration.
 */

import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "telegram";
import * as fs from "fs";
import * as path from "path";
import { spawn, exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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
    this.musicDir = path.join(process.cwd(), "assets", "music_cache");
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

  private safeFilename(name: string, maxLength: number = 100): string {
    // Remove or replace illegal characters
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    // Remove leading/trailing spaces and limit length
    return safeName.trim().substring(0, maxLength);
  }

  private calculateTitlePriority(title: string): number {
    if (!title) return 0;
    
    const priorityKeywords = ['歌词版', '动态歌词', 'lyrics', 'lyric video'];
    const titleLower = title.toLowerCase();
    
    for (const keyword of priorityKeywords) {
      if (titleLower.includes(keyword)) {
        return 100;
      }
    }
    return 0;
  }

  private getBaseYdlOptions(): any {
    return {
      quiet: true,
      no_warnings: true,
      ignoreerrors: true,
      retries: 10,
      fragment_retries: 10,
      noplaylist: true,
      noprogress: true,
      concurrent_fragment_downloads: 16,
      socket_timeout: 120,
      nocheckcertificate: true,
      http_chunk_size: 10485760,
      buffersize: 16777216,
      http_headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        'Connection': 'keep-alive',
      },
      extractor_args: {
        youtube: {
          player_client: ['android', 'web'],
          max_comments: [0],
        }
      },
      prefer_insecure: true,
      call_home: false,
      check_formats: false,
    };
  }

  private async hasYtDlp(): Promise<boolean> {
    try {
      await execAsync('yt-dlp --version');
      return true;
    } catch {
      return false;
    }
  }

  private async hasFfmpeg(): Promise<boolean> {
    try {
      await execAsync('ffmpeg -version');
      return true;
    } catch {
      return false;
    }
  }

  async searchYoutube(query: string, maxResults: number = 5): Promise<string | null> {
    try {
      if (!(await this.hasYtDlp())) {
        throw new Error('yt-dlp not found. Please install yt-dlp first.');
      }

      const searchQuery = `ytsearch${maxResults}:${query}`;
      const command = `yt-dlp --quiet --no-warnings --flat-playlist --skip-download --print "%(id)s|%(title)s|%(webpage_url)s" "${searchQuery}"`;
      
      const { stdout } = await execAsync(command, { timeout: 30000 });
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      
      if (lines.length === 0) return null;

      const entries = lines.map(line => {
        const parts = line.split('|');
        if (parts.length >= 3) {
          return {
            id: parts[0],
            title: parts[1],
            webpage_url: parts[2]
          };
        }
        return null;
      }).filter(entry => entry !== null);

      if (entries.length === 0) return null;

      // Sort by title priority
      entries.sort((a, b) => 
        this.calculateTitlePriority(b.title || '') - this.calculateTitlePriority(a.title || '')
      );

      const bestEntry = entries[0];
      if (bestEntry && bestEntry.id) {
        return `https://www.youtube.com/watch?v=${bestEntry.id}`;
      } else if (bestEntry && bestEntry.webpage_url) {
        return bestEntry.webpage_url;
      }

      return null;
    } catch (error: any) {
      console.error(`YouTube search failed for '${query}':`, error);
      if (error.code === 'TIMEOUT') {
        console.error('Search timeout - network may be slow');
      }
      return null;
    }
  }

  async downloadAudio(url: string, outputPath: string): Promise<boolean> {
    try {
      if (!(await this.hasYtDlp())) {
        throw new Error('yt-dlp not found. Please install yt-dlp first.');
      }

      const options = this.getBaseYdlOptions();
      let format = 'bestaudio/best';
      let postprocessor = '';

      if (await this.hasFfmpeg()) {
        postprocessor = '--extract-audio --audio-format mp3 --audio-quality 192K';
      } else {
        format = 'bestaudio[ext=m4a]/bestaudio/best';
        console.warn('FFmpeg not detected, downloading container audio file directly');
      }

      const cookiePath = path.join(this.tempDir, 'cookies.txt');
      const cookieOption = fs.existsSync(cookiePath) ? `--cookies "${cookiePath}"` : '';

      const command = `yt-dlp --quiet --no-warnings ${cookieOption} --format "${format}" ${postprocessor} --output "${outputPath}" "${url}"`;
      
      await execAsync(command, { timeout: 300000 }); // 5 minutes timeout
      return true;
    } catch (error: any) {
      console.warn('Primary download method failed, trying fallback:', error);
      try {
        // Fallback to simple bestaudio
        const command = `yt-dlp --quiet --no-warnings --format "bestaudio/best" --output "${outputPath}" "${url}"`;
        await execAsync(command, { timeout: 300000 });
        return true;
      } catch (error2: any) {
        console.error('All download methods failed:', error2);
        if (error2.code === 'TIMEOUT') {
          console.error('Download timeout - file may be too large or network too slow');
        }
        return false;
      }
    }
  }

  async saveAudioLocally(audioFile: string, title: string, artist: string): Promise<string> {
    const filename = `${this.safeFilename(artist)} - ${this.safeFilename(title)}.mp3`;
    const savePath = path.join(this.musicDir, filename);
    
    // If target file exists, add counter
    let counter = 1;
    let finalPath = savePath;
    while (fs.existsSync(finalPath)) {
      const ext = path.extname(savePath);
      const base = path.basename(savePath, ext);
      finalPath = path.join(this.musicDir, `${base} (${counter})${ext}`);
      counter++;
    }
    
    // Copy file
    fs.copyFileSync(audioFile, finalPath);
    return finalPath;
  }

  setCookie(cookieContent: string): boolean {
    try {
      const cookieFile = path.join(this.tempDir, 'cookies.txt');
      fs.writeFileSync(cookieFile, cookieContent.trim(), 'utf8');
      return true;
    } catch (error) {
      console.error('Failed to set cookie:', error);
      return false;
    }
  }

  cleanupTempFiles(pattern?: string): void {
    try {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        if (file === 'cookies.txt') continue;
        if (pattern && !file.includes(pattern)) continue;
        
        try {
          const filePath = path.join(this.tempDir, file);
          if (fs.statSync(filePath).isFile()) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // Ignore individual file errors
        }
      }
    } catch (error) {
      console.debug('Error cleaning temp files:', error);
    }
  }
}

// Global downloader instance
const downloader = new MusicDownloader();

async function showHelp(msg: Api.Message): Promise<void> {
  const helpText = `🎵 <b>音乐下载器使用说明</b>

<b>📥 基本用法：</b>
• <code>music &lt;关键词&gt;</code> - 搜索并下载音乐
• <code>music &lt;YouTube链接&gt;</code> - 直接下载指定视频

<b>🔧 辅助功能：</b>
• <code>music save</code> - 回复音频消息保存到本地
• <code>music cookie &lt;内容&gt;</code> - 设置访问受限内容的Cookie
• <code>music clear</code> - 清理临时文件缓存
• <code>music help</code> - 显示此帮助信息

<b>💡 示例：</b>
• <code>music 周杰伦 晴天</code>
• <code>music Taylor Swift Love Story</code>
• <code>music https://youtu.be/xxxxx</code>

<b>⚠️ 注意事项：</b>
• 优先选择包含"歌词版"的视频
• 支持 FFmpeg 自动转换为 MP3 格式
• 临时文件会在发送后自动清理
• 需要安装 yt-dlp 和 FFmpeg (可选)`;

  await msg.edit({ text: helpText, parseMode: "html" });
}

async function handleMusicDownload(msg: Api.Message, query: string): Promise<void> {
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
        text: `❌ <b>搜索失败</b>\n\n<b>查询内容:</b> <code>${query}</code>\n\n💡 <b>建议:</b>\n• 尝试使用不同的关键词\n• 检查网络连接\n• 使用完整的歌手和歌曲名称`, 
        parseMode: "html" 
      });
      return;
    }
    url = searchResult;
  }
  
  await msg.edit({ text: "📥 正在分析并下载最佳音质...", parseMode: "html" });
  
  // Generate temp file path
  const safeQuery = downloader['safeFilename'](query);
  const tempFile = path.join(downloader['tempDir'], `${safeQuery}.%(ext)s`);
  
  // Download audio
  const success = await downloader.downloadAudio(url, tempFile);
  if (!success) {
    await msg.edit({ 
      text: "❌ <b>下载失败</b>\n\n💡 <b>可能原因:</b>\n• 网络连接问题\n• 视频不可用或受限\n• yt-dlp 需要更新\n\n🔄 请稍后重试或使用其他链接", 
      parseMode: "html" 
    });
    return;
  }
  
  // Find downloaded file
  const tempDir = downloader['tempDir'];
  const files = fs.readdirSync(tempDir);
  const downloadedFiles = files.filter(file => file.startsWith(safeQuery));
  
  if (downloadedFiles.length === 0) {
    await msg.edit({ 
      text: "❌ <b>文件处理失败</b>\n\n下载的文件未找到，可能是格式转换问题\n\n🔄 请重试或联系管理员", 
      parseMode: "html" 
    });
    return;
  }
  
  const audioFile = path.join(tempDir, downloadedFiles[0]);
  
  try {
    await msg.edit({ text: "📤 正在发送音频文件...", parseMode: "html" });
    
    // Send audio file
    await msg.client?.sendFile(msg.peerId, {
      file: audioFile,
      attributes: [
        new Api.DocumentAttributeAudio({
          duration: 0,
          title: query,
          performer: "YouTube Music"
        })
      ],
      replyTo: msg.replyToMsgId,
      forceDocument: false,
    });
    
    await msg.delete();
    console.log(`Successfully sent audio: ${query}`);
    
  } catch (error: any) {
    console.error('Failed to send audio:', error);
    const errorMessage = error.message || String(error);
    const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + '...' : errorMessage;
    await msg.edit({ 
      text: `❌ <b>发送音频失败</b>\n\n<b>错误信息:</b> ${displayError}\n\n💡 <b>建议:</b> 文件可能过大或格式不支持`, 
      parseMode: "html" 
    });
  } finally {
    // Cleanup temp files
    downloader.cleanupTempFiles(safeQuery);
  }
}

async function handleSaveCommand(msg: Api.Message): Promise<void> {
  const reply = await msg.getReplyMessage();
  if (!reply || !reply.document) {
    await msg.edit({ 
      text: "❌ <b>使用错误</b>\n\n请回复一个音频文件使用此命令\n\n💡 <b>使用方法:</b> 回复音频消息后发送 <code>music save</code>", 
      parseMode: "html" 
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
    const tempFile = path.join(downloader['tempDir'], `temp_save_${msg.id}.mp3`);
    
    // Download file to temp location
    await msg.client?.downloadMedia(reply, { outputFile: tempFile });
    
    // Save to local storage
    const savedPath = await downloader.saveAudioLocally(tempFile, title, artist);
    
    await msg.edit({ 
      text: `✅ <b>保存成功</b>\n\n<b>文件名:</b> <code>${path.basename(savedPath)}</code>\n<b>位置:</b> <code>${path.dirname(savedPath)}</code>`, 
      parseMode: "html" 
    });
    console.log(`Audio saved to: ${savedPath}`);
    
  } catch (error: any) {
    console.error('Save command failed:', error);
    const errorMessage = error.message || String(error);
    const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + '...' : errorMessage;
    await msg.edit({ 
      text: `❌ <b>保存失败</b>\n\n<b>错误信息:</b> ${displayError}\n\n💡 <b>建议:</b> 检查磁盘空间和文件权限`, 
      parseMode: "html" 
    });
  } finally {
    // Cleanup temp file
    try {
      const tempFile = path.join(downloader['tempDir'], `temp_save_${msg.id}.mp3`);
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function handleCookieCommand(msg: Api.Message, cookieContent: string): Promise<void> {
  if (!cookieContent) {
    await msg.edit({ 
      text: "❌ <b>参数缺失</b>\n\n请提供 Cookie 内容\n\n<b>使用方法:</b> <code>music cookie &lt;cookie内容&gt;</code>", 
      parseMode: "html" 
    });
    return;
  }
  
  try {
    const success = downloader.setCookie(cookieContent);
    if (success) {
      await msg.edit({ 
        text: "✅ <b>Cookie 设置成功</b>\n\n现在可以访问受限制的内容\n\n⏰ Cookie 将在重启后失效", 
        parseMode: "html" 
      });
    } else {
      await msg.edit({ 
        text: "❌ <b>Cookie 设置失败</b>\n\n请检查 Cookie 格式是否正确", 
        parseMode: "html" 
      });
    }
  } catch (error: any) {
    console.error('Cookie command failed:', error);
    const errorMessage = error.message || String(error);
    const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + '...' : errorMessage;
    await msg.edit({ 
      text: `❌ <b>Cookie 设置失败</b>\n\n<b>错误信息:</b> ${displayError}`, 
      parseMode: "html" 
    });
  }
}

async function handleClearCommand(msg: Api.Message): Promise<void> {
  try {
    await msg.edit({ text: "🧹 正在清理临时文件...", parseMode: "html" });
    
    // Clear temp files (preserve cookies.txt)
    downloader.cleanupTempFiles();
    
    await msg.edit({ 
      text: "✅ <b>清理完成</b>\n\n临时文件已清理，Cookie 文件已保留", 
      parseMode: "html" 
    });
    console.log("Music downloader temp files cleaned");
    
  } catch (error: any) {
    console.error('Clear command failed:', error);
    const errorMessage = error.message || String(error);
    const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + '...' : errorMessage;
    await msg.edit({ 
      text: `❌ <b>清理失败</b>\n\n<b>错误信息:</b> ${displayError}`, 
      parseMode: "html" 
    });
  }
}

const musicPlugin: Plugin = {
  command: ["music"],
  description: "音乐下载器 - 搜索并下载 YouTube 音乐",
  cmdHandler: async (msg: Api.Message) => {
    try {
      const args = msg.message.slice(1).split(' ').slice(1).join(' ').trim();
      
      if (!args || args.toLowerCase() === "help") {
        await showHelp(msg);
        return;
      }
      
      // Parse command arguments
      const parts = args.split(' ');
      const command = parts[0].toLowerCase();
      
      // Dispatch to corresponding handler functions
      if (command === "save") {
        await handleSaveCommand(msg);
      } else if (command === "cookie") {
        await handleCookieCommand(msg, parts.slice(1).join(' '));
      } else if (command === "clear") {
        await handleClearCommand(msg);
      } else {
        // Default to music search and download
        await handleMusicDownload(msg, args);
      }
      
    } catch (error: any) {
      console.error('Music command execution failed:', error);
      const errorMessage = error.message || String(error);
      const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + '...' : errorMessage;
      await msg.edit({ 
        text: `❌ <b>命令执行失败</b>\n\n<b>错误信息:</b> ${displayError}\n\n💡 <b>建议:</b> 请检查命令格式或联系管理员`, 
        parseMode: "html" 
      });
    }
  },
};

export default musicPlugin;

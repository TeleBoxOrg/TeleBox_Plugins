/**
 * Convert plugin for TeleBox
 * 
 * 将回复的视频消息转换为 MP3 音频文件
 * 使用方法：回复一个视频消息，然后发送 .convert 命令
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

class VideoConverter {
  private tempDir: string;
  private outputDir: string;

  constructor() {
    this.tempDir = path.join(process.cwd(), "temp", "convert");
    this.outputDir = createDirectoryInAssets("convert_output");
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  safeFilename(filename: string): string {
    return filename
      .replace(/[^\w\s.-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50);
  }

  async convertVideoToMp3(inputPath: string, outputPath: string): Promise<boolean> {
    try {
      // 使用 FFmpeg 将视频转换为 MP3
      const cmd = `ffmpeg -i "${inputPath}" -vn -acodec libmp3lame -ab 192k -ar 44100 -y "${outputPath}"`;
      
      console.log(`执行转换命令: ${cmd}`);
      await execAsync(cmd, { timeout: 300000 }); // 5分钟超时
      
      return fs.existsSync(outputPath);
    } catch (error) {
      console.error("视频转换失败:", error);
      return false;
    }
  }

  async getVideoDuration(filePath: string): Promise<number> {
    try {
      const cmd = `ffprobe -v quiet -show_entries format=duration -of csv="p=0" "${filePath}"`;
      const { stdout } = await execAsync(cmd);
      return parseFloat(stdout.trim()) || 0;
    } catch (error) {
      console.error("获取视频时长失败:", error);
      return 0;
    }
  }

  getTempDir(): string {
    return this.tempDir;
  }

  cleanupTempFiles(pattern?: string): void {
    try {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        if (pattern && !file.includes(pattern)) continue;
        
        const filePath = path.join(this.tempDir, file);
        try {
          fs.unlinkSync(filePath);
          console.debug(`清理临时文件: ${file}`);
        } catch (err) {
          console.debug(`删除文件失败 ${file}:`, err);
        }
      }
    } catch (error) {
      console.debug("清理临时文件出错:", error);
    }
  }
}

// 全局转换器实例
const converter = new VideoConverter();

// 帮助文档
const help_text = `🎬 <b>视频转音频插件</b>

<b>📥 使用方法：</b>
• 回复一个视频消息
• 发送 <code>${mainPrefix}convert</code> 命令
• 等待转换完成并接收 MP3 文件

<b>✅ 支持格式：</b>
• 所有 Telegram 支持的视频格式
• 自动提取音频轨道
• 输出为高质量 MP3 (192kbps)

<b>⚠️ 注意事项：</b>
• 仅对视频消息有效，文字消息无效
• 需要系统安装 FFmpeg
• 转换时间取决于视频长度
• 临时文件会自动清理

<b>🔧 其他命令：</b>
• <code>${mainPrefix}convert help</code> - 显示此帮助信息
• <code>${mainPrefix}convert clear</code> - 清理临时文件`;

class ConvertPlugin extends Plugin {
  description: string = `视频转音频插件 - 将回复的视频消息转换为 MP3 音频`;
  
  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    convert: async (msg: Api.Message, trigger?: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      // 参数解析
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();

      try {
        // 显示帮助信息
        if (sub === "help" || sub === "h") {
          await msg.edit({
            text: help_text,
            parseMode: "html"
          });
          return;
        }

        // 清理临时文件
        if (sub === "clear") {
          await this.handleClearCommand(msg);
          return;
        }

        // 主要转换功能
        await this.handleVideoConversion(msg);

      } catch (error: any) {
        console.error("[convert] 插件执行失败:", error);
        await msg.edit({
          text: `❌ <b>插件执行失败:</b> ${htmlEscape(error.message)}`,
          parseMode: "html"
        });
      }
    }
  };

  private async handleVideoConversion(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    // 检查是否回复了消息
    const reply = await msg.getReplyMessage();
    if (!reply) {
      await msg.edit({
        text: `❌ <b>使用错误</b>\n\n请回复一个视频消息使用此命令\n\n💡 <b>使用方法:</b> 回复视频消息后发送 <code>${mainPrefix}convert</code>`,
        parseMode: "html"
      });
      return;
    }

    // 检查回复的消息是否包含视频
    if (!reply.document && !reply.video) {
      await msg.edit({
        text: `❌ <b>消息类型错误</b>\n\n回复的消息不是视频文件\n\n💡 <b>提示:</b> 只能转换视频消息，文字消息无效`,
        parseMode: "html"
      });
      return;
    }

    // 检查是否为视频文件
    let isVideo = false;
    let fileName = "video";
    let fileSize = 0;

    if (reply.video) {
      isVideo = true;
      fileName = "telegram_video";
      fileSize = Number(reply.video.size) || 0;
    } else if (reply.document) {
      // 检查文档是否为视频
      const mimeType = reply.document.mimeType || "";
      const docFileName = reply.document.attributes?.find(
        attr => attr instanceof Api.DocumentAttributeFilename
      )?.fileName || "document";
      
      if (mimeType.startsWith("video/") || 
          /\.(mp4|avi|mkv|mov|wmv|flv|webm|m4v)$/i.test(docFileName)) {
        isVideo = true;
        fileName = docFileName;
        fileSize = Number(reply.document.size) || 0;
      }
    }

    if (!isVideo) {
      await msg.edit({
        text: `❌ <b>文件类型不支持</b>\n\n回复的文件不是视频格式\n\n✅ <b>支持的格式:</b> MP4, AVI, MKV, MOV, WMV, FLV, WebM, M4V`,
        parseMode: "html"
      });
      return;
    }

    // 检查文件大小（限制为 100MB）
    const maxSize = 100 * 1024 * 1024; // 100MB
    if (fileSize > maxSize) {
      const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
      await msg.edit({
        text: `❌ <b>文件过大</b>\n\n文件大小: ${sizeMB} MB\n最大支持: 100 MB\n\n💡 <b>建议:</b> 请使用较小的视频文件`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: "📥 正在下载视频文件...", parseMode: "html" });

    // 生成临时文件路径
    const timestamp = Date.now();
    const safeFileName = converter.safeFilename(fileName);
    const tempVideoPath = path.join(converter.getTempDir(), `video_${timestamp}_${safeFileName}`);
    const tempAudioPath = path.join(converter.getTempDir(), `audio_${timestamp}.mp3`);

    try {
      // 下载视频文件
      await client.downloadMedia(reply, { outputFile: tempVideoPath });
      
      if (!fs.existsSync(tempVideoPath)) {
        throw new Error("视频文件下载失败");
      }

      await msg.edit({ text: "🔄 正在转换为 MP3 音频...", parseMode: "html" });

      // 获取视频时长
      const duration = await converter.getVideoDuration(tempVideoPath);
      
      // 转换视频为 MP3
      const success = await converter.convertVideoToMp3(tempVideoPath, tempAudioPath);
      
      if (!success) {
        throw new Error("视频转换失败，请检查 FFmpeg 是否已安装");
      }

      if (!fs.existsSync(tempAudioPath)) {
        throw new Error("转换后的音频文件未找到");
      }

      await msg.edit({ text: "📤 正在发送 MP3 文件...", parseMode: "html" });

      // 获取音频文件信息
      const audioStats = fs.statSync(tempAudioPath);
      const audioSizeMB = (audioStats.size / (1024 * 1024)).toFixed(2);

      // 生成音频文件名
      const audioFileName = `${converter.safeFilename(fileName.replace(/\.[^.]+$/, ""))}.mp3`;

      // 发送音频文件
      await client.sendFile(msg.peerId, {
        file: tempAudioPath,
        attributes: [
          new Api.DocumentAttributeAudio({
            duration: Math.round(duration),
            title: audioFileName,
            performer: "Video Converter",
          }),
        ],
        replyTo: msg.replyToMsgId,
        forceDocument: false,
      });

      // 发送成功消息
      await msg.edit({
        text: `✅ <b>转换完成</b>\n\n📁 <b>文件名:</b> <code>${htmlEscape(audioFileName)}</code>\n⏱️ <b>时长:</b> ${Math.round(duration)} 秒\n📦 <b>大小:</b> ${audioSizeMB} MB\n🎵 <b>格式:</b> MP3 (192kbps)`,
        parseMode: "html"
      });

      console.log(`视频转换成功: ${fileName} -> ${audioFileName}`);

    } catch (error: any) {
      console.error("视频转换失败:", error);
      const errorMessage = error.message || String(error);
      const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + "..." : errorMessage;
      
      await msg.edit({
        text: `❌ <b>转换失败</b>\n\n<b>错误信息:</b> ${htmlEscape(displayError)}\n\n💡 <b>可能原因:</b>\n• FFmpeg 未安装或配置错误\n• 视频文件损坏\n• 磁盘空间不足\n• 网络连接问题`,
        parseMode: "html"
      });
    } finally {
      // 清理临时文件
      try {
        if (fs.existsSync(tempVideoPath)) {
          fs.unlinkSync(tempVideoPath);
        }
        if (fs.existsSync(tempAudioPath)) {
          fs.unlinkSync(tempAudioPath);
        }
      } catch (cleanupError) {
        console.debug("清理临时文件失败:", cleanupError);
      }
    }
  }

  private async handleClearCommand(msg: Api.Message): Promise<void> {
    try {
      await msg.edit({ text: "🧹 正在清理临时文件...", parseMode: "html" });

      // 清理所有临时文件
      converter.cleanupTempFiles();

      await msg.edit({
        text: "✅ <b>清理完成</b>\n\n临时文件已清理",
        parseMode: "html"
      });
      console.log("Convert plugin 临时文件已清理");
    } catch (error: any) {
      console.error("Clear command failed:", error);
      const errorMessage = error.message || String(error);
      const displayError = errorMessage.length > 100 ? errorMessage.substring(0, 100) + "..." : errorMessage;
      await msg.edit({
        text: `❌ <b>清理失败</b>\n\n<b>错误信息:</b> ${htmlEscape(displayError)}`,
        parseMode: "html"
      });
    }
  }
}

export default new ConvertPlugin();

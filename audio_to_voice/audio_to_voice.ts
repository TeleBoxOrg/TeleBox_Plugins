import { Plugin } from "../src/utils/pluginBase";
import { getGlobalClient } from "../src/utils/globalClient";
import { Api } from "telegram";
import fs from "fs";
import path from "path";
import { createDirectoryInTemp } from "../src/utils/pathHelpers";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);


class AudioToVoicePlugin extends Plugin {
  description: string = `🎙️ <b>音频转语音</b><br/><br/>
<b>命令</b><br/>
• <code>.audio_to_voice</code>（回复一条包含音乐的消息）<br/><br/>
<b>功能</b><br/>
• 将音乐文件转换为 Telegram 语音消息（OGG/Opus）<br/><br/>
<b>用法</b><br/>
1) 回复音乐文件发送 <code>.audio_to_voice</code><br/><br/>
<b>依赖</b><br/>
• 需要系统安装 FFmpeg`;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    "audio_to_voice": this.handleAudioToVoice.bind(this),
  };


  private async getAudio(msg: Api.Message): Promise<Api.Message | null> {
    const client = await getGlobalClient();
    if (!client) return null;


    if (msg.replyToMsgId) {
      const messages = await client.getMessages(msg.peerId!, {
        ids: [msg.replyToMsgId]
      });
      
      if (messages && messages.length > 0) {
        const replyMessage = messages[0];
        if (this.hasAudio(replyMessage)) {
          return replyMessage;
        }
      }
    }
    

    return this.hasAudio(msg) ? msg : null;
  }


  private hasAudio(msg: Api.Message): boolean {
    if (!msg.media || !(msg.media instanceof Api.MessageMediaDocument)) {
      return false;
    }

    const document = msg.media.document;
    if (!(document instanceof Api.Document)) {
      return false;
    }


    return document.mimeType?.startsWith('audio/') || 
           document.attributes?.some(attr => 
             attr instanceof Api.DocumentAttributeAudio && !attr.voice
           ) || false;
  }

  private async handleAudioToVoice(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化" });
      return;
    }

    try {

      const audioMessage = await this.getAudio(msg);
      if (!audioMessage) {
        await msg.edit({ text: "请回复一个音乐文件" });
        return;
      }


       const statusMsg = await msg.edit({ text: "转换中。。。" });
       if (!statusMsg) {
         console.error("Cannot edit message");
         return;
       }

       // 先检测 ffmpeg 是否可用
       try {
         await execAsync(`ffmpeg -version`);
       } catch {
         await statusMsg.edit({ text: "❌ 未检测到 ffmpeg，请先在系统安装 ffmpeg 后重试。macOS 可使用：brew install ffmpeg" });
         return;
       }

       const tempDir = createDirectoryInTemp("audio_to_voice");
       // 原始下载路径（无扩展名）
       const audioPath = path.join(tempDir, `audio_${Date.now()}`);
       const oggPath = path.join(tempDir, `voice_${Date.now()}.ogg`);

       try {
         // 下载音频文件
         await client.downloadMedia(audioMessage.media!, {
           outputFile: audioPath
         });

         // 使用 FFmpeg 转码为 OGG/Opus（Telegram 语音格式）
         // 48k-64k 比特率，48k 采样率，单声道
         const cmd = `ffmpeg -y -i "${audioPath}" -vn -acodec libopus -b:a 64k -ar 48000 -ac 1 "${oggPath}"`;
         try {
           await execAsync(cmd, { timeout: 180000 });
         } catch (e) {
           throw new Error(`FFmpeg 转码失败，请确认系统已安装 FFmpeg（macOS: brew install ffmpeg）。`);
         }

         if (!fs.existsSync(oggPath)) {
           throw new Error("转码后的语音文件未找到");
         }

         // 确定回复目标
         const replyToId = audioMessage === msg ? statusMsg.id : msg.replyToMsgId;
         
         // 发送语音笔记（必须是 audio/ogg + voice 属性）
         await client.sendFile(msg.peerId!, {
           file: oggPath,
           // mimeType: "audio/ogg", // 不需要显式指定，Telegram 会根据扩展名识别
           attributes: [
             new Api.DocumentAttributeAudio({
               duration: this.getAudioDuration(audioMessage),
               voice: true,
               waveform: Buffer.alloc(0)
             })
           ],
           replyTo: replyToId,
           forceDocument: false,
           voiceNote: true
         });


         // 清理临时文件
         this.safeRemove(audioPath);
         this.safeRemove(oggPath);
         
         // 清理状态消息，与Python版本逻辑一致
         if (audioMessage !== msg) {
           // 如果是回复的音频，删除状态消息
           try {
             await statusMsg.delete({ revoke: true });
           } catch (deleteError) {
             console.warn("删除状态消息失败:", deleteError);
           }
         } else {
           // 如果是消息本身的音频，清空消息内容
           try {
             await statusMsg.edit({ text: "" });
           } catch (editError) {
             console.warn("清空消息失败:", editError);
           }
         }
         
       } catch (error) {
         this.safeRemove(audioPath);
         this.safeRemove(oggPath);
         await statusMsg.edit({ text: `转换为语音消息失败：${error}` });
       }
      
    } catch (error) {
      console.error("AudioToVoice plugin error:", error);
      await msg.edit({ text: `转换为语音消息失败：${error}` });
    }
  }

  private safeRemove(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.warn(`删除文件失败 ${filePath}:`, error);
    }
  }

  private getAudioDuration(msg: Api.Message): number {
    if (!msg.media || !(msg.media instanceof Api.MessageMediaDocument)) {
      return 0;
    }

    const document = msg.media.document;
    if (!(document instanceof Api.Document)) {
      return 0;
    }

    const audioAttr = document.attributes?.find(attr => 
      attr instanceof Api.DocumentAttributeAudio
    ) as Api.DocumentAttributeAudio | undefined;
    
    return audioAttr?.duration || 0;
  }
}

export default new AudioToVoicePlugin();

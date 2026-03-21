import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs/promises";
import { statSync, existsSync } from "fs";
import { CustomFile } from 'teleproto/client/uploads';

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

interface UserConfig {
  target: string;
  showSource: boolean;  // 新增：来源显示配置
}

interface PrometheusDB {
  users: Record<string, UserConfig>;
}

const help_text = `🔥<b>Prometheus -突破Telegram保存限制</b>

<blockquote>"To defy Power, which seems omnipotent."
—Percy Bysshe Shelley, Prometheus Unbound</blockquote>

<b>📝 功能:</b>
• 突破"限制保存内容"，转发任何消息
• 支持批量处理多个消息链接
• 支持范围保存功能（自动保存指定范围内的所有消息）
• 支持来源显示功能
• 同时支持<code>${mainPrefix}prometheus</code>与<code>${mainPrefix}pms</code>

<b>🔧 使用方法:</b>

<b>设置默认目标:</b>
• <code>${mainPrefix}pms to [目标]</code> - 设置默认转发目标(支持用户名、chatid如-123456780、'me')
• <code>${mainPrefix}pms to me</code> - 重置为发给自己
• <code>${mainPrefix}pms target</code> - 查看当前目标

<b>来源显示控制:</b>
• <code>${mainPrefix}pms source on/off</code> - 开启/关闭来源显示功能
• <code>${mainPrefix}pms source</code> - 查看当前来源显示状态

<b>转发消息:</b>
• <code>${mainPrefix}pms</code> - 回复要转发的消息
• <code>${mainPrefix}pms [链接1] [链接2] ...</code> - 批量转发
• <code>${mainPrefix}pms [链接] [临时目标]</code> - 临时转发到指定对话
• <code>${mainPrefix}pms [链接1]|[链接2]</code> - 保存两个链接之间的所有消息（支持不连续编号，自动跳过不存在消息）

<b>💡 示例:</b>
• <code>${mainPrefix}pms to @group</code> - 设置默认目标
• <code>${mainPrefix}pms to -123456780</code> - 设置chatid为目标
• <code>${mainPrefix}pms</code> - 回复消息进行转发
• <code>${mainPrefix}pms https://t.me/c/123/1 https://t.me/c/123/2</code> - 批量转发
• <code>${mainPrefix}pms https://t.me/c/123/1 @username</code> - 转发到指定用户
• <code>${mainPrefix}pms t.me/c/123/1|t.me/c/123/100</code> - 自动保存123群组/频道内1-100号消息

<b>📊 支持类型:</b>
• 文本、图片、视频、音频、语音
• 文档、贴纸、GIF动画
• 轮播相册、链接预览
• 投票、地理位置`;

class PrometheusPlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  name = "prometheus";
  description = help_text;
  
  private tempDir = createDirectoryInTemp("prometheus");
  private db: any = null;
  private lastEditText: Map<string, string> = new Map();
  
  constructor() {
    super();
    this.initDB();
  }
  
  // 安全编辑（防 MESSAGE_EMPTY）
  private async safeEditMessage(
    msg: Api.Message,
    text: string,
    force: boolean = false
  ): Promise<void> {
    const msgId = `${msg.chatId}_${msg.id}`;
    const lastText = this.lastEditText.get(msgId);

    // 关键兜底：绝对不给空字符串
    const safeText = text?.trim() || ' '; // 用不可见空格占位
    if (!force && lastText === safeText) return;

    try {
      await msg.edit({ text: safeText, parseMode: 'html' });
      this.lastEditText.set(msgId, safeText);
    } catch (err: any) {
      if (err.message?.includes('MESSAGE_NOT_MODIFIED')) {
        this.lastEditText.set(msgId, safeText);
        return;
      }
      throw err;
    }
  }
  
  private async initDB(): Promise<void> {
    try {
      const dbPath = path.join(createDirectoryInAssets("prometheus"), "config.json");
      this.db = await JSONFilePreset<PrometheusDB>(dbPath, { users: {} });
    } catch (error) {
      console.error(`初始化数据库失败:`, error);
    }
  }
  
  private async getUserConfig(userId: string): Promise<UserConfig> {
    await this.initDB();
    if (!this.db.data.users[userId]) {
      this.db.data.users[userId] = { 
        target: "me",
        showSource: false  // 默认关闭来源显示
      };
      await this.db.write();
    }
    return this.db.data.users[userId];
  }
  
  private async setUserConfig(userId: string, config: Partial<UserConfig>): Promise<void> {
    await this.initDB();
    if (!this.db.data.users[userId]) {
      this.db.data.users[userId] = { 
        target: "me",
        showSource: false
      };
    }
    Object.assign(this.db.data.users[userId], config);
    await this.db.write();
  }
  
  // 生成消息跳转链接
  private generateMessageLink(chatId: string, messageId: number): string {
    // 处理私有频道的chatId转换
    let linkChatId = chatId;
    
    // 如果chatId是数字字符串（可能为负数）
    if (/^-?\d+$/.test(chatId)) {
      // 如果以-100开头，需要去掉-100前缀
      if (chatId.startsWith('-100')) {
        linkChatId = `-${chatId.substring(4)}`;
      } else if (!chatId.startsWith('-') && parseInt(chatId) > 0) {
        // 正数且不是频道格式，加上-100前缀
        linkChatId = `-100${chatId}`;
      }
      
      // 最终格式：去掉-100前缀后的负号格式
      if (linkChatId.startsWith('-100')) {
        linkChatId = `-${linkChatId.substring(4)}`;
      }
      
      return `https://t.me/c/${linkChatId}/${messageId}`;
    }
    
    // 如果是用户名格式，直接使用
    return `https://t.me/${chatId}/${messageId}`;
  }
  
  // 发送来源消息（回复指定的消息）
  private async sendSourceMessage(
    targetPeer: any,
    sourceChatId: string,
    sourceMessageId: number,
    forwardedMsg: Api.Message,
    replyMsg?: Api.Message
  ): Promise<void> {
    try {
      const client = await getGlobalClient();
      const sourceLink = this.generateMessageLink(sourceChatId, sourceMessageId);
      
      const sourceText = `🔗 <b>消息来源</b>\n\n` +
                        `📝 <a href="${htmlEscape(sourceLink)}">查看原消息</a>\n` +
                        `👤 来源对话: <code>${htmlEscape(sourceChatId)}</code>\n` +
                        `#️⃣ 消息ID: <code>${sourceMessageId}</code>`;
      
      // 回复转发的消息
      await client.sendMessage(targetPeer, {
        message: sourceText,
        parseMode: 'html',
        replyTo: forwardedMsg.id
      });
      
      if (replyMsg) {
        await this.safeEditMessage(replyMsg, `✅ 已转发并添加来源链接`, true);
      }
    } catch (error) {
      console.error(`发送来源消息失败:`, error);
      // 不中断主流程，只是来源消息发送失败
    }
  }
  
  private parseMessageLink(link: string): { chatId: string; messageId: number } | null {
    const cleanLink = link.split('?')[0];
    
    const patterns = [
      /(?:https?:\/\/)?t\.me\/c\/(-?\d+)\/(\d+)/,
      /(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]+)\/(\d+)/,
    ];
    
    for (const pattern of patterns) {
      const match = cleanLink.match(pattern);
      if (match) {
        let chatId = match[1];
        const messageId = parseInt(match[2]);
        
        if (/^-?\d+$/.test(chatId) && !chatId.startsWith('-100') && chatId.startsWith('-')) {
          chatId = `-100${chatId.substring(1)}`;
        } else if (/^\d+$/.test(chatId) && parseInt(chatId) > 0) {
          chatId = `-100${chatId}`;
        }
        
        return { chatId, messageId };
      }
    }
    
    return null;
  }
  
  private async getMessage(chatId: string, messageId: number): Promise<Api.Message | null> {
    try {
      const client = await getGlobalClient();
      const peer = await client.getInputEntity(chatId);
      const messages = await client.getMessages(peer, { ids: [messageId] });
      return messages[0] || null;
    } catch (error) {
      console.error(`获取消息失败:`, error);
      return null;
    }
  }
  
  private getFileExtension(media: Api.TypeMessageMedia): string {
    try {
      if (media instanceof Api.MessageMediaPhoto) {
        return '.jpg';
      } else if (media instanceof Api.MessageMediaDocument) {
        const document = media.document as Api.Document;
        
        if (document.mimeType) {
          const mimeType = document.mimeType.toLowerCase();
          if (mimeType.includes('video/mp4')) return '.mp4';
          if (mimeType.includes('video/webm')) return '.webm';
          if (mimeType.includes('video/quicktime')) return '.mov';
          if (mimeType.includes('audio/mpeg')) return '.mp3';
          if (mimeType.includes('audio/ogg')) return '.ogg';
          if (mimeType.includes('image/jpeg') || mimeType.includes('image/jpg')) return '.jpg';
          if (mimeType.includes('image/png')) return '.png';
          if (mimeType.includes('image/gif')) return '.gif';
          if (mimeType.includes('image/webp')) return '.webp';
        }
        
        for (const attr of document.attributes) {
          if (attr instanceof Api.DocumentAttributeFilename) {
            const ext = path.extname(attr.fileName).toLowerCase();
            if (ext) return ext;
          }
        }
        
        for (const attr of document.attributes) {
          if (attr instanceof Api.DocumentAttributeVideo) return '.mp4';
          if (attr instanceof Api.DocumentAttributeAudio) return attr.voice ? '.ogg' : '.mp3';
          if (attr instanceof Api.DocumentAttributeSticker) return '.webp';
          if (attr instanceof Api.DocumentAttributeAnimated) return '.gif';
        }
      }
    } catch (error) {
      console.error(`获取文件扩展名失败:`, error);
    }
    
    return '.bin';
  }
  
  private getMediaType(media: Api.TypeMessageMedia): string {
    try {
      if (media instanceof Api.MessageMediaPhoto) {
        return 'photo';
      } else if (media instanceof Api.MessageMediaDocument) {
        const document = media.document as Api.Document;
        
        for (const attr of document.attributes) {
          if (attr instanceof Api.DocumentAttributeVideo) return 'video';
          if (attr instanceof Api.DocumentAttributeAudio) return attr.voice ? 'voice' : 'audio';
          if (attr instanceof Api.DocumentAttributeSticker) return 'sticker';
          if (attr instanceof Api.DocumentAttributeAnimated) return 'gif';
        }
        
        if (document.mimeType?.includes('video/')) return 'video';
        if (document.mimeType?.includes('audio/')) return 'audio';
        if (document.mimeType?.includes('image/')) return 'photo';
      }
    } catch (error) {
      console.error(`获取媒体类型失败:`, error);
    }
    
    return 'document';
  }
  
  private async downloadMedia(message: Api.Message, index: number = 0, replyMsg?: Api.Message): Promise<{ 
    path: string; 
    type: string;
    caption?: string;
    fileName?: string;
  } | null> {
    try {
      const client = await getGlobalClient();
      
      if (!message.media) return null;
      
      const mediaType = this.getMediaType(message.media);
      const extension = this.getFileExtension(message.media);
      
      const timestamp = Date.now();
      let fileName = `${mediaType}_${timestamp}_${index}`;
      
      if (message.media instanceof Api.MessageMediaDocument) {
        const document = message.media.document as Api.Document;
        for (const attr of document.attributes) {
          if (attr instanceof Api.DocumentAttributeFilename) {
            const baseName = path.parse(attr.fileName).name;
            if (baseName) fileName = baseName;
            break;
          }
        }
      }
      
      const safeName = fileName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      const finalFileName = `${safeName}${extension}`;
      const filePath = path.join(this.tempDir, finalFileName);
      
      let finalFilePath = filePath;
      let counter = 1;
      while (existsSync(finalFilePath)) {
        const baseName = path.parse(safeName).name;
        finalFilePath = path.join(this.tempDir, `${baseName}_${counter}${extension}`);
        counter++;
      }
      
      if (replyMsg) {
        await this.safeEditMessage(replyMsg, `⏬ 下载媒体文件 (${index + 1})...`);
      }
      
      const buffer = await client.downloadMedia(message.media, {});
      if (buffer && buffer.length > 0) {
        await fs.writeFile(finalFilePath, buffer);
      } else {
        return null;
      }
      
      if (!existsSync(finalFilePath)) {
        return null;
      }
      
      const stats = statSync(finalFilePath);
      if (stats.size === 0) {
        return null;
      }
      
      return {
        path: finalFilePath,
        type: mediaType,
        caption: message.text || undefined,
        fileName: path.basename(finalFilePath),
      };
      
    } catch (error: any) {
      console.error(`下载媒体失败:`, error);
      return null;
    }
  }
  
  private async cleanupTempFile(filePath: string | null): Promise<void> {
    if (filePath && existsSync(filePath)) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        console.error(`清理临时文件失败:`, error);
      }
    }
  }
  
  private async sendSingleMedia(
    client: any,
    targetPeer: any,
    mediaInfo: { 
      path: string; 
      type: string; 
      caption?: string;
      fileName?: string;
    },
    replyMsg?: Api.Message
  ): Promise<Api.Message> {
    const { path: filePath, type, caption, fileName } = mediaInfo;
    
    if (!existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }
    
    const sendOptions: any = {
      file: filePath,
      forceDocument: false
    };
    
    if (caption && type !== 'voice' && type !== 'sticker') {
      sendOptions.caption = caption;
      sendOptions.parseMode = caption.includes('<') ? 'html' : undefined;
    }
    
    if (replyMsg) {
      await this.safeEditMessage(replyMsg, `📤 上传 ${type}...`);
    }
    
    return await client.sendFile(targetPeer, sendOptions);
  }
  
  private async processMessage(
    sourceMsg: Api.Message, 
    targetPeer: any, 
    replyMsg: Api.Message,
    sourceChatId: string,
    sourceMessageId: number,
    showSource: boolean,
    progress: string = ""
  ): Promise<{ success: boolean; forwardedMsg?: Api.Message }> {
    const client = await getGlobalClient();
    let tempFileInfo: any = null;
    let forwardedMessage: Api.Message | undefined;
    
    try {
      await this.safeEditMessage(replyMsg, `${progress}🔄 尝试直接转发...`, true);
      
      try {
        // 直接转发，获取转发的消息
        const result = await client.forwardMessages(targetPeer, {
          messages: [sourceMsg.id],
          fromPeer: sourceMsg.peerId
        });
        forwardedMessage = result[0];
        
        await this.safeEditMessage(replyMsg, `${progress}✅ 转发成功`, true);
        
        // 如果开启了来源显示，发送来源消息
        if (showSource && forwardedMessage) {
          await this.sendSourceMessage(targetPeer, sourceChatId, sourceMessageId, forwardedMessage, replyMsg);
        } else {
          return { success: true, forwardedMsg: forwardedMessage };
        }
        
        return { success: true, forwardedMsg: forwardedMessage };
      } catch (forwardError: any) {
        const errorMsg = forwardError.message || '';
        const isRestricted = errorMsg.includes('SAVE') || 
                           errorMsg.includes('FORWARD') || 
                           errorMsg.includes('CHAT_FORWARDS_RESTRICTED');
        
        if (!isRestricted) throw forwardError;
        
        if (!sourceMsg.media) {
          const text = sourceMsg.text || '';
          if (text) {
            // 发送文本消息，获取发送的消息
            forwardedMessage = await client.sendMessage(targetPeer, {
              message: text,
              parseMode: sourceMsg.text?.includes('<') ? 'html' : undefined
            });
            
            await this.safeEditMessage(replyMsg, `${progress}✅ 文本内容已发送`, true);
            
            // 如果开启了来源显示，发送来源消息
            if (showSource && forwardedMessage) {
              await this.sendSourceMessage(targetPeer, sourceChatId, sourceMessageId, forwardedMessage, replyMsg);
            } else {
              return { success: true, forwardedMsg: forwardedMessage };
            }
            
            return { success: true, forwardedMsg: forwardedMessage };
          } else {
            await this.safeEditMessage(replyMsg, `${progress}❌ 消息无内容可转发`, true);
            return { success: false };
          }
        }
        
        tempFileInfo = await this.downloadMedia(sourceMsg, 0, replyMsg);
        if (!tempFileInfo) {
          await this.safeEditMessage(replyMsg, `${progress}❌ 下载媒体失败`, true);
          return { success: false };
        }
        
        // 发送媒体消息，获取发送的消息
        forwardedMessage = await this.sendSingleMedia(client, targetPeer, tempFileInfo, replyMsg);
        await this.safeEditMessage(replyMsg, `${progress}✅ 内容已重新上传发送`, true);
        
        // 如果开启了来源显示，发送来源消息
        if (showSource && forwardedMessage) {
          await this.sendSourceMessage(targetPeer, sourceChatId, sourceMessageId, forwardedMessage, replyMsg);
        } else {
          return { success: true, forwardedMsg: forwardedMessage };
        }
        
        return { success: true, forwardedMsg: forwardedMessage };
      }
    } catch (error: any) {
      console.error(`处理消息失败:`, error);
      await this.safeEditMessage(replyMsg, `${progress}❌ 处理失败: ${htmlEscape(error.message || "未知错误")}`, true);
      return { success: false };
    } finally {
      if (tempFileInfo?.path) {
        await this.cleanupTempFile(tempFileInfo.path);
      }
    }
  }
  
  // 处理消息范围
  private async processMessageRange(
    chatId: string,
    startId: number,
    endId: number,
    targetPeer: any,
    replyMsg: Api.Message,
    showSource: boolean
  ): Promise<{ total: number; success: number }> {
    const client = await getGlobalClient();
    let successCount = 0;
    let totalProcessed = 0;
    
    // 确保startId <= endId
    const actualStart = Math.min(startId, endId);
    const actualEnd = Math.max(startId, endId);
    const totalMessages = actualEnd - actualStart + 1;
    
    await this.safeEditMessage(replyMsg, `🔄 开始处理消息范围 ${actualStart}-${actualEnd} (共${totalMessages}条)...`, true);
    
    for (let msgId = actualStart; msgId <= actualEnd; msgId++) {
      totalProcessed++;
      const progress = `[${totalProcessed}/${totalMessages}] `;
      
      try {
        await this.safeEditMessage(replyMsg, `${progress}🔍 获取消息 ${msgId}...`, true);
        const sourceMsg = await this.getMessage(chatId, msgId);
        
        if (!sourceMsg) {
          await this.safeEditMessage(replyMsg, `${progress}⏭️ 消息 ${msgId} 不存在，跳过`, true);
          continue;
        }
        
        await this.safeEditMessage(replyMsg, `${progress}🔄 处理消息 ${msgId}...`, true);
        const result = await this.processMessage(
          sourceMsg, 
          targetPeer, 
          replyMsg, 
          chatId, 
          msgId, 
          showSource, 
          progress
        );
        
        if (result.success) {
          successCount++;
          await this.safeEditMessage(replyMsg, `${progress}✅ 消息 ${msgId} 处理完成`, true);
        } else {
          await this.safeEditMessage(replyMsg, `${progress}❌ 消息 ${msgId} 处理失败`, true);
        }
      } catch (error: any) {
        await this.safeEditMessage(replyMsg, `${progress}❌ 消息 ${msgId} 处理出错: ${htmlEscape(error.message || "未知错误")}`, true);
      }
      
      // 延迟以避免触发限制
      if (msgId < actualEnd) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return { total: totalProcessed, success: successCount };
  }
  
  // 主要处理函数
  private async handleCommand(msg: Api.Message): Promise<void> {
    try {
      const client = await getGlobalClient();
      if (!client) {
        await this.safeEditMessage(msg, "❌ 客户端未初始化", true);
        return;
      }
      
      const userId = msg.senderId?.toString() || "unknown";
      const text = msg.text || "";
      const parts = text.trim().split(/\s+/);
      
      // 检查是否有回复消息
      const replyMsg = await msg.getReplyMessage();
      
      // 处理source子命令
      if (parts.length >= 2 && parts[1].toLowerCase() === "source") {
        const config = await this.getUserConfig(userId);
        
        if (parts.length === 2) {
          // 查看当前状态
          const status = config.showSource ? "开启 ✅" : "关闭 ❌";
          await this.safeEditMessage(msg, `📊 来源显示功能: <b>${status}</b>\n\n`, true);
          return;
        }
        
        const action = parts[2].toLowerCase();
        if (action === "on") {
          await this.setUserConfig(userId, { showSource: true });
          await this.safeEditMessage(msg, "✅ 已开启来源显示功能\n\n转发消息后，将回复一条包含原消息链接的来源消息。", true);
        } else if (action === "off") {
          await this.setUserConfig(userId, { showSource: false });
          await this.safeEditMessage(msg, "❌ 已关闭来源显示功能\n\n转发消息后，将不再显示来源链接。", true);
        } else {
          await this.safeEditMessage(msg, "❌ 无效的参数\n\n使用: <code>${mainPrefix}pms source on/off</code>", true);
        }
        return;
      }
      
      // 处理子命令
      if (parts.length >= 2 && parts[1].toLowerCase() === "to") {
        if (parts.length < 3) {
          await this.safeEditMessage(msg, "❌ 请指定转发目标\n\n💡 示例:\n<code>${mainPrefix}pms to @username</code>\n<code>${mainPrefix}pms to -123456780</code>\n<code>${mainPrefix}pms to me</code>", true);
          return;
        }
        
        const target = parts.slice(2).join(" ");
        await this.setUserConfig(userId, { target });
        await this.safeEditMessage(msg, `✅ 已设置默认转发目标为: <code>${htmlEscape(target)}</code>`, true);
        return;
      }
      
      if (parts.length >= 2 && parts[1].toLowerCase() === "target") {
        const config = await this.getUserConfig(userId);
        await this.safeEditMessage(msg, `📌 当前默认转发目标: <code>${htmlEscape(config.target)}</code>`, true);
        return;
      }
      
      // 处理帮助命令
      if (parts.length === 2 && (parts[1] === 'help' || parts[1] === 'h')) {
        await this.safeEditMessage(msg, help_text, true);
        return;
      }
      
      // 获取用户配置
      const config = await this.getUserConfig(userId);
      let target = config.target;
      const showSource = config.showSource;
      
      // 解析链接和临时目标
      const links: string[] = [];
      let tempTarget: string | null = null;
      let rangeMode = false;
      let rangeInfo: { chatId: string; startId: number; endId: number } | null = null;
      
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        
        // 检查是否是范围模式（包含|）
        if (part.includes('|') && (part.startsWith('http') || part.startsWith('t.me'))) {
          const rangeParts = part.split('|');
          if (rangeParts.length === 2) {
            const link1 = this.parseMessageLink(rangeParts[0]);
            const link2 = this.parseMessageLink(rangeParts[1]);
            
            if (link1 && link2 && link1.chatId === link2.chatId) {
              rangeMode = true;
              rangeInfo = {
                chatId: link1.chatId,
                startId: link1.messageId,
                endId: link2.messageId
              };
              break;
            }
          }
        } else if (part.startsWith('http') || part.startsWith('t.me')) {
          links.push(part);
        } else if (i === parts.length - 1 && links.length > 0) {
          tempTarget = part;
        }
      }
      
      if (tempTarget) target = tempTarget;
      
      // 如果既没有链接也没有回复消息，显示帮助
      if (links.length === 0 && !replyMsg && !rangeMode) {
        await this.safeEditMessage(msg, help_text, true);
        return;
      }
      
      // 获取目标对话实体
      let targetPeer: any;
      try {
        targetPeer = await client.getInputEntity(target);
      } catch (error) {
        await this.safeEditMessage(msg, `❌ 无法访问目标对话: <code>${htmlEscape(target)}</code>`, true);
        return;
      }
      
      // 范围模式处理
      if (rangeMode && rangeInfo) {
        await this.safeEditMessage(msg, `🔍 进入范围模式: ${rangeInfo.startId}-${rangeInfo.endId}`, true);
        const result = await this.processMessageRange(
          rangeInfo.chatId,
          rangeInfo.startId,
          rangeInfo.endId,
          targetPeer,
          msg,
          showSource
        );
        
        await this.safeEditMessage(msg, `✅ 范围处理完成\n成功: ${result.success}/${result.total} 条消息`, true);
        return;
      }
      
      // 处理消息
      const messagesToProcess: Array<{
        chatId: string;
        messageId: number;
        groupedId?: string;
        isMediaGroup?: boolean;
      }> = [];
      
      // 链接模式
      if (links.length > 0) {
        for (const link of links) {
          const linkInfo = this.parseMessageLink(link);
          if (!linkInfo) {
            await this.safeEditMessage(msg, `❌ 无效的消息链接: <code>${htmlEscape(link)}</code>`, true);
            return;
          }
          
          const sourceMsg = await this.getMessage(linkInfo.chatId, linkInfo.messageId);
          if (sourceMsg) {
            if (sourceMsg.groupedId) {
              const existingGroup = messagesToProcess.find(m => 
                m.groupedId === sourceMsg.groupedId?.toString()
              );
              if (!existingGroup) {
                messagesToProcess.push({
                  chatId: linkInfo.chatId,
                  messageId: linkInfo.messageId,
                  groupedId: sourceMsg.groupedId?.toString(),
                  isMediaGroup: true
                });
              }
            } else {
              messagesToProcess.push({
                chatId: linkInfo.chatId,
                messageId: linkInfo.messageId
              });
            }
          } else {
            await this.safeEditMessage(msg, `❌ 无法获取消息: ${link}`, true);
            return;
          }
        }
      }
      // 回复模式
      else if (replyMsg) {
        messagesToProcess.push({
          chatId: replyMsg.peerId?.toString() || "",
          messageId: replyMsg.id,
          groupedId: replyMsg.groupedId?.toString()
        });
      }
      
      if (messagesToProcess.length === 0) {
        await this.safeEditMessage(msg, "❌ 未找到要转发的消息", true);
        return;
      }
      
      const total = messagesToProcess.length;
      const mediaGroups = new Map<string, boolean>();
      let successCount = 0;
      
      await this.safeEditMessage(msg, `🔄 开始处理 ${total} 个消息/媒体组...`, true);
      
      for (let i = 0; i < messagesToProcess.length; i++) {
        const messageInfo = messagesToProcess[i];
        const progress = total > 1 ? `[${i + 1}/${total}] ` : "";
        
        if (messageInfo.isMediaGroup && messageInfo.groupedId) {
          if (mediaGroups.has(messageInfo.groupedId)) continue;
          mediaGroups.set(messageInfo.groupedId, true);
          
          // 简化处理：对于媒体组，逐个消息处理
          const client = await getGlobalClient();
          const peer = await client.getInputEntity(messageInfo.chatId);
          const searchIds: number[] = [];
          
          for (let j = 0; j <= 60; j++) {
            const id = messageInfo.messageId - 30 + j;
            if (id > 0) searchIds.push(id);
          }
          
          const messages = await client.getMessages(peer, { ids: searchIds });
          const groupMessages = messages.filter((msg): msg is Api.Message => 
            msg && (msg as Api.Message).groupedId?.toString() === messageInfo.groupedId
          );
          
          groupMessages.sort((a, b) => a.id - b.id);
          
          for (let j = 0; j < groupMessages.length; j++) {
            const groupMsg = groupMessages[j];
            const groupProgress = `[${i + 1}/${total}] [${j + 1}/${groupMessages.length}] `;
            const result = await this.processMessage(
              groupMsg, 
              targetPeer, 
              msg, 
              messageInfo.chatId, 
              groupMsg.id, 
              showSource, 
              groupProgress
            );
            
            if (result.success) successCount++;
            
            if (j < groupMessages.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          }
        } else {
          const sourceMsg = await this.getMessage(messageInfo.chatId, messageInfo.messageId);
          if (sourceMsg) {
            const result = await this.processMessage(
              sourceMsg, 
              targetPeer, 
              msg, 
              messageInfo.chatId, 
              messageInfo.messageId, 
              showSource, 
              progress
            );
            if (result.success) successCount++;
          }
        }
        
        if (i < messagesToProcess.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      if (total > 1) {
        await this.safeEditMessage(msg, `✅ 批量处理完成\n成功处理 ${successCount}/${total} 个消息/媒体组`, true);
      }
      
    } catch (error: any) {
      console.error(`prometheus命令执行失败:`, error);
      await this.safeEditMessage(msg, `❌ 执行失败: ${htmlEscape(error.message || "未知错误")}`, true);
    }
  }
  
  cmdHandlers = {
    prometheus: async (msg: Api.Message): Promise<void> => {
      await this.handleCommand(msg);
    },
    pms: async (msg: Api.Message): Promise<void> => {
      await this.handleCommand(msg);
    }
  };
}

export default new PrometheusPlugin();

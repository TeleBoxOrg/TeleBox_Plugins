/**
 * Message history query plugin for TeleBox
 * 
 * Queries message history of specified users or channels in groups.
 * Converted from Pagermaid_Telethon plugin by @tom-snow (@caiji_shiwo)
 */

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 多语言支持
interface LanguageDict {
  help: string;
  processing: string;
  media: Record<string, string>;
  service: Record<string, string>;
  query_success: string;
  no_messages: string;
  invalid_params: string;
  error_prefix: string;
}

const LANGUAGES: Record<string, LanguageDict> = {
  "zh-cn": {
    help: `📜 <b>消息历史查询</b>

<b>📝 功能描述:</b>
• 查询指定用户或频道在群内的发言历史
• 支持按数量限制查询结果
• 自动生成消息链接（如果可用）

<b>🔧 使用方法:</b>
• <code>.his &lt;目标&gt;</code> - 查询目标的消息历史
• <code>.his &lt;目标&gt; -n &lt;数量&gt;</code> - 限制查询数量
• <code>.his -n &lt;数量&gt;</code> - 回复消息时查询发送者历史

<b>💡 示例:</b>
• <code>.his @username</code>
• <code>.his 123456789 -n 10</code>
• 回复消息后使用 <code>.his -n 5</code>

<b>⚠️ 注意事项:</b>
• 仅限群组使用
• 目标可以是用户名、用户ID或频道ID
• 最多查询30条消息`,
    processing: "🔍 正在查询消息历史...",
    media: {
      "AUDIO": "[音频]:", "DOCUMENT": "[文档]:", "PHOTO": "[图片]:",
      "STICKER": "[贴纸]:", "VIDEO": "[视频]:", "ANIMATION": "[动画表情]:",
      "VOICE": "[语音]:", "VIDEO_NOTE": "[视频备注]:", "CONTACT": "[联系人]:",
      "LOCATION": "[位置]:", "VENUE": "[场地]:", "POLL": "[投票]:",
      "WEB_PAGE": "[网页]:", "DICE": "[骰子]:", "GAME": "[游戏]:",
    },
    service: {
      "service": "[服务消息]: ", "PINNED_MESSAGE": "置顶了: ", "NEW_CHAT_TITLE": "新的群组名字: ",
    },
    query_success: "查询历史消息完成. 群组id: {chat_id} 目标: {entity}",
    no_messages: "未找到该用户的消息记录",
    invalid_params: "❌ 参数错误",
    error_prefix: "❌ 查询失败:"
  },
  "en": {
    help: `📜 <b>Message History Query</b>

<b>📝 Description:</b>
• Query message history of specified users or channels in groups
• Support limiting query results by count
• Auto-generate message links (if available)

<b>🔧 Usage:</b>
• <code>${mainPrefix}his &lt;entity&gt;</code> - Query entity's message history
• <code>${mainPrefix}his &lt;entity&gt; -n &lt;num&gt;</code> - Limit query count
• <code>${mainPrefix}his -n &lt;num&gt;</code> - Query sender history when replying

<b>💡 Examples:</b>
• <code>${mainPrefix}his @username</code>
• <code>${mainPrefix}his 123456789 -n 10</code>
• Reply to message and use <code>${mainPrefix}his -n 5</code>

<b>⚠️ Notes:</b>
• Groups only
• Admin permission required
• Entity can be username, user ID, or channel ID
• Maximum 30 messages`,
    processing: "🔍 Querying message history...",
    media: {
      "AUDIO": "[AUDIO]:", "DOCUMENT": "[DOCUMENT]:", "PHOTO": "[PHOTO]:",
      "STICKER": "[STICKER]:", "VIDEO": "[VIDEO]:", "ANIMATION": "[ANIMATION]:",
      "VOICE": "[VOICE]:", "VIDEO_NOTE": "[VIDEO_NOTE]:", "CONTACT": "[CONTACT]:",
      "LOCATION": "[LOCATION]:", "VENUE": "[VENUE]:", "POLL": "[POLL]:",
      "WEB_PAGE": "[WEB_PAGE]:", "DICE": "[DICE]:", "GAME": "[GAME]:",
    },
    service: {
      "service": "[Service_Message]: ", "PINNED_MESSAGE": "Pinned: ", "NEW_CHAT_TITLE": "New chat title: ",
    },
    query_success: "Query completed. chat_id: {chat_id} entity: {entity}",
    no_messages: "No messages found for this entity",
    invalid_params: "❌ Invalid parameters",
    error_prefix: "❌ Query failed:"
  }
};

class HisPlugin extends Plugin {
  description = () => {
    const mainPrefix = getPrefixes()[0];
    return `查询指定用户或频道在群内的发言历史 (仅限群组使用)`;
  };
  
  private readonly MAX_COUNT = 30;
  private lang: LanguageDict;

  constructor() {
    super();
    // 默认使用中文，可根据需要扩展语言检测
    this.lang = LANGUAGES["zh-cn"];
  }

  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    his: async (msg: Api.Message, trigger?: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      // 检查是否在群组中
      if (!msg.isGroup) {
        await msg.edit({
          text: "❌ 此命令仅限群组使用",
          parseMode: "html"
        });
        return;
      }

      // 参数解析（严格按acron.ts模式）
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();

      try {
        // 无参数时报错而不是显示帮助
        if (!sub) {
          if (msg.isReply) {
            // 如果是回复消息，则查询被回复者
            await this.handleReplyQuery(msg, client);
            return;
          }
          await msg.edit({
            text: "❌ 参数错误\n\n请提供要查询的目标（用户名或ID）",
            parseMode: "html"
          });
          return;
        }

        // 明确请求帮助时显示
        if (sub === "help" || sub === "h") {
          const helpText = `📜 <b>消息历史查询</b>

<b>📝 功能描述:</b>
• 查询指定用户或频道在群内的发言历史
• 支持按数量限制查询结果
• 自动生成消息链接（如果可用）

<b>🔧 使用方法:</b>
• <code>${mainPrefix}his &lt;目标&gt;</code> - 查询目标的消息历史
• <code>${mainPrefix}his &lt;目标&gt; -n &lt;数量&gt;</code> - 限制查询数量
• <code>${mainPrefix}his -n &lt;数量&gt;</code> - 回复消息时查询发送者历史
• <code>${mainPrefix}his help</code> - 显示帮助信息

<b>💡 示例:</b>
• <code>${mainPrefix}his @username</code>
• <code>${mainPrefix}his 123456789 -n 10</code>
• 回复消息后使用 <code>${mainPrefix}his -n 5</code>

<b>⚠️ 注意事项:</b>
• 仅限群组使用
• 目标可以是用户名、用户ID或频道ID
• 最多查询30条消息`;
          await msg.edit({
            text: helpText,
            parseMode: "html"
          });
          return;
        }

        await this.handleHistoryQuery(msg, args, client, trigger);

      } catch (error: any) {
        console.error("[his] 插件执行失败:", error);
        await msg.edit({
          text: `❌ 查询失败: ${htmlEscape(error.message || "未知错误")}`,
          parseMode: "html"
        });
      }
    }
  };

  private async handleReplyQuery(msg: Api.Message, client: any): Promise<void> {
    const reply = await msg.getReplyMessage();
    if (!reply) {
      await msg.edit({
        text: "❌ 无法获取回复的消息",
        parseMode: "html"
      });
      return;
    }
    
    const targetEntity = reply.senderId!;
    await this.queryHistory(msg, targetEntity.toString(), this.MAX_COUNT, client);
  }

  private async handleHistoryQuery(msg: Api.Message, args: string[], client: any, trigger?: Api.Message): Promise<void> {
    let targetEntity: any = "";
    let num = this.MAX_COUNT;

    // 解析参数
    if (args.length === 3 && args[1] === "-n") {
      // format: his <entity> -n <num>
      targetEntity = this.parseEntity(args[0]);
      const parsedNum = parseInt(args[2]);
      if (isNaN(parsedNum) || parsedNum <= 0) {
        await msg.edit({
          text: "❌ 无效的数量参数",
          parseMode: "html"
        });
        return;
      }
      num = Math.min(parsedNum, this.MAX_COUNT);
    } else if (args.length === 1) {
      // format: his <entity>
      targetEntity = this.parseEntity(args[0]);
    } else if (args.length === 2 && args[0] === "-n" && msg.isReply) {
      // format: his -n <num> (reply to message)
      const reply = await msg.getReplyMessage();
      if (!reply) {
        await msg.edit({
          text: "❌ 无法获取回复的消息",
          parseMode: "html"
        });
        return;
      }
      targetEntity = reply.senderId!.toString();
      const parsedNum = parseInt(args[1]);
      if (isNaN(parsedNum) || parsedNum <= 0) {
        await msg.edit({
          text: "❌ 无效的数量参数",
          parseMode: "html"
        });
        return;
      }
      num = Math.min(parsedNum, this.MAX_COUNT);
    } else {
      await msg.edit({
        text: "❌ 参数格式错误\n\n使用 <code>.his help</code> 查看帮助",
        parseMode: "html"
      });
      return;
    }

    await this.queryHistory(msg, targetEntity, num, client, trigger);
  }

  private async queryHistory(msg: Api.Message, targetEntity: any, num: number, client: any, trigger?: Api.Message): Promise<void> {
    const chatId = msg.peerId;

    // 显示处理中消息
    await msg.edit({ text: "🔍 正在查询消息历史...", parseMode: "html" });

    // 格式化目标实体显示
    let targetDisplay = "";
    try {
      const entity = await client.getEntity(targetEntity);
      if (entity) {
        const parts: string[] = [];
        if (entity.title) parts.push(entity.title);
        if (entity.firstName) parts.push(entity.firstName);
        if (entity.lastName) parts.push(entity.lastName);
        if (entity.username) parts.push(`@${entity.username}`);
        targetDisplay = parts.join(" ") || targetEntity.toString();
      } else {
        targetDisplay = targetEntity.toString();
      }
    } catch (error) {
      targetDisplay = targetEntity.toString();
    }

    // 获取聊天链接基础URL
    let baseLinkUrl = "";
    try {
      const chat = await client.getEntity(chatId);
      if (chat.username) {
        baseLinkUrl = `https://t.me/${chat.username}/`;
      } else if (chat.megagroup) {
        const chatIdStr = String(chatId).replace("-100", "");
        baseLinkUrl = `https://t.me/c/${chatIdStr}/`;
      }
    } catch (error) {
      console.error("[HIS] Could not get chat entity for linking:", error);
    }

    let count = 0;
    const messages: string[] = [];

    try {
      // 迭代消息
      const messageIterator = client.iterMessages(chatId, {
        limit: num,
        fromUser: targetEntity
      });

      for await (const message of messageIterator) {
        count++;
        let messageText = message.text || "";

        // 处理媒体消息
        if (message.media) {
          messageText = this.processMediaMessage(message, messageText);
        }

        // 处理服务消息
        if (message.className === "MessageService") {
          const action = message.action;
          const serviceText = action.className.replace("MessageAction", "");
          messageText = this.lang.service.service + serviceText;
        }

        if (!messageText) {
          messageText = "[Unsupported Message]";
        }

        // 格式化消息显示
        const messageTextDisplay = messageText.length > 50 
          ? `${messageText.substring(0, 50)}...`
          : messageText;

        // 添加链接（如果可用）
        if (baseLinkUrl) {
          const messageLink = `${baseLinkUrl}${message.id}`;
          messages.push(`${count}. <a href="${messageLink}">${htmlEscape(messageTextDisplay)}</a>`);
        } else {
          messages.push(`${count}. ${htmlEscape(messageTextDisplay)}`);
        }
      }

      if (messages.length === 0) {
        await msg.edit({
          text: `❌ 未找到 <b>${htmlEscape(targetDisplay)}</b> 的消息记录`,
          parseMode: "html"
        });
        return;
      }

      // 构建结果消息
      const header = `📜 <b>消息历史查询</b>\n\n` +
                    `👤 <b>目标:</b> ${htmlEscape(targetDisplay)}\n` +
                    `💬 <b>消息数:</b> ${messages.length}\n` +
                    `━━━━━━━━━━━━━━━━\n\n`;
      
      const results = header + messages.join("\n");

      // 分片发送长消息
      const MAX_LENGTH = 3500;
      if (results.length > MAX_LENGTH) {
        const chunks: string[] = [];
        let currentChunk = header;
        
        for (const message of messages) {
          if ((currentChunk + "\n" + message).length > MAX_LENGTH) {
            chunks.push(currentChunk);
            currentChunk = message;
          } else {
            currentChunk += (currentChunk ? "\n" : "") + message;
          }
        }
        if (currentChunk) {
          chunks.push(currentChunk);
        }

        // 发送第一片
        await msg.edit({
          text: chunks[0],
          parseMode: "html",
          linkPreview: false
        });

        // 发送后续片段
        for (let i = 1; i < chunks.length; i++) {
          await client.sendMessage(msg.peerId, {
            message: chunks[i],
            parseMode: "html",
            linkPreview: false
          });
        }
      } else {
        await msg.edit({
          text: results,
          parseMode: "html",
          linkPreview: false
        });
      }

      console.log(`[HIS] 查询完成 - 群组: ${chatId}, 目标: ${targetEntity.toString()}, 消息数: ${count}`);

    } catch (error: any) {
      console.error("[HIS_ERROR]:", error);
      await msg.edit({
        text: `❌ 查询失败: ${htmlEscape(error.message || "未知错误")}`,
        parseMode: "html"
      });
    }
  }

  private parseEntity(argStr: string): string | number {
    // 尝试解析为数字ID
    const num = parseInt(argStr);
    if (!isNaN(num)) {
      return num;
    }
    // 否则作为用户名返回
    return argStr;
  }

  private processMediaMessage(message: any, mediaCaption: string): string {
    const media = message.media;
    
    if (media.className === "MessageMediaPhoto") {
      return this.lang.media.PHOTO + mediaCaption;
    } else if (media.className === "MessageMediaDocument") {
      const doc = media.document;
      const attributes = doc.attributes || [];
      
      const isVideo = attributes.some((attr: any) => attr.className === "DocumentAttributeVideo");
      const isVoice = attributes.some((attr: any) => attr.className === "DocumentAttributeAudio" && attr.voice);
      const isAudio = attributes.some((attr: any) => attr.className === "DocumentAttributeAudio");
      const isSticker = attributes.some((attr: any) => attr.className === "DocumentAttributeSticker");
      const isAnimation = attributes.some((attr: any) => attr.className === "DocumentAttributeAnimated");

      if (isSticker) return this.lang.media.STICKER + mediaCaption;
      if (isAnimation) return this.lang.media.ANIMATION + mediaCaption;
      if (isVideo) return this.lang.media.VIDEO + mediaCaption;
      if (isVoice) return this.lang.media.VOICE + mediaCaption;
      if (isAudio) return this.lang.media.AUDIO + mediaCaption;
      return this.lang.media.DOCUMENT + mediaCaption;
    } else if (media.className === "MessageMediaContact") {
      return this.lang.media.CONTACT + mediaCaption;
    } else if (media.className === "MessageMediaGeo" || media.className === "MessageMediaVenue") {
      return this.lang.media.LOCATION + mediaCaption;
    } else if (media.className === "MessageMediaPoll") {
      return this.lang.media.POLL + mediaCaption;
    } else if (media.className === "MessageMediaWebPage") {
      return this.lang.media.WEB_PAGE + mediaCaption;
    } else if (media.className === "MessageMediaDice") {
      return this.lang.media.DICE + mediaCaption;
    } else if (media.className === "MessageMediaGame") {
      return this.lang.media.GAME + mediaCaption;
    }

    return mediaCaption;
  }
}

export default new HisPlugin();

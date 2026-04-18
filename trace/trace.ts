import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "teleproto";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import bigInt, { BigInteger } from "big-integer";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// Helper to escape HTML special characters.
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;'
  }[m] || m));

// A whitelist of standard emojis that are valid for reactions.
const AVAILABLE_REACTIONS = "👍👎❤️🔥🥰👏😁🤔🤯😱🤬😢🎉🤩🤮💩🙏👌🕊🤡🥱🥴😍🐳❤️‍🔥🌚🌭💯🤣⚡️🍌🏆💔🤨😐🍓🍾💋🖕😈😎😇😤🏻‍💻";

// Help text constant with enhanced formatting.
const help_text = `🎯 <b>自动回应插件 (Trace)</b>
━━━━━━━━━━━━━━━━
<i>通过自动发送 Reactions 来追踪特定用户或关键字消息</i>

📌 <b>用户追踪</b>
├ 💬 回复消息 + <code>${mainPrefix}trace 👍👎🥰</code>
│  └ 使用指定表情追踪该用户
└ 🚫 回复消息 + <code>${mainPrefix}trace</code>
   └ 取消追踪该用户

🔍 <b>关键字追踪</b>
├ ➕ <code>${mainPrefix}trace kw add ＜词＞ 👍👎🥰</code>
│  └ 添加关键字自动回应
└ ➖ <code>${mainPrefix}trace kw del ＜词＞</code>
   └ 删除关键字追踪

📊 <b>管理命令</b>
├ 📈 <code>${mainPrefix}trace status</code> - 查看追踪统计
├ 🗑️ <code>${mainPrefix}trace clean</code> - 清除所有追踪
└ ⚠️ <code>${mainPrefix}trace reset</code> - 重置全部数据

⚙️ <b>配置选项</b>
├ 📝 <code>${mainPrefix}trace log [true|false]</code>
│  └ 操作回执保留 (默认: true)
└ 🎭 <code>${mainPrefix}trace big [true|false]</code>
   └ 大号表情动画 (默认: true)

💡 <b>使用提示</b>
• 标准表情无需 Premium
• 自定义表情需要 Premium 订阅
• 可用表情: <code>${AVAILABLE_REACTIONS}</code>`;

// DB structure definition.
interface TraceDB {
  users: Record<string, (string | BigInteger)[]>;
  keywords: Record<string, (string | BigInteger)[]>;
  config: {
    keepLog: boolean;
    big: boolean;
  };
}

// Default state for the database.
const defaultState: TraceDB = {
  users: {},
  keywords: {},
  config: {
    keepLog: true,
    big: true,
  },
};

class TracePlugin extends Plugin {
  public description: string = `自动回应消息。\n\n${help_text}`;
  public cmdHandlers = { trace: this.handleTrace.bind(this) };
  public listenMessageHandler = this.handleMessage.bind(this);

  private db: any;
  private isPremium: boolean | null = null;
  // [MODIFIED] Added a property to store our own user ID.
  private meId: BigInteger | null = null;
  private MessageBuilder: any;
  private pendingDeleteTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    super();
    this.initializeDB();
    this.initMessageBuilder();
  }
  
  private initMessageBuilder() {
    // Initialize MessageBuilder as inner class
    const self = this;
    this.MessageBuilder = class {
      private text = '';
      private entities: Api.TypeMessageEntity[] = [];
      
      add(str: string): void {
          this.text += str;
      }
      
      addLine(str: string): void {
          this.text += str + '\n';
      }
      
      addCustomEmoji(placeholder: string, documentId: BigInteger): void {
          const offset = this.calculateOffset(this.text);
          const length = placeholder.length; // Simple length calculation
          this.text += placeholder;
          
          this.entities.push(
              new Api.MessageEntityCustomEmoji({
                  offset,
                  length,
                  documentId
              })
          );
      }
      
      private calculateOffset(text: string): number {
          // Telegram uses UTF-16 code units for offset calculation
          return text.length;
      }
      
      
      build(): { text: string, entities: Api.TypeMessageEntity[] } {
          return { text: this.text.trim(), entities: this.entities };
      }
    };
  }

  private async initializeDB() {
    const dbPath = path.join(createDirectoryInAssets("trace"), "db.json");
    this.db = await JSONFilePreset<TraceDB>(dbPath, defaultState);
  }


  private scheduleDelete(msg: Api.Message, seconds: number): void {
    let timer: ReturnType<typeof setTimeout>;
    timer = setTimeout(() => {
      this.pendingDeleteTimers.delete(timer);
      msg.delete().catch(() => {});
    }, seconds * 1000);
    if (typeof (timer as any).unref === "function") {
      (timer as any).unref();
    }
    this.pendingDeleteTimers.add(timer);
  }

  cleanup(): void {
    // 真实资源清理：释放插件持有的定时器、监听器、运行时状态或临时资源。
    for (const timer of this.pendingDeleteTimers) {
      clearTimeout(timer);
    }
    this.pendingDeleteTimers.clear();
    this.isPremium = null;
    this.meId = null;
  }
  
  /**
   * [MODIFIED] Renamed and enhanced to get our own user ID and premium status.
   */
  private async initializeSelf() {
    if (this.meId === null) {
        const client = await getGlobalClient();
        if (client) {
            const me = await client.getMe() as Api.User;
            this.isPremium = me?.premium || false;
            this.meId = me?.id || null;
        } else {
            this.isPremium = false;
        }
    }
  }

  private async handleTrace(msg: Api.Message) {
    try {
      const parts = msg.message?.split(/\s+/) || [];
      const [, sub, ...args] = parts;
      const repliedMsg = await msg.getReplyMessage();

      if (repliedMsg && !sub) {
        return this.untraceUser(msg, repliedMsg);
      }

      if (repliedMsg && sub) {
        const fullEmojiText = msg.message.substring(parts[0].length).trim();
        return this.traceUser(msg, repliedMsg, fullEmojiText);
      }

      switch (sub?.toLowerCase()) {
        case "kw":
          const action = (args[0] || "").toLowerCase();
          const keyword = args[1];
          const fullEmojiText = msg.message.substring(parts.slice(0, 3).join(" ").length).trim();
          if (action === "add" && keyword && fullEmojiText) {
            return this.traceKeyword(msg, keyword, fullEmojiText);
          } else if (action === "del" && keyword) {
            return this.untraceKeyword(msg, keyword);
          }
          break;
        case "status":
          return this.showStatus(msg);
        case "clean":
          return this.cleanTraces(msg);
        case "reset":
          return this.resetDatabase(msg);
        case "log":
          return this.setConfig(msg, "keepLog", args[0]);
        case "big":
          return this.setConfig(msg, "big", args[0]);
      }
      
      await msg.edit({ text: help_text, parseMode: "html" });

    } catch (error: any) {
      console.error("[trace] Error handling command:", error);
      const errorMsg = `❌ <b>操作失败</b>\n` +
                      `├ 💔 错误类型: ${error.name || 'Unknown'}\n` +
                      `├ 📝 错误信息: ${htmlEscape(error.message)}\n` +
                      `└ 💡 请检查命令格式或稍后重试`;
      await msg.edit({
        text: errorMsg,
        parseMode: "html",
      });
    }
  }

  /**
   * [MODIFIED] Now ignores messages sent by the bot itself to prevent feedback loops.
   */
  private async handleMessage(msg: Api.Message) {
    // Ensure we know who "I" am.
    await this.initializeSelf();
    if (!this.db?.data || !msg.senderId || !this.meId) return;

    // If the message is from me, ignore it completely.
    const senderId = msg.senderId.toString();
    const isSelf = senderId === this.meId.toString();
    if (isSelf) {
        return;
    }

    const { users, keywords, config } = this.db.data;

    try {
      // User trace logic for incoming messages
      if (users[senderId]) {
        await this.sendReaction(msg.peerId, msg.id, users[senderId], config.big);
        return;
      }

      // Keyword trace logic for incoming messages
      if (msg.message) {
        for (const keyword in keywords) {
          if (msg.message.includes(keyword)) {
            await this.sendReaction(msg.peerId, msg.id, keywords[keyword], config.big);
            return;
          }
        }
      }
    } catch (error) {
      console.error("[trace] Listener failed to send reaction:", error);
    }
  }

  private async traceUser(msg: Api.Message, repliedMsg: Api.Message, emojiText: string) {
    const userId = repliedMsg.senderId?.toString();
    if (!userId) {
      await this.editAndDelete(msg, "❌ <b>操作失败</b>\n└ 无法获取用户信息");
      return;
    }
    const reactions = await this.parseReactions(msg, emojiText);
    if (reactions.length === 0) {
      await this.editAndDelete(msg, "❌ <b>操作失败</b>\n├ 未找到有效的表情符号\n└ 请检查帮助中的可用列表");
      return;
    }
    this.db.data.users[userId] = reactions;
    await this.db.write();
    await this.sendReaction(repliedMsg.peerId, repliedMsg.id, reactions, this.db.data.config.big);
    const userEntity = await this.formatEntity(userId);
    // Extract actual emojis from the original message for display
    // Get reaction display with entities for custom emojis
    const reactionCount = reactions.length;
    const customCount = reactions.filter(r => typeof r !== 'string').length;
    
    if (customCount > 0) {
        // Build message with custom emoji entities
        const msgBuilder = new this.MessageBuilder();
        msgBuilder.addLine('✅ 追踪成功');
        msgBuilder.addLine(`├ 👤 用户: ${userEntity.display.replace(/<[^>]*>/g, '')}`);
        msgBuilder.add(`├ 🎯 表情: `);
        
        // Add reactions with proper entities
        for (const reaction of reactions) {
            if (typeof reaction === 'string') {
                msgBuilder.add(reaction + ' ');
            } else {
                // Use a simple emoji as placeholder that will be replaced by custom emoji
                msgBuilder.addCustomEmoji('😊', reaction);
                msgBuilder.add(' ');
            }
        }
        msgBuilder.addLine('');
        
        msgBuilder.addLine(`├ 📊 表情数: ${reactionCount} 个 (含 ${customCount} 个会员表情)`);
        msgBuilder.addLine(`└ 📊 当前追踪: ${Object.keys(this.db.data.users).length} 个用户`);
        
        const { text: fullMessage, entities: messageEntities } = msgBuilder.build();
        await this.editAndDeleteWithEntities(msg, fullMessage, messageEntities, 10);
    } else {
        // Use HTML formatting for messages without custom emojis
        const htmlMsg = `✅ <b>追踪成功</b>\n` +
                      `├ 👤 用户: ${userEntity.display}\n` +
                      `├ 🎯 表情: ${reactions.join(' ')}\n` +
                      `├ 📊 表情数: ${reactionCount} 个\n` +
                      `└ 📊 当前追踪: ${Object.keys(this.db.data.users).length} 个用户`;
        await this.editAndDelete(msg, htmlMsg, 10);
    }
  }

  private async untraceUser(msg: Api.Message, repliedMsg: Api.Message) {
    const userId = repliedMsg.senderId?.toString();
    if (userId && this.db.data.users[userId]) {
      const standardCount = this.db.data.users[userId].filter((r: string | BigInteger) => typeof r === 'string').length;
      const customCount = this.db.data.users[userId].filter((r: string | BigInteger) => typeof r !== 'string').length;
      const previousReactions = `${standardCount}个标准 + ${customCount}个会员表情`;
      delete this.db.data.users[userId];
      await this.db.write();
      const userEntity = await this.formatEntity(userId);
      const untrackMsg = `🗑️ <b>取消追踪</b>\n` +
                        `├ 👤 用户: ${userEntity.display}\n` +
                        `├ 🎯 原表情: ${previousReactions}\n` +
                        `└ 📊 剩余追踪: ${Object.keys(this.db.data.users).length} 个用户`;
      await this.editAndDelete(msg, untrackMsg, 10);
    } else {
      await this.editAndDelete(msg, "ℹ️ <b>提示</b>\n└ 该用户未被追踪");
    }
  }

  private async traceKeyword(msg: Api.Message, keyword: string, emojiText: string) {
    const reactions = await this.parseReactions(msg, emojiText);
    if (reactions.length === 0) {
      await this.editAndDelete(msg, "❌ <b>操作失败</b>\n├ 未找到有效的表情符号\n└ 请检查帮助中的可用列表");
      return;
    }
    const isUpdate = keyword in this.db.data.keywords;
    this.db.data.keywords[keyword] = reactions;
    await this.db.write();
    // Extract actual emojis from the original message for display
    const reactionDisplay = await this.getReactionDisplay(msg, emojiText, reactions);
    const reactionCount = reactions.length;
    const customCount = reactions.filter(r => typeof r !== 'string').length;
    const successMsg = `✅ <b>${isUpdate ? '更新' : '添加'}关键字追踪</b>\n` +
                      `├ 🔑 关键字: <code>${htmlEscape(keyword)}</code>\n` +
                      `├ 🎯 表情: ${reactionDisplay}\n` +
                      `├ 📊 表情数: ${reactionCount} 个${customCount > 0 ? ` (${customCount} 个会员表情)` : ''}\n` +
                      `└ 📊 当前追踪: ${Object.keys(this.db.data.keywords).length} 个关键字`;
    await this.editAndDelete(msg, successMsg, 10);
  }

  private async untraceKeyword(msg: Api.Message, keyword: string) {
    if (this.db.data.keywords[keyword]) {
      const standardCount = this.db.data.keywords[keyword].filter((r: string | BigInteger) => typeof r === 'string').length;
      const customCount = this.db.data.keywords[keyword].filter((r: string | BigInteger) => typeof r !== 'string').length;
      const previousReactions = `${standardCount}个标准 + ${customCount}个会员表情`;
      delete this.db.data.keywords[keyword];
      await this.db.write();
      const untrackMsg = `🗑️ <b>删除关键字追踪</b>\n` +
                        `├ 🔑 关键字: <code>${htmlEscape(keyword)}</code>\n` +
                        `├ 🎯 原表情: ${previousReactions}\n` +
                        `└ 📊 剩余追踪: ${Object.keys(this.db.data.keywords).length} 个关键字`;
      await this.editAndDelete(msg, untrackMsg, 10);
    } else {
      await this.editAndDelete(msg, `ℹ️ <b>提示</b>\n└ 关键字 "<code>${htmlEscape(keyword)}</code>" 未被追踪`);
    }
  }
  
  private async showStatus(msg: Api.Message) {
    const users = this.db.data.users || {};
    const keywords = this.db.data.keywords || {};
    const userCount = Object.keys(users).length;
    const keywordCount = Object.keys(keywords).length;
    const currentTime = new Date().toLocaleString('zh-CN', { 
      timeZone: 'Asia/Shanghai',
      hour12: false 
    });
    
    let response = `📊 <b>Trace 追踪状态面板</b>\n`;
    response += `━━━━━━━━━━━━━━━━\n`;
    response += `🕐 <i>${currentTime}</i>\n\n`;
    
    // Statistics section
    response += `📈 <b>统计信息</b>\n`;
    response += `├ 👥 追踪用户: <b>${userCount}</b> 个\n`;
    response += `├ 🔑 追踪关键字: <b>${keywordCount}</b> 个\n`;
    response += `└ 📊 总计: <b>${userCount + keywordCount}</b> 项\n\n`;
    
    // Users section
    response += `👤 <b>追踪的用户</b> (${userCount})\n`;
    if (userCount > 0) {
        response += `┌──────────\n`;
        let index = 0;
        for (const userId in users) {
            const userEntity = await this.formatEntity(userId);
            const standardEmojis = users[userId].filter((r: string | BigInteger) => typeof r === 'string');
            const customEmojis = users[userId].filter((r: string | BigInteger) => typeof r !== 'string');
            const reactions = standardEmojis.join('') + 
                             (customEmojis.length > 0 ? ` +${customEmojis.length}会员表情` : '');
            const prefix = index === userCount - 1 ? '└' : '├';
            response += `${prefix} ${userEntity.display}\n`;
            response += `${prefix === '└' ? ' ' : '│'} └ ${reactions}\n`;
            index++;
        }
    } else {
        response += `└ <i>暂无追踪用户</i>\n`;
    }
    
    // Keywords section
    response += `\n🔑 <b>追踪的关键字</b> (${keywordCount})\n`;
    if (keywordCount > 0) {
        response += `┌──────────\n`;
        let index = 0;
        for (const keyword in keywords) {
            const standardEmojis = keywords[keyword].filter((r: string | BigInteger) => typeof r === 'string');
            const customEmojis = keywords[keyword].filter((r: string | BigInteger) => typeof r !== 'string');
            const reactions = standardEmojis.join('') + 
                             (customEmojis.length > 0 ? ` +${customEmojis.length}会员表情` : '');
            const prefix = index === keywordCount - 1 ? '└' : '├';
            response += `${prefix} <code>${htmlEscape(keyword)}</code>\n`;
            response += `${prefix === '└' ? ' ' : '│'} └ ${reactions}\n`;
            index++;
        }
    } else {
        response += `└ <i>暂无追踪关键字</i>\n`;
    }
    
    // Settings section
    response += `\n⚙️ <b>当前配置</b>\n`;
    response += `├ 📝 保留日志: ${this.db.data.config.keepLog ? '✅ 启用' : '❌ 禁用'}\n`;
    response += `└ 🎭 大号动画: ${this.db.data.config.big ? '✅ 启用' : '❌ 禁用'}\n`;
    
    response += `\n━━━━━━━━━━━━━━━━\n`;
    
    await msg.edit({ text: response, parseMode: "html" });
  }

  private async cleanTraces(msg: Api.Message) {
    const prevUserCount = Object.keys(this.db.data.users).length;
    const prevKeywordCount = Object.keys(this.db.data.keywords).length;
    this.db.data.users = {};
    this.db.data.keywords = {};
    await this.db.write();
    const cleanMsg = `🗑️ <b>清理完成</b>\n` +
                    `├ 👥 清除用户: ${prevUserCount} 个\n` +
                    `├ 🔑 清除关键字: ${prevKeywordCount} 个\n` +
                    `└ ✅ 所有追踪已清空`;
    await this.editAndDelete(msg, cleanMsg, 10);
  }

  private async resetDatabase(msg: Api.Message) {
    const prevUserCount = Object.keys(this.db.data.users || {}).length;
    const prevKeywordCount = Object.keys(this.db.data.keywords || {}).length;
    this.db.data = { ...defaultState };
    await this.db.write();
    const resetMsg = `⚠️ <b>数据库重置</b>\n` +
                    `├ 📊 已清除数据\n` +
                    `│ ├ 用户: ${prevUserCount} 个\n` +
                    `│ └ 关键字: ${prevKeywordCount} 个\n` +
                    `└ ✅ 恢复默认设置`;
    await this.editAndDelete(msg, resetMsg, 10);
  }

  private async setConfig(msg: Api.Message, key: "keepLog" | "big", value: string) {
    const boolValue = value?.toLowerCase() === "true";
    if (value === undefined || (value.toLowerCase() !== "true" && value.toLowerCase() !== "false")) {
        await this.editAndDelete(msg, `❌ <b>参数错误</b>\n└ 请使用 <code>true</code> 或 <code>false</code>`);
        return;
    }
    const previousValue = this.db.data.config[key];
    this.db.data.config[key] = boolValue;
    await this.db.write();
    const configName = key === 'keepLog' ? '保留日志' : '大号动画';
    const icon = key === 'keepLog' ? '📝' : '🎭';
    const configMsg = `⚙️ <b>配置更新</b>\n` +
                     `├ ${icon} 项目: ${configName}\n` +
                     `├ 🔄 旧值: ${previousValue ? '✅ 启用' : '❌ 禁用'}\n` +
                     `├ ✨ 新值: ${boolValue ? '✅ 启用' : '❌ 禁用'}\n` +
                     `└ 💾 配置已保存`;
    await this.editAndDelete(msg, configMsg, 10);
  }

  private async formatEntity(target: string | Api.TypePeer, mention?: boolean, throwErrorIfFailed?: boolean) {
    const client = await getGlobalClient();
    if (!client) throw new Error("客户端未初始化");
    let id: any, entity: any;
    try {
      entity = (typeof target !== 'string' && target?.className) ? target : await client?.getEntity(target);
      if (!entity) throw new Error("无法获取entity");
      id = entity.id;
    } catch (e: any) {
      if (throwErrorIfFailed) throw new Error(`无法获取 ${target}: ${e?.message}`);
    }
    const displayParts: string[] = [];
    if (entity?.title) displayParts.push(htmlEscape(entity.title));
    if (entity?.firstName) displayParts.push(htmlEscape(entity.firstName));
    if (entity?.lastName) displayParts.push(htmlEscape(entity.lastName));
    if (entity?.username) {
      displayParts.push(mention ? `@${entity.username}` : `<code>@${entity.username}</code>`);
    }
    if (id) {
      displayParts.push(
        entity instanceof Api.User
          ? `<a href="tg://user?id=${id}">${id}</a>`
          : `<a href="https://t.me/c/${id}">${id}</a>`
      );
    }
    return { id, entity, display: displayParts.join(" ").trim() };
  }

  private async parseReactions(msg: Api.Message, text: string): Promise<(string | BigInteger)[]> {
    await this.initializeSelf(); // Ensures isPremium is set
    const validReactions: (string | BigInteger)[] = [];
    const customEmojiMap = new Map<number, BigInteger>();
    const customEmojiIndices = new Set<number>();
    if (this.isPremium) {
        const customEmojiEntities = (msg.entities || []).filter(
            (e): e is Api.MessageEntityCustomEmoji => e instanceof Api.MessageEntityCustomEmoji
        );
        for (const entity of customEmojiEntities) {
            customEmojiMap.set(entity.offset, entity.documentId);
            for (let i = 0; i < entity.length; i++) {
                customEmojiIndices.add(entity.offset + i);
            }
        }
    }
    const textOffsetInMessage = msg.message.indexOf(text);
    if (textOffsetInMessage === -1) return [];
    let currentIndex = 0;
    for (const char of text) {
        const fullMessageOffset = textOffsetInMessage + currentIndex;
        if (customEmojiMap.has(fullMessageOffset)) {
            validReactions.push(customEmojiMap.get(fullMessageOffset)!);
        } 
        else if (!customEmojiIndices.has(fullMessageOffset) && AVAILABLE_REACTIONS.includes(char)) {
            validReactions.push(char);
        }
        currentIndex += char.length; 
    }
    return [...new Set(validReactions)];
  }

  private async sendReaction(peer: Api.TypePeer, msgId: number, reactions: (string | BigInteger)[], big: boolean) {
    const client = await getGlobalClient();
    if (!client || reactions.length === 0) return;
    
    const reactionObjects = reactions.map(r => {
        if (typeof r === 'string') {
            if (AVAILABLE_REACTIONS.includes(r)) {
                return new Api.ReactionEmoji({ emoticon: r });
            }
            return new Api.ReactionCustomEmoji({ documentId: bigInt(r) });
        } else {
            return new Api.ReactionCustomEmoji({ documentId: bigInt(r) });
        }
    });
    
    await client.invoke(
      new Api.messages.SendReaction({
        peer, msgId, reaction: reactionObjects, big,
      })
    );
  }

  // Remove duplicate MessageBuilder definition
  
  /**
   * Helper method to get display text for reactions (fallback without entities)
   */
  private async getReactionDisplay(msg: Api.Message, emojiText: string, reactions: (string | BigInteger)[]): Promise<string> {
    const displayParts: string[] = [];
    let customEmojiCount = 0;
    
    for (const reaction of reactions) {
      if (typeof reaction === 'string') {
        // Standard emoji - can be displayed directly
        displayParts.push(reaction);
      } else {
        // Custom emoji - use a special indicator
        customEmojiCount++;
        // Show custom emoji with its ID prefix for identification
        const idPrefix = reaction.toString().slice(0, 4);
        displayParts.push(`[Premium:${idPrefix}]`);
      }
    }
    
    // If there are custom emojis, add a note
    if (customEmojiCount > 0) {
      return displayParts.join(' ') + ` (含 ${customEmojiCount} 个会员表情)`;
    }
    
    return displayParts.join(' ');
  }

  private async editAndDelete(msg: Api.Message, text: string, seconds: number = 5) {
      await msg.edit({ text, parseMode: "html" });
      if (!this.db.data.config.keepLog) {
          this.scheduleDelete(msg, seconds);
      }
  }
  
  private async editAndDeleteWithEntities(msg: Api.Message, text: string, entities: Api.TypeMessageEntity[], seconds: number = 5) {
      const client = await getGlobalClient();
      if (!client) {
          // Fallback to regular edit if client unavailable
          await msg.edit({ text, parseMode: "html" });
          return;
      }
      
      try {
          // Use bottom-level API call to edit message with entities
          await client.invoke(
              new Api.messages.EditMessage({
                  peer: msg.peerId,
                  id: msg.id,
                  message: text,
                  entities: entities,
                  // Don't use parseMode when using entities
                  noWebpage: true
              })
          );
      } catch (error) {
          console.error("[trace] Failed to edit with entities:", error);
          // Fallback to regular edit without custom emoji entities
          await msg.edit({ text, parseMode: "html" });
      }
      
      if (!this.db.data.config.keepLog) {
          this.scheduleDelete(msg, seconds);
      }
  }
}

export default new TracePlugin();

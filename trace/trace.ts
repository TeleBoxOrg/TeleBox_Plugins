import { Plugin, type PanelSettingsAdapter, type PanelSettingField, type PanelFieldType } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import type { MessageContext } from "@mtcute/dispatcher";
import type { MtcuteInputPeerLike } from "@utils/mtcuteTypes";
import { thtml as html } from "@mtcute/html-parser";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import Long from "long";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { hasRawType } from "@utils/entityTypeGuards";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { htmlEscape } from "@utils/htmlEscape";

/** Stored reaction: unicode emoji string, or custom emoji document id as decimal string. */
type StoredReaction = string;

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// Helper to escape HTML special characters.

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
├ ➕ <code>${mainPrefix}trace kw add &lt;词&gt; 👍👎🥰</code>
│  └ 添加关键字自动回应
└ ➖ <code>${mainPrefix}trace kw del &lt;词&gt;</code>
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
  users: Record<string, StoredReaction[]>;
  keywords: Record<string, StoredReaction[]>;
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

  private db!: Awaited<ReturnType<typeof JSONFilePreset<TraceDB>>>;
  private isPremium: boolean | null = null;
  // [MODIFIED] Added a property to store our own user ID.
  private meId: string | null = null;
  private MessageBuilder: any;
  private pendingDeleteTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    super();
    this.initializeDB();
    this.initMessageBuilder();
  }
  
  private initMessageBuilder() {
    // Initialize MessageBuilder as inner class
    this.MessageBuilder = class {
      private text = '';
      private entities: any[] = [];
      
      add(str: string): void {
          this.text += str;
      }
      
      addLine(str: string): void {
          this.text += str + '\n';
      }
      
      addCustomEmoji(placeholder: string, documentId: string | Long): void {
          const offset = this.calculateOffset(this.text);
          const length = placeholder.length; // Simple length calculation
          this.text += placeholder;
          
          this.entities.push({
              _: "messageEntityCustomEmoji",
              offset,
              length,
              documentId: Long.isLong(documentId)
                ? documentId
                : Long.fromString(String(documentId)),
          });
      }
      
      private calculateOffset(text: string): number {
          // Telegram uses UTF-16 code units for offset calculation
          return text.length;
      }
      
      
      build(): { text: string, entities: any[] } {
          return { text: this.text.trim(), entities: this.entities };
      }
    };
  }

  private async initializeDB() {
    const dbPath = path.join(createDirectoryInAssets("trace"), "db.json");
    this.db = await JSONFilePreset<TraceDB>(dbPath, defaultState);
  }


  private scheduleDelete(msg: MessageContext, seconds: number): void {
    let timer: ReturnType<typeof setTimeout>;
    timer = setTimeout(() => {
      this.pendingDeleteTimers.delete(timer);
      msg.delete().catch(() => { /* msg may already be deleted */ });
    }, seconds * 1000);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
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
            const me = await client.getMe() as { isPremium?: boolean; id?: number | bigint } | undefined;
            // mtcute User has isPremium getter, not raw .premium
            this.isPremium = !!(me?.isPremium);
            this.meId = me?.id != null ? String(me.id) : null;
        } else {
            this.isPremium = false;
        }
    }
  }

  /** true if stored value is a custom-emoji document id (decimal digits), not unicode emoji */
  private isCustomEmojiId(r: StoredReaction): boolean {
    return /^\d+$/.test(r);
  }

  /** Revive DB values that may still be big-integer JSON blobs from older builds */
  private normalizeStoredReactions(list: unknown): StoredReaction[] {
    if (!Array.isArray(list)) return [];
    const out: StoredReaction[] = [];
    for (const item of list) {
      if (typeof item === "string") {
        if (item) out.push(item);
        continue;
      }
      if (typeof item === "number" && Number.isFinite(item)) {
        out.push(String(Math.trunc(item)));
        continue;
      }
      if (typeof item === "bigint") {
        out.push(item.toString());
        continue;
      }
      if (item && typeof item === "object") {
        const anyItem = item as { value?: unknown; toString?: () => string };
        if (typeof anyItem.value === "string" || typeof anyItem.value === "number") {
          out.push(String(anyItem.value));
          continue;
        }
        if (typeof anyItem.toString === "function") {
          const s = anyItem.toString();
          if (s && s !== "[object Object]") out.push(s);
        }
      }
    }
    return [...new Set(out)];
  }

  private async handleTrace(msg: MessageContext) {
    try {
      const parts = msg.text?.split(/\s+/) || [];
      const [, sub, ...args] = parts;
      const repliedMsg = await safeGetReplyMessage(msg);

      if (repliedMsg && !sub) {
        return this.untraceUser(msg, repliedMsg);
      }

      if (repliedMsg && sub) {
        const fullEmojiText = msg.text.substring(parts[0].length).trim();
        return this.traceUser(msg, repliedMsg, fullEmojiText);
      }

      switch (sub?.toLowerCase()) {
        case "kw":
          const action = (args[0] || "").toLowerCase();
          const keyword = args[1];
          const fullEmojiText = msg.text.substring(parts.slice(0, 3).join(" ").length).trim();
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
      
      await msg.edit({ text: html(help_text) });

    } catch (error: unknown) {
      logger.error("[trace] Error handling command:", error);
      const errorMsg = `❌ <b>操作失败</b>\n` +
                      `├ 💔 错误类型: ${error instanceof Error ? error.name : 'Unknown'}\n` +
                      `├ 📝 错误信息: ${htmlEscape(getErrorMessage(error))}\n` +
                      `└ 💡 请检查命令格式或稍后重试`;
      await msg.edit({ text: html(errorMsg) });
    }
  }

  /**
   * [MODIFIED] Now ignores messages sent by the bot itself to prevent feedback loops.
   */
  private async handleMessage(msg: MessageContext) {
    // Ensure we know who "I" am.
    await this.initializeSelf();
    if (!this.db?.data || !msg.sender?.id || !this.meId) return;

    // If the message is from me, ignore it completely.
    const senderId = msg.sender.id.toString();
    const isSelf = senderId === this.meId.toString();
    if (isSelf) {
        return;
    }

    const { users, keywords, config } = this.db.data;

    try {
      // User trace logic for incoming messages
      if (users[senderId]) {
        await this.sendReaction(msg.chat.id, msg.id, this.normalizeStoredReactions(users[senderId]), config.big);
        return;
      }

      // Keyword trace logic for incoming messages
      if (msg.text) {
        for (const keyword in keywords) {
          if (msg.text.includes(keyword)) {
            await this.sendReaction(msg.chat.id, msg.id, this.normalizeStoredReactions(keywords[keyword]), config.big);
            return;
          }
        }
      }
    } catch (error: unknown) {
      logger.error("[trace] Listener failed to send reaction:", error);
    }
  }

  private async traceUser(msg: MessageContext, repliedMsg: any, emojiText: string) {
    const userId = repliedMsg.sender?.id?.toString();
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
    await this.sendReaction(repliedMsg.chat.id, repliedMsg.id, reactions, this.db.data.config.big);
    const userEntity = await this.formatEntity(userId);
    // Extract actual emojis from the original message for display
    // Get reaction display with entities for custom emojis
    const reactionCount = reactions.length;
    const customCount = reactions.filter((r) => this.isCustomEmojiId(r)).length;
    
    if (customCount > 0) {
        // Build message with custom emoji entities
        const msgBuilder = new this.MessageBuilder();
        msgBuilder.addLine('✅ 追踪成功');
        msgBuilder.addLine(`├ 👤 用户: ${userEntity.display.replace(/<[^>]*>/g, '')}`);
        msgBuilder.add(`├ 🎯 表情: `);
        
        // Add reactions with proper entities
        for (const reaction of reactions) {
            if (!this.isCustomEmojiId(reaction)) {
                msgBuilder.add(reaction + ' ');
            } else {
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

  private async untraceUser(msg: MessageContext, repliedMsg: any) {
    const userId = repliedMsg.sender?.id?.toString();
    if (userId && this.db.data.users[userId]) {
      const userReactions = this.normalizeStoredReactions(this.db.data.users[userId]);
      const standardCount = userReactions.filter((r) => !this.isCustomEmojiId(r)).length;
      const customCount = userReactions.filter((r) => this.isCustomEmojiId(r)).length;
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

  private async traceKeyword(msg: MessageContext, keyword: string, emojiText: string) {
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
    const customCount = reactions.filter((r) => this.isCustomEmojiId(r)).length;
    const successMsg = `✅ <b>${isUpdate ? '更新' : '添加'}关键字追踪</b>\n` +
                      `├ 🔑 关键字: <code>${htmlEscape(keyword)}</code>\n` +
                      `├ 🎯 表情: ${reactionDisplay}\n` +
                      `├ 📊 表情数: ${reactionCount} 个${customCount > 0 ? ` (${customCount} 个会员表情)` : ''}\n` +
                      `└ 📊 当前追踪: ${Object.keys(this.db.data.keywords).length} 个关键字`;
    await this.editAndDelete(msg, successMsg, 10);
  }

  private async untraceKeyword(msg: MessageContext, keyword: string) {
    if (this.db.data.keywords[keyword]) {
      const kwReactions = this.normalizeStoredReactions(this.db.data.keywords[keyword]);
      const standardCount = kwReactions.filter((r) => !this.isCustomEmojiId(r)).length;
      const customCount = kwReactions.filter((r) => this.isCustomEmojiId(r)).length;
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
  
  private async showStatus(msg: MessageContext) {
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
        const userIds = Object.keys(users);
        const userEntities = await Promise.all(
            userIds.map((userId) => this.formatEntity(userId))
        );
        userIds.forEach((userId, index) => {
            const userEntity = userEntities[index];
            const userReactions = this.normalizeStoredReactions(users[userId]);
            const standardEmojis = userReactions.filter((r) => !this.isCustomEmojiId(r));
            const customEmojis = userReactions.filter((r) => this.isCustomEmojiId(r));
            const reactions = standardEmojis.join('') + 
                             (customEmojis.length > 0 ? ` +${customEmojis.length}会员表情` : '');
            const prefix = index === userCount - 1 ? '└' : '├';
            response += `${prefix} ${userEntity.display}\n`;
            response += `${prefix === '└' ? ' ' : '│'} └ ${reactions}\n`;
        });
    } else {
        response += `└ <i>暂无追踪用户</i>\n`;
    }
    
    // Keywords section
    response += `\n🔑 <b>追踪的关键字</b> (${keywordCount})\n`;
    if (keywordCount > 0) {
        response += `┌──────────\n`;
        let index = 0;
        for (const keyword in keywords) {
            const kwReactions = this.normalizeStoredReactions(keywords[keyword]);
            const standardEmojis = kwReactions.filter((r) => !this.isCustomEmojiId(r));
            const customEmojis = kwReactions.filter((r) => this.isCustomEmojiId(r));
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
    
    await msg.edit({ text: html(response) });
  }

  private async cleanTraces(msg: MessageContext) {
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

  private async resetDatabase(msg: MessageContext) {
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

  private async setConfig(msg: MessageContext, key: "keepLog" | "big", value: string) {
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

  private async formatEntity(target: string | { _?: unknown; id?: number | bigint; title?: string; firstName?: string; lastName?: string; username?: string }, mention?: boolean, throwErrorIfFailed?: boolean) {
    const client = await getGlobalClient();
    if (!client) throw new Error("客户端未初始化");
    let id: number | bigint | undefined;
    let entity: { _?: unknown; id?: number | bigint; title?: string; firstName?: string; lastName?: string; username?: string | null } | undefined;
    try {
      entity = (typeof target !== 'string' && target?._) ? target : await client?.getChat(target as MtcuteInputPeerLike);
      if (!entity) throw new Error("无法获取entity");
      id = entity.id;
    } catch (e: unknown) {
      if (throwErrorIfFailed) throw new Error(`无法获取 ${target}: ${e instanceof Error ? e.message : String(e)}`);
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
        hasRawType(entity, 'user')
          ? `<a href="tg://user?id=${id}">${id}</a>`
          : `<a href="https://t.me/c/${id}">${id}</a>`
      );
    }
    return { id, entity, display: displayParts.join(" ").trim() };
  }

  private async parseReactions(msg: MessageContext, text: string): Promise<StoredReaction[]> {
    await this.initializeSelf(); // Ensures isPremium is set
    const validReactions: StoredReaction[] = [];
    const customEmojiMap = new Map<number, string>();
    const customEmojiIndices = new Set<number>();
    if (this.isPremium) {
        // mtcute MessageEntity: kind="emoji", params.emojiId=Long
        for (const entity of (msg.entities || [])) {
            const e = entity as { kind?: string; params?: { emojiId?: { toString(): string } }; offset?: number; length?: number };
            if (e.kind !== "emoji") continue;
            const offset = e.offset;
            const length = e.length;
            const docId = e.params?.emojiId?.toString?.();
            if (offset == null || length == null || !docId) continue;
            customEmojiMap.set(offset, docId);
            for (let i = 0; i < length; i++) {
                customEmojiIndices.add(offset + i);
            }
        }
    }
    const textOffsetInMessage = msg.text.indexOf(text);
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

  /**
   * Root cause fix: raw client.call({ peer: chatId }) passes a bare number/string,
   * so TL serialization hits `Unknown object undefined` (peer._ is missing).
   * Use high-level sendReaction which resolvePeer + normalizeInputReaction.
   */
  private async sendReaction(
    chatId: string | number,
    msgId: number,
    reactions: StoredReaction[],
    big: boolean,
  ) {
    const client = await getGlobalClient();
    const normalized = this.normalizeStoredReactions(reactions);
    if (!client || normalized.length === 0) return;

    // mtcute InputReaction: unicode string OR Long custom-emoji id
    const emoji = normalized.map((r) =>
      this.isCustomEmojiId(r) ? Long.fromString(r) : r,
    );

    await client.sendReaction({
      chatId,
      message: msgId,
      emoji,
      big,
    });
  }

  // Remove duplicate MessageBuilder definition
  
  /**
   * Helper method to get display text for reactions (fallback without entities)
   */
  private async getReactionDisplay(msg: MessageContext, emojiText: string, reactions: StoredReaction[]): Promise<string> {
    const displayParts: string[] = [];
    let customEmojiCount = 0;
    
    for (const reaction of this.normalizeStoredReactions(reactions)) {
      if (!this.isCustomEmojiId(reaction)) {
        displayParts.push(reaction);
      } else {
        customEmojiCount++;
        const idPrefix = reaction.slice(0, 4);
        displayParts.push(`[Premium:${idPrefix}]`);
      }
    }
    
    if (customEmojiCount > 0) {
      return displayParts.join(' ') + ` (含 ${customEmojiCount} 个会员表情)`;
    }
    
    return displayParts.join(' ');
  }

  private async editAndDelete(msg: MessageContext, text: string, seconds: number = 5) {
      await msg.edit({ text: html(text) });
      if (!this.db.data.config.keepLog) {
          this.scheduleDelete(msg, seconds);
      }
  }
  
  private async editAndDeleteWithEntities(msg: MessageContext, text: string, entities: any[], seconds: number = 5) {
      const client = await getGlobalClient();
      if (!client) {
          // Fallback to regular edit if client unavailable
          await msg.edit({ text: html(text) });
          return;
      }
      
      try {
          // Use bottom-level API call to edit message with entities
          await client.call({
              _: "messages.editMessage",
              peer: await client.resolvePeer(msg.chat.id),
              id: msg.id,
              message: text,
              entities: entities,
              // Don't use parseMode when using entities
              noWebpage: true
          });
      } catch (error: unknown) {
          logger.error("[trace] Failed to edit with entities:", error);
          // Fallback to regular edit without custom emoji entities
          await msg.edit({ text: html(text) });
      }
      
      if (!this.db.data.config.keepLog) {
          this.scheduleDelete(msg, seconds);
      }
  }
}


  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "trace",
    title: "网络追踪",
    description: "网络路由追踪配置",
    category: "插件配置",
    icon: "🔍",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "timeout",
            "label": "超时 (秒)",
            "type": "number",
            "min": 5,
            "max": 120,
            "default": 30
      },
      {
            "key": "maxHops",
            "label": "最大跳数",
            "type": "number",
            "min": 5,
            "max": 64,
            "default": 30
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("trace"), "config.json"), {} as any);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("trace"), "config.json"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };

export default new TracePlugin();

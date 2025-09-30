import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "telegram";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import bigInt, { BigInteger } from "big-integer";

// Helper to escape HTML special characters.
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;'
  }[m] || m));

// A whitelist of standard emojis that are valid for reactions.
const AVAILABLE_REACTIONS = "👍👎❤️🔥🥰👏😁🤔🤯😱🤬😢🎉🤩🤮💩🙏👌🕊🤡🥱🥴😍🐳❤️‍🔥🌚🌭💯🤣⚡️🍌🏆💔🤨😐🍓🍾💋🖕😈😎😇😤🏻‍💻";

// Help text constant.
const help_text = `📝 <b>自动回应插件 (Trace)</b>

通过对来自特定用户或包含特定关键字的消息自动发送回应 (Reactions) 来追踪消息。

<b>-› 用户追踪</b>
• 回复一条消息: <code>.trace 👍👎🥰</code> - 使用指定表情追踪该用户
• 回复一条消息: <code>.trace</code> - 取消追踪该用户

<b>-› 关键字追踪</b>
• <code>.trace kw add &lt;关键字&gt; 👍👎🥰</code> - 添加关键字追踪
• <code>.trace kw del &lt;关键字&gt;</code> - 删除关键字追踪

<b>-› 管理</b>
• <code>.trace status</code> - 列出所有追踪中的用户和关键字
• <code>.trace clean</code> - 清除所有用户和关键字追踪
• <code>.trace reset</code> - ⚠️ 重置插件所有数据

<b>-› 设置</b>
• <code>.trace log [true|false]</code> - 设置是否保留操作回执 (默认: true)
• <code>.trace big [true|false]</code> - 设置是否使用大号表情动画 (默认: true)

<b>💡 提示:</b>
• 仅支持部分标准表情和自定义表情 (自定义表情需要 Premium)。
• 可用标准表情: ${AVAILABLE_REACTIONS}`;

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

  constructor() {
    super();
    this.initializeDB();
  }

  private async initializeDB() {
    const dbPath = path.join(createDirectoryInAssets("trace"), "db.json");
    this.db = await JSONFilePreset<TraceDB>(dbPath, defaultState);
  }
  
  private async checkPremiumStatus(): Promise<boolean> {
      if (this.isPremium === null) {
          const client = await getGlobalClient();
          if (client) {
              const me = await client.getMe();
              this.isPremium = (me as Api.User)?.premium || false;
          } else {
              this.isPremium = false;
          }
      }
      return this.isPremium;
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
      await msg.edit({
        text: `❌ <b>操作失败:</b> ${htmlEscape(error.message)}`,
        parseMode: "html",
      });
    }
  }

  private async handleMessage(msg: Api.Message) {
    if (!this.db?.data) return;
    const { users, keywords, config } = this.db.data;

    try {
      const senderId = msg.senderId?.toString();
      if (senderId && users[senderId]) {
        await this.sendReaction(msg.peerId, msg.id, users[senderId], config.big);
        return;
      }

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
      await this.editAndDelete(msg, "❌ 无法获取用户信息。");
      return;
    }
    const reactions = await this.parseReactions(msg, emojiText);
    if (reactions.length === 0) {
      await this.editAndDelete(msg, "❌ 未找到有效的表情符号。请检查帮助中的可用列表。");
      return;
    }
    this.db.data.users[userId] = reactions;
    await this.db.write();
    await this.sendReaction(repliedMsg.peerId, repliedMsg.id, reactions, this.db.data.config.big);
    const userEntity = await this.formatEntity(userId);
    await this.editAndDelete(msg, `✅ <b>成功追踪用户:</b> ${userEntity.display}`, 10);
  }

  private async untraceUser(msg: Api.Message, repliedMsg: Api.Message) {
    const userId = repliedMsg.senderId?.toString();
    if (userId && this.db.data.users[userId]) {
      delete this.db.data.users[userId];
      await this.db.write();
      const userEntity = await this.formatEntity(userId);
      await this.editAndDelete(msg, `🗑️ <b>已取消追踪用户:</b> ${userEntity.display}`, 10);
    } else {
      await this.editAndDelete(msg, "ℹ️ 该用户未被追踪。");
    }
  }

  private async traceKeyword(msg: Api.Message, keyword: string, emojiText: string) {
    const reactions = await this.parseReactions(msg, emojiText);
    if (reactions.length === 0) {
      await this.editAndDelete(msg, "❌ 未找到有效的表情符号。请检查帮助中的可用列表。");
      return;
    }
    this.db.data.keywords[keyword] = reactions;
    await this.db.write();
    await this.editAndDelete(msg, `✅ <b>成功追踪关键字:</b> <code>${htmlEscape(keyword)}</code>`, 10);
  }

  private async untraceKeyword(msg: Api.Message, keyword: string) {
    if (this.db.data.keywords[keyword]) {
      delete this.db.data.keywords[keyword];
      await this.db.write();
      await this.editAndDelete(msg, `🗑️ <b>已取消追踪关键字:</b> <code>${htmlEscape(keyword)}</code>`, 10);
    } else {
      await this.editAndDelete(msg, `ℹ️ 关键字 "<code>${htmlEscape(keyword)}</code>" 未被追踪。`);
    }
  }
  
  private async showStatus(msg: Api.Message) {
    let response = "📄 <b>Trace 状态</b>\n\n";
    response += "<b>👤 追踪的用户:</b>\n";
    const users = this.db.data.users || {};
    if (Object.keys(users).length > 0) {
        for (const userId in users) {
            const userEntity = await this.formatEntity(userId);
            response += `• ${userEntity.display}\n`;
        }
    } else {
        response += "• <i>无</i>\n";
    }
    response += "\n<b>🔑 追踪的关键字:</b>\n";
    const keywords = this.db.data.keywords || {};
    if (Object.keys(keywords).length > 0) {
        for (const keyword in keywords) {
            response += `• <code>${htmlEscape(keyword)}</code>\n`;
        }
    } else {
        response += "• <i>无</i>\n";
    }
    response += `\n<b>⚙️ 设置:</b>\n`;
    response += `• 保留日志: <code>${this.db.data.config.keepLog}</code>\n`;
    response += `• 大号动画: <code>${this.db.data.config.big}</code>\n`;
    await msg.edit({ text: response, parseMode: "html" });
  }

  private async cleanTraces(msg: Api.Message) {
    this.db.data.users = {};
    this.db.data.keywords = {};
    await this.db.write();
    await this.editAndDelete(msg, "🗑️ <b>已清除所有用户和关键字追踪。</b>", 10);
  }

  private async resetDatabase(msg: Api.Message) {
    this.db.data = defaultState;
    await this.db.write();
    await this.editAndDelete(msg, "⚠️ <b>Trace 插件数据库已重置。</b>", 10);
  }

  private async setConfig(msg: Api.Message, key: "keepLog" | "big", value: string) {
    const boolValue = value?.toLowerCase() === "true";
    if (value === undefined || (value.toLowerCase() !== "true" && value.toLowerCase() !== "false")) {
        await this.editAndDelete(msg, `❌ 无效值。请使用 'true' 或 'false'。`);
        return;
    }
    this.db.data.config[key] = boolValue;
    await this.db.write();
    await this.editAndDelete(msg, `✅ <b>设置已更新:</b> <code>${key}</code> = <code>${boolValue}</code>`, 10);
  }

  private async formatEntity(target: any, mention?: boolean, throwErrorIfFailed?: boolean) {
    const client = await getGlobalClient();
    if (!client) throw new Error("客户端未初始化");
    let id: any, entity: any;
    try {
      entity = target?.className ? target : await client?.getEntity(target);
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
    const validReactions: (string | BigInteger)[] = [];
    const isPremium = await this.checkPremiumStatus();
    const customEmojiMap = new Map<number, BigInteger>();
    const customEmojiIndices = new Set<number>();
    if (isPremium) {
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

  private async sendReaction(peer: Api.TypePeer, msgId: number, reactions: (string | any)[], big: boolean) {
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

  /**
   * [MODIFIED] Unreferences the timer to allow the Node.js process to exit gracefully during restarts.
   */
  private async editAndDelete(msg: Api.Message, text: string, seconds: number = 5) {
      await msg.edit({ text, parseMode: "html" });
      if (!this.db.data.config.keepLog) {
          // Create the timer.
          const timer = setTimeout(() => {
              msg.delete().catch(() => {}); // Add a catch for safety.
          }, seconds * 1000);
          
          // Unreference it so it doesn't block the process from exiting.
          timer.unref();
      }
  }
}

export default new TracePlugin();

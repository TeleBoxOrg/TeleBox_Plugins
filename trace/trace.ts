import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getEntityWithHash } from "@utils/entityHelpers";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api, TelegramClient } from "telegram";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// 原生表情符号常量
const NATIVE_EMOJI = "👍👎❤️🔥🥰👏😁🤔🤯😱🤬😢🎉🤩🤮💩🙏👌🕊🤡🥱🥴😍🐳❤️‍🔥🌚🌭💯🤣⚡️🍌🏆💔🤨😐🍓🍾💋🖕😈😂😭";

// 数据库接口定义
interface TraceConfig {
  keep_log: boolean;
  big: boolean;
}

interface TracedUser {
  user_id: number;
  reactions: string[];
}

interface TracedKeyword {
  keyword: string;
  reactions: string[];
}

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 延迟函数
const sleep = (ms: number): Promise<void> => 
  new Promise(resolve => setTimeout(resolve, ms));

// 数据库管理类
class TraceDB {
  private db: Database.Database;
  private dbPath: string;

  constructor() {
    const pluginDir = createDirectoryInAssets("trace");
    this.dbPath = path.join(pluginDir, "trace.db");
    this.db = new Database(this.dbPath);
    this.init();
  }

  private init(): void {
    // 创建配置表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // 创建用户追踪表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traced_users (
        user_id INTEGER PRIMARY KEY,
        reactions TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 创建关键词追踪表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traced_keywords (
        keyword TEXT PRIMARY KEY,
        reactions TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 初始化默认配置
    this.initDefaultConfig();
  }

  private initDefaultConfig(): void {
    const defaultConfig = { keep_log: true, big: true };
    
    for (const [key, value] of Object.entries(defaultConfig)) {
      const existing = this.getConfig(key);
      if (existing === null) {
        this.setConfig(key, value.toString());
      }
    }
  }

  // 配置管理
  setConfig(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO config (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, value);
  }

  getConfig(key: string): string | null {
    const stmt = this.db.prepare(`SELECT value FROM config WHERE key = ?`);
    const result = stmt.get(key) as { value: string } | undefined;
    return result?.value || null;
  }

  getTraceConfig(): TraceConfig {
    return {
      keep_log: this.getConfig('keep_log') === 'true',
      big: this.getConfig('big') === 'true'
    };
  }

  // 用户追踪管理
  addTracedUser(userId: number, reactions: string[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO traced_users (user_id, reactions)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET 
        reactions = excluded.reactions,
        created_at = CURRENT_TIMESTAMP
    `);
    stmt.run(userId, JSON.stringify(reactions));
  }

  removeTracedUser(userId: number): string[] | null {
    const stmt = this.db.prepare(`SELECT reactions FROM traced_users WHERE user_id = ?`);
    const result = stmt.get(userId) as { reactions: string } | undefined;
    
    if (result) {
      const deleteStmt = this.db.prepare(`DELETE FROM traced_users WHERE user_id = ?`);
      deleteStmt.run(userId);
      return JSON.parse(result.reactions);
    }
    return null;
  }

  getTracedUser(userId: number): string[] | null {
    const stmt = this.db.prepare(`SELECT reactions FROM traced_users WHERE user_id = ?`);
    const result = stmt.get(userId) as { reactions: string } | undefined;
    return result ? JSON.parse(result.reactions) : null;
  }

  getAllTracedUsers(): TracedUser[] {
    const stmt = this.db.prepare(`SELECT user_id, reactions FROM traced_users`);
    const results = stmt.all() as { user_id: number; reactions: string }[];
    return results.map(row => ({
      user_id: row.user_id,
      reactions: JSON.parse(row.reactions)
    }));
  }

  // 关键词追踪管理
  addTracedKeyword(keyword: string, reactions: string[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO traced_keywords (keyword, reactions)
      VALUES (?, ?)
      ON CONFLICT(keyword) DO UPDATE SET 
        reactions = excluded.reactions,
        created_at = CURRENT_TIMESTAMP
    `);
    stmt.run(keyword, JSON.stringify(reactions));
  }

  removeTracedKeyword(keyword: string): string[] | null {
    const stmt = this.db.prepare(`SELECT reactions FROM traced_keywords WHERE keyword = ?`);
    const result = stmt.get(keyword) as { reactions: string } | undefined;
    
    if (result) {
      const deleteStmt = this.db.prepare(`DELETE FROM traced_keywords WHERE keyword = ?`);
      deleteStmt.run(keyword);
      return JSON.parse(result.reactions);
    }
    return null;
  }

  getTracedKeyword(keyword: string): string[] | null {
    const stmt = this.db.prepare(`SELECT reactions FROM traced_keywords WHERE keyword = ?`);
    const result = stmt.get(keyword) as { reactions: string } | undefined;
    return result ? JSON.parse(result.reactions) : null;
  }

  getAllTracedKeywords(): TracedKeyword[] {
    const stmt = this.db.prepare(`SELECT keyword, reactions FROM traced_keywords`);
    const results = stmt.all() as { keyword: string; reactions: string }[];
    return results.map(row => ({
      keyword: row.keyword,
      reactions: JSON.parse(row.reactions)
    }));
  }

  // 清理所有数据
  clearAll(): void {
    this.db.exec(`DELETE FROM traced_users`);
    this.db.exec(`DELETE FROM traced_keywords`);
  }

  // 重置所有数据（包括配置）
  resetAll(): void {
    this.db.exec(`DELETE FROM traced_users`);
    this.db.exec(`DELETE FROM traced_keywords`);
    this.db.exec(`DELETE FROM config`);
    this.initDefaultConfig();
  }

  close(): void {
    this.db.close();
  }
}

// 全局数据库实例
const traceDB = new TraceDB();

// 工具函数：解析表情符号
function parseEmojis(text: string): string[] {
  const emojis: string[] = [];
  
  // 简单遍历字符，检查是否在支持的表情列表中
  for (const char of text) {
    if (emojis.length >= 3) break;
    if (NATIVE_EMOJI.includes(char) && !emojis.includes(char)) {
      emojis.push(char);
    }
  }
  
  return emojis;
}

// 工具函数：生成反应列表
async function generateReactionList(emojis: string[]): Promise<Api.TypeReaction[]> {
  const reactions: Api.TypeReaction[] = [];
  
  for (const emoji of emojis.slice(0, 3)) { // 最多3个反应
    if (NATIVE_EMOJI.includes(emoji)) {
      reactions.push(new Api.ReactionEmoji({ emoticon: emoji }));
    }
  }
  
  return reactions;
}

// 工具函数：发送反应
async function sendReaction(
  client: TelegramClient, 
  chatId: number | string, 
  messageId: number, 
  reactions: Api.TypeReaction[],
  big: boolean = false
): Promise<void> {
  try {
    const peer = await getEntityWithHash(client, chatId);
    if (!peer) return;

    await client.invoke(new Api.messages.SendReaction({
      peer: peer,
      msgId: messageId,
      reaction: reactions,
      big: big
    }));
  } catch (error: any) {
    console.error("[Trace] 发送反应失败:", error);
  }
}

// 工具函数：编辑并删除消息
async function editAndDelete(
  msg: Api.Message,
  text: string,
  seconds: number = 5,
  keepLog: boolean = false
): Promise<void> {
  await msg.edit({ text, parseMode: "html" });
  
  if (seconds === -1 || keepLog) {
    return;
  }
  
  await sleep(seconds * 1000);
  try {
    await msg.delete();
  } catch (error) {
    console.error("[Trace] 删除消息失败:", error);
  }
}

// 工具函数：格式化用户信息
function formatUserInfo(user: any): string {
  let name = "";
  if (user.firstName) name += user.firstName;
  if (user.lastName) name += " " + user.lastName;
  
  if (user.username) {
    return `@${user.username}`;
  } else if (name.trim()) {
    return name.trim();
  } else {
    return "未知用户";
  }
}

// 工具函数：格式化反应列表
function formatReactions(reactions: string[]): string {
  return reactions.length > 0 ? `[${reactions.join(", ")}]` : "[无反应]";
}

const tracePlugin: Plugin = {
  command: ["trace"],
  description: `消息追踪插件 - 自动为特定用户或关键词添加表情反应

功能特性:
• 用户追踪 - 对特定用户的消息自动添加反应
• 关键词追踪 - 对包含特定关键词的消息自动添加反应  
• 配置管理 - 管理日志保留和大表情设置
• 状态查看 - 查看所有追踪的用户和关键词

基础用法:
• 回复消息使用 .trace [表情] - 追踪用户
• 回复消息使用 .trace - 取消追踪用户
• .trace kw add [关键词] [表情] - 追踪关键词
• .trace kw del [关键词] - 删除关键词追踪

管理命令:
• .trace status - 查看所有追踪状态
• .trace clean - 清除所有追踪
• .trace log [true|false] - 设置日志保留
• .trace big [true|false] - 设置大表情模式

可用表情: ${NATIVE_EMOJI}

注意: 最多支持3个表情反应，仅支持原生Telegram表情`,

  cmdHandler: async (msg: Api.Message) => {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    const text = msg.message || "";
    const args = text.trim().split(/\s+/);
    let showHelp = false;

    const filteredArgs = args.slice(1).filter(arg => {
      if (arg === 'help' || arg === 'h') {
        showHelp = true;
        return false;
      }
      return true;
    });

    if (showHelp) {
      await msg.edit({
        text: tracePlugin.description!,
        parseMode: "html",
        linkPreview: false
      });
      return;
    }

    const config = traceDB.getTraceConfig();

    try {
      // 无参数情况 - 取消追踪或显示帮助
      if (filteredArgs.length === 0) {
        const replyMsg = await msg.getReplyMessage();
        if (!replyMsg || !replyMsg.fromId) {
          await editAndDelete(
            msg, 
            "❌ <b>参数错误:</b> 请回复一条消息来取消追踪，或使用 <code>.trace help</code> 查看帮助", 
            5, 
            config.keep_log
          );
          return;
        }

        const userId = Number(replyMsg.senderId?.toString());
        if (!userId) {
          await editAndDelete(
            msg,
            "❌ <b>错误:</b> 无法获取用户ID",
            5,
            config.keep_log
          );
          return;
        }
        const prevReactions = traceDB.removeTracedUser(userId);
        
        if (!prevReactions) {
          await editAndDelete(
            msg, 
            "❌ 该用户未在追踪列表中", 
            5, 
            config.keep_log
          );
          return;
        }

        const userInfo = await client.getEntity(replyMsg.fromId);
        const formattedUser = formatUserInfo(userInfo);
        
        await editAndDelete(
          msg,
          `✅ <b>成功取消追踪:</b>\n👤 ${htmlEscape(formattedUser)}\n🎭 ${formatReactions(prevReactions)}`,
          5,
          config.keep_log
        );
        return;
      }

      // 单参数情况
      if (filteredArgs.length === 1) {
        const param = filteredArgs[0];

        // 状态查看
        if (param === "status") {
          const tracedUsers = traceDB.getAllTracedUsers();
          const tracedKeywords = traceDB.getAllTracedKeywords();
          
          let statusText = "<b>🔍 追踪状态</b>\n\n";
          
          // 用户追踪列表
          statusText += "<b>👥 追踪用户:</b>\n";
          if (tracedUsers.length === 0) {
            statusText += "• 无\n";
          } else {
            for (const tracedUser of tracedUsers) {
              try {
                const userEntity = await client.getEntity(tracedUser.user_id);
                const userInfo = formatUserInfo(userEntity);
                statusText += `• ${htmlEscape(userInfo)} ${formatReactions(tracedUser.reactions)}\n`;
              } catch {
                statusText += `• 用户ID:${tracedUser.user_id} ${formatReactions(tracedUser.reactions)}\n`;
              }
            }
          }
          
          // 关键词追踪列表
          statusText += "\n<b>🔤 追踪关键词:</b>\n";
          if (tracedKeywords.length === 0) {
            statusText += "• 无\n";
          } else {
            for (const tracedKeyword of tracedKeywords) {
              statusText += `• "${htmlEscape(tracedKeyword.keyword)}" ${formatReactions(tracedKeyword.reactions)}\n`;
            }
          }
          
          // 配置信息
          statusText += `\n<b>⚙️ 配置:</b>\n`;
          statusText += `• 保留日志: ${config.keep_log ? '✅' : '❌'}\n`;
          statusText += `• 大表情: ${config.big ? '✅' : '❌'}`;
          
          await editAndDelete(msg, statusText, 15, config.keep_log);
          return;
        }

        // 清除所有追踪
        if (param === "clean") {
          const tracedUsers = traceDB.getAllTracedUsers();
          const tracedKeywords = traceDB.getAllTracedKeywords();
          
          traceDB.clearAll();
          
          await editAndDelete(
            msg,
            `✅ <b>清除完成</b>\n\n📊 <b>统计:</b>\n• 用户: ${tracedUsers.length} 个\n• 关键词: ${tracedKeywords.length} 个`,
            5,
            config.keep_log
          );
          return;
        }

        // 重置所有数据
        if (param === "resettrace") {
          traceDB.resetAll();
          await editAndDelete(
            msg,
            "✅ <b>数据库已重置</b>",
            5,
            config.keep_log
          );
          return;
        }

        // 追踪用户（带表情）
        const replyMsg = await msg.getReplyMessage();
        if (!replyMsg || !replyMsg.fromId) {
          await editAndDelete(
            msg,
            "❌ <b>参数错误:</b> 请回复一条消息来追踪用户\n\n💡 使用 <code>.trace help</code> 查看帮助",
            5,
            config.keep_log
          );
          return;
        }

        const emojis = parseEmojis(param);
        if (emojis.length === 0) {
          await editAndDelete(
            msg,
            "❌ <b>表情错误:</b> 未找到有效的原生表情符号\n\n💡 使用 <code>.trace help</code> 查看可用表情",
            5,
            config.keep_log
          );
          return;
        }

        const userId = Number(replyMsg.senderId?.toString());
        if (!userId) {
          await editAndDelete(
            msg,
            "❌ <b>错误:</b> 无法获取用户ID",
            5,
            config.keep_log
          );
          return;
        }
        traceDB.addTracedUser(userId, emojis);

        // 立即发送反应作为演示
        const reactions = await generateReactionList(emojis);
        await sendReaction(client, msg.chatId!.toString(), replyMsg.id, reactions, config.big);

        const userInfo = await client.getEntity(replyMsg.fromId);
        const formattedUser = formatUserInfo(userInfo);
        
        await editAndDelete(
          msg,
          `✅ <b>成功追踪用户:</b>\n👤 ${htmlEscape(formattedUser)}\n🎭 ${formatReactions(emojis)}`,
          5,
          config.keep_log
        );
        return;
      }

      // 双参数情况
      if (filteredArgs.length === 2) {
        const [param1, param2] = filteredArgs;

        // 日志配置
        if (param1 === "log") {
          if (param2 === "true") {
            traceDB.setConfig("keep_log", "true");
            await msg.edit({ text: "✅ <b>日志保留:</b> 已启用", parseMode: "html" });
          } else if (param2 === "false") {
            traceDB.setConfig("keep_log", "false");
            await msg.edit({ text: "✅ <b>日志保留:</b> 已禁用", parseMode: "html" });
          } else {
            await editAndDelete(
              msg,
              "❌ <b>参数错误:</b> 请使用 true 或 false\n\n💡 使用 <code>.trace help</code> 查看帮助",
              5,
              config.keep_log
            );
          }
          return;
        }

        // 大表情配置
        if (param1 === "big") {
          if (param2 === "true") {
            traceDB.setConfig("big", "true");
            await msg.edit({ text: "✅ <b>大表情模式:</b> 已启用", parseMode: "html" });
          } else if (param2 === "false") {
            traceDB.setConfig("big", "false");
            await msg.edit({ text: "✅ <b>大表情模式:</b> 已禁用", parseMode: "html" });
          } else {
            await editAndDelete(
              msg,
              "❌ <b>参数错误:</b> 请使用 true 或 false\n\n💡 使用 <code>.trace help</code> 查看帮助",
              5,
              config.keep_log
            );
          }
          return;
        }

        // 删除关键词追踪
        if (param1 === "kw" && param2 === "del") {
          await editAndDelete(
            msg,
            "❌ <b>参数错误:</b> 请指定要删除的关键词\n\n💡 用法: <code>.trace kw del [关键词]</code>",
            5,
            config.keep_log
          );
          return;
        }
      }

      // 三参数及以上情况
      if (filteredArgs.length >= 3) {
        const [param1, param2, param3, ...restArgs] = filteredArgs;

        // 添加关键词追踪
        if (param1 === "kw" && param2 === "add") {
          const keyword = param3;
          // 从剩余参数中解析表情，或从第四个参数开始的所有内容
          const emojiText = restArgs.join(" ") || "👍"; // 默认表情
          const emojis = parseEmojis(emojiText);
          
          if (emojis.length === 0) {
            await editAndDelete(
              msg,
              "❌ <b>表情错误:</b> 请在关键词后添加有效的表情符号\n\n💡 用法: <code>.trace kw add [关键词] [表情]</code>",
              5,
              config.keep_log
            );
            return;
          }

          traceDB.addTracedKeyword(keyword, emojis);
          
          await editAndDelete(
            msg,
            `✅ <b>成功追踪关键词:</b>\n🔤 "${htmlEscape(keyword)}"\n🎭 ${formatReactions(emojis)}`,
            5,
            config.keep_log
          );
          return;
        }

        // 删除关键词追踪
        if (param1 === "kw" && param2 === "del") {
          if (!param3) {
            await editAndDelete(
              msg,
              "❌ <b>参数错误:</b> 请指定要删除的关键词\n\n💡 用法: <code>.trace kw del [关键词]</code>",
              5,
              config.keep_log
            );
            return;
          }
          const keyword = param3;
          const prevReactions = traceDB.removeTracedKeyword(keyword);
          
          if (!prevReactions) {
            await editAndDelete(
              msg,
              `❌ 关键词 "${htmlEscape(keyword)}" 未在追踪列表中`,
              5,
              config.keep_log
            );
            return;
          }

          await editAndDelete(
            msg,
            `✅ <b>成功删除关键词追踪:</b>\n🔤 "${htmlEscape(keyword)}"\n🎭 ${formatReactions(prevReactions)}`,
            5,
            config.keep_log
          );
          return;
        }
      }

      // 未匹配的参数
      await editAndDelete(
        msg,
        "❌ <b>参数错误:</b> 未知的命令格式\n\n💡 使用 <code>.trace help</code> 查看帮助",
        5,
        config.keep_log
      );

    } catch (error: any) {
      console.error("[Trace] 命令处理失败:", error);
      await editAndDelete(
        msg,
        `❌ <b>操作失败:</b> ${htmlEscape(error.message)}`,
        5,
        config.keep_log
      );
    }
  },

  // 消息监听器 - 自动反应功能
  listenMessageHandler: async (msg: Api.Message) => {
    if (!msg.fromId || !msg.chatId) return;

    const client = await getGlobalClient();
    if (!client) return;

    const config = traceDB.getTraceConfig();

    try {
      // 检查用户追踪
      const userId = Number(msg.senderId?.toString());
      const userReactions = traceDB.getTracedUser(userId);
      
      if (userReactions && userReactions.length > 0) {
        const reactions = await generateReactionList(userReactions);
        await sendReaction(client, msg.chatId!.toString(), msg.id, reactions, config.big);
        return; // 用户追踪优先级更高，避免重复反应
      }

      // 检查关键词追踪
      if (msg.message) {
        const trackedKeywords = traceDB.getAllTracedKeywords();
        
        for (const trackedKeyword of trackedKeywords) {
          if (msg.message.includes(trackedKeyword.keyword)) {
            const reactions = await generateReactionList(trackedKeyword.reactions);
            await sendReaction(client, msg.chatId!.toString(), msg.id, reactions, config.big);
            break; // 只匹配第一个关键词，避免重复反应
          }
        }
      }

    } catch (error: any) {
      console.error("[Trace] 消息监听处理失败:", error);
    }
  }
};

export default tracePlugin;

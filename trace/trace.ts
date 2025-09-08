import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getEntityWithHash } from "@utils/entityHelpers";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getPrefixes } from "@utils/pluginManager";
import { Api, TelegramClient } from "telegram";
import Database from "better-sqlite3";
import path from "path";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 原生表情符号常量 - 只包含Telegram支持的基础emoji
const NATIVE_EMOJI = ["👍", "👎", "❤️", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "🌚", "🌭", "💯", "🤣", "⚡️", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😂", "😭"];

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 延迟函数
const sleep = (ms: number): Promise<void> => 
  new Promise(resolve => setTimeout(resolve, ms));

// 数据库接口定义
interface TraceConfig {
  keep_log: boolean;
  big: boolean;
}

interface TracedUser {
  user_id: number;
  reactions: string[];
}

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

  // 清理所有数据
  clearAll(): void {
    this.db.exec(`DELETE FROM traced_users`);
  }

  // 重置所有数据（包括配置）
  resetAll(): void {
    this.db.exec(`DELETE FROM traced_users`);
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
  
  // 遍历支持的emoji列表，检查文本中是否包含
  for (const emoji of NATIVE_EMOJI) {
    if (emojis.length >= 3) break;
    if (text.includes(emoji) && !emojis.includes(emoji)) {
      emojis.push(emoji);
    }
  }
  
  return emojis;
}

// 工具函数：生成反应列表
async function generateReactionList(emojis: string[]): Promise<Api.TypeReaction[]> {
  const reactions: Api.TypeReaction[] = [];
  
  for (const emoji of emojis.slice(0, 3)) { // 最多3个反应
    // 确保emoji在支持列表中
    if (emoji && NATIVE_EMOJI.includes(emoji)) {
      console.log(`[Trace] 添加反应: ${emoji}`);
      reactions.push(new Api.ReactionEmoji({ emoticon: emoji }));
    } else {
      console.log(`[Trace] 跳过不支持的emoji: ${emoji}`);
    }
  }
  
  console.log(`[Trace] 生成了 ${reactions.length} 个反应`);
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
    if (!peer) {
      console.error("[Trace] 无法获取聊天实体");
      return;
    }

    // 检查reactions是否为空
    if (!reactions || reactions.length === 0) {
      console.log("[Trace] 跳过发送空反应");
      return;
    }

    await client.invoke(new Api.messages.SendReaction({
      peer: peer,
      msgId: messageId,
      reaction: reactions,
      big: big,
      addToRecent: true
    }));
    
    console.log(`[Trace] 成功发送 ${reactions.length} 个反应到消息 ${messageId}`);
  } catch (error: any) {
    console.error("[Trace] 发送反应失败:", error.message || error);
    
    // 如果是REACTION_INVALID错误，尝试不带big参数重新发送
    if (error.errorMessage === 'REACTION_INVALID' && big) {
      try {
        console.log("[Trace] 尝试不带big参数重新发送反应");
        const retryPeer = await getEntityWithHash(client, chatId);
        if (retryPeer) {
          await client.invoke(new Api.messages.SendReaction({
            peer: retryPeer,
            msgId: messageId,
            reaction: reactions,
            big: false,
            addToRecent: true
          }));
          console.log("[Trace] 重试发送反应成功");
        }
      } catch (retryError: any) {
        console.error("[Trace] 重试发送反应失败:", retryError.message || retryError);
      }
    }
  }
}

// 工具函数：编辑并删除消息
async function editAndDelete(
  msg: Api.Message,
  text: string,
  seconds: number = 5,
  keepLog: boolean = false
): Promise<void> {
  try {
    await msg.edit({ text, parseMode: "html" });
    
    if (seconds === -1 || keepLog) {
      return;
    }
    
    await sleep(seconds * 1000);
    await msg.delete();
  } catch (error: any) {
    console.error("[Trace] 消息操作失败:", error.message || error);
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

// 帮助文档（等宽处理）
const help_text = `🎭 <b>全局表情追踪插件</b> - 自动为特定用户的消息添加表情反应

<b>📝 功能特性:</b>
• 👥 <b>用户追踪</b> - 对特定用户的消息自动添加表情反应
• ⚙️ <b>配置管理</b> - 管理日志保留和大表情设置
• 📊 <b>状态查看</b> - 查看所有追踪的用户

<b>🔧 基础用法:</b>
• 回复消息使用 <code>${mainPrefix}trace [表情]</code> - 追踪用户
• 回复消息使用 <code>${mainPrefix}trace</code> - 取消追踪用户

<b>🔄 管理命令:</b>
• <code>${mainPrefix}trace status</code> - 查看所有追踪状态
• <code>${mainPrefix}trace clean</code> - 清除所有追踪
• <code>${mainPrefix}trace log [true|false]</code> - 设置日志保留
• <code>${mainPrefix}trace big [true|false]</code> - 设置大表情模式
• <code>${mainPrefix}trace help</code> - 显示此帮助

<b>🎨 可用表情:</b> ${NATIVE_EMOJI.join(" ")}

<b>⚠️ 注意:</b> 
• 最多支持3个表情反应，仅支持原生Telegram表情`;

class TracePlugin extends Plugin {
  description: string = help_text;
  
  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    trace: async (msg: Api.Message, trigger?: Api.Message) => {
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

      const config = traceDB.getTraceConfig();

      try {
        // 无参数时的处理
        if (!sub) {
          const replyMsg = await msg.getReplyMessage();
          if (replyMsg && replyMsg.fromId) {
            // 取消追踪用户
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
                "❌ <b>错误:</b> 该用户未在追踪列表中", 
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
          } else {
            await msg.edit({
              text: `❌ <b>参数不足</b>\n\n💡 使用 <code>${mainPrefix}trace help</code> 查看帮助`,
              parseMode: "html"
            });
            return;
          }
        }

        // 明确请求帮助时才显示
        if (sub === "help" || sub === "h") {
          await msg.edit({
            text: help_text,
            parseMode: "html"
          });
          return;
        }

        // 状态查看
        if (sub === "status") {
          await msg.edit({ text: "🔄 正在获取追踪状态...", parseMode: "html" });
          
          const tracedUsers = traceDB.getAllTracedUsers();
          
          let statusText = "<b>🔍 追踪状态</b>\n\n";
          
          // 用户追踪列表
          statusText += "<b>👥 追踪用户:</b>\n";
          if (tracedUsers.length === 0) {
            statusText += "• 暂无追踪用户\n";
          } else {
            for (const tracedUser of tracedUsers) {
              try {
                const userEntity = await client.getEntity(tracedUser.user_id);
                const userInfo = formatUserInfo(userEntity);
                statusText += `• ${htmlEscape(userInfo)} ${formatReactions(tracedUser.reactions)}\n`;
              } catch (error: any) {
                console.error(`[Trace] 获取用户 ${tracedUser.user_id} 信息失败:`, error.message);
                statusText += `• 用户ID: ${tracedUser.user_id} ${formatReactions(tracedUser.reactions)}\n`;
              }
            }
          }
          
          // 配置信息
          statusText += `\n<b>⚙️ 当前配置:</b>\n`;
          statusText += `• 保留日志: ${config.keep_log ? '✅ 启用' : '❌ 禁用'}\n`;
          statusText += `• 大表情模式: ${config.big ? '✅ 启用' : '❌ 禁用'}\n`;
          statusText += `\n<b>📊 统计信息:</b>\n`;
          statusText += `• 追踪用户数: ${tracedUsers.length}`;
          
          await editAndDelete(msg, statusText, 15, config.keep_log);
          return;
        }

        // 清除所有追踪
        if (sub === "clean") {
          await msg.edit({ text: "🧹 正在清除所有追踪...", parseMode: "html" });
          
          const tracedUsers = traceDB.getAllTracedUsers();
          const count = tracedUsers.length;
          
          if (count === 0) {
            await editAndDelete(
              msg,
              "⚠️ <b>提示:</b> 当前没有任何追踪项",
              5,
              config.keep_log
            );
            return;
          }
          
          traceDB.clearAll();
          
          await editAndDelete(
            msg,
            `✅ <b>清除完成</b>\n\n📊 <b>已清除:</b>\n• 追踪用户: ${count} 个`,
            5,
            config.keep_log
          );
          return;
        }

        // 日志配置
        if (sub === "log" && args.length >= 2) {
          const value = args[1].toLowerCase();
          if (value === "true") {
            traceDB.setConfig("keep_log", "true");
            await msg.edit({ text: "✅ <b>日志保留:</b> 已启用", parseMode: "html" });
          } else if (value === "false") {
            traceDB.setConfig("keep_log", "false");
            await msg.edit({ text: "✅ <b>日志保留:</b> 已禁用", parseMode: "html" });
          } else {
            await editAndDelete(
              msg,
              `❌ <b>参数错误:</b> 请使用 true 或 false\n\n💡 用法: <code>${mainPrefix}trace log [true|false]</code>`,
              5,
              config.keep_log
            );
          }
          return;
        }

        // 大表情配置
        if (sub === "big" && args.length >= 2) {
          const value = args[1].toLowerCase();
          if (value === "true") {
            traceDB.setConfig("big", "true");
            await msg.edit({ text: "✅ <b>大表情模式:</b> 已启用", parseMode: "html" });
          } else if (value === "false") {
            traceDB.setConfig("big", "false");
            await msg.edit({ text: "✅ <b>大表情模式:</b> 已禁用", parseMode: "html" });
          } else {
            await editAndDelete(
              msg,
              `❌ <b>参数错误:</b> 请使用 true 或 false\n\n💡 用法: <code>${mainPrefix}trace big [true|false]</code>`,
              5,
              config.keep_log
            );
          }
          return;
        }

        // 追踪用户（带表情）- 需要回复消息
        const replyMsg = await msg.getReplyMessage();
        if (replyMsg && replyMsg.fromId) {
          const emojis = parseEmojis(sub);
          if (emojis.length === 0) {
            // 尝试从整个参数解析表情
            const allArgs = args.join(" ");
            const emojisFromAll = parseEmojis(allArgs);
            if (emojisFromAll.length === 0) {
              await editAndDelete(
                msg,
                `❌ <b>表情错误:</b> 未找到有效的原生表情符号\n\n💡 使用 <code>${mainPrefix}trace help</code> 查看可用表情`,
                5,
                config.keep_log
              );
              return;
            }
            emojis.push(...emojisFromAll);
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
          
          // 检查是否已经追踪该用户
          const existingReactions = traceDB.getTracedUser(userId);
          if (existingReactions) {
            // 更新追踪
            traceDB.addTracedUser(userId, emojis);
            const userInfo = await client.getEntity(replyMsg.fromId);
            const formattedUser = formatUserInfo(userInfo);
            
            await editAndDelete(
              msg,
              `🔄 <b>更新追踪用户:</b>\n👤 ${htmlEscape(formattedUser)}\n🎭 旧: ${formatReactions(existingReactions)}\n🎭 新: ${formatReactions(emojis)}`,
              5,
              config.keep_log
            );
          } else {
            // 新增追踪
            traceDB.addTracedUser(userId, emojis);
            const userInfo = await client.getEntity(replyMsg.fromId);
            const formattedUser = formatUserInfo(userInfo);
            
            await editAndDelete(
              msg,
              `✅ <b>成功追踪用户:</b>\n👤 ${htmlEscape(formattedUser)}\n🎭 ${formatReactions(emojis)}`,
              5,
              config.keep_log
            );
          }

          // 立即发送反应作为演示
          const reactions = await generateReactionList(emojis);
          await sendReaction(client, msg.chatId!.toString(), replyMsg.id, reactions, config.big);
          return;
        }

        // 未知命令
        await msg.edit({
          text: `❌ <b>未知命令:</b> <code>${htmlEscape(sub)}</code>\n\n💡 使用 <code>${mainPrefix}trace help</code> 查看帮助`,
          parseMode: "html"
        });

      } catch (error: any) {
        console.error("[Trace] 命令处理失败:", error);
        await msg.edit({
          text: `❌ <b>操作失败:</b> ${htmlEscape(error.message || "未知错误")}`,
          parseMode: "html"
        });
      }
    }
  };

  // 消息监听器 - 自动反应功能
  listenMessageHandler = async (msg: Api.Message) => {
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
        if (reactions.length > 0) {
          await sendReaction(client, msg.chatId!.toString(), msg.id, reactions, config.big);
        }
      }

    } catch (error: any) {
      console.error("[Trace] 消息监听处理失败:", error);
    }
  };
}

export default new TracePlugin();

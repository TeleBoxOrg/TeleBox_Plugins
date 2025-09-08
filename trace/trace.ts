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

// 原生表情符号常量 - 只包含Telegram确认支持的反应表情
// 经过测试验证的稳定表情列表
const NATIVE_EMOJI = [
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱",
  "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡",
  "🥱", "🥴", "😍", "🐳", "🌚", "🌭", "💯", "🤣", "⚡", "🍌",
  "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴",
  "😭", "🤓", "👻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "🤗",
  "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉",
  "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷", "😡", "😂"
];

// 安全的默认表情（这些是最常用且稳定的）
const SAFE_EMOJI = ["👍", "👎", "❤", "🔥", "😁", "😢", "🎉", "💩", "🤔", "😍"];

// 配置常量
const MAX_REACTIONS_NORMAL = 1;  // 普通用户只能显示1个反应
const MAX_REACTIONS_PREMIUM = 3; // 会员用户最多同时显示3个反应

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
  premium_mode: boolean;  // 是否启用会员模式（支持多个反应同时显示）
  max_reactions: number;   // 最大同时显示的反应数量
}

interface TracedUser {
  user_id: number;
  reactions: string[];
  custom_emojis?: string[]; // 自定义表情ID列表（会员功能）
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
    const defaultConfig = { 
      keep_log: true, 
      big: true,
      premium_mode: false,
      max_reactions: 1  // 默认非会员只能1个反应
    };
    
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
      big: this.getConfig('big') === 'true',
      premium_mode: this.getConfig('premium_mode') === 'true',
      max_reactions: parseInt(this.getConfig('max_reactions') || '1')
    };
  }

  // 用户追踪管理
  addTracedUser(userId: number, reactions: string[], customEmojis?: string[]): void {
    const data = {
      reactions,
      custom_emojis: customEmojis || []
    };
    const stmt = this.db.prepare(`
      INSERT INTO traced_users (user_id, reactions)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET 
        reactions = excluded.reactions,
        created_at = CURRENT_TIMESTAMP
    `);
    stmt.run(userId, JSON.stringify(data));
  }

  removeTracedUser(userId: number): { reactions: string[], custom_emojis?: string[] } | null {
    const stmt = this.db.prepare(`SELECT reactions FROM traced_users WHERE user_id = ?`);
    const result = stmt.get(userId) as { reactions: string } | undefined;
    
    if (result) {
      const deleteStmt = this.db.prepare(`DELETE FROM traced_users WHERE user_id = ?`);
      deleteStmt.run(userId);
      const data = JSON.parse(result.reactions);
      // 兼容旧数据格式
      if (Array.isArray(data)) {
        return { reactions: data, custom_emojis: [] };
      }
      return data;
    }
    return null;
  }

  getTracedUser(userId: number): { reactions: string[], custom_emojis?: string[] } | null {
    const stmt = this.db.prepare(`SELECT reactions FROM traced_users WHERE user_id = ?`);
    const result = stmt.get(userId) as { reactions: string } | undefined;
    if (!result) return null;
    
    const data = JSON.parse(result.reactions);
    // 兼容旧数据格式
    if (Array.isArray(data)) {
      return { reactions: data, custom_emojis: [] };
    }
    return data;
  }

  getAllTracedUsers(): TracedUser[] {
    const stmt = this.db.prepare(`SELECT user_id, reactions FROM traced_users`);
    const results = stmt.all() as { user_id: number; reactions: string }[];
    return results.map(row => {
      const data = JSON.parse(row.reactions);
      // 兼容旧数据格式
      if (Array.isArray(data)) {
        return {
          user_id: row.user_id,
          reactions: data,
          custom_emojis: []
        };
      }
      return {
        user_id: row.user_id,
        reactions: data.reactions || [],
        custom_emojis: data.custom_emojis || []
      };
    });
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
  
  if (!text || !text.trim()) {
    return [];
  }
  
  console.log(`[Trace] 解析表情文本: "${text}"`);
  
  // 创建所有支持表情的合并列表，按长度排序（避免短表情匹配长表情的一部分）
  const allEmojis = [...NATIVE_EMOJI].sort((a, b) => b.length - a.length);
  
  // 逐字符扫描文本，按出现顺序提取表情
  let remainingText = text;
  let position = 0;
  
  while (position < remainingText.length && emojis.length < 3) {
    let foundEmoji = false;
    
    // 在当前位置尝试匹配表情
    for (const emoji of allEmojis) {
      if (remainingText.substring(position).startsWith(emoji)) {
        if (!emojis.includes(emoji)) {
          emojis.push(emoji);
          console.log(`[Trace] 找到表情: ${emoji} (位置: ${position})`);
        }
        position += emoji.length;
        foundEmoji = true;
        break;
      }
    }
    
    // 如果当前位置没有找到表情，移动到下一个字符
    if (!foundEmoji) {
      position++;
    }
  }
  
  // 如果没找到任何表情，使用默认的👍
  if (emojis.length === 0 && text.trim()) {
    console.log("[Trace] 未找到有效表情，使用默认👍");
    return ["👍"];
  }
  
  console.log(`[Trace] 解析结果: [${emojis.join(", ")}]`);
  return emojis;
}

// 工具函数：生成反应列表
async function generateReactionList(
  emojis: string[], 
  customEmojiIds?: string[],
  maxReactions: number = 1
): Promise<Api.TypeReaction[]> {
  const reactions: Api.TypeReaction[] = [];
  
  // 合并所有表情（普通和自定义）
  const allReactions: Api.TypeReaction[] = [];
  
  // 处理普通表情
  for (const emoji of emojis) {
    if (emoji && NATIVE_EMOJI.includes(emoji)) {
      console.log(`[Trace] 添加反应: ${emoji}`);
      try {
        const reaction = new Api.ReactionEmoji({ 
          emoticon: emoji
        });
        allReactions.push(reaction);
        console.log(`[Trace] 成功创建反应: ${emoji}`);
      } catch (error: any) {
        console.error(`[Trace] 创建反应失败 ${emoji}:`, error.message);
      }
    } else {
      console.log(`[Trace] 跳过不支持的emoji: ${emoji}`);
    }
  }
  
  // 处理自定义表情
  if (customEmojiIds && customEmojiIds.length > 0) {
    for (const customId of customEmojiIds) {
      try {
        console.log(`[Trace] 添加自定义表情: ${customId}`);
        const reaction = new Api.ReactionCustomEmoji({
          documentId: BigInt(customId) as any
        });
        allReactions.push(reaction);
        console.log(`[Trace] 成功创建自定义表情反应`);
      } catch (error: any) {
        console.error(`[Trace] 创建自定义表情失败 ${customId}:`, error.message);
      }
    }
  }
  
  // 根据maxReactions限制返回的反应数量
  // 会员模式可以同时显示多个反应，非会员只能显示1个
  const limitedReactions = allReactions.slice(0, maxReactions);
  
  console.log(`[Trace] 生成了 ${limitedReactions.length} 个反应（最多同时显示 ${maxReactions} 个）`);
  return limitedReactions;
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

    // 先尝试不带big参数发送（更稳定）
    try {
      await client.invoke(new Api.messages.SendReaction({
        peer: peer,
        msgId: messageId,
        reaction: reactions,
        big: false,
        addToRecent: true
      }));
      console.log(`[Trace] 成功发送 ${reactions.length} 个反应到消息 ${messageId}`);
    } catch (firstError: any) {
      // 如果失败且设置了big，尝试带big参数
      if (big && !firstError.errorMessage?.includes('REACTION_INVALID')) {
        console.log("[Trace] 尝试使用big参数发送反应");
        await client.invoke(new Api.messages.SendReaction({
          peer: peer,
          msgId: messageId,
          reaction: reactions,
          big: true,
          addToRecent: true
        }));
        console.log(`[Trace] 成功发送 ${reactions.length} 个大反应到消息 ${messageId}`);
      } else {
        throw firstError;
      }
    }
  } catch (error: any) {
    console.error("[Trace] 发送反应失败:", error.message || error);
    
    // 如果是REACTION_INVALID，可能是表情不支持
    if (error.errorMessage?.includes('REACTION_INVALID')) {
      console.error("[Trace] 表情可能不被支持，请检查表情列表");
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

// 工具函数：检测用户是否为Telegram Premium会员
async function checkUserPremium(client: TelegramClient, userId: number): Promise<boolean> {
  try {
    console.log(`[Trace] 检测用户 ${userId} 的会员状态...`);
    
    // 获取用户完整信息
    const userEntity = await client.getEntity(userId);
    
    // 检查用户是否有Premium标识
    if ('premium' in userEntity && userEntity.premium) {
      console.log(`[Trace] 用户 ${userId} 是Telegram Premium会员`);
      return true;
    }
    
    console.log(`[Trace] 用户 ${userId} 不是Telegram Premium会员`);
    return false;
  } catch (error: any) {
    console.error(`[Trace] 检测用户 ${userId} 会员状态失败:`, error.message);
    // 检测失败时默认为非会员
    return false;
  }
}

// 工具函数：自动启用会员模式（如果用户是Premium会员且设置了多个表情）
async function autoEnablePremiumMode(
  client: TelegramClient, 
  userId: number, 
  emojis: string[], 
  customEmojiIds: string[] = []
): Promise<{ enabled: boolean; reason: string }> {
  const totalReactions = emojis.length + customEmojiIds.length;
  
  // 如果只有1个或没有反应，不需要会员模式
  if (totalReactions <= 1) {
    return { enabled: false, reason: "单个反应无需会员模式" };
  }
  
  // 检测用户是否为Premium会员
  const isPremium = await checkUserPremium(client, userId);
  
  if (isPremium) {
    // 自动启用会员模式
    traceDB.setConfig("premium_mode", "true");
    traceDB.setConfig("max_reactions", "3");
    console.log(`[Trace] 检测到Premium会员，自动启用会员模式`);
    return { enabled: true, reason: "检测到Premium会员，自动启用" };
  } else {
    // 非会员用户尝试设置多个反应
    console.log(`[Trace] 非Premium用户尝试设置${totalReactions}个反应，限制为1个`);
    return { enabled: false, reason: `非Premium用户，限制为1个反应` };
  }
}

// 工具函数：格式化反应列表
function formatReactions(reactions: string[] | { reactions: string[], custom_emojis?: string[] }): string {
  // 兼容两种格式
  if (Array.isArray(reactions)) {
    return reactions.length > 0 ? `[${reactions.join(", ")}]` : "[无反应]";
  }
  
  const normalEmojis = reactions.reactions || [];
  const customEmojis = reactions.custom_emojis || [];
  const allEmojis = [...normalEmojis, ...customEmojis.map(id => `📦${id.slice(-4)}`)]; // 显示自定义表情ID的后4位
  return allEmojis.length > 0 ? `[${allEmojis.join(", ")}]` : "[无反应]";
}

// 帮助文档（等宽处理）
const help_text = `🎭 <b>全局表情追踪插件</b> - 自动为特定用户的消息添加表情反应

<b>📝 功能特性:</b>
• 👥 <b>用户追踪</b> - 对特定用户的消息自动添加表情反应
• 🤖 <b>智能会员检测</b> - 自动检测Telegram Premium会员并启用多反应模式
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

<b>🎨 可用表情:</b> ${SAFE_EMOJI.join(" ")}\n<b>📝 更多表情:</b> ${NATIVE_EMOJI.slice(10, 30).join(" ")}

<b>🎯 智能会员模式:</b>
• 🔍 <b>自动检测</b> - 设置多个表情时自动检测Premium会员状态
• 👑 <b>Premium用户</b> - 自动启用会员模式，可同时显示最多3个反应
• 👤 <b>普通用户</b> - 自动限制为1个反应，确保兼容性
• 🎨 <b>自定义表情</b> - Premium用户支持自定义表情，格式: custom:ID

<b>⚠️ 注意:</b> 
• 插件会自动检测用户Premium状态，无需手动设置
• 非Premium用户设置多个表情时会自动限制为1个
• 支持原生Telegram表情和自定义表情
• Premium检测失败时默认为普通用户模式`;

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
            
            const prevData = traceDB.removeTracedUser(userId);
            if (!prevData) {
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
              `✅ <b>成功取消追踪:</b>\n👤 ${htmlEscape(formattedUser)}\n🎭 ${formatReactions(prevData)}`,
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
        
        // 测试表情功能（隐藏命令）
        if (sub === "test" && args.length >= 2) {
          const testEmoji = args[1];
          await msg.edit({ text: `🧪 测试表情: ${testEmoji}`, parseMode: "html" });
          
          try {
            const reaction = new Api.ReactionEmoji({ emoticon: testEmoji });
            const replyMsg = await msg.getReplyMessage();
            
            if (replyMsg) {
              await sendReaction(client, msg.chatId!.toString(), replyMsg.id, [reaction], false);
              await editAndDelete(
                msg,
                `✅ 表情 ${testEmoji} 测试成功`,
                5,
                config.keep_log
              );
            } else {
              await editAndDelete(
                msg,
                `❌ 请回复一条消息来测试表情`,
                5,
                config.keep_log
              );
            }
          } catch (error: any) {
            await editAndDelete(
              msg,
              `❌ 表情 ${testEmoji} 不被支持: ${error.message}`,
              5,
              config.keep_log
            );
          }
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
                statusText += `• ${htmlEscape(userInfo)} ${formatReactions(tracedUser)}\n`;
              } catch (error: any) {
                console.error(`[Trace] 获取用户 ${tracedUser.user_id} 信息失败:`, error.message);
                statusText += `• 用户ID: ${tracedUser.user_id} ${formatReactions(tracedUser)}\n`;
              }
            }
          }
          
          // 配置信息
          statusText += `\n<b>⚙️ 当前配置:</b>\n`;
          statusText += `• 保留日志: ${config.keep_log ? '✅ 启用' : '❌ 禁用'}\n`;
          statusText += `• 大表情模式: ${config.big ? '✅ 启用' : '❌ 禁用'}\n`;
          statusText += `• 会员模式: ${config.premium_mode ? '✅ 启用' : '❌ 禁用'}\n`;
          statusText += `• 同时显示反应数: ${config.max_reactions}\n`;
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
          // 解析表情
          let emojis: string[] = [];
          
          // 如果有参数，尝试解析表情
          if (sub || args.length > 0) {
            const allText = args.join(" ") || sub;
            emojis = parseEmojis(allText);
          }
          
          // 如果没有找到表情，使用默认的👍
          if (emojis.length === 0 && !config.premium_mode) {
            console.log("[Trace] 没有指定表情，使用默认👍");
            emojis = ["👍"];
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
          
          // 解析自定义表情ID（如果有）
          let customEmojiIds: string[] = [];
          const customMatches = (args.join(" ") || sub).match(/custom:(\d+)/g);
          if (customMatches) {
            customEmojiIds = customMatches.map(m => m.replace('custom:', ''));
            console.log(`[Trace] 找到自定义表情ID: ${customEmojiIds.join(', ')}`);
          }
          
          // 自动检测会员状态并启用会员模式（如果需要）
          const premiumResult = await autoEnablePremiumMode(client, userId, emojis, customEmojiIds);
          const updatedConfig = traceDB.getTraceConfig(); // 重新获取可能更新的配置
          
          // 如果是非会员用户尝试设置多个反应，限制为1个
          if (!premiumResult.enabled && (emojis.length + customEmojiIds.length) > 1) {
            emojis = emojis.slice(0, 1); // 只保留第一个表情
            customEmojiIds = []; // 清空自定义表情（非会员不支持）
            console.log(`[Trace] 非Premium用户，限制为1个反应: ${emojis[0] || '👍'}`);
          }
          
          // 检查是否已经追踪该用户
          const existingData = traceDB.getTracedUser(userId);
          if (existingData) {
            // 更新追踪
            traceDB.addTracedUser(userId, emojis, customEmojiIds);
            const userInfo = await client.getEntity(replyMsg.fromId);
            const formattedUser = formatUserInfo(userInfo);
            
            const newData = { reactions: emojis, custom_emojis: customEmojiIds };
            let statusMessage = `🔄 <b>更新追踪用户:</b>\n👤 ${htmlEscape(formattedUser)}\n🎭 旧: ${formatReactions(existingData)}\n🎭 新: ${formatReactions(newData)}`;
            
            // 添加会员检测结果信息
            if (premiumResult.enabled) {
              statusMessage += `\n🎯 <b>会员模式:</b> ${premiumResult.reason}`;
            } else if ((emojis.length + customEmojiIds.length) > 1) {
              statusMessage += `\n⚠️ <b>提示:</b> ${premiumResult.reason}`;
            }
            
            await editAndDelete(
              msg,
              statusMessage,
              5,
              config.keep_log
            );
          } else {
            // 新增追踪
            traceDB.addTracedUser(userId, emojis, customEmojiIds);
            const userInfo = await client.getEntity(replyMsg.fromId);
            const formattedUser = formatUserInfo(userInfo);
            
            const newData = { reactions: emojis, custom_emojis: customEmojiIds };
            let statusMessage = `✅ <b>成功追踪用户:</b>\n👤 ${htmlEscape(formattedUser)}\n🎭 ${formatReactions(newData)}`;
            
            // 添加会员检测结果信息
            if (premiumResult.enabled) {
              statusMessage += `\n🎯 <b>会员模式:</b> ${premiumResult.reason}`;
            } else if ((emojis.length + customEmojiIds.length) > 1) {
              statusMessage += `\n⚠️ <b>提示:</b> ${premiumResult.reason}`;
            }
            
            await editAndDelete(
              msg,
              statusMessage,
              5,
              config.keep_log
            );
          }

          // 立即发送反应作为演示
          const reactions = await generateReactionList(emojis, customEmojiIds, updatedConfig.max_reactions);
          await sendReaction(client, msg.chatId!.toString(), replyMsg.id, reactions, updatedConfig.big);
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
      const userData = traceDB.getTracedUser(userId);
      
      if (userData && userData.reactions.length > 0) {
        const reactions = await generateReactionList(
          userData.reactions, 
          userData.custom_emojis,
          config.max_reactions
        );
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

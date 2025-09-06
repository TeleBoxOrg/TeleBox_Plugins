import { Plugin } from "@utils/pluginBase";
import path from "path";
import Database from "better-sqlite3";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getGlobalClient } from "@utils/globalClient";
import { TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api } from "telegram/tl";
import {
  safeForwardMessage,
  parseEntityId,
  withEntityAccess,
} from "@utils/entityHelpers";

// Available message types
const AVAILABLE_OPTIONS = new Set([
  "silent",
  "text",
  "all",
  "photo",
  "document",
  "video",
  "sticker",
  "animation",
  "voice",
  "audio",
]);

// Initialize database
let db = new Database(path.join(createDirectoryInAssets("shift"), "shift.db"));

// Initialize database tables
if (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shift_rules (
      source_id INTEGER PRIMARY KEY,
      target_id INTEGER NOT NULL,
      options TEXT NOT NULL,
      target_type TEXT NOT NULL,
      paused INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      filters TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS shift_stats (
      stats_key TEXT PRIMARY KEY,
      stats_data TEXT NOT NULL
    )
  `);
}

// Rule interface
interface ShiftRule {
  target_id: number;
  options: string[];
  target_type: string;
  paused: boolean;
  created_at: string;
  filters: string[];
}

// Cache for rules
const ruleCache = new Map<
  number,
  { rule: ShiftRule | null; timestamp: number }
>();
const RULE_CACHE_TTL = 5 * 60 * 1000;

// Get shift rule from database
async function getShiftRule(sourceId: number): Promise<ShiftRule | null> {
  const now = Date.now();
  const cached = ruleCache.get(sourceId);

  if (cached && now - cached.timestamp < RULE_CACHE_TTL) {
    return cached.rule;
  }

  if (!db) return null;

  try {
    const stmt = db.prepare("SELECT * FROM shift_rules WHERE source_id = ?");
    const row = stmt.get(sourceId) as any;

    if (!row) {
      ruleCache.set(sourceId, { rule: null, timestamp: now });
      return null;
    }

    const rule: ShiftRule = {
      target_id: row.target_id,
      options: JSON.parse(row.options || "[]"),
      target_type: row.target_type,
      paused: row.paused === 1,
      created_at: row.created_at,
      filters: JSON.parse(row.filters || "[]"),
    };

    ruleCache.set(sourceId, { rule, timestamp: now });
    return rule;
  } catch (error) {
    console.error(`[SHIFT] Error getting rule for ${sourceId}:`, error);
    return null;
  }
}

// Save shift rule
function saveShiftRule(sourceId: number, rule: ShiftRule): boolean {
  if (!db) return false;

  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO shift_rules 
      (source_id, target_id, options, target_type, paused, created_at, filters)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      sourceId,
      rule.target_id,
      JSON.stringify(rule.options),
      rule.target_type,
      rule.paused ? 1 : 0,
      rule.created_at,
      JSON.stringify(rule.filters)
    );

    ruleCache.set(sourceId, { rule, timestamp: Date.now() });
    return true;
  } catch (error) {
    console.error(`[SHIFT] Error saving rule:`, error);
    return false;
  }
}

// Delete shift rule
function deleteShiftRule(sourceId: number): boolean {
  if (!db) return false;

  try {
    const stmt = db.prepare("DELETE FROM shift_rules WHERE source_id = ?");
    stmt.run(sourceId);
    ruleCache.delete(sourceId);
    return true;
  } catch (error) {
    console.error(`[SHIFT] Error deleting rule:`, error);
    return false;
  }
}

// Get all rules
function getAllShiftRules(): Array<{ sourceId: number; rule: ShiftRule }> {
  if (!db) return [];

  try {
    const stmt = db.prepare("SELECT * FROM shift_rules");
    const rows = stmt.all() as any[];

    return rows.map((row) => ({
      sourceId: row.source_id,
      rule: {
        target_id: row.target_id,
        options: JSON.parse(row.options || "[]"),
        target_type: row.target_type,
        paused: row.paused === 1,
        created_at: row.created_at,
        filters: JSON.parse(row.filters || "[]"),
      },
    }));
  } catch (error) {
    console.error("[SHIFT] Error getting all rules:", error);
    return [];
  }
}

// Utility functions
function getDisplayName(entity: any): string {
  if (!entity) return "未知实体";
  if (entity.username) return `@${entity.username}`;
  if (entity.firstName) return entity.firstName;
  if (entity.title) return entity.title;
  return `ID: ${entity.id}`;
}

function normalizeChatId(entityOrId: any): number {
  if (typeof entityOrId === "object" && entityOrId.id) {
    const chatId = Number(entityOrId.id);
    if (entityOrId.className === "Channel") {
      return chatId > 0 ? -1000000000000 - chatId : chatId;
    } else if (entityOrId.className === "Chat" && chatId > 0) {
      return -chatId;
    }
    return chatId;
  } else {
    const chatId = Number(entityOrId);
    if (chatId > 1000000000) {
      return -1000000000000 - chatId;
    }
    return chatId;
  }
}

function getTargetTypeEmoji(entity: any): string {
  if (!entity) return "❓";
  if (entity.className === "User") return entity.bot ? "🤖" : "👤";
  if (entity.className === "Channel") return entity.broadcast ? "📢" : "👥";
  if (entity.className === "Chat") return "👥";
  return "❓";
}

function parseIndices(
  indicesStr: string,
  total: number
): { indices: number[]; invalid: string[] } {
  const indices: number[] = [];
  const invalid: string[] = [];

  for (const i of indicesStr.split(",")) {
    try {
      const idx = parseInt(i.trim()) - 1;
      if (idx >= 0 && idx < total) {
        indices.push(idx);
      } else {
        invalid.push(i.trim());
      }
    } catch (error) {
      invalid.push(i.trim());
    }
  }

  return { indices, invalid };
}

function getMediaType(message: any): string {
  if (message.photo) return "photo";
  if (message.document) return "document";
  if (message.video) return "video";
  if (message.sticker) return "sticker";
  if (message.animation) return "animation";
  if (message.voice) return "voice";
  if (message.audio) return "audio";
  return "text";
}

async function resolveTarget(
  client: TelegramClient,
  targetInput: string,
  currentChatId: number
): Promise<any> {
  if (
    targetInput.toLowerCase() === "me" ||
    targetInput.toLowerCase() === "here"
  ) {
    return await client.getEntity(currentChatId);
  }

  try {
    const numericId = parseInt(targetInput);
    if (!isNaN(numericId)) {
      return await client.getEntity(numericId);
    }
  } catch (error) {
    // Fall through to username
  }

  return await client.getEntity(targetInput);
}

async function isCircularForward(
  sourceId: number,
  targetId: number
): Promise<{ isCircular: boolean; message: string }> {
  if (sourceId === targetId) {
    return { isCircular: true, message: "不能设置自己到自己的转发规则" };
  }

  const visited = new Set([sourceId]);
  let currentId = targetId;

  for (let i = 0; i < 20; i++) {
    if (visited.has(currentId)) {
      return { isCircular: true, message: `检测到间接循环：${currentId}` };
    }

    const rule = await getShiftRule(currentId);
    if (!rule) break;

    const nextId = rule.target_id;
    if (nextId === -1) break;

    visited.add(currentId);
    currentId = nextId;
  }

  return { isCircular: false, message: "" };
}

// Help text
const HELP_TEXT = `📢 <b>智能转发助手使用说明</b>

🔧 <b>基础命令：</b>
• <code>shift set [源] [目标] [选项...]</code> - 设置自动转发
• <code>shift set [源] [目标]|[话题 ID] [选项...]</code> - 设置自动转发(指定目标话题 ID)
• <code>shift del [序号]</code> - 删除转发规则
• <code>shift list/ls</code> - 显示当前转发规则
• <code>shift stats</code> - 查看转发统计
• <code>shift pause [序号]</code> - 暂停转发
• <code>shift resume [序号]</code> - 恢复转发

🔍 <b>过滤命令：</b>
• <code>shift filter [序号] add [关键词]</code> - 添加过滤关键词
• <code>shift filter [序号] del [关键词]</code> - 删除过滤关键词
• <code>shift filter [序号] list</code> - 查看过滤列表

🎯 <b>支持的目标类型：</b>
• 频道/群组 - <code>@username</code> 或 <code>-100...ID</code>
• 个人用户 - <code>@username</code> 或 <code>user_id</code>
• 当前对话 - 使用 <code>"me"</code> 或 <code>"here"</code>

📝 <b>消息类型选项：</b>
<code>text</code>, <code>photo</code>, <code>document</code>, <code>video</code>, <code>sticker</code>, <code>animation</code>, <code>voice</code>, <code>audio</code>, <code>all</code>

⚙️ <b>静音选项：</b>
<code>silent</code>

💡 <b>示例：</b>
• <code>shift set @channel1 @channel2 silent photo</code>
• <code>shift set @channel1 @channel2|TopicID</code>
• <code>shift del 1</code>
• <code>shift filter 1 add 广告</code>`;
// Message listener handler for the plugin system
async function shiftMessageListener(message: any): Promise<void> {
  await handleIncomingMessage(message);
}
class ShiftPlugin extends Plugin {
  description: string = `智能转发助手 - 自动转发消息到指定目标\n\n${HELP_TEXT}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    shift: async (msg) => {
      const args = msg.message.slice(1).split(" ").slice(1);

      if (args.length === 0) {
        await msg.edit({
          text: HELP_TEXT,
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      const cmd = args[0];

      // Set command - create forwarding rule
      if (cmd === "set") {
        const params = args.slice(1);
        if (params.length < 1) {
          await msg.edit({
            text: "参数不足\n\n用法: shift set <目标> [选项...]\n或: shift set <源> <目标> [选项...]",
          });
          return;
        }

        let sourceInput: string;
        let targetInput: string;
        let options: Set<string>;

        if (params.length === 1) {
          sourceInput = "here";
          targetInput = params[0];
          options = new Set();
        } else {
          sourceInput = params[0];
          targetInput = params[1];
          options = new Set(
            params.slice(2).filter((opt) => AVAILABLE_OPTIONS.has(opt))
          );
        }
        const [realTargetInput, ...rest] =
          targetInput
            ?.split(/\s*[|｜]\s*/g)
            .map((i) => i.trim())
            .filter((i) => i.length > 0) || [];
        targetInput = realTargetInput;
        const replyTo = rest?.[0];
        if (replyTo) {
          options.add(`replyTo:${replyTo}`);
        }

        // Resolve source
        let source: any;
        try {
          if (!msg.client) {
            await msg.edit({ text: "客户端未初始化" });
            return;
          }

          if (
            sourceInput.toLowerCase() === "here" ||
            sourceInput.toLowerCase() === "me"
          ) {
            const chatId = msg.chatId ? Number(msg.chatId.toString()) : 0;
            source = await msg.client.getEntity(chatId);
          } else {
            const chatId = msg.chatId ? Number(msg.chatId.toString()) : 0;
            source = await resolveTarget(msg.client, sourceInput, chatId);
          }
        } catch (error) {
          await msg.edit({ text: `源对话无效: ${error}` });
          return;
        }

        // Resolve target
        let target: any;
        try {
          if (!msg.client) {
            await msg.edit({ text: "客户端未初始化" });
            return;
          }
          const chatId = msg.chatId ? Number(msg.chatId.toString()) : 0;
          target = await resolveTarget(msg.client, targetInput, chatId);
        } catch (error) {
          await msg.edit({ text: `目标对话无效: ${error}` });
          return;
        }

        const sourceId = normalizeChatId(source);
        const targetId = normalizeChatId(target);

        // Check for circular forwarding
        const { isCircular, message: circularMsg } = await isCircularForward(
          sourceId,
          targetId
        );
        if (isCircular) {
          await msg.edit({ text: `循环转发: ${circularMsg}` });
          return;
        }

        const rule: ShiftRule = {
          target_id: targetId,
          options: Array.from(options),
          target_type: source.className === "User" ? "user" : "chat",
          paused: false,
          created_at: new Date().toISOString(),
          filters: [],
        };

        if (saveShiftRule(sourceId, rule)) {
          await msg.edit({
            text: `成功设置转发: ${getDisplayName(source)} -> ${getDisplayName(
              target
            )}`,
          });
        } else {
          await msg.edit({ text: "保存转发规则失败" });
        }
        return;
      }

      // List command
      if (cmd === "list" || cmd === "ls") {
        const allRules = getAllShiftRules();
        if (allRules.length === 0) {
          await msg.edit({
            text: "🚫 暂无转发规则\n\n💡 使用 `shift set` 命令创建新的转发规则",
          });
          return;
        }

        let output = `✨ 智能转发规则管理\n━━━━━━━━━━━━━━━━━━━━━━\n`;

        for (let i = 0; i < allRules.length; i++) {
          const { sourceId, rule } = allRules[i];
          const status = rule.paused ? "⏸️ 已暂停" : "▶️ 运行中";

          try {
            if (!msg.client) continue;
            const sourceEntity = await msg.client.getEntity(Number(sourceId));
            const targetEntity = await msg.client.getEntity(
              Number(rule.target_id)
            );
            let replyTo = undefined;
            const options = [];
            if (rule.options && rule.options.length > 0) {
              for (const option of rule.options) {
                if (option.startsWith("replyTo:")) {
                  const replyToStr = option.replace("replyTo:", "").trim();
                  const replyToNum = parseInt(replyToStr);
                  if (!isNaN(replyToNum)) {
                    replyTo = replyToNum;
                  }
                } else {
                  options.push(option);
                }
              }
            }

            output += `${i + 1}. ${status}\n`;
            output += `   📤 源: ${getDisplayName(sourceEntity)}\n`;
            output += `   📥 目标: ${getDisplayName(targetEntity)}\n`;
            if (replyTo) {
              output += `   📬 回复: ${replyTo}\n`;
            }
            output += `   🎯 类型: ${options.join(", ") || "all"}\n`;
            output += `   🛡️ 过滤: ${rule.filters.length} 个关键词\n\n`;
          } catch (error) {
            output += `${i + 1}. ⚠️ 规则损坏 (${sourceId})\n\n`;
          }
        }

        await msg.edit({ text: output });
        return;
      }

      // Delete command
      if (cmd === "del") {
        if (args.length < 2) {
          await msg.edit({ text: "请提供序号" });
          return;
        }

        const allRules = getAllShiftRules();
        const { indices } = parseIndices(args[1], allRules.length);

        let deletedCount = 0;
        for (const index of indices.sort((a, b) => b - a)) {
          const { sourceId } = allRules[index];
          if (deleteShiftRule(sourceId)) {
            deletedCount++;
          }
        }

        await msg.edit({ text: `成功删除 ${deletedCount} 条规则。` });
        return;
      }

      // Pause/Resume commands
      if (cmd === "pause" || cmd === "resume") {
        if (args.length < 2) {
          await msg.edit({ text: "请提供序号" });
          return;
        }

        const allRules = getAllShiftRules();
        const { indices } = parseIndices(args[1], allRules.length);
        const pause = cmd === "pause";

        let count = 0;
        for (const index of indices) {
          const { sourceId, rule } = allRules[index];
          rule.paused = pause;
          if (saveShiftRule(sourceId, rule)) {
            count++;
          }
        }

        const action = pause ? "暂停" : "恢复";
        await msg.edit({ text: `成功${action} ${count} 条规则。` });
        return;
      }

      // Stats command
      if (cmd === "stats") {
        if (!db) {
          await msg.edit({ text: "数据库未初始化" });
          return;
        }

        try {
          const stmt = db.prepare("SELECT * FROM shift_stats");
          const rows = stmt.all() as any[];

          if (rows.length === 0) {
            await msg.edit({ text: "📊 暂无转发统计数据" });
            return;
          }

          const channelStats: {
            [key: number]: { total: number; dates: { [key: string]: number } };
          } = {};

          for (const row of rows) {
            try {
              const parts = row.stats_key.split(".");
              const sourceId = parseInt(parts[2]);
              const date = parts[3];

              if (!channelStats[sourceId]) {
                channelStats[sourceId] = { total: 0, dates: {} };
              }

              const dailyStats = JSON.parse(row.stats_data);
              const dailyTotal = dailyStats.total || 0;
              channelStats[sourceId].total += dailyTotal;
              channelStats[sourceId].dates[date] = dailyTotal;
            } catch (error) {
              continue;
            }
          }

          let output = "📊 转发统计报告\n\n";
          for (const [sourceId, stats] of Object.entries(channelStats)) {
            try {
              if (!msg.client) continue;
              const sourceEntity = await msg.client.getEntity(
                parseInt(sourceId)
              );
              output += `📤 源: ${getDisplayName(sourceEntity)}\n`;
              output += `📈 总转发: ${stats.total} 条\n`;

              const recentDates = Object.keys(stats.dates)
                .sort()
                .reverse()
                .slice(0, 7);
              if (recentDates.length > 0) {
                output += "📅 最近7天:\n";
                for (const date of recentDates) {
                  output += `  - ${date}: ${stats.dates[date]} 条\n`;
                }
              }
              output += "\n";
            } catch (error) {
              output += `📤 源: ID ${sourceId}\n📈 总转发: ${stats.total} 条\n\n`;
            }
          }

          await msg.edit({ text: output });
        } catch (error) {
          await msg.edit({ text: `获取统计数据失败: ${error}` });
        }
        return;
      }

      // Filter command
      if (cmd === "filter") {
        if (args.length < 3) {
          await msg.edit({ text: "参数不足" });
          return;
        }

        const indicesStr = args[1];
        const action = args[2];
        const keywords = args.slice(3);

        const allRules = getAllShiftRules();
        const { indices } = parseIndices(indicesStr, allRules.length);

        if (indices.length === 0) {
          await msg.edit({ text: `无效的序号: ${indicesStr}` });
          return;
        }

        let updatedCount = 0;
        for (const index of indices) {
          const { sourceId, rule } = allRules[index];
          const filters = new Set(rule.filters);

          if (action === "add") {
            keywords.forEach((keyword) => filters.add(keyword));
            rule.filters = Array.from(filters);
            if (saveShiftRule(sourceId, rule)) {
              updatedCount++;
            }
          } else if (action === "del") {
            keywords.forEach((keyword) => filters.delete(keyword));
            rule.filters = Array.from(filters);
            if (saveShiftRule(sourceId, rule)) {
              updatedCount++;
            }
          } else if (action === "list") {
            const filterList =
              rule.filters.length > 0 ? rule.filters : ["无过滤词"];
            await msg.edit({
              text: `规则 ${index + 1} 的过滤词：\n${filterList
                .map((f) => `• ${f}`)
                .join("\n")}`,
            });
            return;
          } else {
            await msg.edit({
              text: `无效的操作: ${action}，支持: add, del, list`,
            });
            return;
          }
        }

        if (action === "add" || action === "del") {
          await msg.edit({ text: `已为 ${updatedCount} 条规则更新过滤词。` });
        }
        return;
      }

      // Backup command
      if (cmd === "backup") {
        if (args.length < 3) {
          await msg.edit({ text: "❌ 参数不足，请提供源和目标。" });
          return;
        }

        const sourceInput = args[1];
        const targetInput = args[2];

        let source: any;
        let target: any;

        try {
          if (!msg.client) {
            await msg.edit({ text: "客户端未初始化" });
            return;
          }
          const chatId = msg.chatId ? Number(msg.chatId.toString()) : 0;
          source = await resolveTarget(msg.client, sourceInput, chatId);
          target = await resolveTarget(msg.client, targetInput, chatId);
        } catch (error) {
          await msg.edit({ text: `❌ 解析对话失败: ${error}` });
          return;
        }

        await msg.edit({
          text: `🔄 开始备份从 ${getDisplayName(source)} 到 ${getDisplayName(
            target
          )} 的历史消息...`,
        });

        let count = 0;
        let errorCount = 0;

        try {
          if (!msg.client) {
            await msg.edit({ text: "客户端未初始化" });
            return;
          }
          const messages = await msg.client.getMessages(Number(source.id), {
            limit: 1000,
          });

          for (const message of messages) {
            try {
              await new Promise((resolve) =>
                setTimeout(resolve, Math.random() * 500 + 500)
              );
              if (msg.client) {
                await msg.client.forwardMessages(Number(target.id), {
                  messages: [Number(message.id)],
                  fromPeer: Number(source.id),
                });
              }
              count++;

              if (count % 50 === 0) {
                await msg.edit({
                  text: `🔄 备份进行中... 已处理 ${count} 条消息。`,
                });
              }
            } catch (error) {
              errorCount++;
              console.error("备份消息失败:", error);
            }
          }
        } catch (error) {
          await msg.edit({ text: `❌ 备份失败: ${error}` });
          return;
        }

        await msg.edit({
          text: `✅ 备份完成！共处理 ${count} 条消息，失败 ${errorCount} 条。`,
        });
        return;
      }

      await msg.edit({ text: `未知命令: ${cmd}` });
    },
  };
  listenMessageHandler?: ((msg: Api.Message) => Promise<void>) | undefined =
    shiftMessageListener;
}

// Update stats function
function updateStats(
  sourceId: number,
  targetId: number,
  messageType: string
): void {
  if (!db) return;

  try {
    const today = new Date().toISOString().split("T")[0];
    const statsKey = `shift.stats.${sourceId}.${today}`;

    const stmt = db.prepare(
      "SELECT stats_data FROM shift_stats WHERE stats_key = ?"
    );
    const row = stmt.get(statsKey) as any;

    let stats: any = { total: 0 };
    if (row) {
      stats = JSON.parse(row.stats_data);
    }

    stats.total = (stats.total || 0) + 1;
    stats[messageType] = (stats[messageType] || 0) + 1;

    const saveStmt = db.prepare(`
      INSERT OR REPLACE INTO shift_stats (stats_key, stats_data)
      VALUES (?, ?)
    `);

    saveStmt.run(statsKey, JSON.stringify(stats));
  } catch (error) {
    console.error(`[SHIFT] Error updating stats:`, error);
  }
}

// Check if message is filtered
async function isMessageFiltered(
  message: any,
  sourceId: number
): Promise<boolean> {
  const rule = await getShiftRule(sourceId);
  if (!rule) return false;

  const keywords = rule.filters;
  if (!keywords || keywords.length === 0 || !message.text) return false;

  const text = message.text.toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

// Get chat ID from message
function getChatIdFromMessage(message: any): number | null {
  if (message.chatId) {
    return Number(message.chatId);
  }

  if (message.peerId) {
    if (message.peerId.channelId) {
      return -1000000000000 - Number(message.peerId.channelId);
    } else if (message.peerId.chatId) {
      return -Number(message.peerId.chatId);
    } else if (message.peerId.userId) {
      return Number(message.peerId.userId);
    }
  }

  return null;
}

// Forward message using universal access hash handler
async function shiftForwardMessage(
  client: TelegramClient,
  fromChatId: number,
  toChatId: number,
  messageId: number,
  depth: number = 0,
  options?: any
): Promise<void> {
  if (depth > 5) {
    console.log(`[SHIFT] 转发深度超限: ${depth}`);
    return;
  }

  try {
    // 使用通用的安全转发函数
    await safeForwardMessage(client, fromChatId, toChatId, messageId, {
      maxRetries: 3,
      silent: options?.silent,
      replyTo: options?.replyTo,
    });

    console.log(
      `[SHIFT] 转发成功: ${fromChatId} -> ${toChatId}, msg=${messageId}, depth=${depth}`
    );

    // Check for chained forwarding
    const nextRule = await getShiftRule(toChatId);
    if (nextRule && !nextRule.paused && nextRule.target_id) {
      // Wait for message to arrive
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Recursive forwarding with depth tracking
      await shiftForwardMessage(
        client,
        toChatId,
        nextRule.target_id,
        messageId,
        depth + 1,
        options
      );
    }
  } catch (error) {
    console.error(
      `[SHIFT] 转发失败: ${fromChatId} -> ${toChatId}, msg=${messageId}`,
      error
    );
    throw error;
  }
}

// Message handler for automatic forwarding
async function handleIncomingMessage(message: any): Promise<void> {
  try {
    if (!message || !message.chat) {
      return;
    }

    const sourceId = getChatIdFromMessage(message);
    if (!sourceId) {
      return;
    }

    const rule = await getShiftRule(sourceId);
    if (!rule || rule.paused) {
      return;
    }

    const targetId = rule.target_id;
    if (!targetId) {
      return;
    }

    // Check content protection
    if (message.chat.noforwards) {
      console.log(`[SHIFT] 源聊天 ${sourceId} 开启了内容保护，删除转发规则`);
      deleteShiftRule(sourceId);
      return;
    }

    // Check message filtering
    if (await isMessageFiltered(message, sourceId)) {
      console.log(`[SHIFT] 消息被过滤: ${sourceId}`);
      return;
    }

    // Check message type
    const options = rule.options;
    const messageTypes = [];
    if (Array.isArray(options) && options.length > 0) {
      for (const option of options) {
        if (
          !option.startsWith("replyTo:") &&
          !["all", "silent"].includes(option)
        ) {
          messageTypes.push(option);
        }
      }
    }
    const messageType = getMediaType(message);
    if (messageTypes.length > 0 && !messageTypes.includes(messageType)) {
      console.log(`[SHIFT] 消息类型不匹配: ${messageType} not in ${options}`);
      return;
    }

    // Execute forwarding
    console.log(
      `[SHIFT] 开始转发: ${sourceId} -> ${targetId}, msg=${message.id}`
    );
    const client = await getGlobalClient();
    let replyTo = undefined;
    if (options && options.length > 0) {
      for (const option of options) {
        if (option.startsWith("replyTo:")) {
          const replyToStr = option.replace("replyTo:", "").trim();
          const replyToNum = parseInt(replyToStr);
          if (!isNaN(replyToNum)) {
            replyTo = replyToNum;
          }
          break;
        }
      }
    }
    await shiftForwardMessage(
      client,
      sourceId,
      targetId,
      message.id,
      undefined,
      {
        silent: options?.includes("silent"),
        replyTo,
      }
    );

    // Update stats
    updateStats(sourceId, targetId, messageType);
  } catch (error) {
    console.error(`[SHIFT] 处理消息时出错: ${error}`);
  }
}

export default new ShiftPlugin();

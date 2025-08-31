// Remove Plugin import since we're using object interface
import { Api, TelegramClient } from "telegram";
import path from "path";
import Database from "better-sqlite3";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getEntityWithHash } from "@utils/entityHelpers";
import { Plugin } from "@utils/pluginBase";

// Initialize database
const dbPath = path.join(createDirectoryInAssets("pmcaptcha"), "pmcaptcha.db");
let db = new Database(dbPath);

// Initialize database tables
if (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pmcaptcha_whitelist (
      user_id INTEGER PRIMARY KEY,
      added_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pmcaptcha_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pmcaptcha_challenges (
      user_id INTEGER PRIMARY KEY,
      challenge_type TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      timeout INTEGER NOT NULL
    )
  `);
}

// HTML escape helper
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Get user ID by index from whitelist
function getUserIdByIndex(index: number): number | null {
  try {
    const whitelistUsers = db
      .prepare("SELECT user_id FROM pmcaptcha_whitelist ORDER BY user_id")
      .all() as any[];
    if (index >= 1 && index <= whitelistUsers.length) {
      return whitelistUsers[index - 1].user_id;
    }
    return null;
  } catch (error) {
    console.error("[PMCaptcha] Error getting user by index:", error);
    return null;
  }
}

// Database helper functions
const dbHelpers = {
  getSetting: (key: string, defaultValue: any = null) => {
    const row = db
      .prepare("SELECT value FROM pmcaptcha_settings WHERE key = ?")
      .get(key) as any;
    return row ? JSON.parse(row.value) : defaultValue;
  },

  setSetting: (key: string, value: any) => {
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO pmcaptcha_settings (key, value) VALUES (?, ?)"
    );
    stmt.run(key, JSON.stringify(value));
  },

  isWhitelisted: (userId: number): boolean => {
    const row = db
      .prepare("SELECT 1 FROM pmcaptcha_whitelist WHERE user_id = ?")
      .get(userId);
    return !!row;
  },

  addToWhitelist: (userId: number) => {
    const stmt = db.prepare(
      "INSERT OR IGNORE INTO pmcaptcha_whitelist (user_id) VALUES (?)"
    );
    stmt.run(userId);
  },

  removeFromWhitelist: (userId: number) => {
    const stmt = db.prepare(
      "DELETE FROM pmcaptcha_whitelist WHERE user_id = ?"
    );
    stmt.run(userId);
  },

  getChallengeState: (userId: number) => {
    const row = db
      .prepare("SELECT * FROM pmcaptcha_challenges WHERE user_id = ?")
      .get(userId) as any;
    return row || null;
  },

  setChallengeState: (
    userId: number,
    challengeType: string,
    timeout: number
  ) => {
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO pmcaptcha_challenges (user_id, challenge_type, start_time, timeout) VALUES (?, ?, ?, ?)"
    );
    stmt.run(userId, challengeType, Math.floor(Date.now() / 1000), timeout);
  },

  removeChallengeState: (userId: number) => {
    const stmt = db.prepare(
      "DELETE FROM pmcaptcha_challenges WHERE user_id = ?"
    );
    stmt.run(userId);
  },
};

// Active challenges map
const activeChallenges = new Map<
  number,
  {
    type: "sticker";
    startTime: number;
    timeout: number;
    timer?: NodeJS.Timeout;
  }
>();

// Check common groups count for whitelist
async function checkCommonGroups(
  client: TelegramClient,
  userId: number
): Promise<boolean> {
  const minCommonGroups = dbHelpers.getSetting("groups_in_common");
  if (minCommonGroups === null) return false;

  try {
    const entity = await getEntityWithHash(client, userId);
    const userFull = await client.invoke(
      new Api.users.GetFullUser({ id: entity })
    );

    if (userFull.fullUser.commonChatsCount >= minCommonGroups) {
      dbHelpers.addToWhitelist(userId);
      console.log(
        `[PMCaptcha] User ${userId} added to whitelist (${userFull.fullUser.commonChatsCount} common groups)`
      );
      return true;
    }
  } catch (error) {
    console.error(
      `[PMCaptcha] Failed to check common groups for user ${userId}:`,
      error
    );
  }

  return false;
}

// Start sticker challenge
async function startStickerChallenge(
  client: TelegramClient,
  userId: number
): Promise<boolean> {
  const timeout = dbHelpers.getSetting("sticker_timeout", 180) * 1000;

  try {
    const challengeMsg = await client.sendMessage(userId, {
      message: `🔒 <b>验证挑战</b>\n\n<code>请发送任意表情包进行验证</code>\n\n⏰ <i>验证时间限制: ${
        timeout > 0 ? `${timeout / 1000}秒` : "无限制"
      }</i>`,
      parseMode: "html",
    });

    // Set challenge state
    dbHelpers.setChallengeState(userId, "sticker", timeout);

    // Set timer for timeout
    if (timeout > 0) {
      const timer = setTimeout(async () => {
        await handleChallengeTimeout(client, userId);
      }, timeout * 1000);

      activeChallenges.set(userId, {
        type: "sticker",
        startTime: Date.now(),
        timeout,
        timer,
      });
    } else {
      activeChallenges.set(userId, {
        type: "sticker",
        startTime: Date.now(),
        timeout: 0,
      });
    }

    console.log(`[PMCaptcha] Started sticker challenge for user ${userId}`);
    return true;
  } catch (error) {
    console.error(
      `[PMCaptcha] Failed to start sticker challenge for user ${userId}:`,
      error
    );
    return false;
  }
}

// Handle challenge timeout
async function handleChallengeTimeout(client: TelegramClient, userId: number) {
  const challenge = activeChallenges.get(userId);
  if (!challenge) return;

  try {
    await client.sendMessage(userId, {
      message: "❌ <b>验证超时</b>\n\n验证时间已到，请重新开始验证。",
      parseMode: "html",
    });
  } catch (error) {
    console.error(
      `[PMCaptcha] Failed to send timeout message to user ${userId}:`,
      error
    );
  }

  // Clean up
  activeChallenges.delete(userId);
  dbHelpers.removeChallengeState(userId);
}

// Verify sticker response
async function verifyStickerResponse(
  client: TelegramClient,
  userId: number,
  hasSticker: boolean
): Promise<boolean> {
  const challenge = activeChallenges.get(userId);
  if (!challenge || challenge.type !== "sticker") return false;

  if (hasSticker) {
    // Success - add to whitelist
    dbHelpers.addToWhitelist(userId);

    try {
      await client.sendMessage(userId, {
        message: "✅ <b>验证成功</b>\n\n欢迎！您已通过表情包验证。",
        parseMode: "html",
      });
    } catch (error) {
      console.error(
        `[PMCaptcha] Failed to send success message to user ${userId}:`,
        error
      );
    }

    // Clean up
    if (challenge.timer) {
      clearTimeout(challenge.timer);
    }
    activeChallenges.delete(userId);
    dbHelpers.removeChallengeState(userId);

    console.log(`[PMCaptcha] User ${userId} passed sticker verification`);
    return true;
  } else {
    // Failed - send retry message
    try {
      await client.sendMessage(userId, {
        message: "❌ <b>验证失败</b>\n\n请发送表情包进行验证，不是文字消息。",
        parseMode: "html",
      });
    } catch (error) {
      console.error(
        `[PMCaptcha] Failed to send retry message to user ${userId}:`,
        error
      );
    }
    return false;
  }
}

// Message listener for handling incoming messages
async function pmcaptchaMessageListener(message: Api.Message) {
  const client = message.client as TelegramClient;

  // Only handle private messages
  if (!message.isPrivate) return;

  if (message.out) return;

  const userId = Number(message.senderId);
  if (!userId) return;

  // Skip if already whitelisted
  if (dbHelpers.isWhitelisted(userId)) return;

  // Check if user is in active challenge
  const activeChallenge = activeChallenges.get(userId);
  if (activeChallenge && activeChallenge.type === "sticker") {
    // Verify sticker response
    const hasSticker = !!message.sticker
    await verifyStickerResponse(client, userId, hasSticker);
    return;
  }

  // Check common groups for auto-whitelist
  if (await checkCommonGroups(client, userId)) {
    return; // User was whitelisted via common groups
  }

  // Start sticker challenge for new users
  if (!activeChallenge) {
    await startStickerChallenge(client, userId);
  }
}

const pmcaptchaPlugin: Plugin = {
  command: ["pmcaptcha", "pmc"],
  description: "PMCaptcha - 共同群白名单和表情包验证系统",
  listenMessageHandler: async (msg) => {
    await pmcaptchaMessageListener(msg);
  },
  cmdHandler: async (message: Api.Message) => {
    const client = message.client as TelegramClient;
    const args = message.message.slice(1).split(" ").slice(1);
    const command = args[0] || "help";

    try {
      switch (command.toLowerCase()) {
        case "help":
        case "h":
        case "":
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `🔒 <b>PMCaptcha 验证系统</b>\n\n<b>🛡️ 核心功能</b>\n· 共同群数量自动白名单\n· 表情包验证挑战系统\n· 智能用户识别与管理\n\n<b>📋 命令列表</b>\n· <code>.pmcaptcha</code> · <code>.pmcaptcha h</code> · <code>.pmcaptcha help</code>\n  显示此帮助信息\n\n· <code>.pmcaptcha groups [数量]</code>\n  设置共同群白名单阈值 · 达到即自动通过\n\n· <code>.pmcaptcha timeout [秒数]</code>\n  设置表情包验证超时 · 默认180秒\n\n· <code>.pmcaptcha add [用户ID/用户名]</code>\n  手动添加白名单 · 支持回复消息 · 支持私聊操作\n\n· <code>.pmcaptcha del [用户ID]</code>\n  从白名单移除指定用户\n\n· <code>.pmcaptcha check [用户ID]</code>\n  检查用户当前验证状态\n\n· <code>.pmcaptcha list</code>\n  显示所有白名单用户列表\n\n· <code>.pmcaptcha status</code>\n  查看系统运行状态与统计\n\n💡 <i>智能验证 · 安全防护 · 便捷管理</i>`,
            parseMode: "html",
          });
          break;

        case "groups":
        case "group":
        case "common":
          if (!args[1]) {
            const currentGroups = dbHelpers.getSetting("groups_in_common");
            const statusText =
              currentGroups !== null
                ? `当前设置: <code>${currentGroups}</code> 个共同群`
                : "功能已禁用";
            await client.editMessage(message.peerId, {
              message: message.id,
              text: `🏘️ <b>共同群白名单设置</b>\n\n${statusText}\n\n<b>使用方法:</b>\n• <code>.pmcaptcha groups [数量]</code> - 设置最小共同群数量\n• <code>.pmcaptcha groups -1</code> - 禁用功能\n\n💡 <i>用户与您的共同群数量达到设定值时自动加入白名单</i>`,
              parseMode: "html",
            });
          } else {
            const count = parseInt(args[1]);
            if (count === -1) {
              dbHelpers.setSetting("groups_in_common", null);
              await client.editMessage(message.peerId, {
                message: message.id,
                text: "✅ 共同群白名单功能已禁用",
                parseMode: "html",
              });
            } else if (count >= 0) {
              dbHelpers.setSetting("groups_in_common", count);
              await client.editMessage(message.peerId, {
                message: message.id,
                text: `✅ 共同群白名单已设置为 <code>${count}</code> 个群`,
                parseMode: "html",
              });
            } else {
              await client.editMessage(message.peerId, {
                message: message.id,
                text: "❌ 请输入有效的数量 (≥0) 或 -1 禁用功能",
                parseMode: "html",
              });
            }
          }
          break;

        case "timeout":
        case "wait":
          if (!args[1]) {
            const currentTimeout = dbHelpers.getSetting("sticker_timeout", 180);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: `⏰ <b>表情包验证超时设置</b>\n\n当前设置: <code>${currentTimeout}</code> 秒\n\n<b>使用方法:</b>\n· <code>.pmcaptcha timeout [秒数]</code> - 设置超时时间\n· <code>.pmcaptcha timeout 0</code> - 无时间限制\n· <code>.pmcaptcha timeout 180</code> - 恢复默认(180秒)\n\n<b>建议值:</b>\n· 快速验证: 60-120秒\n· 标准验证: 180秒 (默认)\n· 宽松验证: 300-600秒\n\n💡 <i>用户需要在指定时间内发送表情包完成验证 · 超时将自动失败</i>`,
              parseMode: "html",
            });
          } else {
            const timeout = parseInt(args[1]);
            if (timeout >= 0) {
              dbHelpers.setSetting("sticker_timeout", timeout);
              const timeText = timeout === 0 ? "无时间限制" : `${timeout}秒`;
              await client.editMessage(message.peerId, {
                message: message.id,
                text: `✅ 表情包验证超时已设置为 <code>${timeText}</code>`,
                parseMode: "html",
              });
            } else {
              await client.editMessage(message.peerId, {
                message: message.id,
                text: "❌ 请输入有效的秒数 (≥0)",
                parseMode: "html",
              });
            }
          }
          break;

        case "check":
          let checkUserId: number;

          if (!args[1]) {
            checkUserId = Number(message.senderId);
          } else {
            const arg = args[1];
            // Check if it's an index (number <= 99)
            const argNum = parseInt(arg);
            if (argNum > 0 && argNum <= 99) {
              const userIdFromIndex = getUserIdByIndex(argNum);
              if (userIdFromIndex) {
                checkUserId = userIdFromIndex;
              } else {
                await client.editMessage(message.peerId, {
                  message: message.id,
                  text: `❌ 序号 <code>${argNum}</code> 不存在，请使用 <code>.pmcaptcha list</code> 查看有效序号`,
                  parseMode: "html",
                });
                break;
              }
            } else {
              checkUserId = argNum;
            }
          }

          if (!checkUserId || checkUserId <= 0) {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 请提供有效的用户ID或序号",
              parseMode: "html",
            });
            break;
          }

          const isVerified = dbHelpers.isWhitelisted(checkUserId);
          const challengeState = dbHelpers.getChallengeState(checkUserId);
          const activeChallenge = activeChallenges.get(checkUserId);

          let statusText = isVerified ? "✅ 已验证" : "❌ 未验证";
          if (challengeState || activeChallenge) {
            statusText += " (验证中...)";
          }

          await client.editMessage(message.peerId, {
            message: message.id,
            text: `👤 <b>用户验证状态</b>\n\n用户ID: <code>${checkUserId}</code>\n状态: ${statusText}`,
            parseMode: "html",
          });
          break;

        case "add":
          let targetUserId: number | null = null;
          let targetUserName = "";

          // Check if replying to a message
          if (message.replyTo && message.replyTo.replyToMsgId) {
            try {
              const repliedMessage = await client.getMessages(message.peerId, {
                ids: [message.replyTo.replyToMsgId],
              });
              if (repliedMessage[0] && repliedMessage[0].senderId) {
                targetUserId = Number(repliedMessage[0].senderId);
                // Try to get user info for display name
                try {
                  const entity = await getEntityWithHash(client, targetUserId);
                  if (entity) {
                    const userFull = await client.invoke(
                      new Api.users.GetFullUser({ id: entity })
                    );
                    const user = userFull.users[0] as any;
                    targetUserName =
                      user.username ||
                      `${user.firstName || ""} ${user.lastName || ""}`.trim();
                  }
                } catch (e) {
                  // Ignore entity fetch errors
                }
              }
            } catch (e) {
              console.error("[PMCaptcha] Error getting replied message:", e);
            }
          }

          // If no reply, check for argument
          if (!targetUserId && args[1]) {
            const arg = args[1];
            // Check if it's a username (starts with @)
            if (arg.startsWith("@")) {
              try {
                const username = arg.slice(1);
                const entity = await client.getEntity(username);
                if (entity && "id" in entity) {
                  targetUserId = Number(entity.id);
                  targetUserName = username;
                }
              } catch (e) {
                await client.editMessage(message.peerId, {
                  message: message.id,
                  text: `❌ 找不到用户名: <code>@${arg.slice(1)}</code>`,
                  parseMode: "html",
                });
                break;
              }
            } else {
              // Try to parse as user ID
              const userId = parseInt(arg);
              if (userId > 0) {
                targetUserId = userId;
              }
            }
          }

          // If still no target, use sender (for private chat)
          if (!targetUserId) {
            targetUserId = Number(message.senderId);
            targetUserName = "自己";
          }

          if (!targetUserId || targetUserId <= 0) {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 请提供有效的用户ID、用户名，或回复要添加的用户消息",
              parseMode: "html",
            });
            break;
          }

          // Remove from active challenges if exists
          const activeAdd = activeChallenges.get(targetUserId);
          if (activeAdd?.timer) {
            clearTimeout(activeAdd.timer);
          }
          activeChallenges.delete(targetUserId);
          dbHelpers.removeChallengeState(targetUserId);

          dbHelpers.addToWhitelist(targetUserId);

          const displayName = targetUserName
            ? `<a href="tg://user?id=${targetUserId}">${htmlEscape(
                targetUserName
              )}</a>`
            : `<code>${targetUserId}</code>`;

          await client.editMessage(message.peerId, {
            message: message.id,
            text: `✅ 用户 ${displayName} 已添加到白名单`,
            parseMode: "html",
          });
          break;

        case "del":
        case "delete":
        case "remove":
          let delUserId: number;

          if (!args[1]) {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 请提供用户ID或序号",
              parseMode: "html",
            });
            break;
          }

          const delArg = args[1];
          const delArgNum = parseInt(delArg);

          // Check if it's an index (number <= 99)
          if (delArgNum > 0 && delArgNum <= 99) {
            const userIdFromIndex = getUserIdByIndex(delArgNum);
            if (userIdFromIndex) {
              delUserId = userIdFromIndex;
            } else {
              await client.editMessage(message.peerId, {
                message: message.id,
                text: `❌ 序号 <code>${delArgNum}</code> 不存在，请使用 <code>.pmcaptcha list</code> 查看有效序号`,
                parseMode: "html",
              });
              break;
            }
          } else {
            delUserId = delArgNum;
          }

          if (!delUserId || delUserId <= 0) {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 请提供有效的用户ID或序号",
              parseMode: "html",
            });
            break;
          }

          // Check if user exists in whitelist
          if (!dbHelpers.isWhitelisted(delUserId)) {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: `❌ 用户 <code>${delUserId}</code> 不在白名单中`,
              parseMode: "html",
            });
            break;
          }

          dbHelpers.removeFromWhitelist(delUserId);
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `✅ 用户 <code>${delUserId}</code> 已从白名单移除`,
            parseMode: "html",
          });
          break;

        case "list":
        case "ls":
          const whitelistUsers = db
            .prepare("SELECT user_id FROM pmcaptcha_whitelist ORDER BY user_id")
            .all() as any[];

          if (whitelistUsers.length === 0) {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: `📝 <b>白名单用户列表</b>\n\n<i>暂无用户</i>\n\n使用 <code>.pmcaptcha add</code> 添加用户到白名单`,
              parseMode: "html",
            });
            break;
          }

          let userListText = "";

          for (let i = 0; i < Math.min(whitelistUsers.length, 15); i++) {
            const row = whitelistUsers[i];
            const userId = row.user_id;
            const index = i + 1;
            let displayName = "";

            try {
              const entity = await getEntityWithHash(client, userId);
              if (entity) {
                const userFull = await client.invoke(
                  new Api.users.GetFullUser({ id: entity })
                );
                const user = userFull.users[0] as any;

                if (user.username) {
                  displayName = `<a href="tg://user?id=${userId}">@${htmlEscape(
                    user.username
                  )}</a>`;
                } else {
                  const fullName = `${user.firstName || ""} ${
                    user.lastName || ""
                  }`.trim();
                  if (fullName) {
                    displayName = `<a href="tg://user?id=${userId}">${htmlEscape(
                      fullName
                    )}</a>`;
                  }
                }
              }
            } catch (e) {
              // Keep empty if entity fetch fails
            }

            // Format: [序号] 用户名/昵称 <code>ID</code>
            if (displayName) {
              userListText += `<code>[${index
                .toString()
                .padStart(
                  2,
                  "0"
                )}]</code> ${displayName} <code>${userId}</code>\n`;
            } else {
              userListText += `<code>[${index
                .toString()
                .padStart(2, "0")}]</code> <code>${userId}</code>\n`;
            }
          }

          const totalCount = whitelistUsers.length;
          const moreText =
            totalCount > 15
              ? `\n<i>... 还有 ${totalCount - 15} 个用户</i>`
              : "";

          await client.editMessage(message.peerId, {
            message: message.id,
            text: `📝 <b>白名单用户列表</b> (${totalCount})\n\n${userListText}${moreText}\n\n<b>操作方法:</b>\n· <code>.pmcaptcha del [序号/用户ID]</code> - 移除用户\n· <code>.pmcaptcha check [序号/用户ID]</code> - 检查状态`,
            parseMode: "html",
          });
          break;

        case "status":
        case "stat":
          const whitelistCount = db
            .prepare("SELECT COUNT(*) as count FROM pmcaptcha_whitelist")
            .get() as any;
          const challengeCount = activeChallenges.size;
          const groupsSetting = dbHelpers.getSetting("groups_in_common");
          const timeoutSetting = dbHelpers.getSetting("sticker_timeout", 180);

          await client.editMessage(message.peerId, {
            message: message.id,
            text: `📊 <b>PMCaptcha 系统状态</b>\n\n<b>白名单用户:</b> <code>${
              whitelistCount.count
            }</code> 人\n<b>进行中验证:</b> <code>${challengeCount}</code> 人\n\n<b>设置状态:</b>\n• 共同群白名单: ${
              groupsSetting !== null
                ? `<code>${groupsSetting}</code> 个群`
                : "<code>已禁用</code>"
            }\n• 验证超时: <code>${
              timeoutSetting === 0 ? "无限制" : `${timeoutSetting}秒`
            }</code>\n\n⏰ <i>${new Date().toLocaleString("zh-CN")}</i>`,
            parseMode: "html",
          });
          break;

        default:
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `❌ 未知命令: <code>${htmlEscape(
              command
            )}</code>\n\n使用 <code>.pmcaptcha help</code> 查看帮助信息`,
            parseMode: "html",
          });
      }
    } catch (error) {
      console.error("[PMCaptcha] Command execution error:", error);
      await client.editMessage(message.peerId, {
        message: message.id,
        text: `❌ 执行失败: ${htmlEscape(String(error))}`,
        parseMode: "html",
      });
    }
  },
};

export default pmcaptchaPlugin;

// Remove Plugin import since we're using object interface
import { Api, TelegramClient } from "telegram";
import path from "path";
import Database from "better-sqlite3";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getEntityWithHash } from "@utils/entityHelpers";
import { Plugin } from "@utils/pluginBase";

// Initialize databases
const pmcaptchaDir = createDirectoryInAssets("pmcaptcha");
const dbPath = path.join(pmcaptchaDir, "pmcaptcha.db");
let db = new Database(dbPath);

// Initialize lowdb for configuration
let configDb: any = null;
let configDbReady = false;
const CONFIG_KEYS = {
  ENABLED: "plugin_enabled",
  BLOCK_BOTS: "block_bots", 
  GROUPS_COMMON: "groups_in_common",
  STICKER_TIMEOUT: "sticker_timeout",
  STATS_TOTAL_VERIFIED: "stats_total_verified",
  STATS_TOTAL_BLOCKED: "stats_total_blocked",
  STATS_LAST_RESET: "stats_last_reset",
  DELETE_AND_REPORT: "delete_and_report",
  PROTECTION_MODE: "protection_mode",
  PROTECTION_THRESHOLD: "protection_threshold",
  PROTECTION_WINDOW: "protection_window",
  PROTECTION_ACTIVE: "protection_active",
  PROTECTION_ACTIVATED_AT: "protection_activated_at"
};

const DEFAULT_CONFIG = {
  [CONFIG_KEYS.ENABLED]: true,
  [CONFIG_KEYS.BLOCK_BOTS]: true,
  [CONFIG_KEYS.GROUPS_COMMON]: null,
  [CONFIG_KEYS.STICKER_TIMEOUT]: 180,
  [CONFIG_KEYS.STATS_TOTAL_VERIFIED]: 0,
  [CONFIG_KEYS.STATS_TOTAL_BLOCKED]: 0,
  [CONFIG_KEYS.STATS_LAST_RESET]: new Date().toISOString(),
  [CONFIG_KEYS.DELETE_AND_REPORT]: false,
  [CONFIG_KEYS.PROTECTION_MODE]: false,
  [CONFIG_KEYS.PROTECTION_THRESHOLD]: 20,
  [CONFIG_KEYS.PROTECTION_WINDOW]: 60000, // 60 seconds in ms
  [CONFIG_KEYS.PROTECTION_ACTIVE]: false,
  [CONFIG_KEYS.PROTECTION_ACTIVATED_AT]: null,
  // 扫描上限（可配置）
  SCAN_MAX: 2000
};

// Initialize lowdb configuration
async function initConfigDb() {
  try {
    const configPath = path.join(pmcaptchaDir, "pmcaptcha_config.json");
    configDb = await JSONFilePreset(configPath, DEFAULT_CONFIG);
    configDbReady = true;
    console.log("[PMCaptcha] Configuration database initialized");
  } catch (error) {
    console.error("[PMCaptcha] Failed to initialize config database:", error);
    configDbReady = false;
  }
}

// Wait for config DB to be ready
async function waitForConfigDb(timeout = 5000): Promise<boolean> {
  const startTime = Date.now();
  while (!configDbReady && Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return configDbReady;
}

// Call initialization
initConfigDb();

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

// Database helper functions with lowdb support
const dbHelpers = {
  getSetting: (key: string, defaultValue: any = null) => {
    if (!configDb || !configDbReady) return defaultValue;
    try {
      const value = configDb.data[key];
      return value !== undefined ? value : defaultValue;
    } catch (error) {
      console.error(`[PMCaptcha] Failed to get setting ${key}:`, error);
      return defaultValue;
    }
  },

  isPluginEnabled: (): boolean => {
    return dbHelpers.getSetting(CONFIG_KEYS.ENABLED, true);
  },

  setPluginEnabled: (enabled: boolean) => {
    dbHelpers.setSetting(CONFIG_KEYS.ENABLED, enabled);
  },

  setSetting: (key: string, value: any) => {
    if (!configDb || !configDbReady) {
      console.error("[PMCaptcha] Config database not initialized");
      return;
    }
    try {
      configDb.data[key] = value;
      configDb.write();
    } catch (error) {
      console.error(`[PMCaptcha] Failed to set setting ${key}:`, error);
    }
  },

  updateStats: (verified: number = 0, blocked: number = 0) => {
    if (!configDb || !configDbReady) return;
    try {
      configDb.data[CONFIG_KEYS.STATS_TOTAL_VERIFIED] += verified;
      configDb.data[CONFIG_KEYS.STATS_TOTAL_BLOCKED] += blocked;
      configDb.write();
    } catch (error) {
      console.error("[PMCaptcha] Failed to update stats:", error);
    }
  },

  isWhitelisted: (userId: number): boolean => {
    if (!db || !userId || userId <= 0) return false;
    try {
      const row = db
        .prepare("SELECT 1 FROM pmcaptcha_whitelist WHERE user_id = ?")
        .get(userId);
      return !!row;
    } catch (error) {
      console.error(`[PMCaptcha] Failed to check whitelist for ${userId}:`, error);
      return false;
    }
  },

  addToWhitelist: (userId: number) => {
    if (!db || !userId || userId <= 0) return;
    try {
      const stmt = db.prepare(
        "INSERT OR IGNORE INTO pmcaptcha_whitelist (user_id) VALUES (?)"
      );
      stmt.run(userId);
    } catch (error) {
      console.error(`[PMCaptcha] Failed to add ${userId} to whitelist:`, error);
    }
  },

  removeFromWhitelist: (userId: number) => {
    if (!db || !userId || userId <= 0) return;
    try {
      const stmt = db.prepare(
        "DELETE FROM pmcaptcha_whitelist WHERE user_id = ?"
      );
      stmt.run(userId);
    } catch (error) {
      console.error(`[PMCaptcha] Failed to remove ${userId} from whitelist:`, error);
    }
  },

  getChallengeState: (userId: number) => {
    if (!db || !userId || userId <= 0) return null;
    try {
      const row = db
        .prepare("SELECT * FROM pmcaptcha_challenges WHERE user_id = ?")
        .get(userId) as any;
      return row || null;
    } catch (error) {
      console.error(`[PMCaptcha] Failed to get challenge state for ${userId}:`, error);
      return null;
    }
  },

  setChallengeState: (
    userId: number,
    challengeType: string,
    timeout: number
  ) => {
    if (!db || !userId || userId <= 0) return;
    try {
      const stmt = db.prepare(
        "INSERT OR REPLACE INTO pmcaptcha_challenges (user_id, challenge_type, start_time, timeout) VALUES (?, ?, ?, ?)"
      );
      stmt.run(userId, challengeType, Math.floor(Date.now() / 1000), timeout);
    } catch (error) {
      console.error(`[PMCaptcha] Failed to set challenge state for ${userId}:`, error);
    }
  },

  removeChallengeState: (userId: number) => {
    if (!db || !userId || userId <= 0) return;
    try {
      const stmt = db.prepare(
        "DELETE FROM pmcaptcha_challenges WHERE user_id = ?"
      );
      stmt.run(userId);
    } catch (error) {
      console.error(`[PMCaptcha] Failed to remove challenge state for ${userId}:`, error);
    }
  },
};

// Active challenges map with cleanup mechanism
const activeChallenges = new Map<
  number,
  {
    type: "sticker";
    startTime: number;
    timeout: number;
    timer?: NodeJS.Timeout;
  }
>();

// Cleanup expired challenges periodically (every 5 minutes)
const challengeCleanupInterval = setInterval(() => {
  const now = Date.now();
  const expired: number[] = [];
  
  activeChallenges.forEach((challenge, userId) => {
    // Clean up challenges older than 1 hour (regardless of timeout setting)
    if (now - challenge.startTime > 3600000) {
      if (challenge.timer) {
        clearTimeout(challenge.timer);
      }
      expired.push(userId);
    }
  });
  
  expired.forEach(userId => {
    activeChallenges.delete(userId);
    dbHelpers.removeChallengeState(userId);
  });
  
  if (expired.length > 0) {
    console.log(`[PMCaptcha] Cleaned up ${expired.length} expired challenges`);
  }
}, 300000); // Run every 5 minutes

// Clean up on plugin unload
process.on('exit', () => {
  clearInterval(challengeCleanupInterval);
  clearInterval(trackerCleanupInterval);
  activeChallenges.forEach(challenge => {
    if (challenge.timer) clearTimeout(challenge.timer);
  });
  activeChallenges.clear();
  messageTracker.clear();
});

// Message frequency tracking for protection mode
const messageTracker = new Map<number, number[]>();

// Cleanup old message trackers periodically (every 10 minutes)
const trackerCleanupInterval = setInterval(() => {
  const now = Date.now();
  const maxAge = 600000; // 10 minutes
  const toDelete: number[] = [];
  
  messageTracker.forEach((timestamps, userId) => {
    // Remove trackers with no recent activity
    const hasRecent = timestamps.some(t => now - t < maxAge);
    if (!hasRecent) {
      toDelete.push(userId);
    } else {
      // Clean up old timestamps
      const recent = timestamps.filter(t => now - t < maxAge);
      messageTracker.set(userId, recent);
    }
  });
  
  toDelete.forEach(userId => messageTracker.delete(userId));
  
  if (toDelete.length > 0) {
    console.log(`[PMCaptcha] Cleaned up ${toDelete.length} message trackers`);
  }
}, 600000); // Run every 10 minutes

// Track incoming message for protection mode
function trackMessage(userId: number): boolean {
  if (!dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_MODE, false)) {
    return false;
  }
  
  const now = Date.now();
  const window = dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_WINDOW, 60000);
  const threshold = dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_THRESHOLD, 20);
  
  // Get or create tracker for user
  if (!messageTracker.has(userId)) {
    messageTracker.set(userId, []);
  }
  
  const timestamps = messageTracker.get(userId)!;
  
  // Remove old timestamps outside window
  const cutoff = now - window;
  const recent = timestamps.filter(t => t > cutoff);
  recent.push(now);
  messageTracker.set(userId, recent);
  
  // Check if threshold exceeded
  if (recent.length >= threshold) {
    console.log(`[PMCaptcha] Protection mode triggered! User ${userId} sent ${recent.length} messages in ${window}ms`);
    return true;
  }
  
  return false;
}

// Helper function to move a peer to a specific folder
async function setFolder(client: TelegramClient, userId: number, folderId: number): Promise<boolean> {
  try {
    const userEntity = await client.getInputEntity(userId);
    await client.invoke(
      new Api.folders.EditPeerFolders({
        folderPeers: [new Api.InputFolderPeer({ peer: userEntity, folderId })]
      })
    );
    return true;
  } catch (error) {
    console.error(`[PMCaptcha] Failed to set folder ${folderId} for user ${userId}:`, error);
    return false;
  }
}

// Archive conversation
async function archiveConversation(client: TelegramClient, userId: number): Promise<boolean> {
  console.log(`[PMCaptcha] Archiving conversation with user ${userId}`);
  return setFolder(client, userId, 1); // 1 = Archive
}

// Unarchive conversation and enable notifications
async function unarchiveConversation(client: TelegramClient, userId: number): Promise<boolean> {
  console.log(`[PMCaptcha] Unarchiving conversation for user ${userId}`);
  
  // Restore notifications first
  try {
    await client.invoke(
      new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer: await client.getInputEntity(userId) }),
        settings: new Api.InputPeerNotifySettings({
          muteUntil: 0, // Unmute
          sound: new Api.NotificationSoundDefault()
        })
      })
    );
  } catch (error) {
    console.error(`[PMCaptcha] Failed to update notify settings for ${userId}:`, error);
  }

  // Move to main folder
  return setFolder(client, userId, 0); // 0 = Main folder (All Chats)
}

// Delete and report user (both sides)
async function deleteAndReportUser(
  client: TelegramClient,
  userId: number,
  reason: string = "spam"
): Promise<boolean> {
  try {
    // Report user for spam
    await client.invoke(
      new Api.account.ReportPeer({
        peer: await client.getInputEntity(userId),
        reason: new Api.InputReportReasonSpam(),
        message: reason
      })
    );
    
    // Delete conversation from both sides
    await client.invoke(
      new Api.messages.DeleteHistory({
        justClear: false,
        revoke: true, // Delete for both sides
        peer: await client.getInputEntity(userId),
        maxId: 0 // Delete all messages
      })
    );
    
    // Block user
    await client.invoke(
      new Api.contacts.Block({
        id: await client.getInputEntity(userId)
      })
    );
    
    console.log(`[PMCaptcha] Deleted and reported user ${userId} for ${reason}`);
    dbHelpers.updateStats(0, 1);
    
    return true;
  } catch (error) {
    console.error(`[PMCaptcha] Failed to delete and report user ${userId}:`, error);
    return false;
  }
}

// Check if user is valid (not bot, deleted, fake, scam)
async function isValidUser(
  client: TelegramClient,
  userId: number
): Promise<boolean> {
  try {
    const entity = await getEntityWithHash(client, userId);
    const userFull = await client.invoke(
      new Api.users.GetFullUser({ id: entity })
    );
    const user = userFull.users[0] as Api.User;
    
    // Exclude bots, deleted, fake, scam accounts
    return !user.bot && !user.deleted && !user.fake && !user.scam;
  } catch (error) {
    console.error(`[PMCaptcha] Failed to check user validity for ${userId}:`, error);
    // Graceful degradation: allow verification if API check fails
    return true;
  }
}

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
  const timeout = dbHelpers.getSetting(CONFIG_KEYS.STICKER_TIMEOUT, 180) * 1000;

  try {
    // Archive the conversation first
    await archiveConversation(client, userId);

    const challengeMsg = await client.sendMessage(userId, {
      message: `🔒 <b>人机验证</b>\n\n👋 您好！为了确保您是真实用户，请完成以下验证：\n\n📌 <b>验证方式：</b>\n发送任意<b>表情包（Sticker）</b>即可通过验证\n\n⏰ <b>时间限制：</b> ${
        timeout > 0 ? `${timeout / 1000}秒` : "无限制"
      }\n\n💡 <i>提示：点击输入框旁的😊图标选择表情包</i>`,
      parseMode: "html",
    });

    // Set challenge state
    dbHelpers.setChallengeState(userId, "sticker", timeout);

    // Set timer for timeout
    if (timeout > 0) {
      const timer = setTimeout(async () => {
        await handleChallengeTimeout(client, userId);
      }, timeout);

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

  console.log(`[PMCaptcha] Challenge timeout for user ${userId}, deleting and reporting`);
  
  // Delete and report user for timeout
  await deleteAndReportUser(client, userId, "verification timeout");

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
    
    // Update statistics
    dbHelpers.updateStats(1, 0);

    // Unarchive conversation and enable notifications
    await unarchiveConversation(client, userId);

    try {
      await client.sendMessage(userId, {
        message: "✅ <b>验证成功</b>\n\n🎉 欢迎！您已成功通过验证。\n\n现在可以正常发送消息了，祝您使用愉快！",
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
    // Failed - check if user has exceeded retry attempts
    const challenge = activeChallenges.get(userId);
    if (challenge) {
      // For now, we'll be strict and delete/report on any non-sticker message
      console.log(`[PMCaptcha] User ${userId} failed verification (sent non-sticker), deleting and reporting`);
      
      // Delete and report user for verification failure
      await deleteAndReportUser(client, userId, "verification failed");
      
      // Clean up
      if (challenge.timer) {
        clearTimeout(challenge.timer);
      }
      activeChallenges.delete(userId);
      dbHelpers.removeChallengeState(userId);
    }
    return false;
  }
}

// Robust sticker detection (GramJS)
function isStickerMessage(message: Api.Message): boolean {
  try {
    const media: any = (message as any).media;
    const doc: any = media?.document;
    const attrs: any[] = (doc && (doc as any).attributes) || [];
    return attrs.some((a: any) =>
      (a instanceof (Api as any).DocumentAttributeSticker) ||
      a?.className === "DocumentAttributeSticker" ||
      a?._ === "documentAttributeSticker"
    );
  } catch {
    return false;
  }
}

// Handle bot private messages (block if enabled)
async function handleBotMessage(
  client: TelegramClient,
  message: Api.Message,
  userId: number
): Promise<boolean> {
  const blockBots = dbHelpers.getSetting(CONFIG_KEYS.BLOCK_BOTS, true);
  if (!blockBots) return false;

  const deleteAndReport = dbHelpers.getSetting(CONFIG_KEYS.DELETE_AND_REPORT, false);
  
  if (deleteAndReport) {
    // Use delete and report for bots
    await deleteAndReportUser(client, userId, "bot spam");
    return true;
  }

  try {
    // Send warning to bot first
    await client.sendMessage(userId, {
      message: "🤖 <b>Bot检测</b>\n\n您的bot账户已被自动拦截。如有疑问请联系管理员。",
      parseMode: "html",
    });
    
    // Then try to delete the bot message
    try {
      await message.delete({ revoke: true });
    } catch (deleteError) {
      console.warn(`[PMCaptcha] Could not delete bot message from ${userId}: ${deleteError}`);
    }
    
    console.log(`[PMCaptcha] Blocked bot message from ${userId}`);
    // Update blocked statistics
    dbHelpers.updateStats(0, 1);
    return true;
  } catch (error) {
    console.error(`[PMCaptcha] Failed to handle bot message from ${userId}:`, error);
    return false;
  }
}

// Check if there's chat history between users
async function hasChatHistory(
  client: TelegramClient,
  userId: number,
  excludeMessageId?: number
): Promise<boolean> {
  try {
    const messages = await client.getMessages(userId, {
      limit: 10
    });
    const filtered = excludeMessageId
      ? messages.filter((m: any) => Number(m.id) !== Number(excludeMessageId))
      : messages;
    return filtered.length > 0;
  } catch (error) {
    console.error(`[PMCaptcha] Failed to check chat history with ${userId}:`, error);
    return false;
  }
}

// Scan and whitelist existing chats on enable
async function scanExistingChats(client: TelegramClient, progressCallback?: (msg: string) => Promise<void>) {
  console.log("[PMCaptcha] Starting automatic chat scan...");
  let scannedCount = 0;
  let whitelistedCount = 0;
  let skipCount = 0;
  
  try {
    // Use official iterDialogs method and process private chats on-the-fly
    const maxScan = dbHelpers.getSetting("SCAN_MAX", 2000);
    let totalDialogs = 0;
    
    if (progressCallback) {
      await progressCallback(`📊 正在扫描私聊对话...`);
    }
    
    // Use iterDialogs and process private chats immediately
    for await (const dialog of client.iterDialogs({
      limit: maxScan, // Total limit across all iterations
    })) {
      totalDialogs++;
      
      // Update progress every 100 dialogs
      if (totalDialogs % 100 === 0 && progressCallback) {
        await progressCallback(`🔄 已扫描: ${totalDialogs} | 私聊: ${scannedCount} | 加白: ${whitelistedCount}`);
      }
      
      // Only process private chats with users (not bots, groups, channels)
      if (dialog.isUser) {
        const entity = dialog.entity as Api.User;
        if (!entity?.bot && entity?.id) {
          scannedCount++;
          const userId = Number(entity.id);
          
          if (userId > 0) {
            if (dbHelpers.isWhitelisted(userId)) {
              skipCount++;
            } else {
              // Check if there's chat history
              try {
                const hasHistory = await hasChatHistory(client, userId);
                if (hasHistory) {
                  dbHelpers.addToWhitelist(userId);
                  whitelistedCount++;
                  console.log(`[PMCaptcha] Auto-whitelisted user ${userId} (has chat history)`);
                }
              } catch (error) {
                console.error(`[PMCaptcha] Failed to check history for ${userId}:`, error);
              }
            }
          }
        }
      }
      
      // Safety check
      if (totalDialogs >= maxScan) {
        console.log(`[PMCaptcha] Reached ${maxScan} dialogs scan limit`);
        break;
      }
    }
    
    console.log(`[PMCaptcha] Scan completed: ${totalDialogs} total dialogs, ${scannedCount} private chats`);
    
    const resultMsg = `✅ 扫描完成\n· 总对话: ${totalDialogs}\n· 私聊对话: ${scannedCount}\n· 新增白名单: ${whitelistedCount}\n· 已存在: ${skipCount}`;
    console.log(`[PMCaptcha] ${resultMsg}`);
    
    if (progressCallback) {
      await progressCallback(resultMsg);
    }
    
  } catch (error) {
    console.error("[PMCaptcha] Failed to scan existing chats:", error);
    if (progressCallback) {
      await progressCallback(`❌ 扫描失败: ${error}`);
    }
  }
}

// Message listener for handling all private messages
async function pmcaptchaMessageListener(message: Api.Message) {
  try {
    const client = message.client as TelegramClient;

    // Only handle private messages
    if (!message.isPrivate) return;

    // Check if plugin is enabled
    if (!dbHelpers.isPluginEnabled()) return;

    const userId = Number(message.senderId);
    
    // Handle outgoing messages (user sends to someone)
    if (message.out) {
      // Get recipient ID (peer ID for private chats)
      const recipientId = Number((message.peerId as any)?.userId);
      if (recipientId && recipientId > 0 && !dbHelpers.isWhitelisted(recipientId)) {
        dbHelpers.addToWhitelist(recipientId);
        console.log(`[PMCaptcha] Auto-whitelisted recipient ${recipientId} (user initiated chat)`);
      }
      return;
    }

    // Handle incoming messages
    if (!userId || userId <= 0) return;

    // Skip if already whitelisted
    if (dbHelpers.isWhitelisted(userId)) return;

    // Check if there's chat history with this user
    const hasHistory = await hasChatHistory(client, userId, Number(message.id));
    if (hasHistory) {
      dbHelpers.addToWhitelist(userId);
      console.log(`[PMCaptcha] Auto-whitelisted user ${userId} (has chat history)`);
      return;
    }

    // Check protection mode first
    const protectionActive = dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_ACTIVE, false);
    if (protectionActive) {
      // In protection mode, delete and report all non-whitelisted users
      console.log(`[PMCaptcha] Protection mode active, auto-blocking user ${userId}`);
      await deleteAndReportUser(client, userId, "protection mode - flood");
      return;
    }

    // Track message frequency for protection mode
    if (trackMessage(userId)) {
      // Protection threshold exceeded, activate protection mode
      dbHelpers.setSetting(CONFIG_KEYS.PROTECTION_ACTIVE, true);
      dbHelpers.setSetting(CONFIG_KEYS.PROTECTION_ACTIVATED_AT, new Date().toISOString());
      
      console.log(`[PMCaptcha] PROTECTION MODE ACTIVATED! Blocking all new private messages`);
      
      // Delete and report the flooding user
      await deleteAndReportUser(client, userId, "message flooding");
      
      // Auto-deactivate protection mode after 5 minutes
      setTimeout(() => {
        dbHelpers.setSetting(CONFIG_KEYS.PROTECTION_ACTIVE, false);
        console.log(`[PMCaptcha] Protection mode deactivated after cooldown`);
      }, 300000);
      
      return;
    }

    // Check if user is valid (not bot, deleted, fake, scam)
    const isValid = await isValidUser(client, userId);
    if (!isValid) {
      // Handle bot messages if blocking is enabled
      await handleBotMessage(client, message, userId);
      return;
    }

    // Check if user is in active challenge
    const activeChallenge = activeChallenges.get(userId);
    if (activeChallenge && activeChallenge.type === "sticker") {
      // Verify sticker response
      const hasSticker = isStickerMessage(message);
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
  } catch (error) {
    console.error("[PMCaptcha] Message listener error:", error);
  }
}

const pmcaptcha = async (message: Api.Message) => {
  const client = message.client as TelegramClient;
  const args = message.message.slice(1).split(" ").slice(1);
  const command = args[0] || "help";

  try {
    switch (command.toLowerCase()) {
      case "help":
      case "h":
      case "?":
      case "":
        await client.editMessage(message.peerId, {
          message: message.id,
          text: `🔒 <b>PMCaptcha 验证系统 v3.3</b> <i>(深度优化版)</i>\n\n<b>🛡️ 核心功能</b>\n· 🆕 智能白名单（主动私聊/历史记录自动识别）\n· 🆕 启用时自动扫描现有对话（可配置上限）\n· 🆕 友好提示与操作确认（安全防误操作）\n· 用户实体检测（排除bot/假账户）\n· 共同群数量自动白名单\n· 表情包验证挑战系统\n· 双方删除并举报功能\n· 防护模式（反消息轰炸）\n\n<b>📋 系统控制</b> <i>(简化别名支持)</i>\n· <code>.pmcaptcha enable</code> - 启用并扫描 | 别名: 无\n· <code>.pmcaptcha disable</code> - 禁用插件 | 别名: 无\n· <code>.pmcaptcha scan</code> - 手动扫描 | 别名: <code>s</code>\n· <code>.pmcaptcha scan_set [数量]</code> - 设置扫描上限(100-10000)\n· <code>.pmcaptcha block_bots [on|off]</code> - Bot拦截开关\n· <code>.pmcaptcha delete_report [on|off]</code> - 双方删除举报\n· <code>.pmcaptcha protection [on|off]</code> - 防护模式开关\n· <code>.pmcaptcha protection_set [阈值] [窗口秒]</code> - 防护参数\n\n<b>📋 验证设置</b>\n· <code>.pmcaptcha groups [数量]</code> - 共同群阈值 | 别名: <code>g</code>\n· <code>.pmcaptcha timeout [秒数]</code> - 验证超时 | 别名: <code>t</code>\n\n<b>📋 白名单管理</b> <i>(快捷操作)</i>\n· <code>.pmcaptcha add [ID/@用户]</code> - 添加白名单 | 别名: <code>+</code>\n· <code>.pmcaptcha del [ID/序号]</code> - 移除白名单 | 别名: <code>-</code>\n· <code>.pmcaptcha check [ID/序号]</code> - 检查用户状态\n· <code>.pmcaptcha clear confirm</code> - ⚠️ 清空白名单(需确认)\n· <code>.pmcaptcha list</code> - 显示白名单列表\n\n<b>📊 状态查看</b>\n· <code>.pmcaptcha status</code> - 系统状态统计 | 别名: <code>i</code>\n· <code>.pmcaptcha help</code> - 显示帮助 | 别名: <code>h</code> <code>?</code>\n\n💡 <i>智能识别 · 安全防护 · 用户友好</i>`,
          parseMode: "html",
        });
        break;

      case "groups":
      case "group":
      case "common":
      case "g":
        if (!args[1]) {
          const currentGroups = dbHelpers.getSetting(CONFIG_KEYS.GROUPS_COMMON);
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
            dbHelpers.setSetting(CONFIG_KEYS.GROUPS_COMMON, null);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "✅ 共同群白名单功能已禁用",
              parseMode: "html",
            });
          } else if (count >= 0) {
            dbHelpers.setSetting(CONFIG_KEYS.GROUPS_COMMON, count);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: `✅ 共同群白名单已设置为 <code>${count}</code> 个群`,
              parseMode: "html",
            });
          } else {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: `❌ <b>参数错误</b>\n\n输入的值 <code>${htmlEscape(args[1])}</code> 无效。\n\n<b>正确格式：</b>\n• <code>.pmcaptcha groups 3</code> - 设置3个共同群\n• <code>.pmcaptcha groups 0</code> - 设置为0（仅验证）\n• <code>.pmcaptcha groups -1</code> - 完全禁用功能\n\n💡 <i>数值必须是整数且 ≥ -1</i>`,
              parseMode: "html",
            });
          }
        }
        break;

      case "timeout":
      case "time":
      case "t":
        if (!args[1]) {
          const currentTimeout = dbHelpers.getSetting(CONFIG_KEYS.STICKER_TIMEOUT, 180);
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `⏰ <b>表情包验证超时设置</b>\n\n当前设置: <code>${currentTimeout}</code> 秒\n\n<b>使用方法:</b>\n· <code>.pmcaptcha timeout [秒数]</code> - 设置超时时间\n· <code>.pmcaptcha timeout 0</code> - 无时间限制\n· <code>.pmcaptcha timeout 180</code> - 恢复默认(180秒)\n\n<b>建议值:</b>\n· 快速验证: 60-120秒\n· 标准验证: 180秒 (默认)\n· 宽松验证: 300-600秒\n\n💡 <i>用户需要在指定时间内发送表情包完成验证 · 超时将自动失败</i>`,
            parseMode: "html",
          });
        } else {
          const timeout = parseInt(args[1]);
          if (timeout >= 0) {
            dbHelpers.setSetting(CONFIG_KEYS.STICKER_TIMEOUT, timeout);
            const timeText = timeout === 0 ? "无时间限制" : `${timeout}秒`;
            await client.editMessage(message.peerId, {
              message: message.id,
              text: `✅ 表情包验证超时已设置为 <code>${timeText}</code>`,
              parseMode: "html",
            });
          } else {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: `❌ <b>超时时间设置错误</b>\n\n输入的值 <code>${htmlEscape(args[1])}</code> 无效。\n\n<b>正确示例：</b>\n• <code>.pmcaptcha timeout 180</code> - 3分钟(推荐)\n• <code>.pmcaptcha timeout 60</code> - 1分钟(快速)\n• <code>.pmcaptcha timeout 300</code> - 5分钟(宽松)\n• <code>.pmcaptcha timeout 0</code> - 无时间限制\n\n💡 <i>请输入0或正整数（秒数）</i>`,
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
                text: `❌ <b>未知命令:</b> <code>${htmlEscape(arg)}</code>\n\n💡 使用 <code>.pmcaptcha help</code> 查看帮助`,
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
      case "whitelist":
      case "+":
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
                text: `❌ 找不到用户名: <code>@${htmlEscape(arg.slice(1))}</code>`,
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
      case "remove":
      case "rm":
      case "-":
        let delUserId: number;

        if (!args[1]) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `❌ <b>参数缺失</b>\n\n请提供要移除的用户信息。\n\n<b>使用方法：</b>\n• <code>.pmcaptcha del 123456</code> - 移除用户ID\n• <code>.pmcaptcha del 1</code> - 移除白名单第1个用户\n• <code>.pmcaptcha rm 2</code> - 移除白名单第2个用户\n\n💡 <i>使用 .pmcaptcha list 查看白名单序号</i>`,
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
              text: `❌ 序号 <code>${htmlEscape(String(delArgNum))}</code> 不存在，请使用 <code>.pmcaptcha list</code> 查看有效序号`,
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

      case "scan":
      case "rescan":
      case "s":
        await client.editMessage(message.peerId, {
          message: message.id,
          text: "🔄 <b>开始扫描对话</b>\n\n正在获取对话列表...",
          parseMode: "html",
        });
        
        // Manual scan with progress callback
        await scanExistingChats(client, async (progressMsg: string) => {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `🔄 <b>扫描对话中</b>\n\n${progressMsg}`,
            parseMode: "html",
          });
        });
        break;

      case "scan_set": {
        const n = parseInt(args[1] || "0");
        if (n >= 100 && n <= 10000) {
          dbHelpers.setSetting("SCAN_MAX", n);
          await client.editMessage(message.peerId, { message: message.id, text: `✅ 扫描上限已设为 <code>${n}</code>`, parseMode: "html" });
        } else {
          await client.editMessage(message.peerId, { message: message.id, text: "❌ 请输入 100-10000 之间的整数", parseMode: "html" });
        }
        break;
      }

      case "clear":
      case "clearall":
      case "reset":
        if (args[1] !== "confirm") {
          const whitelistCount = db
            .prepare("SELECT COUNT(*) as count FROM pmcaptcha_whitelist")
            .get() as any;
          
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `⚠️ <b>危险操作确认</b>\n\n🗑️ 即将清空所有白名单用户 (<code>${whitelistCount.count}</code> 个)\n\n<b>⚠️ 重要提醒：</b>\n• 所有用户将需要重新验证\n• 此操作无法撤销\n• 建议先备份重要用户ID\n\n<b>确认清空：</b>\n<code>.pmcaptcha clear confirm</code>\n\n<b>取消操作：</b>\n发送其他任意命令`,
            parseMode: "html",
          });
        } else {
          // Clear all whitelist
          try {
            const stmt = db.prepare("DELETE FROM pmcaptcha_whitelist");
            const info = stmt.run();
            
            await client.editMessage(message.peerId, {
              message: message.id,
              text: `✅ <b>白名单清理完成</b>\n\n🗑️ 已删除 <code>${info.changes}</code> 个用户\n\n<b>后续操作建议：</b>\n• 使用 <code>.pmcaptcha scan</code> 重新扫描对话\n• 使用 <code>.pmcaptcha enable</code> 重新启用并扫描\n• 手动添加重要用户到白名单\n\n💡 <i>所有新的私聊用户将需要重新验证</i>`,
              parseMode: "html",
            });
            
            console.log(`[PMCaptcha] Cleared ${info.changes} users from whitelist`);
          } catch (error) {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: `❌ <b>清理失败：</b> ${htmlEscape(String(error))}`,
              parseMode: "html",
            });
          }
        }
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

              const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();
              if (user.username) {
                displayName = `<a href="tg://user?id=${userId}">@${htmlEscape(user.username)}</a>`;
              } else if (fullName) {
                displayName = `<a href="tg://user?id=${userId}">${htmlEscape(fullName)}</a>`;
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
            // 对于没有用户名和昵称的用户，使用 tg://user?id= 链接
            userListText += `<code>[${index
              .toString()
              .padStart(2, "0")}]</code> <a href=\"tg://user?id=${userId}\">用户 ${userId}</a>\n`;
          }
        }

        const totalCount = whitelistUsers.length;
        const moreText =
          totalCount > 15 ? `\n<i>... 还有 ${totalCount - 15} 个用户</i>` : "";

        await client.editMessage(message.peerId, {
          message: message.id,
          text: `📝 <b>白名单用户列表</b> (${totalCount})\n\n${userListText}${moreText}\n\n<b>操作方法:</b>\n· <code>.pmcaptcha del [序号/用户ID]</code> - 移除用户\n· <code>.pmcaptcha check [序号/用户ID]</code> - 检查状态`,
          parseMode: "html",
        });
        break;

      case "enable":
        dbHelpers.setPluginEnabled(true);
        await client.editMessage(message.peerId, {
          message: message.id,
          text: "✅ <b>PMCaptcha 已启用</b>\n\n🔄 正在扫描现有对话...",
          parseMode: "html",
        });
        
        // Auto scan existing chats with progress callback
        await scanExistingChats(client, async (progressMsg: string) => {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `✅ <b>PMCaptcha 已启用</b>\n\n${progressMsg}`,
            parseMode: "html",
          });
        });
        break;

      case "disable":
        dbHelpers.setPluginEnabled(false);
        await client.editMessage(message.peerId, {
          message: message.id,
          text: "⏸️ <b>PMCaptcha 已禁用</b>\n\n插件将不再处理私聊消息验证",
          parseMode: "html",
        });
        break;

      case "delete_report":
      case "deletereport":
      case "dr":
        if (!args[1]) {
          const currentSetting = dbHelpers.getSetting(CONFIG_KEYS.DELETE_AND_REPORT, false);
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `🗑️ <b>双方删除并举报设置</b>\n\n当前状态: ${
              currentSetting ? "✅ 已启用" : "❌ 已禁用"
            }\n\n<b>使用方法:</b>\n• <code>.pmcaptcha delete_report on</code> - 启用\n• <code>.pmcaptcha delete_report off</code> - 禁用\n\n⚠️ <b>注意：</b> 启用后将对违规用户执行：\n• 举报为垃圾信息\n• 删除双方全部对话\n• 拉黑用户`,
            parseMode: "html",
          });
        } else {
          const action = args[1].toLowerCase();
          if (action === "on" || action === "true" || action === "1") {
            dbHelpers.setSetting(CONFIG_KEYS.DELETE_AND_REPORT, true);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "✅ 双方删除并举报已启用\n\n违规用户将被举报、删除对话并拉黑",
              parseMode: "html",
            });
          } else if (action === "off" || action === "false" || action === "0") {
            dbHelpers.setSetting(CONFIG_KEYS.DELETE_AND_REPORT, false);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 双方删除并举报已禁用",
              parseMode: "html",
            });
          } else {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 无效参数，请使用 on 或 off",
              parseMode: "html",
            });
          }
        }
        break;

      case "protection":
      case "protect":
        if (!args[1]) {
          const protectionMode = dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_MODE, false);
          const protectionActive = dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_ACTIVE, false);
          const threshold = dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_THRESHOLD, 20);
          const window = dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_WINDOW, 60000) / 1000;
          
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `🛡️ <b>防护模式设置</b>\n\n<b>功能状态:</b> ${
              protectionMode ? "✅ 已启用" : "❌ 已禁用"
            }\n<b>实时状态:</b> ${
              protectionActive ? "🔴 防护中" : "🟢 正常"
            }\n<b>触发阈值:</b> <code>${threshold}</code> 条/${window}秒\n\n<b>使用方法:</b>\n• <code>.pmcaptcha protection on</code> - 启用\n• <code>.pmcaptcha protection off</code> - 禁用\n• <code>.pmcaptcha protection_set [阈值] [窗口秒]</code> - 设置参数\n\n💡 <i>当1分钟内收到超过阈值的私聊消息时，自动激活防护模式5分钟</i>`,
            parseMode: "html",
          });
        } else {
          const action = args[1].toLowerCase();
          if (action === "on" || action === "true" || action === "1") {
            dbHelpers.setSetting(CONFIG_KEYS.PROTECTION_MODE, true);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "✅ 防护模式已启用\n\n系统将监控消息频率并自动激活防护",
              parseMode: "html",
            });
          } else if (action === "off" || action === "false" || action === "0") {
            dbHelpers.setSetting(CONFIG_KEYS.PROTECTION_MODE, false);
            dbHelpers.setSetting(CONFIG_KEYS.PROTECTION_ACTIVE, false);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 防护模式已禁用",
              parseMode: "html",
            });
          } else {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 无效参数，请使用 on 或 off",
              parseMode: "html",
            });
          }
        }
        break;

      case "protection_set":
      case "protectionset":
      case "ps":
        if (!args[1] || !args[2]) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `⚙️ <b>防护模式参数设置</b>\n\n<b>使用方法:</b>\n<code>.pmcaptcha protection_set [阈值] [窗口秒]</code>\n\n<b>示例:</b>\n• <code>.pmcaptcha protection_set 20 60</code>\n  设置为60秒内超过20条消息触发\n\n<b>推荐值:</b>\n• 严格: 10条/60秒\n• 标准: 20条/60秒 (默认)\n• 宽松: 30条/60秒`,
            parseMode: "html",
          });
        } else {
          const threshold = parseInt(args[1]);
          const window = parseInt(args[2]);
          
          if (threshold > 0 && window > 0) {
            dbHelpers.setSetting(CONFIG_KEYS.PROTECTION_THRESHOLD, threshold);
            dbHelpers.setSetting(CONFIG_KEYS.PROTECTION_WINDOW, window * 1000);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: `✅ 防护模式参数已更新\n\n触发条件: <code>${threshold}</code> 条消息 / <code>${window}</code> 秒`,
              parseMode: "html",
            });
          } else {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: `❌ <b>防护参数设置错误</b>\n\n输入的参数无效：阈值 <code>${htmlEscape(args[1])}</code>，窗口 <code>${htmlEscape(args[2])}</code>\n\n<b>正确示例：</b>\n• <code>.pmcaptcha protection_set 20 60</code> - 60秒内20条消息\n• <code>.pmcaptcha protection_set 10 30</code> - 30秒内10条消息(严格)\n• <code>.pmcaptcha protection_set 30 120</code> - 2分钟内30条消息(宽松)\n\n💡 <i>两个参数都必须是正整数</i>`,
              parseMode: "html",
            });
          }
        }
        break;

      case "block_bots":
      case "blockbots":
        if (!args[1]) {
          const currentSetting = dbHelpers.getSetting(CONFIG_KEYS.BLOCK_BOTS, true);
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `🤖 <b>Bot拦截设置</b>\n\n当前状态: ${
              currentSetting ? "✅ 已启用" : "❌ 已禁用"
            }\n\n<b>使用方法:</b>\n• <code>.pmcaptcha block_bots on</code> - 启用拦截\n• <code>.pmcaptcha block_bots off</code> - 禁用拦截\n\n💡 <i>启用后将自动删除bot发送的私聊消息</i>`,
            parseMode: "html",
          });
        } else {
          const action = args[1].toLowerCase();
          if (action === "on" || action === "true" || action === "1") {
            dbHelpers.setSetting(CONFIG_KEYS.BLOCK_BOTS, true);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "✅ Bot拦截已启用\n\nbot私聊消息将被自动删除",
              parseMode: "html",
            });
          } else if (action === "off" || action === "false" || action === "0") {
            dbHelpers.setSetting(CONFIG_KEYS.BLOCK_BOTS, false);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ Bot拦截已禁用\n\nbot私聊消息将正常显示",
              parseMode: "html",
            });
          } else {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 无效参数，请使用 on 或 off",
              parseMode: "html",
            });
          }
        }
        break;

      case "status":
      case "stat":
      case "info":
      case "i":
        const whitelistCount = db
          .prepare("SELECT COUNT(*) as count FROM pmcaptcha_whitelist")
          .get() as any;
        const challengeCount = activeChallenges.size;
        const groupsSetting = dbHelpers.getSetting(CONFIG_KEYS.GROUPS_COMMON);
        const timeoutSetting = dbHelpers.getSetting(CONFIG_KEYS.STICKER_TIMEOUT, 180);
        const pluginEnabled = dbHelpers.isPluginEnabled();
        const blockBots = dbHelpers.getSetting(CONFIG_KEYS.BLOCK_BOTS, true);
        const deleteReport = dbHelpers.getSetting(CONFIG_KEYS.DELETE_AND_REPORT, false);
        const protectionMode = dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_MODE, false);
        const protectionActive = dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_ACTIVE, false);
        const totalVerified = dbHelpers.getSetting(CONFIG_KEYS.STATS_TOTAL_VERIFIED, 0);
        const totalBlocked = dbHelpers.getSetting(CONFIG_KEYS.STATS_TOTAL_BLOCKED, 0);
        const lastReset = dbHelpers.getSetting(CONFIG_KEYS.STATS_LAST_RESET);

        await client.editMessage(message.peerId, {
          message: message.id,
          text: `📊 <b>PMCaptcha 系统状态</b>\n\n<b>🔧 系统设置:</b>\n• 插件状态: ${
            pluginEnabled ? "✅ 已启用" : "❌ 已禁用"
          }\n• Bot拦截: ${
            blockBots ? "✅ 已启用" : "❌ 已禁用"
          }\n• 双方删除: ${
            deleteReport ? "✅ 已启用" : "❌ 已禁用"
          }\n• 防护模式: ${
            protectionMode ? "✅ 已启用" : "❌ 已禁用"
          } ${
            protectionActive ? "🔴 防护中" : ""
          }\n• 共同群阈值: ${
            groupsSetting !== null
              ? `<code>${groupsSetting}</code> 个群`
              : "<code>已禁用</code>"
          }\n• 验证超时: <code>${
            timeoutSetting === 0 ? "无限制" : `${timeoutSetting}秒`
          }</code>\n\n<b>📈 运行统计:</b>\n• 白名单用户: <code>${
            whitelistCount.count
          }</code> 人\n• 进行中验证: <code>${challengeCount}</code> 人\n• 累计通过: <code>${totalVerified}</code> 人\n• 累计拦截: <code>${totalBlocked}</code> 个\n\n<b>📅 统计时间:</b>\n• 开始: ${lastReset ? new Date(lastReset).toLocaleString("zh-CN") : "未知"}\n• 当前: ${new Date().toLocaleString("zh-CN")}`,
          parseMode: "html",
        });
        break;

      default:
        await client.editMessage(message.peerId, {
          message: message.id,
          text: `❌ 未知命令: <code>${htmlEscape(command)}</code>\n\n使用 <code>.pmcaptcha help</code> 查看帮助信息`,
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
};

class PmcaptchaPlugin extends Plugin {
  description: string = `PMCaptcha - 共同群白名单和表情包验证系统`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    pmcaptcha,
    pmc: pmcaptcha,
  };
  listenMessageHandler?: ((msg: Api.Message) => Promise<void>) | undefined =
    async (msg) => {
      // Check plugin status before processing
      if (!dbHelpers.isPluginEnabled()) return;
      await pmcaptchaMessageListener(msg);
    };
}

export default new PmcaptchaPlugin();

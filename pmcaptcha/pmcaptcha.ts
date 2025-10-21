// Remove Plugin import since we're using object interface
import { Api, TelegramClient } from "telegram";
import path from "path";
import Database from "better-sqlite3";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getEntityWithHash } from "@utils/entityHelpers";
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { sleep } from "telegram/Helpers";
import bigInt from "big-integer";

// Plugin version
const PLUGIN_VERSION = "3.7.0";
const PLUGIN_BUILD = "production";

// Logging levels
enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

// Current log level
let currentLogLevel = LogLevel.INFO;

// Performance metrics
const performanceMetrics = {
  messageProcessed: 0,
  verificationPassed: 0,
  verificationFailed: 0,
  averageResponseTime: 0,
  lastResetTime: Date.now()
};

// Structured logging
function log(level: LogLevel, message: string, data?: any) {
  if (level < currentLogLevel) return;
  
  const timestamp = new Date().toISOString();
  const levelStr = LogLevel[level];
  const prefix = `[PMCaptcha] [${timestamp}] [${levelStr}]`;
  
  if (data) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
  
  // Update metrics if applicable
  if (level === LogLevel.ERROR) {
    performanceMetrics.lastResetTime = Date.now();
  }
}

// Get command prefixes
const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";

// Initialize databases
const pmcaptchaDir = createDirectoryInAssets("pmcaptcha");
const dbPath = path.join(pmcaptchaDir, "pmcaptcha.db");
let db: Database.Database | null = null;

try {
  db = new Database(dbPath);
} catch (error) {
  log(LogLevel.ERROR, "Failed to initialize database", error);
  // Try to reinitialize on error
  try {
    db = new Database(dbPath);
  } catch (retryError) {
    log(LogLevel.ERROR, "Database initialization retry failed", retryError);
  }
}

// Initialize lowdb for configuration
interface ConfigDatabase {
  data: Record<string, any>;
  write: () => Promise<void>;
}
let configDb: ConfigDatabase | null = null;
let configDbReady = false;
const CONFIG_KEYS = {
  ENABLED: "plugin_enabled",
  BLOCK_ALL: "block_all_private",  // 完全禁止私聊
  BLOCK_BOTS: "block_bots", 
  GROUPS_COMMON: "groups_in_common",
  STICKER_TIMEOUT: "sticker_timeout",
  STATS_TOTAL_VERIFIED: "stats_total_verified",
  STATS_TOTAL_BLOCKED: "stats_total_blocked",
  STATS_LAST_RESET: "stats_last_reset",
  DELETE_AND_REPORT: "delete_and_report",
  REPORT_ENABLED: "report_enabled",
  DELETE_FAILED: "delete_failed_verification",
  PROTECTION_MODE: "protection_mode",
  PROTECTION_THRESHOLD: "protection_threshold",
  PROTECTION_WINDOW: "protection_window",
  PROTECTION_ACTIVE: "protection_active",
  PROTECTION_ACTIVATED_AT: "protection_activated_at"
};

const DEFAULT_CONFIG = {
  [CONFIG_KEYS.ENABLED]: true,
  [CONFIG_KEYS.BLOCK_ALL]: false,  // 默认关闭完全禁止
  [CONFIG_KEYS.BLOCK_BOTS]: true,
  [CONFIG_KEYS.GROUPS_COMMON]: 1,
  [CONFIG_KEYS.STICKER_TIMEOUT]: 180,
  [CONFIG_KEYS.STATS_TOTAL_VERIFIED]: 0,
  [CONFIG_KEYS.STATS_TOTAL_BLOCKED]: 0,
  [CONFIG_KEYS.STATS_LAST_RESET]: new Date().toISOString(),
  [CONFIG_KEYS.DELETE_AND_REPORT]: false,
  [CONFIG_KEYS.REPORT_ENABLED]: false,
  [CONFIG_KEYS.DELETE_FAILED]: true,
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
    configDb = await JSONFilePreset(configPath, DEFAULT_CONFIG) as ConfigDatabase;
    configDbReady = true;
    log(LogLevel.INFO, "Configuration database initialized");
  } catch (error) {
    log(LogLevel.ERROR, "Failed to initialize config database", error);
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

// Auto-scan existing chats on plugin startup
let autoScanCompleted = false;
async function performAutoScan(client: TelegramClient) {
  // Wait for config DB to be ready
  if (!(await waitForConfigDb(10000))) {
    console.error("[PMCaptcha] Config DB not ready for auto-scan");
    return;
  }
  
  // Only scan if plugin is enabled
  if (!dbHelpers.isPluginEnabled()) {
    return;
  }
  
  // Prevent multiple scans
  if (autoScanCompleted) {
    return;
  }
  
  autoScanCompleted = true;
  console.log("[PMCaptcha] Starting background auto-scan...");
  
  try {
    await scanExistingChats(client, undefined, true); // Silent scan
    console.log("[PMCaptcha] Background auto-scan completed");
  } catch (error) {
    console.error("[PMCaptcha] Auto-scan failed:", error);
  }
}

// Prepared statement cache
const preparedStatements: Record<string, any> = {};

// Initialize prepared statements
function initPreparedStatements() {
  if (!db) return;
  try {
    preparedStatements.checkWhitelist = db.prepare(
      "SELECT 1 FROM pmcaptcha_whitelist WHERE user_id = ?"
    );
    preparedStatements.addWhitelist = db.prepare(
      "INSERT OR IGNORE INTO pmcaptcha_whitelist (user_id) VALUES (?)"
    );
    preparedStatements.removeWhitelist = db.prepare(
      "DELETE FROM pmcaptcha_whitelist WHERE user_id = ?"
    );
    preparedStatements.getChallenge = db.prepare(
      "SELECT * FROM pmcaptcha_challenges WHERE user_id = ?"
    );
    preparedStatements.setChallenge = db.prepare(
      "INSERT OR REPLACE INTO pmcaptcha_challenges (user_id, challenge_type, start_time, timeout) VALUES (?, ?, ?, ?)"
    );
    preparedStatements.removeChallenge = db.prepare(
      "DELETE FROM pmcaptcha_challenges WHERE user_id = ?"
    );
    preparedStatements.countWhitelist = db.prepare(
      "SELECT COUNT(*) as count FROM pmcaptcha_whitelist"
    );
    preparedStatements.listWhitelist = db.prepare(
      "SELECT user_id FROM pmcaptcha_whitelist ORDER BY added_at DESC"
    );
    preparedStatements.listWhitelistOrdered = db.prepare(
      "SELECT user_id FROM pmcaptcha_whitelist ORDER BY user_id"
    );
  } catch (error) {
    console.error("[PMCaptcha] Failed to prepare statements:", error);
  }
}

// Initialize database tables
if (db) {
  try {
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
  } catch (error) {
    console.error("[PMCaptcha] Failed to create database tables:", error);
  }
  
  // Initialize prepared statements after tables are created
  initPreparedStatements();
}

// Type definitions
interface WhitelistRow {
  user_id: number;
  added_at?: number;
}

interface ChallengeRow {
  user_id: number;
  challenge_type: string;
  start_time: number;
  timeout: number;
}

interface CountRow {
  count: number;
}

// HTML escape helper with input validation
function htmlEscape(text: string): string {
  // Validate input
  if (typeof text !== 'string') {
    text = String(text || '');
  }
  // Limit length for safety
  if (text.length > 10000) {
    text = text.substring(0, 10000) + '...';
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Get user ID by index from whitelist with validation
function getUserIdByIndex(index: number): number | null {
  // Input validation
  if (!Number.isInteger(index) || index < 1 || index > 9999) {
    return null;
  }
  if (!db) return null;
  try {
    const whitelistUsers = db
      .prepare("SELECT user_id FROM pmcaptcha_whitelist ORDER BY user_id")
      .all() as WhitelistRow[];
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
    // Validate userId to prevent injection
    if (!db || !userId || userId <= 0 || !Number.isInteger(userId)) return false;
    try {
      const stmt = preparedStatements.checkWhitelist || 
        db.prepare("SELECT 1 FROM pmcaptcha_whitelist WHERE user_id = ?");
      const row = stmt.get(userId);
      return !!row;
    } catch (error) {
      console.error(`[PMCaptcha] Failed to check whitelist for ${userId}:`, error);
      return false;
    }
  },

  addToWhitelist: (userId: number) => {
    // Validate userId to prevent injection
    if (!db || !userId || userId <= 0 || !Number.isInteger(userId)) return;
    try {
      const stmt = preparedStatements.addWhitelist || 
        db.prepare("INSERT OR IGNORE INTO pmcaptcha_whitelist (user_id) VALUES (?)");
      stmt.run(userId);
    } catch (error) {
      console.error(`[PMCaptcha] Failed to add ${userId} to whitelist:`, error);
    }
  },

  removeFromWhitelist: (userId: number) => {
    // Validate userId to prevent injection  
    if (!db || !userId || userId <= 0 || !Number.isInteger(userId)) return;
    try {
      const stmt = preparedStatements.removeWhitelist || 
        db.prepare("DELETE FROM pmcaptcha_whitelist WHERE user_id = ?");
      stmt.run(userId);
    } catch (error) {
      console.error(`[PMCaptcha] Failed to remove ${userId} from whitelist:`, error);
    }
  },

  getChallengeState: (userId: number) => {
    // Validate userId to prevent injection
    if (!db || !userId || userId <= 0 || !Number.isInteger(userId)) return null;
    try {
      const row = db
        .prepare("SELECT * FROM pmcaptcha_challenges WHERE user_id = ?")
        .get(userId) as ChallengeRow | undefined;
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
    // Validate all inputs
    if (!db || !userId || userId <= 0 || !Number.isInteger(userId)) return;
    if (!challengeType || typeof challengeType !== 'string') return;
    if (!Number.isInteger(timeout) || timeout < 0) return;
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
    retryCount: number;  // 添加重试计数器
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

// Store cleanup handlers
const cleanupHandlers: (() => void)[] = [];

// Register cleanup
function registerCleanup() {
  const exitHandler = () => {
    try {
      clearInterval(challengeCleanupInterval);
      clearInterval(trackerCleanupInterval);
      activeChallenges.forEach(challenge => {
        if (challenge.timer) clearTimeout(challenge.timer);
      });
      activeChallenges.clear();
      messageTracker.clear();
      // Close database connections
      if (db) {
        try {
          db.close();
        } catch (e) {
          console.error("[PMCaptcha] Error closing database:", e);
        }
      }
    } catch (error) {
      console.error("[PMCaptcha] Cleanup error:", error);
    }
  };
  
  // Register multiple handlers for different exit scenarios
  process.on('exit', exitHandler);
  process.on('SIGINT', exitHandler);
  process.on('SIGTERM', exitHandler);
  process.on('uncaughtException', (error) => {
    console.error("[PMCaptcha] Uncaught exception:", error);
    exitHandler();
  });
  
  cleanupHandlers.push(exitHandler);
}

registerCleanup();

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
    const peer = await client.getInputEntity(userId);
    await client.invoke(
      new Api.folders.EditPeerFolders({
        folderPeers: [new Api.InputFolderPeer({ peer, folderId })]
      })
    );
    return true;
  } catch (error) {
    log(LogLevel.ERROR, `Failed to set folder ${folderId} for user ${userId}`, error);
    return false;
  }
}

// Archive conversation
async function archiveConversation(client: TelegramClient, userId: number): Promise<boolean> {
  log(LogLevel.INFO, `Archiving conversation with user ${userId}`);
  return setFolder(client, userId, 1); // 1 = Archive
}

// Mute conversation
async function muteConversation(client: TelegramClient, userId: number): Promise<boolean> {
  try {
    const peer = await client.getInputEntity(userId);
    await client.invoke(
      new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer }),
        settings: new Api.InputPeerNotifySettings({
          muteUntil: 2147483647, // Max int32, effectively forever
          showPreviews: false,
          silent: true
        })
      })
    );
    log(LogLevel.INFO, `Muted conversation with user ${userId}`);
    return true;
  } catch (error) {
    log(LogLevel.ERROR, `Failed to mute conversation with ${userId}`, error);
    return false;
  }
}

// Block all private messages (archive, mute and delete)
async function blockAllPrivateMessage(
  client: TelegramClient,
  userId: number,
): Promise<boolean> {
  try {
    const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

    // 1. 静音对话
    await muteConversation(client, userId);
    await delay(500);

    // 2. 归档对话
    await archiveConversation(client, userId);
    await delay(500);

    // 3. 删除双方消息（不举报）
    try {
      await client.invoke(
        new Api.messages.DeleteHistory({
          justClear: false,
          revoke: true, // 双方删除
          peer: await client.getInputEntity(userId),
          maxId: 0
        })
      );
      log(LogLevel.INFO, `Deleted history for user ${userId}`);
    } catch (delError) {
      log(LogLevel.ERROR, `Failed to delete history for ${userId}`, delError);
    }
    await delay(500);

    // 4. 拉黑用户 (已根据用户要求禁用)
    /*
    await client.invoke(
      new Api.contacts.Block({
        id: await client.getInputEntity(userId)
      })
    );
    */

    log(LogLevel.INFO, `Handled private message from user ${userId} in block_all mode (deleted history).`);
    dbHelpers.updateStats(0, 1); // Still count as a block/interception for stats

    return true;
  } catch (error) {
    log(LogLevel.ERROR, `Failed to block all private messages from ${userId}`, error);
    return false;
  }
}

// Unarchive conversation and enable notifications
async function unarchiveConversation(client: TelegramClient, userId: number): Promise<boolean> {
  log(LogLevel.INFO, `Unarchiving conversation and restoring notifications for user ${userId}`);
  
  try {
    const peer = await client.getInputEntity(userId);

    // Restore notifications first
    await client.invoke(
      new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer }),
        settings: new Api.InputPeerNotifySettings({
          muteUntil: 0, // Unmute
          showPreviews: true, // Show message previews
          sound: new Api.NotificationSoundDefault()
        })
      })
    );
    log(LogLevel.INFO, `Restored notifications for user ${userId}`);
  } catch (error) {
    log(LogLevel.ERROR, `Failed to restore notifications for ${userId}`, error);
  }

  // Move to main folder (unarchive)
  const unarchived = await setFolder(client, userId, 0); // 0 = Main folder (All Chats)
  if (unarchived) {
    log(LogLevel.INFO, `Successfully unarchived conversation with user ${userId}`);
  } else {
    log(LogLevel.WARN, `Failed to unarchive conversation with user ${userId}. It might already be in the main folder.`);
  }
  return unarchived;
}

// Delete and report user (both sides)
async function deleteAndReportUser(
  client: TelegramClient,
  userId: number,
  reason: string = "spam"
): Promise<boolean> {
  try {
    // Check if reporting is enabled
    const reportEnabled = dbHelpers.getSetting(CONFIG_KEYS.REPORT_ENABLED, false);
    
    if (reportEnabled) {
      // Report user for spam
      await client.invoke(
        new Api.account.ReportPeer({
          peer: await client.getInputEntity(userId),
          reason: new Api.InputReportReasonSpam(),
          message: reason
        })
      );
      console.log(`[PMCaptcha] Reported user ${userId} for ${reason}`);
    }
    
    // Delete conversation from both sides using revoke flag
    // This will delete messages for both parties
    await client.invoke(
      new Api.messages.DeleteHistory({
        justClear: false,  // false = delete history, not just clear
        revoke: true,       // true = delete for both sides (双方删除)
        peer: await client.getInputEntity(userId),
        maxId: 0,           // 0 = delete all messages
        minDate: 0,         // 0 = no date limit
        maxDate: 0          // 0 = no date limit
      })
    );
    
    console.log(`[PMCaptcha] Deleted all messages with user ${userId} (both sides)`);
    
    // Block user
    await client.invoke(
      new Api.contacts.Block({
        id: await client.getInputEntity(userId)
      })
    );
    
    console.log(`[PMCaptcha] Blocked user ${userId}`);
    dbHelpers.updateStats(0, 1);
    
    return true;
  } catch (error) {
    console.error(`[PMCaptcha] Failed to delete and block user ${userId}:`, error);
    return false;
  }
}

// Check if user is an official verified bot
async function isOfficialVerifiedBot(
  client: TelegramClient,
  userId: number
): Promise<boolean> {
  try {
    const entity = await getEntityWithHash(client, userId);
    
    const userFull = await client.invoke(
      new Api.users.GetFullUser({ id: entity })
    );
    const user = userFull.users[0] as Api.User;
    
    // 检查是否为官方认证的机器人
    if (user.bot && user.verified) {
      log(LogLevel.INFO, `User ${userId} is an official verified bot`);
      return true;
    }
    
    return false;
  } catch (error) {
    log(LogLevel.ERROR, `Failed to check if user ${userId} is official verified bot`, error);
    return false;
  }
}

// Check if conversation is in saved messages folder
async function isInSavedMessagesFolder(
  client: TelegramClient,
  userId: number
): Promise<boolean> {
  try {
    // 获取用户的文件夹信息
    const dialogs = await client.invoke(
      new Api.messages.GetDialogs({
        offsetDate: 0,
        offsetId: 0,
        offsetPeer: new Api.InputPeerEmpty(),
        limit: 200,
        hash: bigInt(0),
        excludePinned: false,
        folderId: undefined, // 主文件夹
      })
    );

    if (dialogs instanceof Api.messages.Dialogs || dialogs instanceof Api.messages.DialogsSlice) {
      for (const dialog of dialogs.dialogs) {
        if (dialog instanceof Api.Dialog) {
          // 检查是否为目标用户的对话
          const peer = dialog.peer;
          if (peer instanceof Api.PeerUser && Number(peer.userId) === userId) {
            // 检查是否在收藏夹（文件夹ID为1通常是收藏夹）
            if (dialog.folderId === 1) {
              log(LogLevel.INFO, `User ${userId} conversation is in saved messages folder`);
              return true;
            }
          }
        }
      }
    }
    
    return false;
  } catch (error) {
    log(LogLevel.ERROR, `Failed to check if user ${userId} is in saved messages folder`, error);
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
    
    // 深度检查用户状态
    if (user.bot) {
      console.log(`[PMCaptcha] User ${userId} is a bot`);
      return false;
    }
    
    if (user.deleted) {
      console.log(`[PMCaptcha] User ${userId} is deleted`);
      return false;
    }
    
    if (user.fake) {
      console.log(`[PMCaptcha] User ${userId} is fake`);
      return false;
    }
    
    if (user.scam) {
      console.log(`[PMCaptcha] User ${userId} is scam`);
      return false;
    }
    
    // 检查用户是否被限制
    if ((user as any).restricted) {
      console.log(`[PMCaptcha] User ${userId} is restricted`);
      return false;
    }
    
    return true;
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
    let entity;
    try {
      entity = await getEntityWithHash(client, userId);
    } catch (err) {
      log(LogLevel.WARN, `Could not get entity for ${userId} in checkCommonGroups`, err);
      return false;
    }
    
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

// Handle Flood Wait errors
async function handleFloodWait<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error: any) {
    if (error.message?.includes("FLOOD_WAIT")) {
      const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
      console.log(`[PMCaptcha] Flood wait ${waitTime} seconds`);
      await sleep((waitTime + 1) * 1000);
      try {
        return await operation();
      } catch (retryError) {
        console.error(`[PMCaptcha] Retry failed:`, retryError);
        return null;
      }
    }
    throw error;
  }
}

// Start sticker challenge
async function startStickerChallenge(
  client: TelegramClient,
  userId: number
): Promise<boolean> {
  const timeout = dbHelpers.getSetting(CONFIG_KEYS.STICKER_TIMEOUT, 180) * 1000;

  try {
    // Archive and mute the conversation first
    await archiveConversation(client, userId);
    await muteConversation(client, userId);

    const challengeMsg = await handleFloodWait(async () => 
      await client.sendMessage(userId, {
        message: `🔒 <b>人机验证</b>\n\n👋 您好！为了保护您的账号安全，请完成简单验证：\n\n📌 <b>验证要求：</b>\n发送任意一个 <b>表情包（Sticker）</b>\n\n📖 <b>操作指南：</b>\n1️⃣ 点击输入框旁的 😊 表情图标\n2️⃣ 选择任意表情包发送\n\n⏰ <b>时间限制：</b> ${
          timeout > 0 ? `${timeout / 1000}秒` : "无限制"
        }\n🆘 <b>重试机会：</b> 3次\n\nℹ️ <i>注意：文字、图片、视频等其他内容无效</i>`,
        parseMode: "html",
      })
    );

    if (!challengeMsg) {
        console.error(`[PMCaptcha] Failed to send challenge message to user ${userId}.`);
        return false;
    }

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
        retryCount: 0,  // 初始化重试次数为0
      });
    } else {
      activeChallenges.set(userId, {
        type: "sticker",
        startTime: Date.now(),
        timeout: 0,
        retryCount: 0,  // 初始化重试次数为0
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

  const deleteFailed = dbHelpers.getSetting(CONFIG_KEYS.DELETE_FAILED, true);
  
  if (deleteFailed) {
    console.log(`[PMCaptcha] Challenge timeout for user ${userId}, deleting messages for both sides`);
    
    // Delete and report user for timeout
    await deleteAndReportUser(client, userId, "verification timeout");
  } else {
    console.log(`[PMCaptcha] Challenge timeout for user ${userId}, blocking without deletion`);
    
    // Just block without deleting
    try {
      await client.invoke(
        new Api.contacts.Block({
          id: await client.getInputEntity(userId)
        })
      );
      dbHelpers.updateStats(0, 1);
    } catch (error) {
      console.error(`[PMCaptcha] Failed to block user ${userId}:`, error);
    }
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
  if (!challenge || challenge.type !== "sticker") {
    log(LogLevel.WARN, `No active challenge found for user ${userId}`);
    return false;
  }

  log(LogLevel.INFO, `Verifying sticker response for user ${userId}. Has sticker: ${hasSticker}`);

  if (hasSticker) {
    // Success - add to whitelist
    dbHelpers.addToWhitelist(userId);
    
    // Update statistics
    dbHelpers.updateStats(1, 0);

    // Unarchive conversation and enable notifications
    await unarchiveConversation(client, userId);

    try {
      await client.sendMessage(userId, {
        message: "✅ <b>验证成功</b>\n\n🎉 恭喜！您已成功通过人机验证。\n\n✨ <b>已为您：</b>\n• 解除对话归档\n• 恢复消息通知\n• 加入白名单\n\n现在可以正常发送消息了，祝您使用愉快！",
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
    // Failed - check retry count
    challenge.retryCount++;
    const remainingRetries = 3 - challenge.retryCount;
    log(LogLevel.WARN, `User ${userId} failed verification. Retry count: ${challenge.retryCount}/3`);

    if (remainingRetries > 0) {
      // Still have retries left, send warning message
      try {
        await client.sendMessage(userId, {
          message: `❌ <b>验证失败</b>\n\n您发送的不是表情包（Sticker）！\n\n📌 <b>正确操作步骤：</b>\n1️⃣ 点击输入框旁的 😊 图标\n2️⃣ 选择任意一个表情包发送\n\n⚠️ <b>剩余尝试机会：${remainingRetries}次</b>\n\n❗ 注意：发送文字、图片、GIF等都无效，必须是<b>表情包</b>`,
          parseMode: "html",
        });
      } catch (error) {
        log(LogLevel.ERROR, `Failed to send retry message to user ${userId}`, error);
      }
      
      // Update challenge with new retry count but keep timer
      activeChallenges.set(userId, challenge);
      return false;
    } else {
      // No more retries, execute final action
      log(LogLevel.WARN, `User ${userId} failed verification after 3 retries. Initiating final action.`);
      const deleteFailed = dbHelpers.getSetting(CONFIG_KEYS.DELETE_FAILED, true);
      
      if (deleteFailed) {
        log(LogLevel.INFO, `Final action for ${userId}: Deleting messages and reporting.`);
        await deleteAndReportUser(client, userId, "verification failed - max retries exceeded");
      } else {
        log(LogLevel.INFO, `Final action for ${userId}: Blocking without deletion.`);
        try {
          await client.invoke(
            new Api.contacts.Block({
              id: await client.getInputEntity(userId)
            })
          );
          dbHelpers.updateStats(0, 1);
        } catch (error) {
          log(LogLevel.ERROR, `Failed to block user ${userId} after max retries`, error);
        }
      }
      
      // Clean up
      log(LogLevel.INFO, `Cleaning up challenge state for user ${userId}`);
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
    // Log message structure for debugging
    log(LogLevel.DEBUG, `Checking message for sticker. Message ID: ${message.id}`);
    
    const media: any = (message as any).media;
    if (!media) {
      log(LogLevel.DEBUG, `No media found in message ${message.id}`);
      return false;
    }
    
    log(LogLevel.DEBUG, `Media type: ${media.className || media.constructor?.name}`);
    
    // Check for MessageMediaDocument
    if (media.className === "MessageMediaDocument" || media instanceof Api.MessageMediaDocument) {
      const doc: any = media.document;
      if (!doc) {
        log(LogLevel.DEBUG, `No document in media`);
        return false;
      }
      
      const attrs: any[] = (doc.attributes) || [];
      log(LogLevel.DEBUG, `Document has ${attrs.length} attributes`);
      
      for (const attr of attrs) {
        const attrType = attr.className || attr.constructor?.name || attr._;
        log(LogLevel.DEBUG, `Attribute type: ${attrType}`);
        
        if (attrType === "DocumentAttributeSticker" || 
            attr instanceof Api.DocumentAttributeSticker ||
            attr?._ === "documentAttributeSticker") {
          log(LogLevel.INFO, `✅ Sticker detected in message ${message.id}`);
          return true;
        }
      }
    }
    
    log(LogLevel.DEBUG, `No sticker found in message ${message.id}`);
    return false;
  } catch (error) {
    log(LogLevel.ERROR, `Error detecting sticker in message`, error);
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
    const peer = userId;
    const messages = await client.getMessages(peer, {
      limit: 20 // Increase limit to better find outgoing messages
    });

    // If there is at least one message sent by me (out: true),
    // it means I have talked to this user before.
    const hasOutgoingMessage = messages.some(m => m.out);

    if (hasOutgoingMessage) {
      return true;
    }

    // Fallback for cases where only incoming messages exist.
    // Filter out the current message to see if any *other* messages remain.
    const filtered = excludeMessageId
      ? messages.filter((m: any) => Number(m.id) !== Number(excludeMessageId))
      : messages;
    
    // If more than one message exists, it implies a history.
    return filtered.length > 1;

  } catch (error) {
    console.error(`[PMCaptcha] Failed to check chat history with ${userId}:`, error);
    // If we can't check history, assume no history to be safe
    return false;
  }
}

// Scan and whitelist existing chats on enable
async function scanExistingChats(client: TelegramClient, progressCallback?: (msg: string) => Promise<void>, silent: boolean = false) {
  if (!silent) {
    console.log("[PMCaptcha] Starting optimized private chat scan...");
  }
  let scannedCount = 0;
  let whitelistedCount = 0;
  let skipCount = 0;

  try {
    const maxScan = dbHelpers.getSetting("SCAN_MAX", 2000);
    if (progressCallback) {
      await progressCallback(`📊 正在获取所有对话...`);
    }

    const allDialogs: (Api.messages.Dialogs | Api.messages.DialogsSlice)[] = [];
    // Scan main folder (undefined), archive (1), and other custom folders (0-10)
    const folderIds = [undefined, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    for (const folderId of folderIds) {
      try {
        const dialogs = await client.invoke(
          new Api.messages.GetDialogs({
            offsetDate: 0,
            offsetId: 0,
            offsetPeer: new Api.InputPeerEmpty(),
            limit: 200, // Fetch up to 200 dialogs per folder
            hash: bigInt(0),
            excludePinned: false,
            folderId: folderId,
          })
        );
        if (dialogs) {
          allDialogs.push(dialogs as any);
        }
      } catch (e) {
        // 静默处理不存在的文件夹
        if (!silent && folderId !== undefined && folderId <= 1) {
          console.warn(`[PMCaptcha] Could not fetch dialogs for folder ${folderId}:`, e);
        }
      }
    }

    const privateChats: Api.User[] = [];
    const seenUserIds = new Set<string>();

    for (const dialogs of allDialogs) {
      if (dialogs instanceof Api.messages.Dialogs || dialogs instanceof Api.messages.DialogsSlice) {
        for (const user of dialogs.users) {
          if (user instanceof Api.User && !user.bot && !user.deleted && user.id && !seenUserIds.has(user.id.toString())) {
            privateChats.push(user);
            seenUserIds.add(user.id.toString());
          }
        }
      }
    }

    scannedCount = privateChats.length;
    if (!silent) {
      console.log(`[PMCaptcha] Found ${scannedCount} private chats across all folders`);
    }

    if (progressCallback) {
      await progressCallback(`🔍 发现 ${scannedCount} 个私聊对话，正在处理...`);
    }

    let processed = 0;
    for (const user of privateChats) {
      const userId = Number(user.id);
      processed++;

      if (processed % 20 === 0 && progressCallback) {
        await progressCallback(`⚡ 快速处理中: ${processed}/${scannedCount} | 新增: ${whitelistedCount}`);
      }

      if (userId > 0) {
        if (dbHelpers.isWhitelisted(userId)) {
          skipCount++;
        } else {
          try {
            const messages = await client.getMessages(userId, { limit: 1 });
            if (messages.length > 0) {
              dbHelpers.addToWhitelist(userId);
              whitelistedCount++;
              if (!silent) {
                console.log(`[PMCaptcha] Auto-whitelisted user ${userId} (${user.username || user.firstName || 'User'})`);
              }
            }
          } catch (error) {
            // Ignore users where history can't be fetched
          }
        }
      }

      if (processed >= maxScan) {
        if (!silent) {
          console.log(`[PMCaptcha] Reached scan limit: ${maxScan}`);
        }
        break;
      }
    }

    const resultMsg = `✅ 扫描完成\n• 私聊对话: ${scannedCount}\n• 新增白名单: ${whitelistedCount}\n• 已存在: ${skipCount}`;
    if (!silent) {
      console.log(`[PMCaptcha] ${resultMsg}`);
    }

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
  if (!(await waitForConfigDb())) {
    console.error("[PMCaptcha] Config DB not ready, skipping message.");
    return;
  }
  try {
    const client = message.client as TelegramClient;

    // Trigger auto-scan on first message (background)
    if (!autoScanCompleted) {
      setTimeout(() => performAutoScan(client), 1000);
    }

    // Only handle private messages
    if (!message.isPrivate) return;

    // Check if plugin is enabled
    if (!dbHelpers.isPluginEnabled()) return;

    const userId = Number(message.senderId);
    
    // Get the sender entity directly from the message object. This is more reliable.
    const senderEntity = await message.getSender();

    if (!senderEntity) {
        log(LogLevel.ERROR, `CRITICAL: Could not get sender entity from message object for user ${userId}. Aborting operation.`);
        return;
    }
    
    // 🔴 Absolute Highest Priority: Block All Mode Check
    if (dbHelpers.getSetting(CONFIG_KEYS.BLOCK_ALL, false)) {
      if (!message.out) { // Only act on incoming messages
        log(LogLevel.WARN, `Block all mode is active. Blocking user ${userId}.`);
        await blockAllPrivateMessage(client, userId);
      }
      // Stop all further processing if block all mode is on.
      return;
    }

    // Handle outgoing messages to auto-whitelist recipients
    if (message.out) {
      const recipientId = Number((message.peerId as any)?.userId);
      if (recipientId && recipientId > 0 && !dbHelpers.isWhitelisted(recipientId)) {
        dbHelpers.addToWhitelist(recipientId);
        console.log(`[PMCaptcha] Auto-whitelisted recipient ${recipientId} (user initiated chat)`);
      }
      return; // Don't process outgoing messages further
    }

    // From here, we only handle incoming messages
    if (!userId || userId <= 0) return;

    // 🔵 HIGHEST PRIORITY: Check if user is official verified bot or in saved messages folder
    const isOfficialBot = await isOfficialVerifiedBot(client, userId);
    if (isOfficialBot) {
      log(LogLevel.INFO, `Ignoring message from official verified bot ${userId}`);
      return; // 禁止任何反应
    }

    const isInSavedFolder = await isInSavedMessagesFolder(client, userId);
    if (isInSavedFolder) {
      log(LogLevel.INFO, `Ignoring message from saved messages folder user ${userId}`);
      return; // 禁止任何反应
    }

    // PRIORITY 1: Check if user is in an active challenge.
    const activeChallenge = activeChallenges.get(userId);
    if (activeChallenge && activeChallenge.type === "sticker") {
      log(LogLevel.INFO, `User ${userId} is in active challenge, checking response.`);
      const hasSticker = isStickerMessage(message);
      await verifyStickerResponse(client, userId, hasSticker);
      return; // Stop all further processing after verification attempt.
    }

    // PRIORITY 2: Skip if user is already whitelisted.
    if (dbHelpers.isWhitelisted(userId)) {
      return;
    }

    // PRIORITY 3: Auto-whitelist if there's a pre-existing chat history.
    const hasHistory = await hasChatHistory(client, userId, Number(message.id));
    if (hasHistory) {
      dbHelpers.addToWhitelist(userId);
      log(LogLevel.INFO, `Auto-whitelisted user ${userId} (has chat history).`);
      return; // Whitelisted, no need for captcha.
    }

    // PRIORITY 4: Protection Mode Checks.
    const protectionActive = dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_ACTIVE, false);
    if (protectionActive) {
      log(LogLevel.WARN, `Protection mode active, auto-blocking user ${userId}.`);
      await deleteAndReportUser(client, userId, "protection mode - flood");
      return;
    }
    if (trackMessage(userId)) {
      dbHelpers.setSetting(CONFIG_KEYS.PROTECTION_ACTIVE, true);
      dbHelpers.setSetting(CONFIG_KEYS.PROTECTION_ACTIVATED_AT, new Date().toISOString());
      log(LogLevel.WARN, `PROTECTION MODE ACTIVATED! Blocking all new private messages.`);
      await deleteAndReportUser(client, userId, "message flooding");
      const protectionTimer = setTimeout(() => {
        dbHelpers.setSetting(CONFIG_KEYS.PROTECTION_ACTIVE, false);
        log(LogLevel.INFO, `Protection mode deactivated after cooldown.`);
      }, 300000);
      cleanupHandlers.push(() => clearTimeout(protectionTimer));
      return;
    }

    // PRIORITY 5: Other pre-challenge checks (isValidUser, commonGroups).
    const isValid = await isValidUser(client, userId);
    if (!isValid) {
      await handleBotMessage(client, message, userId);
      return;
    }
    if (await checkCommonGroups(client, userId)) {
      return; // User was whitelisted via common groups.
    }

    // PRIORITY 6: Start sticker challenge for new users.
    log(LogLevel.INFO, `Starting sticker challenge for new user ${userId}.`);
    const challengeStarted = await startStickerChallenge(client, userId);
    if (challengeStarted) {
      log(LogLevel.INFO, `Sticker challenge successfully started for user ${userId}.`);
    } else {
      log(LogLevel.ERROR, `Failed to start sticker challenge for user ${userId}.`);
    }
  } catch (error) {
    console.error("[PMCaptcha] Message listener error:", error);
  }
}

// Handle pmc shortcut command
const pmc = async (message: Api.Message) => {
  if (!(await waitForConfigDb())) {
    console.error("[PMCaptcha] Config DB not ready, skipping command.");
    return;
  }
  const client = message.client as TelegramClient;
  const args = message.message.slice(1).split(" ").slice(1);
  const action = args[0]?.toLowerCase();
  
  // pmc on/off 快捷命令
  if (action === "on" || action === "off") {
    const isEnabling = action === "on";
    dbHelpers.setSetting(CONFIG_KEYS.BLOCK_ALL, isEnabling);

    const statusText = isEnabling
      ? "🚫 <b>完全禁止私聊已启用</b>\n\n所有私聊消息将被静音、归档并删除"
      : "✅ <b>完全禁止私聊已关闭</b>\n\n恢复正常验证模式";

    try {
      // Send a temporary message and then delete it after a short delay
      const tempMsg = await client.sendMessage(message.peerId, {
        message: statusText,
        parseMode: "html",
      });

      // Delete the original command message
      await message.delete();

      // Delete the status message after 3 seconds
      setTimeout(async () => {
        try {
          await tempMsg.delete();
        } catch (e) {
          // Ignore if message is already deleted
        }
      }, 3000);

    } catch (error) {
      console.error(`[PMCaptcha] Failed to execute pmc command:`, error);
    }
    return;
  }
  
  // 其他情况调用主命令处理
  return pmcaptcha(message);
};

const pmcaptcha = async (message: Api.Message) => {
  if (!(await waitForConfigDb())) {
    console.error("[PMCaptcha] Config DB not ready, skipping command.");
    return;
  }
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
          text: help_text,
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
            text: `⏰ <b>表情包验证超时设置</b>\n\n当前设置: <code>${currentTimeout}</code> 秒\n\n<b>使用方法:</b>\n• <code>.pmcaptcha timeout [秒数]</code> - 设置超时时间\n• <code>.pmcaptcha timeout 0</code> - 无时间限制\n• <code>.pmcaptcha timeout 180</code> - 恢复默认(180秒)\n\n<b>建议值:</b>\n• 快速验证: 60-120秒\n• 标准验证: 180秒 (默认)\n• 宽松验证: 300-600秒\n\n💡 <i>用户需要在指定时间内发送表情包完成验证 • 超时将自动失败</i>`,
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
          if (!db) {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 数据库未初始化",
              parseMode: "html",
            });
            break;
          }
          const whitelistCount = db
            .prepare("SELECT COUNT(*) as count FROM pmcaptcha_whitelist")
            .get() as CountRow;
          
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `⚠️ <b>危险操作确认</b>\n\n🗑️ 即将清空所有白名单用户 (<code>${whitelistCount.count}</code> 个)\n\n<b>⚠️ 重要提醒：</b>\n• 所有用户将需要重新验证\n• 此操作无法撤销\n• 建议先备份重要用户ID\n\n<b>确认清空：</b>\n<code>.pmcaptcha clear confirm</code>\n\n<b>取消操作：</b>\n发送其他任意命令`,
            parseMode: "html",
          });
        } else {
          // Clear all whitelist
          if (!db) {
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 数据库未初始化",
              parseMode: "html",
            });
            break;
          }
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
        if (!db) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: "❌ 数据库未初始化",
            parseMode: "html",
          });
          break;
        }
        const whitelistUsers = db
          .prepare("SELECT user_id FROM pmcaptcha_whitelist ORDER BY added_at DESC")
          .all() as WhitelistRow[];
        const totalCount = whitelistUsers.length;

        if (totalCount === 0) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `📝 <b>白名单用户列表</b>\n\n<i>暂无用户</i>\n\n使用 <code>.pmcaptcha add</code> 添加用户到白名单`,
            parseMode: "html",
          });
          break;
        }

        // 构建用户列表文本
        let userListText = `📝 <b>白名单用户列表</b> (共 ${totalCount} 人)\n\n`;
        
        // 使用折叠模式显示所有用户
        userListText += `<blockquote expandable>`;
        
        const maxDisplay = Math.min(whitelistUsers.length, 200); // 最多显示200个

        for (let i = 0; i < maxDisplay; i++) {
          const row = whitelistUsers[i];
          const userId = row.user_id;
          let displayLine = "";

          try {
            const entity = await getEntityWithHash(client, userId);
            if (entity) {
              const userFull = await client.invoke(
                new Api.users.GetFullUser({ id: entity })
              );
              const user = userFull.users[0] as any;

              // 构建显示格式：序号. 昵称 | @用户名 | [打开聊天]
              const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();
              const username = user.username ? `@${user.username}` : "";
              
              // 优先显示昵称
              if (fullName) {
                displayLine = `${i + 1}. ${htmlEscape(fullName)}`;
              } else {
                displayLine = `${i + 1}. User${userId}`;
              }
              
              // 添加用户名（如果有）
              if (username) {
                displayLine += ` | ${htmlEscape(username)}`;
              }
              
              // 添加跳转链接
              displayLine += ` | <a href="tg://user?id=${userId}">打开聊天</a>`;
            } else {
              // 无法获取用户信息时的显示
              displayLine = `${i + 1}. ID: ${userId} | <a href="tg://user?id=${userId}">打开聊天</a>`;
            }
          } catch (e) {
            // 获取失败时只显示ID和链接
            displayLine = `${i + 1}. ID: ${userId} | <a href="tg://user?id=${userId}">打开聊天</a>`;
          }
          
          userListText += displayLine + "\n";
        }
        
        // 关闭折叠标签
        userListText += `</blockquote>`;
        
        // 如果超过最大显示数量，显示剩余数量
        if (totalCount > maxDisplay) {
          userListText += `\n<i>... 还有 ${totalCount - maxDisplay} 个用户未显示</i>\n`;
        }
        
        // 添加操作说明
        userListText += `\n<b>操作方法：</b>\n`;
        userListText += `• <code>.pmcaptcha del [序号/用户ID]</code> - 移除用户\n`;
        userListText += `• <code>.pmcaptcha check [序号/用户ID]</code> - 检查状态`;

        await client.editMessage(message.peerId, {
          message: message.id,
          text: userListText,
          parseMode: "html",
        });
        break;

      case "block_all":
      case "blockall":
      case "ba":
        if (!args[1]) {
          const currentSetting = dbHelpers.getSetting(CONFIG_KEYS.BLOCK_ALL, false);
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `🚫 <b>完全禁止私聊设置</b>\n\n当前状态: ${
              currentSetting ? "✅ 已启用" : "❌ 已禁用"
            }\n\n<b>使用方法:</b>\n• <code>.pmcaptcha block_all on</code> - 启用\n• <code>.pmcaptcha block_all off</code> - 禁用\n• <code>.pmc on/off</code> - 快捷命令\n\n⚠️ <b>重要说明：</b>\n启用后将禁止所有私聊（包括白名单），新消息会被静音、归档并删除`,
            parseMode: "html",
          });
        } else {
          const action = args[1].toLowerCase();
          if (action === "on" || action === "true" || action === "1") {
            dbHelpers.setSetting(CONFIG_KEYS.BLOCK_ALL, true);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "🚫 <b>完全禁止私聊已启用</b>\n\n所有私聊消息将被静音、归档并删除",
              parseMode: "html",
            });
          } else if (action === "off" || action === "false" || action === "0") {
            dbHelpers.setSetting(CONFIG_KEYS.BLOCK_ALL, false);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "✅ <b>完全禁止私聊已关闭</b>\n\n恢复正常验证模式",
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

      case "report":
      case "report_enable":
        if (!args[1]) {
          const currentSetting = dbHelpers.getSetting(CONFIG_KEYS.REPORT_ENABLED, false);
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `📢 <b>举报功能设置</b>\n\n当前状态: ${
              currentSetting ? "✅ 已启用" : "❌ 已禁用"
            }\n\n<b>使用方法:</b>\n• <code>.pmcaptcha report on</code> - 启用举报\n• <code>.pmcaptcha report off</code> - 禁用举报\n\n💡 <i>启用后将对违规用户进行举报</i>`,
            parseMode: "html",
          });
        } else {
          const action = args[1].toLowerCase();
          if (action === "on" || action === "true" || action === "1") {
            dbHelpers.setSetting(CONFIG_KEYS.REPORT_ENABLED, true);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "✅ 举报功能已启用\n\n违规用户将被举报为垃圾信息",
              parseMode: "html",
            });
          } else if (action === "off" || action === "false" || action === "0") {
            dbHelpers.setSetting(CONFIG_KEYS.REPORT_ENABLED, false);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 举报功能已禁用\n\n违规用户将不会被举报",
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

      case "delete_failed":
      case "deletefailed":
      case "df":
        if (!args[1]) {
          const currentSetting = dbHelpers.getSetting(CONFIG_KEYS.DELETE_FAILED, true);
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `🗑️ <b>验证失败双方删除设置</b>\n\n当前状态: ${
              currentSetting ? "✅ 已启用" : "❌ 已禁用"
            }\n\n<b>使用方法:</b>\n• <code>.pmcaptcha delete_failed on</code> - 启用\n• <code>.pmcaptcha delete_failed off</code> - 禁用\n\n⚠️ <b>说明：</b>\n启用后，验证失败时将自动删除双方的全部对话记录`,
            parseMode: "html",
          });
        } else {
          const action = args[1].toLowerCase();
          if (action === "on" || action === "true" || action === "1") {
            dbHelpers.setSetting(CONFIG_KEYS.DELETE_FAILED, true);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "✅ 验证失败双方删除已启用\n\n验证失败时将删除双方全部对话",
              parseMode: "html",
            });
          } else if (action === "off" || action === "false" || action === "0") {
            dbHelpers.setSetting(CONFIG_KEYS.DELETE_FAILED, false);
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 验证失败双方删除已禁用\n\n验证失败时仅拉黑用户",
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

      case "debug":
        if (!args[1]) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `🐛 <b>调试模式设置</b>\n\n当前日志级别: <code>${LogLevel[currentLogLevel]}</code>\n\n<b>使用方法:</b>\n• <code>.pmcaptcha debug on</code> - 启用详细日志\n• <code>.pmcaptcha debug off</code> - 关闭详细日志\n\n💡 <i>启用后可在控制台查看详细的验证过程</i>`,
            parseMode: "html",
          });
        } else {
          const action = args[1].toLowerCase();
          if (action === "on" || action === "true" || action === "1") {
            currentLogLevel = LogLevel.DEBUG;
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "✅ 调试模式已启用\n\n详细日志将输出到控制台",
              parseMode: "html",
            });
          } else if (action === "off" || action === "false" || action === "0") {
            currentLogLevel = LogLevel.INFO;
            await client.editMessage(message.peerId, {
              message: message.id,
              text: "❌ 调试模式已关闭\n\n恢复正常日志级别",
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

      case "test_challenge":
      case "test":
        // Test command to manually check active challenges
        const testUserId = args[1] ? parseInt(args[1]) : Number(message.senderId);
        const testChallenge = activeChallenges.get(testUserId);
        const testDbChallenge = dbHelpers.getChallengeState(testUserId);
        
        let testInfo = `🧪 <b>验证状态测试</b>\n\n`;
        testInfo += `用户ID: <code>${testUserId}</code>\n`;
        testInfo += `内存中的挑战: ${testChallenge ? '✅ 存在' : '❌ 不存在'}\n`;
        testInfo += `数据库中的挑战: ${testDbChallenge ? '✅ 存在' : '❌ 不存在'}\n`;
        testInfo += `白名单状态: ${dbHelpers.isWhitelisted(testUserId) ? '✅ 已加入' : '❌ 未加入'}\n\n`;
        
        if (testChallenge) {
          testInfo += `<b>挑战详情:</b>\n`;
          testInfo += `• 类型: ${testChallenge.type}\n`;
          testInfo += `• 开始时间: ${new Date(testChallenge.startTime).toLocaleString('zh-CN')}\n`;
          testInfo += `• 超时设置: ${testChallenge.timeout}ms\n`;
          testInfo += `• 重试次数: ${testChallenge.retryCount}/3\n`;
          testInfo += `• 计时器: ${testChallenge.timer ? '✅ 运行中' : '❌ 未设置'}\n`;
        }
        
        await client.editMessage(message.peerId, {
          message: message.id,
          text: testInfo,
          parseMode: "html",
        });
        break;

      case "status":
      case "stat":
      case "info":
      case "i":
        const whitelistCountResult = db
          ? (db.prepare("SELECT COUNT(*) as count FROM pmcaptcha_whitelist")
              .get() as CountRow)
          : { count: 0 };
        const challengeCount = activeChallenges.size;
        const groupsSetting = dbHelpers.getSetting(CONFIG_KEYS.GROUPS_COMMON);
        const timeoutSetting = dbHelpers.getSetting(CONFIG_KEYS.STICKER_TIMEOUT, 180);
        const pluginEnabled = dbHelpers.isPluginEnabled();
        const blockAll = dbHelpers.getSetting(CONFIG_KEYS.BLOCK_ALL, false);
        const blockBots = dbHelpers.getSetting(CONFIG_KEYS.BLOCK_BOTS, true);
        const deleteReport = dbHelpers.getSetting(CONFIG_KEYS.DELETE_AND_REPORT, false);
        const reportEnabled = dbHelpers.getSetting(CONFIG_KEYS.REPORT_ENABLED, false);
        const deleteFailed = dbHelpers.getSetting(CONFIG_KEYS.DELETE_FAILED, true);
        const protectionMode = dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_MODE, false);
        const protectionActive = dbHelpers.getSetting(CONFIG_KEYS.PROTECTION_ACTIVE, false);
        const totalVerified = dbHelpers.getSetting(CONFIG_KEYS.STATS_TOTAL_VERIFIED, 0);
        const totalBlocked = dbHelpers.getSetting(CONFIG_KEYS.STATS_TOTAL_BLOCKED, 0);
        const lastReset = dbHelpers.getSetting(CONFIG_KEYS.STATS_LAST_RESET);

        await client.editMessage(message.peerId, {
          message: message.id,
          text: `📊 <b>PMCaptcha 系统状态</b>\n\n<b>🔧 系统设置:</b>\n• 插件状态: ${
            pluginEnabled ? "✅ 已启用" : "❌ 已禁用"
          }${
            blockAll ? "\n• 🚫 <b>完全禁止私聊: ✅ 已启用</b>" : ""
          }\n• Bot拦截: ${
            blockBots ? "✅ 已启用" : "❌ 已禁用"
          }\n• 举报功能: ${
            reportEnabled ? "✅ 已启用" : "❌ 已禁用"
          }\n• 验证失败删除: ${
            deleteFailed ? "✅ 已启用" : "❌ 已禁用"
          }\n• 双方删除举报: ${
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
            whitelistCountResult.count
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

// 定义帮助文本常量
const help_text = `🔒 <b>PMCaptcha 验证系统 v${PLUGIN_VERSION}</b> <i>(生产版本)</i>

<b>🛡️ 核心功能</b>
• 🆕 完全禁止私聊模式（pmc on/off）
• 🆕 智能白名单（主动私聊/历史记录自动识别）
• 🆕 启用时自动扫描现有对话（可配置上限）
• 🆕 验证失败自动双方删除消息
• 🆕 举报功能独立开关控制
• 🆕 增强的表情包检测（支持调试模式）
• 用户实体检测（排除bot/假账户）
• 共同群数量自动白名单
• 表情包验证挑战系统
• 防护模式（反消息轰炸）

<b>⚡ 快捷命令</b>
• <code>${mainPrefix}pmc on</code> - 🚫 完全禁止所有私聊
• <code>${mainPrefix}pmc off</code> - ✅ 恢复正常验证

<b>📋 系统控制</b> <i>(简化别名支持)</i>
• <code>${mainPrefix}pmcaptcha enable</code> - 启用插件
• <code>${mainPrefix}pmcaptcha disable</code> - 禁用插件
• <code>${mainPrefix}pmcaptcha block_all [on|off]</code> - 完全禁止私聊 | 别名: <code>ba</code>
• <code>${mainPrefix}pmcaptcha scan</code> - 手动扫描 | 别名: <code>s</code>
• <code>${mainPrefix}pmcaptcha scan_set [数量]</code> - 设置扫描上限
• <code>${mainPrefix}pmcaptcha block_bots [on|off]</code> - Bot拦截开关
• <code>${mainPrefix}pmcaptcha report [on|off]</code> - 举报功能开关
• <code>${mainPrefix}pmcaptcha delete_failed [on|off]</code> - 验证失败双方删除
• <code>${mainPrefix}pmcaptcha delete_report [on|off]</code> - 双方删除举报
• <code>${mainPrefix}pmcaptcha protection [on|off]</code> - 防护模式开关
• <code>${mainPrefix}pmcaptcha debug [on|off]</code> - 🐛 调试模式（查看详细日志）

<b>📋 验证设置</b>
• <code>${mainPrefix}pmcaptcha groups [数量]</code> - 共同群阈值 | 别名: <code>g</code>
• <code>${mainPrefix}pmcaptcha timeout [秒数]</code> - 验证超时 | 别名: <code>t</code>

<b>📋 白名单管理</b> <i>(快捷操作)</i>
• <code>${mainPrefix}pmcaptcha add [ID/@用户]</code> - 添加白名单 | 别名: <code>+</code>
• <code>${mainPrefix}pmcaptcha del [ID/序号]</code> - 移除白名单 | 别名: <code>-</code>
• <code>${mainPrefix}pmcaptcha check [ID/序号]</code> - 检查用户状态
• <code>${mainPrefix}pmcaptcha clear confirm</code> - ⚠️ 清空白名单(需确认)
• <code>${mainPrefix}pmcaptcha list</code> - 显示白名单列表

<b>📊 状态查看</b>
• <code>${mainPrefix}pmcaptcha status</code> - 系统状态统计 | 别名: <code>i</code>
• <code>${mainPrefix}pmcaptcha help</code> - 显示帮助 | 别名: <code>h</code> <code>?</code>

💡 <i>智能识别 • 安全防护 • 用户友好</i>`;

class PmcaptchaPlugin extends Plugin {
  description: string = `PMCaptcha - 共同群白名单和表情包验证系统\n\n${help_text}`;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    pmcaptcha,
    pmc,  // 使用独立的 pmc 处理函数
  };
  
  listenMessageHandler?: ((msg: Api.Message) => Promise<void>) | undefined =
    async (msg) => {
      // Check plugin status before processing
      if (!dbHelpers.isPluginEnabled()) return;
      await pmcaptchaMessageListener(msg);
    };
}

export default new PmcaptchaPlugin();

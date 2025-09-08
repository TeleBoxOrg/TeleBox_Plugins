import { Plugin } from "@utils/pluginBase";
import path from "path";
import { cronManager } from "@utils/cronManager";
import Database from "better-sqlite3";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getGlobalClient } from "@utils/globalClient";
import { TelegramClient } from "telegram";
import { Api } from "telegram/tl";
import { getEntityWithHash } from "@utils/entityHelpers";
import * as fs from "fs";
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// Configuration file path for random texts
const CONFIG_DIR = createDirectoryInAssets("autochangename");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

interface DynamicNameConfig {
  random_texts: string[];
}

// Load or create config file
function loadConfig(): DynamicNameConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("[AutoChangeName] Error loading config:", error);
  }

  // Default config
  const defaultConfig: DynamicNameConfig = {
    random_texts: [],
  };
  saveConfig(defaultConfig);
  return defaultConfig;
}

function saveConfig(config: DynamicNameConfig): void {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  } catch (error) {
    console.error("[AutoChangeName] Error saving config:", error);
  }
}

// Initialize database
let db = new Database(
  path.join(createDirectoryInAssets("autochangename"), "autochangename.db")
);

// Initialize database tables
if (db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS autochangename_settings (
        user_id INTEGER PRIMARY KEY,
        timezone TEXT DEFAULT 'Asia/Shanghai',
        original_first_name TEXT,
        original_last_name TEXT,
        is_enabled INTEGER DEFAULT 0,
        mode TEXT DEFAULT 'time',
        last_update TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("[AutoChangeName] Database table created successfully");
  } catch (error) {
    console.error("[AutoChangeName] Failed to create database table:", error);
    // Try to recreate the table if it exists with wrong schema
    try {
      db.exec(`DROP TABLE IF EXISTS autochangename_settings`);
      db.exec(`
        CREATE TABLE autochangename_settings (
          user_id INTEGER PRIMARY KEY,
          timezone TEXT DEFAULT 'Asia/Shanghai',
          original_first_name TEXT,
          original_last_name TEXT,
          is_enabled INTEGER DEFAULT 0,
          mode TEXT DEFAULT 'time',
          last_update TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log("[AutoChangeName] Database table recreated successfully");
    } catch (recreateError) {
      console.error(
        "[AutoChangeName] Failed to recreate database table:",
        recreateError
      );
    }
  }
}

// HTML escape function
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

interface UserSettings {
  user_id: number;
  timezone: string;
  original_first_name: string | null;
  original_last_name: string | null;
  is_enabled: boolean;
  mode: "time" | "text" | "both";
  last_update: string | null;
  text_index?: number; // Track current text index for sequential display
}

class AutoChangeNameManager {
  private readonly TASK_NAME = "autochangename_update";
  public client: TelegramClient | undefined = undefined;
  public originalNamesRecorded: Set<number> = new Set();
  private userTextIndices: Map<number, number> = new Map(); // Track text index per user

  constructor() {
    this.initializeClient();
  }

  async initializeClient(): Promise<void> {
    try {
      this.client = await getGlobalClient();
      // Removed auto-record, now manual only via save command
    } catch (error) {
      console.error("[AutoChangeName] Failed to initialize client:", error);
    }
  }

  // Manual save current nickname as original
  async saveCurrentNickname(userId: number): Promise<boolean> {
    if (!this.client || !db) return false;

    try {
      // Get fresh current user profile from Telegram
      const me = await this.client.getMe();
      const currentUserId = Number(me.id.toString());

      // Get existing settings if any
      const existingSettings = this.getUserSettings(currentUserId);

      // Clean current profile from any existing time patterns before recording
      const cleanFirstName = this.cleanTimeFromName(me.firstName || "");
      const cleanLastName = this.cleanTimeFromName(me.lastName || "");

      const originalProfile = {
        firstName: cleanFirstName,
        lastName: cleanLastName,
      };

      console.log(
        `[AutoChangeName] Manually saving original name for user ${currentUserId}:`,
        originalProfile
      );

      // Always update with current nickname
      const newSettings: UserSettings = {
        user_id: currentUserId,
        timezone: existingSettings?.timezone || "Asia/Shanghai",
        original_first_name: originalProfile.firstName,
        original_last_name: originalProfile.lastName || null,
        is_enabled: existingSettings?.is_enabled || false,
        mode: existingSettings?.mode || "text",
        last_update: existingSettings?.last_update || null,
      };

      this.saveUserSettings(newSettings);
      this.originalNamesRecorded.add(currentUserId);
      return true;
    } catch (error) {
      console.error("[AutoChangeName] Error saving original name:", error);
      return false;
    }
  }

  getUserSettings(userId: number): UserSettings | null {
    try {
      const tableInfo = db
        .prepare("PRAGMA table_info(autochangename_settings)")
        .all() as any[];
      const hasUserIdColumn = tableInfo.some((col) => col.name === "user_id");

      if (!hasUserIdColumn) {
        console.error(
          "[AutoChangeName] Table schema is invalid, recreating..."
        );
        this.recreateTable();
        return null;
      }

      const stmt = db.prepare(
        "SELECT * FROM autochangename_settings WHERE user_id = ?"
      );
      const result = stmt.get(userId) as any;

      if (!result) return null;

      return {
        user_id: result.user_id,
        timezone: result.timezone,
        original_first_name: result.original_first_name,
        original_last_name: result.original_last_name,
        is_enabled: Boolean(result.is_enabled),
        mode: result.mode || "time",
        last_update: result.last_update,
      };
    } catch (error) {
      console.error("[AutoChangeName] Error getting user settings:", error);
      // Try to recreate table if there's a schema error
      this.recreateTable();
      return null;
    }
  }

  // Recreate database table with correct schema
  recreateTable(): void {
    try {
      db.exec(`DROP TABLE IF EXISTS autochangename_settings`);
      db.exec(`
        CREATE TABLE autochangename_settings (
          user_id INTEGER PRIMARY KEY,
          timezone TEXT DEFAULT 'Asia/Shanghai',
          original_first_name TEXT,
          original_last_name TEXT,
          is_enabled INTEGER DEFAULT 0,
          mode TEXT DEFAULT 'time',
          last_update TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log("[AutoChangeName] Database table recreated successfully");
    } catch (error) {
      console.error("[AutoChangeName] Failed to recreate table:", error);
    }
  }

  // Save user settings to database
  saveUserSettings(settings: UserSettings): void {
    if (!db) return;

    try {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO autochangename_settings 
        (user_id, timezone, original_first_name, original_last_name, is_enabled, mode, last_update)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        settings.user_id,
        settings.timezone,
        settings.original_first_name,
        settings.original_last_name,
        settings.is_enabled ? 1 : 0,
        settings.mode,
        settings.last_update
      );
    } catch (error) {
      console.error("[AutoChangeName] Error saving user settings:", error);
      // Try to recreate table if there's a schema error
      this.recreateTable();
    }
  }

  // Update last update time for a user
  updateLastUpdateTime(userId: number): void {
    if (!db) return;

    try {
      const stmt = db.prepare(`
        UPDATE autochangename_settings 
        SET last_update = datetime('now') 
        WHERE user_id = ?
      `);
      stmt.run(userId);
    } catch (error) {
      console.error("[AutoChangeName] Error updating last_update time:", error);
    }
  }

  // Get current user profile
  async getCurrentProfile(): Promise<{
    firstName: string;
    lastName: string;
  } | null> {
    if (!this.client) return null;

    try {
      const me = await this.client.getMe();
      return {
        firstName: me.firstName || "",
        lastName: me.lastName || "",
      };
    } catch (error) {
      console.error("[AutoChangeName] Error getting current profile:", error);
      return null;
    }
  }

  // Removed time emoji functionality

  // Clean existing time patterns from name
  cleanTimeFromName(name: string): string {
    if (!name) return "";

    // Remove time emojis (🕐-🕧)
    let cleanName = name.replace(/[\u{1F550}-\u{1F567}]/gu, "");

    // Remove time patterns like "15:14", "3:45 PM", etc.
    cleanName = cleanName.replace(/\b\d{1,2}:\d{2}(\s?(AM|PM))?\b/gi, "");

    // Remove duplicate time patterns that might exist
    cleanName = cleanName.replace(/(\d{1,2}:\d{2})\s+\1/g, "$1");

    // Clean up any random text that might have been added before
    const config = loadConfig();
    if (config.random_texts.length > 0) {
      config.random_texts.forEach((text) => {
        // Escape special regex characters in the text
        const escapedText = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        cleanName = cleanName.replace(
          new RegExp(`\s*${escapedText}\s*`, "g"),
          " "
        );
      });
    }

    // Remove extra spaces and trim
    cleanName = cleanName.replace(/\s+/g, " ").trim();

    return cleanName;
  }

  generateNameWithTime(
    originalFirstName: string,
    originalLastName: string | null,
    timezone: string,
    mode: "time" | "text" | "both" = "time"
  ): { firstName: string; lastName: string | null } {
    try {
      // Clean original names from any existing time patterns
      const cleanFirstName = this.cleanTimeFromName(originalFirstName);
      const cleanLastName = originalLastName
        ? this.cleanTimeFromName(originalLastName)
        : null;

      const now = new Date();
      const timeString = now.toLocaleTimeString("zh-CN", {
        timeZone: timezone,
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      });

      if (mode === "time") {
        // Mode 1: 只显示昵称 时间
        return {
          firstName: `${cleanFirstName} ${timeString}`,
          lastName: cleanLastName,
        };
      } else if (mode === "text") {
        // Mode 2: 只显示 昵称 文案 (handled by generateSequentialTextName)
        return {
          firstName: cleanFirstName,
          lastName: cleanLastName,
        };
      } else {
        // Mode 3: 显示 昵称 文案 时间 (handled by generateSequentialTextName with time)
        return {
          firstName: cleanFirstName,
          lastName: cleanLastName,
        };
      }
    } catch (error) {
      console.error("[AutoChangeName] Error generating name with time:", error);
      return { firstName: originalFirstName, lastName: originalLastName };
    }
  }

  // Reset text index for a user (useful when enabling feature or adding new texts)
  resetTextIndex(userId: number): void {
    this.userTextIndices.set(userId, 0);
  }

  generateSequentialTextName(
    firstName: string,
    lastName: string | null,
    timezone: string,
    userId: number,
    mode: "text" | "both" = "text"
  ): { firstName: string; lastName: string | null } {
    const config = loadConfig();
    if (config.random_texts.length === 0) {
      return { firstName, lastName };
    }

    // Clean the firstName from any existing time patterns first
    const cleanFirstName = this.cleanTimeFromName(firstName);
    const cleanLastName = lastName ? this.cleanTimeFromName(lastName) : null;

    // Get current text index for this user, or initialize to 0
    let currentIndex = this.userTextIndices.get(userId) || 0;

    // Get the text at current index
    const currentText = config.random_texts[currentIndex];

    // Move to next index for next update (wrap around if at end)
    const nextIndex = (currentIndex + 1) % config.random_texts.length;
    this.userTextIndices.set(userId, nextIndex);

    // Get current time for lastName
    const now = new Date();
    const timeString = now.toLocaleTimeString("zh-CN", {
      timeZone: timezone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });

    if (mode === "text") {
      // Mode 2: 只显示 昵称 文案
      return {
        firstName: `${cleanFirstName} ${currentText}`,
        lastName: cleanLastName,
      };
    } else {
      // Mode 3: 显示 昵称 文案 时间
      return {
        firstName: `${cleanFirstName} ${currentText} ${timeString}`,
        lastName: cleanLastName,
      };
    }
  }

  formatTime(timezone: string): string {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return formatter.format(now);
    } catch (error) {
      console.error("[AutoChangeName] Invalid timezone:", timezone);
      // Fallback to UTC+8 (Asia/Shanghai)
      const now = new Date();
      const utc8Time = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      return utc8Time.toTimeString().slice(0, 5);
    }
  }

  async updateProfileName(
    userId: number,
    forceUpdate: boolean = false
  ): Promise<boolean> {
    const settings = this.getUserSettings(userId);
    if (!settings) return false;
    if (!forceUpdate && !settings.is_enabled) return false;

    // Check if client is connected
    if (!this.client?.connected) {
      console.error("[AutoChangeName] Client not connected, skipping update");
      return false;
    }

    if (settings.mode === "time") {
      // Mode 1: 只显示昵称 时间
      const newName = this.generateNameWithTime(
        settings.original_first_name || "",
        settings.original_last_name,
        settings.timezone,
        settings.mode
      );

      // Validate name lengths (Telegram limits)
      if (newName.firstName.length > 64) {
        newName.firstName = newName.firstName.substring(0, 64);
      }
      if (newName.lastName && newName.lastName.length > 64) {
        newName.lastName = newName.lastName.substring(0, 64);
      }

      try {
        await this.client?.invoke(
          new Api.account.UpdateProfile({
            firstName: newName.firstName,
            lastName: newName.lastName || undefined,
          })
        );

        // Update last_update timestamp
        this.updateLastUpdateTime(userId);
        return true;
      } catch (error: any) {
        // Handle rate limiting
        if (error.message?.includes("FLOOD_WAIT")) {
          console.error(
            `[AutoChangeName] Rate limited for user ${userId}, will retry later`
          );
        } else {
          console.error("[AutoChangeName] Error updating profile:", error);
        }
        return false;
      }
    } else if (settings.mode === "text" || settings.mode === "both") {
      // Mode 2 & 3: 文案相关模式
      const config = loadConfig();
      let newName;
      if (config.random_texts.length > 0) {
        // Sequential text display: cycles through texts in order every minute
        newName = this.generateSequentialTextName(
          settings.original_first_name || "",
          settings.original_last_name,
          settings.timezone,
          userId,
          settings.mode
        );
      } else {
        // No texts available, fallback to time mode
        newName = this.generateNameWithTime(
          settings.original_first_name || "",
          settings.original_last_name,
          settings.timezone,
          "time"
        );
      }

      // Validate name lengths (Telegram limits)
      if (newName.firstName.length > 64) {
        newName.firstName = newName.firstName.substring(0, 64);
      }
      if (newName.lastName && newName.lastName.length > 64) {
        newName.lastName = newName.lastName.substring(0, 64);
      }

      try {
        await this.client?.invoke(
          new Api.account.UpdateProfile({
            firstName: newName.firstName,
            lastName: newName.lastName || undefined,
          })
        );

        // Update last_update timestamp
        this.updateLastUpdateTime(userId);
        return true;
      } catch (error: any) {
        // Handle rate limiting
        if (error.message?.includes("FLOOD_WAIT")) {
          console.error(
            `[AutoChangeName] Rate limited for user ${userId}, will retry later`
          );
        } else {
          console.error("[AutoChangeName] Error updating profile:", error);
        }
        return false;
      }
    }

    return false;
  }

  startAutoUpdate(): void {
    // Remove existing task if any
    if (cronManager.has(this.TASK_NAME)) {
      cronManager.del(this.TASK_NAME);
    }

    // Update every minute at 0 seconds (more precise timing)
    cronManager.set(this.TASK_NAME, "0 * * * * *", async () => {
      // Prevent overlapping updates
      if (this.isUpdating) {
        console.log(
          "[AutoChangeName] Skipping update - previous update still in progress"
        );
        return;
      }

      this.isUpdating = true;
      try {
        await this.performAutoUpdate();
      } finally {
        this.isUpdating = false;
      }
    });

    console.log("[AutoChangeName] Auto-update job started via cronManager");
  }

  private isUpdating: boolean = false;

  stopAutoUpdate(): void {
    if (cronManager.has(this.TASK_NAME)) {
      cronManager.del(this.TASK_NAME);
    }
  }

  // Perform auto update for all enabled users
  async performAutoUpdate(): Promise<void> {
    const users = this.getAllEnabledUsers();

    // Use Promise.allSettled for better error handling and parallel execution
    const updatePromises = users.map((userId: number) =>
      this.updateProfileName(userId).catch((error) => {
        console.error(
          `[AutoChangeName] Failed to update for user ${userId}:`,
          error
        );
        return false;
      })
    );

    await Promise.allSettled(updatePromises);
  }

  // Get all enabled users from database
  getAllEnabledUsers(): number[] {
    if (!db) return [];

    try {
      const stmt = db.prepare(
        "SELECT user_id FROM autochangename_settings WHERE is_enabled = 1"
      );
      const results = stmt.all() as any[];
      return results.map((r) => r.user_id);
    } catch (error) {
      console.error("[AutoChangeName] Error getting enabled users:", error);
      return [];
    }
  }

  getStatus(includeInactive: boolean = false): {
    user_id: number;
    timezone: string;
    is_enabled: boolean;
    mode: string;
  }[] {
    if (!db) return [];

    try {
      const query = includeInactive
        ? "SELECT user_id, timezone, is_enabled, mode FROM autochangename_settings"
        : "SELECT user_id, timezone, is_enabled, mode FROM autochangename_settings WHERE is_enabled = 1";

      const stmt = db.prepare(query);
      return stmt.all() as {
        user_id: number;
        timezone: string;
        is_enabled: boolean;
        mode: string;
      }[];
    } catch (error) {
      console.error("[AutoChangeName] Error getting status:", error);
      return [];
    }
  }

  getCommonTimezones(): string[] {
    return [
      "Asia/Shanghai",
      "Asia/Tokyo",
      "Asia/Seoul",
      "Asia/Hong_Kong",
      "Asia/Singapore",
      "Asia/Taipei",
      "Asia/Bangkok",
      "Asia/Jakarta",
      "Asia/Manila",
      "Asia/Kuala_Lumpur",
      "Europe/London",
      "Europe/Paris",
      "Europe/Berlin",
      "Europe/Rome",
      "Europe/Madrid",
      "Europe/Amsterdam",
      "Europe/Brussels",
      "Europe/Vienna",
      "Europe/Zurich",
      "Europe/Stockholm",
      "America/New_York",
      "America/Los_Angeles",
      "America/Chicago",
      "America/Denver",
      "America/Phoenix",
      "America/Toronto",
      "America/Vancouver",
      "America/Montreal",
      "Australia/Sydney",
      "Australia/Melbourne",
      "Australia/Brisbane",
      "Australia/Perth",
      "Pacific/Auckland",
      "UTC",
    ];
  }

  isSchedulerRunning(): boolean {
    return cronManager.has(this.TASK_NAME);
  }
}

// Create global manager instance
const autoChangeNameManager = new AutoChangeNameManager();

const help_text = `动态昵称插件 - 自动在昵称中显示时间或随机文本

基础命令:
• <code>${mainPrefix}autochangename save    </code> - 保存当前昵称为原始昵称
• <code>${mainPrefix}autochangename on/off  </code> - 开启/关闭功能
• <code>${mainPrefix}autochangename mode    </code> - 切换显示模式 (time/text/both)

文本管理:
• <code>${mainPrefix}autochangename text add [内容]</code> - 添加随机文本
• <code>${mainPrefix}autochangename text del [序号]</code> - 删除指定文本
• <code>${mainPrefix}autochangename text clear   </code> - 清空所有文本
• <code>${mainPrefix}autochangename list         </code> - 查看文本列表

高级设置:
• <code>${mainPrefix}autochangename tz [时区]</code> - 设置时区
• <code>${mainPrefix}autochangename status  </code> - 查看系统状态
• <code>${mainPrefix}autochangename update  </code> - 立即更新昵称
• <code>${mainPrefix}autochangename reset   </code> - 恢复原始昵称`;

const fn = async (msg: any) => {
  const text = msg.message || "";
  const args = text.trim().split(/\s+/);
  let showHelp = false;

  // 检查帮助参数并获取实际命令参数
  const cmdArgs = args.slice(1);
  for (const arg of cmdArgs) {
    if (arg === "help" || arg === "h") {
      showHelp = true;
      break;
    }
  }
  const filteredArgs = cmdArgs.filter((arg: string) => arg !== "help" && arg !== "h");

  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
    return;
  }

  if (showHelp) {
    await msg.edit({
      text: help_text,
      parseMode: "html",
      linkPreview: false,
    });
    return;
  }

  const userId = Number(msg.senderId?.toString());
  if (!userId) {
    await msg.edit({
      text: `❌ <b>参数错误:</b> 无法获取用户ID\n\n💡 使用 <code>${mainPrefix}autochangename help</code> 查看帮助`,
      parseMode: "html",
    });
    return;
  }

  const subCmd = filteredArgs[0] || "";

  console.log(
    `[AutoChangeName] Processing command: ${subCmd} from user: ${userId}`
  );

  if (!subCmd) {
    await msg.edit({
      text: `❌ <b>参数错误:</b> 请指定子命令\n\n💡 使用 <code>${mainPrefix}autochangename help</code> 查看帮助`,
      parseMode: "html",
    });
    return;
  }

  // Removed auto-record - now manual only via save command

  // Handle different commands based on subcommand
  if (subCmd === "on" || subCmd === "enable" || subCmd === "start") {
    // Toggle dynamic name functionality
    await msg.edit({ text: "⏳ 正在处理..." });

    let settings = autoChangeNameManager.getUserSettings(userId);

    if (!settings) {
      // First time setup - use recorded original profile or get current profile
      let originalProfile = null;

      // Try to get recorded original name first
      const existingRecord = autoChangeNameManager.getUserSettings(userId);
      if (existingRecord && existingRecord.original_first_name) {
        originalProfile = {
          firstName: existingRecord.original_first_name,
          lastName: existingRecord.original_last_name || null,
        };
      } else {
        // Fallback to current profile and clean it
        const currentProfile = await autoChangeNameManager.getCurrentProfile();
        if (!currentProfile) {
          await msg.edit({ text: "❌ 无法获取当前用户资料，请重试。" });
          return;
        }

        // Clean current profile from any existing time patterns
        originalProfile = {
          firstName: autoChangeNameManager.cleanTimeFromName(
            currentProfile.firstName
          ),
          lastName: currentProfile.lastName
            ? autoChangeNameManager.cleanTimeFromName(currentProfile.lastName)
            : null,
        };
      }

      settings = {
        user_id: userId,
        timezone: "Asia/Shanghai",
        original_first_name: originalProfile.firstName,
        original_last_name: originalProfile.lastName || null,
        is_enabled: true,
        mode: "time" as "time" | "text" | "both",
        last_update: null,
      };
    } else {
      settings.is_enabled = !settings.is_enabled;
    }

    autoChangeNameManager.saveUserSettings(settings);

    if (settings.is_enabled) {
      // Reset text index when enabling
      autoChangeNameManager.resetTextIndex(userId);

      // Perform immediate update
      const success = await autoChangeNameManager.updateProfileName(userId);

      if (success) {
        await msg.edit({
          text: `✅ <b>动态昵称已启用</b>

🕐 当前时区: <code>${settings.timezone}</code>
📝 显示模式: <code>${settings.mode}</code>
⏰ 更新频率: 每分钟

使用其他命令管理设置：
• <code>${mainPrefix}autochangename mode</code> - 切换显示模式
• <code>${mainPrefix}autochangename text add</code> - 管理随机文本`,
          parseMode: "html",
        });
      } else {
        await msg.edit({ text: "❌ 启用失败，请检查权限或稍后重试。" });
      }
    } else {
      await msg.edit({
        text: "✅ <b>动态昵称已禁用</b>\n\n使用 <code>${mainPrefix}autochangename on</code> 重新启用",
        parseMode: "html",
      });
    }
    return;
  }

  if (subCmd === "mode") {
    // Toggle between text and status mode
    await msg.edit({ text: "⏳ 正在处理..." });

    const settings = autoChangeNameManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: `❌ 请先使用 <code>${mainPrefix}autochangename on</code> 命令启用动态昵称功能。`,
        parseMode: "html",
      });
      return;
    }

    // Cycle through three modes: time -> text -> both -> time
    if (settings.mode === "time") {
      settings.mode = "text";
    } else if (settings.mode === "text") {
      settings.mode = "both";
    } else {
      settings.mode = "time";
    }
    autoChangeNameManager.saveUserSettings(settings);

    if (settings.is_enabled) {
      await autoChangeNameManager.updateProfileName(userId);
    }

    await msg.edit({
      text: `✅ <b>显示模式已切换</b>

📝 当前模式: <code>${settings.mode}</code>

模式说明：
1. <code>time</code> - 只显示昵称 时间
2. <code>text</code> - 只显示 昵称 文案
3. <code>both</code> - 显示 昵称 文案 时间`,
      parseMode: "html",
    });
    return;
  }

  if (subCmd === "status") {
    // Show system status
    await msg.edit({ text: "⏳ 正在处理..." });

    const status = autoChangeNameManager.getStatus();
    const isRunning = autoChangeNameManager.isSchedulerRunning();
    const enabledUsers = status.length;

    await msg.edit({
      text: `📊 <b>动态昵称状态</b>\n\n🔄 自动更新: <code>${
        isRunning ? "运行中" : "已停止"
      }</code>\n👥 启用用户: <code>${enabledUsers}</code>\n⏰ 更新频率: <code>每分钟</code>\n\n使用 <code>autochangename help</code> 查看帮助`,
      parseMode: "html",
    });
    return;
  }


  if (subCmd === "text") {
    // Manage random texts
    await msg.edit({ text: "⏳ 正在处理..." });

    const settings = autoChangeNameManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: "❌ 请先使用 <code>autochangename on</code> 命令启用动态昵称功能。",
        parseMode: "html",
      });
      return;
    }

    const action = filteredArgs[1] || "";
    const textArgs = filteredArgs.slice(2);

    const config = loadConfig();

    if (action === "add" && textArgs.length > 0) {
      const newText = textArgs.join(" ");
      config.random_texts.push(newText);
      saveConfig(config);

      // Reset text index when adding new text
      autoChangeNameManager.resetTextIndex(userId);

      await msg.edit({
        text: `<b>✅ 成功添加随机文本</b>\n\n<b>新文本:</b> <code>${htmlEscape(
          newText
        )}</code>\n<b>当前文本数量:</b> ${
          config.random_texts.length
        }\n\n<i>文本将按顺序每分钟自动切换显示</i>`,
        parseMode: "html",
      });
    } else if (action === "del" && textArgs.length > 0) {
      const index = parseInt(textArgs[0]) - 1;
      if (index >= 0 && index < config.random_texts.length) {
        const deletedText = config.random_texts.splice(index, 1)[0];
        saveConfig(config);

        await msg.edit({
          text: `✅ <b>随机文本已删除</b>\n\n📝 删除的文本: <code>${htmlEscape(
            deletedText
          )}</code>\n📊 剩余数量: <code>${config.random_texts.length}</code>`,
          parseMode: "html",
        });
      } else {
        await msg.edit({
          text: "❌ 无效的索引号。使用 <code>namelist</code> 查看所有文本。",
          parseMode: "html",
        });
      }
    } else if (action === "clear") {
      config.random_texts = [];
      saveConfig(config);

      await msg.edit({
        text: "✅ <b>所有随机文本已清空</b>\n\n现在将显示时间而不是随机文本。",
        parseMode: "html",
      });
    } else {
      await msg.edit({
        text: `❌ <b>无效的命令格式</b>\n\n使用方法：\n• <code>autochangename text add 文本内容</code> - 添加随机文本\n• <code>autochangename text del 序号</code> - 删除指定文本\n• <code>autochangename text clear</code> - 清空所有文本\n\n使用 <code>autochangename list</code> 查看所有文本`,
        parseMode: "html",
      });
    }
    return;
  }

  if (subCmd === "list") {
    // List all random texts
    try {
      await msg.edit({ text: "⏳ 正在处理..." });
      console.log("[AutoChangeName] Processing namelist command");

      const config = loadConfig();
      console.log("[AutoChangeName] Config loaded:", config);

      if (config.random_texts.length === 0) {
        await msg.edit({
          text: "📝 <b>随机文本列表</b>\n\n暂无随机文本。\n\n使用 <code>autochangename text add 文本内容</code> 添加随机文本。",
          parseMode: "html",
        });
      } else {
        const textList = config.random_texts
          .map((text, index) => `${index + 1}. ${htmlEscape(text)}`)
          .join("\n");

        await msg.edit({
          text: `📝 <b>随机文本列表</b>\n\n${textList}\n\n📊 总数量: <code>${config.random_texts.length}</code>\n\n使用 <code>autochangename text del 序号</code> 删除指定文本`,
          parseMode: "html",
        });
      }
      console.log("[AutoChangeName] Namelist command completed successfully");
    } catch (error) {
      console.error("[AutoChangeName] Error in namelist command:", error);
      await msg.edit({ text: `❌ 处理失败: ${error}` });
    }
    return;
  }

  // Handle timezone setting
  if (subCmd === "tz" || subCmd === "timezone") {
    await msg.edit({ text: "⏳ 正在处理..." });

    const newTimezone = filteredArgs.slice(1).join(" ");
    if (!newTimezone) {
      const commonTimezones = autoChangeNameManager.getCommonTimezones();
      const timezoneList = commonTimezones
        .map((tz) => `• <code>${tz}</code>`)
        .join("\n");

      await msg.edit({
        text: `🕐 <b>时区设置</b>\n\n请指定时区，例如：\n<code>autochangename tz Asia/Shanghai</code>\n\n常用时区：\n${timezoneList}`,
        parseMode: "html",
      });
      return;
    }

    const settings = autoChangeNameManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: "❌ 请先使用 <code>autochangename on</code> 命令启用动态昵称功能。",
        parseMode: "html",
      });
      return;
    }

    settings.timezone = newTimezone;
    autoChangeNameManager.saveUserSettings(settings);

    // Perform immediate update if enabled
    if (settings.is_enabled) {
      const success = await autoChangeNameManager.updateProfileName(userId);
      if (success) {
        await msg.edit({
          text: `✅ <b>时区已更新</b>\n\n🕐 新时区: <code>${newTimezone}</code>\n⏰ 当前时间: <code>${autoChangeNameManager.formatTime(
            newTimezone
          )}</code>`,
          parseMode: "html",
        });
      } else {
        await msg.edit({
          text: "❌ 时区设置成功，但更新昵称失败。请检查时区格式是否正确。",
        });
      }
    } else {
      await msg.edit({
        text: `✅ <b>时区已更新</b>\n\n🕐 新时区: <code>${newTimezone}</code>\n⏰ 当前时间: <code>${autoChangeNameManager.formatTime(
          newTimezone
        )}</code>\n\n💡 使用 <code>autochangename on</code> 启用动态昵称功能`,
        parseMode: "html",
      });
    }
    return;
  }

  // Handle off/disable command
  if (subCmd === "off" || subCmd === "disable" || subCmd === "stop") {
    const settings = autoChangeNameManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({ text: "❌ 未找到设置，可能尚未启用过自动更新。" });
      return;
    }

    settings.is_enabled = false;
    autoChangeNameManager.saveUserSettings(settings);

    await msg.edit({
      text: `✅ <b>动态昵称已禁用</b>\n\n💡 使用 <code>${mainPrefix}autochangename reset</code> 可恢复原始昵称`,
      parseMode: "html",
    });
    return;
  }

  // Handle reset command
  if (subCmd === "reset") {
    const settings = autoChangeNameManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({ text: "❌ 未找到设置，无法重置。" });
      return;
    }

    try {
      if (!autoChangeNameManager.client) {
        await msg.edit({ text: "❌ 客户端未初始化，请重试。" });
        return;
      }

      await autoChangeNameManager.client.invoke(
        new Api.account.UpdateProfile({
          firstName: settings.original_first_name || "",
          lastName: settings.original_last_name || "",
        })
      );

      settings.is_enabled = false;
      autoChangeNameManager.saveUserSettings(settings);

      await msg.edit({
        text: "✅ <b>已恢复原始昵称并禁用自动更新</b>\n\n原始昵称已恢复，自动更新功能已关闭。",
        parseMode: "html",
      });
    } catch (error) {
      await msg.edit({ text: "❌ 重置失败，请检查权限或稍后重试。" });
    }
    return;
  }

  // Handle save command - manually save current nickname as original
  if (subCmd === "save") {
    await msg.edit({ text: "⏳ 正在保存当前昵称..." });

    const success = await autoChangeNameManager.saveCurrentNickname(userId);
    if (success) {
      const settings = autoChangeNameManager.getUserSettings(userId);
      if (settings) {
        await msg.edit({
          text: `✅ <b>当前昵称已保存为原始昵称</b>\n\n<b>名:</b> <code>${
            settings.original_first_name
          }</code>\n<b>姓:</b> <code>${
            settings.original_last_name || "(空)"
          }</code>\n\n使用 <code>${mainPrefix}autochangename on</code> 启用动态昵称`,
          parseMode: "html",
        });
      } else {
        await msg.edit({ text: "✅ 昵称已保存" });
      }
    } else {
      await msg.edit({ text: "❌ 保存失败，请稍后重试。" });
    }
    return;
  }

  // Handle update command
  if (subCmd === "update" || subCmd === "now") {
    const settings = autoChangeNameManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: `❌ 请先保存原始昵称: <code>${mainPrefix}autochangename save</code>`,
        parseMode: "html",
      });
      return;
    }

    // Force update even if not enabled
    const success = await autoChangeNameManager.updateProfileName(userId, true);
    if (success) {
      const currentTime = autoChangeNameManager.formatTime(settings.timezone);
      await msg.edit({
        text: `✅ <b>昵称已手动更新</b>\n\n🕐 当前时间: <code>${currentTime}</code>\n🌍 时区: <code>${settings.timezone}</code>`,
        parseMode: "html",
      });
    } else {
      await msg.edit({ text: "❌ 更新失败，请检查权限或稍后重试。" });
    }
    return;
  }

  // Unknown command
  await msg.edit({
    text: `❌ <b>未知命令:</b> <code>${subCmd}</code>\n\n使用 <code>${mainPrefix}autochangename help</code> 查看帮助`,
    parseMode: "html",
  });
};

class AutoChangeNamePlugin extends Plugin {
  description: string = help_text;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    autochangename: fn,
    acn: fn,
  };
}

// Auto-start the job when plugin loads (with delay like original)
setTimeout(() => {
  autoChangeNameManager.startAutoUpdate();
}, 2000);

export default new AutoChangeNamePlugin();

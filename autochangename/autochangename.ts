import { Plugin } from "@utils/pluginBase";
import path from "path";
import schedule, { Job } from "node-schedule";
import Database from "better-sqlite3";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getGlobalClient } from "@utils/globalClient";
import { TelegramClient } from "telegram";
import { Api } from "telegram/tl";
import { getEntityWithHash } from "@utils/entityHelpers";

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
          last_update TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log("[AutoChangeName] Database table recreated successfully");
    } catch (recreateError) {
      console.error("[AutoChangeName] Failed to recreate database table:", recreateError);
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

interface AutoChangeNameSettings {
  user_id: number;
  timezone: string;
  original_first_name: string | null;
  original_last_name: string | null;
  is_enabled: boolean;
  last_update: string | null;
}

class AutoChangeNameManager {
  private scheduledJob: Job | undefined = undefined;
  private client: TelegramClient | undefined = undefined;

  constructor() {
    this.initializeClient();
  }

  private async initializeClient(): Promise<void> {
    try {
      this.client = await getGlobalClient();
    } catch (error) {
      console.error("[AutoChangeName] Failed to initialize client:", error);
    }
  }

  // Get user settings from database
  getUserSettings(userId: number): AutoChangeNameSettings | null {
    if (!db) {
      console.error("[AutoChangeName] Database not initialized");
      return null;
    }
    
    try {
      // First check if table exists and has correct schema
      const tableInfo = db.prepare("PRAGMA table_info(autochangename_settings)").all() as any[];
      const hasUserIdColumn = tableInfo.some(col => col.name === 'user_id');
      
      if (!hasUserIdColumn) {
        console.error("[AutoChangeName] Table schema is invalid, recreating...");
        this.recreateTable();
        return null;
      }
      
      const stmt = db.prepare("SELECT * FROM autochangename_settings WHERE user_id = ?");
      const row = stmt.get(userId) as any;
      
      if (!row) return null;
      
      return {
        user_id: row.user_id,
        timezone: row.timezone,
        original_first_name: row.original_first_name,
        original_last_name: row.original_last_name,
        is_enabled: row.is_enabled === 1,
        last_update: row.last_update,
      };
    } catch (error) {
      console.error("[AutoChangeName] Error getting user settings:", error);
      // Try to recreate table if there's a schema error
      this.recreateTable();
      return null;
    }
  }

  // Recreate database table with correct schema
  private recreateTable(): void {
    if (!db) return;
    
    try {
      console.log("[AutoChangeName] Recreating database table...");
      db.exec(`DROP TABLE IF EXISTS autochangename_settings`);
      db.exec(`
        CREATE TABLE autochangename_settings (
          user_id INTEGER PRIMARY KEY,
          timezone TEXT DEFAULT 'Asia/Shanghai',
          original_first_name TEXT,
          original_last_name TEXT,
          is_enabled INTEGER DEFAULT 0,
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
  saveUserSettings(settings: AutoChangeNameSettings): void {
    if (!db) {
      console.error("[AutoChangeName] Database not initialized");
      return;
    }
    
    try {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO autochangename_settings 
        (user_id, timezone, original_first_name, original_last_name, is_enabled, last_update)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        settings.user_id,
        settings.timezone,
        settings.original_first_name,
        settings.original_last_name,
        settings.is_enabled ? 1 : 0,
        settings.last_update
      );
    } catch (error) {
      console.error("[AutoChangeName] Error saving user settings:", error);
      // Try to recreate table if there's a schema error
      this.recreateTable();
    }
  }

  // Get current user profile
  async getCurrentProfile(): Promise<{ firstName: string; lastName: string } | null> {
    if (!this.client) return null;
    
    try {
      const me = await this.client.getMe();
      return {
        firstName: me.firstName || "",
        lastName: me.lastName || "",
      };
    } catch (error) {
      console.error("[AutoChangeName] Failed to get current profile:", error);
      return null;
    }
  }

  // Format time with timezone
  formatTime(timezone: string): string {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      return formatter.format(now);
    } catch (error) {
      console.error("[AutoChangeName] Invalid timezone:", timezone);
      // Fallback to UTC+8 (Asia/Shanghai)
      const now = new Date();
      const utc8Time = new Date(now.getTime() + (8 * 60 * 60 * 1000));
      return utc8Time.toTimeString().slice(0, 5);
    }
  }

  // Generate new name with time
  generateNameWithTime(originalFirstName: string, originalLastName: string | null, timezone: string): { firstName: string; lastName: string } {
    const timeStr = this.formatTime(timezone);
    
    if (originalLastName && originalLastName.trim()) {
      // User has both first and last name - add space and time to last name
      return {
        firstName: originalFirstName,
        lastName: `${originalLastName} ${timeStr}`
      };
    } else {
      // User only has first name - time goes to last name
      return {
        firstName: originalFirstName,
        lastName: timeStr
      };
    }
  }

  // Update user profile name
  async updateProfileName(userId: number): Promise<boolean> {
    if (!this.client) return false;
    
    const settings = this.getUserSettings(userId);
    if (!settings || !settings.is_enabled) return false;
    
    try {
      const newName = this.generateNameWithTime(
        settings.original_first_name || "",
        settings.original_last_name,
        settings.timezone
      );
      
      await this.client.invoke(
        new Api.account.UpdateProfile({
          firstName: newName.firstName,
          lastName: newName.lastName,
        })
      );
      
      // Update last update time
      settings.last_update = new Date().toISOString();
      this.saveUserSettings(settings);
      
      console.log(`[AutoChangeName] Updated profile for user ${userId}: ${newName.firstName} ${newName.lastName}`);
      return true;
    } catch (error) {
      console.error("[AutoChangeName] Failed to update profile:", error);
      return false;
    }
  }

  // Start auto-update job
  startAutoUpdate(): void {
    if (this.scheduledJob) {
      this.scheduledJob.cancel();
    }
    
    // Update every minute at 0 seconds
    this.scheduledJob = schedule.scheduleJob('0 * * * * *', async () => {
      await this.performAutoUpdate();
    });
    
    console.log("[AutoChangeName] Auto-update job started");
  }

  // Stop auto-update job
  stopAutoUpdate(): void {
    if (this.scheduledJob) {
      this.scheduledJob.cancel();
      this.scheduledJob = undefined;
      console.log("[AutoChangeName] Auto-update job stopped");
    }
  }

  // Perform auto-update for all enabled users
  private async performAutoUpdate(): Promise<void> {
    if (!db) return;
    
    try {
      const stmt = db.prepare("SELECT user_id FROM autochangename_settings WHERE is_enabled = 1");
      const users = stmt.all() as { user_id: number }[];
      
      for (const user of users) {
        await this.updateProfileName(user.user_id);
        // Small delay between updates to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error("[AutoChangeName] Error in auto-update:", error);
      // Try to recreate table if there's a schema error
      this.recreateTable();
    }
  }

  // Get status information
  getStatus(): { isRunning: boolean; enabledUsers: number } {
    const isRunning = this.scheduledJob !== undefined;
    let enabledUsers = 0;
    
    if (db) {
      try {
        const stmt = db.prepare("SELECT COUNT(*) as count FROM autochangename_settings WHERE is_enabled = 1");
        const result = stmt.get() as { count: number };
        enabledUsers = result.count;
      } catch (error) {
        console.error("[AutoChangeName] Error getting status:", error);
        this.recreateTable();
      }
    }
    
    return { isRunning, enabledUsers };
  }

  // Get available timezones (common ones)
  getCommonTimezones(): string[] {
    return [
      'Asia/Shanghai',     // UTC+8 中国标准时间
      'Asia/Tokyo',        // UTC+9 日本标准时间
      'Asia/Seoul',        // UTC+9 韩国标准时间
      'Asia/Hong_Kong',    // UTC+8 香港时间
      'Asia/Taipei',       // UTC+8 台北时间
      'Asia/Singapore',    // UTC+8 新加坡时间
      'Europe/London',     // UTC+0/+1 伦敦时间
      'Europe/Paris',      // UTC+1/+2 巴黎时间
      'Europe/Moscow',     // UTC+3 莫斯科时间
      'America/New_York',  // UTC-5/-4 纽约时间
      'America/Los_Angeles', // UTC-8/-7 洛杉矶时间
      'America/Chicago',   // UTC-6/-5 芝加哥时间
      'Australia/Sydney',  // UTC+10/+11 悉尼时间
      'UTC'               // UTC 协调世界时
    ];
  }
}

// Initialize manager
const autoChangeNameManager = new AutoChangeNameManager();

// Auto-start the job when plugin loads
setTimeout(() => {
  autoChangeNameManager.startAutoUpdate();
}, 2000);

const helpMsg = `<b>🕐 自动修改昵称时间显示插件</b>

<b>📋 功能说明:</b>
• 实时在你的姓氏中显示24小时制时间
• 支持自定义时区设置
• 如果你有姓和名，时间会自动空一格添加到姓后面
• 如果你只有名，时间会显示在姓的位置

<b>⚙️ 命令列表:</b>

• <b>启用/禁用:</b>
  <code>autochangename on</code> - 启用自动更新
  <code>autochangename off</code> - 禁用自动更新

• <b>时区设置:</b>
  <code>autochangename tz &lt;时区&gt;</code> - 设置时区
  <code>autochangename tz</code> - 查看当前时区
  <code>autochangename tzlist</code> - 查看支持的时区列表

• <b>状态管理:</b>
  <code>autochangename status</code> - 查看运行状态
  <code>autochangename update</code> - 立即更新一次昵称
  <code>autochangename reset</code> - 恢复原始昵称并禁用

• <b>帮助:</b>
  <code>autochangename</code> 或 <code>autochangename help</code> - 显示此帮助

<b>🌍 常用时区示例:</b>
• <code>Asia/Shanghai</code> - 北京时间 (UTC+8)
• <code>Asia/Tokyo</code> - 东京时间 (UTC+9)
• <code>Europe/London</code> - 伦敦时间 (UTC+0/+1)
• <code>America/New_York</code> - 纽约时间 (UTC-5/-4)

<b>💡 使用提示:</b>
插件会每分钟自动更新一次昵称时间，首次启用时会保存你的原始昵称，禁用后可以恢复。`;

const autoChangeNamePlugin: Plugin = {
  command: ["autochangename", "acn"],
  description: `
自动修改昵称时间显示插件：
- autochangename on/off - 启用/禁用自动更新
- autochangename tz <时区> - 设置时区
- autochangename status - 查看状态
- autochangename update - 立即更新
- autochangename reset - 重置并禁用
  `,
  cmdHandler: async (msg) => {
    try {
      const args = msg.message.slice(1).split(" ").slice(1);
      const userId = Number(msg.senderId?.toString() || "0");
      
      if (userId === 0) {
        await msg.edit({ text: "❌ 无法获取用户ID，请重试。" });
        return;
      }

      // Show help
      if (args.length === 0 || args[0] === "help" || args[0] === "h") {
        await msg.edit({
          text: helpMsg,
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      const cmd = args[0].toLowerCase();

      // Enable auto-update
      if (cmd === "on" || cmd === "enable" || cmd === "start") {
        let settings = autoChangeNameManager.getUserSettings(userId);
        
        if (!settings) {
          // First time setup - get current profile
          const profile = await autoChangeNameManager.getCurrentProfile();
          if (!profile) {
            await msg.edit({ text: "❌ 无法获取当前用户资料，请重试。" });
            return;
          }
          
          settings = {
            user_id: userId,
            timezone: 'Asia/Shanghai',
            original_first_name: profile.firstName,
            original_last_name: profile.lastName || null,
            is_enabled: true,
            last_update: null,
          };
        } else {
          settings.is_enabled = true;
        }
        
        autoChangeNameManager.saveUserSettings(settings);
        
        // Perform immediate update
        const success = await autoChangeNameManager.updateProfileName(userId);
        
        if (success) {
          await msg.edit({
            text: `✅ <b>自动昵称时间已启用</b>\n\n🕐 当前时区: <code>${settings.timezone}</code>\n⏰ 更新频率: 每分钟\n\n使用 <code>autochangename tz &lt;时区&gt;</code> 可更改时区`,
            parseMode: "html",
          });
        } else {
          await msg.edit({ text: "❌ 启用失败，请检查权限或稍后重试。" });
        }
        return;
      }

      // Disable auto-update
      if (cmd === "off" || cmd === "disable" || cmd === "stop") {
        const settings = autoChangeNameManager.getUserSettings(userId);
        if (!settings) {
          await msg.edit({ text: "❌ 未找到设置，可能尚未启用过自动更新。" });
          return;
        }
        
        settings.is_enabled = false;
        autoChangeNameManager.saveUserSettings(settings);
        
        await msg.edit({
          text: "✅ <b>自动昵称时间已禁用</b>\n\n💡 使用 <code>autochangename reset</code> 可恢复原始昵称",
          parseMode: "html",
        });
        return;
      }

      // Reset to original name
      if (cmd === "reset") {
        const settings = autoChangeNameManager.getUserSettings(userId);
        if (!settings) {
          await msg.edit({ text: "❌ 未找到设置，无法重置。" });
          return;
        }
        
        try {
          if (!msg.client) {
            await msg.edit({ text: "❌ 客户端未初始化，请重试。" });
            return;
          }
          
          await msg.client.invoke(
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

      // Set timezone
      if (cmd === "tz" || cmd === "timezone") {
        if (args.length === 1) {
          // Show current timezone
          const settings = autoChangeNameManager.getUserSettings(userId);
          const currentTz = settings?.timezone || 'Asia/Shanghai';
          const currentTime = autoChangeNameManager.formatTime(currentTz);
          
          await msg.edit({
            text: `🌍 <b>当前时区设置</b>\n\n⏰ 时区: <code>${currentTz}</code>\n🕐 当前时间: <code>${currentTime}</code>\n\n使用 <code>autochangename tz &lt;时区&gt;</code> 更改时区\n使用 <code>autochangename tzlist</code> 查看支持的时区`,
            parseMode: "html",
          });
          return;
        }
        
        const newTimezone = args[1];
        let settings = autoChangeNameManager.getUserSettings(userId);
        
        if (!settings) {
          await msg.edit({ text: "❌ 请先启用自动更新功能: <code>autochangename on</code>", parseMode: "html" });
          return;
        }
        
        // Validate timezone by trying to format time
        try {
          const testTime = autoChangeNameManager.formatTime(newTimezone);
          settings.timezone = newTimezone;
          autoChangeNameManager.saveUserSettings(settings);
          
          // Update immediately if enabled
          if (settings.is_enabled) {
            await autoChangeNameManager.updateProfileName(userId);
          }
          
          await msg.edit({
            text: `✅ <b>时区已更新</b>\n\n🌍 新时区: <code>${newTimezone}</code>\n🕐 当前时间: <code>${testTime}</code>`,
            parseMode: "html",
          });
        } catch (error) {
          await msg.edit({
            text: `❌ <b>无效的时区:</b> <code>${htmlEscape(newTimezone)}</code>\n\n使用 <code>autochangename tzlist</code> 查看支持的时区列表`,
            parseMode: "html",
          });
        }
        return;
      }

      // List timezones
      if (cmd === "tzlist" || cmd === "timezones") {
        const timezones = autoChangeNameManager.getCommonTimezones();
        const tzList = timezones.map(tz => {
          const time = autoChangeNameManager.formatTime(tz);
          return `• <code>${tz}</code> - ${time}`;
        }).join('\n');
        
        await msg.edit({
          text: `🌍 <b>支持的时区列表</b>\n\n${tzList}\n\n💡 使用 <code>autochangename tz &lt;时区&gt;</code> 设置时区`,
          parseMode: "html",
        });
        return;
      }

      // Show status
      if (cmd === "status") {
        const status = autoChangeNameManager.getStatus();
        const settings = autoChangeNameManager.getUserSettings(userId);
        
        let statusText = `📊 <b>自动昵称时间状态</b>\n\n`;
        statusText += `🔧 系统状态: ${status.isRunning ? '🟢 运行中' : '🔴 已停止'}\n`;
        statusText += `👥 启用用户: ${status.enabledUsers} 人\n\n`;
        
        if (settings) {
          statusText += `👤 <b>个人设置</b>\n`;
          statusText += `📱 状态: ${settings.is_enabled ? '🟢 已启用' : '🔴 已禁用'}\n`;
          statusText += `🌍 时区: <code>${settings.timezone}</code>\n`;
          statusText += `🕐 当前时间: <code>${autoChangeNameManager.formatTime(settings.timezone)}</code>\n`;
          if (settings.last_update) {
            const lastUpdate = new Date(settings.last_update).toLocaleString('zh-CN');
            statusText += `⏰ 最后更新: ${lastUpdate}\n`;
          }
        } else {
          statusText += `👤 <b>个人设置</b>\n❌ 尚未配置，使用 <code>autochangename on</code> 开始`;
        }
        
        await msg.edit({
          text: statusText,
          parseMode: "html",
        });
        return;
      }

      // Manual update
      if (cmd === "update" || cmd === "now") {
        const settings = autoChangeNameManager.getUserSettings(userId);
        if (!settings) {
          await msg.edit({ text: "❌ 请先启用自动更新功能: <code>autochangename on</code>", parseMode: "html" });
          return;
        }
        
        const success = await autoChangeNameManager.updateProfileName(userId);
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
        text: `❌ <b>未知命令:</b> <code>${htmlEscape(cmd)}</code>\n\n使用 <code>autochangename</code> 查看帮助`,
        parseMode: "html",
      });
    } catch (error: any) {
      console.error("AutoChangeName error:", error);
      await msg.edit({
        text: `❌ 操作失败：${error.message || error}`,
      });
    }
  },
};

export default autoChangeNamePlugin;

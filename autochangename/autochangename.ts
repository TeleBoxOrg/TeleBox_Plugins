/**
 * 自动昵称更新插件 - 自动在昵称中显示时间或随机文本
 * 
 * @author TeleBox Team
 * @version 2.1.0
 * @description 支持定时自动更新昵称，显示时间、随机文本或两者组合
 */

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "telegram";
import { JSONFilePreset } from "lowdb/node";
import { cronManager } from "@utils/cronManager";
import * as path from "path";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文本定义（必需）
const help_text = `🤖 <b>自动昵称更新插件 v2.1</b>

让您的昵称动起来！自动显示时间或个性文案 ⏰

<b>📌 快速开始（按顺序执行）：</b>
1️⃣ <code>${mainPrefix}acn save</code> - 保存您当前的昵称（首次使用必须）
2️⃣ <code>${mainPrefix}acn on</code> - 开启自动更新功能
3️⃣ <code>${mainPrefix}acn mode</code> - 切换显示模式（时间/文案/混合）

<b>🎯 基础命令：</b>
• <code>${mainPrefix}acn help</code> - 显示此帮助信息
• <code>${mainPrefix}acn save</code> - 保存当前昵称为原始昵称
• <code>${mainPrefix}acn on</code> 或 <code>${mainPrefix}acn enable</code> - 开启自动更新
• <code>${mainPrefix}acn off</code> 或 <code>${mainPrefix}acn disable</code> - 关闭自动更新
• <code>${mainPrefix}acn mode</code> - 循环切换显示模式
• <code>${mainPrefix}acn status</code> - 查看当前运行状态

<b>📝 文案管理（让昵称更有个性）：</b>
• <code>${mainPrefix}acn text add 摸鱼中</code> - 添加一条随机文案
• <code>${mainPrefix}acn text add 忙碌中勿扰</code> - 再添加一条
• <code>${mainPrefix}acn text del 1</code> - 删除第1条文案
• <code>${mainPrefix}acn text list</code> - 查看所有文案列表
• <code>${mainPrefix}acn text clear</code> - 清空所有文案

<b>⚙️ 高级设置：</b>
• <code>${mainPrefix}acn tz Asia/Shanghai</code> - 设置为北京时间
• <code>${mainPrefix}acn tz America/New_York</code> - 设置为纽约时间
• <code>${mainPrefix}acn timezone</code> - 查看可用时区列表
• <code>${mainPrefix}acn update</code> 或 <code>${mainPrefix}acn now</code> - 立即更新一次昵称
• <code>${mainPrefix}acn reset</code> - 恢复原始昵称并停止更新

<b>📊 显示模式说明：</b>
• <b>time模式</b>: 张三 09:30
• <b>text模式</b>: 张三 摸鱼中
• <b>both模式</b>: 张三 摸鱼中 09:30

<b>💡 使用技巧：</b>
• 昵称每分钟自动更新一次
• 文案会按添加顺序循环显示
• 支持全球所有标准时区
• 文案最长50字符，建议简短有趣
• 被限流时会自动暂停，无需手动干预

<b>❓ 遇到问题？</b>
• 使用 <code>${mainPrefix}acn status</code> 检查运行状态
• 使用 <code>${mainPrefix}acn reset</code> 重置所有设置
• 重新执行 <code>${mainPrefix}acn save</code> 保存昵称

<b>示例流程：</b>
<code>${mainPrefix}acn save</code>
<code>${mainPrefix}acn text add 工作中</code>
<code>${mainPrefix}acn text add 休息中</code>
<code>${mainPrefix}acn mode</code> (切换到both模式)
<code>${mainPrefix}acn on</code>`;

// 接口定义
interface UserSettings {
  user_id: number;
  timezone: string;
  original_first_name: string | null;
  original_last_name: string | null;
  is_enabled: boolean;
  mode: "time" | "text" | "both";
  last_update: string | null;
  text_index: number;
}

interface ConfigData {
  users: Record<string, UserSettings>;
  random_texts: string[];
}

// 数据库管理器（使用lowdb）
class DataManager {
  private static db: any = null;
  private static initialized = false;
  private static initPromise: Promise<void> | null = null;

  private static async init(): Promise<void> {
    if (this.initialized) return;
    
    // 防止并发初始化
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        const dbPath = path.join(
          createDirectoryInAssets("autochangename"),
          "autochangename.json"
        );

        const defaultData: ConfigData = {
          users: {},
          random_texts: []
        };

        this.db = await JSONFilePreset<ConfigData>(dbPath, defaultData);
        this.initialized = true;
        console.log("[AutoChangeName] 数据库初始化成功");
      } catch (error) {
        console.error("[AutoChangeName] 数据库初始化失败:", error);
        throw error;
      }
    })();

    return this.initPromise;
  }

  static async getUserSettings(userId: number): Promise<UserSettings | null> {
    if (!userId || isNaN(userId)) {
      console.warn("[AutoChangeName] 无效的用户ID:", userId);
      return null;
    }
    
    await this.init();
    if (!this.db) return null;
    
    const userKey = userId.toString();
    return this.db.data.users[userKey] || null;
  }

  static async saveUserSettings(settings: UserSettings): Promise<boolean> {
    if (!settings || !settings.user_id) {
      console.warn("[AutoChangeName] 无效的用户设置");
      return false;
    }
    
    await this.init();
    if (!this.db) return false;

    try {
      const userKey = settings.user_id.toString();
      
      // 深拷贝以防止引用问题
      this.db.data.users[userKey] = JSON.parse(JSON.stringify(settings));
      await this.db.write();
      return true;
    } catch (error) {
      console.error("[AutoChangeName] 保存用户设置失败:", error);
      return false;
    }
  }

  static async getRandomTexts(): Promise<string[]> {
    await this.init();
    if (!this.db) return [];
    return this.db.data.random_texts || [];
  }

  static async saveRandomTexts(texts: string[]): Promise<boolean> {
    await this.init();
    if (!this.db) return false;

    try {
      // 限制文本数量，防止数据过大
      if (texts.length > 100) {
        console.warn("[AutoChangeName] 文本数量超过限制，截断至100条");
        texts = texts.slice(0, 100);
      }
      
      // 过滤和清理文本
      this.db.data.random_texts = texts
        .filter(text => text && typeof text === 'string')
        .map(text => text.trim())
        .filter(text => text.length > 0 && text.length <= 50);
      
      await this.db.write();
      return true;
    } catch (error) {
      console.error("[AutoChangeName] 保存文本失败:", error);
      return false;
    }
  }

  static async getAllEnabledUsers(): Promise<number[]> {
    await this.init();
    if (!this.db) return [];
    
    const users = this.db.data.users;
    return Object.keys(users)
      .filter(key => users[key].is_enabled)
      .map(key => parseInt(key));
  }
}

// 昵称管理器
class NameManager {
  private readonly TASK_NAME = "autochangename_update";
  private static instance: NameManager;
  private isUpdating = false;

  static getInstance(): NameManager {
    if (!NameManager.instance) {
      NameManager.instance = new NameManager();
    }
    return NameManager.instance;
  }

  // 获取当前用户档案（带缓存）
  private profileCache: { data: any; timestamp: number } | null = null;
  private readonly CACHE_TTL = 60000; // 缓存1分钟
  
  async getCurrentProfile(): Promise<{ firstName: string; lastName: string } | null> {
    try {
      // 检查缓存
      if (this.profileCache && Date.now() - this.profileCache.timestamp < this.CACHE_TTL) {
        return this.profileCache.data;
      }
      
      const client = await getGlobalClient();
      if (!client) return null;

      const me = await client.getMe();
      const profile = {
        firstName: me.firstName || "",
        lastName: me.lastName || ""
      };
      
      // 更新缓存
      this.profileCache = {
        data: profile,
        timestamp: Date.now()
      };
      
      return profile;
    } catch (error) {
      console.error("[AutoChangeName] 获取用户档案失败:", error);
      return null;
    }
  }

  // 保存当前昵称为原始昵称
  async saveCurrentNickname(userId: number): Promise<boolean> {
    try {
      const profile = await this.getCurrentProfile();
      if (!profile) return false;

      const cleanFirstName = this.cleanTimeFromName(profile.firstName);
      const cleanLastName = this.cleanTimeFromName(profile.lastName);

      const settings: UserSettings = {
        user_id: userId,
        timezone: "Asia/Shanghai",
        original_first_name: cleanFirstName,
        original_last_name: cleanLastName || null,
        is_enabled: false,
        mode: "time",
        last_update: null,
        text_index: 0
      };

      return await DataManager.saveUserSettings(settings);
    } catch (error) {
      console.error("[AutoChangeName] 保存昵称失败:", error);
      return false;
    }
  }

  // 清理时间模式（优化正则性能）
  private cleanTimeRegex = /\b\d{1,2}:\d{2}(\s?(AM|PM))?\b/gi;
  private clockEmojiRegex = /[\u{1F550}-\u{1F567}]/gu;
  private spaceRegex = /\s+/g;
  
  cleanTimeFromName(name: string): string {
    if (!name || typeof name !== 'string') return "";
    
    // 限制输入长度
    if (name.length > 128) {
      name = name.substring(0, 128);
    }
    
    // 移除时间格式
    let cleanName = name.replace(this.cleanTimeRegex, "");
    // 移除时间表情符号
    cleanName = cleanName.replace(this.clockEmojiRegex, "");
    // 清理多余空格
    return cleanName.replace(this.spaceRegex, " ").trim();
  }

  // 格式化时间
  formatTime(timezone: string): string {
    try {
      const now = new Date();
      // 验证时区是否有效
      const testDate = new Date().toLocaleString("en-US", { timeZone: timezone });
      
      return now.toLocaleTimeString("zh-CN", {
        timeZone: timezone,
        hour12: false,
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch (error) {
      console.error("[AutoChangeName] 无效时区:", timezone, "使用默认时区 Asia/Shanghai");
      try {
        const now = new Date();
        return now.toLocaleTimeString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
          hour: "2-digit",
          minute: "2-digit"
        });
      } catch (fallbackError) {
        // 最后的备用方案
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        return `${hours}:${minutes}`;
      }
    }
  }

  // 生成新昵称
  async generateNewName(settings: UserSettings): Promise<{ firstName: string; lastName: string | null }> {
    const cleanFirstName = settings.original_first_name || "";
    const cleanLastName = settings.original_last_name;
    const currentTime = this.formatTime(settings.timezone);

    if (settings.mode === "time") {
      return {
        firstName: `${cleanFirstName} ${currentTime}`,
        lastName: cleanLastName
      };
    }

    const texts = await DataManager.getRandomTexts();
    if (texts.length === 0) {
      // 无文本时回退到时间模式
      return {
        firstName: `${cleanFirstName} ${currentTime}`,
        lastName: cleanLastName
      };
    }

    const currentText = texts[settings.text_index % texts.length];
    
    if (settings.mode === "text") {
      return {
        firstName: `${cleanFirstName} ${currentText}`,
        lastName: cleanLastName
      };
    } else { // both
      return {
        firstName: `${cleanFirstName} ${currentText} ${currentTime}`,
        lastName: cleanLastName
      };
    }
  }

  // 更新用户昵称
  async updateUserProfile(userId: number, forceUpdate: boolean = false): Promise<boolean> {
    try {
      const client = await getGlobalClient();
      if (!client) {
        console.warn("[AutoChangeName] 客户端未就绪，跳过更新");
        return false;
      }

      const settings = await DataManager.getUserSettings(userId);
      if (!settings) {
        console.warn(`[AutoChangeName] 用户 ${userId} 设置不存在`);
        return false;
      }
      
      if (!forceUpdate && !settings.is_enabled) {
        return false;
      }

      // 检查上次更新时间，避免过于频繁的更新
      if (!forceUpdate && settings.last_update) {
        const lastUpdate = new Date(settings.last_update);
        const now = new Date();
        const timeDiff = now.getTime() - lastUpdate.getTime();
        
        // 如果距离上次更新不足30秒，跳过
        if (timeDiff < 30000) {
          console.log(`[AutoChangeName] 用户 ${userId} 更新过于频繁，跳过`);
          return false;
        }
      }

      const newName = await this.generateNewName(settings);
      
      // 验证长度限制
      if (newName.firstName.length > 64) {
        newName.firstName = newName.firstName.substring(0, 64);
      }
      if (newName.lastName && newName.lastName.length > 64) {
        newName.lastName = newName.lastName.substring(0, 64);
      }

      await client.invoke(
        new Api.account.UpdateProfile({
          firstName: newName.firstName,
          lastName: newName.lastName || undefined
        })
      );

      // 更新文本索引
      if (settings.mode !== "time") {
        const texts = await DataManager.getRandomTexts();
        if (texts.length > 0) {
          settings.text_index = (settings.text_index + 1) % texts.length;
        }
      }

      settings.last_update = new Date().toISOString();
      await DataManager.saveUserSettings(settings);
      
      return true;
    } catch (error: any) {
      if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        console.error(`[AutoChangeName] 用户 ${userId} 被限流，需等待 ${waitTime} 秒`);
        
        // 临时禁用该用户的自动更新，避免持续触发限流
        const settings = await DataManager.getUserSettings(userId);
        if (settings && settings.is_enabled) {
          settings.is_enabled = false;
          await DataManager.saveUserSettings(settings);
          console.log(`[AutoChangeName] 已临时禁用用户 ${userId} 的自动更新`);
        }
      } else if (error.message?.includes("USERNAME_NOT_MODIFIED")) {
        // 昵称未改变，不算错误
        return true;
      } else {
        console.error(`[AutoChangeName] 用户 ${userId} 更新失败:`, error.message || error);
      }
      return false;
    }
  }

  // 启动自动更新
  startAutoUpdate(): void {
    try {
      // 先清理旧任务
      if (cronManager.has(this.TASK_NAME)) {
        cronManager.del(this.TASK_NAME);
      }

      // 创建新的定时任务（每分钟执行一次）
      cronManager.set(this.TASK_NAME, "0 * * * * *", async () => {
        if (this.isUpdating) {
          console.log("[AutoChangeName] 更新任务正在执行中，跳过本次");
          return;
        }
        
        this.isUpdating = true;
        try {
          const enabledUsers = await DataManager.getAllEnabledUsers();
          if (enabledUsers.length === 0) {
            return;
          }
          
          console.log(`[AutoChangeName] 开始更新 ${enabledUsers.length} 个用户的昵称`);
          
          const updatePromises = enabledUsers.map(userId => 
            this.updateUserProfile(userId).catch(error => {
              console.error(`[AutoChangeName] 用户 ${userId} 更新失败:`, error);
              return false;
            })
          );
          
          const results = await Promise.allSettled(updatePromises);
          const successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
          
          if (successCount > 0) {
            console.log(`[AutoChangeName] 成功更新 ${successCount}/${enabledUsers.length} 个用户`);
          }
        } catch (error) {
          console.error("[AutoChangeName] 批量更新时发生错误:", error);
        } finally {
          this.isUpdating = false;
        }
      });

      console.log("[AutoChangeName] 自动更新任务已启动");
    } catch (error) {
      console.error("[AutoChangeName] 启动自动更新失败:", error);
    }
  }

  // 停止自动更新
  stopAutoUpdate(): void {
    if (cronManager.has(this.TASK_NAME)) {
      cronManager.del(this.TASK_NAME);
      console.log("[AutoChangeName] 自动更新任务已停止");
    }
  }
  
  // 清理资源
  cleanup(): void {
    this.stopAutoUpdate();
    this.profileCache = null;
    this.isUpdating = false;
  }

  // 检查调度器状态
  isSchedulerRunning(): boolean {
    return cronManager.has(this.TASK_NAME);
  }
}

// 获取管理器实例（单例模式，防止内存泄漏）
const nameManager = NameManager.getInstance();

// 插件类
class AutoChangeNamePlugin extends Plugin {
  description: string = help_text;

  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    acn: async (msg: Api.Message, trigger?: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      // 标准参数解析
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();

      try {
        // 获取用户ID
        const userId = Number(msg.senderId?.toString());
        if (!userId || isNaN(userId)) {
          await msg.edit({
            text: `❌ <b>无法获取用户ID</b>\n\n💡 使用 <code>${mainPrefix}acn help</code> 查看帮助`,
            parseMode: "html"
          });
          return;
        }

        // 处理帮助
        if (!sub || sub === "help" || sub === "h") {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        // 处理各种命令
        switch (sub) {
          case "save":
            await this.handleSave(msg, userId);
            break;

          case "on":
          case "enable":
            await this.handleToggle(msg, userId, true);
            break;

          case "off":
          case "disable":
            await this.handleToggle(msg, userId, false);
            break;

          case "mode":
            await this.handleMode(msg, userId);
            break;

          case "status":
            await this.handleStatus(msg);
            break;

          case "text":
            await this.handleText(msg, args.slice(1));
            break;

          case "tz":
          case "timezone":
            await this.handleTimezone(msg, userId, args.slice(1));
            break;

          case "update":
          case "now":
            await this.handleUpdate(msg, userId);
            break;

          case "reset":
            await this.handleReset(msg, userId);
            break;

          default:
            await msg.edit({
              text: `❌ <b>未知命令:</b> <code>${htmlEscape(sub)}</code>\n\n💡 使用 <code>${mainPrefix}acn help</code> 查看帮助`,
              parseMode: "html"
            });
        }

      } catch (error: any) {
        console.error("[AutoChangeName] 命令执行失败:", error);
        
        if (error.message?.includes("FLOOD_WAIT")) {
          const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
          await msg.edit({
            text: `⏳ <b>请求过于频繁</b>\n\n需要等待 ${waitTime} 秒后重试`,
            parseMode: "html"
          });
        } else if (error.message?.includes("MESSAGE_ID_INVALID")) {
          console.error("[AutoChangeName] 消息已失效");
        } else {
          const errorMsg = error.message || "未知错误";
          // 限制错误消息长度
          const safeErrorMsg = errorMsg.length > 100 ? errorMsg.substring(0, 100) + "..." : errorMsg;
          await msg.edit({
            text: `❌ <b>操作失败:</b> ${htmlEscape(safeErrorMsg)}`,
            parseMode: "html"
          });
        }
      }
    },

    autochangename: async (msg: Api.Message, trigger?: Api.Message) => {
      // 别名支持
      return this.cmdHandlers.acn(msg, trigger);
    }
  };

  // 处理保存命令
  private async handleSave(msg: Api.Message, userId: number): Promise<void> {
    await msg.edit({ text: "⏳ 正在保存当前昵称...", parseMode: "html" });

    const success = await nameManager.saveCurrentNickname(userId);
    if (success) {
      const settings = await DataManager.getUserSettings(userId);
      if (settings) {
        await msg.edit({
          text: `✅ <b>当前昵称已保存为原始昵称</b>\n\n<b>姓名:</b> <code>${htmlEscape(settings.original_first_name || "")}</code>\n<b>姓氏:</b> <code>${htmlEscape(settings.original_last_name || "(空)")}</code>\n\n使用 <code>${mainPrefix}acn on</code> 启用动态昵称`,
          parseMode: "html"
        });
      } else {
        await msg.edit({ text: "✅ 昵称已保存", parseMode: "html" });
      }
    } else {
      await msg.edit({ text: "❌ 保存失败，请稍后重试", parseMode: "html" });
    }
  }

  // 处理开关命令
  private async handleToggle(msg: Api.Message, userId: number, enable: boolean): Promise<void> {
    await msg.edit({ text: "⏳ 正在处理...", parseMode: "html" });

    let settings = await DataManager.getUserSettings(userId);
    
    if (!settings) {
      if (!enable) {
        await msg.edit({ text: "❌ 未找到设置，请先保存昵称", parseMode: "html" });
        return;
      }

      // 首次使用，自动保存当前昵称
      const saveSuccess = await nameManager.saveCurrentNickname(userId);
      if (!saveSuccess) {
        await msg.edit({ text: "❌ 初始化失败，请先使用 save 命令", parseMode: "html" });
        return;
      }

      settings = await DataManager.getUserSettings(userId);
      if (!settings) {
        await msg.edit({ text: "❌ 获取设置失败", parseMode: "html" });
        return;
      }
    }

    settings.is_enabled = enable;
    const success = await DataManager.saveUserSettings(settings);

    if (success) {
      if (enable) {
        // 确保定时任务已启动
        if (!nameManager.isSchedulerRunning()) {
          nameManager.startAutoUpdate();
        }
        
        // 立即更新昵称
        const updateSuccess = await nameManager.updateUserProfile(userId, true);
        if (updateSuccess) {
          await msg.edit({
            text: `✅ <b>动态昵称已启用</b>\n\n🕐 当前时区: <code>${settings.timezone}</code>\n📝 显示模式: <code>${settings.mode}</code>\n⏰ 更新频率: 每分钟`,
            parseMode: "html"
          });
        } else {
          await msg.edit({ text: "❌ 启用失败，请检查权限", parseMode: "html" });
        }
      } else {
        await msg.edit({
          text: `✅ <b>动态昵称已禁用</b>\n\n使用 <code>${mainPrefix}acn on</code> 重新启用`,
          parseMode: "html"
        });
      }
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  // 处理模式切换
  private async handleMode(msg: Api.Message, userId: number): Promise<void> {
    const settings = await DataManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: `❌ 请先使用 <code>${mainPrefix}acn save</code> 保存昵称`,
        parseMode: "html"
      });
      return;
    }

    // 循环切换模式
    if (settings.mode === "time") {
      settings.mode = "text";
    } else if (settings.mode === "text") {
      settings.mode = "both";
    } else {
      settings.mode = "time";
    }

    await DataManager.saveUserSettings(settings);

    if (settings.is_enabled) {
      await nameManager.updateUserProfile(userId, true);
    }

    await msg.edit({
      text: `✅ <b>显示模式已切换</b>\n\n📝 当前模式: <code>${settings.mode}</code>\n\n模式说明：\n• <code>time</code> - 只显示昵称+时间\n• <code>text</code> - 只显示昵称+文案\n• <code>both</code> - 显示昵称+文案+时间`,
      parseMode: "html"
    });
  }

  // 处理状态查询
  private async handleStatus(msg: Api.Message): Promise<void> {
    const enabledUsers = await DataManager.getAllEnabledUsers();
    const isRunning = nameManager.isSchedulerRunning();

    await msg.edit({
      text: `📊 <b>动态昵称状态</b>\n\n🔄 自动更新: <code>${isRunning ? "运行中" : "已停止"}</code>\n👥 启用用户: <code>${enabledUsers.length}</code>\n⏰ 更新频率: <code>每分钟</code>`,
      parseMode: "html"
    });
  }

  // 处理文本管理
  private async handleText(msg: Api.Message, args: string[]): Promise<void> {
    const action = args[0] || "";
    const texts = await DataManager.getRandomTexts();

    if (action === "add" && args.length > 1) {
      const newText = args.slice(1).join(" ").trim();
      
      // 验证文本长度
      if (newText.length > 50) {
        await msg.edit({
          text: "❌ <b>文本过长</b>\n\n文本长度不能超过50个字符",
          parseMode: "html"
        });
        return;
      }
      
      // 检查重复
      if (texts.includes(newText)) {
        await msg.edit({
          text: "❌ <b>文本已存在</b>\n\n请勿添加重复的文本",
          parseMode: "html"
        });
        return;
      }
      
      texts.push(newText);
      const success = await DataManager.saveRandomTexts(texts);

      if (success) {
        await msg.edit({
          text: `✅ <b>成功添加随机文本</b>\n\n<b>新文本:</b> <code>${htmlEscape(newText)}</code>\n<b>当前文本数量:</b> ${texts.length}`,
          parseMode: "html"
        });
      } else {
        await msg.edit({ text: "❌ 添加失败", parseMode: "html" });
      }

    } else if (action === "del" && args.length > 1) {
      const index = parseInt(args[1]) - 1;
      if (index >= 0 && index < texts.length) {
        const deletedText = texts.splice(index, 1)[0];
        const success = await DataManager.saveRandomTexts(texts);

        if (success) {
          await msg.edit({
            text: `✅ <b>随机文本已删除</b>\n\n📝 删除的文本: <code>${htmlEscape(deletedText)}</code>\n📊 剩余数量: <code>${texts.length}</code>`,
            parseMode: "html"
          });
        } else {
          await msg.edit({ text: "❌ 删除失败", parseMode: "html" });
        }
      } else {
        await msg.edit({ text: "❌ 无效的索引号", parseMode: "html" });
      }

    } else if (action === "list") {
      if (texts.length === 0) {
        await msg.edit({
          text: `📝 <b>随机文本列表</b>\n\n暂无随机文本\n\n使用 <code>${mainPrefix}acn text add 文本内容</code> 添加随机文本`,
          parseMode: "html"
        });
      } else {
        const textList = texts
          .map((text, index) => `${index + 1}. ${htmlEscape(text)}`)
          .join("\n");

        await msg.edit({
          text: `📝 <b>随机文本列表</b>\n\n${textList}\n\n📊 总数量: <code>${texts.length}</code>`,
          parseMode: "html"
        });
      }

    } else if (action === "clear") {
      const success = await DataManager.saveRandomTexts([]);
      if (success) {
        await msg.edit({ text: "✅ 所有随机文本已清空", parseMode: "html" });
      } else {
        await msg.edit({ text: "❌ 清空失败", parseMode: "html" });
      }

    } else {
      await msg.edit({
        text: `❌ <b>无效的命令格式</b>\n\n使用方法：\n• <code>${mainPrefix}acn text add 文本内容</code>\n• <code>${mainPrefix}acn text del 序号</code>\n• <code>${mainPrefix}acn text list</code>\n• <code>${mainPrefix}acn text clear</code>`,
        parseMode: "html"
      });
    }
  }

  // 处理时区设置
  private async handleTimezone(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    if (args.length === 0) {
      const commonTimezones = [
        "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul", "Asia/Hong_Kong",
        "Asia/Singapore", "Europe/London", "Europe/Paris", "Europe/Berlin",
        "America/New_York", "America/Los_Angeles", "America/Chicago", "Australia/Sydney"
      ];
      const timezoneList = commonTimezones.map(tz => `• <code>${tz}</code>`).join("\n");

      await msg.edit({
        text: `🕐 <b>时区设置</b>\n\n请指定时区，例如：\n<code>${mainPrefix}acn tz Asia/Shanghai</code>\n\n常用时区：\n${timezoneList}`,
        parseMode: "html"
      });
      return;
    }

    const settings = await DataManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: `❌ 请先使用 <code>${mainPrefix}acn save</code> 保存昵称`,
        parseMode: "html"
      });
      return;
    }

    const newTimezone = args.join(" ").trim();
    
    // 验证时区是否有效
    try {
      new Date().toLocaleString("en-US", { timeZone: newTimezone });
    } catch (error) {
      await msg.edit({
        text: `❌ <b>无效的时区</b>\n\n<code>${htmlEscape(newTimezone)}</code> 不是有效的时区标识符\n\n请使用标准的IANA时区标识符，如 Asia/Shanghai`,
        parseMode: "html"
      });
      return;
    }
    settings.timezone = newTimezone;
    const success = await DataManager.saveUserSettings(settings);

    if (success) {
      if (settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }

      const currentTime = nameManager.formatTime(newTimezone);
      await msg.edit({
        text: `✅ <b>时区已更新</b>\n\n🕐 新时区: <code>${newTimezone}</code>\n⏰ 当前时间: <code>${currentTime}</code>`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 时区设置失败", parseMode: "html" });
    }
  }

  // 处理立即更新
  private async handleUpdate(msg: Api.Message, userId: number): Promise<void> {
    const settings = await DataManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: `❌ 请先使用 <code>${mainPrefix}acn save</code> 保存昵称`,
        parseMode: "html"
      });
      return;
    }

    const success = await nameManager.updateUserProfile(userId, true);
    if (success) {
      const currentTime = nameManager.formatTime(settings.timezone);
      await msg.edit({
        text: `✅ <b>昵称已手动更新</b>\n\n🕐 当前时间: <code>${currentTime}</code>\n🌍 时区: <code>${settings.timezone}</code>`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 更新失败，请检查权限", parseMode: "html" });
    }
  }

  // 处理重置
  private async handleReset(msg: Api.Message, userId: number): Promise<void> {
    const settings = await DataManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({ text: "❌ 未找到设置", parseMode: "html" });
      return;
    }

    try {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      await client.invoke(
        new Api.account.UpdateProfile({
          firstName: settings.original_first_name || "",
          lastName: settings.original_last_name || undefined
        })
      );

      settings.is_enabled = false;
      await DataManager.saveUserSettings(settings);

      await msg.edit({
        text: "✅ <b>已恢复原始昵称并禁用自动更新</b>",
        parseMode: "html"
      });
    } catch (error) {
      await msg.edit({ text: "❌ 重置失败，请检查权限", parseMode: "html" });
    }
  }

  // 插件初始化
  async init(): Promise<void> {
    try {
      // 初始化数据库（通过调用 getAllEnabledUsers 自动初始化）
      const enabledUsers = await DataManager.getAllEnabledUsers();
      if (enabledUsers.length > 0) {
        nameManager.startAutoUpdate();
        console.log(`[AutoChangeName] 插件已启动，${enabledUsers.length} 个用户已启用自动更新`);
      } else {
        console.log("[AutoChangeName] 插件已启动，暂无用户启用自动更新");
      }
    } catch (error) {
      console.error("[AutoChangeName] 插件初始化失败:", error);
    }
  }

  // 插件销毁
  destroy(): void {
    nameManager.cleanup();
    console.log("[AutoChangeName] 插件已停止并清理资源");
  }
}

// 创建并初始化插件实例
const plugin = new AutoChangeNamePlugin();

// 自动初始化
(async () => {
  try {
    await plugin.init();
  } catch (error) {
    console.error("[AutoChangeName] 自动初始化失败:", error);
  }
})();

// 导出插件实例
export default plugin;

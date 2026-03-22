/**
 * 自动昵称更新插件 v2.2 - 极简模块化重构版
 * @description 支持定时自动更新昵称，显示时间、随机文本或两者组合
 */

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "teleproto";
import { JSONFilePreset } from "lowdb/node";
import { cronManager } from "@utils/cronManager";
import * as path from "path";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


// === 配置与工具函数 ===
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;'}[m] || m));

// 帮助文本定义（必需）
const help_text = `🤖 <b>自动昵称更新插件 v2.2</b>

让您的昵称动起来！自动显示时间或个性文案 ⏰

<b>📌 快速开始（按顺序执行）：</b>
1️⃣ <code>${mainPrefix}acn save</code> - 保存您当前的昵称（首次使用必须）
2️⃣ <code>${mainPrefix}acn on/off</code> - 开启或关闭自动更新功能
3️⃣ <code>${mainPrefix}acn mode</code> - 切换显示模式（时间/文案/混合）

<b>🎯 基础命令：</b>
• <code>${mainPrefix}acn save</code> - 保存当前昵称为原始昵称
• <code>${mainPrefix}acn on/off</code> 或 <code>${mainPrefix}acn enable/disable</code> - 开启或关闭自动更新
• <code>${mainPrefix}acn mode</code> - 循环切换显示模式
• <code>${mainPrefix}acn status</code> - 查看当前运行状态

<b>📝 文案管理（让昵称更有个性）：</b>
• <code>${mainPrefix}acn text add 摸鱼中</code> - 添加一条随机文案
• <code>${mainPrefix}acn text add</code> + 多行歌词 - 支持真正多行文本批量添加
• <code>${mainPrefix}acn text del 1</code> - 删除第1条文案
• <code>${mainPrefix}acn text list</code> - 查看所有文案列表
• <code>${mainPrefix}acn text clear</code> - 清空所有文案

<b>🎨 显示配置（NEW）：</b>
• <code>${mainPrefix}acn emoji on/off</code> - 开启/关闭时钟emoji 🕐
• <code>${mainPrefix}acn showtz on/off</code> - 开启/关闭时区显示 GMT+8
• <code>${mainPrefix}acn tzformat GMT/UTC/city</code> - 设置时区格式(GMT/UTC/城市名/自定义)
• <code>${mainPrefix}acn order</code> - 查看当前显示顺序
• <code>${mainPrefix}acn order name,text,time,emoji</code> - 自定义显示顺序
• <code>${mainPrefix}acn config</code> - 查看所有配置项

<b>⚙️ 高级设置：</b>
• <code>${mainPrefix}acn tz Asia/Shanghai</code> - 设置为北京时间
• <code>${mainPrefix}acn tz America/New_York</code> - 设置为纽约时间
• <code>${mainPrefix}acn timezone</code> - 查看可用时区列表
• <code>${mainPrefix}acn update</code> 或 <code>${mainPrefix}acn now</code> - 立即更新一次昵称
• <code>${mainPrefix}acn reset</code> - 恢复原始昵称并停止更新

<b>📊 显示模式说明（默认只显示时间）：</b>
• <b>time模式</b>: 张三 09:30
• <b>text模式</b>: 张三 摸鱼中
• <b>both模式</b>: 张三 摸鱼中 09:30
• <b>开启emoji/时区后</b>: 张三 09:30 GMT+8 🕐

<b>🔧 自定义显示顺序示例：</b>
• <code>name,text,time,emoji</code> → 张三 摸鱼中 09:30 🕐
• <code>text,time,emoji,name</code> → 摸鱼中 09:30 🕐 张三
• <code>name,emoji,time,text</code> → 张三 🕐 09:30 摸鱼中

<b>💡 使用技巧：</b>
• 昵称每分钟自动更新一次
• 文案会按添加顺序循环显示
• 支持全球所有标准时区
• 文案最长50字符，建议简短有趣
• 被限流时会自动暂停，无需手动干预
• 时钟emoji会根据当前时间显示对应的钟面

<b>❓ 遇到问题？</b>
• 使用 <code>${mainPrefix}acn status</code> 检查运行状态
• 使用 <code>${mainPrefix}acn reset</code> 重置所有设置
• 重新执行 <code>${mainPrefix}acn save</code> 保存昵称

<b>示例流程：</b>
<code>${mainPrefix}acn save</code>
<code>${mainPrefix}acn text add 工作中</code>
<code>${mainPrefix}acn text add 休息中</code>
<code>${mainPrefix}acn emoji on/off</code> (开启或关闭时钟emoji)
<code>${mainPrefix}acn showtz on/off</code> (显示或隐藏时区)
<code>${mainPrefix}acn order text,time,emoji,name</code> (自定义顺序)
<code>${mainPrefix}acn mode</code> (切换到both模式)
<code>${mainPrefix}acn on/off</code>`;

// === 类型定义 ===
interface UserSettings {
  user_id: number;
  timezone: string;
  original_first_name: string | null;
  original_last_name: string | null;
  is_enabled: boolean;
  mode: "time" | "text" | "both";
  last_update: string | null;
  text_index: number;
  show_clock_emoji?: boolean;
  show_timezone?: boolean;
  display_order?: string;
  timezone_format?: string;  // 自定义时区格式："GMT" | "UTC" | "city" | "offset" | "custom:xxx"
}

interface ConfigData {
  users: Record<string, UserSettings>;
  random_texts: string[];
}

// === 数据管理层 ===
class DataManager {
  private static db: any = null;
  private static initPromise: Promise<void> | null = null;

  private static async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const dbPath = path.join(createDirectoryInAssets("autochangename"), "autochangename.json");
      this.db = await JSONFilePreset<ConfigData>(dbPath, { users: {}, random_texts: [] });
      console.log("[AutoChangeName] 数据库初始化成功");
    })();
    
    return this.initPromise;
  }

  static async getUserSettings(userId: number): Promise<UserSettings | null> {
    if (!userId || isNaN(userId)) return null;
    await this.init();
    return this.db?.data.users[userId.toString()] || null;
  }

  static async saveUserSettings(settings: UserSettings): Promise<boolean> {
    if (!settings?.user_id) return false;
    await this.init();
    try {
      this.db.data.users[settings.user_id.toString()] = { ...settings };
      await this.db.write();
      return true;
    } catch { return false; }
  }

  static async getRandomTexts(): Promise<string[]> {
    await this.init();
    return this.db?.data.random_texts || [];
  }

  static async saveRandomTexts(texts: string[]): Promise<boolean> {
    await this.init();
    try {
      this.db.data.random_texts = texts.slice(0, 100)
        .filter(t => t && typeof t === 'string')
        .map(t => t.trim())
        .filter(t => t.length > 0 && t.length <= 50);
      await this.db.write();
      return true;
    } catch { return false; }
  }

  static async getAllEnabledUsers(): Promise<number[]> {
    await this.init();
    const users = this.db?.data.users || {};
    return Object.keys(users)
      .filter(key => users[key].is_enabled)
      .map(key => parseInt(key));
  }
}

// === 昵称管理层 ===
class NameManager {
  private readonly TASK_NAME = "autochangename_update";
  private static instance: NameManager;
  private isUpdating = false;
  private profileCache: { data: any; timestamp: number } | null = null;
  private readonly CACHE_TTL = 60000;

  static getInstance(): NameManager {
    return NameManager.instance ??= new NameManager();
  }

  async getCurrentProfile(): Promise<{ firstName: string; lastName: string } | null> {
    if (this.profileCache && Date.now() - this.profileCache.timestamp < this.CACHE_TTL) {
      return this.profileCache.data;
    }
    
    try {
      const client = await getGlobalClient();
      if (!client) return null;

      const me = await client.getMe();
      const profile = { firstName: me.firstName || "", lastName: me.lastName || "" };
      
      this.profileCache = { data: profile, timestamp: Date.now() };
      return profile;
    } catch {
      return null;
    }
  }

  async saveCurrentNickname(userId: number): Promise<boolean> {
    const profile = await this.getCurrentProfile();
    if (!profile) return false;

    const settings: UserSettings = {
      user_id: userId,
      timezone: "Asia/Shanghai",
      original_first_name: this.cleanTimeFromName(profile.firstName),
      original_last_name: this.cleanTimeFromName(profile.lastName) || null,
      is_enabled: false,
      mode: "time",
      last_update: null,
      text_index: 0,
      show_clock_emoji: false,  // 默认关闭时钟emoji
      show_timezone: false,     // 默认关闭时区显示  
      timezone_format: "GMT",  // 默认时区格式
      display_order: "name,time"  // 默认只显示姓名和时间
    };

    return await DataManager.saveUserSettings(settings);
  }

  private readonly cleanTimeRegex = /\b\d{1,2}:\d{2}(\s?(AM|PM))?\b/gi;
  private readonly clockEmojiRegex = /[\u{1F550}-\u{1F567}]/gu;
  
  cleanTimeFromName(name: string): string {
    if (!name) return "";
    return name.substring(0, 128)
      .replace(this.cleanTimeRegex, "")
      .replace(this.clockEmojiRegex, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  formatTime(timezone: string): string {
    try {
      return new Date().toLocaleTimeString("zh-CN", {
        timeZone: timezone, hour12: false, hour: "2-digit", minute: "2-digit"
      });
    } catch {
      const now = new Date();
      return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }
  }

  getClockEmoji(timezone: string): string {
    try {
      const hour = parseInt(new Date().toLocaleTimeString("zh-CN", {
        timeZone: timezone, hour12: false, hour: "2-digit"
      }).split(':')[0]);
      const clocks = ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚'];
      return clocks[hour % 12];
    } catch { return '🕐'; }
  }

  // 获取时区显示格式（支持自定义格式）
  getTimezoneDisplay(timezone: string, format?: string): string {
    try {
      // 使用正确的方法计算时区偏移
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en', {
        timeZone: timezone,
        timeZoneName: 'longOffset'
      });
      
      const parts = formatter.formatToParts(now);
      const offsetPart = parts.find(part => part.type === 'timeZoneName');
      
      if (offsetPart && offsetPart.value) {
        // 解析GMT偏移 (格式: GMT+08:00)
        const match = offsetPart.value.match(/GMT([+-])(\d{2}):(\d{2})/);
        if (match) {
          const sign = match[1];
          const hours = parseInt(match[2], 10);
          const minutes = parseInt(match[3], 10);
          const offsetHours = sign === '+' ? hours : -hours;
          
          console.log(`[AutoChangeName] 时区计算: ${timezone} -> 偏移 ${sign}${hours} 小时`);
          
          // 处理自定义格式
          if (format) {
            switch (format) {
              case 'GMT':
                return minutes > 0 ? `GMT${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `GMT${sign}${hours}`;
              case 'UTC':
                return minutes > 0 ? `UTC${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `UTC${sign}${hours}`;
              case 'city':
                // 常见城市映射
                const cityMap: Record<string, string> = {
                  'Asia/Shanghai': '北京',
                  'Asia/Tokyo': '东京',
                  'Asia/Seoul': '首尔',
                  'Asia/Hong_Kong': '香港',
                  'Asia/Singapore': '新加坡',
                  'Asia/Kolkata': '新德里',
                  'Asia/Kathmandu': '加德满都',
                  'Australia/Adelaide': '阿德莱德',
                  'Australia/Darwin': '达尔文',
                  'America/New_York': '纽约',
                  'America/Los_Angeles': '洛杉矶',
                  'America/Chicago': '芝加哥',
                  'America/Denver': '丹佛',
                  'Europe/London': '伦敦',
                  'Europe/Paris': '巴黎',
                  'Europe/Berlin': '柏林',
                  'Europe/Moscow': '莫斯科'
                };
                return cityMap[timezone] || (minutes > 0 ? `GMT${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `GMT${sign}${hours}`);
              case 'offset':
                return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
              default:
                // 自定义格式 "custom:xxx"
                if (format.startsWith('custom:')) {
                  return format.substring(7);
                }
                return minutes > 0 ? `GMT${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `GMT${sign}${hours}`;
            }
          }
          
          // 默认GMT格式 - 处理半小时偏移
          const result = minutes > 0 ? `GMT${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `GMT${sign}${hours}`;
          console.log(`[AutoChangeName] 时区显示结果: ${result}`);
          return result;
        }
      }
      
      // 备用方法：使用更精确的时区偏移计算
      const utcNow = new Date();
      const localTime = new Date(utcNow.toLocaleString('en-US', { timeZone: timezone }));
      const utcTime = new Date(utcNow.toLocaleString('en-US', { timeZone: 'UTC' }));
      
      const offsetMs = localTime.getTime() - utcTime.getTime();
      const totalMinutes = Math.round(offsetMs / (1000 * 60));
      const offsetHours = Math.floor(Math.abs(totalMinutes) / 60);
      const offsetMinutes = Math.abs(totalMinutes) % 60;
      const sign = totalMinutes >= 0 ? '+' : '-';
      
      console.log(`[AutoChangeName] 备用计算: ${timezone} -> 偏移 ${sign}${offsetHours}:${offsetMinutes.toString().padStart(2, '0')}`);
      
      if (offsetMinutes > 0) {
        return `GMT${sign}${offsetHours.toString().padStart(2, '0')}:${offsetMinutes.toString().padStart(2, '0')}`;
      } else {
        return `GMT${sign}${offsetHours}`;
      }
      
    } catch (error) {
      console.error('[AutoChangeName] 时区计算失败:', error);
      return 'GMT+8';  // 默认返回 GMT+8
    }
  }

  // 生成新昵称
  async generateNewName(settings: UserSettings): Promise<{ firstName: string; lastName: string | null }> {
    const cleanFirstName = settings.original_first_name || "";
    const cleanLastName = settings.original_last_name;
    const currentTime = this.formatTime(settings.timezone);
    
    // 准备各个组件
    const components: { [key: string]: string } = {
      name: cleanFirstName,
      time: currentTime,
      text: '',
      emoji: settings.show_clock_emoji ? this.getClockEmoji(settings.timezone) : '',
      timezone: settings.show_timezone ? this.getTimezoneDisplay(settings.timezone, settings.timezone_format) : ''
    };
    
    // 调试日志：显示各组件值
    console.log(`[AutoChangeName] 组件值: name="${components.name}", time="${components.time}", emoji="${components.emoji}", timezone="${components.timezone}"`);

    // 获取随机文本
    if (settings.mode === "text" || settings.mode === "both") {
      const texts = await DataManager.getRandomTexts();
      if (texts.length > 0) {
        components.text = texts[settings.text_index % texts.length];
      }
    }

    // 根据模式决定显示哪些组件
    let displayComponents: string[] = [];
    
    if (settings.mode === "time") {
      displayComponents = ['name', 'time', 'timezone', 'emoji'];
    } else if (settings.mode === "text") {
      displayComponents = ['name', 'text', 'timezone', 'emoji'];
    } else { // both
      displayComponents = ['name', 'text', 'time', 'timezone', 'emoji'];
    }

    // 根据用户自定义顺序重新排列组件
    if (settings.display_order) {
      let customOrder = settings.display_order.split(',').map(s => s.trim());
      console.log(`[AutoChangeName] 用户自定义顺序: [${customOrder.join(', ')}]`);
      
      // 自动修复：如果开启了时区但display_order中没有timezone，自动添加
      if (settings.show_timezone && !customOrder.includes('timezone')) {
        // 在time后面添加timezone
        const timeIndex = customOrder.indexOf('time');
        if (timeIndex !== -1) {
          customOrder.splice(timeIndex + 1, 0, 'timezone');
        } else {
          customOrder.push('timezone');
        }
        console.log(`[AutoChangeName] 自动添加timezone到顺序: [${customOrder.join(', ')}]`);
      }
      
      // 自动修复：如果开启了emoji但display_order中没有emoji，自动添加
      if (settings.show_clock_emoji && !customOrder.includes('emoji')) {
        customOrder.push('emoji');
        console.log(`[AutoChangeName] 自动添加emoji到顺序: [${customOrder.join(', ')}]`);
      }
      
      // 过滤出在当前模式下应该显示的组件
      const validOrder = customOrder.filter(comp => displayComponents.includes(comp));
      console.log(`[AutoChangeName] 有效的自定义顺序: [${validOrder.join(', ')}]`);
      
      if (validOrder.length > 0) {
        displayComponents = validOrder;
      } else {
        console.log('[AutoChangeName] 自定义顺序无效，使用默认顺序');
      }
    }

    // 组合最终显示文本（只获取有值的组件内容）
    console.log(`[AutoChangeName] 显示组件顺序: [${displayComponents.join(', ')}]`);
    
    const finalParts = displayComponents
      .map(comp => {
        const value = components[comp];
        console.log(`[AutoChangeName] 组件 ${comp}: "${value}" (长度: ${value ? value.length : 0})`);
        return value;
      })
      .filter(part => part && part.length > 0);
    
    console.log(`[AutoChangeName] 过滤后的组件: ["${finalParts.join('", "')}"]`);
    const finalName = finalParts.join(' ');

    return {
      firstName: finalName || cleanFirstName,
      lastName: cleanLastName
    };
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
          const remainTime = Math.ceil((30000 - timeDiff) / 1000);
          console.log(`[AutoChangeName] 用户 ${userId} 更新过于频繁，还需等待 ${remainTime} 秒`);
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

      // 打印详细日志
      console.log(`[AutoChangeName] 用户 ${userId} 昵称更新: "${newName.firstName}"${newName.lastName ? ` 姓氏: "${newName.lastName}"` : ''}`);
      console.log(`[AutoChangeName] 当前配置 - 模式: ${settings.mode}, emoji: ${settings.show_clock_emoji ? '开' : '关'}, 时区: ${settings.show_timezone ? '开' : '关'}`);

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
          
          console.log(`[AutoChangeName] ===== 开始更新 ${enabledUsers.length} 个用户的昵称 =====`);
          
          const updatePromises = enabledUsers.map(userId => 
            this.updateUserProfile(userId).catch(error => {
              console.error(`[AutoChangeName] 用户 ${userId} 更新失败:`, error);
              return false;
            })
          );
          
          const results = await Promise.allSettled(updatePromises);
          const successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
          
          if (successCount > 0) {
            console.log(`[AutoChangeName] 本次更新完成: ${successCount}/${enabledUsers.length} 个用户成功`);
          }
          console.log(`[AutoChangeName] ===== 更新任务结束 =====`);
          console.log(''); // 空行分隔
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
    // 真实资源清理：停止自动更新任务并重置运行时缓存。
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
  cleanup(): void {
    // 真实资源清理：停止自动更新任务并重置运行时缓存。
    nameManager.cleanup();
  }

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
        // 获取用户ID - 优化频道身份处理
        let userId: number | null = null;
        let isChannelMessage = false;
        
        // 检查是否为频道身份发言
        if (msg.fromId && msg.fromId.className === 'PeerChannel') {
          isChannelMessage = true;
          await msg.edit({
            parseMode: "html"
          });
          return;
        }
        
        // 获取真实用户ID
        if (msg.senderId) {
          userId = Number(msg.senderId.toString());
        } else if (msg.fromId && msg.fromId.className === 'PeerUser') {
          userId = Number(msg.fromId.userId.toString());
        }
        
        if (!userId || isNaN(userId)) {
          await msg.edit({
            parseMode: "html"
          });
          return;
        }

        // 处理帮助
        if (!sub || sub === "help" || sub === "h") {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        // 智能首次使用检测和引导
        const settings = await DataManager.getUserSettings(userId);
        const isFirstTime = !settings;
        const needsSave = !settings?.original_first_name;
        
        // 对于非save、help、status命令，检查是否需要引导
        if (isFirstTime && !["save", "help", "h", "status"].includes(sub)) {
          await msg.edit({
            parseMode: "html"
          });
          return;
        }
        
        // 对于已有设置但未保存昵称的用户
        if (needsSave && !isFirstTime && !["save", "help", "h", "status", "reset"].includes(sub)) {
          await msg.edit({
            text: `⚠️ <b>配置不完整</b>\n\n<b>您想要执行：</b> <code>${sub}</code>\n\n<b>⚠️ 检测到问题：</b>\n您的配置中缺少原始昵称记录\n\n<b>🔧 解决方法：</b>\n请先执行 <code>${mainPrefix}acn save</code> 保存您的当前昵称\n\n<b>💡 小提示：</b>\n确保当前昵称是"干净"的（不含时间等动态内容），\n这样恢复时才能得到正确的原始昵称。`,
            parseMode: "html"
          });
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

          case "emoji":
            await this.handleEmojiToggle(msg, userId, args.slice(1));
            break;

          case "showtz":
            await this.handleTimezoneToggle(msg, userId, args.slice(1));
            break;

          case "order":
            await this.handleDisplayOrder(msg, userId, args.slice(1));
            break;

          case "config":
            await this.handleShowConfig(msg, userId);
            break;
            
          case "tzformat":
            await this.handleTimezoneFormat(msg, userId, args.slice(1));
            break;

          default:
            await msg.edit({
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
        // 检查是否为首次保存
        const texts = await DataManager.getRandomTexts();
        const isFirstTimeSave = !settings.last_update;
        
        if (isFirstTimeSave) {
          // 首次保存，提供完整引导
          await msg.edit({
            text: `🎉 <b>昵称保存成功！设置完成</b>\n\n<b>✅ 已保存的原始昵称：</b>\n• 姓名: <code>${htmlEscape(settings.original_first_name || "")}</code>\n• 姓氏: <code>${htmlEscape(settings.original_last_name || "(空)")}</code>\n\n<b>🚀 接下来您可以：</b>\n\n<b>1. 立即开始使用</b>\n<code>${mainPrefix}acn on/off</code> - 开启或关闭自动昵称更新\n\n<b>2. 个性化设置（推荐）</b>\n<code>${mainPrefix}acn text add 工作中</code> - 添加状态文案\n<code>${mainPrefix}acn emoji on/off</code> - 开启或关闭时钟表情 🕐\n<code>${mainPrefix}acn showtz on/off</code> - 显示或隐藏时区 GMT+8\n\n\n<b>💡 小提示：</b>昵称会每分钟自动更新。`,
            parseMode: "html"
          });
        } else {
          // 非首次保存，简化提示
          await msg.edit({
            text: `✅ <b>昵称已重新保存</b>\n\n<b>姓名:</b> <code>${htmlEscape(settings.original_first_name || "")}</code>\n<b>姓氏:</b> <code>${htmlEscape(settings.original_last_name || "(空)")}</code>\n\n${settings.is_enabled ? '自动更新仍在运行中' : '可按需重新启用动态昵称'}`,
            parseMode: "html"
          });
        }
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

      // 首次使用，提供详细的引导
      await msg.edit({
        parseMode: "html"
      });
      return;
    }

    // 检查是否已保存原始昵称
    if (!settings.original_first_name && enable) {
      await msg.edit({
        text: `❌ <b>未保存原始昵称</b>\n\n检测到您的配置中没有原始昵称记录。\n请先执行：\n\n<code>${mainPrefix}acn save</code>\n\n保存您的原始昵称后再开启自动更新。`,
        parseMode: "html"
      });
      return;
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

    // 检查是否已保存原始昵称
    if (!settings.original_first_name) {
      await msg.edit({
        text: `⚠️ <b>提示</b>\n\n您还未保存原始昵称，建议先执行：\n<code>${mainPrefix}acn save</code>\n\n这样可以确保恢复时能还原到正确的昵称。\n\n当前仅切换了显示模式。`,
        parseMode: "html"
      });
      // 继续执行模式切换，但给出警告
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

    if (action === "add") {
      // 从原始消息文本中提取内容，支持真正的多行
      const rawText = msg.message || "";
      const cmdPrefix = rawText.split(' ').slice(0, 3).join(' '); // "acn text add"
      const inputText = rawText.substring(cmdPrefix.length).trim();
      
      if (!inputText) {
        await msg.edit({ text: "❌ 请提供要添加的文本内容", parseMode: "html" });
        return;
      }
      
      // 支持多行文本：按行分割并批量添加
      console.log(`[AutoChangeName] 原始输入文本: "${inputText}"`);
      console.log(`[AutoChangeName] 输入文本长度: ${inputText.length}`);
      
      // 按行分割批量添加
      const lines = inputText.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
      
      console.log(`[AutoChangeName] 分割后的行数: ${lines.length}`);
      console.log(`[AutoChangeName] 分割结果: ["${lines.join('", "')}"]`);
      
      if (lines.length === 0) {
        await msg.edit({ text: "❌ 没有有效的文本内容", parseMode: "html" });
        return;
      }
      
      const validLines: string[] = [];
      const invalidLines: string[] = [];
      const duplicateLines: string[] = [];
      
      for (const line of lines) {
        if (line.length > 50) {
          invalidLines.push(`"${line.substring(0, 30)}..." (过长)`);
        } else if (texts.includes(line) || validLines.includes(line)) {
          duplicateLines.push(`"${line}"`);
        } else {
          validLines.push(line);
        }
      }
      
      // 添加有效文本
      texts.push(...validLines);
      const success = await DataManager.saveRandomTexts(texts);

      if (success) {
        let resultText = `✅ <b>文本添加结果</b>\n\n`;
        
        if (validLines.length > 0) {
          resultText += `✅ 成功添加 <b>${validLines.length}</b> 条文本\n`;
          if (validLines.length <= 3) {
            resultText += validLines.map(line => `• "${htmlEscape(line)}"`).join('\n') + '\n';
          }
        }
        
        if (duplicateLines.length > 0) {
          resultText += `\n⚠️ 跳过 <b>${duplicateLines.length}</b> 条重复文本\n`;
        }
        
        if (invalidLines.length > 0) {
          resultText += `\n❌ 跳过 <b>${invalidLines.length}</b> 条过长文本\n`;
        }
        
        resultText += `\n📊 当前文本总数: <b>${texts.length}</b>`;
        
        await msg.edit({ text: resultText, parseMode: "html" });
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

    // 检查是否已保存原始昵称
    if (!settings.original_first_name) {
      await msg.edit({
        text: `❌ <b>未保存原始昵称</b>\n\n请先使用 <code>${mainPrefix}acn save</code> 保存您的原始昵称`,
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

  // 处理emoji开关
  private async handleEmojiToggle(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await DataManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: `❌ 请先使用 <code>${mainPrefix}acn save</code> 保存昵称`,
        parseMode: "html"
      });
      return;
    }

    const action = args[0]?.toLowerCase();
    if (action === "on") {
      settings.show_clock_emoji = true;
    } else if (action === "off") {
      settings.show_clock_emoji = false;
    } else {
      // 没有参数时显示当前状态
      await msg.edit({
        text: `🕐 <b>时钟Emoji设置</b>\n\n当前状态: <code>${settings.show_clock_emoji ? "开启" : "关闭"}</code>\n\n使用方法：\n• <code>${mainPrefix}acn emoji on/off</code> - 开启或关闭时钟emoji`,
        parseMode: "html"
      });
      return;
    }

    const success = await DataManager.saveUserSettings(settings);
    if (success) {
      if (settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }
      await msg.edit({
        text: `✅ <b>时钟Emoji已${settings.show_clock_emoji ? "开启" : "关闭"}</b>\n\n${settings.show_clock_emoji ? "现在您的昵称将显示对应时间的时钟表情 🕐" : "时钟表情已从昵称中移除"}`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  // 处理时区显示开关
  private async handleTimezoneToggle(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await DataManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: `❌ 请先使用 <code>${mainPrefix}acn save</code> 保存昵称`,
        parseMode: "html"
      });
      return;
    }

    const action = args[0]?.toLowerCase();
    if (action === "on") {
      settings.show_timezone = true;
    } else if (action === "off") {
      settings.show_timezone = false;
    } else {
      // 没有参数时显示当前状态
      await msg.edit({
        text: `🌍 <b>时区显示设置</b>\n\n当前状态: <code>${settings.show_timezone ? "开启" : "关闭"}</code>\n\n使用方法：\n• <code>${mainPrefix}acn showtz on/off</code> - 显示或隐藏时区`,
        parseMode: "html"
      });
      return;
    }

    const success = await DataManager.saveUserSettings(settings);
    if (success) {
      if (settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }
      const tzDisplay = nameManager.getTimezoneDisplay(settings.timezone, settings.timezone_format);
      await msg.edit({
        text: `✅ <b>时区显示已${settings.show_timezone ? "开启" : "关闭"}</b>\n\n${settings.show_timezone ? `当前时区: ${tzDisplay}` : "时区信息已从昵称中移除"}`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  // 处理时区格式设置
  private async handleTimezoneFormat(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await DataManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: `❌ 请先使用 <code>${mainPrefix}acn save</code> 保存昵称`,
        parseMode: "html"
      });
      return;
    }

    const format = args[0]?.toLowerCase();
    
    if (!format) {
      await msg.edit({
        text: `🌐 <b>时区显示格式设置</b>\n\n当前格式: <code>${settings.timezone_format || 'GMT'}</code>\n\n<b>可用格式：</b>\n• <code>GMT</code> - 显示 GMT+8\n• <code>UTC</code> - 显示 UTC+8\n• <code>city</code> - 显示城市名（如：北京）\n• <code>offset</code> - 显示 +8:00\n• <code>custom:自定义文字</code> - 自定义显示\n\n<b>使用示例：</b>\n<code>${mainPrefix}acn tzformat GMT</code>\n<code>${mainPrefix}acn tzformat city</code>\n<code>${mainPrefix}acn tzformat custom:北京时间</code>`,
        parseMode: "html"
      });
      return;
    }

    // 处理自定义格式
    let finalFormat = format;
    if (format.startsWith('custom:')) {
      finalFormat = args.join(' ');
    } else if (!['gmt', 'utc', 'city', 'offset'].includes(format)) {
      await msg.edit({
        text: `❌ <b>无效格式</b>\n\n请使用: GMT, UTC, city, offset 或 custom:自定义`,
        parseMode: "html"
      });
      return;
    }

    settings.timezone_format = finalFormat.toUpperCase();
    const success = await DataManager.saveUserSettings(settings);
    
    if (success) {
      if (settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }
      const preview = nameManager.getTimezoneDisplay(settings.timezone, settings.timezone_format);
      await msg.edit({
        text: `✅ <b>时区格式已更新</b>\n\n新格式: <code>${htmlEscape(settings.timezone_format)}</code>\n预览: <code>${preview}</code>`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  // 处理显示顺序设置
  private async handleDisplayOrder(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await DataManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: `❌ 请先使用 <code>${mainPrefix}acn save</code> 保存昵称`,
        parseMode: "html"
      });
      return;
    }

    if (args.length === 0) {
      // 显示当前顺序
      const currentOrder = settings.display_order || "name,text,time,emoji";
      const orderExamples = [
        "• <code>name,text,time,emoji</code> → 张三 摸鱼中 09:30 🕐",
        "• <code>text,time,emoji,name</code> → 摸鱼中 09:30 🕐 张三",
        "• <code>name,emoji,time,text</code> → 张三 🕐 09:30 摸鱼中",
        "• <code>emoji,time,text,name</code> → 🕐 09:30 摸鱼中 张三"
      ].join("\n");

      await msg.edit({
        text: `📋 <b>显示顺序设置</b>\n\n当前顺序: <code>${htmlEscape(currentOrder)}</code>\n\n<b>可用组件：</b>\n• <code>name</code> - 您的昵称\n• <code>text</code> - 随机文案\n• <code>time</code> - 当前时间\n• <code>emoji</code> - 时钟表情\n• <code>timezone</code> - 时区显示\n\n<b>设置示例：</b>\n${orderExamples}\n\n使用 <code>${mainPrefix}acn order 组件1,组件2,...</code> 自定义顺序`,
        parseMode: "html"
      });
      return;
    }

    // 设置新顺序
    const newOrder = args.join("").toLowerCase();
    const validComponents = ["name", "text", "time", "emoji", "timezone"];
    const components = newOrder.split(",").map(s => s.trim());
    
    // 验证组件名称
    const invalidComponents = components.filter(comp => !validComponents.includes(comp));
    if (invalidComponents.length > 0) {
      await msg.edit({
        text: `❌ <b>无效的组件名称</b>\n\n无效组件: <code>${htmlEscape(invalidComponents.join(", "))}</code>\n\n有效组件: <code>name, text, time, emoji, timezone</code>`,
        parseMode: "html"
      });
      return;
    }

    settings.display_order = newOrder;
    const success = await DataManager.saveUserSettings(settings);
    
    if (success) {
      if (settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }
      await msg.edit({
        text: `✅ <b>显示顺序已更新</b>\n\n新顺序: <code>${htmlEscape(newOrder)}</code>\n\n昵称将按此顺序显示各个组件`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  // 显示当前配置
  private async handleShowConfig(msg: Api.Message, userId: number): Promise<void> {
    const settings = await DataManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: `❌ 请先使用 <code>${mainPrefix}acn save</code> 保存昵称`,
        parseMode: "html"
      });
      return;
    }

    const texts = await DataManager.getRandomTexts();
    const currentTime = nameManager.formatTime(settings.timezone);
    const clockEmoji = nameManager.getClockEmoji(settings.timezone);
    const tzDisplay = nameManager.getTimezoneDisplay(settings.timezone, settings.timezone_format);

    const configText = `🔧 <b>当前配置状态</b>\n\n` +
      `<b>基础设置：</b>\n` +
      `• 自动更新: <code>${settings.is_enabled ? "开启" : "关闭"}</code>\n` +
      `• 显示模式: <code>${settings.mode}</code>\n` +
      `• 时区: <code>${settings.timezone}</code>\n` +
      `• 当前时间: <code>${currentTime}</code>\n\n` +
      `<b>显示选项：</b>\n` +
      `• 时钟Emoji: <code>${settings.show_clock_emoji ? "开启" : "关闭"}</code> ${settings.show_clock_emoji ? clockEmoji : ""}\n` +
      `• 时区显示: <code>${settings.show_timezone ? "开启" : "关闭"}</code> ${settings.show_timezone ? tzDisplay : ""}\n` +
      `• 时区格式: <code>${settings.timezone_format || "GMT"}</code>\n` +
      `• 显示顺序: <code>${settings.display_order || "name,text,time,emoji"}</code>\n\n` +
      `<b>文案设置：</b>\n` +
      `• 文案数量: <code>${texts.length}</code>\n` +
      `• 当前索引: <code>${settings.text_index}</code>\n\n` +
      `<b>原始昵称：</b>\n` +
      `• 姓名: <code>${htmlEscape(settings.original_first_name || "(空)")}</code>\n` +
      `• 姓氏: <code>${htmlEscape(settings.original_last_name || "(空)")}</code>`;

    await msg.edit({ text: configText, parseMode: "html" });
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
      
      // 检查所有启用的用户是否已保存原始昵称
      let validUsers = 0;
      const userDetails: string[] = [];
      
      for (const userId of enabledUsers) {
        const settings = await DataManager.getUserSettings(userId);
        if (settings && settings.original_first_name) {
          validUsers++;
          userDetails.push(`  - 用户 ${userId}: 模式=${settings.mode}, emoji=${settings.show_clock_emoji ? '开' : '关'}, 时区=${settings.show_timezone ? '开' : '关'}`);
        } else {
          // 如果发现用户没有保存原始昵称，自动禁用其自动更新
          if (settings) {
            console.warn(`[AutoChangeName] 用户 ${userId} 未保存原始昵称，已自动禁用自动更新`);
            settings.is_enabled = false;
            await DataManager.saveUserSettings(settings);
          }
        }
      }
      
      if (validUsers > 0) {
        nameManager.startAutoUpdate();
        console.log(`[AutoChangeName] 插件已启动，${validUsers} 个用户已启用自动更新`);
        if (userDetails.length > 0) {
          console.log('[AutoChangeName] 用户配置:');
          userDetails.forEach(detail => console.log(detail));
        }
      } else {
        console.log("[AutoChangeName] 插件已启动，暂无有效用户启用自动更新");
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

// 自动初始化（测试时可通过设置 TELEBOX_AUTO_INIT=false 跳过）
if (process.env.TELEBOX_AUTO_INIT !== 'false') {
  (async () => {
    try {
      await plugin.init();
    } catch (error) {
      console.error("[AutoChangeName] 自动初始化失败:", error);
    }
  })();
}

// 导出测试辅助（纯函数绑定，便于在不初始化插件的情况下进行单元测试）
export const __test__ = {
  htmlEscape,
  cleanTimeFromName: nameManager.cleanTimeFromName.bind(nameManager),
  formatTime: nameManager.formatTime.bind(nameManager),
  getClockEmoji: nameManager.getClockEmoji.bind(nameManager),
  getTimezoneDisplay: nameManager.getTimezoneDisplay.bind(nameManager),
  generateNewName: nameManager.generateNewName.bind(nameManager)
};

// 导出插件实例
export default plugin;

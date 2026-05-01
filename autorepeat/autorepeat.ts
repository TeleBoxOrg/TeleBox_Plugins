import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api, TelegramClient, utils } from "teleproto";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

function htmlEscape(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ==================== 配置常量 ====================
const CONFIG = {
  CACHE_DB_NAME: "autorepeat.json",  // 修改为 autorepeat.json
  MESSAGE_AUTO_DELETE: 30,
};

// ==================== 帮助文本 ====================
const HELP_TEXT = `<b>自动复读插件使用说明</b>

<b>指令列表：</b>
<code>${mainPrefix}autorepeat on/off</code> - 在群组中使用，开启 / 关闭 当前群组
<code>.autorepeat on / off [群组ID / @群组名 / https://t.me/群组名]</code> - 开启指定群组
<code>.autorepeat allon</code> - 开启全部群组自动复读
<code>.autorepeat alloff</code> - 关闭全部群组自动复读
<code>.autorepeat list [页码]</code> - 查看已开启的群组(每页20个)
<code>.autorepeat set [时间] [人数]</code> - 自定义触发条件(如: .autorepeat set 300 5)
<code>.autorepeat</code> - 查看当前群组状态

<b>高级用法：</b>
• 从目标群组转发消息后，回复该消息并使用 <code>${mainPrefix}autorepeat on/off</code> 可切换该群组状态

<b>复读规则：</b>
• <b>触发条件</b>：默认5分钟内有5位不同用户发送完全相同的内容
• <b>每日限制</b>：同一群组内，相同内容每天只会自动复读一次 (UTC+8 0点重置)
• <b>忽略规则</b>：匿名消息、非文本消息、自己发送的消息、机器人消息会被忽略
`;

// ==================== 缓存管理器 ====================
type CacheData = {
  cache: Record<string, any>;
  daily_history?: Record<string, string[]>; // groupId -> textHashes[]
  last_day_check?: number;
  trigger_config?: { timeWindow: number; minUsers: number }; // 触发条件配置
};

class CacheManager {
  private db: Low<CacheData> | null = null;
  private static instance: CacheManager;
  private initPromise: Promise<void>;

  private constructor() {
    this.initPromise = this.initDb();
  }

  static getInstance(): CacheManager {
    if (!this.instance) {
      this.instance = new CacheManager();
    }
    return this.instance;
  }

  private async initDb(): Promise<void> {
    const dbPath = path.join(
      createDirectoryInAssets("aban"),
      CONFIG.CACHE_DB_NAME
    );
    const adapter = new JSONFile<CacheData>(dbPath);
    this.db = new Low(adapter, { cache: {} });
    await this.db.read();
    if (!this.db.data) {
      this.db.data = { cache: {} };
      await this.db.write();
    }
  }

  async get(key: string): Promise<any> {
    await this.initPromise;
    if (!this.db) return null;
    return this.db.data.cache[key] || null;
  }

  async set(key: string, value: any): Promise<void> {
    await this.initPromise;
    if (!this.db) return;
    this.db.data.cache[key] = value;
    await this.db.write();
  }

  // Generic helpers for root properties
  async getData(): Promise<CacheData | null> {
    await this.initPromise;
    return this.db?.data || null;
  }

  async saveData(data: Partial<CacheData>): Promise<void> {
    await this.initPromise;
    if (!this.db) return;
    Object.assign(this.db.data, data);
    await this.db.write();
  }
}

// ==================== 消息管理器 ====================
class MessageManager {
  static async smartEdit(
    message: Api.Message | undefined,
    text: string,
    deleteAfter: number = CONFIG.MESSAGE_AUTO_DELETE,
    parseMode: "html" | "md" = "html"
  ): Promise<Api.Message | undefined> {
    try {
      const client = await getGlobalClient();
      if (!client || !message) return message;

      await client.editMessage(message.peerId, {
        message: message.id,
        text: text,
        parseMode: parseMode,
        linkPreview: false,
      });

      if (deleteAfter > 0) {
        setTimeout(async () => {
          try {
            await client.deleteMessages(message.peerId, [message.id], {
              revoke: true,
            });
          } catch (e) {
            console.error(`删除消息失败: ${e}`);
          }
        }, deleteAfter * 1000);
      }

      return message;
    } catch (error: any) {
      console.error(`编辑消息失败: ${error.message || error}`);
      return message;
    }
  }
}

// ==================== 权限管理器 ====================
class PermissionManager {
  static async checkAdminPermission(
    client: TelegramClient,
    chatId: any
  ): Promise<boolean> {
    try {
      const me = await client.getMe();
      const participant = await client.invoke(
        new Api.channels.GetParticipant({
          channel: chatId,
          participant: me.id
        })
      );

      const p = participant.participant;
      if (p instanceof Api.ChannelParticipantCreator) return true;
      if (p instanceof Api.ChannelParticipantAdmin) {
        // 只要是管理员就行，或者检查具体权限
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }
}

// ==================== 复读机管理器 ====================
class AutoRepeatManager {
  private static cache = CacheManager.getInstance();
  // 消息记录: groupId -> Array<{userId, text, time}>
  private static recentMessages: Map<number, Array<{ userId: number; text: string; time: number }>> = new Map();
  // 当日已复读记录: groupId -> Set<textHash>
  private static dailyHistory: Map<number, Set<string>> = new Map();
  // 设置: groupId -> boolean
  private static enabledGroups: Set<number> = new Set();

  private static lastCleanup = 0;
  private static lastDayCheck = 0;
  
  // 触发条件配置
  private static triggerConfig = {
    timeWindow: 300, // 5分钟
    minUsers: 5      // 5个用户
  };

  static async init() {
    // 加载设置
    const settings = await this.cache.get("autorepeat_settings");
    if (settings && Array.isArray(settings)) {
      this.enabledGroups = new Set(settings);
    }

    // 加载每日记录
    const data = await this.cache.getData();
    if (data) {
      if (data.last_day_check) {
        this.lastDayCheck = data.last_day_check;
      }
      if (data.daily_history) {
        for (const [gidStr, hashes] of Object.entries(data.daily_history)) {
          const gid = Number(gidStr);
          if (!Number.isNaN(gid)) {
            this.dailyHistory.set(gid, new Set(hashes));
          }
        }
      }
      if (data.trigger_config) {
        this.triggerConfig = data.trigger_config;
      }
    }
  }

  static async setTriggerConfig(timeWindow: number, minUsers: number) {
    this.triggerConfig = { timeWindow, minUsers };
    await this.cache.saveData({ trigger_config: this.triggerConfig });
  }

  static getTriggerConfig() {
    return { ...this.triggerConfig };
  }

  static async toggleGroup(groupId: number, enable: boolean) {
    if (enable) {
      this.enabledGroups.add(groupId);
    } else {
      this.enabledGroups.delete(groupId);
    }
    // 保存设置
    await this.cache.set("autorepeat_settings", Array.from(this.enabledGroups));
  }

  static async enableAll(groupIds: number[]) {
    for (const gid of groupIds) {
      this.enabledGroups.add(gid);
    }
    await this.cache.set("autorepeat_settings", Array.from(this.enabledGroups));
  }

  static async disableAll() {
    this.enabledGroups.clear();
    await this.cache.set("autorepeat_settings", []);
  }

  static isEnabled(groupId: number): boolean {
    return this.enabledGroups.has(groupId);
  }

  static getEnabledGroups(): number[] {
    return Array.from(this.enabledGroups);
  }

  static async checkAndRepeat(message: Api.Message) {
    try {
      if (!message.chatId) return;
      const chatId = Number(message.chatId);

      // 检查开关
      if (!this.enabledGroups.has(chatId)) return;

      // 必须是文本消息
      const text = message.message;
      if (!text) return;

      const now = Math.floor(Date.now() / 1000);

      // 定期清理过期消息和重置每日记录
      this.maintenance(now);

      // 获取当前群组的消息记录
      let msgs = this.recentMessages.get(chatId) || [];

      // 添加新消息
      const senderId = message.senderId ? Number(message.senderId) : 0;
      if (senderId === 0) return; // 忽略匿名发送者

      msgs.push({
        userId: senderId,
        text: text,
        time: now
      });

      // 过滤掉超过配置时间的消息
      msgs = msgs.filter(m => now - m.time <= this.triggerConfig.timeWindow);
      this.recentMessages.set(chatId, msgs);

      // 检查是否满足复读条件
      await this.tryRepeat(chatId, text, msgs);

    } catch (e) {
      console.error(`[AutoRepeat] Error: ${e}`);
    }
  }

  private static async tryRepeat(chatId: number, text: string, msgs: Array<{ userId: number; text: string; time: number }>) {
    // 统计发送由于该内容的不同用户数量
    const senders = new Set<number>();
    for (const msg of msgs) {
      if (msg.text === text) {
        senders.add(msg.userId);
      }
    }

    // 条件：至少配置的人数在配置的时间内发送
    if (senders.size >= this.triggerConfig.minUsers) {
      // 检查今日是否已复读
      if (!this.dailyHistory.has(chatId)) {
        this.dailyHistory.set(chatId, new Set());
      }

      // 简单哈希（或直接用文本，如果文本不太长）
      const contentKey = text.length > 50 ? text.substring(0, 50) + text.length : text;

      if (!this.dailyHistory.get(chatId)?.has(contentKey)) {
        // [关键修改] 先标记为已复读，防止并发重复
        this.dailyHistory.get(chatId)?.add(contentKey);
        await this.saveDailyHistory();

        // 执行复读
        const client = await getGlobalClient();
        if (client) {
          try {
            await client.sendMessage(chatId, { message: text });
            console.log(`[AutoRepeat] Group ${chatId} repeated: ${contentKey}`);
          } catch (e) {
            // 发送失败则移除标记（可选，视需求而定，为了防刷通常不移除）
            console.error(`[AutoRepeat] Failed to send: ${e}`);
          }
        }
      }
    }
  }

  private static async saveDailyHistory() {
    const historyObj: Record<string, string[]> = {};
    for (const [gid, set] of this.dailyHistory) {
      historyObj[gid] = Array.from(set);
    }
    await this.cache.saveData({
      daily_history: historyObj,
      last_day_check: this.lastDayCheck
    });
  }

  private static maintenance(now: number) {
    // 每分钟清理一次过期消息
    if (now - this.lastCleanup > 60) {
      for (const [gid, msgs] of this.recentMessages) {
        const valid = msgs.filter(m => now - m.time <= this.triggerConfig.timeWindow);
        if (valid.length === 0) {
          this.recentMessages.delete(gid);
        } else {
          this.recentMessages.set(gid, valid);
        }
      }
      this.lastCleanup = now;
    }

    // 每天重置复读记录
    const dayKey = Math.floor((now + 8 * 3600) / 86400); // UTC+8 天数
    if (dayKey > this.lastDayCheck) {
      this.dailyHistory.clear();
      this.lastDayCheck = dayKey;
      this.saveDailyHistory(); // 保存新的天数和空的记录
    }
  }

  static cleanup(): void {
    this.recentMessages.clear();
    this.dailyHistory.clear();
    this.enabledGroups.clear();
    this.lastCleanup = 0;
    this.lastDayCheck = 0;
  }
}

// 初始化
AutoRepeatManager.init().catch(e => console.error(`[AutoRepeat] Init failed: ${e}`));

// ==================== 命令处理器 ====================
class CommandHandlers {
  // 从 Telegram 链接中提取用户名
  static extractUsernameFromUrl(url: string): string | null {
    try {
      // 支持格式：
      // https://t.me/username
      // http://t.me/username
      // t.me/username
      // @username
      const patterns = [
        /^https?:\/\/t\.me\/([a-zA-Z0-9_]+)/,
        /^t\.me\/([a-zA-Z0-9_]+)/,
        /^@([a-zA-Z0-9_]+)$/,
        /^([a-zA-Z0-9_]+)$/
      ];

      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
          return match[1];
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // 解析群组标识符（支持 @username, 群组ID, 转发消息, Telegram链接）
  static async parseGroupIdentifier(
    client: TelegramClient, 
    message: Api.Message,
    identifier?: string
  ): Promise<{ success: boolean; chatId?: number; title?: string; error?: string }> {
    try {
      // 1. 如果有回复消息，尝试从转发信息中获取
      if (message.replyTo) {
        try {
          const repliedMsg = await message.getReplyMessage();
          if (repliedMsg && repliedMsg.fwdFrom) {
            const fwdChatId = repliedMsg.fwdFrom.fromId;
            if (fwdChatId) {
              const entity: any = await client.getEntity(fwdChatId);
              if (entity.className === 'Chat' || (entity.className === 'Channel' && entity.megagroup)) {
                const chatId = Number(utils.getPeerId(entity));
                return {
                  success: true,
                  chatId: chatId,
                  title: entity.title || `群组 ${chatId}`
                };
              }
            }
          }
        } catch (e) {
          // 继续尝试其他方式
        }
      }

      // 2. 如果没有提供标识符，检查是否在群组中
      if (!identifier) {
        if (message.isGroup || (message.isChannel && !message.isPrivate)) {
          const chatId = Number(message.chatId);
          try {
            const entity: any = await client.getEntity(chatId);
            return {
              success: true,
              chatId: chatId,
              title: entity.title || `群组 ${chatId}`
            };
          } catch (e) {
            return {
              success: true,
              chatId: chatId,
              title: `群组 ${chatId}`
            };
          }
        } else {
          return {
            success: false,
            error: '❌ 请提供群组标识符或在群组中使用此命令\n支持格式:\n• 群组ID: <code>-1001234567890</code>\n• 公开群组: <code>@groupname</code>\n• Telegram链接: <code>https://t.me/groupname</code>\n• 转发消息: 回复来自目标群组的转发消息'
          };
        }
      }

      // 3. 尝试解析为群组ID（负数）
      if (identifier.startsWith('-') && !identifier.startsWith('@')) {
        const chatId = Number(identifier);
        if (!isNaN(chatId)) {
          try {
            const entity: any = await client.getEntity(chatId);
            return {
              success: true,
              chatId: chatId,
              title: entity.title || `群组 ${chatId}`
            };
          } catch (e) {
              const safeIdentifier = htmlEscape(identifier);
              return {
                success: false,
                error: `❌ 无法访问群组 ${safeIdentifier}\n请确保:\n1. 群组ID正确\n2. 你在该群组中\n3. 已经在该群组中发送过消息`
              };

          }
        }
      }

      // 4. 尝试从 Telegram 链接或 @用户名 中提取用户名
      const username = this.extractUsernameFromUrl(identifier);
      if (username) {
        try {
          const entity: any = await client.getEntity(username);
          
          if (entity.className === 'Chat' || (entity.className === 'Channel' && entity.megagroup)) {
            // 使用 utils.getPeerId 获取正确的 peer ID
            const chatId = Number(utils.getPeerId(entity));
            
            return {
              success: true,
              chatId: chatId,
              title: entity.title || username
            };
          } else {
            return {
              success: false,
              error: '❌ 这不是一个群组\n提示: 普通用户无法使用此命令'
            };
          }
        } catch (e: any) {
            const safeIdentifier = htmlEscape(identifier);
            return {
              success: false,
              error: `❌ 无法找到群组 ${safeIdentifier}\n可能原因:\n1. 群组不是公开群组\n2. 用户名或链接错误\n3. 你不在该群组中\n\n建议使用群组ID或在群组中直接使用命令`
            };

        }
      }

      return {
        success: false,
        error: '❌ 无效的群组标识符\n支持格式:\n• 群组ID: <code>-1001234567890</code>\n• 公开群组: <code>@groupname</code>\n• Telegram链接: <code>https://t.me/groupname</code>'
      };

    } catch (e: any) {
      const errorMessage = htmlEscape(e.message || '未知错误');
      return {
        success: false,
        error: `❌ 解析失败: ${errorMessage}`
      };
    }
  }

  static async handleAutoRepeatCommand(message: Api.Message) {  // 修改函数名
    try {
      const args = message.message?.split(" ").slice(1) || [];
      const action = args[0]?.toLowerCase();
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(message, "❌ 客户端未初始化");
        return;
      }

      // .autorepeat allon - 开启全部群组
      if (action === "allon") {
        await MessageManager.smartEdit(message, "🔄 正在扫描所有群组...", 0);
        const dialogs = await client.getDialogs();
        const groupIds: number[] = [];

        for (const dialog of dialogs) {
          if (dialog.isGroup || (dialog.isChannel && (dialog.entity as any)?.megagroup)) {
            groupIds.push(Number(dialog.id));
          }
        }
        await AutoRepeatManager.enableAll(groupIds);
        await MessageManager.smartEdit(message, `✅ 已开启 ${groupIds.length} 个群组的自动复读`);
        return;
      }

      // .autorepeat alloff - 关闭全部群组
      if (action === "alloff") {
        await AutoRepeatManager.disableAll();
        await MessageManager.smartEdit(message, "✅ 已关闭所有群组的自动复读");
        return;
      }

      // .autorepeat list [页码] - 查看已开启的群组
      if (action === "list") {
        const page = parseInt(args[1]) || 1;
        const pageSize = 20;
        const groups = AutoRepeatManager.getEnabledGroups();
        
        if (groups.length === 0) {
          await MessageManager.smartEdit(message, "📝 当前没有开启自动复读的群组");
          return;
        }

        const totalPages = Math.ceil(groups.length / pageSize);
        const startIdx = (page - 1) * pageSize;
        const endIdx = Math.min(startIdx + pageSize, groups.length);
        const pageGroups = groups.slice(startIdx, endIdx);

        const lines: string[] = [];
        for (const gid of pageGroups) {
          try {
            const entity: any = await client.getEntity(gid);
                const title = htmlEscape(entity.title || "Unknown Group");
                lines.push(`• <b>${title}</b> (<code>${gid}</code>)`);

          } catch (e) {
            lines.push(`• <code>${gid}</code> (无法获取信息)`);
          }
        }

        await MessageManager.smartEdit(
          message,
          `📝 <b>已开启自动复读群组 (${groups.length}):</b>\n` +  // 修改标题
          `<b>第 ${page}/${totalPages} 页</b>\n\n` +
          lines.join("\n") +
          (totalPages > 1 ? `\n\n使用 <code>.autorepeat list ${page + 1}</code> 查看下一页` : '')  // 修改命令提示
        );
        return;
      }

      // .autorepeat set [时间] [人数] - 自定义触发条件
      if (action === "set") {
        const timeWindow = parseInt(args[1]);
        const minUsers = parseInt(args[2]);

        if (!timeWindow || !minUsers || timeWindow <= 0 || minUsers <= 0) {
          await MessageManager.smartEdit(
            message, 
            "❌ 参数错误\n使用格式: <code>.autorepeat set [时间(秒)] [人数]</code>\n示例: <code>.autorepeat set 300 5</code>"  // 修改示例
          );
          return;
        }

        await AutoRepeatManager.setTriggerConfig(timeWindow, minUsers);
        await MessageManager.smartEdit(
          message,
          `✅ 触发条件已更新\n时间窗口: ${timeWindow}秒\n最少人数: ${minUsers}人`
        );
        return;
      }

      // .autorepeat on [标识符]
      if (action === "on") {
        const identifier = args[1];
        const result = await this.parseGroupIdentifier(client, message, identifier);
        
        if (!result.success) {
          await MessageManager.smartEdit(message, result.error || "操作失败");
          return;
        }

        await AutoRepeatManager.toggleGroup(result.chatId!, true);
          await MessageManager.smartEdit(message, `✅ 已开启 <b>${htmlEscape(result.title || "")}</b> 的自动复读`, 3);

        return;
      }

      // .autorepeat off [标识符]
      if (action === "off") {
        const identifier = args[1];
        const result = await this.parseGroupIdentifier(client, message, identifier);
        
        if (!result.success) {
          await MessageManager.smartEdit(message, result.error || "操作失败");
          return;
        }

        await AutoRepeatManager.toggleGroup(result.chatId!, false);
          await MessageManager.smartEdit(message, `❌ 已关闭 <b>${htmlEscape(result.title || "")}</b> 的自动复读`, 3);

        return;
      }

      // .autorepeat - 查看当前群组状态
      const result = await this.parseGroupIdentifier(client, message);
      if (result.success) {
        const status = AutoRepeatManager.isEnabled(result.chatId!) ? "✅ 已开启" : "❌ 已关闭";
        const config = AutoRepeatManager.getTriggerConfig();
          const safeTitle = htmlEscape(result.title || "");
          await MessageManager.smartEdit(
            message,
            `🤖 <b>${safeTitle}</b>\n` +
            `群组ID: <code>${result.chatId}</code>\n` +
            `状态: ${status}\n` +
            `触发条件: ${config.timeWindow}秒内${config.minUsers}人`
          );

      } else {
        // 默认显示帮助
        await MessageManager.smartEdit(message, HELP_TEXT);
      }

    } catch (e: any) {
      const errorMessage = htmlEscape(e.message || "未知错误");
      await MessageManager.smartEdit(message, `❌ 操作失败: ${errorMessage}`);
    }
  }
}

// ==================== 插件主类 ====================
class AutoRepeatPlugin extends Plugin {
  cleanup(): void {
    AutoRepeatManager.cleanup();
  }
  // 修改类名
  description: string = HELP_TEXT;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    autorepeat: async (msg) => {  // 修改命令名
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleAutoRepeatCommand(msg);  // 修改调用函数名
    },
  };

  listenMessageHandler = async (msg: Api.Message) => {
    if (!msg || msg.date === undefined) return;

    // 忽略之前的旧消息（只处理实时消息）
    if (Date.now() / 1000 - msg.date > 60) return;

    // 忽略自己发送的消息
    if (msg.out) return;

    // 忽略其他机器人发送的消息
    const sender = await msg.getSender();
    if (!sender) return;
    if (sender instanceof Api.User && sender.bot) {
      return;
    }

    await AutoRepeatManager.checkAndRepeat(msg);
  };
}

// 导出插件实例
export default new AutoRepeatPlugin();  // 修改实例名

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api, TelegramClient } from "telegram";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";

// ==================== 配置常量 ====================
const CONFIG = {
  CACHE_DB_NAME: "repeat.json",
  MESSAGE_AUTO_DELETE: 30,
};

// ==================== 帮助文本 ====================
const HELP_TEXT = `<b>自动复读插件使用说明</b>

<b>指令列表：</b>
<code>.autorepeat on</code> - 开启本群自动复读
<code>.autorepeat off</code> - 关闭本群自动复读
<code>.autorepeat list</code> - 查看已开启的群组
<code>.autorepeat</code> - 查看当前状态

<b>复读规则：</b>
• <b>触发条件</b>：5分钟内有5位不同用户发送完全相同的内容
• <b>每日限制</b>：同一群组内，相同内容每天只会自动复读一次 (UTC+8 0点重置)
• <b>忽略规则</b>：匿名消息、非文本消息会被忽略
`;

// ==================== 缓存管理器 ====================
type CacheData = {
  cache: Record<string, any>;
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
}

// ==================== 消息管理器 ====================
class MessageManager {
  static async smartEdit(
    message: Api.Message,
    text: string,
    deleteAfter: number = CONFIG.MESSAGE_AUTO_DELETE,
    parseMode: "html" | "md" = "html"
  ): Promise<Api.Message> {
    try {
      const client = await getGlobalClient();
      if (!client) return message;

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

  static async init() {
    // 加载设置
    const settings = await this.cache.get("autorepeat_settings");
    if (settings && Array.isArray(settings)) {
      this.enabledGroups = new Set(settings);
    }
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

      // 过滤掉超过5分钟的消息
      msgs = msgs.filter(m => now - m.time <= 300);
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

    // 条件：至少5人在5分钟内发送
    if (senders.size >= 5) {
      // 检查今日是否已复读
      if (!this.dailyHistory.has(chatId)) {
        this.dailyHistory.set(chatId, new Set());
      }

      // 简单哈希（或直接用文本，如果文本不太长）
      const contentKey = text.length > 50 ? text.substring(0, 50) + text.length : text;

      if (!this.dailyHistory.get(chatId)?.has(contentKey)) {
        // [关键修改] 先标记为已复读，防止并发重复
        this.dailyHistory.get(chatId)?.add(contentKey);

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

  private static maintenance(now: number) {
    // 每分钟清理一次过期消息
    if (now - this.lastCleanup > 60) {
      for (const [gid, msgs] of this.recentMessages) {
        const valid = msgs.filter(m => now - m.time <= 300);
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
    }
  }
}

// 初始化
AutoRepeatManager.init().catch(e => console.error(`[AutoRepeat] Init failed: ${e}`));

// ==================== 命令处理器 ====================
class CommandHandlers {
  static async handleAutoRepeatCommand(message: Api.Message) {  // 修改函数名
    try {
      const args = message.message?.split(" ").slice(1) || [];
      const action = args[0]?.toLowerCase();

      // 此命令仅能在群组中使用 (list 命令除外，可以在私聊查看)
      if (message.isPrivate) {
        if (action !== "list") {
          await MessageManager.smartEdit(message, "❌ 此命令仅能在群组中使用");
          return;
        }
      }

      const chatId = Number(message.chatId);

      if (action === "on") {
        await AutoRepeatManager.toggleGroup(chatId, true);
        await MessageManager.smartEdit(message, "✅ 自动复读已开启", 2);  // 修改提示文本
      } else if (action === "off") {
        await AutoRepeatManager.toggleGroup(chatId, false);
        await MessageManager.smartEdit(message, "❌ 自动复读已关闭", 2);  // 修改提示文本
      } else if (action === "list") {
        const groups = AutoRepeatManager.getEnabledGroups();
        if (groups.length === 0) {
          await MessageManager.smartEdit(message, "📝 当前没有开启自动复读的群组");
        } else {
          // 获取群组信息
          const lines = [];
          const client = await getGlobalClient(); // 确保获取 client

          if (client) {
            for (const gid of groups) {
              try {
                // 尝试获取群组信息
                const entity: any = await client.getEntity(gid);
                const title = entity.title || "Unknown Group";
                lines.push(`• <b>${title}</b> (<code>${gid}</code>)`);
              } catch (e) {
                // 如果获取失败（比如不在群里了），只显示 ID
                lines.push(`• <code>${gid}</code> (无法获取信息)`);
              }
            }
          } else {
            // 如果没有 client 实例（理论上不应该），降级显示 ID
            lines.push(...groups.map(id => `<code>${id}</code>`));
          }

          await MessageManager.smartEdit(
            message,
            `📝 <b>已开启自动复读群组 (${groups.length}):</b>\n\n` +  // 修改标题
            lines.join("\n")
          );
        }
      } else {
        const status = AutoRepeatManager.isEnabled(chatId) ? "开启" : "关闭";
        await MessageManager.smartEdit(message, `🤖 自动复读状态: ${status}`);  // 修改提示文本
      }

    } catch (e: any) {
      await MessageManager.smartEdit(message, `❌ 设置失败: ${e.message}`);
    }
  }
}

// ==================== 插件主类 ====================
class AutoRepeatPlugin extends Plugin {  // 修改类名
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
    // 忽略之前的旧消息（只处理实时消息）
    if (Date.now() / 1000 - msg.date > 60) return;

    // 忽略自己发送的消息
    if (msg.out) return;

    // 忽略其他机器人发送的消息
    const sender = await msg.getSender();
    if (sender instanceof Api.User && sender.bot) {
      return;
    }

    await AutoRepeatManager.checkAndRepeat(msg);
  };
}

// 导出插件实例
export default new AutoRepeatPlugin();  // 修改实例名

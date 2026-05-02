import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api, TelegramClient } from "teleproto";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


// ==================== 配置常量 ====================
const CONFIG = {
  BATCH_SIZE: 50, // 增加批次大小
  PARALLEL_LIMIT: 20, // 增加并发数
  DEFAULT_MUTE_DURATION: 0, // 0表示永久禁言
  MESSAGE_AUTO_DELETE: 10,
  PER_GROUP_SCAN_LIMIT: 2000,
  CACHE_DB_NAME: "aban_cache.json"
};

// ==================== 帮助文本 ====================
const HELP_TEXT = `<b>封禁管理</b>

<code>${mainPrefix}kick</code> 踢出
<code>${mainPrefix}ban</code> 封禁  
<code>${mainPrefix}unban</code> 解封
<code>${mainPrefix}mute [time]</code> 禁言 (如 60s/5m/1h/1d，不填则永久)
<code>${mainPrefix}unmute</code> 解禁言
<code>${mainPrefix}sb</code> 批量封禁
<code>${mainPrefix}unsb</code> 批量解封
<code>${mainPrefix}refresh</code> 刷新

回复消息或@用户名`;

// ==================== 工具函数 ====================
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#x27;'
  }[m] || m));

// 解析时间字符串
function parseTimeString(timeStr?: string): number {
  if (!timeStr) return 0; // 无参数返回0（永久）
  
  const time = timeStr.toLowerCase();
  const num = parseInt(time) || 0;
  
  if (time.includes('d')) return num * 86400;
  if (time.includes('h')) return num * 3600;
  if (time.includes('m')) return num * 60;
  if (time.includes('s')) return num;
  
  return 0; // 默认永久
}

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

  async clear(): Promise<void> {
    await this.initPromise;
    if (!this.db) return;
    this.db.data.cache = {};
    await this.db.write();
  }
}

// ==================== 用户解析器 ====================
class UserResolver {
  static async resolveTarget(
    client: TelegramClient,
    message: Api.Message,
    args: string[]
  ): Promise<{ user: any; uid: number | null }> {
    // 从参数解析
    if (args.length > 0) {
      const target = args[0];
      return await this.resolveFromString(client, target);
    }
    
    // 从回复消息解析
    const reply = await message.getReplyMessage();
    if (reply?.senderId) {
      return {
        user: reply.sender,
        uid: Number(reply.senderId)
      };
    }
    
    return { user: null, uid: null };
  }

  private static async resolveFromString(
    client: TelegramClient,
    target: string
  ): Promise<{ user: any; uid: number | null }> {
    try {
      // @username 格式
      if (target.startsWith("@")) {
        const entity = await client.getEntity(target);
        return { user: entity, uid: entity?.id ? Number(entity.id) : null };
      }
      
      // 纯数字 ID
      if (/^-?\d+$/.test(target)) {
        const userId = parseInt(target);
        const entity = await client.getEntity(userId);
        return { user: entity, uid: userId };
      }
    } catch (error) {
      console.error(`[UserResolver] 解析失败: ${error}`);
    }
    
    return { user: null, uid: null };
  }

  static formatUser(user: any, userId: number): string {
    if (user?.firstName || user?.first_name) {
      let name = user.firstName || user.first_name || String(userId);
      if (user.lastName || user.last_name) {
        name += ` ${user.lastName || user.last_name}`;
      }
      if (user.username) {
        name += ` (@${user.username})`;
      }
      return name;
    } else if (user?.title) {
      return `频道: ${user.title}${user.username ? ` (@${user.username})` : ''}`;
    }
    return String(userId);
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
        const rights = p.adminRights;
        return !!(rights?.banUsers || rights?.deleteMessages);
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  static async isTargetAdmin(
    client: TelegramClient,
    chatId: any,
    userId: number
  ): Promise<boolean> {
    try {
      const participant = await client.invoke(
        new Api.channels.GetParticipant({
          channel: chatId,
          participant: userId
        })
      );
      
      const p = participant.participant;
      return (
        p instanceof Api.ChannelParticipantCreator ||
        p instanceof Api.ChannelParticipantAdmin
      );
    } catch (error) {
      return false;
    }
  }

  static async canDeleteMessages(
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
        return !!p.adminRights?.deleteMessages;
      }
      return false;
    } catch {
      return false;
    }
  }
}

// ==================== 群组管理器 ====================
class GroupManager {
  private static cache = CacheManager.getInstance();

  private static async getAllManageableDialogs(client: TelegramClient): Promise<any[]> {
    const dialogMap = new Map<number, any>();

    const collectDialogs = async (params: Record<string, any>) => {
      const dialogs = await client.getDialogs(params);
      for (const dialog of dialogs || []) {
        if (dialog.isChannel || dialog.isGroup) {
          dialogMap.set(Number(dialog.id), dialog);
        }
      }
    };

    await collectDialogs({});
    await collectDialogs({ folderId: 1 });

    return Array.from(dialogMap.values());
  }

  static async getManagedGroups(
    client: TelegramClient
  ): Promise<Array<{ id: number; title: string }>> {
    // 尝试从缓存获取
    const cached = await this.cache.get("managed_groups");
    if (cached) return cached;

    const groups: Array<{ id: number; title: string }> = [];
    
    try {
      const dialogs = await this.getAllManageableDialogs(client);
      
      // 并发检查权限
      const checkPromises = dialogs.map(async (dialog: any) => {
        if (dialog.isChannel || dialog.isGroup) {
          const hasPermission = await PermissionManager.checkAdminPermission(
            client,
            dialog.entity
          );
          
          if (hasPermission) {
            return {
              id: Number(dialog.id),
              title: dialog.title || "Unknown"
            };
          }
        }
        return null;
      });
      
      const results = await Promise.all(checkPromises);
      groups.push(...results.filter((g: any): g is { id: number; title: string } => g !== null));
      
      try {
        await this.cache.set("managed_groups", groups);
      } catch (cacheError) {
        console.error(`[GroupManager] 缓存群组失败: ${cacheError}`);
      }
    } catch (error) {
      console.error(`[GroupManager] 获取群组失败: ${error}`);
    }
    
    return groups;
  }

  static async clearCache(): Promise<void> {
    await this.cache.clear();
  }
}

// ==================== 封禁操作管理器 ====================
class BanManager {
  static async banUser(
    client: TelegramClient,
    chatId: any,
    userId: number,
    until: number = 0
  ): Promise<boolean> {
    try {
      const rights = new Api.ChatBannedRights({
        untilDate: until,
        viewMessages: true,
        sendMessages: true,
        sendMedia: true,
        sendStickers: true,
        sendGifs: true,
        sendGames: true,
        sendInline: true,
        embedLinks: true,
      });

      await client.invoke(
        new Api.channels.EditBanned({
          channel: chatId,
          participant: userId,
          bannedRights: rights,
        })
      );
      return true;
    } catch (error) {
      // 静默处理常见错误
      return false;
    }
  }

  static async unbanUser(
    client: TelegramClient,
    chatId: any,
    userId: number
  ): Promise<boolean> {
    try {
      const rights = new Api.ChatBannedRights({
        untilDate: 0,
      });

      await client.invoke(
        new Api.channels.EditBanned({
          channel: chatId,
          participant: userId,
          bannedRights: rights,
        })
      );
      return true;
    } catch (error) {
      console.error(`[BanManager] 解封失败: ${error}`);
      return false;
    }
  }

  static async muteUser(
    client: TelegramClient,
    chatId: any,
    userId: number,
    duration: number
  ): Promise<boolean> {
    try {
      const until = duration === 0 ? 0 : Math.floor(Date.now() / 1000) + duration;
      const rights = new Api.ChatBannedRights({
        untilDate: until,
        sendMessages: true,
        sendMedia: true,
        sendStickers: true,
        sendGifs: true,
        sendGames: true,
        sendInline: true,
        embedLinks: true,
      });

      await client.invoke(
        new Api.channels.EditBanned({
          channel: chatId,
          participant: userId,
          bannedRights: rights,
        })
      );
      return true;
    } catch (error) {
      console.error(`[BanManager] 禁言失败: ${error}`);
      return false;
    }
  }

  static async kickUser(
    client: TelegramClient,
    chatId: any,
    userId: number
  ): Promise<boolean> {
    try {
      // 先封禁
      await this.banUser(client, chatId, userId);
      // 立即解封
      await this.unbanUser(client, chatId, userId);
      return true;
    } catch (error) {
      console.error(`[BanManager] 踢出失败: ${error}`);
      return false;
    }
  }

  // 删除用户在当前会话的消息（sb命令优化）
  static async deleteHistoryInCurrentChat(
    client: TelegramClient,
    chatId: any,
    userId: number
  ): Promise<boolean> {
    try {
      const canDelete = await PermissionManager.canDeleteMessages(client, chatId);
      if (!canDelete) {
        console.log(`[BanManager] 无删除消息权限`);
        return false;
      }

      // 获取用户实体
      const userEntity = await client.getEntity(userId);
      
      await client.invoke(
        new Api.channels.DeleteParticipantHistory({
          channel: chatId,
          participant: userEntity,
        })
      );
      
      console.log(`[BanManager] 成功删除用户 ${userId} 在当前会话的所有消息`);
      return true;
    } catch (error: any) {
      // 静默处理常见错误
      if (!/CHANNEL_INVALID|CHAT_ADMIN_REQUIRED/.test(error?.message || "")) {
        console.error(`[BanManager] 删除消息失败: ${error?.message}`);
      }
      return false;
    }
  }

  // 批量封禁操作（极速版本）
  static async batchBanUser(
    client: TelegramClient,
    groups: Array<{ id: number; title: string }>,
    userId: number,
    reason: string = "跨群违规"
  ): Promise<{ success: number; failed: number; failedGroups: string[] }> {
    // 预创建权限对象
    const rights = new Api.ChatBannedRights({
      untilDate: 0,
      viewMessages: true,
      sendMessages: true,
      sendMedia: true,
      sendStickers: true,
      sendGifs: true,
      sendGames: true,
      sendInline: true,
      embedLinks: true,
    });
    
    // 全并发执行所有封禁请求
    const taskPromises = groups.map((group) => {
      return client.invoke(new Api.channels.EditBanned({
        channel: group.id,
        participant: userId,
        bannedRights: rights,
      }))
      .then(() => ({ success: true, group }))
      .catch(() => ({ success: false, group }));
    });

    // 设置3秒超时
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT')), 3000);
    });

    let results: Array<{ success: boolean; group: { id: number; title: string } }>;
    
    try {
      results = await Promise.race([
        Promise.all(taskPromises),
        timeoutPromise
      ]);
    } catch {
      // 超时后等待已发送的请求
      await new Promise(resolve => setTimeout(resolve, 500));
      const settled = await Promise.allSettled(taskPromises);
      results = settled
        .filter((r): r is PromiseFulfilledResult<{ success: boolean; group: { id: number; title: string } }> => 
          r.status === 'fulfilled')
        .map(r => r.value);
    }
    
    // 快速统计
    let success = 0;
    let failed = 0;
    const failedGroups: string[] = [];
    
    results.forEach((result) => {
      if (result.success) {
        success++;
      } else {
        failed++;
        failedGroups.push(result.group.title);
      }
    });

    return { success, failed, failedGroups };
  }

  // 批量解封操作（全并发版本）
  static async batchUnbanUser(
    client: TelegramClient,
    groups: Array<{ id: number; title: string }>,
    userId: number
  ): Promise<{ success: number; failed: number; failedGroups: string[] }> {
    const rights = new Api.ChatBannedRights({
      untilDate: 0,
    });

    // 全并发执行所有解封请求
    const promises = groups.map(group => 
      client.invoke(
        new Api.channels.EditBanned({
          channel: group.id,
          participant: userId,
          bannedRights: rights,
        })
      ).then(() => ({ success: true, group }))
       .catch(() => ({ success: false, group }))
    );

    // 3秒超时机制
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT')), 3000);
    });

    let results: Array<{ success: boolean; group: { id: number; title: string } }>;
    
    try {
      results = await Promise.race([
        Promise.all(promises),
        timeoutPromise
      ]);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
      const settled = await Promise.allSettled(promises);
      results = settled
        .filter((r): r is PromiseFulfilledResult<{ success: boolean; group: { id: number; title: string } }> => 
          r.status === 'fulfilled')
        .map(r => r.value);
    }
    
    // 快速统计
    let success = 0;
    let failed = 0;
    const failedGroups: string[] = [];
    
    results.forEach((result) => {
      if (result.success) {
        success++;
      } else {
        failed++;
        failedGroups.push(result.group.title);
      }
    });

    return { success, failed, failedGroups };
  }
}

// ==================== 命令处理器 ====================
class CommandHandlers {
  // 单群基础命令处理
  static async handleBasicCommand(
    client: TelegramClient,
    message: Api.Message,
    action: 'kick' | 'ban' | 'unban' | 'mute' | 'unmute'
  ): Promise<void> {
    try {
      // 权限检查
      const hasPermission = await PermissionManager.checkAdminPermission(
        client,
        message.peerId
      );
      
      if (!hasPermission) {
        await MessageManager.smartEdit(message, "❌ 无管理员权限");
        return;
      }

      // 解析参数
      const args = message.message?.split(" ").slice(1) || [];
      const { user, uid } = await UserResolver.resolveTarget(client, message, args);

      if (!uid) {
        await MessageManager.smartEdit(message, "❌ 获取用户失败");
        return;
      }

      // 检查目标是否为管理员
      const isAdmin = await PermissionManager.isTargetAdmin(client, message.peerId, uid);
      if (isAdmin) {
        const hasConfirm = args.includes('true');
        if (!hasConfirm) {
          await MessageManager.smartEdit(message, "⚠️ 目标是管理员，请在命令后加上 <code>true</code> 确认执行");
          return;
        }
      }

      const display = UserResolver.formatUser(user, uid);
      const status = await MessageManager.smartEdit(
        message,
        `⏳ ${this.getActionName(action)}${htmlEscape(display)}...`,
        0
      );

      let success = false;
      let resultText = "";

      switch (action) {
        case 'kick':
          success = await BanManager.kickUser(client, message.peerId, uid);
          resultText = `✅ 已踢出 ${htmlEscape(display)}`;
          break;
        case 'ban':
          // 先删除消息，再封禁
          const deleteSuccess = await BanManager.deleteHistoryInCurrentChat(client, message.peerId, uid);
          success = await BanManager.banUser(client, message.peerId, uid);
          const deleteText = deleteSuccess ? '(已清理消息)' : '';
          resultText = `✅ 已封禁 ${htmlEscape(display)} ${deleteText}`;
          break;
        case 'unban':
          success = await BanManager.unbanUser(client, message.peerId, uid);
          resultText = `✅ 已解封 ${htmlEscape(display)}`;
          break;
        case 'mute':
          const duration = parseTimeString(args[1]);
          success = await BanManager.muteUser(client, message.peerId, uid, duration);
          const durationText = duration === 0 ? '永久' : this.formatDuration(duration);
          resultText = `✅ 已禁言 ${htmlEscape(display)} ${durationText}`;
          break;
        case 'unmute':
          success = await BanManager.unbanUser(client, message.peerId, uid);
          resultText = `✅ 已解禁言 ${htmlEscape(display)}`;
          break;
      }

      if (success) {
        await MessageManager.smartEdit(status, resultText);
      } else {
        await MessageManager.smartEdit(status, `❌ ${this.getActionName(action)}失败`);
      }
    } catch (error: any) {
      await MessageManager.smartEdit(message, `❌ 操作失败：${htmlEscape(error.message)}`);
    }
  }

  private static getActionName(action: string): string {
    const names: Record<string, string> = {
      kick: '踢出', ban: '封禁', unban: '解封',
      mute: '禁言', unmute: '解除禁言'
    };
    return names[action] || action;
  }

  private static formatDuration(seconds: number): string {
    if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
    return `${seconds}s`;
  }

  // sb命令：即时返回+后台处理
  static async handleSuperBan(
    client: TelegramClient,
    message: Api.Message
  ): Promise<void> {
    try {
      const args = message.message?.split(" ").slice(1) || [];
      const { user, uid } = await UserResolver.resolveTarget(client, message, args);

      if (!uid) {
        await MessageManager.smartEdit(message, "❌ 获取用户失败");
        return;
      }

      // 检查目标是否为当前群管理员
      const isAdmin = await PermissionManager.isTargetAdmin(client, message.peerId, uid);
      if (isAdmin) {
        const hasConfirm = args.includes('true');
        if (!hasConfirm) {
          await MessageManager.smartEdit(message, "⚠️ 目标是管理员，请在命令后加上 <code>true</code> 确认执行");
          return;
        }
      }

      const display = UserResolver.formatUser(user, uid);
      const groups = await GroupManager.getManagedGroups(client);
      
      if (groups.length === 0) {
        await MessageManager.smartEdit(message, "❌ 无管理群组");
        return;
      }

      // 立即返回处理中状态
      const status = await MessageManager.smartEdit(
        message,
        `⚡ 在${groups.length}个频道/群组中封禁该用户...`,
        0
      );

      // 后台处理：不等待结果，立即启动
      const backgroundProcess = async () => {
        const startTime = Date.now();
        
        // 并发执行删除和封禁
        const [deletedInCurrent, banResult] = await Promise.allSettled([
          BanManager.deleteHistoryInCurrentChat(client, message.peerId, uid),
          BanManager.batchBanUser(client, groups, uid, args.slice(1).join(" ") || "违规")
        ]);

        const elapsed = (Date.now() - startTime) / 1000;
        
        // 处理结果
        const deleteSuccess = deletedInCurrent.status === 'fulfilled' && deletedInCurrent.value;
        const { success = 0, failed = groups.length } = 
          banResult.status === 'fulfilled' ? banResult.value : {};

        // 更新最终结果
        const result = `✅ 在${success}个频道/群组中封禁该用户 ${htmlEscape(display)}\n🗑️当前群组消息: ${deleteSuccess ? '✓已清理' : '✗'} | ⏱️${elapsed.toFixed(1)}s`;
        
        // 更新为最终结果
        setTimeout(() => {
          MessageManager.smartEdit(status, result, 30).catch(() => {});
        }, 100);
      };

      // 后台执行，不等待
      backgroundProcess().catch(() => {});

    } catch (error: any) {
      await MessageManager.smartEdit(message, `❌ ${error.message}`);
    }
  }

  // unsb命令：即时返回+后台处理
  static async handleSuperUnban(
    client: TelegramClient,
    message: Api.Message
  ): Promise<void> {
    try {
      const args = message.message?.split(" ").slice(1) || [];
      const { user, uid } = await UserResolver.resolveTarget(client, message, args);

      if (!uid) {
        await MessageManager.smartEdit(message, "❌ 获取用户失败");
        return;
      }

      // 检查目标是否为当前群管理员
      const isAdmin = await PermissionManager.isTargetAdmin(client, message.peerId, uid);
      if (isAdmin) {
        const hasConfirm = args.includes('true');
        if (!hasConfirm) {
          await MessageManager.smartEdit(message, "⚠️ 目标是管理员，请在命令后加上 <code>true</code> 确认执行");
          return;
        }
      }

      const display = UserResolver.formatUser(user, uid);
      const groups = await GroupManager.getManagedGroups(client);
      
      if (groups.length === 0) {
        await MessageManager.smartEdit(message, "❌ 无管理群组");
        return;
      }

      // 立即返回处理中状态
      const status = await MessageManager.smartEdit(
        message,
        `🔓 在${groups.length}个频道/群组中解封该用户...`,
        0
      );

      // 后台处理
      const backgroundProcess = async () => {
        const startTime = Date.now();
        const { success = 0, failed = groups.length } = 
          await BanManager.batchUnbanUser(client, groups, uid).catch(() => ({ success: 0, failed: groups.length }));
        
        const elapsed = (Date.now() - startTime) / 1000;
        const result = `✅ 在${success}个频道/群组中解封该用户 ${htmlEscape(display)} | ⏱️${elapsed.toFixed(1)}s`;
        
        setTimeout(() => {
          MessageManager.smartEdit(status, result, 30).catch(() => {});
        }, 100);
      };

      backgroundProcess().catch(() => {});
    } catch (error: any) {
      await MessageManager.smartEdit(message, `❌ ${error.message}`);
    }
  }
}

// ==================== 插件主类 ====================
class AbanPlugin extends Plugin {
  cleanup(): void {
  }

  description: string = HELP_TEXT;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    // 帮助命令
    aban: async (msg) => {
      await MessageManager.smartEdit(msg, HELP_TEXT);
    },

    // 基础管理命令
    kick: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'kick');
    },

    ban: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'ban');
    },

    unban: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'unban');
    },

    mute: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'mute');
    },

    unmute: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'unmute');
    },

    // 批量管理命令
    sb: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleSuperBan(client, msg);
    },

    unsb: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleSuperUnban(client, msg);
    },

    // 系统命令
    refresh: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }

      const status = await MessageManager.smartEdit(msg, "🔄 刷新中...", 0);
      
      try {
        GroupManager.clearCache();
        const groups = await GroupManager.getManagedGroups(client);
        await MessageManager.smartEdit(status, `✅ 已刷新 ${groups.length}个群组`);
      } catch (error: any) {
        await MessageManager.smartEdit(status, `❌ 刷新失败`);
      }
    }
  };
}

// 导出插件实例
export default new AbanPlugin();

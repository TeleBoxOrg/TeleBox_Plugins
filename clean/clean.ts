// file name: clean.ts
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { banUser, getBannedUsers, unbanUser } from "@utils/banUtils";

// HTML 转义函数（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 延迟函数
const sleep = (ms: number): Promise<void> => 
  new Promise(resolve => setTimeout(resolve, ms));

// 帮助文本
const HELP_TEXT = `🧹 <b>清理工具 Pro</b>

<b>📝 功能概述:</b>
• <b>删除账号清理</b>: 扫描并清理已注销/删除的账号
• <b>拉黑用户清理</b>: 解除双向拉黑状态
• <b>被封禁实体解封</b>: 解封群组中被封禁的用户/频道/群组

<b>🔧 命令列表:</b>

<u>删除账号清理:</u>
• <code>.clean deleted pm</code> - 扫描私聊中的已注销账号
• <code>.clean deleted pm rm</code> - 扫描并删除已注销账号的私聊
• <code>.clean deleted member</code> - 扫描群组中的已注销账号
• <code>.clean deleted member rm</code> - 扫描并清理群组已注销账号

<u>拉黑用户清理:</u>
• <code>.clean blocked pm</code> - 清理拉黑用户（智能模式）
• <code>.clean blocked pm all</code> - 清理所有拉黑用户（全量模式）

<u>被封禁实体解封:</u>
• <code>.clean blocked member</code> - 解封自己封禁的实体
• <code>.clean blocked member all</code> - 解封所有被封禁的实体

<u>帮助信息:</u>
• <code>.clean help</code> - 显示此帮助信息

<b>⚡ 智能清理模式:</b>
• 跳过机器人、诈骗账户、虚假账户
• 自动处理 API 限制
• 实时进度显示

<b>📊 数据统计:</b>
• 处理总数、成功数、失败数、跳过数
• 实体类型统计（用户/频道/群组）
• 清理成功率

<b>⚠️ 权限要求:</b>
• 群组操作需要管理员权限
• 封禁清理需要封禁用户权限
• 私聊清理仅操作机器人自身对话`;

class CleanPlugin extends Plugin {
  // 插件配置
  private readonly PLUGIN_NAME = "clean";
  private readonly PLUGIN_VERSION = "2.0.0";
  
  // 清理进度状态
  private cleanupStartTime: number = 0;
  private blockedCleanupStartTime: number = 0;

  constructor() {
    super();
    this.description = HELP_TEXT;
    this.cmdHandlers = {
      clean: this.handleClean.bind(this)
    };
  }

  // 主命令处理器
  private async handleClean(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await this.editMessage(msg, "❌ 客户端未就绪");
      return;
    }

    try {
      const text = msg.text || "";
      const parts = text.trim().split(/\s+/);
      const subCommand = parts[1]?.toLowerCase();

      // 显示帮助
      if (!subCommand || subCommand === "help" || subCommand === "h") {
        await this.editMessage(msg, HELP_TEXT);
        return;
      }

      await this.editMessage(msg, "🔄 正在处理请求...");

      // 路由到对应功能模块
      switch (subCommand) {
        case "deleted":
          await this.handleDeletedClean(client, msg, parts);
          break;
        case "blocked":
          await this.handleBlockedClean(client, msg, parts);
          break;
        default:
          await this.sendError(msg, `未知子命令: ${htmlEscape(subCommand)}`);
          break;
      }

    } catch (error: any) {
      await this.handleError(msg, error);
    }
  }

  // 处理删除账号清理
  private async handleDeletedClean(client: any, msg: Api.Message, parts: string[]): Promise<void> {
    const action = parts[2]?.toLowerCase();
    const operation = parts[3]?.toLowerCase();

    if (!action) {
      await this.sendError(msg, "请指定清理类型: pm (私聊) 或 member (群组)");
      return;
    }

    switch (action) {
      case "pm":
        await this.cleanDeletedPM(client, msg, operation === "rm");
        break;
      case "member":
        await this.cleanDeletedMember(client, msg, operation === "rm");
        break;
      default:
        await this.sendError(msg, `未知类型: ${htmlEscape(action)}`);
        break;
    }
  }

  // 处理拉黑/解封清理
  private async handleBlockedClean(client: any, msg: Api.Message, parts: string[]): Promise<void> {
    const action = parts[2]?.toLowerCase();
    const mode = parts[3]?.toLowerCase();

    if (!action) {
      await this.sendError(msg, "请指定清理类型: pm (私聊拉黑) 或 member (群组封禁)");
      return;
    }

    switch (action) {
      case "pm":
        await this.cleanBlockedPM(client, msg, mode === "all");
        break;
      case "member":
        await this.unblockMember(client, msg, mode === "all");
        break;
      default:
        await this.sendError(msg, `未知类型: ${htmlEscape(action)}`);
        break;
    }
  }

// 私聊已注销账号清理 - 修复版：直接移除整个对话
  private async cleanDeletedPM(client: any, msg: Api.Message, deleteDialogs: boolean = false): Promise<void> {
    await this.editMessage(msg, deleteDialogs 
      ? "🔍 正在扫描并从对话列表中移除已注销账号..." 
      : "🔍 正在扫描私聊已注销账号...");

    const deletedUsers: Array<{id: string, username?: string}> = [];
    
    try {
      // 获取所有对话列表
      const dialogs = await client.getDialogs({});
      
      for (const dialog of dialogs) {
        // 检查是否为用户，且该用户实体标记为已注销
        if (dialog.isUser && dialog.entity instanceof Api.User && dialog.entity.deleted) {
          const user = dialog.entity;
          const userId = user.id.toString();
          deletedUsers.push({ 
            id: userId, 
            username: user.username || "已注销账号" 
          });
          
          if (deleteDialogs) {
            try {
              /**
               * 修复核心：
               * 1. 使用 dialog.inputEntity 确保 ID 类型在 API 层级完全匹配。
               * 2. 不传任何参数（默认不开启 revoke），直接从本地对话列表中移除该会话。
               * 3. 针对已注销账号，开启 revoke 反而会导致删除失败。
               */
              await client.deleteDialog(dialog.inputEntity);
              
              // 稍微延迟，防止触发 Telegram API 的频率限制
              await sleep(150);
            } catch (error: any) {
              console.error(`[Clean] 无法移除对话 ${userId}:`, error.message);
              if (error.message?.includes("FLOOD_WAIT")) {
                await this.handleFloodWait(msg, error);
                return;
              }
            }
          }
        }
      }

      // 构建结果反馈
      let result = "";
      if (deletedUsers.length === 0) {
        result = "✅ <b>扫描完成</b>\n\n对话列表中未发现已注销账号。";
      } else {
        result = deleteDialogs 
          ? `✅ <b>清理完成</b>\n\n已从列表移除 <code>${deletedUsers.length}</code> 个已注销对话:\n\n`
          : `✅ <b>扫描完成</b>\n\n共找到 <code>${deletedUsers.length}</code> 个已注销对话:\n\n`;
        
        // 仅展示前 15 条
        deletedUsers.slice(0, 15).forEach((user) => {
          result += `• <a href="tg://user?id=${user.id}">已注销账号</a> (ID: <code>${user.id}</code>)\n`;
        });
        
        if (deletedUsers.length > 15) {
          result += `\n... 以及其他 ${deletedUsers.length - 15} 个会话\n`;
        }
        
        if (!deleteDialogs) {
          result += `\n💡 使用 <code>.clean deleted pm rm</code> 直接移除这些对话`;
        }
      }

      await this.editMessage(msg, result);

    } catch (error: any) {
      await this.handleError(msg, error);
    }
  }

  // 群组已注销账号清理
  private async cleanDeletedMember(client: any, msg: Api.Message, cleanMembers: boolean = false): Promise<void> {
    const chat = await msg.getChat();
    if (!chat || !(chat instanceof Api.Chat || chat instanceof Api.Channel)) {
      await this.sendError(msg, "此命令仅在群组中可用");
      return;
    }

    await this.editMessage(msg, cleanMembers 
      ? "🔍 正在扫描并清理群组已注销账号..." 
      : "🔍 正在扫描群组已注销账号...");

    const chatId = chat.id;
    if (cleanMembers && !await this.checkBanPermission(client, chatId)) {
      await this.sendError(msg, "没有封禁用户权限，无法执行清理");
      return;
    }

    let deletedCount = 0;
    const deletedUsers: Array<{id: string, username?: string}> = [];

    const participants = client.iterParticipants(chatId);
    for await (const participant of participants) {
      if (participant instanceof Api.User && participant.deleted) {
        deletedCount++;
        deletedUsers.push({ 
          id: participant.id.toString(), 
          username: participant.username || "未知" 
        });
        
        if (cleanMembers) {
          try {
            await banUser(client, chatId, participant.id);
            await sleep(100);
          } catch (error: any) {
            if (error.message?.includes("FLOOD_WAIT")) {
              await this.handleFloodWait(msg, error);
              return;
            }
          }
        }
      }
    }

    let result = "";
    if (deletedCount === 0) {
      result = "✅ <b>扫描完成</b>\n\n此群组中没有发现已注销账号。";
    } else {
      result = cleanMembers 
        ? `✅ <b>清理完成</b>\n\n已清理 <code>${deletedCount}</code> 个已注销账号:\n\n`
        : `✅ <b>扫描完成</b>\n\n此群组的已注销账号数: <code>${deletedCount}</code>:\n\n`;
      
      deletedUsers.slice(0, 15).forEach(user => {
        result += `• <a href="tg://user?id=${user.id}">${user.id}</a>\n`;
      });
      
      if (deletedCount > 15) {
        result += `\n... 还有 ${deletedCount - 15} 个未显示\n`;
      }
      
      if (!cleanMembers) {
        result += `\n💡 使用 <code>.clean deleted member rm</code> 清理这些已注销账号`;
      }
    }

    await this.editMessage(msg, result);
  }

  // 拉黑用户清理
  private async cleanBlockedPM(client: any, msg: Api.Message, includeAll: boolean = false): Promise<void> {
    this.blockedCleanupStartTime = Date.now();
    
    await this.editMessage(msg, 
      `🧹 开始清理拉黑用户\n\n模式: ${includeAll ? '全量清理' : '智能清理'}`);

    let offset = 0;
    let success = 0, failed = 0, skipped = 0, totalUsers = 0, processedUsers = 0;
    let consecutiveErrors = 0;

    // 获取总数
    try {
      const initialBlocked = await client.invoke(new Api.contacts.GetBlocked({ offset: 0, limit: 1 }));
      totalUsers = initialBlocked.className === 'contacts.BlockedSlice' 
        ? (initialBlocked as any).count || 0 
        : (await client.invoke(new Api.contacts.GetBlocked({ offset: 0, limit: 1000 })))?.users?.length || 0;
    } catch (error) {
      console.error("获取用户总数失败:", error);
    }

    while (true) {
      try {
        const blocked = await client.invoke(new Api.contacts.GetBlocked({ offset, limit: 100 }));
        if (!blocked.users?.length) break;

        for (const user of blocked.users) {
          processedUsers++;
          
          // 智能模式跳过机器人/诈骗账户
          if (!includeAll && (user.bot || user.scam || user.fake)) {
            skipped++;
            continue;
          }

          try {
            await client.invoke(new Api.contacts.Unblock({ id: user }));
            success++;
            
            // 动态延迟
            const delay = this.getDynamicDelay(user, includeAll, consecutiveErrors);
            await sleep(delay);
            consecutiveErrors = 0;
          } catch (error: any) {
            if (error.message?.includes('FLOOD_WAIT_')) {
              await this.handleFloodWait(msg, error);
              continue;
            } else {
              failed++;
              consecutiveErrors++;
              await sleep(this.getDynamicDelay(user, includeAll, consecutiveErrors));
            }
          }

          // 更新进度
          if (processedUsers % 10 === 0) {
            await this.updateBlockedProgress(msg, processedUsers, totalUsers, success, failed, skipped, includeAll);
          }
        }

        offset += 100;
        if (blocked.className === 'contacts.BlockedSlice' && offset >= (blocked as any).count) break;
        
        // 批次间延迟
        const batchDelay = consecutiveErrors > 0 ? 3000 + (consecutiveErrors * 1000) : 2000;
        await sleep(Math.min(batchDelay, 10000));

      } catch (error: any) {
        console.error("获取拉黑列表失败:", error);
        if (error.message?.includes('FLOOD_WAIT')) {
          await this.handleFloodWait(msg, error);
          continue;
        }
        break;
      }
    }

    const result = this.buildBlockedResult(success, failed, skipped, totalUsers, includeAll);
    await this.editMessage(msg, result);
  }

  // 群组解封
  private async unblockMember(client: any, msg: Api.Message, includeAll: boolean = false): Promise<void> {
    if (!msg.isChannel && !msg.isGroup) {
      await this.sendError(msg, "此命令只能在群组中使用");
      return;
    }

    await this.editMessage(msg, "🔓 正在获取被封禁实体列表...");

    const me = await client.getMe();
    const myId = Number(me.id);
    const chatEntity = msg.peerId;
    
    let bannedUsers = await getBannedUsers(client, chatEntity);
    if (!includeAll) {
      bannedUsers = bannedUsers.filter(u => u.kickedBy === myId);
    }
    
    if (bannedUsers.length === 0) {
      await this.editMessage(msg, "ℹ️ 没有找到需要解封的实体");
      await sleep(3000);
      await this.safeDelete(msg);
      return;
    }

    await this.editMessage(msg, `⚡ 正在解封 ${bannedUsers.length} 个实体...`);
    
    const entityStats = { users: 0, channels: 0, chats: 0 };
    bannedUsers.forEach(entity => {
      if (entity.type === 'user') entityStats.users++;
      else if (entity.type === 'channel') entityStats.channels++;
      else if (entity.type === 'chat') entityStats.chats++;
    });
    
    let successCount = 0, failedCount = 0;
    const failedEntities: string[] = [];
    
    for (const entity of bannedUsers) {
      const success = await unbanUser(client, chatEntity, entity.id);
      if (success) {
        successCount++;
      } else {
        failedCount++;
        const displayName = entity.type === 'user' 
          ? `${entity.firstName}(${entity.id})` 
          : `${entity.title || entity.firstName}[${entity.type}](${entity.id})`;
        failedEntities.push(displayName);
      }
      await sleep(500);
    }
    
    let statsText = "";
    if (entityStats.users > 0) statsText += `👤 用户: ${entityStats.users} `;
    if (entityStats.channels > 0) statsText += `📢 频道: ${entityStats.channels} `;
    if (entityStats.chats > 0) statsText += `💬 群组: ${entityStats.chats}`;
    
    let resultText = "";
    if (failedCount > 0) {
      resultText = `✅ <b>解封完成</b>\n\n${statsText}\n成功: <code>${successCount}</code> 个\n失败: <code>${failedCount}</code> 个`;
    } else {
      resultText = `✅ <b>解封完成</b>\n\n${statsText}\n已成功解封 <code>${successCount}</code> 个实体`;
    }
    
    await this.editMessage(msg, resultText);
    await sleep(5000);
    await this.safeDelete(msg);
  }

  // 工具函数
  private async editMessage(msg: Api.Message, text: string): Promise<void> {
    try {
      await msg.edit({ text, parseMode: "html" });
    } catch (error) {
      console.error("编辑消息失败:", error);
    }
  }

  private async sendError(msg: Api.Message, errorMsg: string): Promise<void> {
    await this.editMessage(msg, `❌ <b>错误:</b> ${htmlEscape(errorMsg)}`);
  }

  private async handleError(msg: Api.Message, error: any): Promise<void> {
    console.error(`[CleanPlugin] 错误:`, error);
    
    let errorMsg = `❌ <b>操作失败:</b> ${htmlEscape(error.message || "未知错误")}`;
    
    if (error.message?.includes("FLOOD_WAIT")) {
      const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
      errorMsg = `⏳ <b>请求过于频繁</b>\n\n需要等待 ${waitTime} 秒后重试`;
    } else if (error.message?.includes("CHAT_ADMIN_REQUIRED")) {
      errorMsg = "🔒 <b>权限不足</b>\n\n需要管理员权限";
    } else if (error.message?.includes("USER_NOT_PARTICIPANT")) {
      errorMsg = "❌ <b>未加入群组</b>\n\n机器人需要先加入群组";
    }
    
    await this.editMessage(msg, errorMsg);
  }

  private async handleFloodWait(msg: Api.Message, error: any): Promise<void> {
    const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
    await this.editMessage(msg, `⏳ 需要等待 ${waitTime} 秒后继续`);
    await sleep((waitTime + 1) * 1000);
  }

  private async safeDelete(msg: Api.Message): Promise<void> {
    try {
      await msg.delete({ revoke: true });
    } catch (error) {
      // 忽略删除错误
    }
  }

  private getDynamicDelay(user: any, includeAll: boolean, consecutiveErrors: number): number {
    let delay = 200;
    
    if (user.bot) delay = 1500;
    else if (user.scam || user.fake) delay = 800;
    
    if (includeAll) delay = Math.max(delay, 1000);
    if (consecutiveErrors > 0) delay = delay * (1 + consecutiveErrors * 0.5);
    
    return Math.min(delay, 5000);
  }

  private async updateBlockedProgress(msg: Api.Message, processed: number, total: number, 
                                    success: number, failed: number, skipped: number, includeAll: boolean): Promise<void> {
    try {
      const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
      const progressBar = '█'.repeat(Math.round((percentage / 100) * 20)) + '░'.repeat(20 - Math.round((percentage / 100) * 20));
      
      const progressText = `🧹 <b>清理拉黑用户进行中</b>

📊 <b>进度:</b> ${percentage}% (${processed}/${total})
${progressBar}

📈 <b>统计:</b>
• ✅ 成功: ${success}
• ❌ 失败: ${failed}
• ⏭️ 跳过: ${skipped}

⚙️ <b>模式:</b> ${includeAll ? '全量清理' : '智能清理'}

⏱️ <b>剩余时间:</b> ${this.estimateRemainingTime(processed, total, Date.now() - this.blockedCleanupStartTime)}`;

      await this.editMessage(msg, progressText);
    } catch (e) {
      // 忽略编辑错误
    }
  }

  private estimateRemainingTime(processed: number, total: number, elapsedMs: number): string {
    if (processed === 0 || total === 0) return "计算中...";
    
    const avgTimePerUser = elapsedMs / processed;
    const remaining = total - processed;
    const estimatedMs = avgTimePerUser * remaining;
    
    if (estimatedMs < 1000) return "即将完成";
    if (estimatedMs < 60000) return `约 ${Math.ceil(estimatedMs / 1000)} 秒`;
    return `约 ${Math.ceil(estimatedMs / 60000)} 分钟`;
  }

  private buildBlockedResult(success: number, failed: number, skipped: number, total: number, includeAll: boolean): string {
    const efficiency = total > 0 ? Math.round((success / total) * 100) : 0;
    const totalProcessed = success + failed + skipped;
    
    let statusEmoji = "✅", statusText = "成功完成";
    if (failed > 0 && failed > success) {
      statusEmoji = "⚠️"; statusText = "部分完成";
    } else if (success === 0) {
      statusEmoji = "ℹ️"; statusText = "无需清理";
    }
    
    return `${statusEmoji} <b>清理拉黑用户${statusText}</b>

📊 <b>统计结果:</b>
• 总计用户: ${total}
• 成功清理: ${success}
• 清理失败: ${failed}
• 跳过处理: ${skipped}
• 成功率: ${efficiency}%

⚙️ <b>清理模式:</b> ${includeAll ? '全量清理' : '智能清理'}

📈 <b>处理详情:</b>
• 已处理: ${totalProcessed}/${total}
${skipped > 0 ? `• 跳过原因: ${includeAll ? '系统限制' : '机器人/诈骗/虚假账户'}` : ''}

💡 <b>提示:</b> ${failed > 0 ? '部分失败可能是由于API限制或网络问题' : '所有操作已成功完成'}`;
  }

  private async checkBanPermission(client: any, chatId: any): Promise<boolean> {
    try {
      const me = await client.getMe();
      
      let participant;
      if (chatId instanceof Api.Channel) {
        participant = await client.invoke(new Api.channels.GetParticipant({ channel: chatId, participant: me }));
      } else {
        participant = await client.invoke(new Api.messages.GetFullChat({ chatId }));
      }

      if (participant instanceof Api.channels.ChannelParticipant) {
        const participantObj = participant.participant;
        if (participantObj instanceof Api.ChannelParticipantCreator) return true;
        if (participantObj instanceof Api.ChannelParticipantAdmin) return participantObj.adminRights.banUsers || false;
      }
      
      if (participant instanceof Api.messages.ChatFull) {
        const fullChat = participant.fullChat;
        if (fullChat instanceof Api.ChatFull) {
          const participants = fullChat.participants;
          if (participants instanceof Api.ChatParticipants) {
            const meParticipant = participants.participants.find((p: any) => p.userId?.equals(me.id));
            if (meParticipant instanceof Api.ChatParticipantCreator || meParticipant instanceof Api.ChatParticipantAdmin) {
              return true;
            }
          }
        }
      }

      return false;
      
    } catch (error: any) {
      if (error.message?.includes("CHAT_ADMIN_REQUIRED") ||
          error.message?.includes("USER_NOT_PARTICIPANT") ||
          error.message?.includes("PEER_ID_INVALID")) {
        return false;
      }
      return true;
    }
  }
}

export default new CleanPlugin();

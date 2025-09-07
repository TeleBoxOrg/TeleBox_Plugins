import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义工具
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 延迟函数
const sleep = (ms: number): Promise<void> => 
  new Promise(resolve => setTimeout(resolve, ms));

// 动态延迟策略
const getDynamicDelay = (user: any, includeAll: boolean, consecutiveErrors: number): number => {
  // 基础延迟
  let delay = 200;
  
  // 根据用户类型调整
  if (user.bot) {
    delay = 1500; // 机器人需要更长延迟
  } else if (user.scam || user.fake) {
    delay = 800; // 诈骗/虚假账户中等延迟
  }
  
  // 全量清理模式增加延迟
  if (includeAll) {
    delay = Math.max(delay, 1000);
  }
  
  // 根据连续错误次数增加延迟
  if (consecutiveErrors > 0) {
    delay = delay * (1 + consecutiveErrors * 0.5);
  }
  
  return Math.min(delay, 5000); // 最大延迟5秒
};

// 帮助文档
const help_text = `🧹 <b>清理拉黑用户插件</b>

<b>📝 功能描述:</b>
• 🚫 <b>批量清理</b>：清理所有已拉黑的用户
• ⚡ <b>智能过滤</b>：默认跳过机器人、诈骗和虚假账户
• 🤖 <b>全量清理</b>：可选择清理包括机器人在内的所有用户
• 📊 <b>详细统计</b>：显示成功、失败和跳过的数量
• 🔄 <b>防洪处理</b>：自动处理 Telegram API 限制
• ⏱️ <b>智能限速</b>：机器人清理时自动延迟避免API限制

<b>🔧 使用方法:</b>
• <code>${mainPrefix}clearblocked</code> - 清理拉黑用户（跳过机器人）
• <code>${mainPrefix}clearblocked all</code> - 清理所有拉黑用户（包括机器人）
• <code>${mainPrefix}clearblocked help</code> - 显示此帮助

<b>⚠️ 注意事项:</b>
• 此操作需要管理员权限
• 清理过程中请勿关闭程序
• 大量用户清理可能需要较长时间
• 使用 all 参数会清理所有类型的用户，包括机器人
• 清理机器人时会自动添加延迟以避免API限制

<b>💡 示例:</b>
• <code>${mainPrefix}clearblocked</code> - 智能清理（跳过机器人）
• <code>${mainPrefix}clearblocked all</code> - 全量清理（包括机器人，较慢）`;

class ClearBlockedPlugin extends Plugin {
  private startTime: number = 0;
  description: string = `批量取消拉黑所有用户\n\n${help_text}`;
  
  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    clearblocked: async (msg: Api.Message, trigger?: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      // 参数解析（严格按acron.ts模式）
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();

      try {
        // 无参数时显示错误提示，不自动显示帮助
        if (!sub) {
          // 默认行为：智能清理（跳过机器人）
          const result = await this.clearBlockedUsers(client, msg, false);
          
          await msg.edit({
            text: this.buildCompletionMessage(result, false),
            parseMode: "html"
          });
          return;
        }

        // 明确请求帮助时才显示
        if (sub === "help" || sub === "h") {
          await msg.edit({
            text: help_text,
            parseMode: "html"
          });
          return;
        }

        // 检查是否为 all 参数
        const includeAll = sub === "all";
        
        // 如果有未知参数，显示错误提示
        if (sub !== "all") {
          await msg.edit({
            text: `❌ <b>未知参数:</b> <code>${htmlEscape(sub)}</code>\n\n💡 使用 <code>${mainPrefix}clearblocked help</code> 查看帮助`,
            parseMode: "html"
          });
          return;
        }

        // 开始清理拉黑用户
        const result = await this.clearBlockedUsers(client, msg, includeAll);
        
        await msg.edit({
          text: this.buildCompletionMessage(result, includeAll),
          parseMode: "html"
        });

      } catch (error: any) {
        console.error("[clearblocked] 插件执行失败:", error);
        const errorMessage = error.message || "未知错误";
        await msg.edit({
          text: `❌ <b>清理失败</b>\n\n<b>错误信息:</b> ${htmlEscape(errorMessage)}\n\n💡 如遇到频繁错误，请稍后重试或使用 <code>${mainPrefix}clearblocked help</code> 查看帮助`,
          parseMode: "html"
        });
      }
    }
  };

  private async clearBlockedUsers(
    client: any, 
    msg: Api.Message, 
    includeAll: boolean = false
  ): Promise<{success: number, failed: number, skipped: number, total: number}> {
    this.startTime = Date.now(); // 记录开始时间
    let offset = 0;
    let success = 0, failed = 0, skipped = 0;
    let totalUsers = 0;
    let processedUsers = 0;
    let lastUpdateTime = Date.now();
    const updateInterval = 500; // 更新间隔毫秒数
    let consecutiveErrors = 0; // 连续错误计数
    
    // 首先获取总数用于进度计算
    try {
      const initialBlocked = await client.invoke(new Api.contacts.GetBlocked({
        offset: 0,
        limit: 1
      }));
      
      if (initialBlocked.className === 'contacts.BlockedSlice') {
        totalUsers = (initialBlocked as any).count || 0;
      } else {
        // 如果是 contacts.Blocked 类型，需要获取所有用户来计算总数
        const allBlocked = await client.invoke(new Api.contacts.GetBlocked({
          offset: 0,
          limit: 1000
        }));
        totalUsers = allBlocked.users?.length || 0;
      }
      
      await msg.edit({
        text: `🧹 <b>开始清理拉黑用户</b>\n\n📊 <b>发现拉黑用户:</b> ${totalUsers} 个\n🔄 <b>清理模式:</b> ${includeAll ? '全量清理（包括机器人）' : '智能清理（跳过机器人）'}\n\n⏳ 正在初始化...`,
        parseMode: "html"
      });
      
      await sleep(1000);
    } catch (error) {
      console.error("[clearblocked] 获取用户总数失败:", error);
    }
    
    while (true) {
      try {
        // 获取拉黑用户列表
        const blocked = await client.invoke(new Api.contacts.GetBlocked({
          offset: offset,
          limit: 100
        }));

        if (!blocked.users || blocked.users.length === 0) {
          break;
        }

        for (const user of blocked.users) {
          processedUsers++;
          
          // 根据 includeAll 参数决定是否跳过机器人、诈骗和虚假账户
          // includeAll=false 时跳过机器人等，includeAll=true 时清理所有用户
          if (!includeAll && (user.bot || user.scam || user.fake)) {
            skipped += 1;
            
            // 限制更新频率，避免过于频繁的消息编辑
            if (Date.now() - lastUpdateTime > updateInterval) {
              await this.updateProgress(msg, processedUsers, totalUsers, success, failed, skipped, user, "跳过", includeAll);
              lastUpdateTime = Date.now();
            }
            continue;
          }

          // 限制更新频率
          if (Date.now() - lastUpdateTime > updateInterval) {
            await this.updateProgress(msg, processedUsers, totalUsers, success, failed, skipped, user, "处理中", includeAll);
            lastUpdateTime = Date.now();
          }

          try {
            await client.invoke(new Api.contacts.Unblock({
              id: user
            }));
            success += 1;
            
            // 限制更新频率
            if (Date.now() - lastUpdateTime > updateInterval) {
              await this.updateProgress(msg, processedUsers, totalUsers, success, failed, skipped, user, "成功", includeAll);
              lastUpdateTime = Date.now();
            }
            
            // 使用动态延迟策略
            const delay = getDynamicDelay(user, includeAll, consecutiveErrors);
            await sleep(delay);
            consecutiveErrors = 0; // 重置错误计数
          } catch (error: any) {
            // 处理 FloodWait 错误
            if (error.message && error.message.includes('FLOOD_WAIT_')) {
              const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
              
              try {
                await msg.edit({
                  text: `🧹 清理拉黑用户中...\n\n⏳ 需要等待 ${waitTime} 秒后继续`,
                  parseMode: "html"
                });
              } catch (e) {
                // 忽略消息编辑错误
              }

              await sleep((waitTime + 1) * 1000);

              try {
                await msg.edit({
                  text: "🧹 继续清理拉黑用户...",
                  parseMode: "html"
                });
              } catch (e) {
                // 忽略消息编辑错误
              }

              // 重试取消拉黑
              await client.invoke(new Api.contacts.Unblock({
                id: user
              }));
              success += 1;
              
              // 限制更新频率
              if (Date.now() - lastUpdateTime > updateInterval) {
                await this.updateProgress(msg, processedUsers, totalUsers, success, failed, skipped, user, "成功", includeAll);
                lastUpdateTime = Date.now();
              }
              
              // 重试成功后使用动态延迟
              const delay = getDynamicDelay(user, includeAll, 0);
              await sleep(delay);
              consecutiveErrors = 0; // 重置错误计数
            } else {
              failed += 1;
              consecutiveErrors++; // 增加错误计数
              
              // 限制更新频率
              if (Date.now() - lastUpdateTime > updateInterval) {
                await this.updateProgress(msg, processedUsers, totalUsers, success, failed, skipped, user, "失败", includeAll);
                lastUpdateTime = Date.now();
              }
              
              // 错误后增加延迟
              const errorDelay = getDynamicDelay(user, includeAll, consecutiveErrors);
              await sleep(errorDelay);
            }
          }
        }

        offset += 100;

        // 检查是否还有更多用户
        if (blocked.className === 'contacts.BlockedSlice') {
          if (offset >= (blocked as any).count) {
            break;
          }
        } else {
          // contacts.Blocked 类型表示已获取所有用户
          break;
        }

        // 批次间延迟，根据错误情况动态调整
        const batchDelay = consecutiveErrors > 0 ? 3000 + (consecutiveErrors * 1000) : 2000;
        await sleep(Math.min(batchDelay, 10000)); // 最大延迟10秒

      } catch (error: any) {
        console.error("[clearblocked] 获取拉黑列表失败:", error);
        
        // 处理特定的 API 错误
        if (error.message?.includes('FLOOD_WAIT')) {
          const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
          await msg.edit({
            text: `⏳ API 限制，需要等待 ${waitTime} 秒后继续...`,
            parseMode: "html"
          });
          await sleep(waitTime * 1000);
          continue; // 继续循环
        }
        
        throw new Error(`获取拉黑列表失败: ${error.message || '未知错误'}`);
      }
    }

    return { success, failed, skipped, total: totalUsers };
  }

  private buildCompletionMessage(
    result: {success: number, failed: number, skipped: number, total: number},
    includeAll: boolean
  ): string {
    const totalProcessed = result.success + result.failed + result.skipped;
    const efficiency = result.total > 0 ? Math.round((result.success / result.total) * 100) : 0;
    
    let statusEmoji = "✅";
    let statusText = "成功完成";
    
    if (result.failed > 0 && result.failed > result.success) {
      statusEmoji = "⚠️";
      statusText = "部分完成";
    } else if (result.success === 0) {
      statusEmoji = "ℹ️";
      statusText = "无需清理";
    }
    
    return `🧹 <b>清理拉黑用户${statusText}</b>

${statusEmoji} <b>清理模式:</b> ${includeAll ? '全量清理（包括机器人）' : '智能清理（跳过机器人）'}

📊 <b>统计结果:</b>
• 📋 总计用户: ${result.total}
• ✅ 成功清理: ${result.success}
• ❌ 清理失败: ${result.failed}
• ⏭️ 跳过处理: ${result.skipped}
• 📈 成功率: ${efficiency}%

⏱️ <b>处理详情:</b>
• 已处理: ${totalProcessed}/${result.total}
${result.skipped > 0 ? `• 跳过原因: ${includeAll ? '系统限制' : '机器人/诈骗/虚假账户'}` : ''}

💡 <b>提示:</b> ${result.failed > 0 ? '部分用户清理失败可能是由于API限制或网络问题' : '所有操作已成功完成'}`;
  }

  private async updateProgress(
    msg: Api.Message, 
    processed: number, 
    total: number, 
    success: number, 
    failed: number, 
    skipped: number, 
    currentUser: any, 
    status: string,
    includeAll: boolean
  ) {
    try {
      const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
      const progressBarLength = 20;
      const filledLength = Math.round((percentage / 100) * progressBarLength);
      const progressBar = '█'.repeat(filledLength) + '░'.repeat(progressBarLength - filledLength);
      
      // 用户类型标识
      let userType = "👤 普通用户";
      if (currentUser.bot) userType = "🤖 机器人";
      else if (currentUser.scam) userType = "⚠️ 诈骗账户";
      else if (currentUser.fake) userType = "🚫 虚假账户";
      else if (currentUser.deleted) userType = "❌ 已删除账户";
      else if (currentUser.verified) userType = "✓ 认证用户";
      
      // 状态图标
      let statusIcon = "";
      switch (status) {
        case "处理中": statusIcon = "🔄"; break;
        case "成功": statusIcon = "✅"; break;
        case "跳过": statusIcon = "⏭️"; break;
        case "失败": statusIcon = "❌"; break;
      }
      
      // 用户名显示（改进逻辑）
      let userName = "未知用户";
      if (currentUser.firstName || currentUser.lastName) {
        userName = `${currentUser.firstName || ''} ${currentUser.lastName || ''}`.trim();
      } else if (currentUser.username) {
        userName = `@${currentUser.username}`;
      } else if (currentUser.id) {
        userName = `ID:${currentUser.id}`;
      }
      
      const progressText = `🧹 <b>清理拉黑用户进行中</b>

📊 <b>总体进度:</b> ${percentage}% (${processed}/${total})
${progressBar}

📈 <b>统计信息:</b>
• ✅ 成功: ${success}
• ❌ 失败: ${failed}  
• ⏭️ 跳过: ${skipped}

🔄 <b>当前处理:</b>
${statusIcon} ${status} - ${userType}
👤 <b>用户:</b> <code>${htmlEscape(userName)}</code>

⚙️ <b>清理模式:</b> ${includeAll ? '全量清理（包括机器人）' : '智能清理（跳过机器人）'}

⏱️ <b>预计剩余时间:</b> ${this.estimateRemainingTime(processed, total, Date.now() - this.startTime)}`;

      await msg.edit({
        text: progressText,
        parseMode: "html"
      });
    } catch (e) {
      // 忽略消息编辑错误，避免影响主要流程
    }
  }

  private estimateRemainingTime(processed: number, total: number, elapsedMs: number): string {
    if (processed === 0 || total === 0) return "计算中...";
    
    const avgTimePerUser = elapsedMs / processed;
    const remaining = total - processed;
    const estimatedMs = avgTimePerUser * remaining;
    
    if (estimatedMs < 1000) return "即将完成";
    if (estimatedMs < 60000) return `约 ${Math.ceil(estimatedMs / 1000)} 秒`;
    if (estimatedMs < 3600000) return `约 ${Math.ceil(estimatedMs / 60000)} 分钟`;
    return `约 ${Math.ceil(estimatedMs / 3600000)} 小时`;
  }
}

export default new ClearBlockedPlugin();

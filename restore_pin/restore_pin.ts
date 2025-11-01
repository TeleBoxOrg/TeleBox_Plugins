import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { conversation } from "@utils/conversation";

// HTML转义函数（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文本
const helpText = `📌 <b>恢复置顶插件</b>

<b>功能：</b>恢复管理员误取消的置顶消息

<b>命令：</b>
• <code>.restore_pin</code> - 开始恢复置顶流程

<b>使用说明：</b>
1. 仅在群组中可用
2. 需要管理员权限
3. 会列出最近取消置顶的管理员
4. 选择管理员后自动恢复其取消的置顶`;

class RestorePinPlugin extends Plugin {
  name = "restore_pin";
  description = helpText;

  cmdHandlers = {
    restore_pin: this.handleRestorePin.bind(this)
  };

  /**
   * 获取管理员日志
   */
  private async getAdminLog(chatId: any): Promise<Api.channels.AdminLogResults> {
    const client = await getGlobalClient();
    if (!client) throw new Error("客户端未初始化");

    const result = await client.invoke(
      new Api.channels.GetAdminLog({
        channel: chatId,
        q: "",
        maxId: BigInt(0),
        minId: BigInt(0),
        limit: 100,
        eventsFilter: new Api.ChannelAdminLogEventsFilter({
          pinned: true
        })
      })
    ) as Api.channels.AdminLogResults;

    return result;
  }

  /**
   * 从管理员日志中提取取消置顶事件
   */
  private getUnpinMap(events: Api.channels.AdminLogResults): Map<string, number[]> {
    const unpinMap = new Map<string, number[]>();
    
    for (const event of events.events) {
      // 检查是否为取消置顶事件
      if (event.action instanceof Api.ChannelAdminLogEventActionUpdatePinned) {
        if (!event.action.message.pinned) { // 取消置顶
          const userId = event.userId?.toString();
          if (userId) {
            const messageId = event.action.message.id;
            const existing = unpinMap.get(userId) || [];
            existing.push(messageId);
            unpinMap.set(userId, existing);
          }
        }
      }
    }
    
    return unpinMap;
  }

  /**
   * 让用户选择要恢复的管理员
   */
  private async askForAdmin(msg: Api.Message, unpinMap: Map<string, number[]>): Promise<string | null> {
    // 按取消数量排序
    const sortedAdmins = Array.from(unpinMap.entries())
      .sort((a, b) => b[1].length - a[1].length);

    if (sortedAdmins.length === 0) {
      await msg.edit({ text: "❌ 未找到取消置顶的记录", parseMode: "html" });
      return null;
    }

    // 构建选择列表
    let text = "👥 <b>请选择要恢复的管理员：</b>\n\n";
    sortedAdmins.forEach(([userId, messages], index) => {
      text += `<code>${index + 1}</code> - 用户 <code>${userId}</code> 取消了 ${messages.length} 条置顶\n`;
    });
    
    text += "\n💡 请回复管理员编号 (1, 2, 3...)";

    await msg.edit({ text, parseMode: "html" });

    try {
      // 等待用户回复
      const response = await conversation.waitForMessage(
        msg.senderId?.toString() || "unknown",
        msg.chatId.toString(),
        30000 // 30秒超时
      );

      if (!response || !response.text) {
        await msg.edit({ text: "❌ 未收到回复，操作已取消", parseMode: "html" });
        return null;
      }

      const choice = parseInt(response.text.trim());
      if (isNaN(choice) || choice < 1 || choice > sortedAdmins.length) {
        await msg.edit({ text: "❌ 选择无效，操作已取消", parseMode: "html" });
        return null;
      }

      // 删除用户回复
      try {
        await response.delete({ revoke: true });
      } catch (error) {
        // 忽略删除失败
      }

      return sortedAdmins[choice - 1][0];

    } catch (error) {
      await msg.edit({ text: "❌ 等待回复超时，操作已取消", parseMode: "html" });
      return null;
    }
  }

  /**
   * 恢复单条消息的置顶
   */
  private async pinMessage(chatId: any, messageId: number): Promise<boolean> {
    const client = await getGlobalClient();
    if (!client) return false;

    try {
      await client.invoke(
        new Api.messages.UpdatePinnedMessage({
          peer: chatId,
          id: messageId,
          silent: true,
          unpin: false
        })
      );
      return true;
    } catch (error: any) {
      console.error(`[restore_pin] 置顶消息失败:`, error);
      return false;
    }
  }

  /**
   * 批量恢复置顶
   */
  private async restorePins(msg: Api.Message, chatId: any, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) {
      await msg.edit({ text: "✅ 没有需要恢复的置顶消息", parseMode: "html" });
      return;
    }

    await msg.edit({ 
      text: `🔄 正在恢复 ${messageIds.length} 条置顶消息...`, 
      parseMode: "html" 
    });

    let successCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < messageIds.length; i++) {
      const messageId = messageIds[i];
      
      // 每5条更新一次进度
      if ((i + 1) % 5 === 0) {
        await msg.edit({ 
          text: `🔄 正在恢复第 ${i + 1}/${messageIds.length} 条置顶消息...\n✅ 成功: ${successCount} ❌ 失败: ${errorCount}`, 
          parseMode: "html" 
        });
      }

      const success = await this.pinMessage(chatId, messageId);
      if (success) {
        successCount++;
      } else {
        errorCount++;
        errors.push(`消息 ${messageId} 恢复失败`);
      }

      // 延迟避免触发限制
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    let resultText = `📊 <b>恢复完成</b>\n\n`;
    resultText += `✅ 成功恢复: ${successCount} 条\n`;
    resultText += `❌ 恢复失败: ${errorCount} 条`;

    if (errors.length > 0) {
      resultText += `\n\n<b>失败详情：</b>\n`;
      errors.slice(0, 5).forEach(error => {
        resultText += `• ${htmlEscape(error)}\n`;
      });
      if (errors.length > 5) {
        resultText += `• ... 还有 ${errors.length - 5} 个错误`;
      }
    }

    await msg.edit({ text: resultText, parseMode: "html" });
  }

  /**
   * 主命令处理器
   */
  private async handleRestorePin(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    try {
      // 检查是否为群组
      const chat = await msg.getChat();
      if (!(chat instanceof Api.Chat || chat instanceof Api.Channel)) {
        await msg.edit({ text: "❌ 此命令仅在群组或频道中可用", parseMode: "html" });
        return;
      }

      // 检查管理员权限
      const participant = await client.invoke(
        new Api.channels.GetParticipant({
          channel: chat.id,
          participant: await msg.getSender() as Api.InputUser
        })
      );

      const isAdmin = participant.participant instanceof Api.ChannelParticipantAdmin || 
                     participant.participant instanceof Api.ChannelParticipantCreator;

      if (!isAdmin) {
        await msg.edit({ text: "❌ 需要管理员权限才能使用此命令", parseMode: "html" });
        return;
      }

      await msg.edit({ text: "📋 正在获取管理员日志...", parseMode: "html" });

      // 获取管理员日志
      const adminLog = await this.getAdminLog(chat.id);
      
      // 提取取消置顶记录
      const unpinMap = this.getUnpinMap(adminLog);

      if (unpinMap.size === 0) {
        await msg.edit({ text: "❌ 未找到取消置顶的记录", parseMode: "html" });
        return;
      }

      // 让用户选择管理员
      const selectedAdmin = await this.askForAdmin(msg, unpinMap);
      if (!selectedAdmin) return;

      // 恢复置顶
      const messageIds = unpinMap.get(selectedAdmin) || [];
      await this.restorePins(msg, chat.id, messageIds);

    } catch (error: any) {
      console.error(`[restore_pin] 错误:`, error);
      
      let errorMessage = "❌ 操作失败";
      if (error.message?.includes("CHAT_ADMIN_REQUIRED")) {
        errorMessage = "❌ 需要管理员权限";
      } else if (error.message?.includes("USER_NOT_PARTICIPANT")) {
        errorMessage = "❌ 用户不是群组成员";
      } else if (error.message) {
        errorMessage += `: ${htmlEscape(error.message)}`;
      }

      await msg.edit({ text: errorMessage, parseMode: "html" });
    }
  }
}

export default new RestorePinPlugin();

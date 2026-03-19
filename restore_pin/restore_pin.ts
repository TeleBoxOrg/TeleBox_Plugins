import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getGlobalClient } from "@utils/globalClient";
import bigInt from "big-integer";

// HTML转义函数（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文本
const helpText = `📌 <b>恢复置顶插件</b>

<b>功能：</b>自动恢复管理员误取消的置顶消息

<b>命令：</b>
• <code>.restore_pin</code> - 自动恢复所有可恢复的置顶消息

<b>使用说明：</b>
1. 仅在群组中可用
2. 需要管理员权限
3. 自动扫描并恢复最近取消的置顶消息`;

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
        maxId: bigInt.zero,
        minId: bigInt.zero,
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
  private getUnpinMessages(events: Api.channels.AdminLogResults): number[] {
    const messageIds: number[] = [];
    
    for (const event of events.events) {
      // 检查是否为取消置顶事件
      if (event.action instanceof Api.ChannelAdminLogEventActionUpdatePinned) {
        if (!(event.action.message instanceof Api.MessageEmpty) && !event.action.message.pinned) { // 取消置顶
          const messageId = event.action.message.id;
          messageIds.push(messageId);
        }
      }
    }
    
    // 去重并返回
    return [...new Set(messageIds)];
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
      
      // 每3条更新一次进度
      if ((i + 1) % 3 === 0) {
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

      // 延迟避免触发限制（减少到1秒）
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    let resultText = `📊 <b>恢复完成</b>\n\n`;
    resultText += `✅ 成功恢复: ${successCount} 条\n`;
    resultText += `❌ 恢复失败: ${errorCount} 条`;

    if (errors.length > 0) {
      resultText += `\n\n<b>失败详情：</b>\n`;
      errors.slice(0, 3).forEach(error => {
        resultText += `• ${htmlEscape(error)}\n`;
      });
      if (errors.length > 3) {
        resultText += `• ... 还有 ${errors.length - 3} 个错误`;
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
      const sender = await msg.getSender();
      if (!sender) {
        await msg.edit({ text: "❌ 无法获取发送者信息", parseMode: "html" });
        return;
      }

      const participant = await client.invoke(
        new Api.channels.GetParticipant({
          channel: chat.id,
          participant: sender as unknown as Api.InputUser
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
      
      // 提取取消置顶的消息ID
      const messageIds = this.getUnpinMessages(adminLog);

      if (messageIds.length === 0) {
        await msg.edit({ text: "✅ 未找到可恢复的置顶消息", parseMode: "html" });
        return;
      }

      await msg.edit({ 
        text: `🔍 找到 ${messageIds.length} 条可恢复的置顶消息，开始自动恢复...`, 
        parseMode: "html" 
      });

      // 直接恢复所有置顶消息
      await this.restorePins(msg, chat.id, messageIds);

    } catch (error: any) {
      console.error(`[restore_pin] 错误:`, error);
      
      let errorMessage = "❌ 操作失败";
      if (error.message?.includes("CHAT_ADMIN_REQUIRED")) {
        errorMessage = "❌ 需要管理员权限";
      } else if (error.message?.includes("USER_NOT_PARTICIPANT")) {
        errorMessage = "❌ 用户不是群组成员";
      } else if (error.message?.includes("AUTH_KEY_UNREGISTERED")) {
        errorMessage = "❌ 会话已失效，请重新登录";
      } else if (error.message) {
        errorMessage += `: ${htmlEscape(error.message)}`;
      }

      await msg.edit({ text: errorMessage, parseMode: "html" });
    }
  }
}

export default new RestorePinPlugin();
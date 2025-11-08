import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { banUser } from "@utils/banUtils";

// HTML 转义函数（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文本
const HELP_TEXT = `🧹 <b>死号检测与清理</b>

<b>命令格式：</b>
<code>.getdel</code> - 统计死号数量
<code>.getdel 清理</code> - 统计并自动清理死号

<b>说明：</b>
• 仅在群组中可用
• 需要管理员权限
• 清理功能需要封禁用户权限`;

class GetDelPlugin extends Plugin {
  name = "getdel";
  description = HELP_TEXT;
  
  cmdHandlers = {
    getdel: this.handleGetDel.bind(this)
  };

  private async handleGetDel(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await this.sendError(msg, "客户端未就绪");
      return;
    }

    try {
      // 检查是否为群组
      const chat = await msg.getChat();
      if (!chat || !(chat instanceof Api.Chat || chat instanceof Api.Channel)) {
        await this.sendError(msg, "此命令仅在群组中可用");
        return;
      }

      // 解析参数
      const text = msg.text || "";
      const parts = text.trim().split(/\s+/);
      const needClean = parts.length > 1 && parts[1] === "清理";

      await msg.edit({ 
        text: "🔍 遍历成员中...", 
        parseMode: "html" 
      });

      let deletedCount = 0;
      const chatId = chat.id;

      // 如果需要清理，检查权限
      if (needClean) {
        const hasBanPermission = await this.checkBanPermissionWithGramJS(client, chatId);
        if (!hasBanPermission) {
          await this.sendError(msg, "没有封禁用户权限，无法执行清理操作");
          return;
        }
      }

      // 遍历所有成员
      const participants = client.iterParticipants(chatId);
      for await (const participant of participants) {
        if (participant instanceof Api.User && participant.deleted) {
          deletedCount++;
          
          // 如果需要清理，则封禁死号
          if (needClean) {
            try {
              // 使用 banUtils 封禁用户，设置5分钟封禁时间（与原版行为一致）
              await banUser(client, chatId, participant.id);
              
              // 短暂延迟避免 FloodWait
              await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error: any) {
              // 处理 FloodWait 错误
              if (error.message?.includes("FLOOD_WAIT")) {
                const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
                await this.sendError(msg, `处理失败，受到 TG 服务器限制，需要等待 ${waitTime} 秒`);
                return;
              }
              // 忽略其他封禁错误，继续处理下一个用户
              console.warn(`封禁用户 ${participant.id} 失败:`, error.message);
            }
          }
        }
      }

      // 发送结果
      let resultText: string;
      if (needClean) {
        resultText = `✅ 清理完成\n\n此群组的死号数：<code>${deletedCount}</code>，并且已经清理完毕。`;
      } else {
        resultText = `📊 统计完成\n\n此群组的死号数：<code>${deletedCount}</code>。`;
      }

      await msg.edit({ 
        text: resultText, 
        parseMode: "html" 
      });

    } catch (error: any) {
      await this.handleError(msg, error);
    }
  }

  /**
   * 使用 gramJS 推荐的方式检查封禁权限
   * 通过获取参与者的管理员权限来验证
   */
  private async checkBanPermissionWithGramJS(client: any, chatId: any): Promise<boolean> {
    try {
      // 获取当前机器人的信息
      const me = await client.getMe();
      
      // 获取机器人在群组中的参与者信息
      let participant;
      if (chatId instanceof Api.Channel) {
        // 对于频道/超级群组
        participant = await client.invoke(
          new Api.channels.GetParticipant({
            channel: chatId,
            participant: me
          })
        );
      } else {
        // 对于普通群组
        participant = await client.invoke(
          new Api.messages.GetFullChat({
            chatId: chatId
          })
        );
      }

      // 检查权限
      if (participant instanceof Api.channels.ChannelParticipant) {
        const participantObj = participant.participant;
        
        // 如果是创建者，拥有所有权限
        if (participantObj instanceof Api.ChannelParticipantCreator) {
          return true;
        }
        
        // 如果是管理员，检查封禁权限
        if (participantObj instanceof Api.ChannelParticipantAdmin) {
          return participantObj.adminRights.banUsers || false;
        }
      }
      
      // 对于普通群组，检查是否有管理员权限
      if (participant instanceof Api.messages.ChatFull) {
        const fullChat = participant.fullChat;
        if (fullChat instanceof Api.ChatFull) {
          // 在普通群组中，检查是否是管理员
          const participants = fullChat.participants;
          if (participants instanceof Api.ChatParticipants) {
            const meParticipant = participants.participants.find(
              (p: any) => p.userId && p.userId.equals(me.id)
            );
            // 如果是创建者或管理员，则认为有封禁权限
            if (meParticipant instanceof Api.ChatParticipantCreator || 
                meParticipant instanceof Api.ChatParticipantAdmin) {
              return true;
            }
          }
        }
      }

      return false;
      
    } catch (error: any) {
      console.error("检查封禁权限失败:", error);
      
      // 根据错误类型判断权限
      if (error.message?.includes("CHAT_ADMIN_REQUIRED") ||
          error.message?.includes("USER_NOT_PARTICIPANT") ||
          error.message?.includes("PEER_ID_INVALID")) {
        return false;
      }
      
      // 其他错误可能表示网络问题，默认认为有权限，在实际操作中会再次验证
      return true;
    }
  }

  /**
   * 备用的权限检查方法：通过尝试获取管理员列表来验证权限
   */
  private async checkBanPermissionByAdminList(client: any, chatId: any): Promise<boolean> {
    try {
      // 尝试获取管理员列表，如果有权限获取，说明是管理员
      await client.getParticipants(chatId, {
        filter: new Api.ChannelParticipantsAdmins()
      });
      return true;
    } catch (error: any) {
      console.error("通过管理员列表检查权限失败:", error);
      
      if (error.message?.includes("CHAT_ADMIN_REQUIRED") ||
          error.message?.includes("USER_NOT_PARTICIPANT")) {
        return false;
      }
      
      return true;
    }
  }

  private async sendError(msg: Api.Message, errorMsg: string): Promise<void> {
    await msg.edit({
      text: `❌ <b>错误:</b> ${htmlEscape(errorMsg)}`,
      parseMode: "html"
    });
  }

  private async handleError(msg: Api.Message, error: any): Promise<void> {
    console.error(`[GetDelPlugin] 错误:`, error);
    
    let errorMsg: string;
    
    if (error.message?.includes("FLOOD_WAIT")) {
      const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
      errorMsg = `⏳ <b>请求过于频繁</b>\n\n需要等待 ${waitTime} 秒后重试`;
    } else if (error.message?.includes("CHAT_ADMIN_REQUIRED")) {
      errorMsg = "🔒 <b>权限不足</b>\n\n您需要管理员权限才能使用此命令";
    } else if (error.message?.includes("USER_NOT_PARTICIPANT")) {
      errorMsg = "❌ <b>未加入群组</b>\n\n机器人需要先加入群组才能执行此操作";
    } else if (error.message?.includes("USER_NOT_MUTUAL_CONTACT")) {
      errorMsg = "❌ <b>无法操作</b>\n\n目标用户不是双向联系人";
    } else if (error.message?.includes("ADMIN_RANK_EMOJI_NOT_ALLOWED")) {
      errorMsg = "❌ <b>权限不足</b>\n\n您的管理员等级不足以执行此操作";
    } else if (error.message?.includes("CHANNEL_PRIVATE")) {
      errorMsg = "❌ <b>无法访问</b>\n\n机器人没有权限访问此频道";
    } else {
      errorMsg = `❌ <b>操作失败:</b> ${htmlEscape(error.message || "未知错误")}`;
    }
    
    await msg.edit({ 
      text: errorMsg, 
      parseMode: "html" 
    });
  }
}

export default new GetDelPlugin();

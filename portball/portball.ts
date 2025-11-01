import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

class PortballPlugin extends Plugin {
  name = "portball";
  description = "🔇 临时禁言工具 - 回复消息实现XX秒禁言";
  
  cmdHandlers = {
    portball: this.handlePortball.bind(this)
  };

  private readonly helpText = `🔇 <b>Portball 临时禁言工具</b>

<b>用法：</b>
<code>.portball [理由] 时间(秒)</code>

<b>示例：</b>
• <code>.portball 广告 300</code> - 禁言5分钟，理由"广告"
• <code>.portball 600</code> - 禁言10分钟，无理由

<b>注意：</b>
• 需要回复目标用户的消息
• 禁言时间必须 ≥ 60秒
• 需要管理员权限`;

  private async handlePortball(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;

    try {
      // 检查是否在群组中
      if (!(msg.chat instanceof Api.Chat || msg.chat instanceof Api.Channel)) {
        await msg.edit({
          text: "❌ <b>错误：</b>此命令只能在群组或超级群组中使用",
          parseMode: "html"
        });
        await this.autoDelete(msg, 5);
        return;
      }

      // 获取回复消息
      const replyMsg = await msg.getReplyMessage();
      if (!replyMsg) {
        await msg.edit({
          text: "❌ <b>错误：</b>请回复要禁言用户的消息",
          parseMode: "html"
        });
        await this.autoDelete(msg, 5);
        return;
      }

      // 获取发送者
      const sender = replyMsg.sender;
      if (!sender) {
        await msg.edit({
          text: "❌ <b>错误：</b>无法获取用户信息",
          parseMode: "html"
        });
        await this.autoDelete(msg, 5);
        return;
      }

      // 检查是否为自己
      const self = await client.getMe();
      if (sender.id?.eq?.(self.id)) {
        await msg.edit({
          text: "❌ <b>错误：</b>无法禁言自己",
          parseMode: "html"
        });
        await this.autoDelete(msg, 5);
        return;
      }

      // 解析参数
      const text = msg.text || "";
      const parts = text.trim().split(/\s+/).slice(1);
      
      let reason = "";
      let seconds = -1;

      if (parts.length === 1) {
        // 只有一个参数：时间
        try {
          seconds = parseInt(parts[0]);
        } catch {
          await msg.edit({
            text: "❌ <b>错误：</b>无效的时间参数",
            parseMode: "html"
          });
          await this.autoDelete(msg, 5);
          return;
        }
      } else if (parts.length >= 2) {
        // 两个或多个参数：理由 时间
        reason = parts.slice(0, -1).join(" ");
        try {
          seconds = parseInt(parts[parts.length - 1]);
        } catch {
          await msg.edit({
            text: "❌ <b>错误：</b>无效的时间参数",
            parseMode: "html"
          });
          await this.autoDelete(msg, 5);
          return;
        }
      } else {
        await msg.edit({
          text: "❌ <b>错误：</b>参数不足\n\n" + this.helpText,
          parseMode: "html"
        });
        await this.autoDelete(msg, 5);
        return;
      }

      // 验证时间
      if (seconds < 60) {
        await msg.edit({
          text: "❌ <b>错误：</b>禁言时间不能小于60秒",
          parseMode: "html"
        });
        await this.autoDelete(msg, 5);
        return;
      }

      // 计算禁言结束时间
      const untilDate = Math.floor(Date.now() / 1000) + seconds;

      try {
        // 使用正确的 API 方法禁言用户
        // 在 Telegram API 中，应该使用 editBanned 方法
        await client.invoke(new Api.channels.EditBanned({
          channel: msg.chat.id,
          participant: sender.id,
          bannedRights: new Api.ChatBannedRights({
            untilDate: untilDate,
            viewMessages: true, // 允许查看消息
            sendMessages: false, // 禁止发送消息
            sendMedia: false, // 禁止发送媒体
            sendStickers: false, // 禁止发送贴纸
            sendGifs: false, // 禁止发送GIF
            sendGames: false, // 禁止发送游戏
            sendInline: false, // 禁止发送内联
            embedLinks: false, // 禁止嵌入链接
            sendPolls: false, // 禁止发送投票
            changeInfo: false, // 禁止更改信息
            inviteUsers: false, // 禁止邀请用户
            pinMessages: false // 禁止置顶消息
          })
        }));

        // 构建成功消息
        let resultText = `🔇 <b>禁言成功</b>\n\n`;
        
        // 获取用户名
        let userName = "";
        if (sender instanceof Api.User) {
          if (sender.firstName && sender.lastName) {
            userName = `${sender.firstName} ${sender.lastName}`;
          } else if (sender.firstName) {
            userName = sender.firstName;
          } else {
            userName = `用户 ${sender.id}`;
          }
        } else {
          userName = `用户 ${sender.id}`;
        }

        resultText += `• <b>用户：</b>${htmlEscape(userName)}\n`;
        resultText += `• <b>时长：</b>${seconds}秒\n`;
        
        if (reason) {
          resultText += `• <b>理由：</b>${htmlEscape(reason)}\n`;
        }
        
        resultText += `\n⏰ 到期自动解除`;

        // 发送成功消息
        await client.sendMessage(msg.chat.id, {
          message: resultText,
          parseMode: "html"
        });

        // 删除命令消息
        await msg.delete({ revoke: true });

      } catch (error: any) {
        console.error("[Portball] 禁言失败:", error);
        
        let errorMsg = "❌ <b>禁言失败：</b>";
        
        if (error.message?.includes("ADMIN_REQUIRED")) {
          errorMsg += "需要管理员权限";
        } else if (error.message?.includes("USER_ADMIN_INVALID")) {
          errorMsg += "无法禁言管理员";
        } else if (error.message?.includes("CHAT_ADMIN_REQUIRED")) {
          errorMsg += "需要群组管理员权限";
        } else if (error.message?.includes("CHANNEL_PRIVATE")) {
          errorMsg += "无法在私有频道操作";
        } else if (error.message?.includes("USER_NOT_PARTICIPANT")) {
          errorMsg += "用户不在群组中";
        } else {
          errorMsg += htmlEscape(error.message || "未知错误");
        }

        await msg.edit({
          text: errorMsg,
          parseMode: "html"
        });
        await this.autoDelete(msg, 5);
      }

    } catch (error: any) {
      console.error("[Portball] 处理错误:", error);
      await msg.edit({
        text: `❌ <b>处理失败：</b>${htmlEscape(error.message || "未知错误")}`,
        parseMode: "html"
      });
      await this.autoDelete(msg, 5);
    }
  }

  // 自动删除消息
  private async autoDelete(msg: Api.Message, seconds: number = 5): Promise<void> {
    setTimeout(async () => {
      try {
        await msg.delete({ revoke: true });
      } catch (error) {
        // 忽略删除错误
      }
    }, seconds * 1000);
  }
}

export default new PortballPlugin();

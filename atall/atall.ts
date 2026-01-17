import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 消息分割函数（限制调整为4000字符）
const splitMessagesByMention = (mentions: string[], maxLength = 4000): string[] => {
  const messages: string[] = [];
  let currentMessage = "";
  
  for (const mention of mentions) {
    // 如果当前消息为空，直接添加第一个mention
    if (currentMessage === "") {
      currentMessage = mention;
    } 
    // 如果添加下一个mention后不会超过限制，则添加空格和mention
    else if (currentMessage.length + 1 + mention.length <= maxLength) {
      currentMessage += " " + mention;
    } 
    // 否则保存当前消息，开始新消息
    else {
      messages.push(currentMessage);
      currentMessage = mention;
    }
  }
  
  // 添加最后一个消息
  if (currentMessage) {
    messages.push(currentMessage);
  }
  
  return messages;
};

// 帮助文本
const help_text = `📢 <b>AtAll</b>

📝 <b>功能描述:</b>
• 一键@群组中的所有成员
• 自动处理无用户名用户
• 智能消息分割

🔧 <b>使用方法:</b>
• <code>${getPrefixes()[0]}atall</code> - @群组中的所有成员

⚠️ <b>注意事项:</b>
• 极大封号风险，后果自负
• 大群组中可能会生成很多条消息
• 一般来说你可以通过置顶消息来提醒所有人的`;

class AtAllPlugin extends Plugin {
  description = help_text;
  
  cmdHandlers = {
    atall: async (msg: Api.Message) => {
      try {
        const client = await getGlobalClient();
        if (!client) {
          await msg.edit({ text: "❌ 无法获取客户端", parseMode: "html" });
          return;
        }

        // 获取当前聊天
        const chat = await msg.getChat();
        if (!chat || !("id" in chat)) {
          await msg.edit({ text: "❌ 此命令只能在群组中使用", parseMode: "html" });
          return;
        }

        const chatId = chat.id;
        
        // 显示处理中
        const processingMsg = await msg.edit({
          text: "🔄 正在获取群组成员列表...",
          parseMode: "html"
        });

        // 获取所有群组成员
        const participants = await client.getParticipants(chatId, {});
        
        if (!participants || participants.length === 0) {
          await processingMsg.edit({ 
            text: "❌ 无法获取群组成员或群组为空", 
            parseMode: "html" 
          });
          return;
        }

        // 生成@列表
        let mentionList: string[] = [];
        
        for (const participant of participants) {
          // 跳过机器人自身
          if (participant.bot) continue;
          
          // 尝试获取用户实体
          let userEntity;
          try {
            userEntity = await client.getEntity(participant.id);
          } catch {
            continue; // 跳过无法获取实体的用户
          }
          
          if (userEntity && "username" in userEntity && userEntity.username) {
            // 有用户名的情况 - 直接使用@username
            mentionList.push(`@${userEntity.username}`);
          } else {
            // 无用户名，使用mention链接
            let displayName = "";
            if ("firstName" in participant && participant.firstName) {
              displayName = participant.firstName;
              if ("lastName" in participant && participant.lastName) {
                displayName += ` ${participant.lastName}`;
              }
            } else if ("title" in participant && participant.title) {
              displayName = participant.title;
            } else {
              displayName = "";
            }
            
            // 使用Telegram mention链接
            mentionList.push(`<a href="tg://user?id=${participant.id}">${htmlEscape(displayName)}</a>`);
          }
        }

        if (mentionList.length === 0) {
          await processingMsg.edit({ 
            text: "❌ 没有可@的成员", 
            parseMode: "html" 
          });
          return;
        }

        // 更新处理状态
        await processingMsg.edit({
          text: `🔄 正在生成@列表... (${mentionList.length} 个成员)`,
          parseMode: "html"
        });

        // 分割消息（基于mention单位），限制调整为4000
        const messageParts = splitMessagesByMention(mentionList, 4000);
        
        // 删除处理中消息
        await processingMsg.delete({ revoke: true }).catch(() => {});
        
        // 发送所有消息部分
        for (let i = 0; i < messageParts.length; i++) {
          const part = messageParts[i];
          
          // 在每条消息开头加上"@所有人:"标题
          const messageContent = `<b>@所有人:</b>\n${part}`;
          
          await client.sendMessage(chatId, {
            message: messageContent,
            parseMode: "html",
            replyTo: i === 0 ? msg.id : undefined
          });
          
          // 为避免消息发送过快，添加短暂延迟
          if (i < messageParts.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

      } catch (error: any) {
        console.error("[AtAll Plugin] Error:", error);
        
        let errorMessage = "❌ <b>发生错误:</b> ";
        if (error.message?.includes("CHAT_ADMIN_REQUIRED")) {
          errorMessage += "需要管理员权限来获取成员列表";
        } else if (error.message?.includes("USER_NOT_PARTICIPANT")) {
          errorMessage += "不是群组成员";
        } else if (error.message?.includes("CHANNEL_PRIVATE")) {
          errorMessage += "无法访问私有频道";
        } else {
          errorMessage += htmlEscape(error.message || "未知错误");
        }
        
        await msg.edit({ 
          text: errorMessage, 
          parseMode: "html" 
        });
      }
    }
  };
}

export default new AtAllPlugin();
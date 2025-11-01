import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { SudoDB } from "@utils/sudoDB";

// HTML转义函数（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

const help_text = `📋 <b>listusernames - 列出公开群组/频道</b>

<b>命令格式：</b>
<code>.listusernames</code>

<b>功能说明：</b>
• 列出所有属于自己的公开群组/频道
• 仅管理员可用

<b>使用示例：</b>
<code>.listusernames</code>`;

class ListUsernamesPlugin extends Plugin {
  description = help_text;
  
  cmdHandlers = {
    listusernames: async (msg: Api.Message): Promise<void> => {
      try {
        const client = await getGlobalClient();
        if (!client) {
          await msg.edit({ text: "❌ 客户端未就绪", parseMode: "html" });
          return;
        }

        // 检查管理员权限
        const sudoDB = new SudoDB();
        const userId = msg.senderId?.toString();
        
        if (!userId || !sudoDB.has(userId)) {
          await msg.edit({ 
            text: "❌ <b>权限不足</b>\n\n该命令仅限管理员使用",
            parseMode: "html" 
          });
          return;
        }

        // 发送处理中提示
        await msg.edit({ 
          text: "🔄 <b>正在获取公开群组/频道列表...</b>", 
          parseMode: "html" 
        });

        // 调用Telegram API获取公开频道
        const result = await client.invoke(
          new Api.channels.GetAdminedPublicChannels()
        );

        if (!result.chats || result.chats.length === 0) {
          await msg.edit({ 
            text: "📭 <b>没有找到公开群组/频道</b>\n\n您目前没有拥有任何公开群组或频道",
            parseMode: "html" 
          });
          return;
        }

        // 构建输出消息
        let output = `📋 <b>属于我的公开群组/频道</b>\n\n`;
        output += `共找到 <b>${result.chats.length}</b> 个公开群组/频道：\n\n`;

        result.chats.forEach((chat: any, index: number) => {
          const title = chat.title ? htmlEscape(chat.title) : "未知标题";
          const username = chat.username ? `@${chat.username}` : "无用户名";
          
          output += `<b>${index + 1}.</b> ${title}\n`;
          output += `   <code>${username}</code>\n\n`;
        });

        // 检查消息长度（Telegram限制4096字符）
        if (output.length > 4096) {
          // 如果消息过长，分割发送
          const part1 = output.substring(0, 4000) + "\n\n... (消息过长，已截断)";
          await msg.edit({ text: part1, parseMode: "html" });
        } else {
          await msg.edit({ text: output, parseMode: "html" });
        }

      } catch (error: any) {
        console.error("[listusernames] 错误:", error);
        
        let errorMessage = "❌ <b>获取列表失败</b>\n\n";
        
        if (error.message?.includes("AUTH_KEY_UNREGISTERED")) {
          errorMessage += "会话已失效，请重新登录";
        } else if (error.message?.includes("FLOOD_WAIT")) {
          const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
          errorMessage += `请求过于频繁，请等待 ${waitTime} 秒后重试`;
        } else {
          errorMessage += `错误信息: ${htmlEscape(error.message || "未知错误")}`;
        }

        await msg.edit({ 
          text: errorMessage, 
          parseMode: "html" 
        });
      }
    }
  };
}

export default new ListUsernamesPlugin();

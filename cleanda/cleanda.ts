import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";

const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

const HELP_TEXT = `🧹 <b>CleanDa - 已注销账号清理工具</b>

<b>功能：</b>
查找所有与已注销Telegram账号的私聊会话

<b>命令：</b>
• <code>.cleanda</code> - 扫描已注销账号的私聊会话

<b>说明：</b>
该命令会扫描您的所有私聊对话，找出那些账号已注销的用户。
扫描完成后会列出这些用户的ID，您可以根据需要手动清理这些对话。`;

class CleanDaPlugin extends Plugin {
  description = HELP_TEXT;
  
  cmdHandlers = {
    cleanda: this.handleCleanDa.bind(this)
  };

  private async handleCleanDa(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ 
        text: "❌ <b>错误：</b>无法获取Telegram客户端",
        parseMode: "html" 
      });
      return;
    }

    try {
      // 更新消息状态
      await msg.edit({ 
        text: "🔄 <b>正在扫描私聊会话...</b>\n请稍候，这可能需要一些时间。",
        parseMode: "html" 
      });

      const deletedUsers: string[] = [];
      
      // 获取所有对话
      const dialogs = await client.getDialogs();
      
      for (const dialog of dialogs) {
        // 只处理私聊对话
        if (dialog.isUser) {
          try {
            const entity = dialog.entity;
            
            // 检查是否为用户实体
            if (entity && entity.className === "User") {
              const user = entity as Api.User;
              
              // 检查用户是否已注销
              if (user.deleted) {
                const userId = user.id.toString();
                deletedUsers.push(userId);
              }
            }
          } catch (error) {
            // 忽略获取用户信息时的错误，继续处理下一个对话
            console.warn(`[CleanDa] 获取用户信息失败:`, error);
          }
        }
      }

      // 生成结果消息
      let resultMessage = "";
      
      if (deletedUsers.length === 0) {
        resultMessage = "✅ <b>扫描完成</b>\n\n未找到与已注销账号的私聊会话。";
      } else {
        resultMessage = `✅ <b>扫描完成</b>\n\n共找到 <code>${deletedUsers.length}</code> 个与已注销账号的私聊会话：\n\n`;
        
        // 为每个已注销用户生成链接
        deletedUsers.forEach(userId => {
          resultMessage += `• <a href="tg://openmessage?user_id=${userId}">${userId}</a>\n`;
        });
        
        resultMessage += `\n💡 <b>操作建议：</b>\n点击上面的用户ID可以快速跳转到对话，建议手动清理这些对话。`;
      }

      await msg.edit({ 
        text: resultMessage,
        parseMode: "html" 
      });

    } catch (error: any) {
      console.error(`[CleanDa] 扫描失败:`, error);
      
      await msg.edit({ 
        text: `❌ <b>扫描失败：</b>${htmlEscape(error.message || "未知错误")}`,
        parseMode: "html" 
      });
    }
  }
}

export default new CleanDaPlugin();

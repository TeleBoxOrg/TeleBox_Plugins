import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";

// HTML转义函数（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

class PremiumPlugin extends Plugin {
  name = "premium";
  
  description = `🎁 群组大会员统计插件

<b>命令格式：</b>
<code>.premium</code> - 统计群组大会员情况
<code>.premium force</code> - 强制统计（超过1万人时使用）

<b>功能：</b>
• 统计群组中的Telegram Premium会员情况
• 显示大会员比例
• 自动过滤机器人和死号`;

  cmdHandlers = {
    premium: this.handlePremium.bind(this)
  };

  private async getChatParticipantsCount(chat: Api.Chat | Api.Channel): Promise<number> {
    const client = await getGlobalClient();
    
    if (chat instanceof Api.Chat) {
      // 对于普通群组
      return (chat as any).participantsCount || 0;
    } else {
      // 对于频道/超级群
      try {
        const fullChat = await client.invoke(
          new Api.channels.GetFullChannel({
            channel: chat
          })
        );
        return (fullChat.fullChat as any).participantsCount || 0;
      } catch (error) {
        console.error("获取频道成员数量失败:", error);
        return 0;
      }
    }
  }

  private async handlePremium(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;

    try {
      // 检查是否在群组中
      const chat = await msg.getChat();
      if (!(chat instanceof Api.Chat || chat instanceof Api.Channel)) {
        await msg.edit({
          text: "❌ <b>错误：</b>此命令只能在群组或频道中使用",
          parseMode: "html"
        });
        return;
      }

      // 获取参数
      const args = msg.text?.trim().split(/\s+/) || [];
      const forceMode = args[1] === "force";

      // 编辑消息显示等待
      await msg.edit({ text: "⏳ 请稍等，正在统计中..." });

      // 获取群组成员数量
      const participantCount = await this.getChatParticipantsCount(chat);
      
      // 检查人数限制
      if (participantCount >= 10000 && !forceMode) {
        await msg.edit({
          text: `😵 <b>人数过多</b>\n\n太...太多人了... 我会...会...会坏掉的...\n\n如果您执意要运行的的话，您可以使用指令 <code>.premium force</code>`,
          parseMode: "html"
        });
        return;
      }

      // 统计变量
      let premiumUsers = 0;
      let totalUsers = 0;
      let bots = 0;
      let deleted = 0;

      // 遍历所有成员
      let processedCount = 0;
      const limit = 10000; // 限制最大处理数量
      
      for await (const participant of client.iterParticipants(chat, { limit })) {
        processedCount++;
        
        // 更新进度（每处理100人更新一次）
        if (processedCount % 100 === 0) {
          await msg.edit({
            text: `⏳ 正在统计中... 已处理 ${processedCount} 个成员`,
            parseMode: "html"
          });
        }

        let user: Api.User | null = null;

        // 处理不同类型的participant
        if (participant instanceof Api.ChannelParticipant) {
          if ((participant as any).user) {
            user = (participant as any).user as Api.User;
          }
          continue;
        } else if (participant instanceof Api.ChatParticipant) {
          user = participant.userId as unknown as Api.User;
        } else if (participant instanceof Api.User) {
          user = participant;
        }

        if (!user) continue;

        if (user.bot) {
          bots++;
          continue;
        }
        
        if (user.deleted) {
          deleted++;
          continue;
        }

        // 统计有效用户
        totalUsers++;
        
        // 检查是否是Premium会员
        const isPremium = user.premium || false;
        
        if (isPremium) {
          premiumUsers++;
        }
      }

      // 计算百分比
      const premiumPercent = totalUsers > 0 ? 
        ((premiumUsers / totalUsers) * 100).toFixed(2) : "0.00";

      // 生成报告
      let report = `🎁 <b>分遗产咯</b>\n\n`;

      report += `<b>统计结果:</b>\n`;
      report += `> 大会员: <b>${premiumUsers}</b> / 总用户数: <b>${totalUsers}</b>\n`;
      report += `> 大会员占比: <b>${premiumPercent}%</b>\n\n`;

      report += `> 已自动过滤掉 <b>${bots}</b> 个 Bot, <b>${deleted}</b> 个 死号\n`;
      report += `> 本次统计处理了 <b>${processedCount}</b> 个成员\n\n`;

      if (participantCount >= 10000) {
        report += `⚠️ <i>请注意: 由于Telegram限制，我们只能遍历前1万人，此次获得的数据可能不完整</i>`;
      }

      await msg.edit({
        text: report,
        parseMode: "html"
      });

    } catch (error: any) {
      console.error("[Premium Plugin] Error:", error);
      
      let errorMessage = "❌ <b>统计失败</b>\n\n";
      
      if (error.message?.includes("CHAT_ADMIN_REQUIRED")) {
        errorMessage += "需要管理员权限才能查看群组成员列表";
      } else if (error.message?.includes("CHANNEL_PRIVATE")) {
        errorMessage += "无法访问该群组，请确保机器人是群组成员";
      } else if (error.message?.includes("AUTH_KEY_UNREGISTERED")) {
        errorMessage += "会话未注册，请重新登录";
      } else if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = error.message.match(/\d+/)?.[0] || "60";
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
}

export default new PremiumPlugin();

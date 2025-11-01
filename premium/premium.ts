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
• 显示管理员和普通用户的大会员比例
• 自动过滤机器人和死号`;

  cmdHandlers = {
    premium: this.handlePremium.bind(this)
  };

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
      const participantCount = await client.getParticipantsCount(chat);
      
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
      let admins = 0;
      let premiumAdmins = 0;
      let bots = 0;
      let deleted = 0;

      // 遍历所有成员
      for await (const participant of client.iterParticipants(chat)) {
        if (participant instanceof Api.ChannelParticipant) {
          const user = participant.user;
          
          if (user && !user.bot && !user.deleted) {
            totalUsers++;
            
            // 检查是否是管理员
            const isAdmin = participant instanceof Api.ChannelParticipantAdmin || 
                           participant instanceof Api.ChannelParticipantCreator;
            
            // 检查是否是Premium会员
            const isPremium = user.premium || false;
            
            if (isPremium) {
              premiumUsers++;
              if (isAdmin) {
                premiumAdmins++;
              }
            }
            
            if (isAdmin) {
              admins++;
            }
          } else if (user?.bot) {
            bots++;
          } else if (user?.deleted) {
            deleted++;
          }
        }
      }

      // 计算百分比
      const adminPremiumPercent = admins > 0 ? 
        ((premiumAdmins / admins) * 100).toFixed(2) : "0.00";
      
      const userPremiumPercent = totalUsers > 0 ? 
        ((premiumUsers / totalUsers) * 100).toFixed(2) : "0.00";

      // 生成报告
      let report = `🎁 <b>分遗产咯</b>\n\n`;

      report += `<b>管理员:</b>\n`;
      report += `> 大会员: <b>${premiumAdmins}</b> / 总管理数: <b>${admins}</b> 分遗产占比: <b>${adminPremiumPercent}%</b>\n\n`;

      report += `<b>用户:</b>\n`;
      report += `> 大会员: <b>${premiumUsers}</b> / 总用户数: <b>${totalUsers}</b> 分遗产占比: <b>${userPremiumPercent}%</b>\n\n`;

      report += `> 已自动过滤掉 <b>${bots}</b> 个 Bot, <b>${deleted}</b> 个 死号\n\n`;

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

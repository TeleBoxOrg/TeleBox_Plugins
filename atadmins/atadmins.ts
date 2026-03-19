import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
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

// 帮助文档
const help_text = `👮 <b>一键 AT 管理员</b>

<b>📝 功能描述:</b>
• 🔔 <b>管理员召唤</b>：一键艾特群组内所有管理员
• 💬 <b>自定义消息</b>：可附带自定义召唤消息
• 📦 <b>智能分片</b>：自动分片避免消息过长
• 🤖 <b>过滤机器人</b>：自动排除机器人和已删除用户

<b>🔧 使用方法:</b>
• <code>${mainPrefix}atadmins</code> - 使用默认消息召唤管理员
• <code>${mainPrefix}atadmins [消息内容]</code> - 附带自定义消息召唤

<b>💡 示例:</b>
• <code>${mainPrefix}atadmins</code> - 默认召唤
• <code>${mainPrefix}atadmins 请查看置顶消息</code> - 自定义消息召唤
• <code>${mainPrefix}atadmins 紧急情况需要处理</code> - 紧急召唤

<b>⚠️ 注意事项:</b>
• 仅限群组使用，私聊无效
• 需要获取群组管理员权限
• 自动删除召唤命令消息
• 支持回复消息时召唤管理员`;

class AtAdminsPlugin extends Plugin {
  description: string = help_text;
  
  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    atadmins: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      // 参数解析（严格按acron.ts模式）
      const lines = msg.message?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();

      try {
        // 明确请求帮助时才显示
        if (sub === "help" || sub === "h") {
          await msg.edit({
            text: help_text,
            parseMode: "html"
          });
          return;
        }

        // 执行AT管理员功能
        await this.handleAtAdmins(msg, args);
        
      } catch (error: any) {
        console.error("[atadmins] 插件执行失败:", error);
        await msg.edit({
          text: `❌ <b>操作失败:</b> ${htmlEscape(error.message)}`,
          parseMode: "html"
        });
      }
    }
  };

  // 将管理员 mention 分片，控制单条消息的最大字数与最大 mention 数
  private chunkMentions(mentions: string[], header: string, maxLen = 3500, maxCount = 25): string[] {
    const chunks: string[] = [];
    let current = header;
    let count = 0;
    for (const m of mentions) {
      const toAdd = (count === 0 ? "" : " , ") + m;
      if (count >= maxCount || (current.length + toAdd.length) > maxLen) {
        chunks.push(current);
        current = header + m; // 新开一条
        count = 1;
      } else {
        current += toAdd;
        count++;
      }
    }
    if (count > 0) chunks.push(current);
    return chunks;
  }

  private async handleAtAdmins(msg: Api.Message, args: string[]): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    try {
      // 检查是否在群组中
      if (!msg.peerId || !(msg.peerId instanceof Api.PeerChannel || msg.peerId instanceof Api.PeerChat)) {
        await msg.edit({ 
          text: `❌ <b>此命令只能在群组中使用</b>\n\n💡 请在群组中使用 <code>${mainPrefix}atadmins</code> 命令`, 
          parseMode: "html" 
        });
        return;
      }

      // 获取管理员列表
      const participants = await client.getParticipants(msg.peerId, {
        filter: new Api.ChannelParticipantsAdmins()
      });

      const admins: string[] = [];
      let adminCount = 0;
      let botCount = 0;
       
      for (const user of participants) {
        if (user && !user.deleted) {
          if (user.bot) {
            botCount++;
            continue; // 跳过机器人
          }
          
          adminCount++;
          if (user.username) {
            admins.push(`@${user.username}`);
          } else {
            const firstName = user.firstName || "";
            const lastName = user.lastName || "";
            const fullName = `${firstName} ${lastName}`.trim() || "用户";
            // HTML转义用户名
            const escapedName = htmlEscape(fullName);
            admins.push(`[${escapedName}](tg://user?id=${user.id})`);
          }
        }
      }

      if (admins.length === 0) {
        await msg.edit({ 
          text: `❌ <b>未找到可召唤的管理员</b>\n\n📊 统计信息:\n• 总管理员: ${adminCount}\n• 机器人管理员: ${botCount}\n• 可召唤: 0\n\n💡 可能原因：所有管理员都是机器人或已删除账户`, 
          parseMode: "html" 
        });
        return;
      }

      // 获取自定义消息内容（HTML转义）
      const customMessage = args.join(" ").trim();
      const say = customMessage ? htmlEscape(customMessage) : "召唤本群所有管理员";
      
      const header = `${say}：\n\n`;
      const chunks = this.chunkMentions(admins, header);

      // 逐条发送（显式使用 Markdown 解析 tg://user?id= 链接）
      const baseSendOptions: any = { parseMode: "markdown" };
      if (msg.replyToMsgId) baseSendOptions.replyTo = msg.replyToMsgId;

      for (const part of chunks) {
        await client.sendMessage(msg.peerId, { ...baseSendOptions, message: part });
        // 小间隔，避免触发频控
        await new Promise((r) => setTimeout(r, 800));
      }

      // 延迟删除命令消息
      setTimeout(async () => {
        try {
          await msg.delete({ revoke: true });
        } catch (deleteError) {
          console.warn("[atadmins] 删除原消息失败:", deleteError);
        }
      }, 3000); // 3秒后删除
      
    } catch (error: any) {
      console.error("[atadmins] 获取管理员列表失败:", error);
      
      // 详细错误处理
      let errorText = "❌ <b>获取管理员列表失败</b>\n\n";
      
      if (error.message?.includes("CHAT_ADMIN_REQUIRED")) {
        errorText += "💡 <b>原因:</b> 机器人需要管理员权限才能获取管理员列表";
      } else if (error.message?.includes("CHANNEL_PRIVATE")) {
        errorText += "💡 <b>原因:</b> 无法访问此群组的管理员信息";
      } else if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = error.message.match(/\d+/)?.[0] || "60";
        errorText += `💡 <b>原因:</b> 请求过于频繁，请等待 ${waitTime} 秒后重试`;
      } else {
        errorText += `💡 <b>错误详情:</b> ${htmlEscape(error.message || "未知错误")}`;
      }
      
      await msg.edit({ 
        text: errorText,
        parseMode: "html"
      });
    }
  }
}

export default new AtAdminsPlugin();

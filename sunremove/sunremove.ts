import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { getBannedUsers, unbanUser } from "@utils/banUtils";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 帮助文档
const help_text = `🔓 <b>一键解封工具</b>

<b>命令格式：</b>
<code>${mainPrefix}sunremove [子命令] [参数]</code>

<b>可用命令：</b>
• <code>${mainPrefix}sunremove</code> - 解封自己封禁的实体
• <code>${mainPrefix}sunremove all</code> - 解封所有被封禁的实体
• <code>${mainPrefix}sunremove help</code> - 显示此帮助

<b>支持类型：</b>
👤 用户 - 普通用户账号
📢 频道 - Telegram 频道
💬 群组 - Telegram 群组

<b>说明：</b>
此命令用于批量解封被封禁的群组成员、频道和群组，解封后这些实体可以重新加入群组。

<b>使用示例：</b>
<code>${mainPrefix}sunremove</code> - 解封我封禁的实体
<code>${mainPrefix}sunremove all</code> - 解封所有实体`;
const sunremove = async (msg: Api.Message) => {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
    return;
  }

  // 标准参数解析
  const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
  const parts = lines?.[0]?.split(/\s+/) || [];
  const [, ...args] = parts;
  const sub = (args[0] || "").toLowerCase();

  try {
    // 处理 help 在前的情况：.sunremove help [subcommand]
    if (sub === "help" || sub === "h") {
      await msg.edit({ text: help_text, parseMode: "html" });
      return;
    }

    // 处理 help 在后的情况：.sunremove [subcommand] help
    if (args[1] && (args[1].toLowerCase() === "help" || args[1].toLowerCase() === "h")) {
      await msg.edit({ text: help_text, parseMode: "html" });
      return;
    }

    // 检查是否在群组中
    if (!msg.isChannel && !msg.isGroup) {
      await msg.edit({ 
        text: "❌ <b>此命令只能在群组中使用</b>", 
        parseMode: "html" 
      });
      return;
    }

    // 处理具体的子命令
    let mode = "mine";
    if (sub === "all") {
      mode = "all";
    } else if (sub !== "" && sub !== "help" && sub !== "h") {
      // 未知命令
      await msg.edit({
        text: `❌ <b>未知命令:</b> <code>${htmlEscape(sub)}</code>\n\n💡 使用 <code>${mainPrefix}sunremove help</code> 查看帮助`,
        parseMode: "html"
      });
      return;
    }
    // 无参数时执行默认操作（mode = "mine"）

    const me = await client.getMe();
  const myId = Number(me.id);
  
  const chatEntity = msg.peerId;
  
  await msg.edit({ 
    text: `🔍 正在获取被封禁实体列表...`, 
    parseMode: "html" 
  });
  
  let bannedUsers = await getBannedUsers(client, chatEntity);
  
  if (mode === "mine") {
    bannedUsers = bannedUsers.filter(u => u.kickedBy === myId);
  }
  
  if (bannedUsers.length === 0) {
    await msg.edit({ 
      text: `ℹ️ 没有找到需要解封的实体`, 
      parseMode: "html" 
    });
    await sleep(3000);
    await msg.delete();
    return;
  }
  
  await msg.edit({ 
    text: `⚡ 正在解封 ${bannedUsers.length} 个实体...`, 
    parseMode: "html" 
  });
  
  let progressMsg: Api.Message | null = null;
  try {
    const chat = await client.getEntity(chatEntity);
    const chatTitle = 'title' in chat ? chat.title : "未知群组";
    progressMsg = await client.sendMessage("me", {
      message: `🔓 <b>解封任务进度</b>\n\n群组: ${chatTitle}\n总数: ${bannedUsers.length} 个实体\n进度: 0/${bannedUsers.length}`,
      parseMode: "html"
    });
  } catch (e) {
    console.error("发送进度消息失败:", e);
  }
  
  let successCount = 0;
  let failedCount = 0;
  const failedEntities: string[] = [];
  const entityStats = { users: 0, channels: 0, chats: 0 };
  
  // 统计实体类型
  for (const entity of bannedUsers) {
    if (entity.type === 'user') entityStats.users++;
    else if (entity.type === 'channel') entityStats.channels++;
    else if (entity.type === 'chat') entityStats.chats++;
  }
  
  for (const entity of bannedUsers) {
    const success = await unbanUser(client, chatEntity, entity.id);
    if (success) {
      successCount++;
    } else {
      failedCount++;
      const displayName = entity.type === 'user' 
        ? `${entity.firstName}(${entity.id})` 
        : `${entity.title || entity.firstName}[${entity.type}](${entity.id})`;
      failedEntities.push(displayName);
    }
    
    if (progressMsg && (successCount + failedCount) % 5 === 0) {
      try {
        const chat = await client.getEntity(chatEntity);
        const chatTitle = 'title' in chat ? chat.title : "未知群组";
        let statsText = "";
        if (entityStats.users > 0) statsText += `👤 用户: ${entityStats.users} `;
        if (entityStats.channels > 0) statsText += `📢 频道: ${entityStats.channels} `;
        if (entityStats.chats > 0) statsText += `💬 群组: ${entityStats.chats}`;
        
        await client.editMessage("me", {
          message: progressMsg.id,
          text: `🔓 <b>解封任务进度</b>\n\n群组: ${chatTitle}\n总数: ${bannedUsers.length} 个实体\n${statsText}\n进度: ${successCount + failedCount}/${bannedUsers.length}\n\n✅ 成功: ${successCount}\n❌ 失败: ${failedCount}`,
          parseMode: "html"
        });
      } catch (e) {
        console.error("更新进度消息失败:", e);
      }
    }
    
    await sleep(500);
  }
  
  if (progressMsg) {
    try {
      const chat = await client.getEntity(chatEntity);
      const chatTitle = 'title' in chat ? chat.title : "未知群组";
      let statsText = "";
      if (entityStats.users > 0) statsText += `👤 用户: ${entityStats.users} `;
      if (entityStats.channels > 0) statsText += `📢 频道: ${entityStats.channels} `;
      if (entityStats.chats > 0) statsText += `💬 群组: ${entityStats.chats}`;
      
      let finalText = `🔓 <b>解封任务完成</b>\n\n群组: ${chatTitle}\n总数: ${bannedUsers.length} 个实体\n${statsText}\n\n`;
      if (failedCount > 0) {
        finalText += `✅ 成功: ${successCount} 个\n❌ 失败: ${failedCount} 个\n`;
        if (failedEntities.length <= 5) {
          finalText += `\n失败实体: ${failedEntities.map(u => htmlEscape(u)).join(", ")}`;
        }
      } else {
        finalText += `✅ 已成功解封所有 ${successCount} 个实体`;
      }
      
      await client.editMessage("me", {
        message: progressMsg.id,
        text: finalText,
        parseMode: "html"
      });
    } catch (e) {
      console.error("更新最终结果失败:", e);
    }
  }
  
  let resultText = "";
  let statsText = "";
  if (entityStats.users > 0) statsText += `👤 ${entityStats.users} `;
  if (entityStats.channels > 0) statsText += `📢 ${entityStats.channels} `;
  if (entityStats.chats > 0) statsText += `💬 ${entityStats.chats}`;
  
  if (failedCount > 0) {
    resultText = `✅ <b>解封完成</b>\n\n` +
      `${statsText}\n` +
      `成功: <code>${successCount}</code> 个\n` +
      `失败: <code>${failedCount}</code> 个`;
  } else {
    resultText = `✅ <b>解封完成</b>\n\n${statsText}\n已成功解封 <code>${successCount}</code> 个实体`;
  }
  
  await msg.edit({
    text: resultText,
    parseMode: "html"
  });
  
    await sleep(5000);
    await msg.delete();

  } catch (error: any) {
    console.error("[sunremove] 插件执行失败:", error);
    await msg.edit({
      text: `❌ <b>插件执行失败:</b> ${htmlEscape(error.message || "未知错误")}`,
      parseMode: "html"
    });
  }
};

class SunRemovePlugin extends Plugin {
  description: string = `一键解封工具\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sunremove
  };
}

export default new SunRemovePlugin();

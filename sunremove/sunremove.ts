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
const sunremove = async (msg: Api.Message) => {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
    return;
  }

  if (!msg.isChannel && !msg.isGroup) {
    await msg.edit({ 
      text: "❌ <b>此命令只能在群组中使用</b>", 
      parseMode: "html" 
    });
    return;
  }

  const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
  const parts = lines?.[0]?.split(/\s+/) || [];
  const [, ...args] = parts;
  
  let mode = "mine";
  
  if (args.length > 0) {
    if (args[0] === "all") {
      mode = "all";
    } else if (args[0] === "help" || args[0] === "h") {
      await msg.edit({
        text: `<b>🔓 一键解封工具</b>

<b>用法:</b>
• <code>${mainPrefix}sunremove</code> - 解封自己封禁的用户
• <code>${mainPrefix}sunremove all</code> - 解封所有被封禁的用户

<b>说明:</b>
此命令用于批量解封被封禁的群组成员，解封后用户可以重新加入群组。`,
        parseMode: "html"
      });
      return;
    }
  }

  const me = await client.getMe();
  const myId = Number(me.id);
  
  const chatEntity = msg.peerId;
  
  await msg.edit({ 
    text: `🔍 正在获取被封禁用户列表...`, 
    parseMode: "html" 
  });
  
  let bannedUsers = await getBannedUsers(client, chatEntity);
  
  if (mode === "mine") {
    bannedUsers = bannedUsers.filter(u => u.kickedBy === myId);
  }
  
  if (bannedUsers.length === 0) {
    await msg.edit({ 
      text: `ℹ️ 没有找到需要解封的用户`, 
      parseMode: "html" 
    });
    await sleep(3000);
    await msg.delete();
    return;
  }
  
  await msg.edit({ 
    text: `⚡ 正在解封 ${bannedUsers.length} 个用户...`, 
    parseMode: "html" 
  });
  
  let progressMsg: Api.Message | null = null;
  try {
    progressMsg = await client.sendMessage("me", {
      message: `🔓 <b>解封任务进度</b>\n\n群组: ${msg.chat?.title || "未知"}\n总数: ${bannedUsers.length} 人\n进度: 0/${bannedUsers.length}`,
      parseMode: "html"
    });
  } catch (e) {
    console.error("发送进度消息失败:", e);
  }
  
  let successCount = 0;
  let failedCount = 0;
  const failedUsers: string[] = [];
  
  for (const user of bannedUsers) {
    const success = await unbanUser(client, chatEntity, user.id);
    if (success) {
      successCount++;
    } else {
      failedCount++;
      failedUsers.push(`${user.firstName}(${user.id})`);
    }
    
    if (progressMsg && (successCount + failedCount) % 5 === 0) {
      try {
        await client.editMessage("me", {
          message: progressMsg.id,
          text: `🔓 <b>解封任务进度</b>\n\n群组: ${msg.chat?.title || "未知"}\n总数: ${bannedUsers.length} 人\n进度: ${successCount + failedCount}/${bannedUsers.length}\n\n✅ 成功: ${successCount}\n❌ 失败: ${failedCount}`,
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
      let finalText = `🔓 <b>解封任务完成</b>\n\n群组: ${msg.chat?.title || "未知"}\n总数: ${bannedUsers.length} 人\n\n`;
      if (failedCount > 0) {
        finalText += `✅ 成功: ${successCount} 人\n❌ 失败: ${failedCount} 人\n`;
        if (failedUsers.length <= 5) {
          finalText += `\n失败用户: ${failedUsers.map(u => htmlEscape(u)).join(", ")}`;
        }
      } else {
        finalText += `✅ 已成功解封所有 ${successCount} 人`;
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
  if (failedCount > 0) {
    resultText = `✅ <b>解封完成</b>\n\n` +
      `成功: <code>${successCount}</code> 人\n` +
      `失败: <code>${failedCount}</code> 人`;
  } else {
    resultText = `✅ <b>解封完成</b>\n\n已成功解封 <code>${successCount}</code> 人`;
  }
  
  await msg.edit({
    text: resultText,
    parseMode: "html"
  });
  
  await sleep(5000);
  await msg.delete();
};

class SunRemovePlugin extends Plugin {
  description: string = "🔓 一键解封被封禁的用户";
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sunremove
  };
}

export default new SunRemovePlugin();

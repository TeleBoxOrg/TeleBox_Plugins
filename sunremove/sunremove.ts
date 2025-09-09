/**
 * SunRemove - 一键解封被封禁的用户
 * 移植自 PagerMaid 的 sunremove.py
 */

import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { getBannedUsers, unbanUser } from "@utils/banUtils";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 延迟函数
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


/**
 * 主命令处理函数
 */
const sunremove = async (msg: Api.Message) => {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
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

  // 参数解析 (acron.ts 模式)
  const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
  const parts = lines?.[0]?.split(/\s+/) || [];
  const [, ...args] = parts;
  
  let mode = "mine";  // 默认只解封自己封禁的
  let num = 0;
  
  if (args.length > 0) {
    if (args[0] === "all") {
      mode = "all";
    } else if (args[0] === "random" && args[1] && !isNaN(parseInt(args[1]))) {
      mode = "random";
      num = parseInt(args[1]);
    } else if (args[0] === "help" || args[0] === "h") {
      await msg.edit({
        text: `<b>🔓 一键解封工具</b>

<b>用法:</b>
• <code>${mainPrefix}sunremove</code> - 解封自己封禁的用户
• <code>${mainPrefix}sunremove all</code> - 解封所有被封禁的用户
• <code>${mainPrefix}sunremove random 5</code> - 随机解封5个用户

<b>说明:</b>
此命令用于批量解封被封禁的群组成员，解封后用户可以重新加入群组。`,
        parseMode: "html"
      });
      return;
    }
  }

  // 获取当前用户ID
  const me = await client.getMe();
  const myId = Number(me.id);
  
  // 获取群组实体
  const chatEntity = msg.peerId;
  
  // 更新状态
  await msg.edit({ 
    text: `🔍 正在获取被封禁用户列表...`, 
    parseMode: "html" 
  });
  
  // 获取被封禁的用户
  let bannedUsers = await getBannedUsers(client, chatEntity);
  
  // 根据模式过滤
  if (mode === "mine") {
    bannedUsers = bannedUsers.filter(u => u.kickedBy === myId);
  } else if (mode === "random" && num > 0) {
    // 随机选择指定数量
    bannedUsers = bannedUsers
      .sort(() => Math.random() - 0.5)
      .slice(0, num);
  }
  // mode === "all" 不需要过滤
  
  if (bannedUsers.length === 0) {
    await msg.edit({ 
      text: `ℹ️ 没有找到需要解封的用户`, 
      parseMode: "html" 
    });
    await sleep(3000);
    await msg.delete();
    return;
  }
  
  // 更新状态
  await msg.edit({ 
    text: `⚡ 正在解封 ${bannedUsers.length} 个用户...`, 
    parseMode: "html" 
  });
  
  // 批量解封
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
    
    // 每解封5个用户更新一次状态
    if ((successCount + failedCount) % 5 === 0) {
      await msg.edit({
        text: `⚡ 解封进度: ${successCount + failedCount}/${bannedUsers.length}`,
        parseMode: "html"
      });
    }
    
    // 添加延迟避免频率限制
    await sleep(500);
  }
  
  // 显示最终结果
  let resultText = "";
  if (failedCount > 0) {
    resultText = `✅ <b>解封完成</b>\n\n` +
      `成功: <code>${successCount}</code> 人\n` +
      `失败: <code>${failedCount}</code> 人\n`;
    if (failedUsers.length <= 5) {
      resultText += `失败用户: ${failedUsers.map(u => htmlEscape(u)).join(", ")}`;
    }
  } else {
    resultText = `✅ <b>解封完成</b>\n\n已成功解封 <code>${successCount}</code> 人`;
  }
  
  await msg.edit({
    text: resultText,
    parseMode: "html"
  });
  
  // 5秒后删除消息
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

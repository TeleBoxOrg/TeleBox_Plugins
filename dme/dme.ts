/**
 * DME (Delete My Messages) Plugin for TeleBox
 * 支持在所有聊天类型中删除自己的消息，包括收藏夹
 */

import { TelegramClient, Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { getEntityWithHash } from "@utils/entityHelpers";
import { Plugin } from "@utils/pluginBase";

// HTML转义函数
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// 通用删除消息函数，支持所有聊天类型包括收藏夹
async function deleteMessagesUniversal(
  client: TelegramClient,
  chatEntity: any,
  messageIds: number[]
): Promise<number> {
  try {
    // 使用通用deleteMessages方法，适用于所有聊天类型
    await client.deleteMessages(chatEntity, messageIds, { revoke: true });
    return messageIds.length;
  } catch (error: any) {
    console.error("[DME] 删除消息失败:", error);
    throw error;
  }
}

// 搜索并删除自己的消息
async function searchAndDeleteMyMessages(
  client: TelegramClient,
  chatEntity: any,
  myId: bigint,
  targetCount: number,
  progressCallback: (text: string) => Promise<void>
): Promise<number> {
  const allMyMessages: Api.Message[] = [];
  let offsetId = 0;
  let searchedTotal = 0;
  const maxSearchLimit = Math.max(targetCount * 10, 2000);

  // 使用getMessages方法，适用于所有聊天类型包括收藏夹
  while (allMyMessages.length < targetCount && searchedTotal < maxSearchLimit) {
    try {
      const messages = await client.getMessages(chatEntity, {
        limit: 100,
        offsetId: offsetId,
      });

      if (messages.length === 0) {
        break;
      }

      searchedTotal += messages.length;
      
      // 筛选自己的消息
      const myMessages = messages.filter(m => {
        if (!m || !m.id || !m.senderId) return false;
        return m.senderId.toString() === myId.toString();
      });
      
      allMyMessages.push(...myMessages);
      
      // 更新偏移量
      if (messages.length > 0) {
        offsetId = messages[messages.length - 1].id;
      }

      // 更新进度
      await progressCallback(
        `🔍 <b>搜索消息中...</b>\n` +
        `📊 已找到: <code>${allMyMessages.length}/${targetCount}</code> 条自己的消息\n` +
        `🔎 已搜索: <code>${searchedTotal}</code> 条总消息\n` +
        `💡 支持所有聊天类型，包括收藏夹...`
      );

      if (allMyMessages.length >= targetCount) break;
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } catch (error: any) {
      if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        for (let i = waitTime; i > 0; i--) {
          await progressCallback(`⏳ <b>API限制，等待 <code>${i}s</code>...</b>`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        continue;
      }
      console.error("[DME] 搜索消息失败:", error);
      break;
    }
  }

  // 删除找到的消息
  const messagesToDelete = allMyMessages.slice(0, targetCount);
  if (messagesToDelete.length === 0) {
    return 0;
  }

  await progressCallback(`🗑️ <b>开始删除消息...</b>\n📊 找到: <code>${messagesToDelete.length}</code> 条`);

  const deleteIds = messagesToDelete.map(m => m.id);
  const batchSize = 50;
  let deletedCount = 0;

  for (let i = 0; i < deleteIds.length; i += batchSize) {
    const batch = deleteIds.slice(i, i + batchSize);
    
    try {
      const batchDeleted = await deleteMessagesUniversal(client, chatEntity, batch);
      deletedCount += batchDeleted;
      
      if (deleteIds.length > batchSize) {
        await progressCallback(`🗑️ <b>删除进度:</b> <code>${deletedCount}/${deleteIds.length}</code>\n⏳ 正在处理批次...`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error: any) {
      if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        for (let j = waitTime; j > 0; j--) {
          await progressCallback(`⏳ <b>API限制，等待 <code>${j}s</code>...</b>\n📊 进度: <code>${deletedCount}/${deleteIds.length}</code>`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        i -= batchSize; // 重试当前批次
      } else {
        console.error("[DME] 删除批次失败:", error);
      }
    }
  }

  return deletedCount;
}

const dmePlugin: Plugin = {
  command: ["dme"],
  description: `删除自己的消息插件：
- dme [数量] - 删除指定数量的自己的消息
- 支持所有聊天类型，包括收藏夹
- 自动处理API限制和重试

示例: dme 100 - 删除100条自己的消息`,
  cmdHandler: async (msg: Api.Message) => {
    const text = msg.message || "";
    const chatId = msg.chatId?.toString() || msg.peerId?.toString() || "";
    const args = text.trim().split(/\s+/);
    const countArg = args[1];

    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    if (!countArg) {
      const helpMsg = `<b>🗑️ 删除自己的消息 - DME</b>

<b>用法:</b>
<code>.dme [数量]</code>

<b>特性:</b>
• 支持所有聊天类型（群组、频道、私聊、收藏夹）
• 深度搜索历史消息
• 智能API限制处理
• 详细删除统计
• 自动重试机制

<b>示例:</b>
<code>.dme 50</code> - 删除50条消息
<code>.dme 999</code> - 删除999条消息
<code>.dme 5000</code> - 删除5000条消息

<b>说明:</b>
插件会自动搜索历史消息并批量删除，
支持在收藏夹等所有聊天类型中使用。`;
      
      await msg.edit({
        text: helpMsg,
        parseMode: "html",
        linkPreview: false
      });
      return;
    }

    const count = parseInt(countArg);
    if (isNaN(count) || count <= 0) {
      await msg.edit({ 
        text: "❌ <b>参数错误:</b> 数量必须是正整数", 
        parseMode: "html" 
      });
      return;
    }

    try {
      // 获取当前用户信息
      const me = await client.getMe();
      const myId = BigInt(me.id.toString());
      
      // 获取聊天实体
      let chatEntity;
      try {
        chatEntity = await getEntityWithHash(client, chatId);
      } catch (error) {
        await msg.edit({ 
          text: `❌ <b>获取聊天实体失败:</b> ${htmlEscape(String(error))}`, 
          parseMode: "html" 
        });
        return;
      }

      // 创建进度消息
      let progressMsg = await client.sendMessage(chatEntity as any, {
        message: `🔍 <b>开始搜索消息...</b>\n📊 目标: <code>${count}</code> 条`,
        parseMode: "html"
      });

      // 进度更新函数
      const updateProgress = async (text: string) => {
        try {
          await progressMsg.edit({ text, parseMode: "html" });
        } catch (error: any) {
          try {
            await client.deleteMessages(chatEntity as any, [progressMsg.id], { revoke: true });
            progressMsg = await client.sendMessage(chatEntity as any, { 
              message: text, 
              parseMode: "html" 
            });
          } catch (e: any) {
            console.error("[DME] 无法更新进度:", e);
          }
        }
      };

      // 执行搜索和删除
      const deletedCount = await searchAndDeleteMyMessages(client, chatEntity as any, myId, count, updateProgress);

      // 清理进度消息
      try {
        await client.deleteMessages(chatEntity as any, [progressMsg.id], { revoke: true });
      } catch {}

      if (deletedCount === 0) {
        const resultMsg = await client.sendMessage(chatEntity as any, {
          message: "❌ <b>未找到自己的消息</b>\n💡 请确认在此聊天中发送过消息",
          parseMode: "html"
        });
        setTimeout(async () => {
          try {
            await client.deleteMessages(chatEntity as any, [resultMsg.id], { revoke: true });
          } catch {}
        }, 3000);
      } else {
        // 发送结果
        const resultMsg = await client.sendMessage(chatEntity as any, {
          message: `✅ <b>删除完成！</b>\n\n📊 <b>统计信息:</b>\n• 删除: <code>${deletedCount}</code> 条消息\n\n💡 支持所有聊天类型，包括收藏夹`,
          parseMode: "html"
        });

        setTimeout(async () => {
          try {
            await client.deleteMessages(chatEntity as any, [resultMsg.id], { revoke: true });
          } catch {}
        }, 5000);
      }

    } catch (error: any) {
      console.error("[DME] 删除失败:", error);
      await msg.edit({ 
        text: `❌ <b>操作失败:</b> ${htmlEscape(error.message || String(error))}`, 
        parseMode: "html" 
      });
    }
  },
};

export default dmePlugin;

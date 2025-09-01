/**
 * DME (Delete My Messages) Plugin for TeleBox
 * 智能防撤回删除插件 - 优化版本
 * 支持媒体消息防撤回处理，文本消息快速删除
 */

import { TelegramClient, Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { getEntityWithHash } from "@utils/entityHelpers";
import { Plugin } from "@utils/pluginBase";
import { CustomFile } from "telegram/client/uploads";
import * as fs from "fs";
import * as path from "path";

// 常量配置
const CONFIG = {
  TROLL_IMAGE_URL: "https://www.hhlqilongzhu.cn/api/tu_tuwen.php?msg=不可以防撤回哦",
  TROLL_IMAGE_PATH: "./assets/dme/dme_troll_image.jpg",
  BATCH_SIZE: 50,
  SEARCH_LIMIT: 100,
  MAX_SEARCH_MULTIPLIER: 10,
  MIN_MAX_SEARCH: 2000,
  DELAYS: {
    BATCH: 200,
    EDIT_WAIT: 1000,
    SEARCH: 100,
    RESULT_DISPLAY: 3000
  }
} as const;

// 工具函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[m] || m));

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const formatProgress = (current: number, total: number): string => `<code>${current}/${total}</code>`;

/**
 * 获取防撤回图片，支持缓存
 */
async function getTrollImage(): Promise<string | null> {
  if (fs.existsSync(CONFIG.TROLL_IMAGE_PATH)) {
    return CONFIG.TROLL_IMAGE_PATH;
  }

  const dir = path.dirname(CONFIG.TROLL_IMAGE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    const response = await fetch(CONFIG.TROLL_IMAGE_URL);
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(CONFIG.TROLL_IMAGE_PATH, buffer);
      return CONFIG.TROLL_IMAGE_PATH;
    }
    return null;
  } catch (error) {
    console.error("[DME] 下载防撤回图片失败:", error);
    return null;
  }
}

/**
 * 通用删除消息函数
 */
async function deleteMessagesUniversal(
  client: TelegramClient,
  chatEntity: any,
  messageIds: number[]
): Promise<number> {
  await client.deleteMessages(chatEntity, messageIds, { revoke: true });
  return messageIds.length;
}

/**
 * 媒体消息防撤回处理
 */
async function editMediaMessageToAntiRecall(
  client: TelegramClient,
  message: Api.Message,
  trollImagePath: string | null,
  chatEntity: any
): Promise<boolean> {
  // 只处理媒体消息（排除网页预览）
  if (!message.media || message.media instanceof Api.MessageMediaWebPage) {
    return false;
  }

  if (!trollImagePath || !fs.existsSync(trollImagePath)) {
    return false;
  }

  try {
    const uploadedFile = await client.uploadFile({
      file: new CustomFile(
        "dme_troll.jpg",
        fs.statSync(trollImagePath).size,
        trollImagePath
      ),
      workers: 1
    });

    await client.invoke(
      new Api.messages.EditMessage({
        peer: chatEntity,
        id: message.id,
        message: "",
        media: new Api.InputMediaUploadedPhoto({ file: uploadedFile })
      })
    );
    return true;
  } catch (error) {
    console.error("[DME] 编辑媒体消息失败:", error);
    return false;
  }
}

/**
 * 搜索并处理用户消息的主函数
 */
async function searchEditAndDeleteMyMessages(
  client: TelegramClient,
  chatEntity: any,
  myId: bigint,
  userRequestedCount: number,
  progressCallback: (text: string) => Promise<void>
): Promise<{ processedCount: number; actualCount: number; editedCount: number }> {
  const actualCount = userRequestedCount + 2;
  const maxSearchLimit = Math.max(actualCount * CONFIG.MAX_SEARCH_MULTIPLIER, CONFIG.MIN_MAX_SEARCH);
  
  await progressCallback(`🔍 <b>搜索消息中...</b>`);

  const allMyMessages: Api.Message[] = [];
  let offsetId = 0;
  let searchedTotal = 0;

  // 搜索用户消息
  while (allMyMessages.length < actualCount && searchedTotal < maxSearchLimit) {
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
      const myMessages = messages.filter((m: Api.Message) => {
        if (!m?.id || !m?.senderId) return false;
        return m.senderId.toString() === myId.toString();
      });
      
      allMyMessages.push(...myMessages);
      
      if (messages.length > 0) {
        offsetId = messages[messages.length - 1].id;
      }

      await progressCallback(`🔍 <b>搜索中...</b>`);

      if (allMyMessages.length >= actualCount) break;
      await sleep(CONFIG.DELAYS.SEARCH);
      
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

  // 处理找到的消息
  const messagesToProcess = allMyMessages.slice(0, actualCount);
  if (messagesToProcess.length === 0) {
    return { processedCount: 0, actualCount, editedCount: 0 };
  }

  // 分类消息：媒体消息和文字消息
  const mediaMessages = messagesToProcess.filter((m: Api.Message) => 
    m.media && !(m.media instanceof Api.MessageMediaWebPage)
  );

  await progressCallback(`📊 <b>分类消息...</b>`);

  let editedCount = 0;
  if (mediaMessages.length > 0) {
    const trollImagePath = await getTrollImage();
    
    await progressCallback(`🛡️ <b>处理媒体消息...</b>`);

    const editTasks = mediaMessages.map(message => 
      editMediaMessageToAntiRecall(client, message, trollImagePath, chatEntity)
    );

    const results = await Promise.allSettled(editTasks);
    editedCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    
    await progressCallback(`🖼️ <b>媒体处理完成</b>`);
    await sleep(CONFIG.DELAYS.EDIT_WAIT);
  }

  // 删除消息
  await progressCallback(`🗑️ <b>删除消息中...</b>`);

  const deleteIds = messagesToProcess.map((m: Api.Message) => m.id);
  let deletedCount = 0;

  for (let i = 0; i < deleteIds.length; i += CONFIG.BATCH_SIZE) {
    const batch = deleteIds.slice(i, i + CONFIG.BATCH_SIZE);
    
    try {
      const batchDeleted = await deleteMessagesUniversal(client, chatEntity, batch);
      deletedCount += batchDeleted;
      
      if (deleteIds.length > CONFIG.BATCH_SIZE) {
        await progressCallback(`🗑️ <b>删除中...</b>`);
      }
      
      await sleep(CONFIG.DELAYS.BATCH);
    } catch (error: any) {
      if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        for (let j = waitTime; j > 0; j--) {
          await progressCallback(`⏳ <b>等待 <code>${j}s</code>...</b>`);
          await sleep(1000);
        }
        i -= CONFIG.BATCH_SIZE; // 重试当前批次
      } else {
        console.error("[DME] 删除批次失败:", error);
      }
    }
  }

  return { processedCount: deletedCount, actualCount, editedCount };
}

const dmePlugin: Plugin = {
  command: ["dme"],
  description: `智能防撤回删除插件 - 优化版本
- dme [数量] - 处理指定数量的消息（实际+2）
- 媒体消息：防撤回图片替换
- 文字消息：直接删除提升速度
- 支持所有聊天类型`,
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
      const helpMsg = `<b>🛡️ 智能防撤回删除插件 - DME 优化版</b>

<b>用法:</b> <code>.dme [数量]</code>

<b>核心特性:</b>
• 🧠 <b>智能策略</b>：媒体消息防撤回，文字消息快速删除
• 🖼️ <b>媒体消息</b>：替换为防撤回图片（真正防撤回）
• 📝 <b>文字消息</b>：直接删除（提升速度）
• ➕ <b>智能+2</b>：实际处理数量=输入数量+2
• ⚡ <b>性能优化</b>：批量处理，减少API调用
• 🌍 支持所有聊天类型
<b>工作流程:</b>
1️⃣ 搜索历史消息 → 2️⃣ 分类处理 → 3️⃣ 媒体防撤回 → 4️⃣ 批量删除`;
      
      await msg.edit({
        text: helpMsg,
        parseMode: "html",
        linkPreview: false
      });
      return;
    }

    const userRequestedCount = parseInt(countArg);
    if (isNaN(userRequestedCount) || userRequestedCount <= 0) {
      await msg.edit({ 
        text: "❌ <b>参数错误:</b> 数量必须是正整数", 
        parseMode: "html" 
      });
      return;
    }

    try {
      const me = await client.getMe();
      const myId = BigInt(me.id.toString());
      
      const chatEntity = await getEntityWithHash(client, chatId);

      // 删除命令消息
      try {
        await msg.delete();
      } catch (error) {
        console.error("[DME] 删除命令消息失败:", error);
      }

      // 创建进度消息
      let progressMsg = await client.sendMessage(chatEntity as any, {
        message: `🔍 <b>开始处理...</b>`,
        parseMode: "html"
      });

      // 进度更新函数
      const updateProgress = async (text: string) => {
        try {
          await progressMsg.edit({ text, parseMode: "html" });
        } catch {
          try {
            await client.deleteMessages(chatEntity as any, [progressMsg.id], { revoke: true });
            progressMsg = await client.sendMessage(chatEntity as any, { 
              message: text, 
              parseMode: "html" 
            });
          } catch (e) {
            console.error("[DME] 无法更新进度:", e);
          }
        }
      };

      // 执行主要操作
      const result = await searchEditAndDeleteMyMessages(client, chatEntity as any, myId, userRequestedCount, updateProgress);

      // 清理进度消息
      try {
        await client.deleteMessages(chatEntity as any, [progressMsg.id], { revoke: true });
      } catch {}

      // 显示结果
      const resultMessage = result.processedCount === 0 
        ? "❌ <b>未找到消息</b>"
        : `✅ <b>操作完成</b>`;

      const resultMsg = await client.sendMessage(chatEntity as any, {
        message: resultMessage,
        parseMode: "html"
      });

      setTimeout(async () => {
        try {
          await client.deleteMessages(chatEntity as any, [resultMsg.id], { revoke: true });
        } catch {}
      }, CONFIG.DELAYS.RESULT_DISPLAY);

    } catch (error: any) {
      console.error("[DME] 操作失败:", error);
      await msg.edit({ 
        text: `❌ <b>操作失败:</b> ${htmlEscape(error.message || String(error))}`, 
        parseMode: "html" 
      });
    }
  },
};

export default dmePlugin;

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
  TROLL_IMAGE_URL:
    "https://raw.githubusercontent.com/TeleBoxDev/TeleBox/main/telebox.png",
  TROLL_IMAGE_PATH: "./assets/dme/dme_troll_image.png",
  BATCH_SIZE: 50,
  MIN_BATCH_SIZE: 5, // 最小批次大小
  MAX_BATCH_SIZE: 100, // 最大批次大小
  SEARCH_LIMIT: 100,
  MAX_SEARCH_MULTIPLIER: 10,
  MIN_MAX_SEARCH: 2000,
  DEFAULT_BATCH_LIMIT: 30,
  RETRY_ATTEMPTS: 3, // 重试次数
  DELAYS: {
    BATCH: 200,
    EDIT_WAIT: 1000,
    SEARCH: 100,
    RESULT_DISPLAY: 3000,
    RETRY: 2000, // 重试延迟
    NETWORK_ERROR: 5000, // 网络错误延迟
  },
} as const;

// 工具函数
const htmlEscape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" }[
        m
      ] || m)
  );

// 获取命令前缀
const prefixes = ["."];
const mainPrefix = prefixes[0];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const formatProgress = (current: number, total: number): string =>
  `<code>${current}/${total}</code>`;

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
 * 带重试机制的删除消息函数
 */
async function deleteMessagesWithRetry(
  client: TelegramClient,
  chatEntity: any,
  messageIds: number[],
  retryCount: number = 0
): Promise<number> {
  try {
    await client.deleteMessages(chatEntity, messageIds, { revoke: true });
    
    // 强制刷新更新状态，确保跨平台同步
    try {
      await client.invoke(new Api.updates.GetState());
      console.log(`[DME] 已触发跨平台同步刷新`);
    } catch (syncError) {
      console.log(`[DME] 同步刷新失败，但不影响删除操作:`, syncError);
    }
    
    return messageIds.length;
  } catch (error: any) {
    if (retryCount < CONFIG.RETRY_ATTEMPTS) {
      console.log(`[DME] 删除失败，第 ${retryCount + 1} 次重试:`, error.message);
      await sleep(CONFIG.DELAYS.RETRY * (retryCount + 1));
      return deleteMessagesWithRetry(client, chatEntity, messageIds, retryCount + 1);
    }
    throw error;
  }
}

/**
 * 通用删除消息函数 - 增强版本
 */
async function deleteMessagesUniversal(
  client: TelegramClient,
  chatEntity: any,
  messageIds: number[]
): Promise<number> {
  return deleteMessagesWithRetry(client, chatEntity, messageIds);
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
  // 排除网页预览
  if (!message.media || message.media instanceof Api.MessageMediaWebPage) {
    return false;
  }

  // 检查是否为贴纸并跳过
  if (message.media instanceof Api.MessageMediaDocument) {
    const doc = message.media.document;
    if (doc instanceof Api.Document) {
      // 检查文档属性中是否包含贴纸标识
      const isSticker = doc.attributes?.some(attr => 
        attr instanceof Api.DocumentAttributeSticker
      );
      if (isSticker) {
        return false;
      }
    }
  }

  if (!trollImagePath || !fs.existsSync(trollImagePath)) {
    return false;
  }

  // 超过可编辑时间窗口(48h)则静默跳过，避免 MESSAGE_EDIT_TIME_EXPIRED
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof (message as any).date === "number" && nowSec - (message as any).date > 172800) {
    return false;
  }

  try {
    const uploadedFile = await client.uploadFile({
      file: new CustomFile(
        "dme_troll.jpg",
        fs.statSync(trollImagePath).size,
        trollImagePath
      ),
      workers: 1,
    });

    await client.invoke(
      new Api.messages.EditMessage({
        peer: chatEntity,
        id: message.id,
        message: "",
        media: new Api.InputMediaUploadedPhoto({ file: uploadedFile }),
      })
    );
    return true;
  } catch {
    // 任意编辑失败(含 MESSAGE_EDIT_TIME_EXPIRED)静默跳过
    return false;
  }
}

/**
 * 增强的消息搜索函数 - 带容错机制
 */
async function searchMyMessagesOptimized(
  client: TelegramClient,
  chatEntity: any,
  myId: bigint,
  userRequestedCount: number
): Promise<Api.Message[]> {
  const allMyMessages: Api.Message[] = [];
  let offsetId = 0;
  const targetCount = userRequestedCount === 999999 ? Infinity : userRequestedCount;
  let consecutiveFailures = 0;
  const maxFailures = 3;

  console.log(`[DME] 使用增强搜索模式，直接定位自己的消息`);

  try {
    while (allMyMessages.length < targetCount && consecutiveFailures < maxFailures) {
      try {
        const searchResult = await client.invoke(
          new Api.messages.Search({
            peer: chatEntity,
            q: "",
            fromId: await client.getInputEntity(myId.toString()),
            filter: new Api.InputMessagesFilterEmpty(),
            minDate: 0,
            maxDate: 0,
            offsetId: offsetId,
            addOffset: 0,
            limit: Math.min(100, targetCount - allMyMessages.length),
            maxId: 0,
            minId: 0,
            hash: 0 as any
          })
        );

        const resultMessages = (searchResult as any).messages;
        if (!resultMessages || resultMessages.length === 0) {
          console.log(`[DME] 搜索完成，共找到 ${allMyMessages.length} 条自己的消息`);
          break;
        }

        const messages = resultMessages.filter((m: any) => 
          m.className === "Message" && m.senderId?.toString() === myId.toString()
        );

        if (messages.length > 0) {
          allMyMessages.push(...messages);
          offsetId = messages[messages.length - 1].id;
          console.log(`[DME] 批次搜索到 ${messages.length} 条消息，总计 ${allMyMessages.length} 条`);
          consecutiveFailures = 0; // 重置失败计数
        } else {
          break;
        }

        await sleep(CONFIG.DELAYS.SEARCH);
      } catch (searchError: any) {
        consecutiveFailures++;
        console.log(`[DME] 搜索失败 ${consecutiveFailures}/${maxFailures}:`, searchError.message);
        if (consecutiveFailures < maxFailures) {
          await sleep(CONFIG.DELAYS.NETWORK_ERROR);
        }
      }
    }
  } catch (error: any) {
    console.error("[DME] 优化搜索失败，回退到传统模式:", error);
    return [];
  }

  return allMyMessages.slice(0, targetCount === Infinity ? allMyMessages.length : targetCount);
}

/**
 * 判断是否为“收藏夹/保存的消息”会话
 */
function isSavedMessagesPeer(chatEntity: any, myId: bigint): boolean {
  return (
    (chatEntity?.className === "User" && chatEntity?.id?.toString?.() === myId.toString()) ||
    chatEntity?.className === "PeerSelf" ||
    chatEntity?.className === "InputPeerSelf" ||
    ((chatEntity?.className === "PeerUser" || chatEntity?.className === "InputPeerUser") &&
      chatEntity?.userId?.toString?.() === myId.toString())
  );
}

/**
 * 自适应批次删除函数
 */
async function adaptiveBatchDelete(
  client: TelegramClient,
  chatEntity: any,
  messageIds: number[]
): Promise<{ deletedCount: number; failedCount: number }> {
  if (messageIds.length === 0) {
    return { deletedCount: 0, failedCount: 0 };
  }

  let deletedCount = 0;
  let failedCount = 0;
  let currentBatchSize: number = CONFIG.BATCH_SIZE;
  
  console.log(`[DME] 开始自适应批次删除，总计 ${messageIds.length} 条消息`);
  
  for (let i = 0; i < messageIds.length; i += currentBatchSize) {
    const batch = messageIds.slice(i, i + currentBatchSize);
    
    try {
      const deleted = await deleteMessagesWithRetry(client, chatEntity, batch);
      deletedCount += deleted;
      
      // 成功则逐步增大批次
      if (currentBatchSize < CONFIG.MAX_BATCH_SIZE) {
        currentBatchSize = Math.min(currentBatchSize + 10, CONFIG.MAX_BATCH_SIZE);
      }
      
      console.log(`[DME] 批次删除成功: ${deleted}/${batch.length} 条，下批大小: ${currentBatchSize}`);
      await sleep(CONFIG.DELAYS.BATCH);
      
    } catch (error: any) {
      console.error(`[DME] 批次删除失败:`, error.message);
      failedCount += batch.length;
      
      // 失败则减小批次大小
      if (currentBatchSize > CONFIG.MIN_BATCH_SIZE) {
        currentBatchSize = Math.max(CONFIG.MIN_BATCH_SIZE, Math.floor(currentBatchSize / 2));
        console.log(`[DME] 调整批次大小为: ${currentBatchSize}`);
      }
      
      // 网络错误时等待更长时间
      if (error.message?.includes('FLOOD') || error.message?.includes('NETWORK')) {
        await sleep(CONFIG.DELAYS.NETWORK_ERROR);
      } else {
        await sleep(CONFIG.DELAYS.RETRY);
      }
    }
  }
  
  console.log(`[DME] 批次删除完成，成功: ${deletedCount}，失败: ${failedCount}`);
  return { deletedCount, failedCount };
}

/**
 * 收藏夹直接按数量删除（不做媒体编辑）
 */
async function deleteInSavedMessages(
  client: TelegramClient,
  chatEntity: any,
  userRequestedCount: number
): Promise<{ processedCount: number; actualCount: number; editedCount: number }> {
  const target = userRequestedCount;
  const ids: number[] = [];
  let offsetId = 0;

  while (ids.length < target) {
    const history = await client.invoke(
      new Api.messages.GetHistory({
        peer: chatEntity,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit: Math.min(100, target - ids.length),
        maxId: 0,
        minId: 0,
        hash: 0 as any,
      })
    );
    const msgs: any[] = (history as any).messages || [];
    const justMsgs = msgs.filter((m: any) => m.className === "Message");
    if (justMsgs.length === 0) break;
    ids.push(...justMsgs.map((m: any) => m.id));
    offsetId = justMsgs[justMsgs.length - 1].id;
    await sleep(200);
  }

  if (ids.length === 0)
    return { processedCount: 0, actualCount: 0, editedCount: 0 };

  let deleted = 0;
  for (let i = 0; i < ids.length; i += CONFIG.BATCH_SIZE) {
    const batch = ids.slice(i, i + CONFIG.BATCH_SIZE);
    try {
      deleted += await deleteMessagesUniversal(client, chatEntity, batch);
      await sleep(CONFIG.DELAYS.BATCH);
    } catch (e) {
      console.error("[DME] 收藏夹删除批次失败:", e);
      await sleep(1000);
    }
  }

  return { processedCount: deleted, actualCount: ids.length, editedCount: 0 };
}

/**
 * 兼容“频道身份发言”的搜索：扫描历史并筛选 out=true
 */
async function searchMyOutgoingMessages(
  client: TelegramClient,
  chatEntity: any,
  userRequestedCount: number
): Promise<Api.Message[]> {
  const targetCount = userRequestedCount === 999999 ? Infinity : userRequestedCount;
  const results: Api.Message[] = [];
  let offsetId = 0;

  while (true) {
    if (targetCount !== Infinity && results.length >= targetCount) break;
    const history = await client.invoke(
      new Api.messages.GetHistory({
        peer: chatEntity,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit: Math.min(100, targetCount === Infinity ? 100 : targetCount - results.length),
        maxId: 0,
        minId: 0,
        hash: 0 as any,
      })
    );
    const msgs: any[] = (history as any).messages || [];
    const justMsgs = msgs.filter((m: any) => m.className === "Message");
    if (justMsgs.length === 0) break;
    const outMsgs = justMsgs.filter((m: any) => m.out === true);
    results.push(...outMsgs);
    offsetId = justMsgs[justMsgs.length - 1].id;
    await sleep(150);
  }

  return targetCount === Infinity ? results : results.slice(0, targetCount);
}
/**
 * 搜索并处理用户消息的主函数 - 优化版本
 */
async function searchEditAndDeleteMyMessages(
  client: TelegramClient,
  chatEntity: any,
  myId: bigint,
  userRequestedCount: number
): Promise<{
  processedCount: number;
  actualCount: number;
  editedCount: number;
}> {
  // 收藏夹（保存的消息）专用快速删除
  if (isSavedMessagesPeer(chatEntity, myId)) {
    console.log("[DME] 检测到收藏夹会话，直接按数量删除");
    return await deleteInSavedMessages(client, chatEntity, userRequestedCount);
  }

  // 检查是否为频道且有管理权限
  const isChannel = chatEntity.className === "Channel";
  if (isChannel) {
    console.log(`[DME] 检测到频道，检查管理员权限...`);
    try {
      const me = await client.getMe();
      const participant = await client.invoke(
        new Api.channels.GetParticipant({
          channel: chatEntity,
          participant: me.id,
        })
      );

      // 若为私人频道且自己是频道主，直接按数量删除（与收藏夹相同方案）
      const isCreator =
        participant.participant.className === "ChannelParticipantCreator";
      const isBroadcast = (chatEntity as any).broadcast === true;
      if (isCreator && isBroadcast) {
        console.log(`[DME] 检测到私人频道且为频道主，直接按数量删除`);
        return await deleteInSavedMessages(client, chatEntity, userRequestedCount);
      }

      const isAdmin =
        participant.participant.className === "ChannelParticipantAdmin" ||
        participant.participant.className === "ChannelParticipantCreator";

      if (isAdmin) {
        console.log(`[DME] 拥有频道管理权限，但仍使用普通模式避免误删别人消息`);
        console.log(`[DME] 如需删除所有消息，请使用其他管理工具`);
      } else {
        console.log(`[DME] 无频道管理权限，使用普通模式`);
      }
    } catch (error) {
      console.log(`[DME] 权限检查失败，使用普通模式:`, error);
    }
  }
  console.log(`[DME] 开始优化搜索消息，目标数量: ${userRequestedCount === 999999 ? "全部" : userRequestedCount}`);

  // 使用优化搜索模式直接获取自己的消息
  let allMyMessages = await searchMyMessagesOptimized(
    client, 
    chatEntity, 
    myId, 
    userRequestedCount
  );

  // 回退：兼容频道身份发言（fromId 不匹配），改用 out=true 获取
  const targetCount = userRequestedCount === 999999 ? Infinity : userRequestedCount;
  if (allMyMessages.length === 0 || (targetCount !== Infinity && allMyMessages.length < targetCount)) {
    console.log('[DME] fromId 搜索不足，回退到 out=true 以兼容频道身份发言');
    allMyMessages = await searchMyOutgoingMessages(client, chatEntity, userRequestedCount);
  }

  if (allMyMessages.length === 0) {
    console.log(`[DME] 未找到任何自己的消息`);
    return { processedCount: 0, actualCount: 0, editedCount: 0 };
  }

  // 处理找到的消息  
  const messagesToProcess = targetCount === Infinity ? allMyMessages : allMyMessages.slice(0, targetCount);
  if (messagesToProcess.length === 0) {
    console.log(`[DME] 未找到任何需要处理的消息`);
    return { processedCount: 0, actualCount: 0, editedCount: 0 };
  }

  console.log(`[DME] 准备处理 ${messagesToProcess.length} 条消息`);

  // 分类消息：媒体消息和文字消息（排除贴纸）
  const mediaMessages = messagesToProcess.filter((m: Api.Message) => {
    if (!m.media || m.media instanceof Api.MessageMediaWebPage) {
      return false;
    }
    
    // 排除贴纸类型消息
    if (m.media instanceof Api.MessageMediaDocument) {
      const doc = m.media.document;
      if (doc instanceof Api.Document) {
        const isSticker = doc.attributes?.some(attr => 
          attr instanceof Api.DocumentAttributeSticker
        );
        if (isSticker) {
          return false;
        }
      }
    }
    
    return true;
  });

  let editedCount = 0;
  if (mediaMessages.length > 0) {
    console.log(`[DME] 处理 ${mediaMessages.length} 条媒体消息...`);
    const trollImagePath = await getTrollImage();

    const editTasks = mediaMessages.map((message) =>
      editMediaMessageToAntiRecall(client, message, trollImagePath, chatEntity)
    );

    const results = await Promise.allSettled(editTasks);
    editedCount = results.filter(
      (r) => r.status === "fulfilled" && r.value === true
    ).length;
    console.log(`[DME] 成功编辑 ${editedCount} 条媒体消息`);

    await sleep(CONFIG.DELAYS.EDIT_WAIT);
  }

  // 自适应批次删除消息
  console.log(`[DME] 开始自适应批次删除 ${messagesToProcess.length} 条消息...`);
  const deleteIds = messagesToProcess.map((m: Api.Message) => m.id);
  const result = await adaptiveBatchDelete(client, chatEntity, deleteIds);
  const deletedCount = result.deletedCount;

  console.log(`[DME] 删除完成，共删除 ${deletedCount} 条消息`);

  return {
    processedCount: deletedCount,
    actualCount: messagesToProcess.length,
    editedCount,
  };
}

// 已移除频道直接删除功能，避免误删别人消息
// 所有情况下都使用普通模式，只删除自己的消息

// 定义帮助文本常量
const help_text = `🗑️ <b>智能防撤回删除插件</b>

<b>命令格式：</b>
<code>${mainPrefix}dme [数量]</code>

<b>可用命令：</b>
• <code>${mainPrefix}dme [数量]</code> - 删除指定数量的消息
• <code>${mainPrefix}dme help</code> - 显示帮助信息

<b>示例：</b>
• <code>${mainPrefix}dme 10</code> - 删除最近10条消息
• <code>${mainPrefix}dme 100</code> - 删除最近100条消息
• <code>${mainPrefix}dme 999999</code> - 删除所有自己的消息`;

const dme = async (msg: Api.Message) => {
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
    // 无参数时显示帮助
    if (!sub) {
      await msg.edit({
        text: help_text,
        parseMode: "html"
      });
      return;
    }

    // 处理 help 命令
    if (sub === "help" || sub === "h") {
      await msg.edit({
        text: help_text,
        parseMode: "html"
      });
      return;
    }

    // 解析数量参数
    const userRequestedCount = parseInt(sub);
    if (isNaN(userRequestedCount) || userRequestedCount <= 0) {
      await msg.edit({
        text: `❌ <b>参数错误:</b> 数量必须是正整数\n\n💡 使用 <code>${mainPrefix}dme help</code> 查看帮助`,
        parseMode: "html"
      });
      return;
    }

    const me = await client.getMe();
    const myId = BigInt(me.id.toString());
    const chatId = msg.chatId?.toString() || msg.peerId?.toString() || "";
    const chatEntity = await getEntityWithHash(client, chatId);

    // 删除命令消息
    try {
      await client.deleteMessages(chatEntity as any, [msg.id], {
        revoke: true,
      });
    } catch {}

    // 执行主要操作
    console.log(`[DME] ========== 开始执行DME任务 ==========`);
    console.log(`[DME] 聊天ID: ${chatId}`);
    console.log(`[DME] 请求数量: ${userRequestedCount}`);
    console.log(`[DME] 使用优化搜索模式`);
    const startTime = Date.now();

    const result = await searchEditAndDeleteMyMessages(
      client,
      chatEntity as any,
      myId,
      userRequestedCount
    );

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`[DME] ========== 任务完成 ==========`);
    console.log(`[DME] 总耗时: ${duration} 秒`);
    console.log(`[DME] 处理消息: ${result.processedCount} 条`);
    console.log(`[DME] 编辑媒体: ${result.editedCount} 条`);
    console.log(`[DME] =============================`);

    // 完全静默模式 - 不发送任何前台消息
  } catch (error: any) {
    console.error("[DME] 操作失败:", error);
    await msg.edit({
      text: `❌ <b>操作失败:</b> ${htmlEscape(error.message || "未知错误")}`,
      parseMode: "html"
    });
  }
};

class DmePlugin extends Plugin {
  description: string = `智能防撤回删除插件\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    dme,
  };
}

export default new DmePlugin();

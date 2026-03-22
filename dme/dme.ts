/**
 * DME (Delete My Messages) Plugin for TeleBox
 * 智能防撤回删除插件 - 优化版本
 * 支持媒体消息防撤回处理，文本消息快速删除
 */

import { TelegramClient, Api } from "teleproto";
import { getGlobalClient } from "@utils/globalClient";
import { getEntityWithHash } from "@utils/entityHelpers";
import { Plugin } from "@utils/pluginBase";
import { CustomFile } from "teleproto/client/uploads";
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
  MAX_SAFE_REQUEST_COUNT: 2000, // 单次请求安全上限（防止堆内存暴涨）
  CHANNEL_EMPTY_BATCH_LIMIT: 300, // 频道深度扫描空批次上限
  UNLIMITED_REQUEST_COUNT: 999999, // 特殊值：删除全部可见消息
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

        const messages = resultMessages.filter(
          (m: any) =>
            m.className === "Message" &&
            (m.senderId?.toString() === myId.toString() || m.out === true)
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

function peerToTypedKey(peer: any): string | null {
  if (!peer) return null;
  if (peer.userId !== undefined && peer.userId !== null) {
    return `user:${peer.userId.toString()}`;
  }
  if (peer.channelId !== undefined && peer.channelId !== null) {
    return `channel:${peer.channelId.toString()}`;
  }
  if (peer.chatId !== undefined && peer.chatId !== null) {
    return `chat:${peer.chatId.toString()}`;
  }
  return null;
}

function normalizeIdToken(idText: string): string {
  if (idText.startsWith("-100")) return idText.slice(4);
  if (idText.startsWith("-")) return idText.slice(1);
  return idText;
}

function getPeerRawId(peer: any): string | null {
  if (!peer) return null;
  if (peer.userId !== undefined && peer.userId !== null) {
    return peer.userId.toString();
  }
  if (peer.channelId !== undefined && peer.channelId !== null) {
    return peer.channelId.toString();
  }
  if (peer.chatId !== undefined && peer.chatId !== null) {
    return peer.chatId.toString();
  }
  if (
    typeof peer === "bigint" ||
    typeof peer === "number" ||
    typeof peer === "string"
  ) {
    return peer.toString();
  }
  return null;
}

async function getSendAsIdentitySet(
  client: TelegramClient,
  chatEntity: any
): Promise<{ typedKeys: Set<string>; rawIds: Set<string> }> {
  const typedKeys = new Set<string>();
  const rawIds = new Set<string>();
  try {
    const sendAs = await client.invoke(
      new Api.channels.GetSendAs({
        peer: chatEntity,
      })
    );
    const peers = (sendAs as any).peers || [];
    for (const item of peers) {
      const peer = (item as any)?.peer;
      const typedKey = peerToTypedKey(peer);
      if (typedKey) {
        typedKeys.add(typedKey);
      }
      const rawId = getPeerRawId(peer);
      if (rawId) {
        rawIds.add(rawId);
        rawIds.add(normalizeIdToken(rawId));
      }
    }
    console.log(
      `[DME] 获取发送身份成功: typed=${typedKeys.size}, raw=${rawIds.size}`
    );
  } catch (error: any) {
    console.log(`[DME] 获取发送身份失败，回退基础匹配: ${error?.message || error}`);
  }
  return { typedKeys, rawIds };
}

function isMyMessageByIdentity(
  message: any,
  myId: bigint,
  sendAsTypedKeySet: Set<string>,
  sendAsRawIdSet: Set<string>
): boolean {
  if (message.senderId?.toString?.() === myId.toString()) {
    return true;
  }
  if (message.out === true) {
    return true;
  }
  const identityCandidates = [message.fromId, message.senderId];
  for (const candidate of identityCandidates) {
    const typedKey = peerToTypedKey(candidate);
    if (typedKey && sendAsTypedKeySet.has(typedKey)) {
      return true;
    }

    const rawId = getPeerRawId(candidate);
    if (rawId) {
      if (
        sendAsRawIdSet.has(rawId) ||
        sendAsRawIdSet.has(normalizeIdToken(rawId))
      ) {
        return true;
      }
    }
  }
  return false;
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
  const target =
    userRequestedCount === CONFIG.UNLIMITED_REQUEST_COUNT
      ? Infinity
      : userRequestedCount;
  let offsetId = 0;
  let totalMatched = 0;
  let totalDeleted = 0;

  while (target === Infinity || totalMatched < target) {
    const searchLimit =
      target === Infinity
        ? CONFIG.SEARCH_LIMIT
        : Math.min(CONFIG.SEARCH_LIMIT, target - totalMatched);
    const history = await client.invoke(
      new Api.messages.GetHistory({
        peer: chatEntity,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit: searchLimit,
        maxId: 0,
        minId: 0,
        hash: 0 as any,
      })
    );
    const msgs: any[] = (history as any).messages || [];
    const justMsgs = msgs.filter((m: any) => m.className === "Message");
    if (justMsgs.length === 0) break;
    const ids = justMsgs.map((m: any) => m.id);
    totalMatched += ids.length;

    for (let i = 0; i < ids.length; i += CONFIG.BATCH_SIZE) {
      const batch = ids.slice(i, i + CONFIG.BATCH_SIZE);
      try {
        totalDeleted += await deleteMessagesUniversal(client, chatEntity, batch);
        await sleep(CONFIG.DELAYS.BATCH);
      } catch (e) {
        console.error("[DME] 收藏夹删除批次失败:", e);
        await sleep(1000);
      }
    }

    offsetId = justMsgs[justMsgs.length - 1].id;
    await sleep(200);
  }

  if (totalMatched === 0)
    return { processedCount: 0, actualCount: 0, editedCount: 0 };

  return { processedCount: totalDeleted, actualCount: totalMatched, editedCount: 0 };
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
 * 检测群组是否禁止转发和复制（受限群组）
 */
async function isRestrictedGroup(client: TelegramClient, chatEntity: any): Promise<boolean> {
  try {
    // 检查群组类型和权限
    if (chatEntity.className === "Chat" || chatEntity.className === "Channel") {
      // 尝试获取群组完整信息
      const fullChat = await client.invoke(
        new Api.messages.GetFullChat({ chatId: chatEntity.id })
      ).catch(() => null);
      
      if (fullChat) {
        const chatFull = (fullChat as any).fullChat;
        // 检查是否有内容保护标志
        if (chatFull.noforwards === true) {
          console.log(`[DME] 检测到禁止转发群组`);
          return true;
        }
      }
      
      // 检查频道权限
      if (chatEntity.className === "Channel") {
        const channelFull = await client.invoke(
          new Api.channels.GetFullChannel({ channel: chatEntity })
        ).catch(() => null);
        
        if (channelFull) {
          const fullChannel = (channelFull as any).fullChat;
          if (fullChannel.noforwards === true) {
            console.log(`[DME] 检测到禁止转发频道`);
            return true;
          }
        }
      }
    }
    
    return false;
  } catch (error: any) {
    console.log(`[DME] 权限检测失败，假设为受限群组:`, error.message);
    return true; // 检测失败时保守处理，使用传统模式
  }
}

/**
 * 传统遍历消息流式处理 - 适用于禁止转发和复制的群组
 */
async function traditionalStreamProcessing(
  client: TelegramClient,
  chatEntity: any,
  myId: bigint,
  userRequestedCount: number,
  isAntiRecallMode: boolean = false
): Promise<{
  processedCount: number;
  actualCount: number;
  editedCount: number;
}> {
  console.log(`[DME] 使用传统遍历消息流式处理模式`);
  
  const targetCount = userRequestedCount === 999999 ? Infinity : userRequestedCount;
  const trollImagePath = isAntiRecallMode ? await getTrollImage() : null;
  const sendAsIdentity =
    chatEntity.className === "Channel"
      ? await getSendAsIdentitySet(client, chatEntity)
      : { typedKeys: new Set<string>(), rawIds: new Set<string>() };
  
  let totalProcessed = 0;
  let totalEdited = 0;
  let totalDeleted = 0;
  let offsetId = 0;
  let consecutiveEmptyBatches = 0;
  const maxEmptyBatches =
    chatEntity.className === "Channel" ? CONFIG.CHANNEL_EMPTY_BATCH_LIMIT : 3;
  const HISTORY_BATCH = 100; // 每批获取历史消息数量

  // 传统模式：逐批获取历史消息，筛选自己的消息进行处理
  while (totalProcessed < targetCount && consecutiveEmptyBatches < maxEmptyBatches) {
    try {
      // 获取历史消息
      const history = await client.invoke(
        new Api.messages.GetHistory({
          peer: chatEntity,
          offsetId,
          offsetDate: 0,
          addOffset: 0,
          limit: HISTORY_BATCH,
          maxId: 0,
          minId: 0,
          hash: 0 as any,
        })
      );

      const allMessages: any[] = (history as any).messages || [];
      const validMessages = allMessages.filter((m: any) => m.className === "Message");
      
      if (validMessages.length === 0) {
        consecutiveEmptyBatches++;
        console.log(`[DME] 空批次 ${consecutiveEmptyBatches}/${maxEmptyBatches}`);
        await sleep(CONFIG.DELAYS.SEARCH);
        continue;
      }

      // 筛选出自己的消息
      const myMessages = validMessages.filter((m: any) =>
        isMyMessageByIdentity(
          m,
          myId,
          sendAsIdentity.typedKeys,
          sendAsIdentity.rawIds
        )
      );

      if (myMessages.length === 0) {
        // 更新offsetId继续搜索
        offsetId = validMessages[validMessages.length - 1].id;
        consecutiveEmptyBatches++;
        console.log(
          `[DME] 当前批次无可删消息，空批次 ${consecutiveEmptyBatches}/${maxEmptyBatches}`
        );
        await sleep(CONFIG.DELAYS.SEARCH);
        continue;
      }

      consecutiveEmptyBatches = 0; // 重置空批次计数
      
      // 限制处理数量
      const messagesToProcess = targetCount === Infinity 
        ? myMessages 
        : myMessages.slice(0, targetCount - totalProcessed);

      console.log(`[DME] 传统模式找到 ${messagesToProcess.length} 条自己的消息`);

      // 防撤回模式：先编辑媒体消息
      if (isAntiRecallMode && trollImagePath) {
        const mediaMessages = messagesToProcess.filter((m: Api.Message) => {
          if (!m.media || m.media instanceof Api.MessageMediaWebPage) return false;
          if (m.media instanceof Api.MessageMediaDocument) {
            const doc = m.media.document;
            if (doc instanceof Api.Document) {
              const isSticker = doc.attributes?.some(attr => 
                attr instanceof Api.DocumentAttributeSticker
              );
              if (isSticker) return false;
            }
          }
          return true;
        });

        if (mediaMessages.length > 0) {
          console.log(`[DME] 传统模式编辑 ${mediaMessages.length} 条媒体消息`);
          const editPromises = mediaMessages.map((msg: Api.Message) => 
            editMediaMessageToAntiRecall(client, msg, trollImagePath, chatEntity)
              .catch(() => false)
          );
          const editResults = await Promise.allSettled(editPromises);
          const edited = editResults.filter(r => r.status === "fulfilled" && r.value === true).length;
          totalEdited += edited;
          console.log(`[DME] 传统模式成功编辑 ${edited} 条媒体`);
          
          // 编辑后等待一段时间
          await sleep(CONFIG.DELAYS.EDIT_WAIT);
        }
      }

      // 删除这批消息
      const deleteIds = messagesToProcess.map((m: Api.Message) => m.id);
      if (deleteIds.length > 0) {
        try {
          // 分小批次删除，避免API限制
          const DELETE_BATCH_SIZE = 20;
          for (let i = 0; i < deleteIds.length; i += DELETE_BATCH_SIZE) {
            const batch = deleteIds.slice(i, i + DELETE_BATCH_SIZE);
            await deleteMessagesWithRetry(client, chatEntity, batch);
            totalDeleted += batch.length;
            await sleep(CONFIG.DELAYS.BATCH);
          }
          console.log(`[DME] 传统模式删除 ${deleteIds.length} 条，总计 ${totalDeleted} 条`);
        } catch (error: any) {
          console.error(`[DME] 传统模式删除失败:`, error.message);
        }
      }

      totalProcessed += messagesToProcess.length;
      
      // 如果已达到目标数量，停止处理
      if (totalProcessed >= targetCount) {
        break;
      }
      
      // 更新偏移ID继续搜索
      offsetId = validMessages[validMessages.length - 1].id;
      await sleep(CONFIG.DELAYS.SEARCH);
      
    } catch (error: any) {
      console.error(`[DME] 传统模式批次处理失败:`, error.message);
      consecutiveEmptyBatches++;
      await sleep(CONFIG.DELAYS.RETRY);
      
      if (consecutiveEmptyBatches >= maxEmptyBatches) {
        console.log(`[DME] 传统模式达到最大重试次数，停止处理`);
        break;
      }
    }
  }

  if (consecutiveEmptyBatches >= maxEmptyBatches) {
    console.log(
      `[DME] 达到空批次上限 ${maxEmptyBatches}，停止继续深扫`
    );
  }

  console.log(`[DME] 传统模式处理完成，删除 ${totalDeleted} 条，编辑 ${totalEdited} 条`);

  return {
    processedCount: totalDeleted,
    actualCount: totalProcessed,
    editedCount: totalEdited,
  };
}

/**
 * 快速删除模式 - 直接调用官方API删除消息
 */
async function quickDeleteMyMessages(
  client: TelegramClient,
  chatEntity: any,
  myId: bigint,
  userRequestedCount: number
): Promise<{
  processedCount: number;
  actualCount: number;
  editedCount: number;
}> {
  // 频道/超级群里“以频道身份发言”的消息通常不带个人 senderId，
  // 直接改用 out 消息遍历模式，避免快速搜索漏删。
  if (chatEntity.className === "Channel") {
    console.log(`[DME] 频道会话启用出站消息遍历模式（支持频道身份发言）`);
    return await traditionalStreamProcessing(client, chatEntity, myId, userRequestedCount, false);
  }

  // 检测是否为受限群组（禁止转发和复制）
  const isRestricted = await isRestrictedGroup(client, chatEntity);
  if (isRestricted) {
    console.log(`[DME] 检测到受限群组，切换到传统遍历模式`);
    return await traditionalStreamProcessing(client, chatEntity, myId, userRequestedCount, false);
  }
  
  console.log(`[DME] 使用快速删除模式`);
  
  const targetCount =
    userRequestedCount === CONFIG.UNLIMITED_REQUEST_COUNT
      ? Infinity
      : userRequestedCount;
  let offsetId = 0;
  let searchFailCount = 0;
  const maxSearchFails = 2;
  let totalMatched = 0;
  let totalDeleted = 0;
  let hasSearchResult = false;

  // 流式搜索并删除：避免 allMyMessages 大数组导致堆内存膨胀
  while (targetCount === Infinity || totalMatched < targetCount) {
    const searchLimit =
      targetCount === Infinity
        ? CONFIG.SEARCH_LIMIT
        : Math.min(CONFIG.SEARCH_LIMIT, targetCount - totalMatched);

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
          limit: searchLimit,
          maxId: 0,
          minId: 0,
          hash: 0 as any
        })
      );

      const resultMessages = (searchResult as any).messages;
      if (!resultMessages || resultMessages.length === 0) {
        break;
      }

      const allBatchMessages = resultMessages.filter(
        (m: any) => m.className === "Message"
      );
      if (allBatchMessages.length === 0) {
        break;
      }

      offsetId = allBatchMessages[allBatchMessages.length - 1].id;

      const messagesToDelete = allBatchMessages.filter(
        (m: any) =>
          m.className === "Message" &&
          (m.senderId?.toString() === myId.toString() || m.out === true)
      );

      if (messagesToDelete.length === 0) {
        await sleep(CONFIG.DELAYS.SEARCH);
        continue;
      }

      hasSearchResult = true;
      const deleteIds = messagesToDelete.map((m: Api.Message) => m.id);

      const result = await adaptiveBatchDelete(client, chatEntity, deleteIds);
      totalDeleted += result.deletedCount;
      totalMatched += messagesToDelete.length;

      await sleep(CONFIG.DELAYS.SEARCH);
    } catch (error: any) {
      console.error(`[DME] 搜索失败:`, error.message);
      searchFailCount++;
      
      // 如果连续搜索失败，切换到传统模式
      if (searchFailCount >= maxSearchFails) {
        if (totalMatched > 0) {
          break;
        }
        console.log(`[DME] API搜索多次失败，切换到传统遍历模式`);
        return await traditionalStreamProcessing(client, chatEntity, myId, userRequestedCount, false);
      }
      await sleep(CONFIG.DELAYS.RETRY);
    }
  }

  if (!hasSearchResult) {
    console.log(`[DME] API搜索无结果，尝试传统遍历模式`);
    return await traditionalStreamProcessing(client, chatEntity, myId, userRequestedCount, false);
  }
  
  return {
    processedCount: totalDeleted,
    actualCount: totalMatched,
    editedCount: 0
  };
}

/**
 * 搜索并处理用户消息的主函数 - 防撤回模式（-f参数）流式处理版本
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
      } else {
        console.log(`[DME] 无频道管理权限，使用普通模式`);
      }
    } catch (error) {
      console.log(`[DME] 权限检查失败，使用普通模式:`, error);
    }
  }

  // 频道/超级群里“以频道身份发言”的消息通常不带个人 senderId，
  // 直接改用 out 消息遍历模式，避免流式搜索漏删。
  if (isChannel) {
    console.log(`[DME] 频道会话启用出站消息遍历模式（支持频道身份发言）`);
    return await traditionalStreamProcessing(client, chatEntity, myId, userRequestedCount, true);
  }
  
  // 检测是否为受限群组（禁止转发和复制）
  const isRestricted = await isRestrictedGroup(client, chatEntity);
  if (isRestricted) {
    console.log(`[DME] 检测到受限群组，切换到传统遍历模式`);
    return await traditionalStreamProcessing(client, chatEntity, myId, userRequestedCount, true);
  }
  
  console.log(`[DME] 流式处理模式，目标数量: ${userRequestedCount === 999999 ? "全部" : userRequestedCount}`);

  const targetCount = userRequestedCount === 999999 ? Infinity : userRequestedCount;
  const trollImagePath = await getTrollImage();
  
  let totalProcessed = 0;
  let totalEdited = 0;
  let totalDeleted = 0;
  let offsetId = 0;
  let searchFailCount = 0;
  const maxSearchFails = 2;
  const STREAM_BATCH = 50; // 每批处理50条

  // 流式处理：搜索一批，处理一批，删除一批
  while (totalProcessed < targetCount) {
    try {
      // 搜索一批消息
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
          limit: Math.min(STREAM_BATCH, targetCount === Infinity ? STREAM_BATCH : targetCount - totalProcessed),
          maxId: 0,
          minId: 0,
          hash: 0 as any
        })
      );

      const resultMessages = (searchResult as any).messages;
      if (!resultMessages || resultMessages.length === 0) {
        console.log(`[DME] 流式处理完成，无更多消息`);
        break;
      }

      const batchMessages = resultMessages.filter(
        (m: any) =>
          m.className === "Message" &&
          (m.senderId?.toString() === myId.toString() || m.out === true)
      );

      if (batchMessages.length === 0) break;

      // 立即处理这批消息的媒体编辑
      const mediaMessages = batchMessages.filter((m: Api.Message) => {
        if (!m.media || m.media instanceof Api.MessageMediaWebPage) return false;
        if (m.media instanceof Api.MessageMediaDocument) {
          const doc = m.media.document;
          if (doc instanceof Api.Document) {
            const isSticker = doc.attributes?.some(attr => 
              attr instanceof Api.DocumentAttributeSticker
            );
            if (isSticker) return false;
          }
        }
        return true;
      });

      // 并发编辑媒体（不等待全部完成）
      if (mediaMessages.length > 0 && trollImagePath) {
        const editPromises = mediaMessages.map((msg: Api.Message) => 
          editMediaMessageToAntiRecall(client, msg, trollImagePath, chatEntity)
            .catch(() => false)
        );
        const editResults = await Promise.allSettled(editPromises);
        const edited = editResults.filter(r => r.status === "fulfilled" && r.value === true).length;
        totalEdited += edited;
        console.log(`[DME] 批次编辑 ${edited}/${mediaMessages.length} 条媒体`);
      }

      // 立即删除这批消息
      const deleteIds = batchMessages.map((m: Api.Message) => m.id);
      try {
        await deleteMessagesWithRetry(client, chatEntity, deleteIds);
        totalDeleted += deleteIds.length;
        console.log(`[DME] 流式删除 ${deleteIds.length} 条，总计 ${totalDeleted} 条`);
      } catch (error: any) {
        console.error(`[DME] 批次删除失败:`, error.message);
      }

      totalProcessed += batchMessages.length;
      offsetId = batchMessages[batchMessages.length - 1].id;
      
      await sleep(CONFIG.DELAYS.BATCH);
    } catch (error: any) {
      console.error(`[DME] 流式处理批次失败:`, error.message);
      searchFailCount++;
      
      // 如果连续搜索失败，切换到传统模式
      if (searchFailCount >= maxSearchFails) {
        console.log(`[DME] API搜索多次失败，切换到传统遍历模式`);
        const traditionalResult = await traditionalStreamProcessing(client, chatEntity, myId, userRequestedCount, true);
        return {
          processedCount: totalDeleted + traditionalResult.processedCount,
          actualCount: totalProcessed + traditionalResult.actualCount,
          editedCount: totalEdited + traditionalResult.editedCount,
        };
      }
      
      await sleep(CONFIG.DELAYS.RETRY);
      break;
    }
  }

  // 如果API搜索没有找到任何消息，尝试传统模式
  if (totalProcessed === 0) {
    console.log(`[DME] API搜索无结果，尝试传统遍历模式`);
    return await traditionalStreamProcessing(client, chatEntity, myId, userRequestedCount, true);
  }

  console.log(`[DME] 流式处理完成，删除 ${totalDeleted} 条，编辑 ${totalEdited} 条`);

  return {
    processedCount: totalDeleted,
    actualCount: totalProcessed,
    editedCount: totalEdited,
  };
}

// 已移除频道直接删除功能，避免误删别人消息
// 所有情况下都使用普通模式，只删除自己的消息

// 定义帮助文本常量
const help_text = `🗑️ <b>智能防撤回删除插件</b>

<b>命令格式：</b>
<code>${mainPrefix}dme [数量]</code>
<code>${mainPrefix}dme -f [数量]</code>

<b>可用命令：</b>
• <code>${mainPrefix}dme [数量]</code> - 快速删除指定数量的消息
• <code>${mainPrefix}dme -f [数量]</code> - 防撤回模式（替换媒体后删除）

<b>智能适配：</b>
• 自动检测禁止转发和复制的群组
• 受限群组自动切换传统遍历模式
• API搜索失败时自动回退处理

<b>示例：</b>
• <code>${mainPrefix}dme 10</code> - 快速删除最近10条消息
• <code>${mainPrefix}dme -f 100</code> - 防撤回删除最近100条消息
• <code>${mainPrefix}dme 999</code> - 快速删除所有自己的消息`;

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

    // 检查是否为防撤回模式 (-f 参数)
    const isAntiRecallMode = sub === "-f";
    let userRequestedCount: number;
    
    if (isAntiRecallMode) {
      // -f 模式，数量在第二个参数
      const countArg = args[1];
      if (!countArg) {
        await msg.edit({
          text: `❌ <b>参数错误:</b> 请指定删除数量\n\n💡 使用 <code>${mainPrefix}dme -f [数量]</code>`,
          parseMode: "html"
        });
        return;
      }
      userRequestedCount = parseInt(countArg);
    } else {
      // 普通模式，数量在第一个参数
      userRequestedCount = parseInt(sub);
    }
    
    if (isNaN(userRequestedCount) || userRequestedCount <= 0) {
      await msg.edit({
        parseMode: "html"
      });
      return;
    }

    const requestedTotalCount = userRequestedCount;
    const shouldRunInRounds =
      requestedTotalCount !== CONFIG.UNLIMITED_REQUEST_COUNT &&
      requestedTotalCount > CONFIG.MAX_SAFE_REQUEST_COUNT;

    if (shouldRunInRounds) {
      console.log(
        `[DME] 请求数量 ${requestedTotalCount} 超过单次安全上限 ${CONFIG.MAX_SAFE_REQUEST_COUNT}，将分轮执行直到达到目标或无可删消息`
      );
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
    console.log(`[DME] 请求数量: ${requestedTotalCount}`);
    console.log(`[DME] 模式: ${isAntiRecallMode ? '防撤回模式 (-f)' : '快速删除模式'}`);
    const startTime = Date.now();

    const runOneRound = async (count: number) =>
      isAntiRecallMode
        ? await searchEditAndDeleteMyMessages(
            client,
            chatEntity as any,
            myId,
            count
          )
        : await quickDeleteMyMessages(
            client,
            chatEntity as any,
            myId,
            count
          );

    const result = {
      processedCount: 0,
      actualCount: 0,
      editedCount: 0,
    };

    if (!shouldRunInRounds) {
      const singleResult = await runOneRound(requestedTotalCount);
      result.processedCount = singleResult.processedCount;
      result.actualCount = singleResult.actualCount;
      result.editedCount = singleResult.editedCount;
    } else {
      let remaining = requestedTotalCount;
      let round = 0;

      while (remaining > 0) {
        round++;
        const roundTarget = Math.min(CONFIG.MAX_SAFE_REQUEST_COUNT, remaining);
        console.log(
          `[DME] 第 ${round} 轮开始，请求 ${roundTarget} 条，剩余目标 ${remaining} 条`
        );

        const roundResult = await runOneRound(roundTarget);
        result.processedCount += roundResult.processedCount;
        result.actualCount += roundResult.actualCount;
        result.editedCount += roundResult.editedCount;
        remaining = Math.max(0, remaining - roundResult.processedCount);

        console.log(
          `[DME] 第 ${round} 轮完成，删除 ${roundResult.processedCount} 条，累计 ${result.processedCount}/${requestedTotalCount}`
        );

        if (roundResult.actualCount === 0) {
          console.log(`[DME] 第 ${round} 轮未找到可删除消息，提前结束`);
          break;
        }

        if (roundResult.processedCount === 0) {
          console.log(`[DME] 第 ${round} 轮没有删除进度，提前结束避免空转`);
          break;
        }

        await sleep(CONFIG.DELAYS.BATCH);
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`[DME] ========== 任务完成 ==========`);
    console.log(`[DME] 总耗时: ${duration} 秒`);
    console.log(`[DME] 处理消息: ${result.processedCount} 条`);
    console.log(`[DME] 编辑媒体: ${result.editedCount} 条`);
    if (
      shouldRunInRounds &&
      requestedTotalCount !== CONFIG.UNLIMITED_REQUEST_COUNT &&
      result.processedCount < requestedTotalCount
    ) {
      console.log(
        `[DME] 未达到目标数量，目标: ${requestedTotalCount}，实际: ${result.processedCount}（可能已无可删消息）`
      );
    }
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
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  description: string = `智能防撤回删除插件\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    dme,
  };
}

export default new DmePlugin();

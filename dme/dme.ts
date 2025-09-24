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
  BATCH_SIZE: 100, // 增加批量大小
  SEARCH_LIMIT: 100,
  MAX_SEARCH_MULTIPLIER: 10,
  MIN_MAX_SEARCH: 2000,
  DEFAULT_BATCH_LIMIT: 30,
  DELAYS: {
    BATCH: 50, // 减少延迟
    EDIT_WAIT: 500, // 减少编辑等待
    SEARCH: 50, // 减少搜索延迟
    RESULT_DISPLAY: 3000,
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
 * 通用删除消息函数 - 增强跨平台同步
 */
async function deleteMessagesUniversal(
  client: TelegramClient,
  chatEntity: any,
  messageIds: number[]
): Promise<number> {
  // 删除消息
  await client.deleteMessages(chatEntity, messageIds, { revoke: true });

  // 强制刷新更新状态，确保跨平台同步
  try {
    await client.invoke(new Api.updates.GetState());
  } catch {} // 静默处理

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
 * 使用messages.search直接搜索自己的消息 - 高效版本
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


  try {
    while (allMyMessages.length < targetCount) {
      // 使用messages.search直接搜索自己的消息
      const searchResult = await client.invoke(
        new Api.messages.Search({
          peer: chatEntity,
          q: "", // 空查询搜索所有消息
          fromId: await client.getInputEntity(myId.toString()), // 修复：转换为字符串
          filter: new Api.InputMessagesFilterEmpty(), // 不过滤消息类型
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

      // 修复：正确处理搜索结果类型
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
      } else {
        break;
      }

      await sleep(100); // 减少延迟
    }
  } catch (error: any) {
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
 * 极速删除：智能删除策略，完全静默
 */
async function fastDeleteMessages(
  client: TelegramClient,
  chatEntity: any,
  myId: bigint,
  count: number
): Promise<void> {
  // 检查是否为频道主
  const isChannelOwner = await checkChannelOwner(client, chatEntity, myId);
  
  const messageIds: number[] = [];
  let offsetId = 0;

  // 快速获取最近消息
  while (messageIds.length < count) {
    const history = await client.invoke(
      new Api.messages.GetHistory({
        peer: chatEntity,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit: Math.min(100, count - messageIds.length),
        maxId: 0,
        minId: 0,
        hash: 0 as any,
      })
    );
    
    const msgs: any[] = (history as any).messages || [];
    const justMsgs = msgs.filter((m: any) => m.className === "Message");
    if (justMsgs.length === 0) break;
    
    for (const m of justMsgs) {
      // 频道主：删除所有消息；非频道主：只删除自己的消息
      if (isChannelOwner || m.out === true || m.senderId?.toString() === myId.toString()) {
        messageIds.push(m.id);
        
        // 媒体防撤回（异步处理）
        if (m.media && !(m.media instanceof Api.MessageMediaWebPage)) {
          getTrollImage().then(trollPath => {
            if (trollPath) {
              editMediaMessageToAntiRecall(client, m, trollPath, chatEntity).catch(() => {});
            }
          });
        }
      }
    }
    
    offsetId = justMsgs[justMsgs.length - 1].id;
    await sleep(50);
  }

  if (messageIds.length === 0) return;

  // 并发删除
  const deleteGroups: number[][] = [];
  for (let i = 0; i < messageIds.length; i += CONFIG.BATCH_SIZE) {
    deleteGroups.push(messageIds.slice(i, i + CONFIG.BATCH_SIZE));
  }

  const deleteTasks = deleteGroups.map(async (batch, index) => {
    try {
      await sleep(index * 30);
      await deleteMessagesUniversal(client, chatEntity, batch);
    } catch {}
  });

  await Promise.allSettled(deleteTasks);
}

/**
 * 完整模式删除：等待媒体处理完成
 */
async function fullDeleteMessages(
  client: TelegramClient,
  chatEntity: any,
  myId: bigint,
  count: number
): Promise<void> {
  const isChannelOwner = await checkChannelOwner(client, chatEntity, myId);
  const messageIds: number[] = [];
  const mediaMessages: any[] = [];
  let offsetId = 0;

  // 获取消息并收集媒体消息
  while (messageIds.length < count) {
    const history = await client.invoke(
      new Api.messages.GetHistory({
        peer: chatEntity,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit: Math.min(100, count - messageIds.length),
        maxId: 0,
        minId: 0,
        hash: 0 as any,
      })
    );
    
    const msgs: any[] = (history as any).messages || [];
    const justMsgs = msgs.filter((m: any) => m.className === "Message");
    if (justMsgs.length === 0) break;
    
    for (const m of justMsgs) {
      if (isChannelOwner || m.out === true || m.senderId?.toString() === myId.toString()) {
        messageIds.push(m.id);
        
        // 收集媒体消息
        if (m.media && !(m.media instanceof Api.MessageMediaWebPage)) {
          mediaMessages.push(m);
        }
      }
    }
    
    offsetId = justMsgs[justMsgs.length - 1].id;
    await sleep(50);
  }

  if (messageIds.length === 0) return;

  // 先处理所有媒体消息，等待完成
  if (mediaMessages.length > 0) {
    const trollPath = await getTrollImage();
    if (trollPath) {
      const editTasks = mediaMessages.map(m => 
        editMediaMessageToAntiRecall(client, m, trollPath, chatEntity)
      );
      await Promise.allSettled(editTasks);
      await sleep(CONFIG.DELAYS.EDIT_WAIT); // 等待编辑完成
    }
  }

  // 再删除所有消息
  const deleteGroups: number[][] = [];
  for (let i = 0; i < messageIds.length; i += CONFIG.BATCH_SIZE) {
    deleteGroups.push(messageIds.slice(i, i + CONFIG.BATCH_SIZE));
  }

  const deleteTasks = deleteGroups.map(async (batch, index) => {
    try {
      await sleep(index * 30);
      await deleteMessagesUniversal(client, chatEntity, batch);
    } catch {}
  });

  await Promise.allSettled(deleteTasks);
}

/**
 * 检查是否为频道主
 */
async function checkChannelOwner(
  client: TelegramClient,
  chatEntity: any,
  myId: bigint
): Promise<boolean> {
  try {
    // 收藏夹/私聊：按自己消息处理
    if (chatEntity.className === "User" || isSavedMessagesPeer(chatEntity, myId)) {
      return false;
    }
    
    // 频道：检查是否为创建者
    if (chatEntity.className === "Channel") {
      const participant = await client.invoke(
        new Api.channels.GetParticipant({
          channel: chatEntity,
          participant: myId.toString(),
        })
      );
      return participant.participant.className === "ChannelParticipantCreator";
    }
    
    return false;
  } catch {
    return false;
  }
}

/**
 * 原搜索函数（已废弃，保留兼容）
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
        return await deleteInSavedMessages(client, chatEntity, userRequestedCount);
      }

      const isAdmin =
        participant.participant.className === "ChannelParticipantAdmin" ||
        participant.participant.className === "ChannelParticipantCreator";

      if (isAdmin) {
      } else {
      }
    } catch (error) {
    }
  }

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
    allMyMessages = await searchMyOutgoingMessages(client, chatEntity, userRequestedCount);
  }

  if (allMyMessages.length === 0) {
    return { processedCount: 0, actualCount: 0, editedCount: 0 };
  }

  // 处理找到的消息  
  const messagesToProcess = targetCount === Infinity ? allMyMessages : allMyMessages.slice(0, targetCount);
  if (messagesToProcess.length === 0) {
    return { processedCount: 0, actualCount: 0, editedCount: 0 };
  }


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
    const trollImagePath = await getTrollImage();

    const editTasks = mediaMessages.map((message) =>
      editMediaMessageToAntiRecall(client, message, trollImagePath, chatEntity)
    );

    const results = await Promise.allSettled(editTasks);
    editedCount = results.filter(
      (r) => r.status === "fulfilled" && r.value === true
    ).length;

    await sleep(CONFIG.DELAYS.EDIT_WAIT);
  }

  // 高性能并发删除
  const deleteIds = messagesToProcess.map((m: Api.Message) => m.id);
  
  // 分组并发删除
  const deleteGroups: number[][] = [];
  for (let i = 0; i < deleteIds.length; i += CONFIG.BATCH_SIZE) {
    deleteGroups.push(deleteIds.slice(i, i + CONFIG.BATCH_SIZE));
  }

  // 并发执行所有删除任务
  const deleteTasks = deleteGroups.map(async (batch, index) => {
    try {
      await sleep(index * CONFIG.DELAYS.BATCH); // 错开请求时间
      return await deleteMessagesUniversal(client, chatEntity, batch);
    } catch (error: any) {
      if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "30");
        await sleep(waitTime * 1000);
        return await deleteMessagesUniversal(client, chatEntity, batch);
      }
      return 0;
    }
  });

  const results = await Promise.allSettled(deleteTasks);
  const deletedCount = results
    .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
    .reduce((sum, r) => sum + r.value, 0);

  return {
    processedCount: deletedCount,
    actualCount: messagesToProcess.length,
    editedCount,
  };
}

// 已移除频道直接删除功能，避免误删别人消息
// 所有情况下都使用普通模式，只删除自己的消息

// 定义帮助文本常量
const help_text = `<b>删除消息</b>

<code>.dme [数量]</code> 快速删除
<code>.dme f [数量]</code> 等待媒体处理
频道主删任意，普通用户删自己`;

const dme = async (msg: Api.Message) => {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ text: "❌ 客户端错误", parseMode: "html" });
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

    // 检查是否为完整模式
    const isFullMode = sub === "f";
    const countArg = isFullMode ? args[1] : sub;
    
    // 解析数量参数
    const userRequestedCount = parseInt(countArg);
    if (isNaN(userRequestedCount) || userRequestedCount <= 0) {
      await msg.edit({ text: "❌ 数量错误", parseMode: "html" });
      return;
    }

    const me = await client.getMe();
    const myId = BigInt(me.id.toString());
    const chatId = msg.chatId?.toString() || msg.peerId?.toString() || "";
    const chatEntity = await getEntityWithHash(client, chatId);

    // 删除命令消息
    try {
      await client.deleteMessages(chatEntity as any, [msg.id], { revoke: true });
    } catch {}

    // 根据模式选择删除方式
    if (isFullMode) {
      // 完整模式：等待媒体处理完成
      fullDeleteMessages(client, chatEntity as any, myId, userRequestedCount).catch(() => {});
    } else {
      // 快速模式：直接删除，媒体异步处理
      fastDeleteMessages(client, chatEntity as any, myId, userRequestedCount).catch(() => {});
    }
  } catch (error: any) {
    await msg.edit({ text: "❌ 操作失败", parseMode: "html" });
  }
};

class DmePlugin extends Plugin {
  description: string = help_text;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    dme,
  };
}

export default new DmePlugin();

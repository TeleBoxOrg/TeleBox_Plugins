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
  SEARCH_LIMIT: 100,
  MAX_SEARCH_MULTIPLIER: 10,
  MIN_MAX_SEARCH: 2000,
  DEFAULT_BATCH_LIMIT: 30, // 默认最大搜索批次数
  DELAYS: {
    BATCH: 200,
    EDIT_WAIT: 1000,
    SEARCH: 100,
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
    console.log(`[DME] 已触发跨平台同步刷新`);
  } catch (error) {
    console.log(`[DME] 同步刷新失败，但不影响删除操作:`, error);
  }

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
        console.log(`[DME] 跳过贴纸消息编辑: ${message.id}`);
        return false;
      }
    }
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
  } catch (error) {
    console.error("[DME] 编辑媒体消息失败:", error);
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

  console.log(`[DME] 使用优化搜索模式，直接定位自己的消息`);

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
        console.log(`[DME] 批次搜索到 ${messages.length} 条消息，总计 ${allMyMessages.length} 条`);
      } else {
        break;
      }

      // 避免API限制
      await sleep(200);
    }
  } catch (error: any) {
    console.error("[DME] 优化搜索失败，回退到传统模式:", error);
    return [];
  }

  return allMyMessages.slice(0, targetCount === Infinity ? allMyMessages.length : targetCount);
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
  const allMyMessages = await searchMyMessagesOptimized(
    client, 
    chatEntity, 
    myId, 
    userRequestedCount
  );

  if (allMyMessages.length === 0) {
    console.log(`[DME] 未找到任何自己的消息`);
    return { processedCount: 0, actualCount: 0, editedCount: 0 };
  }

  // 处理找到的消息  
  const targetCount = userRequestedCount === 999999 ? Infinity : userRequestedCount;
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
          console.log(`[DME] 跳过贴纸消息分类: ${m.id}`);
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

  // 删除消息
  console.log(`[DME] 开始删除 ${messagesToProcess.length} 条消息...`);
  const deleteIds = messagesToProcess.map((m: Api.Message) => m.id);
  let deletedCount = 0;
  let deleteBatch = 0;

  for (let i = 0; i < deleteIds.length; i += CONFIG.BATCH_SIZE) {
    deleteBatch++;
    const batch = deleteIds.slice(i, i + CONFIG.BATCH_SIZE);

    try {
      const batchDeleted = await deleteMessagesUniversal(
        client,
        chatEntity,
        batch
      );
      deletedCount += batchDeleted;
      console.log(
        `[DME] 删除批次 ${deleteBatch}: 成功删除 ${batchDeleted} 条，进度 ${deletedCount}/${deleteIds.length}`
      );

      await sleep(CONFIG.DELAYS.BATCH);
    } catch (error: any) {
      if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        console.log(`[DME] 删除时触发API限制，休眠 ${waitTime} 秒...`);

        for (let j = waitTime; j > 0; j -= 10) {
          if (j % 10 === 0 || j < 10) {
            console.log(`[DME] 删除等待中... 剩余 ${j} 秒`);
          }
          await sleep(Math.min(j, 10) * 1000);
        }

        i -= CONFIG.BATCH_SIZE; // 重试当前批次
        console.log(`[DME] 休眠结束，重试批次 ${deleteBatch}`);
      } else {
        console.error("[DME] 删除批次失败:", error);
        // 其他错误等待后继续
        await sleep(5000);
      }
    }
  }

  console.log(`[DME] 删除完成，共删除 ${deletedCount} 条消息`);

  return {
    processedCount: deletedCount,
    actualCount: messagesToProcess.length,
    editedCount,
  };
}

// 已移除频道直接删除功能，避免误删别人消息
// 所有情况下都使用普通模式，只删除自己的消息

const dme = async (msg: Api.Message) => {
  const text = msg.message || "";
  const chatId = msg.chatId?.toString() || msg.peerId?.toString() || "";
  const args = text.trim().split(/\s+/);

  // 解析参数：数量和帮助命令
  let countArg: string | undefined;
  let showHelp = false;

  // 检查参数中是否有帮助命令
  const filteredArgs = args.slice(1).filter((arg) => {
    if (arg === "help" || arg === "h") {
      showHelp = true;
      return false;
    }
    return true;
  });

  countArg = filteredArgs[0];

  const client = await getGlobalClient();
  if (!client) {
    console.error("[DME] 客户端未初始化");
    return;
  }

  // 显示帮助文档（仅在明确请求时）
  if (showHelp) {
    console.log("[DME] 用户请求帮助文档");
    console.log(new DmePlugin().description);
    return;
  }

  // 参数验证
  if (!countArg) {
    console.error("[DME] 参数错误: 请提供要删除的消息数量");
    console.log("[DME] 提示: 使用 .dme help 查看帮助");
    return;
  }

  const userRequestedCount = parseInt(countArg);
  if (isNaN(userRequestedCount) || userRequestedCount <= 0) {
    console.error("[DME] 参数错误: 数量必须是正整数");
    return;
  }

  try {
    const me = await client.getMe();
    const myId = BigInt(me.id.toString());

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
    // 静默模式：不显示错误消息
  }
};

class DmePlugin extends Plugin {
  description: string = `智能防撤回删除插件 - 高效版本

参数说明:
• [数量] - 要删除的消息数量

核心特性:
• 🚀 高效搜索：基于messages.search API直接定位自己的消息，无需遍历
• 🧠 智能策略：媒体消息防撤回，文字消息快速删除，贴纸直接删除
• 🖼️ 媒体消息：替换为防撤回图片（真正防撤回）
• 📝 文字消息：直接删除（提升速度）
• 🎯 贴纸处理：跳过编辑直接删除，避免MESSAGE_ID_INVALID错误
• ⚡ 性能优化：批量处理，减少API调用
• 🌍 支持所有聊天类型

示例:
• .dme 10 - 删除最近10条消息
• .dme 100 - 删除最近100条消息
• .dme 999999 - 删除所有自己的消息

工作流程:
1️⃣ 使用messages.search搜索自己的消息 → 2️⃣ 智能分类处理 → 3️⃣ 媒体防撤回 → 4️⃣ 批量删除

技术改进:
• 基于Telegram MTProto API的messages.search方法
• 使用from_id参数直接过滤用户消息，避免低效遍历
• 参考CherryGram等第三方客户端的优化实现
• 移除传统批次遍历，显著提升性能`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    dme,
  };
}

export default new DmePlugin();

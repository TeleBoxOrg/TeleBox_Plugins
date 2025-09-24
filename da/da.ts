import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import * as path from "path";
import * as fs from "fs";
import bigInt from "big-integer";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义工具（每个插件必须实现）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文档常量
const help_text = `<b>批量删除</b>

<code>.da true</code> 开始删除
<code>.da stop</code> 停止任务`;

// 删除任务状态管理
interface DeleteTask {
  chatId: string;
  chatName: string;
  startTime: number;
  deletedMessages: number;
  isRunning: boolean;
  isPaused: boolean;
  sleepUntil: number | null;
  lastUpdate: number;
  lastLogTime: number;
  errors: string[];
  savedMessageId?: number; // 收藏夹消息ID
}

interface DatabaseSchema {
  tasks: DeleteTask[];
}

// 数据文件路径
const DATA_DIR = path.join(process.cwd(), "assets", "da");
const DB_FILE = path.join(DATA_DIR, "database.json");

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 初始化 lowdb
let db: Low<DatabaseSchema>;

const initDatabase = async () => {
  const adapter = new JSONFile<DatabaseSchema>(DB_FILE);
  db = new Low(adapter, { tasks: [] });
  await db.read();
};

// 获取任务
const getTask = async (chatId: string): Promise<DeleteTask | undefined> => {
  if (!db) await initDatabase();
  await db.read();
  return db.data.tasks.find(t => t.chatId === chatId);
};

// 保存任务
const saveTask = async (task: DeleteTask) => {
  if (!db) await initDatabase();
  await db.read();
  
  const index = db.data.tasks.findIndex(t => t.chatId === task.chatId);
  if (index >= 0) {
    db.data.tasks[index] = task;
  } else {
    db.data.tasks.push(task);
  }
  
  await db.write();
};

// 删除任务
const removeTask = async (chatId: string) => {
  if (!db) await initDatabase();
  await db.read();
  
  db.data.tasks = db.data.tasks.filter(t => t.chatId !== chatId);
  await db.write();
};

// 初始化数据库
initDatabase().catch(console.error);

// 工具函数
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 使用messages.search直接搜索自己的消息 - 高效版本
 * 从dme.ts移植的优化搜索函数
 */
async function searchMyMessagesOptimized(
  client: TelegramClient,
  chatEntity: any,
  myId: bigInt.BigInteger,
  batchSize: number = 100
): Promise<Api.Message[]> {
  const allMyMessages: Api.Message[] = [];
  let offsetId = 0;

  console.log(`[DA] 使用优化搜索模式，直接定位自己的消息`);

  try {
    while (true) {
      // 使用messages.search直接搜索自己的消息
      const searchResult = await client.invoke(
        new Api.messages.Search({
          peer: chatEntity,
          q: "", // 空查询搜索所有消息
          fromId: await client.getInputEntity(myId.toString()), // 关键：指定from_id为自己
          filter: new Api.InputMessagesFilterEmpty(), // 不过滤消息类型
          minDate: 0,
          maxDate: 0,
          offsetId: offsetId,
          addOffset: 0,
          limit: batchSize,
          maxId: 0,
          minId: 0,
          hash: 0 as any
        })
      );

      // 正确处理搜索结果类型
      const resultMessages = (searchResult as any).messages;
      if (!resultMessages || resultMessages.length === 0) {
        console.log(`[DA] 搜索完成，共找到 ${allMyMessages.length} 条自己的消息`);
        break;
      }

      const messages = resultMessages.filter((m: any) => 
        m.className === "Message" && m.senderId?.toString() === myId.toString()
      );

      if (messages.length > 0) {
        allMyMessages.push(...messages);
        offsetId = messages[messages.length - 1].id;
        console.log(`[DA] 批次搜索到 ${messages.length} 条消息，总计 ${allMyMessages.length} 条`);
      } else {
        break;
      }

      // 避免API限制
      await sleep(200);
    }
  } catch (error: any) {
    console.error("[DA] 优化搜索失败:", error);
    return [];
  }

  return allMyMessages;
}

// 发送或更新进度到收藏夹
const sendProgressToSaved = async (
  client: TelegramClient,
  task: DeleteTask,
  status: string
): Promise<number | undefined> => {
  try {
    const elapsed = Date.now() - task.startTime;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    
    const speed = task.deletedMessages > 0 
      ? (task.deletedMessages / (elapsed / 1000)).toFixed(2)
      : "0";
    
    let statusText = "⏹️ 已停止";
    if (task.isRunning) {
      statusText = "🟢 运行中";
    } else if (task.sleepUntil && task.sleepUntil > Date.now()) {
      const sleepRemaining = Math.ceil((task.sleepUntil - Date.now()) / 1000);
      statusText = `😴 休眠中 (${sleepRemaining}秒)`;
    } else if (task.isPaused) {
      statusText = "⏸️ 已暂停";
    }

    const message = `📊 <b>删除任务${status}</b>

<b>群聊:</b> ${task.chatName}
<b>状态:</b> ${statusText}

<b>📈 统计信息:</b>
• 已删除: <code>${task.deletedMessages.toLocaleString()}</code> 条
• 删除速度: ${speed} 条/秒
• 运行时长: ${hours}小时 ${minutes}分钟 ${seconds}秒

<b>最后更新:</b> ${new Date(task.lastUpdate).toLocaleString("zh-CN")}

${task.errors.length > 0 ? `<b>⚠️ 最近错误:</b>\n${task.errors.slice(-3).join("\n")}` : ""}`;

    // 如果已有收藏夹消息，则编辑；否则创建新消息
    if (task.savedMessageId) {
      try {
        await client.editMessage("me", {
          message: task.savedMessageId,
          text: message,
          parseMode: "html",
        });
        return task.savedMessageId;
      } catch (editError) {
        // 如果编辑失败，创建新消息
        console.log("编辑收藏夹消息失败，创建新消息:", editError);
      }
    }
    
    // 创建新消息
    const savedMsg = await client.sendMessage("me", {
      message,
      parseMode: "html",
    });
    return savedMsg.id;
  } catch (error) {
    console.error("发送进度到收藏夹失败:", error);
    return undefined;
  }
};

// 计算已用时间
const calculateElapsedTime = (task: DeleteTask): string => {
  const elapsed = Date.now() - task.startTime;
  const hours = Math.floor(elapsed / 3600000);
  const minutes = Math.floor((elapsed % 3600000) / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  
  if (hours > 0) {
    return `${hours}小时 ${minutes}分钟 ${seconds}秒`;
  } else if (minutes > 0) {
    return `${minutes}分钟 ${seconds}秒`;
  } else {
    return `${seconds}秒`;
  }
};

// 高速删除批处理（极简版）
const fastDeleteBatch = async (
  client: TelegramClient,
  chatId: bigInt.BigInteger,
  messages: Api.Message[],
  task: DeleteTask
): Promise<boolean> => {
  try {
    // 直接批量删除，不等待
    await client.deleteMessages(
      chatId,
      messages.map((m) => m.id),
      { revoke: true }
    );
    
    task.deletedMessages += messages.length;
    await saveTask(task);
    return true;
    
  } catch (error: any) {
    // FLOOD_WAIT处理
    if (error.message?.includes("FLOOD_WAIT")) {
      const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "30") * 1000;
      await sleep(waitTime);
      return fastDeleteBatch(client, chatId, messages, task); // 重试
    }
    
    // 批量失败，逐个删除
    for (const message of messages) {
      try {
        await client.deleteMessages(chatId, [message.id], { revoke: true });
        task.deletedMessages++;
        await sleep(50);
      } catch {}
    }
    
    await saveTask(task);
    return false;
  }
};

// 主删除命令
const da = async (msg: Api.Message) => {
  // 标准参数解析模式（参考 music.ts）
  const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
  const parts = lines?.[0]?.split(/\s+/) || [];
  const [, ...args] = parts; // 跳过命令本身
  const sub = (args[0] || "").toLowerCase();

  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ text: "❌ 客户端错误", parseMode: "html" });
    return;
  }

  if (!msg.chatId || msg.isPrivate) {
    await msg.edit({ text: "❌ 仅群组可用", parseMode: "html" });
    return;
  }

  const taskId = msg.chatId.toString();

  try {
    // 无参数时显示帮助
    if (!sub) {
      await msg.edit({ text: help_text, parseMode: "html" });
      return;
    }

    // 处理 help 命令
    if (sub === "help" || sub === "h") {
      await msg.edit({ text: help_text, parseMode: "html" });
      return;
    }

    // 处理停止命令
    if (sub === "stop") {
      const task = await getTask(taskId);
      
      if (!task) {
        await msg.delete();
        return;
      }
      
      task.isRunning = false;
      task.isPaused = true;
      await saveTask(task);
      
      const msgId = await sendProgressToSaved(client, task, "已手动停止");
      if (msgId && !task.savedMessageId) {
        task.savedMessageId = msgId;
        await saveTask(task);
      }
      
      await msg.delete();
      return;
    }

    // 处理状态查询
    if (sub === "status") {
      const task = await getTask(taskId);
      
      if (!task) {
        await msg.delete();
        return;
      }
      
      const msgId = await sendProgressToSaved(client, task, "状态查询");
      if (msgId && !task.savedMessageId) {
        task.savedMessageId = msgId;
        await saveTask(task);
      }
      
      await msg.delete();
      return;
    }

    if (sub !== "true") {
      await msg.edit({ text: "❌ 未知命令", parseMode: "html" });
      return;
    }

    // 检查是否已有运行中的任务
    const existingTask = await getTask(taskId);
    
    if (existingTask && existingTask.isRunning) {
      await msg.delete();
      return;
    }

    // 获取群聊信息
    let chatName = "未知群组";
    try {
      const chat = await client.getEntity(msg.chatId);
      if ("title" in chat) {
        chatName = chat.title || "未知群组";
      }
    } catch (error) {
      console.error("获取群聊信息失败:", error);
    }

    // 创建或恢复任务
    const task: DeleteTask = existingTask || {
      chatId: taskId,
      chatName,
      startTime: Date.now(),
      deletedMessages: 0,
      isRunning: true,
      isPaused: false,
      sleepUntil: null,
      lastUpdate: Date.now(),
      lastLogTime: Date.now(),
      errors: [],
    };

    task.isRunning = true;
    task.isPaused = false;
    task.lastUpdate = Date.now();
    await saveTask(task);

    // 删除命令消息
    await msg.delete();

    // 开始执行删除任务
    const chatId = msg.chatId;
    const me = await client.getMe();
    const myId = me.id;

    // 检查管理员权限
    let isAdmin = false;
    try {
      const chat = await client.getEntity(chatId);
      if (chat.className === "Channel") {
        try {
          const result = await client.invoke(
            new Api.channels.GetParticipant({
              channel: chat as Api.Channel,
              participant: myId,
            })
          );
          isAdmin =
            result.participant instanceof Api.ChannelParticipantAdmin ||
            result.participant instanceof Api.ChannelParticipantCreator;
        } catch (permError) {
          console.log("权限检查失败，尝试备用方法:", permError);
          try {
            const adminResult = await client.invoke(
              new Api.channels.GetParticipants({
                channel: chat as Api.Channel,
                filter: new Api.ChannelParticipantsAdmins(),
                offset: 0,
                limit: 100,
                hash: 0 as any,
              })
            );
            if ("users" in adminResult) {
              const admins = adminResult.users as Api.User[];
              isAdmin = admins.some(
                (admin) => Number(admin.id) === Number(myId)
              );
            }
          } catch (adminListError) {
            console.log("管理员列表获取失败:", adminListError);
            isAdmin = false;
          }
        }
      }
    } catch (e) {
      console.error("权限检查失败:", e);
      isAdmin = false;
    }

    // 启动日志
    console.log(`[DA] 任务启动 - 群组: ${chatName} | 模式: ${isAdmin ? "管理员" : "普通用户"}`);

    // 自动发送任务开始状态到收藏夹
    const msgId = await sendProgressToSaved(client, task, "任务已启动");
    if (msgId) {
      task.savedMessageId = msgId;
      await saveTask(task);
    }

    // 批处理配置
    const BATCH_SIZE = 100;
    let floodWaitTime = 0;
    let consecutiveErrors = 0;

    if (isAdmin) {
      // 管理员模式：使用传统遍历删除所有消息
      console.log(`[DA] 管理员模式：遍历删除所有消息`);
      let messages: Api.Message[] = [];
      
      const deleteIterator = client.iterMessages(chatId, { minId: 1 });
      
      for await (const message of deleteIterator) {
        // 检查是否需要停止
        const currentTask = await getTask(taskId);
        if (!currentTask || !currentTask.isRunning) {
          // 最后更新一次收藏夹状态
          if (client) {
            await sendProgressToSaved(client, task, "已停止");
          }
          return;
        }

        messages.push(message);

        // 达到批处理大小时执行删除
        if (messages.length >= BATCH_SIZE) {
          await fastDeleteBatch(client, chatId, messages, task);
          messages = [];
        }
      }

      // 删除剩余消息
      if (messages.length > 0) {
        await fastDeleteBatch(client, chatId, messages, task);
      }
    } else {
      // 普通用户模式：使用优化搜索只删除自己的消息
      console.log(`[DA] 普通用户模式：使用优化搜索删除自己的消息`);
      
      try {
        const chatEntity = await client.getEntity(chatId);
        const myMessages = await searchMyMessagesOptimized(client, chatEntity, myId, BATCH_SIZE);
        
        if (myMessages.length === 0) {
          console.log(`[DA] 未找到任何自己的消息`);
          task.isRunning = false;
          await saveTask(task);
          await sendProgressToSaved(client, task, "未找到消息");
          return;
        }

        console.log(`[DA] 找到 ${myMessages.length} 条自己的消息，开始批量删除`);

        // 分批删除消息，优化进度报告
        const totalBatches = Math.ceil(myMessages.length / BATCH_SIZE);
        let currentBatch = 0;
        
        for (let i = 0; i < myMessages.length; i += BATCH_SIZE) {
          currentBatch++;
          
          // 检查是否需要停止
          const currentTask = await getTask(taskId);
          if (!currentTask || !currentTask.isRunning) {
            await sendProgressToSaved(client, task, "已停止");
            return;
          }

          const batch = myMessages.slice(i, i + BATCH_SIZE);
          console.log(`[DA] 优化模式：处理批次 ${currentBatch}/${totalBatches}，消息数: ${batch.length}`);
          
          await fastDeleteBatch(client, chatId, batch, task);

          // 静默处理，无进度反馈
        }
      } catch (error) {
        console.error("[DA] 优化删除失败:", error);
        task.errors.push(`优化删除失败: ${error}`);
        task.isRunning = false;
        await saveTask(task);
        await sendProgressToSaved(client, task, "执行失败");
        return;
      }
    }

    // 任务完成
    task.isRunning = false;
    task.lastUpdate = Date.now();
    await saveTask(task);
    
    // 最终日志报告
    const totalTime = Math.floor((Date.now() - task.startTime) / 1000);
    const avgSpeed = task.deletedMessages / totalTime;
    console.log(`[DA] 任务完成 - 群组: ${task.chatName} | 总删除: ${task.deletedMessages} 条 | 总耗时: ${totalTime}秒 | 平均速度: ${avgSpeed.toFixed(1)} 条/秒`);
    
    await sendProgressToSaved(client, task, "任务完成");

    // 清理任务
    await removeTask(taskId);

  } catch (error: any) {
    console.error("[DA] 插件执行失败:", error);
    
    // 如果任务已创建，更新状态
    const existingTask = await getTask(taskId);
    if (existingTask) {
      existingTask.isRunning = false;
      existingTask.errors.push(String(error));
      await saveTask(existingTask);
      await sendProgressToSaved(client, existingTask, "执行失败");
    }
    
    // 处理特定错误类型
    if (error.message?.includes("FLOOD_WAIT")) {
      const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
      // 静默处理，不在群聊显示错误
      console.log(`[DA] FLOOD_WAIT: 需等待 ${waitTime} 秒`);
      return;
    }
    
    // 其他错误也静默处理
    console.log(`[DA] 错误: ${error.message || "未知错误"}`);
  }
};

class DaPlugin extends Plugin {
  // 必须在 description 中引用 help_text
  description: string = `群组消息批量删除插件\n\n${help_text}`;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    da,
  };
}

export default new DaPlugin();

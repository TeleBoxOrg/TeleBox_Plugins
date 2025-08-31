import { Plugin } from "@utils/pluginBase";
import path from "path";
import schedule, { Job } from "node-schedule";
import Database from "better-sqlite3";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getGlobalClient } from "@utils/globalClient";
import { TelegramClient } from "telegram";
import { Api } from "telegram/tl";
import { getEntityWithHash } from "@utils/entityHelpers";

// Initialize database
let db = new Database(
  path.join(createDirectoryInAssets("pin_cron"), "pin_cron.db")
);

// Initialize database table
if (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pin_cron_tasks (
      task_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      operation TEXT NOT NULL,
      cron TEXT NOT NULL,
      comment TEXT DEFAULT '',
      target_chat_id INTEGER,
      silent INTEGER DEFAULT 0,
      pause INTEGER DEFAULT 0
    )
  `);
}

// HTML escape function
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

interface PinTaskData {
  task_id: number;
  chat_id: number;
  message_id: number;
  operation: string;
  cron: string;
  comment: string;
  target_chat_id?: number;
  silent: boolean;
  pause: boolean;
}

class PinTask {
  task_id: number;
  chat_id: number;
  message_id: number;
  operation: string; // 'pin' or 'unpin'
  cron: string;
  comment: string;
  target_chat_id?: number;
  silent: boolean;
  pause: boolean;
  public scheduledJob: Job | undefined = undefined;

  constructor(
    task_id: number,
    chat_id: number = 0,
    message_id: number = 0,
    operation: string = "pin",
    cronExpr: string = "",
    comment: string = "",
    target_chat_id?: number,
    silent: boolean = false,
    pause: boolean = false
  ) {
    this.task_id = task_id;
    this.chat_id = chat_id;
    this.message_id = message_id;
    this.operation = operation;
    this.cron = cronExpr;
    this.comment = comment;
    this.target_chat_id = target_chat_id;
    this.silent = silent;
    this.pause = pause;
  }

  export(): PinTaskData {
    return {
      task_id: this.task_id,
      chat_id: this.chat_id,
      message_id: this.message_id,
      operation: this.operation,
      cron: this.cron,
      comment: this.comment,
      target_chat_id: this.target_chat_id,
      silent: this.silent,
      pause: this.pause,
    };
  }

  removeJob(): void {
    if (this.scheduledJob) {
      this.scheduledJob.cancel();
      this.scheduledJob = undefined;
    }
  }

  exportStr(showAll: boolean = false): string {
    let text = `<code>${this.task_id}</code> - <code>${this.cron}</code> - `;

    if (this.scheduledJob && !this.pause) {
      text += `<code>运行中</code> - `;
    } else {
      text += `<code>已暂停</code> - `;
    }

    if (showAll) {
      text += `<code>${this.target_chat_id || this.chat_id}</code> - `;
    }

    text += `<code>${this.operation}</code> - `;
    text += `<code>消息${this.message_id}</code>`;
    
    if (this.silent) {
      text += ` - <code>静默</code>`;
    }
    
    if (this.comment) {
      text += ` - ${htmlEscape(this.comment)}`;
    }

    return text;
  }

  parseTask(text: string, currentChatId: number): void {
    const parts = text.split("|").map(p => p.trim());
    if (parts.length < 3) {
      throw new Error("参数不足，格式：<crontab> | <消息ID> | <操作类型> | <备注> [| <对话ID>] [| silent]");
    }

    // Parse cron expression
    const cronText = parts[0].trim();
    if (cronText.split(" ").length !== 6) {
      throw new Error("Cron 表达式格式错误（需要6个字段：秒 分 时 日 月 周）。");
    }
    this.cron = cronText;

    // Parse message ID
    const messageId = parseInt(parts[1]);
    if (isNaN(messageId)) {
      throw new Error("消息ID必须是数字。");
    }
    this.message_id = messageId;

    // Parse operation
    const operation = parts[2].toLowerCase();
    if (!["pin", "unpin"].includes(operation)) {
      throw new Error("操作类型必须是 'pin' 或 'unpin'。");
    }
    this.operation = operation;

    // Parse comment (optional)
    this.comment = parts.length > 3 ? parts[3] : "";

    // Parse target chat ID (optional)
    if (parts.length > 4 && parts[4]) {
      const targetChatId = parseInt(parts[4]);
      if (!isNaN(targetChatId)) {
        this.target_chat_id = targetChatId;
      }
    } else {
      this.target_chat_id = currentChatId;
    }

    // Parse silent option (optional)
    if (parts.length > 5 && parts[5].toLowerCase() === "silent") {
      this.silent = true;
    }
  }

  getCronExpression(): string {
    return this.cron;
  }
}

class PinTasks {
  private tasks: PinTask[] = [];

  add(task: PinTask): void {
    if (!this.tasks.some((t) => t.task_id === task.task_id)) {
      this.tasks.push(task);
    }
  }

  remove(taskId: number): boolean {
    const taskIndex = this.tasks.findIndex((t) => t.task_id === taskId);
    if (taskIndex !== -1) {
      this.tasks[taskIndex].removeJob();
      this.tasks.splice(taskIndex, 1);
      return true;
    }
    return false;
  }

  get(taskId: number): PinTask | undefined {
    return this.tasks.find((t) => t.task_id === taskId);
  }

  printAllTasks(showAll: boolean = false, chatId: number = 0): string {
    const tasksToShow = showAll
      ? this.tasks
      : this.tasks.filter((t) => (t.target_chat_id || t.chat_id) === chatId);

    if (tasksToShow.length === 0) {
      return showAll ? "当前没有任何任务。" : "当前聊天没有任何任务。";
    }

    return tasksToShow.map((task) => task.exportStr(showAll)).join("\n");
  }

  saveToDB(): void {
    if (!db) return;

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO pin_cron_tasks (task_id, chat_id, message_id, operation, cron, comment, target_chat_id, silent, pause)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deleteStmt = db.prepare("DELETE FROM pin_cron_tasks");
    deleteStmt.run();

    for (const task of this.tasks) {
      stmt.run(
        task.task_id,
        task.chat_id,
        task.message_id,
        task.operation,
        task.cron,
        task.comment,
        task.target_chat_id,
        task.silent ? 1 : 0,
        task.pause ? 1 : 0
      );
    }
  }

  loadFromDB(): void {
    if (!db) return;

    const stmt = db.prepare("SELECT * FROM pin_cron_tasks");
    const rows = stmt.all() as any[];

    this.tasks = rows.map(
      (row) =>
        new PinTask(
          row.task_id,
          row.chat_id,
          row.message_id,
          row.operation,
          row.cron,
          row.comment,
          row.target_chat_id,
          row.silent === 1,
          row.pause === 1
        )
    );
  }

  pauseTask(taskId: number): boolean {
    const task = this.get(taskId);
    if (task) {
      task.pause = true;
      task.removeJob();
      this.saveToDB();
      return true;
    }
    return false;
  }

  static async pinMessageJob(
    task: PinTask,
    bot: TelegramClient | undefined
  ): Promise<void> {
    try {
      if (!bot) {
        console.error(`No bot instance available for pin task ${task.task_id}`);
        return;
      }

      const targetChatId = task.target_chat_id || task.chat_id;
      
      // 使用通用实体处理函数
      const chatEntity = await getEntityWithHash(bot, targetChatId);

      if (task.operation === "pin") {
        // 先验证消息是否存在
        try {
          const messages = await bot.getMessages(chatEntity, {
            ids: [task.message_id],
            limit: 1
          });
          
          if (!messages || messages.length === 0 || !messages[0]) {
            console.error(`[PIN_CRON] 消息ID ${task.message_id} 不存在于聊天 ${targetChatId}`);
            return;
          }
          
          await bot.invoke(new Api.messages.UpdatePinnedMessage({
            peer: chatEntity,
            id: task.message_id,
            silent: task.silent,
            pmOneside: false
          }));
          console.log(`[PIN_CRON] 置顶消息成功: 任务${task.task_id}, 消息${task.message_id}, 聊天${targetChatId}`);
        } catch (msgError) {
          console.error(`[PIN_CRON] 验证消息失败: 任务${task.task_id}, 消息${task.message_id}`, msgError);
          return;
        }
      } else if (task.operation === "unpin") {
        await bot.invoke(new Api.messages.UpdatePinnedMessage({
          peer: chatEntity,
          id: 0, // 0 means unpin all
          silent: task.silent,
          pmOneside: false
        }));
        console.log(`[PIN_CRON] 取消置顶成功: 任务${task.task_id}, 聊天${targetChatId}`);
      }
    } catch (error) {
      console.error(
        `Failed to execute pin operation for task ${task.task_id}:`,
        error
      );
    }
  }

  registerTask(task: PinTask, bot: TelegramClient | undefined): void {
    if (task.pause || !schedule) {
      return;
    }

    try {
      const cronExpression = task.getCronExpression();
      task.scheduledJob = schedule.scheduleJob(cronExpression, () => {
        PinTasks.pinMessageJob(task, bot);
      });
    } catch (error) {
      console.error(`Failed to register pin task ${task.task_id}:`, error);
    }
  }

  resumeTask(taskId: number, bot: TelegramClient | undefined): boolean {
    const task = this.get(taskId);
    if (task) {
      task.pause = false;
      this.registerTask(task, bot);
      this.saveToDB();
      return true;
    }
    return false;
  }

  registerAllTasks(bot: TelegramClient | undefined): void {
    for (const task of this.tasks) {
      this.registerTask(task, bot);
    }
  }

  getNextTaskId(): number {
    return this.tasks.length > 0
      ? Math.max(...this.tasks.map((t) => t.task_id)) + 1
      : 1;
  }
}

// Initialize tasks manager
const pinCronTasks = new PinTasks();

async function loadTasksAfterImportCurrentPlugin() {
  try {
    if (!db) return;
    const client = await getGlobalClient();
    await client.getDialogs();
    pinCronTasks.loadFromDB();
    pinCronTasks.registerAllTasks(client);
  } catch (error) {
    console.error(
      "Failed to load pin tasks after importing current plugin:",
      error
    );
  }
}

loadTasksAfterImportCurrentPlugin();

const pinHelpMsg = `📌 <b>定时置顶消息插件</b>

• <b>添加任务:</b>
  <code>pin_cron &lt;crontab&gt; | &lt;消息ID&gt; | &lt;操作类型&gt; | &lt;备注&gt; [| &lt;对话ID&gt;] [| silent]</code>
  <i>Crontab 表达式有6个字段，分别代表：秒 分 时 日 月 周</i>
  <i>操作类型：pin（置顶）或 unpin（取消置顶）</i>
  <i>对话ID：可选，不填则在当前聊天执行</i>
  <i>silent：可选，静默置顶不通知</i>

  <u>示例:</u>
  <code>pin_cron 0 0 9 * * * | 12345 | pin | 早晨公告 |</code>
  (每天 09:00:00 在当前聊天置顶消息，备注为"早晨公告")
  <code>pin_cron 0 0 18 * * * | 12345 | unpin | 工作日结束 | -1001234567890</code>
  (每天 18:00:00 在指定群组取消置顶消息，备注为"工作日结束")
  <code>pin_cron 0 */30 * * * * | 67890 | pin | 定时提醒 | | silent</code>
  (每30分钟在当前聊天静默置顶消息，备注为"定时提醒")

• <b>查看任务:</b>
  <code>pin_cron list</code> (查看本群任务)
  <code>pin_cron list all</code> (查看所有任务)

• <b>管理任务:</b>
  <code>pin_cron rm &lt;ID&gt;</code> (删除任务)
  <code>pin_cron pause &lt;ID&gt;</code> (暂停任务)
  <code>pin_cron resume &lt;ID&gt;</code> (恢复任务)

💡 <b>复制粘贴功能:</b>
使用 <code>list</code> 命令查看任务，复制输出的格式化字符串，
在前面加上 <code>pin_cron</code> 即可快速创建相似任务`;

const pinCronPlugin: Plugin = {
  command: ["pin_cron"],
  description: `
定时置顶消息插件：
- pin_cron <crontab> | <消息ID> | <操作> | <备注> [| <对话ID>] [| silent] - 添加定时任务
- pin_cron list - 查看当前聊天任务
- pin_cron list all - 查看所有任务
- pin_cron rm <ID> - 删除任务
- pin_cron pause <ID> - 暂停任务
- pin_cron resume <ID> - 恢复任务

Crontab 格式：秒 分 时 日 月 周
操作类型：pin（置顶）或 unpin（取消置顶）
  `,
  cmdHandler: async (msg) => {
    try {
      const args = msg.message.slice(1).split(" ").slice(1); // Remove command part

      if (args.length === 0 || args[0] === "h") {
        await msg.edit({
          text: pinHelpMsg,
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      const cmd = args[0];

      // List tasks
      if (cmd === "list") {
        const showAll = args.length > 1 && args[1] === "all";
        const header = showAll
          ? "<b>所有已注册的置顶任务:</b>"
          : "<b>当前聊天已注册的置顶任务:</b>";
        let chatId: number;
        try {
          if (msg.chat?.id) {
            chatId = Number(msg.chat.id);
          } else if (msg.peerId) {
            chatId = Number(msg.peerId.toString());
          } else if (msg.chatId) {
            chatId = Number(msg.chatId.toString());
          } else {
            chatId = 0;
          }
        } catch (error) {
          chatId = 0;
        }
        const tasksStr = pinCronTasks.printAllTasks(showAll, chatId);

        await msg.edit({
          text: `${header}\n\n${tasksStr}`,
          parseMode: "html",
        });
        return;
      }

      // Management commands
      if (["rm", "pause", "resume"].includes(cmd)) {
        if (args.length < 2) {
          await msg.edit({ text: "❌ 缺少任务 ID。" });
          return;
        }

        let taskId: number;
        try {
          taskId = parseInt(args[1]);
          if (!pinCronTasks.get(taskId)) {
            await msg.edit({
              text: `❌ 任务 ID <code>${taskId}</code> 不存在。`,
              parseMode: "html",
            });
            return;
          }
        } catch (error) {
          await msg.edit({ text: "❌ 任务 ID 必须是数字。" });
          return;
        }

        if (cmd === "rm") {
          pinCronTasks.remove(taskId);
          pinCronTasks.saveToDB();
          await msg.edit({
            text: `✅ 已删除置顶任务 <code>${taskId}</code>。`,
            parseMode: "html",
          });
        } else if (cmd === "pause") {
          pinCronTasks.pauseTask(taskId);
          await msg.edit({
            text: `⏸️ 已暂停置顶任务 <code>${taskId}</code>。`,
            parseMode: "html",
          });
        } else if (cmd === "resume") {
          pinCronTasks.resumeTask(taskId, msg.client);
          await msg.edit({
            text: `▶️ 已恢复置顶任务 <code>${taskId}</code>。`,
            parseMode: "html",
          });
        }
        return;
      }

      // Add new task - Extract chat ID properly
      let chatId2: number;
      try {
        if (msg.chat?.id) {
          chatId2 = Number(msg.chat.id);
        } else if (msg.peerId) {
          chatId2 = Number(msg.peerId.toString());
        } else if (msg.chatId) {
          chatId2 = Number(msg.chatId.toString());
        } else {
          chatId2 = 0;
        }
      } catch (error) {
        chatId2 = 0;
      }

      if (!chatId2 || chatId2 === 0) {
        await msg.edit({ text: "❌ 无法获取聊天ID，请重试。" });
        return;
      }

      const task = new PinTask(pinCronTasks.getNextTaskId(), chatId2);

      try {
        task.parseTask(args.join(" "), chatId2);
      } catch (error: any) {
        await msg.edit({
          text: `❌ <b>参数错误:</b> ${htmlEscape(error.message)}`,
          parseMode: "html",
        });
        return;
      }

      pinCronTasks.add(task);
      pinCronTasks.registerTask(task, msg.client);
      pinCronTasks.saveToDB();

      const operationText = task.operation === "pin" ? "置顶" : "取消置顶";
      const silentText = task.silent ? "（静默）" : "";
      await msg.edit({
        text: `✅ 已添加新${operationText}任务${silentText}，ID 为 <code>${task.task_id}</code>。`,
        parseMode: "html",
      });
    } catch (error: any) {
      console.error("Pin cron error:", error);
      await msg.edit({
        text: `❌ 操作失败：${error.message || error}`,
      });
    }
  },
};

export default pinCronPlugin;

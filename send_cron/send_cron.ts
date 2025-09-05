import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs";

// HTML escape function
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// 配置接口
interface SendCronConfig {
  tasks?: SendTaskData[];
}

interface SendTaskData {
  task_id: number;
  chat_id: number;
  msg: string;
  cron: string;
  pause: boolean;
}

// 统一配置管理类
class Config {
  private static db: any = null;
  private static initPromise: Promise<void> | null = null;

  private static async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    await this.initPromise;
  }

  private static async doInit(): Promise<void> {
    const filePath = path.join(
      createDirectoryInAssets("send_cron"),
      "send_cron_config.json"
    );
    this.db = await JSONFilePreset<SendCronConfig>(filePath, { tasks: [] });
  }

  static async load(): Promise<SendCronConfig> {
    await this.init();
    return { ...this.db.data };
  }

  static async save(config: SendCronConfig): Promise<void> {
    await this.init();
    this.db.data = { ...config };
    await this.db.write();
  }

  static async get<T>(key: keyof SendCronConfig, def?: T): Promise<T> {
    await this.init();
    const v = (this.db.data as any)[key];
    return v !== undefined ? (v as T) : (def as T);
  }

  static async set<T>(key: keyof SendCronConfig, value: T): Promise<void> {
    await this.init();
    if (value === null || value === undefined) {
      delete (this.db.data as any)[key];
    } else {
      (this.db.data as any)[key] = value;
    }
    await this.db.write();
  }
}

class SendTask {
  task_id: number;
  chat_id: number;
  msg: string;
  cron: string;
  pause: boolean;

  constructor(
    task_id: number,
    chat_id: number = 0,
    msg: string = "",
    cronExpr: string = "",
    pause: boolean = false
  ) {
    this.task_id = task_id;
    this.chat_id = chat_id;
    this.msg = msg;
    this.cron = cronExpr;
    this.pause = pause;
  }

  export(): SendTaskData {
    return {
      task_id: this.task_id,
      chat_id: this.chat_id,
      msg: this.msg,
      cron: this.cron,
      pause: this.pause,
    };
  }

  getTaskName(): string {
    return `send_cron_${this.task_id}`;
  }

  exportStr(showAll: boolean = false): string {
    let text = `<code>${this.task_id}</code> - <code>${this.cron}</code> - `;

    if (cronManager.has(this.getTaskName()) && !this.pause) {
      text += `<code>运行中</code> - `;
    } else {
      text += `<code>已暂停</code> - `;
    }

    if (showAll) {
      text += `<code>${this.chat_id}</code> - `;
    }

    const displayMsg =
      this.msg.length > 50 ? this.msg.substring(0, 50) + "..." : this.msg;
    text += htmlEscape(displayMsg);

    return text;
  }

  parseTask(text: string): void {
    const parts = text.split("|");
    if (parts.length < 2) {
      throw new Error("消息内容不能为空，请用 `|` 分隔。");
    }

    this.msg = parts.slice(1).join("|").trim();
    const cronText = parts[0].trim();

    if (cronText.split(" ").length !== 6) {
      throw new Error("Cron 表达式格式错误（需要6个字段）。");
    }

    this.cron = cronText;
  }

  getCronExpression(): string {
    return this.cron;
  }
}

class SendTasks {
  private tasks: SendTask[] = [];

  add(task: SendTask): void {
    if (!this.tasks.some((t) => t.task_id === task.task_id)) {
      this.tasks.push(task);
    }
  }

  remove(taskId: number): boolean {
    const taskIndex = this.tasks.findIndex((t) => t.task_id === taskId);
    if (taskIndex !== -1) {
      // 移除 cronManager 中的任务
      const task = this.tasks[taskIndex];
      cronManager.del(task.getTaskName());
      this.tasks.splice(taskIndex, 1);
      return true;
    }
    return false;
  }

  get(taskId: number): SendTask | undefined {
    return this.tasks.find((t) => t.task_id === taskId);
  }

  printAllTasks(showAll: boolean = false, chatId: number = 0): string {
    const tasksToShow = showAll
      ? this.tasks
      : this.tasks.filter((t) => t.chat_id === chatId);

    if (tasksToShow.length === 0) {
      return showAll ? "当前没有任何任务。" : "当前聊天没有任何任务。";
    }

    return tasksToShow.map((task) => task.exportStr(showAll)).join("\n");
  }

  async saveToDB(): Promise<void> {
    const tasksData = this.tasks.map((task) => task.export());
    await Config.set("tasks", tasksData);
  }

  async loadFromDB(): Promise<void> {
    const tasksData = await Config.get<SendTaskData[]>("tasks", []);
    this.tasks = tasksData.map(
      (data) =>
        new SendTask(
          data.task_id,
          data.chat_id,
          data.msg,
          data.cron,
          data.pause
        )
    );
  }

  pauseTask(taskId: number): boolean {
    const task = this.get(taskId);
    if (task) {
      task.pause = true;
      cronManager.del(task.getTaskName());
      this.saveToDB();
      return true;
    }
    return false;
  }

  static async sendMessageJob(
    task: SendTask,
    bot: TelegramClient | undefined
  ): Promise<void> {
    try {
      if (bot) {
        await bot.sendMessage(task.chat_id, { message: task.msg });
      } else {
        console.error(`No bot instance available for task ${task.task_id}`);
      }
    } catch (error) {
      console.error(
        `Failed to send scheduled message for task ${task.task_id}:`,
        error
      );
    }
  }

  registerTask(task: SendTask, bot: TelegramClient | undefined): void {
    if (task.pause) {
      return;
    }

    try {
      const cronExpression = task.getCronExpression();
      cronManager.set(task.getTaskName(), cronExpression, () => {
        SendTasks.sendMessageJob(task, bot);
      });
    } catch (error) {
      console.error(`Failed to register task ${task.task_id}:`, error);
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
const sendCronTasks = new SendTasks();

async function loadTasksAfterImportCurrentPlugin() {
  try {
    const client = await getGlobalClient();
    if (!client) return;

    await client.getDialogs();
    await sendCronTasks.loadFromDB();
    sendCronTasks.registerAllTasks(client);
  } catch (error) {
    console.error(
      "Failed to load tasks after importing current plugin:",
      error
    );
  }
}

// 延迟加载任务
setTimeout(() => {
  loadTasksAfterImportCurrentPlugin();
}, 2000);

const sendHelpMsg = `<b>定时发送消息插件</b>

• <b>添加任务:</b>
  <code>send_cron &lt;crontab&gt; | &lt;消息&gt;</code>
  <i>Crontab 表达式有6个字段，分别代表：秒 分 时 日 月 周</i>

  <u>示例:</u>
  <code>send_cron 59 59 23 * * * | 又是无所事事的一天呢。</code>
  (每天 23:59:59 发送)
  <code>send_cron 0 */5 * * * * | 每5分钟提醒一次。</code>
  (每5分钟的第0秒发送)

• <b>查看任务:</b>
  <code>send_cron list</code> (查看本群任务)
  <code>send_cron list all</code> (查看所有任务)

• <b>管理任务:</b>
  <code>send_cron rm &lt;ID&gt;</code>
  <code>send_cron pause &lt;ID&gt;</code>
  <code>send_cron resume &lt;ID&gt;</code>`;

class SendCronPlugin extends Plugin {
  description: string = `定时发送消息插件：
- send_cron <crontab> | <消息> - 添加定时任务
- send_cron list - 查看当前聊天任务
- send_cron list all - 查看所有任务
- send_cron rm <ID> - 删除任务
- send_cron pause <ID> - 暂停任务
- send_cron resume <ID> - 恢复任务

Crontab 格式：秒 分 时 日 月 周
示例：send_cron 0 0 12 * * * | 每天中午12点的消息`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    send_cron: async (msg) => {
      const args = msg.message.slice(1).split(" ").slice(1); // Remove command part

      if (args.length === 0 || args[0] === "h") {
        await msg.edit({
          text: sendHelpMsg,
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
          ? "<b>所有已注册的任务:</b>"
          : "<b>当前聊天已注册的任务:</b>";
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
        const tasksStr = sendCronTasks.printAllTasks(showAll, chatId);

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
          if (!sendCronTasks.get(taskId)) {
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
          sendCronTasks.remove(taskId);
          await sendCronTasks.saveToDB();
          await msg.edit({
            text: `✅ 已删除任务 <code>${taskId}</code>。`,
            parseMode: "html",
          });
        } else if (cmd === "pause") {
          sendCronTasks.pauseTask(taskId);
          await msg.edit({
            text: `⏸️ 已暂停任务 <code>${taskId}</code>。`,
            parseMode: "html",
          });
        } else if (cmd === "resume") {
          sendCronTasks.resumeTask(taskId, msg.client);
          await msg.edit({
            text: `▶️ 已恢复任务 <code>${taskId}</code>。`,
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

      const task = new SendTask(sendCronTasks.getNextTaskId(), chatId2);

      try {
        task.parseTask(args.join(" "));
      } catch (error: any) {
        await msg.edit({
          text: `❌ <b>参数错误:</b> ${htmlEscape(error.message)}`,
          parseMode: "html",
        });
        return;
      }

      sendCronTasks.add(task);
      sendCronTasks.registerTask(task, msg.client);
      await sendCronTasks.saveToDB();

      await msg.edit({
        text: `✅ 已添加新任务，ID 为 <code>${task.task_id}</code>。`,
        parseMode: "html",
      });
    },
  };
}

// 插件初始化时启动定时任务
setTimeout(() => {
  try {
    loadTasksAfterImportCurrentPlugin();
  } catch (error) {
    console.error("定时发送任务启动失败:", error);
  }
}, 3000);

export default new SendCronPlugin();

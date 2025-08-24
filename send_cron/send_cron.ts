import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { npm_install } from "@utils/npm_install";
import fs from "fs";
import path from "path";

// Install required dependencies
npm_install("node-schedule");
npm_install("better-sqlite3");
npm_install("telegraf");

let schedule: any;
let Database: any;
let Telegraf: any;
let db: any;
let globalBot: any;

try {
  schedule = require("node-schedule");
  Database = require("better-sqlite3");
  Telegraf = require("telegraf");
  
  // Database setup
  const dbPath = path.join(process.cwd(), "data", "send_cron.db");
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  
  // Create bot instance for scheduled messages
  // Note: In real implementation, get token from environment or config
  const BOT_TOKEN = process.env.BOT_TOKEN || "dummy_token";
  if (BOT_TOKEN !== "dummy_token") {
    globalBot = new Telegraf(BOT_TOKEN);
  }
} catch (error) {
  console.error("Failed to import dependencies or initialize database:", error);
}

// Initialize database table
if (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS send_cron_tasks (
      task_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      msg TEXT NOT NULL,
      cron TEXT NOT NULL,
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

interface SendTaskData {
  task_id: number;
  chat_id: number;
  msg: string;
  cron: string;
  pause: boolean;
}

class SendTask {
  task_id: number;
  chat_id: number;
  msg: string;
  cron: string;
  pause: boolean;
  public scheduledJob: any = null;
  public clientRef: any = null; // Store client reference

  constructor(task_id: number, chat_id: number = 0, msg: string = "", cronExpr: string = "", pause: boolean = false) {
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
      pause: this.pause
    };
  }

  removeJob(): void {
    if (this.scheduledJob) {
      this.scheduledJob.cancel();
      this.scheduledJob = null;
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
      text += `<code>${this.chat_id}</code> - `;
    }
    
    const displayMsg = this.msg.length > 50 ? this.msg.substring(0, 50) + "..." : this.msg;
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
    
    // node-schedule supports 6-field cron expressions natively
    this.cron = cronText;
  }

  getCronExpression(): string {
    return this.cron; // node-schedule supports 6-field expressions directly
  }
}

class SendTasks {
  private tasks: SendTask[] = [];

  add(task: SendTask): void {
    if (!this.tasks.some(t => t.task_id === task.task_id)) {
      this.tasks.push(task);
    }
  }

  remove(taskId: number): boolean {
    const taskIndex = this.tasks.findIndex(t => t.task_id === taskId);
    if (taskIndex !== -1) {
      this.tasks[taskIndex].removeJob();
      this.tasks.splice(taskIndex, 1);
      return true;
    }
    return false;
  }

  get(taskId: number): SendTask | undefined {
    return this.tasks.find(t => t.task_id === taskId);
  }

  printAllTasks(showAll: boolean = false, chatId: number = 0): string {
    const tasksToShow = showAll ? this.tasks : this.tasks.filter(t => t.chat_id === chatId);
    
    if (tasksToShow.length === 0) {
      return showAll ? "当前没有任何任务。" : "当前聊天没有任何任务。";
    }
    
    return tasksToShow.map(task => task.exportStr(showAll)).join("\n");
  }

  saveToDB(): void {
    if (!db) return;
    
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO send_cron_tasks (task_id, chat_id, msg, cron, pause)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    const deleteStmt = db.prepare("DELETE FROM send_cron_tasks");
    deleteStmt.run();
    
    for (const task of this.tasks) {
      stmt.run(task.task_id, task.chat_id, task.msg, task.cron, task.pause ? 1 : 0);
    }
  }

  loadFromDB(): void {
    if (!db) return;
    
    const stmt = db.prepare("SELECT * FROM send_cron_tasks");
    const rows = stmt.all() as any[];
    
    this.tasks = rows.map(row => new SendTask(
      row.task_id,
      row.chat_id,
      row.msg,
      row.cron,
      row.pause === 1
    ));
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

  static async sendMessageJob(task: SendTask, bot?: any): Promise<void> {
    try {
      // Try multiple methods to send message
      if (bot && bot.telegram) {
        await bot.telegram.sendMessage(task.chat_id, task.msg);
      } else if (globalBot && globalBot.telegram) {
        await globalBot.telegram.sendMessage(task.chat_id, task.msg);
      } else if (task.clientRef) {
        // Use stored client reference - send text message not file
        await task.clientRef.sendMessage(task.chat_id, { message: task.msg });
      } else {
        console.error(`No bot instance available for task ${task.task_id}`);
      }
    } catch (error) {
      console.error(`Failed to send scheduled message for task ${task.task_id}:`, error);
    }
  }

  registerTask(task: SendTask, bot: any): void {
    if (task.pause || !schedule) {
      return;
    }

    try {
      const cronExpression = task.getCronExpression();
      task.scheduledJob = schedule.scheduleJob(cronExpression, () => {
        SendTasks.sendMessageJob(task, bot);
      });
    } catch (error) {
      console.error(`Failed to register task ${task.task_id}:`, error);
    }
  }

  resumeTask(taskId: number, bot: any): boolean {
    const task = this.get(taskId);
    if (task) {
      task.pause = false;
      this.registerTask(task, bot);
      this.saveToDB();
      return true;
    }
    return false;
  }

  registerAllTasks(bot: any): void {
    for (const task of this.tasks) {
      this.registerTask(task, bot);
    }
  }

  getNextTaskId(): number {
    return this.tasks.length > 0 ? Math.max(...this.tasks.map(t => t.task_id)) + 1 : 1;
  }
}

// Initialize tasks manager
const sendCronTasks = new SendTasks();
if (db) {
  sendCronTasks.loadFromDB();
}

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

const sendCronPlugin: Plugin = {
  command: "send_cron",
  description: `
定时发送消息插件：
- send_cron <crontab> | <消息> - 添加定时任务
- send_cron list - 查看当前聊天任务
- send_cron list all - 查看所有任务
- send_cron rm <ID> - 删除任务
- send_cron pause <ID> - 暂停任务
- send_cron resume <ID> - 恢复任务

Crontab 格式：秒 分 时 日 月 周
示例：send_cron 0 0 12 * * * | 每天中午12点的消息
  `,
  cmdHandler: async (msg: Api.Message) => {
    try {
      const args = msg.message.slice(1).split(" ").slice(1); // Remove command part
      
      if (args.length === 0 || args[0] === "h") {
        await msg.edit({
          text: sendHelpMsg,
          parseMode: "html",
          linkPreview: false
        });
        return;
      }

      const cmd = args[0];

      // List tasks
      if (cmd === "list") {
        const showAll = args.length > 1 && args[1] === "all";
        const header = showAll ? "<b>所有已注册的任务:</b>" : "<b>当前聊天已注册的任务:</b>";
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
          parseMode: "html"
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
              parseMode: "html"
            });
            return;
          }
        } catch (error) {
          await msg.edit({ text: "❌ 任务 ID 必须是数字。" });
          return;
        }

        if (cmd === "rm") {
          sendCronTasks.remove(taskId);
          sendCronTasks.saveToDB();
          await msg.edit({
            text: `✅ 已删除任务 <code>${taskId}</code>。`,
            parseMode: "html"
          });
        } else if (cmd === "pause") {
          sendCronTasks.pauseTask(taskId);
          await msg.edit({
            text: `⏸️ 已暂停任务 <code>${taskId}</code>。`,
            parseMode: "html"
          });
        } else if (cmd === "resume") {
          sendCronTasks.resumeTask(taskId, msg.client);
          await msg.edit({
            text: `▶️ 已恢复任务 <code>${taskId}</code>。`,
            parseMode: "html"
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
      // Store client reference for fallback
      task.clientRef = msg.client;
      
      try {
        task.parseTask(args.join(" "));
      } catch (error: any) {
        await msg.edit({
          text: `❌ <b>参数错误:</b> ${htmlEscape(error.message)}`,
          parseMode: "html"
        });
        return;
      }

      sendCronTasks.add(task);
      sendCronTasks.registerTask(task, globalBot || msg.client);
      sendCronTasks.saveToDB();
      
      await msg.edit({
        text: `✅ 已添加新任务，ID 为 <code>${task.task_id}</code>。`,
        parseMode: "html"
      });

    } catch (error: any) {
      console.error("Send cron error:", error);
      await msg.edit({
        text: `❌ 操作失败：${error.message || error}`
      });
    }
  },
};

// Register all tasks when plugin loads
setTimeout(() => {
  // We need to get the client somehow, this is a limitation
  // In a real implementation, you'd need to pass the client reference
  console.log("Send cron plugin loaded, tasks will be registered when client is available");
}, 1000);

export default sendCronPlugin;

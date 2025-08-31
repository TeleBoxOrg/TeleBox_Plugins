// import { Plugin } from "@utils/pluginBase";
import { TelegramClient, Api } from "telegram";
import Database from "better-sqlite3";
import * as schedule from "node-schedule";
import * as fs from "fs";
import * as path from "path";
import { getGlobalClient } from "@utils/globalClient";
import { getEntityWithHash, safeForwardMessage } from "../src/utils/entityHelpers";

// 确保数据库目录存在
const dbDir = "./assets/forward_cron";
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// 数据库初始化
const db = new Database("./assets/forward_cron/forward_cron.db");

// 创建任务表
db.exec(`
  CREATE TABLE IF NOT EXISTS forward_tasks (
    task_id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    source_chat_id TEXT NOT NULL,
    target_chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('forward', 'copy')),
    cron_expression TEXT NOT NULL,
    is_paused INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_run DATETIME,
    next_run DATETIME
  )
`);

interface ForwardTask {
  task_id: number;
  chat_id: string;
  source_chat_id: string;
  target_chat_id: string;
  message_id: number;
  operation: "forward" | "copy";
  cron_expression: string;
  is_paused: number;
  created_at: string;
  last_run?: string;
  next_run?: string;
}

class ForwardTasks {
  private static jobs = new Map<number, schedule.Job>();

  // 添加新任务
  static addTask(
    chatId: string,
    sourceChatId: string,
    targetChatId: string,
    messageId: number,
    operation: "forward" | "copy",
    cronExpression: string
  ): number {
    const stmt = db.prepare(`
      INSERT INTO forward_tasks (chat_id, source_chat_id, target_chat_id, message_id, operation, cron_expression)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(chatId, sourceChatId, targetChatId, messageId, operation, cronExpression);
    return result.lastInsertRowid as number;
  }

  // 获取所有任务
  static getAllTasks(chatId: string): ForwardTask[] {
    const stmt = db.prepare("SELECT * FROM forward_tasks WHERE chat_id = ? ORDER BY task_id");
    return stmt.all(chatId) as ForwardTask[];
  }

  // 获取单个任务
  static getTask(taskId: number): ForwardTask | undefined {
    const stmt = db.prepare("SELECT * FROM forward_tasks WHERE task_id = ?");
    return stmt.get(taskId) as ForwardTask | undefined;
  }

  // 删除任务
  static removeTask(taskId: number): boolean {
    const stmt = db.prepare("DELETE FROM forward_tasks WHERE task_id = ?");
    const result = stmt.run(taskId);
    return result.changes > 0;
  }

  // 暂停任务
  static pauseTask(taskId: number): boolean {
    const stmt = db.prepare("UPDATE forward_tasks SET is_paused = 1 WHERE task_id = ?");
    const result = stmt.run(taskId);
    return result.changes > 0;
  }

  // 恢复任务
  static resumeTask(taskId: number): boolean {
    const stmt = db.prepare("UPDATE forward_tasks SET is_paused = 0 WHERE task_id = ?");
    const result = stmt.run(taskId);
    return result.changes > 0;
  }

  // 更新最后运行时间
  static updateLastRun(taskId: number): void {
    const stmt = db.prepare("UPDATE forward_tasks SET last_run = CURRENT_TIMESTAMP WHERE task_id = ?");
    stmt.run(taskId);
  }

  // 执行转发/复制操作
  static async forwardMessageJob(
    task: ForwardTask,
    bot: TelegramClient | undefined
  ): Promise<void> {
    try {
      if (!bot) {
        console.error(`No bot instance available for forward task ${task.task_id}`);
        return;
      }

      if (task.operation === "forward") {
        // 使用安全转发函数
        console.log(`[FORWARD_CRON] 开始转发任务: ${task.task_id}, 消息${task.message_id}, 从${task.source_chat_id}到${task.target_chat_id}`);
        await safeForwardMessage(
          bot,
          task.source_chat_id,
          task.target_chat_id,
          task.message_id
        );
        console.log(`[FORWARD_CRON] 转发消息成功: 任务${task.task_id}, 消息${task.message_id}, 从${task.source_chat_id}到${task.target_chat_id}`);
      } else if (task.operation === "copy") {
        // 获取源聊天和目标聊天实体
        const sourceChatEntity = await getEntityWithHash(bot, task.source_chat_id);
        const targetChatEntity = await getEntityWithHash(bot, task.target_chat_id);
        
        // 先获取原消息
        const messages = await bot.getMessages(sourceChatEntity, {
          ids: [task.message_id],
          limit: 1
        });
        
        if (!messages || messages.length === 0 || !messages[0]) {
          console.error(`[FORWARD_CRON] 消息ID ${task.message_id} 不存在于聊天 ${task.source_chat_id}`);
          return;
        }

        const originalMessage = messages[0];
        
        // 复制消息内容
        if (originalMessage.text) {
          await bot.sendMessage(targetChatEntity, {
            message: originalMessage.text,
            parseMode: "html"
          });
        } else if (originalMessage.media) {
          // 处理媒体消息
          await bot.sendFile(targetChatEntity, {
            file: originalMessage.media,
            caption: originalMessage.message || ""
          });
        }
        console.log(`[FORWARD_CRON] 复制消息成功: 任务${task.task_id}, 消息${task.message_id}, 从${task.source_chat_id}到${task.target_chat_id}`);
      }

      // 更新最后运行时间
      ForwardTasks.updateLastRun(task.task_id);
    } catch (error) {
      console.error(
        `Failed to execute forward operation for task ${task.task_id}:`,
        error
      );
    }
  }

  // 注册定时任务
  static registerJob(task: ForwardTask, bot: TelegramClient | undefined): void {
    if (task.is_paused) {
      return;
    }

    try {
      const job = schedule.scheduleJob(task.cron_expression, async () => {
        await ForwardTasks.forwardMessageJob(task, bot);
      });

      if (job) {
        ForwardTasks.jobs.set(task.task_id, job);
        console.log(`[FORWARD_CRON] 注册定时任务成功: ${task.task_id} - ${task.cron_expression}`);
      }
    } catch (error) {
      console.error(`Failed to register job for task ${task.task_id}:`, error);
    }
  }

  // 取消定时任务
  static cancelJob(taskId: number): void {
    const job = ForwardTasks.jobs.get(taskId);
    if (job) {
      job.cancel();
      ForwardTasks.jobs.delete(taskId);
      console.log(`[FORWARD_CRON] 取消定时任务: ${taskId}`);
    }
  }

  // 重新加载所有任务
  static reloadAllJobs(bot: TelegramClient | undefined): void {
    // 取消所有现有任务
    ForwardTasks.jobs.forEach((job, taskId) => {
      job.cancel();
    });
    ForwardTasks.jobs.clear();

    // 重新加载所有未暂停的任务
    const stmt = db.prepare("SELECT * FROM forward_tasks WHERE is_paused = 0");
    const tasks = stmt.all() as ForwardTask[];
    
    tasks.forEach(task => {
      ForwardTasks.registerJob(task, bot);
    });

    console.log(`[FORWARD_CRON] 重新加载了 ${tasks.length} 个定时任务`);
  }
}

// 格式化cron表达式为可读格式
function formatCronExpression(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length !== 6) return cron;

  const [second, minute, hour, day, month, weekday] = parts;
  
  // 解析间隔执行模式
  if (second.startsWith("*/")) {
    const interval = parseInt(second.substring(2));
    return `每${interval}秒执行一次`;
  }
  
  if (minute.startsWith("*/") && second === "0") {
    const interval = parseInt(minute.substring(2));
    return `每${interval}分钟执行一次`;
  }
  
  if (hour.startsWith("*/") && minute === "0" && second === "0") {
    const interval = parseInt(hour.substring(2));
    return `每${interval}小时执行一次`;
  }
  
  if (day.startsWith("*/") && hour === "0" && minute === "0" && second === "0") {
    const interval = parseInt(day.substring(2));
    return `每${interval}天执行一次`;
  }
  
  // 解析特定时间执行
  if (second === "0" && minute === "0" && !hour.includes("*") && day === "*" && month === "*" && weekday === "*") {
    const h = parseInt(hour);
    if (h === 0) return "每天午夜执行";
    if (h === 12) return "每天中午12点执行";
    return `每天${h}点执行`;
  }
  
  // 解析每周特定时间
  if (second === "0" && minute === "0" && !hour.includes("*") && day === "*" && month === "*" && !weekday.includes("*")) {
    const h = parseInt(hour);
    const w = parseInt(weekday);
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const weekName = weekdays[w] || `周${w}`;
    
    if (h === 0) return `每${weekName}午夜执行`;
    if (h === 12) return `每${weekName}中午12点执行`;
    return `每${weekName}${h}点执行`;
  }
  
  // 解析每月特定日期
  if (second === "0" && minute === "0" && !hour.includes("*") && !day.includes("*") && month === "*" && weekday === "*") {
    const h = parseInt(hour);
    const d = parseInt(day);
    
    if (h === 0) return `每月${d}号午夜执行`;
    if (h === 12) return `每月${d}号中午12点执行`;
    return `每月${d}号${h}点执行`;
  }
  
  // 复合时间表达式
  let desc = "";
  
  // 秒
  if (second !== "*" && second !== "0") {
    if (second.startsWith("*/")) {
      desc += `每${second.substring(2)}秒`;
    } else {
      desc += `第${second}秒`;
    }
  }
  
  // 分钟
  if (minute !== "*" && minute !== "0") {
    if (desc) desc += " ";
    if (minute.startsWith("*/")) {
      desc += `每${minute.substring(2)}分钟`;
    } else {
      desc += `第${minute}分钟`;
    }
  }
  
  // 小时
  if (hour !== "*") {
    if (desc) desc += " ";
    if (hour.startsWith("*/")) {
      desc += `每${hour.substring(2)}小时`;
    } else {
      desc += `${hour}点`;
    }
  }
  
  if (desc) return desc + "执行";
  
  return cron;
}

// 解析聊天ID或用户名
function parseChatId(input: string, currentChatId: string): string {
  if (input === "here") return currentChatId;
  if (input === "me") return "me";
  if (input.startsWith("@")) return input;
  if (input.startsWith("-100")) return input;
  if (/^-?\d+$/.test(input)) return input;
  return input;
}

const forwardCronPlugin = {
  command: ["forward_cron", "fc"],
  description: "定时转发/复制消息插件",
  cmdHandler: async (msg: Api.Message) => {
    const text = msg.message || "";
    const chatId = msg.chatId?.toString() || msg.peerId?.toString() || "";

    // 解析命令
    const args = text.trim().split(/\s+/);
    const command = args[0];
    const subCommand = args[1];

    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({
        text: "❌ Telegram客户端未初始化",
        parseMode: "html"
      });
      return;
    }

    if (!subCommand) {
      // 显示帮助信息
      const helpText = `
<b>📋 定时转发/复制 - Forward Cron</b>

<b>🔧 命令列表:</b>
<code>.fc add [源聊天] [目标聊天] [消息ID] [操作] [cron表达式]</code> - 添加定时任务
<code>.fc list</code> - 查看所有任务
<code>.fc rm [任务ID]</code> - 删除任务
<code>.fc pause [任务ID]</code> - 暂停任务
<code>.fc resume [任务ID]</code> - 恢复任务
<code>.fc help</code> - 显示帮助

<b>📝 参数说明:</b>
• <b>源聊天:</b> 消息来源聊天ID/@用户名/群组名
• <b>目标聊天:</b> 转发目标聊天ID/@用户名/群组名 (可用 "here" 表示当前聊天)
• <b>消息ID:</b> 要转发/复制的消息ID
• <b>操作:</b> forward(转发) 或 copy(复制)
• <b>cron表达式:</b> 定时规则 (秒 分 时 日 月 周)

<b>⏰ 常用cron表达式:</b>
<code>0 0 9 * * *</code> - 每天上午9点
<code>0 0 12 * * *</code> - 每天中午12点
<code>0 0 18 * * 5</code> - 每周五下午6点
<code>0 */30 * * * *</code> - 每30分钟
<code>0 0 0 1 * *</code> - 每月1号午夜

<b>💡 使用示例:</b>
<code>.fc add @channel here 123 forward "0 0 9 * * *"</code>
<code>.fc add -1001234567890 @target_group 456 copy "0 0 12 * * 1"</code>
      `;
      
      await msg.edit({
        text: helpText.trim(),
        parseMode: "html"
      });
      return;
    }

    if (subCommand === "add") {
      if (args.length < 7) {
        await msg.edit({
          text: "❌ 参数不足\n\n用法: <code>.fc add [源聊天] [目标聊天] [消息ID] [操作] [cron表达式]</code>",
          parseMode: "html"
        });
        return;
      }

      const sourceChatInput = args[2];
      const targetChatInput = args[3];
      const messageId = parseInt(args[4]);
      const operation = args[5] as "forward" | "copy";
      const cronExpression = args.slice(6).join(" ").replace(/["""]/g, '"').replace(/^"|"$/g, '');

      if (isNaN(messageId)) {
        await msg.edit({
          text: "❌ 消息ID必须是数字",
          parseMode: "html"
        });
        return;
      }

      if (!["forward", "copy"].includes(operation)) {
        await msg.edit({
          text: "❌ 操作类型必须是 forward 或 copy",
          parseMode: "html"
        });
        return;
      }

      // 验证cron表达式
      try {
        const testJob = schedule.scheduleJob(cronExpression, () => {});
        if (testJob) {
          testJob.cancel();
        } else {
          throw new Error("Invalid cron expression");
        }
      } catch (error) {
        await msg.edit({
          text: "❌ 无效的cron表达式\n\n格式: <code>秒 分 时 日 月 周</code>\n例如: <code>0 0 9 * * *</code> (每天上午9点)",
          parseMode: "html"
        });
        return;
      }

      const sourceChatId = parseChatId(sourceChatInput, chatId);
      const targetChatId = parseChatId(targetChatInput, chatId);

      try {
        const taskId = ForwardTasks.addTask(
          chatId,
          sourceChatId,
          targetChatId,
          messageId,
          operation,
          cronExpression
        );

        const task = ForwardTasks.getTask(taskId);
        if (task) {
          ForwardTasks.registerJob(task, client);
        }

        // 获取当前任务的序号位置
        const allTasks = ForwardTasks.getAllTasks(chatId);
        const taskPosition = allTasks.length;
        
        const operationText = operation === "forward" ? "转发" : "复制";
        const cronDesc = formatCronExpression(cronExpression);
        
        await msg.edit({
          text: `✅ 定时${operationText}任务创建成功\n\n` +
                `📋 任务序号: <code>${taskPosition}</code>\n` +
                `📤 源聊天: <code>${sourceChatId}</code>\n` +
                `📥 目标聊天: <code>${targetChatId}</code>\n` +
                `📨 消息ID: <code>${messageId}</code>\n` +
                `🔄 操作: <code>${operationText}</code>\n` +
                `⏰ 定时: <code>${cronExpression}</code> (${cronDesc})`,
          parseMode: "html"
        });
      } catch (error) {
        console.error("Error adding forward task:", error);
        await msg.edit({
          text: "❌ 创建任务失败，请检查参数是否正确",
          parseMode: "html"
        });
      }
    }
    else if (subCommand === "list") {
      const tasks = ForwardTasks.getAllTasks(chatId);
      
      if (tasks.length === 0) {
        await msg.edit({
          text: "📋 暂无定时转发/复制任务",
          parseMode: "html"
        });
        return;
      }

      let listText = "<b>📋 定时转发/复制任务列表</b>\n\n";
      
      tasks.forEach((task, index) => {
        const status = task.is_paused ? "⏸️ 暂停" : "▶️ 运行中";
        const operationText = task.operation === "forward" ? "转发" : "复制";
        const cronDesc = formatCronExpression(task.cron_expression);
        
        listText += `<b>${index + 1}. 定时任务</b> ${status}\n`;
        listText += `📤 源: <code>${task.source_chat_id}</code>\n`;
        listText += `📥 目标: <code>${task.target_chat_id}</code>\n`;
        listText += `📨 消息: <code>${task.message_id}</code>\n`;
        listText += `🔄 操作: <code>${operationText}</code>\n`;
        listText += `⏰ 定时: <code>${task.cron_expression}</code> (${cronDesc})\n`;
        if (task.last_run) {
          listText += `🕐 上次运行: <code>${task.last_run}</code>\n`;
        }
        listText += "\n";
      });

      await msg.edit({
        text: listText.trim(),
        parseMode: "html"
      });
    }
    else if (subCommand === "rm") {
      if (args.length < 3) {
        await msg.edit({
          text: "❌ 请指定要删除的任务ID\n\n用法: <code>.fc rm [任务ID]</code>",
          parseMode: "html"
        });
        return;
      }

      const taskId = parseInt(args[2]);
      if (isNaN(taskId)) {
        await msg.edit({
          text: "❌ 任务ID必须是数字",
          parseMode: "html"
        });
        return;
      }

      const task = ForwardTasks.getTask(taskId);
      if (!task || task.chat_id !== chatId) {
        await msg.edit({
          text: "❌ 任务不存在或无权限删除",
          parseMode: "html"
        });
        return;
      }

      ForwardTasks.cancelJob(taskId);
      const success = ForwardTasks.removeTask(taskId);
      
      if (success) {
        await msg.edit({
          text: `✅ 任务 #${taskId} 已删除`,
          parseMode: "html"
        });
      } else {
        await msg.edit({
          text: "❌ 删除任务失败",
          parseMode: "html"
        });
      }
    }
    else if (subCommand === "pause") {
      if (args.length < 3) {
        await msg.edit({
          text: "❌ 请指定要暂停的任务ID\n\n用法: <code>.fc pause [任务ID]</code>",
          parseMode: "html"
        });
        return;
      }

      const taskId = parseInt(args[2]);
      if (isNaN(taskId)) {
        await msg.edit({
          text: "❌ 任务ID必须是数字",
          parseMode: "html"
        });
        return;
      }

      const task = ForwardTasks.getTask(taskId);
      if (!task || task.chat_id !== chatId) {
        await msg.edit({
          text: "❌ 任务不存在或无权限操作",
          parseMode: "html"
        });
        return;
      }

      if (task.is_paused) {
        await msg.edit({
          text: `ℹ️ 任务 #${taskId} 已经是暂停状态`,
          parseMode: "html"
        });
        return;
      }

      ForwardTasks.cancelJob(taskId);
      const success = ForwardTasks.pauseTask(taskId);
      
      if (success) {
        await msg.edit({
          text: `⏸️ 任务 #${taskId} 已暂停`,
          parseMode: "html"
        });
      } else {
        await msg.edit({
          text: "❌ 暂停任务失败",
          parseMode: "html"
        });
      }
    }
    else if (subCommand === "resume") {
      if (args.length < 3) {
        await msg.edit({
          text: "❌ 请指定要恢复的任务ID\n\n用法: <code>.fc resume [任务ID]</code>",
          parseMode: "html"
        });
        return;
      }

      const taskId = parseInt(args[2]);
      if (isNaN(taskId)) {
        await msg.edit({
          text: "❌ 任务ID必须是数字",
          parseMode: "html"
        });
        return;
      }

      const task = ForwardTasks.getTask(taskId);
      if (!task || task.chat_id !== chatId) {
        await msg.edit({
          text: "❌ 任务不存在或无权限操作",
          parseMode: "html"
        });
        return;
      }

      if (!task.is_paused) {
        await msg.edit({
          text: `ℹ️ 任务 #${taskId} 已经在运行中`,
          parseMode: "html"
        });
        return;
      }

      const success = ForwardTasks.resumeTask(taskId);
      
      if (success) {
        const updatedTask = ForwardTasks.getTask(taskId);
        if (updatedTask) {
          ForwardTasks.registerJob(updatedTask, client);
        }
        
        await msg.edit({
          text: `▶️ 任务 #${taskId} 已恢复运行`,
          parseMode: "html"
        });
      } else {
        await msg.edit({
          text: "❌ 恢复任务失败",
          parseMode: "html"
        });
      }
    }
    else if (subCommand === "help") {
      // 显示帮助信息 (与主帮助相同)
      const helpText = `
<b>📋 定时转发/复制 - Forward Cron</b>

<b>🔧 命令列表:</b>
<code>fc add [源聊天] [目标聊天] [消息ID] [操作] [cron表达式]</code> - 添加定时任务
<code>fc list</code> - 查看所有任务
<code>fc rm [任务ID]</code> - 删除任务
<code>fc pause [任务ID]</code> - 暂停任务
<code>fc resume [任务ID]</code> - 恢复任务
<code>fc help</code> - 显示帮助

<b>📝 参数说明:</b>
• <b>源聊天:</b> 消息来源聊天ID/@用户名/群组名
• <b>目标聊天:</b> 转发目标聊天ID/@用户名/群组名 (可用 "here" 表示当前聊天)
• <b>消息ID:</b> 要转发/复制的消息ID
• <b>操作:</b> forward(转发) 或 copy(复制)
• <b>cron表达式:</b> 定时规则 (秒 分 时 日 月 周)

<b>⏰ 常用cron表达式:</b>
<code>0 0 9 * * *</code> - 每天上午9点
<code>0 0 12 * * *</code> - 每天中午12点
<code>0 0 18 * * 5</code> - 每周五下午6点
<code>0 */30 * * * *</code> - 每30分钟
<code>0 0 0 1 * *</code> - 每月1号午夜

<b>💡 使用示例:</b>
<code>fc add @channel here 123 forward "0 0 9 * * *"</code>
<code>fc add -1001234567890 @target_group 456 copy "0 0 12 * * 1"</code>
      `;
      
      await msg.edit({
        text: helpText.trim(),
        parseMode: "html"
      });
    }
    else {
      await msg.edit({
        text: "❌ 未知的子命令\n\n使用 <code>.fc</code> 查看帮助",
        parseMode: "html"
      });
    }
  },
};

// 插件初始化 - 在插件加载时重新加载所有定时任务
(async () => {
  const client = await getGlobalClient();
  if (client) {
    ForwardTasks.reloadAllJobs(client);
    console.log("[FORWARD_CRON] 插件初始化完成");
  }
})();

export default forwardCronPlugin;

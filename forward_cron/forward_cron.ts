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
    // 获取当前用户的任务数量，确定新任务ID
    const existingTasks = this.getAllTasks(chatId);
    const newTaskId = existingTasks.length + 1;
    
    const stmt = db.prepare(`
      INSERT INTO forward_tasks (task_id, chat_id, source_chat_id, target_chat_id, message_id, operation, cron_expression)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(newTaskId, chatId, sourceChatId, targetChatId, messageId, operation, cronExpression);
    
    // 更新自增序列
    db.exec(`UPDATE sqlite_sequence SET seq = ${newTaskId} WHERE name = 'forward_tasks'`);
    
    return newTaskId;
  }

  // 获取所有任务
  static getAllTasks(chatId?: string): ForwardTask[] {
    if (chatId) {
      const stmt = db.prepare("SELECT * FROM forward_tasks WHERE chat_id = ? ORDER BY task_id");
      return stmt.all(chatId) as ForwardTask[];
    } else {
      // 全局查看所有任务
      const stmt = db.prepare("SELECT * FROM forward_tasks ORDER BY chat_id, task_id");
      return stmt.all() as ForwardTask[];
    }
  }

  // 重新排序任务ID
  static reorderTaskIds(chatId: string): void {
    // 获取当前用户的所有任务，按创建时间排序
    const tasks = db.prepare("SELECT * FROM forward_tasks WHERE chat_id = ? ORDER BY created_at, task_id").all(chatId) as ForwardTask[];
    
    if (tasks.length === 0) {
      // 如果没有任务，重置该用户的自增序列为0
      db.exec(`DELETE FROM sqlite_sequence WHERE name = 'forward_tasks'`);
      db.exec(`INSERT INTO sqlite_sequence (name, seq) VALUES ('forward_tasks', 0)`);
      return;
    }

    // 开始事务
    db.transaction(() => {
      // 临时表存储重排序的数据
      db.exec("CREATE TEMP TABLE temp_reorder AS SELECT * FROM forward_tasks WHERE 1=0");
      
      // 按新的顺序插入数据
      const insertStmt = db.prepare(`
        INSERT INTO temp_reorder (task_id, chat_id, source_chat_id, target_chat_id, message_id, operation, cron_expression, is_paused, created_at, last_run, next_run)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      tasks.forEach((task, index) => {
        const newTaskId = index + 1;
        insertStmt.run(
          newTaskId,
          task.chat_id,
          task.source_chat_id,
          task.target_chat_id,
          task.message_id,
          task.operation,
          task.cron_expression,
          task.is_paused,
          task.created_at,
          task.last_run,
          task.next_run
        );
      });
      
      // 删除原数据
      db.prepare("DELETE FROM forward_tasks WHERE chat_id = ?").run(chatId);
      
      // 从临时表复制回主表
      db.exec(`
        INSERT INTO forward_tasks SELECT * FROM temp_reorder
      `);
      
      // 清理临时表
      db.exec("DROP TABLE temp_reorder");
      
      // 更新自增序列为当前最大ID
      const maxId = tasks.length;
      db.exec(`DELETE FROM sqlite_sequence WHERE name = 'forward_tasks'`);
      db.exec(`INSERT INTO sqlite_sequence (name, seq) VALUES ('forward_tasks', ${maxId})`);
    })();
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

  // 删除任务后重新排序
  static removeTaskAndReorder(taskId: number, chatId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    
    const success = this.removeTask(taskId);
    if (success) {
      this.reorderTaskIds(chatId);
    }
    return success;
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
        // 获取最新的任务信息（防止重排序后ID变化）
        const currentTask = this.getTask(task.task_id);
        if (currentTask) {
          await ForwardTasks.forwardMessageJob(currentTask, bot);
        }
      });

      if (job) {
        this.jobs.set(task.task_id, job);
        console.log(`[FORWARD_CRON] 注册定时任务: ${task.task_id}, cron: ${task.cron_expression}`);
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

  // 重新加载指定聊天的所有任务（重排序后需要）
  static reloadChatJobs(chatId: string, bot: TelegramClient | undefined): void {
    // 取消该聊天的所有现有任务
    const tasks = this.getAllTasks(chatId);
    tasks.forEach(task => {
      this.cancelJob(task.task_id);
    });

    // 重新注册该聊天的所有未暂停任务
    tasks.forEach(task => {
      if (!task.is_paused) {
        this.registerJob(task, bot);
      }
    });

    console.log(`[FORWARD_CRON] 重新加载聊天 ${chatId} 的 ${tasks.filter(t => !t.is_paused).length} 个定时任务`);
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
<code>.fc add [源聊天] [目标聊天] [消息ID] [操作] [cron表达式]</code> - 添加到当前聊天
<code>.fc add [目标聊天ID] [源聊天] [目标聊天] [消息ID] [操作] [cron表达式]</code> - 全局添加
<code>.fc list</code> - 查看当前聊天任务
<code>.fc list all</code> - 查看所有聊天任务
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
<code>.fc add @channel here 123 forward "0 0 9 * * *"</code> - 当前聊天添加
<code>.fc add -1001234567890 @source here 456 copy "0 0 12 * * 1"</code> - 全局添加
      `;
      
      await msg.edit({
        text: helpText.trim(),
        parseMode: "html"
      });
      return;
    }

    if (subCommand === "add") {
      // 检查是否有足够的参数
      if (args.length < 7) {
        await msg.edit({
          text: "❌ 参数不足\n\n用法: <code>.fc add [目标聊天] [源聊天] [目标聊天] [消息ID] [操作] [cron表达式]</code>\n或: <code>.fc add [源聊天] [目标聊天] [消息ID] [操作] [cron表达式]</code>",
          parseMode: "html"
        });
        return;
      }

      // 检查是否是全局添加模式 (第一个参数是目标聊天ID)
      let targetChatForTask: string;
      let sourceChatInput: string;
      let targetChatInput: string;
      let messageId: number;
      let operation: "forward" | "copy";
      let cronExpression: string;

      // 尝试解析为全局模式: fc add [目标聊天ID] [源聊天] [目标聊天] [消息ID] [操作] [cron表达式]
      if (args.length >= 8) {
        const potentialTargetChatId = args[2];
        // 如果第一个参数看起来像聊天ID，则认为是全局模式
        if (potentialTargetChatId.startsWith("-") || potentialTargetChatId.match(/^\d+$/)) {
          targetChatForTask = potentialTargetChatId;
          sourceChatInput = args[3];
          targetChatInput = args[4];
          messageId = parseInt(args[5]);
          operation = args[6] as "forward" | "copy";
          cronExpression = args.slice(7).join(" ").replace(/["""]/g, '"').replace(/^"|"$/g, '');
        } else {
          // 普通模式
          targetChatForTask = chatId;
          sourceChatInput = args[2];
          targetChatInput = args[3];
          messageId = parseInt(args[4]);
          operation = args[5] as "forward" | "copy";
          cronExpression = args.slice(6).join(" ").replace(/["""]/g, '"').replace(/^"|"$/g, '');
        }
      } else {
        // 普通模式
        targetChatForTask = chatId;
        sourceChatInput = args[2];
        targetChatInput = args[3];
        messageId = parseInt(args[4]);
        operation = args[5] as "forward" | "copy";
        cronExpression = args.slice(6).join(" ").replace(/["""]/g, '"').replace(/^"|"$/g, '');
      }

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

      const sourceChatId = parseChatId(sourceChatInput, targetChatForTask);
      const targetChatId = parseChatId(targetChatInput, targetChatForTask);

      try {
        const taskId = ForwardTasks.addTask(
          targetChatForTask,
          sourceChatId,
          targetChatId,
          messageId,
          operation,
          cronExpression
        );

        const task = ForwardTasks.getTask(taskId);
        if (task) {
          ForwardTasks.registerJob(task, client);
          
          const operationText = operation === "forward" ? "转发" : "复制";
          const cronDesc = formatCronExpression(cronExpression);
          const isGlobalAdd = targetChatForTask !== chatId;
          const modeText = isGlobalAdd ? "全局" : "";
          const chatInfo = isGlobalAdd ? `\n📍 目标聊天: <code>${targetChatForTask}</code>` : "";
          
          await msg.edit({
            text: `✅ ${modeText}定时${operationText}任务创建成功${chatInfo}\n\n` +
                  `📋 任务ID: <code>#${task.task_id}</code>\n` +
                  `📤 源聊天: <code>${sourceChatId}</code>\n` +
                  `📥 目标聊天: <code>${targetChatId}</code>\n` +
                  `📨 消息ID: <code>${messageId}</code>\n` +
                  `🔄 操作: <code>${operationText}</code>\n` +
                  `⏰ 定时: <code>${cronExpression}</code> (${cronDesc})`,
            parseMode: "html"
          });
        } else {
          await msg.edit({
            text: "❌ 任务创建失败，无法获取任务信息",
            parseMode: "html"
          });
        }
      } catch (error) {
        console.error("Error adding forward task:", error);
        await msg.edit({
          text: "❌ 创建任务失败，请检查参数是否正确",
          parseMode: "html"
        });
      }
    }
    else if (subCommand === "list") {
      // 检查是否要查看全局任务
      const isAll = args[2] === "all";
      
      if (!isAll) {
        // 先重新排序当前聊天的任务ID
        ForwardTasks.reorderTaskIds(chatId);
        
        // 重新加载该聊天的定时任务
        const client = await getGlobalClient();
        if (client) {
          ForwardTasks.reloadChatJobs(chatId, client);
        }
      }
      
      const tasks = isAll ? ForwardTasks.getAllTasks() : ForwardTasks.getAllTasks(chatId);
      if (tasks.length === 0) {
        await msg.edit({
          text: isAll ? "📋 暂无定时转发/复制任务" : "📋 暂无定时转发/复制任务",
          parseMode: "html"
        });
        return;
      }

      let listText = "<b>📋 定时转发/复制任务列表</b>\n\n";
      
      if (isAll) {
        // 按聊天分组显示
        const tasksByChat = new Map<string, ForwardTask[]>();
        tasks.forEach(task => {
          if (!tasksByChat.has(task.chat_id)) {
            tasksByChat.set(task.chat_id, []);
          }
          tasksByChat.get(task.chat_id)!.push(task);
        });

        tasksByChat.forEach((chatTasks, chatId) => {
          listText += `<b>💬 聊天: <code>${chatId}</code></b>\n`;
          chatTasks.forEach(task => {
            const status = task.is_paused ? "⏸️ 暂停" : "▶️ 运行中";
            const operationText = task.operation === "forward" ? "转发" : "复制";
            const cronDesc = formatCronExpression(task.cron_expression);
            
            listText += `  <b>任务 #${task.task_id}</b> ${status}\n`;
            listText += `  📤 源: <code>${task.source_chat_id}</code>\n`;
            listText += `  📥 目标: <code>${task.target_chat_id}</code>\n`;
            listText += `  📨 消息: <code>${task.message_id}</code>\n`;
            listText += `  🔄 操作: <code>${operationText}</code>\n`;
            listText += `  ⏰ 定时: <code>${task.cron_expression}</code> (${cronDesc})\n`;
            if (task.last_run) {
              listText += `  🕐 上次运行: <code>${task.last_run}</code>\n`;
            }
            listText += "\n";
          });
          listText += "\n";
        });
      } else {
        // 当前聊天的任务列表
        tasks.forEach((task, index) => {
          const status = task.is_paused ? "⏸️ 暂停" : "▶️ 运行中";
          const operationText = task.operation === "forward" ? "转发" : "复制";
          const cronDesc = formatCronExpression(task.cron_expression);
          
          listText += `<b>任务 #${task.task_id}</b> ${status}\n`;
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
      }

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
      if (isNaN(taskId) || taskId <= 0) {
        await msg.edit({ 
          text: "❌ 任务ID必须是正整数",
          parseMode: "html"
        });
        return;
      }
      
      const task = ForwardTasks.getTask(taskId);
      if (!task) {
        await msg.edit({ 
          text: "❌ 任务不存在，请使用 <code>fc list</code> 或 <code>fc list all</code> 查看有效的任务ID",
          parseMode: "html"
        });
        return;
      }
      
      ForwardTasks.cancelJob(taskId);
      const success = ForwardTasks.removeTaskAndReorder(taskId, task.chat_id);
      if (success) {
        // 重新加载该任务所属聊天的定时任务
        const client = await getGlobalClient();
        if (client) {
          ForwardTasks.reloadChatJobs(task.chat_id, client);
        }
        
        const chatInfo = task.chat_id !== chatId ? `\n📍 来源聊天: <code>${task.chat_id}</code>` : "";
        
        await msg.edit({
          text: `✅ 删除任务 #${taskId} 成功${chatInfo}\n任务ID已重新排序`,
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
      if (!task) {
        await msg.edit({ 
          text: "❌ 任务不存在，请使用 <code>fc list</code> 或 <code>fc list all</code> 查看有效的任务ID",
          parseMode: "html"
        });
        return;
      }
      
      if (task.is_paused) {
        const chatInfo = task.chat_id !== chatId ? `\n📍 来源聊天: <code>${task.chat_id}</code>` : "";
        await msg.edit({ 
          text: `⏸️ 任务 #${taskId} 已经处于暂停状态${chatInfo}`,
          parseMode: "html"
        });
        return;
      }
      
      const success = ForwardTasks.pauseTask(taskId);
      if (success) {
        ForwardTasks.cancelJob(taskId);
        const chatInfo = task.chat_id !== chatId ? `\n📍 来源聊天: <code>${task.chat_id}</code>` : "";
        await msg.edit({
          text: `✅ 暂停任务 #${taskId} 成功${chatInfo}`,
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
          text: "❌ 请提供任务ID\n\n用法: <code>.fc resume [任务ID]</code>",
          parseMode: "html"
        });
        return;
      }

      const taskId = parseInt(args[2]);
      if (isNaN(taskId) || taskId <= 0) {
        await msg.edit({
          text: "❌ 任务ID必须是正整数",
          parseMode: "html"
        });
        return;
      }

      const task = ForwardTasks.getTask(taskId);
      if (!task) {
        await msg.edit({
          text: "❌ 任务不存在，请使用 <code>fc list</code> 或 <code>fc list all</code> 查看有效的任务ID",
          parseMode: "html"
        });
        return;
      }

      if (!task.is_paused) {
        const chatInfo = task.chat_id !== chatId ? `\n📍 来源聊天: <code>${task.chat_id}</code>` : "";
        await msg.edit({
          text: `ℹ️ 任务 #${taskId} 已经在运行中${chatInfo}`,
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
        
        const chatInfo = task.chat_id !== chatId ? `\n📍 来源聊天: <code>${task.chat_id}</code>` : "";
        
        await msg.edit({
          text: `▶️ 恢复任务 #${taskId} 成功${chatInfo}`,
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
      let helpText = `<b>📋 定时转发/复制</b>

<b>🔧 命令列表:</b>
• <code>fc add [源聊天] [目标聊天] [消息ID] [操作] [cron表达式]</code> - 添加到当前聊天
• <code>fc add [目标聊天ID] [源聊天] [目标聊天] [消息ID] [操作] [cron表达式]</code> - 全局添加
• <code>fc list</code> - 查看当前聊天任务
• <code>fc list all</code> - 查看所有聊天任务
• <code>fc rm [任务ID]</code> - 删除任务
• <code>fc pause [任务ID]</code> - 暂停任务
• <code>fc resume [任务ID]</code> - 恢复任务
• <code>fc help</code> - 显示帮助

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
<code>fc add @channel here 123 forward "0 0 9 * * *"</code> - 当前聊天添加
<code>fc add -1001234567890 @source here 456 copy "0 0 12 * * 1"</code> - 全局添加`;
      
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

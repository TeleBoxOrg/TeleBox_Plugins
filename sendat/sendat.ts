// plugins/sendat.ts
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { cronManager } from "@utils/cronManager";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";
import * as fs from "fs";

// HTML转义函数（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 任务接口
interface SendTaskData {
  task_id: number;
  cid: number;
  msg: string;
  interval: boolean;
  cron: boolean;
  pause: boolean;
  time_limit: number;
  hour: string;
  minute: string;
  second: string;
  current_count?: number;
}

class SendTask {
  task_id: number;
  cid: number;
  msg: string;
  interval: boolean;
  cron: boolean;
  pause: boolean;
  time_limit: number;
  hour: string;
  minute: string;
  second: string;
  current_count: number;

  constructor(data: SendTaskData) {
    this.task_id = data.task_id;
    this.cid = data.cid;
    this.msg = data.msg;
    this.interval = data.interval;
    this.cron = data.cron;
    this.pause = data.pause;
    this.time_limit = data.time_limit;
    this.hour = data.hour;
    this.minute = data.minute;
    this.second = data.second;
    this.current_count = data.current_count || 0;
  }

  export(): SendTaskData {
    return {
      task_id: this.task_id,
      cid: this.cid,
      msg: this.msg,
      interval: this.interval,
      cron: this.cron,
      pause: this.pause,
      time_limit: this.time_limit,
      hour: this.hour,
      minute: this.minute,
      second: this.second,
      current_count: this.current_count
    };
  }

  // 减少时间限制计数
  reduceTime(): boolean {
    if (this.time_limit > 0) {
      this.time_limit -= 1;
      return this.time_limit === 0;
    }
    return false;
  }

  // 检查时间值有效性
  static checkTime(time: string, minValue?: number, maxValue?: number): string {
    const timeNum = parseInt(time);
    if (isNaN(timeNum)) {
      throw new Error(`时间值 ${time} 不是有效数字`);
    }
    if (maxValue !== undefined && timeNum > maxValue) {
      throw new Error(`时间值 ${time} 过大`);
    }
    if (minValue !== undefined && timeNum < minValue) {
      throw new Error(`时间值 ${time} 过小`);
    }
    if (timeNum < 0) {
      throw new Error(`时间值 ${time} 不能为负数`);
    }
    return time;
  }

  // 解析任务字符串
  parseTask(text: string): void {
    const parts = text.split("|");
    if (parts.length < 2) {
      throw new Error("任务格式错误，请使用 '时间 | 消息内容' 格式");
    }

    this.msg = parts.slice(1).join("|").trim();
    if (!this.msg) {
      throw new Error("消息内容不能为空");
    }

    const timePart = parts[0].trim();
    let hasEvery = false;
    let timeText = timePart;

    // 检查是否有 every 关键字
    if (timePart.toLowerCase().includes("every")) {
      hasEvery = true;
      this.interval = true;
      timeText = timePart.toLowerCase().replace("every", "").trim();
    }

    const timeComponents = timeText.split(/\s+/);
    if (timeComponents.length % 2 !== 0) {
      throw new Error("时间格式错误");
    }

    let hasDate = false;
    let hasTimeUnit = false;

    for (let i = 0; i < timeComponents.length; i += 2) {
      const value = timeComponents[i];
      const unit = timeComponents[i + 1].toLowerCase();

      switch (unit) {
        case "seconds":
          hasTimeUnit = true;
          this.second = SendTask.checkTime(value, 0, 59);
          break;
        case "minutes":
          hasTimeUnit = true;
          this.minute = SendTask.checkTime(value, 0, 59);
          break;
        case "hours":
          hasTimeUnit = true;
          this.hour = SendTask.checkTime(value, 0, 23);
          break;
        case "times":
          this.time_limit = parseInt(SendTask.checkTime(value, 1));
          break;
        case "date":
          hasDate = true;
          hasTimeUnit = true;
          this.cron = true;
          // 解析时间格式 HH:MM:SS
          const timeParts = value.split(":");
          if (timeParts.length !== 3) {
            throw new Error("时间格式应为 HH:MM:SS");
          }
          this.hour = SendTask.checkTime(timeParts[0], 0, 23);
          this.minute = SendTask.checkTime(timeParts[1], 0, 59);
          this.second = SendTask.checkTime(timeParts[2], 0, 59);
          break;
        default:
          throw new Error(`未知的时间单位: ${unit}`);
      }
    }

    if (!hasTimeUnit) {
      throw new Error("时间格式错误");
    }

    // 如果没有指定时间单位但有 every，则视为间隔任务
    if (!hasDate && hasEvery) {
      this.interval = true;
    }

    // 设置默认时间限制
    if (this.time_limit === -1 && this.interval) {
      this.time_limit = -1; // 无限循环
    }
  }

  // 获取任务描述
  getDescription(): string {
    let desc = `任务 #${this.task_id} - `;
    
    if (this.interval) {
      if (this.cron) {
        desc += `每天 ${this.hour.padStart(2, '0')}:${this.minute.padStart(2, '0')}:${this.second.padStart(2, '0')}`;
      } else {
        const parts = [];
        if (this.hour !== "0") parts.push(`${this.hour}小时`);
        if (this.minute !== "0") parts.push(`${this.minute}分钟`);
        if (this.second !== "0") parts.push(`${this.second}秒`);
        desc += `每${parts.join('')}`;
      }
    } else {
      desc += `指定时间 ${this.hour.padStart(2, '0')}:${this.minute.padStart(2, '0')}:${this.second.padStart(2, '0')}`;
    }

    if (this.time_limit > 0) {
      desc += `，执行 ${this.time_limit} 次`;
    } else if (this.time_limit === -1) {
      desc += `，无限执行`;
    }

    if (this.pause) {
      desc += ` [已暂停]`;
    }

    desc += `\n消息: ${this.msg.substring(0, 50)}${this.msg.length > 50 ? '...' : ''}`;
    
    return desc;
  }
}

class SendTaskManager {
  private tasks: SendTask[] = [];
  private db: any = null;
  private dbPath: string;

  constructor() {
    const assetsDir = createDirectoryInAssets("sendat");
    this.dbPath = path.join(assetsDir, "tasks.json");
    this.initDB();
  }

  private async initDB(): Promise<void> {
    this.db = await JSONFilePreset<{ tasks: SendTaskData[] }>(this.dbPath, { tasks: [] });
    this.tasks = this.db.data.tasks.map((data: SendTaskData) => new SendTask(data));
    this.registerAllTasks();
  }

  private async saveToDB(): Promise<void> {
    if (this.db) {
      this.db.data.tasks = this.tasks.map(task => task.export());
      await this.db.write();
    }
  }

  // 获取下一个任务ID
  getNextTaskId(): number {
    if (this.tasks.length === 0) return 1;
    return Math.max(...this.tasks.map(task => task.task_id)) + 1;
  }

  // 添加任务
  async addTask(task: SendTask): Promise<void> {
    this.tasks.push(task);
    await this.saveToDB();
    this.registerTask(task);
  }

  // 删除任务
  async removeTask(taskId: number): Promise<boolean> {
    const index = this.tasks.findIndex(task => task.task_id === taskId);
    if (index !== -1) {
      this.removeTaskFromCron(taskId);
      this.tasks.splice(index, 1);
      await this.saveToDB();
      return true;
    }
    return false;
  }

  // 获取任务
  getTask(taskId: number): SendTask | undefined {
    return this.tasks.find(task => task.task_id === taskId);
  }

  // 获取所有任务
  getAllTasks(): SendTask[] {
    return this.tasks;
  }

  // 获取用户的任务
  getUserTasks(chatId: number): SendTask[] {
    return this.tasks.filter(task => task.cid === chatId);
  }

  // 暂停任务
  async pauseTask(taskId: number): Promise<boolean> {
    const task = this.getTask(taskId);
    if (task && !task.pause) {
      task.pause = true;
      this.removeTaskFromCron(taskId);
      await this.saveToDB();
      return true;
    }
    return false;
  }

  // 恢复任务
  async resumeTask(taskId: number): Promise<boolean> {
    const task = this.getTask(taskId);
    if (task && task.pause) {
      task.pause = false;
      this.registerTask(task);
      await this.saveToDB();
      return true;
    }
    return false;
  }

  // 从cron管理器中移除任务
  private removeTaskFromCron(taskId: number): void {
    const taskName = `sendat_${taskId}`;
    if (cronManager.hasTask(taskName)) {
      cronManager.removeTask(taskName);
    }
  }

  // 注册单个任务到cron管理器
  private registerTask(task: SendTask): void {
    if (task.pause) return;

    const taskName = `sendat_${task.task_id}`;
    
    if (task.interval) {
      if (task.cron) {
        // 定时任务（每天固定时间）
        const cronExpression = `${task.second} ${task.minute} ${task.hour} * * *`;
        cronManager.addTask(taskName, {
          cron: cronExpression,
          description: `定时发送任务 #${task.task_id}`,
          handler: async () => {
            await this.executeTask(task);
          }
        });
      } else {
        // 间隔任务
        const intervalMs = 
          (parseInt(task.hour) * 3600 + 
           parseInt(task.minute) * 60 + 
           parseInt(task.second)) * 1000;
        
        if (intervalMs > 0) {
          // 使用cron表达式模拟间隔任务
          const seconds = parseInt(task.second);
          const minutes = parseInt(task.minute);
          const hours = parseInt(task.hour);
          
          let cronExpression = '';
          if (hours > 0) {
            cronExpression = `${seconds} ${minutes} */${hours} * * *`;
          } else if (minutes > 0) {
            cronExpression = `${seconds} */${minutes} * * * *`;
          } else {
            cronExpression = `*/${seconds} * * * * *`;
          }
          
          cronManager.addTask(taskName, {
            cron: cronExpression,
            description: `间隔发送任务 #${task.task_id}`,
            handler: async () => {
              await this.executeTask(task);
            }
          });
        }
      }
    } else {
      // 单次任务 - 使用cron表达式指定具体时间
      const now = new Date();
      const targetTime = new Date();
      targetTime.setHours(parseInt(task.hour), parseInt(task.minute), parseInt(task.second));
      
      if (targetTime <= now) {
        targetTime.setDate(targetTime.getDate() + 1);
      }
      
      const cronExpression = `${targetTime.getSeconds()} ${targetTime.getMinutes()} ${targetTime.getHours()} ${targetTime.getDate()} ${targetTime.getMonth() + 1} *`;
      
      cronManager.addTask(taskName, {
        cron: cronExpression,
        description: `单次发送任务 #${task.task_id}`,
        handler: async () => {
          await this.executeTask(task);
          // 单次任务执行后删除
          await this.removeTask(task.task_id);
        }
      });
    }
  }

  // 执行任务
  private async executeTask(task: SendTask): Promise<void> {
    try {
      const client = await getGlobalClient();
      if (!client) return;

      await client.sendMessage(task.cid, {
        message: task.msg,
        parseMode: "html"
      });

      task.current_count += 1;
      
      // 检查执行次数限制
      if (task.reduceTime()) {
        // 达到执行次数限制，删除任务
        await this.removeTask(task.task_id);
      } else {
        await this.saveToDB();
      }
    } catch (error) {
      console.error(`[sendat] 执行任务 ${task.task_id} 失败:`, error);
    }
  }

  // 注册所有任务
  private registerAllTasks(): void {
    this.tasks.forEach(task => {
      if (!task.pause) {
        this.registerTask(task);
      }
    });
  }
}

// 插件主类
class SendAtPlugin extends Plugin {
  private taskManager: SendTaskManager;
  private readonly helpText: string;

  constructor() {
    super();
    this.taskManager = new SendTaskManager();
    
    this.helpText = `⏰ <b>定时发送消息插件</b>

<b>使用方法：</b>
<code>.sendat 时间 | 消息内容</code> - 添加定时任务
<code>.sendat list</code> - 查看我的任务
<code>.sendat list all</code> - 查看所有任务（管理员）
<code>.sendat rm 任务ID</code> - 删除任务
<code>.sendat pause 任务ID</code> - 暂停任务
<code>.sendat resume 任务ID</code> - 恢复任务

<b>时间格式示例：</b>
• <code>.sendat 16:00:00 date | 投票截止！</code> - 每天16:00发送
• <code>.sendat every 23:59:59 date | 又是无所事事的一天呢。</code> - 每天23:59:59发送
• <code>.sendat every 1 minutes | 又过去了一分钟。</code> - 每分钟发送
• <code>.sendat 3 times 1 minutes | 此消息将出现三次。</code> - 每分钟发送，共3次

<b>支持的时间单位：</b>
seconds, minutes, hours, date, times`;
  }

  description = this.helpText;

  cmdHandlers = {
    sendat: async (msg: Api.Message) => {
      await this.handleSendAtCommand(msg);
    }
  };

  private async handleSendAtCommand(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;

    const text = msg.text || "";
    const parts = text.trim().split(/\s+/);
    const command = parts[0]?.replace(/^[.!。]/, "") || "";
    const subCommand = parts[1]?.toLowerCase();

    try {
      // 显示帮助
      if (!subCommand || subCommand === 'help' || subCommand === 'h') {
        await msg.edit({ text: this.helpText, parseMode: "html" });
        return;
      }

      // 列出任务
      if (subCommand === 'list') {
        await this.handleListTasks(msg, parts[2] === 'all');
        return;
      }

      // 删除任务
      if (subCommand === 'rm' || subCommand === 'delete') {
        await this.handleRemoveTask(msg, parts[2]);
        return;
      }

      // 暂停任务
      if (subCommand === 'pause') {
        await this.handlePauseTask(msg, parts[2]);
        return;
      }

      // 恢复任务
      if (subCommand === 'resume') {
        await this.handleResumeTask(msg, parts[2]);
        return;
      }

      // 添加新任务
      await this.handleAddTask(msg);

    } catch (error: any) {
      await msg.edit({
        text: `❌ <b>错误：</b>${htmlEscape(error.message)}`,
        parseMode: "html"
      });
    }
  }

  private async handleListTasks(msg: Api.Message, showAll: boolean): Promise<void> {
    const chatId = msg.chatId?.toJSNumber() || 0;
    let tasks: SendTask[];

    if (showAll) {
      // 检查管理员权限
      const sudoDB = (await import("@utils/sudoDB")).default;
      const sudoDBInstance = new sudoDB();
      const userId = msg.senderId?.toJSNumber();
      
      if (!userId || !sudoDBInstance.has(userId)) {
        await msg.edit({ text: "❌ 只有管理员可以查看所有任务", parseMode: "html" });
        return;
      }
      tasks = this.taskManager.getAllTasks();
    } else {
      tasks = this.taskManager.getUserTasks(chatId);
    }

    if (tasks.length === 0) {
      await msg.edit({ 
        text: showAll ? "📝 没有已注册的任务" : "📝 您没有已注册的任务",
        parseMode: "html" 
      });
      return;
    }

    let response = showAll ? "📋 <b>所有任务：</b>\n\n" : "📋 <b>我的任务：</b>\n\n";
    
    tasks.forEach(task => {
      response += `• ${task.getDescription()}\n\n`;
    });

    await msg.edit({ text: response, parseMode: "html" });
  }

  private async handleRemoveTask(msg: Api.Message, taskIdStr: string): Promise<void> {
    const taskId = parseInt(taskIdStr);
    if (isNaN(taskId)) {
      await msg.edit({ text: "❌ 请输入有效的任务ID", parseMode: "html" });
      return;
    }

    const task = this.taskManager.getTask(taskId);
    if (!task) {
      await msg.edit({ text: "❌ 任务不存在", parseMode: "html" });
      return;
    }

    // 权限检查：只能删除自己的任务或者是管理员
    const chatId = msg.chatId?.toJSNumber() || 0;
    const sudoDB = (await import("@utils/sudoDB")).default;
    const sudoDBInstance = new sudoDB();
    const userId = msg.senderId?.toJSNumber();

    if (task.cid !== chatId && (!userId || !sudoDBInstance.has(userId))) {
      await msg.edit({ text: "❌ 只能删除自己的任务", parseMode: "html" });
      return;
    }

    const success = await this.taskManager.removeTask(taskId);
    if (success) {
      await msg.edit({ text: `✅ 已删除任务 #${taskId}`, parseMode: "html" });
    } else {
      await msg.edit({ text: "❌ 删除任务失败", parseMode: "html" });
    }
  }

  private async handlePauseTask(msg: Api.Message, taskIdStr: string): Promise<void> {
    const taskId = parseInt(taskIdStr);
    if (isNaN(taskId)) {
      await msg.edit({ text: "❌ 请输入有效的任务ID", parseMode: "html" });
      return;
    }

    const success = await this.taskManager.pauseTask(taskId);
    if (success) {
      await msg.edit({ text: `⏸️ 已暂停任务 #${taskId}`, parseMode: "html" });
    } else {
      await msg.edit({ text: "❌ 暂停任务失败", parseMode: "html" });
    }
  }

  private async handleResumeTask(msg: Api.Message, taskIdStr: string): Promise<void> {
    const taskId = parseInt(taskIdStr);
    if (isNaN(taskId)) {
      await msg.edit({ text: "❌ 请输入有效的任务ID", parseMode: "html" });
      return;
    }

    const success = await this.taskManager.resumeTask(taskId);
    if (success) {
      await msg.edit({ text: `▶️ 已恢复任务 #${taskId}`, parseMode: "html" });
    } else {
      await msg.edit({ text: "❌ 恢复任务失败", parseMode: "html" });
    }
  }

  private async handleAddTask(msg: Api.Message): Promise<void> {
    const text = msg.text || "";
    const commandMatch = text.match(/^[.!。]sendat\s+(.+)/i);
    
    if (!commandMatch) {
      await msg.edit({ text: "❌ 命令格式错误", parseMode: "html" });
      return;
    }

    const taskContent = commandMatch[1].trim();
    const chatId = msg.chatId?.toJSNumber() || 0;

    const task = new SendTask({
      task_id: this.taskManager.getNextTaskId(),
      cid: chatId,
      msg: "",
      interval: false,
      cron: false,
      pause: false,
      time_limit: -1,
      hour: "0",
      minute: "0",
      second: "0"
    });

    try {
      task.parseTask(taskContent);
      await this.taskManager.addTask(task);
      
      await msg.edit({ 
        text: `✅ <b>已添加任务 #${task.task_id}</b>\n\n${task.getDescription()}`,
        parseMode: "html" 
      });
    } catch (error: any) {
      throw new Error(`添加任务失败: ${error.message}`);
    }
  }
}

export default new SendAtPlugin();

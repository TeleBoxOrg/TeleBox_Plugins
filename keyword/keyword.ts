import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getGlobalClient } from "@utils/globalClient";
import { TelegramClient } from "teleproto";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import path from "path";
import Database from "better-sqlite3";
import {
  dealCommandPluginWithMessage,
  getCommandFromMessage,
} from "@utils/pluginManager";

interface KeywordTaskData {
  task_id?: number;
  cid: number;
  key: string;
  msg: string;
  include: boolean;
  regexp: boolean;
  exact: boolean;
  case: boolean;
  ignore_forward: boolean;
  reply: boolean;
  delete: boolean;
  ban: number;
  restrict: number;
  delay_delete: number;
  source_delay_delete: number;
}

class KeywordTask {
  task_id?: number;
  cid: number;
  key: string;
  msg: string;
  include: boolean;
  regexp: boolean;
  exact: boolean;
  case: boolean;
  ignore_forward: boolean;
  reply: boolean;
  delete: boolean;
  ban: number;
  restrict: number;
  delay_delete: number;
  source_delay_delete: number;

  constructor(data: KeywordTaskData) {
    this.task_id = data.task_id;
    this.cid = data.cid;
    this.key = data.key;
    this.msg = data.msg;
    this.include = data.include ?? true;
    this.regexp = data.regexp ?? false;
    this.exact = data.exact ?? false;
    this.case = data.case ?? false;
    this.ignore_forward = data.ignore_forward ?? false;
    this.reply = data.reply ?? true;
    this.delete = data.delete ?? false;
    this.ban = data.ban ?? 0;
    this.restrict = data.restrict ?? 0;
    this.delay_delete = data.delay_delete ?? 0;
    this.source_delay_delete = data.source_delay_delete ?? 0;
  }

  export(): KeywordTaskData {
    return {
      task_id: this.task_id,
      cid: this.cid,
      key: this.key,
      msg: this.msg,
      include: this.include,
      regexp: this.regexp,
      exact: this.exact,
      case: this.case,
      ignore_forward: this.ignore_forward,
      reply: this.reply,
      delete: this.delete,
      ban: this.ban,
      restrict: this.restrict,
      delay_delete: this.delay_delete,
      source_delay_delete: this.source_delay_delete,
    };
  }

  exportStr(showAll: boolean = false): string {
    let text = `${codeTag(this.task_id ?? "")}`;
    text += ` - ${codeTag(this.key)} - `;
    if (showAll) {
      text += `${codeTag(this.cid)} - `;
    }
    text += `${htmlEscape(this.msg)}`;
    return text;
  }

  checkNeedReply(message: Api.Message): boolean {
    const text =
      message.message ||
      (message.media && "caption" in message.media
        ? String(message.media.caption || "")
        : "");
    if (!text) return false;

    if (this.ignore_forward && message.fwdFrom) {
      return false;
    }

    let messageText = text;
    let key = this.key;

    if (this.regexp) {
      try {
        const regex = new RegExp(key, this.case ? "g" : "gi");
        return regex.test(messageText);
      } catch {
        return false;
      }
    }

    if (!this.case) {
      messageText = messageText.toLowerCase();
      key = key.toLowerCase();
    }

    if (this.include && messageText.includes(key)) {
      return true;
    }

    return this.exact && messageText === key;
  }

  replaceReply(message: Api.Message): string {
    let text = this.msg;

    if (message.fromId && "userId" in message.fromId) {
      const userId = Number(message.fromId.userId);
      const sender = message.sender as any;
      const firstName = sender?.firstName || sender?.first_name || "User";
      text = text.replace(
        "$mention",
        `<a href="tg://user?id=${userId}">${htmlEscape(firstName)}</a>`
      );
      text = text.replace("$code_id", String(userId));
      text = text.replace("$code_name", htmlEscape(firstName));
    } else {
      text = text.replace("$mention", "");
      text = text.replace("$code_id", "");
      text = text.replace("$code_name", "");
    }

    if (this.delay_delete) {
      text = text.replace("$delay_delete", String(this.delay_delete));
    } else {
      text = text.replace("$delay_delete", "");
    }

    return text;
  }

  async processKeyword(message: Api.Message): Promise<void> {
    try {
      const text = this.replaceReply(message);
      const client = await getGlobalClient();

      let sentMsg: Api.Message | null = null;
      try {
        const sendOptions: any = {
          message: text,
          parseMode: "html",
        };

        if (this.reply && message.id) {
          sendOptions.replyTo = message.id;
        }

        sentMsg = await client.sendMessage(message.peerId, sendOptions);

        const cmd = await getCommandFromMessage(text);

        if (cmd && sentMsg)
          await dealCommandPluginWithMessage({ cmd, msg: sentMsg });
      } catch (error) {
        console.error("Reply message error:", error);
      }

      if (this.delete) {
        try {
          if (this.source_delay_delete > 0) {
            setTimeout(async () => {
              try {
                await client.deleteMessages(message.peerId, [message.id], {
                  revoke: true,
                });
              } catch (error) {
                console.error("Delayed delete message error:", error);
              }
            }, this.source_delay_delete * 1000);
          } else {
            await client.deleteMessages(message.peerId, [message.id], {
              revoke: true,
            });
          }
        } catch (error) {
          console.error("Delete message error:", error);
        }
      }

      if (this.delay_delete > 0 && sentMsg) {
        setTimeout(async () => {
          try {
            await client.deleteMessages(message.peerId, [sentMsg!.id], {
              revoke: true,
            });
          } catch (error) {
            console.error("Delayed delete reply error:", error);
          }
        }, this.delay_delete * 1000);
      }
    } catch (error) {
      console.error("Process keyword error:", error);
    }
  }

  parseTask(text: string): void {
    const data = text.split("\n+++\n");
    if (data.length < 2) {
      throw new Error("任务格式无效");
    }

    for (const part of data) {
      if (part === "") {
        throw new Error("任务格式无效");
      }
    }

    this.key = data[0];
    this.msg = data[1];

    if (data.length > 2) {
      const options = data[2].split(" ");
      for (const option of options) {
        if (option.startsWith("include")) {
          this.include = true;
        } else if (option.startsWith("exact")) {
          this.include = false;
          this.exact = true;
        } else if (option.startsWith("regexp")) {
          this.regexp = true;
        } else if (option.startsWith("case")) {
          this.case = true;
        } else if (option.startsWith("ignore_forward")) {
          this.ignore_forward = true;
        } else if (option.trim() !== "") {
          throw new Error("任务格式无效");
        }
      }

      if (this.include && this.exact) {
        throw new Error("不能同时设置include和exact选项");
      }
    }

    if (data.length > 3) {
      const actions = data[3].split(" ");
      for (const action of actions) {
        if (action.startsWith("reply")) {
          this.reply = true;
        } else if (action.startsWith("delete")) {
          this.delete = true;
        } else if (action.startsWith("ban")) {
          this.ban = parseInt(action.replace("ban", "")) || 0;
        } else if (action.startsWith("restrict")) {
          this.restrict = parseInt(action.replace("restrict", "")) || 0;
        } else if (action.trim() !== "") {
          throw new Error("任务格式无效");
        }
      }
    }

    if (data.length > 4) {
      this.delay_delete = parseInt(data[4]) || 0;
    }

    if (data.length > 5) {
      this.source_delay_delete = parseInt(data[5]) || 0;
    }

    if (
      this.ban < 0 ||
      this.restrict < 0 ||
      this.delay_delete < 0 ||
      this.source_delay_delete < 0
    ) {
      throw new Error("时间参数不能为负数");
    }
  }
}

let db = new Database(
  path.join(createDirectoryInAssets("keyword"), "keyword.db")
);
if (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS keyword_tasks (
      task_id INTEGER PRIMARY KEY,
      cid INTEGER NOT NULL,
      key TEXT NOT NULL,
      msg TEXT NOT NULL,
      include INTEGER DEFAULT 1,
      regexp INTEGER DEFAULT 0,
      exact INTEGER DEFAULT 0,
      case_sensitive INTEGER DEFAULT 0,
      ignore_forward INTEGER DEFAULT 0,
      reply INTEGER DEFAULT 1,
      delete_msg INTEGER DEFAULT 0,
      ban INTEGER DEFAULT 0,
      restrict INTEGER DEFAULT 0,
      delay_delete INTEGER DEFAULT 0,
      source_delay_delete INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS keyword_alias (
      from_cid INTEGER PRIMARY KEY,
      to_cid INTEGER NOT NULL
    )
  `);
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function codeTag(text: string | number): string {
  return `<code>${htmlEscape(String(text))}</code>`;
}

class KeywordAlias {
  add(fromCid: number, toCid: number): void {
    if (!db) return;
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO keyword_alias (from_cid, to_cid)
      VALUES (?, ?)
    `);
    stmt.run(fromCid, toCid);
  }

  remove(fromCid: number): void {
    if (!db) return;
    const stmt = db.prepare("DELETE FROM keyword_alias WHERE from_cid = ?");
    stmt.run(fromCid);
  }

  get(fromCid: number): number | undefined {
    if (!db) return undefined;
    const stmt = db.prepare(
      "SELECT to_cid FROM keyword_alias WHERE from_cid = ?"
    );
    const row = stmt.get(fromCid) as any;
    return row ? row.to_cid : undefined;
  }
}

class KeywordTasks {
  private tasks: KeywordTask[] = [];

  constructor() {
    this.loadFromDB();
  }

  add(task: KeywordTask): void {
    if (!this.tasks.some((t) => t.task_id === task.task_id)) {
      this.tasks.push(task);
    }
  }

  remove(taskId: number): boolean {
    const taskIndex = this.tasks.findIndex((t) => t.task_id === taskId);
    if (taskIndex !== -1) {
      this.tasks.splice(taskIndex, 1);
      return true;
    }
    return false;
  }

  removeByIds(taskIds: number[]): { success: number; failed: number } {
    let success = 0;
    let failed = 0;

    for (const taskId of taskIds) {
      if (this.remove(taskId)) {
        success++;
      } else {
        failed++;
      }
    }

    return { success, failed };
  }

  get(taskId: number): KeywordTask | undefined {
    return this.tasks.find((task) => task.task_id === taskId);
  }

  getAll(): KeywordTask[] {
    return this.tasks;
  }

  getAllIds(): number[] {
    return this.tasks.map((task) => task.task_id!);
  }

  printAllTasks(showAll: boolean = false, cid: number = 0): string {
    const tasksToShow = showAll
      ? this.tasks
      : this.tasks.filter((task) => task.cid === cid);

    if (tasksToShow.length === 0) {
      return showAll
        ? "ℹ️ 当前没有任何关键词任务"
        : "ℹ️ 当前聊天没有任何关键词任务";
    }

    return tasksToShow.map((task) => task.exportStr(showAll)).join("\n");
  }

  saveToDB(): void {
    if (!db) return;

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO keyword_tasks (
        task_id, cid, key, msg, include, regexp, exact, case_sensitive,
        ignore_forward, reply, delete_msg, ban, restrict, delay_delete, source_delay_delete
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deleteStmt = db.prepare("DELETE FROM keyword_tasks");
    deleteStmt.run();

    for (const task of this.tasks) {
      stmt.run(
        task.task_id,
        task.cid,
        task.key,
        task.msg,
        task.include ? 1 : 0,
        task.regexp ? 1 : 0,
        task.exact ? 1 : 0,
        task.case ? 1 : 0,
        task.ignore_forward ? 1 : 0,
        task.reply ? 1 : 0,
        task.delete ? 1 : 0,
        task.ban,
        task.restrict,
        task.delay_delete,
        task.source_delay_delete
      );
    }
  }

  loadFromDB(): void {
    if (!db) return;

    const stmt = db.prepare("SELECT * FROM keyword_tasks");
    const rows = stmt.all() as any[];

    this.tasks = rows.map(
      (row) =>
        new KeywordTask({
          task_id: row.task_id,
          cid: row.cid,
          key: row.key,
          msg: row.msg,
          include: row.include === 1,
          regexp: row.regexp === 1,
          exact: row.exact === 1,
          case: row.case_sensitive === 1,
          ignore_forward: row.ignore_forward === 1,
          reply: row.reply === 1,
          delete: row.delete_msg === 1,
          ban: row.ban,
          restrict: row.restrict,
          delay_delete: row.delay_delete,
          source_delay_delete: row.source_delay_delete,
        })
    );
  }

  getNextTaskId(): number {
    return this.tasks.length > 0
      ? Math.max(...this.tasks.map((t) => t.task_id!)) + 1
      : 1;
  }

  getTasksForChat(cid: number): KeywordTask[] {
    return this.tasks.filter((task) => task.cid === cid);
  }

  async checkAndReply(message: Api.Message): Promise<void> {
    try {
      const chatId = getChatId(message);
      if (!chatId || chatId === 0) return;

      const aliasId = keywordAlias.get(chatId);
      if (aliasId) {
        const aliasTasks = this.getTasksForChat(aliasId);
        for (const task of aliasTasks) {
          if (task.checkNeedReply(message)) {
            await task.processKeyword(message);
          }
        }
      }

      const tasks = this.getTasksForChat(chatId);
      for (const task of tasks) {
        if (task.checkNeedReply(message)) {
          await task.processKeyword(message);
        }
      }
    } catch (error) {
      console.error("Check and reply error:", error);
    }
  }
}

function toNumber(value: any): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return parseInt(value, 10) || 0;
  return 0;
}

function getChatId(msg: Api.Message): number {
  try {
    if (msg.chat?.id) {
      return Number(msg.chat.id);
    } else if (msg.peerId) {
      return Number(msg.peerId.toString());
    } else if (msg.chatId) {
      return Number(msg.chatId.toString());
    } else {
      return 0;
    }
  } catch (error) {
    console.error("Get chat ID error:", error);
    return 0;
  }
}

const keywordAlias = new KeywordAlias();
const keywordTasks = new KeywordTasks();

function parseTaskIds(idsStr: string): number[] {
  const idList = idsStr.split(",");
  const result: number[] = [];

  for (const id of idList) {
    const num = parseInt(id.trim());
    if (isNaN(num)) {
      throw new Error("请输入正确的参数");
    }
    result.push(num);
  }

  return result;
}

const keyword = async (msg: Api.Message) => {
  try {
    const messageText = msg.message || "";
    const args = messageText.split(" ").slice(1) || [];
    const spaceIndex = messageText.indexOf(" ");
    const fullArgs =
      spaceIndex !== -1 ? messageText.substring(spaceIndex + 1) : "";

    if (args.length === 0 || args[0] === "h" || args[0] === "help") {
      const helpText = `🔧 <b>关键词回复插件 - 完整使用指南</b>

<b>📋 基础命令：</b>
<code>keyword list</code> - 查看当前群组的关键词任务
<code>keyword list all</code> - 查看所有群组的关键词任务
<code>keyword rm 1,2,3</code> - 删除指定ID的任务
<code>keyword alias</code> - 查看当前群组继承设置
<code>keyword alias 123456</code> - 设置继承其他群组的关键词
<code>keyword alias rm</code> - 删除继承设置


<b>📝 添加关键词任务格式：</b>
<code>keyword 关键词内容
+++
回复消息内容
+++
匹配选项
+++
执行动作
+++
延迟删除秒数
+++
原消息延迟删除秒数</code>

<b>🎯 匹配选项（第3段，空格分隔）：</b>
• <code>include</code> - 包含匹配（默认）
• <code>exact</code> - 精确匹配
• <code>regexp</code> - 正则表达式匹配
• <code>case</code> - 区分大小写
• <code>ignore_forward</code> - 忽略转发消息

<b>⚡ 执行动作（第4段，空格分隔）：</b>
• <code>reply</code> - 回复消息（默认）
• <code>delete</code> - 删除触发消息
• <code>ban300</code> - 封禁用户300秒
• <code>restrict600</code> - 限制用户600秒

<b>🔤 消息变量：</b>
• <code>$mention</code> - @提及用户
• <code>$code_id</code> - 用户ID
• <code>$code_name</code> - 用户姓名
• <code>$delay_delete</code> - 延迟删除时间

<b>📖 使用示例：</b>

<b>1. 简单关键词回复：</b>
<code>keyword 你好
+++
欢迎！$mention</code>

<b>2. 精确匹配+删除原消息：</b>
<code>keyword 违规词汇
+++
⚠️ 请注意言辞！
+++
exact case
+++
reply delete</code>

<b>3. 正则表达式+延迟删除：</b>
<code>keyword \\d{11}
+++
🚫 请勿发送手机号码
+++
regexp
+++
reply delete
+++
10
+++
0</code>

<b>4. 封禁用户：</b>
<code>keyword 广告
+++
🚫 检测到广告，用户已被封禁
+++
include
+++
reply delete ban3600</code>

<b>💡 高级功能：</b>
• <b>继承机制：</b>可以让当前群组继承其他群组的关键词设置
• <b>延迟删除：</b>支持定时删除回复消息和原消息
• <b>批量管理：</b>支持批量删除多个任务
• <b>灵活匹配：</b>支持包含、精确、正则三种匹配模式

<b>⚠️ 注意事项：</b>
• 封禁和限制功能需要机器人有管理员权限
• 正则表达式需要转义特殊字符（如 \\\\d）
• 继承功能会同时检查当前群组和继承群组的关键词
• 任务ID在删除后不会重复使用

<b>🔗 更多信息：</b>
如需更多帮助，请参考 TeleBox 官方文档或联系管理员。`;

      await msg.edit({
        text: helpText,
        parseMode: "html",
      });
      return;
    }

    if (args.length === 1) {
      if (args[0] === "list") {
        const chatId = getChatId(msg);
        const taskList = keywordTasks.printAllTasks(false, chatId);
        await msg.edit({
          text: `<b>当前聊天的关键词任务：</b>\n\n${taskList}`,
          parseMode: "html",
        });
        return;
      } else if (args[0] === "alias") {
        const chatId = getChatId(msg) || 0;
        const aliasId = keywordAlias.get(chatId);
        if (aliasId) {
          await msg.edit({
            text: `🔗 当前群组继承自：<code>${aliasId}</code>`,
            parseMode: "html",
          });
        } else {
          await msg.edit({
            text: "ℹ️ 当前群组没有继承设置",
          });
        }
        return;
      }
    }

    if (args.length === 2) {
      if (args[0] === "rm") {
        try {
          const idList = parseTaskIds(args[1]);
          const result = keywordTasks.removeByIds(idList);
          keywordTasks.saveToDB();
          await msg.edit({
            text: `✅ 已删除任务成功 <code>${result.success}</code> 个，失败 <code>${result.failed}</code> 个。`,
            parseMode: "html",
          });
        } catch (error: any) {
          await msg.edit({
            text: `❌ <b>参数错误:</b> ${htmlEscape(error.message || error)}`,
            parseMode: "html",
          });
        }
        return;
      } else if (args[0] === "list" && args[1] === "all") {
        const taskList = keywordTasks.printAllTasks(true);
        await msg.edit({
          text: `<b>所有关键词任务：</b>\n\n${taskList}`,
          parseMode: "html",
        });
        return;
      } else if (args[0] === "alias") {
        const chatId = getChatId(msg) || 0;
        if (args[1] === "rm") {
          if (!keywordAlias.get(chatId)) {
            await msg.edit({
              text: "ℹ️ 当前群组没有继承设置",
            });
            return;
          }
          keywordAlias.remove(chatId);
          await msg.edit({
            text: "✅ 已删除继承设置",
          });
        } else {
          try {
            const cid = parseInt(args[1]);
            keywordAlias.add(chatId, cid);
            await msg.edit({
              text: `✅ 已添加继承：<code>${cid}</code>`,
              parseMode: "html",
            });
          } catch (error: any) {
            await msg.edit({
              text: `❌ <b>参数错误:</b> ${htmlEscape(
                error.message || "请输入正确的参数"
              )}`,
              parseMode: "html",
            });
          }
        }
        return;
      }
    }

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

    if (!chatId || chatId === 0) {
      await msg.edit({ text: "❌ 无法获取聊天ID，请重试。" });
      return;
    }

    const task = new KeywordTask({
      task_id: keywordTasks.getNextTaskId(),
      cid: chatId,
      key: "",
      msg: "",
      include: true,
      regexp: false,
      exact: false,
      case: false,
      ignore_forward: false,
      reply: true,
      delete: false,
      ban: 0,
      restrict: 0,
      delay_delete: 0,
      source_delay_delete: 0,
    });

    try {
      task.parseTask(fullArgs);
      keywordTasks.add(task);
      keywordTasks.saveToDB();
      await msg.edit({
        text: `✅ 已添加关键词任务，ID 为 <code>${task.task_id}</code>。`,
        parseMode: "html",
      });
    } catch (error: any) {
      await msg.edit({
        text: `❌ <b>参数错误:</b> ${htmlEscape(error.message || error)}`,
        parseMode: "html",
      });
    }
  } catch (error: any) {
    console.error("Keyword plugin error:", error);
    await msg.edit({
      text: `❌ 操作失败：${error.message || error}`,
    });
  }
};

class KeywordPlugin extends Plugin {
  cleanup(): void {
  }

  description: string = `关键词回复管理`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    keyword,
  };
  listenMessageHandler?: ((msg: Api.Message) => Promise<void>) | undefined =
    async (message) => {
      try {
        const text =
          message.message ||
          (message.media && "caption" in message.media
            ? String(message.media.caption || "")
            : "");
        if (!text) {
          return;
        }

        if (message.out) {
          return;
        }

        await keywordTasks.checkAndReply(message);
      } catch (error) {
        console.error("Process keyword message error:", error);
      }
    };
}

export default new KeywordPlugin();

export async function processKeywordMessage(
  message: Api.Message
): Promise<void> {
  try {
    const text =
      message.message ||
      (message.media && "caption" in message.media
        ? String(message.media.caption || "")
        : "");
    if (!text) {
      return;
    }

    if (message.out) {
      return;
    }

    await keywordTasks.checkAndReply(message);
  } catch (error) {
    console.error("Process keyword message error:", error);
  }
}

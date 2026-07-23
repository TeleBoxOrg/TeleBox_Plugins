import {
  getPrefixes
} from "@utils/pluginManager";
import { logger } from "@utils/logger";
import type { MtcuteMessageContext } from "@utils/mtcuteTypes";
import { getErrorMessage } from "@utils/errorHelpers";
import { Plugin, type PanelSettingsAdapter, type PanelSettingField, type PanelFieldType } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { getGlobalClient } from "@utils/runtimeManager";
import { safeGetMessages, safeGetReplyMessage } from "@utils/safeGetMessages";
import { reviveEntities } from "@utils/tlRevive";
import { isUser } from "@utils/entityTypeGuards";
import type { Chat, User } from "@mtcute/node";
import { htmlEscape } from "@utils/htmlEscape";
import {
  dealCommandPluginWithMessage,
  getCommandFromMessage,
} from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const filePath = path.join(
  createDirectoryInAssets("acron"),
  "acron_config.json",
);

function getRemarkFromMsg(msg: MessageContext | string, n: number): string {
  return (typeof msg === "string" ? msg : msg?.text || "")
    .replace(new RegExp(`^\\S+${Array(n).fill("\\s+\\S+").join("")}`), "")
    .trim();
}

// DB schema and helpers
type AcronType =
  | "send"
  | "copy"
  | "forward"
  | "del"
  | "del_re"
  | "pin"
  | "unpin"
  | "cmd";

type AcronTaskBase = {
  id: string; // 自增主键（字符串格式）
  type: AcronType;
  cron: string;
  chat: string; // 用户输入的对话ID或@name
  chatId?: string; // 解析后的对话ID（字符串），使用时转 number
  createdAt: string; // 时间戳（字符串）
  lastRunAt?: string; // 时间戳（字符串）
  lastResult?: string; // 例如删除的数量
  lastError?: string;
  disabled?: boolean; // 是否被禁用
  remark?: string; // 备注
  display?: string; // 显示名称
};

type DelTask = AcronTaskBase & {
  type: "del";
  msgId: string; // 存储为字符串
};

type DelReTask = AcronTaskBase & {
  type: "del_re";
  limit: string; // 最近消息条数（字符串）
  regex: string; // 正则表达式字符串，支持 /.../flags 或纯文本
};

type SendTask = AcronTaskBase & {
  type: "send";
  message: string; // 纯文本内容
  entities?: any; // TL JSON（MessageEntity 数组的 JSON 序列化）
  replyTo?: string; // 回复的消息 ID
};

type CmdTask = AcronTaskBase & {
  type: "cmd";
  message: string; // 要执行的命令文本
  replyTo?: string; // 指定执行命令的话题ID或回复消息ID
};

type CopyTask = AcronTaskBase & {
  type: "copy";
  fromChatId: string; // 源消息所在对话ID（字符串）
  fromMsgId: string; // 源消息ID（字符串）
  replyTo?: string; // 发送时回复的消息ID（或话题顶贴ID）
};

type ForwardTask = AcronTaskBase & {
  type: "forward";
  fromChatId: string; // 源消息所在对话ID（字符串）
  fromMsgId: string; // 源消息ID（字符串）
  replyTo?: string; // 为了和 copy/send 一致保留，但转发API不支持replyTo
};

type PinTask = AcronTaskBase & {
  type: "pin";
  msgId: string; // 要置顶的消息ID（字符串）
  notify?: boolean; // 是否通知
  pmOneSide?: boolean; // 是否仅自己置顶（私聊）
};

type UnpinTask = AcronTaskBase & {
  type: "unpin";
  msgId: string; // 要取消置顶的消息ID（字符串）
};

type AcronTask =
  | SendTask
  | CmdTask
  | CopyTask
  | ForwardTask
  | DelTask
  | DelReTask
  | PinTask
  | UnpinTask;

type AcronDB = {
  seq: string; // 自增计数器（字符串）
  tasks: AcronTask[];
};

async function getDB() {
  const db = await JSONFilePreset<AcronDB>(filePath, { seq: "0", tasks: [] });
  return db;
}

// 转换辅助：在使用时将字符串转 number，写入时存字符串
function toInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function toStrInt(value: unknown): string | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : undefined;
}

const CN_TIME_ZONE = "Asia/Shanghai";

function formatDate(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: CN_TIME_ZONE });
}

async function formatEntity(
  target: unknown,
  mention?: boolean,
  throwErrorIfFailed?: boolean,
) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");
  if (!target) throw new Error("无效的目标");
  let id: number | undefined;
  let entity: Chat | User | { id?: number; title?: string; firstName?: string; lastName?: string; username?: string } | undefined;
  try {
    if (target && typeof target === "object" && "_" in target) {
      entity = target as unknown as Chat | User;
    } else {
      // mtcute treats pure-digit strings as usernames; numeric IDs must be numbers
      let peer: string | number = target as string | number;
      if (typeof peer === "string" && /^-?\d+$/.test(peer.trim())) {
        peer = Number(peer);
      }
      entity = (await client.getChat(peer)) as Chat | User;
    }
    if (!entity) throw new Error("无法获取 entity");
    id = entity.id;
    if (!id) throw new Error("无法获取 entity id");
  } catch (e: unknown) {
    logger.error(e);
    if (throwErrorIfFailed)
      throw new Error(
        `无法获取 ${target} 的 entity: ${getErrorMessage(e)}`,
      );
  }
  const displayParts: string[] = [];

  if (entity) {
    if ("title" in entity && entity.title)
      displayParts.push(htmlEscape(String(entity.title)));
    if ("firstName" in entity && entity.firstName)
      displayParts.push(htmlEscape(String(entity.firstName)));
    if ("lastName" in entity && entity.lastName)
      displayParts.push(htmlEscape(String(entity.lastName)));
    if ("username" in entity && entity.username) {
      const uname = htmlEscape(String(entity.username));
      displayParts.push(
        mention ? `@${uname}` : `<code>@${uname}</code>`,
      );
    }
  }

  if (id && entity) {
    displayParts.push(
      isUser(entity)
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`,
    );
  } else if (!(target && typeof target === "object" && "_" in target)) {
    displayParts.push(`<code>${htmlEscape(String(target))}</code>`);
  }

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}

function makeCronKey(id: string) {
  return `acron:${id}`;
}

function parseCronFromArgs(
  args: string[],
): { cron: string; rest: string[] } | null {
  // 优先按 6 段解析 (second minute hour dayOfMonth month dayOfWeek)
  const n6 = 6;
  if (args.length >= n6) {
    const maybeCron = args.slice(0, n6).join(" ");
    const validation = cron.validateCronExpression
      ? cron.validateCronExpression(maybeCron)
      : { valid: true };
    if (validation.valid) {
      return { cron: maybeCron, rest: args.slice(n6) };
    }
  }

  return null;
}

function buildCopy(task: AcronTask): string {
  if (task.type === "send") {
    const remark = task.remark ? ` ${task.remark}` : "";
    return `${mainPrefix}acron send ${task.cron} ${task.chat}${
      task.replyTo ? `|${task.replyTo}` : ""
    }${remark}`;
  } else if (task.type === "cmd") {
    const t = task as CmdTask;
    const remark = t.remark ? ` ${t.remark}` : "";
    return `${mainPrefix}acron cmd ${t.cron} ${t.chat}${
      t.replyTo ? `|${t.replyTo}` : ""
    }${remark}\n${t.message}`;
  } else if (task.type === "copy") {
    const remark = task.remark ? ` ${task.remark}` : "";
    const t = task as CopyTask;
    return `${mainPrefix}acron copy ${t.cron} ${t.chat}${
      t.replyTo ? `|${t.replyTo}` : ""
    }${remark}`;
  } else if (task.type === "forward") {
    const remark = task.remark ? ` ${task.remark}` : "";
    const t = task as ForwardTask;
    return `${mainPrefix}acron forward ${t.cron} ${t.chat}${
      t.replyTo ? `|${t.replyTo}` : ""
    }${remark}`;
  } else if (task.type === "del") {
    const remark = task.remark ? ` ${task.remark}` : "";
    return `${mainPrefix}acron del ${task.cron} ${task.chat} ${task.msgId}${remark}`;
  } else if (task.type === "del_re") {
    // 尽量保留原始正则字符串
    const t = task as DelReTask;
    const remark = t.remark ? ` ${t.remark}` : "";
    return `${mainPrefix}acron del_re ${t.cron} ${t.chat} ${t.limit} ${t.regex}${remark}`;
  } else if (task.type === "pin") {
    const t = task as PinTask;
    const remark = t.remark ? ` ${t.remark}` : "";
    const notify = t.notify ? "1" : "0";
    const pmOneSide = t.pmOneSide ? "1" : "0";
    return `${mainPrefix}acron pin ${t.cron} ${t.chat} ${t.msgId} ${notify} ${pmOneSide}${remark}`;
  } else if (task.type === "unpin") {
    const t = task as UnpinTask;
    const remark = t.remark ? ` ${t.remark}` : "";
    return `${mainPrefix}acron unpin ${t.cron} ${t.chat} ${t.msgId}${remark}`;
  }
  // fallback（理论不可达）
  return `${mainPrefix}acron`;
}
function buildCopyCommand(task: AcronTask): string {
  const cmd = buildCopy(task);
  return cmd?.includes("\n") ? `<pre>${cmd}</pre>` : `<code>${cmd}</code>`;
}

function tryParseRegex(input: string): RegExp {
  const trimmed = input.trim();
  if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
    const lastSlash = trimmed.lastIndexOf("/");
    const pattern = trimmed.slice(1, lastSlash);
    const flags = trimmed.slice(lastSlash + 1);
    return new RegExp(pattern, flags);
  }
  return new RegExp(trimmed);
}

async function scheduleTask(task: AcronTask) {
  const key = makeCronKey(task.id);
  if (task.disabled) return;
  if (cronManager.has(key)) return;

  cronManager.set(key, task.cron, async () => {
    const db = await getDB();
    const idx = db.data.tasks.findIndex((t) => t.id === task.id);
    const now = Date.now();
    try {
      const client = await getGlobalClient();
      // NOTE: mtcute 自动解析 peer，无需预加载对话
      const chatIdNum = toInt(task.chatId);
      const entityLike = chatIdNum ?? task.chat;

      if (task.type === "send") {
        const t = task as SendTask;
        const entities = reviveEntities(t.entities);
        const replyTo = t.replyTo ? toInt(t.replyTo) : undefined;
        await client.sendText(
          entityLike,
          entities && entities.length ? { text: t.message, entities } : t.message,
          replyTo ? { replyTo } : undefined,
        );
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已发送 1 条消息`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "cmd") {
        const t = task as CmdTask;
        const cmd = await getCommandFromMessage(t.message);
        const replyTo = t.replyTo ? toInt(t.replyTo) : undefined;
        const sudoMsg = await client.sendText(
          entityLike,
          t.message,
          replyTo ? { replyTo } : undefined,
        ) as MtcuteMessageContext;
        if (cmd && sudoMsg)
          await dealCommandPluginWithMessage({ cmd, msg: sudoMsg });
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已执行命令`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "copy") {
        const t = task as CopyTask;
        const fromChatIdNum = toInt(t.fromChatId);
        const fromMsgIdNum = toInt(t.fromMsgId);
        try {
          // 获取源消息（尽量使用完整实体以避免 hash 失效）
          const fromEntityLike = fromChatIdNum ?? t.fromChatId;
          const messages = await safeGetMessages(client, fromEntityLike, {
            ids: fromMsgIdNum,
          });
          const realtimeMsg = messages?.[0];
          if (!realtimeMsg) throw new Error("未能获取源消息");

          // 复制发送（不带转发头，保留文本/实体/媒体）
          const replyTo = t.replyTo ? toInt(t.replyTo) : undefined;
          await client.forwardMessagesById({
            toChatId: entityLike,
            fromChatId: fromEntityLike,
            messages: [fromMsgIdNum!],
            noAuthor: true,
            ...(replyTo ? { replyTo } : {}),
          });

          if (idx >= 0) {
            db.data.tasks[idx].lastRunAt = String(now);
            db.data.tasks[idx].lastResult = `已复制发送 1 条消息`;
            db.data.tasks[idx].lastError = undefined;
            await db.write();
          }
        } catch (e: unknown) {
          throw e;
        }
      } else if (task.type === "forward") {
        const t = task as ForwardTask;
        const fromChatIdNum = toInt(t.fromChatId);
        const fromMsgIdNum = toInt(t.fromMsgId);
        const fromEntityLike = fromChatIdNum ?? t.fromChatId;

        await client.forwardMessagesById({
          fromChatId: fromEntityLike,
          messages: [fromMsgIdNum!],
          toChatId: entityLike,
          // 如果在论坛话题中，指定话题的顶层消息 ID
          ...(t.replyTo ? { replyTo: toInt(t.replyTo) } : {}),
        });
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已转发 1 条消息`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "del") {
        const t = task as DelTask;
        const msgIdNum = toInt(t.msgId);
        if (msgIdNum !== undefined) {
          await client.deleteMessagesById(entityLike, [msgIdNum]);
        }
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已尝试删除消息 ${t.msgId}`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "del_re") {
        const t = task as DelReTask;
        const limitNum = toInt(t.limit) ?? 100;
        const messages = await client.getHistory(entityLike, {
          limit: limitNum,
        });
        const re = tryParseRegex(t.regex);
        const ids: number[] = [];
        for (const m of messages || []) {
          const text: string | undefined = m.text;
          if (typeof text === "string" && re.test(text)) {
            if (typeof m.id === "number") ids.push(m.id);
          }
        }
        if (ids.length > 0) {
          await client.deleteMessagesById(entityLike, ids);
        }
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `匹配并删除 ${ids.length} 条`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "pin") {
        const t = task as PinTask;
        const msgIdNum = toInt(t.msgId);
        if (msgIdNum === undefined) throw new Error("无效的消息ID");
        await client.pinMessage({
          chatId: entityLike,
          message: msgIdNum,
          notify: !!t.notify,
        });
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已置顶消息 ${t.msgId}`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      } else if (task.type === "unpin") {
        const t = task as UnpinTask;
        const msgIdNum = toInt(t.msgId);
        if (msgIdNum === undefined) throw new Error("无效的消息ID");
        await client.unpinMessage({ chatId: entityLike, message: msgIdNum });
        if (idx >= 0) {
          db.data.tasks[idx].lastRunAt = String(now);
          db.data.tasks[idx].lastResult = `已取消置顶消息 ${t.msgId}`;
          db.data.tasks[idx].lastError = undefined;
          await db.write();
        }
      }
    } catch (e: unknown) {
      logger.error(`[acron] 任务 ${task.id} 执行失败:`, e);
      if (idx >= 0) {
        db.data.tasks[idx].lastRunAt = String(now);
        db.data.tasks[idx].lastError = getErrorMessage(e);
        await db.write();
      }
    }
  });
}

async function bootstrapTasks() {
  try {
    const db = await getDB();
    // 并行调度所有有效任务
    const validTasks = db.data.tasks.filter(
      (t) => cron.validateCronExpression(t.cron).valid && !t.disabled,
    );
    await Promise.all(validTasks.map((t) => scheduleTask(t)));
  } catch (e: unknown) {
    logger.error("[acron] bootstrap 失败:", e);
  }
}

// 启动时注册历史任务（异步，不阻塞加载）
bootstrapTasks();

const help_text = `▎定时复制

每天2点复制发送到指定对话(可指定话题或回复消息)

• 使用 <code>${mainPrefix}acron copy 0 0 2 * * * 对话ID/@name [备注]</code> 回复一条消息
• 使用 <code>${mainPrefix}acron copy 0 0 2 * * * 对话ID/@name|发送时的话题ID或回复消息的ID [备注]</code> 回复一条消息

▎定时转发

每天2点转发到指定对话(可指定话题)

• 使用 <code>${mainPrefix}acron forward 0 0 2 * * * 对话ID/@name [备注]</code> 回复一条消息
• 使用 <code>${mainPrefix}acron forward 0 0 2 * * * 对话ID/@name|发送时的话题ID [备注]</code> 回复一条消息

▎定时发送

稍微麻烦了一点, 但是可以保证消息的完整格式. 储存此消息到数据库, 每天2点在指定对话发送(可指定话题或回复消息). 不支持带多媒体或 replyMarkup 的消息, 可考虑使用本插件的定时复制/转发功能

• 使用 <code>${mainPrefix}acron send 0 0 2 * * * 对话ID/@name [备注]</code> 回复一条消息
• 使用 <code>${mainPrefix}acron send 0 0 2 * * * 对话ID/@name|发送时话题的ID或回复消息的ID [备注]</code> 回复一条消息

▎定时删除

每天2点删除指定ID或@name的对话中的指定ID的消息

• <code>${mainPrefix}acron del 0 0 2 * * * 对话ID/@name 消息ID [备注]</code>

▎定时正则删除

每天2点删除指定ID或@name的对话中的最近的 100 条消息中 内容符合正则表达式的消息

• <code>${mainPrefix}acron del_re 0 0 2 * * * 对话ID/@name 100 /^test/i [备注]</code>

▎定时置顶/取消置顶

每天2点在指定ID或@name的对话中置顶指定ID的消息, 是否发通知(true/1, false/0), 是否仅对自己置顶(true/1, false/0)

• <code>${mainPrefix}acron pin 0 0 2 * * * 对话ID/@name 消息ID 是否发通知 是否仅对自己置顶 [备注]</code>

每天2点在指定ID或@name的对话中取消置顶指定ID的消息

• <code>${mainPrefix}acron unpin 0 0 2 * * * 对话ID/@name 消息ID [备注]</code>

▎定时执行命令

每天2点在指定ID或@name的对话中执行命令 <code>${mainPrefix}a foo bar</code>(可指定话题或回复消息)
注意要换行写

<pre>${mainPrefix}acron cmd 0 0 2 * * * 对话ID/@name [备注]
${mainPrefix}a foo bar</pre>

<pre>${mainPrefix}acron cmd 0 0 2 * * * 对话ID/@name|发送时话题的ID或回复消息的ID [备注]
${mainPrefix}a foo bar</pre>

典型的使用场景:

每天2点自动备份(调用 <code>${mainPrefix}bf</code> 命令)

<pre>${mainPrefix}acron cmd 0 0 2 * * * me 定时备份
${mainPrefix}bf</pre>

每天2点自动更新 <code>eat</code> 的表情包配置(调用 <code>${mainPrefix}eat set</code> 命令)

<pre>${mainPrefix}acron cmd 0 0 2 * * * me 定时更新表情包
${mainPrefix}eat set</pre>

• <code>${mainPrefix}acron list</code>, <code>${mainPrefix}acron ls</code> - 列出当前会话中的所有定时任务
• <code>${mainPrefix}acron ls all</code>, <code>${mainPrefix}acron la</code> - 列出所有的定时任务
• <code>${mainPrefix}acron ls del</code> - 列出当前会话中的类型为 del 的定时任务
• <code>${mainPrefix}acron ls all del</code>, <code>${mainPrefix}acron la del</code> - 列出所有的类型为 del 的定时任务
• <code>${mainPrefix}acron rm 定时任务ID</code> - 删除指定的定时任务
• <code>${mainPrefix}acron disable/off 定时任务ID</code> - 禁用指定的定时任务
• <code>${mainPrefix}acron enable/on 定时任务ID</code> - 启用指定的定时任务
`;

class AcronPlugin extends Plugin {

  description: string = `定时发送/转发/复制/置顶/取消置顶/删除消息/执行命令\n\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: MessageContext, trigger?: MessageContext) => Promise<void>
  > = {
    acron: async (msg: MessageContext) => {
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];

      const parts = lines?.[0]?.split(/\s+/) || [];

      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();

      try {
        if (!sub) {
          await msg.edit({
            text: html(help_text),
          });
          return;
        }

        if (sub === "list" || sub === "ls" || sub === "la") {
          let p1 = (args[1] || "").toLowerCase();
          let p2 = (args[2] || "").toLowerCase();
          if (sub === "la") {
            p2 = p1;
            p1 = "all";
          }

          const scopeAll = p1 === "all";
          const maybeType = (scopeAll ? p2 : p1) as AcronType | "";
          const typeFilter: AcronType | undefined = [
            "send",
            "cmd",
            "copy",
            "forward",
            "del",
            "del_re",
            "pin",
            "unpin",
          ].includes(maybeType as string)
            ? (maybeType as AcronType)
            : undefined;

          const typeLabel = (tp?: AcronType) =>
            tp === "send"
              ? "发送"
              : tp === "cmd"
                ? "命令"
                : tp === "copy"
                  ? "复制"
                  : tp === "forward"
                    ? "转发"
                    : tp === "del"
                      ? "删除"
                      : tp === "del_re"
                        ? "正则删除"
                        : tp === "pin"
                          ? "置顶"
                          : tp === "unpin"
                            ? "取消置顶"
                            : String(tp || "");

          const db = await getDB();
          const chatId = Number(msg.chat.id);
          const tasks = db.data.tasks
            .filter(
              (t) =>
                (scopeAll ? true : Number(t.chatId) === chatId) &&
                (!typeFilter || t.type === typeFilter),
            )
            // 先展示已启用的，再展示已禁用的
            .sort((a, b) => {
              const ad = a.disabled ? 1 : 0;
              const bd = b.disabled ? 1 : 0;
              return ad - bd;
            });

          if (tasks.length === 0) {
            const noneText = scopeAll
              ? typeFilter
                ? `暂无类型为 ${typeLabel(typeFilter)} 的定时任务`
                : "暂无定时任务"
              : typeFilter
                ? `当前会话暂无类型为 ${typeLabel(typeFilter)} 的定时任务`
                : "当前会话暂无定时任务";
            await msg.edit({ text: noneText });
            return;
          }

          const lines: string[] = [];
          const header = scopeAll
            ? typeFilter
              ? `📋 所有 ${typeLabel(typeFilter)} 定时任务`
              : "📋 所有定时任务"
            : typeFilter
              ? `📋 当前会话 ${typeLabel(typeFilter)} 定时任务`
              : "📋 当前会话定时任务";
          lines.push(header);
          lines.push("");

          // 分块显示：先启用，再禁用；如果对应块为空则不显示表头
          const enabledTasks = tasks.filter((t) => !t.disabled);
          const disabledTasks = tasks.filter((t) => t.disabled);

          if (enabledTasks.length > 0) {
            lines.push("🔛 已启用:");
            lines.push("");
            const enabledEntities = await Promise.all(
              enabledTasks.map((t) => formatEntity(t.chatId ?? t.chat))
            );
            for (let i = 0; i < enabledTasks.length; i++) {
              const t = enabledTasks[i];
              const entityInfo = enabledEntities[i];
              const nextDt = cron.sendAt(t.cron);
              const escapedRemark = htmlEscape(t.remark);
              const title = `<code>${t.id}</code> • <code>${typeLabel(
                t.type,
              )}</code>${escapedRemark ? ` • ${escapedRemark}` : ""}`;
              lines.push(title);
              // entityInfo.display 已是安全 HTML（formatEntity 内已 escape 纯文本）
              // 勿再 htmlEscape，否则 <code>/<a> 会原样显示
              const chatDisplay = entityInfo?.entity
                ? entityInfo.display
                : t.display
                  ? htmlEscape(String(t.display))
                  : `<code>${htmlEscape(String(t.chat))}</code>`;
              lines.push(`对话: ${chatDisplay}`);
              const msgId = (t.type === "del" || t.type === "pin" || t.type === "unpin")
                ? (t as DelTask | PinTask | UnpinTask).msgId : undefined;
              const fromChatId = (t.type === "copy" || t.type === "forward")
                ? (t as CopyTask | ForwardTask).fromChatId : undefined;
              const fromMsgId = (t.type === "copy" || t.type === "forward")
                ? (t as CopyTask | ForwardTask).fromMsgId : undefined;
              if (msgId) {
                lines.push(
                  `消息: <a href="https://t.me/c/${String(
                    t.chatId ?? t.chat,
                  ).replace("-100", "")}/${msgId}">${msgId}</a>`,
                );
              }
              if (fromChatId && fromMsgId) {
                lines.push(
                  `消息: <a href="https://t.me/c/${String(
                    fromChatId ?? "",
                  ).replace("-100", "")}/${fromMsgId}">${fromMsgId}</a>`,
                );
              }
              if (
                (t.type === "send" && (t as SendTask).replyTo) ||
                (t.type === "cmd" && (t as CmdTask).replyTo) ||
                (t.type === "copy" && (t as CopyTask).replyTo) ||
                (t.type === "forward" && (t as ForwardTask).replyTo)
              ) {
                const replyId = (t as SendTask | CmdTask | CopyTask | ForwardTask).replyTo as string | undefined;
                if (replyId)
                  lines.push(
                    `回复: <a href="https://t.me/c/${String(
                      t.chatId ?? t.chat,
                    ).replace("-100", "")}/${replyId}">${replyId}</a>`,
                  );
              }
              if (nextDt) {
                const dt: Date =
                  typeof (nextDt as unknown as { toJSDate?: () => Date })?.toJSDate === "function"
                    ? (nextDt as unknown as { toJSDate: () => Date }).toJSDate()
                    : nextDt instanceof Date
                      ? nextDt
                      : new Date(Number(nextDt));
                lines.push(`下次: ${formatDate(dt)}`);
              }
              if (t.lastRunAt) {
                lines.push(
                  `上次: ${formatDate(new Date(Number(t.lastRunAt)))}`,
                );
              }
              if (t.lastResult) lines.push(`结果: ${htmlEscape(String(t.lastResult))}`);
              if (t.lastError) lines.push(`错误: ${htmlEscape(String(t.lastError))}`);
              lines.push(`复制: <code>${htmlEscape(buildCopyCommand(t))}</code>`);
              lines.push("");
            }
          }

          if (disabledTasks.length > 0) {
            lines.push("⏹ 已禁用:");
            lines.push("");
            const disabledEntities = await Promise.all(
              disabledTasks.map((t) => formatEntity(t.chatId ?? t.chat))
            );
            for (let i = 0; i < disabledTasks.length; i++) {
              const t = disabledTasks[i];
              const entityInfo = disabledEntities[i];
              const escapedRemark = htmlEscape(t.remark);
              const title = `<code>${t.id}</code> • <code>${typeLabel(
                t.type,
              )}</code>${escapedRemark ? ` • ${escapedRemark}` : ""}`;
              lines.push(title);
              const disabledChatDisplay = entityInfo?.entity
                ? entityInfo.display
                : t.display
                  ? htmlEscape(String(t.display))
                  : `<code>${htmlEscape(String(t.chat))}</code>`;
              lines.push(`对话: ${disabledChatDisplay}`);
              // 禁用状态不显示下次执行
              if (t.lastRunAt) {
                lines.push(
                  `上次: ${formatDate(new Date(Number(t.lastRunAt)))}`,
                );
              }
              if (t.lastResult) lines.push(`结果: ${htmlEscape(String(t.lastResult))}`);
              if (t.lastError) lines.push(`错误: ${htmlEscape(String(t.lastError))}`);
              lines.push(`复制: <code>${htmlEscape(buildCopyCommand(t))}</code>`);
              lines.push("");
            }
          }

          // 分片发送，避免超长
          const full = lines.join("\n");
          const MAX = 3500; // 预留富文本开销
          const chunks: string[] = [];
          for (let i = 0; i < full.length; i += MAX) {
            chunks.push(full.slice(i, i + MAX));
          }
          if (chunks.length > 0) {
            await msg.edit({ text: html(chunks[0]) });
            // Sequential: each chunk replies to the previous one to maintain order
            for (let i = 1; i < chunks.length; i++) {
              await msg.replyText(html(chunks[i]));
            }
          }
          return;
        }

        if (sub === "rm") {
          const rawId = args[1];
          if (!rawId) {
            await msg.edit({
              text: html(`请提供定时任务ID: <code>${mainPrefix}acron rm ID</code>`),
            });
            return;
          }
          const escapedId = htmlEscape(rawId);
          const db = await getDB();
          const idx = db.data.tasks.findIndex((t) => t.id === rawId);
          if (idx < 0) {
            await msg.edit({
              text: html(`未找到任务: <code>${escapedId}</code>`),
            });
            return;
          }
          const key = makeCronKey(rawId);
          cronManager.del(key);
          db.data.tasks.splice(idx, 1);
          await db.write();
          await msg.edit({
            text: html(`✅ 已删除任务 <code>${escapedId}</code>`),
          });
          return;
        }

        if (
          sub === "disable" ||
          sub === "enable" ||
          sub === "off" ||
          sub === "on"
        ) {
          const rawId = args[1];
          if (!rawId) {
            await msg.edit({
              text: html(
                sub === "disable"
                  ? `请提供定时任务ID: <code>${mainPrefix}acron disable ID</code>`
                  : `请提供定时任务ID: <code>${mainPrefix}acron enable ID</code>`,
              ),
            });
            return;
          }
          const escapedId = htmlEscape(rawId);
          const db = await getDB();
          const idx = db.data.tasks.findIndex((t) => t.id === rawId);
          if (idx < 0) {
            await msg.edit({
              text: html(`未找到任务: <code>${escapedId}</code>`),
            });
            return;
          }
          const t = db.data.tasks[idx];
          if (sub === "disable" || sub === "off") {
            if (t.disabled) {
              await msg.edit({
                text: html(`任务 <code>${escapedId}</code> 已处于禁用状态`),
              });
              return;
            }
            const key = makeCronKey(rawId);
            cronManager.del(key);
            t.disabled = true;
            await db.write();
            await msg.edit({
              text: html(`⏸️ 已禁用任务 <code>${escapedId}</code>`),
            });
          } else {
            if (!cron.validateCronExpression(t.cron).valid) {
              await msg.edit({
                text: html(`任务 <code>${escapedId}</code> 的 Cron 表达式无效，无法启用`),
              });
              return;
            }
            t.disabled = false;
            await db.write();
            await scheduleTask(t as AcronTask);
            await msg.edit({
              text: html(`▶️ 已启用任务 <code>${escapedId}</code>\n下次执行: ${formatDate(
                cron.sendAt(t.cron).toJSDate(),
              )}`),
            });
          }
          return;
        }

        if (
          sub === "send" ||
          sub === "cmd" ||
          sub === "copy" ||
          sub === "forward" ||
          sub === "del" ||
          sub === "del_re" ||
          sub === "pin" ||
          sub === "unpin"
        ) {
          const argRest = args.slice(1); // 跳过子命令
          const parsed = parseCronFromArgs(argRest);
          if (!parsed) {
            await msg.edit({ text: "无效的 Cron 表达式" });
            return;
          }
          const { cron: cronExpr, rest } = parsed;
          const validation = cron.validateCronExpression
            ? cron.validateCronExpression(cronExpr)
            : { valid: true };
          if (!validation.valid) {
            await msg.edit({
              text: `Cron 校验失败: ${validation.error || "无效表达式"}`,
            });
            return;
          }

          const [chatArg, ...restChatArg] =
            rest[0]
              ?.split(/\s*[|｜]\s*/g)
              .map((i) => i.trim())
              .filter((i) => i.length > 0) || [];

          if (!chatArg) {
            await msg.edit({ text: "请提供对话ID或@name" });
            return;
          }
          // 解析并展示（失败也只用于展示）
          const { id: resolvedChatId, display } = await formatEntity(chatArg);
          const chatIdNum = Number(resolvedChatId);
          const hasChatId = Number.isFinite(chatIdNum)
            ? String(chatIdNum)
            : undefined;

          const db = await getDB();
          // 自增 seq（字符串存储）
          const currentSeq = toInt(db.data.seq) ?? 0;
          const nextSeq = currentSeq + 1;
          db.data.seq = String(nextSeq);
          const id = String(nextSeq);

          if (sub === "send") {
            // 必须回复一条消息
            if (!msg.replyToMessage) {
              await msg.edit({ text: html("请回复一条要定时发送的消息") });
              return;
            }
            const replied = await safeGetReplyMessage(msg);
            // 不支持多媒体或按钮
            if (replied?.media || (replied as unknown as { replyMarkup?: unknown }).replyMarkup) {
              await msg.edit({
                text: html("不支持带多媒体或 replyMarkup 的消息 可考虑使用本插件的定时复制/转发功能"),
              });
              return;
            }
            const text: string = (replied?.text ?? (replied as unknown as { message?: string }).message ?? "").toString();
            if (!text || !text.trim()) {
              await msg.edit({ text: html("请回复一条包含文本的消息") });
              return;
            }
            const entities: ReturnType<typeof JSON.parse> | undefined = (replied as unknown as { entities?: unknown })?.entities
              ? JSON.parse(JSON.stringify((replied as unknown as { entities: unknown }).entities))
              : undefined;
            const remark = getRemarkFromMsg(lines[0], 8);
            const replyTo = restChatArg[0];

            const task: SendTask = {
              id,
              type: "send",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId,
              message: text,
              entities,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              replyTo: replyTo || undefined,
              display: display || undefined,
            };

            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = cron.sendAt(cronExpr);
            const tip = [
              "✅ 已添加定时发送任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              ...(task.replyTo ? [`回复: ${task.replyTo}`] : []),
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ]
              .filter(Boolean)
              .join("\n");
            await msg.edit({ text: html(tip) });
            return;
          } else if (sub === "cmd") {
            // 备注与回复ID
            const remark = getRemarkFromMsg(lines[0], 8);
            const replyTo = restChatArg[0];
            const message = lines?.[1]?.trim(); // 第二行
            if (!message) {
              await msg.edit({ text: "无法识别要执行的命令" });
              return;
            }

            const task: CmdTask = {
              id,
              type: "cmd",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId,
              message,
              replyTo: replyTo || undefined,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              display: display || undefined,
            };

            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = cron.sendAt(cronExpr);
            const tip = [
              "✅ 已添加定时命令任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              ...(task.replyTo ? [`回复: ${task.replyTo}`] : []),
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ]
              .filter(Boolean)
              .join("\n");
            await msg.edit({ text: html(tip) });
            return;
          } else if (sub === "copy" || sub === "forward") {
            // 必须回复一条消息（作为源）
            if (!msg.replyToMessage) {
              await msg.edit({ text: html("请回复一条要复制/转发的源消息") });
              return;
            }
            const replied = await safeGetReplyMessage(msg);
            const mm: { id?: number; chat?: { id?: number | string } } = replied || {};
            const fromMsgId = toInt(mm.id);
            const fromChatId = toInt(mm.chat?.id);
            if (!fromMsgId || !fromChatId) {
              await msg.edit({ text: html("无法识别源消息ID或会话ID") });
              return;
            }

            // 备注与回复ID
            const remark = getRemarkFromMsg(lines[0], 8);
            const replyTo = restChatArg[0];

            if (sub === "copy") {
              const task: CopyTask = {
                id,
                type: "copy",
                cron: cronExpr,
                chat: chatArg,
                chatId: hasChatId,
                fromChatId: String(Math.trunc(fromChatId)),
                fromMsgId: String(Math.trunc(fromMsgId)),
                replyTo: replyTo || undefined,
                createdAt: String(Date.now()),
                remark: remark || undefined,
                display: display || undefined,
              };
              db.data.tasks.push(task);
              await db.write();
              await scheduleTask(task);

              const nextAt = cron.sendAt(cronExpr);
              const tip = [
                "✅ 已添加定时复制任务",
                `ID: <code>${id}</code>`,
                `对话: ${display}`,
                ...(task.replyTo ? [`回复: ${task.replyTo}`] : []),
                ...(task.remark ? [`备注: ${task.remark}`] : []),
                nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
                `复制: ${buildCopyCommand(task)}`,
              ]
                .filter(Boolean)
                .join("\n");
              await msg.edit({ text: html(tip) });
              return;
            } else {
              const task: ForwardTask = {
                id,
                type: "forward",
                cron: cronExpr,
                chat: chatArg,
                chatId: hasChatId,
                fromChatId: String(Math.trunc(fromChatId)),
                fromMsgId: String(Math.trunc(fromMsgId)),
                replyTo: replyTo || undefined,
                createdAt: String(Date.now()),
                remark: remark || undefined,
                display: display || undefined,
              };
              db.data.tasks.push(task);
              await db.write();
              await scheduleTask(task);

              const nextAt = cron.sendAt(cronExpr);
              const tip = [
                "✅ 已添加定时转发任务",
                `ID: <code>${id}</code>`,
                `对话: ${display}`,
                ...(task.replyTo ? [`回复: ${task.replyTo}`] : []),
                ...(task.remark ? [`备注: ${task.remark}`] : []),
                nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
                `复制: ${buildCopyCommand(task)}`,
              ]
                .filter(Boolean)
                .join("\n");
              await msg.edit({ text: html(tip) });
              return;
            }
          } else if (sub === "del") {
            const msgIdStr = rest[1];

            if (!msgIdStr) {
              await msg.edit({ text: "请提供消息 ID" });
              return;
            }
            const remark = getRemarkFromMsg(lines[0], 9);

            const task: DelTask = {
              id,
              type: "del",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId,
              msgId: msgIdStr,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              display: display || undefined,
            };

            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = cron.sendAt(cronExpr);
            const tip = [
              "✅ 已添加删除消息的定时任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ].join("\n");
            await msg.edit({ text: html(tip) });
            return;
          } else if (sub === "pin") {
            // rest: [chat, msgId, notify, pmOneSide, ...remark]
            const msgIdStr = rest[1];

            if (!msgIdStr) {
              await msg.edit({ text: "请提供消息 ID" });
              return;
            }
            const notifyRaw = (rest[2] || "").toLowerCase();
            const pmOneSideRaw = (rest[3] || "").toLowerCase();
            if (!notifyRaw || !pmOneSideRaw) {
              await msg.edit({
                text: "请提供是否发通知与是否仅对自己置顶参数，如: 1 0 或 true false",
              });
              return;
            }
            const parseBool = (v: string) =>
              v === "1" || v === "true" || v === "yes" || v === "y";
            const notify = parseBool(notifyRaw);
            const pmOneSide = parseBool(pmOneSideRaw);
            const remark = getRemarkFromMsg(lines[0], 11);

            const task: PinTask = {
              id,
              type: "pin",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId,
              msgId: msgIdStr,
              notify,
              pmOneSide,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              display: display || undefined,
            };

            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = cron.sendAt(cronExpr);
            const tip = [
              "✅ 已添加置顶消息的定时任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              `消息ID: <code>${task.msgId}</code>`,
              `通知: <code>${task.notify ? "1" : "0"}</code>`,
              `仅自己置顶: <code>${task.pmOneSide ? "1" : "0"}</code>`,
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ].join("\n");
            await msg.edit({ text: html(tip) });
            return;
          } else if (sub === "unpin") {
            // rest: [chat, msgId, ...remark]
            const msgIdStr = rest[1];

            if (!msgIdStr) {
              await msg.edit({ text: "请提供消息 ID" });
              return;
            }
            const remark = getRemarkFromMsg(lines[0], 9);

            const task: UnpinTask = {
              id,
              type: "unpin",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId,
              msgId: msgIdStr,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              display: display || undefined,
            };

            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = cron.sendAt(cronExpr);
            const tip = [
              "✅ 已添加取消置顶的定时任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              `消息ID: <code>${task.msgId}</code>`,
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ].join("\n");
            await msg.edit({ text: html(tip) });
            return;
          } else {
            // del_re
            const limitStr = rest[1];
            const limit = Number(limitStr || 100);
            if (!Number.isFinite(limit) || limit <= 0) {
              await msg.edit({ text: "请提供有效的条数限制(正整数)" });
              return;
            }
            if (!rest[2]) {
              await msg.edit({ text: "请提供消息正则表达式" });
              return;
            }
            // 新增备注支持：从第三段起第一个参数为正则，其余合并为备注
            const regexRaw = String(rest[2]).trim();
            const remark = getRemarkFromMsg(lines[0], 10);
            if (!regexRaw) {
              await msg.edit({ text: "请提供消息正则表达式" });
              return;
            }
            // 校验正则
            try {
              void tryParseRegex(regexRaw);
            } catch (e: unknown) {
              await msg.edit({ text: `无效的正则表达式: ${e instanceof Error ? e.message : String(e)}` });
              return;
            }

            const task: DelReTask = {
              id,
              type: "del_re",
              cron: cronExpr,
              chat: chatArg,
              chatId: hasChatId,
              limit: String(Math.trunc(limit)),
              regex: regexRaw,
              createdAt: String(Date.now()),
              remark: remark || undefined,
              display: display || undefined,
            };
            db.data.tasks.push(task);
            await db.write();
            await scheduleTask(task);

            const nextAt = cron.sendAt(cronExpr);
            const tip = [
              "✅ 已添加正则删除的定时任务",
              `ID: <code>${id}</code>`,
              `对话: ${display}`,
              `最近条数: <code>${limit}</code>`,
              `匹配: <code>${regexRaw}</code>`,
              ...(task.remark ? [`备注: ${task.remark}`] : []),
              nextAt ? `下次执行: ${formatDate(nextAt.toJSDate())}` : "",
              `复制: ${buildCopyCommand(task)}`,
            ].join("\n");
            await msg.edit({ text: html(tip) });
            return;
          }
        }

        await msg.edit({ text: `未知子命令: ${sub}` });
      } catch (error: unknown) {
        await msg.edit({ text: `处理出错: ${getErrorMessage(error)}` });
      }
    },
  };
}


  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "acron",
    title: "定时任务",
    description: "ACRON 定时任务配置",
    category: "插件配置",
    icon: "⏰",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "timezone",
            "label": "时区",
            "type": "string",
            "default": "Asia/Shanghai"
      },
      {
            "key": "maxRetries",
            "label": "最大重试次数",
            "type": "number",
            "min": 0,
            "max": 10,
            "default": 3
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("acron"), "config.json"), {} as any);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("acron"), "config.json"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };

export default new AcronPlugin();

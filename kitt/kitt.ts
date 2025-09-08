import axios from "axios";
import _ from "lodash";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { getGlobalClient } from "@utils/globalClient";
import { reviveEntities } from "@utils/tlRevive";
import {
  dealCommandPluginWithMessage,
  getCommandFromMessage,
} from "@utils/pluginManager";
import { sleep } from "telegram/Helpers";
import dayjs from "dayjs";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "kitt";

const commandName = `${mainPrefix}${pluginName}`;

const filePath = path.join(
  createDirectoryInAssets(`${pluginName}`),
  `${pluginName}_config.json`
);

function getRemarkFromMsg(msg: Api.Message | string, n: number): string {
  return (typeof msg === "string" ? msg : msg?.message || "")
    .replace(new RegExp(`^\\S+${Array(n).fill("\\s+\\S+").join("")}`), "")
    .trim();
}

async function getDB() {
  const db = await JSONFilePreset(filePath, {
    tasks: [] as Array<{
      id: string;
      remark?: string;
      match: string;
      action: string;
      status?: string;
    }>,
    index: "0",
  });
  return db;
  // await db.write();
}

function toInt(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function toStrInt(value: any): string | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : undefined;
}

const CN_TIME_ZONE = "Asia/Shanghai";

function formatDate(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: CN_TIME_ZONE });
}

async function formatEntity(
  target: any,
  mention?: boolean,
  throwErrorIfFailed?: boolean
) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");
  if (!target) throw new Error("无效的目标");
  let id: any;
  let entity: any;
  try {
    entity = target?.className
      ? target
      : ((await client?.getEntity(target)) as any);
    if (!entity) throw new Error("无法获取 entity");
    id = entity.id;
    if (!id) throw new Error("无法获取 entity id");
  } catch (e: any) {
    console.error(e);
    if (throwErrorIfFailed)
      throw new Error(
        `无法获取 ${target} 的 entity: ${e?.message || "未知错误"}`
      );
  }
  const displayParts: string[] = [];

  if (entity?.title) displayParts.push(entity.title);
  if (entity?.firstName) displayParts.push(entity.firstName);
  if (entity?.lastName) displayParts.push(entity.lastName);
  if (entity?.username)
    displayParts.push(
      mention ? `@${entity.username}` : `<code>@${entity.username}</code>`
    );

  if (id) {
    displayParts.push(
      entity instanceof Api.User
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`
    );
  } else if (!target?.className) {
    displayParts.push(`<code>${target}</code>`);
  }

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
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

function buildCopy(task: any): string {
  return `${commandName} add ${task.remark}
${task.match}
${task.action}`;
}
function buildCopyCommand(task: any): string {
  const cmd = buildCopy(task);
  return cmd?.includes("\n") ? `<pre>${cmd}</pre>` : `<code>${cmd}</code>`;
}
async function run(text: string, msg: Api.Message, trigger?: Api.Message) {
  const cmd = await getCommandFromMessage(text);
  const sudoMsg = await msg.client?.sendMessage(msg.peerId, {
    message: text,
    replyTo: msg.replyToMsgId,
    // formattingEntities: msg.entities,
  });
  if (cmd && sudoMsg)
    await dealCommandPluginWithMessage({ cmd, msg: sudoMsg, trigger: msg });
}

async function exec(text: string, msg: Api.Message, trigger?: Api.Message) {
  return await (
    await import(
      `data:text/javascript;charset=utf-8,${encodeURIComponent(
        `export default async ({ msg, chat, sender, trigger, reply, client, _, axios, formatEntity, sleep, dayjs, run, Api }) => { ${text} }`
      )}`
    )
  ).default({
    msg,
    chat: msg?.chat,
    sender: msg?.sender,
    trigger,
    reply: await msg.getReplyMessage(),
    client: msg?.client,
    _,
    axios,
    formatEntity,
    sleep,
    dayjs,
    run,
    Api,
  });
}

const help_text = `▎格式

<pre>${commandName} add [备注]
[匹配逻辑]
[执行逻辑]</pre>

▎匹配逻辑

执行 JavaScript, 返回值为真值, 即匹配

▎执行逻辑

执行 JavaScript

▎示范

可使用

<code>msg: Api.Message</code>: 当前消息
<code>chat: Entity</code>: 当前消息的对话(可从 <code>msg</code> 上取, 这里是为了精简)
<code>sender: Entity</code>: 当前消息的发送者(可从 <code>msg</code> 上取, 这里是为了精简)
<code>reply?: Api.Message</code>: 若此消息是回复的其他消息, 则此字段为被回复的消息
<code>trigger?: Api.Message</code>: <code>sudo</code> 模式下, 触发执行当前操作的原始消息
<code>client?: TelegramClient</code>: <code>client</code>(可从 <code>msg</code> 上取, 这里是为了精简)
<code>Api: </code>: <code>Api</code>
<code>_</code>: <code>lodash</code>
<code>axios</code>: <code>axios</code>
<code>dayjs</code>: <code>dayjs</code>
<code>formatEntity</code>: 用户/对话格式化
<code>sleep</code>: <code>sleep</code>(单位 <code>ms</code>)
<code>run</code>: <code>run</code> 执行插件命令

- <code>username</code> 为 <code>a</code> 或 <code>b</code> 的用户在星期四发言就回复 <code>V 我 50!</code>

<pre>${commandName} add 疯狂星期四
return !msg.fwdFrom && ['a', 'b'].includes(msg.sender?.username) && dayjs().day() === 4
await msg.reply({ message: \`\${(await formatEntity(msg.sender)).display}, V 我 50!\`}, parseMode: 'html' })</pre>

- <code>username</code> 为 <code>test</code> 的群里的没有 <code>username</code> 的用户不许参加淫趴

<pre>${commandName} add 你不许参加淫趴
return msg.chat?.username === 'test' && !msg.sender?.username
await msg.reply({ message: \`\${(await formatEntity(msg.sender)).display}, 你不许参加淫趴!\`, parseMode: 'html' })</pre>

- <code>username</code> 为 <code>a</code> 或 <code>b</code> 的用户可使用 <code>${mainPrefix}${mainPrefix}</code> 依次执行命令 一键强制更新并退出重启

<pre>.kitt add 一键强制更新并退出重启
return !msg.fwdFrom && ['a', 'b'].includes(msg.sender?.username) && msg.text === '${mainPrefix}${mainPrefix}'
await run('${mainPrefix}update -f', msg); await run('${mainPrefix}dme 1', msg); try { await msg.delete() } catch (e) {}; await run('.exit', msg)</pre>

- <code>username</code> 为 <code>a</code> 或 <code>b</code> 的用户可使用 <code>,,</code> 一键更新已安装的远程插件

<pre>.kitt add 一键更新已安装的远程插件
return !msg.fwdFrom && ['a', 'b'].includes(msg.sender?.username) && msg.text === ',,'
await run('${mainPrefix}tpm update', msg); await run('${mainPrefix}dme 1', msg); try { await msg.delete() } catch (e) {};</pre>

▎管理
<code>${commandName} ls</code>, <code>${commandName} list</code>: 列出所有任务
<code>${commandName} ls -v</code>, <code>${commandName} list -v</code>, <code>${commandName} lv</code>: 列出所有任务(详细版, ⚠️ 可能包含隐私, 酌情在公开场合使用)
<code>${commandName} del [id]</code>, <code>${commandName} rm [id]</code>: 移除指定任务
<code>${commandName} enable [id]</code>, <code>${commandName} on [id]</code>: 启用指定任务
<code>${commandName} disable [id]</code>, <code>${commandName} off [id]</code>: 禁用指定任务
`;

class KittPlugin extends Plugin {
  description: string = `\nK.I.T.T <blockquote>As you wish, Michael.</blockquote>\n\n使用 JavaScript 的高级触发器: 匹配 -> 执行, 高度自定义, 逻辑自由\n\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    kitt: async (msg: Api.Message, trigger?: Api.Message) => {
      const lines = msg.message.split(/\r?\n/g).map((l) => l.trim());
      const args = lines[0].split(/\s+/g);
      const command = args[1];
      const remark = getRemarkFromMsg(lines[0], 1);
      if (["add"].includes(command)) {
        const match = lines[1];
        const action = lines[2];
        // console.log({ remark, match, action });
        const db = await getDB();
        db.data.index = (parseInt(db.data.index) + 1).toString();
        await db.write();
        const id = db.data.index;
        db.data.tasks.push({
          id,
          remark,
          match,
          action,
        });
        await db.write();
        await msg.edit({
          text: `任务 <code>${id}</code> 已添加`,
          parseMode: "html",
        });
      } else if (["ls", "list", "lv"].includes(command)) {
        const verbose =
          command === "lv" || ["-v", "--verbose"].includes(args[2]);
        const db = await getDB();
        const tasks = db.data.tasks;
        if (tasks.length === 0) {
          await msg.edit({ text: `当前没有任何任务` });
          return;
        }
        const enabledTasks = tasks
          .filter((t) => t.status !== "0")
          .sort((a, b) => parseInt(a.id) - parseInt(b.id));
        const disabledTasks = tasks
          .filter((t) => t.status === "0")
          .sort((a, b) => parseInt(a.id) - parseInt(b.id));

        let text = "";
        if (enabledTasks.length > 0) {
          text += `🔛 已启用的任务：\n\n${enabledTasks
            .map(
              (t) =>
                `- [<code>${t.id}</code>] ${t.remark}${
                  verbose ? `\n${buildCopyCommand(t)}` : ""
                }`
            )
            .join("\n")}`;
        }
        if (disabledTasks.length > 0) {
          if (text) text += "\n\n";
          text += `⏹ 已禁用的任务：\n\n${disabledTasks
            .map(
              (t) =>
                `- [<code>${t.id}</code>] ${t.remark}${
                  verbose ? `\n${buildCopyCommand(t)}` : ""
                }`
            )
            .join("\n")}`;
        }

        await msg.edit({
          text:
            `${
              verbose
                ? ""
                : `💡 可使用 <code>${commandName} ls -v</code> 查看详情(⚠️ 可能包含隐私, 酌情在公开场合使用)\n\n`
            }${text}` || "当前没有任何任务",
          parseMode: "html",
        });
      } else if (["rm", "del"].includes(command)) {
        const taskId = args[2];
        const db = await getDB();
        const tasks = db.data.tasks;
        const taskIndex = tasks.findIndex((t) => t.id === taskId);
        if (taskIndex === -1) {
          await msg.edit({
            text: `任务 <code>${taskId}</code> 不存在`,
            parseMode: "html",
          });
          return;
        }
        tasks.splice(taskIndex, 1);
        await db.write();
        await msg.edit({
          text: `任务 <code>${taskId}</code> 已删除`,
          parseMode: "html",
        });
      } else if (["disable", "off"].includes(command)) {
        const taskId = args[2];
        const db = await getDB();
        const tasks = db.data.tasks;
        const task = tasks.find((t) => t.id === taskId);
        if (!task) {
          await msg.edit({
            text: `任务 <code>${taskId}</code> 不存在`,
            parseMode: "html",
          });
          return;
        }
        task.status = "0";
        await db.write();
        await msg.edit({
          text: `任务 <code>${taskId}</code> 已禁用`,
          parseMode: "html",
        });
      } else if (["enable", "on"].includes(command)) {
        const taskId = args[2];
        const db = await getDB();
        const tasks = db.data.tasks;
        const task = tasks.find((t) => t.id === taskId);
        if (!task) {
          await msg.edit({
            text: `任务 <code>${taskId}</code> 不存在`,
            parseMode: "html",
          });
          return;
        }
        delete task.status;
        await db.write();
        await msg.edit({
          text: `任务 <code>${taskId}</code> 已启用`,
          parseMode: "html",
        });
      }
    },
  };
  listenMessageHandler?: ((msg: Api.Message) => Promise<void>) | undefined =
    async (msg: Api.Message) => {
      const db = await getDB();
      for (const { id, remark, match, action, status } of db.data.tasks) {
        if ("0" !== status) {
          let matched;
          try {
            matched = await exec(match, msg);
          } catch (e) {
            console.error(
              `[KITT] 任务 ${id}${remark ? ` ${remark}` : ""} 匹配时出错:`,
              e
            );
          }
          if (matched) {
            try {
              console.log(
                `[KITT] 任务 ${id}${remark ? ` ${remark}` : ""} 匹配成功`
              );
              await exec(action, msg);
            } catch (e) {
              console.error(
                `[KITT] 任务 ${id}${remark ? ` ${remark}` : ""} 执行时出错:`,
                e
              );
            }
          }
        }
      }
    };
}

export default new KittPlugin();

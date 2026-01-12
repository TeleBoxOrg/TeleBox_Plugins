import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { Api } from "telegram";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "isalive";

const commandName = `${mainPrefix}${pluginName}`;

const help_text = `<code>${commandName} 用户名/UID</code> - 活了么

可配置 <code>acron</code> 实现定时在某个群里查询某个用户活了么

<pre>${mainPrefix}acron cmd 0 0 12 * * * -1002514991425 定时在花火喵查询亚托莉活了么
${mainPrefix}isalive 1948276144</pre>

使用 UID 时, 需要满足一些条件 比如有过私聊之类的 目前本脚本会自动获取对话 所以私聊过的可以查到
https://docs.telethon.dev/en/stable/concepts/entities.html
`;

// HTML转义函数
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
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
function getLastOnlineDays(user: Api.User): number | null {
  if (!user.status) return null;
  if (
    user.status instanceof Api.UserStatusOnline ||
    user.status instanceof Api.UserStatusRecently
  ) {
    return 0;
  }
  if (user.status instanceof Api.UserStatusOffline) {
    if (user.status.wasOnline) {
      const days = Math.floor(
        (Date.now() - Number(user.status.wasOnline) * 1000) /
          (1000 * 60 * 60 * 24)
      );
      return Math.max(0, days);
    }
    return null;
  }
  if (user.status instanceof Api.UserStatusLastWeek) {
    return 7;
  }
  if (user.status instanceof Api.UserStatusLastMonth) {
    return 30;
  }
  return null;
}

function getLastOnlineDateTime(user: Api.User): string | null {
  if (!user.status) return null;
  if (user.status instanceof Api.UserStatusOnline) {
    return "在线";
  }
  if (user.status instanceof Api.UserStatusRecently) {
    return "最近上线";
  }
  if (user.status instanceof Api.UserStatusOffline) {
    if (user.status.wasOnline) {
      const date = new Date(Number(user.status.wasOnline) * 1000);
      return date.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    }
    return null;
  }
  if (user.status instanceof Api.UserStatusLastWeek) {
    return "一周内";
  }
  if (user.status instanceof Api.UserStatusLastMonth) {
    return "一个月内";
  }
  return null;
}

class IsAlivePlugin extends Plugin {
  description: string = `\nisalive\n\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    isalive: async (msg: Api.Message, trigger?: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "Client not initialized." });
        return;
      }

      const rawText = (msg.message || msg.text || "").trim();
      const [, ...args] = rawText.split(/\s+/);
      const input = args.join(" ").trim();

      if (!input) {
        await msg.edit({
          text: `Missing parameter.\n\n${help_text}`,
          parseMode: "html",
        });
        return;
      }

      let entity: Api.User | null = null;

      try {
        if (/^-?\d+$/.test(input)) {
          const userId = Number(input);
          await client.getDialogs({});
          entity = (await client.getEntity(userId)) as Api.User;
        } else {
          await client.getDialogs({});
          const username = input.startsWith("@") ? input : `@${input}`;
          entity = (await client.getEntity(username)) as Api.User;
        }
      } catch (error: any) {
        await msg.edit({
          text: `Failed to resolve user: ${htmlEscape(
            error?.message || String(error)
          )}`,
          parseMode: "html",
        });
        return;
      }

      if (!entity || entity.className !== "User") {
        await msg.edit({
          text: "Target is not a user or cannot be resolved.",
        });
        return;
      }

      const user = entity as Api.User;
      const name =
        [user.firstName, user.lastName].filter(Boolean).join(" ") || "N/A";
      const username = user.username ? `@${user.username}` : "N/A";
      const lastOnlineDays = getLastOnlineDays(user);
      const lastOnlineText =
        lastOnlineDays === null ? "未知" : String(lastOnlineDays);
      const lastOnlineDateTime = getLastOnlineDateTime(user);
      const lastOnlineDateTimeText = lastOnlineDateTime ?? "未知";
      const deletedText = user.deleted ? "是" : "否";
      const entityInfo = await formatEntity(user);
      const text = [
        "<b><i>活了么</i></b>\n",
        entityInfo.display,
        `最后上线时间: <code>${lastOnlineDateTimeText}</code>`,
        `最后上线天数: <code>${lastOnlineText}</code>`,
        `是否已销号: <code>${deletedText}</code>`,
      ]
        .filter((i) => i)
        .join("\n");

      await msg.edit({
        text,
        parseMode: "html",
      });
    },
  };
}

export default new IsAlivePlugin();

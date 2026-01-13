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

  return {
    id,
    entity,
    username: entity?.username || null,
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

// 获取用户状态图标
function getStatusIcon(user: Api.User): string {
  if (user.deleted) return "💀";
  if (user.scam || user.fake) return "⚠️";
  if (user.bot) return "🤖";
  if (user.verified) return "✅";
  if (user.premium) return "⭐";

  // 在线状态图标
  if (user.status instanceof Api.UserStatusOnline) return "🟢";
  if (user.status instanceof Api.UserStatusRecently) return "🟡";
  if (user.status instanceof Api.UserStatusOffline) return "⚪";
  return "⚫";
}

// 从群组成员中查找用户
async function findUserFromGroups(
  client: any,
  userId: number
): Promise<Api.User | null> {
  try {
    const dialogs = await client.getDialogs({ limit: 50 });
    for (const dialog of dialogs) {
      // 只检查群组和超级群组
      if (
        dialog.entity?.className === "Chat" ||
        dialog.entity?.className === "Channel"
      ) {
        try {
          const participants = await client.getParticipants(dialog.entity, {
            limit: 200,
          });
          for (const participant of participants) {
            if (
              participant.id?.toJSNumber?.() === userId ||
              Number(participant.id) === userId
            ) {
              return participant as Api.User;
            }
          }
        } catch {
          // 跳过无法获取成员的群组
          continue;
        }
      }
    }
  } catch (e) {
    console.error("findUserFromGroups error:", e);
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

        // 立即显示查询状态
        await msg.edit({
          text: "🔍 正在查询中...",
          parseMode: "html",
        });

        try {
          if (/^-?\d+$/.test(input)) {
            const userId = Number(input);
            // 先尝试常规方式获取
            await client.getDialogs({});
            try {
              entity = (await client.getEntity(userId)) as Api.User;
            } catch {
              // 常规方式失败，尝试从群组成员中查找
              await msg.edit({
                text: "🔍 正在从群组成员中查找用户...",
                parseMode: "html",
              });
              entity = await findUserFromGroups(client, userId);
            }
          } else {
            await client.getDialogs({});
            const username = input.startsWith("@") ? input : `@${input}`;
            entity = (await client.getEntity(username)) as Api.User;
          }
        } catch (error: any) {
          await msg.edit({
            text: `❌ 无法解析用户: ${htmlEscape(
              error?.message || String(error)
            )}\n\n<i>提示: 使用 UID 查询需要你与该用户有过交互（私聊、同群等）</i>`,
            parseMode: "html",
          });
          return;
        }

        if (!entity || entity.className !== "User") {
          await msg.edit({
            text: "❌ 查询失败，提供的用户名或ID可能不存在或有误。",
            parseMode: "html",
          });
          return;
        }

        const user = entity as Api.User;

        // 基本信息
        const entityInfo = await formatEntity(user);
        const lastOnlineDateTime = getLastOnlineDateTime(user);
        const lastOnlineDays = getLastOnlineDays(user);

        // 状态图标
        const statusIcon = getStatusIcon(user);

        // 获取当前对话的最后发言时间
        let lastMessageTime: string | null = null;
        try {
          const chatId = msg.chatId;
          if (chatId) {
            const messages = await client.getMessages(chatId, {
              fromUser: user.id,
              limit: 1,
            });
            if (messages && messages.length > 0 && messages[0].date) {
              const date = new Date(messages[0].date * 1000);
              lastMessageTime = date.toLocaleString("zh-CN", {
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
          }
        } catch {
          lastMessageTime = null;
        }

        // 构建输出
        const lines: string[] = [
          `<b>👤 用户信息</b>`,
          `${statusIcon} ${entityInfo.display}`,
        ];
        if (entityInfo.username) {
          lines.push(`├ 用户名: <code>@${entityInfo.username}</code>`);
        }
        lines.push(`└ 用户ID: <a href="tg://user?id=${user.id}">${user.id}</a>`);
        lines.push(`<b>📡 在线状态</b>`);
        lines.push(`├ 状态: <code>${lastOnlineDateTime ?? "未知"}</code>`);
        lines.push(`└ 天数: <code>${lastOnlineDays === null ? "未知" : lastOnlineDays + " 天"}</code>`);
        lines.push(`<b>💬 发言记录</b>`);
        lines.push(`└ 本群最后发言: <code>${lastMessageTime ?? "无记录"}</code>`);
        lines.push(`<b>🏷️ 账号属性</b>`);

        // 账号属性
        const attrs: string[] = [];
        if (user.verified) attrs.push("✅ 官方认证");
        if (user.premium) attrs.push("⭐ Premium");
        if (user.bot) attrs.push("🤖 机器人");
        if (user.scam) attrs.push("⚠️ 诈骗账号");
        if (user.fake) attrs.push("⚠️ 虚假账号");
        if (user.restricted) attrs.push("🚫 受限账号");
        if (user.deleted) attrs.push("💀 已销号");
        if (user.support) attrs.push("🛟 官方客服");

        if (attrs.length === 0) attrs.push("普通用户");

        attrs.forEach((attr, i) => {
          const prefix = i === attrs.length - 1 ? "└" : "├";
          lines.push(`${prefix} ${attr}`);
        });

        await msg.edit({
          text: lines.join("\n"),
          parseMode: "html",
        });
      },
    };
}

export default new IsAlivePlugin();

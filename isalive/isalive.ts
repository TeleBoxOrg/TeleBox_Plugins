import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { Api } from "teleproto";

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

function codeTag(text: string | number): string {
  return `<code>${htmlEscape(String(text))}</code>`;
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

// 生成趣味评语
function generateComment(
  user: Api.User,
  lastOnlineDays: number | null,
  lastMessageDate: Date | null
): string {
  const comments: string[] = [];

  // 特殊账号状态优先
  if (user.deleted) {
    const deletedComments = [
      "这号已经凉透了 💀",
      "人走茶凉，账号注销",
      "RIP，已销号",
      "曾经来过，如今已去",
      "已成为历史的尘埃...",
      "永别了，朋友",
    ];
    comments.push(deletedComments[Math.floor(Math.random() * deletedComments.length)]);
    return comments.join("\n├ ");
  }

  if (user.bot) {
    const botComments = [
      "我是机器人，不需要睡觉 🤖",
      "24小时待命中~",
      "机器人永不下线！",
      "人工智能，永远在线",
    ];
    comments.push(botComments[Math.floor(Math.random() * botComments.length)]);
    return comments.join("\n├ ");
  }

  // 根据在线状态生成评语
  if (lastOnlineDays !== null) {
    if (lastOnlineDays === 0) {
      const onlineComments = [
        "这货还活着！🎉",
        "活蹦乱跳的呢~",
        "生龙活虎！",
        "还在线上浪呢~",
        "正在摸鱼中...",
        "还没睡觉呢？",
      ];
      comments.push(onlineComments[Math.floor(Math.random() * onlineComments.length)]);
    } else if (lastOnlineDays <= 1) {
      const recentComments = [
        "昨天还在呢",
        "刚刚还活着",
        "应该还行吧~",
        "还热乎着呢",
      ];
      comments.push(recentComments[Math.floor(Math.random() * recentComments.length)]);
    } else if (lastOnlineDays <= 3) {
      const fewDaysComments = [
        "这几天有点安静...",
        "可能去忙别的了",
        "摸了几天鱼了",
        "暂时失踪中~",
      ];
      comments.push(fewDaysComments[Math.floor(Math.random() * fewDaysComments.length)]);
    } else if (lastOnlineDays <= 7) {
      const weekComments = [
        "一周没冒泡了",
        "该不会是触电了？",
        "是不是去旅游了",
        "有点危险的信号...",
      ];
      comments.push(weekComments[Math.floor(Math.random() * weekComments.length)]);
    } else if (lastOnlineDays <= 30) {
      const monthComments = [
        "这货很久没出现了...",
        "人呢？？？",
        "建议去看看急诊",
        "怕不是注销了吧",
        "快派人找找！",
      ];
      comments.push(monthComments[Math.floor(Math.random() * monthComments.length)]);
    } else {
      const longTimeComments = [
        "已经凉凉了 💀",
        "建议报警寻人",
        "这号估计废了",
        "默哀三秒钟...",
        "永远怀念 TA",
        "化石级选手！",
      ];
      comments.push(longTimeComments[Math.floor(Math.random() * longTimeComments.length)]);
    }
  } else {
    comments.push("神秘人物，行踪成谜 🕵️");
  }

  // 根据最后发言时间补充评语
  if (lastMessageDate) {
    const daysSinceMessage = Math.floor(
      (Date.now() - lastMessageDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysSinceMessage === 0) {
      const talkingComments = [
        "话唠本唠",
        "刚刚还在唠嗑",
        "活跃分子！",
      ];
      comments.push(talkingComments[Math.floor(Math.random() * talkingComments.length)]);
    } else if (daysSinceMessage <= 3) {
      // 最近发过言，不添加额外评语
    } else if (daysSinceMessage <= 7) {
      comments.push("潜水一周了...");
    } else if (daysSinceMessage <= 30) {
      comments.push("本群潜水员认证 🤿");
    } else if (daysSinceMessage <= 90) {
      comments.push("三个月没说话，是不是屏蔽群了？");
    } else {
      comments.push("化石级潜水员！上次发言都不知道啥时候了");
    }
  }

  return comments.length > 0 ? comments.join("\n├ ") : "";
}

// 从群组成员中查找用户
async function findUserFromGroups(
  client: any,
  userId: number
): Promise<Api.User | null> {
  const dialogMap = new Map<string, any>();

  const collectDialogs = async (params: Record<string, any>) => {
    try {
      const dialogs = await client.getDialogs(params);
      for (const dialog of dialogs || []) {
        const key = `${dialog.id}`;
        if (!dialogMap.has(key)) {
          dialogMap.set(key, dialog);
        }
      }
    } catch (error) {
      console.error("findUserFromGroups getDialogs error:", error);
    }
  };

  try {
    await collectDialogs({});
    await collectDialogs({ folderId: 1 });

    for (const dialog of dialogMap.values()) {
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
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

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
        let lastMessageDate: Date | null = null;
        try {
          const chatId = msg.chatId;
          if (chatId) {
            const messages = await client.getMessages(chatId, {
              fromUser: user.id,
              limit: 1,
            });
            if (messages && messages.length > 0 && messages[0].date) {
              const date = new Date(messages[0].date * 1000);
              lastMessageDate = date;
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
          lastMessageDate = null;
        }

        // 生成趣味评语
        const comment = generateComment(user, lastOnlineDays, lastMessageDate);

        // 构建输出
        const lines: string[] = [
          `<b>👤 用户信息</b>`,
          `${statusIcon} ${entityInfo.display}`,
        ];
        if (entityInfo.username) {
          lines.push(`├ 用户名: ${codeTag(`@${entityInfo.username}`)}`);
        }
        lines.push(`└ 用户ID: <a href="tg://user?id=${user.id}">${user.id}</a>`);
        lines.push(`<b>📡 在线状态</b>`);
        lines.push(`├ 状态: ${codeTag(lastOnlineDateTime ?? "未知")}`);
        lines.push(`└ 天数: ${codeTag(lastOnlineDays === null ? "未知" : lastOnlineDays + " 天")}`);
        lines.push(`<b>💬 发言记录</b>`);
        lines.push(`└ 本群最后发言: ${codeTag(lastMessageTime ?? "无记录")}`);
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

        // 添加趣味评语
        if (comment) {
          lines.push("");
          lines.push(`<b>📝 评语</b>`);
          lines.push(`└ ${comment}`);
        }

        await msg.edit({
          text: lines.join("\n"),
          parseMode: "html",
        });
      },
    };
}

export default new IsAlivePlugin();

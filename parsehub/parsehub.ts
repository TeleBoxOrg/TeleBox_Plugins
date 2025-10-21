import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";
import { sleep } from "telegram/Helpers";

const BOT_USERNAME = "ParseHubot";
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_DURATION_MS = 3 * 60 * 1000;
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "parsehub";
const commandName = `${mainPrefix}${pluginName}`;

const helpText = `
依赖 @ParseHubot

<code>${commandName} 链接</code> 解析社交媒体链接（支持多条，空格或换行分隔）

示例：
<code>${commandName} https://twitter.com/user/status/123</code>
<code>${commandName} https://www.instagram.com/p/xxxx/</code>
`.trim();

const htmlEscape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      })[ch] || ch,
  );

let hasStartedBot = false;

function extractLinks(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/(?:https?:\/\/|www\.)\S+/gi) || [];
  const sanitized = matches.map((raw) => {
    const cleaned = raw.replace(
      /[)\]\}\u3002\uff1a\uff01\uff1f\u3001\uff0c>]+$/u,
      "",
    );
    return cleaned.startsWith("http") ? cleaned : `https://${cleaned}`;
  });
  return Array.from(new Set(sanitized.map((link) => link.trim()))).filter(
    Boolean,
  );
}

async function ensureBotReady(msg: Api.Message) {
  const client = msg.client;
  if (!client) return;
  try {
    await client.invoke(new Api.contacts.Unblock({ id: BOT_USERNAME }));
  } catch {}

  try {
    const inputPeer = await client.getInputEntity(BOT_USERNAME);
    await client.invoke(
      new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer: inputPeer }),
        settings: new Api.InputPeerNotifySettings({
          silent: true,
          muteUntil: 2147483647,
        }),
      }),
    );
  } catch {}

  if (hasStartedBot) {
    return;
  }

  try {
    const history = await client.getMessages(BOT_USERNAME, { limit: 1 });
    if (history.length > 0) {
      hasStartedBot = true;
      return;
    }
  } catch {}

  try {
    await client.invoke(
      new Api.messages.StartBot({
        bot: BOT_USERNAME,
        peer: BOT_USERNAME,
        startParam: "",
      }),
    );
    hasStartedBot = true;
  } catch {
    try {
      await client.sendMessage(BOT_USERNAME, { message: "/start" });
      hasStartedBot = true;
    } catch {}
  }
}

function buildStatusText(
  link: string,
  botMessage: Api.Message | null,
  state: "pending" | "done" | "timeout",
): string {
  const prefix =
    state === "done"
      ? "✅ 解析完成"
      : state === "timeout"
        ? "⌛ 超时结束"
        : "🔄 等待解析";
  const intro = `${prefix}\n<b>${htmlEscape(link)}</b>`;

  if (!botMessage) {
    return `${intro}\n\n尚未收到 @${BOT_USERNAME} 的回复，请稍后重试。`;
  }

  const text = botMessage.message?.trim();
  const snippet = text
    ? htmlEscape(text.length > 3500 ? `${text.slice(0, 3500)}…` : text)
    : botMessage.media
      ? "🖼️ Bot 返回了多媒体内容，已尝试直接转发。"
      : "ℹ️ Bot 返回了空消息。";

  const updatedAt =
    botMessage.editDate || botMessage.date || Math.floor(Date.now() / 1000);
  const timestamp = new Date(updatedAt * 1000).toLocaleString();

  return `${intro}\n\n${snippet}\n\n来源：@${BOT_USERNAME}\n更新时间：<code>${htmlEscape(timestamp)}</code>`;
}

async function forwardBotMessage(
  msg: Api.Message,
  statusMessage: Api.Message,
  botMessage: Api.Message,
  forward: boolean,
  botPeer: Api.TypeInputPeer | string,
) {
  const client = msg.client;
  if (!client) return;

  if (forward) {
    try {
      await client.forwardMessages(msg.peerId, {
        messages: [botMessage.id],
        fromPeer: botPeer,
      });
    } catch (error: any) {
      const fallback = botMessage.message?.trim();
      if (fallback) {
        await client.sendMessage(msg.peerId, {
          message: `📨 @${BOT_USERNAME} 最新内容（转发失败，转文本展示）：\n\n${fallback}`,
          replyTo: statusMessage.id,
        });
      } else {
        await client.sendMessage(msg.peerId, {
          message: `⚠️ 未能转发 @${BOT_USERNAME} 的多媒体消息，请前往私聊查看。`,
          replyTo: statusMessage.id,
        });
      }
    }
  }
}

async function processLink(
  msg: Api.Message,
  link: string,
  baselineId: number,
): Promise<number> {
  const client = msg.client;
  if (!client) return baselineId;

  const statusMessage = await client.sendMessage(msg.peerId, {
    message: `⏳ 正在解析 <b>${htmlEscape(link)}</b>，请稍候…`,
    parseMode: "html",
    replyTo: msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId || msg.id,
  });

  let lastBotMessageId = baselineId;
  let latestBotMessage: Api.Message | null = null;
  let lastActivity = Date.now();
  let botPeer: Api.TypeInputPeer | string = BOT_USERNAME;

  try {
    botPeer = await client.getInputEntity(BOT_USERNAME);
  } catch {}

  try {
    const history = await client.getMessages(BOT_USERNAME, { limit: 1 });
    if (history.length > 0) {
      lastBotMessageId = Math.max(lastBotMessageId, history[0].id);
    }
  } catch {}

  await client.sendMessage(BOT_USERNAME, { message: link });

  const deadline = Date.now() + MAX_POLL_DURATION_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let updateDetected = false;
    let messages: Api.Message[] = [];

    try {
      messages = await client.getMessages(BOT_USERNAME, { limit: 10 });
    } catch (error: any) {
      await statusMessage.edit({
        text: `❌ 获取 @${BOT_USERNAME} 消息失败：${htmlEscape(error.message || String(error))}`,
        parseMode: "html",
      });
      break;
    }

    const chronological = messages.slice().reverse();
    for (const botMsg of chronological) {
      if (botMsg.out) continue;
      if (botMsg.id <= lastBotMessageId) continue;

      lastBotMessageId = botMsg.id;
      latestBotMessage = botMsg;
      lastActivity = Date.now();
      updateDetected = true;

      await forwardBotMessage(msg, statusMessage, botMsg, true, botPeer);
      await statusMessage.edit({
        text: buildStatusText(link, botMsg, "pending"),
        parseMode: "html",
      });
    }

    if (!updateDetected && latestBotMessage) {
      const newest = messages.find(
        (m) =>
          !m.out &&
          m.id === latestBotMessage?.id &&
          ((m.editDate || 0) > (latestBotMessage?.editDate || 0) ||
            (m.message || "") !== (latestBotMessage?.message || "")),
      );

      if (newest) {
        latestBotMessage = newest;
        lastActivity = Date.now();
        updateDetected = true;
        await statusMessage.edit({
          text: buildStatusText(link, newest, "pending"),
          parseMode: "html",
        });
      }
    }

    if (!updateDetected && Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      break;
    }
  }

  const timedOut = Date.now() >= deadline;
  const idleTimeout = Date.now() - lastActivity > IDLE_TIMEOUT_MS && !timedOut;
  const finalState: "pending" | "done" | "timeout" =
    latestBotMessage && !timedOut ? "done" : "timeout";

  await statusMessage.edit({
    text: buildStatusText(
      link,
      latestBotMessage,
      finalState === "timeout" && !latestBotMessage ? "timeout" : finalState,
    ),
    parseMode: "html",
  });

  if (!latestBotMessage) {
    await client.sendMessage(msg.peerId, {
      message: `⚠️ 在 3 分钟内未收到 @${BOT_USERNAME} 的任何回复，请稍后重试或直接私聊机器人处理。`,
      replyTo: statusMessage.id,
    });
  }

  if (idleTimeout && latestBotMessage) {
    await client.sendMessage(msg.peerId, {
      message: `ℹ️ @${BOT_USERNAME} 在 ${Math.round(
        (Date.now() - lastActivity) / 1000,
      )} 秒内未继续更新，已返回最新状态。`,
      replyTo: statusMessage.id,
    });
  }

  return lastBotMessageId;
}

class ParseHubPlugin extends Plugin {
  description: string = `\nparsehub\n\n${helpText}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    parsehub: async (msg: Api.Message) => {
      const rawText = msg.message || "";
      const cleaned = rawText.replace(
        new RegExp(`^${commandName}\\s*`, "i"),
        "",
      );
      const links = extractLinks(cleaned);

      if (!links.length) {
        await msg.edit({ text: helpText, parseMode: "html" });
        return;
      }

      await msg.edit({
        text: `🚀 将 ${links.length} 条链接发送至 @${BOT_USERNAME}，请稍候...`,
        parseMode: "html",
      });

      await ensureBotReady(msg);

      let baselineId = 0;
      for (const link of links) {
        baselineId = await processLink(msg, link, baselineId);
        await sleep(500);
      }

      try {
        await msg.delete();
      } catch {}
    },
  };
}

export default new ParseHubPlugin();

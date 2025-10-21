import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";
import { sleep } from "telegram/Helpers";

const BOT_USERNAME = "ParseHubot";
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 3 * 60 * 1000;
const RESULT_IDLE_MS = 5000;
const FETCH_LIMIT = 50;

const PROGRESS_PREFIXES = [
  "解 析 中",
  "已有相同任务正在解析",
  "下 载 中",
  "上 传 中",
] as const;

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "parsehub";
const commandName = `${mainPrefix}${pluginName}`;

const helpText = `
依赖 @ParseHubot

<code>${commandName} 链接</code> 解析社交媒体链接

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

const isProgressText = (text?: string | null): boolean => {
  if (!text) return false;
  const trimmed = text.trim();
  return PROGRESS_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
};

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

async function getLatestBotMessageId(client: any): Promise<number> {
  if (!client) return 0;
  try {
    const history = await client.getMessages(BOT_USERNAME, { limit: 1 });
    if (history.length > 0) {
      return history[0].id;
    }
  } catch {}
  return 0;
}

type RelayReason = "timeout" | "fetch_failed" | "send_failed" | "no_client";

interface RelayOutcome {
  lastId: number;
  forwarded: boolean;
  reason?: RelayReason;
  error?: string;
}

const describeReason = (reason?: RelayReason): string => {
  switch (reason) {
    case "timeout":
      return "等待超时";
    case "fetch_failed":
      return "获取机器人消息失败";
    case "send_failed":
      return "向机器人发送链接失败";
    case "no_client":
      return "客户端未就绪";
    default:
      return "原因未知";
  }
};

async function forwardChunk(client: any, peer: any, ids: number[]) {
  await client.forwardMessages(peer, {
    fromPeer: BOT_USERNAME,
    messages: ids,
  });
}

async function relayParseResult(
  originMsg: Api.Message,
  link: string,
  baselineId: number,
): Promise<RelayOutcome> {
  const client = originMsg.client;
  if (!client) {
    return { lastId: baselineId, forwarded: false, reason: "no_client" };
  }

  try {
    await client.sendMessage(BOT_USERNAME, { message: link });
  } catch (error: any) {
    return {
      lastId: baselineId,
      forwarded: false,
      reason: "send_failed",
      error: error?.message || String(error),
    };
  }

  const processedIds = new Set<number>();
  const finalMessages = new Map<number, Api.Message>();

  const deadline = Date.now() + MAX_WAIT_MS;
  let lastId = baselineId;
  let lastFinalActivity = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let messages: Api.Message[] = [];
    try {
      messages = await client.getMessages(BOT_USERNAME, { limit: FETCH_LIMIT });
    } catch (error: any) {
      return {
        lastId,
        forwarded: false,
        reason: "fetch_failed",
        error: error?.message || String(error),
      };
    }

    messages.sort((a, b) => a.id - b.id);

    for (const botMsg of messages) {
      if (!botMsg || (botMsg as any).className === "MessageService") continue;
      if (botMsg.out) continue;
      if (botMsg.id <= lastId) continue;
      if (processedIds.has(botMsg.id)) continue;

      processedIds.add(botMsg.id);
      lastId = Math.max(lastId, botMsg.id);

      const text = botMsg.message?.trim();
      if (isProgressText(text)) {
        continue;
      }

      finalMessages.set(botMsg.id, botMsg);
      lastFinalActivity = Date.now();
    }

    if (
      finalMessages.size > 0 &&
      Date.now() - lastFinalActivity >= RESULT_IDLE_MS
    ) {
      break;
    }
  }

  if (finalMessages.size === 0) {
    return { lastId, forwarded: false, reason: "timeout" };
  }

  const sortedMessages = Array.from(finalMessages.values()).sort(
    (a, b) => a.id - b.id,
  );

  let forwarded = false;
  const fallbackTexts: string[] = [];

  for (let i = 0; i < sortedMessages.length; i += 100) {
    const chunk = sortedMessages.slice(i, i + 100);
    const ids = chunk.map((m) => m.id);

    try {
      await forwardChunk(client, originMsg.peerId, ids);
      forwarded = true;
    } catch {
      const snippet = chunk
        .map((m) => m.message?.trim())
        .filter(Boolean)
        .join("\n\n");
      fallbackTexts.push(
        snippet.length
          ? snippet
          : `⚠️ 未能转发 @${BOT_USERNAME} 的多媒体结果，请前往私聊机器人查看。`,
      );
    }
  }

  if (!forwarded && fallbackTexts.length) {
    try {
      await client.sendMessage(originMsg.peerId, {
        message: `📨 @${BOT_USERNAME} 返回内容：\n\n${fallbackTexts.join("\n\n")}`,
        replyTo: originMsg.id,
      });
      forwarded = true;
    } catch {}
  }

  return {
    lastId,
    forwarded,
    reason: forwarded ? undefined : "timeout",
  };
}

class ParseHubPlugin extends Plugin {
  description: string = `\n${pluginName}\n\n${helpText}`;
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
        text: `✅ 已提交链接至 @${BOT_USERNAME}，正在解析中，请等待。`,
        parseMode: "html",
      });

      await ensureBotReady(msg);
      const client = msg.client;
      if (!client) {
        await msg.edit({
          text: `❌ 无法获取 Telegram 客户端实例，请稍后重试。`,
        });
        return;
      }

      let baselineId = await getLatestBotMessageId(client);

      for (const link of links) {
        const outcome = await relayParseResult(msg, link, baselineId);
        baselineId = outcome.lastId;

        if (!outcome.forwarded) {
          const reasonText = describeReason(outcome.reason);
          const detail =
            outcome.error && outcome.error !== "undefined"
              ? `\n\n错误信息：${outcome.error}`
              : "";
          await client.sendMessage(msg.peerId, {
            message: `⚠️ 未能获取 <b>${htmlEscape(link)}</b> 的最终结果（${reasonText}）。请稍后重试或直接私聊 @${BOT_USERNAME}。${detail}`,
            parseMode: "html",
            replyTo: msg.id,
          });
        }

        await sleep(600);
      }

      try {
        await msg.delete();
      } catch {}
    },
  };
}

export default new ParseHubPlugin();

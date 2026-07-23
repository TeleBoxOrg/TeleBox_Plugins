import { Plugin, type PanelSettingsAdapter, type PanelSettingField, type PanelFieldType } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";
import * as fs from "fs";
import { safeGetMessages, safeGetReplyMessage } from "@utils/safeGetMessages";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/runtimeManager";
import { tl, Long } from "@mtcute/node";
import { Message } from "@mtcute/core";
import { logger } from "@utils/logger";
import { sleep } from "@utils/asyncHelpers";
import { getErrorMessage } from "@utils/errorHelpers";
import { htmlEscape } from "@utils/htmlEscape";

const BOT_USERNAME = "ParseHubot";
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 10 * 60 * 1000; // large media upload can exceed 3min
const RESULT_IDLE_MS = 5000;
const PROGRESS_EXTEND_MS = 2 * 60 * 1000; // keep waiting while bot still reports progress
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

1) 直接命令：<code>${commandName} 链接</code>
2) 回复消息后使用：在含链接的消息上回复 <code>${commandName}</code>

目前支持的平台:
抖音视频|图文
哔哩哔哩视频|动态
YouTube
YouTube Music
TikTok视频|图文
小红书视频|图文
Twitter视频|图文
百度贴吧视频|图文
Facebook视频
微博视频|图文
Instagram视频|图文

示例：
<code>${commandName} https://twitter.com/user/status/123</code>
<code>${commandName} https://www.instagram.com/p/xxxx/</code>
`.trim();

let hasStartedBot = false;
let firstRunPreStartLastId = 0;
let shouldIgnoreNextBotMessage = false;

type InitState = {
  initialized: boolean;
  ignoredUpToId?: number;
};

const STATE_DIR = createDirectoryInAssets(pluginName);
const STATE_PATH = path.join(STATE_DIR, "state.json");

function readState(): InitState {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      initialized: Boolean(parsed?.initialized),
      ignoredUpToId: Number.isFinite(parsed?.ignoredUpToId)
        ? Number(parsed.ignoredUpToId)
        : undefined,
    };
  } catch (_e: unknown) {
    return { initialized: false };
  }
}

function writeState(state: InitState) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state), "utf-8");
  } catch (e: unknown) { logger.warn('[parsehub] state write failed:', e) }
}

let initState: InitState = readState();
let ignoredUpToId = Number(initState.ignoredUpToId || 0) || 0;

// Common progress prefix decoration characters (blocks, emoji, zero-width)
const PROGRESS_DECO_RE = /^[\s\u2580-\u259F\u25A0-\u25FF\u2000-\u200F\uFEFF\u3000]+/u;

const isProgressText = (text?: string | null): boolean => {
  if (!text) return false;
  // Strip common decorative prefix chars first (blocks, emoji, zero-width, ideographic space)
  const stripped = text.replace(PROGRESS_DECO_RE, "").trim();
  return PROGRESS_PREFIXES.some((prefix) => stripped.startsWith(prefix));
};

/** True when message carries real media (mtcute returns null for empty). */
function hasMediaPayload(msg: Message): boolean {
  return msg.media != null;
}

function isFinalBotMessage(msg: Message): boolean {
  // Media always wins — bot may edit progress text in place while attaching file
  if (hasMediaPayload(msg)) return true;
  const text = msg.text?.trim() || "";
  if (isProgressText(text)) return false;
  return Boolean(text);
}

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

async function ensureBotReady(msg: MessageContext) {
  const client = await getGlobalClient();
  if (!client) return;

  let botPeer: tl.TypeInputPeer;
  let botUser: tl.TypeInputUser;
  try {
    botPeer = await client.resolvePeer(BOT_USERNAME);
    botUser = await client.resolveUser(BOT_USERNAME);
  } catch (e: unknown) { logger.warn('[parsehub] resolve failed:', e); return; }

  try {
    await client.call({ _: "contacts.unblock", id: botPeer });
  } catch (e: unknown) { logger.warn('[parsehub] unblock failed:', e) }

  try {
    const inputPeer = await client.resolvePeer(BOT_USERNAME);
    await client.call({
      _: "account.updateNotifySettings",
      peer: { _: "inputNotifyPeer", peer: inputPeer },
      settings: {
        _: "inputPeerNotifySettings",
        silent: true,
        muteUntil: 2147483647,
      },
    });
  } catch (e: unknown) { logger.warn('[parsehub] notify settings update failed:', e) }

  if (hasStartedBot) {
    return;
  }

  try {
    const history = await client.getHistory(BOT_USERNAME, { limit: 1 });
    if (history.length > 0) {
      hasStartedBot = true;
      return;
    }
  } catch (e: unknown) { logger.warn('[parsehub] history fetch failed:', e) }

  try {
    if (!initState.initialized) {
      firstRunPreStartLastId = await getLatestBotMessageId(client);
      shouldIgnoreNextBotMessage = true;
    }
    await client.call({
      _: "messages.startBot",
      bot: botUser,
      peer: botPeer,
      randomId: Long.fromNumber(Date.now()),
      startParam: "",
    });
    hasStartedBot = true;
  } catch (e: unknown) {
    try {
      if (!initState.initialized) {
        firstRunPreStartLastId = await getLatestBotMessageId(client);
        shouldIgnoreNextBotMessage = true;
      }
      await client.sendText(BOT_USERNAME, "/start");
      hasStartedBot = true;
    } catch (e: unknown) { logger.warn('[parsehub] send /start failed:', e) }
  }

  // Best-effort: capture welcome message id to avoid mis-forwarding
  if (!initState.initialized && client) {
    const deadline = Date.now() + 10000; // up to 10s to observe welcome
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        const latestId = await getLatestBotMessageId(client);
        if (latestId > firstRunPreStartLastId && latestId > ignoredUpToId) {
          ignoredUpToId = latestId;
          initState.initialized = true;
          initState.ignoredUpToId = latestId;
          writeState(initState);
          shouldIgnoreNextBotMessage = false;
          break;
        }
      } catch (e: unknown) { logger.warn('[parsehub] latest id fetch failed:', e) }
    }
  }
}

async function getLatestBotMessageId(client: TelegramClient): Promise<number> {
  if (!client) return 0;
  try {
    const history = await client.getHistory(BOT_USERNAME, { limit: 1 });
    if (history.length > 0) {
      return history[0].id;
    }
  } catch (e: unknown) { logger.warn('获取历史记录失败', e) }
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

async function forwardChunk(client: TelegramClient, peer: string | number, ids: number[]) {
  await client.forwardMessagesById({
    toChatId: peer,
    fromChatId: BOT_USERNAME,
    messages: ids,
    noAuthor: true,
  });
}

async function relayParseResult(
  originMsg: MessageContext,
  link: string,
  baselineId: number,
): Promise<RelayOutcome> {
  const client = await getGlobalClient();
  if (!client) {
    return { lastId: baselineId, forwarded: false, reason: "no_client" };
  }

  try {
    await client.sendText(BOT_USERNAME, link);
  } catch (error: unknown) {
    return {
      lastId: baselineId,
      forwarded: false,
      reason: "send_failed",
      error: getErrorMessage(error),
    };
  }

  // Progress msgs (解析中/下载中/上传中) often keep the SAME id and are later
  // edited into the final media. Never permanently skip them via processedIds.
  const progressIds = new Set<number>();
  const finalMessages = new Map<number, Message>();

  let deadline = Date.now() + MAX_WAIT_MS;
  let lastId = baselineId;
  let lastFinalActivity = 0;
  let lastProgressActivity = Date.now();
  let firstRunIgnore = shouldIgnoreNextBotMessage;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let messages: Message[] = [];
    try {
      messages = await client.getHistory(BOT_USERNAME, { limit: FETCH_LIMIT });
    } catch (error: unknown) {
      return {
        lastId,
        forwarded: false,
        reason: "fetch_failed",
        error: getErrorMessage(error),
      };
    }

    messages.sort((a: Message, b: Message) => a.id - b.id);

    for (const botMsg of messages) {
      if (!botMsg) continue;
      if (botMsg.isOutgoing) continue;
      if (botMsg.id <= baselineId) continue;

      const text = botMsg.text?.trim() || "";

      // Still a progress status (may be the same msg id as before)
      if (isProgressText(text) && !hasMediaPayload(botMsg)) {
        // Stale progress left behind after a newer final result must not block forwarding
        const maxFinalId = finalMessages.size
          ? Math.max(...Array.from(finalMessages.keys()))
          : 0;
        if (maxFinalId > botMsg.id) {
          progressIds.delete(botMsg.id);
          continue;
        }
        progressIds.add(botMsg.id);
        lastId = Math.max(lastId, botMsg.id);
        lastProgressActivity = Date.now();
        // Only extend while we do not yet have a final result
        if (finalMessages.size === 0) {
          const extended = Date.now() + PROGRESS_EXTEND_MS;
          if (extended > deadline) deadline = extended;
          const hardCap = Date.now() + 30 * 60 * 1000;
          if (deadline > hardCap) deadline = hardCap;
        }
        continue;
      }

      if (!isFinalBotMessage(botMsg)) {
        // Empty service-ish noise: mark high-water but do not forward
        lastId = Math.max(lastId, botMsg.id);
        continue;
      }

      // First-run welcome /start reply: skip once
      if (firstRunIgnore && !hasMediaPayload(botMsg)) {
        firstRunIgnore = false;
        shouldIgnoreNextBotMessage = false;
        ignoredUpToId = botMsg.id;
        initState.initialized = true;
        initState.ignoredUpToId = botMsg.id;
        writeState(initState);
        continue;
      }

      const isNew = botMsg.id > lastId || progressIds.has(botMsg.id) || !finalMessages.has(botMsg.id);
      if (!isNew && finalMessages.has(botMsg.id)) {
        // already captured; still refresh object in case caption/media changed
        finalMessages.set(botMsg.id, botMsg);
        continue;
      }

      progressIds.delete(botMsg.id);
      finalMessages.set(botMsg.id, botMsg);
      lastId = Math.max(lastId, botMsg.id);
      lastFinalActivity = Date.now();
    }

    // Prefer break when we have finals AND progress has gone quiet
    if (
      finalMessages.size > 0 &&
      progressIds.size === 0 &&
      Date.now() - lastFinalActivity >= RESULT_IDLE_MS
    ) {
      break;
    }

    // If we only ever saw progress and it went silent for a long time, keep looping until deadline
    if (
      finalMessages.size > 0 &&
      progressIds.size > 0 &&
      Date.now() - lastProgressActivity >= RESULT_IDLE_MS * 3 &&
      Date.now() - lastFinalActivity >= RESULT_IDLE_MS
    ) {
      // progress stuck without turning into final — forward what we have
      break;
    }
  }

  if (finalMessages.size === 0) {
    return { lastId, forwarded: false, reason: "timeout" };
  }

  const sortedMessages = Array.from(finalMessages.values()).sort(
    (a: Message, b: Message) => a.id - b.id,
  );

  let forwarded = false;
  const fallbackTexts: string[] = [];

  // Sequential forwarding: each chunk uses fallback text on failure, so order matters
  for (let i = 0; i < sortedMessages.length; i += 100) {
    const chunk = sortedMessages.slice(i, i + 100);
    const ids = chunk.map((m: Message) => m.id);

    try {
      await forwardChunk(client, originMsg.chat.id, ids);
      forwarded = true;
    } catch (_e: unknown) {
      const snippet = chunk
        .map((m: Message) => m.text?.trim())
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
      await client.sendText(originMsg.chat.id, `📨 @${BOT_USERNAME} 返回内容：\n\n${fallbackTexts.join("\n\n")}`, {
        replyTo: originMsg.id,
      });
      forwarded = true;
    } catch (e: unknown) { logger.warn('[parsehub] send to origin failed:', e) }
  }

  return {
    lastId,
    forwarded,
    reason: forwarded ? undefined : "timeout",
  };
}

class ParseHubPlugin extends Plugin {
  description = helpText;

  cmdHandlers = {
    parsehub: async (msg: MessageContext) => {
      await ensureBotReady(msg);

      const client = await getGlobalClient();
      if (!client) return;

      const links = extractLinks(msg.text || "");
      const replyLinks = msg.replyToMessage
        ? extractLinks(msg.replyToMessage.text || "")
        : [];
      const allLinks = [...new Set([...links, ...replyLinks])];

      if (allLinks.length === 0) {
        await msg.edit({ text: html(helpText) });
        return;
      }

      const baselineId = initState.ignoredUpToId || 0;

      for (const link of allLinks) {
        const outcome = await relayParseResult(msg, link, baselineId);

        const reasonText = describeReason(outcome.reason);
        const detail = outcome.error ? ` (${htmlEscape(outcome.error)})` : "";

        if (!outcome.forwarded) {
          await client.sendText(msg.chat.id, html(`⚠️ 未能获取 <b>${htmlEscape(link)}</b> 的最终结果（${reasonText}）。请稍后重试或直接私聊 @${BOT_USERNAME}。${detail}`), {
            replyTo: msg.id,
          });
        }

        await sleep(600);
      }

      try {
        await msg.delete();
      } catch (e: unknown) { logger.warn('[parsehub] msg already deleted:', e) }
    },
  };

  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "parsehub",
    title: "ParseHub 解析",
    description: "链接解析插件状态：初始化状态、忽略消息 ID",
    category: "插件配置",
    icon: "🔗",
    getSchema: (): PanelSettingField[] => [
      {
        key: "initialized",
        label: "已初始化",
        type: "boolean",
        default: false,
        description: "是否已完成首次启动初始化",
      },
      {
        key: "ignoredUpToId",
        label: "忽略消息 ID",
        type: "number",
        min: 0,
        default: 0,
        description: "启动时忽略的最大消息 ID (避免处理历史消息)",
      },
      {
        key: "resetState",
        label: "重置状态",
        type: "boolean",
        default: false,
        description: "开启后保存将清空状态文件 (需手动关闭)",
      },
    ],
    getValues: async () => {
      const state = readState();
      return {
        initialized: state.initialized,
        ignoredUpToId: state.ignoredUpToId || 0,
        resetState: false,
      };
    },
    setValues: async (patch: Record<string, unknown>) => {
      if (patch.resetState === true) {
        try {
          fs.unlinkSync(STATE_PATH);
          logger.info("[parsehub] State file reset via panel");
        } catch { }
        return;
      }

      const state: InitState = {
        initialized: Boolean(patch.initialized ?? initState.initialized),
        ignoredUpToId: Number(patch.ignoredUpToId ?? initState.ignoredUpToId || 0) || 0,
      };
      writeState(state);
      initState = state;
      ignoredUpToId = state.ignoredUpToId || 0;
    },
  };
}

export default new ParseHubPlugin();
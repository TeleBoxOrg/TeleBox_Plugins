import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import type { Low } from "lowdb";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { Api } from "telegram";
import { sleep } from "telegram/Helpers";
import { RPCError } from "telegram/errors";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "bs";
const commandName = `${mainPrefix}${pluginName}`;

const MODE_SEQUENCE = "sequence" as const;
const MODE_BROADCAST = "broadcast" as const;

type TargetRecord = {
  id: string;
  target: string; // 用户输入的对话 ID/@name
  chatId?: string; // 解析后的对话 ID
  topicId?: string; // 话题 ID（字符串）
  display?: string; // 展示名称
  status?: "0"; // "0" 表示禁用
  createdAt: string;
  updatedAt?: string;
};

type BsMode = typeof MODE_SEQUENCE | typeof MODE_BROADCAST;

type BsDB = {
  seq: string;
  mode: BsMode;
  targets: TargetRecord[];
};

const defaultTargets: TargetRecord[] = [];

type ForwardSuccess = {
  target: TargetRecord;
  forwarded: Api.Message[];
  entity: any;
};

const filePath = path.join(createDirectoryInAssets(pluginName), "config.json");

let dbPromise: Promise<Low<BsDB>> | null = null;

async function getDB() {
  if (!dbPromise) {
    dbPromise = JSONFilePreset<BsDB>(filePath, {
      seq: String(defaultTargets.length),
      mode: MODE_SEQUENCE,
      targets: defaultTargets,
    });
  }
  const db = await dbPromise;

  const data = (db.data ??= {
    seq: String(defaultTargets.length),
    mode: MODE_SEQUENCE,
    targets: [...defaultTargets],
  });

  if (!Array.isArray(data.targets)) {
    data.targets = [];
  }

  if (!data.mode) {
    data.mode = MODE_SEQUENCE;
  }

  const maxId = data.targets.reduce((max, target) => {
    const idNum = Number(target.id);
    return Number.isFinite(idNum) ? Math.max(max, idNum) : max;
  }, 0);

  const seqNum = Number(data.seq);
  if (!Number.isFinite(seqNum) || seqNum < maxId) {
    data.seq = String(maxId);
  }

  return db;
}

function nextId(db: Low<BsDB>): string {
  const current = Number(db.data?.seq ?? "0");
  const next = Number.isFinite(current) ? current + 1 : 1;
  db.data!.seq = String(next);
  return String(next);
}

function toInt(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function toStrInt(value: any): string | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : undefined;
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
    displayParts.push(`<code>${escapeHtml(String(target))}</code>`);
  }

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}

function escapeHtml(text: string): string {
  const escaped = (text || "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#x27;";
      default:
        return ch;
    }
  });
  return escaped.replace(/\n/g, "<br>");
}

function escapeAttribute(text: string): string {
  return (text || "").replace(/[&<>"]/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return ch;
    }
  });
}

function resolveEntityUsername(entity: any): string | undefined {
  if (!entity) return undefined;
  if (typeof entity.username === "string" && entity.username.trim()) {
    return entity.username.trim();
  }
  if (Array.isArray(entity.usernames) && entity.usernames.length > 0) {
    const username = entity.usernames.find(
      (item: any) => item?.active
    )?.username;
    if (typeof username === "string" && username.trim()) {
      return username.trim();
    }
  }
  return undefined;
}

function cleanEntityId(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "bigint") {
    text = value.toString();
  } else {
    text = String(value);
  }
  if (!text) return undefined;
  if (text.startsWith("-100")) return text.slice(4);
  if (text.startsWith("-")) return text.slice(1);
  return text;
}

function buildEntityLink(entity: any): string | undefined {
  if (!entity) return undefined;
  const username = resolveEntityUsername(entity);
  if (username) return `https://t.me/${username}`;

  const cleaned = cleanEntityId(
    entity.id ??
      entity.peerId ??
      entity.chatId ??
      entity.channelId ??
      entity.userId ??
      entity.peer?.channelId ??
      entity.peer?.userId ??
      entity.peer?.chatId
  );
  if (cleaned) {
    if (entity instanceof Api.User || entity?.className === "User") {
      return `tg://user?id=${cleaned}`;
    }
    return `https://t.me/c/${cleaned}`;
  }
  return undefined;
}

function buildMessageLink(entity: any, messageId: number): string | undefined {
  if (!entity || !messageId) return undefined;
  const username = resolveEntityUsername(entity);
  if (username) {
    return `https://t.me/${username}/${messageId}`;
  }

  const cleaned = cleanEntityId(
    entity.id ??
      entity.peerId ??
      entity.chatId ??
      entity.channelId ??
      entity.userId ??
      entity.peer?.channelId ??
      entity.peer?.userId ??
      entity.peer?.chatId
  );
  if (cleaned) {
    if (entity instanceof Api.User || entity?.className === "User") {
      return `tg://user?id=${cleaned}`;
    }
    return `https://t.me/c/${cleaned}/${messageId}`;
  }
  return undefined;
}

function buildForwardedLinkTags(
  entity: any,
  messages: Api.Message[]
): string[] {
  const tags: string[] = [];
  if (!Array.isArray(messages)) return tags;
  messages.forEach((item, index) => {
    if (!item || typeof item.id !== "number") return;
    const url = buildMessageLink(entity, item.id);
    if (url) {
      tags.push(`<a href="${escapeAttribute(url)}">#${index + 1}</a>`);
    } else {
      tags.push(`#${index + 1}`);
    }
  });
  return tags;
}

function buildMessageLinkTagsByIds(entity: any, ids: number[]): string[] {
  const tags: string[] = [];
  if (!Array.isArray(ids)) return tags;
  ids.forEach((id, index) => {
    if (typeof id !== "number" || id <= 0) return;
    const url = buildMessageLink(entity, id);
    if (url) {
      tags.push(`<a href="${escapeAttribute(url)}">#${index + 1}</a>`);
    } else {
      tags.push(`#${index + 1}`);
    }
  });
  return tags;
}

function getEntityDisplayName(entity: any): string | undefined {
  if (!entity) return undefined;
  if (typeof entity.title === "string" && entity.title.trim()) {
    return entity.title.trim();
  }
  const names = [entity.firstName, entity.lastName]
    .filter((item) => typeof item === "string" && item.trim())
    .join(" ");
  if (names.trim()) return names.trim();
  if (typeof entity.username === "string" && entity.username.trim()) {
    return `@${entity.username.trim()}`;
  }
  const idCandidate =
    entity.id ??
    entity.peerId ??
    entity.chatId ??
    entity.channelId ??
    entity.userId ??
    entity.peer?.channelId ??
    entity.peer?.userId ??
    entity.peer?.chatId;
  if (typeof idCandidate !== "undefined") {
    return String(idCandidate);
  }
  return undefined;
}

function buildReplyToForMessage(
  message: Api.Message
): number | Api.InputReplyToMessage {
  const replyHeader: any = message.replyTo;
  const topMsgId =
    (replyHeader &&
      (typeof replyHeader.topMsgId === "number"
        ? replyHeader.topMsgId
        : typeof replyHeader.replyToTopId === "number"
        ? replyHeader.replyToTopId
        : undefined)) ||
    undefined;

  if (typeof topMsgId === "number") {
    return new Api.InputReplyToMessage({
      replyToMsgId: message.id,
      topMsgId,
    });
  }

  return message.id;
}

function renderTarget(target: TargetRecord): string {
  const display =
    target.display?.trim() || `<code>${escapeHtml(target.target)}</code>`;
  const topic = target.topicId
    ? ` | 话题: <code>${escapeHtml(target.topicId)}</code>`
    : "";
  return `[<code>${target.id}</code>] ${display}${topic}`;
}

function formatMode(mode: BsMode): string {
  return mode === MODE_BROADCAST ? "群发模式" : "顺序模式";
}

const helpText = `使用 <code>${commandName} [消息数]</code> 回复一条消息

首次使用请先通过 <code>${commandName} add</code> 配置转发目标

<code>${commandName} add 对话 ID/对话名[|话题ID]</code>: 添加目标(支持指定话题 ID)
<code>${commandName} ls</code>, <code>${commandName} list</code>: 列出所有目标
<code>${commandName} del [id]</code>, <code>${commandName} rm [id]</code>: 移除指定目标
<code>${commandName} enable [id]</code>, <code>${commandName} on [id]</code>: 启用指定目标
<code>${commandName} disable [id]</code>, <code>${commandName} off [id]</code>: 禁用指定目标
<code>${commandName} toggle mode</code>: 切换模式, 默认是按顺序优先发送, 发送成功就不继续. 可切换为每个目标都尝试发送`;

function sanitizeTargetInput(
  input: string | undefined | null
): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function getTargetLookup(target: TargetRecord): any {
  if (target.chatId) {
    const num = Number(target.chatId);
    if (Number.isFinite(num)) return num;
    try {
      return BigInt(target.chatId);
    } catch {}
    return target.chatId;
  }
  return target.target;
}

function getRpcErrorMessage(error: any): string {
  if (!error) return "";
  if (error instanceof RPCError) return error.errorMessage;
  if (typeof error.errorMessage === "string") return error.errorMessage;
  if (typeof error.message === "string") return error.message;
  return String(error);
}

function isPermissionError(message: string): boolean {
  const codes = [
    "CHAT_WRITE_FORBIDDEN",
    "USER_BANNED_IN_CHANNEL",
    "CHAT_ADMIN_REQUIRED",
    "CHANNEL_PRIVATE",
    "CHAT_SEND_GIFS_DISABLED",
    "PEER_FLOOD",
  ];
  return codes.some((code) => message.includes(code));
}

function extractForwardedMessages(result: Api.TypeUpdates): Api.Message[] {
  const forwarded: Api.Message[] = [];
  if ("updates" in result) {
    for (const update of result.updates) {
      if (
        update instanceof Api.UpdateNewMessage ||
        update instanceof Api.UpdateNewChannelMessage
      ) {
        const { message } = update;
        if (message instanceof Api.Message) {
          forwarded.push(message);
        }
      }
    }
  }
  return forwarded;
}

async function forwardToTarget(options: {
  client: any;
  fromPeer: any;
  target: TargetRecord;
  messageIds: number[];
}) {
  const { client, fromPeer, target, messageIds } = options;
  const lookup = getTargetLookup(target);
  let entity: any;
  try {
    entity = await client.getEntity(lookup as any);
  } catch (error) {
    console.warn(`[bs] 获取对话 ${target.target} 失败`, error);
    return { success: false, error: getRpcErrorMessage(error) };
  }

  if (!entity) return { success: false, error: "未找到目标" };

  let updated = false;
  const resolvedId = toStrInt(entity.id);
  if (resolvedId && target.chatId !== resolvedId) {
    target.chatId = resolvedId;
    updated = true;
  }

  if (
    !target.display ||
    target.display === `<code>${escapeHtml(target.target)}</code>`
  ) {
    const info = await formatEntity(entity).catch(() => null);
    if (info?.display) {
      target.display = info.display;
      updated = true;
    }
  }

  let retryFlood = false;
  const toPeer = await client.getInputEntity(entity);

  while (true) {
    try {
      const result = await client.invoke(
        new Api.messages.ForwardMessages({
          fromPeer,
          id: messageIds,
          toPeer,
          ...(target.topicId
            ? { topMsgId: toInt(target.topicId) ?? undefined }
            : {}),
        })
      );
      return {
        success: true,
        entity,
        forwarded: extractForwardedMessages(result),
        updated,
      };
    } catch (error) {
      const errorMessage = getRpcErrorMessage(error);

      if (errorMessage.startsWith("FLOOD_WAIT")) {
        const waitSeconds = parseInt(errorMessage.split("_").pop() || "5", 10);
        await sleep((waitSeconds + 1) * 1000);
        if (!retryFlood) {
          retryFlood = true;
          continue;
        }
        throw new Error(`操作频繁，请 ${waitSeconds} 秒后重试`);
      }

      if (errorMessage === "CHAT_FORWARDS_RESTRICTED") {
        throw new Error("该消息不允许被转发");
      }

      if (isPermissionError(errorMessage)) {
        console.warn(
          `[bs] 在目标 ${target.target} 没有发送权限: ${errorMessage}`
        );
        return { success: false, error: errorMessage };
      }

      if (error instanceof RPCError) {
        throw error;
      }

      throw new Error(errorMessage || "无法转发消息");
    }
  }
}

function buildListText(targets: TargetRecord[], mode: BsMode): string {
  const enabled = targets
    .filter((t) => t.status !== "0")
    .sort((a, b) => Number(a.id) - Number(b.id));
  const disabled = targets
    .filter((t) => t.status === "0")
    .sort((a, b) => Number(a.id) - Number(b.id));

  const lines: string[] = [];
  lines.push(`当前模式：<b>${formatMode(mode)}</b>`);

  if (enabled.length > 0) {
    lines.push("\n🔛 已启用的目标：");
    lines.push(enabled.map((target) => `- ${renderTarget(target)}`).join("\n"));
  }

  if (disabled.length > 0) {
    lines.push("\n⏹ 已禁用的目标：");
    lines.push(
      disabled.map((target) => `- ${renderTarget(target)}`).join("\n")
    );
  }

  if (enabled.length === 0 && disabled.length === 0) {
    lines.push("\n暂无目标，请使用 <code>add</code> 命令添加");
  }

  return lines.join("\n");
}

async function collectMessages(
  client: any,
  peer: any,
  startId: number,
  desiredCount: number
) {
  const messageIds: number[] = [];
  const MAX_SEARCH_LIMIT = 500;
  const maxSearch = Math.min(desiredCount * 3, MAX_SEARCH_LIMIT);
  let currentId = startId;

  while (messageIds.length < desiredCount && currentId < startId + maxSearch) {
    try {
      const fetched = await client.getMessages(peer, {
        ids: [currentId],
      });
      const candidate = Array.isArray(fetched) ? fetched[0] : fetched;
      if (candidate && candidate.id) {
        messageIds.push(candidate.id);
      }
    } catch (error) {
      console.warn(`[bs] 获取消息 ${currentId} 失败`, error);
    }
    currentId += 1;
  }

  return { messageIds };
}

async function sendSourceFeedback(options: {
  msg: Api.Message;
  client: any;
  fromPeer: any;
  replyMessage: Api.Message;
  successes: ForwardSuccess[];
  messageCount: number;
}) {
  const { msg, client, fromPeer, replyMessage, successes, messageCount } =
    options;
  if (!successes.length) return;

  const responses: string[] = [];

  for (const success of successes) {
    const forwardedCount = success.forwarded?.filter(
      (item) => item && typeof item.id === "number"
    ).length;
    const countText =
      forwardedCount && forwardedCount > 0 ? forwardedCount : messageCount;

    const targetNameRaw =
      getEntityDisplayName(success.entity) ??
      (typeof success.target.target === "string"
        ? success.target.target
        : "目标");
    const targetName = escapeHtml(targetNameRaw);
    const targetLink = buildEntityLink(success.entity);
    const targetHtml = targetLink
      ? `<a href="${escapeAttribute(targetLink)}">${targetName}</a>`
      : targetName;

    responses.push(`${countText} 条消息已被保送到 ${targetHtml}`);
  }

  if (!responses.length) return;

  try {
    // await client.sendMessage(fromPeer, {
    //   message: `亲爱的被观察者 您的 ${responses.join("\n")}`,
    //   parseMode: "html",
    //   linkPreview: false,
    //   replyTo: buildReplyToForMessage(replyMessage),
    // });
    await msg.edit({
      text: `亲爱的被观察者 您的 ${responses.join("\n")}`,
      parseMode: "html",
      linkPreview: false,
    });
  } catch (error) {
    console.warn("[bs] 回复原消息失败", error);
  }
}

async function sendTargetFeedback(options: {
  client: any;
  replyMessage: Api.Message;
  successes: ForwardSuccess[];
  sourceEntity: any;
  originalMessageIds: number[];
}) {
  const { client, replyMessage, successes, sourceEntity, originalMessageIds } =
    options;
  if (!successes.length) return;

  const originEntity = sourceEntity ?? replyMessage.peerId;
  const sourceNameRaw = getEntityDisplayName(originEntity) ?? "来源对话";
  const sourceLink = buildEntityLink(originEntity);
  const sourceName = escapeHtml(sourceNameRaw);
  const sourceText = sourceLink
    ? `<a href="${escapeAttribute(sourceLink)}">${sourceName}</a>`
    : sourceName;

  for (const success of successes) {
    const forwardedMessages = success.forwarded;
    if (!forwardedMessages || forwardedMessages.length === 0) continue;
    const firstForwarded = forwardedMessages[0];
    if (!firstForwarded || typeof firstForwarded.id !== "number") continue;

    const forwardedLinks = buildForwardedLinkTags(
      success.entity,
      forwardedMessages
    );
    const originalLinks = buildMessageLinkTagsByIds(
      originEntity,
      (originalMessageIds || []).slice(0, forwardedMessages.length)
    );

    const textParts: string[] = [];
    textParts.push(`来源：${sourceText}`);
    if (originalLinks.length) {
      textParts.push(`\n原消息：${originalLinks.join(" ")}`);
    }
    if (forwardedLinks.length) {
      textParts.push(`\n消息：${forwardedLinks.join(" ")}`);
    }

    const replyToMsgId = firstForwarded.id;
    const topMsgId = success.target.topicId
      ? toInt(success.target.topicId) ?? undefined
      : undefined;

    try {
      await client.sendMessage(success.entity, {
        message: textParts.filter(Boolean).join("<br>"),
        parseMode: "html",
        linkPreview: false,
        replyTo: replyToMsgId,
        topMsgId,
      });
    } catch (error) {
      console.warn(
        `[bs] 在目标 ${success.target.target} 回复转发消息失败`,
        error
      );
    }
  }
}

const helpResponse = `🛰️ <b>保送插件</b>\n\n${escapeHtml(helpText)}`;

class BsPlugin extends Plugin {
  description: string = `保送被回复的消息至指定目标\n\n${helpText}`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    [pluginName]: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ <b>客户端未初始化</b>", parseMode: "html" });
        return;
      }

      const text = msg.message || msg.text || "";
      const lines = text.trim().split(/\r?\n/);
      const head = lines[0] || "";
      const parts = head.trim().split(/\s+/).filter(Boolean);
      const args = parts.slice(1);
      const command = (args[0] || "").toLowerCase();

      if (!command || /^\d+$/.test(command)) {
        const count = command ? Number(command) : 1;
        if (!count || count <= 0) {
          await msg.edit({
            text: `❌ <b>消息数必须是正整数</b>\n示例：<code>${commandName} 3</code>`,
            parseMode: "html",
            linkPreview: false,
          });
          return;
        }

        if (!msg.isReply) {
          await msg.edit({
            text: "❌ <b>请先回复需要保送的消息</b>",
            parseMode: "html",
          });
          return;
        }

        const replyMessage = await msg.getReplyMessage();
        if (!replyMessage) {
          await msg.edit({
            text: "❌ <b>无法获取被回复的消息</b>",
            parseMode: "html",
          });
          return;
        }

        await msg.edit({
          text: "🚚 <b>正在保送消息...</b>",
          parseMode: "html",
        });

        const peerForFetch = msg.peerId ?? replyMessage.peerId;
        const { messageIds } = await collectMessages(
          client,
          peerForFetch,
          replyMessage.id,
          count
        );

        if (messageIds.length === 0) {
          await msg.edit({
            text: "❌ <b>未找到可转发的消息</b>\n请确认消息未被删除",
            parseMode: "html",
          });
          return;
        }

        const fromPeer = await msg.getInputChat();
        if (!fromPeer) {
          await msg.edit({
            text: "❌ <b>无法解析当前会话</b>",
            parseMode: "html",
          });
          return;
        }

        const db = await getDB();
        const targets = db.data.targets.filter(
          (target) => target && target.target
        );
        const activeTargets = targets.filter((target) => target.status !== "0");
        const mode = db.data.mode || MODE_SEQUENCE;

        const queue =
          activeTargets.length > 0
            ? activeTargets
            : targets.length === 0
            ? defaultTargets
            : [];

        const successes: ForwardSuccess[] = [];
        const errors: string[] = [];
        let metadataDirty = false;

        for (const target of queue) {
          try {
            const result = await forwardToTarget({
              client,
              fromPeer,
              target,
              messageIds,
            });

            if (result.updated) {
              metadataDirty = true;
            }

            if (!result.success) {
              errors.push(
                `${renderTarget(target)}: ${escapeHtml(
                  result.error || "未知错误"
                )}`
              );
              continue;
            }

            successes.push({
              target,
              forwarded: result.forwarded ?? [],
              entity: result.entity,
            });

            if (mode === MODE_SEQUENCE) break;
          } catch (error) {
            const message = escapeHtml(getRpcErrorMessage(error));
            await msg.edit({
              text: `❌ <b>保送失败</b>${message ? `<br>${message}` : ""}`,
              parseMode: "html",
              linkPreview: false,
            });
            return;
          }
        }

        if (metadataDirty) {
          try {
            await db.write();
          } catch (error) {
            console.warn("[bs] 写入对话元数据失败", error);
          }
        }

        if (successes.length === 0) {
          const errorText =
            errors.length > 0
              ? `失败原因：\n${errors.map((line) => `- ${line}`).join("\n")}`
              : "未找到可用的目标";
          await msg.edit({
            text: `❌ ${errorText}`,
            parseMode: "html",
            linkPreview: false,
          });
          return;
        }

        let sourceEntity: any;
        try {
          sourceEntity = await client.getEntity(fromPeer);
        } catch (error) {
          console.warn("[bs] 获取来源会话失败", error);
        }

        await sendSourceFeedback({
          msg,
          client,
          fromPeer,
          replyMessage,
          successes,
          messageCount: messageIds.length,
        });

        await sendTargetFeedback({
          client,
          replyMessage,
          successes,
          sourceEntity,
          originalMessageIds: messageIds,
        });

        // if (mode === MODE_SEQUENCE) {
        //   const { target } = successes[0];
        //   await msg.edit({
        //     text: `✅ 已保送至 ${renderTarget(target)}`,
        //     parseMode: "html",
        //     linkPreview: false,
        //   });
        // } else {
        //   const list = successes
        //     .map(({ target }) => `- ${renderTarget(target)}`)
        //     .join("\n");
        //   await msg.edit({
        //     text: `✅ 已尝试保送至以下目标：\n${list}`,
        //     parseMode: "html",
        //     linkPreview: false,
        //   });
        // }

        return;
      }

      if (["help", "h", "说明"].includes(command)) {
        await msg.edit({
          text: helpResponse,
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      if (["add"].includes(command)) {
        const db = await getDB();
        const rawTarget = sanitizeTargetInput(args[1]);
        if (!rawTarget) {
          await msg.edit({
            text: `❌ <b>请提供对话 ID 或 @名称</b>`,
            parseMode: "html",
          });
          return;
        }

        const [targetInput, topicInput] = rawTarget
          .split(/\s*[|｜]\s*/g)
          .map((item) => item.trim())
          .filter(Boolean);

        if (!targetInput) {
          await msg.edit({
            text: `❌ <b>无效的目标</b>`,
            parseMode: "html",
          });
          return;
        }

        try {
          const info = await formatEntity(targetInput, false, true);
          const id = nextId(db);
          const record: TargetRecord = {
            id,
            target: targetInput,
            chatId: toStrInt(info?.id),
            topicId: sanitizeTargetInput(topicInput),
            display: info?.display || `<code>${escapeHtml(targetInput)}</code>`,
            createdAt: String(Date.now()),
            updatedAt: String(Date.now()),
          };
          db.data.targets.push(record);
          await db.write();

          await msg.edit({
            text: `✅ 目标 <code>${id}</code> 已添加`,
            parseMode: "html",
          });
        } catch (error) {
          await msg.edit({
            text: `❌ <b>无法解析目标</b>\n${escapeHtml(
              getRpcErrorMessage(error)
            )}`,
            parseMode: "html",
          });
        }
        return;
      }

      if (["ls", "list"].includes(command)) {
        const db = await getDB();
        await msg.edit({
          text: buildListText(db.data.targets, db.data.mode || MODE_SEQUENCE),
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      if (["rm", "del"].includes(command)) {
        const targetId = args[1];
        if (!targetId) {
          await msg.edit({
            text: "❌ <b>请提供要删除的 ID</b>",
            parseMode: "html",
          });
          return;
        }
        const db = await getDB();
        const idx = db.data.targets.findIndex(
          (target) => target.id === targetId
        );
        if (idx === -1) {
          await msg.edit({
            text: `❌ <b>目标 <code>${escapeHtml(targetId)}</code> 不存在</b>`,
            parseMode: "html",
          });
          return;
        }
        db.data.targets.splice(idx, 1);
        await db.write();
        await msg.edit({
          text: `✅ 目标 <code>${escapeHtml(targetId)}</code> 已移除`,
          parseMode: "html",
        });
        return;
      }

      if (["disable", "off"].includes(command)) {
        const targetId = args[1];
        if (!targetId) {
          await msg.edit({
            text: "❌ <b>请提供要禁用的 ID</b>",
            parseMode: "html",
          });
          return;
        }
        const db = await getDB();
        const target = db.data.targets.find((item) => item.id === targetId);
        if (!target) {
          await msg.edit({
            text: `❌ <b>目标 <code>${escapeHtml(targetId)}</code> 不存在</b>`,
            parseMode: "html",
          });
          return;
        }
        target.status = "0";
        target.updatedAt = String(Date.now());
        await db.write();
        await msg.edit({
          text: `✅ 目标 <code>${escapeHtml(targetId)}</code> 已禁用`,
          parseMode: "html",
        });
        return;
      }

      if (["enable", "on"].includes(command)) {
        const targetId = args[1];
        if (!targetId) {
          await msg.edit({
            text: "❌ <b>请提供要启用的 ID</b>",
            parseMode: "html",
          });
          return;
        }
        const db = await getDB();
        const target = db.data.targets.find((item) => item.id === targetId);
        if (!target) {
          await msg.edit({
            text: `❌ <b>目标 <code>${escapeHtml(targetId)}</code> 不存在</b>`,
            parseMode: "html",
          });
          return;
        }
        delete target.status;
        target.updatedAt = String(Date.now());
        await db.write();
        await msg.edit({
          text: `✅ 目标 <code>${escapeHtml(targetId)}</code> 已启用`,
          parseMode: "html",
        });
        return;
      }

      if (command === "toggle" && (args[1] || "").toLowerCase() === "mode") {
        const db = await getDB();
        db.data.mode =
          db.data.mode === MODE_SEQUENCE ? MODE_BROADCAST : MODE_SEQUENCE;
        await db.write();
        await msg.edit({
          text: `✅ 模式已切换为 <b>${formatMode(db.data.mode)}</b>`,
          parseMode: "html",
        });
        return;
      }

      await msg.edit({
        text: `❓ <b>未知命令</b>\n\n${escapeHtml(helpText)}`,
        parseMode: "html",
        linkPreview: false,
      });
    },
  };
}

export default new BsPlugin();

import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/globalClient";
import { Api } from "teleproto";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "biko";
const commandName = `${mainPrefix}${pluginName}`;
const MAX_MESSAGE_COUNT = 200;
const MAX_SCAN_LIMIT = 3000;
const MAX_TEXT_LENGTH = 240;
const MAX_CHUNK_LENGTH = 3500;

type ResolvedChat = {
  raw: string;
  entity: any;
  display: string;
};

type ResolvedSourceUser =
  | {
      raw: string;
      display: string;
      manualMode: false;
      entity: Api.User;
    }
  | {
      raw: string;
      display: string;
      manualMode: true;
      manualUserId?: string;
      manualUsername?: string;
    };

type DigestRecord = {
  day: string;
  time: string;
  text: string;
  link?: string;
};

const helpText = `📦 <b>Biko - 批量获取整理发送指定对话中指定用户的消息</b>

<b>格式：</b>
<code>${commandName} 对话id(或@对话) 用户id(或@用户) 最大消息数 目标对话id(或@目标)</code>

<b>示例：</b>
<code>${commandName} -1001234567890 123456789 20 @targetchat</code>
<code>${commandName} @sourcechat @alice 30 -1009876543210</code>

<b>说明：</b>
• 最大消息数上限为 ${MAX_MESSAGE_COUNT}
• 输出包含时间和消息内容
• 能生成原消息链接时会自动附加可点击超链接
• 源用户实体解析失败时，会自动降级为手动过滤模式

若想实现定时任务, 可安装并使用 <code>${mainPrefix}tpm i acron</code>  
每天 2 点 从 对话 <code>@group</code> 中获取 <code>@user</code> 的 20 条消息并发送到人形账号的收藏夹 (Saved Messages)

<pre>${mainPrefix}acron cmd 0 0 2 * * * me 尾行
${mainPrefix}biko @group @user 20 me</pre>
`;

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return "未知错误";
}

function normalizeId(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") {
    const maybeValue = value as Record<string, unknown>;
    return normalizeId(
      maybeValue.userId ??
        maybeValue.channelId ??
        maybeValue.chatId ??
        maybeValue.value ??
        "",
    );
  }
  return String(value);
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function formatDateParts(input: unknown): { day: string; time: string } {
  let date: Date;
  if (input instanceof Date) {
    date = input;
  } else if (typeof input === "number") {
    date = new Date(input * 1000);
  } else if (typeof input === "bigint") {
    date = new Date(Number(input) * 1000);
  } else {
    date = new Date();
  }

  const day = date.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const time = date.toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return { day, time };
}

function buildEntityDisplay(entity: any, fallbackRaw: string): string {
  const parts: string[] = [];
  if (entity?.title) parts.push(String(entity.title));
  if (entity?.firstName) parts.push(String(entity.firstName));
  if (entity?.lastName) parts.push(String(entity.lastName));
  if (entity?.username) parts.push(`@${entity.username}`);
  if (entity?.id !== undefined && entity?.id !== null) {
    parts.push(String(entity.id));
  }
  return parts.join(" ").trim() || fallbackRaw;
}

async function resolveEntityWithFallback(
  client: any,
  raw: string,
): Promise<any> {
  const attempts: any[] = [raw];
  if (/^-?\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isSafeInteger(numeric)) attempts.push(numeric);
  }

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await client.getEntity(attempt);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error(`无法解析 ${raw}`);
}

async function resolveChatTarget(
  client: any,
  raw: string,
  label: string,
): Promise<ResolvedChat> {
  try {
    const entity = await resolveEntityWithFallback(client, raw);
    return {
      raw,
      entity,
      display: buildEntityDisplay(entity, raw),
    };
  } catch (error) {
    throw new Error(
      `${label}解析失败: ${raw}\n原因: ${extractErrorMessage(error)}`,
    );
  }
}

async function resolveSourceUser(
  client: any,
  raw: string,
): Promise<ResolvedSourceUser> {
  try {
    const entity = await resolveEntityWithFallback(client, raw);
    if (!(entity instanceof Api.User)) {
      throw new Error("解析结果不是用户实体");
    }
    return {
      raw,
      display: buildEntityDisplay(entity, raw),
      manualMode: false,
      entity,
    };
  } catch (error) {
    const errorMessage = extractErrorMessage(error);
    if (errorMessage === "解析结果不是用户实体") {
      throw new Error(`源用户解析失败: ${raw}\n原因: 解析结果不是用户实体`);
    }

    if (/^-?\d+$/.test(raw)) {
      return {
        raw,
        display: raw,
        manualMode: true,
        manualUserId: normalizeId(raw),
      };
    }

    const username = normalizeUsername(raw);
    if (username) {
      return {
        raw,
        display: `@${username}`,
        manualMode: true,
        manualUsername: username,
      };
    }

    throw new Error(`源用户解析失败: ${raw}\n原因: ${errorMessage}`);
  }
}

function parseRequestedCount(raw: string): number {
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("最大消息数必须是大于 0 的整数");
  }
  return Math.min(value, MAX_MESSAGE_COUNT);
}

function buildChatMessageLink(
  chatEntity: any,
  messageId: number,
): string | undefined {
  if (!messageId) return undefined;

  if (chatEntity?.username) {
    return `https://t.me/${chatEntity.username}/${messageId}`;
  }

  if (chatEntity instanceof Api.Channel && chatEntity?.id) {
    return `https://t.me/c/${chatEntity.id}/${messageId}`;
  }

  return undefined;
}

function describeServiceMessage(message: any): string {
  const actionName = String(message?.action?.className || "")
    .replace(/^MessageAction/, "")
    .trim();
  return actionName ? `[服务消息:${actionName}]` : "[服务消息]";
}

function describeDocumentMessage(message: any): string {
  const attributes = Array.isArray(message?.document?.attributes)
    ? message.document.attributes
    : [];

  if (
    attributes.some((attr: any) => attr instanceof Api.DocumentAttributeSticker)
  ) {
    return "[贴纸]";
  }
  if (
    attributes.some(
      (attr: any) =>
        attr instanceof Api.DocumentAttributeAudio && Boolean(attr.voice),
    )
  ) {
    return "[语音]";
  }
  if (
    attributes.some((attr: any) => attr instanceof Api.DocumentAttributeAudio)
  ) {
    return "[音频]";
  }
  if (
    attributes.some((attr: any) => attr instanceof Api.DocumentAttributeVideo)
  ) {
    return "[视频]";
  }
  if (
    attributes.some(
      (attr: any) => attr instanceof Api.DocumentAttributeAnimated,
    )
  ) {
    return "[动图]";
  }
  return "[文档]";
}

function buildMessageText(message: any): string {
  const rawText = String(message?.message || message?.text || "").trim();

  if (message?.className === "MessageService") {
    return rawText || describeServiceMessage(message);
  }

  let placeholder = "";
  if (message?.photo) {
    placeholder = "[图片]";
  } else if (message?.video) {
    placeholder = "[视频]";
  } else if (message?.voice) {
    placeholder = "[语音]";
  } else if (message?.audio) {
    placeholder = "[音频]";
  } else if (message?.sticker) {
    placeholder = "[贴纸]";
  } else if (message?.document) {
    placeholder = describeDocumentMessage(message);
  } else if (message?.poll) {
    placeholder = "[投票]";
  } else if (message?.contact) {
    placeholder = "[联系人]";
  } else if (message?.location || message?.venue) {
    placeholder = "[位置]";
  } else if (message?.media) {
    placeholder = "[媒体消息]";
  }

  if (rawText && placeholder) return `${placeholder} ${rawText}`;
  if (rawText) return rawText;
  if (placeholder) return placeholder;
  return "[空消息]";
}

function compactMessageText(text: string): string {
  const singleLine = text
    .replace(/\s*\r?\n\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
  if (singleLine.length <= MAX_TEXT_LENGTH) return singleLine || "[空消息]";
  return `${singleLine.slice(0, MAX_TEXT_LENGTH)}...`;
}

async function matchesManualSelector(
  message: any,
  selector: Extract<ResolvedSourceUser, { manualMode: true }>,
): Promise<boolean> {
  if (selector.manualUserId) {
    return normalizeId(message?.senderId) === selector.manualUserId;
  }

  const expectedUsername = selector.manualUsername;
  if (!expectedUsername) return false;

  const directUsername = normalizeUsername(
    String(message?.sender?.username || ""),
  );
  if (directUsername && directUsername === expectedUsername) {
    return true;
  }

  if (typeof message?.getSender === "function") {
    try {
      const sender = await message.getSender();
      const senderUsername = normalizeUsername(
        String((sender as any)?.username || ""),
      );
      return Boolean(senderUsername) && senderUsername === expectedUsername;
    } catch {
      return false;
    }
  }

  return false;
}

async function collectMessagesOnce(
  client: any,
  sourceChat: ResolvedChat,
  sourceUser: ResolvedSourceUser,
  requestedCount: number,
  manualScanLimit?: number,
): Promise<DigestRecord[]> {
  const records: DigestRecord[] = [];
  const iterParams: Record<string, any> = {
    limit: sourceUser.manualMode
      ? (manualScanLimit ??
        Math.min(
          Math.max(requestedCount * 20, requestedCount + 50),
          MAX_SCAN_LIMIT,
        ))
      : requestedCount,
  };

  if (!sourceUser.manualMode) {
    iterParams.fromUser = sourceUser.entity;
  }

  const iterator = client.iterMessages(sourceChat.entity, iterParams);

  for await (const message of iterator) {
    const current = message as any;

    if (sourceUser.manualMode) {
      const matched = await matchesManualSelector(current, sourceUser);
      if (!matched) continue;
    }

    const { day, time } = formatDateParts(current?.date);
    records.push({
      day,
      time,
      text: compactMessageText(buildMessageText(current)),
      link: buildChatMessageLink(sourceChat.entity, Number(current?.id)),
    });

    if (records.length >= requestedCount) break;
  }

  return records.reverse();
}

async function collectMessages(
  client: any,
  sourceChat: ResolvedChat,
  sourceUser: ResolvedSourceUser,
  requestedCount: number,
): Promise<DigestRecord[]> {
  const initialRecords = await collectMessagesOnce(
    client,
    sourceChat,
    sourceUser,
    requestedCount,
  );

  if (!sourceUser.manualMode || initialRecords.length >= requestedCount) {
    return initialRecords;
  }

  try {
    const retriedSourceUser = await resolveSourceUser(client, sourceUser.raw);
    if (!retriedSourceUser.manualMode) {
      return await collectMessagesOnce(
        client,
        sourceChat,
        retriedSourceUser,
        requestedCount,
      );
    }
  } catch {
    // ignore and continue to deep manual scan fallback
  }

  return await collectMessagesOnce(
    client,
    sourceChat,
    sourceUser,
    requestedCount,
    MAX_SCAN_LIMIT,
  );
}

function formatDigestLine(record: DigestRecord): string {
  const prefix = `• <code>${htmlEscape(record.time)}</code> `;
  if (record.link) {
    return `${prefix}<a href="${htmlEscape(record.link)}">${htmlEscape(
      record.text,
    )}</a>`;
  }
  return `${prefix}${htmlEscape(record.text)}`;
}

function buildDigestLines(records: DigestRecord[]): string[] {
  const lines: string[] = [];
  let currentDay = "";

  for (const record of records) {
    if (record.day !== currentDay) {
      if (lines.length > 0) lines.push("");
      currentDay = record.day;
      lines.push(`📅 <b>${htmlEscape(record.day)}</b>`);
    }
    lines.push(formatDigestLine(record));
  }

  return lines;
}

function splitDigest(header: string, lines: string[]): string[] {
  const continuationHeader = "📦 <b>Biko 消息整理</b>（续）\n\n";
  const parts: string[] = [];
  let current = header;

  for (const line of lines) {
    const separator = current.endsWith("\n\n") ? "" : "\n";
    if ((current + separator + line).length > MAX_CHUNK_LENGTH) {
      parts.push(current);
      current = continuationHeader + line;
    } else {
      current += separator + line;
    }
  }

  if (current) parts.push(current);
  return parts;
}

class BikoPlugin extends Plugin {
  cleanup(): void {}

  description: string = helpText;

  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    biko: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({
          text: "❌ Telegram 客户端未初始化",
          parseMode: "html",
        });
        return;
      }

      const firstLine = String(msg.message || msg.text || "")
        .split(/\r?\n/)[0]
        ?.trim();
      const parts = firstLine.split(/\s+/).filter(Boolean);
      const args = parts.slice(1);

      if (args[0] === "help" || args.length !== 4) {
        await msg.edit({
          text: helpText,
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      const [sourceChatRaw, sourceUserRaw, requestedCountRaw, targetChatRaw] =
        args;

      try {
        const requestedCount = parseRequestedCount(requestedCountRaw);
        await msg.edit({
          text: "🔄 正在解析对话和用户...",
          parseMode: "html",
        });

        const sourceChat = await resolveChatTarget(
          client,
          sourceChatRaw,
          "来源对话",
        );
        const targetChat = await resolveChatTarget(
          client,
          targetChatRaw,
          "目标对话",
        );
        const sourceUser = await resolveSourceUser(client, sourceUserRaw);

        const statusLines = [
          `🔄 正在整理消息...`,
          `<b>来源对话:</b> ${htmlEscape(sourceChat.display)}`,
          `<b>来源用户:</b> ${htmlEscape(sourceUser.display)}`,
          `<b>目标对话:</b> ${htmlEscape(targetChat.display)}`,
          `<b>消息数:</b> ${requestedCount}`,
        ];

        if (sourceUser.manualMode) {
          statusLines.push("⚠️ 源用户实体解析失败，已切换为手动过滤模式");
        }

        await msg.edit({
          text: statusLines.join("\n"),
          parseMode: "html",
          linkPreview: false,
        });

        const records = await collectMessages(
          client,
          sourceChat,
          sourceUser,
          requestedCount,
        );

        if (records.length === 0) {
          await msg.edit({
            text:
              `❌ 未找到匹配消息\n\n` +
              `<b>来源对话:</b> ${htmlEscape(sourceChat.display)}\n` +
              `<b>来源用户:</b> ${htmlEscape(sourceUser.display)}`,
            parseMode: "html",
          });
          return;
        }

        const headerLines = [
          "📦 <b>Biko 消息整理</b>",
          "",
          `<b>来源对话:</b> ${htmlEscape(sourceChat.display)}`,
          `<b>来源用户:</b> ${htmlEscape(sourceUser.display)}`,
          `<b>目标对话:</b> ${htmlEscape(targetChat.display)}`,
          `<b>消息数:</b> ${records.length}`,
        ];

        if (sourceUser.manualMode) {
          headerLines.push("<b>过滤模式:</b> 手动过滤");
        }

        const header = `${headerLines.join("\n")}\n\n`;
        const lines = buildDigestLines(records);
        const chunks = splitDigest(header, lines);

        for (const chunk of chunks) {
          await client.sendMessage(targetChat.entity, {
            message: chunk,
            parseMode: "html",
            linkPreview: false,
          });
        }

        const summaryLines = [
          "✅ 已发送整理结果",
          `<b>来源对话:</b> ${htmlEscape(sourceChat.display)}`,
          `<b>来源用户:</b> ${htmlEscape(sourceUser.display)}`,
          `<b>目标对话:</b> ${htmlEscape(targetChat.display)}`,
          `<b>发送条数:</b> ${records.length}`,
          `<b>发送分片:</b> ${chunks.length}`,
        ];

        if (parseInt(requestedCountRaw, 10) > requestedCount) {
          summaryLines.push(`<b>说明:</b> 请求数量已限制为 ${requestedCount}`);
        }

        if (sourceUser.manualMode) {
          summaryLines.push("<b>说明:</b> 本次使用手动过滤模式完成匹配");
        }

        await msg.edit({
          text: summaryLines.join("\n"),
          parseMode: "html",
          linkPreview: false,
        });
      } catch (error) {
        await msg.edit({
          text: `❌ <b>Biko 执行失败</b>\n\n${htmlEscape(
            extractErrorMessage(error),
          )}`,
          parseMode: "html",
          linkPreview: false,
        });
      }
    },
  };
}

export default new BikoPlugin();

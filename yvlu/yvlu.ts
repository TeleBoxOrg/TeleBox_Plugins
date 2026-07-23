//@ts-nocheck
import { safeGetMe } from "@utils/authGuards";
import { htmlEscape } from "@utils/htmlEscape";

// YVLU Plugin - 生成文字语录贴纸
import axios from "axios";
import _ from "lodash";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin, type PanelSettingsAdapter, type PanelSettingField, type PanelFieldType } from "@utils/pluginBase";
import {
  createDirectoryInAssets,
  createDirectoryInTemp,
} from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs";
import { getGlobalClient } from "@utils/runtimeManager";
import { reviveEntities } from "@utils/tlRevive";
import {
  dealCommandPluginWithMessage,
  getCommandFromMessage,
} from "@utils/pluginManager";
import { sleep } from "@utils/asyncHelpers";
import { safeGetReplyMessage, safeGetMessages } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { EntityLike, MessageLike } from "@utils/tlTypes";
import { getErrorMessage } from "@utils/errorHelpers";
import dayjs from "dayjs";
import * as zlib from "zlib";
import { execFile } from "child_process";
import { promisify } from "util";
import { thtml as html } from "@mtcute/node";

const execFileAsync = promisify(execFile);

const timeout = 60000; // 超时
const PYTHON_PATH = "python3"; // Python 路径，可修改为 venv 中的路径，如："/path/to/venv/bin/python"

// timeout for lightweight RPC helpers (ensureFullUser etc.)
const YVLU_EMOJI_TIMEOUT_MS = 20000;

const hashCode = (s: any) => {
  const l = s.length;
  let h = 0;
  let i = 0;
  if (l > 0) {
    while (i < l) {
      h = ((h << 5) - h + s.charCodeAt(i++)) | 0;
    }
  }
  return h;
};

// 检测是否为 webm 格式
function isWebmFormat(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 4) return false;
  // WebM 魔数: 0x1A 0x45 0xDF 0xA3 (EBML header)
  return (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  );
}

// 检测是否为 TGS 格式 (gzip 压缩的 Lottie JSON)
function isTgsFormat(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 2) return false;
  // gzip 魔数: 0x1F 0x8B
  return buffer[0] === 0x1f && buffer[1] === 0x8b;
}

// 检查 TGS 转换依赖
async function checkTgsDependencies(): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    await execFileAsync(PYTHON_PATH, [
      "-c",
      "from rlottie_python import LottieAnimation",
    ]);
  } catch (_e: unknown) {
    return {
      ok: false,
      message:
        "缺少 rlottie-python 依赖，请运行: pip3 install rlottie-python Pillow --break-system-packages",
    };
  }
  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch (_e: unknown) {
    return {
      ok: false,
      message: "缺少 ffmpeg，请安装: apt-get install -y ffmpeg",
    };
  }
  return { ok: true, message: "" };
}

// TGS 转 WebM (使用 rlottie-python + ffmpeg)
async function convertTgsToWebm(tgsBuffer: Buffer): Promise<Buffer> {
  const os = await import("os");
  const tmpDir = os.tmpdir();
  const uniqueId =
    Date.now().toString() + "_" + Math.random().toString(36).slice(2);
  const tgsPath = path.join(tmpDir, `sticker_${uniqueId}.tgs`);
  const gifPath = path.join(tmpDir, `sticker_${uniqueId}.gif`);
  const webmPath = path.join(tmpDir, `sticker_${uniqueId}.webm`);

  try {
    fs.writeFileSync(tgsPath, tgsBuffer);

    const pythonScript = `
import sys

from rlottie_python import LottieAnimation
anim = LottieAnimation.from_tgs(sys.argv[1])
anim.save_animation(sys.argv[2])
`;

    await execFileAsync(PYTHON_PATH, ["-c", pythonScript, tgsPath, gifPath]);

    await execFileAsync("ffmpeg", [
      "-i",
      gifPath,
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-b:v",
      "400k",
      "-auto-alt-ref",
      "0",
      "-an",
      "-y",
      webmPath,
    ]);

    const webmBuffer = fs.readFileSync(webmPath);
    return webmBuffer;
  } finally {
    try {
      fs.unlinkSync(tgsPath);
    } catch (e: unknown) { logger.warn('[yvlu] 清理临时文件失败:', e) }
    try {
      fs.unlinkSync(gifPath);
    } catch (e: unknown) { logger.warn('[yvlu] 清理临时文件失败:', e) }
    try {
      fs.unlinkSync(webmPath);
    } catch (e: unknown) { logger.warn('[yvlu] 清理临时文件失败:', e) }
  }
}

// 检测是否为动态 WebP
function isAnimatedWebP(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;

  // 检查 RIFF + WEBP 头
  if (
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return false;
  }

  // 搜索 ANIM 块
  for (let i = 12; i < buffer.length - 4; i++) {
    if (buffer.toString("ascii", i, i + 4) === "ANIM") {
      return true;
    }
  }
  return false;
}
// 检测是否为 MP4 格式
function isMp4Format(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;
  // MP4 魔数: ftyp 在偏移 4-8
  const ftyp = buffer.toString("ascii", 4, 8);
  return ftyp === "ftyp";
}

// MP4 转 WebM (使用 ffmpeg)
async function convertMp4ToWebm(mp4Buffer: Buffer): Promise<Buffer> {
  const os = await import("os");
  const tmpDir = os.tmpdir();
  const uniqueId =
    Date.now().toString() + "_" + Math.random().toString(36).slice(2);
  const mp4Path = path.join(tmpDir, `video_${uniqueId}.mp4`);
  const webmPath = path.join(tmpDir, `video_${uniqueId}.webm`);

  try {
    fs.writeFileSync(mp4Path, mp4Buffer);

    await execFileAsync("ffmpeg", [
      "-i",
      mp4Path,
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-b:v",
      "400k",
      "-auto-alt-ref",
      "0",
      "-an",
      "-y",
      webmPath,
    ]);

    const webmBuffer = fs.readFileSync(webmPath);
    return webmBuffer;
  } finally {
    try {
      fs.unlinkSync(mp4Path);
    } catch (e: unknown) { logger.warn('[yvlu] 清理临时文件失败:', e) }
    try {
      fs.unlinkSync(webmPath);
    } catch (e: unknown) { logger.warn('[yvlu] 清理临时文件失败:', e) }
  }
}

// 读取WebP图片尺寸的辅助函数
function getWebPDimensions(imageBuffer: any): {
  width: number;
  height: number;
} {
  try {
    // 如果是 WebM 格式，直接返回默认尺寸
    if (isWebmFormat(imageBuffer)) {
      return { width: 512, height: 512 };
    }

    // WebP文件格式解析
    if (imageBuffer.length < 30) {
      throw new Error("Invalid WebP file: too short");
    }

    // 检查RIFF头
    if (imageBuffer.toString("ascii", 0, 4) !== "RIFF") {
      throw new Error("Invalid WebP file: missing RIFF header");
    }

    // 检查WEBP标识
    if (imageBuffer.toString("ascii", 8, 12) !== "WEBP") {
      throw new Error("Invalid WebP file: missing WEBP signature");
    }

    // 读取VP8或VP8L头
    const chunkHeader = imageBuffer.toString("ascii", 12, 16);

    if (chunkHeader === "VP8 ") {
      // VP8格式
      const width = imageBuffer.readUInt16LE(26) & 0x3fff;
      const height = imageBuffer.readUInt16LE(28) & 0x3fff;
      return { width, height };
    } else if (chunkHeader === "VP8L") {
      // VP8L格式
      const data = imageBuffer.readUInt32LE(21);
      const width = (data & 0x3fff) + 1;
      const height = ((data >> 14) & 0x3fff) + 1;
      return { width, height };
    } else if (chunkHeader === "VP8X") {
      // VP8X格式
      const width = (imageBuffer.readUInt32LE(24) & 0xffffff) + 1;
      const height = (imageBuffer.readUInt32LE(27) & 0xffffff) + 1;
      return { width, height };
    }

    // 如果无法解析，返回默认尺寸
    logger.warn("Unknown WebP format, using default dimensions");
    return { width: 512, height: 768 };
  } catch (error: unknown) {
    logger.warn("Failed to parse WebP dimensions:", error);
    return { width: 512, height: 768 };
  }
}

const codeTag = (text: string): string => `<code>${htmlEscape(text)}</code>`;

const getPeerNumericId = (peer?: any): number | undefined => {
  if (!peer) return undefined;
  if (peer.type === "user") return peer.id;
  if (peer.type === "chat" || peer.type === "group") return -peer.id;
  if (peer.type === "channel") return -peer.id;
  // Fallback for raw TL peers
  if (peer._ === "peerUser") return peer.userId;
  if (peer._ === "peerChat") return -peer.chatId;
  if (peer._ === "peerChannel") return -peer.channelId;
  return undefined;
};

const resolveForwardSenderFromHeader = async (
  forwardHeader: any,
  client: any,
) => {
  if (!forwardHeader) return undefined;

  const displayName =
    forwardHeader.fromName ||
    forwardHeader.savedFromName ||
    forwardHeader.postAuthor ||
    "";
  const fallbackName = displayName || "未知来源";

  const peerCandidates = [
    forwardHeader.fromId,
    forwardHeader.savedFromPeer,
    forwardHeader.savedFromId,
  ].filter(Boolean);

  for (const peer of peerCandidates) {
    try {
      const entity = await client?.resolvePeer(peer);
      if (entity) {
        return entity;
      }
    } catch (error: unknown) {
      const errMsg = (error?.errorMessage || error?.message || "").toString();
      if (!errMsg.includes("CHANNEL_PRIVATE")) {
        logger.warn("解析转发发送者失败", error);
      }
    }
  }

  return {
    id:
      getPeerNumericId(
        forwardHeader.fromId ||
          forwardHeader.savedFromId ||
          forwardHeader.savedFromPeer,
      ) || hashCode(fallbackName),
    firstName: fallbackName,
    lastName: "",
    username: forwardHeader.postAuthor || undefined,
    title: fallbackName,
    name: fallbackName,
  };
};

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "yvlu";

const commandName = `${mainPrefix}${pluginName}`;

// 完整 helptext 单段进 description；标题外露，板块正文用可折叠 blockquote
// 标签与正文之间禁止换行：<blockquote expandable>内容</blockquote>
const helpFold = (title: string, body: string) =>
  `${title}\n<blockquote expandable>${body}</blockquote>`;
const help_text = [
  helpFold(
    `- 不包含回复`,
    `使用 <code>${commandName} [消息数]</code> 回复一条消息(支持选择部分引用回复) ⚠️ 不得超过 5 条`,
  ),
  ``,
  helpFold(
    `- 包含回复`,
    `使用 <code>${commandName} r [消息数]</code> 回复一条消息(支持选择部分引用回复) ⚠️ 不得超过 5 条`,
  ),
  ``,
  helpFold(
    `- 输出格式（默认 webp 贴纸）`,
    [
      `使用 <code>${commandName} webp</code> - 静态 WebP 贴纸`,
      `使用 <code>${commandName} image</code> - 背景大图 (PNG)`,
      `使用 <code>${commandName} stories</code> - 故事模式 (720×1280 PNG)`,
    ].join("\n"),
  ),
  ``,
  helpFold(
    `- 保存贴纸/图片到贴纸包`,
    `使用 <code>${commandName} s</code> 回复一张贴纸或图片,将其保存到配置的贴纸包中`,
  ),
  ``,
  helpFold(
    `- 配置管理`,
    [
      `使用 <code>${commandName} config</code> 查看当前配置`,
      `使用 <code>${commandName} config sticker 贴纸包名称</code> 设置贴纸包名称`,
    ].join("\n"),
  ),
].join("\n");

// 转换Telegram消息实体为quote-api格式
function convertEntities(entities: any[]): any[] {
  if (!entities) return [];

  return entities.map((entity: any) => {
    const baseEntity = {
      offset: entity.offset ?? entity.raw?.offset ?? 0,
      length: entity.length ?? entity.raw?.length ?? 0,
    };

    // mtcute MessageEntity: .kind / .params.kind
    // TL raw: ._ ; gramjs: className / type
    const entityType =
      entity.kind ||
      entity.params?.kind ||
      entity.type ||
      entity._ ||
      entity.className ||
      entity.constructor?.name ||
      "";

    switch (entityType) {
      case "bold":
      case "messageEntityBold":
        return { ...baseEntity, type: "bold" };
      case "italic":
      case "messageEntityItalic":
        return { ...baseEntity, type: "italic" };
      case "underline":
      case "messageEntityUnderline":
        return { ...baseEntity, type: "underline" };
      case "strikethrough":
      case "messageEntityStrike":
        return { ...baseEntity, type: "strikethrough" };
      case "code":
      case "messageEntityCode":
        return { ...baseEntity, type: "code" };
      case "pre":
      case "messageEntityPre":
        return { ...baseEntity, type: "pre", language: entity.language ?? entity.params?.language };
      case "emoji": // mtcute custom emoji kind
      case "custom_emoji":
      case "customEmoji":
      case "messageEntityCustomEmoji": {
        const idRaw =
          entity.emojiId ??
          entity.params?.emojiId ??
          entity.custom_emoji_id ??
          entity.customEmojiId ??
          entity.documentId ??
          entity.document_id ??
          entity.raw?.documentId ??
          entity.raw?.document_id;
        const custom_emoji_id =
          idRaw?.value?.toString?.() ||
          (typeof idRaw?.toString === "function" ? idRaw.toString() : "") ||
          (idRaw != null ? String(idRaw) : "") ||
          "";
        return {
          ...baseEntity,
          type: "custom_emoji",
          custom_emoji_id: custom_emoji_id === "[object Object]" ? "" : custom_emoji_id,
        };
      }
      case "url":
      case "messageEntityUrl":
        return { ...baseEntity, type: "url" };
      case "text_link":
      case "textLink":
      case "messageEntityTextUrl":
        return {
          ...baseEntity,
          type: "text_link",
          url: entity.url || entity.params?.url || "",
        };
      case "mention":
      case "messageEntityMention":
        return { ...baseEntity, type: "mention" };
      case "text_mention":
      case "textMention":
      case "messageEntityMentionName":
        return {
          ...baseEntity,
          type: "text_mention",
          user: { id: entity.userId ?? entity.params?.userId },
        };
      case "hashtag":
      case "messageEntityHashtag":
        return { ...baseEntity, type: "hashtag" };
      case "cashtag":
      case "messageEntityCashtag":
        return { ...baseEntity, type: "cashtag" };
      case "bot_command":
      case "botCommand":
      case "messageEntityBotCommand":
        return { ...baseEntity, type: "bot_command" };
      case "email":
      case "messageEntityEmail":
        return { ...baseEntity, type: "email" };
      case "phone_number":
      case "phoneNumber":
      case "messageEntityPhone":
        return { ...baseEntity, type: "phone_number" };
      case "spoiler":
      case "messageEntitySpoiler":
        return { ...baseEntity, type: "spoiler" };
      case "blockquote":
      case "messageEntityBlockquote":
        return { ...baseEntity, type: "blockquote" };
      default:
        // className fallback for gramjs-like objects
        if (String(entityType).includes("CustomEmoji")) {
          const idRaw = entity.documentId ?? entity.document_id ?? entity.emojiId;
          const custom_emoji_id = idRaw?.toString?.() || String(idRaw || "");
          return { ...baseEntity, type: "custom_emoji", custom_emoji_id };
        }
        return baseEntity;
    }
  }).filter((e: any) => e && e.length > 0 && e.type);
}

// ======== quote-api 高级字段辅助函数 (mtcute) ========

const QUOTE_RPC_TIMEOUT_MS = 20000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getDocumentAttributes(msg: any): any[] {
  const doc = (msg as any).document ?? (msg as any).media?.document;
  return doc?.attributes || [];
}

function audioAttribute(msg: any): any | undefined {
  return getDocumentAttributes(msg).find((a: any) => {
    const t = a.type || a._ || a.className || "";
    return t.includes("Audio");
  });
}

function voiceWaveform(msg: any): number[] | undefined {
  const attr = audioAttribute(msg);
  const raw = attr?.waveform;
  if (!raw) return undefined;
  let arr: number[];
  if (Array.isArray(raw)) arr = raw.map((x: any) => Number(x) || 0);
  else if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) arr = Array.from(raw as Uint8Array).map((x) => Number(x) || 0);
  else return undefined;
  if (!arr.length) return undefined;
  return arr.map((x) => Math.max(0, Math.min(31, x)));
}

function getMediaKind(msg: any): string | undefined {
  const media: any = (msg as any).media;
  if (!media) return undefined;
  const type = media.type || media._ || media.className || "";
  const attrs = getDocumentAttributes(msg);
  if (attrs.some((a: any) => {
    const t = a.type || a._ || a.className || "";
    return t.includes("Sticker");
  })) return "sticker";
  if (attrs.some((a: any) => {
    const t = a.type || a._ || a.className || "";
    return t.includes("Animated");
  }) || type.includes("Dice")) return "animation";
  if (attrs.some((a: any) => {
    const t = a.type || a._ || a.className || "";
    return t.includes("Audio") && a.voice;
  })) return "voice";
  if (attrs.some((a: any) => {
    const t = a.type || a._ || a.className || "";
    return t.includes("Audio");
  })) return "audio";
  if (attrs.some((a: any) => {
    const t = a.type || a._ || a.className || "";
    return t.includes("Video") && a.roundMessage;
  })) return "round";
  if (attrs.some((a: any) => {
    const t = a.type || a._ || a.className || "";
    return t.includes("Video");
  })) return "video";
  if (type.includes("Photo")) return "photo";
  if (type.includes("Geo")) return "location";
  if (type.includes("Venue")) return "venue";
  if (type.includes("Contact")) return "contact";
  if (type.includes("Poll")) return "poll";
  if (type.includes("Document")) return "document";
  return "media";
}

async function forwardedSource(msg: any): Promise<{ peer?: any; entity?: any; name?: string; anonymous: boolean } | undefined> {
  const fwd = msg.forward?.raw || msg.forward;
  if (!fwd) return undefined;
  const client = await getGlobalClient().catch(() => null);
  if (!client) return { anonymous: true };
  const headerName = (fwd as any).fromName || (fwd as any).savedFromName || (fwd as any).postAuthor || "";
  const peer = (fwd as any).fromId || (fwd as any).savedFromId || (fwd as any).savedFromPeer;
  if (peer) {
    try {
      const entity = await withTimeout(client.getEntity(peer), QUOTE_RPC_TIMEOUT_MS, "forwardedSource.getEntity");
      const name = entity?.firstName || entity?.title || entity?.name || headerName || "Forwarded";
      return { peer, entity, name, anonymous: false };
    } catch (err) {
    console.debug("[yvlu] forwardedSource.getEntity failed:", err?.message || err);
  }
  }
  if (headerName) return { name: headerName, anonymous: true };
  return { anonymous: true };
}

async function senderRankInChat(msg: any, entity: any): Promise<string | undefined> {
  if (!entity?.accessHash) return undefined;
  try {
    const client = await getGlobalClient().catch(() => null);
    if (!client) return undefined;
    const inputUser = { _: "inputUser", userId: entity.id, accessHash: entity.accessHash };
    const result = await withTimeout(
      client.call({ _: "channels.getParticipant", channel: msg.chat, participant: inputUser }),
      QUOTE_RPC_TIMEOUT_MS, "senderRank.channels.getParticipant",
    );
    return result?.participant?.rank?.trim() || undefined;
  } catch { return undefined; }
}

const QUOTE_API_URL = "https://quote-api-enhanced.zhetengsha.eu.org/generate.webp";
const QUOTE_API_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "TeleBox/0.2.1",
};

function detectQuoteImageExt(buffer: Buffer): "webp" | "png" | "webm" {
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "webp";
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return "png";
  // WebM (EBML header)
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) return "webm";
  const preview = buffer.subarray(0, 120).toString("utf8").replace(/\s+/g, " ").trim();
  throw new Error(`quote-api 返回了非图片/视频数据${preview ? `：${preview.slice(0, 100)}` : ""}`);
}

// 调用quote-api生成语录
async function generateQuote(
  quoteData: any,
): Promise<{ buffer: Buffer; ext: string }> {
  try {
    const response = await axios({
      method: "post",
      url: QUOTE_API_URL,
      headers: QUOTE_API_HEADERS,
      timeout,
      data: quoteData,
      responseType: "arraybuffer",
      transformResponse: [(data) => data],
      validateStatus: () => true,
    });

    logger.info("quote-api响应状态:", response.status);
    const imageBuffer = Buffer.from(response.data);
    if (response.status < 200 || response.status >= 300) {
      const detail = imageBuffer.subarray(0, 160).toString("utf8").replace(/\s+/g, " ").trim();
      throw new Error(`quote-api HTTP ${response.status}${detail ? `：${detail.slice(0, 120)}` : ""}`);
    }
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    if (!contentType.startsWith("image/") && !contentType.startsWith("video/") && contentType !== "application/octet-stream") {
      throw new Error(`quote-api 返回类型异常：${contentType || "unknown"}`);
    }
    return { buffer: imageBuffer, ext: detectQuoteImageExt(imageBuffer) };
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      logger.error(`quote-api请求失败:`, {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
      });
    } else {
      logger.error(`调用quote-api失败: ${error}`);
    }
    throw error;
  }
}

async function downloadProfilePhotoBuffer(client: any, sender: EntityLike): Promise<Buffer | undefined> {
  const photos = await client.getProfilePhotos(sender as any, { limit: 1 });
  const photo = photos?.[0];
  if (!photo) return undefined;
  const data = await client.downloadAsBuffer(photo);
  const buffer = Buffer.from(data);
  return buffer.length > 0 ? buffer : undefined;
}

async function ensureFullUser(client: any, sender: any): Promise<any> {
  if (!client || !sender) return sender;
  try {
    const isMin = !!(sender.isMin || sender.raw?.min);
    const hasStatusField =
      sender.emojiStatus != null ||
      sender.emoji_status != null ||
      sender.raw?.emojiStatus != null ||
      sender.raw?.emoji_status != null;
    // min peers often omit emojiStatus; also refresh when status field is totally absent
    if (!isMin && hasStatusField) return sender;
    if (typeof client.getUsers !== "function") return sender;
    const users = await withTimeout(
      client.getUsers(sender),
      YVLU_EMOJI_TIMEOUT_MS,
      "yvlu.ensureFullUser.getUsers",
    );
    const full = Array.isArray(users) ? users[0] : users;
    return full || sender;
  } catch (e: unknown) {
    logger.debug("yvlu ensureFullUser failed", e);
    return sender;
  }
}


interface YvluConfig {
  stickerSetShortName: string;
  _comment?: string;
}

class YvluPlugin extends Plugin {

  description: string = `\n生成文字语录贴纸\n\n${help_text}`;
  private config: YvluConfig | null = null;
  private configPath: string = "";

  async onLoad() {
    // 使用 assets 目录存储配置文件
    const configDir = createDirectoryInAssets("yvlu");
    this.configPath = path.join(configDir, "config.json");

    logger.info(`yvlu配置文件路径: ${this.configPath}`);

    // 如果配置文件不存在,创建默认配置
    if (!fs.existsSync(this.configPath)) {
      const defaultConfig: YvluConfig = {
        stickerSetShortName: "",
        _comment:
          "如果贴纸包不存在,将自动创建。shortName 只能包含字母、数字和下划线",
      };
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(defaultConfig, null, 2),
        "utf-8",
      );
      logger.info(`已创建默认配置文件: ${this.configPath}`);
    }

    // 加载配置
    await this.loadConfig();
  }

  async loadConfig() {
    try {
      // 确保 configPath 已初始化
      if (!this.configPath || this.configPath === "") {
        const configDir = createDirectoryInAssets("yvlu");
        this.configPath = path.join(configDir, "config.json");
        logger.info(`重新初始化配置文件路径: ${this.configPath}`);
      }

      if (!fs.existsSync(this.configPath)) {
        logger.error(`配置文件不存在: ${this.configPath}`);
        logger.info(`请手动创建配置文件: ${this.configPath}`);
        this.config = { stickerSetShortName: "" };
        return;
      }

      const configData = fs.readFileSync(this.configPath, "utf-8");
      this.config = JSON.parse(configData);
      logger.info("yvlu配置已加载:", this.config);
      logger.info("stickerSetShortName:", this.config?.stickerSetShortName);
    } catch (error: unknown) {
      logger.error("加载yvlu配置失败:", error);
      this.config = { stickerSetShortName: "" };
    }
  }

  cmdHandlers: Record<
    string,
    (msg: any, trigger?: any) => Promise<void>
  > = {
    yvlu: async (msg: any, trigger?: any) => {
      const start = Date.now();
      const args = (msg.text || "").split(/\s+/);
      let count = 1;
      let r = false;
      let valid = false;
      let saveToSet = false;
      let outputFormat: string | undefined = undefined; // webp / image / stories

      // 处理配置命令
      if (args[1] === "config") {
        await this.handleConfigCommand(msg, args.slice(2));
        return;
      }

      if (!args[1] || /^\d+$/.test(args[1])) {
        count = parseInt(args[1]) || 1;
        valid = true;
      } else if (args[1] === "r") {
        r = true;
        if (["webp", "image", "png", "stories"].includes(args[2])) {
          outputFormat = args[2] === "png" ? "image" : args[2];
          count = parseInt(args[3]) || 1;
        } else {
          count = parseInt(args[2]) || 1;
        }
        valid = true;
      } else if (args[1] === "s") {
        saveToSet = true;
        valid = true;
      } else if (["webp", "image", "png", "stories"].includes(args[1])) {
        outputFormat = args[1] === "png" ? "image" : args[1];
        count = parseInt(args[2]) || 1;
        valid = true;
      }

      if (saveToSet) {
        // 处理保存贴纸/图片到贴纸包的逻辑
        await this.handleSaveStickerToSet(msg);
      } else if (valid) {
        let replied = await safeGetReplyMessage(msg);
        if (!replied) {
          await msg.edit({ text: "请回复一条消息" });
          return;
        }
        if (count > 5) {
          await msg.edit({ text: "太多了 哒咩" });
          return;
        }

        await msg.edit({ text: "正在生成语录贴纸..." });

        try {
          const client = await getGlobalClient();

          // count=1 直接用被回复消息；多条用 minId 保证包含 replied（mtcute reverse offset 语义不稳）
          let messages: any[];
          if (count <= 1) {
            messages = [replied];
          } else {
            const history = await client.getHistory(msg.chat, {
              minId: replied!.id,
              limit: count,
              reverse: true,
            }).catch(() => []);
            messages = Array.isArray(history) ? history : [];
            if (!messages.some((m: any) => Number(m?.id) === Number(replied.id))) {
              messages = [replied, ...messages].slice(0, count);
            }
          }

          if (!messages || messages.length === 0) {
            await msg.edit({ text: "未找到消息" });
            return;
          }

          const items: Record<string, unknown>[] = [];
          let previousUserIdentifier: string | null = null;

          for (const [i, message] of messages.entries()) {
            // 获取发送者信息：mtcute 的 Message 已解析 `.sender`（Peer），无异步 getSender()
            let sender: EntityLike | null = (message.sender as EntityLike) || null;

            // 如果无法获取发送者（可能是以频道身份发言），尝试从 forward 信息获取
            if (!sender && message.forward) {
              try {
                const fwdSender = message.forward.sender;
                if (fwdSender && typeof (fwdSender as { id?: unknown }).id !== "undefined") {
                  sender = fwdSender as unknown as EntityLike;
                }
              } catch (e: unknown) {
                logger.warn("从转发获取发送者失败", e);
              }
            }

            if (message.forward) {
              let forwardedSender = message.forward.sender || null;

              if (!forwardedSender) {
                try {
                  forwardedSender = message.forward?.sender || null;
                } catch (error: unknown) {
                  logger.warn("获取转发发送者失败", error);
                }
              }

              if (!forwardedSender) {
                forwardedSender = await resolveForwardSenderFromHeader(
                  message.forward?.raw ?? null,
                  client,
                );
              }

              if (!forwardedSender) {
                const fallbackName = "未知来源";
                forwardedSender = {
                  id: hashCode(fallbackName),
                  firstName: fallbackName,
                  lastName: "",
                  title: fallbackName,
                  name: fallbackName,
                };
              }
              sender = forwardedSender;
            }

            if (!sender) {
              await msg.edit({ text: "无法获取消息发送者信息" });
              return;
            }

            // min/incomplete peer 可能没有 emojiStatus，先 getUsers 补全
            sender = await ensureFullUser(client, sender);

            // 准备用户数据
            const senderLike = sender as EntityLike;
            const userId = senderLike.id?.toString();
            const name = (sender as unknown as { name?: string }).name || "";
            const firstName =
              senderLike.firstName || senderLike.title || "";
            const lastName = senderLike.lastName || "";
            const username = senderLike.username || "";
            const emojiStatusObj = (sender as any)?.emojiStatus ?? (sender as any)?.emoji_status;
            let emojiStatus: string | null = null;
            if (emojiStatusObj != null) {
              try {
                const via =
                  emojiStatusObj?.emoji ??
                  emojiStatusObj?.documentId ??
                  emojiStatusObj?.document_id ??
                  emojiStatusObj?.raw?.documentId ??
                  emojiStatusObj?.raw?.document_id;
                if (via != null && via !== "") {
                  const s = typeof via?.toString === "function" ? via.toString() : String(via);
                  if (s && s !== "[object Object]") emojiStatus = s;
                } else if (typeof emojiStatusObj !== "object") {
                  emojiStatus = String(emojiStatusObj);
                }
              } catch {
                emojiStatus = null;
              }
            }

            // 生成用户唯一标识符：优先使用 userId，如果没有则使用名称的 hashCode
            const currentUserIdentifier =
              userId ||
              hashCode(
                name || `${firstName}|${lastName}` || `user_${i}`,
              ).toString();

            // 判断是否应该显示头像：只有当前用户与上一条消息的用户不同时才显示
            const shouldShowAvatar =
              currentUserIdentifier !== previousUserIdentifier;
            previousUserIdentifier = currentUserIdentifier;

            let photo: { url: string } | undefined = undefined;
            if (shouldShowAvatar) {
              try {
                const buffer = await downloadProfilePhotoBuffer(client, sender as EntityLike);
                if (Buffer.isBuffer(buffer) && buffer.length > 0) {
                  const base64 = buffer.toString("base64");
                  photo = {
                    url: `data:image/jpeg;base64,${base64}`,
                  };
                } else {
                  logger.warn("下载的头像数据无效或用户无头像");
                }
              } catch (e: unknown) {
                logger.warn("下载用户头像失败", e);
              }
              // 远程 quote-api 的 emoji_status 只接受纯字符串 ID，由远端自行拉表情。
              // 本地无需预下载 customEmojiBuffer（塞进请求会膨胀/易炸 JSON）。
            }

            if (i === 0) {
              const replyTo = (trigger || msg)?.replyTo;
              if (replyTo?.quoteText) {
                message.text = replyTo.quoteText;
                message.entities = replyTo.quoteEntities || [];
              }
            }

            // 转换消息实体
            const entities = convertEntities(
              message.entities || [],
            );

            // 处理回复引用（支持 quote header 与真实被回复消息）
            let replyBlock: { name: string; text: string; entities: unknown[]; chatId?: number } | undefined;
            if (r) {
              try {
                const replyHeader = (message as MessageLike).replyTo as Record<string, unknown> | undefined;

                // 1) 优先使用 quote header（包含被引用文本与实体偏移）
                if (replyHeader?.quote && replyHeader.quoteText) {
                  let replyName = "unknown";
                  let replyChatId: number | undefined = undefined;

                  // 尝试拿到被回复消息以获取发送者名称
                  try {
                    const repliedMsg = await safeGetReplyMessage(message);
                    if (repliedMsg) {
                      const repliedSender = repliedMsg.sender as EntityLike | null;
                      if (repliedSender) {
                        replyChatId = Number(repliedSender.id);
                        const repliedSenderLike = repliedSender as EntityLike;
                        const rFirst =
                          repliedSenderLike.firstName ||
                          repliedSenderLike.title ||
                          "";
                        const rLast = repliedSenderLike.lastName || "";
                        const rUser = repliedSenderLike.username || "";
                        const composed = `${rFirst} ${rLast}`.trim();
                        replyName = composed || rUser || "unknown";
                      }
                    }
                  } catch (e: unknown) {
                    logger.warn('[yvlu] 解析回复发送者信息失败:', e);
                  }

                  // 实体
                  const revived = reviveEntities(replyHeader.quoteEntities);
                  const replyEntities = convertEntities(revived || []);

                  replyBlock = {
                    name: replyName,
                    text: replyHeader.quoteText,
                    entities: replyEntities,
                    ...(replyChatId ? { chatId: replyChatId } : {}),
                  };
                } else if (
                  // 2) 次选：直接获取被回复消息
                  (message as MessageLike).isReply ||
                  replyHeader?.replyToMsgId
                ) {
                  try {
                    const repliedMsg = await safeGetReplyMessage(message);
                    if (repliedMsg) {
                      const repliedSender = repliedMsg.sender as EntityLike | null;
                      let replyName = "unknown";
                      let replyChatId: number | undefined;
                      if (repliedSender) {
                        replyChatId = Number(repliedSender.id);
                        const repliedSenderLike = repliedSender as EntityLike;
                        const rFirst =
                          repliedSenderLike.firstName ||
                          repliedSenderLike.title ||
                          "";
                        const rLast = repliedSenderLike.lastName || "";
                        const rUser = repliedSenderLike.username || "";
                        const composed = `${rFirst} ${rLast}`.trim();
                        replyName = composed || rUser || "unknown";
                      }

                      // 使用被回复消息的文本 + 实体
                      const replyText = repliedMsg.text || repliedMsg.message || "";
                      const replyEntities = convertEntities(
                        repliedMsg.entities || [],
                      );

                      if (replyText) {
                        replyBlock = {
                          name: replyName,
                          text: replyText,
                          entities: replyEntities,
                          ...(replyChatId ? { chatId: replyChatId } : {}),
                        };
                      }
                    }
                  } catch (e: unknown) {
                    logger.warn('[yvlu] 解析回复引用信息失败:', e);
                  }
                }
              } catch (e: unknown) {
                logger.warn("处理回复引用失败: ", e);
              }
            }

            let media: { url: string } | undefined = undefined;
            try {
              if (message.media) {
                let mediaTypeForQuote: string | undefined = undefined;

                // 判断是否为贴纸 - check type/className instead of instanceof
                const mediaDoc = message.media.document;
                const mediaAttrs = mediaDoc?.attributes;
                const isSticker =
                  mediaAttrs?.some(
                    (a: any) => {
                      const t = a.type || a._ || a.className;
                      return t === "documentAttributeSticker" || t === "sticker";
                    },
                  ) || false;

                if (isSticker) {
                  mediaTypeForQuote = "sticker";
                } else {
                  mediaTypeForQuote = "photo";
                }

                const mimeType = (message.media as unknown as { document?: { mimeType?: string } }).document?.mimeType;

                // 检测是否为 TGS 动态贴纸
                const isTgsSticker =
                  isSticker && mimeType === "application/x-tgsticker";

                // 检测是否为 GIF/MP4 (Telegram 的 GIF 实际是 mp4)
                const isGifOrMp4 =
                  mimeType === "video/mp4" || mimeType === "image/gif";

                // 检测是否为动态内容（需要下载原文件，不用缩略图）
                const isAnimatedContent =
                  (isSticker &&
                    (mimeType === "video/webm" || // 视频贴纸
                      mimeType === "image/webp" || // 可能是动态WebP
                      isTgsSticker)) || // TGS 动态贴纸
                  isGifOrMp4; // GIF/MP4

                const buffer = await client.downloadAsBuffer(
                  message.media as Parameters<typeof client.downloadAsBuffer>[0],
                  isAnimatedContent ? {} : { thumb: 1 },
                ).then((b) => Buffer.from(b));
                if (Buffer.isBuffer(buffer)) {
                  let finalBuffer = buffer;
                  let finalMime = mimeType;

                  // 如果是 TGS 格式，转换为 WebM
                  if (isTgsSticker || isTgsFormat(buffer)) {
                    try {
                      const depCheck = await checkTgsDependencies();
                      if (!depCheck.ok) {
                        logger.error(`[yvlu] ${depCheck.message}`);
                      } else {
                        logger.info(
                          `[yvlu] 检测到 TGS 贴纸，开始转换为 WebM...`,
                        );
                        finalBuffer = await convertTgsToWebm(buffer);
                        finalMime = "video/webm";
                        logger.info(
                          `[yvlu] TGS -> WebM 转换成功，大小: ${finalBuffer.length}`,
                        );
                      }
                    } catch (convertError: unknown) {
                      logger.error(`[yvlu] TGS 转换失败:`, convertError);
                    }
                  }
                  // 如果是 MP4/GIF，转换为 WebM
                  else if (isGifOrMp4 || isMp4Format(buffer)) {
                    try {
                      logger.info(`[yvlu] 检测到 GIF/MP4，开始转换为 WebM...`);
                      finalBuffer = await convertMp4ToWebm(buffer);
                      finalMime = "video/webm";
                      logger.info(
                        `[yvlu] MP4 -> WebM 转换成功，大小: ${finalBuffer.length}`,
                      );
                    } catch (convertError: unknown) {
                      logger.error(`[yvlu] MP4 转换失败:`, convertError);
                      // 转换失败时保持原格式
                    }
                  }

                  // 使用实际的 mimeType
                  const mime =
                    finalMime ||
                    (mediaTypeForQuote === "sticker"
                      ? "image/webp"
                      : "image/jpeg");
                  const base64 = finalBuffer.toString("base64");
                  media = { url: `data:${mime};base64,${base64}` };
                  logger.info(
                    `媒体下载: mimeType=${mimeType}, isAnimated=${isAnimatedContent}, isTgs=${isTgsSticker}, isGif=${isGifOrMp4}, size=${finalBuffer.length}`,
                  );
                }
              }
            } catch (e: unknown) {
              logger.error("下载媒体失败", e);
            }

            // 构建高级消息对象（quote-api 全字段）
            const msgItem: any = {
              from: {
                id: userId
                  ? parseInt(userId)
                  : hashCode(sender.name || `${firstName}|${lastName}`),
                name: shouldShowAvatar ? name : "",
                first_name: shouldShowAvatar
                  ? firstName || undefined
                  : undefined,
                last_name: shouldShowAvatar ? lastName || undefined : undefined,
                username:
                  photo && shouldShowAvatar ? username || undefined : undefined,
                photo,
                emoji_status: shouldShowAvatar && emojiStatus
                  ? String(emojiStatus)
                  : undefined,
              },
              text: message.text || "",
              entities: entities,
              avatar: shouldShowAvatar,
              ...(replyBlock ? { replyMessage: replyBlock } : {}),
            };

            // === quote-api glass 字段：voice / document / audio / forward / senderTag / mediaType / mediaDuration ===

            // 媒体
            if (media) msgItem.media = media;

            // 转发行标签
            if (message.forward) {
              const fwdInfo = await forwardedSource(message).catch(() => undefined);
              if (fwdInfo?.name) {
                msgItem.forward = { label: fwdInfo.name };
              }
            }

            // 管理员标签
            if (sender && (sender as any).accessHash) {
              const tag = await senderRankInChat(message, sender).catch(() => undefined);
              if (tag) msgItem.senderTag = tag;
            }

            // 媒体类型高级字段
            const mediaObj = (message as any).media;
            if (mediaObj) {
              const kind = getMediaKind(message as any);
              if (kind === "voice") {
                const waveform = voiceWaveform(message as any);
                const attr = audioAttribute(message as any);
                const duration = Number(attr?.duration ?? attr?.voiceDuration ?? 0) || undefined;
                if (waveform) msgItem.voice = { waveform, ...(duration !== undefined ? { duration } : {}) };
              } else if (kind === "document") {
                const doc = (message as any).document ?? (message as any).media?.document;
                const fn = doc?.attributes?.find((a: any) => {
                  const t = a.type || a._ || a.className || "";
                  return t.includes("Filename");
                });
                const name = String(fn?.fileName || fn?.file_name || "file");
                msgItem.document = { file_name: name };
              } else if (kind === "audio") {
                const attr = audioAttribute(message as any);
                const title = attr?.title || attr?.fileName || attr?.file_name || "Audio";
                const performer = attr?.performer || attr?.artist;
                const duration = Number(attr?.duration ?? 0) || undefined;
                msgItem.audio = { title, ...(performer ? { performer } : {}), ...(duration !== undefined ? { duration } : {}) };
              } else if (kind === "video" || kind === "animation" || kind === "round") {
                const attr = getDocumentAttributes(message as any).find((a: any) => {
                  const t = a.type || a._ || a.className || "";
                  return t.includes("Video");
                });
                const mediaDuration = Number(attr?.duration ?? 0) || undefined;
                msgItem.mediaType = kind === "animation" ? "gif" : kind === "round" ? "video" : kind;
                if (mediaDuration) msgItem.mediaDuration = mediaDuration;
              }
            }

            items.push(msgItem);
          }

          const quoteData: Record<string, unknown> = {
            type: "quote",
            format: "webp",
            backgroundColor: "#1b1429",
            width: 512,
            height: 768,
            scale: 2,
            emojiBrand: "apple",
            messages: items,
          };
          // 支持动态输出格式（通过参数控制）
          if (outputFormat === "stories") {
            quoteData.type = "stories";
            quoteData.format = "png";
            quoteData.width = 360;
            quoteData.height = 640;
          } else if (outputFormat === "image") {
            quoteData.type = "image";
            quoteData.format = "png";
          } else if (outputFormat === "webp") {
            quoteData.type = "quote";
            quoteData.format = "webp";
          }
          // 生成语录贴纸（webp）
          const quoteResult = await generateQuote(quoteData);
          const imageBuffer = quoteResult.buffer;
          const imageExt = quoteResult.ext; // 'image' => png, 'quote' => webp

          // 验证图片数据
          if (!imageBuffer || imageBuffer.length === 0) {
            await msg.edit({ text: "生成的图片数据为空" });
            return;
          }

          logger.info(
            `[yvlu] API返回: buffer长度=${imageBuffer?.length}, ext=${imageExt}`,
          );
          logger.info(
            `[yvlu] buffer前20字节: ${imageBuffer
              ?.slice(0, 20)
              .toString("hex")}`,
          );

          try {
            // 从生成的图片文件中读取实际尺寸
            const dimensions = getWebPDimensions(imageBuffer);

            // 检测格式
            const isWebm = isWebmFormat(imageBuffer);
            const isAnimated = isAnimatedWebP(imageBuffer);

            logger.info(
              `检测到的图片尺寸: ${dimensions.width}x${
                dimensions.height
              }, 格式: ${isWebm ? "webm" : "webp"}, 动态: ${
                isWebm || isAnimated
              }`,
            );

            const os = await import("os");
            const tmpDir = os.tmpdir();

            if (isWebm) {
              // webm 格式：直接发送为贴纸（参考 eatgif）
              const uniqueId = Date.now().toString();
              const webmPath = path.join(tmpDir, `sticker_${uniqueId}.webm`);

              try {
                fs.writeFileSync(webmPath, imageBuffer);

                await client.sendMedia(msg.chat.id, {
                  type: "sticker",
                  file: webmPath,
                  fileName: "yvlu.webm",
                  fileMime: "video/webm",
                  alt: "📝",
                }, { replyTo: replied?.id });

                logger.info("[yvlu] 动态贴纸发送成功 (webm)");
              } finally {
                try {
                  fs.unlinkSync(webmPath);
                } catch (e: unknown) { logger.warn('[yvlu] 清理临时文件失败:', e) }
              }
            } else {
              const uniqueId = Date.now().toString();
              const outputPath = path.join(tmpDir, `quote_${uniqueId}.${imageExt}`);

              try {
                fs.writeFileSync(outputPath, imageBuffer);

                if (imageExt === "webp") {
                  await client.sendMedia(msg.chat.id, {
                    type: "sticker",
                    file: outputPath,
                    fileName: "yvlu.webp",
                    fileMime: "image/webp",
                    alt: "📝",
                  }, { replyTo: replied?.id });
                  logger.info("[yvlu] 静态贴纸发送成功");
                } else {
                  await client.sendMedia(msg.chat.id, {
                    type: "photo",
                    file: outputPath,
                  }, { replyTo: replied?.id });
                  logger.info("[yvlu] PNG 图片发送成功");
                }
              } finally {
                try {
                  fs.unlinkSync(outputPath);
                } catch (e: unknown) { logger.warn('[yvlu] 清理临时文件失败:', e) }
              }
            }

            logger.info("[yvlu] 文件发送成功");
          } catch (fileError: unknown) {
            logger.error(`发送文件失败: ${fileError}`);
            await msg.edit({ text: `发送文件失败: ${htmlEscape(String(fileError))}` });
            return;
          }

          await msg.delete();

          const end = Date.now();
          logger.info(`语录生成耗时: ${end - start}ms`);
        } catch (error: unknown) {
          logger.error(`语录生成失败: ${error}`);
          await msg.edit({ text: `语录生成失败: ${htmlEscape(String(error))}` });
        }
      } else {
        await msg.edit({
          text: html(help_text),
        });
      }
    },
  };

  async handleConfigCommand(msg: any, args: string[]) {
    try {
      // 确保配置已加载
      await this.loadConfig();

      // 如果没有参数，显示当前配置
      if (args.length === 0) {
        const configInfo = `
<b>📋 当前配置:</b>

        <b>贴纸包名称:</b> ${codeTag(this.config?.stickerSetShortName || "(未设置)")}
${
  this.config?.stickerSetShortName
    ? `<b>贴纸包链接:</b> t.me/addstickers/${htmlEscape(this.config.stickerSetShortName)}`
    : ""
}

<b>配置文件路径:</b>
${codeTag(this.configPath)}


<b>可用配置命令:</b>
<code>${commandName} config sticker 贴纸包名称</code> - 设置贴纸包名称
`;
        await msg.edit({ text: html(configInfo) });
        return;
      }

      const subCommand = args[0].toLowerCase();

      switch (subCommand) {
        case "sticker":
        case "stickerset":
        case "set": {
          // 设置贴纸包名称
          const newName = args.slice(1).join("_"); // 用下划线连接多个参数

          if (!newName) {
            await msg.edit({
              text: html(`❌ 请提供贴纸包名称\n用法: <code>${commandName} config sticker 贴纸包名称</code>`),
            });
            return;
          }

          // 验证贴纸包名称格式（只能包含字母、数字和下划线）
          if (!/^[a-zA-Z0-9_]+$/.test(newName)) {
            await msg.edit({
              text: html("❌ 贴纸包名称只能包含字母、数字和下划线"),
            });
            return;
          }

          // 贴纸包名称长度限制
          if (newName.length < 1 || newName.length > 64) {
            await msg.edit({
              text: html("❌ 贴纸包名称长度应在 1-64 个字符之间"),
            });
            return;
          }

          // 更新配置
          const newConfig: YvluConfig = {
            ...this.config,
            stickerSetShortName: newName,
          };

          // 保存到文件
          fs.writeFileSync(
            this.configPath,
            JSON.stringify(newConfig, null, 2),
            "utf-8",
          );

          // 重新加载配置
          await this.loadConfig();

          await msg.edit({
            text: html(`✅ 贴纸包名称已设置为: ${codeTag(newName)}\n贴纸包链接: t.me/addstickers/${htmlEscape(newName)}`),
          });
          break;
        }

        default:
          await msg.edit({
            text: html(`❌ 未知的配置项: ${codeTag(subCommand)}\n\n可用配置命令:\n<code>${commandName} config sticker 贴纸包名称</code> - 设置贴纸包名称`),
          });
      }
    } catch (error: unknown) {
      logger.error("处理配置命令失败:", error);
      await msg.edit({
        text: html(`❌ 配置操作失败: ${htmlEscape(getErrorMessage(error) || String(error))}`),
      });
    }
  }

  async handleSaveStickerToSet(msg: any) {
    try {
      // 确保配置路径已初始化
      if (!this.configPath || this.configPath === "") {
        const configDir = createDirectoryInAssets("yvlu");
        this.configPath = path.join(configDir, "config.json");

        // 如果配置文件不存在,创建默认配置
        if (!fs.existsSync(this.configPath)) {
          const defaultConfig: YvluConfig = {
            stickerSetShortName: "",
            _comment:
              "如果贴纸包不存在,将自动创建。shortName 只能包含字母、数字和下划线",
          };
          fs.writeFileSync(
            this.configPath,
            JSON.stringify(defaultConfig, null, 2),
            "utf-8",
          );
          logger.info(`已创建默认配置文件: ${this.configPath}`);
        }
      }

      // 重新加载配置(确保获取最新配置)
      await this.loadConfig();

      // 检查配置
      if (
        !this.config ||
        !this.config.stickerSetShortName ||
        this.config.stickerSetShortName.trim() === ""
      ) {
        await msg.edit({
          text: html(`❌ 未配置贴纸包!\n请编辑配置文件: ${htmlEscape(this.configPath)}\n设置 stickerSetShortName`),
        });
        return;
      }

      // 获取回复的消息
      const replied = await safeGetReplyMessage(msg);
      if (!replied) {
        await msg.edit({ text: "❌ 请回复一张贴纸或图片" });
        return;
      }

      // 检查是否有媒体
      if (!replied.media) {
        await msg.edit({ text: "❌ 回复的消息不包含贴纸或图片" });
        return;
      }

      const client = await getGlobalClient();

      // 判断媒体类型
      let isSticker = false;
      let isPhoto = false;
      let documentToAdd: any = null;

      // Check if media is a document (sticker) using type property
      const mediaType = replied.media.type || replied.media._ || replied.media.className;
      if (mediaType === "messageMediaDocument" || replied.media.document) {
        const doc = replied.media.document as unknown as { attributes?: unknown[]; id?: number | string; accessHash?: number | string; fileReference?: Uint8Array } | null;
        if (doc && doc.attributes) {
          isSticker = doc.attributes.some(
            (a: any) => {
              const t = a.type || a._ || a.className;
              return t === "documentAttributeSticker" || t === "sticker";
            },
          );
        }
        if (isSticker && doc.id && doc.accessHash) {
          documentToAdd = {
            _: 'inputDocument',
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference || Buffer.from([]),
          };
        }
      } else if (mediaType === "messageMediaPhoto" || replied.media.photo) {
        isPhoto = true;
      }

      if (!isSticker && !isPhoto) {
        await msg.edit({ text: "❌ 不支持的媒体类型,请回复贴纸或图片" });
        return;
      }

      // 检查贴纸包是否存在,不存在则创建
      let stickerSetExists = false;
      try {
        const stickerSet = await client.call({
          _: 'messages.getStickerSet',
          stickerset: {_: 'inputStickerSetShortName', shortName: this.config.stickerSetShortName},
          hash: 0,
        });
        stickerSetExists = stickerSet instanceof Object && stickerSet._ === 'messages.stickerSet';
      } catch (error: unknown) {
        // 如果贴纸包不存在,会抛出异常
        const errorMessage = getErrorMessage(error);
        if (errorMessage === "STICKERSET_INVALID") {
          stickerSetExists = false;
        } else {
          throw error;
        }
      }

      // 如果贴纸包不存在,需要先创建
      if (!stickerSetExists) {
        await this.createStickerSet(client, msg, replied, isSticker, isPhoto);
        return;
      }

      // 如果是贴纸,直接添加
      if (isSticker && documentToAdd) {
        try {
          await client.call({
            _: 'stickers.addStickerToSet',
            stickerset: {_: 'inputStickerSetShortName', shortName: this.config.stickerSetShortName},
            sticker: {
              _: 'inputStickerSetItem',
              document: documentToAdd,
              emoji: "📝",
            },
          });

          await msg.edit({
            text: html(`✅ 已成功添加到贴纸包!\n贴纸包: t.me/addstickers/${htmlEscape(this.config.stickerSetShortName)}`),
          });
        } catch (error: unknown) {
          logger.error("添加贴纸失败:", error);
          await msg.edit({
            text: html(`❌ 添加贴纸失败: ${htmlEscape(getErrorMessage(error) || String(error))}`),
          });
        }
        return;
      }

      // 如果是图片,需要先下载并转换为贴纸格式
      if (isPhoto) {
        try {
          // 下载图片
          const buffer = await client.downloadAsBuffer(
            replied.media as Parameters<typeof client.downloadAsBuffer>[0],
          ).then((b) => Buffer.from(b));
          if (!Buffer.isBuffer(buffer)) {
            await msg.edit({ text: "❌ 下载图片失败" });
            return;
          }

          // 上传为文件
          const file = await client.uploadFile({
            file: {
              name: "sticker.png",
              size: buffer.length,
              buffer: buffer,
            },
            workers: 1,
          });

          // 使用上传的文件
          await client.call({
            _: 'stickers.addStickerToSet',
            stickerset: {_: 'inputStickerSetShortName', shortName: this.config.stickerSetShortName},
            sticker: {
              _: 'inputStickerSetItem',
              document: file,
              emoji: "📝",
            },
          });

          await msg.edit({
            text: html(`✅ 已成功添加到贴纸包!\n贴纸包: t.me/addstickers/${htmlEscape(this.config.stickerSetShortName)}`),
          });
        } catch (error: unknown) {
          logger.error("处理图片失败:", error);
          await msg.edit({
            text: html(`❌ 处理图片失败: ${htmlEscape(getErrorMessage(error) || String(error))}`),
          });
        }
        return;
      }
    } catch (error: unknown) {
      logger.error("保存贴纸到贴纸包失败:", error);
      await msg.edit({
        text: html(`❌ 操作失败: ${htmlEscape(getErrorMessage(error) || String(error))}`),
      });
    }
  }

  async createStickerSet(
    client: any,
    msg: any,
    replied: any,
    isSticker: boolean,
    isPhoto: boolean,
  ) {
    try {
      // 准备第一个贴纸
      let firstSticker: any = null;

      const repliedMediaType = replied.media?.type || replied.media?._ || replied.media?.className;
      if (isSticker && (repliedMediaType === "messageMediaDocument" || replied.media?.document)) {
        const doc = replied.media.document as unknown as { id?: number | string; accessHash?: number | string; fileReference?: Uint8Array } | null;
        if (doc && doc.id && doc.accessHash) {
          firstSticker = {
            _: 'inputDocument',
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference || Buffer.from([]),
          };
        }
      } else if (isPhoto) {
        // 下载图片
        const buffer = await client.downloadAsBuffer(
          replied.media as Parameters<typeof client.downloadAsBuffer>[0],
        ).then((b) => Buffer.from(b));
        if (!Buffer.isBuffer(buffer)) {
          await msg.edit({ text: "❌ 下载图片失败" });
          return;
        }

        // 上传为文件
        firstSticker = await client.uploadFile({
          file: {
            name: "sticker.png",
            size: buffer.length,
            buffer: buffer,
          },
          workers: 1,
        });
      }

      if (!firstSticker) {
        await msg.edit({ text: "❌ 无法准备贴纸数据" });
        return;
      }

      // 获取当前用户信息
      const me = await safeGetMe(client);
      if (!me) return;

      // 创建贴纸包
      await client.call({
        _: 'stickers.createStickerSet',
        userId: me,
        title: `${this.config!.stickerSetShortName}`,
        shortName: this.config!.stickerSetShortName,
        stickers: [
          {
            _: 'inputStickerSetItem',
            document: firstSticker,
            emoji: "📝",
          },
        ],
      });

      await msg.edit({
        text: html(`✅ 已创建贴纸包并添加第一个贴纸!\n贴纸包: t.me/addstickers/${htmlEscape(
          this.config!.stickerSetShortName
        )}`),
      });
    } catch (error: unknown) {
      logger.error("创建贴纸包失败:", error);
      await msg.edit({
        text: html(`❌ 创建贴纸包失败: ${htmlEscape(getErrorMessage(error) || String(error))}`),
      });
    }
  }
}


  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "yvlu",
    title: "语录贴纸",
    description: "语录贴纸配置",
    category: "插件配置",
    icon: "💬",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "stickerSetShortName",
            "label": "贴纸包短名",
            "type": "string"
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<YvluConfig>(path.join(createDirectoryInAssets("yvlu"), "config.json"), defaultConfig);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<YvluConfig>(path.join(createDirectoryInAssets("yvlu"), "config.json"), defaultConfig);
      Object.assign(db.data, patch);
      await db.write();
    },
  };

export default new YvluPlugin();

//@ts-nocheck
import { safeGetMe } from "@utils/authGuards";
// YVLU Plugin - 生成文字语录贴纸
import axios from "axios";
import _ from "lodash";
import bigInteger from "big-integer";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api, utils } from "teleproto";
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
import { sleep } from "teleproto/Helpers";
import { safeGetReplyMessage, safeGetMessages } from "@utils/safeGetMessages";
import dayjs from "dayjs";
import { CustomFile } from "teleproto/client/uploads.js";
import * as zlib from "zlib";
import { execFile } from "child_process";
import { promisify } from "util";
import * as os from "os";

import { htmlEscape } from "@utils/htmlEscape";

const execFileAsync = promisify(execFile);

const timeout = 60000; // 超时
const PYTHON_PATH = "python3"; // Python 路径，可修改为 venv 中的路径，如："/path/to/venv/bin/python"

const QUOTE_RPC_TIMEOUT_MS = 20000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const avatarCache = new Map<string, Buffer | undefined>();
const customEmojiCache = new Map<string, Buffer | undefined>();

function stableEntityKey(entity: any): string | undefined {
  const raw = entity?.id ?? entity?.userId ?? entity?.channelId ?? entity?.chatId ?? entity?.accessHash ?? entity;
  if (!raw) return undefined;
  try {
    return typeof raw === "bigint" ? raw.toString() : JSON.stringify(raw, (_, v) => typeof v === "bigint" ? v.toString() : v);
  } catch (_) {
    return String(raw);
  }
}

async function downloadEntityAvatar(client: any, entity: any): Promise<Buffer | undefined> {
  if (!client || !entity) return undefined;
  const key = stableEntityKey(entity);
  if (key && avatarCache.has(key)) return avatarCache.get(key);

  // Resolve a full entity with photo + accessHash. getSender() may return a
  // min entity (no accessHash), and we need a full entity for getInputPeer.
  let fullEntity = entity;
  try {
    if (!(entity.accessHash !== undefined && !entity.min) && entity.id) {
      fullEntity = await withTimeout(client.getEntity(entity), QUOTE_RPC_TIMEOUT_MS, "downloadEntityAvatar.getEntity");
    }
  } catch (e: any) {
    console.warn("yvlu avatar getEntity failed, using raw entity", e?.message || e);
  }

  const photo = fullEntity?.photo;
  if (!photo || photo._ === "userProfilePhotoEmpty" || photo._ === "chatPhotoEmpty") {
    if (key) avatarCache.set(key, undefined);
    return undefined;
  }

  const tryDownload = async (isBig: boolean): Promise<Buffer | undefined> => {
    try {
      // Bypass the MediaScheduler (which retries 5×15s = 75s on failure) by
      // using raw upload.GetFile via client.invoke with the photo's DC.
      // This gives us a single attempt that our withTimeout can actually cap.
      const inputPeer = client.utils?.getInputPeer ? client.utils.getInputPeer(fullEntity) : (await withTimeout(client.getInputEntity(fullEntity), QUOTE_RPC_TIMEOUT_MS, "downloadEntityAvatar.getInputEntity"));
      const location = new Api.InputPeerPhotoFileLocation({
        peer: inputPeer,
        photoId: photo.photoId,
        big: isBig,
      });
      const dcId = photo.dcId ?? fullEntity?.photo?.dc_id;
      const result = await withTimeout(
        client.invoke(
          new Api.upload.GetFile({
            location,
            offset: bigInteger.zero,
            limit: 512 * 1024,
            precise: true,
          }),
          dcId,
        ),
        QUOTE_RPC_TIMEOUT_MS,
        `downloadEntityAvatar.${isBig ? "big" : "small"}`,
      ) as { bytes?: unknown };
      const buffer = result?.bytes;
      return Buffer.isBuffer(buffer) && buffer.length > 0 ? buffer : undefined;
    } catch (err: any) {
      console.warn(`yvlu avatar ${isBig ? "big" : "small"} download failed`, err?.message || err);
      return undefined;
    }
  };

  const [small, big] = await Promise.all([tryDownload(false), tryDownload(true)]);
  const normalized = small ? await normalizeAvatarBuffer(small) : big ? await normalizeAvatarBuffer(big) : undefined;
  if (key) avatarCache.set(key, normalized);
  return normalized;
}

async function normalizeAvatarBuffer(buffer: Buffer): Promise<Buffer> {
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(buffer)
      .resize(256, 256, { fit: "cover", position: "centre" })
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .png()
      .toBuffer();
  } catch (err: any) {
    console.warn("yvlu avatar normalize failed", err?.message || err);
    return buffer.length > 0 ? buffer : undefined;
  }
}

async function downloadCustomEmoji(client: any, doc: any): Promise<Buffer | undefined> {
  if (!client || !doc) return undefined;
  const id = String(doc.id ?? doc.documentId ?? doc.document_id ?? "");
  if (!id) return undefined;
  if (customEmojiCache.has(id)) return customEmojiCache.get(id);

  const location = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: "",
  });
  const buffer = await rawDownloadFile(client, location, doc.dcId);
  if (buffer) customEmojiCache.set(id, buffer);
  return buffer;
}

async function rawDownloadFile(client: any, location: any, dcId: number | undefined): Promise<Buffer | undefined> {
  if (!client || !location) return undefined;
  try {
    const result = await withTimeout(
      client.invoke(
        new Api.upload.GetFile({
          location,
          offset: bigInteger.zero,
          limit: 512 * 1024,
          precise: true,
        }),
        dcId,
      ),
      QUOTE_RPC_TIMEOUT_MS,
      "rawDownloadFile",
    ) as { bytes?: unknown };
    const buffer = result?.bytes;
    return Buffer.isBuffer(buffer) && buffer.length > 0 ? buffer : undefined;
  } catch (err: any) {
    console.warn("yvlu rawDownloadFile failed", err?.message || err);
    return undefined;
  }
}

async function downloadMediaBuffer(client: any, target: any): Promise<Buffer | undefined> {
  if (!client || !target) return undefined;
  // For small media (thumbnails, static stickers, photos), try raw upload.GetFile first
  // Fall back to downloadMedia if raw download fails or isn't applicable
  try {
    const media = target.media ?? target;
    // Try to get document/photo info for raw download
    let doc = media?.document ?? media?.photo;
    if (doc && doc.id && doc.accessHash) {
      // Small files: use raw download
      const isLarge = doc.size && doc.size > 1024 * 1024;
      if (!isLarge) {
        const location = new Api.InputDocumentFileLocation({
          id: doc.id,
          accessHash: doc.accessHash,
          fileReference: doc.fileReference,
          thumbSize: "w",
        });
        const rawBuffer = await rawDownloadFile(client, location, doc.dcId);
        if (rawBuffer) return rawBuffer;
      }
    }
  } catch (_) {}
  // Fallback to downloadMedia with timeout
  try {
    const downloaded = await withTimeout(client.downloadMedia(target, { outputFile: path.join(os.tmpdir(), `yvlu_media_${Date.now()}_${Math.random().toString(16).slice(2)}`) }), QUOTE_RPC_TIMEOUT_MS, "downloadMediaBuffer.downloadMedia");
    if (Buffer.isBuffer(downloaded)) return downloaded;
    if (downloaded && typeof downloaded === "string" && fs.existsSync(downloaded)) return fs.readFileSync(downloaded);
  } catch (err: any) {
    console.warn("yvlu media download failed", err?.message || err);
  }
  return undefined;
}

// Helper to check if file format needs conversion
function needsConversion(buffer: Buffer, mimeType: string | undefined): boolean {
  if (!buffer || !mimeType) return false;
  return mimeType === "application/x-tgsticker" || // TGS
    mimeType === "video/mp4" || mimeType === "image/gif" || // GIF/MP4
    isTgsFormat(buffer) || isMp4Format(buffer) || isWebmFormat(buffer);
}

async function downloadAndProcessMedia(client: any, message: any): Promise<{ buffer: Buffer; mime: string } | undefined> {
  if (!message.media) return undefined;

  let mediaTypeForQuote: string | undefined = undefined;
  const isSticker = message.media instanceof Api.MessageMediaDocument &&
    message.media.document &&
    message.media.document.attributes?.some((a: any) => a instanceof Api.DocumentAttributeSticker);

  if (isSticker) mediaTypeForQuote = "sticker";
  else mediaTypeForQuote = "photo";

  const mimeType = message.media.document?.mimeType;
  const isTgsSticker = isSticker && mimeType === "application/x-tgsticker";
  const isGifOrMp4 = mimeType === "video/mp4" || mimeType === "image/gif";

  const buffer = await downloadMediaBuffer(client, message);
  if (!Buffer.isBuffer(buffer)) return undefined;

  let finalBuffer = buffer;
  let finalMime = mimeType;

  // Convert TGS to WebM
  if (isTgsSticker || isTgsFormat(buffer)) {
    try {
      const depCheck = await checkTgsDependencies();
      if (!depCheck.ok) console.error(`[yvlu] ${depCheck.message}`);
      else {
        console.log(`[yvlu] 检测到 TGS 贴纸，开始转换为 WebM...`);
        finalBuffer = await convertTgsToWebm(buffer);
        finalMime = "video/webm";
        console.log(`[yvlu] TGS -> WebM 转换成功，大小: ${finalBuffer.length}`);
      }
    } catch (convertError) {
      console.error(`[yvlu] TGS 转换失败:`, convertError);
    }
  } else if (isGifOrMp4 || isMp4Format(buffer)) {
    try {
      console.log(`[yvlu] 检测到 GIF/MP4，开始转换为 WebM...`);
      finalBuffer = await convertMp4ToWebm(buffer);
      finalMime = "video/webm";
      console.log(`[yvlu] MP4 -> WebM 转换成功，大小: ${finalBuffer.length}`);
    } catch (convertError) {
      console.error(`[yvlu] MP4 转换失败:`, convertError);
    }
  }

  const mime = finalMime || (mediaTypeForQuote === "sticker" ? "image/webp" : "image/jpeg");
  console.log(`媒体下载: mimeType=${mimeType}, isTgs=${isTgsSticker}, isGif=${isGifOrMp4}, size=${finalBuffer.length}`);
  return { buffer: finalBuffer, mime };
}

async function getPeerEntity(client: any, peer: any): Promise<any | undefined> {
  if (!client || !peer) return undefined;
  const key = JSON.stringify(peer, (_, v) => typeof v === "bigint" ? v.toString() : v);
  try {
    return await withTimeout(client.getEntity(peer), QUOTE_RPC_TIMEOUT_MS, "getPeerEntity.getEntity");
  } catch (_) {
    try {
      return await withTimeout(client.getInputEntity(peer), QUOTE_RPC_TIMEOUT_MS, "getPeerEntity.getInputEntity");
    } catch (_) {
      return undefined;
    }
  }
}

async function senderEntity(msg: any): Promise<any | undefined> {
  const peer = (msg as any).senderId ?? (msg as any).fromId;
  const key = peer ? `sender:${stableEntityKey(peer)}` : undefined;
  try {
    const sender = await withTimeout((msg as any).getSender?.(), QUOTE_RPC_TIMEOUT_MS, "senderEntity.getSender");
    if (sender) {
      if (key) { /* cache if needed */ }
      return sender;
    }
  } catch (_) {}
  const entity = await getPeerEntity((msg as any).client, peer);
  return entity;
}

function emojiStatusIdFromEntity(entity: any): string | undefined {
  const status = entity?.emojiStatus ?? entity?.emoji_status;
  if (!status) return undefined;
  if (typeof status !== "object") {
    const id = status?.value ?? status;
    return id ? String(id) : undefined;
  }
  const documentId = status.documentId ?? status.document_id ?? status.customEmojiId ?? status.custom_emoji_id ?? status.id;
  if (!documentId) return undefined;
  return String(documentId);
}

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
  } catch (e) {
    return {
      ok: false,
      message:
        "缺少 rlottie-python 依赖，请运行: pip3 install rlottie-python Pillow --break-system-packages",
    };
  }
  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch (e) {
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
    } catch (e) {}
    try {
      fs.unlinkSync(gifPath);
    } catch (e) {}
    try {
      fs.unlinkSync(webmPath);
    } catch (e) {}
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
    } catch (e) {}
    try {
      fs.unlinkSync(webmPath);
    } catch (e) {}
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
    console.warn("Unknown WebP format, using default dimensions");
    return { width: 512, height: 768 };
  } catch (error) {
    console.warn("Failed to parse WebP dimensions:", error);
    return { width: 512, height: 768 };
  }
}

const codeTag = (text: string): string => `<code>${htmlEscape(text)}</code>`;

const getPeerNumericId = (peer?: Api.TypePeer): number | undefined => {
  if (!peer) return undefined;
  if (peer instanceof Api.PeerUser) return peer.userId;
  if (peer instanceof Api.PeerChat) return -peer.chatId;
  if (peer instanceof Api.PeerChannel) return -peer.channelId;
  return undefined;
};

const resolveForwardSenderFromHeader = async (
  forwardHeader: Api.MessageFwdHeader,
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
      const entity = await client?.getEntity(peer as any);
      if (entity) {
        return entity;
      }
    } catch (error) {
      const errMsg = (error?.errorMessage || error?.message || "").toString();
      if (!errMsg.includes("CHANNEL_PRIVATE")) {
        console.warn("解析转发发送者失败", error);
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
// （.help yvlu 整段显示在「功能描述」，不拆成短描述 + 空洞「使用方法」）
const help_text = [
  `- 不包含回复`,
  `<blockquote expandable>`,
  `使用 <code>${commandName} [消息数]</code> 回复一条消息(支持选择部分引用回复) ⚠️ 不得超过 5 条`,
  `</blockquote>`,
  ``,
  `- 包含回复`,
  `<blockquote expandable>`,
  `使用 <code>${commandName} r [消息数]</code> 回复一条消息(支持选择部分引用回复) ⚠️ 不得超过 5 条`,
  `</blockquote>`,
  ``,
  `- 输出格式（默认 webp 贴纸）`,
  `<blockquote expandable>`,
  `使用 <code>${commandName} webp</code> - 静态 WebP 贴纸`,
  `使用 <code>${commandName} image</code> - 背景大图 (PNG)`,
  `使用 <code>${commandName} stories</code> - 故事模式 (720×1280 PNG)`,
  `</blockquote>`,
  ``,
  `- 保存贴纸/图片到贴纸包`,
  `<blockquote expandable>`,
  `使用 <code>${commandName} s</code> 回复一张贴纸或图片,将其保存到配置的贴纸包中`,
  `</blockquote>`,
  ``,
  `- 配置管理`,
  `<blockquote expandable>`,
  `使用 <code>${commandName} config</code> 查看当前配置`,
  `使用 <code>${commandName} config sticker 贴纸包名称</code> 设置贴纸包名称`,
  `</blockquote>`,
].join("\n");

// 转换Telegram消息实体为quote-api格式
function convertEntities(entities: Api.TypeMessageEntity[]): any[] {
  if (!entities) return [];

  return entities.map((entity) => {
    // console.log(entity);
    const baseEntity = {
      offset: entity.offset,
      length: entity.length,
    };

    if (entity instanceof Api.MessageEntityBold) {
      return { ...baseEntity, type: "bold" };
    } else if (entity instanceof Api.MessageEntityItalic) {
      return { ...baseEntity, type: "italic" };
    } else if (entity instanceof Api.MessageEntityUnderline) {
      return { ...baseEntity, type: "underline" };
    } else if (entity instanceof Api.MessageEntityStrike) {
      return { ...baseEntity, type: "strikethrough" };
    } else if (entity instanceof Api.MessageEntityCode) {
      return { ...baseEntity, type: "code" };
    } else if (entity instanceof Api.MessageEntityPre) {
      return { ...baseEntity, type: "pre" };
    } else if (entity instanceof Api.MessageEntityCustomEmoji) {
      const documentId = (entity as any).documentId;
      const custom_emoji_id =
        documentId?.value?.toString() || documentId?.toString() || "";
      return {
        ...baseEntity,
        type: "custom_emoji",
        custom_emoji_id,
      };
    } else if (entity instanceof Api.MessageEntityUrl) {
      return { ...baseEntity, type: "url" };
    } else if (entity instanceof Api.MessageEntityTextUrl) {
      return {
        ...baseEntity,
        type: "text_link",
        url: (entity as any).url || "",
      };
    } else if (entity instanceof Api.MessageEntityMention) {
      return { ...baseEntity, type: "mention" };
    } else if (entity instanceof Api.MessageEntityMentionName) {
      return {
        ...baseEntity,
        type: "text_mention",
        user: { id: (entity as any).userId },
      };
    } else if (entity instanceof Api.MessageEntityHashtag) {
      return { ...baseEntity, type: "hashtag" };
    } else if (entity instanceof Api.MessageEntityCashtag) {
      return { ...baseEntity, type: "cashtag" };
    } else if (entity instanceof Api.MessageEntityBotCommand) {
      return { ...baseEntity, type: "bot_command" };
    } else if (entity instanceof Api.MessageEntityEmail) {
      return { ...baseEntity, type: "email" };
    } else if (entity instanceof Api.MessageEntityPhone) {
      return { ...baseEntity, type: "phone_number" };
    } else if (entity instanceof Api.MessageEntitySpoiler) {
      return { ...baseEntity, type: "spoiler" };
    }

    return baseEntity;
  });
}

// ======== quote-api 高级字段辅助函数 ========

function getDocumentAttributes(msg: Api.Message): any[] {
  const doc = (msg as any).document ?? (msg as any).media?.document;
  return doc?.attributes || [];
}

function audioAttribute(msg: Api.Message): any | undefined {
  return getDocumentAttributes(msg).find((a: any) => (a.className || a.constructor?.name || "").includes("Audio"));
}

function voiceWaveform(msg: Api.Message): number[] | undefined {
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

function getMediaKind(msg: Api.Message): string | undefined {
  const media: any = (msg as any).media;
  if (!media) return undefined;
  const cls = media.className || media.constructor?.name || "";
  const attrs = getDocumentAttributes(msg);
  if (attrs.some((a: any) => (a.className || "").includes("Sticker"))) return "sticker";
  if (attrs.some((a: any) => (a.className || "").includes("Animated")) || cls.includes("Dice")) return "animation";
  if (attrs.some((a: any) => (a.className || "").includes("Audio") && a.voice)) return "voice";
  if (attrs.some((a: any) => (a.className || "").includes("Audio"))) return "audio";
  if (attrs.some((a: any) => (a.className || "").includes("Video") && a.roundMessage)) return "round";
  if (attrs.some((a: any) => (a.className || "").includes("Video"))) return "video";
  if (cls.includes("Photo")) return "photo";
  if (cls.includes("Geo")) return "location";
  if (cls.includes("Venue")) return "venue";
  if (cls.includes("Contact")) return "contact";
  if (cls.includes("Poll")) return "poll";
  if (cls.includes("Document")) return "document";
  return "media";
}

async function forwardedSource(msg: Api.Message): Promise<{ peer?: any; entity?: any; name?: string; anonymous: boolean } | undefined> {
  const fwd: any = (msg as any).fwdFrom || (msg as any).fwd_from;
  if (!fwd) return undefined;
  const client: any = (msg as any).client;
  const headerName = fwd.fromName || fwd.savedFromName || fwd.postAuthor || "";
  // Try fromId peer resolution
  const peer = fwd.fromId || fwd.savedFromId || fwd.savedFromPeer;
  if (peer) {
    try {
      const entity = await withTimeout(client.getEntity(peer), QUOTE_RPC_TIMEOUT_MS, "forwardedSource.getEntity");
      const name = (entity as any)?.firstName || (entity as any)?.title || (entity as any)?.name || headerName || "Forwarded";
      return { peer, entity, name, anonymous: false };
    } catch (_) {}
  }
  if (headerName) return { name: headerName, anonymous: true };
  return { anonymous: true };
}

async function senderRankInChat(msg: Api.Message, entity: any): Promise<string | undefined> {
  if (!entity?.accessHash) return undefined;
  try {
    const client: any = (msg as any).client ?? await getGlobalClient().catch(() => null);
    if (!client) return undefined;
    const chatPeer = (msg as any).peerId ?? (msg as any).chatId ?? (msg as any).inputChat;
    const inputUser = new Api.InputUser({ userId: entity.id, accessHash: entity.accessHash });
    const result = await withTimeout(
      client.invoke(new Api.channels.GetParticipant({ channel: chatPeer, participant: inputUser })),
      QUOTE_RPC_TIMEOUT_MS, "senderRank.channels.getParticipant",
    );
    return (result as any)?.participant?.rank?.trim() || undefined;
  } catch { return undefined; }
}

// 调用quote-api生成语录
async function generateQuote(
  quoteData: any,
): Promise<{ buffer: Buffer; ext: string }> {
  try {
    const response = await axios({
      method: "post",
      timeout,
      data: quoteData,
      responseType: "arraybuffer",
      ...JSON.parse(
        Buffer.from(
          "eyJ1cmwiOiJodHRwczovL3F1b3RlLWFwaS1lbmhhbmNlZC56aGV0ZW5nc2hhLmV1Lm9yZy9nZW5lcmF0ZS53ZWJwIiwiaGVhZGVycyI6eyJDb250ZW50LVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIiwiVXNlci1BZ2VudCI6IlRlbGVCb3gvMC4yLjEifX0=",
          "base64",
        ).toString("utf-8"),
      ),
    });

    console.log("quote-api响应状态:", response.status);

    // // 检查响应格式
    // if (!response.data.ok || !response.data.result) {
    //   throw new Error("API响应格式错误，缺少result字段");
    // }

    // if (!response.data.result.image) {
    //   throw new Error("API响应中缺少image字段");
    // }

    // let imageBuffer: Buffer;

    // // 如果image是base64字符串，需要解码
    // if (typeof response.data.result.image === "string") {
    //   // 移除可能的data URL前缀
    //   const base64Data = response.data.result.image.replace(
    //     /^data:image\/[a-z]+;base64,/,
    //     ""
    //   );
    //   imageBuffer = Buffer.from(base64Data, "base64");
    // } else if (Buffer.isBuffer(response.data.result.image)) {
    //   imageBuffer = response.data.result.image;
    // } else {
    //   throw new Error("不支持的图片数据格式");
    // }

    // console.log("解码后图片数据长度:", imageBuffer.length);

    // 推断返回图片格式：
    // - 当 type === 'quote' 且 format === 'webp' 时，后端会生成 webp 贴纸
    // - 当 type === 'image' 或 type === 'stories' 时，后端输出的是 png
    const outExt = quoteData?.type === "quote" && quoteData?.format !== "png" ? "webp" : "png";
    return { buffer: response.data, ext: outExt };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(`quote-api请求失败:`, {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
      });
    } else {
      console.error(`调用quote-api失败: ${error}`);
    }
    throw error;
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

    console.log(`yvlu配置文件路径: ${this.configPath}`);

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
      console.log(`已创建默认配置文件: ${this.configPath}`);
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
        console.log(`重新初始化配置文件路径: ${this.configPath}`);
      }

      if (!fs.existsSync(this.configPath)) {
        console.error(`配置文件不存在: ${this.configPath}`);
        console.log(`请手动创建配置文件: ${this.configPath}`);
        this.config = { stickerSetShortName: "" };
        return;
      }

      const configData = fs.readFileSync(this.configPath, "utf-8");
      this.config = JSON.parse(configData);
      console.log("yvlu配置已加载:", this.config);
      console.log("stickerSetShortName:", this.config?.stickerSetShortName);
    } catch (error) {
      console.error("加载yvlu配置失败:", error);
      this.config = { stickerSetShortName: "" };
    }
  }

  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    yvlu: async (msg: Api.Message, trigger?: Api.Message) => {
      const start = Date.now();
      const args = msg.message.split(/\s+/);
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

          const messages = await safeGetMessages(msg.client, replied.peerId, {
            offsetId: replied!.id - 1,
            limit: count,
            reverse: true,
          });

          if (!messages || messages.length === 0) {
            await msg.edit({ text: "未找到消息" });
            return;
          }

          const items = [] as any[];
          let previousUserIdentifier: string | null = null;

          for await (const [i, message] of messages.entries()) {
            // 获取发送者信息
            let sender: any = await message.getSender();

            // 如果无法获取发送者（可能是以频道身份发言），尝试从 peerId 获取
            if (!sender) {
              try {
                const peerId =
                  (message as any).peerId || (message as any).fromId;
                if (peerId) {
                  sender = await client.getEntity(peerId);
                }
              } catch (e) {
                console.warn("从 peerId 获取发送者失败", e);
              }
            }

            if (message.fwdFrom) {
              let forwardedSender =
                message.forward?.sender || message.forward?.chat;

              if (!forwardedSender) {
                try {
                  forwardedSender = await message.forward?.getSender();
                } catch (error) {
                  console.warn("获取转发发送者失败", error);
                }
              }

              if (!forwardedSender) {
                forwardedSender = await resolveForwardSenderFromHeader(
                  message.fwdFrom,
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

            // 准备用户数据
            const userId = (sender as any).id?.toString();
            const name = (sender as any).name || "";
            const firstName =
              (sender as any).firstName || (sender as any).title || "";
            const lastName = (sender as any).lastName || "";
            const username = (sender as any).username || "";
            const emojiStatus =
              (sender as any).emojiStatus?.documentId?.toString() || null;

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
            let emojiStatusPayload: { custom_emoji_id: string; customEmojiBuffer: Buffer } | undefined;
            if (shouldShowAvatar) {
              try {
                const buffer = await downloadEntityAvatar(client, sender);
                if (Buffer.isBuffer(buffer) && buffer.length > 0) {
                  const base64 = buffer.toString("base64");
                  photo = {
                    url: `data:image/png;base64,${base64}`,
                  };
                } else {
                  console.warn("下载的头像数据无效或用户无头像");
                }
              } catch (e) {
                console.warn("下载用户头像失败", e);
              }

              // Download custom emoji for status emoji if present
              if (emojiStatus) {
                try {
                  const emojiId = String(emojiStatus);
                  if (!customEmojiCache.has(emojiId)) {
                    // Fetch custom emoji document
                    const docs = await withTimeout(
                      client.invoke(
                        new Api.messages.GetCustomEmojiDocuments({
                          documentId: [BigInt(emojiId)],
                        })
                      ),
                      QUOTE_RPC_TIMEOUT_MS,
                      "GetCustomEmojiDocuments"
                    );
                    const doc = docs?.[0];
                    if (doc) {
                      const buffer = await downloadCustomEmoji(client, doc);
                      if (buffer) customEmojiCache.set(emojiId, buffer);
                    }
                  }
                  const emojiBuffer = customEmojiCache.get(emojiId);
                  if (emojiBuffer) {
                    emojiStatusPayload = {
                      custom_emoji_id: emojiId,
                      customEmojiBuffer: emojiBuffer,
                    };
                  }
                } catch (e) {
                  console.warn("下载状态表情失败", e);
                }
              }
            }

            if (i === 0) {
              let replyTo = (trigger || msg)?.replyTo;
              if (replyTo?.quoteText) {
                message.message = replyTo.quoteText;
                message.entities = replyTo.quoteEntities;
              }
            }

            // 转换消息实体
            const entities = convertEntities(message.entities || []);

            // 处理回复引用（支持 quote header 与真实被回复消息）
            let replyBlock: any | undefined;
            if (r) {
              try {
                const replyHeader: any = (message as any).replyTo;

                // 1) 优先使用 quote header（包含被引用文本与实体偏移）
                if (replyHeader?.quote && replyHeader.quoteText) {
                  let replyName = "unknown";
                  let replyChatId: number | undefined = undefined;

                  // 尝试拿到被回复消息以获取发送者名称
                  try {
                    const repliedMsg = await safeGetReplyMessage(message);
                    if (repliedMsg) {
                      const repliedSender = await repliedMsg.getSender();
                      if (repliedSender) {
                        replyChatId = Number(repliedSender.id);
                        const rFirst =
                          (repliedSender as any).firstName ||
                          (repliedSender as any).title ||
                          "";
                        const rLast = (repliedSender as any).lastName || "";
                        const rUser = (repliedSender as any).username || "";
                        const composed = `${rFirst} ${rLast}`.trim();
                        replyName = composed || rUser || "unknown";
                      }
                    }
                  } catch {}

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
                  (message as any).isReply ||
                  replyHeader?.replyToMsgId
                ) {
                  try {
                    const repliedMsg = await safeGetReplyMessage(message);
                    if (repliedMsg) {
                      const repliedSender = await repliedMsg.getSender();
                      let replyName = "unknown";
                      let replyChatId: number | undefined;
                      if (repliedSender) {
                        replyChatId = Number(repliedSender.id);
                        const rFirst =
                          (repliedSender as any).firstName ||
                          (repliedSender as any).title ||
                          "";
                        const rLast = (repliedSender as any).lastName || "";
                        const rUser = (repliedSender as any).username || "";
                        const composed = `${rFirst} ${rLast}`.trim();
                        replyName = composed || rUser || "unknown";
                      }

                      // 使用被回复消息的文本 + 实体
                      const replyText = repliedMsg.message || "";
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
                  } catch {}
                }
              } catch (e) {
                console.warn("处理回复引用失败: ", e);
              }
            }

            let media: { url: string } | undefined = undefined;
                        try {
                          const mediaResult = await downloadAndProcessMedia(client, message);
                          if (mediaResult) {
                            const base64 = mediaResult.buffer.toString("base64");
                            media = { url: `data:${mediaResult.mime};base64,${base64}` };
                          }
                        } catch (e) {
                          console.error("下载媒体失败", e);
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
                emoji_status: shouldShowAvatar
                  ? (emojiStatusPayload || (emojiStatus ? { custom_emoji_id: String(emojiStatus) } : undefined))
                  : undefined,
              },
              text: message.message || "",
              entities: entities,
              avatar: shouldShowAvatar,
              ...(replyBlock ? { replyMessage: replyBlock } : {}),
            };

            // === quote-api glass 字段：voice / document / audio / forward / senderTag / mediaType / mediaDuration ===

            // 媒体
            if (media) msgItem.media = media;

            // 转发行标签
            if ((message as any).fwdFrom) {
              const fwdInfo = await forwardedSource(message).catch(() => undefined);
              if (fwdInfo?.name) {
                msgItem.forward = { label: fwdInfo.name };
              }
            }

            // 管理员标签
            if (sender && sender.accessHash) {
              const tag = await senderRankInChat(message, sender).catch(() => undefined);
              if (tag) msgItem.senderTag = tag;
            }

            // 媒体类型高级字段
            const mediaObj = (message as any).media;
            if (mediaObj) {
              const kind = getMediaKind(message);
              if (kind === "voice") {
                const waveform = voiceWaveform(message);
                const attr = audioAttribute(message);
                const duration = Number(attr?.duration ?? attr?.voiceDuration ?? 0) || undefined;
                if (waveform) msgItem.voice = { waveform, ...(duration !== undefined ? { duration } : {}) };
              } else if (kind === "document") {
                const doc = (message as any).document ?? (message as any).media?.document;
                const fn = doc?.attributes?.find((a: any) => a.className?.includes?.("Filename") || a.constructor?.name?.includes?.("Filename"));
                const name = String(fn?.fileName || fn?.file_name || "file");
                msgItem.document = { file_name: name };
              } else if (kind === "audio") {
                const attr = audioAttribute(message);
                const title = attr?.title || attr?.fileName || attr?.file_name || "Audio";
                const performer = attr?.performer || attr?.artist;
                const duration = Number(attr?.duration ?? 0) || undefined;
                msgItem.audio = { title, ...(performer ? { performer } : {}), ...(duration !== undefined ? { duration } : {}) };
              } else if (kind === "video" || kind === "animation" || kind === "round") {
                // 如果有 mediaCanvas（预先下载的媒体），标记 type/duration
                const attr = getDocumentAttributes(message).find((a: any) => a.className?.includes?.("Video") || a.constructor?.name?.includes?.("Video"));
                const mediaDuration = Number(attr?.duration ?? 0) || undefined;
                msgItem.mediaType = kind === "animation" ? "gif" : kind === "round" ? "video" : kind;
                if (mediaDuration) msgItem.mediaDuration = mediaDuration;
              }
            }

            items.push(msgItem);
          }

          const quoteData = {
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

          console.log(
            `[yvlu] API返回: buffer长度=${imageBuffer?.length}, ext=${imageExt}`,
          );
          console.log(
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

            console.log(
              `检测到的图片尺寸: ${dimensions.width}x${
                dimensions.height
              }, 格式: ${isWebm ? "webm" : "webp"}, 动态: ${
                isWebm || isAnimated
              }`,
            );

            if (isWebm) {
              // webm 格式：直接发送为贴纸（参考 eatgif）
              const os = await import("os");
              const tmpDir = os.tmpdir();
              const uniqueId = Date.now().toString();
              const webmPath = path.join(tmpDir, `sticker_${uniqueId}.webm`);

              try {
                fs.writeFileSync(webmPath, imageBuffer);

                await client.sendFile(msg.peerId, {
                  file: webmPath,
                  attributes: [
                    new Api.DocumentAttributeSticker({
                      alt: "📝",
                      stickerset: new Api.InputStickerSetEmpty(),
                    }),
                  ],
                  replyTo: replied?.id,
                });

                console.log("[yvlu] 动态贴纸发送成功 (webm)");
              } finally {
                try {
                  fs.unlinkSync(webmPath);
                } catch (e) {}
              }
            } else {
              // webp/png 格式：发送为静态贴纸
              const file = new CustomFile(
                `sticker.${imageExt}`,
                imageBuffer.length,
                "",
                imageBuffer,
              );

              const stickerAttr = new Api.DocumentAttributeSticker({
                alt: "📝",
                stickerset: new Api.InputStickerSetEmpty(),
              });

              const imageSizeAttr = new Api.DocumentAttributeImageSize({
                w: dimensions.width,
                h: dimensions.height,
              });

              const filenameAttr = new Api.DocumentAttributeFilename({
                fileName: `sticker.${imageExt}`,
              });

              await client.sendFile(msg.peerId, {
                file,
                forceDocument: false,
                attributes: [stickerAttr, imageSizeAttr, filenameAttr],
                replyTo: replied?.id,
              });

              console.log("[yvlu] 静态贴纸发送成功");
            }

            console.log("[yvlu] 文件发送成功");
          } catch (fileError) {
            console.error(`发送文件失败: ${fileError}`);
            await msg.edit({ text: `发送文件失败: ${htmlEscape(String(fileError))}`, parseMode: "html" });
            return;
          }

          await msg.delete();

          const end = Date.now();
          console.log(`语录生成耗时: ${end - start}ms`);
        } catch (error) {
          console.error(`语录生成失败: ${error}`);
          await msg.edit({ text: `语录生成失败: ${htmlEscape(String(error))}`, parseMode: "html" });
        }
      } else {
        await msg.edit({
          text: help_text,
          parseMode: "html",
        });
      }
    },
  };

  async handleConfigCommand(msg: Api.Message, args: string[]) {
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
        await msg.edit({ text: configInfo, parseMode: "html" });
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
              text: `❌ 请提供贴纸包名称\n用法: <code>${commandName} config sticker 贴纸包名称</code>`,
              parseMode: "html",
            });
            return;
          }

          // 验证贴纸包名称格式（只能包含字母、数字和下划线）
          if (!/^[a-zA-Z0-9_]+$/.test(newName)) {
            await msg.edit({
              text: "❌ 贴纸包名称只能包含字母、数字和下划线",
              parseMode: "html",
            });
            return;
          }

          // 贴纸包名称长度限制
          if (newName.length < 1 || newName.length > 64) {
            await msg.edit({
              text: "❌ 贴纸包名称长度应在 1-64 个字符之间",
              parseMode: "html",
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
            text: `✅ 贴纸包名称已设置为: ${codeTag(newName)}\n贴纸包链接: t.me/addstickers/${htmlEscape(newName)}`,
            parseMode: "html",
          });
          break;
        }

        default:
          await msg.edit({
            text: `❌ 未知的配置项: ${codeTag(subCommand)}\n\n可用配置命令:\n<code>${commandName} config sticker 贴纸包名称</code> - 设置贴纸包名称`,
            parseMode: "html",
          });
      }
    } catch (error: any) {
      console.error("处理配置命令失败:", error);
      await msg.edit({
        text: `❌ 配置操作失败: ${htmlEscape(error.message || String(error))}`,
        parseMode: "html",
      });
    }
  }

  async handleSaveStickerToSet(msg: Api.Message) {
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
          console.log(`已创建默认配置文件: ${this.configPath}`);
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
          text: `❌ 未配置贴纸包!\n请编辑配置文件: ${htmlEscape(this.configPath)}\n设置 stickerSetShortName`,
          parseMode: "html",
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
      let documentToAdd: Api.InputDocument | null = null;

      if (replied.media instanceof Api.MessageMediaDocument) {
        const doc = replied.media.document as any;
        if (doc && doc.attributes) {
          isSticker = doc.attributes.some(
            (a: any) => a instanceof Api.DocumentAttributeSticker,
          );
        }
        if (isSticker && doc.id && doc.accessHash) {
          documentToAdd = new Api.InputDocument({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference || Buffer.from([]),
          });
        }
      } else if (replied.media instanceof Api.MessageMediaPhoto) {
        isPhoto = true;
      }

      if (!isSticker && !isPhoto) {
        await msg.edit({ text: "❌ 不支持的媒体类型,请回复贴纸或图片" });
        return;
      }

      // 检查贴纸包是否存在,不存在则创建
      let stickerSetExists = false;
      try {
        const stickerSet = await client.invoke(
          new Api.messages.GetStickerSet({
            stickerset: new Api.InputStickerSetShortName({
              shortName: this.config.stickerSetShortName,
            }),
            hash: 0,
          }),
        );
        stickerSetExists = stickerSet instanceof Api.messages.StickerSet;
      } catch (error: any) {
        // 如果贴纸包不存在,会抛出异常
        if (error.errorMessage === "STICKERSET_INVALID") {
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
          await client.invoke(
            new Api.stickers.AddStickerToSet({
              stickerset: new Api.InputStickerSetShortName({
                shortName: this.config.stickerSetShortName,
              }),
              sticker: new Api.InputStickerSetItem({
                document: documentToAdd,
                emoji: "📝",
              }),
            }),
          );

          await msg.edit({
            text: `✅ 已成功添加到贴纸包!\n贴纸包: t.me/addstickers/${htmlEscape(this.config.stickerSetShortName)}`,
            parseMode: "html",
          });
        } catch (error: any) {
          console.error("添加贴纸失败:", error);
          await msg.edit({
            text: `❌ 添加贴纸失败: ${htmlEscape(error.message || String(error))}`,
            parseMode: "html",
          });
        }
        return;
      }

      // 如果是图片,需要先下载并转换为贴纸格式
      if (isPhoto) {
        try {
          // 下载图片
          const buffer = await downloadMediaBuffer(client, replied);
          if (!Buffer.isBuffer(buffer)) {
            await msg.edit({ text: "❌ 下载图片失败" });
            return;
          }

          // 上传为文件
          const file = await client.uploadFile({
            file: new CustomFile("sticker.png", buffer.length, "", buffer),
            workers: 1,
          });

          // 创建 InputStickerSetItem
          const stickerItem = new Api.InputStickerSetItem({
            document: new Api.InputDocument({
              id: BigInt(0),
              accessHash: BigInt(0),
              fileReference: Buffer.from([]),
            }),
            emoji: "📝",
          });

          // 使用上传的文件
          await client.invoke(
            new Api.stickers.AddStickerToSet({
              stickerset: new Api.InputStickerSetShortName({
                shortName: this.config.stickerSetShortName,
              }),
              sticker: new Api.InputStickerSetItem({
                document: file as any,
                emoji: "📝",
              }),
            }),
          );

          await msg.edit({
            text: `✅ 已成功添加到贴纸包!\n贴纸包: t.me/addstickers/${htmlEscape(this.config.stickerSetShortName)}`,
            parseMode: "html",
          });
        } catch (error: any) {
          console.error("处理图片失败:", error);
          await msg.edit({
            text: `❌ 处理图片失败: ${htmlEscape(error.message || String(error))}`,
            parseMode: "html",
          });
        }
        return;
      }
    } catch (error: any) {
      console.error("保存贴纸到贴纸包失败:", error);
      await msg.edit({
        text: `❌ 操作失败: ${htmlEscape(error.message || String(error))}`,
        parseMode: "html",
      });
    }
  }

  async createStickerSet(
    client: any,
    msg: Api.Message,
    replied: Api.Message,
    isSticker: boolean,
    isPhoto: boolean,
  ) {
    try {
      // 准备第一个贴纸
      let firstSticker: any = null;

      if (isSticker && replied.media instanceof Api.MessageMediaDocument) {
        const doc = replied.media.document as any;
        if (doc && doc.id && doc.accessHash) {
          firstSticker = new Api.InputDocument({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference || Buffer.from([]),
          });
        }
      } else if (isPhoto) {
        // 下载图片
        const buffer = await downloadMediaBuffer(client, replied);
        if (!Buffer.isBuffer(buffer)) {
          await msg.edit({ text: "❌ 下载图片失败" });
          return;
        }

        // 上传为文件
        firstSticker = await client.uploadFile({
          file: new CustomFile("sticker.png", buffer.length, "", buffer),
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
      await client.invoke(
        new Api.stickers.CreateStickerSet({
          userId: me,
          title: `${this.config!.stickerSetShortName}`,
          shortName: this.config!.stickerSetShortName,
          stickers: [
            new Api.InputStickerSetItem({
              document: firstSticker,
              emoji: "📝",
            }),
          ],
        }),
      );

      await msg.edit({
        text: `✅ 已创建贴纸包并添加第一个贴纸!\n贴纸包: t.me/addstickers/${htmlEscape(
          this.config!.stickerSetShortName
        )}`,
        parseMode: "html",
      });
    } catch (error: any) {
      console.error("创建贴纸包失败:", error);
      await msg.edit({
        text: `❌ 创建贴纸包失败: ${htmlEscape(error.message || String(error))}`,
        parseMode: "html",
      });
    }
  }
}

export default new YvluPlugin();

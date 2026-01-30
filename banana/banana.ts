import axios from "axios";
import path from "path";
import type { Low } from "lowdb";
import { JSONFilePreset } from "lowdb/node";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import { createDirectoryInAssets } from "@utils/pathHelpers";

interface BananaConfig {
  apiKey: string;
  maxBytes: number;
}

const FIXED_MODEL = "gemini-3-pro-image-preview";
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const MIN_ALLOWED_IMAGE_BYTES = 256 * 1024; // 256KB
const MAX_ALLOWED_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB

const CONFIG_DEFAULTS: BananaConfig = {
  apiKey: "",
  maxBytes: DEFAULT_MAX_IMAGE_BYTES,
};

const help_text =
  "🎯 <b>Nano-Banana 图像编辑插件</b>\n" +
  "• 回复图片并附带 <code>.banana 提示词</code> 调用 Gemini Nano-Banana 修改图像\n" +
  "• <code>.banana key &lt;密钥&gt;</code> 配置 Gemini API Key\n" +
  "• <code>.banana limit &lt;数值/MB&gt;</code> 调整图片大小上限（默认 10MB，可用 default 重置）\n" +
  "• 使用 <code>.help banana</code> 随时查看此帮助";

const dataDir = createDirectoryInAssets("banana");
const configPath = path.join(dataDir, "config.json");
let dbPromise: Promise<Low<BananaConfig>> | null = null;

const htmlEscape = (input: string): string =>
  input.replace(
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

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(mb >= 10 ? 0 : 1).replace(/\.0$/, "")}MB`;
  }
  if (bytes >= 1024) {
    const kb = bytes / 1024;
    return `${kb.toFixed(kb >= 10 ? 0 : 1).replace(/\.0$/, "")}KB`;
  }
  return `${bytes}B`;
};

function estimateMediaSizeBytes(message: Api.Message): number {
  const doc = (message as any).document;
  if (doc && typeof doc.size === "number") {
    return Number(doc.size);
  }

  const video = (message as any).video;
  if (video && typeof video.size === "number") {
    return Number(video.size);
  }

  const gif = (message as any).gif;
  if (gif && typeof gif.size === "number") {
    return Number(gif.size);
  }

  const photo = (message as any).photo;
  if (photo && Array.isArray(photo.sizes)) {
    let max = 0;
    for (const size of photo.sizes) {
      const progressive = (size as any).sizes;
      if (Array.isArray(progressive) && progressive.length) {
        const candidate = Math.max(...progressive);
        if (candidate > max) max = candidate;
      }
      const directSize = (size as any).size;
      if (typeof directSize === "number" && directSize > max) {
        max = directSize;
      }
    }
    return max;
  }

  return 0;
}

async function getDb(): Promise<Low<BananaConfig>> {
  if (!dbPromise) {
    dbPromise = JSONFilePreset<BananaConfig>(configPath, {
      ...CONFIG_DEFAULTS,
    });
  }
  const db = await dbPromise;
  db.data ||= { ...CONFIG_DEFAULTS };
  db.data = { ...CONFIG_DEFAULTS, ...db.data };
  return db;
}

async function getConfigValue<TKey extends keyof BananaConfig>(
  key: TKey,
): Promise<BananaConfig[TKey]> {
  const db = await getDb();
  const value = db.data![key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return CONFIG_DEFAULTS[key];
    }
  }
  return value ?? CONFIG_DEFAULTS[key];
}

async function setConfigValue<TKey extends keyof BananaConfig>(
  key: TKey,
  value: BananaConfig[TKey],
): Promise<void> {
  const db = await getDb();
  db.data![key] = value;
  await db.write();
}

function parseSizeInput(raw: string): number | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;

  const match = normalized.match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/);
  if (!match) return null;

  const value = parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = match[2] || "mb";
  const multiplier =
    unit === "gb"
      ? 1024 * 1024 * 1024
      : unit === "mb"
        ? 1024 * 1024
        : unit === "kb"
          ? 1024
          : 1;

  const bytes = Math.round(value * multiplier);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return bytes;
}

function normalizeMaxBytes(bytes: number | string | null | undefined): number {
  const numeric = typeof bytes === "number" ? bytes : Number(bytes);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_MAX_IMAGE_BYTES;
  }
  const rounded = Math.round(numeric);
  if (rounded < MIN_ALLOWED_IMAGE_BYTES) {
    return MIN_ALLOWED_IMAGE_BYTES;
  }
  if (rounded > MAX_ALLOWED_IMAGE_BYTES) {
    return MAX_ALLOWED_IMAGE_BYTES;
  }
  return rounded;
}

async function resolveMaxImageBytes(): Promise<number> {
  const stored = await getConfigValue("maxBytes");
  return normalizeMaxBytes(stored as any);
}

function maskKey(key: string): string {
  if (!key) return "(未配置)";
  if (key.length <= 8) return `${key.slice(0, 2)}***${key.slice(-2)}`;
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

function resolveMimeType(media: any): string {
  const documentMime = media?.document?.mimeType;
  if (typeof documentMime === "string" && documentMime.startsWith("image/")) {
    return documentMime;
  }
  if (media?.photo) {
    return "image/jpeg";
  }
  return "image/png";
}

function extFromMime(mime: string): string {
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "png";
}

async function handleConfig(
  msg: Api.Message,
  subcommand: string,
  subValue: string,
): Promise<void> {
  switch (subcommand) {
    case "key": {
      if (!subValue) {
        await msg.edit({
          text: "❌ 请提供 Gemini API Key，例如 `.banana key AIza...`",
        });
        return;
      }
      await setConfigValue("apiKey", subValue.trim());
      await msg.edit({ text: "✅ 已更新 Gemini API Key" });
      return;
    }
    case "limit": {
      if (!subValue) {
        const current = await resolveMaxImageBytes();
        await msg.edit({
          text: `当前图片大小上限：${formatBytes(current)}（范围 ${formatBytes(MIN_ALLOWED_IMAGE_BYTES)} - ${formatBytes(MAX_ALLOWED_IMAGE_BYTES)}）\n使用 <code>.banana limit default</code> 可恢复默认值`,
          parseMode: "html",
        });
        return;
      }

      const lowered = subValue.trim().toLowerCase();
      if (lowered === "default" || lowered === "reset") {
        await setConfigValue("maxBytes", DEFAULT_MAX_IMAGE_BYTES);
        await msg.edit({
          text: `✅ 已恢复默认图片大小上限 ${formatBytes(DEFAULT_MAX_IMAGE_BYTES)}`,
        });
        return;
      }

      const parsed = parseSizeInput(subValue);
      if (parsed === null) {
        await msg.edit({
          text: "❌ 无法识别的大小，请使用如 `8`, `8MB`, `2048KB`、`0.5GB` 等格式。",
        });
        return;
      }

      if (parsed < MIN_ALLOWED_IMAGE_BYTES) {
        await msg.edit({
          text: `❌ 数值过小，最小支持 ${formatBytes(MIN_ALLOWED_IMAGE_BYTES)}`,
        });
        return;
      }

      if (parsed > MAX_ALLOWED_IMAGE_BYTES) {
        await msg.edit({
          text: `❌ 数值过大，最大支持 ${formatBytes(MAX_ALLOWED_IMAGE_BYTES)}`,
        });
        return;
      }

      await setConfigValue("maxBytes", parsed);
      await msg.edit({
        text: `✅ 已将图片大小上限设置为 ${formatBytes(parsed)}`,
      });
      return;
    }
    case "config": {
      const [apiKey, maxBytes] = await Promise.all([
        getConfigValue("apiKey"),
        resolveMaxImageBytes(),
      ]);
      await msg.edit({
        text: `🔧 当前配置\n• API Key: ${maskKey(apiKey)}\n• 图片大小上限: ${formatBytes(maxBytes)}`,
      });
      return;
    }
    case "help": {
      await msg.edit({ text: "ℹ️ 帮助内容已迁移至 `.help banana`" });
      return;
    }
    default:
      await msg.edit({ text: "❓ 未知子命令，使用 `.help banana` 查看说明" });
  }
}

async function handleImageEdit(
  msg: Api.Message,
  promptText: string,
): Promise<void> {
  const apiKey = (await getConfigValue("apiKey")).trim();
  if (!apiKey) {
    await msg.edit({
      text: "❌ 未配置 Gemini API Key，请先执行 `.banana key <密钥>`",
    });
    return;
  }

  const prompt = promptText.trim();
  if (!prompt) {
    await msg.edit({
      text: "❌ 请在命令后提供提示词，例如 `.banana 把猫换成骑士盔甲`",
    });
    return;
  }

  const replyMsg = await msg.getReplyMessage();
  if (!replyMsg || !replyMsg.media) {
    await msg.edit({ text: "❌ 请回复一条包含图片的消息后再执行命令" });
    return;
  }

  const client = (msg as any).client;
  if (!client) {
    await msg.edit({ text: "❌ 无法获取客户端实例" });
    return;
  }

  const maxBytes = await resolveMaxImageBytes();
  const limitLabel = formatBytes(maxBytes);
  const hintedSize = estimateMediaSizeBytes(replyMsg);
  if (hintedSize > maxBytes) {
    await msg.edit({
      text: `❌ 图片文件过大（${formatBytes(hintedSize)}），最大支持 ${limitLabel}`,
    });
    return;
  }

  await msg.edit({ text: "⬇️ 正在下载图片..." });

  let mediaBuffer: Buffer | null = null;
  try {
    const mediaData = await client.downloadMedia(replyMsg.media, {
      workers: 1,
    });
    if (Buffer.isBuffer(mediaData)) {
      mediaBuffer = mediaData;
    } else if (mediaData && typeof (mediaData as any).read === "function") {
      const chunks: Buffer[] = [];
      for await (const chunk of mediaData as any) {
        chunks.push(Buffer.from(chunk));
      }
      mediaBuffer = Buffer.concat(chunks);
    }
  } catch (error) {
    await msg.edit({ text: `❌ 图片下载失败: ${error}` });
    return;
  }

  if (!mediaBuffer) {
    await msg.edit({ text: "❌ 未能获取到图片数据" });
    return;
  }

  if (mediaBuffer.length > maxBytes) {
    await msg.edit({
      text: `❌ 图片文件过大（${formatBytes(mediaBuffer.length)}），最大支持 ${limitLabel}`,
    });
    return;
  }

  const mimeType = resolveMimeType(replyMsg.media);
  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: mediaBuffer.toString("base64"),
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  await msg.edit({ text: "🤖 正在调用 Gemini Nano-Banana 生成..." });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${FIXED_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let responseData: any;
  try {
    const response = await axios.post(url, requestBody, { timeout: 120000 });
    responseData = response.data;
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const message = error.response?.data?.error?.message || error.message;
      await msg.edit({
        text: `❌ Gemini 请求失败 (${status ?? "网络错误"}): ${message}`,
      });
    } else {
      await msg.edit({ text: `❌ 请求失败: ${(error as Error).message}` });
    }
    return;
  }

  const candidates: any[] = responseData?.candidates || [];
  if (!candidates.length) {
    const blockReason = responseData?.promptFeedback?.blockReason;
    if (blockReason) {
      await msg.edit({ text: `❌ 请求被阻止: ${blockReason}` });
    } else {
      await msg.edit({ text: "❌ 未收到模型返回结果" });
    }
    return;
  }

  const finishReason = candidates[0]?.finishReason;
  if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
    await msg.edit({ text: `❌ 生成被中断: ${finishReason}` });
    return;
  }

  const inlineParts: any[] = [];
  const textParts: string[] = [];

  for (const candidate of candidates) {
    const parts: any[] = candidate?.content?.parts || [];
    for (const part of parts) {
      // Support both snake_case and camelCase responses
      const inlineData = part?.inline_data || part?.inlineData;
      if (inlineData?.data) {
        inlineParts.push(inlineData);
      }
      if (typeof part?.text === "string" && part.text.trim()) {
        textParts.push(part.text.trim());
      }
    }
  }

  if (!inlineParts.length && !textParts.length) {
    await msg.edit({ text: `❌ 模型未返回可用的图像或文本 (finishReason: ${finishReason || "unknown"})` });
    return;
  }

  const captionBase = `<b>提示:</b> ${htmlEscape(prompt)}`;
  const extraText = textParts.length
    ? `\n\n${htmlEscape(textParts.join("\n"))}`
    : "";
  const caption = `${captionBase}${extraText}`;

  let sent = false;
  for (let index = 0; index < inlineParts.length; index += 1) {
    const part = inlineParts[index];
    const data = part.data as string;
    const mime =
      typeof part.mime_type === "string" ? part.mime_type :
      typeof part.mimeType === "string" ? part.mimeType : "image/png";
    const buffer = Buffer.from(data, "base64");
    if (!buffer.length) continue;

    const fileName = `banana_${Date.now()}_${index}.${extFromMime(mime)}`;
    const file = new CustomFile(fileName, buffer.length, "", buffer);

    await client.sendFile(msg.peerId, {
      file,
      caption: !sent ? caption : undefined,
      parseMode: !sent ? "html" : undefined,
      replyTo: replyMsg.id,
    });
    sent = true;
  }

  if (!sent && textParts.length) {
    await client.sendMessage(msg.peerId, {
      message: caption,
      parseMode: "html",
      replyTo: replyMsg.id,
    });
    sent = true;
  }

  if (sent) {
    try {
      await msg.delete();
    } catch (error) {
      await msg.edit({ text: caption, parseMode: "html" });
    }
  } else {
    await msg.edit({ text: "❌ 未成功发送生成的内容" });
  }
}

async function handleBananaCommand(msg: Api.Message): Promise<void> {
  const raw = msg.message || "";
  const trimmed = raw.trim();
  const tokens = trimmed ? trimmed.split(/\s+/) : [];
  tokens.shift();
  const subcommand = (tokens[0] || "").toLowerCase();
  const subValue = tokens.slice(1).join(" ").trim();
  const textAfterCommand = trimmed.replace(/^\S+\s*/, "").trim();

  const configCommands = new Set(["key", "limit", "config", "help"]);
  if (configCommands.has(subcommand)) {
    await handleConfig(msg, subcommand, subValue);
    return;
  }

  await handleImageEdit(msg, textAfterCommand);
}

class BananaPlugin extends Plugin {
  description: string = `Nano-Banana 图像编辑插件\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    banana: handleBananaCommand,
  };
}

export default new BananaPlugin();

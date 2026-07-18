import { Api } from "teleproto";
import { CustomFile } from "teleproto/client/uploads";
import { utils } from "teleproto";
import big_integer from "big-integer";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import { npm_install } from "@utils/npm_install";
const { execFile } = require("child_process");
import { safeGetReplyMessage, safeGetMessages } from "@utils/safeGetMessages";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";

const DEFAULT_BACKGROUND = "#231d2b/#372e44";
const DEFAULT_EMOJI_BRAND = "apple";
const MAX_QUOTE_MESSAGES = 50;
const QUOTE_EMOJIS = "💜";
const EMOJI_SUFFIXES = [
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚", "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓", "😎", "🤩", "🥳", "😏", "😒", "😞", "😔", "😟", "😕", "🙁", "☹️", "😣", "😖", "😫", "😩", "🥺", "😢", "😭", "😤", "😠", "😡", "🤬", "🤯", "😳", "🥵", "🥶", "😱", "😨", "😰", "😥", "😓", "🤗", "🤔", "🤭", "🤫", "🤥", "😶", "😐", "😑", "😬", "🙄", "😯", "😦", "😧", "😮", "😲", "🥱", "😴", "🤤", "😪", "😵", "🤐", "🥴", "🤢", "🤮", "🤧", "😷", "🤒", "🤕", "🤑", "🤠", "😈", "👿", "👹", "👺", "🤡", "💩", "👻", "💀", "☠️", "👽", "👾", "🤖", "🎃", "😺", "😸", "😹", "😻", "😼", "😽", "🙀", "😿", "😾"
];

const customEmojiCache = new Map<string, Buffer | undefined>();
const animatedCustomEmojiCache = new Map<string, Buffer | undefined>();
const animatedFrameCache = new Map<string, AnimatedFrameSet>();
const entityCache = new Map<string, any>();
const avatarCache = new Map<string, Buffer | undefined>();
const EMOJI_FETCH_CONCURRENCY = 8;
const QUOTE_MESSAGE_CONCURRENCY = 8;
const ANIMATED_FRAME_CONCURRENCY = 4;
const TG_STICKER_FPS = 10;
const TG_STICKER_MAX_DURATION = 3;
const TG_STICKER_MAX_FRAMES = 100;
const TG_STICKER_MAX_BYTES = 512 * 1024;
const WEBM_CRF_STEPS = [38, 44, 50, 56];

const QUOTE_PLUGIN_VERSION = "1.12";
const QUOTE_BASE_URL = "https://raw.githubusercontent.com/TeleBoxOrg/TeleBox-Plugins/main/quote";
const QUOTE_ASSETS_BASE_URL = "https://raw.githubusercontent.com/LyoSU/quote-api/master/assets";
const QUOTE_VENDOR_DIR = path.join(quotePluginDir(), "quote", "vendor");
const QUOTE_ASSETS_DIR = path.join(process.cwd(), "assets", "quote");
// npm packages required by vendor/ at module load that are NOT in the host
// package.json. Installed on demand in getQuoteGen() before requiring generate.js.
const QUOTE_VENDOR_NPM_DEPS = ["telegraf", "lru-cache", "runes", "jimp", "smartcrop-sharp", "emoji-db"];
const QUOTE_DEP_FILES = [
  "generate.js",
  "vendor/emoji-db.js",
  "vendor/emoji-image.js",
  "vendor/image-load-path.js",
  "vendor/image-load-url.js",
  "vendor/index.js",
  "vendor/promise-concurrent.js",
  "vendor/quote-generate/attachments.js",
  "vendor/quote-generate/avatar.js",
  "vendor/quote-generate/canvas-utils.js",
  "vendor/quote-generate/color.js",
  "vendor/quote-generate/composer.js",
  "vendor/quote-generate/constants.js",
  "vendor/quote-generate/index.js",
  "vendor/quote-generate/layout-box.js",
  "vendor/quote-generate/media.js",
  "vendor/quote-generate/text-layout.js",
  "vendor/quote-generate/text-prepare.js",
  "vendor/quote-generate/text-render.js",
  "vendor/quote-generate/text-renderer.js",
  "vendor/user-name.js",
  "assets/icons/insert_drive_file.svg",
  "assets/icons/music_note.svg",
  "assets/icons/play_arrow.svg",
];
const QUOTE_ASSET_FILES = [
  "pattern_02.png",
  "pattern_ny.png",
  "emoji/emoji-apple-image.json",
  "emoji/emoji-google-image.json",
  "emoji/emoji-twitter-image.json",
  "emoji/emoji-joypixels-image.json",
  "emoji/emoji-blob-image.json",
];
const QUOTE_FONT_FILES = [
  { name: "NotoSansCJK-Regular.ttc", url: "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTC/NotoSansCJK-Regular.ttc" },
  { name: "NotoSansCJK-Bold.ttc", url: "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTC/NotoSansCJK-Bold.ttc" },
];

let quoteGenPromise: Promise<any> | undefined;
let sharpPromise: Promise<any> | undefined;
let canvasPromise: Promise<any> | undefined;

function quotePluginDir(): string {
  return __dirname;
}


async function fetchToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadFileIfMissingOrChanged(url: string, filePath: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data = await fetchToBuffer(url);
  if (fs.existsSync(filePath)) {
    const old = fs.readFileSync(filePath);
    if (old.length === data.length && old.equals(data)) return;
  }
  fs.writeFileSync(filePath, data);
}

function requireOrInstall(pkg: string): any {
  try {
    return require(pkg);
  } catch (err: any) {
    const code = err?.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") throw err;
    console.warn("quote loader installing npm package", { pkg });
    npm_install(pkg);
    return require(pkg);
  }
}

async function getSharp(): Promise<any> {
  if (!sharpPromise) sharpPromise = Promise.resolve(requireOrInstall("sharp"));
  return sharpPromise;
}

async function getCanvas(): Promise<any> {
  if (!canvasPromise) canvasPromise = Promise.resolve(requireOrInstall("canvas"));
  return canvasPromise;
}

function quoteResourcesReady(): boolean {
  const quoteDir = path.join(quotePluginDir(), "quote");
  const versionFile = path.join(quoteDir, ".version");
  let currentVersion = "";
  try { currentVersion = fs.readFileSync(versionFile, "utf8").trim(); } catch (_) {}
  if (currentVersion !== QUOTE_PLUGIN_VERSION) return false;
  if (QUOTE_DEP_FILES.some((rel) => !fs.existsSync(path.join(quoteDir, rel)))) return false;
  if (QUOTE_ASSET_FILES.some((rel) => !fs.existsSync(path.join(QUOTE_ASSETS_DIR, rel)))) return false;
  if (QUOTE_FONT_FILES.some((font) => !fs.existsSync(path.join(QUOTE_ASSETS_DIR, font.name)))) return false;
  return true;
}

async function ensureQuoteAssets(): Promise<void> {
  const quoteDir = path.join(quotePluginDir(), "quote");
  const versionFile = path.join(quoteDir, ".version");
  let currentVersion = "";
  try { currentVersion = fs.readFileSync(versionFile, "utf8").trim(); } catch (_) {}

  if (currentVersion !== QUOTE_PLUGIN_VERSION) {
    const missingVendor = QUOTE_DEP_FILES.filter((rel) => !fs.existsSync(path.join(quoteDir, rel)));
    if (missingVendor.length > 0) {
      console.warn("quote loader installing missing vendor", { from: currentVersion || undefined, to: QUOTE_PLUGIN_VERSION, count: missingVendor.length });
      for (const rel of missingVendor) {
        await downloadFileIfMissingOrChanged(`${QUOTE_BASE_URL}/${rel}`, path.join(quoteDir, rel));
      }
    }
    fs.mkdirSync(quoteDir, { recursive: true });
    fs.writeFileSync(versionFile, QUOTE_PLUGIN_VERSION);
  }

  for (const rel of QUOTE_ASSET_FILES) {
    const filePath = path.join(QUOTE_ASSETS_DIR, rel);
    if (!fs.existsSync(filePath)) {
      console.warn("quote loader downloading asset", { rel });
      await downloadFileIfMissingOrChanged(`${QUOTE_ASSETS_BASE_URL}/${rel}`, filePath);
    }
  }

  for (const font of QUOTE_FONT_FILES) {
    const filePath = path.join(QUOTE_ASSETS_DIR, font.name);
    if (!fs.existsSync(filePath)) {
      console.warn("quote loader downloading CJK font", { name: font.name });
      await downloadFileIfMissingOrChanged(font.url, filePath);
    }
  }
}

async function getQuoteGen(): Promise<any> {
  if (!quoteGenPromise) {
    quoteGenPromise = (async () => {
      await ensureQuoteAssets();
      requireOrInstall("canvas");
      requireOrInstall("sharp");
      // vendor/ pulls these in at module load (quote-generate/index.js requires
      // telegraf; avatar.js requires lru-cache + runes; media.js requires jimp +
      // smartcrop-sharp; emoji-db.js requires emoji-db). They are not declared in
      // the host package.json, so install on demand or generate.js fails to load.
      for (const dep of QUOTE_VENDOR_NPM_DEPS) requireOrInstall(dep);
      return require("./quote/generate");
    })();
  }
  return quoteGenPromise;
}

function quoteMs(start: number): number {
  return Date.now() - start;
}

function quoteTiming(label: string, start: number, extra?: Record<string, any>): void {
  console.warn("quote timing", label, `${quoteMs(start)}ms`, extra || "");
}

// Timeout budgets (ms) for MTProto RPCs inside the quote pipeline. Telegram RPCs
// have NO inherent timeout: when the MTProto connection drops/reconnects (which
// happens regularly), an in-flight RPC promise neither resolves nor rejects — it
// sits in the pending-resend queue forever. A bare `.catch()` cannot rescue an
// unsettled promise, so the whole command hangs silently with no error and the
// bot appears unresponsive. We race every RPC against a timer so a stuck call
// rejects, hits the handler's try/catch, and surfaces an error to the user.
const QUOTE_RPC_TIMEOUT_MS = 20000; // per individual RPC (getMessages / edit / reply / delete)
const QUOTE_TOTAL_TIMEOUT_MS = 90000; // hard ceiling for the entire command

class QuoteTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`quote operation "${label}" timed out after ${ms}ms (likely a stalled Telegram RPC during a connection drop)`);
    this.name = "QuoteTimeoutError";
  }
}

/**
 * Race a promise against a timeout. On timeout the returned promise REJECTS with
 * QuoteTimeoutError (so the caller's try/catch can report it) and the timer is
 * always cleared to avoid leaks. The underlying RPC is abandoned, not cancelled —
 * gramjs has no cancel — but it no longer blocks the command from completing.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QuoteTimeoutError(label, ms)), ms);
    // Don't keep the event loop alive solely for this timer.
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

type QuoteArgs = {
  count: number;
  reply: boolean;
  png: boolean;
  img: boolean;
  rate: boolean;
  hidden: boolean;
  media: boolean;
  crop: boolean;
  stories: boolean;
  scale: number;
  color?: string;
  backgroundColor: string;
  emojiBrand: string;
  emojiSuffix: string;
};

type QuoteUser = {
  id: number;
  name: string | false;
  first_name: string | false;
  photo: Record<string, never>;
  emoji_status?: any;
};

function generateRandomColor(): string {
  return `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
}

function getCommandArgsText(msg: Api.Message, command: string): string {
  const raw = ((msg as any).message || (msg as any).text || "") as string;
  const prefix = getPrefixes().find((p) => raw.startsWith(p)) || raw[0] || "";
  const rest = raw.slice(prefix.length).trimStart();
  if (!rest) return "";
  const first = rest.split(/\s+/, 1)[0] || "";
  const normalized = first.replace(/@\w+$/i, "");
  if (normalized.toLowerCase() !== command.toLowerCase()) return rest;
  return rest.slice(first.length).trimStart();
}

const QUOTE_EMOJI_BRANDS = new Set(["apple", "google", "twitter", "joypixels", "blob"]);

function isColorToken(arg: string): boolean {
  if (!arg) return false;
  const lower = arg.toLowerCase();
  if (lower === "random") return true;
  // #rgb / #rrggbb / gradient #aaa/#bbb / //semi
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})(\/#([0-9a-f]{3}|[0-9a-f]{6}))?$/i.test(arg)) return true;
  if (/^\/\/#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(arg)) return true;
  // bare hex without #
  if (/^([0-9a-f]{3}|[0-9a-f]{6})(\/([0-9a-f]{3}|[0-9a-f]{6}))?$/i.test(arg)) return true;
  return false;
}

function normalizeColorToken(arg: string): string {
  const lower = arg.toLowerCase();
  if (lower === "random") return generateRandomColor();
  if (arg.startsWith("//")) return arg;
  if (arg.startsWith("#")) return arg;
  // bare hex → add #
  if (/^[0-9a-f]{3,6}(\/[0-9a-f]{3,6})?$/i.test(arg)) {
    return arg.split("/").map((p) => (p.startsWith("#") ? p : `#${p}`)).join("/");
  }
  return arg;
}

function parseArgs(text: string): QuoteArgs {
  const args = text.trim().split(/\s+/).filter(Boolean);
  const out: QuoteArgs = {
    count: 1,
    reply: false,
    png: false,
    img: false,
    rate: false,
    hidden: false,
    media: false,
    crop: false,
    stories: false,
    scale: 2,
    backgroundColor: DEFAULT_BACKGROUND,
    emojiBrand: DEFAULT_EMOJI_BRAND,
    emojiSuffix: QUOTE_EMOJIS,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const lower = arg.toLowerCase();

    if (lower === "r" || lower === "reply") {
      out.reply = true;
      continue;
    }
    if (lower === "png" || lower === "image" || lower === "img") {
      out.png = true;
      out.img = true;
      continue;
    }
    if (lower === "stories" || lower === "story") {
      out.stories = true;
      continue;
    }
    if (lower === "webp" || lower === "quote") {
      // explicit default sticker mode
      out.png = false;
      out.stories = false;
      continue;
    }
    if (lower === "hidden" || lower === "hide" || lower === "anonymous") {
      out.hidden = true;
      continue;
    }
    if (lower === "media" || lower === "m") {
      out.media = true;
      continue;
    }
    if (lower === "crop") {
      out.crop = true;
      continue;
    }
    if (lower === "rate" || lower === "rating") {
      out.rate = true;
      continue;
    }

    // scale=2 / scale:2 / s=2
    const scaleEq = lower.match(/^(?:scale|s)[=:](\d+(?:\.\d+)?)$/);
    if (scaleEq) {
      const s = Number(scaleEq[1]);
      if (Number.isFinite(s) && s > 0) out.scale = Math.min(20, Math.max(1, s));
      continue;
    }
    if (lower === "scale" || lower === "s") {
      const next = args[i + 1];
      const s = next ? Number(next) : NaN;
      if (Number.isFinite(s) && s > 0) {
        out.scale = Math.min(20, Math.max(1, s));
        i++;
      }
      continue;
    }

    // bg=#xxx / color=#xxx / background=#xxx
    const colorEq = lower.match(/^(?:bg|color|background)[=:](.+)$/i);
    if (colorEq) {
      out.backgroundColor = normalizeColorToken(colorEq[1]);
      out.color = out.backgroundColor;
      continue;
    }
    if (lower === "bg" || lower === "color" || lower === "background") {
      const next = args[i + 1];
      if (next && isColorToken(next)) {
        out.backgroundColor = normalizeColorToken(next);
        out.color = out.backgroundColor;
        i++;
      }
      continue;
    }
    if (isColorToken(arg)) {
      out.backgroundColor = normalizeColorToken(arg);
      out.color = out.backgroundColor;
      continue;
    }

    // emoji brand
    if (QUOTE_EMOJI_BRANDS.has(lower)) {
      out.emojiBrand = lower;
      continue;
    }
    const brandEq = lower.match(/^(?:emoji|brand)[=:]([a-z]+)$/);
    if (brandEq && QUOTE_EMOJI_BRANDS.has(brandEq[1])) {
      out.emojiBrand = brandEq[1];
      continue;
    }

    const n = Number.parseInt(arg, 10);
    if (!Number.isNaN(n) && /^[-+]?\d+$/.test(arg)) {
      out.count = Math.max(-MAX_QUOTE_MESSAGES, Math.min(MAX_QUOTE_MESSAGES, n));
      continue;
    }
  }

  out.emojiSuffix = `${QUOTE_EMOJIS}${EMOJI_SUFFIXES[Math.floor(Math.random() * EMOJI_SUFFIXES.length)]}💜`;
  return out;
}

function wantsQuoteHelp(argsText: string): boolean {
  const t = argsText.trim().toLowerCase();
  if (!t) return false;
  return /^(help|\?|h|帮助)$/i.test(t) || /(?:^|\s)(help|\?|帮助)(?:\s|$)/i.test(t);
}

function foldSection(title: string, body: string): string {
  // 标签与正文之间禁止换行：<blockquote expandable>内容</blockquote>
  return `${title}\n<blockquote expandable>${body}</blockquote>`;
}

function buildQuoteHelpText(): string {
  const prefixes = getPrefixes();
  const mainPrefix = prefixes[0] || ".";
  const cmd = `${mainPrefix}q`;
  const cmdFull = `${mainPrefix}quote`;
  // 完整 helptext 单段进 description；标题外露，板块正文用可折叠 blockquote
  // （.help quote 会整段显示在「功能描述」，不再依赖 help 壳的短「使用方法」）
  return [
    `本地 glass 渲染：语音/文件/音频行、视频/GIF 角标、转发标签、管理员头衔`,
    ``,
    foldSection(
      `- 基础用法`,
      [
        `使用 <code>${cmd}</code> 或 <code>${cmdFull}</code> 回复一条消息生成语录贴纸`,
        `使用 <code>${cmd} [消息数]</code> 连续引用多条（最多 ${MAX_QUOTE_MESSAGES}）`,
        `使用 <code>${cmd} r</code> / <code>${cmd} reply</code> 在气泡内显示被回复内容`,
      ].join("\n"),
    ),
    ``,
    foldSection(
      `- 输出格式（默认 webp 贴纸）`,
      [
        `使用 <code>${cmd} webp</code> - 静态 WebP 贴纸（默认）`,
        `使用 <code>${cmd} image</code> / <code>${cmd} png</code> - 背景大图 (PNG)`,
        `使用 <code>${cmd} stories</code> - 故事模式 (720×1280 PNG)`,
      ].join("\n"),
    ),
    ``,
    foldSection(
      `- 显示选项`,
      [
        `使用 <code>${cmd} hidden</code> - 隐藏头像与昵称`,
        `使用 <code>${cmd} media</code> - 强制附带媒体预览`,
        `使用 <code>${cmd} crop</code> - 媒体按比例裁剪`,
      ].join("\n"),
    ),
    ``,
    foldSection(
      `- 样式`,
      [
        `使用 <code>${cmd} #1b1429</code> 或 <code>${cmd} #111/#222</code> - 背景色 / 渐变`,
        `使用 <code>${cmd} bg random</code> - 随机背景色`,
        `使用 <code>${cmd} scale 2</code> - 缩放 1–20（默认 2）`,
        `使用 <code>${cmd} apple</code> / <code>google</code> / <code>twitter</code> / <code>joypixels</code> / <code>blob</code> - Emoji 风格`,
      ].join("\n"),
    ),
    ``,
    foldSection(
      `- 组合示例`,
      [
        `<code>${cmd} r 3</code>`,
        `<code>${cmd} stories #231d2b/#372e44</code>`,
        `<code>${cmd} image r hidden scale 3</code>`,
        `<code>${cmd} help</code> - 显示本帮助`,
      ].join("\n"),
    ),
  ].join("\n");
}

function asBigInt(value: any): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  try { return BigInt(value.value ?? value); } catch (_) { return undefined; }
}

function idNumber(value: any): number {
  const raw = value?.value ?? value;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "number") return raw;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function peerIdNumber(peer: any): number {
  if (!peer) return 0;
  return idNumber(peer.userId ?? peer.chatId ?? peer.channelId ?? peer.id ?? peer);
}

function senderIdNumber(msg: Api.Message): number {
  return idNumber((msg as any).senderId ?? (msg as any).fromId ?? (msg as any).peerId);
}

function isApiMessage(value: any): value is Api.Message {
  return !!value && typeof value === "object" && typeof value.id === "number" && (
    value.className === "Message" ||
    value._ === "message" ||
    "message" in value ||
    "media" in value ||
    "peerId" in value ||
    "fromId" in value ||
    "senderId" in value
  );
}

function quoteSenderKey(message: any): string {
  if (!message) return "";
  const fromId = message.from?.id ?? message.chatId ?? message.senderId ?? message.fromId ?? message.peerId;
  const n = peerIdNumber(fromId);
  return n ? String(n) : "";
}

function emojiStatusPayload(entity: any, customEmojiBuffer?: Buffer): any | undefined {
  const id = emojiStatusIdFromEntity(entity);
  if (!id) return undefined;
  // Always string ID for vendor map lookups
  return { custom_emoji_id: String(id), ...(customEmojiBuffer ? { customEmojiBuffer } : {}) };
}

function displayName(entity: any): string {
  if (!entity) return "User";
  const first = entity.firstName || entity.first_name || "";
  const last = entity.lastName || entity.last_name || "";
  const title = entity.title || "";
  const username = entity.username ? `@${entity.username}` : "";
  return [first, last].filter(Boolean).join(" ") || title || username || "User";
}

function fwdHeaderName(fwd: any): string | undefined {
  return fwd?.fromName || fwd?.from_name || fwd?.postAuthor || fwd?.post_author || undefined;
}

function fwdPeer(fwd: any): any | undefined {
  return fwd?.fromId ?? fwd?.from_id ?? fwd?.savedFromPeer ?? fwd?.saved_from_peer;
}

async function forwardedSource(msg: Api.Message): Promise<{ peer?: any; entity?: any; name?: string; anonymous: boolean } | undefined> {
  const fwd: any = (msg as any).fwdFrom || (msg as any).fwd_from;
  if (!fwd) return undefined;

  const client: any = (msg as any).client;
  const peer = fwdPeer(fwd);
  const headerName = fwdHeaderName(fwd);

  if (peer) {
    const rawEntity = await getPeerEntity(client, peer);
    const entity = await ensureFullEntity(client, rawEntity);
    return { peer, entity, name: displayName(entity) || headerName || "Forwarded", anonymous: !entity && !!headerName };
  }

  if (headerName) return { name: headerName, anonymous: true };
  return { anonymous: true };
}

function stableEntityKey(entity: any): string | undefined {
  const raw = entity?.id ?? entity?.userId ?? entity?.channelId ?? entity?.chatId ?? entity?.accessHash ?? entity;
  if (!raw) return undefined;
  try { return typeof raw === "bigint" ? raw.toString() : JSON.stringify(raw, (_, v) => typeof v === "bigint" ? v.toString() : v); } catch (_) { return String(raw); }
}

async function getPeerEntity(client: any, peer: any): Promise<any | undefined> {
  if (!client || !peer) return undefined;
  const key = JSON.stringify(peer, (_, v) => typeof v === "bigint" ? v.toString() : v);
  if (entityCache.has(key)) return entityCache.get(key);
  try {
    const entity = await withTimeout(client.getEntity(peer), QUOTE_RPC_TIMEOUT_MS, "getPeerEntity.getEntity");
    entityCache.set(key, entity);
    return entity;
  } catch (_) {
    entityCache.set(key, undefined);
    return undefined;
  }
}

async function ensureFullEntity(client: any, entity: any): Promise<any> {
  if (!entity || !client) return entity;
  if (entity.id && entity.emojiStatus === undefined && entity.emoji_status === undefined) {
    try {
      const full = await withTimeout(client.getEntity(entity), QUOTE_RPC_TIMEOUT_MS, "ensureFullEntity");
      return full || entity;
    } catch { return entity; }
  }
  return entity;
}

async function senderEntity(msg: Api.Message): Promise<any | undefined> {
  const peer = (msg as any).senderId ?? (msg as any).fromId;
  const key = peer ? `sender:${stableEntityKey(peer)}` : undefined;
  if (key && entityCache.has(key)) return entityCache.get(key);
  try {
    const sender = await withTimeout((msg as any).getSender?.(), QUOTE_RPC_TIMEOUT_MS, "senderEntity.getSender");
    if (sender) {
      if (key) entityCache.set(key, sender);
      return sender;
    }
  } catch (_) {}
  const entity = await getPeerEntity((msg as any).client, peer);
  if (key) entityCache.set(key, entity);
  return entity;
}

async function senderName(msg: Api.Message): Promise<string> {
  return displayName(await senderEntity(msg));
}

function emojiStatusIdFromEntity(entity: any): string | undefined {
  const status = entity?.emojiStatus ?? entity?.emoji_status;
  if (!status) return undefined;
  // If status is a primitive (bigint, number, string), treat it as the direct document ID
  if (typeof status !== "object") {
    const id = status?.value ?? status;
    return id ? String(id) : undefined;
  }
  const documentId = status.documentId ?? status.document_id ?? status.customEmojiId ?? status.custom_emoji_id ?? status.id;
  if (!documentId) return undefined;
  return String(documentId);
}

function messageDate(msg: Api.Message): number | undefined {
  const date = (msg as any).date;
  if (date instanceof Date) return Math.floor(date.getTime() / 1000);
  if (typeof date === "number") return date;
  return undefined;
}

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

function mediaFallbackText(msg: Api.Message): string {
  const kind = getMediaKind(msg);
  if (!kind) return "";
  const map: Record<string, string> = {
    photo: "[照片]", video: "[视频]", round: "[圆形视频]", animation: "[动画]",
    sticker: "[贴纸]", voice: "[语音]", audio: "[音频]", document: "[文件]",
    location: "[位置]", venue: "[地点]", contact: "[联系人]", poll: "[投票]", media: "[媒体]"
  };
  return map[kind] || "[媒体]";
}

function hasPreviewMedia(msg: Api.Message): boolean {
  const kind = getMediaKind(msg);
  return kind === "photo" || kind === "sticker" || kind === "animation" || kind === "document";
}

function messageText(msg: Api.Message): string {
  const text = (msg as any).message || "";
  if (typeof text === "string" && text.trim()) return text;
  const kind = getMediaKind(msg);
  if (kind === "photo" || kind === "sticker" || kind === "animation" || kind === "document") return "";
  return mediaFallbackText(msg);
}

function convertEntities(msg: Api.Message): any[] {
  // Telegram puts formatting entities on the message body. For media messages
  // the caption IS the body, so the entities already live in msg.entities.
  // Some layers use a separate caption_entities field — merge both.
  const msgEntities = ((msg as any).entities || []) as any[];
  const capEntities = ((msg as any).captionEntities || (msg as any).caption_entities || []) as any[];
  const all = Array.isArray(msgEntities) && Array.isArray(capEntities) ? [...msgEntities, ...capEntities] : msgEntities;
  return all.map((e) => {
    const name = e.className || e.constructor?.name || "";
    const offset = e.offset ?? 0;
    const length = e.length ?? 0;
    if (name.includes("Bold")) return { type: "bold", offset, length };
    if (name.includes("Italic")) return { type: "italic", offset, length };
    if (name.includes("Underline")) return { type: "underline", offset, length };
    if (name.includes("Strike")) return { type: "strikethrough", offset, length };
    if (name.includes("Blockquote")) return { type: "blockquote", offset, length };
    if (name.includes("Spoiler")) return { type: "spoiler", offset, length };
    if (name.includes("Code")) return { type: "code", offset, length };
    if (name.includes("Pre")) return { type: "pre", offset, length, language: e.language };
    if (name.includes("TextUrl")) return { type: "text_link", offset, length, url: e.url };
    if (name.includes("MentionName")) return { type: "text_mention", offset, length, user: e.userId };
    if (name.includes("Mention")) return { type: "mention", offset, length };
    if (name.includes("Hashtag")) return { type: "hashtag", offset, length };
    if (name.includes("Cashtag")) return { type: "cashtag", offset, length };
    if (name.includes("BotCommand")) return { type: "bot_command", offset, length };
    if (name.includes("Url")) return { type: "url", offset, length };
    if (name.includes("Email")) return { type: "email", offset, length };
    if (name.includes("Phone")) return { type: "phone_number", offset, length };
    if (name.includes("CustomEmoji")) return { type: "custom_emoji", offset, length, custom_emoji_id: String(e.documentId ?? e.document_id ?? "") };
    return { type: "text", offset, length };
  }).filter((e) => e.length > 0 && e.type !== "text");
}

async function normalizeAvatarBuffer(buffer: Buffer): Promise<Buffer | undefined> {
  if (!buffer || buffer.length === 0) return undefined;
  try {
    const meta = await (await getSharp())(buffer).metadata();
    if (!meta.width || !meta.height) return undefined;
    const side = Math.min(meta.width, meta.height);
    const left = Math.max(0, Math.floor(((meta.width || side) - side) / 2));
    const top = Math.max(0, Math.floor(((meta.height || side) - side) / 2));
    return await (await getSharp())(buffer)
      .extract({ left, top, width: side, height: side })
      .resize(256, 256, { fit: "cover", position: "centre" })
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .png()
      .toBuffer();
  } catch (err: any) {
    console.warn("quote avatar normalize failed", err?.message || err);
    return buffer.length > 0 ? buffer : undefined;
  }
}

async function downloadEntityAvatar(client: any, entity: any): Promise<Buffer | undefined> {
  if (!client || !entity) return undefined;
  const key = stableEntityKey(entity);
  if (key && avatarCache.has(key)) return avatarCache.get(key);

  // Resolve a full entity with photo + accessHash. getSender() may return a
  // min entity (no accessHash), and downloadProfilePhoto internally calls
  // getInputPeer(entity) which throws for min entities.
  let fullEntity = entity;
  try {
    if (!(entity.accessHash !== undefined && !entity.min) && entity.id) {
      fullEntity = await withTimeout(client.getEntity(entity), QUOTE_RPC_TIMEOUT_MS, "downloadEntityAvatar.getEntity");
    }
  } catch (e: any) {
    console.warn("quote avatar getEntity failed, using raw entity", e?.message || e);
  }

  const photo = fullEntity?.photo;
  if (!photo || photo instanceof Api.UserProfilePhotoEmpty || photo instanceof Api.ChatPhotoEmpty) {
    if (key) avatarCache.set(key, undefined);
    return undefined;
  }

  const tryDownload = async (isBig: boolean): Promise<Buffer | undefined> => {
    try {
      // Bypass the MediaScheduler (which retries 5×15s = 75s on failure) by
      // using raw upload.GetFile via client.invoke with the photo's DC.
      // This gives us a single attempt that our withTimeout can actually cap.
      const inputPeer = utils.getInputPeer(fullEntity);
      const location = new Api.InputPeerPhotoFileLocation({
        peer: inputPeer,
        photoId: photo.photoId,
        big: isBig,
      });
      const dcId = photo.dcId;
      const result = await withTimeout(
        client.invoke(
          new Api.upload.GetFile({
            location,
            offset: big_integer.zero,
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
      console.warn(`quote avatar ${isBig ? "big" : "small"} download failed`, err?.message || err);
      return undefined;
    }
  };

  const [small, big] = await Promise.all([tryDownload(false), tryDownload(true)]);
  const normalized = small ? await normalizeAvatarBuffer(small) : big ? await normalizeAvatarBuffer(big) : undefined;
  if (key) avatarCache.set(key, normalized);
  return normalized;
}

async function downloadSenderAvatar(msg: Api.Message, entity?: any): Promise<Buffer | undefined> {
  const client = (msg as any).client ?? await getGlobalClient().catch(() => undefined);
  return downloadEntityAvatar(client, entity ?? await senderEntity(msg));
}

/**
 * Download a file via raw upload.GetFile, bypassing the MediaScheduler.
 * The MediaScheduler retries 5×15s (75s total) on failure, which blocks
 * the quote pipeline for the entire duration. This helper does a single
 * attempt that our withTimeout can cap at QUOTE_RPC_TIMEOUT_MS.
 * For small files (avatars, emoji) one chunk of 512KB is enough.
 */
async function rawDownloadFile(client: any, location: any, dcId: number | undefined): Promise<Buffer | undefined> {
  if (!client || !location) return undefined;
  try {
    const result = await withTimeout(
      client.invoke(
        new Api.upload.GetFile({
          location,
          offset: big_integer.zero,
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
    console.warn("quote rawDownloadFile failed", err?.message || err);
    return undefined;
  }
}

/**
 * Download a Document (e.g. custom emoji) via raw upload.GetFile,
 * bypassing the MediaScheduler's 75s retry loop.
 */
async function rawDownloadDocument(client: any, doc: any): Promise<Buffer | undefined> {
  if (!client || !doc) return undefined;
  const location = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: "",
  });
  return rawDownloadFile(client, location, doc.dcId);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStableFile(filePath: string, timeoutMs = 8000): Promise<Buffer | undefined> {
  const start = Date.now();
  let lastSize = -1;
  let stable = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.existsSync(filePath)) {
        const size = fs.statSync(filePath).size;
        if (size > 0 && size === lastSize) {
          stable += 1;
          if (stable >= 2) return fs.readFileSync(filePath);
        } else {
          stable = 0;
          lastSize = size;
        }
      }
    } catch (_) {}
    await sleepMs(120);
  }
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return fs.readFileSync(filePath);
  } catch (_) {}
  return undefined;
}

async function downloadMediaToBuffer(client: any, target: any): Promise<Buffer | undefined> {
  if (!client || !target) return undefined;
  const mediaPath = path.join(os.tmpdir(), `telebox_quote_media_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  try {
    const downloaded = await withTimeout(client.downloadMedia(target, { outputFile: mediaPath }), QUOTE_RPC_TIMEOUT_MS, "downloadMediaToBuffer.downloadMedia");
    let buffer: Buffer | undefined;
    if (Buffer.isBuffer(downloaded)) buffer = downloaded;
    else if (downloaded && typeof downloaded === "string" && fs.existsSync(downloaded)) buffer = await waitForStableFile(downloaded);
    if (!buffer || buffer.length === 0) buffer = await waitForStableFile(mediaPath);
    return buffer && buffer.length > 0 ? buffer : undefined;
  } catch (err: any) {
    console.warn("quote media download failed", err?.message || err);
    return undefined;
  } finally {
    try { if (fs.existsSync(mediaPath)) fs.unlinkSync(mediaPath); } catch (_) {}
  }
}

async function downloadMessageMedia(msg: Api.Message, enabled: boolean): Promise<Buffer | undefined> {
  if (!enabled || !(msg as any).media) return undefined;
  const client = (msg as any).client ?? await getGlobalClient().catch(() => undefined);
  if (!client) return undefined;
  return downloadMediaToBuffer(client, msg);
}

async function mediaBufferToCanvas(buffer: Buffer | undefined, kind: string | undefined): Promise<any | undefined> {
  if (!buffer || buffer.length === 0) return undefined;
  try {
    let imageBuffer = buffer;
    const isVideoLike = kind === "animation" || kind === "video" || kind === "round" || looksLikeAnimatedEmoji(buffer);
    if (isVideoLike) {
      const converted = await convertAnimatedEmojiToPng(buffer);
      if (converted) imageBuffer = converted;
    } else if (kind === "sticker") {
      imageBuffer = await (await getSharp())(buffer, { animated: false }).ensureAlpha().png({ force: true }).toBuffer();
    }
    const { createCanvas, loadImage } = await getCanvas();
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    return canvas;
  } catch (err: any) {
    console.warn("quote media canvas failed", kind, err?.message || err);
    return undefined;
  }
}

async function prepareQuoteMedia(msg: Api.Message, args: QuoteArgs): Promise<{
  mediaBuffer?: Buffer;
  mediaCanvas?: any;
  mediaType?: string;
  mediaMaxSize?: number;
  mediaCrop?: boolean;
  mediaDuration?: number;
  voice?: { waveform: number[]; duration?: number };
  /** quote-api attachments.js: file_name / file_size */
  document?: { file_name: string; file_size?: number };
  /** quote-api attachments.js: title / performer / duration / thumb */
  audio?: { title?: string; performer?: string; duration?: number; thumb?: any };
}> {
  const kind = getMediaKind(msg);
  const waveform = kind === "voice" ? voiceWaveform(msg) : undefined;
  const voiceAttr = audioAttribute(msg);
  const duration = Number(voiceAttr?.duration ?? voiceAttr?.voiceDuration ?? 0) || undefined;
  const videoAttr = getDocumentAttributes(msg).find((a: any) =>
    (a.className || a.constructor?.name || "").includes("Video")
  );
  const mediaDuration =
    kind === "video" || kind === "animation" || kind === "round"
      ? Number(videoAttr?.duration ?? 0) || undefined
      : kind === "voice" || kind === "audio"
        ? duration
        : undefined;

  // Glass: voice/document/audio → in-bubble rows; photo/sticker/video/gif → mediaCanvas + badges
  const wantsVisual =
    args.media ||
    args.img ||
    kind === "photo" ||
    kind === "sticker" ||
    kind === "animation" ||
    kind === "video" ||
    kind === "round";
  const mediaBuffer = await downloadMessageMedia(msg, !!wantsVisual);
  const mediaCanvas = await mediaBufferToCanvas(mediaBuffer, kind);
  const isSticker = kind === "sticker";

  let document: { file_name: string; file_size?: number } | undefined;
  let audio: { title?: string; performer?: string; duration?: number; thumb?: any } | undefined;
  if (kind === "document") {
    const doc = (msg as any).document ?? (msg as any).media?.document;
    const attrs = Array.isArray(doc?.attributes) ? doc.attributes : getDocumentAttributes(msg);
    const fn = attrs.find(
      (a: any) =>
        (a.className || a.constructor?.name || "").includes("Filename") ||
        a.fileName ||
        a.file_name,
    );
    const name = String(fn?.fileName || fn?.file_name || "file");
    document = {
      file_name: name,
      file_size: Number(doc?.size ?? 0) || undefined,
    };
  } else if (kind === "audio") {
    const title = voiceAttr?.title || voiceAttr?.fileName || voiceAttr?.file_name || "Audio";
    const performer = voiceAttr?.performer || voiceAttr?.artist;
    audio = { title, performer, duration };
  }

  // Normalize mediaType for vendor badges (video play / GIF chip)
  let mediaType = mediaCanvas ? (kind || "photo") : kind;
  if (mediaType === "animation") mediaType = "gif";
  if (mediaType === "round") mediaType = "video";

  return {
    mediaBuffer,
    mediaCanvas,
    mediaType,
    mediaMaxSize: isSticker ? 220 * (args.scale || 2) : undefined,
    mediaCrop: isSticker ? false : args.crop,
    mediaDuration,
    voice: waveform ? { waveform, duration } : undefined,
    document,
    audio,
  };
}


function execFileAsync(cmd: string, args: string[], timeout = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err: any) => err ? reject(err) : resolve());
  });
}

type AnimatedFrameSet = { frames: Buffer[]; fps: number; duration: number; cacheKey?: string };

function parseFps(value: string | undefined, fallback = 12): number {
  if (!value) return fallback;
  const raw = value.trim();
  if (!raw) return fallback;
  if (raw.includes("/")) {
    const [a, b] = raw.split("/").map(Number);
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return a / b;
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function execFileCaptureAsync(cmd: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err: any, stdout: string, stderr: string) => err ? reject(err) : resolve(stdout || stderr || ""));
  });
}


async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function probeAnimatedInfo(buffer: Buffer): Promise<{ fps: number; duration: number }> {
  const tmpBase = path.join(os.tmpdir(), `telebox_quote_probe_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const input = `${tmpBase}.bin`;
  try {
    fs.writeFileSync(input, buffer);
    const out = await execFileCaptureAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=avg_frame_rate,r_frame_rate,duration:format=duration",
      "-of", "default=noprint_wrappers=1:nokey=0",
      input,
    ], 10000);
    const data = new Map<string, string>();
    out.split(/\r?\n/).forEach((line) => {
      const idx = line.indexOf("=");
      if (idx > 0) data.set(line.slice(0, idx), line.slice(idx + 1));
    });
    const fps = Math.max(1, Math.min(60, parseFps(data.get("avg_frame_rate"), parseFps(data.get("r_frame_rate"), 12))));
    const durationRaw = Number(data.get("duration") || data.get("TAG:DURATION") || data.get("format.duration"));
    const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 2;
    return { fps, duration };
  } catch (err: any) {
    console.warn("quote animated probe failed", err?.message || err);
    return { fps: 12, duration: 2 };
  } finally {
    try { if (fs.existsSync(input)) fs.unlinkSync(input); } catch (_) {}
  }
}

function looksLikeAnimatedEmoji(buffer: Buffer | undefined): boolean {
  if (!buffer || buffer.length < 16) return false;
  const head = buffer.subarray(0, 64).toString("utf8");
  if (isAnimatedRasterBuffer(buffer)) return true;
  if (head.includes("WEBM")) return true;
  if (head.trimStart().startsWith("{\"v\"") || head.includes("\"layers\"")) return true;
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return true; // .tgs gzip/lottie
  return false;
}

async function convertAnimatedEmojiToPng(buffer: Buffer): Promise<Buffer | undefined> {
  const tmpBase = path.join(os.tmpdir(), `telebox_quote_emoji_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const input = `${tmpBase}.bin`;
  const output = `${tmpBase}.png`;
  try {
    fs.writeFileSync(input, buffer);
    // ffmpeg handles webm/video stickers. It may not handle tgs/lottie; those will fall back below.
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-c:v", "libvpx-vp9",
      "-i", input,
      "-frames:v", "1",
      "-vf", "scale=128:128:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba",
      "-f", "image2", output
    ], 12000);
    if (fs.existsSync(output)) {
      const png = fs.readFileSync(output);
      if (png.length > 0) {
        return await (await getSharp())(png, { animated: false }).ensureAlpha().png({ force: true }).toBuffer();
      }
    }
  } catch (_) {
    // keep fallback quiet; normal static buffers and unsupported tgs land here
  } finally {
    try { if (fs.existsSync(input)) fs.unlinkSync(input); } catch (_) {}
    try { if (fs.existsSync(output)) fs.unlinkSync(output); } catch (_) {}
  }

  try {
    // Some animated emoji downloads are tgs/lottie. Sharp cannot render lottie,
    // but if Telegram provided a raster thumbnail this path is not used.
    return await (await getSharp())(buffer, { animated: false }).resize(128, 128, { fit: "inside" }).png({ force: true }).toBuffer();
  } catch (_) {
    return undefined;
  }
}


async function extractAnimatedFrames(buffer: Buffer, size: number, frameCount: number, fps: number): Promise<Buffer[]> {
  const tmpBase = path.join(os.tmpdir(), `telebox_quote_anim_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const input = `${tmpBase}.bin`;
  const dir = `${tmpBase}_frames`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(input, buffer);
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-stream_loop", "-1",
      "-i", input,
      "-vf", `fps=${fps},scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba`,
      "-frames:v", String(frameCount),
      path.join(dir, "frame_%03d.png"),
    ], 20000);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
    return files.map((f) => fs.readFileSync(path.join(dir, f))).filter((b) => b.length > 0);
  } catch (err: any) {
    console.warn("quote animated frame extract failed", err?.message || err);
    return [];
  } finally {
    try { if (fs.existsSync(input)) fs.unlinkSync(input); } catch (_) {}
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function bufferToCanvas(buffer: Buffer): Promise<any | undefined> {
  try {
    const { createCanvas, loadImage } = await getCanvas();
    const img = await loadImage(buffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    return canvas;
  } catch (_) {
    return undefined;
  }
}

function collectAnimatedEmojiIds(messages: any[]): string[] {
  const ids = new Set<string>();
  const scanEntity = (entity: any) => {
    const id = entity?.custom_emoji_id;
    if (id && animatedCustomEmojiCache.get(String(id))) ids.add(String(id));
  };
  const scanMessage = (message: any) => {
    if (!message) return;
    (message.entities || []).forEach(scanEntity);
    (message.caption_entities || []).forEach(scanEntity);
    // Do not let sender emoji_status alone turn a pure-text quote into animated WebM.
    // It is already rendered from customEmojiCache as a static first frame.
    if (message.replyMessage) scanMessage(message.replyMessage);
    if (message.forward) scanMessage(message.forward);
  };
  messages.forEach(scanMessage);
  return Array.from(ids);
}

function applyCustomEmojiFrame(messages: any[], id: string, frame: Buffer): void {
  const applyEntity = (entity: any) => {
    if (String(entity?.custom_emoji_id || "") === id) entity.customEmojiBuffer = frame;
  };
  const scanMessage = (message: any) => {
    if (!message) return;
    (message.entities || []).forEach(applyEntity);
    (message.caption_entities || []).forEach(applyEntity);
    const statusId = message.from?.emoji_status?.custom_emoji_id || message.from?.emoji_status?.customEmojiId || message.emoji_status?.custom_emoji_id || message.emoji_status?.customEmojiId;
    if (String(statusId || "") === id) {
      if (message.from?.emoji_status) message.from.emoji_status.customEmojiBuffer = frame;
      if (message.emoji_status) message.emoji_status.customEmojiBuffer = frame;
    }
    if (message.replyMessage) scanMessage(message.replyMessage);
    if (message.forward) scanMessage(message.forward);
  };
  messages.forEach(scanMessage);
}

function isWebmBuffer(buffer: Buffer | undefined): boolean {
  return !!buffer && buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

function isGifBuffer(buffer: Buffer | undefined): boolean {
  return !!buffer && buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a");
}

function isAnimatedRasterBuffer(buffer: Buffer | undefined): boolean {
  return isWebmBuffer(buffer) || isGifBuffer(buffer);
}

function bufferKind(buffer: Buffer | undefined): string {
  if (!buffer) return "none";
  if (isGifBuffer(buffer)) return "gif";
  if (isWebmBuffer(buffer)) return "webm";
  if (buffer.length >= 8 && buffer.subarray(1, 4).toString("ascii") === "PNG") return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return "gzip/tgs";
  return `other:${buffer.subarray(0, 8).toString("hex")}`;
}

async function probeWebmAlpha(buffer: Buffer): Promise<string> {
  const tmpBase = path.join(os.tmpdir(), `telebox_quote_alpha_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const input = `${tmpBase}.webm`;
  try {
    fs.writeFileSync(input, buffer);
    const out = await execFileCaptureAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=pix_fmt,width,height,duration:stream_tags=alpha_mode:format=duration",
      "-of", "default=noprint_wrappers=1",
      input,
    ], 10000);
    return out.trim().replace(/\s+/g, " ") || "empty-ffprobe";
  } catch (err: any) {
    return `probe-failed:${err?.message || err}`;
  } finally {
    try { if (fs.existsSync(input)) fs.unlinkSync(input); } catch (_) {}
  }
}

function customEmojiThumbs(doc: any): any[] {
  return [
    ...(Array.isArray(doc?.videoThumbs) ? doc.videoThumbs : []),
    ...(Array.isArray(doc?.video_thumbs) ? doc.video_thumbs : []),
    ...(Array.isArray(doc?.thumbs) ? doc.thumbs : []),
  ];
}

async function downloadCustomEmojiAnimatedPreferred(client: any, doc: any): Promise<Buffer | undefined> {
  const t0 = Date.now();
  const id = String(doc?.id ?? doc?.documentId ?? doc?.document_id ?? "");
  const mime = doc?.mimeType || doc?.mime_type || "";
  const thumbs = customEmojiThumbs(doc);
  console.warn("quote emoji source scan", id, "docMime", mime, "thumbs", thumbs.map((t: any) => `${t?.className || t?.constructor?.name || typeof t}:${t?.type || ""}:${t?.size || ""}`).join(","), "mode", "skip-thumbs-use-original");
  const td = Date.now();
  const original = await rawDownloadDocument(client, doc).catch(() => undefined);
  console.warn("quote emoji source selected", id, "original", original?.length || 0, bufferKind(original), "downloadMs", quoteMs(td), "totalMs", quoteMs(t0));
  return original;
}
function collectAnimatedMediaMessages(messages: any[]): any[] {
  const out: any[] = [];
  const scan = (message: any) => {
    if (!message) return;
    if (message.mediaBuffer && isAnimatedRasterBuffer(message.mediaBuffer)) out.push(message);
    if (message.replyMessage) scan(message.replyMessage);
    if (message.forward) scan(message.forward);
  };
  messages.forEach(scan);
  return out;
}

async function encodeFramesToWebm(frames: Buffer[], fps = TG_STICKER_FPS): Promise<Buffer> {
  const t0 = Date.now();
  const tmpBase = path.join(os.tmpdir(), `telebox_quote_webm_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const dir = `${tmpBase}_frames`;
  const outputFor = (crf: number) => `${tmpBase}_${crf}.webm`;
  const outputs: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tw = Date.now();
    frames.forEach((frame, i) => fs.writeFileSync(path.join(dir, `frame_${String(i + 1).padStart(3, "0")}.png`), frame));
    quoteTiming("webm.write_frames", tw, { frames: frames.length });

    let best: Buffer | undefined;
    let bestCrf = WEBM_CRF_STEPS[0];
    for (const crf of WEBM_CRF_STEPS) {
      const output = outputFor(crf);
      outputs.push(output);
      const te = Date.now();
      await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", String(fps),
        "-i", path.join(dir, "frame_%03d.png"),
        "-vf", "split[v][a];[a]alphaextract[alpha];[v][alpha]alphamerge,format=yuva420p",
        "-an", "-c:v", "libvpx-vp9",
        "-deadline", "good", "-cpu-used", "4",
        "-b:v", "0", "-crf", String(crf),
        "-row-mt", "1", "-tile-columns", "1",
        "-auto-alt-ref", "0", "-pix_fmt", "yuva420p",
        "-metadata:s:v:0", "alpha_mode=1",
        output,
      ], 30000);
      const encoded = fs.readFileSync(output);
      quoteTiming("webm.ffmpeg_encode", te, { frames: frames.length, fps, crf, bytes: encoded.length });
      best = encoded;
      bestCrf = crf;
      if (encoded.length <= TG_STICKER_MAX_BYTES) break;
    }
    quoteTiming("webm.encode_total", t0, { frames: frames.length, bytes: best?.length || 0, crf: bestCrf });
    return best || Buffer.alloc(0);
  } finally {
    for (const output of outputs) try { if (fs.existsSync(output)) fs.unlinkSync(output); } catch (_) {}
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}
async function generateAnimatedQuoteWebm(quoteMessages: any[], args: QuoteArgs): Promise<{ image: Buffer; ext: string; width?: number; height?: number; duration?: number }> {
  const t0 = Date.now();
  const emojiIds = collectAnimatedEmojiIds(quoteMessages);
  const mediaMessages = collectAnimatedMediaMessages(quoteMessages);
  const sources: { kind: "emoji" | "media"; key: string | any; raw: Buffer; size: number; info: { fps: number; duration: number } }[] = [];

  const rawSources = [
    ...emojiIds.map((id) => ({ kind: "emoji" as const, key: id, raw: animatedCustomEmojiCache.get(id), size: 128 })),
    ...mediaMessages.map((message) => ({ kind: "media" as const, key: message, raw: message.mediaBuffer, size: 512 })),
  ].filter((source) => !!source.raw) as { kind: "emoji" | "media"; key: string | any; raw: Buffer; size: number }[];
  const tsources = Date.now();
  const probedSources = await runWithConcurrency(rawSources, ANIMATED_FRAME_CONCURRENCY, async (source) => ({
    ...source,
    info: await probeAnimatedInfo(source.raw),
  }));
  sources.push(...probedSources);
  quoteTiming("animated.collect_sources", tsources, { emojis: emojiIds.length, media: mediaMessages.length, sources: sources.length });

  if (!sources.length) return await (await getQuoteGen()).generateQuote({
    messages: quoteMessages,
    type: "quote",
    format: "png",
    scale: args.scale,
    backgroundColor: args.backgroundColor,
    emojiBrand: args.emojiBrand,
  });

  const longest = sources.reduce((best, item) => item.info.duration > best.info.duration ? item : best, sources[0]);
  const fps = TG_STICKER_FPS;
  const oneLoopDuration = longest ? Math.max(0.1, Math.min(longest.info.duration, TG_STICKER_MAX_DURATION)) : 2;
  const duration = Math.min(TG_STICKER_MAX_DURATION, oneLoopDuration);
  const frameCount = Math.max(1, Math.min(TG_STICKER_MAX_FRAMES, Math.ceil(duration * fps)));

  const emojiFrames = new Map<string, AnimatedFrameSet>();
  const mediaFrames = new Map<any, AnimatedFrameSet>();
  const textract = Date.now();
  const extractedSources = await runWithConcurrency(sources, ANIMATED_FRAME_CONCURRENCY, async (source) => {
    const cacheKey = `${source.kind}:${String(source.key)}:${source.size}:${fps}:${frameCount}`;
    const cached = source.kind === "emoji" ? animatedFrameCache.get(cacheKey) : undefined;
    if (cached?.frames?.length) {
      quoteTiming("animated.extract_source_cached", Date.now(), { kind: source.kind, key: String(source.key), frames: cached.frames.length });
      return { source, frameSet: cached };
    }
    const tx = Date.now();
    const frames = await extractAnimatedFrames(source.raw, source.size, frameCount, fps);
    quoteTiming("animated.extract_source", tx, { kind: source.kind, key: String(source.key), frames: frames.length, size: source.size, rawKind: bufferKind(source.raw), rawBytes: source.raw.length });
    const frameSet: AnimatedFrameSet = { frames, fps, duration: source.info.duration, cacheKey };
    if (source.kind === "emoji" && frames.length) animatedFrameCache.set(cacheKey, frameSet);
    return { source, frameSet };
  });
  quoteTiming("animated.extract_all", textract, { sources: sources.length, frameCount });
  for (const { source, frameSet } of extractedSources) {
    if (source.kind === "emoji") emojiFrames.set(String(source.key), frameSet);
    else mediaFrames.set(source.key, frameSet);
  }

  const rendered: Buffer[] = [];
  const trenderAll = Date.now();
  for (let i = 0; i < frameCount; i++) {
    const trenderFrame = Date.now();
    for (const [id, set] of emojiFrames) if (set.frames.length) applyCustomEmojiFrame(quoteMessages, id, set.frames[i % set.frames.length]);
    for (const [message, set] of mediaFrames) {
      if (!set.frames.length) continue;
      const canvas = await bufferToCanvas(set.frames[i % set.frames.length]);
      if (canvas) message.mediaCanvas = canvas;
    }
    const frame = await (await getQuoteGen()).generateQuote({
      messages: quoteMessages,
      type: "quote",
      format: "png",
      scale: args.scale,
      backgroundColor: args.backgroundColor,
      emojiBrand: args.emojiBrand,
    });
    const framed = await (await getSharp())(frame.image)
      .ensureAlpha()
      .png({ force: true })
      .toBuffer();
    rendered.push(framed);
    if (i === 0 || i === frameCount - 1 || (i + 1) % 25 === 0) quoteTiming("animated.render_frame", trenderFrame, { frame: i + 1, total: frameCount });
  }
  quoteTiming("animated.render_all", trenderAll, { frames: rendered.length });
  let width = 512;
  let height = 512;
  try {
    const { loadImage } = await getCanvas();
    const probe = await loadImage(rendered[0]);
    width = probe.width;
    height = probe.height;
  } catch (_) {}
  const encoded = await encodeFramesToWebm(rendered, fps);
  const tprobe = Date.now();
  const alphaProbe = await probeWebmAlpha(encoded);
  quoteTiming("webm.alpha_probe", tprobe);
  console.warn("quote webm generated", "bytes", encoded.length, "fps", fps, "frames", rendered.length, "size", `${width}x${height}`, "alpha", alphaProbe);
  quoteTiming("animated.total", t0, { frames: rendered.length, bytes: encoded.length });
  return { image: encoded, ext: "webm", width, height, duration: Math.ceil(duration) };
}

async function normalizeCustomEmojiBuffer(buffer: Buffer | undefined): Promise<Buffer | undefined> {
  if (!buffer || buffer.length === 0) return undefined;
  if (looksLikeAnimatedEmoji(buffer)) {
    const converted = await convertAnimatedEmojiToPng(buffer);
    if (converted && converted.length > 0) return converted;
  }
  try {
    return await (await getSharp())(buffer, { animated: false }).resize(128, 128, { fit: "inside" }).png({ force: true }).toBuffer();
  } catch (_) {
    return buffer;
  }
}

async function getCustomEmojiDocuments(client: any, ids: string[]): Promise<Array<{ id: string; doc: any }>> {
  const unique = Array.from(new Set(ids.map(String).filter(Boolean)));
  if (!client || unique.length === 0 || !(Api as any).messages?.GetCustomEmojiDocuments) return [];
  try {
    const docs = await withTimeout(
      client.invoke(new (Api as any).messages.GetCustomEmojiDocuments({ documentId: unique.map((id) => big_integer(id)) })),
      QUOTE_RPC_TIMEOUT_MS,
      "getCustomEmojiDocuments.invoke",
    );
    const list = Array.isArray(docs) ? docs : [];
    const out: Array<{ id: string; doc: any }> = [];
    for (let i = 0; i < unique.length; i++) {
      const d = list[i];
      if (!d) continue;
      const cls = d.className || d._ || "";
      if (String(cls).includes("Empty")) continue;
      const rid = String(d.id ?? d.documentId ?? unique[i]);
      out.push({ id: unique[i] || rid, doc: d });
    }
    return out;
  } catch (err: any) {
    console.warn("quote custom emoji fetch failed", err?.message || err);
    return [];
  }
}

async function hydrateCustomEmojiBuffers(client: any, messages: any[]): Promise<void> {
  const ids: string[] = [];
  const scanEntity = (entity: any) => {
    const id = entity?.custom_emoji_id;
    if (id && !customEmojiCache.get(String(id))) ids.push(String(id));
  };
  const scanMessage = (message: any) => {
    (message.entities || []).forEach(scanEntity);
    (message.caption_entities || []).forEach(scanEntity);
    const status = message.from?.emoji_status ?? message.emoji_status;
    if (status != null) {
      if (typeof status === "object") {
        const statusId = status.custom_emoji_id ?? status.customEmojiId ?? status.documentId ?? status.id;
        if (statusId && !customEmojiCache.get(String(statusId))) ids.push(String(statusId));
      } else if (!customEmojiCache.get(String(status))) {
        ids.push(String(status));
      }
    }
    if (message.replyMessage) scanMessage(message.replyMessage);
    if (message.forward) scanMessage(message.forward);
  };
  messages.forEach(scanMessage);
  const docs = await getCustomEmojiDocuments(client, ids);
  await runWithConcurrency(docs, EMOJI_FETCH_CONCURRENCY, async (entry: { id: string; doc: any }) => {
    const id = entry.id;
    const doc = entry.doc;
    if (!id) return;
    let rawBuffer = await downloadCustomEmojiAnimatedPreferred(client, doc);
    const wasAnimated = looksLikeAnimatedEmoji(rawBuffer);
    if (isAnimatedRasterBuffer(rawBuffer)) animatedCustomEmojiCache.set(id, rawBuffer);
    const buffer = await normalizeCustomEmojiBuffer(rawBuffer);
    customEmojiCache.set(id, buffer);
    console.warn("quote custom emoji loaded", id, buffer ? buffer.length : 0, wasAnimated ? "animated-converted" : "static", "source", isGifBuffer(rawBuffer) ? "gif" : isWebmBuffer(rawBuffer) ? "webm" : "other", "mime", doc.mimeType || doc.mime_type || "", "thumbs", doc.thumbs?.length || 0, "videoThumbs", doc.videoThumbs?.length || doc.video_thumbs?.length || 0);
  });
  const loadedDocIds = new Set(docs.map((entry: any) => String(entry.id || "")).filter(Boolean));
  ids.forEach((id) => {
    if (!loadedDocIds.has(id)) console.warn("quote custom emoji document missing", id);
    else if (!customEmojiCache.get(id)) console.warn("quote custom emoji buffer missing", id);
  });

  const applyEntity = (entity: any) => {
    const id = entity?.custom_emoji_id;
    if (!id) return;
    const buffer = customEmojiCache.get(String(id));
    if (buffer) entity.customEmojiBuffer = buffer;
    else console.warn("quote custom emoji apply missing", String(id));
  };
  const applyMessage = (message: any) => {
    (message.entities || []).forEach(applyEntity);
    (message.caption_entities || []).forEach(applyEntity);
    const status = message.from?.emoji_status ?? message.emoji_status;
    if (status != null) {
      let key: string | undefined;
      if (typeof status === "object") {
        key = String(status.custom_emoji_id ?? status.customEmojiId ?? status.documentId ?? status.id ?? "");
      } else {
        key = String(status);
      }
      if (key && key !== "undefined" && key !== "") {
        const buffer = customEmojiCache.get(key);
        const payload = { custom_emoji_id: key, ...(buffer ? { customEmojiBuffer: buffer } : {}) };
        if (message.from) message.from.emoji_status = payload;
        message.emoji_status = payload;
        if (buffer) console.warn("quote sender emoji status cached", key, buffer.length);
        else console.warn("quote sender emoji status missing", key);
      }
    }
    if (message.replyMessage) applyMessage(message.replyMessage);
    if (message.forward) applyMessage(message.forward);
  };
  messages.forEach(applyMessage);
}

async function replyPreview(msg: Api.Message, includeReply: boolean, args: QuoteArgs): Promise<any | undefined> {
  if (!includeReply) return undefined;
  const reply = await withTimeout(safeGetReplyMessage(msg), QUOTE_RPC_TIMEOUT_MS, "replyPreview.getReply").catch(() => undefined);
  if (!reply) return undefined;
  const entity = await senderEntity(reply);
  const name = displayName(entity);
  return {
    chatId: senderIdNumber(reply),
    from: { id: senderIdNumber(reply), name, first_name: name, photo: {}, emoji_status: emojiStatusPayload(entity) },
    name,
    text: messageText(reply),
    entities: convertEntities(reply),
    ...await prepareQuoteMedia(reply, args),
  };
}

async function forwardPreview(msg: Api.Message): Promise<any | undefined> {
  const fwd: any = (msg as any).fwdFrom || (msg as any).fwd_from;
  if (!fwd) return undefined;
  const src = await forwardedSource(msg);
  const name = src?.name || "Forwarded";
  const avatarClient = (msg as any).client ?? await getGlobalClient().catch(() => undefined);
  const avatarBuffer = src?.entity && !src.anonymous ? await downloadEntityAvatar(avatarClient, src.entity) : undefined;
  return {
    chatId: peerIdNumber(src?.peer || src?.entity),
    from: { id: peerIdNumber(src?.peer || src?.entity), name, first_name: name, photo: {}, emoji_status: src?.anonymous ? undefined : emojiStatusPayload(src?.entity) },
    name,
    text: `Forwarded from ${name}`,
    entities: [],
    avatar: !!avatarBuffer,
    avatarBuffer,
    avatarScale: 2,
    date: fwd.date,
    channelPost: fwd.channelPost ?? fwd.channel_post,
    anonymous: !!src?.anonymous,
  };
}

async function senderRankInChat(msg: Api.Message, entity: any): Promise<string | undefined> {
  if (!entity?.accessHash) return undefined;
  try {
    const client = (msg as any).client;
    const chatPeer = (msg as any).peerId ?? (msg as any).chatId ?? (msg as any).inputChat;
    const inputUser = new Api.InputUser({ userId: entity.id, accessHash: entity.accessHash });
    const result = await withTimeout(
      client.invoke(new Api.channels.GetParticipant({ channel: chatPeer, participant: inputUser })),
      QUOTE_RPC_TIMEOUT_MS,
      "senderRank.channels.getParticipant",
    );
    return (result as any)?.participant?.rank?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function toQuoteMessage(msg: Api.Message, args: QuoteArgs): Promise<any> {
  const entity = await senderEntity(msg);
  const fwd = await forwardedSource(msg);
  const effectiveEntity = fwd?.entity ?? entity;
  const effectiveName = fwd?.name || displayName(effectiveEntity);
  const avatarClient = (msg as any).client ?? await getGlobalClient().catch(() => undefined);
  const [avatarBuffer, media, replyMessage] = await Promise.all([
    fwd && !fwd.anonymous && fwd.entity
      ? downloadEntityAvatar(avatarClient, fwd.entity)
      : downloadSenderAvatar(msg, entity),
    prepareQuoteMedia(msg, args),
    replyPreview(msg, args.reply, args),
    Promise.resolve(undefined),
  ]);
  const emojiId = emojiStatusIdFromEntity(effectiveEntity);
  let emojiBuffer: Buffer | undefined;
  if (emojiId) {
    emojiBuffer = customEmojiCache.get(emojiId);
    console.warn("quote sender emoji status", emojiId, emojiBuffer ? emojiBuffer.length : 0);
  }
  const user: QuoteUser = {
    id: fwd?.peer ? peerIdNumber(fwd.peer) : senderIdNumber(msg),
    name: args.hidden ? false : effectiveName,
    first_name: args.hidden ? false : effectiveName,
    photo: {},
    emoji_status: args.hidden || fwd?.anonymous ? undefined : emojiStatusPayload(effectiveEntity, emojiBuffer),
  };
  return {
    chatId: fwd?.peer ? peerIdNumber(fwd.peer) : senderIdNumber(msg),
    message_id: (msg as any).id,
    from: user,
    name: user.name,
    avatar: !args.hidden && !!avatarBuffer,
    avatarBuffer: args.hidden ? undefined : avatarBuffer,
    avatarScale: args.scale,
    text: messageText(msg),
    entities: convertEntities(msg),
    caption: messageText(msg),
    caption_entities: convertEntities(msg),
    replyMessage,
    forward: fwd ? { label: fwd.name || "Forwarded message" } : undefined,
    mediaBuffer: media.mediaBuffer,
    mediaCanvas: media.mediaCanvas,
    mediaType: media.mediaType,
    mediaMaxSize: media.mediaMaxSize,
    mediaCrop: media.mediaCrop,
    mediaDuration: media.mediaDuration,
    voice: media.voice,
    document: media.document,
    audio: media.audio,
    emoji_status: args.hidden || fwd?.anonymous ? undefined : emojiStatusPayload(effectiveEntity, emojiBuffer),
    date: messageDate(msg),
    via_bot: (msg as any).viaBotId ?? (msg as any).via_bot_id,
    senderTag: fwd ? undefined : await senderRankInChat(msg, entity),
  };
}

async function collectMessages(msg: Api.Message, args: QuoteArgs): Promise<Api.Message[]> {
  const reply = await withTimeout(safeGetReplyMessage(msg), QUOTE_RPC_TIMEOUT_MS, "collectMessages.getReply").catch(() => undefined);
  const count = args.count || 1;

  const peer = (msg as any).inputChat ?? (msg as any).peerId ?? (msg as any).chatId;
  const client = (msg as any).client;
  if (!peer || !client) return [reply || msg];

  if (reply) {
    const baseId = (reply as any).id;
    if (!baseId || Math.abs(count) <= 1) return [reply];
    const limit = Math.min(Math.abs(count), MAX_QUOTE_MESSAGES);
    const params = count > 0
      ? { offsetId: baseId - 1, limit, reverse: true }
      : { offsetId: baseId + 1, limit };
    const messages = await withTimeout(safeGetMessages(client, peer, params), QUOTE_RPC_TIMEOUT_MS, "collectMessages.getMessages.reply").catch(() => []);
    const result = (Array.isArray(messages) ? messages : []).filter(isApiMessage).sort((a: any, b: any) => a.id - b.id) as Api.Message[];
    console.warn("quote collect messages", { reply: true, count, baseId, params, got: result.map((m: any) => m.id) });
    return result.length ? result : [reply];
  }

  const commandId = (msg as any).id;
  if (!commandId || Math.abs(count) <= 1) return [msg];
  const limit = Math.min(Math.abs(count), MAX_QUOTE_MESSAGES);
  const params = count > 0
    ? { offsetId: commandId, limit }
    : { offsetId: commandId + 1, limit };
  const messages = await withTimeout(safeGetMessages(client, peer, params), QUOTE_RPC_TIMEOUT_MS, "collectMessages.getMessages.command").catch(() => []);
  const result = (Array.isArray(messages) ? messages : []).filter(isApiMessage).sort((a: any, b: any) => a.id - b.id) as Api.Message[];
  console.warn("quote collect messages", { reply: false, count, commandId, params, got: result.map((m: any) => m.id) });
  return result.length ? result : [msg];
}

function hasExplicitCount(argsText: string): boolean {
  return /(?:^|\s)[+-]?\d+(?:\s|$)/.test(argsText.trim());
}

async function quoteStickerReplyTargetId(commandMsg: Api.Message, quoteMessages: Api.Message[], argsText: string): Promise<any> {
  const replied = await withTimeout(safeGetReplyMessage(commandMsg), QUOTE_RPC_TIMEOUT_MS, "quoteStickerReplyTargetId.getReply").catch(() => undefined);
  if (replied && (replied as any).id) return (replied as any).id;

  // Direct `.q <number>` quotes surrounding messages, so there is no single referenced message.
  // Keep the old behavior there and reply to the command itself.
  if (hasExplicitCount(argsText)) return (commandMsg as any).id;

  return quoteMessages[0]?.id ?? (commandMsg as any).id;
}

async function editProgress(msg: Api.Message, text: string, parseMode?: "html" | "md"): Promise<void> {
  try {
    if (typeof (msg as any).edit === "function") {
      await withTimeout(
        (msg as any).edit(parseMode ? { text, parseMode } : { text }),
        QUOTE_RPC_TIMEOUT_MS,
        "editProgress.edit",
      );
    } else {
      await withTimeout(
        (msg as any).client?.editMessage?.((msg as any).chatId ?? (msg as any).peerId, {
          message: msg.id,
          text,
          ...(parseMode ? { parseMode } : {}),
        }),
        QUOTE_RPC_TIMEOUT_MS,
        "editProgress.editMessage",
      );
    }
  } catch (_) {
    // Progress text is best-effort. If editing stalls (e.g. connection drop) or
    // fails, fall back to a reply but never let it block / hang the command.
    try {
      await withTimeout(
        msg.reply(parseMode ? ({ message: text, parseMode } as any) : ({ message: text } as any)),
        QUOTE_RPC_TIMEOUT_MS,
        "editProgress.reply",
      );
    } catch (_) {}
  }
}

export class QuotePlugin {
  // 完整 helptext：.help quote / .q help 共用；help 详情页整段进可折叠「功能描述」
  description = buildQuoteHelpText();
  cmdHandlers = {
    q: async (msg: Api.Message) => this.handleQuote(msg, "q"),
    quote: async (msg: Api.Message) => this.handleQuote(msg, "quote"),
  };

  private async handleQuote(msg: Api.Message, command: "q" | "quote") {
      const rawText = ((msg as any).message || (msg as any).text || "") as string;
      const argsText = getCommandArgsText(msg, command);
      if (wantsQuoteHelp(argsText)) {
        await editProgress(msg, buildQuoteHelpText(), "html");
        return;
      }
      const args = parseArgs(argsText);
      const quoteStartedAt = Date.now();
      console.warn("quote command triggered", { command, text: rawText, argsText, out: (msg as any).out, replyTo: !!(msg as any).replyTo, backgroundColor: args.backgroundColor });
      await editProgress(msg, quoteResourcesReady() ? "⏳ 正在生成 quote…" : "⏳ 首次使用，正在初始化 quote 资源…");

      try {
        // Hard ceiling on the entire pipeline. Even if some future await inside
        // here lacks its own timeout (vendor render, on-demand npm install, an
        // RPC we forgot to wrap), this guarantees the command cannot hang forever:
        // it rejects after QUOTE_TOTAL_TIMEOUT_MS and the catch below reports it.
        await withTimeout((async () => {
        const tCollect = Date.now();
        const messages = await collectMessages(msg, args);
        quoteTiming("main.collect_messages", tCollect, { count: messages.length, ids: messages.map((m: any) => m.id) });
        const tQuoteMsg = Date.now();
        const quoteMessages = await runWithConcurrency(messages, QUOTE_MESSAGE_CONCURRENCY, (item) => toQuoteMessage(item, args));
        quoteTiming("main.to_quote_messages", tQuoteMsg, { count: quoteMessages.length });
        const tEmoji = Date.now();
        await hydrateCustomEmojiBuffers((msg as any).client, quoteMessages);
        quoteTiming("main.hydrate_custom_emoji", tEmoji, { count: quoteMessages.length });

        const hasAnimated = false;
        const tGenerate = Date.now();
        // quote-api output types: quote (sticker frame) | image (wallpaper) | stories (720×1280)
        const outType = args.stories ? "stories" : args.png ? "image" : "quote";
        const outFormat = args.png || args.stories ? "png" : "webp";
        const result = await (await getQuoteGen()).generateQuote({
          messages: quoteMessages,
          type: outType,
          format: outFormat,
          scale: args.scale,
          backgroundColor: args.backgroundColor,
          emojiBrand: args.emojiBrand,
        });
        quoteTiming("main.generate_result", tGenerate, { ext: result.ext, bytes: result.image?.length || 0, hasAnimated });

        const dir = createDirectoryInTemp("telebox_quote");
        const output = path.join(dir, `quote.${result.ext}`);
        fs.writeFileSync(output, result.image);

        const replyTargetId = await quoteStickerReplyTargetId(msg, messages, argsText);
        await editProgress(msg, "✅ quote 已生成，正在发送…");
        const sendOptions: any = {
          file: output,
          forceDocument: false,
          replyTo: replyTargetId,
        };
        // wallpaper / stories → send as image; quote sticker stays default
        if (outType === "image" || outType === "stories") {
          sendOptions.forceDocument = false;
        }
        if (result.ext === "webm") {
          const width = result.width || 512;
          const height = result.height || 512;
          const duration = result.duration || 2;
          sendOptions.file = new CustomFile("quote.webm", result.image.length, "", result.image);
          sendOptions.mimeType = "video/webm";
          sendOptions.supportsStreaming = true;
          sendOptions.attributes = [
            new Api.DocumentAttributeSticker({
              alt: args.emojiSuffix || "💜",
              stickerset: new Api.InputStickerSetEmpty(),
              mask: false,
            } as any),
            new Api.DocumentAttributeFilename({ fileName: "quote.webm" }),
          ];
          console.warn("quote webm send options", { bytes: result.image.length, mimeType: sendOptions.mimeType, supportsStreaming: sendOptions.supportsStreaming, width, height, duration, attributes: sendOptions.attributes.map((a: any) => a.className || a.constructor?.name) });
        } else {
          sendOptions.attributes = [];
        }
        const tSend = Date.now();
        await withTimeout(msg.reply(sendOptions as any), QUOTE_RPC_TIMEOUT_MS, "main.send_reply");
        quoteTiming("main.send_reply", tSend, { ext: result.ext, bytes: result.image?.length || 0 });
        try {
          await withTimeout((msg as any).delete?.(), QUOTE_RPC_TIMEOUT_MS, "main.delete_source");
          console.warn("quote command source deleted", { id: (msg as any).id });
        } catch (deleteErr: any) {
          console.warn("quote command source delete failed", deleteErr?.message || deleteErr);
        }
        console.warn("quote command finished", { ms: Date.now() - quoteStartedAt, bytes: result.image?.length, ext: result.ext, replyTo: replyTargetId });
        })(), QUOTE_TOTAL_TIMEOUT_MS, "handleQuote.pipeline");
      } catch (err: any) {
        console.error("quote command failed", err?.stack || err?.message || err);
        await editProgress(msg, `❌ quote 失败：${err?.message || err}`);
      }
  }
}

export default new QuotePlugin();

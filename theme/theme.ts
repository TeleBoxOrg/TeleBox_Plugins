import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { htmlEscape } from "@utils/htmlEscape";
import { Api, TelegramClient } from "teleproto";
import { CustomFile } from "teleproto/client/uploads";
import bigInt from "big-integer";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) result += htmlEscape(values[i]);
  }
  return result;
}

function tlType(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const object = value as { _: string; className?: string };
  if (typeof object._ === "string") return object._;
  if (typeof object.className === "string") return object.className;
  return "";
}

function hasTlType(value: unknown, expected: string): boolean {
  const type = tlType(value).toLowerCase();
  const wanted = expected.toLowerCase();
  return type === wanted || type.endsWith(`.${wanted}`);
}

function toLong(value: unknown): bigInt.BigInteger {
  if (value == null) return bigInt.zero;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") return bigInt(value.toString());
  try { return bigInt(String(value)); } catch { return bigInt.zero; }
}

function toBytes(value: unknown): Buffer {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(value as ArrayBuffer);
}

function documentAttributeFileName(document: any): string {
  const attribute = (document?.attributes || []).find((item: any) =>
    hasTlType(item, "documentAttributeFilename") || item instanceof Api.DocumentAttributeFilename,
  );
  return typeof attribute?.fileName === "string" ? attribute.fileName : "";
}

function toInputDocument(document: any): Api.InputDocument | null {
  if (!document || document.id == null || document.accessHash == null) return null;
  return new Api.InputDocument({
    id: toLong(document.id),
    accessHash: toLong(document.accessHash),
    fileReference: toBytes(document.fileReference),
  });
}

function toBaseTheme(name: string): any {
  const normalized = String(name || "").toLowerCase();
  if (normalized.includes("night")) return new Api.BaseThemeNight();
  if (normalized.includes("classic")) return new Api.BaseThemeClassic();
  const Tinted = (Api as any).BaseThemeTinted;
  if (normalized.includes("tinted") && Tinted) return new Tinted();
  return new Api.BaseThemeDay();
}

async function sendThemeDocument(
  client: TelegramClient,
  peer: any,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  caption: string,
  replyTo?: number,
): Promise<void> {
  await client.sendFile(peer, {
    file: new CustomFile(fileName, buffer.length, "", buffer),
    forceDocument: true,
    mimeType,
    attributes: [new Api.DocumentAttributeFilename({ fileName })],
    caption,
    parseMode: "html",
    replyTo,
  } as any);
}

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ASSETS_DIR = path.join(process.cwd(), "assets", "theme");

if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

// ─── Types ───────────────────────────────────────────────────────────────────

type ThemeFormat = "attheme" | "tdesktop-theme" | "tgx-theme" | "ios-theme";

const API_MIME: Record<ThemeFormat, string> = {
  attheme: "application/x-tgtheme-android",
  "tdesktop-theme": "application/x-tgtheme-tdesktop",
  "tgx-theme": "application/x-tgtheme-macos",
  "ios-theme": "application/x-tgtheme-ios",
};

interface ThemeDoc {
  format: ThemeFormat;
  colors: Record<string, string>;
  /** Raw wallpaper image bytes (JPEG/PNG), without WPS/WPE wrappers */
  wallpaper?: Buffer | null;
  /** Desktop tiled wallpaper flag */
  wallpaperTiled?: boolean;
  /**
   * iOS cloud wallpaper slug from `chat.defaultWallpaper: <slug> ...`.
   * Real .tgios-theme files do NOT embed image bytes — they reference a cloud
   * wallpaper uploaded via account.uploadWallPaper / existing wallpapers.
   */
  wallpaperSlug?: string | null;
  /** Wallpaper blur radius (0 = no blur) */
  wallpaperBlur?: number;
  /** Wallpaper motion effect flag (iOS parallax) */
  wallpaperMotion?: boolean;
  /** Wallpaper pattern intensity 0..100 (Android) */
  wallpaperIntensity?: number;
  /** Wallpaper solid background color (Android fallback behind pattern) */
  wallpaperColor?: string | null;
  /** Wallpaper pattern ID/slug (Android) */
  wallpaperPattern?: string | null;
  /** Parent / based-on theme identifier */
  basedOn?: string | null;
}

const FORMAT_LABELS: Record<ThemeFormat, string> = {
  attheme: "Android (.attheme)",
  "tdesktop-theme": "Desktop (.tdesktop-theme)",
  "tgx-theme": "TGX (.tgx-theme)",
  "ios-theme": "iOS (.tgios-theme)",
};

const FORMAT_EXT: Record<ThemeFormat, string> = {
  attheme: ".attheme",
  "tdesktop-theme": ".tdesktop-theme",
  "tgx-theme": ".tgx-theme",
  "ios-theme": ".tgios-theme",
};

// client-target aliases (user doesn't need to know source format)
// Official file formats are ONLY 4 (API getTheme format strings):
//   android → .attheme | ios → .tgios-theme | macos → .tgx-theme | tdesktop → .tdesktop-theme
// Other clients reuse one of these engines or cloud themeSettings only.
const TARGET_ALIASES: Record<string, ThemeFormat> = {
  // Android engine (.attheme) — official + forks
  android: "attheme",
  official: "attheme",
  nekogram: "attheme",
  neko: "attheme",
  nicegram: "attheme",
  owlgram: "attheme",
  extera: "attheme",
  cherrygram: "attheme",
  materialgram: "attheme",
  // Desktop engine
  desktop: "tdesktop-theme",
  tdesktop: "tdesktop-theme",
  "64gram": "tdesktop-theme",
  kotatogram: "tdesktop-theme",
  ayugram: "tdesktop-theme",
  // TGX / macOS engine
  tgx: "tgx-theme",
  macos: "tgx-theme",
  mac: "tgx-theme",
  // iOS engine
  ios: "ios-theme",
  iphone: "ios-theme",
  // Cloud themeSettings clients (no proprietary file — use settings export / cloud link)
  // Still map convert-to-X to closest file format for palette transfer
  unigram: "tdesktop-theme",
  web: "tdesktop-theme",
  webk: "tdesktop-theme",
  weba: "tdesktop-theme",
  telegramweb: "tdesktop-theme",
};

const TARGET_CLIENT_LABELS: Record<ThemeFormat, string> = {
  attheme: "📱 Android",
  "tdesktop-theme": "💻 Desktop",
  "tgx-theme": "📲 TGX / macOS",
  "ios-theme": "🍎 iOS",
};

/** Human labels for alias → which real engine */
const CLIENT_ENGINE_NOTE: Record<string, string> = {
  android: "官方 Android · .attheme",
  nekogram: "Nekogram 等 Android 衍生 · .attheme",
  neko: "Nekogram · .attheme",
  nicegram: "Nicegram · .attheme",
  desktop: "Telegram Desktop · .tdesktop-theme",
  tdesktop: "Telegram Desktop · .tdesktop-theme",
  "64gram": "64Gram · .tdesktop-theme",
  kotatogram: "Kotatogram · .tdesktop-theme",
  ayugram: "AyuGram · .tdesktop-theme",
  tgx: "Telegram X · .tgx-theme",
  macos: "Telegram macOS · .tgx-theme",
  ios: "官方 iOS · .tgios-theme",
  unigram: "Unigram → 云端 themeSettings（无独立文件）",
  web: "Telegram Web → 云端 themeSettings",
  webk: "WebK → 云端 themeSettings",
  weba: "WebA → 云端 themeSettings",
};

// ─── Color utilities ─────────────────────────────────────────────────────────

function toHex(r: number, g: number, b: number, a = 255): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  if (a < 255) return `#${c(a)}${c(r)}${c(g)}${c(b)}`;
  return `#${c(r)}${c(g)}${c(b)}`;
}

function parseColor(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (/^[0-9a-fA-F]{6}$/.test(h)) return `#${h}`;
    if (/^[0-9a-fA-F]{8}$/.test(h)) return `#${h}`;
    if (/^[0-9a-fA-F]{3}$/.test(h)) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (/^[0-9a-fA-F]{4}$/.test(h)) {
      // #RGBA → #AARRGGBB
      return `#${h[3]}${h[3]}${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    }
    return null;
  }
  // rgb(r,g,b) / rgba(r,g,b,a)
  const rgb = s.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
  if (rgb) {
    const r = Math.max(0, Math.min(255, Math.round(Number(rgb[1]))));
    const g = Math.max(0, Math.min(255, Math.round(Number(rgb[2]))));
    const b = Math.max(0, Math.min(255, Math.round(Number(rgb[3]))));
    if (rgb[4] != null) {
      const aF = Number(rgb[4]);
      const a = aF <= 1 ? Math.round(aF * 255) : Math.round(aF);
      if (a >= 0 && a < 255) return toHex(r, g, b, Math.max(0, Math.min(255, a)));
    }
    return toHex(r, g, b);
  }
  // 0xAARRGGBB / 0xRRGGBB
  if (/^0x[0-9a-fA-F]{6,8}$/i.test(s)) {
    const n = parseInt(s.slice(2), 16) >>> 0;
    if (s.length === 10) {
      // 0xAARRGGBB
      return toHex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, (n >> 24) & 0xff);
    }
    return toHex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  if (s.endsWith("h") || s.endsWith("H")) {
    try {
      const n = parseInt(s.slice(0, -1), 16) >>> 0;
      // 8 hex digits → AARRGGBB
      if (s.length === 9) return toHex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, (n >> 24) & 0xff);
      return toHex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    } catch { return null; }
  }
  try {
    // bare hex without # — must win over decimal parseInt("112233")
    if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`;
    if (/^[0-9a-fA-F]{8}$/.test(s)) return `#${s}`;
    let n = parseInt(s, 10);
    if (isNaN(n) || !/^-?\d+$/.test(s)) return null;
    if (n < 0) n = n >>> 0;
    const a = (n >> 24) & 0xff;
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    if (a > 0 && a < 255) return toHex(r, g, b, a);
    return toHex(r, g, b);
  } catch { return null; }
}

function adjustBright(hex: string, pct: number): string {
  if (!hex.startsWith("#")) return hex;
  const h = hex.slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const f = 1 + pct / 100;
  return toHex(Math.max(0, Math.min(255, r * f)), Math.max(0, Math.min(255, g * f)), Math.max(0, Math.min(255, b * f)));
}

function toRgb(hex: string): string { return hex.length === 9 ? "#" + hex.slice(3) : hex; }

/** Fast stable content key for wallpaper bytes (slug reverse cache / disk) */
function wallpaperContentHash(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 40);
}

// ─── Wallpaper / ZIP helpers ─────────────────────────────────────────────────

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}
function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}
function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}
function detectImageExt(buf: Buffer): "jpg" | "png" | null {
  if (isJpeg(buf)) return "jpg";
  if (isPng(buf)) return "png";
  return null;
}

/** Read JPEG SOF dimensions without full decode. Returns null if not JPEG / truncated. */
function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (!isJpeg(buf) || buf.length < 4) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; } // SOI/EOI
    if (marker >= 0xd0 && marker <= 0xd7) { i += 2; continue; } // RSTn
    if (i + 3 >= buf.length) break;
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2) break;
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 (baseline/progressive/etc.)
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (i + 8 >= buf.length) break;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    i += 2 + segLen;
  }
  return null;
}

/** Read PNG IHDR dimensions. */
function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (!isPng(buf) || buf.length < 24) return null;
  // signature 8 + IHDR len 4 + type 4 + width 4 + height 4
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width > 0 && height > 0) return { width, height };
  return null;
}

function readImageDimensions(buf: Buffer | null | undefined): { width: number; height: number; orient: "portrait" | "landscape" | "square" } | null {
  const wp = normalizeWallpaper(buf || null);
  if (!wp) return null;
  const d = detectImageExt(wp) === "png" ? readPngDimensions(wp) : readJpegDimensions(wp);
  if (!d) return null;
  const orient = d.height > d.width * 1.05 ? "portrait" : d.width > d.height * 1.05 ? "landscape" : "square";
  return { ...d, orient };
}

function formatImageDim(d: { width: number; height: number; orient: string } | null): string {
  if (!d) return "";
  const o = d.orient === "portrait" ? "竖图" : d.orient === "landscape" ? "横图" : "方图";
  return `${d.width}×${d.height} ${o}`;
}

/** Strip accidental WPS/WPE wrappers; return pure image bytes or null */
function normalizeWallpaper(raw: Buffer | null | undefined): Buffer | null {
  if (!raw || raw.length < 16) return null;
  let b = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any);
  // strip leading WPS\n
  if (b.length >= 4 && b.subarray(0, 4).equals(Buffer.from("WPS\n"))) b = b.subarray(4);
  // strip trailing \nWPE\n or WPE\n
  if (b.length >= 5 && b.subarray(b.length - 5).equals(Buffer.from("\nWPE\n"))) b = b.subarray(0, b.length - 5);
  else if (b.length >= 4 && b.subarray(b.length - 4).equals(Buffer.from("WPE\n"))) b = b.subarray(0, b.length - 4);
  if (!detectImageExt(b)) {
    // search for embedded jpeg/png signature
    const j = b.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const p = b.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let start = -1;
    if (j >= 0 && (p < 0 || j < p)) start = j;
    else if (p >= 0) start = p;
    if (start > 0) b = b.subarray(start);
    if (!detectImageExt(b)) return null;
  }
  return b;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function u16le(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0, 0); return b; }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

/** Create a store-only ZIP (method 0) — enough for tdesktop theme packages */
function makeZip(files: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32le(0x04034b50), u16le(20), u16le(0), u16le(0), u16le(0), u16le(0),
      u32le(crc), u32le(data.length), u32le(data.length), u16le(nameBuf.length), u16le(0),
      nameBuf, data,
    ]);
    const central = Buffer.concat([
      u32le(0x02014b50), u16le(20), u16le(20), u16le(0), u16le(0), u16le(0), u16le(0),
      u32le(crc), u32le(data.length), u32le(data.length), u16le(nameBuf.length), u16le(0),
      u16le(0), u16le(0), u16le(0), u32le(0), u32le(offset),
      nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32le(0x06054b50), u16le(0), u16le(0), u16le(files.length), u16le(files.length),
    u32le(centralDir.length), u32le(offset), u16le(0),
  ]);
  return Buffer.concat([...locals, centralDir, end]);
}

/** Parse local-file entries from a ZIP (store or deflate). Falls back to central directory. */
function parseZip(buf: Buffer): Record<string, Buffer> {
  const zlib = require("zlib") as typeof import("zlib");
  const out: Record<string, Buffer> = {};

  const inflate = (method: number, data: Buffer): Buffer => {
    if (method === 8) {
      try { return zlib.inflateRawSync(data); } catch { return data; }
    }
    return data;
  };

  const storeEntry = (name: string, data: Buffer) => {
    out[name] = data;
    const base = name.split("/").pop() || name;
    if (base !== name) out[base] = data;
    const lower = base.toLowerCase();
    if (lower !== base) out[lower] = data;
  };

  // ── Pass 1: local file headers ──────────────────────────────────────
  let i = 0;
  while (i + 30 <= buf.length) {
    const sig = buf.readUInt32LE(i);
    if (sig !== 0x04034b50) break; // PK\x03\x04 local file
    const method = buf.readUInt16LE(i + 8);
    const flags = buf.readUInt16LE(i + 6);
    let comp = buf.readUInt32LE(i + 18);
    let uncomp = buf.readUInt32LE(i + 22);
    const nlen = buf.readUInt16LE(i + 26);
    const elen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nlen).toString("utf8");
    let start = i + 30 + nlen + elen;
    let data: Buffer;

    // Bit 3: data descriptor — sizes in local header may be zero
    if ((flags & 0x8) && (comp === 0 || uncomp === 0)) {
      let scan = start;
      let next = -1;
      while (scan + 4 <= buf.length) {
        const s = buf.readUInt32LE(scan);
        if (s === 0x04034b50 || s === 0x02014b50 || s === 0x06054b50) {
          next = scan;
          break;
        }
        if (s === 0x08074b50 && scan + 16 <= buf.length) {
          next = scan;
          break;
        }
        scan++;
      }
      if (next < 0) next = buf.length;
      let end = next;
      if (next >= start + 16 && buf.readUInt32LE(next - 16) === 0x08074b50) {
        end = next - 16;
        comp = buf.readUInt32LE(next - 12);
        if (comp > 0 && start + comp <= next - 16) end = start + comp;
      } else if (next >= start + 12) {
        const maybeComp = buf.readUInt32LE(next - 8);
        if (maybeComp > 0 && start + maybeComp === next - 12) {
          end = start + maybeComp;
          comp = maybeComp;
        }
      }
      data = buf.subarray(start, end);
      i = next;
      if (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x08074b50) i += 16;
    } else {
      data = buf.subarray(start, start + comp);
      i = start + comp;
    }

    if (method !== 0 && method !== 8) continue;
    storeEntry(name, Buffer.from(inflate(method, data)));
  }

  // ── Pass 2: central directory fallback (if local pass got nothing / incomplete) ──
  // Find EOCD (PK\x05\x06) near end, then walk central headers
  let eocd = -1;
  for (let p = Math.max(0, buf.length - 22 - 65535); p + 22 <= buf.length; p++) {
    if (buf.readUInt32LE(p) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd >= 0) {
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const cdTotal = buf.readUInt16LE(eocd + 10);
    let c = cdOffset;
    for (let n = 0; n < cdTotal && c + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(c) !== 0x02014b50) break;
      const method = buf.readUInt16LE(c + 10);
      const comp = buf.readUInt32LE(c + 20);
      const nlen = buf.readUInt16LE(c + 28);
      const elen = buf.readUInt16LE(c + 30);
      const clen = buf.readUInt16LE(c + 32);
      const localOff = buf.readUInt32LE(c + 42);
      const name = buf.subarray(c + 46, c + 46 + nlen).toString("utf8");
      c += 46 + nlen + elen + clen;
      if (out[name]) continue; // already have from local pass
      if (localOff + 30 > buf.length) continue;
      if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
      const lnlen = buf.readUInt16LE(localOff + 26);
      const lelen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lnlen + lelen;
      if (dataStart + comp > buf.length) continue;
      if (method !== 0 && method !== 8) continue;
      const data = buf.subarray(dataStart, dataStart + comp);
      storeEntry(name, Buffer.from(inflate(method, data)));
    }
  }

  return out;
}

function parseDesktopColorText(text: string): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("//")) continue;
    // strip trailing // comment
    const noComment = s.replace(/\s+\/\/.*$/, "").trim();
    // Support: key: value;  OR  key: value  OR multi key: a: x; b: y;
    const parts = noComment.split(";").map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
      const col = part.indexOf(":");
      if (col <= 0) continue;
      const key = part.slice(0, col).trim();
      let val = part.slice(col + 1).trim();
      if (!key || !val) continue;
      // skip non-color metadata here — handled by extractDesktopMeta
      if (/^wallpaper$/i.test(key)) continue;
      raw[key] = val;
    }
  }
  // Multi-round alias resolve (up to 12)
  const resolve = (v: string, depth = 0): string | null => {
    if (depth > 12) return null;
    const hex = parseColor(v);
    if (hex) return hex;
    // alias reference
    const ref = raw[v] || raw[v.replace(/^\$/, "")];
    if (ref && ref !== v) return resolve(ref, depth + 1);
    return null;
  };
  const colors: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const hex = resolve(v);
    if (hex) colors[k] = hex;
  }
  return colors;
}

/** Extract wallpaper: t.me/bg/SLUG (?mode=tiled) from desktop palette text */
function extractDesktopMeta(text: string): {
  wallpaperSlug: string | null;
  wallpaperTiled: boolean;
  wallpaperLink: string | null;
} {
  let wallpaperSlug: string | null = null;
  let wallpaperTiled = false;
  let wallpaperLink: string | null = null;
  for (const line of text.split("\n")) {
    const s = line.trim().replace(/\s+\/\/.*$/, "");
    if (!s || s.startsWith("//")) continue;
    const m = s.match(/^wallpaper\s*:\s*(.+?);?\s*$/i);
    if (!m) continue;
    let val = m[1].trim().replace(/^["']|["']$/g, "");
    wallpaperLink = val;
    // t.me/bg/SLUG or https://t.me/bg/SLUG?mode=tiled
    const bg = val.match(/(?:https?:\/\/)?t\.me\/bg\/([A-Za-z0-9_\-]+)(?:\?([^#\s]+))?/i);
    if (bg) {
      wallpaperSlug = bg[1];
      if (bg[2] && /(?:^|&)mode=tiled\b/i.test(bg[2])) wallpaperTiled = true;
      if (bg[2] && /(?:^|&)mode=blur\b/i.test(bg[2])) {
        /* blur flag on link — stored via tiled only for desktop package */
      }
    }
  }
  return { wallpaperSlug, wallpaperTiled, wallpaperLink };
}

function extractDesktopWallpaper(files: Record<string, Buffer>): { wallpaper: Buffer | null; tiled: boolean } {
  const names = Object.keys(files);
  const lower = (n: string) => n.toLowerCase();
  const find = (cands: string[]) => {
    for (const c of cands) {
      const hit = names.find(n => lower(n) === c || lower(n).endsWith("/" + c) || lower(n).split("/").pop() === c);
      if (hit && files[hit]?.length) return files[hit];
    }
    return null;
  };
  // Prefer explicit background/tiled names; then any image that looks like wallpaper
  const tiledBuf = find(["tiled.jpg", "tiled.jpeg", "tiled.png", "tiled.webp"]);
  const tiled = !!tiledBuf;
  let wp = find([
    "background.jpg", "background.jpeg", "background.png", "background.webp",
    "background", "bg.jpg", "bg.jpeg", "bg.png",
    "tiled.jpg", "tiled.jpeg", "tiled.png", "tiled.webp",
  ]);
  if (!wp) {
    // last resort: largest jpeg/png in package (excluding colors file)
    let best: Buffer | null = null;
    for (const n of names) {
      const l = lower(n);
      if (l.includes("color") || l.endsWith(".tdesktop-theme") || l.endsWith(".tdesktop-palette")) continue;
      const b = files[n];
      if (!b || b.length < 100) continue;
      if (detectImageExt(b) && (!best || b.length > best.length)) best = b;
    }
    wp = best;
  }
  return { wallpaper: normalizeWallpaper(wp || tiledBuf), tiled };
}

/** Non-color attheme keys that must never enter the palette map */
const ATTHEME_META_KEYS = new Set([
  "wallpaperfileoffset",
  "wallpaperfileoffset ",
]);

function isAtthemeMetaKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  return k === "wallpaperfileoffset" || k.startsWith("wallpaperfileoffset");
}

/**
 * Convert internal #RRGGBB / #AARRGGBB → Android signed-int color string.
 * Official .attheme exports use decimal ints (e.g. -14737374), not hex.
 */
function toAndroidColorValue(hex: string): string {
  if (!hex) return "0";
  let h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length === 3) h = `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  let a = 255, r = 0, g = 0, b = 0;
  if (h.length === 8) {
    a = parseInt(h.slice(0, 2), 16) || 0;
    r = parseInt(h.slice(2, 4), 16) || 0;
    g = parseInt(h.slice(4, 6), 16) || 0;
    b = parseInt(h.slice(6, 8), 16) || 0;
  } else if (h.length === 6) {
    r = parseInt(h.slice(0, 2), 16) || 0;
    g = parseInt(h.slice(2, 4), 16) || 0;
    b = parseInt(h.slice(4, 6), 16) || 0;
  } else if (/^-?\d+$/.test(hex)) {
    return hex; // already int
  } else {
    return hex.startsWith("#") ? hex : `#${hex}`;
  }
  let n = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
  if (n >= 0x80000000) n = n - 0x100000000;
  return String(n);
}

/** Compute official wallpaperFileOffset for attheme (byte index of image after WPS\\n) */
function computeAtthemeWallpaperOffset(colorBodyUtf8: string): number {
  // file = `wallpaperFileOffset=${N}\n` + colorBody + `WPS\n` + image + `\nWPE\n`
  // N = byteLength(offsetLine) + byteLength(colorBody) + 4
  const prefix = "wallpaperFileOffset=";
  const bodyLen = Buffer.byteLength(colorBodyUtf8, "utf-8");
  for (let digits = 1; digits <= 10; digits++) {
    const headerLen = prefix.length + digits + 1; // digits + "\n"
    const N = headerLen + bodyLen + 4; // + "WPS\n"
    if (String(N).length === digits) return N;
  }
  return prefix.length + 5 + 1 + bodyLen + 4;
}

/**
 * Attach wallpaper into Android .attheme bytes (official layout):
 *   wallpaperFileOffset=<N>
 *   key=value lines...
 *   WPS\n
 *   <jpeg/png>
 *   \nWPE\n
 * When no wallpaper: wallpaperFileOffset=-1 (matches BiliBiliDarkByMiku etc.)
 */
function attachAtthemeWallpaper(colorText: string, wallpaper: Buffer | null | undefined): Buffer {
  // Drop any stale offset / empty lines from generator output
  const body = colorText
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (isAtthemeMetaKey(t.split("=")[0] || "")) return false;
      return true;
    })
    .join("\n") + "\n";

  const wp = normalizeWallpaper(wallpaper || null);
  if (!wp) {
    return Buffer.from(`wallpaperFileOffset=-1\n${body}`, "utf-8");
  }
  const offset = computeAtthemeWallpaperOffset(body);
  const header = `wallpaperFileOffset=${offset}\n${body}WPS\n`;
  return Buffer.concat([
    Buffer.from(header, "utf-8"),
    wp,
    Buffer.from("\nWPE\n"),
  ]);
}

/** Build Desktop theme package: ZIP with colors + background when wallpaper present */
function buildDesktopTheme(colorText: string, wallpaper: Buffer | null | undefined, tiled = false): Buffer {
  const colorsBuf = Buffer.from(colorText.endsWith("\n") ? colorText : colorText + "\n", "utf-8");
  const wp = normalizeWallpaper(wallpaper || null);
  if (!wp) {
    // plain palette file is valid for desktop (no chat wallpaper)
    return colorsBuf;
  }
  const ext = detectImageExt(wp) === "png" ? "png" : "jpg";
  const bgName = tiled ? `tiled.${ext}` : `background.${ext}`;
  return makeZip([
    ["colors.tdesktop-theme", colorsBuf],
    [bgName, wp],
  ]);
}

/** Normalize to #RRGGBB / #AARRGGBB for TGX (#-prefixed) */
function toTgxColor(hex: string): string {
  if (!hex || !hex.startsWith("#")) return "#000000";
  const h = hex.slice(1);
  if (h.length === 6) return `#${h.toUpperCase()}`;
  if (h.length === 8) return `#${h.toUpperCase()}`; // already AARRGGBB or RRGGBBAA?
  // our toHex uses #AARRGGBB when alpha < 255
  if (h.length === 8) return `#${h.toUpperCase()}`;
  return `#${h.toUpperCase()}`;
}

/** iOS theme colors: RRGGBB or AARRGGBB (no #), alpha first when present */
function toIosColor(hex: string): string {
  if (!hex) return "000000";
  let h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length === 6) return h.toLowerCase();
  if (h.length === 8) {
    // our internal format is AARRGGBB when alpha present
    return h.toLowerCase();
  }
  if (h.length === 3) return `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
  return "000000";
}

function isDarkHex(hex: string): boolean {
  const rgb = toRgb(hex).slice(1);
  if (rgb.length < 6) return true;
  const r = parseInt(rgb.slice(0, 2), 16);
  const g = parseInt(rgb.slice(2, 4), 16);
  const b = parseInt(rgb.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

function pickColor(colors: Record<string, string>, keys: string[], fallback: string): string {
  for (const k of keys) {
    if (colors[k]) return colors[k];
  }
  return fallback;
}

/** Normalize color key aliases so lookups work across Android/Desktop/TGX/iOS names */
function expandColorAliases(colors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) {
    if (!v || k.startsWith("__") || isAtthemeMetaKey(k)) continue;
    out[k] = v;
  }
  const put = (k: string, v: string) => { if (v && !out[k] && !k.startsWith("__") && !isAtthemeMetaKey(k)) out[k] = v; };

  // Cross-map every known pair both directions
  for (const [a, d] of Object.entries(A2D_MAP)) {
    if (out[a]) put(d, out[a]);
    if (out[d]) put(a, out[d]);
  }
  for (const [a, t] of Object.entries(A2T_MAP)) {
    if (out[a]) put(t, out[a]);
    if (out[t]) put(a, out[t]);
  }
  for (const [a, i] of Object.entries(A2I_MAP)) {
    if (out[a]) put(i, out[a]);
    if (out[i]) put(a, out[i]);
  }

  // Common semantic aliases (fill gaps for generators)
  const aliases: Array<[string, string[]]> = [
    ["windowBackgroundWhite", ["windowBg", "filling", "background", "list.plainBg", "backgroundColor", "chatListBackground"]],
    ["windowBackgroundWhiteBlackText", ["windowFg", "text", "primaryText", "list.primaryText"]],
    ["windowBackgroundWhiteGrayText", ["windowSubTextFg", "textLight", "secondaryText", "list.secondaryText", "icon"]],
    ["windowBackgroundWhiteBlueText", ["primaryColor", "textLink", "accentColor", "list.accent", "progress", "iconActive"]],
    ["windowBackgroundWhiteBlueText4", ["primaryColor", "textLink", "accentColor", "activeButtonFg"]],
    ["actionBarDefault", ["topBarBg", "headerBackground", "root.navBar.background", "navigationBarBackground"]],
    ["actionBarDefaultTitle", ["headerTitle", "navigationBarTitle", "windowFg"]],
    ["actionBarDefaultIcon", ["headerIcon", "menuIconFg", "navigationBarIcons"]],
    ["chat_inBubble", ["msgInBg", "bubbleIn_background", "chatIncomingBubble", "chat.message.incoming.bubble.withoutWp.bg"]],
    ["chat_outBubble", ["msgOutBg", "bubbleOut_background", "chatOutgoingBubble", "chat.message.outgoing.bubble.withoutWp.bg"]],
    ["chat_messageTextIn", ["bubbleIn_text", "chatIncomingText", "historyTextInFg"]],
    ["chat_messageTextOut", ["bubbleOut_text", "chatOutgoingText", "historyTextOutFg"]],
    ["chat_messageLinkIn", ["bubbleIn_textLink", "chatIncomingLink", "historyLinkInFg", "textLink"]],
    ["chat_messageLinkOut", ["bubbleOut_textLink", "chatOutgoingLink", "historyLinkOutFg", "textLink"]],
    ["chat_inTimeText", ["bubbleIn_time", "chatIncomingTime", "msgInDateFg"]],
    ["chat_outTimeText", ["bubbleOut_time", "chatOutgoingTime", "msgOutDateFg"]],
    ["chat_inReplyLine", ["bubbleIn_chatVerticalLine", "chatIncomingReplyLine", "msgInReplyBarFg"]],
    ["chat_outReplyLine", ["bubbleOut_chatVerticalLine", "chatOutgoingReplyLine", "msgOutReplyBarFg"]],
    ["chat_inReplyNameText", ["bubbleIn_messageAuthor", "chatIncomingReplyName", "msgInReplyNameFg"]],
    ["chat_outReplyNameText", ["bubbleOut_messageAuthor", "chatOutgoingReplyName", "msgOutReplyNameFg"]],
    ["chats_name", ["dialogsNameFg", "headerTitle", "chatListName", "chatList.title"]],
    ["chats_message", ["dialogsTextFg", "textLight", "chatListMessage", "chatList.messageText"]],
    ["chats_date", ["dialogsDateFg", "chatListDate", "chatList.dateText"]],
    ["chats_unreadCounter", ["dialogsUnreadBg", "badge", "chatListBadge", "chatList.unreadBadgeActiveBg"]],
    ["chats_unreadCounterMuted", ["dialogsUnreadBgMuted", "badgeMuted", "chatListBadgeMuted"]],
    ["chats_unreadCounterText", ["dialogsUnreadFg", "badge", "chatListBadgeText"]],
    ["chats_sentCheck", ["dialogsSentIconFg", "ticks", "chatListSentIcon"]],
    ["chats_sentCheckRead", ["dialogsSentIconFg", "ticksRead", "chatListReadIcon"]],
    ["chats_draft", ["dialogsDraftFg", "chatListDraft", "chatList.messageDraftText"]],
    ["divider", ["separator", "windowShadowFg", "separatorColor", "list.blocksSeparator"]],
    ["listSelectorSDK21", ["windowBgRipple", "listRipple"]],
    ["switchTrack", ["controlInactive", "switchInactive"]],
    ["switchTrackChecked", ["controlActive", "switchActive"]],
    ["chat_messagePanelBackground", ["chatKeyboard", "keyboardBackground"]],
    ["chat_messagePanelSend", ["historySendIconFg", "chatSendButton", "keyboardSendIcon", "controlActive"]],
    ["chat_messagePanelHint", ["placeholderFg", "textPlaceholder", "keyboardPlaceholder"]],
    ["chat_serviceBackground", ["bubble_date", "chatServiceBackground"]],
    ["chat_serviceText", ["unreadText", "chatServiceText"]],
    ["profile_tabSelectedText", ["headerTabActive", "tabBarActiveIcon", "controlActive"]],
    ["profile_tabSelectedLine", ["headerTabActive", "tabBarActiveLine", "activeLineFg"]],
    ["text_RedRegular", ["attentionButtonFg", "destructiveText", "destructive"]],
    ["player_progress", ["playerProgress", "controlActive"]],
    ["player_progressBackground", ["playerProgressBackground", "waveformInactive"]],
    ["inappPlayerBackground", ["playerBackground", "playerBg"]],
    ["avatar_text", ["avatar_content", "avatarPlaceholderText"]],
  ];
  for (const [canonical, alts] of aliases) {
    if (out[canonical]) {
      for (const a of alts) put(a, out[canonical]);
    } else {
      for (const a of alts) {
        if (out[a]) { put(canonical, out[a]); break; }
      }
      if (out[canonical]) {
        for (const a of alts) put(a, out[canonical]);
      }
    }
  }
  return out;
}

/**
 * Pass through ALL source color keys when converting, remapping known names
 * so we don't drop palette entries that generators don't explicitly list.
 */
/**
 * Merge multiple ThemeDocs into one lossless palette.
 * Later docs fill missing keys only (first-writer-wins for conflicts).
 *
 * IMPORTANT: wallpaper BYTES are intentionally NOT merged here.
 * Desktop wallpapers are often different crops/aspect ratios and must never
 * silently become the shared mobile wallpaper. Callers pick wallpaper via
 * pickMobileWallpaper() / pickDesktopWallpaper() after merge.
 */
function mergeThemeDocs(docs: ThemeDoc[], preferredOrder: ThemeFormat[] = ["attheme", "ios-theme", "tgx-theme", "tdesktop-theme"]): ThemeDoc | null {
  if (!docs.length) return null;
  const ordered = [...docs].sort((a, b) => {
    const ia = preferredOrder.indexOf(a.format);
    const ib = preferredOrder.indexOf(b.format);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const colors: Record<string, string> = {};
  let wallpaperSlug: string | null = null;
  let wallpaperBlur: number | undefined;
  let wallpaperMotion: boolean | undefined;
  let wallpaperIntensity: number | undefined;
  let wallpaperColor: string | null | undefined;
  let wallpaperPattern: string | null | undefined;
  let basedOn: string | null | undefined;
  let format: ThemeFormat = ordered[0].format;

  for (const d of ordered) {
    for (const [k, v] of Object.entries(d.colors || {})) {
      // Never leak internal markers / non-color metadata into merged palette
      if (!v || k.startsWith("__") || isAtthemeMetaKey(k)) continue;
      if (colors[k] === undefined) colors[k] = v;
    }
    // slug/options: mobile-first sources only (never take slug metadata only from desktop)
    if (d.format !== "tdesktop-theme") {
      if (!wallpaperSlug && d.wallpaperSlug) wallpaperSlug = d.wallpaperSlug;
      if (wallpaperBlur == null && d.wallpaperBlur != null) wallpaperBlur = d.wallpaperBlur;
      if (wallpaperMotion == null && d.wallpaperMotion != null) wallpaperMotion = d.wallpaperMotion;
      if (wallpaperIntensity == null && d.wallpaperIntensity != null) wallpaperIntensity = d.wallpaperIntensity;
      if (!wallpaperColor && d.wallpaperColor) wallpaperColor = d.wallpaperColor;
      if (!wallpaperPattern && d.wallpaperPattern) wallpaperPattern = d.wallpaperPattern;
    }
    if (!basedOn && d.basedOn) basedOn = d.basedOn;
  }
  // If no mobile slug, allow desktop-sourced slug only as last resort (rare)
  if (!wallpaperSlug) {
    for (const d of ordered) {
      if (d.wallpaperSlug) { wallpaperSlug = d.wallpaperSlug; break; }
    }
  }
  if (!Object.keys(colors).length && !wallpaperSlug) return null;

  const expanded = expandColorAliases(colors);
  return {
    format,
    colors: expanded,
    // wallpaper bytes left null — selected by pickMobile/DesktopWallpaper
    wallpaper: null,
    wallpaperSlug,
    wallpaperTiled: false,
    wallpaperBlur,
    wallpaperMotion,
    wallpaperIntensity,
    wallpaperColor: wallpaperColor || null,
    wallpaperPattern: wallpaperPattern || null,
    basedOn: basedOn || null,
  };
}

/** Mobile wallpaper priority: Android embed → iOS/TGX resolved bytes → settings.
 *  NEVER Desktop — Desktop crops are landscape and push subject off-screen on mobile.
 *  If Android theme has wallpaperFileOffset=-1 / no WPS, official mobile install
 *  also has NO chat wallpaper (e.g. BiliBiliDarkByMiku). Mirroring that is correct.
 */
function pickMobileWallpaper(
  parsedByFmt: Map<ThemeFormat, ThemeDoc>,
  extras?: { settingsWp?: Buffer | null; extraWp?: Buffer | null },
): { wallpaper: Buffer | null; source: string | null; slug: string | null; blur?: number; motion?: boolean } {
  let slug: string | null = null;
  let blur: number | undefined;
  let motion: boolean | undefined;

  // Collect slug from mobile formats first
  for (const fmt of ["attheme", "ios-theme", "tgx-theme"] as ThemeFormat[]) {
    const d = parsedByFmt.get(fmt);
    if (!d) continue;
    if (!slug && d.wallpaperSlug) slug = d.wallpaperSlug;
    if (blur == null && d.wallpaperBlur != null) blur = d.wallpaperBlur;
    if (motion == null && d.wallpaperMotion != null) motion = d.wallpaperMotion;
  }

  // 1) Android embedded WPS/WPE — absolute priority for mobile
  {
    const d = parsedByFmt.get("attheme");
    const w = normalizeWallpaper(d?.wallpaper || null);
    if (w) return { wallpaper: w, source: "attheme", slug: slug || d?.wallpaperSlug || null, blur, motion };
  }
  // 2) iOS resolved cloud wallpaper bytes
  {
    const d = parsedByFmt.get("ios-theme");
    const w = normalizeWallpaper(d?.wallpaper || null);
    if (w) return { wallpaper: w, source: "ios-theme", slug: slug || d?.wallpaperSlug || null, blur, motion };
  }
  // 3) TGX resolved cloud wallpaper bytes
  {
    const d = parsedByFmt.get("tgx-theme");
    const w = normalizeWallpaper(d?.wallpaper || null);
    if (w) return { wallpaper: w, source: "tgx-theme", slug: slug || d?.wallpaperSlug || null, blur, motion };
  }
  // 4) themeSettings / synthesize extras (cloud accent wallpaper — mobile-correct)
  {
    const w = normalizeWallpaper(extras?.settingsWp || null) || normalizeWallpaper(extras?.extraWp || null);
    if (w) return { wallpaper: w, source: "settings", slug, blur, motion };
  }
  // NO step 5 Desktop — intentional. Desktop background is a different asset.
  return { wallpaper: null, source: null, slug, blur, motion };
}

/** Desktop wallpaper: keep own package image; else fall back to mobile-priority pick */
function pickDesktopWallpaper(
  parsedByFmt: Map<ThemeFormat, ThemeDoc>,
  mobileWp: Buffer | null,
): { wallpaper: Buffer | null; tiled: boolean; source: string | null; keptOwn: boolean } {
  const d = parsedByFmt.get("tdesktop-theme");
  const own = normalizeWallpaper(d?.wallpaper || null);
  if (own) return { wallpaper: own, tiled: !!d?.wallpaperTiled, source: "tdesktop-theme", keptOwn: true };
  if (mobileWp) return { wallpaper: mobileWp, tiled: false, source: "mobile-fallback", keptOwn: false };
  return { wallpaper: null, tiled: false, source: null, keptOwn: false };
}

function remapAllColors(
  colors: Record<string, string>,
  direction: "to-android" | "to-desktop" | "to-tgx" | "to-ios",
): Record<string, string> {
  const src = expandColorAliases(colors);
  const out: Record<string, string> = { ...src };

  const applyMap = (map: Record<string, string>, reverse: boolean) => {
    for (const [from, to] of Object.entries(map)) {
      if (reverse) {
        if (src[to] && !out[from]) out[from] = src[to];
        if (src[from] && !out[to]) out[to] = src[from];
      } else {
        if (src[from] && !out[to]) out[to] = src[from];
        if (src[to] && !out[from]) out[from] = src[to];
      }
    }
  };

  if (direction === "to-android") {
    applyMap(A2D_MAP, true);
    applyMap(A2T_MAP, true);
    applyMap(A2I_MAP, true);
  } else if (direction === "to-desktop") {
    applyMap(A2D_MAP, false);
    applyMap(A2T_MAP, true);
    applyMap(A2I_MAP, true);
  } else if (direction === "to-tgx") {
    applyMap(A2T_MAP, false);
    applyMap(A2D_MAP, true);
    applyMap(A2I_MAP, true);
  } else if (direction === "to-ios") {
    applyMap(A2I_MAP, false);
    applyMap(A2D_MAP, true);
    applyMap(A2T_MAP, true);
  }

  return expandColorAliases(out);
}

// ─── Mapping: Android ↔ Desktop ──────────────────────────────────────────────

const A2D_MAP: Record<string, string> = {
  windowBackgroundWhite: "windowBg",
  windowBackgroundWhiteBlackText: "windowFg",
  windowBackgroundWhiteGrayText: "windowSubTextFg",
  windowBackgroundWhiteGrayText2: "windowSubTextFg",
  windowBackgroundWhiteGrayText3: "windowSubTextFg",
  windowBackgroundWhiteHintText: "placeholderFg",
  windowBackgroundWhiteValueText: "windowBoldFg",
  windowBackgroundWhiteLinkText: "windowActiveTextFg",
  windowBackgroundWhiteBlueText: "windowActiveTextFg",
  windowBackgroundWhiteBlueText2: "windowActiveTextFg",
  windowBackgroundWhiteBlueText3: "windowActiveTextFg",
  windowBackgroundWhiteBlueText4: "activeButtonFg",
  windowBackgroundWhiteBlueText5: "windowActiveTextFg",
  windowBackgroundWhiteBlueText6: "windowActiveTextFg",
  windowBackgroundWhiteBlueText7: "windowActiveTextFg",
  windowBackgroundWhiteBlueButton: "activeButtonBg",
  windowBackgroundWhiteBlueIcon: "windowActiveTextFg",
  windowBackgroundWhiteGreenText: "onlineFg",
  windowBackgroundWhiteGreenText2: "onlineFg",
  windowBackgroundWhiteInputField: "inputBorderFg",
  windowBackgroundWhiteInputFieldActivated: "activeLineFg",
  actionBarDefault: "topBarBg",
  actionBarDefaultIcon: "menuIconFg",
  actionBarDefaultTitle: "windowBoldFg",
  actionBarDefaultSubtitle: "windowSubTextFg",
  actionBarDefaultSearch: "windowFg",
  actionBarDefaultSearchPlaceholder: "placeholderFg",
  actionBarDefaultSelector: "windowBgRipple",
  actionBarActionModeDefault: "topBarBg",
  actionBarActionModeDefaultIcon: "menuIconFg",
  chats_menuBackground: "dialogsBg",
  chats_name: "dialogsNameFg",
  chats_nameMessage: "dialogsTextFgService",
  chats_message: "dialogsTextFg",
  chats_message_threeLines: "dialogsTextFg",
  chats_date: "dialogsDateFg",
  chats_pinnedIcon: "dialogsPinnedIconFg",
  chats_pinnedOverlay: "dialogsPinnedBg",
  chats_tabletSelectedOverlay: "dialogsBgOver",
  chats_unreadCounter: "dialogsUnreadBg",
  chats_unreadCounterMuted: "dialogsUnreadBgMuted",
  chats_unreadCounterText: "dialogsUnreadFg",
  chats_verifiedBackground: "dialogsVerifiedIconBg",
  chats_verifiedCheck: "dialogsVerifiedIconFg",
  chats_muteIcon: "dialogsUnreadBgMuted",
  chats_mentionIcon: "dialogsUnreadBg",
  chats_menuItemIcon: "menuIconFg",
  chats_menuItemText: "menuIconFg",
  chats_menuName: "windowBoldFg",
  chats_menuPhone: "windowSubTextFg",
  chats_menuPhoneCats: "windowSubTextFg",
  chats_menuTopShadow: "windowShadowFg",
  chats_menuTopBackgroundCats: "dialogsBg",
  chats_actionBackground: "activeButtonBg",
  chats_actionPressedBackground: "activeButtonBgOver",
  chats_actionIcon: "windowFgActive",
  chats_sentCheck: "dialogsSentIconFg",
  chats_sentCheckRead: "dialogsSentIconFg",
  chats_sentClock: "dialogsSentIconFg",
  chats_sentError: "dialogsDraftFg",
  chats_sentErrorIcon: "dialogsDraftFg",
  chats_draft: "dialogsDraftFg",
  chats_onlineCircle: "onlineFg",
  chats_secretIcon: "dialogsSentIconFg",
  chats_secretName: "dialogsNameFg",
  avatar_text: "historyPeerUserpicFg",
  avatar_backgroundActionBarBlue: "topBarBg",
  avatar_actionBarSelectorBlue: "windowBgRipple",
  avatar_actionBarIconBlue: "menuIconFg",
  avatar_subtitleInProfileBlue: "windowSubTextFg",
  chat_messagePanelBackground: "historyComposeAreaBg",
  chat_messagePanelHint: "historyComposeAreaFgService",
  chat_messagePanelText: "historyComposeAreaFg",
  chat_messagePanelSend: "historySendIconFg",
  chat_messagePanelIcons: "historyComposeIconFg",
  chat_messagePanelVoiceBackground: "historyComposeIconFg",
  chat_messagePanelVoicePressed: "historyComposeIconFgOver",
  chat_messagePanelCancelInlineBot: "historyComposeIconFg",
  chat_recordedVoicePlayPause: "historyComposeIconFg",
  chat_recordedVoicePlayPausePressed: "historyComposeIconFgOver",
  chat_recordedVoiceDot: "historyComposeIconFg",
  chat_recordedVoiceBackground: "historyComposeAreaBg",
  chat_recordedVoiceProgress: "historySendIconFg",
  chat_recordedVoiceProgressInner: "historyComposeAreaFgService",
  chat_recordTime: "historyComposeAreaFgService",
  chat_recordVoiceCancel: "historyComposeIconFg",
  chat_inBubble: "msgInBg",
  chat_inBubbleSelected: "msgInBgSelected",
  chat_inBubbleShadow: "msgInShadow",
  chat_outBubble: "msgOutBg",
  chat_outBubbleSelected: "msgOutBgSelected",
  chat_outBubbleShadow: "msgOutShadow",
  chat_outBubbleGradient1: "msgOutBg",
  chat_outBubbleGradient2: "msgOutBg",
  chat_outBubbleGradient3: "msgOutBg",
  chat_outBubbleGradientSelectedOverlay: "msgOutBgSelected",
  chat_messageTextIn: "historyTextInFg",
  chat_messageTextOut: "historyTextOutFg",
  chat_messageLinkIn: "historyLinkInFg",
  chat_messageLinkOut: "historyLinkOutFg",
  chat_inReplyNameText: "msgInServiceFg",
  chat_outReplyNameText: "msgOutServiceFg",
  chat_inReplyMessageText: "msgInReplyBarSelFg",
  chat_outReplyMessageText: "msgOutReplyBarSelFg",
  chat_inReplyLine: "msgInReplyBarColor",
  chat_outReplyLine: "msgOutReplyBarColor",
  chat_inReplyMediaMessageText: "msgInDateFg",
  chat_outReplyMediaMessageText: "msgOutDateFg",
  chat_inForwardedNameText: "msgInServiceFg",
  chat_outForwardedNameText: "msgOutServiceFg",
  chat_inViaBotNameText: "msgInServiceFg",
  chat_outViaBotNameText: "msgOutServiceFg",
  chat_inTimeText: "msgInDateFg",
  chat_outTimeText: "msgOutDateFg",
  chat_inTimeSelectedText: "msgInDateFgSelected",
  chat_outTimeSelectedText: "msgOutDateFgSelected",
  chat_inViews: "msgInDateFg",
  chat_outViews: "msgOutDateFg",
  chat_inViewsSelected: "msgInDateFgSelected",
  chat_outViewsSelected: "msgOutDateFgSelected",
  chat_inMenu: "msgInDateFg",
  chat_outMenu: "msgOutDateFg",
  chat_inMenuSelected: "msgInDateFgSelected",
  chat_outMenuSelected: "msgOutDateFgSelected",
  chat_outSentCheck: "historyOutIconFg",
  chat_outSentCheckRead: "historyOutIconFgSelected",
  chat_outSentCheckSelected: "historyOutIconFgSelected",
  chat_outSentCheckReadSelected: "historyOutIconFgSelected",
  chat_outSentClock: "historyOutIconFg",
  chat_inSentClock: "msgInDateFg",
  chat_mediaTimeText: "msgInDateFg",
  chat_mediaSentCheck: "historyOutIconFg",
  chat_mediaProgress: "historyOutIconFg",
  chat_selectedBackground: "msgSelectOverlay",
  chat_status: "windowActiveTextFg",
  chat_muteIcon: "windowSubTextFg",
  chat_goDownButton: "historyToDownBg",
  chat_goDownButtonShadow: "historyToDownShadow",
  chat_goDownButtonIcon: "historyToDownFg",
  chat_goDownButtonCounter: "historyToDownFgOver",
  chat_goDownButtonCounterBackground: "historyToDownBgOver",
  chat_inInstant: "msgInServiceFg",
  chat_outInstant: "msgOutServiceFg",
  chat_inInstantSelected: "msgInServiceFgSelected",
  chat_outInstantSelected: "msgOutServiceFgSelected",
  chat_sentError: "msgInBgSelected",
  chat_sentErrorIcon: "msgInDateFg",
  chat_inAudioSeekbar: "msgInDateFg",
  chat_inAudioSeekbarFill: "msgInServiceFg",
  chat_inAudioSeekbarSelected: "msgInDateFgSelected",
  chat_outAudioSeekbar: "msgOutDateFg",
  chat_outAudioSeekbarFill: "msgOutServiceFg",
  chat_outAudioSeekbarSelected: "msgOutDateFgSelected",
  chat_inVoiceSeekbar: "msgInDateFg",
  chat_inVoiceSeekbarFill: "msgInServiceFg",
  chat_inVoiceSeekbarSelected: "msgInDateFgSelected",
  chat_outVoiceSeekbar: "msgOutDateFg",
  chat_outVoiceSeekbarFill: "msgOutServiceFg",
  chat_outVoiceSeekbarSelected: "msgOutDateFgSelected",
  chat_inFileNameText: "historyTextInFg",
  chat_outFileNameText: "historyTextOutFg",
  chat_inFileInfoText: "msgInDateFg",
  chat_outFileInfoText: "msgOutDateFg",
  chat_inFileProgress: "msgInServiceFg",
  chat_outFileProgress: "msgOutServiceFg",
  chat_inFileBackground: "msgInBg",
  chat_outFileBackground: "msgOutBg",
  chat_inFileBackgroundSelected: "msgInBgSelected",
  chat_outFileBackgroundSelected: "msgOutBgSelected",
  chat_inLoader: "msgInServiceFg",
  chat_outLoader: "msgOutServiceFg",
  chat_inLoaderSelected: "msgInServiceFgSelected",
  chat_outLoaderSelected: "msgOutServiceFgSelected",
  chat_inLoaderPhoto: "msgInServiceFg",
  chat_outLoaderPhoto: "msgOutServiceFg",
  chat_emojiPanelBackground: "emojiPanBg",
  chat_emojiPanelIcon: "emojiPanIconFg",
  chat_emojiPanelIconSelected: "emojiPanIconFgActive",
  chat_emojiPanelStickerPackSelector: "emojiPanBg",
  chat_emojiPanelStickerPackSelectorLine: "activeLineFg",
  chat_emojiPanelBadgeBackground: "emojiPanBadgeBg",
  chat_emojiPanelBadgeText: "emojiPanBadgeFg",
  chat_emojiPanelShadowLine: "windowShadowFg",
  chat_emojiPanelTrendingTitle: "windowBoldFg",
  chat_emojiPanelTrendingDescription: "windowSubTextFg",
  chat_emojiSearchBackground: "windowBgOver",
  chat_emojiSearchIcon: "windowSubTextFg",
  chat_botKeyboardButtonText: "windowFg",
  chat_botKeyboardButtonBackground: "windowBgOver",
  chat_botKeyboardButtonBackgroundPressed: "windowBgRipple",
  chat_botSwitchToInlineText: "windowActiveTextFg",
  chat_unreadMessagesStartBackground: "msgServiceBg",
  chat_unreadMessagesStartText: "msgServiceFg",
  chat_unreadMessagesStartArrowIcon: "msgServiceFg",
  chat_serviceBackground: "msgServiceBg",
  chat_serviceBackgroundSelected: "msgServiceBgSelected",
  chat_serviceText: "msgServiceFg",
  chat_serviceLink: "msgServiceFg",
  chat_serviceIcon: "msgServiceFg",
  chat_topPanelBackground: "topBarBg",
  chat_topPanelLine: "activeLineFg",
  chat_topPanelTitle: "windowBoldFg",
  chat_topPanelMessage: "windowSubTextFg",
  chat_topPanelClose: "menuIconFg",
  chat_wallpaper: "windowBg",
  chat_wallpaper_temp: "windowBg",
  profile_tabSelectedText: "activeButtonFg",
  profile_tabSelectedLine: "activeLineFg",
  profile_tabText: "windowSubTextFg",
  profile_tabSelector: "windowBgRipple",
  profile_actionBackground: "activeButtonBg",
  profile_actionIcon: "windowFgActive",
  profile_actionPressedBackground: "activeButtonBgOver",
  profile_verifiedBackground: "dialogsVerifiedIconBg",
  profile_verifiedCheck: "dialogsVerifiedIconFg",
  profile_title: "windowBoldFg",
  profile_creatorIcon: "windowActiveTextFg",
  profile_status: "windowSubTextFg",
  calls_callReceivedGreenIcon: "callsReceivedFg",
  calls_callReceivedRedIcon: "callsMissedFg",
  inappPlayerBackground: "playerBg",
  inappPlayerPlayPause: "playerButtonActive",
  inappPlayerClose: "playerButton",
  inappPlayerPerformer: "playerTitleFg",
  inappPlayerTitle: "playerTitleFg",
  player_progress: "playerProgressFg",
  player_progressBackground: "playerProgressBg",
  player_progressCachedBackground: "playerProgressBg",
  player_button: "playerButton",
  player_buttonActive: "playerButtonActive",
  player_time: "playerTimeFg",
  player_placeholder: "playerPlaceholderFg",
  player_placeholderBackground: "playerBg",
  player_background: "playerBg",
  switchTrack: "windowSubTextFg",
  switchTrackChecked: "activeButtonBg",
  switchTrackBlue: "windowSubTextFg",
  switchTrackBlueChecked: "activeButtonBg",
  switchTrackBlueThumb: "windowBg",
  switchTrackBlueThumbChecked: "windowFgActive",
  switchTrackBlueSelector: "windowBgRipple",
  switchTrackBlueSelectorChecked: "windowBgRipple",
  featuredStickers_addButton: "activeButtonBg",
  featuredStickers_addButtonPressed: "activeButtonBgOver",
  featuredStickers_addedIcon: "activeButtonFg",
  featuredStickers_buttonProgress: "windowFgActive",
  featuredStickers_buttonText: "windowFgActive",
  featuredStickers_unread: "dialogsUnreadBg",
  text_RedRegular: "attentionButtonFg",
  text_RedBold: "attentionButtonFg",
  key_graySection: "windowBgOver",
  key_graySectionText: "windowSubTextFg",
  key_radioBackground: "windowSubTextFg",
  key_radioBackgroundChecked: "activeButtonBg",
  checkbox: "activeButtonBg",
  checkboxCheck: "windowFgActive",
  checkboxDisabled: "windowSubTextFg",
  checkboxSquareBackground: "activeButtonBg",
  checkboxSquareCheck: "windowFgActive",
  checkboxSquareUnchecked: "windowSubTextFg",
  checkboxSquareDisabled: "windowSubTextFg",
  dialogBackground: "boxBg",
  dialogBackgroundGray: "boxBg",
  dialogTextBlack: "boxTextFg",
  dialogTextGray: "boxTextFg2",
  dialogTextGray2: "boxTextFg2",
  dialogTextGray3: "boxTextFg2",
  dialogTextHint: "placeholderFg",
  dialogTextLink: "windowActiveTextFg",
  dialogTextBlue: "windowActiveTextFg",
  dialogTextBlue2: "windowActiveTextFg",
  dialogTextBlue4: "windowActiveTextFg",
  dialogButton: "windowActiveTextFg",
  dialogButtonSelector: "windowBgRipple",
  dialogIcon: "boxTextFg2",
  dialogGrayLine: "boxTextFg2",
  dialogScrollGlow: "windowBg",
  dialogRoundCheckBox: "activeButtonBg",
  dialogRoundCheckBoxCheck: "windowFgActive",
  dialogRadioBackground: "windowSubTextFg",
  dialogRadioBackgroundChecked: "activeButtonBg",
  dialogLineProgress: "activeButtonBg",
  dialogLineProgressBackground: "windowBgOver",
  dialogInputField: "inputBorderFg",
  dialogInputFieldActivated: "activeLineFg",
  dialogCheckboxSquareBackground: "activeButtonBg",
  dialogCheckboxSquareCheck: "windowFgActive",
  dialogCheckboxSquareUnchecked: "windowSubTextFg",
  dialogCheckboxSquareDisabled: "windowSubTextFg",
  dialogSearchBackground: "windowBgOver",
  dialogSearchHint: "placeholderFg",
  dialogSearchIcon: "windowSubTextFg",
  dialogSearchText: "windowFg",
  dialogFloatingButton: "activeButtonBg",
  dialogFloatingButtonPressed: "activeButtonBgOver",
  dialogFloatingIcon: "windowFgActive",
  dialogShadowLine: "windowShadowFg",
  dialogTopBackground: "topBarBg",
  progressCircle: "activeButtonBg",
  divider: "windowShadowFg",
  listSelectorSDK21: "windowBgRipple",
  emptyListPlaceholder: "windowSubTextFg",
  fastScrollActive: "activeButtonBg",
  fastScrollInactive: "windowSubTextFg",
  fastScrollText: "windowFgActive",
  contextProgressInner1: "windowSubTextFg",
  contextProgressOuter1: "activeButtonBg",
  undo_background: "toastBg",
  undo_cancelColor: "toastFg",
  undo_infoColor: "toastFg",
};
const D2A_MAP: Record<string, string> = {};
for (const [a, d] of Object.entries(A2D_MAP)) D2A_MAP[d] = a;

// ─── Mapping: Android ↔ TGX ─────────────────────────────────────────────────

const A2T_MAP: Record<string, string> = {
  windowBackgroundWhite: "filling",
  windowBackgroundWhiteBlackText: "text",
  windowBackgroundWhiteGrayText: "textLight",
  windowBackgroundWhiteGrayText2: "textPlaceholder",
  windowBackgroundWhiteHintText: "textPlaceholder",
  windowBackgroundWhiteValueText: "text",
  windowBackgroundWhiteLinkText: "textLink",
  windowBackgroundWhiteBlueText: "textLink",
  windowBackgroundWhiteBlueText2: "textLink",
  windowBackgroundWhiteBlueText3: "textLink",
  windowBackgroundWhiteBlueText4: "controlActive",
  windowBackgroundWhiteBlueText5: "textLink",
  windowBackgroundWhiteBlueText6: "textLink",
  windowBackgroundWhiteBlueText7: "textLink",
  windowBackgroundWhiteBlueButton: "controlActive",
  windowBackgroundWhiteBlueIcon: "iconActive",
  windowBackgroundWhiteGreenText: "textNeutral",
  windowBackgroundWhiteInputField: "inputInactive",
  windowBackgroundWhiteInputFieldActivated: "inputActive",
  actionBarDefault: "headerBackground",
  actionBarDefaultTitle: "headerTitle",
  actionBarDefaultIcon: "headerIcon",
  actionBarDefaultSubtitle: "headerText",
  actionBarDefaultSearch: "headerText",
  actionBarDefaultSearchPlaceholder: "textPlaceholder",
  actionBarDefaultSelector: "headerBackground",
  profile_tabSelectedLine: "headerTabActive",
  profile_tabSelectedText: "headerTabActiveText",
  profile_tabText: "headerTabInactiveText",
  profile_actionBackground: "controlActive",
  profile_actionIcon: "controlContent",
  switchTrack: "controlInactive",
  switchTrackChecked: "controlActive",
  chats_menuBackground: "drawer",
  chats_name: "text",
  chats_message: "textLight",
  chats_date: "textLight",
  chats_unreadCounter: "badge",
  chats_unreadCounterMuted: "badgeMuted",
  chats_unreadCounterText: "badgeText",
  chats_sentCheck: "ticks",
  chats_sentCheckRead: "ticksRead",
  chats_draft: "textNegative",
  chats_actionBackground: "controlActive",
  chats_actionIcon: "controlContent",
  chats_menuItemIcon: "icon",
  chats_menuItemText: "text",
  chats_onlineCircle: "online",
  chats_muteIcon: "icon",
  chats_verifiedBackground: "chatListVerify",
  chats_verifiedCheck: "controlContent",
  avatar_text: "avatar_content",
  chat_goDownButton: "circleButtonChat",
  chat_goDownButtonIcon: "circleButtonChatIcon",
  chat_goDownButtonCounter: "controlContent",
  chat_goDownButtonCounterBackground: "badge",
  chat_messagePanelBackground: "chatKeyboard",
  chat_messagePanelHint: "textPlaceholder",
  chat_messagePanelText: "text",
  chat_messagePanelSend: "chatSendButton",
  chat_messagePanelIcons: "icon",
  chat_inBubble: "bubbleIn_background",
  chat_outBubble: "bubbleOut_background",
  chat_inBubbleSelected: "bubbleIn_pressed",
  chat_outBubbleSelected: "bubbleOut_pressed",
  chat_messageTextIn: "bubbleIn_text",
  chat_messageTextOut: "bubbleOut_text",
  chat_messageLinkIn: "bubbleIn_textLink",
  chat_messageLinkOut: "bubbleOut_textLink",
  chat_inReplyLine: "bubbleIn_chatVerticalLine",
  chat_outReplyLine: "bubbleOut_chatVerticalLine",
  chat_inReplyNameText: "bubbleIn_messageAuthor",
  chat_outReplyNameText: "bubbleOut_messageAuthor",
  chat_inReplyMessageText: "bubbleIn_text",
  chat_outReplyMessageText: "bubbleOut_text",
  chat_inTimeText: "bubbleIn_time",
  chat_outTimeText: "bubbleOut_time",
  chat_inViews: "bubbleIn_time",
  chat_outViews: "bubbleOut_time",
  chat_outSentCheck: "ticks",
  chat_outSentCheckRead: "ticksRead",
  chat_selectedBackground: "bubble_messageSelection",
  chat_serviceBackground: "bubble_date",
  chat_serviceText: "bubble_dateText",
  chat_serviceLink: "textLink",
  chat_status: "textLink",
  chat_muteIcon: "icon",
  chat_inInstant: "bubbleIn_textLink",
  chat_outInstant: "bubbleOut_textLink",
  chat_inAudioSeekbar: "bubbleIn_waveformInactive",
  chat_inAudioSeekbarFill: "bubbleIn_waveformActive",
  chat_outAudioSeekbar: "bubbleOut_waveformInactive",
  chat_outAudioSeekbarFill: "bubbleOut_waveformActive",
  chat_inVoiceSeekbar: "bubbleIn_waveformInactive",
  chat_inVoiceSeekbarFill: "bubbleIn_waveformActive",
  chat_outVoiceSeekbar: "bubbleOut_waveformInactive",
  chat_outVoiceSeekbarFill: "bubbleOut_waveformActive",
  chat_inFileNameText: "bubbleIn_text",
  chat_outFileNameText: "bubbleOut_text",
  chat_inFileInfoText: "bubbleIn_time",
  chat_outFileInfoText: "bubbleOut_time",
  chat_inLoader: "bubbleIn_progress",
  chat_outLoader: "bubbleOut_progress",
  chat_emojiPanelBackground: "chatKeyboard",
  chat_emojiPanelIcon: "icon",
  chat_emojiPanelIconSelected: "iconActive",
  chat_emojiPanelBadgeBackground: "badge",
  chat_emojiPanelBadgeText: "badgeText",
  chat_topPanelBackground: "headerBackground",
  chat_topPanelTitle: "headerTitle",
  chat_topPanelMessage: "headerText",
  chat_topPanelClose: "headerIcon",
  chat_topPanelLine: "headerTabActive",
  inappPlayerBackground: "playerBackground",
  inappPlayerPlayPause: "playerButton",
  inappPlayerTitle: "playerTitle",
  inappPlayerPerformer: "playerSubtitle",
  inappPlayerClose: "playerButton",
  player_progress: "playerProgress",
  player_progressBackground: "playerProgressBackground",
  player_button: "playerButton",
  player_buttonActive: "playerButtonActive",
  player_time: "playerTime",
  divider: "separator",
  listSelectorSDK21: "fillingPressed",
  text_RedRegular: "textNegative",
  progressCircle: "progress",
  dialogBackground: "overlayFilling",
  dialogTextBlack: "text",
  dialogTextLink: "textLink",
  dialogButton: "textLink",
  dialogIcon: "icon",
  dialogSearchBackground: "filling",
  dialogSearchText: "text",
  dialogSearchHint: "textPlaceholder",
  dialogSearchIcon: "icon",
  dialogFloatingButton: "controlActive",
  dialogFloatingIcon: "controlContent",
  featuredStickers_addButton: "controlActive",
  calls_callReceivedGreenIcon: "textNeutral",
  calls_callReceivedRedIcon: "textNegative",
  // desktop-specific fallbacks
  windowBg: "filling",
  windowFg: "text",
  windowSubTextFg: "textLight",
  windowBoldFg: "text",
  windowActiveTextFg: "textLink",
  primaryColor: "controlActive",
  topBarBg: "headerBackground",
  msgInBg: "bubbleIn_background",
  msgOutBg: "bubbleOut_background",
  msgInBgSelected: "bubbleIn_pressed",
  msgOutBgSelected: "bubbleOut_pressed",
  historyTextInFg: "bubbleIn_text",
  historyTextOutFg: "bubbleOut_text",
  historyLinkInFg: "bubbleIn_textLink",
  historyLinkOutFg: "bubbleOut_textLink",
  dialogsBg: "chatListBackground",
  dialogsNameFg: "text",
  dialogsTextFg: "textLight",
  dialogsDateFg: "textLight",
  dialogsUnreadBg: "badge",
  dialogsUnreadBgMuted: "badgeMuted",
  dialogsUnreadFg: "badgeText",
  dialogsSentIconFg: "ticks",
  dialogsDraftFg: "textNegative",
  activeButtonBg: "controlActive",
  activeButtonFg: "controlContent",
  historySendIconFg: "chatSendButton",
  menuIconFg: "headerIcon",
  placeholderFg: "textPlaceholder",
  playerBg: "playerBackground",
  playerProgressFg: "playerProgress",
  playerTitleFg: "playerTitle",
  msgServiceBg: "bubble_date",
  msgServiceFg: "bubble_dateText",
  onlineFg: "online",
  attentionButtonFg: "textNegative",
};
const T2A_MAP: Record<string, string> = {};
for (const [a, t] of Object.entries(A2T_MAP)) T2A_MAP[t] = a;

// ─── Mapping: Android ↔ iOS ─────────────────────────────────────────────────

const A2I_MAP: Record<string, string> = {
  windowBackgroundWhite: "backgroundColor",
  actionBarDefault: "navigationBarBackground",
  actionBarDefaultTitle: "navigationBarTitle",
  actionBarDefaultIcon: "navigationBarIcons",
  actionBarDefaultSubtitle: "navigationBarSubtitle",
  chats_menuBackground: "chatListBackground",
  chats_name: "chatListName",
  chats_message: "chatListMessage",
  chats_date: "chatListDate",
  chats_unreadCounter: "chatListBadge",
  chats_unreadCounterText: "chatListBadgeText",
  chats_unreadCounterMuted: "chatListBadgeMuted",
  chats_sentCheck: "chatListSentIcon",
  chats_sentCheckRead: "chatListReadIcon",
  chats_draft: "chatListDraft",
  chat_inBubble: "chatIncomingBubble",
  chat_inBubbleSelected: "chatIncomingBubbleSelected",
  chat_outBubble: "chatOutgoingBubble",
  chat_outBubbleSelected: "chatOutgoingBubbleSelected",
  chat_messageTextIn: "chatIncomingText",
  chat_messageTextOut: "chatOutgoingText",
  chat_messageLinkIn: "chatIncomingLink",
  chat_messageLinkOut: "chatOutgoingLink",
  chat_inReplyLine: "chatIncomingReplyLine",
  chat_outReplyLine: "chatOutgoingReplyLine",
  chat_inReplyNameText: "chatIncomingReplyName",
  chat_outReplyNameText: "chatOutgoingReplyName",
  chat_inReplyMessageText: "chatIncomingReplyMessage",
  chat_outReplyMessageText: "chatOutgoingReplyMessage",
  chat_inTimeText: "chatIncomingTime",
  chat_outTimeText: "chatOutgoingTime",
  chat_inViews: "chatIncomingViews",
  chat_outViews: "chatOutgoingViews",
  chat_status: "chatStatus",
  chat_selectedBackground: "chatSelectionBackground",
  chat_goDownButton: "chatJumpButtonBackground",
  chat_goDownButtonIcon: "chatJumpButtonIcon",
  chat_serviceBackground: "chatServiceBackground",
  chat_serviceText: "chatServiceText",
  chat_serviceLink: "chatServiceLink",
  chat_messagePanelBackground: "keyboardBackground",
  chat_messagePanelText: "keyboardText",
  chat_messagePanelSend: "keyboardSendIcon",
  chat_messagePanelHint: "keyboardPlaceholder",
  chat_emojiPanelBackground: "keyboardBackground",
  chat_emojiPanelIcon: "keyboardIcon",
  chat_emojiPanelIconSelected: "keyboardActiveIcon",
  chat_emojiPanelBadgeBackground: "keyboardBadge",
  chat_emojiPanelBadgeText: "keyboardBadgeText",
  profile_tabSelectedText: "tabBarActiveIcon",
  profile_tabSelectedLine: "tabBarActiveLine",
  profile_tabText: "tabBarIcon",
  profile_actionBackground: "tabBarBackground",
  avatar_text: "avatarPlaceholderText",
  avatar_backgroundActionBarBlue: "navigationBarBackground",
  switchTrack: "switchInactive",
  switchTrackChecked: "switchActive",
  player_progress: "playerProgress",
  player_progressBackground: "playerProgressBackground",
  inappPlayerBackground: "playerBackground",
  inappPlayerPlayPause: "playerIcon",
  text_RedRegular: "destructiveText",
  divider: "separatorColor",
  listSelectorSDK21: "listRipple",
  featuredStickers_addButton: "accentColor",
  windowBackgroundWhiteBlackText: "primaryText",
  windowBackgroundWhiteGrayText: "secondaryText",
  windowBackgroundWhiteGrayText2: "secondaryText",
  windowBackgroundWhiteBlueText4: "accentColor",
  chats_actionBackground: "accentColor",
  chats_actionIcon: "accentIcon",
  chat_inInstant: "accentColor",
  chat_outInstant: "accentColor",
  chat_inAudioSeekbar: "playerProgressBackground",
  chat_inAudioSeekbarFill: "playerProgress",
  chat_outAudioSeekbar: "playerProgressBackground",
  chat_outAudioSeekbarFill: "playerProgress",
  chat_inVoiceSeekbar: "playerProgressBackground",
  chat_inVoiceSeekbarFill: "playerProgress",
  chat_outVoiceSeekbar: "playerProgressBackground",
  chat_outVoiceSeekbarFill: "playerProgress",
  calls_callReceivedGreenIcon: "callGreenIcon",
  calls_callReceivedRedIcon: "callRedIcon",
  // desktop fallbacks
  windowBg: "backgroundColor",
  windowFg: "primaryText",
  windowSubTextFg: "secondaryText",
  topBarBg: "navigationBarBackground",
  dialogsBg: "chatListBackground",
  dialogsNameFg: "chatListName",
  dialogsUnreadBg: "chatListBadge",
  dialogsUnreadBgMuted: "chatListBadgeMuted",
  dialogsUnreadFg: "chatListBadgeText",
  primaryColor: "accentColor",
  activeButtonBg: "accentColor",
  activeButtonFg: "accentIcon",
  msgInBg: "chatIncomingBubble",
  msgOutBg: "chatOutgoingBubble",
  msgInBgSelected: "chatIncomingBubbleSelected",
  msgOutBgSelected: "chatOutgoingBubbleSelected",
  menuIconFg: "navigationBarIcons",
  placeholderFg: "keyboardPlaceholder",
  historySendIconFg: "keyboardSendIcon",
};
const I2A_MAP: Record<string, string> = {};
for (const [a, i] of Object.entries(A2I_MAP)) I2A_MAP[i] = a;

// ─── Generic map helper ──────────────────────────────────────────────────────

// ─── Generators ──────────────────────────────────────────────────────────────

function genDesktop(
  colors: Record<string, string>,
  wallpaperSlug?: string | null,
  tiled = false,
): string {
  const cx = remapAllColors(colors, "to-desktop");
  const f = (ak: string, fb: string) => cx[A2D_MAP[ak] || ak] || cx[ak] || fb;
  const p = toRgb(f("windowBackgroundWhiteBlueText", "#6750a4"));
  const bg = toRgb(f("windowBackgroundWhite", "#1c1b1f"));
  const t = toRgb(f("windowBackgroundWhiteBlackText", "#e6e1e5"));
  const st = toRgb(f("windowBackgroundWhiteGrayText", "#938f96"));
  const mi = cx["msgInBg"] || cx["chat_inBubble"] || "#2b2930";
  const mo = cx["msgOutBg"] || cx["chat_outBubble"] || p;
  const tb = cx["topBarBg"] || cx["actionBarDefault"] || bg;
  const cl = cx["dialogsBg"] || cx["chats_menuBackground"] || bg;
  const dest = cx["text_RedRegular"] || "#f44336";
  const green = cx["calls_callReceivedGreenIcon"] || "#4caf50";
  const lines = [
    `// TeleBox Desktop theme`,
    `primaryColor: ${p};`,
    `primaryDark: ${bg};`,
    `primaryText: ${t};`,
    `secondaryText: ${st};`,
    `windowBg: primaryDark;`,
    `windowFg: primaryText;`,
    `windowSubTextFg: secondaryText;`,
    `windowBoldFg: primaryText;`,
    `windowActiveTextFg: primaryColor;`,
    `topBarBg: ${toRgb(tb)};`,
    `dialogsBg: ${toRgb(cl)};`,
    `msgInBg: ${toRgb(mi)};`,
    `msgOutBg: ${toRgb(mo)};`,
  ];
  // Official Desktop can reference cloud wallpaper when package has no background.jpg
  if (wallpaperSlug && wallpaperSlug.length > 4) {
    const mode = tiled ? "?mode=tiled" : "";
    lines.push(`wallpaper: https://t.me/bg/${wallpaperSlug}${mode};`);
  }
  // Keep rest of palette via spillover from existing body — call original structure
  // by appending known desktop keys from a second pass through genDesktopCore
  const core = genDesktopCore(colors);
  // Merge: wallpaper line already added; append core lines skipping duplicates
  const known = new Set<string>();
  for (const l of lines) {
    for (const part of l.split(";")) {
      const col = part.indexOf(":");
      if (col > 0) known.add(part.slice(0, col).trim());
    }
  }
  for (const l of core.split("\n")) {
    const s = l.trim();
    if (!s || s.startsWith("//")) { lines.push(l); continue; }
    let skip = false;
    for (const part of s.split(";")) {
      const col = part.indexOf(":");
      if (col > 0) {
        const k = part.slice(0, col).trim();
        if (known.has(k)) { skip = true; break; }
      }
    }
    if (!skip) {
      lines.push(l);
      for (const part of s.split(";")) {
        const col = part.indexOf(":");
        if (col > 0) known.add(part.slice(0, col).trim());
      }
    }
  }
  return lines.join("\n");
}

/** Original desktop palette body (no wallpaper meta) */
function genDesktopCore(colors: Record<string, string>): string {
  const cx = remapAllColors(colors, "to-desktop");
  const f = (ak: string, fb: string) => cx[A2D_MAP[ak] || ak] || cx[ak] || fb;
  const p = toRgb(f("windowBackgroundWhiteBlueText", "#6750a4"));
  const bg = toRgb(f("windowBackgroundWhite", "#1c1b1f"));
  const t = toRgb(f("windowBackgroundWhiteBlackText", "#e6e1e5"));
  const st = toRgb(f("windowBackgroundWhiteGrayText", "#938f96"));
  const mi = cx["msgInBg"] || cx["chat_inBubble"] || "#2b2930";
  const mo = cx["msgOutBg"] || cx["chat_outBubble"] || p;
  const tb = cx["topBarBg"] || cx["actionBarDefault"] || bg;
  const cl = cx["dialogsBg"] || cx["chats_menuBackground"] || bg;
  const dest = cx["text_RedRegular"] || "#f44336";
  const green = cx["calls_callReceivedGreenIcon"] || "#4caf50";
  // Continue with the existing genDesktop body — we rename old function content here
  // by reading that the old genDesktop started at primaryColor; keep full original lines
  // For safety, call into the previous implementation via duplicated spillover path:
  // We'll rebuild using the previous function name body that still exists until we replace it.
  // Actually the old function is being replaced — include full lines from the previous read.
  const lines = [
    `primaryColor: ${p};`,
    `primaryDark: ${bg};`,
    `primaryText: ${t};`,
    `secondaryText: ${st};`,
    `windowBg: primaryDark; windowFg: primaryText; windowSubTextFg: secondaryText;`,
    `topBarBg: ${toRgb(tb)};`,
    `dialogsBg: ${toRgb(cl)}; dialogsNameFg: primaryText; dialogsTextFg: secondaryText;`,
    `dialogsDateFg: secondaryText; dialogsUnreadBg: primaryColor; dialogsUnreadFg: #ffffff;`,
    `msgInBg: ${toRgb(mi)}; msgOutBg: ${toRgb(mo)};`,
    `historyComposeAreaBg: primaryDark; historyComposeAreaFg: primaryText;`,
    `activeButtonBg: primaryColor; activeButtonFg: #ffffff;`,
    `placeholderFg: secondaryText; menuIconFg: primaryColor;`,
    `inputBorderFg: secondaryText; activeLineFg: primaryColor;`,
    `onlineFg: ${green};`,
    `windowBoldFg: primaryText; windowActiveTextFg: primaryColor;`,
    `historyOutIconFg: primaryColor;`,
    `msgInBgSelected: ${adjustBright(mi, 15)}; msgOutBgSelected: ${adjustBright(mo, 15)};`,
    `sideBarBg: ${adjustBright(bg, -5)}; sideBarBgActive: primaryColor;`,
    `sideBarTextFg: secondaryText; sideBarTextFgActive: #ffffff; sideBarIconFgActive: #ffffff;`,
    `scrollBarBg: ${p}80; scrollBarBgOver: primaryColor;`,
    `playerBg: primaryDark; playerTitleFg: primaryText; playerProgressFg: primaryColor;`,
    `callsBg: primaryDark; callsNameFg: primaryText;`,
    `callsReceivedFg: ${green}; callsMissedFg: ${dest};`,
    `dialogsPinnedIconFg: primaryColor; dialogsPinnedBg: ${p}3c;`,
    `dialogsVerifiedIconBg: primaryColor; dialogsVerifiedIconFg: #ffffff;`,
    `windowShadowFg: 00000000;`,
    `msgInReplyBarColor: primaryColor; msgOutReplyBarColor: primaryColor;`,
    `historyPeerUserpicFg: primaryText;`,
    `historyToDownShadow: 00000000;`,
    `msgInShadow: ${bg}; msgOutShadow: ${bg};`,
  ];
  const known = new Set<string>();
  for (const l of lines) {
    for (const part of l.split(";")) {
      const col = part.indexOf(":");
      if (col > 0) known.add(part.slice(0, col).trim());
    }
  }
  for (const [k, v] of Object.entries(cx)) {
    const hex = toRgb(v);
    if (!known.has(k) && hex && !k.includes(".") && !k.startsWith("__") && !isAtthemeMetaKey(k)) {
      lines.push(`${k}: ${hex};`);
      known.add(k);
    }
  }
  return lines.join("\n");
}
function genAndroid(colors: Record<string, string>): string[] {
  const cx = remapAllColors(colors, "to-android");
  const f = (dk: string, fb: string) => cx[D2A_MAP[dk] || dk] || cx[dk] || fb;
  const p = toRgb(f("primaryColor", "#6750a4"));
  const bg = toRgb(f("windowBg", "#1c1b1f"));
  const t = toRgb(f("windowFg", "#e6e1e5"));
  const st = toRgb(f("windowSubTextFg", "#938f96"));
  const mi = cx["msgInBg"] || "#2b2930";
  const mo = cx["msgOutBg"] || p;
  const tb = cx["topBarBg"] || bg;
  const dark = isDarkHex(bg);
  const r: Record<string, string> = {};
  const set = (k: string, v: string) => { r[k] = v; };
  // Base explicit derived values
  set("windowBackgroundWhite", bg); set("windowBackgroundWhiteBlackText", t);
  set("windowBackgroundWhiteGrayText", st); set("windowBackgroundWhiteGrayText2", st);
  set("windowBackgroundWhiteGrayText3", st); set("windowBackgroundWhiteHintText", st);
  set("windowBackgroundWhiteValueText", t); set("windowBackgroundWhiteLinkText", p);
  set("windowBackgroundWhiteBlueText", p); set("windowBackgroundWhiteBlueText2", p);
  set("windowBackgroundWhiteBlueText3", p); set("windowBackgroundWhiteBlueText4", p);
  set("windowBackgroundWhiteBlueText5", p); set("windowBackgroundWhiteBlueText6", p);
  set("windowBackgroundWhiteBlueText7", p); set("windowBackgroundWhiteBlueButton", p);
  set("windowBackgroundWhiteBlueIcon", p); set("windowBackgroundWhiteGreenText", "#4caf50");
  set("windowBackgroundWhiteGreenText2", "#4caf50"); set("windowBackgroundWhiteInputField", bg + "3c");
  set("windowBackgroundWhiteInputFieldActivated", p); set("divider", bg + "3c");
  set("listSelectorSDK21", p + "1a"); set("actionBarDefault", tb);
  set("actionBarDefaultIcon", p); set("actionBarDefaultTitle", t);
  set("actionBarDefaultSubtitle", st); set("actionBarDefaultSearch", t);
  set("actionBarDefaultSearchPlaceholder", st); set("actionBarDefaultSelector", p + "1a");
  set("actionBarActionModeDefault", tb); set("actionBarActionModeDefaultIcon", p);
  set("chats_menuBackground", bg); set("chats_name", t); set("chats_nameMessage", p);
  set("chats_message", st); set("chats_message_threeLines", st); set("chats_date", st);
  set("chats_pinnedIcon", p); set("chats_pinnedOverlay", p + "3c");
  set("chats_tabletSelectedOverlay", p + "1a"); set("chats_unreadCounter", p);
  set("chats_unreadCounterMuted", st); set("chats_unreadCounterText", "#ffffff");
  set("chats_verifiedBackground", p); set("chats_verifiedCheck", "#ffffff");
  set("chats_muteIcon", st); set("chats_mentionIcon", p); set("chats_sentCheck", p);
  set("chats_sentCheckRead", p); set("chats_sentClock", st); set("chats_sentError", "#f44336");
  set("chats_sentErrorIcon", "#f44336"); set("chats_draft", "#f44336");
  set("chats_onlineCircle", "#4caf50"); set("chats_secretIcon", p);
  set("chats_secretName", t); set("chats_menuItemIcon", p);
  set("chats_menuItemText", t); set("chats_menuName", t); set("chats_menuPhone", st);
  set("chats_menuPhoneCats", st); set("chats_menuTopShadow", "00000000");
  set("chats_menuTopBackgroundCats", bg); set("chats_actionBackground", p);
  set("chats_actionPressedBackground", adjustBright(p, 10)); set("chats_actionIcon", "#ffffff");
  set("avatar_text", t); set("avatar_backgroundActionBarBlue", tb);
  set("avatar_actionBarSelectorBlue", p + "1a"); set("avatar_actionBarIconBlue", p);
  set("avatar_subtitleInProfileBlue", st); set("avatar_backgroundRed", "#f44336");
  set("avatar_backgroundGreen", "#4caf50"); set("avatar_backgroundBlue", p);
  set("avatar_backgroundOrange", "#ff9800"); set("avatar_nameInMessageRed", t);
  set("avatar_nameInMessageGreen", t); set("avatar_nameInMessageBlue", t);
  set("avatar_nameInMessageOrange", t); set("avatar_backgroundInProfileRed", "#f44336");
  set("chat_messagePanelBackground", bg); set("chat_messagePanelHint", st);
  set("chat_messagePanelText", t); set("chat_messagePanelSend", p);
  set("chat_messagePanelIcons", p); set("chat_messagePanelVoiceBackground", p);
  set("chat_messagePanelVoicePressed", adjustBright(p, 15));
  set("chat_messagePanelCancelInlineBot", st);
  set("chat_recordedVoicePlayPause", p); set("chat_recordedVoicePlayPausePressed", adjustBright(p, 15));
  set("chat_recordedVoiceDot", "#f44336"); set("chat_recordedVoiceBackground", bg);
  set("chat_recordedVoiceProgress", p); set("chat_recordedVoiceProgressInner", st);
  set("chat_recordTime", st); set("chat_recordVoiceCancel", st);
  set("chat_inBubble", mi); set("chat_inBubbleSelected", adjustBright(mi, 15));
  set("chat_inBubbleShadow", bg); set("chat_outBubble", mo);
  set("chat_outBubbleSelected", adjustBright(mo, 15)); set("chat_outBubbleShadow", bg);
  set("chat_outBubbleGradient1", mo); set("chat_outBubbleGradient2", mo);
  set("chat_outBubbleGradient3", mo); set("chat_outBubbleGradientSelectedOverlay", adjustBright(mo, 15));
  set("chat_messageTextIn", t); set("chat_messageTextOut", t);
  set("chat_messageLinkIn", p); set("chat_messageLinkOut", p);
  set("chat_inReplyLine", p); set("chat_outReplyLine", p);
  set("chat_inReplyNameText", p); set("chat_outReplyNameText", p);
  set("chat_inReplyMessageText", st); set("chat_outReplyMessageText", st);
  set("chat_inReplyMediaMessageText", st); set("chat_outReplyMediaMessageText", st);
  set("chat_inForwardedNameText", p); set("chat_outForwardedNameText", p);
  set("chat_inViaBotNameText", p); set("chat_outViaBotNameText", p);
  set("chat_inTimeText", st); set("chat_outTimeText", st);
  set("chat_inTimeSelectedText", adjustBright(st, 15)); set("chat_outTimeSelectedText", adjustBright(st, 15));
  set("chat_inViews", st); set("chat_outViews", st);
  set("chat_inViewsSelected", adjustBright(st, 15)); set("chat_outViewsSelected", adjustBright(st, 15));
  set("chat_inMenu", st); set("chat_outMenu", st);
  set("chat_inMenuSelected", adjustBright(st, 15)); set("chat_outMenuSelected", adjustBright(st, 15));
  set("chat_inSentCheck", p); set("chat_outSentCheck", p);
  set("chat_outSentCheckRead", p); set("chat_outSentCheckSelected", p);
  set("chat_outSentCheckReadSelected", p); set("chat_outSentClock", st);
  set("chat_inSentClock", st); set("chat_mediaTimeText", st);
  set("chat_mediaSentCheck", p); set("chat_mediaProgress", p);
  set("chat_selectedBackground", p + "1a"); set("chat_status", p); set("chat_muteIcon", st);
  set("chat_goDownButton", bg); set("chat_goDownButtonShadow", "00000000");
  set("chat_goDownButtonIcon", p); set("chat_goDownButtonCounter", "#ffffff");
  set("chat_goDownButtonCounterBackground", p); set("chat_inInstant", p);
  set("chat_outInstant", p); set("chat_inInstantSelected", p);
  set("chat_outInstantSelected", p); set("chat_sentError", "#f44336");
  set("chat_sentErrorIcon", "#f44336");
  set("chat_inAudioSeekbar", st); set("chat_inAudioSeekbarFill", p);
  set("chat_inAudioSeekbarSelected", adjustBright(st, 15));
  set("chat_outAudioSeekbar", st); set("chat_outAudioSeekbarFill", p);
  set("chat_outAudioSeekbarSelected", adjustBright(st, 15));
  set("chat_inVoiceSeekbar", st); set("chat_inVoiceSeekbarFill", p);
  set("chat_inVoiceSeekbarSelected", adjustBright(st, 15));
  set("chat_outVoiceSeekbar", st); set("chat_outVoiceSeekbarFill", p);
  set("chat_outVoiceSeekbarSelected", adjustBright(st, 15));
  set("chat_inFileNameText", t); set("chat_outFileNameText", t);
  set("chat_inFileInfoText", st); set("chat_outFileInfoText", st);
  set("chat_inFileProgress", p); set("chat_outFileProgress", p);
  set("chat_inFileBackground", mi); set("chat_outFileBackground", mo);
  set("chat_inFileBackgroundSelected", adjustBright(mi, 15));
  set("chat_outFileBackgroundSelected", adjustBright(mo, 15));
  set("chat_inLoader", p); set("chat_outLoader", p);
  set("chat_inLoaderSelected", p); set("chat_outLoaderSelected", p);
  set("chat_inLoaderPhoto", p); set("chat_outLoaderPhoto", p);
  set("chat_inLoaderPhotoSelected", p); set("chat_outLoaderPhotoSelected", p);
  set("chat_inContactName", p); set("chat_outContactName", p);
  set("chat_emojiPanelBackground", bg); set("chat_emojiPanelIcon", st);
  set("chat_emojiPanelIconSelected", p); set("chat_emojiPanelBadgeBackground", p);
  set("chat_emojiPanelBadgeText", "#ffffff"); set("chat_emojiPanelNewUnread", p);
  set("chat_emojiPanelStickerPackSelector", p);
  set("chat_emojiPanelIconSelector", bg + "1a");
  set("chat_botInlineInfo", st); set("chat_botInlineTitle", t);
  set("chat_botInlineDescription", st);
  set("chat_serviceBackground", p + "3c"); set("chat_serviceText", "#ffffff");
  set("chat_serviceLink", "#ffffff"); set("chat_serviceIcon", "#ffffff");
  set("chat_serviceIconSelected", "#ffffff");
  set("profile_tabSelectedText", p); set("profile_tabSelectedLine", p);
  set("profile_tabText", st); set("profile_actionBackground", p);
  set("profile_actionIcon", "#ffffff"); set("profile_avatarIcon", t);
  set("profile_status", st); set("profile_title", t);
  set("calls_callReceivedGreenIcon", "#4caf50"); set("calls_callReceivedRedIcon", "#f44336");
  set("calls_callReceivedGreenIconSelected", "#4caf50");
  set("calls_callReceivedRedIconSelected", "#f44336");
  set("inappPlayerBackground", bg); set("inappPlayerPlayPause", t);
  set("inappPlayerTitle", t); set("inappPlayerPerformer", st);
  set("inappPlayerClose", st); set("player_progress", p);
  set("player_progressBackground", st); set("player_progressCached", p + "3c");
  set("switchTrack", st); set("switchTrackChecked", p);
  set("switchTrackBlueSwitch", p); set("switchTrackBlueThumb", t);
  set("switchThumb", p); set("checkboxSquareDefault", bg);
  set("checkboxSquareChecked", p); set("checkboxSquareUnchecked", st);
  set("checkboxSquareBackground", bg); set("checkboxSquareCheck", "#ffffff");
  set("text_RedRegular", "#f44336"); set("text_RedBold", "#f44336");
  set("text_RedLight", adjustBright("#f44336", 30));
  set("text_BlueBackground", p + "1a"); set("text_BlueText", p);
  set("text_BlueIcon", p); set("text_BlueBold", p);
  set("text_BlueLink", p); set("text_BluePressed", adjustBright(p, -15));
  set("text_GreenRegular", "#4caf50"); set("text_link", p);
  set("featuredStickers_addButton", p); set("featuredStickers_addButtonPressed", adjustBright(p, -15));
  set("featuredStickers_unread", p); set("stickers_menu", bg);
  set("stickers_menuSelector", p + "1a");
  set("returnToCallBackground", p); set("returnToCallText", "#ffffff");
  set("musicPicker_checkbox", p); set("musicPicker_buttonBackground", p);
  set("musicPicker_buttonIcon", "#ffffff");
  set("notification_alertBackground", p); set("notification_alertText", t);
  set("notification_alertInfo", st);
  set("dialogBackground", bg); set("dialogTextBlack", t);
  set("dialogTextGray", st); set("dialogTextGray2", st);
  set("dialogTextGray3", st); set("dialogTextBlue", p);
  set("dialogTextBlue2", p); set("dialogTextBlue3", p);
  set("dialogTextRed", "#f44336"); set("dialogTextLink", p);
  set("dialogButton", p); set("dialogButtonPressed", adjustBright(p, -15));
  set("dialogIcon", st); set("dialogCheckboxSquareDefault", bg);
  set("dialogCheckboxSquareChecked", p); set("dialogCheckboxSquareUnchecked", st);
  set("dialogCheckboxSquareBackground", bg); set("dialogCheckboxSquareCheck", "#ffffff");
  set("dialogInputField", bg + "3c"); set("dialogInputFieldActivated", p);
  set("dialogRadioBackground", p); set("dialogRadioBackgroundChecked", p);
  set("dialogProgressBar", p); set("dialogGrayLine", bg + "3c");
  set("dialogTopBackground", bg); set("dialogBadgeBackground", p);
  set("dialogBadgeText", "#ffffff"); set("dialogLineProgress", p);
  set("dialogLineProgressBackground", st); set("dialogScrollRound", p);
  set("dialogScrollRoundOver", adjustBright(p, 10));
  set("dialog_inlineProgress", p); set("dialog_inlineProgressBackground", st);
  set("dialogInputField", bg + "3c");
  // Fill any remaining known Android keys from cx
  const allKnown = new Set([
    ...Object.keys(A2D_MAP),
    "switchTrack","switchTrackChecked","switchTrackBlueSwitch","switchTrackBlueThumb","switchThumb",
    "checkboxSquareDefault","checkboxSquareChecked","checkboxSquareUnchecked","checkboxSquareBackground","checkboxSquareCheck",
    "text_RedRegular","text_RedBold","text_RedLight","text_BlueBackground","text_BlueText","text_BlueIcon","text_BlueBold",
    "text_BlueLink","text_BluePressed","text_GreenRegular","text_link",
    "featuredStickers_addButton","featuredStickers_addButtonPressed","featuredStickers_unread",
    "stickers_menu","stickers_menuSelector",
    "returnToCallBackground","returnToCallText","musicPicker_checkbox","musicPicker_buttonBackground","musicPicker_buttonIcon",
    "notification_alertBackground","notification_alertText","notification_alertInfo",
    "dialogBackground","dialogTextBlack","dialogTextGray","dialogTextGray2","dialogTextGray3","dialogTextBlue",
    "dialogTextBlue2","dialogTextBlue3","dialogTextRed","dialogTextLink","dialogButton","dialogButtonPressed",
    "dialogIcon","dialogCheckboxSquareDefault","dialogCheckboxSquareChecked","dialogCheckboxSquareUnchecked",
    "dialogCheckboxSquareBackground","dialogCheckboxSquareCheck","dialogInputField","dialogInputFieldActivated",
    "dialogRadioBackground","dialogRadioBackgroundChecked","dialogProgressBar","dialogGrayLine",
    "dialogTopBackground","dialogBadgeBackground","dialogBadgeText","dialogLineProgress","dialogLineProgressBackground",
    "dialogScrollRound","dialogScrollRoundOver","dialog_inlineProgress","dialog_inlineProgressBackground",
    "chat_outBubbleGradient1","chat_outBubbleGradient2","chat_outBubbleGradient3","chat_outBubbleGradientSelectedOverlay",
    "chat_inInstantSelected","chat_outInstantSelected","chat_sentError","chat_sentErrorIcon",
    "chat_botInlineInfo","chat_botInlineTitle","chat_botInlineDescription",
    "chat_serviceIcon","chat_serviceIconSelected",
    "profile_avatarIcon","profile_status","profile_title",
    "inappPlayerTitle","inappPlayerPerformer","inappPlayerClose","player_progressCached",
    "avatar_nameInMessageRed","avatar_nameInMessageGreen","avatar_nameInMessageBlue","avatar_nameInMessageOrange",
    "avatar_backgroundInProfileRed",
    "calls_callReceivedGreenIconSelected","calls_callReceivedRedIconSelected",
    "chat_emojiPanelNewUnread","chat_emojiPanelStickerPackSelector","chat_emojiPanelIconSelector",
    "dialog_inlineProgress",
  ]);
  for (const key of allKnown) {
    if (!r[key] && cx[key]) r[key] = cx[key];
  }
  // Spillover: any remaining cx key not yet in output — zero loss
  for (const [k, v] of Object.entries(cx)) {
    if (!r[k] && v && !isAtthemeMetaKey(k)) r[k] = v;
  }
  // Official Android .attheme uses signed decimal ints, not #hex
  return Object.entries(r)
    .filter(([k]) => !isAtthemeMetaKey(k))
    .map(([k, v]) => `${k}=${toAndroidColorValue(v)}`);
}

/** Real TGX format: `!` meta / `@` props / `#` colors (NOT JSON).
 *  Wallpaper is NOT binary-embedded in the text file; the `!` section can
 *  contain `wallpaper: "slug"` referencing a cloud wallpaper (see 
 *  https://t.me/addtheme/ZXc0i6wFjMITudh8). The slug is written when available.
 */
function genTgx(
  colors: Record<string, string>,
  name = "TeleBox Theme",
  wallpaperSlug?: string | null,
  basedOn?: string | null,
): string {
  // Expand aliases so known cross-format keys map to TGX names
  const cx = remapAllColors(colors, "to-tgx");
  const bg = pickColor(cx, ["filling", "background", "windowBackgroundWhite", "windowBg", "chatListBackground"], "#1C2733");
  const t = pickColor(cx, ["text", "windowBackgroundWhiteBlackText", "windowFg", "headerTitle"], "#E6E1E5");
  const p = pickColor(cx, ["controlActive", "windowBackgroundWhiteBlueText", "textLink", "progress", "iconActive", "windowBackgroundWhiteBlueText4"], "#6750A4");
  const st = pickColor(cx, ["textLight", "windowBackgroundWhiteGrayText", "icon", "windowSubTextFg", "textPlaceholder"], "#7D8E98");
  const mi = pickColor(cx, ["bubbleIn_background", "chat_inBubble", "msgInBg"], "#2B2930");
  const mo = pickColor(cx, ["bubbleOut_background", "chat_outBubble", "msgOutBg"], p);
  const tb = pickColor(cx, ["headerBackground", "actionBarDefault", "topBarBg"], bg);
  const sep = pickColor(cx, ["separator", "divider"], adjustBright(bg, 15));
  // Prefer explicit basedOn from source (day/night); else luminance
  const dark = basedOn
    ? (String(basedOn).toLowerCase().includes("night") || String(basedOn).toLowerCase().includes("dark") ? 1 : 0)
    : (isDarkHex(bg) ? 1 : 0);
  const c = (hex: string) => toTgxColor(hex);

  // Group ALL known TGX colors by value (official TGX export style)
  const colorGroups: Record<string, string[]> = {};

  const tgxKeys = [
    "filling", "background", "overlayFilling", "chatBackground", "chatKeyboard", "passcode",
    "headerBackground", "headerLightBackground",
    "text", "background_text", "headerTitle", "headerText",
    "icon", "textLight", "textPlaceholder", "textNeutral", "textNegative", "background_icon",
    "bubbleIn_time", "bubbleIn_text", "bubbleIn_textLink", "bubbleIn_background", "bubbleIn_chatVerticalLine",
    "bubbleIn_messageAuthor", "bubbleIn_waveformActive", "bubbleIn_waveformInactive", "bubbleIn_progress",
    "bubbleIn_pressed", "bubbleIn_separator", "bubbleIn_outline", "bubbleIn_fillingPositive",
    "bubbleOut_text", "bubbleOut_textLink", "bubbleOut_background", "bubbleOut_chatVerticalLine",
    "bubbleOut_messageAuthor", "bubbleOut_waveformActive", "bubbleOut_waveformInactive", "bubbleOut_progress",
    "bubbleOut_pressed", "bubbleOut_separator", "bubbleOut_outline", "bubbleOut_fillingPositive",
    "bubbleOut_file", "bubbleOut_time", "bubbleOut_ticks", "bubbleOut_ticksRead",
    "ticks", "ticksRead", "badge", "badgeMuted", "badgeText",
    "progress", "textLink", "iconActive", "controlActive", "controlInactive", "controlContent",
    "circleButtonRegular", "circleButtonTheme", "circleButtonActive", "circleButtonChat", "circleButtonChatIcon",
    "circleButtonOverlay", "circleButtonOverlayIcon",
    "unread", "unreadText",
    "playerProgress", "playerBackground", "playerTitle", "playerSubtitle", "playerButton", "playerButtonActive", "playerTime",
    "attachPhoto", "attachFile", "attachContact", "attachLocation", "attachInlineBot",
    "chatListBackground", "chatListAction", "chatListVerify", "chatListIcon",
    "headerTabActive", "headerTabActiveText", "headerTabInactiveText",
    "bubble_date", "bubble_dateText", "bubble_date_noWallpaper",
    "bubble_messageSelection", "bubble_messageSelectionNoWallpaper",
    "bubble_button_noWallpaper", "bubble_buttonRipple_noWallpaper",
    "bubble_chatSeparator", "bubble_mediaReply_noWallpaper", "bubble_unread_noWallpaper",
    "chatSeparator", "chatSendButton", "chatKeyboard",
    "separator", "shareSeparator",
    "drawer", "drawerText",
    "inputActive", "inputInactive", "fillingPressed",
    "messageAuthor", "messageSwipeBackground",
    "notificationLink", "notificationAccent",
    "online", "onlineDot",
    "promo", "introSectionActive",
    "checkActive", "checkInactive",
    "sliderActive", "seekDone", "seekBar",
    "togglerActive", "togglerPositive", "togglerInactive",
    "profileSectionActive", "profileSectionActiveContent",
    "searchResult", "searchResultHighlight",
    "snackbarUpdate", "textSearchQueryHighlight",
    "themeBlackWhite",
    "headerLightIcon", "headerLightText",
    "iv_background", "iv_caption", "iv_chatLinkBackground", "iv_header", "iv_icon",
    "iv_pageAuthor", "iv_pageFooter", "iv_pageTitle", "iv_preBlockBackground",
    "iv_separator", "iv_text", "iv_textCode", "iv_textCodeBackground",
    "iv_textCodeBackgroundPressed", "iv_textLink", "iv_textLinkPressHighlight",
    "iv_textMarked", "iv_textMarkedLink", "iv_textReference", "iv_blockQuoteLine",
  ];

  for (const key of tgxKeys) {
    const val = cx[key] || colors[key];
    if (!val) continue;
    const v = c(toRgb(val));
    if (!colorGroups[v]) colorGroups[v] = [];
    if (!colorGroups[v].includes(key)) colorGroups[v].push(key);
  }

  // Also add any remaining mapped colors from source — no filter so no colors lost
  for (const [key, val] of Object.entries(cx)) {
    const v = c(toRgb(val));
    if (colorGroups[v] && colorGroups[v].includes(key)) continue;
    if (!colorGroups[v]) colorGroups[v] = [key];
    else if (!colorGroups[v].includes(key)) colorGroups[v].push(key);
  }

  const lines: string[] = [
    "!",
    `id: ${Math.floor(Date.now() / 1000) % 100000}`,
    `name: ${JSON.stringify(name)}`,
    `time: ${Math.floor(Date.now() / 1000)}`,
  ];
  if (wallpaperSlug && wallpaperSlug.trim()) {
    lines.push(`wallpaper: ${wallpaperSlug.trim()}`);
  }
  lines.push(
    "@",
    `dark: ${dark}`,
    `parentTheme: ${dark ? 1 : 0}`,
    "shadowDepth: 1",
    wallpaperSlug ? "wallpaperUsageId: 1" : "wallpaperUsageId: 0",
    "bubbleCorner: 18",
    "bubbleCornerMerged: 6",
    "bubbleDateCorner: 13",
    "dateCorner: 13",
    "bubbleOuterMargin: 8",
    "#",
  );
  for (const [hex, keys] of Object.entries(colorGroups)) {
    lines.push(`${keys.join(", ")}: ${hex}`);
  }
  return lines.join("\n") + "\n";
}

/** Real iOS .tgios-theme: nested camelCase `key: value` (NOT JSON).
 *  Wallpaper is NOT binary-embedded: `chat.defaultWallpaper` is either a solid
 *  color (RRGGBB) or a cloud wallpaper slug (e.g. eSUFoZbLCUXaAAAAi8b2YcKWYqo).
 */
function genIos(
  colors: Record<string, string>,
  name = "TeleBox Theme",
  wallpaperSlug?: string | null,
  options?: { blur?: number; motion?: boolean; basedOn?: string | null },
): string {
  const cx = remapAllColors(colors, "to-ios");
  const bg = pickColor(cx, ["windowBackgroundWhite", "backgroundColor", "windowBg", "list.plainBg"], "#1c1b1f");
  const t = pickColor(cx, ["windowBackgroundWhiteBlackText", "primaryText", "windowFg", "list.primaryText"], "#e6e1e5");
  const p = pickColor(cx, ["windowBackgroundWhiteBlueText", "accentColor", "list.accent", "windowBackgroundWhiteBlueText4"], "#6750a4");
  const st = pickColor(cx, ["windowBackgroundWhiteGrayText", "secondaryText", "list.secondaryText"], "#938f96");
  const mi = pickColor(cx, ["chat_inBubble", "chatIncomingBubble", "msgInBg"], "#2b2930");
  const mo = pickColor(cx, ["chat_outBubble", "chatOutgoingBubble", "msgOutBg"], p);
  const tb = pickColor(cx, ["actionBarDefault", "navigationBarBackground", "topBarBg", "root.navBar.background"], bg);
  const sep = pickColor(cx, ["divider", "separatorColor", "list.blocksSeparator"], adjustBright(bg, 15));
  // Prefer source basedOn (day/night/nightTinted/classic) over luminance guess
  const based = (options?.basedOn || "").toLowerCase();
  const dark = based
    ? (based.includes("night") || based.includes("dark"))
    : isDarkHex(bg);
  const basedOnOut = based.includes("night") ? (based.includes("tint") ? "nightTinted" : "night")
    : based.includes("classic") ? "classic"
    : based.includes("day") ? "day"
    : (dark ? "night" : "day");
  const ic = (hex: string) => toIosColor(hex);
  // Derive semantic colors from cx when available
  const white = "ffffff";
  const black = "000000";
  const destructive = ic(cx["text_RedRegular"] || cx["destructiveText"] || cx["attentionButtonFg"] || "#ff3b30");
  const outText = ic(isDarkHex(mo)
    ? (cx["windowBackgroundWhiteBlackText"] || "#e6e1e5")
    : (cx["windowBackgroundWhiteBlackText"] || "#000000"));
  const inText = ic(t);
  // Prefer cloud slug when available; otherwise solid color (client still installs)
  const defaultWp = (wallpaperSlug && wallpaperSlug.trim())
    ? wallpaperSlug.trim()
    : ic(bg);
  const wpOpts = wallpaperSlug ? ` blur: ${options?.blur ?? 0} motion: ${options?.motion ?? true}` : "";

  // Minimal but valid nested structure accepted by Telegram iOS
  const lines: string[] = [
    `name: ${name}`,
    `basedOn: ${basedOnOut}`,
    `dark: ${dark ? "true" : "false"}`,
    "intro:",
    `  statusBar: ${dark ? "white" : "black"}`,
    `  startButton: ${ic(p)}`,
    `  dot: ${ic(st)}`,
    "passcode:",
    "  bg:",
    `    top: ${ic(tb)}`,
    `    bottom: ${ic(bg)}`,
    `  button: clear`,
    "root:",
    `  statusBar: ${dark ? "white" : "black"}`,
    "  tabBar:",
    `    background: ${ic(bg)}`,
    `    separator: ${ic(sep)}`,
    `    icon: ${ic(st)}`,
    `    selectedIcon: ${ic(p)}`,
    `    text: ${ic(st)}`,
    `    selectedText: ${ic(p)}`,
    `    badgeBackground: ${destructive}`,
    `    badgeStroke: ${destructive}`,
    `    badgeText: ${white}`,
    "  navBar:",
    `    button: ${ic(p)}`,
    `    disabledButton: ${ic(st)}`,
    `    primaryText: ${ic(t)}`,
    `    secondaryText: ${ic(st)}`,
    `    control: ${ic(st)}`,
    `    accentText: ${ic(p)}`,
    `    background: ${ic(tb)}`,
    `    separator: ${ic(sep)}`,
    `    badgeFill: ${destructive}`,
    `    badgeStroke: ${destructive}`,
    `    badgeText: ${white}`,
    "  searchBar:",
    `    background: ${ic(bg)}`,
    `    accent: ${ic(p)}`,
    `    inputFill: ${ic(adjustBright(bg, dark ? 10 : -8))}`,
    `    inputText: ${ic(t)}`,
    `    inputPlaceholderText: ${ic(st)}`,
    `    inputIcon: ${ic(st)}`,
    `    inputClearButton: ${ic(st)}`,
    `    separator: ${ic(sep)}`,
    `  keyboard: ${dark ? "dark" : "light"}`,
    "list:",
    `  blocksBg: ${ic(adjustBright(bg, dark ? -5 : -6))}`,
    `  plainBg: ${ic(bg)}`,
    `  primaryText: ${ic(t)}`,
    `  secondaryText: ${ic(st)}`,
    `  disabledText: ${ic(st)}`,
    `  accent: ${ic(p)}`,
    `  highlighted: ${ic(p)}`,
    `  destructive: ${destructive}`,
    `  placeholderText: ${ic(st)}`,
    `  itemBlocksBg: ${ic(bg)}`,
    `  itemHighlightedBg: ${ic(adjustBright(bg, dark ? 12 : -10))}`,
    `  blocksSeparator: ${ic(sep)}`,
    `  plainSeparator: ${ic(sep)}`,
    `  disclosureArrow: ${ic(st)}`,
    `  sectionHeaderText: ${ic(st)}`,
    `  freeText: ${ic(st)}`,
    `  freeTextError: ${destructive}`,
    `  freeTextSuccess: 26972c`,
    `  freeMonoIcon: ${ic(st)}`,
    "  switch:",
    `    frame: ${ic(sep)}`,
    `    handle: ${white}`,
    `    content: ${ic(p)}`,
    `    positive: 00c900`,
    `    negative: ${destructive}`,
    "  disclosureActions:",
    `    neutral1:`,
    `      bg: ${ic(p)}`,
    `      fg: ${white}`,
    `    neutral2:`,
    `      bg: f09a37`,
    `      fg: ${white}`,
    `    destructive:`,
    `      bg: ${destructive}`,
    `      fg: ${white}`,
    `    constructive:`,
    `      bg: 00c900`,
    `      fg: ${white}`,
    `    accent:`,
    `      bg: ${ic(p)}`,
    `      fg: ${white}`,
    `    warning:`,
    `      bg: ff9500`,
    `      fg: ${white}`,
    `    inactive:`,
    `      bg: ${ic(st)}`,
    `      fg: ${white}`,
    "  check:",
    `    bg: ${ic(p)}`,
    `    stroke: ${ic(sep)}`,
    `    fg: ${white}`,
    `  controlSecondary: ${ic(sep)}`,
    "  freeInputField:",
    `    bg: ${ic(adjustBright(bg, dark ? 10 : -8))}`,
    `    stroke: ${ic(sep)}`,
    `    placeholder: ${ic(st)}`,
    `    primary: ${ic(t)}`,
    `    control: ${ic(st)}`,
    `  mediaPlaceholder: ${ic(adjustBright(bg, dark ? 8 : -6))}`,
    `  scrollIndicator: ${ic(st)}`,
    `  pageIndicatorInactive: ${ic(sep)}`,
    `  inputClearButton: ${ic(st)}`,
    "chatList:",
    `  bg: ${ic(bg)}`,
    `  itemSeparator: ${ic(sep)}`,
    `  itemBg: ${ic(bg)}`,
    `  pinnedItemBg: ${ic(bg)}`,
    `  itemHighlightedBg: ${ic(adjustBright(bg, dark ? 10 : -8))}`,
    `  itemSelectedBg: ${ic(adjustBright(bg, dark ? 12 : -10))}`,
    `  title: ${ic(t)}`,
    `  secretTitle: 00b12c`,
    `  dateText: ${ic(st)}`,
    `  authorName: ${ic(t)}`,
    `  messageText: ${ic(st)}`,
    `  messageDraftText: ${destructive}`,
    `  checkmark: ${ic(p)}`,
    `  pendingIndicator: ${ic(st)}`,
    `  failedFill: ${destructive}`,
    `  failedFg: ${white}`,
    `  muteIcon: ${ic(st)}`,
    `  unreadBadgeActiveBg: ${ic(p)}`,
    `  unreadBadgeActiveText: ${white}`,
    `  unreadBadgeInactiveBg: ${ic(st)}`,
    `  unreadBadgeInactiveText: ${white}`,
    `  pinnedBadge: ${ic(st)}`,
    `  pinnedSearchBar: ${ic(adjustBright(bg, dark ? 8 : -6))}`,
    `  regularSearchBar: ${ic(adjustBright(bg, dark ? 8 : -6))}`,
    `  sectionHeaderBg: ${ic(adjustBright(bg, dark ? -3 : -4))}`,
    `  sectionHeaderText: ${ic(st)}`,
    `  verifiedIconBg: ${ic(p)}`,
    `  verifiedIconFg: ${white}`,
    `  secretIcon: 00b12c`,
    "  pinnedArchiveAvatar:",
    "    background:",
    `      top: ${ic(p)}`,
    `      bottom: ${ic(adjustBright(p, -20))}`,
    `    foreground: ${white}`,
    "  unpinnedArchiveAvatar:",
    "    background:",
    `      top: ${ic(st)}`,
    `      bottom: ${ic(adjustBright(st, -15))}`,
    `    foreground: ${white}`,
    `  onlineDot: 4cc91f`,
    "chat:",
    `  defaultWallpaper: ${defaultWp}${wpOpts}`,
    "  message:",
    "    incoming:",
    "      bubble:",
    "        withWp:",
    `          bg: ${ic(mi)}`,
    `          highlightedBg: ${ic(adjustBright(mi, 12))}`,
    `          stroke: ${ic(mi)}`,
    "        withoutWp:",
    `          bg: ${ic(mi)}`,
    `          highlightedBg: ${ic(adjustBright(mi, 12))}`,
    `          stroke: ${ic(mi)}`,
    `      primaryText: ${ic(t)}`,
    `      secondaryText: ${ic(st)}`,
    `      linkText: ${ic(p)}`,
    `      linkHighlight: ${ic(p)}`,
    `      scam: ${destructive}`,
    `      textHighlight: ffe438`,
    `      accentText: ${ic(p)}`,
    `      accentControl: ${ic(p)}`,
    `      mediaActiveControl: ${ic(p)}`,
    `      mediaInactiveControl: ${ic(st)}`,
    `      pendingActivity: ${ic(st)}`,
    `      fileTitle: ${ic(p)}`,
    `      fileDescription: ${ic(st)}`,
    `      fileDuration: ${ic(st)}`,
    `      mediaPlaceholder: ${ic(adjustBright(bg, dark ? 8 : -6))}`,
    "      polls:",
    `        radioButton: ${ic(sep)}`,
    `        radioProgress: ${ic(p)}`,
    `        highlight: ${ic(p)}`,
    `        separator: ${ic(sep)}`,
    `        bar: ${ic(p)}`,
    "      actionButtonsBg:",
    `        withWp: ${ic(p)}`,
    `        withoutWp: ${ic(bg)}`,
    "      actionButtonsStroke:",
    `        withWp: clear`,
    `        withoutWp: ${ic(p)}`,
    "      actionButtonsText:",
    `        withWp: ${white}`,
    `        withoutWp: ${ic(p)}`,
    `      textSelection: ${ic(p)}`,
    `      textSelectionKnob: ${ic(p)}`,
    "    outgoing:",
    "      bubble:",
    "        withWp:",
    `          bg: ${ic(mo)}`,
    `          highlightedBg: ${ic(adjustBright(mo, -15))}`,
    `          stroke: ${ic(mo)}`,
    "        withoutWp:",
    `          bg: ${ic(mo)}`,
    `          highlightedBg: ${ic(adjustBright(mo, -15))}`,
    `          stroke: ${ic(mo)}`,
    `      primaryText: ${outText}`,
    `      secondaryText: ${outText}`,
    `      linkText: ${outText}`,
    `      linkHighlight: ${outText}`,
    `      scam: ${destructive}`,
    `      textHighlight: ffe438`,
    `      accentText: ${outText}`,
    `      accentControl: ${outText}`,
    `      mediaActiveControl: ${outText}`,
    `      mediaInactiveControl: ${outText}`,
    `      pendingActivity: ${outText}`,
    `      fileTitle: ${outText}`,
    `      fileDescription: ${outText}`,
    `      fileDuration: ${outText}`,
    `      mediaPlaceholder: ${ic(adjustBright(mo, -10))}`,
    "      polls:",
    `        radioButton: ${outText}`,
    `        radioProgress: ${outText}`,
    `        highlight: ${outText}`,
    `        separator: ${outText}`,
    `        bar: ${outText}`,
    "      actionButtonsBg:",
    `        withWp: ${ic(p)}`,
    `        withoutWp: ${ic(mo)}`,
    "      actionButtonsStroke:",
    `        withWp: clear`,
    `        withoutWp: ${ic(mo)}`,
    "      actionButtonsText:",
    `        withWp: ${white}`,
    `        withoutWp: ${outText}`,
    `      textSelection: ${outText}`,
    `      textSelectionKnob: ${outText}`,
    "  serviceMessage:",
    `    date: ${ic(st)}`,
    `    service: ${ic(st)}`,
    `    serviceLink: ${ic(p)}`,
    `    unreadBarBg: ${ic(adjustBright(bg, dark ? 8 : -6))}`,
    `    unreadBarText: ${ic(st)}`,
    `    unreadBarStroke: ${ic(sep)}`,
    `    mediaDate: ${white}`,
    "  inputPanel:",
    `    panelBg: ${ic(bg)}`,
    `    panelBorder: ${ic(sep)}`,
    `    panelControlAccent: ${ic(p)}`,
    `    panelControl: ${ic(st)}`,
    `    panelControlDisabled: ${ic(st)}`,
    `    panelControlDestructive: ${destructive}`,
    `    inputBg: ${ic(adjustBright(bg, dark ? 10 : -6))}`,
    `    inputStroke: ${ic(sep)}`,
    `    inputPlaceholder: ${ic(st)}`,
    `    inputText: ${ic(t)}`,
    `    inputControl: ${ic(st)}`,
    `    actionControl: ${ic(p)}`,
    `    mediaRecordDot: ${destructive}`,
    "    mediaRecordControl:",
    `      button: ${ic(p)}`,
    `      micLevel: ${ic(p)}`,
    `      bubbleBg: ${ic(mi)}`,
    `      bubbleFg: ${ic(t)}`,
    `      icon: ${white}`,
    "  inputMediaPanel:",
    `    panelSeparator: ${ic(sep)}`,
    `    panelIcon: ${ic(st)}`,
    `    panelHighlightedIconBg: ${ic(adjustBright(bg, dark ? 12 : -10))}`,
    `    stickersBg: ${ic(bg)}`,
    `    stickersSectionText: ${ic(st)}`,
    `    stickersSearchBg: ${ic(adjustBright(bg, dark ? 8 : -6))}`,
    `    stickersSearchPlaceholder: ${ic(st)}`,
    `    stickersSearchPrimary: ${ic(t)}`,
    `    stickersSearchControl: ${ic(st)}`,
    `    gifsBg: ${ic(bg)}`,
    "  inputButtonPanel:",
    `    panelBg: ${ic(bg)}`,
    `    panelSeparator: ${ic(sep)}`,
    `    buttonBg: ${ic(adjustBright(bg, dark ? 10 : -6))}`,
    `    buttonStroke: ${ic(sep)}`,
    `    buttonHighlightedBg: ${ic(adjustBright(bg, dark ? 15 : -12))}`,
    `    buttonHighlightedStroke: ${ic(sep)}`,
    `    buttonText: ${ic(t)}`,
    "  historyNav:",
    `    bg: ${ic(bg)}`,
    `    stroke: ${ic(sep)}`,
    `    fg: ${ic(p)}`,
    `    badgeBg: ${ic(p)}`,
    `    badgeStroke: ${ic(p)}`,
    `    badgeText: ${white}`,
    "actionSheet:",
    `  dim: ${black}`,
    `  backgroundType: ${dark ? "dark" : "light"}`,
    `  opaqueItemBg: ${ic(bg)}`,
    `  opaqueItemHighlightedBg: ${ic(adjustBright(bg, dark ? 12 : -10))}`,
    `  opaqueItemSeparator: ${ic(sep)}`,
    `  standardActionText: ${ic(p)}`,
    `  destructiveActionText: ${destructive}`,
    `  disabledActionText: ${ic(st)}`,
    `  primaryText: ${ic(t)}`,
    `  secondaryText: ${ic(st)}`,
    `  controlAccent: ${ic(p)}`,
    `  inputBg: ${ic(adjustBright(bg, dark ? 10 : -6))}`,
    `  inputHollowBg: ${ic(bg)}`,
    `  inputBorder: ${ic(sep)}`,
    `  inputPlaceholder: ${ic(st)}`,
    `  inputText: ${ic(t)}`,
    `  inputClearButton: ${ic(st)}`,
    `  checkContent: ${white}`,
    "contextMenu:",
    `  dim: ${black}`,
    `  background: ${ic(bg)}`,
    `  itemBg: ${ic(bg)}`,
    `  itemHighlightedBg: ${ic(adjustBright(bg, dark ? 12 : -10))}`,
    `  separator: ${ic(sep)}`,
    `  itemPrimaryText: ${ic(t)}`,
    `  itemSecondaryText: ${ic(st)}`,
    `  itemDestructiveText: ${destructive}`,
    `  sectionHeaderText: ${ic(st)}`,
    "notification:",
    "  expanded:",
    `    bg: ${ic(bg)}`,
    `    primaryText: ${ic(t)}`,
    `    secondaryText: ${ic(st)}`,
    `    separator: ${ic(sep)}`,
    `    accent: ${ic(p)}`,
    `  regular: ${ic(bg)}`,
  ];
  // Spillover: remaining cx keys not yet in output — zero loss
  const iosLines = lines;
  const usedPaths = new Set<string>();
  for (const l of iosLines) {
    const trimmed = l.trim();
    const col = trimmed.indexOf(":");
    if (col > 0) {
      const key = trimmed.slice(0, col).trim();
      if (key) usedPaths.add(key);
    }
  }
  for (const [k, v] of Object.entries(cx)) {
    const hex = toIosColor(v);
    // Skip internal markers, nested paths already covered by the structured output
    if (k.startsWith("__") || k.includes(".") || usedPaths.has(k)) continue;
    if (!hex || usedPaths.has(k)) continue;
    iosLines.push(`  ${k}: ${hex}`);
    usedPaths.add(k);
  }
  return iosLines.join("\n") + "\n";
}

/** Build ThemeDoc colors from cloud themeSettings (accent-only themes). */
function colorsFromThemeSettings(settings: any): Record<string, string> {
  const colors: Record<string, string> = {};
  if (!settings || typeof settings !== "object") return colors;

  // MTProto delivers color as signed int32 — handle both positive and negative
  const parseColorInt = (val: any): string | null => {
    if (val == null) return null;
    const n = Number(val) >>> 0; // forced unsigned
    if (isNaN(n) || n === 0) return null;
    return toHex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  };
  const accent = settings.accentColor != null
    ? parseColor(String(settings.accentColor)) || parseColorInt(settings.accentColor)
    : null;
  const outAccent = settings.outboxAccentColor != null
    ? parseColor(String(settings.outboxAccentColor)) || parseColorInt(settings.outboxAccentColor)
    : accent;
  const base = settings.baseTheme || "";
  const dark = String(base).toLowerCase().includes("night") || String(base).toLowerCase().includes("dark");
  const bg = dark ? "#0f0f0f" : "#ffffff";
  const text = dark ? "#e6e1e5" : "#000000";
  const sub = dark ? "#938f96" : "#8e8e93";
  const p = accent || (dark ? "#6750a4" : "#2481cc");
  const out = outAccent || p;
  const assign = (keys: string[], hex: string) => { for (const k of keys) colors[k] = hex; };
  assign(["windowBackgroundWhite", "windowBg", "filling", "background", "chatListBackground"], bg);
  assign(["windowBackgroundWhiteBlackText", "windowFg", "text", "primaryText"], text);
  assign(["windowBackgroundWhiteGrayText", "windowSubTextFg", "textLight", "secondaryText"], sub);
  assign(["windowBackgroundWhiteBlueText", "windowBackgroundWhiteBlueText4", "textLink", "progress", "accentColor", "controlActive"], p);
  assign(["actionBarDefault", "topBarBg", "headerBackground", "navigationBarBackground", "root.navBar.background"], dark ? "#1a1a1a" : p);
  assign(["chat_inBubble", "bubbleIn_background", "msgInBg", "chatIncomingBubble"], dark ? "#1e1e1e" : "#f1f1f4");
  assign(["chat_outBubble", "bubbleOut_background", "msgOutBg", "chatOutgoingBubble"], out);
  assign(["chats_unreadCounter", "badge", "unread"], p);
  assign(["divider", "separator", "list.blocksSeparator", "separatorColor"], dark ? "#2a2a2a" : "#c8c7cc");
  assign(["windowBackgroundWhiteGrayText2", "windowBackgroundWhiteGrayText3", "windowBackgroundWhiteHintText"], sub);
  assign(["windowBackgroundWhiteBlueText2", "windowBackgroundWhiteBlueText3", "windowBackgroundWhiteBlueText5", "windowBackgroundWhiteBlueText6", "windowBackgroundWhiteBlueText7"], p);
  assign(["windowBackgroundWhiteBlueButton", "windowBackgroundWhiteBlueIcon"], p);
  assign(["windowBackgroundWhiteLinkText", "windowBackgroundWhiteValueText"], text);
  assign(["windowBackgroundWhiteInputField"], dark ? "#2a2a2a" : "#e6e6ea");
  assign(["windowBackgroundWhiteInputFieldActivated", "activeLineFg"], p);
  assign(["actionBarDefaultIcon", "menuIconFg", "actionBarActionModeDefaultIcon"], p);
  assign(["actionBarDefaultTitle", "windowBoldFg"], text);
  assign(["actionBarDefaultSubtitle", "actionBarDefaultSearchPlaceholder", "placeholderFg"], sub);
  assign(["actionBarDefaultSearch", "windowFg"], text);
  assign(["actionBarDefaultSelector", "listSelectorSDK21", "windowBgRipple"], p + "1a");
  assign(["chats_menuBackground"], bg);
  assign(["chats_name", "dialogsNameFg"], text);
  assign(["chats_message", "chats_message_threeLines", "dialogsTextFg"], sub);
  assign(["chats_date", "dialogsDateFg"], sub);
  assign(["chats_nameMessage", "dialogsTextFgService"], p);
  assign(["chats_menuItemIcon", "chats_menuItemText"], p);
  assign(["chats_menuName", "chats_menuPhone", "chats_menuPhoneCats"], text);
  assign(["chats_actionBackground", "activeButtonBg"], p);
  assign(["chats_actionIcon", "windowFgActive"], "#ffffff");
  assign(["chats_sentCheck", "chats_sentCheckRead", "dialogsSentIconFg"], p);
  assign(["chats_draft", "dialogsDraftFg"], "#f44336");
  assign(["chats_onlineCircle", "onlineFg"], "#4caf50");
  assign(["chats_unreadCounterMuted", "dialogsUnreadBgMuted"], sub);
  assign(["chats_unreadCounterText", "dialogsUnreadFg"], "#ffffff");
  assign(["chats_verifiedBackground", "dialogsVerifiedIconBg"], p);
  assign(["chats_verifiedCheck", "dialogsVerifiedIconFg"], "#ffffff");
  assign(["chats_secretIcon", "chats_secretName"], p);
  assign(["avatar_text"], text);
  assign(["avatar_backgroundRed"], "#f44336");
  assign(["avatar_backgroundGreen"], "#4caf50");
  assign(["avatar_backgroundBlue", "accentColor"], p);
  assign(["avatar_backgroundOrange"], "#ff9800");
  assign(["chat_messagePanelBackground", "historyComposeAreaBg"], bg);
  assign(["chat_messagePanelHint", "historyComposeAreaFgService"], sub);
  assign(["chat_messagePanelText", "historyComposeAreaFg"], text);
  assign(["chat_messagePanelSend", "historySendIconFg"], p);
  assign(["chat_messagePanelIcons", "historyComposeIconFg"], p);
  assign(["chat_messagePanelVoiceBackground", "chat_messagePanelVoicePressed"], p);
  assign(["chat_botInlineInfo", "chat_botInlineTitle", "chat_botInlineDescription"], sub);
  assign(["chat_inBubbleSelected", "msgInBgSelected"], dark ? adjustBright("#1e1e1e", 15) : adjustBright("#f1f1f4", -10));
  assign(["chat_outBubbleSelected", "msgOutBgSelected"], adjustBright(out, -15));
  assign(["chat_messageTextIn", "chat_messageTextOut", "historyTextInFg", "historyTextOutFg"], text);
  assign(["chat_messageLinkIn", "chat_messageLinkOut", "historyLinkInFg", "historyLinkOutFg"], p);
  assign(["chat_inReplyLine", "msgInReplyBarColor"], p);
  assign(["chat_outReplyLine", "msgOutReplyBarColor"], p);
  assign(["chat_inReplyNameText", "msgInServiceFg"], p);
  assign(["chat_outReplyNameText", "msgOutServiceFg"], p);
  assign(["chat_inReplyMessageText", "chat_outReplyMessageText", "msgInDateFg", "msgOutDateFg"], sub);
  assign(["chat_inTimeText", "chat_outTimeText", "chat_inViews", "chat_outViews"], sub);
  assign(["chat_selectedBackground", "msgSelectOverlay"], p + "1a");
  assign(["chat_status", "windowActiveTextFg"], p);
  assign(["chat_goDownButton", "historyToDownBg"], bg);
  assign(["chat_goDownButtonIcon", "historyToDownFg"], p);
  assign(["chat_goDownButtonCounter", "historyToDownFgOver"], "#ffffff");
  assign(["chat_goDownButtonCounterBackground", "historyToDownBgOver"], p);
  assign(["chat_serviceBackground"], p + "3c");
  assign(["chat_serviceText", "chat_serviceLink", "chat_serviceIcon"], "#ffffff");
  assign(["chat_emojiPanelBackground", "stickers_menu"], bg);
  assign(["chat_emojiPanelIcon", "stickers_menu"], sub);
  assign(["chat_emojiPanelIconSelected", "stickers_menuSelector"], p);
  assign(["chat_emojiPanelBadgeBackground", "featuredStickers_unread"], p);
  assign(["chat_emojiPanelBadgeText"], "#ffffff");
  assign(["profile_tabSelectedText", "profile_tabSelectedLine"], p);
  assign(["profile_tabText"], sub);
  assign(["profile_actionBackground"], p);
  assign(["profile_actionIcon"], "#ffffff");
  assign(["calls_callReceivedGreenIcon"], "#4caf50");
  assign(["calls_callReceivedRedIcon"], "#f44336");
  assign(["inappPlayerBackground", "playerBackground"], dark ? "#1a1a1a" : "#f9f9f9");
  assign(["inappPlayerPlayPause", "playerButton"], text);
  assign(["player_progress", "playerProgress"], p);
  assign(["player_progressBackground", "playerTime"], sub);
  assign(["switchTrack", "switchTrackBlueSwitch"], p);
  assign(["switchTrackChecked", "switchTrackBlueThumb"], p);
  assign(["text_RedRegular", "text_RedBold"], "#f44336");
  assign(["text_BlueBackground", "text_BlueText", "text_BlueIcon", "text_BlueBold", "text_BlueLink"], p);
  assign(["text_GreenRegular"], "#4caf50");
  assign(["featuredStickers_addButton"], p);
  assign(["dialogBackground", "dialogTopBackground"], bg);
  assign(["dialogTextBlack", "dialogTextBlack"], text);
  assign(["dialogTextGray", "dialogTextGray2", "dialogTextGray3"], sub);
  assign(["dialogTextBlue", "dialogTextBlue2", "dialogTextBlue3"], p);
  assign(["dialogTextRed"], "#f44336");
  assign(["dialogButton"], p);
  assign(["dialogIcon"], sub);
  assign(["dialogCheckboxSquareChecked", "dialogRadioBackground", "dialogRadioBackgroundChecked"], p);
  assign(["dialogProgressBar", "dialogLineProgress", "dialogScrollRound"], p);
  assign(["dialogBadgeBackground"], p);
  assign(["dialogBadgeText"], "#ffffff");
  if (Array.isArray(settings.messageColors)) {
    // messageColors are ARGB ints for outgoing bubble gradients — use first
    const mc = settings.messageColors[0];
    if (mc != null) {
      const n = Number(mc) >>> 0;
      const hex = toHex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
      assign(["chat_outBubble", "bubbleOut_background", "msgOutBg", "chatOutgoingBubble"], hex);
    }
  }
  return colors;
}

/**
 * Export cloud themeSettings JSON for clients without proprietary theme files
 * (Unigram / Telegram Web / WebK / WebA). Colors are signed int32 AARRGGBB.
 */
function hexToSignedColorInt(hex: string): number | null {
  const pv = parseColor(hex);
  if (!pv) return null;
  let r = 0, g = 0, b = 0, a = 255;
  if (pv.length === 9) {
    a = parseInt(pv.slice(1, 3), 16);
    r = parseInt(pv.slice(3, 5), 16);
    g = parseInt(pv.slice(5, 7), 16);
    b = parseInt(pv.slice(7, 9), 16);
  } else {
    r = parseInt(pv.slice(1, 3), 16);
    g = parseInt(pv.slice(3, 5), 16);
    b = parseInt(pv.slice(5, 7), 16);
  }
  const n = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
  return n > 0x7fffffff ? n - 0x100000000 : n;
}

function genCloudThemeSettingsExport(
  colors: Record<string, string>,
  meta?: {
    title?: string;
    basedOn?: string | null;
    wallpaperSlug?: string | null;
    wallpaperBlur?: number;
    wallpaperMotion?: boolean;
  },
): string {
  const cx = expandColorAliases(colors);
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      if (cx[k]) return cx[k];
    }
    return null;
  };
  const accentHex = pick(
    "windowBackgroundWhiteBlueText4", "windowBackgroundWhiteBlueText",
    "windowActiveTextFg", "accentColor", "controlActive", "textLink", "progress",
  ) || "#2481cc";
  const outHex = pick(
    "chat_outBubble", "bubbleOut_background", "msgOutBg", "chatOutgoingBubble",
  ) || accentHex;
  const bgHex = pick(
    "windowBackgroundWhite", "windowBg", "filling", "background", "chatListBackground",
  ) || "#ffffff";
  const dark = isDarkHex(bgHex) || /night|dark/i.test(meta?.basedOn || "");
  const baseTheme = dark
    ? (/tinted/i.test(meta?.basedOn || "") ? "baseThemeTinted" : "baseThemeNight")
    : (/classic/i.test(meta?.basedOn || "") ? "baseThemeClassic" : "baseThemeDay");

  const accent = hexToSignedColorInt(accentHex) ?? 0x2481cc;
  const outbox = hexToSignedColorInt(outHex) ?? accent;
  const msgIn = hexToSignedColorInt(
    pick("chat_inBubble", "bubbleIn_background", "msgInBg") || (dark ? "#1e1e1e" : "#f1f1f4"),
  );
  const msgOut = hexToSignedColorInt(outHex);

  const settings: any = {
    _: "themeSettings",
    baseTheme: { _: baseTheme },
    accentColor: accent,
    outboxAccentColor: outbox,
    messageColors: [msgOut, msgIn].filter((x): x is number => x != null),
  };
  if (meta?.wallpaperSlug) {
    settings.wallpaper = {
      _: "wallPaper",
      slug: meta.wallpaperSlug,
      settings: {
        _: "wallPaperSettings",
        blur: meta.wallpaperBlur ?? 0,
        motion: meta.wallpaperMotion !== false,
      },
    };
  }

  const doc = {
    teleboxExport: "cloud-theme-settings",
    version: 1,
    title: meta?.title || "TeleBox Theme",
    note: "Unigram / Telegram Web 等无独立主题文件的客户端使用云端 themeSettings。"
      + " 可用 theme cloud 上传生成 t.me/addtheme 链接；本 JSON 便于调试/二次导入。",
    clients: ["unigram", "web", "webk", "weba", "telegram-web"],
    officialFileFormats: {
      android: ".attheme",
      ios: ".tgios-theme",
      macos: ".tgx-theme",
      tdesktop: ".tdesktop-theme",
    },
    settings,
    palettePreview: {
      accent: accentHex,
      outbox: outHex,
      background: bgHex,
      dark,
      basedOn: meta?.basedOn || (dark ? "night" : "day"),
      wallpaperSlug: meta?.wallpaperSlug || null,
    },
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Parse TeleBox cloud-settings JSON or raw themeSettings object → ThemeDoc */
function parseCloudSettingsJson(buf: Buffer): ThemeDoc | null {
  try {
    const text = buf.toString("utf-8").trim();
    if (!text.startsWith("{")) return null;
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object") return null;
    let settings: any = null;
    if (obj.teleboxExport === "cloud-theme-settings" && obj.settings) settings = obj.settings;
    else if (hasTlType(obj, "themeSettings") || obj.accentColor != null) settings = obj;
    else if (obj.settings && (hasTlType(obj.settings, "themeSettings") || obj.settings.accentColor != null)) settings = obj.settings;
    if (!settings) return null;
    const colors = colorsFromThemeSettings(settings);
    if (!Object.keys(colors).length) return null;
    const base = String(settings.baseTheme?._ || settings.baseTheme || obj.palettePreview?.basedOn || "");
    const basedOn = /night|dark/i.test(base) ? "night" : /classic/i.test(base) ? "classic" : "day";
    let wallpaperSlug: string | null =
      (typeof settings.wallpaper?.slug === "string" && settings.wallpaper.slug.length > 4)
        ? settings.wallpaper.slug
        : (obj.palettePreview?.wallpaperSlug || null);
    const wpSet = settings.wallpaper?.settings || {};
    return {
      format: "attheme",
      colors,
      basedOn,
      wallpaperSlug,
      wallpaperBlur: typeof wpSet.blur === "number" ? wpSet.blur : (typeof wpSet.blur === "boolean" && wpSet.blur ? 1 : 0),
      wallpaperMotion: wpSet.motion !== false,
    };
  } catch { return null; }
}

/** Unified parser: cloud JSON → format-specific parsers */
function parseThemeBuffer(buf: Buffer, hint?: ThemeFormat | null): ThemeDoc | null {
  const cloud = parseCloudSettingsJson(buf);
  if (cloud) return cloud;
  const fmt = hint || detectFmt(buf);
  if (!fmt) return null;
  if (fmt === "attheme") return parseAttheme(buf);
  if (fmt === "tdesktop-theme") return parseDesktop(buf);
  if (fmt === "tgx-theme") return parseTgx(buf);
  return parseIos(buf);
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseAttheme(buf: Buffer): ThemeDoc | null {
  try {
    const colors: Record<string, string> = {};
    const wps = Buffer.from("WPS\n");
    // WPE may appear as \nWPE\n or WPE\n
    const wpsIdx = buf.indexOf(wps);
    const textEnd = wpsIdx !== -1 ? wpsIdx : buf.length;
    for (const line of buf.subarray(0, textEnd).toString("utf-8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("//") || s === "end") continue;
      const eq = s.indexOf("=");
      if (eq <= 0) continue;
      const key = s.slice(0, eq).trim();
      // wallpaperFileOffset is metadata, not a color — never put in palette
      if (isAtthemeMetaKey(key)) continue;
      const pv = parseColor(s.slice(eq + 1).trim());
      if (pv) colors[key] = pv;
    }
    let wallpaper: Buffer | null = null;
    if (wpsIdx !== -1) {
      const imgStart = wpsIdx + wps.length;
      // find WPE marker near end
      let imgEnd = buf.length;
      const wpe1 = buf.indexOf(Buffer.from("\nWPE\n"), imgStart);
      const wpe2 = buf.indexOf(Buffer.from("WPE\n"), imgStart);
      if (wpe1 !== -1) imgEnd = wpe1;
      else if (wpe2 !== -1) imgEnd = wpe2;
      wallpaper = normalizeWallpaper(buf.subarray(imgStart, imgEnd));
    }
    return { format: "attheme", colors, wallpaper };
  } catch { return null; }
}

function parseDesktop(buf: Buffer): ThemeDoc | null {
  try {
    // ZIP package: colors.tdesktop-theme + background.jpg/png
    if (isZip(buf)) {
      const files = parseZip(buf);
      const names = Object.keys(files);
      const colorName = names.find(n => {
        const l = n.toLowerCase();
        return l.endsWith("colors.tdesktop-theme") || l.endsWith("colors.tdesktop-palette") || l.endsWith(".tdesktop-theme") || l.endsWith(".tdesktop-palette");
      });
      // Prefer explicit colors.* name
      let colorBuf: Buffer | null = null;
      for (const prefer of ["colors.tdesktop-theme", "colors.tdesktop-palette"]) {
        const hit = names.find(n => n.toLowerCase() === prefer || n.toLowerCase().endsWith("/" + prefer));
        if (hit) { colorBuf = files[hit]; break; }
      }
      if (!colorBuf && colorName) colorBuf = files[colorName];
      if (!colorBuf) {
        // any non-image text file
        for (const n of names) {
          const f = files[n];
          if (f && !detectImageExt(f) && f.toString("utf-8", 0, Math.min(200, f.length)).includes(":")) {
            colorBuf = f; break;
          }
        }
      }
      if (!colorBuf) return null;
      const colorText = colorBuf.toString("utf-8");
      const colors = parseDesktopColorText(colorText);
      const { wallpaper, tiled } = extractDesktopWallpaper(files);
      const meta = extractDesktopMeta(colorText);
      return {
        format: "tdesktop-theme",
        colors,
        wallpaper,
        wallpaperTiled: tiled || meta.wallpaperTiled,
        // Desktop palette may reference cloud bg via t.me/bg/SLUG when package has no image
        wallpaperSlug: wallpaper ? null : (meta.wallpaperSlug || null),
      };
    }

    // Plain palette text (optionally with trailing binary wrongly concatenated — try recover)
    let text = buf.toString("utf-8");
    let wallpaper: Buffer | null = null;
    // If binary jpeg/png appended after text (old broken export), recover it
    const j = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const p = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let imgAt = -1;
    if (j > 50 && (p < 0 || j < p)) imgAt = j;
    else if (p > 50) imgAt = p;
    if (imgAt > 0) {
      text = buf.subarray(0, imgAt).toString("utf-8");
      wallpaper = normalizeWallpaper(buf.subarray(imgAt));
    }
    const colors = parseDesktopColorText(text);
    if (!Object.keys(colors).length) return null;
    const meta = extractDesktopMeta(text);
    return {
      format: "tdesktop-theme",
      colors,
      wallpaper,
      wallpaperTiled: meta.wallpaperTiled,
      wallpaperSlug: wallpaper ? null : (meta.wallpaperSlug || null),
    };
  } catch { return null; }
}

function parseTgx(buf: Buffer): ThemeDoc | null {
  try {
    const text = buf.toString("utf-8");
    // Real TGX: sections ! / @ / # — parse # color lines
    if (text.trimStart().startsWith("!") || /^#\s*$/m.test(text) || text.includes("\nbubbleIn_background") || text.includes("filling:")) {
      const colors: Record<string, string> = {};
      let wallpaperSlug: string | null = null;
      let basedOn: string | null = null;
      let section = "";
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("//")) continue;
        if (line === "!" || line === "@" || line === "#") { section = line; continue; }
        // In ! section: metadata — wallpaper / name
        if (section === "!") {
          if (line.startsWith("wallpaper:")) {
            const slug = line.slice("wallpaper:".length).trim().replace(/^["']|["']$/g, "");
            if (slug && slug.length > 8) wallpaperSlug = slug;
          }
          continue;
        }
        // In @ section: dark / parentTheme
        if (section === "@") {
          if (line.startsWith("dark:")) {
            const v = line.slice(5).trim();
            basedOn = (v === "1" || v === "true") ? "night" : "day";
          } else if (line.startsWith("parentTheme:")) {
            const v = line.slice("parentTheme:".length).trim();
            if (!basedOn) basedOn = (v === "1" || v === "true") ? "night" : "day";
          }
          continue;
        }
        if (section !== "#" && !line.includes("#")) {
          // still try color-like values anywhere
        }
        const col = line.lastIndexOf(":");
        if (col <= 0) continue;
        const keysPart = line.slice(0, col).trim();
        const val = line.slice(col + 1).trim();
        if (!val.startsWith("#") && !/^[0-9a-fA-F]{6,8}$/.test(val)) continue;
        const hex = val.startsWith("#") ? val : `#${val}`;
        const pv = parseColor(hex) || (hex.startsWith("#") ? hex : null);
        if (!pv) continue;
        for (const k of keysPart.split(",")) {
          const key = k.trim();
          if (key) colors[key] = pv.startsWith("#") ? pv : `#${pv}`;
        }
      }
      if (Object.keys(colors).length || wallpaperSlug) {
        return { format: "tgx-theme", colors, wallpaperSlug, basedOn };
      }
    }
    // Legacy JSON fallback
    const obj = JSON.parse(text);
    const colors: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && (v.startsWith("#") || /^[0-9a-fA-F]{6,8}$/.test(v))) {
        colors[k] = v.startsWith("#") ? v : `#${v}`;
      }
    }
    if (!Object.keys(colors).length) return null;
    const iosKeys = ["backgroundColor", "navigationBarBackground", "chatIncomingBubble", "keyboardBackground"];
    const hasIosKeys = iosKeys.some(k => colors[k] !== undefined);
    const tgxKeys = ["bubbleIn_background", "bubbleOut_background", "chatListBackground", "headerBackground", "filling"];
    const hasTgxKeys = tgxKeys.some(k => colors[k] !== undefined);
    if (hasIosKeys && !hasTgxKeys) return { format: "ios-theme", colors };
    return { format: "tgx-theme", colors };
  } catch { return null; }
}

function parseIos(buf: Buffer): ThemeDoc | null {
  try {
    const text = buf.toString("utf-8");
    // Nested camelCase theme file
    if (text.includes("basedOn:") || text.includes("navBar:") || text.includes("chatList:") || text.includes("primaryText:")) {
      const colors: Record<string, string> = {};
      let wallpaperSlug: string | null = null;
      let basedOn: string | null = null;
      const stack: string[] = [];
      for (const rawLine of text.split("\n")) {
        if (!rawLine.trim()) continue;
        const indent = (rawLine.match(/^ */)?.[0].length || 0);
        const level = Math.floor(indent / 2);
        while (stack.length > level) stack.pop();
        const line = rawLine.trim();
        if (line.endsWith(":") && !line.includes(" ")) {
          // section key only
          stack[level] = line.slice(0, -1);
          stack.length = level + 1;
          continue;
        }
        const col = line.indexOf(":");
        if (col <= 0) continue;
        const key = line.slice(0, col).trim();
        let val = line.slice(col + 1).trim();
        if (!val || val === "true" || val === "false" || val === "clear" || val === "light" || val === "dark" || val === "black" || val === "white" || val === "day" || val === "night" || val === "nightTinted" || val === "classic") {
          if (key === "basedOn") basedOn = val;
          stack[level] = key;
          stack.length = level + 1;
          continue;
        }

        // chat.defaultWallpaper: solid color OR cloud wallpaper slug (+ optional settings)
        // Real example: `  defaultWallpaper: eSUFoZbLCUXaAAAAi8b2YcKWYqo blur: 0 motion: true`
        if (key === "defaultWallpaper") {
          const parts = val.split(/\s+/).filter(Boolean);
          const first = parts[0] || "";
          const hexOnly = first.replace(/^#/, "");
          // Parse optional wallpaper options: blur:N, motion:true/false, intensity:0..100
          let blur = 0, motion = true, intensity = 100;
          for (const p of parts.slice(1)) {
            if (p.startsWith("blur:")) blur = parseInt(p.slice(5), 10) || 0;
            else if (p.startsWith("motion:")) motion = p.slice(7) === "true";
            else if (p.startsWith("intensity:")) intensity = parseInt(p.slice(10), 10) || 100;
          }
          if (/^[0-9a-fA-F]{6,8}$/.test(hexOnly) && first.length <= 9) {
            // solid color wallpaper
            colors["chat.defaultWallpaper"] = `#${hexOnly}`;
            colors.defaultWallpaper = colors["chat.defaultWallpaper"];
          } else if (first.length > 8 && !/^[0-9a-fA-F]{6,8}$/.test(first)) {
            // cloud wallpaper slug (must be longer than hex color)
            wallpaperSlug = first;
            colors["chat.defaultWallpaperSlug"] = first;
          } else if (first.toLowerCase() === "builtin") {
            // builtin — no image
          } else if (/^[0-9a-fA-F]{6,8}$/.test(hexOnly)) {
            colors["chat.defaultWallpaper"] = `#${hexOnly}`;
          }
          // Store wallpaper options for later use (they're not part of the flat color map)
          // We'll inject them into the return doc via a tag on the colors map
          (colors as any)["__wpBlur"] = blur;
          (colors as any)["__wpMotion"] = motion;
          (colors as any)["__wpIntensity"] = intensity;
          continue;
        }

        // color value: RRGGBB / AARRGGBB / #hex
        if (val.startsWith("#")) val = val.slice(1);
        if (!/^[0-9a-fA-F]{6,8}$/.test(val)) continue;
        const path = [...stack.slice(0, level), key].filter(Boolean).join(".");
        const hex = `#${val}`;
        colors[path] = hex;
        // also store leaf key for mapping convenience
        if (!colors[key]) colors[key] = colors[path];
      }
      // Map common nested paths to flat keys used by converters
      const mapIf = (from: string, to: string) => { if (colors[from] && !colors[to]) colors[to] = colors[from]; };
      mapIf("list.plainBg", "windowBackgroundWhite");
      mapIf("list.primaryText", "windowBackgroundWhiteBlackText");
      mapIf("list.secondaryText", "windowBackgroundWhiteGrayText");
      mapIf("list.accent", "windowBackgroundWhiteBlueText");
      mapIf("root.navBar.background", "actionBarDefault");
      mapIf("chat.message.incoming.bubble.withoutWp.bg", "chat_inBubble");
      mapIf("chat.message.outgoing.bubble.withoutWp.bg", "chat_outBubble");
      mapIf("chatList.bg", "chatListBackground");
      if (Object.keys(colors).length || wallpaperSlug) {
        const wpBlur = (colors as any)["__wpBlur"] as number | undefined;
        const wpMotion = (colors as any)["__wpMotion"] as boolean | undefined;
        const wpIntensity = (colors as any)["__wpIntensity"] as number | undefined;
        // Clean up internal markers before returning
        delete (colors as any)["__wpBlur"];
        delete (colors as any)["__wpMotion"];
        delete (colors as any)["__wpIntensity"];
        return { format: "ios-theme", colors, wallpaperSlug, basedOn, wallpaperBlur: wpBlur, wallpaperMotion: wpMotion, wallpaperIntensity: wpIntensity };
      }
    }
    // Legacy JSON fallback
    const obj = JSON.parse(text);
    const colors: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && (v.startsWith("#") || /^[0-9a-fA-F]{6,8}$/.test(v))) {
        colors[k] = v.startsWith("#") ? v : `#${v}`;
      }
    }
    if (!Object.keys(colors).length) return null;
    return { format: "ios-theme", colors };
  } catch { return null; }
}

function detectFmt(buf: Buffer): ThemeFormat | null {
  if (!buf || buf.length === 0) return null;
  // ZIP = desktop theme package
  if (isZip(buf)) return "tdesktop-theme";
  const t = buf.toString("utf-8", 0, Math.min(buf.length, 4096)).trim();
  // Real TGX text format
  if (t.startsWith("!") || (t.includes("\n#\n") && (t.includes("filling") || t.includes("bubbleIn_background") || t.includes("parentTheme")))) {
    return "tgx-theme";
  }
  // Real iOS nested theme
  if ((t.includes("basedOn:") || t.startsWith("name:")) && (t.includes("navBar:") || t.includes("chatList:") || t.includes("primaryText:"))) {
    return "ios-theme";
  }
  // JSON (legacy / cloud-settings export / accidental)
  if (t[0] === "{" || t[0] === "[") {
    try {
      const obj = JSON.parse(buf.toString("utf-8").trim());
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        // Our own cloud-settings export or raw themeSettings
        if (
          obj.teleboxExport === "cloud-theme-settings"
          || hasTlType(obj.settings, "themeSettings")
          || (hasTlType(obj, "themeSettings") && (obj.accentColor != null || obj.baseTheme))
        ) {
          // Synthesize as attheme-colored doc via colorsFromThemeSettings — detectFmt returns attheme
          // so parsers route through a dedicated path in listen/convert
          return "attheme";
        }
        if (obj.backgroundColor || obj.navigationBarBackground || obj.chatIncomingBubble) return "ios-theme";
        if (obj.bubbleIn_background || obj.chatListBackground || obj.headerBackground || obj.filling) return "tgx-theme";
        for (const v of Object.values(obj)) {
          if (typeof v === "string" && v.startsWith("#")) return "tgx-theme";
        }
      }
    } catch { /* */ }
  }
  // Android with or without wallpaper
  if (buf.includes(Buffer.from("WPS\n")) || t.split("\n").some((l: string) => l.includes("=") && !l.trim().startsWith("//") && !l.includes(":"))) {
    // prefer attheme if key=value color lines present
    if (t.split("\n").some((l: string) => /^[A-Za-z0-9_]+=/.test(l.trim()))) return "attheme";
  }
  // Desktop palette: classic "key: val;" OR bare "key: #hex" / "key: alias" (no semicolon)
  if (t.split("\n").some((l: string) => l.includes(":") && l.includes(";"))) return "tdesktop-theme";
  if (
    t.split("\n").some((l: string) => {
      const s = l.trim();
      if (!s || s.startsWith("//") || s.startsWith("!")) return false;
      // desktop-like: identifier: value (value may be #hex, alias, or hex without #)
      return /^[A-Za-z][A-Za-z0-9_]*\s*:\s*(#[0-9a-fA-F]{3,8}|[0-9a-fA-F]{6,8}|[A-Za-z][A-Za-z0-9_]*)\s*;?\s*$/.test(s);
    })
    && (t.includes("windowBg") || t.includes("primaryColor") || t.includes("msgInBg") || t.includes("historyComposeAreaBg") || t.includes("dialogsBg"))
  ) {
    return "tdesktop-theme";
  }
  if (t.split("\n").some((l: string) => (l.includes("=") && !l.trim().startsWith("//")) || l.includes("WPS"))) return "attheme";
  return null;
}

function renderDoc(doc: ThemeDoc, target: ThemeFormat, name = "TeleBox Theme"): Buffer | null {
  try {
    const wp = normalizeWallpaper(doc.wallpaper || null);
    const tiled = !!doc.wallpaperTiled;
    const slug = doc.wallpaperSlug || null;
    const options = {
      blur: doc.wallpaperBlur ?? 0,
      motion: doc.wallpaperMotion ?? true,
      basedOn: doc.basedOn || null,
    };
    const withWp: ThemeDoc = {
      ...doc,
      wallpaper: wp,
      wallpaperTiled: tiled,
      wallpaperSlug: slug,
      wallpaperBlur: doc.wallpaperBlur,
      wallpaperMotion: doc.wallpaperMotion,
      basedOn: doc.basedOn,
    };

    let buf: Buffer | null = null;
    if (target === "attheme") {
      const text = genAndroid(withWp.colors).join("\n") + "\n";
      buf = attachAtthemeWallpaper(text, wp);
    } else if (target === "tdesktop-theme") {
      // When package embeds image, no need for t.me/bg link; when only slug, write wallpaper: line
      const deskText = genDesktop(withWp.colors, wp ? null : slug, tiled);
      buf = buildDesktopTheme(deskText, wp, tiled);
    } else if (target === "tgx-theme") {
      buf = Buffer.from(genTgx(withWp.colors, name, doc.wallpaperSlug || null, doc.basedOn || null), "utf-8");
    } else if (target === "ios-theme") {
      buf = Buffer.from(genIos(withWp.colors, name, doc.wallpaperSlug || null, options), "utf-8");
    }
    if (!buf) return null;

    // Roundtrip validation: the output must parse back to a non-empty colors map
    // If it fails, fall back to the raw text (still better than null)
    try {
      const parser = target === "attheme" ? parseAttheme
        : target === "tdesktop-theme" ? parseDesktop
        : target === "tgx-theme" ? parseTgx
        : parseIos;
      const back = parser(buf);
      if (!back || Object.keys(back.colors).length === 0) {
        console.warn(`[theme] renderDoc roundtrip empty for ${target}, using original`);
      }
    } catch {
      console.warn(`[theme] renderDoc roundtrip failed for ${target}, using original`);
    }
    return buf;
  } catch { return null; }
}

// ─── State management ────────────────────────────────────────────────────────

function genSlug(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

// ─── Download helper ─────────────────────────────────────────────────────────

async function downloadMedia(
  msg: Api.Message,
  client: TelegramClient,
): Promise<Buffer | null> {
  try {
    const raw = await client.downloadMedia(msg, { outputFile: Buffer.alloc(0) });
    if (!raw) return null;
    if (Buffer.isBuffer(raw)) return raw;
    if (typeof raw === "string") return fs.readFileSync(raw);
    return Buffer.from(raw as ArrayBuffer);
  } catch { return null; }
}

// ─── Help text ───────────────────────────────────────────────────────────────

function buildHelpText(): string {
  return html`
<b>🎨 主题转换器</b>

<b>用法</b>
• 发送主题文件 → 自动转换全部格式 + 云端 settings
• <code>${mainPrefix}theme &lt;客户端&gt;</code> <i>(回复文件)</i> → 转到指定引擎
• <code>${mainPrefix}theme link t.me/addtheme/xxx</code> → 拉取云端主题
• <code>${mainPrefix}theme cloud</code> <i>(回复文件)</i> → 上传文件主题
• <code>${mainPrefix}theme cloud-settings</code> <i>(回复文件)</i> → 创建云端 accent 主题（Unigram/Web）

<b>官方文件格式（仅 4 种）</b>
• <code>android</code> → .attheme（Nekogram / Nicegram 等同）
• <code>desktop</code> → .tdesktop-theme（64Gram / Kotatogram / AyuGram 等同）
• <code>tgx</code> / <code>macos</code> → .tgx-theme
• <code>ios</code> → .tgios-theme

<b>无独立文件的客户端</b>
• Unigram / Telegram Web / WebK / WebA → 使用云端 <code>themeSettings</code>
  （link 输出会附带 settings JSON；也可用 <code>cloud-settings</code>）
  `;
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

class ThemePlugin extends Plugin {
  name = "theme";
  description = "🎨 主题转换器 | Android↔Desktop↔TGX↔iOS";

  cmdHandlers = {
    theme: this.handleCmd.bind(this),
  };

  listenMessageHandlerIgnoreEdited = true;

  /** In-flight addtheme slug → promise (dedupe concurrent link fetches) */
  private readonly inflightLinks = new Map<string, Promise<void>>();

  async handleCmd(msg: Api.Message): Promise<void> {
    const parts = (msg.message ?? "").trim().split(/\s+/).slice(1);
    const sub = parts[0]?.toLowerCase() || "";
    const client = await getGlobalClient();

    // ── Help ────────────────────────────────────────────────────────────
    if (!sub || sub === "help") {
      await msg.edit({ text: buildHelpText(), parseMode: "html" });
      return;
    }

    // ── link ────────────────────────────────────────────────────────────
    if (sub === "link" && parts[1]) {
      const linkMatch = parts[1].match(/(?:https?:\/\/)?t\.me\/addtheme\/([a-zA-Z0-9_\-\.]+)/);
      if (linkMatch) {
        await this.handleAddThemeLink(msg, linkMatch[1]);
        return;
      }
      await msg.edit({ text: html`❌ 无效链接，格式: <code>t.me/addtheme/xxx</code>`, parseMode: "html" });
      return;
    }

    // ── cloud ───────────────────────────────────────────────────────────
    if (sub === "cloud") {
      await this.handleCloudUpload(msg);
      return;
    }

    // ── cloud-settings: createTheme with InputThemeSettings (Unigram/Web) ─
    if (sub === "cloud-settings" || sub === "settings" || sub === "cloudsettings") {
      await this.handleCloudSettingsUpload(msg);
      return;
    }

    // ── clients: list supported engines ─────────────────────────────────
    if (sub === "clients" || sub === "list") {
      await msg.edit({
        text: html`
<b>支持的客户端 / 引擎</b>

<b>有独立主题文件（API format）</b>
• Android / Nekogram / Nicegram / … → <code>android</code> · .attheme
• Desktop / 64Gram / Kotatogram / AyuGram → <code>desktop</code> · .tdesktop-theme
• Telegram X / macOS → <code>tgx</code> / <code>macos</code> · .tgx-theme
• iOS → <code>ios</code> · .tgios-theme

<b>仅云端 themeSettings（无专有文件）</b>
• Unigram · Telegram Web / WebK / WebA
  → 使用 <code>${mainPrefix}theme cloud-settings</code> 或 link 附带的 settings JSON

<i>官方 API 没有第 5 种文件 format；第三方客户端要么复用上述引擎，要么只吃 accent/settings。</i>
        `, parseMode: "html" });
      return;
    }

    // ── direct conversion to target client ──────────────────────────────
    const target = TARGET_ALIASES[sub];
    if (target) {
      await this.handleConvertToTarget(msg, target);
      return;
    }

    // fallback: show help
    await msg.edit({ text: buildHelpText(), parseMode: "html" });
  }

  // ── listen: file attachments + t.me/addtheme links ───────────────────

  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    try {
      const text = msg.message?.trim();

      // t.me/addtheme link in any message
      if (text) {
        const addthemeMatch = text.match(/(?:https?:\/\/)?t\.me\/addtheme\/([a-zA-Z0-9_\-\.]+)/);
        if (addthemeMatch) {
          await this.handleAddThemeLink(msg, addthemeMatch[1]);
          return;
        }
      }

      // theme file attached
      const docInfo = (msg as any).document as Api.Document | undefined;
      if (!docInfo) return;
      const name = documentAttributeFileName(docInfo).toLowerCase();
      const size = Number(docInfo.size || 0);
      if (size > MAX_FILE_SIZE || size === 0) return;
      if (!name.endsWith(".attheme") && !name.endsWith(".tdesktop-theme") && !name.endsWith(".tgios-theme") && !name.endsWith(".tgx-theme") && !name.endsWith(".json") && !name.endsWith(".tdesktop-palette") && !name.includes("theme") && !name.includes("tgx") && !name.includes("settings")) return;

      await msg.edit({ text: html`⏳ 解析主题文件...`, parseMode: "html" });
      const client = await getGlobalClient();
      const buf = await downloadMedia(msg, client);
      if (!buf || buf.length === 0) return;
      // cloud-settings JSON first, then binary formats
      const cloudDoc = parseCloudSettingsJson(buf);
      if (cloudDoc) {
        const baseName = (documentAttributeFileName(docInfo) || "cloud-theme").replace(/\.[^.]+$/, "") || "theme";
        await msg.edit({ text: html`⏳ 识别为云端 themeSettings JSON，转换四端…`, parseMode: "html" });
        // Materialize as synthetic attheme buffer is unnecessary — feed colors via render path
        // by building a minimal attheme for the pipeline
        const lines = genAndroid(cloudDoc.colors);
        const att = attachAtthemeWallpaper(lines.join("\n") + "\n", cloudDoc.wallpaper || null);
        // stash slug meta into a sidecar by re-parsing after we inject via fmtMap + bestDoc merge
        // Prefer: put JSON-derived doc through sendThemeResults using a synthetic map
        const slugHint = cloudDoc.wallpaperSlug || null;
        await this.sendThemeResults(
          msg,
          baseName,
          baseName.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(0, 48) || genSlug(),
          { attheme: { format: "attheme", buf: att }, ...(slugHint ? { __cloudSlug: slugHint, __cloudDoc: cloudDoc } as any : { __cloudDoc: cloudDoc } as any) },
          true,
          null,
        );
        return;
      }
      const format = detectFmt(buf);
      if (!format) {
        await msg.edit({ text: html`❌ 无法识别格式，支持 .attheme / .tdesktop-theme / .tgx-theme / .tgios-theme / cloud-settings.json<br/><br/>使用 <code>${mainPrefix}theme</code> 查看帮助`, parseMode: "html" });
        return;
      }
      // Route through the same lossless multi-format pipeline as link
      const baseName = (documentAttributeFileName(docInfo) || "theme").replace(/\.[^.]+$/, "") || "theme";
      await this.sendThemeResults(
        msg,
        baseName,
        baseName.replace(/[^a-zA-Z0-9_\-\.]/g, "_").slice(0, 48) || genSlug(),
        { [format]: { format, buf } },
        false,
        null,
      );
    } catch (e) {
      console.error("[theme] listen:", e);
    }
  };

  // ── Download a raw TL document correctly ────────────────────────────
  // teleproto downloadFile needs InputDocumentFileLocation, not InputDocument
  // Keep document ids, access hashes, and sizes as BigInteger values.
  /** slug → base64 image */
  private readonly wallpaperSlugCache = new Map<string, string>();
  /** contentHash → slug (reverse lookup without O(n) buffer equals) */
  private readonly wallpaperHashToSlug = new Map<string, string>();

  private cacheWallpaper(slug: string, img: Buffer): void {
    const b64 = img.toString("base64");
    this.wallpaperSlugCache.set(slug, b64);
    this.wallpaperHashToSlug.set(wallpaperContentHash(img), slug);
    // Bound memory: keep last ~40 entries
    if (this.wallpaperSlugCache.size > 40) {
      const first = this.wallpaperSlugCache.keys().next().value;
      if (first) {
        const oldB64 = this.wallpaperSlugCache.get(first);
        this.wallpaperSlugCache.delete(first);
        if (oldB64) {
          try {
            const h = wallpaperContentHash(Buffer.from(oldB64, "base64"));
            if (this.wallpaperHashToSlug.get(h) === first) this.wallpaperHashToSlug.delete(h);
          } catch { /* */ }
        }
      }
    }
  }

  private async downloadTlDocument(
    client: TelegramClient,
    doc: any,
    retries = 2,
  ): Promise<Buffer | null> {
    if (!doc || doc.id == null || doc.accessHash == null) return null;
    const location = new Api.InputDocumentFileLocation({
      id: toLong(doc.id),
      accessHash: toLong(doc.accessHash),
      fileReference: toBytes(doc.fileReference),
      thumbSize: "",
    });
    const fileSize = doc.size == null ? undefined : toLong(doc.size);
    let dcId = doc.dcId == null ? undefined : Number(doc.dcId);
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const migrateDc = (error: unknown): number | undefined => {
      const match = getErrorMessage(error).match(/(?:FILE_)?MIGRATE[_ ](\d+)/i);
      return match ? Number(match[1]) : undefined;
    };
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const raw = await client.downloadFile(location, {
          outputFile: Buffer.alloc(0),
          fileSize,
          dcId,
        });
        if (Buffer.isBuffer(raw) && raw.length) return raw;
        if (typeof raw === "string") {
          const data = fs.readFileSync(raw);
          try { fs.unlinkSync(raw); } catch { /* best effort */ }
          if (data.length) return data;
        }
      } catch (error) {
        const migrated = migrateDc(error);
        if (migrated != null) dcId = migrated;
        const flood = getErrorMessage(error).match(/FLOOD_WAIT[_ ]?(\d+)/i);
        if (flood) await sleep(Math.min(30, Number(flood[1])) * 1000);
        if (attempt === retries) console.warn("[theme] document download failed:", getErrorMessage(error));
      }
    }
    return null;
  }

  /** Resolve iOS cloud wallpaper slug → image bytes via account.getWallPaper */
  private async downloadWallpaperBySlug(
    client: TelegramClient,
    slug: string,
  ): Promise<Buffer | null> {
    if (!slug || slug.length < 4) return null;
    try {
      const wp: any = await client.invoke(new Api.account.GetWallPaper({
        wallpaper: new Api.InputWallPaperSlug({ slug }),
      }));
      if (hasTlType(wp, "wallPaper") && hasTlType(wp.document, "document")) {
        return await this.downloadTlDocument(client, wp.document);
      }
      return null;
    } catch (e) {
      console.warn("[theme] getWallPaper failed:", getErrorMessage(e));
      return null;
    }
  }

  /**
   * Upload image bytes as cloud wallpaper and return its slug for iOS
   * `chat.defaultWallpaper: <slug>`.
   */
  private async uploadWallpaperForIos(
    client: TelegramClient,
    image: Buffer,
  ): Promise<string | null> {
    try {
      const wp = normalizeWallpaper(image);
      if (!wp) return null;
      const ext = detectImageExt(wp) === "png" ? "png" : "jpg";
      const mime = ext === "png" ? "image/png" : "image/jpeg";
      const uploaded: any = await client.uploadFile({ file: new CustomFile(`theme-wallpaper.${ext}`, Buffer.isBuffer(wp) ? wp.length : Buffer.from(wp as any).length, "", Buffer.isBuffer(wp) ? wp : Buffer.from(wp as any)) });
      // uploadFile may return InputFile or document-like — prefer inputFile for uploadWallPaper
      let inputFile: any = uploaded;
      if (uploaded && uploaded._ !== "inputFile" && uploaded._ !== "inputFileBig") {
        // Some API responses wrap the uploaded wallpaper
        if (uploaded.inputFile) inputFile = uploaded.inputFile;
        else if (uploaded.file) inputFile = uploaded.file;
      }
      const result: any = await client.invoke(new Api.account.UploadWallPaper({
        file: inputFile,
        mimeType: mime,
        settings: new Api.WallPaperSettings({ blur: false, motion: false, intensity: 50 }),
      }));
      if (hasTlType(result, "wallPaper") && result.slug) {
        return String(result.slug);
      }
      console.warn("[theme] uploadWallPaper unexpected:", tlType(result));
      return null;
    } catch (e) {
      console.warn("[theme] uploadWallPaper failed:", getErrorMessage(e));
      return null;
    }
  }

  /** Ensure ThemeDoc has wallpaper bytes if only iOS slug is known */
  private async resolveWallpaperBytes(
    client: TelegramClient,
    doc: ThemeDoc,
  ): Promise<ThemeDoc> {
    if (normalizeWallpaper(doc.wallpaper || null)) return doc;
    if (doc.wallpaperSlug) {
      const cached = this.wallpaperSlugCache.get(doc.wallpaperSlug);
      if (cached) {
        return { ...doc, wallpaper: Buffer.from(cached, "base64") };
      }
      const img = await this.downloadWallpaperBySlug(client, doc.wallpaperSlug);
      if (img) {
        this.cacheWallpaper(doc.wallpaperSlug, img);
        return { ...doc, wallpaper: img };
      }
    }
    return doc;
  }

  /**
   * Ensure ThemeDoc has cloud wallpaper slug if only image bytes are known.
   * Used for BOTH iOS (defaultWallpaper) and TGX (wallpaper: slug).
   */
  private async ensureIosWallpaperSlug(
    client: TelegramClient,
    doc: ThemeDoc,
  ): Promise<ThemeDoc> {
    if (doc.wallpaperSlug) return doc;
    const wp = normalizeWallpaper(doc.wallpaper || null);
    if (!wp) return doc;
    // O(1) reverse cache by content hash
    const hit = this.wallpaperHashToSlug.get(wallpaperContentHash(wp));
    if (hit) return { ...doc, wallpaperSlug: hit };
    const slug = await this.uploadWallpaperForIos(client, wp);
    if (slug) {
      this.cacheWallpaper(slug, wp);
      return { ...doc, wallpaperSlug: slug };
    }
    return doc;
  }

  /** Infer ThemeFormat from mime / filename / content */
  private inferThemeFormat(doc: any, buf: Buffer): ThemeFormat | null {
    const mime = (doc.mimeType || "").toLowerCase();
    const name = ((doc.attributes || []).find((a: any) => hasTlType(a, "documentAttributeFilename"))?.fileName || "").toLowerCase();
    if (mime.includes("tgtheme-android") || name.endsWith(".attheme")) return "attheme";
    if (mime.includes("tgtheme-tdesktop") || name.endsWith(".tdesktop-theme")) return "tdesktop-theme";
    if (mime.includes("tgtheme-macos") || name.includes("tgx") || name.endsWith(".tgx-theme")) return "tgx-theme";
    if (mime.includes("tgtheme-ios") || name.endsWith(".tgios-theme") || name.endsWith(".ios-theme")) return "ios-theme";
    return detectFmt(buf);
  }

  /** Collect themeSettings from theme / webPageAttributeTheme.
   *  Prefer the entry with wallpaper, else richest accent data. */
  private collectThemeSettings(source: any): any | null {
    if (!source) return null;
    const candidates: any[] = [];
    const push = (s: any) => {
      if (!s) return;
      if (Array.isArray(s)) { for (const x of s) push(x); return; }
      if (hasTlType(s, "themeSettings") || s.accentColor != null || s.baseTheme || s.wallpaper) candidates.push(s);
    };
    if (hasTlType(source, "themeSettings") || source.accentColor != null || source.baseTheme) push(source);
    push(source.settings);
    for (const attr of source.attributes || []) {
      if (hasTlType(attr, "webPageAttributeTheme")) push(attr.settings);
    }
    if (!candidates.length) return null;
    // Prefer settings that carry a downloadable / slug wallpaper
    const score = (s: any) => {
      let n = 0;
      if (s.wallpaper) n += 10;
      if (hasTlType(s.wallpaper, "wallPaper") && s.wallpaper.document) n += 20;
      if (typeof s.wallpaper?.slug === "string" && s.wallpaper.slug.length > 4) n += 15;
      if (s.accentColor != null) n += 3;
      if (s.outboxAccentColor != null) n += 2;
      if (Array.isArray(s.messageColors) && s.messageColors.length) n += 2;
      if (s.baseTheme) n += 1;
      return n;
    };
    candidates.sort((a, b) => score(b) - score(a));
    return candidates[0];
  }

  /** Download wallpaper image document from themeSettings.wallpaper (wallPaper) */
  private async downloadWallpaperFromSettings(
    client: TelegramClient,
    settings: any,
  ): Promise<{ bytes: Buffer | null; slug: string | null; blur: number; motion: boolean }> {
    try {
      const wp = settings?.wallpaper;
      if (!wp) return { bytes: null, slug: null, blur: 0, motion: true };
      // wallPaper { document, slug, settings } | wallPaperNoFile
      const slug = (hasTlType(wp, "wallPaper") && typeof wp.slug === "string" && wp.slug.length > 8)
        ? wp.slug
        : null;
      // Extract wallpaper options from wallpaper settings
      const wpSettings = wp.settings || {};
      const blur = (typeof wpSettings.blur === "number" ? wpSettings.blur : 0);
      const motion = wpSettings.motion !== false;
      if (hasTlType(wp, "wallPaper") && hasTlType(wp.document, "document")) {
        const bytes = await this.downloadTlDocument(client, wp.document);
        return { bytes, slug, blur, motion };
      }
      if (hasTlType(wp.document, "document")) {
        const bytes = await this.downloadTlDocument(client, wp.document);
        return { bytes, slug, blur, motion };
      }
      return { bytes: null, slug, blur, motion };
    } catch (e) {
      console.warn("[theme] wallpaper download failed:", getErrorMessage(e));
      return { bytes: null, slug: null, blur: 0, motion: true };
    }
  }

  /** If only settings exist, synthesize all client formats from accent colors (+ wallpaper) */
  private synthesizeFromSettings(
    settings: any,
    title: string,
    wallpaper?: Buffer | null,
    wallpaperSlug?: string | null,
    wallpaperBlur?: number,
    wallpaperMotion?: boolean,
  ): Record<string, { format: ThemeFormat; buf: Buffer }> | null {
    const colors = colorsFromThemeSettings(settings);
    if (!Object.keys(colors).length) return null;
    const base = String(settings?.baseTheme || settings?.baseTheme?._ || "");
    const basedOn = /night|dark/i.test(base) ? "night" : /classic/i.test(base) ? "classic" : "day";
    const doc: ThemeDoc = {
      format: "attheme",
      colors,
      wallpaper: normalizeWallpaper(wallpaper || null),
      wallpaperSlug: wallpaperSlug || null,
      wallpaperBlur: wallpaperBlur ?? 0,
      wallpaperMotion: wallpaperMotion ?? true,
      basedOn,
    };
    const fmtMap: Record<string, { format: ThemeFormat; buf: Buffer }> = {};
    for (const format of ["attheme", "tdesktop-theme", "tgx-theme", "ios-theme"] as ThemeFormat[]) {
      const buf = renderDoc(doc, format, title);
      if (buf) fmtMap[format] = { format, buf };
    }
    // stash wallpaper for sidecar send via special key on first entry — callers use parse path
    (fmtMap as any).__wallpaper = doc.wallpaper || null;
    (fmtMap as any).__wallpaperSlug = doc.wallpaperSlug || null;
    (fmtMap as any).__wallpaperBlur = doc.wallpaperBlur;
    (fmtMap as any).__wallpaperMotion = doc.wallpaperMotion;
    return Object.keys(fmtMap).length ? fmtMap : null;
  }

  // ── Handle t.me/addtheme/SLUG ────────────────────────────────────────

  private async handleAddThemeLink(msg: Api.Message, slug: string): Promise<void> {
    const key = slug.toLowerCase();
    const existing = this.inflightLinks.get(key);
    if (existing) {
      try {
        await msg.edit({ text: html`⏳ 主题 <code>${slug}</code> 已在处理中，请稍候…`, parseMode: "html" });
      } catch { /* */ }
      try { await existing; } catch { /* primary handler reports */ }
      return;
    }
    const run = this.handleAddThemeLinkInner(msg, slug).finally(() => {
      if (this.inflightLinks.get(key) === run) this.inflightLinks.delete(key);
    });
    this.inflightLinks.set(key, run);
    await run;
  }

  private async handleAddThemeLinkInner(msg: Api.Message, slug: string): Promise<void> {
    const client = await getGlobalClient();
    try {
      await msg.edit({ text: html`⏳ 获取主题 <code>${slug}</code>...`, parseMode: "html" });

      const fmtMap: Record<string, { format: ThemeFormat; buf: Buffer }> = {};
      let themeTitle = slug;
      const errors: string[] = [];
      let settingsFallback: any = null;
      const url = `https://t.me/addtheme/${slug}`;

      // ── Strategy 1: messages.getWebPage (like clients do) ──────────────
      // This is what real Telegram clients use and works for cloud accent themes.
      let webPage: any = null;
      try {
        const wpResult: any = await client.invoke(new Api.messages.GetWebPage({
          url,
          hash: 0,
        }));
        if (hasTlType(wpResult, "messages.webPage") && hasTlType(wpResult.webpage, "webPage")) {
          webPage = wpResult.webpage;
        } else if (hasTlType(wpResult?.webpage, "webPage")) {
          webPage = wpResult.webpage;
        } else if (hasTlType(wpResult, "webPage")) {
          webPage = wpResult;
        }
      } catch (e) {
        errors.push(`getWebPage: ${getErrorMessage(e)}`);
      }

      if (!webPage) {
        try {
          const preview: any = await client.invoke(new Api.messages.GetWebPagePreview({
            message: url,
          }));
          const media = preview?.media || preview;
          if (hasTlType(media, "messageMediaWebPage") && hasTlType(media.webpage, "webPage")) {
            webPage = media.webpage;
          }
        } catch (e) {
          errors.push(`getWebPagePreview: ${getErrorMessage(e)}`);
        }
      }

      if (webPage?.title) themeTitle = webPage.title;
      if (webPage) settingsFallback = this.collectThemeSettings(webPage);

      // Collect documents from webPageAttributeTheme
      const docs: any[] = [];
      if (webPage) {
        for (const attr of webPage.attributes || []) {
          if (hasTlType(attr, "webPageAttributeTheme") && Array.isArray(attr.documents)) {
            for (const d of attr.documents) {
              if (hasTlType(d, "document")) docs.push(d);
            }
          }
        }
        if (webPage.document?._ === "document") docs.push(webPage.document);
      }

      let idx = 0;
      // Parallel download all webpage theme documents
      if (docs.length) {
        const results = await Promise.all(docs.map(async (doc, i) => {
          const buf = await this.downloadTlDocument(client, doc);
          return { i, doc, buf };
        }));
        for (const r of results) {
          if (!r.buf) {
            errors.push(`doc#${r.i}: download failed`);
            continue;
          }
          const format = this.inferThemeFormat(r.doc, r.buf);
          if (!format) {
            errors.push(`doc#${r.i}: unknown format mime=${r.doc.mimeType}`);
            continue;
          }
          if (!fmtMap[format]) fmtMap[format] = { format, buf: r.buf };
        }
        idx = docs.length;
      }

      // Always try themeSettings wallpaper early (mobile-correct cloud image)
      let settingsWpBytes: Buffer | null = null;
      let settingsWpSlug: string | null = null;
      let settingsWpBlur = 0;
      let settingsWpMotion = true;
      if (settingsFallback) {
        const wpInfo = await this.downloadWallpaperFromSettings(client, settingsFallback);
        settingsWpBytes = wpInfo.bytes;
        settingsWpSlug = wpInfo.slug;
        settingsWpBlur = wpInfo.blur;
        settingsWpMotion = wpInfo.motion;
      }

      // ── Strategy 3: account.getTheme — MUST fetch Android before deliver ──
      // ROOT CAUSE of Desktop wallpaper fallback:
      // webpage often ships only Desktop (or Desktop+iOS) documents. Old code
      // returned immediately when fmtMap had ANY format, never calling
      // getTheme("android"). Mobile outputs then fell back to Desktop crop.
      // Fix: always attempt getTheme for missing formats, Android first.
      const apiFormats = ["android", "ios", "macos", "tdesktop"] as const;
      const apiToFmt = {
        android: "attheme",
        tdesktop: "tdesktop-theme",
        macos: "tgx-theme",
        ios: "ios-theme",
      } as const;
      // Prefer missing mobile formats; still fill Desktop if absent
      // Parallel getTheme for all missing formats (android first in list order for logging only)
      const missingFormats = apiFormats.filter(f => !fmtMap[apiToFmt[f]]);
      if (missingFormats.length) {
        const results = await Promise.all(missingFormats.map(async (f) => {
          try {
            const raw: any = await client.invoke(new Api.account.GetTheme({
              format: f,
              theme: new Api.InputThemeSlug({ slug }),
            }));
            if (!hasTlType(raw, "theme")) return { f, raw: null as any, buf: null as Buffer | null, err: null as string | null };
            let buf: Buffer | null = null;
            if (hasTlType(raw.document, "document")) {
              buf = await this.downloadTlDocument(client, raw.document);
              if (!buf) return { f, raw, buf: null, err: `getTheme(${f}): download failed` };
            }
            return { f, raw, buf, err: null };
          } catch (e) {
            return { f, raw: null as any, buf: null as Buffer | null, err: `getTheme(${f}): ${getErrorMessage(e)}` };
          }
        }));
        // Apply android first so mobile wallpaper source is preferred when multiple arrive
        const order = ["android", "ios", "macos", "tdesktop"] as const;
        results.sort((a, b) => order.indexOf(a.f as any) - order.indexOf(b.f as any));
        for (const r of results) {
          if (r.err) { errors.push(r.err); continue; }
          if (!r.raw) continue;
          if (r.raw.title) themeTitle = r.raw.title;
          if (!settingsFallback) {
            settingsFallback = this.collectThemeSettings(r.raw);
            if (settingsFallback && !settingsWpBytes) {
              const wpInfo = await this.downloadWallpaperFromSettings(client, settingsFallback);
              settingsWpBytes = wpInfo.bytes;
              settingsWpSlug = wpInfo.slug || settingsWpSlug;
              settingsWpBlur = wpInfo.blur;
              settingsWpMotion = wpInfo.motion;
            }
          }
          if (r.buf) {
            const want = apiToFmt[r.f];
            const format = this.inferThemeFormat(r.raw.document, r.buf) || want;
            if (!fmtMap[format]) fmtMap[format] = { format, buf: r.buf };
          }
        }
      }

      // Stash settings wallpaper for sendThemeResults (mobile priority extras)
      if (settingsWpBytes) {
        (fmtMap as any).__wallpaper = settingsWpBytes;
        (fmtMap as any).__wallpaperSlug = settingsWpSlug;
        (fmtMap as any).__wallpaperBlur = settingsWpBlur;
        (fmtMap as any).__wallpaperMotion = settingsWpMotion;
      }

      if (Object.keys(fmtMap).filter(k => !k.startsWith("__")).length > 0) {
        console.info(
          `[theme] link ${slug}: formats=${Object.keys(fmtMap).filter(k => !k.startsWith("__")).join(",")} ` +
          `android=${!!fmtMap.attheme} desktop=${!!fmtMap["tdesktop-theme"]} settingsWp=${!!settingsWpBytes}`,
        );
        await this.sendThemeResults(msg, themeTitle, slug, fmtMap, false, settingsWpBytes);
        return;
      }

      // ── Strategy 2/final: synthesize from themeSettings (no documents at all) ──
      if (settingsFallback) {
        const synth = this.synthesizeFromSettings(
          settingsFallback, themeTitle, settingsWpBytes, settingsWpSlug, settingsWpBlur, settingsWpMotion,
        );
        if (synth && Object.keys(synth).length > 0) {
          await this.sendThemeResults(msg, themeTitle, slug, synth, true, settingsWpBytes);
          return;
        }
        const accent = settingsFallback.accentColor;
        errors.push(`synth: accent=${accent} base=${settingsFallback.baseTheme} wp=${!!settingsFallback.wallpaper}`);
      }

      if (!webPage) {
        await msg.edit({
          text: html`
❌ 无法获取主题 <code>${slug}</code>
<br/><br/><i>调试: ${errors.slice(0, 3).join(" | ") || "无响应"}</i>
          `, parseMode: "html" });
        return;
      }

      await msg.edit({
        text: html`
📄 <b>${themeTitle}</b>
🔗 <code>t.me/addtheme/${slug}</code>
${webPage.description ? `<br/>${webPage.description}` : ""}
<br/><br/><i>未找到可下载主题文件，且无法从颜色设置合成</i>
<br/><i>type=${webPage.type || "?"} attrs=${(webPage.attributes || []).map((a: any) => a._).join(",") || "none"} docs=${docs.length}</i>
<br/><i>${errors.slice(0, 3).join(" | ")}</i>
        `, parseMode: "html" });
    } catch (e: any) {
      console.error("[theme] handleAddThemeLink:", e);
      await msg.edit({ text: html`❌ 获取失败: ${getErrorMessage(e)}`, parseMode: "html" });
    }
  }

  /** Shared: parse + convert downloaded theme files, send results */
  private async sendThemeResults(
    msg: Api.Message,
    title: string,
    slug: string,
    fmtMap: Record<string, { format: ThemeFormat; buf: Buffer }>,
    synthesized = false,
    extraWallpaper?: Buffer | null,
  ): Promise<void> {
    const client = await getGlobalClient();
    const t0 = Date.now();
    try {
      await msg.edit({ text: html`⏳ <b>${title}</b>\n🔗 <code>t.me/addtheme/${slug}</code>\n解析并合并配色…`, parseMode: "html" });
    } catch { /* */ }

    const byFormat = new Map<ThemeFormat, Buffer>();
    for (const [k, info] of Object.entries(fmtMap)) {
      if (k.startsWith("__")) continue;
      if (info && info.format && info.buf && !byFormat.has(info.format)) byFormat.set(info.format, info.buf);
    }

    // Wallpaper source priority: Android first (mobile), then iOS/TGX, Desktop last.
    // Official multi-format themes often ship DIFFERENT wallpapers per platform;
    // Android / TGX / iOS are mobile — share Android wallpaper when available.
    const parseByFmt = (fmt: ThemeFormat, buf: Buffer): ThemeDoc | null => {
      return parseThemeBuffer(buf, fmt);
    };

    // Collect per-format parsed docs (for wallpaper + slug)
    const parsedByFmt = new Map<ThemeFormat, ThemeDoc>();
    for (const [fmt, buf] of byFormat) {
      const doc = parseByFmt(fmt, buf);
      if (doc) parsedByFmt.set(fmt, doc);
    }

    // LOSSLESS colors: merge ALL source formats (wallpaper bytes intentionally excluded)
    const colorPickOrder: ThemeFormat[] = ["attheme", "ios-theme", "tgx-theme", "tdesktop-theme"];
    const allDocs = colorPickOrder
      .map(f => parsedByFmt.get(f))
      .filter((d): d is ThemeDoc => !!d);
    for (const [, doc] of parsedByFmt) {
      if (!allDocs.includes(doc)) allDocs.push(doc);
    }

    let bestDoc: ThemeDoc | null = mergeThemeDocs(allDocs, colorPickOrder);
    let bestFmt: ThemeFormat | null = bestDoc?.format || null;
    let bestCount = bestDoc ? Object.keys(bestDoc.colors).length : 0;
    const sourceFmts = allDocs.map(d => d.format);

    // Cloud-settings JSON sidecar (from listen path): merge slug/basedOn/colors
    const cloudSidecar = (fmtMap as any).__cloudDoc as ThemeDoc | undefined;
    if (cloudSidecar && Object.keys(cloudSidecar.colors || {}).length) {
      bestDoc = mergeThemeDocs(
        [cloudSidecar, ...(bestDoc ? [bestDoc] : [])],
        colorPickOrder,
      ) || bestDoc || cloudSidecar;
      if (!bestDoc.wallpaperSlug && cloudSidecar.wallpaperSlug) bestDoc.wallpaperSlug = cloudSidecar.wallpaperSlug;
      if (cloudSidecar.basedOn) bestDoc.basedOn = cloudSidecar.basedOn;
      if (cloudSidecar.wallpaperBlur != null) bestDoc.wallpaperBlur = cloudSidecar.wallpaperBlur;
      if (cloudSidecar.wallpaperMotion != null) bestDoc.wallpaperMotion = cloudSidecar.wallpaperMotion;
      bestCount = Object.keys(bestDoc.colors).length;
      bestFmt = bestFmt || cloudSidecar.format;
    }
    if ((fmtMap as any).__cloudSlug && bestDoc && !bestDoc.wallpaperSlug) {
      bestDoc.wallpaperSlug = String((fmtMap as any).__cloudSlug);
    }

    if (!bestDoc || bestCount === 0) {
      for (const fmt of colorPickOrder) {
        const doc = parsedByFmt.get(fmt);
        if (!doc) continue;
        const cc = Object.keys(doc.colors).length;
        if (cc > bestCount) {
          bestDoc = { ...doc, wallpaper: null }; // strip desktop bytes from fallback base
          bestFmt = fmt;
          bestCount = cc;
        }
      }
    }

    // Resolve iOS/TGX slug → bytes so they can beat Desktop in pickMobileWallpaper
    for (const fmt of ["ios-theme", "tgx-theme"] as ThemeFormat[]) {
      const d = parsedByFmt.get(fmt);
      if (d?.wallpaperSlug && !normalizeWallpaper(d.wallpaper || null)) {
        const resolved = await this.resolveWallpaperBytes(client, d);
        parsedByFmt.set(fmt, resolved);
      }
    }
    // Re-merge colors/slug metadata after resolve (still no wallpaper bytes)
    if (bestDoc) {
      bestDoc = mergeThemeDocs(
        colorPickOrder.map(f => parsedByFmt.get(f)).filter((x): x is ThemeDoc => !!x),
        colorPickOrder,
      ) || bestDoc;
      bestCount = Object.keys(bestDoc.colors).length;
    }

    // ── MOBILE wallpaper pick (Android absolute priority) ──
    // NEVER seed from bestDoc.wallpaper (merge no longer carries bytes).
    // NEVER use Desktop crop for mobile — BiliBiliDarkByMiku proves Android can
    // ship wallpaperFileOffset=-1 while only Desktop has background.jpg.
    const settingsWp = normalizeWallpaper(extraWallpaper || null)
      || normalizeWallpaper((fmtMap as any).__wallpaper || null);
    const mobilePick = pickMobileWallpaper(parsedByFmt, {
      settingsWp,
      extraWp: settingsWp,
    });
    let wallpaper: Buffer | null = mobilePick.wallpaper;
    let wallpaperSlug: string | null = mobilePick.slug || bestDoc?.wallpaperSlug || (fmtMap as any).__wallpaperSlug || null;
    let wallpaperSource: string | null = mobilePick.source;
    let wallpaperBlur = mobilePick.blur ?? bestDoc?.wallpaperBlur ?? (fmtMap as any).__wallpaperBlur;
    let wallpaperMotion = mobilePick.motion ?? bestDoc?.wallpaperMotion ?? (fmtMap as any).__wallpaperMotion;

    // last chance: resolve remaining mobile slug → bytes (still not Desktop)
    if (!wallpaper && wallpaperSlug) {
      const img = await this.downloadWallpaperBySlug(client, wallpaperSlug);
      if (img) {
        wallpaper = img;
        wallpaperSource = wallpaperSource || "ios-slug";
      }
    }

    // Desktop own wallpaper (SEPARATE — never fed into mobile shared wallpaper)
    const desktopPick = pickDesktopWallpaper(parsedByFmt, null /* do not inject mobile into desktop pick source label */);
    // If Desktop has no own wp but mobile has one, Desktop may use mobile (ok for desktop)
    const desktopWallpaper = desktopPick.wallpaper || wallpaper;
    const wallpaperTiled = desktopPick.tiled;
    const desktopKeptOwn = desktopPick.keptOwn;

    console.info(
      `[theme] wallpaper pick slug=${slug}: mobileSrc=${wallpaperSource || "none"} ` +
      `androidWp=${!!normalizeWallpaper(parsedByFmt.get("attheme")?.wallpaper || null)} ` +
      `desktopOwn=${desktopKeptOwn} mobileBytes=${!!wallpaper} desktopBytes=${!!desktopWallpaper}`,
    );

    if (bestDoc) {
      // bestDoc.wallpaper = MOBILE shared image only (never Desktop crop for mobile gens)
      bestDoc = {
        ...bestDoc,
        wallpaper,
        wallpaperSlug,
        wallpaperTiled: false,
        wallpaperBlur,
        wallpaperMotion,
      };
      // Upload mobile image → iOS/TGX cloud slug
      if (!bestDoc.wallpaperSlug && normalizeWallpaper(bestDoc.wallpaper || null)) {
        bestDoc = await this.ensureIosWallpaperSlug(client, bestDoc);
        wallpaperSlug = bestDoc.wallpaperSlug || null;
      }
      wallpaper = normalizeWallpaper(bestDoc.wallpaper || null) || wallpaper;
      wallpaperSlug = bestDoc.wallpaperSlug || wallpaperSlug;
      bestCount = Object.keys(bestDoc.colors).length;
    }

    if (!bestDoc || !bestFmt) {
      for (const [fmt, buf] of byFormat) {
        const det = detectFmt(buf);
        if (!det) continue;
        const parser = det === "attheme" ? parseAttheme : det === "tdesktop-theme" ? parseDesktop : det === "tgx-theme" ? parseTgx : parseIos;
        const doc = parser(buf);
        if (doc && Object.keys(doc.colors).length > bestCount) {
          // strip any wallpaper from this fallback; use mobile pick only
          bestDoc = { ...doc, wallpaper, wallpaperSlug };
          bestFmt = det;
          bestCount = Object.keys(doc.colors).length;
        }
      }
    }

    if (!bestDoc || !bestFmt) {
      const sentRaw: string[] = [];
      for (const [fmt, buf] of byFormat) {
        await sendThemeDocument(client, msg.peerId, Buffer.isBuffer(buf) ? buf : Buffer.from(buf as any), `${slug || "theme"}${FORMAT_EXT[fmt]}`, API_MIME[fmt], html`✅ <b>${FORMAT_LABELS[fmt]}</b>（原始文件）`, msg.id);
        sentRaw.push(FORMAT_LABELS[fmt]);
      }
      if (sentRaw.length) {
        await msg.edit({
          text: html`
🎨 <b>${title}</b>
🔗 <code>t.me/addtheme/${slug}</code>
<br/>✅ 已输出: ${sentRaw.join(" · ")}
          `, parseMode: "html" });
        return;
      }
      await msg.edit({ text: html`❌ 主题文件解析失败（无颜色变量）`, parseMode: "html" });
      return;
    }

    // Output strategy with STRICT wallpaper separation:
    // - Mobile targets (Android/TGX/iOS): ONLY mobilePick (Android > iOS > TGX > settings; NEVER Desktop)
    // - Desktop target: keep OWN wallpaper if present; else mobilePick
    const ensureWallpaper = (target: ThemeFormat, buf: Buffer): Buffer => {
      const preferredSlug = wallpaperSlug || bestDoc?.wallpaperSlug || null;
      const mobileBase: ThemeDoc = {
        ...bestDoc!,
        wallpaper, // mobile-only
        wallpaperSlug: preferredSlug,
        wallpaperTiled: false,
        wallpaperBlur,
        wallpaperMotion,
      };

      if (target === "attheme") {
        const parsed = parseAttheme(buf);
        const existing = normalizeWallpaper(parsed?.wallpaper || null);
        // Prefer original Android wallpaper when the Android file itself has embed
        if (existing) {
          const origCount = parsed ? Object.keys(parsed.colors).length : 0;
          if (origCount >= bestCount * 0.95) return buf;
          // re-render colors but KEEP Android's own wallpaper
          return renderDoc({
            ...mobileBase,
            wallpaper: existing,
            colors: expandColorAliases({ ...(parsed?.colors || {}), ...mobileBase.colors }),
          }, "attheme", title) || buf;
        }
        // No Android embed → attach mobile-priority wallpaper (NOT Desktop unless last resort)
        if (!wallpaper) return buf;
        return renderDoc({
          ...mobileBase,
          colors: expandColorAliases({ ...(parsed?.colors || {}), ...mobileBase.colors }),
        }, "attheme", title) || buf;
      }

      if (target === "tdesktop-theme") {
        const parsed = parseDesktop(buf);
        const ownWp = normalizeWallpaper(parsed?.wallpaper || null);
        const origCount = parsed ? Object.keys(parsed.colors).length : 0;
        // Keep Desktop package as-is when it has own wallpaper + near-complete colors
        if (ownWp && origCount >= bestCount * 0.95) return buf;
        return renderDoc({
          ...bestDoc!,
          colors: expandColorAliases({ ...(parsed?.colors || {}), ...bestDoc!.colors }),
          // Desktop: own first, else mobile
          wallpaper: ownWp || desktopWallpaper || wallpaper,
          wallpaperSlug: preferredSlug,
          wallpaperTiled: !!parsed?.wallpaperTiled || wallpaperTiled,
          wallpaperBlur,
          wallpaperMotion,
        }, "tdesktop-theme", title) || buf;
      }

      if (target === "ios-theme") {
        const parsed = parseIos(buf);
        const origCount = parsed ? Object.keys(parsed.colors).length : 0;
        const slugOk = !!parsed?.wallpaperSlug && (!preferredSlug || parsed.wallpaperSlug === preferredSlug);
        if (slugOk && origCount >= bestCount * 0.95) return buf;
        return renderDoc({
          ...mobileBase,
          colors: expandColorAliases({ ...(parsed?.colors || {}), ...mobileBase.colors }),
          wallpaperSlug: preferredSlug || parsed?.wallpaperSlug || null,
          wallpaperBlur: wallpaperBlur ?? parsed?.wallpaperBlur,
          wallpaperMotion: wallpaperMotion ?? parsed?.wallpaperMotion,
          basedOn: parsed?.basedOn || mobileBase.basedOn,
        }, "ios-theme", title) || buf;
      }

      if (target === "tgx-theme") {
        const parsed = parseTgx(buf);
        const origCount = parsed ? Object.keys(parsed.colors).length : 0;
        const slugOk = !preferredSlug || parsed?.wallpaperSlug === preferredSlug;
        if (slugOk && origCount >= bestCount * 0.95 && !!parsed?.wallpaperSlug) return buf;
        return renderDoc({
          ...mobileBase,
          colors: expandColorAliases({ ...(parsed?.colors || {}), ...mobileBase.colors }),
          wallpaperSlug: preferredSlug || parsed?.wallpaperSlug || null,
        }, "tgx-theme", title) || buf;
      }

      return buf;
    };

    const allTargets = (["attheme", "tdesktop-theme", "tgx-theme", "ios-theme"] as ThemeFormat[]);
    const sent: string[] = [];
    const stats: Array<{ target: ThemeFormat; colors: number; bytes: number; wp: boolean; note: string }> = [];
    let wpSidecarSent = false;

    try {
      await msg.edit({
        text: html`⏳ <b>${title}</b>
🔗 <code>t.me/addtheme/${slug}</code>
📊 合并 ${bestCount} 色 · 源 ${sourceFmts.map(f => FORMAT_LABELS[f].split(" ")[0]).join("+") || "?"}
🖼️ 移动端壁纸: ${wallpaperSource === "attheme" ? "Android" : wallpaperSource || "无"}
生成四端文件…`, parseMode: "html" });
    } catch { /* */ }

    /** Validate output buffer: must parse + retain colors; for attheme check offset/WPS consistency */
    const validateOut = (target: ThemeFormat, out: Buffer): { ok: boolean; colors: number; wp: boolean; detail: string } => {
      try {
        const parser = target === "attheme" ? parseAttheme
          : target === "tdesktop-theme" ? parseDesktop
          : target === "tgx-theme" ? parseTgx
          : parseIos;
        const back = parser(out);
        const cc = back ? Object.keys(back.colors).length : 0;
        const hasWp = !!(back && (normalizeWallpaper(back.wallpaper || null) || back.wallpaperSlug));
        if (!back || cc === 0) return { ok: false, colors: 0, wp: false, detail: "parse empty" };
        if (target === "attheme") {
          const textHead = out.subarray(0, Math.min(80, out.length)).toString("utf8");
          if (!textHead.startsWith("wallpaperFileOffset=")) {
            return { ok: false, colors: cc, wp: hasWp, detail: "missing wallpaperFileOffset" };
          }
          // If we claim mobile wallpaper, WPS must exist (or offset=-1 when none)
          const hasWps = out.includes(Buffer.from("WPS\n"));
          if (wallpaper && !hasWps && target === "attheme" && !byFormat.has("attheme")) {
            // synthesized android should embed
            return { ok: false, colors: cc, wp: hasWp, detail: "expected WPS embed" };
          }
        }
        if (target === "tdesktop-theme" && (desktopWallpaper || wallpaper)) {
          const p = parseDesktop(out);
          // Desktop with intended wp should be ZIP when wp present
          if ((desktopKeptOwn || wallpaper) && !normalizeWallpaper(p?.wallpaper || null) && isZip(out) === false && (desktopWallpaper || wallpaper)) {
            // plain palette without wp only ok if we intentionally had none
          }
        }
        return { ok: true, colors: cc, wp: hasWp, detail: "ok" };
      } catch (e: any) {
        return { ok: false, colors: 0, wp: false, detail: getErrorMessage(e) };
      }
    };

    for (const target of allTargets) {
      let out: Buffer | null = null;
      let fromLabel: string;
      if (byFormat.has(target)) {
        out = ensureWallpaper(target, byFormat.get(target)!);
        fromLabel = synthesized ? "设置合成" : (sourceFmts.length > 1 ? "多源合并" : "原始");
      } else {
        out = renderDoc(bestDoc, target, title);
        fromLabel = sourceFmts.length > 1
          ? `合并(${sourceFmts.map(f => FORMAT_LABELS[f].split(" ")[0]).join("+")})`
          : FORMAT_LABELS[bestFmt];
      }
      if (!out) {
        console.warn(`[theme] ${slug} render ${target} returned null`);
        continue;
      }

      // Validate; if fail and we have original, prefer original for same-format
      let v = validateOut(target, out);
      if (!v.ok && byFormat.has(target)) {
        const orig = byFormat.get(target)!;
        const vo = validateOut(target, orig);
        if (vo.ok && vo.colors >= v.colors) {
          out = orig;
          v = vo;
          fromLabel = "原始(校验回退)";
          console.warn(`[theme] ${slug} ${target} regen failed (${v.detail}), kept original`);
        }
      }
      if (!v.ok) {
        console.warn(`[theme] ${slug} ${target} validation weak: ${v.detail} colors=${v.colors}`);
      }

      // Caption wallpaper note
      let wpNote = "";
      if (target === "attheme") {
        if (v.wp) {
          wpNote = wallpaperSource === "attheme" || !wallpaperSource
            ? " · 🖼️ WPS 已嵌入"
            : ` · 🖼️ WPS 已嵌入（← ${wallpaperSource === "ios-theme" || wallpaperSource === "ios-slug" ? "iOS" : wallpaperSource}）`;
        } else {
          wpNote = " · 无壁纸 (offset=-1)";
        }
      } else if (target === "tdesktop-theme") {
        const p = parseDesktop(out);
        if (normalizeWallpaper(p?.wallpaper || null)) {
          const keptOwn = desktopKeptOwn;
          wpNote = keptOwn
            ? " · 🖼️ ZIP 原壁纸"
            : ` · 🖼️ ZIP 壁纸（← ${wallpaperSource === "attheme" ? "Android" : wallpaperSource || "移动端"}）`;
        }
      } else if (target === "ios-theme" && (wallpaperSlug || bestDoc?.wallpaperSlug)) {
        wpNote = " · 🖼️ defaultWallpaper slug";
      } else if (target === "tgx-theme" && (wallpaperSlug || bestDoc?.wallpaperSlug)) {
        wpNote = " · 🖼️ wallpaper slug";
      }

      const sizeKb = Math.max(1, Math.round(out.length / 1024));
      await sendThemeDocument(client, msg.peerId, Buffer.isBuffer(out) ? out : Buffer.from(out as any), `${slug || "theme"}${FORMAT_EXT[target]}`, API_MIME[target], html`✅ <b>${FORMAT_LABELS[target]}</b>${fromLabel === "设置合成" ? "（云端设置）" : fromLabel === "原始" ? "（原始）" : fromLabel === "多源合并" ? "（多源合并）" : fromLabel.startsWith("原始") ? `（${fromLabel}）` : ` ← ${fromLabel}`} · ${v.colors || bestCount} 色 · ${sizeKb}KB${wpNote}`, msg.id);
      sent.push(FORMAT_LABELS[target]);
      stats.push({ target, colors: v.colors || bestCount, bytes: out.length, wp: v.wp, note: fromLabel });
    }

    // Sidecar: mobile-priority wallpaper (Android first) for TGX / manual use
    if (wallpaper && !wpSidecarSent) {
      const ext = detectImageExt(wallpaper) === "png" ? "png" : "jpg";
      const srcLabel = wallpaperSource === "attheme" ? "Android"
        : wallpaperSource === "ios-theme" || wallpaperSource === "ios-slug" ? "iOS"
        : wallpaperSource === "tgx-theme" ? "TGX"
        : wallpaperSource === "settings" ? "云端设置"
        : wallpaperSource || "unknown";
      const dim = formatImageDim(readImageDimensions(wallpaper));
      await sendThemeDocument(client, msg.peerId, Buffer.isBuffer(wallpaper) ? wallpaper : Buffer.from(wallpaper as any), `${slug || "theme"}-chat-background.${ext}`, ext === "png" ? "image/png" : "image/jpeg", html`🖼️ <b>移动端聊天背景</b>（来源: ${srcLabel}${dim ? ` · ${dim}` : ""}${wallpaperSlug ? ` · slug: <code>${wallpaperSlug}</code>` : ""}；仅 Android/iOS/TGX/settings，绝不使用 Desktop）`, msg.id);
      wpSidecarSent = true;
    }

    // Optional: if Desktop has own wallpaper and mobile has none, send Desktop bg as
    // separate "Desktop-only background" sidecar so user can still grab it — NOT as mobile bg
    if (!wallpaper && desktopKeptOwn && desktopWallpaper) {
      const ext = detectImageExt(desktopWallpaper) === "png" ? "png" : "jpg";
      const dim = formatImageDim(readImageDimensions(desktopWallpaper));
      await sendThemeDocument(client, msg.peerId, Buffer.isBuffer(desktopWallpaper) ? desktopWallpaper : Buffer.from(desktopWallpaper as any), `${slug || "theme"}-desktop-background.${ext}`, ext === "png" ? "image/png" : "image/jpeg", html`🖥️ <b>Desktop 专用壁纸</b>${dim ? `（${dim}）` : ""}（Android 主题无壁纸 · 未注入移动端，避免主体出画）`, msg.id);
    }

    const mobileSrcLabel = wallpaperSource === "attheme" ? "Android"
      : wallpaperSource === "ios-theme" || wallpaperSource === "ios-slug" ? "iOS"
      : wallpaperSource === "tgx-theme" ? "TGX"
      : wallpaperSource === "settings" ? "云端设置"
      : "无（Android 未嵌入，不回退 Desktop）";

    const ms = Date.now() - t0;
    const statLine = stats.map(s => {
      const short = FORMAT_LABELS[s.target].split(" ")[0];
      return `${short}:${s.colors}色${s.wp ? "+壁纸" : ""}`;
    }).join(" · ");
    const mobileDim = formatImageDim(readImageDimensions(wallpaper));
    const desktopDim = desktopKeptOwn ? formatImageDim(readImageDimensions(desktopWallpaper)) : "";

    // Cloud themeSettings export for Unigram / Web (no proprietary file format)
    try {
      const settingsJson = genCloudThemeSettingsExport(bestDoc?.colors || {}, {
        title,
        basedOn: bestDoc?.basedOn,
        wallpaperSlug,
        wallpaperBlur,
        wallpaperMotion,
      });
      await sendThemeDocument(client, msg.peerId, Buffer.isBuffer(Buffer.from(settingsJson, "utf-8")) ? Buffer.from(settingsJson, "utf-8") : Buffer.from(Buffer.from(settingsJson, "utf-8") as any), `${slug || "theme"}-cloud-settings.json`, "application/json", html`☁️ <b>云端 themeSettings</b>（Unigram / Web / WebK / WebA）
<br/>无独立主题文件的客户端走 accent + baseTheme + wallpaper slug
<br/>也可用 <code>${mainPrefix}theme cloud-settings</code> 直接创建云端链接`, msg.id);
      sent.push("Cloud settings");
    } catch (e) {
      console.warn("[theme] settings export failed:", getErrorMessage(e));
    }

    await msg.edit({
      text: html`
🎨 <b>${title}</b>
🔗 <code>t.me/addtheme/${slug}</code>
📊 源: ${synthesized ? "云端颜色设置" : `${sourceFmts.map(f => FORMAT_LABELS[f]).join(" + ") || FORMAT_LABELS[bestFmt]}（合并 ${bestCount} 色）`}
<br/>🖼️ 移动端壁纸: <b>${mobileSrcLabel}</b>${mobileDim ? ` · ${mobileDim}` : ""}${wallpaperSlug ? ` · slug <code>${wallpaperSlug}</code>` : ""}
${desktopKeptOwn ? `<br/>🖥️ Desktop 使用自带壁纸${desktopDim ? ` · ${desktopDim}` : ""}（不注入移动端）` : wallpaper ? "<br/>🖥️ Desktop 无原图 → 使用移动端壁纸" : ""}
<br/>✅ 已输出: ${sent.join(" · ") || "无"}
${statLine ? `<br/>📈 ${statLine}` : ""}
<br/>⏱ ${ms}ms
<br/><i>四端文件 + 云端 settings · 移动壁纸永不 Desktop</i>
      `, parseMode: "html" });
  }

  // ── Handle cloud upload ──────────────────────────────────────────────

  private async handleCloudUpload(msg: Api.Message): Promise<void> {
    if (!msg.replyToMsgId) {
      await msg.edit({ text: html`❌ 请回复一个主题文件后再使用 <code>${mainPrefix}theme cloud</code>`, parseMode: "html" });
      return;
    }
    const client = await getGlobalClient();
    try {
      const reply = await safeGetReplyMessage(msg);
      if (!reply || !(reply as any).document) {
        await msg.edit({ text: html`❌ 回复的消息不是文件`, parseMode: "html" }); return;
      }
      await msg.edit({ text: html`⏳ 下载并解析主题...`, parseMode: "html" });
      const buf = await downloadMedia(reply, client);
      if (!buf || buf.length === 0) { await msg.edit({ text: html`❌ 下载失败`, parseMode: "html" }); return; }
      const format = detectFmt(buf);
      let doc = parseThemeBuffer(buf, format);
      if (!doc || !Object.keys(doc.colors).length) { await msg.edit({ text: html`❌ 无法识别或解析主题格式`, parseMode: "html" }); return; }
      const fmt: ThemeFormat = (doc.format || format || "attheme") as ThemeFormat;

      // Resolve slug→bytes; upload image→slug so iOS/TGX cloud themes keep wallpaper
      if (doc.wallpaperSlug && !normalizeWallpaper(doc.wallpaper || null)) {
        await msg.edit({ text: html`⏳ 下载云壁纸...`, parseMode: "html" });
        doc = await this.resolveWallpaperBytes(client, doc);
      }
      if (!doc.wallpaperSlug && normalizeWallpaper(doc.wallpaper || null) && (fmt === "ios-theme" || fmt === "tgx-theme")) {
        await msg.edit({ text: html`⏳ 上传聊天背景到云壁纸...`, parseMode: "html" });
        doc = await this.ensureIosWallpaperSlug(client, doc);
      }

      await msg.edit({ text: html`⏳ 上传到 Telegram 云端...`, parseMode: "html" });
      const slug = genSlug();
      // Prefer original buffer when it already has native wallpaper/slug; else re-render
      const origHasWp =
        (fmt === "attheme" && !!normalizeWallpaper(parseAttheme(buf)?.wallpaper || null))
        || (fmt === "tdesktop-theme" && !!normalizeWallpaper(parseDesktop(buf)?.wallpaper || null))
        || (fmt === "ios-theme" && !!(parseIos(buf)?.wallpaperSlug))
        || (fmt === "tgx-theme" && !!(parseTgx(buf)?.wallpaperSlug));
      const docHasWp = !!(normalizeWallpaper(doc.wallpaper || null) || doc.wallpaperSlug);
      let converted = buf;
      // Cloud JSON has no native document — always render to attheme for file-based cloud theme
      if (!format || parseCloudSettingsJson(buf)) {
        converted = renderDoc(doc, "attheme") || Buffer.from(genAndroid(doc.colors).join("\n") + "\n");
      } else if (fmt === "attheme") {
        // Always normalize to official wallpaperFileOffset + signed ints
        converted = renderDoc(doc, fmt) || buf;
      } else if (!origHasWp && docHasWp) {
        converted = renderDoc(doc, fmt, "TeleBox Theme") || buf;
      } else if ((fmt === "ios-theme" || fmt === "tgx-theme") && doc.wallpaperSlug) {
        // Ensure slug is written even if original lacked it
        const origSlug = fmt === "ios-theme" ? parseIos(buf)?.wallpaperSlug : parseTgx(buf)?.wallpaperSlug;
        if (origSlug !== doc.wallpaperSlug) converted = renderDoc(doc, fmt, "TeleBox Theme") || buf;
      }

      const outFmt: ThemeFormat = (!format || parseCloudSettingsJson(buf)) ? "attheme" : fmt;

      const uploaded: any = await client.uploadFile({ file: new CustomFile(`theme${FORMAT_EXT[outFmt]}`, Buffer.isBuffer(converted) ? converted.length : Buffer.from(converted as any).length, "", Buffer.isBuffer(converted) ? converted : Buffer.from(converted as any)) });

      // Build inputDocument correctly from uploadFile result shape variants
      let inputDoc: any = null;
      if (hasTlType(uploaded, "inputDocument") || (uploaded?.id && uploaded?.accessHash)) {
        inputDoc = toInputDocument(uploaded);
      } else if (uploaded?.document) {
        const d = uploaded.document;
        inputDoc = toInputDocument(d);
      } else if (hasTlType(uploaded, "inputFile") || hasTlType(uploaded, "inputFileBig") || uploaded?.id != null) {
        // teleproto uploadFile returns InputFile; createTheme requires InputDocument.
        // Fallback: send as media to Saved Messages style is heavy; try createTheme with document: uploaded via messages.uploadMedia path.
        try {
          const media: any = await client.invoke(new Api.messages.UploadMedia({
            peer: new Api.InputPeerSelf(),
            media: new Api.InputMediaUploadedDocument({
              file: uploaded,
              mimeType: API_MIME[outFmt],
              attributes: [new Api.DocumentAttributeFilename({ fileName: `theme${FORMAT_EXT[outFmt]}` })],
            }),
          }));
          const d = media?.document;
          if (hasTlType(d, "document")) {
            inputDoc = toInputDocument(d);
          }
        } catch (e) {
          console.warn("[theme] cloud uploadMedia bridge failed:", getErrorMessage(e));
        }
      }
      if (!inputDoc) {
        await msg.edit({ text: html`❌ 云端上传失败: 无法构造 inputDocument`, parseMode: "html" });
        return;
      }

      const created: any = await client.invoke(new Api.account.CreateTheme({
        slug,
        title: `TeleBox Theme (${FORMAT_LABELS[outFmt]})`,
        document: inputDoc,
      }));

      const themeSlug = (created as any).slug || slug;
      const link = `https://t.me/addtheme/${themeSlug}`;
      const wpNote = normalizeWallpaper(doc.wallpaper || null)
        ? (doc.wallpaperSlug ? ` · 🖼️ 壁纸 + slug <code>${doc.wallpaperSlug}</code>` : " · 🖼️ 壁纸已保留")
        : (doc.wallpaperSlug ? ` · 🖼️ slug <code>${doc.wallpaperSlug}</code>` : "");
      await msg.edit({
        text: html`
✅ <b>云端主题创建成功！</b>

<a href="${link}">${link}</a>

📊 ${Object.keys(doc.colors).length} 个颜色变量 · ${FORMAT_LABELS[outFmt]}${wpNote}
        `, parseMode: "html" });
    } catch (e: any) {
      await msg.edit({ text: html`❌ 云端上传失败: ${getErrorMessage(e)}`, parseMode: "html" });
    }
  }

  /**
   * Create a cloud accent theme via account.createTheme(settings=InputThemeSettings).
   * This is what Unigram / Telegram Web consume — no proprietary theme file.
   */
  private async handleCloudSettingsUpload(msg: Api.Message): Promise<void> {
    if (!msg.replyToMsgId) {
      await msg.edit({ text: html`❌ 请回复主题文件后使用 <code>${mainPrefix}theme cloud-settings</code>`, parseMode: "html" });
      return;
    }
    const client = await getGlobalClient();
    try {
      const reply = await safeGetReplyMessage(msg);
      if (!reply || !(reply as any).document) {
        await msg.edit({ text: html`❌ 回复不是文件`, parseMode: "html" }); return;
      }
      await msg.edit({ text: html`⏳ 解析并生成云端 themeSettings...`, parseMode: "html" });
      const buf = await downloadMedia(reply, client);
      if (!buf || buf.length === 0) { await msg.edit({ text: html`❌ 下载失败`, parseMode: "html" }); return; }
      let doc = parseThemeBuffer(buf, detectFmt(buf));
      if (!doc || !Object.keys(doc.colors).length) { await msg.edit({ text: html`❌ 解析失败`, parseMode: "html" }); return; }

      if (doc.wallpaperSlug && !normalizeWallpaper(doc.wallpaper || null)) {
        doc = await this.resolveWallpaperBytes(client, doc);
      }
      if (!doc.wallpaperSlug && normalizeWallpaper(doc.wallpaper || null)) {
        await msg.edit({ text: html`⏳ 上传壁纸到云端...`, parseMode: "html" });
        doc = await this.ensureIosWallpaperSlug(client, doc);
      }

      const exportJson = genCloudThemeSettingsExport(doc.colors, {
        title: "TeleBox Theme",
        basedOn: doc.basedOn,
        wallpaperSlug: doc.wallpaperSlug,
        wallpaperBlur: doc.wallpaperBlur,
        wallpaperMotion: doc.wallpaperMotion,
      });
      const parsed = JSON.parse(exportJson);
      const s = parsed.settings;
      const baseName = String(s.baseTheme?._ || s.baseTheme || "baseThemeDay");
      const inputSettings = new Api.InputThemeSettings({
        baseTheme: toBaseTheme(baseName),
        accentColor: s.accentColor,
        outboxAccentColor: s.outboxAccentColor,
        messageColors: s.messageColors || [],
        wallpaper: doc.wallpaperSlug
          ? new Api.InputWallPaperSlug({ slug: doc.wallpaperSlug })
          : undefined,
        wallpaperSettings: doc.wallpaperSlug
          ? new Api.WallPaperSettings({
              blur: !!doc.wallpaperBlur,
              motion: doc.wallpaperMotion !== false,
              intensity: doc.wallpaperIntensity ?? 50,
            })
          : undefined,
      });

      await msg.edit({ text: html`⏳ 创建云端 accent 主题（Unigram/Web）...`, parseMode: "html" });
      const slug = genSlug();
      const created: any = await client.invoke(new Api.account.CreateTheme({
        slug,
        title: `TeleBox Cloud (${parsed.palettePreview?.dark ? "dark" : "light"})`,
        settings: [inputSettings],
      }));

      const themeSlug = created?.slug || slug;
      const link = `https://t.me/addtheme/${themeSlug}`;

      await sendThemeDocument(client, msg.peerId, Buffer.isBuffer(Buffer.from(exportJson, "utf-8")) ? Buffer.from(exportJson, "utf-8") : Buffer.from(Buffer.from(exportJson, "utf-8") as any), `${themeSlug}-cloud-settings.json`, "application/json", html`☁️ settings JSON 备份`, msg.id);

      await msg.edit({
        text: html`
✅ <b>云端 accent 主题已创建</b>（Unigram / Web / WebK / WebA）

<a href="${link}">${link}</a>

📊 accent <code>${parsed.palettePreview?.accent}</code>
· outbox <code>${parsed.palettePreview?.outbox}</code>
· ${parsed.palettePreview?.dark ? "dark" : "light"}
${doc.wallpaperSlug ? `<br/>🖼️ wallpaper slug <code>${doc.wallpaperSlug}</code>` : ""}
<br/><i>此类客户端无 .attheme 等文件，靠 themeSettings 同步配色</i>
        `, parseMode: "html" });
    } catch (e) {
      await msg.edit({ text: html`❌ cloud-settings 失败: ${getErrorMessage(e)}`, parseMode: "html" });
    }
  }

  // ── Handle convert to target client (auto-detect source) ─────────────

  private async handleConvertToTarget(msg: Api.Message, target: ThemeFormat): Promise<void> {
    if (!msg.replyToMsgId) {
      await msg.edit({ text: html`❌ 请回复主题文件后使用 <code>${mainPrefix}theme ${target}</code>`, parseMode: "html" });
      return;
    }
    const client = await getGlobalClient();
    try {
      const reply = await safeGetReplyMessage(msg);
      if (!reply || !(reply as any).document) {
        await msg.edit({ text: html`❌ 回复不是文件`, parseMode: "html" }); return;
      }
      await msg.edit({ text: html`⏳ 转换为 ${TARGET_CLIENT_LABELS[target]}...`, parseMode: "html" });
      const buf = await downloadMedia(reply, client);
      if (!buf || buf.length === 0) { await msg.edit({ text: html`❌ 下载失败`, parseMode: "html" }); return; }
      const format = detectFmt(buf);
      if (!format && !parseCloudSettingsJson(buf)) { await msg.edit({ text: html`❌ 无法识别文件格式`, parseMode: "html" }); return; }
      let doc = parseThemeBuffer(buf, format);
      if (!doc || !Object.keys(doc.colors).length) { await msg.edit({ text: html`❌ 解析失败`, parseMode: "html" }); return; }
      const srcFmt = doc.format || format!;
      const sameFmt = srcFmt === target;
      if (sameFmt) {
        await msg.edit({ text: html`⏳ 同格式重规范化（补齐壁纸/offset/slug）...`, parseMode: "html" });
      }

      // Resolve / package wallpaper for target
      if (doc.wallpaperSlug && !normalizeWallpaper(doc.wallpaper || null)) {
        await msg.edit({ text: html`⏳ 下载云壁纸...`, parseMode: "html" });
        doc = await this.resolveWallpaperBytes(client, doc);
      }
      // iOS + TGX both need cloud wallpaper slug when only image bytes exist
      if ((target === "ios-theme" || target === "tgx-theme") && !doc.wallpaperSlug && normalizeWallpaper(doc.wallpaper || null)) {
        await msg.edit({ text: html`⏳ 上传聊天背景到云壁纸（${target === "ios-theme" ? "iOS" : "TGX"} 打包）...`, parseMode: "html" });
        doc = await this.ensureIosWallpaperSlug(client, doc);
      }

      const out = renderDoc(doc, target);
      if (!out) { await msg.edit({ text: html`❌ 转换失败`, parseMode: "html" }); return; }
      const cc = Object.keys(doc.colors).length;
      const wp = normalizeWallpaper(doc.wallpaper || null);
      const emb = !!(wp && (target === "attheme" || target === "tdesktop-theme"));
      const slugPacked = !!((target === "ios-theme" || target === "tgx-theme") && doc.wallpaperSlug);
      const dim = formatImageDim(readImageDimensions(wp));
      await msg.delete();
      await sendThemeDocument(client, msg.peerId, Buffer.isBuffer(out) ? out : Buffer.from(out as any), `theme${FORMAT_EXT[target]}`, API_MIME[target], html`
✅ <b>${sameFmt ? "重规范化完成" : "转换完成"}</b> ${TARGET_CLIENT_LABELS[target]}
📊 ${cc} 个颜色变量${emb ? "<br/>🖼️ 壁纸已嵌入" : slugPacked ? `<br/>🖼️ 壁纸已打包（slug: <code>${doc.wallpaperSlug}</code>）` : wp ? "<br/>🖼️ 壁纸见附图" : ""}${dim ? `<br/>📐 ${dim}` : ""}
${sameFmt ? "<br/><i>源格式相同：已按生产级规范重写（offset/signed int/slug）</i>" : ""}
        `, msg.id);
      if (wp && !emb) {
        const ext = detectImageExt(wp) === "png" ? "png" : "jpg";
        const cap = slugPacked
          ? html`🖼️ <b>聊天背景原图</b>${dim ? ` · ${dim}` : ""}（已写入 ${target === "ios-theme" ? "iOS defaultWallpaper" : "TGX wallpaper"} slug）`
          : html`🖼️ 聊天背景${dim ? ` · ${dim}` : ""}`;
        await sendThemeDocument(client, msg.peerId, Buffer.isBuffer(wp) ? wp : Buffer.from(wp as any), `theme-chat-background.${ext}`, ext === "png" ? "image/png" : "image/jpeg", cap, msg.id);
      }
    } catch (e) {
      await msg.edit({ text: html`❌ 转换失败: ${getErrorMessage(e)}`, parseMode: "html" });
    }
  }
}

export default new ThemePlugin();

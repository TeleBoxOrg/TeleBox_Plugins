import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
import { FileLocation } from "@mtcute/core";
import { getGlobalClient } from "@utils/runtimeManager";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import type { MtcuteFileDownloadLocation } from "@utils/mtcuteTypes";
import * as fs from "fs";
import * as path from "path";

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
const TARGET_ALIASES: Record<string, ThemeFormat> = {
  android: "attheme",
  tgx: "tgx-theme",
  desktop: "tdesktop-theme",
  ios: "ios-theme",
};
const TARGET_CLIENT_LABELS: Record<ThemeFormat, string> = {
  attheme: "📱 Android",
  "tdesktop-theme": "💻 Desktop",
  "tgx-theme": "📲 TGX",
  "ios-theme": "🍎 iOS",
};

// ─── Color utilities ─────────────────────────────────────────────────────────

function toHex(r: number, g: number, b: number, a = 255): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  if (a < 255) return `#${c(a)}${c(r)}${c(g)}${c(b)}`;
  return `#${c(r)}${c(g)}${c(b)}`;
}

function parseColor(raw: string): string | null {
  const s = raw.trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (/^[0-9a-fA-F]{6}$/.test(h)) return `#${h}`;
    if (/^[0-9a-fA-F]{8}$/.test(h)) return `#${h}`;
    if (/^[0-9a-fA-F]{3}$/.test(h)) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    return null;
  }
  if (s.endsWith("h")) {
    try {
      const n = parseInt(s.slice(0, -1), 16) >>> 0;
      return toHex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    } catch { return null; }
  }
  try {
    let n = parseInt(s);
    if (isNaN(n)) return null;
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

/** Parse local-file entries from a ZIP (store or deflate) */
function parseZip(buf: Buffer): Record<string, Buffer> {
  const zlib = require("zlib") as typeof import("zlib");
  const out: Record<string, Buffer> = {};
  let i = 0;
  while (i + 30 <= buf.length) {
    const sig = buf.readUInt32LE(i);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const flags = buf.readUInt16LE(i + 6);
    let comp = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26);
    const elen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nlen).toString("utf8");
    let start = i + 30 + nlen + elen;
    // data descriptor when bit 3 set and sizes zero
    if ((flags & 0x8) && comp === 0) {
      // scan for next local header or data descriptor — rare for theme zips; skip if empty
      break;
    }
    let data = buf.subarray(start, start + comp);
    if (method === 8) {
      try { data = zlib.inflateRawSync(data); } catch { /* keep raw */ }
    } else if (method !== 0) {
      i = start + comp;
      continue;
    }
    out[name] = Buffer.from(data);
    // also index by basename lower
    const base = name.split("/").pop() || name;
    if (base !== name) out[base] = out[name];
    i = start + comp;
  }
  return out;
}

function parseDesktopColorText(text: string): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("//")) continue;
    // support multiple "key: val;" on one line
    const parts = s.split(";").map(x => x.trim()).filter(Boolean);
    for (const part of parts) {
      const col = part.indexOf(":");
      if (col <= 0) continue;
      const k = part.slice(0, col).trim();
      const v = part.slice(col + 1).trim();
      if (k && v) raw[k] = v;
    }
  }
  const colors: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v.startsWith("#")) colors[k] = v;
    else if (raw[v]?.startsWith("#")) colors[k] = raw[v];
    else if (/^[0-9a-fA-F]{6,8}$/.test(v)) colors[k] = `#${v}`;
    else colors[k] = v.startsWith("#") ? v : (raw[v] || v);
  }
  return colors;
}

function extractDesktopWallpaper(files: Record<string, Buffer>): { wallpaper: Buffer | null; tiled: boolean } {
  const names = Object.keys(files);
  const lower = (n: string) => n.toLowerCase();
  const find = (cands: string[]) => {
    for (const c of cands) {
      const hit = names.find(n => lower(n) === c || lower(n).endsWith("/" + c));
      if (hit && files[hit]?.length) return files[hit];
    }
    return null;
  };
  const tiled = !!(find(["tiled.jpg", "tiled.jpeg", "tiled.png"]));
  const wp = find(["background.jpg", "background.jpeg", "background.png", "tiled.jpg", "tiled.jpeg", "tiled.png"]);
  return { wallpaper: normalizeWallpaper(wp), tiled };
}

/** Attach wallpaper into Android .attheme bytes */
function attachAtthemeWallpaper(colorText: string, wallpaper: Buffer | null | undefined): Buffer {
  const text = colorText.endsWith("\n") ? colorText : colorText + "\n";
  const parts: Buffer[] = [Buffer.from(text, "utf-8")];
  const wp = normalizeWallpaper(wallpaper || null);
  if (wp) {
    parts.push(Buffer.from("WPS\n"), wp, Buffer.from("\nWPE\n"));
  }
  return Buffer.concat(parts);
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
  const out: Record<string, string> = { ...colors };
  const put = (k: string, v: string) => { if (v && !out[k]) out[k] = v; };

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
 * Later docs fill missing keys only (first-writer-wins for conflicts),
 * so platform-native keys are preserved when that platform is listed first.
 */
function mergeThemeDocs(docs: ThemeDoc[], preferredOrder: ThemeFormat[] = ["attheme", "ios-theme", "tgx-theme", "tdesktop-theme"]): ThemeDoc | null {
  if (!docs.length) return null;
  const ordered = [...docs].sort((a, b) => {
    const ia = preferredOrder.indexOf(a.format);
    const ib = preferredOrder.indexOf(b.format);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const colors: Record<string, string> = {};
  let wallpaper: Buffer | null = null;
  let wallpaperSlug: string | null = null;
  let wallpaperTiled = false;
  let wallpaperBlur: number | undefined;
  let wallpaperMotion: boolean | undefined;
  let wallpaperIntensity: number | undefined;
  let wallpaperColor: string | null | undefined;
  let wallpaperPattern: string | null | undefined;
  let basedOn: string | null | undefined;
  let format: ThemeFormat = ordered[0].format;

  for (const d of ordered) {
    for (const [k, v] of Object.entries(d.colors || {})) {
      if (v && !colors[k]) colors[k] = v;
    }
    if (!wallpaper) wallpaper = normalizeWallpaper(d.wallpaper || null);
    if (!wallpaperSlug && d.wallpaperSlug) wallpaperSlug = d.wallpaperSlug;
    if (d.wallpaperTiled) wallpaperTiled = true;
    if (wallpaperBlur == null && d.wallpaperBlur != null) wallpaperBlur = d.wallpaperBlur;
    if (wallpaperMotion == null && d.wallpaperMotion != null) wallpaperMotion = d.wallpaperMotion;
    if (wallpaperIntensity == null && d.wallpaperIntensity != null) wallpaperIntensity = d.wallpaperIntensity;
    if (!wallpaperColor && d.wallpaperColor) wallpaperColor = d.wallpaperColor;
    if (!wallpaperPattern && d.wallpaperPattern) wallpaperPattern = d.wallpaperPattern;
    if (!basedOn && d.basedOn) basedOn = d.basedOn;
  }

  // Expand cross-platform aliases AFTER merge so every native key gets siblings
  const expanded = expandColorAliases(colors);
  return {
    format,
    colors: expanded,
    wallpaper,
    wallpaperSlug,
    wallpaperTiled,
    wallpaperBlur,
    wallpaperMotion,
    wallpaperIntensity,
    wallpaperColor: wallpaperColor || null,
    wallpaperPattern: wallpaperPattern || null,
    basedOn: basedOn || null,
  };
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

function genDesktop(colors: Record<string, string>): string {
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
  const dark = isDarkHex(bg);
  const lines = [
    "// Telegram Desktop Theme // Generated by TeleBox Theme Converter",
    `primaryColor: ${p}; primaryColorDark: ${adjustBright(p, -30)}; primaryColorTrans: ${p}80;`,
    `primaryDark: ${toRgb(bg)}; secondaryDark: ${adjustBright(bg, 8)}; tertiaryDark: ${adjustBright(bg, 15)};`,
    `quaternaryDark: ${adjustBright(bg, 20)}; primaryText: ${t}; secondaryText: ${adjustBright(t, -10)};`,
    `windowBg: primaryDark; windowFg: primaryText; windowBgOver: tertiaryDark; windowBgRipple: ${p};`,
    `windowSubTextFg: ${st}; windowBoldFg: primaryText; windowBgActive: primaryColor; windowFgActive: #ffffff;`,
    `activeButtonBg: primaryColor; activeButtonBgOver: ${adjustBright(p, 10)}; activeButtonFg: #ffffff;`,
    `activeLineFg: primaryColor; attentionButtonFg: ${dest};`,
    `dialogsBg: ${cl}; dialogsNameFg: primaryText; dialogsTextFg: secondaryText;`,
    `dialogsDateFg: secondaryText; dialogsChatIconFg: primaryColor; dialogsTextFgService: primaryColor;`,
    `dialogsDraftFg: ${dest}; dialogsSentIconFg: primaryColor;`,
    `dialogsUnreadBg: primaryColor; dialogsUnreadBgMuted: secondaryText; dialogsUnreadFg: #ffffff;`,
    `topBarBg: ${tb}; menuBg: primaryDark; menuBgOver: quaternaryDark;`,
    `menuIconFg: ${p}; menuIconFgOver: primaryColor;`,
    `placeholderFg: ${st}; placeholderFgActive: secondaryText; inputBorderFg: tertiaryDark;`,
    `historySendIconFg: primaryColor;`,
    `msgInBg: ${mi}; msgInBgSelected: ${adjustBright(mi, 15)}; msgInShadow: ${bg};`,
    `msgOutBg: ${mo}; msgOutBgSelected: ${adjustBright(mo, 15)}; msgOutShadow: ${bg};`,
    `historyTextInFg: primaryText; historyTextOutFg: primaryText;`,
    `historyLinkInFg: primaryColor; historyLinkOutFg: primaryColor;`,
    `msgInReplyBarFg: primaryColor; msgOutReplyBarFg: primaryColor;`,
    `msgInReplyNameFg: primaryColor; msgOutReplyNameFg: primaryColor;`,
    `msgInDateFg: secondaryText; msgOutDateFg: secondaryText;`,
    `msgInServiceFg: primaryColor; msgOutServiceFg: primaryColor;`,
    `msgSelectOverlay: ${p}1a;`,
    `historyComposeAreaBg: primaryDark; historyComposeAreaFg: primaryText;`,
    `historyComposeAreaFgService: secondaryText; historyComposeIconFg: ${p};`,
    `historyToDownBg: primaryDark; historyToDownFg: ${p}; historyToDownFgOver: #ffffff; historyToDownBgOver: primaryColor;`,
    `emojiPanBg: primaryDark; emojiPanIconFg: secondaryText; emojiPanIconFgActive: primaryColor;`,
    `emojiPanBadgeBg: primaryColor; emojiPanBadgeFg: #ffffff;`,
    `sideBarBg: ${adjustBright(bg, -5)}; sideBarBgActive: primaryColor;`,
    `sideBarTextFg: secondaryText; sideBarTextFgActive: #ffffff; sideBarIconFgActive: #ffffff;`,
    `scrollBarBg: ${p}80; scrollBarBgOver: primaryColor;`,
    `playerBg: primaryDark; playerTitleFg: primaryText; playerProgressFg: primaryColor;`,
    `playerBackground: primaryDark; playerButton: primaryText; playerTime: secondaryText;`,
    `callsBg: primaryDark; callsNameFg: primaryText;`,
    `callsReceivedFg: ${green}; callsMissedFg: ${dest};`,
    `onlineFg: ${green};`,
    `dialogsPinnedIconFg: primaryColor; dialogsPinnedBg: ${p}3c;`,
    `dialogsVerifiedIconBg: primaryColor; dialogsVerifiedIconFg: #ffffff;`,
    `onlineFg: ${green};`,
    `windowBoldFg: primaryText; windowActiveTextFg: primaryColor;`,
    `windowShadowFg: 00000000;`,
    `historyOutIconFg: primaryColor; historyOutIconFgSelected: ${adjustBright(p, 10)};`,
    `msgInReplyBarColor: primaryColor; msgOutReplyBarColor: primaryColor;`,
    `msgInReplyBarSelFg: secondaryText; msgOutReplyBarSelFg: secondaryText;`,
    `msgInDateFgSelected: secondaryText; msgOutDateFgSelected: secondaryText;`,
    `historyPeerUserpicFg: primaryText;`,
    `historyToDownShadow: 00000000;`,
    `msgInBgSelected: ${adjustBright(mi, 15)}; msgOutBgSelected: ${adjustBright(mo, 15)};`,
    `msgInShadow: ${bg}; msgOutShadow: ${bg};`,
  ];
  // Spillover: any remaining cx key not yet in output — zero loss
  const known = new Set(lines.map(l => l.split(":")[0].trim()));
  for (const [k, v] of Object.entries(cx)) {
    const hex = toRgb(v);
    if (!known.has(k) && hex && !k.includes(".") && !k.includes("__")) {
      lines.push(`${k}: ${hex};`);
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
    if (!r[k] && v) r[k] = v;
  }
  return Object.entries(r).map(([k, v]) => `${k}=${v}`);
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
  const dark = isDarkHex(bg) ? 1 : 0;
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
  options?: { blur?: number; motion?: boolean },
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
  const dark = isDarkHex(bg);
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
    `basedOn: ${dark ? "night" : "day"}`,
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
      const pv = parseColor(s.slice(eq + 1).trim());
      if (pv) colors[s.slice(0, eq).trim()] = pv;
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
      const colors = parseDesktopColorText(colorBuf.toString("utf-8"));
      const { wallpaper, tiled } = extractDesktopWallpaper(files);
      return { format: "tdesktop-theme", colors, wallpaper, wallpaperTiled: tiled };
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
    return { format: "tdesktop-theme", colors, wallpaper };
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
  // JSON (legacy / accidental)
  if (t[0] === "{" || t[0] === "[") {
    try {
      const obj = JSON.parse(buf.toString("utf-8").trim());
      if (typeof obj === "object" && obj !== null) {
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
  if (t.split("\n").some((l: string) => l.includes(":") && l.includes(";"))) return "tdesktop-theme";
  if (t.split("\n").some((l: string) => (l.includes("=") && !l.trim().startsWith("//")) || l.includes("WPS"))) return "attheme";
  return null;
}

function renderDoc(doc: ThemeDoc, target: ThemeFormat, name = "TeleBox Theme"): Buffer | null {
  try {
    const wp = normalizeWallpaper(doc.wallpaper || null);
    const tiled = !!doc.wallpaperTiled;
    const slug = doc.wallpaperSlug || null;
    const options = { blur: doc.wallpaperBlur ?? 0, motion: doc.wallpaperMotion ?? true };
    const withWp: ThemeDoc = { ...doc, wallpaper: wp, wallpaperTiled: tiled, wallpaperSlug: slug, wallpaperBlur: doc.wallpaperBlur, wallpaperMotion: doc.wallpaperMotion };

    let buf: Buffer | null = null;
    if (target === "attheme") {
      const text = genAndroid(withWp.colors).join("\n") + "\n";
      buf = attachAtthemeWallpaper(text, wp);
    } else if (target === "tdesktop-theme") {
      buf = buildDesktopTheme(genDesktop(withWp.colors), wp, tiled);
    } else if (target === "tgx-theme") {
      buf = Buffer.from(genTgx(withWp.colors, name, doc.wallpaperSlug || null), "utf-8");
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
        logger.warn(`[theme] renderDoc roundtrip empty for ${target}, using original`);
      }
    } catch {
      logger.warn(`[theme] renderDoc roundtrip failed for ${target}, using original`);
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
  msg: { media: any },
  client: Awaited<ReturnType<typeof getGlobalClient>>,
): Promise<Buffer | null> {
  try {
    if (!msg.media) return null;
    const raw = await client.downloadAsBuffer(msg.media as MtcuteFileDownloadLocation);
    if (!raw) return null;
    return Buffer.from(raw);
  } catch { return null; }
}

// ─── Help text ───────────────────────────────────────────────────────────────

function buildHelpText(): ReturnType<typeof html> {
  return html`
<b>🎨 主题转换器</b>

<b>用法</b>
• 发送主题文件 → 自动转换全部格式
• <code>${mainPrefix}theme &lt;客户端&gt;</code> <i>(回复文件)</i> → 转换到指定客户端
• <code>${mainPrefix}theme link t.me/addtheme/xxx</code> → 获取云端主题
• <code>${mainPrefix}theme cloud</code> <i>(回复文件)</i> → 上传到云端

<b>目标客户端</b>
• <code>android</code> — 📱 Android (.attheme)
• <code>desktop</code> — 💻 Desktop (.tdesktop-theme)
• <code>tgx</code> — 📲 TGX (.tgx-theme)
• <code>ios</code> — 🍎 iOS (.tgios-theme)
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

  async handleCmd(msg: MessageContext): Promise<void> {
    const parts = (msg.text ?? "").trim().split(/\s+/).slice(1);
    const sub = parts[0]?.toLowerCase() || "";
    const client = await getGlobalClient();

    // ── Help ────────────────────────────────────────────────────────────
    if (!sub || sub === "help") {
      await msg.edit({ text: buildHelpText() });
      return;
    }

    // ── link ────────────────────────────────────────────────────────────
    if (sub === "link" && parts[1]) {
      const linkMatch = parts[1].match(/(?:https?:\/\/)?t\.me\/addtheme\/([a-zA-Z0-9_\-\.]+)/);
      if (linkMatch) {
        await this.handleAddThemeLink(msg, linkMatch[1]);
        return;
      }
      await msg.edit({ text: html`❌ 无效链接，格式: <code>t.me/addtheme/xxx</code>` });
      return;
    }

    // ── cloud ───────────────────────────────────────────────────────────
    if (sub === "cloud") {
      await this.handleCloudUpload(msg);
      return;
    }

    // ── direct conversion to target client ──────────────────────────────
    const target = TARGET_ALIASES[sub];
    if (target) {
      await this.handleConvertToTarget(msg, target);
      return;
    }

    // fallback: show help
    await msg.edit({ text: buildHelpText() });
  }

  // ── listen: file attachments + t.me/addtheme links ───────────────────

  listenMessageHandler = async (msg: MessageContext): Promise<void> => {
    try {
      const text = msg.text?.trim();

      // t.me/addtheme link in any message
      if (text) {
        const addthemeMatch = text.match(/(?:https?:\/\/)?t\.me\/addtheme\/([a-zA-Z0-9_\-\.]+)/);
        if (addthemeMatch) {
          await this.handleAddThemeLink(msg, addthemeMatch[1]);
          return;
        }
      }

      // theme file attached
      if (!msg.media || msg.media.type !== "document") return;
      const docInfo = (msg.media as any).document as { fileName?: string; size?: number };
      const name = (docInfo.fileName || "").toLowerCase();
      const size = docInfo.size || 0;
      if (size > MAX_FILE_SIZE || size === 0) return;
      if (!name.endsWith(".attheme") && !name.endsWith(".tdesktop-theme") && !name.endsWith(".tgios-theme") && !name.includes("theme") && !name.includes("tgx")) return;

      await msg.edit({ text: html`⏳ 解析主题文件...` });
      const client = await getGlobalClient();
      const buf = await downloadMedia(msg, client);
      if (!buf || buf.length === 0) return;
      const format = detectFmt(buf);
      if (!format) {
        await msg.edit({ text: html`❌ 无法识别格式，支持 .attheme / .tdesktop-theme / .tgx-theme / .tgios-theme<br/><br/>使用 <code>${mainPrefix}theme</code> 查看帮助` });
        return;
      }
      const parser = format === "attheme" ? parseAttheme : format === "tdesktop-theme" ? parseDesktop : format === "tgx-theme" ? parseTgx : parseIos;
      let doc = parser(buf);
      if (!doc || !Object.keys(doc.colors).length) {
        await msg.edit({ text: html`❌ 解析失败，未找到颜色变量` });
        return;
      }

      // iOS: resolve cloud wallpaper slug → image; other→iOS will upload later
      if (doc.wallpaperSlug && !normalizeWallpaper(doc.wallpaper || null)) {
        await msg.edit({ text: html`⏳ 下载 iOS 云壁纸...` });
        doc = await this.resolveWallpaperBytes(client, doc);
      }

      // When converting to iOS with image wallpaper, upload to get cloud slug
      const needsIosSlug = !doc.wallpaperSlug && !!normalizeWallpaper(doc.wallpaper || null);
      if (needsIosSlug) {
        await msg.edit({ text: html`⏳ 上传聊天背景到云壁纸（iOS 打包）...` });
        doc = await this.ensureIosWallpaperSlug(client, doc);
      }

      const cc = Object.keys(doc.colors).length;
      const hasWp = !!(normalizeWallpaper(doc.wallpaper || null) || doc.wallpaperSlug);
      const targets = (["attheme", "tdesktop-theme", "tgx-theme", "ios-theme"] as ThemeFormat[]).filter(f => f !== format) as ThemeFormat[];

      // convert to all targets (wallpaper preserved via renderDoc; iOS uses slug)
      const converted: { target: ThemeFormat; result: Buffer | null }[] = targets.map(t => ({
        target: t,
        result: renderDoc(doc, t),
      }));

      const count = converted.filter(c => c.result).length;
      const wpNote = normalizeWallpaper(doc.wallpaper || null)
        ? (doc.wallpaperSlug ? "🖼️ 聊天背景已提取（iOS 已绑定云壁纸 slug）" : "🖼️ 聊天背景已提取")
        : (doc.wallpaperSlug ? "🖼️ iOS 云壁纸 slug 已识别" : "");

      await msg.edit({
        text: html`
✅ <b>已识别</b> ${FORMAT_LABELS[format]}
📊 ${cc} 个颜色变量${wpNote ? `<br/>${wpNote}` : ""}

<b>转换：${count}/${targets.length} 个格式</b>

${converted.map((c) => {
  const ok = c.result !== null;
  const label = FORMAT_LABELS[c.target];
  return `${ok ? "✅" : "❌"} ${label}`;
}).join("<br/>")}

<i>回复文件使用</i> <code>${mainPrefix}theme ${"{"}android|desktop|tgx|ios{"}"}</code> <i>转换到单格式</i>
        `,
      });

      // send each successful conversion
      for (let i = 0; i < converted.length; i++) {
        const c = converted[i];
        if (!c.result) continue;
        const emb = !!(normalizeWallpaper(doc.wallpaper || null) && (c.target === "attheme" || c.target === "tdesktop-theme"));
        const iosPacked = !!(c.target === "ios-theme" && doc.wallpaperSlug);
        await client.sendMedia(msg.chat.id, {
          type: "document",
          file: c.result,
          fileName: `theme${FORMAT_EXT[c.target]}`,
          fileMime: API_MIME[c.target],
        } as any, {
          caption: html`
✅ <b>${FORMAT_LABELS[format]}</b> → <b>${FORMAT_LABELS[c.target]}</b>
📊 ${cc} 个颜色变量${emb ? "<br/>🖼️ 壁纸已嵌入" : iosPacked ? "<br/>🖼️ 壁纸已打包为 defaultWallpaper slug" : hasWp ? "<br/>🖼️ 壁纸见附图" : ""}
          `,
          replyTo: msg.id,
        });
      }

      // Sidecar wallpaper only when image exists and target formats cannot fully use slug alone
      // (still useful for manual set / TGX; skip pure iOS-only if already slug-packed and no bytes)
      const wp = normalizeWallpaper(doc.wallpaper || null);
      if (wp) {
        const ext = detectImageExt(wp) === "png" ? "png" : "jpg";
        await client.sendMedia(msg.chat.id, {
          type: "document",
          file: wp,
          fileName: `theme-chat-background.${ext}`,
          fileMime: ext === "png" ? "image/png" : "image/jpeg",
        } as any, {
          caption: html`🖼️ <b>聊天背景</b>${doc.wallpaperSlug ? `（slug: <code>${doc.wallpaperSlug}</code>）` : ""}（Android/Desktop 已嵌入；TGX 请手动设置）`,
          replyTo: msg.id,
        });
      }

      // update the info message with the last note
      // (edit is already done above)
    } catch (e) {
      logger.error("[theme] listen:", e);
    }
  };

  // ── Download a raw TL document correctly ────────────────────────────
  // mtcute downloadAsBuffer needs inputDocumentFileLocation (NOT inputDocument)
  // and Long ids must be passed as-is — Number() destroys 64-bit precision.
  // Fallback: upload.getFile (handles some dc cases better for small theme files).
  private readonly wallpaperSlugCache = new Map<string, string>();

  private async downloadTlDocument(
    client: Awaited<ReturnType<typeof getGlobalClient>>,
    doc: any,
    retries = 2,
  ): Promise<Buffer | null> {
    if (!doc || doc._ !== "document") return null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const inputLoc = {
          _: "inputDocumentFileLocation" as const,
          id: doc.id,
          accessHash: doc.accessHash,
          fileReference: doc.fileReference || new Uint8Array(0),
          thumbSize: "",
        };
        const fileSize = doc.size != null ? Number(doc.size) : undefined;

        // 1) FileLocation with positional (location, fileSize, dcId)
        try {
          const raw = await client.downloadAsBuffer(
            new FileLocation(inputLoc, fileSize, doc.dcId) as any,
          );
          if (raw && (raw as any).length) return Buffer.from(raw as any);
        } catch (e) {
          if (attempt === retries) logger.warn(`[theme] download FileLocation failed:`, getErrorMessage(e));
        }

        // 2) raw inputDocumentFileLocation
        try {
          const raw = await client.downloadAsBuffer(inputLoc as any);
          if (raw && (raw as any).length) return Buffer.from(raw as any);
        } catch { /* */ }

        // 3) upload.getFile direct (works when downloadAsBuffer returns empty / FILE_MIGRATE)
        try {
          const parts: Buffer[] = [];
          let offset = 0;
          const limit = 512 * 1024;
          const total = fileSize && fileSize > 0 ? fileSize : Infinity;
          while (offset < total) {
            const r: any = await client.call({
              _: "upload.getFile",
              precise: true,
              cdnSupported: true,
              location: inputLoc,
              offset,
              limit,
            } as any);
            if (r?._ === "upload.file" && r.bytes) {
              const chunk = Buffer.from(r.bytes);
              parts.push(chunk);
              offset += chunk.length;
              if (chunk.length < limit) break;
            } else if (r?._ === "upload.fileCdnRedirect") {
              logger.warn("[theme] CDN redirect not handled");
              break;
            } else {
              break;
            }
          }
          if (parts.length) return Buffer.concat(parts);
        } catch (e) {
          if (attempt === retries) logger.warn(`[theme] upload.getFile failed:`, getErrorMessage(e));
        }
        logger.warn(`[theme] downloadTlDocument attempt ${attempt} failed, retries left: ${retries - attempt}`);
      } catch (e) {
        logger.warn(`[theme] downloadTlDocument attempt ${attempt} failed:`, getErrorMessage(e));
      }
    }
    return null;
  }

  /** Resolve iOS cloud wallpaper slug → image bytes via account.getWallPaper */
  private async downloadWallpaperBySlug(
    client: Awaited<ReturnType<typeof getGlobalClient>>,
    slug: string,
  ): Promise<Buffer | null> {
    if (!slug || slug.length < 4) return null;
    try {
      const wp: any = await client.call({
        _: "account.getWallPaper",
        wallpaper: { _: "inputWallPaperSlug", slug },
      } as any);
      if (wp?._ === "wallPaper" && wp.document?._ === "document") {
        return await this.downloadTlDocument(client, wp.document);
      }
      return null;
    } catch (e) {
      logger.warn("[theme] getWallPaper failed:", getErrorMessage(e));
      return null;
    }
  }

  /**
   * Upload image bytes as cloud wallpaper and return its slug for iOS
   * `chat.defaultWallpaper: <slug>`.
   */
  private async uploadWallpaperForIos(
    client: Awaited<ReturnType<typeof getGlobalClient>>,
    image: Buffer,
  ): Promise<string | null> {
    try {
      const wp = normalizeWallpaper(image);
      if (!wp) return null;
      const ext = detectImageExt(wp) === "png" ? "png" : "jpg";
      const mime = ext === "png" ? "image/png" : "image/jpeg";
      const uploaded: any = await client.uploadFile({
        file: wp,
        fileName: `theme-wallpaper.${ext}`,
        fileMime: mime,
      } as any);
      // uploadFile may return InputFile or document-like — prefer inputFile for uploadWallPaper
      let inputFile: any = uploaded;
      if (uploaded && uploaded._ !== "inputFile" && uploaded._ !== "inputFileBig") {
        // some mtcute versions wrap
        if (uploaded.inputFile) inputFile = uploaded.inputFile;
        else if (uploaded.file) inputFile = uploaded.file;
      }
      const result: any = await client.call({
        _: "account.uploadWallPaper",
        file: inputFile,
        mimeType: mime,
        settings: {
          _: "wallPaperSettings",
          blur: false,
          motion: false,
          intensity: 50,
        },
      } as any);
      if (result?._ === "wallPaper" && result.slug) {
        return String(result.slug);
      }
      logger.warn("[theme] uploadWallPaper unexpected:", result?._);
      return null;
    } catch (e) {
      logger.warn("[theme] uploadWallPaper failed:", getErrorMessage(e));
      return null;
    }
  }

  /** Ensure ThemeDoc has wallpaper bytes if only iOS slug is known */
  private async resolveWallpaperBytes(
    client: Awaited<ReturnType<typeof getGlobalClient>>,
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
        this.wallpaperSlugCache.set(doc.wallpaperSlug, img.toString("base64"));
        return { ...doc, wallpaper: img };
      }
    }
    return doc;
  }

  /** Ensure ThemeDoc has iOS wallpaper slug if only image bytes are known */
  private async ensureIosWallpaperSlug(
    client: Awaited<ReturnType<typeof getGlobalClient>>,
    doc: ThemeDoc,
  ): Promise<ThemeDoc> {
    if (doc.wallpaperSlug) return doc;
    const wp = normalizeWallpaper(doc.wallpaper || null);
    if (!wp) return doc;
    // Check reverse cache: already uploaded this image?
    for (const [slug, b64] of this.wallpaperSlugCache) {
      if (Buffer.from(b64, "base64").equals(wp)) return { ...doc, wallpaperSlug: slug };
    }
    const slug = await this.uploadWallpaperForIos(client, wp);
    if (slug) {
      this.wallpaperSlugCache.set(slug, wp.toString("base64"));
      return { ...doc, wallpaperSlug: slug };
    }
    return doc;
  }

  /** Infer ThemeFormat from mime / filename / content */
  private inferThemeFormat(doc: any, buf: Buffer): ThemeFormat | null {
    const mime = (doc.mimeType || "").toLowerCase();
    const name = ((doc.attributes || []).find((a: any) => a._ === "documentAttributeFilename")?.fileName || "").toLowerCase();
    if (mime.includes("tgtheme-android") || name.endsWith(".attheme")) return "attheme";
    if (mime.includes("tgtheme-tdesktop") || name.endsWith(".tdesktop-theme")) return "tdesktop-theme";
    if (mime.includes("tgtheme-macos") || name.includes("tgx") || name.endsWith(".tgx-theme")) return "tgx-theme";
    if (mime.includes("tgtheme-ios") || name.endsWith(".tgios-theme") || name.endsWith(".ios-theme")) return "ios-theme";
    return detectFmt(buf);
  }

  /** Collect themeSettings from theme / webPageAttributeTheme */
  private collectThemeSettings(source: any): any | null {
    if (!source) return null;
    if (source._ === "themeSettings" || source.accentColor != null || source.baseTheme) return source;
    if (Array.isArray(source.settings) && source.settings[0]) return source.settings[0];
    if (source.settings && (source.settings._ === "themeSettings" || source.settings.accentColor != null)) {
      return source.settings;
    }
    // theme.settings is Vector<ThemeSettings>
    if (Array.isArray(source.settings)) {
      for (const s of source.settings) {
        if (s && (s._ === "themeSettings" || s.accentColor != null || s.wallpaper)) return s;
      }
    }
    for (const attr of source.attributes || []) {
      if (attr._ === "webPageAttributeTheme") {
        if (attr.settings) return attr.settings;
      }
    }
    return null;
  }

  /** Download wallpaper image document from themeSettings.wallpaper (wallPaper) */
  private async downloadWallpaperFromSettings(
    client: Awaited<ReturnType<typeof getGlobalClient>>,
    settings: any,
  ): Promise<{ bytes: Buffer | null; slug: string | null; blur: number; motion: boolean }> {
    try {
      const wp = settings?.wallpaper;
      if (!wp) return { bytes: null, slug: null, blur: 0, motion: true };
      // wallPaper { document, slug, settings } | wallPaperNoFile
      const slug = (wp._ === "wallPaper" && typeof wp.slug === "string" && wp.slug.length > 8)
        ? wp.slug
        : null;
      // Extract wallpaper options from wallpaper settings
      const wpSettings = wp.settings || {};
      const blur = (typeof wpSettings.blur === "number" ? wpSettings.blur : 0);
      const motion = wpSettings.motion !== false;
      if (wp._ === "wallPaper" && wp.document?._ === "document") {
        const bytes = await this.downloadTlDocument(client, wp.document);
        return { bytes, slug, blur, motion };
      }
      if (wp.document?._ === "document") {
        const bytes = await this.downloadTlDocument(client, wp.document);
        return { bytes, slug, blur, motion };
      }
      return { bytes: null, slug, blur, motion };
    } catch (e) {
      logger.warn("[theme] wallpaper download failed:", getErrorMessage(e));
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
    const doc: ThemeDoc = {
      format: "attheme",
      colors,
      wallpaper: normalizeWallpaper(wallpaper || null),
      wallpaperSlug: wallpaperSlug || null,
      wallpaperBlur: wallpaperBlur ?? 0,
      wallpaperMotion: wallpaperMotion ?? true,
    };
    const fmtMap: Record<string, { format: ThemeFormat; buf: Buffer }> = {};
    for (const format of ["attheme", "tdesktop-theme", "tgx-theme", "ios-theme"] as ThemeFormat[]) {
      const buf = renderDoc(doc, format, title);
      if (buf) fmtMap[format] = { format, buf };
    }
    // stash wallpaper for sidecar send via special key on first entry — callers use parse path
    (fmtMap as any).__wallpaper = doc.wallpaper || null;
    return Object.keys(fmtMap).length ? fmtMap : null;
  }

  // ── Handle t.me/addtheme/SLUG ────────────────────────────────────────

  private async handleAddThemeLink(msg: MessageContext, slug: string): Promise<void> {
    const client = await getGlobalClient();
    try {
      await msg.edit({ text: html`⏳ 获取主题 <code>${slug}</code>...` });

      const fmtMap: Record<string, { format: ThemeFormat; buf: Buffer }> = {};
      let themeTitle = slug;
      const errors: string[] = [];
      let settingsFallback: any = null;
      const url = `https://t.me/addtheme/${slug}`;

      // ── Strategy 1: messages.getWebPage (like clients do) ──────────────
      // This is what real Telegram clients use and works for cloud accent themes.
      let webPage: any = null;
      try {
        const wpResult: any = await client.call({
          _: "messages.getWebPage",
          url,
          hash: 0,
        } as any);
        if (wpResult?._ === "messages.webPage" && wpResult.webpage?._ === "webPage") {
          webPage = wpResult.webpage;
        } else if (wpResult?.webpage?._ === "webPage") {
          webPage = wpResult.webpage;
        } else if (wpResult?._ === "webPage") {
          webPage = wpResult;
        }
      } catch (e) {
        errors.push(`getWebPage: ${getErrorMessage(e)}`);
      }

      if (!webPage) {
        try {
          const preview: any = await client.call({
            _: "messages.getWebPagePreview",
            message: url,
          } as any);
          const media = preview?.media || preview;
          if (media?._ === "messageMediaWebPage" && media.webpage?._ === "webPage") {
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
          if (attr._ === "webPageAttributeTheme" && Array.isArray(attr.documents)) {
            for (const d of attr.documents) {
              if (d?._ === "document") docs.push(d);
            }
          }
        }
        if (webPage.document?._ === "document") docs.push(webPage.document);
      }

      let idx = 0;
      for (const doc of docs) {
        const buf = await this.downloadTlDocument(client, doc);
        if (!buf) {
          errors.push(`doc#${idx}: download failed`);
          idx++;
          continue;
        }
        const format = this.inferThemeFormat(doc, buf);
        if (!format) {
          errors.push(`doc#${idx}: unknown format mime=${doc.mimeType}`);
          idx++;
          continue;
        }
        if (!fmtMap[format]) fmtMap[format] = { format, buf };
        idx++;
      }

      // If we have at least one format from webpage, deliver immediately
      if (Object.keys(fmtMap).length > 0) {
        await this.sendThemeResults(msg, themeTitle, slug, fmtMap);
        return;
      }

      // ── Strategy 2: synthesize from themeSettings (cloud accent themes) ──
      // Many installable themes only ship settings, no document. Clients still
      // install them via the settings alone. We generate all 4 formats.
      if (settingsFallback) {
        const { bytes: cloudWp, slug: wpSlug, blur: wpBlur, motion: wpMotion } =
          await this.downloadWallpaperFromSettings(client, settingsFallback);
        const synth = this.synthesizeFromSettings(
          settingsFallback, themeTitle, cloudWp, wpSlug, wpBlur, wpMotion,
        );
        if (synth && Object.keys(synth).length > 0) {
          await this.sendThemeResults(msg, themeTitle, slug, synth, true, cloudWp);
          return;
        }
        // If synthesis failed, log why
        const accent = settingsFallback.accentColor;
        errors.push(`synth: accent=${accent} base=${settingsFallback.baseTheme} wp=${!!settingsFallback.wallpaper}`);
      }

      // ── Strategy 3: account.getTheme for each client format (last resort) ──
      // This is slow and often returns empty document for cloud themes, but
      // may have additional formats not in the webpage.
      const apiFormats = ["android", "tdesktop", "macos", "ios"] as const;
      for (const f of apiFormats) {
        try {
          const raw: any = await client.call({
            _: "account.getTheme",
            format: f,
            theme: { _: "inputThemeSlug", slug },
          } as any);
          if (raw?._ !== "theme") continue;
          if (raw.title) themeTitle = raw.title;
          if (!settingsFallback) settingsFallback = this.collectThemeSettings(raw);
          if (raw.document?._ === "document") {
            const buf = await this.downloadTlDocument(client, raw.document);
            if (!buf) {
              errors.push(`getTheme(${f}): download failed`);
              continue;
            }
            const format = this.inferThemeFormat(raw.document, buf) || ({
              android: "attheme", tdesktop: "tdesktop-theme", macos: "tgx-theme", ios: "ios-theme",
            } as const)[f];
            // Don't overwrite an existing format from webpage
            if (!fmtMap[format]) fmtMap[format] = { format, buf };
          }
        } catch (e) {
          errors.push(`getTheme(${f}): ${getErrorMessage(e)}`);
        }
      }

      if (Object.keys(fmtMap).length > 0) {
        await this.sendThemeResults(msg, themeTitle, slug, fmtMap);
        return;
      }

      // ── Final: try synthesis from settingsFallback obtained via getTheme ──
      if (settingsFallback) {
        const { bytes: cloudWp, slug: wpSlug, blur: wpBlur, motion: wpMotion } =
          await this.downloadWallpaperFromSettings(client, settingsFallback);
        const synth = this.synthesizeFromSettings(
          settingsFallback, themeTitle, cloudWp, wpSlug, wpBlur, wpMotion,
        );
        if (synth && Object.keys(synth).length > 0) {
          await this.sendThemeResults(msg, themeTitle, slug, synth, true, cloudWp);
          return;
        }
      }

      if (!webPage) {
        await msg.edit({
          text: html`
❌ 无法获取主题 <code>${slug}</code>
<br/><br/><i>调试: ${errors.slice(0, 3).join(" | ") || "无响应"}</i>
          `,
        });
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
        `,
      });
    } catch (e: any) {
      logger.error("[theme] handleAddThemeLink:", e);
      await msg.edit({ text: html`❌ 获取失败: ${getErrorMessage(e)}` });
    }
  }

  /** Shared: parse + convert downloaded theme files, send results */
  private async sendThemeResults(
    msg: MessageContext,
    title: string,
    slug: string,
    fmtMap: Record<string, { format: ThemeFormat; buf: Buffer }>,
    synthesized = false,
    extraWallpaper?: Buffer | null,
  ): Promise<void> {
    const client = await getGlobalClient();
    const byFormat = new Map<ThemeFormat, Buffer>();
    for (const [k, info] of Object.entries(fmtMap)) {
      if (k.startsWith("__")) continue;
      if (info && info.format && info.buf && !byFormat.has(info.format)) byFormat.set(info.format, info.buf);
    }

    // Wallpaper source priority: Android first (mobile), then iOS/TGX, Desktop last.
    // Official multi-format themes often ship DIFFERENT wallpapers per platform;
    // Android / TGX / iOS are mobile — share Android wallpaper when available.
    const parseByFmt = (fmt: ThemeFormat, buf: Buffer): ThemeDoc | null => {
      if (fmt === "attheme") return parseAttheme(buf);
      if (fmt === "tdesktop-theme") return parseDesktop(buf);
      if (fmt === "tgx-theme") return parseTgx(buf);
      if (fmt === "ios-theme") return parseIos(buf);
      return null;
    };

    const wallpaperPriority: ThemeFormat[] = [
      "attheme",       // Android — preferred for all mobile clients
      "ios-theme",     // iOS cloud slug / solid
      "tgx-theme",     // TGX (usually no embed)
      "tdesktop-theme", // Desktop last — often a different (desktop-sized) image
    ];

    // Collect per-format parsed docs (for wallpaper + slug)
    const parsedByFmt = new Map<ThemeFormat, ThemeDoc>();
    for (const [fmt, buf] of byFormat) {
      const doc = parseByFmt(fmt, buf);
      if (doc) parsedByFmt.set(fmt, doc);
    }

    // LOSSLESS: merge ALL source formats' colors + wallpaper metadata into one doc.
    // Previously we only picked the "richest" single format, dropping unique keys
    // from other platforms (e.g. Desktop-only vars when Android was chosen).
    const colorPickOrder: ThemeFormat[] = ["attheme", "ios-theme", "tgx-theme", "tdesktop-theme"];
    const allDocs = colorPickOrder
      .map(f => parsedByFmt.get(f))
      .filter((d): d is ThemeDoc => !!d);
    // include any unexpected formats
    for (const [fmt, doc] of parsedByFmt) {
      if (!allDocs.includes(doc)) allDocs.push(doc);
    }

    let bestDoc: ThemeDoc | null = mergeThemeDocs(allDocs, colorPickOrder);
    let bestFmt: ThemeFormat | null = bestDoc?.format || null;
    let bestCount = bestDoc ? Object.keys(bestDoc.colors).length : 0;
    // Track which sources contributed (for UI)
    const sourceFmts = allDocs.map(d => d.format);

    // Fallback: if merge empty, pick richest single doc (legacy path)
    if (!bestDoc || bestCount === 0) {
      for (const fmt of colorPickOrder) {
        const doc = parsedByFmt.get(fmt);
        if (!doc) continue;
        const cc = Object.keys(doc.colors).length;
        if (cc > bestCount) {
          bestDoc = doc;
          bestFmt = fmt;
          bestCount = cc;
        }
      }
      for (const [fmt, doc] of parsedByFmt) {
        const cc = Object.keys(doc.colors).length;
        if (cc > bestCount) {
          bestDoc = doc;
          bestFmt = fmt;
          bestCount = cc;
        }
      }
    }

    // Resolve iOS/TGX slug → bytes early so it can participate in wallpaper priority
    for (const fmt of ["ios-theme", "tgx-theme"] as ThemeFormat[]) {
      const d = parsedByFmt.get(fmt);
      if (d?.wallpaperSlug && !normalizeWallpaper(d.wallpaper || null)) {
        const resolved = await this.resolveWallpaperBytes(client, d);
        parsedByFmt.set(fmt, resolved);
        // Re-merge after resolving wallpaper bytes
        if (bestDoc) {
          bestDoc = mergeThemeDocs(
            colorPickOrder.map(f => parsedByFmt.get(f)).filter((x): x is ThemeDoc => !!x),
            colorPickOrder,
          ) || bestDoc;
          bestCount = Object.keys(bestDoc.colors).length;
        }
      }
    }

    // Pick wallpaper by mobile-first priority (Android wins over Desktop)
    let wallpaper: Buffer | null = normalizeWallpaper(bestDoc?.wallpaper || null);
    let wallpaperSlug: string | null = bestDoc?.wallpaperSlug || null;
    let wallpaperSource: string | null = null;
    let wallpaperTiled = !!bestDoc?.wallpaperTiled;
    let wallpaperBlur = bestDoc?.wallpaperBlur;
    let wallpaperMotion = bestDoc?.wallpaperMotion;

    for (const fmt of wallpaperPriority) {
      const d = parsedByFmt.get(fmt);
      if (!d) continue;
      if (!wallpaperSlug && d.wallpaperSlug) {
        wallpaperSlug = d.wallpaperSlug;
        if (!wallpaperSource) wallpaperSource = fmt;
      }
      const w = normalizeWallpaper(d.wallpaper || null);
      if (w && !wallpaper) {
        wallpaper = w;
        wallpaperSource = fmt;
        if (d.wallpaperTiled) wallpaperTiled = true;
        if (d.wallpaperBlur != null) wallpaperBlur = d.wallpaperBlur;
        if (d.wallpaperMotion != null) wallpaperMotion = d.wallpaperMotion;
        // Android found — stop; never let later Desktop override
        if (fmt === "attheme") break;
      } else if (w && !wallpaperSource) {
        wallpaperSource = fmt;
      }
    }

    // extras only if no platform file provided wallpaper
    if (!wallpaper) {
      wallpaper = normalizeWallpaper(extraWallpaper || null)
        || normalizeWallpaper((fmtMap as any).__wallpaper || null);
      if (wallpaper) wallpaperSource = wallpaperSource || "settings";
    }
    // last chance: resolve remaining iOS/TGX slug
    if (!wallpaper && wallpaperSlug) {
      const img = await this.downloadWallpaperBySlug(client, wallpaperSlug);
      if (img) {
        wallpaper = img;
        wallpaperSource = wallpaperSource || "ios-slug";
      }
    }

    if (bestDoc) {
      bestDoc = {
        ...bestDoc,
        wallpaper,
        wallpaperSlug,
        wallpaperTiled,
        wallpaperBlur,
        wallpaperMotion,
      };
      // Upload image → iOS/TGX cloud slug so packages can reference wallpaper
      if (!bestDoc.wallpaperSlug && normalizeWallpaper(bestDoc.wallpaper || null)) {
        bestDoc = await this.ensureIosWallpaperSlug(client, bestDoc);
        wallpaperSlug = bestDoc.wallpaperSlug || null;
      }
      wallpaper = normalizeWallpaper(bestDoc.wallpaper || null) || wallpaper;
      wallpaperSlug = bestDoc.wallpaperSlug || wallpaperSlug;
      bestCount = Object.keys(bestDoc.colors).length;
    }

    // If originals failed parse but we have buffers that are already rendered, still send them
    if (!bestDoc || !bestFmt) {
      for (const [fmt, buf] of byFormat) {
        const det = detectFmt(buf);
        if (!det) continue;
        const parser = det === "attheme" ? parseAttheme : det === "tdesktop-theme" ? parseDesktop : det === "tgx-theme" ? parseTgx : parseIos;
        const doc = parser(buf);
        if (doc && Object.keys(doc.colors).length > bestCount) {
          bestDoc = { ...doc, wallpaper: normalizeWallpaper(doc.wallpaper) || wallpaper, wallpaperSlug };
          bestFmt = det;
          bestCount = Object.keys(doc.colors).length;
        }
      }
    }

    if (!bestDoc || !bestFmt) {
      const sentRaw: string[] = [];
      for (const [fmt, buf] of byFormat) {
        await client.sendMedia(msg.chat.id, {
          type: "document",
          file: buf,
          fileName: `${slug || "theme"}${FORMAT_EXT[fmt]}`,
          fileMime: API_MIME[fmt],
        } as any, {
          caption: html`✅ <b>${FORMAT_LABELS[fmt]}</b>（原始文件）`,
          replyTo: msg.id,
        });
        sentRaw.push(FORMAT_LABELS[fmt]);
      }
      if (sentRaw.length) {
        await msg.edit({
          text: html`
🎨 <b>${title}</b>
🔗 <code>t.me/addtheme/${slug}</code>
<br/>✅ 已输出: ${sentRaw.join(" · ")}
          `,
        });
        return;
      }
      await msg.edit({ text: html`❌ 主题文件解析失败（无颜色变量）` });
      return;
    }

    // LOSSLESS output strategy:
    // - Same-format original: keep native file when it already has wallpaper/colors,
    //   but re-render from merged palette when original is missing keys/wallpaper.
    // - Missing format: always render from merged bestDoc (all platforms' colors).
    // - Desktop: keep OWN wallpaper if present; else fall back to mobile-priority.
    const ensureWallpaper = (target: ThemeFormat, buf: Buffer): Buffer => {
      const preferred = wallpaper;
      const preferredSlug = wallpaperSlug || bestDoc?.wallpaperSlug || null;
      const mergedBase: ThemeDoc = {
        ...bestDoc!,
        wallpaper: preferred,
        wallpaperSlug: preferredSlug,
        wallpaperTiled: target === "tdesktop-theme" ? wallpaperTiled : bestDoc!.wallpaperTiled,
        wallpaperBlur,
        wallpaperMotion,
      };

      if (target === "attheme") {
        const parsed = parseAttheme(buf);
        const existing = normalizeWallpaper(parsed?.wallpaper || null);
        // If original Android has wallpaper AND its color count is near merged, keep original
        // Otherwise re-render from merged palette (fills missing keys from other platforms)
        const origCount = parsed ? Object.keys(parsed.colors).length : 0;
        if (existing && origCount >= bestCount * 0.95) return buf;
        return renderDoc({
          ...mergedBase,
          wallpaper: existing || preferred,
          // Prefer Android-native colors first, then fill from merged
          colors: expandColorAliases({ ...(parsed?.colors || {}), ...mergedBase.colors }),
        }, "attheme", title) || buf;
      }

      if (target === "tdesktop-theme") {
        const parsed = parseDesktop(buf);
        const ownWp = normalizeWallpaper(parsed?.wallpaper || null);
        const origCount = parsed ? Object.keys(parsed.colors).length : 0;
        // Keep own wallpaper; still re-render colors if merged has more keys
        if (ownWp && origCount >= bestCount * 0.95) return buf;
        return renderDoc({
          ...mergedBase,
          colors: expandColorAliases({ ...(parsed?.colors || {}), ...mergedBase.colors }),
          wallpaper: ownWp || preferred,
          wallpaperTiled: !!parsed?.wallpaperTiled || wallpaperTiled,
        }, "tdesktop-theme", title) || buf;
      }

      if (target === "ios-theme") {
        const parsed = parseIos(buf);
        const origCount = parsed ? Object.keys(parsed.colors).length : 0;
        const slugOk = !!parsed?.wallpaperSlug && (!preferredSlug || parsed.wallpaperSlug === preferredSlug);
        if (slugOk && origCount >= bestCount * 0.95) return buf;
        return renderDoc({
          ...mergedBase,
          colors: expandColorAliases({ ...(parsed?.colors || {}), ...mergedBase.colors }),
          wallpaperSlug: preferredSlug || parsed?.wallpaperSlug || null,
          wallpaperBlur: wallpaperBlur ?? parsed?.wallpaperBlur,
          wallpaperMotion: wallpaperMotion ?? parsed?.wallpaperMotion,
          basedOn: parsed?.basedOn || mergedBase.basedOn,
        }, "ios-theme", title) || buf;
      }

      if (target === "tgx-theme") {
        const parsed = parseTgx(buf);
        const origCount = parsed ? Object.keys(parsed.colors).length : 0;
        const slugOk = !preferredSlug || parsed?.wallpaperSlug === preferredSlug;
        if (slugOk && origCount >= bestCount * 0.95) return buf;
        return renderDoc({
          ...mergedBase,
          colors: expandColorAliases({ ...(parsed?.colors || {}), ...mergedBase.colors }),
          wallpaperSlug: preferredSlug || parsed?.wallpaperSlug || null,
        }, "tgx-theme", title) || buf;
      }

      return buf;
    };

    const allTargets = (["attheme", "tdesktop-theme", "tgx-theme", "ios-theme"] as ThemeFormat[]);
    const sent: string[] = [];
    let wpSidecarSent = false;

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
      if (!out) continue;

      // Caption wallpaper note: Desktop keeps own image if any; else falls back
      let wpNote = "";
      if (target === "attheme") {
        const p = parseAttheme(out);
        if (normalizeWallpaper(p?.wallpaper || null)) {
          wpNote = wallpaperSource === "attheme" || !wallpaperSource
            ? " · 🖼️ 壁纸已嵌入"
            : ` · 🖼️ 壁纸已嵌入（回退自 ${wallpaperSource === "ios-theme" || wallpaperSource === "ios-slug" ? "iOS" : wallpaperSource}）`;
        }
      } else if (target === "tdesktop-theme") {
        const p = parseDesktop(out);
        if (normalizeWallpaper(p?.wallpaper || null)) {
          // If original desktop package had wallpaper, we kept it
          const orig = byFormat.has("tdesktop-theme") ? parseDesktop(byFormat.get("tdesktop-theme")!) : null;
          const keptOwn = !!(orig && normalizeWallpaper(orig.wallpaper || null));
          wpNote = keptOwn
            ? " · 🖼️ 壁纸已保留（Desktop 原图）"
            : ` · 🖼️ 壁纸已嵌入（Desktop 无原图，回退 ${wallpaperSource === "attheme" ? "Android" : wallpaperSource || "移动端"}）`;
        }
      } else if (target === "ios-theme" && (wallpaperSlug || bestDoc?.wallpaperSlug)) {
        wpNote = " · 🖼️ defaultWallpaper slug 已打包";
      } else if (target === "tgx-theme" && (wallpaperSlug || bestDoc?.wallpaperSlug)) {
        wpNote = " · 🖼️ wallpaper slug 已打包";
      }

      await client.sendMedia(msg.chat.id, {
        type: "document",
        file: out,
        fileName: `${slug || "theme"}${FORMAT_EXT[target]}`,
        fileMime: API_MIME[target],
      } as any, {
        caption: html`✅ <b>${FORMAT_LABELS[target]}</b>${fromLabel === "设置合成" ? "（从云端颜色设置生成）" : fromLabel === "原始" ? "（原始）" : fromLabel === "多源合并" ? "（多源无损合并）" : ` ← ${fromLabel}`} 📊 ${bestCount} 色${wpNote}`,
        replyTo: msg.id,
      });
      sent.push(FORMAT_LABELS[target]);
    }

    // Sidecar: mobile-priority wallpaper (Android first) for TGX / manual use
    if (wallpaper && !wpSidecarSent) {
      const ext = detectImageExt(wallpaper) === "png" ? "png" : "jpg";
      const srcLabel = wallpaperSource === "attheme" ? "Android"
        : wallpaperSource === "ios-theme" || wallpaperSource === "ios-slug" ? "iOS"
        : wallpaperSource === "tdesktop-theme" ? "Desktop"
        : wallpaperSource === "settings" ? "云端设置"
        : wallpaperSource || "unknown";
      await client.sendMedia(msg.chat.id, {
        type: "document",
        file: wallpaper,
        fileName: `${slug || "theme"}-chat-background.${ext}`,
        fileMime: ext === "png" ? "image/png" : "image/jpeg",
      } as any, {
        caption: html`🖼️ <b>移动端聊天背景</b>（来源: ${srcLabel}${wallpaperSlug ? ` · iOS slug: <code>${wallpaperSlug}</code>` : ""}；优先级 Android→iOS→TGX→Desktop）`,
        replyTo: msg.id,
      });
      wpSidecarSent = true;
    }

    const desktopOwn = (() => {
      const b = byFormat.get("tdesktop-theme");
      if (!b) return false;
      return !!normalizeWallpaper(parseDesktop(b)?.wallpaper || null);
    })();

    await msg.edit({
      text: html`
🎨 <b>${title}</b>
🔗 <code>t.me/addtheme/${slug}</code>
📊 源: ${synthesized ? "云端颜色设置" : `${sourceFmts.map(f => FORMAT_LABELS[f]).join(" + ") || FORMAT_LABELS[bestFmt]}（合并 ${bestCount} 色）`}
${wallpaper || wallpaperSlug ? `<br/>🖼️ 移动端壁纸: ${wallpaperSource === "attheme" ? "Android" : wallpaperSource || "已保留"}${wallpaperSlug ? ` · slug <code>${wallpaperSlug}</code>` : ""}` : ""}
${desktopOwn ? "<br/>🖥️ Desktop 使用自带壁纸（有原图则不覆盖）" : wallpaper ? "<br/>🖥️ Desktop 无原图 → 回退移动端壁纸" : ""}
<br/>✅ 已输出: ${sent.join(" · ") || "无"}
<br/><i>无损: 多端配色合并 · 移动端优先 Android 壁纸 · Desktop 原壁纸保留</i>
      `,
    });
  }

  // ── Handle cloud upload ──────────────────────────────────────────────

  private async handleCloudUpload(msg: MessageContext): Promise<void> {
    if (!msg.replyToMessage?.id) {
      await msg.edit({ text: html`❌ 请回复一个主题文件后再使用 <code>${mainPrefix}theme cloud</code>` });
      return;
    }
    const client = await getGlobalClient();
    try {
      const reply = await safeGetReplyMessage(msg);
      if (!reply || !(reply as any).media || (reply as any).media.type !== "document") {
        await msg.edit({ text: html`❌ 回复的消息不是文件` }); return;
      }
      await msg.edit({ text: html`⏳ 下载并解析主题...` });
      const buf = await downloadMedia(reply, client);
      if (!buf || buf.length === 0) { await msg.edit({ text: html`❌ 下载失败` }); return; }
      const format = detectFmt(buf);
      if (!format) { await msg.edit({ text: html`❌ 无法识别主题格式` }); return; }
      const parser = format === "attheme" ? parseAttheme : format === "tdesktop-theme" ? parseDesktop : format === "tgx-theme" ? parseTgx : parseIos;
      const doc = parser(buf);
      if (!doc || !Object.keys(doc.colors).length) { await msg.edit({ text: html`❌ 解析失败` }); return; }
      await msg.edit({ text: html`⏳ 上传到 Telegram 云端...` });

      const slug = genSlug();
      const converted = renderDoc(doc, format) || buf;
      const uploaded = await client.uploadFile({
        file: converted,
        fileName: `theme${FORMAT_EXT[format]}`,
        fileMime: API_MIME[format],
      });
      const created: any = await client.call({
        _: "account.createTheme",
        slug,
        title: `TeleBox Theme (${FORMAT_LABELS[format]})`,
        document: { _: "inputDocument", id: (uploaded as any).id, accessHash: (uploaded as any).accessHash },
      } as any);

      const themeSlug = (created as any).slug || slug;
      const link = `https://t.me/addtheme/${themeSlug}`;
      await msg.edit({
        text: html`
✅ <b>云端主题创建成功！</b>

<a href="${link}">${link}</a>

📊 ${Object.keys(doc.colors).length} 个颜色变量
        `,
      });
    } catch (e: any) {
      await msg.edit({ text: html`❌ 云端上传失败: ${getErrorMessage(e)}` });
    }
  }

  // ── Handle convert to target client (auto-detect source) ─────────────

  private async handleConvertToTarget(msg: MessageContext, target: ThemeFormat): Promise<void> {
    if (!msg.replyToMessage?.id) {
      await msg.edit({ text: html`❌ 请回复主题文件后使用 <code>${mainPrefix}theme ${target}</code>` });
      return;
    }
    const client = await getGlobalClient();
    try {
      const reply = await safeGetReplyMessage(msg);
      if (!reply || !(reply as any).media || (reply as any).media.type !== "document") {
        await msg.edit({ text: html`❌ 回复不是文件` }); return;
      }
      await msg.edit({ text: html`⏳ 转换为 ${TARGET_CLIENT_LABELS[target]}...` });
      const buf = await downloadMedia(reply, client);
      if (!buf || buf.length === 0) { await msg.edit({ text: html`❌ 下载失败` }); return; }
      const format = detectFmt(buf);
      if (!format) { await msg.edit({ text: html`❌ 无法识别文件格式` }); return; }
      if (format === target) { await msg.edit({ text: html`❌ 文件已经是 ${TARGET_CLIENT_LABELS[target]} 格式` }); return; }
      const parsers: Record<string, (b: Buffer) => ThemeDoc | null> = {
        attheme: parseAttheme, "tdesktop-theme": parseDesktop, "tgx-theme": parseTgx, "ios-theme": parseIos,
      };
      let doc = parsers[format](buf);
      if (!doc || !Object.keys(doc.colors).length) { await msg.edit({ text: html`❌ 解析失败` }); return; }

      // Resolve / package wallpaper for target
      if (doc.wallpaperSlug && !normalizeWallpaper(doc.wallpaper || null)) {
        await msg.edit({ text: html`⏳ 下载 iOS 云壁纸...` });
        doc = await this.resolveWallpaperBytes(client, doc);
      }
      if (target === "ios-theme" && !doc.wallpaperSlug && normalizeWallpaper(doc.wallpaper || null)) {
        await msg.edit({ text: html`⏳ 上传聊天背景到云壁纸（iOS 打包）...` });
        doc = await this.ensureIosWallpaperSlug(client, doc);
      }

      const out = renderDoc(doc, target);
      if (!out) { await msg.edit({ text: html`❌ 转换失败` }); return; }
      const cc = Object.keys(doc.colors).length;
      const wp = normalizeWallpaper(doc.wallpaper || null);
      const emb = !!(wp && (target === "attheme" || target === "tdesktop-theme"));
      const iosPacked = !!(target === "ios-theme" && doc.wallpaperSlug);
      await msg.delete();
      await client.sendMedia(msg.chat.id, {
        type: "document",
        file: out,
        fileName: `theme${FORMAT_EXT[target]}`,
        fileMime: API_MIME[target],
      } as any, {
        caption: html`
✅ <b>转换完成</b> ${TARGET_CLIENT_LABELS[target]}
📊 ${cc} 个颜色变量${emb ? "<br/>🖼️ 壁纸已嵌入" : iosPacked ? `<br/>🖼️ 壁纸已打包（slug: <code>${doc.wallpaperSlug}</code>）` : wp ? "<br/>🖼️ 壁纸见附图" : ""}
        `,
        replyTo: msg.id,
      });
      if (wp && !emb && !iosPacked) {
        const ext = detectImageExt(wp) === "png" ? "png" : "jpg";
        await client.sendMedia(msg.chat.id, {
          type: "document",
          file: wp,
          fileName: `theme-chat-background.${ext}`,
          fileMime: ext === "png" ? "image/png" : "image/jpeg",
        } as any, {
          caption: html`🖼️ <b>聊天背景</b>`,
          replyTo: msg.id,
        });
      } else if (wp && iosPacked) {
        // still send image copy for convenience / other clients
        const ext = detectImageExt(wp) === "png" ? "png" : "jpg";
        await client.sendMedia(msg.chat.id, {
          type: "document",
          file: wp,
          fileName: `theme-chat-background.${ext}`,
          fileMime: ext === "png" ? "image/png" : "image/jpeg",
        } as any, {
          caption: html`🖼️ <b>聊天背景原图</b>（已写入 iOS defaultWallpaper）`,
          replyTo: msg.id,
        });
      }
    } catch (e) {
      await msg.edit({ text: html`❌ 转换失败: ${getErrorMessage(e)}` });
    }
  }
}

export default new ThemePlugin();
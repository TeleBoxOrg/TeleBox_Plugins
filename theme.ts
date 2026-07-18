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

// ─── Mapping: Android ↔ Desktop ──────────────────────────────────────────────

const A2D_MAP: Record<string, string> = {
  windowBackgroundWhite: "windowBg",
  windowBackgroundWhiteBlackText: "windowFg",
  windowBackgroundWhiteGrayText: "windowSubTextFg",
  windowBackgroundWhiteGrayText2: "windowSubTextFg",
  windowBackgroundWhiteBlueText4: "activeButtonFg",
  actionBarDefault: "topBarBg",
  actionBarDefaultIcon: "menuIconFg",
  actionBarDefaultTitle: "windowFg",
  actionBarDefaultSubtitle: "windowSubTextFg",
  actionBarDefaultSearchPlaceholder: "placeholderFg",
  chats_menuBackground: "dialogsBg",
  chats_name: "dialogsNameFg",
  chats_message: "dialogsTextFg",
  chats_date: "dialogsDateFg",
  chats_unreadCounter: "dialogsUnreadBg",
  chats_unreadCounterMuted: "dialogsUnreadBgMuted",
  chats_unreadCounterText: "dialogsUnreadFg",
  chats_sentCheck: "dialogsSentIconFg",
  chats_sentCheckRead: "dialogsSentIconFg",
  chats_draft: "dialogsDraftFg",
  chats_menuItemIcon: "menuIconFg",
  chats_menuItemText: "menuIconFg",
  chats_actionBackground: "activeButtonBg",
  chats_actionIcon: "windowFg",
  avatar_text: "windowFg",
  chat_messagePanelBackground: "windowBg",
  chat_messagePanelHint: "placeholderFg",
  chat_messagePanelText: "windowFg",
  chat_messagePanelSend: "historySendIconFg",
  chat_inBubble: "msgInBg",
  chat_inBubbleSelected: "msgInBgSelected",
  chat_inBubbleShadow: "msgInShadow",
  chat_outBubble: "msgOutBg",
  chat_outBubbleSelected: "msgOutBgSelected",
  chat_outBubbleShadow: "msgOutShadow",
  chat_messageTextIn: "windowFg",
  chat_messageTextOut: "windowFg",
  chat_messageLinkIn: "windowFg",
  chat_messageLinkOut: "windowFg",
  chat_inReplyNameText: "windowFg",
  chat_outReplyNameText: "windowFg",
  chat_inReplyMessageText: "windowSubTextFg",
  chat_outReplyMessageText: "windowSubTextFg",
  chat_inReplyLine: "msgInShadow",
  chat_outReplyLine: "msgOutShadow",
  chat_inTimeText: "windowSubTextFg",
  chat_outTimeText: "windowSubTextFg",
  chat_inViews: "windowSubTextFg",
  chat_outViews: "windowSubTextFg",
  chat_selectedBackground: "windowBgRipple",
  chat_status: "windowFg",
  chat_goDownButton: "windowBg",
  chat_goDownButtonIcon: "windowFg",
  chat_inInstant: "activeButtonFg",
  chat_outInstant: "activeButtonFg",
  chat_inAudioSeekbar: "windowSubTextFg",
  chat_inAudioSeekbarFill: "activeButtonFg",
  chat_outAudioSeekbar: "windowSubTextFg",
  chat_outAudioSeekbarFill: "activeButtonFg",
  chat_inVoiceSeekbar: "windowSubTextFg",
  chat_inVoiceSeekbarFill: "activeButtonFg",
  chat_outVoiceSeekbar: "windowSubTextFg",
  chat_outVoiceSeekbarFill: "activeButtonFg",
  chat_emojiPanelBackground: "windowBg",
  chat_emojiPanelIcon: "windowSubTextFg",
  chat_emojiPanelIconSelected: "activeButtonFg",
  chat_emojiPanelBadgeBackground: "activeButtonBg",
  chat_emojiPanelBadgeText: "windowFg",
  profile_tabSelectedText: "activeButtonFg",
  profile_tabSelectedLine: "activeLineFg",
  profile_tabText: "windowSubTextFg",
  profile_actionBackground: "activeButtonBg",
  profile_actionIcon: "windowFg",
  avatar_backgroundActionBarBlue: "topBarBg",
  calls_callReceivedGreenIcon: "activeButtonFg",
  calls_callReceivedRedIcon: "attentionButtonFg",
  inappPlayerBackground: "windowBg",
  inappPlayerPlayPause: "windowFg",
  player_progress: "activeButtonFg",
  player_progressBackground: "windowSubTextFg",
  switchTrack: "windowSubTextFg",
  switchTrackChecked: "activeButtonFg",
  featuredStickers_addButton: "activeButtonFg",
  text_RedRegular: "attentionButtonFg",
  divider: "windowShadowFg",
  listSelectorSDK21: "windowBgRipple",
};
const D2A_MAP: Record<string, string> = {};
for (const [a, d] of Object.entries(A2D_MAP)) D2A_MAP[d] = a;

// ─── Mapping: Android ↔ TGX ─────────────────────────────────────────────────

const A2T_MAP: Record<string, string> = {
  windowBackgroundWhite: "chatListBackground",
  actionBarDefault: "headerBackground",
  actionBarDefaultTitle: "headerTitle",
  actionBarDefaultIcon: "headerIcon",
  profile_tabSelectedLine: "headerTabActive",
  profile_tabSelectedText: "headerTabActive",
  switchTrackChecked: "controlActive",
  actionBarDefaultSearchPlaceholder: "textPlaceholder",
  chats_unreadCounter: "badge",
  chats_unreadCounterMuted: "badgeMuted",
  chats_sentCheck: "ticks",
  chats_sentCheckRead: "ticksRead",
  avatar_text: "avatar_content",
  chat_goDownButton: "circleButtonChat",
  chat_goDownButtonIcon: "circleButtonChatIcon",
  chat_messagePanelBackground: "chatKeyboard",
  chat_inBubble: "bubbleIn_background",
  chat_outBubble: "bubbleOut_background",
  chat_messageTextIn: "bubbleIn_text",
  chat_messageTextOut: "bubbleOut_text",
  chat_messageLinkIn: "bubbleIn_textLink",
  chat_messageLinkOut: "bubbleOut_textLink",
  chat_inReplyLine: "bubbleIn_chatVerticalLine",
  chat_outReplyLine: "bubbleOut_chatVerticalLine",
  chat_inReplyNameText: "bubbleIn_messageAuthor",
  chat_outReplyNameText: "bubbleOut_messageAuthor",
  chat_inTimeText: "bubbleIn_time",
  chat_outTimeText: "bubbleOut_time",
  chat_selectedBackground: "bubble_messageSelection",
  windowBackgroundWhiteBlackText: "headerTitle",
  windowBackgroundWhiteGrayText: "textPlaceholder",
  windowBackgroundWhiteGrayText2: "textPlaceholder",
  chats_message: "chatListIcon",
  chats_name: "headerTitle",
  chats_date: "badgeMuted",
  profile_tabText: "textPlaceholder",
  inappPlayerBackground: "playerButtonActive",
  player_progress: "controlActive",
  switchTrack: "controlActive",
  chat_serviceBackground: "badge",
  chat_serviceText: "badge",
  chat_emojiPanelBackground: "chatKeyboard",
  chat_emojiPanelIcon: "chatKeyboard",
  divider: "separator",
  passcode: "passcode",
  // desktop-specific fallbacks
  windowBg: "chatListBackground",
  windowFg: "headerTitle",
  windowSubTextFg: "textPlaceholder",
  primaryColor: "controlActive",
  topBarBg: "headerBackground",
  msgInBg: "bubbleIn_background",
  msgOutBg: "bubbleOut_background",
  msgInBgSelected: "bubble_messageSelection",
  msgOutBgSelected: "bubble_messageSelection",
  dialogsBg: "chatListBackground",
  dialogsNameFg: "headerTitle",
  dialogsUnreadBg: "badge",
  dialogsUnreadBgMuted: "badgeMuted",
  dialogsUnreadFg: "badge",
  activeButtonBg: "controlActive",
  activeButtonFg: "controlContent",
  historySendIconFg: "controlActive",
  dialogsSentIconFg: "ticks",
  dialogsDraftFg: "badge",
  menuIconFg: "headerIcon",
  placeholderFg: "textPlaceholder",
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
  const f = (ak: string, fb: string) => colors[A2D_MAP[ak] || ak] || colors[ak] || fb;
  const p = toRgb(f("windowBackgroundWhiteBlueText", "#6750a4"));
  const bg = toRgb(f("windowBackgroundWhite", "#1c1b1f"));
  const t = toRgb(f("windowBackgroundWhiteBlackText", "#e6e1e5"));
  const st = toRgb(f("windowBackgroundWhiteGrayText", "#938f96"));
  const mi = colors["msgInBg"] || colors["chat_inBubble"] || "#2b2930";
  const mo = colors["msgOutBg"] || colors["chat_outBubble"] || p;
  const tb = colors["topBarBg"] || colors["actionBarDefault"] || bg;
  const cl = colors["dialogsBg"] || colors["chats_menuBackground"] || bg;
  return [
    "// Telegram Desktop Theme // Generated by TeleBox Theme Converter",
    `primaryColor: ${p}; primaryColorDark: ${adjustBright(p, -30)}; primaryColorTrans: ${p}80;`,
    `primaryDark: ${toRgb(bg)}; secondaryDark: ${adjustBright(bg, 8)}; tertiaryDark: ${adjustBright(bg, 15)};`,
    `quaternaryDark: ${adjustBright(bg, 20)}; primaryText: ${t}; secondaryText: ${adjustBright(t, -10)};`,
    `windowBg: primaryDark; windowFg: primaryText; windowBgOver: tertiaryDark; windowBgRipple: ${p};`,
    `windowSubTextFg: ${st}; windowBoldFg: primaryText; windowBgActive: primaryColor; windowFgActive: #ffffff;`,
    `activeButtonBg: primaryColor; activeButtonBgOver: ${adjustBright(p, 10)}; activeButtonFg: #ffffff;`,
    `activeLineFg: primaryColor; attentionButtonFg: ${colors["text_RedRegular"] || "#f44336"};`,
    `dialogsBg: ${cl}; dialogsNameFg: primaryText; dialogsTextFg: secondaryText;`,
    `dialogsDateFg: secondaryText; dialogsChatIconFg: primaryColor; dialogsTextFgService: primaryColor;`,
    `dialogsDraftFg: ${colors["chats_draft"] || "#f44336"}; dialogsSentIconFg: primaryColor;`,
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
    `emojiPanBg: primaryDark; emojiPanIconFg: secondaryText; emojiPanIconFgActive: primaryColor;`,
    `emojiPanBadgeBg: primaryColor; emojiPanBadgeFg: #ffffff;`,
    `sideBarBg: ${adjustBright(bg, -5)}; sideBarBgActive: primaryColor;`,
    `sideBarTextFg: secondaryText; sideBarTextFgActive: #ffffff; sideBarIconFgActive: #ffffff;`,
    `scrollBarBg: ${p}80; scrollBarBgOver: primaryColor;`,
    `playerBg: primaryDark; playerTitleFg: primaryText; playerProgressFg: primaryColor;`,
    `callsBg: primaryDark; callsNameFg: primaryText;`,
    `callsReceivedFg: ${colors["calls_callReceivedGreenIcon"] || "#4caf50"};`,
    `callsMissedFg: ${colors["calls_callReceivedRedIcon"] || "#f44336"};`,
  ].join("\n");
}

function genAndroid(colors: Record<string, string>): string[] {
  const f = (dk: string, fb: string) => colors[D2A_MAP[dk] || dk] || colors[dk] || fb;
  const p = toRgb(f("primaryColor", "#6750a4"));
  const bg = toRgb(f("windowBg", "#1c1b1f"));
  const t = toRgb(f("windowFg", "#e6e1e5"));
  const st = toRgb(f("windowSubTextFg", "#938f96"));
  const mi = colors["msgInBg"] || "#2b2930";
  const mo = colors["msgOutBg"] || p;
  const tb = colors["topBarBg"] || bg;
  const r: Record<string, string> = {
    windowBackgroundWhite: bg, windowBackgroundWhiteBlackText: t,
    windowBackgroundWhiteGrayText: st, windowBackgroundWhiteGrayText2: st,
    windowBackgroundWhiteBlueText4: p, divider: bg + "3c",
    listSelectorSDK21: p + "1a", actionBarDefault: tb,
    actionBarDefaultIcon: p, actionBarDefaultTitle: t, actionBarDefaultSubtitle: st,
    actionBarDefaultSearch: t, actionBarDefaultSearchPlaceholder: st,
    chats_menuBackground: bg, chats_name: t, chats_message: st, chats_date: st,
    chats_unreadCounter: p, chats_unreadCounterMuted: st, chats_unreadCounterText: "#ffffff",
    chats_sentCheck: p, chats_sentCheckRead: p, chats_draft: "#f44336",
    chats_menuItemIcon: p, chats_menuItemText: t, chats_menuName: t, chats_menuPhone: st,
    chats_actionBackground: p, chats_actionIcon: "#ffffff",
    avatar_text: t,
    avatar_backgroundRed: "#f44336", avatar_backgroundGreen: "#4caf50",
    avatar_backgroundBlue: p, avatar_backgroundOrange: "#ff9800",
    chat_messagePanelBackground: bg, chat_messagePanelHint: st, chat_messagePanelText: t, chat_messagePanelSend: p,
    chat_inBubble: mi, chat_inBubbleSelected: adjustBright(mi, 15), chat_inBubbleShadow: bg,
    chat_outBubble: mo, chat_outBubbleSelected: adjustBright(mo, 15), chat_outBubbleShadow: bg, chat_outBubbleGradient: "00000000",
    chat_messageTextIn: t, chat_messageTextOut: t, chat_messageLinkIn: p, chat_messageLinkOut: p,
    chat_inReplyLine: p, chat_outReplyLine: p, chat_inReplyNameText: p, chat_outReplyNameText: p,
    chat_inReplyMessageText: st, chat_outReplyMessageText: st,
    chat_inTimeText: st, chat_outTimeText: st, chat_inViews: st, chat_outViews: st,
    chat_inSentCheck: p, chat_outSentCheck: p, chat_outSentCheckRead: p,
    chat_outSentClock: st, chat_inSentClock: st, chat_mediaTimeText: st, chat_mediaSentCheck: p, chat_mediaProgress: p,
    chat_selectedBackground: p + "1a", chat_status: p, chat_muteIcon: st,
    chat_goDownButton: bg, chat_goDownButtonIcon: p, chat_goDownButtonCounter: "#ffffff", chat_goDownButtonCounterBackground: p,
    chat_inInstant: p, chat_outInstant: p,
    chat_inAudioSeekbar: st, chat_inAudioSeekbarFill: p, chat_outAudioSeekbar: st, chat_outAudioSeekbarFill: p,
    chat_inVoiceSeekbar: st, chat_inVoiceSeekbarFill: p, chat_outVoiceSeekbar: st, chat_outVoiceSeekbarFill: p,
    chat_emojiPanelBackground: bg, chat_emojiPanelIcon: st, chat_emojiPanelIconSelected: p,
    chat_emojiPanelBadgeBackground: p, chat_emojiPanelBadgeText: "#ffffff",
    chat_serviceBackground: p + "3c", chat_serviceText: "#ffffff", chat_serviceLink: "#ffffff",
    profile_tabSelectedText: p, profile_tabSelectedLine: p, profile_tabText: st,
    profile_actionBackground: p, profile_actionIcon: "#ffffff", avatar_backgroundActionBarBlue: tb,
    calls_callReceivedGreenIcon: "#4caf50", calls_callReceivedRedIcon: "#f44336",
    inappPlayerBackground: bg, inappPlayerPlayPause: t, player_progress: p, player_progressBackground: st,
    switchTrack: st, switchTrackChecked: p, text_RedRegular: "#f44336",
    text_BlueBackground: p + "1a", text_BlueText: p, text_BlueIcon: p, featuredStickers_addButton: p,
  };
  return Object.entries(r).map(([k, v]) => `${k}=${v}`);
}

/** Real TGX format: `!` meta / `@` props / `#` colors (NOT JSON). */
function genTgx(colors: Record<string, string>, name = "TeleBox Theme"): string {
  const bg = pickColor(colors, ["windowBackgroundWhite", "filling", "background", "windowBg", "chatListBackground"], "#1C2733");
  const t = pickColor(colors, ["windowBackgroundWhiteBlackText", "text", "windowFg"], "#E6E1E5");
  const p = pickColor(colors, ["windowBackgroundWhiteBlueText", "textLink", "progress", "iconActive", "windowBackgroundWhiteBlueText4"], "#6750A4");
  const st = pickColor(colors, ["windowBackgroundWhiteGrayText", "textLight", "icon", "windowSubTextFg"], "#7D8E98");
  const mi = pickColor(colors, ["chat_inBubble", "bubbleIn_background", "msgInBg"], "#2B2930");
  const mo = pickColor(colors, ["chat_outBubble", "bubbleOut_background", "msgOutBg"], p);
  const tb = pickColor(colors, ["actionBarDefault", "headerBackground", "topBarBg"], bg);
  const sep = pickColor(colors, ["divider", "separator"], adjustBright(bg, 15));
  const dark = isDarkHex(bg) ? 1 : 0;
  const c = (hex: string) => toTgxColor(hex);
  // Group identical colors on one line (official TGX export style)
  const colorGroups: Record<string, string[]> = {};
  const add = (key: string, hex: string) => {
    const v = c(hex);
    if (!colorGroups[v]) colorGroups[v] = [];
    colorGroups[v].push(key);
  };
  add("filling", bg);
  add("background", bg);
  add("overlayFilling", bg);
  add("chatBackground", bg);
  add("chatKeyboard", bg);
  add("passcode", bg);
  add("headerBackground", tb);
  add("headerLightBackground", tb);
  add("text", t);
  add("background_text", t);
  add("headerTitle", t);
  add("icon", st);
  add("textLight", st);
  add("textPlaceholder", st);
  add("background_icon", st);
  add("bubbleIn_time", st);
  add("separator", sep);
  add("bubbleIn_background", mi);
  add("bubbleOut_background", mo);
  add("bubbleIn_text", t);
  add("bubbleOut_text", t);
  add("bubbleIn_textLink", p);
  add("bubbleOut_textLink", p);
  add("bubbleIn_messageAuthor", p);
  add("bubbleOut_messageAuthor", p);
  add("bubbleIn_chatVerticalLine", p);
  add("bubbleOut_chatVerticalLine", p);
  add("bubbleIn_waveformActive", p);
  add("bubbleOut_waveformActive", p);
  add("bubbleIn_waveformInactive", st);
  add("bubbleOut_waveformInactive", st);
  add("ticks", p);
  add("ticksRead", p);
  add("badge", p);
  add("progress", p);
  add("textLink", p);
  add("iconActive", p);
  add("controlActive", p);
  add("circleButtonRegular", p);
  add("circleButtonTheme", p);
  add("circleButtonActive", adjustBright(p, -15));
  add("circleButtonChat", bg);
  add("circleButtonChatIcon", p);
  add("unread", p);
  add("playerProgress", p);
  add("playerBackground", bg);
  add("playerTitle", t);
  add("attachPhoto", bg);
  add("attachFile", bg);
  add("attachContact", bg);
  add("attachLocation", bg);
  add("attachInlineBot", bg);

  const lines: string[] = [
    "!",
    `id: ${Math.floor(Date.now() / 1000) % 100000}`,
    `name: ${JSON.stringify(name)}`,
    `time: ${Math.floor(Date.now() / 1000)}`,
    "@",
    `dark: ${dark}`,
    `parentTheme: ${dark ? 1 : 0}`,
    "shadowDepth: 1",
    "wallpaperUsageId: 1",
    "bubbleCorner: 18",
    "bubbleCornerMerged: 6",
    "bubbleDateCorner: 13",
    "dateCorner: 13",
    "bubbleOuterMargin: 8",
    "#",
  ];
  for (const [hex, keys] of Object.entries(colorGroups)) {
    lines.push(`${keys.join(", ")}: ${hex}`);
  }
  return lines.join("\n") + "\n";
}

/** Real iOS .tgios-theme: nested camelCase `key: value` (NOT JSON). */
function genIos(colors: Record<string, string>, name = "TeleBox Theme"): string {
  const bg = pickColor(colors, ["windowBackgroundWhite", "backgroundColor", "windowBg", "list.plainBg"], "#1c1b1f");
  const t = pickColor(colors, ["windowBackgroundWhiteBlackText", "primaryText", "windowFg", "list.primaryText"], "#e6e1e5");
  const p = pickColor(colors, ["windowBackgroundWhiteBlueText", "accentColor", "list.accent", "windowBackgroundWhiteBlueText4"], "#6750a4");
  const st = pickColor(colors, ["windowBackgroundWhiteGrayText", "secondaryText", "list.secondaryText"], "#938f96");
  const mi = pickColor(colors, ["chat_inBubble", "chatIncomingBubble", "msgInBg"], "#2b2930");
  const mo = pickColor(colors, ["chat_outBubble", "chatOutgoingBubble", "msgOutBg"], p);
  const tb = pickColor(colors, ["actionBarDefault", "navigationBarBackground", "topBarBg", "root.navBar.background"], bg);
  const sep = pickColor(colors, ["divider", "separatorColor", "list.blocksSeparator"], adjustBright(bg, 15));
  const dark = isDarkHex(bg);
  const ic = (hex: string) => toIosColor(hex);
  const white = "ffffff";
  const black = "000000";
  const destructive = "ff3b30";
  const outText = isDarkHex(mo) ? white : black;

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
    `  defaultWallpaper: ${ic(bg)}`,
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
  return lines.join("\n") + "\n";
}

/** Build ThemeDoc colors from cloud themeSettings (accent-only themes). */
function colorsFromThemeSettings(settings: any): Record<string, string> {
  const colors: Record<string, string> = {};
  if (!settings || typeof settings !== "object") return colors;
  const accent = settings.accentColor != null
    ? parseColor(String(settings.accentColor)) || (() => {
        const n = Number(settings.accentColor) >>> 0;
        return toHex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
      })()
    : null;
  const outAccent = settings.outboxAccentColor != null
    ? parseColor(String(settings.outboxAccentColor)) || (() => {
        const n = Number(settings.outboxAccentColor) >>> 0;
        return toHex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
      })()
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
  assign(["windowBackgroundWhiteBlueText", "windowBackgroundWhiteBlueText4", "textLink", "progress", "accentColor"], p);
  assign(["actionBarDefault", "topBarBg", "headerBackground", "navigationBarBackground"], dark ? "#1a1a1a" : p);
  assign(["chat_inBubble", "bubbleIn_background", "msgInBg", "chatIncomingBubble"], dark ? "#1e1e1e" : "#f1f1f4");
  assign(["chat_outBubble", "bubbleOut_background", "msgOutBg", "chatOutgoingBubble"], out);
  assign(["chats_unreadCounter", "badge", "unread"], p);
  assign(["divider", "separator"], dark ? "#2a2a2a" : "#c8c7cc");
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
      let section = "";
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("//")) continue;
        if (line === "!" || line === "@" || line === "#") { section = line; continue; }
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
      if (Object.keys(colors).length) return { format: "tgx-theme", colors };
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
          stack[level] = key;
          stack.length = level + 1;
          continue;
        }
        // color value: RRGGBB / AARRGGBB / #hex
        if (val.startsWith("#")) val = val.slice(1);
        if (!/^[0-9a-fA-F]{6,8}$/.test(val)) continue;
        const path = [...stack.slice(0, level), key].filter(Boolean).join(".");
        const hex = val.length === 8
          ? `#${val}` // AARRGGBB
          : `#${val}`;
        colors[path] = hex.startsWith("#") ? (hex.length === 7 || hex.length === 9 ? hex : `#${val}`) : `#${val}`;
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
      if (Object.keys(colors).length) return { format: "ios-theme", colors };
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
    const withWp: ThemeDoc = { ...doc, wallpaper: wp, wallpaperTiled: tiled };

    if (target === "attheme") {
      // Always re-render colors + re-attach wallpaper so conversions keep chat background
      const text = genAndroid(withWp.colors).join("\n") + "\n";
      return attachAtthemeWallpaper(text, wp);
    }
    if (target === "tdesktop-theme") {
      return buildDesktopTheme(genDesktop(withWp.colors), wp, tiled);
    }
    if (target === "tgx-theme") {
      // TGX file format has no embedded image; keep wallpaper on ThemeDoc for sidecar send
      return Buffer.from(genTgx(withWp.colors, name), "utf-8");
    }
    if (target === "ios-theme") {
      return Buffer.from(genIos(withWp.colors, name), "utf-8");
    }
    return null;
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
      const doc = parser(buf);
      if (!doc || !Object.keys(doc.colors).length) {
        await msg.edit({ text: html`❌ 解析失败，未找到颜色变量` });
        return;
      }

      const cc = Object.keys(doc.colors).length;
      const hasWp = !!(normalizeWallpaper(doc.wallpaper || null));
      const targets = (["attheme", "tdesktop-theme", "tgx-theme", "ios-theme"] as ThemeFormat[]).filter(f => f !== format) as ThemeFormat[];

      // convert to all targets (wallpaper preserved via renderDoc)
      const converted: { target: ThemeFormat; result: Buffer | null }[] = targets.map(t => ({
        target: t,
        result: renderDoc(doc, t),
      }));

      const count = converted.filter(c => c.result).length;

      await msg.edit({
        text: html`
✅ <b>已识别</b> ${FORMAT_LABELS[format]}
📊 ${cc} 个颜色变量${hasWp ? "<br/>🖼️ 聊天背景已提取" : ""}

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
        const emb = hasWp && (c.target === "attheme" || c.target === "tdesktop-theme");
        await client.sendMedia(msg.chat.id, {
          type: "document",
          file: c.result,
          fileName: `theme${FORMAT_EXT[c.target]}`,
          fileMime: API_MIME[c.target],
        } as any, {
          caption: html`
✅ <b>${FORMAT_LABELS[format]}</b> → <b>${FORMAT_LABELS[c.target]}</b>
📊 ${cc} 个颜色变量${emb ? "<br/>🖼️ 壁纸已嵌入" : hasWp ? "<br/>🖼️ 壁纸见附图" : ""}
          `,
          replyTo: msg.id,
        });
      }

      // Sidecar wallpaper for TGX/iOS (and any path that cannot embed)
      const wp = normalizeWallpaper(doc.wallpaper || null);
      if (wp) {
        const ext = detectImageExt(wp) === "png" ? "png" : "jpg";
        await client.sendMedia(msg.chat.id, {
          type: "document",
          file: wp,
          fileName: `theme-chat-background.${ext}`,
          fileMime: ext === "png" ? "image/png" : "image/jpeg",
        } as any, {
          caption: html`🖼️ <b>聊天背景</b>（Android/Desktop 已嵌入主题；TGX/iOS 请手动设为聊天背景）`,
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
  private async downloadTlDocument(
    client: Awaited<ReturnType<typeof getGlobalClient>>,
    doc: any,
  ): Promise<Buffer | null> {
    if (!doc || doc._ !== "document") return null;
    try {
      const inputLoc = {
        _: "inputDocumentFileLocation" as const,
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference || new Uint8Array(0),
        thumbSize: "",
      };
      const fileSize = doc.size != null ? Number(doc.size) : undefined;
      // Prefer real FileLocation class so dcId is honored
      let raw: any;
      try {
        raw = await client.downloadAsBuffer(
          new FileLocation(inputLoc, fileSize, doc.dcId) as any,
        );
      } catch {
        try {
          raw = await client.downloadAsBuffer(inputLoc as any);
        } catch {
          // last resort: plain shape with dcId
          raw = await client.downloadAsBuffer({
            location: inputLoc,
            fileSize,
            dcId: doc.dcId,
          } as any);
        }
      }
      if (!raw) return null;
      return Buffer.from(raw as any);
    } catch (e) {
      logger.warn("[theme] downloadTlDocument failed:", getErrorMessage(e));
      return null;
    }
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
  ): Promise<Buffer | null> {
    try {
      const wp = settings?.wallpaper;
      if (!wp) return null;
      // wallPaper { document } | wallPaperNoFile
      if (wp._ === "wallPaper" && wp.document?._ === "document") {
        return await this.downloadTlDocument(client, wp.document);
      }
      if (wp.document?._ === "document") {
        return await this.downloadTlDocument(client, wp.document);
      }
      return null;
    } catch (e) {
      logger.warn("[theme] wallpaper download failed:", getErrorMessage(e));
      return null;
    }
  }

  /** If only settings exist, synthesize all client formats from accent colors (+ wallpaper) */
  private synthesizeFromSettings(
    settings: any,
    title: string,
    wallpaper?: Buffer | null,
  ): Record<string, { format: ThemeFormat; buf: Buffer }> | null {
    const colors = colorsFromThemeSettings(settings);
    if (!Object.keys(colors).length) return null;
    const doc: ThemeDoc = {
      format: "attheme",
      colors,
      wallpaper: normalizeWallpaper(wallpaper || null),
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

      // ── Strategy 1: account.getTheme for each client format ──────────
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
            fmtMap[f] = { format, buf };
          }
        } catch (e) {
          errors.push(`getTheme(${f}): ${getErrorMessage(e)}`);
        }
      }

      if (Object.keys(fmtMap).length > 0) {
        await this.sendThemeResults(msg, themeTitle, slug, fmtMap);
        return;
      }

      // ── Strategy 2: messages.getWebPage / getWebPagePreview ──────────
      await msg.edit({ text: html`⏳ 尝试从网页获取主题文件...` });
      const url = `https://t.me/addtheme/${slug}`;
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
          if (typeof (client as any).getWebPagePreview === "function") {
            const media: any = await (client as any).getWebPagePreview(url);
            if (media?.type === "webpage" && media.preview?.raw) {
              webPage = media.preview.raw;
            } else if (media?.raw?.webpage?._ === "webPage") {
              webPage = media.raw.webpage;
            }
          }
        } catch (e) {
          errors.push(`getWebPagePreview(hl): ${getErrorMessage(e)}`);
        }
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
      if (!settingsFallback && webPage) settingsFallback = this.collectThemeSettings(webPage);

      // Collect documents from webPageAttributeTheme + top-level document
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

      if (Object.keys(fmtMap).length > 0) {
        await this.sendThemeResults(msg, themeTitle, slug, fmtMap);
        return;
      }

      // ── Strategy 3: synthesize from themeSettings (cloud accent themes) ──
      // Many installable themes only ship settings (no document). Clients still
      // install them; we generate .attheme / .tdesktop-theme / .tgx-theme / .tgios-theme.
      if (settingsFallback) {
        const cloudWp = await this.downloadWallpaperFromSettings(client, settingsFallback);
        const synth = this.synthesizeFromSettings(settingsFallback, themeTitle, cloudWp);
        if (synth) {
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

    let bestDoc: ThemeDoc | null = null;
    let bestFmt: ThemeFormat | null = null;
    let bestCount = 0;
    for (const [fmt, buf] of byFormat) {
      const parser = fmt === "attheme" ? parseAttheme : fmt === "tdesktop-theme" ? parseDesktop : fmt === "tgx-theme" ? parseTgx : parseIos;
      const doc = parser(buf);
      if (!doc) continue;
      const cc = Object.keys(doc.colors).length;
      if (cc > bestCount) {
        bestDoc = doc;
        bestFmt = fmt;
        bestCount = cc;
      }
    }

    // Merge wallpaper from richest source + any extras (cloud settings / stashed)
    let wallpaper = normalizeWallpaper(bestDoc?.wallpaper || null)
      || normalizeWallpaper(extraWallpaper || null)
      || normalizeWallpaper((fmtMap as any).__wallpaper || null);
    // Prefer wallpaper embedded in any original buffer (e.g. attheme/desktop)
    if (!wallpaper) {
      for (const [fmt, buf] of byFormat) {
        const parser = fmt === "attheme" ? parseAttheme : fmt === "tdesktop-theme" ? parseDesktop : null;
        if (!parser) continue;
        const d = parser(buf);
        const w = normalizeWallpaper(d?.wallpaper || null);
        if (w) { wallpaper = w; break; }
      }
    }
    if (bestDoc) {
      bestDoc = { ...bestDoc, wallpaper };
    }

    // If originals failed parse but we have buffers that are already rendered, still send them
    if (!bestDoc || !bestFmt) {
      for (const [fmt, buf] of byFormat) {
        const det = detectFmt(buf);
        if (!det) continue;
        const parser = det === "attheme" ? parseAttheme : det === "tdesktop-theme" ? parseDesktop : det === "tgx-theme" ? parseTgx : parseIos;
        const doc = parser(buf);
        if (doc && Object.keys(doc.colors).length > bestCount) {
          bestDoc = { ...doc, wallpaper: normalizeWallpaper(doc.wallpaper) || wallpaper };
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

    // Ensure conversions re-embed wallpaper even when using "original" buffer that lacks it
    const ensureWallpaper = (target: ThemeFormat, buf: Buffer): Buffer => {
      if (!wallpaper) return buf;
      if (target === "attheme") {
        const parsed = parseAttheme(buf);
        if (parsed && !normalizeWallpaper(parsed.wallpaper)) {
          return renderDoc({ ...bestDoc!, wallpaper }, "attheme", title) || buf;
        }
      }
      if (target === "tdesktop-theme") {
        if (isZip(buf)) {
          const parsed = parseDesktop(buf);
          if (parsed && !normalizeWallpaper(parsed.wallpaper)) {
            return renderDoc({ ...bestDoc!, wallpaper }, "tdesktop-theme", title) || buf;
          }
        } else {
          // plain palette without zip — rebuild package with wallpaper
          return renderDoc({ ...bestDoc!, wallpaper }, "tdesktop-theme", title) || buf;
        }
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
        fromLabel = synthesized ? "设置合成" : "原始";
      } else {
        out = renderDoc(bestDoc, target, title);
        fromLabel = FORMAT_LABELS[bestFmt];
      }
      if (!out) continue;
      const hasWp = !!(wallpaper && (target === "attheme" || target === "tdesktop-theme"));
      await client.sendMedia(msg.chat.id, {
        type: "document",
        file: out,
        fileName: `${slug || "theme"}${FORMAT_EXT[target]}`,
        fileMime: API_MIME[target],
      } as any, {
        caption: html`✅ <b>${FORMAT_LABELS[target]}</b>${fromLabel !== "原始" && fromLabel !== "设置合成" ? ` ← ${fromLabel}` : fromLabel === "设置合成" ? "（从云端颜色设置生成）" : "（原始）"} 📊 ${bestCount} 色${hasWp ? " · 🖼️ 壁纸已嵌入" : ""}`,
        replyTo: msg.id,
      });
      sent.push(FORMAT_LABELS[target]);
    }

    // TGX/iOS 文件本身不嵌壁纸：附带聊天背景图供手动设置
    if (wallpaper && !wpSidecarSent) {
      const ext = detectImageExt(wallpaper) === "png" ? "png" : "jpg";
      await client.sendMedia(msg.chat.id, {
        type: "document",
        file: wallpaper,
        fileName: `${slug || "theme"}-chat-background.${ext}`,
        fileMime: ext === "png" ? "image/png" : "image/jpeg",
      } as any, {
        caption: html`🖼️ <b>聊天背景</b>（TGX/iOS 主题文件不含嵌入壁纸，请在客户端「聊天背景」中手动设置此图）`,
        replyTo: msg.id,
      });
      wpSidecarSent = true;
    }

    await msg.edit({
      text: html`
🎨 <b>${title}</b>
🔗 <code>t.me/addtheme/${slug}</code>
📊 源: ${synthesized ? "云端颜色设置" : `${FORMAT_LABELS[bestFmt]}（${bestCount} 色）`}
${wallpaper ? "<br/>🖼️ 聊天背景已保留（Android/Desktop 已嵌入；TGX/iOS 见附图）" : ""}
<br/>✅ 已输出: ${sent.join(" · ") || "无"}
<br/><i>TGX/iOS 请点文件安装（.tgx-theme / .tgios-theme）</i>
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
      const doc = parsers[format](buf);
      if (!doc || !Object.keys(doc.colors).length) { await msg.edit({ text: html`❌ 解析失败` }); return; }
      const out = renderDoc(doc, target);
      if (!out) { await msg.edit({ text: html`❌ 转换失败` }); return; }
      const cc = Object.keys(doc.colors).length;
      const wp = normalizeWallpaper(doc.wallpaper || null);
      const emb = !!(wp && (target === "attheme" || target === "tdesktop-theme"));
      await msg.delete();
      await client.sendMedia(msg.chat.id, {
        type: "document",
        file: out,
        fileName: `theme${FORMAT_EXT[target]}`,
        fileMime: API_MIME[target],
      } as any, {
        caption: html`
✅ <b>转换完成</b> ${TARGET_CLIENT_LABELS[target]}
📊 ${cc} 个颜色变量${emb ? "<br/>🖼️ 壁纸已嵌入" : wp ? "<br/>🖼️ 壁纸见附图" : ""}
        `,
        replyTo: msg.id,
      });
      if (wp && !emb) {
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
      }
    } catch (e) {
      await msg.edit({ text: html`❌ 转换失败: ${getErrorMessage(e)}` });
    }
  }
}

export default new ThemePlugin();
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
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
const ASSETS_DIR = path.join(process.cwd(), "assets", "theme-converter");

if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

// ─── Types ───────────────────────────────────────────────────────────────────

type ThemeFormat = "attheme" | "tdesktop-theme" | "tgx-theme";

/** Telegram API format string */
const API_FORMATS: Record<ThemeFormat, string> = {
  attheme: "android",
  "tdesktop-theme": "tdesktop",
  "tgx-theme": "macos",
};

const API_MIME: Record<ThemeFormat, string> = {
  attheme: "application/x-tgtheme-android",
  "tdesktop-theme": "application/x-tgtheme-tdesktop",
  "tgx-theme": "application/x-tgtheme-macos",
};

interface ThemeDoc {
  format: ThemeFormat;
  colors: Record<string, string>;
  wallpaper?: any;
  slug?: string;
  title?: string;
  document?: { id: bigint; accessHash: bigint };
}

interface PendingState {
  chatId: number;
  msgId: number;
  format: ThemeFormat;
  buf: number[];
  createdAt: number;
}

interface PendingCloud {
  chatId: number;
  msgId: number;
  format: string;
  colors: Record<string, string>;
  slug: string;
  title: string;
  createdAt: number;
}

const FORMAT_LABELS: Record<ThemeFormat, string> = {
  attheme: "Android (.attheme)",
  "tdesktop-theme": "Desktop (.tdesktop-theme)",
  "tgx-theme": "Telegram X (.tgx-theme)",
};

const FORMAT_EXT: Record<ThemeFormat, string> = {
  attheme: ".attheme",
  "tdesktop-theme": ".tdesktop-theme",
  "tgx-theme": ".json",
};

const FORMAT_EMOJI: Record<ThemeFormat, string> = {
  attheme: "📱 Android",
  "tdesktop-theme": "💻 Desktop",
  "tgx-theme": "📲 TGX",
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

// ─── Mapping ─────────────────────────────────────────────────────────────────

const M: [string, string][] = [
  ["windowBackgroundWhite", "windowBg"],
  ["windowBackgroundWhiteBlackText", "windowFg"],
  ["windowBackgroundWhiteGrayText", "windowSubTextFg"],
  ["windowBackgroundWhiteGrayText2", "windowSubTextFg"],
  ["windowBackgroundWhiteBlueText4", "activeButtonFg"],
  ["actionBarDefault", "topBarBg"],
  ["actionBarDefaultIcon", "menuIconFg"],
  ["actionBarDefaultTitle", "windowFg"],
  ["actionBarDefaultSubtitle", "windowSubTextFg"],
  ["actionBarDefaultSearchPlaceholder", "placeholderFg"],
  ["chats_menuBackground", "dialogsBg"],
  ["chats_name", "dialogsNameFg"],
  ["chats_message", "dialogsTextFg"],
  ["chats_date", "dialogsDateFg"],
  ["chats_unreadCounter", "dialogsUnreadBg"],
  ["chats_unreadCounterMuted", "dialogsUnreadBgMuted"],
  ["chats_unreadCounterText", "dialogsUnreadFg"],
  ["chats_sentCheck", "dialogsSentIconFg"],
  ["chats_sentCheckRead", "dialogsSentIconFg"],
  ["chats_draft", "dialogsDraftFg"],
  ["chats_menuItemIcon", "menuIconFg"],
  ["chats_menuItemText", "menuIconFg"],
  ["chats_actionBackground", "activeButtonBg"],
  ["chats_actionIcon", "windowFg"],
  ["avatar_text", "windowFg"],
  ["chat_messagePanelBackground", "windowBg"],
  ["chat_messagePanelHint", "placeholderFg"],
  ["chat_messagePanelText", "windowFg"],
  ["chat_messagePanelSend", "historySendIconFg"],
  ["chat_inBubble", "msgInBg"],
  ["chat_inBubbleSelected", "msgInBgSelected"],
  ["chat_inBubbleShadow", "msgInShadow"],
  ["chat_outBubble", "msgOutBg"],
  ["chat_outBubbleSelected", "msgOutBgSelected"],
  ["chat_outBubbleShadow", "msgOutShadow"],
  ["chat_messageTextIn", "windowFg"],
  ["chat_messageTextOut", "windowFg"],
  ["chat_messageLinkIn", "windowFg"],
  ["chat_messageLinkOut", "windowFg"],
  ["chat_inReplyNameText", "windowFg"],
  ["chat_outReplyNameText", "windowFg"],
  ["chat_inReplyMessageText", "windowSubTextFg"],
  ["chat_outReplyMessageText", "windowSubTextFg"],
  ["chat_inReplyLine", "msgInShadow"],
  ["chat_outReplyLine", "msgOutShadow"],
  ["chat_inTimeText", "windowSubTextFg"],
  ["chat_outTimeText", "windowSubTextFg"],
  ["chat_inViews", "windowSubTextFg"],
  ["chat_outViews", "windowSubTextFg"],
  ["chat_selectedBackground", "windowBgRipple"],
  ["chat_status", "windowFg"],
  ["chat_goDownButton", "windowBg"],
  ["chat_goDownButtonIcon", "windowFg"],
  ["chat_inInstant", "activeButtonFg"],
  ["chat_outInstant", "activeButtonFg"],
  ["chat_inAudioSeekbar", "windowSubTextFg"],
  ["chat_inAudioSeekbarFill", "activeButtonFg"],
  ["chat_outAudioSeekbar", "windowSubTextFg"],
  ["chat_outAudioSeekbarFill", "activeButtonFg"],
  ["chat_inVoiceSeekbar", "windowSubTextFg"],
  ["chat_inVoiceSeekbarFill", "activeButtonFg"],
  ["chat_outVoiceSeekbar", "windowSubTextFg"],
  ["chat_outVoiceSeekbarFill", "activeButtonFg"],
  ["chat_emojiPanelBackground", "windowBg"],
  ["chat_emojiPanelIcon", "windowSubTextFg"],
  ["chat_emojiPanelIconSelected", "activeButtonFg"],
  ["chat_emojiPanelBadgeBackground", "activeButtonBg"],
  ["chat_emojiPanelBadgeText", "windowFg"],
  ["profile_tabSelectedText", "activeButtonFg"],
  ["profile_tabSelectedLine", "activeLineFg"],
  ["profile_tabText", "windowSubTextFg"],
  ["profile_actionBackground", "activeButtonBg"],
  ["profile_actionIcon", "windowFg"],
  ["avatar_backgroundActionBarBlue", "topBarBg"],
  ["calls_callReceivedGreenIcon", "activeButtonFg"],
  ["calls_callReceivedRedIcon", "attentionButtonFg"],
  ["inappPlayerBackground", "windowBg"],
  ["inappPlayerPlayPause", "windowFg"],
  ["player_progress", "activeButtonFg"],
  ["player_progressBackground", "windowSubTextFg"],
  ["switchTrack", "windowSubTextFg"],
  ["switchTrackChecked", "activeButtonFg"],
  ["featuredStickers_addButton", "activeButtonFg"],
  ["text_RedRegular", "attentionButtonFg"],
  ["divider", "windowShadowFg"],
  ["listSelectorSDK21", "windowBgRipple"],
];

const a2d = new Map(M);
const d2a = new Map(M.map(([a, d]) => [d, a]));

// ─── Generators ──────────────────────────────────────────────────────────────

function genDesktop(colors: Record<string, string>): string {
  const f = (ak: string, fb: string) => {
    const dk = a2d.get(ak);
    return (dk && colors[dk]) || colors[ak] || fb;
  };
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
  const f = (dk: string, fb: string) => {
    const ak = d2a.get(dk);
    return (ak && colors[ak]) || colors[dk] || fb;
  };
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

function genTgx(colors: Record<string, string>): string {
  const m: Record<string, string> = {
    bubbleIn_background: colors["msgInBg"] || "#2b2930",
    bubbleOut_background: colors["msgOutBg"] || colors["primaryColor"] || "#6750a4",
    bubbleIn_text: colors["windowFg"] || "#e6e1e5",
    bubbleOut_text: colors["windowFg"] || "#e6e1e5",
    bubbleIn_textLink: colors["primaryColor"] || "#6750a4",
    bubbleOut_textLink: colors["primaryColor"] || "#6750a4",
    bubbleIn_time: colors["windowSubTextFg"] || "#938f96",
    bubbleOut_time: colors["windowSubTextFg"] || "#938f96",
    bubbleIn_chatVerticalLine: colors["primaryColor"] || "#6750a4",
    bubbleOut_chatVerticalLine: colors["primaryColor"] || "#6750a4",
    bubbleIn_messageAuthor: colors["primaryColor"] || "#6750a4",
    bubbleOut_messageAuthor: colors["primaryColor"] || "#6750a4",
    bubble_messageSelection: "#6750a41a",
    chatListBackground: colors["windowBg"] || "#1c1b1f",
    headerBackground: colors["topBarBg"] || "#1c1b1f",
    headerTitle: colors["windowFg"] || "#e6e1e5",
    headerIcon: colors["primaryColor"] || "#6750a4",
    headerTabActive: colors["primaryColor"] || "#6750a4",
    controlActive: colors["primaryColor"] || "#6750a4", controlContent: "#ffffff",
    textPlaceholder: colors["windowSubTextFg"] || "#938f96",
    badge: colors["primaryColor"] || "#6750a4", badgeMuted: colors["windowSubTextFg"] || "#938f96",
    ticks: colors["primaryColor"] || "#6750a4", ticksRead: colors["primaryColor"] || "#6750a4",
    avatar_content: colors["windowFg"] || "#e6e1e5",
    circleButtonRegular: colors["primaryColor"] || "#6750a4", circleButtonRegularIcon: "#ffffff",
    circleButtonChat: colors["windowBg"] || "#1c1b1f", circleButtonChatIcon: colors["primaryColor"] || "#6750a4",
    chatKeyboard: colors["windowBg"] || "#1c1b1f",
    passcode: colors["windowBg"] || "#1c1b1f", passcodeText: colors["windowFg"] || "#e6e1e5", passcodeIcon: colors["primaryColor"] || "#6750a4",
    themeColor: colors["primaryColor"] || "#6750a4",
  };
  return JSON.stringify(m, null, 2);
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseAttheme(buf: Buffer): ThemeDoc | null {
  try {
    const colors: Record<string, string> = {};
    const wps = Buffer.from("WPS\n");
    const wpe = Buffer.from("\nWPE\n");
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
      const wpeIdx = buf.indexOf(wpe, imgStart);
      wallpaper = buf.subarray(imgStart, wpeIdx !== -1 ? wpeIdx : buf.length);
    }
    return { format: "attheme", colors, wallpaper };
  } catch { return null; }
}

function parseDesktop(buf: Buffer): ThemeDoc | null {
  try {
    const raw: Record<string, string> = {};
    for (const line of buf.toString("utf-8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("//")) continue;
      const semi = s.indexOf(";");
      const c = semi !== -1 ? s.slice(0, semi) : s;
      const col = c.indexOf(":");
      if (col <= 0) continue;
      const k = c.slice(0, col).trim();
      const v = c.slice(col + 1).trim();
      if (k && v) raw[k] = v;
    }
    const colors: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) colors[k] = v.startsWith("#") ? v : (raw[v] || v);
    return { format: "tdesktop-theme", colors };
  } catch { return null; }
}

function parseTgx(buf: Buffer): ThemeDoc | null {
  try {
    const colors: Record<string, string> = {};
    for (const [k, v] of Object.entries(JSON.parse(buf.toString("utf-8")))) {
      if (typeof v === "string" && v.startsWith("#")) colors[k] = v;
    }
    return { format: "tgx-theme", colors };
  } catch { return null; }
}

function detectFmt(buf: Buffer): ThemeFormat | null {
  const t = buf.toString("utf-8").trim();
  if (t[0] === "{" || t[0] === "[") { try { JSON.parse(t); return "tgx-theme"; } catch { /* */ } }
  if (t.split("\n").some((l: string) => (l.includes("=") && !l.trim().startsWith("//")) || l.includes("WPS"))) return "attheme";
  if (t.split("\n").some((l: string) => l.includes(":") && l.includes(";"))) return "tdesktop-theme";
  return null;
}

function renderDoc(doc: ThemeDoc, target: ThemeFormat): Buffer | null {
  try {
    if (doc.format === "attheme" && target === "tdesktop-theme") {
      const buf = Buffer.from(genDesktop(doc.colors), "utf-8");
      if (doc.wallpaper && doc.wallpaper.length > 10) return Buffer.concat([buf, Buffer.from("\n\n"), doc.wallpaper] as any);
      return buf;
    }
    if (target === "attheme" && (doc.format === "tdesktop-theme" || doc.format === "tgx-theme")) {
      const text = genAndroid(doc.colors).join("\n") + "\n";
      const parts: any[] = [Buffer.from(text, "utf-8")];
      if (doc.wallpaper && doc.wallpaper.length > 10) {
        parts.push(Buffer.from("WPS\n"), doc.wallpaper);
        if (!Buffer.from(doc.wallpaper).slice(-5).equals(Buffer.from("\nWPE\n"))) parts.push(Buffer.from("\nWPE\n"));
      }
      return Buffer.concat(parts);
    }
    if (target === "tgx-theme") return Buffer.from(genTgx(doc.colors), "utf-8");
    if (doc.format === "tgx-theme" && target === "tdesktop-theme") return Buffer.from(genDesktop(doc.colors), "utf-8");
    return null;
  } catch { return null; }
}

// ─── State management ────────────────────────────────────────────────────────

function savePending(state: PendingState | PendingCloud): void {
  try {
    for (const f of fs.readdirSync(ASSETS_DIR)) {
      if (f.startsWith(`pending_${state.chatId}_`)) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, f), "utf-8"));
          if (d.chatId === state.chatId && Date.now() - d.createdAt > 60000) fs.unlinkSync(path.join(ASSETS_DIR, f));
        } catch { fs.unlinkSync(path.join(ASSETS_DIR, f)); }
      }
    }
  } catch { /* */ }
  fs.writeFileSync(path.join(ASSETS_DIR, `pending_${state.chatId}_${state.msgId}.json`), JSON.stringify(state));
}

function loadPending(chatId: number, replyMsgId: number): PendingState | PendingCloud | null {
  try {
    const p = path.join(ASSETS_DIR, `pending_${chatId}_${replyMsgId}.json`);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (Date.now() - data.createdAt > 60000) { fs.unlinkSync(p); return null; }
    return data;
  } catch { return null; }
}

function cleanupPending(chatId: number, msgId: number): void {
  try { fs.unlinkSync(path.join(ASSETS_DIR, `pending_${chatId}_${msgId}.json`)); } catch { /* */ }
}

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

// ─── Plugin ──────────────────────────────────────────────────────────────────

class ThemeConverterPlugin extends Plugin {
  description =
    `🎨 <b>Telegram 主题转换器</b>\n\n` +
    `<b>支持格式互转：</b>\n` +
    `Android (.attheme) ↔ Desktop (.tdesktop-theme) ↔ Telegram X\n\n` +
    `<b>使用方法：</b>\n` +
    `• 发送主题文件，自动识别后回复序号选择目标格式\n` +
    `• 发送 <code>t.me/addtheme/SLUG</code> 链接，自动获取云端主题\n` +
    `• <code>${mainPrefix}theme</code> - 显示帮助\n` +
    `• <code>${mainPrefix}theme atd</code> - 回复文件: → Desktop\n` +
    `• <code>${mainPrefix}theme dta</code> - 回复文件: → Android\n` +
    `• <code>${mainPrefix}theme cloud</code> - 回复文件: 上传为云端主题\n\n` +
    `<b>云端主题（Cloud Theme）：</b>\n` +
    `转换后可上传到 Telegram 云端，生成 <code>t.me/addtheme</code> 链接\n` +
    `对方点击链接即可直接应用主题`;

  cmdHandlers = {
    theme: this.handleCmd.bind(this),
  };

  listenMessageHandlerIgnoreEdited = true;

  async handleCmd(msg: MessageContext): Promise<void> {
    const text = (msg.text ?? "").trim().split(/\s+/).slice(1);
    const sub = text[0]?.toLowerCase() || "";
    const client = await getGlobalClient();

    if (!sub || sub === "help") {
      await msg.edit({ text: html`${this.description}` });
      return;
    }

    // ── Cloud upload ─────────────────────────────────────────────────────
    if (sub === "cloud") {
      if (!msg.replyToMessage?.id) {
        await msg.edit({ text: "❌ 请回复一个主题文件来上传到云端" });
        return;
      }
      try {
        const reply = await safeGetReplyMessage(msg);
        if (!reply || !(reply as any).media || (reply as any).media.type !== "document") {
          await msg.edit({ text: "❌ 回复的消息不是文件" }); return;
        }
        await msg.edit({ text: "⏳ 下载并解析主题..." });
        const buf = await downloadMedia(reply, client);
        if (!buf || buf.length === 0) { await msg.edit({ text: "❌ 下载失败" }); return; }
        const format = detectFmt(buf);
        if (!format) { await msg.edit({ text: "❌ 无法识别主题格式" }); return; }
        const p = format === "attheme" ? parseAttheme : format === "tdesktop-theme" ? parseDesktop : parseTgx;
        const doc = p(buf);
        if (!doc || !Object.keys(doc.colors).length) { await msg.edit({ text: "❌ 解析失败" }); return; }
        await msg.edit({ text: "⏳ 上传到 Telegram 云端..." });

        const slug = genSlug();
        const converted = renderDoc(doc, format) || buf;
        const uploaded = await client.uploadFile({
          file: converted,
          fileName: `theme${FORMAT_EXT[format]}`,
          fileMime: API_MIME[format],
        });
        const created = await client.call({
          _: "account.createTheme",
          slug,
          title: `TeleBox Theme (${FORMAT_LABELS[format]})`,
          document: { _: "inputDocument", id: (uploaded as any).id, accessHash: (uploaded as any).accessHash },
        } as any);

        const themeSlug = (created as any).slug || slug;
        const link = `https://t.me/addtheme/${themeSlug}`;
        await msg.edit({ text: `✅ <b>云端主题创建成功！</b>\n\n<a href="${link}">${link}</a>\n\n📊 ${Object.keys(doc.colors).length} 个颜色变量` });
      } catch (e: any) {
        await msg.edit({ text: `❌ 云端上传失败: ${getErrorMessage(e)}` });
      }
      return;
    }

    // ── Direct conversion commands ───────────────────────────────────────
    const cmds: Record<string, { from: ThemeFormat; to: ThemeFormat; label: string }> = {
      atd: { from: "attheme", to: "tdesktop-theme", label: "→ Desktop" },
      dta: { from: "tdesktop-theme", to: "attheme", label: "→ Android" },
      attgx: { from: "attheme", to: "tgx-theme", label: "→ TGX" },
      dtatgx: { from: "tdesktop-theme", to: "tgx-theme", label: "→ TGX" },
      tgxat: { from: "tgx-theme", to: "attheme", label: "→ Android" },
      tgxdt: { from: "tgx-theme", to: "tdesktop-theme", label: "→ Desktop" },
    };

    const cmd = cmds[sub];
    if (!cmd) {
      await msg.edit({ text: html`${this.description}` });
      return;
    }

    if (!msg.replyToMessage?.id) {
      await msg.edit({ text: `❌ 请回复主题文件后使用 <code>${mainPrefix}theme ${sub}</code>` });
      return;
    }

    try {
      const reply = await safeGetReplyMessage(msg);
      if (!reply || !(reply as any).media || (reply as any).media.type !== "document") {
        await msg.edit({ text: "❌ 回复不是文件" }); return;
      }
      await msg.edit({ text: `⏳ 下载并转换 ${FORMAT_LABELS[cmd.from]} ${cmd.label}...` });
      const buf = await downloadMedia(reply, client);
      if (!buf || buf.length === 0) { await msg.edit({ text: "❌ 下载失败" }); return; }
      const detected = detectFmt(buf);
      if (detected !== cmd.from) {
        await msg.edit({ text: `❌ 格式不匹配: 检测到 ${FORMAT_LABELS[detected || "attheme"]}，需要 ${FORMAT_LABELS[cmd.from]}` });
        return;
      }
      const parsers: Record<string, (b: Buffer) => ThemeDoc | null> = { attheme: parseAttheme, "tdesktop-theme": parseDesktop, "tgx-theme": parseTgx };
      const doc = parsers[cmd.from](buf);
      if (!doc || !Object.keys(doc.colors).length) { await msg.edit({ text: `❌ 解析失败` }); return; }
      const out = renderDoc(doc, cmd.to);
      if (!out) { await msg.edit({ text: "❌ 转换失败" }); return; }
      const cc = Object.keys(doc.colors).length;
      const hasWp = doc.wallpaper && doc.wallpaper.length > 10;
      await msg.delete();

      await client.sendMedia(msg.chat.id, {
        type: "document", file: out, fileName: `theme${FORMAT_EXT[cmd.to]}`,
      }, {
        caption:
          `✅ <b>转换完成</b>  ${FORMAT_LABELS[cmd.from]} ${cmd.label}\n` +
          `📊 ${cc} 个颜色变量${hasWp ? "\n🖼️ 壁纸已保留" : ""}\n\n` +
          `<i>回复本消息 <code>${mainPrefix}theme cloud</code> 上传到云端生成链接</i>`,
        replyTo: msg.id,
      });
    } catch (e) {
      await msg.edit({ text: `❌ 转换失败: ${getErrorMessage(e)}` });
    }
  }

  // ── Listen: file attachments + t.me/addtheme links + choice responses ──

  listenMessageHandler = async (msg: MessageContext): Promise<void> => {
    try {
      const text = msg.text?.trim();
      const num = text ? parseInt(text) : NaN;

      // 1) Check if this is a number response to a pending conversion
      if (!isNaN(num) && msg.replyToMessage?.id) {
        const pending = loadPending(msg.chat.id, msg.replyToMessage.id);
        if (pending) {
          if ("buf" in pending) {
            await this.handleFileChoice(msg, pending as PendingState, num);
          } else if ("slug" in pending) {
            await this.handleCloudChoice(msg, pending as PendingCloud, num);
          }
          return;
        }
      }

      // 2) Check for t.me/addtheme/SLUG links
      const addthemeMatch = text?.match(/t\.me\/addtheme\/([a-zA-Z0-9_]+)/);
      if (addthemeMatch) {
        await this.handleAddThemeLink(msg, addthemeMatch[1]);
        return;
      }

      // 3) Check if it's a theme file
      if (!msg.media || msg.media.type !== "document") return;
      const doc = (msg.media as any).document as { fileName?: string; size?: number };
      const name = (doc.fileName || "").toLowerCase();
      const size = doc.size || 0;
      if (size > MAX_FILE_SIZE || size === 0) return;
      if (!name.endsWith(".attheme") && !name.endsWith(".tdesktop-theme") && !name.includes("theme") && !name.includes("tgx")) return;

      await msg.edit({ text: "⏳ 识别主题文件..." });
      const client = await getGlobalClient();
      const buf = await downloadMedia(msg, client);
      if (!buf || buf.length === 0) return;
      const format = detectFmt(buf);
      if (!format) {
        await msg.edit({ text: `❌ 无法识别: 支持 .attheme / .tdesktop-theme / TGX JSON\n\n发送 <code>${mainPrefix}theme</code> 查看帮助` });
        return;
      }
      const p = format === "attheme" ? parseAttheme : format === "tdesktop-theme" ? parseDesktop : parseTgx;
      const parsed = p(buf);
      if (!parsed || !Object.keys(parsed.colors).length) {
        await msg.edit({ text: "❌ 解析失败，未找到颜色变量" }); return;
      }
      const cc = Object.keys(parsed.colors).length;
      const hasWp = parsed.wallpaper && parsed.wallpaper.length > 10;
      const targets = (["attheme", "tdesktop-theme", "tgx-theme"] as ThemeFormat[]).filter(f => f !== format);

      await msg.edit({
        text:
          `✅ <b>已识别</b>  ${FORMAT_LABELS[format]}\n` +
          `📊 ${cc} 颜色变量${hasWp ? "\n🖼️  壁纸已嵌入" : ""}\n\n` +
          `<b>转换目标：</b>\n\n` +
          targets.map((f, i) => `• <code>${i + 1}</code> — ${FORMAT_LABELS[f]}`).join("\n") + "\n\n" +
          `<i>回复数字选择（<code>0</code> 取消，60 秒超时）</i>`,
      });

      savePending({ chatId: msg.chat.id, msgId: msg.id, format, buf: [...buf], createdAt: Date.now() });
    } catch (e) {
      logger.error("[theme-converter] listen:", e);
    }
  };

  // ── Handle t.me/addtheme/SLUG ─────────────────────────────────────────

  private async handleAddThemeLink(msg: MessageContext, slug: string): Promise<void> {
    const client = await getGlobalClient();
    try {
      await msg.edit({ text: `⏳ 获取云端主题 <code>${slug}</code>...` });

      // Fetch theme in all formats
      const formats = ["android", "tdesktop", "macos"] as const;
      const results: { format: string; raw: any }[] = [];

      for (const f of formats) {
        try {
          const raw = await client.call({
            _: "account.getTheme",
            format: f,
            theme: { _: "inputThemeSlug", slug },
          } as any);
          results.push({ format: f, raw });
        } catch { /* format not available */ }
      }

      if (results.length === 0) {
        await msg.edit({ text: `❌ 未找到主题 <code>${slug}</code>` });
        return;
      }

      const first = results[0];
      const themeTitle = (first.raw as any)?.title || "Unnamed Theme";
      const availableFormats = results.map(r => r.format);
      const formatLabels = { android: "Android", tdesktop: "Desktop", macos: "TGX" } as Record<string, string>;

      const avail = availableFormats.map(f => `• ${formatLabels[f] || f}`).join("\n");
      await msg.edit({
        text:
          `🎨 <b>${themeTitle}</b>\n\n` +
          `🔗 <code>t.me/addtheme/${slug}</code>\n\n` +
          `<b>可用格式：</b>\n${avail}\n\n` +
          `<b>操作：</b>\n` +
          `• <code>1</code> — 下载并转换为其他格式\n` +
          `• <code>0</code> — 取消\n\n` +
          `<i>60 秒内回复数字</i>`,
      });

      savePending({
        chatId: msg.chat.id,
        msgId: msg.id,
        format: results[0].format,
        colors: {},
        slug,
        title: themeTitle,
        createdAt: Date.now(),
      } as PendingCloud);

      // Store the theme documents info for later download
      fs.writeFileSync(path.join(ASSETS_DIR, `cloud_${msg.chat.id}_${msg.id}.json`), JSON.stringify({
        slug, title: themeTitle,
        documents: results.map(r => ({
          format: r.format,
          id: (r.raw as any)?.document?.id ? Number((r.raw as any).document.id) : null,
          accessHash: (r.raw as any)?.document?.accessHash ? Number((r.raw as any).document.accessHash) : null,
        })),
      }));
    } catch (e: any) {
      await msg.edit({ text: `❌ 获取云端主题失败: ${getErrorMessage(e)}` });
    }
  }

  // ── Handle cloud theme choice ─────────────────────────────────────────

  private async handleCloudChoice(msg: MessageContext, pending: PendingCloud, choice: number): Promise<void> {
    cleanupPending(pending.chatId, pending.msgId);
    if (choice !== 1) { await msg.edit({ text: "❌ 已取消" }); return; }

    const client = await getGlobalClient();
    try {
      await msg.edit({ text: "⏳ 读取云端主题数据..." });

      let docInfo: any = null;
      try {
        docInfo = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, `cloud_${pending.chatId}_${pending.msgId}.json`), "utf-8"));
      } catch { /* */ }
      if (!docInfo) { await msg.edit({ text: "❌ 未找到主题文档信息" }); return; }
      try { fs.unlinkSync(path.join(ASSETS_DIR, `cloud_${pending.chatId}_${pending.msgId}.json`)); } catch { /* */ }

      const availableDocs = docInfo.documents?.filter((d: any) => d.id && d.accessHash) || [];
      if (availableDocs.length === 0) { await msg.edit({ text: "❌ 无可下载的文档" }); return; }

      const lines = availableDocs.map((d: any, i: number) => {
        const fl = { android: "📱 Android", tdesktop: "💻 Desktop", macos: "📲 TGX" } as Record<string, string>;
        return `• <code>${i + 1}</code> — ${fl[d.format] || d.format}`;
      });

      await msg.edit({
        text:
          `🎨 <b>${docInfo.title}</b>\n\n` +
          `<b>选择要下载的格式：</b>\n\n${lines.join("\n")}\n\n` +
          `<i>回复数字选择（60 秒超时）</i>`,
      });

      // Save new pending state and store docInfo again
      savePending({ chatId: pending.chatId, msgId: msg.id, format: pending.format, buf: [], createdAt: Date.now() } as any);
      fs.writeFileSync(path.join(ASSETS_DIR, `cloudfmt_${pending.chatId}_${msg.id}.json`), JSON.stringify(docInfo));
    } catch (e: any) {
      await msg.edit({ text: `❌ 处理失败: ${getErrorMessage(e)}` });
    }
  }

  // ── Handle file choice (original file conversion) ────────────────────

  private async handleFileChoice(msg: MessageContext, pending: PendingState, choice: number): Promise<void> {
    const client = await getGlobalClient();
    cleanupPending(pending.chatId, pending.msgId);

    if (choice <= 0 || choice > 3) { await msg.edit({ text: "❌ 已取消" }); return; }
    const targets = (["attheme", "tdesktop-theme", "tgx-theme"] as ThemeFormat[]).filter(f => f !== pending.format);
    if (choice > targets.length) { await msg.edit({ text: "❌ 无效选择" }); return; }
    const target = targets[choice - 1];

    try {
      await msg.edit({ text: `⏳ 转换为 ${FORMAT_LABELS[target]}...` });
      const buf = Buffer.from(pending.buf);
      const p = pending.format === "attheme" ? parseAttheme : pending.format === "tdesktop-theme" ? parseDesktop : parseTgx;
      const doc = p(buf);
      if (!doc) { await msg.edit({ text: "❌ 重新解析失败" }); return; }
      const out = renderDoc(doc, target);
      if (!out) { await msg.edit({ text: "❌ 转换失败" }); return; }
      const cc = Object.keys(doc.colors).length;
      const hasWp = doc.wallpaper && doc.wallpaper.length > 10;
      await msg.delete();
      await client.sendMedia(msg.chat.id, {
        type: "document", file: out, fileName: `theme_${target}${FORMAT_EXT[target]}`,
      }, {
        caption:
          `✅ <b>转换完成</b>  ${FORMAT_LABELS[pending.format]} → ${FORMAT_LABELS[target]}\n` +
          `📊 ${cc} 颜色变量${hasWp ? "\n🖼️ 壁纸已保留" : ""}\n\n` +
          `<i>回复此消息 <code>${mainPrefix}theme cloud</code> 上传到云端</i>`,
        replyTo: msg.id,
      });
    } catch (e) {
      await msg.edit({ text: `❌ 转换失败: ${getErrorMessage(e)}` });
    }
  }
}

export default new ThemeConverterPlugin();
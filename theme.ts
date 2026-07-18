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
  wallpaper?: any;
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
  "tgx-theme": ".json",
  "ios-theme": ".json",
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

function genTgx(colors: Record<string, string>): string {
  const m = (ak: string, fb: string) => colors[A2T_MAP[ak] || ak] || colors[ak] || fb;
  const bg = m("windowBackgroundWhite", "#1c1b1f");
  const t = m("windowBackgroundWhiteBlackText", "#e6e1e5");
  const p = m("windowBackgroundWhiteBlueText", "#6750a4");
  const st = m("windowBackgroundWhiteGrayText", "#938f96");
  const mi = colors["bubbleIn_background"] || colors["msgInBg"] || colors["chat_inBubble"] || "#2b2930";
  const mo = colors["bubbleOut_background"] || colors["msgOutBg"] || colors["chat_outBubble"] || p;
  const tb = colors["headerBackground"] || colors["topBarBg"] || colors["actionBarDefault"] || bg;
  return JSON.stringify({
    // Chat list
    chatListBackground: bg,
    chatListAction: st,
    chatListIcon: st,
    headerBackground: tb,
    headerTitle: t,
    headerIcon: p,
    headerTabActive: p,
    // Controls
    controlActive: p,
    controlContent: "#ffffff",
    textPlaceholder: st,
    // Badge
    badge: p,
    badgeMuted: st,
    badgeFailedText: "#f44336",
    // Ticks
    ticks: p,
    ticksRead: p,
    // Avatar
    avatar_content: t,
    avatarArchive: adjustBright(bg, 15),
    // Circle buttons
    circleButtonRegular: p,
    circleButtonRegularIcon: "#ffffff",
    circleButtonChat: bg,
    circleButtonChatIcon: p,
    circleButtonTheme: p,
    circleButtonThemeIcon: "#ffffff",
    circleButtonActive: adjustBright(p, -15),
    circleButtonActiveIcon: "#ffffff",
    // Keyboard
    chatKeyboard: bg,
    // Passcode
    passcode: bg,
    passcodeText: t,
    passcodeIcon: p,
    // Bubbles - Incoming
    bubbleIn_background: mi,
    bubbleIn_text: t,
    bubbleIn_textLink: p,
    bubbleIn_time: st,
    bubbleIn_chatVerticalLine: p,
    bubbleIn_messageAuthor: p,
    bubbleIn_file: p,
    bubbleIn_separator: st,
    bubbleIn_waveformActive: p,
    bubbleIn_waveformInactive: st,
    // Bubbles - Outgoing
    bubbleOut_background: mo,
    bubbleOut_text: t,
    bubbleOut_textLink: p,
    bubbleOut_time: st,
    bubbleOut_chatVerticalLine: p,
    bubbleOut_messageAuthor: p,
    bubbleOut_file: p,
    bubbleOut_separator: st,
    bubbleOut_waveformActive: p,
    bubbleOut_waveformInactive: st,
    bubbleOut_outline: p,
    // Bubbles - Shared
    bubble_messageSelection: p + "1a",
    bubble_unreadText: p,
    bubble_dateText: st,
    bubble_buttonText: p,
    bubble_mediaOverlayText: "#ffffff",
    bubble_overlayText: "#ffffff",
    // Service messages
    chatServiceBackground: p + "3c",
    // Separator
    separator: adjustBright(bg, 15),
    // Theme color
    themeColor: p,
    // Player
    playerBackground: bg,
    playerTitle: t,
    playerProgress: p,
    playerProgressBackground: st,
    playerButtonActive: p,
    // Calls
    callsBg: bg,
    callsName: t,
    callsReceived: "#4caf50",
    callsMissed: "#f44336",
  }, null, 2);
}

function genIos(colors: Record<string, string>): string {
  const m = (ak: string, fb: string) => colors[A2I_MAP[ak] || ak] || colors[ak] || fb;
  const bg = m("windowBackgroundWhite", "#1c1b1f");
  const t = m("windowBackgroundWhiteBlackText", "#e6e1e5");
  const p = m("windowBackgroundWhiteBlueText", "#6750a4");
  const st = m("windowBackgroundWhiteGrayText", "#938f96");
  const mi = colors["chatIncomingBubble"] || colors["msgInBg"] || colors["chat_inBubble"] || "#2b2930";
  const mo = colors["chatOutgoingBubble"] || colors["msgOutBg"] || colors["chat_outBubble"] || p;
  const tb = colors["navigationBarBackground"] || colors["topBarBg"] || colors["actionBarDefault"] || bg;
  return JSON.stringify({
    // General
    backgroundColor: bg,
    primaryText: t,
    secondaryText: st,
    accentColor: p,
    accentIcon: "#ffffff",
    destructiveText: "#f44336",
    separatorColor: adjustBright(bg, 15),
    listRipple: p + "1a",
    // Navigation Bar
    navigationBarBackground: tb,
    navigationBarTitle: t,
    navigationBarSubtitle: st,
    navigationBarIcons: p,
    // Tab Bar
    tabBarBackground: bg,
    tabBarIcon: st,
    tabBarActiveIcon: p,
    tabBarActiveLine: p,
    tabBarBadge: p,
    tabBarBadgeText: "#ffffff",
    // Chat List
    chatListBackground: bg,
    chatListName: t,
    chatListMessage: st,
    chatListDate: st,
    chatListBadge: p,
    chatListBadgeText: "#ffffff",
    chatListBadgeMuted: st,
    chatListSentIcon: p,
    chatListReadIcon: p,
    chatListDraft: "#f44336",
    chatListVerified: p,
    // Chat - Incoming
    chatIncomingBubble: mi,
    chatIncomingBubbleSelected: adjustBright(mi, 15),
    chatIncomingText: t,
    chatIncomingLink: p,
    chatIncomingTime: st,
    chatIncomingViews: st,
    chatIncomingReplyLine: p,
    chatIncomingReplyName: p,
    chatIncomingReplyMessage: st,
    // Chat - Outgoing
    chatOutgoingBubble: mo,
    chatOutgoingBubbleSelected: adjustBright(mo, 15),
    chatOutgoingText: t,
    chatOutgoingLink: p,
    chatOutgoingTime: st,
    chatOutgoingViews: st,
    chatOutgoingReplyLine: p,
    chatOutgoingReplyName: p,
    chatOutgoingReplyMessage: st,
    // Chat - Service
    chatServiceBackground: p + "3c",
    chatServiceText: "#ffffff",
    chatServiceLink: "#ffffff",
    chatStatus: p,
    chatSelectionBackground: p + "1a",
    chatJumpButtonBackground: bg,
    chatJumpButtonIcon: p,
    // Keyboard
    keyboardBackground: bg,
    keyboardText: t,
    keyboardPlaceholder: st,
    keyboardSendIcon: p,
    keyboardIcon: st,
    keyboardActiveIcon: p,
    keyboardBadge: p,
    keyboardBadgeText: "#ffffff",
    // Avatar
    avatarPlaceholderText: t,
    // Controls
    switchActive: p,
    switchInactive: st,
    // Player
    playerBackground: bg,
    playerIcon: t,
    playerProgress: p,
    playerProgressBackground: st,
    // Calls
    callGreenIcon: "#4caf50",
    callRedIcon: "#f44336",
    // Theme Color
    themeColor: p,
  }, null, 2);
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
    let wallpaper: any = null;
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
    // If all keys are iOS-style, reclassify
    const iosKeys = ["backgroundColor", "navigationBarBackground", "chatIncomingBubble", "keyboardBackground"];
    const hasIosKeys = iosKeys.some(k => colors[k] !== undefined);
    const tgxKeys = ["bubbleIn_background", "bubbleOut_background", "chatListBackground", "headerBackground"];
    const hasTgxKeys = tgxKeys.some(k => colors[k] !== undefined);
    if (hasIosKeys && !hasTgxKeys) {
      return { format: "ios-theme", colors };
    }
    return { format: "tgx-theme", colors };
  } catch { return null; }
}

function parseIos(buf: Buffer): ThemeDoc | null {
  try {
    const colors: Record<string, string> = {};
    for (const [k, v] of Object.entries(JSON.parse(buf.toString("utf-8")))) {
      if (typeof v === "string" && v.startsWith("#")) colors[k] = v;
    }
    return { format: "ios-theme", colors };
  } catch { return null; }
}

function detectFmt(buf: Buffer): ThemeFormat | null {
  const t = buf.toString("utf-8").trim();
  // Try JSON formats
  if (t[0] === "{" || t[0] === "[") {
    try {
      const obj = JSON.parse(t);
      if (typeof obj === "object" && obj !== null) {
        // Check for iOS-specific keys
        if (obj.backgroundColor || obj.navigationBarBackground || obj.chatIncomingBubble) return "ios-theme";
        // Check for TGX-specific keys
        if (obj.bubbleIn_background || obj.chatListBackground || obj.headerBackground) return "tgx-theme";
        // Generic JSON with colors starting with #
        for (const v of Object.values(obj)) {
          if (typeof v === "string" && v.startsWith("#")) return "tgx-theme";
        }
      }
    } catch { /* */ }
  }
  if (t.split("\n").some((l: string) => (l.includes("=") && !l.trim().startsWith("//")) || l.includes("WPS"))) return "attheme";
  if (t.split("\n").some((l: string) => l.includes(":") && l.includes(";"))) return "tdesktop-theme";
  return null;
}

function renderDoc(doc: ThemeDoc, target: ThemeFormat): Buffer | null {
  try {
    const df = doc.format;
    if (df === "attheme" && target === "tdesktop-theme") {
      const buf = Buffer.from(genDesktop(doc.colors), "utf-8");
      if (doc.wallpaper && doc.wallpaper.length > 10) return Buffer.concat([buf, Buffer.from("\n\n"), doc.wallpaper] as any);
      return buf;
    }
    if (target === "attheme" && (df === "tdesktop-theme" || df === "tgx-theme" || df === "ios-theme")) {
      const text = genAndroid(doc.colors).join("\n") + "\n";
      const parts: any[] = [Buffer.from(text, "utf-8")];
      if (doc.wallpaper && doc.wallpaper.length > 10) {
        parts.push(Buffer.from("WPS\n"), doc.wallpaper);
        if (!Buffer.from(doc.wallpaper).slice(-5).equals(Buffer.from("\nWPE\n"))) parts.push(Buffer.from("\nWPE\n"));
      }
      return Buffer.concat(parts);
    }
    if (target === "tgx-theme") return Buffer.from(genTgx(doc.colors), "utf-8");
    if (target === "ios-theme") return Buffer.from(genIos(doc.colors), "utf-8");
    // remaining conversions (any format to desktop or cross-format)
    if (target === "tdesktop-theme") return Buffer.from(genDesktop(doc.colors), "utf-8");
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
        await msg.edit({ text: html`❌ 无法识别格式，支持 .attheme / .tdesktop-theme / TGX JSON / iOS JSON<br/><br/>使用 <code>${mainPrefix}theme</code> 查看帮助` });
        return;
      }
      const parser = format === "attheme" ? parseAttheme : format === "tdesktop-theme" ? parseDesktop : format === "tgx-theme" ? parseTgx : parseIos;
      const doc = parser(buf);
      if (!doc || !Object.keys(doc.colors).length) {
        await msg.edit({ text: html`❌ 解析失败，未找到颜色变量` });
        return;
      }

      const cc = Object.keys(doc.colors).length;
      const hasWp = doc.wallpaper && doc.wallpaper.length > 10;
      const targets = (["attheme", "tdesktop-theme", "tgx-theme", "ios-theme"] as ThemeFormat[]).filter(f => f !== format) as ThemeFormat[];

      // convert to all targets
      const converted: { target: ThemeFormat; result: Buffer | null }[] = targets.map(t => ({
        target: t,
        result: renderDoc(doc, t),
      }));

      const count = converted.filter(c => c.result).length;

      await msg.edit({
        text: html`
✅ <b>已识别</b> ${FORMAT_LABELS[format]}
📊 ${cc} 个颜色变量${hasWp ? "<br/>🖼️ 壁纸已嵌入" : ""}

<b>转换：${count}/${targets.length} 个格式</b>

${converted.map((c, i) => {
  const ok = c.result !== null;
  const label = FORMAT_LABELS[c.target];
  return `${ok ? "✅" : "❌"} ${label}`;
}).join("<br/>")}

<i>回复文件使用</i> <code>${mainPrefix}theme ${"{"}android|desktop|tgx|ios${"}"}</code> <i>转换到单格式</i>
        `,
      });

      // send each successful conversion
      for (let i = 0; i < converted.length; i++) {
        const c = converted[i];
        if (!c.result) continue;
        await client.sendMedia(msg.chat.id, {
          type: "document",
          file: c.result,
          fileName: `theme${FORMAT_EXT[c.target]}`,
        }, {
          caption: html`
✅ <b>${FORMAT_LABELS[format]}</b> → <b>${FORMAT_LABELS[c.target]}</b>
📊 ${cc} 个颜色变量${hasWp ? "<br/>🖼️ 壁纸已保留" : ""}
          `,
          replyTo: msg.id,
        });
      }

      // update the info message with the last note
      // (edit is already done above)
    } catch (e) {
      logger.error("[theme] listen:", e);
    }
  };

  // ── Handle t.me/addtheme/SLUG ────────────────────────────────────────

  private async handleAddThemeLink(msg: MessageContext, slug: string): Promise<void> {
    const client = await getGlobalClient();
    try {
      await msg.edit({ text: html`⏳ 获取主题 <code>${slug}</code>...` });

      // Try all 4 API formats first
      const apiFormats = ["android", "tdesktop", "macos", "ios"] as const;
      const fmtMap: Record<string, { format: ThemeFormat; buf: Buffer }> = {};
      let themeTitle = "Unknown Theme";

      for (const f of apiFormats) {
        try {
          const raw: any = await client.call({
            _: "account.getTheme",
            format: f,
            theme: { _: "inputThemeSlug", slug },
          } as any);
          if (!themeTitle || themeTitle === "Unknown Theme") themeTitle = raw?.title || "Unnamed Theme";
          if (!raw?.document?.id || !raw?.document?.accessHash) continue;
          const dlBuf = await client.downloadAsBuffer({
            _: "inputDocument",
            id: Number(raw.document.id),
            accessHash: Number(raw.document.accessHash),
          } as any);
          if (!dlBuf) continue;
          const full = Buffer.from(dlBuf);
          const fLabel: Record<string, ThemeFormat> = { android: "attheme", tdesktop: "tdesktop-theme", macos: "tgx-theme", ios: "ios-theme" };
          fmtMap[f] = { format: fLabel[f] || "attheme", buf: full };
        } catch { /* not available */ }
      }

      if (Object.keys(fmtMap).length > 0) {
        // cloud theme found — parse and convert
        const results: { label: string; from: ThemeFormat; targets: { t: ThemeFormat; ok: boolean }[] }[] = [];

        for (const [apiFmt, info] of Object.entries(fmtMap)) {
          const { format: fmt, buf } = info;
          const parser = fmt === "attheme" ? parseAttheme : fmt === "tdesktop-theme" ? parseDesktop : fmt === "tgx-theme" ? parseTgx : parseIos;
          const doc = parser(buf);
          if (!doc) continue;
          const cc = Object.keys(doc.colors).length;
          const targets = (["attheme", "tdesktop-theme", "tgx-theme", "ios-theme"] as ThemeFormat[]).filter(f => f !== fmt);
          const convResults = targets.map(t => ({ t, ok: renderDoc(doc, t) !== null }));
          results.push({ label: `${FORMAT_LABELS[fmt]} (${cc}色)`, from: fmt, targets: convResults });

          for (const cr of convResults) {
            if (!cr.ok) continue;
            const out = renderDoc(doc, cr.t);
            if (!out) continue;
            await client.sendMedia(msg.chat.id, {
              type: "document",
              file: out,
              fileName: `theme${FORMAT_EXT[cr.t]}`,
            }, {
              caption: html`✅ <b>${FORMAT_LABELS[fmt]}</b> → <b>${FORMAT_LABELS[cr.t]}</b> 📊 ${cc} 色`,
              replyTo: msg.id,
            });
          }
        }

        await msg.edit({
          text: html`
🎨 <b>${themeTitle}</b>
🔗 <code>t.me/addtheme/${slug}</code>

${results.map(r => `📦 ${r.label}<br/>${r.targets.map(t => `${t.ok ? "✅" : "❌"} ${FORMAT_LABELS[t.t]}`).join("<br/>")}`).join("<br/><br/>")}
          `,
        });
        return;
      }

      // ── Fallback: try web page preview (non-theme t.me/addtheme links) ──
      await msg.edit({ text: html`⏳ 不是云端主题，尝试获取网页内容...` });

      // Resolve the web page
      const url = `https://t.me/addtheme/${slug}`;
      const webPagePreview: any = await client.call({
        _: "messages.getWebPagePreview",
        message: url,
      } as any);

      let webPage: any = null;
      if (webPagePreview?._ === "messageMediaWebPage" && webPagePreview?.webpage) {
        webPage = webPagePreview.webpage;
      } else {
        // Try direct getWebPage
        const wpResult: any = await client.call({
          _: "messages.getWebPage",
          url,
          hash: 0,
        } as any);
        if (wpResult?._ === "webPage" || wpResult?.webpage) {
          webPage = wpResult._ === "webPage" ? wpResult : wpResult.webpage;
        }
      }

      if (!webPage) {
        await msg.edit({ text: html`❌ 未找到主题 <code>${slug}</code>，该链接可能不是有效的主题或页面` });
        return;
      }

      const siteName = webPage.site_name || "";
      const title = webPage.title || slug;
      const desc = webPage.description || "";

      // Check if the page has a theme document attachment
      let themeDoc: any = null;
      if (webPage.document) {
        const docName = (webPage.document.fileName || "").toLowerCase();
        if (docName.endsWith(".attheme") || docName.endsWith(".tdesktop-theme") || docName.includes("theme")) {
          themeDoc = webPage.document;
        }
      }

      if (themeDoc) {
        await msg.edit({ text: html`⏳ 从网页下载主题文件...` });
        const dlBuf = await client.downloadAsBuffer({
          _: "inputDocument",
          id: Number(themeDoc.id),
          accessHash: Number(themeDoc.accessHash),
        } as any);
        if (dlBuf) {
          const full = Buffer.from(dlBuf);
          const format = detectFmt(full);
          if (format) {
            const parser = format === "attheme" ? parseAttheme : format === "tdesktop-theme" ? parseDesktop : format === "tgx-theme" ? parseTgx : parseIos;
            const doc = parser(full);
            if (doc && Object.keys(doc.colors).length > 0) {
              const cc = Object.keys(doc.colors).length;
              const targets = (["attheme", "tdesktop-theme", "tgx-theme", "ios-theme"] as ThemeFormat[]).filter(f => f !== format);
              let sent = 0;
              for (const t of targets) {
                const out = renderDoc(doc, t);
                if (!out) continue;
                await client.sendMedia(msg.chat.id, {
                  type: "document", file: out, fileName: `theme${FORMAT_EXT[t]}`,
                }, {
                  caption: html`✅ <b>${FORMAT_LABELS[format]}</b> → <b>${FORMAT_LABELS[t]}</b> 📊 ${cc} 色`,
                  replyTo: msg.id,
                });
                sent++;
              }
              await msg.edit({
                text: html`
📄 <b>${title}</b>
🔗 <code>t.me/addtheme/${slug}</code>
${desc ? `<br/>${desc}` : ""}
<br/>✅ ${sent} 个格式已转换
                `,
              });
              return;
            }
          }
        }
      }

      // No downloadable theme — show info
      await msg.edit({
        text: html`
📄 <b>${title}</b>
🔗 <code>t.me/addtheme/${slug}</code>
${siteName ? `<br/>📌 ${siteName}` : ""}
${desc ? `<br/><br/>${desc}` : ""}
<br/><br/><i>该链接不包含可下载的主题文件</i>
        `,
      });
    } catch (e: any) {
      await msg.edit({ text: html`❌ 获取失败: ${getErrorMessage(e)}` });
    }
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
      const hasWp = doc.wallpaper && doc.wallpaper.length > 10;
      await msg.delete();
      await client.sendMedia(msg.chat.id, {
        type: "document", file: out, fileName: `theme${FORMAT_EXT[target]}`,
      }, {
        caption: html`
✅ <b>转换完成</b> ${TARGET_CLIENT_LABELS[target]}
📊 ${cc} 个颜色变量${hasWp ? "<br/>🖼️ 壁纸已保留" : ""}
        `,
        replyTo: msg.id,
      });
    } catch (e) {
      await msg.edit({ text: html`❌ 转换失败: ${getErrorMessage(e)}` });
    }
  }
}

export default new ThemePlugin();
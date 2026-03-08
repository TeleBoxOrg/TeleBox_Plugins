import { Api, TelegramClient } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";

const PLUGIN_VERSION = "5.0.0";

enum LogLevel { INFO = 1, WARN = 2, ERROR = 3 }

function log(level: LogLevel, message: string, data?: any) {
  const prefix = `[PMCaptcha] [${new Date().toISOString()}] [${LogLevel[level]}]`;
  data ? console.log(`${prefix} ${message}`, data) : console.log(`${prefix} ${message}`);
}

enum CaptchaMode {
  MATH       = "math",
  TEXT       = "text",
  IMG_DIGIT  = "img_digit",
  IMG_MIXED  = "img_mixed",
}

enum FailAction {
  BLOCK        = "block",
  DELETE       = "delete",
  REPORT       = "report",
  MUTE         = "mute",
  ARCHIVE      = "archive",
  KICK         = "kick",
  BAN          = "ban",
  DELETE_REVOKE = "delete_revoke"
}

enum PassAction {
  UNMUTE    = "unmute",
  UNARCHIVE = "unarchive"
}

const FAIL_ACTION_LABEL: Record<string, string> = {
  block:         "被屏蔽",
  delete:        "删除对话",
  delete_revoke: "删除对话（双端）",
  report:        "举报",
  mute:          "永久静音",
  archive:       "归档",
  kick:          "踢出",
  ban:           "封禁"
};

const PASS_ACTION_LABEL: Record<string, string> = {
  unmute:    "取消静音",
  unarchive: "取消归档"
};

const K = {
  ENABLED:          "plugin_enabled",
  CAP_ENABLED:      "captcha_enabled",
  CAP_MODE:         "captcha_mode",
  CAP_TIMEOUT:      "captcha_timeout",
  CAP_TRIES:        "captcha_max_tries",
  CAP_ACTIONS:      "captcha_fail_actions",
  CAP_KEYWORD:      "captcha_text_keyword",
  CAP_PROMPT:       "captcha_prompt",
  CAP_PASS_ACTIONS: "captcha_pass_actions",
} as const;

const D = {
  WHITELIST: "whitelist_user_ids",
  VERIFIED:  "verified_users",
  FAILED:    "failed_users",
} as const;

interface VerifiedRecord { id: number; name: string; username?: string; time: string }
interface FailedRecord   { id: number; name: string; username?: string; time: string; reason: "timeout" | "max_tries" }

const DEFAULT_CONFIG = {
  [K.ENABLED]:         true,
  [K.CAP_ENABLED]:     false,
  [K.CAP_MODE]:        CaptchaMode.MATH,
  [K.CAP_TIMEOUT]:     30,
  [K.CAP_TRIES]:       3,
  [K.CAP_ACTIONS]:     [] as FailAction[],
  [K.CAP_KEYWORD]:     "我同意",
  [K.CAP_PROMPT]:      "",
  [K.CAP_PASS_ACTIONS]: [] as PassAction[],
};

const DEFAULT_DATA = {
  [D.WHITELIST]: [] as number[],
  [D.VERIFIED]:  [] as VerifiedRecord[],
  [D.FAILED]:    [] as FailedRecord[],
};

interface JsonDb { data: Record<string, any>; write(): Promise<void> }

const prefixes   = getPrefixes();
const mainPrefix = prefixes[0] || ".";
const pmcDir     = createDirectoryInAssets("pmcaptcha");

const dataDir = path.join(process.cwd(), "pmcaptcha_userdata");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let configDb: JsonDb | null = null;
let dataDb:   JsonDb | null = null;
let dbReady = false;

async function initDb() {
  try {
    [configDb, dataDb] = await Promise.all([
      JSONFilePreset(path.join(pmcDir,  "pmcaptcha_config.json"), DEFAULT_CONFIG) as Promise<JsonDb>,
      JSONFilePreset(path.join(dataDir, "pmcaptcha_data.json"),   DEFAULT_DATA)   as Promise<JsonDb>,
    ]);
    dbReady = true;
    log(LogLevel.INFO, `Config DB ready | Data DB: ${path.join(dataDir, "pmcaptcha_data.json")}`);
  } catch (e) {
    log(LogLevel.ERROR, "DB init failed", e);
  }
}

async function waitDb(ms = 5000): Promise<boolean> {
  const t = Date.now();
  while (!dbReady && Date.now() - t < ms) await new Promise(r => setTimeout(r, 50));
  return dbReady;
}

initDb();

function get<T>(key: string, def: T): T {
  if (!dbReady) return def;

  const db = (configDb?.data[key] !== undefined) ? configDb : dataDb;
  const v  = db?.data[key];
  return v !== undefined ? v : def;
}

function set(key: string, value: any) {
  if (!dbReady) return;

  if (key in DEFAULT_DATA) {
    if (!dataDb) return;
    dataDb.data[key] = value;
    dataDb.write().catch(e => log(LogLevel.ERROR, `data write failed: ${key}`, e));
  } else {
    if (!configDb) return;
    configDb.data[key] = value;
    configDb.write().catch(e => log(LogLevel.ERROR, `config write failed: ${key}`, e));
  }
}

const cfg = {
  pluginOn:    () => get(K.ENABLED, true),
  captchaOn:   () => get(K.CAP_ENABLED, false),
  mode:        () => {
    const v = get<string>(K.CAP_MODE, CaptchaMode.MATH);
    return (Object.values(CaptchaMode) as string[]).includes(v)
      ? v as CaptchaMode
      : CaptchaMode.MATH;
  },
  timeout:     () => get<number>(K.CAP_TIMEOUT, 30),
  maxTries:    () => get<number>(K.CAP_TRIES, 3),
  failActions: () => get<FailAction[]>(K.CAP_ACTIONS, []),
  keyword:     () => get(K.CAP_KEYWORD, "我同意"),
  prompt:      () => get(K.CAP_PROMPT, ""),
  whitelist:   () => get<number[]>(D.WHITELIST, []),
  verified:    () => get<VerifiedRecord[]>(D.VERIFIED, []),
  failed:      () => get<FailedRecord[]>(D.FAILED, []),
  passActions: () => get<PassAction[]>(K.CAP_PASS_ACTIONS, []),
};

const wl = {
  has:   (id: number) => cfg.whitelist().includes(id),
  add:   (id: number) => {
    const list = cfg.whitelist();
    if (!list.includes(id)) { list.push(id); set(D.WHITELIST, list); }
  },
  del:   (id: number) => set(D.WHITELIST, cfg.whitelist().filter(x => x !== id)),
  clear: ()           => set(D.WHITELIST, [])
};

const rec = {
  addVerified: (id: number, name: string, username?: string) => {
    const list = cfg.verified();
    const idx  = list.findIndex(r => r.id === id);
    const entry: VerifiedRecord = { id, name, ...(username ? { username } : {}), time: new Date().toISOString() };
    idx >= 0 ? list[idx] = entry : list.push(entry);
    set(D.VERIFIED, list);
  },
  delVerified:   (id: number) => set(D.VERIFIED, cfg.verified().filter(r => r.id !== id)),
  clearVerified: ()           => set(D.VERIFIED, []),

  addFailed: (id: number, name: string, reason: FailedRecord["reason"], username?: string) => {
    const list = cfg.failed();
    const idx  = list.findIndex(r => r.id === id);
    const entry: FailedRecord = { id, name, reason, ...(username ? { username } : {}), time: new Date().toISOString() };
    idx >= 0 ? list[idx] = entry : list.push(entry);
    set(D.FAILED, list);
  },
  delFailed:   (id: number) => set(D.FAILED, cfg.failed().filter(r => r.id !== id)),
  clearFailed: ()           => set(D.FAILED, [])
};

const nameCache     = new Map<number, string>();
const usernameCache = new Map<number, string>();
let _selfId: number | null = null;

async function getSelfId(client: TelegramClient): Promise<number> {
  if (_selfId !== null) return _selfId;
  try { _selfId = Number((await client.getMe() as any).id); }
  catch { _selfId = 0; }
  return _selfId!;
}

function cacheUserFromSender(sender: any): void {
  if (!sender?.id) return;
  const id       = Number(sender.id);
  const name     = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim() || "Unknown";
  const username = sender.username as string | undefined;
  nameCache.set(id, name);
  if (username) usernameCache.set(id, username);
}

async function fetchUserInfo(client: TelegramClient, userId: number): Promise<any | null> {

  try {
    const e = await client.getEntity(userId) as any;
    cacheUserFromSender(e);
    return e;
  } catch {}

  try {
    const res = await client.invoke(new Api.users.GetUsers({
      id: [new Api.InputUser({ userId: BigInt(userId), accessHash: BigInt(0) })]
    })) as any[];
    const user = res?.[0];
    if (user && !(user instanceof Api.UserEmpty)) {
      cacheUserFromSender(user);
      return user;
    }
  } catch {}

  return null;
}

async function getDisplayName(client: TelegramClient, userId: number): Promise<string> {
  if (nameCache.has(userId)) return nameCache.get(userId)!;
  const user = await fetchUserInfo(client, userId);
  if (user) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "Unknown";
    return name;
  }
  return String(userId);
}

function userLink(id: number, name: string): string {
  return `<a href="tg://user?id=${id}">${name} (${id})</a>`;
}

function isBotFromSender(sender: any): boolean {
  return !!(sender as any)?.bot;
}

async function isBot(client: TelegramClient, userId: number): Promise<boolean> {
  const user = await fetchUserInfo(client, userId);
  return !!user?.bot;
}

async function archiveChat(client: TelegramClient, userId: number) {
  try {
    const peer = await client.getInputEntity(userId);
    await client.invoke(new Api.folders.EditPeerFolders({
      folderPeers: [new Api.InputFolderPeer({ peer, folderId: 1 })]
    }));
  } catch (e) { log(LogLevel.ERROR, `archive failed ${userId}`, e); }
}

async function muteChat(client: TelegramClient, userId: number) {
  try {
    const peer = await client.getInputEntity(userId);
    await client.invoke(new Api.account.UpdateNotifySettings({
      peer: new Api.InputNotifyPeer({ peer }),
      settings: new Api.InputPeerNotifySettings({ muteUntil: 2147483647, showPreviews: false, silent: true })
    }));
  } catch (e) { log(LogLevel.ERROR, `mute failed ${userId}`, e); }
}

async function blockUser(client: TelegramClient, userId: number) {
  try {
    const peer = await client.getInputEntity(userId);
    await client.invoke(new Api.contacts.Block({ id: peer }));
    log(LogLevel.INFO, `Blocked ${userId}`);
  } catch (e) { log(LogLevel.ERROR, `block failed ${userId}`, e); }
}

async function deleteHistory(client: TelegramClient, userId: number) {
  try {
    const peer = await client.getInputEntity(userId);
    await client.invoke(new Api.messages.DeleteHistory({ peer, revoke: false, maxId: 0 }));
    log(LogLevel.INFO, `Deleted history ${userId}`);
  } catch (e) { log(LogLevel.ERROR, `delete history failed ${userId}`, e); }
}

async function reportSpam(client: TelegramClient, userId: number) {
  try {
    const peer = await client.getInputEntity(userId);
    await client.invoke(new Api.account.ReportPeer({
      peer, reason: new Api.InputReportReasonSpam(), message: "spam"
    }));
    log(LogLevel.INFO, `Reported ${userId}`);
  } catch (e) { log(LogLevel.ERROR, `report failed ${userId}`, e); }
}

async function unmuteChat(client: TelegramClient, userId: number) {
  try {
    const peer = await client.getInputEntity(userId);
    await client.invoke(new Api.account.UpdateNotifySettings({
      peer: new Api.InputNotifyPeer({ peer }),
      settings: new Api.InputPeerNotifySettings({ muteUntil: 0, showPreviews: true, silent: false })
    }));
  } catch (e) { log(LogLevel.ERROR, `unmute failed ${userId}`, e); }
}

async function unarchiveChat(client: TelegramClient, userId: number) {
  try {
    const peer = await client.getInputEntity(userId);
    await client.invoke(new Api.folders.EditPeerFolders({
      folderPeers: [new Api.InputFolderPeer({ peer, folderId: 0 })]
    }));
  } catch (e) { log(LogLevel.ERROR, `unarchive failed ${userId}`, e); }
}

async function runFailActions(client: TelegramClient, userId: number) {

  await archiveChat(client, userId);
  await muteChat(client, userId);

  for (const a of cfg.failActions()) {
    if (a === FailAction.BLOCK)         await blockUser(client, userId);
    if (a === FailAction.DELETE)        await deleteHistory(client, userId);
    if (a === FailAction.DELETE_REVOKE) {
      try {
        const peer = await client.getInputEntity(userId);
        await client.invoke(new Api.messages.DeleteHistory({ peer, revoke: true, maxId: 0 }));
        log(LogLevel.INFO, `Deleted history (revoke) ${userId}`);
      } catch (e) { log(LogLevel.ERROR, `delete_revoke failed ${userId}`, e); }
    }
    if (a === FailAction.REPORT)        await reportSpam(client, userId);
    if (a === FailAction.MUTE)          await muteChat(client, userId);
    if (a === FailAction.ARCHIVE)       await archiveChat(client, userId);

  }
}

async function runPassActions(client: TelegramClient, userId: number) {
  for (const a of cfg.passActions()) {
    if (a === PassAction.UNMUTE)    await unmuteChat(client, userId);
    if (a === PassAction.UNARCHIVE) await unarchiveChat(client, userId);
  }
}

let _canvas: any = null;
let _canvasInstalling = false;

async function tryGetCanvas(): Promise<any> {
  if (_canvas !== null) return _canvas;

  try {
    _canvas = await import("canvas");
    log(LogLevel.INFO, "canvas module loaded");
    return _canvas;
  } catch {  }

  if (_canvasInstalling) {
    const deadline = Date.now() + 60_000;
    while (_canvasInstalling && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }
    return _canvas ?? false;
  }

  _canvasInstalling = true;
  log(LogLevel.INFO, "canvas not found — auto installing (npm install canvas)…");

  try {
    execSync("npm install canvas", { stdio: "pipe" });
    log(LogLevel.INFO, "canvas installed successfully");
  } catch (e) {
    log(LogLevel.ERROR, "canvas install failed", e);
    _canvas = false;
    _canvasInstalling = false;
    return false;
  }

  try {

    const canvasId = require.resolve("canvas");
    if (require.cache[canvasId]) delete require.cache[canvasId];
  } catch {  }

  try {
    _canvas = await import("canvas");
    log(LogLevel.INFO, "canvas dynamically loaded after install");
  } catch (e) {
    log(LogLevel.ERROR, "canvas load failed after install", e);
    _canvas = false;
  }

  _canvasInstalling = false;
  return _canvas ?? false;
}

async function generateImageCaptcha(
  digitOnly: boolean
): Promise<{ buffer: Buffer; answer: string } | null> {
  const cv = await tryGetCanvas();
  if (!cv) return null;

  const CHARSET_DIGIT = "0123456789";
  const CHARSET_MIXED = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  const charset = digitOnly ? CHARSET_DIGIT : CHARSET_MIXED;
  const LENGTH  = 5;

  let answer = "";
  for (let i = 0; i < LENGTH; i++) {
    answer += charset[Math.floor(Math.random() * charset.length)];
  }

  const W = 240, H = 90;
  const canvas = cv.createCanvas(W, H);
  const ctx    = canvas.getContext("2d") as CanvasRenderingContext2D;

  const rnd  = () => Math.random();
  const rndI = (min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min;

  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = `hsla(${rndI(0,360)},30%,${rndI(85,97)}%,0.9)`;
    ctx.fillRect(rndI(0, W), rndI(0, H), rndI(20, 80), rndI(20, 60));
  }

  ctx.strokeStyle = `rgba(180,180,200,0.35)`;
  ctx.lineWidth = 0.8;
  for (let x = 0; x < W; x += rndI(18, 28)) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += rndI(18, 28)) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.moveTo(0, rnd() * H);
    ctx.bezierCurveTo(
      W * 0.25, rnd() * H,
      W * 0.75, rnd() * H,
      W,        rnd() * H
    );
    ctx.strokeStyle = `hsla(${rndI(0,360)},55%,45%,${0.3 + rnd() * 0.3})`;
    ctx.lineWidth   = 1 + rnd();
    ctx.stroke();
  }

  for (let i = 0; i < 180; i++) {
    ctx.beginPath();
    ctx.arc(rnd() * W, rnd() * H, 0.8 + rnd() * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${rndI(0,360)},50%,35%,${0.4 + rnd() * 0.4})`;
    ctx.fill();
  }

  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = `hsla(${rndI(0,360)},60%,60%,0.15)`;
    ctx.fillRect(rnd() * W, rnd() * H, rndI(8, 30), rndI(4, 16));
  }

  const STEP = (W - 24) / LENGTH;
  for (let i = 0; i < LENGTH; i++) {
    const ch  = answer[i];
    const x   = 14 + i * STEP + STEP * 0.35;
    const y   = H / 2 + (rnd() - 0.5) * 18;
    const rot = (rnd() - 0.5) * 0.65;
    const sz  = 32 + rndI(0, 10);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.font         = `bold ${sz}px monospace`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";

    ctx.shadowColor   = `hsla(${rndI(0,360)},80%,50%,0.6)`;
    ctx.shadowBlur    = 4;
    ctx.strokeStyle   = `hsla(${rndI(0,360)},35%,85%,0.9)`;
    ctx.lineWidth     = 4;
    ctx.strokeText(ch, 0, 0);

    ctx.shadowBlur  = 0;
    ctx.fillStyle   = `hsl(${rndI(0,360)},70%,20%)`;
    ctx.fillText(ch, 0, 0);

    if (rnd() > 0.5) {
      ctx.strokeStyle = `hsla(${rndI(0,360)},60%,40%,0.5)`;
      ctx.lineWidth   = 1.5;
      const hw = sz * 0.35;
      ctx.beginPath();
      ctx.moveTo(-hw, (rnd() - 0.5) * sz * 0.4);
      ctx.lineTo( hw, (rnd() - 0.5) * sz * 0.4);
      ctx.stroke();
    }

    ctx.restore();
  }

  return { buffer: canvas.toBuffer("image/png"), answer };
}

interface CaptchaState {
  answer:      string;
  tries:       number;
  timer:       ReturnType<typeof setTimeout> | null;
  msgIds:      number[];
  mode:        CaptchaMode;
}

const states = new Map<number, CaptchaState>();

async function cleanupCaptchaMessages(client: TelegramClient, userId: number, state: CaptchaState) {
  for (const id of state.msgIds) {
    try { await client.deleteMessages(userId, [id], { revoke: false }); } catch {}
  }
}

function modeLabel(m: CaptchaMode): string {
  return {
    [CaptchaMode.MATH]:       "数学计算",
    [CaptchaMode.TEXT]:       "文字关键词",
    [CaptchaMode.IMG_DIGIT]:  "图片验证码（纯数字）",
    [CaptchaMode.IMG_MIXED]:  "图片验证码（字母+数字）",
  }[m] ?? m;
}

function mathQuestion(): { question: string; answer: string } {
  const rand  = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
  const type  = rand(0, 5);

  if (type === 0) {

    const a = rand(10, 99), b = rand(10, 99);
    return { question: `${a} + ${b}`, answer: String(a + b) };
  }
  if (type === 1) {

    const b = rand(10, 60), a = rand(b + 1, b + 60);
    return { question: `${a} - ${b}`, answer: String(a - b) };
  }
  if (type === 2) {

    const a = rand(2, 9), b = rand(11, 25);
    return { question: `${a} × ${b}`, answer: String(a * b) };
  }
  if (type === 3) {

    const divisor = rand(2, 12), quotient = rand(3, 15);
    const dividend = divisor * quotient;
    return { question: `${dividend} ÷ ${divisor}`, answer: String(quotient) };
  }
  if (type === 4) {

    const a = rand(2, 9), b = rand(2, 9), c = rand(1, 20);
    return { question: `${a} × ${b} + ${c}`, answer: String(a * b + c) };
  }

  const a = rand(2, 12);
  return { question: `${a}²`, answer: String(a * a) };
}

const TEXT_QA: { question: string; answer: string }[] = [
  { question: "天空是什么颜色？（中文）",           answer: "蓝色"   },
  { question: "一周有几天？（数字）",               answer: "7"      },
  { question: "一年有几个月？（数字）",             answer: "12"     },
  { question: "猫叫声是？（中文拟声词）",           answer: "喵"     },
  { question: "水的化学式是？",                    answer: "h2o"    },
  { question: "太阳从哪边升起？（东/西/南/北）",    answer: "东"     },
  { question: "地球上最大的洋是？（中文）",         answer: "太平洋" },
  { question: "1 + 1 等于几？（数字）",            answer: "2"      },
  { question: "中国的首都是哪个城市？（中文）",     answer: "北京"   },
  { question: "一天有多少小时？（数字）",           answer: "24"     },
  { question: "人有几根手指？（数字）",             answer: "10"     },
  { question: "苹果是什么颜色的？（中文，常见色）", answer: "红色"   },
  { question: "冰是什么状态的水？（固/液/气）",     answer: "固"     },
  { question: "地球围绕什么转？（中文）",           answer: "太阳"   },
  { question: "键盘上字母共有几个？（数字）",       answer: "26"     },
];

function textQuestion(): { question: string; answer: string } {
  return TEXT_QA[Math.floor(Math.random() * TEXT_QA.length)];
}

async function sendCaptcha(client: TelegramClient, userId: number): Promise<void> {

  const existing = states.get(userId);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    await cleanupCaptchaMessages(client, userId, existing);
    states.delete(userId);
  }

  const mode    = cfg.mode();
  const timeout = cfg.timeout();
  const tries   = cfg.maxTries();
  const actions = cfg.failActions();
  const custom  = cfg.prompt();

  const actionDesc = actions.length
    ? actions.map(a => FAIL_ACTION_LABEL[a] ?? a).join("、")
    : "仅归档并静音";

  function buildFooter(): string {
    const lines: string[] = [];
    if (timeout > 0) lines.push(`⏱ 验证时间：<b>${timeout}</b> 秒`);
    if (tries   > 0) lines.push(`🔢 剩余次数：<b>${tries}</b> 次`);
    lines.push(`⚠️ 验证失败将会：${actionDesc}`);
    return lines.length ? "\n\n" + lines.join("\n") : "";
  }

  let answer  = "";
  const msgIds: number[] = [];

  try {

    switch (mode) {

      case CaptchaMode.MATH: {
        const { question, answer: ans } = mathQuestion();
        answer = ans;
        const footer = buildFooter();
        const text = custom
          ? custom.replace("{question}", question)
          : `🔒 <b>人机验证</b>\n\n请回复以下算式的答案：\n\n<code>${question} = ?</code>${footer}`;
        const m = await client.sendMessage(userId, { message: text, parseMode: "html" });
        msgIds.push(m.id);
        break;
      }

      case CaptchaMode.TEXT: {
        const kw = cfg.keyword();
        const footer = buildFooter();

        if (kw === "我同意" && !custom) {
          const qa = textQuestion();
          answer   = qa.answer;
          const text = `🔒 <b>人机验证</b>\n\n请回答以下问题：\n\n<b>${qa.question}</b>${footer}`;
          const m = await client.sendMessage(userId, { message: text, parseMode: "html" });
          msgIds.push(m.id);
        } else {
          answer = kw;
          const text = custom
            ? custom.replace("{keyword}", kw)
            : `🔒 <b>人机验证</b>\n\n请回复以下关键词以证明你不是机器人：\n\n<code>${kw}</code>${footer}`;
          const m = await client.sendMessage(userId, { message: text, parseMode: "html" });
          msgIds.push(m.id);
        }
        break;
      }

      case CaptchaMode.IMG_DIGIT:
      case CaptchaMode.IMG_MIXED: {
        const digitOnly = mode === CaptchaMode.IMG_DIGIT;
        const img = await generateImageCaptcha(digitOnly);

        if (!img) {
          log(LogLevel.WARN, `canvas unavailable for user ${userId}, not switching mode`);
          try {
            await client.sendMessage(userId, {
              message: "❌ 验证服务暂时不可用，请稍后再试。"
            });
          } catch {}
          return;
        }

        answer = img.answer;
        const desc = digitOnly ? "5 位数字验证码" : "5 位验证码（字母与数字均为大写）";

        function buildImgCaption(): string {
          const lines: string[] = [`🔒 人机验证\n\n请输入图片中的${desc}`];
          if (timeout > 0) lines.push(`⏱ 验证时间：${timeout} 秒`);
          if (tries   > 0) lines.push(`🔢 剩余次数：${tries} 次`);
          lines.push(`⚠️ 验证失败将会：${actionDesc}`);
          return lines.join("\n");
        }

        const caption = custom || buildImgCaption();

        const photoMsg = await client.sendMessage(userId, {
          message: caption,
          file: new CustomFile("captcha.png", img.buffer.length, "", img.buffer)
        });
        msgIds.push(photoMsg.id);
        break;
      }

    }

    if (!answer) {
      log(LogLevel.WARN, `sendCaptcha: answer empty after switch (mode=${mode}), fallback to MATH`);
      const { question, answer: ans } = mathQuestion();
      answer = ans;
      const m = await client.sendMessage(userId, {
        message: `🔒 <b>人机验证</b>（降级）\n\n请回复以下算式的答案：\n\n<code>${question} = ?</code>`,
        parseMode: "html"
      });
      msgIds.push(m.id);
    }

    const state: CaptchaState = { answer, tries: 0, timer: null, msgIds, mode };

    if (timeout > 0) {
      state.timer = setTimeout(async () => {
        const st = states.get(userId);
        if (!st) return;
        states.delete(userId);
        log(LogLevel.INFO, `Captcha timed out: ${userId}`);
        const name = await getDisplayName(client, userId).catch(() => String(userId));
        rec.addFailed(userId, name, "timeout", usernameCache.get(userId));
        rec.delVerified(userId);
        await cleanupCaptchaMessages(client, userId, st);
        try {
          await client.sendMessage(userId, { message: "⏰ 验证超时，对话已被限制。", parseMode: "html" });
        } catch {}
        await runFailActions(client, userId);
      }, timeout * 1000);
    }

    states.set(userId, state);
    log(LogLevel.INFO, `Captcha sent (${mode}, timeout=${timeout}s) → user ${userId}`);

  } catch (e) {
    log(LogLevel.ERROR, `Failed to send captcha to ${userId}`, e);
  }
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

async function handleReply(client: TelegramClient, userId: number, input: string): Promise<void> {
  const state = states.get(userId);
  if (!state) return;

  if (!input.trim()) return;

  if (!state.answer) {
    log(LogLevel.WARN, `handleReply: empty answer for user ${userId}, treating as fail`);
    if (state.timer) clearTimeout(state.timer);
    states.delete(userId);
    await cleanupCaptchaMessages(client, userId, state);
    try { await client.sendMessage(userId, { message: "❌ 验证状态异常，请联系对方重置。", parseMode: "html" }); } catch {}
    return;
  }

  const isImgMode   = state.mode === CaptchaMode.IMG_DIGIT || state.mode === CaptchaMode.IMG_MIXED;
  const inputNorm   = input.trim().toUpperCase();
  const answerNorm  = state.answer.trim().toUpperCase();

  const correct = isImgMode
    ? levenshtein(inputNorm, answerNorm) <= 1
    : inputNorm === answerNorm;

  if (correct) {
    if (state.timer) clearTimeout(state.timer);
    states.delete(userId);

    await cleanupCaptchaMessages(client, userId, state);
    const name = await getDisplayName(client, userId).catch(() => String(userId));
    rec.addVerified(userId, name, usernameCache.get(userId));
    rec.delFailed(userId);
    log(LogLevel.INFO, `User ${userId} passed captcha`);
    await runPassActions(client, userId);
    try {
      await client.sendMessage(userId, { message: "✅ 验证通过！欢迎与我对话。", parseMode: "html" });
    } catch {}
    return;
  }

  state.tries++;
  const max       = cfg.maxTries();
  const remaining = max > 0 ? max - state.tries : Infinity;

  if (max > 0 && state.tries >= max) {
    if (state.timer) clearTimeout(state.timer);
    states.delete(userId);

    await cleanupCaptchaMessages(client, userId, state);
    const name = await getDisplayName(client, userId).catch(() => String(userId));
    rec.addFailed(userId, name, "max_tries", usernameCache.get(userId));
    rec.delVerified(userId);
    log(LogLevel.INFO, `User ${userId} failed captcha (max tries)`);
    try {
      await client.sendMessage(userId, { message: "❌ 验证失败次数过多，对话已被限制。", parseMode: "html" });
    } catch {}
    await runFailActions(client, userId);
  } else {
    const hint = remaining === Infinity ? "请重试。" : `请重试（剩余次数：${remaining}）`;
    try {
      await client.sendMessage(userId, { message: `❌ 答案错误，${hint}`, parseMode: "html" });
    } catch {}
  }
}

async function messageListener(message: Api.Message) {
  if (!(await waitDb())) return;
  try {
    const client = message.client as TelegramClient;
    if (!message.isPrivate)        return;
    if (!cfg.pluginOn())           return;
    if (message.out)               return;

    const userId = Number(message.senderId);
    if (!userId || userId <= 0)    return;

    const selfId = await getSelfId(client);
    if (selfId && userId === selfId) return;

    const sender = (message as any).sender ?? (message as any)._sender;
    if (sender) cacheUserFromSender(sender);

    const botFlag = sender ? isBotFromSender(sender) : await isBot(client, userId);
    if (botFlag) return;

    if (wl.has(userId)) return;

    if (states.has(userId)) {
      await handleReply(client, userId, message.text || "");
      return;
    }

    await archiveChat(client, userId);
    await muteChat(client, userId);
    if (cfg.captchaOn()) {
      await sendCaptcha(client, userId);
    }
  } catch (e) {
    log(LogLevel.ERROR, "Listener error", e);
  }
}

async function resolveUser(client: TelegramClient, arg: string): Promise<number | null> {

  if (/^\d+$/.test(arg)) {
    const id = parseInt(arg);

    fetchUserInfo(client, id).catch(() => {});
    return id > 0 ? id : null;
  }

  try {
    const username = arg.replace(/^@/, "");
    const res = await client.invoke(new Api.contacts.ResolveUsername({ username })) as any;
    const user = res?.users?.[0];
    if (user && !(user instanceof Api.UserEmpty)) {
      cacheUserFromSender(user);
      return Number(user.id);
    }
    return null;
  } catch { return null; }
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function helpText(): string {
  const p = mainPrefix;
  return `🔒 <b>PMCaptcha v${PLUGIN_VERSION}</b>

<b>基础</b>
  <code>${p}pmc on</code> / <code>off</code>  — 启用 / 禁用插件
  <code>${p}pmc status</code>     — 查看当前配置与统计

<b>验证开关与模式</b>
  <code>${p}pmc captcha on</code> / <code>off</code> — 开启 / 关闭验证功能（默认关闭）
  <code>${p}pmc captcha mode &lt;模式&gt;</code>
    └ <code>math</code>         数学计算题（默认）
    └ <code>text</code>         文字关键词回复
    └ <code>img_digit</code>    图片验证码（纯数字，自动安装 canvas）
    └ <code>img_mixed</code>    图片验证码（字母+数字，自动安装 canvas）

<b>参数设置</b>
  <code>${p}pmc set timeout &lt;秒&gt;</code>   — 验证超时（0=不限，默认 30）
  <code>${p}pmc set tries &lt;次&gt;</code>     — 最大尝试次数（0=不限，默认 3）
  <code>${p}pmc set keyword &lt;词&gt;</code>   — 文字模式关键词（默认"我同意"）
  <code>${p}pmc set prompt &lt;文本&gt;</code>  — 自定义验证提示语（留空=恢复默认）
    └ 占位符：math 模式用 <code>{question}</code>，text 模式用 <code>{keyword}</code>
  <code>${p}pmc set fail [操作…]</code> — 验证失败后的额外操作（可复选）
    └ <code>block</code> / <code>delete</code> / <code>delete_revoke</code> / <code>report</code> / <code>mute</code> / <code>archive</code> / <code>none</code>
  <code>${p}pmc set pass [操作…]</code> — 验证通过后的操作（可复选）
    └ <code>unmute</code> / <code>unarchive</code> / <code>none</code>

<b>白名单</b>
  <code>${p}pmc wl</code>                   — 查看白名单
  <code>${p}pmc wl add &lt;ID/@user&gt;</code>  — 手动加入（支持回复消息）
  <code>${p}pmc wl del &lt;ID/@user&gt;</code>  — 移除指定用户
  <code>${p}pmc wl del all</code>           — 清空白名单
  <code>${p}pmc wl pass &lt;ID/@user&gt;</code> — 手动标记为验证通过并加入白名单

<b>验证记录</b>
  <code>${p}pmc record</code>                              — 通过 / 失败摘要
  <code>${p}pmc record verified</code>                    — 查看通过记录
  <code>${p}pmc record failed</code>                      — 查看失败记录
  <code>${p}pmc record del verified &lt;ID&gt;/all</code>     — 删除通过记录
  <code>${p}pmc record del failed &lt;ID&gt;/all</code>       — 删除失败记录`;
}

const pmcaptcha = async (message: Api.Message) => {
  if (!(await waitDb())) return;
  const client  = message.client as TelegramClient;
  const args    = message.message.slice(1).split(/\s+/).slice(1);
  const command = (args[0] || "help").toLowerCase();

  if (command === "on" || command === "off") {
    set(K.ENABLED, command === "on");
    try {
      const tmp = await client.sendMessage(message.peerId, {
        message: command === "on" ? "✅ <b>PMCaptcha 已启用</b>" : "🚫 <b>PMCaptcha 已禁用</b>",
        parseMode: "html"
      });
      try { await message.delete(); } catch {}
      setTimeout(async () => { try { await tmp.delete(); } catch {} }, 3000);
    } catch (e) { log(LogLevel.ERROR, "pmc on/off error", e); }
    return;
  }

  const edit = async (text: string) => {
    try {
      await client.editMessage(message.peerId, {
        message:      message.id,
        text,
        parseMode:    "html",
        linkPreview:  false
      });
    } catch (e: any) {

      if (String(e).includes("Could not find the input entity")) {
        try { await message.reply({ message: text, parseMode: "html", linkPreview: false }); } catch {}
      } else {
        throw e;
      }
    }
  };

  try {
    switch (command) {

      case "help": case "h": case "?": case "":
        await edit(helpText());
        break;

      case "status": {
        const fa  = cfg.failActions();
        const pa  = cfg.passActions();
        const rawMode = get<string>(K.CAP_MODE, CaptchaMode.MATH);
        const modeInvalid = !(Object.values(CaptchaMode) as string[]).includes(rawMode);
        await edit(
          `📊 <b>PMCaptcha v${PLUGIN_VERSION}</b>\n\n` +
          `• 插件：${cfg.pluginOn() ? "✅ 启用" : "🚫 禁用"}\n` +
          `• 验证：${cfg.captchaOn() ? "✅ 开启" : "❌ 关闭（默认）"}\n` +
          `• 模式：${modeLabel(cfg.mode())}${modeInvalid ? " ⚠️ 原设置无效已自动降级" : ""}\n` +
          `• 超时：${cfg.timeout() > 0 ? cfg.timeout() + " 秒" : "不限"}\n` +
          `• 最大次数：${cfg.maxTries() > 0 ? cfg.maxTries() + " 次" : "不限"}\n` +
          `• 失败操作：${fa.length ? fa.map(a => FAIL_ACTION_LABEL[a] ?? a).join("、") : "仅归档静音"}\n` +
          `• 通过操作：${pa.length ? pa.map(a => PASS_ACTION_LABEL[a] ?? a).join("、") : "无"}\n` +
          `• 文字关键词：${cfg.keyword()}\n` +
          `• 白名单：${cfg.whitelist().length} 人\n` +
          `• 待验证：${states.size} 人\n` +
          `• 通过记录：${cfg.verified().length}\n` +
          `• 失败记录：${cfg.failed().length}\n` +
          `• 数据文件：<code>${path.join(dataDir, "pmcaptcha_data.json")}</code>`
        );
        break;
      }

      case "captcha": {
        const sub = args[1]?.toLowerCase();

        if (sub === "on" || sub === "off") {
          set(K.CAP_ENABLED, sub === "on");
          await edit(sub === "on" ? "✅ 验证功能已开启" : "❌ 验证功能已关闭");
          break;
        }

        if (sub === "mode") {
          const m = args[2]?.toLowerCase();
          const validModes = Object.values(CaptchaMode);
          if (!m || !validModes.includes(m as CaptchaMode)) {
            const current = cfg.mode();
            await edit(
              `当前模式：<b>${modeLabel(current)}</b>（<code>${current}</code>）\n\n` +
              `可用模式：\n` +
              `<code>math</code>      — 数学计算题（默认）\n` +
              `<code>text</code>      — 文字关键词回复\n` +
              `<code>img_digit</code> — 图片验证码（纯数字）\n` +
              `<code>img_mixed</code> — 图片验证码（字母+数字）\n\n` +
              `用法：<code>${mainPrefix}pmc captcha mode &lt;模式&gt;</code>`
            );
            break;
          }
          set(K.CAP_MODE, m);
          await edit(`✅ 验证模式：<b>${modeLabel(m as CaptchaMode)}</b>`);
          break;
        }

        await edit(
          `验证功能：${cfg.captchaOn() ? "✅ 开启" : "❌ 关闭"}\n` +
          `当前模式：<b>${modeLabel(cfg.mode())}</b>\n\n` +
          `<code>${mainPrefix}pmc captcha on/off</code>        — 开关验证\n` +
          `<code>${mainPrefix}pmc captcha mode &lt;模式&gt;</code> — 切换模式`
        );
        break;
      }

      case "set": {
        const param = args[1]?.toLowerCase();
        const val   = args.slice(2).join(" ").trim();

        if (!param) {
          await edit(
            `❌ 用法：<code>${mainPrefix}pmc set &lt;参数&gt; &lt;值&gt;</code>\n\n` +
            `可设置参数：\n` +
            `<code>timeout</code>  — 验证超时秒数（0=不限，默认 30）\n` +
            `<code>tries</code>    — 最大尝试次数（0=不限，默认 3）\n` +
            `<code>keyword</code>  — 文字模式关键词\n` +
            `<code>prompt</code>   — 自定义提示语（留空恢复默认）\n` +
            `<code>fail</code>     — 失败操作（block/delete/delete_revoke/report/mute/archive/none）\n` +
            `<code>pass</code>     — 通过操作（unmute/unarchive/none）`
          );
          break;
        }

        switch (param) {

          case "timeout": {
            const n = parseInt(val);
            if (isNaN(n) || n < 0) {
              await edit(`❌ 用法：<code>${mainPrefix}pmc set timeout &lt;秒&gt;</code>（0 = 不限时）`);
              break;
            }
            set(K.CAP_TIMEOUT, n);
            await edit(`✅ 验证超时：<b>${n > 0 ? n + " 秒" : "不限"}</b>`);
            break;
          }

          case "tries": {
            const n = parseInt(val);
            if (isNaN(n) || n < 0) {
              await edit(`❌ 用法：<code>${mainPrefix}pmc set tries &lt;次&gt;</code>（0 = 不限次数）`);
              break;
            }
            set(K.CAP_TRIES, n);
            await edit(`✅ 最大尝试次数：<b>${n > 0 ? n + " 次" : "不限"}</b>`);
            break;
          }

          case "keyword": {
            if (!val) {
              await edit(`❌ 用法：<code>${mainPrefix}pmc set keyword &lt;关键词&gt;</code>`);
              break;
            }
            set(K.CAP_KEYWORD, val);
            await edit(`✅ 文字关键词：<code>${val}</code>`);
            break;
          }

          case "prompt": {
            set(K.CAP_PROMPT, val);
            await edit(val
              ? `✅ 自定义提示语已设置\n占位符：math 模式用 <code>{question}</code>，text 模式用 <code>{keyword}</code>`
              : "✅ 提示语已恢复默认");
            break;
          }

          case "fail": {
            const subs = args.slice(2).map(s => s.toLowerCase()).filter(Boolean);
            if (!subs.length) {
              await edit(
                `❌ 用法：<code>${mainPrefix}pmc set fail &lt;操作…&gt;</code>\n\n` +
                `可选操作（可复选，空格分隔）：\n` +
                `<code>block</code>         — 屏蔽用户\n` +
                `<code>delete</code>        — 删除对话记录（己方）\n` +
                `<code>delete_revoke</code> — 删除对话记录（双端撤回）\n` +
                `<code>report</code>        — 举报为垃圾信息\n` +
                `<code>mute</code>          — 永久静音（失败时默认已执行）\n` +
                `<code>archive</code>       — 归档（失败时默认已执行）\n` +
                `<code>none</code>          — 清除所有额外操作`
              );
              break;
            }
            if (subs.includes("none")) {
              set(K.CAP_ACTIONS, []);
              await edit("✅ 失败额外操作已清除（仅归档静音）");
              break;
            }
            const validVals = Object.values(FailAction) as string[];
            const valid: FailAction[] = [];
            const bad: string[]       = [];
            for (const s of subs) {
              if (validVals.includes(s)) valid.push(s as FailAction);
              else bad.push(s);
            }
            if (bad.length) {
              await edit(`❌ 无效操作：<code>${bad.join("、")}</code>`);
              break;
            }
            set(K.CAP_ACTIONS, valid);
            await edit(`✅ 验证失败将执行：<b>${valid.map(a => FAIL_ACTION_LABEL[a] ?? a).join("、")}</b>`);
            break;
          }

          case "pass": {
            const subs = args.slice(2).map(s => s.toLowerCase()).filter(Boolean);
            if (!subs.length) {
              await edit(
                `❌ 用法：<code>${mainPrefix}pmc set pass &lt;操作…&gt;</code>\n\n` +
                `可选操作（可复选）：\n` +
                `<code>unmute</code>    — 验证通过后取消静音\n` +
                `<code>unarchive</code> — 验证通过后取消归档\n` +
                `<code>none</code>      — 清除所有通过操作`
              );
              break;
            }
            if (subs.includes("none")) {
              set(K.CAP_PASS_ACTIONS, []);
              await edit("✅ 通过操作已清除");
              break;
            }
            const validVals = Object.values(PassAction) as string[];
            const valid: PassAction[] = [];
            const bad: string[]       = [];
            for (const s of subs) {
              if (validVals.includes(s)) valid.push(s as PassAction);
              else bad.push(s);
            }
            if (bad.length) {
              await edit(`❌ 无效操作：<code>${bad.join("、")}</code>`);
              break;
            }
            set(K.CAP_PASS_ACTIONS, valid);
            await edit(`✅ 验证通过后将执行：<b>${valid.map(a => PASS_ACTION_LABEL[a] ?? a).join("、")}</b>`);
            break;
          }

          case "ext-timeout": case "exttimeout":
            await edit(`❌ ext-timeout 已移除，请使用 <code>${mainPrefix}pmc set timeout</code>`);
            break;
          case "google-url": case "googleurl":
          case "cf-url":     case "cfurl":
          case "google-port": case "googleport":
          case "cf-port":    case "cfport":
          case "google-secret": case "googlesecret":
          case "cf-secret":  case "cfsecret":
          case "webhook-secret": case "webhooksecret":
          case "url":
            await edit("❌ Google / Cloudflare 验证功能已移除，此参数无效。");
            break;

          default:
            await edit(
              `❌ 未知参数：<code>${param}</code>\n\n` +
              `可设置：<code>timeout</code>、<code>tries</code>、<code>keyword</code>、<code>prompt</code>、<code>fail</code>、<code>pass</code>`
            );
        }
        break;
      }

      case "wl":
      case "whitelist": {
        const sub = args[1]?.toLowerCase();

        if (!sub) {
          const list = cfg.whitelist();
          if (!list.length) { await edit("📋 <b>白名单为空</b>"); break; }
          const items = await Promise.all(list.map(async id => {
            const name = await getDisplayName(client, id);
            return `• ${userLink(id, name)}`;
          }));
          await edit(`📋 <b>白名单 (${list.length})</b>\n\n${items.join("\n")}`);
          break;
        }

        if (sub === "add") {
          let tid: number | null = null;
          if (message.replyTo?.replyToMsgId) {
            try {
              const r = await client.getMessages(message.peerId, { ids: [message.replyTo.replyToMsgId] });
              if (r[0]?.senderId) tid = Number(r[0].senderId);
            } catch {}
          }
          if (!tid && args[2]) tid = await resolveUser(client, args[2]);
          if (!tid || tid <= 0) { await edit("❌ 请提供有效的用户 ID / 用户名，或回复用户消息"); break; }
          if (await isBot(client, tid)) { await edit("❌ 无法将机器人加入白名单"); break; }
          wl.add(tid);
          const name = await getDisplayName(client, tid);
          await edit(`✅ ${userLink(tid, name)} 已加入白名单`);
          break;
        }

        if (sub === "del") {
          if (args[2]?.toLowerCase() === "all") {
            wl.clear();
            await edit("✅ 白名单已清空");
            break;
          }
          if (!args[2]) { await edit(`❌ 用法：<code>${mainPrefix}pmc wl del &lt;ID/@user&gt;</code> 或 <code>del all</code>`); break; }
          const tid = await resolveUser(client, args[2]);
          if (!tid || tid <= 0) { await edit("❌ 无法解析目标用户"); break; }
          wl.del(tid);
          const delName = await getDisplayName(client, tid);
          await edit(`✅ ${userLink(tid, delName)} 已从白名单移除`);
          break;
        }

        if (sub === "pass") {
          if (!args[2]) { await edit(`❌ 用法：<code>${mainPrefix}pmc wl pass &lt;ID/@user&gt;</code>`); break; }
          const tid = await resolveUser(client, args[2]);
          if (!tid || tid <= 0) { await edit("❌ 无法解析目标用户"); break; }
          const st = states.get(tid);
          if (st?.timer) clearTimeout(st.timer);
          if (st) await cleanupCaptchaMessages(client, tid, st);
          states.delete(tid);
          wl.add(tid);
          const name = await getDisplayName(client, tid);
          rec.addVerified(tid, name, usernameCache.get(tid));
          rec.delFailed(tid);
          await edit(`✅ ${userLink(tid, name)} 已手动通过验证并加入白名单`);
          break;
        }

        await edit(
          `❌ 未知子命令：<code>${sub}</code>\n\n` +
          `可用：\n` +
          `<code>${mainPrefix}pmc wl</code>               — 查看白名单\n` +
          `<code>${mainPrefix}pmc wl add &lt;ID/@user&gt;</code> — 加入白名单\n` +
          `<code>${mainPrefix}pmc wl del &lt;ID/@user&gt;</code> — 移除用户\n` +
          `<code>${mainPrefix}pmc wl del all</code>       — 清空白名单\n` +
          `<code>${mainPrefix}pmc wl pass &lt;ID/@user&gt;</code> — 手动标记通过`
        );
        break;
      }

      case "record": {

        const sub  = args[1]?.toLowerCase();
        const sub2 = args[2]?.toLowerCase();
        const sub3 = args[3]?.toLowerCase();

        const rLbl: Record<FailedRecord["reason"], string> = {
          timeout:   "⏰ 超时",
          max_tries: "❌ 次数耗尽"
        };

        if (!sub) {
          const vList = cfg.verified();
          const fList = cfg.failed();
          await edit(
            `📋 <b>验证记录摘要</b>\n\n` +
            `✅ 通过：<b>${vList.length}</b> 人\n` +
            `❌ 失败：<b>${fList.length}</b> 人\n\n` +
            `使用 <code>${mainPrefix}pmc record verified</code> / <code>failed</code> 查看详情`
          );
          break;
        }

        if (sub === "del") {
          const target = sub2;
          if (target !== "verified" && target !== "failed") {
            await edit(`❌ 用法：<code>${mainPrefix}pmc record del verified/failed [&lt;ID&gt;/all]</code>`);
            break;
          }
          const isV = target === "verified";
          if (!sub3 || sub3 === "all") {
            if (sub3 === "all") {
              isV ? rec.clearVerified() : rec.clearFailed();
              await edit(`✅ 所有${isV ? "通过" : "失败"}记录已清空`);
            } else {
              await edit(`❌ 用法：<code>${mainPrefix}pmc record del ${target} &lt;ID&gt;/all</code>`);
            }
            break;
          }
          const delId = parseInt(sub3);
          if (isNaN(delId) || delId <= 0) {
            await edit(`❌ 无效 ID：<code>${sub3}</code>`);
            break;
          }
          isV ? rec.delVerified(delId) : rec.delFailed(delId);
          await edit(`✅ 用户 <a href="tg://user?id=${delId}">${delId}</a> 的${isV ? "通过" : "失败"}记录已删除`);
          break;
        }

        if (sub === "verified") {
          const list = cfg.verified();
          if (!list.length) { await edit("📋 <b>验证通过记录为空</b>"); break; }
          const items = await Promise.all(list.map(async r => {
            if (r.username) usernameCache.set(r.id, r.username);
            const name = await getDisplayName(client, r.id).catch(() => r.name);
            return `• ${userLink(r.id, name)}\n  <i>${fmtTime(r.time)}</i>`;
          }));
          await edit(`✅ <b>验证通过 (${list.length})</b>\n\n${items.join("\n\n")}`);
          break;
        }

        if (sub === "failed") {
          const list = cfg.failed();
          if (!list.length) { await edit("📋 <b>验证失败记录为空</b>"); break; }
          const items = await Promise.all(list.map(async r => {
            if (r.username) usernameCache.set(r.id, r.username);
            const name = await getDisplayName(client, r.id).catch(() => r.name);
            return `• ${userLink(r.id, name)} — ${rLbl[r.reason]}\n  <i>${fmtTime(r.time)}</i>`;
          }));
          await edit(`❌ <b>验证失败 (${list.length})</b>\n\n${items.join("\n\n")}`);
          break;
        }

        await edit(
          `❌ 未知子命令：<code>${sub}</code>\n\n` +
          `可用：\n` +
          `<code>${mainPrefix}pmc record</code>                             — 摘要\n` +
          `<code>${mainPrefix}pmc record verified</code>                   — 通过列表\n` +
          `<code>${mainPrefix}pmc record failed</code>                     — 失败列表\n` +
          `<code>${mainPrefix}pmc record del verified &lt;ID&gt;/all</code>  — 删除通过记录\n` +
          `<code>${mainPrefix}pmc record del failed &lt;ID&gt;/all</code>    — 删除失败记录`
        );
        break;
      }

      default:
        await edit(`❌ 未知命令：<code>${command}</code>\n\n使用 <code>${mainPrefix}pmc help</code> 查看帮助`);
    }
  } catch (e) {
    log(LogLevel.ERROR, "Command error", e);
    try { await edit(`❌ 命令执行失败: ${e}`); } catch {}
  }
};

const pmc = pmcaptcha;

class PMCaptchaPlugin extends Plugin {
  name        = "pmcaptcha";
  description = `🔒 PMCaptcha v${PLUGIN_VERSION} - 陌生人私聊人机验证`;
  cmdHandlers = { pmc, pmcaptcha };
  listenMessageHandler = messageListener;
}

const plugin = new PMCaptchaPlugin();
export default plugin;
ha已启用</b>\n\n陌生人私聊将被归档并静音"
      : "🚫 <b>PMCaptcha已禁用</b>";

    try {
      const tempMsg = await client.sendMessage(message.peerId, {
        message: statusText,
        parseMode: "html",
      });

      await message.delete();

      setTimeout(async () => {
        try {
          await tempMsg.delete();
        } catch (e) {
        }
      }, 3000);

    } catch (error) {
      console.error(`[PMCaptcha] Failed to execute pmc command:`, error);
    }
    return;
  }
  
  return pmcaptcha(message);
};

/**
 * 辅助函数：根据用户名解析用户ID
 * 支持 @username 或 username 格式
 */
async function resolveUsernameToId(client: TelegramClient, username: string): Promise<number | null> {
  try {
    const cleanUsername = username.replace(/^@/, '');
    const entity = await client.getEntity(cleanUsername);
    if (entity && 'id' in entity) {
      return Number(entity.id);
    }
    return null;
  } catch (error) {
    log(LogLevel.ERROR, `Failed to resolve username ${username}`, error);
    return null;
  }
}

const pmcaptcha = async (message: Api.Message) => {
  if (!(await waitForConfigDb())) {
    console.error("[PMCaptcha] Config DB not ready, skipping command.");
    return;
  }
  const client = message.client as TelegramClient;
  const args = message.message.slice(1).split(" ").slice(1);
  const command = args[0] || "help";

  try {
    switch (command.toLowerCase()) {
      case "help":
      case "h":
      case "?":
      case "":
        await client.editMessage(message.peerId, {
          message: message.id,
          text: help_text,
          parseMode: "html",
        });
        break;

      case "add":
      case "whitelist":
      case "+":
        let targetUserId: number | null = null;

        if (message.replyTo && message.replyTo.replyToMsgId) {
          try {
            const repliedMessage = await client.getMessages(message.peerId, {
              ids: [message.replyTo.replyToMsgId],
            });
            if (repliedMessage[0] && repliedMessage[0].senderId) {
              targetUserId = Number(repliedMessage[0].senderId);
            }
          } catch (e) {
            console.error("[PMCaptcha] Error getting replied message:", e);
          }
        }

        if (!targetUserId && args[1]) {
          const arg = args[1];
          if (/^\d+$/.test(arg)) {
            targetUserId = parseInt(arg);
          } else {
            targetUserId = await resolveUsernameToId(client, arg);
          }
        }

        if (!targetUserId) {
          targetUserId = Number(message.senderId);
        }

        if (!targetUserId || targetUserId <= 0) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: "❌ 无法解析目标用户，请提供有效的用户ID、用户名或回复用户消息",
            parseMode: "html",
          });
          break;
        }

        const isBot = await isUserBot(client, targetUserId);
        if (isBot) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `❌ 无法添加机器人到白名单：<a href="tg://user?id=${targetUserId}">${targetUserId}</a>`,
            parseMode: "html",
          });
          break;
        }

        dbHelpers.addToWhitelist(targetUserId);

        const displayName = await getUserDisplayName(client, targetUserId);
        await client.editMessage(message.peerId, {
          message: message.id,
          text: `✅ 用户 <a href="tg://user?id=${targetUserId}">${displayName} (${targetUserId})</a> 已添加到白名单`,
          parseMode: "html",
        });
        break;

      case "del":
      case "remove":
      case "rm":
      case "-":
        if (args[1] && args[1].toLowerCase() === "all") {
          dbHelpers.clearWhitelist();
          await client.editMessage(message.peerId, {
            message: message.id,
            text: "✅ 所有白名单已清空",
            parseMode: "html",
          });
          break;
        }

        if (!args[1]) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: "❌ 请提供要移除的用户ID或用户名，或使用 `del all` 清空白名单",
            parseMode: "html",
          });
          break;
        }

        let delUserId: number | null = null;
        const delArg = args[1];

        if (/^\d+$/.test(delArg)) {
          delUserId = parseInt(delArg);
        } else {
          delUserId = await resolveUsernameToId(client, delArg);
        }

        if (!delUserId || delUserId <= 0) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: "❌ 无法解析目标用户，请提供有效的用户ID或用户名",
            parseMode: "html",
          });
          break;
        }

        dbHelpers.removeFromWhitelist(delUserId);

        await client.editMessage(message.peerId, {
          message: message.id,
          text: `✅ 用户 <a href="tg://user?id=${delUserId}">${delUserId}</a> 已从白名单移除`,
          parseMode: "html",
        });
        break;

      case "list":
      case "ls":
        const whitelist = dbHelpers.getSetting(CONFIG_KEYS.WHITELIST, []) as number[];
        
        if (whitelist.length === 0) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: "📋 <b>白名单为空</b>",
            parseMode: "html",
          });
          break;
        }

        const listItems = await Promise.all(
          whitelist.map(async (id) => {
            const displayName = await getUserDisplayName(client, id);
            return `• <a href="tg://user?id=${id}">${displayName} (${id})</a>`;
          })
        );
        
        await client.editMessage(message.peerId, {
          message: message.id,
          text: `📋 <b>白名单用户 (${whitelist.length})</b>\n\n${listItems.join("\n")}`,
          parseMode: "html",
        });
        break;

      default:
        await client.editMessage(message.peerId, {
          message: message.id,
          text: `❌ 未知命令: <code>${command}</code>\n\n使用 <code>${mainPrefix}pmc help</code> 查看帮助`,
          parseMode: "html",
        });
        break;
    }
  } catch (error) {
    console.error("[PMCaptcha] Command error:", error);
    try {
      await client.editMessage(message.peerId, {
        message: message.id,
        text: `❌ 命令执行失败: ${error}`,
        parseMode: "html",
      });
    } catch (e) {
    }
  }
};

class PMCaptchaPlugin extends Plugin {
  name = "pmcaptcha";
  description = `🔒 PMCaptcha v${PLUGIN_VERSION} - 自动归档并静音陌生人私聊`;
  
  cmdHandlers = {
    pmc: pmc,
    pmcaptcha: pmcaptcha
  };
  
  listenMessageHandler = pmcaptchaMessageListener;
}

const plugin = new PMCaptchaPlugin();

export default plugin;

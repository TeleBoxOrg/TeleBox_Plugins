/**
 * TeleBox AI 插件（完美整合版）
 * 兼容 OpenAI / Gemini / Claude / 火山 等标准接口
 * 功能：对话、搜索、识图、生图、TTS、语音回答、全局 Prompt 预设、上下文记忆、 Telegraph 长文等
 * 用法：.ai  或  .ai chat|search|image|tts|audio|searchaudio|prompt|config|model|...
 * 2025-05 最终优化版
 */
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs";
import sharp from "sharp";
import { createDirectoryInAssets } from "@utils/pathHelpers";

/* ---------- 类型定义 ---------- */
type Provider = {
  apiKey: string;
  baseUrl: string;
  compatauth?: Compat;
  authMethod?: AuthMethod;
  authConfig?: AuthConfig;
};
type Compat = "openai" | "gemini" | "claude";
type Models = { chat: string; search: string; image: string; tts: string };
type Telegraph = {
  enabled: boolean;
  limit: number;
  token: string;
  posts: { title: string; url: string; createdAt: string }[];
};
type VoiceConfig = { gemini: string; openai: string };
type DB = {
  dataVersion?: number;
  providers: Record<string, Provider>;
  modelCompat?: Record<string, Record<string, Compat>>;
  modelCatalog?: { map: Record<string, Compat>; updatedAt?: string };
  models: Models;
  contextEnabled: boolean;
  collapse: boolean;
  telegraph: Telegraph;
  voices?: VoiceConfig;
  histories: Record<string, { role: string; content: string }[]>;
  histMeta?: Record<string, { lastAt: string }>;
  presetPrompt?: string; // 全局 Prompt 预设
  timeout?: number; // 全局超时时间（毫秒）
  maxTokens?: number; // 最大输出 token 数
  linkPreview?: boolean; // 链接即时预览开关

};

/* ---------- 常量 ---------- */
const MAX_MSG = 4096;
const PAGE_EXTRA = 48;
const WRAP_EXTRA_COLLAPSED = 64;
const HISTORY_MAX_ITEMS = 50;
const HISTORY_MAX_BYTES = 64 * 1024;
const MODEL_REFRESH_DEBOUNCE_MS = 2000;
const DEFAULT_TIMEOUT_MS = 30000; // 默认超时 30 秒
const MAX_TIMEOUT_MS = 600000; // 最大超时 10 分钟
const DEFAULT_MAX_TOKENS = 16384; // 默认最大输出 token（约8000中文字）
const GEMINI_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafar"
] as const;
const OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;

/* ---------- 工具函数 ---------- */
// 动态获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const trimBase = (u: string) => u.replace(/\/$/, "");
const html = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const shortenUrlForDisplay = (u: string) => {
  try {
    const url = new URL(u);
    const host = url.hostname;
    const path = url.pathname && url.pathname !== "/" ? url.pathname : "";
    let text = host + path;
    if (text.length > 60) text = text.slice(0, 45) + "…" + text.slice(-10);
    return text || u;
  } catch {
    return u.length > 60 ? u.slice(0, 45) + "…" + u.slice(-10) : u;
  }
};
const nowISO = () => new Date().toISOString();
const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
const shouldRetry = (err: any): boolean => {
  const s = err?.response?.status;
  const code = err?.code;
  return (
    s === 429 || s === 500 || s === 502 || s === 503 || s === 504 ||
    code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" ||
    !!(err?.isAxiosError && !err?.response)
  );
};
const axiosWithRetry = async <T = any>(
  config: AxiosRequestConfig,
  tries = 2,
  backoffMs = 500
): Promise<AxiosResponse<T>> => {
  let attempt = 0;
  let lastErr: any;
  const configuredTimeout = Store.data.timeout || DEFAULT_TIMEOUT_MS;
  while (attempt <= tries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), configuredTimeout);
    try {
      const baseConfig: AxiosRequestConfig = {
        timeout: configuredTimeout,
        signal: controller.signal,
        ...config
      };
      const result = await axios(baseConfig);
      clearTimeout(timeoutId);
      return result;
    } catch (err: any) {
      clearTimeout(timeoutId);
      lastErr = err;
      if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') {
        throw new Error(`请求超时（${configuredTimeout / 1000}秒）`);
      }
      if (attempt >= tries || !shouldRetry(err)) throw err;
      const jitter = Math.floor(Math.random() * 200);
      await sleep(backoffMs * Math.pow(2, attempt) + jitter);
      attempt++;
    }
  }
  throw lastErr;
};

/* ---------- 原子 JSON 写入 ---------- */
const atomicWriteJSON = async (file: string, data: any) => {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.promises.rename(tmp, file);
};

/* ---------- 通用鉴权 ---------- */
enum AuthMethod {
  BEARER_TOKEN = "bearer_token",
  API_KEY_HEADER = "api_key_header",
  QUERY_PARAM = "query_param",
  BASIC_AUTH = "basic_auth",
  CUSTOM_HEADER = "custom_header"
}
interface AuthConfig {
  method: AuthMethod;
  apiKey: string;
  headerName?: string;
  paramName?: string;
  username?: string;
  password?: string;
}
class UniversalAuthHandler {
  static buildAuthHeaders(config: AuthConfig): Record<string, string> {
    const headers: Record<string, string> = {};
    switch (config.method) {
      case AuthMethod.BEARER_TOKEN:
        headers["Authorization"] = `Bearer ${config.apiKey}`;
        break;
      case AuthMethod.API_KEY_HEADER:
        headers[config.headerName || "X-API-Key"] = config.apiKey;
        break;
      case AuthMethod.CUSTOM_HEADER:
        if (config.headerName) headers[config.headerName] = config.apiKey;
        break;
      case AuthMethod.BASIC_AUTH:
        headers["Authorization"] = `Basic ${Buffer.from(
          `${config.username || config.apiKey}:${config.password || ""}`
        ).toString("base64")}`;
        break;
    }
    return headers;
  }
  static buildAuthParams(config: AuthConfig): Record<string, string> {
    const params: Record<string, string> = {};
    if (config.method === AuthMethod.QUERY_PARAM) {
      params[config.paramName || "key"] = config.apiKey;
    }
    return params;
  }
  static detectAuthMethod(baseUrl: string): AuthMethod {
    const url = baseUrl.toLowerCase();
    if (url.includes("generativelanguage.googleapis.com") || url.includes("aiplatform.googleapis.com"))
      return AuthMethod.QUERY_PARAM;
    if (url.includes("anthropic.com")) return AuthMethod.API_KEY_HEADER;
    if (url.includes("aip.baidubce.com")) return AuthMethod.QUERY_PARAM;
    return AuthMethod.BEARER_TOKEN;
  }
}

/* ---------- 统一鉴权构建 ---------- */
const buildAuthAttempts = (p: Provider, extraHeaders: Record<string, string> = {}) => {
  if (p.authConfig) {
    const headers = { ...UniversalAuthHandler.buildAuthHeaders(p.authConfig), ...extraHeaders };
    const params = { ...UniversalAuthHandler.buildAuthParams(p.authConfig) };
    return [{ headers, params }];
  }
  const detected = UniversalAuthHandler.detectAuthMethod(p.baseUrl);
  const cfg: AuthConfig = {
    method: detected,
    apiKey: p.apiKey,
    headerName: detected === AuthMethod.API_KEY_HEADER ? "x-api-key" : undefined,
    paramName: detected === AuthMethod.QUERY_PARAM ? "key" : undefined
  };
  const headers = { ...UniversalAuthHandler.buildAuthHeaders(cfg), ...extraHeaders };
  const params = { ...UniversalAuthHandler.buildAuthParams(cfg) };
  return [{ headers, params }];
};
const tryPostJSON = async (url: string, body: any, attempts: Array<{ headers?: any; params?: any }>) => {
  let lastErr: any;
  for (const a of attempts) {
    try {
      const r = await axiosWithRetry({ method: "POST", url, data: body, ...(a || {}) });
      return r.data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
};

/* ---------- lowdb 封装 ---------- */
class Store {
  static db: any = null;
  static data: DB = {
    providers: {},
    models: { chat: "", search: "", image: "", tts: "" },
    contextEnabled: false,
    collapse: false,
    telegraph: { enabled: false, limit: 0, token: "", posts: [] },
    voices: { gemini: "Kore", openai: "alloy" },
    histories: {},
    presetPrompt: "",
    timeout: DEFAULT_TIMEOUT_MS
  };
  static baseDir = "";
  static file = "";
  static async init() {
    if (this.db) return;
    this.baseDir = createDirectoryInAssets("ai");
    this.file = path.join(this.baseDir, "config.json");
    this.db = await JSONFilePreset<DB>(this.file, this.data);
    this.data = this.db.data;
    const d: any = this.data;
    // 默认值填充
    const defaults: Record<string, any> = {
      dataVersion: 5, providers: {}, modelCompat: {}, modelCatalog: { map: {}, updatedAt: undefined },
      models: { chat: "", search: "", image: "", tts: "" }, contextEnabled: false, collapse: false,
      telegraph: { enabled: false, limit: 0, token: "", posts: [] }, voices: { gemini: "Kore", openai: "alloy" },
      histories: {}, histMeta: {}, presetPrompt: "", timeout: DEFAULT_TIMEOUT_MS, maxTokens: DEFAULT_MAX_TOKENS
    };
    for (const [k, v] of Object.entries(defaults)) if (d[k] === undefined || d[k] === null) d[k] = v;
    if (d.dataVersion < 3) { try { await refreshModelCatalog(true); } catch { } d.dataVersion = 5; }
    // 确保超时值在有效范围内
    if (d.timeout > MAX_TIMEOUT_MS) d.timeout = MAX_TIMEOUT_MS;
    if (d.timeout < 10000) d.timeout = DEFAULT_TIMEOUT_MS;
    await this.writeSoon();
  }
  static async write() { await atomicWriteJSON(this.file, this.data); }
  static writeSoonDelay = 300;
  static _writeTimer: NodeJS.Timeout | null = null;
  static async writeSoon(): Promise<void> {
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(async () => {
      try { await atomicWriteJSON(this.file, this.data); } finally { this._writeTimer = null; }
    }, this.writeSoonDelay);
    return Promise.resolve();
  }
}

/* ---------- 消息分片 & 折叠 ---------- */
const applyWrap = (s: string, collapse?: boolean) => {
  if (!collapse) return s;
  if (/<blockquote(?:\s|>|\/)\/?>/i.test(s)) return s;
  return `<span class="tg-spoiler">${s}</span>`;
};
const buildChunks = (text: string, collapse?: boolean, postfix?: string) => {
  const WRAP_EXTRA = collapse ? WRAP_EXTRA_COLLAPSED : 0;
  const parts = splitMessage(text, PAGE_EXTRA + WRAP_EXTRA);
  if (parts.length === 0) return [];
  if (parts.length === 1) return [applyWrap(parts[0], collapse) + (postfix || "")];
  const total = parts.length;
  const chunks: string[] = [];
  for (let i = 0; i < total; i++) {
    const isLast = i === total - 1;
    const header = `📄 (${i + 1}/${total})\n\n`;
    const body = header + parts[i];
    const wrapped = applyWrap(body, collapse) + (isLast ? (postfix || "") : "");
    chunks.push(wrapped);
  }
  return chunks;
};
const sendLong = async (msg: Api.Message, text: string, opts?: { collapse?: boolean }, postfix?: string) => {
  const chunks = buildChunks(text, opts?.collapse, postfix);
  if (chunks.length === 0) return;
  if (chunks.length === 1) { await msg.edit({ text: chunks[0], parseMode: "html" }); return; }
  await msg.edit({ text: chunks[0], parseMode: "html" });
  if (msg.client) {
    const peer = msg.peerId;
    for (let i = 1; i < chunks.length; i++) await msg.client.sendMessage(peer, { message: chunks[i], parseMode: "html" });
  } else {
    for (let i = 1; i < chunks.length; i++) await msg.reply({ message: chunks[i], parseMode: "html" });
  }
};
const sendLongReply = async (msg: Api.Message, replyToId: number, text: string, opts?: { collapse?: boolean }, postfix?: string) => {
  const chunks = buildChunks(text, opts?.collapse, postfix);
  if (!msg.client) return;
  const peer = msg.peerId;
  for (const chunk of chunks) await msg.client.sendMessage(peer, { message: chunk, parseMode: "html", replyTo: replyToId });
};
const extractText = (m: Api.Message | null | undefined) => {
  if (!m) return "";
  const anyM: any = m;
  return (anyM.message || anyM.text || anyM.caption || "");
};
/**
 * 提取引用文本或被回复消息的文本
 * 优先级：1. 引用文本 (quoteText) 2. 被回复消息的内容
 * @param msg 当前消息
 * @param replyMsg 被回复的消息（通过 getReplyMessage 获取）
 * @returns 引用文本或被回复消息的文本
 */
const extractQuoteOrReplyText = (msg: Api.Message, replyMsg: Api.Message | null | undefined): string => {
  // 优先使用引用文本 (Telegram 的 quote reply 功能)
  const quoteText = (msg.replyTo as any)?.quoteText;
  if (quoteText && typeof quoteText === "string" && quoteText.trim()) {
    return quoteText.trim();
  }
  // 回退到被回复消息的内容
  return extractText(replyMsg);
};
const splitMessage = (text: string, reserve = 0) => {
  const limit = Math.max(1, MAX_MSG - Math.max(0, reserve));
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (line.length > limit) {
      if (cur) { parts.push(cur); cur = ""; }
      for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
      continue;
    }
    const next = cur ? cur + "\n" + line : line;
    if (next.length > limit) { parts.push(cur); cur = line; } else { cur = next; }
  }
  if (cur) parts.push(cur);
  return parts;
};

/* ---------- 兼容类型检测 ---------- */
const detectCompat = (model: string): Compat => {
  const m = (model || "").toLowerCase();
  if (/\bclaude\b|anthropic/.test(m)) return "claude";
  if (/\bgemini\b|(^gemini-)|image-generation/.test(m)) return "gemini";
  if (/(^gpt-|gpt-4o|gpt-image|dall-e|^tts-1\b)/.test(m)) return "openai";
  return "openai";
};

/* ---------- 模型目录 ---------- */
const catalogInflight: { refreshing: boolean; lastPromise: Promise<void> | null } = { refreshing: false, lastPromise: null };
const getCompatFromCatalog = (model: string): Compat | null => {
  const ml = String(model || "").toLowerCase();
  const map = Store.data.modelCatalog?.map || ({} as Record<string, Compat>);
  const v = (map as any)[ml] as Compat | undefined;
  return v ?? null;
};
const refreshModelCatalog = async (force = false): Promise<void> => {
  if (!force && catalogInflight.refreshing) return catalogInflight.lastPromise || Promise.resolve();
  catalogInflight.refreshing = true;
  const work = (async () => {
    try {
      const entries = Object.entries(Store.data.providers || {});
      const merged: Record<string, Compat> = {};
      for (const [, p] of entries) {
        try {
          const res = await listModelsByAnyCompat(p);
          const mp: Record<string, Compat> = (((res as any).modelMap) || {}) as Record<string, Compat>;
          for (const [k, v] of Object.entries(mp)) merged[k] = v;
        } catch { }
      }
      const catalog = (Store.data.modelCatalog ??= { map: {}, updatedAt: undefined } as any);
      (catalog as any).map = merged as any;
      (catalog as any).updatedAt = nowISO();
      await Store.writeSoon();
    } finally {
      catalogInflight.refreshing = false;
      catalogInflight.lastPromise = null;
    }
  })();
  catalogInflight.lastPromise = work;
  return work;
};
/* ---------- 模型刷新防抖 ---------- */
let refreshDebounceTimer: NodeJS.Timeout | null = null;
const debouncedRefreshModelCatalog = () => {
  if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
  refreshDebounceTimer = setTimeout(() => {
    refreshDebounceTimer = null;
    refreshModelCatalog(true).catch(() => { });
  }, MODEL_REFRESH_DEBOUNCE_MS);
};
const compatResolving = new Map<string, Promise<Compat>>();
const resolveCompat = async (name: string, model: string, p: Provider): Promise<Compat> => {
  const ml = String(model || "").toLowerCase();
  const cat = getCompatFromCatalog(ml);
  if (cat) return cat;
  const mc = (Store.data.modelCompat && (Store.data.modelCompat as any)[name]) ? (Store.data.modelCompat as any)[name][ml] as Compat | undefined : undefined;
  const byName = detectCompat(model);
  if (mc) return mc;
  setTimeout(() => { void refreshModelCatalog(false).catch(() => { }); }, 0);
  const pending = compatResolving.get(name + "::" + ml) || compatResolving.get(name);
  if (pending) return await pending;
  const task = (async () => {
    try {
      const res = await listModelsByAnyCompat(p);
      const primary: Compat | null = (res.compat as Compat) || null;
      const map: Record<string, Compat> = (((res as any).modelMap) || {}) as Record<string, Compat>;
      if (!Store.data.modelCompat) Store.data.modelCompat = {} as any;
      if (!(Store.data.modelCompat as any)[name]) (Store.data.modelCompat as any)[name] = {} as any;
      for (const [k, v] of Object.entries(map)) {
        const cur = (Store.data.modelCompat as any)[name][k] as Compat | undefined;
        if (cur !== v) (Store.data.modelCompat as any)[name][k] = v;
      }
      let comp: Compat = (Store.data.modelCompat as any)[name][ml] as Compat;
      if (!comp) comp = (primary as Compat) || byName;
      if (((Store.data.modelCompat as any)[name][ml] as Compat | undefined) !== comp) (Store.data.modelCompat as any)[name][ml] = comp;
      const cat = (Store.data.modelCatalog ??= { map: {}, updatedAt: undefined } as any);
      const catMap = (cat as any).map as Record<string, Compat>;
      for (const [k, v] of Object.entries(map)) if ((catMap as any)[k] !== v) (catMap as any)[k] = v as Compat;
      if ((catMap as any)[ml] !== comp) (catMap as any)[ml] = comp;
      (cat as any).updatedAt = nowISO();
      if (primary && p) if (p.compatauth !== primary) p.compatauth = primary;
      await Store.writeSoon();
      return comp;
    } catch {
      const comp: Compat = byName;
      if (!Store.data.modelCompat) Store.data.modelCompat = {} as any;
      if (!(Store.data.modelCompat as any)[name]) (Store.data.modelCompat as any)[name] = {} as any;
      if (!(Store.data.modelCompat as any)[name][ml]) (Store.data.modelCompat as any)[name][ml] = comp;
      try { await Store.writeSoon(); } catch { }
      setTimeout(() => { void refreshModelCatalog(false).catch(() => { }); }, 0);
      return comp;
    } finally {
      compatResolving.delete(name + "::" + ml);
      compatResolving.delete(name);
    }
  })();
  compatResolving.set(name + "::" + ml, task);
  return await task;
};

/* ---------- 错误映射 ---------- */
const mapError = (err: any, ctx?: string): string => {
  const s = err?.response?.status as number | undefined;
  const body = err?.response?.data;
  const raw = body?.error?.message || body?.message || err?.message || String(err);
  let hint = "";
  if (s === 400) hint = "请求格式有误，可能是模型不支持当前参数或输入过长";
  else if (s === 401 || s === 403) hint = "认证失败，请检查 API Key 是否正确、是否有对应权限";
  else if (s === 404) hint = "接口不存在，请检查 BaseURL/兼容类型或服务商路由";
  else if (s === 429) hint = "请求过于频繁或额度受限，请稍后重试或调整速率";
  else if (typeof s === "number" && s >= 500) hint = "服务端异常，请稍后重试或更换服务商";
  else if (!s) hint = "网络异常，请检查网络或 BaseURL";
  const where = ctx ? `（${ctx}）` : "";
  return `${raw}${hint ? "｜" + hint : ""}${s ? `｜HTTP ${s}` : ""}${where}`;
};

/* ---------- 模型名规范化 ---------- */
const normalizeModelName = (x: any): string => {
  let s = String(x?.id || x?.slug || x?.name || x || "");
  s = s.trim();
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf("#");
  if (h >= 0) s = s.slice(0, h);
  if (s.includes("/")) s = s.split("/").pop() || s;
  return s.trim();
};

/* ---------- 快捷选取 ---------- */
const pick = (kind: keyof Models): { provider: string; model: string } | null => {
  const s = Store.data.models[kind];
  if (!s) return null;
  const i = s.indexOf(" ");
  if (i <= 0) return null;
  const provider = s.slice(0, i);
  const model = s.slice(i + 1);
  return { provider, model };
};
const providerOf = (name: string): Provider | null => Store.data.providers[name] || null;
const footer = (model: string, extra?: string) => {
  const src = model.toLowerCase().includes("claude") ? "Anthropic Claude" : model.toLowerCase().includes("gemini") ? "Google Gemini" : "OpenAI";
  return `\n\n<i>Powered by ${src}${extra ? " " + extra : ""}</i>`;
};
const ensureDir = () => {
  if (!fs.existsSync(Store.baseDir)) fs.mkdirSync(Store.baseDir, { recursive: true });
};
/* ---------- 上下文隔离（用户+会话） ---------- */
const contextKey = (msg: Api.Message): string => {
  const chatId = String((msg.peerId as any)?.channelId || (msg.peerId as any)?.userId || (msg.peerId as any)?.chatId || "global");
  const userId = String((msg as any).senderId || (msg as any).fromId?.userId || "unknown");
  return `${userId}:${chatId}`;
};
const chatIdStr = (msg: Api.Message) => contextKey(msg); // 兼容别名
const isGroupOrChannel = (msg: Api.Message): boolean => {
  const peer = msg.peerId;
  return (peer as any)?.className === "PeerChannel" || (peer as any)?.className === "PeerChat";
};
const histFor = (id: string) => Store.data.histories[id] || [];
const HISTORY_GLOBAL_MAX_SESSIONS = 200;
const HISTORY_GLOBAL_MAX_BYTES = 2 * 1024 * 1024;
const pruneGlobalHistories = () => {
  const ids = Object.keys(Store.data.histories || {});
  if (!ids.length) return;
  const meta = (Store.data.histMeta || {}) as Record<string, { lastAt: string }>;
  const sizeOfItem = (x: { role: string; content: string }) => Buffer.byteLength(`${x.role}:${x.content}`);
  const sizeOfHist = (arr: { role: string; content: string }[]) => arr.reduce((t, x) => t + sizeOfItem(x), 0);
  let totalBytes = 0;
  for (const id of ids) totalBytes += sizeOfHist(Store.data.histories[id] || []);
  if (ids.length <= HISTORY_GLOBAL_MAX_SESSIONS && totalBytes <= HISTORY_GLOBAL_MAX_BYTES) return;
  const sorted = ids.sort((a, b) => {
    const ta = Date.parse((meta[a]?.lastAt) || "1970-01-01T00:00:00.000Z");
    const tb = Date.parse((meta[b]?.lastAt) || "1970-01-01T00:00:00.000Z");
    return ta - tb;
  });
  while ((sorted.length > HISTORY_GLOBAL_MAX_SESSIONS || totalBytes > HISTORY_GLOBAL_MAX_BYTES) && sorted.length) {
    const victim = sorted.shift()!;
    const arr = Store.data.histories[victim] || [];
    totalBytes -= sizeOfHist(arr);
    delete Store.data.histories[victim];
    if (Store.data.histMeta) delete Store.data.histMeta[victim];
  }
};
const pushHist = (id: string, role: string, content: string) => {
  if (!Store.data.histories[id]) Store.data.histories[id] = [];
  Store.data.histories[id].push({ role, content });
  const h = Store.data.histories[id];
  while (h.length > HISTORY_MAX_ITEMS) h.shift();
  const sizeOf = (x: { role: string; content: string }) => Buffer.byteLength(`${x.role}:${x.content}`);
  let total = 0;
  for (const x of h) total += sizeOf(x);
  while (total > HISTORY_MAX_BYTES && h.length > 1) { const first = h.shift()!; total -= sizeOf(first); }
  if (!Store.data.histMeta) Store.data.histMeta = {} as any;
  (Store.data.histMeta as any)[id] = { lastAt: new Date().toISOString() };
  pruneGlobalHistories();
};

/* ---------- 文本清理 & 格式化 ---------- */
const cleanTextBasic = (t: string): string =>
  t
    .replace(/\uFEFF/g, "")
    .replace(/[\uFFFC\uFFFF\uFFFE]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u200B\u200C\u200D\u2060]/g, "")
    .normalize("NFKC");
const escapeAndFormatForTelegram = (raw: string): string => {
  const cleaned = cleanTextBasic(raw || "");
  let escaped = html(cleaned);
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  escaped = escaped.replace(/\*\*\s*\[?引用来源]?\s*\*\*/g, "<b>引用来源</b>");
  escaped = escaped.replace(/^\s*-\s*\[([^]]+)]\((https?:\/\/[^\s)]+)\)\s*$/gm, (_m, title: string, url: string) => {
    const href = html(String(url));
    return `• <a href="${href}">${title}</a>`;
  });
  const urlRegex = /\bhttps?:\/\/[^\s<>"')}\x5D]+/g;
  const urls = cleaned.match(urlRegex) || [];
  for (const u of urls) {
    const display = shortenUrlForDisplay(u);
    const escapedUrl = html(u);
    const anchor = `<a href="${html(u)}">${html(display)}</a>`;
    escaped = escaped.replace(new RegExp(escapeRegExp(escapedUrl), "g"), anchor);
  }
  escaped = escaped.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
  return escaped;
};

/* ---------- 路由降级 ---------- */
const isRouteError = (err: any): boolean => {
  const s = err?.response?.status;
  const txt = String(err?.response?.data || err?.message || "").toLowerCase();
  return s === 404 || s === 405 || (s === 400 && /(unknown|not found|invalid path|no route)/.test(txt));
};
const geminiRequestWithFallback = async (p: Provider, path: string, axiosConfig: any): Promise<any> => {
  const base = trimBase(p.baseUrl);
  const mkConfigs = () => {
    const baseCfg = { ...axiosConfig };
    const headersBase = { ...(baseCfg.headers || {}) };
    const paramsBase = { ...(baseCfg.params || {}) };
    const cfgKey = { ...baseCfg, headers: { ...headersBase }, params: { ...paramsBase, key: p.apiKey } };
    const cfgXGoog = { ...baseCfg, headers: { ...headersBase, "x-goog-api-key": p.apiKey }, params: { ...paramsBase } };
    const cfgAuth = { ...baseCfg, headers: { ...headersBase, Authorization: `Bearer ${p.apiKey}` }, params: { ...paramsBase } };
    const pref = p.compatauth;
    const ordered = (pref === "openai" || pref === "claude") ? [cfgAuth, cfgXGoog, cfgKey] : [cfgKey, cfgXGoog, cfgAuth];
    const seen = new Set<string>();
    const out: any[] = [];
    for (const c of ordered) {
      const sig = JSON.stringify({ h: c.headers || {}, p: c.params || {} });
      if (!seen.has(sig)) { seen.add(sig); out.push(c); }
    }
    return out;
  };
  const configs = mkConfigs();
  const paths = [`/v1beta${path}`, `/v1${path}`];
  let lastErr: any;
  for (const suffix of paths) {
    for (const cfg of configs) {
      try {
        const r = await axiosWithRetry({ url: base + suffix, ...cfg });
        return r.data;
      } catch (err: any) {
        lastErr = err;
        if (isRouteError(err)) break;
      }
    }
  }
  throw lastErr;
};

/* ---------- Anthropic 版本缓存 ---------- */
const anthropicVersionCache = new Map<string, string>();
const getAnthropicVersion = async (p: Provider): Promise<string> => {
  const key = trimBase(p.baseUrl) || "anthropic";
  const cached = anthropicVersionCache.get(key);
  if (cached) return cached;
  let ver = "2023-06-01";
  const base = trimBase(p.baseUrl);
  try {
    await axiosWithRetry({ method: "GET", url: base + "/v1/models", headers: { "x-api-key": p.apiKey } });
  } catch (err: any) {
    const txt = JSON.stringify(err?.response?.data || err?.message || "");
    const matches = txt.match(/\b20\d{2}-\d{2}-\d{2}\b/g);
    if (matches && matches.length) {
      matches.sort();
      ver = matches[matches.length - 1];
    }
  }
  anthropicVersionCache.set(key, ver);
  return ver;
};

/* ---------- AI 响应清理工具 ---------- */

/**
 * 清理 AI 思考标签（<think>...</think>）
 * 一些模型会返回带有思考过程的响应，需要移除
 */
const cleanAIThinking = (text: string): string => {
  // 移除 <think>...</think> 标签及其内容
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // 同时处理 [think]...[/think] 格式
  cleaned = cleaned.replace(/\[think\][\s\S]*?\[\/think\]/gi, "");
  return cleaned.trim();
};

/**
 * 从文本中提取内嵌的 base64 图片
 * 支持 Markdown 图片格式：![alt](data:image/...;base64,...)
 * 以及直接的 data URI 格式
 * @returns 提取的图片数组，包含 base64 数据和 mime 类型
 */
const extractEmbeddedImages = (text: string): Array<{ data: string; mime: string; alt?: string }> => {
  const images: Array<{ data: string; mime: string; alt?: string }> = [];

  // 匹配 Markdown 格式: ![alt](data:image/xxx;base64,...)
  const mdRegex = /!\[([^\]]*)\]\((data:image\/([a-z0-9+.-]+);base64,([A-Za-z0-9+/=]+))\)/gi;
  let match: RegExpExecArray | null;
  while ((match = mdRegex.exec(text)) !== null) {
    const alt = match[1];
    const mimeType = match[3]; // jpeg, png, webp, etc.
    const base64Data = match[4];
    if (base64Data && base64Data.length > 100) { // 确保是有效的图片数据
      images.push({ data: base64Data, mime: `image/${mimeType}`, alt });
    }
  }

  // 匹配直接的 data URI 格式（不在 Markdown 中）
  // 避免重复匹配已经在 Markdown 中处理过的
  const dataUriRegex = /(?<!![\^\[\]\(])data:image\/([a-z0-9+.-]+);base64,([A-Za-z0-9+/=]{100,})/gi;
  while ((match = dataUriRegex.exec(text)) !== null) {
    const mimeType = match[1];
    const base64Data = match[2];
    // 检查是否已经添加过（通过比较base64数据的前100个字符）
    const isDuplicate = images.some(img => img.data.substring(0, 100) === base64Data.substring(0, 100));
    if (!isDuplicate && base64Data.length > 100) {
      images.push({ data: base64Data, mime: `image/${mimeType}` });
    }
  }

  return images;
};

/**
 * 从文本中移除内嵌图片，只保留文字内容
 */
const cleanEmbeddedImages = (text: string): string => {
  // 移除 Markdown 图片格式
  let cleaned = text.replace(/!\[[^\]]*\]\(data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+\)/gi, "[图片]");
  // 移除直接的 data URI
  cleaned = cleaned.replace(/data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]{100,}/gi, "[图片数据]");
  return cleaned.trim();
};

/**
 * 处理 AI 响应，提取图片和清理文本
 * @returns 处理后的结果，包含清理后的文本和提取的图片
 */
const processAIResponse = (rawContent: string): { text: string; images: Array<{ data: string; mime: string; alt?: string }> } => {
  // 首先清理思考标签
  const withoutThinking = cleanAIThinking(rawContent);

  // 提取内嵌图片
  const images = extractEmbeddedImages(withoutThinking);

  // 清理图片数据，只保留文字
  let text = withoutThinking;
  if (images.length > 0) {
    text = cleanEmbeddedImages(withoutThinking);
  }

  return { text, images };
};

/* ---------- 格式化 Q&A ---------- */
const formatQA = (qRaw: string, aRaw: string) => {
  const expandAttr = Store.data.collapse ? ' expandable' : "";
  const qEsc = escapeAndFormatForTelegram(qRaw);
  const aEsc = escapeAndFormatForTelegram(aRaw);
  const Q = `<b>Q:</b>\n<blockquote${expandAttr}>${qEsc}</blockquote>`;
  const A = `<b>A:</b>\n<blockquote${expandAttr}>${aEsc}</blockquote>`;
  return `${Q}\n\n${A}`;
};

/* ---------- Telegraph 工具 ---------- */
const toNodes = (text: string) => JSON.stringify(text.split("\n\n").map(p => ({ tag: "p", children: [p] })));
const ensureTGToken = async (): Promise<string> => {
  if (Store.data.telegraph.token) return Store.data.telegraph.token;
  const resp = await axiosWithRetry({
    method: "POST",
    url: "https://api.telegra.ph/createAccount",
    params: { short_name: "TeleBoxAI", author_name: "TeleBox" }
  });
  const t = resp.data?.result?.access_token || "";
  Store.data.telegraph.token = t;
  await Store.writeSoon();
  return t;
};
const createTGPage = async (title: string, text: string): Promise<string[]> => {
  // Telegraph 单页限制约 64KB JSON，8000安全值
  const MAX_CHARS_PER_PAGE = 8000;

  const tryCreate = async (token: string, pageTitle: string, content: string): Promise<string | null> => {
    const contentNodes = JSON.parse(toNodes(content));
    const resp = await axiosWithRetry({
      method: "POST",
      url: "https://api.telegra.ph/createPage",
      headers: { "Content-Type": "application/json" },
      data: {
        access_token: token,
        title: pageTitle,
        content: contentNodes,
        return_content: false
      }
    });
    if (!resp.data?.ok) {
      return null;
    }
    return resp.data?.result?.url || null;
  };

  // 按段落分割内容成多个块
  const splitContent = (fullText: string): string[] => {
    if (fullText.length <= MAX_CHARS_PER_PAGE) return [fullText];

    const paragraphs = fullText.split("\n\n");
    const chunks: string[] = [];
    let current = "";

    for (const para of paragraphs) {
      const next = current ? current + "\n\n" + para : para;
      if (next.length > MAX_CHARS_PER_PAGE && current) {
        chunks.push(current);
        current = para;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  };

  try {
    const token = await ensureTGToken();
    if (!token) return [];

    const chunks = splitContent(text);



    // 多页创建
    const urls: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const pageTitle = title;
      try {
        const url = await tryCreate(token, pageTitle, chunks[i]);
        if (url) urls.push(url);
      } catch {
        // 页面创建失败，静默处理
      }
    }
    return urls;
  } catch {
    return [];
  }
};


/* ---------- 媒体处理辅助函数 ---------- */

// 归一化下载的媒体结果
const normalizeDownloadedMedia = async (downloaded: any): Promise<Buffer | null> => {
  if (!downloaded) return null;
  if (Buffer.isBuffer(downloaded)) return downloaded;
  if (typeof downloaded === "string" && downloaded.length > 0) {
    try {
      const stat = await fs.promises.stat(downloaded);
      if (!stat.isFile()) return null;
      return await fs.promises.readFile(downloaded);
    } catch {
      return null;
    }
  }
  return null;
};

// 提取第一帧 (GIF/WebM/Sticker)
const extractFirstFrame = async (buffer: Buffer): Promise<Buffer | null> => {
  try {
    // animated: true 读取第一帧，转为 png
    return await sharp(buffer, { animated: true }).png().toBuffer();
  } catch {
    return null;
  }
};

// 获取 Document 缩略图
const getDocumentThumb = (doc: Api.Document): Api.TypePhotoSize | undefined => {
  const thumbs = doc.thumbs || [];
  if (thumbs.length === 0) return undefined;
  return thumbs[thumbs.length - 1];
};

/**
 * 智能下载并处理消息中的媒体（支持图片、GIF、贴纸等）
 * 返回适合 AI 视觉模型的 Buffer (通常是 PNG/JPEG)
 */
const downloadMessageMediaAsData = async (msg: Api.Message): Promise<{ buffer: Buffer; mime: string } | null> => {
  if (!msg?.media || !msg.client) return null;

  // 1. 普通 Photo
  if (msg.media instanceof Api.MessageMediaPhoto) {
    const downloaded = await msg.client.downloadMedia(msg);
    const buffer = await normalizeDownloadedMedia(downloaded);
    if (!buffer) return null;
    return { buffer, mime: "image/jpeg" };
  }

  // 2. Document (可能是普通图片、GIF、贴纸)
  if (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document) {
    const doc = msg.media.document;
    const docMime = (doc.mimeType || "").toLowerCase();
    const isAnimated =
      docMime === "image/gif" ||
      docMime === "video/webm" ||
      docMime === "application/x-tgsticker" ||
      docMime === "application/x-tg-sticker" ||
      doc.attributes?.some((attr) => attr instanceof Api.DocumentAttributeAnimated);

    // 2.1 静态图片 Document
    if (!isAnimated && docMime.startsWith("image/")) {
      const downloaded = await msg.client.downloadMedia(msg);
      const buffer = await normalizeDownloadedMedia(downloaded);
      if (!buffer) return null;
      return { buffer, mime: docMime };
    }

    // 2.2 动态媒体 (GIF / WebM / Sticker) -> 抽帧
    let frameBuffer: Buffer | null = null;

    // 优先尝试利用 Telegram 提供的缩略图
    const thumb = getDocumentThumb(doc);
    if (thumb) {
      try {
        const downloaded = await msg.client.downloadMedia(msg, { thumb });
        const buffer = await normalizeDownloadedMedia(downloaded);
        if (buffer) {
          // 确保是 PNG
          try { frameBuffer = await sharp(buffer).png().toBuffer(); } catch { frameBuffer = buffer; }
        }
      } catch {
        // 缩略图下载失败，回退到原文件
      }
    }

    // 如果没有缩略图或失败，尝试下载原文件并抽帧
    if (!frameBuffer) {
      try {
        const downloaded = await msg.client.downloadMedia(msg);
        const buffer = await normalizeDownloadedMedia(downloaded);
        if (buffer) {
          frameBuffer = await extractFirstFrame(buffer);
        }
      } catch {
        // 原文件下载/抽帧失败
      }
    }

    if (frameBuffer) {
      return { buffer: frameBuffer, mime: "image/png" };
    }
  }

  return null;
};

/* ---------- 聊天适配 ---------- */
const chatOpenAI = async (p: Provider, model: string, msgs: { role: string; content: string }[], maxTokens?: number, useSearch?: boolean) => {
  const url = trimBase(p.baseUrl) + "/v1/chat/completions";
  const effectiveMaxTokens = maxTokens || Store.data.maxTokens || DEFAULT_MAX_TOKENS;
  const body: any = { model, messages: msgs, max_tokens: effectiveMaxTokens };
  if (useSearch && p.baseUrl?.includes("api.openai.com")) {
    body.tools = [{
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information and return relevant results",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "The search query to execute" } },
          required: ["query"]
        }
      }
    }];
  } else if (useSearch) {
    const searchPrompt = "请基于你的知识回答以下问题，如果需要最新信息请说明。";
    msgs[msgs.length - 1].content = searchPrompt + "\n\n" + msgs[msgs.length - 1].content;
  }
  const attempts = buildAuthAttempts(p);
  try {
    const data: any = await tryPostJSON(url, body, attempts);
    return data?.choices?.[0]?.message?.content || "";
  } catch (lastErr: any) {
    const status = lastErr?.response?.status;
    const bodyErr = lastErr?.response?.data;
    const msg = bodyErr?.error?.message || bodyErr?.message || lastErr?.message || String(lastErr);
    throw new Error(`[chatOpenAI] adapter=openai model=${html(model)} status=${status || "network"} message=${msg}`);
  }
};
const chatClaude = async (p: Provider, model: string, msgs: { role: string; content: string }[], maxTokens?: number, useSearch?: boolean) => {
  const url = trimBase(p.baseUrl) + "/v1/messages";
  const effectiveMaxTokens = maxTokens || Store.data.maxTokens || DEFAULT_MAX_TOKENS;
  const body: any = { model, max_tokens: effectiveMaxTokens, messages: msgs.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })) };
  if (useSearch && p.baseUrl?.includes("api.anthropic.com")) {
    body.tools = [{ type: "web_search_20241220", name: "web_search", max_uses: 3 }];
  }
  const v = await getAnthropicVersion(p);
  const attempts = buildAuthAttempts(p, { "anthropic-version": v });
  try {
    const data: any = await tryPostJSON(url, body, attempts);
    if (data?.content && Array.isArray(data.content)) {
      const textBlocks = data.content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .filter((text: string) => text && text.trim());
      if (textBlocks.length > 0) return textBlocks.join("\n\n");
    }
    const possibleTexts = [
      data?.content?.[0]?.text,
      data?.message?.content?.[0]?.text,
      data?.choices?.[0]?.message?.content,
      data?.response,
      data?.text,
      data?.content,
      data?.message?.content,
      data?.output
    ];
    for (const text of possibleTexts) if (typeof text === "string" && text.trim()) return text.trim();
    return "";
  } catch (lastErr: any) {
    const status = lastErr?.response?.status;
    const bodyErr = lastErr?.response?.data;
    const msg = bodyErr?.error?.message || bodyErr?.message || lastErr?.message || String(lastErr);
    throw new Error(`[chatClaude] adapter=claude model=${html(model)} status=${status || "network"} message=${msg}`);
  }
};
const chatGemini = async (p: Provider, model: string, msgs: { role: string; content: string }[], useSearch: boolean = false) => {
  const path = `/models/${encodeURIComponent(model)}:generateContent`;
  const effectiveMaxTokens = Store.data.maxTokens || DEFAULT_MAX_TOKENS;
  const requestData: any = {
    contents: [{ parts: msgs.map(m => ({ text: m.content })) }],
    generationConfig: {
      maxOutputTokens: effectiveMaxTokens,
      temperature: 0.9
    }
  };
  if (useSearch) requestData.tools = [{ googleSearch: {} }];
  const data = await geminiRequestWithFallback(p, path, {
    method: "POST",
    data: requestData,
    params: { key: p.apiKey }
  });
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((x: any) => x.text || "").join("");
};

/* ---------- 视觉对话 ---------- */
const chatVisionOpenAI = async (p: Provider, model: string, imageB64: string, prompt?: string, mime?: string) => {
  const url = trimBase(p.baseUrl) + "/v1/chat/completions";
  const content = [
    { type: "text", text: prompt || "用中文描述此图片" },
    { type: "image_url", image_url: { url: `data:${mime || "image/png"};base64,${imageB64}` } }
  ];
  const body = { model, messages: [{ role: "user", content }] };
  const attempts = buildAuthAttempts(p);
  try {
    const data: any = await tryPostJSON(url, body, attempts);
    return data?.choices?.[0]?.message?.content || "";
  } catch (lastErr: any) {
    const status = lastErr?.response?.status;
    const bodyErr = lastErr?.response?.data;
    const msg = bodyErr?.error?.message || bodyErr?.message || lastErr?.message || String(lastErr);
    throw new Error(`[chatVisionOpenAI] adapter=openai model=${html(model)} status=${status || "network"} message=${msg}`);
  }
};
const chatVisionGemini = async (p: Provider, model: string, imageB64: string, prompt?: string, mime?: string) => {
  const path = `/models/${encodeURIComponent(model)}:generateContent`;
  try {
    const data = await geminiRequestWithFallback(p, path, {
      method: "POST",
      data: {
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: mime || "image/png", data: imageB64 } },
              { text: prompt || "用中文描述此图片" }
            ]
          }
        ]
      },
      params: { key: p.apiKey }
    });
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.map((x: any) => x.text || "").join("");
  } catch (err: any) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const msg = body?.error?.message || body?.message || err?.message || String(err);
    throw new Error(`[chatVisionGemini] adapter=gemini model=${html(model)} status=${status || "network"} message=${msg}`);
  }
};
const chatVisionClaude = async (p: Provider, model: string, imageB64: string, prompt?: string, mime?: string) => {
  const url = trimBase(p.baseUrl) + "/v1/messages";
  const v = await getAnthropicVersion(p);
  const body = {
    model,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt || "用中文描述此图片" },
          { type: "image", source: { type: "base64", media_type: mime || "image/png", data: imageB64 } }
        ]
      }
    ]
  };
  const attempts = buildAuthAttempts(p, { "anthropic-version": v });
  try {
    const data: any = await tryPostJSON(url, body, attempts);
    const blocks = data?.content || data?.message?.content || [];
    return Array.isArray(blocks) ? blocks.map((b: any) => b?.text || b?.content?.[0]?.text || "").join("") : "";
  } catch (lastErr: any) {
    const status = lastErr?.response?.status;
    const bodyErr = lastErr?.response?.data;
    const msg = bodyErr?.error?.message || bodyErr?.message || lastErr?.message || String(lastErr);
    throw new Error(`[chatVisionClaude] adapter=claude model=${html(model)} status=${status || "network"} message=${msg}`);
  }
};
const chatVision = async (p: Provider, compat: string, model: string, imageB64: string, prompt?: string, mime?: string): Promise<string> => {
  if (compat === "openai") return chatVisionOpenAI(p, model, imageB64, prompt, mime);
  if (compat === "gemini") return chatVisionGemini(p, model, imageB64, prompt, mime);
  if (compat === "claude") return chatVisionClaude(p, model, imageB64, prompt, mime);
  return chatOpenAI(p, model, [{ role: "user", content: prompt || "描述这张图片" } as any] as any);
};

/* ---------- 生图 ---------- */
const imageOpenAI = async (
  p: Provider,
  model: string,
  prompt: string,
  sourceImage?: { data: string; mime: string }
): Promise<string> => {
  const base = trimBase(p.baseUrl);
  const isEdit = !!sourceImage;

  // 尝试多种方式：优先使用 generations 端点（大多数第三方兼容）
  // 如果有源图片，将图片 base64 嵌入请求体（某些平台如豆包支持此方式）
  const url = base + "/v1/images/generations";

  // 根据模型选择合适的分辨率
  // 某些模型（如豆包 imagen）要求最小 3686400 像素 (1920x1920)
  // 通用模型使用 1024x1024
  const modelLower = model.toLowerCase();
  const needsHighRes = modelLower.includes("imagen") ||
    modelLower.includes("sd3") ||
    modelLower.includes("sdxl") ||
    modelLower.includes("flux") ||
    modelLower.includes("seedream") ||
    modelLower.includes("doubao");
  const imageSize = needsHighRes ? "2048x2048" : "1024x1024";

  // 构建请求体
  let body: any = {
    model,
    prompt,
    n: 1,
    response_format: "b64_json",
    size: imageSize
  };

  // 如果有源图片，添加到请求体（兼容某些支持图生图的第三方平台）
  if (isEdit && sourceImage) {
    body.image = `data:${sourceImage.mime};base64,${sourceImage.data}`;
  }

  const attempts = buildAuthAttempts(p, { "Content-Type": "application/json" });

  try {
    const data = await tryPostJSON(url, body, attempts);
    const first = data?.data?.[0] || {};
    const b64 = first?.b64_json || first?.image_base64 || first?.image || "";
    if (b64) return String(b64);
    const urlOut = first?.url || first?.image_url;
    if (urlOut) {
      try {
        const r = await axiosWithRetry({ method: "GET", url: String(urlOut), responseType: "arraybuffer" });
        const buf: any = r.data;
        const b: Buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        if (b && b.length > 0) return b.toString("base64");
      } catch { }
    }
    return "";
  } catch (err: any) {
    // 如果 generations 端点不支持图生图，尝试 edits 端点 (标准 OpenAI 格式)
    if (isEdit && sourceImage) {
      try {
        const editUrl = base + "/v1/images/edits";
        const editBody = {
          model,
          prompt,
          image: `data:${sourceImage.mime};base64,${sourceImage.data}`,
          n: 1,
          response_format: "b64_json",
          size: imageSize
        };
        const editData = await tryPostJSON(editUrl, editBody, attempts);
        const first = editData?.data?.[0] || {};
        const b64 = first?.b64_json || first?.image_base64 || first?.image || "";
        if (b64) return String(b64);
        const urlOut = first?.url || first?.image_url;
        if (urlOut) {
          const r = await axiosWithRetry({ method: "GET", url: String(urlOut), responseType: "arraybuffer" });
          const buf: any = r.data;
          const b: Buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
          if (b && b.length > 0) return b.toString("base64");
        }
      } catch { }
    }
    throw err;
  }
};
const imageGemini = async (p: Provider, model: string, prompt: string, sourceImage?: { data: string; mime: string }): Promise<{ image?: Buffer; text?: string; mime?: string }> => {
  let imageModel = model;
  if (!model.includes("image") && !model.includes("2.5-flash") && !model.includes("2.0-flash") && !model.includes("3-pro")) {
    imageModel = "gemini-2.5-flash-image-preview";
  }
  const path = `/models/${encodeURIComponent(imageModel)}:generateContent`;

  // 构建请求内容 - 支持图生图
  const parts: any[] = [];
  if (sourceImage) {
    // 图生图：先添加原图，再添加提示词
    parts.push({
      inlineData: {
        mimeType: sourceImage.mime,
        data: sourceImage.data
      }
    });
  }
  parts.push({ text: prompt });

  try {
    const data = await geminiRequestWithFallback(p, path, {
      method: "POST",
      data: {
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], temperature: 0.7, maxOutputTokens: 2048 }
      },
      params: { key: p.apiKey }
    });
    const responseParts = data?.candidates?.[0]?.content?.parts || [];
    let text: string | undefined;
    let image: Buffer | undefined;
    let mime: string | undefined;
    for (const part of responseParts) {
      const pAny: any = part;
      if (pAny?.text) {
        const rawText = String(pAny.text);
        // 清理思考标签
        const cleanedText = cleanAIThinking(rawText);

        // 尝试从文本中提取内嵌的 data URI 图片
        const embeddedImages = extractEmbeddedImages(cleanedText);
        if (embeddedImages.length > 0) {
          // 使用第一张提取到的图片
          const firstImg = embeddedImages[0];
          image = Buffer.from(firstImg.data, "base64");
          mime = firstImg.mime;
          // 清理图片数据后的文本
          const remainingText = cleanEmbeddedImages(cleanedText).replace(/\[图片\]/g, "").replace(/\[图片数据\]/g, "").trim();
          if (remainingText && remainingText.length > 10) {
            text = remainingText;
          }
        } else {
          text = cleanedText;
        }
      }
      const inline = pAny?.inlineData || pAny?.inline_data;
      if (inline?.data) {
        image = Buffer.from(inline.data, "base64");
        mime = inline?.mimeType || inline?.mime_type || "image/png";
      }
      const fileUri = pAny?.fileData?.fileUri || pAny?.file_data?.file_uri;
      if (fileUri) {
        const hint = `生成的图片已提供文件URI：${String(fileUri)}`;
        text = text ? `${text}\n${hint}` : hint;
      }
    }
    return { image, text, mime };
  } catch (err: any) {
    const body = err?.response?.data;
    const msg = body?.error?.message || body?.message || err?.message || String(err);
    throw new Error(`图片生成失败：${msg}`);
  }
};

/* ---------- TTS ---------- */
const ttsGemini = async (p: Provider, model: string, input: string, voiceName?: string): Promise<{ audio?: Buffer; mime?: string }> => {
  const path = `/models/${encodeURIComponent(model)}:generateContent`;
  const voice = voiceName || "Kore";
  const buildPayloads = () => [
    {
      contents: [{ role: "user", parts: [{ text: input }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    },
    {
      contents: [{ role: "user", parts: [{ text: input }] }],
      generationConfig: { responseModalities: ["AUDIO"] }
    }
  ];
  try {
    const payloads = buildPayloads();
    for (let i = 0; i < payloads.length; i++) {
      const payload = payloads[i];
      try {
        const data = await geminiRequestWithFallback(p, path, {
          method: "POST",
          data: payload,
          params: { key: p.apiKey },
          timeout: 60000
        });
        const parts = data?.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          const pAny: any = part;
          const inline = pAny?.inlineData || pAny?.inline_data;
          const d = inline?.data;
          const m = inline?.mimeType || inline?.mime_type || "audio/ogg";
          if (d && String(m).startsWith("audio/")) {
            const audio = Buffer.from(d, "base64");
            const mime = m;
            return { audio, mime };
          }
        }
      } catch {
        // Payload 失败，尝试下一个
      }
    }
    return {};
  } catch {
    return {};
  }
};
const ttsOpenAI = async (p: Provider, model: string, input: string, voiceName?: string): Promise<Buffer> => {
  const base = trimBase(p.baseUrl);
  const paths = ["/v1/audio/speech", "/v1/audio/tts", "/audio/speech"];
  const payload = { model, input, voice: voiceName || "alloy", format: "opus" };
  const attempts = buildAuthAttempts(p, { "Content-Type": "application/json" });
  let lastErr: any;
  for (const pth of paths) {
    const url = base + pth;
    for (const a of attempts) {
      try {
        const r = await axiosWithRetry({ method: "POST", url, data: payload, responseType: "arraybuffer", ...(a || {}), timeout: 60000 });
        const data: any = r.data;
        const buf: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf && buf.length > 0) return buf;
      } catch (err: any) {
        lastErr = err;
      }
    }
  }
  const status = lastErr?.response?.status;
  const bodyErr = lastErr?.response?.data;
  const msg = bodyErr?.error?.message || bodyErr?.message || lastErr?.message || String(lastErr);
  throw new Error(`[ttsOpenAI] adapter=openai model=${html(model)} status=${status || "network"} message=${msg}`);
};

/* ---------- PCM -> WAV ---------- */
const convertPcmL16ToWavIfNeeded = (raw: Buffer, mime?: string): { buf: Buffer; mime: string } => {
  let buf = raw;
  let outMime = mime || "audio/ogg";
  const lm = outMime.toLowerCase();
  if (lm.includes("l16") && lm.includes("pcm")) {
    try {
      const parse = (mt: string) => {
        const [fileType, ...params] = mt.split(";").map(s => s.trim());
        const [, format] = (fileType || "").split("/");
        const opts: any = { numChannels: 1, sampleRate: 24000, bitsPerSample: 16 };
        if (format && format.toUpperCase().startsWith("L")) {
          const bits = parseInt(format.slice(1), 10);
          if (!isNaN(bits)) opts.bitsPerSample = bits;
        }
        for (const param of params) {
          const [k, v] = param.split("=").map(s => s.trim());
          if (k === "rate") { const r = parseInt(v, 10); if (!isNaN(r)) opts.sampleRate = r; }
          if (k === "channels") { const c = parseInt(v, 10); if (!isNaN(c)) opts.numChannels = c; }
        }
        return opts;
      };
      const createHeader = (len: number, o: any) => {
        const byteRate = o.sampleRate * o.numChannels * o.bitsPerSample / 8;
        const blockAlign = o.numChannels * o.bitsPerSample / 8;
        const b = Buffer.alloc(44);
        b.write("RIFF", 0);
        b.writeUInt32LE(36 + len, 4);
        b.write("WAVE", 8);
        b.write("fmt ", 12);
        b.writeUInt32LE(16, 16);
        b.writeUInt16LE(1, 20);
        b.writeUInt16LE(o.numChannels, 22);
        b.writeUInt32LE(o.sampleRate, 24);
        b.writeUInt32LE(byteRate, 28);
        b.writeUInt16LE(blockAlign, 32);
        b.writeUInt16LE(o.bitsPerSample, 34);
        b.write("data", 36);
        b.writeUInt32LE(len, 40);
        return b;
      };
      const opts = parse(outMime);
      const header = createHeader(buf.length, opts);
      buf = Buffer.concat([header, buf]);
      outMime = "audio/wav";
    } catch { }
  }
  return { buf, mime: outMime };
};

/* ---------- 语音发送 ---------- */
const sendVoiceWithCaption = async (msg: Api.Message, fileBuf: Buffer, caption: string, replyToId?: number): Promise<void> => {
  try {
    const file: any = Object.assign(fileBuf, { name: "ai.ogg" });
    await msg.client?.sendFile(msg.peerId, {
      file,
      caption,
      parseMode: "html",
      replyTo: replyToId || undefined,
      attributes: [new Api.DocumentAttributeAudio({ duration: 0, voice: true })]
    });
  } catch (error: any) {
    if (error?.message?.includes("CHAT_SEND_VOICES_FORBIDDEN") || error?.message?.includes("VOICES_FORBIDDEN")) {
      try {
        const altFile: any = Object.assign(fileBuf, { name: "ai.wav" });
        await msg.client?.sendFile(msg.peerId, {
          file: altFile,
          caption,
          parseMode: "html",
          replyTo: replyToId || undefined
        });
        return;
      } catch {
        // 回退到文本消息
        const fallbackText = caption + "\n\n⚠️ 语音发送被禁止，已转为文本消息";
        if (replyToId) {
          await msg.client?.sendMessage(msg.peerId, { message: fallbackText, parseMode: "html", replyTo: replyToId });
        } else {
          await msg.client?.sendMessage(msg.peerId, { message: fallbackText, parseMode: "html" });
        }
      }
    } else {
      throw error;
    }
  }
};

/* ---------- 图片发送 ---------- */
const sendImageFile = async (msg: Api.Message, buf: Buffer, caption: string, replyToId?: number, mimeHint?: string): Promise<void> => {
  const ext = (mimeHint || "image/png").includes("png") ? "png" : (mimeHint || "").includes("jpeg") ? "jpg" : "png";
  const file: any = Object.assign(buf, { name: `ai.${ext}` });
  await msg.client?.sendFile(msg.peerId, { file, caption, parseMode: "html", replyTo: replyToId || undefined });
};

/* ---------- 长文自动选择 ---------- */
const sendLongAuto = async (msg: Api.Message, text: string, replyToId?: number, opts?: { collapse?: boolean }, postfix?: string): Promise<void> => {
  if (replyToId) await sendLongReply(msg, replyToId, text, opts, postfix);
  else await sendLong(msg, text, opts, postfix);
};

// 公共 TTS 执行函数
const executeTTS = async (msg: Api.Message, text: string, replyToId: number): Promise<boolean> => {
  const m = pick("tts");
  if (!m) { await msg.edit({ text: "❌ 未设置 tts 模型", parseMode: "html" }); return false; }
  const p = providerOf(m.provider);
  if (!p?.apiKey) { await msg.edit({ text: "❌ 服务商/令牌未配置", parseMode: "html" }); return false; }
  const compat = await resolveCompat(m.provider, m.model, p);
  if (!Store.data.voices) Store.data.voices = { gemini: "Kore", openai: "alloy" };
  const voice = compat === "gemini" ? Store.data.voices.gemini : Store.data.voices.openai;
  await msg.edit({ text: "🔊 合成中...", parseMode: "html" });
  try {
    if (compat === "openai") {
      const audio = await ttsOpenAI(p, m.model, text, voice);
      await sendVoiceWithCaption(msg, audio, "", replyToId);
    } else if (compat === "gemini") {
      const { audio, mime } = await ttsGemini(p, m.model, text, voice);
      if (!audio) { await msg.edit({ text: "❌ 语音合成失败", parseMode: "html" }); return false; }
      const { buf } = convertPcmL16ToWavIfNeeded(audio, mime);
      await sendVoiceWithCaption(msg, buf, "", replyToId);
    } else {
      await msg.edit({ text: "❌ 当前服务商不支持语音合成", parseMode: "html" }); return false;
    }
    await msg.delete();
    return true;
  } catch (e: any) {
    await msg.edit({ text: `❌ 语音合成失败: ${html(e?.message || e)}`, parseMode: "html" });
    return false;
  }
};


/* ---------- 模型列表解析 ---------- */
const parseModelListFromResponse = (data: any): string[] => {
  const arr = Array.isArray(data) ? data : data?.data || data?.models || [];
  return (arr || []).map((x: any) => normalizeModelName(x));
};

/* ---------- 按兼容类型枚举模型 ---------- */
const listModels = async (p: Provider, compat: Compat): Promise<string[]> => {
  const base = trimBase(p.baseUrl);
  const tryGet = async (url: string, headers: Record<string, string> = {}, prefer?: Compat) => {
    const attempts = buildAuthAttempts({ ...p, compatauth: prefer || p.compatauth } as Provider, headers);
    let lastErr: any;
    for (const a of attempts) {
      try {
        const r = await axiosWithRetry({ method: "GET", url, ...(a || {}) });
        return r.data;
      } catch (e: any) {
        lastErr = e;
      }
    }
    throw lastErr;
  };
  let lastErr: any = null;
  if (compat === "openai") {
    const url = base + "/v1/models";
    try {
      const data = await tryGet(url);
      return parseModelListFromResponse(data);
    } catch (e: any) {
      lastErr = e;
    }
    try {
      const vAnth = await getAnthropicVersion(p);
      const data = await tryGet(url, { "anthropic-version": vAnth }, "claude");
      return parseModelListFromResponse(data);
    } catch (e: any) {
      lastErr = e;
    }
    try {
      const data = await tryGet(base + "/v1beta/models", {}, "gemini");
      return parseModelListFromResponse(data);
    } catch (e: any) {
      lastErr = e;
    }
  } else if (compat === "claude") {
    const url = base + "/v1/models";
    try {
      const vAnth = await getAnthropicVersion(p);
      const data = await tryGet(url, { "anthropic-version": vAnth }, "claude");
      return parseModelListFromResponse(data);
    } catch (e: any) {
      lastErr = e;
    }
    try {
      const data = await tryGet(url);
      return parseModelListFromResponse(data);
    } catch (e: any) {
      lastErr = e;
    }
    try {
      const data = await tryGet(base + "/v1beta/models", {}, "gemini");
      return parseModelListFromResponse(data);
    } catch (e: any) {
      lastErr = e;
    }
  } else {
    const url1 = base + "/v1beta/models";
    const url2 = base + "/v1/models";
    try {
      const data = await tryGet(url1, {}, "gemini");
      const list = parseModelListFromResponse(data);
      if (list.length) return list;
    } catch (e: any) {
      lastErr = e;
    }
    try {
      const data = await tryGet(url2, {}, "gemini");
      const list = parseModelListFromResponse(data);
      if (list.length) return list;
    } catch (e: any) {
      lastErr = e;
    }
    try {
      const data = await tryGet(url2);
      return parseModelListFromResponse(data);
    } catch (e: any) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error("无法获取模型列表：服务无有效输出");
};
const listModelsByAnyCompat = async (p: Provider): Promise<{ models: string[]; compat: Compat | null; compats: Compat[]; modelMap?: Record<string, Compat> }> => {
  const order: Compat[] = ["openai", "gemini", "claude"];
  const merged = new Map<string, string>();
  const compats: Compat[] = [];
  const modelMap: Record<string, Compat> = {};
  let primary: Compat | null = null;
  for (const c of order) {
    try {
      const list = await listModels(p, c);
      if (Array.isArray(list) && list.length) {
        if (!primary) primary = c;
        if (!compats.includes(c)) compats.push(c);
        for (const m of list) {
          const k = String(m || "").toLowerCase();
          if (k && !merged.has(k)) merged.set(k, m);
          if (k && modelMap[k] === undefined) modelMap[k] = c;
        }
      }
    } catch { }
  }
  for (const k of Object.keys(modelMap)) {
    const g = detectCompat(k);
    if ((g === "gemini" || g === "claude") && modelMap[k] !== g) modelMap[k] = g;
  }
  return { models: Array.from(merged.values()), compat: primary, compats, modelMap };
};

/* ---------- 预设 Prompt 应用 ---------- */
const applyPresetPrompt = (userInput: string): string => {
  const preset = Store.data.presetPrompt || "";
  if (!preset.trim()) return userInput;
  return `${preset}\n\n${userInput}`;
};

/* ---------- 统一聊天调用 ---------- */
const callChat = async (kind: "chat" | "search", text: string, msg: Api.Message): Promise<{ content: string; model: string }> => {
  const m = pick(kind);
  if (!m) throw new Error(`未设置${kind}模型，请先配置`);
  const p = providerOf(m.provider);
  if (!p) throw new Error(`服务商 ${m.provider} 未配置`);
  const compat = await resolveCompat(m.provider, m.model, p);
  const id = chatIdStr(msg);
  const msgs: { role: string; content: string }[] = [];
  const processedText = applyPresetPrompt(text);
  msgs.push({ role: "user", content: processedText });
  let out = "";
  try {
    const isSearch = kind === "search";
    if (compat === "openai") out = await chatOpenAI(p, m.model, msgs, undefined, isSearch);
    else if (compat === "claude") out = await chatClaude(p, m.model, msgs, undefined, isSearch);
    else out = await chatGemini(p, m.model, msgs, isSearch);
  } catch (e: any) {
    const em = e?.message || String(e);
    throw new Error(`[${kind}] provider=${m.provider} compat=${compat} model=${html(m.model)} :: ${em}`);
  }
  if (Store.data.contextEnabled) {
    pushHist(id, "user", text);
    pushHist(id, "assistant", out);
    await Store.writeSoon();
  }
  return { content: out, model: m.model };
};



/* ---------- 帮助文案 ---------- */
const help_text = `🔧 📝 <b>特性</b>
兼容 Google Gemini、OpenAI、Anthropic Claude、Baidu 标准接口，统一指令，一处配置，多处可用。

✨ <b>亮点</b>
• 🔀 模型混用：对话 / 搜索 / 图片 / 语音 可分别指定不同服务商的不同模型
• 🧠 可选上下文记忆、📰 长文自动发布 Telegraph、🧾 消息折叠显示
• 🎯 全局Prompt预设：为所有对话设置统一的系统提示词

<blockquote expandable>💬 <b>对话</b>
<code>${mainPrefix}ai chat [问题]</code>
• 示例：<code>${mainPrefix}ai chat 你好，帮我简单介绍一下你</code>
• 支持多轮对话（可执行 <code>${mainPrefix}ai context on</code> 开启记忆）
• 超长回答可自动转 Telegraph

🔍 <b>搜索</b>
<code>${mainPrefix}ai search [查询]</code>
• 示例：<code>${mainPrefix}ai search 2024 年 AI 技术进展</code>

🖼️ <b>图片</b>
<code>${mainPrefix}ai image [描述]</code>
• 示例：<code>${mainPrefix}ai image 未来城市的科幻夜景</code>

🎵 <b>文本转语音</b>
<code>${mainPrefix}ai tts [文本]</code>
• 示例：<code>${mainPrefix}ai tts 你好，这是一次语音合成测试</code>

🎤 <b>语音回答</b>
<code>${mainPrefix}ai audio [问题]</code>
• 示例：<code>${mainPrefix}ai audio 用 30 秒介绍人工智能的发展</code>

🔍🎤 <b>搜索并语音回答</b>
<code>${mainPrefix}ai searchaudio [查询]</code>
• 示例：<code>${mainPrefix}ai searchaudio 2024 年最新科技趋势</code>

🎯 <b>全局Prompt预设</b>
<code>${mainPrefix}ai prompt set [内容]</code> - 设置全局Prompt预设
<code>${mainPrefix}ai prompt clear</code> - 清除全局Prompt预设
<code>${mainPrefix}ai prompt show</code> - 显示当前Prompt预设
• 预设将自动添加到所有对话请求前，适用于角色设定、回答风格等统一配置

💭 <b>对话上下文</b>
<code>${mainPrefix}ai context on|off|show|del</code>

📋 <b>消息折叠</b>
<code>${mainPrefix}ai collapse on|off</code>

📰 <b>Telegraph 长文</b>
<code>${mainPrefix}ai telegraph on|off|limit &lt;数量&gt;|list|del &lt;n|all&gt;</code>
• limit &lt;数量&gt;：设置字数阈值（0 表示不限制）
• 自动创建 / 管理 / 删除 Telegraph 文章

🎤 <b>音色管理</b>
<code>${mainPrefix}ai voice list</code> - 查看所有可用音色（Gemini 30种 / OpenAI 6种）
<code>${mainPrefix}ai voice show</code> - 查看当前音色配置
<code>${mainPrefix}ai voice gemini [音色名]</code> - 设置 Gemini TTS 音色
<code>${mainPrefix}ai voice openai [音色名]</code> - 设置 OpenAI TTS 音色
• Gemini 音色示例：Kore, Puck, Charon, Leda, Aoede 等
• OpenAI 音色示例：alloy, echo, fable, onyx, nova, shimmer

⚙️ <b>模型管理</b>
<code>${mainPrefix}ai model list</code> - 查看当前模型配置
<code>${mainPrefix}ai model chat|search|image|tts [服务商] [模型]</code> - 设置各功能模型
<code>${mainPrefix}ai model default</code> - 清空所有功能模型
<code>${mainPrefix}ai model auto</code> - 智能分配 chat/search/image/tts

🔧 <b>配置管理</b>
<code>${mainPrefix}ai config status</code> - 显示配置概览
<code>${mainPrefix}ai config add [服务商] [API密钥] [BaseURL]</code>
<code>${mainPrefix}ai config list</code> - 查看已配置的服务商
<code>${mainPrefix}ai config model [服务商]</code> - 查看该服务商可用模型
<code>${mainPrefix}ai config update [服务商] [apikey|baseurl] [值]</code>
<code>${mainPrefix}ai config remove [服务商|all]</code>

📝 <b>配置示例</b>
• OpenAI：<code>${mainPrefix}ai config add openai sk-proj-xxx https://api.openai.com</code>
• DeepSeek：<code>${mainPrefix}ai config add deepseek sk-xxx https://api.deepseek.com</code>
• Grok：<code>${mainPrefix}ai config add grok xai-xxx https://api.x.ai</code>
• Claude：<code>${mainPrefix}ai config add claude sk-ant-xxx https://api.anthropic.com</code>
• Gemini：<code>${mainPrefix}ai config add gemini AIzaSy-xxx https://generativelanguage.googleapis.com</code>

⚡ <b>简洁命令与别名</b>
常用简写
• 对话：<code>${mainPrefix}ai [问题]</code>或<code>${mainPrefix}ai chat [问题]</code>
• 搜索：<code>${mainPrefix}ai s [查询]</code>
• 图片：<code>${mainPrefix}ai img [描述]</code>
• 语音：<code>${mainPrefix}ai v [文本]</code>
• 回答为语音：<code>${mainPrefix}ai a [问题]</code> / 搜索并语音：<code>${mainPrefix}ai sa [查询]</code>
• 上下文：<code>${mainPrefix}ai ctx on|off</code>
• 模型：<code>${mainPrefix}ai m list</code> / 设置：<code>${mainPrefix}ai m chat|search|image|tts [服务商] [模型]</code>
• 配置：<code>${mainPrefix}ai c add [服务商] [API密钥] [BaseURL]</code>
• 别名：<code>s</code>=search, <code>img</code>/<code>i</code>=image, <code>v</code>=tts, <code>a</code>=audio, <code>sa</code>=searchaudio, <code>ctx</code>=context, <code>fold</code>=collapse, <code>cfg</code>/<code>c</code>=config, <code>m</code>=model

⏱️ <b>超时设置</b>
<code>${mainPrefix}ai timeout</code> - 查看当前超时时间
<code>${mainPrefix}ai timeout set [秒]</code> - 设置超时时间（10-600秒）
<code>${mainPrefix}ai timeout reset</code> - 重置为默认值（30秒）

📝 <b>最大输出 Token</b>
<code>${mainPrefix}ai maxtokens</code> - 查看当前设置
<code>${mainPrefix}ai maxtokens set [数量]</code> - 设置最大输出 token（100-128000）
<code>${mainPrefix}ai maxtokens reset</code> - 重置为默认值（16384，约8000中文字）
• 生成超长文本时需增大此值，同时建议增加超时时间

🔗 <b>链接预览</b>
<code>${mainPrefix}ai preview</code> - 查看当前状态
<code>${mainPrefix}ai preview on|off</code> - 开启/关闭链接预览
</blockquote>`;


/* ---------- 插件主体 ---------- */
class AiPlugin extends Plugin {
  description = `🤖 智能AI助手\n\n${help_text}`;
  cmdHandlers = {
    ai: async (msg: Api.Message) => {
      await Store.init();
      ensureDir();
      const text = (msg as any).text || (msg as any).message || "";
      const lines = text.trim().split(/\r?\n/g);
      const parts = (lines[0] || "").split(/\s+/);
      const [, sub, ...args] = parts;
      const subl = (sub || "").toLowerCase();
      const aliasMap: Record<string, string> = {
        s: "search",
        img: "image",
        i: "image",
        v: "tts",
        a: "audio",
        sa: "searchaudio",
        ctx: "context",
        fold: "collapse",
        cfg: "config",
        c: "config",
        m: "model"
      };
      const subn = aliasMap[subl] || subl;
      const knownSubs = [
        "config", "model", "context", "collapse", "telegraph", "voice", "prompt",
        "chat", "search", "image", "tts", "audio", "searchaudio", "help", "timeout", "preview", "maxtokens"
      ];
      const isUnknownBareQuery = !!subn && !knownSubs.includes(subn);
      try {
        const preflight = async (kind: keyof Models): Promise<{ m: { provider: string; model: string }; p: Provider; compat: Compat } | null> => {
          const m = pick(kind);
          if (!m) { await msg.edit({ text: `❌ 未设置 ${kind} 模型`, parseMode: "html" }); return null; }
          const p = providerOf(m.provider);
          if (!p) { await msg.edit({ text: "❌ 服务商未配置", parseMode: "html" }); return null; }
          if (!p.apiKey) { await msg.edit({ text: "❌ 未提供令牌，请先配置 API Key（ai config add/update）", parseMode: "html" }); return null; }
          const compat = await resolveCompat(m.provider, m.model, p);
          return { m, p, compat };
        };

        /* ---------- 帮助命令 ---------- */
        if (subn === "help" || subn === "h" || subn === "?") {
          await sendLong(msg, help_text);
          return;
        }

        /* ---------- Prompt 预设管理 ---------- */
        if (subn === "prompt") {
          const a0 = (args[0] || "").toLowerCase();
          if (a0 === "set") {
            // 支持多行 Prompt：从原始文本中提取 "prompt set" 后的全部内容
            const fullText = (msg as any).text || (msg as any).message || "";
            // 匹配 "-ai prompt set " 或 ".ai prompt set " 等前缀，忽略大小写
            const promptSetMatch = fullText.match(/^[.\-\/!]ai\s+prompt\s+set\s+/i);
            let promptContent = "";
            if (promptSetMatch) {
              promptContent = fullText.slice(promptSetMatch[0].length).trim();
            } else {
              // 回退到旧逻辑（理论上不会走到这里）
              promptContent = args.slice(1).join(" ").trim();
            }
            if (!promptContent) {
              await msg.edit({ text: "❌ 请提供预设Prompt内容", parseMode: "html" });
              return;
            }
            Store.data.presetPrompt = promptContent;
            await Store.writeSoon();
            await msg.edit({ text: `✅ 已设置全局Prompt预设\n\n<blockquote expandable>${html(promptContent)}</blockquote>`, parseMode: "html" });
            return;
          }
          if (a0 === "clear") {
            Store.data.presetPrompt = "";
            await Store.writeSoon();
            await msg.edit({ text: "✅ 已清除全局Prompt预设", parseMode: "html" });
            return;
          }
          if (a0 === "show") {
            const currentPrompt = Store.data.presetPrompt || "";
            if (!currentPrompt) {
              await msg.edit({ text: "📝 当前未设置全局Prompt预设", parseMode: "html" });
              return;
            }
            await sendLong(msg, `📝 <b>当前全局Prompt预设</b>\n\n<blockquote expandable>${html(currentPrompt)}</blockquote>`);
            return;
          }
          await msg.edit({ text: "❌ 未知 prompt 子命令\n支持: set|clear|show", parseMode: "html" });
          return;
        }

        /* ---------- 配置管理 ---------- */
        if (subn === "config") {
          if (isGroupOrChannel(msg)) {
            await msg.edit({ text: "❌ 为保护用户隐私，禁止在公共对话环境使用ai config所有子命令", parseMode: "html" });
            return;
          }
          const a0 = (args[0] || "").toLowerCase();
          if (a0 === "status") {
            const cur = Store.data.models;
            const flags = [
              `• 上下文: ${Store.data.contextEnabled ? "开启" : "关闭"}`,
              `• 折叠: ${Store.data.collapse ? "开启" : "关闭"}`,
              `• Telegraph: ${Store.data.telegraph.enabled ? "开启" : "关闭"}${Store.data.telegraph.enabled && Store.data.telegraph.limit ? `（阈值 ${Store.data.telegraph.limit}）` : ""}`,
              `• Prompt预设: ${Store.data.presetPrompt ? "✅ 已设置" : "❌ 未设置"}`,

            ].join("\n");
            const provList = Object.entries(Store.data.providers)
              .map(([n, v]) => {
                const display = shortenUrlForDisplay(v.baseUrl);
                return `• <b>${html(n)}</b> - key:${v.apiKey ? "✅" : "❌"} base:<a href="${html(v.baseUrl)}">${html(display)}</a>`;
              })
              .join("\n") || "(空)";
            const txt = `⚙️ <b>AI 配置概览</b>\n\n<b>功能模型</b>\n<b>chat:</b> <code>${html(cur.chat) || "(未设)"}</code>\n<b>search:</b> <code>${html(cur.search) || "(未设)"}</code>\n<b>image:</b> <code>${html(cur.image) || "(未设)"}</code>\n<b>tts:</b> <code>${html(cur.tts) || "(未设)"}</code>\n\n<b>功能开关</b>\n${flags}\n\n<b>服务商</b>\n${provList}`;
            await sendLong(msg, txt);
            return;
          }
          if (a0 === "add") {
            const [name, key, baseUrl] = [args[1], args[2], args[3]];
            if (!name || !key || !baseUrl) {
              await msg.edit({ text: "❌ 参数不足", parseMode: "html" });
              return;
            }
            try {
              const u = new URL(baseUrl);
              if (u.protocol !== "http:" && u.protocol !== "https:") {
                await msg.edit({ text: "❌ baseUrl 无效，请使用 http/https 协议", parseMode: "html" });
                return;
              }
            } catch {
              await msg.edit({ text: "❌ baseUrl 无效，请检查是否为合法 URL", parseMode: "html" });
              return;
            }
            Store.data.providers[name] = { apiKey: key, baseUrl: trimBase(baseUrl.trim()) };
            if (Store.data.modelCompat) delete Store.data.modelCompat[name];
            compatResolving.delete(name);
            await Store.writeSoon();
            debouncedRefreshModelCatalog();
            await msg.edit({ text: `✅ 已添加 <b>${html(name)}</b>`, parseMode: "html" });
            return;
          }
          if (a0 === "update") {
            const [name, field, ...rest] = args.slice(1);
            const value = (rest.join(" ") || "").trim();
            if (!name || !field || !value) {
              await msg.edit({ text: "❌ 参数不足", parseMode: "html" });
              return;
            }
            const p = Store.data.providers[name];
            if (!p) {
              await msg.edit({ text: "❌ 未找到服务商", parseMode: "html" });
              return;
            }
            if (field.toLowerCase() === "apikey") {
              p.apiKey = value;
              delete (p as any).compatauth;
            } else if (field.toLowerCase() === "baseurl") {
              try {
                const u = new URL(value);
                if (u.protocol !== "http:" && u.protocol !== "https:") {
                  await msg.edit({ text: "❌ baseUrl 无效，请使用 http/https 协议", parseMode: "html" });
                  return;
                }
              } catch {
                await msg.edit({ text: "❌ baseUrl 无效，请检查是否为合法 URL", parseMode: "html" });
                return;
              }
              p.baseUrl = trimBase(value.trim());
              delete (p as any).compatauth;
            } else {
              await msg.edit({ text: "❌ 字段仅支持 apikey|baseurl", parseMode: "html" });
              return;
            }
            if (Store.data.modelCompat) delete Store.data.modelCompat[name];
            compatResolving.delete(name);
            await Store.writeSoon();
            debouncedRefreshModelCatalog();
            await msg.edit({ text: `✅ 已更新 <b>${html(name)}</b> 的 <code>${html(field)}</code>`, parseMode: "html" });
            return;
          }
          if (a0 === "remove") {
            const target = (args[1] || "").toLowerCase();
            if (!target) {
              await msg.edit({ text: "❌ 请输入服务商名称或 all", parseMode: "html" });
              return;
            }
            if (target === "all") {
              Store.data.providers = {};
              Store.data.modelCompat = {};
              Store.data.modelCatalog = { map: {}, updatedAt: undefined } as any;
              compatResolving.clear();
            } else {
              if (!Store.data.providers[target]) {
                await msg.edit({ text: "❌ 未找到服务商", parseMode: "html" });
                return;
              }
              delete Store.data.providers[target];
              if (Store.data.modelCompat) delete Store.data.modelCompat[target];
              const kinds: (keyof Models)[] = ["chat", "search", "image", "tts"];
              for (const k of kinds) {
                const v = Store.data.models[k];
                if (v && v.startsWith(target + " ")) Store.data.models[k] = "";
              }
            }
            await Store.writeSoon();
            debouncedRefreshModelCatalog();
            await msg.edit({ text: "✅ 已删除", parseMode: "html" });
            return;
          }
          if (a0 === "list") {
            const list = Object.entries(Store.data.providers)
              .map(([n, v]) => {
                const display = shortenUrlForDisplay(v.baseUrl);
                return `• <b>${html(n)}</b> - key:${v.apiKey ? "✅" : "❌"} base:<a href="${html(v.baseUrl)}">${html(display)}</a>`;
              })
              .join("\n") || "(空)";
            await sendLong(msg, `📦 <b>已配置服务商</b>\n\n${list}`);
            return;
          }
          if (a0 === "model") {
            const name = args[1];
            const p = name && providerOf(name);
            if (!p) {
              await msg.edit({ text: "❌ 未找到服务商", parseMode: "html" });
              return;
            }
            let models: string[] = [];
            let selected: Compat | null = null;
            try {
              const res = await listModelsByAnyCompat(p);
              models = res.models;
              selected = res.compat;
            } catch { }
            if (!models.length || !selected) {
              await msg.edit({ text: "❌ 该服务商的权鉴方式未使用OpenAI、Google Gemini、Claude的标准接口，不做兼容。", parseMode: "html" });
              return;
            }
            const buckets = { chat: [] as string[], search: [] as string[], image: [] as string[], tts: [] as string[] };
            for (const m of models) {
              const ml = String(m).toLowerCase();
              if (/image|dall|sd|gpt-image/.test(ml)) buckets.image.push(m);
              else if (/tts|voice|audio\.speech|gpt-4o.*-tts|\b-tts\b/.test(ml)) buckets.tts.push(m);
              else {
                buckets.chat.push(m);
                buckets.search.push(m);
              }
            }
            const txt = `🧾 <b>${html(name!)}</b> 可用模型\n\n<b>chat/search</b>:\n${buckets.chat.length ? buckets.chat.map(x => "• " + html(x)).join("\n") : "(空)"}\n\n<b>image</b>:\n${buckets.image.length ? buckets.image.map(x => "• " + html(x)).join("\n") : "(空)"}\n\n<b>tts</b>:\n${buckets.tts.length ? buckets.tts.map(x => "• " + html(x)).join("\n") : "(空)"}`;
            await sendLong(msg, txt);
            return;
          }
          await msg.edit({ text: "❌ 未知 config 子命令", parseMode: "html" });
          return;
        }

        /* ---------- 模型管理 ---------- */
        if (subn === "model") {
          const a0 = (args[0] || "").toLowerCase();
          if (a0 === "list") {
            const cur = Store.data.models;
            const txt = `⚙️ <b>当前模型配置</b>\n\n<b>chat:</b> <code>${html(cur.chat) || "(未设)"}</code>\n<b>search:</b> <code>${html(cur.search) || "(未设)"}</code>\n<b>image:</b> <code>${html(cur.image) || "(未设)"}</code>\n<b>tts:</b> <code>${html(cur.tts) || "(未设)"}</code>`;
            await sendLong(msg, txt);
            return;
          }
          if (a0 === "default") {
            Store.data.models = { chat: "", search: "", image: "", tts: "" };
            await Store.writeSoon();
            await msg.edit({ text: "✅ 已清空所有功能模型设置", parseMode: "html" });
            return;
          }
          if (a0 === "auto") {
            const entries = Object.entries(Store.data.providers);
            if (!entries.length) {
              await msg.edit({ text: "❌ 请先使用 ai config add 添加服务商", parseMode: "html" });
              return;
            }
            const modelsBy: Record<string, string[]> = {};
            for (const [n, p] of entries) {
              try {
                const { models } = await listModelsByAnyCompat(p);
                if (Array.isArray(models) && models.length) {
                  modelsBy[n] = models;
                } else {
                  modelsBy[n] = [];
                }
              } catch {
                modelsBy[n] = [];
              }
            }
            const bucketsBy: Record<string, { chat: string[]; search: string[]; image: string[]; tts: string[] }> = {};
            for (const [n, list] of Object.entries(modelsBy)) {
              const buckets = { chat: [] as string[], search: [] as string[], image: [] as string[], tts: [] as string[] };
              for (const m of list) {
                const ml = String(m).toLowerCase();
                if (/image|dall|sd|gpt-image/.test(ml)) buckets.image.push(m);
                else if (/tts|voice|audio\.speech|gpt-4o.*-tts|\b-tts\b/.test(ml)) buckets.tts.push(m);
                else {
                  buckets.chat.push(m);
                  buckets.search.push(m);
                }
              }
              bucketsBy[n] = buckets;
            }
            const orders: Array<Compat | "other"> = ["openai", "gemini", "claude", "other"];
            const modelFamilyOf = (m: string): Compat | "other" => {
              const s = m.toLowerCase();
              if (/(gpt-|dall-e|gpt-image|tts-1|gpt-4o|\bo[134](?:-|\b))/.test(s)) return "openai";
              if (/gemini/.test(s)) return "gemini";
              if (/claude/.test(s)) return "claude";
              return "other";
            };
            const isStable = (m: string) => !/(preview|experimental|beta|dev|test|sandbox|staging)/i.test(m);
            const labelWeight = (s: string) => {
              const l = s.toLowerCase();
              let w = 0;
              if (/ultra/.test(l)) w += 0.09; if (/\bpro\b/.test(l)) w += 0.08; if (/opus/.test(l)) w += 0.08;
              if (/sonnet/.test(l)) w += 0.07; if (/flash/.test(l)) w += 0.06; if (/haiku/.test(l)) w += 0.03;
              if (/nano|lite|mini/.test(l)) w += 0.02;
              return w;
            };
            const popularPatterns: Record<Compat | "other", RegExp> = {
              openai: /gpt-4o|gpt-4\.?1|gpt-4-turbo|gpt-4|gpt-3\.5|gpt-image|tts-1|o[134]-?mini?/i,
              claude: /claude-3\.?[57]-sonnet|claude-3-opus|claude-3-sonnet|claude-3-haiku|claude-2/i,
              gemini: /gemini-2\.5|gemini-2\.0|gemini-1\.5|gemini-1\.0/i,
              other: /deepseek|grok|llama-3|mistral|mixtral|qwen2|command-r/i
            };
            const isPopularByFamily = (m: string, family: Compat | "other") => popularPatterns[family]?.test(m) ?? false;
            const popularityWeight = (m: string, family: Compat | "other") => isPopularByFamily(m, family) ? 0.5 : 0;
            const versionScore = (m: string, family: Compat | "other") => {
              const s = String(m).toLowerCase();
              const numMatch = s.match(/(\d+(?:\.\d+)?)/);
              let base = numMatch ? parseFloat(numMatch[1]) : 0;
              if (/gpt-4o/.test(s)) base = Math.max(base, 4.01);
              if (/tts-1/.test(s)) base = Math.max(base, 1.0);
              return base + labelWeight(s) + popularityWeight(m, family);
            };
            const sortCandidates = (_kind: "chat" | "search" | "image" | "tts", family: Compat | "other", list: string[]) => {
              const preferred = list.filter(m => isPopularByFamily(m, family));
              const useList = preferred.length ? preferred : list;
              const stable = useList.filter(m => isStable(m));
              const unstable = useList.filter(m => !isStable(m));
              const cmp = (a: string, b: string) => versionScore(b, family) - versionScore(a, family);
              stable.sort(cmp);
              unstable.sort(cmp);
              return [...stable, ...unstable];
            };
            const pickAcrossKind = (kind: "chat" | "search" | "image" | "tts", preferredProvider?: string) => {
              const providerOrder = (() => {
                const names = entries.map(([n]) => n);
                if (preferredProvider && names.includes(preferredProvider)) {
                  const rest = names.filter(n => n !== preferredProvider);
                  return [preferredProvider, ...rest];
                }
                return names;
              })();
              for (const fam of orders) {
                for (const n of providerOrder) {
                  const bucket = bucketsBy[n]?.[kind] || [];
                  if (!bucket.length) continue;
                  const candidates = bucket.filter(m => modelFamilyOf(m) === fam);
                  if (!candidates.length) continue;
                  const sorted = sortCandidates(kind, fam, candidates);
                  const m = sorted[0];
                  if (m) return { n, m, c: fam };
                }
              }
              for (const n of providerOrder) {
                const bucket = bucketsBy[n]?.[kind] || [];
                if (!bucket.length) continue;
                const sorted = sortCandidates(kind, "other", bucket);
                const m = sorted[0];
                if (m) return { n, m, c: "other" as const };
              }
              return null as any;
            };
            const chatPref = pick("chat")?.provider || undefined;
            const searchPref = pick("search")?.provider || undefined;
            const imagePref = pick("image")?.provider || undefined;
            const ttsPref = pick("tts")?.provider || undefined;
            const anchorProvider = chatPref || searchPref || imagePref || ttsPref || undefined;
            const chatSel = pickAcrossKind("chat", anchorProvider);
            const searchSel = pickAcrossKind("search", anchorProvider);
            const imageSel = pickAcrossKind("image", anchorProvider);
            const ttsSel = pickAcrossKind("tts", anchorProvider);
            if (!chatSel) {
              await msg.edit({ text: "❌ 未在任何已配置服务商中找到可用 chat 模型", parseMode: "html" });
              return;
            }
            const prev = { ...Store.data.models };
            Store.data.models.chat = `${chatSel.n} ${chatSel.m}`;
            Store.data.models.search = searchSel ? `${searchSel.n} ${searchSel.m}` : prev.search;
            Store.data.models.image = imageSel ? `${imageSel.n} ${imageSel.m}` : prev.image;
            Store.data.models.tts = ttsSel ? `${ttsSel.n} ${ttsSel.m}` : prev.tts;
            await Store.writeSoon();
            const cur = Store.data.models;
            const detail = `✅ 已智能分配 chat/search/image/tts\n\n<b>chat:</b> <code>${html(cur.chat) || "(未设)"}</code>\n<b>search:</b> <code>${html(cur.search) || "(未设)"}</code>\n<b>image:</b> <code>${html(cur.image) || "(未设)"}</code>\n<b>tts:</b> <code>${html(cur.tts) || "(未设)"}</code>`;
            await msg.edit({ text: detail, parseMode: "html" });
            return;
          }
          const kind = a0 as keyof Models;
          if (["chat", "search", "image", "tts"].includes(kind)) {
            const [provider, ...mm] = args.slice(1);
            const model = (mm.join(" ") || "").trim();
            if (!provider || !model) {
              await msg.edit({ text: "❌ 参数不足", parseMode: "html" });
              return;
            }
            if (!Store.data.providers[provider]) {
              await msg.edit({ text: "❌ 未知服务商", parseMode: "html" });
              return;
            }
            Store.data.models[kind] = `${provider} ${model}`;
            await Store.writeSoon();
            await msg.edit({ text: `✅ 已设置 ${kind}: <code>${html(Store.data.models[kind])}</code>`, parseMode: "html" });
            return;
          }
          await msg.edit({ text: "❌ 未知 model 子命令", parseMode: "html" });
          return;
        }

        /* ---------- 上下文管理 ---------- */
        if (subn === "context") {
          const a0 = (args[0] || "").toLowerCase();
          const id = chatIdStr(msg);
          if (a0 === "on") {
            Store.data.contextEnabled = true;
            await Store.writeSoon();
            await msg.edit({ text: "✅ 已开启上下文", parseMode: "html" });
            return;
          }
          if (a0 === "off") {
            Store.data.contextEnabled = false;
            await Store.writeSoon();
            await msg.edit({ text: "✅ 已关闭上下文", parseMode: "html" });
            return;
          }
          if (a0 === "show") {
            const items = histFor(id);
            const t = items.map(x => `${x.role}: ${html(x.content)}`).join("\n");
            await sendLong(msg, t || "(空)");
            return;
          }
          if (a0 === "del") {
            const histItems = Store.data.histories[id] || [];
            const count = histItems.length;
            delete Store.data.histories[id];
            if (Store.data.histMeta) delete Store.data.histMeta[id];
            await Store.writeSoon();
            await msg.edit({ text: `✅ 已清空本会话上下文（${count} 条记录）`, parseMode: "html" });
            return;
          }
          await msg.edit({ text: "❌ 未知 context 子命令\n支持: on|off|show|del", parseMode: "html" });
          return;
        }

        /* ---------- 折叠开关 ---------- */
        if (subn === "collapse") {
          const a0 = (args[0] || "").toLowerCase();
          Store.data.collapse = a0 === "on";
          await Store.writeSoon();
          await msg.edit({ text: `✅ 消息折叠: ${Store.data.collapse ? "开启" : "关闭"}`, parseMode: "html" });
          return;
        }

        /* ---------- Telegraph ---------- */
        if (subn === "telegraph") {
          const a0 = (args[0] || "").toLowerCase();
          if (a0 === "on") {
            Store.data.telegraph.enabled = true;
            await Store.writeSoon();
            await msg.edit({ text: "✅ 已开启 telegraph", parseMode: "html" });
            return;
          }
          if (a0 === "off") {
            Store.data.telegraph.enabled = false;
            await Store.writeSoon();
            await msg.edit({ text: "✅ 已关闭 telegraph", parseMode: "html" });
            return;
          }
          if (a0 === "limit") {
            const n = parseInt(args[1] || "0");
            Store.data.telegraph.limit = isFinite(n) ? n : 0;
            await Store.writeSoon();
            await msg.edit({ text: `✅ 阈值: ${Store.data.telegraph.limit}`, parseMode: "html" });
            return;
          }
          if (a0 === "list") {
            const list = Store.data.telegraph.posts.map((p, i) => `${i + 1}. <a href="${p.url}">${html(p.title)}</a> ${p.createdAt}`).join("\n") || "(空)";
            await sendLong(msg, `🧾 <b>Telegraph 列表</b>\n\n${list}`);
            return;
          }
          if (a0 === "del") {
            const t = (args[1] || "").toLowerCase();
            if (t === "all") Store.data.telegraph.posts = [];
            else {
              const i = parseInt(args[1] || "0") - 1;
              if (i >= 0) Store.data.telegraph.posts.splice(i, 1);
            }
            await Store.writeSoon();
            await msg.edit({ text: "✅ 操作完成", parseMode: "html" });
            return;
          }
          await msg.edit({ text: "❌ 未知 telegraph 子命令", parseMode: "html" });
          return;
        }

        /* ---------- 音色管理 ---------- */
        if (subn === "voice") {
          const a0 = (args[0] || "").toLowerCase();
          if (!Store.data.voices) Store.data.voices = { gemini: "Kore", openai: "alloy" };
          if (a0 === "list") {
            const geminiList = GEMINI_VOICES.map((v, i) => `${i + 1}. ${v}`).join("\n");
            const openaiList = OPENAI_VOICES.map((v, i) => `${i + 1}. ${v}`).join("\n");
            const header = `🎤 <b>可用音色列表</b>\n\n<b>当前配置:</b>\nGemini: <code>${Store.data.voices.gemini}</code>\nOpenAI: <code>${Store.data.voices.openai}</code>\n\n`;
            const collapsedContent = `<b>Gemini (${GEMINI_VOICES.length}种):</b>\n${geminiList}\n\n<b>OpenAI (${OPENAI_VOICES.length}种):</b>\n${openaiList}`;
            const txt = header + `<blockquote expandable>${collapsedContent}</blockquote>`;
            await sendLong(msg, txt);
            return;
          }
          if (a0 === "show") {
            const txt = `🎤 <b>当前音色配置</b>\n\n<b>Gemini:</b> <code>${Store.data.voices.gemini}</code>\n<b>OpenAI:</b> <code>${Store.data.voices.openai}</code>`;
            await msg.edit({ text: txt, parseMode: "html" });
            return;
          }
          if (a0 === "gemini") {
            const voiceName = args[1];
            if (!voiceName) {
              await msg.edit({ text: `❌ 请指定音色名称\n当前: <code>${Store.data.voices.gemini}</code>`, parseMode: "html" });
              return;
            }
            if (!GEMINI_VOICES.includes(voiceName as any)) {
              await msg.edit({ text: `❌ 未知音色: ${html(voiceName)}\n使用 <code>ai voice list</code> 查看可用音色`, parseMode: "html" });
              return;
            }
            Store.data.voices.gemini = voiceName;
            await Store.writeSoon();
            await msg.edit({ text: `✅ 已设置 Gemini 音色: <code>${html(voiceName)}</code>`, parseMode: "html" });
            return;
          }
          if (a0 === "openai") {
            const voiceName = args[1];
            if (!voiceName) {
              await msg.edit({ text: `❌ 请指定音色名称\n当前: <code>${Store.data.voices.openai}</code>`, parseMode: "html" });
              return;
            }
            if (!OPENAI_VOICES.includes(voiceName as any)) {
              await msg.edit({ text: `❌ 未知音色: ${html(voiceName)}\n使用 <code>ai voice list</code> 查看可用音色`, parseMode: "html" });
              return;
            }
            Store.data.voices.openai = voiceName;
            await Store.writeSoon();
            await msg.edit({ text: `✅ 已设置 OpenAI 音色: <code>${html(voiceName)}</code>`, parseMode: "html" });
            return;
          }
          await msg.edit({ text: "❌ 未知 voice 子命令\n支持: list|show|gemini <音色>|openai <音色>", parseMode: "html" });
          return;
        }

        /* ---------- 超时设置 ---------- */
        if (subn === "timeout") {
          const a0 = (args[0] || "").toLowerCase();
          if (a0 === "show" || !a0) {
            const current = Store.data.timeout || DEFAULT_TIMEOUT_MS;
            await msg.edit({ text: `⏱️ 当前超时时间: <code>${current / 1000}秒</code>`, parseMode: "html" });
            return;
          }
          if (a0 === "set") {
            const val = args[1];
            if (!val) {
              await msg.edit({ text: "❌ 请指定超时时间（秒）\n例如: <code>ai timeout set 180</code> 设置为180秒", parseMode: "html" });
              return;
            }
            const sec = parseInt(val);
            if (!isFinite(sec) || sec < 10 || sec > 600) {
              await msg.edit({ text: "❌ 超时时间必须在 10-600 秒之间（最多10分钟）", parseMode: "html" });
              return;
            }
            Store.data.timeout = sec * 1000;
            await Store.writeSoon();
            await msg.edit({ text: `✅ 已设置超时时间: <code>${sec}秒</code>`, parseMode: "html" });
            return;
          }
          if (a0 === "reset") {
            Store.data.timeout = DEFAULT_TIMEOUT_MS;
            await Store.writeSoon();
            await msg.edit({ text: `✅ 已重置超时时间为默认值: <code>${DEFAULT_TIMEOUT_MS / 1000}秒</code>`, parseMode: "html" });
            return;
          }
          await msg.edit({ text: "❌ 未知 timeout 子命令\n支持: show|set <秒>|reset", parseMode: "html" });
          return;
        }

        /* ---------- 最大输出 Token 设置 ---------- */
        if (subn === "maxtokens" || subn === "tokens" || subn === "maxtoken") {
          const a0 = (args[0] || "").toLowerCase();
          if (a0 === "show" || !a0) {
            const current = Store.data.maxTokens || DEFAULT_MAX_TOKENS;
            const approxChars = Math.floor(current / 2); // 大约1 token = 0.5个中文字
            await msg.edit({ text: `📝 当前最大输出 Token: <code>${current}</code>\n约等于 <code>${approxChars}</code> 个中文字\n\n💡 生成超长文本时建议同时增加超时时间`, parseMode: "html" });
            return;
          }
          if (a0 === "set") {
            const val = args[1];
            if (!val) {
              await msg.edit({ text: "❌ 请指定最大 token 数\n例如: <code>ai maxtokens set 32768</code> 设置为32768", parseMode: "html" });
              return;
            }
            const num = parseInt(val);
            if (!isFinite(num) || num < 100 || num > 128000) {
              await msg.edit({ text: "❌ Token 数必须在 100-128000 之间", parseMode: "html" });
              return;
            }
            Store.data.maxTokens = num;
            await Store.writeSoon();
            const approxChars = Math.floor(num / 2);
            await msg.edit({ text: `✅ 已设置最大输出 Token: <code>${num}</code>\n约等于 <code>${approxChars}</code> 个中文字\n\n💡 建议同时设置超时: <code>ai timeout set 300</code>`, parseMode: "html" });
            return;
          }
          if (a0 === "reset") {
            Store.data.maxTokens = DEFAULT_MAX_TOKENS;
            await Store.writeSoon();
            await msg.edit({ text: `✅ 已重置最大输出 Token 为默认值: <code>${DEFAULT_MAX_TOKENS}</code>`, parseMode: "html" });
            return;
          }
          await msg.edit({ text: "❌ 未知 maxtokens 子命令\n支持: show|set <数量>|reset", parseMode: "html" });
          return;
        }

        /* ---------- 链接预览开关 ---------- */
        if (subn === "preview") {
          const a0 = (args[0] || "").toLowerCase();
          if (a0 === "on") {
            Store.data.linkPreview = true;
            await Store.writeSoon();
            await msg.edit({ text: "✅ 已开启链接预览", parseMode: "html" });
            return;
          }
          if (a0 === "off") {
            Store.data.linkPreview = false;
            await Store.writeSoon();
            await msg.edit({ text: "✅ 已关闭链接预览", parseMode: "html" });
            return;
          }
          const current = Store.data.linkPreview !== false;
          await msg.edit({ text: `🔗 链接预览: ${current ? "开启" : "关闭"}\n\n用法: <code>ai preview on|off</code>`, parseMode: "html" });
          return;
        }

        /* ---------- 对话 / 搜索 ---------- */
        if (subn === "chat" || subn === "search" || !subn || isUnknownBareQuery) {
          const replyMsg = await msg.getReplyMessage();
          const isSearch = subn === "search";
          const plain = (((isUnknownBareQuery ? [sub, ...args] : args).join(" ") || "").trim());

          // 仿照 temp/ai (10).ts 的逻辑处理上下文
          let question = plain;
          let context = "";

          // 尝试智能获取媒体（支持图片、GIF、Sticker等）
          // 如果有回复消息，优先用回复消息的媒体；否则尝试当前消息
          const mediaTarget = replyMsg && (replyMsg as any).media ? replyMsg : ((msg as any).media ? msg : null);
          const mediaData = mediaTarget ? await downloadMessageMediaAsData(mediaTarget) : null;
          const hasImage = !!mediaData;

          if (replyMsg) {
            // 优先使用被引用的部分，如果没有则使用整条消息
            context = extractQuoteOrReplyText(msg, replyMsg).trim();
            // 如果回复的是图片消息但没有文字内容，补充说明
            if (!context && hasImage && mediaTarget === replyMsg) {
              context = "[用户引用了一张图片]";
            }
          }

          // 如果用户没有输入问题（只发了 .ai），则直接把引用消息当作问题
          if (!question && context) {
            question = context;
            context = ""; // 避免重复，既然当作问题了就不用作上下文了
          }

          if (!question && !hasImage) {
            await msg.edit({ text: "❌ 请输入内容或回复一条消息", parseMode: "html" });
            return;
          }

          // 构建最终发给 AI 的内容 (Prompt)
          // 格式：
          // 引用消息:
          // [内容]
          //
          // 用户消息:
          // [内容]
          let q = question;
          if (context) {
            q = `引用消息:\n${context}\n\n用户消息:\n${question}`;
          }
          await msg.edit({ text: "🔄 处理中...", parseMode: "html" });
          const pre = await preflight(isSearch ? "search" : "chat");
          if (!pre) return;
          const { m, p, compat } = pre;

          let content = "";
          let usedModel = m.model;
          if (hasImage && mediaData) {
            try {
              const b64 = mediaData.buffer.toString("base64");
              const processedPrompt = applyPresetPrompt(q || "描述这张图片");
              // 传入 mime 以支持不同格式（虽然目前转为 PNG 或原格式）
              content = await chatVision(p, compat, m.model, b64, processedPrompt, mediaData.mime);
            } catch (e: any) {
              await msg.edit({ text: `❌ 处理图片失败：${html(mapError(e, "vision"))}`, parseMode: "html" });
              return;
            }
          } else {
            const res = await callChat(isSearch ? "search" : "chat", q, msg);
            content = res.content;
            usedModel = res.model;
          }

          // 处理 AI 响应：提取内嵌图片，清理思考标签
          const processed = processAIResponse(content);
          const replyToId = replyMsg?.id || 0;
          const footTxt = footer(usedModel, isSearch ? "with Search" : "");

          // 如果响应中包含内嵌图片，先发送图片
          if (processed.images.length > 0) {
            for (const img of processed.images) {
              try {
                const buf = Buffer.from(img.data, "base64");
                const caption = img.alt ? `🖼️ ${html(img.alt)}` : `🖼️ AI 生成的图片`;
                await sendImageFile(msg, buf, caption + footTxt, replyToId, img.mime);
              } catch {
                // 图片发送失败，继续处理
              }
            }
            // 如果只有图片没有其他文字内容，删除原消息并返回
            const textContent = processed.text.replace(/\[图片\]/g, "").replace(/\[图片数据\]/g, "").trim();
            if (!textContent || textContent.length < 10) {
              try { await msg.delete({ revoke: true }); } catch { /* 忽略删除失败 */ }
              return;
            }
            // 如果还有文字内容，继续处理
            content = processed.text;
          } else {
            // 即使没有图片也要清理思考标签
            content = processed.text;
          }

          const full = formatQA(q || "(图片)", content);

          if (Store.data.telegraph.enabled && Store.data.telegraph.limit > 0 && full.length > Store.data.telegraph.limit) {
            const tgContent = `Q: ${q || "(图片)"}\n\nA: ${content}`;
            const urls = await createTGPage("TeleBox AI", tgContent);
            if (urls.length > 0) {
              // 保存历史记录（倒序插入，保持时间顺序）
              for (let i = urls.length - 1; i >= 0; i--) {
                Store.data.telegraph.posts.unshift({ title: (q || "图片").slice(0, 30) || "AI", url: urls[i], createdAt: nowISO() });
              }
              Store.data.telegraph.posts = Store.data.telegraph.posts.slice(0, 10);
              await Store.writeSoon();

              const links = urls.map((u, i) => {
                const num = urls.length > 1 ? (['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][i] || (i + 1)) : '';
                return `🔗 <a href="${u}">点我阅读内容${num}</a>`;
              }).join("\n\n");
              const linkText = `📰 内容较长，Telegraph观感更好喔:\n\n${links}`;

              const tgMsg = `Q:\n${q || "(图片)"}\n\nA:\n${linkText}\n${footTxt}`;
              try { await msg.delete({ revoke: true }); } catch { /* 忽略删除失败 */ }
              if (msg.client) {
                await msg.client.sendMessage(msg.peerId, {
                  message: tgMsg,
                  parseMode: "html",
                  replyTo: replyToId || undefined,
                  linkPreview: Store.data.linkPreview !== false
                });
              }
              return;
            }
          }
          // 发送结果并删除原消息
          try { await msg.delete({ revoke: true }); } catch { /* 忽略删除失败 */ }
          const chunks = buildChunks(full, Store.data.collapse, footTxt);
          if (msg.client && chunks.length > 0) {
            const peer = msg.peerId;
            for (const chunk of chunks) {
              await msg.client.sendMessage(peer, {
                message: chunk,
                parseMode: "html",
                replyTo: replyToId || undefined
              });
            }
          }
          return;
        }

        /* ---------- 生图 ---------- */
        if (subn === "image") {
          const replyMsg = await msg.getReplyMessage();
          const fullText = (msg as any).text || (msg as any).message || "";
          const imagePromptMatch = fullText.match(/^[.\-\/!]ai\s+(?:image|img|i)\s+([\s\S]*)$/im);
          const userInput = (imagePromptMatch ? imagePromptMatch[1].trim() : args.join(" ").trim());
          const replyContent = extractQuoteOrReplyText(msg, replyMsg).trim();

          // 检查是否有回复的图片（图生图模式）
          const mediaTarget = replyMsg && (replyMsg as any).media ? replyMsg : null;
          const mediaData = mediaTarget ? await downloadMessageMediaAsData(mediaTarget) : null;
          const hasSourceImage = !!mediaData;

          // 结合用户输入和引用内容
          let prm = "";
          if (userInput) {
            prm = userInput;
          } else if (replyContent && !hasSourceImage) {
            prm = replyContent;
          } else if (hasSourceImage) {
            prm = "请基于这张图片进行创作";
          }
          if (!prm && !hasSourceImage) {
            await msg.edit({ text: "❌ 请输入提示词", parseMode: "html" });
            return;
          }
          const pre = await preflight("image");
          if (!pre) return;
          const { m, p, compat } = pre;
          const replyToId = replyMsg?.id || 0;

          await msg.edit({ text: hasSourceImage ? "🎨 图生图处理中..." : "🎨 生成中...", parseMode: "html" });

          if (compat === "openai") {
            // OpenAI 兼容模式：支持图生图
            const sourceImage = hasSourceImage && mediaData ? {
              data: mediaData.buffer.toString("base64"),
              mime: mediaData.mime
            } : undefined;
            const b64 = await imageOpenAI(p, m.model, prm, sourceImage);
            if (!b64) {
              await msg.edit({ text: "❌ 图片生成失败：服务无有效输出", parseMode: "html" });
              return;
            }
            const buf = Buffer.from(b64, "base64");
            const caption = hasSourceImage ? `🖼️ AI 图生图` : `🖼️ AI 生成图片`;
            await sendImageFile(msg, buf, caption + footer(m.model), replyToId);
            await msg.delete();
            return;
          } else if (compat === "gemini") {
            try {
              // 如果有源图片，传入图生图模式
              const sourceImage = hasSourceImage && mediaData ? {
                data: mediaData.buffer.toString("base64"),
                mime: mediaData.mime
              } : undefined;
              const { image, text, mime } = await imageGemini(p, m.model, prm, sourceImage);
              if (image) {
                const caption = hasSourceImage ? `🖼️ AI 图生图` : `🖼️ AI 生成图片`;
                await sendImageFile(msg, image, caption + footer(m.model), replyToId, mime);
                await msg.delete();
                return;
              }
              if (text) {
                const textOut = formatQA(prm, text);
                await sendLongAuto(msg, textOut, replyToId, { collapse: Store.data.collapse }, footer(m.model));
                await msg.delete();
                return;
              }
              await msg.edit({ text: "❌ 图片生成失败：服务无有效输出", parseMode: "html" });
              return;
            } catch (e: any) {
              await msg.edit({ text: `❌ 图片生成失败：${html(mapError(e, "image"))}`, parseMode: "html" });
              return;
            }
          } else {
            await msg.edit({ text: "❌ 当前服务商不支持图片生成功能", parseMode: "html" });
            return;
          }
        }

        /* ---------- 语音回答 ---------- */
        if (subn === "audio" || subn === "searchaudio") {
          const replyMsg = await msg.getReplyMessage();
          const plain = (args.join(" ") || "").trim();

          // 仿照 temp/ai (10).ts 的逻辑处理上下文 (Voice版)
          let question = plain;
          let context = "";

          if (replyMsg) {
            context = extractQuoteOrReplyText(msg, replyMsg).trim();
          }

          if (!question && context) {
            question = context;
            context = "";
          }

          if (!question) { await msg.edit({ text: "❌ 请输入内容或回复一条消息", parseMode: "html" }); return; }

          // 构建 Prompt
          let q = question;
          if (context) {
            q = `引用消息:\n${context}\n\n用户消息:\n${question}`;
          }
          await msg.edit({ text: "🔄 处理中...", parseMode: "html" });
          const res = await callChat(subn === "searchaudio" ? "search" : "chat", q, msg);
          await executeTTS(msg, res.content, replyMsg?.id || 0);
          return;
        }


        /* ---------- TTS ---------- */
        if (subn === "tts") {
          const replyMsg = await msg.getReplyMessage();
          const t = (args.join(" ") || "").trim() || extractQuoteOrReplyText(msg, replyMsg).trim();
          if (!t) { await msg.edit({ text: "❌ 请输入文本", parseMode: "html" }); return; }
          await executeTTS(msg, t, replyMsg?.id || 0);
          return;
        }

        /* ---------- 兜底 ---------- */
        await msg.edit({ text: "❌ 未知子命令", parseMode: "html" });
        return;
      } catch (e: any) {
        await msg.edit({ text: `❌ 出错：${html(mapError(e, subn))}`, parseMode: "html" });
        return;
      }
    }
  };

  // 资源清理方法 - 防止内存泄漏
  async cleanup(): Promise<void> {
    try {
      // 清理 Store 写入定时器
      if (Store._writeTimer) {
        clearTimeout(Store._writeTimer);
        Store._writeTimer = null;
      }
      // 清理模型刷新防抖定时器
      if (refreshDebounceTimer) {
        clearTimeout(refreshDebounceTimer);
        refreshDebounceTimer = null;
      }
      // 清理兼容性解析缓存
      compatResolving.clear();
      // 清理 Anthropic 版本缓存
      anthropicVersionCache.clear();
    } catch {
      // 清理失败时静默处理
    }
  }
}

export default new AiPlugin();

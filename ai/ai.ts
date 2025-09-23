import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs";
import { createDirectoryInAssets } from "@utils/pathHelpers";

// ---- 存储 ----
type Provider = { apiKey: string; baseUrl: string; compatauth?: Compat; authMethod?: AuthMethod; authConfig?: AuthConfig };
type Compat = "openai" | "gemini" | "claude";
type Models = { chat: string; search: string; image: string; tts: string };
type Telegraph = { enabled: boolean; limit: number; token: string; posts: { title: string; url: string; createdAt: string }[] };
type DB = { dataVersion?: number; providers: Record<string, Provider>; modelCompat?: Record<string, Record<string, Compat>>; modelCatalog?: { map: Record<string, Compat>; updatedAt?: string }; models: Models; contextEnabled: boolean; collapse: boolean; telegraph: Telegraph; histories: Record<string, { role: string; content: string }[]>; histMeta?: Record<string, { lastAt: string }> };

const MAX_MSG = 4096;
const PAGE_EXTRA = 32;
const WRAP_EXTRA_COLLAPSED = 64;
const trimBase = (u: string) => u.replace(/\/$/, "");
const html = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function shortenUrlForDisplay(u: string): string {
  try {
    const url = new URL(u);
    const host = url.hostname;
    const path = url.pathname && url.pathname !== "/" ? url.pathname : "";
    let text = host + path;
    if (text.length > 60) {
      const head = text.slice(0, 45);
      const tail = text.slice(-10);
      text = head + "…" + tail;
    }
    return text || u;
  } catch {
    return u.length > 60 ? (u.slice(0, 45) + "…" + u.slice(-10)) : u;
  }
}
const nowISO = () => new Date().toISOString();
const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
function shouldRetry(err: any): boolean {
  const s = err?.response?.status;
  const code = err?.code;
  return s === 429 || s === 500 || s === 502 || s === 503 || s === 504 ||
         code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" ||
         !!(err?.isAxiosError && !err?.response);
}
async function axiosWithRetry<T = any>(config: AxiosRequestConfig, tries = 2, backoffMs = 500): Promise<AxiosResponse<T>> {
  let attempt = 0; let lastErr: any;
  const defaultTimeout = config.url?.includes('/messages') ? 90000 : 30000;
  const baseConfig: AxiosRequestConfig = { timeout: defaultTimeout, ...config };
  while (attempt <= tries) {
    try {
      return await axios(baseConfig);
    } catch (err: any) {
      lastErr = err;
      if (attempt >= tries || !shouldRetry(err)) throw err;
      const jitter = Math.floor(Math.random() * 200);
      await sleep(backoffMs * Math.pow(2, attempt) + jitter);
      attempt++;
    }
  }
  throw lastErr;
}

// 原子 JSON 写入：写临时文件后 rename 覆盖，避免部分写入
async function atomicWriteJSON(file: string, data: any) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  const json = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(tmp, json, { encoding: "utf8" });
  await fs.promises.rename(tmp, file);
}

// 通用权鉴处理器枚举和接口
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

// 通用权鉴处理器
class UniversalAuthHandler {
  static buildAuthHeaders(config: AuthConfig): Record<string, string> {
    const headers: Record<string, string> = {};
    
    switch (config.method) {
      case AuthMethod.BEARER_TOKEN:
        headers["Authorization"] = `Bearer ${config.apiKey}`;
        break;
      case AuthMethod.API_KEY_HEADER:
        const headerName = config.headerName || "X-API-Key";
        headers[headerName] = config.apiKey;
        break;
      case AuthMethod.CUSTOM_HEADER:
        if (config.headerName) {
          headers[config.headerName] = config.apiKey;
        }
        break;
      case AuthMethod.BASIC_AUTH:
        const credentials = Buffer.from(`${config.username || config.apiKey}:${config.password || ""}`).toString('base64');
        headers["Authorization"] = `Basic ${credentials}`;
        break;
    }
    
    return headers;
  }
  
  static buildAuthParams(config: AuthConfig): Record<string, string> {
    const params: Record<string, string> = {};
    
    if (config.method === AuthMethod.QUERY_PARAM) {
      const paramName = config.paramName || "key";
      params[paramName] = config.apiKey;
    }
    
    return params;
  }
  
  static detectAuthMethod(baseUrl: string, _apiKey: string): AuthMethod {
    const url = baseUrl.toLowerCase();
    
    // 谷歌 Gemini 接口
    if (url.includes("generativelanguage.googleapis.com") || url.includes("aiplatform.googleapis.com")) {
      return AuthMethod.QUERY_PARAM;
    }
    
    // Anthropic Claude 接口
    if (url.includes("anthropic.com")) {
      return AuthMethod.API_KEY_HEADER;
    }
    
    // 百度文心一言
    if (url.includes("aip.baidubce.com")) {
      return AuthMethod.QUERY_PARAM;
    }
    
    // 默认使用Bearer Token（适用于OpenAI及大多数兼容接口）
    return AuthMethod.BEARER_TOKEN;
  }
}

// 统一的鉴权尝试构建器
function buildAuthAttempts(p: Provider, extraHeaders: Record<string, string> = {}) {
  if (p.authConfig) {
    const authHeaders = UniversalAuthHandler.buildAuthHeaders(p.authConfig);
    const authParams = UniversalAuthHandler.buildAuthParams(p.authConfig);
    return [{ headers: { ...authHeaders, ...extraHeaders }, params: authParams }];
  }
  
  // 智能检测权鉴方式
  const detectedMethod = UniversalAuthHandler.detectAuthMethod(p.baseUrl, p.apiKey);
  const authConfig: AuthConfig = {
    method: detectedMethod,
    apiKey: p.apiKey,
    headerName: detectedMethod === AuthMethod.API_KEY_HEADER ? "x-api-key" : undefined,
    paramName: detectedMethod === AuthMethod.QUERY_PARAM ? "key" : undefined
  };
  
  const smartAuthHeaders = UniversalAuthHandler.buildAuthHeaders(authConfig);
  const smartAuthParams = UniversalAuthHandler.buildAuthParams(authConfig);
  
  return [{ headers: { ...smartAuthHeaders, ...extraHeaders }, params: smartAuthParams }];
}
async function tryPostJSON(url: string, body: any, attempts: Array<{ headers?: any; params?: any }>): Promise<any> {
  let lastErr: any;
  for (const a of attempts) {
    try {
      const r = await axiosWithRetry({ method: "POST", url, data: body, ...(a || {}) });
      return r.data;
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr;
}

class Store {
  static db: any = null;
  static data: DB = {
    providers: {},
    models: { chat: "", search: "", image: "", tts: "" },
    contextEnabled: false,
    collapse: false,
    telegraph: { enabled: false, limit: 0, token: "", posts: [] },
    histories: {}
  };
  static baseDir: string = "";
  static file: string = "";
  static async init() {
    if (this.db) return;
    this.baseDir = createDirectoryInAssets("ai");
    this.file = path.join(this.baseDir, "config.json");
    this.db = await JSONFilePreset<DB>(this.file, {
      providers: {},
      models: { chat: "", search: "", image: "", tts: "" },
      contextEnabled: false, collapse: false,
      telegraph: { enabled: false, limit: 0, token: "", posts: [] },
      histories: {}
    });
    this.data = this.db.data;
    // 数据结构迁移：dataVersion / modelCompat / histMeta
    const d: any = this.data;
    if (typeof d.dataVersion !== "number") d.dataVersion = 1;
    if (!d.providers) d.providers = {};
    if ((d as any).compat) delete (d as any).compat;
    if (!d.modelCompat) d.modelCompat = {};
    if (!d.modelCatalog) d.modelCatalog = { map: {}, updatedAt: undefined };
    if (!d.models) d.models = { chat: "", search: "", image: "", tts: "" };
    if (typeof d.contextEnabled !== "boolean") d.contextEnabled = false;
    if (typeof d.collapse !== "boolean") d.collapse = false;
    if (!d.telegraph) d.telegraph = { enabled: false, limit: 0, token: "", posts: [] };
    if (!d.histories) d.histories = {};
    if (!d.histMeta) d.histMeta = {};
    if (d.dataVersion < 2) d.dataVersion = 2;
    if (d.dataVersion < 3) {
      try {
        await refreshModelCatalog(true);
        const catMap: Record<string, Compat> = (((Store.data.modelCatalog?.map) || {}) as Record<string, Compat>);
        const providers = Store.data.providers || {};
        const mc = Store.data.modelCompat || {};
        for (const [prov, mm] of Object.entries(mc)) {
          const provCfg = (providers as any)[prov] as Provider | undefined;
          const base = provCfg?.baseUrl || "";
          const dict = mm as Record<string, Compat>;
          for (const [k0, v0] of Object.entries(dict)) {
            const k = String(k0 || "").toLowerCase();
            const cur = v0 as Compat;
            const cat = (catMap as any)[k] as Compat | undefined;
            if (cat && cat !== cur) {
              dict[k] = cat;
              continue;
            }
            if (!cat && cur === "openai") {
              const inf = detectCompat(prov, k, base);
              if (inf === "gemini" || inf === "claude") {
                dict[k] = inf;
              }
            }
          }
        }
      } catch {}
      d.dataVersion = 3;
    }
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

function applyWrap(s: string, collapse?: boolean) { 
  if (!collapse) return s; 
  if (/<blockquote(?:\s|>|\/)\/?>/i.test(s) || /<blockquote(?:\s|>|\/)/i.test(s)) return s; 
  return `<span class="tg-spoiler">${s}</span>`; 
}
// 构建分片，可选折叠包装与页脚；最后一片附加后缀（若提供）
function buildChunks(text: string, collapse?: boolean, postfix?: string): string[] {
  const WRAP_EXTRA = collapse ? WRAP_EXTRA_COLLAPSED : 0;
  const parts = splitMessage(text, PAGE_EXTRA + WRAP_EXTRA);
  if (parts.length === 0) return [];
  if (parts.length === 1) {
    return [applyWrap(parts[0], collapse) + (postfix || "")];
  }
  const total = parts.length; const chunks: string[] = [];
  for (let i = 0; i < total; i++) {
    const isLast = i === total - 1;
    const body = parts[i] + `\n\n📄 (${i + 1}/${total})`;
    const wrapped = applyWrap(body, collapse) + (isLast ? (postfix || "") : "");
    chunks.push(wrapped);
  }
  return chunks;
}
// 确保页脚不被折叠：通过 sendLong 系列在折叠外追加
async function sendLong(msg: Api.Message, text: string, opts?: { collapse?: boolean }, postfix?: string) {
  const chunks = buildChunks(text, opts?.collapse, postfix);
  if (chunks.length === 0) return;
  if (chunks.length === 1) { await msg.edit({ text: chunks[0], parseMode: "html" }); return; }
  await msg.edit({ text: chunks[0], parseMode: "html" });
  for (let i = 1; i < chunks.length; i++) {
    await msg.reply({ message: chunks[i], parseMode: "html" });
  }
}
async function sendLongReply(msg: Api.Message, replyToId: number, text: string, opts?: { collapse?: boolean }, postfix?: string) {
  const chunks = buildChunks(text, opts?.collapse, postfix);
  if (!msg.client) return; const peer = msg.peerId;
  for (const chunk of chunks) {
    await msg.client.sendMessage(peer, { message: chunk, parseMode: "html", replyTo: replyToId });
  }
}
function extractText(m: Api.Message | null | undefined): string {
  if (!m) return "";
  const anyM: any = m as any;
  return (anyM.message || anyM.text || anyM.caption || "");
}
function splitMessage(text: string, reserve = 0): string[] {
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
}
function detectCompat(_name: string, model: string, _baseUrl: string): Compat {
  const m = (model || "").toLowerCase();
  if (/\bclaude\b|anthropic/.test(m)) return "claude";
  if (/\bgemini\b|(^gemini-)|image-generation/.test(m)) return "gemini";
  if (/(^gpt-|gpt-4o|gpt-image|dall-e|^tts-1\b)/.test(m)) return "openai";
  return "openai";
}
// 新增：全局模型目录（catalog）与查询/刷新
const catalogInflight: { refreshing: boolean; lastPromise: Promise<void> | null } = { refreshing: false, lastPromise: null };
function getCompatFromCatalog(model: string): Compat | null {
  const ml = String(model || "").toLowerCase();
  const map = Store.data.modelCatalog?.map || ({} as Record<string, Compat>);
  const v = (map as any)[ml] as Compat | undefined;
  return v ?? null;
}
async function refreshModelCatalog(force = false): Promise<void> {
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
          for (const [k, v] of (Object.entries(mp) as Array<[string, Compat]>)) {
            merged[k] = v;
          }
        } catch {}
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
}
const compatResolving = new Map<string, Promise<Compat>>();
async function resolveCompat(name: string, model: string, p: Provider): Promise<Compat> {
  const ml = String(model || "").toLowerCase();
  const cat = getCompatFromCatalog(ml);
  if (cat) return cat;
  const mc = (Store.data.modelCompat && (Store.data.modelCompat as any)[name]) ? (Store.data.modelCompat as any)[name][ml] as Compat | undefined : undefined;
  const byName = detectCompat(name, model, p.baseUrl);
  if (mc) return mc;
  refreshModelCatalog(false).catch(() => {});
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
        if (cur !== v) { (Store.data.modelCompat as any)[name][k] = v; }
      }
      let comp: Compat = (Store.data.modelCompat as any)[name][ml] as Compat;
      if (!comp) comp = (primary as Compat) || byName;
      if (((Store.data.modelCompat as any)[name][ml] as Compat | undefined) !== comp) { (Store.data.modelCompat as any)[name][ml] = comp; }
      const cat = (Store.data.modelCatalog ??= { map: {}, updatedAt: undefined } as any);
      const catMap = (cat as any).map as Record<string, Compat>;
      for (const [k, v] of Object.entries(map)) { if ((catMap as any)[k] !== v) (catMap as any)[k] = v as Compat; }
      if ((catMap as any)[ml] !== comp) (catMap as any)[ml] = comp;
      (cat as any).updatedAt = nowISO();
      if (primary && p) { if (p.compatauth !== primary) { p.compatauth = primary; } }
      await Store.writeSoon();
      return comp;
    } catch {
      const comp: Compat = byName;
      if (!Store.data.modelCompat) Store.data.modelCompat = {} as any;
      if (!(Store.data.modelCompat as any)[name]) (Store.data.modelCompat as any)[name] = {} as any;
      if (!(Store.data.modelCompat as any)[name][ml]) { (Store.data.modelCompat as any)[name][ml] = comp; try { await Store.writeSoon(); } catch {} }
      refreshModelCatalog(false).catch(() => {});
      return comp;
    } finally {
      compatResolving.delete(name + "::" + ml);
      compatResolving.delete(name);
    }
  })();
  compatResolving.set(name + "::" + ml, task);
  return await task;
}
// 统一错误提示映射
function mapError(err: any, ctx?: string): string {
  const s = err?.response?.status as number | undefined;
  const body = err?.response?.data;
  const raw = body?.error?.message || body?.message || err?.message || String(err);
  let hint = "";
  if (s === 401 || s === 403) hint = "认证失败，请检查 API Key 是否正确、是否有对应权限";
  else if (s === 404) hint = "接口不存在，请检查 BaseURL/兼容类型或服务商路由";
  else if (s === 429) hint = "请求过于频繁或额度受限，请稍后重试或调整速率";
  else if (typeof s === "number" && s >= 500) hint = "服务端异常，请稍后重试或更换服务商";
  else if (!s) hint = "网络异常，请检查网络或 BaseURL";
  const where = ctx ? `（${ctx}）` : "";
  return `${raw}${hint ? "｜" + hint : ""}${s ? `｜HTTP ${s}` : ""}${where}`;
}
// 规范化模型 id/name，提取短名用于显示与配置
function normalizeModelName(x: any): string {
  let s = String(x?.id || x?.slug || x?.name || x || "");
  s = s.trim();
  // 防御性处理：去除查询参数与片段
  const q = s.indexOf("?"); if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf("#"); if (h >= 0) s = s.slice(0, h);
  // 常见前缀：models/<id>、publishers/.../models/<id>、projects/.../locations/.../models/<id>
  if (s.includes("/")) s = (s.split("/").pop() || s);
  return s.trim();
}
function pick(kind: keyof Models): { provider: string; model: string } | null {
  const s = Store.data.models[kind]; if (!s) return null; const i = s.indexOf(" "); if (i <= 0) return null;
  const provider = s.slice(0, i); const model = s.slice(i + 1);
  return { provider, model };
}
function providerOf(name: string): Provider | null { return Store.data.providers[name] || null; }
function footer(model: string, extra?: string) { const src = model.toLowerCase().includes("claude") ? "Anthropic Claude" : model.toLowerCase().includes("gemini") ? "Google Gemini" : "OpenAI"; return `\n\n<i>Powered by ${src}${extra ? " " + extra : ""}</i>`; }
function ensureDir() { if (!fs.existsSync(Store.baseDir)) fs.mkdirSync(Store.baseDir, { recursive: true }); }
function chatIdStr(msg: Api.Message) { return String((msg.peerId as any)?.channelId || (msg.peerId as any)?.userId || (msg.peerId as any)?.chatId || "global"); }
function histFor(id: string) { return Store.data.histories[id] || []; }
const HISTORY_GLOBAL_MAX_SESSIONS = 200;
const HISTORY_GLOBAL_MAX_BYTES = 2 * 1024 * 1024; // 2MB
function pruneGlobalHistories() {
  const ids = Object.keys(Store.data.histories || {});
  if (!ids.length) return;
  const meta = (Store.data.histMeta || {}) as Record<string, { lastAt: string }>;
  const sizeOfItem = (x: { role: string; content: string }) => Buffer.byteLength(`${x.role}:${x.content}`);
  const sizeOfHist = (arr: { role: string; content: string }[]) => arr.reduce((t, x) => t + sizeOfItem(x), 0);
  let totalBytes = 0;
  for (const id of ids) totalBytes += sizeOfHist(Store.data.histories[id] || []);
  if (ids.length <= HISTORY_GLOBAL_MAX_SESSIONS && totalBytes <= HISTORY_GLOBAL_MAX_BYTES) return;
  const sorted = ids.sort((a, b) => {
    const mm = meta || {} as Record<string, { lastAt: string }>;
    const ta = Date.parse(mm[a]?.lastAt || "1970-01-01T00:00:00.000Z");
    const tb = Date.parse(mm[b]?.lastAt || "1970-01-01T00:00:00.000Z");
    return ta - tb;
  });
  while ((sorted.length > HISTORY_GLOBAL_MAX_SESSIONS || totalBytes > HISTORY_GLOBAL_MAX_BYTES) && sorted.length) {
    const victim = sorted.shift()!;
    const arr = Store.data.histories[victim] || [];
    totalBytes -= sizeOfHist(arr);
    delete Store.data.histories[victim];
    if (Store.data.histMeta) delete Store.data.histMeta[victim];
  }
}
function pushHist(id: string, role: string, content: string) {
  if (!Store.data.histories[id]) Store.data.histories[id] = [];
  Store.data.histories[id].push({ role, content });
  const h = Store.data.histories[id];
  const MAX_ITEMS = 50;
  while (h.length > MAX_ITEMS) h.shift();
  const MAX_BYTES = 64 * 1024; // 64KB
  const sizeOf = (x: { role: string; content: string }) => Buffer.byteLength(`${x.role}:${x.content}`);
  let total = 0;
  for (const x of h) total += sizeOf(x);
  while (total > MAX_BYTES && h.length > 1) { const first = h.shift()!; total -= sizeOf(first); }
  if (!Store.data.histMeta) Store.data.histMeta = {} as any;
  (Store.data.histMeta as any)[id] = { lastAt: new Date().toISOString() };
  pruneGlobalHistories();
}
// 基础文本清理（去除不可见字符、统一换行与标准化）
function cleanTextBasic(t: string): string {
  if (!t) return "";
  return t
    .replace(/\uFEFF/g, "")
    .replace(/[\uFFFC\uFFFF\uFFFE]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u200B\u200C\u200D\u2060]/g, "")
    .normalize('NFKC');
}
// 转义为 HTML，并将纯文本 URL 转为 <a> 链接；行首 > 转为引用块
function escapeAndFormatForTelegram(raw: string): string {
  const cleaned = cleanTextBasic(raw || "");
  let escaped = html(cleaned);
  const urlRegex = /\bhttps?:\/\/[^\s<>")'\]}]+/g;
  const urls = cleaned.match(urlRegex) || [];
  for (const u of urls) {
    const display = shortenUrlForDisplay(u);
    const escapedUrl = html(u);
    const anchor = `<a href="${html(u)}">${html(display)}</a>`;
    escaped = escaped.replace(new RegExp(escapeRegExp(escapedUrl), "g"), anchor);
  }
  escaped = escaped.replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>');
  return escaped;
}
// 判断是否为“路由不存在”类错误；用于 /v1beta -> /v1 降级
function isRouteError(err: any): boolean {
  const s = err?.response?.status;
  const txt = String(err?.response?.data || err?.message || "").toLowerCase();
  return s === 404 || s === 405 || (s === 400 && /(unknown|not found|invalid path|no route)/.test(txt));
}
// 通用：Gemini 从 /v1beta -> /v1 的降级请求助手，并在鉴权方式间回退（params.key 与 Authorization Bearer 互换）
async function geminiRequestWithFallback(p: Provider, path: string, axiosConfig: any): Promise<any> {
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
    const seen = new Set<string>(); const out: any[] = [];
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
}
// 动态发现并缓存 Anthropic 版本
const anthropicVersionCache = new Map<string, string>();
async function getAnthropicVersion(p: Provider): Promise<string> {
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
}
function formatQA(qRaw: string, aRaw: string): string {
  const expandAttr = Store.data.collapse ? " expandable" : "";
  const qEsc = escapeAndFormatForTelegram(qRaw);
  const aEsc = escapeAndFormatForTelegram(aRaw);
  const Q = `<b>Q:</b>\n<blockquote${expandAttr}>${qEsc}</blockquote>`;
  const A = `<b>A:</b>\n<blockquote${expandAttr}>${aEsc}</blockquote>`;
  return `${Q}\n\n${A}`;
}

function toNodes(text: string) { return JSON.stringify(text.split("\n\n").map(p => ({ tag: "p", children: [p] }))); }
async function ensureTGToken(): Promise<string> {
  if (Store.data.telegraph.token) return Store.data.telegraph.token;
  const resp = await axiosWithRetry({
    method: "POST",
    url: "https://api.telegra.ph/createAccount",
    params: { short_name: "TeleBoxAI", author_name: "TeleBox" }
  });
  const t = resp.data?.result?.access_token || ""; Store.data.telegraph.token = t; await Store.writeSoon(); return t;
}
async function createTGPage(title: string, text: string): Promise<string | null> {
  try {
    const token = await ensureTGToken(); if (!token) return null;
    const resp = await axiosWithRetry({
      method: "POST",
      url: "https://api.telegra.ph/createPage",
      params: { access_token: token, title, content: toNodes(text), return_content: false }
    });
    return resp.data?.result?.url || null;
  } catch { return null; }
}

async function chatOpenAI(p: Provider, model: string, msgs: { role: string; content: string }[], maxTokens?: number, useSearch?: boolean) {
  const url = trimBase(p.baseUrl) + "/v1/chat/completions";
  const body: any = { model, messages: msgs, max_tokens: maxTokens || 1024 };
  if (useSearch && p.baseUrl?.includes('api.openai.com')) {
    body.tools = [{
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information and return relevant results",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query to execute"
            }
          },
          required: ["query"]
        }
      }
    }];
  } else if (useSearch) {
    // 第三方平台：将搜索提示并入用户消息
    const searchPrompt = "请基于你的知识回答以下问题，如果需要最新信息请说明。";
    msgs[msgs.length - 1].content = searchPrompt + "\n\n" + msgs[msgs.length - 1].content;
  }
  
  const attempts = buildAuthAttempts(p);
  try {
    const data: any = await tryPostJSON(url, body, attempts);
    return data?.choices?.[0]?.message?.content || "";
  } catch (lastErr: any) {
    const status = lastErr?.response?.status; const bodyErr = lastErr?.response?.data; const msg = bodyErr?.error?.message || bodyErr?.message || lastErr?.message || String(lastErr);
    throw new Error(`[chatOpenAI] adapter=openai model=${html(model)} status=${status || "network"} message=${msg}`);
  }
}
async function chatClaude(p: Provider, model: string, msgs: { role: string; content: string }[], maxTokens?: number, useSearch?: boolean) {
  const url = trimBase(p.baseUrl) + "/v1/messages";
  const body: any = { model, max_tokens: maxTokens || 1024, messages: msgs.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })) };
  if (useSearch && p.baseUrl?.includes('api.anthropic.com')) {
    body.tools = [{
      type: "web_search_20241220",
      name: "web_search",
      max_uses: 3
    }];
  }
  
  const v = await getAnthropicVersion(p);
  const attempts = buildAuthAttempts(p, { "anthropic-version": v });
  try {
    const data: any = await tryPostJSON(url, body, attempts);
    if (data?.content && Array.isArray(data.content)) {
      // 提取文本内容
      const textBlocks = data.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .filter((text: string) => text && text.trim());
      
      if (textBlocks.length > 0) {
        return textBlocks.join('\n\n');
      }
    }
    
    // 回退：兼容多种第三方返回结构
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
    
    for (const text of possibleTexts) {
      if (typeof text === 'string' && text.trim()) {
        return text.trim();
      }
    }
    
    return "";
  } catch (lastErr: any) {
    const status = lastErr?.response?.status; const bodyErr = lastErr?.response?.data; const msg = bodyErr?.error?.message || bodyErr?.message || lastErr?.message || String(lastErr);
    throw new Error(`[chatClaude] adapter=claude model=${html(model)} status=${status || "network"} message=${msg}`);
  }
}
async function chatGemini(p: Provider, model: string, msgs: { role: string; content: string }[], useSearch: boolean = false) {
  const path = `/models/${encodeURIComponent(model)}:generateContent`;
  
  // 构建请求数据
  const requestData: any = {
    contents: [{ parts: msgs.map(m => ({ text: (m.role === "user" ? "" : "") + m.content })) }]
  };
  
  // 如果启用搜索，添加Google搜索工具
  if (useSearch) {
    requestData.tools = [{ googleSearch: {} }];
  }
  
  const data = await geminiRequestWithFallback(p, path, {
    method: "POST",
    data: requestData,
    params: { key: p.apiKey }
  });
  
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((x: any) => x.text || "").join("");
}

// 图像输入对话（OpenAI）
async function chatVisionOpenAI(p: Provider, model: string, imageB64: string, prompt?: string) {
  const url = trimBase(p.baseUrl) + "/v1/chat/completions";
  const content = [
    { type: "text", text: prompt || "用中文描述此图片" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${imageB64}` } }
  ];
  const body = { model, messages: [{ role: "user", content }] };
  const attempts = buildAuthAttempts(p);
  try {
    const data: any = await tryPostJSON(url, body, attempts);
    return data?.choices?.[0]?.message?.content || "";
  } catch (lastErr: any) {
    const status = lastErr?.response?.status; const bodyErr = lastErr?.response?.data; const msg = bodyErr?.error?.message || bodyErr?.message || lastErr?.message || String(lastErr);
    throw new Error(`[chatVisionOpenAI] adapter=openai model=${html(model)} status=${status || "network"} message=${msg}`);
  }
}

// 图像输入对话（Gemini）
async function chatVisionGemini(p: Provider, model: string, imageB64: string, prompt?: string) {
  const path = `/models/${encodeURIComponent(model)}:generateContent`;
  try {
    const data = await geminiRequestWithFallback(p, path, {
      method: "POST",
      data: {
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/png", data: imageB64 } },
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
}
// 图像输入对话（Claude）
async function chatVisionClaude(p: Provider, model: string, imageB64: string, prompt?: string) {
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
          { type: "image", source: { type: "base64", media_type: "image/png", data: imageB64 } }
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
    const status = lastErr?.response?.status; const bodyErr = lastErr?.response?.data; const msg = bodyErr?.error?.message || bodyErr?.message || lastErr?.message || String(lastErr);
    throw new Error(`[chatVisionClaude] adapter=claude model=${html(model)} status=${status || "network"} message=${msg}`);
  }
}
// 统一的视觉对话入口；按兼容类型路由
async function chatVision(p: Provider, compat: string, model: string, imageB64: string, prompt?: string): Promise<string> {
  if (compat === "openai") return chatVisionOpenAI(p, model, imageB64, prompt);
  if (compat === "gemini") return chatVisionGemini(p, model, imageB64, prompt);
  if (compat === "claude") return chatVisionClaude(p, model, imageB64, prompt);
   // 若提供方不支持视觉，回退为纯文本描述（以 OpenAI 风格对话作泛化回退）
  return chatOpenAI(p, model, [{ role: "user", content: prompt || "描述这张图片" } as any] as any);
}

// 图像生成（OpenAI）
async function imageOpenAI(p: Provider, model: string, prompt: string): Promise<string> {
  const url = trimBase(p.baseUrl) + "/v1/images/generations";
  const body = { model, prompt, n: 1, response_format: "b64_json", size: "1024x1024" };
  const attempts = buildAuthAttempts(p, { "Content-Type": "application/json" });
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
    } catch {}
  }
  return "";
}
// 图像生成（Gemini）
async function imageGemini(p: Provider, model: string, prompt: string): Promise<{ image?: Buffer; text?: string; mime?: string }> {
  // 确保使用支持图片生成的模型
  let imageModel = model;
  if (!model.includes("image") && !model.includes("2.5-flash") && !model.includes("2.0-flash")) {
    // 如果模型不支持图片生成，尝试使用默认的图片生成模型
    imageModel = "gemini-2.5-flash-image-preview";
  }
  
  const path = `/models/${encodeURIComponent(imageModel)}:generateContent`;
  try {
    const data = await geminiRequestWithFallback(p, path, {
      method: "POST",
      data: {
        contents: [{ 
          role: "user", 
          parts: [{ text: prompt }] 
        }],
        generationConfig: { 
          responseModalities: ["TEXT", "IMAGE"],
          temperature: 0.7,
          maxOutputTokens: 2048
        }
      },
      params: { key: p.apiKey }
    });
    const parts = data?.candidates?.[0]?.content?.parts || [];
    let text: string | undefined; let image: Buffer | undefined; let mime: string | undefined;
    for (const part of parts) {
      const pAny: any = part;
      if (pAny?.text) text = String(pAny.text);
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
    const status = err?.response?.status;
    const body = err?.response?.data;
    const msg = body?.error?.message || body?.message || err?.message || String(err);
    console.error(`[imageGemini] 图片生成失败: model=${imageModel} status=${status || "network"} message=${msg}`);
    throw new Error(`图片生成失败：${msg}`);
  }
}
// 文本转语音（Gemini）
async function ttsGemini(p: Provider, model: string, input: string, voiceName?: string): Promise<{ audio?: Buffer; mime?: string }> {
  const path = `/models/${encodeURIComponent(model)}:generateContent`;
  const voice = voiceName || "Kore";
  const buildPayloads = () => [
    {
      contents: [ { role: "user", parts: [{ text: input }] } ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    },
    {
      contents: [ { role: "user", parts: [{ text: input }] } ],
      generationConfig: { responseModalities: ["AUDIO"] }
    }
  ];
  try {
    for (let i = 0; i < buildPayloads().length; i++) {
      const payload = buildPayloads()[i];
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
      } catch (e) {
        console.warn(`[ttsGemini] Payload ${i + 1} 失败`);
      }
    }
    console.warn(`[ttsGemini] 所有payload都失败，返回空结果`);
    return {};
  } catch (e: any) {
    console.error(`[ttsGemini] 整体异常:`, e?.message || e);
    return {};
  }
}

// 文本转语音（OpenAI）
async function ttsOpenAI(p: Provider, model: string, input: string, voiceName?: string): Promise<Buffer> {
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
  const status = lastErr?.response?.status; const bodyErr = lastErr?.response?.data; const msg = bodyErr?.error?.message || bodyErr?.message || lastErr?.message || String(lastErr);
  throw new Error(`[ttsOpenAI] adapter=openai model=${html(model)} status=${status || "network"} message=${msg}`);
}

// 通用：如 Gemini 返回 L16/PCM，这里补 WAV 头
function convertPcmL16ToWavIfNeeded(raw: Buffer, mime?: string): { buf: Buffer; mime: string } {
  let buf = raw;
  let outMime = (mime || "audio/ogg");
  const lm = outMime.toLowerCase();
  if (lm.includes('l16') && lm.includes('pcm')) {
    try {
      const parse = (mt: string) => {
        const [fileType, ...params] = mt.split(';').map(s => s.trim());
        const [, format] = (fileType || '').split('/');
        const opts: any = { numChannels: 1, sampleRate: 24000, bitsPerSample: 16 };
        if (format && format.toUpperCase().startsWith('L')) {
          const bits = parseInt(format.slice(1), 10);
          if (!isNaN(bits)) opts.bitsPerSample = bits;
        }
        for (const param of params) {
          const [k, v] = param.split('=').map(s => s.trim());
          if (k === 'rate') { const r = parseInt(v, 10); if (!isNaN(r)) opts.sampleRate = r; }
          if (k === 'channels') { const c = parseInt(v, 10); if (!isNaN(c)) opts.numChannels = c; }
        }
        return opts;
      };
      const createHeader = (len: number, o: any) => {
        const byteRate = o.sampleRate * o.numChannels * o.bitsPerSample / 8;
        const blockAlign = o.numChannels * o.bitsPerSample / 8;
        const b = Buffer.alloc(44);
        b.write('RIFF', 0);
        b.writeUInt32LE(36 + len, 4);
        b.write('WAVE', 8);
        b.write('fmt ', 12);
        b.writeUInt32LE(16, 16);
        b.writeUInt16LE(1, 20);
        b.writeUInt16LE(o.numChannels, 22);
        b.writeUInt32LE(o.sampleRate, 24);
        b.writeUInt32LE(byteRate, 28);
        b.writeUInt16LE(blockAlign, 32);
        b.writeUInt16LE(o.bitsPerSample, 34);
        b.write('data', 36);
        b.writeUInt32LE(len, 40);
        return b;
      };
      const opts = parse(outMime);
      const header = createHeader(buf.length, opts);
      buf = Buffer.concat([header, buf]);
      outMime = 'audio/wav';
    } catch {}
  }
  return { buf, mime: outMime };
}

// 通用：发送语音（带标题和语音属性）
async function sendVoiceWithCaption(msg: Api.Message, fileBuf: Buffer, caption: string, replyToId?: number): Promise<void> {
  try {
    const file: any = Object.assign(fileBuf, { name: "ai.ogg" });
    await msg.client?.sendFile(msg.peerId, {
      file,
      caption,
      parseMode: "html",
      replyTo: replyToId || undefined,
      attributes: [new Api.DocumentAttributeAudio({ duration: 0, voice: true })],
    });
  } catch (error: any) {
    // 如果语音发送被禁止，先尝试以普通音频/文件形式发送，仍失败再退到文本
    if (error?.message?.includes('CHAT_SEND_VOICES_FORBIDDEN') || error?.message?.includes('VOICES_FORBIDDEN')) {
      console.warn('[AI] Voice sending forbidden, retrying as regular audio/document');
      try {
        const altFile: any = Object.assign(fileBuf, { name: "ai.wav" });
        await msg.client?.sendFile(msg.peerId, {
          file: altFile,
          caption,
          parseMode: "html",
          replyTo: replyToId || undefined
          // 不带 voice 属性，避免被识别为语音消息
        });
        return;
      } catch (e2: any) {
        console.warn('[AI] Fallback to regular audio/document failed, falling back to text');
        if (replyToId) {
          await msg.client?.sendMessage(msg.peerId, {
            message: caption + "\n\n⚠️ 语音发送被禁止，已转为文本消息",
            parseMode: "html",
            replyTo: replyToId
          });
        } else {
          await msg.client?.sendMessage(msg.peerId, {
            message: caption + "\n\n⚠️ 语音发送被禁止，已转为文本消息",
            parseMode: "html"
          });
        }
      }
    } else {
      // 其他错误继续抛出
      throw error;
    }
  }
}

async function sendImageFile(
  msg: Api.Message,
  buf: Buffer,
  caption: string,
  replyToId?: number,
  mimeHint?: string
): Promise<void> {
  const ext = (mimeHint || "image/png").includes("png") ? "png" : (mimeHint || "").includes("jpeg") ? "jpg" : "png";
  const file: any = Object.assign(buf, { name: `ai.${ext}` });
  await msg.client?.sendFile(msg.peerId, {
    file,
    caption,
    parseMode: "html",
    replyTo: replyToId || undefined
  });
}

// 新增：统一的长文发送（根据是否为回复自动选择 sendLong/sendLongReply）
async function sendLongAuto(
  msg: Api.Message,
  text: string,
  replyToId?: number,
  opts?: { collapse?: boolean },
  postfix?: string
): Promise<void> {
  if (replyToId) {
    await sendLongReply(msg, replyToId, text, opts, postfix);
  } else {
    await sendLong(msg, text, opts, postfix);
  }
}

// 新增：统一解析模型列表响应
function parseModelListFromResponse(data: any): string[] {
  const arr = Array.isArray(data) ? data : (data?.data || data?.models || []);
  return (arr || []).map((x: any) => normalizeModelName(x));
}

// 新增：按兼容类型通用的模型枚举
async function listModels(p: Provider, compat: Compat): Promise<string[]> {
  const base = trimBase(p.baseUrl);
  const tryGet = async (url: string, headers: Record<string, string> = {}, prefer?: Compat) => {
    const attempts = buildAuthAttempts({ ...p, compatauth: prefer || p.compatauth } as Provider, headers);
    let lastErr: any;
    for (const a of attempts) {
      try {
        const r = await axiosWithRetry({ method: "GET", url, ...(a || {}) });
        return r.data;
      } catch (e: any) { lastErr = e; }
    }
    throw lastErr;
  };
  let lastErr: any = null;
  if (compat === "openai") {
    const url = base + "/v1/models";
    try {
      const data = await tryGet(url);
      return parseModelListFromResponse(data);
    } catch (e: any) { lastErr = e; }
    // 回退其它风格
    try {
      const vAnth = await getAnthropicVersion(p);
      const data = await tryGet(url, { "anthropic-version": vAnth }, "claude");
      return parseModelListFromResponse(data);
    } catch (e: any) { lastErr = e; }
    try {
      const data = await tryGet(base + "/v1beta/models", {}, "gemini");
      return parseModelListFromResponse(data);
    } catch (e: any) { lastErr = e; }
  } else if (compat === "claude") {
    const url = base + "/v1/models";
    try {
      const vAnth = await getAnthropicVersion(p);
      const data = await tryGet(url, { "anthropic-version": vAnth }, "claude");
      return parseModelListFromResponse(data);
    } catch (e: any) { lastErr = e; }
    try {
      const data = await tryGet(url);
      return parseModelListFromResponse(data);
    } catch (e: any) { lastErr = e; }
    try {
      const data = await tryGet(base + "/v1beta/models", {}, "gemini");
      return parseModelListFromResponse(data);
    } catch (e: any) { lastErr = e; }
  } else {
    
    const url1 = base + "/v1beta/models";
    const url2 = base + "/v1/models";
    try {
      const data = await tryGet(url1, {}, "gemini");
      const list = parseModelListFromResponse(data);
      if (list.length) return list;
    } catch (e: any) { lastErr = e; }
    try {
      const data = await tryGet(url2, {}, "gemini");
      const list = parseModelListFromResponse(data);
      if (list.length) return list;
    } catch (e: any) { lastErr = e; }
    try {
      const data = await tryGet(url2);
      return parseModelListFromResponse(data);
    } catch (e: any) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  throw new Error("无法获取模型列表：服务无有效输出");
}

// 新增：按标准三种兼容类型依次尝试列出模型
async function listModelsByAnyCompat(p: Provider): Promise<{ models: string[]; compat: Compat | null; compats: Compat[]; modelMap?: Record<string, Compat> }> {
  const order: Compat[] = ["openai", "gemini", "claude"];
  const merged = new Map<string, string>(); // key: lower-case name -> original
  const compats: Compat[] = [];
  const modelMap: Record<string, Compat> = {};
  let primary: Compat | null = null;
  for (const c of order) {
    try {
      const list = await listModels(p, c);
      if (Array.isArray(list) && list.length) {
        if (!primary) primary = c; // 首个成功的 compat 作为 primary
        if (!compats.includes(c)) compats.push(c);
        for (const m of list) {
          const k = String(m || "").toLowerCase();
          if (k && !merged.has(k)) merged.set(k, m);
          if (k && modelMap[k] === undefined) modelMap[k] = c;
        }
      }
    } catch {}
  }
  // 纠偏：若模型名强匹配 Claude/Gemini，则覆盖为对应 family，避免因尝试顺序被标记为 OpenAI
  for (const k of Object.keys(modelMap)) {
    const g = detectCompat("", k, "");
    if ((g === "gemini" || g === "claude") && modelMap[k] !== g) modelMap[k] = g;
  }
  return { models: Array.from(merged.values()), compat: primary, compats, modelMap };
}

async function callChat(kind: "chat" | "search", text: string, msg: Api.Message): Promise<{ content: string; model: string }> {
  const m = pick(kind); if (!m) throw new Error(`未设置${kind}模型，请先配置`);
  const p = providerOf(m.provider); if (!p) throw new Error(`服务商 ${m.provider} 未配置`);
  const compat = await resolveCompat(m.provider, m.model, p);
  const id = chatIdStr(msg); const msgs: { role: string; content: string }[] = [];

  msgs.push({ role: "user", content: text });
  let out = "";
  try {
    const isSearch = kind === "search";
    
    // 根据兼容性类型调用相应的聊天函数
    if (compat === "openai") out = await chatOpenAI(p, m.model, msgs, undefined, isSearch);
    else if (compat === "claude") out = await chatClaude(p, m.model, msgs, undefined, isSearch);
    else out = await chatGemini(p, m.model, msgs, isSearch);
  } catch (e: any) {
    const em = e?.message || String(e);
    throw new Error(`[${kind}] provider=${m.provider} compat=${compat} model=${html(m.model)} :: ${em}`);
  }
  
  // 保存到本地历史记录（如果context开启）
  if (Store.data.contextEnabled) { 
    pushHist(id, "user", text); 
    pushHist(id, "assistant", out); 
    await Store.writeSoon(); 
  }
  
  return { content: out, model: m.model };
}

const help = `🔧 📝 <b>特性</b>
兼容 Google Gemini、OpenAI、Anthropic Claude、Baidu 标准接口，统一指令，一处配置，多处可用。
✨ <b>亮点</b>
• 🔀 模型混用：对话 / 搜索 / 图片 / 语音 可分别指定不同服务商的不同模型
• 🧠 可选上下文记忆、📰 长文自动发布 Telegraph、🧾 消息折叠显示

💬 <b>对话</b>
<code>ai chat [问题]</code>
• 示例：<code>ai chat 你好，帮我简单介绍一下你</code>
• 支持多轮对话（可执行 <code>ai context on</code> 开启记忆）
• 超长回答可自动转 Telegraph

🔍 <b>搜索</b>
<code>ai search [查询]</code>
• 示例：<code>ai search 2024 年 AI 技术进展</code>

🖼️ <b>图片</b>
<code>ai image [描述]</code>
• 示例：<code>ai image 未来城市的科幻夜景</code>

🎵 <b>文本转语音</b>
<code>ai tts [文本]</code>
• 示例：<code>ai tts 你好，这是一次语音合成测试</code>

🎤 <b>语音回答</b>
<code>ai audio [问题]</code>
• 示例：<code>ai audio 用 30 秒介绍人工智能的发展</code>

🔍🎤 <b>搜索并语音回答</b>
<code>ai searchaudio [查询]</code>
• 示例：<code>ai searchaudio 2024 年最新科技趋势</code>

💭 <b>对话上下文</b>
<code>ai context on|off|show|del</code>

📋 <b>消息折叠</b>
<code>ai collapse on|off</code>

📰 <b>Telegraph 长文</b>
<code>ai telegraph on|off|limit &lt;数量&gt;|list|del &lt;n|all&gt;</code>
• limit &lt;数量&gt;：设置字数阈值（0 表示不限制）
• 自动创建 / 管理 / 删除 Telegraph 文章

⚙️ <b>模型管理</b>
<code>ai model list</code> - 查看当前模型配置
<code>ai model chat|search|image|tts [服务商] [模型]</code> - 设置各功能模型
<code>ai model default</code> - 清空所有功能模型
<code>ai model auto</code> - 智能分配 chat/search/image/tts

🔧 <b>配置管理</b>
<code>ai config status</code> - 显示配置概览
<code>ai config add [服务商] [API密钥] [BaseURL]</code>
<code>ai config list</code> - 查看已配置的服务商
<code>ai config model [服务商]</code> - 查看该服务商可用模型
<code>ai config update [服务商] [apikey|baseurl] [值]</code>
<code>ai config remove [服务商|all]</code>

📝 <b>配置示例</b>
• OpenAI：<code>ai config add openai sk-proj-xxx https://api.openai.com</code>
• DeepSeek：<code>ai config add deepseek sk-xxx https://api.deepseek.com</code>
• Grok：<code>ai config add grok xai-xxx https://api.x.ai</code>
• Claude：<code>ai config add claude sk-ant-xxx https://api.anthropic.com</code>
• Gemini：<code>ai config add gemini AIzaSy-xxx https://generativelanguage.googleapis.com</code>

⚡ <b>简洁命令与别名</b>
常用简写
• 对话：<code>ai [问题]</code>或<code>ai chat [问题]</code>
• 搜索：<code>ai s [查询]</code>
• 图片：<code>ai img [描述]</code>
• 语音：<code>ai v [文本]</code>
• 回答为语音：<code>ai a [问题]</code> / 搜索并语音：<code>ai sa [查询]</code>
• 上下文：<code>ai ctx on|off</code>
• 模型：<code>ai m list</code> / 设置：<code>ai m chat|search|image|tts [服务商] [模型]</code>
• 配置：<code>ai c add [服务商] [API密钥] [BaseURL]</code>
• 别名：<code>s</code>=search, <code>img</code>/<code>i</code>=image, <code>v</code>=tts, <code>a</code>=audio, <code>sa</code>=searchaudio, <code>ctx</code>=context, <code>fold</code>=collapse, <code>cfg</code>/<code>c</code>=config, <code>m</code>=model
`;

class AiPlugin extends Plugin {
  description: string = `🤖 智能AI助手\n\n${help}`;
  cmdHandlers = {
    ai: async (msg: Api.Message) => {
      await Store.init(); ensureDir();
      const text = (msg as any).text || (msg as any).message || ""; const lines = text.trim().split(/\r?\n/g); const parts = (lines[0] || "").split(/\s+/);
      const [, sub, ...args] = parts; const subl = (sub || "").toLowerCase();
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
      m: "model",
      };
      const subn = aliasMap[subl] || subl;
      try {
        const preflight = async (kind: keyof Models): Promise<{ m: { provider: string; model: string }, p: Provider, compat: Compat } | null> => {
          const m = pick(kind); if (!m) { await msg.edit({ text: `❌ 未设置 ${kind} 模型`, parseMode: "html" }); return null; }
          const p = providerOf(m.provider); if (!p) { await msg.edit({ text: "❌ 服务商未配置", parseMode: "html" }); return null; }
          if (!p.apiKey) { await msg.edit({ text: "❌ 未提供令牌，请先配置 API Key（ai config add/update）", parseMode: "html" }); return null; }
          const compat = await resolveCompat(m.provider, m.model, p); return { m, p, compat };
        };
        
        if (subn === "config") {
          if ((msg as any).isGroup || (msg as any).isChannel) { await msg.edit({ text: "❌ 为保护用户隐私，禁止在公共对话环境使用ai config所有子命令", parseMode: "html" }); return; }
          const a0 = (args[0] || "").toLowerCase();
          if (a0 === "status") {
            const cur = Store.data.models;
            const flags = [
              `• 上下文: ${Store.data.contextEnabled ? "开启" : "关闭"}`,
              `• 折叠: ${Store.data.collapse ? "开启" : "关闭"}`,
              `• Telegraph: ${Store.data.telegraph.enabled ? "开启" : "关闭"}${Store.data.telegraph.enabled && Store.data.telegraph.limit ? `（阈值 ${Store.data.telegraph.limit}）` : ""}`,
            ].join("\n");
            const provList = Object.entries(Store.data.providers)
              .map(([n, v]) => {
                const display = shortenUrlForDisplay(v.baseUrl);
                return `• <b>${html(n)}</b> - key:${v.apiKey ? "✅" : "❌"} base:<a href="${html(v.baseUrl)}">${html(display)}</a>`;
              })
              .join("\n") || "(空)";
            const txt = `⚙️ <b>AI 配置概览</b>\n\n<b>功能模型</b>\n<b>chat:</b> <code>${html(cur.chat) || "(未设)"}</code>\n<b>search:</b> <code>${html(cur.search) || "(未设)"}</code>\n<b>image:</b> <code>${html(cur.image) || "(未设)"}</code>\n<b>tts:</b> <code>${html(cur.tts) || "(未设)"}</code>\n\n<b>功能开关</b>\n${flags}\n\n<b>服务商</b>\n${provList}`;
            await sendLong(msg, txt); return;
          }
          if (a0 === "add") {
            const [name, key, baseUrl] = [args[1], args[2], args[3]];
            if (!name || !key || !baseUrl) { await msg.edit({ text: "❌ 参数不足", parseMode: "html" }); return; }
            try {
              const u = new URL(baseUrl);
              if (u.protocol !== "http:" && u.protocol !== "https:") { await msg.edit({ text: "❌ baseUrl 无效，请使用 http/https 协议", parseMode: "html" }); return; }
            } catch {
              await msg.edit({ text: "❌ baseUrl 无效，请检查是否为合法 URL", parseMode: "html" }); return;
            }
            Store.data.providers[name] = { apiKey: key, baseUrl: trimBase(baseUrl.trim()) };
            if (Store.data.modelCompat) delete Store.data.modelCompat[name];
            compatResolving.delete(name);
            await Store.writeSoon();
            await refreshModelCatalog(true).catch(() => {});
            await msg.edit({ text: `✅ 已添加 <b>${html(name)}</b>`, parseMode: "html" }); return;
          }
          if (a0 === "update") {
            const [name, field, ...rest] = args.slice(1);
            const value = (rest.join(" ") || "").trim();
            if (!name || !field || !value) { await msg.edit({ text: "❌ 参数不足", parseMode: "html" }); return; }
            const p = Store.data.providers[name]; if (!p) { await msg.edit({ text: "❌ 未找到服务商", parseMode: "html" }); return; }
            if (field.toLowerCase() === "apikey") { p.apiKey = value; delete (p as any).compatauth; }
            else if (field.toLowerCase() === "baseurl") {
              try {
                const u = new URL(value);
                if (u.protocol !== "http:" && u.protocol !== "https:") { await msg.edit({ text: "❌ baseUrl 无效，请使用 http/https 协议", parseMode: "html" }); return; }
              } catch {
                await msg.edit({ text: "❌ baseUrl 无效，请检查是否为合法 URL", parseMode: "html" }); return;
              }
              p.baseUrl = trimBase(value.trim()); delete (p as any).compatauth;
            }
            else { await msg.edit({ text: "❌ 字段仅支持 apikey|baseurl", parseMode: "html" }); return; }
            if (Store.data.modelCompat) delete Store.data.modelCompat[name];
            compatResolving.delete(name);
            await Store.writeSoon();
            await refreshModelCatalog(true).catch(() => {});
            await msg.edit({ text: `✅ 已更新 <b>${html(name)}</b> 的 <code>${html(field)}</code>`, parseMode: "html" }); return;
          }
          if (a0 === "remove") {
            const target = (args[1] || "").toLowerCase();
            if (!target) { await msg.edit({ text: "❌ 请输入服务商名称或 all", parseMode: "html" }); return; }
            if (target === "all") { Store.data.providers = {}; Store.data.modelCompat = {}; Store.data.modelCatalog = { map: {}, updatedAt: undefined } as any; compatResolving.clear(); }
            else {
              if (!Store.data.providers[target]) { await msg.edit({ text: "❌ 未找到服务商", parseMode: "html" }); return; }
              delete Store.data.providers[target]; if (Store.data.modelCompat) delete Store.data.modelCompat[target];
              const kinds: (keyof Models)[] = ["chat","search","image","tts"];
              for (const k of kinds) { const v = Store.data.models[k]; if (v && v.startsWith(target + " ")) Store.data.models[k] = ""; }
            }
            await Store.writeSoon();
            await refreshModelCatalog(true).catch(() => {});
            await msg.edit({ text: "✅ 已删除", parseMode: "html" }); return;
          }
          if (a0 === "list") {
            const list = Object.entries(Store.data.providers).map(([n, v]) => { const base=v.baseUrl; const display=shortenUrlForDisplay(base); return `• <b>${html(n)}</b> - key:${v.apiKey ? "✅" : "❌"} base:<a href="${html(base)}">${html(display)}</a>`; }).join("\n") || "(空)";
            await sendLong(msg, `📦 <b>已配置服务商</b>\n\n${list}`); return;
          }
          if (a0 === "model") {
            const name = args[1]; const p = name && providerOf(name);
            if (!p) { await msg.edit({ text: "❌ 未找到服务商", parseMode: "html" }); return; }
            let models: string[] = [];
            let selected: Compat | null = null;
            try {
              const res = await listModelsByAnyCompat(p);
              models = res.models; selected = res.compat;
            } catch {}
            if (!models.length || !selected) {
              await msg.edit({ text: "❌ 该服务商的权鉴方式未使用OpenAI、Google Gemini、Claude的标准接口，不做兼容。", parseMode: "html" }); return;
            }
            const buckets = { chat: [] as string[], search: [] as string[], image: [] as string[], tts: [] as string[] };
            for (const m of models) {
              const ml = String(m).toLowerCase();
              if (/image|dall|sd|gpt-image/.test(ml)) buckets.image.push(m);
              else if (/tts|voice|audio\.speech|gpt-4o.*-tts|\b-tts\b/.test(ml)) buckets.tts.push(m);
              else { buckets.chat.push(m); buckets.search.push(m); }
            }

            const txt = `🧾 <b>${html(name!)}</b> 可用模型\n\n<b>chat/search</b>:\n${buckets.chat.length ? buckets.chat.map(x => "• " + html(x)).join("\n") : "(空)"}\n\n<b>image</b>:\n${buckets.image.length ? buckets.image.map(x => "• " + html(x)).join("\n") : "(空)"}\n\n<b>tts</b>:\n${buckets.tts.length ? buckets.tts.map(x => "• " + html(x)).join("\n") : "(空)"}`;
            await sendLong(msg, txt); return;
          }
          await msg.edit({ text: "❌ 未知 config 子命令", parseMode: "html" }); return;
        }
        
        if (subn === "model") {
          const a0 = (args[0] || "").toLowerCase();
          
          if (a0 === "list") {
            const cur = Store.data.models;
            const txt = `⚙️ <b>当前模型配置</b>\n\n<b>chat:</b> <code>${html(cur.chat) || "(未设)"}</code>\n<b>search:</b> <code>${html(cur.search) || "(未设)"}</code>\n<b>image:</b> <code>${html(cur.image) || "(未设)"}</code>\n<b>tts:</b> <code>${html(cur.tts) || "(未设)"}</code>`;
            await sendLong(msg, txt); return;
          }

          if (a0 === "default") {
            Store.data.models = { chat: "", search: "", image: "", tts: "" };
            await Store.writeSoon();
            await msg.edit({ text: "✅ 已清空所有功能模型设置", parseMode: "html" });
            return;
          }
          
          if (a0 === "auto") {
            const entries = Object.entries(Store.data.providers);
            if (!entries.length) { await msg.edit({ text: "❌ 请先使用 ai config add 添加服务商", parseMode: "html" }); return; }
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
                else { buckets.chat.push(m); buckets.search.push(m); }
              }
              bucketsBy[n] = buckets;
            }
            const orders: Array<Compat | "other"> = ["openai","gemini","claude","other"];
            const modelFamilyOf = (m: string): Compat | "other" => {
              const s = String(m).toLowerCase();
              if (/(gpt-|dall-e|gpt-image|tts-1|gpt-4o)/.test(s)) return "openai";
              if (/gemini/.test(s)) return "gemini";
              if (/claude/.test(s)) return "claude";
              return "other";
            };
            const preferBy = (family: Compat | "other", kind: "chat"|"search"|"image"|"tts", list: string[]) => {
              if (family === "openai") {
                if (kind === "chat" || kind === "search") return list.find(m => /gpt-4o-mini|gpt-4o/i.test(m)) || "";
                if (kind === "image") return list.find(m => /gpt-image-1|dall-e-\d+/i.test(m)) || "";
                if (kind === "tts") return list.find(m => /^(tts-1|gpt-4o.*-tts)/i.test(m)) || "";
              } else if (family === "gemini") {
                if (kind === "chat" || kind === "search") return list.find(m => /gemini-2\.0-flash|gemini-1\.5-flash/i.test(m)) || "";
                if (kind === "image") return list.find(m => /image-generation|image-preview/i.test(m)) || "";
                if (kind === "tts") return list.find(m => /-tts|voice|audio\.speech/i.test(m)) || "";
              } else if (family === "claude") {
                if (kind === "chat" || kind === "search") return list.find(m => /claude-3\.5-sonnet|claude-3-opus|claude-3/i.test(m)) || "";
              }
              return "";
            };
            const pickAcrossKind = (kind: "chat"|"search"|"image"|"tts") => {
              for (const fam of orders) {
                for (const [n] of entries) {
                  const bucket = bucketsBy[n]?.[kind] || [];
                  if (!bucket.length) continue;
                  const candidates = bucket.filter(m => modelFamilyOf(m) === fam);
                  if (!candidates.length) continue;
                  const m = preferBy(fam, kind, candidates) || candidates[0];
                  if (m) return { n, m, c: fam };
                }
              }
              for (const [n] of entries) {
                const bucket = bucketsBy[n]?.[kind] || [];
                if (bucket.length) return { n, m: bucket[0], c: "other" as const };
              }
              return null as any;
            };
            const chatSel = pickAcrossKind("chat");
            const searchSel = pickAcrossKind("search") || chatSel;
            const imageSel = pickAcrossKind("image");
            const ttsSel = pickAcrossKind("tts");
            if (!chatSel) { await msg.edit({ text: "❌ 未找到可用 chat/search 模型", parseMode: "html" }); return; }
            Store.data.models.chat = `${chatSel.n} ${chatSel.m}`;
            Store.data.models.search = `${(searchSel || chatSel).n} ${(searchSel || chatSel).m}`;
            Store.data.models.image = imageSel ? `${imageSel.n} ${imageSel.m}` : "";
            Store.data.models.tts = ttsSel ? `${ttsSel.n} ${ttsSel.m}` : "";
            await Store.writeSoon();
            const cur = Store.data.models;
            const detail = `✅ 已智能分配 chat/search/image/tts\n\n<b>chat:</b> <code>${html(cur.chat) || "(未设)"}</code>\n<b>search:</b> <code>${html(cur.search) || "(未设)"}</code>\n<b>image:</b> <code>${html(cur.image) || "(未设)"}</code>\n<b>tts:</b> <code>${html(cur.tts) || "(未设)"}</code>`;
            await msg.edit({ text: detail, parseMode: "html" }); return;
          }
          
          const kind = a0 as keyof Models;
          if (["chat","search","image","tts"].includes(kind)) {
            const [provider, ...mm] = args.slice(1);
            const model = (mm.join(" ") || "").trim();
            if (!provider || !model) { await msg.edit({ text: "❌ 参数不足", parseMode: "html" }); return; }
            if (!Store.data.providers[provider]) { await msg.edit({ text: "❌ 未知服务商", parseMode: "html" }); return; }
            Store.data.models[kind] = `${provider} ${model}`;
            await Store.writeSoon();
            await msg.edit({ text: `✅ 已设置 ${kind}: <code>${html(Store.data.models[kind])}</code>`, parseMode: "html" }); return;
          }
          await msg.edit({ text: "❌ 未知 model 子命令", parseMode: "html" }); return;
        }
        
        if (subn === "context") {
          const a0 = (args[0] || "").toLowerCase(); const id = chatIdStr(msg);
          if (a0 === "on") { Store.data.contextEnabled = true; await Store.writeSoon(); await msg.edit({ text: "✅ 已开启上下文", parseMode: "html" }); return; }
          if (a0 === "off") { Store.data.contextEnabled = false; await Store.writeSoon(); await msg.edit({ text: "✅ 已关闭上下文", parseMode: "html" }); return; }
          if (a0 === "show") { const items = histFor(id); const t = items.map(x => `${x.role}: ${html(x.content)}`).join("\n"); await sendLong(msg, t || "(空)"); return; }
          if (a0 === "del") { delete Store.data.histories[id]; if (Store.data.histMeta) delete Store.data.histMeta[id]; await Store.writeSoon(); await msg.edit({ text: "✅ 已清空本会话上下文", parseMode: "html" }); return; }
          await msg.edit({ text: "❌ 未知 context 子命令\n支持: on|off|show|del", parseMode: "html" }); return;
        }
        
        if (subn === "collapse") { const a0 = (args[0] || "").toLowerCase(); Store.data.collapse = a0 === "on"; await Store.writeSoon(); await msg.edit({ text: `✅ 消息折叠: ${Store.data.collapse ? "开启" : "关闭"}`, parseMode: "html" }); return; }
        
        if (subn === "telegraph") {
          const a0 = (args[0] || "").toLowerCase();
          if (a0 === "on") { Store.data.telegraph.enabled = true; await Store.writeSoon(); await msg.edit({ text: "✅ 已开启 telegraph", parseMode: "html" }); return; }
          if (a0 === "off") { Store.data.telegraph.enabled = false; await Store.writeSoon(); await msg.edit({ text: "✅ 已关闭 telegraph", parseMode: "html" }); return; }
          if (a0 === "limit") { const n = parseInt(args[1] || "0"); Store.data.telegraph.limit = isFinite(n) ? n : 0; await Store.writeSoon(); await msg.edit({ text: `✅ 阈值: ${Store.data.telegraph.limit}`, parseMode: "html" }); return; }
          if (a0 === "list") { const list = Store.data.telegraph.posts.map((p, i) => `${i + 1}. <a href="${p.url}">${html(p.title)}</a> ${p.createdAt}`).join("\n") || "(空)"; await sendLong(msg, `🧾 <b>Telegraph 列表</b>\n\n${list}`); return; }
          if (a0 === "del") { const t = (args[1] || "").toLowerCase(); if (t === "all") Store.data.telegraph.posts = []; else { const i = parseInt(args[1] || "0") - 1; if (i >= 0) Store.data.telegraph.posts.splice(i, 1); } await Store.writeSoon(); await msg.edit({ text: "✅ 操作完成", parseMode: "html" }); return; }
          await msg.edit({ text: "❌ 未知 telegraph 子命令", parseMode: "html" }); return;
        }
        
        if (subn === "chat" || subn === "search" || !subn) {
          const replyMsg = await msg.getReplyMessage();
          const isSearch = subn === "search";
          const plain = (args.join(" ") || "").trim();
          const repliedText = extractText(replyMsg).trim();
          const q = (plain || repliedText).trim();
          const hasImage = !!(replyMsg && (replyMsg as any).media);
          if (!q && !hasImage) { await msg.edit({ text: "❌ 请输入内容或回复一条消息", parseMode: "html" }); return; }
          await msg.edit({ text: "🔄 处理中...", parseMode: "html" });
          const pre = await preflight(isSearch ? "search" : "chat"); if (!pre) return; const { m, p, compat } = pre;

          let content = ""; let usedModel = m.model;
          if (hasImage) {
            try {

              const raw = await msg.client?.downloadMedia(replyMsg as any);
              const buf: Buffer | undefined = Buffer.isBuffer(raw) ? raw as Buffer : (raw != null ? Buffer.from(String(raw)) : undefined);
              if (!buf || !buf.length) { await msg.edit({ text: "❌ 无法下载被回复的媒体", parseMode: "html" }); return; }
              const b64 = buf.toString('base64');
              content = await chatVision(p, compat, m.model, b64, q);
            } catch (e: any) {
              await msg.edit({ text: `❌ 处理图片失败：${html(mapError(e, 'vision'))}`, parseMode: "html" }); return;
            }
          } else {
            const res = await callChat(isSearch ? "search" : "chat", q, msg);
            content = res.content; usedModel = res.model;
          }

          const footTxt = footer(usedModel, isSearch ? "with Search" : "");
          const full = formatQA(q || "(图片)", content);
          const replyToId = replyMsg?.id || 0; // Do not reply to service/status messages
          if (Store.data.telegraph.enabled && Store.data.telegraph.limit > 0 && full.length > Store.data.telegraph.limit) {
            const url = await createTGPage("TeleBox AI", content);
            if (url) {
              Store.data.telegraph.posts.unshift({ title: (q || "图片").slice(0, 30) || "AI", url, createdAt: nowISO() });
              Store.data.telegraph.posts = Store.data.telegraph.posts.slice(0, 10);
              await Store.writeSoon();
              await sendLongAuto(msg, `📰 <a href="${url}">内容较长，已创建 Telegraph</a>`, replyToId, { collapse: Store.data.collapse }, footTxt);
              if (replyToId) { try { await msg.delete(); } catch {} }
               return;
            }
          }
          await sendLongAuto(msg, full, replyToId, { collapse: Store.data.collapse }, footTxt);
          if (replyToId) { try { await msg.delete(); } catch {} }
           return;
        }
        
        if (subn === "image") {
          const replyMsg = await msg.getReplyMessage();
          const prm = (args.join(" ") || "").trim() || extractText(replyMsg).trim();
          if (!prm) { await msg.edit({ text: "❌ 请输入提示词", parseMode: "html" }); return; }
          const pre = await preflight("image"); if (!pre) return; const { m, p, compat } = pre;
          await msg.edit({ text: "🎨 生成中...", parseMode: "html" });
          const replyToId = replyMsg?.id || 0;
          if (compat === "openai") {
            const b64 = await imageOpenAI(p, m.model, prm);
            if (!b64) { await msg.edit({ text: "❌ 图片生成失败：服务无有效输出", parseMode: "html" }); return; }
            const buf = Buffer.from(b64, "base64");
            await sendImageFile(msg, buf, `🖼️ ${html(prm)}` + footer(m.model), replyToId);
            await msg.delete(); return;
          } else if (compat === "gemini") {
            try {
              const { image, text, mime } = await imageGemini(p, m.model, prm);
              if (image) {
                await sendImageFile(msg, image, `🖼️ ${html(prm)}` + footer(m.model), replyToId, mime);
                await msg.delete(); return;
              }

              if (text) {
                const textOut = formatQA(prm, text);
                await sendLongAuto(msg, textOut, replyToId, { collapse: Store.data.collapse }, footer(m.model));
                await msg.delete(); return;
              }
              await msg.edit({ text: "❌ 图片生成失败：服务无有效输出", parseMode: "html" }); return;
            } catch (e: any) {
              await msg.edit({ text: `❌ 图片生成失败：${html(mapError(e, 'image'))}` , parseMode: "html" });
              return;
            }
          } else {
            await msg.edit({ text: "❌ 当前服务商不支持图片生成功能", parseMode: "html" }); return;
          }
        }
        
        if (subn === "audio" || subn === "searchaudio") {
          const replyMsg = await msg.getReplyMessage();
          const plain = (args.join(" ") || "").trim();
          const repliedText = extractText(replyMsg).trim();
          const q = (plain || repliedText).trim();
          if (!q) { await msg.edit({ text: "❌ 请输入内容或回复一条消息", parseMode: "html" }); return; }

          await msg.edit({ text: "🔄 处理中...", parseMode: "html" });
          const isSearch = subn === "searchaudio";
          const res = await callChat(isSearch ? "search" : "chat", q, msg);
          const content = res.content;

          const mtts = pick("tts"); if (!mtts) { await msg.edit({ text: "❌ 未设置 tts 模型", parseMode: "html" }); return; }
          const ptts = providerOf(mtts.provider); if (!ptts) { await msg.edit({ text: "❌ 服务商未配置", parseMode: "html" }); return; }
          if (!ptts.apiKey) { await msg.edit({ text: "❌ 未提供令牌，请先配置 API Key（ai config add/update）", parseMode: "html" }); return; }
          const compat = await resolveCompat(mtts.provider, mtts.model, ptts);
          const voice = compat === "gemini" ? "Kore" : "alloy";

          await msg.edit({ text: "🔊 合成中...", parseMode: "html" });
          const replyToId = replyMsg?.id || 0;

          if (compat === "openai") {
            if (!ptts.apiKey) { await msg.edit({ text: "❌ 未提供令牌，请先配置 API Key（ai config add/update）", parseMode: "html" }); return; }
            const audio = await ttsOpenAI(ptts, mtts.model, content, voice);
            const formattedContent = formatQA(q, content);
            await sendVoiceWithCaption(
              msg,
              audio,
              formattedContent + footer(mtts.model, isSearch ? ("Audio with Search") : ("Audio")),
              replyToId
            );
            await msg.delete();
            return;
          } else if (compat === "gemini") {
            const { audio, mime } = await ttsGemini(ptts, mtts.model, content, voice);
            if (audio) {
              const { buf: outBuf } = convertPcmL16ToWavIfNeeded(audio, mime);
              const formattedContent = formatQA(q, content);
              await sendVoiceWithCaption(
                msg,
                outBuf,
                formattedContent + footer(mtts.model, isSearch ? ("Audio with Search") : ("Audio")),
                replyToId
              );
              await msg.delete();
              return;
            } else {
              await msg.edit({ text: "❌ 语音合成失败：服务无有效输出", parseMode: "html" });
              return;
            }
          } else {
            await msg.edit({ text: "❌ 当前服务商不支持语音合成功能", parseMode: "html" });
            return;
          }
        }
        
        if (subn === "tts") {
          const replyMsg = await msg.getReplyMessage();
          const t = (args.join(" ") || "").trim() || extractText(replyMsg).trim();
          if (!t) { await msg.edit({ text: "❌ 请输入文本", parseMode: "html" }); return; }
          const m = pick("tts"); if (!m) { await msg.edit({ text: "❌ 未设置 tts 模型", parseMode: "html" }); return; }
          const p = providerOf(m.provider)!;
          if (!p.apiKey) { await msg.edit({ text: "❌ 未提供令牌，请先配置 API Key（ai config add/update）", parseMode: "html" }); return; }
          const compat = await resolveCompat(m.provider, m.model, p);
          const voice = compat === "gemini" ? "Kore" : "alloy";
          await msg.edit({ text: "🔊 合成中...", parseMode: "html" });
          const replyToId = replyMsg?.id || 0;
          if (compat === "openai") {
            if (!p.apiKey) { await msg.edit({ text: "❌ 未提供令牌，请先配置 API Key（ai config add/update）", parseMode: "html" }); return; }
            const audio = await ttsOpenAI(p, m.model, t, voice);
            await sendVoiceWithCaption(
              msg,
              audio,
              formatQA(t, t) + footer(m.model, `Audio`),
              replyToId
            );
            await msg.delete();
            return;
          } else if (compat === "gemini") {
            const { audio, mime } = await ttsGemini(p, m.model, t, voice);
            if (audio) {
              const { buf: outBuf } = convertPcmL16ToWavIfNeeded(audio, mime);
              await sendVoiceWithCaption(
                msg,
                outBuf,
                formatQA(t, t) + footer(m.model, `Audio`),
                replyToId
              );
              await msg.delete();
              return;
            } else {
              await msg.edit({ text: "❌ 语音合成失败：服务无有效输出", parseMode: "html" });
              return;
            }
          } else {
            await msg.edit({ text: "❌ 当前服务商不支持语音合成功能", parseMode: "html" });
            return;
          }
        }

        // 未知子命令兜底
        await msg.edit({ text: "❌ 未知子命令", parseMode: "html" });
        return;
      } catch (e: any) {
        await msg.edit({ text: `❌ 出错：${html(mapError(e, subn))}` , parseMode: "html" });
        return;
      }
    }
  };
}

export default new AiPlugin();

import fs from "fs";
import path from "path";
import axios from "axios";
import { Api, tl } from "teleproto";

import { Plugin, type PluginRuntimeContext } from "@utils/pluginBase";
import { htmlEscape } from "@utils/htmlEscape";
import { getCommandFromMessage, getPrefixes } from "@utils/pluginManager";
import { TelegramFormatter } from "@utils/telegramFormatter";

/**
 * 免费账号 + Telegram Premium 共存：
 * - 启动 / 首次需要时探测账号是否 Premium，结果落盘缓存
 * - 之后每条消息直接走对应编辑路径（rich / entities），不做 try-fail 试错，降低延迟
 * - 可用 .fwb mode auto|premium|free 强制路径；.fwb status 查看当前模式
 */

const RICH_MESSAGE_LAYER = 228;
const MAX_SOURCE_LENGTH = 6000;
const MAX_RESULT_LENGTH = 4096;
const DEFAULT_TIMEOUT = 60_000;
const MAX_CONCURRENT_REQUESTS = 4;
const AI_CONFIG_CACHE_MS = 5_000;
/** Premium 探测结果缓存时长；过期后下次润色前静默重探 */
const PREMIUM_CACHE_MS = 6 * 60 * 60 * 1000;
/** 检测到命令后，同会话内短时不润色后续出站纯文本（吃掉 .h 等插件回包） */
const COMMAND_FOLLOWUP_SUPPRESS_MS = 5_000;

const DATA_DIR = path.join(process.cwd(), "plugins", ".data", "fwb");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const AI_CONFIG_PATHS = [
  path.join(process.cwd(), "plugins", ".data", "uai", "config.json"),
  path.join(process.cwd(), "assets", "uai", "config.json"),
];

/** 经典 entities：免费账号可用 */
const POLISH_PROMPT_ENTITIES = `润色 Telegram 消息，只输出润色后的正文。
要求：保原意/语气/人称/语言；修错别字与病句；短句少改；可少量使用 **粗体** *斜体* __下划线__ ~~删除线~~ ||剧透|| \`代码\` 链接；保留 URL/@/命令/数字；禁止解释、前后缀、整段代码围栏、回答问题、编造事实。`;

/** Premium RichMessage：可更积极使用排版（服务端需支持 InputRichMessageMarkdown） */
const POLISH_PROMPT_RICH = `润色 Telegram 消息，只输出润色后的完整正文（Telegram RichMessage Markdown）。
要求：保原意/语气/人称/语言；修错别字与病句；短句少改；可适量使用 **粗体** *斜体* __下划线__ ~~删除线~~ ||剧透|| 行内代码、代码块、引用、列表、标题和链接；保留 URL/@/命令/数字；禁止解释、前后缀、整段代码围栏包裹答案、回答问题、编造事实。`;

type ApiType = "openai" | "gemini";
type AuthMethod = "bearer_token" | "api_key_header" | "query_param";
/** auto=按账号探测；premium/free=强制路径 */
type AccountMode = "auto" | "premium" | "free";
/** 实际编辑路径：rich=InputRichMessageMarkdown；entities=HTML MessageEntity */
type EditPath = "rich" | "entities";

type Provider = {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  type: ApiType;
  auth_method: AuthMethod;
  api_interface?: string;
};

type AIConfig = {
  timeout?: number;
  active_provider?: Provider;
};

type FwbConfig = {
  enabled: boolean;
  /** 用户偏好：auto / 强制 premium / 强制 free */
  accountMode: AccountMode;
  /** 最近一次 getMe 探测到的 Premium 状态；null=尚未探测 */
  detectedPremium: boolean | null;
  /** 已解析的编辑路径；null=尚未解析 */
  editPath: EditPath | null;
  /** 探测时间戳 ms */
  detectedAt: number | null;
};

type EligibleMessage = Api.Message & {
  viaBotId?: unknown;
};

type LoadedAIConfig = { provider: Provider; timeout: number };

const DEFAULT_CONFIG: FwbConfig = {
  enabled: true,
  accountMode: "auto",
  detectedPremium: null,
  editPath: null,
  detectedAt: null,
};

let aiConfigCache: { value: LoadedAIConfig; expireAt: number; signature: string } | null =
  null;

/** 进程内探测中的 Promise，避免并发重复 getMe */
let detectInflight: Promise<EditPath> | null = null;

function prefix(): string {
  return getPrefixes()[0] || ".";
}

function errorText(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status) return `AI API HTTP ${status}`;
    if (error.code === "ECONNABORTED" || /timeout/i.test(error.message)) {
      return "AI API 请求超时";
    }
    return `AI API 请求失败：${error.code || error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    console.error(`[fwb] 配置读取失败 (${filePath})：${errorText(error)}`);
    return null;
  }
}

function normalizeAccountMode(value: unknown): AccountMode {
  if (value === "premium" || value === "free" || value === "auto") return value;
  return "auto";
}

function normalizeEditPath(value: unknown): EditPath | null {
  if (value === "rich" || value === "entities") return value;
  return null;
}

function loadConfig(): FwbConfig {
  const raw = readJsonFile<Partial<FwbConfig>>(CONFIG_PATH);
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    accountMode: normalizeAccountMode(raw?.accountMode),
    detectedPremium:
      typeof raw?.detectedPremium === "boolean" ? raw.detectedPremium : null,
    editPath: normalizeEditPath(raw?.editPath),
    detectedAt: typeof raw?.detectedAt === "number" ? raw.detectedAt : null,
  };
}

function saveConfig(config: FwbConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, CONFIG_PATH);
}

function normalizeProvider(raw: unknown): Provider | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Provider>;
  const baseUrl = String(value.base_url || "").trim().replace(/\/+$/, "");
  const apiKey = String(value.api_key || "").trim();
  const model = String(value.model || "").trim();
  if (!baseUrl || !apiKey || !model) return null;

  const type: ApiType = value.type === "gemini" ? "gemini" : "openai";
  const authMethod: AuthMethod =
    value.auth_method === "api_key_header" ||
    value.auth_method === "query_param" ||
    value.auth_method === "bearer_token"
      ? value.auth_method
      : type === "gemini"
        ? "query_param"
        : "bearer_token";

  return {
    name: String(value.name || "AI").trim() || "AI",
    base_url: baseUrl,
    api_key: apiKey,
    model,
    type,
    auth_method: authMethod,
    api_interface: String(value.api_interface || "").trim() || undefined,
  };
}

function aiConfigSignature(): string {
  return AI_CONFIG_PATHS.map((configPath) => {
    try {
      const stat = fs.statSync(configPath);
      return `${configPath}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${configPath}:missing`;
    }
  }).join("|");
}

function loadAIConfig(): LoadedAIConfig {
  const now = Date.now();
  const signature = aiConfigSignature();
  if (aiConfigCache && aiConfigCache.expireAt > now && aiConfigCache.signature === signature) {
    return aiConfigCache.value;
  }

  for (const configPath of AI_CONFIG_PATHS) {
    const config = readJsonFile<AIConfig>(configPath);
    if (!config) continue;
    const provider = normalizeProvider(config.active_provider);
    if (!provider) {
      throw new Error("ai.ts 配置中没有有效的 active_provider");
    }
    const timeout = Number(config.timeout);
    const value: LoadedAIConfig = {
      provider,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT,
    };
    aiConfigCache = {
      value,
      expireAt: now + AI_CONFIG_CACHE_MS,
      signature,
    };
    return value;
  }
  throw new Error("未找到 ai.ts 配置文件 plugins/.data/uai/config.json");
}

/** 按原文长度限制输出 token，短消息显著降低生成耗时 */
function maxOutputTokens(content: string): number {
  const estimated = Math.ceil(content.length * 1.6) + 64;
  return Math.min(MAX_RESULT_LENGTH, Math.max(128, estimated));
}

function apiBaseHasVersion(baseUrl: string): boolean {
  try {
    return /\/v\d+(?:beta|alpha)?(?:\/|$)/i.test(new URL(baseUrl).pathname);
  } catch {
    return /\/v\d+(?:beta|alpha)?(?:\/|$)/i.test(baseUrl);
  }
}

function authConfig(provider: Provider): {
  headers: Record<string, string>;
  params: Record<string, string>;
} {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const params: Record<string, string> = {};

  if (provider.type === "gemini") {
    if (provider.auth_method === "api_key_header") {
      headers["x-goog-api-key"] = provider.api_key;
    } else {
      params.key = provider.api_key;
    }
  } else if (provider.auth_method === "api_key_header") {
    headers["X-API-Key"] = provider.api_key;
  } else if (provider.auth_method === "query_param") {
    params.key = provider.api_key;
  } else {
    headers.Authorization = `Bearer ${provider.api_key}`;
  }

  return { headers, params };
}

function extractOpenAIText(data: any): string {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((item: any) => String(item?.text || "")).join("\n").trim();
  }
  return "";
}

function extractAnthropicText(data: any): string {
  const content = data?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((item: any) => String(item?.text || "")).join("\n").trim();
}

function extractGeminiText(data: any): string {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((item: any) => String(item?.text || "")).join("\n").trim();
}

function polishPromptFor(path: EditPath): string {
  return path === "rich" ? POLISH_PROMPT_RICH : POLISH_PROMPT_ENTITIES;
}

async function callOpenAI(
  provider: Provider,
  content: string,
  timeout: number,
  signal: AbortSignal,
  maxTokens: number,
  systemPrompt: string,
): Promise<string> {
  const base = provider.base_url.replace(/\/+$/, "");
  const url = apiBaseHasVersion(base)
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
  const { headers, params } = authConfig(provider);
  const response = await axios.post(
    url,
    {
      model: provider.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
      stream: false,
    },
    { headers, params, timeout, signal },
  );
  return extractOpenAIText(response.data);
}

async function callAnthropic(
  provider: Provider,
  content: string,
  timeout: number,
  signal: AbortSignal,
  maxTokens: number,
  systemPrompt: string,
): Promise<string> {
  const base = provider.base_url.replace(/\/+$/, "");
  const url = base.endsWith("/anthropic")
    ? `${base}/v1/messages`
    : apiBaseHasVersion(base)
      ? `${base}/messages`
      : `${base}/v1/messages`;
  const response = await axios.post(
    url,
    {
      model: provider.model,
      system: systemPrompt,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: "user", content }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-api-key": provider.api_key,
        "anthropic-version": "2023-06-01",
      },
      timeout,
      signal,
    },
  );
  return extractAnthropicText(response.data);
}

async function callGemini(
  provider: Provider,
  content: string,
  timeout: number,
  signal: AbortSignal,
  maxTokens: number,
  systemPrompt: string,
): Promise<string> {
  const base = provider.base_url.replace(/\/+$/, "");
  const url = `${base}/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`;
  const { headers, params } = authConfig(provider);
  const response = await axios.post(
    url,
    {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: content }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
    },
    { headers, params, timeout, signal },
  );
  return extractGeminiText(response.data);
}

async function polishText(
  content: string,
  signal: AbortSignal,
  editPath: EditPath,
): Promise<{ text: string; model: string; aiMs: number; maxTokens: number }> {
  const { provider, timeout } = loadAIConfig();
  const maxTokens = maxOutputTokens(content);
  const systemPrompt = polishPromptFor(editPath);
  const started = Date.now();
  let text: string;

  if (
    provider.api_interface === "anthropic" ||
    /anthropic|claude/i.test(`${provider.name} ${provider.base_url}`)
  ) {
    text = await callAnthropic(provider, content, timeout, signal, maxTokens, systemPrompt);
  } else if (provider.type === "gemini") {
    text = await callGemini(provider, content, timeout, signal, maxTokens, systemPrompt);
  } else {
    text = await callOpenAI(provider, content, timeout, signal, maxTokens, systemPrompt);
  }

  text = text.trim();
  if (!text) throw new Error("AI 返回空内容");
  if (text.length > MAX_RESULT_LENGTH) {
    throw new Error(`AI 返回内容超过 ${MAX_RESULT_LENGTH} 个 UTF-16 代码单元`);
  }
  return {
    text,
    model: provider.model,
    aiMs: Date.now() - started,
    maxTokens,
  };
}

function hasNativeRichMessageApi(): boolean {
  return Boolean(
    tl.LAYER >= RICH_MESSAGE_LAYER &&
      (Api as any).InputRichMessageMarkdown &&
      (Api as any).InputRichMessageHTML,
  );
}

function isRichMessageUnsupported(error: unknown): boolean {
  return /RICH_MESSAGE_UNSUPPORTED|rich.?message.?unsupported/i.test(errorText(error));
}

function isOwnOutgoingMessage(msg: Api.Message): boolean {
  // 只认 out===true：Telegram 仅允许编辑自己发出的消息。
  // 勿用 savedPeerId !== undefined —— teleproto 常把未设置字段落成 null。
  return msg.out === true;
}

/** chatKey → 抑制截止时间戳；用于过滤其他命令发出的纯文本回包 */
const commandFollowupSuppressUntil = new Map<string, number>();

function messageChatKey(msg: Api.Message): string {
  return String(msg.chatId || msg.peerId || "");
}

function noteCommandActivity(chatKey: string): void {
  if (!chatKey) return;
  const until = Date.now() + COMMAND_FOLLOWUP_SUPPRESS_MS;
  const prev = commandFollowupSuppressUntil.get(chatKey) || 0;
  commandFollowupSuppressUntil.set(chatKey, Math.max(prev, until));
  // 防止 map 无限增长
  if (commandFollowupSuppressUntil.size > 200) {
    const now = Date.now();
    for (const [key, exp] of commandFollowupSuppressUntil) {
      if (exp <= now) commandFollowupSuppressUntil.delete(key);
    }
  }
}

function isCommandFollowupSuppressed(chatKey: string): boolean {
  if (!chatKey) return false;
  const until = commandFollowupSuppressUntil.get(chatKey);
  if (until == null) return false;
  if (Date.now() >= until) {
    commandFollowupSuppressUntil.delete(chatKey);
    return false;
  }
  return true;
}

/** 文本是否像 TeleBox 命令（.h / .fwb on / 自定义前缀） */
function textLooksLikeCommand(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  for (const p of getPrefixes()) {
    if (!p || !trimmed.startsWith(p)) continue;
    const body = trimmed.slice(p.length);
    // 前缀后需紧跟命令字，避免误伤普通省略号/小数
    if (/^[a-zA-Z一-鿿]/.test(body)) return true;
  }
  return false;
}

/** 已有 MessageEntity / richMessage → 多半是其他插件格式化后的输出，不再二次润色 */
function hasExistingFormatEntities(msg: Api.Message): boolean {
  const entities = (msg as any).entities;
  if (Array.isArray(entities) && entities.length > 0) return true;
  if ((msg as any).richMessage != null) return true;
  return false;
}

/**
 * 过滤其他命令/插件产生的纯文本，避免出现「.h 出两条纯文本」这类双重响应。
 * - 命令本体：记入会话抑制窗口并跳过
 * - 已有富文本实体：视为插件输出
 * - 命令后短时窗口内的出站纯文本：视为命令回包
 */
function shouldSkipPluginOrCommandOutput(
  msg: Api.Message,
  text: string,
  chatKey: string,
): boolean {
  if (getCommandFromMessage(msg) || textLooksLikeCommand(text)) {
    noteCommandActivity(chatKey);
    return true;
  }
  if (hasExistingFormatEntities(msg)) return true;
  if (isCommandFollowupSuppressed(chatKey)) return true;
  return false;
}

function isEligibleMessage(msg: EligibleMessage): boolean {
  const text = msg.message || msg.text || "";
  return Boolean(
    isOwnOutgoingMessage(msg) &&
      text.trim() &&
      text.length <= MAX_SOURCE_LENGTH &&
      !msg.media &&
      !msg.action &&
      !msg.fwdFrom &&
      !msg.viaBotId,
  );
}

function extractPremiumFlag(me: any): boolean {
  if (!me || typeof me !== "object") return false;
  // teleproto User.premium；个别封装可能用 isPremium
  return Boolean(me.premium ?? me.isPremium ?? me.user?.premium ?? me.user?.isPremium);
}

function resolveEditPathLocked(config: FwbConfig): EditPath | null {
  if (config.accountMode === "free") return "entities";
  if (config.accountMode === "premium") {
    // 强制 premium 但本机构造不了 RichMessage → 只能 entities
    if (!hasNativeRichMessageApi()) return "entities";
    // 若曾探测到服务端不支持，editPath 可能已锁 entities
    if (config.editPath === "entities" && config.detectedPremium === false) {
      return "entities";
    }
    return config.editPath === "entities" ? "entities" : config.editPath === "rich" ? "rich" : null;
  }
  // auto：已有有效缓存则直接用
  if (config.editPath && config.detectedAt && Date.now() - config.detectedAt < PREMIUM_CACHE_MS) {
    return config.editPath;
  }
  return null;
}

class RequestGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new Error("Runtime 已停止");

    if (this.active >= MAX_CONCURRENT_REQUESTS) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          const index = this.waiting.indexOf(resume);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new Error("Runtime 已停止"));
        };
        const resume = (): void => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        this.waiting.push(resume);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }

    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.waiting.shift()?.();
    };
  }

  clear(): void {
    this.waiting.splice(0).forEach((resume) => resume());
    this.active = 0;
  }
}

class FwbPlugin extends Plugin {
  description = (): string => {
    const p = htmlEscape(prefix());
    const pathLabel =
      this.config.editPath === "rich"
        ? "Premium RichMessage"
        : this.config.editPath === "entities"
          ? "免费 entities"
          : "待探测";
    const premiumLabel =
      this.config.detectedPremium === true
        ? "是"
        : this.config.detectedPremium === false
          ? "否"
          : "未知";
    return [
      "<b>AI 富文本润色</b>（免费 / Premium 自适应）",
      "",
      "默认开启，仅自动润色自己发出的非命令纯文本。",
      "自动跳过其他命令/插件输出（如 .h 回包），避免双重响应。",
      "启动时探测 Telegram Premium；之后直接走对应路径，避免每条试错。",
      `当前：模式 <code>${this.config.accountMode}</code> · 探测 Premium=<b>${premiumLabel}</b> · 路径 <b>${pathLabel}</b>`,
      "",
      `使用 <code>${p}fwb on</code> / <code>${p}fwb off</code> 开关。`,
      `使用 <code>${p}fwb mode auto|premium|free</code> 设置路径策略。`,
      `使用 <code>${p}fwb status</code> 查看状态；<code>${p}fwb redetect</code> 重新探测。`,
      "AI API、模型和超时直接读取 ai.ts / uai 配置。",
    ].join("\n");
  };

  private config = loadConfig();
  private signal: AbortSignal | null = null;
  private readonly processing = new Set<string>();
  private readonly gate = new RequestGate();
  private client: any = null;

  setup(context: PluginRuntimeContext): void {
    this.signal = context.signal;
    this.config = loadConfig();
    this.client = (context as any).client ?? null;
    // 后台预探测：不阻塞 setup；失败则等首条消息再探
    void this.ensureEditPath().catch((error) => {
      console.warn(`[fwb] 启动预探测失败（将在首条消息重试）：${errorText(error)}`);
    });
  }

  cleanup(): void {
    this.signal = null;
    this.processing.clear();
    this.gate.clear();
    this.client = null;
    detectInflight = null;
    aiConfigCache = null;
    commandFollowupSuppressUntil.clear();
  }

  private persist(): void {
    saveConfig(this.config);
  }

  private setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.persist();
  }

  private setAccountMode(mode: AccountMode): void {
    this.config.accountMode = mode;
    // 切换策略后清空路径缓存，强制按新策略解析
    this.config.editPath = null;
    if (mode === "free") {
      this.config.editPath = "entities";
      this.config.detectedAt = Date.now();
    } else if (mode === "premium") {
      this.config.editPath = hasNativeRichMessageApi() ? "rich" : "entities";
      this.config.detectedAt = Date.now();
    }
    this.persist();
  }

  private lockEditPath(path: EditPath, detectedPremium: boolean | null): void {
    this.config.editPath = path;
    if (detectedPremium !== null) this.config.detectedPremium = detectedPremium;
    this.config.detectedAt = Date.now();
    this.persist();
  }

  private async getClient(msg?: Api.Message): Promise<any> {
    if (this.client) return this.client;
    if (msg?.client) {
      this.client = msg.client;
      return this.client;
    }
    const ctxClient = (this as any).client;
    if (ctxClient) return ctxClient;
    throw new Error("Telegram client 不可用，无法探测 Premium / 编辑消息");
  }

  /** 从 getMe 探测 Premium，并解析 editPath（带内存+磁盘缓存） */
  private async ensureEditPath(msg?: Api.Message): Promise<EditPath> {
    const locked = resolveEditPathLocked(this.config);
    if (locked) return locked;

    if (detectInflight) return detectInflight;

    detectInflight = (async () => {
      // 强制 free 已在 resolve 处理；此处只处理 auto / 未缓存 premium
      if (this.config.accountMode === "free") {
        this.lockEditPath("entities", this.config.detectedPremium);
        return "entities";
      }

      if (!hasNativeRichMessageApi()) {
        // 本地 TL 无 RichMessage 构造，无论是否 Premium 都只能 entities
        let premium: boolean | null = this.config.detectedPremium;
        try {
          const client = await this.getClient(msg);
          const me = await client.getMe();
          premium = extractPremiumFlag(me);
        } catch {
          // 忽略探测失败，路径仍 entities
        }
        this.lockEditPath("entities", premium);
        console.log(
          `[fwb] 本地无 RichMessage API，锁定 entities（Premium=${String(premium)}）`,
        );
        return "entities";
      }

      if (this.config.accountMode === "premium") {
        this.lockEditPath("rich", true);
        console.log("[fwb] 强制 premium 模式，锁定 rich 路径");
        return "rich";
      }

      // auto：getMe 探测
      const client = await this.getClient(msg);
      const me = await client.getMe();
      const premium = extractPremiumFlag(me);
      const path: EditPath = premium ? "rich" : "entities";
      this.lockEditPath(path, premium);
      console.log(
        `[fwb] 账号探测完成：Premium=${premium} → 编辑路径 ${path}（已缓存 ${PREMIUM_CACHE_MS / 3600000}h）`,
      );
      return path;
    })().finally(() => {
      detectInflight = null;
    });

    return detectInflight;
  }

  private async editWithEntities(msg: Api.Message, markdown: string): Promise<void> {
    await msg.edit({
      text: TelegramFormatter.markdownToHtml(markdown),
      parseMode: "html",
      linkPreview: false,
    });
  }

  private async editWithRich(msg: Api.Message, markdown: string): Promise<void> {
    const client = await this.getClient(msg);
    if (!client) throw new Error("Telegram client 未绑定到消息");
    const peer = await client.getInputEntity(msg.peerId);
    const InputRichMessageMarkdown = (Api as any).InputRichMessageMarkdown;
    await client.invoke(
      new Api.messages.EditMessage({
        peer,
        id: Number(msg.id),
        message: markdown,
        richMessage: new InputRichMessageMarkdown({ markdown }),
      } as any),
    );
  }

  /**
   * 按已缓存路径直接编辑；rich 若首次被服务端拒绝则降级 entities 并锁定，避免后续每条试错。
   */
  private async editPolishedMessage(
    msg: Api.Message,
    markdown: string,
    editPath: EditPath,
  ): Promise<EditPath> {
    if (!isOwnOutgoingMessage(msg)) {
      throw new Error("非本人发出的消息，跳过编辑");
    }

    if (editPath === "entities") {
      await this.editWithEntities(msg, markdown);
      return "entities";
    }

    try {
      await this.editWithRich(msg, markdown);
      return "rich";
    } catch (error) {
      if (!isRichMessageUnsupported(error)) throw error;
      // 账号标了 Premium 但会话/服务端不支持 RichMessage → 永久降级
      this.lockEditPath("entities", this.config.detectedPremium);
      console.warn(
        `[fwb] RichMessage 不被服务端接受，已降级并锁定 entities：${errorText(error)}`,
      );
      await this.editWithEntities(msg, markdown);
      return "entities";
    }
  }

  private statusText(): string {
    const premium =
      this.config.detectedPremium === true
        ? "是"
        : this.config.detectedPremium === false
          ? "否"
          : "未知";
    const path =
      this.config.editPath === "rich"
        ? "Premium RichMessage"
        : this.config.editPath === "entities"
          ? "免费 entities"
          : "待探测";
    const age =
      this.config.detectedAt != null
        ? `${Math.round((Date.now() - this.config.detectedAt) / 60000)} 分钟前`
        : "—";
    return [
      `<b>fwb 状态</b>`,
      `开关：<b>${this.config.enabled ? "开启" : "关闭"}</b>`,
      `策略：<code>${this.config.accountMode}</code>`,
      `Premium 探测：<b>${premium}</b>`,
      `编辑路径：<b>${path}</b>`,
      `探测时间：${age}`,
      `本地 RichMessage API：${hasNativeRichMessageApi() ? "有" : "无"}`,
    ].join("\n");
  }

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    fwb: async (msg): Promise<void> => {
      const parts = (msg.message || msg.text || "").trim().split(/\s+/);
      const action = String(parts[1] || "").toLowerCase();
      const arg = String(parts[2] || "").toLowerCase();

      if (["on", "enable", "开启", "启用"].includes(action)) {
        this.setEnabled(true);
        await msg.edit({
          text: `AI 富文本润色已<b>开启</b>（策略 <code>${this.config.accountMode}</code>）`,
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      if (["off", "disable", "关闭", "停用"].includes(action)) {
        this.setEnabled(false);
        await msg.edit({
          text: "AI 富文本润色已<b>关闭</b>",
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      if (action === "mode" || action === "模式") {
        if (!["auto", "premium", "free"].includes(arg)) {
          await msg.edit({
            text: `用法：<code>${htmlEscape(prefix())}fwb mode auto|premium|free</code>`,
            parseMode: "html",
            linkPreview: false,
          });
          return;
        }
        this.setAccountMode(arg as AccountMode);
        // 强制刷新探测（free/premium 已在 setAccountMode 锁路径；auto 清缓存）
        if (arg === "auto") {
          this.config.editPath = null;
          this.config.detectedAt = null;
          this.persist();
          try {
            await this.ensureEditPath(msg);
          } catch (error) {
            console.warn(`[fwb] mode auto 重探测失败：${errorText(error)}`);
          }
        }
        await msg.edit({
          text: this.statusText(),
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      if (action === "status" || action === "状态") {
        try {
          await this.ensureEditPath(msg);
        } catch {
          // 展示已有缓存即可
        }
        await msg.edit({
          text: this.statusText(),
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      if (action === "redetect" || action === "探测" || action === "refresh") {
        this.config.editPath = null;
        this.config.detectedAt = null;
        this.config.detectedPremium = null;
        this.persist();
        try {
          const path = await this.ensureEditPath(msg);
          await msg.edit({
            text: `已重新探测：路径 <b>${path}</b>\n\n${this.statusText()}`,
            parseMode: "html",
            linkPreview: false,
          });
        } catch (error) {
          await msg.edit({
            text: `重新探测失败：${htmlEscape(errorText(error))}`,
            parseMode: "html",
            linkPreview: false,
          });
        }
        return;
      }

      await msg.edit({
        text: this.description(),
        parseMode: "html",
        linkPreview: false,
      });
    },
  };

  listenMessageHandlerIgnoreEdited = true;

  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    if (!this.config.enabled || !this.signal || this.signal.aborted) return;
    if (!isEligibleMessage(msg as EligibleMessage)) return;

    const chatKey = messageChatKey(msg);
    const text = msg.message || msg.text || "";
    // 跳过命令本体、其他插件已格式化输出、命令触发后的短时回包
    if (shouldSkipPluginOrCommandOutput(msg, text, chatKey)) return;

    const key = `${chatKey}:${String(msg.id)}`;
    if (this.processing.has(key)) return;
    this.processing.add(key);

    // 绑定 client，供探测 / rich 编辑复用
    if (msg.client) this.client = msg.client;

    const totalStarted = Date.now();
    let release: (() => void) | null = null;
    try {
      const queueStarted = Date.now();
      release = await this.gate.acquire(this.signal);
      const queueMs = Date.now() - queueStarted;
      if (!this.config.enabled || this.signal.aborted) return;

      // 路径已缓存则 O(1)；仅首次 / 过期时探测
      const detectStarted = Date.now();
      const editPath = await this.ensureEditPath(msg);
      const detectMs = Date.now() - detectStarted;

      const original = msg.message || msg.text || "";
      // 按路径选 prompt，避免 premium 生成 rich 排版却走 entities（或反过来）
      const result = await polishText(original, this.signal, editPath);
      if (this.signal.aborted || !this.config.enabled) return;

      const editStarted = Date.now();
      const usedPath = await this.editPolishedMessage(msg, result.text, editPath);
      const editMs = Date.now() - editStarted;
      const totalMs = Date.now() - totalStarted;
      console.log(
        `[fwb] 消息 ${String(msg.id)} 已用 ${result.model} 润色 | ` +
          `路径 ${usedPath} | 总耗时 ${totalMs}ms ` +
          `(排队 ${queueMs}ms / 探测 ${detectMs}ms / AI ${result.aiMs}ms / 编辑 ${editMs}ms) | ` +
          `max_tokens=${result.maxTokens} 原文 ${original.length} 字`,
      );
    } catch (error) {
      if (!this.signal?.aborted) {
        console.error(
          `[fwb] 消息 ${String(msg.id)} 润色失败，保留原文（${Date.now() - totalStarted}ms）：${errorText(error)}`,
        );
      }
    } finally {
      release?.();
      this.processing.delete(key);
    }
  };
}

export default new FwbPlugin();

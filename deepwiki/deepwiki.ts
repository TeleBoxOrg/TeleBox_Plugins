import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";
import { JSONFilePreset, Low } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { TelegramFormatter } from "@utils/telegramFormatter";
import { TelegraphFormatter } from "@utils/telegraphFormatter";
import path from "path";
import axios from "axios";
import http from "http";
import https from "https";

type RepoEntry = {
  tag: string;
  repo: string;
  url: string;
  addedAt: string;
};

type ContextTurn = {
  q: string;
  a: string;
  at: string;
};

type ChatState = {
  currentTag: string;
  repos: Record<string, RepoEntry>;
  contextEnabled?: boolean;
  contextTurns?: Record<string, ContextTurn[]>;
  telegraphToken?: string;
};

type MainChatState = {
  currentTag: string;
  repos: Record<string, RepoEntry>;
};

type MainDB = {
  chats: Record<string, MainChatState>;
  telegraphToken?: string;
};

type CtxChatState = {
  contextEnabled?: boolean;
  contextTurns?: Record<string, ContextTurn[]>;
};

type CtxDB = {
  chats: Record<string, CtxChatState>;
};

const MAX_TG_LEN = 4050;
const MAX_DEEPWIKI_LEN = 48000;
const MAX_TURNS_PER_TAG = 50;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const getMessageText = (m?: Api.Message | null): string => {
  if (!m) return "";
  const text = (m as any).message ?? (m as any).text ?? "";
  return typeof text === "string" ? text : "";
};

class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

const requireUser = (cond: any, msg: string) => {
  if (!cond) throw new UserError(msg);
};

class MessageSender {
  static async sendOrEdit(msg: Api.Message, text: string, parseMode: "html" | "markdown" = "html"): Promise<Api.Message> {
    try {
      return await msg.edit({ text, parseMode, linkPreview: false } as any);
    } catch {
      return await msg.reply({ message: text, parseMode, linkPreview: false } as any);
    }
  }

  static async sendNew(
    msg: Api.Message,
    text: string,
    parseMode: "html" | "markdown" = "html",
    replyToId?: number,
    linkPreview: boolean = false
  ): Promise<Api.Message> {
    return await msg.client.sendMessage(msg.chatId || msg.peerId, {
      message: text,
      parseMode,
      ...(replyToId ? { replyTo: replyToId } : {}),
      linkPreview,
    });
  }
}

class DeepWikiStore {
  private dbMain!: Low<MainDB>;
  private dbCtx!: Low<CtxDB>;

  async init(): Promise<void> {
    const baseDir = createDirectoryInAssets("deepwiki");
    const mainFile = path.join(baseDir, "config.json");
    const ctxFile = path.join(baseDir, "context.json");

    this.dbMain = await JSONFilePreset<MainDB>(mainFile, { chats: {}, telegraphToken: "" });
    await this.dbMain.read();
    this.dbMain.data ||= { chats: {}, telegraphToken: "" };
    this.dbMain.data.chats ||= {};
    this.dbMain.data.telegraphToken ||= "";
    await this.dbMain.write();

    this.dbCtx = await JSONFilePreset<CtxDB>(ctxFile, { chats: {} });
    await this.dbCtx.read();
    this.dbCtx.data ||= { chats: {} };
    this.dbCtx.data.chats ||= {};
    await this.dbCtx.write();
  }

  private ensureReady() {
    if (!this.dbMain || !this.dbCtx) throw new Error("DeepWikiStore not initialized");
  }

  private normalizeMainState(state: MainChatState): MainChatState {
    state.currentTag ||= "";
    state.repos ||= {};
    return state;
  }

  private normalizeCtxState(state: CtxChatState): CtxChatState {
    state.contextEnabled = !!state.contextEnabled;
    state.contextTurns ||= {};
    return state;
  }

  private async ensureMainChat(chatKey: string): Promise<MainChatState> {
    this.ensureReady();
    await this.dbMain.read();
    this.dbMain.data ||= { chats: {}, telegraphToken: "" };
    this.dbMain.data.chats ||= {};
    this.dbMain.data.telegraphToken ||= "";
    if (!this.dbMain.data.chats[chatKey]) {
      this.dbMain.data.chats[chatKey] = this.normalizeMainState({ currentTag: "", repos: {} });
      await this.dbMain.write();
    } else {
      this.dbMain.data.chats[chatKey] = this.normalizeMainState(this.dbMain.data.chats[chatKey]);
    }
    return this.dbMain.data.chats[chatKey];
  }

  private async ensureCtxChat(chatKey: string): Promise<CtxChatState> {
    this.ensureReady();
    await this.dbCtx.read();
    this.dbCtx.data ||= { chats: {} };
    this.dbCtx.data.chats ||= {};
    if (!this.dbCtx.data.chats[chatKey]) {
      this.dbCtx.data.chats[chatKey] = this.normalizeCtxState({ contextEnabled: false, contextTurns: {} });
      await this.dbCtx.write();
    } else {
      this.dbCtx.data.chats[chatKey] = this.normalizeCtxState(this.dbCtx.data.chats[chatKey]);
    }
    return this.dbCtx.data.chats[chatKey];
  }

  async getChatState(chatKey: string): Promise<ChatState> {
    this.ensureReady();
    const main = await this.ensureMainChat(chatKey);
    const ctx = await this.ensureCtxChat(chatKey);
    await this.dbMain.read();
    return {
      currentTag: main.currentTag || "",
      repos: main.repos || {},
      contextEnabled: !!ctx.contextEnabled,
      contextTurns: ctx.contextTurns || {},
      telegraphToken: this.dbMain.data?.telegraphToken || "",
    };
  }

  async setRepo(chatKey: string, entry: RepoEntry, makeCurrent: boolean = true): Promise<void> {
    this.ensureReady();
    const state = await this.ensureMainChat(chatKey);
    state.repos ||= {};
    state.repos[entry.tag] = entry;
    if (makeCurrent) state.currentTag = entry.tag;
    this.dbMain.data!.chats[chatKey] = state;
    await this.dbMain.write();
  }

  async deleteRepo(chatKey: string, tag: string): Promise<boolean> {
    this.ensureReady();
    const main = await this.ensureMainChat(chatKey);
    if (!main.repos?.[tag]) return false;

    delete main.repos[tag];
    if (main.currentTag === tag) main.currentTag = "";
    this.dbMain.data!.chats[chatKey] = main;
    await this.dbMain.write();

    const ctx = await this.ensureCtxChat(chatKey);
    if (ctx.contextTurns?.[tag]) {
      delete ctx.contextTurns[tag];
      this.dbCtx.data!.chats[chatKey] = ctx;
      await this.dbCtx.write();
    }

    return true;
  }

  async setCurrent(chatKey: string, tag: string): Promise<void> {
    this.ensureReady();
    const state = await this.ensureMainChat(chatKey);
    requireUser(!!state.repos?.[tag], `项目不存在：<code>${escapeHtml(tag)}</code>`);
    state.currentTag = tag;
    this.dbMain.data!.chats[chatKey] = state;
    await this.dbMain.write();
  }

  async setContextEnabled(chatKey: string, enabled: boolean): Promise<void> {
    this.ensureReady();
    const ctx = await this.ensureCtxChat(chatKey);
    ctx.contextEnabled = !!enabled;
    this.dbCtx.data!.chats[chatKey] = ctx;
    await this.dbCtx.write();
  }

  async clearContext(chatKey: string, tag?: string): Promise<void> {
    this.ensureReady();
    const ctx = await this.ensureCtxChat(chatKey);
    ctx.contextTurns ||= {};
    if (tag) {
      delete ctx.contextTurns[tag];
    } else {
      ctx.contextTurns = {};
    }
    this.dbCtx.data!.chats[chatKey] = ctx;
    await this.dbCtx.write();
  }

  async appendTurn(chatKey: string, tag: string, q: string, a: string): Promise<void> {
    this.ensureReady();
    const ctx = await this.ensureCtxChat(chatKey);
    ctx.contextTurns ||= {};
    const turns = ctx.contextTurns[tag] || [];
    turns.push({ q, a, at: new Date().toISOString() });
    ctx.contextTurns[tag] = turns.slice(-MAX_TURNS_PER_TAG);
    this.dbCtx.data!.chats[chatKey] = ctx;
    await this.dbCtx.write();
  }

  async getTurns(chatKey: string, tag: string): Promise<ContextTurn[]> {
    this.ensureReady();
    const ctx = await this.ensureCtxChat(chatKey);
    return (ctx.contextTurns?.[tag] || []).slice();
  }

  async getTelegraphToken(): Promise<string> {
    this.ensureReady();
    await this.dbMain.read();
    this.dbMain.data ||= { chats: {}, telegraphToken: "" };
    this.dbMain.data.telegraphToken ||= "";
    return this.dbMain.data.telegraphToken || "";
  }

  async setTelegraphToken(token: string): Promise<void> {
    this.ensureReady();
    await this.dbMain.read();
    this.dbMain.data ||= { chats: {}, telegraphToken: "" };
    this.dbMain.data.telegraphToken = token || "";
    await this.dbMain.write();
  }
}

class DeepWikiMcp {
  private client: any | null = null;
  private connecting: Promise<void> | null = null;
  private repoKey: string | null = null;
  private questionKey: string | null = null;

  private extractText(result: any): string {
    const parts = result?.content;
    if (!Array.isArray(parts)) {
      if (typeof result === "string") return result;
      if (typeof result?.text === "string") return result.text;
      return String(result ?? "");
    }
    const texts = parts
      .map((p: any) => {
        if (p?.type === "text" && typeof p?.text === "string") return p.text;
        if (typeof p?.text === "string") return p.text;
        return "";
      })
      .filter(Boolean);
    return texts.join("\n").trim();
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return await this.connecting;
    this.connecting = (async () => {
      let ClientCtor: any;
      let SSEClientTransportCtor: any;
      try {
        const clientMod: any = await import("@modelcontextprotocol/sdk/client/index.js");
        const sseMod: any = await import("@modelcontextprotocol/sdk/client/sse.js");
        ClientCtor = clientMod?.Client;
        SSEClientTransportCtor = sseMod?.SSEClientTransport;
      } catch {
        throw new UserError(
          "缺少环境依赖，择需安装：\n" +
            "<code>npm install @modelcontextprotocol/sdk</code>\n" +
            "<code>pnpm add @modelcontextprotocol/sdk</code>"
        );
      }

      const transport = new SSEClientTransportCtor(new URL("https://mcp.deepwiki.com/sse"));
      const client = new ClientCtor({ name: "telebox-deepwiki", version: "0.5.1" }, { capabilities: {} });
      await client.connect(transport);
      this.client = client;
      const tools = await client.listTools();
      const ask = tools?.tools?.find((t: any) => t?.name === "ask_question");
      const props = ask?.inputSchema?.properties || {};
      const keys = Object.keys(props);
      this.repoKey =
        keys.find((k) => /repo/i.test(k)) ||
        keys.find((k) => /repository/i.test(k)) ||
        keys.find((k) => /project/i.test(k)) ||
        keys[0] ||
        "repo";
      this.questionKey =
        keys.find((k) => /question/i.test(k)) ||
        keys.find((k) => /query/i.test(k)) ||
        keys.find((k) => /prompt/i.test(k)) ||
        keys[1] ||
        "question";
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async ask(repo: string, question: string): Promise<string> {
    await this.ensureConnected();
    if (!this.client) throw new Error("DeepWiki MCP client not ready");
    const args: Record<string, any> = {
      [this.repoKey || "repo"]: repo,
      [this.questionKey || "question"]: question,
    };
    const res = await this.client.callTool({ name: "ask_question", arguments: args });
    const text = this.extractText(res);
    return text || "DeepWiki 未返回可用文本结果（可能项目未被索引或暂时不可用）";
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {}
    this.client = null;
    this.connecting = null;
  }
}

const normalizeTag = (tag: string): string => tag.trim().replace(/^@/, "").replace(/\s+/g, "-");

const parseRepoFromUrl = (url: string): { repo: string; canonicalUrl: string } | null => {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === "deepwiki.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const owner = parts[0];
        const repo = parts[1];
        const full = `${owner}/${repo}`;
        return { repo: full, canonicalUrl: `https://deepwiki.com/${owner}/${repo}` };
      }
      return null;
    }
    if (host === "github.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const owner = parts[0];
        const repo = parts[1].replace(/\.git$/i, "");
        const full = `${owner}/${repo}`;
        return { repo: full, canonicalUrl: `https://deepwiki.com/${owner}/${repo}` };
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
};

const buildQuestionWithContext = (turns: ContextTurn[], question: string): { finalQuestion: string; dropped: number } => {
  const header =
    "以下是我们的历史问答上下文，请在回答时参考；若上下文与仓库事实冲突，以仓库内容为准。\n\n";
  const tail = `现在的问题：\nQ: ${question}\n`;
  let safeTail = tail;
  if (header.length + safeTail.length > MAX_DEEPWIKI_LEN) {
    const keep = Math.max(0, MAX_DEEPWIKI_LEN - header.length);
    safeTail = safeTail.slice(safeTail.length - keep);
  }
  const renderTurns = (ts: ContextTurn[]) =>
    ts
      .map((t, idx) => {
        const n = idx + 1;
        return `[历史问答 ${n}]\nQ: ${t.q}\nA: ${t.a}\n`;
      })
      .join("\n");
  let working = turns.slice();
  let dropped = 0;
  const assemble = () => {
    const ctx = working.length ? renderTurns(working) + "\n\n" : "";
    return header + ctx + safeTail;
  };
  let finalText = assemble();
  while (finalText.length > MAX_DEEPWIKI_LEN && working.length > 0) {
    working.shift();
    dropped++;
    finalText = assemble();
  }
  if (finalText.length > MAX_DEEPWIKI_LEN) {
    finalText = finalText.slice(finalText.length - MAX_DEEPWIKI_LEN);
  }
  return { finalQuestion: finalText, dropped };
};

const buildQAHtml = (headerLines: string[], question: string, answerMarkdown: string, collapseSafe: boolean): string => {
  const header = headerLines.filter(Boolean).join("\n");
  const safeQ = escapeHtml(question);
  const htmlA = TelegramFormatter.markdownToHtml(answerMarkdown, { collapseSafe });

  const qBlock = collapseSafe ? `Q:\n<blockquote expandable>${safeQ}</blockquote>\n\n` : `Q:\n${safeQ}\n\n`;
  const aBlock = collapseSafe ? `A:\n<blockquote expandable>${htmlA}</blockquote>` : `A:\n${htmlA}`;

  return header ? `${header}\n\n${qBlock}${aBlock}` : `${qBlock}${aBlock}`;
};

class DeepWikiPlugin extends Plugin {
  name = "deepwiki";

  private store = new DeepWikiStore();
  private mcp = new DeepWikiMcp();
  private inited = false;

  private httpClient = axios.create({
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
  });

  private async initOnce(): Promise<void> {
    if (this.inited) return;
    await this.store.init();
    this.inited = true;
  }

  private getMainPrefix(): string {
    const prefixes = getPrefixes();
    return prefixes[0] || "";
  }

  private getChatKey(msg: Api.Message): string {
    const key = (msg.chatId || msg.peerId) as any;
    return String(key ?? "unknown");
  }

  private helpText(): string {
    const p = this.getMainPrefix();
    return (
      `<b>📚 DeepWiki 插件</b>\n\n` +
      `DeepWiki通过与Github上的项目建立索引可以解决目前普遍的Ai信息滞后问题来精准回答您的提问\n\n` +
      `<b>🗂️ 项目管理</b>\n` +
      `• <code>${p}deepwiki add &lt;tag&gt; &lt;url&gt;</code>（添加新的项目）\n` +
      `• <code>${p}deepwiki lst</code>（已添加的项目）\n` +
      `• <code>${p}deepwiki use &lt;tag&gt;</code>（切换默认项目）\n` +
      `• <code>${p}deepwiki del &lt;tag&gt;</code>（删除指定项目）\n\n` +
      `<b>📜 上下文管理</b>\n` +
      `• <code>${p}deepwiki ctx</code>（上下文状态）\n` +
      `• <code>${p}deepwiki ctx on</code>（开启上下文）\n` +
      `• <code>${p}deepwiki ctx off</code>（关闭上下文）\n` +
      `• <code>${p}deepwiki ctx del</code>（清空当前项目上下文）\n` +
      `• <code>${p}deepwiki ctx del &lt;tag&gt;</code>（清空指定项目上下文）\n` +
      `• <code>${p}deepwiki ctx del all</code>（清空全部项目上下文）\n\n` +
      `<b>📌 使用说明</b>\n` +
      `• <code>${p}deepwiki 你的问题</code>（发起默认项目提问）\n` +
      `• <code>${p}deepwiki &lt;tag&gt; 你的问题</code>（发起指定项目提问）\n\n` +
      `说明：项目需要能在 deepwiki.com 上正常访问（已索引）。`
    );
  }

  private formatError(err: any): string {
    if (err instanceof UserError) return `🚫 ${err.message}`;
    const msg = typeof err?.message === "string" ? err.message : String(err);
    return `❌ <b>错误:</b> ${escapeHtml(msg)}`;
  }

  private async ensureTelegraphToken(token?: string): Promise<string> {
    const existing = token || (await this.store.getTelegraphToken());
    if (existing) return existing;

    const response = await this.httpClient.request({
      url: "https://api.telegra.ph/createAccount",
      method: "POST",
      data: { short_name: "TeleBoxDeepWiki", author_name: "TeleBox" },
    });

    const tgToken = response.data?.result?.access_token;
    if (!tgToken) throw new Error("Telegraph账户创建失败");
    await this.store.setTelegraphToken(tgToken);
    return tgToken;
  }

  private async createTelegraphPage(markdown: string, titleSource?: string): Promise<{ url: string; title: string }> {
    const tgToken = await this.ensureTelegraphToken();
    const rawTitle = (titleSource || "").replace(/\s+/g, " ").trim();
    const shortTitle = rawTitle.length > 24 ? `${rawTitle.slice(0, 24)}…` : rawTitle;
    const title = shortTitle || `DeepWiki - ${new Date().toLocaleString()}`;
    const nodes = TelegraphFormatter.toNodes(markdown);

    const response = await this.httpClient.request({
      url: "https://api.telegra.ph/createPage",
      method: "POST",
      data: {
        access_token: tgToken,
        title,
        content: nodes,
        return_content: false,
      },
    });

    const url = response.data?.result?.url;
    if (!url) throw new Error(response.data?.error || "Telegraph页面创建失败");
    return { url, title };
  }

  private async sendAnswerOrTelegraph(
    msg: Api.Message,
    replyToId: number | undefined,
    headerLines: string[],
    question: string,
    answerMarkdown: string,
    collapseSafe: boolean
  ): Promise<void> {
    const signature = `<i>🍀Powered by DeepWiki</i>`;
    const html = buildQAHtml(headerLines, question, answerMarkdown, collapseSafe);
    const finalHtml = html.length + (`\n\n${signature}`).length <= MAX_TG_LEN ? `${html}\n\n${signature}` : `${html}`;

    if (finalHtml.length <= MAX_TG_LEN) {
      await MessageSender.sendNew(msg, finalHtml, "html", replyToId, false);
      return;
    }

    const headerText = headerLines
      .filter(Boolean)
      .map((l) => l.replace(/<[^>]+>/g, ""))
      .join("\n");
    const telegraphMarkdown =
      (headerText ? `${headerText}\n\n` : "") + `**Q:**\n${question}\n\n**A:**\n${answerMarkdown}\n`;
    const telegraphResult = await this.createTelegraphPage(telegraphMarkdown, question);

    const qBlock = collapseSafe
      ? `Q:\n<blockquote expandable>${escapeHtml(question)}</blockquote>\n\n`
      : `Q:\n${escapeHtml(question)}\n\n`;

    const linkHtml = `📰内容比较长，Telegraph观感更好喔:\n\n🔗 <a href="${telegraphResult.url}">点我阅读内容</a>`;
    const aBlock = collapseSafe
      ? `A:\n<blockquote expandable>${linkHtml}</blockquote>`
      : `A:\n${linkHtml}`;

    const header = headerLines.filter(Boolean).join("\n");
    const body = header ? `${header}\n\n${qBlock}${aBlock}` : `${qBlock}${aBlock}`;
    const withSig = body.length + (`\n\n${signature}`).length <= MAX_TG_LEN ? `${body}\n\n${signature}` : body;

    await MessageSender.sendNew(msg, withSig, "html", replyToId, false);
  }

  description = async (): Promise<string> => this.helpText();

  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    deepwiki: async (msg: Api.Message, trigger?: Api.Message) => {
      await this.initOnce();
      const chatKey = this.getChatKey(msg);
      const raw = getMessageText(msg).trim();
      const args = raw.split(/\s+/).slice(1);
      const original = trigger || msg;
      try {
        if (args.length === 0) {
          await MessageSender.sendOrEdit(original, "🚫 至少需要一个问题", "html");
          return;
        }
        const state = await this.store.getChatState(chatKey);
        const sub = (args[0] || "").toLowerCase();
        if (sub === "help" || sub === "?") {
          await MessageSender.sendOrEdit(original, this.helpText(), "html");
          return;
        }
        if (sub === "lst") {
          const entries = Object.values(state.repos || {});
          if (entries.length === 0) {
            await MessageSender.sendOrEdit(
              original,
              `暂无项目。\n用 <code>${this.getMainPrefix()}deepwiki add &lt;tag&gt; &lt;url&gt;</code> 添加。`,
              "html"
            );
            return;
          }
          const cur = state.currentTag;
          const lines = entries
            .sort((a, b) => a.tag.localeCompare(b.tag))
            .map((e) => {
              const marker = e.tag === cur ? "✅" : "•";
              return `${marker} <code>${escapeHtml(e.tag)}</code> → <code>${escapeHtml(e.repo)}</code>`;
            })
            .join("\n");
          await MessageSender.sendOrEdit(original, `<b>📌 已添加项目</b>\n\n${lines}`, "html");
          return;
        }
        if (sub === "use") {
          requireUser(args.length >= 2, `用法：<code>${this.getMainPrefix()}deepwiki use &lt;tag&gt;</code>`);
          const tag = normalizeTag(args[1]);
          requireUser(!!state.repos?.[tag], `项目不存在：<code>${escapeHtml(tag)}</code>`);
          await this.store.setCurrent(chatKey, tag);
          const entry = (await this.store.getChatState(chatKey)).repos[tag];
          await MessageSender.sendOrEdit(
            original,
            `✅ 已切换默认项目：<code>${escapeHtml(entry.tag)}</code>\n• <code>${escapeHtml(entry.url)}</code>`,
            "html"
          );
          return;
        }
        if (sub === "del") {
          requireUser(args.length >= 2, `用法：<code>${this.getMainPrefix()}deepwiki del &lt;tag&gt;</code>`);
          const tag = normalizeTag(args[1]);
          const ok = await this.store.deleteRepo(chatKey, tag);
          requireUser(ok, `项目不存在：<code>${escapeHtml(tag)}</code>`);
          await MessageSender.sendOrEdit(original, `✅ 已删除项目：<code>${escapeHtml(tag)}</code>`, "html");
          return;
        }
        if (sub === "add") {
          requireUser(args.length >= 3, `用法：<code>${this.getMainPrefix()}deepwiki add &lt;tag&gt; &lt;url&gt;</code>`);
          const tagArg = normalizeTag(args[1]);
          requireUser(/^[A-Za-z0-9_.-]+$/.test(tagArg), "&lt;tag&gt; 只能包含字母/数字/下划线/点/短横线");
          const parsed = parseRepoFromUrl(args[2]);
          requireUser(!!parsed, "链接格式不正确，仅支持 deepwiki.com 或 github.com");
          const entry: RepoEntry = {
            tag: tagArg,
            repo: parsed!.repo,
            url: parsed!.canonicalUrl,
            addedAt: new Date().toISOString(),
          };
          await this.store.setRepo(chatKey, entry, true);
          await MessageSender.sendOrEdit(
            original,
            `✅ 已添加并切换默认项目：<code>${escapeHtml(entry.tag)}</code>\n• <code>${escapeHtml(entry.url)}</code>`,
            "html"
          );
          return;
        }
        if (sub === "ctx") {
          const action = (args[1] || "").toLowerCase();

          if (action === "on") {
            await this.store.setContextEnabled(chatKey, true);
            await MessageSender.sendOrEdit(original, `✅ 上下文已开启`, "html");
            return;
          }

          if (action === "off") {
            await this.store.setContextEnabled(chatKey, false);
            await MessageSender.sendOrEdit(original, `✅ 上下文已关闭`, "html");
            return;
          }

          if (action === "del") {
            const rawArg = (args[2] || "").trim().toLowerCase();
            if (rawArg === "all") {
              await this.store.clearContext(chatKey);
              await MessageSender.sendOrEdit(original, `✅ 已清空全部项目上下文`, "html");
              return;
            }

            const tagArg = args[2] ? normalizeTag(args[2]) : "";
            const tagToClear = tagArg || state.currentTag;
            requireUser(!!tagToClear, "未指定 <tag>，且当前也没有默认项目。用法：<code>deepwiki ctx del &lt;tag&gt;</code>");
            if (tagArg) {
              requireUser(!!state.repos?.[tagArg], `项目不存在：<code>${escapeHtml(tagArg)}</code>`);
            }
            await this.store.clearContext(chatKey, tagToClear);
            await MessageSender.sendOrEdit(
              original,
              `✅ 已清空项目上下文：<code>${escapeHtml(tagToClear)}</code>`,
              "html"
            );
            return;
          }

          requireUser(!action, `未知子命令：<code>${escapeHtml(action)}</code>`);

          const enabled = !!state.contextEnabled;
          const curTag = state.currentTag || "";
          const entries = Object.values(state.repos || {}).sort((a, b) => a.tag.localeCompare(b.tag));
          const lines: string[] = [];
          lines.push(`<b>📜 上下文状态</b>\n`);
          lines.push(`• 上下文已${enabled ? "开启" : "关闭"}`);
          for (const e of entries) {
            const turns = state.contextTurns?.[e.tag] || [];
            const marker = e.tag === curTag ? "✅" : "•";
            lines.push(`${marker} <code>${escapeHtml(e.tag)}</code>（缓存轮数：<b>${turns.length}</b>）`);
          }
          await MessageSender.sendOrEdit(original, lines.join("\n"), "html");
          return;
        }

        const maybeTag = normalizeTag(args[0]);
        const hasTag = !!state.repos?.[maybeTag];
        let tagToUse = "";
        let question = "";
        if (hasTag && args.length >= 2) {
          tagToUse = maybeTag;
          question = args.slice(1).join(" ").trim();
        } else {
          tagToUse = state.currentTag;
          question = args.join(" ").trim();
        }
        requireUser(!!question, "请输入问题内容");
        requireUser(!!tagToUse, "尚未设置默认项目，请先添加项目");
        const entry = state.repos?.[tagToUse];
        requireUser(!!entry, "项目不存在，请检查 <tag>");

        await MessageSender.sendOrEdit(original, "💬 <b>DeepWiki 正在处理</b>", "html");

        const ctxEnabled = !!state.contextEnabled;
        let finalQuestion = question;
        let droppedTurns = 0;
        if (ctxEnabled) {
          const turns = await this.store.getTurns(chatKey, tagToUse);
          const built = buildQuestionWithContext(turns, question);
          finalQuestion = built.finalQuestion;
          droppedTurns = built.dropped;
        }

        const answer = await this.mcp.ask(entry.repo, finalQuestion);
        if (ctxEnabled) {
          await this.store.appendTurn(chatKey, tagToUse, question, answer);
        }

        const ctxLine =
          ctxEnabled && droppedTurns > 0
            ? `<b>上下文:</b> 开（本次因长度限制丢弃最早 <b>${droppedTurns}</b> 轮）`
            : ctxEnabled
              ? `<b>上下文:</b> 开`
              : `<b>上下文:</b> 关`;

        const headerLines = [`<b>项目:</b> <code>${escapeHtml(entry.repo)}</code>`, ctxLine];

        await this.sendAnswerOrTelegraph(msg, (original as any).id, headerLines, question, answer, true);

        try {
          await original.delete();
        } catch {}
      } catch (err: any) {
        await MessageSender.sendOrEdit(original, this.formatError(err), "html");
      }
    },
  };

  async onUnload(): Promise<void> {
    await this.mcp.close();
  }
}

export default new DeepWikiPlugin();

import { Plugin, type PanelSettingsAdapter, type PanelSettingField, type PanelFieldType } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import type { TelegramClient } from "@mtcute/node";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
import type { Chat, User } from "@mtcute/core";
import * as path from "path";
import { logger } from "@utils/logger";
import { htmlEscape } from "@utils/htmlEscape";

const PREFIX = getPrefixes()[0];

const HELP = `🕵️ <b>FBI 跨群组追踪</b>

• <code>${PREFIX}fbi cs [目标]</code> — 搜索目标最新消息
• <code>${PREFIX}fbi sv [目标]</code> — 蹲守目标下一条消息
• <code>${PREFIX}fbi ds [目标]</code> — 分析目标最活跃群组
• <code>${PREFIX}fbi ssv</code> — 终止所有蹲守
• <code>${PREFIX}fbi cache</code> — 查看/管理消息缓存
• <code>${PREFIX}fbi help</code> — 本帮助

目标可为 @用户名、用户ID，或回复消息自动取被回复者。`;

const CACHE_MSG_LIMIT = 3000; // max messages stored per group
const CACHE_LIMIT_DEF = 300; // default max groups to cache
const CACHE_LIMIT_MIN = 10;
const CACHE_LIMIT_MAX = 1000;

const CACHE_EXPIRE_SECS = 30 * 24 * 60 * 60; // 30 days in seconds

/** Resolve a display name from a User or Chat peer (mtcute getChat returns User|Chat). */
function resolveDisplayName(peer: User | Chat | { id: number; title?: string; firstName?: string; lastName?: string }, fallback: string): string {
  if ("firstName" in peer && typeof peer.firstName === "string") {
    const u = peer as User;
    const full = [u.firstName, u.lastName].filter(Boolean).join(" ");
    if (full) return full;
  }
  if ("title" in peer && typeof peer.title === "string" && peer.title) return peer.title;
  return fallback;
}

/** random delay between min and max ms */
function rndDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal serializable representation of a chat message */
interface CachedMsg {
  id: number;
  senderId: string; // mtcute marker id (marked id) as string
  date: number; // unix seconds
  text: string;
}

interface CachedChat {
  username?: string;
  title?: string;
  msgs: CachedMsg[];
}

interface SvEntry {
  targetId: string;
  targetName: string;
  triggerPeer: string;
  triggerMsgId: number;
}

interface FbiConfig {
  surveillance: Record<string, SvEntry>;
  cacheLimit: number;
}

interface FbiCache {
  cache: Record<string, CachedChat>;
}

const CONFIG_DEF: FbiConfig = { surveillance: {}, cacheLimit: CACHE_LIMIT_DEF };

function stripMsg(m: { id: number; sender: { id?: number }; date: Date; text?: string }): CachedMsg {
  return {
    id: m.id,
    senderId: String(m.sender?.id ?? ""),
    date: Math.floor(m.date.getTime() / 1000),
    text: m.text || "",
  };
}

class FbiPlugin extends Plugin {
  description = `FBI 跨群组追踪\n\n${HELP}`;

  cmdHandlers = {
    fbi: async (msg: MessageContext) => {
      await this.onCmd(msg);
    },
  };
  listenMessageHandler = (msg: MessageContext) => this.onMsg(msg);

  private configDb: Awaited<ReturnType<typeof JSONFilePreset<FbiConfig>>> | null = null;
  private cacheDb: Awaited<ReturnType<typeof JSONFilePreset<FbiCache>>> | null = null;
  private sv = new Map<string, SvEntry>();
  private chatCache = new Map<string, CachedChat>();
  private cacheReady = false;
  private cacheDirty = false;
  private cachePersistTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** remove messages older than 30 days from a chat cache, return true if any pruned */
  private pruneExpired(chat: CachedChat): boolean {
    const cutoff = Math.floor(Date.now() / 1000) - CACHE_EXPIRE_SECS;
    const before = chat.msgs.length;
    chat.msgs = chat.msgs.filter((m) => m.date > cutoff);
    return chat.msgs.length !== before;
  }

  async setup(): Promise<void> {
    await this.initDB();
  }

  /* ====== bootstrap ====== */

  private async initDB() {
    const p = path.join(createDirectoryInAssets("fbi"), "db.json");
    this.configDb = await JSONFilePreset<FbiConfig>(p, CONFIG_DEF);
    // ensure cacheLimit has a default
    if (typeof this.configDb.data.cacheLimit !== "number") {
      this.configDb.data.cacheLimit = CACHE_LIMIT_DEF;
      await this.configDb.write();
    }
    for (const [k, v] of Object.entries(this.configDb.data.surveillance)) this.sv.set(k, v);

    // load cache from separate file — tolerate corrupt/truncated JSON
    const cp = path.join(createDirectoryInAssets("fbi"), "cache.json");
    try {
      this.cacheDb = await JSONFilePreset<FbiCache>(cp, { cache: {} });
      if (this.cacheDb.data.cache) {
        for (const [k, v] of Object.entries(this.cacheDb.data.cache)) this.chatCache.set(k, v);
        logger.info(`[fbi] cache loaded: ${this.chatCache.size} groups`);
      }
    } catch (e: unknown) {
      logger.error("[fbi] initDB cache load failed, resetting cache.json", e);
      try {
        const fs = await import("fs");
        if (fs.existsSync(cp)) {
          fs.renameSync(cp, `${cp}.corrupt.${Date.now()}`);
        }
      } catch (_renameErr: unknown) {
        /* ignore rename failure; overwrite below */
      }
      this.chatCache.clear();
      this.cacheDb = await JSONFilePreset<FbiCache>(cp, { cache: {} });
      await this.cacheDb.write();
      logger.warn("[fbi] cache reset to empty after corruption recovery");
    }

    this.cacheReady = true;

    // cold sweep every 24h — prune expired messages in silent groups
    this.sweepTimer = setInterval(() => {
      if (!this.cacheReady) return;
      let anyPruned = false;
      for (const chat of this.chatCache.values()) if (this.pruneExpired(chat)) anyPruned = true;
      if (anyPruned) this.schedulePersistCache();
    }, 24 * 60 * 60 * 1000);
  }

  private async persistDb() {
    if (!this.configDb) return;
    this.configDb.data.surveillance = Object.fromEntries(this.sv);
    await this.configDb.write();
  }

  /** debounced cache persist — at most once every 10s */
  private schedulePersistCache() {
    this.cacheDirty = true;
    if (this.cachePersistTimer) return; // already queued
    this.cachePersistTimer = setTimeout(() => {
      this.cachePersistTimer = null;
      if (!this.cacheDirty) return;
      this.cacheDirty = false;
      if (this.cacheDb) {
        this.cacheDb.data.cache = Object.fromEntries(this.chatCache);
        this.cacheDb.write().catch((e) => logger.warn("[fbi] persist cache failed", e));
      }
    }, 10_000);
  }

  /** scan public groups one-by-one with random delay, fill chatCache */
  private async buildCache() {
    try {
      const cl = await getGlobalClient();
      if (!cl) return;

      const limit = this.configDb?.data.cacheLimit ?? CACHE_LIMIT_DEF;
      const dialogs: { id: number; isGroup: boolean; isChannel: boolean }[] = [];
      for await (const d of cl.iterDialogs({})) {
        const peer = d.peer;
        const id = (peer as { id?: number }).id;
        if (typeof id !== "number") continue;
        const type = (peer as { type?: string }).type;
        const isGroup = type === "group" || type === "supergroup" || type === "gigagroup";
        const isChannel = type === "channel";
        if (isGroup || isChannel) dialogs.push({ id, isGroup, isChannel });
        if (dialogs.length >= limit) break;
      }

      let count = 0;
      for (const d of dialogs) {
        const msgs: CachedMsg[] = [];
        try {
          const history = await cl.getHistory(d.id, { limit: CACHE_MSG_LIMIT });
          for (const m of history) msgs.push(stripMsg(m));
        } catch (e: unknown) {
          logger.warn(`[fbi] getHistory failed for ${d.id}`, e);
          continue;
        }
        // get entity for username/title (public groups only)
        let username: string | undefined;
        let title: string | undefined;
        try {
          const entity = await cl.getChat(d.id);
          username = (entity as Chat)?.username ?? undefined;
          title = (entity as Chat)?.title ?? undefined;
        } catch {
          /* best-effort */
        }
        // only cache public groups (has username)
        if (username) {
          this.chatCache.set(String(d.id), { username, title, msgs });
          count++;
        }
        await rndDelay(1000, 10000);
      }

      if (this.cacheDb) {
        this.cacheDb.data.cache = Object.fromEntries(this.chatCache);
        await this.cacheDb.write();
      }
      logger.info(`[fbi] cache ready: ${count} groups (limit ${limit})`);
    } finally {
      this.cacheReady = true;
    }
  }

  /* ====== router ====== */

  private async onCmd(msg: MessageContext) {
    const parts = msg.text?.trim().split(/\s+/) || [];
    const sub = parts[1]?.toLowerCase();
    const args = parts.slice(2);

    try {
      switch (sub) {
        case "cs":
          return this.doCs(msg, args);
        case "sv":
          return this.doSv(msg, args);
        case "ds":
          return this.doDs(msg, args);
        case "ssv":
          return this.doSsv(msg);
        case "cache":
          return this.doCache(msg, args);
        default:
          return msg.edit({ text: html(HELP) });
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      await msg.edit({ text: html`❌ ${htmlEscape(err || "未知错误")}` });
    }
  }

  /* ====== target resolver ====== */

  private async resolveTarget(msg: MessageContext, args: string[]): Promise<{ id: string; name: string } | null> {
    const cl = await getGlobalClient();
    if (!cl) return null;
    let targetId: string | undefined;
    let name = "";

    if (args.length) {
      const raw = args[0];
      try {
        const e = await cl.getChat(raw);
        targetId = String(e.id);
        const plain = htmlEscape(resolveDisplayName(e, targetId));
        name = e.username ? `<a href="https://t.me/${e.username}">${plain}</a>` : plain;
      } catch {
        name = raw;
        targetId = raw.replace(/^@/, "");
      }
    } else if (msg.replyToMessage) {
      const r = await safeGetReplyMessage(msg);
      if (r?.sender?.id) {
        targetId = String(r.sender.id);
        try {
          const u = await cl.getChat(r.sender.id);
          const plain = htmlEscape(resolveDisplayName(u, targetId));
          name = u.username ? `<a href="https://t.me/${u.username}">${plain}</a>` : plain;
        } catch {
          name = targetId;
        }
      }
    }
    return targetId ? { id: targetId, name } : null;
  }

  /* ====== cs (zero-request, reads cache) ====== */

  private async doCs(msg: MessageContext, args: string[]) {
    if (!this.cacheReady) {
      await msg.edit({ text: html`⏳ 缓存正在初始化，请稍后再试。` });
      return;
    }
    const target = await this.resolveTarget(msg, args);
    if (!target) {
      await msg.edit({ text: html`❌ 无法识别目标，请回复消息或提供用户名/ID` });
      return;
    }

    await msg.edit({ text: html`🔍 正在搜索嫌疑人 ${target.name} 的蛛丝马迹...` });

    let found: { msg: CachedMsg; peer: string } | null = null;

    for (const [peer, chat] of this.chatCache) {
      for (const m of chat.msgs) {
        if (String(m.senderId) === target.id) {
          if (!found || m.date > found.msg.date) found = { msg: m, peer };
          break; // newest msg in this group, move on
        }
      }
    }

    await msg.delete().catch(() => {});

    if (!found) {
      await this.sendReply(msg, `🤦‍♀ 暂时没发现 ${target.name} 有作案嫌疑。`);
      return;
    }

    // build link from cache, no API call needed
    const chat = this.chatCache.get(found.peer)!;
    const text = htmlEscape((found.msg.text || "").slice(0, 50) || "[媒体消息]");
    const link = chat.username
      ? `<a href="https://t.me/${chat.username}/${found.msg.id}">${text}</a>`
      : `<a href="https://t.me/c/${found.peer}/${found.msg.id}">${text}</a>`;
    await this.sendReply(
      msg,
      `👀 发现嫌疑人 ${target.name} 的作案现场：\n\n${link}\n\n<i>要想人不知除非己莫为。</i>`,
    );
  }

  /* ====== sv ====== */

  private async doSv(msg: MessageContext, args: string[]) {
    const cl = await getGlobalClient();
    if (!cl) return;
    const target = await this.resolveTarget(msg, args);
    if (!target) {
      await msg.edit({ text: html`❌ 无法识别目标` });
      return;
    }

    await msg.edit({ text: html`👁️ 正在对嫌疑人 ${target.name} 进行蹲守...` });

    this.sv.set(target.id, {
      targetId: target.id,
      targetName: target.name,
      triggerPeer: String(msg.chat.id),
      triggerMsgId: msg.id,
    });
    await this.persistDb();
  }

  /* ====== listen — update cache + check surveillance ====== */

  private async onMsg(msg: MessageContext) {
    // 1) update cache — only public groups, auto-vivify on first sighting
    if (msg.chat?.id) {
      const peer = String(msg.chat.id);
      let chat = this.chatCache.get(peer);
      if (!chat) {
        // first sighting → check if public, cache only public groups
        const cl = await getGlobalClient();
        if (cl) {
          try {
            const entity = await cl.getChat(msg.chat.id);
            const chatEntity0 = entity as Chat;
            if (chatEntity0?.username) {
              chat = { username: chatEntity0.username, title: chatEntity0.title ?? undefined, msgs: [] };
              this.chatCache.set(peer, chat);
            }
          } catch {
            /* getChat failed → skip */
          }
        }
      }
      if (chat) {
        chat.msgs.unshift(stripMsg(msg));
        this.pruneExpired(chat);
        if (chat.msgs.length > CACHE_MSG_LIMIT) chat.msgs.length = CACHE_MSG_LIMIT;
        this.schedulePersistCache();
      }
    }

    // 2) sv surveillance
    if (this.sv.size === 0) return;
    const sid = msg.sender?.id ? String(msg.sender.id) : "";
    if (!sid || !this.sv.has(sid)) return;
    const entry = this.sv.get(sid)!;

    // prevent self-trigger
    if (String(msg.chat.id) === entry.triggerPeer && msg.id === entry.triggerMsgId) return;

    // check group is public (has username, resolved via getChat) before consuming the sv entry
    const cl = await getGlobalClient();
    if (!cl) return;
    let chatEntity: Chat | undefined;
    try {
      chatEntity = (await cl.getChat(msg.chat.id)) as Chat;
    } catch {
      return;
    }
    if (!chatEntity?.username) return; // private group — skip silently, keep sv alive

    this.sv.delete(sid);
    this.persistDb().catch(() => {});

    const preview = htmlEscape((msg.text || "").slice(0, 50) || "[媒体消息]");
    const link = chatEntity.username
      ? `<a href="https://t.me/${chatEntity.username}/${msg.id}">${preview}</a>`
      : `<a href="https://t.me/c/${msg.chat.id}/${msg.id}">${preview}</a>`;
    const result = `🚨 发现嫌疑人 ${entry.targetName} 最新动向\n\n${link}\n\n<i>天网恢恢疏而不漏。</i>`;

    // remove the original trigger command message, then notify
    try {
      await cl.deleteMessagesById(entry.triggerPeer, [entry.triggerMsgId]);
    } catch {
      /* already deleted */
    }

    await cl.sendText(entry.triggerPeer as string | number, html(result)).catch(() => {});
    await cl.sendText("me", html(result)).catch(() => {});
  }

  /* ====== ds (zero-request, reads cache) ====== */

  private async doDs(msg: MessageContext, args: string[]) {
    if (!this.cacheReady) {
      await msg.edit({ text: html`⏳ 缓存正在初始化，请稍后再试。` });
      return;
    }
    const target = await this.resolveTarget(msg, args);
    if (!target) {
      await msg.edit({ text: html`❌ 无法识别目标` });
      return;
    }

    await msg.edit({ text: html`🧭 正在摸排嫌疑人 ${target.name} 的窝点...` });

    let bestPeer: string | null = null;
    let bestCount = 0;
    let bestMsg: CachedMsg | null = null;

    for (const [peer, chat] of this.chatCache) {
      let cnt = 0;
      let latest: CachedMsg | null = null;
      for (const m of chat.msgs) {
        if (String(m.senderId) === target.id) {
          cnt++;
          if (!latest) latest = m; // first hit = newest (msgs newest-first)
        }
      }
      if (cnt > bestCount) {
        bestCount = cnt;
        bestPeer = peer;
        bestMsg = latest;
      }
    }

    await msg.delete().catch(() => {});

    if (!bestPeer || bestCount === 0) {
      await this.sendReply(msg, `🤦‍♀ 摸排结果不尽人意，嫌疑人 ${target.name} 藏的很深。`);
      return;
    }

    // link text = group name, href points to target's latest msg in that group
    let link = `https://t.me/c/${bestPeer}`;
    if (bestMsg) {
      const chat = this.chatCache.get(bestPeer)!;
      const mid = bestMsg.id;
      const href = chat.username
        ? `https://t.me/${chat.username}/${mid}`
        : `https://t.me/c/${bestPeer}/${mid}`;
      link = `<a href="${href}">${htmlEscape(chat.title || chat.username || bestPeer)}</a>`;
    }
    await this.sendReply(
      msg,
      `🏚 发现嫌疑人 ${target.name} 的窝点：\n\n${link}\n\n<i>跑得了和尚跑不了庙。</i>`,
    );
  }

  /* ====== ssv ====== */

  private async doSsv(msg: MessageContext) {
    if (this.sv.size === 0) {
      await msg.edit({ text: html`❌ 当前没有活跃的蹲守任务。` });
      return;
    }

    const cl = await getGlobalClient();

    for (const entry of this.sv.values()) {
      if (cl) {
        try {
          await cl.editMessage({
            chatId: entry.triggerPeer as string | number,
            message: entry.triggerMsgId,
            text: html`🤦‍♀ 蹲守过程中没有发现嫌疑人 ${entry.targetName} 的行踪。`,
          });
        } catch {
          /* trigger may be deleted — fine */
        }
      }
    }

    this.sv.clear();
    await this.persistDb();
    await msg.edit({ text: html`✅ 已终止所有蹲守任务。` });
  }

  /* ====== cache management ====== */

  private async doCache(msg: MessageContext, args: string[]) {
    const sub = args[0]?.toLowerCase();

    if (sub === "limit") {
      const n = parseInt(args[1], 10);
      if (isNaN(n) || n < CACHE_LIMIT_MIN || n > CACHE_LIMIT_MAX) {
        const limit = this.configDb?.data.cacheLimit ?? CACHE_LIMIT_DEF;
        await msg.edit({
          text: html`❌ 缓存上限必须为 ${CACHE_LIMIT_MIN}~${CACHE_LIMIT_MAX} 之间的整数。当前：${limit}`,
        });
        return;
      }
      if (this.configDb) {
        this.configDb.data.cacheLimit = n;
        await this.configDb.write();
      }
      await msg.edit({
        text: html`✅ 缓存上限已设为 ${n} 个群组。使用 <code>${PREFIX}fbi cache rebuild</code> 重新构建。`,
      });
      return;
    }

    if (sub === "rebuild") {
      await msg.edit({ text: html`🔄 正在重建缓存，可能需要几分钟...` });
      this.cacheReady = false;
      this.chatCache.clear();
      await this.buildCache();
      await msg.edit({
        text: html`✅ 缓存重建完成，共缓存 ${this.chatCache.size} 个群组。`,
      });
      return;
    }

    // status
    const limit = this.configDb?.data.cacheLimit ?? CACHE_LIMIT_DEF;
    await msg.edit({
      text: html`📦 <b>FBI 缓存状态</b>

• 已缓存群组：<code>${this.chatCache.size}</code>
• 缓存上限：<code>${limit}</code>
• 每群最大消息：<code>${CACHE_MSG_LIMIT}</code>
• 状态：${this.cacheReady ? "✅ 就绪" : "⏳ 初始化中"}

<b>子命令</b>
• <code>${PREFIX}fbi cache limit [数量]</code> — 设置缓存上限（${CACHE_LIMIT_MIN}~${CACHE_LIMIT_MAX}）
• <code>${PREFIX}fbi cache rebuild</code> — 重建缓存`,
    });
  }

  /* ====== helper ====== */

  private async sendReply(original: MessageContext, text: string) {
    const cl = await getGlobalClient();
    if (!cl) return;
    await cl.sendText(original.chat.id as string | number, html(text)).catch(() => {});
  }

  /** 清理后台定时器，避免 reload 后定时器泄漏（与 cy.ts 等保持一致） */
  cleanup(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.cachePersistTimer) {
      clearTimeout(this.cachePersistTimer);
      this.cachePersistTimer = null;
    }
  }
}


  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "fbi",
    title: "FBI 跨群追踪",
    description: "跨群组消息追踪配置",
    category: "插件配置",
    icon: "🕵️",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "cacheLimit",
            "label": "缓存限制 (条)",
            "type": "number",
            "min": 100,
            "max": 10000,
            "default": 1000
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<FbiConfig>(path.join(createDirectoryInAssets("fbi"), "config.json"), CONFIG_DEF);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<FbiConfig>(path.join(createDirectoryInAssets("fbi"), "config.json"), CONFIG_DEF);
      Object.assign(db.data, patch);
      await db.write();
    },
  };

export default new FbiPlugin();

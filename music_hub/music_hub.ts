import axios from "axios";
import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";
import { Api } from "teleproto";
import { CustomFile } from "teleproto/client/uploads.js";
import { JSONFilePreset } from "lowdb/node";
import * as fs from "fs";
import * as path from "path";

import { htmlEscape } from "@utils/htmlEscape";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const PLUGIN_NAME = "music_hub";
const COMMAND = "mh";
const commandName = `${mainPrefix}${COMMAND}`;
const API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const PAGE_SIZE = 5;
const SEARCH_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const PROGRESS_UPDATE_INTERVAL_MS = 2000;
const PROGRESS_BAR_WIDTH = 12;
const CHECK_TIMEOUT_MS = 10000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const HEALTH_KEYWORD = "test";

const MUSIC_SOURCES = [
  { key: "netease", name: "网易云音乐", stable: true },
  { key: "tencent", name: "QQ 音乐", stable: false },
  { key: "kuwo", name: "酷我音乐", stable: true },
  { key: "tidal", name: "TIDAL", stable: false },
  { key: "qobuz", name: "Qobuz", stable: false },
  { key: "joox", name: "JOOX", stable: true },
  { key: "bilibili", name: "Bilibili", stable: false },
  { key: "apple", name: "Apple Music", stable: false },
  { key: "ytmusic", name: "YouTube Music", stable: false },
  { key: "spotify", name: "Spotify", stable: false },
] as const;

const SOURCE_ALIASES: Record<string, SourceKey | "auto"> = {
  auto: "auto",
  a: "auto",
  wy: "netease",
  wangyi: "netease",
  "163": "netease",
  qq: "tencent",
  tx: "tencent",
  tc: "tencent",
  kw: "kuwo",
  bili: "bilibili",
  youtube: "ytmusic",
  yt: "ytmusic",
  apple_music: "apple",
  am: "apple",
  spot: "spotify",
};

const QUALITY_BR_VALUES = {
  low: "128",
  medium: "320",
  high: "999",
} as const;

type SourceKey = (typeof MUSIC_SOURCES)[number]["key"];
type SourceMode = SourceKey | "auto";
type QualityLabel = keyof typeof QUALITY_BR_VALUES;

const QUALITY_LABEL_BY_BR: Record<string, QualityLabel> = {
  "128": "low",
  "320": "medium",
  "999": "high",
};

interface MusicHubConfig {
  defaultSource: SourceMode;
  br: string;
  maxResults: number;
  maxUploadBytes: number;
}

interface ApiSong {
  id: string;
  name: string;
  artist: string[];
  album?: string;
  pic_id?: string;
  url_id?: string;
  lyric_id?: string;
  source: SourceKey;
  from?: string;
}

interface SongUrlInfo {
  url: string;
  br?: number;
  size?: number;
  from?: string;
}

interface SearchSession {
  query: string;
  requestedSource: SourceMode;
  resolvedSource: SourceKey;
  results: ApiSong[];
  page: number;
  createdAt: number;
  message?: Api.Message;
  messageId?: number;
}

interface SourceCheckResult {
  key: SourceKey;
  ok: boolean;
  elapsedMs: number;
  sample?: string;
  error?: string;
}

interface TransferProgressUpdate {
  stage: "download" | "upload";
  loadedBytes?: number;
  totalBytes?: number;
  fraction?: number;
  detail?: string;
  force?: boolean;
}

type TransferProgressReporter = (
  update: TransferProgressUpdate
) => void | Promise<void>;

interface TransferProgressController {
  report: TransferProgressReporter;
  stop: () => Promise<void>;
}

const CONFIG_PATH = path.join(
  createDirectoryInAssets(PLUGIN_NAME),
  "config.json"
);
const TEMP_DIR = createDirectoryInTemp(PLUGIN_NAME);

const DEFAULT_CONFIG: MusicHubConfig = {
  defaultSource: "auto",
  br: "999",
  maxResults: 30,
  maxUploadBytes: 100 * 1024 * 1024,
};

function codeTag(text: unknown): string {
  return `<code>${htmlEscape(text)}</code>`;
}

function displayBitrate(br?: string | number): string {
  const value = String(br ?? DEFAULT_CONFIG.br).trim();
  return QUALITY_LABEL_BY_BR[value] || value;
}

function parseBitrateSetting(input?: string): string | null {
  const value = String(input ?? "").trim().toLowerCase();
  if (!value) return null;
  const mapped = (QUALITY_BR_VALUES as Record<string, string>)[value];
  if (mapped) return mapped;
  if (QUALITY_LABEL_BY_BR[value]) return value;
  return /^\d+$/.test(value) ? value : null;
}

function sourceLabel(key: SourceMode): string {
  if (key === "auto") return "auto";
  const source = MUSIC_SOURCES.find((item) => item.key === key);
  return source ? `${source.name} (${source.key})` : key;
}

function normalizeSource(input?: string): SourceMode | null {
  if (!input) return null;
  const lowered = input.trim().toLowerCase();
  if (!lowered) return null;
  if (SOURCE_ALIASES[lowered]) return SOURCE_ALIASES[lowered];
  return MUSIC_SOURCES.some((item) => item.key === lowered)
    ? (lowered as SourceKey)
    : null;
}

function getSource(key: SourceKey) {
  return MUSIC_SOURCES.find((item) => item.key === key)!;
}

function getAutoSourceOrder(): SourceKey[] {
  const stable = MUSIC_SOURCES.filter((item) => item.stable).map((item) => item.key);
  const rest = MUSIC_SOURCES.filter((item) => !item.stable).map((item) => item.key);
  return [...stable, ...rest];
}

function getArgs(msg: Api.Message): string[] {
  const text = msg.message || (msg as any).text || "";
  return text.trim().split(/\s+/).slice(1);
}

function idToString(value: any): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value.userId !== undefined) return `user:${idToString(value.userId)}`;
  if (value.chatId !== undefined) return `chat:${idToString(value.chatId)}`;
  if (value.channelId !== undefined) return `channel:${idToString(value.channelId)}`;
  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item
    );
  } catch {
    return String(value);
  }
}

function getSessionKey(msg: Api.Message): string {
  const peerKey = idToString((msg as any).chatId ?? msg.peerId) || "unknown-peer";
  const userKey =
    idToString((msg as any).senderId ?? (msg as any).fromId) || "unknown-user";
  return `${peerKey}:${userKey}`;
}

function parseIndex(text?: string): number | null {
  if (!text || !/^\d+$/.test(text)) return null;
  const index = Number.parseInt(text, 10);
  return index >= 1 ? index : null;
}

function clampPage(page: number, totalPages: number): number {
  return Math.min(Math.max(page, 1), Math.max(totalPages, 1));
}

function formatArtists(artist: string[]): string {
  return artist.filter(Boolean).join(" / ") || "未知歌手";
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "未知大小";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatProgressBytes(bytes?: number): string {
  if (bytes === undefined) return "未知大小";
  if (bytes <= 0) return "0 B";
  return formatBytes(bytes);
}

function clampFraction(value?: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(value, 0), 1);
}

function progressFraction(update: TransferProgressUpdate): number | undefined {
  const explicit = clampFraction(update.fraction);
  if (explicit !== undefined) return explicit;
  if (update.loadedBytes && update.totalBytes && update.totalBytes > 0) {
    return clampFraction(update.loadedBytes / update.totalBytes);
  }
  return undefined;
}

function formatPercent(fraction?: number): string {
  if (fraction === undefined) return "--%";
  return `${Math.floor(fraction * 100)}%`;
}

function renderProgressBar(fraction?: number): string {
  const safeFraction = clampFraction(fraction) ?? 0;
  const filled = Math.round(safeFraction * PROGRESS_BAR_WIDTH);
  return `${"█".repeat(filled)}${"░".repeat(PROGRESS_BAR_WIDTH - filled)}`;
}

function renderTransferProgress(song: ApiSong, update: TransferProgressUpdate): string {
  const fraction = progressFraction(update);
  const stageIcon = update.stage === "download" ? "⬇️" : "📤";
  const stageText = update.stage === "download" ? "本地下载中" : "本地上传中";
  const sizeText =
    update.loadedBytes !== undefined && update.totalBytes !== undefined
      ? `${formatProgressBytes(update.loadedBytes)} / ${formatProgressBytes(update.totalBytes)}`
      : update.loadedBytes !== undefined
        ? formatProgressBytes(update.loadedBytes)
        : "";

  return [
    `${stageIcon} <b>${stageText}</b>`,
    `🎵 ${codeTag(song.name)}`,
    `👤 ${codeTag(formatArtists(song.artist))}`,
    `${codeTag(renderProgressBar(fraction))} ${codeTag(formatPercent(fraction))}`,
    sizeText ? `💾 ${codeTag(sizeText)}` : "",
    update.detail ? `ℹ️ ${htmlEscape(update.detail)}` : "",
  ].filter(Boolean).join("\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMessageNotModifiedError(error: unknown): boolean {
  return /MESSAGE_NOT_MODIFIED|message is not modified/i.test(errorText(error));
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "music").slice(0, 80);
}

function detectAudioExtension(url: string, contentType?: string): string {
  const lowerType = (contentType || "").toLowerCase();
  if (lowerType.includes("flac")) return "flac";
  if (lowerType.includes("ogg")) return "ogg";
  if (lowerType.includes("wav")) return "wav";
  if (lowerType.includes("mp4") || lowerType.includes("m4a")) return "m4a";
  if (lowerType.includes("mpeg") || lowerType.includes("mp3")) return "mp3";

  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/);
    if (match && ["mp3", "flac", "m4a", "aac", "ogg", "wav"].includes(match[1])) {
      return match[1];
    }
  } catch {}

  return "mp3";
}

function normalizeSong(raw: any, fallbackSource: SourceKey): ApiSong | null {
  const name = String(raw?.name ?? raw?.title ?? "").trim();
  const id = String(raw?.id ?? raw?.song_id ?? raw?.url_id ?? "").trim();
  const normalizedSource = normalizeSource(String(raw?.source ?? fallbackSource));
  if (!name || !id || !normalizedSource || normalizedSource === "auto") return null;
  const source = normalizedSource;

  const artistValue = raw?.artist ?? raw?.artists ?? raw?.singer ?? [];
  const artist = Array.isArray(artistValue)
    ? artistValue.map((item) => String(item))
    : String(artistValue || "")
        .split(/[\/,，]/)
        .map((item) => item.trim())
        .filter(Boolean);

  return {
    id,
    name,
    artist,
    album: raw?.album ? String(raw.album) : undefined,
    pic_id: raw?.pic_id ? String(raw.pic_id) : undefined,
    url_id: raw?.url_id ? String(raw.url_id) : id,
    lyric_id: raw?.lyric_id ? String(raw.lyric_id) : id,
    source,
    from: raw?.from ? String(raw.from) : undefined,
  };
}

function normalizeSearchResults(data: any, fallbackSource: SourceKey): ApiSong[] {
  const rawItems: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.result)
        ? data.result
        : Array.isArray(data?.songs)
          ? data.songs
          : [];

  return rawItems
    .map((item: any) => normalizeSong(item, fallbackSource))
    .filter((item: ApiSong | null): item is ApiSong => Boolean(item));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run())
  );
  return results;
}

const helpText = `🎵 <b>Music Hub</b>

🔍 <b>搜索和选择</b>
${codeTag(`${commandName} 关键词`)} - 使用默认源搜索
${codeTag(`${commandName} auto 关键词`)} - 自动选择可用源
${codeTag(`${commandName} netease 关键词`)} - 指定源搜索

⚙️ <b>源和配置</b>
${codeTag(`${commandName} sources`)} - 查看全部音乐源
${codeTag(`${commandName} default auto`)} - 设置默认源，可换成任意源
${codeTag(`${commandName} br medium`)} - 设置码率，常用 low/medium/high
${codeTag(`${commandName} check`)} - 一键测活所有音乐源`;

class MusicHubPlugin extends Plugin {
  description: string = `Music Hub 多音源音乐搜索和下载\n\n${helpText}`;
  private db?: Awaited<ReturnType<typeof JSONFilePreset<MusicHubConfig>>>;
  private sessions = new Map<string, SearchSession>();

  cmdHandlers = {
    mh: this.handleCommand.bind(this),
    music_hub: this.handleCommand.bind(this),
  };

  cleanup(): void {
    this.sessions.clear();
    this.db = undefined;
  }

  private async getConfig(): Promise<MusicHubConfig> {
    if (!this.db) {
      this.db = await JSONFilePreset<MusicHubConfig>(CONFIG_PATH, {
        ...DEFAULT_CONFIG,
      });
      await this.normalizeConfig();
    }
    return this.db.data;
  }

  private async normalizeConfig(): Promise<void> {
    if (!this.db) return;
    const config = this.db.data;
    let changed = false;

    const defaultSource = normalizeSource(config.defaultSource);
    if (!defaultSource) {
      config.defaultSource = DEFAULT_CONFIG.defaultSource;
      changed = true;
    }

    const normalizedBr = parseBitrateSetting(config.br);
    if (!normalizedBr) {
      config.br = DEFAULT_CONFIG.br;
      changed = true;
    } else if (config.br !== normalizedBr) {
      config.br = normalizedBr;
      changed = true;
    }

    if (!Number.isFinite(config.maxResults) || config.maxResults < PAGE_SIZE) {
      config.maxResults = DEFAULT_CONFIG.maxResults;
      changed = true;
    }

    if (!Number.isFinite(config.maxUploadBytes) || config.maxUploadBytes < 1024 * 1024) {
      config.maxUploadBytes = DEFAULT_CONFIG.maxUploadBytes;
      changed = true;
    }

    if (changed) await this.db.write();
  }

  private async updateConfig(updater: (config: MusicHubConfig) => void): Promise<MusicHubConfig> {
    const config = await this.getConfig();
    updater(config);
    await this.db!.write();
    return config;
  }

  private async requestApi<T>(params: Record<string, string | number>, timeout = SEARCH_TIMEOUT_MS): Promise<T> {
    const response = await axios.get<T>(API_BASE_URL, {
      params,
      timeout,
      responseType: "json",
      headers: {
        "User-Agent": "TeleBox-MusicHub/1.0",
      },
      validateStatus: (status: number) => status >= 200 && status < 500,
    });

    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data: any = response.data;
    if (data?.error) throw new Error(String(data.error));
    if (data?.message && data?.code && Number(data.code) >= 400) {
      throw new Error(String(data.message));
    }
    return response.data;
  }

  private async searchSource(source: SourceKey, keyword: string, count: number): Promise<ApiSong[]> {
    const data = await this.requestApi<any>(
      {
        types: "search",
        source,
        name: keyword,
        count,
        pages: 1,
      },
      SEARCH_TIMEOUT_MS
    );
    return normalizeSearchResults(data, source).slice(0, count);
  }

  private async searchMusic(sourceMode: SourceMode, keyword: string): Promise<SearchSession> {
    const config = await this.getConfig();
    const sourceOrder = sourceMode === "auto" ? getAutoSourceOrder() : [sourceMode];
    const errors: string[] = [];

    for (const source of sourceOrder) {
      try {
        const results = await this.searchSource(source, keyword, config.maxResults);
        if (results.length > 0) {
          return {
            query: keyword,
            requestedSource: sourceMode,
            resolvedSource: source,
            results,
            page: 1,
            createdAt: Date.now(),
          };
        }
        errors.push(`${source}: 无结果`);
      } catch (error) {
        errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(errors.slice(0, 5).join("; ") || "没有搜索结果");
  }

  private async getSongUrl(song: ApiSong, br: string): Promise<SongUrlInfo> {
    const data = await this.requestApi<any>(
      {
        types: "url",
        source: song.source,
        id: song.url_id || song.id,
        br,
      },
      SEARCH_TIMEOUT_MS
    );

    const url = String(data?.url ?? data?.data?.url ?? "").trim();
    if (!url) throw new Error("API 未返回播放链接");

    return {
      url,
      br: data?.br ? Number(data.br) : undefined,
      size: data?.size ? Number(data.size) : undefined,
      from: data?.from ? String(data.from) : undefined,
    };
  }

  private renderSearchPage(session: SearchSession): string {
    const totalPages = Math.ceil(session.results.length / PAGE_SIZE);
    const page = clampPage(session.page, totalPages);
    const start = (page - 1) * PAGE_SIZE;
    const visible = session.results.slice(start, start + PAGE_SIZE);
    const sourceText =
      session.requestedSource === "auto"
        ? `auto -> ${sourceLabel(session.resolvedSource)}`
        : sourceLabel(session.resolvedSource);

    const lines = visible.map((song, offset) => {
      const index = start + offset + 1;
      const album = song.album ? ` / ${htmlEscape(song.album)}` : "";
      return `🎧 ${codeTag(`${index}.`)} <b>${htmlEscape(song.name)}</b>\n    👤 ${htmlEscape(formatArtists(song.artist))}${album}`;
    });

    return [
      `🎵 <b>Music Hub 搜索结果</b>\n`,
      `🔍 关键词: ${codeTag(session.query)}`,
      `📡 音源: ${codeTag(sourceText)}`,
      `📄 页码: ${codeTag(`${page}/${totalPages || 1}`)}，共 ${codeTag(session.results.length)} 首`,
      "",
      ...lines,
      "",
      `🎯 选择: ${codeTag(`${commandName} 1`)} 或 ${codeTag(`${commandName} play 1`)}`,
      `↔️ 翻页: ${codeTag(`${commandName} next`)} / ${codeTag(`${commandName} prev`)}`,
    ].join("\n");
  }

  private renderSources(config: MusicHubConfig): string {
    const lines = MUSIC_SOURCES.map((source) => {
      return `${codeTag(source.key)} - ${htmlEscape(source.name)} - ${source.stable ? "稳定" : "备用"}`;
    });

    return [
      "<b>🎵 Music Hub 音乐源</b>\n",
      `✅ 当前默认源: ${htmlEscape(sourceLabel(config.defaultSource))}`,
      "━━━━━━━━━━━━━━━━━",
      `${codeTag("auto")} - 自动模式，优先稳定源再回退其它源`,
      ...lines,
      "",
      `⚙️ 设置默认源: ${codeTag(`${commandName} default netease`)}`,
    ].join("\n");
  }

  private getSession(msg: Api.Message): SearchSession | null {
    const key = getSessionKey(msg);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  private saveSession(msg: Api.Message, session: SearchSession): void {
    this.sessions.set(getSessionKey(msg), session);
  }

  private rememberSessionMessage(session: SearchSession, message?: Api.Message): void {
    if (!message) return;
    session.message = message;
    if (message.id) session.messageId = Number(message.id);
  }

  private isSameMessage(a?: Api.Message, b?: Api.Message): boolean {
    return Boolean(a && b && a.id && b.id && Number(a.id) === Number(b.id));
  }

  private async deleteQuietly(message?: Api.Message): Promise<void> {
    if (!message) return;
    try {
      await message.delete({ revoke: true });
      return;
    } catch {}

    try {
      const client = message.client || (await getGlobalClient());
      const id = Number(message.id);
      const peer = message.peerId ?? (message as any).chatId;
      if (client && peer && Number.isFinite(id)) {
        await client.deleteMessages(peer, [id], { revoke: true });
        return;
      }
    } catch {}

    try {
      await message.delete();
    } catch {}
  }

  private async sendTextMessage(
    sourceMsg: Api.Message,
    text: string,
    parseMode: "html" | undefined = "html"
  ): Promise<Api.Message | undefined> {
    const client = sourceMsg.client || (await getGlobalClient());
    if (!client) return undefined;
    return await client.sendMessage(sourceMsg.peerId, {
      message: text,
      parseMode,
    });
  }

  private async editOrReplaceMessage(
    sourceMsg: Api.Message,
    targetMsg: Api.Message | undefined,
    text: string,
    parseMode: "html" | undefined = "html"
  ): Promise<Api.Message | undefined> {
    if (targetMsg) {
      try {
        const edited = await targetMsg.edit({ text, parseMode, linkPreview: false });
        return edited || targetMsg;
      } catch (error) {
        if (isMessageNotModifiedError(error)) return targetMsg;
        // Do not delete+resend on edit failure — flood the chat. Retry via client.editMessage.
        try {
          const client = sourceMsg.client || (await getGlobalClient());
          if (client) {
            const edited = await client.editMessage(sourceMsg.peerId, {
              message: targetMsg.id,
              text,
              parseMode,
              linkPreview: false,
            });
            return (edited as Api.Message) || targetMsg;
          }
        } catch (e2) {
          if (isMessageNotModifiedError(e2)) return targetMsg;
          console.warn("[music_hub] editMessage fallback failed:", e2);
        }
      }
    }

    return await this.sendTextMessage(sourceMsg, text, parseMode);
  }

  private async editOrReplaceCommandMessage(
    msg: Api.Message,
    text: string,
    parseMode: "html" | undefined = "html"
  ): Promise<Api.Message | undefined> {
    return await this.editOrReplaceMessage(msg, msg, text, parseMode);
  }

  private async editOrReplaceSessionMessage(
    msg: Api.Message,
    session: SearchSession,
    text: string,
    parseMode: "html" | undefined = "html"
  ): Promise<Api.Message | undefined> {
    const updated = await this.editOrReplaceMessage(msg, session.message, text, parseMode);
    this.rememberSessionMessage(session, updated);
    return updated;
  }

  private async deleteCommandIfDifferent(
    commandMsg: Api.Message,
    targetMsg?: Api.Message
  ): Promise<void> {
    if (this.isSameMessage(commandMsg, targetMsg)) return;
    await this.deleteQuietly(commandMsg);
  }

  private async showSessionPage(msg: Api.Message, page: number): Promise<void> {
    const session = this.getSession(msg);
    if (!session) {
      await this.editOrReplaceCommandMessage(
        msg,
        `❌ 没有可翻页的搜索结果，请先使用 ${codeTag(`${commandName} 关键词`)} 搜索。`
      );
      return;
    }

    const totalPages = Math.ceil(session.results.length / PAGE_SIZE);
    session.page = clampPage(page, totalPages);
    await this.editOrReplaceSessionMessage(msg, session, this.renderSearchPage(session));
    await this.deleteCommandIfDifferent(msg, session.message);
  }

  private async selectSong(msg: Api.Message, index: number): Promise<void> {
    const session = this.getSession(msg);
    if (!session) {
      await this.editOrReplaceCommandMessage(
        msg,
        `❌ 没有可选择的搜索结果，请先使用 ${codeTag(`${commandName} 关键词`)} 搜索。`
      );
      return;
    }

    const song = session.results[index - 1];
    if (!song) {
      await this.editOrReplaceSessionMessage(
        msg,
        session,
        `❌ 序号超出范围。当前结果共有 ${codeTag(session.results.length)} 首。`
      );
      await this.deleteCommandIfDifferent(msg, session.message);
      return;
    }

    await this.sendSong(msg, song, session);
  }

  private buildSongCaption(song: ApiSong, urlInfo: SongUrlInfo): string {
    return [
      "🎵 Music Hub",
      `${song.name} - ${formatArtists(song.artist)}`,
      `📡 source: ${song.source}`,
      urlInfo.br ? `🎚️ br: ${displayBitrate(urlInfo.br)}` : "",
    ].filter(Boolean).join("\n");
  }

  private getReplyTarget(msg: Api.Message, session?: SearchSession): number | undefined {
    return (
      session?.messageId ||
      msg.replyTo?.replyToTopId ||
      msg.replyTo?.replyToMsgId ||
      msg.id
    );
  }

  private async finishSongSend(msg: Api.Message, session?: SearchSession): Promise<void> {
    const messageToDelete = session?.message;
    await this.deleteCommandIfDifferent(msg, messageToDelete);
    await this.deleteQuietly(messageToDelete);
    this.sessions.delete(getSessionKey(msg));
  }

  private async sendTelegramUrl(
    client: any,
    msg: Api.Message,
    urlInfo: SongUrlInfo,
    caption: string,
    session?: SearchSession
  ): Promise<void> {
    await client.sendFile(msg.peerId, {
      file: urlInfo.url,
      caption,
      replyTo: this.getReplyTarget(msg, session),
      forceDocument: false,
    });
  }

  private createTransferProgressReporter(
    updateStatus: (text: string, parseMode?: "html" | undefined) => Promise<void>,
    song: ApiSong
  ): TransferProgressController {
    let timer: any;
    let latestText = "";
    let sentText = "";
    let updateQueue = Promise.resolve();

    const enqueue = (text: string): Promise<void> => {
      sentText = text;
      updateQueue = updateQueue
        .catch(() => undefined)
        .then(async () => {
          await updateStatus(text);
        })
        .catch(() => undefined);
      return updateQueue;
    };

    const sendLatest = (force = false): Promise<void> => {
      if (!latestText) return updateQueue.catch(() => undefined);
      if (!force && latestText === sentText) {
        return updateQueue.catch(() => undefined);
      }
      return enqueue(latestText);
    };

    const startTimer = () => {
      if (timer) return;
      timer = setInterval(() => {
        void sendLatest(false);
      }, PROGRESS_UPDATE_INTERVAL_MS);
    };

    return {
      report: (update: TransferProgressUpdate) => {
        latestText = renderTransferProgress(song, update);
        if (update.force) return sendLatest(true);
        startTimer();
      },
      stop: async () => {
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        await sendLatest(true);
        await updateQueue.catch(() => undefined);
      },
    };
  }

  private async sendLocalUpload(
    client: any,
    msg: Api.Message,
    song: ApiSong,
    urlInfo: SongUrlInfo,
    config: MusicHubConfig,
    caption: string,
    session?: SearchSession,
    onProgress?: TransferProgressReporter
  ): Promise<void> {
    let tempFilePath = "";
    try {
      const response = await axios.get<any>(urlInfo.url, {
        responseType: "stream",
        timeout: DOWNLOAD_TIMEOUT_MS,
        maxContentLength: config.maxUploadBytes,
        maxBodyLength: config.maxUploadBytes,
        headers: {
          "User-Agent": "TeleBox-MusicHub/1.0",
        },
      });

      const reader = response.data as any;
      if (!reader || typeof reader.pipe !== "function") {
        throw new Error("下载响应不是可读流");
      }

      const contentLength = Number(response.headers?.["content-length"]);
      const totalBytes =
        Number.isFinite(contentLength) && contentLength > 0
          ? contentLength
          : urlInfo.size;
      if (totalBytes && totalBytes > config.maxUploadBytes) {
        throw new Error(`文件过大 (${formatBytes(totalBytes)})，超过上传限制 ${formatBytes(config.maxUploadBytes)}`);
      }
      const extension = detectAudioExtension(
        urlInfo.url,
        String(response.headers?.["content-type"] || "")
      );
      const filename = `${sanitizeFilename(`${song.name}-${formatArtists(song.artist)}`)}.${extension}`;
      tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${filename}`);
      let downloadedBytes = 0;

      await onProgress?.({
        stage: "download",
        loadedBytes: 0,
        totalBytes,
        force: true,
      });

      await new Promise<void>((resolve, reject) => {
        const writer = fs.createWriteStream(tempFilePath);
        let settled = false;

        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          try {
            if (typeof reader.destroy === "function") reader.destroy();
          } catch {}
          try {
            if (typeof writer.destroy === "function") writer.destroy();
          } catch {}
          reject(error instanceof Error ? error : new Error(String(error)));
        };

        reader.on("data", (chunk: any) => {
          const chunkSize =
            typeof chunk === "string"
              ? Buffer.byteLength(chunk)
              : Number(chunk?.byteLength ?? chunk?.length ?? 0);
          downloadedBytes += chunkSize;

          if (downloadedBytes > config.maxUploadBytes) {
            fail(new Error(`文件超过上传限制 ${formatBytes(config.maxUploadBytes)}`));
            return;
          }

          void onProgress?.({
            stage: "download",
            loadedBytes: downloadedBytes,
            totalBytes,
          });
        });
        reader.on("error", fail);
        writer.on("error", fail);
        writer.on("finish", () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        reader.pipe(writer);
      });

      if (!downloadedBytes) throw new Error("下载到的音频为空");
      const fileSize = fs.statSync(tempFilePath).size;

      await onProgress?.({
        stage: "download",
        loadedBytes: fileSize,
        totalBytes: totalBytes || fileSize,
        fraction: 1,
        force: true,
      });
      await onProgress?.({
        stage: "upload",
        loadedBytes: 0,
        totalBytes: fileSize,
        fraction: 0,
        force: true,
      });

      await client.sendFile(msg.peerId, {
        file: new CustomFile(filename, fileSize, tempFilePath),
        caption,
        replyTo: this.getReplyTarget(msg, session),
        attributes: [
          new Api.DocumentAttributeAudio({
            duration: 0,
            title: song.name,
            performer: formatArtists(song.artist),
          }),
        ],
        forceDocument: false,
        progressCallback: (progress: number) => {
          const fraction = clampFraction(progress) ?? 0;
          void onProgress?.({
            stage: "upload",
            loadedBytes: Math.round(fileSize * fraction),
            totalBytes: fileSize,
            fraction,
          });
        },
      });

      await onProgress?.({
        stage: "upload",
        loadedBytes: fileSize,
        totalBytes: fileSize,
        fraction: 1,
        force: true,
      });
    } finally {
      if (tempFilePath) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch {}
      }
    }
  }

  private async sendSong(
    msg: Api.Message,
    song: ApiSong,
    session?: SearchSession
  ): Promise<void> {
    const config = await this.getConfig();
    const client = msg.client || (await getGlobalClient());
    if (!client) {
      if (session) {
        await this.editOrReplaceSessionMessage(msg, session, "❌ 客户端未初始化，无法发送音乐。", undefined);
        await this.deleteCommandIfDifferent(msg, session.message);
      } else {
        await this.editOrReplaceCommandMessage(msg, "❌ 客户端未初始化，无法发送音乐。", undefined);
      }
      return;
    }

    const updateStatus = async (text: string, parseMode: "html" | undefined = "html") => {
      if (session) {
        await this.editOrReplaceSessionMessage(msg, session, text, parseMode);
        await this.deleteCommandIfDifferent(msg, session.message);
        return;
      }
      await this.editOrReplaceCommandMessage(msg, text, parseMode);
    };

    await updateStatus(
      `🔍 <b>正在获取播放链接</b>\n🎵 ${codeTag(song.name)}\n👤 ${codeTag(formatArtists(song.artist))}`
    );

    let urlInfo: SongUrlInfo;
    try {
      urlInfo = await this.getSongUrl(song, config.br);
    } catch (error) {
      await updateStatus(
        `❌ <b>获取播放链接失败</b>\n<code>${htmlEscape(error instanceof Error ? error.message : String(error))}</code>`
      );
      if (session) await this.deleteCommandIfDifferent(msg, session.message);
      return;
    }

    if (urlInfo.size && urlInfo.size > config.maxUploadBytes) {
      await updateStatus(
        `❌ <b>文件过大</b>\n大小: ${codeTag(formatBytes(urlInfo.size))}\n已提供下载链接:\n` +
          `${codeTag(urlInfo.url)}`
      );
      if (session) await this.deleteCommandIfDifferent(msg, session.message);
      return;
    }

    await updateStatus(
      `🌐 <b>正在请求 Telegram 拉取发送</b>\n` +
        `🎵 ${codeTag(song.name)}\n` +
        `💾 ${codeTag(formatBytes(urlInfo.size))}，🎚️ ${codeTag(displayBitrate(urlInfo.br || config.br))}`
    );

    try {
      const caption = this.buildSongCaption(song, urlInfo);
      await this.sendTelegramUrl(client, msg, urlInfo, caption, session);
      await this.finishSongSend(msg, session);
    } catch (directError) {
      const progress = this.createTransferProgressReporter(updateStatus, song);
      await progress.report({
        stage: "download",
        loadedBytes: 0,
        totalBytes: urlInfo.size,
        detail: `Telegram 拉取失败，回退本地下载后上传。直拉错误: ${errorText(directError)}`,
        force: true,
      });

      try {
        const caption = this.buildSongCaption(song, urlInfo);
        await this.sendLocalUpload(
          client,
          msg,
          song,
          urlInfo,
          config,
          caption,
          session,
          progress.report
        );
        await progress.stop();
        await this.finishSongSend(msg, session);
      } catch (fallbackError) {
        await progress.stop();
        await updateStatus(
          `❌ <b>上传失败，保留下载链接</b>\n${codeTag(urlInfo.url)}\n\n` +
            `🌐 直拉错误: ${htmlEscape(errorText(directError))}\n` +
            `📤 上传错误: ${htmlEscape(errorText(fallbackError))}`
        );
        if (session) await this.deleteCommandIfDifferent(msg, session.message);
      }
    }
  }

  private async checkSource(source: SourceKey): Promise<SourceCheckResult> {
    const started = Date.now();
    try {
      const songs = await this.searchSource(source, HEALTH_KEYWORD, 1);
      const first = songs[0];
      if (!first) {
        return {
          key: source,
          ok: false,
          elapsedMs: Date.now() - started,
          error: "无搜索结果",
        };
      }

      await this.requestApi<any>(
        {
          types: "url",
          source,
          id: first.url_id || first.id,
          br: "128",
        },
        CHECK_TIMEOUT_MS
      );

      return {
        key: source,
        ok: true,
        elapsedMs: Date.now() - started,
        sample: `${first.name} - ${formatArtists(first.artist)}`,
      };
    } catch (error) {
      return {
        key: source,
        ok: false,
        elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private renderCheckResults(results: SourceCheckResult[], done: number): string {
    const lines = results.map((result) => {
      const name = sourceLabel(result.key);
      if (result.ok) {
        return `✅ ${codeTag(result.key)} ${htmlEscape(name)} ${codeTag(`${result.elapsedMs}ms`)}`;
      }
      return `❌ ${codeTag(result.key)} ${htmlEscape(name)} - ${htmlEscape(result.error || "不可用")}`;
    });

    return [
      "🔍 <b>Music Hub 音乐源测活</b>\n",
      `📊 进度: ${codeTag(`${done}/${MUSIC_SOURCES.length}`)}`,
      "",
      ...lines,
    ].join("\n");
  }

  private async checkAllSources(msg: Api.Message): Promise<void> {
    let statusMessage = await this.editOrReplaceCommandMessage(
      msg,
      `🔍 <b>开始测活</b> ${codeTag(MUSIC_SOURCES.length)} 个音乐源...`
    );
    let statusUpdateQueue = Promise.resolve();

    const queueStatusUpdate = (text: string): Promise<void> => {
      statusUpdateQueue = statusUpdateQueue
        .catch(() => undefined)
        .then(async () => {
          const updated = await this.editOrReplaceMessage(msg, statusMessage, text);
          if (updated) statusMessage = updated;
        })
        .catch(() => undefined);
      return statusUpdateQueue;
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "music_hub",
    title: "Music Hub 音乐",
    description: "音乐搜索下载配置：默认音源、音质、结果数量、上传大小限制",
    category: "插件配置",
    icon: "🎵",
    getSchema: (): PanelSettingField[] => [
      {
        key: "defaultSource",
        label: "默认音源",
        type: "select",
        options: [
          { value: "auto", label: "自动 (auto)" },
          { value: "netease", label: "网易云音乐" },
          { value: "tencent", label: "QQ 音乐" },
          { value: "kuwo", label: "酷我音乐" },
          { value: "tidal", label: "TIDAL" },
          { value: "qobuz", label: "Qobuz" },
          { value: "joox", label: "JOOX" },
          { value: "bilibili", label: "Bilibili" },
          { value: "apple", label: "Apple Music" },
          { value: "ytmusic", label: "YouTube Music" },
          { value: "spotify", label: "Spotify" },
        ],
        default: "auto",
      },
      {
        key: "br",
        label: "默认音质",
        type: "select",
        options: [
          { value: "128", label: "128kbps (低)" },
          { value: "320", label: "320kbps (标准)" },
          { value: "999", label: "无损/最高 (999)" },
        ],
        default: "999",
      },
      {
        key: "maxResults",
        label: "最大搜索结果数",
        type: "number",
        min: 5,
        max: 100,
        default: 30,
        description: "单次搜索返回的最大结果数",
      },
      {
        key: "maxUploadBytes",
        label: "最大上传大小 (字节)",
        type: "number",
        min: 1024 * 1024,
        max: 2 * 1024 * 1024 * 1024,
        default: 100 * 1024 * 1024,
        description: "Telegram 文件上传限制，默认 100MB",
      },
    ],
    getValues: async () => {
      const db = await JSONFilePreset<MusicHubConfig>(CONFIG_PATH, DEFAULT_CONFIG);
      return {
        defaultSource: db.data.defaultSource || "auto",
        br: db.data.br || "999",
        maxResults: db.data.maxResults ?? 30,
        maxUploadBytes: db.data.maxUploadBytes ?? 100 * 1024 * 1024,
      };
    },
    setValues: async (patch: Record<string, unknown>) => {
      const db = await JSONFilePreset<MusicHubConfig>(CONFIG_PATH, DEFAULT_CONFIG);
      const fields: (keyof MusicHubConfig)[] = ["defaultSource", "br", "maxResults", "maxUploadBytes"];
      for (const f of fields) {
        if (patch[f] !== undefined) (db.data as any)[f] = patch[f];
      }
      await db.write();
    },
  };
    };

    const partial: SourceCheckResult[] = [];
    let done = 0;

    const results = await mapWithConcurrency(
      MUSIC_SOURCES.map((source) => source.key),
      3,
      async (source) => {
        const result = await this.checkSource(source);
        partial.push(result);
        done += 1;
        await queueStatusUpdate(this.renderCheckResults(partial, done));
        return result;
      }
    );

    await statusUpdateQueue;
    await queueStatusUpdate(
      this.renderCheckResults(
        results.sort((a, b) => MUSIC_SOURCES.findIndex((s) => s.key === a.key) - MUSIC_SOURCES.findIndex((s) => s.key === b.key)),
        MUSIC_SOURCES.length
      )
    );
    await statusUpdateQueue;
  }

  private async handleDefault(msg: Api.Message, args: string[]): Promise<void> {
    const config = await this.getConfig();
    const next = normalizeSource(args[0]);
    if (!next) {
      await this.editOrReplaceCommandMessage(
        msg,
        `⚙️ 当前默认源: ${codeTag(sourceLabel(config.defaultSource))}\n\n` +
          `💡 用法: ${codeTag(`${commandName} default auto`)} 或 ${codeTag(`${commandName} default netease`)}`
      );
      return;
    }

    await this.updateConfig((current) => {
      current.defaultSource = next;
    });

    await this.editOrReplaceCommandMessage(
      msg,
      `✅ 默认源已设置为 ${codeTag(sourceLabel(next))}`
    );
  }

  private async handleBitrate(msg: Api.Message, args: string[]): Promise<void> {
    const config = await this.getConfig();
    const br = args[0];
    if (!br) {
      await this.editOrReplaceCommandMessage(
        msg,
        `🎚️ 当前码率: ${codeTag(displayBitrate(config.br))}\n💡 用法: ${codeTag(`${commandName} br high`)}`
      );
      return;
    }

    const nextBr = parseBitrateSetting(br);
    if (!nextBr) {
      await this.editOrReplaceCommandMessage(
        msg,
        `❌ 码率必须是 ${codeTag("low")}、${codeTag("medium")} 或 ${codeTag("high")}`
      );
      return;
    }

    await this.updateConfig((current) => {
      current.br = nextBr;
    });
    await this.editOrReplaceCommandMessage(msg, `✅ 码率已设置为 ${codeTag(displayBitrate(nextBr))}`);
  }

  private async handleSearch(msg: Api.Message, sourceMode: SourceMode, keyword: string): Promise<void> {
    if (!keyword.trim()) {
      await this.editOrReplaceCommandMessage(msg, helpText);
      return;
    }

    const statusMessage = await this.editOrReplaceCommandMessage(
      msg,
      `🔍 <b>正在搜索</b> ${codeTag(keyword)}\n📡 音源: ${codeTag(sourceLabel(sourceMode))}`
    );

    try {
      const session = await this.searchMusic(sourceMode, keyword.trim());
      this.rememberSessionMessage(session, statusMessage);
      this.saveSession(msg, session);
      await this.editOrReplaceSessionMessage(msg, session, this.renderSearchPage(session));
    } catch (error) {
      await this.editOrReplaceMessage(
        msg,
        statusMessage,
        `❌ <b>搜索失败</b>\n<code>${htmlEscape(error instanceof Error ? error.message : String(error))}</code>\n\n` +
          `💡 可尝试 ${codeTag(`${commandName} check`)} 查看源状态。`
      );
    }
  }

  private async handleCommand(msg: Api.Message): Promise<void> {
    const args = getArgs(msg);
    const action = (args[0] || "").toLowerCase();
    const config = await this.getConfig();

    if (!action || action === "help" || action === "h") {
      await this.editOrReplaceCommandMessage(msg, helpText);
      return;
    }

    if (action === "sources" || action === "source" || action === "list") {
      if (action === "source" && args[1]) {
        await this.handleDefault(msg, args.slice(1));
        return;
      }
      await this.editOrReplaceCommandMessage(msg, this.renderSources(config));
      return;
    }

    if (action === "default" || action === "set") {
      await this.handleDefault(msg, args.slice(1));
      return;
    }

    if (action === "br" || action === "quality") {
      await this.handleBitrate(msg, args.slice(1));
      return;
    }

    if (action === "check" || action === "health") {
      await this.checkAllSources(msg);
      return;
    }

    if (action === "next" || action === "n") {
      const session = this.getSession(msg);
      await this.showSessionPage(msg, (session?.page || 1) + 1);
      return;
    }

    if (action === "prev" || action === "p") {
      const session = this.getSession(msg);
      await this.showSessionPage(msg, (session?.page || 1) - 1);
      return;
    }

    if (action === "page") {
      const page = parseIndex(args[1]) || 1;
      await this.showSessionPage(msg, page);
      return;
    }

    if (action === "clear") {
      const session = this.getSession(msg);
      await this.deleteQuietly(session?.message);
      this.sessions.delete(getSessionKey(msg));
      await this.editOrReplaceCommandMessage(msg, "✅ 已清除当前 Music Hub 搜索会话。", undefined);
      return;
    }

    if (action === "play" || action === "download" || action === "get") {
      const index = parseIndex(args[1]);
      if (!index) {
        await this.editOrReplaceCommandMessage(
          msg,
          `🎯 请提供歌曲序号，例如 ${codeTag(`${commandName} play 1`)}`
        );
        return;
      }
      await this.selectSong(msg, index);
      return;
    }

    const directIndex = parseIndex(action);
    if (directIndex) {
      await this.selectSong(msg, directIndex);
      return;
    }

    if (action === "search" || action === "s") {
      const explicitSource = normalizeSource(args[1]);
      const sourceMode = explicitSource || config.defaultSource;
      const keyword = explicitSource ? args.slice(2).join(" ") : args.slice(1).join(" ");
      await this.handleSearch(msg, sourceMode, keyword);
      return;
    }

    const explicitSource = normalizeSource(action);
    if (explicitSource) {
      await this.handleSearch(msg, explicitSource, args.slice(1).join(" "));
      return;
    }

    await this.handleSearch(msg, config.defaultSource, args.join(" "));
  }
}

export default new MusicHubPlugin();

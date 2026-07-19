import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import * as fs from "fs/promises";
import path from "path";
import axios from "axios";
import { createDirectoryInAssets } from "@utils/pathHelpers";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// ── Data store ──────────────────────────────────────────────────────────
const DATA_DIR = createDirectoryInAssets("checkapi");
const KEYS_FILE = path.join(DATA_DIR, "keys.json");

interface SavedKey {
  name: string;
  key: string;
  baseUrl?: string;
  provider?: string;
  addedAt: number;
}

async function loadKeys(): Promise<SavedKey[]> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(KEYS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveKeys(keys: SavedKey[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(KEYS_FILE, JSON.stringify(keys, null, 2), "utf8");
}

function getErrorMessage(error: unknown): string {
  if (!error) return "未知错误";
  const errObj = error as Record<string, unknown>;
  return (errObj.message as string) || (errObj.stderr as string) || String(error);
}

// ── Provider detection ──────────────────────────────────────────────────

interface ProviderInfo {
  provider: string;
  displayName: string;
  baseUrl: string;
  balanceUrl?: string;
  modelsUrl?: string;
  confidence: "high" | "medium" | "low";
  headers: Record<string, string>;
}

function detectProvider(key: string, baseUrl?: string): ProviderInfo {
  const trimmedKey = key.trim();

  if (baseUrl) {
    const normalized = baseUrl.replace(/\/+$/, "");
    const defaultHeaders: Record<string, string> = {};
    if (normalized.includes("openrouter"))
      defaultHeaders["HTTP-Referer"] = "https://t.me/telebox_next";
    return {
      provider: "custom",
      displayName: `\u81ea\u5b9a\u4e49 (${normalized})`,
      baseUrl: normalized,
      balanceUrl: normalized.includes("openrouter")
        ? `${normalized}/api/v1/auth/key`
        : undefined,
      modelsUrl: `${normalized}/v1/models`,
      confidence: "medium",
      headers: defaultHeaders,
    };
  }

  if (/^sk-ant-/i.test(trimmedKey)) {
    return {
      provider: "anthropic",
      displayName: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      modelsUrl: "https://api.anthropic.com/v1/models",
      confidence: "high",
      headers: { "x-api-key": trimmedKey, "anthropic-version": "2023-06-01" },
    };
  }

  if (/^sk-or-v1-/i.test(trimmedKey)) {
    return {
      provider: "openrouter",
      displayName: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      balanceUrl: "https://openrouter.ai/api/v1/auth/key",
      modelsUrl: "https://openrouter.ai/api/v1/models",
      confidence: "high",
      headers: {
        Authorization: `Bearer ${trimmedKey}`,
        "HTTP-Referer": "https://t.me/telebox_next",
      },
    };
  }

  if (/^sk-/i.test(trimmedKey)) {
    if (trimmedKey.length < 40) {
      return {
        provider: "deepseek",
        displayName: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        balanceUrl: "https://api.deepseek.com/user/balance",
        modelsUrl: "https://api.deepseek.com/v1/models",
        confidence: "medium",
        headers: { Authorization: `Bearer ${trimmedKey}` },
      };
    }
    return {
      provider: "openai",
      displayName: "OpenAI",
      baseUrl: "https://api.openai.com",
      balanceUrl: "https://api.openai.com/v1/dashboard/billing/subscription",
      modelsUrl: "https://api.openai.com/v1/models",
      confidence: "high",
      headers: { Authorization: `Bearer ${trimmedKey}` },
    };
  }

  if (/^xai-/i.test(trimmedKey)) {
    return {
      provider: "xai",
      displayName: "xAI (Grok)",
      baseUrl: "https://api.x.ai",
      modelsUrl: "https://api.x.ai/v1/models",
      confidence: "high",
      headers: { Authorization: `Bearer ${trimmedKey}` },
    };
  }

  if (/^AIza/i.test(trimmedKey)) {
    return {
      provider: "gemini",
      displayName: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      modelsUrl: `https://generativelanguage.googleapis.com/v1beta/models?key=${trimmedKey}`,
      confidence: "high",
      headers: {},
    };
  }

  if (trimmedKey.length > 20) {
    return {
      provider: "openai",
      displayName: "OpenAI\uff08\u63a8\u6d4b\uff09",
      baseUrl: "https://api.openai.com",
      balanceUrl: "https://api.openai.com/v1/dashboard/billing/subscription",
      modelsUrl: "https://api.openai.com/v1/models",
      confidence: "low",
      headers: { Authorization: `Bearer ${trimmedKey}` },
    };
  }

  return { provider: "unknown", displayName: "\u672a\u77e5", baseUrl: "", confidence: "low", headers: {} };
}

// ── API call helpers ────────────────────────────────────────────────────

async function apiGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15000,
): Promise<{ ok: boolean; data?: unknown; status?: number; error?: string }> {
  try {
    const resp = await axios.get(url, {
      headers,
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    if (resp.status >= 200 && resp.status < 300) {
      return { ok: true, data: resp.data, status: resp.status };
    }
    const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    return {
      ok: false,
      status: resp.status,
      error: `HTTP ${resp.status}: ${body.slice(0, 200)}`,
    };
  } catch (e: unknown) {
    return { ok: false, error: getErrorMessage(e) };
  }
}

async function apiGetJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs?: number,
): Promise<{ ok: boolean; data?: Record<string, unknown>; status?: number; error?: string }> {
  const result = await apiGet(url, headers, timeoutMs);
  if (!result.ok) return result as unknown as { ok: boolean; data?: Record<string, unknown>; status?: number; error?: string };
  if (result.data && typeof result.data === "object") {
    return { ok: true, data: result.data as Record<string, unknown>, status: result.status };
  }
  return { ok: false, error: `非 JSON 响应: ${String(result.data).slice(0, 100)}` };
}

// ── Balance checks ──────────────────────────────────────────────────────

async function checkOpenAIBalance(key: string, baseUrl: string): Promise<string> {
  const lines: string[] = [];
  const headers = { Authorization: `Bearer ${key}` };

  const subResult = await apiGetJson(`${baseUrl}/v1/dashboard/billing/subscription`, headers);
  if (subResult.ok && subResult.data) {
    const planData = subResult.data.plan as Record<string, unknown> | undefined;
    const plan = planData?.title || "未知";
    const accessUntil = subResult.data.access_until
      ? new Date((subResult.data.access_until as number) * 1000).toLocaleDateString("zh-CN")
      : "\u672a\u77e5";
    const hardLimit = subResult.data.hard_limit_usd ?? "?";
    const softLimit = subResult.data.soft_limit_usd ?? "?";
    lines.push(`\u{1F4CB} \u5957\u9910: ${plan}`);
    lines.push(`\u{1F4C5} \u6709\u6548\u671f\u81f3: ${accessUntil}`);
    lines.push(`\u{1F4B0} \u786c\u4e0a\u9650: $${hardLimit} | \u8f6f\u4e0a\u9650: $${softLimit}`);
    lines.push(`\u{1F9EA} \u7cfb\u7edf\u8f6f\u4e0a\u9650: $${subResult.data.system_hard_limit_usd ?? "?"}`);
  } else if (subResult.status === 401 || subResult.status === 403) {
    lines.push("\u274c API Key \u65e0\u6548\u6216\u5df2\u8fc7\u671f");
    return lines.join("\n");
  } else {
    lines.push("\u26a0\ufe0f \u65e0\u6cd5\u83b7\u53d6\u8ba2\u9605\u4fe1\u606f\uff08\u53ef\u80fd\u9700\u8981 API Key \u6709 billing \u6743\u9650\uff09");
  }

  const now = Math.floor(Date.now() / 1000);
  const ninetyDaysAgo = now - 90 * 86400;
  const usageResult = await apiGetJson(
    `${baseUrl}/v1/dashboard/billing/usage?start_date=${ninetyDaysAgo}&end_date=${now}`,
    headers,
  );
  if (usageResult.ok && usageResult.data) {
    const totalUsage = (usageResult.data as Record<string, unknown>).total_usage as number || 0;
    lines.push(`\u{1F4CA} \u8fd1 90 \u5929\u7528\u91cf: $${(totalUsage / 100).toFixed(4)}`);
  }

  return lines.join("\n") || "\u2705 API Key \u6709\u6548\uff08\u65e0\u6cd5\u83b7\u53d6\u66f4\u591a\u8d26\u5355\u4fe1\u606f\uff09";
}

async function checkDeepSeekBalance(key: string, baseUrl: string): Promise<string> {
  const headers = { Authorization: `Bearer ${key}` };
  const result = await apiGetJson(`${baseUrl}/user/balance`, headers);

  if (result.ok && result.data) {
    const info = result.data;
    const balanceInfos = info.balance_infos as Array<Record<string, unknown>> | undefined;
    const isAvailable = info.is_available;
    const lines: string[] = [];
    lines.push(`\u2705 \u53ef\u7528: ${isAvailable ? "\u662f" : "\u5426"}`);
    if (balanceInfos) {
      for (const bi of balanceInfos) {
        lines.push(`\u{1F4B0} ${bi.currency || "\u4f59\u989d"}: ${bi.total_balance || "?"} (\u5df2\u7528: ${bi.topped_up_balance || "?"})`);
      }
    }
    return lines.join("\n");
  }
  if (result.status === 401) return "\u274c API Key \u65e0\u6548";
  return `\u26a0\ufe0f \u65e0\u6cd5\u67e5\u8be2: ${result.error || "\u672a\u77e5\u9519\u8bef"}`;
}

async function checkOpenRouterBalance(key: string, baseUrl: string): Promise<string> {
  const headers = { Authorization: `Bearer ${key}` };
  const result = await apiGetJson(`${baseUrl}/auth/key`, headers);

  if (result.ok && result.data) {
    const data = result.data as Record<string, unknown>;
    const info = data.data as Record<string, unknown> | undefined || data;
    const lines: string[] = [];
    lines.push(`\u{1F3F7}\ufe0f  \u540d\u79f0: ${info.label || info.name || "\u672a\u547d\u540d"}`);
    lines.push(`\u{1F4B0} \u4f59\u989d: $${info.credits ?? "?"}`);
    lines.push(`\u{1F4CA} \u5df2\u7528: $${info.usage ?? "?"}`);
    if (info.limit !== undefined) lines.push(`\u{1F4CF} \u9650\u989d: $${info.limit}`);
    if (info.rate_limit) {
      const rl = info.rate_limit as Record<string, unknown>;
      lines.push(`\u26a1 \u901f\u7387: ${rl.requests || "?"} req / ${rl.interval || "?"}`);
    }
    return lines.join("\n");
  }
  if (result.status === 401) return "\u274c API Key \u65e0\u6548";
  return `\u26a0\ufe0f \u65e0\u6cd5\u67e5\u8be2: ${result.error || "\u672a\u77e5\u9519\u8bef"}`;
}

async function checkAnthropicUsage(key: string): Promise<string> {
  const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  const result = await apiGetJson("https://api.anthropic.com/v1/messages", headers, 10000);

  if (result.status === 401 || result.status === 403) return "\u274c API Key \u65e0\u6548";
  if (result.status === 400 || result.status === 429 || result.status === 200) {
    return "\u2705 API Key \u6709\u6548\n\u26a0\ufe0f Anthropic \u65e0\u516c\u5f00\u4f59\u989d\u67e5\u8be2\u63a5\u53e3\uff0c\u8bf7\u524d\u5f80 console.anthropic.com \u67e5\u770b\u7528\u91cf";
  }
  return `\u26a0\ufe0f \u72b6\u6001: HTTP ${result.status}\n${result.error || ""}`;
}

async function checkGeminiKey(key: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
  const result = await apiGetJson(url, {}, 10000);

  if (result.ok && result.data) {
    const models = result.data.models as Array<Record<string, unknown>> | undefined;
    const count = models?.length ?? 0;
    return `\u2705 API Key \u6709\u6548\n\u{1F4CB} \u53ef\u7528\u6a21\u578b: ${count} \u4e2a`;
  }
  if (result.status === 400 && String(result.data || "").includes("API_KEY_INVALID")) {
    return "\u274c API Key \u65e0\u6548";
  }
  return `\u26a0\ufe0f \u72b6\u6001: HTTP ${result.status}\n${result.error || "API Key \u53ef\u80fd\u6709\u6548\uff08\u65e0\u6cd5\u786e\u8ba4\uff09"}`;
}

async function checkXAIKey(key: string, baseUrl: string): Promise<string> {
  const headers = { Authorization: `Bearer ${key}` };
  const result = await apiGetJson(`${baseUrl}/v1/models`, headers, 10000);

  if (result.ok && result.data) {
    const arr = Array.isArray(result.data) ? result.data : (result.data.data as Array<unknown> | undefined);
    const count = arr?.length ?? 0;
    return `\u2705 API Key \u6709\u6548\n\u{1F4CB} \u53ef\u7528\u6a21\u578b: ${count} \u4e2a`;
  }
  if (result.status === 401) return "\u274c API Key \u65e0\u6548";
  return `\u26a0\ufe0f \u72b6\u6001: HTTP ${result.status}`;
}

// ── Model listing ────────────────────────────────────────────────────────

async function listModels(
  provider: string,
  key: string,
  baseUrl: string,
): Promise<string> {
  if (provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
    const result = await apiGetJson(url, {}, 10000);
    if (result.ok && result.data) {
      const models = result.data.models as Array<Record<string, unknown>> | undefined || [];
      const lines: string[] = [`\u{1F916} Gemini \u6a21\u578b (${models.length}):`];
      for (const m of models.slice(0, 30)) {
        const name = String(m.name || "").replace("models/", "");
        const desc = String(m.description || "").slice(0, 80);
        const methods = String(m.supportedGenerationMethods || "");
        const tags = methods.includes("generateContent") ? "\u2705" : "\u26a1";
        lines.push(`  ${tags} <code>${name}</code> \u2014 ${desc}`);
      }
      if (models.length > 30) lines.push(`  ... \u5171 ${models.length} \u4e2a`);
      return lines.join("\n");
    }
    return `\u274c \u83b7\u53d6\u5931\u8d25: ${result.error}`;
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (provider === "openrouter") headers["HTTP-Referer"] = "https://t.me/telebox_next";
  else if (provider === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    delete headers["Authorization"];
  }

  const url = provider === "anthropic"
    ? "https://api.anthropic.com/v1/models"
    : `${baseUrl}/v1/models`;

  const result = await apiGetJson(url, headers, 10000);
  if (result.ok && result.data) {
    const arr = Array.isArray(result.data)
      ? result.data
      : (result.data.data as Array<Record<string, unknown>> | undefined) || [];
    const lines: string[] = [`\u{1F916} ${provider} \u6a21\u578b (${arr.length}):`];
    const sorted = [...arr].sort((a, b) => {
      const ca = Number(a.created || 0);
      const cb = Number(b.created || 0);
      if (cb !== ca) return cb - ca;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
    for (const m of sorted.slice(0, 40)) {
      const id = String(m.id || m.name || "");
      const owner = m.owned_by ? ` [${m.owned_by}]` : "";
      lines.push(`  \u2022 <code>${id}</code>${owner}`);
    }
    if (sorted.length > 40) lines.push(`  ... \u5171 ${sorted.length} \u4e2a`);
    return lines.join("\n");
  }
  return `\u274c \u83b7\u53d6\u5931\u8d25: ${result.error}`;
}

// ── Connection test ─────────────────────────────────────────────────────

async function testConnection(
  provider: string,
  key: string,
  baseUrl: string,
): Promise<string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (provider === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    delete headers["Authorization"];
  }

  const start = Date.now();
  const url = provider === "gemini"
    ? `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
    : `${baseUrl}/v1/models`;

  const result = await apiGetJson(url, headers, 8000);
  const elapsed = Date.now() - start;

  if (result.ok) {
    return `\u2705 \u8fde\u63a5\u6210\u529f (${elapsed}ms)\n\u{1F4E1} ${provider} API \u53ef\u8fbe`;
  }
  if (result.status === 401 || result.status === 403) {
    return `\u{1F511} API Key \u8ba4\u8bc1\u5931\u8d25 (${elapsed}ms)\nHTTP ${result.status}: ${result.error || "\u65e0\u6548\u6216\u6743\u9650\u4e0d\u8db3"}`;
  }
  return `\u26a0\ufe0f \u8fde\u63a5\u5f02\u5e38 (${elapsed}ms)\nHTTP ${result.status}: ${result.error || "\u672a\u77e5\u9519\u8bef"}`;
}

// ── Full check ───────────────────────────────────────────────────────────

async function fullCheck(info: ProviderInfo, key: string): Promise<string> {
  const sections: string[] = [];
  sections.push(`\u{1F50D} \u8bc6\u522b: ${info.displayName} (${info.provider}, \u7f6e\u4fe1\u5ea6: ${info.confidence})`);

  sections.push(`\n\u{1F4E1} \u8fde\u63a5\u6d4b\u8bd5:`);
  sections.push(await testConnection(info.provider, key, info.baseUrl));

  sections.push(`\n\u{1F4B0} \u4f59\u989d/\u7528\u91cf:`);
  try {
    if (info.provider === "openai" || info.provider === "custom") {
      sections.push(await checkOpenAIBalance(key, info.baseUrl));
    } else if (info.provider === "deepseek") {
      sections.push(await checkDeepSeekBalance(key, info.baseUrl));
    } else if (info.provider === "openrouter") {
      sections.push(await checkOpenRouterBalance(key, info.baseUrl));
    } else if (info.provider === "anthropic") {
      sections.push(await checkAnthropicUsage(key));
    } else if (info.provider === "gemini") {
      sections.push(await checkGeminiKey(key));
    } else if (info.provider === "xai") {
      sections.push(await checkXAIKey(key, info.baseUrl));
    } else {
      sections.push("\u2753 \u672a\u77e5 provider\uff0c\u5c1d\u8bd5 OpenAI \u517c\u5bb9\u68c0\u67e5...");
      sections.push(await testConnection("openai", key, "https://api.openai.com"));
    }
  } catch (e: unknown) {
    sections.push(`\u26a0\ufe0f \u4f59\u989d\u67e5\u8be2\u5f02\u5e38: ${getErrorMessage(e)}`);
  }

  sections.push(`\n\u{1F4CB} \u6a21\u578b\u5217\u8868\uff08\u524d 10 \u4e2a\uff09:`);
  try {
    const modelsStr = await listModels(info.provider, key, info.baseUrl);
    const lines = modelsStr.split("\n");
    const header = lines[0] || "";
    const firstTen = lines.slice(1, 11);
    if (lines.length > 12) firstTen.push(`  ... \u5171 ${lines.length - 1} \u4e2a\uff0c\u4f7f\u7528 <code>${mainPrefix}checkapi models</code> \u67e5\u770b\u5168\u90e8`);
    sections.push(header);
    sections.push(...firstTen);
  } catch (e: unknown) {
    sections.push(`\u26a0\ufe0f \u6a21\u578b\u5217\u8868\u5f02\u5e38: ${getErrorMessage(e)}`);
  }

  return sections.join("\n");
}

// ── Plugin ───────────────────────────────────────────────────────────────

class CheckApiPlugin extends Plugin {
  name = "checkapi";
  description =
    `\u{1F50D} API Key \u68c0\u6d4b\u5de5\u5177\n\n` +
    `\u652f\u6301 OpenAI / Anthropic / Gemini / DeepSeek / OpenRouter / xAI / \u81ea\u5b9a\u4e49\n\n` +
    `\u7528\u6cd5:\n` +
    `<blockquote expandable>` +
    `<code>${mainPrefix}checkapi &lt;key&gt;</code> \u2014 \u81ea\u52a8\u8bc6\u522b\u5e76\u5168\u7ebf\u68c0\u6d4b\n` +
    `<code>${mainPrefix}checkapi balance &lt;key|name&gt;</code> \u2014 \u4ec5\u67e5\u4f59\u989d\n` +
    `<code>${mainPrefix}checkapi models &lt;key|name&gt;</code> \u2014 \u5217\u6a21\u578b\n` +
    `<code>${mainPrefix}checkapi test &lt;key|name&gt;</code> \u2014 \u8fde\u901a\u6027\u6d4b\u8bd5\n` +
    `<code>${mainPrefix}checkapi save &lt;name&gt; &lt;key&gt; [baseUrl]</code> \u2014 \u4fdd\u5b58 Key\n` +
    `<code>${mainPrefix}checkapi list</code> \u2014 \u5217\u51fa\u5df2\u4fdd\u5b58\n` +
    `<code>${mainPrefix}checkapi del &lt;name&gt;</code> \u2014 \u5220\u9664\n` +
    `<code>${mainPrefix}checkapi check &lt;name|all&gt;</code> \u2014 \u68c0\u6d4b\u5df2\u4fdd\u5b58\n` +
    `</blockquote>\n\n` +
    `\u667a\u80fd\u8bc6\u522b\uff1a\u6839\u636e Key \u524d\u7f00\u81ea\u52a8\u5224\u65ad provider\n` +
    `- <code>sk-ant-...</code> \u2192 Anthropic\n` +
    `- <code>sk-or-v1-...</code> \u2192 OpenRouter\n` +
    `- <code>sk-...</code> \u2192 OpenAI\n` +
    `- <code>AIza...</code> \u2192 Google Gemini\n` +
    `- <code>xai-...</code> \u2192 xAI (Grok)`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    checkapi: async (msg) => {
      const text = msg.message.slice(mainPrefix.length).trim();
      const parts = text.split(/\s+/).filter(Boolean);

      // No args → help
      if (parts.length === 0 || parts[0] === "help") {
        await msg.edit({ text: this.description, parseMode: "html" });
        return;
      }

      const sub = parts[0]?.toLowerCase();

      // list
      if (sub === "list") {
        const keys = await loadKeys();
        if (keys.length === 0) {
          await msg.edit({
            text: `\u{1F4ED} \u672a\u4fdd\u5b58\u4efb\u4f55 API Key\n\n\u4f7f\u7528 <code>${mainPrefix}checkapi save &lt;name&gt; &lt;key&gt;</code> \u4fdd\u5b58`,
            parseMode: "html",
          });
          return;
        }
        const lines = [`\u{1F511} \u5df2\u4fdd\u5b58\u7684 API Key (${keys.length}):`];
        for (const k of keys) {
          const masked = k.key.slice(0, 7) + "..." + k.key.slice(-4);
          const provider = k.provider || "auto";
          const base = k.baseUrl ? ` [${k.baseUrl}]` : "";
          lines.push(`  \u2022 <b>${k.name}</b>: ${masked} (${provider})${base}`);
        }
        await msg.edit({ text: lines.join("\n"), parseMode: "html" });
        return;
      }

      // del
      if (sub === "del" || sub === "delete") {
        const name = parts[1];
        if (!name) {
          await msg.edit({ text: `\u274c \u7528\u6cd5: <code>${mainPrefix}checkapi del &lt;name&gt;</code>`, parseMode: "html" });
          return;
        }
        const keys = await loadKeys();
        const idx = keys.findIndex((k) => k.name === name);
        if (idx === -1) {
          await msg.edit({ text: `\u274c \u672a\u627e\u5230\u540d\u4e3a <b>${name}</b> \u7684 Key`, parseMode: "html" });
          return;
        }
        keys.splice(idx, 1);
        await saveKeys(keys);
        await msg.edit({ text: `\u2705 \u5df2\u5220\u9664 <b>${name}</b>`, parseMode: "html" });
        return;
      }

      // save
      if (sub === "save") {
        const name = parts[1];
        const key = parts[2];
        const baseUrl = parts[3] || undefined;
        if (!name || !key) {
          await msg.edit({
            text: `\u274c \u7528\u6cd5: <code>${mainPrefix}checkapi save &lt;name&gt; &lt;key&gt; [baseUrl]</code>\n\n\u793a\u4f8b:\n<code>${mainPrefix}checkapi save openai sk-xxx</code>\n<code>${mainPrefix}checkapi save myproxy sk-xxx https://my.proxy.com/v1</code>`,
            parseMode: "html",
          });
          return;
        }
        const keys = await loadKeys();
        const existing = keys.findIndex((k) => k.name === name);
        const info = detectProvider(key, baseUrl);
        const entry: SavedKey = { name, key, baseUrl, provider: info.provider, addedAt: Date.now() };
        if (existing >= 0) {
          keys[existing] = entry;
          await saveKeys(keys);
          await msg.edit({ text: `\u2705 \u5df2\u66f4\u65b0 <b>${name}</b> (${info.displayName})`, parseMode: "html" });
        } else {
          keys.push(entry);
          await saveKeys(keys);
          await msg.edit({
            text: `\u2705 \u5df2\u4fdd\u5b58 <b>${name}</b> (${info.displayName})\n\n\u4f7f\u7528 <code>${mainPrefix}checkapi check ${name}</code> \u68c0\u6d4b`,
            parseMode: "html",
          });
        }
        return;
      }

      // check (saved)
      if (sub === "check") {
        const target = parts[1] || "all";
        if (target === "all") {
          const keys = await loadKeys();
          if (keys.length === 0) {
            await msg.edit({ text: "\u{1F4ED} \u672a\u4fdd\u5b58\u4efb\u4f55 Key", parseMode: "html" });
            return;
          }
          await msg.edit({ text: `\u{1F50D} \u6b63\u5728\u68c0\u6d4b ${keys.length} \u4e2a Key...`, parseMode: "html" });
          const results: string[] = [];
          for (const k of keys) {
            const info = detectProvider(k.key, k.baseUrl);
            results.push(`\n\u2501\u2501\u2501 <b>${k.name}</b> (${info.displayName}) \u2501\u2501\u2501`);
            results.push(await fullCheck(info, k.key));
          }
          await msg.edit({ text: results.join("\n"), parseMode: "html" });
          return;
        }

        const keys = await loadKeys();
        const found = keys.find((k) => k.name === target);
        if (found) {
          await msg.edit({ text: `\u{1F50D} \u6b63\u5728\u68c0\u6d4b <b>${target}</b>...`, parseMode: "html" });
          const info = detectProvider(found.key, found.baseUrl);
          const result = await fullCheck(info, found.key);
          await msg.edit({ text: result, parseMode: "html" });
          return;
        }
        await msg.edit({
          text: `\u274c \u672a\u627e\u5230\u540d\u4e3a <b>${target}</b> \u7684 Key\n\n\u4f7f\u7528 <code>${mainPrefix}checkapi list</code> \u67e5\u770b\u5df2\u4fdd\u5b58`,
          parseMode: "html",
        });
        return;
      }

      // balance / models / test subcommands
      if (sub === "balance" || sub === "models" || sub === "test") {
        const input = parts[1];
        if (!input) {
          await msg.edit({ text: `\u274c \u7528\u6cd5: <code>${mainPrefix}checkapi ${sub} &lt;key|name&gt;</code>`, parseMode: "html" });
          return;
        }

        const keys = await loadKeys();
        const found = keys.find((k) => k.name === input);
        let key: string;
        let info: ProviderInfo;

        if (found) {
          key = found.key;
          info = detectProvider(found.key, found.baseUrl);
          await msg.edit({ text: `\u{1F50D} \u68c0\u6d4b <b>${input}</b> (${info.displayName})...`, parseMode: "html" });
        } else {
          key = input;
          info = detectProvider(key);
          await msg.edit({ text: `\u{1F50D} ${info.displayName}...`, parseMode: "html" });
        }

        try {
          if (sub === "balance") {
            let result: string;
            if (info.provider === "openai" || info.provider === "custom") {
              result = await checkOpenAIBalance(key, info.baseUrl);
            } else if (info.provider === "deepseek") {
              result = await checkDeepSeekBalance(key, info.baseUrl);
            } else if (info.provider === "openrouter") {
              result = await checkOpenRouterBalance(key, info.baseUrl);
            } else if (info.provider === "anthropic") {
              result = await checkAnthropicUsage(key);
            } else if (info.provider === "gemini") {
              result = await checkGeminiKey(key);
            } else if (info.provider === "xai") {
              result = await checkXAIKey(key, info.baseUrl);
            } else {
              result = "\u2753 \u672a\u77e5 provider";
            }
            await msg.edit({ text: `\u{1F4B0} <b>${info.displayName}</b> \u4f59\u989d\n\n${result}`, parseMode: "html" });
          } else if (sub === "models") {
            const result = await listModels(info.provider, key, info.baseUrl);
            await msg.edit({ text: result, parseMode: "html" });
          } else if (sub === "test") {
            const result = await testConnection(info.provider, key, info.baseUrl);
            await msg.edit({ text: `\u{1F4E1} <b>${info.displayName}</b> \u8fde\u63a5\u6d4b\u8bd5\n\n${result}`, parseMode: "html" });
          }
        } catch (e: unknown) {
          await msg.edit({ text: `\u274c \u67e5\u8be2\u5931\u8d25: ${getErrorMessage(e)}`, parseMode: "html" });
        }
        return;
      }

      // Inline key: full auto-detect + check
      const key = parts[0];
      const info = detectProvider(key);
      await msg.edit({ text: `\u{1F50D} \u8bc6\u522b\u4e3a <b>${info.displayName}</b>\uff0c\u6b63\u5728\u68c0\u6d4b...`, parseMode: "html" });

      try {
        const result = await fullCheck(info, key);
        await msg.edit({ text: result, parseMode: "html" });
      } catch (e: unknown) {
        await msg.edit({ text: `\u274c \u68c0\u6d4b\u5931\u8d25: ${getErrorMessage(e)}`, parseMode: "html" });
      }
    },
  };
}

export default new CheckApiPlugin();

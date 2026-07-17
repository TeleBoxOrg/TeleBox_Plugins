/**
 * DuckDuckGo 搜索插件
 *
 * 命令：.duckduckgo / .ddg
 *
 * 链路：
 *  1) DDG HTML + Chrome TLS 伪装（curl_cffi）
 *  2) Firecrawl keyless search（不足时回退）
 *
 * tpm 只下载 .ts。首次使用自动：
 *  - ddg_fetch.py → assets/duckduckgo/（不在 plugins/）
 *  - pip 安装 curl_cffi（不入 package.json）
 *
 * 未提交：仅供本地测试。
 */

import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { Api } from "teleproto";
import axios from "axios";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { htmlEscape } from "@utils/htmlEscape";

const execFileAsync = promisify(execFile);
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 15;
const FIRECRAWL_SEARCH = "https://api.firecrawl.dev/v2/search";
const UA_BOT = "TeleBox-Search/1.5 (+https://github.com/TeleBoxOrg)";


const PLUGIN_ASSET_NAME = "duckduckgo";
const DDG_FETCH_FILENAME = "ddg_fetch.py";
/** 变更嵌入脚本时递增，触发覆盖 assets 中旧文件。
 * 改仓库内 ddg_fetch.py 后必须：重算 DDG_FETCH_PY_B64 并 +1 本版本号。
 */
const DDG_FETCH_VERSION = 1;
/** tpm 只装 .ts；脚本 base64 内嵌，首次使用落到 assets/duckduckgo/ */
const DDG_FETCH_PY_B64 = "IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJGZXRjaCBEdWNrRHVja0dvIEhUTUwgU0VSUCB3aXRoIENocm9tZSBUTFMgaW1wZXJzb25hdGlvbiAoY3VybF9jZmZpKS4KClN0ZG91dDogSlNPTiB7ICJvayI6IGJvb2wsICJzdGF0dXMiOiBpbnQsICJibG9ja2VkIjogYm9vbCwgInJlc3VsdHMiOiBbLi4uXSB9ClVzZWQgYnkgZHVja2R1Y2tnby50cyDigJQgbm8gQVBJIGtleSByZXF1aXJlZC4KIiIiCmZyb20gX19mdXR1cmVfXyBpbXBvcnQgYW5ub3RhdGlvbnMKCmltcG9ydCBqc29uCmltcG9ydCByZQppbXBvcnQgc3lzCmZyb20gdXJsbGliLnBhcnNlIGltcG9ydCBwYXJzZV9xcywgdW5xdW90ZSwgdXJscGFyc2UKCgpkZWYgc3RyaXBfaHRtbChzOiBzdHIpIC0+IHN0cjoKICAgIHMgPSByZS5zdWIociI8W14+XSs+IiwgIiIsIHMgb3IgIiIpCiAgICBzID0gKAogICAgICAgIHMucmVwbGFjZSgiJmFtcDsiLCAiJiIpCiAgICAgICAgLnJlcGxhY2UoIiZsdDsiLCAiPCIpCiAgICAgICAgLnJlcGxhY2UoIiZndDsiLCAiPiIpCiAgICAgICAgLnJlcGxhY2UoIiZxdW90OyIsICciJykKICAgICAgICAucmVwbGFjZSgiJiMzOTsiLCAiJyIpCiAgICAgICAgLnJlcGxhY2UoIiYjeDI3OyIsICInIikKICAgICAgICAucmVwbGFjZSgiJm5ic3A7IiwgIiAiKQogICAgKQogICAgcmV0dXJuIHJlLnN1YihyIlxzKyIsICIgIiwgcykuc3RyaXAoKQoKCmRlZiBkZWNvZGVfdWRkZyhocmVmOiBzdHIpIC0+IHN0cjoKICAgIHRyeToKICAgICAgICBpZiBocmVmLnN0YXJ0c3dpdGgoIi8vIik6CiAgICAgICAgICAgIGhyZWYgPSAiaHR0cHM6IiArIGhyZWYKICAgICAgICBxID0gcGFyc2VfcXModXJscGFyc2UoaHJlZikucXVlcnkpCiAgICAgICAgaWYgInVkZGciIGluIHEgYW5kIHFbInVkZGciXToKICAgICAgICAgICAgcmV0dXJuIHVucXVvdGUocVsidWRkZyJdWzBdKQogICAgICAgIHJldHVybiBocmVmCiAgICBleGNlcHQgRXhjZXB0aW9uOgogICAgICAgIHJldHVybiBocmVmCgoKZGVmIHBhcnNlX3Jlc3VsdHMoaHRtbDogc3RyLCBsaW1pdDogaW50KSAtPiBsaXN0W2RpY3RdOgogICAgaWYgcmUuc2VhcmNoKHIiYW5vbWFseS1tb2RhbHxVbmZvcnR1bmF0ZWx5LCBib3RzIHVzZSBEdWNrRHVja0dvIiwgaHRtbCwgcmUuSSk6CiAgICAgICAgcmV0dXJuIFtdCiAgICBibG9ja3MgPSByZS5zcGxpdChyJ2NsYXNzPSJyZXN1bHQgcmVzdWx0c19saW5rcycsIGh0bWwpCiAgICBvdXQ6IGxpc3RbZGljdF0gPSBbXQogICAgZm9yIGJsb2NrIGluIGJsb2Nrc1sxOl06CiAgICAgICAgaWYgbGVuKG91dCkgPj0gbGltaXQ6CiAgICAgICAgICAgIGJyZWFrCiAgICAgICAgaWYgInJlc3VsdC0tYWQiIGluIGJsb2NrIG9yICJ5LmpzP2FkXyIgaW4gYmxvY2s6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgbSA9IHJlLnNlYXJjaCgKICAgICAgICAgICAgcidjbGFzcz0icmVzdWx0X19hIlxzK2hyZWY9IihbXiJdKykiW14+XSo+KFtcc1xTXSo/KTwvYT4nLAogICAgICAgICAgICBibG9jaywKICAgICAgICAgICAgcmUuSSwKICAgICAgICApCiAgICAgICAgaWYgbm90IG06CiAgICAgICAgICAgIG0gPSByZS5zZWFyY2goCiAgICAgICAgICAgICAgICByJ2hyZWY9IihbXiJdKykiW14+XSpjbGFzcz0icmVzdWx0X19hIltePl0qPihbXHNcU10qPyk8L2E+JywKICAgICAgICAgICAgICAgIGJsb2NrLAogICAgICAgICAgICAgICAgcmUuSSwKICAgICAgICAgICAgKQogICAgICAgIGlmIG5vdCBtOgogICAgICAgICAgICBjb250aW51ZQogICAgICAgIHNuID0gcmUuc2VhcmNoKAogICAgICAgICAgICByJ2NsYXNzPSJyZXN1bHRfX3NuaXBwZXQiW14+XSo+KFtcc1xTXSo/KTwvKD86YXx0ZHxkaXYpJywKICAgICAgICAgICAgYmxvY2ssCiAgICAgICAgICAgIHJlLkksCiAgICAgICAgKQogICAgICAgIHVtID0gcmUuc2VhcmNoKHInY2xhc3M9InJlc3VsdF9fdXJsIltePl0qPihbXHNcU10qPyk8LycsIGJsb2NrLCByZS5JKQogICAgICAgIHRpdGxlID0gc3RyaXBfaHRtbChtLmdyb3VwKDIpKQogICAgICAgIHVybCA9IGRlY29kZV91ZGRnKG0uZ3JvdXAoMSkpCiAgICAgICAgaWYgbm90IHRpdGxlIG9yIG5vdCB1cmw6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgaWYgcmUubWF0Y2gociJeaHR0cHM/Oi8vZHVja2R1Y2tnb1wuY29tL2MvIiwgdXJsLCByZS5JKToKICAgICAgICAgICAgY29udGludWUKICAgICAgICBkaXNwbGF5ID0gc3RyaXBfaHRtbCh1bS5ncm91cCgxKSkgaWYgdW0gZWxzZSAiIgogICAgICAgIGlmIG5vdCBkaXNwbGF5OgogICAgICAgICAgICB0cnk6CiAgICAgICAgICAgICAgICBkaXNwbGF5ID0gdXJscGFyc2UodXJsKS5ob3N0bmFtZSBvciAiIgogICAgICAgICAgICAgICAgaWYgZGlzcGxheS5zdGFydHN3aXRoKCJ3d3cuIik6CiAgICAgICAgICAgICAgICAgICAgZGlzcGxheSA9IGRpc3BsYXlbNDpdCiAgICAgICAgICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAgICAgICAgICAgICBkaXNwbGF5ID0gIiIKICAgICAgICBvdXQuYXBwZW5kKAogICAgICAgICAgICB7CiAgICAgICAgICAgICAgICAidGl0bGUiOiB0aXRsZSwKICAgICAgICAgICAgICAgICJ1cmwiOiB1cmwsCiAgICAgICAgICAgICAgICAic25pcHBldCI6IHN0cmlwX2h0bWwoc24uZ3JvdXAoMSkpIGlmIHNuIGVsc2UgIiIsCiAgICAgICAgICAgICAgICAiZGlzcGxheSI6IGRpc3BsYXksCiAgICAgICAgICAgICAgICAic291cmNlIjogImRkZy1odG1sIiwKICAgICAgICAgICAgfQogICAgICAgICkKICAgIHJldHVybiBvdXQKCgpkZWYgbWFpbigpIC0+IGludDoKICAgIGlmIGxlbihzeXMuYXJndikgPCAyOgogICAgICAgIHByaW50KGpzb24uZHVtcHMoeyJvayI6IEZhbHNlLCAiZXJyb3IiOiAidXNhZ2U6IGRkZ19mZXRjaC5weSA8cXVlcnk+IFtsaW1pdF0ifSkpCiAgICAgICAgcmV0dXJuIDIKICAgIHF1ZXJ5ID0gc3lzLmFyZ3ZbMV0KICAgIGxpbWl0ID0gOAogICAgaWYgbGVuKHN5cy5hcmd2KSA+PSAzOgogICAgICAgIHRyeToKICAgICAgICAgICAgbGltaXQgPSBtYXgoMSwgbWluKDE1LCBpbnQoc3lzLmFyZ3ZbMl0pKSkKICAgICAgICBleGNlcHQgVmFsdWVFcnJvcjoKICAgICAgICAgICAgbGltaXQgPSA4CgogICAgdHJ5OgogICAgICAgIGZyb20gY3VybF9jZmZpIGltcG9ydCByZXF1ZXN0cwogICAgZXhjZXB0IEltcG9ydEVycm9yOgogICAgICAgIGltcG9ydCBzdWJwcm9jZXNzCgogICAgICAgIHRyeToKICAgICAgICAgICAgc3VicHJvY2Vzcy5jaGVja19jYWxsKAogICAgICAgICAgICAgICAgWwogICAgICAgICAgICAgICAgICAgIHN5cy5leGVjdXRhYmxlLAogICAgICAgICAgICAgICAgICAgICItbSIsCiAgICAgICAgICAgICAgICAgICAgInBpcCIsCiAgICAgICAgICAgICAgICAgICAgImluc3RhbGwiLAogICAgICAgICAgICAgICAgICAgICItLXVzZXIiLAogICAgICAgICAgICAgICAgICAgICItcSIsCiAgICAgICAgICAgICAgICAgICAgImN1cmxfY2ZmaSIsCiAgICAgICAgICAgICAgICAgICAgIi0tYnJlYWstc3lzdGVtLXBhY2thZ2VzIiwKICAgICAgICAgICAgICAgIF0sCiAgICAgICAgICAgICAgICB0aW1lb3V0PTE4MCwKICAgICAgICAgICAgKQogICAgICAgICAgICBmcm9tIGN1cmxfY2ZmaSBpbXBvcnQgcmVxdWVzdHMgICMgdHlwZTogaWdub3JlCiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBpbnN0X2VycjoKICAgICAgICAgICAgcHJpbnQoCiAgICAgICAgICAgICAgICBqc29uLmR1bXBzKAogICAgICAgICAgICAgICAgICAgIHsKICAgICAgICAgICAgICAgICAgICAgICAgIm9rIjogRmFsc2UsCiAgICAgICAgICAgICAgICAgICAgICAgICJlcnJvciI6IGYiY3VybF9jZmZpIGluc3RhbGwgZmFpbGVkOiB7aW5zdF9lcnJ9IiwKICAgICAgICAgICAgICAgICAgICAgICAgInJlc3VsdHMiOiBbXSwKICAgICAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgICAgICApCiAgICAgICAgICAgICkKICAgICAgICAgICAgcmV0dXJuIDEKCiAgICB0cnk6CiAgICAgICAgciA9IHJlcXVlc3RzLmdldCgKICAgICAgICAgICAgImh0dHBzOi8vaHRtbC5kdWNrZHVja2dvLmNvbS9odG1sLyIsCiAgICAgICAgICAgIHBhcmFtcz17InEiOiBxdWVyeX0sCiAgICAgICAgICAgIGltcGVyc29uYXRlPSJjaHJvbWUxMjAiLAogICAgICAgICAgICB0aW1lb3V0PTI1LAogICAgICAgICAgICBoZWFkZXJzPXsKICAgICAgICAgICAgICAgICJBY2NlcHQiOiAidGV4dC9odG1sLGFwcGxpY2F0aW9uL3hodG1sK3htbCIsCiAgICAgICAgICAgICAgICAiQWNjZXB0LUxhbmd1YWdlIjogInpoLUNOLHpoO3E9MC45LGVuO3E9MC44IiwKICAgICAgICAgICAgfSwKICAgICAgICApCiAgICAgICAgdGV4dCA9IHIudGV4dCBvciAiIgogICAgICAgIGJsb2NrZWQgPSByLnN0YXR1c19jb2RlID09IDIwMiBvciBib29sKAogICAgICAgICAgICByZS5zZWFyY2goCiAgICAgICAgICAgICAgICByImFub21hbHktbW9kYWx8VW5mb3J0dW5hdGVseSwgYm90cyB1c2UgRHVja0R1Y2tHbyIsIHRleHQsIHJlLkkKICAgICAgICAgICAgKQogICAgICAgICkKICAgICAgICByZXN1bHRzID0gW10gaWYgYmxvY2tlZCBlbHNlIHBhcnNlX3Jlc3VsdHModGV4dCwgbGltaXQpCiAgICAgICAgcHJpbnQoCiAgICAgICAgICAgIGpzb24uZHVtcHMoCiAgICAgICAgICAgICAgICB7CiAgICAgICAgICAgICAgICAgICAgIm9rIjogVHJ1ZSwKICAgICAgICAgICAgICAgICAgICAic3RhdHVzIjogci5zdGF0dXNfY29kZSwKICAgICAgICAgICAgICAgICAgICAiYmxvY2tlZCI6IGJsb2NrZWQsCiAgICAgICAgICAgICAgICAgICAgInJlc3VsdHMiOiByZXN1bHRzLAogICAgICAgICAgICAgICAgfSwKICAgICAgICAgICAgICAgIGVuc3VyZV9hc2NpaT1GYWxzZSwKICAgICAgICAgICAgKQogICAgICAgICkKICAgICAgICByZXR1cm4gMAogICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOgogICAgICAgIHByaW50KAogICAgICAgICAgICBqc29uLmR1bXBzKAogICAgICAgICAgICAgICAgeyJvayI6IEZhbHNlLCAiZXJyb3IiOiBzdHIoZSksICJyZXN1bHRzIjogW10sICJibG9ja2VkIjogVHJ1ZX0sCiAgICAgICAgICAgICAgICBlbnN1cmVfYXNjaWk9RmFsc2UsCiAgICAgICAgICAgICkKICAgICAgICApCiAgICAgICAgcmV0dXJuIDEKCgppZiBfX25hbWVfXyA9PSAiX19tYWluX18iOgogICAgcmFpc2UgU3lzdGVtRXhpdChtYWluKCkpCg==";

function ensureDdgFetchScript(): string {
  const dir = createDirectoryInAssets(PLUGIN_ASSET_NAME);
  const scriptPath = path.join(dir, DDG_FETCH_FILENAME);
  const markerPath = path.join(dir, ".ddg_fetch.version");
  const want = String(DDG_FETCH_VERSION);
  let needWrite = !fs.existsSync(scriptPath);
  if (!needWrite) {
    try {
      const cur = fs.existsSync(markerPath)
        ? fs.readFileSync(markerPath, "utf8").trim()
        : "";
      if (cur !== want) needWrite = true;
    } catch {
      needWrite = true;
    }
  }
  if (needWrite) {
    fs.mkdirSync(dir, { recursive: true });
    const body = Buffer.from(DDG_FETCH_PY_B64, "base64").toString("utf8");
    fs.writeFileSync(scriptPath, body, { encoding: "utf8", mode: 0o755 });
    try {
      fs.chmodSync(scriptPath, 0o755);
    } catch {
      /* ignore */
    }
    fs.writeFileSync(markerPath, `${want}\n`, "utf8");
  }
  return scriptPath;
}

/** 首次搜索：写 assets 脚本 + pip 装 curl_cffi（不入 package.json / 不放 plugins/）
 * 仅缓存成功结果；失败清空以便下次重试。
 */
let runtimeReady: Promise<{ ok: boolean; script: string; note?: string }> | null =
  null;

async function ensureRuntime(): Promise<{
  ok: boolean;
  script: string;
  note?: string;
}> {
  if (runtimeReady) return runtimeReady;

  const task = (async () => {
    let script = "";
    try {
      script = ensureDdgFetchScript();
    } catch (e: unknown) {
      return {
        ok: false as const,
        script: "",
        note: `初始化 ddg_fetch.py 失败: ${getErrorMessage(e).slice(0, 120)}`,
      };
    }

    try {
      await execFileAsync(
        "python3",
        ["-c", "from curl_cffi import requests"],
        { timeout: 10_000 },
      );
      return { ok: true as const, script };
    } catch {
      try {
        await execFileAsync(
          "python3",
          [
            "-m",
            "pip",
            "install",
            "--user",
            "-q",
            "curl_cffi",
            "--break-system-packages",
          ],
          {
            timeout: 180_000,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
          },
        );
        await execFileAsync(
          "python3",
          ["-c", "from curl_cffi import requests"],
          { timeout: 10_000 },
        );
        return { ok: true as const, script };
      } catch (e: unknown) {
        return {
          ok: false as const,
          script,
          note: `curl_cffi 安装失败: ${getErrorMessage(e).slice(0, 120)}`,
        };
      }
    }
  })();

  // 进行中先挂上，避免并发重复 pip；失败后清掉以允许重试
  runtimeReady = task.then((r) => {
    if (!r.ok) runtimeReady = null;
    return r;
  });
  return runtimeReady;
}



function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown");
}

const help_text = `🔍 <b>DuckDuckGo 搜索</b>

<b>用法：</b>
• <code>${mainPrefix}ddg &lt;关键词&gt;</code>
• <code>${mainPrefix}duckduckgo &lt;关键词&gt;</code>
• <code>${mainPrefix}ddg &lt;关键词&gt; -n 5</code> — 条数 1–${MAX_LIMIT}

<b>链路（自动）：</b>
1. DuckDuckGo HTML（Chrome TLS 伪装）
2. Firecrawl 免 Key 搜索（结果不足时）

<b>首次使用：</b>自动初始化 <code>assets/duckduckgo/</code> 与 curl_cffi`;

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  display: string;
  source: string;
};

type SearchBundle = {
  results: SearchResult[];
  sources: string[];
  notes: string[];
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function parseLimitAndQuery(rawArgs: string[]): { query: string; limit: number } {
  let limit = DEFAULT_LIMIT;
  const parts: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (
      (a === "-n" || a === "--num" || a === "-l" || a === "--limit") &&
      rawArgs[i + 1]
    ) {
      const n = parseInt(rawArgs[i + 1], 10);
      if (Number.isFinite(n)) limit = Math.min(MAX_LIMIT, Math.max(1, n));
      i++;
      continue;
    }
    parts.push(a);
  }
  return { query: parts.join(" ").trim(), limit };
}

function dedupeResults(items: SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const it of items) {
    if (!it.title || !it.url) continue;
    const key = it.url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchDdgViaCurlCffi(
  query: string,
  limit: number,
): Promise<{ results: SearchResult[]; blocked: boolean; note?: string }> {
  const runtime = await ensureRuntime();
  if (!runtime.ok) {
    return {
      results: [],
      blocked: true,
      note: runtime.note || "运行时初始化失败",
    };
  }
  const script = runtime.script;

  try {
    const { stdout, stderr } = await execFileAsync(
      "python3",
      [script, query, String(limit)],
      {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      },
    );
    if (stderr && /Error|Traceback/i.test(stderr)) {
      console.warn("[duckduckgo] ddg_fetch stderr", stderr.slice(0, 300));
    }
    const raw = String(stdout || "").trim();
    if (!raw) {
      return { results: [], blocked: true, note: "ddg_fetch 无输出" };
    }
    const data = JSON.parse(raw) as {
      ok?: boolean;
      blocked?: boolean;
      results?: SearchResult[];
      error?: string;
      status?: number;
    };
    if (!data.ok) {
      return {
        results: [],
        blocked: true,
        note: data.error || "ddg_fetch 失败",
      };
    }
    if (data.blocked) {
      return { results: [], blocked: true, note: "DDG 反爬（TLS 伪装后仍 202）" };
    }
    const results = (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet || "",
      display: r.display || hostOf(r.url),
      source: "ddg-html",
    }));
    return { results, blocked: false };
  } catch (e: unknown) {
    const msg = getErrorMessage(e);
    console.warn("[duckduckgo] curl_cffi DDG 失败", e);
    return { results: [], blocked: true, note: `ddg_fetch: ${msg.slice(0, 120)}` };
  }
}

async function fetchFirecrawl(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  try {
    const { data, status } = await axios.post(
      FIRECRAWL_SEARCH,
      { query, limit: Math.min(limit, MAX_LIMIT) },
      {
        timeout: 30_000,
        headers: { "Content-Type": "application/json", "User-Agent": UA_BOT },
        validateStatus: (s: number) => s >= 200 && s < 500,
      },
    );
    if (status >= 400 || !data) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root: any = data;
    let items: Array<{
      url?: string;
      title?: string;
      description?: string;
    }> = [];
    if (Array.isArray(root?.data?.web)) items = root.data.web;
    else if (Array.isArray(root?.data)) items = root.data;
    else if (Array.isArray(root?.web)) items = root.web;

    return items.slice(0, limit).map((it) => ({
      title: String(it.title || hostOf(String(it.url || "")) || "result"),
      url: String(it.url || ""),
      snippet: String(it.description || ""),
      display: hostOf(String(it.url || "")),
      source: "firecrawl",
    }));
  } catch (e: unknown) {
    console.warn("[duckduckgo] Firecrawl 失败", e);
    return [];
  }
}

async function searchAll(query: string, limit: number): Promise<SearchBundle> {
  const notes: string[] = [];
  const sources: string[] = [];
  const collected: SearchResult[] = [];

  const ddg = await fetchDdgViaCurlCffi(query, limit);
  if (ddg.results.length) {
    sources.push("DuckDuckGo");
    collected.push(...ddg.results);
  } else if (ddg.note) {
    notes.push(ddg.note);
  }

  if (collected.length < limit) {
    const firecrawl = await fetchFirecrawl(query, limit);
    if (firecrawl.length) {
      sources.push("Firecrawl");
      collected.push(...firecrawl);
    } else if (collected.length === 0) {
      notes.push("Firecrawl 无结果");
    }
  }

  const rank: Record<string, number> = {
    "ddg-html": 0,
    firecrawl: 1,
  };
  collected.sort((a, b) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9));

  return {
    results: dedupeResults(collected, limit),
    sources: [...new Set(sources)],
    notes,
  };
}

const MSG_SOFT_LIMIT = 3500;
const MSG_HARD_LIMIT = 4000;

function buildHeader(
  query: string,
  total: number,
  sources: string[],
  elapsedMs: number,
): string {
  return (
    `🔍 <b>DuckDuckGo</b> · <code>${htmlEscape(query)}</code>\n` +
    `⏱ ${elapsedMs}ms · ${total} 条` +
    (sources.length ? ` · ${htmlEscape(sources.join(" + "))}` : "")
  );
}

function buildResultBlock(r: SearchResult, index: number): string {
  const lines: string[] = [];
  const title =
    r.title.length > 120 ? `${r.title.slice(0, 120)}…` : r.title;
  lines.push(
    `<b>${index}.</b> <a href="${htmlEscape(r.url)}">${htmlEscape(title)}</a>`,
  );
  const body: string[] = [];
  body.push(`🔗 ${htmlEscape(r.url)}`);
  const meta = [r.display, r.source !== "ddg-html" ? r.source : ""]
    .filter(Boolean)
    .join(" · ");
  if (meta) body.push(`🏷 ${htmlEscape(meta)}`);
  if (r.snippet) {
    const snip =
      r.snippet.length > 280 ? `${r.snippet.slice(0, 280)}…` : r.snippet;
    body.push("");
    body.push(htmlEscape(snip));
  }
  lines.push(`<blockquote expandable>${body.join("\n")}</blockquote>`);
  return lines.join("\n");
}

function buildFooter(query: string): string {
  return `🌐 <a href="https://duckduckgo.com/?q=${encodeURIComponent(query)}">在 DuckDuckGo 打开</a>`;
}

function canFit(base: string, block: string, limit: number): string | null {
  const next = base ? `${base}\n${block}` : block;
  return next.length <= limit ? next : null;
}

/**
 * 按完整 HTML 块拆成 N 条消息（需要几条就几条）。
 * - 只在块边界切开（标题 + blockquote 一体）
 * - 不截断标签 / 不重复条目
 */
function packSearchMessages(
  query: string,
  bundle: SearchBundle,
  elapsedMs: number,
): string[] {
  const { results, sources, notes } = bundle;
  const total = results.length;
  const footer = buildFooter(query);

  if (total === 0) {
    const empty: string[] = [
      buildHeader(query, 0, sources, elapsedMs),
      "",
      "⚠️ 没有找到结果。可换关键词重试。",
    ];
    if (notes.length) {
      empty.push(
        `<blockquote expandable>${htmlEscape(notes.join("\n"))}</blockquote>`,
      );
    }
    empty.push("", footer);
    return [empty.join("\n").trimEnd()];
  }

  type Chunk = {
    kind: "prelude" | "result" | "note" | "footer";
    html: string;
    index?: number;
  };
  const queue: Chunk[] = [];

  queue.push({
    kind: "prelude",
    html: `${buildHeader(query, total, sources, elapsedMs)}\n`,
  });

  results.forEach((r, i) => {
    queue.push({
      kind: "result",
      html: buildResultBlock(r, i + 1),
      index: i + 1,
    });
  });

  if (notes.length) {
    queue.push({
      kind: "note",
      html: `<blockquote expandable>ℹ️ ${htmlEscape(notes.join("；"))}</blockquote>`,
    });
  }
  queue.push({ kind: "footer", html: footer });

  const pages: string[] = [];
  let page = "";
  let pageFirstIdx = 0;
  let pageLastIdx = 0;
  const pageRanges: Array<{ from: number; to: number }> = [];

  const flush = () => {
    if (!page.trim()) return;
    pages.push(page.trimEnd());
    pageRanges.push({ from: pageFirstIdx, to: pageLastIdx });
    page = "";
    pageFirstIdx = 0;
    pageLastIdx = 0;
  };

  const startContinuation = (fromIdx: number) => {
    page =
      `🔍 <b>DuckDuckGo</b> · <code>${htmlEscape(query)}</code>\n` +
      `📄 续 · 第 ${fromIdx} 条起 / 共 ${total} 条\n`;
    pageFirstIdx = fromIdx;
    pageLastIdx = fromIdx;
  };

  for (const chunk of queue) {
    if (chunk.html.length > MSG_HARD_LIMIT) {
      flush();
      if (chunk.kind === "result" && chunk.index) {
        startContinuation(chunk.index);
        page = `${page}\n${chunk.html}`;
        pageLastIdx = chunk.index;
      } else if (pages.length === 0 && chunk.kind === "prelude") {
        page = chunk.html;
      } else {
        page = chunk.html;
      }
      flush();
      continue;
    }

    const limit = page.length === 0 ? MSG_HARD_LIMIT : MSG_SOFT_LIMIT;
    const fitted = canFit(page, chunk.html, limit);
    if (fitted != null) {
      page = fitted;
      if (chunk.kind === "result" && chunk.index) {
        if (!pageFirstIdx) pageFirstIdx = chunk.index;
        pageLastIdx = chunk.index;
      }
      continue;
    }

    flush();
    if (chunk.kind === "result" && chunk.index) {
      startContinuation(chunk.index);
      page =
        canFit(page, chunk.html, MSG_HARD_LIMIT) ?? `${page}\n${chunk.html}`;
      pageLastIdx = chunk.index;
    } else {
      page = chunk.html;
    }
  }
  flush();

  if (pages.length > 1) {
    const n = pages.length;
    for (let i = 0; i < n; i++) {
      const range = pageRanges[i];
      let hint = `\n\n📄 (${i + 1}/${n})`;
      if (range && range.from && range.to) {
        if (range.from === range.to) {
          hint = `\n\n📄 (${i + 1}/${n}) · 第 ${range.from} 条`;
        } else {
          hint = `\n\n📄 (${i + 1}/${n}) · 第 ${range.from}–${range.to} 条`;
        }
      }
      if (i < n - 1) hint += " · 续见下一条";
      if (pages[i].length + hint.length <= MSG_HARD_LIMIT) {
        pages[i] = pages[i] + hint;
      } else if (
        pages[i].length + `\n\n📄 (${i + 1}/${n})`.length <=
        MSG_HARD_LIMIT
      ) {
        pages[i] = pages[i] + `\n\n📄 (${i + 1}/${n})`;
      }
    }
  }

  return pages.length ? pages : ["⚠️ 空结果"];
}

async function deliverSearchMessages(
  msg: Api.Message,
  client: Awaited<ReturnType<typeof getGlobalClient>>,
  parts: string[],
): Promise<void> {
  if (!client) return;
  const first = parts[0] || "⚠️ 空结果";
  await msg.edit({
    text: first,
    parseMode: "html",
    linkPreview: false,
  });

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    try {
      await client.sendMessage(msg.peerId, {
        message: part,
        parseMode: "html",
        linkPreview: false,
      });
    } catch (e: unknown) {
      console.warn(`[duckduckgo] sendMessage 第 ${i + 1} 页失败，尝试 reply`, e);
      await msg.reply({
        message: part,
        parseMode: "html",
        linkPreview: false,
      });
    }
  }
}

async function handleSearch(msg: Api.Message): Promise<void> {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
    return;
  }

  const text = String(msg.text ?? "").trim();
  const parts = text ? text.split(/\s+/) : [];
  const rawArgs = parts.slice(1);
  const sub = (rawArgs[0] || "").toLowerCase();

  if (!rawArgs.length || sub === "help" || sub === "h") {
    await msg.edit({ text: help_text, parseMode: "html" });
    return;
  }

  const { query, limit } = parseLimitAndQuery(rawArgs);
  if (!query) {
    await msg.edit({ text: help_text, parseMode: "html" });
    return;
  }
  if (query.length > 200) {
    await msg.edit({
      text: "❌ 关键词过长（最多 200 字符）",
      parseMode: "html",
    });
    return;
  }

  await msg.edit({
    text: `⏳ 正在初始化搜索环境…\n<code>${htmlEscape(query)}</code>`,
    parseMode: "html",
  });

  const started = Date.now();
  try {
    const runtime = await ensureRuntime();
    if (!runtime.ok) {
      // 仍尝试 Firecrawl-only：searchAll 内部会再 ensure；此处给出明确状态
      await msg.edit({
        text:
          `⏳ 运行时未就绪，尝试备用源…\n<code>${htmlEscape(query)}</code>` +
          (runtime.note
            ? `\n<blockquote expandable>${htmlEscape(runtime.note)}</blockquote>`
            : ""),
        parseMode: "html",
      });
    } else {
      await msg.edit({
        text: `⏳ 正在搜索 <code>${htmlEscape(query)}</code>…`,
        parseMode: "html",
      });
    }
    const bundle = await searchAll(query, limit);
    const elapsed = Date.now() - started;
    const messages = packSearchMessages(query, bundle, elapsed);
    await deliverSearchMessages(msg, client, messages);
  } catch (error: unknown) {
    const err = getErrorMessage(error);
    console.error("[duckduckgo] 搜索失败", error);
    await msg.edit({
      text: `❌ <b>搜索失败</b>\n<code>${htmlEscape(err.slice(0, 200))}</code>`,
      parseMode: "html",
    });
  }
}

class DuckDuckGoPlugin extends Plugin {
  name = "duckduckgo";
  description = `DuckDuckGo 搜索（TLS 伪装 + Firecrawl 回退）\n\n${help_text}`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    duckduckgo: async (msg) => handleSearch(msg),
    ddg: async (msg) => handleSearch(msg),
  };
}

export default new DuckDuckGoPlugin();

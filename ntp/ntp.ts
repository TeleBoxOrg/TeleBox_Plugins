import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import * as dgram from "dgram";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "ntp";

const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
<code>${commandName}</code> 查看与 NTP 的时间偏差
<code>${commandName} s</code> 对时（需要系统权限）
`;

// NTP helpers (no external deps)
const NTP_SERVERS = ["time.apple.com", "time.windows.com"] as const;
const NTP_PORT = 123;
const NTP_EPOCH_OFFSET = 2208988800; // seconds from 1900 to 1970

type NtpTimestamps = {
  t1: number; // client send (ms since unix epoch)
  t2?: number; // server receive (ms since unix epoch)
  t3?: number; // server transmit (ms since unix epoch)
  t4: number; // client receive (ms since unix epoch)
};

type NtpResult = {
  server: string;
  ip?: string;
  stratum?: number;
  delayMs?: number; // round-trip delay
  offsetMs?: number; // local clock offset (server - local)
  serverTimeMs?: number; // best estimate of server time at t4
  raw?: Buffer;
};

function toNtpSecondsAndFrac(ms: number): { sec: number; frac: number } {
  const s = Math.floor(ms / 1000) + NTP_EPOCH_OFFSET;
  const f = Math.round(((ms % 1000) / 1000) * 2 ** 32);
  return { sec: s >>> 0, frac: f >>> 0 };
}

function readNtpTimestamp(buf: Buffer, offset: number): number | undefined {
  if (!buf || buf.length < offset + 8) return undefined;
  const sec = buf.readUInt32BE(offset);
  const frac = buf.readUInt32BE(offset + 4);
  if (sec === 0 && frac === 0) return undefined; // not provided
  const ms = (sec - NTP_EPOCH_OFFSET) * 1000 + Math.floor((frac / 2 ** 32) * 1000);
  return ms;
}

async function queryOnce(host: string, timeoutMs = 2500): Promise<NtpResult> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let timeoutTimer: NodeJS.Timeout | null = null;

    const packet = Buffer.alloc(48);
    // LI = 0 (no warning), VN = 4, Mode = 3 (client) -> 0b00 100 011 = 0x23
    packet[0] = 0x23;
    // Transmit timestamp: set to client time (optional but good practice)
    const t1ms = Date.now();
    const t1 = toNtpSecondsAndFrac(t1ms);
    packet.writeUInt32BE(t1.sec, 40);
    packet.writeUInt32BE(t1.frac, 44);

    function cleanup() {
      try {
        socket.close();
      } catch {}
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    socket.once("error", (err) => {
      cleanup();
      reject(err);
    });

    socket.once("message", (msg, rinfo) => {
      const t4ms = Date.now();
      try {
        // Parse stratum and timestamps
        const stratum = msg[1];
        const t2ms = readNtpTimestamp(msg, 32);
        const t3ms = readNtpTimestamp(msg, 40);

        let delayMs: number | undefined;
        let offsetMs: number | undefined;
        let serverTimeMs: number | undefined;

        if (typeof t2ms === "number" && typeof t3ms === "number") {
          // Full NTP offset/delay calculation
          delayMs = (t4ms - t1ms) - (t3ms - t2ms);
          offsetMs = ((t2ms - t1ms) + (t3ms - t4ms)) / 2;
          // Best estimate of server time when received = t4 + offset
          serverTimeMs = Math.round(t4ms + (offsetMs || 0));
        } else if (typeof t3ms === "number") {
          // Fallback: assume symmetric path, use half the RTT
          const rtt = t4ms - t1ms;
          delayMs = rtt;
          offsetMs = t3ms - (t1ms + rtt / 2);
          serverTimeMs = Math.round(t4ms + (offsetMs || 0));
        }

        cleanup();
        resolve({
          server: host,
          ip: rinfo?.address,
          stratum,
          delayMs,
          offsetMs,
          serverTimeMs,
          raw: msg,
        });
      } catch (e) {
        cleanup();
        reject(e);
      }
    });

    timeoutTimer = setTimeout(() => {
      cleanup();
      reject(new Error(`NTP query timeout: ${host}`));
    }, timeoutMs);

    socket.send(packet, 0, packet.length, NTP_PORT, host, (err) => {
      if (err) {
        cleanup();
        reject(err);
      }
    });
  });
}

async function queryBest(servers = NTP_SERVERS, timeoutMs = 2500): Promise<NtpResult> {
  const tasks = servers.map((s) => queryOnce(s, timeoutMs).then(
    (r) => ({ status: "fulfilled" as const, value: r }),
    (e) => ({ status: "rejected" as const, reason: e })
  ));
  const results = await Promise.all(tasks);
  const fulfilled = results.filter((r) => r.status === "fulfilled") as Array<{
    status: "fulfilled";
    value: NtpResult;
  }>;
  if (fulfilled.length === 0) {
    const firstErr = (results.find((r) => r.status === "rejected") as any)?.reason;
    throw firstErr || new Error("All NTP queries failed");
  }
  // Prefer the one with smallest delay
  fulfilled.sort((a, b) => (a.value.delayMs ?? 1e12) - (b.value.delayMs ?? 1e12));
  return fulfilled[0].value;
}

function fmtMs(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
  const sign = ms >= 0 ? "+" : "-";
  const abs = Math.abs(ms);
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(3)}s`;
  return `${sign}${abs.toFixed(1)}ms`;
}

function formatDateCN(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

async function setSystemTimeBestEffort(serverTimeMs: number): Promise<{
  ok: boolean;
  command?: string;
  stdout?: string;
  stderr?: string;
  error?: any;
  hint?: string;
}> {
  const platform = process.platform;
  const target = new Date(serverTimeMs);
  try {
    if (platform === "linux") {
      const epochSec = Math.floor(serverTimeMs / 1000).toString();
      const args = ["-u", "-s", `@${epochSec}`];
      const { stdout, stderr } = await execFileAsync("date", args, { timeout: 5000 });
      return { ok: true, command: `date ${args.join(" ")}`, stdout, stderr };
    } else if (platform === "darwin") {
      // BSD date: [[[[mm]dd]HH]MM][[cc]yy][.ss]
      const yyyy = target.getUTCFullYear();
      const cc = Math.floor(yyyy / 100);
      const yy = yyyy % 100;
      const mm = target.getUTCMonth() + 1;
      const dd = target.getUTCDate();
      const HH = target.getUTCHours();
      const MM = target.getUTCMinutes();
      const ss = target.getUTCSeconds();
      const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
      const ts = `${pad(mm)}${pad(dd)}${pad(HH)}${pad(MM)}${cc}${pad(yy)}.${pad(ss)}`;
      const args = ["-u", ts];
      const { stdout, stderr } = await execFileAsync("date", args, { timeout: 5000 });
      return { ok: true, command: `date ${args.join(" ")}`, stdout, stderr };
    } else if (platform === "win32") {
      // Not supported here due to permission and locale complexities.
      return {
        ok: false,
        hint:
          "Windows 上暂不支持自动设置，请以管理员权限手动同步时间或启用 Windows 时间服务。",
      };
    }
    return { ok: false, hint: `暂不支持的平台：${platform}` };
  } catch (error: any) {
    const msg = String(error?.message || error);
    const needRoot = /not permitted|Operation not permitted|must be root|permission/i.test(
      msg
    );
    return {
      ok: false,
      error,
      hint: needRoot
        ? "需要管理员权限（sudo/root）。请以提升权限运行或手动执行上述命令。"
        : "设置失败。请检查系统权限与命令可用性。",
    };
  }
}

class NtpPlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }
  description: string = `\nNTP 对时\n\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    ntp: async (msg: Api.Message) => {
      const text = msg.message || "";
      const args = text.trim().split(/\s+/g).slice(1); // remove command

      // .ntp -> show current offset
      if (args.length === 0) {
        try {
          await msg.edit({ text: "⏳ 正在查询 NTP..." });
        } catch {}
        try {
          const result = await queryBest();
          const now = Date.now();
          const lines = [
            `🕒 NTP 查询完成`,
            `• 服务器: <code>${result.server}</code>${result.ip ? ` (${result.ip})` : ""}`,
            `• 分层: <code>${result.stratum ?? "-"}</code>`,
            `• 往返延迟: <code>${fmtMs(result.delayMs)}</code>`,
            `• 本地相对偏移: <code>${fmtMs(result.offsetMs)}</code>`,
            `• 本地时间: <code>${formatDateCN(new Date(now))}</code>`,
            result.serverTimeMs
              ? `• 服务器时间(估算): <code>${formatDateCN(
                  new Date(result.serverTimeMs)
                )}</code>`
              : undefined,
          ].filter(Boolean);
          await msg.edit({ text: lines.join("\n"), parseMode: "html" });
        } catch (e: any) {
          await msg.edit({ text: `❌ 查询失败：${e?.message || e}` });
        }
        return;
      }

      // .ntp s -> sync time (best effort, requires privileges)
      if (args[0].toLowerCase() === "s") {
        try {
          await msg.edit({ text: "🔧 正在对时（NTP 查询）..." });
        } catch {}
        try {
          const result = await queryBest();
          if (!result.serverTimeMs) throw new Error("无法获取服务器时间");

          const now = Date.now();
          const beforeOffset = result.offsetMs ?? result.serverTimeMs - now;
          const header = [
            `🔧 NTP 对时`,
            `• 服务器: <code>${result.server}</code>${result.ip ? ` (${result.ip})` : ""}`,
            `• 估算偏移: <code>${fmtMs(beforeOffset)}</code>`,
            `• 往返延迟: <code>${fmtMs(result.delayMs)}</code>`,
          ].join("\n");

          // Try set system time
          const setRes = await setSystemTimeBestEffort(result.serverTimeMs);
          if (setRes.ok) {
            await msg.edit({
              text:
                header +
                `\n• 已尝试设置系统时间：<code>${setRes.command}</code>` +
                (setRes.stdout ? `\n<pre>${(setRes.stdout || "").trim()}</pre>` : ""),
              parseMode: "html",
            });
          } else {
            const hint = setRes.hint || "无法设置系统时间。";
            await msg.edit({
              text:
                header +
                `\n• 未能自动设置系统时间。` +
                `\n▫︎ 原因/提示：${hint}` +
                `\n▫︎ 请以管理员权限运行，或手动设置系统时间为：` +
                `\n<code>${formatDateCN(new Date(result.serverTimeMs))}</code>`,
              parseMode: "html",
            });
          }
        } catch (e: any) {
          await msg.edit({ text: `❌ 对时失败：${e?.message || e}` });
        }
        return;
      }

      // Fallback: help
      await msg.edit({ text: help_text, parseMode: "html" });
    },
  };
}

export default new NtpPlugin();

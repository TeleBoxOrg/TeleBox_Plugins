import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "teleproto";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";

interface SignTarget {
  id: string;
  name: string;
  target: string;
  command: string;
  callbackData?: string;
  buttonText?: string;
  enabled: boolean;
}

interface CheckInConfig {
  runTime: string;
  logChat: string;
  randomDelay: number;
  lastRunDate: string;
  botToken: string;
  pushChatId: string;
  targets: SignTarget[];
}

type SignResult = { success: boolean; message?: string; error?: string };

const DEFAULT_CONFIG: CheckInConfig = {
  runTime: "10:00",
  logChat: "",
  randomDelay: 0,
  lastRunDate: "",
  botToken: "",
  pushChatId: "",
  targets: [],
};

const SH_TZ = "Asia/Shanghai";
const PREFIX = getPrefixes()[0] || ".";

class ConfigManager {
  private readonly configPath: string;
  private data: CheckInConfig;

  constructor() {
    const dir = createDirectoryInAssets("checkin");
    this.configPath = path.join(dir, "checkin_config.json");
    this.data = this.load();
  }

  private load(): CheckInConfig {
    try {
      if (!fs.existsSync(this.configPath)) return { ...DEFAULT_CONFIG };
      const raw = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
      const merged = { ...DEFAULT_CONFIG, ...raw };
      merged.targets = Array.isArray(raw?.targets) ? raw.targets : [];
      return merged;
    } catch (e) {
      console.error("[CheckIn] Config load error:", e);
      return { ...DEFAULT_CONFIG };
    }
  }

  get(): CheckInConfig {
    return this.data;
  }

  save(partial: Partial<CheckInConfig>): void {
    this.data = { ...this.data, ...partial };
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (e) {
      console.error("[CheckIn] Config save error:", e);
    }
  }
}

class CheckInPlugin extends Plugin {
  description = this.helpText();
  private readonly cfg = new ConfigManager();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor() {
    super();
    this.timer = setInterval(() => void this.checkAndRun(), 60_000);
  }

  cleanup(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    qd: async (msg: Api.Message) => {
      try {
        const parts = (msg.message || msg.text || "").trim().split(/\s+/);
        const args = parts.slice(1);
        const action = (args[0] || "").toLowerCase();

        if (!action || action === "help" || action === "h") {
          if (!action) {
            if (!this.cfg.get().targets.length) {
              await this.edit(msg, "❌ 当前没有配置签到目标，请先使用 add");
              return;
            }
            await this.edit(msg, "🚀 开始执行所有签到任务...");
            void this.runAllSigns("手动触发", msg.chatId, msg);
            return;
          }
          await this.edit(msg, this.helpText());
          return;
        }

        if (action === "add") {
          const id = args[1];
          const name = args[2];
          const target = args[3];
          const command = args[4];
          if (!id || !name || !target || !command) {
            await this.edit(msg, `❌ 格式错误：${PREFIX}qd add [ID] [名称] [目标] [命令] [data:回调数据|text:按钮名]`);
            return;
          }

          const matcher = this.parseButtonMatcher(args.slice(5));
          const conf = this.cfg.get();
          const next: SignTarget = { id, name, target, command, ...matcher, enabled: true };
          const i = conf.targets.findIndex((t) => t.id === id);
          if (i >= 0) conf.targets[i] = next;
          else conf.targets.push(next);
          this.cfg.save({ targets: conf.targets });
          await this.edit(msg, `✅ 已${i >= 0 ? "更新" : "添加"}签到目标: ${name} (${id})`);
          return;
        }

        if (action === "del" || action === "delete") {
          const id = args[1];
          if (!id) return void (await this.edit(msg, `❌ 请指定目标ID：${PREFIX}qd del [ID]`));
          const conf = this.cfg.get();
          const n = conf.targets.length;
          conf.targets = conf.targets.filter((t) => t.id !== id);
          this.cfg.save({ targets: conf.targets });
          await this.edit(msg, conf.targets.length < n ? `✅ 已删除签到目标: ${id}` : `❌ 未找到目标: ${id}`);
          return;
        }

        if (action === "list") {
          const conf = this.cfg.get();
          if (!conf.targets.length) return void (await this.edit(msg, "📝 当前没有配置签到目标"));
          const enabled = conf.targets.filter((t) => t.enabled).length;
          const lines = conf.targets
            .map((t, i) => {
              const m = t.callbackData ? `\n   回调: ${this.escape(t.callbackData)}` : t.buttonText ? `\n   按钮: ${this.escape(t.buttonText)}` : "";
              return `${t.enabled ? "🟢" : "🔴"} <b>${i + 1}. ${this.escape(t.name)}</b>\n   ID: ${this.escape(t.id)}\n   目标: ${this.escape(t.target)}\n   命令: ${this.escape(t.command)}${m}`;
            })
            .join("\n\n");
          await this.edit(msg, `📝 <b>签到目标列表</b> (${enabled}/${conf.targets.length} 个启用)\n\n${lines}`);
          return;
        }

        if (action === "toggle") {
          const id = args[1];
          if (!id) return void (await this.edit(msg, `❌ 请指定目标ID：${PREFIX}qd toggle [ID]`));
          const conf = this.cfg.get();
          const t = conf.targets.find((x) => x.id === id);
          if (!t) return void (await this.edit(msg, `❌ 未找到目标: ${id}`));
          t.enabled = !t.enabled;
          this.cfg.save({ targets: conf.targets });
          await this.edit(msg, `✅ 已${t.enabled ? "启用" : "禁用"}签到目标: ${this.escape(t.name)} (${this.escape(id)})`);
          return;
        }

        if (action === "test") {
          const id = args[1];
          if (!id) return void (await this.edit(msg, `❌ 请指定目标ID：${PREFIX}qd test [ID]`));
          const t = this.cfg.get().targets.find((x) => x.id === id);
          if (!t) return void (await this.edit(msg, `❌ 未找到目标: ${id}`));
          await this.edit(msg, `🚀 开始测试签到目标: ${this.escape(t.name)}...`);
          const r = await this.runSingleSign(t);
          await this.edit(msg, r.success ? `✅ <b>${this.escape(t.name)}</b> 测试成功\n\n结果: ${this.escape(r.message || "无")}` : `❌ <b>${this.escape(t.name)}</b> 测试失败\n\n错误: ${this.escape(r.error || "未知错误")}`);
          return;
        }

        if (action === "set") {
          const type = (args[1] || "").toLowerCase();
          const v = args[2];
          if (type === "time") {
            if (!v || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) return void (await this.edit(msg, "❌ 格式错误，请使用 HH:MM (例如 10:30)"));
            this.cfg.save({ runTime: v });
            await this.edit(msg, `✅ 每日运行时间已设置为: ${v}`);
            return;
          }
          if (type === "bot") {
            const token = args[2];
            const chatId = args[3];
            if (!token || !chatId) return void (await this.edit(msg, `❌ 格式错误：${PREFIX}qd set bot [Token] [ChatID]`));
            this.cfg.save({ botToken: token, pushChatId: chatId });
            await this.edit(msg, `✅ Bot配置已更新:\nToken: ${this.mask(token)}\nChatID: ${this.escape(chatId)}`);
            return;
          }
          if (type === "delay") {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0 || n > 60) return void (await this.edit(msg, "❌ 请输入 0-60 之间的分钟数"));
            this.cfg.save({ randomDelay: n });
            await this.edit(msg, `✅ 随机延迟已设置为: ${n} 分钟`);
            return;
          }
          await this.edit(msg, "❌ 未知设置项。支持: time, bot, delay");
          return;
        }

        if (action === "reset") {
          this.cfg.save({ lastRunDate: "" });
          await this.edit(msg, "✅ 已重置每日运行状态，定时任务可再次触发。");
          return;
        }

        if (action === "settings") {
          const conf = this.cfg.get();
          const enabled = conf.targets.filter((t) => t.enabled).length;
          await this.edit(
            msg,
            `⚙️ <b>CheckIn 配置信息</b>\n\n` +
              `运行时间: ${this.escape(conf.runTime)}\n` +
              `Bot Token: ${this.mask(conf.botToken) || "未设置"}\n` +
              `推送目标: ${this.escape(conf.pushChatId || "未设置")}\n` +
              `随机延迟: ${conf.randomDelay} 分钟\n` +
              `上次运行: ${this.escape(conf.lastRunDate || "无")}\n` +
              `签到目标: ${enabled}/${conf.targets.length} 个启用`
          );
          return;
        }

        await this.edit(msg, `❌ 未知命令，请使用 ${PREFIX}qd help 查看帮助`);
      } catch (e: any) {
        console.error("[CheckIn] Command error:", e);
        try {
          await this.edit(msg, `❌ 命令执行失败: ${this.escape(e?.message || "未知错误")}`);
        } catch {}
      }
    },
  };

  private async checkAndRun(): Promise<void> {
    if (this.running) return;
    try {
      const conf = this.cfg.get();
      const now = new Date();
      const today = this.dateCN(now);
      const [h, m] = conf.runTime.split(":").map(Number);
      const t = new Date(now.toLocaleString("en-US", { timeZone: SH_TZ }));
      if (conf.lastRunDate === today || t.getHours() !== h || t.getMinutes() !== m) return;
      this.running = true;
      if (conf.randomDelay > 0) await this.sleep(Math.floor(Math.random() * conf.randomDelay * 60_000));
      await this.runAllSigns("自动定时任务");
      this.cfg.save({ lastRunDate: today });
    } catch (e) {
      console.error("[CheckIn] Scheduler error:", e);
    } finally {
      this.running = false;
    }
  }

  private async runAllSigns(source: string, fallbackPeer?: any, statusMsg?: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;
    const conf = this.cfg.get();
    const enabled = conf.targets.filter((t) => t.enabled);
    if (!enabled.length) {
      if (statusMsg) await this.edit(statusMsg, "❌ 没有启用的签到目标");
      return;
    }

    const results: Array<{ target: SignTarget; result: SignResult }> = [];
    for (let i = 0; i < enabled.length; i++) {
      const t = enabled[i];
      const r = await this.runSingleSign(t);
      results.push({ target: t, result: r });
      if (i < enabled.length - 1) await this.sleep(2000);
    }

    const ok = results.filter((x) => x.result.success).length;
    const fail = results.length - ok;
    const lines = results
      .map((x, i) => `${x.result.success ? "✅" : "❌"} <b>${i + 1}. ${this.escape(x.target.name)}</b>\n   ${this.escape(x.result.success ? x.result.message || "成功" : x.result.error || "失败")}`)
      .join("\n");
    const summary = `🤖 <b>CheckIn 签到汇总报告</b>\n时间: ${new Date().toLocaleString("zh-CN", { timeZone: SH_TZ })}\n来源: ${this.escape(source)}\n结果: ${ok} 成功 / ${fail} 失败\n\n${lines}`;

    let sent = false;
    if (conf.botToken && conf.pushChatId) {
      try {
        await this.sendViaBot(conf.botToken, conf.pushChatId, summary);
        sent = true;
      } catch (e) {
        console.error("[CheckIn] Bot push failed:", e);
      }
    }
    if (!sent) {
      const peer = conf.logChat || fallbackPeer;
      if (peer) {
        try {
          await client.sendMessage(peer, { message: summary, parseMode: "html", linkPreview: false });
          sent = true;
        } catch (e) {
          console.error("[CheckIn] Userbot push failed:", e);
        }
      }
    }
    if (statusMsg) {
      try {
        await statusMsg.delete({ revoke: true });
      } catch {}
    }
    if (!sent) console.error("[CheckIn] Failed to send summary report.");
  }

  private async runSingleSign(target: SignTarget): Promise<SignResult> {
    const client = await getGlobalClient();
    if (!client) return { success: false, error: "客户端未初始化" };
    try {
      const sent = await client.sendMessage(target.target, { message: target.command });
      const sentId = Number((sent as any)?.id || 0);
      const start = Math.floor(Date.now() / 1000);

      const first = await this.waitForNewMessage(client, target.target, start, 10_000, (m) => {
        if (m.out) return false;
        if (this.hasMatcher(target)) return !!this.findCallbackButton(m, target);
        return this.isAfterMessage(m, sentId);
      });
      if (!first) return { success: false, error: "未收到签到结果" };

      if (!this.hasMatcher(target)) return { success: true, message: first.message || "签到命令已发送" };
      await this.clickCallbackButton(client, target.target, first, target);

      const second = await this.waitForNewMessage(client, target.target, Math.floor(Date.now() / 1000), 10_000, (m) => !m.out);
      return { success: true, message: second?.message || first.message || "已点击签到按钮" };
    } catch (e: any) {
      return { success: false, error: e?.message || "执行失败" };
    }
  }

  private async waitForNewMessage(
    client: any,
    peer: string,
    minDate: number,
    timeoutMs: number,
    filter?: (m: Api.Message) => boolean
  ): Promise<Api.Message | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await this.sleep(1000);
        const msgs = await client.getMessages(peer, { limit: 8 });
        for (const m of msgs) {
          if (m.date < minDate) continue;
          if (!filter || filter(m)) return m;
        }
      } catch (e) {
        console.error("[CheckIn] Polling error:", e);
      }
    }
    return null;
  }

  private async clickCallbackButton(client: any, peer: string, msg: Api.Message, target: SignTarget): Promise<void> {
    const btn = this.findCallbackButton(msg, target);
    if (!btn) throw new Error(`未找到回调按钮: ${target.callbackData || target.buttonText || target.id}`);
    await client.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer,
        msgId: msg.id,
        data: btn.data || Buffer.from(target.callbackData || "", "utf-8"),
      })
    );
  }

  private findCallbackButton(msg: Api.Message, target: SignTarget): any | null {
    const rows = (msg as any).replyMarkup?.rows || [];
    for (const row of rows) {
      for (const b of row.buttons || []) {
        const d = this.decodeData(b.data);
        if (target.callbackData && d === target.callbackData) return b;
        if (!target.callbackData && target.buttonText && b.text === target.buttonText) return b;
      }
    }
    return null;
  }

  private parseButtonMatcher(args: string[]): Pick<SignTarget, "callbackData" | "buttonText"> {
    const raw = args.join(" ").trim();
    if (!raw) return {};
    if (raw.startsWith("data:")) return { callbackData: raw.slice(5).trim() };
    if (raw.startsWith("text:")) return { buttonText: raw.slice(5).trim() };
    return { callbackData: raw };
  }

  private hasMatcher(t: SignTarget): boolean {
    return !!t.callbackData || !!t.buttonText;
  }

  private helpText(): string {
    return `<b>CheckIn 自动化签到插件</b>

<b>基础指令：</b>
<code>${PREFIX}qd</code> - 手动触发所有签到
<code>${PREFIX}qd reset</code> - 重置今日运行状态
<code>${PREFIX}qd settings</code> - 查看当前配置

<b>目标管理：</b>
<code>${PREFIX}qd add [ID] [名称] [目标] [命令]</code>
<code>${PREFIX}qd add [ID] [名称] [目标] [命令] data:[回调数据]</code>（推荐）
<code>${PREFIX}qd add [ID] [名称] [目标] [命令] text:[按钮名]</code>
<code>${PREFIX}qd del [ID]</code>
<code>${PREFIX}qd list</code>
<code>${PREFIX}qd toggle [ID]</code>
<code>${PREFIX}qd test [ID]</code>

<b>设置：</b>
<code>${PREFIX}qd set time [HH:MM]</code>
<code>${PREFIX}qd set bot [Token] [ChatID]</code>
<code>${PREFIX}qd set delay [分钟]</code>

<b>示例：</b>
<code>${PREFIX}qd add storm Storm签到 @stormuser_bot /start data:checkin</code>`;
  }

  private async edit(msg: Api.Message, text: string): Promise<void> {
    await msg.edit({ text, parseMode: "html", linkPreview: false });
  }

  private sendViaBot(token: string, chatId: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
      const req = https.request(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        },
        (res) => {
          let out = "";
          res.on("data", (c) => (out += c));
          res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error(`API Error: ${out}`))));
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  private decodeData(data: unknown): string {
    if (!data) return "";
    if (Buffer.isBuffer(data)) return data.toString("utf-8");
    if (data instanceof Uint8Array) return Buffer.from(data).toString("utf-8");
    return String(data);
  }

  private isAfterMessage(msg: Api.Message, id: number): boolean {
    return !id || Number((msg as any).id || 0) > id;
  }

  private dateCN(d: Date): string {
    return d.toLocaleDateString("zh-CN", { timeZone: SH_TZ });
  }

  private mask(v: string): string {
    if (!v) return "";
    return v.length <= 5 ? "***" : `${v.slice(0, 5)}...`;
  }

  private escape(s: string): string {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

export default new CheckInPlugin();

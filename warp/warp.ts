import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import axios from "axios";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";

// 简单HTML转义
const htmlEscape = (text: string): string =>
  String(text).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  }[m] || m));

// 配置项
const CONFIG_KEYS = {
  WIREPROXY_PORT: "warp_wireproxy_port",
};

const DEFAULT_CONFIG: Record<string, string> = {
  [CONFIG_KEYS.WIREPROXY_PORT]: "40000",
};

// 配置管理器（先写框架）
class ConfigManager {
  private static db: any = null;
  private static initialized = false;
  private static configPath = path.join(createDirectoryInAssets("warp"), "warp_config.json");

  private static async init(): Promise<void> {
    if (this.initialized) return;
    this.db = await JSONFilePreset<Record<string, any>>(this.configPath, { ...DEFAULT_CONFIG });
    this.initialized = true;
  }

  static async get(key: string, defaultValue?: string): Promise<string> {
    await this.init();
    if (!this.db) return defaultValue || DEFAULT_CONFIG[key] || "";
    const val = this.db.data[key];
    return (typeof val === "undefined" ? defaultValue ?? DEFAULT_CONFIG[key] ?? "" : val);
  }

  static async set(key: string, value: string): Promise<boolean> {
    await this.init();
    if (!this.db) return false;
    this.db.data[key] = value;
    await this.db.write();
    return true;
  }
}

 

// wireproxy 管理（先写框架，再补全最小实现）
class WireproxyManager {
  // 获取或注册免费账户
  static async getOrCreateAccount(): Promise<{ privateKey: string; address6: string }> {
    // 优先读取本地账户文件
    try {
      const { stdout } = await execAsync("sudo bash -lc 'cat /etc/wireguard/warp-account.conf 2>/dev/null' ");
      if (stdout.trim()) {
        const obj = JSON.parse(stdout.trim());
        if (obj.private_key && obj.v6) {
          return { privateKey: String(obj.private_key), address6: String(obj.v6) };
        }
      }
    } catch {}

    // 远程注册免费账户（warp.sh: warp_api register）
    try {
      const url = "https://warp.cloudflare.now.cc/?run=register";
      const res = await axios.get(url, { timeout: 8000 });
      const dataStr = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
      const pkMatch = dataStr.match(/"private_key"\s*:\s*"([A-Za-z0-9+/=]{20,})"/);
      const v6Match = dataStr.match(/"v6"\s*:\s*"([0-9a-fA-F:]+)"/);
      if (!pkMatch || !v6Match) throw new Error("注册返回缺少必要字段");
      const privateKey = pkMatch[1];
      const address6 = v6Match[1];
      // 保存到本地（here-doc，保留换行与缩进）
      const payload = JSON.stringify({ private_key: privateKey, v6: address6 }, null, 2);
      await execAsync(`sudo bash -lc 'mkdir -p /etc/wireguard && cat > /etc/wireguard/warp-account.conf <<"EOF"\n${payload}\nEOF'`);
      return { privateKey, address6 };
    } catch (e: any) {
      throw new Error(`注册免费账户失败: ${e?.message || e}`);
    }
  }
  static async isRunning(): Promise<{ running: boolean; port?: number }> {
    try {
      const [svc, socks] = await Promise.all([
        execAsync("systemctl is-active wireproxy 2>/dev/null || true"),
        execAsync("ss -tlnp | grep -i wireproxy | head -1 || true"),
      ]);
      const active = svc.stdout.trim() === "active";
      const line = socks.stdout.trim();
      const portMatch = line.match(/:(\d+)/);
      const orphan = !active && !!line; // 孤儿进程（非 systemd）
      return { running: active || orphan, port: portMatch ? parseInt(portMatch[1], 10) : undefined };
    } catch {
      return { running: false };
    }
  }

  static async findAvailablePort(start = 40000, end = 50000): Promise<number> {
    for (let p = start; p <= end; p++) {
      try {
        const { stdout } = await execAsync(`ss -tln | grep :${p} || true`);
        if (!stdout.trim()) return p;
      } catch {
        return p;
      }
    }
    return 40000;
  }

  static async setupAndStart(port?: number): Promise<string> {
    try {
      const usePort = port || parseInt(await ConfigManager.get(CONFIG_KEYS.WIREPROXY_PORT, "40000"), 10) || 40000;
      const chosen = usePort || (await this.findAvailablePort());

      // 端口合法性检查
      if (chosen < 1 || chosen > 65535 || isNaN(chosen)) {
        return `❌ 无效端口: ${chosen}`;
      }

      await ConfigManager.set(CONFIG_KEYS.WIREPROXY_PORT, String(chosen));

      // 检查是否已安装
      try {
        await execAsync("wireproxy --version 2>/dev/null");
        console.log("[warp] wireproxy 已存在，跳过下载");
      } catch {
        // 下载 wireproxy（支持更多架构）
        const { stdout: arch } = await execAsync("uname -m");
        const raw = arch.trim();
        let archName = "amd64";
        if (raw === "aarch64" || raw === "arm64") archName = "arm64";
        else if (raw === "x86_64") archName = "amd64";
        else if (raw === "armv7l" || raw === "armhf") archName = "arm";
        else if (raw === "i386" || raw === "i686") archName = "386";
        else throw new Error(`不支持的架构: ${raw}`);

        const version = "1.0.9";
        const url = `https://github.com/pufferffish/wireproxy/releases/download/v${version}/wireproxy_linux_${archName}.tar.gz`;
        
        // 添加超时和重试
        const downloadCmd = `wget -T 30 -q -O /tmp/wireproxy.tar.gz ${url} || curl -L --connect-timeout 30 -s -o /tmp/wireproxy.tar.gz ${url}`;
        await execAsync(`sudo bash -lc 'rm -f /tmp/wireproxy.tar.gz && ${downloadCmd} && tar xzf /tmp/wireproxy.tar.gz -C /tmp/ && mv /tmp/wireproxy /usr/bin/wireproxy && chmod +x /usr/bin/wireproxy'`);
      }

      // 注册/读取免费账户
      const account = await this.getOrCreateAccount();
      const address4 = "172.16.0.2/32"; // 与脚本保持一致的本地 v4 地址
      const address6 = `${account.address6}/128`;
      const dnsList = "1.1.1.1,8.8.8.8,8.8.4.4,2606:4700:4700::1111,2001:4860:4860::8888,2001:4860:4860::8844";

      // 写配置
      const cfg = `\n[Interface]\nPrivateKey = ${account.privateKey}\nAddress = ${address4}\nAddress = ${address6}\nDNS = ${dnsList}\nMTU = 1280\n\n[Peer]\nPublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = engage.cloudflareclient.com:2408\n\n[Socks5]\nBindAddress = 127.0.0.1:${chosen}\n`;
      await execAsync("sudo mkdir -p /etc/wireguard");
      await execAsync(`sudo bash -lc 'cat > /etc/wireguard/proxy.conf <<"EOF"\n${cfg.trim()}\nEOF'`);

      // systemd
      const svc = `\n[Unit]\nDescription=WireProxy for WARP\nAfter=network.target\nDocumentation=https://github.com/fscarmen/warp-sh\nDocumentation=https://github.com/pufferffish/wireproxy\n\n[Service]\nExecStart=/usr/bin/wireproxy -c /etc/wireguard/proxy.conf\nRemainAfterExit=yes\nRestart=always\n\n[Install]\nWantedBy=multi-user.target\n`;
      await execAsync(`sudo bash -lc 'cat > /lib/systemd/system/wireproxy.service <<"EOF"\n${svc.trim()}\nEOF'`);
      await execAsync("sudo systemctl daemon-reload && sudo systemctl enable wireproxy && sudo systemctl restart wireproxy");

      return `✅ wireproxy 已启动，Socks5: 127.0.0.1:${chosen}`;
    } catch (e: any) {
      return `❌ wireproxy 启动失败: ${htmlEscape(e?.message || e)}`;
    }
  }

  static async stop(): Promise<string> {
    try {
      await execAsync("sudo systemctl stop wireproxy || true");
      await execAsync("sudo systemctl disable wireproxy || true");
      return "✅ wireproxy 已停止";
    } catch (e: any) {
      return `❌ wireproxy 停止失败: ${htmlEscape(e?.message || e)}`;
    }
  }

  static async restart(): Promise<string> {
    try {
      await execAsync("sudo systemctl restart wireproxy");
      return "✅ wireproxy 已重启";
    } catch (e: any) {
      return `❌ 重启失败: ${htmlEscape(e?.message || e)}`;
    }
  }

  static async setPort(port: number): Promise<string> {
    if (!Number.isFinite(port) || port < 1 || port > 65535) return "❌ 端口无效";
    try {
      await execAsync(`sudo bash -lc "sed -i 's/BindAddress.*/BindAddress = 127.0.0.1:${port}/g' /etc/wireguard/proxy.conf"`);
      await ConfigManager.set(CONFIG_KEYS.WIREPROXY_PORT, String(port));
      await execAsync("sudo systemctl restart wireproxy");
      return `✅ 端口已更新并重启: ${port}`;
    } catch (e: any) {
      return `❌ 更新端口失败: ${htmlEscape(e?.message || e)}`;
    }
  }

  static async uninstall(): Promise<string> {
    try {
      // 停止并禁用服务
      try { await execAsync("sudo systemctl disable --now wireproxy"); } catch {}

      // 强制杀死遗留进程（分步执行避免复杂逻辑报错）
      try { await execAsync("sudo pkill -9 wireproxy"); } catch {}
      try { await execAsync("sudo pkill -9 -f '/usr/bin/wireproxy'"); } catch {}
      try { await execAsync("sudo pkill -9 -f 'wireproxy -c'"); } catch {}

      // 清理 service 与二进制、配置
      try { await execAsync("sudo rm -f /etc/systemd/system/wireproxy.service /lib/systemd/system/wireproxy.service"); } catch {}
      try { await execAsync("sudo rm -f /etc/wireguard/proxy.conf"); } catch {}
      try { await execAsync("sudo rm -f /usr/bin/wireproxy"); } catch {}
      try { await execAsync("sudo systemctl daemon-reload"); } catch {}

      // 校验
      const [svc, procs] = await Promise.all([
        execAsync("systemctl is-active wireproxy 2>/dev/null || echo inactive"),
        execAsync("pgrep -fa wireproxy 2>/dev/null || echo '(无进程)'"),
      ]);
      const stillActive = svc.stdout.trim() === "active" || (procs.stdout.trim() && !procs.stdout.includes("(无进程)"));
      return stillActive ? "⚠️ 尝试卸载完成，但仍检测到进程，请重试或手动清理" : "✅ wireproxy 已卸载";
    } catch (e: any) {
      return `❌ 卸载失败: ${htmlEscape(e?.message || e)}`;
    }
  }
}

// 帮助文本
const helpText = `⚡ <b>WARP WireProxy 管理</b>

<code>${mainPrefix}warp help</code> - 显示帮助
<code>${mainPrefix}warp status</code> - 查看 wireproxy 状态

<b>wireproxy（Socks5 代理）</b>
<code>${mainPrefix}warp start [端口]</code> - 安装并启动（默认端口 40000，默认免费账户）
<code>${mainPrefix}warp stop</code> - 停止并禁用 wireproxy
<code>${mainPrefix}warp restart</code> - 重启 wireproxy（用于换 IP）
<code>${mainPrefix}warp port &lt;端口&gt;</code> - 修改监听端口并重启
<code>${mainPrefix}warp uninstall</code> - 卸载 wireproxy 与配置文件
<code>${mainPrefix}warp ip</code> - 换 IP（等价于 restart）`;

// 插件实现
class WarpPlugin extends Plugin {
  description: string = `Cloudflare WARP 管理\n\n${helpText}`;

  cmdHandlers = {
    warp: async (msg: Api.Message) => {
      await this.handleWarp(msg);
    },
  };

  // 子命令帮助
  private async showSubCommandHelp(subCmd: string, msg: Api.Message): Promise<void> {
    const cmd = `${mainPrefix}warp`;
    let text = "";
    switch (subCmd) {
      case "status":
        text = `📖 <b>状态查询</b>\n\n<code>${cmd} status</code> - 查看 wireproxy 运行状态`;
        break;
      case "start":
        text = `📖 <b>启动</b>\n\n<code>${cmd} start [端口]</code> - 安装/更新 wireproxy，生成配置并启动（默认端口 40000）`;
        break;
      case "stop":
        text = `📖 <b>停止</b>\n\n<code>${cmd} stop</code> - 停止并禁用 wireproxy`;
        break;
      case "restart":
        text = `📖 <b>重启</b>\n\n<code>${cmd} restart</code> - 重启 wireproxy（用于换 IP）`;
        break;
      case "port":
        text = `📖 <b>端口</b>\n\n<code>${cmd} port &lt;端口&gt;</code> - 修改监听端口并重启`;
        break;
      case "uninstall":
        text = `📖 <b>卸载</b>\n\n<code>${cmd} uninstall</code> - 卸载 wireproxy 与配置文件`;
        break;
      case "ip":
        text = `📖 <b>换 IP</b>\n\n<code>${cmd} ip</code> - 重启 wireproxy 以更换 IP`;
        break;
      default:
        text = helpText;
        break;
    }
    await msg.edit({ text, parseMode: "html" });
  }

  // 解析参数（遵循规范）
  private parseArgs(text?: string): string[] {
    const line = (text || "").trim().split(/\r?\n/g)[0] || "";
    const parts = line.split(/\s+/g);
    return parts.slice(1).map((s) => s.trim()).filter(Boolean);
  }

  // 主处理
  private async handleWarp(msg: Api.Message): Promise<void> {
    // 标准参数解析
    const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
    const parts = lines?.[0]?.split(/\s+/g) || [];
    const [, ...args] = parts;
    const sub = (args[0] || "").toLowerCase();

    try {
      // 无参数：显示帮助
      if (!sub) {
        await msg.edit({ text: helpText, parseMode: "html" });
        return;
      }

      // help 在前：.warp help [sub]
      if (sub === "help" || sub === "h") {
        if (args[1]) {
          await this.showSubCommandHelp(args[1].toLowerCase(), msg);
        } else {
          await msg.edit({ text: helpText, parseMode: "html" });
        }
        return;
      }

      // help 在后：.warp [sub] help
      if (args[1] && (args[1].toLowerCase() === "help" || args[1].toLowerCase() === "h")) {
        await this.showSubCommandHelp(sub, msg);
        return;
      }

      switch (sub) {
        case "help":
        case "h":
        case "status": {
          await msg.edit({ text: "🔄 正在获取状态...", parseMode: "html" });
          const wpStatus = await WireproxyManager.isRunning();
          const text = wpStatus.running
            ? `📊 <b>wireproxy 状态</b>\n\n✅ 运行中${wpStatus.port ? `，端口: ${wpStatus.port}` : ""}`
            : "📊 <b>wireproxy 状态</b>\n\n❌ 未运行";
          await msg.edit({ text, parseMode: "html" });
          return;
        }
        case "start": {
          const port = args[1] ? parseInt(args[1], 10) : undefined;
          await msg.edit({ text: "🔄 正在启动 wireproxy...", parseMode: "html" });
          const ret = await WireproxyManager.setupAndStart(port);
          await msg.edit({ text: ret, parseMode: "html" });
          return;
        }
        case "stop": {
          await msg.edit({ text: "🔄 正在停止 wireproxy...", parseMode: "html" });
          const ret = await WireproxyManager.stop();
          await msg.edit({ text: ret, parseMode: "html" });
          return;
        }
        case "restart": {
          await msg.edit({ text: "🔄 正在重启 wireproxy...", parseMode: "html" });
          const ret = await WireproxyManager.restart();
          await msg.edit({ text: ret, parseMode: "html" });
          return;
        }
        case "port": {
          const p = parseInt(args[1] || "", 10);
          if (!p) {
            await msg.edit({ text: `❌ 请提供端口号\n\n用法：<code>${mainPrefix}warp port 40000</code>`, parseMode: "html" });
            return;
          }
          await msg.edit({ text: `🔄 正在修改端口为 ${p}...`, parseMode: "html" });
          const ret = await WireproxyManager.setPort(p);
          await msg.edit({ text: ret, parseMode: "html" });
          return;
        }
        case "uninstall": {
          await msg.edit({ text: "⚠️ 正在卸载 wireproxy...", parseMode: "html" });
          const ret = await WireproxyManager.uninstall();
          await msg.edit({ text: ret, parseMode: "html" });
          return;
        }
        case "ip": {
          await msg.edit({ text: "🔄 正在更换 IP（重启 wireproxy）...", parseMode: "html" });
          const ret = await WireproxyManager.restart();
          await msg.edit({ text: ret, parseMode: "html" });
          return;
        }

        default:
          await msg.edit({ text: helpText, parseMode: "html" });
      }
    } catch (err: any) {
      await msg.edit({ text: `❌ 执行失败: ${htmlEscape(err?.message || err)}` , parseMode: "html"});
    }
  }
}

export default new WarpPlugin();

// 插件系统
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";

// Telegram API
import { Api } from "teleproto";

// 内置依赖库
import axios from "axios";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";
// 命令执行统一封装
class SystemExecutor {
   static async run(cmd: string): Promise<{ success: boolean; output: string; error?: string }> {
     try {
       const { stdout, stderr } = await execAsync(cmd);
       return { success: true, output: String(stdout ?? "").trim(), error: String(stderr ?? "").trim() };
     } catch (e: any) {
       return {
         success: false,
         output: String(e?.stdout ?? "").trim(),
         error: String(e?.stderr ?? e?.message ?? e ?? "").trim(),
       };
     }
   }

   static async runSudo(cmd: string): Promise<{ success: boolean; output: string; error?: string }> {
     return this.run(`sudo ${cmd}`);
   }
 }

// HTML转义（每个插件必须实现）
const htmlEscape = (text: string): string =>
  String(text).replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 常量配置
const DEFAULT_PORT = 40000;
const WARP_CONFIG_FILE = "/etc/wireguard/warp-account.conf";
const WIREPROXY_CONFIG_FILE = "/etc/wireguard/proxy.conf";
const WIREPROXY_SERVICE_FILE = "/lib/systemd/system/wireproxy.service";
const WIREPROXY_BINARY = "/usr/bin/wireproxy";

// 账户管理
class AccountManager {
  static async getOrCreate(): Promise<{ privateKey: string; address6: string }> {
    // 尝试读取本地账户
    const localAccount = await this.readLocal();
    if (localAccount) return localAccount;
    
    // 注册新账户
    return await this.register();
  }

  private static async readLocal(): Promise<{ privateKey: string; address6: string } | null> {
    const result = await SystemExecutor.runSudo(`cat ${WARP_CONFIG_FILE}`);
    if (!result.success || !result.output) return null;
    
    try {
      const data = JSON.parse(result.output);
      if (data.private_key && data.v6) {
        return { privateKey: data.private_key, address6: data.v6 };
      }
    } catch {}
    return null;
  }

  private static async register(): Promise<{ privateKey: string; address6: string }> {
    try {
      const response = await axios.get("https://warp.cloudflare.now.cc/?run=register", { timeout: 8000 });
      const dataStr = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
      
      const pkMatch = dataStr.match(/"private_key"\s*:\s*"([A-Za-z0-9+/=]{20,})"/); 
      const v6Match = dataStr.match(/"v6"\s*:\s*"([0-9a-fA-F:]+)"/); 
      
      if (!pkMatch || !v6Match) {
        throw new Error("注册响应格式错误");
      }
      
      const privateKey = pkMatch[1];
      const address6 = v6Match[1];
      const accountData = JSON.stringify({ type: "free", private_key: privateKey, v6: address6 }, null, 2);
      
      await SystemExecutor.runSudo(`mkdir -p /etc/wireguard`);
      await execAsync(`sudo bash -lc 'cat > ${WARP_CONFIG_FILE} <<"EOF"\n${accountData}\nEOF'`);
      
      return { privateKey, address6 };
    } catch (error: any) {
      throw new Error(`账户注册失败: ${error.message}`);
    }
  }
}


// wireproxy 管理
class WireproxyManager {
  private static async _getOrCreateAccount(): Promise<{ privateKey: string; address6: string }> {
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

    // 远程注册免费账户
    try {
      const url = "https://warp.cloudflare.now.cc/?run=register";
      const res = await axios.get(url, { timeout: 8000 });
      const dataStr = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
      const pkMatch = dataStr.match(/"private_key"\s*:\s*"([A-Za-z0-9+/=]{20,})"/);
      const v6Match = dataStr.match(/"v6"\s*:\s*"([0-9a-fA-F:]+)"/);
      if (!pkMatch || !v6Match) throw new Error("注册返回缺少必要字段");
      const privateKey = pkMatch[1];
      const address6 = v6Match[1];
      const payload = JSON.stringify({ type: "free", private_key: privateKey, v6: address6 }, null, 2);
      await execAsync(`sudo bash -lc 'mkdir -p /etc/wireguard && cat > /etc/wireguard/warp-account.conf <<"EOF"\n${payload}\nEOF'`);
      return { privateKey, address6 };
    } catch (e: any) {
      throw new Error(`注册免费账户失败: ${e?.message || e}`);
    }
  }

  static async getStatus(): Promise<string> {
    try {
      const [svc, socks, cfg, bin, acc, dns, ipt, ips, kmod] = await Promise.all([
        SystemExecutor.run("systemctl is-active wireproxy"),
        SystemExecutor.run("ss -tlnp | grep -i wireproxy | head -1"),
        SystemExecutor.run(`test -f ${WIREPROXY_CONFIG_FILE}`),
        SystemExecutor.run(`test -f ${WIREPROXY_BINARY}`),
        SystemExecutor.run(`test -f ${WARP_CONFIG_FILE}`),
        SystemExecutor.run("systemctl is-active dnsmasq"),
        SystemExecutor.run("command -v iptables"),
        SystemExecutor.run("command -v ipset"),
        SystemExecutor.run("lsmod | grep -w wireguard"),
      ]);

      const svcStatus = svc.success ? svc.output : "inactive";
      const portMatch = socks.success ? socks.output.match(/:(\d+)\b/) : null;
      const port = portMatch ? parseInt(portMatch[1], 10) : 0;

      // 检查代理配置状态
      let proxyInfo = "";
      if (svcStatus === "active" && port) {
        const pwdResult = await SystemExecutor.run("pwd");
        if (pwdResult.success) {
          const programDir = pwdResult.output.trim();
          let tgProxyStatus = "❌ 未配置";
          let musicProxyStatus = "❌ 未配置";

          // 检查 Telegram 代理
          const tgConfigPath = `${programDir}/config.json`;
          const tgConfigCheck = await SystemExecutor.run(`test -f ${tgConfigPath}`);
          if (tgConfigCheck.success) {
            const readResult = await SystemExecutor.run(`cat ${tgConfigPath}`);
            if (readResult.success) {
              try {
                const config = JSON.parse(readResult.output);
                if (config.proxy && config.proxy.port === port) {
                  tgProxyStatus = `✅ 已配置 (端口: ${port})`;
                }
              } catch {
                tgProxyStatus = "❓ 配置文件解析失败";
              }
            }
          }

          // 检查 Music 代理
          const musicConfigPath = `${programDir}/assets/music/music_config.json`;
          const musicConfigCheck = await SystemExecutor.run(`test -f ${musicConfigPath}`);
          if (musicConfigCheck.success) {
            const readResult = await SystemExecutor.run(`cat ${musicConfigPath}`);
            if (readResult.success) {
              try {
                const musicConfig = JSON.parse(readResult.output);
                const musicProxy = musicConfig["music_ytdlp_proxy"];
                if (musicProxy && musicProxy.includes(`:${port}`)) {
                  musicProxyStatus = `✅ 已配置 (端口: ${port})`;
                }
              } catch {
                musicProxyStatus = "❓ 配置文件解析失败";
              }
            }
          }
          
          proxyInfo = `\n<b>代理状态</b>\n- Telegram 代理: ${tgProxyStatus}\n- Music 代理: ${musicProxyStatus}`;
        }
      }

      let wireproxyStatusLine = "";
      if (svcStatus === "active") {
        wireproxyStatusLine = `WireProxy: ✅ 运行中${port ? ` (端口: ${port})` : ""}`;
      } else if (bin.success) {
        wireproxyStatusLine = "WireProxy: ⚠️ 已安装但未运行";
      } else {
        wireproxyStatusLine = "WireProxy: ❌ 未安装";
      }

      const text = `📊 <b>WARP 综合状态</b>\n\n<b>WireProxy</b>\n- ${wireproxyStatusLine}\n- 配置文件: ${cfg.success ? "存在" : "不存在"}\n- 可执行文件: ${bin.success ? "存在" : "不存在"}\n- 账户文件: ${acc.success ? "存在" : "不存在"}${proxyInfo}\n\n<b>Iptables 方案</b>\n- dnsmasq: ${dns.success && dns.output === "active" ? "✅ 运行中" : "❌ 未运行"}\n- iptables: ${ipt.success ? "✅ 已安装" : "❌ 未安装"}\n- ipset: ${ips.success ? "✅ 已安装" : "❌ 未安装"}\n\n<b>内核</b>\n- WireGuard 模块: ${kmod.success ? "✅ 已加载" : "⚠️ 未加载"}`;

      return text;
    } catch (e: any) {
      return `❌ 查询状态失败: ${htmlEscape(e?.message || e)}`;
    }
  }

  private static async _getCurrentIpInfo(port: number): Promise<{ ipv4: string; ipv6: string }> {
    const fetchIp = async (version: 4 | 6): Promise<string> => {
      const maxRetries = 5;
      const retryDelay = 2000; // 2 seconds
      for (let i = 0; i < maxRetries; i++) {
        const cmd = `curl -${version} --socks5-hostname 127.0.0.1:${port} -s -m 8 ip.gs/json`;
        const result = await SystemExecutor.run(cmd);
        if (result.success && result.output.includes('"ip"')) {
          try {
            const data = JSON.parse(result.output);
            return `${data.ip} ${data.country} ${data.organisation}`.trim();
          } catch {
            // JSON parsing failed, continue to retry
          }
        }
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
      return "查询失败 (多次尝试后)";
    };

    const [ipv4, ipv6] = await Promise.all([fetchIp(4), fetchIp(6)]);
    return { ipv4, ipv6 };
  }

  private static async findAvailablePort(start = DEFAULT_PORT, end = 50000): Promise<number> {
    for (let port = start; port <= end; port++) {
      const result = await SystemExecutor.run(`ss -tln | grep :${port}`);
      if (!result.success || !result.output) return port;
    }
    return DEFAULT_PORT;
  }

  private static async installBinary(): Promise<void> {
    const archResult = await SystemExecutor.run("uname -m");
    const arch = archResult.output;
    
    let archName = "amd64";
    if (arch === "aarch64" || arch === "arm64") archName = "arm64";
    else if (arch === "x86_64") archName = "amd64";
    else if (arch === "armv7l" || arch === "armhf") archName = "arm";
    else if (arch === "i386" || arch === "i686") archName = "386";
    else throw new Error(`不支持的架构: ${arch}`);

    const version = "1.0.9";
    const url = `https://github.com/pufferffish/wireproxy/releases/download/v${version}/wireproxy_linux_${archName}.tar.gz`;
    
    const downloadCmd = `wget -T 30 -q -O /tmp/wireproxy.tar.gz ${url} || curl -L --connect-timeout 30 -s -o /tmp/wireproxy.tar.gz ${url}`;
    const installCmd = `rm -f /tmp/wireproxy.tar.gz && ${downloadCmd} && tar xzf /tmp/wireproxy.tar.gz -C /tmp/ && mv /tmp/wireproxy ${WIREPROXY_BINARY} && chmod +x ${WIREPROXY_BINARY}`;
    
    const result = await SystemExecutor.runSudo(installCmd);
    if (!result.success) {
      throw new Error(`安装失败: ${result.error}`);
    }
  }

  static async setupAndStart(port?: number): Promise<string> {
    try {
      const targetPort = port || (await this.findAvailablePort());
      
      if (targetPort < 1 || targetPort > 65535 || isNaN(targetPort)) {
        return `❌ 无效端口: ${targetPort}`;
      }

      // 检查并安装二进制文件
      const binCheck = await SystemExecutor.run(`test -f ${WIREPROXY_BINARY} && echo exists || echo missing`);
      if (binCheck.output.trim() !== "exists") {
        await this.installBinary();
      }

      // 获取账户信息
      const account = await AccountManager.getOrCreate();
      
      // 生成配置文件
      const config = this.generateConfig(account, targetPort);
      await execAsync(`sudo bash -lc 'cat > ${WIREPROXY_CONFIG_FILE} <<"EOF"\n${config}\nEOF'`);

      // 创建系统服务
      const service = this.generateService();
      await execAsync(`sudo bash -lc 'cat > ${WIREPROXY_SERVICE_FILE} <<"EOF"\n${service}\nEOF'`);

      // 启动服务
      const startResult = await SystemExecutor.runSudo("systemctl daemon-reload && systemctl enable wireproxy && systemctl restart wireproxy");
      if (!startResult.success) {
        throw new Error(`服务启动失败: ${startResult.error}`);
      }

      return `✅ WireProxy 已启动，SOCKS5 代理: 127.0.0.1:${targetPort}`;
    } catch (error: any) {
      return `❌ 启动失败: ${htmlEscape(error.message)}`;
    }
  }

  private static generateConfig(account: { privateKey: string; address6: string }, port: number): string {
    const address4 = "172.16.0.2/32";
    const address6 = `${account.address6}/128`;
    const dns = "1.1.1.1,8.8.8.8,8.8.4.4,2606:4700:4700::1111,2001:4860:4860::8888,2001:4860:4860::8844";
    
    return `[Interface]
PrivateKey = ${account.privateKey}
Address = ${address4}
Address = ${address6}
DNS = ${dns}
MTU = 1280

[Peer]
PublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = engage.cloudflareclient.com:2408
PersistentKeepalive = 25

[Socks5]
BindAddress = 127.0.0.1:${port}`;
  }

  private static generateService(): string {
    return `[Unit]
Description=WireProxy for WARP
Wants=network-online.target
After=network-online.target
Documentation=https://github.com/fscarmen/warp-sh
Documentation=https://github.com/pufferffish/wireproxy

[Service]
ExecStart=${WIREPROXY_BINARY} -c ${WIREPROXY_CONFIG_FILE}
RemainAfterExit=yes
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target`;
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
    const binCheck = await SystemExecutor.run(`test -f ${WIREPROXY_BINARY}`);
    if (!binCheck.success) {
      return `❌ WireProxy 未安装，无法重启。请先使用 <code>${mainPrefix}warp w</code> 安装。`;
    }

    try {
      const restartResult = await SystemExecutor.runSudo("systemctl restart wireproxy");
      if (!restartResult.success) {
        if (restartResult.error?.includes("not found")) {
          return `❌ WireProxy 服务未找到。可能安装不完整，请尝试重新安装: <code>${mainPrefix}warp w</code>`;
        }
        throw new Error(restartResult.error);
      }


      return "✅ WireProxy 已重启，IP 已更换";
    } catch (e: any) {
      return `❌ 重启失败: ${htmlEscape(e?.message || e)}`;
    }
  }

  static async setPort(port: number): Promise<string> {
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return "❌ 端口无效";
    }
    
    try {
      const updateResult = await SystemExecutor.runSudo(`sed -i 's/BindAddress.*/BindAddress = 127.0.0.1:${port}/g' ${WIREPROXY_CONFIG_FILE}`);
      if (!updateResult.success) {
        throw new Error(`配置更新失败: ${updateResult.error}`);
      }
      
      const restartResult = await SystemExecutor.runSudo("systemctl restart wireproxy");
      if (!restartResult.success) {
        throw new Error(`服务重启失败: ${restartResult.error}`);
      }
      
      return `✅ 端口已更新为 ${port} 并重启服务`;
    } catch (error: any) {
      return `❌ 端口更新失败: ${htmlEscape(error.message)}`;
    }
  }

  static async uninstall(): Promise<string> {
    try {
      // 第一步：停止所有服务（忽略错误）
      await SystemExecutor.runSudo("systemctl stop wireproxy 2>/dev/null || true");
      await SystemExecutor.runSudo("systemctl stop dnsmasq 2>/dev/null || true");
      await SystemExecutor.runSudo("wg-quick down warp 2>/dev/null || true");
      
      // 第二步：禁用服务（忽略错误）
      await SystemExecutor.runSudo("systemctl disable wireproxy 2>/dev/null || true");
      await SystemExecutor.runSudo("systemctl disable dnsmasq 2>/dev/null || true");
      await SystemExecutor.runSudo("systemctl disable wg-quick@warp 2>/dev/null || true");

      // 第三步：强制终止进程（等待一秒让进程完全退出）
      await SystemExecutor.runSudo("pkill -9 wireproxy 2>/dev/null || true");
      await SystemExecutor.runSudo("pkill -9 dnsmasq 2>/dev/null || true");
      await SystemExecutor.runSudo("pkill -9 -f 'wg-quick' 2>/dev/null || true");
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 第四步：清理网络配置
      await SystemExecutor.runSudo("chattr -i /etc/resolv.conf 2>/dev/null || true");
      await SystemExecutor.runSudo("[ -f /etc/resolv.conf.bak ] && mv /etc/resolv.conf.bak /etc/resolv.conf 2>/dev/null || true");
      await SystemExecutor.runSudo("iptables -F 2>/dev/null || true");
      await SystemExecutor.runSudo("iptables -X 2>/dev/null || true");
      await SystemExecutor.runSudo("ipset flush warp 2>/dev/null || true");
      await SystemExecutor.runSudo("ipset destroy warp 2>/dev/null || true");

      // 第五步：删除服务文件
      await SystemExecutor.runSudo("rm -f /etc/systemd/system/wireproxy.service 2>/dev/null || true");
      await SystemExecutor.runSudo("rm -f /lib/systemd/system/wireproxy.service 2>/dev/null || true");
      await SystemExecutor.runSudo("rm -f /etc/systemd/system/dnsmasq.service 2>/dev/null || true");
      await SystemExecutor.runSudo("systemctl daemon-reload 2>/dev/null || true");

      // 第六步：删除二进制文件和配置目录
      await SystemExecutor.runSudo("rm -f /usr/bin/wireproxy 2>/dev/null || true");
      await SystemExecutor.runSudo("rm -rf /etc/wireguard 2>/dev/null || true");
      
      // 第七步：尝试卸载软件包（忽略所有错误）
      await SystemExecutor.runSudo("apt-get remove -y --purge dnsmasq ipset wireguard-tools 2>/dev/null || yum remove -y dnsmasq ipset wireguard-tools 2>/dev/null || true");
      await SystemExecutor.runSudo("apt-get autoremove -y 2>/dev/null || true");

      // 等待文件系统同步
      await new Promise(resolve => setTimeout(resolve, 500));

      // 最终校验（更宽松的检查）
      const [wpSvc, dnsSvc, wgDir, wpBin] = await Promise.all([
        SystemExecutor.run("systemctl is-active wireproxy 2>/dev/null"),
        SystemExecutor.run("systemctl is-active dnsmasq 2>/dev/null"),
        SystemExecutor.run("[ -d /etc/wireguard ] && echo 'exists' || echo 'deleted'"),
        SystemExecutor.run("[ -f /usr/bin/wireproxy ] && echo 'exists' || echo 'deleted'"),
      ]);
      
      // 只有在关键组件仍然存在时才报告残留
      const criticalRemains = wpSvc.output === "active" || wgDir.output === 'exists' || wpBin.output === 'exists';
      
      if (criticalRemains) {
        return "⚠️ 卸载完成，但检测到部分关键文件残留。建议重启系统后重试，或手动删除 /etc/wireguard 目录。";
      } else {
        return "✅ 所有 WARP 相关组件已彻底卸载。";
      }
    } catch (e: any) {
      return `❌ 卸载过程中出现错误: ${htmlEscape(e?.message || e)}。建议重启后重试。`;
    }
  }
}

// 帮助文本
const helpText = `⚡ <b>WARP 管理面板</b>


<b>主要方案 (二选一)</b>
  <b>1. WireProxy (Socks5 代理)</b>
    <code>${mainPrefix}warp w [端口]</code> - 安装并启动 (与 Iptables 方案互斥)

  <b>2. Iptables (透明代理)</b>
    <code>${mainPrefix}warp e</code> - 安装 Iptables + dnsmasq + ipset (与 WireProxy 方案互斥)

<b>辅助命令</b>
<code>${mainPrefix}warp status</code> - 查看 WARP 综合状态
<code>${mainPrefix}warp y</code> - 切换 WireProxy 开/关
<code>${mainPrefix}warp ip</code> - 重启 WireProxy (更换 WARP IP)
<code>${mainPrefix}warp port &lt;端口&gt;</code> - 修改 WireProxy 监听端口
<code>${mainPrefix}warp proxy</code> - 配置 Telegram 代理设置 (需要 WireProxy 运行)
<code>${mainPrefix}warp unproxy</code> - 关闭 Telegram 代理设置
<code>${mainPrefix}warp music</code> - 配置 Music 插件代理设置
<code>${mainPrefix}warp unmusic</code> - 关闭 Music 插件代理设置

<b>系统</b>
<code>${mainPrefix}warp uninstall</code> - 仅卸载 WireProxy
<code>${mainPrefix}warp uninstall_all</code> - 卸载所有组件 (WireProxy 和 Iptables 方案)`;

// 插件实现
class WarpPlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

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
        text = `📖 <b>状态查询</b>\n\n<code>${cmd} status</code> - 查看 WARP 综合状态 (WireProxy、账户文件、iptables 方案、WireGuard 模块)`;
        break;
      case "w":
        text = `📖 <b>启动</b>\n\n<code>${cmd} w [端口]</code> - 安装/更新 wireproxy 并启动`;
        break;
      case "stop":
        text = `📖 <b>停止</b>\n\n<code>${cmd} stop</code> - 停止并禁用 wireproxy`;
        break;
      case "ip":
        text = `📖 <b>重启/换IP</b>\n\n<code>${cmd} ip</code> - 重启 wireproxy 以更换 IP`;
        break;
      case "port":
        text = `📖 <b>端口</b>\n\n<code>${cmd} port &lt;端口&gt;</code> - 修改监听端口并重启`;
        break;
      case "uninstall":
      case "uninstall_all":
        text = `📖 <b>卸载</b>\n\n<code>${cmd} uninstall</code> - 仅卸载 WireProxy 方案\n<code>${cmd} uninstall_all</code> - 彻底卸载所有 WARP 相关组件`;
        break;
      case "y":
        text = `📖 <b>WireProxy 开关</b>\n\n<code>${cmd} y</code> - 连接或断开 WireProxy socks5`;
        break;
      case "e":
        text = `📖 <b>Iptables 方案</b>\n\n<code>${cmd} e</code> - 安装 Iptables 透明代理方案 (与 WireProxy 互斥)`;
        break;
      case "proxy":
        text = `📖 <b>代理设置</b>\n\n<code>${cmd} proxy</code> - 配置 Telegram 使用 WireProxy 代理 (默认端口 40000)`;
        break;
      case "unproxy":
        text = `📖 <b>关闭代理</b>\n\n<code>${cmd} unproxy</code> - 从 config.json 中移除 Telegram 代理配置`;
        break;
      case "music":
        text = `📖 <b>Music 代理</b>\n\n<code>${cmd} music</code> - 配置 Music 插件使用 WireProxy 代理 (需要 WireProxy 运行)`;
        break;
      case "unmusic":
        text = `📖 <b>关闭 Music 代理</b>\n\n<code>${cmd} unmusic</code> - 从 Music 配置中移除代理设置`;
        break;
      default:
        text = helpText;
        break;
    }
    await msg.edit({ text, parseMode: "html" });
  }

  // 配置代理设置
  private async configureProxy(): Promise<string> {
    try {
      // 检查 WireProxy 是否运行
      const svcCheck = await SystemExecutor.run("systemctl is-active wireproxy");
      if (!svcCheck.success || svcCheck.output !== "active") {
        return "❌ WireProxy 未运行。请先使用 <code>${mainPrefix}warp w</code> 启动 WireProxy。";
      }

      // 获取当前端口
      const socksCheck = await SystemExecutor.run("ss -tlnp | grep -i wireproxy | head -1");
      const portMatch = socksCheck.success ? socksCheck.output.match(/:(\d+)\b/) : null;
      const port = portMatch ? parseInt(portMatch[1], 10) : 40000;

      // 获取程序目录并构建配置文件路径
      const pwdResult = await SystemExecutor.run("pwd");
      if (!pwdResult.success) {
        return "❌ 无法获取当前工作目录。";
      }
      
      const programDir = pwdResult.output.trim();
      const configPath = `${programDir}/config.json`;
      
      // 检查配置文件是否存在
      const configCheck = await SystemExecutor.run(`test -f ${configPath}`);
      if (!configCheck.success) {
        return `❌ 找不到配置文件: ${configPath}`;
      }

      // 读取配置文件
      const readResult = await SystemExecutor.run(`cat ${configPath}`);
      if (!readResult.success) {
        return "❌ 无法读取 config.json 文件。";
      }

      let config;
      try {
        config = JSON.parse(readResult.output);
      } catch {
        return "❌ config.json 文件格式错误。";
      }

      // 设置代理配置
      config.proxy = {
        ip: "127.0.0.1",
        port: port,
        socksType: 5
      };

      // 写回配置文件
      const configJson = JSON.stringify(config, null, 2);
      const writeCmd = `cat > ${configPath} << 'EOF'\n${configJson}\nEOF`;
      const writeResult = await SystemExecutor.runSudo(writeCmd);
      
      if (!writeResult.success) {
        return "❌ 无法写入配置文件。";
      }

      return `✅ 代理配置已更新\n\n📋 <b>配置详情</b>\n- 代理类型: SOCKS5\n- 地址: 127.0.0.1\n- 端口: ${port}\n\n⚠️ <b>注意</b>: 需要重启 TeleBox 生效`;
    } catch (e: any) {
      return `❌ 配置代理失败: ${htmlEscape(e?.message || e)}`;
    }
  }

  // 关闭代理设置
  private async removeProxy(): Promise<string> {
    try {
      // 获取程序目录并构建配置文件路径
      const pwdResult = await SystemExecutor.run("pwd");
      if (!pwdResult.success) {
        return "❌ 无法获取当前工作目录。";
      }
      
      const programDir = pwdResult.output.trim();
      const configPath = `${programDir}/config.json`;
      
      // 检查配置文件是否存在
      const configCheck = await SystemExecutor.run(`test -f ${configPath}`);
      if (!configCheck.success) {
        return `❌ 找不到配置文件: ${configPath}`;
      }

      // 读取配置文件
      const readResult = await SystemExecutor.run(`cat ${configPath}`);
      if (!readResult.success) {
        return "❌ 无法读取 config.json 文件。";
      }

      let config;
      try {
        config = JSON.parse(readResult.output);
      } catch {
        return "❌ config.json 文件格式错误。";
      }

      // 检查是否已配置代理
      if (!config.proxy) {
        return "ℹ️ Telegram 代理未配置，无需关闭。";
      }

      // 移除代理配置
      delete config.proxy;

      // 写回配置文件
      const configJson = JSON.stringify(config, null, 2);
      const writeCmd = `cat > ${configPath} << 'EOF'\n${configJson}\nEOF`;
      const writeResult = await SystemExecutor.runSudo(writeCmd);
      
      if (!writeResult.success) {
        return "❌ 无法写入配置文件。";
      }

      return `✅ Telegram 代理配置已关闭\n\n⚠️ <b>注意</b>: 需要重启 TeleBox 生效`;
    } catch (e: any) {
      return `❌ 关闭代理失败: ${htmlEscape(e?.message || e)}`;
    }
  }

  // 配置 Music 插件代理
  private async configureMusicProxy(): Promise<string> {
    try {
      // 检查 WireProxy 是否运行
      const svcCheck = await SystemExecutor.run("systemctl is-active wireproxy");
      if (!svcCheck.success || svcCheck.output !== "active") {
        return "❌ WireProxy 未运行。请先使用 <code>${mainPrefix}warp w</code> 启动 WireProxy。";
      }

      // 获取当前端口
      const socksCheck = await SystemExecutor.run("ss -tlnp | grep -i wireproxy | head -1");
      const portMatch = socksCheck.success ? socksCheck.output.match(/:(\d+)\b/) : null;
      const port = portMatch ? parseInt(portMatch[1], 10) : 40000;

      // 获取程序目录并构建配置文件路径
      const pwdResult = await SystemExecutor.run("pwd");
      if (!pwdResult.success) {
        return "❌ 无法获取当前工作目录。";
      }
      
      const programDir = pwdResult.output.trim();
      const configPath = `${programDir}/assets/music/music_config.json`;
      
      // 检查 Music 配置文件是否存在
      const configCheck = await SystemExecutor.run(`test -f ${configPath}`);
      if (!configCheck.success) {
        // 创建目录和配置文件
        const createDirResult = await SystemExecutor.run(`mkdir -p ${programDir}/assets/music`);
        if (!createDirResult.success) {
          return "❌ 无法创建 Music 配置目录。";
        }
        
        // 创建默认配置文件
        const defaultConfig = {
          "music_ytdlp_proxy": `socks5://127.0.0.1:${port}`
        };
        const configJson = JSON.stringify(defaultConfig, null, 2);
        const writeCmd = `cat > ${configPath} << 'EOF'\n${configJson}\nEOF`;
        const writeResult = await SystemExecutor.run(writeCmd);
        
        if (!writeResult.success) {
          return "❌ 无法创建 Music 配置文件。";
        }
      } else {
        // 读取现有配置文件
        const readResult = await SystemExecutor.run(`cat ${configPath}`);
        if (!readResult.success) {
          return "❌ 无法读取 Music 配置文件。";
        }

        let config;
        try {
          config = JSON.parse(readResult.output);
        } catch {
          return "❌ Music 配置文件格式错误。";
        }

        // 设置代理配置
        config["music_ytdlp_proxy"] = `socks5://127.0.0.1:${port}`;

        // 写回配置文件
        const configJson = JSON.stringify(config, null, 2);
        const writeCmd = `cat > ${configPath} << 'EOF'\n${configJson}\nEOF`;
        const writeResult = await SystemExecutor.run(writeCmd);
        
        if (!writeResult.success) {
          return "❌ 无法更新 Music 配置文件。";
        }
      }

      return `✅ Music 插件代理配置已更新\n\n📋 <b>配置详情</b>\n- 代理类型: SOCKS5\n- 地址: 127.0.0.1\n- 端口: ${port}\n\n💡 <b>提示</b>: Music 插件现在可以通过 WARP 访问 YouTube`;
    } catch (e: any) {
      return `❌ 配置 Music 代理失败: ${htmlEscape(e?.message || e)}`;
    }
  }

  // 关闭 Music 插件代理
  private async removeMusicProxy(): Promise<string> {
    try {
      // 获取程序目录并构建配置文件路径
      const pwdResult = await SystemExecutor.run("pwd");
      if (!pwdResult.success) {
        return "❌ 无法获取当前工作目录。";
      }
      
      const programDir = pwdResult.output.trim();
      const configPath = `${programDir}/assets/music/music_config.json`;
      
      // 检查配置文件是否存在
      const configCheck = await SystemExecutor.run(`test -f ${configPath}`);
      if (!configCheck.success) {
        return "ℹ️ Music 插件配置文件不存在，无需关闭代理。";
      }

      // 读取配置文件
      const readResult = await SystemExecutor.run(`cat ${configPath}`);
      if (!readResult.success) {
        return "❌ 无法读取 Music 配置文件。";
      }

      let config;
      try {
        config = JSON.parse(readResult.output);
      } catch {
        return "❌ Music 配置文件格式错误。";
      }

      // 检查是否已配置代理
      if (!config["music_ytdlp_proxy"]) {
        return "ℹ️ Music 插件代理未配置，无需关闭。";
      }

      // 移除代理配置
      delete config["music_ytdlp_proxy"];

      // 写回配置文件
      const configJson = JSON.stringify(config, null, 2);
      const writeCmd = `cat > ${configPath} << 'EOF'\n${configJson}\nEOF`;
      const writeResult = await SystemExecutor.run(writeCmd);
      
      if (!writeResult.success) {
        return "❌ 无法更新 Music 配置文件。";
      }

      return `✅ Music 插件代理配置已关闭\n\n💡 <b>提示</b>: Music 插件现在将直接访问 YouTube`;
    } catch (e: any) {
      return `❌ 关闭 Music 代理失败: ${htmlEscape(e?.message || e)}`;
    }
  }

  // 主处理
  private async handleWarp(msg: Api.Message): Promise<void> {
    // 标准参数解析模式（参考规范）
    const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
    const parts = lines?.[0]?.split(/\s+/) || [];
    const [, ...args] = parts; // 跳过命令本身
    const sub = (args[0] || "").toLowerCase();

    try {
      // 无参数时显示帮助
      if (!sub) {
        await msg.edit({ text: helpText, parseMode: "html" });
        return;
      }

      // 处理 help 在前的情况：${mainPrefix}help warp [subcommand]
      if (sub === "help" || sub === "h") {
        if (args[1]) {
          // 显示特定子命令的帮助
          const subCmd = args[1].toLowerCase();
          await this.showSubCommandHelp(subCmd, msg);
        } else {
          // 显示总帮助
          await msg.edit({ text: helpText, parseMode: "html" });
        }
        return;
      }

      // 处理 help 在后的情况：.warp [subcommand] help
      if (args[1] && (args[1].toLowerCase() === "help" || args[1].toLowerCase() === "h")) {
        await this.showSubCommandHelp(sub, msg);
        return;
      }

      switch (sub) {
        case "help":
        case "h":
          await msg.edit({ text: helpText, parseMode: "html" });
          return;

        case "status": {
          await msg.edit({ text: "🔄 正在获取状态...", parseMode: "html" });
          const statusText = await WireproxyManager.getStatus();
          await msg.edit({ text: statusText, parseMode: "html" });
          return;
        }

        case "w": {
          await msg.edit({ text: "🔄 正在检查环境...", parseMode: "html" });
          try {
            const { stdout } = await execAsync("systemctl is-active dnsmasq 2>/dev/null || echo 'inactive'");
            if (stdout.trim() === 'active') {
              await msg.edit({ text: "❌ Iptables/dnsmasq 方案似乎正在运行。请先禁用它，然后再启动 WireProxy。", parseMode: "html" });
              return;
            }
          } catch {}

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

        case "ip": {
          await msg.edit({ text: "🔄 正在重启 wireproxy (更换IP)...", parseMode: "html" });
          const ret = await WireproxyManager.restart();
          await msg.edit({ text: ret, parseMode: "html" });
          return;
        }

        case "port": {
          const p = parseInt(args[1] || "", 10);
          if (!p) {
            await msg.edit({ text: `❌ 请提供端口号\n\n用法: <code>${mainPrefix}warp port 40000</code>`, parseMode: "html" });
            return;
          }
          await msg.edit({ text: `🔄 正在修改端口为 ${p}...`, parseMode: "html" });
          const ret = await WireproxyManager.setPort(p);
          await msg.edit({ text: ret, parseMode: "html" });
          return;
        }

        case "uninstall":
        case "uninstall_all": {
          await msg.edit({ text: "⚠️ 正在卸载 wireproxy...", parseMode: "html" });
          const ret = await WireproxyManager.uninstall();
          await msg.edit({ text: ret, parseMode: "html" });
          return;
        }

        case "y": {
          await msg.edit({ text: "🔄 正在切换 WireProxy 状态...", parseMode: "html" });
          const status = await WireproxyManager.getStatus();
          let result;
          if (status.includes("✅ 运行中")) {
            result = await WireproxyManager.stop();
          } else {
            result = await WireproxyManager.setupAndStart();
          }
          await msg.edit({ text: result, parseMode: "html" });
          return;
        }

        case "e": {
          await msg.edit({ text: "🔄 正在检查环境...", parseMode: "html" });
          const wpStatus = await WireproxyManager.getStatus();
          if (wpStatus.includes("✅ 运行中")) {
            await msg.edit({ text: "❌ WireProxy 正在运行。请先使用 `${mainPrefix}warp stop` 停止它，然后再安装 Iptables 方案。", parseMode: "html" });
            return;
          }

          await msg.edit({ text: "🔄 正在安装 Iptables + dnsmasq + ipset 方案...", parseMode: "html" });
          try {
            await execAsync("sudo apt-get update && sudo apt-get install -y iptables dnsmasq ipset || sudo yum install -y iptables dnsmasq ipset");
            await msg.edit({ text: "✅ Iptables + dnsmasq + ipset 方案已安装", parseMode: "html" });
          } catch (e: any) {
            await msg.edit({ text: `❌ 安装失败: ${e.message}`, parseMode: "html" });
          }
          return;
        }

        case "proxy": {
          await msg.edit({ text: "🔄 正在配置代理设置...", parseMode: "html" });
          const result = await this.configureProxy();
          await msg.edit({ text: result, parseMode: "html" });
          return;
        }

        case "unproxy": {
          await msg.edit({ text: "🔄 正在关闭代理设置...", parseMode: "html" });
          const result = await this.removeProxy();
          await msg.edit({ text: result, parseMode: "html" });
          return;
        }

        case "music": {
          await msg.edit({ text: "🔄 正在配置 Music 插件代理...", parseMode: "html" });
          const result = await this.configureMusicProxy();
          await msg.edit({ text: result, parseMode: "html" });
          return;
        }

        case "unmusic": {
          await msg.edit({ text: "🔄 正在关闭 Music 插件代理...", parseMode: "html" });
          const result = await this.removeMusicProxy();
          await msg.edit({ text: result, parseMode: "html" });
          return;
        }

        default:
          // 未知命令
          await msg.edit({
            parseMode: "html"
          });
      }
    } catch (error: any) {
      console.error("[warp] 插件执行失败:", error);
      
      // 处理特定错误类型
      if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        await msg.edit({
          text: `⏳ <b>请求过于频繁</b>\n\n需要等待 ${waitTime} 秒后重试`,
          parseMode: "html"
        });
        return;
      }
      
      if (error.message?.includes("MESSAGE_TOO_LONG")) {
        await msg.edit({
          text: "❌ <b>消息过长</b>\n\n请减少内容长度或使用文件发送",
          parseMode: "html"
        });
        return;
      }
      
      // 通用错误处理
      await msg.edit({
        text: `❌ <b>操作失败:</b> ${htmlEscape(error.message || "未知错误")}`,
        parseMode: "html"
      });
    }
  }
}

export default new WarpPlugin();

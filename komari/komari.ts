import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import axios from "axios";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

// 配置存储键名
const CONFIG_KEYS = {
  KOMARI_URL: "komari_url",
};

// 数据库路径
const CONFIG_DB_PATH = path.join(
  (globalThis as any).process?.cwd?.() || ".",
  "assets",
  "komari_config.db"
);

// 确保assets目录存在
if (!fs.existsSync(path.dirname(CONFIG_DB_PATH))) {
  fs.mkdirSync(path.dirname(CONFIG_DB_PATH), { recursive: true });
}

// 配置管理器 - 使用SQLite数据库
class ConfigManager {
  private static db: Database.Database;
  private static initialized = false;

  // 初始化数据库
  private static init(): void {
    if (this.initialized) return;

    try {
      this.db = new Database(CONFIG_DB_PATH);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.initialized = true;
    } catch (error) {
      console.error("初始化Komari配置数据库失败:", error);
    }
  }

  static get(key: string, defaultValue?: string): string {
    this.init();

    try {
      const stmt = this.db.prepare("SELECT value FROM config WHERE key = ?");
      const row = stmt.get(key) as { value: string } | undefined;

      if (row) {
        return row.value;
      }
    } catch (error) {
      console.error("读取Komari配置失败:", error);
    }

    return defaultValue || "";
  }

  static set(key: string, value: string): void {
    this.init();

    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO config (key, value, updated_at) 
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `);
      stmt.run(key, value);
    } catch (error) {
      console.error("保存Komari配置失败:", error);
    }
  }

  // 获取所有配置
  static getAll(): { [key: string]: string } {
    this.init();

    try {
      const stmt = this.db.prepare("SELECT key, value FROM config");
      const rows = stmt.all() as { key: string; value: string }[];

      const config: { [key: string]: string } = {};
      rows.forEach((row) => {
        config[row.key] = row.value;
      });

      return config;
    } catch (error) {
      console.error("读取所有Komari配置失败:", error);
      return {};
    }
  }

  // 删除配置
  static delete(key: string): void {
    this.init();

    try {
      const stmt = this.db.prepare("DELETE FROM config WHERE key = ?");
      stmt.run(key);
    } catch (error) {
      console.error("删除Komari配置失败:", error);
    }
  }

  // 关闭数据库连接
  static close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}

// 字节转换工具函数
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  // 根据值的大小决定小数位数
  let decimals = 2;
  if (value >= 100) decimals = 1;
  if (value >= 1000) decimals = 0;

  return parseFloat(value.toFixed(decimals)) + " " + sizes[i];
}

// 格式化网络速度
function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond === 0) return "0 bps";

  // 转换为比特每秒
  const bitsPerSecond = bytesPerSecond * 8;

  const units = [
    { name: "bps", value: 1 },
    { name: "Kbps", value: 1024 },
    { name: "Mbps", value: 1024 * 1024 },
    { name: "Gbps", value: 1024 * 1024 * 1024 },
  ];

  // 找到最合适的单位
  let unitIndex = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    if (bitsPerSecond >= units[i].value) {
      unitIndex = i;
      break;
    }
  }

  const value = bitsPerSecond / units[unitIndex].value;

  // 根据值的大小决定小数位数
  let decimals = 2;
  if (value >= 100) decimals = 1;
  if (value >= 1000) decimals = 0;

  return parseFloat(value.toFixed(decimals)) + " " + units[unitIndex].name;
}

// 格式化运行时间
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return `${days} 天 ${hours} 时 ${minutes} 分 ${secs} 秒`;
}

// 格式化过期时间
function formatExpiredDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    // 检查是否是无效的默认日期（0001年）
    if (date.getFullYear() <= 1) {
      return "未设置";
    }

    const now = new Date();
    const diffTime = date.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    const dateString = date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    if (diffDays > 0) {
      return `${dateString} (还有 ${diffDays} 天)`;
    } else if (diffDays === 0) {
      return `${dateString} (今天到期)`;
    } else {
      return `${dateString} (已过期 ${Math.abs(diffDays)} 天)`;
    }
  } catch {
    return "未知";
  }
}

// HTTP 请求封装
async function makeRequest(url: string, endpoint: string): Promise<any> {
  try {
    const response = await axios.get(`${url}${endpoint}`, {
      timeout: 10000,
      headers: {
        Accept: "application/json",
        "User-Agent": "TeleBox-Komari-Plugin/1.0",
      },
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.data;
  } catch (error: any) {
    if (error.response) {
      throw new Error(`API 请求失败: HTTP ${error.response.status}`);
    }
    throw new Error(`网络请求失败: ${error.message}`);
  }
}

// 获取服务器基本信息
async function getServerInfo(baseUrl: string): Promise<string> {
  try {
    // 获取公开信息
    const publicData = await makeRequest(baseUrl, "/api/public");

    // 获取版本信息
    const versionData = await makeRequest(baseUrl, "/api/version");

    // 获取节点列表
    const nodesData = await makeRequest(baseUrl, "/api/nodes");

    if (
      publicData.status !== "success" ||
      versionData.status !== "success" ||
      nodesData.status !== "success"
    ) {
      throw new Error("API 返回状态异常");
    }

    const siteName = publicData.data.sitename || "未知站点";
    const version = `${versionData.data.version}-${versionData.data.hash}`;
    const nodes = nodesData.data;

    // 计算总资源
    let totalCores = 0;
    let totalMemory = 0;
    let totalSwap = 0;
    let totalDisk = 0;

    nodes.forEach((node: any) => {
      totalCores += node.cpu_cores || 0;
      totalMemory += node.mem_total || 0;
      totalSwap += node.swap_total || 0;
      totalDisk += node.disk_total || 0;
    });

    return `🎯 **Komari 服务信息**

**📊 基本信息**
• **站点名称**: \`${siteName}\`
• **Komari 版本**: \`${version}\`
• **节点数量**: \`${nodes.length}\`

**💾 资源统计**
• **CPU 核心总数**: \`${totalCores}\`
• **内存总量**: \`${formatBytes(totalMemory)}\`
• **交换分区总量**: \`${formatBytes(totalSwap)}\`
• **硬盘总量**: \`${formatBytes(totalDisk)}\``;
  } catch (error: any) {
    throw new Error(`获取服务器信息失败: ${error.message}`);
  }
}

// 获取节点总览信息
async function getNodesOverview(baseUrl: string): Promise<string> {
  try {
    // 获取公开信息
    const publicData = await makeRequest(baseUrl, "/api/public");

    // 获取节点列表
    const nodesData = await makeRequest(baseUrl, "/api/nodes");

    if (publicData.status !== "success" || nodesData.status !== "success") {
      throw new Error("API 返回状态异常");
    }

    const siteName = publicData.data.sitename || "未知站点";
    const nodes = nodesData.data;

    // 尝试通过 WebSocket 获取实时数据
    let onlineNodes: string[] = [];
    let realtimeData: { [key: string]: any } = {};

    try {
      // 这里我们通过 /api/recent/ 接口来获取每个节点的最新数据
      // 作为 WebSocket 的替代方案
      for (const node of nodes) {
        try {
          const recentData = await makeRequest(
            baseUrl,
            `/api/recent/${node.uuid}`
          );
          if (recentData.status === "success" && recentData.data.length > 0) {
            onlineNodes.push(node.uuid);
            realtimeData[node.uuid] = recentData.data[0];
          }
        } catch {
          // 节点可能离线，忽略错误
        }
      }
    } catch {
      // 如果获取实时数据失败，使用节点列表数据
    }

    const totalNodes = nodes.length;
    const onlineCount = onlineNodes.length;
    const onlinePercent =
      totalNodes > 0 ? ((onlineCount / totalNodes) * 100).toFixed(2) : "0.00";

    // 计算平均值
    let totalCores = 0;
    let avgCpu = 0;
    let avgLoad1 = 0;
    let avgLoad5 = 0;
    let avgLoad15 = 0;
    let totalMemUsed = 0;
    let totalMemTotal = 0;
    let totalSwapUsed = 0;
    let totalSwapTotal = 0;
    let totalDiskUsed = 0;
    let totalDiskTotal = 0;
    let totalDownload = 0;
    let totalUpload = 0;
    let totalDownSpeed = 0;
    let totalUpSpeed = 0;
    let totalTcpConnections = 0;
    let totalUdpConnections = 0;

    onlineNodes.forEach((uuid) => {
      const data = realtimeData[uuid];
      if (data) {
        // 找到对应的节点信息以获取核心数
        const node = nodes.find((n: any) => n.uuid === uuid);
        if (node) {
          totalCores += node.cpu_cores || 0;
        }

        avgCpu += data.cpu?.usage || 0;
        avgLoad1 += data.load?.load1 || 0;
        avgLoad5 += data.load?.load5 || 0;
        avgLoad15 += data.load?.load15 || 0;
        totalMemUsed += data.ram?.used || 0;
        totalMemTotal += data.ram?.total || 0;
        totalSwapUsed += data.swap?.used || 0;
        totalSwapTotal += data.swap?.total || 0;
        totalDiskUsed += data.disk?.used || 0;
        totalDiskTotal += data.disk?.total || 0;
        totalDownload += data.network?.totalDown || 0;
        totalUpload += data.network?.totalUp || 0;
        totalDownSpeed += data.network?.down || 0;
        totalUpSpeed += data.network?.up || 0;
        totalTcpConnections += data.connections?.tcp || 0;
        totalUdpConnections += data.connections?.udp || 0;
      }
    });

    if (onlineCount > 0) {
      avgCpu /= onlineCount;
      avgLoad1 /= onlineCount;
      avgLoad5 /= onlineCount;
      avgLoad15 /= onlineCount;
    }

    const memPercent =
      totalMemTotal > 0
        ? ((totalMemUsed / totalMemTotal) * 100).toFixed(2)
        : "0.00";
    const swapPercent =
      totalSwapTotal > 0
        ? ((totalSwapUsed / totalSwapTotal) * 100).toFixed(2)
        : "0.00";
    const diskPercent =
      totalDiskTotal > 0
        ? ((totalDiskUsed / totalDiskTotal) * 100).toFixed(2)
        : "0.00";

    return `🌐 **${siteName}** 节点总览

**📡 节点状态**
• **在线状态**: \`${onlineCount} / ${totalNodes}\` (\`${onlinePercent}%\`)
• **总核心数**: \`${totalCores}\`
• **平均 CPU**: \`${avgCpu.toFixed(2)}%\`
• **负载**: \`${avgLoad1.toFixed(2)} / ${avgLoad5.toFixed(
      2
    )} / ${avgLoad15.toFixed(2)}\`

**💾 资源使用**
• **内存**: \`${formatBytes(totalMemUsed)} / ${formatBytes(
      totalMemTotal
    )}\` (\`${memPercent}%\`)
• **交换分区**: \`${formatBytes(totalSwapUsed)} / ${formatBytes(
      totalSwapTotal
    )}\` (\`${swapPercent}%\`)
• **硬盘**: \`${formatBytes(totalDiskUsed)} / ${formatBytes(
      totalDiskTotal
    )}\` (\`${diskPercent}%\`)

**🌍 网络统计**
• **总下载**: \`${formatBytes(totalDownload)}\`
• **总上传**: \`${formatBytes(totalUpload)}\`
• **下载速度**: \`${formatSpeed(totalDownSpeed)}\`
• **上传速度**: \`${formatSpeed(totalUpSpeed)}\`
• **连接数**: \`${totalTcpConnections} TCP / ${totalUdpConnections} UDP\``;
  } catch (error: any) {
    throw new Error(`获取节点总览失败: ${error.message}`);
  }
}

// 获取指定节点详细信息
async function getNodeDetails(
  baseUrl: string,
  nodeName: string
): Promise<string> {
  try {
    // 获取公开信息
    const publicData = await makeRequest(baseUrl, "/api/public");

    // 获取节点列表
    const nodesData = await makeRequest(baseUrl, "/api/nodes");

    if (publicData.status !== "success" || nodesData.status !== "success") {
      throw new Error("API 返回状态异常");
    }

    const siteName = publicData.data.sitename || "未知站点";
    const nodes = nodesData.data;

    // 查找指定名称的节点
    const targetNode = nodes.find((node: any) => node.name === nodeName);
    if (!targetNode) {
      throw new Error(`未找到名为 "${nodeName}" 的节点`);
    }

    // 获取节点实时数据
    const recentData = await makeRequest(
      baseUrl,
      `/api/recent/${targetNode.uuid}`
    );
    if (recentData.status !== "success" || recentData.data.length === 0) {
      throw new Error(`无法获取节点 "${nodeName}" 的实时数据，节点可能离线`);
    }

    const realtime = recentData.data[0];
    const node = targetNode;

    // 格式化数据
    const cpuUsage = (realtime.cpu?.usage || 0).toFixed(2);

    const memUsed = realtime.ram?.used || 0;
    const memTotal = realtime.ram?.total || 0;
    const memPercent =
      memTotal > 0 ? ((memUsed / memTotal) * 100).toFixed(2) : "0.00";

    const swapUsed = realtime.swap?.used || 0;
    const swapTotal = realtime.swap?.total || 0;
    const swapPercent =
      swapTotal > 0 ? ((swapUsed / swapTotal) * 100).toFixed(2) : "0.00";

    const diskUsed = realtime.disk?.used || 0;
    const diskTotal = realtime.disk?.total || 0;
    const diskPercent =
      diskTotal > 0 ? ((diskUsed / diskTotal) * 100).toFixed(2) : "0.00";

    const netDown = realtime.network?.totalDown || 0;
    const netUp = realtime.network?.totalUp || 0;

    const upSpeed = formatSpeed(realtime.network?.up || 0);
    const downSpeed = formatSpeed(realtime.network?.down || 0);

    const uptime = formatUptime(realtime.uptime || 0);
    const updateTime = realtime.updated_at || "未知";

    // 构建付费信息部分
    let billingInfo = "";
    const price = node.price || 0;
    const billingCycle = node.billing_cycle || 0;

    if (price !== 0 && price !== -1 && billingCycle !== 0) {
      const currency = node.currency || "$";
      const autoRenewal = node.auto_renewal ? "是" : "否";
      const expiredDate = formatExpiredDate(node.expired_at);

      billingInfo = `

**💰 账单信息**
• **价格**: \`${currency}${price} / ${billingCycle} 天\`
• **自动续费**: \`${autoRenewal}\`
• **过期时间**: \`${expiredDate}\``;
    }

    return `🖥️ **${nodeName}** ${node.region || "🇺🇳"}
> 🌐 **${siteName}**

**⚙️ 硬件信息**
• **CPU**: \`${node.cpu_name || "未知"}\` @ \`${node.cpu_cores || 0} Cores\`
• **GPU**: \`${node.gpu_name || "None"}\`
• **架构**: \`${node.arch || "未知"}\`
• **虚拟化**: \`${node.virtualization || "未知"}\`

**🖥️ 系统信息**
• **操作系统**: \`${node.os || "未知"}\`
• **内核版本**: \`${node.kernel_version || "未知"}\`
• **运行时间**: \`${uptime}\`${billingInfo}

**📊 资源使用**
• **CPU**: \`${cpuUsage}%\`
• **内存**: \`${formatBytes(memUsed)} / ${formatBytes(
      memTotal
    )}\` (\`${memPercent}%\`)
• **交换分区**: \`${formatBytes(swapUsed)} / ${formatBytes(
      swapTotal
    )}\` (\`${swapPercent}%\`)
• **硬盘**: \`${formatBytes(diskUsed)} / ${formatBytes(
      diskTotal
    )}\` (\`${diskPercent}%\`)

**📈 系统负载**
• **负载**: \`${(realtime.load?.load1 || 0).toFixed(2)} / ${(
      realtime.load?.load5 || 0
    ).toFixed(2)} / ${(realtime.load?.load15 || 0).toFixed(2)}\`
• **进程数**: \`${realtime.process || 0}\`

**🌐 网络状态**
• **流量**: ↓ \`${formatBytes(netDown)}\` / ↑ \`${formatBytes(netUp)}\`
• **速度**: ↓ \`${downSpeed}\` / ↑ \`${upSpeed}\`
• **连接数**: \`${realtime.connections?.tcp || 0} TCP / ${
      realtime.connections?.udp || 0
    } UDP\`

**⏰ 更新时间**: \`${updateTime}\``;
  } catch (error: any) {
    throw new Error(`获取节点详情失败: ${error.message}`);
  }
}

// 主处理函数
async function handleKomariRequest(msg: Api.Message): Promise<void> {
  const [, ...args] = msg.message.slice(1).split(" ");

  try {
    // 检查是否是配置命令
    if (args.length === 2 && args[0].startsWith("_set_")) {
      const configKey = args[0];
      const configValue = args[1].trim();

      let actualKey: string;
      let displayName: string;

      if (configKey !== "_set_url") {
        await msg.edit({ text: "❌ 未知的配置项" });
        return;
      }

      displayName = "Komari URL";
      ConfigManager.set(CONFIG_KEYS.KOMARI_URL, configValue);
      const displayValue = configValue;

      await msg.edit({
        text: `✅ 已设置 ${displayName}: \`${displayValue}\``,
        parseMode: "markdown",
      });

      setTimeout(() => {
        msg.delete().catch(() => {});
      }, 5000);
      return;
    }

    // 获取配置
    const baseUrl = ConfigManager.get(CONFIG_KEYS.KOMARI_URL);
    if (!baseUrl) {
      await msg.edit({
        text: "❌ 请先设置 Komari URL\n使用命令: `komari _set_url <URL>`",
        parseMode: "markdown",
      });
      return;
    }

    // 处理不同的子命令
    if (args.length === 0 || args[0] === "status") {
      await msg.edit({ text: "🔄 获取服务器信息中..." });
      const result = await getServerInfo(baseUrl);
      await msg.edit({
        text: result,
        parseMode: "markdown",
      });
    } else if (args[0] === "total") {
      await msg.edit({ text: "🔄 获取节点总览中..." });
      const result = await getNodesOverview(baseUrl);
      await msg.edit({
        text: result,
        parseMode: "markdown",
      });
    } else if (args[0] === "show" && args.length >= 2) {
      const nodeName = args.slice(1).join(" ");
      await msg.edit({ text: `🔄 获取节点 "${nodeName}" 信息中...` });
      const result = await getNodeDetails(baseUrl, nodeName);
      await msg.edit({
        text: result,
        parseMode: "markdown",
      });
    } else {
      await msg.edit({
        text: `❌ 未知命令。支持的命令：
• <code>komari status</code> - 获取服务器基本信息
• <code>komari total</code> - 获取节点总览
• <code>komari show &lt;节点名&gt;</code> - 查看指定节点详情

配置命令：
• <code>komari _set_url &lt;URL&gt;</code> - 设置 Komari 服务器 URL`,
        parseMode: "html",
      });
    }
  } catch (error: any) {
    console.error("Komari处理错误:", error);

    const errorMsg = `❌ 错误：${error.message}`;
    await msg.edit({ text: errorMsg });

    setTimeout(() => {
      msg.delete().catch(() => {});
    }, 10000);
  }
}

class KomariPlugin extends Plugin {
  cleanup(): void {
  }

  description: string = `
Komari 服务器监控插件：
基于 Komari API 获取服务器和节点状态信息

命令：
• <code>komari status</code> - 获取服务器基本信息
• <code>komari total</code> - 获取所有节点总览
• <code>komari show &lt;节点名&gt;</code> - 查看指定节点详细状态

配置命令：
• <code>komari _set_url &lt;URL&gt;</code> - 设置 Komari 服务器地址
  `;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    komari: handleKomariRequest,
  };
}

export default new KomariPlugin();

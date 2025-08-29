import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import axios from "axios";

// 配置存储键名
const CONFIG_KEYS = {
  KOMARI_URL: "komari_url",
  KOMARI_TOKEN: "komari_token",
};

// 配置管理器
class ConfigManager {
  private static storage: { [key: string]: string } = {};

  static get(key: string, defaultValue?: string): string {
    return this.storage[key] || defaultValue || "";
  }

  static set(key: string, value: string): void {
    this.storage[key] = value;
  }
}

// 字节转换工具函数
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatGiB(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GiB";
}

function formatGB(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

// 格式化速度（字节/秒 转 Mbps）
function formatSpeed(bytesPerSecond: number): string {
  const mbps = (bytesPerSecond * 8) / (1024 * 1024);
  return mbps.toFixed(2) + " Mbps";
}

// 格式化运行时间
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  return `${days} 天 ${hours} 时 ${minutes} 分 ${secs} 秒`;
}

// HTTP 请求封装
async function makeRequest(url: string, endpoint: string): Promise<any> {
  try {
    const response = await axios.get(`${url}${endpoint}`, {
      timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TeleBox-Komari-Plugin/1.0'
      }
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
    
    if (publicData.status !== "success" || versionData.status !== "success" || nodesData.status !== "success") {
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
• **内存总量**: \`${formatGiB(totalMemory)}\`
• **交换分区总量**: \`${formatGiB(totalSwap)}\`
• **硬盘总量**: \`${formatGiB(totalDisk)}\``;

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
          const recentData = await makeRequest(baseUrl, `/api/recent/${node.uuid}`);
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
    const onlinePercent = totalNodes > 0 ? ((onlineCount / totalNodes) * 100).toFixed(2) : "0.00";
    
    // 计算平均值
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
    
    onlineNodes.forEach(uuid => {
      const data = realtimeData[uuid];
      if (data) {
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
    
    const memPercent = totalMemTotal > 0 ? ((totalMemUsed / totalMemTotal) * 100).toFixed(2) : "0.00";
    const swapPercent = totalSwapTotal > 0 ? ((totalSwapUsed / totalSwapTotal) * 100).toFixed(2) : "0.00";
    const diskPercent = totalDiskTotal > 0 ? ((totalDiskUsed / totalDiskTotal) * 100).toFixed(2) : "0.00";
    
    return `🌐 **${siteName}** 节点总览

**📡 节点状态**
• **在线状态**: \`${onlineCount} / ${totalNodes}\` (\`${onlinePercent}%\`)
• **平均 CPU**: \`${avgCpu.toFixed(2)}%\`
• **负载**: \`${avgLoad1.toFixed(2)} / ${avgLoad5.toFixed(2)} / ${avgLoad15.toFixed(2)}\`

**💾 资源使用**
• **内存**: \`${formatGB(totalMemUsed)} / ${formatGB(totalMemTotal)}\` (\`${memPercent}%\`)
• **交换分区**: \`${formatGB(totalSwapUsed)} / ${formatGB(totalSwapTotal)}\` (\`${swapPercent}%\`)
• **硬盘**: \`${formatGB(totalDiskUsed)} / ${formatGB(totalDiskTotal)}\` (\`${diskPercent}%\`)

**🌍 网络统计**
• **总下载**: \`${formatGB(totalDownload)}\`
• **总上传**: \`${formatGB(totalUpload)}\`
• **下载速度**: \`${formatSpeed(totalDownSpeed)}\`
• **上传速度**: \`${formatSpeed(totalUpSpeed)}\`
• **连接数**: \`${totalTcpConnections} TCP / ${totalUdpConnections} UDP\``;

  } catch (error: any) {
    throw new Error(`获取节点总览失败: ${error.message}`);
  }
}

// 获取指定节点详细信息
async function getNodeDetails(baseUrl: string, nodeName: string): Promise<string> {
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
    const recentData = await makeRequest(baseUrl, `/api/recent/${targetNode.uuid}`);
    if (recentData.status !== "success" || recentData.data.length === 0) {
      throw new Error(`无法获取节点 "${nodeName}" 的实时数据，节点可能离线`);
    }
    
    const realtime = recentData.data[0];
    const node = targetNode;
    
    // 格式化数据
    const cpuUsage = (realtime.cpu?.usage || 0).toFixed(2);
    const memUsed = (realtime.ram?.used || 0) / (1024 * 1024); // MB
    const memTotal = (realtime.ram?.total || 0) / (1024 * 1024); // MB
    const memPercent = memTotal > 0 ? ((memUsed / memTotal) * 100).toFixed(2) : "0.00";
    
    const swapUsed = (realtime.swap?.used || 0) / (1024 * 1024); // MB
    const swapTotal = (realtime.swap?.total || 0) / (1024 * 1024); // MB
    const swapPercent = swapTotal > 0 ? ((swapUsed / swapTotal) * 100).toFixed(2) : "0.00";
    
    const diskUsed = (realtime.disk?.used || 0) / (1024 * 1024 * 1024); // GB
    const diskTotal = (realtime.disk?.total || 0) / (1024 * 1024 * 1024); // GB
    const diskPercent = diskTotal > 0 ? ((diskUsed / diskTotal) * 100).toFixed(2) : "0.00";
    
    const netDown = (realtime.network?.totalDown || 0) / (1024 * 1024 * 1024); // GB
    const netUp = (realtime.network?.totalUp || 0) / (1024 * 1024 * 1024); // GB
    
    const upSpeed = formatSpeed(realtime.network?.up || 0);
    const downSpeed = formatSpeed(realtime.network?.down || 0);
    
    const uptime = formatUptime(realtime.uptime || 0);
    const updateTime = realtime.updated_at || "未知";
    
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
• **运行时间**: \`${uptime}\`

**📊 资源使用**
• **CPU**: \`${cpuUsage}%\`
• **内存**: \`${memUsed.toFixed(2)} / ${memTotal.toFixed(2)} MB\` (\`${memPercent}%\`)
• **交换分区**: \`${swapUsed.toFixed(2)} / ${swapTotal.toFixed(2)} MB\` (\`${swapPercent}%\`)
• **硬盘**: \`${diskUsed.toFixed(2)} / ${diskTotal.toFixed(2)} GB\` (\`${diskPercent}%\`)

**📈 系统负载**
• **负载**: \`${(realtime.load?.load1 || 0).toFixed(2)} / ${(realtime.load?.load5 || 0).toFixed(2)} / ${(realtime.load?.load15 || 0).toFixed(2)}\`
• **进程数**: \`${realtime.process || 0}\`

**🌐 网络状态**
• **流量**: ↓ \`${netDown.toFixed(2)} GB\` / ↑ \`${netUp.toFixed(2)} GB\`
• **速度**: ↓ \`${downSpeed}\` / ↑ \`${upSpeed}\`
• **连接数**: \`${realtime.connections?.tcp || 0} TCP / ${realtime.connections?.udp || 0} UDP\`

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
      
      switch (configKey) {
        case "_set_url":
          actualKey = CONFIG_KEYS.KOMARI_URL;
          displayName = "Komari URL";
          break;
        case "_set_token":
          actualKey = CONFIG_KEYS.KOMARI_TOKEN;
          displayName = "API Token";
          break;
        default:
          await msg.edit({ text: "❌ 未知的配置项" });
          return;
      }
      
      ConfigManager.set(actualKey, configValue);
      const displayValue = actualKey === CONFIG_KEYS.KOMARI_TOKEN 
        ? configValue.substring(0, 8) + "..." 
        : configValue;
      
      await msg.edit({ 
        text: `✅ 已设置 ${displayName}: \`${displayValue}\``,
        parseMode: "markdown"
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
        text: "❌ 请先设置 Komari URL\n使用命令: \`komari _set_url <URL>\`",
        parseMode: "markdown"
      });
      return;
    }
    
    // 处理不同的子命令
    if (args.length === 0 || args[0] === "status") {
      await msg.edit({ text: "🔄 获取服务器信息中..." });
      const result = await getServerInfo(baseUrl);
      await msg.edit({ 
        text: result,
        parseMode: "markdown"
      });
      
    } else if (args[0] === "total") {
      await msg.edit({ text: "🔄 获取节点总览中..." });
      const result = await getNodesOverview(baseUrl);
      await msg.edit({ 
        text: result,
        parseMode: "markdown"
      });
      
    } else if (args[0] === "show" && args.length >= 2) {
      const nodeName = args.slice(1).join(" ");
      await msg.edit({ text: `🔄 获取节点 "${nodeName}" 信息中...` });
      const result = await getNodeDetails(baseUrl, nodeName);
      await msg.edit({ 
        text: result,
        parseMode: "markdown"
      });
      
    } else {
      await msg.edit({ 
        text: `❌ 未知命令。支持的命令：
• \`komari status\` - 获取服务器基本信息
• \`komari total\` - 获取节点总览
• \`komari show <节点名>\` - 查看指定节点详情

配置命令：
• \`komari _set_url <URL>\` - 设置 Komari 服务器 URL
• \`komari _set_token <token>\` - 设置 API Token（暂未使用）`,
        parseMode: "markdown"
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

const komariPlugin: Plugin = {
  command: ["komari"],
  description: `
Komari 服务器监控插件：
基于 Komari API 获取服务器和节点状态信息

命令：
• \`komari status\` - 获取服务器基本信息
• \`komari total\` - 获取所有节点总览
• \`komari show <节点名>\` - 查看指定节点详细状态

配置命令：
• \`komari _set_url <URL>\` - 设置 Komari 服务器地址
• \`komari _set_token <token>\` - 设置 API Token（可选）
  `,
  cmdHandler: handleKomariRequest,
};

export default komariPlugin;

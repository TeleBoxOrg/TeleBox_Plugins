/**
 * SpeedNext plugin for TeleBox - Network Speed Test
 * Converted from PagerMaid-Modify speednext.py
 */

import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import axios from "axios";

const execAsync = promisify(exec);
const SPEEDTEST_PATH = path.join(process.cwd(), "assets", "speedtest");
const SPEEDTEST_JSON = path.join(process.cwd(), "assets", "speedtest.json");
const SPEEDTEST_VERSION = "1.2.0";

interface SpeedtestResult {
  isp: string;
  server: {
    id: number;
    name: string;
    location: string;
  };
  interface: {
    externalIp: string;
    name: string;
  };
  ping: {
    latency: number;
    jitter: number;
  };
  download: {
    bandwidth: number;
    bytes: number;
  };
  upload: {
    bandwidth: number;
    bytes: number;
  };
  timestamp: string;
  result: {
    url: string;
  };
}

interface ServerInfo {
  id: number;
  name: string;
  location: string;
}

function ensureDirectories(): void {
  const assetsDir = path.join(process.cwd(), "assets");
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }
}

function getDefaultServer(): number | null {
  try {
    if (fs.existsSync(SPEEDTEST_JSON)) {
      const data = JSON.parse(fs.readFileSync(SPEEDTEST_JSON, 'utf8'));
      return data.default_server_id || null;
    }
  } catch (error) {
    console.error('Failed to read default server:', error);
  }
  return null;
}

function saveDefaultServer(serverId: number | null): void {
  try {
    ensureDirectories();
    fs.writeFileSync(SPEEDTEST_JSON, JSON.stringify({ default_server_id: serverId }));
  } catch (error) {
    console.error('Failed to save default server:', error);
  }
}

function removeDefaultServer(): void {
  try {
    if (fs.existsSync(SPEEDTEST_JSON)) {
      fs.unlinkSync(SPEEDTEST_JSON);
    }
  } catch (error) {
    console.error('Failed to remove default server:', error);
  }
}

async function downloadCli(): Promise<void> {
  try {
    ensureDirectories();
    
    // 检查是否已存在
    if (fs.existsSync(SPEEDTEST_PATH)) {
      return;
    }

    const platform = process.platform;
    const arch = process.arch;
    
    let filename: string;
    if (platform === 'linux') {
      const archMap: { [key: string]: string } = {
        'x64': 'x86_64',
        'arm64': 'aarch64',
        'arm': 'armhf'
      };
      const mappedArch = archMap[arch] || 'x86_64';
      filename = `ookla-speedtest-${SPEEDTEST_VERSION}-linux-${mappedArch}.tgz`;
    } else if (platform === 'win32') {
      filename = `ookla-speedtest-${SPEEDTEST_VERSION}-win64.zip`;
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    const url = `https://install.speedtest.net/app/cli/${filename}`;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    
    const tempFile = path.join(process.cwd(), "assets", filename);
    fs.writeFileSync(tempFile, response.data);

    // 解压文件
    if (platform === 'linux') {
      await execAsync(`tar -xzf "${tempFile}" -C "${path.dirname(SPEEDTEST_PATH)}"`);
      await execAsync(`chmod +x "${SPEEDTEST_PATH}"`);
    } else if (platform === 'win32') {
      // Windows 需要解压 zip 文件
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(tempFile);
      zip.extractAllTo(path.dirname(SPEEDTEST_PATH), true);
    }

    // 清理临时文件
    fs.unlinkSync(tempFile);
    
    // 清理额外文件
    const extraFiles = ['speedtest.5', 'speedtest.md'];
    for (const file of extraFiles) {
      const filePath = path.join(path.dirname(SPEEDTEST_PATH), file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (error) {
    console.error('Failed to download speedtest CLI:', error);
    throw error;
  }
}

async function unitConvert(bytes: number, isBytes: boolean = false): Promise<string> {
  const power = 1000;
  let value = bytes;
  let unitIndex = 0;
  
  const units = isBytes 
    ? ['B', 'KB', 'MB', 'GB', 'TB']
    : ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  
  if (!isBytes) {
    value *= 8; // Convert bytes to bits
  }
  
  while (value >= power && unitIndex < units.length - 1) {
    value /= power;
    unitIndex++;
  }
  
  return `${Math.round(value * 100) / 100}${units[unitIndex]}`;
}

async function getIpApi(ip: string): Promise<{
  asInfo: string;
  ccName: string;
  ccCode: string;
  ccFlag: string;
  ccLink: string;
}> {
  try {
    const response = await axios.get(`http://ip-api.com/json/${ip}?fields=as,country,countryCode`);
    const data = response.data;
    
    const asInfo = data.as?.split(' ')[0] || '';
    const ccName = data.country === 'Netherlands' ? 'Netherlands' : (data.country || '');
    const ccCode = data.countryCode || '';
    const ccFlag = ccCode ? String.fromCodePoint(...ccCode.toUpperCase().split('').map(c => 127397 + c.charCodeAt(0))) : '';
    
    let ccLink = 'https://www.submarinecablemap.com/country/';
    if (['Hong Kong', 'Macao', 'Macau'].includes(ccName)) {
      ccLink += 'china';
    } else {
      ccLink += ccName.toLowerCase().replace(' ', '-');
    }
    
    return { asInfo, ccName, ccCode, ccFlag, ccLink };
  } catch (error) {
    console.error('Failed to get IP info:', error);
    return { asInfo: '', ccName: '', ccCode: '', ccFlag: '', ccLink: '' };
  }
}

async function getInterfaceTraffic(interfaceName: string): Promise<{
  rxBytes: number;
  txBytes: number;
  mtu: number;
}> {
  try {
    if (process.platform === 'linux') {
      const rxBytes = parseInt(fs.readFileSync(`/sys/class/net/${interfaceName}/statistics/rx_bytes`, 'utf8'));
      const txBytes = parseInt(fs.readFileSync(`/sys/class/net/${interfaceName}/statistics/tx_bytes`, 'utf8'));
      const mtu = parseInt(fs.readFileSync(`/sys/class/net/${interfaceName}/mtu`, 'utf8'));
      return { rxBytes, txBytes, mtu };
    }
  } catch (error) {
    console.error('Failed to get interface traffic:', error);
  }
  return { rxBytes: 0, txBytes: 0, mtu: 0 };
}

async function runSpeedtest(serverId?: number): Promise<SpeedtestResult> {
  try {
    if (!fs.existsSync(SPEEDTEST_PATH)) {
      await downloadCli();
    }

    const serverArg = serverId ? ` -s ${serverId}` : '';
    const command = `"${SPEEDTEST_PATH}" --accept-license --accept-gdpr -f json${serverArg}`;
    
    const { stdout, stderr } = await execAsync(command);
    
    if (stderr && stderr.includes('NoServersException')) {
      throw new Error('Unable to connect to the specified server');
    }
    
    return JSON.parse(stdout);
  } catch (error) {
    console.error('Speedtest failed:', error);
    throw error;
  }
}

async function getAllServers(): Promise<ServerInfo[]> {
  try {
    if (!fs.existsSync(SPEEDTEST_PATH)) {
      await downloadCli();
    }

    const command = `"${SPEEDTEST_PATH}" -f json -L`;
    const { stdout } = await execAsync(command);
    const result = JSON.parse(stdout);
    
    return result.servers || [];
  } catch (error) {
    console.error('Failed to get servers:', error);
    return [];
  }
}

async function saveSpeedtestImage(url: string): Promise<string | null> {
  try {
    const imageUrl = url + '.png';
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const imagePath = path.join(tempDir, 'speedtest.png');
    fs.writeFileSync(imagePath, response.data);
    
    return imagePath;
  } catch (error) {
    console.error('Failed to save speedtest image:', error);
    return null;
  }
}

const speednextPlugin: Plugin = {
  command: ["s", "speedtest"],
  description: "⚡️ 网络速度测试工具 | SpeedTest by Ookla",
  cmdHandler: async (msg: Api.Message) => {
    const args = msg.message.slice(1).split(' ').slice(1);
    const command = args[0] || '';
    
    try {
      if (command === 'list') {
        await msg.edit({ text: "🔍 正在获取服务器列表..." });
        
        const servers = await getAllServers();
        if (servers.length === 0) {
          await msg.edit({ text: "❌ **错误**\n\n无可用服务器" });
          return;
        }
        
        const serverList = servers.slice(0, 20).map(server => 
          `\`${server.id}\` - \`${server.name}\` - \`${server.location}\``
        ).join('\n');
        
        await msg.edit({
          text: `> **⚡️SPEEDTEST by OOKLA**\n${serverList}`
        });
        
      } else if (command === 'set') {
        const serverId = parseInt(args[1]);
        if (!serverId || isNaN(serverId)) {
          await msg.edit({ text: "❌ **参数错误**\n\n请指定有效的服务器ID\n例: `s set 12345`" });
          return;
        }
        
        saveDefaultServer(serverId);
        await msg.edit({
          text: `> **⚡️SPEEDTEST by OOKLA**\n\`默认服务器已设置为 ${serverId}\``
        });
        
      } else if (command === 'clear') {
        removeDefaultServer();
        await msg.edit({
          text: "> **⚡️SPEEDTEST by OOKLA**\n`默认服务器已清除`"
        });
        
      } else if (command === 'config') {
        const defaultServer = getDefaultServer() || 'Auto';
        await msg.edit({
          text: `> **⚡️SPEEDTEST by OOKLA**\n\`默认服务器: ${defaultServer}\`\n\`Speedtest® CLI: ${SPEEDTEST_VERSION}\``
        });
        
      } else if (command === 'update') {
        await msg.edit({ text: "🔄 正在更新 Speedtest CLI..." });
        
        try {
          // 删除现有文件强制重新下载
          if (fs.existsSync(SPEEDTEST_PATH)) {
            fs.unlinkSync(SPEEDTEST_PATH);
          }
          
          await downloadCli();
          await msg.edit({
            text: "> **⚡️SPEEDTEST by OOKLA**\n`Speedtest® CLI 已更新到最新版本`"
          });
        } catch (error) {
          await msg.edit({
            text: `> **⚡️SPEEDTEST by OOKLA**\n\`更新失败: ${error}\``
          });
        }
        
      } else if (command === '' || !isNaN(parseInt(command))) {
        await msg.edit({ text: "⚡️ 正在进行速度测试..." });
        
        const serverId = command && !isNaN(parseInt(command)) ? parseInt(command) : getDefaultServer();
        
        try {
          const result = await runSpeedtest(serverId || undefined);
          const { asInfo, ccName, ccCode, ccFlag, ccLink } = await getIpApi(result.interface.externalIp);
          const { rxBytes, txBytes, mtu } = await getInterfaceTraffic(result.interface.name);
          
          const description = [
            `> **⚡️SPEEDTEST by OOKLA [@${ccCode}${ccFlag}](${ccLink})**`,
            `\`Name\`\`  \`\`${result.isp}\`\` \`[${asInfo}](https://bgp.tools/${asInfo})`,
            `\`Node\`\`  \`\`${result.server.id}\` - \`${result.server.name}\` - \`${result.server.location}\``,
            `\`Conn\`\`  \`\`${result.interface.externalIp.includes(':') ? 'IPv6' : 'IPv4'}\` - \`${result.interface.name}\` - \`MTU\` \`${mtu}\``,
            `\`Ping\`\`  \`⇔\`${result.ping.latency}ms\`\` \`±\`${result.ping.jitter}ms\``,
            `\`Rate\`\`  \`↓\`${await unitConvert(result.download.bandwidth)}\`\` \`↑\`${await unitConvert(result.upload.bandwidth)}\``,
            `\`Data\`\`  \`↓\`${await unitConvert(result.download.bytes, true)}\`\` \`↑\`${await unitConvert(result.upload.bytes, true)}\``,
            `\`Stat\`\`  \`RX \`${await unitConvert(rxBytes, true)}\`\` \`TX \`${await unitConvert(txBytes, true)}\``,
            `\`Time\`\`  \`\`${result.timestamp.replace('T', ' ').split('.')[0].replace('Z', '')}\``
          ].join('\n');
          
          // 尝试发送图片
          if (result.result?.url) {
            try {
              const imagePath = await saveSpeedtestImage(result.result.url);
              if (imagePath && fs.existsSync(imagePath)) {
                await msg.client?.sendFile(msg.peerId, {
                  file: imagePath,
                  caption: description
                });
                
                // 删除原消息和临时文件
                await msg.delete();
                fs.unlinkSync(imagePath);
                return;
              }
            } catch (imageError) {
              console.error('Failed to send image:', imageError);
            }
          }
          
          // 如果图片发送失败，发送文本
          await msg.edit({ text: description });
          
        } catch (error) {
          await msg.edit({
            text: `❌ **速度测试失败**\n\n${error}`
          });
        }
        
      } else {
        await msg.edit({
          text: `❌ **参数错误**\n\n**使用方法:**
\`s\` - 开始速度测试
\`s [服务器ID]\` - 使用指定服务器测试
\`s list\` - 显示可用服务器列表
\`s set [ID]\` - 设置默认服务器
\`s clear\` - 清除默认服务器
\`s config\` - 显示配置信息
\`s update\` - 更新 Speedtest CLI`
        });
      }
      
    } catch (error) {
      console.error('SpeedNext plugin error:', error);
      await msg.edit({
        text: `❌ **插件错误**\n\n${error}`
      });
    }
  },
};

export default speednextPlugin;

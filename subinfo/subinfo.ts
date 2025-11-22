import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import axios from "axios";
import * as yaml from "js-yaml";
import dayjs from "dayjs";

const REMOTE_MAPPINGS_URL = "https://raw.githubusercontent.com/Hyy800/Quantumult-X/refs/heads/Nana/ymys.txt";
let REMOTE_CONFIG_MAPPINGS: Record<string, string> = {};

// 地区规则全量
const REGION_RULES: Array<[string, string[]]> = [
  // 亚洲
  ['香港', ['香港', 'hong kong', 'hongkong', 'hk', '🇭🇰', 'hkg']],
  ['台湾', ['台湾', 'taiwan', 'tw', '🇹🇼', 'taipei', 'tpe']],
  ['日本', ['日本', 'japan', 'jp', '🇯🇵', 'tokyo', 'osaka', 'jap']],
  ['新加坡', ['新加坡', 'singapore', 'sg', '🇸🇬', 'sgp']],
  ['韩国', ['韩国', 'korea', 'kr', '🇰🇷', 'seoul', 'kor']],
  ['印度', ['印度', 'india', 'in', '🇮🇳', 'mumbai', 'delhi', 'ind']],
  ['马来西亚', ['马来西亚', 'malaysia', 'my', '🇲🇾', 'kuala lumpur', 'mys']],
  ['泰国', ['泰国', 'thailand', 'th', '🇹🇭', 'bangkok', 'tha']],
  ['越南', ['越南', 'vietnam', 'vn', '🇻🇳', 'hanoi', 'vnm']],
  ['印尼', ['印尼', '印度尼西亚', 'indonesia', 'id', '🇮🇩', 'jakarta', 'idn']],
  ['菲律宾', ['菲律宾', 'philippines', 'ph', '🇵🇭', 'manila', 'phl']],
  ['土耳其', ['土耳其', 'turkey', 'tr', '🇹🇷', 'istanbul', 'ankara', 'tur']],
  // 北美
  ['美国', ['美国', 'united states', 'us', 'usa', '🇺🇸', 'los angeles', 'san jose', 'silicon valley']],
  ['加拿大', ['加拿大', 'canada', 'ca', '🇨🇦', 'toronto', 'vancouver']],
  // 欧洲主要
  ['英国', ['英国', 'united kingdom', 'uk', '🇬🇧', 'london', 'manchester', 'gbr']],
  ['德国', ['德国', 'germany', 'de', '🇩🇪', 'frankfurt', 'berlin', 'deu']],
  ['法国', ['法国', 'france', 'fr', '🇫🇷', 'paris', 'fra']],
  ['荷兰', ['荷兰', 'netherlands', 'nl', '🇳🇱', 'amsterdam', 'nld']],
  ['瑞士', ['瑞士', 'switzerland', 'ch', '🇨🇭', 'zurich', 'che']],
  // 其他欧洲
  ['意大利', ['意大利', 'italy', 'it', '🇮🇹', 'milan', 'rome', 'ita']],
  ['西班牙', ['西班牙', 'spain', 'es', '🇪🇸', 'madrid', 'barcelona', 'esp']],
  ['瑞典', ['瑞典', 'sweden', 'se', '🇸🇪', 'stockholm', 'swe']],
  ['挪威', ['挪威', 'norway', 'no', '🇳🇴', 'oslo', 'nor']],
  ['芬兰', ['芬兰', 'finland', 'fi', '🇫🇮', 'helsinki', 'fin']],
  ['丹麦', ['丹麦', 'denmark', 'dk', '🇩🇰', 'copenhagen', 'dnk']],
  ['波兰', ['波兰', 'poland', 'pl', '🇵🇱', 'warsaw', 'pol']],
  ['奥地利', ['奥地利', 'austria', 'at', '🇦🇹', 'vienna', 'aut']],
  ['比利时', ['比利时', 'belgium', 'be', '🇧🇪', 'brussels', 'bel']],
  ['爱尔兰', ['爱尔兰', 'ireland', 'ie', '🇮🇪', 'dublin', 'irl']],
  ['葡萄牙', ['葡萄牙', 'portugal', 'pt', '🇵🇹', 'lisbon', 'prt']],
  ['希腊', ['希腊', 'greece', 'gr', '🇬🇷', 'athens', 'grc']],
  ['卢森堡', ['卢森堡', 'luxembourg', 'lu', '🇱🇺', 'lux']],
  ['乌克兰', ['乌克兰', 'ukraine', 'ua', '🇺🇦', 'kiev', 'ukr']],
  // 大洋洲
  ['澳大利亚', ['澳大利亚', 'australia', 'au', '🇦🇺', 'sydney', 'melbourne', 'aus']],
  ['新西兰', ['新西兰', 'new zealand', 'nz', '🇳🇿', 'auckland', 'nzl']],
  // 南美
  ['巴西', ['巴西', 'brazil', 'br', '🇧🇷', 'sao paulo', 'rio', 'bra']],
  ['阿根廷', ['阿根廷', 'argentina', 'ar', '🇦🇷', 'buenos aires', 'arg']],
  ['智利', ['智利', 'chile', 'cl', '🇨🇱', 'santiago', 'chl']],
  ['哥伦比亚', ['哥伦比亚', 'colombia', 'co', '🇨🇴', 'bogota', 'col']],
  ['墨西哥', ['墨西哥', 'mexico', 'mx', '🇲🇽', 'mexico city', 'mex']],
  // 中东
  ['阿联酋', ['阿联酋', 'uae', 'united arab emirates', 'ae', '🇦🇪', 'dubai', 'abu dhabi', 'are']],
  ['以色列', ['以色列', 'israel', 'il', '🇮🇱', 'tel aviv', 'jerusalem', 'isr']],
  ['沙特', ['沙特', '沙特阿拉伯', 'saudi arabia', 'sa', '🇸🇦', 'riyadh', 'sau']],
  // 非洲
  ['南非', ['南非', 'south africa', 'za', '🇿🇦', 'johannesburg', 'cape town', 'zaf']],
  ['埃及', ['埃及', 'egypt', 'eg', '🇪🇬', 'cairo', 'egy']],
  // 俄罗斯
  ['俄罗斯', ['俄罗斯', 'russia', 'ru', '🇷🇺', 'moscow', 'st.petersburg', 'rus']],
];

// HTML转义
function htmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#x27;'
  }[m] || m));
}

// 字节单位转换
function formatSize(size: number): string {
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  if (size < 0) size = 0;
  let level = 0;
  let integer = Math.floor(size);
  let remainder = 0;
  while (integer >= 1024 && level < UNITS.length - 1) {
    remainder = integer % 1024;
    integer = Math.floor(integer / 1024);
    level++;
  }
  return `${integer}.${remainder.toString().padStart(3, '0')} ${UNITS[level]}`;
}

// xx天xx小时
function formatTimeRemaining(seconds: number): string {
  seconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days.toString().padStart(2, '0')}天${hours.toString().padStart(2, '0')}小时`;
}

// 日均
function calculateDailyUsage(totalUsed: number, startTime: number, currentTime: number): string {
  const days = Math.max(1, (currentTime - startTime) / 86400);
  return formatSize(totalUsed / days);
}

// 建议日均
function calculateRemainingDailyAllowance(remain: number, days: number): string {
  if (days <= 0) return "无法计算";
  return formatSize(remain / days);
}

// 使用百分比表情
function getSpeedEmoji(percent: number): string {
  if (percent < 30) return "🟢 良好";
  if (percent < 70) return "🟡 正常";
  if (percent < 90) return "🟠 偏高";
  return "🔴 警告";
}

// 预计耗尽日期
function estimateDepletionDate(remain: number, dailyUsage: number): string {
  if (dailyUsage <= 0) return "无法估计";
  const days = Math.floor(remain / dailyUsage);
  return dayjs().add(days, 'day').format("YYYY-MM-DD");
}

// 节点统计
async function getNodeInfo(url: string): Promise<{ node_count: number | string, type_count: Record<string, number>, regions: Record<string, number> } | null> {
  try {
    const res = await axios.get(url, { timeout: 10000, responseType: 'text' });
    // 尝试 parse yaml
    try {
      const config = yaml.load(res.data);
      if (config && (config as any).proxies) {
        const proxies = (config as any).proxies;
        const typeCount: Record<string, number> = {};
        const regions: Record<string, number> = {};
        let totalNodes = proxies.length;
        let identified = 0;
        for (const proxy of proxies) {
          const type = proxy.type?.toLowerCase();
          typeCount[type] = typeCount[type] ? typeCount[type] + 1 : 1;
          const nameLow = proxy.name?.toLowerCase() || '';
          for (const [region, keys] of REGION_RULES) {
            if (keys.some(k => nameLow.includes(k.toLowerCase()))) {
              regions[region] = (regions[region] || 0) + 1;
              identified++;
              break;
            }
          }
        }
        if (totalNodes - identified > 0) regions['其他'] = totalNodes - identified;
        return {
          node_count: totalNodes,
          type_count: Object.fromEntries(Object.entries(typeCount).filter(([_, v]) => v > 0)),
          regions: Object.fromEntries(Object.entries(regions).filter(([_, v]) => v > 0))
        };
      }
    } catch { }
    // 尝试 base64
    try {
      const decoded = Buffer.from(res.data, 'base64').toString();
      const typeCount: Record<string, number> = {};
      const regions: Record<string, number> = {};
      let nodeCount = 0;
      let identified = 0;
      decoded.split('\n').forEach(line => {
        if (!line.trim()) return;
        for (const pattern of ['vmess://', 'trojan://', 'ss://', 'ssr://', 'vless://', 'hy2://', 'hysteria://', 'hy://', 'tuic://', 'wireguard://', 'socks5://', 'http://', 'https://', 'shadowtls://', 'naive://']) {
          if (line.startsWith(pattern)) {
            let t = pattern.replace('://', '');
            typeCount[t] = typeCount[t] ? typeCount[t] + 1 : 1;
            nodeCount++;
            let lLow = line.toLowerCase();
            for (const [region, keys] of REGION_RULES) {
              if (keys.some(k => lLow.includes(k.toLowerCase()))) {
                regions[region] = (regions[region] || 0) + 1;
                identified++;
                break;
              }
            }
            break;
          }
        }
      });
      if (nodeCount - identified > 0) regions['其他'] = nodeCount - identified;
      return {
        node_count: nodeCount,
        type_count: Object.fromEntries(Object.entries(typeCount).filter(([_, v]) => v > 0)),
        regions: Object.fromEntries(Object.entries(regions).filter(([_, v]) => v > 0)),
      };
    } catch { }
    return null;
  } catch { return null; }
}

// 订阅周期类型智能区分
function getSubType(expireTs: number): { isLongTerm: boolean; isSingle: boolean; resetInfo: string; daysToReset: number } {
  const now = Math.floor(Date.now() / 1000);
  const expireTime = new Date(expireTs * 1000);
  const daysToExpire = Math.max(0, Math.floor((expireTs - now) / 86400));
  const isLongTerm = (expireTs - now) > 3 * 365 * 86400;
  let resetInfo = "单次订阅，无重置";
  let daysToReset = daysToExpire;

  // 月度重置日
  const resetDay = expireTime.getDate();
  const current = new Date();
  let nextReset = new Date(current.getFullYear(), current.getMonth(), resetDay, 0, 0, 0);
  if (current.getDate() >= resetDay) {
    nextReset = new Date(current.getFullYear(), current.getMonth() + 1, resetDay, 0, 0, 0);
  }
  daysToReset = Math.max(1, Math.floor((nextReset.getTime() / 1000 - now) / 86400));
  if (daysToExpire < 45 && !isLongTerm) {
    resetInfo = "单次订阅，无重置";
    daysToReset = daysToExpire;
    return { isSingle: true, isLongTerm, resetInfo, daysToReset };
  } else {
    resetInfo = `每月${resetDay}日`;
    return { isSingle: false, isLongTerm, resetInfo, daysToReset };
  }
}

// 电报长消息分割
function splitLongMessage(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text];
  const ret: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > maxLength) {
      if (current) ret.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) ret.push(current);
  return ret;
}

class SubinfoPlugin extends Plugin {
  description =
    `📈 订阅链接多维度查询工具

<b>使用方法：</b>
• <code>.subinfo [订阅链接]</code> - 查询订阅(回复消息可自动提取)

<b>功能特性：</b>
支持批量多链接查询、流量统计、月度重置检测、节点分布分析、到期预测、耗尽时间预测、上下行比例统计、自动识别机场名称。`;

  cmdHandlers = {
    subinfo: this.handleSubinfo.bind(this)
  };
  
  // 加载远程映射配置
  private async loadRemoteMappings(): Promise<number> {
    try {
      const response = await axios.get(REMOTE_MAPPINGS_URL, { timeout: 10000 });
      const content = response.data as string;
      
      const mappings: Record<string, string> = {};
      const lines = content.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        
        const equalsIndex = trimmed.indexOf('=');
        if (equalsIndex > 0) {
          const key = trimmed.substring(0, equalsIndex).trim();
          const value = trimmed.substring(equalsIndex + 1).trim();
          mappings[key] = value;
        }
      }
      
      REMOTE_CONFIG_MAPPINGS = mappings;
      return Object.keys(REMOTE_CONFIG_MAPPINGS).length;
    } catch (error) {
      console.error(`[Subinfo] 加载远程映射失败:`, error);
      return 0;
    }
  }

  // 从映射中获取配置名称
  private getConfigNameFromMappings(url: string): string | null {
    for (const [key, name] of Object.entries(REMOTE_CONFIG_MAPPINGS)) {
      if (url.includes(key)) {
        return name;
      }
    }
    return null;
  }

  // 从 Content-Disposition 头中获取配置名称
  private getConfigNameFromHeader(contentDisposition: string | null): string | null {
    if (!contentDisposition) return null;

    try {
      const parts = contentDisposition.split(';');
      
      // filename* 格式
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith('filename*=')) {
          const namePart = trimmed.split("''").pop();
          if (namePart) {
            try {
              return decodeURIComponent(namePart);
            } catch {
              // Ignore
            }
          }
        }
      }
      
      // filename 格式
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith('filename=')) {
          let namePart = trimmed.split('=').slice(1).join('=').trim();
          namePart = namePart.replace(/^["']|["']$/g, '');
          
          if (namePart) {
            try {
              const repairedName = Buffer.from(namePart, 'binary').toString('utf-8');
              const unquotedName = decodeURIComponent(repairedName);
              return unquotedName !== repairedName ? unquotedName : repairedName;
            } catch {
              try {
                return decodeURIComponent(namePart);
              } catch {
                return namePart;
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`[Subinfo] 解析Content-Disposition失败:`, error);
    }
    
    return null;
  }
  
  async handleSubinfo(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    await msg.edit({ text: "⏳ 正在准备解析订阅，请稍候..." });
    
    // 提取文本和链接
    let sourceText = '';
    if (msg.replyToMsgId) {
      try {
        const replyMsg = await msg.getReplyMessage();
        if (replyMsg) {
            sourceText = (replyMsg.text ?? '') + ' ' + ((replyMsg as any).caption ?? '');
        }
      } catch { sourceText = ''; }
    }
    const myText = (msg.text ?? '').trim();
    const parts = myText.split(/\s+/);
    if (parts.length > 1) sourceText += ' ' + parts.slice(1).join(' ');
    sourceText = sourceText.trim();
    
    // 默认行为：如果没有参数且没有回复，显示帮助
    if (!sourceText) {
      await msg.edit({
        text: "❌ <b>无效的参数</b>\n\n" +
              "💡 使用方法：\n" +
              "• <code>.subinfo [订阅链接]</code> - 查询订阅链接\n" +
              "• 回复包含链接的消息并发送 <code>.subinfo</code>",
        parseMode: "html"
      });
      return;
    }
    const urlRegex = /https?:\/\/[^\s]+/g;
    const urls = Array.from(new Set((sourceText.match(urlRegex) ?? [])));
    if (!urls.length) {
      await msg.edit({ text: "❌ 未找到有效的订阅链接" });
      return;
    }
    
    // 加载远程映射
    const mappingsCount = await this.loadRemoteMappings();
    await msg.edit({ text: `📚 已加载 ${mappingsCount} 条配置映射，正在查询 ${urls.length} 个链接...` });

    let reports: string[] = [];
    let stats = { 有效: 0, 耗尽: 0, 过期: 0, 失败: 0 };
    for (const url of urls) {
      try {
        // 1. 尝试从映射中获取配置名
        let configName: string | null = this.getConfigNameFromMappings(url);
        
        const response = await axios.get(url, { 
            headers: { 
                'User-Agent': 'FlClash/v0.8.76 clash-verge Platform/android' 
            }, 
            timeout: 15000, 
            maxRedirects: 5, 
            validateStatus: () => true 
        });

        if (response.status !== 200) {
          reports.push(`订阅链接: <code>${htmlEscape(url)}</code>\n状态: <b>无法访问(${response.status})</b>`);
          stats.失败++; continue;
        }
        
        // 2. 尝试从 Content-Disposition 头获取配置名
        if (!configName) {
            const contentDisposition = response.headers['content-disposition'];
            configName = this.getConfigNameFromHeader(contentDisposition);
        }
        const finalConfigName = configName || '未知';

        // 解析用户信息头
        const userInfoHeader = response.headers['subscription-userinfo'];
        if (!userInfoHeader) {
          reports.push(`订阅链接: <code>${htmlEscape(url)}</code>\n机场名称: <code>${htmlEscape(finalConfigName)}</code>\n<b>无流量统计信息</b>`);
          stats.失败++; continue;
        }
        
        // 解析用户信息
        const userInfoParts: Record<string, string> = {};
        const headerParts = userInfoHeader.split(';');
        
        for (const part of headerParts) {
            const equalsIndex = part.indexOf('=');
            if (equalsIndex > 0) {
                const key = part.substring(0, equalsIndex).trim().toLowerCase();
                const value = part.substring(equalsIndex + 1).trim();
                userInfoParts[key] = value;
            }
        }
        
        const upload = parseInt(userInfoParts.upload || '0');
        const download = parseInt(userInfoParts.download || '0');
        const total = parseInt(userInfoParts.total || '0');
        const expireTs = parseInt(userInfoParts.expire || '0');
        
        const used = upload + download;
        const remain = total > used ? total - used : 0;
        const percent = total > 0 ? Math.round((used / total) * 10000) / 100 : 0;
        
        // 状态判断
        let status = "有效";
        if (total > 0 && remain <= 0) { status = "耗尽"; stats.耗尽++; }
        if (expireTs && Date.now() > expireTs * 1000) { status = "过期"; stats.过期++; }
        if (status === "有效") stats.有效++;
        
        let statusEmoji = "⏰";

        // 节点信息
        let nodeInfo: { node_count: number | string, type_count: Record<string, number>, regions: Record<string, number> } | null = null;
        try { nodeInfo = await getNodeInfo(url); } catch { nodeInfo = null; }

        // 订阅开始时间
        const startTs = parseInt(userInfoParts.starttime || '0');
        
        // 订阅类型区分
        const { isLongTerm, isSingle, resetInfo, daysToReset } = getSubType(expireTs ?? 0);

        // --- 输出生成逻辑 ---
        let seg: string[] = [];

        // 1. 基本信息
        seg.push(`📄 <b>机场名称</b>: <code>${htmlEscape(finalConfigName)}</code>`);
        seg.push(`🔗 <b>订阅链接</b>: <code>${htmlEscape(url)}</code>`);
        
        // 2. 查询时间与状态 (上移)
        seg.push(`⏱️ <b>查询时间</b>: <code>${dayjs().format('YYYY-MM-DD HH:mm:ss')}</code>`);
        seg.push(`${statusEmoji} <b>状态</b>: <b>${status}</b>\n`);
        
        // 3. 流量信息 (折叠)
        seg.push(`📊 <b>流量信息</b>`);
        let trafficInfo = `总计: ${formatSize(total)}\n` +
                          `已用: ${formatSize(used)} (↑${formatSize(upload)} ↓${formatSize(download)})\n` +
                          `剩余: ${formatSize(remain)}\n` +
                          `进度: ${'█'.repeat(Math.round(percent / 5))}${'░'.repeat(20 - Math.round(percent / 5))} ${percent}% ${getSpeedEmoji(percent)}`;
        seg.push(`<blockquote expandable>${trafficInfo}</blockquote>`);
        
        // 4. 时间信息 (折叠)
        if (expireTs) {
          seg.push(`⏱️ <b>时间信息</b>`);
          let timeInfo = '';
          const leftTime = expireTs * 1000 - Date.now();
          timeInfo += `到期: ${dayjs(expireTs * 1000).format('YYYY-MM-DD HH:mm:ss')}\n`;
          if (leftTime > 0) timeInfo += `剩余: ${formatTimeRemaining(Math.floor(leftTime / 1000))}\n`;
          else timeInfo += `状态: 已过期\n`;

          if (isLongTerm) timeInfo += `类型: 长期有效订阅\n`;
          else if (isSingle) timeInfo += `周期: 单次订阅，无重置\n`;
          else timeInfo += `周期: ${resetInfo}\n`;
          
          timeInfo += `下次重置/到期: ${formatTimeRemaining(daysToReset * 86400)}\n`;
          if (daysToReset) timeInfo += `建议用量: ${calculateRemainingDailyAllowance(remain, daysToReset)}/天\n`;
          
          if (startTs && Math.floor(Date.now() / 1000) > startTs)
            timeInfo += `历史日均: ${calculateDailyUsage(used, startTs, Math.floor(Date.now() / 1000))}/天\n`;
          
          if (used > 0) {
            const dayUsageBytes = Math.floor(used / ((Math.floor(Date.now() / 1000) - startTs) / 86400));
            timeInfo += `预计耗尽日期: ${estimateDepletionDate(remain, dayUsageBytes)}\n`;
            timeInfo += `上下行比例: ↑${Math.round((upload / used) * 10000) / 100}% ↓${Math.round((download / used) * 10000) / 100}%`;
          }
          seg.push(`<blockquote expandable>${timeInfo.trim()}</blockquote>`);
        }
        
        // 5. 节点统计 (折叠)
        seg.push(`🌐 <b>节点信息</b>`);
        if (nodeInfo) {
          let nodeStats = `数量: ${nodeInfo.node_count}\n`;
          if (nodeInfo.type_count && Object.keys(nodeInfo.type_count).length)
            nodeStats +=
              `类型: ${Object.entries(nodeInfo.type_count)
                .map(([k, v]) => `${k}:${v}`).join(', ')}\n`;
          
          if (nodeInfo.regions && Object.keys(nodeInfo.regions).length) {
            nodeStats +=
              `地区分布: ${Object.entries(nodeInfo.regions)
                .map(([k, v]) => `${k}:${v}`).join(', ')}\n`;
            
            if (nodeInfo.node_count && typeof nodeInfo.node_count === 'number') {
              const topRegion = Object.entries(nodeInfo.regions)
                .sort((a, b) => b[1] - a[1])[0];
              if (topRegion)
                nodeStats +=
                  `主要: ${topRegion[0]}(${Math.round(topRegion[1] / (nodeInfo.node_count as number) * 10000) / 100}%)`;
            }
          }
          seg.push(`<blockquote expandable>${nodeStats.trim()}</blockquote>`);
        } else {
          seg.push(`(未能解析节点列表)`);
        }
        
        reports.push(seg.join('\n'));
        // --- 输出生成逻辑结束 ---
      } catch (err: any) {
        reports.push(`订阅链接: <code>${htmlEscape(url)}</code>\n<b>查询失败:</b> <code>${htmlEscape(err.message || '未知错误')}</code>`);
        stats.失败++;
      }
    }

    let resultText = reports.join('\n\n' + '='.repeat(30) + '\n\n');
    if (urls.length > 1) resultText +=
      `\n📈 <b>统计:</b> ✅有效:${stats.有效} | ⚠️耗尽:${stats.耗尽} | ⏰过期:${stats.过期} | ❌失败:${stats.失败}`;
    const messageParts = splitLongMessage(resultText, 4090);
    if (messageParts.length === 1) {
      await msg.edit({ text: messageParts[0], parseMode: "html" });
    } else {
      await msg.edit({ text: messageParts[0], parseMode: "html" });
      for (let i = 1; i < messageParts.length; i++) {
        await client.sendMessage(msg.chatId!, {
          message: messageParts[i],
          parseMode: "html",
          replyTo: msg.id
        });
      }
    }
  }
}

export default new SubinfoPlugin();

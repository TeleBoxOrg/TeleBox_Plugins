import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "telegram";
import axios from "axios";
import { JSONFilePreset } from "lowdb/node";
import path from "path";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";

// 配置 dayjs
dayjs.extend(relativeTime);
dayjs.locale('zh-cn');


// 必需工具函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const help_text = `🔍 <b>WHOIS 域名查询</b>

<b>📝 功能：</b>
• 查询域名注册信息和状态
• 显示注册/过期/更新日期
• 查看DNS服务器和注册商
• 批量查询多个域名
• 查询历史记录缓存
• 域名到期提醒

<b>🔧 使用：</b>
• <code>${mainPrefix}whois &lt;域名&gt;</code> - 查询指定域名
• <code>${mainPrefix}whois</code> - 回复包含域名的消息
• <code>${mainPrefix}whois batch &lt;域名1&gt; &lt;域名2&gt;...</code> - 批量查询
• <code>${mainPrefix}whois history</code> - 查看查询历史
• <code>${mainPrefix}whois clear</code> - 清除历史记录
• <code>${mainPrefix}whois help</code> - 显示帮助

<b>💡 示例：</b>
• <code>${mainPrefix}whois google.com</code>
• <code>${mainPrefix}whois batch google.com github.com</code>

<b>📌 说明：</b>
• 支持自动提取URL中的域名
• 支持回复消息中的域名提取
• 查询结果自动缓存24小时
• 支持批量查询（最多10个）
• 自动检测即将过期的域名`;

// 定义类型
interface WhoisRecord {
  domain: string;
  registrar?: string;
  createdDate?: string;
  expiryDate?: string;
  updatedDate?: string;
  status?: string;
  nameServers?: string[];
  rawData?: string;
  queryTime: string;
  cached?: boolean;
}

interface WhoisDB {
  history: WhoisRecord[];
  cache: Record<string, WhoisRecord>;
  settings: {
    maxHistory: number;
    cacheHours: number;
    enableNotifications: boolean;
  };
}

class WhoisPlugin extends Plugin {
  description = help_text;
  private db?: Awaited<ReturnType<typeof JSONFilePreset<WhoisDB>>>;
  private pluginDir: string;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    "whois": this.handleWhois.bind(this),
  };
  
  constructor() {
    super();
    this.pluginDir = createDirectoryInAssets("whois");
    this.initDatabase();
  }
  
  private async initDatabase() {
    const dbPath = path.join(this.pluginDir, "whois_data.json");
    const defaultData: WhoisDB = {
      history: [],
      cache: {},
      settings: {
        maxHistory: 100,
        cacheHours: 24,
        enableNotifications: true
      }
    };
    
    try {
      this.db = await JSONFilePreset<WhoisDB>(dbPath, defaultData);
    } catch (error) {
      console.error("[whois] 数据库初始化失败:", error);
    }
  }

  private async handleWhois(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    
    if (!client) {
      await msg.edit({
        text: "❌ <b>客户端未初始化</b>",
        parseMode: "html"
      });
      return;
    }
    
    try {
      // acron.ts 模式参数解析
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();
      
      // 明确请求帮助时才显示
      if (sub === "help" || sub === "h") {
        await msg.edit({ 
          text: help_text, 
          parseMode: "html" 
        });
        return;
      }
      
      // 批量查询
      if (sub === "batch") {
        await this.handleBatchQuery(msg, args.slice(1));
        return;
      }
      
      // 查看历史记录
      if (sub === "history") {
        await this.showHistory(msg);
        return;
      }
      
      // 清除历史记录
      if (sub === "clear") {
        await this.clearHistory(msg);
        return;
      }
      
      let domain = '';
      
      // 检查是否有回复消息
      if (msg.replyTo && 'replyToMsgId' in msg.replyTo && msg.replyTo.replyToMsgId) {
        try {
          const replyMsgId = msg.replyTo.replyToMsgId;
          const messages = await client.getMessages(msg.peerId!, {
            ids: [replyMsgId]
          });
          
          if (messages && messages.length > 0) {
            const replyMsg = messages[0];
            if (replyMsg.message) {
              // 提取域名的正则表达式
              const urlRegex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?(?:\.[a-zA-Z]{2,})+)/gi;
              const matches = replyMsg.message.match(urlRegex);
              if (matches && matches.length > 0) {
                // 清理域名
                domain = matches[0].replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
              }
            }
          }
        } catch (error) {
          console.error('[whois] 获取回复消息失败:', error);
        }
      }
      
      // 如果没有从回复中获取到域名，则从参数中获取
      if (!domain && sub) {
        // 清理输入的域名
        domain = sub.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
      }
      
      // 无参数时显示错误提示
      if (!domain) {
        await msg.edit({
          text: `❌ <b>参数不足</b>\n\n💡 使用 <code>${mainPrefix}whois &lt;域名&gt;</code> 查询域名信息\n💡 或回复包含域名的消息\n\n📖 使用 <code>${mainPrefix}whois help</code> 查看帮助`,
          parseMode: "html"
        });
        return;
      }
      
      // 验证域名格式
      const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?(?:\.[a-zA-Z]{2,})+$/;
      if (!domainRegex.test(domain)) {
        await msg.edit({
          text: `❌ <b>域名格式无效</b>\n\n<b>输入的域名：</b> <code>${htmlEscape(domain)}</code>\n\n💡 请输入有效的域名，例如：\n• example.com\n• google.com\n• github.io`,
          parseMode: "html"
        });
        return;
      }
      
      // 检查缓存
      const cachedResult = await this.getCachedResult(domain);
      if (cachedResult) {
        await this.displayWhoisResult(msg, cachedResult, true);
        return;
      }
      
      // 渐进式状态反馈
      await msg.edit({
        text: `🔍 <b>正在查询域名信息...</b>\n\n<b>域名：</b> <code>${htmlEscape(domain)}</code>`,
        parseMode: "html"
      });
      
      // 使用 axios 进行请求
      const response = await axios.get(`https://namebeta.com/api/search/check`, {
        params: { query: domain },
        timeout: 10000,
        headers: {
          'User-Agent': 'TeleBox/1.0'
        }
      });
      
      if (response.status === 200 && response.data) {
        const whoisData = response.data.whois?.whois;
        
        if (!whoisData) {
          await msg.edit({
            text: `❌ <b>查询失败</b>\n\n<b>域名：</b> <code>${htmlEscape(domain)}</code>\n\n💡 可能的原因：\n• 域名不存在或未注册\n• 域名格式不正确\n• WHOIS 信息不可用\n\n📖 请检查域名拼写是否正确`,
            parseMode: "html"
          });
          return;
        }
        
        // 清理和格式化 WHOIS 数据
        let cleanedData = whoisData;
        
        // 移除多余的信息
        if (cleanedData.includes("For more information")) {
          cleanedData = cleanedData.split("For more information")[0];
        }
        
        // 提取关键信息
        const extractInfo = (data: string, pattern: RegExp): string => {
          const match = data.match(pattern);
          return match ? match[1].trim() : "N/A";
        };
        
        // 尝试提取关键信息
        const registrar = extractInfo(cleanedData, /Registrar:\s*(.+)/i);
        const createdDate = extractInfo(cleanedData, /Creation Date:\s*(.+)/i);
        const expiryDate = extractInfo(cleanedData, /Registry Expiry Date:\s*(.+)/i);
        const updatedDate = extractInfo(cleanedData, /Updated Date:\s*(.+)/i);
        const status = extractInfo(cleanedData, /Domain Status:\s*(.+)/i);
        // 提取 Name Server 信息（支持多种格式）
        const nameServerRegex = /(?:Name Server|nserver|NS):\s*(.+)/gi;
        const nameServers = cleanedData.match(nameServerRegex)?.map((ns: string) => 
          ns.replace(/(?:Name Server|nserver|NS):\s*/i, '').trim()
        ).filter((ns: string) => ns && ns.length > 0) || [];
        
        // 创建 WHOIS 记录
        const whoisRecord: WhoisRecord = {
          domain,
          registrar: registrar !== "N/A" ? registrar : undefined,
          createdDate: createdDate !== "N/A" ? createdDate : undefined,
          expiryDate: expiryDate !== "N/A" ? expiryDate : undefined,
          updatedDate: updatedDate !== "N/A" ? updatedDate : undefined,
          status: status !== "N/A" ? status : undefined,
          nameServers: nameServers.length > 0 ? nameServers : undefined,
          rawData: cleanedData.trim(),
          queryTime: new Date().toISOString()
        };
        
        // 保存到缓存和历史
        await this.saveWhoisRecord(whoisRecord);
        
        // 显示结果
        await this.displayWhoisResult(msg, whoisRecord, false);
        
      } else {
        await msg.edit({
          text: `❌ <b>API 服务器错误</b>\n\n<b>状态码：</b> ${response.status}\n\n💡 请稍后重试`,
          parseMode: "html"
        });
      }
      
    } catch (error: any) {
      console.error("[whois] 插件执行失败:", error);
      
      let errorMessage = `❌ <b>查询失败</b>\n\n`;
      
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        errorMessage += `<b>错误：</b> 请求超时\n\n💡 请检查网络连接后重试`;
      } else if (error.response?.status === 429) {
        errorMessage += `<b>错误：</b> 请求过于频繁\n\n💡 请稍后再试`;
      } else if (error.response?.status === 403) {
        errorMessage += `<b>错误：</b> API 访问被拒绝\n\n💡 可能需要更换 API 服务`;
      } else if (error.response) {
        errorMessage += `<b>错误代码：</b> ${error.response.status}\n<b>错误信息：</b> ${htmlEscape(error.message)}\n\n💡 请稍后重试`;
      } else if (error.request) {
        errorMessage += `<b>错误：</b> 无法连接到 API 服务器\n\n💡 请检查网络连接`;
      } else {
        errorMessage += `<b>错误信息：</b> ${htmlEscape(error.message || '未知错误')}\n\n💡 请稍后重试`;
      }
      
      await msg.edit({
        text: errorMessage,
        parseMode: "html"
      });
    }
  }
  
  private async getCachedResult(domain: string): Promise<WhoisRecord | null> {
    if (!this.db) return null;
    
    const cache = this.db.data.cache[domain.toLowerCase()];
    if (!cache) return null;
    
    // 检查缓存是否过期
    const cacheTime = new Date(cache.queryTime).getTime();
    const now = Date.now();
    const cacheHours = this.db.data.settings.cacheHours || 24;
    
    if (now - cacheTime > cacheHours * 60 * 60 * 1000) {
      // 缓存过期，删除
      delete this.db.data.cache[domain.toLowerCase()];
      await this.db.write();
      return null;
    }
    
    return cache;
  }
  
  private async saveWhoisRecord(record: WhoisRecord) {
    if (!this.db) return;
    
    // 保存到缓存
    this.db.data.cache[record.domain.toLowerCase()] = record;
    
    // 保存到历史
    this.db.data.history.unshift(record);
    
    // 限制历史记录数量
    const maxHistory = this.db.data.settings.maxHistory || 100;
    if (this.db.data.history.length > maxHistory) {
      this.db.data.history = this.db.data.history.slice(0, maxHistory);
    }
    
    await this.db.write();
  }
  
  private async displayWhoisResult(msg: Api.Message, record: WhoisRecord, fromCache: boolean) {
    let formattedOutput = `✅ <b>WHOIS 查询结果</b>`;
    
    if (fromCache) {
      const cacheTime = dayjs(record.queryTime);
      formattedOutput += ` <i>（缓存: ${cacheTime.fromNow()}）</i>`;
    }
    
    formattedOutput += `\n\n<b>🌐 域名：</b> <code>${htmlEscape(record.domain)}</code>\n\n`;
    
    if (record.registrar) {
      formattedOutput += `<b>📋 注册商：</b> ${htmlEscape(record.registrar)}\n`;
    }
    if (record.createdDate) {
      formattedOutput += `<b>📅 注册日期：</b> ${htmlEscape(record.createdDate)}\n`;
    }
    if (record.expiryDate) {
      formattedOutput += `<b>⏰ 过期日期：</b> ${htmlEscape(record.expiryDate)}`;
      
      // 计算到期时间
      try {
        const expiryTime = new Date(record.expiryDate).getTime();
        const now = Date.now();
        const daysUntilExpiry = Math.floor((expiryTime - now) / (1000 * 60 * 60 * 24));
        
        if (daysUntilExpiry < 0) {
          formattedOutput += ` <b>⚠️ 已过期</b>`;
        } else if (daysUntilExpiry < 30) {
          formattedOutput += ` <b>⚠️ ${daysUntilExpiry} 天后过期</b>`;
        } else if (daysUntilExpiry < 90) {
          formattedOutput += ` <i>（${daysUntilExpiry} 天后过期）</i>`;
        }
      } catch (e) {
        // 日期解析失败，忽略
      }
      formattedOutput += `\n`;
    }
    if (record.updatedDate) {
      formattedOutput += `<b>🔄 更新日期：</b> ${htmlEscape(record.updatedDate)}\n`;
    }
    if (record.status) {
      formattedOutput += `<b>📊 域名状态：</b> ${htmlEscape(record.status)}\n`;
    }
    
    if (record.nameServers && record.nameServers.length > 0) {
      formattedOutput += `\n<b>🖥️ DNS 服务器：</b>\n`;
      record.nameServers.slice(0, 5).forEach(ns => {
        formattedOutput += `• <code>${htmlEscape(ns)}</code>\n`;
      });
    }
    
    // 添加原始数据（折叠显示）
    if (record.rawData) {
      formattedOutput += `\n<b>📄 原始 WHOIS 数据：</b>\n`;
      formattedOutput += `<pre>${htmlEscape(record.rawData.substring(0, 3000))}</pre>`;
      
      if (record.rawData.length > 3000) {
        formattedOutput += `\n<i>（数据已截断，仅显示前 3000 字符）</i>`;
      }
    }
    
    await msg.edit({
      text: formattedOutput,
      parseMode: "html"
    });
  }
  
  private async handleBatchQuery(msg: Api.Message, domains: string[]) {
    if (domains.length === 0) {
      await msg.edit({
        text: `❌ <b>请提供要查询的域名</b>\n\n💡 使用示例：<code>${mainPrefix}whois batch google.com github.com</code>`,
        parseMode: "html"
      });
      return;
    }
    
    if (domains.length > 10) {
      await msg.edit({
        text: `❌ <b>批量查询限制</b>\n\n每次最多查询 10 个域名，您提供了 ${domains.length} 个`,
        parseMode: "html"
      });
      return;
    }
    
    await msg.edit({
      text: `🔍 <b>批量查询中...</b>\n\n<b>域名数量：</b> ${domains.length}`,
      parseMode: "html"
    });
    
    const results: string[] = [];
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i].replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
      
      // 更新进度
      await msg.edit({
        text: `🔍 <b>批量查询中...</b>\n\n<b>进度：</b> ${i + 1}/${domains.length}\n<b>当前域名：</b> <code>${htmlEscape(domain)}</code>`,
        parseMode: "html"
      });
      
      try {
        // 检查缓存
        const cachedResult = await this.getCachedResult(domain);
        if (cachedResult) {
          results.push(`✅ <code>${htmlEscape(domain)}</code> - <i>缓存</i>`);
          successCount++;
          continue;
        }
        
        // 查询域名
        const response = await axios.get(`https://namebeta.com/api/search/check`, {
          params: { query: domain },
          timeout: 5000,
          headers: { 'User-Agent': 'TeleBox/1.0' }
        });
        
        if (response.status === 200 && response.data?.whois?.whois) {
          results.push(`✅ <code>${htmlEscape(domain)}</code>`);
          successCount++;
          
          // 保存到缓存
          const whoisData = response.data.whois.whois;
          const record: WhoisRecord = {
            domain,
            rawData: whoisData,
            queryTime: new Date().toISOString()
          };
          await this.saveWhoisRecord(record);
        } else {
          results.push(`❌ <code>${htmlEscape(domain)}</code> - 查询失败`);
          failCount++;
        }
      } catch (error) {
        results.push(`❌ <code>${htmlEscape(domain)}</code> - 查询失败`);
        failCount++;
      }
      
      // 避免请求过快
      if (i < domains.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // 显示结果
    let output = `📊 <b>批量查询完成</b>\n\n`;
    output += `<b>成功：</b> ${successCount}\n`;
    output += `<b>失败：</b> ${failCount}\n\n`;
    output += `<b>查询结果：</b>\n`;
    output += results.join('\n');
    output += `\n\n💡 使用 <code>${mainPrefix}whois history</code> 查看详细信息`;
    
    await msg.edit({
      text: output,
      parseMode: "html"
    });
  }
  
  private async showHistory(msg: Api.Message) {
    if (!this.db) {
      await msg.edit({
        text: "❌ <b>数据库未初始化</b>",
        parseMode: "html"
      });
      return;
    }
    
    const history = this.db.data.history;
    if (history.length === 0) {
      await msg.edit({
        text: `📭 <b>暂无查询历史</b>\n\n💡 使用 <code>${mainPrefix}whois &lt;域名&gt;</code> 开始查询`,
        parseMode: "html"
      });
      return;
    }
    
    let output = `📜 <b>查询历史</b> <i>（最近 ${Math.min(history.length, 20)} 条）</i>\n\n`;
    
    history.slice(0, 20).forEach((record, index) => {
      const queryTime = dayjs(record.queryTime);
      output += `${index + 1}. <code>${htmlEscape(record.domain)}</code>\n`;
      output += `   <i>${queryTime.format('MM-DD HH:mm')} (${queryTime.fromNow()})</i>\n`;
      
      if (record.expiryDate) {
        try {
          const expiryTime = new Date(record.expiryDate).getTime();
          const now = Date.now();
          const daysUntilExpiry = Math.floor((expiryTime - now) / (1000 * 60 * 60 * 24));
          
          if (daysUntilExpiry < 0) {
            output += `   ⚠️ <b>已过期</b>\n`;
          } else if (daysUntilExpiry < 30) {
            output += `   ⚠️ <b>${daysUntilExpiry} 天后过期</b>\n`;
          }
        } catch (e) {
          // 忽略日期解析错误
        }
      }
      output += `\n`;
    });
    
    output += `<b>统计信息：</b>\n`;
    output += `• 总查询次数：${history.length}\n`;
    output += `• 缓存域名数：${Object.keys(this.db.data.cache).length}\n`;
    output += `• 缓存时长：${this.db.data.settings.cacheHours} 小时\n\n`;
    output += `💡 使用 <code>${mainPrefix}whois clear</code> 清除历史记录`;
    
    await msg.edit({
      text: output,
      parseMode: "html"
    });
  }
  
  private async clearHistory(msg: Api.Message) {
    if (!this.db) {
      await msg.edit({
        text: "❌ <b>数据库未初始化</b>",
        parseMode: "html"
      });
      return;
    }
    
    const historyCount = this.db.data.history.length;
    const cacheCount = Object.keys(this.db.data.cache).length;
    
    if (historyCount === 0 && cacheCount === 0) {
      await msg.edit({
        text: "📭 <b>没有需要清除的记录</b>",
        parseMode: "html"
      });
      return;
    }
    
    // 清除数据
    this.db.data.history = [];
    this.db.data.cache = {};
    await this.db.write();
    
    await msg.edit({
      text: `🗑️ <b>清除完成</b>\n\n• 清除历史记录：${historyCount} 条\n• 清除缓存：${cacheCount} 个域名`,
      parseMode: "html"
    });
  }

}

export default new WhoisPlugin();

import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import axios from "axios";
import * as querystring from "querystring";

// HTML转义函数（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 远程配置映射
const REMOTE_MAPPINGS_URL = "https://raw.githubusercontent.com/Hyy800/Quantumult-X/refs/heads/Nana/ymys.txt";
let REMOTE_CONFIG_MAPPINGS: Record<string, string> = {};

class SubQueryPlugin extends Plugin {
  description = `📊 订阅链接信息查询工具
  
<b>命令：</b>
• <code>.subinfo [订阅链接]</code> - 查询单个订阅链接信息
• <code>.subinfo</code> - 回复包含链接的消息进行查询
• <code>.subinfo 多个链接</code> - 批量查询多个链接

<b>功能：</b>
- 查询订阅链接的流量使用情况
- 显示配置名称、使用进度、剩余流量
- 支持批量查询和统计
- 自动从远程映射获取配置名称`;

  cmdHandlers = {
    subinfo: this.handleSubQuery.bind(this)
  };

  // 格式化字节大小
  private formatBytes(size: number): string {
    if (!size || size < 0) return "0 B";
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let power = 0;
    while (size >= 1024 && power < units.length - 1) {
      size /= 1024;
      power++;
    }
    return `${size.toFixed(2)} ${units[power]}`;
  }

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
      console.error(`[SubQuery] 加载远程映射失败:`, error);
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

  // 从Content-Disposition头中获取配置名称
  private getConfigNameFromHeader(contentDisposition: string | null): string | null {
    if (!contentDisposition) return null;

    try {
      const parts = contentDisposition.split(';');
      
      // 处理 filename* 格式
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith('filename*=')) {
          const namePart = trimmed.split("''").pop();
          if (namePart) {
            try {
              return decodeURIComponent(namePart);
            } catch {
              // 忽略解码错误
            }
          }
        }
      }
      
      // 处理 filename 格式
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith('filename=')) {
          let namePart = trimmed.split('=').slice(1).join('=').trim();
          namePart = namePart.replace(/^["']|["']$/g, '');
          
          if (namePart) {
            try {
              // 尝试ISO-8859-1到UTF-8的转换
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
      console.error(`[SubQuery] 解析Content-Disposition失败:`, error);
    }
    
    return null;
  }

  // 处理单个URL
  private async processSingleUrl(url: string): Promise<any> {
    try {
      const configName = this.getConfigNameFromMappings(url);
      
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'FlClash/v0.8.76 clash-verge Platform/android'
        },
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: () => true // 不抛出HTTP错误状态
      });

      if (response.status !== 200) {
        return {
          status: "失败",
          url,
          config_name: configName,
          data: null,
          error: `HTTP ${response.status}`
        };
      }

      // 获取配置名称
      let finalConfigName = configName;
      if (!finalConfigName) {
        const contentDisposition = response.headers['content-disposition'];
        finalConfigName = this.getConfigNameFromHeader(contentDisposition);
      }

      // 解析用户信息头
      const userInfoHeader = response.headers['subscription-userinfo'];
      if (!userInfoHeader) {
        return {
          status: "失败",
          url,
          config_name: finalConfigName,
          data: null,
          error: "未找到订阅用户信息"
        };
      }

      // 解析用户信息
      const parts: Record<string, string> = {};
      const headerParts = userInfoHeader.split(';');
      
      for (const part of headerParts) {
        const equalsIndex = part.indexOf('=');
        if (equalsIndex > 0) {
          const key = part.substring(0, equalsIndex).trim().toLowerCase();
          const value = part.substring(equalsIndex + 1).trim();
          parts[key] = value;
        }
      }

      const upload = parseInt(parts.upload || '0');
      const download = parseInt(parts.download || '0');
      const total = parseInt(parts.total || '0');
      const used = upload + download;
      const remain = total > used ? total - used : 0;

      // 检查状态
      let status = "有效";
      let isExpired = false;
      let isExhausted = false;

      // 检查过期时间
      const expireTsStr = parts.expire;
      if (expireTsStr && /^\d+$/.test(expireTsStr)) {
        const expireTs = parseInt(expireTsStr);
        if (Date.now() > expireTs * 1000) {
          isExpired = true;
        }
      }

      // 检查流量耗尽
      if (total > 0 && remain <= 0) {
        isExhausted = true;
      }

      if (isExpired) {
        status = "过期";
      } else if (isExhausted) {
        status = "耗尽";
      }

      const data = {
        used,
        total,
        remain,
        expire_ts_str: expireTsStr,
        percentage: total > 0 ? (used / total * 100) : 0
      };

      return {
        status,
        url,
        config_name: finalConfigName,
        data
      };

    } catch (error: any) {
      return {
        status: "失败",
        url,
        config_name: null,
        data: null,
        error: error.message
      };
    }
  }

  // 分割长消息（处理Telegram 4096字符限制）
  private splitLongMessage(text: string, maxLength: number = 4000): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const parts: string[] = [];
    let currentPart = '';
    const lines = text.split('\n');

    for (const line of lines) {
      if (currentPart.length + line.length + 1 > maxLength) {
        if (currentPart) {
          parts.push(currentPart);
          currentPart = line;
        } else {
          // 单行就超过限制，强制分割
          const chunkSize = maxLength - 100; // 留一些余量
          for (let i = 0; i < line.length; i += chunkSize) {
            parts.push(line.substring(i, i + chunkSize));
          }
        }
      } else {
        currentPart += (currentPart ? '\n' : '') + line;
      }
    }

    if (currentPart) {
      parts.push(currentPart);
    }

    return parts;
  }

  // 主命令处理器
  private async handleSubQuery(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;

    try {
      let sourceText = "";

      // 检查是否回复消息
      if (msg.replyToMsgId) {
        try {
          const replyMsg = await msg.getReplyMessage();
          if (replyMsg) {
            sourceText = replyMsg.text || "";
          }
        } catch (error) {
          console.error(`[SubQuery] 获取回复消息失败:`, error);
        }
      }

      // 处理命令参数
      const text = msg.text || "";
      const parts = text.trim().split(/\s+/);
      
      if (parts.length > 1) {
        // 有参数时，将参数添加到源文本
        sourceText += " " + parts.slice(1).join(" ");
      }

      sourceText = sourceText.trim();

      if (!sourceText) {
        await msg.edit({
          text: "❌ <b>使用方法：</b>\n\n" +
                "• <code>.subinfo [订阅链接]</code> - 查询单个订阅\n" +
                "• 回复包含链接的消息 <code>.subinfo</code> - 查询回复中的链接\n" +
                "• <code>.subinfo 链接1 链接2 ...</code> - 批量查询多个链接",
          parseMode: "html"
        });
        return;
      }

      // 提取URL
      const urlRegex = /https?:\/\/[^\s]+/g;
      const urls = sourceText.match(urlRegex) || [];
      
      if (urls.length === 0) {
        await msg.edit({
          text: "❌ 未找到有效的链接",
          parseMode: "html"
        });
        return;
      }

      // 去重
      const uniqueUrls = Array.from(new Set(urls));
      
      await msg.edit({
        text: `🔍 找到 ${uniqueUrls.length} 个链接，正在加载配置映射...`,
        parseMode: "html"
      });

      // 加载远程映射
      const mappingsCount = await this.loadRemoteMappings();
      
      if (uniqueUrls.length > 1) {
        await msg.edit({
          text: `📚 已加载 ${mappingsCount} 条配置映射，正在并发查询 ${uniqueUrls.length} 个链接...`,
          parseMode: "html"
        });
      } else {
        await msg.edit({
          text: `📚 已加载 ${mappingsCount} 条配置映射，正在查询...`,
          parseMode: "html"
        });
      }

      // 并发处理所有URL
      const promises = uniqueUrls.map(url => this.processSingleUrl(url));
      const results = await Promise.all(promises);

      // 统计结果
      const stats = {
        "有效": 0,
        "耗尽": 0,
        "过期": 0,
        "失败": 0
      };

      const validResults: string[] = [];

      for (const result of results) {
        stats[result.status as keyof typeof stats]++;
        
        if (result.status === "有效") {
          const outputText: string[] = [];
          
          // 配置名称
          outputText.push(`📄 <b>配置名称:</b> <code>${htmlEscape(result.config_name || "未提供或无法获取")}</code>`);
          
          // 订阅链接（完整显示，不缩短）
          outputText.push(`🔗 <b>订阅链接:</b> <code>${htmlEscape(result.url)}</code>`);

          const quoteContent: string[] = [];
          const data = result.data;

          // 流量详情
          quoteContent.push(`🌈 <b>流量详情:</b> ${this.formatBytes(data.used)} / ${this.formatBytes(data.total)}`);
          
          // 进度条
          const filledBlocks = Math.round(Math.min(100, Math.max(0, data.percentage)) / 10);
          const progressBar = `[${'■'.repeat(filledBlocks)}${'□'.repeat(10 - filledBlocks)}] ${data.percentage.toFixed(1)}%`;
          quoteContent.push(`💾 <b>使用进度:</b> ${progressBar}`);
          
          // 剩余流量
          quoteContent.push(`🗃️ <b>剩余可用:</b> ${this.formatBytes(data.remain)}`);

          // 过期时间
          if (data.expire_ts_str && /^\d+$/.test(data.expire_ts_str)) {
            const expireTs = parseInt(data.expire_ts_str);
            const expireDate = new Date(expireTs * 1000);
            const formattedDate = expireDate.toLocaleString('zh-CN', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });
            
            quoteContent.push(`📅 <b>过期时间:</b> ${formattedDate}`);
            
            // 剩余时间
            const now = Date.now();
            const delta = expireTs * 1000 - now;
            if (delta > 0) {
              const days = Math.floor(delta / (1000 * 60 * 60 * 24));
              const hours = Math.floor((delta % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
              const minutes = Math.floor((delta % (1000 * 60 * 60)) / (1000 * 60));
              
              quoteContent.push(`⏳ <b>剩余时间:</b> ${days}天${hours}小时${minutes}分钟`);
            } else {
              quoteContent.push(`⏳ <b>剩余时间:</b> 已过期`);
            }
          } else {
            quoteContent.push("📅 <b>过期时间:</b> 长期有效");
          }
          
          const quotedContent = `<blockquote>${quoteContent.join('\n')}</blockquote>`;
          outputText.push(quotedContent);
          
          validResults.push(outputText.join('\n'));
        }
      }

      // 生成最终结果
      if (validResults.length > 0) {
        let resultText = validResults.join("\n\n" + "=".repeat(30) + "\n\n");
        
        // 添加统计信息（多个链接时）
        if (uniqueUrls.length > 1) {
          const statsText = `\n\n📈 <b>统计结果:</b> ✅有效:${stats.有效} | ⚠️耗尽:${stats.耗尽} | ⏰过期:${stats.过期} | ❌失败:${stats.失败}`;
          resultText += statsText;
        }
        
        // 检查消息长度，如果超过Telegram限制则分割
        const messageParts = this.splitLongMessage(resultText);
        
        if (messageParts.length === 1) {
          await msg.edit({
            text: resultText,
            parseMode: "html"
          });
        } else {
          // 发送第一部分
          await msg.edit({
            text: messageParts[0],
            parseMode: "html"
          });
          
          // 发送剩余部分
          for (let i = 1; i < messageParts.length; i++) {
            await client.sendMessage(msg.chatId, {
              message: messageParts[i],
              parseMode: "html",
              replyTo: msg.id
            });
          }
        }
      } else {
        if (uniqueUrls.length > 1) {
          const statsText = `📈 <b>统计结果:</b> ✅有效:${stats.有效} | ⚠️耗尽:${stats.耗尽} | ⏰过期:${stats.过期} | ❌失败:${stats.失败}`;
          await msg.edit({
            text: `❌ 未找到有效的订阅信息\n\n${statsText}`,
            parseMode: "html"
          });
        } else {
          await msg.edit({
            text: "❌ 未找到有效的订阅信息",
            parseMode: "html"
          });
        }
      }

    } catch (error: any) {
      console.error(`[SubQuery] 命令处理错误:`, error);
      await msg.edit({
        text: `❌ <b>发生错误:</b> ${htmlEscape(error.message || "未知错误")}`,
        parseMode: "html"
      });
    }
  }
}

export default new SubQueryPlugin();

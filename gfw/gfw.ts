import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import axios from "axios";

const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

class GfwPlugin extends Plugin {
  name = "gfw";
  description = "🌐 GFW检测工具 - 查询IP或域名是否被墙";
  
  private readonly API_URL = "https://api.potatonet.idc.wiki/network/simple_health_check/scripts/gfw_check";
  
  private isIP(ip: string): boolean {
    try {
      // 简单的IPv4验证
      const parts = ip.split('.');
      if (parts.length !== 4) return false;
      
      return parts.every(part => {
        const num = parseInt(part, 10);
        return num >= 0 && num <= 255 && part === num.toString();
      });
    } catch {
      return false;
    }
  }
  
  private async getIP(domain: string): Promise<string | null> {
    try {
      // 使用DNS解析域名
      const dns = await import('dns/promises');
      const addresses = await dns.resolve4(domain);
      return addresses[0] || null;
    } catch {
      return null;
    }
  }
  
  private async postToAPI(host: string): Promise<any> {
    try {
      const response = await axios.post(this.API_URL, { host }, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'TeleBox-GFW-Plugin/1.0'
        }
      });
      return response.data;
    } catch (error) {
      throw new Error(`API请求失败: ${error.message}`);
    }
  }
  
  private parseArguments(msg: Api.Message): string | null {
    const text = msg.text || "";
    const parts = text.trim().split(/\s+/);
    
    // 提取参数（跳过命令前缀和命令名）
    if (parts.length >= 2) {
      return parts.slice(1).join(" ");
    }
    
    // 检查是否是回复消息
    if (msg.replyToMsgId) {
      // 在实际实现中需要获取回复的消息内容
      // 这里简化处理，返回null让调用方处理
      return null;
    }
    
    return null;
  }
  
  cmdHandlers = {
    gfw: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) return;
      
      try {
        let target = this.parseArguments(msg);
        
        // 如果没有参数且是回复消息，尝试获取回复内容
        if (!target && msg.replyToMsgId) {
          const replyMsg = await msg.getReplyMessage();
          if (replyMsg && replyMsg.text) {
            target = replyMsg.text.trim().split(/\s+/)[0];
          }
        }
        
        if (!target) {
          await msg.edit({
            text: "❌ <b>使用方法:</b>\n\n" +
                  "• <code>.gfw [IP地址或域名]</code>\n" +
                  "• 回复一条包含IP或域名的消息，然后使用 <code>.gfw</code>",
            parseMode: "html"
          });
          return;
        }
        
        // 更新消息状态
        await msg.edit({
          text: `🔍🔍 正在查询 <code>${htmlEscape(target)}</code>...`,
          parseMode: "html"
        });
        
        let ipAddress = target;
        
        // 如果不是IP地址，尝试解析域名
        if (!this.isIP(target)) {
          const resolvedIP = await this.getIP(target);
          if (!resolvedIP) {
            await msg.edit({
              text: `❌❌ 域名 <code>${htmlEscape(target)}</code> 解析失败，请检查域名是否正确`,
              parseMode: "html"
            });
            return;
          }
          ipAddress = resolvedIP;
        }
        
        // 调用API查询
        const data = await this.postToAPI(ipAddress);
        
        let statusText: string;
        
        if (data.success) {
          const { tcp, icmp } = data.data;
          
          if (tcp.cn === tcp["!cn"] && icmp.cn === icmp["!cn"]) {
            if (!tcp.cn && !icmp.cn) {
              statusText = "🌍 全球不通，不能判断是否被墙";
            } else {
              statusText = "✅ 未被墙";
            }
          } else {
            statusText = "🚫 被墙";
          }
        } else {
          statusText = "❓ 查询失败";
        }
        
        const resultText = 
          `🌐 <b>GFW检测结果</b>\n\n` +
          `📡 目标: <code>${htmlEscape(target)}</code>\n` +
          (target !== ipAddress ? `🔢 解析IP: <code>${htmlEscape(ipAddress)}</code>\n` : "") +
          `📊 状态: ${statusText}\n\n` +
          `<i>💡 数据来源: GFW检测API</i>`;
        
        await msg.edit({
          text: resultText,
          parseMode: "html"
        });
        
      } catch (error: any) {
        console.error("[GFW Plugin] Error:", error);
        
        let errorMessage = "❌ 查询过程中发生错误";
        if (error.message.includes("timeout")) {
          errorMessage = "⏰ 请求超时，请稍后重试";
        } else if (error.message.includes("Network Error")) {
          errorMessage = "🌐 网络连接错误，请检查网络设置";
        } else if (error.message.includes("API请求失败")) {
          errorMessage = `🔧 ${error.message}`;
        }
        
        await msg.edit({
          text: `${errorMessage}\n\n<code>${htmlEscape(error.message)}</code>`,
          parseMode: "html"
        });
      }
    }
  };
}

export default new GfwPlugin();

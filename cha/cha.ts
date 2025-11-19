import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import axios from "axios";
import * as cheerio from "cheerio";
import dayjs from "dayjs";

class ChaPlugin extends Plugin {
  description = `🔍 订阅链接识别与查询
  
<b>使用方法：</b>
• <code>.cha [订阅链接]</code> - 查询订阅信息(可回复包含链接的消息)
• 支持自动识别机场名称、官网链接、流量信息及过期时间`;

  cmdHandlers = {
    cha: this.handleCha.bind(this)
  };

  // 格式化流量
  private formatSize(size: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let level = 0;
    while (size >= 1024 && level < units.length - 1) {
      size /= 1024;
      level++;
    }
    return `${size.toFixed(2)} ${units[level]}`;
  }

  // 格式化时长
  private formatDuration(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${days.toString().padStart(2, '0')}天${hours.toString().padStart(2, '0')}小时${minutes.toString().padStart(2, '0')}分${secs.toString().padStart(2, '0')}秒`;
  }

  // 获取机场名称
  private async getAirportName(url: string): Promise<string> {
    try {
      // 1. 处理转换链接 sub?target=
      if (url.includes("sub?target=")) {
        const match = url.match(/url=([^&]*)/);
        if (match) {
          const decodedUrl = decodeURIComponent(match[1]);
          return this.getAirportName(decodedUrl);
        }
      }

      // 2. 处理通用订阅接口 api/v1/client/subscribe
      if (url.includes("api/v1/client/subscribe?token")) {
        let targetUrl = url;
        if (!targetUrl.includes("&flag=clash")) {
          targetUrl += "&flag=clash";
        }
        try {
          const res = await axios.get(targetUrl, { timeout: 5000 });
          const disposition = res.headers['content-disposition'];
          if (disposition) {
            const match = disposition.match(/filename\*=UTF-8''(.+)/);
            if (match) {
              let filename = decodeURIComponent(match[1]);
              return filename.replace(/%20/g, " ").replace(/%2B/g, "+");
            }
          }
        } catch (e) {
          return "未知";
        }
      }

      // 3. 网页抓取识别
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (HTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
      };

      const urlMatch = url.match(/(https?:\/\/)([^/]+)/);
      let baseUrl = "";
      if (urlMatch) {
        baseUrl = urlMatch[1] + urlMatch[2];
      } else {
        return "未知";
      }

      let response;
      try {
        response = await axios.get(baseUrl + '/auth/login', { headers, timeout: 10000 });
      } catch {
        response = await axios.get(baseUrl, { headers, timeout: 5000 });
      }

      if (response.status === 200) {
        const $ = cheerio.load(response.data);
        let title = $('title').text().trim();
        title = title.replace('登录 — ', '');

        if (title.includes("Attention Required! | Cloudflare")) {
          return '该域名仅限国内IP访问';
        } else if (title.includes("Access denied") || title.includes("404 Not Found")) {
          return '该域名非机场面板域名';
        } else if (title.includes("Just a moment")) {
          return '该域名开启了5s盾';
        }
        return title || "未知";
      }

    } catch (e) {
      // console.error("Get airport name error:", e);
    }
    return "未知";
  }

  private async handleCha(msg: Api.Message): Promise<void> {
    // 获取消息内容
    let messageRaw = (msg.text || "").trim();
    
    // 如果是回复，且当前消息只有命令，则取回复内容
    const parts = messageRaw.split(/\s+/);
    if (parts.length === 1 && msg.replyToMsgId) {
        const replyMsg = await msg.getReplyMessage();
        if (replyMsg) {
            messageRaw = (replyMsg.text || "") + " " + ((replyMsg as any).caption || "");
        }
    } else if (parts.length > 1) {
        // 移除命令部分
        messageRaw = parts.slice(1).join(" ");
    }

    if (!messageRaw) {
       await msg.edit({
        text: "❌ <b>无效的参数</b>\n\n" + 
              "💡 使用方法：\n" +
              "• <code>.cha [订阅链接]</code> - 查询订阅链接\n" +
              "• 回复包含链接的消息并发送 <code>.cha</code>",
        parseMode: "html"
       });
       return;
    }

    await msg.edit({ text: "⏳ 正在查询订阅信息..." });

    const urlList = messageRaw.match(/https?:\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]/g);
    if (!urlList || urlList.length === 0) {
        await msg.edit({ text: "❌ 未找到有效的订阅链接" });
        return;
    }

    let finalOutput = "";
    const headers = {
        'User-Agent': 'ClashforWindows/0.18.1'
    };

    for (const url of urlList) {
        try {
            // 处理重定向
            let currentUrl = url;
            let res = await axios.get(currentUrl, { 
                headers, 
                timeout: 5000,
                maxRedirects: 5,
                validateStatus: (status) => status < 400 
            });

            if (res.status === 200) {
                const info = res.headers['subscription-userinfo'];
                const profileUrl = res.headers['profile-web-page-url'];

                if (!info) {
                     const airportName = await this.getAirportName(url);
                     finalOutput += `订阅链接：<code>${url}</code>\n` +
                                   `机场名称：<code>${airportName}</code>\n` +
                                   `⚠️ 无流量信息\n\n`;
                     continue;
                }

                // 解析流量信息 upload=xxx; download=xxx; total=xxx; expire=xxx
                const infoParts: Record<string, string> = {};
                if (typeof info === 'string') {
                    info.split(';').forEach((part: string) => {
                        const [key, value] = part.split('=').map((s: string) => s.trim());
                        if (key && value) infoParts[key] = value;
                    });
                }

                // 兼容正则提取（防止头部格式不规范）
                // upload=(\d+); download=(\d+); total=(\d+); expire=(\d+)
                const upload = parseInt(infoParts['upload'] || '0');
                const download = parseInt(infoParts['download'] || '0');
                const total = parseInt(infoParts['total'] || '0');
                const expire = parseInt(infoParts['expire'] || '0');

                const airportName = await this.getAirportName(url);
                
                let outputText = `订阅链接：<code>${url}</code>\n` +
                                 `机场名称：<code>${airportName}</code>\n`;
                
                if (profileUrl) {
                    outputText += `官网链接：${profileUrl}\n`;
                }

                const used = upload + download;
                const remaining = total - used;

                outputText += `订阅流量：<code>${this.formatSize(total)}</code>\n` +
                              `已用上行：<code>${this.formatSize(upload)}</code>\n` +
                              `已用下行：<code>${this.formatSize(download)}</code>\n` +
                              `已用总量：<code>${this.formatSize(used)}</code>\n` +
                              `剩余流量：<code>${this.formatSize(remaining)}</code>\n`;

                if (expire) {
                    const expireTime = dayjs.unix(expire);
                    const now = dayjs();
                    const dateStr = expireTime.format("YYYY-MM-DD HH:mm:ss");
                    
                    if (now.isBefore(expireTime)) {
                        const diffSeconds = expireTime.diff(now, 'second');
                        outputText += `过期时间：<code>${dateStr}</code>\n` +
                                      `剩余时间：<code>${this.formatDuration(diffSeconds)}</code>`;
                    } else {
                        outputText += `此订阅已于 <code>${dateStr}</code> 过期！`;
                    }
                } else {
                    outputText += `到期时间：<code>未知</code>`;
                }

                finalOutput += outputText + "\n\n";

            } else {
                 finalOutput += `无法访问 (状态码: ${res.status})\n\n`;
            }

        } catch (e: any) {
            finalOutput += `连接错误: ${e.message || e}\n\n`;
        }
    }

    await msg.edit({
        text: finalOutput || "未获取到任何信息",
        parseMode: "html",
        linkPreview: false
    });
  }
}

export default new ChaPlugin();

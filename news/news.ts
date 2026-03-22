import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getGlobalClient } from "@utils/globalClient";
import axios from "axios";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义工具
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 详细帮助文档（help子命令时显示）
const help_text = `🗞️ <b>每日新闻插件</b>

<b>📝 功能描述:</b>
• 📰 <b>每日新闻</b>：获取当日热点新闻
• 🎬 <b>历史上的今天</b>：查看历史事件
• 🧩 <b>天天成语</b>：学习成语知识
• 🎻 <b>慧语香风</b>：欣赏名人名言
• 🎑 <b>诗歌天地</b>：品味古典诗词

<b>🔧 使用方法:</b>
• <code>${mainPrefix}news</code> - 获取完整的每日资讯


<b>💡 示例:</b>
• <code>${mainPrefix}news</code> - 获取今日完整资讯包

<b>📊 数据来源:</b>
• API: news.topurl.cn
• 内容: 新闻、历史、成语、名言、诗词`;

// 新闻数据接口定义
interface NewsItem {
  title: string;
  url: string;
}

interface HistoryItem {
  event: string;
}

interface PhraseItem {
  phrase: string;
  explain: string;
}

interface SentenceItem {
  sentence: string;
  author: string;
}

interface PoemItem {
  content: string[];
  title: string;
  author: string;
}

interface NewsData {
  newsList: NewsItem[];
  historyList: HistoryItem[];
  phrase: PhraseItem;
  sentence: SentenceItem;
  poem: PoemItem;
}

interface NewsResponse {
  data: NewsData;
}

class NewsPlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  description: string = `🔧 <b>NEWS</b>

<b>📝 功能描述:</b>
每日新闻、历史上的今天、天天成语、慧语香风、诗歌天地

<b>🏷️ 命令:</b>
<code>${mainPrefix}news</code>

<b>⚡ 使用方法:</b>
<code>${mainPrefix}news [参数]</code>

<b>💡 提示:</b> 使用 <code>${mainPrefix}help</code> 查看所有命令`;
  
  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    news: async (msg: Api.Message, trigger?: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      // 参数解析（严格按acron.ts模式）
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();

      try {
        // acron.ts模式：无参数时直接执行默认操作
        if (!sub) {
          // 直接获取新闻，这是默认行为
          await this.fetchAndDisplayNews(msg, client);
          return;
        }

        // 明确请求帮助时才显示
        if (sub === "help" || sub === "h") {
          await msg.edit({
            text: help_text,
            parseMode: "html"
          });
          return;
        }

        // 未知子命令
        await msg.edit({
          text: `❌ <b>未知命令:</b> <code>${htmlEscape(sub)}</code>`,
          parseMode: "html"
        });

      } catch (error: any) {
        console.error("[news] 插件执行失败:", error);
        await msg.edit({
          text: `❌ <b>插件执行失败:</b> ${htmlEscape(error.message)}`,
          parseMode: "html"
        });
      }
    }
  };

  // 私有方法：获取并显示新闻
  private async fetchAndDisplayNews(msg: Api.Message, client: any): Promise<void> {
    try {
      // 渐进式状态更新
      await msg.edit({ text: "📰 获取中...", parseMode: "html" });

      // 使用内部导入的axios
      
      // 渐进式状态更新
      await msg.edit({ text: "📡 连接服务器...", parseMode: "html" });
      
      // 获取新闻数据
      const response = await axios.get<NewsResponse>("https://news.topurl.cn/api", {
        timeout: 15000,
        headers: {
          'User-Agent': 'TeleBox/1.0'
        }
      });

      const data = response.data?.data;
      if (!data) {
        throw new Error("API返回数据格式错误");
      }

      // 渐进式状态更新
      await msg.edit({ text: "📝 处理数据...", parseMode: "html" });

      // 构建消息内容
      const messageParts: string[] = [];

      // 每日新闻部分
      if (data.newsList && data.newsList.length > 0) {
        messageParts.push("📮 <b>每日新闻</b> 📮");
        messageParts.push("");
        data.newsList.forEach((item, index) => {
          const title = htmlEscape(item.title || "");
          const url = item.url || ""; // URL不需要HTML转义
          if (title && url) {
            messageParts.push(`${index + 1}. <a href="${url}">${title}</a>`);
          }
        });
        messageParts.push("");
      }

      // 历史上的今天部分
      if (data.historyList && data.historyList.length > 0) {
        messageParts.push("🎬 <b>历史上的今天</b> 🎬");
        messageParts.push("");
        data.historyList.forEach((item) => {
          const event = htmlEscape(item.event || "");
          if (event) {
            messageParts.push(event);
          }
        });
        messageParts.push("");
      }

      // 天天成语部分
      if (data.phrase) {
        messageParts.push("🧩 <b>天天成语</b> 🧩");
        messageParts.push("");
        const phrase = htmlEscape(data.phrase.phrase || "");
        const explain = htmlEscape(data.phrase.explain || "");
        if (phrase && explain) {
          messageParts.push(`<b>${phrase}</b>`);
          messageParts.push(`${explain}`);
        }
        messageParts.push("");
      }

      // 慧语香风部分
      if (data.sentence) {
        messageParts.push("🎻 <b>慧语香风</b> 🎻");
        messageParts.push("");
        const sentence = htmlEscape(data.sentence.sentence || "");
        const author = htmlEscape(data.sentence.author || "");
        if (sentence && author) {
          messageParts.push(`<i>${sentence}</i>`);
          messageParts.push(`—— <b>${author}</b>`);
        }
        messageParts.push("");
      }

      // 诗歌天地部分
      if (data.poem) {
        messageParts.push("🎑 <b>诗歌天地</b> 🎑");
        messageParts.push("");
        const content = data.poem.content?.join("") || "";
        const title = htmlEscape(data.poem.title || "");
        const author = htmlEscape(data.poem.author || "");
        if (content && title && author) {
          const poemContent = htmlEscape(content);
          messageParts.push(`<i>${poemContent}</i>`);
          messageParts.push(`—— 《<b>${title}</b>》${author}`);
        }
        messageParts.push("");
      }

      const finalMessage = messageParts.join("\n").trim();
      
      // 检查消息长度，如果太长则分段发送
      const MAX_LENGTH = 4000;
      if (finalMessage.length <= MAX_LENGTH) {
        await msg.edit({
          text: finalMessage || "❌ 未获取到有效数据",
          parseMode: "html"
        });
      } else {
        // 分段发送
        const chunks: string[] = [];
        let currentChunk = "";
        
        for (const part of messageParts) {
          if ((currentChunk + part + "\n").length > MAX_LENGTH) {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
              currentChunk = part + "\n";
            } else {
              // 单个部分就超长，强制截断
              chunks.push(part.substring(0, MAX_LENGTH - 3) + "...");
            }
          } else {
            currentChunk += part + "\n";
          }
        }
        
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }

        // 发送第一段（编辑原消息）
        if (chunks.length > 0) {
          await msg.edit({
            text: chunks[0],
            parseMode: "html"
          });
          
          // 发送后续段落
          for (let i = 1; i < chunks.length; i++) {
            await client.sendMessage(msg.peerId, {
              message: chunks[i],
              parseMode: "html"
            });
          }
        }
      }

    } catch (error: any) {
      console.error("[news] 获取新闻失败:", error);
      await msg.edit({
        text: `❌ <b>获取失败:</b> ${htmlEscape(error.message || "网络请求失败")}`,
        parseMode: "html"
      });
    }
  }
}

export default new NewsPlugin();

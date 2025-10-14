
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";
import axios from "axios";

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;'
  }[m] || m));

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "soutu";

const help_text = `🖼️ <b>搜图插件</b>

<b>命令格式：</b>
<code>${mainPrefix}${pluginName}</code> - 回复一张图片并使用此命令

<b>功能:</b>
回复一张图片并发送 <code>${mainPrefix}${pluginName}</code> 命令，插件会自动将其上传到临时图床 (0x0.st) 并生成 Google 和 Yandex 的搜图链接。
文件默认有效期约为30天。

<b>命令:</b>
• <code>${mainPrefix}${pluginName}</code> - 搜索图片（需要回复图片）
• <code>${mainPrefix}${pluginName} help</code> - 显示此帮助消息`;

class SoutuPlugin extends Plugin {
  description: string = `回复图片进行搜图\n\n${help_text}`;

  cmdHandlers = {
    [pluginName]: async (msg: Api.Message) => {
      // 按照规范的参数解析模式
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();

      try {
        // 无参数或help：执行搜图功能
        if (!sub) {
          await this.handleSearch(msg);
          return;
        }

        // help 在前：.soutu help
        if (sub === "help" || sub === "h") {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        // help 在后：.soutu [sub] help
        if (args[1] && (args[1].toLowerCase() === "help" || args[1].toLowerCase() === "h")) {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        // 默认行为：执行搜图
        await this.handleSearch(msg);

      } catch (error: any) {
        console.error('[soutu] 插件执行失败:', error);
        await msg.edit({ text: `❌ <b>操作失败:</b> ${htmlEscape(error.message)}`, parseMode: "html" });
      }
    },
  };

  private async handleSearch(msg: Api.Message) {
    if (!msg.replyTo) {
      await msg.edit({ text: "❌ <b>错误:</b> 请回复一张图片后使用此命令", parseMode: "html" });
      return;
    }

    const replied = await msg.getReplyMessage();
    if (!replied?.photo) {
      await msg.edit({ text: "❌ <b>错误:</b> 回复的消息不包含图片", parseMode: "html" });
      return;
    }

    await msg.edit({ text: "⏳ 正在下载并上传图片...", parseMode: "html" });
    
    try {
      const buffer = await replied.downloadMedia();
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        await msg.edit({ text: "❌ <b>错误:</b> 图片下载失败或为空", parseMode: "html" });
        return;
      }

      // 从 oxost.ts 借鉴的图片类型检测和文件名生成逻辑
      let filename = "photo.jpg";
      const head = buffer.slice(0, 8).toString('hex').toLowerCase();
      if (head.startsWith('ffd8ff')) filename = "photo.jpg";
      else if (head.startsWith('89504e47')) filename = "photo.png";
      else if (head.startsWith('47494638')) filename = "photo.gif";
      else if (head.startsWith('52494646')) filename = "photo.webp";

      const form = new globalThis.FormData();
      form.append("file", new Blob([buffer]), filename);

      const response = await axios.post("https://0x0.st", form, {
        headers: { 'User-Agent': 'curl/8.0.1' },
        timeout: 60000,
      });

      const imageUrl = response.data?.toString().trim();
      if (!imageUrl || !imageUrl.startsWith("https://0x0.st/")) {
        throw new Error("从 0x0.st 获取URL失败");
      }

      const googleUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
      const yandexUrl = `https://yandex.ru/images/search?url=${encodeURIComponent(imageUrl)}&rpt=imageview`;

      const responseText = `🖼️ <b>搜图结果:</b> (<a href="${htmlEscape(imageUrl)}">原图</a>)
有效期限: 约30天

• <a href="${googleUrl}">Google Lens</a>
• <a href="${yandexUrl}">Yandex Images</a>`;

      await msg.edit({ text: responseText, parseMode: "html" });

    } catch (error: any) {
      console.error("[soutu] 处理图片失败:", error);
      const errorText = `❌ 搜图失败: ${htmlEscape(error.message)}`;
      await msg.edit({ text: errorText, parseMode: "html" });
    }
  }
}

export default new SoutuPlugin();

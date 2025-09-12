import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";

// HTML转义工具
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 帮助文本定义
const help_text = `🔐 <b>编码解码工具集</b>

<b>可用命令：</b>
• <code>b64encode</code> - Base64 编码
• <code>b64decode</code> - Base64 解码  
• <code>urlencode</code> - URL 编码
• <code>urldecode</code> - URL 解码

<b>使用示例：</b>
• <code>${mainPrefix}b64encode Hello World</code>
• <code>${mainPrefix}b64decode SGVsbG8gV29ybGQ=</code>
• <code>${mainPrefix}urlencode 你好世界</code>
• <code>${mainPrefix}urldecode %E4%BD%A0%E5%A5%BD%E4%B8%96%E7%95%8C</code>

<b>回复消息处理：</b>
支持回复消息后直接使用命令进行编码/解码`;

class EncodePlugin extends Plugin {
  description: string = `编码解码工具插件\n\n${help_text}`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    // 显示帮助信息
    encode: async (msg: Api.Message) => {
      await msg.edit({ text: help_text, parseMode: "html" });
    },

    // Base64 编码
    b64encode: async (msg: Api.Message) => {
      await this.processEncoding(msg, "Base64", "🔐", "encode", {
        encode: (text: string) => Buffer.from(text, 'utf8').toString('base64'),
        decode: () => { throw new Error("不支持的操作"); }
      });
    },

    // Base64 解码
    b64decode: async (msg: Api.Message) => {
      await this.processEncoding(msg, "Base64", "🔐", "decode", {
        encode: () => { throw new Error("不支持的操作"); },
        decode: (text: string) => {
          try {
            const result = Buffer.from(text, 'base64').toString('utf8');
            if (!result || result.includes('\uFFFD')) {
              throw new Error("无效的 Base64 字符串");
            }
            return result;
          } catch {
            throw new Error("无效的 Base64 字符串，请检查输入");
          }
        }
      });
    },

    // URL 编码
    urlencode: async (msg: Api.Message) => {
      await this.processEncoding(msg, "URL", "🌐", "encode", {
        encode: (text: string) => encodeURIComponent(text),
        decode: () => { throw new Error("不支持的操作"); }
      });
    },

    // URL 解码
    urldecode: async (msg: Api.Message) => {
      await this.processEncoding(msg, "URL", "🌐", "decode", {
        encode: () => { throw new Error("不支持的操作"); },
        decode: (text: string) => {
          try {
            return decodeURIComponent(text);
          } catch {
            throw new Error("无效的 URL 编码字符串，请检查输入");
          }
        }
      });
    }
  };



  // 统一的编码处理逻辑
  private async processEncoding(
    msg: Api.Message,
    typeName: string, 
    icon: string,
    operation: string,
    processors: { encode: (text: string) => string; decode: (text: string) => string }
  ): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    // 标准参数解析
    const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
    const parts = lines?.[0]?.split(/\s+/) || [];
    const [, ...args] = parts; // 跳过命令本身

    try {
      // 获取要处理的文本
      const text = await this.getTextFromArgsOrReply(msg, args, operation);
      if (!text) return; // 错误已在方法内处理

      // 显示处理中状态
      await msg.edit({
        text: `🔄 <b>${typeName} ${operation === "encode" ? "编码" : "解码"}中...</b>`,
        parseMode: "html"
      });

      // 执行编码/解码
      const result = operation === "encode" 
        ? processors.encode(text) 
        : processors.decode(text);

      // 显示结果
      await this.showResult(msg, text, result, typeName, operation, icon);

    } catch (error: any) {
      console.error(`[${typeName.toLowerCase()}${operation}] 插件执行失败:`, error);
      await msg.edit({
        text: `❌ <b>${typeName} ${operation === "encode" ? "编码" : "解码"}失败:</b> ${htmlEscape(error.message)}`,
        parseMode: "html"
      });
    }
  }

  // 从参数或回复消息获取文本
  private async getTextFromArgsOrReply(msg: Api.Message, args: string[], operation: string): Promise<string | null> {
    let text = args.join(" ");
    
    // 如果没有提供文本，尝试从回复消息获取
    if (!text.trim()) {
      try {
        const reply = await msg.getReplyMessage();
        if (reply && reply.text) {
          text = reply.text.trim();
        } else {
          await msg.edit({
            text: `❌ <b>缺少文本内容</b>\n\n💡 请提供要${operation === "encode" ? "编码" : "解码"}的文本或回复一条消息`,
            parseMode: "html"
          });
          return null;
        }
      } catch (replyError: any) {
        console.error("获取回复消息失败:", replyError);
        await msg.edit({
          text: `❌ <b>缺少文本内容</b>\n\n💡 请提供要${operation === "encode" ? "编码" : "解码"}的文本`,
          parseMode: "html"
        });
        return null;
      }
    }

    return text;
  }

  // 显示处理结果
  private async showResult(
    msg: Api.Message, 
    originalText: string, 
    result: string, 
    typeName: string, 
    operation: string, 
    icon: string
  ): Promise<void> {
    const operationText = operation === "encode" ? "编码" : "解码";
    const originalPreview = originalText.length > 200 ? originalText.substring(0, 200) + "..." : originalText;
    const resultPreview = result.length > 3000 ? result.substring(0, 3000) + "..." : result;

    await msg.edit({
      text: `${icon} <b>${typeName} ${operationText}完成</b>\n\n<b>原文:</b>\n<code>${htmlEscape(originalPreview)}</code>\n\n<b>结果:</b>\n<code>${htmlEscape(resultPreview)}</code>\n\n${result.length > 3000 ? `⚠️ 结果过长，已截取前3000字符显示` : ""}`,
      parseMode: "html"
    });
  }
}

export default new EncodePlugin();

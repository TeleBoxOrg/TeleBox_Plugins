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
const help_text = `🔐 <b>编码解码插件</b>

<b>支持的命令：</b>
• <code>${mainPrefix}b64 encode [文本]</code> - Base64 编码
• <code>${mainPrefix}b64 decode [文本]</code> - Base64 解码
• <code>${mainPrefix}url encode [文本]</code> - URL 编码
• <code>${mainPrefix}url decode [文本]</code> - URL 解码

<b>回复消息处理：</b>
• <code>${mainPrefix}b64 encode</code> - 对回复的消息进行 Base64 编码
• <code>${mainPrefix}url decode</code> - 对回复的消息进行 URL 解码

<b>示例：</b>
1. <code>${mainPrefix}b64 encode Hello World</code>
2. <code>${mainPrefix}url encode 你好世界</code>
3. 回复一条消息后使用 <code>${mainPrefix}b64 decode</code>`;

class EncodePlugin extends Plugin {
  description: string = `编码解码工具插件\n\n${help_text}`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    b64: async (msg: Api.Message) => {
      await this.handleCommand(msg, "b64", "Base64", this.handleBase64.bind(this));
    },

    url: async (msg: Api.Message) => {
      await this.handleCommand(msg, "url", "URL", this.handleUrl.bind(this));
    }
  };

  // 统一的命令处理逻辑
  private async handleCommand(
    msg: Api.Message, 
    cmdName: string, 
    displayName: string, 
    handler: (msg: Api.Message, args: string[]) => Promise<void>
  ): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    // 标准参数解析（按照开发规范）
    const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
    const parts = lines?.[0]?.split(/\s+/) || [];
    const [, ...args] = parts; // 跳过命令本身
    const sub = (args[0] || "").toLowerCase();

    try {
      // 无参数时显示错误提示
      if (!sub) {
        await msg.edit({
          text: `❌ <b>参数不足</b>\n\n💡 使用 <code>${mainPrefix}${cmdName} help</code> 查看帮助`,
          parseMode: "html"
        });
        return;
      }

      // 处理 help 命令（支持双向帮助）
      if (sub === "help" || sub === "h") {
        await this.showCommandHelp(msg, cmdName, displayName, args[1]);
        return;
      }

      // 处理 help 在后的情况
      if (args[1] && (args[1].toLowerCase() === "help" || args[1].toLowerCase() === "h")) {
        await this.showCommandHelp(msg, cmdName, displayName, sub);
        return;
      }

      // 处理编码解码操作
      await handler(msg, args);

    } catch (error: any) {
      console.error(`[${cmdName}] 插件执行失败:`, error);
      await msg.edit({
        text: `❌ <b>插件执行失败:</b> ${htmlEscape(error.message)}`,
        parseMode: "html"
      });
    }
  }

  // 显示命令帮助
  private async showCommandHelp(msg: Api.Message, cmdName: string, displayName: string, subCmd?: string): Promise<void> {
    if (subCmd && (subCmd === "encode" || subCmd === "decode")) {
      const action = subCmd === "encode" ? "编码" : "解码";
      await msg.edit({ 
        text: `📖 <b>${displayName} ${action}帮助</b>\n\n<code>${mainPrefix}${cmdName} ${subCmd} &lt;文本&gt;</code> - ${displayName} ${action}\n\n支持回复消息处理`,
        parseMode: "html" 
      });
    } else {
      await msg.edit({ 
        text: `📖 <b>${displayName} 编码帮助</b>\n\n<code>${mainPrefix}${cmdName} encode &lt;文本&gt;</code> - ${displayName} 编码\n<code>${mainPrefix}${cmdName} decode &lt;文本&gt;</code> - ${displayName} 解码\n\n支持回复消息处理`,
        parseMode: "html" 
      });
    }
  }

  private async handleBase64(msg: Api.Message, args: string[]): Promise<void> {
    await this.processEncoding(msg, args, "Base64", "🔐", {
      encode: (text: string) => Buffer.from(text, 'utf8').toString('base64'),
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
  }

  private async handleUrl(msg: Api.Message, args: string[]): Promise<void> {
    await this.processEncoding(msg, args, "URL", "🌐", {
      encode: (text: string) => encodeURIComponent(text),
      decode: (text: string) => {
        try {
          return decodeURIComponent(text);
        } catch {
          throw new Error("无效的 URL 编码字符串，请检查输入");
        }
      }
    });
  }

  // 统一的编码处理逻辑
  private async processEncoding(
    msg: Api.Message, 
    args: string[], 
    typeName: string, 
    icon: string,
    processors: { encode: (text: string) => string; decode: (text: string) => string }
  ): Promise<void> {
    const operation = (args[0] || "").toLowerCase();
    
    // 验证操作类型
    if (!operation) {
      await msg.edit({
        text: `❌ <b>缺少操作类型</b>\n\n💡 使用: <code>${mainPrefix}${typeName.toLowerCase()} encode|decode [文本]</code>`,
        parseMode: "html"
      });
      return;
    }

    if (operation !== "encode" && operation !== "decode") {
      await msg.edit({
        text: `❌ <b>无效操作:</b> <code>${htmlEscape(operation)}</code>\n\n💡 支持的操作: <code>encode</code>, <code>decode</code>`,
        parseMode: "html"
      });
      return;
    }

    // 获取要处理的文本
    const text = await this.getTextFromArgsOrReply(msg, args, operation);
    if (!text) return; // 错误已在方法内处理

    // 显示处理中状态
    await msg.edit({
      text: `🔄 <b>${typeName} ${operation === "encode" ? "编码" : "解码"}中...</b>`,
      parseMode: "html"
    });

    try {
      // 执行编码/解码
      const result = operation === "encode" 
        ? processors.encode(text) 
        : processors.decode(text);

      // 显示结果
      await this.showResult(msg, text, result, typeName, operation, icon);

    } catch (error: any) {
      await msg.edit({
        text: `❌ <b>${typeName} ${operation === "encode" ? "编码" : "解码"}失败:</b> ${htmlEscape(error.message)}`,
        parseMode: "html"
      });
    }
  }

  // 从参数或回复消息获取文本
  private async getTextFromArgsOrReply(msg: Api.Message, args: string[], operation: string): Promise<string | null> {
    let text = args.slice(1).join(" ");
    
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

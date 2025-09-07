import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "telegram";


const gt = async (msg: Api.Message) => {
  let translate: any;

  try {
    // 动态导入翻译库
    const translateModule = await import("@vitalets/google-translate-api");
    translate = translateModule.translate || translateModule.default;

    if (!translate || typeof translate !== "function") {
      await msg.edit({
        text: "❌ 翻译服务未正确加载，请检查网络连接或重启程序",
        parseMode: "html",
      });
      return;
    }
  } catch (importError: any) {
    console.error("Failed to import translation service:", importError);
    await msg.edit({
      text: `❌ <b>翻译服务加载失败:</b> ${importError.message || importError}`,
      parseMode: "html",
    });
    return;
  }

  try {
    const args = msg.message.split(" ").slice(1); // Remove command part
    let text = "";
    let target = "zh-CN";

    // Check for help command
    if (args.length > 0 && ["h", "help"].includes(args[0].toLowerCase())) {
      await msg.edit({
        text: `📘 <b>使用说明：</b>

<b>基本用法：</b>
• <code>gt [文本]</code> - 翻译为中文（默认）
• <code>gt en [文本]</code> - 翻译为英文

<b>回复消息翻译：</b>
• <code>gt</code> 或 <code>gt en</code>

<b>示例：</b>
1. <code>gt Hello world</code>
2. <code>gt en 你好，世界</code>
3. 回复英文消息后 <code>gt</code>`,
        parseMode: "html",
      });
      return;
    }

    // Check if first argument is "en" for English translation
    if (args.length > 0 && args[0].toLowerCase() === "en") {
      target = "en";
      text = args.slice(1).join(" ");
    } else {
      text = args.join(" ");
    }

    // If no text provided, try to get from replied message
    if (!text.trim()) {
      try {
        const reply = await msg.getReplyMessage();
        if (reply && reply.text) {
          text = reply.text.trim();
        } else {
          await msg.edit({
            text: "❌ 请提供要翻译的文本或回复一条消息",
            parseMode: "html",
          });
          return;
        }
      } catch (replyError: any) {
        console.error("Failed to get reply message:", replyError);
        await msg.edit({
          text: "❌ 请提供要翻译的文本（无法获取回复消息）",
          parseMode: "html",
        });
        return;
      }
    }

    // 验证文本长度
    if (text.length > 5000) {
      await msg.edit({
        text: "❌ 文本过长，请保持在5000字符以内",
        parseMode: "html",
      });
      return;
    }

    // Show translating message
    await msg.edit({
      text: "🔄 <b>翻译中...</b>",
      parseMode: "html",
    });

    // Perform translation using @vitalets/google-translate-api
    let result;
    let translated;

    try {
      // 设置超时和重试机制
      const translateOptions = {
        to: target,
        timeout: 10000, // 10秒超时
      };

      result = await translate(text, translateOptions);
      translated = result?.text || result;

      if (
        !translated ||
        typeof translated !== "string" ||
        translated.trim() === ""
      ) {
        throw new Error("翻译结果为空或格式错误");
      }

      // 检查翻译质量（避免原文和译文完全相同）
      if (translated.trim() === text.trim() && text.length > 10) {
        console.warn("翻译结果与原文相同，可能翻译失败");
      }
    } catch (translateError: any) {
      console.error("Translation API error:", translateError);

      // 分类处理不同类型的错误
      let errorMsg = "翻译服务暂时不可用";
      const errorStr = String(translateError.message || translateError);

      if (errorStr.includes("timeout") || errorStr.includes("TIMEOUT")) {
        errorMsg = "翻译请求超时，请稍后重试";
      } else if (errorStr.includes("network") || errorStr.includes("NETWORK")) {
        errorMsg = "网络连接失败，请检查网络连接";
      } else if (errorStr.includes("rate limit") || errorStr.includes("429")) {
        errorMsg = "请求过于频繁，请稍后重试";
      }

      throw new Error(errorMsg);
    }

    // Send result
    const targetLang = target === "zh-CN" ? "中文" : "英文";
    const originalPreview =
      text.length > 50 ? text.substring(0, 50) + "..." : text;

    await msg.edit({
      text: `🌐 <b>翻译结果</b> (→ ${targetLang})

<b>原文:</b>
<code>${originalPreview}</code>

<b>译文:</b>
${translated}`,
      parseMode: "html",
    });
  } catch (error: any) {
    console.error("Translation error:", error);
    const errorMessage = error.message || String(error);
    const displayError =
      errorMessage.length > 100
        ? errorMessage.substring(0, 100) + "..."
        : errorMessage;

    await msg.edit({
      text: `❌ <b>翻译失败:</b> ${displayError}`,
      parseMode: "html",
    });
  }
};

class GtPlugin extends Plugin {
  description: string = `
谷歌翻译插件：
- gt [文本] - 翻译为中文（默认）
- gt en [文本] - 翻译为英文
- gt help - 显示帮助信息

也可回复一段消息后使用：
- gt 或 gt en

示例：
1. gt Hello world
2. gt en 你好，世界
3. 回复英文消息后 gt
  `;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    gt,
  };
}

export default new GtPlugin();

import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { npm_install } from "@utils/npm_install";

npm_install("@vitalets/google-translate-api");

const gtPlugin: Plugin = {
  command: ["gt"],
  description: `
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
  `,
  cmdHandler: async (msg: Api.Message) => {
    try {
      const { translate } = await import("@vitalets/google-translate-api");
      if (!translate) {
        await msg.edit({ text: "❌ 翻译服务未正确加载，请重启程序" });
        return;
      }

      const args = msg.message.split(" ").slice(1); // Remove command part
      let text = "";
      let target = "zh-CN";

      // Check for help command
      if (args.length > 0 && ["h", "help"].includes(args[0].toLowerCase())) {
        await msg.edit({
          text: `📘 使用说明：

gt [文本] - 翻译为中文（默认）
gt en [文本] - 翻译为英文

也可回复一段消息后使用：
gt 或 gt en

示例：
1. gt Hello world
2. gt en 你好，世界
3. 回复英文消息后 gt`,
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
        const reply = await msg.getReplyMessage();
        if (reply && reply.text) {
          text = reply.text.trim();
        } else {
          await msg.edit({ text: "❌ 请提供要翻译的文本或回复一条消息" });
          return;
        }
      }

      // Show translating message
      await msg.edit({ text: "🔄 翻译中..." });

      // Perform translation using @vitalets/google-translate-api
      const result = await translate(text, { to: target });
      const translated = result.text;

      // Send result
      await msg.edit({
        text: `🌐 翻译（→ \`${target}\`）：

${translated}`,
      });
    } catch (error: any) {
      console.error("Translation error:", error);
      await msg.edit({ text: `❌ 翻译失败：${error.message || error}` });
    }
  },
};

export default gtPlugin;

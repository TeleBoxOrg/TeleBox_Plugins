import axios from "axios";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { CustomFile } from "telegram/client/uploads.js";

const timeout = 60000;
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "httpcat";
const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
发送 HTTP 状态码对应的猫猫图片\n\n<code>${commandName} [状态码]</code> 例如 <code>${commandName} 404</code>
`;

class HttpCatPlugin extends Plugin {
  description: string = `\nHTTP猫猫图片\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    httpcat: async (msg: Api.Message) => {
      const args = msg.message.split(/\s+/);
      const code = args[1];
      if (!code || !/^\d{3}$/.test(code)) {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }
      const imageUrl = `https://http.cat/${code}`;
      await msg.edit({ text: `正在获取 HTTP ${code} 猫猫图片...` });
      try {
        // 获取图片数据
        const response = await axios.get(imageUrl, {
          responseType: "arraybuffer",
          timeout,
        });
        const imageBuffer = Buffer.from(response.data);
        if (!imageBuffer || imageBuffer.length === 0) {
          await msg.edit({ text: "图片获取失败或为空" });
          return;
        }
        const client = await getGlobalClient();
        const file = new CustomFile(
          `httpcat_${code}.jpg`,
          imageBuffer.length,
          "",
          imageBuffer
        );
        await client.sendFile(msg.peerId, {
          file,
          replyTo: msg.id,
        });
        await msg.delete();
      } catch (error) {
        await msg.edit({ text: `获取图片失败: ${error}` });
      }
    },
  };
}

export default new HttpCatPlugin();

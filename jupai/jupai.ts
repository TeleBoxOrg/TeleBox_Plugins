import axios from "axios";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { CustomFile } from "telegram/client/uploads.js";

const timeout = 60000;
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "jupai";
const commandName = `${mainPrefix}${pluginName}`;
const juPaiApi = "https://api.txqq.pro/api/zt.php";

const help_text = `
生成举牌小人图片

<code>${commandName} [文本]</code> - 生成举牌小人
或回复消息使用 <code>${commandName}</code> - 将回复的消息内容生成举牌小人

示例：
<code>${commandName} 你好世界</code>
`;

class JuPaiPlugin extends Plugin {
  description: string = `\n举牌小人\n\n${help_text}`;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    jupai: async (msg: Api.Message) => {
      try {
        // 获取文本内容
        const args = msg.message.split(/\s+/).slice(1);
        let text = args.join(" ");
        
        // 如果命令后没有文本，检查是否回复了消息
        if (!text) {
          const replied = msg.replyTo ? await msg.getReplyMessage() : null;
          if (replied && replied.message) {
            text = replied.message;
          }
        }
        
        // 如果还是没有文本，显示帮助信息
        if (!text) {
          await msg.edit({
            text: help_text,
            parseMode: "html"
          });
          return;
        }
        
        await msg.edit({ text: "正在生成举牌小人..." });
        
        try {
          // 构建 API URL，对文本进行 URL 编码
          const imageUrl = `${juPaiApi}?msg=${encodeURIComponent(text)}`;
          
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
          
          // 发送图片
          const client = await getGlobalClient();
          const file = new CustomFile(
            "jupai.jpg",
            imageBuffer.length,
            "",
            imageBuffer
          );
          
          await client.sendFile(msg.peerId, {
            file,
            replyTo: msg.replyTo?.replyToMsgId || msg.id,
          });
          
          await msg.delete();
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          await msg.edit({ text: `获取失败: ${errorMsg}` });
        }
      } catch (error) {
        console.error("JuPai Plugin Error:", error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        await msg.edit({ text: `插件执行失败: ${errorMsg}` });
      }
    },
  };
}

export default new JuPaiPlugin();


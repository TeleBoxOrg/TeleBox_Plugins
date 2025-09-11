/**
 * bizhi 插件类型参数说明：
 *
 * lx（类型）参数：
 *   - meizi     美女
 *   - dongman   动漫
 *   - fengjing  风景
 *   - suiji     随机
 *   - 为空      随机输出
 *
 * 行为：
 *   - 仅输入 bizhi 命令，lx 为空，随机类型壁纸
 *   - bizhi dongman，lx = dongman，输出动漫壁纸
 *   - 其他类型同理
 */
import axios from "axios";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { CustomFile } from "telegram/client/uploads.js";

const timeout = 60000;
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "bizhi";
const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
随机获取一张壁纸\n\n<code>${commandName} [分类]</code>\n分类可选：meizi, dongman, fengjing, suiji\n如 <code>${commandName} dongman</code>
`;

class BizhiPlugin extends Plugin {
  description: string = `\n随机壁纸\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    bizhi: async (msg: Api.Message) => {
      const args = msg.message.split(/\s+/);
      const lx = args[1] || "";
      const apiUrl = `https://api.btstu.cn/sjbz/api.php?method=pc${lx ? `&lx=${lx}` : ""}&format=json`;
      await msg.edit({ text: `正在获取壁纸...` });
      try {
        const response = await axios.get(apiUrl, {
          responseType: "json",
          timeout,
        });
        const data = response.data;
        if (!data || data.code !== "200" || !data.imgurl) {
          await msg.edit({ text: "壁纸获取失败或为空" });
          return;
        }
        // 获取图片数据
        const imgResponse = await axios.get(data.imgurl, {
          responseType: "arraybuffer",
          timeout,
        });
        const imageBuffer = Buffer.from(imgResponse.data);
        if (!imageBuffer || imageBuffer.length === 0) {
          await msg.edit({ text: "图片下载失败或为空" });
          return;
        }
        const client = await getGlobalClient();
        const file = new CustomFile(
          `bizhi_${lx || "suiji"}.jpg`,
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
        await msg.edit({ text: `获取壁纸失败: ${error}` });
      }
    },
  };
}

export default new BizhiPlugin();

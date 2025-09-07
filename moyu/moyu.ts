import { Plugin } from "@utils/pluginBase";
import { Api, client, TelegramClient } from "telegram";
import axios from "axios";
import { CustomFile } from "telegram/client/uploads.js";

const url = "https://api.52vmy.cn/api/wl/moyu";

const CN_TIME_ZONE = "Asia/Shanghai";

function formatCN(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: CN_TIME_ZONE });
}

class MoyuPlugin extends Plugin {
  description: string = "摸鱼日报";
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    moyu: async (msg) => {
      await msg.edit({ text: "开摸..." });
      const caption = `摸鱼日报 ${formatCN(new Date())}`;

      const res = await axios.get(url, {
        responseType: "arraybuffer",
        validateStatus: () => true,
      });

      const buf = Buffer.from(res.data);
      const file = new CustomFile(`moyu.jpg`, buf.length, "", buf);

      await msg.client?.sendFile(msg.peerId, {
        file,
        caption,
        forceDocument: false,
      });
      await msg.delete();
    },
  };
}

const plugin = new MoyuPlugin();

export default plugin;

import { NewMessageEvent } from "telegram/events";
import { Plugin } from "@utils/pluginInterface";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import download from "download";

const EAT_ASSET_PATH = path.join(process.cwd(), "assets", "eat");
const EAT_TEMP_PATH = path.join(process.cwd(), "temp", "eat");
const YOU_AVATAR_PATH = path.join(EAT_TEMP_PATH, "you.png");
const ME_AVATAR_PATH = path.join(EAT_TEMP_PATH, "me.png");
const OUT_STICKER_PATH = path.join(EAT_TEMP_PATH, "output.webp");

interface RoleConfig {
  x: number;
  y: number;
  mask: string;
}

interface EntryConfig {
  name: string;
  url: string;
  me?: RoleConfig; // 少部分有两人互动，比如 tc
  you: RoleConfig;
}

interface EatConfig {
  [key: string]: EntryConfig;
}

let config: EatConfig;

async function loadConfigResource(url:string) {
  const filePath = await assetPathFor(url)
  const content = fs.readFileSync(filePath, "utf-8")
  config = JSON.parse(content)
}

loadConfigResource("https://github.com/TeleBoxDev/TeleBox_Plugins/raw/main/eat/config.json")

// 取出表情包列表
async function sendStickerList(event: NewMessageEvent) {
  const keysText = Object.keys(config).join(",");
  await event.message.edit({
    text: `当前表情包：\n${keysText}`,
  });
}

// 随机从 config 中抽取一个 EntryConfig
function getRandomEntry(): EntryConfig {
  const values = Object.values(config); // 取出所有 EntryConfig
  const randomIndex = Math.floor(Math.random() * values.length);
  return values[randomIndex];
}

async function assetPathFor(url: string): Promise<string> {
  const pathname = new URL(url).pathname;
  const filename = path.basename(pathname);
  const filePath = path.join(EAT_ASSET_PATH, filename);

  if (!fs.existsSync(filePath)) {
    await download(url, EAT_ASSET_PATH);
    return filePath;
  }
  return filePath;
}

async function iconMaskedFor(params: {
  role: RoleConfig;
  avatar: string;
}): Promise<sharp.OverlayOptions> {
  const { role, avatar } = params;

  const maskSharp = sharp(await assetPathFor(role.mask)).ensureAlpha();
  const { width, height } = await maskSharp.metadata(); // 只读一次 metadata

  const [iconBuffer, alphaMask] = await Promise.all([
    sharp(avatar).resize(width, height).toBuffer(),
    maskSharp.clone().extractChannel("alpha").toBuffer(),
  ]);

  const iconMasked = await sharp(iconBuffer)
    .joinChannel(alphaMask)
    .png()
    .toBuffer();

  return {
    input: iconMasked,
    top: role.y,
    left: role.x,
  };
}

async function compositeWithEntryConfig(parmas: {
  entry: EntryConfig;
  event: NewMessageEvent;
}) {
  const { entry, event } = parmas;

  const basePath = await assetPathFor(entry.url);

  const replied = await event.message.getReplyMessage();
  const fromId = replied?.fromId;

  if (!fromId) {
    await event.message.edit({ text: "无法获取头像" });
    return;
  }
  await event.client?.downloadProfilePhoto(fromId, {
    outputFile: YOU_AVATAR_PATH,
  });

  let composite: sharp.OverlayOptions[] = [
    await iconMaskedFor({ role: entry.you, avatar: YOU_AVATAR_PATH }),
  ];

  // 如果有两人互动
  if (entry.me) {
    await event.client?.downloadProfilePhoto("me", {
      outputFile: ME_AVATAR_PATH,
    });
    let iconMasked = await iconMaskedFor({
      role: entry.me,
      avatar: ME_AVATAR_PATH,
    });
    composite.push(iconMasked);
  }

  await sharp(basePath)
    .composite(composite)
    .webp({ quality: 100 })
    .toFile(OUT_STICKER_PATH);
}

async function sendSticker(params: {
  entry: EntryConfig;
  event: NewMessageEvent;
}) {
  const { entry, event } = params;

  const msg = event.message;
  await msg.edit({ text: `正在生成 ${entry.name} 表情包···` });
  await compositeWithEntryConfig({ entry, event });
  await msg.delete()
  await event.client?.sendFile(msg.peerId, {
    file: OUT_STICKER_PATH,
    replyTo: await msg.getReplyMessage(),
  });
}

const eatPlugin: Plugin = {
  command: "eat",
  commandHandler: async (event: NewMessageEvent) => {
    const msg = event.message;
    if (!msg.isReply) {
      await sendStickerList(event);
      return;
    }

    const [, ...args] = msg.message.slice(1).split(" ");
    if (args.length == 0) {
      // 说明随机情况
      const entry = getRandomEntry();
      await sendSticker({ entry, event });
    } else {
      if (args[0] == "set") {
        // 设置 config.json 可能会做
      } else {
        const stickerName = args[0]
        const entrys = Object.keys(config);
        if (!entrys.includes(stickerName)) {
          await msg.edit({
            text: `找不到 ${stickerName} 该表情包，目前可用表情包如下:\n${entrys.join(",")}`
          })
          return
        }
        let entry = config[stickerName];
        await sendSticker({ entry, event });
      }
    }
  },
};

export default eatPlugin;

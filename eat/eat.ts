import { Plugin } from "@utils/pluginBase";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import download from "download";
import { Api } from "telegram";
import {
  createDirectoryInAssets,
  createDirectoryInTemp,
} from "@utils/pathHelpers";

const EAT_ASSET_PATH = createDirectoryInAssets("me");
const EAT_TEMP_PATH = createDirectoryInTemp("eat");
const YOU_AVATAR_PATH = path.join(EAT_TEMP_PATH, "you.png");
const ME_AVATAR_PATH = path.join(EAT_TEMP_PATH, "me.png");
const OUT_STICKER_PATH = path.join(EAT_TEMP_PATH, "output.webp");

interface RoleConfig {
  x: number;
  y: number;
  mask: string;
  brightness?: number;
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

let baseConfigURL =
  "https://github.com/TeleBoxDev/TeleBox_Plugins/raw/main/eat/config.json";

async function loadConfigResource(url: string, update = false) {
  if (update) {
    await download(url, EAT_ASSET_PATH);
  }
  const filePath = await assetPathFor(url);
  const content = fs.readFileSync(filePath, "utf-8");
  config = JSON.parse(content);
}

loadConfigResource(baseConfigURL);

// 取出表情包列表
async function sendStickerList(msg: Api.Message) {
  const keysText = Object.keys(config)
    .sort((a, b) => a.localeCompare(b))
    .join(",");
  await msg.edit({
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

  const pipeline = sharp(iconBuffer).joinChannel(alphaMask);
  if (role.brightness) {
    pipeline.modulate({ brightness: role.brightness });
  }

  const iconMasked = await pipeline.png().toBuffer();

  return {
    input: iconMasked,
    top: role.y,
    left: role.x,
  };
}

async function downloadProfilePhoto(msg: Api.Message): Promise<Boolean> {
  const replied = await msg.getReplyMessage();
  const fromId = replied?.fromId;
  if (!fromId) {
    await msg.edit({ text: "无法获取对方头像" });
    return false;
  }
  await msg.client?.downloadProfilePhoto(fromId, {
    outputFile: YOU_AVATAR_PATH,
  });
  return true;
}

async function downloadMedia(msg: Api.Message): Promise<Boolean> {
  const replied = await msg.getReplyMessage();
  if (!replied) {
    await msg.edit({ text: "请回复一条图片消息" });
    return false;
  }
  if (!replied.media) {
    await msg.edit({ text: "请回复一条图片消息" });
    return false;
  }
  await msg.client?.downloadMedia(replied, {
    outputFile: YOU_AVATAR_PATH,
  });
  return true;
}

async function downloadAvatar(
  msg: Api.Message,
  isEat2: Boolean
): Promise<Boolean> {
  return isEat2 ? await downloadMedia(msg) : await downloadProfilePhoto(msg);
}

async function compositeWithEntryConfig(parmas: {
  entry: EntryConfig;
  msg: Api.Message;
  isEat2: boolean;
}): Promise<void> {
  const { entry, msg, isEat2 } = parmas;

  const basePath = await assetPathFor(entry.url);

  const downloadResult = await downloadAvatar(msg, isEat2);
  if (!downloadResult) return;

  let composite: sharp.OverlayOptions[] = [
    await iconMaskedFor({ role: entry.you, avatar: YOU_AVATAR_PATH }),
  ];

  // 如果有两人互动
  if (entry.me) {
    const meId = msg.fromId;
    if (!meId) {
      await msg.edit({ text: "无法获取自己的头像" });
      return;
    }
    await msg.client?.downloadProfilePhoto(meId, {
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

  await msg.client?.sendFile(msg.peerId, {
    file: OUT_STICKER_PATH,
    replyTo: await msg.getReplyMessage(),
  });
}

async function sendSticker(params: { entry: EntryConfig; msg: Api.Message }) {
  const { entry, msg } = params;
  const cmd = msg.message.slice(1).split(" ")[0];
  const isEat2 = cmd === "eat2";
  await msg.edit({ text: `正在生成 ${entry.name} 表情包···` });
  await compositeWithEntryConfig({ entry, msg, isEat2 });
  await msg.delete();
}

async function handleSetCommand(params: {
  msg: Api.Message;
  url: string;
}): Promise<void> {
  const { msg, url } = params;
  fs.rmSync(EAT_ASSET_PATH, { recursive: true, force: true });
  await msg.edit({
    text: `✅ 删除旧的表情包配置文件成功！`,
  });
  await msg.edit({
    text: "更新表情包配置中，请稍等···",
  });
  await loadConfigResource(url, true);
  await msg.edit({
    text: `已更新表情包配置，当前表情包：\n${Object.keys(config)
      .sort((a, b) => a.localeCompare(b))
      .join(",")}`,
  });
}

const eatPlugin: Plugin = {
  command: ["eat", "eat2"],
  description:
    `表情包插件，回复 eat 来获取表情包列表\n` +
    `回复 eat set [url] 来更新表情包配置，默认配置在 ${baseConfigURL}。\n` +
    `回复 eat <表情包名称> 来发送对应的表情包，或者直接回复 eat 来随机发送一个表情包。`,
  cmdHandler: async (msg) => {
    const [, ...args] = msg.message.split(" ");
    if (!msg.isReply) {
      if (args[0] == "set") {
        let url = args[1] || baseConfigURL;
        await handleSetCommand({ msg, url });
        return;
      }

      await sendStickerList(msg);
      return;
    }

    if (args.length == 0) {
      // 说明随机情况
      const entry = getRandomEntry();
      await sendSticker({ entry, msg });
    } else {
      const stickerName = args[0];
      const entrys = Object.keys(config);
      if (!entrys.includes(stickerName)) {
        await msg.edit({
          text: `找不到 ${stickerName} 该表情包，目前可用表情包如下:\n${entrys.join(
            ","
          )}`,
        });
        return;
      }
      let entry = config[stickerName];
      await sendSticker({ entry, msg });
    }
  },
};

export default eatPlugin;

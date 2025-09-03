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

async function loadConfigResource(url: string, forceUpdate = false) {
  const filePath = await assetPathFor(url);
  
  // 如果有缓存且不强制更新，直接使用缓存
  if (!forceUpdate && fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      config = JSON.parse(content);
      return;
    } catch (error) {
      console.error("缓存文件损坏，尝试从远程下载:", error);
    }
  }
  
  // 下载最新配置
  try {
    await download(url, EAT_ASSET_PATH);
    const content = fs.readFileSync(filePath, "utf-8");
    config = JSON.parse(content);
  } catch (error) {
    console.error("从远程加载配置失败，尝试使用本地缓存:", error);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      config = JSON.parse(content);
    } else {
      throw new Error("无可用配置，远程和本地缓存均不可用");
    }
  }
}

// 初始加载（使用缓存优先）
loadConfigResource(baseConfigURL).catch(() => {
  console.log("初始配置加载失败，将在首次使用时重试");
});

// 取出表情包列表
async function sendStickerList(msg: Api.Message) {
  const stickerList = Object.keys(config)
    .sort((a, b) => a.localeCompare(b))
    .map(key => `${key} - ${config[key].name}`)
    .join('\n');
  await msg.edit({
    text: `当前表情包：\n${stickerList}`,
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

async function ensureConfigLoaded(msg?: Api.Message): Promise<void> {
  if (!config || Object.keys(config).length === 0) {
    if (msg) {
      await msg.edit({ text: "正在加载表情包配置..." });
    }
    await loadConfigResource(baseConfigURL);
  }
}

async function handleSetCommand(params: {
  msg: Api.Message;
  url: string;
}): Promise<void> {
  const { msg, url } = params;
  await msg.edit({
    text: "强制更新表情包配置中，请稍等...",
  });
  await loadConfigResource(url, true);
  const stickerList = Object.keys(config)
    .sort((a, b) => a.localeCompare(b))
    .map(key => `${key} - ${config[key].name}`)
    .join('\n');
  await msg.edit({
    text: `✅ 已强制更新表情包配置\n当前表情包：\n${stickerList}`,
  });
}

const eatPlugin: Plugin = {
  command: ["eat", "eat2"],
  description:
    `表情包插件，智能缓存机制，首次使用自动下载配置\n` +
    `• eat - 获取表情包列表（优先使用缓存）\n` +
    `• eat set [url] - 强制更新配置（覆盖缓存）\n` +
    `• 回复消息 + eat <名称> - 发送指定表情包\n` +
    `• 回复消息 + eat - 随机发送表情包`,
  cmdHandler: async (msg) => {
    const [, ...args] = msg.message.split(" ");
    
    if (!msg.isReply) {
      if (args[0] == "set") {
        let url = args[1] || baseConfigURL;
        await handleSetCommand({ msg, url });
        return;
      }
      
      // 确保配置已加载（优先使用缓存）
      await ensureConfigLoaded(msg);
      await sendStickerList(msg);
      return;
    }
    
    // 确保配置已加载（优先使用缓存）
    await ensureConfigLoaded(msg);

    if (args.length == 0) {
      // 说明随机情况
      const entry = getRandomEntry();
      await sendSticker({ entry, msg });
    } else {
      const stickerName = args[0];
      const entrys = Object.keys(config);
      if (!entrys.includes(stickerName)) {
        const stickerList = entrys
          .sort((a, b) => a.localeCompare(b))
          .map(key => `${key} - ${config[key].name}`)
          .join('\n');
        await msg.edit({
          text: `找不到 ${stickerName} 该表情包，目前可用表情包如下:\n${stickerList}`,
        });
        return;
      }
      let entry = config[stickerName];
      await sendSticker({ entry, msg });
    }
  },
};

export default eatPlugin;

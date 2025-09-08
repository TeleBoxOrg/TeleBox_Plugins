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
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const EAT_ASSET_PATH = createDirectoryInAssets("eat");
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
  you?: RoleConfig;
}

interface EatConfig {
  [key: string]: EntryConfig;
}

let config: EatConfig = {};

// + 新增此行：用于存储根据meta配置拼接好的资源基础URL
let resourceBaseUrl = "";

// + 修改此行：请将URL替换为您新配置文件的【实际Raw地址】
let baseConfigURL =
  "https://raw.githubusercontent.com/TeleBoxOrg/TeleBox_Plugins/refs/heads/main/eat/config.json";
function resolveResourceUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${resourceBaseUrl}/${path}`;
}
// eat.ts (用这个版本替换整个 loadConfigResource 函数)

async function loadConfigResource(url: string, forceUpdate = false) {
  const filePath = path.join(
    EAT_ASSET_PATH,
    path.basename(new URL(url).pathname)
  );

  const parseAndSetConfig = (content: string) => {
    const fullConfig = JSON.parse(content);
    if (!fullConfig.meta || !fullConfig.resources) {
      throw new Error("配置文件格式错误，缺少 meta 或 resources 字段");
    }

    const meta = fullConfig.meta;
    const { repo_owner, repo_name, branch, base_url_template } = meta;

    if (!repo_owner || !repo_name || !branch || !base_url_template) {
      throw new Error(
        "meta配置不完整, 缺少 repo_owner, repo_name, branch, 或 base_url_template 之一"
      );
    }

    // 动态替换模板中的占位符
    resourceBaseUrl = base_url_template
      .replace("${repo_owner}", repo_owner)
      .replace("${repo_name}", repo_name)
      .replace("${branch}", branch);

    config = fullConfig.resources;
    console.log(
      `配置加载成功，当前分支: ${branch}, 资源基础URL: ${resourceBaseUrl}`
    );
  };

  // 如果有缓存且不强制更新
  if (!forceUpdate && fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      parseAndSetConfig(content);
      return;
    } catch (error) {
      console.error("缓存文件损坏，尝试从远程下载:", error);
    }
  }

  // 下载最新配置
  try {
    // 注意: download的第二个参数是目录，它会自动使用URL中的文件名
    await download(url, EAT_ASSET_PATH);
    const content = fs.readFileSync(filePath, "utf-8");
    parseAndSetConfig(content);
  } catch (error) {
    console.error("从远程加载配置失败，尝试使用本地缓存:", error);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      parseAndSetConfig(content);
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
    .map((key) => `${key} - ${config[key].name}`)
    .join("\n");
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

  const maskSharp = sharp(
    await assetPathFor(resolveResourceUrl(role.mask))
  ).ensureAlpha(); // ✅ 已修正
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
  trigger?: Api.Message;
}): Promise<void> {
  const { entry, msg, isEat2, trigger } = parmas;

  const basePath = await assetPathFor(resolveResourceUrl(entry.url)); // ✅ 已修正

  const downloadResult = await downloadAvatar(msg, isEat2);
  if (!downloadResult) return;

  let composite: sharp.OverlayOptions[] = [];
  if (entry.you) {
    const iconMasked = await iconMaskedFor({
      role: entry.you,
      avatar: YOU_AVATAR_PATH,
    });
    composite.push(iconMasked);
  }

  // 如果有两人互动
  if (entry.me) {
    const meId = trigger?.fromId || msg.fromId;
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

async function sendSticker(params: {
  entry: EntryConfig;
  msg: Api.Message;
  trigger?: Api.Message;
}) {
  const { entry, msg, trigger } = params;
  const cmd = msg.message.slice(1).split(" ")[0];
  const isEat2 = cmd === "eat2";
  await msg.edit({ text: `正在生成 ${entry.name} 表情包···` });
  await compositeWithEntryConfig({ entry, msg, isEat2, trigger });
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
    .map((key) => `${key} - ${config[key].name}`)
    .join("\n");
  await msg.edit({
    text: `✅ 已强制更新表情包配置\n当前表情包：\n${stickerList}`,
  });
}

const fn = async (msg: Api.Message, trigger?: Api.Message) => {
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
    await sendSticker({ entry, msg, trigger });
  } else {
    const stickerName = args[0];
    const entrys = Object.keys(config);
    if (!entrys.includes(stickerName)) {
      const stickerList = entrys
        .sort((a, b) => a.localeCompare(b))
        .map((key) => `${key} - ${config[key].name}`)
        .join("\n");
      await msg.edit({
        text: `找不到 ${stickerName} 该表情包，目前可用表情包如下:\n${stickerList}`,
      });
      return;
    }
    let entry = config[stickerName];
    await sendSticker({ entry, msg, trigger });
  }
};

const help_text =
  `表情包插件，智能缓存机制，首次使用自动下载配置\n` +
  `• eat - 获取表情包列表（优先使用缓存）\n` +
  `• eat set [url] - 强制更新配置（覆盖缓存）\n` +
  `• 回复消息 + eat <名称> - 发送指定表情包\n` +
  `• 回复消息 + eat - 随机发送表情包\n\n` +
  `若想实现定时更新表情包配置, 可安装并使用 <code>${mainPrefix}tpm i acron</code>
每天2点自动更新 <code>eat</code> 的表情包配置(调用 <code>${mainPrefix}eat set</code> 命令)

<pre>${mainPrefix}acron cmd 0 0 2 * * * me 定时更新表情包
${mainPrefix}eat set</pre>
`;

class EatPlugin extends Plugin {
  description: string = `${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    eat: fn,
    eat2: fn,
  };
}

export default new EatPlugin();

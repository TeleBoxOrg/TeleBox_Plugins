import { Plugin } from "@utils/pluginBase";
import sharp from "sharp";
import axios from "axios";
import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
// 使用内存缓存，避免任何文件写入
const assetBufferCache = new Map<string, Buffer>();

interface RoleConfig {
  x: number;
  y: number;
  mask: string;
  brightness?: number;
  flip?: boolean;
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

  // 若已有配置且不强制更新，直接使用内存中的配置
  if (!forceUpdate && Object.keys(config || {}).length > 0) {
    return;
  }

  // 下载最新配置（仅内存，不落地）
  const response = await axios.get(url, { responseType: "arraybuffer" });
  const content = Buffer.from(response.data).toString("utf-8");
  parseAndSetConfig(content);
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

async function getAssetBuffer(url: string): Promise<Buffer> {
  const absoluteUrl = resolveResourceUrl(url);
  const cached = assetBufferCache.get(absoluteUrl);
  if (cached) return cached;

  const response = await axios.get(absoluteUrl, {
    responseType: "arraybuffer",
  });
  const buf = Buffer.from(response.data);
  assetBufferCache.set(absoluteUrl, buf);
  return buf;
}

async function iconMaskedFor(params: {
  role: RoleConfig;
  avatar: Buffer;
}): Promise<sharp.OverlayOptions> {
  const { role, avatar } = params;

  const maskSharp = sharp(await getAssetBuffer(role.mask)).ensureAlpha();
  const { width, height } = await maskSharp.metadata();

  let iconSharp = sharp(avatar).resize(width, height);

  if (role.flip) {
    iconSharp = iconSharp.flip(); // 如果 role.flip 为真，就上下颠倒
  }

  const [iconBuffer, alphaMask] = await Promise.all([
    iconSharp.toBuffer(),
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

async function downloadProfilePhoto(msg: Api.Message): Promise<Buffer | null> {
  const replied = await msg.getReplyMessage();
  const fromId = replied?.senderId;
  if (!fromId) {
    await msg.edit({ text: "无法获取对方头像" });
    return null;
  }

  const buf = (await msg.client?.downloadProfilePhoto(fromId, {
    isBig: false,
  })) as Buffer | undefined;
  if (!buf) return null;
  return buf;
}

async function downloadMedia(msg: Api.Message): Promise<Buffer | null> {
  const replied = await msg.getReplyMessage();
  if (!replied) {
    await msg.edit({ text: "请回复一条图片消息" });
    return null;
  }
  if (!replied.media) {
    await msg.edit({ text: "请回复一条图片消息" });
    return null;
  }
  const mimeType = (replied.media as any).document?.mimeType;
  const buf = (await msg.client?.downloadMedia(replied, {
    thumb: ["video/webm"].includes(mimeType) ? 0 : 1,
  })) as Buffer | undefined;
  if (!buf) return null;
  return buf;
}

async function downloadAvatar(
  msg: Api.Message,
  isEat2: Boolean
): Promise<Buffer | null> {
  return isEat2 ? await downloadMedia(msg) : await downloadProfilePhoto(msg);
}

async function compositeWithEntryConfig(parmas: {
  entry: EntryConfig;
  msg: Api.Message;
  isEat2: boolean;
  trigger?: Api.Message;
}): Promise<void> {
  const { entry, msg, isEat2, trigger } = parmas;

  const baseBuffer = await getAssetBuffer(entry.url);

  const youAvatarBuffer = await downloadAvatar(msg, isEat2);
  if (!youAvatarBuffer) return;

  let composite: sharp.OverlayOptions[] = [];
  if (entry.you) {
    const iconMasked = await iconMaskedFor({
      role: entry.you,
      avatar: youAvatarBuffer,
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
    const meAvatarBuffer = (await msg.client?.downloadProfilePhoto(meId, {
      isBig: false,
    })) as Buffer | undefined;
    if (!meAvatarBuffer) {
      await msg.edit({ text: "无法获取自己的头像" });
      return;
    }
    const iconMasked = await iconMaskedFor({
      role: entry.me,
      avatar: meAvatarBuffer,
    });
    composite.push(iconMasked);
  }

  const outBuffer = await sharp(baseBuffer)
    .composite(composite)
    .webp({ quality: 100 })
    .toBuffer();

  // 使用 CustomFile 指定文件名与大小，避免落地
  const file = new CustomFile("output.webp", outBuffer.length, "", outBuffer);
  await msg.client?.sendFile(msg.peerId, {
    file,
    replyTo: await msg.getReplyMessage(),
  });
}

async function sendSticker(params: {
  entry: EntryConfig;
  msg: Api.Message;
  trigger?: Api.Message;
  isEat2: boolean;
}) {
  const { entry, msg, trigger, isEat2 } = params;
  const cmd = msg.message.slice(1).split(" ")[0];
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

const fn = async (
  msg: Api.Message,
  trigger?: Api.Message,
  isEat2: boolean = false
) => {
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
    await sendSticker({ entry, msg, trigger, isEat2 });
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
    await sendSticker({ entry, msg, trigger, isEat2 });
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
    eat: async (msg, trigger?: Api.Message) => {
      await fn(msg, trigger);
    },
    eat2: async (msg: Api.Message, trigger?: Api.Message) => {
      await fn(msg, trigger, true);
    },
  };
}

export default new EatPlugin();

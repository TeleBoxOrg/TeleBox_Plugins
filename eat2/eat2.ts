import { Api } from "telegram";
import { Plugin } from "@utils/pluginBase";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import download from "download";

// --- 常量与路径 ---
const EAT_ASSET_PATH = path.join(process.cwd(), "assets", "eat");
const EAT_TEMP_PATH = path.join(process.cwd(), "temp", "eat");
const YOU_AVATAR_PATH = path.join(EAT_TEMP_PATH, "you.png");
const ME_AVATAR_PATH = path.join(EAT_TEMP_PATH, "me.png");
const OUT_STICKER_PATH = path.join(EAT_TEMP_PATH, "output.webp");

// --- 配置接口定义 ---
interface RoleConfig {
  x: number;
  y: number;
  mask: string;
}

interface EntryConfig {
  name: string;
  url: string;
  actionText?: string;
  me?: RoleConfig;
  you: RoleConfig;
}

interface EatConfig {
  [key: string]: EntryConfig;
}

// --- 全局状态 ---
let config: EatConfig = {};
let defaultConfigKey: string | null = null;
const baseConfigURL = "https://github.com/TeleBoxDev/TeleBox_Plugins/raw/main/eat/config.json";

// 保证资源目录存在
for (const dir of [EAT_ASSET_PATH, EAT_TEMP_PATH]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 加载配置文件（远程/本地），失败时初始化为空对象。
async function loadConfigResource(url: string, update = false) {
  const configFileName = "config.json";
  const configFilePath = path.join(EAT_ASSET_PATH, configFileName);
  try {
    if (update || !fs.existsSync(configFilePath)) {
      await download(url, EAT_ASSET_PATH, { filename: configFileName });
    }
    config = JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
  } catch (error) {
    console.error(`配置加载失败: ${url}`, error);
    config = {};
  }
}

// 初始化配置
loadConfigResource(baseConfigURL);

// 获取一个随机表情包配置。
function getRandomEntry(): EntryConfig | null {
  const values = Object.values(config);
  if (!values.length) return null;
  return values[Math.floor(Math.random() * values.length)];
}

// 保证远程资源本地可用。
async function assetPathFor(url: string): Promise<string> {
  const filename = path.basename(new URL(url).pathname);
  const filePath = path.join(EAT_ASSET_PATH, filename);
  if (!fs.existsSync(filePath)) await download(url, EAT_ASSET_PATH);
  return filePath;
}

// 生成遮罩头像 Overlay。
async function iconMaskedFor(params: { role: RoleConfig; avatar: string; rotate: boolean; }): Promise<sharp.OverlayOptions> {
  const { role, avatar, rotate } = params;
  const maskSharp = sharp(await assetPathFor(role.mask)).ensureAlpha();
  const { width, height } = await maskSharp.metadata();
  let avatarProcessor = sharp(avatar).resize(width, height);
  if (rotate) avatarProcessor = avatarProcessor.rotate(180);
  const iconBuffer = await avatarProcessor.toBuffer();
  const alphaMask = await maskSharp.clone().extractChannel("alpha").toBuffer();
  const iconMasked = await sharp(iconBuffer).joinChannel(alphaMask).png().toBuffer();
  return { input: iconMasked, top: role.y, left: role.x };
}

// 合成表情包主流程。
async function compositeWithEntryConfig(params: { entry: EntryConfig; msg: Api.Message; rotate: boolean; }) {
  const { entry, msg, rotate } = params;
  const replied = await msg.getReplyMessage();
  if (!replied) return await msg.edit({ text: "❌ 错误：您必须回复一条消息。" });
  if (!replied.media) return await msg.edit({ text: "❌ 错误：您回复的消息中必须包含图片或贴纸。" });
  try {
    await msg.client?.downloadMedia(replied, { outputFile: YOU_AVATAR_PATH });
  } catch (error) {
    console.error("下载媒体失败", error);
    return await msg.edit({ text: "❌ 错误：无法下载回复消息中的媒体文件。" });
  }
  const compositeOverlays: sharp.OverlayOptions[] = [await iconMaskedFor({ role: entry.you, avatar: YOU_AVATAR_PATH, rotate })];
  if (entry.me) {
    const meId = msg.fromId;
    if (!meId) return await msg.edit({ text: "❌ 错误：无法获取您自己的用户ID。" });
    await msg.client?.downloadProfilePhoto(meId, { outputFile: ME_AVATAR_PATH });
    if (!fs.existsSync(ME_AVATAR_PATH)) return await msg.edit({ text: "❌ 错误：无法下载您的头像，您设置了吗？" });
    compositeOverlays.push(await iconMaskedFor({ role: entry.me, avatar: ME_AVATAR_PATH, rotate: false }));
  }
  const basePath = await assetPathFor(entry.url);
  await sharp(basePath).composite(compositeOverlays).webp({ quality: 100 }).toFile(OUT_STICKER_PATH);
  await msg.client?.sendFile(msg.peerId, { file: OUT_STICKER_PATH, replyTo: replied });
}

// 发送所有可用表情包列表。
async function sendStickerList(msg: Api.Message) {
  if (!Object.keys(config).length) return await msg.edit({ text: '❌ 配置为空，请使用 `eat2 set` 命令加载配置。', parseMode: 'markdown' });
  const keysText = Object.keys(config).sort().join(", ");
  await msg.edit({ text: `ℹ️ **可用表情包:**\n\`${keysText}\``, parseMode: "markdown" });
}

// 生成并发送表情包。
async function sendSticker(params: { entry: EntryConfig; msg: Api.Message; rotate: boolean; }) {
  const { entry, msg, rotate } = params;
  const actionText = entry.actionText || entry.name;
  await msg.edit({ text: `⚙️ 正在生成 '${actionText}' 表情包...` });
  try {
    await compositeWithEntryConfig({ entry, msg, rotate });
    await msg.delete();
  } catch (error) {
    console.error("表情包生成失败", error);
    await msg.edit({ text: `❌ 生成表情包时发生错误。` });
  }
}

// 处理 set 命令，更新配置。
async function handleSetCommand(params: { msg: Api.Message; url: string; }) {
  const { msg, url } = params;
  await msg.edit({ text: "🗑️ 正在删除旧资源..." });
  fs.rmSync(EAT_ASSET_PATH, { recursive: true, force: true });
  fs.mkdirSync(EAT_ASSET_PATH, { recursive: true });
  await msg.edit({ text: "🔄 正在更新配置，请稍候..." });
  try {
    await loadConfigResource(url, true);
    const keys = Object.keys(config).sort().join(", ");
    await msg.edit({ text: `✅ **配置已更新！**\n\nℹ️ **可用表情包:**\n\`${keys}\``, parseMode: "markdown" });
  } catch (error) {
    console.error("配置更新失败", error);
    await msg.edit({ text: `❌ 从该URL加载新配置失败。` });
  }
}

const eatPlugin: Plugin = {
  command: ["eat2"],
  description: `
一个功能强大的表情包生成器。

**用法:**

- \`eat2 ! \` 或 \`eat2\`: 列出所有可用的表情包模板。
- 回复一个**带图片或贴纸**的消息并发送 \`eat2 <名称>\`: 生成指定的表情包。
- 回复一个**带图片或贴纸**的消息并发送 \`eat2\`: 生成一个随机表情包（如果设置了默认则使用默认的）。
- 回复一个**带图片或贴纸**的消息并发送 \`eat2 .<名称>\`: 生成图片旋转180°的表情包。
- \`eat2 -<名称>\`: 将一个表情包设置为 \`eat2\` 命令的默认选项。
- \`eat2 -\`: 清除默认表情包设置。
- \`eat2 set [url]\`: 从新的配置URL更新表情包。 (如果没有提供URL，则使用默认地址)。
  `,
  cmdHandler: async (msg: Api.Message) => {
    const [command, ...args] = msg.message.slice(1).split(" ");
    const primaryArg = args[0] || "";

    // 非回复消息的命令分发
    if (!msg.isReply) {
      if (primaryArg === "set") {
        const url = args[1] || baseConfigURL;
        await handleSetCommand({ msg, url });
        return;
      }

      if (primaryArg.startsWith("-")) {
        const key = primaryArg.substring(1);
        if (key) {
          if (config && config[key]) {
            defaultConfigKey = key;
            await msg.edit({ text: `✅ 默认表情包已设置为: \`${defaultConfigKey}\``, parseMode: 'markdown' });
          } else {
            await msg.edit({ text: `❌ 未找到名为 \`${key}\` 的表情包。`, parseMode: 'markdown' });
          }
        } else {
          defaultConfigKey = null;
          await msg.edit({ text: `🗑️ 默认表情包设置已清除。` });
        }
        return;
      }
      await sendStickerList(msg);
      return;
    }

    // 回复消息的命令分发
    let stickerName = primaryArg;
    let rotate = false;

    if (primaryArg.startsWith(".")) {
      rotate = true;
      stickerName = primaryArg.substring(1);
    }

    let entry: EntryConfig | null = null;

    if (stickerName) {
      entry = config[stickerName];
    } else {
      if (defaultConfigKey && config[defaultConfigKey]) {
        entry = config[defaultConfigKey];
      } else {
        entry = getRandomEntry();
      }
    }

    if (!entry) {
      if (!Object.keys(config).length) {
        await msg.edit({ text: '❌ 配置为空或加载失败，无法生成表情包。', parseMode: 'markdown' });
        return;
      }
      const available = Object.keys(config).join(", ");
      await msg.edit({
        text: `❌ 未找到名为 \`${stickerName || '随机'}\` 的表情包。\n\n**可用:**\n\`${available}\``,
        parseMode: "markdown",
      });
      return;
    }

    await sendSticker({ entry, msg, rotate });
  },
};

export default eatPlugin;

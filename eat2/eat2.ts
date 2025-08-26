import { Api } from "telegram";
import { Plugin } from "@utils/pluginBase";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import download from "download";

// --- Constants and Paths ---
const EAT_ASSET_PATH = path.join(process.cwd(), "assets", "eat");
const EAT_TEMP_PATH = path.join(process.cwd(), "temp", "eat");
const YOU_AVATAR_PATH = path.join(EAT_TEMP_PATH, "you.png");
const ME_AVATAR_PATH = path.join(EAT_TEMP_PATH, "me.png");
const OUT_STICKER_PATH = path.join(EAT_TEMP_PATH, "output.webp");

// --- Interfaces for Configuration ---
interface RoleConfig {
  x: number;
  y: number;
  mask: string;
}

interface EntryConfig {
  name: string;
  url: string;
  actionText?: string; // Custom text for "Generating..." message
  me?: RoleConfig;     // Optional config for the sender's avatar
  you: RoleConfig;      // Config for the replied-to user's avatar
}

interface EatConfig {
  [key: string]: EntryConfig;
}

// --- Global State ---
let config: EatConfig;
let defaultConfigKey: string | null = null; // To store the default sticker key
const baseConfigURL =
  "https://github.com/TeleBoxDev/TeleBox_Plugins/raw/main/eat/config.json";

// Ensure asset and temp directories exist
if (!fs.existsSync(EAT_ASSET_PATH)) {
  fs.mkdirSync(EAT_ASSET_PATH, { recursive: true });
}
if (!fs.existsSync(EAT_TEMP_PATH)) {
    fs.mkdirSync(EAT_TEMP_PATH, { recursive: true });
}


// --- Core Functions ---

/**
 * Loads the configuration file from a URL, downloading it if necessary.
 * @param url The URL of the config.json file.
 * @param update If true, forces a re-download of the config.
 */
async function loadConfigResource(url: string, update = false) {
  const configFileName = "config.json";
  const configFilePath = path.join(EAT_ASSET_PATH, configFileName);
  try {
    if (update || !fs.existsSync(configFilePath)) {
      await download(url, EAT_ASSET_PATH, { filename: configFileName });
    }
    const content = fs.readFileSync(configFilePath, "utf-8");
    config = JSON.parse(content);
  } catch (error) {
    console.error(`Failed to load or parse config from ${url}:`, error);
    // Initialize with empty config to prevent crashes
    config = {};
  }
}

// Initial load of the configuration
loadConfigResource(baseConfigURL);

/**
 * Gets a random sticker entry from the loaded configuration.
 * @returns A random EntryConfig object.
 */
function getRandomEntry(): EntryConfig | null {
  const values = Object.values(config);
  if (values.length === 0) return null;
  const randomIndex = Math.floor(Math.random() * values.length);
  return values[randomIndex];
}

/**
 * Ensures a remote asset (like a mask or base image) is available locally, downloading it if not.
 * @param url The URL of the asset.
 * @returns The local file path to the asset.
 */
async function assetPathFor(url: string): Promise<string> {
  const pathname = new URL(url).pathname;
  const filename = path.basename(pathname);
  const filePath = path.join(EAT_ASSET_PATH, filename);

  if (!fs.existsSync(filePath)) {
    await download(url, EAT_ASSET_PATH);
  }
  return filePath;
}

/**
 * Creates a masked and positioned avatar overlay for compositing.
 * @param params - The role configuration, avatar path, and rotation flag.
 * @returns A sharp.OverlayOptions object ready for compositing.
 */
async function iconMaskedFor(params: {
  role: RoleConfig;
  avatar: string;
  rotate: boolean;
}): Promise<sharp.OverlayOptions> {
  const { role, avatar, rotate } = params;

  const maskSharp = sharp(await assetPathFor(role.mask)).ensureAlpha();
  const { width, height } = await maskSharp.metadata();

  // Prepare the avatar processor pipeline
  let avatarProcessor = sharp(avatar).resize(width, height);
  if (rotate) {
    avatarProcessor = avatarProcessor.rotate(180);
  }
  const iconBuffer = await avatarProcessor.toBuffer();

  const alphaMask = await maskSharp.clone().extractChannel("alpha").toBuffer();

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

/**
 * Composites avatars onto a base image according to the entry config.
 * @param params - The entry config, event object, and rotation flag.
 */
async function compositeWithEntryConfig(params: {
  entry: EntryConfig;
  msg: Api.Message;
  rotate: boolean;
}) {
  const { entry, msg, rotate } = params;

  const replied = await msg.getReplyMessage();
  if (!replied) {
    await msg.edit({ text: "❌ 错误：您必须回复一条消息。" });
    return;
  }

  // Check if the replied message has media (photo or sticker)
  if (!replied.media) {
    await msg.edit({ text: "❌ 错误：您回复的消息中必须包含图片或贴纸。" });
    return;
  }

  // Download the media from the replied message
  try {
      await msg.client?.downloadMedia(replied, {
          outputFile: YOU_AVATAR_PATH,
      });
    } catch (error) {
      console.error("Failed to download media:", error);
      await msg.edit({ text: "❌ 错误：无法下载回复消息中的媒体文件。" });
      return;
    }

  // Create the overlay for the target media
  const compositeOverlays: sharp.OverlayOptions[] = [
    await iconMaskedFor({ role: entry.you, avatar: YOU_AVATAR_PATH, rotate }),
  ];

  // If the template supports a second avatar (the sender's profile pic), process it
  if (entry.me) {
      const meId = msg.fromId;
      if (!meId) {
        await msg.edit({ text: "❌ 错误：无法获取您自己的用户ID。" });
        return;
      }
      await msg.client?.downloadProfilePhoto(meId, {
        outputFile: ME_AVATAR_PATH,
      });
     if (!fs.existsSync(ME_AVATAR_PATH)) {
       await msg.edit({ text: "❌ 错误：无法下载您的头像，您设置了吗？" });
       return;
     }
    const myIconMasked = await iconMaskedFor({
      role: entry.me,
      avatar: ME_AVATAR_PATH,
      rotate: false, // Sender's avatar is never rotated
    });
    compositeOverlays.push(myIconMasked);
  }

  const basePath = await assetPathFor(entry.url);

  // Perform the image composition
  await sharp(basePath)
    .composite(compositeOverlays)
    .webp({ quality: 100 })
    .toFile(OUT_STICKER_PATH);

  // Send the final sticker
    await msg.client?.sendFile(msg.peerId, {
      file: OUT_STICKER_PATH,
      replyTo: replied,
    });
}


// --- Command Handlers ---

/**
 * Sends a list of available sticker keys to the chat.
 */
async function sendStickerList(msg: Api.Message) {
  if (Object.keys(config).length === 0) {
      await msg.edit({ text: '❌ 配置为空，请使用 `eat2 set` 命令加载配置。', parseMode: 'markdown' });
      return;
    }
    const keysText = Object.keys(config)
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
    await msg.edit({
    text: `ℹ️ **可用表情包:**\n\`${keysText}\``,
    parseMode: "markdown",
  });
}

/**
 * Handles the logic for creating and sending a sticker.
 */
async function sendSticker(params: {
  entry: EntryConfig;
  msg: Api.Message;
  rotate: boolean;
}) {
  const { entry, msg, rotate } = params;
  const actionText = entry.actionText || entry.name;

  await msg.edit({ text: `⚙️ 正在生成 '${actionText}' 表情包...` });
  try {
    await compositeWithEntryConfig({ entry, msg, rotate });
    await msg.delete();
  } catch (error) {
    console.error("Sticker generation failed:", error);
    await msg.edit({ text: `❌ 生成表情包时发生错误。` });
  }
}

/**
 * Handles the 'set' command to update the configuration from a new URL.
 */
async function handleSetCommand(params: {
  msg: Api.Message;
  url: string;
}) {
  const { msg, url } = params;

  await msg.edit({ text: "🗑️ 正在删除旧资源..." });
  fs.rmSync(EAT_ASSET_PATH, { recursive: true, force: true });
  fs.mkdirSync(EAT_ASSET_PATH, { recursive: true });

  await msg.edit({ text: "🔄 正在更新配置，请稍候..." });
  try {
    await loadConfigResource(url, true);
    const keys = Object.keys(config).sort((a, b) => a.localeCompare(b)).join(", ");
    await msg.edit({
      text: `✅ **配置已更新！**\n\nℹ️ **可用表情包:**\n\`${keys}\``,
      parseMode: "markdown",
    });
  } catch (error) {
    console.error("Failed to update config:", error);
    await msg.edit({ text: `❌ 从该URL加载新配置失败。` });
  }
}

// --- Main Plugin Definition ---
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

    // --- Command routing for non-reply messages ---
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
      
      // Default action for non-replies is to list stickers
      await sendStickerList(msg);
      return;
    }

    // --- Command routing for messages that are replies ---
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
      // No name provided: use default or random
      if (defaultConfigKey && config[defaultConfigKey]) {
        entry = config[defaultConfigKey];
      } else {
        entry = getRandomEntry();
      }
    }

    if (!entry) {
      if (Object.keys(config).length === 0) {
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

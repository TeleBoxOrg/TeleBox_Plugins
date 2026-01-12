import { Plugin } from "@utils/pluginBase";
import sharp from "sharp";
import axios from "axios";
import {
  createDirectoryInAssets,
  createDirectoryInTemp,
} from "@utils/pathHelpers";
import { getPrefixes } from "@utils/pluginManager";
import path from "path";
import fs from "fs";
import { Api } from "telegram";
import { encode, UnencodedFrame } from "modern-gif";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// 由于gif可能很多帧，最好缓存在本地，而不是每次都远程拿不同的帧数
const ASSET_PATH = createDirectoryInAssets("eatgif");
// 用来保存缓存的gif资源以及webm资源
const TEMP_PATH = createDirectoryInTemp("eatgif");

interface RoleConfig {
  x: number;
  y: number;
  mask: string;
  rotate?: number;
  brightness?: number;
}

interface GifResConfig {
  url: string;
  delay?: number;
  me?: RoleConfig;
  you?: RoleConfig;
}

// 表情包详细配置
interface EatGifConfig {
  width: number;
  height: number;
  res: GifResConfig[];
}

// 各种表情包配置列表
interface EatGifListConfig {
  [key: string]: { url: string; desc: string };
}

// 测试时可以更换主体url
const baseRepoURL =
  "https://github.com/TeleBoxOrg/TeleBox_Plugins/raw/refs/heads/main/eatgif/";
const baseConfigURL = baseRepoURL + "config.json";

let config: EatGifListConfig;

// 还是每次生命周期仅加载一次资源，或者 clear 来重载
async function loadGifListConfig(url: string): Promise<void> {
  const res = await axios.get(url);
  config = res.data;
}
loadGifListConfig(baseConfigURL);

// 命令前缀与帮助
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "eatgif";
const commandName = `${mainPrefix}${pluginName}`;

const help_text = `🧩 <b>头像动图表情</b>

<b>用法：</b>
<code>${commandName} [list|ls|clear|名称]</code>
• <b>空/ list</b>：查看表情列表
• <b>生成</b>：回复目标并输入名称

<b>指定用户：</b>
• <code>${commandName} 名称 @A @B</code> - A 对 B
• <code>${commandName} 名称 @B</code> (回复A) - A 对 B
• <code>${commandName} 名称</code> (回复B) - 自己对 B`;

const htmlEscape = (text: string): string =>
  String(text || "").replace(
    /[&<>"']/g,
    (m) =>
      ((
        {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#x27;",
        } as any
      )[m] || m)
  );

async function ensureConfig(): Promise<void> {
  if (!config) await loadGifListConfig(baseConfigURL);
}

async function loadGifDetailConfig(url: string): Promise<EatGifConfig> {
  const res = await axios.get(baseRepoURL + url);
  return res.data;
}

// 由于很多帧，每个帧又有不同的mask等配置，最好就是缓存
async function assetBufferFor(filePath: string): Promise<Buffer> {
  const localPath = path.join(ASSET_PATH, filePath);
  const url = baseRepoURL + filePath;
  if (fs.existsSync(localPath)) {
    const buffer: Buffer = fs.readFileSync(localPath);
    return buffer;
  }
  const res = await axios.get(url, { responseType: "arraybuffer" });
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, res.data);
  return res.data;
}

class EatGifPlugin extends Plugin {
  description: string = `生成头像融合动图\n\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    eatgif: async (msg, trigger) => {
      await this.handleEatGif(msg, trigger);
    },
    // eatgif2
  };

  private async handleEatGif(msg: Api.Message, trigger?: Api.Message) {
    const firstLine = (msg.message || msg.text || "").split(/\r?\n/g)[0] || "";
    const parts = firstLine.trim().split(/\s+/) || [];
    const [, ...args] = parts;
    const sub = (args[0] || "").toLowerCase();

    // 提取 @用户名参数
    const mentionedUsers = args.slice(1).filter((arg) => arg.startsWith("@"));

    try {
      await ensureConfig();

      if (!sub || sub === "list" || sub === "ls") {
        await msg.edit({ text: this.listAllStickers(), parseMode: "html" });
        return;
      }

      if (sub === "help" || sub === "h") {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }

      if (sub === "clear") {
        await this.clearRes(msg);
        return;
      }

      if (!Object.keys(config).includes(sub)) {
        const text = `❌ 未找到 <code>${htmlEscape(
          sub
        )}</code>\n\n${this.listAllStickers()}`;
        await msg.edit({ text, parseMode: "html" });
        return;
      }

      // 检查是否有足够的用户信息
      const hasReply = msg.isReply || trigger?.isReply;
      const hasTwoMentions = mentionedUsers.length >= 2;
      const hasOneMention = mentionedUsers.length === 1;

      if (!hasReply && !hasTwoMentions) {
        await msg.edit({
          text: `💡 请指定两个用户或回复一个用户的消息

<b>用法：</b>
• <code>${commandName} ${sub} @A @B</code> - A 对 B
• <code>${commandName} ${sub} @B</code> (回复A) - A 对 B
• <code>${commandName} ${sub}</code> (回复B) - 自己对 B`,
          parseMode: "html",
        });
        return;
      }

      await msg.edit({
        text: `⏳ 正在生成 <b>${htmlEscape(config[sub].desc)}</b>...`,
        parseMode: "html",
      });
      await this.generateGif(sub, { msg, trigger, mentionedUsers });
    } catch (e: any) {
      await msg.edit({
        text: `❌ 失败：${htmlEscape(e?.message || String(e))}`,
        parseMode: "html",
      });
    }
  }

  private listAllStickers(): string {
    const keys = Object.keys(config || {});
    const items = keys.map(
      (k) => `• <code>${htmlEscape(k)}</code> - ${htmlEscape(config[k].desc)}`
    );
    const header = `🧩 <b>可用表情列表</b>\n使用：<code>${commandName} &lt;名称&gt;</code>（需回复Ta）\n\n`;
    return header + items.join("\n");
  }

  private async clearRes(msg: Api.Message): Promise<void> {
    fs.rmSync(ASSET_PATH, { recursive: true, force: true });
    await loadGifListConfig(baseConfigURL);
    await msg.edit({ text: "🧹 已清理缓存并刷新配置", parseMode: "html" });
  }

  private getRandomEatGif(): string {
    let keys = Object.keys(config);
    const randomIndex = Math.floor(Math.random() * keys.length);
    return keys[randomIndex];
  }

  private async generateGif(
    gifName: string,
    params: { msg: Api.Message; trigger?: Api.Message; mentionedUsers?: string[] }
  ) {
    const { msg, trigger, mentionedUsers = [] } = params;
    const gifConfig = await loadGifDetailConfig(config[gifName].url);

    // 获取头像的逻辑：
    // 1. .eatgif kiss @A @B -> A 对 B
    // 2. 回复A + .eatgif kiss @B -> A 对 B
    // 3. 回复B + .eatgif kiss -> 自己对 B

    let meAvatarBuffer: Buffer | undefined;
    let youAvatarBuffer: Buffer | undefined;

    if (mentionedUsers.length >= 2) {
      // 情况1: 指定了两个用户 @A @B
      meAvatarBuffer = await this.getAvatarByUsername(msg, mentionedUsers[0]);
      youAvatarBuffer = await this.getAvatarByUsername(msg, mentionedUsers[1]);
    } else if (mentionedUsers.length === 1) {
      // 情况2: 回复A + 指定@B
      meAvatarBuffer = await this.getReplyUserAvatarBuffer(msg, trigger);
      youAvatarBuffer = await this.getAvatarByUsername(msg, mentionedUsers[0]);
    } else {
      // 情况3: 回复B（原有逻辑）
      meAvatarBuffer = await this.getSelfAvatarBuffer(msg, trigger);
      youAvatarBuffer = await this.getReplyUserAvatarBuffer(msg, trigger);
    }

    if (!meAvatarBuffer) {
      await msg.edit({ text: "❌ 无法获取用户A的头像", parseMode: "html" });
      await msg.deleteWithDelay(2000);
      return;
    }
    if (!youAvatarBuffer) {
      await msg.edit({ text: "❌ 无法获取用户B的头像", parseMode: "html" });
      await msg.deleteWithDelay(2000);
      return;
    }
    let tasks = [];
    for (let i = 0; i < gifConfig.res.length; i++) {
      const entry = gifConfig.res[i];
      tasks.push(
        this.compositeWithEntryConfig(entry, {
          youAvatarBuffer,
          meAvatarBuffer,
        })
      );
    }
    const result = await Promise.all(tasks);

    if (result.length === 0 || result.every((r) => !r)) {
      await msg.edit({ text: "合成动图失败" });
      return;
    }

    let frames: UnencodedFrame[] = [];
    for (let i = 0; i < gifConfig.res.length; i++) {
      const buffer = result[i];
      if (!buffer) continue;
      const data = Buffer.from(buffer);
      const delay = gifConfig.res[i].delay;
      frames.push({
        data,
        delay: delay ? delay : 100,
      });
    }

    const output = await encode({
      width: gifConfig.width,
      height: gifConfig.height,
      frames,
    });

    const gifPath = path.join(TEMP_PATH, "output.gif");
    const webmPath = path.join(TEMP_PATH, "output.webm");

    fs.writeFileSync(gifPath, Buffer.from(output));

    const cmd = `ffmpeg -y -i ${gifPath} -c:v libvpx-vp9 -b:v 0 -crf 41 -pix_fmt yuva420p -auto-alt-ref 0 ${webmPath}`;

    try {
      await msg.edit({ text: "⏳ 正在转换为 webm 格式..." });
      await execAsync(cmd);
      await msg.client?.sendFile(msg.peerId, {
        file: webmPath,
        attributes: [
          new Api.DocumentAttributeSticker({
            alt: "✨",
            stickerset: new Api.InputStickerSetEmpty(),
          }),
        ],
        replyTo: await msg.getReplyMessage(),
      });
    } catch (e) {
      console.log("exec ffmpeg error", e);
      await msg.edit({ text: `生成 webm 失败 ${e}` });
      await msg.client?.sendFile(msg.peerId, {
        file: gifPath,
        replyTo: await msg.getReplyMessage(),
      });
    }

    await msg.delete();

    fs.rmSync(gifPath, { force: true, recursive: true });
    fs.rmSync(webmPath, { force: true, recursive: true });
  }

  // 合成每一帧
  private async compositeWithEntryConfig(
    entry: GifResConfig,
    parmas: {
      youAvatarBuffer: Buffer;
      meAvatarBuffer: Buffer;
    }
  ): Promise<Buffer | undefined> {
    const { youAvatarBuffer, meAvatarBuffer } = parmas;

    const mainCanvas = await assetBufferFor(entry.url);

    let composite: sharp.OverlayOptions[] = [];
    if (entry.you) {
      const iconMasked = await this.iconMaskedFor(entry.you, youAvatarBuffer);
      composite.push(iconMasked);
    }

    // 如果有两人互动
    if (entry.me) {
      const iconMasked = await this.iconMaskedFor(entry.me, meAvatarBuffer);
      composite.push(iconMasked);
    }

    const outBuffer = await sharp(mainCanvas)
      .composite(composite)
      .raw()
      .toBuffer();

    return outBuffer;
  }

  // 拿到每一帧头像位置及裁剪形状
  private async iconMaskedFor(
    role: RoleConfig,
    avatar: Buffer
  ): Promise<sharp.OverlayOptions> {
    const maskBuffer = await assetBufferFor(role.mask);
    const { width: maskWidth, height: maskHeight } = await sharp(
      maskBuffer
    ).metadata();

    let iconRotate = await sharp(avatar)
      .resize(maskWidth, maskHeight)
      .toBuffer();

    if (role.rotate) {
      iconRotate = await sharp(iconRotate).rotate(role.rotate).toBuffer();
    }
    if (role.brightness) {
      iconRotate = await sharp(iconRotate)
        .modulate({ brightness: role.brightness })
        .toBuffer();
    }

    let iconSharp = sharp(iconRotate);

    const { width: iconWidth, height: iconHeight } = await iconSharp.metadata();

    const left = Math.max(0, Math.floor((iconWidth - maskWidth) / 2));
    const top = Math.max(0, Math.floor((iconHeight - maskHeight) / 2));

    let cropped = iconSharp.extract({
      left,
      top,
      width: maskWidth,
      height: maskHeight,
    });

    let iconMasked = await cropped
      .composite([
        {
          input: maskBuffer,
          blend: "dest-in", // 保留 mask 区域
        },
      ])
      .png()
      .toBuffer();

    return {
      input: iconMasked,
      top: role.y,
      left: role.x,
    };
  }
  // 获取自己的头像
  private async getSelfAvatarBuffer(
    msg: Api.Message,
    trigger?: Api.Message
  ): Promise<Buffer | undefined> {
    const meId = trigger?.fromId || msg.fromId;
    if (!meId) {
      return;
    }
    const meAvatarBuffer = (await msg.client?.downloadProfilePhoto(meId, {
      isBig: false,
    })) as Buffer | undefined;
    // 检查 buffer 是否有效
    if (!meAvatarBuffer || meAvatarBuffer.length === 0) {
      return await this.generateDefaultAvatar("Me");
    }
    return meAvatarBuffer;
  }

  // 获取被回复用户的头像
  private async getReplyUserAvatarBuffer(
    msg: Api.Message,
    trigger?: Api.Message
  ): Promise<Buffer | undefined> {
    let replyTo = await msg.getReplyMessage();
    if (!replyTo) {
      replyTo = await trigger?.getReplyMessage();
    }
    if (!replyTo?.senderId) return;
    const avatarBuffer = await msg.client?.downloadProfilePhoto(
      replyTo?.senderId,
      {
        isBig: false,
      }
    );
    // 检查 buffer 是否有效
    if (!avatarBuffer || (avatarBuffer as Buffer).length === 0) {
      // 尝试获取用户名生成默认头像
      const sender = replyTo.sender as any;
      const name = sender?.firstName || sender?.username || "User";
      return await this.generateDefaultAvatar(name);
    }
    return avatarBuffer as Buffer | undefined;
  }

  // 通过用户名获取头像
  private async getAvatarByUsername(
    msg: Api.Message,
    username: string
  ): Promise<Buffer | undefined> {
    try {
      // 移除 @ 前缀
      const cleanUsername = username.startsWith("@") ? username.slice(1) : username;
      const entity = await msg.client?.getEntity(cleanUsername);
      if (!entity) return;
      const avatarBuffer = await msg.client?.downloadProfilePhoto(entity, {
        isBig: false,
      });
      // 检查 buffer 是否有效
      if (!avatarBuffer || (avatarBuffer as Buffer).length === 0) {
        // 用户没有头像，生成默认头像
        return await this.generateDefaultAvatar(cleanUsername);
      }
      return avatarBuffer as Buffer | undefined;
    } catch (e) {
      console.log(`获取用户 ${username} 头像失败:`, e);
      return;
    }
  }

  // 生成默认头像（当用户没有设置头像时）
  private async generateDefaultAvatar(name: string): Promise<Buffer> {
    // 根据名字生成一个颜色
    const colors = [
      "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4",
      "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F",
      "#BB8FCE", "#85C1E9", "#F8B500", "#00CED1"
    ];
    const colorIndex = name.charCodeAt(0) % colors.length;
    const bgColor = colors[colorIndex];

    // 获取首字母
    const initial = name.charAt(0).toUpperCase();

    // 使用 sharp 生成一个带首字母的圆形头像
    const size = 200;
    const svg = `
      <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="${bgColor}"/>
        <text x="50%" y="50%" font-size="80" font-family="Arial, sans-serif"
              fill="white" text-anchor="middle" dominant-baseline="central">
          ${initial}
        </text>
      </svg>
    `;

    return await sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toBuffer();
  }

  private async getMediaAvatarBuffer(
    msg: Api.Message,
    trigger?: Api.Message
  ): Promise<Buffer | undefined> {
    return;
  }
}

export default new EatGifPlugin();

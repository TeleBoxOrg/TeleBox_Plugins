import { Plugin } from "@utils/pluginBase";
import sharp from "sharp";
import axios from "axios";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import path from "path";
import fs from "fs";
import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import { encode, UnencodedFrame } from "modern-gif";

// 由于gif可能很多帧，最好缓存在本地，而不是每次都远程拿不同的帧数
const ASSET_PATH = createDirectoryInAssets("eatgif");

interface RoleConfig {
  x: number;
  y: number;
  mask: string;
  rotate?: number;
  brightness?: number;
}

interface GifResConfig {
  url: string;
  delay?: number
  me?: RoleConfig;
  you?: RoleConfig;
}

// 表情包详细配置
interface EatGifConfig {
  desc: string;
  width: number;
  height: number;
  res: GifResConfig[];
}

// 各种表情包配置列表
interface EatGifListConfig {
  [key: string] : string
}
// 不再有 eatgif set，每次使用 eatgif 就会重新获取
let config: EatGifListConfig;

// 测试时可以更换主体url
const baseRepoURL = "https://github.com/TeleBoxOrg/TeleBox_Plugins/raw/main/eatgif/";
const baseConfigURL = baseRepoURL + "config.json";
// 理论上可以下载别的仓库的文件保存在本地，但是直接拿取实时数据得了
async function loadGifListConfig(url: string): Promise<EatGifListConfig> {
  const res = await axios.get(url);
  config = res.data as EatGifListConfig;
  return config;
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
  fs.mkdirSync(path.dirname(localPath), {recursive: true})
  fs.writeFileSync(localPath, res.data);
  return res.data;
}

class EatGifPlugin extends Plugin {
  description: string = "生成 eat GIF 版的有趣表情包";
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
    await loadGifListConfig(baseConfigURL);
    if (!msg.isReply && !trigger?.isReply) {
      await msg.edit({ text: "请回复一个人" });
      return;
    }
    const [, ...arg] = msg.message.split(" ");
    const eatGif = arg[0];
    if (!eatGif) {
      await this.generateGif(this.getRandomEatGif(), {msg, trigger});
      return;
    }
    if (!Object.keys(config).includes(eatGif)) {
      await msg.edit({ text: `没找到 ${eatGif} 这个表情包` });
      await msg.deleteWithDelay(2000);
      return;
    }
    await this.generateGif(eatGif, {msg, trigger});
  }

  private getRandomEatGif(): string {
    let keys = Object.keys(config);
    const randomIndex = Math.floor(Math.random() * keys.length);
    return keys[randomIndex];
  }

  private async generateGif(
    gifName: string,
    params: { msg: Api.Message; trigger?: Api.Message }
  ) {
    const { msg, trigger } = params;
    const gifConfig = await loadGifDetailConfig(config[gifName]);
    await msg.edit({text: `正在生成 ${gifConfig.desc} 表情包`});

    // 由于要生成很多张图片，最好就是保存 self.avatar 以及 you.avatar 不断调用
    const meAvatarBuffer = await this.getSelfAvatarBuffer(msg, trigger);
    if (!meAvatarBuffer) {
      await msg.edit({ text: "无法获取自己的头像" });
            await msg.deleteWithDelay(2000);
      return;
    }
    const youAvatarBuffer = await this.getYouAvatarBuffer(msg, trigger);
    if (!youAvatarBuffer) {
      await msg.edit({ text: "无法获取对方的头像" });
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
      const buffer = result[i]
      if (!buffer) continue;
      const data = Buffer.from(buffer)
      const delay = gifConfig.res[i].delay;
      frames.push({
        data,
        delay: delay ? delay : 100
      })
    }

    const output = await encode({
      width: gifConfig.width,
      height: gifConfig.height,
      frames,
    });

    const file = new CustomFile(
      "output.gif",
      output.byteLength,
      "",
      Buffer.from(output)
    );
    await msg.client?.sendFile(msg.peerId, {
      file,
      replyTo: await msg.getReplyMessage(),
    });

    await msg.delete();
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
    const maskSharp = sharp(await assetBufferFor(role.mask)).ensureAlpha();
    const { width, height } = await maskSharp.metadata();

    let iconSharp = sharp(avatar).resize(width, height);
    if (role.rotate) {
      iconSharp = iconSharp.rotate(role.rotate);
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

  // 获取头像等数据
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
    return meAvatarBuffer;
  }

  private async getYouAvatarBuffer(
    msg: Api.Message,
    trigger?: Api.Message
  ): Promise<Buffer | undefined> {
    let replyTo = await msg.getReplyMessage();
    if (!replyTo) {
      replyTo = await trigger?.getReplyMessage();
    }
    if (!replyTo?.senderId) return;
    const youAvatarBuffer = await msg.client?.downloadProfilePhoto(
      replyTo?.senderId,
      {
        isBig: false,
      }
    );
    return youAvatarBuffer as Buffer | undefined;
  }

  private async getMediaAvatarBuffer(msg: Api.Message, trigger?: Api.Message): Promise<Buffer | undefined> {
    return
  }
}

export default new EatGifPlugin();

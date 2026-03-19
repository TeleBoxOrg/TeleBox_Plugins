// YVLU Plugin - 生成文字语录贴纸
//@ts-nocheck
import axios from "axios";
import _ from "lodash";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import {
  createDirectoryInAssets,
  createDirectoryInTemp,
} from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs";
import { getGlobalClient } from "@utils/globalClient";
import { reviveEntities } from "@utils/tlRevive";
import {
  dealCommandPluginWithMessage,
  getCommandFromMessage,
} from "@utils/pluginManager";
import { sleep } from "teleproto/Helpers";
import dayjs from "dayjs";
import { CustomFile } from "teleproto/client/uploads.js";
import * as zlib from "zlib";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const timeout = 60000; // 超时
const PYTHON_PATH = "python3"; // Python 路径，可修改为 venv 中的路径，如："/path/to/venv/bin/python"

const hashCode = (s: any) => {
  const l = s.length;
  let h = 0;
  let i = 0;
  if (l > 0) {
    while (i < l) {
      h = ((h << 5) - h + s.charCodeAt(i++)) | 0;
    }
  }
  return h;
};

// 检测是否为 webm 格式
function isWebmFormat(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 4) return false;
  // WebM 魔数: 0x1A 0x45 0xDF 0xA3 (EBML header)
  return (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  );
}

// 检测是否为 TGS 格式 (gzip 压缩的 Lottie JSON)
function isTgsFormat(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 2) return false;
  // gzip 魔数: 0x1F 0x8B
  return buffer[0] === 0x1f && buffer[1] === 0x8b;
}

// 检查 TGS 转换依赖
async function checkTgsDependencies(): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    await execFileAsync(PYTHON_PATH, [
      "-c",
      "from rlottie_python import LottieAnimation",
    ]);
  } catch (e) {
    return {
      ok: false,
      message:
        "缺少 rlottie-python 依赖，请运行: pip3 install rlottie-python Pillow --break-system-packages",
    };
  }
  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch (e) {
    return {
      ok: false,
      message: "缺少 ffmpeg，请安装: apt-get install -y ffmpeg",
    };
  }
  return { ok: true, message: "" };
}

// TGS 转 WebM (使用 rlottie-python + ffmpeg)
async function convertTgsToWebm(tgsBuffer: Buffer): Promise<Buffer> {
  const os = await import("os");
  const tmpDir = os.tmpdir();
  const uniqueId =
    Date.now().toString() + "_" + Math.random().toString(36).slice(2);
  const tgsPath = path.join(tmpDir, `sticker_${uniqueId}.tgs`);
  const gifPath = path.join(tmpDir, `sticker_${uniqueId}.gif`);
  const webmPath = path.join(tmpDir, `sticker_${uniqueId}.webm`);

  try {
    fs.writeFileSync(tgsPath, tgsBuffer);

    const pythonScript = `
import sys
from rlottie_python import LottieAnimation
anim = LottieAnimation.from_tgs(sys.argv[1])
anim.save_animation(sys.argv[2])
`;

    await execFileAsync(PYTHON_PATH, ["-c", pythonScript, tgsPath, gifPath]);

    await execFileAsync("ffmpeg", [
      "-i",
      gifPath,
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-b:v",
      "400k",
      "-auto-alt-ref",
      "0",
      "-an",
      "-y",
      webmPath,
    ]);

    const webmBuffer = fs.readFileSync(webmPath);
    return webmBuffer;
  } finally {
    try {
      fs.unlinkSync(tgsPath);
    } catch (e) {}
    try {
      fs.unlinkSync(gifPath);
    } catch (e) {}
    try {
      fs.unlinkSync(webmPath);
    } catch (e) {}
  }
}

// 检测是否为动态 WebP
function isAnimatedWebP(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;

  // 检查 RIFF + WEBP 头
  if (
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return false;
  }

  // 搜索 ANIM 块
  for (let i = 12; i < buffer.length - 4; i++) {
    if (buffer.toString("ascii", i, i + 4) === "ANIM") {
      return true;
    }
  }
  return false;
}
// 检测是否为 MP4 格式
function isMp4Format(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;
  // MP4 魔数: ftyp 在偏移 4-8
  const ftyp = buffer.toString("ascii", 4, 8);
  return ftyp === "ftyp";
}

// MP4 转 WebM (使用 ffmpeg)
async function convertMp4ToWebm(mp4Buffer: Buffer): Promise<Buffer> {
  const os = await import("os");
  const tmpDir = os.tmpdir();
  const uniqueId =
    Date.now().toString() + "_" + Math.random().toString(36).slice(2);
  const mp4Path = path.join(tmpDir, `video_${uniqueId}.mp4`);
  const webmPath = path.join(tmpDir, `video_${uniqueId}.webm`);

  try {
    fs.writeFileSync(mp4Path, mp4Buffer);

    await execFileAsync("ffmpeg", [
      "-i",
      mp4Path,
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-b:v",
      "400k",
      "-auto-alt-ref",
      "0",
      "-an",
      "-y",
      webmPath,
    ]);

    const webmBuffer = fs.readFileSync(webmPath);
    return webmBuffer;
  } finally {
    try {
      fs.unlinkSync(mp4Path);
    } catch (e) {}
    try {
      fs.unlinkSync(webmPath);
    } catch (e) {}
  }
}

// 读取WebP图片尺寸的辅助函数
function getWebPDimensions(imageBuffer: any): {
  width: number;
  height: number;
} {
  try {
    // 如果是 WebM 格式，直接返回默认尺寸
    if (isWebmFormat(imageBuffer)) {
      return { width: 512, height: 512 };
    }

    // WebP文件格式解析
    if (imageBuffer.length < 30) {
      throw new Error("Invalid WebP file: too short");
    }

    // 检查RIFF头
    if (imageBuffer.toString("ascii", 0, 4) !== "RIFF") {
      throw new Error("Invalid WebP file: missing RIFF header");
    }

    // 检查WEBP标识
    if (imageBuffer.toString("ascii", 8, 12) !== "WEBP") {
      throw new Error("Invalid WebP file: missing WEBP signature");
    }

    // 读取VP8或VP8L头
    const chunkHeader = imageBuffer.toString("ascii", 12, 16);

    if (chunkHeader === "VP8 ") {
      // VP8格式
      const width = imageBuffer.readUInt16LE(26) & 0x3fff;
      const height = imageBuffer.readUInt16LE(28) & 0x3fff;
      return { width, height };
    } else if (chunkHeader === "VP8L") {
      // VP8L格式
      const data = imageBuffer.readUInt32LE(21);
      const width = (data & 0x3fff) + 1;
      const height = ((data >> 14) & 0x3fff) + 1;
      return { width, height };
    } else if (chunkHeader === "VP8X") {
      // VP8X格式
      const width = (imageBuffer.readUInt32LE(24) & 0xffffff) + 1;
      const height = (imageBuffer.readUInt32LE(27) & 0xffffff) + 1;
      return { width, height };
    }

    // 如果无法解析，返回默认尺寸
    console.warn("Unknown WebP format, using default dimensions");
    return { width: 512, height: 768 };
  } catch (error) {
    console.warn("Failed to parse WebP dimensions:", error);
    return { width: 512, height: 768 };
  }
}

const getPeerNumericId = (peer?: Api.TypePeer): number | undefined => {
  if (!peer) return undefined;
  if (peer instanceof Api.PeerUser) return peer.userId;
  if (peer instanceof Api.PeerChat) return -peer.chatId;
  if (peer instanceof Api.PeerChannel) return -peer.channelId;
  return undefined;
};

const resolveForwardSenderFromHeader = async (
  forwardHeader: Api.MessageFwdHeader,
  client: any,
) => {
  if (!forwardHeader) return undefined;

  const displayName =
    forwardHeader.fromName ||
    forwardHeader.savedFromName ||
    forwardHeader.postAuthor ||
    "";
  const fallbackName = displayName || "未知来源";

  const peerCandidates = [
    forwardHeader.fromId,
    forwardHeader.savedFromPeer,
    forwardHeader.savedFromId,
  ].filter(Boolean);

  for (const peer of peerCandidates) {
    try {
      const entity = await client?.getEntity(peer as any);
      if (entity) {
        return entity;
      }
    } catch (error) {
      const errMsg = (error?.errorMessage || error?.message || "").toString();
      if (!errMsg.includes("CHANNEL_PRIVATE")) {
        console.warn("解析转发发送者失败", error);
      }
    }
  }

  return {
    id:
      getPeerNumericId(
        forwardHeader.fromId ||
          forwardHeader.savedFromId ||
          forwardHeader.savedFromPeer,
      ) || hashCode(fallbackName),
    firstName: fallbackName,
    lastName: "",
    username: forwardHeader.postAuthor || undefined,
    title: fallbackName,
    name: fallbackName,
  };
};

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "yvlu";

const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
- 不包含回复
使用 <code>${commandName} [消息数]</code> 回复一条消息(支持选择部分引用回复) ⚠️ 不得超过 5 条

- 包含回复
使用 <code>${commandName} r [消息数]</code> 回复一条消息(支持选择部分引用回复) ⚠️ 不得超过 5 条


- 保存贴纸/图片到贴纸包
使用 <code>${commandName} s</code> 回复一张贴纸或图片,将其保存到配置的贴纸包中

- 配置管理
使用 <code>${commandName} config</code> 查看当前配置
使用 <code>${commandName} config sticker 贴纸包名称</code> 设置贴纸包名称
`;

// 转换Telegram消息实体为quote-api格式
function convertEntities(entities: Api.TypeMessageEntity[]): any[] {
  if (!entities) return [];

  return entities.map((entity) => {
    // console.log(entity);
    const baseEntity = {
      offset: entity.offset,
      length: entity.length,
    };

    if (entity instanceof Api.MessageEntityBold) {
      return { ...baseEntity, type: "bold" };
    } else if (entity instanceof Api.MessageEntityItalic) {
      return { ...baseEntity, type: "italic" };
    } else if (entity instanceof Api.MessageEntityUnderline) {
      return { ...baseEntity, type: "underline" };
    } else if (entity instanceof Api.MessageEntityStrike) {
      return { ...baseEntity, type: "strikethrough" };
    } else if (entity instanceof Api.MessageEntityCode) {
      return { ...baseEntity, type: "code" };
    } else if (entity instanceof Api.MessageEntityPre) {
      return { ...baseEntity, type: "pre" };
    } else if (entity instanceof Api.MessageEntityCustomEmoji) {
      const documentId = (entity as any).documentId;
      const custom_emoji_id =
        documentId?.value?.toString() || documentId?.toString() || "";
      return {
        ...baseEntity,
        type: "custom_emoji",
        custom_emoji_id,
      };
    } else if (entity instanceof Api.MessageEntityUrl) {
      return { ...baseEntity, type: "url" };
    } else if (entity instanceof Api.MessageEntityTextUrl) {
      return {
        ...baseEntity,
        type: "text_link",
        url: (entity as any).url || "",
      };
    } else if (entity instanceof Api.MessageEntityMention) {
      return { ...baseEntity, type: "mention" };
    } else if (entity instanceof Api.MessageEntityMentionName) {
      return {
        ...baseEntity,
        type: "text_mention",
        user: { id: (entity as any).userId },
      };
    } else if (entity instanceof Api.MessageEntityHashtag) {
      return { ...baseEntity, type: "hashtag" };
    } else if (entity instanceof Api.MessageEntityCashtag) {
      return { ...baseEntity, type: "cashtag" };
    } else if (entity instanceof Api.MessageEntityBotCommand) {
      return { ...baseEntity, type: "bot_command" };
    } else if (entity instanceof Api.MessageEntityEmail) {
      return { ...baseEntity, type: "email" };
    } else if (entity instanceof Api.MessageEntityPhone) {
      return { ...baseEntity, type: "phone_number" };
    } else if (entity instanceof Api.MessageEntitySpoiler) {
      return { ...baseEntity, type: "spoiler" };
    }

    return baseEntity;
  });
}

// 调用quote-api生成语录
async function generateQuote(
  quoteData: any,
): Promise<{ buffer: Buffer; ext: string }> {
  try {
    const response = await axios({
      method: "post",
      timeout,
      data: quoteData,
      responseType: "arraybuffer",
      ...JSON.parse(
        Buffer.from(
          "eyJ1cmwiOiJodHRwczovL3F1b3RlLWFwaS1lbmhhbmNlZC56aGV0ZW5nc2hhLmV1Lm9yZy9nZW5lcmF0ZS53ZWJwIiwiaGVhZGVycyI6eyJDb250ZW50LVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIiwiVXNlci1BZ2VudCI6IlRlbGVCb3gvMC4yLjEifX0=",
          "base64",
        ).toString("utf-8"),
      ),
    });

    console.log("quote-api响应状态:", response.status);

    // // 检查响应格式
    // if (!response.data.ok || !response.data.result) {
    //   throw new Error("API响应格式错误，缺少result字段");
    // }

    // if (!response.data.result.image) {
    //   throw new Error("API响应中缺少image字段");
    // }

    // let imageBuffer: Buffer;

    // // 如果image是base64字符串，需要解码
    // if (typeof response.data.result.image === "string") {
    //   // 移除可能的data URL前缀
    //   const base64Data = response.data.result.image.replace(
    //     /^data:image\/[a-z]+;base64,/,
    //     ""
    //   );
    //   imageBuffer = Buffer.from(base64Data, "base64");
    // } else if (Buffer.isBuffer(response.data.result.image)) {
    //   imageBuffer = response.data.result.image;
    // } else {
    //   throw new Error("不支持的图片数据格式");
    // }

    // console.log("解码后图片数据长度:", imageBuffer.length);

    // 推断返回图片格式：
    // - 当 type === 'quote' 且 format === 'webp' 时，后端会生成 webp 贴纸（但 JSON 下没有 ext 字段）
    // - 当 type === 'image' 时，后端最终输出的是 png（带背景的图片）
    // const outExt = quoteData?.type === "quote" ? "webp" : "png";
    // return { buffer: imageBuffer, ext: outExt };
    return { buffer: response.data, ext: "webp" };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(`quote-api请求失败:`, {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
      });
    } else {
      console.error(`调用quote-api失败: ${error}`);
    }
    throw error;
  }
}

interface YvluConfig {
  stickerSetShortName: string;
  _comment?: string;
}

class YvluPlugin extends Plugin {
  description: string = `\n生成文字语录贴纸\n\n${help_text}`;
  private config: YvluConfig | null = null;
  private configPath: string = "";

  async onLoad() {
    // 使用 assets 目录存储配置文件
    const configDir = createDirectoryInAssets("yvlu");
    this.configPath = path.join(configDir, "config.json");

    console.log(`yvlu配置文件路径: ${this.configPath}`);

    // 如果配置文件不存在,创建默认配置
    if (!fs.existsSync(this.configPath)) {
      const defaultConfig: YvluConfig = {
        stickerSetShortName: "",
        _comment:
          "如果贴纸包不存在,将自动创建。shortName 只能包含字母、数字和下划线",
      };
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(defaultConfig, null, 2),
        "utf-8",
      );
      console.log(`已创建默认配置文件: ${this.configPath}`);
    }

    // 加载配置
    await this.loadConfig();
  }

  async loadConfig() {
    try {
      // 确保 configPath 已初始化
      if (!this.configPath || this.configPath === "") {
        const configDir = createDirectoryInAssets("yvlu");
        this.configPath = path.join(configDir, "config.json");
        console.log(`重新初始化配置文件路径: ${this.configPath}`);
      }

      if (!fs.existsSync(this.configPath)) {
        console.error(`配置文件不存在: ${this.configPath}`);
        console.log(`请手动创建配置文件: ${this.configPath}`);
        this.config = { stickerSetShortName: "" };
        return;
      }

      const configData = fs.readFileSync(this.configPath, "utf-8");
      this.config = JSON.parse(configData);
      console.log("yvlu配置已加载:", this.config);
      console.log("stickerSetShortName:", this.config?.stickerSetShortName);
    } catch (error) {
      console.error("加载yvlu配置失败:", error);
      this.config = { stickerSetShortName: "" };
    }
  }

  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    yvlu: async (msg: Api.Message, trigger?: Api.Message) => {
      const start = Date.now();
      const args = msg.message.split(/\s+/);
      let count = 1;
      let r = false;
      let valid = false;
      let saveToSet = false;

      // 处理配置命令
      if (args[1] === "config") {
        await this.handleConfigCommand(msg, args.slice(2));
        return;
      }

      if (!args[1] || /^\d+$/.test(args[1])) {
        count = parseInt(args[1]) || 1;
        valid = true;
      } else if (args[1] === "r") {
        r = true;
        count = parseInt(args[2]) || 1;
        valid = true;
      } else if (args[1] === "s") {
        saveToSet = true;
        valid = true;
      }

      if (saveToSet) {
        // 处理保存贴纸/图片到贴纸包的逻辑
        await this.handleSaveStickerToSet(msg);
      } else if (valid) {
        let replied = await msg.getReplyMessage();
        if (!replied) {
          await msg.edit({ text: "请回复一条消息" });
          return;
        }
        if (count > 5) {
          await msg.edit({ text: "太多了 哒咩" });
          return;
        }

        await msg.edit({ text: "正在生成语录贴纸..." });

        try {
          const client = await getGlobalClient();

          const messages = await msg.client?.getMessages(replied?.peerId, {
            offsetId: replied!.id - 1,
            limit: count,
            reverse: true,
          });

          if (!messages || messages.length === 0) {
            await msg.edit({ text: "未找到消息" });
            return;
          }

          const items = [] as any[];
          let previousUserIdentifier: string | null = null;

          for await (const [i, message] of messages.entries()) {
            // 获取发送者信息
            let sender: any = await message.getSender();

            // 如果无法获取发送者（可能是以频道身份发言），尝试从 peerId 获取
            if (!sender) {
              try {
                const peerId =
                  (message as any).peerId || (message as any).fromId;
                if (peerId) {
                  sender = await client.getEntity(peerId);
                }
              } catch (e) {
                console.warn("从 peerId 获取发送者失败", e);
              }
            }

            if (message.fwdFrom) {
              let forwardedSender =
                message.forward?.sender || message.forward?.chat;

              if (!forwardedSender) {
                try {
                  forwardedSender = await message.forward?.getSender();
                } catch (error) {
                  console.warn("获取转发发送者失败", error);
                }
              }

              if (!forwardedSender) {
                forwardedSender = await resolveForwardSenderFromHeader(
                  message.fwdFrom,
                  client,
                );
              }

              if (!forwardedSender) {
                const fallbackName = "未知来源";
                forwardedSender = {
                  id: hashCode(fallbackName),
                  firstName: fallbackName,
                  lastName: "",
                  title: fallbackName,
                  name: fallbackName,
                };
              }
              sender = forwardedSender;
            }

            if (!sender) {
              await msg.edit({ text: "无法获取消息发送者信息" });
              return;
            }

            // 准备用户数据
            const userId = (sender as any).id?.toString();
            const name = (sender as any).name || "";
            const firstName =
              (sender as any).firstName || (sender as any).title || "";
            const lastName = (sender as any).lastName || "";
            const username = (sender as any).username || "";
            const emojiStatus =
              (sender as any).emojiStatus?.documentId?.toString() || null;

            // 生成用户唯一标识符：优先使用 userId，如果没有则使用名称的 hashCode
            const currentUserIdentifier =
              userId ||
              hashCode(
                name || `${firstName}|${lastName}` || `user_${i}`,
              ).toString();

            // 判断是否应该显示头像：只有当前用户与上一条消息的用户不同时才显示
            const shouldShowAvatar =
              currentUserIdentifier !== previousUserIdentifier;
            previousUserIdentifier = currentUserIdentifier;

            let photo: { url: string } | undefined = undefined;
            if (shouldShowAvatar) {
              try {
                const buffer = await client.downloadProfilePhoto(
                  sender as any,
                  {
                    isBig: false,
                  },
                );
                if (Buffer.isBuffer(buffer) && buffer.length > 0) {
                  const base64 = buffer.toString("base64");
                  photo = {
                    url: `data:image/jpeg;base64,${base64}`,
                  };
                } else {
                  console.warn("下载的头像数据无效或用户无头像");
                }
              } catch (e) {
                console.warn("下载用户头像失败", e);
              }
            }

            if (i === 0) {
              let replyTo = (trigger || msg)?.replyTo;
              if (replyTo?.quoteText) {
                message.message = replyTo.quoteText;
                message.entities = replyTo.quoteEntities;
              }
            }

            // 转换消息实体
            const entities = convertEntities(message.entities || []);

            // 处理回复引用（支持 quote header 与真实被回复消息）
            let replyBlock: any | undefined;
            if (r) {
              try {
                const replyHeader: any = (message as any).replyTo;

                // 1) 优先使用 quote header（包含被引用文本与实体偏移）
                if (replyHeader?.quote && replyHeader.quoteText) {
                  let replyName = "unknown";
                  let replyChatId: number | undefined = undefined;

                  // 尝试拿到被回复消息以获取发送者名称
                  try {
                    const repliedMsg = await message.getReplyMessage();
                    if (repliedMsg) {
                      const repliedSender = await repliedMsg.getSender();
                      if (repliedSender) {
                        replyChatId = Number(repliedSender.id);
                        const rFirst =
                          (repliedSender as any).firstName ||
                          (repliedSender as any).title ||
                          "";
                        const rLast = (repliedSender as any).lastName || "";
                        const rUser = (repliedSender as any).username || "";
                        const composed = `${rFirst} ${rLast}`.trim();
                        replyName = composed || rUser || "unknown";
                      }
                    }
                  } catch {}

                  // 实体
                  const revived = reviveEntities(replyHeader.quoteEntities);
                  const replyEntities = convertEntities(revived || []);

                  replyBlock = {
                    name: replyName,
                    text: replyHeader.quoteText,
                    entities: replyEntities,
                    ...(replyChatId ? { chatId: replyChatId } : {}),
                  };
                } else if (
                  // 2) 次选：直接获取被回复消息
                  (message as any).isReply ||
                  replyHeader?.replyToMsgId
                ) {
                  try {
                    const repliedMsg = await message.getReplyMessage();
                    if (repliedMsg) {
                      const repliedSender = await repliedMsg.getSender();
                      let replyName = "unknown";
                      let replyChatId: number | undefined;
                      if (repliedSender) {
                        replyChatId = Number(repliedSender.id);
                        const rFirst =
                          (repliedSender as any).firstName ||
                          (repliedSender as any).title ||
                          "";
                        const rLast = (repliedSender as any).lastName || "";
                        const rUser = (repliedSender as any).username || "";
                        const composed = `${rFirst} ${rLast}`.trim();
                        replyName = composed || rUser || "unknown";
                      }

                      // 使用被回复消息的文本 + 实体
                      const replyText = repliedMsg.message || "";
                      const replyEntities = convertEntities(
                        repliedMsg.entities || [],
                      );

                      if (replyText) {
                        replyBlock = {
                          name: replyName,
                          text: replyText,
                          entities: replyEntities,
                          ...(replyChatId ? { chatId: replyChatId } : {}),
                        };
                      }
                    }
                  } catch {}
                }
              } catch (e) {
                console.warn("处理回复引用失败: ", e);
              }
            }

            let media: { url: string } | undefined = undefined;
            try {
              if (message.media) {
                let mediaTypeForQuote: string | undefined = undefined;

                // 判断是否为贴纸
                const isSticker =
                  message.media instanceof Api.MessageMediaDocument &&
                  (message.media as Api.MessageMediaDocument).document &&
                  (
                    (message.media as Api.MessageMediaDocument).document as any
                  ).attributes?.some(
                    (a: any) => a instanceof Api.DocumentAttributeSticker,
                  );

                if (isSticker) {
                  mediaTypeForQuote = "sticker";
                } else {
                  mediaTypeForQuote = "photo";
                }

                const mimeType = (message.media as any).document?.mimeType;

                // 检测是否为 TGS 动态贴纸
                const isTgsSticker =
                  isSticker && mimeType === "application/x-tgsticker";

                // 检测是否为 GIF/MP4 (Telegram 的 GIF 实际是 mp4)
                const isGifOrMp4 =
                  mimeType === "video/mp4" || mimeType === "image/gif";

                // 检测是否为动态内容（需要下载原文件，不用缩略图）
                const isAnimatedContent =
                  (isSticker &&
                    (mimeType === "video/webm" || // 视频贴纸
                      mimeType === "image/webp" || // 可能是动态WebP
                      isTgsSticker)) || // TGS 动态贴纸
                  isGifOrMp4; // GIF/MP4

                const buffer = await (message as any).downloadMedia({
                  // 动态内容不使用缩略图，下载原始文件
                  ...(isAnimatedContent ? {} : { thumb: 1 }),
                });
                if (Buffer.isBuffer(buffer)) {
                  let finalBuffer = buffer;
                  let finalMime = mimeType;

                  // 如果是 TGS 格式，转换为 WebM
                  if (isTgsSticker || isTgsFormat(buffer)) {
                    try {
                      const depCheck = await checkTgsDependencies();
                      if (!depCheck.ok) {
                        console.error(`[yvlu] ${depCheck.message}`);
                      } else {
                        console.log(
                          `[yvlu] 检测到 TGS 贴纸，开始转换为 WebM...`,
                        );
                        finalBuffer = await convertTgsToWebm(buffer);
                        finalMime = "video/webm";
                        console.log(
                          `[yvlu] TGS -> WebM 转换成功，大小: ${finalBuffer.length}`,
                        );
                      }
                    } catch (convertError) {
                      console.error(`[yvlu] TGS 转换失败:`, convertError);
                    }
                  }
                  // 如果是 MP4/GIF，转换为 WebM
                  else if (isGifOrMp4 || isMp4Format(buffer)) {
                    try {
                      console.log(`[yvlu] 检测到 GIF/MP4，开始转换为 WebM...`);
                      finalBuffer = await convertMp4ToWebm(buffer);
                      finalMime = "video/webm";
                      console.log(
                        `[yvlu] MP4 -> WebM 转换成功，大小: ${finalBuffer.length}`,
                      );
                    } catch (convertError) {
                      console.error(`[yvlu] MP4 转换失败:`, convertError);
                      // 转换失败时保持原格式
                    }
                  }

                  // 使用实际的 mimeType
                  const mime =
                    finalMime ||
                    (mediaTypeForQuote === "sticker"
                      ? "image/webp"
                      : "image/jpeg");
                  const base64 = finalBuffer.toString("base64");
                  media = { url: `data:${mime};base64,${base64}` };
                  console.log(
                    `媒体下载: mimeType=${mimeType}, isAnimated=${isAnimatedContent}, isTgs=${isTgsSticker}, isGif=${isGifOrMp4}, size=${finalBuffer.length}`,
                  );
                }
              }
            } catch (e) {
              console.error("下载媒体失败", e);
            }

            items.push({
              from: {
                id: userId
                  ? parseInt(userId)
                  : hashCode(sender.name || `${firstName}|${lastName}`),
                name: shouldShowAvatar ? name : "",
                first_name: shouldShowAvatar
                  ? firstName || undefined
                  : undefined,
                last_name: shouldShowAvatar ? lastName || undefined : undefined,
                username:
                  photo && shouldShowAvatar ? username || undefined : undefined,
                photo,
                emoji_status: shouldShowAvatar
                  ? emojiStatus || undefined
                  : undefined,
              },
              text: message.message || "",
              entities: entities,
              avatar: shouldShowAvatar,
              media,
              ...(replyBlock ? { replyMessage: replyBlock } : {}),
            });
          }

          const quoteData = {
            type: "quote",
            format: "webp",
            backgroundColor: "#1b1429",
            width: 512,
            height: 768,
            scale: 2,
            emojiBrand: "apple",
            messages: items,
          };
          // 生成语录贴纸（webp）
          const quoteResult = await generateQuote(quoteData);
          const imageBuffer = quoteResult.buffer;
          const imageExt = quoteResult.ext; // 'image' => png, 'quote' => webp

          // 验证图片数据
          if (!imageBuffer || imageBuffer.length === 0) {
            await msg.edit({ text: "生成的图片数据为空" });
            return;
          }

          console.log(
            `[yvlu] API返回: buffer长度=${imageBuffer?.length}, ext=${imageExt}`,
          );
          console.log(
            `[yvlu] buffer前20字节: ${imageBuffer
              ?.slice(0, 20)
              .toString("hex")}`,
          );

          try {
            // 从生成的图片文件中读取实际尺寸
            const dimensions = getWebPDimensions(imageBuffer);

            // 检测格式
            const isWebm = isWebmFormat(imageBuffer);
            const isAnimated = isAnimatedWebP(imageBuffer);

            console.log(
              `检测到的图片尺寸: ${dimensions.width}x${
                dimensions.height
              }, 格式: ${isWebm ? "webm" : "webp"}, 动态: ${
                isWebm || isAnimated
              }`,
            );

            if (isWebm) {
              // webm 格式：直接发送为贴纸（参考 eatgif）
              const os = await import("os");
              const tmpDir = os.tmpdir();
              const uniqueId = Date.now().toString();
              const webmPath = path.join(tmpDir, `sticker_${uniqueId}.webm`);

              try {
                fs.writeFileSync(webmPath, imageBuffer);

                await client.sendFile(msg.peerId, {
                  file: webmPath,
                  attributes: [
                    new Api.DocumentAttributeSticker({
                      alt: "📝",
                      stickerset: new Api.InputStickerSetEmpty(),
                    }),
                  ],
                  replyTo: replied?.id,
                });

                console.log("[yvlu] 动态贴纸发送成功 (webm)");
              } finally {
                try {
                  fs.unlinkSync(webmPath);
                } catch (e) {}
              }
            } else {
              // webp/png 格式：发送为静态贴纸
              const file = new CustomFile(
                `sticker.${imageExt}`,
                imageBuffer.length,
                "",
                imageBuffer,
              );

              const stickerAttr = new Api.DocumentAttributeSticker({
                alt: "📝",
                stickerset: new Api.InputStickerSetEmpty(),
              });

              const imageSizeAttr = new Api.DocumentAttributeImageSize({
                w: dimensions.width,
                h: dimensions.height,
              });

              const filenameAttr = new Api.DocumentAttributeFilename({
                fileName: `sticker.${imageExt}`,
              });

              await client.sendFile(msg.peerId, {
                file,
                forceDocument: false,
                attributes: [stickerAttr, imageSizeAttr, filenameAttr],
                replyTo: replied?.id,
              });

              console.log("[yvlu] 静态贴纸发送成功");
            }

            console.log("[yvlu] 文件发送成功");
          } catch (fileError) {
            console.error(`发送文件失败: ${fileError}`);
            await msg.edit({ text: `发送文件失败: ${fileError}` });
            return;
          }

          await msg.delete();

          const end = Date.now();
          console.log(`语录生成耗时: ${end - start}ms`);
        } catch (error) {
          console.error(`语录生成失败: ${error}`);
          await msg.edit({ text: `语录生成失败: ${error}` });
        }
      } else {
        await msg.edit({
          text: help_text,
          parseMode: "html",
        });
      }
    },
  };

  async handleConfigCommand(msg: Api.Message, args: string[]) {
    try {
      // 确保配置已加载
      await this.loadConfig();

      // 如果没有参数，显示当前配置
      if (args.length === 0) {
        const configInfo = `
<b>📋 当前配置:</b>

<b>贴纸包名称:</b> <code>${
          this.config?.stickerSetShortName || "(未设置)"
        }</code>
${
  this.config?.stickerSetShortName
    ? `<b>贴纸包链接:</b> t.me/addstickers/${this.config.stickerSetShortName}`
    : ""
}

<b>配置文件路径:</b>
<code>${this.configPath}</code>

<b>可用配置命令:</b>
<code>${commandName} config sticker 贴纸包名称</code> - 设置贴纸包名称
`;
        await msg.edit({ text: configInfo, parseMode: "html" });
        return;
      }

      const subCommand = args[0].toLowerCase();

      switch (subCommand) {
        case "sticker":
        case "stickerset":
        case "set": {
          // 设置贴纸包名称
          const newName = args.slice(1).join("_"); // 用下划线连接多个参数

          if (!newName) {
            await msg.edit({
              text: `❌ 请提供贴纸包名称\n用法: <code>${commandName} config sticker 贴纸包名称</code>`,
              parseMode: "html",
            });
            return;
          }

          // 验证贴纸包名称格式（只能包含字母、数字和下划线）
          if (!/^[a-zA-Z0-9_]+$/.test(newName)) {
            await msg.edit({
              text: "❌ 贴纸包名称只能包含字母、数字和下划线",
              parseMode: "html",
            });
            return;
          }

          // 贴纸包名称长度限制
          if (newName.length < 1 || newName.length > 64) {
            await msg.edit({
              text: "❌ 贴纸包名称长度应在 1-64 个字符之间",
              parseMode: "html",
            });
            return;
          }

          // 更新配置
          const newConfig: YvluConfig = {
            ...this.config,
            stickerSetShortName: newName,
          };

          // 保存到文件
          fs.writeFileSync(
            this.configPath,
            JSON.stringify(newConfig, null, 2),
            "utf-8",
          );

          // 重新加载配置
          await this.loadConfig();

          await msg.edit({
            text: `✅ 贴纸包名称已设置为: <code>${newName}</code>\n贴纸包链接: t.me/addstickers/${newName}`,
            parseMode: "html",
          });
          break;
        }

        default:
          await msg.edit({
            text: `❌ 未知的配置项: <code>${subCommand}</code>\n\n可用配置命令:\n<code>${commandName} config sticker 贴纸包名称</code> - 设置贴纸包名称`,
            parseMode: "html",
          });
      }
    } catch (error: any) {
      console.error("处理配置命令失败:", error);
      await msg.edit({
        text: `❌ 配置操作失败: ${error.message || error}`,
      });
    }
  }

  async handleSaveStickerToSet(msg: Api.Message) {
    try {
      // 确保配置路径已初始化
      if (!this.configPath || this.configPath === "") {
        const configDir = createDirectoryInAssets("yvlu");
        this.configPath = path.join(configDir, "config.json");

        // 如果配置文件不存在,创建默认配置
        if (!fs.existsSync(this.configPath)) {
          const defaultConfig: YvluConfig = {
            stickerSetShortName: "",
            _comment:
              "如果贴纸包不存在,将自动创建。shortName 只能包含字母、数字和下划线",
          };
          fs.writeFileSync(
            this.configPath,
            JSON.stringify(defaultConfig, null, 2),
            "utf-8",
          );
          console.log(`已创建默认配置文件: ${this.configPath}`);
        }
      }

      // 重新加载配置(确保获取最新配置)
      await this.loadConfig();

      // 检查配置
      if (
        !this.config ||
        !this.config.stickerSetShortName ||
        this.config.stickerSetShortName.trim() === ""
      ) {
        await msg.edit({
          text: `❌ 未配置贴纸包!\n请编辑配置文件: ${this.configPath}\n设置 stickerSetShortName`,
        });
        return;
      }

      // 获取回复的消息
      const replied = await msg.getReplyMessage();
      if (!replied) {
        await msg.edit({ text: "❌ 请回复一张贴纸或图片" });
        return;
      }

      // 检查是否有媒体
      if (!replied.media) {
        await msg.edit({ text: "❌ 回复的消息不包含贴纸或图片" });
        return;
      }

      const client = await getGlobalClient();

      // 判断媒体类型
      let isSticker = false;
      let isPhoto = false;
      let documentToAdd: Api.InputDocument | null = null;

      if (replied.media instanceof Api.MessageMediaDocument) {
        const doc = replied.media.document as any;
        if (doc && doc.attributes) {
          isSticker = doc.attributes.some(
            (a: any) => a instanceof Api.DocumentAttributeSticker,
          );
        }
        if (isSticker && doc.id && doc.accessHash) {
          documentToAdd = new Api.InputDocument({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference || Buffer.from([]),
          });
        }
      } else if (replied.media instanceof Api.MessageMediaPhoto) {
        isPhoto = true;
      }

      if (!isSticker && !isPhoto) {
        await msg.edit({ text: "❌ 不支持的媒体类型,请回复贴纸或图片" });
        return;
      }

      // 检查贴纸包是否存在,不存在则创建
      let stickerSetExists = false;
      try {
        const stickerSet = await client.invoke(
          new Api.messages.GetStickerSet({
            stickerset: new Api.InputStickerSetShortName({
              shortName: this.config.stickerSetShortName,
            }),
            hash: 0,
          }),
        );
        stickerSetExists = stickerSet instanceof Api.messages.StickerSet;
      } catch (error: any) {
        // 如果贴纸包不存在,会抛出异常
        if (error.errorMessage === "STICKERSET_INVALID") {
          stickerSetExists = false;
        } else {
          throw error;
        }
      }

      // 如果贴纸包不存在,需要先创建
      if (!stickerSetExists) {
        await this.createStickerSet(client, msg, replied, isSticker, isPhoto);
        return;
      }

      // 如果是贴纸,直接添加
      if (isSticker && documentToAdd) {
        try {
          await client.invoke(
            new Api.stickers.AddStickerToSet({
              stickerset: new Api.InputStickerSetShortName({
                shortName: this.config.stickerSetShortName,
              }),
              sticker: new Api.InputStickerSetItem({
                document: documentToAdd,
                emoji: "📝",
              }),
            }),
          );

          await msg.edit({
            text: `✅ 已成功添加到贴纸包!\n贴纸包: t.me/addstickers/${this.config.stickerSetShortName}`,
          });
        } catch (error: any) {
          console.error("添加贴纸失败:", error);
          await msg.edit({
            text: `❌ 添加贴纸失败: ${error.message || error}`,
          });
        }
        return;
      }

      // 如果是图片,需要先下载并转换为贴纸格式
      if (isPhoto) {
        try {
          // 下载图片
          const buffer = await replied.downloadMedia();
          if (!Buffer.isBuffer(buffer)) {
            await msg.edit({ text: "❌ 下载图片失败" });
            return;
          }

          // 上传为文件
          const file = await client.uploadFile({
            file: new CustomFile("sticker.png", buffer.length, "", buffer),
            workers: 1,
          });

          // 创建 InputStickerSetItem
          const stickerItem = new Api.InputStickerSetItem({
            document: new Api.InputDocument({
              id: BigInt(0),
              accessHash: BigInt(0),
              fileReference: Buffer.from([]),
            }),
            emoji: "📝",
          });

          // 使用上传的文件
          await client.invoke(
            new Api.stickers.AddStickerToSet({
              stickerset: new Api.InputStickerSetShortName({
                shortName: this.config.stickerSetShortName,
              }),
              sticker: new Api.InputStickerSetItem({
                document: file as any,
                emoji: "📝",
              }),
            }),
          );

          await msg.edit({
            text: `✅ 已成功添加到贴纸包!\n贴纸包: t.me/addstickers/${this.config.stickerSetShortName}`,
          });
        } catch (error: any) {
          console.error("处理图片失败:", error);
          await msg.edit({
            text: `❌ 处理图片失败: ${error.message || error}`,
          });
        }
        return;
      }
    } catch (error: any) {
      console.error("保存贴纸到贴纸包失败:", error);
      await msg.edit({
        text: `❌ 操作失败: ${error.message || error}`,
      });
    }
  }

  async createStickerSet(
    client: any,
    msg: Api.Message,
    replied: Api.Message,
    isSticker: boolean,
    isPhoto: boolean,
  ) {
    try {
      // 准备第一个贴纸
      let firstSticker: any = null;

      if (isSticker && replied.media instanceof Api.MessageMediaDocument) {
        const doc = replied.media.document as any;
        if (doc && doc.id && doc.accessHash) {
          firstSticker = new Api.InputDocument({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference || Buffer.from([]),
          });
        }
      } else if (isPhoto) {
        // 下载图片
        const buffer = await replied.downloadMedia();
        if (!Buffer.isBuffer(buffer)) {
          await msg.edit({ text: "❌ 下载图片失败" });
          return;
        }

        // 上传为文件
        firstSticker = await client.uploadFile({
          file: new CustomFile("sticker.png", buffer.length, "", buffer),
          workers: 1,
        });
      }

      if (!firstSticker) {
        await msg.edit({ text: "❌ 无法准备贴纸数据" });
        return;
      }

      // 获取当前用户信息
      const me = await client.getMe();

      // 创建贴纸包
      await client.invoke(
        new Api.stickers.CreateStickerSet({
          userId: me,
          title: `${this.config!.stickerSetShortName}`,
          shortName: this.config!.stickerSetShortName,
          stickers: [
            new Api.InputStickerSetItem({
              document: firstSticker,
              emoji: "📝",
            }),
          ],
        }),
      );

      await msg.edit({
        text: `✅ 已创建贴纸包并添加第一个贴纸!\n贴纸包: t.me/addstickers/${
          this.config!.stickerSetShortName
        }`,
      });
    } catch (error: any) {
      console.error("创建贴纸包失败:", error);
      await msg.edit({
        text: `❌ 创建贴纸包失败: ${error.message || error}`,
      });
    }
  }
}

export default new YvluPlugin();

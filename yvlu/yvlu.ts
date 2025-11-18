import axios from "axios";
import _ from "lodash";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
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
import { sleep } from "telegram/Helpers";
import dayjs from "dayjs";
import { CustomFile } from "telegram/client/uploads.js";

const timeout = 60000; // 超时

// 读取WebP图片尺寸的辅助函数

function getWebPDimensions(imageBuffer: any): {
  width: number;
  height: number;
} {
  try {
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

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "yvlu";

const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
- 不包含回复
使用 <code>${commandName} [消息数]</code> 回复一条消息(支持选择部分引用回复) ⚠️ 不得超过 5 条

- 包含回复
使用 <code>${commandName} r [消息数]</code> 回复一条消息(支持选择部分引用回复) ⚠️ 不得超过 5 条
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
  quoteData: any
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
          "base64"
        ).toString("utf-8")
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

class YvluPlugin extends Plugin {
  description: string = `\n生成文字语录贴纸\n\n${help_text}`;
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
      if (!args[1] || /^\d+$/.test(args[1])) {
        count = parseInt(args[1]) || 1;
        valid = true;
      } else if (args[1] === "r") {
        r = true;
        count = parseInt(args[2]) || 1;
        valid = true;
      }

      if (valid) {
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

          for await (const [i, message] of messages.entries()) {
            // 获取发送者信息
            const sender =
              (await message.forward?.getSender()) ||
              (await message.getSender());
            if (!sender) {
              await msg.edit({ text: "无法获取消息发送者信息" });
              return;
            }

            // 准备用户数据
            const userId = sender.id.toString();
            const firstName =
              (sender as any).firstName || (sender as any).title || "";
            const lastName = (sender as any).lastName || "";
            const username = (sender as any).username || "";
            const emojiStatus =
              (sender as any).emojiStatus?.documentId?.toString() || null;

            let photo = undefined;
            try {
              const buffer = await client.downloadProfilePhoto(sender as any, {
                isBig: false,
              });
              if (Buffer.isBuffer(buffer)) {
                const base64 = buffer.toString("base64");
                photo = {
                  url: `data:image/jpeg;base64,${base64}`,
                };
              }
            } catch (e) {
              console.warn("下载用户头像失败", e);
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
                        repliedMsg.entities || []
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

            let media = undefined;
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
                    (a: any) => a instanceof Api.DocumentAttributeSticker
                  );

                if (isSticker) {
                  mediaTypeForQuote = "sticker";
                } else {
                  mediaTypeForQuote = "photo";
                }

                const mimeType = (message.media as any).document?.mimeType;
                const buffer = await (message as any).downloadMedia({
                  thumb: ["video/webm"].includes(mimeType) ? 0 : 1,
                });
                if (Buffer.isBuffer(buffer)) {
                  const mime =
                    mediaTypeForQuote === "sticker"
                      ? "image/webp"
                      : "image/jpeg";
                  const base64 = buffer.toString("base64");
                  media = { url: `data:${mime};base64,${base64}` };
                }
              }
            } catch (e) {
              console.error("下载媒体失败", e);
            }

            items.push({
              from: {
                id: parseInt(userId),
                first_name: firstName,
                last_name: lastName || undefined,
                username: username || undefined,
                photo,
                emoji_status: emojiStatus || undefined,
              },
              text: message.message || "",
              entities: entities,
              avatar: true,
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

          try {
            const file = new CustomFile(
              `sticker.${imageExt}`,
              imageBuffer.length,
              "",
              imageBuffer
            );

            // 从生成的图片文件中读取实际尺寸

            const dimensions = getWebPDimensions(imageBuffer);

            console.log(
              `检测到的图片尺寸: ${dimensions.width}x${dimensions.height}`
            );

            // 发送语录贴纸到指定对话

            // 通过设置完整的文档属性，确保始终显示为贴纸

            const stickerAttr = new Api.DocumentAttributeSticker({
              alt: "📝",

              stickerset: new Api.InputStickerSetEmpty(),
            });

            // 添加图片尺寸属性，使用实际检测到的尺寸

            const imageSizeAttr = new Api.DocumentAttributeImageSize({
              w: dimensions.width,

              h: dimensions.height,
            });

            // 添加文件名属性

            const filenameAttr = new Api.DocumentAttributeFilename({
              fileName: `sticker.${imageExt}`,
            });

            await client.sendFile(msg.peerId, {
              file,
              // 贴纸通常不带 caption，这里留空
              forceDocument: false,
              // 包含所有必要的属性以确保正确识别为贴纸
              attributes: [stickerAttr, imageSizeAttr, filenameAttr],
              replyTo: replied?.id,
            });
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
}

export default new YvluPlugin();

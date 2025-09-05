import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { NewMessageEvent } from "telegram/events";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { getGlobalClient } from "../src/utils/globalClient";

// Plugin interface
interface Plugin {
  command: string[];
  description?: string;
  cmdHandler: (msg: Api.Message) => Promise<void>;
  listenMessageHandler?: (msg: Api.Message) => Promise<void>;
}

// Configuration
const CONFIG = {
  API_URL: "https://bot.lyo.su/quote/generate",
  TIMEOUT: 30000,
  EMOJI_BRAND: "apple",
  CANVAS: {
    WIDTH: 512,
    HEIGHT: 768,
    SCALE: 2,
  },
  THEME_COLORS: {
    transparent: "transparent",
    trans: "transparent",
    dark: "#1b1429",
    light: "#ffffff",
    random: null as string | null,
    随机: null as string | null,
  },
};

// Parse background color from arguments
const parseBackgroundColor = (args: string[]): string => {
  if (!args || args.length === 0) {
    return "transparent";
  }

  const param = args[0].toLowerCase();

  // Check for hex color
  if (param.startsWith("#") && param.length === 7) {
    return param;
  }

  // Check for theme colors
  if (param in CONFIG.THEME_COLORS) {
    if (param === "random" || param === "随机") {
      return (
        "#" +
        Math.floor(Math.random() * 16777215)
          .toString(16)
          .padStart(6, "0")
      );
    }
    return (
      CONFIG.THEME_COLORS[param as keyof typeof CONFIG.THEME_COLORS] ||
      "transparent"
    );
  }

  // If it's a word (potential CSS color name), return it
  if (/^[a-z]+$/i.test(param)) {
    return param;
  }

  return "transparent";
};

// Extract text entities from message
const extractTextEntities = (message: Api.Message): Array<any> => {
  const entities: Array<any> = [];

  if (!message.entities || message.entities.length === 0) {
    return entities;
  }

  for (const entity of message.entities) {
    try {
      const entityData: any = {
        type: entity.className?.toLowerCase() || "unknown",
        offset: entity.offset,
        length: entity.length,
      };

      if ("url" in entity && entity.url) {
        entityData.url = entity.url;
      }

      if ("customEmojiId" in entity && entity.customEmojiId) {
        entityData.custom_emoji_id = entity.customEmojiId.toString();
      }

      entities.push(entityData);
    } catch (error) {
      console.error("Error extracting entity:", error);
      continue;
    }
  }

  return entities;
};

// Types
interface QuoteMessage {
  from: {
    id: number;
    first_name: string;
    last_name: string;
    username: string;
    name: string;
  };
  text: string;
  avatar: boolean;
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
    url?: string;
    custom_emoji_id?: string;
  }>;
  replyMessage?: {
    name: string;
    text: string;
    entities: Array<any>;
    chatId: number;
  };
}

interface QuotePayload {
  width: number;
  height: number;
  scale: number;
  emojiBrand: string;
  messages: QuoteMessage[];
  backgroundColor?: string;
}

// Build quote payload from message
const buildQuotePayload = async (
  message: Api.Message,
  backgroundColor: string,
  client: any
): Promise<QuotePayload> => {
  try {
    // Get sender information
    const sender = await message.getSender();
    let fromInfo: QuoteMessage["from"];

    if (!sender) {
      fromInfo = {
        id: 1,
        first_name: "",
        last_name: "",
        username: "",
        name: "Unknown User",
      };
    } else {
      const firstName = (sender as any).firstName || "";
      const lastName = (sender as any).lastName || "";
      const username = (sender as any).username || "";
      const title = (sender as any).title || "";

      let displayName = "Unknown User";
      if (firstName) {
        displayName = firstName;
        if (lastName) {
          displayName += ` ${lastName}`;
        }
      } else if (title) {
        displayName = title;
      } else if (username) {
        displayName = username;
      } else if (sender.id) {
        displayName = `User_${sender.id}`;
      }

      fromInfo = {
        id: sender.id?.toJSNumber() || 1,
        first_name: firstName,
        last_name: lastName,
        username: username,
        name: displayName,
      };
    }

    // Get message text
    let messageText = message.text || message.message || "";
    if (!messageText.trim()) {
      messageText = message.media ? "[媒体消息]" : "";
    }

    // Extract entities
    const entities = extractTextEntities(message);

    // Build quote message
    const quoteMessage: QuoteMessage = {
      from: fromInfo,
      text: messageText,
      avatar: true,
    };

    if (entities.length > 0) {
      quoteMessage.entities = entities;
    }

    // Handle reply message
    if (message.replyToMsgId) {
      try {
        const replyMessages = await client.getMessages(message.chatId, {
          ids: [message.replyToMsgId],
        });

        if (replyMessages && replyMessages.length > 0) {
          const originalReply = replyMessages[0];
          const replySender = await originalReply.getSender();

          if (replySender) {
            const replyFirstName = (replySender as any).firstName || "";
            const replyLastName = (replySender as any).lastName || "";
            const replyTitle = (replySender as any).title || "";
            const replyUsername = (replySender as any).username || "";

            let replyName = "Unknown User";
            if (replyFirstName) {
              replyName = replyFirstName;
              if (replyLastName) {
                replyName += ` ${replyLastName}`;
              }
            } else if (replyTitle) {
              replyName = replyTitle;
            } else if (replyUsername) {
              replyName = replyUsername;
            } else if (replySender.id) {
              replyName = `User_${replySender.id}`;
            }

            let replyText = originalReply.text || originalReply.message || "";
            if (!replyText.trim()) {
              replyText = originalReply.media ? "[媒体消息]" : "[空消息]";
            }

            quoteMessage.replyMessage = {
              name: replyName,
              text: replyText,
              entities: extractTextEntities(originalReply),
              chatId: replySender.id?.toJSNumber() || 1,
            };
          }
        }
      } catch (error) {
        console.error("Error getting reply message:", error);
      }
    }

    // Build payload
    const payload: QuotePayload = {
      width: CONFIG.CANVAS.WIDTH,
      height: CONFIG.CANVAS.HEIGHT,
      scale: CONFIG.CANVAS.SCALE,
      emojiBrand: CONFIG.EMOJI_BRAND,
      messages: [quoteMessage],
    };

    if (backgroundColor !== "transparent") {
      payload.backgroundColor = backgroundColor;
    }

    return payload;
  } catch (error) {
    throw new Error(`构造请求数据失败: ${error}`);
  }
};

// Generate quote image via API
const generateQuoteImage = async (
  payload: QuotePayload
): Promise<Buffer | null> => {
  try {
    console.log("🌐 正在通过API生成引用图片...");

    const response = await axios.post(CONFIG.API_URL, payload, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: CONFIG.TIMEOUT,
      responseType: "json",
    });

    if (response.status === 200 && response.data) {
      if (!response.data.ok) {
        const errorMsg = response.data.error || "未知错误";
        console.error(`❌ API返回失败: ${errorMsg}`);
        return null;
      }

      const imageBase64 = response.data.result?.image;
      if (!imageBase64) {
        console.error("❌ API响应中没有图片数据");
        return null;
      }

      const imageBuffer = Buffer.from(imageBase64, "base64");
      console.log("✅ 引用图片生成成功");
      return imageBuffer;
    }

    console.error(`❌ API请求失败，状态码: ${response.status}`);
    return null;
  } catch (error: any) {
    if (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED") {
      console.error("⏰ API请求超时");
    } else {
      console.error("💥 API请求异常:", error.message);
    }
    return null;
  }
};

// Main quote handler
const handleQuote = async (msg: Api.Message): Promise<void> => {
  const client = await getGlobalClient();

  const text = msg.message || "";
  const args = text.trim().split(/\s+/);
  let showHelp = false;

  const filteredArgs = args.slice(1).filter((arg) => {
    if (arg === "help" || arg === "h") {
      showHelp = true;
      return false;
    }
    return true;
  });

  if (!client) {
    await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
    return;
  }

  if (showHelp) {
    await msg.edit({
      text: `生成美观的消息引用图片

参数说明:
• [背景色] - 可选，支持 transparent、dark、light、random、#hex

核心特性:
• API 优先生成高质量引用图片
• 支持多种背景色主题
• 自动处理消息实体和回复

示例:
• .yvlu - 透明背景引用
• .yvlu dark - 深色主题引用
• .yvlu #1b1429 - 自定义颜色引用

注意事项:
• 必须回复要引用的消息才能使用`,
      parseMode: "html",
      linkPreview: false,
    });
    return;
  }

  // Check for reply
  if (!msg.replyToMsgId) {
    await msg.edit({
      text:
        "❌ **请回复要生成引用的消息**\n\n" +
        "**💡 使用方法：**\n" +
        "1. 回复目标消息\n" +
        "2. 发送 `.yvlu` 命令",
    });
    return;
  }

  await msg.edit({ text: "🎨 **正在生成引用图片...**" });

  try {
    // Get the replied message
    const repliedMessages = await client.getMessages(msg.peerId!, {
      ids: [msg.replyToMsgId],
    });

    if (!repliedMessages || repliedMessages.length === 0) {
      await msg.edit({ text: "❌ **无法获取要引用的消息**" });
      return;
    }

    const targetMessage = repliedMessages[0];

    // Parse background color
    const backgroundColor = parseBackgroundColor(filteredArgs);

    // Build payload and generate image
    const payload = await buildQuotePayload(
      targetMessage,
      backgroundColor,
      client
    );
    const imageBuffer = await generateQuoteImage(payload);

    if (imageBuffer) {
      console.log("📤 发送引用图片...");

      // Create temporary file
      const tempDir = path.join(process.cwd(), "temp");
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const imagePath = path.join(tempDir, `quote_${Date.now()}.webp`);
      fs.writeFileSync(imagePath, imageBuffer);

      try {
        // Send as file
        await client.sendFile(msg.peerId!, {
          file: imagePath,
          replyTo: msg.replyToMsgId,
        });

        // Delete the command message
        await msg.delete();

        // Clean up temp file
        fs.unlinkSync(imagePath);
        console.log("✅ 引用发送成功");
      } catch (sendError) {
        console.error("❌ 发送引用失败:", sendError);
        await msg.edit({ text: "❌ **发送引用图片失败**" });

        if (fs.existsSync(imagePath)) {
          fs.unlinkSync(imagePath);
        }
      }
    } else {
      await msg.edit({ text: "❌ **生成引用图片失败**" });
    }
  } catch (error) {
    console.error("❌ 引用生成错误:", error);
    await msg.edit({ text: `❌ 生成失败：${error}` });
  }
};

class QuotePlugin extends Plugin {
  description: string = `生成美观的消息引用图片

参数说明:
• [背景色] - 可选，支持 transparent、dark、light、random、#hex

核心特性:
• API 优先生成高质量引用图片
• 支持多种背景色主题
• 自动处理消息实体和回复

示例:
• .yvlu - 透明背景引用
• .yvlu dark - 深色主题引用
• .yvlu #1b1429 - 自定义颜色引用

注意事项:
• 必须回复要引用的消息才能使用`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    yvlu: handleQuote,
  };
}

export default new QuotePlugin();

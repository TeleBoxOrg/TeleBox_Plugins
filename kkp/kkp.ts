// @ts-nocheck
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import { NewMessage } from "teleproto/events";
import { safeGetMessages } from "@utils/safeGetMessages";

// HTML转义函数 (虽然这次用实体不需要了，但保留作为工具函数无妨)
const htmlEscape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      }[m] || m),
  );

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 帮助文本
const help_text = `🎲 <b>随机色色视频获取</b>

<b>命令：</b>
• <code>${mainPrefix}kkp</code> - 从SeSe3000Bot获取随机视频并转发


<b>说明：</b>
该插件会自动与SeSe3000Bot交互获取随机视频内容`;

class KkpPlugin extends Plugin {
  cleanup(): void {
    // 真实资源清理：释放插件持有的定时器、监听器、运行时状态或临时资源。
  }

  description: string = `🎲 随机色色视频获取\n\n${help_text}`;

  // 存储等待回复的消息监听器
  private messageListeners: Map<
    string,
    {
      resolve: (message: Api.Message | null) => void;
      timeout: NodeJS.Timeout;
      startTime: number;
      handler: (event: any) => void;
    }
  > = new Map();

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    kkp: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();

      try {
        if (sub === "help" || sub === "h") {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        if (sub && sub !== "help" && sub !== "h") {
          await msg.edit({
            text: `❌ <b>未知命令:</b> <code>${htmlEscape(
              sub,
            )}</code>`,
            parseMode: "html",
          });
          return;
        }

        await this.getRandomVideo(msg, client);
      } catch (error: any) {
        console.error("[kkp] 插件执行失败:", error);
        await msg.edit({
          text: `❌ <b>插件执行失败:</b> ${htmlEscape(
            error.message || "未知错误",
          )}`,
          parseMode: "html",
        });
      }
    },
  };

  private extractPlainText(message: Api.Message): string {
    const fullText = message.message || "";
    if (!fullText) return "";

    // 如果没有实体，直接返回文本
    if (!message.entities || message.entities.length === 0) return fullText;

    // 简化的纯文本提取，这里我们只关心拿到文字内容
    // 原有的逻辑过滤了 URL 等，这里保持原样
    // ... (保持原逻辑以防破坏其他需求) ...
    const excludedRanges: Array<{ offset: number; length: number }> = [];
    for (const entity of message.entities) {
      if (
        [
          "MessageEntityHashtag",
          "MessageEntityTextUrl",
          "MessageEntityUrl",
        ].includes(entity.className)
      ) {
        excludedRanges.push({ offset: entity.offset, length: entity.length });
      }
    }

    if (excludedRanges.length === 0) return fullText;
    excludedRanges.sort((a, b) => a.offset - b.offset);

    let result = "";
    let lastEnd = 0;
    for (const range of excludedRanges) {
      if (range.offset > lastEnd)
        result += fullText.substring(lastEnd, range.offset);
      lastEnd = range.offset + range.length;
    }
    if (lastEnd < fullText.length) result += fullText.substring(lastEnd);

    return result.trim();
  }

  private isVideoMessage(message: Api.Message): boolean {
    if (message.video) return true;
    if (message.document) {
      if (message.document.mimeType?.startsWith("video/")) return true;
      const fileName = message.document.attributes?.find(
        (attr: any) => attr.className === "DocumentAttributeFilename",
      )?.fileName;
      if (fileName) {
        return [
          ".mp4",
          ".avi",
          ".mov",
          ".mkv",
          ".webm",
          ".flv",
          ".wmv",
          ".m4v",
        ].some((ext) => fileName.toLowerCase().endsWith(ext));
      }
    }
    if (message.media && message.media.className === "MessageMediaDocument") {
      if (message.media.document?.mimeType?.startsWith("video/")) return true;
    }
    return false;
  }

  private async waitForBotReply(
    client: any,
    botEntity: any,
    timeoutMs: number = 15000,
  ): Promise<Api.Message | null> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const listenerId = `${botEntity.id}_${startTime}_${Math.random()}`;
      let isResolved = false;

      const cleanup = (result: Api.Message | null) => {
        if (isResolved) return;
        isResolved = true;

        const listener = this.messageListeners.get(listenerId);
        if (listener) {
          clearTimeout(listener.timeout);
          try {
            client.removeEventHandler(listener.handler, new NewMessage({}));
          } catch (error) {
            console.warn("[kkp] 移除事件监听器失败:", error);
          }
          this.messageListeners.delete(listenerId);
        }
        resolve(result);
      };

      const timeout = setTimeout(() => cleanup(null), timeoutMs);

      const messageHandler = (event: any) => {
        try {
          const message = event.message;
          if (!message) return;
          const senderId = message.senderId?.toString();
          const botId = botEntity.id.toString();

          if (senderId === botId && message.date * 1000 >= startTime - 1000) {
            if (this.isVideoMessage(message)) cleanup(message);
          }
        } catch (error) {
          console.error("[kkp] 消息处理失败:", error);
          cleanup(null);
        }
      };

      this.messageListeners.set(listenerId, {
        resolve,
        timeout,
        startTime,
        handler: messageHandler,
      });
      try {
        client.addEventHandler(messageHandler, new NewMessage({}));
      } catch (error) {
        console.error("[kkp] 添加事件监听器失败:", error);
        cleanup(null);
      }
    });
  }

  private async getRandomVideo(msg: Api.Message, client: any): Promise<void> {
    await msg.edit({ text: "🎲 正在获取随机视频...", parseMode: "html" });

    const botUsername = "SeSe3000Bot";
    try {
      const botEntity = await client.getEntity(botUsername);
      const recentMessages = await safeGetMessages(client, botEntity, { limit: 3 });

      if (recentMessages.length === 0) {
        await client.sendMessage(botEntity, { message: "/start" });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      const replyPromise = this.waitForBotReply(client, botEntity, 20000);
      await client.sendMessage(botEntity, { message: "随机色色" });
      const videoMessage = await replyPromise;

      if (videoMessage && this.isVideoMessage(videoMessage)) {
        const mediaToSend = videoMessage.media;

        if (mediaToSend) {
          const plainTextCaption = this.extractPlainText(videoMessage);

          await msg.edit({ text: "📥 正在转发视频...", parseMode: "html" });

          let fileInput = mediaToSend;

          // 1. 视频画面剧透：手动重构 InputMediaDocument
          if (
            mediaToSend instanceof Api.MessageMediaDocument &&
            mediaToSend.document instanceof Api.Document
          ) {
            const doc = mediaToSend.document;
            fileInput = new Api.InputMediaDocument({
              id: new Api.InputDocument({
                id: doc.id,
                accessHash: doc.accessHash,
                fileReference: doc.fileReference,
              }),
              spoiler: true, // 🚨 画面剧透的关键
            });
          }

          // 2. 文字剧透：手动构造 Entity
          const finalCaption = plainTextCaption;

          // 创建一个覆盖整个文本长度的剧透实体
          // 这是最底层的实现方式，无视 ParseMode
          const spoilerEntities = [
            new Api.MessageEntitySpoiler({
              offset: 0,
              length: finalCaption.length,
            }),
          ];

          await client.sendFile(msg.peerId, {
            file: fileInput,
            caption: finalCaption, // 这里只传纯文本
            formattingEntities: spoilerEntities, // ✨ 直接传入格式化实体，不走HTML解析
            spoiler: true, // 视频画面剧透(冗余备份)
            forceDocument: false,
            // ⚠️ 注意：不要在这里加 parseMode: "html"，否则可能会覆盖 formattingEntities
          });

          try {
            await client.markAsRead(botEntity);
          } catch {}
          await msg.delete();
        } else {
          await msg.edit({ text: "❌ 无法提取视频文件", parseMode: "html" });
        }
      } else {
        await msg.edit({ text: "❌ 获取视频超时", parseMode: "html" });
      }
    } catch (botError: any) {
      console.error("[kkp] 错误:", botError);
      await msg.edit({
        text: `❌ 错误: ${htmlEscape(botError.message || "未知")}`,
        parseMode: "html",
      });
    }
  }

  async cleanup(): Promise<void> {
    const client = await getGlobalClient().catch(() => null);

    for (const [listenerId, listener] of this.messageListeners) {
      clearTimeout(listener.timeout);
      if (client) {
        try {
          client.removeEventHandler(listener.handler, new NewMessage({}));
        } catch (error) {
          console.warn("[kkp] cleanup 移除监听器失败:", error);
        }
      }
    }
    this.messageListeners.clear();
  }
}

export default new KkpPlugin();

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api, TelegramClient } from "teleproto";
import { sleep } from "teleproto/Helpers";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";

// 配置键定义
const CONFIG_KEYS = {
  DEFAULT_PACK: "sticker_default_pack",
};

// 默认配置（扁平化结构）
const DEFAULT_CONFIG: Record<string, string> = {
  [CONFIG_KEYS.DEFAULT_PACK]: "",
};

// 配置管理器类
class ConfigManager {
  private static db: any = null;
  private static initialized = false;
  private static configPath: string;

  private static async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // 使用插件专用目录
      this.configPath = path.join(
        createDirectoryInAssets("nsticker"),
        "config.json"
      );

      // 以扁平结构初始化
      this.db = await JSONFilePreset<Record<string, any>>(
        this.configPath,
        { ...DEFAULT_CONFIG }
      );
      this.initialized = true;
    } catch (error) {
      console.error("[nsticker] 初始化配置失败:", error);
    }
  }

  static async get(key: string, defaultValue?: string): Promise<string> {
    await this.init();
    if (!this.db) return defaultValue || DEFAULT_CONFIG[key] || "";

    // 直接从顶级键读取
    const value = this.db.data[key];
    return value ?? defaultValue ?? DEFAULT_CONFIG[key] ?? "";
  }

  static async set(key: string, value: string): Promise<boolean> {
    await this.init();
    if (!this.db) return false;

    try {
      this.db.data[key] = value;
      await this.db.write();
      return true;
    } catch (error) {
      console.error(`[nsticker] 设置配置失败 ${key}:`, error);
      return false;
    }
  }

  static async remove(key: string): Promise<boolean> {
    await this.init();
    if (!this.db) return false;

    try {
      delete this.db.data[key];
      await this.db.write();
      return true;
    } catch (error) {
      console.error(`[nsticker] 删除配置失败 ${key}:`, error);
      return false;
    }
  }
}


// HTML转义（每个插件必须实现）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";

// 基础表情池与随机函数（当贴纸不携带基础 emoji 时兜底）
const BASE_EMOJIS = ["😀","😁","😂","🤣","😊","😇","🙂","😉","😋","😎","😍","😘","😜","🤗","🤔","😴","😌","😅","😆","😄"];
const getRandomBaseEmoji = (): string => {
  const idx = Math.floor(Math.random() * BASE_EMOJIS.length);
  return BASE_EMOJIS[idx];
};

// Custom Error for better handling
class StickerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StickerError";
  }
}

const help_text = `⭐ <b>贴纸收藏插件</b>

<b>📝 功能描述:</b>
• 💾 <b>一键收藏</b>：回复任意贴纸即可快速保存到您的贴纸包。
• 🤖 <b>全自动处理</b>：自动创建贴纸包，并在包满时自动创建新包。
• 📁 <b>自定义包</b>：可设置一个默认的贴纸包，或临时保存到指定包。
• ✨ <b>类型支持</b>：完美支持普通、动态（.tgs）和视频（.webm）贴纸。

<b>🔧 使用方法:</b>
• 回复一个贴纸，发送 <code>${mainPrefix}sticker</code> - 保存贴纸到默认或自动创建的包。
• <code>${mainPrefix}sticker to &lt;包名&gt;</code> - (回复贴纸时) 临时保存到指定包。
• <code>${mainPrefix}sticker cancel</code> - 取消设置的默认贴纸包。
• <code>${mainPrefix}sticker</code> - (不回复贴纸) 查看当前配置。

<b>💡 使用示例:</b>
• 回复贴纸, 发送 <code>${mainPrefix}sticker</code>
• <code>${mainPrefix}sticker MyStickers</code>
• <code>${mainPrefix}sticker cancel</code>
• 回复贴纸, 发送 <code>${mainPrefix}sticker to TempPack</code>

<b>📌 注意事项:</b>
• 首次使用前，请确保您已私聊过官方的 @Stickers 机器人。
• 贴纸包名称只能包含字母、数字和下划线，且必须以字母开头。
• 若被收藏贴纸未携带基础 emoji，将自动随机选择一个基础表情作为标签。
`;

class StickerPlugin extends Plugin {
  cleanup(): void {
  }

  description: string = help_text;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sticker: async (msg: Api.Message) => await this.handleSticker(msg),
  };

  private async handleSticker(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ <b>客户端未初始化</b>", parseMode: "html" });
      return;
    }

    try {
      // 标准参数解析
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();
      const repliedMsg = await msg.getReplyMessage();

      // 处理 help 在前的情况：.s help 或 .s h
      if (sub === "help" || sub === "h") {
        await msg.edit({ text: help_text, parseMode: "html", linkPreview: false });
        return;
      }

      // Case 1: No reply, handle configuration
      if (!repliedMsg || !repliedMsg.sticker) {
        await this.handleConfiguration(msg, args, client);
        return;
      }

      // Case 2: Replied to a sticker, handle saving
      await msg.edit({ text: "🤔 <b>正在处理贴纸...</b>", parseMode: "html" });

      const sticker = repliedMsg.sticker;
      if (!(sticker instanceof Api.Document)) {
        throw new StickerError("回复的消息不是有效的贴纸。");
      }
      
      // 更准确的贴纸类型检测
      const mimeType = sticker.mimeType || "";
      const isAnimated = mimeType === "application/x-tgsticker";
      const isVideo = mimeType === "video/webm";
      const isStatic = !isAnimated && !isVideo && (mimeType === "image/webp" || mimeType === "image/png");
      
      const stickerInfo = {
        isAnimated,
        isVideo,
        isStatic,
        emoji: (() => {
          const alt = sticker.attributes.find(
            (a): a is Api.DocumentAttributeSticker => a instanceof Api.DocumentAttributeSticker
          )?.alt?.trim();
          return alt && alt.length > 0 ? alt : getRandomBaseEmoji();
        })(),
        document: new Api.InputDocument({
          id: sticker.id,
          accessHash: sticker.accessHash,
          fileReference: sticker.fileReference,
        }),
      };
      
      let targetPackName = "";
      if (args.length === 2 && args[0].toLowerCase() === "to") {
        targetPackName = args[1];
      } else {
        targetPackName = await ConfigManager.get(CONFIG_KEYS.DEFAULT_PACK) || "";
      }

      const me = await client.getMe();
      if (!(me instanceof Api.User)) {
          throw new StickerError("无法获取您的用户信息。");
      }
      if (!me.username && !targetPackName) {
        throw new StickerError(
          "您没有设置用户名，无法自动创建贴纸包。\n" +
          `请使用 <code>${htmlEscape(mainPrefix)}sticker &lt;您的贴纸包名&gt;</code> 设置一个默认包。`
        );
      }
      
      await msg.edit({ text: "✅ <b>贴纸信息已解析，正在查找贴纸包...</b>", parseMode: "html" });

      const { packName, shouldCreate } = await this.findOrCreatePack(
        client,
        targetPackName,
        me.username || "user",
        stickerInfo
      );

      if (shouldCreate) {
        await msg.edit({ text: `➕ <b>正在创建新贴纸包:</b> <code>${htmlEscape(packName)}</code>...`, parseMode: "html" });
        await this.createStickerSet(client, me, packName, stickerInfo);
      } else {
        await msg.edit({ text: `📥 <b>正在添加到贴纸包:</b> <code>${htmlEscape(packName)}</code>...`, parseMode: "html" });
        await this.addToStickerSet(client, repliedMsg, packName, stickerInfo.emoji);
      }
      
      const successMsg = await msg.edit({
        text: `✅ <b>收藏成功！</b>\n\n贴纸已添加到 <a href="https://t.me/addstickers/${htmlEscape(packName)}">${htmlEscape(packName)}</a>`,
        parseMode: "html",
        linkPreview: false,
      });
      
      // 修复: 增加对 successMsg 的有效性检查
      if (successMsg && typeof successMsg !== 'boolean') {
        await sleep(5000);
        await successMsg.delete();
      }

    } catch (error: any) {
      console.error("[nsticker] 插件执行失败:", error);
      
      // 处理特定错误类型
      if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        await msg.edit({
          text: `⏳ <b>请求过于频繁</b>\n\n需要等待 ${waitTime} 秒后重试`,
          parseMode: "html"
        });
        return;
      }
      
      if (error.message?.includes("MESSAGE_TOO_LONG")) {
        await msg.edit({
          text: "❌ <b>消息过长</b>\n\n请减少内容长度或使用文件发送",
          parseMode: "html"
        });
        return;
      }
      
      // 通用错误处理
      const errorMessage = error instanceof StickerError ? error.message : `未知错误: ${htmlEscape(error.message || "发生未知错误")}`;
      await msg.edit({
        text: `❌ <b>操作失败:</b> ${errorMessage}`,
        parseMode: "html",
      });
    }
  }

  private async handleConfiguration(msg: Api.Message, args: string[], client: TelegramClient): Promise<void> {
    if (args[0]?.toLowerCase() === "help") {
      await msg.edit({ text: help_text, parseMode: "html", linkPreview: false });
      return;
    }
    
    if (args.length === 0) { // Show current config
      const defaultPack = await ConfigManager.get(CONFIG_KEYS.DEFAULT_PACK);
      let text = "⚙️ <b>贴纸收藏插件设置</b>\n\n";
      if (defaultPack) {
        text += `当前默认贴纸包: <a href="https://t.me/addstickers/${htmlEscape(defaultPack)}">${htmlEscape(defaultPack)}</a>`;
      } else {
        const me = await client.getMe();
        if (me instanceof Api.User && me.username) {
            text += `未设置默认贴纸包，将自动使用 <code>${htmlEscape(me.username)}_...</code> 系列包。`;
        } else {
            text += `未设置默认贴纸包，且您没有用户名，收藏前必须先设置一个默认包。`;
        }
      }
      await msg.edit({ text, parseMode: "html", linkPreview: false });
      return;
    }

    if (args.length === 1) {
      if (args[0].toLowerCase() === "cancel") {
        await ConfigManager.remove(CONFIG_KEYS.DEFAULT_PACK);
        await msg.edit({ text: "✅ <b>已取消默认贴纸包。</b>", parseMode: "html" });
      } else { // Set new default pack
        const packName = args[0];
        await msg.edit({ text: `🤔 <b>正在验证贴纸包</b> <code>${htmlEscape(packName)}</code>...`, parseMode: "html" });
        try {
            await client.invoke(new Api.messages.GetStickerSet({
                stickerset: new Api.InputStickerSetShortName({ shortName: packName }),
                hash: 0,
            }));
            await ConfigManager.set(CONFIG_KEYS.DEFAULT_PACK, packName);
            await msg.edit({ text: `✅ <b>默认贴纸包已设置为:</b> <code>${htmlEscape(packName)}</code>`, parseMode: "html" });
        } catch (error) {
            throw new StickerError(`无法访问贴纸包 <code>${htmlEscape(packName)}</code>。请确保它存在且您有权访问。`);
        }
      }
    } else {
        throw new StickerError("参数错误。");
    }
  }
  
  private async findOrCreatePack(
    client: TelegramClient,
    packName: string,
    username: string,
    stickerInfo: { isAnimated: boolean; isVideo: boolean; isStatic: boolean }
  ): Promise<{ packName: string; shouldCreate: boolean }> {
      if (packName) { // User specified a pack (default or temporary)
          try {
              const result = await client.invoke(new Api.messages.GetStickerSet({
                  stickerset: new Api.InputStickerSetShortName({ shortName: packName }),
                  hash: 0,
              }));
              // 修复: 使用类型守卫安全访问 .set 属性
              if (result instanceof Api.messages.StickerSet) {
                  if (result.set.count >= 120) {
                      throw new StickerError(`贴纸包 <code>${htmlEscape(packName)}</code> 已满 (120/120)。`);
                  }
                  return { packName, shouldCreate: false };
              }
              // Handle StickerSetNotModified case if necessary, though unlikely with hash: 0
              return { packName, shouldCreate: false }; 
          } catch (error: any) {
            if (error.errorMessage === 'STICKERSET_INVALID') {
                return { packName, shouldCreate: true };
            }
            throw new StickerError(`检查贴纸包 <code>${htmlEscape(packName)}</code> 时出错: ${htmlEscape(error.message)}`);
          }
      }

      // Auto-generation logic - 为每种类型贴纸分配专用后缀
      let suffix = "_static";  // 默认静态贴纸
      if (stickerInfo.isAnimated) {
        suffix = "_animated";
      } else if (stickerInfo.isVideo) {
        suffix = "_video";
      }
      
      for (let i = 1; i <= 50; i++) { // Try up to 50 packs
          const autoPackName = `${username}${suffix}_${i}`;
          try {
              const result = await client.invoke(new Api.messages.GetStickerSet({
                  stickerset: new Api.InputStickerSetShortName({ shortName: autoPackName }),
                  hash: 0,
              }));
              // 修复: 使用类型守卫安全访问 .set 属性
              if (result instanceof Api.messages.StickerSet) {
                  if (result.set.count < 120) {
                      return { packName: autoPackName, shouldCreate: false };
                  }
              }
              // If full or not modified, loop continues to the next index
          } catch (error: any) {
              if (error.errorMessage === 'STICKERSET_INVALID') {
                  // This pack name is available, so we'll create it
                  return { packName: autoPackName, shouldCreate: true };
              }
              // For other errors, we stop
              throw new StickerError(`检查自动生成的贴纸包时出错: ${htmlEscape(error.message)}`);
          }
      }

      throw new StickerError("自动创建贴纸包失败，已尝试超过50个。");
  }

  private async createStickerSet(
    client: TelegramClient,
    me: Api.User,
    packName: string,
    stickerInfo: { isAnimated: boolean; isVideo: boolean; isStatic: boolean; emoji: string, document: Api.InputDocument }
  ): Promise<void> {
    let title = `@${me.username} 的收藏`;
    if (stickerInfo.isAnimated) title += " (动态)";
    else if (stickerInfo.isVideo) title += " (视频)";
    else if (stickerInfo.isStatic) title += " (静态)";

    try {
      await client.invoke(new Api.stickers.CreateStickerSet({
        userId: "me",
        title: title,
        shortName: packName,
        stickers: [new Api.InputStickerSetItem({
          document: stickerInfo.document,
          emoji: stickerInfo.emoji,
        })],
      }));
    } catch (error: any) {
        let friendlyMessage = `创建贴纸包失败: ${error.message}`;
        if (error.errorMessage) {
            switch (error.errorMessage) {
                case 'STICKER_VIDEO_LONG':
                    friendlyMessage = '视频贴纸时长不能超过3秒。';
                    break;
                case 'STICKER_PNG_DIMENSIONS':
                    friendlyMessage = '静态贴纸尺寸必须为 512xN 或 Nx512 (一边为512px)。';
                    break;
                case 'STICKERSET_INVALID':
                    friendlyMessage = '贴纸包名称无效或已被占用 (只能用字母、数字、下划线，且以字母开头)。';
                    break;
                case 'PEER_ID_INVALID':
                    friendlyMessage = '无法与 @Stickers 机器人通信，请先私聊它一次。';
                    break;
            }
        }
        throw new StickerError(friendlyMessage);
    }
  }

  private async addToStickerSet(
    client: TelegramClient,
    stickerMsg: Api.Message,
    packName: string,
    emoji: string
  ): Promise<void> {
    const stickersBot = "stickers";
    try {
        // Helper to get the latest message from the bot
        const getLatestBotResponse = async () => {
            const history = await client.getMessages(stickersBot, { limit: 1 });
            return history[0];
        };

        // Start conversation
        await client.sendMessage(stickersBot, { message: "/addsticker" });
        await sleep(1500); // Wait for bot to respond

        // Send pack name
        await client.sendMessage(stickersBot, { message: packName });
        await sleep(1500);
        let response = await getLatestBotResponse();
        if (response?.message.toLowerCase().includes("invalid set")) {
            throw new StickerError(`贴纸包 <code>${htmlEscape(packName)}</code> 无效或您不是该包的所有者。`);
        }

        // 修复: 转发消息需要提供 fromPeer
        await client.forwardMessages(stickersBot, {
            messages: [stickerMsg.id],
            fromPeer: stickerMsg.peerId,
        });
        await sleep(2500); // Wait for processing and response
        response = await getLatestBotResponse();
        
        if (response?.message) {
            const responseText = response.message.toLowerCase();
            if (responseText.includes("sorry, the video is too long") || responseText.includes("duration of the video must be 3 seconds or less")) {
                throw new StickerError("视频贴纸时长不能超过3秒。");
            }
            if (responseText.includes("the sticker's dimensions should be")) {
                throw new StickerError("静态贴纸尺寸必须为 512xN 或 Nx512。");
            }
            if (!responseText.includes("thanks! now send me an emoji")) {
                throw new StickerError(`添加贴纸时机器人返回未知信息: "${htmlEscape(response.message)}"`);
            }
        } else {
             throw new StickerError("添加贴纸后没有收到 @Stickers 机器人的回复。");
        }
        
        // Send emoji
        await client.sendMessage(stickersBot, { message: emoji });
        await sleep(1500);

        // Finish
        await client.sendMessage(stickersBot, { message: "/done" });

    } catch (error: any) {
      // Try to cancel the operation with the bot on failure
      await client.sendMessage(stickersBot, { message: "/cancel" });
      if (error instanceof StickerError) {
          throw error; // Re-throw our custom, user-friendly error
      }
      throw new StickerError(`与 @Stickers 机器人交互失败: ${htmlEscape(error.message)}`);
    }
  }
}

export default new StickerPlugin();

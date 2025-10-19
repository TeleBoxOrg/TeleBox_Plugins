import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { banUser } from "@utils/banUtils";
import { Api, TelegramClient } from "telegram";
// 使用简化的事件类型定义
interface NewMessageEvent {
  message: Api.Message;
}

interface EditedMessageEvent {
  message: Api.Message;
}
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as crypto from "crypto";

// ==================== 类型定义 ====================
type Action = "delete" | "ban";

interface MonitoredChat {
  id: string;
  name: string;
  username?: string; // 添加 username 字段
}

interface Config {
  enabled: boolean;
  monitoredChats: MonitoredChat[];
  bannedMD5s: Record<string, Action>;
  bannedStickerIds: Record<string, Action>;
  defaultAction: Action;
}

// ==================== 配置 ====================
const PLUGIN_NAME = "image_monitor";
const CONFIG_FILE = `${PLUGIN_NAME}_config.json`;
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB

const DEFAULT_CONFIG: Config = {
  enabled: true,
  monitoredChats: [],
  bannedMD5s: {},
  bannedStickerIds: {},
  defaultAction: "delete",
};

// ==================== 帮助文本 ====================
const HELP_TEXT = `<b>🖼️ 图片监控插件 (image_monitor)</b>

自动监控指定群组的图片，并对匹配MD5哈希的图片执行操作。

<b>命令格式:</b>
<code>.im [子命令] [参数]</code>

<b>子命令:</b>
• <code>.im on</code> - 启用插件
• <code>.im off</code> - 禁用插件
• <code>.im addchat [chatId|@username]</code> - 添加监控群组 (默认为当前群组)
• <code>.im delchat [chatId|@username]</code> - 删除监控群组 (默认为当前群组)
• <code>.im addmd5 &lt;md5&gt; &lt;delete|ban&gt;</code> - 添加MD5及操作
• <code>.im delmd5 &lt;md5&gt;</code> - 删除MD5
• <code>.im setaction <delete|ban></code> - 设置回复时的默认操作
• <code>.im list</code> - 查看当前配置
• <code>.im help</code> - 显示此帮助

<b>快速操作:</b>
• 回复图片/媒体/贴纸使用 <code>.im [delete|ban]</code> - 快速添加（图片MD5/文件MD5/贴纸ID），未指定时使用默认操作`;

// ==================== 工具函数 ====================
const htmlEscape = (text: string): string =>
  text.replace(/[&<>'"/]/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
    "/": "&#x2F;",
  }[m] || m));

async function getPeerId(client: TelegramClient, msg: Api.Message, chatIdStr?: string): Promise<string | null> {
    try {
        const peer = chatIdStr ? chatIdStr : msg.peerId;
        const resolved = await client.getInputEntity(peer);
        if (resolved instanceof Api.InputPeerChannel) {
            return `-100${resolved.channelId}`;
        }
        if (resolved instanceof Api.InputPeerChat) {
            return `-${resolved.chatId}`;
        }
        if (resolved instanceof Api.InputPeerUser) {
            return `${resolved.userId}`;
        }
        return null;
    } catch (e) {
        console.error(`[${PLUGIN_NAME}] Could not resolve peer:`, e);
        return null;
    }
}

// ==================== 消息管理器 ====================
class MessageManager {
  static async edit(msg: Api.Message, text: string, options: { parseMode?: "html" | "md", deleteAfter?: number } = {}): Promise<void> {
    const { parseMode = "html", deleteAfter = 10 } = options;
    try {
      await msg.edit({ text, parseMode });
      if (deleteAfter > 0) {
        setTimeout(() => msg.delete({ revoke: true }).catch(() => {}), deleteAfter * 1000);
      }
    } catch (e) {
      // Ignore errors if message was deleted or something
    }
  }
}

// ==================== 配置管理器 ====================
class ConfigManager {
  private static db: any = null;

  static async init() {
    if (this.db) return;
    const dbPath = path.join(createDirectoryInAssets(PLUGIN_NAME), CONFIG_FILE);
    this.db = await JSONFilePreset<Config>(dbPath, DEFAULT_CONFIG);
    // 迁移与标准化
    this.normalize();
  }

  static async getConfig(): Promise<Config> {
    await this.init();
    // 再次保证标准化（防止外部意外写入）
    this.normalize();
    return this.db.data;
  }

  static async saveConfig() {
    await this.init();
    await this.db.write();
  }

  private static normalize() {
    const data = this.db?.data as any;
    if (!data) return;
    // 兼容旧版 monitoredChats: (string|number)[] -> MonitoredChat[]
    if (Array.isArray(data.monitoredChats)) {
      const first = data.monitoredChats[0];
      if (first && (typeof first === 'string' || typeof first === 'number')) {
        data.monitoredChats = (data.monitoredChats as (string|number)[]).map((id) => ({ id: String(id), name: String(id) }));
      }
    } else {
      data.monitoredChats = [];
    }
    // 确保 bannedStickerIds 存在
    if (!data.bannedStickerIds || typeof data.bannedStickerIds !== 'object') {
      data.bannedStickerIds = {};
    }
    // 确保 defaultAction 存在
    if (data.defaultAction !== 'delete' && data.defaultAction !== 'ban') {
      data.defaultAction = 'delete';
    }
  }
}

// ==================== 主插件类 ====================
class ImageMonitorPlugin extends Plugin {
  description: string = HELP_TEXT;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    im: this.handleConfigCommand.bind(this),
  };

  constructor() {
    super();
    this.initialize();
  }

  private async initialize() {
    await ConfigManager.init();
    console.log("[image_monitor] Plugin initialized");
  }

  // 消息监听器 - TeleBox会自动调用这个方法
  listenMessageHandler = async (msg: Api.Message, options?: { isEdited?: boolean }) => {
    const client = await getGlobalClient();
    if (!client) return;

    // 检查是否为回复图片并添加MD5的命令
    const text = msg.text || "";
    const commandParts = text.split(" ");
    const command = commandParts[0].toLowerCase();
    const subCommand = commandParts[1]?.toLowerCase();

    if (msg.isReply && (command === ".im" || command === "im")) {
        const repliedMsg = await msg.getReplyMessage();
        if (!repliedMsg) {
            await MessageManager.edit(msg, "❌ 未找到被回复的消息。");
            return;
        }

        const config = await ConfigManager.getConfig();
        if (!config.bannedStickerIds) config.bannedStickerIds = {};
        const action = (subCommand === 'ban' || subCommand === 'delete') ? subCommand as Action : config.defaultAction;

        const media = repliedMsg.media;
        if (!media) {
            await MessageManager.edit(msg, "❌ 该回复不是图片、媒体或贴纸。请回复包含图片/媒体/贴纸的消息后再使用 <code>.im</code>。");
            return;
        }

        try {
            if (media instanceof Api.MessageMediaDocument) {
                const docRaw = media.document;
                if (docRaw instanceof Api.Document) {
                    const isSticker = Array.isArray(docRaw.attributes) && docRaw.attributes.some(a => a instanceof Api.DocumentAttributeSticker);
                    if (isSticker) {
                        const stickerId = String(docRaw.id);
                        config.bannedStickerIds[stickerId] = action;
                        await ConfigManager.saveConfig();
                        await MessageManager.edit(msg, `✅ 已添加贴纸ID: <code>${htmlEscape(stickerId)}</code>，操作: <code>${action}</code>`);
                        return;
                    }
                    if (docRaw.size && Number(docRaw.size) > MAX_FILE_SIZE) {
                        await MessageManager.edit(msg, "❌ 文件过大，已超过限制。" );
                        return;
                    }
                }
                await MessageManager.edit(msg, "⏳ 正在计算文件MD5...", { deleteAfter: 0 });
                const buffer = await client.downloadMedia(media, {});
                if (!buffer) {
                    await MessageManager.edit(msg, "❌ 下载媒体失败。");
                    return;
                }
                const md5 = crypto.createHash('md5').update(buffer).digest('hex');
                config.bannedMD5s[md5] = action;
                await ConfigManager.saveConfig();
                await MessageManager.edit(msg, `✅ 已添加文件MD5: <code>${htmlEscape(md5)}</code>，操作: <code>${action}</code>`);
                return;
            }

            if (media instanceof Api.MessageMediaPhoto) {
                await MessageManager.edit(msg, "⏳ 正在计算图片MD5...", { deleteAfter: 0 });
                const buffer = await client.downloadMedia(media, {});
                if (!buffer) {
                    await MessageManager.edit(msg, "❌ 下载图片失败。");
                    return;
                }
                const md5 = crypto.createHash('md5').update(buffer).digest('hex');
                config.bannedMD5s[md5] = action;
                await ConfigManager.saveConfig();
                await MessageManager.edit(msg, `✅ 已添加图片MD5: <code>${htmlEscape(md5)}</code>，操作: <code>${action}</code>`);
                return;
            }

            await MessageManager.edit(msg, "❌ 不支持的媒体类型。请回复图片、媒体或贴纸。");
        } catch (error: any) {
            console.error(`[${PLUGIN_NAME}] Failed to process replied media:`, error);
            await MessageManager.edit(msg, `❌ 处理媒体时出错: ${htmlEscape(error.message)}`);
        }
        return;
    }

    // 如果不是回复命令，则执行常规的消息处理
    if (options?.isEdited) {
      await this.handleEditedMessage({ message: msg } as EditedMessageEvent);
    } else {
      await this.handleNewMessage({ message: msg } as NewMessageEvent);
    }
  };

  // 不忽略编辑消息
  ignoreEdited = false

  private async handleConfigCommand(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;

    const args = msg.text?.split(" ").slice(1) || [];
    const subCommand = args[0]?.toLowerCase();
    const config = await ConfigManager.getConfig();



    try {
      switch (subCommand) {
        case "on":
          config.enabled = true;
          await ConfigManager.saveConfig();
          await MessageManager.edit(msg, "✅ 图片监控已启用。");
          break;
        case "off":
          config.enabled = false;
          await ConfigManager.saveConfig();
          await MessageManager.edit(msg, "❌ 图片监控已禁用。");
          break;
        case "addchat": {
          const chatIdStr = args[1];
          const peerIdentifier = chatIdStr || msg.peerId;
          try {
            const peerId = await getPeerId(client, msg, chatIdStr);
            if (!peerId) {
              await MessageManager.edit(msg, "❌ 无法解析群组ID或用户名。");
              return;
            }
            const entity: any = await client.getEntity(peerIdentifier);
            let chatName: string;
            if (entity && 'username' in entity && entity.username) {
              chatName = `@${entity.username}`;
            } else if (entity && 'title' in entity && entity.title) {
              chatName = entity.title as string;
            } else {
              chatName = peerId;
            }

            if (!config.monitoredChats.some(c => c.id === peerId)) {
              config.monitoredChats.push({ id: peerId, name: chatName, username: entity?.username });
              await ConfigManager.saveConfig();
              await MessageManager.edit(msg, `✅ 已添加监控群组: <code>${htmlEscape(chatName)}</code> (<code>${peerId}</code>)`);
            } else {
              await MessageManager.edit(msg, `ℹ️ 群组 <code>${htmlEscape(chatName)}</code> 已在监控列表中。`);
            }
          } catch (e) {
            await MessageManager.edit(msg, "❌ 无法解析群组ID或用户名。");
          }
          break;
        }
        case "delchat": {
          const chatIdStr = args[1];
          const peerIdentifier = chatIdStr || msg.peerId;
          try {
            const peerId = await getPeerId(client, msg, chatIdStr);
            if (!peerId) {
              await MessageManager.edit(msg, "❌ 无法解析群组ID或用户名。");
              return;
            }
            const entity: any = await client.getEntity(peerIdentifier);
            let chatName: string;
            if (entity && 'username' in entity && entity.username) {
              chatName = `@${entity.username}`;
            } else if (entity && 'title' in entity && entity.title) {
              chatName = entity.title as string;
            } else {
              chatName = peerId;
            }

            const index = config.monitoredChats.findIndex(c => c.id === peerId);

            if (index > -1) {
              const removedChat = config.monitoredChats.splice(index, 1)[0];
              await ConfigManager.saveConfig();
              await MessageManager.edit(msg, `✅ 已移除监控群组: <code>${htmlEscape(removedChat.name)}</code>`);
            } else {
              await MessageManager.edit(msg, `ℹ️ 群组 <code>${htmlEscape(chatName)}</code> 不在监控列表中。`);
            }
          } catch (e) {
            await MessageManager.edit(msg, "❌ 无法解析群组ID或用户名。");
          }
          break;
        }
        case "addmd5": {
          const md5 = args[1];
          const action = args[2] as Action;
          if (!md5 || !action || !["delete", "ban"].includes(action)) {
            await MessageManager.edit(msg, "❌ 用法: <code>.im addmd5 &lt;md5&gt; &lt;delete|ban&gt;</code>");
            return;
          }
          config.bannedMD5s[md5] = action;
          await ConfigManager.saveConfig();
          await MessageManager.edit(msg, `✅ 已添加MD5: <code>${htmlEscape(md5)}</code>，操作: <code>${action}</code>`);
          break;
        }
        case "delmd5": {
          const md5 = args[1];
          if (!md5) {
            await MessageManager.edit(msg, "❌ 用法: <code>.im delmd5 &lt;md5&gt;</code>");
            return;
          }
          if (config.bannedMD5s[md5]) {
            delete config.bannedMD5s[md5];
            await ConfigManager.saveConfig();
            await MessageManager.edit(msg, `✅ 已删除MD5: <code>${htmlEscape(md5)}</code>`);
          } else {
            await MessageManager.edit(msg, `ℹ️ MD5 <code>${htmlEscape(md5)}</code> 不在列表中。`);
          }
          break;
        }
        case "setaction": {
          const action = args[1] as Action;
          if (!action || !["delete", "ban"].includes(action)) {
            await MessageManager.edit(msg, "❌ 用法: <code>.im setaction &lt;delete|ban&gt;</code>");
            return;
          }
          config.defaultAction = action;
          await ConfigManager.saveConfig();
          await MessageManager.edit(msg, `✅ 默认操作已设置为: <code>${action}</code>`);
          break;
        }
        case "list": {
          let output = `<b>🖼️ 图片监控配置</b>\n\n`;
          output += `<b>状态:</b> ${config.enabled ? "启用" : "禁用"}\n`;
          output += `<b>默认操作:</b> <code>${config.defaultAction}</code>\n`;
          output += `<b>监控群组:</b>\n${config.monitoredChats.map(c => `<code>- ${htmlEscape(c.name)} (${c.id})</code>`).join("\n") || "无"}\n\n`;
          output += `<b>MD5列表:</b>\n`;
          const md5s = Object.entries(config.bannedMD5s);
          if (md5s.length > 0) {
            output += md5s.map(([md5, action]) => `<code>- ${htmlEscape(md5)} (${action})</code>`).join("\n");
          } else {
            output += "无";
          }
          output += `\n\n<b>贴纸ID列表:</b>\n`;
          const stickers = Object.entries(config.bannedStickerIds || {});
          if (stickers.length > 0) {
            output += stickers.map(([sid, action]) => `<code>- ${htmlEscape(sid)} (${action})</code>`).join("\n");
          } else {
            output += "无";
          }
          await MessageManager.edit(msg, output, { deleteAfter: 30 });
          break;
        }
        case "help":
        default:
          await MessageManager.edit(msg, HELP_TEXT, { deleteAfter: 30 });
          break;
      }
    } catch (error: any) {
        console.error(`[${PLUGIN_NAME}] Command failed:`, error);
        await MessageManager.edit(msg, `❌ 命令执行失败: ${htmlEscape(error.message)}`);
    }
  }

  private async handleNewMessage(event: NewMessageEvent): Promise<void> {
    const config = await ConfigManager.getConfig();
    if (!config.enabled || !event.message.peerId) return;

    const client = await getGlobalClient();
    if (!client) return;

    const msg = event.message;
    const chatId = await getPeerId(client, msg);

        if (chatId && config.monitoredChats.some(c => c.id === chatId)) {
        console.log(`[${PLUGIN_NAME}] Processing new message ${msg.id} in chat ${chatId}`);
        await this.processImageMessage(msg, client, config);
    }
  }

  private async handleEditedMessage(event: EditedMessageEvent): Promise<void> {
    const config = await ConfigManager.getConfig();
    if (!config.enabled || !event.message.peerId) return;

    const client = await getGlobalClient();
    if (!client) return;

    const msg = event.message;
    const chatId = await getPeerId(client, msg);

        if (chatId && config.monitoredChats.some(c => c.id === chatId)) {
        console.log(`[${PLUGIN_NAME}] Processing edited message ${msg.id} in chat ${chatId}`);
        await this.processImageMessage(msg, client, config);
    }
  }

  private async processImageMessage(msg: Api.Message, client: TelegramClient, config: Config): Promise<void> {
    let media: Api.MessageMediaPhoto | Api.MessageMediaDocument | undefined;
    let fileSize: number | undefined;

    if (!msg.media) return;

    if (msg.media instanceof Api.MessageMediaDocument) {
        const docRaw = msg.media.document;
        if (docRaw instanceof Api.Document) {
            const isSticker = Array.isArray(docRaw.attributes) && docRaw.attributes.some(a => a instanceof Api.DocumentAttributeSticker);
            if (isSticker) {
                const stickerId = String(docRaw.id);
                const action = config.bannedStickerIds?.[stickerId];
                if (action) {
                    try {
                        if (action === 'delete') {
                            await msg.delete({ revoke: true });
                        } else if (action === 'ban') {
                            const senderId = msg.senderId;
                            if (senderId) {
                                await banUser(client, await msg.getInputChat(), senderId);
                                await msg.delete({ revoke: true });
                            }
                        }
                    } catch (err: any) {
                        if (err.message?.includes('CHAT_ADMIN_REQUIRED')) {
                            console.error(`[${PLUGIN_NAME}] Action failed in chat ${msg.chatId}: Bot is not an admin or lacks permissions.`);
                        } else if (err.message?.includes('USER_ID_INVALID')) {
                            console.error(`[${PLUGIN_NAME}] Action failed in chat ${msg.chatId}: Invalid user ID.`);
                        } else {
                            console.error(`[${PLUGIN_NAME}] Action failed for message ${msg.id}:`, err);
                        }
                    }
                    return;
                }
            }
            if (docRaw.mimeType?.startsWith("image/")) {
                fileSize = docRaw.size ? Number(docRaw.size) : undefined;
                media = msg.media;
            } else {
                return;
            }
        }
    } else if (msg.media instanceof Api.MessageMediaPhoto) {
        media = msg.media;
        const photo = media.photo as Api.Photo;
        const sizes: number[] = [];
        for (const s of photo.sizes) {
            if (s instanceof Api.PhotoSize) {
                sizes.push(s.size);
            } else if (s instanceof Api.PhotoSizeProgressive) {
                sizes.push(Math.max(...s.sizes));
            }
        }
        if (sizes.length > 0) {
            fileSize = Math.max(...sizes);
        }
    }

    if (!media || (fileSize !== undefined && fileSize > MAX_FILE_SIZE)) {
        return;
    }

    try {
        const buffer = await client.downloadMedia(media, {});
        if (!buffer) {
            return;
        }
        const md5 = crypto.createHash('md5').update(buffer).digest('hex');
        const action = config.bannedMD5s[md5];
        if (action) {
            try {
                if (action === 'delete') {
                    await msg.delete({ revoke: true });
                } else if (action === 'ban') {
                    const senderId = msg.senderId;
                    if (senderId) {
                        await banUser(client, await msg.getInputChat(), senderId);
                        await msg.delete({ revoke: true });
                    }
                }
            } catch (err: any) {
                if (err.message?.includes('CHAT_ADMIN_REQUIRED')) {
                    console.error(`[${PLUGIN_NAME}] Action failed in chat ${msg.chatId}: Bot is not an admin or lacks permissions.`);
                } else if (err.message?.includes('USER_ID_INVALID')) {
                    console.error(`[${PLUGIN_NAME}] Action failed in chat ${msg.chatId}: Invalid user ID.`);
                } else {
                    console.error(`[${PLUGIN_NAME}] Action failed for message ${msg.id}:`, err);
                }
            }
        }
    } catch (error: any) {
        console.error(`[${PLUGIN_NAME}] Failed to process media in message ${msg.id}:`, error);
    }
  }
}

export default new ImageMonitorPlugin();

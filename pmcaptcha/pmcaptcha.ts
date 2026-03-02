import { Api, TelegramClient } from "telegram";
import path from "path";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";

const PLUGIN_VERSION = "4.1.0";

enum LogLevel {
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

function log(level: LogLevel, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const levelStr = LogLevel[level];
  const prefix = `[PMCaptcha] [${timestamp}] [${levelStr}]`;
  
  if (data) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";

const pmcaptchaDir = createDirectoryInAssets("pmcaptcha");

interface ConfigDatabase {
  data: Record<string, any>;
  write: () => Promise<void>;
}

let configDb: ConfigDatabase | null = null;
let configDbReady = false;

const CONFIG_KEYS = {
  ENABLED: "plugin_enabled",
  WHITELIST: "whitelist_user_ids"
};

const DEFAULT_CONFIG = {
  [CONFIG_KEYS.ENABLED]: true,
  [CONFIG_KEYS.WHITELIST]: [] as number[]
};

async function initConfigDb() {
  try {
    const configPath = path.join(pmcaptchaDir, "pmcaptcha_config.json");
    configDb = await JSONFilePreset(configPath, DEFAULT_CONFIG) as ConfigDatabase;
    configDbReady = true;
    log(LogLevel.INFO, "Configuration database initialized");
  } catch (error) {
    log(LogLevel.ERROR, "Failed to initialize config database", error);
    configDbReady = false;
  }
}

async function waitForConfigDb(timeout = 5000): Promise<boolean> {
  const startTime = Date.now();
  while (!configDbReady && Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return configDbReady;
}

initConfigDb();

const dbHelpers = {
  getSetting: (key: string, defaultValue: any = null) => {
    if (!configDb || !configDbReady) return defaultValue;
    try {
      const value = configDb.data[key];
      return value !== undefined ? value : defaultValue;
    } catch (error) {
      console.error(`[PMCaptcha] Failed to get setting ${key}:`, error);
      return defaultValue;
    }
  },

  isPluginEnabled: (): boolean => {
    return dbHelpers.getSetting(CONFIG_KEYS.ENABLED, true);
  },

  setPluginEnabled: (enabled: boolean) => {
    dbHelpers.setSetting(CONFIG_KEYS.ENABLED, enabled);
  },

  setSetting: (key: string, value: any) => {
    if (!configDb || !configDbReady) {
      console.error("[PMCaptcha] Config database not initialized");
      return;
    }
    try {
      configDb.data[key] = value;
      configDb.write();
    } catch (error) {
      console.error(`[PMCaptcha] Failed to set setting ${key}:`, error);
    }
  },

  isWhitelisted: (userId: number): boolean => {
    if (!userId || userId <= 0) return false;
    const whitelist = dbHelpers.getSetting(CONFIG_KEYS.WHITELIST, []) as number[];
    return whitelist.includes(userId);
  },

  addToWhitelist: (userId: number) => {
    if (!userId || userId <= 0) return;
    const whitelist = dbHelpers.getSetting(CONFIG_KEYS.WHITELIST, []) as number[];
    if (!whitelist.includes(userId)) {
      whitelist.push(userId);
      dbHelpers.setSetting(CONFIG_KEYS.WHITELIST, whitelist);
      log(LogLevel.INFO, `Added user ${userId} to whitelist`);
    }
  },

  removeFromWhitelist: (userId: number) => {
    if (!userId || userId <= 0) return;
    const whitelist = dbHelpers.getSetting(CONFIG_KEYS.WHITELIST, []) as number[];
    const filtered = whitelist.filter(id => id !== userId);
    if (filtered.length !== whitelist.length) {
      dbHelpers.setSetting(CONFIG_KEYS.WHITELIST, filtered);
      log(LogLevel.INFO, `Removed user ${userId} from whitelist`);
    }
  },

  clearWhitelist: () => {
    dbHelpers.setSetting(CONFIG_KEYS.WHITELIST, []);
    log(LogLevel.INFO, "Cleared entire whitelist");
  }
};

const userInfoCache = new Map<number, { firstName: string; lastName?: string }>();

async function getUserInfo(client: TelegramClient, userId: number): Promise<{ firstName: string; lastName?: string } | null> {
  if (userInfoCache.has(userId)) {
    return userInfoCache.get(userId)!;
  }
  try {
    const entity = await client.getEntity(userId);
    if (entity && 'firstName' in entity) {
      const info = {
        firstName: entity.firstName || '',
        lastName: entity.lastName
      };
      userInfoCache.set(userId, info);
      return info;
    }
    return null;
  } catch (error) {
    log(LogLevel.ERROR, `Failed to get user info for ${userId}`, error);
    return null;
  }
}

async function getUserDisplayName(client: TelegramClient, userId: number): Promise<string> {
  const info = await getUserInfo(client, userId);
  if (info) {
    const fullName = info.lastName ? `${info.firstName} ${info.lastName}`.trim() : info.firstName;
    return fullName || 'Unknown';
  }
  return 'Unknown';
}

async function isUserBot(client: TelegramClient, userId: number): Promise<boolean> {
  try {
    const entity = await client.getEntity(userId);
    return !!(entity as any).bot;
  } catch (error) {
    log(LogLevel.ERROR, `Failed to check if user ${userId} is bot`, error);
    return false;
  }
}

async function setFolder(client: TelegramClient, userId: number, folderId: number): Promise<boolean> {
  try {
    const peer = await client.getInputEntity(userId);
    await client.invoke(
      new Api.folders.EditPeerFolders({
        folderPeers: [new Api.InputFolderPeer({ peer, folderId })]
      })
    );
    return true;
  } catch (error) {
    log(LogLevel.ERROR, `Failed to set folder ${folderId} for user ${userId}`, error);
    return false;
  }
}

async function archiveConversation(client: TelegramClient, userId: number): Promise<boolean> {
  log(LogLevel.INFO, `Archiving conversation with user ${userId}`);
  return setFolder(client, userId, 1);
}

async function muteConversation(client: TelegramClient, userId: number): Promise<boolean> {
  try {
    const peer = await client.getInputEntity(userId);
    await client.invoke(
      new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer }),
        settings: new Api.InputPeerNotifySettings({
          muteUntil: 2147483647,
          showPreviews: false,
          silent: true
        })
      })
    );
    log(LogLevel.INFO, `Muted conversation with user ${userId}`);
    return true;
  } catch (error) {
    log(LogLevel.ERROR, `Failed to mute conversation with ${userId}`, error);
    return false;
  }
}

async function hasChatHistory(
  client: TelegramClient,
  userId: number,
  excludeMessageId?: number
): Promise<boolean> {
  try {
    const messages = await client.getMessages(userId, {
      limit: 20
    });

    const hasOutgoingMessage = messages.some(m => m.out);
    if (hasOutgoingMessage) {
      return true;
    }

    const filtered = excludeMessageId
      ? messages.filter((m: any) => Number(m.id) !== Number(excludeMessageId))
      : messages;
    
    return filtered.length > 1;
  } catch (error) {
    console.error(`[PMCaptcha] Failed to check chat history with ${userId}:`, error);
    return false;
  }
}

async function pmcaptchaMessageListener(message: Api.Message) {
  if (!(await waitForConfigDb())) {
    console.error("[PMCaptcha] Config DB not ready, skipping message.");
    return;
  }

  try {
    const client = message.client as TelegramClient;

    if (!message.isPrivate) return;

    if (!dbHelpers.isPluginEnabled()) return;

    const userId = Number(message.senderId);

    if (message.out) {
      const recipientId = Number((message.peerId as any)?.userId);
      if (recipientId && recipientId > 0 && !dbHelpers.isWhitelisted(recipientId)) {
        const isBot = await isUserBot(client, recipientId);
        if (!isBot) {
          dbHelpers.addToWhitelist(recipientId);
          log(LogLevel.INFO, `Auto-whitelisted recipient ${recipientId}`);
        } else {
          log(LogLevel.INFO, `Skipped auto-whitelist for bot ${recipientId}`);
        }
      }
      return;
    }

    if (!userId || userId <= 0) return;

    if (dbHelpers.isWhitelisted(userId)) {
      return;
    }

    const hasHistory = await hasChatHistory(client, userId, Number(message.id));
    if (hasHistory) {
      const isBot = await isUserBot(client, userId);
      if (!isBot) {
        dbHelpers.addToWhitelist(userId);
        log(LogLevel.INFO, `Auto-whitelisted user ${userId} (has chat history)`);
      } else {
        log(LogLevel.INFO, `Skipped auto-whitelist for bot ${userId} (has chat history)`);
      }
      return;
    }

    log(LogLevel.INFO, `Archiving and muting conversation with stranger ${userId}`);
    await archiveConversation(client, userId);
    await muteConversation(client, userId);

  } catch (error) {
    console.error("[PMCaptcha] Message listener error:", error);
  }
}

const help_text = `🔒 <b>PMCaptcha v${PLUGIN_VERSION}</b>

<b>功能说明：</b>
自动将陌生人私聊归档并静音

<b>命令列表：</b>

<b>基础命令：</b>
• <code>${mainPrefix}pmc on</code> - 启用插件
• <code>${mainPrefix}pmc off</code> - 禁用插件
• <code>${mainPrefix}pmc help</code> - 显示帮助

<b>白名单管理：</b>
• <code>${mainPrefix}pmc add [用户ID/用户名]</code> - 添加到白名单（支持回复消息或直接输入ID/用户名，机器人不可添加）
• <code>${mainPrefix}pmc del [用户ID/用户名]</code> - 从白名单移除
• <code>${mainPrefix}pmc del all</code> - 删除所有白名单
• <code>${mainPrefix}pmc list</code> - 查看白名单（显示完整名字，点击可跳转）

<b>说明：</b>
• 已有聊天记录的用户会自动加入白名单（机器人除外）
• 你主动发起的对话会自动加入白名单（机器人除外）
• 白名单用户的消息不会被归档静音`;

const pmc = async (message: Api.Message) => {
  if (!(await waitForConfigDb())) {
    console.error("[PMCaptcha] Config DB not ready, skipping command.");
    return;
  }
  const client = message.client as TelegramClient;
  const args = message.message.slice(1).split(" ").slice(1);
  const action = args[0]?.toLowerCase();
  
  if (action === "on" || action === "off") {
    const isEnabling = action === "on";
    dbHelpers.setPluginEnabled(isEnabling);

    const statusText = isEnabling
      ? "✅ <b>PMCaptcha已启用</b>\n\n陌生人私聊将被归档并静音"
      : "🚫 <b>PMCaptcha已禁用</b>";

    try {
      const tempMsg = await client.sendMessage(message.peerId, {
        message: statusText,
        parseMode: "html",
      });

      await message.delete();

      setTimeout(async () => {
        try {
          await tempMsg.delete();
        } catch (e) {
        }
      }, 3000);

    } catch (error) {
      console.error(`[PMCaptcha] Failed to execute pmc command:`, error);
    }
    return;
  }
  
  return pmcaptcha(message);
};

/**
 * 辅助函数：根据用户名解析用户ID
 * 支持 @username 或 username 格式
 */
async function resolveUsernameToId(client: TelegramClient, username: string): Promise<number | null> {
  try {
    const cleanUsername = username.replace(/^@/, '');
    const entity = await client.getEntity(cleanUsername);
    if (entity && 'id' in entity) {
      return Number(entity.id);
    }
    return null;
  } catch (error) {
    log(LogLevel.ERROR, `Failed to resolve username ${username}`, error);
    return null;
  }
}

const pmcaptcha = async (message: Api.Message) => {
  if (!(await waitForConfigDb())) {
    console.error("[PMCaptcha] Config DB not ready, skipping command.");
    return;
  }
  const client = message.client as TelegramClient;
  const args = message.message.slice(1).split(" ").slice(1);
  const command = args[0] || "help";

  try {
    switch (command.toLowerCase()) {
      case "help":
      case "h":
      case "?":
      case "":
        await client.editMessage(message.peerId, {
          message: message.id,
          text: help_text,
          parseMode: "html",
        });
        break;

      case "add":
      case "whitelist":
      case "+":
        let targetUserId: number | null = null;

        if (message.replyTo && message.replyTo.replyToMsgId) {
          try {
            const repliedMessage = await client.getMessages(message.peerId, {
              ids: [message.replyTo.replyToMsgId],
            });
            if (repliedMessage[0] && repliedMessage[0].senderId) {
              targetUserId = Number(repliedMessage[0].senderId);
            }
          } catch (e) {
            console.error("[PMCaptcha] Error getting replied message:", e);
          }
        }

        if (!targetUserId && args[1]) {
          const arg = args[1];
          if (/^\d+$/.test(arg)) {
            targetUserId = parseInt(arg);
          } else {
            targetUserId = await resolveUsernameToId(client, arg);
          }
        }

        if (!targetUserId) {
          targetUserId = Number(message.senderId);
        }

        if (!targetUserId || targetUserId <= 0) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: "❌ 无法解析目标用户，请提供有效的用户ID、用户名或回复用户消息",
            parseMode: "html",
          });
          break;
        }

        const isBot = await isUserBot(client, targetUserId);
        if (isBot) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: `❌ 无法添加机器人到白名单：<a href="tg://user?id=${targetUserId}">${targetUserId}</a>`,
            parseMode: "html",
          });
          break;
        }

        dbHelpers.addToWhitelist(targetUserId);

        const displayName = await getUserDisplayName(client, targetUserId);
        await client.editMessage(message.peerId, {
          message: message.id,
          text: `✅ 用户 <a href="tg://user?id=${targetUserId}">${displayName} (${targetUserId})</a> 已添加到白名单`,
          parseMode: "html",
        });
        break;

      case "del":
      case "remove":
      case "rm":
      case "-":
        if (args[1] && args[1].toLowerCase() === "all") {
          dbHelpers.clearWhitelist();
          await client.editMessage(message.peerId, {
            message: message.id,
            text: "✅ 所有白名单已清空",
            parseMode: "html",
          });
          break;
        }

        if (!args[1]) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: "❌ 请提供要移除的用户ID或用户名，或使用 `del all` 清空白名单",
            parseMode: "html",
          });
          break;
        }

        let delUserId: number | null = null;
        const delArg = args[1];

        if (/^\d+$/.test(delArg)) {
          delUserId = parseInt(delArg);
        } else {
          delUserId = await resolveUsernameToId(client, delArg);
        }

        if (!delUserId || delUserId <= 0) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: "❌ 无法解析目标用户，请提供有效的用户ID或用户名",
            parseMode: "html",
          });
          break;
        }

        dbHelpers.removeFromWhitelist(delUserId);

        await client.editMessage(message.peerId, {
          message: message.id,
          text: `✅ 用户 <a href="tg://user?id=${delUserId}">${delUserId}</a> 已从白名单移除`,
          parseMode: "html",
        });
        break;

      case "list":
      case "ls":
        const whitelist = dbHelpers.getSetting(CONFIG_KEYS.WHITELIST, []) as number[];
        
        if (whitelist.length === 0) {
          await client.editMessage(message.peerId, {
            message: message.id,
            text: "📋 <b>白名单为空</b>",
            parseMode: "html",
          });
          break;
        }

        const listItems = await Promise.all(
          whitelist.map(async (id) => {
            const displayName = await getUserDisplayName(client, id);
            return `• <a href="tg://user?id=${id}">${displayName} (${id})</a>`;
          })
        );
        
        await client.editMessage(message.peerId, {
          message: message.id,
          text: `📋 <b>白名单用户 (${whitelist.length})</b>\n\n${listItems.join("\n")}`,
          parseMode: "html",
        });
        break;

      default:
        await client.editMessage(message.peerId, {
          message: message.id,
          text: `❌ 未知命令: <code>${command}</code>\n\n使用 <code>${mainPrefix}pmc help</code> 查看帮助`,
          parseMode: "html",
        });
        break;
    }
  } catch (error) {
    console.error("[PMCaptcha] Command error:", error);
    try {
      await client.editMessage(message.peerId, {
        message: message.id,
        text: `❌ 命令执行失败: ${error}`,
        parseMode: "html",
      });
    } catch (e) {
    }
  }
};

class PMCaptchaPlugin extends Plugin {
  name = "pmcaptcha";
  description = `🔒 PMCaptcha v${PLUGIN_VERSION} - 自动归档并静音陌生人私聊`;
  
  cmdHandlers = {
    pmc: pmc,
    pmcaptcha: pmcaptcha
  };
  
  listenMessageHandler = pmcaptchaMessageListener;
}

const plugin = new PMCaptchaPlugin();

export default plugin;

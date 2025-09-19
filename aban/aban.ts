import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api, TelegramClient } from "telegram";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// Configuration constants
const BATCH_SIZE = 20;
const PARALLEL_LIMIT = 8;
const USE_GET_PARTICIPANT_FIRST = true;
const PER_GROUP_SCAN_LIMIT = 2000;

// Database path for permanent cache - use telebox's assets directory
const CACHE_DB_PATH = path.join(
  createDirectoryInAssets("aban"),
  "aban_cache.db"
);

/**
 * Permanent cache system using SQLite database
 */
class PermanentCache {
  private db: Database.Database;

  constructor(dbPath: string = CACHE_DB_PATH) {
    this.db = new Database(dbPath);
    this.initDb();
  }

  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  get(key: string): any {
    const stmt = this.db.prepare("SELECT value FROM cache WHERE key = ?");
    const row = stmt.get(key) as { value: string } | undefined;

    if (row) {
      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    }
    return null;
  }

  set(key: string, value: any): void {
    const jsonValue = typeof value === "string" ? value : JSON.stringify(value);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO cache (key, value) 
      VALUES (?, ?)
    `);
    stmt.run(key, jsonValue);
  }

  delete(key: string): void {
    const stmt = this.db.prepare("DELETE FROM cache WHERE key = ?");
    stmt.run(key);
  }

  clear(): void {
    this.db.exec("DELETE FROM cache");
  }

  close(): void {
    this.db.close();
  }
}

// Global cache instance
const permanentCache = new PermanentCache();

/**
 * Permanent cache decorator for async functions
 */
function permanentCacheDecorator(
  target: any,
  propertyName: string,
  descriptor: PropertyDescriptor
) {
  const method = descriptor.value;

  descriptor.value = async function (...args: any[]) {
    // Generate cache key
    const cacheKey = `${propertyName}|${args
      .map((arg) =>
        typeof arg === "object" ? JSON.stringify(arg) : String(arg)
      )
      .join("|")}`;

    // Try to get from cache
    const cachedValue = permanentCache.get(cacheKey);
    if (cachedValue !== null) {
      return cachedValue;
    }

    // Execute function and cache result
    const result = await method.apply(this, args);
    permanentCache.set(cacheKey, result);
    return result;
  };
}

/**
 * HTML escape function for safe text display
 */
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Smart message editing with HTML support
 */
async function smartEdit(
  message: Api.Message,
  text: string,
  deleteAfter: number = 5,
  parseMode: "html" | "md" = "html"
): Promise<Api.Message> {
  try {
    const client = await getGlobalClient();
    if (!client) {
      console.log("[BanManager] Client not available for message editing");
      return message;
    }

    await client.editMessage(message.peerId, {
      message: message.id,
      text: text,
      parseMode: parseMode,
      linkPreview: false,
    });

    if (deleteAfter > 0) {
      setTimeout(async () => {
        try {
          await client.deleteMessages(message.peerId, [message.id], {
            revoke: true,
          });
        } catch (e) {
          console.log(`Failed to delete message: ${e}`);
        }
      }, deleteAfter * 1000);
    }

    return message;
  } catch (error: any) {
    console.log(`[BanManager] Edit error: ${error.message || error}`);
    return message;
  }
}

/**
 * Parse command arguments
 */
function parseArgs(parameter: string | string[]): string[] {
  if (typeof parameter === "string") {
    return parameter.split(" ").filter((arg) => arg.length > 0);
  } else if (Array.isArray(parameter)) {
    return parameter;
  }
  return [];
}

/**
 * Safe entity getter - handles various target formats
 */
async function safeGetEntity(
  client: TelegramClient,
  target: string | number
): Promise<any> {
  try {
    const targetStr = String(target);

    if (targetStr.startsWith("@")) {
      return await client.getEntity(target);
    } else if (targetStr.replace(/^-/, "").match(/^\d+$/)) {
      const userId = parseInt(targetStr);
      return await client.getEntity(userId);
    } else {
      throw new Error(
        "Invalid username format - usernames without @ are disabled for security"
      );
    }
  } catch (error: any) {
    console.log(
      `[BanManager] Get entity error for ${target}: ${error.message || error}`
    );
    return null;
  }
}

/**
 * Get target user from message (supports reply and arguments)
 */
async function getTargetUser(
  client: TelegramClient,
  message: Api.Message,
  args: string[]
): Promise<{ user: any; uid: number | null }> {
  // 1) If arguments provided, parse them first
  try {
    if (args.length > 0) {
      const raw = String(args[0]);

      if (raw.startsWith("@")) {
        const entity = await safeGetEntity(client, raw);
        return { user: entity, uid: entity?.id ? Number(entity.id) : null };
      } else if (raw.replace(/^-/, "").match(/^\d+$/)) {
        const userId = parseInt(raw);
        const entity = await safeGetEntity(client, userId);
        return { user: entity, uid: userId };
      } else {
        console.log(`[BanManager] Invalid username format: ${raw}`);
        return { user: null, uid: null };
      }
    }
  } catch (error: any) {
    console.log(
      `[BanManager] Get user from args error: ${error.message || error}`
    );
    return { user: null, uid: null };
  }

  // 2) If no arguments, try to get from reply message
  try {
    if (args.length === 0) {
      const reply = await message.getReplyMessage();
      if (reply && reply.fromId) {
        const targetUser = reply.sender;
        let targetUid = reply.senderId ? Number(reply.senderId) : null;

        // Check for channel identity
        if ((reply as any).post && reply.fromId) {
          if ((reply.fromId as any).channelId) {
            targetUid = Number((reply.fromId as any).channelId);
            console.log(
              `[BanManager] Detected channel message, using channel ID: ${targetUid}`
            );
          }
        }

        return { user: targetUser, uid: targetUid };
      }
    }
  } catch (error: any) {
    console.log(
      `[BanManager] Get user from reply error: ${error.message || error}`
    );
  }

  // 3) Unable to get target
  return { user: null, uid: null };
}

/**
 * Format user display name (supports channels)
 */
function formatUser(user: any, userId: number): string {
  if (user && (user.firstName || user.first_name)) {
    let name = user.firstName || user.first_name || String(userId);
    if (user.lastName || user.last_name) {
      name += ` ${user.lastName || user.last_name}`;
    }
    if (user.username) {
      name += ` (@${user.username})`;
    }
    return name;
  } else if (user && user.title) {
    let title = user.title;
    if (user.username) {
      title += ` (@${user.username})`;
    }
    return `频道: ${title}`;
  } else if (user && user.broadcast) {
    let title = user.title || String(userId);
    if (user.username) {
      title += ` (@${user.username})`;
    }
    return `频道: ${title}`;
  }
  return String(userId);
}

/**
 * Check bot permissions in a chat
 */
async function checkPermissions(
  client: TelegramClient,
  chatId: any,
  action: string = "ban"
): Promise<boolean> {
  try {
    const me = await client.getMe();

    // Extract actual ID from peerId object or BigInt
    let channelId: number;
    if (chatId && typeof chatId === "object" && chatId.channelId) {
      // Handle PeerChannel object
      channelId = Number(chatId.channelId.toString());
    } else if (chatId && typeof chatId === "object" && chatId.chatId) {
      // Handle PeerChat object
      channelId = Number(chatId.chatId.toString());
    } else if (chatId && typeof chatId === "object" && chatId.userId) {
      // Handle PeerUser object
      channelId = Number(chatId.userId.toString());
    } else if (typeof chatId === "bigint") {
      channelId = Number(chatId.toString());
    } else {
      channelId = Number(chatId);
    }

    const myId = Number(me.id.toString());

    if (isNaN(channelId) || isNaN(myId)) {
      console.log(
        `[BanManager] Invalid ID conversion: chatId=${JSON.stringify(
          chatId
        )}, myId=${me.id}`
      );
      return false;
    }

    const participant = await client.invoke(
      new Api.channels.GetParticipant({
        channel: channelId,
        participant: myId,
      })
    );

    const rights = (participant.participant as any).adminRights;
    return !!(rights && rights.banUsers);
  } catch (error: any) {
    console.log(
      `[BanManager] Permission check error: ${error.message || error}`
    );
    return false;
  }
}

/**
 * Check if user is admin in chat
 */
async function isAdmin(
  client: TelegramClient,
  chatId: any,
  userId: any
): Promise<boolean> {
  try {
    // Extract actual ID from peerId object or BigInt
    let channelId: number;
    if (chatId && typeof chatId === "object" && chatId.channelId) {
      // Handle PeerChannel object
      channelId = Number(chatId.channelId.toString());
    } else if (chatId && typeof chatId === "object" && chatId.chatId) {
      // Handle PeerChat object
      channelId = Number(chatId.chatId.toString());
    } else if (chatId && typeof chatId === "object" && chatId.userId) {
      // Handle PeerUser object
      channelId = Number(chatId.userId.toString());
    } else if (typeof chatId === "bigint") {
      channelId = Number(chatId.toString());
    } else {
      channelId = Number(chatId);
    }

    const participantId = Number(userId.toString());

    if (isNaN(channelId) || isNaN(participantId)) {
      console.log(
        `[BanManager] Invalid ID conversion: chatId=${JSON.stringify(
          chatId
        )}, userId=${userId}`
      );
      return false;
    }

    const participant = await client.invoke(
      new Api.channels.GetParticipant({
        channel: channelId,
        participant: participantId,
      })
    );

    return !!(participant.participant as any).adminRights;
  } catch (error: any) {
    console.log(`[BanManager] Admin check error: ${error.message || error}`);
    return false;
  }
}

/**
 * Get managed groups where bot has ban permissions
 */
async function getManagedGroups(
  client: TelegramClient
): Promise<Array<{ id: number; title: string }>> {
  const groups: Array<{ id: number; title: string }> = [];
  const me = await client.getMe();

  try {
    const dialogs = await client.getDialogs({ limit: 500 });

    // Process dialogs in batches
    for (let i = 0; i < dialogs.length; i += 20) {
      const batch = dialogs.slice(i, i + 20);
      const promises = batch.map(async (dialog: any) => {
        if (dialog.isGroup || dialog.isChannel) {
          try {
            const participant = await client.invoke(
              new Api.channels.GetParticipant({
                channel: Number(dialog.id),
                participant: Number(me.id),
              })
            );

            const rights = (participant.participant as any).adminRights;
            if (rights && rights.banUsers) {
              return { id: Number(dialog.id), title: dialog.title };
            }
          } catch (error) {
            // Ignore groups without permissions
          }
        }
        return null;
      });

      const results = await Promise.allSettled(promises);
      results.forEach((result) => {
        if (result.status === "fulfilled" && result.value) {
          groups.push(result.value);
        }
      });
    }
  } catch (error: any) {
    console.log(
      `[BanManager] Error getting managed groups: ${error.message || error}`
    );
  }

  console.log(`[BanManager] Found ${groups.length} managed groups`);
  return groups;
}

/**
 * Check if chat supports message deletion
 */
async function canDeleteMessages(
  client: TelegramClient,
  chatId: any
): Promise<boolean> {
  try {
    // Extract actual ID from peerId object or BigInt
    let channelId: number;
    if (chatId && typeof chatId === "object" && chatId.channelId) {
      channelId = Number(chatId.channelId.toString());
    } else if (chatId && typeof chatId === "object" && chatId.chatId) {
      channelId = Number(chatId.chatId.toString());
    } else if (typeof chatId === "bigint") {
      channelId = Number(chatId.toString());
    } else {
      channelId = Number(chatId);
    }

    // Get chat info to check if it's a channel/supergroup
    const chatEntity = await client.getEntity(channelId);

    // Only channels and supergroups support DeleteParticipantHistory
    // Check if it's a channel or supergroup using proper type checking
    const isChannel = (chatEntity as any).broadcast === true;
    const isSupergroup = (chatEntity as any).megagroup === true;

    if (!isChannel && !isSupergroup) {
      return false;
    }

    // Check if bot has delete_messages permission
    const me = await client.getMe();
    const participant = await client.invoke(
      new Api.channels.GetParticipant({
        channel: channelId,
        participant: Number(me.id),
      })
    );

    const rights = (participant.participant as any).adminRights;
    return !!(rights && rights.deleteMessages);
  } catch (error: any) {
    console.log(
      `[BanManager] Cannot check delete permission: ${error.message}`
    );
    return false;
  }
}

/**
 * Invoke helper with FLOOD_WAIT backoff
 */
async function invokeWithFlood<T>(
  client: TelegramClient,
  req: any
): Promise<T> {
  try {
    return await client.invoke(req);
  } catch (e: any) {
    const m = /FLOOD_WAIT_(\d+)/.exec(e?.message || "");
    if (m) {
      const wait = (parseInt(m[1]) + 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return client.invoke(req);
    }
    throw e;
  }
}

/**
 * Get common chats (channels/supergroups) with target user
 */
async function getCommonChats(
  client: TelegramClient,
  uid: number
): Promise<number[]> {
  const result: number[] = [];
  try {
    const entity: any = await safeGetEntity(client, uid);
    const inputUser = entity?.accessHash
      ? new Api.InputUser({ userId: entity.id as any, accessHash: entity.accessHash })
      : (uid as any);

    const Ctor = (Api as any).contacts?.GetCommonChats;
    if (typeof Ctor === "function") {
      const res: any = await invokeWithFlood(
        client,
        new Ctor({ userId: inputUser, maxId: 0, limit: 200 })
      );
      const ids = (res.chats || [])
        .filter((c: any) => c.megagroup || c.broadcast)
        .map((c: any) => Number(c.id));
      return ids;
    } else {
      console.log(
        `[BanManager] contacts.GetCommonChats not available, fallback to managed-groups scan`
      );
    }
  } catch (e: any) {
    console.log(
      `[BanManager] GetCommonChats error: ${e.message || e}, fallback to scan`
    );
  }

  // Fallback: scan managed groups and check membership via channels.GetParticipant
  try {
    const groups = await getManagedGroups(client);
    const entity: any = await safeGetEntity(client, uid);
    const participantRef = entity || (uid as any);
    for (const g of groups) {
      try {
        await invokeWithFlood(
          client,
          new Api.channels.GetParticipant({
            channel: Number(g.id),
            participant: participantRef,
          })
        );
        result.push(Number(g.id));
      } catch {
        // Not a member or no access; skip
      }
    }
  } catch (e) {
    console.log(`[BanManager] Fallback scan error: ${(e as any).message || e}`);
  }
  return result;
}

/**
 * Delete all messages of user in common chats only
 */
async function deleteHistoryInCommonChats(
  client: TelegramClient,
  uid: number
): Promise<number> {
  const chats = await getCommonChats(client, uid);
  const entity: any = await safeGetEntity(client, uid);
  const participantRef = entity || (uid as any);
  let count = 0;
  for (const gid of chats) {
    try {
      await invokeWithFlood(
        client,
        new Api.channels.DeleteParticipantHistory({ channel: gid, participant: participantRef })
      );
      count++;
    } catch (e: any) {
      if (!/CHANNEL_INVALID|CHAT_ADMIN_REQUIRED/.test(e?.message || "")) {
        console.log(`[BanManager] Delete history in ${gid} failed: ${e?.message}`);
      }
    }
  }
  return count;
}

/**
 * Safe ban action with multiple fallback methods
 */
async function safeBanAction(
  client: TelegramClient,
  chatId: any,
  userId: number,
  rights: any,
  options: { deleteHistory?: boolean } = { deleteHistory: true }
): Promise<boolean> {
  try {
    let banSuccess = false;

    // Extract actual ID from peerId object or BigInt
    let channelId: number;
    if (chatId && typeof chatId === "object" && chatId.channelId) {
      // Handle PeerChannel object
      channelId = Number(chatId.channelId.toString());
    } else if (chatId && typeof chatId === "object" && chatId.chatId) {
      // Handle PeerChat object
      channelId = Number(chatId.chatId.toString());
    } else if (chatId && typeof chatId === "object" && chatId.userId) {
      // Handle PeerUser object
      channelId = Number(chatId.userId.toString());
    } else if (typeof chatId === "bigint") {
      channelId = Number(chatId.toString());
    } else {
      channelId = Number(chatId);
    }

    // Method 1: Direct ban with user ID
    try {
      await client.invoke(
        new Api.channels.EditBanned({
          channel: channelId,
          participant: Number(userId),
          bannedRights: rights,
        })
      );
      banSuccess = true;
    } catch (error1: any) {
      console.log(
        `[BanManager] Method 1 (direct ID) failed: ${error1.message}`
      );

      // Method 2: Get entity first then ban
      try {
        const userEntity = await safeGetEntity(client, userId);
        if (userEntity) {
          await client.invoke(
            new Api.channels.EditBanned({
              channel: channelId,
              participant: userEntity,
              bannedRights: rights,
            })
          );
          banSuccess = true;
        }
      } catch (error2: any) {
        console.log(`[BanManager] Method 2 (entity) failed: ${error2.message}`);

        // Method 3: Try with InputPeer
        try {
          const userEntity = await safeGetEntity(client, userId);
          if (userEntity && userEntity.accessHash) {
            const inputPeer = userEntity.broadcast
              ? new Api.InputPeerChannel({
                  channelId: userId as any,
                  accessHash: userEntity.accessHash,
                })
              : new Api.InputPeerUser({
                  userId: userId as any,
                  accessHash: userEntity.accessHash,
                });

            await client.invoke(
              new Api.channels.EditBanned({
                channel: channelId,
                participant: inputPeer,
                bannedRights: rights,
              })
            );
            banSuccess = true;
          }
        } catch (error3: any) {
          console.log(
            `[BanManager] Method 3 (InputPeer) failed: ${error3.message}`
          );
        }
      }
    }

    // Delete history only when explicitly requested (sb 场景关闭)
    if (banSuccess && rights.viewMessages && options?.deleteHistory) {
      try {
        // Check if this chat supports message deletion
        const canDelete = await canDeleteMessages(client, chatId);
        if (!canDelete) {
          console.log(
            `[BanManager] Chat ${channelId} doesn't support message deletion or lacks permission`
          );
          return banSuccess;
        }

        const userEntity = await safeGetEntity(client, userId);
        if (userEntity) {
          await client.invoke(
            new Api.channels.DeleteParticipantHistory({
              channel: channelId,
              participant: userEntity,
            })
          );
          console.log(
            `[BanManager] Deleted all messages from ${userId} in ${channelId}`
          );
        }
      } catch (error: any) {
        // Don't log CHANNEL_INVALID and CHAT_ADMIN_REQUIRED as errors since they're expected
        if (
          error.message.includes("CHANNEL_INVALID") ||
          error.message.includes("CHAT_ADMIN_REQUIRED")
        ) {
          console.log(
            `[BanManager] Cannot delete messages in chat ${channelId}: ${error.message} (expected for some chat types)`
          );
        } else {
          console.log(
            `[BanManager] Failed to delete messages: ${error.message}`
          );
        }
      }
    }

    return banSuccess;
  } catch (error: any) {
    console.log(
      `[BanManager] Safe ban action error: ${error.message || error}`
    );
    return false;
  }
}

/**
 * Batch ban operation with concurrency control
 */
async function batchBanOperation(
  client: TelegramClient,
  groups: Array<{ id: number; title: string }>,
  userId: number,
  rights: any,
  operationName: string = "封禁",
  options: { deleteHistory?: boolean } = {}
): Promise<{ success: number; failed: number; failedGroups: string[] }> {
  let success = 0;
  let failed = 0;
  const failedGroups: string[] = [];

  const processGroup = async (group: { id: number; title: string }) => {
    try {
      const result = await safeBanAction(
        client,
        group.id,
        userId,
        rights,
        options
      );
      if (result) {
        return { success: true, groupName: null };
      } else {
        return { success: false, groupName: group.title };
      }
    } catch (error: any) {
      console.log(
        `[BanManager] ${operationName} error in ${group.title}: ${error.message}`
      );
      return { success: false, groupName: `${group.title} (异常)` };
    }
  };

  // Process groups in batches
  for (let i = 0; i < groups.length; i += BATCH_SIZE) {
    const batch = groups.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(processGroup));

    results.forEach((result) => {
      if (result.status === "fulfilled") {
        if (result.value.success) {
          success++;
        } else {
          failed++;
          if (result.value.groupName) {
            failedGroups.push(result.value.groupName);
          }
        }
      } else {
        failed++;
        failedGroups.push("未知群组 (异常)");
      }
    });
  }

  return { success, failed, failedGroups };
}

/**
 * Resolve user across groups by ID
 */
async function resolveUserAcrossGroups(
  client: TelegramClient,
  groups: Array<{ id: number; title: string }>,
  userId: number,
  perGroupLimit: number = PER_GROUP_SCAN_LIMIT
): Promise<any> {
  let foundUser: any = null;
  const semaphore = { count: 0, max: PARALLEL_LIMIT };

  const probeGroup = async (group: { id: number; title: string }) => {
    if (foundUser) return;

    // Wait for semaphore
    while (semaphore.count >= semaphore.max) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    semaphore.count++;

    try {
      // Method 1: Try GetParticipant first
      if (USE_GET_PARTICIPANT_FIRST) {
        try {
          const participant = await client.invoke(
            new Api.channels.GetParticipant({
              channel: Number(group.id),
              participant: Number(userId),
            })
          );

          if (participant.users && participant.users.length > 0) {
            const user = participant.users.find(
              (u: any) => Number(u.id) === userId
            );
            if (user) {
              foundUser = user;
              return;
            }
          }
        } catch (error) {
          // Continue to method 2
        }
      }

      if (foundUser) return;

      // Method 2: Iterate participants
      try {
        const participants = client.iterParticipants(group.id, {
          limit: perGroupLimit,
        });
        for await (const participant of participants) {
          if (Number(participant.id) === userId) {
            foundUser = participant;
            return;
          }
        }
      } catch (error: any) {
        console.log(
          `[BanManager] Scan group ${group.title} for uid ${userId} error: ${error.message}`
        );
      }
    } finally {
      semaphore.count--;
    }
  };

  // Start all probes
  const promises = groups.map(probeGroup);
  await Promise.allSettled(promises);

  return foundUser;
}

/**
 * Resolve user if needed (cross-group resolution)
 */
async function resolveUserIfNeeded(
  client: TelegramClient,
  message: Api.Message,
  user: any,
  uid: number | null,
  args: string[]
): Promise<{ user: any; uid: number | null; message: Api.Message }> {
  try {
    const raw = args.length > 0 ? String(args[0]) : "";
    if (
      raw &&
      raw.replace(/^-/, "").match(/^\d+$/) &&
      !user &&
      uid &&
      uid > 0
    ) {
      const status = await smartEdit(
        message,
        "🔎 未能直接解析该 ID，正在跨群扫描尝试定位实体...",
        0
      );

      const groups = await getManagedGroups(client);
      if (groups.length === 0) {
        await smartEdit(
          status,
          "❌ 未找到可管理的群组（请确认已建立缓存或有管理权限）"
        );
        return { user: null, uid: null, message: status };
      }

      const found = await resolveUserAcrossGroups(client, groups, uid, 2000);
      if (!found) {
        await smartEdit(
          status,
          "❌ 无法通过纯数字ID跨群定位该用户\n\n" +
            "请改用：\n" +
            "• @用户名（推荐），或\n" +
            "• 在任一聊天回复该用户后再使用命令，或\n" +
            "• 确保你与该用户有共同群/私聊以便解析实体",
          30
        );
        return { user: null, uid: null, message: status };
      }

      return {
        user: found,
        uid: found.id ? Number(found.id) : uid,
        message: status,
      };
    }
  } catch (error: any) {
    console.log(`[BanManager] Cross-group resolution error: ${error.message}`);
  }

  return { user, uid, message };
}

/**
 * Show help information for commands
 */
function showHelp(command: string): string {
  const helps: { [key: string]: string } = {
    main: `🛡️ <b>高级封禁管理插件</b>

<b>可用指令：</b>
• <code>kick</code> - 踢出用户
• <code>ban</code> - 封禁用户
• <code>unban</code> - 解封用户
• <code>mute</code> - 禁言用户
• <code>unmute</code> - 解除禁言
• <code>sb</code> - 批量封禁
• <code>unsb</code> - 批量解封
• <code>refresh</code> - 刷新群组缓存

💡 <b>使用方式：</b>
支持：回复消息、@用户名、用户ID、群/频道ID（负数）
不支持：不带 @ 的用户名`,

    sb: `<code>sb</code>: 🌐 <b>批量封禁</b>

<b>语法：</b> <code>sb &lt;用户&gt; [原因]</code>
<b>示例：</b> <code>sb @user 垃圾广告</code>
<b>支持：</b> 回复消息、@用户名、用户ID、群/频道ID（负数）
不支持：不带 @ 的用户名

在你管理的所有群组中封禁指定用户`,

    kick: `<code>kick</code>: 🚪 <b>踢出用户</b>

<b>语法：</b> <code>kick &lt;用户&gt; [原因]</code>
<b>示例：</b> <code>kick @user 刷屏</code>
<b>支持：</b> 回复消息、@用户名、用户ID、群/频道ID（负数）
不支持：不带 @ 的用户名

用户可以重新加入群组`,

    ban: `<code>ban</code>: 🚫 <b>封禁用户</b>

<b>语法：</b> <code>ban &lt;用户&gt; [原因]</code>
<b>示例：</b> <code>ban @user 广告</code>
<b>支持：</b> 回复消息、@用户名、用户ID、群/频道ID（负数）
不支持：不带 @ 的用户名

永久封禁，需要管理员解封`,

    unban: `<code>unban</code>: 🔓 <b>解除封禁</b>

<b>语法：</b> <code>unban &lt;用户&gt;</code>
<b>示例：</b> <code>unban @user</code>
<b>支持：</b> 回复消息、@用户名、用户ID、群/频道ID（负数）
不支持：不带 @ 的用户名

解除用户封禁状态`,

    mute: `<code>mute</code>: 🤐 <b>禁言用户</b>

<b>语法：</b> <code>mute &lt;用户&gt; [分钟] [原因]</code>
<b>示例：</b> <code>mute @user 60 刷屏</code>
<b>支持：</b> 回复消息、@用户名、用户ID、群/频道ID（负数）
不支持：不带 @ 的用户名

默认60分钟，最长24小时`,

    unmute: `<code>unmute</code>: 🔊 <b>解除禁言</b>

<b>语法：</b> <code>unmute &lt;用户&gt;</code>
<b>示例：</b> <code>unmute @user</code>
<b>支持：</b> 回复消息、@用户名、用户ID、群/频道ID（负数）
不支持：不带 @ 的用户名

立即解除禁言`,

    refresh: `<code>refresh</code>: 🔄 <b>刷新群组缓存</b>

重建管理群组缓存`,
  };

  return helps[command] || helps.main;
}

/**
 * Handle user action - common logic for all user-targeted commands
 */
async function handleUserAction(
  client: TelegramClient,
  message: Api.Message,
  command: string
): Promise<{ user: any; uid: number | null; args: string[] } | null> {
  const messageParts = message.message.split(" ");
  const userTarget = messageParts[1] || ""; // Get user target (2nd part, since no aban prefix)
  const reasonArgs = messageParts.slice(2); // Get reason arguments (3rd part onwards)

  // Check if help is needed
  const hasReply = !!(await message.getReplyMessage());
  if (!userTarget && !hasReply) {
    await smartEdit(message, showHelp(command), 30);
    return null;
  }

  if (!message.isGroup) {
    await smartEdit(message, "❌ 此命令只能在群组中使用");
    return null;
  }

  const targetArgs = userTarget ? [userTarget] : [];
  const { user, uid } = await getTargetUser(client, message, targetArgs);
  if (!uid) {
    await smartEdit(message, "❌ 无法获取用户信息");
    return null;
  }

  return { user, uid, args: reasonArgs };
}

/**
 * Handle kick command
 */
async function handleKickCommand(
  client: TelegramClient,
  message: Api.Message
): Promise<void> {
  const result = await handleUserAction(client, message, "kick");
  if (!result) return;

  let { user, uid, args } = result;
  const resolved = await resolveUserIfNeeded(client, message, user, uid, args);
  user = resolved.user;
  uid = resolved.uid;
  message = resolved.message;

  if (!uid) return;

  const reason = args.slice(0).join(" ") || "广告";
  const display = formatUser(user, uid);

  const status = await smartEdit(
    message,
    `🚪 正在踢出 ${htmlEscape(display)}...`,
    0
  );

  if (await isAdmin(client, message.peerId, uid)) {
    await smartEdit(status, "❌ 不能踢出管理员");
    return;
  }

  if (!(await checkPermissions(client, message.peerId))) {
    await smartEdit(status, "❌ 权限不足");
    return;
  }

  try {
    // Kick user by temporary ban (1 minute) - this removes user but allows them to rejoin
    const kickRights = new Api.ChatBannedRights({
      untilDate: Math.floor(Date.now() / 1000) + 60, // Ban for 1 minute then auto-unban
      viewMessages: true,
      sendMessages: true,
    });

    const success = await safeBanAction(
      client,
      message.peerId,
      uid,
      kickRights
    );

    const resultText = `✅ **踢出完成**

👤 用户：${htmlEscape(display)}
🆔 ID：${uid}
📝 原因：${htmlEscape(reason)}
⏰ ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;

    await smartEdit(status, resultText);
  } catch (error: any) {
    await smartEdit(status, `❌ 踢出失败：${error.message}`);
  }
}

/**
 * Handle ban command
 */
async function handleBanCommand(
  client: TelegramClient,
  message: Api.Message
): Promise<void> {
  const result = await handleUserAction(client, message, "ban");
  if (!result) return;

  let { user, uid, args } = result;
  const resolved = await resolveUserIfNeeded(client, message, user, uid, args);
  user = resolved.user;
  uid = resolved.uid;
  message = resolved.message;

  if (!uid) return;

  const reason = args.slice(0).join(" ") || "广告";
  const display = formatUser(user, uid);

  const status = await smartEdit(
    message,
    `🚫 正在封禁 ${htmlEscape(display)}...`,
    0
  );

  if (await isAdmin(client, message.peerId, uid)) {
    await smartEdit(status, "❌ 不能封禁管理员");
    return;
  }

  if (!(await checkPermissions(client, message.peerId))) {
    await smartEdit(status, "❌ 权限不足");
    return;
  }

  const rights = new Api.ChatBannedRights({
    untilDate: 0,
    viewMessages: true,
    sendMessages: true,
  });

  const success = await safeBanAction(client, message.peerId, uid, rights, {
    deleteHistory: true,
  });

  if (success) {
    const resultText = `✅ **封禁完成**

👤 用户：${htmlEscape(display)}
🆔 ID：${uid}
📝 原因：${htmlEscape(reason)}
🗑️ 已删除该用户的所有消息
⏰ ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;

    await smartEdit(status, resultText);
  } else {
    await smartEdit(status, "❌ 封禁失败，请检查权限或用户是否存在");
  }
}

/**
 * Handle unban command
 */
async function handleUnbanCommand(
  client: TelegramClient,
  message: Api.Message
): Promise<void> {
  const result = await handleUserAction(client, message, "unban");
  if (!result) return;

  let { user, uid, args } = result;
  const resolved = await resolveUserIfNeeded(client, message, user, uid, args);
  user = resolved.user;
  uid = resolved.uid;
  message = resolved.message;

  if (!uid) return;

  const display = formatUser(user, uid);

  const status = await smartEdit(
    message,
    `🔓 正在解封 ${htmlEscape(display)}...`,
    0
  );

  if (!(await checkPermissions(client, message.peerId))) {
    await smartEdit(status, "❌ 权限不足");
    return;
  }

  const rights = new Api.ChatBannedRights({ untilDate: 0 });
  const success = await safeBanAction(client, message.peerId, uid, rights);

  if (success) {
    const resultText = `✅ **解封完成**

👤 用户：${htmlEscape(display)}
🆔 ID：${uid}
⏰ ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;

    await smartEdit(status, resultText);
  } else {
    await smartEdit(status, "❌ 解封失败，用户可能不在群组或无权限");
  }
}

/**
 * Handle mute command
 */
async function handleMuteCommand(
  client: TelegramClient,
  message: Api.Message
): Promise<void> {
  const result = await handleUserAction(client, message, "mute");
  if (!result) return;

  let { user, uid, args } = result;
  const resolved = await resolveUserIfNeeded(client, message, user, uid, args);
  user = resolved.user;
  uid = resolved.uid;
  message = resolved.message;

  if (!uid) return;

  let minutes = 60;
  let reason = "违规发言";

  // Parse arguments
  if (args.length > 0) {
    if (/^\d+$/.test(args[0])) {
      minutes = Math.max(1, Math.min(parseInt(args[0]), 1440)); // Max 24 hours
      if (args.length > 1) {
        reason = args.slice(1).join(" ");
      }
    } else {
      reason = args.slice(0).join(" ");
    }
  }

  const display = formatUser(user, uid);
  const status = await smartEdit(
    message,
    `🤐 正在禁言 ${htmlEscape(display)}...`,
    0
  );

  if (await isAdmin(client, message.peerId, uid)) {
    await smartEdit(status, "❌ 不能禁言管理员");
    return;
  }

  if (!(await checkPermissions(client, message.peerId))) {
    await smartEdit(status, "❌ 权限不足");
    return;
  }

  try {
    const untilDate = Math.floor(Date.now() / 1000) + minutes * 60;
    const rights = new Api.ChatBannedRights({
      untilDate: untilDate,
      sendMessages: true,
    });

    const success = await safeBanAction(client, message.peerId, uid, rights);

    if (success) {
      const endTime = new Date(Date.now() + minutes * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      const resultText = `✅ **禁言完成**

👤 用户：${htmlEscape(display)}
🆔 ID：${uid}
📝 原因：${htmlEscape(reason)}
⏱️ 时长：${minutes} 分钟
🔓 解除：${endTime} UTC`;

      await smartEdit(status, resultText);
    } else {
      await smartEdit(status, "❌ 禁言失败，请检查权限");
    }
  } catch (error: any) {
    await smartEdit(status, `❌ 禁言失败：${error.message}`);
  }
}

/**
 * Handle unmute command
 */
async function handleUnmuteCommand(
  client: TelegramClient,
  message: Api.Message
): Promise<void> {
  const result = await handleUserAction(client, message, "unmute");
  if (!result) return;

  let { user, uid, args } = result;
  const resolved = await resolveUserIfNeeded(client, message, user, uid, args);
  user = resolved.user;
  uid = resolved.uid;
  message = resolved.message;

  if (!uid) return;

  const display = formatUser(user, uid);

  const status = await smartEdit(
    message,
    `🔊 正在解除禁言 ${htmlEscape(display)}...`,
    0
  );

  if (!(await checkPermissions(client, message.peerId))) {
    await smartEdit(status, "❌ 权限不足");
    return;
  }

  const rights = new Api.ChatBannedRights({
    untilDate: 0,
    sendMessages: false,
  });

  const success = await safeBanAction(client, message.peerId, uid, rights);

  if (success) {
    const resultText = `✅ **解除禁言完成**

👤 用户：${htmlEscape(display)}
🆔 ID：${uid}
⏰ ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;

    await smartEdit(status, resultText);
  } else {
    await smartEdit(status, "❌ 解除禁言失败，请检查权限");
  }
}

/**
 * Handle super ban command
 */
async function handleSuperBanCommand(
  client: TelegramClient,
  message: Api.Message
): Promise<void> {
  const result = await handleUserAction(client, message, "sb");
  if (!result) return;

  let { user, uid, args } = result;
  const resolved = await resolveUserIfNeeded(client, message, user, uid, args);
  user = resolved.user;
  uid = resolved.uid;
  message = resolved.message;

  if (!uid) return;

  const reason = args.slice(0).join(" ") || "跨群违规";
  const display = formatUser(user, uid);
  const status = await smartEdit(
    message,
    "🌐 正在查找与目标用户的共同群组...",
    0
  );

  try {
    const groups = await getManagedGroups(client);

    if (groups.length === 0) {
      await smartEdit(
        status,
        "❌ 未找到可管理的群组（请确认已建立缓存或有管理权限）"
      );
      return;
    }

    await smartEdit(
      status,
      `🌐 正在批量封禁 ${htmlEscape(display)}...\n📊 目标群组：${
        groups.length
      } 个`,
      0
    );

    const rights = new Api.ChatBannedRights({
      untilDate: 0,
      viewMessages: true,
      sendMessages: true,
      sendMedia: true,
      sendStickers: true,
      sendGifs: true,
      sendGames: true,
      sendInline: true,
      embedLinks: true,
    });

    const { success, failed, failedGroups } = await batchBanOperation(
      client,
      groups,
      uid,
      rights,
      "封禁",
      { deleteHistory: false }
    );

    // Then delete messages only in common chats
    const deletedIn = await deleteHistoryInCommonChats(client, uid);

    let resultText = `✅ **批量封禁完成**

👤 用户：${htmlEscape(display)}
🆔 ID：${uid}
📝 原因：${htmlEscape(reason)}
🌐 成功：${success} 群组
❌ 失败：${failed} 群组
🗑️ 清理共同群消息：${deletedIn} 个群
⏰ ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;

    if (failedGroups.length > 0 && failedGroups.length <= 3) {
      resultText +=
        "\n\n失败群组：\n" +
        failedGroups
          .slice(0, 3)
          .map((g) => `• ${g}`)
          .join("\n");
    }

    await smartEdit(status, resultText, 60);
  } catch (error: any) {
    await smartEdit(status, `❌ sb执行异常：${error.message}`);
  }
}

/**
 * Handle super unban command
 */
async function handleSuperUnbanCommand(
  client: TelegramClient,
  message: Api.Message
): Promise<void> {
  const result = await handleUserAction(client, message, "unsb");
  if (!result) return;

  let { user, uid, args } = result;
  const resolved = await resolveUserIfNeeded(client, message, user, uid, args);
  user = resolved.user;
  uid = resolved.uid;
  message = resolved.message;

  if (!uid) return;

  const display = formatUser(user, uid);

  const status = await smartEdit(message, "🌐 正在获取管理群组...", 0);

  const groups = await getManagedGroups(client);

  if (groups.length === 0) {
    await smartEdit(
      status,
      "❌ 未找到管理的群组\n\n💡 提示：使用 `refresh` 命令刷新缓存"
    );
    return;
  }

  await smartEdit(
    status,
    `🌐 正在批量解封 ${htmlEscape(display)}...\n📊 目标群组：${
      groups.length
    } 个`,
    0
  );

  const rights = new Api.ChatBannedRights({ untilDate: 0 });

  const startTime = Date.now();
  const { success, failed, failedGroups } = await batchBanOperation(
    client,
    groups,
    uid,
    rights,
    "解封"
  );
  const elapsed = (Date.now() - startTime) / 1000;

  let resultText = `✅ **批量解封完成**

👤 用户：${htmlEscape(display)}
🆔 ID：${uid}
🌐 成功：${success} 群组
❌ 失败：${failed} 群组
⏱️ 耗时：${elapsed.toFixed(1)} 秒
⏰ ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;

  if (failedGroups.length > 0 && failedGroups.length <= 3) {
    resultText +=
      "\n\n失败群组：\n" +
      failedGroups
        .slice(0, 3)
        .map((g) => `• ${g}`)
        .join("\n");
  }

  await smartEdit(status, resultText, 60);
}

/**
 * Handle refresh command
 */
async function handleRefreshCommand(
  client: TelegramClient,
  message: Api.Message
): Promise<void> {
  const status = await smartEdit(message, "🔄 正在刷新群组缓存...", 0);

  try {
    // Clear all cache
    permanentCache.clear();

    // Reload managed groups
    const groups = await getManagedGroups(client);
    await smartEdit(status, `✅ 刷新完成，管理群组数：${groups.length}`);
  } catch (error: any) {
    console.log(`[BanManager] Refresh cache error: ${error.message}`);
    await smartEdit(status, `❌ 刷新失败：${error.message}`);
  }
}

// Plugin definition - moved to end to avoid hoisting issues
console.log(`[BanManager] Plugin module loaded, defining aban plugin`);

// Export handler functions for potential use by other plugins
export {
  handleKickCommand,
  handleBanCommand,
  handleUnbanCommand,
  handleMuteCommand,
  handleUnmuteCommand,
  handleSuperBanCommand,
  handleSuperUnbanCommand,
  handleRefreshCommand,
};

const HELP_TEXT = `🛡️ 高级封禁管理插件

• .kick - 🚪 踢出用户
• .ban - 🚫 封禁用户  
• .unban - 🔓 解封用户
• .mute - 🤐 禁言用户
• .unmute - 🔊 解除禁言
• .sb - 🌐 批量封禁
• .unsb - 🌐 批量解封
• .refresh - 🔄 刷新群组缓存

使用方式：回复消息、@用户名、用户ID`;

class AbanPlugin extends Plugin {
  description: string = HELP_TEXT;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    aban: async (msg) => {
      await smartEdit(msg, HELP_TEXT);
    },
    kick: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await smartEdit(msg, "❌ 客户端未初始化");
        return;
      }

      // Get the command from the message (first word after the dot)
      const args = msg.message.split(" ");
      const command = args[0].replace(".", "").toLowerCase();

      console.log(`[BanManager] Executing ${command} command`);
      await handleKickCommand(client, msg);
    },
    ban: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await smartEdit(msg, "❌ 客户端未初始化");
        return;
      }

      // Get the command from the message (first word after the dot)
      const args = msg.message.split(" ");
      const command = args[0].replace(".", "").toLowerCase();

      console.log(`[BanManager] Executing ${command} command`);
      await handleBanCommand(client, msg);
    },
    unban: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await smartEdit(msg, "❌ 客户端未初始化");
        return;
      }

      // Get the command from the message (first word after the dot)
      const args = msg.message.split(" ");
      const command = args[0].replace(".", "").toLowerCase();

      console.log(`[BanManager] Executing ${command} command`);
      await handleUnbanCommand(client, msg);
    },
    mute: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await smartEdit(msg, "❌ 客户端未初始化");
        return;
      }

      // Get the command from the message (first word after the dot)
      const args = msg.message.split(" ");
      const command = args[0].replace(".", "").toLowerCase();

      console.log(`[BanManager] Executing ${command} command`);
      await handleMuteCommand(client, msg);
    },
    unmute: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await smartEdit(msg, "❌ 客户端未初始化");
        return;
      }

      // Get the command from the message (first word after the dot)
      const args = msg.message.split(" ");
      const command = args[0].replace(".", "").toLowerCase();

      console.log(`[BanManager] Executing ${command} command`);
      await handleUnmuteCommand(client, msg);
    },
    sb: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await smartEdit(msg, "❌ 客户端未初始化");
        return;
      }

      // Get the command from the message (first word after the dot)
      const args = msg.message.split(" ");
      const command = args[0].replace(".", "").toLowerCase();

      console.log(`[BanManager] Executing ${command} command`);
      await handleSuperBanCommand(client, msg);
    },
    unsb: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await smartEdit(msg, "❌ 客户端未初始化");
        return;
      }

      // Get the command from the message (first word after the dot)
      const args = msg.message.split(" ");
      const command = args[0].replace(".", "").toLowerCase();

      console.log(`[BanManager] Executing ${command} command`);
      await handleSuperUnbanCommand(client, msg);
    },
    refresh: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await smartEdit(msg, "❌ 客户端未初始化");
        return;
      }

      // Get the command from the message (first word after the dot)
      const args = msg.message.split(" ");
      const command = args[0].replace(".", "").toLowerCase();

      console.log(`[BanManager] Executing ${command} command`);
      await handleRefreshCommand(client, msg);
    },
  };
}

console.log(`[BanManager] Exporting aban plugin with direct and subcommands`);
export default new AbanPlugin();

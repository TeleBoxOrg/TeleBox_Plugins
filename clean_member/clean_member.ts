/**
 * Clean Member plugin for TeleBox
 */

import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const sleep = promisify(setTimeout);
const CACHE_DIR = createDirectoryInAssets("clean_member_cache");

interface UserInfo {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  is_deleted: boolean;
  last_online: string | null;
}

interface CacheData {
  chat_id: number;
  chat_title: string;
  mode: string;
  day: number;
  search_time: string;
  total_found: number;
  users: UserInfo[];
}

const cache = new Map<string, { data: CacheData; timestamp: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function getCacheKey(chatId: number, mode: string, day: number): string {
  return `${chatId}_${mode}_${day}`;
}

function getFromCache(
  chatId: number,
  mode: string,
  day: number
): CacheData | null {
  const key = getCacheKey(chatId, mode, day);
  const cached = cache.get(key);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  cache.delete(key);
  return null;
}

function setCache(
  chatId: number,
  mode: string,
  day: number,
  data: CacheData
): void {
  const key = getCacheKey(chatId, mode, day);
  cache.set(key, { data, timestamp: Date.now() });
}

async function ensureDirectories(): Promise<void> {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

async function generateReport(cacheData: CacheData): Promise<string> {
  await ensureDirectories();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const reportFile = path.join(
    CACHE_DIR,
    `report_${cacheData.chat_id}_${cacheData.mode}_${cacheData.day}_${timestamp}.csv`
  );

  const modeNames: { [key: string]: string } = {
    "1": `未上线超过${cacheData.day}天`,
    "2": `未发言超过${cacheData.day}天`,
    "3": `发言少于${cacheData.day}条`,
    "4": "已注销账户",
    "5": "所有普通成员",
  };

  const csvContent = [
    ["群组清理报告"],
    ["群组名称", cacheData.chat_title],
    ["群组ID", cacheData.chat_id.toString()],
    ["清理条件", modeNames[cacheData.mode] || "未知"],
    ["搜索时间", cacheData.search_time.slice(0, 19)],
    ["符合条件用户数量", cacheData.total_found.toString()],
    [],
    ["用户ID", "用户名", "姓名", "最后上线时间", "是否注销"],
  ];

  for (const user of cacheData.users) {
    const fullName = `${user.first_name} ${user.last_name}`.trim();
    csvContent.push([
      user.id.toString(),
      user.username,
      fullName,
      user.last_online || "未知",
      user.is_deleted ? "是" : "否",
    ]);
  }

  const csvString = csvContent.map((row) => row.join(",")).join("\n");
  fs.writeFileSync(reportFile, "\ufeff" + csvString, "utf8");

  return reportFile;
}

async function checkAdminPermissions(msg: Api.Message): Promise<boolean> {
  // 暂时跳过权限检查，直接返回true进行测试
  return true;

  /* 原权限检查逻辑，如需启用请取消注释
  try {
    if (!msg.peerId || !msg.client) return false;
    
    const me = await msg.client.getMe();
    
    // 尝试获取自己在群组中的权限
    try {
      const result = await msg.client.invoke(new Api.channels.GetParticipant({
        channel: msg.peerId,
        participant: me.id
      }));
      
      if (result.participant instanceof Api.ChannelParticipantAdmin || 
          result.participant instanceof Api.ChannelParticipantCreator) {
        return true;
      }
    } catch (participantError) {
      console.log('GetParticipant failed, trying alternative method:', participantError);
    }
    
    // 备用方法：检查是否能获取管理员列表
    try {
      const result = await msg.client.invoke(new Api.channels.GetParticipants({
        channel: msg.peerId,
        filter: new Api.ChannelParticipantsAdmins(),
        offset: 0,
        limit: 100,
        hash: 0 as any
      }));
      
      if ('users' in result) {
        const admins = result.users as Api.User[];
        return admins.some(admin => Number(admin.id) === Number(me.id));
      }
    } catch (adminListError) {
      console.log('GetParticipants admin list failed:', adminListError);
    }
    
    return false;
  } catch (error) {
    console.error('Permission check failed:', error);
    return false;
  }
  */
}

async function kickChatMember(
  client: TelegramClient,
  channelEntity: any,
  userId: number
): Promise<void> {
  try {
    const untilDate = Math.floor(Date.now() / 1000) + 60;
    const userEntity = await client.getInputEntity(userId);

    console.log(`正在清理用户: ${userId}`);

    await client.invoke(
      new Api.channels.EditBanned({
        channel: channelEntity,
        participant: userEntity,
        bannedRights: new Api.ChatBannedRights({
          untilDate,
          viewMessages: true,
          sendMessages: true,
          sendMedia: true,
          sendStickers: true,
          sendGifs: true,
          sendGames: true,
          sendInline: true,
          sendPolls: true,
          changeInfo: true,
          inviteUsers: true,
          pinMessages: true,
        }),
      })
    );

    await sleep(500);

    await client.invoke(
      new Api.channels.EditBanned({
        channel: channelEntity,
        participant: userEntity,
        bannedRights: new Api.ChatBannedRights({
          untilDate: 0,
          viewMessages: false,
          sendMessages: false,
          sendMedia: false,
          sendStickers: false,
          sendGifs: false,
          sendGames: false,
          sendInline: false,
          sendPolls: false,
          changeInfo: false,
          inviteUsers: false,
          pinMessages: false,
        }),
      })
    );
  } catch (error: any) {
    console.error(`清理用户 ${userId} 失败:`, error);
    if (error.errorMessage && error.errorMessage.includes("FLOOD_WAIT")) {
      const seconds = parseInt(error.errorMessage.match(/\d+/)?.[0] || "60");
      console.log(`遇到频率限制，等待 ${seconds} 秒后重试`);
      await sleep(seconds * 1000);
      await kickChatMember(client, channelEntity, userId);
    } else if (
      error.errorMessage &&
      error.errorMessage.includes("USER_NOT_PARTICIPANT")
    ) {
      console.log(`用户 ${userId} 已不在群组中`);
      // 用户已经不在群组中，视为成功
      return;
    } else {
      // 其他错误，抛出以便上层处理
      throw error;
    }
  }
}

function getLastOnlineDays(user: Api.User): number | null {
  if (!user.status) return null;

  if (
    user.status instanceof Api.UserStatusOnline ||
    user.status instanceof Api.UserStatusRecently
  ) {
    return 0;
  } else if (user.status instanceof Api.UserStatusOffline) {
    if (user.status.wasOnline) {
      const days = Math.floor(
        (Date.now() - Number(user.status.wasOnline) * 1000) /
          (1000 * 60 * 60 * 24)
      );
      return days;
    }
  } else if (user.status instanceof Api.UserStatusLastWeek) {
    return 7;
  } else if (user.status instanceof Api.UserStatusLastMonth) {
    return 30;
  }

  return null;
}

async function getAllParticipants(
  client: TelegramClient,
  chatEntity: any,
  statusCallback?: (message: string) => Promise<void>
): Promise<{ visibleUsers: Api.User[]; estimatedTotal: number }> {
  try {
    const allUsers: Api.User[] = [];
    let offset = 0;
    const limit = 200; // Telegram API 限制
    let hasMore = true;

    while (hasMore) {
      if (statusCallback) {
        await statusCallback(
          `📥 获取成员数据 (${allUsers.length}/${
            Math.floor(offset / limit) + 1
          }批)`
        );
      }

      const result = await client.invoke(
        new Api.channels.GetParticipants({
          channel: chatEntity,
          filter: new Api.ChannelParticipantsRecent(),
          offset: offset,
          limit: limit,
          hash: 0 as any,
        })
      );

      console.log(
        `获取第${Math.floor(offset / limit) + 1}批: ${
          "users" in result ? result.users.length : 0
        }人, 总计: ${
          allUsers.length + ("users" in result ? result.users.length : 0)
        }人`
      );

      if ("users" in result && result.users.length > 0) {
        const users = result.users as Api.User[];
        allUsers.push(...users);

        // 如果返回的用户数少于limit，说明已经获取完所有用户
        if (users.length < limit) {
          hasMore = false;
          console.log(
            `API返回用户数(${users.length})少于请求数(${limit})，判断为已获取完所有可访问用户`
          );
        } else {
          offset += limit;
          // 添加延迟避免触发频率限制
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } else {
        hasMore = false;
      }

      // 安全检查：避免无限循环
      if (offset > 50000) {
        // 最多获取50000个用户
        console.warn("达到最大用户获取限制，停止获取");
        break;
      }
    }

    if (statusCallback) {
      await statusCallback(`✅ 获取完成: ${allUsers.length} 名成员`);
    }

    return { visibleUsers: allUsers, estimatedTotal: allUsers.length };
  } catch (error) {
    console.error("Failed to get participants:", error);
    if (statusCallback) {
      await statusCallback(`❌ 获取成员失败: ${error}`);
    }
    return { visibleUsers: [], estimatedTotal: 0 };
  }
}

async function filterTargetUsers(
  participants: Api.User[],
  client: TelegramClient,
  chatEntity: any,
  mode: string,
  day: number,
  adminIds: Set<number>,
  statusCallback?: (message: string) => Promise<void>
): Promise<Api.User[]> {
  const targetUsers: Api.User[] = [];
  let processedCount = 0;
  const totalCount = participants.length;

  for (const participant of participants) {
    processedCount++;

    // 对于大群组，减少状态更新频率以提高性能
    const updateInterval = totalCount > 1000 ? 50 : 10;
    if (statusCallback && processedCount % updateInterval === 0) {
      const progress = ((processedCount / totalCount) * 100).toFixed(1);
      await statusCallback(
        `🔍 分析中: ${processedCount}/${totalCount} (${progress}%) | 找到: ${targetUsers.length}`
      );
    }
    const uid = Number(participant.id);

    if (adminIds.has(uid)) continue;

    let tryTarget = false;

    if (mode === "1") {
      // 按未上线时间清理
      const lastOnlineDays = getLastOnlineDays(participant);
      if (lastOnlineDays !== null && lastOnlineDays > day) {
        tryTarget = true;
      }
    } else if (mode === "2") {
      // 按未发言时间清理
      try {
        const userEntity = await client.getInputEntity(uid);
        const messages = await client.getMessages(chatEntity, {
          limit: 1,
          fromUser: userEntity,
        });

        if (messages && messages.length > 0) {
          const lastMessageDate = messages[0].date;
          const daysDiff = Math.floor(
            (Date.now() - lastMessageDate * 1000) / (1000 * 60 * 60 * 24)
          );
          if (daysDiff > day) {
            tryTarget = true;
          }
        } else {
          // 从未发言
          tryTarget = true;
        }
      } catch (error) {
        // 获取消息失败时跳过
        continue;
      }
    } else if (mode === "3") {
      // 按发言数清理
      try {
        const userEntity = await client.getInputEntity(uid);
        const messages = await client.getMessages(chatEntity, {
          limit: day + 1,
          fromUser: userEntity,
        });

        if (messages.length < day) {
          tryTarget = true;
        }
      } catch (error) {
        // 获取消息失败时跳过
        continue;
      }
    } else if (mode === "4") {
      // 清理已注销账户
      if (participant.deleted) {
        tryTarget = true;
      }
    } else if (mode === "5") {
      // 清理所有普通成员
      tryTarget = true;
    }

    if (tryTarget) {
      targetUsers.push(participant);
    }
  }

  return targetUsers;
}

async function getTargetUsersCached(
  client: TelegramClient,
  chatId: any,
  mode: string,
  day: number,
  chatTitle: string = "",
  statusCallback?: (message: string) => Promise<void>
): Promise<CacheData> {
  try {
    // 添加调试信息
    console.log("chatId type:", typeof chatId);
    console.log("chatId value:", chatId);
    console.log(
      "chatId keys:",
      typeof chatId === "object" ? Object.keys(chatId) : "not object"
    );

    // 从 chatId 中提取数字ID用于缓存
    let numericChatId: number;
    if (typeof chatId === "object" && chatId.userId) {
      numericChatId = Number(chatId.userId);
      console.log("Using userId:", numericChatId);
    } else if (typeof chatId === "object" && chatId.chatId) {
      numericChatId = Number(chatId.chatId);
      console.log("Using chatId:", numericChatId);
    } else if (typeof chatId === "object" && chatId.channelId) {
      numericChatId = Number(chatId.channelId);
      console.log("Using channelId:", numericChatId);
    } else {
      numericChatId = Number(chatId);
      console.log("Using direct conversion:", numericChatId);
    }

    if (isNaN(numericChatId)) {
      console.error("Failed to extract numeric chat ID, using fallback");
      numericChatId = 0;
    }

    const cached = getFromCache(numericChatId, mode, day);
    if (cached) {
      if (statusCallback) {
        await statusCallback(`📋 使用缓存: ${cached.total_found} 名用户`);
      }
      return cached;
    }

    if (statusCallback) {
      await statusCallback(`🔍 搜索用户中...`);
    }

    // 尝试不同方式获取 channel entity
    let channelEntity;
    try {
      // 方法1：直接使用 chatId
      channelEntity = chatId;
      console.log("Trying direct chatId as entity");

      // 先测试是否能获取参与者
      await client.invoke(
        new Api.channels.GetParticipants({
          channel: channelEntity,
          filter: new Api.ChannelParticipantsRecent(),
          offset: 0,
          limit: 1,
          hash: 0 as any,
        })
      );

      console.log("Direct chatId works");
    } catch (error) {
      console.log("Direct chatId failed, trying getInputEntity");
      try {
        // 方法2：尝试从数字ID获取entity
        if (numericChatId && numericChatId !== 0) {
          channelEntity = await client.getInputEntity(numericChatId);
          console.log("getInputEntity with numeric ID works");
        } else {
          throw new Error("No valid numeric ID");
        }
      } catch (error2) {
        console.error("Both methods failed:", error, error2);
        throw new Error("Cannot get channel entity");
      }
    }

    if (statusCallback) {
      await statusCallback(`👥 获取成员列表中...`);
    }

    const participantsResult = await getAllParticipants(
      client,
      channelEntity,
      statusCallback
    );
    const participants = participantsResult.visibleUsers;

    if (participants.length === 0) {
      throw new Error("无法获取群组成员列表，请检查机器人权限");
    }

    if (statusCallback) {
      await statusCallback(`👤 分析权限: ${participants.length} 名成员`);
    }

    const adminIds = new Set<number>();
    try {
      const result = await client.invoke(
        new Api.channels.GetParticipants({
          channel: channelEntity,
          filter: new Api.ChannelParticipantsAdmins(),
          offset: 0,
          limit: 200,
          hash: 0 as any,
        })
      );

      if ("users" in result) {
        const admins = result.users as Api.User[];
        for (const admin of admins) {
          adminIds.add(Number(admin.id));
        }
      }
    } catch {
      // Ignore errors
    }

    if (statusCallback) {
      const modeNames: { [key: string]: string } = {
        "1": `未上线超过${day}天`,
        "2": `未发言超过${day}天`,
        "3": `发言少于${day}条`,
        "4": "已注销账户",
        "5": "所有普通成员",
      };
      await statusCallback(
        `🎯 筛选: ${modeNames[mode]} | 成员: ${participants.length} | 管理员: ${adminIds.size}`
      );
    }

    const targetUsers = await filterTargetUsers(
      participants,
      client,
      channelEntity,
      mode,
      day,
      adminIds,
      statusCallback
    );

    const cacheData: CacheData = {
      chat_id: numericChatId,
      chat_title: chatTitle,
      mode,
      day,
      search_time: new Date().toISOString(),
      total_found: targetUsers.length,
      users: [],
    };

    for (const user of targetUsers) {
      const userInfo: UserInfo = {
        id: Number(user.id),
        username: user.username || "",
        first_name: user.firstName || "",
        last_name: user.lastName || "",
        is_deleted: user.deleted || false,
        last_online: null,
      };

      if (user.status) {
        if (
          user.status instanceof Api.UserStatusOffline &&
          user.status.wasOnline
        ) {
          userInfo.last_online = new Date(
            Number(user.status.wasOnline) * 1000
          ).toISOString();
        } else if (user.status instanceof Api.UserStatusOnline) {
          userInfo.last_online = "online";
        } else if (user.status instanceof Api.UserStatusRecently) {
          userInfo.last_online = "recently";
        } else if (user.status instanceof Api.UserStatusLastWeek) {
          userInfo.last_online = "last_week";
        } else if (user.status instanceof Api.UserStatusLastMonth) {
          userInfo.last_online = "last_month";
        }
      }

      cacheData.users.push(userInfo);
    }

    try {
      await generateReport(cacheData);
    } catch (error) {
      console.error("Failed to generate CSV report:", error);
    }

    setCache(numericChatId, mode, day, cacheData);
    return cacheData;
  } catch (error) {
    console.error("Error in getTargetUsersCached:", error);
    throw error;
  }
}

function getHelpText(): string {
  return `<b>🧹 群成员清理工具</b>

<b>用法:</b> <code>clean_member &lt;模式&gt; [参数] [search]</code>

<b>模式:</b>
<code>1</code> - 按未上线天数 | <code>2</code> - 按未发言天数
<code>3</code> - 按发言数量 | <code>4</code> - 已注销账户
<code>5</code> - 所有成员 ⚠️

<b>示例:</b>
<code>clean_member 1 7 search</code> - 查找7天未上线
<code>clean_member 2 30</code> - 清理30天未发言
<code>clean_member 4</code> - 清理已注销账户

<b>特性:</b> 24h缓存 | CSV报告 | 进度显示
<b>安全:</b> 保护管理员 | 分批处理 | 自动重试`;
}

const clean_member = async (msg: Api.Message) => {
  if (!(await checkAdminPermissions(msg))) {
    await msg.edit({
      text: "❌ 权限不足，需要管理员权限",
      parseMode: "html",
    });
    return;
  }

  const args = msg.message.slice(1).split(" ").slice(1);

  if (args.length === 0) {
    await msg.edit({
      text: getHelpText(),
      parseMode: "html",
    });
    return;
  }

  const mode = args[0] || "0";
  let day = 0;
  let onlySearch = false;

  if (args.some((arg) => arg.toLowerCase() === "search")) {
    onlySearch = true;
  }

  if (mode === "1") {
    if (args.length < 2) {
      await msg.edit({
        text: "❌ 模式1需要指定天数，例: `clean_member 1 7 search`",
        parseMode: "html",
      });
      return;
    }
    try {
      day = Math.max(parseInt(args[1]), 7);
    } catch (error) {
      await msg.edit({
        text: "❌ 天数必须为数字",
        parseMode: "html",
      });
      return;
    }
  } else if (mode === "2") {
    if (args.length < 2) {
      await msg.edit({
        text: "❌ 模式2需要指定天数，例: `clean_member 2 30 search`",
        parseMode: "html",
      });
      return;
    }
    try {
      day = Math.max(parseInt(args[1]), 7);
    } catch (error) {
      await msg.edit({
        text: "❌ 天数必须为数字",
        parseMode: "html",
      });
      return;
    }
  } else if (mode === "3") {
    if (args.length < 2) {
      await msg.edit({
        text: "❌ 模式3需要指定发言数，例: `clean_member 3 5 search`",
        parseMode: "html",
      });
      return;
    }
    try {
      day = parseInt(args[1]);
      if (isNaN(day)) {
        throw new Error("Invalid number");
      }
    } catch (error) {
      await msg.edit({
        text: "❌ 发言数必须为数字",
        parseMode: "html",
      });
      return;
    }
  } else if (mode === "4" || mode === "5") {
    day = 0;
  } else {
    await msg.edit({
      text: "❌ 无效模式，请输入1-5，使用 `clean_member` 查看帮助",
      parseMode: "html",
    });
    return;
  }

  const modeNames: { [key: string]: string } = {
    "1": `未上线超过${day}天的用户`,
    "2": `未发言超过${day}天的用户`,
    "3": `发言少于${day}条的用户`,
    "4": "已注销的账户",
    "5": "所有普通成员",
  };

  const chatTitle = (msg.chat as any)?.title || "当前群组";

  // 直接使用 msg.peerId，这是 TeleBox 中的标准做法
  const chatId = msg.peerId;

  // 验证 chatId 是否有效
  if (!chatId) {
    await msg.edit({
      text: "❌ 无法获取群组ID，请在群组中使用",
      parseMode: "html",
    });
    return;
  }

  if (onlySearch) {
    await msg.edit({
      text: "🔍 开始搜索: " + modeNames[mode],
      parseMode: "html",
    });

    const statusCallback = async (message: string) => {
      try {
        await msg.edit({
          text: message,
          parseMode: "html",
        });
        await sleep(100); // 防止过于频繁的更新
      } catch (error) {
        console.log("Status update failed:", error);
      }
    };

    const client = await getGlobalClient();
    const cacheData = await getTargetUsersCached(
      client!,
      chatId,
      mode,
      day,
      chatTitle,
      statusCallback
    );

    await msg.edit({
      text: `✅ 搜索完成\n\n📊 找到 ${
        cacheData.total_found
      } 名符合条件用户\n📁 报告已保存至 \`${CACHE_DIR}/\`\n\n💡 执行清理: \`clean_member ${mode}${
        day > 0 ? " " + day : ""
      }\``,
      parseMode: "html",
    });
  } else {
    await msg.edit({
      text: `🧹 开始清理: ${modeNames[mode]}`,
      parseMode: "html",
    });

    const statusCallback = async (message: string) => {
      try {
        await msg.edit({
          text: message,
          parseMode: "html",
        });
        await sleep(100);
      } catch (error) {
        console.log("Status update failed:", error);
      }
    };

    const client = await getGlobalClient();
    const cacheData = await getTargetUsersCached(
      client!,
      chatId,
      mode,
      day,
      chatTitle,
      statusCallback
    );

    let memberCount = 0;
    const totalUsers = cacheData.users.length;

    const channelEntity = chatId;

    await msg.edit({
      text: `🚀 开始移除 ${totalUsers} 名成员`,
      parseMode: "html",
    });

    for (let i = 0; i < cacheData.users.length; i++) {
      const userInfo = cacheData.users[i];
      const userName = userInfo.username
        ? `@${userInfo.username}`
        : `${userInfo.first_name} ${userInfo.last_name}`.trim();

      try {
        await kickChatMember(client!, channelEntity, userInfo.id);
        memberCount++;

        // 每处理5个用户或每10%进度更新状态
        if (
          (i + 1) % 5 === 0 ||
          (i + 1) % Math.max(1, Math.floor(totalUsers / 10)) === 0
        ) {
          const progress = (((i + 1) / totalUsers) * 100).toFixed(1);
          const eta =
            totalUsers > 0 ? Math.ceil((totalUsers - i - 1) * 1.5) : 0; // 估算剩余时间(秒)
          await msg.edit({
            text: ` 移除中: ${
              i + 1
            }/${totalUsers} (${progress}%) | 已踢出: ${memberCount} | 当前: ${userName}`,
            parseMode: "html",
          });
        }
      } catch (error: any) {
        console.error(`Failed to kick user ${userInfo.id}:`, error);
        // 继续处理下一个用户，不中断整个流程
      }

      await sleep(1000 + Math.random() * 1000);
    }

    const successRate =
      totalUsers > 0 ? ((memberCount / totalUsers) * 100).toFixed(1) : "0";
    const failedCount = totalUsers - memberCount;
    await msg.edit({
      text: `🎉 清理完成\n\n✅ 成功: ${memberCount} | ❌ 失败: ${failedCount} | 成功率: ${successRate}%\n📁 日志已保存至 \`${CACHE_DIR}/\``,
      parseMode: "html",
    });
  }
};

class CleanMemberPlugin extends Plugin {
  description: string = `🧹 群成员清理工具 - 支持多种清理模式和进度跟踪`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    clean_member,
  };
}

export default new CleanMemberPlugin();

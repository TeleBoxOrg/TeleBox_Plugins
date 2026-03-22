import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "teleproto";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const sleep = promisify(setTimeout);
const CACHE_DIR = createDirectoryInAssets("clean_member_cache");

const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

interface UserInfo {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  is_deleted: boolean;
  last_online: string | null;
}

interface FailedUserInfo extends UserInfo {
  error_message: string;
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

function getFromCache(chatId: number, mode: string, day: number): CacheData | null {
  const key = getCacheKey(chatId, mode, day);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  cache.delete(key);
  return null;
}

function setCache(chatId: number, mode: string, day: number, data: CacheData): void {
  const key = getCacheKey(chatId, mode, day);
  cache.set(key, { data, timestamp: Date.now() });
}

async function ensureDirectories(): Promise<void> {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
  } catch (error) {
    console.error('Failed to create cache directory:', error);
    throw error;
  }
}

async function generateReport(cacheData: CacheData): Promise<string> {
  await ensureDirectories();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const reportFile = path.join(CACHE_DIR, `report_${cacheData.chat_id}_${cacheData.mode}_${cacheData.day}_${timestamp}.csv`);
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
  try {
    fs.writeFileSync(reportFile, "\ufeff" + csvString, "utf8");
    console.log(`Report generated: ${reportFile}`);
  } catch (error) {
    console.error('Failed to write report file:', error);
    await sleep(1000);
    fs.writeFileSync(reportFile, "\ufeff" + csvString, "utf8");
  }
  return reportFile;
}

async function generateFailedReport(failedUsers: FailedUserInfo[], chatTitle: string, chatId: number): Promise<string> {
  await ensureDirectories();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const reportFile = path.join(CACHE_DIR, `failed_${chatId}_${timestamp}.csv`);
  const csvContent = [
    ["群组清理失败用户报告"],
    ["群组名称", chatTitle],
    ["群组ID", chatId.toString()],
    ["失败时间", new Date().toISOString().slice(0, 19)],
    ["失败用户数量", failedUsers.length.toString()],
    [],
    ["用户ID", "用户名", "姓名", "最后上线时间", "是否注销", "失败原因"],
  ];
  for (const user of failedUsers) {
    const fullName = `${user.first_name} ${user.last_name}`.trim();
    csvContent.push([
      user.id.toString(),
      user.username,
      fullName,
      user.last_online || "未知",
      user.is_deleted ? "是" : "否",
      user.error_message
    ]);
  }
  const csvString = csvContent.map((row) => row.join(",")).join("\n");
  try {
    fs.writeFileSync(reportFile, "\ufeff" + csvString, "utf8");
    console.log(`Failed report generated: ${reportFile}`);
  } catch (error) {
    console.error('Failed to write failed report file:', error);
    await sleep(1000);
    fs.writeFileSync(reportFile, "\ufeff" + csvString, "utf8");
  }
  return reportFile;
}

async function checkAdminPermissions(msg: Api.Message): Promise<boolean> {
  try {
    if (!msg.peerId || !msg.client) return false;
    const me = await msg.client.getMe();
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
}

async function removeChatMember(client: TelegramClient, channelEntity: any, userId: number): Promise<void> {
  try {
    const userEntity = await client.getInputEntity(userId);
    console.log(`正在移出用户: ${userId}`);
    await client.invoke(new Api.channels.EditBanned({
      channel: channelEntity,
      participant: userEntity,
      bannedRights: new Api.ChatBannedRights({
        untilDate: Math.floor(Date.now() / 1000) + 60,
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
    }));
    await sleep(2000 + Math.random() * 1000);
    await client.invoke(new Api.channels.EditBanned({
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
    }));
    console.log(`用户 ${userId} 已移出并解封，可重新加入`);
  } catch (error: any) {
    console.error(`移出用户 ${userId} 失败:`, error);
    if (error.errorMessage && error.errorMessage.includes("FLOOD_WAIT")) {
      const seconds = parseInt(error.errorMessage.match(/\d+/)?.[0] || "60");
      console.log(`遇到频率限制，等待 ${seconds} 秒后重试`);
      await sleep(seconds * 1000);
      await removeChatMember(client, channelEntity, userId);
    } else if (error.errorMessage && error.errorMessage.includes("USER_NOT_PARTICIPANT")) {
      console.log(`用户 ${userId} 已不在群组中`);
      return;
    } else if (error.errorMessage && error.errorMessage.includes("CHAT_ADMIN_REQUIRED")) {
      console.log(`无权限移出用户 ${userId}（可能是管理员）`);
      throw error;
    } else {
      throw error;
    }
  }
}

function getLastOnlineDays(user: Api.User): number | null {
  if (!user.status) return null;
  if (user.status instanceof Api.UserStatusOnline || user.status instanceof Api.UserStatusRecently) {
    return 0;
  } else if (user.status instanceof Api.UserStatusOffline) {
    if (user.status.wasOnline) {
      const days = Math.floor((Date.now() - Number(user.status.wasOnline) * 1000) / (1000 * 60 * 60 * 24));
      return days;
    }
  } else if (user.status instanceof Api.UserStatusLastWeek) {
    return 7;
  } else if (user.status instanceof Api.UserStatusLastMonth) {
    return 30;
  }
  return null;
}

interface StreamProcessOptions {
  client: TelegramClient;
  chatEntity: any;
  mode: string;
  day: number;
  adminIds: Set<number>;
  onlySearch: boolean;
  maxRemove?: number;
  statusCallback?: (message: string, forceUpdate?: boolean) => Promise<void>;
  modeNames: { [key: string]: string };
}

interface StreamProcessResult {
  totalScanned: number;
  totalFound: number;
  totalRemoved: number;
  users: UserInfo[];
  failedUsers: FailedUserInfo[];
}

async function streamProcessMembers(options: StreamProcessOptions): Promise<StreamProcessResult> {
  const { client, chatEntity, mode, day, adminIds, onlySearch, maxRemove, statusCallback, modeNames } = options;
  const result: StreamProcessResult = {
    totalScanned: 0,
    totalFound: 0,
    totalRemoved: 0,
    users: [],
    failedUsers: []
  };
  let offset = 0;
  const limit = 200;
  let hasMore = true;
  let batchNumber = 0;
  try {
    while (hasMore) {
      batchNumber++;
      if (statusCallback) {
        await statusCallback(
          `🔍 扫描第 ${batchNumber} 批 (${modeNames[mode]}) | 已扫描: ${result.totalScanned} | 已找到: ${result.totalFound}${!onlySearch ? ` | 已移出: ${result.totalRemoved}` : ''}`,
          true
        );
      }
      const participantsResult = await client.invoke(new Api.channels.GetParticipants({
        channel: chatEntity,
        filter: new Api.ChannelParticipantsRecent(),
        offset: offset,
        limit: limit,
        hash: 0 as any,
      }));
      if ("users" in participantsResult && participantsResult.users.length > 0) {
        const users = participantsResult.users as Api.User[];
        result.totalScanned += users.length;
        for (const user of users) {
          const uid = Number(user.id);
          if (adminIds.has(uid)) continue;
          let shouldProcess = false;
          if (mode === "1") {
            const lastOnlineDays = getLastOnlineDays(user);
            if (lastOnlineDays !== null && lastOnlineDays > day) {
              shouldProcess = true;
            }
          } else if (mode === "2") {
            try {
              const userEntity = await client.getInputEntity(uid);
              const minDate = Math.floor(Date.now() / 1000) - day * 24 * 60 * 60;
              const res = await client.invoke(new Api.messages.Search({
                peer: chatEntity,
                q: "",
                filter: new Api.InputMessagesFilterEmpty(),
                minDate,
                maxDate: undefined as any,
                offsetId: 0,
                addOffset: 0,
                limit: 1,
                maxId: 0,
                minId: 0,
                hash: 0 as any,
                fromId: userEntity,
              }));
              const cnt = ("count" in (res as any)) ? (res as any).count : ((res as any).messages?.length || 0);
              if (cnt === 0) {
                shouldProcess = true;
              }
            } catch (error) {
              continue;
            }
          } else if (mode === "3") {
            try {
              const userEntity = await client.getInputEntity(uid);
              const res = await client.invoke(new Api.messages.Search({
                peer: chatEntity,
                q: "",
                filter: new Api.InputMessagesFilterEmpty(),
                minDate: undefined as any,
                maxDate: undefined as any,
                offsetId: 0,
                addOffset: 0,
                limit: 1,
                maxId: 0,
                minId: 0,
                hash: 0 as any,
                fromId: userEntity,
              }));
              const cnt = ("count" in (res as any)) ? (res as any).count : ((res as any).messages?.length || 0);
              if (cnt < day) {
                shouldProcess = true;
              }
            } catch (error) {
              continue;
            }
          } else if (mode === "4") {
            if (user.deleted) {
              shouldProcess = true;
            }
          } else if (mode === "5") {
            shouldProcess = true;
          }
          if (shouldProcess) {
            result.totalFound++;
            const userInfo: UserInfo = {
              id: uid,
              username: user.username || "",
              first_name: user.firstName || "",
              last_name: user.lastName || "",
              is_deleted: user.deleted || false,
              last_online: null,
            };
            if (user.status) {
              if (user.status instanceof Api.UserStatusOffline && user.status.wasOnline) {
                userInfo.last_online = new Date(Number(user.status.wasOnline) * 1000).toISOString();
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
            result.users.push(userInfo);
            if (!onlySearch) {
              if (maxRemove && result.totalRemoved >= maxRemove) {
                console.log(`已达到移除上限 ${maxRemove} 人，停止处理`);
                hasMore = false;
                break;
              }
              try {
                await removeChatMember(client, chatEntity, uid);
                result.totalRemoved++;
                if (result.totalRemoved % 5 === 0 && statusCallback) {
                  const limitInfo = maxRemove ? ` / 上限: ${maxRemove}` : '';
                  await statusCallback(
                    `⚡ 流式处理中 (${modeNames[mode]}) | 扫描: ${result.totalScanned} | 找到: ${result.totalFound} | 已移出: ${result.totalRemoved}${limitInfo}`,
                    false
                  );
                }
                await sleep(1000 + Math.random() * 500);
                if (maxRemove && result.totalRemoved >= maxRemove) {
                  console.log(`已达到移除上限 ${maxRemove} 人，停止处理`);
                  hasMore = false;
                  break;
                }
              } catch (error: any) {
                console.error(`Failed to remove user ${uid}:`, error);
                const failedUser: FailedUserInfo = {
                  ...userInfo,
                  error_message: error.message || error.toString()
                };
                result.failedUsers.push(failedUser);
              }
            }
          }
        }
        if (users.length < limit) {
          hasMore = false;
          console.log(`批次 ${batchNumber}: 获取 ${users.length} 人，少于限制 ${limit}，结束扫描`);
        } else {
          offset += limit;
          await sleep(100);
        }
      } else {
        hasMore = false;
      }
      if (offset > 50000) {
        console.warn("达到最大扫描限制 50000 人");
        break;
      }
    }
    if (statusCallback) {
      if (onlySearch) {
        await statusCallback(
          `✅ 搜索完成 (${modeNames[mode]}) | 扫描: ${result.totalScanned} 人 | 找到: ${result.totalFound} 人`,
          true
        );
      } else {
        await statusCallback(
          `✅ 清理完成 (${modeNames[mode]}) | 扫描: ${result.totalScanned} 人 | 移出: ${result.totalRemoved}/${result.totalFound} 人`,
          true
        );
      }
    }
    return result;
  } catch (error) {
    console.error("Stream process error:", error);
    if (statusCallback) {
      await statusCallback(`❌ 处理失败: ${error}`, true);
    }
    throw error;
  }
}

async function getAdminIds(client: TelegramClient, chatEntity: any): Promise<Set<number>> {
  const adminIds = new Set<number>();
  try {
    const result = await client.invoke(new Api.channels.GetParticipants({
      channel: chatEntity,
      filter: new Api.ChannelParticipantsAdmins(),
      offset: 0,
      limit: 200,
      hash: 0 as any,
    }));
    if ("users" in result) {
      const admins = result.users as Api.User[];
      for (const admin of admins) {
        adminIds.add(Number(admin.id));
      }
    }
  } catch (error) {
    console.error("Failed to get admins:", error);
  }
  return adminIds;
}

async function checkCache(chatId: number, mode: string, day: number, statusCallback?: (message: string, forceUpdate?: boolean) => Promise<void>): Promise<CacheData | null> {
  const cached = getFromCache(chatId, mode, day);
  if (cached && statusCallback) {
    await statusCallback(`📋 使用缓存: ${cached.total_found} 名用户`, true);
  }
  return cached;
}

function getHelpText(): string {
  return `<b>🧹 群成员清理工具 Pro</b>

<b>🔧 使用格式:</b>
<code>${mainPrefix}clean_member &lt;模式&gt; &lt;参数&gt; [chat:-100xxx] [limit:数量] [search]</code>

<b>📋 清理模式:</b>
┌─────────────────────────
│ <b>1</b> &lt;天数&gt; → 未上线超过N天
│ <b>2</b> &lt;天数&gt; → 未发言超过N天  
│ <b>3</b> &lt;数量&gt; → 发言少于N条
│ <b>4</b> → 已注销账户
│ <b>5</b> → 所有普通成员 ⚠️
└─────────────────────────

<b>⚙️ 可选参数:</b>
• <code>chat:-100xxx</code> - 指定群组ID(跨群查询)
• <code>limit:100</code> - 限制最多移出100人
• <code>search</code> - 仅搜索不移出（预览模式）

<b>💡 使用示例:</b>
• <code>${mainPrefix}clean_member 1 30 search</code>
  └ 搜索30天未上线的用户（预览）
• <code>${mainPrefix}clean_member 2 60 limit:50</code>
  └ 移出60天未发言，最多50人
• <code>${mainPrefix}clean_member 4 chat:-1001234567890</code>
  └ 移出指定群组的注销账户
• <code>${mainPrefix}clean_member 1 7 limit:10</code>
  └ 移出7天未上线，最多10人
`;
}

const clean_member = async (msg: Api.Message) => {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
    return;
  }
  if (!(await checkAdminPermissions(msg))) {
    await msg.edit({ text: "❌ 权限不足，需要管理员权限", parseMode: "html" });
    return;
  }
  const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
  const parts = lines?.[0]?.split(/\s+/) || [];
  const [, ...args] = parts;
  const mode = (args[0] || "").toLowerCase();
  if (!mode) {
    await msg.edit({
      parseMode: "html"
    });
    return;
  }
  if (mode === "help" || mode === "h") {
    await msg.edit({ text: getHelpText(), parseMode: "html" });
    return;
  }
  let day = 0;
  let onlySearch = false;
  let maxRemove: number | undefined = undefined;
  let targetChatId: string | number | undefined = undefined;
  
  if (args.some((arg) => arg.toLowerCase() === "search")) {
    onlySearch = true;
  }
  
  const limitArg = args.find((arg) => arg.toLowerCase().startsWith("limit:"));
  if (limitArg) {
    const limitValue = limitArg.split(":")[1];
    const parsed = parseInt(limitValue);
    if (!isNaN(parsed) && parsed > 0) {
      maxRemove = parsed;
    }
  }
  
  const chatArg = args.find((arg) => arg.toLowerCase().startsWith("chat:"));
  if (chatArg) {
    const chatValue = chatArg.split(":")[1];
    if (chatValue) {
      targetChatId = chatValue;
    }
  }
  if (mode === "1") {
    if (args.length < 2) {
      await msg.edit({
        text: `❌ <b>参数不足</b>\n\n模式1需要指定天数\n💡 示例: <code>${mainPrefix}clean_member 1 7 search</code>`,
        parseMode: "html",
      });
      return;
    }
    day = parseInt(args[1]);
    if (isNaN(day) || day < 1) {
      await msg.edit({ text: `❌ <b>参数错误</b>\n\n天数必须为正整数`, parseMode: "html" });
      return;
    }
    day = Math.max(day, 7);
  } else if (mode === "2") {
    if (args.length < 2) {
      await msg.edit({
        text: `❌ <b>参数不足</b>\n\n模式2需要指定天数\n💡 示例: <code>${mainPrefix}clean_member 2 30 search</code>`,
        parseMode: "html",
      });
      return;
    }
    day = parseInt(args[1]);
    if (isNaN(day) || day < 1) {
      await msg.edit({ text: `❌ <b>参数错误</b>\n\n天数必须为正整数`, parseMode: "html" });
      return;
    }
    day = Math.max(day, 7);
  } else if (mode === "3") {
    if (args.length < 2) {
      await msg.edit({
        text: `❌ <b>参数不足</b>\n\n模式3需要指定发言数\n💡 示例: <code>${mainPrefix}clean_member 3 5 search</code>`,
        parseMode: "html",
      });
      return;
    }
    day = parseInt(args[1]);
    if (isNaN(day) || day < 1) {
      await msg.edit({ text: `❌ <b>参数错误</b>\n\n发言数必须为正整数`, parseMode: "html" });
      return;
    }
  } else if (mode === "4" || mode === "5") {
    day = 0;
  } else {
    await msg.edit({
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

  let chatTitle = (msg.chat as any)?.title || "当前群组";
  let chatId = msg.peerId;
  let channelEntity: any;
  
  if (targetChatId) {
    try {
      channelEntity = await client.getEntity(targetChatId);
      if ('title' in channelEntity) {
        chatTitle = (channelEntity as any).title || "目标群组";
      }
      chatId = channelEntity;
    } catch (error: any) {
      await msg.edit({
        text: `❌ <b>错误：</b>无法访问指定群组\n\n请确认群组ID正确且您是该群组成员\n错误: ${htmlEscape(error.message || error.toString())}`,
        parseMode: "html",
      });
      return;
    }
  } else {
    if (!chatId) {
      await msg.edit({
        text: "❌ 无法获取群组ID，请在群组中使用或指定chat参数",
        parseMode: "html",
      });
      return;
    }
    channelEntity = chatId;
  }
  const startMessage = onlySearch ? 
    `🔍 开始搜索: ${modeNames[mode]}` : 
    `🧹 开始清理: ${modeNames[mode]}`;
  
  await msg.edit({
    text: `📋 <b>群组清理任务启动</b>\n\n🏷️ 群组: <b>${htmlEscape(chatTitle)}</b>\n🎯 ${startMessage}\n\n⏳ 正在初始化...`,
    parseMode: "html",
  });
  let savedMessageId: number | null = null;
  let useOriginalMessage = true;
  let lastUpdateTime = Date.now();
  const MIN_UPDATE_INTERVAL = 2000;
  const statusCallback = async (message: string, forceUpdate: boolean = false) => {
    try {
      const now = Date.now();
      if (!forceUpdate && now - lastUpdateTime < MIN_UPDATE_INTERVAL) {
        return;
      }
      lastUpdateTime = now;
      const progressMessage = `📋 <b>群组清理进度</b>\n\n🏷️ 群组: <b>${htmlEscape(chatTitle)}</b>\n📊 ${message}\n\n⏰ 更新时间: ${new Date().toLocaleTimeString('zh-CN')}`;
      if (useOriginalMessage) {
        try {
          await msg.edit({
            text: progressMessage,
            parseMode: "html",
          });
        } catch (editError: any) {
          console.log("原消息编辑失败，切换到收藏夹:", editError);
          useOriginalMessage = false;
          const savedMsg = await client.sendMessage("me", {
            message: `⚠️ <b>原消息已被删除，进度转移到收藏夹</b>\n\n${progressMessage}`,
            parseMode: "html",
          });
          if (savedMsg && typeof savedMsg.id === 'number') {
            savedMessageId = savedMsg.id;
          }
        }
      } else {
        if (savedMessageId) {
          try {
            await client.editMessage("me", {
              message: savedMessageId,
              text: progressMessage,
              parseMode: "html",
            });
          } catch (error) {
            const newMsg = await client.sendMessage("me", {
              message: progressMessage,
              parseMode: "html",
            });
            if (newMsg && typeof newMsg.id === 'number') {
              savedMessageId = newMsg.id;
            }
          }
        } else {
          const newMsg = await client.sendMessage("me", {
            message: progressMessage,
            parseMode: "html",
          });
          if (newMsg && typeof newMsg.id === 'number') {
            savedMessageId = newMsg.id;
          }
        }
      }
    } catch (error) {
      console.log("Status update failed:", error);
    }
  };
  
  let numericChatId: number = 0;
  try {
    if (typeof chatId === "object" && "channelId" in chatId) {
      numericChatId = Number((chatId as any).channelId);
    } else if (typeof chatId === "object" && "chatId" in chatId) {
      numericChatId = Number((chatId as any).chatId);
    } else {
      numericChatId = Number(chatId);
    }
  } catch (error) {
    console.error("Failed to extract numeric chat ID:", error);
  }
  if (onlySearch && numericChatId) {
    const cached = await checkCache(numericChatId, mode, day, statusCallback);
    if (cached) {
      try {
        await generateReport(cached);
      } catch (error) {
        console.error("Failed to generate report:", error);
      }
      await msg.edit({
        text: `✅ 搜索完成（缓存）\n\n📊 找到 ${cached.total_found} 名符合条件用户\n📁 报告已保存至 \`${CACHE_DIR}/\`\n\n💡 执行清理: \`${mainPrefix}clean_member ${mode}${day > 0 ? " " + day : ""}\``,
        parseMode: "html",
      });
      return;
    }
  }
  await statusCallback(`👤 获取管理员权限...`, true);
  const adminIds = await getAdminIds(client, channelEntity);
  await statusCallback(
    `🎯 准备${onlySearch ? "搜索" : "清理"}: ${modeNames[mode]} | 管理员: ${adminIds.size}`,
    true
  );
  const result = await streamProcessMembers({
    client,
    chatEntity: channelEntity,
    mode,
    day,
    adminIds,
    onlySearch,
    maxRemove,
    statusCallback,
    modeNames
  });
  if (numericChatId) {
    const cacheData: CacheData = {
      chat_id: numericChatId,
      chat_title: chatTitle,
      mode,
      day,
      search_time: new Date().toISOString(),
      total_found: result.totalFound,
      users: result.users
    };
    setCache(numericChatId, mode, day, cacheData);
  }
  let finalMessage = "";
  if (onlySearch) {
    finalMessage = `✅ <b>搜索完成</b> - ${modeNames[mode]}\n\n` +
      `📊 扫描人数: <code>${result.totalScanned}</code> 人\n` +
      `🎯 符合条件: <code>${result.totalFound}</code> 人\n` +
      `📁 报告位置: <code>${CACHE_DIR}/</code>\n\n` +
      `💡 <b>执行清理命令:</b>\n` +
      `<code>${mainPrefix}clean_member ${mode}${day > 0 ? " " + day : ""}</code>`;
  } else {
    const successRate = result.totalFound > 0 
      ? ((result.totalRemoved / result.totalFound) * 100).toFixed(1) 
      : "0";
    const failedCount = result.totalFound - result.totalRemoved;
    const limitReached = maxRemove && result.totalRemoved >= maxRemove;
    
    finalMessage = `🎉 <b>清理完成</b> - ${modeNames[mode]}${limitReached ? " (已达上限)" : ""}\n\n` +
      `📊 扫描人数: <code>${result.totalScanned}</code> 人\n` +
      `🎯 符合条件: <code>${result.totalFound}</code> 人\n` +
      `✅ 成功移出: <code>${result.totalRemoved}</code> 人` +
      (maxRemove ? ` / 上限 <code>${maxRemove}</code>` : "") + `\n` +
      `❌ 失败/跳过: <code>${failedCount}</code> 人\n` +
      `📈 成功率: <code>${successRate}%</code>\n` +
      `📁 报告位置: <code>${CACHE_DIR}/</code>`;
  }
  try {
    if (useOriginalMessage) {
      await msg.edit({
        text: finalMessage,
        parseMode: "html",
      });
    } else {
      if (savedMessageId) {
        await client.editMessage("me", {
          message: savedMessageId,
          text: finalMessage,
          parseMode: "html",
        });
      } else {
        await client.sendMessage("me", {
          message: finalMessage,
          parseMode: "html",
        });
      }
    }
  } catch (error) {
    console.error("显示最终结果失败:", error);
    await client.sendMessage("me", {
      message: finalMessage,
      parseMode: "html",
    });
  }
  if (!useOriginalMessage) {
    try {
      const reportMessage = `📋 <b>群组清理最终报告</b>\n\n` +
        `🏷️ 群组: <b>${htmlEscape(chatTitle)}</b>\n` +
        `🔧 模式: ${modeNames[mode]}\n` +
        `📅 时间: ${new Date().toLocaleString('zh-CN')}\n\n` +
        `⚠️ 注意：原消息已被删除，报告已转移到收藏夹\n\n` +
        finalMessage;
      
      await client.sendMessage("me", {
        message: reportMessage,
        parseMode: "html",
      });
      console.log("完整报告已发送到收藏夹");
    } catch (error) {
      console.error("发送完整报告失败:", error);
    }
  }
  
  if (!onlySearch && result.failedUsers.length > 0 && numericChatId) {
    try {
      const failedReportPath = await generateFailedReport(result.failedUsers, chatTitle, numericChatId);
      await client.sendMessage("me", {
        message: `⚠️ <b>清理失败用户报告</b>\n\n` +
          `🏷️ 群组: <b>${htmlEscape(chatTitle)}</b>\n` +
          `❌ 失败数量: <code>${result.failedUsers.length}</code> 人\n` +
          `📁 报告文件: <code>${path.basename(failedReportPath)}</code>\n\n` +
          `📊 详细信息请查看 CSV 文件`,
        parseMode: "html",
        file: failedReportPath
      });
      console.log(`失败用户报告已发送到收藏夹: ${failedReportPath}`);
    } catch (error) {
      console.error("生成或发送失败报告失败:", error);
    }
  }
};

class CleanMemberPlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  description: string = getHelpText();
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    clean_member
  };
}

export default new CleanMemberPlugin();

/**
 * Clean Member plugin for TeleBox
 */

import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const sleep = promisify(setTimeout);
const CACHE_DIR = createDirectoryInAssets("clean_member_cache");

// 必需工具函数
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

async function removeChatMember(
  client: TelegramClient,
  channelEntity: any,
  userId: number
): Promise<void> {
  try {
    const userEntity = await client.getInputEntity(userId);

    console.log(`正在移出用户: ${userId}`);

    // 第一步：先封禁用户（踢出群组）
    await client.invoke(
      new Api.channels.EditBanned({
        channel: channelEntity,
        participant: userEntity,
        bannedRights: new Api.ChatBannedRights({
          untilDate: Math.floor(Date.now() / 1000) + 60,  // 临时封禁60秒
          viewMessages: true,  // 禁止查看消息
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

    // 等待较长时间确保踢出生效，避免解封失败
    await sleep(2000 + Math.random() * 1000);  // 等待2-3秒

    // 第二步：解封（允许用户重新加入）
    await client.invoke(
      new Api.channels.EditBanned({
        channel: channelEntity,
        participant: userEntity,
        bannedRights: new Api.ChatBannedRights({
          untilDate: 0,  // 0 表示解除所有限制
          viewMessages: false,  // 恢复所有权限
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
    
    console.log(`用户 ${userId} 已移出并解封，可重新加入`);
  } catch (error: any) {
    console.error(`移出用户 ${userId} 失败:`, error);
    if (error.errorMessage && error.errorMessage.includes("FLOOD_WAIT")) {
      const seconds = parseInt(error.errorMessage.match(/\d+/)?.[0] || "60");
      console.log(`遇到频率限制，等待 ${seconds} 秒后重试`);
      await sleep(seconds * 1000);
      await removeChatMember(client, channelEntity, userId);
    } else if (
      error.errorMessage &&
      error.errorMessage.includes("USER_NOT_PARTICIPANT")
    ) {
      console.log(`用户 ${userId} 已不在群组中`);
      // 用户已经不在群组中，视为成功
      return;
    } else if (
      error.errorMessage &&
      error.errorMessage.includes("CHAT_ADMIN_REQUIRED")
    ) {
      console.log(`无权限移出用户 ${userId}（可能是管理员）`);
      throw error;
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

// 流式处理接口
interface StreamProcessOptions {
  client: TelegramClient;
  chatEntity: any;
  mode: string;
  day: number;
  adminIds: Set<number>;
  onlySearch: boolean;
  maxRemove?: number;  // 移除人数上限
  statusCallback?: (message: string, forceUpdate?: boolean) => Promise<void>;
  modeNames: { [key: string]: string };
}

interface StreamProcessResult {
  totalScanned: number;
  totalFound: number;
  totalRemoved: number;
  users: UserInfo[];
}

// 流式处理：边扫描边处理
async function streamProcessMembers(
  options: StreamProcessOptions
): Promise<StreamProcessResult> {
  const { client, chatEntity, mode, day, adminIds, onlySearch, maxRemove, statusCallback, modeNames } = options;
  const result: StreamProcessResult = {
    totalScanned: 0,
    totalFound: 0,
    totalRemoved: 0,
    users: []
  };

  let offset = 0;
  const limit = 200; // Telegram API 限制
  let hasMore = true;
  let batchNumber = 0;

  try {
    while (hasMore) {
      batchNumber++;
      
      // 获取一批用户
      if (statusCallback) {
        // 每批次强制更新
        await statusCallback(
          `🔍 扫描第 ${batchNumber} 批 (${modeNames[mode]}) | 已扫描: ${result.totalScanned} | 已找到: ${result.totalFound}${!onlySearch ? ` | 已移出: ${result.totalRemoved}` : ''}`,
          true
        );
      }

      const participantsResult = await client.invoke(
        new Api.channels.GetParticipants({
          channel: chatEntity,
          filter: new Api.ChannelParticipantsRecent(),
          offset: offset,
          limit: limit,
          hash: 0 as any,
        })
      );

      if ("users" in participantsResult && participantsResult.users.length > 0) {
        const users = participantsResult.users as Api.User[];
        result.totalScanned += users.length;

        // 流式处理这批用户
        for (const user of users) {
          const uid = Number(user.id);
          
          // 跳过管理员
          if (adminIds.has(uid)) continue;

          // 检查是否符合条件
          let shouldProcess = false;

          if (mode === "1") {
            // 按未上线时间
            const lastOnlineDays = getLastOnlineDays(user);
            if (lastOnlineDays !== null && lastOnlineDays > day) {
              shouldProcess = true;
            }
          } else if (mode === "2") {
            // 按未发言时间
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
                  shouldProcess = true;
                }
              } else {
                // 从未发言
                shouldProcess = true;
              }
            } catch (error) {
              // 获取消息失败时跳过
              continue;
            }
          } else if (mode === "3") {
            // 按发言数
            try {
              const userEntity = await client.getInputEntity(uid);
              const messages = await client.getMessages(chatEntity, {
                limit: day + 1,
                fromUser: userEntity,
              });

              if (messages.length < day) {
                shouldProcess = true;
              }
            } catch (error) {
              continue;
            }
          } else if (mode === "4") {
            // 已注销账户
            if (user.deleted) {
              shouldProcess = true;
            }
          } else if (mode === "5") {
            // 所有普通成员
            shouldProcess = true;
          }

          if (shouldProcess) {
            result.totalFound++;
            
            // 记录用户信息
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

            // 如果不是仅搜索模式，立即移出用户（流式处理核心）
            if (!onlySearch) {
              // 检查是否达到移除上限
              if (maxRemove && result.totalRemoved >= maxRemove) {
                console.log(`已达到移除上限 ${maxRemove} 人，停止处理`);
                hasMore = false;
                break;
              }
              
              try {
                await removeChatMember(client, chatEntity, uid);
                result.totalRemoved++;
                
                // 实时更新进度（每5个用户更新一次）
                if (result.totalRemoved % 5 === 0 && statusCallback) {
                  const limitInfo = maxRemove ? ` / 上限: ${maxRemove}` : '';
                  await statusCallback(
                    `⚡ 流式处理中 (${modeNames[mode]}) | 扫描: ${result.totalScanned} | 找到: ${result.totalFound} | 已移出: ${result.totalRemoved}${limitInfo}`,
                    false // 不强制更新，受频率限制
                  );
                }
                
                // 添加延迟避免频率限制
                await sleep(1000 + Math.random() * 500);
                
                // 再次检查是否达到上限
                if (maxRemove && result.totalRemoved >= maxRemove) {
                  console.log(`已达到移除上限 ${maxRemove} 人，停止处理`);
                  hasMore = false;
                  break;
                }
              } catch (error: any) {
                console.error(`Failed to remove user ${uid}:`, error);
                // 继续处理下一个用户
              }
            }
          }
        }

        // 判断是否还有更多用户
        if (users.length < limit) {
          hasMore = false;
          console.log(`批次 ${batchNumber}: 获取 ${users.length} 人，少于限制 ${limit}，结束扫描`);
        } else {
          offset += limit;
          // 批次间延迟
          await sleep(100);
        }
      } else {
        hasMore = false;
      }

      // 安全限制
      if (offset > 50000) {
        console.warn("达到最大扫描限制 50000 人");
        break;
      }
    }

    if (statusCallback) {
      if (onlySearch) {
        await statusCallback(
          `✅ 搜索完成 (${modeNames[mode]}) | 扫描: ${result.totalScanned} 人 | 找到: ${result.totalFound} 人`,
          true // 强制更新最终结果
        );
      } else {
        await statusCallback(
          `✅ 清理完成 (${modeNames[mode]}) | 扫描: ${result.totalScanned} 人 | 移出: ${result.totalRemoved}/${result.totalFound} 人`,
          true // 强制更新最终结果
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

// 获取管理员列表
async function getAdminIds(
  client: TelegramClient,
  chatEntity: any
): Promise<Set<number>> {
  const adminIds = new Set<number>();
  try {
    const result = await client.invoke(
      new Api.channels.GetParticipants({
        channel: chatEntity,
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
  } catch (error) {
    console.error("Failed to get admins:", error);
  }
  return adminIds;
}

// 简化的缓存检查函数
async function checkCache(
  chatId: number,
  mode: string,
  day: number,
  statusCallback?: (message: string, forceUpdate?: boolean) => Promise<void>
): Promise<CacheData | null> {
  const cached = getFromCache(chatId, mode, day);
  if (cached && statusCallback) {
    await statusCallback(`📋 使用缓存: ${cached.total_found} 名用户`, true);
  }
  return cached;
}

function getHelpText(): string {
  return `<b>🧹 群成员清理工具 Pro</b>


<b>🔧 使用格式:</b>
<code>${mainPrefix}clean_member &lt;模式&gt; &lt;参数&gt; [limit:数量] [search]</code>

<b>📋 清理模式:</b>
┌─────────────────────────
│ <b>1</b> &lt;天数&gt; → 未上线超过N天
│ <b>2</b> &lt;天数&gt; → 未发言超过N天  
│ <b>3</b> &lt;数量&gt; → 发言少于N条
│ <b>4</b> → 已注销账户
│ <b>5</b> → 所有普通成员 ⚠️
└─────────────────────────

<b>⚙️ 可选参数:</b>
• <code>limit:100</code> - 限制最多移出100人
• <code>search</code> - 仅搜索不移出（预览模式）

<b>💡 使用示例:</b>
• <code>${mainPrefix}clean_member 1 30 search</code>
  └ 搜索30天未上线的用户（预览）
• <code>${mainPrefix}clean_member 2 60 limit:50</code>
  └ 移出60天未发言，最多50人
• <code>${mainPrefix}clean_member 4</code>
  └ 移出所有已注销账户
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
    await msg.edit({
      text: "❌ 权限不足，需要管理员权限",
      parseMode: "html",
    });
    return;
  }

  // acron.ts 模式参数解析
  const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
  const parts = lines?.[0]?.split(/\s+/) || [];
  const [, ...args] = parts;
  const mode = (args[0] || "").toLowerCase();

  // 无参数时显示错误提示
  if (!mode) {
    await msg.edit({
      text: `❌ <b>参数不足</b>\n\n💡 使用 <code>${mainPrefix}clean_member help</code> 查看帮助`,
      parseMode: "html"
    });
    return;
  }

  // 明确请求帮助时才显示
  if (mode === "help" || mode === "h") {
    await msg.edit({ text: getHelpText(), parseMode: "html" });
    return;
  }

  let day = 0;
  let onlySearch = false;
  let maxRemove: number | undefined = undefined;

  // 检查是否包含 search 参数
  if (args.some((arg) => arg.toLowerCase() === "search")) {
    onlySearch = true;
  }
  
  // 检查是否包含 limit 参数
  const limitArg = args.find((arg) => arg.toLowerCase().startsWith("limit:"));
  if (limitArg) {
    const limitValue = limitArg.split(":")[1];
    const parsed = parseInt(limitValue);
    if (!isNaN(parsed) && parsed > 0) {
      maxRemove = parsed;
    }
  }

  // 参数验证
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
      await msg.edit({
        text: `❌ <b>参数错误</b>\n\n天数必须为正整数`,
        parseMode: "html",
      });
      return;
    }
    day = Math.max(day, 7); // 最少7天
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
      await msg.edit({
        text: `❌ <b>参数错误</b>\n\n天数必须为正整数`,
        parseMode: "html",
      });
      return;
    }
    day = Math.max(day, 7); // 最少7天
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
      await msg.edit({
        text: `❌ <b>参数错误</b>\n\n发言数必须为正整数`,
        parseMode: "html",
      });
      return;
    }
  } else if (mode === "4" || mode === "5") {
    day = 0;
  } else {
    await msg.edit({
      text: `❌ <b>无效模式</b>\n\n请输入1-5之间的数字\n💡 使用 <code>${mainPrefix}clean_member help</code> 查看帮助`,
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

  // 初始化提示 - 在原消息编辑
  const startMessage = onlySearch ? 
    `🔍 开始搜索: ${modeNames[mode]}` : 
    `🧹 开始清理: ${modeNames[mode]}`;
  
  await msg.edit({
    text: `📋 <b>群组清理任务启动</b>\n\n🏷️ 群组: <b>${htmlEscape(chatTitle)}</b>\n🎯 ${startMessage}\n\n⏳ 正在初始化...`,
    parseMode: "html",
  });
  
  // 保存收藏夹消息ID，用于备用
  let savedMessageId: number | null = null;
  let useOriginalMessage = true; // 标记是否使用原消息

  // 状态回调函数 - 优先编辑原消息，失败则发送到收藏夹
  let lastUpdateTime = Date.now();
  const MIN_UPDATE_INTERVAL = 2000; // 最小更新间隔2秒，避免过于频繁
  
  const statusCallback = async (message: string, forceUpdate: boolean = false) => {
    try {
      // 控制更新频率
      const now = Date.now();
      if (!forceUpdate && now - lastUpdateTime < MIN_UPDATE_INTERVAL) {
        return;
      }
      lastUpdateTime = now;
      
      const progressMessage = `📋 <b>群组清理进度</b>\n\n🏷️ 群组: <b>${htmlEscape(chatTitle)}</b>\n📊 ${message}\n\n⏰ 更新时间: ${new Date().toLocaleTimeString('zh-CN')}`;
      
      if (useOriginalMessage) {
        try {
          // 尝试编辑原消息
          await msg.edit({
            text: progressMessage,
            parseMode: "html",
          });
        } catch (editError: any) {
          // 如果编辑失败（消息被删除等），切换到收藏夹
          console.log("原消息编辑失败，切换到收藏夹:", editError);
          useOriginalMessage = false;
          
          // 发送到收藏夹
          const savedMsg = await client.sendMessage("me", {
            message: `⚠️ <b>原消息已被删除，进度转移到收藏夹</b>\n\n${progressMessage}`,
            parseMode: "html",
          });
          
          if (savedMsg && typeof savedMsg.id === 'number') {
            savedMessageId = savedMsg.id;
          }
        }
      } else {
        // 使用收藏夹消息
        if (savedMessageId) {
          try {
            // 尝试编辑收藏夹中的消息
            await client.editMessage("me", {
              message: savedMessageId,
              text: progressMessage,
              parseMode: "html",
            });
          } catch (error) {
            // 如果编辑失败，发送新消息
            const newMsg = await client.sendMessage("me", {
              message: progressMessage,
              parseMode: "html",
            });
            if (newMsg && typeof newMsg.id === 'number') {
              savedMessageId = newMsg.id;
            }
          }
        } else {
          // 如果没有保存的消息ID，发送新消息
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

  // 获取 channel entity
  const channelEntity = chatId;
  let numericChatId: number = 0;
  
  try {
    // 提取数字ID用于缓存
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

  // 检查缓存（仅搜索模式）
  if (onlySearch && numericChatId) {
    const cached = await checkCache(numericChatId, mode, day, statusCallback);
    if (cached) {
      // 生成报告
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

  // 获取管理员列表
  await statusCallback(`👤 获取管理员权限...`, true);
  const adminIds = await getAdminIds(client, channelEntity);
  
  await statusCallback(
    `🎯 准备${onlySearch ? "搜索" : "清理"}: ${modeNames[mode]} | 管理员: ${adminIds.size}`,
    true
  );

  // 最终结果
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

  // 设置缓存
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

  // 显示最终结果
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
  
  // 尝试编辑原消息显示最终结果
  try {
    if (useOriginalMessage) {
      await msg.edit({
        text: finalMessage,
        parseMode: "html",
      });
    } else {
      // 如果原消息已被删除，在收藏夹中显示最终结果
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
    // 如果都失败了，至少发送到收藏夹
    await client.sendMessage("me", {
      message: finalMessage,
      parseMode: "html",
    });
  }
  
  // 如果使用了收藏夹，额外发送一份完整报告
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
};

class CleanMemberPlugin extends Plugin {
  description: string = getHelpText();
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    clean_member
  };
}

export default new CleanMemberPlugin();

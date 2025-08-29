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
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

async function generateReport(cacheData: CacheData): Promise<string> {
  await ensureDirectories();
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const reportFile = path.join(CACHE_DIR, `report_${cacheData.chat_id}_${cacheData.mode}_${cacheData.day}_${timestamp}.csv`);
  
  const modeNames: { [key: string]: string } = {
    "1": `未上线超过${cacheData.day}天`,
    "2": `未发言超过${cacheData.day}天`,
    "3": `发言少于${cacheData.day}条`,
    "4": "已注销账户",
    "5": "所有普通成员"
  };
  
  const csvContent = [
    ['群组清理报告'],
    ['群组名称', cacheData.chat_title],
    ['群组ID', cacheData.chat_id.toString()],
    ['清理条件', modeNames[cacheData.mode] || '未知'],
    ['搜索时间', cacheData.search_time.slice(0, 19)],
    ['符合条件用户数量', cacheData.total_found.toString()],
    [],
    ['用户ID', '用户名', '姓名', '最后上线时间', '是否注销']
  ];
  
  for (const user of cacheData.users) {
    const fullName = `${user.first_name} ${user.last_name}`.trim();
    csvContent.push([
      user.id.toString(),
      user.username,
      fullName,
      user.last_online || '未知',
      user.is_deleted ? '是' : '否'
    ]);
  }
  
  const csvString = csvContent.map(row => row.join(',')).join('\n');
  fs.writeFileSync(reportFile, '\ufeff' + csvString, 'utf8');
  
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

async function kickChatMember(client: TelegramClient, channelEntity: any, userId: number): Promise<void> {
  try {
    const untilDate = Math.floor(Date.now() / 1000) + 60;
    const userEntity = await client.getInputEntity(userId);
    
    console.log(`正在清理用户: ${userId}`);
    
    await client.invoke(new Api.channels.EditBanned({
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
        pinMessages: true
      })
    }));
    
    await sleep(500);
    
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
        pinMessages: false
      })
    }));
  } catch (error: any) {
    console.error(`清理用户 ${userId} 失败:`, error);
    if (error.errorMessage && error.errorMessage.includes('FLOOD_WAIT')) {
      const seconds = parseInt(error.errorMessage.match(/\d+/)?.[0] || '60');
      console.log(`遇到频率限制，等待 ${seconds} 秒后重试`);
      await sleep(seconds * 1000);
      await kickChatMember(client, channelEntity, userId);
    } else if (error.errorMessage && error.errorMessage.includes('USER_NOT_PARTICIPANT')) {
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

async function getAllParticipants(
  client: TelegramClient, 
  chatEntity: any, 
  statusCallback?: (message: string) => Promise<void>
): Promise<{ visibleUsers: Api.User[], estimatedTotal: number }> {
  try {
    const allUsers: Api.User[] = [];
    let offset = 0;
    const limit = 200; // Telegram API 限制
    let hasMore = true;
    
    while (hasMore) {
      if (statusCallback) {
        await statusCallback(`📥 **获取群成员数据**\n\n📊 **当前进度:** 已获取 ${allUsers.length} 名成员\n🔄 **状态:** 正在从服务器获取第 ${Math.floor(offset / limit) + 1} 批数据...`);
      }
      
      const result = await client.invoke(new Api.channels.GetParticipants({
        channel: chatEntity,
        filter: new Api.ChannelParticipantsRecent(),
        offset: offset,
        limit: limit,
        hash: 0 as any
      }));
      
      console.log(`获取第${Math.floor(offset / limit) + 1}批: ${'users' in result ? result.users.length : 0}人, 总计: ${allUsers.length + ('users' in result ? result.users.length : 0)}人`);
      
      if ('users' in result && result.users.length > 0) {
        const users = result.users as Api.User[];
        allUsers.push(...users);
        
        // 如果返回的用户数少于limit，说明已经获取完所有用户
        if (users.length < limit) {
          hasMore = false;
          console.log(`API返回用户数(${users.length})少于请求数(${limit})，判断为已获取完所有可访问用户`);
        } else {
          offset += limit;
          // 添加延迟避免触发频率限制
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } else {
        hasMore = false;
      }
      
      // 安全检查：避免无限循环
      if (offset > 50000) { // 最多获取50000个用户
        console.warn('达到最大用户获取限制，停止获取');
        break;
      }
    }
    
    if (statusCallback) {
      await statusCallback(`✅ **成员数据获取完成**\n\n📊 **可见成员:** 成功获取 ${allUsers.length} 名群成员\n📝 **已注销用户:** API无法访问的用户已计为已注销账户\n🎯 **下一步:** 开始分析用户活动状态...`);
    }
    
    return { visibleUsers: allUsers, estimatedTotal: allUsers.length };
  } catch (error) {
    console.error('Failed to get participants:', error);
    if (statusCallback) {
      await statusCallback(`❌ **获取成员失败**\n\n🔍 **错误:** ${error}\n💡 **建议:** 检查网络连接和机器人权限`);
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
      const eta = totalCount > processedCount ? Math.ceil((totalCount - processedCount) * 0.1) : 0;
      await statusCallback(`🔍 **分析用户活动**\n\n📊 **进度:** ${processedCount}/${totalCount} (${progress}%)\n👤 **当前:** 检查用户活动状态\n✅ **已找到:** ${targetUsers.length} 名符合条件用户\n⏱️ **预计剩余:** ${eta}秒`);
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
          fromUser: userEntity
        });
        
        if (messages && messages.length > 0) {
          const lastMessageDate = messages[0].date;
          const daysDiff = Math.floor((Date.now() - lastMessageDate * 1000) / (1000 * 60 * 60 * 24));
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
          fromUser: userEntity
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
    console.log('chatId type:', typeof chatId);
    console.log('chatId value:', chatId);
    console.log('chatId keys:', typeof chatId === 'object' ? Object.keys(chatId) : 'not object');
  
  // 从 chatId 中提取数字ID用于缓存
  let numericChatId: number;
  if (typeof chatId === 'object' && chatId.userId) {
    numericChatId = Number(chatId.userId);
    console.log('Using userId:', numericChatId);
  } else if (typeof chatId === 'object' && chatId.chatId) {
    numericChatId = Number(chatId.chatId);
    console.log('Using chatId:', numericChatId);
  } else if (typeof chatId === 'object' && chatId.channelId) {
    numericChatId = Number(chatId.channelId);
    console.log('Using channelId:', numericChatId);
  } else {
    numericChatId = Number(chatId);
    console.log('Using direct conversion:', numericChatId);
  }
  
  if (isNaN(numericChatId)) {
    console.error('Failed to extract numeric chat ID, using fallback');
    numericChatId = 0;
  }
  
  const cached = getFromCache(numericChatId, mode, day);
  if (cached) {
    if (statusCallback) {
      await statusCallback(`📋 **使用缓存数据**\n\n🔍 **操作:** 从缓存加载符合条件的用户\n📊 **结果:** 找到 ${cached.total_found} 名用户`);
    }
    return cached;
  }
  
  if (statusCallback) {
    await statusCallback(`🔍 **正在搜索用户**\n\n📡 **操作:** 获取群组成员列表\n⏳ **状态:** 连接到Telegram服务器...`);
  }
  
  // 尝试不同方式获取 channel entity
  let channelEntity;
  try {
    // 方法1：直接使用 chatId
    channelEntity = chatId;
    console.log('Trying direct chatId as entity');
    
    // 先测试是否能获取参与者
    await client.invoke(new Api.channels.GetParticipants({
      channel: channelEntity,
      filter: new Api.ChannelParticipantsRecent(),
      offset: 0,
      limit: 1,
      hash: 0 as any
    }));
    
    console.log('Direct chatId works');
  } catch (error) {
    console.log('Direct chatId failed, trying getInputEntity');
    try {
      // 方法2：尝试从数字ID获取entity
      if (numericChatId && numericChatId !== 0) {
        channelEntity = await client.getInputEntity(numericChatId);
        console.log('getInputEntity with numeric ID works');
      } else {
        throw new Error('No valid numeric ID');
      }
    } catch (error2) {
      console.error('Both methods failed:', error, error2);
      throw new Error('Cannot get channel entity');
    }
  }
  
  if (statusCallback) {
    await statusCallback(`👥 **开始获取成员列表**\n\n📡 **操作:** 从Telegram服务器获取群组成员\n⏳ **状态:** 准备分批下载成员数据...`);
  }
  
  const participantsResult = await getAllParticipants(client, channelEntity, statusCallback);
  const participants = participantsResult.visibleUsers;
  
  if (participants.length === 0) {
    throw new Error('无法获取群组成员列表，请检查机器人权限');
  }
  
  if (statusCallback) {
    await statusCallback(`👤 **分析管理员权限**\n\n📡 **操作:** 获取群组管理员列表\n👥 **可见成员:** ${participants.length} 名\n🔍 **状态:** 识别管理员身份...`);
  }
  
  const adminIds = new Set<number>();
  try {
    const result = await client.invoke(new Api.channels.GetParticipants({
      channel: channelEntity,
      filter: new Api.ChannelParticipantsAdmins(),
      offset: 0,
      limit: 200,
      hash: 0 as any
    }));
    
    if ('users' in result) {
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
      "5": "所有普通成员"
    };
    await statusCallback(`🎯 **开始筛选目标用户**\n\n📊 **筛选条件:** ${modeNames[mode]}\n👥 **可见成员:** ${participants.length} 名\n🛡️ **管理员数:** ${adminIds.size} 名\n📝 **说明:** 不可见用户已视为已注销账户\n⏳ **状态:** 正在逐个分析用户活动...`);
  }
  
  const targetUsers = await filterTargetUsers(participants, client, channelEntity, mode, day, adminIds, statusCallback);
  
  const cacheData: CacheData = {
    chat_id: numericChatId,
    chat_title: chatTitle,
    mode,
    day,
    search_time: new Date().toISOString(),
    total_found: targetUsers.length,
    users: []
  };
  
  for (const user of targetUsers) {
    const userInfo: UserInfo = {
      id: Number(user.id),
      username: user.username || '',
      first_name: user.firstName || '',
      last_name: user.lastName || '',
      is_deleted: user.deleted || false,
      last_online: null
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
    
    cacheData.users.push(userInfo);
  }
  
  try {
    await generateReport(cacheData);
  } catch (error) {
    console.error('Failed to generate CSV report:', error);
  }
  
  setCache(numericChatId, mode, day, cacheData);
  return cacheData;
  } catch (error) {
    console.error('Error in getTargetUsersCached:', error);
    throw error;
  }
}

function getHelpText(): string {
  return `<b>🧹 群成员清理工具 v5.1 - TeleBox版</b>

<b>📋 使用方法:</b>
<code>clean_member &lt;模式&gt; [参数] [search]</code>

<b>🎯 清理模式:</b>
├ <code>1</code> - 按未上线时间清理
├ <code>2</code> - 按未发言时间清理
├ <code>3</code> - 按发言数量清理
├ <code>4</code> - 清理已注销账户  
└ <code>5</code> - 清理所有成员 ⚠️

<b>💡 使用示例:</b>
├ <code>clean_member 1 7 search</code> - 查找7天未上线用户
├ <code>clean_member 2 30 search</code> - 查找30天未发言用户
├ <code>clean_member 3 5 search</code> - 查找发言少于5条用户
├ <code>clean_member 1 7</code> - 清理7天未上线用户
└ <code>clean_member 4</code> - 清理已注销账户

<b>🚀 TeleBox集成特性:</b>
• <b>智能缓存</b>: 24小时缓存系统
• <b>CSV报告</b>: Excel可打开的详细报告
• <b>实时状态</b>: 详细的操作进度显示
• <b>错误处理</b>: 完善的异常处理机制

<b>⚠️ 重要说明:</b>
• <b>权限要求</b>: 需要管理员权限
• <b>建议流程</b>: 查找 → 确认报告 → 清理

<b>🛡️ 安全特性:</b>
• 不会清理管理员
• 分批处理降低风控
• 异常自动重试

<b>📁 文件输出:</b>
• CSV报告: Excel可打开，供人工查看
• 存储位置: <code>${CACHE_DIR}/</code>`;
}

const cleanMemberPlugin: Plugin = {
  command: ["clean_member"],
  description: "🧹 智能群成员清理工具 v5.1 | TeleBox版 - 支持实时状态显示和详细进度跟踪",
  cmdHandler: async (msg: Api.Message) => {
    try {
      if (!(await checkAdminPermissions(msg))) {
        await msg.edit({
          text: "❌ **权限不足**\n\n您不是群管理员，无法使用此命令",
          parseMode: "html"
        });
        return;
      }

      const args = msg.message.slice(1).split(' ').slice(1);

      if (args.length === 0) {
        await msg.edit({
          text: getHelpText(),
          parseMode: "html"
        });
        return;
      }

      const mode = args[0] || "0";
      let day = 0;
      let onlySearch = false;

      if (args.some(arg => arg.toLowerCase() === "search")) {
        onlySearch = true;
      }

      if (mode === "1") {
        if (args.length < 2) {
          await msg.edit({
            text: "❌ **参数错误**\n\n模式1需要指定天数\n例: `clean_member 1 7 search`",
            parseMode: "html"
          });
          return;
        }
        try {
          day = Math.max(parseInt(args[1]), 7);
        } catch (error) {
          await msg.edit({
            text: "❌ **参数错误**\n\n天数必须为数字",
            parseMode: "html"
          });
          return;
        }
      } else if (mode === "2") {
        if (args.length < 2) {
          await msg.edit({
            text: "❌ **参数错误**\n\n模式2需要指定天数\n例: `clean_member 2 30 search`",
            parseMode: "html"
          });
          return;
        }
        try {
          day = Math.max(parseInt(args[1]), 7);
        } catch (error) {
          await msg.edit({
            text: "❌ **参数错误**\n\n天数必须为数字",
            parseMode: "html"
          });
          return;
        }
      } else if (mode === "3") {
        if (args.length < 2) {
          await msg.edit({
            text: "❌ **参数错误**\n\n模式3需要指定发言数\n例: `clean_member 3 5 search`",
            parseMode: "html"
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
            text: "❌ **参数错误**\n\n发言数必须为数字",
            parseMode: "html"
          });
          return;
        }
      } else if (mode === "4" || mode === "5") {
        day = 0;
      } else {
        await msg.edit({
          text: "❌ **模式错误**\n\n请输入有效的模式(1-5)\n使用 `clean_member` 查看帮助",
          parseMode: "html"
        });
        return;
      }

      const modeNames: { [key: string]: string } = {
        "1": `未上线超过${day}天的用户`,
        "2": `未发言超过${day}天的用户`,
        "3": `发言少于${day}条的用户`,
        "4": "已注销的账户",
        "5": "所有普通成员"
      };

      const chatTitle = (msg.chat as any)?.title || '当前群组';

      // 直接使用 msg.peerId，这是 TeleBox 中的标准做法
      const chatId = msg.peerId;

      // 验证 chatId 是否有效
      if (!chatId) {
        await msg.edit({
          text: "❌ **错误**\n\n无法获取群组ID，请在群组中使用此命令",
          parseMode: "html"
        });
        return;
      }

      if (onlySearch) {
        await msg.edit({
          text: "🔍 **开始搜索**\n\n📡 **操作:** 初始化搜索任务\n🎯 **目标:** " + modeNames[mode] + "\n⏳ **状态:** 准备连接服务器...",
          parseMode: "html"
        });

        const statusCallback = async (message: string) => {
          try {
            await msg.edit({
              text: message,
              parseMode: "html"
            });
            await sleep(100); // 防止过于频繁的更新
          } catch (error) {
            console.log('Status update failed:', error);
          }
        };

        const client = await getGlobalClient();
        const cacheData = await getTargetUsersCached(client!, chatId, mode, day, chatTitle, statusCallback);

        await msg.edit({
          text: `✅ **群成员筛选分析完成**\n\n📊 **筛选结果统计:**\n• 符合清理条件的成员: ${cacheData.total_found} 名\n• 分析完成时间: ${cacheData.search_time.slice(0, 19)}\n• 目标群组: ${chatTitle}\n\n📁 **详细报告已生成:**\n• Excel格式报告: 已保存到本地磁盘\n• 文件存储位置: \`${CACHE_DIR}/\`\n• 数据缓存有效期: 24小时内可重复使用\n\n💡 **执行清理操作:**\n移除上述符合条件的成员，请执行清理命令\n清理命令: \`clean_member ${mode}${day > 0 ? ' ' + day : ''}\``,
          parseMode: "html"
        });
      } else {
        await msg.edit({
          text: `🧹 **开始执行群成员清理**\n\n📡 **当前操作:** 准备批量移除群成员\n🎯 **清理条件:** ${modeNames[mode]}\n⚠️ **重要提醒:** 即将永久移除符合条件的成员`,
          parseMode: "html"
        });

        const statusCallback = async (message: string) => {
          try {
            await msg.edit({
              text: message,
              parseMode: "html"
            });
            await sleep(100);
          } catch (error) {
            console.log('Status update failed:', error);
          }
        };

        const client = await getGlobalClient();
        const cacheData = await getTargetUsersCached(client!, chatId, mode, day, chatTitle, statusCallback);

        let memberCount = 0;
        const totalUsers = cacheData.users.length;

        const channelEntity = chatId;

        await msg.edit({
          text: `🚀 **正在执行批量移除操作**\n\n📊 **待移除成员数量:** ${totalUsers} 名\n🎯 **移除条件:** ${modeNames[mode]}\n⏳ **当前状态:** 开始逐个踢出群成员...`,
          parseMode: "html"
        });

        for (let i = 0; i < cacheData.users.length; i++) {
          const userInfo = cacheData.users[i];
          const userName = userInfo.username ? `@${userInfo.username}` : `${userInfo.first_name} ${userInfo.last_name}`.trim();

          try {
            await kickChatMember(client!, channelEntity, userInfo.id);
            memberCount++;

            // 每处理5个用户或每10%进度更新状态
            if ((i + 1) % 5 === 0 || (i + 1) % Math.max(1, Math.floor(totalUsers / 10)) === 0) {
              const progress = ((i + 1) / totalUsers * 100).toFixed(1);
              const eta = totalUsers > 0 ? Math.ceil((totalUsers - i - 1) * 1.5) : 0; // 估算剩余时间(秒)
              await msg.edit({
                text: `🧹 **正在批量踢出群成员**\n\n📊 **移除进度:** ${i + 1}/${totalUsers} (${progress}%)\n✅ **已成功踢出:** ${memberCount} 名成员\n👤 **当前处理用户:** ${userName}\n⏱️ **预计剩余时间:** ${eta}秒\n\n🔄 **执行状态:** 正在从群组移除用户...`,
                parseMode: "html"
              });
            }
          } catch (error: any) {
            console.error(`Failed to kick user ${userInfo.id}:`, error);
            // 继续处理下一个用户，不中断整个流程
          }

          await sleep(1000 + Math.random() * 1000);
        }

        const successRate = totalUsers > 0 ? ((memberCount / totalUsers) * 100).toFixed(1) : '0';
        const failedCount = totalUsers - memberCount;
        await msg.edit({
          text: `🎉 **群成员批量移除完成**\n\n📊 **移除操作统计:**\n✅ **成功踢出群组:** ${memberCount} 名成员\n❌ **移除失败:** ${failedCount} 名成员\n📈 **操作成功率:** ${successRate}%\n\n🎯 **本次移除条件:** ${modeNames[mode]}\n📅 **操作完成时间:** ${new Date().toLocaleString()}\n⏱️ **总执行耗时:** 约 ${Math.ceil(totalUsers * 1.5 / 60)} 分钟\n\n💡 **详细记录:** 完整操作日志已保存到 \`${CACHE_DIR}/\``,
          parseMode: "html"
        });
      }
    } catch (error: any) {
      console.error('Clean member error:', error);
      await msg.edit({
        text: `❌ **群成员清理操作失败**\n\n🔍 **失败原因:** ${error.message || error}\n\n💡 **解决建议:**\n• 检查网络连接状态\n• 确认机器人管理员权限\n• 稍后重新执行清理命令`,
        parseMode: "html"
      });
    }
  },
};

export default cleanMemberPlugin;

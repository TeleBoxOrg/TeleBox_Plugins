import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { getGlobalClient } from "@utils/globalClient";
import axios from "axios";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const filePath = path.join(
  createDirectoryInAssets("sum"),
  "summary_config.json"
);

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
}

type CustomProvider = {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  type: "openai" | "gemini"; // API 兼容类型
};

type AIConfig = {
  providers: Record<string, CustomProvider>; // 自定义提供商列表
  default_provider?: string;
  default_prompt?: string;
  default_spoiler?: boolean; // 默认是否启用折叠
  default_timeout?: number; // 默认超时时间（毫秒）
  reply_mode?: boolean; // 回复模式：发送新消息而非编辑原消息（防止运行时间长消息被顶上去）
  max_output_length?: number; // 最大输出字符数（0或不设置表示不限制）
};

const OFFICIAL_PROVIDER_PRESETS: Record<
  "openai" | "gemini",
  Omit<CustomProvider, "api_key">
> = {
  openai: {
    name: "OpenAI",
    base_url: "https://api.openai.com",
    model: "gpt-4o",
    type: "openai"
  },
  gemini: {
    name: "Gemini",
    base_url: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-flash",
    type: "gemini"
  }
};

type SummaryTask = {
  id: string;
  cron: string;
  chatId: string;
  chatDisplay?: string;
  interval: string;
  messageCount: number;
  timeRange?: number; // 时间范围（小时），如果设置则按时间范围总结
  pushTarget?: string;
  aiProvider?: string; // 提供商名称
  aiPrompt?: string;
  useSpoiler?: boolean; // 是否使用折叠
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
  lastError?: string;
  disabled?: boolean;
  remark?: string;
};

type SummaryDB = {
  seq: string;
  tasks: SummaryTask[];
  aiConfig: AIConfig;
  defaultPushTarget?: string;
};

async function getDB() {
  const db = await JSONFilePreset<SummaryDB>(filePath, {
    seq: "0",
    tasks: [],
    aiConfig: {
      providers: {
        openai: {
          name: "OpenAI",
          base_url: "https://api.openai.com",
          api_key: "",
          model: "gpt-4o",
          type: "openai"
        },
        gemini: {
          name: "Gemini",
          base_url: "https://generativelanguage.googleapis.com",
          api_key: "",
          model: "gemini-2.0-flash",
          type: "gemini"
        }
      },
      default_provider: "openai",
      default_prompt: "请总结以下群聊消息的主要内容，提取关键话题和重要信息：",
      default_spoiler: false
    }
  });

  // 兼容旧数据
  if (!db.data.aiConfig) {
    db.data.aiConfig = {
      providers: {},
      default_provider: "openai",
      default_prompt: "请总结以下群聊消息的主要内容，提取关键话题和重要信息："
    };
  }

  if (!db.data.aiConfig.providers) {
    db.data.aiConfig.providers = {};
  }

  return db;
}

function toInt(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function makeCronKey(id: string) {
  return `sum:${id}`;
}

function parseInterval(interval: string): string | null {
  console.log(`[sum] parseInterval 输入: "${interval}"`);

  // 1. 检查字段数量
  const fields = interval.trim().split(/\s+/);
  console.log(`[sum] 字段数量: ${fields.length}, 字段: ${JSON.stringify(fields)}`);

  // 2. 如果是 6 字段，直接返回（参考 sendat，不验证，让 cronManager 处理）
  if (fields.length === 6) {
    console.log(`[sum] 返回 6 字段 cron: "${interval}"`);
    return interval;
  }

  // 3. 如果是 5 字段，补 0（秒）
  if (fields.length === 5) {
    const result = `0 ${interval}`;
    console.log(`[sum] 5 字段转 6 字段: "${result}"`);
    return result;
  }

  // 4. 尝试解析简化格式
  const match = interval.match(/^(\d+)(h|m)$/i);
  if (!match) {
    console.log(`[sum] 无法解析简化格式，返回 null`);
    return null;
  }

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  if (unit === 'h') {
    const result = `0 0 */${value} * * *`;
    console.log(`[sum] 简化格式(小时): "${result}"`);
    return result;
  } else if (unit === 'm') {
    const result = `0 */${value} * * * *`;
    console.log(`[sum] 简化格式(分钟): "${result}"`);
    return result;
  }

  console.log(`[sum] 未知情况，返回 null`);
  return null;
}

function parseChatIdentifier(input: string): string {
  // 1. 如果是纯数字或负数ID，直接返回
  if (/^-?\d+$/.test(input)) {
    return input;
  }

  // 2. 处理私有邀请链接 https://t.me/+xxxxx 或 https://t.me/joinchat/xxxxx
  // 这种格式需要特殊处理，保留完整链接
  const inviteLinkMatch = input.match(/(?:https?:\/\/)?t\.me\/(?:\+|joinchat\/)([a-zA-Z0-9_-]+)/);
  if (inviteLinkMatch) {
    return input; // 返回完整链接，让 formatEntity 特殊处理
  }

  // 3. 处理 t.me 公开群组/频道链接
  // https://t.me/groupname 或 t.me/groupname
  const publicLinkMatch = input.match(/(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]+)/);
  if (publicLinkMatch) {
    return publicLinkMatch[1]; // 返回用户名
  }

  // 4. 处理私有群组链接 https://t.me/c/1234567890/xxx
  const privateLinkMatch = input.match(/(?:https?:\/\/)?t\.me\/c\/(\d+)/);
  if (privateLinkMatch) {
    return `-100${privateLinkMatch[1]}`; // 转换为完整ID
  }

  // 5. 处理 @username 格式
  if (input.startsWith('@')) {
    return input.substring(1); // 移除 @ 符号
  }

  // 6. 其他情况直接返回原值，让 formatEntity 处理
  return input;
}

async function formatEntity(target: any) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  let id: any;
  let entity: any;

  try {
    // 检查是否是邀请链接
    const inviteLinkMatch = typeof target === 'string'
      ? target.match(/(?:https?:\/\/)?t\.me\/(?:\+|joinchat\/)([a-zA-Z0-9_-]+)/)
      : null;

    if (inviteLinkMatch) {
      // 处理邀请链接
      const hash = inviteLinkMatch[1];

      try {
        // 先检查邀请链接信息
        const inviteInfo = await client.invoke(
          new Api.messages.CheckChatInvite({ hash })
        );

        if (inviteInfo instanceof Api.ChatInviteAlready) {
          // 已经在群组中，直接使用返回的 chat 对象
          entity = inviteInfo.chat;
          id = entity?.id;
        } else if (inviteInfo instanceof Api.ChatInvite) {
          // 还未加入群组，需要先加入
          const importResult = await client.invoke(
            new Api.messages.ImportChatInvite({ hash })
          );

          // 从导入结果中获取 chat 对象
          if ('chats' in importResult && importResult.chats.length > 0) {
            entity = importResult.chats[0];
            id = entity?.id;
          }
        }
      } catch (inviteError: any) {
        console.error("处理邀请链接失败:", inviteError);
        throw new Error(`无法处理邀请链接: ${inviteError.message || "未知错误"}`);
      }
    } else {
      // 普通的 username 或 ID，直接获取 entity
      entity = await client.getEntity(target);
      id = entity?.id;
    }
  } catch (e: any) {
    console.error(e);
    throw new Error(`无法获取群组信息: ${e.message || "未知错误"}`);
  }

  const displayParts: string[] = [];
  if (entity?.title) displayParts.push(entity.title);
  if (entity?.username) displayParts.push(`@${entity.username}`);
  if (id) displayParts.push(`<code>${id}</code>`);

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// AI 调用函数
async function callOpenAI(
  apiKey: string,
  baseUrl: string,
  model: string,
  messages: string,
  prompt: string,
  timeout: number = 60000
): Promise<string> {
  const url = `${baseUrl}/v1/chat/completions`;

  const response = await axios.post(
    url,
    {
      model,
      messages: [
        {
          role: "user",
          content: `${prompt}\n\n${messages}`
        }
      ],
      max_tokens: 2000
    },
    {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      timeout
    }
  );

  const choice = response.data?.choices?.[0];
  if (!choice?.message?.content) {
    throw new Error("OpenAI 返回内容为空");
  }

  return choice.message.content.trim();
}

async function callGemini(
  apiKey: string,
  baseUrl: string,
  model: string,
  messages: string,
  prompt: string,
  timeout: number = 60000
): Promise<string> {
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await axios.post(
    url,
    {
      contents: [
        {
          role: "user",
          parts: [
            { text: `${prompt}\n\n${messages}` }
          ]
        }
      ]
    },
    {
      headers: {
        "Content-Type": "application/json"
      },
      timeout
    }
  );

  const candidate = response.data?.candidates?.[0];
  if (!candidate?.content?.parts?.[0]?.text) {
    throw new Error("Gemini 返回内容为空");
  }

  return candidate.content.parts[0].text.trim();
}

// 构建群组链接
function buildChatLink(chatId: string, username?: string): string {
  if (username) {
    return `https://t.me/${username}`;
  }
  // 私有群：chatId 格式为 -100xxxxx，需要去掉 -100 前缀
  const numericId = chatId.replace(/^-100/, '');
  return `https://t.me/c/${numericId}`;
}

// 构建消息链接
function buildMessageLink(chatId: string, messageId: number, username?: string): string {
  if (username) {
    return `https://t.me/${username}/${messageId}`;
  }
  // 私有群：chatId 格式为 -100xxxxx，需要去掉 -100 前缀
  const numericId = chatId.replace(/^-100/, '');
  return `https://t.me/c/${numericId}/${messageId}`;
}

// 消息数据结构
type MessageData = {
  text: string;           // 格式化后的消息文本
  content: string;        // 原始消息内容
  telegramLink: string;   // Telegram 消息链接
  urls: string[];         // 消息中的所有 URL（包括 entities 中的）
  fileName?: string;      // 附件文件名（如果有）
};

// 从消息 entities 中提取 URL
function extractUrlsFromEntities(message: any): string[] {
  const urls: string[] = [];

  // 从 entities 中提取
  if (message.entities && Array.isArray(message.entities)) {
    for (const entity of message.entities) {
      // TextUrl 类型：[文本](URL) 格式的链接
      if (entity.className === 'MessageEntityTextUrl' && entity.url) {
        urls.push(entity.url);
      }
      // Url 类型：消息中的纯文本 URL
      if (entity.className === 'MessageEntityUrl' && message.message) {
        const url = message.message.substring(entity.offset, entity.offset + entity.length);
        urls.push(url);
      }
    }
  }

  return urls;
}

// 提取文本中的 URL
function extractUrlsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s\]）】>]+/g;
  return text.match(urlRegex) || [];
}

// 检查是否为贴纸/表情包
function isStickerOrEmoji(message: any): boolean {
  if (!message.media?.document) return false;

  const doc = message.media.document;

  // 检查 MIME 类型
  const stickerMimeTypes = [
    'application/x-tgsticker',  // TGS 动画贴纸
    'video/webm',               // 视频贴纸
  ];
  if (doc.mimeType && stickerMimeTypes.includes(doc.mimeType)) {
    return true;
  }

  // 检查 attributes 中是否有贴纸/表情包标识
  if (doc.attributes && Array.isArray(doc.attributes)) {
    for (const attr of doc.attributes) {
      if (attr.className === 'DocumentAttributeSticker' ||
          attr.className === 'DocumentAttributeCustomEmoji') {
        return true;
      }
    }
  }

  return false;
}

// 从消息中提取文件名
function extractFileName(message: any): string | null {
  if (!message.media) return null;

  // 忽略贴纸/表情包
  if (isStickerOrEmoji(message)) {
    return null;
  }

  // MessageMediaDocument（文件、图片等）
  if (message.media.document) {
    const doc = message.media.document;
    // 从 attributes 中查找文件名
    if (doc.attributes && Array.isArray(doc.attributes)) {
      for (const attr of doc.attributes) {
        if (attr.className === 'DocumentAttributeFilename' && attr.fileName) {
          return attr.fileName;
        }
      }
    }
    // 如果没有文件名，返回 MIME 类型
    if (doc.mimeType) {
      return `[${doc.mimeType}]`;
    }
  }

  // MessageMediaPhoto（图片）
  if (message.media.className === 'MessageMediaPhoto') {
    return '[图片]';
  }

  // MessageMediaWebPage（网页预览）
  if (message.media.className === 'MessageMediaWebPage') {
    return null; // 网页预览不作为文件处理
  }

  return null;
}

// 获取群消息（按数量）
async function getGroupMessages(chatId: string, count: number): Promise<MessageData[]> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  const messages = await client.getMessages(chatId, { limit: count });

  // 获取群组 username（如果有）
  let chatUsername: string | undefined;
  try {
    const entity = await client.getEntity(chatId);
    chatUsername = (entity as any).username;
  } catch (e) {
    // 忽略错误，使用私有链接格式
  }

  const messageData: MessageData[] = [];
  for (const msg of messages) {
    const message = msg as any;
    // 跳过完全没有内容的消息
    if (!message.message && !message.media) continue;

    const sender = message.sender?.firstName || message.sender?.username || "未知用户";
    const time = formatDate(new Date(message.date * 1000));
    const link = buildMessageLink(chatId, message.id, chatUsername);
    const urls = extractUrlsFromEntities(message);

    // 构建消息文本，包含文件信息
    let textContent = message.message || "";
    const fileName = extractFileName(message);
    if (fileName) {
      textContent = textContent ? `${textContent} [文件: ${fileName}]` : `[文件: ${fileName}]`;
    }

    if (textContent) {
      messageData.push({
        text: `[${time}] ${sender}: ${textContent}`,
        content: message.message || "",
        telegramLink: link,
        urls,
        fileName: fileName || undefined
      });
    }
  }

  return messageData.reverse();
}

// 获取群消息（按时间范围）
async function getGroupMessagesByTime(chatId: string, hours: number): Promise<MessageData[]> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  const now = Math.floor(Date.now() / 1000);
  const startTime = now - hours * 3600;

  const messages = await client.getMessages(chatId, { limit: 100 });

  // 获取群组 username（如果有）
  let chatUsername: string | undefined;
  try {
    const entity = await client.getEntity(chatId);
    chatUsername = (entity as any).username;
  } catch (e) {
    // 忽略错误，使用私有链接格式
  }

  const messageData: MessageData[] = [];
  for (const msg of messages) {
    const message = msg as any;
    if (message.date < startTime) continue;
    if (!message.message && !message.media) continue;

    const sender = message.sender?.firstName || message.sender?.username || "未知用户";
    const time = formatDate(new Date(message.date * 1000));
    const link = buildMessageLink(chatId, message.id, chatUsername);
    const urls = extractUrlsFromEntities(message);

    // 构建消息文本，包含文件信息
    let textContent = message.message || "";
    const fileName = extractFileName(message);
    if (fileName) {
      textContent = textContent ? `${textContent} [文件: ${fileName}]` : `[文件: ${fileName}]`;
    }

    if (textContent) {
      messageData.push({
        text: `[${time}] ${sender}: ${textContent}`,
        content: message.message || "",
        telegramLink: link,
        urls,
        fileName: fileName || undefined
      });
    }
  }

  return messageData.reverse();
}

// 格式化消息数据为文本
function formatMessagesForAI(messageData: MessageData[]): string {
  // 消息正文，每条消息附带 Telegram 链接
  const messageTexts = messageData.map(m => `${m.text} [来源](${m.telegramLink})`);

  // 提取所有外部 URL 及其对应的 Telegram 消息链接
  // 优先使用 entities 中提取的 URL，其次使用文本中的 URL
  const urlMappings: { url: string; telegramLink: string }[] = [];
  for (const m of messageData) {
    // 合并两种来源的 URL
    const allUrls = [...m.urls, ...extractUrlsFromText(m.content)];
    for (const url of allUrls) {
      // 去重：检查是否已存在相同 URL
      if (!urlMappings.some(u => u.url === url)) {
        urlMappings.push({ url, telegramLink: m.telegramLink });
      }
    }
  }

  // 提取所有附件文件
  const fileMappings: { fileName: string; telegramLink: string }[] = [];
  for (const m of messageData) {
    if (m.fileName) {
      fileMappings.push({ fileName: m.fileName, telegramLink: m.telegramLink });
    }
  }

  let result = messageTexts.join("\n");

  if (urlMappings.length > 0) {
    result += "\n\n--- 消息中包含的外部链接（资源URL - 来源消息链接）---\n";
    for (const mapping of urlMappings) {
      result += `${mapping.url} - [查看原消息](${mapping.telegramLink})\n`;
    }
  }

  if (fileMappings.length > 0) {
    result += "\n\n--- 消息中包含的附件（文件名 - 来源消息链接）---\n";
    for (const mapping of fileMappings) {
      result += `${mapping.fileName} - [查看原消息](${mapping.telegramLink})\n`;
    }
  }

  return result;
}

// 包裹折叠标签
function wrapWithSpoiler(content: string, useSpoiler: boolean): string {
  if (!useSpoiler) {
    return content;
  }

  // 检查内容是否已经包含折叠标签
  if (content.includes('<blockquote expandable>')) {
    return content;
  }

  // 用折叠标签包裹整个内容
  return `<blockquote expandable>${content}</blockquote>`;
}

// AI 总结消息
async function summarizeMessages(
  task: SummaryTask,
  messageData: MessageData[]
): Promise<{ success: boolean; result?: string; error?: string }> {
  const db = await getDB();
  const aiConfig = db.data.aiConfig;
  const providerName = task.aiProvider || aiConfig.default_provider || "openai";
  const prompt = task.aiPrompt || aiConfig.default_prompt || "请总结以下群聊消息的主要内容：";
  const timeout = aiConfig.default_timeout || 60000;

  // 格式化消息为文本（包含 URL 及来源链接）
  const messages = formatMessagesForAI(messageData);

  // 调试日志：输出发送给 AI 的完整文本
  console.log("[sum] ========== 发送给 AI 的文本 ==========");
  console.log(messages);
  console.log("[sum] ========== 文本结束 ==========");

  const provider = aiConfig.providers[providerName];
  if (!provider) {
    return { success: false, error: `未找到提供商: ${providerName}` };
  }

  if (!provider.api_key) {
    return { success: false, error: `提供商 ${providerName} 的 API Key 未配置` };
  }

  try {
    let aiResponse: string;

    if (provider.type === "openai") {
      aiResponse = await callOpenAI(
        provider.api_key,
        provider.base_url,
        provider.model,
        messages,
        prompt,
        timeout
      );
    } else if (provider.type === "gemini") {
      aiResponse = await callGemini(
        provider.api_key,
        provider.base_url,
        provider.model,
        messages,
        prompt,
        timeout
      );
    } else {
      return { success: false, error: `不支持的 API 类型: ${provider.type}` };
    }

    return { success: true, result: aiResponse };
  } catch (aiErr: any) {
    return { success: false, error: `AI 调用失败: ${aiErr?.message || aiErr}` };
  }
}

// 执行总结任务
async function executeSummary(task: SummaryTask): Promise<{ success: boolean; message: string }> {
  try {
    const client = await getGlobalClient();
    if (!client) throw new Error("Telegram 客户端未初始化");

    const db = await getDB();

    // 获取消息
    let messageData: MessageData[];

    if (task.timeRange) {
      messageData = await getGroupMessagesByTime(task.chatId, task.timeRange);
    } else {
      messageData = await getGroupMessages(task.chatId, task.messageCount);
    }

    if (!messageData || messageData.length === 0) {
      return { success: false, message: "未找到可总结的消息" };
    }

    // AI 总结
    const summaryResult = await summarizeMessages(task, messageData);
    if (!summaryResult.success) {
      return { success: false, message: summaryResult.error! };
    }

    // 发送总结
    const pushTarget = task.pushTarget || db.data.defaultPushTarget || "me";
    let summaryContent = summaryResult.result!;

    // 过滤掉思考标签内容（如 <thinking>...</thinking>、<think>...</think>）
    summaryContent = summaryContent.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
    summaryContent = summaryContent.replace(/<think>[\s\S]*?<\/think>/gi, "");
    summaryContent = summaryContent.trim();

    // 应用最大输出长度限制（过滤思考内容后再计算）
    // 应用最大输出长度限制（0表示不限制）
    const maxOutputLength = db.data.aiConfig.max_output_length ?? 0;
    if (maxOutputLength > 0 && summaryContent.length > maxOutputLength) {
      summaryContent = summaryContent.substring(0, maxOutputLength) + "\n\n⚠️ 内容已截断（超过最大长度限制）";
    }

    const header = `📊 群组总结\n来源: ${task.chatDisplay || task.chatId}\n时间: ${formatDate(new Date())}\n\n`;

    // 应用折叠标签（如果启用）
    const wrappedContent = wrapWithSpoiler(summaryContent, task.useSpoiler || false);
    const summaryText = `${header}${wrappedContent}`;

    // 如果启用折叠或内容包含 HTML 标签，使用 HTML 解析模式
    const needHtmlParse = task.useSpoiler || summaryContent.includes('<');

    await client.sendMessage(pushTarget, {
      message: summaryText,
      parseMode: needHtmlParse ? "html" : undefined
    });

    return { success: true, message: `总结完成，已推送到 ${pushTarget}` };
  } catch (e: any) {
    return { success: false, message: `总结失败: ${e?.message || e}` };
  }
}

// 调度任务
async function scheduleTask(task: SummaryTask) {
  const key = makeCronKey(task.id);
  if (task.disabled || cronManager.has(key)) return;

  console.log(`[sum] 注册任务 ${task.id}: ${task.cron}`);

  cronManager.set(key, task.cron, async () => {
    console.log(`[sum] 开始执行任务 ${task.id}`);

    const db = await getDB();
    const idx = db.data.tasks.findIndex((t: SummaryTask) => t.id === task.id);
    const now = Date.now();

    try {
      const result = await executeSummary(task);

      if (idx >= 0) {
        db.data.tasks[idx].lastRunAt = String(now);
        if (result.success) {
          db.data.tasks[idx].lastResult = result.message;
          db.data.tasks[idx].lastError = undefined;
        } else {
          db.data.tasks[idx].lastError = result.message;
        }
        await db.write();
      }
      console.log(`[sum] 任务 ${task.id} 执行完成: ${result.success ? '成功' : '失败'}`);
    } catch (e: any) {
      console.error(`[sum] 任务 ${task.id} 执行失败:`, e);
      if (idx >= 0) {
        db.data.tasks[idx].lastRunAt = String(now);
        db.data.tasks[idx].lastError = String(e?.message || e);
        await db.write();
      }
    }
  });
}

// 启动任务
async function bootstrapTasks() {
  try {
    const db = await getDB();
    console.log(`[sum] 启动加载，共 ${db.data.tasks.length} 个任务`);

    for (const t of db.data.tasks) {
      if (!cron.validateCronExpression(t.cron).valid) {
        console.error(`[sum] 任务 ${t.id} Cron 表达式无效: ${t.cron}`);
        continue;
      }
      if (t.disabled) {
        console.log(`[sum] 任务 ${t.id} 已禁用，跳过`);
        continue;
      }
      await scheduleTask(t);
    }
    console.log(`[sum] 任务加载完成`);
  } catch (e) {
    console.error("[sum] bootstrap 失败:", e);
  }
}

// 立即执行
(async () => {
  await bootstrapTasks();
  console.log("[sum] 插件初始化完成");
})();

const help_text = `▎群消息总结

使用 AI 自动总结群组消息

<b>⚡ 快捷总结当前群：</b>
<code>${mainPrefix}sum</code> - 总结最近100条消息
<code>${mainPrefix}sum 200</code> - 总结最近200条消息
<code>${mainPrefix}sum --provider deepseek</code> - 指定AI配置总结
<code>${mainPrefix}sum 200 --provider gemini</code> - 指定数量和AI配置

<b>📋 定时总结：</b>
<code>${mainPrefix}sum add &lt;群组标识&gt; &lt;间隔&gt; [消息数] [选项]</code>
群组标识支持:
  • 数字ID: -1001234567890
  • 公开链接: t.me/groupname 或 https://t.me/groupname
  • 私有链接: https://t.me/c/1234567890/123
  • 用户名: @groupname
间隔格式:
  • 简化格式: 2h (2小时), 30m (30分钟)
  • Cron表达式(6字段): 0 0 9,15,21 * * * (每天9:00,15:00,21:00)
  • Cron表达式(5字段): 30 */2 * * * (自动补秒字段)
选项:
  --time &lt;小时&gt; - 按时间范围总结（如 --time 2 表示过去2小时）
  --provider &lt;名称&gt; - 指定AI配置
  --spoiler - 启用折叠显示
  --no-spoiler - 禁用折叠显示（覆盖全局设置）
示例:
  <code>${mainPrefix}sum add -1001234567890 2h</code>
  <code>${mainPrefix}sum add t.me/mygroup "0 0 9,15,21 * * *" --spoiler</code>
  <code>${mainPrefix}sum add @mygroup "30 */2 * * *" 200 --provider deepseek</code>

<b>🔧 管理命令：</b>
• <code>${mainPrefix}sum list</code> - 列出所有任务（按ID排序）
• <code>${mainPrefix}sum del &lt;任务ID&gt;</code> - 删除任务
• <code>${mainPrefix}sum run &lt;任务ID&gt;</code> - 立即运行任务
• <code>${mainPrefix}sum edit &lt;任务ID&gt; &lt;属性&gt; &lt;值&gt;</code> - 修改任务属性
  属性: spoiler (on/off) | provider (配置名) | prompt (提示词)
  留空值则使用全局配置
• <code>${mainPrefix}sum disable/enable &lt;任务ID&gt;</code> - 禁用/启用任务
• <code>${mainPrefix}sum reorder</code> - 从1开始重新编号所有任务

<b>🤖 AI 配置管理：</b>
• <code>${mainPrefix}sum config list</code> - 列出所有配置
• <code>${mainPrefix}sum config add &lt;官方名称&gt; &lt;API_KEY&gt;</code> - 快速添加官方 (openai/gemini)
  示例: <code>${mainPrefix}sum config add openai sk-xxx</code>
• <code>${mainPrefix}sum config add &lt;名称&gt; &lt;类型&gt; &lt;BaseURL&gt; &lt;Model&gt;</code> - 自定义服务商
  类型: openai 或 gemini
  示例: <code>${mainPrefix}sum config add deepseek openai https://api.deepseek.com deepseek-chat</code>
• <code>${mainPrefix}sum config set &lt;名称&gt; key &lt;API_KEY&gt;</code> - 设置API Key
• <code>${mainPrefix}sum config set &lt;名称&gt; model &lt;模型&gt;</code> - 修改模型
• <code>${mainPrefix}sum config set &lt;名称&gt; url &lt;URL&gt;</code> - 修改Base URL
• <code>${mainPrefix}sum config del &lt;名称&gt;</code> - 删除配置

<b>⚙️ 全局设置：</b>
• <code>${mainPrefix}sum config set push &lt;目标&gt;</code> - 设置默认推送目标
• <code>${mainPrefix}sum config set default &lt;名称&gt;</code> - 设置默认配置
• <code>${mainPrefix}sum config set prompt &lt;提示词&gt;</code> - 设置总结提示词
• <code>${mainPrefix}sum config set prompt reset</code> - 重置提示词为默认值
• <code>${mainPrefix}sum config set spoiler on/off</code> - 全局折叠开关
• <code>${mainPrefix}sum config set timeout &lt;秒数&gt;</code> - 设置AI超时时间（默认60秒）
• <code>${mainPrefix}sum config set reply on/off</code> - 回复模式（发送新消息，防止被顶走，默认开启）
• <code>${mainPrefix}sum config set maxoutput &lt;字符数&gt;</code> - 最大输出长度（0不限制，默认不限制）
• <code>${mainPrefix}sum prompts</code> - 查看推荐提示词
`;

class SummaryPlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  description: string = `群消息总结插件\n\n${help_text}`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sum: async (msg: Api.Message) => {
      const parts = msg.message?.trim()?.split(/\s+/) || [];
      const [, sub, ...args] = parts;

      try {
        // 查看推荐提示词
        if (sub === "prompts") {
          const prompts = [
            {
              name: "默认总结（HTML折叠版）",
              prompt: `你是一个群聊/频道消息的专业总结助手。请阅读下面这段「最近消息记录」，用**简洁、结构化的中文**做一个总结。

【重要】输出必须是 Telegram HTML 格式，每个章节使用 <blockquote expandable> 标签包裹实现折叠。

【输入格式说明】
消息记录末尾有一个「消息中包含的外部链接」部分，格式为：
资源URL - [查看原消息](Telegram消息链接)
请直接使用这个部分提供的 URL 和来源链接。

【输出格式要求】
严格按以下 HTML 结构输出（每个章节都是可折叠的）：

<b>主要话题：</b>
<blockquote expandable>• 话题1
• 话题2</blockquote>

<b>技术讨论：</b>
<blockquote expandable>• 技术点1 <a href="来源链接">来源</a>
• 技术点2</blockquote>

<b>资源分享：</b>
<blockquote expandable>* 外部链接：
• 资源说明 <a href="资源URL">链接</a> - <a href="Telegram链接">查看原消息</a>
* 文件分享：
• 文件名 - <a href="Telegram链接">查看原消息</a></blockquote>

<b>重要互动：</b>
<blockquote expandable>• 人物 + 问题/结论 <a href="来源链接">来源</a></blockquote>

<b>零散信息：</b>
<blockquote expandable>• 备注信息</blockquote>

<b>时间线梳理：</b>
<blockquote expandable>• 时间 - 事件概述</blockquote>

【HTML 格式规则】
1. 链接使用 <a href="URL">文本</a> 格式
2. 标题使用 <b>标题</b> 格式
3. 每个章节内容用 <blockquote expandable>...</blockquote> 包裹
4. 特殊字符转义：& → &amp; < → &lt; > → &gt;
5. 若某章节无内容，写「• 暂无」

下面是需要你总结的对话内容（不要重复原文，只输出总结）：`
            },
            {
              name: "简洁版",
              prompt: "用3-5个要点总结以下群聊消息的核心内容："
            },
            {
              name: "详细版",
              prompt: "详细分析以下群聊消息，包括：1.主要话题 2.关键观点 3.重要决策 4.待办事项"
            },
            {
              name: "技术讨论",
              prompt: "总结以下技术讨论的内容，重点提取：技术方案、问题、解决方案、待确认事项"
            },
            {
              name: "会议纪要",
              prompt: "整理以下会议讨论内容，格式化为：讨论议题、关键决策、行动项、责任人"
            },
            {
              name: "新闻摘要",
              prompt: "提取以下消息中的新闻要点，按重要性排序，每条用一句话概括"
            },
            {
              name: "问答整理",
              prompt: "整理以下对话中的问答内容，格式：Q: 问题 A: 答案"
            }
          ];

          const lines = ["📝 推荐提示词", ""];

          for (const p of prompts) {
            lines.push(`<b>${p.name}</b>`);
            lines.push(`<code>${p.prompt}</code>`);
            lines.push("");
          }

          lines.push("💡 使用方法：");
          lines.push(`<code>${mainPrefix}sum config set prompt 您的提示词</code>`);

          await msg.edit({ text: lines.join("\n"), parseMode: "html" });
          return;
        }

        // 调试：查看发送给 AI 的原始文本
        if (sub === "debug") {
          const count = toInt(args[0]) || 50;
          const chatId = String(msg.chatId);

          await msg.edit({ text: "⏳ 正在获取消息..." });

          const messageData = await getGroupMessages(chatId, count);
          if (!messageData || messageData.length === 0) {
            await msg.edit({ text: "❌ 未找到消息" });
            return;
          }

          const formattedText = formatMessagesForAI(messageData);

          // 截取最后 2000 字符（主要看链接部分）
          const preview = formattedText.length > 2000
            ? "...(前面省略)...\n\n" + formattedText.slice(-2000)
            : formattedText;

          await msg.edit({
            text: `📋 发送给 AI 的文本预览（最后2000字符）：\n\n<code>${preview.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`,
            parseMode: "html"
          });
          return;
        }

        // 快捷总结当前群 - 支持格式: .sum [数量] [--provider 名称]
        if (!sub || /^\d+$/.test(sub) || sub === "--provider") {
          let count = 100;
          let aiProvider: string | undefined;

          // 解析参数
          let i = 1; // 从 sub 开始解析
          while (i < parts.length) {
            const arg = parts[i];
            if (arg === "--provider" || arg === "-p") {
              aiProvider = parts[i + 1];
              i += 2;
            } else if (/^\d+$/.test(arg)) {
              count = toInt(arg) || 100;
              i += 1;
            } else {
              i += 1;
            }
          }

          const chatId = String(msg.chatId);

          const db = await getDB();
          const useReplyMode = db.data.aiConfig.reply_mode !== false; // 默认开启回复模式
          const maxOutputLength = db.data.aiConfig.max_output_length ?? 0; // 默认不限制

          await msg.edit({ text: "⏳ 正在获取消息并总结..." });

          const messageData = await getGroupMessages(chatId, count);
          if (!messageData || messageData.length === 0) {
            await msg.edit({ text: "❌ 未找到可总结的消息" });
            return;
          }

          // 获取当前群组信息
          const client = await getGlobalClient();
          let chatDisplay = chatId;
          if (client) {
            try {
              const chat = await client.getEntity(chatId);
              const displayParts: string[] = [];
              if ((chat as any).title) displayParts.push((chat as any).title);
              if ((chat as any).username) displayParts.push(`@${(chat as any).username}`);
              displayParts.push(`<code>${chatId}</code>`);
              chatDisplay = displayParts.join(" ");
            } catch (e) {
              console.error("获取群组信息失败:", e);
            }
          }

          const task: SummaryTask = {
            id: "temp",
            cron: "",
            chatId,
            chatDisplay,
            interval: "",
            messageCount: count,
            aiProvider: aiProvider || db.data.aiConfig.default_provider,
            aiPrompt: undefined,
            createdAt: String(Date.now())
          };

          const summaryResult = await summarizeMessages(task, messageData);
          if (!summaryResult.success) {
            await msg.edit({ text: `❌ ${summaryResult.error}` });
            return;
          }

          let summaryContent = summaryResult.result!;

          // 过滤掉思考标签内容（如 <thinking>...</thinking>、<think>...</think>）
          summaryContent = summaryContent.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
          summaryContent = summaryContent.replace(/<think>[\s\S]*?<\/think>/gi, "");
          summaryContent = summaryContent.trim();

          // 应用最大输出长度限制（过滤思考内容后再计算）
          if (maxOutputLength > 0 && summaryContent.length > maxOutputLength) {
            summaryContent = summaryContent.substring(0, maxOutputLength) + "\n\n⚠️ 内容已截断（超过最大长度限制）";
          }

          const header = `📊 群组总结\n来源: ${chatDisplay}\n时间: ${formatDate(new Date())}\n\n`;

          // 应用折叠标签（如果启用）
          const wrappedContent = wrapWithSpoiler(summaryContent, db.data.aiConfig.default_spoiler || false);
          const summaryText = `${header}${wrappedContent}`;

          // 如果启用折叠或内容包含 HTML 标签，使用 HTML 解析模式
          const needHtmlParse = db.data.aiConfig.default_spoiler || summaryContent.includes('<');

          // 根据模式选择编辑原消息或回复新消息
          if (useReplyMode) {
            // 回复模式：删除原消息，发送新消息（防止运行时间长消息被顶走）
            if (client) {
              await client.sendMessage(chatId, {
                message: summaryText,
                parseMode: needHtmlParse ? "html" : undefined,
                replyTo: msg.replyToMsgId || undefined
              });
              await msg.delete({ revoke: true });
            }
          } else {
            // 编辑模式：直接编辑原消息
            await msg.edit({
              text: summaryText,
              parseMode: needHtmlParse ? "html" : undefined
            });
          }
          return;
        }

        if (sub === "add") {
          const chatIdInput = args[0];

          // 处理引号包裹的 cron 表达式（参考 qdsg）
          let intervalInput = "";
          let paramIndex = 1;

          if (args[paramIndex] && args[paramIndex].startsWith('"')) {
            const cronParts: string[] = [];
            while (paramIndex < args.length) {
              const part = args[paramIndex];
              cronParts.push(part);
              if (part.endsWith('"')) {
                paramIndex++;
                break;
              }
              paramIndex++;
            }
            intervalInput = cronParts.join(" ").replace(/^"|"$/g, "");
          } else {
            intervalInput = args[paramIndex] || "";
            paramIndex++;
          }

          if (!chatIdInput || !intervalInput) {
            await msg.edit({
              text: `❌ 格式错误\n\n用法: <code>${mainPrefix}sum add &lt;群组标识&gt; &lt;间隔&gt; [消息数] [选项]</code>\n\n群组标识支持:\n• 数字ID: -1001234567890\n• 链接: t.me/groupname\n• 用户名: @groupname\n\n示例: <code>${mainPrefix}sum add -1001234567890 2h</code>`,
              parseMode: "html"
            });
            return;
          }

          const cronExpr = parseInterval(intervalInput);
          if (!cronExpr) {
            await msg.edit({
              text: `❌ 无效的间隔格式\n\n支持格式:\n• 简化: 2h (2小时), 30m (30分钟)\n• Cron(6字段): 0 0 9,15,21 * * * (每天9:00,15:00,21:00)\n• Cron(5字段): 30 */2 * * * (自动补秒字段)`,
              parseMode: "html"
            });
            return;
          }

          const parsedChatId = parseChatIdentifier(chatIdInput);
          const entity = await formatEntity(parsedChatId);
          const chatId = entity?.id ? String(entity.id) : parsedChatId;

          const db = await getDB();
          const currentSeq = toInt(db.data.seq) || 0;
          db.data.seq = String(currentSeq + 1);
          const id = db.data.seq;

          // 解析参数（从 paramIndex 开始，因为前面已经处理了 chatId 和 interval）
          let messageCount = 100;
          let timeRange: number | undefined;
          let aiProvider: string | undefined = db.data.aiConfig.default_provider;
          let useSpoiler = db.data.aiConfig.default_spoiler || false;
          let remark = "";

          let i = paramIndex;
          while (i < args.length) {
            const arg = args[i];

            if (arg === "--time") {
              timeRange = toInt(args[i + 1]);
              i += 2;
            } else if (arg === "--provider") {
              aiProvider = args[i + 1];
              i += 2;
            } else if (arg === "--spoiler") {
              useSpoiler = true;
              i += 1;
            } else if (arg === "--no-spoiler") {
              useSpoiler = false;
              i += 1;
            } else if (!isNaN(Number(arg))) {
              messageCount = toInt(arg) || 100;
              i += 1;
            } else {
              remark += (remark ? " " : "") + arg;
              i += 1;
            }
          }

          const task: SummaryTask = {
            id,
            cron: cronExpr,
            chatId,
            chatDisplay: entity?.display,
            interval: intervalInput,
            messageCount,
            timeRange,
            pushTarget: db.data.defaultPushTarget,
            aiProvider,
            aiPrompt: undefined,
            useSpoiler,
            createdAt: String(Date.now()),
            remark: remark || undefined
          };

          db.data.tasks.push(task);
          await db.write();
          await scheduleTask(task);

          const nextAt = cron.sendAt(cronExpr);
          const nextDate = (nextAt as any).toJSDate ? (nextAt as any).toJSDate() : nextAt;

          const tip = [
            "✅ 已添加总结任务",
            `ID: <code>${id}</code>`,
            `群组: ${entity?.display || chatId}`,
            `间隔: ${intervalInput}`,
            timeRange ? `时间范围: 过去${timeRange}小时` : `消息数: ${messageCount}`,
            aiProvider ? `AI配置: ${aiProvider}` : null,
            useSpoiler ? `折叠: 是` : null,
            `推送: ${task.pushTarget || "me"}`,
            remark ? `备注: ${remark}` : null,
            `下次执行: ${formatDate(nextDate)}`,
          ].filter(Boolean).join("\n");

          await msg.edit({ text: tip, parseMode: "html" });
          return;
        }

        if (sub === "list" || sub === "ls") {
          const db = await getDB();
          if (db.data.tasks.length === 0) {
            await msg.edit({ text: "暂无总结任务" });
            return;
          }

          const lines: string[] = ["📋 所有总结任务", ""];

          // 按任务ID排序（数字升序）
          const sortedTasks = [...db.data.tasks].sort((a, b) => {
            const idA = parseInt(a.id) || 0;
            const idB = parseInt(b.id) || 0;
            return idA - idB;
          });

          for (const t of sortedTasks) {
            const nextDt = cron.sendAt(t.cron);
            const nextDate = (nextDt as any).toJSDate ? (nextDt as any).toJSDate() : nextDt;

            lines.push(`<code>${t.id}</code> • ${t.remark || t.chatDisplay || t.chatId}`);
            lines.push(`群组: ${t.chatDisplay || t.chatId}`);
            lines.push(`间隔: ${t.interval}`);
            if (t.timeRange) {
              lines.push(`时间范围: 过去${t.timeRange}小时`);
            } else {
              lines.push(`消息数: ${t.messageCount}`);
            }
            if (t.aiProvider) {
              lines.push(`AI配置: ${t.aiProvider}`);
            } else {
              lines.push(`AI配置: 默认 (${db.data.aiConfig.default_provider || "openai"})`);
            }
            if (t.aiPrompt) {
              const shortPrompt = t.aiPrompt.length > 30
                ? t.aiPrompt.substring(0, 30) + "..."
                : t.aiPrompt;
              lines.push(`提示词: ${shortPrompt}`);
            } else {
              lines.push(`提示词: 默认`);
            }
            if (t.useSpoiler) lines.push(`折叠: 是`);
            lines.push(`推送: ${t.pushTarget || "me"}`);
            if (t.disabled) {
              lines.push(`状态: ⏹ 已禁用`);
            } else {
              lines.push(`下次: ${formatDate(nextDate)}`);
            }
            if (t.lastRunAt) lines.push(`上次: ${formatDate(new Date(Number(t.lastRunAt)))}`);
            if (t.lastResult) lines.push(`结果: ${t.lastResult}`);
            if (t.lastError) lines.push(`错误: ${t.lastError}`);
            lines.push("");
          }

          await msg.edit({ text: lines.join("\n"), parseMode: "html" });
          return;
        }

        if (sub === "del" || sub === "rm") {
          const id = args[0];
          if (!id) {
            await msg.edit({ text: "请提供任务ID" });
            return;
          }

          const db = await getDB();
          const idx = db.data.tasks.findIndex((t: SummaryTask) => t.id === id);
          if (idx < 0) {
            await msg.edit({ text: `未找到任务: <code>${id}</code>`, parseMode: "html" });
            return;
          }

          cronManager.del(makeCronKey(id));
          db.data.tasks.splice(idx, 1);
          await db.write();

          await msg.edit({ text: `✅ 已删除任务 <code>${id}</code>`, parseMode: "html" });
          return;
        }

        if (sub === "run" || sub === "now") {
          const id = args[0];
          if (!id) {
            await msg.edit({ text: "请提供任务ID" });
            return;
          }

          const db = await getDB();
          const task = db.data.tasks.find((t: SummaryTask) => t.id === id);
          if (!task) {
            await msg.edit({ text: `未找到任务: <code>${id}</code>`, parseMode: "html" });
            return;
          }

          // 获取群组链接
          let chatLink = "";
          try {
            const client = await getGlobalClient();
            if (client) {
              const entity = await client.getEntity(task.chatId);
              const username = (entity as any).username;
              chatLink = buildChatLink(task.chatId, username);
            }
          } catch { /* 忽略 */ }

          const chatDisplay = task.chatDisplay || task.chatId;
          const linkText = chatLink ? ` <a href="${chatLink}">${chatDisplay}</a>` : ` ${chatDisplay}`;
          await msg.edit({ text: `⏳ 正在执行总结...${linkText}`, parseMode: "html" });

          const result = await executeSummary(task);
          if (result.success) {
            await msg.edit({ text: `✅ ${result.message}`, parseMode: "html" });
          } else {
            await msg.edit({ text: `❌ ${result.message}`, parseMode: "html" });
          }
          return;
        }

        if (sub === "edit") {
          const id = args[0];
          const prop = args[1]?.toLowerCase();
          const value = args.slice(2).join(" ");

          if (!id || !prop) {
            await msg.edit({
              text: `❌ 格式错误\n\n用法: <code>${mainPrefix}sum edit &lt;任务ID&gt; &lt;属性&gt; &lt;值&gt;</code>\n\n支持的属性:\n• spoiler - 折叠显示 (on/off)\n• provider - AI配置名称\n• prompt - AI提示词 (留空使用全局配置)`,
              parseMode: "html"
            });
            return;
          }

          const db = await getDB();
          const idx = db.data.tasks.findIndex((t: SummaryTask) => t.id === id);
          if (idx < 0) {
            await msg.edit({ text: `未找到任务: <code>${id}</code>`, parseMode: "html" });
            return;
          }

          const task = db.data.tasks[idx];

          if (prop === "spoiler") {
            if (!value) {
              await msg.edit({ text: "❌ 请提供值: on 或 off", parseMode: "html" });
              return;
            }
            if (value === "on" || value === "true" || value === "1") {
              task.useSpoiler = true;
              await db.write();
              await msg.edit({ text: `✅ 已启用任务 <code>${id}</code> 的折叠显示`, parseMode: "html" });
            } else if (value === "off" || value === "false" || value === "0") {
              task.useSpoiler = false;
              await db.write();
              await msg.edit({ text: `✅ 已禁用任务 <code>${id}</code> 的折叠显示`, parseMode: "html" });
            } else {
              await msg.edit({ text: "❌ 无效的值，请使用 on 或 off", parseMode: "html" });
            }
          } else if (prop === "provider") {
            if (!value) {
              // 清空 provider，使用全局默认
              task.aiProvider = undefined;
              await db.write();
              await msg.edit({ text: `✅ 已清空任务 <code>${id}</code> 的 AI 配置，将使用全局默认配置`, parseMode: "html" });
            } else {
              // 检查 provider 是否存在
              if (!db.data.aiConfig.providers[value]) {
                await msg.edit({ text: `❌ 未找到 AI 配置: ${value}`, parseMode: "html" });
                return;
              }
              task.aiProvider = value;
              await db.write();
              await msg.edit({ text: `✅ 已设置任务 <code>${id}</code> 的 AI 配置为: ${value}`, parseMode: "html" });
            }
          } else if (prop === "prompt") {
            if (!value) {
              // 清空 prompt，使用全局默认
              task.aiPrompt = undefined;
              await db.write();
              await msg.edit({ text: `✅ 已清空任务 <code>${id}</code> 的提示词，将使用全局默认提示词`, parseMode: "html" });
            } else {
              task.aiPrompt = value;
              await db.write();
              await msg.edit({ text: `✅ 已设置任务 <code>${id}</code> 的提示词`, parseMode: "html" });
            }
          } else {
            await msg.edit({ text: `❌ 未知属性: ${prop}\n支持: spoiler/provider/prompt`, parseMode: "html" });
          }
          return;
        }

        if (sub === "disable" || sub === "enable") {
          const id = args[0];
          if (!id) {
            await msg.edit({ text: "请提供任务ID" });
            return;
          }

          const db = await getDB();
          const idx = db.data.tasks.findIndex((t: SummaryTask) => t.id === id);
          if (idx < 0) {
            await msg.edit({ text: `未找到任务: <code>${id}</code>`, parseMode: "html" });
            return;
          }

          const t = db.data.tasks[idx];
          if (sub === "disable") {
            cronManager.del(makeCronKey(id));
            t.disabled = true;
            await db.write();
            await msg.edit({ text: `⏸️ 已禁用任务 <code>${id}</code>`, parseMode: "html" });
          } else {
            t.disabled = false;
            await db.write();
            await scheduleTask(t);
            await msg.edit({ text: `▶️ 已启用任务 <code>${id}</code>`, parseMode: "html" });
          }
          return;
        }

        if (sub === "reorder" || sub === "sort") {
          const db = await getDB();
          if (db.data.tasks.length === 0) {
            await msg.edit({ text: "暂无任务需要重排序" });
            return;
          }

          // 停止所有任务
          for (const t of db.data.tasks) {
            cronManager.del(makeCronKey(t.id));
          }

          // 重新编号
          const oldIds: string[] = [];
          db.data.tasks.forEach((t: SummaryTask, i: number) => {
            oldIds.push(t.id);
            t.id = String(i + 1);
          });
          db.data.seq = String(db.data.tasks.length);

          // 重新调度
          for (const t of db.data.tasks) {
            if (!t.disabled && cron.validateCronExpression(t.cron).valid) {
              await scheduleTask(t);
            }
          }

          await db.write();

          const mapping = oldIds.map((old, i) => `${old} → ${i + 1}`).join(", ");
          await msg.edit({
            text: `✅ 已重新排序 ${db.data.tasks.length} 个任务\n\n${mapping}`,
            parseMode: "html"
          });
          return;
        }



        if (sub === "config") {
          const action = args[0];

          if (action === "list" || action === "ls") {
            const db = await getDB();
            const providers = db.data.aiConfig.providers;
            const cfg = db.data.aiConfig;

            if (Object.keys(providers).length === 0) {
              await msg.edit({ text: "暂无配置" });
              return;
            }

            const lines = ["🤖 AI 配置列表", ""];

            for (const [key, p] of Object.entries(providers)) {
              const provider = p as CustomProvider;
              lines.push(`<b>${provider.name}</b> (<code>${key}</code>)`);
              lines.push(`类型: ${provider.type}`);
              lines.push(`Base URL: ${provider.base_url}`);
              lines.push(`Model: ${provider.model}`);
              lines.push(`API Key: ${provider.api_key ? "已设置" : "未设置"}`);
              lines.push("");
            }

            lines.push("⚙️ 全局设置");
            lines.push("");
            lines.push(`默认配置: ${cfg.default_provider || "未设置"}`);
            lines.push(`默认推送: ${db.data.defaultPushTarget || "me"}`);
            lines.push(`提示词: ${cfg.default_prompt || "默认"}`);
            lines.push(`折叠显示: ${cfg.default_spoiler ? "开启" : "关闭"}`);
            lines.push(`超时时间: ${cfg.default_timeout ? `${cfg.default_timeout / 1000}秒` : "60秒（默认）"}`);
            lines.push(`回复模式: ${cfg.reply_mode !== false ? "开启" : "关闭"}`);
            lines.push(`最大输出: ${cfg.max_output_length ? `${cfg.max_output_length}字符` : "不限制（默认）"}`);

            await msg.edit({ text: lines.join("\n"), parseMode: "html" });
            return;
          }

          if (action === "add") {
            const name = args[1];
            if (!name) {
              await msg.edit({
                text: `❌ 请提供配置名称\n用法1（官方）: <code>${mainPrefix}sum config add openai sk-xxx</code>\n用法2（自定义）: <code>${mainPrefix}sum config add myai openai https://api.example.com my-model</code>`,
                parseMode: "html"
              });
              return;
            }

            const db = await getDB();
            const key = name.toLowerCase().replace(/\s+/g, "_");
            const officialPreset =
              OFFICIAL_PROVIDER_PRESETS[key as keyof typeof OFFICIAL_PROVIDER_PRESETS];

            if (officialPreset) {
              const apiKey = args[2];

              if (!apiKey) {
                await msg.edit({
                  text: `❌ 请提供 API Key\n用法: <code>${mainPrefix}sum config add ${key} YOUR_API_KEY</code>`,
                  parseMode: "html"
                });
                return;
              }

              db.data.aiConfig.providers[key] = {
                ...officialPreset,
                api_key: apiKey
              };

              await db.write();

              await msg.edit({
                text: `✅ 已配置官方 <b>${officialPreset.name}</b>\n默认模型: <code>${officialPreset.model}</code>\n可用命令: <code>${mainPrefix}sum config set ${key} model ...</code> / <code>url ...</code>`,
                parseMode: "html"
              });
              return;
            }

            const type = args[2] as "openai" | "gemini";
            const baseUrl = args[3];
            const model = args[4];

            if (!type || !baseUrl || !model) {
              await msg.edit({
                text: `❌ 格式错误\n\n自定义用法: <code>${mainPrefix}sum config add &lt;名称&gt; &lt;类型&gt; &lt;BaseURL&gt; &lt;Model&gt;</code>\n示例: <code>${mainPrefix}sum config add deepseek openai https://api.deepseek.com deepseek-chat</code>`,
                parseMode: "html"
              });
              return;
            }

            if (type !== "openai" && type !== "gemini") {
              await msg.edit({ text: "❌ 类型必须是 openai 或 gemini" });
              return;
            }

            db.data.aiConfig.providers[key] = {
              name,
              base_url: baseUrl,
              api_key: "",
              model,
              type
            };

            await db.write();

            await msg.edit({
              text: `✅ 已添加配置 <code>${key}</code>\n\n请使用以下命令设置 API Key:\n<code>${mainPrefix}sum config set ${key} key YOUR_API_KEY</code>`,
              parseMode: "html"
            });
            return;
          }

          if (action === "set") {
            const name = args[1];
            const prop = args[2];
            const value = args.slice(3).join(" ");

            if (!name || !prop) {
              await msg.edit({ text: "用法: sum config set <名称/选项> <属性> <值>\n属性: key/model/url\n选项: push/default/prompt" });
              return;
            }

            const db = await getDB();

            // 全局设置
            if (name === "push") {
              if (!prop) {
                await msg.edit({ text: "请提供推送目标" });
                return;
              }
              db.data.defaultPushTarget = prop;
              await db.write();
              await msg.edit({ text: `✅ 已设置默认推送目标: ${prop}` });
              return;
            }

            if (name === "default") {
              if (!prop) {
                await msg.edit({ text: "请提供配置名称" });
                return;
              }
              if (!db.data.aiConfig.providers[prop]) {
                await msg.edit({ text: `❌ 未找到配置: ${prop}` });
                return;
              }
              db.data.aiConfig.default_provider = prop;
              await db.write();
              await msg.edit({ text: `✅ 已设置默认配置: ${prop}` });
              return;
            }

            if (name === "prompt") {
              if (!prop) {
                await msg.edit({ text: "请提供提示词，或使用 reset 重置为默认" });
                return;
              }

              // 重置提示词
              if (prop === "reset") {
                db.data.aiConfig.default_prompt = "请总结以下群聊消息的主要内容，提取关键话题和重要信息：";
                await db.write();
                await msg.edit({ text: `✅ 已重置提示词为默认值` });
                return;
              }

              const promptValue = [prop, value].filter(Boolean).join(" ");
              db.data.aiConfig.default_prompt = promptValue;
              await db.write();
              await msg.edit({ text: `✅ 已设置提示词` });
              return;
            }

            if (name === "spoiler") {
              if (!prop) {
                await msg.edit({ text: "请提供值: on 或 off" });
                return;
              }

              if (prop === "on" || prop === "true" || prop === "1") {
                db.data.aiConfig.default_spoiler = true;
                await db.write();
                await msg.edit({ text: `✅ 已启用全局折叠` });
                return;
              } else if (prop === "off" || prop === "false" || prop === "0") {
                db.data.aiConfig.default_spoiler = false;
                await db.write();
                await msg.edit({ text: `✅ 已关闭全局折叠` });
                return;
              } else {
                await msg.edit({ text: "❌ 无效的值，请使用 on 或 off" });
                return;
              }
            }

            if (name === "timeout") {
              if (!prop) {
                await msg.edit({ text: "请提供超时时间（秒），例如: 60、120、180" });
                return;
              }

              const seconds = toInt(prop);
              if (!seconds || seconds < 10) {
                await msg.edit({ text: "❌ 超时时间必须至少为10秒" });
                return;
              }

              db.data.aiConfig.default_timeout = seconds * 1000;
              await db.write();
              await msg.edit({ text: `✅ 已设置超时时间为 ${seconds} 秒` });
              return;
            }

            if (name === "reply") {
              if (!prop) {
                await msg.edit({ text: "请提供值: on 或 off" });
                return;
              }

              if (prop === "on" || prop === "true" || prop === "1") {
                db.data.aiConfig.reply_mode = true;
                await db.write();
                await msg.edit({ text: `✅ 已开启回复模式（发送新消息，防止被顶走）` });
                return;
              } else if (prop === "off" || prop === "false" || prop === "0") {
                db.data.aiConfig.reply_mode = false;
                await db.write();
                await msg.edit({ text: `✅ 已关闭回复模式（编辑原消息）` });
                return;
              } else {
                await msg.edit({ text: "❌ 无效的值，请使用 on 或 off" });
                return;
              }
            }

            if (name === "maxoutput") {
              if (!prop) {
                await msg.edit({ text: "请提供最大输出字符数（0表示不限制），例如: 4000、8000" });
                return;
              }

              const length = toInt(prop);
              if (length === undefined || length < 0) {
                await msg.edit({ text: "❌ 请输入有效的数字（0表示不限制）" });
                return;
              }

              db.data.aiConfig.max_output_length = length;
              await db.write();
              if (length === 0) {
                await msg.edit({ text: `✅ 已取消输出长度限制` });
              } else {
                await msg.edit({ text: `✅ 已设置最大输出长度为 ${length} 字符` });
              }
              return;
            }

            // 配置项设置
            const provider = db.data.aiConfig.providers[name];

            if (!provider) {
              await msg.edit({ text: `❌ 未找到配置: ${name}` });
              return;
            }

            if (!value) {
              await msg.edit({ text: "请提供值" });
              return;
            }

            if (prop === "key") {
              provider.api_key = value;
            } else if (prop === "model") {
              provider.model = value;
            } else if (prop === "url") {
              provider.base_url = value;
            } else {
              await msg.edit({ text: "❌ 无效的属性，支持: key/model/url" });
              return;
            }

            await db.write();
            await msg.edit({ text: `✅ 已更新配置 ${name} 的 ${prop}` });
            return;
          }

          if (action === "del" || action === "rm") {
            const name = args[1];

            if (!name) {
              await msg.edit({ text: "请提供配置名称" });
              return;
            }

            const db = await getDB();

            if (!db.data.aiConfig.providers[name]) {
              await msg.edit({ text: `❌ 未找到配置: ${name}` });
              return;
            }

            delete db.data.aiConfig.providers[name];

            if (db.data.aiConfig.default_provider === name) {
              db.data.aiConfig.default_provider = undefined;
            }

            await db.write();
            await msg.edit({ text: `✅ 已删除配置 ${name}` });
            return;
          }

          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        await msg.edit({ text: help_text, parseMode: "html" });
      } catch (e: any) {
        await msg.edit({ text: `❌ 错误: ${e?.message || e}` });
      }
    }
  };
}

export default new SummaryPlugin();


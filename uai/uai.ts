/**
 * UAI 插件 - 引用消息 AI 分析
 * 引用某用户/频道的消息，回复 .uai zj/fx 进行总结/分析
 */
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";
import axios from "axios";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getGlobalClient } from "@utils/globalClient";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// ========== 类型定义 ==========
type ApiType = "openai" | "gemini";
type AuthMethod = "bearer_token" | "api_key_header" | "query_param";

type Provider = {
    name: string;
    base_url: string;
    api_key: string;
    model: string;
    type: ApiType;
    auth_method: AuthMethod;
};

type UAIConfig = {
    providers: Record<string, Provider>;
    default_provider?: string;
    prompts: Record<string, string>;
    timeout: number;
};

// ========== 常量 ==========
const DB_PATH = path.join(createDirectoryInAssets("uai"), "config.json");
const DEFAULT_TIMEOUT = 120000;
const BATCH_LIMIT = 500;

const BUILTIN_PROMPTS: Record<string, string> = {
    zj: "请总结以下消息的主要内容，提取关键信息，用简洁的中文回复：",
    fx: "请分析以下消息的观点、态度和倾向，用简洁的中文回复："
};

const DEFAULT_CONFIG: UAIConfig = {
    providers: {},
    default_provider: undefined,
    prompts: {},
    timeout: DEFAULT_TIMEOUT
};

// ========== 工具函数 ==========
function htmlEscape(t: string): string {
    return t
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Markdown 转 Telegram HTML
function markdownToHtml(text: string): string {
    return text
        // 粗体 **text** 或 __text__
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/__(.+?)__/g, "<b>$1</b>")
        // 斜体 *text* 或 _text_
        .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>")
        .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>")
        // 代码 `code`
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        // 删除线 ~~text~~
        .replace(/~~(.+?)~~/g, "<s>$1</s>");
}

// 生成 blockquote 折叠块
function createCollapsibleBlockquote(content: string, title: string = "AI 分析结果", collapsed: boolean = true): string {
    const escapedContent = htmlEscape(content);
    const hashedTitle = `analysis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // 使用 Telegram 的 details/summary 标签实现折叠效果
    // 注意：Telegram 不完全支持标准的 details/summary，但可以使用类似的结构
    return `
<blockquote expandable>
<details ${collapsed ? '' : 'open'}>
<summary><b>${title} (点击展开/折叠)</b></summary>
${escapedContent}
</details>
</blockquote>`;
}

// 生成简单的 blockquote（无折叠）
function createSimpleBlockquote(content: string): string {
    const escapedContent = htmlEscape(content).replace(/\n/g, '<br>');
    return `<blockquote>${escapedContent}</blockquote>`;
}

function trimBase(url: string): string {
    return url.replace(/\/$/, "");
}

function formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    return `${y}/${m}/${d} ${h}:${min}`;
}

function getTodayStart(): number {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.floor(now.getTime() / 1000);
}

// 解析时间参数：2h -> 2小时, 30m -> 30分钟
function parseTimeLimit(s: string): number | null {
    const match = s.match(/^(\d+)(h|m)$/i);
    if (!match) return null;
    const val = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === "h") return val * 3600;
    if (unit === "m") return val * 60;
    return null;
}

// ========== 数据库 ==========
async function getDB() {
    const db = await JSONFilePreset<UAIConfig>(DB_PATH, DEFAULT_CONFIG);
    if (!db.data.providers) db.data.providers = {};
    if (!db.data.prompts) db.data.prompts = {};
    if (!db.data.timeout) db.data.timeout = DEFAULT_TIMEOUT;
    return db;
}

// 获取提示词：优先自定义，其次内置
function getPrompt(db: { data: UAIConfig }, key: string): string {
    return db.data.prompts[key] || BUILTIN_PROMPTS[key] || BUILTIN_PROMPTS["zj"];
}

// ========== AI 调用 ==========
async function callOpenAI(
    provider: Provider,
    prompt: string,
    content: string,
    timeout: number
): Promise<string> {
    const base = trimBase(provider.base_url);
    // 火山等 API 的 base_url 已包含版本路径（如 /api/v3），无需再添加 /v1
    const url = base.match(/\/v\d+$/) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (provider.auth_method === "bearer_token") {
        headers["Authorization"] = `Bearer ${provider.api_key}`;
    } else if (provider.auth_method === "api_key_header") {
        headers["X-API-Key"] = provider.api_key;
    }

    const params: Record<string, string> = {};
    if (provider.auth_method === "query_param") {
        params["key"] = provider.api_key;
    }

    const response = await axios.post(
        url,
        {
            model: provider.model,
            messages: [{ role: "user", content: `${prompt}\n\n${content}` }],
            max_tokens: 4096
        },
        { headers, params, timeout }
    );

    return response.data?.choices?.[0]?.message?.content || "";
}

async function callGemini(
    provider: Provider,
    prompt: string,
    content: string,
    timeout: number
): Promise<string> {
    const url = `${trimBase(provider.base_url)}/v1beta/models/${provider.model}:generateContent`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const params: Record<string, string> = {};

    if (provider.auth_method === "query_param" || provider.auth_method === "bearer_token") {
        params["key"] = provider.api_key;
    }
    if (provider.auth_method === "api_key_header") {
        headers["x-goog-api-key"] = provider.api_key;
    }

    const response = await axios.post(
        url,
        {
            contents: [{ role: "user", parts: [{ text: `${prompt}\n\n${content}` }] }]
        },
        { headers, params, timeout }
    );

    const parts = response.data?.candidates?.[0]?.content?.parts || [];
    return parts.map((p: any) => p.text || "").join("");
}

async function callAI(provider: Provider, prompt: string, content: string, timeout: number): Promise<string> {
    if (provider.type === "gemini") {
        return await callGemini(provider, prompt, content, timeout);
    }
    return await callOpenAI(provider, prompt, content, timeout);
}

// ========== 消息收集 ==========
type MessageData = { time: string; sender: string; text: string };

async function collectMessages(
    chatPeerId: any,  // msg.peerId
    filterSenderId: string | null,  // senderId.toString() 用于手动过滤
    limit: { type: "count"; value: number } | { type: "time"; seconds: number } | { type: "today" }
): Promise<MessageData[]> {
    const client = await getGlobalClient();
    if (!client) throw new Error("客户端未初始化");

    const messages: MessageData[] = [];
    const startTime = limit.type === "today" ? getTodayStart() :
        limit.type === "time" ? Math.floor(Date.now() / 1000) - limit.seconds : 0;
    const maxCount = limit.type === "count" ? limit.value : 10000;

    // 获取消息（不使用 fromUser，因为不可靠）
    // 使用更大的 limit 来确保能获取到足够的目标用户消息
    const fetchLimit = filterSenderId ? maxCount * 10 : maxCount;
    const messageIterator = client.iterMessages(chatPeerId, { limit: Math.min(fetchLimit, 10000) });

    for await (const msg of messageIterator) {
        const m = msg as any;

        // 时间检查
        if (limit.type !== "count" && m.date < startTime) {
            break;
        }

        // 手动过滤发送者
        if (filterSenderId) {
            const msgSenderId = m.senderId?.toString();
            if (msgSenderId !== filterSenderId) continue;
        }

        if (!m.message) continue;

        // 过滤掉插件生成的分析结果消息
        if (m.message.startsWith("📊 分析结果") || m.message.startsWith("📊 总结结果")) continue;

        const sender = m.sender?.firstName || m.sender?.username || "未知";
        messages.push({
            time: formatDate(new Date(m.date * 1000)),
            sender,
            text: m.message
        });

        if (messages.length >= maxCount) break;
    }

    return messages.reverse();
}

function formatMessagesForAI(messages: MessageData[]): string {
    return messages.map(m => `[${m.time}] ${m.sender}: ${m.text}`).join("\n");
}

// ========== 帮助文本 ==========
const getHelpText = () => `📊 <b>UAI - 引用消息 AI 分析</b>

<b>使用方法:</b>
引用某用户/频道消息，回复:
• <code>${mainPrefix}uai zj</code> - 总结（当天消息）
• <code>${mainPrefix}uai fx</code> - 分析（当天消息）
• <code>${mainPrefix}uai zj 50</code> - 总结最近 50 条
• <code>${mainPrefix}uai fx 2h</code> - 分析最近 2 小时
• <code>${mainPrefix}uai 自定义名</code> - 使用自定义提示词

<b>供应商配置:</b>
• <code>${mainPrefix}uai add &lt;名称&gt; &lt;url&gt; &lt;key&gt; &lt;type&gt;</code>
• <code>${mainPrefix}uai set/del &lt;名称&gt;</code>
• <code>${mainPrefix}uai list</code>
• <code>${mainPrefix}uai model &lt;名称&gt; &lt;模型&gt;</code>

<b>提示词配置:</b>
• <code>${mainPrefix}uai prompt add &lt;名称&gt; &lt;内容&gt;</code>
• <code>${mainPrefix}uai prompt del &lt;名称&gt;</code>
• <code>${mainPrefix}uai prompt list</code>

<b>type:</b> openai / gemini
<b>内置提示词:</b> zj(总结) fx(分析)`;

// ========== 插件类 ==========
class UAIPlugin extends Plugin {
    name = "uai";
    description = () => getHelpText();

    cmdHandlers = {
        uai: async (msg: Api.Message) => {
            const text = (msg.message || "").trim();
            const parts = text.split(/\s+/).slice(1);
            const subCmd = parts[0]?.toLowerCase() || "";

            const db = await getDB();

            // 帮助
            if (!subCmd || subCmd === "help") {
                await msg.edit({ text: getHelpText(), parseMode: "html" });
                return;
            }

            // 配置命令
            if (subCmd === "add" && parts.length >= 5) {
                const [, name, baseUrl, apiKey, typeStr] = parts;
                const type = typeStr.toLowerCase() as ApiType;
                if (type !== "openai" && type !== "gemini") {
                    await msg.edit({ text: "❌ type 必须是 openai 或 gemini", parseMode: "html" });
                    return;
                }
                const authMethod: AuthMethod = type === "gemini" ? "query_param" : "bearer_token";
                const defaultModel = type === "gemini" ? "gemini-2.0-flash" : "gpt-4o";
                db.data.providers[name] = { name, base_url: baseUrl, api_key: apiKey, model: defaultModel, type, auth_method: authMethod };
                if (!db.data.default_provider) db.data.default_provider = name;
                await db.write();
                await msg.edit({ text: `✅ 供应商 <code>${htmlEscape(name)}</code> 已添加`, parseMode: "html" });
                return;
            }

            if (subCmd === "del" && parts[1]) {
                const name = parts[1];
                if (!db.data.providers[name]) {
                    await msg.edit({ text: "❌ 供应商不存在", parseMode: "html" });
                    return;
                }
                delete db.data.providers[name];
                if (db.data.default_provider === name) {
                    db.data.default_provider = Object.keys(db.data.providers)[0] || undefined;
                }
                await db.write();
                await msg.edit({ text: `✅ 已删除 <code>${htmlEscape(name)}</code>`, parseMode: "html" });
                return;
            }

            if (subCmd === "set" && parts[1]) {
                const name = parts[1];
                if (!db.data.providers[name]) {
                    await msg.edit({ text: "❌ 供应商不存在", parseMode: "html" });
                    return;
                }
                db.data.default_provider = name;
                await db.write();
                await msg.edit({ text: `✅ 默认供应商: <code>${htmlEscape(name)}</code>`, parseMode: "html" });
                return;
            }

            if (subCmd === "list") {
                const providers = Object.values(db.data.providers);
                if (providers.length === 0) {
                    await msg.edit({ text: "📋 暂无供应商", parseMode: "html" });
                    return;
                }
                const list = providers.map(p => {
                    const isDefault = db.data.default_provider === p.name ? " ⭐" : "";
                    return `• <code>${htmlEscape(p.name)}</code>${isDefault} (${p.type}, ${p.model})`;
                }).join("\n");
                await msg.edit({ text: `📋 <b>供应商列表</b>\n\n${list}`, parseMode: "html" });
                return;
            }

            if (subCmd === "model" && parts[1] && parts[2]) {
                const name = parts[1];
                const model = parts[2];
                if (!db.data.providers[name]) {
                    await msg.edit({ text: `❌ 供应商 <code>${htmlEscape(name)}</code> 不存在`, parseMode: "html" });
                    return;
                }
                db.data.providers[name].model = model;
                await db.write();
                await msg.edit({ text: `✅ <code>${htmlEscape(name)}</code> 模型已设置为 <code>${htmlEscape(model)}</code>`, parseMode: "html" });
                return;
            }

            // ========== 提示词管理 ==========
            if (subCmd === "prompt") {
                const action = parts[1]?.toLowerCase();

                if (action === "add" && parts.length >= 4) {
                    const name = parts[2];
                    const content = parts.slice(3).join(" ");
                    if (BUILTIN_PROMPTS[name]) {
                        await msg.edit({ text: `❌ <code>${htmlEscape(name)}</code> 是内置提示词，无法覆盖`, parseMode: "html" });
                        return;
                    }
                    db.data.prompts[name] = content;
                    await db.write();
                    await msg.edit({ text: `✅ 提示词 <code>${htmlEscape(name)}</code> 已添加`, parseMode: "html" });
                    return;
                }

                if (action === "del" && parts[2]) {
                    const name = parts[2];
                    if (!db.data.prompts[name]) {
                        await msg.edit({ text: "❌ 提示词不存在", parseMode: "html" });
                        return;
                    }
                    delete db.data.prompts[name];
                    await db.write();
                    await msg.edit({ text: `✅ 已删除 <code>${htmlEscape(name)}</code>`, parseMode: "html" });
                    return;
                }

                if (action === "list" || !action) {
                    const builtinList = Object.keys(BUILTIN_PROMPTS).map(k => `• <code>${k}</code> (内置)`).join("\n");
                    const customList = Object.entries(db.data.prompts).map(([k, v]) =>
                        `• <code>${htmlEscape(k)}</code>: ${htmlEscape(v.substring(0, 30))}...`
                    ).join("\n");
                    const text = `📝 <b>提示词列表</b>\n\n<b>内置:</b>\n${builtinList}${customList ? `\n\n<b>自定义:</b>\n${customList}` : ""}`;
                    await msg.edit({ text, parseMode: "html" });
                    return;
                }

                await msg.edit({ text: "❌ 用法: prompt add/del/list", parseMode: "html" });
                return;
            }

            // ========== 主功能：引用消息分析 ==========
            // 检查是否引用了消息
            if (!msg.replyTo) {
                await msg.edit({ text: "❌ 请引用一条消息后使用此命令\n\n" + getHelpText(), parseMode: "html" });
                return;
            }

            // 检查 AI 配置
            if (!db.data.default_provider || !db.data.providers[db.data.default_provider]) {
                await msg.edit({ text: "❌ 请先配置 AI 供应商\n\n使用: <code>.uai add 名称 url key type</code>", parseMode: "html" });
                return;
            }

            // 解析参数：[提示词名称] [数量|时间]
            let limit: { type: "count"; value: number } | { type: "time"; seconds: number } | { type: "today" } = { type: "today" };
            let promptKey = "zj";

            // 合并内置和自定义提示词名称
            const allPromptKeys = new Set([...Object.keys(BUILTIN_PROMPTS), ...Object.keys(db.data.prompts)]);

            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                const pLower = p.toLowerCase();

                // 检查是否是提示词名称（内置或自定义）
                if (allPromptKeys.has(pLower) || allPromptKeys.has(p)) {
                    promptKey = allPromptKeys.has(pLower) ? pLower : p;
                } else if (/^\d+$/.test(p)) {
                    limit = { type: "count", value: parseInt(p) };
                } else {
                    const seconds = parseTimeLimit(p);
                    if (seconds) limit = { type: "time", seconds };
                }
            }

            const prompt = getPrompt(db, promptKey);

            await msg.edit({ text: "🔄 正在收集消息...", parseMode: "html" });

            try {
                const client = await getGlobalClient();
                if (!client) throw new Error("客户端未初始化");

                // 获取被引用的消息
                const replyToId = (msg.replyTo as any)?.replyToMsgId;
                if (!replyToId) throw new Error("无法获取引用消息");

                const chatPeerId = msg.peerId;  // 使用 peerId 而不是 chatId 字符串
                const [repliedMsg] = await client.getMessages(chatPeerId, { ids: [replyToId] });
                if (!repliedMsg) throw new Error("引用的消息不存在");

                // 获取来源：发送者 或 转发来源
                let sourceId: string | null = null;  // 使用字符串形式的 ID
                let sourceName = "未知";
                let sourceUsername: string | undefined = undefined;

                const fwdFrom = (repliedMsg as any).fwdFrom;
                if (fwdFrom?.fromId) {
                    // 转发消息，获取原始来源
                    const fwdId = fwdFrom.fromId;
                    if (fwdId.channelId) {
                        // 转发自频道 - 不按用户过滤，改为获取该频道消息
                        const channelPeerId = `-100${fwdId.channelId}`;
                        await msg.edit({ text: "🔄 正在收集频道消息...", parseMode: "html" });
                        const messages = await collectMessages(channelPeerId, null, limit);
                        if (messages.length === 0) {
                            await msg.edit({ text: "❌ 没有找到消息", parseMode: "html" });
                            return;
                        }
                        const content = formatMessagesForAI(messages);
                        await msg.edit({ text: `🤖 正在分析 ${messages.length} 条消息...`, parseMode: "html" });
                        const provider = db.data.providers[db.data.default_provider!];

                        // 获取频道信息
                        let channelName = "频道";
                        let channelUsername: string | undefined = undefined;
                        try {
                            const channelEntity = await client.getEntity(channelPeerId);
                            channelName = (channelEntity as any).title || (channelEntity as any).username || "频道";
                            channelUsername = (channelEntity as any).username;
                        } catch { }
                        const displayName = channelUsername ? `@${channelUsername}` : channelName;

                        const userInfo = `来源: ${channelName}${channelUsername ? ` (@${channelUsername})` : ""}`;
                        const result = await callAI(provider, prompt, `${userInfo}\n\n${content}`, db.data.timeout);
                        
                        // 使用 blockquote 折叠块显示结果
                        const resultBlockquote = createCollapsibleBlockquote(
                            result, 
                            promptKey === "zj" ? "总结结果" : "分析结果"
                        );
                        
                        const resultText = `📊 <b>${promptKey === "zj" ? "总结" : "分析"}结果</b>（${displayName}，${messages.length} 条）\n\n${resultBlockquote}`;
                        await msg.delete({ revoke: true });
                        await client.sendMessage(chatPeerId, { message: resultText, parseMode: "html" });
                        return;
                    } else if (fwdId.userId) {
                        sourceId = fwdId.userId.toString();
                        try {
                            const entity = await client.getEntity(fwdId.userId) as any;
                            sourceName = entity.firstName || entity.username || "用户";
                            sourceUsername = entity.username;
                        } catch { }
                    }
                } else {
                    // 非转发消息，使用发送者
                    const senderId = (repliedMsg as any).senderId;
                    if (senderId) {
                        sourceId = senderId.toString();
                        try {
                            const entity = await client.getEntity(senderId) as any;
                            sourceName = entity.firstName || entity.username || "用户";
                            sourceUsername = entity.username;
                        } catch { }
                    }
                }

                if (!sourceId) throw new Error("无法确定消息来源");

                // 显示名称：优先 @username
                const displayName = sourceUsername ? `@${sourceUsername}` : sourceName;
                const userInfo = `用户: ${sourceName}${sourceUsername ? ` (@${sourceUsername})` : ""}`;

                // 收集消息 - 传入 peerId 和 senderId 字符串
                await msg.edit({ text: `🔄 正在收集 ${displayName} 的消息...`, parseMode: "html" });
                const messages = await collectMessages(chatPeerId, sourceId, limit);

                if (messages.length === 0) {
                    await msg.edit({ text: `❌ 没有找到 ${displayName} 的消息`, parseMode: "html" });
                    return;
                }

                const content = formatMessagesForAI(messages);
                await msg.edit({ text: `🤖 正在分析 ${messages.length} 条消息...`, parseMode: "html" });

                const provider = db.data.providers[db.data.default_provider!];
                const result = await callAI(provider, prompt, `${userInfo}\n\n${content}`, db.data.timeout);
                
                // 使用 blockquote 折叠块显示结果
                const resultBlockquote = createCollapsibleBlockquote(
                    result, 
                    promptKey === "zj" ? "总结结果" : "分析结果"
                );
                
                const resultText = `📊 <b>${promptKey === "zj" ? "总结" : "分析"}结果</b>（${displayName}，${messages.length} 条）\n\n${resultBlockquote}`;
                await msg.delete({ revoke: true });
                await client.sendMessage(chatPeerId, { message: resultText, parseMode: "html" });

            } catch (err: any) {
                await msg.edit({ text: `❌ 错误: ${htmlEscape(err.message || String(err))}`, parseMode: "html" });
            }
        }
    };

    async cleanup(): Promise<void> {
        // 无需清理资源
    }
}

export default new UAIPlugin();

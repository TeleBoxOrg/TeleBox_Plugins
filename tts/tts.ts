import { Plugin, type PanelSettingsAdapter, type PanelSettingField, type PanelFieldType } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
import { getPrefixes } from "@utils/pluginManager";
import axios from "axios";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";
import { getGlobalClient } from "@utils/runtimeManager";
import * as fs from "fs";
import { safeGetMessages } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

/** 私聊删除命令：为双方删除；群/频道：仅自己删除 */
async function deleteCommandMessage(msg: MessageContext) {
    try {
        const isPrivate = msg.chat.type === "user";

        if (isPrivate) {
            await msg.safeDelete({ revoke: true }); // 双向删除
        } else {
            await msg.delete(); // 普通删除
        }
    } catch (e: unknown) {
        logger.debug("tts: message delete failed, may lack permission or already deleted", e);
    }
}

/** 清理文本（emoji/不在白名单的符号；合并连续标点） */
function cleanTextForTTS(text: string): string {
    if (!text) return "";
    let cleanedText = text;
    // 移除各类 Emoji 和特殊符号
    const broadSymbolRegex = new RegExp(
        "[" +
        "\u{1F600}-\u{1F64F}" + // Emoticons
        "\u{1F300}-\u{1F5FF}" + // Misc Symbols and Pictographs
        "\u{1F680}-\u{1F6FF}" + // Transport and Map
        "\u{2600}-\u{26FF}" +   // Misc symbols
        "\u{2700}-\u{27BF}" +   // Dingbats
        "\u{FE0F}" +            // Variation Selectors
        "\u{200D}" +            // Zero-Width Joiner
        "]",
        "gu"
    );
    cleanedText = cleanedText.replace(broadSymbolRegex, "");

    // 合并连续标点
    cleanedText = cleanedText.replace(/([，。？！、,?!.])\1+/g, "$1");
    // 移除 markdown 链接格式 [text](url) -> text
    cleanedText = cleanedText.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");

    return cleanedText.trim();
}

/** 转义 SSML 特殊字符 */
function escapeSsmlText(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function htmlEscape(text: unknown): string {
    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;");
}

function codeTag(text: unknown): string {
    return `<code>${htmlEscape(text)}</code>`;
}

// ========== 类型定义 ==========
type TTSConfig = {
    key: string;
    region: string;
    voice: string;
    style?: string; // 说话风格
    rate?: string;  // 语速 (0.5 - 2.0)
    format: string;
};

// ========== 默认配置 ==========
const DEFAULT_CONFIG: TTSConfig = {
    key: "",
    region: "eastus",
    voice: "zh-CN-XiaoxiaoNeural",
    style: "",
    rate: "1.0",
    format: "audio-48khz-192kbitrate-mono-mp3"
};

const DB_PATH = path.join(createDirectoryInAssets("tts"), "config.json");

// ========== 数据库 ==========
async function getDB() {
    return await JSONFilePreset<TTSConfig>(DB_PATH, DEFAULT_CONFIG);
}

// ========== 帮助文本 ==========
const getHelpText = () => `🗣️ <b>Azure TTS</b> (微软语音合成)

<b>📝 功能:</b>
• 将文本转换为高质量语音
• 支持多种语音、情感和语速控制

<b>🔧 使用方法:</b>
• <code>${mainPrefix}tts &lt;文本&gt;</code> - 合成语音
• <code>${mainPrefix}tts config &lt;key&gt; &lt;region&gt;</code> - 配置 API
• <code>${mainPrefix}tts voice &lt;VoiceName&gt;</code> - 设置语音
• <code>${mainPrefix}tts style &lt;Style&gt;</code> - 设置风格 (如 cheerful, sad, chat, clear)
• <code>${mainPrefix}tts rate &lt;Rate&gt;</code> - 设置语速 (0.5 ~ 2.0, 默认为 1.0)
• <code>${mainPrefix}tts voices [filter]</code> - 列出音色 (默认 zh-CN)
• <code>${mainPrefix}tts list</code> - 查看当前配置

<b>💡 提示:</b>
• 样式需要该音色支持才能生效 (如 Xiaoxiao 支持 cheerful)
• 清除风格使用 <code>${mainPrefix}tts style clear</code>`;

// ========== 插件类 ==========
class TTSPlugin extends Plugin {

    name = "tts";
    description = () => getHelpText();

    cmdHandlers = {
        tts: async (msg: MessageContext) => {
            const text = (msg.text || "").trim();
            const parts = text.split(/\s+/).slice(1);
            const subCmd = parts[0]?.toLowerCase() || "";

            const db = await getDB();

            // 帮助
            if (!subCmd && !msg.replyToMessage) {
                await msg.edit({ text: html(getHelpText()) });
                return;
            }

            // 配置
            if (subCmd === "config") {
                if (parts.length < 3) {
                    await msg.edit({ text: html`❌ 用法: <code>${mainPrefix}tts config &lt;key&gt; &lt;region&gt;</code>` });
                    return;
                }
                const [, key, region] = parts;
                db.data.key = key;
                db.data.region = region;
                await db.write();

                // 遮挡 Key 显示
                const maskedKey = key.length > 8 ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : "***";
                await msg.edit({ text: html`✅ 配置已更新\nKey: ${codeTag(maskedKey)}\nRegion: ${codeTag(region)}` });
                return;
            }

            // 设置语音
            if (subCmd === "voice") {
                if (parts.length < 2) {
                    await msg.edit({ text: html`❌ 用法: <code>${mainPrefix}tts voice &lt;VoiceName&gt;</code>` });
                    return;
                }
                const voice = parts[1];
                db.data.voice = voice;
                await db.write();
                await msg.edit({ text: html`✅ 语音已设置为: ${codeTag(voice)}` });
                return;
            }

            // 查看配置
            if (subCmd === "list") {
                const { key, region, voice, style, rate } = db.data;
                const maskedKey = key ? (key.length > 8 ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : "***") : "未设置";
                await msg.edit({
                    text: html`📋 <b>当前配置</b>\n\nKey: ${codeTag(maskedKey)}\nRegion: ${codeTag(region)}\nVoice: ${codeTag(voice)}\nStyle: ${codeTag(style || "默认")}\nRate: ${codeTag(rate || "1.0")}`,
                });
                return;
            }

            // 设置风格
            if (subCmd === "style") {
                const style = parts[1];
                if (!style) {
                    await msg.edit({ text: html`❌ 用法: <code>${mainPrefix}tts style &lt;style&gt;</code> (使用 clear 清除)` });
                    return;
                }
                db.data.style = style === "clear" ? "" : style;
                await db.write();
                await msg.edit({ text: html`✅ 风格已设置: ${codeTag(db.data.style || "默认")}` });
                return;
            }

            // 设置语速
            if (subCmd === "rate") {
                const rateStr = parts[1];
                const rate = parseFloat(rateStr);
                if (isNaN(rate) || rate < 0.5 || rate > 2.0) {
                    await msg.edit({ text: html`❌ 语速必须在 0.5 到 2.0 之间` });
                    return;
                }
                db.data.rate = rateStr;
                await db.write();
                await msg.edit({ text: html`✅ 语速已设置: ${codeTag(rateStr)}` });
                return;
            }

            // 获取可用音色列表
            if (subCmd === "voices") {
                if (!db.data.key || !db.data.region) {
                    await msg.edit({ text: html`❌ 请先配置 Azure API Key 和 Region` });
                    return;
                }

                await msg.edit({ text: html`🔄 正在获取音色列表...` });

                const filter = parts[1] || "zh-CN"; // 默认只显示中文

                try {
                    const url = `https://${db.data.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
                    const response = await axios.get(url, {
                        headers: { "Ocp-Apim-Subscription-Key": db.data.key },
                        timeout: 30000
                    });

                    if (response.status !== 200 || !Array.isArray(response.data)) {
                        throw new Error(`API returned invalid data: ${response.status}`);
                    }

                    let voices = response.data;

                    // 过滤
                    if (filter.toLowerCase() !== "all") {
                        voices = voices.filter((v: { Locale?: string; ShortName?: string }) => (v.Locale ?? "").toLowerCase().includes(filter.toLowerCase()) || (v.ShortName ?? "").toLowerCase().includes(filter.toLowerCase()));
                    }

                    if (voices.length === 0) {
                        await msg.edit({ text: html`❌ 未找到匹配 "${codeTag(filter)}" 的音色` });
                        return;
                    }

                    // 格式化输出
                    const lines = voices.map((v: { ShortName?: string; LocalName?: string; Gender?: string }) => {
                        const gender = v.Gender === "Female" ? "👩" : (v.Gender === "Male" ? "👨" : "👤");
                        return `${gender} ${codeTag(v.ShortName)} (${htmlEscape(v.LocalName)})`;
                    });

                    const resultText = `📋 <b>可用音色列表</b> (${htmlEscape(filter)})\n\n${lines.join("\n")}\n\n使用 <code>${mainPrefix}tts voice &lt;Name&gt;</code> 设置`;

                    // 如果太长，发送文件
                    if (resultText.length > 4000) {
                        const buffer = Buffer.from(lines.join("\n"));
                        const client = await getGlobalClient();
                        if (!client) {
                            await msg.edit({ text: html`❌ 客户端不可用` });
                            return;
                        }
                        await client.sendMedia(msg.chat.id, {
                            type: "document",
                            file: buffer,
                            fileName: `voices_${filter}.txt`,
                            caption: html`📋 <b>可用音色列表</b> (${htmlEscape(filter)}) - 共 ${voices.length} 个`,
                        });
                        await deleteCommandMessage(msg);
                    } else {
                        await msg.edit({ text: html(resultText) });
                    }

                } catch (error: unknown) {
                    logger.error("[TTS Plugin] Voices Error:", error);
                    await msg.edit({ text: html`❌ 获取列表失败: ${htmlEscape(getErrorMessage(error))}` });
                }
                return;
            }

            // 合成语音
            let textToSynthesize = "";
            const match = text.match(/^\S+\s+(.*)/s);
            if (match) {
                textToSynthesize = match[1];
            }

            // 如果只有命令没有文本，且引用了消息，使用引用消息的文本
            if (!textToSynthesize && msg.replyToMessage) {
                const client = await getGlobalClient();
                if (client) {
                    const replyToId = msg.replyToMessage.id;
                    if (replyToId) {
                        const [repliedMsg] = await safeGetMessages(client, msg.chat.id, { ids: [replyToId] });
                        if (repliedMsg && repliedMsg.text) {
                            textToSynthesize = repliedMsg.text;
                        }
                    }
                }
            }

            // 如果既没有文本参数也没有引用文本，显示帮助
            if (!textToSynthesize) {
                await msg.edit({ text: html(getHelpText()) });
                return;
            }

            if (!db.data.key || !db.data.region) {
                await msg.edit({ text: html`❌ 请先配置 Azure API Key 和 Region\n使用: <code>${mainPrefix}tts config &lt;key&gt; &lt;region&gt;</code>` });
                return;
            }

            await msg.edit({ text: html`🔄 正在合成语音...` });

            const { key, region, voice, format, style, rate } = db.data;

            try {
                // 清理文本
                let cleanText = cleanTextForTTS(textToSynthesize);
                if (!cleanText) {
                    await msg.edit({ text: html`❌ 文本为空或仅包含特殊字符` });
                    return;
                }

                // 限制文本长度 (Azure TTS 有限制，且过长的语音消息不实用)
                const MAX_TEXT_LENGTH = 3000;
                if (cleanText.length > MAX_TEXT_LENGTH) {
                    cleanText = cleanText.substring(0, MAX_TEXT_LENGTH);
                }

                // 构建 SSML
                let content = escapeSsmlText(cleanText);

                // 添加语速控制
                if (rate && rate !== "1.0") {
                    content = `<prosody rate="${escapeSsmlText(rate)}">${content}</prosody>`;
                }

                // 添加风格控制 (仅当 style 存在时)
                if (style) {
                    content = `<mstts:express-as style="${escapeSsmlText(style)}">${content}</mstts:express-as>`;
                }

                const ssml = `<speak version='1.0' xml:lang='en-US' xmlns:mstts='https://www.w3.org/2001/mstts'><voice xml:lang='en-US' name='${escapeSsmlText(voice)}'>${content}</voice></speak>`;

                const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

                const response = await axios.post(url, ssml, {
                    headers: {
                        "Ocp-Apim-Subscription-Key": key,
                        "Content-Type": "application/ssml+xml",
                        "X-Microsoft-OutputFormat": format,
                        "User-Agent": "TeleBox-TTS"
                    },
                    responseType: "arraybuffer", // 获取二进制数据
                    timeout: 3600000
                });

                if (response.status === 200 && response.data) {
                    await msg.edit({ text: html`⬆️ 正在上传...` });

                    const client = await getGlobalClient();
                    if (!client) throw new Error("Client not available");

                    const buffer = Buffer.from(response.data);

                    const tempDir = createDirectoryInTemp("tts");

                    const tempFilePath = path.join(tempDir, `tts_${Date.now()}.mp3`);
                    fs.writeFileSync(tempFilePath, buffer);

                    try {
                        // 发送语音
                        await client.sendMedia(msg.chat.id, {
                            type: "voice",
                            file: tempFilePath,
                            duration: 0,
                        });

                        await deleteCommandMessage(msg); // 尝试删除命令消息
                    } finally {
                        if (fs.existsSync(tempFilePath)) {
                            fs.unlinkSync(tempFilePath);
                        }
                    }
                } else {
                    throw new Error(`API returned status ${response.status}`);
                }

            } catch (error: unknown) {
                logger.error("[TTS Plugin] Error:", error);
                const errMsg = error !== null && error !== undefined && typeof error === "object" && "response" in error
                    ? `API Error: ${(error as { response: { status: number; statusText: string } }).response.status} ${(error as { response: { status: number; statusText: string } }).response.statusText}`
                    : getErrorMessage(error);
                await msg.edit({ text: html`❌ 合成失败: ${htmlEscape(errMsg)}` });
            }
        }
    };
  
  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "tts",
    title: "TTS 语音合成",
    description: "微软 Azure TTS 配置：Key、Region、语音、风格、语速",
    category: "插件配置",
    icon: "🗣️",
    getSchema: (): PanelSettingField[] => [
      {
        key: "key",
        label: "Azure Speech Key",
        type: "password",
        secret: true,
        description: "从 Azure Portal 获取",
        required: true,
      },
      {
        key: "region",
        label: "Region 区域",
        type: "select",
        options: [
          { value: "eastus", label: "East US (东部美国)" },
          { value: "eastasia", label: "East Asia (东亚)" },
          { value: "southeastasia", label: "Southeast Asia (东南亚)" },
          { value: "northeurope", label: "North Europe (北欧)" },
          { value: "westus2", label: "West US 2 (美国西部 2)" },
          { value: "centralus", label: "Central US (美国中部)" },
        ],
        default: "eastus",
        description: "Azure 语音服务区域",
      },
      {
        key: "voice",
        label: "语音角色",
        type: "string",
        placeholder: "zh-CN-XiaoxiaoNeural",
        default: "zh-CN-XiaoxiaoNeural",
        description: "如 zh-CN-XiaoxiaoNeural, zh-CN-YunyangNeural 等",
      },
      {
        key: "style",
        label: "语音风格",
        type: "string",
        placeholder: "cheerful / sad / chat / clear 等",
        description: "需语音角色支持，如 Xiaoxiao 支持 cheerful, sad, angry, fearful 等",
      },
      {
        key: "rate",
        label: "语速",
        type: "string",
        placeholder: "1.0 (0.5~2.0)",
        default: "1.0",
        description: "0.5(慢) ~ 2.0(快)，默认 1.0",
      },
      {
        key: "format",
        label: "输出格式",
        type: "select",
        options: [
          { value: "audio-48khz-192kbitrate-mono-mp3", label: "MP3 48kHz 192kbps (默认)" },
          { value: "audio-24khz-160kbitrate-mono-mp3", label: "MP3 24kHz 160kbps" },
          { value: "audio-16khz-128kbitrate-mono-mp3", label: "MP3 16kHz 128kbps" },
          { value: "riff-48khz-16bit-mono-pcm", label: "WAV 48kHz 16bit PCM" },
          { value: "riff-24khz-16bit-mono-pcm", label: "WAV 24kHz 16bit PCM" },
          { value: "riff-16khz-16bit-mono-pcm", label: "WAV 16kHz 16bit PCM" },
        ],
        default: "audio-48khz-192kbitrate-mono-mp3",
      },
    ],
    getValues: async () => {
      const db = await getDB();
      return {
        key: db.data.key ? maskSecret(db.data.key) : "",
        region: db.data.region || "eastus",
        voice: db.data.voice || "zh-CN-XiaoxiaoNeural",
        style: db.data.style || "",
        rate: db.data.rate || "1.0",
        format: db.data.format || "audio-48khz-192kbitrate-mono-mp3",
      };
    },
    setValues: async (patch: Record<string, unknown>) => {
      const db = await getDB();
      const fields: (keyof TTSConfig)[] = ["key", "region", "voice", "style", "rate", "format"];
      for (const f of fields) {
        if (patch[f] !== undefined) {
          if (f === "key" && String(patch[f]).includes("••••••••")) {
            // keep existing key
          } else {
            (db.data as any)[f] = patch[f];
          }
        }
      }
      await db.write();
    },
  };
}

function maskSecret(val: string, visibleChars = 4): string {
  if (!val) return "(未配置)";
  if (val.length <= visibleChars * 2) return "••••••••";
  return `${val.slice(0, visibleChars)}••••••${val.slice(-visibleChars)}`;
}

export default new TTSPlugin();

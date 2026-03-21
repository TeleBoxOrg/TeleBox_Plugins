/**
 * Azure TTS Plugin - 微软语音合成
 * 使用 Azure Speech Service 将文本转换为语音
 */
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import axios from "axios";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";
import { getGlobalClient } from "@utils/globalClient";
import * as fs from "fs";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

/** 私聊删除命令：为双方删除；群/频道：仅自己删除 */
async function deleteCommandMessage(msg: Api.Message) {
    try {
        const isPrivate =
            (msg as any).isPrivate === true ||
            (msg.peerId instanceof (Api as any).PeerUser);

        if (isPrivate) {
            await (msg as any).delete({ revoke: true }); // 双向删除
        } else {
            await msg.delete(); // 普通删除
        }
    } catch { }
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

    // 仅保留中文、英文、数字和常见标点
    // const whitelistRegex = /[^\u4e00-\u9fa5a-zA-Z0-9\s，。？！、,?!.]/g;
    // cleanedText = cleanedText.replace(whitelistRegex, "");

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
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

    name = "tts";
    description = () => getHelpText();

    cmdHandlers = {
        tts: async (msg: Api.Message) => {
            const text = (msg.message || "").trim();
            const parts = text.split(/\s+/).slice(1);
            const subCmd = parts[0]?.toLowerCase() || "";

            const db = await getDB();

            // 帮助
            if (!subCmd && !msg.replyTo) {
                await msg.edit({ text: getHelpText(), parseMode: "html" });
                return;
            }

            // 配置
            if (subCmd === "config") {
                if (parts.length < 3) {
                    await msg.edit({ text: `❌ 用法: <code>${mainPrefix}tts config <key> <region></code>`, parseMode: "html" });
                    return;
                }
                const [, key, region] = parts;
                db.data.key = key;
                db.data.region = region;
                await db.write();

                // 遮挡 Key 显示
                const maskedKey = key.length > 8 ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : "***";
                await msg.edit({ text: `✅ 配置已更新\nKey: ${maskedKey}\nRegion: ${region}`, parseMode: "html" });
                return;
            }

            // 设置语音
            if (subCmd === "voice") {
                if (parts.length < 2) {
                    await msg.edit({ text: `❌ 用法: <code>${mainPrefix}tts voice <VoiceName></code>`, parseMode: "html" });
                    return;
                }
                const voice = parts[1];
                db.data.voice = voice;
                await db.write();
                await msg.edit({ text: `✅ 语音已设置为: <code>${voice}</code>`, parseMode: "html" });
                return;
            }

            // 查看配置
            if (subCmd === "list") {
                const { key, region, voice, style, rate } = db.data;
                const maskedKey = key ? (key.length > 8 ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : "***") : "未设置";
                await msg.edit({
                    text: `📋 <b>当前配置</b>\n\nKey: <code>${maskedKey}</code>\nRegion: <code>${region}</code>\nVoice: <code>${voice}</code>\nStyle: <code>${style || "默认"}</code>\nRate: <code>${rate || "1.0"}</code>`,
                    parseMode: "html"
                });
                return;
            }

            // 设置风格
            if (subCmd === "style") {
                const style = parts[1];
                if (!style) {
                    await msg.edit({ text: `❌ 用法: <code>${mainPrefix}tts style <style></code> (使用 clear 清除)`, parseMode: "html" });
                    return;
                }
                db.data.style = style === "clear" ? "" : style;
                await db.write();
                await msg.edit({ text: `✅ 风格已设置: <code>${db.data.style || "默认"}</code>`, parseMode: "html" });
                return;
            }

            // 设置语速
            if (subCmd === "rate") {
                const rateStr = parts[1];
                const rate = parseFloat(rateStr);
                if (isNaN(rate) || rate < 0.5 || rate > 2.0) {
                    await msg.edit({ text: `❌ 语速必须在 0.5 到 2.0 之间`, parseMode: "html" });
                    return;
                }
                db.data.rate = rateStr;
                await db.write();
                await msg.edit({ text: `✅ 语速已设置: <code>${rateStr}</code>`, parseMode: "html" });
                return;
            }

            // 获取可用音色列表
            if (subCmd === "voices") {
                if (!db.data.key || !db.data.region) {
                    await msg.edit({ text: `❌ 请先配置 Azure API Key 和 Region`, parseMode: "html" });
                    return;
                }

                await msg.edit({ text: "🔄 正在获取音色列表...", parseMode: "html" });

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
                        voices = voices.filter((v: any) => v.Locale.toLowerCase().includes(filter.toLowerCase()) || v.ShortName.toLowerCase().includes(filter.toLowerCase()));
                    }

                    if (voices.length === 0) {
                        await msg.edit({ text: `❌ 未找到匹配 "<code>${filter}</code>" 的音色`, parseMode: "html" });
                        return;
                    }

                    // 格式化输出
                    const lines = voices.map((v: any) => {
                        const gender = v.Gender === "Female" ? "👩" : (v.Gender === "Male" ? "👨" : "👤");
                        return `${gender} <code>${v.ShortName}</code> (${v.LocalName})`;
                    });

                    const resultText = `📋 <b>可用音色列表</b> (${filter})\n\n${lines.join("\n")}\n\n使用 <code>${mainPrefix}tts voice <Name></code> 设置`;

                    // 如果太长，发送文件
                    if (resultText.length > 4000) {
                        const buffer = Buffer.from(lines.join("\n"));
                        const client = await getGlobalClient();
                        if (!client) {
                            await msg.edit({ text: "❌ 客户端不可用", parseMode: "html" });
                            return;
                        }
                        await client.sendFile(msg.peerId, {
                            file: buffer,
                            attributes: [new Api.DocumentAttributeFilename({ fileName: `voices_${filter}.txt` })],
                            caption: `📋 <b>可用音色列表</b> (${filter}) - 共 ${voices.length} 个`,
                            parseMode: "html"
                        });
                        await deleteCommandMessage(msg);
                    } else {
                        await msg.edit({ text: resultText, parseMode: "html" });
                    }

                } catch (error: any) {
                    console.error("[TTS Plugin] Voices Error:", error);
                    await msg.edit({ text: `❌ 获取列表失败: ${error.message}`, parseMode: "html" });
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
            if (!textToSynthesize && msg.replyTo) {
                const client = await getGlobalClient();
                if (client) {
                    const replyToId = (msg.replyTo as any)?.replyToMsgId;
                    if (replyToId) {
                        const [repliedMsg] = await client.getMessages(msg.peerId, { ids: [replyToId] });
                        if (repliedMsg && repliedMsg.message) {
                            textToSynthesize = repliedMsg.message;
                        }
                    }
                }
            }

            // 如果既没有文本参数也没有引用文本，显示帮助
            if (!textToSynthesize) {
                await msg.edit({ text: getHelpText(), parseMode: "html" });
                return;
            }

            if (!db.data.key || !db.data.region) {
                await msg.edit({ text: `❌ 请先配置 Azure API Key 和 Region\n使用: <code>${mainPrefix}tts config <key> <region></code>`, parseMode: "html" });
                return;
            }

            await msg.edit({ text: "🔄 正在合成语音...", parseMode: "html" });

            const { key, region, voice, format, style, rate } = db.data;

            try {
                // 清理文本
                let cleanText = cleanTextForTTS(textToSynthesize);
                if (!cleanText) {
                    await msg.edit({ text: "❌ 文本为空或仅包含特殊字符", parseMode: "html" });
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
                    content = `<prosody rate="${rate}">${content}</prosody>`;
                }

                // 添加风格控制 (仅当 style 存在时)
                if (style) {
                    content = `<mstts:express-as style="${style}">${content}</mstts:express-as>`;
                }

                const ssml = `<speak version='1.0' xml:lang='en-US' xmlns:mstts='https://www.w3.org/2001/mstts'><voice xml:lang='en-US' name='${voice}'>${content}</voice></speak>`;

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
                    await msg.edit({ text: "⬆️ 正在上传..." });

                    const client = await getGlobalClient();
                    if (!client) throw new Error("Client not available");

                    const buffer = Buffer.from(response.data);

                    const tempDir = createDirectoryInTemp("tts");

                    const tempFilePath = path.join(tempDir, `tts_${Date.now()}.mp3`);
                    fs.writeFileSync(tempFilePath, buffer);

                    try {
                        // 发送语音
                        await client.sendFile(msg.peerId, {
                            file: tempFilePath,
                            voiceNote: true,
                            forceDocument: false,
                            attributes: [
                                new Api.DocumentAttributeAudio({
                                    duration: 0,
                                    voice: true,
                                    title: "TTS Audio",
                                    performer: "Azure TTS"
                                })
                            ]
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

            } catch (error: any) {
                console.error("[TTS Plugin] Error:", error);
                const errMsg = error.response ? `API Error: ${error.response.status} ${error.response.statusText}` : (error.message || "Unknown error");
                await msg.edit({ text: `❌ 合成失败: ${errMsg}`, parseMode: "html" });
            }
        }
    };
}

export default new TTSPlugin();

/**
 * Say Plugin - 自动语音合成 (MiMo / 火山引擎豆包)
 * 把你打的字自动转为语音，每个对话独立开关
 * 服务商主备：主失败自动回退到备
 */
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";
import axios from "axios";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";
import { getGlobalClient } from "@utils/runtimeManager";
import { safeGetMessages } from "@utils/safeGetMessages";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// execFile（无 shell）替代 exec，消除任何命令注入面。参数为数组，绝不拼接 shell 字符串。
const execFileAsync = promisify(execFile);

/* ===================== 通用工具 ===================== */

/** 会话唯一键：用 chatId 区分每个会话。
 *  注意：msg.peerId.toString() 会返回 "[object Object]"（所有会话相同），
 *  会导致开关变成全局生效，必须用 chatId（内部经 getPeerId 归一化为带符号 ID）。 */
function getChatKey(msg: Api.Message): string {
    const id = (msg as any).chatId;
    return id != null ? id.toString() : "";
}

/** 私聊删除命令：为双方删除；群/频道：仅自己删除 */
async function deleteCommandMessage(msg: Api.Message) {
    try {
        const isPrivate =
            (msg as any).isPrivate === true ||
            (msg as any).peerId instanceof (Api as any).PeerUser;
        if (isPrivate) {
            await (msg as any).delete({ revoke: true });
        } else {
            await msg.delete();
        }
    } catch { }
}

/** 清理文本（emoji/markdown 链接；合并连续标点） */
function cleanTextForTTS(text: string): string {
    if (!text) return "";
    let cleanedText = text;
    const broadSymbolRegex = new RegExp(
        "[" +
        "\u{1F600}-\u{1F64F}" +
        "\u{1F300}-\u{1F5FF}" +
        "\u{1F680}-\u{1F6FF}" +
        "\u{2600}-\u{26FF}" +
        "\u{2700}-\u{27BF}" +
        "\u{FE0F}" +
        "\u{200D}" +
        "]",
        "gu"
    );
    cleanedText = cleanedText.replace(broadSymbolRegex, "");
    cleanedText = cleanedText.replace(/([，。？！、,?!.])\1+/g, "$1");
    cleanedText = cleanedText.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");
    return cleanedText.trim();
}

function htmlEscape(text: unknown): string {
    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function codeTag(text: unknown): string {
    return `<code>${htmlEscape(text)}</code>`;
}

function maskKey(key: string): string {
    return key ? (key.length > 8 ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : "***") : "未设置";
}

/** 从 axios 错误中提取可读详情（含响应体 message/error/msg 字段） */
function describeAxiosError(e: any): string {
    if (!e) return "未知错误";
    const resp = e.response;
    if (!resp) return e.message || String(e);
    const body = resp.data;
    let detail = "";
    if (typeof body === "string") {
        detail = body.slice(0, 200);
    } else if (body && typeof body === "object") {
        detail = body.message || body.error || body.msg
            || (typeof body.data === "string" ? body.data : "")
            || JSON.stringify(body).slice(0, 200);
    }
    return `HTTP ${resp.status}${detail ? `: ${detail}` : ""}`;
}

/* ===================== 类型定义 ===================== */

type ProviderName = "mimo" | "volc" | "fish";

type MimoConfig = { apiKey: string; voice: string; endpoint: "standard" | "tokenplan" };
type VolcConfig = { apiKey: string; resourceId: string; voice: string };
type FishConfig = { apiKey: string; voice: string }; // voice 存 reference_id（友好名在设置时解析）

type SayConfig = {
    providers: { mimo: MimoConfig; volc: VolcConfig; fish: FishConfig };
    primary: ProviderName;
    speed: number;        // 0.5 ~ 2.0（火山 speech_rate；MiMo 通过 style 文本控制）
    style: string;        // MiMo 风格指令（火山忽略）
    translate: boolean;   // 语音 caption 是否追加多语言译文
    chats: Record<string, boolean>; // per-chat 自动开关
};

/** Fish Audio 内置角色名 → reference_id（来自 t 插件；设置音色时按友好名解析） */
const FISH_ROLES: Record<string, string> = {
    "薯薯": "cc1c9874effe4526883662166456513c", "麦当劳": "4066d617322e41abb30ed70eaeaf273f",
    "影视飓风": "91648d8a8d9841c5a1c54fb18e54ab04", "丁真": "54a5170264694bfc8e9ad98df7bd89c3",
    "雷军": "aebaa2305aa2452fbdc8f41eec852a79", "蔡徐坤": "e4642e5edccd4d9ab61a69e82d4f8a14",
    "邓紫棋": "3b55b3d84d2f453a98d8ca9bb24182d6", "周杰伦": "1512d05841734931bf905d0520c272b1",
    "周星驰": "faa3273e5013411199abc13d8f3d6445", "孙笑川": "e80ea225770f42f79d50aa98be3cedfc",
    "央视配音": "59cb5986671546eaa6ca8ae6f29f6d22", "阿诺": "daeda14f742f47b8ac243ccf21c62df8",
    "卢本伟": "24d524b57c5948f598e9b74c4dacc7ab", "电棍": "25d496c425d14109ba4958b6e47ea037",
    "炫狗": "b48533d37bed4ef4b9ad5b11d8b0b694", "阿梓": "c2a6125240f343498e26a9cf38db87b7",
    "七海": "a7725771e0974eb5a9b044ba357f6e13", "嘉然": "1d11381f42b54487b895486f69fb14fb",
    "东雪莲": "7af4d620be1c4c6686132f21940d51c5", "永雏塔菲": "e1cfccf59a1c4492b5f51c7c62a8abd2",
    "可莉": "626bb6d3f3364c9cbc3aa6a67300a664", "刻晴": "5611bf78886a4a9998f56538c4ec7d8c",
    "烧姐姐": "60d377ebaae44829ad4425033b94fdea", "AD学姐": "7f92f8afb8ec43bf81429cc1c9199cb1",
    "御姐": "f44181a3d6d444beae284ad585a1af37", "台湾女": "e855dc04a51f48549b484e41c4d4d4cc",
    "御女茉莉": "6ce7ea8ada884bf3889fa7c7fb206691", "真实女声": "c189c7cff21c400ba67592406202a3a0",
    "女大学生": "5c353fdb312f4888836a9a5680099ef0", "温情女学生": "a1417155aa234890aab4a18686d12849",
    "蒋介石": "918a8277663d476b95e2c4867da0f6a6", "李云龙": "2e576989a8f94e888bf218de90f8c19a",
    "姜文": "ee58439a2e354525bd8fa79380418f4d", "黑手": "f7561ff309bd4040a59f1e600f4f4338",
    "马保国": "794ed17659b243f69cfe6838b03fd31a", "罗永浩": "9cc8e9b9d9ed471a82144300b608bf7f",
    "祁同伟": "4729cb883a58431996b998f2fca7f38b", "郭继承": "ecf03a0cf954498ca0005c472ce7b141",
    "麦克阿瑟": "405736979e244634914add64e37290b0", "营销号": "9d2a825024ce4156a16ba3ff799c4554",
    "蜡笔小新": "60b9a847ba6e485fa8abbde1b9470bc4", "奶龙": "3d1cb00d75184099992ddbaf0fdd7387",
    "懒羊羊": "131c6b3a889543139680d8b3aa26b98d", "剑魔": "ffb55be33cbb4af19b07e9a0ef64dab1",
    "小明剑魔": "a9372068ed0740b48326cf9a74d7496a", "唐僧": "0fb04af381e845e49450762bc941508c",
    "孙悟空": "8d96d5525334476aa67677fb43059dc5", "王琨": "4f201abba2574feeae11e5ebf737859e",
    "麦辣鸡腿堡": "c293697468924f3089cd9b90520dbc16", "猪八戒": "4313e3ec56f14eb3946630dbdad01059",
    "夏(中配) 蔚蓝档案": "c5fca4f670214e3cb7fbb9d595552e6e", "蔚蓝档案阿洛娜": "6ec8168d8392467c82358a780b35c5ca",
    "蔚蓝档案星野": "057265ac020c41a9a91d57c747d3b4c0"
};

const FISH_DEFAULT_VOICE = FISH_ROLES["雷军"];

/** reference_id → 友好名（用于状态展示反查）；同 id 取首个名字 */
const FISH_ID_TO_NAME: Record<string, string> = (() => {
    const m: Record<string, string> = {};
    for (const [name, id] of Object.entries(FISH_ROLES)) {
        if (!(id in m)) m[id] = name;
    }
    return m;
})();

/** Fish 音色展示名：内置 id 反查友好名，否则回退到原始 id */
function fishVoiceLabel(voice: string): string {
    if (!voice) return "未设";
    return FISH_ID_TO_NAME[voice] || voice;
}

/** 渲染 Fish 内置角色分页列表（每页 20，对齐 t 插件） */
function renderFishRoleList(pageArg: string | undefined, cfg: SayConfig): string {
    const PAGE_SIZE = 20;
    const names = Object.keys(FISH_ROLES);
    const total = names.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const reqPage = pageArg && /^\d+$/.test(pageArg) ? parseInt(pageArg, 10) : 1;
    const page = Math.min(Math.max(reqPage, 1), totalPages);

    const start = (page - 1) * PAGE_SIZE;
    const slice = names.slice(start, start + PAGE_SIZE);
    const currentId = cfg.providers.fish.voice;
    const list = slice
        .map((n, i) => {
            const mark = FISH_ROLES[n] === currentId ? " ✅" : "";
            return `${start + i + 1}. ${htmlEscape(n)}${mark}`;
        })
        .join("\n");

    return (
        `🎭 <b>Fish 内置角色</b>（${total}） | 第 ${page}/${totalPages} 页\n` +
        `当前：${codeTag(fishVoiceLabel(currentId))}\n\n` +
        list +
        `\n\n• <code>${mainPrefix}say voice fish &lt;角色名&gt;</code> 切换\n` +
        `• <code>${mainPrefix}say voice fish list ${page < totalPages ? page + 1 : 1}</code> 翻页`
    );
}

const MIMO_ENDPOINTS: Record<MimoConfig["endpoint"], string> = {
    standard: "https://api.xiaomimimo.com/v1/chat/completions",
    tokenplan: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
};

const DEFAULT_CONFIG: SayConfig = {
    providers: {
        mimo: { apiKey: "", voice: "冰糖", endpoint: "standard" },
        volc: { apiKey: "", resourceId: "seed-tts-2.0", voice: "" },
        fish: { apiKey: "", voice: FISH_DEFAULT_VOICE },
    },
    primary: "mimo",
    speed: 1.0,
    style: "",
    translate: true,
    chats: {},
};

/** 补全/规范化配置，兼容旧字段缺失 */
function normalizeConfig(data: any): SayConfig {
    const d = data || {};
    const providers = d.providers || {};
    const ep = providers.mimo?.endpoint;
    const primary = d.primary === "volc" ? "volc" : d.primary === "fish" ? "fish" : "mimo";
    return {
        providers: {
            mimo: {
                apiKey: providers.mimo?.apiKey ?? "",
                voice: providers.mimo?.voice ?? "冰糖",
                endpoint: ep === "tokenplan" ? "tokenplan" : "standard",
            },
            volc: {
                apiKey: providers.volc?.apiKey ?? providers.volc?.token ?? "",
                resourceId: providers.volc?.resourceId ?? "seed-tts-2.0",
                voice: providers.volc?.voice ?? "",
            },
            fish: {
                apiKey: providers.fish?.apiKey ?? "",
                voice: providers.fish?.voice ?? FISH_DEFAULT_VOICE,
            },
        },
        primary,
        speed: typeof d.speed === "number" && !isNaN(d.speed) ? d.speed : 1.0,
        style: typeof d.style === "string" ? d.style : "",
        translate: typeof d.translate === "boolean" ? d.translate : true,
        chats: d.chats && typeof d.chats === "object" ? { ...d.chats } : {},
    };
}

const MAX_TEXT_LENGTH = 3000;

// 自动模式跳过门槛：纯文本超过此码点数则不转语音（保留原文）。仅作用于自动模式，手动 .say 不受限。
const AUTO_MAX_TEXT_LENGTH = 200;

// 多语言译文：恒定目标语言，展示层决定中文行是替换预设语言还是追加
const TRANSLATE_TARGETS = ["en", "ja", "ko", "zh-CN"] as const;
const LANG_FLAG: Record<string, string> = {
    "en": "🇺🇸 ",
    "ja": "🇯🇵 ",
    "ko": "🇰🇷 ",
};
const GENERIC_FLAG = "🇺🇳 ";
const CHINESE_FLAG = "🇨🇳 ";
const PRESET_TRANSLATION_LANGS = ["en", "ja", "ko"] as const;

/* ===================== 服务商 ===================== */

type SynthResult = { buffer: Buffer; ext: string };

// 每个服务商单次请求超时（毫秒）。超时即视为该服务商失败，
// 由 synthesize() 的回退循环自动切换到下一个已配置服务商，避免持续等待。
const PROVIDER_TIMEOUT_MS = 10000;

/** MiMo 是否已配置 */
function mimoConfigured(cfg: SayConfig): boolean {
    return !!cfg.providers.mimo.apiKey;
}

/** 火山豆包是否已配置 */
function volcConfigured(cfg: SayConfig): boolean {
    return !!cfg.providers.volc.apiKey;
}

/** Fish Audio 是否已配置 */
function fishConfigured(cfg: SayConfig): boolean {
    return !!cfg.providers.fish.apiKey;
}

function providerConfigured(cfg: SayConfig, p: ProviderName): boolean {
    if (p === "mimo") return mimoConfigured(cfg);
    if (p === "volc") return volcConfigured(cfg);
    return fishConfigured(cfg);
}

/** 是否已配置任意服务商 */
function anyProviderConfigured(cfg: SayConfig): boolean {
    return mimoConfigured(cfg) || volcConfigured(cfg) || fishConfigured(cfg);
}

/** MiMo 语音合成（OpenAI 兼容；文本放 assistant，风格放 user）
 *  MiMo 仅支持 wav/pcm16 → 需 ffmpeg 转 OPUS */
async function synthesizeMimo(text: string, cfg: SayConfig): Promise<SynthResult> {
    const m = cfg.providers.mimo;
    const messages: Array<{ role: string; content: string }> = [];
    if (cfg.style && cfg.style.trim()) {
        messages.push({ role: "user", content: cfg.style });
    }
    messages.push({ role: "assistant", content: text });

    const url = MIMO_ENDPOINTS[m.endpoint] || MIMO_ENDPOINTS.standard;

    try {
        const resp = await axios.post(
            url,
            {
                model: "mimo-v2.5-tts",
                messages,
                audio: {
                    format: "wav",
                    voice: m.voice || "mimo_default",
                },
            },
            {
                headers: {
                    "api-key": m.apiKey,
                    "Authorization": `Bearer ${m.apiKey}`,
                    "Content-Type": "application/json",
                    "User-Agent": "TeleBox-Say",
                },
                responseType: "json",
                timeout: PROVIDER_TIMEOUT_MS,
            }
        );
        const audioData = resp.data?.choices?.[0]?.message?.audio?.data;
        if (!audioData) {
            throw new Error("MiMo 未返回音频数据");
        }
        return { buffer: Buffer.from(audioData, "base64"), ext: "wav" };
    } catch (e: any) {
        throw new Error(`MiMo ${describeAxiosError(e)}`);
    }
}

/** 速度(0.5~2.0) → 火山 speech_rate([-50,100])：1.0→0, 2.0→100, 0.5→-50 */
function speedToSpeechRate(speed: number): number {
    const s = typeof speed === "number" && speed >= 0.5 && speed <= 2.0 ? speed : 1.0;
    return Math.round((s - 1.0) * 100);
}

/** 将流式响应的文本（可能含多个 JSON 对象）解析为数组 */
function parseJsonChunks(raw: string): any[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    // 1) 整体是一个 JSON 对象
    try {
        const one = JSON.parse(trimmed);
        return [one];
    } catch { /* 可能是多对象流，继续 */ }
    // 2) 按换行切分（NDJSON）
    const byNewline = trimmed.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const out: any[] = [];
    let bad = false;
    for (const line of byNewline) {
        try { out.push(JSON.parse(line)); } catch { bad = true; break; }
    }
    if (!bad && out.length > 0) return out;
    // 3) 按对象边界 }{ 切分（无分隔的拼接）
    const recombined = trimmed.replace(/\}\s*\{/g, "}\u0000{").split("\u0000");
    const out2: any[] = [];
    for (const piece of recombined) {
        try { out2.push(JSON.parse(piece.trim())); } catch { }
    }
    return out2;
}

/** 火山豆包语音合成（HTTP v3 单向流式；X-Api-Key 鉴权） */
async function synthesizeVolc(text: string, cfg: SayConfig): Promise<SynthResult> {
    const v = cfg.providers.volc;
    const requestId = crypto.randomUUID();

    let resp;
    try {
        resp = await axios.post(
            "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
            {
                req_params: {
                    text,
                    speaker: v.voice || "",
                    audio_params: {
                        format: "ogg_opus",
                        sample_rate: 48000,
                        speech_rate: speedToSpeechRate(cfg.speed),
                    },
                },
            },
            {
                headers: {
                    "X-Api-Key": v.apiKey,
                    "X-Api-Resource-Id": v.resourceId || "seed-tts-2.0",
                    "X-Api-Request-Id": requestId,
                    "Content-Type": "application/json",
                    "Connection": "keep-alive",
                    "User-Agent": "TeleBox-Say",
                },
                responseType: "text",
                timeout: PROVIDER_TIMEOUT_MS,
            }
        );
    } catch (e: any) {
        throw new Error(`Volc ${describeAxiosError(e)}`);
    }

    const chunks = parseJsonChunks(String(resp.data ?? ""));
    if (chunks.length === 0) {
        throw new Error("Volc 未返回可解析的数据");
    }

    // 火山成功码：文档示例为 0，实际线上为 20000000（均为成功）
    const VOLC_OK = new Set([0, 20000000]);
    // 错误码：任一 chunk 不在成功码集合内即视为失败（取第一个非成功的）
    for (const c of chunks) {
        if (typeof c?.code === "number" && !VOLC_OK.has(c.code)) {
            throw new Error(`Volc ${c.code}: ${c.message || "未知错误"}`);
        }
    }

    // 拼接所有 base64 音频片段（逐个解码后拼接 Buffer，保证安全）
    const buffers: Buffer[] = [];
    for (const c of chunks) {
        if (typeof c?.data === "string" && c.data.length > 0) {
            buffers.push(Buffer.from(c.data, "base64"));
        }
    }
    if (buffers.length === 0) {
        throw new Error("Volc 未返回音频数据");
    }
    return { buffer: Buffer.concat(buffers), ext: "ogg" };
}

/** Fish Audio 语音合成（reference_id 指定音色）
 *  返回 MP3 → 需 ffmpeg 转 OPUS（同 MiMo） */
async function synthesizeFish(text: string, cfg: SayConfig): Promise<SynthResult> {
    const f = cfg.providers.fish;
    try {
        const resp = await axios.post(
            "https://api.fish.audio/v1/tts",
            { text, reference_id: f.voice || FISH_DEFAULT_VOICE },
            {
                headers: {
                    "Authorization": `Bearer ${f.apiKey}`,
                    "Content-Type": "application/json",
                    "User-Agent": "TeleBox-Say",
                },
                responseType: "arraybuffer",
                timeout: PROVIDER_TIMEOUT_MS,
            }
        );
        const buffer = Buffer.from(resp.data);
        if (buffer.length === 0) {
            throw new Error("Fish 未返回音频数据");
        }
        return { buffer, ext: "mp3" };
    } catch (e: any) {
        // arraybuffer 响应下错误体是 Buffer，先解码为文本，避免 describeAxiosError 输出 {"type":"Buffer"...}
        const data = e?.response?.data;
        if (data && (Buffer.isBuffer(data) || data instanceof ArrayBuffer)) {
            try {
                const text = Buffer.from(data as any).toString("utf8");
                try { e.response.data = JSON.parse(text); }
                catch { e.response.data = text; }
            } catch { }
        }
        throw new Error(`Fish ${describeAxiosError(e)}`);
    }
}

/* ===================== OPUS 归一化（Telegram 语音要求） ===================== */

/* ---------- FFmpeg 查找 / 安装 ---------- */

const FFMPEG_BIN_NAME = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

/** 本地 ffmpeg 路径（assets/say/bin/ffmpeg[.exe]） */
function getLocalFfmpegPath(): string {
    const binDir = path.join(createDirectoryInAssets("say"), "bin");
    return path.join(binDir, FFMPEG_BIN_NAME);
}

/** 查找可用的 ffmpeg：本地二进制 → 系统 PATH；返回路径或 null */
async function findFfmpeg(): Promise<string | null> {
    // 1. 本地下载的二进制
    const local = getLocalFfmpegPath();
    if (fs.existsSync(local)) {
        if (process.platform !== "win32") {
            try { fs.chmodSync(local, 0o755); } catch { }
        }
        return local;
    }
    // 2. 系统 PATH（无 shell：参数数组）
    try {
        await execFileAsync(FFMPEG_BIN_NAME, ["-version"], { timeout: 5000 });
        return FFMPEG_BIN_NAME;
    } catch { }
    return null;
}

/** 平台对应的静态 ffmpeg 下载信息 */
function getFfmpegDownloadInfo(): { url: string; type: "tar.xz" | "zip"; binaryInArchive: string } | null {
    const p = process.platform;
    const a = process.arch;
    if (p === "linux" && a === "x64") {
        return {
            url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
            type: "tar.xz",
            binaryInArchive: "ffmpeg-master-latest-linux64-gpl/bin/ffmpeg",
        };
    }
    if (p === "linux" && a === "arm64") {
        return {
            url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
            type: "tar.xz",
            binaryInArchive: "ffmpeg-master-latest-linuxarm64-gpl/bin/ffmpeg",
        };
    }
    if (p === "win32" && a === "x64") {
        return {
            url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
            type: "zip",
            binaryInArchive: "ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe",
        };
    }
    if (p === "darwin") {
        return {
            url: "https://evermeet.cx/ffmpeg/getrelease/zip",
            type: "zip",
            binaryInArchive: "ffmpeg",
        };
    }
    return null;
}

/** 尝试包管理器安装 ffmpeg（Linux / macOS） */
async function tryPackageManagerInstall(): Promise<boolean> {
    const managers: Array<{ cmd: string; args: string }> = [];
    if (process.platform === "linux") {
        managers.push(
            { cmd: "apt-get", args: "install -y ffmpeg" },
            { cmd: "yum", args: "install -y ffmpeg" },
            { cmd: "dnf", args: "install -y ffmpeg" },
            { cmd: "apk", args: "add --no-cache ffmpeg" },
            { cmd: "pacman", args: "-S --noconfirm ffmpeg" },
        );
    }
    if (process.platform === "darwin") {
        managers.push({ cmd: "brew", args: "install ffmpeg" });
    }
    for (const { cmd, args } of managers) {
        try {
            await execFileAsync(cmd, ["--version"], { timeout: 5000 });
        } catch { continue; }
        try {
            await execFileAsync(cmd, args.split(/\s+/), { timeout: 300000 });
            const found = await findFfmpeg();
            return found !== null;
        } catch { }
    }
    return false;
}

/** 下载并安装 ffmpeg 静态二进制到 assets/say/bin/ */
async function downloadFfmpeg(progress?: (t: string) => Promise<void>): Promise<string> {
    const info = getFfmpegDownloadInfo();
    if (!info) {
        throw new Error(`暂不支持 ${process.platform}/${process.arch} 自动安装，请手动安装 ffmpeg`);
    }

    const binDir = path.join(createDirectoryInAssets("say"), "bin");
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

    const tempDir = createDirectoryInTemp("say");
    const archiveExt = info.type === "tar.xz" ? ".tar.xz" : ".zip";
    const archivePath = path.join(tempDir, `ffmpeg_dl_${Date.now()}${archiveExt}`);
    const extractDir = path.join(tempDir, `ffmpeg_ext_${Date.now()}`);

    try {
        // 下载
        if (progress) await progress("📥 正在下载 ffmpeg...");
        const resp = await axios.get(info.url, {
            responseType: "arraybuffer",
            timeout: 300000,
            maxRedirects: 10,
        });
        fs.writeFileSync(archivePath, Buffer.from(resp.data));

        // 解压
        if (progress) await progress("📦 正在解压...");
        if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });

        if (info.type === "tar.xz") {
            await execFileAsync("tar", ["-xf", archivePath, "-C", extractDir], { timeout: 120000 });
        } else {
            if (process.platform === "win32") {
                await execFileAsync(
                    "powershell",
                    ["-Command", `Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force`],
                    { timeout: 120000 }
                );
            } else {
                await execFileAsync("unzip", ["-o", archivePath, "-d", extractDir], { timeout: 120000 });
            }
        }

        // 复制 ffmpeg 二进制
        const srcPath = path.join(extractDir, info.binaryInArchive);
        if (!fs.existsSync(srcPath)) {
            throw new Error(`解压后未找到 ffmpeg（预期: ${info.binaryInArchive}）`);
        }

        const destPath = getLocalFfmpegPath();
        fs.copyFileSync(srcPath, destPath);
        if (process.platform !== "win32") {
            fs.chmodSync(destPath, 0o755);
        }

        // 验证（无 shell：参数数组）
        await execFileAsync(destPath, ["-version"], { timeout: 10000 });
        return destPath;
    } finally {
        try { fs.unlinkSync(archivePath); } catch { }
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { }
    }
}

/**
 * 归一化为 Telegram 语音所需的 OGG/Opus。
 * - 若已是 opus/ogg（如 Volc ogg_opus）→ 原样返回（无需 ffmpeg）
 * - 否则（MiMo wav）→ 用 ffmpeg 转码；ffmpeg 不可用则提示安装
 */
async function ensureOpus(input: Buffer, inputExt: string, tempDir: string): Promise<{ buffer: Buffer; ext: string }> {
    const e = (inputExt || "").toLowerCase();
    if (e === "ogg" || e === "opus") {
        return { buffer: input, ext: "ogg" };
    }
    const inFile = path.join(tempDir, `in_${Date.now()}.${e || "bin"}`);
    const outFile = path.join(tempDir, `out_${Date.now()}.ogg`);
    fs.writeFileSync(inFile, input);

    // 查找 ffmpeg（本地 → 系统 PATH）
    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) {
        try { fs.unlinkSync(inFile); } catch { }
        throw new Error("MiMo 返回 WAV，需 ffmpeg 转 OPUS。发送 .say ffmpeg install 一键安装");
    }

    try {
        await execFileAsync(
            ffmpegPath,
            ["-y", "-i", inFile, "-vn", "-acodec", "libopus", "-b:a", "64k", "-ar", "48000", "-ac", "1", outFile],
            { timeout: 180000 }
        );
        if (!fs.existsSync(outFile)) {
            throw new Error("ffmpeg 未生成输出文件");
        }
        return { buffer: fs.readFileSync(outFile), ext: "ogg" };
    } catch (err: any) {
        throw new Error("ffmpeg 转码 OPUS 失败，请确认 ffmpeg 可用（.say ffmpeg install）");
    } finally {
        try { fs.unlinkSync(inFile); } catch { }
        try { fs.unlinkSync(outFile); } catch { }
    }
}

/** 合成器：主失败自动回退到其余已配置服务商；返回所用服务商 */
async function synthesize(
    text: string,
    cfg: SayConfig,
    onProvider?: (provider: string, attempt: number) => void
): Promise<SynthResult & { provider: string }> {
    const primary: ProviderName = cfg.primary;
    // 主服务商优先，其余作为备选（保持 volc→mimo→fish 的稳定顺序）
    const rest: ProviderName[] = (["volc", "mimo", "fish"] as ProviderName[]).filter((p) => p !== primary);

    const order: ProviderName[] = [];
    if (providerConfigured(cfg, primary)) order.push(primary);
    for (const p of rest) {
        if (providerConfigured(cfg, p)) order.push(p);
    }

    if (order.length === 0) {
        throw new Error("未配置任何可用的服务商（请先设置 火山 / MiMo / Fish 的密钥）");
    }

    const synthFns: Record<ProviderName, (t: string, c: SayConfig) => Promise<SynthResult>> = {
        volc: synthesizeVolc,
        mimo: synthesizeMimo,
        fish: synthesizeFish,
    };

    const errors: string[] = [];
    for (let i = 0; i < order.length; i++) {
        const p = order[i];
        if (onProvider) onProvider(p, i + 1);
        try {
            const r = await synthFns[p](text, cfg);
            return { ...r, provider: p };
        } catch (e: any) {
            errors.push(`${p}: ${e?.message || e}`);
        }
    }
    throw new Error(errors.join(" | "));
}

/* ===================== 发送语音 ===================== */

const PROVIDER_LABEL: Record<string, string> = { volc: "火山豆包", mimo: "MiMo", fish: "Fish" };

/** 构建语音消息的引用 caption（原文引用条，国旗置于条内同行，截断到 Telegram caption 上限） */
function buildVoiceCaption(originalText: string): string {
    const CAP_LIMIT = 1000; // Telegram caption 上限 1024，留余量给标签
    let t = originalText || "";
    if (t.length > CAP_LIMIT) t = t.substring(0, CAP_LIMIT) + "…";
    return `<blockquote>${GENERIC_FLAG}${htmlEscape(t)}</blockquote>`;
}

/** 多语言翻译：EN/JA/KO/ZH 恒定请求。
 *  使用 @vitalets/google-translate-api（免费、无 key；与 gt 插件一致）。
 *  全部失败或模块加载失败 → 返回 []（调用方据此不改 caption）。 */
async function translateMulti(text: string): Promise<{ sourceLang: string; items: Array<{ lang: string; text: string }> }> {
    let translate: any;
    try {
        const mod: any = await import("@vitalets/google-translate-api");
        translate = mod.translate || mod.default;
        if (typeof translate !== "function") return { sourceLang: "", items: [] };
    } catch {
        return { sourceLang: "", items: [] };
    }

    const results = await Promise.allSettled(
        TRANSLATE_TARGETS.map((lang) => translate(text, { to: lang, timeout: 10000 }))
    );

    const out: Array<{ lang: string; text: string }> = [];
    // 源语言优先就地判定（翻译库的 from.language.iso 在部分版本里恒为空，会导致中文原文仍补中文译文）
    let sourceLang = detectSourceLang(text);
    results.forEach((r, i) => {
        if (r.status === "fulfilled") {
            const srcIso: string = r.value?.from?.language?.iso || "";
            if (!sourceLang && srcIso) {
                sourceLang = normalizeLang(srcIso);
            }
            const translated = r.value?.text;
            if (typeof translated === "string" && translated.trim()) {
                out.push({ lang: TRANSLATE_TARGETS[i], text: translated.trim() });
            }
        }
    });

    return { sourceLang, items: out };
}

/** 构建含译文的 caption：原文引用 + 各语言译文行（整体截断到 caption 上限） */
function buildTranslatedCaption(
    originalText: string,
    translationPack: { sourceLang: string; items: Array<{ lang: string; text: string }> }
): string {
    const CAP_LIMIT = 1000; // 与 buildVoiceCaption 一致，留余量给标签
    const quote = `<blockquote>${GENERIC_FLAG}${htmlEscape((originalText || "").slice(0, CAP_LIMIT))}</blockquote>`;
    const lines = buildTranslationLines(translationPack.items, translationPack.sourceLang);
    let body = lines.join("\n");
    // 给原文引用留出空间后，对译文整体做尾部截断
    const budget = CAP_LIMIT - Math.min((originalText || "").length, CAP_LIMIT);
    if (body.length > budget) body = body.slice(0, Math.max(0, budget)) + "…";
    return body ? `${quote}\n${body}` : quote;
}

function buildTranslationLines(translations: Array<{ lang: string; text: string }>, sourceLang: string): string[] {
    const byLang = new Map(translations.map((item) => [item.lang, item.text]));
    const lines: string[] = [];
    const normalizedSourceLang = normalizeLang(sourceLang);
    const zhText = byLang.get("zh-CN") || "";
    let replacedWithChinese = false;

    for (const lang of PRESET_TRANSLATION_LANGS) {
        const text = byLang.get(lang);
        if (!text) continue;
        if (!replacedWithChinese && normalizedSourceLang === lang && zhText) {
            lines.push(`<blockquote>${CHINESE_FLAG}${htmlEscape(zhText)}</blockquote>`);
            replacedWithChinese = true;
            continue;
        }
        lines.push(`<blockquote>${LANG_FLAG[lang] || GENERIC_FLAG}${htmlEscape(text)}</blockquote>`);
    }

    if (zhText && !replacedWithChinese && !normalizedSourceLang.startsWith("zh")) {
        lines.push(`<blockquote>${CHINESE_FLAG}${htmlEscape(zhText)}</blockquote>`);
    }

    if (lines.length === 0 && zhText && !normalizedSourceLang.startsWith("zh")) {
        lines.push(`<blockquote>${CHINESE_FLAG}${htmlEscape(zhText)}</blockquote>`);
    }

    return lines;
}

function normalizeLang(lang: string): string {
    const value = String(lang || "").trim().toLowerCase();
    if (value.startsWith("zh")) return "zh-CN";
    if (value.startsWith("en")) return "en";
    if (value.startsWith("ja")) return "ja";
    if (value.startsWith("ko")) return "ko";
    return value;
}

/** 按字符脚本就地判定源语言（不依赖翻译库的检测，后者在部分版本里返回空）。
 *  韩文谚文→ko；日文假名→ja；汉字（无假名）→zh-CN；拉丁字母→en；无法判定→""。
 *  注意顺序：先谚文、再假名（日文也含汉字，有假名即判为日文）、再汉字、最后拉丁。 */
function detectSourceLang(text: string): string {
    const t = String(text || "");
    if (!t) return "";
    if (/[가-힣ᄀ-ᇿ㄰-㆏]/.test(t)) return "ko";
    if (/[぀-ゟ゠-ヿ]/.test(t)) return "ja";
    if (/[一-鿿㐀-䶿豈-﫿]/.test(t)) return "zh-CN";
    if (/[A-Za-z]/.test(t)) return "en";
    return "";
}

/** 后台回填译文：翻译完成后编辑语音消息的 caption。
 *  完全隔离错误，绝不影响主流程，绝不改动用户原消息。 */
async function appendTranslations(sentMsg: any, originalText: string): Promise<void> {
    try {
        if (!sentMsg || typeof sentMsg.edit !== "function") return;
        const translations = await translateMulti(originalText);
        if (translations.items.length === 0) return;
        await sentMsg.edit({
            text: buildTranslatedCaption(originalText, translations),
            parseMode: "html",
        });
    } catch (e) {
        console.error("[Say Plugin] 译文回填失败：", e);
    }
}

/** 合成并发送语音；成功返回 true 及已发送的语音消息句柄（用于后续 caption 回填）。
 *  语音自带原文引用 caption，可携带 replyTo */
async function synthesizeAndSend(
    peerId: any,
    text: string,
    cfg: SayConfig,
    progress?: (t: string) => Promise<void>,
    replyToMsgId?: number
): Promise<{ ok: boolean; error?: string; sentMessage?: any }> {
    try {
        const originalText = text; // 清理前的原文，用于引用 caption
        let cleanText = cleanTextForTTS(text);
        if (!cleanText) {
            return { ok: false, error: "文本为空或仅包含特殊字符" };
        }
        if (cleanText.length > MAX_TEXT_LENGTH) {
            cleanText = cleanText.substring(0, MAX_TEXT_LENGTH);
        }

        if (progress) await progress("🔄 正在合成语音...");

        const { buffer: rawBuffer, ext: rawExt, provider } = await synthesize(cleanText, cfg, (p, attempt) => {
            // 不 await（同步通知；实际进度编辑由下面的 progress 调用驱动）
            if (attempt > 1) {
                progress?.(`🔄 主服务商失败，切换备用 ${PROVIDER_LABEL[p] || p}...`);
            }
        });

        const client = await getGlobalClient();
        if (!client) throw new Error("客户端不可用");

        const tempDir = createDirectoryInTemp("say");

        // 归一化为 Telegram 语音所需的 OGG/Opus（已是 ogg 则直接放行；否则 ffmpeg 转码）
        const needsConvert = (rawExt || "").toLowerCase() !== "ogg";
        if (needsConvert && progress) await progress(`🎵 ${PROVIDER_LABEL[provider] || provider} 合成完成，正在转换 OPUS...`);
        const { buffer: opusBuffer, ext } = await ensureOpus(rawBuffer, rawExt, tempDir);

        if (progress) await progress("⬆️ 正在上传语音...");

        const tempFilePath = path.join(tempDir, `say_${Date.now()}.${ext}`);
        fs.writeFileSync(tempFilePath, opusBuffer);

        let sentMessage: any;
        try {
            sentMessage = await client.sendFile(peerId, {
                file: tempFilePath,
                voiceNote: true,
                forceDocument: false,
                caption: buildVoiceCaption(originalText),
                parseMode: "html",
                replyTo: replyToMsgId,
                attributes: [
                    new Api.DocumentAttributeAudio({
                        duration: 0,
                        voice: true,
                        title: "Say Voice",
                        performer: PROVIDER_LABEL[provider] || provider,
                    }),
                ],
            });
        } finally {
            if (fs.existsSync(tempFilePath)) {
                try { fs.unlinkSync(tempFilePath); } catch { }
            }
        }

        return { ok: true, sentMessage };
    } catch (error: any) {
        // 优先用上游已提取的消息（synthesize 内已 describe），否则尝试 axios 提取
        const errMsg = error?.message
            ? error.message
            : describeAxiosError(error);
        return { ok: false, error: errMsg };
    }
}

/* ===================== 数据库 ===================== */

const DB_PATH = path.join(createDirectoryInAssets("say"), "config.json");

/* ===================== 帮助文本 ===================== */

const getHelpText = () => `🗣️ <b>Say 自动语音</b> (MiMo / 火山豆包)

<b>📝 自动模式：</b> 开启后，仅本会话生效；你发出的纯文本（含链接）会自动转为语音并删除原文。<i>带任何附件（图片/文件/语音等）的消息不转换；超过 ${AUTO_MAX_TEXT_LENGTH} 字的长文本也不转换、原文保留。</i>
• <code>${mainPrefix}say on</code> / <code>${mainPrefix}say off</code> - 本会话开关
• <code>${mainPrefix}say status</code> - 查看状态

<b>🎤 单次合成：</b>
• <code>${mainPrefix}say &lt;文本&gt;</code> - 合成指定文本
• <code>${mainPrefix}say</code>（回复消息）- 合成被回复消息的文字（自动忽略媒体）

<b>⚙️ 配置（全局）：</b>
• <code>${mainPrefix}say key mimo &lt;apiKey&gt;</code>
• <code>${mainPrefix}say key volc &lt;apiKey&gt;</code>
• <code>${mainPrefix}say key fish &lt;apiKey&gt;</code>
• <code>${mainPrefix}say endpoint &lt;standard|tokenplan&gt;</code> - MiMo 接入（通用/Token Plan）
• <code>${mainPrefix}say provider &lt;volc|mimo|fish&gt;</code> - 主服务商（其余自动作备）
• <code>${mainPrefix}say voice</code> - 查看音色
• <code>${mainPrefix}say voice mimo &lt;音色&gt;</code> - 如 冰糖 / Mia
• <code>${mainPrefix}say voice volc &lt;音色ID&gt;</code> - 如 zh_female_vv_uranus_bigtts
• <code>${mainPrefix}say voice fish &lt;角色名|reference_id&gt;</code> - 如 雷军 / 周杰伦
• <code>${mainPrefix}say voice fish list [页码]</code> - 查看 Fish 内置角色
• <code>${mainPrefix}say resource &lt;id&gt;</code> - 火山Resource ID (seed-tts-2.0/seed-icl-2.0)
• <code>${mainPrefix}say speed &lt;0.5~2.0&gt;</code> - 语速（火山）
• <code>${mainPrefix}say style &lt;指令&gt;</code> - MiMo 风格（自然语言）
• <code>${mainPrefix}say style clear</code> - 清除风格
• <code>${mainPrefix}say translate &lt;on|off&gt;</code> - 语音下方多语言译文（默认开）
• <code>${mainPrefix}say ffmpeg install</code> - 一键安装 FFmpeg（MiMo / Fish 必需）
• <code>${mainPrefix}say ffmpeg</code> - 查看 FFmpeg 状态

<b>💡 提示：</b>
• 主服务商失败会自动回退到其余已配置服务商
• 语音以 OGG/Opus 发送；火山原生 opus，MiMo(WAV)/Fish(MP3) 需 ffmpeg 转 OPUS
• 首次使用 MiMo 或 Fish 前请执行 <code>${mainPrefix}say ffmpeg install</code>
• 语速仅作用于火山；MiMo 通过 style 文本/标签控制
• 译文在语音发出后约 1~2 秒补现于 caption；原文与各语言译文均用 🇺🇳/🇺🇸/🇯🇵/🇰🇷/🇨🇳 国旗标注，非中文原文才显示 🇨🇳 中文译文
• Fish 角色名见 <code>${mainPrefix}say voice fish list</code>，更多音色: https://fish.audio/zh-CN/app/discovery/
• <i>注：自动模式失败时保留原文不转换</i>`;

/* ===================== 保留子命令 ===================== */

const RESERVED = ["on", "off", "status", "key", "provider", "voice", "speed", "style", "resource", "endpoint", "ffmpeg", "translate"];

/* ===================== 插件主体 ===================== */

class SayPlugin extends Plugin {
    name = "say";
    description = () => getHelpText();

    private dbPromise: Promise<any> | null = null;
    private db: any;
    // 自动模式串行队列：逐条处理，避免并发编辑混乱与语音乱序
    private autoQueue: Promise<void> = Promise.resolve();

    constructor() {
        super();
        this.dbPromise = this.initDB();
    }

    cleanup(): void {
        this.db = null;
        this.dbPromise = null;
        this.autoQueue = Promise.resolve();
    }

    private async initDB() {
        const raw = await JSONFilePreset(DB_PATH, DEFAULT_CONFIG);
        raw.data = normalizeConfig(raw.data);
        this.db = raw;
        return raw;
    }

    private async getDb() {
        if (!this.db && this.dbPromise) {
            await this.dbPromise;
        }
        return this.db;
    }

    cmdHandlers = {
        say: async (msg: Api.Message) => {
            const db = await this.getDb();
            if (!db) {
                await msg.edit({ text: "❌ 数据库初始化中，请稍后再试", parseMode: "html" });
                return;
            }
            const cfg: SayConfig = db.data;

            const raw = (msg.message || "").trim();
            const parts = raw.split(/\s+/).slice(1);
            const subCmd = (parts[0] || "").toLowerCase();

            /* ======== 配置 / 开关 ======== */
            if (RESERVED.includes(subCmd)) {
                await this.handleConfig(msg, parts, cfg, db);
                return;
            }

            /* ======== 单次合成 ======== */
            let textToSynthesize = "";
            const match = raw.match(/^\S+\s+([\s\S]*)/);
            if (match) textToSynthesize = match[1];

            // 无文本参数 → 取被回复消息的文字（媒体安全：只读 message/text，不碰 media）
            if (!textToSynthesize && msg.replyTo) {
                const client = await getGlobalClient();
                if (client) {
                    const replyToId = (msg.replyTo as any)?.replyToMsgId;
                    if (replyToId) {
                        const [repliedMsg] = await safeGetMessages(client, msg.peerId, { ids: [replyToId] });
                        if (repliedMsg) {
                            textToSynthesize = repliedMsg.message || (repliedMsg as any).text || "";
                        }
                    }
                }
            }

            if (!textToSynthesize) {
                await msg.edit({ text: getHelpText(), parseMode: "html" });
                return;
            }

            if (!anyProviderConfigured(cfg)) {
                await msg.edit({
                    text: `❌ 请先配置服务商密钥\n${mainPrefix}say key mimo <apiKey>\n${mainPrefix}say key volc <apiKey>\n${mainPrefix}say key fish <apiKey>`,
                    parseMode: "html",
                });
                return;
            }

            // 回复上下文：语音引用被回复的那条消息
            const replyToId = (msg.replyTo as any)?.replyToMsgId;

            const result = await synthesizeAndSend(
                msg.peerId,
                textToSynthesize,
                cfg,
                async (t) => { await msg.edit({ text: t, parseMode: "html" }); },
                replyToId,
            );

            if (result.ok) {
                await deleteCommandMessage(msg);
                // 非阻塞回填多语言译文（受 translate 开关控制；不影响语音延迟）
                if (cfg.translate && result.sentMessage) {
                    void appendTranslations(result.sentMessage, textToSynthesize);
                }
            } else {
                await msg.edit({ text: `❌ 合成失败: ${htmlEscape(result.error)}`, parseMode: "html" });
            }
        },
    };

    /* ===================== 配置子命令 ===================== */

    private async handleConfig(msg: Api.Message, parts: string[], cfg: SayConfig, db: any) {
        const chatId = getChatKey(msg);
        const [, a1, a2, a3] = parts;
        const sub = parts[0].toLowerCase();

        switch (sub) {
            /* 开关 */
            case "on": {
                cfg.chats[chatId] = true;
                await db.write();
                await msg.edit({ text: `✅ 本会话已开启自动语音`, parseMode: "html" });
                return;
            }
            case "off": {
                delete cfg.chats[chatId];
                await db.write();
                await msg.edit({ text: `✅ 本会话已关闭自动语音`, parseMode: "html" });
                return;
            }
            case "status": {
                const on = cfg.chats[chatId] === true;
                const ffmpegOk = (await findFfmpeg()) !== null;
                // 实际回退顺序：主 + 其余已配置服务商
                const rest = (["mimo", "volc", "fish"] as ProviderName[]).filter((p) => p !== cfg.primary && providerConfigured(cfg, p));
                const backupLabel = rest.length ? rest.join(" → ") : "无";
                await msg.edit({
                    text:
                        `🔍 <b>本会话自动语音：</b> ${on ? "开启 ✅" : "关闭 ❌"}\n` +
                        `🌐 <b>主服务商：</b> ${codeTag(cfg.primary)}（备 ${codeTag(backupLabel)}）\n` +
                        `🎵 <b>音色：</b> MiMo=${codeTag(cfg.providers.mimo.voice || "默认")} | 火山=${codeTag(cfg.providers.volc.voice || "未设")} | Fish=${codeTag(fishVoiceLabel(cfg.providers.fish.voice))}\n` +
                        `⚡ <b>语速：</b> ${codeTag(cfg.speed)}\n` +
                        `🎨 <b>风格：</b> ${codeTag(cfg.style || "默认")}\n` +
                        `🌍 <b>多语言译文：</b> ${cfg.translate ? "开启 ✅" : "关闭 ❌"}\n` +
                        `🌐 <b>MiMo接入：</b> ${codeTag(cfg.providers.mimo.endpoint === "tokenplan" ? "Token Plan" : "通用")}\n` +
                        `🔊 <b>火山Resource：</b> ${codeTag(cfg.providers.volc.resourceId || "seed-tts-2.0")}\n` +
                        `🔧 <b>FFmpeg：</b> ${ffmpegOk ? "已安装 ✅" : `未安装 ❌ (${mainPrefix}say ffmpeg install)`}`,
                    parseMode: "html",
                });
                return;
            }
            /* 密钥 */
            case "key": {
                const target = (a1 || "").toLowerCase();
                if (target === "mimo") {
                    if (!a2) {
                        await msg.edit({ text: `❌ 用法: <code>${mainPrefix}say key mimo &lt;apiKey&gt;</code>`, parseMode: "html" });
                        return;
                    }
                    cfg.providers.mimo.apiKey = a2;
                    await db.write();
                    await msg.edit({ text: `✅ MiMo Key 已设置: ${codeTag(maskKey(a2))}`, parseMode: "html" });
                    return;
                }
                if (target === "volc") {
                    if (!a2) {
                        await msg.edit({ text: `❌ 用法: <code>${mainPrefix}say key volc &lt;apiKey&gt;</code>`, parseMode: "html" });
                        return;
                    }
                    cfg.providers.volc.apiKey = a2;
                    await db.write();
                    await msg.edit({ text: `✅ 火山 API Key 已设置: ${codeTag(maskKey(a2))}`, parseMode: "html" });
                    return;
                }
                if (target === "fish") {
                    if (!a2) {
                        await msg.edit({ text: `❌ 用法: <code>${mainPrefix}say key fish &lt;apiKey&gt;</code>`, parseMode: "html" });
                        return;
                    }
                    cfg.providers.fish.apiKey = a2;
                    await db.write();
                    await msg.edit({ text: `✅ Fish API Key 已设置: ${codeTag(maskKey(a2))}`, parseMode: "html" });
                    return;
                }
                await msg.edit({ text: `❌ 用法: <code>${mainPrefix}say key &lt;mimo|volc|fish&gt; ...</code>`, parseMode: "html" });
                return;
            }
            /* 主服务商 */
            case "provider": {
                const p = (a1 || "").toLowerCase();
                if (p !== "mimo" && p !== "volc" && p !== "fish") {
                    await msg.edit({ text: `❌ 用法: <code>${mainPrefix}say provider &lt;mimo|volc|fish&gt;</code>`, parseMode: "html" });
                    return;
                }
                cfg.primary = p;
                await db.write();
                const rest = (["mimo", "volc", "fish"] as ProviderName[]).filter((x) => x !== p);
                await msg.edit({
                    text: `✅ 主服务商: ${codeTag(p)}（备 ${codeTag(rest.join(" → "))}）`,
                    parseMode: "html",
                });
                return;
            }
            /* 音色 */
            case "voice": {
                const target = (a1 || "").toLowerCase();
                if (!target) {
                    await msg.edit({
                        text: `🎵 MiMo=${codeTag(cfg.providers.mimo.voice || "默认")} | 火山=${codeTag(cfg.providers.volc.voice || "未设")} | Fish=${codeTag(fishVoiceLabel(cfg.providers.fish.voice))}\n设置: <code>${mainPrefix}say voice &lt;mimo|volc|fish&gt; &lt;音色&gt;</code>`,
                        parseMode: "html",
                    });
                    return;
                }
                if (target === "mimo") {
                    if (!a2) {
                        await msg.edit({ text: `❌ 用法: <code>${mainPrefix}say voice mimo &lt;音色&gt;</code>`, parseMode: "html" });
                        return;
                    }
                    cfg.providers.mimo.voice = parts.slice(2).join(" ");
                    await db.write();
                    await msg.edit({ text: `✅ MiMo 音色: ${codeTag(cfg.providers.mimo.voice)}`, parseMode: "html" });
                    return;
                }
                if (target === "volc") {
                    if (!a2) {
                        await msg.edit({ text: `❌ 用法: <code>${mainPrefix}say voice volc &lt;音色ID&gt;</code>`, parseMode: "html" });
                        return;
                    }
                    cfg.providers.volc.voice = a2;
                    await db.write();
                    await msg.edit({ text: `✅ 火山音色: ${codeTag(cfg.providers.volc.voice)}`, parseMode: "html" });
                    return;
                }
                if (target === "fish") {
                    // 列出内置角色（分页）：say voice fish list [页码]
                    if ((a2 || "").toLowerCase() === "list") {
                        await msg.edit({ text: renderFishRoleList(a3, cfg), parseMode: "html" });
                        return;
                    }
                    if (!a2) {
                        await msg.edit({
                            text: `❌ 用法: <code>${mainPrefix}say voice fish &lt;角色名|reference_id&gt;</code>\n查看角色: <code>${mainPrefix}say voice fish list</code>`,
                            parseMode: "html",
                        });
                        return;
                    }
                    // 支持含空格的角色名（如 "夏(中配) 蔚蓝档案"）：取命令后的完整串
                    const arg = parts.slice(2).join(" ").trim();
                    const resolvedId = FISH_ROLES[arg];
                    if (resolvedId) {
                        cfg.providers.fish.voice = resolvedId;
                        await db.write();
                        await msg.edit({ text: `✅ Fish 音色: ${codeTag(arg)}（ID: ${codeTag(resolvedId)}）`, parseMode: "html" });
                    } else {
                        // 不是内置名 → 当作原始 reference_id 存储
                        cfg.providers.fish.voice = arg;
                        await db.write();
                        const label = FISH_ID_TO_NAME[arg] ? `（${FISH_ID_TO_NAME[arg]}）` : "";
                        await msg.edit({ text: `✅ Fish 音色已设为 reference_id: ${codeTag(arg)}${label}`, parseMode: "html" });
                    }
                    return;
                }
                await msg.edit({ text: `❌ 用法: <code>${mainPrefix}say voice &lt;mimo|volc|fish&gt; &lt;音色&gt;</code>`, parseMode: "html" });
                return;
            }
            /* 语速 */
            case "speed": {
                const s = parseFloat(a1);
                if (isNaN(s) || s < 0.5 || s > 2.0) {
                    await msg.edit({ text: `❌ 语速须在 0.5 ~ 2.0 之间`, parseMode: "html" });
                    return;
                }
                cfg.speed = s;
                await db.write();
                await msg.edit({ text: `✅ 语速: ${codeTag(a1)}（作用于火山）`, parseMode: "html" });
                return;
            }
            /* 风格 */
            case "style": {
                if (!a1) {
                    await msg.edit({ text: `❌ 用法: <code>${mainPrefix}say style &lt;指令&gt;</code>（clear 清除）`, parseMode: "html" });
                    return;
                }
                cfg.style = a1 === "clear" ? "" : parts.slice(1).join(" ");
                await db.write();
                await msg.edit({ text: `✅ 风格: ${codeTag(cfg.style || "默认")}`, parseMode: "html" });
                return;
            }
            /* 多语言译文开关 */
            case "translate": {
                const v = (a1 || "").toLowerCase();
                if (v !== "on" && v !== "off") {
                    await msg.edit({
                        text:
                            `当前多语言译文: ${cfg.translate ? "开启 ✅" : "关闭 ❌"}\n` +
                            `用法: <code>${mainPrefix}say translate &lt;on|off&gt;</code>\n` +
                            `开启后语音 caption 会在原文下方追加多语言译文；非中文原文会显示 🇨🇳 中文译文`,
                        parseMode: "html",
                    });
                    return;
                }
                cfg.translate = v === "on";
                await db.write();
                await msg.edit({ text: `✅ 多语言译文已${cfg.translate ? "开启" : "关闭"}`, parseMode: "html" });
                return;
            }
            /* 火山 resource id */
            case "resource": {
                if (!a1) {
                    await msg.edit({
                        text: `当前火山 Resource ID: ${codeTag(cfg.providers.volc.resourceId || "seed-tts-2.0")}\n用法: <code>${mainPrefix}say resource &lt;id&gt;</code>\n如 seed-tts-2.0（预置音色）/ seed-icl-2.0（复刻音色）`,
                        parseMode: "html",
                    });
                    return;
                }
                cfg.providers.volc.resourceId = a1;
                await db.write();
                await msg.edit({ text: `✅ 火山 Resource ID: ${codeTag(a1)}`, parseMode: "html" });
                return;
            }
            /* MiMo 接入端点（通用 API / Token Plan API） */
            case "endpoint": {
                const cur = cfg.providers.mimo.endpoint === "tokenplan" ? "tokenplan" : "standard";
                if (!a1) {
                    await msg.edit({
                        text:
                            `当前 MiMo 接入: ${codeTag(cur === "tokenplan" ? "Token Plan" : "通用")}\n` +
                            `用法: <code>${mainPrefix}say endpoint &lt;standard|tokenplan&gt;</code>\n` +
                            `• standard — 通用 API（按量计费）\n` +
                            `• tokenplan — Token Plan API（订阅套餐）`,
                        parseMode: "html",
                    });
                    return;
                }
                const v = a1.toLowerCase();
                if (v !== "standard" && v !== "tokenplan") {
                    await msg.edit({ text: `❌ 用法: <code>${mainPrefix}say endpoint &lt;standard|tokenplan&gt;</code>`, parseMode: "html" });
                    return;
                }
                cfg.providers.mimo.endpoint = v as "standard" | "tokenplan";
                await db.write();
                await msg.edit({
                    text: `✅ MiMo 接入已切换为: ${codeTag(v === "tokenplan" ? "Token Plan" : "通用")}`,
                    parseMode: "html",
                });
                return;
            }
            /* FFmpeg 安装 / 状态 */
            case "ffmpeg": {
                const action = (a1 || "").toLowerCase();

                // .say ffmpeg install
                if (action === "install") {
                    const existing = await findFfmpeg();
                    if (existing) {
                        await msg.edit({ text: `✅ ffmpeg 已可用，无需重复安装\n📍 ${codeTag(existing)}`, parseMode: "html" });
                        return;
                    }

                    // 1) 尝试包管理器
                    await msg.edit({ text: "🔍 尝试通过包管理器安装...", parseMode: "html" });
                    try {
                        if (await tryPackageManagerInstall()) {
                            const p = await findFfmpeg();
                            await msg.edit({ text: `✅ ffmpeg 通过包管理器安装成功\n📍 ${codeTag(p || "ffmpeg")}`, parseMode: "html" });
                            return;
                        }
                    } catch { }

                    // 2) 下载静态二进制
                    try {
                        const p = await downloadFfmpeg(async (t) => {
                            try { await msg.edit({ text: t, parseMode: "html" }); } catch { }
                        });
                        await msg.edit({ text: `✅ ffmpeg 安装成功\n📍 ${codeTag(p)}`, parseMode: "html" });
                    } catch (e: any) {
                        await msg.edit({
                            text:
                                `❌ 自动安装失败: ${htmlEscape(e?.message || e)}\n\n` +
                                `请手动安装 ffmpeg：\n` +
                                `• Linux: <code>apt install ffmpeg</code> / <code>yum install ffmpeg</code>\n` +
                                `• macOS: <code>brew install ffmpeg</code>\n` +
                                `• Windows: https://www.gyan.dev/ffmpeg/builds/`,
                            parseMode: "html",
                        });
                    }
                    return;
                }

                // .say ffmpeg status（默认）
                const ffmpegPath = await findFfmpeg();
                if (ffmpegPath) {
                    let version = "";
                    try {
                        const { stdout } = await execFileAsync(ffmpegPath, ["-version"], { timeout: 5000 });
                        version = stdout.split("\n")[0] || "";
                    } catch { }
                    await msg.edit({
                        text:
                            `✅ <b>ffmpeg 可用</b>\n` +
                            `📍 ${codeTag(ffmpegPath)}\n` +
                            (version ? `🔧 ${htmlEscape(version)}` : ""),
                        parseMode: "html",
                    });
                } else {
                    await msg.edit({
                        text:
                            `❌ <b>ffmpeg 不可用</b>\n` +
                            `MiMo TTS 需要 ffmpeg 将 WAV 转为 OPUS\n` +
                            `使用 <code>${mainPrefix}say ffmpeg install</code> 一键安装`,
                        parseMode: "html",
                    });
                }
                return;
            }
        }
    }

    /* ===================== 监听所有消息（自动模式） ===================== */

    listenMessageHandler = async (msg: Api.Message) => {
        const savedMessage = (msg as any).savedPeerId;
        // 仅处理自己发出的消息
        if (!(msg.out || savedMessage)) return;
        // 需要有文字（纯媒体无文字则跳过）
        if (!msg.text) return;

        // 含任何附件则跳过：只有纯文本/纯语音才转语音。
        // 例外：网页链接预览（MessageMediaWebPage）属于纯文本消息，不算附件。
        // 这同时阻断了对插件自己发出的语音消息（带 media）的再次处理 → 防止无限循环。
        const media = (msg as any).media;
        if (media && media.className !== "MessageMediaWebPage") return;

        const chatId = getChatKey(msg);

        const db = await this.getDb();
        if (!db) return;
        const cfg: SayConfig = db.data;

        // 本会话未开启
        if (cfg.chats[chatId] !== true) return;

        const raw = msg.text.trim();

        // 跳过命令（动态前缀或 / 开头）
        const dynamicPrefixes = getPrefixes();
        if (raw.startsWith("/") || dynamicPrefixes.some((p) => raw.startsWith(p))) return;

        // 没有可用服务商则不自动转换（避免吃掉用户消息）
        if (!anyProviderConfigured(cfg)) return;

        // 长度门槛：超长文本不自动转语音，原文保留不动（仅自动模式）。
        // 按码点计数，避免 emoji/代理对被算成多个字符。
        if ([...raw].length > AUTO_MAX_TEXT_LENGTH) return;

        // 串行入队：逐条处理，避免多条消息并发导致进度编辑混乱、语音乱序。
        // 注意：必须在 then 回调内才创建任务（惰性），否则任务会立即并发执行，队列形同虚设。
        this.autoQueue = this.autoQueue
            .then(() => this.processAutoMessage(msg, raw, cfg))
            .catch((e) => { console.error("[Say Plugin] 自动队列异常：", e); });
    };

    /** 处理单条自动模式消息（在串行队列中执行） */
    private async processAutoMessage(msg: Api.Message, raw: string, cfg: SayConfig): Promise<void> {
        // 保存原文：失败时需恢复
        const originalText = msg.text;
        // 回复上下文：语音引用被回复的那条消息
        const replyToId = (msg.replyTo as any)?.replyToMsgId;

        // 进度提示：编辑当前消息的文字/caption
        const progress = async (t: string) => {
            try { await msg.edit({ text: t }); } catch { }
        };

        const result = await synthesizeAndSend(msg.peerId, raw, cfg, progress, replyToId);
        if (result.ok) {
            // 纯文本（含链接预览）：删除原消息（语音已作为新消息发送）
            await deleteCommandMessage(msg);
            // 非阻塞回填多语言译文（受 translate 开关控制；不影响语音延迟）
            if (cfg.translate && result.sentMessage) {
                void appendTranslations(result.sentMessage, raw);
            }
        } else {
            // 失败 → 恢复原文（避免进度提示吞掉用户消息）
            try { await msg.edit({ text: originalText }); } catch { }
            console.error("[Say Plugin] 自动合成失败，保留原文：", result.error);
        }
    }

    listenMessageHandlerIgnoreEdited = true;
}

export default new SayPlugin();

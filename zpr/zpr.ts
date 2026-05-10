// zpr Plugin - 随机纸片人插件
//@ts-nocheck
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { CustomFile } from "teleproto/client/uploads";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import path from "path";
import { promises as fs } from "fs";
import { JSONFilePreset } from "lowdb/node";
import axios from "axios";

// ==================== 工具函数 ====================

const htmlEscape = (text: string): string =>
    text.replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;',
        '"': '&quot;', "'": '&#x27;'
    }[m] || m));

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// ==================== 常量 ====================

const PROXY_HOSTS: Record<string, string> = {
    "pximg.net": "i.pximg.net",
    "pixiv.cat": "i.pixiv.cat",
    "pixiv.re": "i.pixiv.re",
    "pixiv.nl": "i.pixiv.nl"
};

const CONFIG_KEYS = { PROXY_HOST: "zpr_proxy_host" } as const;
const DEFAULT_CONFIG = { [CONFIG_KEYS.PROXY_HOST]: "i.pixiv.cat" };

const BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.2651.74"
};

const dataPath = createDirectoryInAssets("zpr");

// ==================== 类型定义 ====================

interface SetuData {
    pid: number;
    title: string;
    width: number;
    height: number;
    urls: { regular: string; original: string };
}

interface ApiResponse {
    data: SetuData[];
}

interface CaptionData {
    html: string;
    text: string;
    entities: any[];
}

interface DownloadedImage {
    filePath: string;
    caption: string;
    captionText: string;
    captionEntities: any[];
    hasSpoiler: boolean;
}

interface ParsedArgs {
    num: number;
    r18: boolean;
    tags: string[];
    isProxy: boolean;
    isHelp: boolean;
    proxyHost?: string;
}

// ==================== 配置管理 ====================

class ZprConfigManager {
    private static db: any = null;
    private static initialized = false;
    private static configPath: string;
    private static backupPath: string;
    private static isWriting = false;

    private static async init(): Promise<void> {
        if (this.initialized) return;
        try {
            await fs.mkdir(dataPath, { recursive: true });
            this.configPath = path.join(dataPath, "zpr_config.json");
            this.backupPath = path.join(dataPath, "zpr_config.backup.json");
            await this.validateAndRestore();
            this.db = await JSONFilePreset<Record<string, any>>(this.configPath, { ...DEFAULT_CONFIG });
            this.initialized = true;
        } catch {
            await this.handleInitError();
        }
    }

    private static async validateAndRestore(): Promise<void> {
        try {
            const exists = await fs.access(this.configPath).then(() => true).catch(() => false);
            if (exists) {
                JSON.parse(await fs.readFile(this.configPath, 'utf8'));
            }
        } catch {
            await this.restoreFromBackup();
        }
    }

    private static async restoreFromBackup(): Promise<void> {
        try {
            const backupExists = await fs.access(this.backupPath).then(() => true).catch(() => false);
            if (backupExists) {
                await fs.copyFile(this.backupPath, this.configPath);
            } else {
                await this.createDefaultConfig();
            }
        } catch {
            await this.createDefaultConfig();
        }
    }

    private static async createDefaultConfig(): Promise<void> {
        await fs.writeFile(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    }

    private static async handleInitError(): Promise<void> {
        this.initialized = false;
        this.db = null;
        await this.createDefaultConfig();
    }

    static async getProxyHost(): Promise<string> {
        await this.ensureInitialized();
        if (!this.db) return DEFAULT_CONFIG[CONFIG_KEYS.PROXY_HOST];
        return this.db.data[CONFIG_KEYS.PROXY_HOST] || DEFAULT_CONFIG[CONFIG_KEYS.PROXY_HOST];
    }

    static async setProxyHost(host: string): Promise<boolean> {
        await this.ensureInitialized();
        if (!this.db || this.isWriting) return false;
        this.isWriting = true;
        try {
            this.db.data[CONFIG_KEYS.PROXY_HOST] = host;
            return await this.writeConfigWithRetry();
        } finally {
            this.isWriting = false;
        }
    }

    private static async writeConfigWithRetry(): Promise<boolean> {
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                await this.db.write();
                return true;
            } catch {
                if (attempt === 5) throw new Error("写入失败");
                await new Promise(r => setTimeout(r, attempt * 200));
            }
        }
        return false;
    }

    private static async ensureInitialized(): Promise<void> {
        if (!this.initialized || !this.db) await this.init();
    }
}

// ==================== 帮助文本 ====================
const helpText = `🎨 <b>随机纸片人插件</b>

<b>命令格式：</b>
<code>${mainPrefix}zpr [参数]</code>

<b>可选参数：</b>
• <code>${mainPrefix}zpr</code> - 随机获取1张纸片人图片
• <code>${mainPrefix}zpr [数量]</code> - 获取指定数量图片（1-10）
• <code>${mainPrefix}zpr [标签]</code> - 按标签筛选图片
• <code>${mainPrefix}zpr [标签] [数量]</code> - 按标签获取指定数量
• <code>${mainPrefix}zpr r18</code> - 获取R18内容
• <code>${mainPrefix}zpr r18 [数量]</code> - 获取指定数量R18图片
• <code>${mainPrefix}zpr proxy</code> - 查看当前反代设置
• <code>${mainPrefix}zpr proxy [地址]</code> - 设置反代地址
• <code>${mainPrefix}zpr help</code> - 显示此帮助

<b>使用示例：</b>
• <code>${mainPrefix}zpr</code> - 随机1张
• <code>${mainPrefix}zpr 3</code> - 随机3张
• <code>${mainPrefix}zpr 萝莉</code> - 萝莉标签
• <code>${mainPrefix}zpr 萝莉 2</code> - 萝莉标签2张

<b>反代地址管理：</b>
• <code>${mainPrefix}zpr proxy</code> - 查看当前反代
• <code>${mainPrefix}zpr proxy i.pixiv.re</code> - 设置为pixiv.re
• <code>${mainPrefix}zpr proxy i.pixiv.cat</code> - 设置为pixiv.cat
• <code>${mainPrefix}zpr proxy i.pixiv.nl</code> - 设置为pixiv.nl

<b>说明：</b>
• 图片来源：Lolicon API
• 数量限制：1-10张
• 默认反代：i.pixiv.cat（优先推荐）`;

// ==================== 消息编辑 ====================

const editHtmlMessage = async (msg: Api.Message, text: string): Promise<void> => {
    try {
        await msg.edit({ text, parseMode: "html" });
    } catch {}
};

// ==================== Caption 构建 ====================

function buildCaption(title: string, pid: number, originalUrl: string, width: number, height: number): CaptionData {
    const html = `<b>🎨 ${htmlEscape(title)}</b>\n\n🆔 <b>作品ID：</b><a href="https://www.pixiv.net/artworks/${pid}">${pid}</a>\n🔗 <b>原图链接：</b><a href="${htmlEscape(originalUrl)}">点击查看高清</a>\n📐 <b>尺寸：</b><code>${width}×${height}</code>\n\n<i>📡 来源：Pixiv</i>`;

    let text = "";
    const entities: any[] = [];

    const append = (value: string): void => { text += value; };

    const addEntity = (Ctor: any, value: string, extra: Record<string, any> = {}): void => {
        const offset = text.length;
        append(value);
        entities.push(new Ctor({ offset, length: value.length, ...extra }));
    };

    addEntity(Api.MessageEntityBold, `🎨 ${title}`);
    append("\n\n🆔 ");
    addEntity(Api.MessageEntityBold, "作品ID：");
    addEntity(Api.MessageEntityTextUrl, String(pid), { url: `https://www.pixiv.net/artworks/${pid}` });
    append("\n🔗 ");
    addEntity(Api.MessageEntityBold, "原图链接：");
    addEntity(Api.MessageEntityTextUrl, "点击查看高清", { url: originalUrl });
    append("\n📐 ");
    addEntity(Api.MessageEntityBold, "尺寸：");
    addEntity(Api.MessageEntityCode, `${width}×${height}`);
    append("\n\n");
    addEntity(Api.MessageEntityItalic, "📡 来源：Pixiv");

    return { html, text, entities };
}

// ==================== 标签处理 ====================

function processTags(tagString: string): { query: string; hasOr: boolean } {
    if (!tagString) return { query: "", hasOr: false };

    if (tagString.includes("|")) {
        const tags = tagString.split("|")
            .map(t => t.trim())
            .filter(Boolean)
            .slice(0, 5);
        return {
            query: tags.map(encodeURIComponent).join("|"),
            hasOr: true
        };
    }

    const tags = tagString.replace(/,/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 5);
    const tagQuery = tags.map(encodeURIComponent).join("&tag=");
    return {
        query: tagQuery ? "&tag=" + tagQuery : "",
        hasOr: false
    };
}

// ==================== 参数解析 ====================

function parseCommandArgs(args: string[]): ParsedArgs {
    const result: ParsedArgs = {
        num: 1,
        r18: false,
        tags: [],
        isProxy: false,
        isHelp: false
    };

    for (const arg of args) {
        const lowerArg = arg.toLowerCase();

        if (lowerArg === 'proxy') {
            result.isProxy = true;
            continue;
        }
        if (lowerArg === 'help' || lowerArg === 'h') {
            result.isHelp = true;
            continue;
        }
        if (lowerArg === 'r18') {
            result.r18 = true;
            continue;
        }
        if (/^\d+$/.test(arg)) {
            result.num = Math.min(Math.max(1, parseInt(arg)), 10);
            continue;
        }
        if (arg) {
            result.tags.push(arg);
        }
    }

    // 检查 proxy 后面是否有主机名参数
    const proxyIndex = args.findIndex(a => a.toLowerCase() === 'proxy');
    if (proxyIndex !== -1 && args.length > proxyIndex + 1) {
        const possibleHost = args[proxyIndex + 1];
        if (isValidProxyHost(possibleHost)) {
            result.proxyHost = possibleHost;
        }
    }

    return result;
}

function getArgs(msg: Api.Message): string[] {
    const parts = (msg.text?.trim()?.split(/\r?\n/g) || [])[0]?.split(/\s+/) || [];
    const [, ...args] = parts;
    return args.filter(Boolean);
}

// ==================== 代理验证 ====================

function isValidProxyHost(host: string): host is string {
    return Object.values(PROXY_HOSTS).includes(host);
}

// ==================== API 调用 ====================

async function fetchSetuData(
    r18: number,
    tags: string,
    num: number,
    proxy: string
): Promise<SetuData[]> {
    const { query, hasOr } = processTags(tags);
    let apiUrl = `https://api.lolicon.app/setu/v2?num=${num}&r18=${r18}&size=regular&size=original&proxy=${proxy}&excludeAI=true`;

    if (query) {
        apiUrl += hasOr ? `&tag=${query}` : query;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await axios.get(apiUrl, {
            headers: BASE_HEADERS,
            timeout: 10000,
            signal: controller.signal
        });

        if (response.status !== 200) {
            throw new Error("连接二次元大门出错");
        }

        return (response.data as ApiResponse).data;
    } finally {
        clearTimeout(timeout);
    }
}

async function downloadImage(
    data: SetuData,
    index: number,
    isR18: boolean
): Promise<DownloadedImage | null> {
    const filePath = path.join(dataPath, `${data.pid}_${index}.jpg`);

    try {
        const response = await axios.get(data.urls.regular, {
            headers: BASE_HEADERS,
            timeout: 10000,
            responseType: 'arraybuffer'
        });

        if (response.status !== 200) return null;

        await fs.writeFile(filePath, response.data as any);
        const caption = buildCaption(
            data.title,
            data.pid,
            data.urls.original,
            data.width,
            data.height
        );

        return {
            filePath,
            caption: caption.html,
            captionText: caption.text,
            captionEntities: caption.entities,
            hasSpoiler: isR18
        };
    } catch {
        return null;
    }
}

// ==================== 消息发送 ====================

async function sendSingleImage(
    client: any,
    peerId: any,
    image: DownloadedImage,
    replyTo?: number
): Promise<void> {
    await client.sendFile(peerId, {
        file: image.filePath,
        caption: image.caption,
        parseMode: "html",
        replyTo,
        spoiler: image.hasSpoiler
    });
}

async function sendMultipleImages(
    client: any,
    peerId: any,
    images: DownloadedImage[],
    replyTo?: number
): Promise<void> {
    const multiMedia = [];

    for (const img of images) {
        const fileStats = await fs.stat(img.filePath);
        const fileBuffer = await fs.readFile(img.filePath);

        const customFile = new CustomFile(
            path.basename(img.filePath),
            fileStats.size,
            img.filePath,
            fileBuffer
        );

        const inputFile = await client.uploadFile({
            file: customFile,
            workers: 1
        });

        const uploadResult = await client.invoke(
            new Api.messages.UploadMedia({
                peer: peerId,
                media: new Api.InputMediaUploadedPhoto({
                    file: inputFile,
                    spoiler: img.hasSpoiler
                })
            })
        );

        multiMedia.push(
            new Api.InputSingleMedia({
                media: new Api.InputMediaPhoto({
                    id: new Api.InputPhoto({
                        id: uploadResult.photo.id,
                        accessHash: uploadResult.photo.accessHash,
                        fileReference: uploadResult.photo.fileReference
                    }),
                    spoiler: img.hasSpoiler
                }),
                randomId: Math.floor(Math.random() * 9007199254740992),
                message: img.captionText,
                entities: img.captionEntities
            })
        );
    }

    await client.invoke(
        new Api.messages.SendMultiMedia({
            peer: peerId,
            multiMedia,
            replyTo
        })
    );
}

async function sendImagesWithFallback(
    client: any,
    msg: Api.Message,
    images: DownloadedImage[]
): Promise<void> {
    const replyTo = msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId;

    try {
        if (images.length === 1) {
            await sendSingleImage(client, msg.peerId, images[0], replyTo);
        } else {
            await sendMultipleImages(client, msg.peerId, images, replyTo);
        }
    } catch (error: any) {
        console.error("[zpr] 发送失败，降级处理:", error.message);
        // 降级：逐张发送
        for (const img of images) {
            try {
                await sendSingleImage(client, msg.peerId, img, replyTo);
                await new Promise(r => setTimeout(r, 500));
            } catch {}
        }
    }
}

// ==================== 清理 ====================

async function cleanupTempFiles(images: DownloadedImage[]): Promise<void> {
    await Promise.allSettled(
        images.map(img => fs.unlink(img.filePath).catch(() => {}))
    );
}

// ==================== 命令处理 ====================

async function handleProxyCommand(
    msg: Api.Message,
    args: ParsedArgs
): Promise<void> {
    if (!args.proxyHost) {
        const currentHost = await ZprConfigManager.getProxyHost();
        await editHtmlMessage(msg, `🔗 当前反代: <code>${htmlEscape(currentHost)}</code>`);
        return;
    }

    await ZprConfigManager.setProxyHost(args.proxyHost);
    await editHtmlMessage(msg, `✅ 反代已设置为 <code>${htmlEscape(args.proxyHost)}</code>`);
}

async function handleZprCommand(
    msg: Api.Message,
    client: any,
    args: ParsedArgs
): Promise<void> {
    // 获取图片数据
    await editHtmlMessage(msg, "🔄 连接API...");
    const proxy = await ZprConfigManager.getProxyHost();
    const setuData = await fetchSetuData(args.r18 ? 1 : 0, args.tags.join(" "), args.num, proxy);

    if (!setuData.length) {
        await editHtmlMessage(msg, "❌ 没有找到匹配的纸片人");
        return;
    }

    // 下载图片
    await editHtmlMessage(msg, "📥 下载中...");
    const downloadPromises = setuData.map((data, i) =>
        downloadImage(data, i, args.r18)
    );
    const images = (await Promise.all(downloadPromises)).filter(
        (img): img is DownloadedImage => img !== null
    );

    if (!images.length) {
        await editHtmlMessage(msg, "❌ 所有图片下载失败");
        return;
    }

    // 发送图片
    await editHtmlMessage(msg, "📤 上传中...");
    await sendImagesWithFallback(client, msg, images);

    // 清理临时文件
    await cleanupTempFiles(images);

    // 删除命令消息
    try {
        await msg.delete({ revoke: true });
    } catch {}
}

// ==================== 插件主体 ====================

class ZprPlugin extends Plugin {
    cleanup(): void {}

    description = `随机纸片人插件\n\n${helpText}`;

    cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
        zpr: async (msg: Api.Message): Promise<void> => {
            try {
                const client = await getGlobalClient();
                if (!client) {
                    await editHtmlMessage(msg, "❌ 客户端未初始化");
                    return;
                }

                const args = parseCommandArgs(getArgs(msg));

                if (args.isHelp) {
                    await editHtmlMessage(msg, helpText);
                    return;
                }

                if (args.isProxy) {
                    await handleProxyCommand(msg, args);
                    return;
                }

                await handleZprCommand(msg, client, args);
            } catch (error: any) {
                console.error("[zpr] 插件错误:", error);
                await editHtmlMessage(
                    msg,
                    `❌ ${htmlEscape(error.message || String(error))}`
                );
            }
        }
    };
}

export default new ZprPlugin();
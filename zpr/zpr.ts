// zpr Plugin - 随机纸片人插件
import { Plugin, type PanelSettingsAdapter, type PanelSettingField, type PanelFieldType } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
import { getGlobalClient, tryGetCurrentGenerationContext } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import path from "path";
import { promises as fs } from "fs";
import { JSONFilePreset } from "lowdb/node";
import axios from "axios";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { htmlEscape } from "@utils/htmlEscape";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// pixiv反代服务器配置
const PROXY_HOSTS: Record<string, string> = {
    "pximg.net": "i.pximg.net",
    "pixiv.cat": "i.pixiv.cat",
    "pixiv.re": "i.pixiv.re",
    "pixiv.nl": "i.pixiv.nl"
};

const CONFIG_KEYS = {
    PROXY_HOST: "zpr_proxy_host"
};

const DEFAULT_CONFIG = {
    [CONFIG_KEYS.PROXY_HOST]: "i.pximg.net"
};

interface ZprConfig {
    [CONFIG_KEYS.PROXY_HOST]: string;
}

const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.2651.74"
};

const getHeaders = (proxyHost: string) => {
    // 当使用 i.pximg.net 时添加 Referer
    if (proxyHost === "i.pximg.net") {
        return {
            ...baseHeaders,
            "Host": proxyHost,  
            "Referer": "https://www.pixiv.net/"
        };
    }

    return baseHeaders;
};

const dataPath = createDirectoryInAssets("zpr");

async function lifecycleDelay(ms: number, label: string): Promise<void> {
    const lifecycle = tryGetCurrentGenerationContext();
    if (lifecycle) {
        await lifecycle.delay(ms, { label });
        return;
    }
    await new Promise(resolve => setTimeout(resolve, ms));
}

function scheduleAbort(controller: AbortController, ms: number, label: string): () => void {
    const lifecycle = tryGetCurrentGenerationContext();
    if (lifecycle) {
        const handle = lifecycle.setTimeout(() => controller.abort(), ms, { label });
        return () => clearTimeout(handle);
    }

    const handle = setTimeout(() => controller.abort(), ms);
    return () => clearTimeout(handle);
}

// 配置管理器
class ZprConfigManager {
    private static db: Awaited<ReturnType<typeof JSONFilePreset<ZprConfig>>> | null = null;
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
            
            // 尝试从备份恢复损坏的配置
            await this.validateAndRestore();
            
            this.db = await JSONFilePreset<ZprConfig>(
                this.configPath,
                { ...DEFAULT_CONFIG }
            );
            this.initialized = true;
            logger.info("[zpr] 配置初始化成功");
        } catch (error: unknown) {
            logger.error("[zpr] 初始化配置失败:", error);
            await this.handleInitError();
        }
    }

    private static async validateAndRestore(): Promise<void> {
        try {
            try { await fs.access(this.configPath); } catch (_e: unknown) { logger.debug("[zpr] 配置文件不存在，跳过验证"); return; }

            const configContent = await fs.readFile(this.configPath, 'utf8');
            JSON.parse(configContent); // 验证JSON格式
        } catch (_e: unknown) {
            logger.warn("[zpr] 配置文件损坏，尝试从备份恢复");
            await this.restoreFromBackup();
        }
    }

    private static async restoreFromBackup(): Promise<void> {
        try {
            try { await fs.access(this.backupPath); } catch (_e: unknown) { logger.debug("[zpr] 备份文件不存在，跳过恢复"); return; }
            await fs.copyFile(this.backupPath, this.configPath);
            logger.info("[zpr] 从备份恢复配置成功");
        } catch (error: unknown) {
            logger.error("[zpr] 备份恢复失败:", error);
            await this.createDefaultConfig();
        }
    }

    private static async createDefaultConfig(): Promise<void> {
        await fs.writeFile(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
        logger.info("[zpr] 创建默认配置");
    }

    private static async handleInitError(): Promise<void> {
        this.initialized = false;
        this.db = null;
        await this.createDefaultConfig();
    }

    static cleanup(): void {
        // 引用重置：清空静态 db 和初始化标志，便于 reload 后重新初始化。
        this.db = null;
        this.initialized = false;
        this.isWriting = false;
    }

    static async reinit(): Promise<void> {
        // 强制重新初始化，用于 reload 后的 setup
        this.initialized = false;
        this.db = null;
        await this.init();
    }

    private static async createBackup(): Promise<void> {
        try {
            try { await fs.access(this.configPath); } catch (_e: unknown) { logger.debug("[zpr] 配置文件不存在，跳过备份创建"); return; }
            await fs.copyFile(this.configPath, this.backupPath);
            logger.info("[zpr] 配置备份创建成功");
        } catch (error: unknown) {
            logger.warn("[zpr] 创建备份失败:", error);
        }
    }

    private static async writeConfigWithRetry(): Promise<boolean> {
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                await this.db!.write();
                logger.info("[zpr] 配置保存成功");
                return true;
            } catch (writeError: unknown) {
                logger.error(`[zpr] 第${attempt}次写入失败:`, writeError);
                if (attempt === 5) {
                    // 最后一次失败，尝试恢复备份
                    await this.restoreFromBackup();
                    throw writeError;
                }
                await lifecycleDelay(attempt * 200, "zpr:config-write-retry");
            }
        }
        return false;
    }

    private static async ensureInitialized(): Promise<void> {
        // 插件重新加载时强制重新初始化以从磁盘加载最新配置
        if (!this.initialized || !this.db) {
            await this.init();
        }
    }

    static async getProxyHost(): Promise<string> {
        await this.ensureInitialized();
        if (!this.db) return DEFAULT_CONFIG[CONFIG_KEYS.PROXY_HOST];
        return this.db.data[CONFIG_KEYS.PROXY_HOST] || DEFAULT_CONFIG[CONFIG_KEYS.PROXY_HOST];
    }

    static async setProxyHost(host: string): Promise<boolean> {
        await this.ensureInitialized();
        if (!this.db) {
            logger.error("[zpr] 数据库未初始化");
            return false;
        }

        // 防止并发写入
        if (this.isWriting) {
            logger.info("[zpr] 配置正在写入中，请稍后");
            return false;
        }

        this.isWriting = true;
        try {
            // 验证输入参数
            if (!host || typeof host !== 'string') {
                logger.error("[zpr] 无效的代理地址");
                return false;
            }

            // 创建备份
            await this.createBackup();

            // 更新配置数据
            this.db.data[CONFIG_KEYS.PROXY_HOST] = host;

            // 写入配置，增强重试机制
            return await this.writeConfigWithRetry();
        } catch (error: unknown) {
            logger.error("[zpr] 设置代理失败:", error);
            return false;
        } finally {
            this.isWriting = false;
        }
    }
}

// 帮助文本定义
const help_text = `🎨 <b>随机纸片人插件</b>

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

<b>可用反代地址：</b>
${Object.entries(PROXY_HOSTS).map(([key, value]) => `• <code>${value}</code> - ${key}`).join("\n")}`;

// 结果项类型
interface ResultItem {
    media: string;
    hasSpoiler: boolean;
    caption?: string;
}

async function editHtmlMessage(msg: MessageContext, text: string) {
    await msg.edit({ text: html(text), disableWebPreview: true });
}

async function getResult(msg: MessageContext, r18: number, tag: string, num: number): Promise<[ResultItem[] | null, string]> {
    const client = await getGlobalClient();
    if (!client) return [null, "客户端未初始化"];

    try {
        const proxyHost = await ZprConfigManager.getProxyHost();
        const apiUrl = `https://api.lolicon.app/setu/v2?r18=${r18}&num=${num}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`;

        const response = await axios.get(apiUrl, {
            headers: getHeaders(proxyHost),
            timeout: 15000,
        });

        if (response.data.code !== 0) {
            return [null, `API错误: ${response.data.msg || "未知错误"}`];
        }

        const data = response.data.data;
        if (!data || data.length === 0) {
            return [null, "未找到符合条件的图片"];
        }

        const photoList: ResultItem[] = [];

        for (const item of data) {
            let url = item.urls.original;
            
            // 替换为反代地址
            for (const [original, proxy] of Object.entries(PROXY_HOSTS)) {
                if (url.includes(original)) {
                    url = url.replace(original, proxy);
                    break;
                }
            }

            // 下载图片
            const controller = new AbortController();
            const abortFn = scheduleAbort(controller, 30000, "zpr:download-image");
            
            try {
                const imgResp = await axios.get(url, {
                    responseType: "arraybuffer",
                    headers: getHeaders(proxyHost),
                    signal: controller.signal,
                    timeout: 30000,
                });

                abortFn();

                if (imgResp.status !== 200 || !imgResp.data) {
                    throw new Error(`下载失败: ${imgResp.status}`);
                }

                const buffer = Buffer.from(imgResp.data);
                const ext = url.split('.').pop()?.split('?')[0] || "jpg";
                const fileName = `${item.pid}_${item.p}.${ext}`;
                const filePath = path.join(dataPath, fileName);
                
                await fs.writeFile(filePath, buffer);
                
                photoList.push({
                    media: filePath,
                    hasSpoiler: r18 === 1,
                    caption: `pid: ${item.pid}\nauthor: ${item.author}\ntags: ${item.tags.join(", ")}`
                });

            } catch (e: unknown) {
                abortFn();
                logger.warn(`[zpr] 下载图片失败 ${url}:`, e);
            }
        }

        if (photoList.length === 0) {
            return [null, "所有图片下载失败"];
        }

        return [photoList, "成功"];

    } catch (error: unknown) {
        logger.error("[zpr] API请求失败:", error);
        return [null, getErrorMessage(error) || "请求失败"];
    }
}

class ZprPlugin extends Plugin {
    description = help_text;

    cmdHandlers = {
        zpr: async (msg: MessageContext) => {
            try {
                const client = await getGlobalClient();

                // 标准参数解析
                const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
                const parts = lines?.[0]?.split(/\s+/) || [];
                const [, ...args] = parts;
                const sub = (args[0] || "").toLowerCase();

                // 处理帮助命令
                if (sub === "help" || sub === "h" || 
                    (args.length > 1 && (args[args.length - 1].toLowerCase() === "help" || args[args.length - 1].toLowerCase() === "h"))) {
                    await editHtmlMessage(msg, help_text);
                    return;
                }

                // 处理 proxy 子命令
                if (sub === "proxy") {
                    if (args.length === 1) {
                        // 查看当前反代设置
                        const currentProxy = await ZprConfigManager.getProxyHost();
                        await editHtmlMessage(msg, `🔗 <b>当前反代设置</b>\n\n<b>当前地址:</b> <code>${htmlEscape(currentProxy)}</code>\n\n<b>可用地址:</b>\n${Object.entries(PROXY_HOSTS).map(([key, value]) => 
`• <code>${htmlEscape(value)}</code> - ${htmlEscape(key)}`).join("\n")}\n\n<b>使用方法:</b>\n<code>${mainPrefix}zpr proxy [地址]</code> - 设置反代地址`);
                        return;
                    }
                    
                    // 设置反代地址
                    const newProxy = args[1];
                    const validHosts = Object.values(PROXY_HOSTS);
                    
                    if (!validHosts.includes(newProxy)) {
                        await editHtmlMessage(msg, `❌ <b>无效的反代地址</b>\n\n<b>可用地址:</b>\n${Object.entries(PROXY_HOSTS).map(([key, value]) => 
`• <code>${value}</code> - ${key}`).join("\n")}`);
                        return;
                    }
                    
                    const success = await ZprConfigManager.setProxyHost(newProxy);
                    if (success) {
                        await editHtmlMessage(msg, `✅ <b>反代地址已更新</b>\n\n<b>新地址:</b> <code>${htmlEscape(newProxy)}</code>\n\n设置已保存，下次获取图片时将使用新的反代地址。`);
                    } else {
                        await editHtmlMessage(msg, "❌ <b>设置失败</b>\n\n无法保存配置，请稍后重试。");
                    }
                    return;
                }
            
                // 解析参数
                let num = 1;
                let r18 = 0;
                let tag = "";
                
                if (args.length > 0) {
                    if (!isNaN(Number(args[0]))) {
                        num = Math.min(Math.max(1, Number(args[0])), 10);
                    } else if (args[0] === "r18") {
                        r18 = 1;
                        if (args.length > 1 && !isNaN(Number(args[1]))) {
                            num = Math.min(Math.max(1, Number(args[1])), 10);
                        }
                    } else if (args[0] !== "proxy") {
                        tag = args[0];
                        if (args.length > 1) {
                            if (!isNaN(Number(args[1]))) {
                                num = Math.min(Math.max(1, Number(args[1])), 10);
                            } else if (args[1] === "r18") {
                                r18 = 1;
                                if (args.length > 2 && !isNaN(Number(args[2]))) {
                                    num = Math.min(Math.max(1, Number(args[2])), 10);
                                }
                            }
                        }
                    }
                }

                await editHtmlMessage(msg, "🔄 正在前往二次元。。。");

                const [photoList, des] = await getResult(msg, r18, tag, num);
                
                if (!photoList) {
                    await editHtmlMessage(msg, `❌ <b>获取失败:</b> ${htmlEscape(des)}`);
                    return;
                }
                
                try {
                    await editHtmlMessage(msg, "📤 传送中。。。");
                } catch (e: unknown) { logger.error('[zpr] edit message failed:', e); }
                
                try {
                    // 逐个发送图片文件
                    for (const item of photoList) {
                        try {
                            await client.sendMedia(msg.chat.id, {
                                type: 'photo',
                                file: item.media,
                                fileName: path.basename(item.media),
                                spoiler: item.hasSpoiler,
                                ...(item.caption ? { caption: html(item.caption) } : {}),
                            }, {
                                replyTo: msg.replyToMessage?.id ?? undefined
                            });

                        } catch (error: unknown) {
                            const errorMsg = getErrorMessage(error)?.includes("CHAT_SEND_MEDIA_FORBIDDEN")
                                ? "此群组不允许发送媒体。"
                                : htmlEscape(`发送失败: ${getErrorMessage(error) || "未知错误"}`);
                            
                            await editHtmlMessage(msg, `❌ <b>发送失败:</b> ${errorMsg}`);
                            throw error; // 继续抛出错误以中断循环
                        } finally {
                            // 无论发送是否成功，都尝试清理临时文件
                            try {
                                await fs.unlink(item.media);
                                logger.info(`[zpr] 成功清理临时文件: ${item.media}`);
                            } catch (err: unknown) {
                                logger.warn(`[zpr] 清理图片文件失败: ${item.media}`, err);
                            }
                        }
                    }

                    try {
                        await msg.delete();
                    } catch (e: unknown) { logger.error('[zpr] delete message failed:', e); }
                } catch (error: unknown) {
                    logger.error("[zpr] 插件执行失败:", error);
                    await editHtmlMessage(msg, `❌ <b>插件执行失败:</b> ${htmlEscape(getErrorMessage(error) || "未知错误")}`);
                }
            } catch (error: unknown) {
                logger.error("[zpr] 插件执行失败:", error);
                await editHtmlMessage(msg, `❌ <b>插件执行失败:</b> ${htmlEscape(getErrorMessage(error) || "未知错误")}`);
            }
        }
    };

    // Panel Settings Adapter
    panelAdapter: PanelSettingsAdapter = {
        id: "zpr",
        title: "随机纸片人",
        description: "Lolicon API 图片获取：配置反代服务器",
        category: "插件配置",
        icon: "🎨",
        getSchema: (): PanelSettingField[] => [
            {
                key: "zpr_proxy_host",
                label: "反代服务器",
                type: "select",
                options: [
                    { value: "i.pximg.net", label: "官方 (i.pximg.net)" },
                    { value: "i.pixiv.cat", label: "pixiv.cat" },
                    { value: "i.pixiv.re", label: "pixiv.re" },
                    { value: "i.pixiv.nl", label: "pixiv.nl" },
                ],
                default: "i.pximg.net",
                description: "图片下载代理，默认官方 i.pximg.net",
            },
        ],
        getValues: async () => {
            const currentProxy = await ZprConfigManager.getProxyHost();
            return { zpr_proxy_host: currentProxy };
        },
        setValues: async (patch: Record<string, unknown>) => {
            if (typeof patch.zpr_proxy_host === "string") {
                await ZprConfigManager.setProxyHost(patch.zpr_proxy_host);
            }
        },
    };
}

export default new ZprPlugin();
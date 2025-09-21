import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import path from "path";
import fs from "fs/promises";
import axios from "axios";

// HTML转义（每个插件必须实现）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// pixiv反代服务器配置
const PROXY_HOSTS = {
    "pixiv.re": "i.pixiv.re",
    "pixiv.cat": "i.pixiv.cat",
    "pixiv.nl": "i.pixiv.nl"
};

const CONFIG_KEYS = {
    PROXY_HOST: "zpr_proxy_host"
};

const DEFAULT_CONFIG = {
    [CONFIG_KEYS.PROXY_HOST]: "i.pixiv.re"
};

const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.2651.74"
};
const dataPath = createDirectoryInAssets("zpr");

// 配置管理器
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
            
            // 尝试从备份恢复损坏的配置
            await this.validateAndRestore();
            
            this.db = await JSONFilePreset<Record<string, any>>(
                this.configPath,
                { ...DEFAULT_CONFIG }
            );
            this.initialized = true;
            console.log("[zpr] 配置初始化成功");
        } catch (error) {
            console.error("[zpr] 初始化配置失败:", error);
            await this.handleInitError();
        }
    }

    private static async validateAndRestore(): Promise<void> {
        try {
            const configExists = await fs.access(this.configPath).then(() => true).catch(() => false);
            if (!configExists) return;

            const configContent = await fs.readFile(this.configPath, 'utf8');
            JSON.parse(configContent); // 验证JSON格式
        } catch (error) {
            console.warn("[zpr] 配置文件损坏，尝试从备份恢复");
            await this.restoreFromBackup();
        }
    }

    private static async restoreFromBackup(): Promise<void> {
        try {
            const backupExists = await fs.access(this.backupPath).then(() => true).catch(() => false);
            if (backupExists) {
                await fs.copyFile(this.backupPath, this.configPath);
                console.log("[zpr] 从备份恢复配置成功");
            }
        } catch (error) {
            console.error("[zpr] 备份恢复失败:", error);
            await this.createDefaultConfig();
        }
    }

    private static async createDefaultConfig(): Promise<void> {
        await fs.writeFile(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
        console.log("[zpr] 创建默认配置");
    }

    private static async handleInitError(): Promise<void> {
        this.initialized = false;
        this.db = null;
        await this.createDefaultConfig();
    }

    private static async createBackup(): Promise<void> {
        try {
            const configExists = await fs.access(this.configPath).then(() => true).catch(() => false);
            if (configExists) {
                await fs.copyFile(this.configPath, this.backupPath);
                console.log("[zpr] 配置备份创建成功");
            }
        } catch (error) {
            console.warn("[zpr] 创建备份失败:", error);
        }
    }

    private static async writeConfigWithRetry(): Promise<boolean> {
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                await this.db.write();
                console.log("[zpr] 配置保存成功");
                return true;
            } catch (writeError: any) {
                console.error(`[zpr] 第${attempt}次写入失败:`, writeError);
                if (attempt === 5) {
                    // 最后一次失败，尝试恢复备份
                    await this.restoreFromBackup();
                    throw writeError;
                }
                await new Promise(resolve => setTimeout(resolve, attempt * 200));
            }
        }
        return false;
    }

    private static async ensureInitialized(): Promise<void> {
        // 插件重新加载时强制重新初始化以从磁盘加载最新配置
        if (!this.initialized || !this.db) {
            this.initialized = false;
            await this.init();
        }
    }

    static async getProxyHost(): Promise<string> {
        await this.ensureInitialized();
        if (!this.db) return DEFAULT_CONFIG[CONFIG_KEYS.PROXY_HOST];
        return this.db.data[CONFIG_KEYS.PROXY_HOST] || DEFAULT_CONFIG[CONFIG_KEYS.PROXY_HOST];
    }

    static async setProxyHost(host: string): Promise<boolean> {
        await this.init();
        if (!this.db) {
            console.error("[zpr] 数据库未初始化");
            return false;
        }

        // 防止并发写入
        if (this.isWriting) {
            console.log("[zpr] 配置正在写入中，请稍后");
            return false;
        }

        this.isWriting = true;
        try {
            // 验证输入参数
            if (!host || typeof host !== 'string') {
                console.error("[zpr] 无效的代理地址");
                return false;
            }

            // 创建备份
            await this.createBackup();
            
            // 更新配置数据
            this.db.data[CONFIG_KEYS.PROXY_HOST] = host;
            
            // 写入配置，增强重试机制
            return await this.writeConfigWithRetry();
        } catch (error) {
            console.error("[zpr] 设置代理失败:", error);
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
• <code>${mainPrefix}zpr help</code> - 显示此帮助

<b>使用示例：</b>
<code>${mainPrefix}zpr</code> - 随机1张
<code>${mainPrefix}zpr 3</code> - 随机3张
<code>${mainPrefix}zpr 萝莉</code> - 萝莉标签
<code>${mainPrefix}zpr 萝莉 2</code> - 萝莉标签2张

<b>反代地址管理：</b>
<code>${mainPrefix}zpr proxy</code> - 查看当前反代
<code>${mainPrefix}zpr proxy i.pixiv.re</code> - 设置为pixiv.re
<code>${mainPrefix}zpr proxy i.pixiv.cat</code> - 设置为pixiv.cat
<code>${mainPrefix}zpr proxy i.pixiv.nl</code> - 设置为pixiv.nl

<b>说明：</b>
• 图片来源：Lolicon API
• 数量限制：1-10张
• 默认反代：i.pixiv.re（优先推荐）`;

interface SetuData {
    pid: number;
    title: string;
    width: number;
    height: number;
    urls: {
        regular: string;
        original: string;
    };
}

interface ApiResponse {
    data: SetuData[];
}

interface MediaGroup {
    media: string;
    type: string;
    caption?: string;
    hasSpoiler?: boolean;
}

async function getResult(message: Api.Message, r18 = 0, tag = "", num = 1): Promise<[MediaGroup[] | null, string]> {
    const client = await getGlobalClient();
    if (!client) {
        return [null, "❌ 客户端未初始化"];
    }
    
    const des = "出错了，没有纸片人看了。";
    
    try {
        const proxyHost = await ZprConfigManager.getProxyHost();
        const response = await axios.get(
            `https://api.lolicon.app/setu/v2?num=${num}&r18=${r18}&tag=${tag}&size=regular&size=original&proxy=${proxyHost}&excludeAI=true`,
            { headers, timeout: 10000 }
        );
        
        const spoiler = r18 === 1;
        
        if (response.status !== 200) {
            return [null, "连接二次元大门出错。。。"];
        }
        
        await message.edit({
            text: "🔍 已进入二次元 . . .",
            parseMode: "html"
        });
        
        const result: SetuData[] = (response.data as ApiResponse).data;
        const setuList: MediaGroup[] = [];
        
        await message.edit({
            text: "📥 努力获取中 。。。",
            parseMode: "html"
        });
        
        for (let i = 0; i < Math.min(num, result.length); i++) {
            const item = result[i];
            if (!item) continue;
            const urls = item.urls.regular;
            const original = item.urls.original;
            const { pid, title, width, height } = item;
            const imgName = `${pid}_${i}.jpg`;
            const filePath = path.join(dataPath, imgName);
            
            try {
                const imgResponse = await axios.get(urls, {
                    headers,
                    timeout: 10000,
                    responseType: 'arraybuffer'
                });
                
                if (imgResponse.status !== 200) {
                    continue;
                }
                
                await fs.writeFile(filePath, Buffer.from(imgResponse.data));
                
                setuList.push({
                    type: 'photo',
                    media: filePath,
                    caption: `<b>🎨 ${htmlEscape(title)}</b>

🆔 <b>作品ID:</b> <a href="https://www.pixiv.net/artworks/${pid}">${pid}</a>
🔗 <b>原图:</b> <a href="${htmlEscape(original)}">高清查看</a>
📐 <b>尺寸:</b> <code>${width}×${height}</code>

<i>📡 来源: Pixiv</i>`,
                    hasSpoiler: spoiler
                });
            } catch (error) {
                return [null, "连接二次元出错。。。"];
            }
        }
        
        return [setuList.length > 0 ? setuList : null, des];
    } catch (error) {
        return [null, "解析JSON出错。"];
    }
}

class ZprPlugin extends Plugin {
    description: string = `随机纸片人插件\n\n${help_text}`;
    
    cmdHandlers = {
        zpr: async (msg: Api.Message): Promise<void> => {
        const client = await getGlobalClient();
        if (!client) {
            await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
            return;
        }

        // 标准参数解析
        const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
        const parts = lines?.[0]?.split(/\s+/) || [];
        const [, ...args] = parts;
        const sub = (args[0] || "").toLowerCase();

        try {
            // 处理 help 在前的情况：.zpr help
            if (sub === "help" || sub === "h") {
                await msg.edit({ text: help_text, parseMode: "html" });
                return;
            }

            // 处理 help 在后的情况：.zpr [params] help  
            if (args.length > 1 && (args[args.length - 1].toLowerCase() === "help" || args[args.length - 1].toLowerCase() === "h")) {
                await msg.edit({ text: help_text, parseMode: "html" });
                return;
            }
            // 处理 proxy 子命令
            if (sub === "proxy") {
                if (args.length === 1) {
                    // 查看当前反代设置
                    const currentProxy = await ZprConfigManager.getProxyHost();
                    await msg.edit({
                        text: `🔗 <b>当前反代设置</b>

<b>当前地址:</b> <code>${htmlEscape(currentProxy)}</code>

<b>可用地址:</b>
${Object.entries(PROXY_HOSTS).map(([key, value]) => 
`• <code>${value}</code> - ${key}`).join('\n')}

<b>使用方法:</b>
<code>${mainPrefix}zpr proxy [地址]</code> - 设置反代地址`,
                        parseMode: "html"
                    });
                    return;
                } else {
                    // 设置反代地址
                    const newProxy = args[1];
                    const validHosts = Object.values(PROXY_HOSTS);
                    
                    if (!validHosts.includes(newProxy)) {
                        await msg.edit({
                            text: `❌ <b>无效的反代地址</b>

<b>可用地址:</b>
${Object.entries(PROXY_HOSTS).map(([key, value]) => 
`• <code>${value}</code> - ${key}`).join('\n')}`,
                            parseMode: "html"
                        });
                        return;
                    }
                    
                    const success = await ZprConfigManager.setProxyHost(newProxy);
                    if (success) {
                        await msg.edit({
                            text: `✅ <b>反代地址已更新</b>

<b>新地址:</b> <code>${htmlEscape(newProxy)}</code>

设置已保存，下次获取图片时将使用新的反代地址。`,
                            parseMode: "html"
                        });
                    } else {
                        await msg.edit({
                            text: "❌ <b>设置失败</b>\n\n无法保存配置，请稍后重试。",
                            parseMode: "html"
                        });
                    }
                    return;
                }
            }
            
            // 参数解析逻辑        
            let num = 1;
            let r18 = 0;
            let tag = "";
            
            // 参数解析逻辑
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
                } else {
                    // proxy 命令已在上面处理
                    return;
                }
            }
        
            await msg.edit({
                text: "🔄 正在前往二次元。。。",
                parseMode: "html"
            });
        
            const [photoList, des] = await getResult(msg, r18, tag, num);
            
            if (!photoList) {
                try {
                    await fs.rm(dataPath, { recursive: true, force: true });
                } catch {}
                await msg.edit({
                    text: `❌ <b>获取失败:</b> ${htmlEscape(des)}`,
                    parseMode: "html"
                });
                return;
            }
            
            try {
                await msg.edit({
                    text: "📤 传送中。。。",
                    parseMode: "html"
                });
            } catch {}
            
            try {
                // 逐个发送图片文件
                for (const item of photoList) {
                    await client.sendFile(msg.peerId, {
                        file: item.media,
                        caption: item.caption,
                        parseMode: 'html',
                        replyTo: msg.replyTo?.replyToMsgId
                    });
                }
            } catch (error: any) {
                const errorMsg = error.message?.includes("CHAT_SEND_MEDIA_FORBIDDEN")
                    ? "此群组不允许发送媒体。"
                    : `发送失败: ${htmlEscape(error.message || "未知错误")}`;
                    
                await msg.edit({
                    text: `❌ <b>发送失败:</b> ${errorMsg}`,
                    parseMode: "html"
                });
                return;
            }
        } catch (error: any) {
            console.error("[zpr] 插件执行失败:", error);
            await msg.edit({
                text: `❌ <b>插件执行失败:</b> ${htmlEscape(error.message || "未知错误")}`,
                parseMode: "html"
            });
            return;
        }
        
        try {
            await fs.rm(dataPath, { recursive: true, force: true });
        } catch {}
        
        try {
            await msg.delete({ revoke: true });
        } catch {}
        }
    };
}

export default new ZprPlugin();

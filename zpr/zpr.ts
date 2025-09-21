import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
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

// pixiv反代服务器
const pixivImgHost = "i.pixiv.cat";
const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.2651.74"
};
const dataPath = createDirectoryInAssets("zpr");

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
• <code>${mainPrefix}zpr help</code> - 显示此帮助

<b>使用示例：</b>
<code>${mainPrefix}zpr</code> - 随机1张
<code>${mainPrefix}zpr 3</code> - 随机3张
<code>${mainPrefix}zpr 萝莉</code> - 萝莉标签
<code>${mainPrefix}zpr 萝莉 2</code> - 萝莉标签2张

<b>说明：</b>
• 图片来源：Lolicon API
• 数量限制：1-10张
• 使用pixiv反代服务器`;

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
        const response = await axios.get(
            `https://api.lolicon.app/setu/v2?num=${num}&r18=${r18}&tag=${tag}&size=regular&size=original&proxy=${pixivImgHost}&excludeAI=true`,
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
                } else {
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

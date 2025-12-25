import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";
import dayjs from "dayjs";
import { getGlobalClient } from "@utils/globalClient";

// 定义数据库结构
interface GroupData {
    enabled: boolean;      // 开关状态
    date: string;          // 当前记录的日期 (YYYY-MM-DD)
    sleepUsers: string[];  // 睡觉的用户ID列表 (按顺序)
    wakeUsers: string[];   // 起床的用户ID列表 (按顺序)
}

interface DBData {
    groups: Record<string, GroupData>; // Key为群组ID
}

class GreetingPlugin extends Plugin {
    // 动态生成描述，包含帮助信息
    description = () => {
        const help = `🌙 <b>早晚安统计插件</b>\n\n` +
                     `自动回复早晚安并统计排名。默认关闭，需手动开启。\n\n` +
                     `<b>指令:</b>\n` +
                     `• <code>.goodnight on</code> - 开启统计\n` +
                     `• <code>.goodnight off</code> - 关闭统计\n` +
                     `• <code>.goodnight</code> - 查看状态`;
        return help;
    };
    
    // 数据库实例
    private db: any;
    
    // 关键词配置
    private readonly sleepKeywords = ["晚安", "晚", "睡觉", "睡了", "去睡了", "晚安喵"];
    private readonly wakeKeywords = ["早", "早上好", "早安", "起床", "早安喵"];

    constructor() {
        super();
        this.initDB();
    }

    // 初始化数据库
    private async initDB() {
        // 数据存储在 assets/greeting/data.json
        const dbDir = createDirectoryInAssets("greeting");
        const dbPath = path.join(dbDir, "data.json");
        
        // 设置默认值
        this.db = await JSONFilePreset<DBData>(dbPath, { groups: {} });
    }

    // 指令处理器
    cmdHandlers = {
        goodnight: async (msg: Api.Message) => {
            await this.handleCommand(msg);
        },
        // 添加 gn 作为 .goodnight 的简写别名
        gn: async (msg: Api.Message) => {
            await this.handleCommand(msg);
        }
    };

    // 统一处理指令逻辑
    private async handleCommand(msg: Api.Message) {
        if (!this.db) await this.initDB();
        
        const chatId = msg.chatId?.toString();
        if (!chatId) return;

        // 获取或初始化数据（如果不存在，默认 enabled=false）
        let groupData = this.db.data.groups[chatId];
        if (!groupData) {
            groupData = {
                enabled: false,
                date: dayjs().format("YYYY-MM-DD"),
                sleepUsers: [],
                wakeUsers: []
            };
            this.db.data.groups[chatId] = groupData;
        }

        // 解析参数
        const text = msg.text || "";
        const parts = text.trim().split(/\s+/);
        // parts[0] 是命令本身(如 .goodnight)，parts[1] 是参数(如 on/off)
        const subCommand = parts[1]?.toLowerCase();

        if (subCommand === "on") {
            if (groupData.enabled) {
                await msg.edit({ text: "✅ 本群早晚安统计已经是<b>开启</b>状态", parseMode: "html" });
            } else {
                groupData.enabled = true;
                await this.db.write();
                await msg.edit({ text: "✅ 本群早晚安统计已<b>开启</b>", parseMode: "html" });
            }
        } else if (subCommand === "off") {
            if (!groupData.enabled) {
                await msg.edit({ text: "🚫 本群早晚安统计已经是<b>关闭</b>状态", parseMode: "html" });
            } else {
                groupData.enabled = false;
                await this.db.write();
                await msg.edit({ text: "🚫 本群早晚安统计已<b>关闭</b>", parseMode: "html" });
            }
        } else {
            // 显示状态和帮助
            const status = groupData.enabled ? "✅ 开启" : "🚫 关闭";
            const help = `🌙 <b>早晚安统计插件</b>\n\n` +
                         `当前状态: ${status}\n\n` +
                         `<b>指令:</b>\n` +
                         `• <code>.goodnight on</code> - 开启统计\n` +
                         `• <code>.goodnight off</code> - 关闭统计\n` +
                         `• <code>.goodnight</code> - 查看状态`;
            await msg.edit({ text: help, parseMode: "html" });
        }
    }

    // 监听所有消息
    listenMessageHandler = async (msg: Api.Message) => {
        // 1. 基础过滤：必须有文本，且忽略太长的消息
        const text = msg.text?.trim();
        if (!text || text.length > 10) return;

        // 2. 获取基本信息
        const chatId = msg.chatId?.toString();
        const userId = msg.senderId?.toString();
        if (!chatId || !userId) return;

        // 3. 检查功能开关
        if (!this.db) await this.initDB();
        const groupData = this.db.data.groups[chatId];
        
        // 关键逻辑：如果数据不存在（从未设置过），或者 enabled 为 false，直接忽略
        if (!groupData || !groupData.enabled) return;

        // 4. 判断是早安还是晚安
        const isSleep = this.checkKeywords(text, this.sleepKeywords);
        const isWake = this.checkKeywords(text, this.wakeKeywords);

        // 如果既不是早也不是晚，直接返回
        if (!isSleep && !isWake) return;

        // 5. 处理业务逻辑
        await this.processGreeting(msg, chatId, userId, isSleep ? "sleep" : "wake");
    };

    // 辅助函数：检查关键词（完全匹配）
    private checkKeywords(text: string, keywords: string[]): boolean {
        return keywords.includes(text);
    }

    // 核心处理逻辑
    private async processGreeting(msg: Api.Message, chatId: string, userId: string, type: "sleep" | "wake") {
        // 确保数据库已加载
        if (!this.db) await this.initDB();

        const today = dayjs().format("YYYY-MM-DD");
        
        // 获取群组数据（listener 已确保数据存在且 enabled=true）
        let groupData = this.db.data.groups[chatId];

        // 如果日期不是今天，则重置每日数据（保留 enabled 状态）
        if (groupData.date !== today) {
            groupData.date = today;
            groupData.sleepUsers = [];
            groupData.wakeUsers = [];
            // 注意：这里不需要立即 write，因为下面添加新用户时会统一 write
        }

        // 获取对应的用户列表
        const list = type === "sleep" ? groupData.sleepUsers : groupData.wakeUsers;
        
        // 计算排名
        let rank = 0;
        const userIndex = list.indexOf(userId);

        if (userIndex !== -1) {
            // 如果用户已经在列表中，使用已有排名（索引+1）
            rank = userIndex + 1;
        } else {
            // 如果是新用户，添加到列表末尾
            list.push(userId);
            rank = list.length;
            // 保存数据库
            await this.db.write();
        }

        // 获取用户显示名称
        let senderName = "神秘人";
        try {
            const sender = await msg.getSender() as any;
            if (sender) {
                senderName = sender.firstName || sender.username || "群友";
            }
        } catch (e) {
            console.error("获取用户信息失败", e);
        }

        // 构建回复内容
        const currentTime = dayjs().format("YYYY-MM-DD HH:mm:ss");
        const actionText = type === "sleep" ? "睡觉" : "起床";
        const replyAction = type === "sleep" ? "快睡觉" : "起床喵";
        
        const replyText = `${replyAction}, ${senderName}!\n现在是 ${currentTime}, 你是本群今天第 ${rank} 个${actionText}的。`;

        // 发送回复
        try {
            await msg.reply({
                message: replyText
            });
        } catch (e) {
            console.error("回复消息失败", e);
        }
    }
}

export default new GreetingPlugin();
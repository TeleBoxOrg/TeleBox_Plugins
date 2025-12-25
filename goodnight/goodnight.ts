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
    timezone: number;      // 时区偏移 (如 8 代表 UTC+8)
    date: string;          // 当前记录的日期 (YYYY-MM-DD，基于设定时区)
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
                     `• <code>.goodnight utc+8</code> - 设置时区 (支持 utc+8, utc-5 格式)\n` +
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

        // 获取或初始化数据
        let groupData = this.db.data.groups[chatId];
        
        // 如果是新群组，默认初始化
        if (!groupData) {
            const defaultTimezone = 8; // 默认 UTC+8
            const targetDate = this.getDateByTimezone(defaultTimezone);
            
            groupData = {
                enabled: false,
                timezone: defaultTimezone,
                date: dayjs(targetDate).format("YYYY-MM-DD"),
                sleepUsers: [],
                wakeUsers: []
            };
            this.db.data.groups[chatId] = groupData;
        }

        // 确保旧数据有 timezone 字段
        if (typeof groupData.timezone === 'undefined') {
            groupData.timezone = 8;
        }

        // 解析参数
        const text = msg.text || "";
        const parts = text.trim().split(/\s+/);
        // parts[0] 是命令，parts[1] 是参数
        const subCommand = parts[1]?.toLowerCase();
        
        // 解析时区输入
        // 支持格式: 8, +8, -5, utc+8, utc-5, gmt+8
        let timezoneInput = NaN;
        if (subCommand && subCommand !== "on" && subCommand !== "off") {
            // 移除 utc 或 gmt 前缀，保留符号和数字
            const cleaned = subCommand.replace(/^(utc|gmt)/i, '');
            timezoneInput = parseInt(cleaned);
        }

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
        } else if (!isNaN(timezoneInput)) {
            // 设置时区逻辑
            if (timezoneInput < -12 || timezoneInput > 14) {
                await msg.edit({ text: "❌ 时区必须在 UTC-12 到 UTC+14 之间", parseMode: "html" });
                return;
            }
            
            groupData.timezone = timezoneInput;
            
            // 更新时区后，重新计算该时区的当前日期
            const targetDate = this.getDateByTimezone(timezoneInput);
            const todayStr = dayjs(targetDate).format("YYYY-MM-DD");
            
            // 简单处理：仅保存新时区，日期切换逻辑在 processGreeting 中会自动处理
            await this.db.write();
            
            const sign = timezoneInput >= 0 ? "+" : "";
            await msg.edit({ 
                text: `✅ 已将本群时区设置为 <b>UTC${sign}${timezoneInput}</b>\n当前时间: ${dayjs(targetDate).format("HH:mm:ss")}`, 
                parseMode: "html" 
            });
        } else {
            // 显示状态和帮助
            const status = groupData.enabled ? "✅ 开启" : "🚫 关闭";
            const tzSign = groupData.timezone >= 0 ? "+" : "";
            const currentTzTime = dayjs(this.getDateByTimezone(groupData.timezone)).format("YYYY-MM-DD HH:mm:ss");
            
            const help = `🌙 <b>早晚安统计插件</b>\n\n` +
                         `当前状态: ${status}\n` +
                         `当前时区: UTC${tzSign}${groupData.timezone}\n` +
                         `当前时间: ${currentTzTime}\n\n` +
                         `<b>指令:</b>\n` +
                         `• <code>.goodnight on</code> - 开启统计\n` +
                         `• <code>.goodnight off</code> - 关闭统计\n` +
                         `• <code>.goodnight utc+8</code> - 设置时区\n` +
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
    
    // 辅助函数：根据时区偏移获取 Date 对象
    private getDateByTimezone(timezoneOffset: number): Date {
        const now = new Date();
        // 获取当前 UTC 时间戳
        const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
        // 加上目标时区偏移 (小时 * 60 * 60 * 1000)
        return new Date(utcTime + (timezoneOffset * 3600000));
    }

    // 核心处理逻辑
    private async processGreeting(msg: Api.Message, chatId: string, userId: string, type: "sleep" | "wake") {
        // 确保数据库已加载
        if (!this.db) await this.initDB();

        // 获取群组数据（listener 已确保数据存在且 enabled=true）
        let groupData = this.db.data.groups[chatId];
        
        // 确保 timezone 存在 (向后兼容)
        const timezone = typeof groupData.timezone === 'number' ? groupData.timezone : 8;

        // 基于群组时区计算当前日期和时间
        const targetDate = this.getDateByTimezone(timezone);
        const today = dayjs(targetDate).format("YYYY-MM-DD");
        
        // 如果日期不是今天，则重置每日数据
        if (groupData.date !== today) {
            groupData.date = today;
            groupData.sleepUsers = [];
            groupData.wakeUsers = [];
            // 如果旧数据没有 timezone 字段，借此机会补上
            groupData.timezone = timezone;
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
        const currentTime = dayjs(targetDate).format("YYYY-MM-DD HH:mm:ss");
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
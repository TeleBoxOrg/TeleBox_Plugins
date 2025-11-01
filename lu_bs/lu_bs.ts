// plugins/lu_bs.ts
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文本
const HELP_TEXT = `🕒 <b>鲁小迅整点报时</b>

<b>功能说明：</b>
• 每小时整点自动发送鲁小迅贴纸报时
• 自动删除上一条报时消息（1小时后）
• 支持群组和私聊订阅

<b>可用命令：</b>
• <code>.lu_bs sub</code> - 订阅整点报时
• <code>.lu_bs unsub</code> - 退订整点报时
• <code>.lu_bs list</code> - 查看订阅状态
• <code>.lu_bs reload</code> - 重新加载贴纸包
• <code>.lu_bs help</code> - 显示此帮助

<b>注意事项：</b>
• 需要管理员权限才能操作群组订阅
• 请先添加贴纸包: <code>https://t.me/addstickers/luxiaoxunbs</code>`;

class LuBsPlugin extends Plugin {
  private db: any = null;
  private stickerSet: any = null;
  private readonly PLUGIN_NAME = "lu_bs";
  
  description = HELP_TEXT;
  
  // 定时任务 - 每小时整点执行
  cronTasks = {
    hourlyReport: {
      cron: "0 * * * *", // 每小时整点
      description: "鲁小迅整点报时",
      handler: async (client: any) => {
        await this.sendHourlyStickers(client);
      }
    }
  };

  constructor() {
    super();
    this.initDB();
    this.loadStickerSet();
  }

  // 初始化数据库
  private async initDB() {
    const dbPath = path.join(createDirectoryInAssets(this.PLUGIN_NAME), "subscriptions.json");
    this.db = await JSONFilePreset(dbPath, { 
      subscriptions: [],
      lastMessages: {} // 存储最后发送的消息ID，用于删除
    });
  }

  // 加载贴纸包
  private async loadStickerSet() {
    try {
      const client = await getGlobalClient();
      if (!client) return;

      // 使用Telegram原始API获取贴纸包
      this.stickerSet = await client.invoke(
        new Api.messages.GetStickerSet({
          stickerset: new Api.InputStickerSetShortName({
            shortName: "luxiaoxunbs"
          }),
          hash: 0
        })
      );
      
      console.log(`[${this.PLUGIN_NAME}] 贴纸包加载成功`);
    } catch (error) {
      console.error(`[${this.PLUGIN_NAME}] 贴纸包加载失败:`, error);
      this.stickerSet = null;
    }
  }

  // 获取当前小时对应的贴纸
  private async getHourSticker(): Promise<any> {
    if (!this.stickerSet) {
      await this.loadStickerSet();
    }
    
    if (!this.stickerSet || !this.stickerSet.documents || this.stickerSet.documents.length === 0) {
      return null;
    }

    const now = new Date();
    let hour = now.getHours() - 1;
    
    if (now.getMinutes() > 30) {
      hour += 1;
    }
    
    hour = hour % 12;
    if (hour === -1) {
      hour = 11;
    }

    // 确保索引在有效范围内
    const stickerIndex = hour % this.stickerSet.documents.length;
    return this.stickerSet.documents[stickerIndex];
  }

  // 发送整点贴纸
  private async sendHourlyStickers(client: any) {
    if (!this.db) await this.initDB();
    
    const sticker = await this.getHourSticker();
    if (!sticker) {
      console.error(`[${this.PLUGIN_NAME}] 无法获取贴纸`);
      return;
    }

    const subscriptions = this.db.data.subscriptions;
    
    for (const chatId of subscriptions) {
      try {
        // 先删除上一条消息（如果存在）
        const lastMsgId = this.db.data.lastMessages[chatId];
        if (lastMsgId) {
          try {
            await client.deleteMessages(chatId, [lastMsgId], { revoke: true });
          } catch (error) {
            // 忽略删除失败的情况（消息可能已过期）
          }
        }

        // 发送新贴纸
        const message = await client.sendFile(chatId, {
          file: sticker,
          attributes: []
        });

        // 记录新消息ID，用于下次删除
        this.db.data.lastMessages[chatId] = message.id;
        await this.db.write();

        console.log(`[${this.PLUGIN_NAME}] 已发送整点报时到 ${chatId}`);
      } catch (error) {
        console.error(`[${this.PLUGIN_NAME}] 发送失败到 ${chatId}:`, error);
        
        // 如果发送失败，可能是聊天不存在或没有权限，移除订阅
        if (error.message?.includes("CHAT_WRITE_FORBIDDEN") || 
            error.message?.includes("CHAT_NOT_FOUND")) {
          this.db.data.subscriptions = this.db.data.subscriptions.filter((id: string) => id !== chatId);
          delete this.db.data.lastMessages[chatId];
          await this.db.write();
          console.log(`[${this.PLUGIN_NAME}] 已移除无效订阅: ${chatId}`);
        }
      }
    }
  }

  // 检查用户权限（简化版本，实际使用时可能需要更复杂的权限检查）
  private async checkPermission(msg: Api.Message): Promise<boolean> {
    try {
      const client = await getGlobalClient();
      if (!client) return false;

      const chat = await msg.getChat();
      const sender = await msg.getSender();
      
      // 私聊总是允许
      if (chat.className === "User") {
        return true;
      }
      
      // 群组/频道需要检查管理员权限
      if (chat.className === "Channel" || chat.className === "Chat") {
        const participant = await client.getParticipant(chat, sender);
        return participant && (
          participant instanceof Api.ChannelParticipantAdmin ||
          participant instanceof Api.ChannelParticipantCreator ||
          participant instanceof Api.ChatParticipantAdmin ||
          participant instanceof Api.ChatParticipantCreator
        );
      }
      
      return false;
    } catch (error) {
      console.error(`[${this.PLUGIN_NAME}] 权限检查失败:`, error);
      return false;
    }
  }

  cmdHandlers = {
    lu_bs: async (msg: Api.Message) => {
      if (!this.db) await this.initDB();
      
      const parts = msg.text?.trim().split(/\s+/) || [];
      const subCommand = parts[1]?.toLowerCase() || "help";
      
      try {
        switch (subCommand) {
          case "sub":
          case "订阅":
            await this.handleSubscribe(msg);
            break;
            
          case "unsub":
          case "退订":
            await this.handleUnsubscribe(msg);
            break;
            
          case "list":
          case "列表":
            await this.handleList(msg);
            break;
            
          case "reload":
          case "重载":
            await this.handleReload(msg);
            break;
            
          case "help":
          case "帮助":
          default:
            await msg.edit({ text: HELP_TEXT, parseMode: "html" });
            break;
        }
      } catch (error: any) {
        await msg.edit({
          text: `❌ <b>错误:</b> ${htmlEscape(error.message || "未知错误")}`,
          parseMode: "html"
        });
      }
    }
  };

  // 处理订阅
  private async handleSubscribe(msg: Api.Message) {
    const chatId = msg.chatId?.toString();
    if (!chatId) {
      await msg.edit({ text: "❌ 无法获取聊天ID", parseMode: "html" });
      return;
    }

    // 检查权限
    const hasPermission = await this.checkPermission(msg);
    if (!hasPermission) {
      await msg.edit({ 
        text: "❌ 权限不足，无法操作整点报时", 
        parseMode: "html" 
      });
      return;
    }

    // 检查是否已订阅
    if (this.db.data.subscriptions.includes(chatId)) {
      await msg.edit({ 
        text: "❌ 你已经订阅了整点报时", 
        parseMode: "html" 
      });
      return;
    }

    // 添加订阅
    this.db.data.subscriptions.push(chatId);
    await this.db.write();

    await msg.edit({ 
      text: "✅ 你已经成功订阅了整点报时", 
      parseMode: "html" 
    });
  }

  // 处理退订
  private async handleUnsubscribe(msg: Api.Message) {
    const chatId = msg.chatId?.toString();
    if (!chatId) {
      await msg.edit({ text: "❌ 无法获取聊天ID", parseMode: "html" });
      return;
    }

    // 检查权限
    const hasPermission = await this.checkPermission(msg);
    if (!hasPermission) {
      await msg.edit({ 
        text: "❌ 权限不足，无法操作整点报时", 
        parseMode: "html" 
      });
      return;
    }

    // 检查是否已订阅
    if (!this.db.data.subscriptions.includes(chatId)) {
      await msg.edit({ 
        text: "❌ 你还没有订阅整点报时", 
        parseMode: "html" 
      });
      return;
    }

    // 移除订阅
    this.db.data.subscriptions = this.db.data.subscriptions.filter((id: string) => id !== chatId);
    delete this.db.data.lastMessages[chatId];
    await this.db.write();

    await msg.edit({ 
      text: "✅ 你已经成功退订了整点报时", 
      parseMode: "html" 
    });
  }

  // 处理列表查看
  private async handleList(msg: Api.Message) {
    const chatId = msg.chatId?.toString();
    if (!chatId) {
      await msg.edit({ text: "❌ 无法获取聊天ID", parseMode: "html" });
      return;
    }

    const isSubscribed = this.db.data.subscriptions.includes(chatId);
    const totalSubscriptions = this.db.data.subscriptions.length;
    
    let text = `📊 <b>订阅状态</b>\n\n`;
    text += `• 当前聊天: <code>${isSubscribed ? "✅ 已订阅" : "❌ 未订阅"}</code>\n`;
    text += `• 总订阅数: <code>${totalSubscriptions}</code>\n\n`;
    
    if (isSubscribed) {
      text += "💡 使用 <code>.lu_bs unsub</code> 退订";
    } else {
      text += "💡 使用 <code>.lu_bs sub</code> 订阅";
    }

    await msg.edit({ text, parseMode: "html" });
  }

  // 处理重载贴纸包
  private async handleReload(msg: Api.Message) {
    await this.loadStickerSet();
    
    if (this.stickerSet) {
      await msg.edit({ 
        text: "✅ 贴纸包重新加载成功", 
        parseMode: "html" 
      });
    } else {
      await msg.edit({ 
        text: "❌ 贴纸包加载失败，请检查贴纸包名称是否正确", 
        parseMode: "html" 
      });
    }
  }
}

export default new LuBsPlugin();

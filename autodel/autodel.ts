import { Plugin } from "../src/utils/pluginBase";
import { getGlobalClient } from "../src/utils/globalClient";
import { Api } from "telegram";
import { createDirectoryInAssets } from "../src/utils/pathHelpers";
import Database from "better-sqlite3";
import path from "path";

class AutoDelPlugin extends Plugin {
  description: string = `🕒 <b>定时自动删除消息</b><br/><br/>
<b>命令</b><br/>
• <code>.autodel [时间] [global]</code> 设置自动删除<br/>
• <code>.autodel l</code> 查看当前设置<br/>
• <code>.autodel cancel [global]</code> 取消设置<br/><br/>
<b>时间格式</b><br/>
• <code>30 seconds</code>、<code>5 minutes</code>、<code>2 hours</code>、<code>1 days</code><br/>
• 简写：<code>30s</code>、<code>5m</code>、<code>2h</code>、<code>1d</code><br/>
• 中文：<code>30秒</code>、<code>5分</code>/<code>5分钟</code>、<code>2小时</code>/<code>2时</code>、<code>1天</code><br/><br/>
<b>示例</b><br/>
• <code>.autodel 30s</code><br/>
• <code>.autodel 5 分钟 global</code>（设置全局）<br/><br/>
<b>⚠️ 安全说明</b><br/>
• 只会删除您自己发送的消息<br/>
• 最小删除时间为5秒`;
  private db: Database.Database | null = null;
  private settings: Map<string, number> = new Map();
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    autodel: this.handleAutoDel.bind(this)
  };

  constructor() {
    super();
    this.initDatabase();
  }

  private async initDatabase(): Promise<void> {
    try {
      const assetsDir = await createDirectoryInAssets("autodel");
      const dbPath = path.join(assetsDir, "autodel.db");
      
      this.db = new Database(dbPath);
      
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS autodel_settings (
          chat_id TEXT PRIMARY KEY,
          seconds INTEGER NOT NULL
        )
      `);
      
      await this.loadExistingSettings();
    } catch (error) {
      console.error("Failed to initialize autodel database:", error);
    }
  }

  private async loadExistingSettings(): Promise<void> {
    if (!this.db) return;
    
    try {
      const settings = this.db.prepare(
        "SELECT * FROM autodel_settings"
      ).all() as { chat_id: string; seconds: number }[];
      
      for (const setting of settings) {
        this.settings.set(setting.chat_id, setting.seconds);
      }
    } catch (error) {
      console.error("Failed to load existing settings:", error);
    }
  }

  private async handleAutoDel(msg: Api.Message): Promise<void> {
    const args = msg.message.split(" ").slice(1);
    
    if (args.length === 0 || args[0] === "h") {
      await msg.edit({
        text: this.getHelpText(),
        parseMode: "html"
      });
      return;
    }
    
    if (args[0] === "l") {
      await this.showAutoDelSettings(msg);
      return;
    }
     
    if (args[0] === "cancel") {
      await this.cancelAutoDelSetting(msg, args.includes("global"));
      return;
    }
     
    const timeStr = args[0];
    const isGlobal = args.includes("global");
    
    const delaySeconds = this.parseTimeString(timeStr);
    if (delaySeconds === null) {
      await msg.edit({
        text: "❌ 时间格式错误，请使用如：30 seconds, 5 minutes, 2 hours, 1 days"
      });
      return;
    }
     
    // 设置自动删除配置
    await this.setAutoDelSetting(msg, delaySeconds, isGlobal);
  }

  private getHelpText(): string {
    return `📝 <b>定时删除消息帮助</b>\n\n` +
           `<b>用法：</b>\n` +
           `• <code>.autodel [时间] [global]</code> - 设置自动删除\n` +
           `• <code>.autodel l</code> - 查看当前设置\n` +
           `• <code>.autodel cancel [global]</code> - 取消设置\n\n` +
           `<b>时间格式：</b>\n` +
           `• 英文：30 seconds, 5 minutes, 2 hours, 1 days\n` +
           `• 简写：30s, 5m, 2h, 1d\n` +
           `• 中文：30秒，5分/5分钟，2小时/2时，1天\n\n` +
           `<b>示例：</b>\n` +
           `• <code>.autodel 30s</code> - 30秒后自动删除\n` +
           `• <code>.autodel 5 分钟 global</code> - 全局5分钟自动删除`;
  }

  private async showAutoDelSettings(msg: Api.Message): Promise<void> {
    const chatId = msg.peerId.toString();
    const globalSeconds = this.settings.get("0");
    const chatSeconds = this.settings.get(chatId);
    
    let text = "📋 <b>自动删除设置：</b>\n\n";
    
    if (chatSeconds) {
      text += `当前聊天：${chatSeconds} 秒\n`;
    } else if (globalSeconds) {
      text += `当前聊天：全局 ${globalSeconds} 秒\n`;
    } else {
      text += "当前聊天：未设置\n";
    }
    
    if (globalSeconds) {
      text += `全局设置：${globalSeconds} 秒`;
    } else {
      text += "全局设置：未设置";
    }
    
    await msg.edit({
      text,
      parseMode: "html"
    });
  }

  private async cancelAutoDelSetting(msg: Api.Message, isGlobal: boolean): Promise<void> {
    const chatId = isGlobal ? "0" : msg.peerId.toString();
    
    if (!this.settings.has(chatId)) {
      await msg.edit({
        text: "❌ 未开启自动删除"
      });
      return;
    }
    
    this.settings.delete(chatId);
    
    if (this.db) {
      try {
        this.db.prepare("DELETE FROM autodel_settings WHERE chat_id = ?").run(chatId);
      } catch (error) {
        console.error("Failed to delete setting:", error);
      }
    }
    
    await msg.edit({
      text: "✅ 取消自动删除任务成功。"
    });
  }

  private async setAutoDelSetting(msg: Api.Message, seconds: number, isGlobal: boolean): Promise<void> {
    const chatId = isGlobal ? "0" : msg.peerId.toString();
    
    // 安全限制：最小删除时间为5秒，防止滥用
    if (seconds < 5) {
      await msg.edit({
        text: "❌ 为了安全考虑，自动删除时间不能少于5秒"
      });
      return;
    }
    
    this.settings.set(chatId, seconds);
    
    if (this.db) {
      try {
        this.db.prepare(
          "INSERT OR REPLACE INTO autodel_settings (chat_id, seconds) VALUES (?, ?)"
        ).run(chatId, seconds);
      } catch (error) {
        console.error("Failed to save setting:", error);
      }
    }
    
    await msg.edit({
      text: `✅ 设置自动删除任务成功。\n⚠️ 注意：只会删除您自己发送的消息`
    });
  }

  // 监听所有消息，为符合条件的消息添加删除任务
  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    // 跳过命令消息
    if (!msg.message || msg.message.startsWith(".") || msg.message.startsWith(",")) {
      return;
    }
    
    const chatId = msg.peerId.toString();
    const globalSeconds = this.settings.get("0");
    const chatSeconds = this.settings.get(chatId);
    
    const seconds = chatSeconds || globalSeconds;
    if (!seconds) return;
    
    // 获取当前用户ID
    const client = await getGlobalClient();
    if (!client) return;
    
    const me = await client.getMe();
    const myId = Number(me.id);
    
    // 只删除自己发送的消息
    if (!msg.fromId) {
      return;
    }
    
    let senderId: number;
    if ('userId' in msg.fromId) {
      senderId = Number(msg.fromId.userId);
    } else if (typeof msg.fromId === 'object' && 'value' in msg.fromId) {
      senderId = Number(msg.fromId.value);
    } else {
      senderId = Number(msg.fromId);
    }
    
    if (senderId !== myId) {
      return;
    }
    
    // 设置定时删除
    setTimeout(async () => {
      try {
        const client = await getGlobalClient();
        if (!client) return;
        
        // 只删除自己的消息，不使用revoke强制删除
        await client.deleteMessages(msg.peerId, [msg.id], {
          revoke: false
        });
      } catch (error) {
        console.error("Failed to auto delete message:", error);
      }
    }, seconds * 1000);
  }

  private parseTimeString(timeStr: string): number | null {
    // 支持多种格式：
    // 英文全称/复数：30 second(s), 5 minute(s), 2 hour(s), 1 day(s)
    // 英文简写：30s, 5m, 2h, 1d, sec/secs, min/mins, hr/hrs
    // 中文单位：30秒, 5分, 5分钟, 2小时/2时, 1天（大小写与空格均可忽略）
    if (!timeStr) return null;
    const str = String(timeStr).trim();

    // 统一移除多余空格
    const compact = str.replace(/\s+/g, "");

    // 先尝试英文“数字+单位（可空格）”形式
    const matchLoose = str.match(/^\s*(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\s*$/i);
    if (matchLoose) {
      const value = parseInt(matchLoose[1], 10);
      const unitRaw = matchLoose[2].toLowerCase();
      const unit = unitRaw as string;

      const multipliers: Record<string, number> = {
        s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
        m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
        h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
        d: 86400, day: 86400, days: 86400
      };

      // 归一化到键
      const key = (
        unit === 's' || unit === 'sec' || unit === 'secs' || unit === 'second' || unit === 'seconds' ? 'seconds' :
        unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minute' || unit === 'minutes' ? 'minutes' :
        unit === 'h' || unit === 'hr' || unit === 'hrs' || unit === 'hour' || unit === 'hours' ? 'hours' :
        unit === 'd' || unit === 'day' || unit === 'days' ? 'days' : unit
      );

      const mul = multipliers[key];
      return Number.isFinite(mul) ? value * mul : null;
    }

    // 再尝试英文“紧凑简写”形式（如 30s/5m/2h/1d）
    const matchCompact = compact.match(/^(\d+)(s|sec|secs|m|min|mins|h|hr|hrs|d)$/i);
    if (matchCompact) {
      const value = parseInt(matchCompact[1], 10);
      const unit = matchCompact[2].toLowerCase();
      const multipliers: Record<string, number> = {
        s: 1, sec: 1, secs: 1,
        m: 60, min: 60, mins: 60,
        h: 3600, hr: 3600, hrs: 3600,
        d: 86400
      };
      const mul = multipliers[unit];
      return Number.isFinite(mul) ? value * mul : null;
    }

    // 中文单位（支持：秒/分/分钟/小时/时/天），也兼容中英混写无空格
    const zhMatch = compact.match(/^(\d+)(秒|分|分钟|小时|时|天)$/);
    if (zhMatch) {
      const value = parseInt(zhMatch[1], 10);
      const unit = zhMatch[2];
      const multipliers: Record<string, number> = {
        '秒': 1,
        '分': 60,
        '分钟': 60,
        '小时': 3600,
        '时': 3600,
        '天': 86400
      };
      const mul = multipliers[unit];
      return Number.isFinite(mul) ? value * mul : null;
    }

    return null;
  }
}

export default new AutoDelPlugin();

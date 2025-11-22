import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs";
import axios from "axios";

const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

class AnnualReportPlugin extends Plugin {
  private readonly PLUGIN_NAME = "annualreport";
  private db: any;
  private configPath: string;

  constructor() {
    super();
    this.configPath = path.join(createDirectoryInAssets(this.PLUGIN_NAME), "stats.json");
    this.initDB();
  }

  private async initDB() {
    this.db = await JSONFilePreset(this.configPath, {
      startTime: Date.now(), // 记录插件首次运行时间
      reportCount: 0
    });
  }

  description = `📊 年度报告插件\n\n使用 ${getPrefixes()[0]}annualreport 生成您的Telegram年度报告`;

  cmdHandlers = {
    annualreport: this.handleAnnualReport.bind(this)
  };

  private async getChatCount(client: any): Promise<{private: number, group: number, bots: number, channel: number}> {
    let privateCount = 0, groupCount = 0, botsCount = 0, channelCount = 0;
    
    try {
      const dialogs = await client.getDialogs({});
      
      for (const dialog of dialogs) {
        if (dialog.isUser) {
          if (dialog.entity && dialog.entity.bot) {
            botsCount++;
          } else {
            privateCount++;
          }
        } else if (dialog.isGroup) {
          groupCount++;
        } else if (dialog.isChannel) {
          channelCount++;
        }
      }
    } catch (error) {
      console.error("[AnnualReport] 获取对话列表失败:", error);
    }
    
    return { private: privateCount, group: groupCount, bots: botsCount, channel: channelCount };
  }

  private async getBlockedCount(client: any): Promise<number> {
    try {
      // 使用原始API获取黑名单数量
      const result = await client.invoke(
        new Api.contacts.GetBlocked({
          offset: 0,
          limit: 1
        })
      );
      
      if (result instanceof Api.contacts.BlockedSlice) {
        return result.count;
      } else if (result.users && result.users.length > 0) {
        return result.users.length;
      }
    } catch (error) {
      console.error("[AnnualReport] 获取黑名单失败:", error);
    }
    
    return 0;
  }

  private getRunDays(): number {
    try {
      // 尝试读取LICENSE文件，如果不存在则使用插件安装时间
      const licensePath = path.join(process.cwd(), "LICENSE");
      if (fs.existsSync(licensePath)) {
        const stats = fs.statSync(licensePath);
        const days = Math.floor((Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24));
        return days;
      }
    } catch (error) {
      console.error("[AnnualReport] 读取LICENSE文件失败:", error);
    }
    
    // 使用插件安装时间作为备选
    const installTime = this.db?.data?.startTime || Date.now();
    const days = Math.floor((Date.now() - installTime) / (1000 * 60 * 60 * 24));
    return days;
  }

  private getPluginCount(): number {
    try {
      // 统计用户插件
      const userPluginPath = path.join(process.cwd(), "plugins");
      let userPlugins = 0;
      if (fs.existsSync(userPluginPath)) {
        userPlugins = fs.readdirSync(userPluginPath)
          .filter(file => file.endsWith('.ts') && !file.startsWith('.'))
          .length;
      }

      // 统计系统插件
      const systemPluginPath = path.join(process.cwd(), "src", "plugin");
      let systemPlugins = 0;
      if (fs.existsSync(systemPluginPath)) {
        systemPlugins = fs.readdirSync(systemPluginPath)
          .filter(file => file.endsWith('.ts') && !file.startsWith('.'))
          .length;
      }

      return userPlugins + systemPlugins;
    } catch (error) {
      console.error("[AnnualReport] 统计插件数量失败:", error);
      return 0;
    }
  }

  private async getHitokoto(): Promise<string> {
    try {
      const response = await axios.get("https://v1.hitokoto.cn/?charset=utf-8");
      const data = response.data;
      
      let text = `"${htmlEscape(data.hitokoto)}" —— `;
      if (data.from_who) {
        text += htmlEscape(data.from_who);
      }
      if (data.from) {
        text += `「${htmlEscape(data.from)}」`;
      }
      return text;
    } catch (error) {
      console.error("[AnnualReport] 获取一言失败:", error);
      return '"用代码表达言语的魅力，用代码书写山河的壮丽。" —— 一言「一言开发者中心」';
    }
  }

  private getYear(): string {
    const now = new Date();
    let year = now.getFullYear();
    if (now.getMonth() === 0) { // 1月
      year -= 1;
    }
    return year.toString();
  }

  private async handleAnnualReport(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 无法获取客户端", parseMode: "html" });
      return;
    }

    await msg.edit({ text: "🔄 加载中请稍候。。。", parseMode: "html" });

    try {
      // 更新报告计数
      if (this.db) {
        this.db.data.reportCount += 1;
        await this.db.write();
      }

      const year = this.getYear();
      const chatStats = await this.getChatCount(client);
      const days = this.getRunDays();
      const pluginCount = this.getPluginCount();
      const blockedCount = await this.getBlockedCount(client);
      
      // 获取用户信息
      const user = await client.getMe();
      let userName = "";
      if (user.username) {
        userName = `@${user.username}`;
      } else if (user.firstName && user.lastName) {
        userName = `${user.firstName} ${user.lastName}`;
      } else {
        userName = user.firstName || "未知用户";
      }

      const isPremium = user.premium || false;
      const premiumText = isPremium ? "你已成为TG大会员用户，愿新一年继续享受专属特权" : "";
      
      const blockedText = blockedCount < 20 ? "你的账户真的很干净" : "愿明年的spam少一些";
      
      const hitokotoText = await this.getHitokoto();

      // 构建报告消息
      const reportText = `
<b>${htmlEscape(userName)} 的 ${year} 年度报告</b>

📅 <b>陪伴时光</b>
TeleBox 已陪伴你的 TG ${days} 天
安装了 ${pluginCount} 个插件，为你的使用体验增光添彩

👥 <b>社交网络</b>
你邂逅了 ${chatStats.channel} 个频道，${chatStats.group} 个群组
遇见了 ${chatStats.private} 个有趣的灵魂，使用了 ${chatStats.bots} 个机器人
愿你的生活每天都像庆典一样开心

🛡️ <b>安全守护</b>
你的黑名单里有 ${blockedCount} 人
${blockedText}

${premiumText ? `⭐ <b>会员特权</b>\n${premiumText}\n` : ''}
💫 <b>年度寄语</b>
${hitokotoText}

<code>#${year}年度报告</code>`.trim();

      await msg.edit({ text: reportText, parseMode: "html" });

    } catch (error: any) {
      console.error("[AnnualReport] 生成报告失败:", error);
      await msg.edit({ 
        text: `❌ <b>生成报告失败:</b> ${htmlEscape(error.message || "未知错误")}`,
        parseMode: "html" 
      });
    }
  }
}

export default new AnnualReportPlugin();

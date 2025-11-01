import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";

interface AffData {
  text: string;
  web_page: boolean;
}

class AffPlugin extends Plugin {
  private db: any = null;
  private readonly PLUGIN_NAME = "aff";
  
  // 插件描述
  description = `✈️ 机场Affiliate信息管理

在别人要打算买机场的时候光速发出自己的aff信息（请尽量配合短链接）

<b>使用方法：</b>
• <code>.aff</code> - 发送已保存的aff信息
• <code>.aff save</code> - 回复一条消息以保存aff信息
• <code>.aff remove</code> - 删除已保存的aff信息`;

  // 命令处理器
  cmdHandlers = {
    aff: this.handleAffCommand.bind(this)
  };

  // 初始化数据库
  private async initDB(): Promise<void> {
    if (this.db) return;
    
    const dbPath = path.join(
      createDirectoryInAssets(this.PLUGIN_NAME),
      "data.json"
    );
    
    this.db = await JSONFilePreset<{ aff?: AffData }>(dbPath, {});
  }

  // 获取aff信息
  private async getAff(): Promise<AffData | null> {
    await this.initDB();
    return this.db.data.aff || null;
  }

  // 设置aff信息
  private async setAff(text: string, web_page: boolean = false): Promise<void> {
    await this.initDB();
    this.db.data.aff = { text, web_page };
    await this.db.write();
  }

  // 删除aff信息
  private async delAff(): Promise<void> {
    await this.initDB();
    if (this.db.data.aff) {
      delete this.db.data.aff;
      await this.db.write();
    }
  }

  // HTML转义函数（必需）
  private htmlEscape(text: string): string {
    return text.replace(/[&<>"']/g, m => ({ 
      '&': '&amp;', '<': '&lt;', '>': '&gt;', 
      '"': '&quot;', "'": '&#x27;' 
    }[m] || m));
  }

  // 主命令处理
  private async handleAffCommand(msg: Api.Message): Promise<void> {
    try {
      const text = msg.text || "";
      const parts = text.trim().split(/\s+/);
      const subCommand = parts[1]?.toLowerCase();

      // 无参数：发送aff信息
      if (!subCommand) {
        await this.sendAffInfo(msg);
        return;
      }

      // 保存aff信息
      if (subCommand === "save") {
        await this.saveAffInfo(msg);
        return;
      }

      // 删除aff信息
      if (subCommand === "remove") {
        await this.removeAffInfo(msg);
        return;
      }

      // 无效参数
      await msg.edit({
        text: "❌ <b>无效的参数</b>\n\n" + 
              "💡 使用方法：\n" +
              "• <code>.aff</code> - 发送aff信息\n" +
              "• <code>.aff save</code> - 保存aff信息（回复消息）\n" +
              "• <code>.aff remove</code> - 删除aff信息",
        parseMode: "html"
      });

    } catch (error: any) {
      await this.handleError(msg, error);
    }
  }

  // 发送aff信息
  private async sendAffInfo(msg: Api.Message): Promise<void> {
    const affData = await this.getAff();
    
    if (!affData || !affData.text) {
      await msg.edit({
        text: "❌ <b>Aff消息不存在</b>\n\n" +
              "💡 请先使用 <code>.aff save</code> 命令保存aff信息",
        parseMode: "html"
      });
      return;
    }

    await msg.edit({
      text: affData.text,
      parseMode: "html",
      linkPreview: !affData.web_page
    });
  }

  // 保存aff信息
  private async saveAffInfo(msg: Api.Message): Promise<void> {
    const replyMsg = await msg.getReplyMessage();
    
    if (!replyMsg) {
      await msg.edit({
        text: "❌ <b>请回复一条消息以保存新的Aff信息</b>",
        parseMode: "html"
      });
      return;
    }

    const text = replyMsg.text || replyMsg.message || "";
    
    if (!text.trim()) {
      await msg.edit({
        text: "❌ <b>回复的消息内容为空</b>\n\n" +
              "💡 请回复一条包含aff信息的消息",
        parseMode: "html"
      });
      return;
    }

    // 检测是否包含网页预览（简单的URL检测）
    const hasWebPage = /https?:\/\/[^\s]+/.test(text);
    
    await this.setAff(text, hasWebPage);
    
    await msg.edit({
      text: "✅ <b>Aff信息保存成功！</b>",
      parseMode: "html"
    });
  }

  // 删除aff信息
  private async removeAffInfo(msg: Api.Message): Promise<void> {
    await this.delAff();
    
    await msg.edit({
      text: "✅ <b>Aff信息删除成功！</b>",
      parseMode: "html"
    });
  }

  // 错误处理
  private async handleError(msg: Api.Message, error: any): Promise<void> {
    console.error(`[${this.PLUGIN_NAME}] Error:`, error);
    
    const errorMsg = this.htmlEscape(error.message || "未知错误");
    
    await msg.edit({
      text: `❌ <b>操作失败：</b>${errorMsg}`,
      parseMode: "html"
    });
  }
}

export default new AffPlugin();

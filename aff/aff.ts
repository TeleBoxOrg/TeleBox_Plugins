import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";

interface AffData {
  text: string;
  web_page: boolean;
  created_at?: number;
}

interface DBData {
  aff?: AffData; // 旧数据兼容
  affs: AffData[];
}

class AffPlugin extends Plugin {
  private db: any = null;
  private readonly PLUGIN_NAME = "aff";
  
  // 插件描述
  description = `✈️ 机场Affiliate信息管理

在别人要打算买机场的时候光速发出自己的aff信息（支持多条）

<b>使用方法：</b>
• <code>.aff</code> - 发送默认aff（如有多条则显示列表）
• <code>.aff &lt;序号&gt;</code> - 发送指定序号的aff
• <code>.aff list</code> - 查看所有已保存的aff
• <code>.aff save</code> - 回复一条消息以新增aff
• <code>.aff remove &lt;序号&gt;</code> - 删除指定aff`;

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
    
    this.db = await JSONFilePreset<DBData>(dbPath, { affs: [] });
    
    // 迁移旧数据
    if (this.db.data.aff) {
      this.db.data.affs.push(this.db.data.aff);
      delete this.db.data.aff;
      await this.db.write();
    }
  }

  // 获取aff列表
  private async getAffs(): Promise<AffData[]> {
    await this.initDB();
    return this.db.data.affs || [];
  }

  // 新增aff
  private async addAff(text: string, web_page: boolean = false): Promise<void> {
    await this.initDB();
    this.db.data.affs.push({ 
      text, 
      web_page,
      created_at: Date.now()
    });
    await this.db.write();
  }

  // 删除aff
  private async removeAff(index: number): Promise<boolean> {
    await this.initDB();
    const affs = this.db.data.affs;
    if (index >= 0 && index < affs.length) {
      affs.splice(index, 1);
      await this.db.write();
      return true;
    }
    return false;
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
      const param = parts[2];

      // 1. 无参数：智能发送
      if (!subCommand) {
        await this.handleSmartSend(msg);
        return;
      }

      // 2. 数字参数：发送指定序号
      const index = parseInt(subCommand);
      if (!isNaN(index)) {
        await this.sendAffByIndex(msg, index);
        return;
      }

      // 3. 保存命令
      if (subCommand === "save") {
        await this.saveAffInfo(msg);
        return;
      }

      // 4. 列表命令
      if (subCommand === "list") {
        await this.listAffs(msg);
        return;
      }

      // 5. 删除命令
      if (subCommand === "remove" || subCommand === "rm" || subCommand === "del") {
        await this.handleRemove(msg, param);
        return;
      }

      // 无效参数
      await msg.edit({
        text: "❌ <b>无效的参数</b>\n\n" + 
              "💡 使用方法：\n" +
              "• <code>.aff</code> - 发送/列表\n" +
              "• <code>.aff &lt;序号&gt;</code> - 发送指定条目\n" +
              "• <code>.aff save</code> - 保存回复\n" +
              "• <code>.aff remove &lt;序号&gt;</code> - 删除条目",
        parseMode: "html"
      });

    } catch (error: any) {
      await this.handleError(msg, error);
    }
  }

  // 智能发送：1条直接发，多条显示列表，0条提示保存
  private async handleSmartSend(msg: Api.Message): Promise<void> {
    const affs = await this.getAffs();
    
    if (affs.length === 0) {
      await msg.edit({
        text: "❌ <b>暂无Aff信息</b>\n\n💡 请回复一条消息使用 <code>.aff save</code> 保存",
        parseMode: "html"
      });
      return;
    }

    if (affs.length === 1) {
      await this.sendAffContent(msg, affs[0]);
      return;
    }

    await this.listAffs(msg);
  }

  // 发送指定序号
  private async sendAffByIndex(msg: Api.Message, index: number): Promise<void> {
    const affs = await this.getAffs();
    // 用户输入通常是 1-based，所以减 1
    const realIndex = index - 1;
    
    if (realIndex >= 0 && realIndex < affs.length) {
      await this.sendAffContent(msg, affs[realIndex]);
    } else {
      await msg.edit({
        text: `❌ <b>找不到序号为 ${index} 的Aff信息</b>`,
        parseMode: "html"
      });
    }
  }

  // 发送内容的核心方法
  private async sendAffContent(msg: Api.Message, aff: AffData): Promise<void> {
    await msg.edit({
      text: aff.text,
      parseMode: "html",
      linkPreview: !aff.web_page
    });
  }

  // 列出所有Aff
  private async listAffs(msg: Api.Message): Promise<void> {
    const affs = await this.getAffs();
    
    if (affs.length === 0) {
      await msg.edit({
        text: "📂 <b>Aff列表为空</b>",
        parseMode: "html"
      });
      return;
    }

    let listText = "📋 <b>已保存的Aff列表：</b>\n\n";
    
    affs.forEach((aff, idx) => {
      // 截取前30个字符作为预览
      let preview = aff.text.replace(/\n/g, " ").substring(0, 30);
      if (aff.text.length > 30) preview += "...";
      preview = this.htmlEscape(preview);
      
      listText += `<b>${idx + 1}.</b> ${preview}\n`;
    });

    listText += "\n💡 使用 <code>.aff &lt;序号&gt;</code> 发送指定条目";

    await msg.edit({
      text: listText,
      parseMode: "html"
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
    
    await this.addAff(text, hasWebPage);
    
    const affs = await this.getAffs();
    await msg.edit({
      text: `✅ <b>Aff信息保存成功！</b>\n🆔 当前序号：${affs.length}`,
      parseMode: "html"
    });
  }

  // 删除aff信息
  private async handleRemove(msg: Api.Message, param?: string): Promise<void> {
    if (!param) {
      await msg.edit({
        text: "❌ <b>请指定要删除的序号</b>\n💡 例如：<code>.aff remove 1</code>",
        parseMode: "html"
      });
      return;
    }

    const index = parseInt(param);
    if (isNaN(index)) {
      await msg.edit({
        text: "❌ <b>无效的序号</b>",
        parseMode: "html"
      });
      return;
    }

    const success = await this.removeAff(index - 1);
    
    if (success) {
      await msg.edit({
        text: `✅ <b>已删除序号 ${index} 的Aff信息</b>`,
        parseMode: "html"
      });
    } else {
      await msg.edit({
        text: `❌ <b>删除失败：找不到序号 ${index}</b>`,
        parseMode: "html"
      });
    }
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

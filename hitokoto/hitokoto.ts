import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import axios from "axios";

// 类型定义
interface HitokotoResponse {
  hitokoto: string;
  from?: string;
  from_who?: string;
  type: string;
}

// 一言类型映射
const hitokotoTypeMap: Record<string, string> = {
  "a": "动画",
  "b": "漫画", 
  "c": "游戏",
  "d": "文学",
  "e": "原创",
  "f": "网络",
  "g": "其他",
  "h": "影视",
  "i": "诗词",
  "j": "网易云",
  "k": "哲学",
  "l": "抖机灵"
};

// 帮助文本（符合开发规范格式）
const help_text = `⚙️ <b>Hitokoto 插件</b>

<b>📝 功能描述:</b>
• 从 hitokoto.cn API 获取随机一言
• 支持多种类型（动画、漫画、文学、哲学等）
• 包含详细的来源信息

<b>🔧 使用方法:</b>
• <code>.hitokoto</code> - 获取随机一言
• <code>.hitokoto help</code> - 显示帮助信息`;

// HTML转义函数（符合开发规范）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

class HitokotoPlugin extends Plugin {
  // 插件描述（符合开发规范）
  description = help_text;
  
  // 命令处理器（主命令改为 hitokoto）
  cmdHandlers = {
    hitokoto: this.handleHitokotoCommand.bind(this)
  };

  /**
   * 处理 hitokoto 命令
   * 符合开发规范：支持 help/h 子指令和无参数时显示帮助
   */
  private async handleHitokotoCommand(msg: Api.Message): Promise<void> {
    try {
      // 解析参数
      const parts = msg.text?.trim().split(/\s+/) || [];
      const subCommand = parts[1]?.toLowerCase() || "";
      
      // 处理 help/h 子指令或无参数情况
      if (!subCommand || subCommand === "help" || subCommand === "h") {
        await msg.edit({
          text: help_text,
          parseMode: "html"
        });
        return;
      }
      
      // 如果不是 help/h，则执行获取一言功能
      await this.fetchAndSendHitokoto(msg);
      
    } catch (error: any) {
      await this.handleError(msg, error);
    }
  }

  /**
   * 获取并发送一言
   */
  private async fetchAndSendHitokoto(msg: Api.Message): Promise<void> {
    // 发送等待消息
    const processingMsg = await msg.edit({
      text: "🔄 正在获取一言...",
      parseMode: "html"
    });

    let hitokotoData: HitokotoResponse | null = null;
    let retryCount = 0;
    const maxRetries = 10;

    // 重试机制
    while (retryCount < maxRetries && !hitokotoData) {
      try {
        const response = await axios.get<HitokotoResponse>(
          "https://v1.hitokoto.cn/?charset=utf-8",
          { timeout: 10000 }
        );
        hitokotoData = response.data;
        break;
      } catch (error) {
        retryCount++;
        if (retryCount >= maxRetries) {
          throw new Error("获取一言失败，请稍后重试");
        }
        // 等待一段时间后重试
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!hitokotoData) {
      throw new Error("无法获取一言数据");
    }

    // 构建来源信息
    let sourceInfo = "";
    if (hitokotoData.from) {
      sourceInfo += `《${htmlEscape(hitokotoData.from)}》`;
    }
    if (hitokotoData.type && hitokotoTypeMap[hitokotoData.type]) {
      sourceInfo += `（${hitokotoTypeMap[hitokotoData.type]}）`;
    }
    if (hitokotoData.from_who) {
      sourceInfo += ` - ${htmlEscape(hitokotoData.from_who)}`;
    }

    // 构建最终消息
    const finalText = sourceInfo 
      ? `💬 ${htmlEscape(hitokotoData.hitokoto)}\n\n📚 ${sourceInfo}`
      : `💬 ${htmlEscape(hitokotoData.hitokoto)}`;

    // 编辑消息显示结果
    await processingMsg.edit({
      text: finalText,
      parseMode: "html"
    });
  }

  /**
   * 错误处理
   */
  private async handleError(msg: Api.Message, error: any): Promise<void> {
    const errorMsg = error.message || "未知错误";
    await msg.edit({
      text: `❌ <b>获取一言失败：</b>${htmlEscape(errorMsg)}`,
      parseMode: "html"
    });
  }
}

export default new HitokotoPlugin();
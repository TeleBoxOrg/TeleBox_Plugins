import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import axios from "axios";

class DissPlugin extends Plugin {
  // 插件描述
  description = "🗣️ 儒雅随和版祖安语录\n\n使用 .diss 触发";

  // 命令处理器
  cmdHandlers = {
    diss: this.handleDiss.bind(this)
  };

  /**
   * 处理diss命令
   */
  private async handleDiss(msg: Api.Message): Promise<void> {
    try {
      // 发送等待消息
      await msg.edit({ text: "🔄 正在获取儒雅随和语录..." });

      // 尝试最多5次请求
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const response = await axios.get("https://api.oddfar.com/yl/q.php?c=1009&encode=text", {
            timeout: 10000, // 10秒超时
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });

          if (response.status === 200 && response.data) {
            const dissText = response.data.toString().trim();
            
            if (dissText && dissText.length > 0) {
              // 成功获取到语录，发送结果
              await msg.edit({ 
                text: `🗣️ <b>儒雅随和语录：</b>\n\n${this.htmlEscape(dissText)}`,
                parseMode: "html"
              });
              return;
            }
          }
        } catch (error) {
          console.warn(`[diss] 第${attempt}次尝试失败:`, error.message);
          
          // 如果不是最后一次尝试，等待一下再重试
          if (attempt < 5) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }

      // 所有尝试都失败了
      await msg.edit({ 
        text: "❌ 出错了呜呜呜 ~ 试了好多好多次都无法访问到 API 服务器。",
        parseMode: "html"
      });

    } catch (error: any) {
      // 处理意外错误
      console.error('[diss] 插件执行错误:', error);
      await msg.edit({ 
        text: `❌ 发生意外错误: ${this.htmlEscape(error.message || "未知错误")}`,
        parseMode: "html"
      });
    }
  }

  /**
   * HTML转义函数（必需）
   */
  private htmlEscape(text: string): string {
    return text.replace(/[&<>"']/g, m => ({ 
      '&': '&amp;', '<': '&lt;', '>': '&gt;', 
      '"': '&quot;', "'": '&#x27;' 
    }[m] || m));
  }
}

export default new DissPlugin();

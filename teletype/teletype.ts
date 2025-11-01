import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";

// HTML转义函数（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

class TeletypePlugin extends Plugin {
  // 插件配置
  private readonly PLUGIN_NAME = "teletype";
  private readonly PLUGIN_VERSION = "1.0.0";
  
  // 帮助文档
  private readonly HELP_TEXT = `⌨️ <b>打字机效果插件</b>

<b>命令格式：</b>
<code>.teletype [文本内容]</code>

<b>功能说明：</b>
• 模拟打字机效果，逐个字符显示文本
• 支持中英文和特殊字符
• 自动处理消息编辑冲突

<b>使用示例：</b>
<code>.teletype Hello World!</code>
<code>.teletype 这是一个测试消息</code>`;
  
  // 插件描述
  description = this.HELP_TEXT;
  
  // 命令处理器
  cmdHandlers = {
    teletype: this.handleTeletype.bind(this)
  };
  
  // 主命令处理
  private async handleTeletype(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;
    
    try {
      // 参数解析
      const text = this.parseArguments(msg);
      if (!text) {
        await this.showUsage(msg);
        return;
      }
      
      // 执行打字机效果
      await this.executeTeletype(msg, text);
      
    } catch (error: any) {
      await this.handleError(msg, error);
    }
  }
  
  // 参数解析
  private parseArguments(msg: Api.Message): string {
    const text = msg.text || "";
    const parts = text.trim().split(/\s+/);
    
    // 移除命令部分，获取剩余文本
    if (parts.length < 2) return "";
    
    return parts.slice(1).join(" ");
  }
  
  // 显示用法
  private async showUsage(msg: Api.Message): Promise<void> {
    await msg.edit({
      text: `❌ <b>参数错误</b>\n\n${this.HELP_TEXT}`,
      parseMode: "html"
    });
  }
  
  // 执行打字机效果
  private async executeTeletype(msg: Api.Message, text: string): Promise<void> {
    const interval = 50; // 50ms 间隔
    const cursor = "█";
    let buffer = "";
    
    // 初始化消息，显示光标
    let currentMsg = await msg.edit({
      text: cursor,
      parseMode: "html"
    });
    
    // 等待初始间隔
    await this.sleep(interval);
    
    // 逐个字符显示
    for (const character of text) {
      buffer += character;
      const bufferWithCursor = `${buffer}${cursor}`;
      
      try {
        // 显示文本+光标
        currentMsg = await currentMsg.edit({
          text: bufferWithCursor,
          parseMode: "html"
        });
        
        await this.sleep(interval);
        
        // 显示文本（去掉光标）
        currentMsg = await currentMsg.edit({
          text: buffer,
          parseMode: "html"
        });
        
      } catch (error: any) {
        // 忽略消息未修改错误，继续执行
        if (!error.message?.includes("MESSAGE_NOT_MODIFIED")) {
          throw error;
        }
      }
      
      await this.sleep(interval);
    }
    
    // 最终确认消息
    await currentMsg.edit({
      text: `⌨️ <b>打字完成:</b>\n<code>${htmlEscape(text)}</code>`,
      parseMode: "html"
    });
  }
  
  // 错误处理
  private async handleError(msg: Api.Message, error: any): Promise<void> {
    console.error(`[${this.PLUGIN_NAME}] Error:`, error);
    
    let errorMessage = "❌ <b>操作失败:</b> ";
    
    if (error.message?.includes("MESSAGE_TOO_LONG")) {
      errorMessage += "消息过长，请缩短文本内容";
    } else if (error.message?.includes("MESSAGE_NOT_MODIFIED")) {
      // 忽略消息未修改错误
      return;
    } else {
      errorMessage += htmlEscape(error.message || "未知错误");
    }
    
    await msg.edit({
      text: errorMessage,
      parseMode: "html"
    });
  }
  
  // 睡眠函数
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default new TeletypePlugin();

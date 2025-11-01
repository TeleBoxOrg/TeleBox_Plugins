import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import axios from "axios";

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文本
const help_text = `📱 <b>手机号码归属地查询</b>

<b>命令格式：</b>
<code>.tel [手机号码]</code>

<b>示例：</b>
<code>.tel 13800138000</code>

<b>功能：</b>
• 查询手机号码归属地
• 显示运营商信息
• 查询号段信息
• 显示通信标准`;

class TelPlugin extends Plugin {
  name = "tel";
  description = help_text;
  
  private readonly API_URL = "https://tenapi.cn/v2/phone";
  
  cmdHandlers = {
    tel: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) return;
      
      try {
        const text = msg.text || "";
        const parts = text.trim().split(/\s+/);
        
        if (parts.length < 2) {
          await msg.edit({
            text: `❌ <b>参数错误</b>\n\n${help_text}`,
            parseMode: "html"
          });
          return;
        }
        
        const phone = parts[1].trim();
        
        if (!/^\d+$/.test(phone)) {
          await msg.edit({
            text: "❌ <b>无效的手机号码</b>\n\n请输入纯数字的手机号码",
            parseMode: "html"
          });
          return;
        }
        
        await msg.edit({
          text: "🔄 <b>查询中...</b>",
          parseMode: "html"
        });
        
        const response = await axios.post(this.API_URL, null, {
          params: { tel: phone },
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        
        const data = response.data;
        
        if (!response.status || response.status !== 200 || data.code !== 200) {
          let errorMsg = "❌ <b>API服务器返回错误</b>";
          if (data && data.msg) {
            errorMsg += `\n\n错误信息: ${htmlEscape(data.msg)}`;
          } else if (response.status !== 200) {
            errorMsg += `\n\nHTTP状态码: ${response.status}`;
          }
          await msg.edit({
            text: errorMsg,
            parseMode: "html"
          });
          return;
        }
        
        const result = data.data;
        
        const resultText = `
📱 <b>手机号码归属地查询结果</b>

🔢 <b>查询目标:</b> <code>${htmlEscape(phone)}</code>
📍 <b>地区:</b> ${htmlEscape(result.local || "未知")}
📊 <b>号段:</b> ${htmlEscape(result.num || "未知")}
🏷️ <b>卡类型:</b> ${htmlEscape(result.type || "未知")}
📡 <b>运营商:</b> ${htmlEscape(result.isp || "未知")}
📶 <b>通信标准:</b> ${htmlEscape(result.std || "未知")}

💡 <i>数据仅供参考，以官方信息为准</i>
        `.trim();
        
        await msg.edit({
          text: resultText,
          parseMode: "html"
        });
        
      } catch (error: any) {
        console.error("[TelPlugin] 查询错误:", error);
        
        let errorMessage = "❌ <b>查询失败</b>";
        
        if (error.code === 'ECONNABORTED') {
          errorMessage += "\n\n⏰ 请求超时，请稍后重试";
        } else if (error.response) {
          errorMessage += `\n\nAPI错误: ${htmlEscape(error.response.status.toString())}`;
          if (error.response.data && error.response.data.msg) {
            errorMessage += `\n错误信息: ${htmlEscape(error.response.data.msg)}`;
          }
        } else if (error.request) {
          errorMessage += "\n\n🌐 网络连接失败，请检查网络";
        } else {
          errorMessage += `\n\n错误详情: ${htmlEscape(error.message)}`;
        }
        
        await msg.edit({
          text: errorMessage,
          parseMode: "html"
        });
      }
    }
  };
}

export default new TelPlugin();

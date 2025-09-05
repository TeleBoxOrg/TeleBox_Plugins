import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "telegram";
import axios from "axios";

// HTML escape function equivalent to Python's html.escape
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// API helper function
async function getIpInfo(query: string): Promise<any> {
  // 验证输入格式
  if (!query || query.trim() === "") {
    return {
      status: "fail",
      message: "请提供有效的IP地址或域名",
    };
  }

  const cleanQuery = query.trim();
  const apiUrl = `http://ip-api.com/json/${encodeURIComponent(
    cleanQuery
  )}?lang=zh-CN&fields=status,message,country,regionName,city,isp,org,as,query,lat,lon,timezone`;

  try {
    const response = await axios.get(apiUrl, {
      timeout: 15000,
      headers: {
        "User-Agent": "TeleBox-IP-Plugin/1.0",
      },
    });

    if (response.status === 200) {
      const data = response.data;

      // 检查API返回的状态
      if (data.status === "fail") {
        return {
          status: "fail",
          message: data.message || "查询失败，请检查IP地址或域名是否正确",
        };
      }

      return data;
    }

    return {
      status: "fail",
      message: `API请求失败，HTTP状态码: ${response.status}`,
    };
  } catch (error: any) {
    console.error("IP API request failed:", error);

    let errorMessage = "网络请求失败";
    const errorStr = String(error.message || error);

    if (errorStr.includes("timeout") || errorStr.includes("TIMEOUT")) {
      errorMessage = "请求超时，请稍后重试";
    } else if (
      errorStr.includes("ENOTFOUND") ||
      errorStr.includes("getaddrinfo")
    ) {
      errorMessage = "DNS解析失败，请检查网络连接";
    } else if (errorStr.includes("ECONNREFUSED")) {
      errorMessage = "连接被拒绝，请稍后重试";
    }

    return {
      status: "fail",
      message: errorMessage,
    };
  }
}

const ip = async (msg: Api.Message) => {
  try {
    const args = msg.message.slice(1).split(" ").slice(1); // Remove command part
    let query = args.join(" ");

    // If no query provided, try to get from replied message
    if (!query) {
      try {
        const reply = await msg.getReplyMessage();
        if (reply && reply.text) {
          // 尝试提取IP或域名
          const text = reply.text.trim();
          const ipRegex = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/;
          const domainRegex =
            /\b[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.[a-zA-Z]{2,}\b/;

          const ipMatch = text.match(ipRegex);
          const domainMatch = text.match(domainRegex);

          if (ipMatch) {
            query = ipMatch[0];
          } else if (domainMatch) {
            query = domainMatch[0];
          } else {
            query = text.split(" ")[0]; // 退化为第一个单词
          }
        }
      } catch (replyError: any) {
        console.error("Failed to get reply message:", replyError);
        // 继续执行，不阻断流程
      }
    }

    // If still no query, show help
    if (!query || query.trim() === "") {
      await msg.edit({
        text: `📍 <b>IP查询插件</b>

<b>使用方法：</b>
• <code>ip &lt;IP地址&gt;</code>
• <code>ip &lt;域名&gt;</code>
• 回复包含IP/域名的消息后使用 <code>ip</code>

<b>示例：</b>
• <code>ip 8.8.8.8</code>
• <code>ip google.com</code>
• <code>ip 2001:4860:4860::8888</code>`,
        parseMode: "html",
      });
      return;
    }

    // Show searching message
    await msg.edit({
      text: `🔍 <b>正在查询:</b> <code>${htmlEscape(query)}</code>`,
      parseMode: "html",
    });

    // Get IP information
    const data = await getIpInfo(query);

    // Check for API failure
    if (data.status === "fail") {
      const errorMessage = data.message || "未知错误";
      await msg.edit({
        text: `❌ <b>查询失败</b>

<b>查询目标:</b> <code>${htmlEscape(query)}</code>
<b>失败原因:</b> ${htmlEscape(errorMessage)}

💡 <b>建议:</b>
• 检查IP地址或域名格式
• 稍后重试查询`,
        parseMode: "html",
      });
      return;
    }

    // Parse and format the results
    try {
      const country = data.country || "N/A";
      const region = data.regionName || "N/A";
      const city = data.city || "N/A";
      const isp = data.isp || "N/A";
      const org = data.org || "N/A";
      const asInfo = data.as || "N/A";
      const ipAddress = data.query || "N/A";
      const lat = data.lat;
      const lon = data.lon;

      let resultText = `🌍 <b>IP/域名查询结果</b>

<b>🔍 查询目标:</b> <code>${htmlEscape(ipAddress)}</code>
<b>📍 地理位置:</b> ${htmlEscape(country)} - ${htmlEscape(
        region
      )} - ${htmlEscape(city)}
<b>🏢 ISP:</b> ${htmlEscape(isp)}
<b>🏦 组织:</b> ${htmlEscape(org)}
<b>🔢 AS号:</b> <code>${htmlEscape(asInfo)}</code>`;

      // 添加时区信息
      if (data.timezone) {
        resultText += `
<b>⏰ 时区:</b> ${htmlEscape(data.timezone)}`;
      }

      // Add map link if coordinates are available
      if (lat && lon) {
        const mapsLink = `https://www.google.com/maps/place/${lat},${lon}`;
        resultText += `
<b>🗺️ 地图链接:</b> <a href='${mapsLink}'>点击查看地图</a>`;
        resultText += `
<b>📍 坐标:</b> <code>${lat}, ${lon}</code>`;
      }

      await msg.edit({
        text: resultText,
        parseMode: "html",
        linkPreview: false,
      });
    } catch (parseError: any) {
      console.error("Failed to parse IP data:", parseError, data);
      await msg.edit({
        text: `❌ <b>数据解析失败</b>

<b>查询目标:</b> <code>${htmlEscape(query)}</code>
<b>错误原因:</b> API返回了非预期的数据格式

💡 <b>建议:</b> 请稍后重试或联系管理员`,
        parseMode: "html",
      });
    }
  } catch (error: any) {
    console.error("IP lookup error:", error);
    const errorMessage = error.message || String(error);
    const displayError =
      errorMessage.length > 100
        ? errorMessage.substring(0, 100) + "..."
        : errorMessage;

    await msg.edit({
      text: `❌ <b>IP查询失败</b>

<b>错误信息:</b> ${htmlEscape(displayError)}

💡 <b>建议:</b>
• 检查网络连接
• 稍后重试查询
• 确认IP地址或域名格式正确`,
      parseMode: "html",
    });
  }
};

class IpPlugin extends Plugin {
  description: string = `
IP 查询插件：
- ip <IP地址/域名> - 查询 IP 地址或域名的详细信息
- 也可回复包含 IP/域名 的消息后使用 ip 命令

示例：
1. ip 8.8.8.8
2. ip google.com
3. 回复包含 IP 的消息后使用 ip
  `;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    ip,
  };
}

export default new IpPlugin();

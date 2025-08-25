import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
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
  const apiUrl = `http://ip-api.com/json/${query}?lang=zh-CN`;

  try {
    const response = await axios.get(apiUrl, { timeout: 10000 });

    if (response.status === 200) {
      return response.data;
    }

    return {
      status: "fail",
      message: `API 请求失败，HTTP 状态码: ${response.status}`,
    };
  } catch (error: any) {
    return {
      status: "fail",
      message: `网络请求时发生错误: ${error.message || error}`,
    };
  }
}

const ipPlugin: Plugin = {
  command: ["ip"],
  description: `
IP 查询插件：
- ip <IP地址/域名> - 查询 IP 地址或域名的详细信息
- 也可回复包含 IP/域名 的消息后使用 ip 命令

示例：
1. ip 8.8.8.8
2. ip google.com
3. 回复包含 IP 的消息后使用 ip
  `,
  cmdHandler: async (msg: Api.Message) => {
    try {
      const args = msg.message.slice(1).split(" ").slice(1); // Remove command part
      let query = args.join(" ");

      // If no query provided, try to get from replied message
      if (!query) {
        const reply = await msg.getReplyMessage();
        if (reply && reply.text) {
          query = reply.text.split(" ")[0];
        }
      }

      // If still no query, show help
      if (!query) {
        await msg.edit({
          text: `ℹ️ <b>IP 查询用法</b>

• <code>ip &lt;IP/域名&gt;</code>
• 回复一条包含 IP/域名 的消息并发送 <code>ip</code>`,
          parseMode: "html",
        });
        return;
      }

      // Show searching message
      await msg.edit({
        text: `🔍 正在查询: <code>${htmlEscape(query)}</code>`,
        parseMode: "html",
      });

      // Get IP information
      const data = await getIpInfo(query);

      // Check for API failure
      if (data.status === "fail") {
        const errorMessage = data.message || "未知错误";
        await msg.edit({
          text: `❌ <b>查询失败</b>
<b>原因:</b> <code>${htmlEscape(errorMessage)}</code>`,
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

        let resultText = `<b>📍 IP/域名信息查询结果</b>
        <b>查询目标:</b> <code>${htmlEscape(ipAddress)}</code>
        <b>地理位置:</b> ${htmlEscape(country)} - ${htmlEscape(
          region
        )} - ${htmlEscape(city)}
        <b>ISP:</b> ${htmlEscape(isp)}
        <b>组织:</b> ${htmlEscape(org)}
        <b>AS号:</b> <code>${htmlEscape(asInfo)}</code>`;

        // Add map link if coordinates are available
        if (lat && lon) {
          const mapsLink = `https://www.google.com/maps/place/${lat},${lon}`;
          resultText += `<b>地图链接:</b> <a href='${mapsLink}'>点击查看</a>`;
        }

        await msg.edit({
          text: resultText,
          parseMode: "html",
          linkPreview: false,
        });
      } catch (error) {
        await msg.edit({
          text: `❌ <b>解析数据失败</b>API 返回了非预期的格式。<code>${htmlEscape(
            JSON.stringify(data)
          )}</code>`,
          parseMode: "html",
        });
      }
    } catch (error: any) {
      console.error("IP lookup error:", error);
      await msg.edit({
        text: `❌ 查询过程中发生错误：${error.message || error}`,
      });
    }
  },
};

export default ipPlugin;

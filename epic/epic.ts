import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import axios from "axios";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const htmlEscape = (text: string): string => {
  if (typeof text !== "string") return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
};

const help_text = `⚙️ <b>Epic 限免游戏</b>

<b>📝 功能描述:</b>
• 获取 Epic Games 每周限免游戏信息
• 显示游戏详情、原价、限免时间

<b>🔧 使用方法:</b>
• <code>${mainPrefix}epic</code> - 查看当前限免游戏

<b>📊 数据来源:</b>
• Epic Games Store API`;

// Epic API URL
const EPIC_API_URL = "https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN";

interface EpicGame {
  title: string;
  description: string;
  originalPrice: string;
  startDate: string;
  endDate: string;
  url: string;
  imageUrl: string;
}

// 解析限免游戏数据
function parseFreeGames(data: any): { current: EpicGame[]; upcoming: EpicGame[] } {
  const current: EpicGame[] = [];
  const upcoming: EpicGame[] = [];

  const elements = data?.data?.Catalog?.searchStore?.elements || [];

  for (const game of elements) {
    // 跳过非游戏类型
    if (!game.categories?.some((c: any) => c.path === "freegames")) continue;

    const promotions = game.promotions;
    if (!promotions) continue;

    // 获取游戏URL
    const pageSlug = game.offerMappings?.[0]?.pageSlug || game.catalogNs?.mappings?.[0]?.pageSlug || game.productSlug || game.urlSlug;
    const url = pageSlug ? `https://store.epicgames.com/zh-CN/p/${pageSlug}` : "";

    // 获取图片
    const imageUrl = game.keyImages?.find((img: any) => img.type === "OfferImageWide" || img.type === "Thumbnail")?.url || "";

    // 获取价格
    const price = game.price?.totalPrice;
    const originalPrice = price?.fmtPrice?.originalPrice || "免费";

    const baseInfo: Omit<EpicGame, "startDate" | "endDate"> = {
      title: game.title || "未知游戏",
      description: game.description || "",
      originalPrice,
      url,
      imageUrl,
    };

    // 当前限免
    const currentPromo = promotions.promotionalOffers?.[0]?.promotionalOffers?.[0];
    if (currentPromo && price?.discountPrice === 0) {
      current.push({
        ...baseInfo,
        startDate: currentPromo.startDate,
        endDate: currentPromo.endDate,
      });
      continue;
    }

    // 即将限免
    const upcomingPromo = promotions.upcomingPromotionalOffers?.[0]?.promotionalOffers?.[0];
    if (upcomingPromo && upcomingPromo.discountSetting?.discountPercentage === 0) {
      upcoming.push({
        ...baseInfo,
        startDate: upcomingPromo.startDate,
        endDate: upcomingPromo.endDate,
      });
    }
  }

  return { current, upcoming };
}

// 格式化日期
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return dateStr;
  }
}

// 构建游戏信息文本
function buildGameText(game: EpicGame, index: number): string {
  const title = htmlEscape(game.title);
  const desc = game.description.length > 100 ? htmlEscape(game.description.slice(0, 100)) + "..." : htmlEscape(game.description);
  const start = formatDate(game.startDate);
  const end = formatDate(game.endDate);
  const link = game.url ? `<a href="${game.url}">🔗 领取</a>` : "";

  return `<b>${index}. ${title}</b>
💰 原价: <code>${htmlEscape(game.originalPrice)}</code> → <b>免费</b>
📅 ${start} ~ ${end}
${desc}
${link}`;
}

class EpicPlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  description: string = help_text;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    epic: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      const parts = msg.text?.trim().split(/\s+/) || [];
      const sub = (parts[1] || "").toLowerCase();

      if (sub === "help" || sub === "h") {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }

      try {
        await msg.edit({ text: "🎮 获取 Epic 限免游戏中...", parseMode: "html" });

        const res = await axios.get(EPIC_API_URL, { timeout: 15000 });
        const { current, upcoming } = parseFreeGames(res.data);

        let text = "🎮 <b>Epic Games 限免游戏</b>\n\n";

        if (current.length > 0) {
          text += "📢 <b>当前限免:</b>\n\n";
          current.forEach((g, i) => (text += buildGameText(g, i + 1) + "\n\n"));
        } else {
          text += "📢 <b>当前限免:</b> 暂无\n\n";
        }

        await msg.edit({ text, parseMode: "html", linkPreview: false });
      } catch (error: any) {
        console.error("[epic] 获取失败:", error);
        await msg.edit({ text: `❌ <b>获取失败:</b> ${htmlEscape(error.message || "网络错误")}`, parseMode: "html" });
      }
    },
  };
}

export default new EpicPlugin();


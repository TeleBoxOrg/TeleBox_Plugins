import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";

const mainPrefix = getPrefixes()[0];
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  }[m] || m));

const help_text = `💳 <b>BIN 查询</b>

<b>用法：</b>
• <code>${mainPrefix}bin &lt;卡头6-8位&gt;</code>

<b>示例：</b>
• <code>${mainPrefix}bin 415042</code>

<b>数据源：</b> Bincheck 优先，Binlist 备用`;

// 显示优化
function formatScheme(s: any): string {
  const map: Record<string, string> = {
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "American Express",
    diners: "Diners Club",
    discover: "Discover",
    jcb: "JCB",
    unionpay: "UnionPay",
    maestro: "Maestro",
    mir: "MIR",
    uatp: "UATP",
    elo: "Elo",
    verve: "Verve",
  };
  const k = typeof s === "string" ? s.toLowerCase() : "";
  if (!k) return "N/A";
  return map[k] || (k.charAt(0).toUpperCase() + k.slice(1));
}

function normalizeBankName(name: string): string {
  if (!name) return "N/A";
  let up = name.toUpperCase();
  // 将 " COMPANY LIMITED" -> ", CO., LTD."，" LIMITED" -> ", LTD."
  up = up.replace(/\bCOMPANY LIMITED\b/g, "CO., LTD.");
  up = up.replace(/\bLIMITED\b/g, "LTD.");
  // 在 (TAIWAN)LTD. 中间补逗号
  up = up.replace(/\)(\s*)LTD\./g, "), LTD.");
  // 避免重复逗号
  up = up.replace(/,\s*,/g, ", ");
  return up;
}

function formatType(t: any): string {
  const map: Record<string, string> = {
    credit: "信用",
    debit: "借记",
    charge: "签账",
    prepaid: "预付",
  };
  const k = typeof t === "string" ? t.toLowerCase() : "";
  return k ? (map[k] || k) : "未知";
}

function toTitleCase(s: any): string {
  if (!s || typeof s !== "string") return "N/A";
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ");
}

function formatCountry(c: any): string {
  if (!c) return "N/A";
  const raw = c.name || "";
  const name = raw.replace(" (Province of China)", "").trim();
  const code = c.alpha2 ? ` (${c.alpha2})` : "";
  const emoji = c.emoji ? c.emoji + " " : "";
  return `${emoji}${name || "未知"}${code}`;
}

function currencyCn(code?: string): string {
  const map: Record<string, string> = {
    USD: "美元",
    TWD: "新台币",
    CNY: "人民币",
    HKD: "港币",
    EUR: "欧元",
    JPY: "日元",
    GBP: "英镑",
    AUD: "澳元",
    CAD: "加元",
    SGD: "新加坡元",
  };
  return code ? (map[code] || code) : "未知";
}

function schemeBrandDisplay(s: any): string {
  const k = typeof s === "string" ? s.toLowerCase() : "";
  if (!k) return "N/A";
  if (k === "mastercard") return "Master Card";
  if (k === "amex") return "American Express";
  if (k === "unionpay") return "UnionPay";
  return k.charAt(0).toUpperCase() + k.slice(1);
}

async function fetchFromBincheck(bin: string): Promise<Partial<{ scheme: string; bank: string; country: string }>> {
  const axios = (await import("axios")).default;
  const cheerio = await import("cheerio");
  const bin6 = bin.slice(0, 6);
  const url = `https://bincheck.io/details/${bin6}`;
  try {
    const resp = await axios.get(url, { timeout: 8000 });
    const $ = cheerio.load(resp.data);
    const og = $('meta[property="og:description"]').attr('content') || "";
    // e.g. "This number: 545807 is a valid BIN number MASTERCARD issued by GAZPROMBANK ... in RUSSIAN FEDERATION"
    const m = og.match(/valid BIN number\s+([A-Z ]+)\s+issued by\s+(.+?)\s+in\s+(.+)/i);
    if (m) {
      const scheme = m[1]?.trim().toLowerCase().replace(/\s+/g, "");
      const bank = m[2]?.trim();
      const country = m[3]?.trim();
      return { scheme, bank, country };
    }
  } catch (e) {
    // ignore, fallback will be used
  }
  return {};
}

class BinPlugin extends Plugin {
  description: string = `BIN 查询插件\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    bin: async (msg: Api.Message) => {
      const line = msg.text?.trim()?.split(/\r?\n/g)?.[0] || "";
      const args = line.split(/\s+/) || [];
      const [, ...rest] = args;
      if (rest.length === 0 || /^h(elp)?$/i.test(rest[0])) {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }
      if (rest[1] && /^h(elp)?$/i.test(rest[1])) {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }
      const bin = (rest[0] || "").replace(/\D/g, "");
      if (bin.length < 6 || bin.length > 8) {
        await msg.edit({ text: `❌ 无效BIN：<code>${htmlEscape(rest[0] || "")}</code>\n需6-8位数字`, parseMode: "html" });
        return;
      }
      await msg.edit({ text: `🔍 正在查询 BIN ${bin}...` });
      const axios = (await import("axios")).default;
      try {
        // 先尝试 Bincheck（抓取概要信息）
        const bc = await fetchFromBincheck(bin);
        // 再用 Binlist 补全字段
        const r = await axios.get(`https://lookup.binlist.net/${bin}`, {
          headers: { "Accept-Version": "3" },
          timeout: 10000,
        });
        const d = r.data || {};
        const country = d.country ? `${d.country.emoji || ""} ${d.country.name || ""} (${d.country.alpha2 || ""})` : "N/A";
        const bank = d.bank
          ? `${d.bank.name || ""}${d.bank.url ? ` | ${d.bank.url}` : ""}${d.bank.phone ? ` | ${d.bank.phone}` : ""}${d.bank.city ? ` | ${d.bank.city}` : ""}`
          : "N/A";
        const scheme = formatScheme(d.scheme);
        const brand = toTitleCase(d.brand);
        const typeZh = formatType(d.type);
        const lenTxt = (d.number && Number.isFinite(d.number.length)) ? `${d.number.length}位` : "未知位数";
        const luhnTxt = (d.number && typeof d.number.luhn === "boolean") ? (d.number.luhn ? "是" : "否") : "未知";
        const num = `${lenTxt} | Luhn:${luhnTxt}`;
        // 计算品牌（方案名）优先取 Bincheck，其次 Binlist 的scheme
        const schemeDisp = schemeBrandDisplay(bc.scheme || d.scheme);
        // 等级：从 brand 中粗略提取（BUSINESS/CORPORATE/PLATINUM/GOLD/...）
        const level = (brand || "").toUpperCase().match(/BUSINESS|CORPORATE|PLATINUM|GOLD|CLASSIC|SIGNATURE|INFINITE|WORLD|PREMIUM/);
        const levelTxt = level ? level[0] : "—";
        const isBusiness = /BUSINESS|CORPORATE|COMMERCIAL/i.test(brand || "");
        const prepaid = d.prepaid === true ? "✓" : "×";
        const businessMark = isBusiness ? "✓" : "×";
        const countryName = bc.country || d.country?.name || "";
        const cnCountry = countryName.replace(" (Province of China)", "").replace("Taiwan, Province of China", "Taiwan");
        const countryLine = cnCountry === "Taiwan" ? "台湾" : (cnCountry || "未知");
        const currencyLine = currencyCn(d.country?.currency);
        const bankLine = normalizeBankName(bc.bank || d.bank?.name || "N/A");

        const txt =
          `卡头检测\n` +
          `🔢卡头：${bin}\n` +
          `💳品牌：${htmlEscape(schemeDisp)}\n` +
          `🔖类型：${htmlEscape(typeZh === "信用" ? "贷记" : typeZh)}\n` +
          `💹等级：${levelTxt}\n\n` +
          `🗺国家：${htmlEscape(countryLine)}\n` +
          `💸货币：${htmlEscape(currencyLine)}\n` +
          `🏦银行：${htmlEscape(bankLine)}\n\n` +
          `💰预付卡：${prepaid}\n` +
          `🧾商业卡：${businessMark}`;
        await msg.edit({ text: txt, parseMode: "html" });
      } catch (e: any) {
        if (e?.response?.status === 404) {
          await msg.edit({ text: `❌ 未找到: <code>${bin}</code>`, parseMode: "html" });
        } else if (e?.response?.status === 429) {
          await msg.edit({ text: "⏳ 频率受限，请稍后重试", parseMode: "html" });
        } else if (e?.code === "ECONNABORTED" || e?.message?.includes("timeout")) {
          await msg.edit({ text: "❌ 请求超时，请稍后重试", parseMode: "html" });
        } else if (e?.message?.includes("MESSAGE_TOO_LONG")) {
          await msg.edit({ text: "❌ 消息过长，请缩短输出", parseMode: "html" });
        } else {
          await msg.edit({ text: `❌ 查询失败: ${htmlEscape(e?.message || "未知错误")}`, parseMode: "html" });
        }
      }
    },
  };
}

export default new BinPlugin();

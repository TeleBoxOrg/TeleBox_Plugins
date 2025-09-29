/*!
 * name=javDB
 * desc=番号查询（TeleBox 标准插件）
 * priority=10
 * author=原作者𝑺𝒍𝒊𝒗𝒆𝒓𝒌𝒊𝒔𝒔 @ios151支持telebox
 * */

import axios from "axios";
import * as cheerio from "cheerio";
import dayjs from "dayjs";

// TeleBox 内部工具
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";

import { Api } from "telegram";

/*********************** 工具与常量 ************************/ 
const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";

const CN_TIME_ZONE = "Asia/Shanghai";
const MAX_MESSAGE_LENGTH = 4096;

const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  }[m] || m));

function chunkHtml(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let buf = "";
  const push = () => { if (buf) { out.push(buf); buf = ""; } };
  for (const ch of text) {
    buf += ch;
    if (buf.length >= limit - 16) {
      let cut = Math.max(buf.lastIndexOf("\n"), buf.lastIndexOf(" "));
      if (cut < limit * 0.6) cut = buf.length;
      let part = buf.slice(0, cut);
      if (part.endsWith("<") || part.endsWith("&")) part = part.slice(0, -1);
      out.push(part);
      buf = buf.slice(part.length);
    }
  }
  push();
  return out;
}

async function sendLongMessage(msg: Api.Message, html: string) {
  const parts = chunkHtml(html);
  const first = parts[0] + (parts.length > 1 ? `\n\n📄 (1/${parts.length})` : "");
  try {
    await msg.edit({ text: first, parseMode: "html" });
  } catch {
    await msg.reply({ message: first, parseMode: "html" });
  }
  for (let i = 1; i < parts.length; i++) {
    await msg.reply({ message: `${parts[i]}\n\n📄 (${i + 1}/${parts.length})`, parseMode: "html" });
  }
}

/*********************** 站点抓取 ************************/ 
interface MovieItem {
  code: string;
  link: string;
  title: string;
  thumb: string;
  score: string;
  meta: string;
  detail?: Partial<MovieDetail> & { score?: string };
}

interface MovieDetail {
  director: string;
  maker: string;
  series: string;
  duration: string;
  releaseDate: string;
  actors: Array<{ name: string; gender: "male" | "female" }>;
  tags: string[];
  previewVideo: string;
  previewImages: string[];
}

class JavDBClient {
  constructor(public code: string, public baseURL = "https://javdb.com") {}

  async search(): Promise<MovieItem[]> {
    const url = `${this.baseURL}/search?q=${encodeURIComponent(this.code)}&f=all`;
    const { data } = await axios.get<string>(url, {
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9",
        "user-agent": "Mozilla/5.0 TeleBoxBot",
      },
      timeout: 15000,
    });
    const $ = cheerio.load(data);
    const $list = $(".movie-list");
    const list: MovieItem[] = $list.find(".item").toArray().map((el) => {
      const $a = $(el).find("a");
      const title = $a.find(".video-title").text().trim();
      const code = (/([A-Za-z]+-\d+)/.exec(title)?.[1] || "").replace(/\s+/g, "").toUpperCase();
      return {
        code,
        link: this.baseURL + ($a.attr("href") || ""),
        title,
        thumb: $a.find(".cover img").attr("src") || "",
        score: $a.find(".score span.value").text().trim() || "",
        meta: $a.find(".meta").text().trim() || "",
      };
    });
    return list;
  }

  async detail(url: string): Promise<Partial<MovieDetail> & { score?: string }> {
    const { data: html } = await axios.get<string>(url, {
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9",
        "user-agent": "Mozilla/5.0 TeleBoxBot",
      },
      timeout: 15000,
    });
    const $ = cheerio.load(html);
    const getPanelValue = (label: string) =>
      $(`.panel-block strong:contains("${label}")`).parent().find(".value").text().trim();
    const getPanelLinkValue = (label: string) =>
      $(`.panel-block strong:contains("${label}")`).parent().find(".value a").first().text().trim();

    const detail: Partial<MovieDetail> & { score?: string } = {};
    detail.director = getPanelLinkValue("導演") || undefined;
    detail.maker = getPanelLinkValue("片商") || undefined;
    detail.series = getPanelLinkValue("系列") || undefined;
    detail.duration = getPanelValue("時長") || undefined;
    detail.releaseDate = getPanelValue("日期") || undefined;

    const actorsBlock = $(`.panel-block strong:contains("演員")`).parent().find(".value");
    const actors = actorsBlock.find("a").map((_, el) => {
      const $el = $(el);
      return {
        name: $el.text().trim(),
        gender: ($el.next(".symbol").hasClass("female") ? "female" : "male") as const,
      };
    }).get();
    if (actors.length) detail.actors = actors;

    const tagsBlock = $(`.panel-block strong:contains("類別")`).parent().find(".value");
    const tags = tagsBlock.find("a").map((_, el) => $(el).text().trim()).get();
    if (tags.length) detail.tags = tags;

    const scoreEl = $(".score .value").first();
    if (scoreEl.length) detail.score = scoreEl.text().trim();

    const previewVideo = $("#preview-video source").attr("src");
    if (previewVideo) detail.previewVideo = previewVideo.startsWith("http") ? previewVideo : `https:${previewVideo}`;

    const previewImages = $(".preview-images .tile-item.preview-images-item").map((_, el) => $(el).attr("href") || "").get();
    if (previewImages.length) detail.previewImages = previewImages;

    // 去空
    Object.keys(detail).forEach((k) => {
      const v: any = (detail as any)[k];
      if (!v || (Array.isArray(v) && v.length === 0)) delete (detail as any)[k];
    });
    return detail;
  }
}

/*********************** 打分/文本处理 ************************/ 
function generateRating(text: string): string {
  // 兼容 "4.7" 或 "4.7分" 等
  const m = text.match(/(\d+(?:\.\d+)?)/);
  if (!m) return "暂无评分";
  let score = parseFloat(m[1]);
  if (!Number.isFinite(score)) return "暂无评分";
  if (score < 0) score = 0; if (score > 5) score = 5;
  const full = Math.floor(score);
  const half = score % 1 >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  const stars = "★".repeat(full) + (half ? "✩" : "") + "☆".repeat(empty);
  return `${stars} ${score.toFixed(2)}分`;
}

function extractInfo(title: string): { id: string | null; description: string | null } {
  const idRegex = /[A-Z]+-\d+/;
  const m = title?.match(idRegex) || null;
  const id = m ? m[0] : null;
  const descM = title?.match(/([A-Z]+-\d+)\s+(.+)/);
  return { id, description: descM ? descM[2] : null };
}

/*********************** 插件实现 ************************/ 
const help_text = `🎬 <b>JavDB 番号查询</b>

<b>用法：</b>
<code>${mainPrefix}av 番号</code> 例如 <code>${mainPrefix}av ABP-123</code>

<b>说明：</b>
• javdb.com 搜索结果并展示详情/演员/标签/评分
• 自动附带 MissAV 在线观看链接
• 有预告片则追加一条链接 60s 后撤回`;

class JavDBPlugin extends Plugin {
  description: string = `JavDB 番号查询\n\n${help_text}`;

  cmdHandlers = {
    av: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      // 参数解析
      const text = (msg as any).message || (msg as any).text || "";
      const parts = text.trim().split(/\s+/g);
      const [, ...args] = parts; // 跳过命令
      const queryRaw = args.join(" ") || "";

      if (!queryRaw) {
        await msg.edit({ text: `❌ <b>参数不足</b>\n\n${help_text}`, parseMode: "html" });
        return;
      }

      const code = queryRaw.toUpperCase();

      try {
        await msg.edit({ text: "🔎 正在查询...", parseMode: "html" });
        const api = new JavDBClient(code);
        const list = await api.search();
        const item = list.find((it) => it.code === code) || list[0];

        if (!item) {
          await msg.edit({ text: "😿 未找到相关番号，请更换关键词", parseMode: "html" });
          return;
        }

        const detail = await api.detail(item.link);
        item.detail = detail;

        // 文本拼装
        const { id } = extractInfo(item.title);
        const scoreText = generateRating(detail.score || item.score || "");

        const fields: string[] = [];
        if (detail.director) fields.push(`导演：${htmlEscape(detail.director)}`);
        if (detail.series) fields.push(`系列：${htmlEscape(detail.series)}`);
        if (detail.releaseDate) fields.push(`日期：${htmlEscape(detail.releaseDate)}`);
        if (detail.duration) fields.push(`时长：${htmlEscape(detail.duration)}`);
        if (detail.actors?.length) fields.push(`演员：${htmlEscape(detail.actors.map(a => a.name).join('、'))}`);
        if (detail.tags?.length) fields.push(`标签：${htmlEscape(detail.tags.join('、'))}`);

        const missUrl = `https://missav.ws/${encodeURIComponent(code)}`;
        const caption = [
          `番号：${htmlEscape(id || code)}`,
          htmlEscape(item.title || code),
          fields.join("\n"),
          `评分  ${htmlEscape(scoreText)}`,
          `\n🔗 <a href="${htmlEscape(item.link)}">JavDB</a> | <a href="${htmlEscape(missUrl)}">MissAV</a>`
        ].filter(Boolean).join("\n");

        // 先尝试编辑为图文，若无图则退化为文本
        const photoUrl = item.thumb?.startsWith("http") ? item.thumb : `https:${item.thumb || ""}`;
        let sent: Api.Message | undefined;
        try {
          sent = await client.sendFile(msg.peerId!, {
            file: photoUrl,
            caption,
            parseMode: "html",
            replyTo: (msg as any).replyToMsgId,
          });
          try { await msg.delete({ revoke: true }); } catch {}
        } catch {
          await sendLongMessage(msg, caption);
        }

        // 有预告片就再回一条链接（按钮在 GramJS 下写起来更繁琐，用链接更稳）
        if (detail.previewVideo && sent) {
          await client.sendMessage(msg.peerId!, {
            message: `🎬 预告片：<a href="${htmlEscape(detail.previewVideo)}">点击观看</a>`,
            parseMode: "html",
            replyTo: sent.id,
          });
        }

        // 60 秒后自动撤回
        if (sent) {
          setTimeout(async () => {
            try { await client.deleteMessages(msg.peerId!, [sent!.id], { revoke: true }); } catch {}
          }, 60_000);
        }

      } catch (error: any) {
        const m = String(error?.message || error);
        if (m.includes("FLOOD_WAIT")) {
          const wait = parseInt(m.match(/\d+/)?.[0] || "60", 10);
          await msg.edit({ text: `⏳ <b>请求过于频繁</b>\n\n需要等待 ${wait} 秒后重试`, parseMode: "html" });
          return;
        }
        if (m.includes("MESSAGE_TOO_LONG")) {
          await msg.edit({ text: "❌ <b>消息过长</b>\n\n请减少内容或以文件方式发送", parseMode: "html" });
          return;
        }
        await msg.edit({ text: `❌ <b>查询失败：</b>${htmlEscape(m)}`, parseMode: "html" });
      }
    },

    // 别名：.jav / .jd
    jav: async (m: Api.Message) => this.cmdHandlers.av(m),
    jd: async (m: Api.Message) => this.cmdHandlers.av(m),
  };
}

export default new JavDBPlugin();

/*!
 * name=javDB
 * desc=番号查询（TeleBox 标准插件）
 * priority=10
 * author=原作者𝑺𝒍𝒊𝒗𝒆𝒓𝒌𝒊𝒔𝒔 @ios151支持telebox
 */

//@ts-nocheck
import axios from "axios";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";

import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads";

/*********************** 工具与常量 ************************/
const mainPrefix = (getPrefixes()[0] || ".");
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
  if (buf) out.push(buf);
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

/*********************** 抓取逻辑（函数化，避免“未使用方法”） ************************/
type MovieItem = {
  code: string;
  link: string;
  title: string;
  thumb: string;
  score: string;
  meta: string;
};
type MovieDetail = Partial<{
  director: string;
  maker: string;
  series: string;
  duration: string;
  releaseDate: string;
  actors: Array<{ name: string; gender: "male" | "female" }>;
  tags: string[];
  previewImages: string[];
  score: string;
}>;

async function searchByCode(code: string): Promise<MovieItem[]> {
  const url = `https://javdb.com/search?q=${encodeURIComponent(code)}&f=all`;
  const { data } = await axios.get<string>(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9",
      "user-agent": "Mozilla/5.0 TeleBoxBot",
    },
    timeout: 15000,
  });

  const $ = cheerio.load(data);
  return $(".movie-list .item").toArray().map((el) => {
    const $a = $(el).find("a");
    const title = $a.find(".video-title").text().trim();
    const codeInTitle = (/([A-Za-z]+-\d+)/.exec(title)?.[1] || "")
      .replace(/\s+/g, "")
      .toUpperCase();
    return {
      code: codeInTitle,
      link: "https://javdb.com" + ($a.attr("href") || ""),
      title,
      thumb: $a.find(".cover img").attr("src") || "",
      score: $a.find(".score span.value").text().trim() || "",
      meta: $a.find(".meta").text().trim() || "",
    };
  });
}

async function fetchDetail(url: string): Promise<MovieDetail> {
  const { data: html } = await axios.get<string>(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

  const detail: MovieDetail = {};
  const director = getPanelLinkValue("導演");
  const maker = getPanelLinkValue("片商");
  const series = getPanelLinkValue("系列");
  const duration = getPanelValue("時長");
  const releaseDate = getPanelValue("日期");
  if (director) detail.director = director;
  if (maker) detail.maker = maker;
  if (series) detail.series = series;
  if (duration) detail.duration = duration;
  if (releaseDate) detail.releaseDate = releaseDate;

  const actorsBlock = $(`.panel-block strong:contains("演員")`).parent().find(".value");
  const actors = actorsBlock.find("a").map((_, el) => {
    const $el = $(el);
    const gender: "male" | "female" = $el.next(".symbol").hasClass("female") ? "female" : "male";
    return { name: $el.text().trim(), gender };
  }).get();
  if (actors.length) detail.actors = actors;

  const tagsBlock = $(`.panel-block strong:contains("類別")`).parent().find(".value");
  const tags = tagsBlock.find("a").map((_, el) => $(el).text().trim()).get();
  if (tags.length) detail.tags = tags;

  const sc = $(".score .value").first().text().trim();
  if (sc) detail.score = sc;

  const previewImages = $(".preview-images .tile-item.preview-images-item")
    .map((_, el) => $(el).attr("href") || "")
    .get();
  if (previewImages.length) detail.previewImages = previewImages;

  return detail;
}

/*********************** 打分/文本处理 ************************/
function generateRating(text: string): string {
  const m = text.match(/(\d+(?:\.\d+)?)/);
  if (!m) return "暂无评分";
  let score = parseFloat(m[1]);
  if (!Number.isFinite(score)) return "暂无评分";
  if (score < 0) score = 0;
  if (score > 5) score = 5;
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
<code>${mainPrefix}javdb 番号</code>（等价）

<b>说明：</b>
• 抓取 javdb.com 搜索结果并展示详情/演员/标签/评分
• 直接附带 MissAV 在线观看链接`;

class JavDBPlugin extends Plugin {
  description: string = `JavDB 番号查询\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {};

  constructor() {
    super();
    // 避免未使用字段告警
    const h = this.handleAv.bind(this);
    this.cmdHandlers["av"] = h;
    this.cmdHandlers["jav"] = h;
    this.cmdHandlers["jd"] = h;
    this.cmdHandlers["javdb"] = h;
  }

  private async handleAv(msg: Api.Message) {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    const text = (msg as any).message || (msg as any).text || "";
    const parts = text.trim().split(/\s+/g);
    const [, ...args] = parts;
    const queryRaw = args.join(" ") || "";

    if (!queryRaw || /^(help|h)$/i.test(queryRaw)) {
      await msg.edit({ text: help_text, parseMode: "html" });
      return;
    }

    const code = queryRaw.toUpperCase();

    try {
      await msg.edit({ text: "🔎 正在查询...", parseMode: "html" });

      const items = await searchByCode(code);
      const item = items.find((it) => it.code === code) || items[0];

      if (!item) {
        await msg.edit({ text: "😿 未找到相关番号，请更换关键词", parseMode: "html" });
        return;
      }

      const detail = await fetchDetail(item.link);

      const { id } = extractInfo(item.title);
      const scoreText = generateRating(detail.score || item.score || "");

      const fields: string[] = [];
      if (detail.director) fields.push(`导演：${htmlEscape(detail.director)}`);
      if (detail.series) fields.push(`系列：${htmlEscape(detail.series)}`);
      if (detail.releaseDate) fields.push(`日期：${htmlEscape(detail.releaseDate)}`);
      if (detail.duration) fields.push(`时长：${htmlEscape(detail.duration)}`);
      if (detail.actors?.length) fields.push(`演员：${htmlEscape(detail.actors.map(a => a.name).join("、"))}`);
      if (detail.tags?.length) fields.push(`标签：${htmlEscape(detail.tags.join("、"))}`);

      const missUrl = `https://missav.ws/${encodeURIComponent(code)}`;
      const caption = [
        `番号：${htmlEscape(id || code)}`,
        htmlEscape(item.title || code),
        fields.join("\n"),
        `评分  ${htmlEscape(scoreText)}`,
        `\n🔗 <a href="${htmlEscape(item.link)}">JavDB</a> | <a href="${htmlEscape(missUrl)}">MissAV</a>`,
      ].filter(Boolean).join("\n");

      const rawThumb = item.thumb || "";
      const photoUrl = rawThumb.startsWith("http") ? rawThumb : `https:${rawThumb}`;
      let sent: Api.Message | undefined;

      try {
        // 下载封面
        const imgResp = await axios.get<ArrayBuffer>(photoUrl, {
          responseType: "arraybuffer",
          timeout: 20000,
          headers: {
            "user-agent": "Mozilla/5.0 TeleBoxBot",
            "referer": item.link,
            "accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          },
        });
        if (imgResp.status !== 200 || !imgResp.data) throw new Error(`下载封面失败: HTTP ${imgResp.status}`);

        // 写入临时文件
        const tmpPath = path.join(os.tmpdir(), `javdb_cover_${Date.now()}.jpg`);
        await fs.promises.writeFile(tmpPath, Buffer.from(imgResp.data as any));

        try {
          // 上传并加剧透
          const toUpload = new CustomFile(path.basename(tmpPath), fs.statSync(tmpPath).size, tmpPath);
          const handle = await client.uploadFile({ file: toUpload, workers: 1 });

          sent = await client.sendFile(msg.peerId!, {
            file: new Api.InputMediaUploadedPhoto({ file: handle, spoiler: true }),
            caption,
            parseMode: "html",
            replyTo: (msg as any).replyToMsgId,
          });

          try { await msg.delete({ revoke: true }); } catch {}
        } finally {
          try { await fs.promises.unlink(tmpPath); } catch {}
        }
      } catch {
        await sendLongMessage(msg, caption);
      }

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
  }
}

export default new JavDBPlugin();

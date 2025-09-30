/**
 * @name javdb
 * @desc JavDB 番号查询插件
 * @priority 10
 * @author 原作者 𝑺𝒍𝒊𝒗𝒆𝒓𝒌𝒊𝒔𝒔 | TeleBox @ios151
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

// ==================== 工具函数与常量 ====================
/** 获取命令前缀 */
const mainPrefix = (getPrefixes()[0] || ".");

/** Telegram 消息最大长度限制 */
const MAX_MESSAGE_LENGTH = 4096;

/** HTML 转义函数（安全处理用户输入）*/
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  }[m] || m));

/** 分割 HTML 文本为多个分段（避免超过长度限制）*/
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

/** 发送长消息（自动分割为多条）*/
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

// ==================== 类型定义 ====================
/** 电影搜索结果项 */
type MovieItem = {
  code: string;
  link: string;
  title: string;
  thumb: string;
  score: string;
  meta: string;
};

/** 电影详细信息 */
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

// ==================== 网络请求函数 ====================
/** 根据番号搜索电影 */
async function searchByCode(code: string): Promise<MovieItem[]> {
  // 构建搜索 URL
  const url = `https://javdb.com/search?q=${encodeURIComponent(code)}&f=all`;
  
  // 发送 HTTP 请求
  const { data } = await axios.get<string>(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9",
      "user-agent": "Mozilla/5.0 TeleBoxBot",
    },
    timeout: 15000,
  });

  // 解析 HTML 响应
  const $ = cheerio.load(data);
  
  // 提取搜索结果
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

/** 获取电影详细信息 */
async function fetchDetail(url: string): Promise<MovieDetail> {
  // 请求详情页面
  const { data: html } = await axios.get<string>(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9",
      "user-agent": "Mozilla/5.0 TeleBoxBot",
    },
    timeout: 15000,
  });

  // 解析 HTML
  const $ = cheerio.load(html);
  
  // 定义解析工具函数
  const getPanelValue = (label: string) =>
    $(`.panel-block strong:contains("${label}")`).parent().find(".value").text().trim();
  const getPanelLinkValue = (label: string) =>
    $(`.panel-block strong:contains("${label}")`).parent().find(".value a").first().text().trim();

  // 提取基本信息
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

  // 提取演员信息
  const actorsBlock = $(`.panel-block strong:contains("演員")`).parent().find(".value");
  const actors = actorsBlock.find("a").map((_, el) => {
    const $el = $(el);
    const gender: "male" | "female" = $el.next(".symbol").hasClass("female") ? "female" : "male";
    return { name: $el.text().trim(), gender };
  }).get();
  if (actors.length) detail.actors = actors;

  // 提取标签信息
  const tagsBlock = $(`.panel-block strong:contains("類別")`).parent().find(".value");
  const tags = tagsBlock.find("a").map((_, el) => $(el).text().trim()).get();
  if (tags.length) detail.tags = tags;

  // 提取评分
  const sc = $(".score .value").first().text().trim();
  if (sc) detail.score = sc;

  // 提取预览图
  const previewImages = $(".preview-images .tile-item.preview-images-item")
    .map((_, el) => $(el).attr("href") || "")
    .get();
  if (previewImages.length) detail.previewImages = previewImages;

  return detail;
}

// ==================== 文本处理函数 ====================
/** 生成评分星级显示 */
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

/** 从标题提取番号和描述 */
function extractInfo(title: string): { id: string | null; description: string | null } {
  const idRegex = /[A-Z]+-\d+/;
  const m = title?.match(idRegex) || null;
  const id = m ? m[0] : null;
  const descM = title?.match(/([A-Z]+-\d+)\s+(.+)/);
  return { id, description: descM ? descM[2] : null };
}

// ==================== 插件实现 ====================
const help_text = `🎬 <b>JavDB 番号查询</b>

<b>指令格式：</b>
<code>${mainPrefix}javdb &lt;番号&gt;</code>
<code>${mainPrefix}av &lt;番号&gt;</code>
<code>${mainPrefix}jav &lt;番号&gt;</code>
<code>${mainPrefix}jd &lt;番号&gt;</code>

<b>使用示例：</b>
<code>${mainPrefix}av ABP-123</code>
<code>${mainPrefix}javdb SSIS-001</code>
<code>${mainPrefix}av start 128</code> （支持空格，自动转为 START-128）

<b>功能说明：</b>
• 查询 JavDB 数据库，获取番号详情
• 显示导演、系列、演员、标签等信息
• 封面图自动添加剧透标记，60秒后自动销毁
• 附带 JavDB 和 MissAV 在线观看链接`;

class JavDBPlugin extends Plugin {
  description: string = `JavDB 番号查询\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {};

  constructor() {
    super();
    // 注册指令别名（独立指令模式）
    const h = this.handleAv.bind(this);
    this.cmdHandlers["javdb"] = h;  // 主指令
    this.cmdHandlers["av"] = h;     // 别名1：通用
    this.cmdHandlers["jav"] = h;    // 别名2：简写
    this.cmdHandlers["jd"] = h;     // 别名3：超短
  }

  /** 处理番号查询指令 */
  private async handleAv(msg: Api.Message) {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    // 解析参数
    const text = (msg as any).message || (msg as any).text || "";
    const parts = text.trim().split(/\s+/g);
    const [, ...args] = parts;
    const queryRaw = args.join(" ") || "";

    if (!queryRaw || /^(help|h)$/i.test(queryRaw)) {
      await msg.edit({ text: help_text, parseMode: "html" });
      return;
    }

    // 规范化番号格式：去除多余空格，将空格替换为连字符
    // 例："start 128" -> "START-128"
    const code = queryRaw.trim().replace(/\s+/g, "-").toUpperCase();

    try {
      // 步骤1：搜索番号
      await msg.edit({ text: "🔎 正在查询...", parseMode: "html" });
      const items = await searchByCode(code);
      const item = items.find((it) => it.code === code) || items[0];

      if (!item) {
        await msg.edit({ text: "😿 未找到相关番号，请更换关键词", parseMode: "html" });
        return;
      }

      // 步骤2：获取详细信息
      const detail = await fetchDetail(item.link);

      // 步骤3：格式化数据
      const { id } = extractInfo(item.title);
      const scoreText = generateRating(detail.score || item.score || "");

      const fields: string[] = [];
      if (detail.director) fields.push(`导演：${htmlEscape(detail.director)}`);
      if (detail.series) fields.push(`系列：${htmlEscape(detail.series)}`);
      if (detail.releaseDate) fields.push(`日期：${htmlEscape(detail.releaseDate)}`);
      if (detail.duration) fields.push(`时长：${htmlEscape(detail.duration)}`);
      if (detail.actors?.length) fields.push(`演员：${htmlEscape(detail.actors.map(a => a.name).join("、"))}`);
      if (detail.tags?.length) fields.push(`标签：${htmlEscape(detail.tags.join("、"))}`);

      // 步骤4：构建显示文本
      const missUrl = `https://missav.ws/${encodeURIComponent(code)}`;
      const caption = [
        `番号：${htmlEscape(id || code)}`,
        htmlEscape(item.title || code),
        fields.join("\n"),
        `评分  ${htmlEscape(scoreText)}`,
        `\n🔗 <a href="${htmlEscape(item.link)}">JavDB</a> | <a href="${htmlEscape(missUrl)}">MissAV</a>`,
      ].filter(Boolean).join("\n");

      // 步骤5：处理封面图
      const rawThumb = item.thumb || "";
      const photoUrl = rawThumb.startsWith("http") ? rawThumb : `https:${rawThumb}`;
      let sent: Api.Message | undefined;

      try {
        // 下载封面图
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

        // 保存到临时文件
        const tmpPath = path.join(os.tmpdir(), `javdb_cover_${Date.now()}.jpg`);
        await fs.promises.writeFile(tmpPath, Buffer.from(imgResp.data as any));

        try {
          // 上传文件并发送（带剧透标记）
          const toUpload = new CustomFile(path.basename(tmpPath), fs.statSync(tmpPath).size, tmpPath);
          const handle = await client.uploadFile({ file: toUpload, workers: 1 });

          sent = await client.sendFile(msg.peerId!, {
            file: new Api.InputMediaUploadedPhoto({ file: handle, spoiler: true }),
            caption,
            parseMode: "html",
            replyTo: (msg as any).replyToMsgId,
          });

          // 删除原查询消息
          try { await msg.delete({ revoke: true }); } catch {}
        } finally {
          // 清理临时文件
          try { await fs.promises.unlink(tmpPath); } catch {}
        }
      } catch {
        // 封面下载失败，仅发送文本
        await sendLongMessage(msg, caption);
      }

      // 定时销毁（60秒）
      if (sent) {
        setTimeout(async () => {
          try { await client.deleteMessages(msg.peerId!, [sent!.id], { revoke: true }); } catch {}
        }, 60_000);
      }
    } catch (error: any) {
      // 错误处理
      console.error("[javdb] 查询失败:", error);
      const m = String(error?.message || error);
      
      // 处理 Telegram API 频率限制
      if (m.includes("FLOOD_WAIT")) {
        const wait = parseInt(m.match(/\d+/)?.[0] || "60", 10);
        await msg.edit({ text: `⏳ <b>请求过于频繁</b>\n\n需要等待 ${wait} 秒后重试`, parseMode: "html" });
        return;
      }
      
      // 处理消息过长错误
      if (m.includes("MESSAGE_TOO_LONG")) {
        await msg.edit({ text: "❌ <b>消息过长</b>\n\n请减少内容或以文件方式发送", parseMode: "html" });
        return;
      }
      
      // 通用错误处理
      await msg.edit({ text: `❌ <b>查询失败：</b>${htmlEscape(m)}`, parseMode: "html" });
    }
  }
}

export default new JavDBPlugin();

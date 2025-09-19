import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const htmlEscape = (text: string): string =>
  (text || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m);

const filterInput = (s: string): string => (s || "").split("").filter(c => /[\w\- ]/u.test(c)).join("");

function readJsonArray(file: string): string[] {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function getPopSentence(file: string, originals: string[] = [], replacers: string[] = []): string | null {
  const list = readJsonArray(file);
  if (!list.length) return null;
  let item = list[Math.floor(Math.random() * list.length)] as string;
  if (replacers.length === 1) item = item.replace("<name>", replacers[0]);
  if (replacers.length === 2) item = item.replace("<name1>", replacers[0]).replace("<name2>", replacers[1]);
  return item;
}

const help_text = `🗒️ <b>发电语录插件</b>

<b>用法：</b>
• <code>${mainPrefix}fadian fd &lt;名字&gt;</code> - 心理语录（psycho.json）
• <code>${mainPrefix}fadian tg</code> - TG 语录（tg.json）
• <code>${mainPrefix}fadian kfc</code> - KFC 语录（kfc.json）
• <code>${mainPrefix}fadian wyy</code> - 网抑云语录（wyy.json）
• <code>${mainPrefix}fadian cp</code> + 第二行/第三行为两个名字（cp.json）
• <code>${mainPrefix}fadian help</code> - 查看帮助`;

class FadianPlugin extends Plugin {
  description: string = `从本地 JSON 语料随机生成语录\n\n${help_text}`;

  cmdHandlers = {
    fadian: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines[0]?.split(/\s+/g) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();

      if (!sub || sub === "help" || sub === "h") {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }

      const baseDir = path.join(__dirname, "fadian");
      try {
        switch (sub) {
          case "fd": {
            const raw = (args.slice(1).join(" ") || lines[1] || "").trim();
            if (!raw) {
              await msg.edit({ text: `❌ <b>参数不足</b>\n\n示例：<code>${mainPrefix}fadian fd 张三</code>`, parseMode: "html" });
              return;
            }
            const name = filterInput(raw);
            const res = getPopSentence(path.join(baseDir, "psycho.json"), ["<name>"], [htmlEscape(name)]);
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          case "tg": {
            const res = getPopSentence(path.join(baseDir, "tg.json"));
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          case "kfc": {
            const res = getPopSentence(path.join(baseDir, "kfc.json"));
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          case "wyy": {
            const res = getPopSentence(path.join(baseDir, "wyy.json"));
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          case "cp": {
            const a = filterInput((lines[1] || args[1] || "").trim());
            const b = filterInput((lines[2] || args[2] || "").trim());
            if (!a || !b) {
              await msg.edit({ text: `❌ <b>参数不足</b>\n\n在第2/3行输入两个名字，或：<code>${mainPrefix}fadian cp A B</code>`, parseMode: "html" });
              return;
            }
            const res = getPopSentence(path.join(baseDir, "cp.json"), ["<name1>", "<name2>"], [htmlEscape(a), htmlEscape(b)]);
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          default:
            await msg.edit({ text: `❌ <b>未知子命令:</b> <code>${htmlEscape(sub)}</code>\n\n${help_text}`, parseMode: "html" });
        }
      } catch (e: any) {
        await msg.edit({ text: `❌ <b>执行失败:</b> ${htmlEscape(e?.message || "未知错误")}` , parseMode: "html"});
      }
    }
  };
}

export default FadianPlugin;

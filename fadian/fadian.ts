import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "telegram";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 远程配置URL
const baseRepoURL = "https://github.com/TeleBoxOrg/TeleBox_Plugins/raw/refs/heads/main/fadian/";
const ASSET_PATH = createDirectoryInAssets("fadian");

// 配置文件映射
const configFiles = {
  psycho: "psycho.json",
  tg: "tg.json", 
  kfc: "kfc.json",
  wyy: "wyy.json",
  cp: "cp.json"
};

// 缓存配置数据
let configCache: { [key: string]: string[] } = {};
let lastUpdateCheck = 0;
const UPDATE_INTERVAL = 5 * 60 * 1000; // 5分钟检查一次

const htmlEscape = (text: string): string =>
  (text || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as any)[m] || m);

const filterInput = (s: string): string => (s || "").split("").filter(c => /[\w\- ]/u.test(c)).join("");

// 从本地缓存读取JSON数组
function readJsonArray(file: string): string[] {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// 下载并缓存配置文件
async function downloadConfigFile(filename: string): Promise<void> {
  try {
    const url = baseRepoURL + filename;
    const localPath = path.join(ASSET_PATH, filename);
    
    const response = await axios.get(url);
    fs.mkdirSync(ASSET_PATH, { recursive: true });
    fs.writeFileSync(localPath, JSON.stringify(response.data, null, 2));
    
    // 更新缓存
    configCache[filename] = Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    console.error(`下载配置文件失败: ${filename}`, error);
  }
}

// 确保配置文件存在并是最新的
async function ensureConfigFile(filename: string): Promise<string[]> {
  const localPath = path.join(ASSET_PATH, filename);
  const now = Date.now();
  
  // 检查是否需要更新
  if (!fs.existsSync(localPath) || (now - lastUpdateCheck > UPDATE_INTERVAL)) {
    await downloadConfigFile(filename);
    lastUpdateCheck = now;
  }
  
  // 从缓存获取，如果缓存为空则从文件读取
  if (!configCache[filename] && fs.existsSync(localPath)) {
    configCache[filename] = readJsonArray(localPath);
  }
  
  return configCache[filename] || [];
}

async function getPopSentence(filename: string, originals: string[] = [], replacers: string[] = []): Promise<string | null> {
  const list = await ensureConfigFile(filename);
  if (!list.length) return null;
  let item = list[Math.floor(Math.random() * list.length)] as string;
  if (replacers.length === 1) item = item.replace("<name>", replacers[0]);
  if (replacers.length === 2) item = item.replace("<name1>", replacers[0]).replace("<name2>", replacers[1]);
  return item;
}

const help_text = `🗒️ <b>发电语录插件</b>

<b>用法：</b>
• <code>${mainPrefix}fadian fd &lt;名字&gt;</code> - 心理语录
• <code>${mainPrefix}fadian tg</code> - TG 语录
• <code>${mainPrefix}fadian kfc</code> - KFC 语录
• <code>${mainPrefix}fadian wyy</code> - 网抑云语录
• <code>${mainPrefix}fadian cp</code> + 第二行/第三行为两个名字
• <code>${mainPrefix}fadian clear</code> - 清理缓存并重新下载
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

      if (sub === "clear") {
        await this.clearCache(msg);
        return;
      }

      try {
        switch (sub) {
          case "fd": {
            const raw = (args.slice(1).join(" ") || lines[1] || "").trim();
            if (!raw) {
              await msg.edit({ text: `❌ <b>参数不足</b>\n\n示例：<code>${mainPrefix}fadian fd 张三</code>`, parseMode: "html" });
              return;
            }
            const name = filterInput(raw);
            const res = await getPopSentence(configFiles.psycho, ["<name>"], [htmlEscape(name)]);
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          case "tg": {
            const res = await getPopSentence(configFiles.tg);
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          case "kfc": {
            const res = await getPopSentence(configFiles.kfc);
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          case "wyy": {
            const res = await getPopSentence(configFiles.wyy);
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
            const res = await getPopSentence(configFiles.cp, ["<name1>", "<name2>"], [htmlEscape(a), htmlEscape(b)]);
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

  private async clearCache(msg: Api.Message): Promise<void> {
    try {
      // 清理本地缓存目录
      if (fs.existsSync(ASSET_PATH)) {
        fs.rmSync(ASSET_PATH, { recursive: true, force: true });
      }
      // 清理内存缓存
      configCache = {};
      lastUpdateCheck = 0;
      
      await msg.edit({ text: "🧹 已清理缓存，下次使用时将重新下载配置", parseMode: "html" });
    } catch (e: any) {
      await msg.edit({ text: `❌ 清理缓存失败: ${htmlEscape(e?.message || "未知错误")}`, parseMode: "html" });
    }
  }
}

export default FadianPlugin;

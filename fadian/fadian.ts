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
  if (replacers.length === 1) item = item.replace(/<name>/g, replacers[0]);
  if (replacers.length === 2) item = item.replace(/<name1>/g, replacers[0]).replace(/<name2>/g, replacers[1]);
  return item;
}

const help_text = `🗒️ <b>发电语录插件</b>

<b>命令格式：</b>
<code>${mainPrefix}fadian [子命令] [参数]</code>

<b>子命令：</b>
• <code>${mainPrefix}fadian fd [名字]</code> - 心理语录（回复消息时自动获取对方昵称）
• <code>${mainPrefix}fadian tg</code> - TG 语录
• <code>${mainPrefix}fadian kfc</code> - KFC 语录
• <code>${mainPrefix}fadian wyy</code> - 网抑云语录
• <code>${mainPrefix}fadian cp</code> + 第二行/第三行为两个名字
• <code>${mainPrefix}fadian clear</code> - 清理缓存并重新下载
• <code>${mainPrefix}fadian help</code> - 查看帮助

<b>使用示例：</b>
<code>${mainPrefix}fadian fd 张三</code> - 生成张三的心理语录
<code>${mainPrefix}fadian fd</code> (回复消息) - 自动生成被回复人的心理语录
<code>${mainPrefix}fadian cp</code>\n第一个人\n第二个人 - 生成CP语录`;

class FadianPlugin extends Plugin {
  description: string = `从远程配置随机生成发电语录\n\n${help_text}`;

  cmdHandlers = {
    fadian: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      // 标准参数解析模式
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();

      try {
        // 无参数时显示帮助
        if (!sub) {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        // 处理 help 在前的情况：.fadian help [subcommand]
        if (sub === "help" || sub === "h") {
          if (args[1]) {
            // 显示特定子命令的帮助
            const subCmd = args[1].toLowerCase();
            await this.showSubCommandHelp(subCmd, msg);
          } else {
            // 显示总帮助
            await msg.edit({ text: help_text, parseMode: "html" });
          }
          return;
        }

        // 处理 help 在后的情况：.fadian [subcommand] help
        if (args[1] && (args[1].toLowerCase() === "help" || args[1].toLowerCase() === "h")) {
          await this.showSubCommandHelp(sub, msg);
          return;
        }

        // 处理 clear 命令
        if (sub === "clear") {
          await this.clearCache(msg);
          return;
        }

        // 处理具体的子命令
        switch (sub) {
          case "fd": {
            let targetName = (args.slice(1).join(" ") || lines[1] || "").trim();
            
            // 如果没有提供名字，尝试从回复消息获取
            if (!targetName) {
              const replyMsg = await msg.getReplyMessage();
              if (replyMsg) {
                const sender = await replyMsg.getSender();
                if (sender && 'firstName' in sender) {
                  const firstName = sender.firstName || "";
                  const lastName = sender.lastName || "";
                  const username = sender.username || "";
                  
                  // 优先使用 firstName + lastName，其次使用 username
                  targetName = (firstName + (lastName ? " " + lastName : "")).trim() || username || "Ta";
                } else {
                  targetName = "Ta";
                }
              }
            }
            
            if (!targetName) {
              await msg.edit({ 
                text: `❌ <b>参数不足</b>\n\n💡 使用方法：\n1. <code>${mainPrefix}fadian fd &lt;名字&gt;</code>\n2. 回复某人消息后使用 <code>${mainPrefix}fadian fd</code>\n\n示例：<code>${mainPrefix}fadian fd 张三</code>`, 
                parseMode: "html" 
              });
              return;
            }
            
            const name = filterInput(targetName);
            await msg.edit({ text: "🔄 生成心理语录中...", parseMode: "html" });
            const res = await getPopSentence(configFiles.psycho, ["<name>"], [htmlEscape(name)]);
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          case "tg": {
            await msg.edit({ text: "🔄 生成TG语录中...", parseMode: "html" });
            const res = await getPopSentence(configFiles.tg);
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          case "kfc": {
            await msg.edit({ text: "🔄 生成KFC语录中...", parseMode: "html" });
            const res = await getPopSentence(configFiles.kfc);
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          case "wyy": {
            await msg.edit({ text: "🔄 生成网抑云语录中...", parseMode: "html" });
            const res = await getPopSentence(configFiles.wyy);
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          case "cp": {
            const a = filterInput((lines[1] || args[1] || "").trim());
            const b = filterInput((lines[2] || args[2] || "").trim());
            if (!a || !b) {
              await msg.edit({ 
                text: `❌ <b>参数不足</b>\n\n💡 使用方法：\n1. <code>${mainPrefix}fadian cp 名字1 名字2</code>\n2. 或者：<code>${mainPrefix}fadian cp</code>\n第二行写第一个名字\n第三行写第二个名字`, 
                parseMode: "html" 
              });
              return;
            }
            await msg.edit({ text: "🔄 生成CP语录中...", parseMode: "html" });
            const res = await getPopSentence(configFiles.cp, ["<name1>", "<name2>"], [htmlEscape(a), htmlEscape(b)]);
            await msg.edit({ text: res ? htmlEscape(res) : "❌ 数据为空", parseMode: "html" });
            break;
          }
          default:
            await msg.edit({
              text: `❌ <b>未知子命令:</b> <code>${htmlEscape(sub)}</code>\n\n💡 使用 <code>${mainPrefix}fadian help</code> 查看帮助`,
              parseMode: "html"
            });
        }
        
      } catch (error: any) {
        console.error("[fadian] 插件执行失败:", error);
        
        // 处理特定错误类型
        if (error.message?.includes("FLOOD_WAIT")) {
          const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
          await msg.edit({
            text: `⏳ <b>请求过于频繁</b>\n\n需要等待 ${waitTime} 秒后重试`,
            parseMode: "html"
          });
          return;
        }
        
        if (error.message?.includes("MESSAGE_TOO_LONG")) {
          await msg.edit({
            text: "❌ <b>消息过长</b>\n\n请减少内容长度或使用文件发送",
            parseMode: "html"
          });
          return;
        }
        
        // 通用错误处理
        await msg.edit({
          text: `❌ <b>插件执行失败:</b> ${htmlEscape(error.message || "未知错误")}`,
          parseMode: "html"
        });
      }
    }
  };

  private async showSubCommandHelp(subCmd: string, msg: Api.Message): Promise<void> {
    const helpTexts: { [key: string]: string } = {
      fd: `📖 <b>心理语录命令帮助</b>\n\n<code>${mainPrefix}fadian fd [名字]</code> - 生成心理语录\n\n<b>使用方式：</b>\n1. 直接指定名字：<code>${mainPrefix}fadian fd 张三</code>\n2. 回复消息后自动获取对方昵称：<code>${mainPrefix}fadian fd</code>`,
      tg: `📖 <b>TG语录命令帮助</b>\n\n<code>${mainPrefix}fadian tg</code> - 生成TG舔狗语录`,
      kfc: `📖 <b>KFC语录命令帮助</b>\n\n<code>${mainPrefix}fadian kfc</code> - 生成KFC疯狂星期四语录`,
      wyy: `📖 <b>网抑云语录命令帮助</b>\n\n<code>${mainPrefix}fadian wyy</code> - 生成网易云音乐热评语录`,
      cp: `📖 <b>CP语录命令帮助</b>\n\n<code>${mainPrefix}fadian cp 名字1 名字2</code> - 生成两人CP语录\n或者：\n<code>${mainPrefix}fadian cp</code>\n第二行写第一个名字\n第三行写第二个名字`,
      clear: `📖 <b>清理缓存命令帮助</b>\n\n<code>${mainPrefix}fadian clear</code> - 清理本地缓存并重新下载配置文件`
    };

    const helpText = helpTexts[subCmd] || help_text;
    await msg.edit({ text: helpText, parseMode: "html" });
  }

  private async clearCache(msg: Api.Message): Promise<void> {
    try {
      await msg.edit({ text: "🔄 清理缓存中...", parseMode: "html" });
      
      // 清理本地缓存目录
      if (fs.existsSync(ASSET_PATH)) {
        fs.rmSync(ASSET_PATH, { recursive: true, force: true });
      }
      // 清理内存缓存
      configCache = {};
      lastUpdateCheck = 0;
      
      await msg.edit({ text: "🧹 已清理缓存，下次使用时将重新下载配置", parseMode: "html" });
    } catch (error: any) {
      console.error("[fadian] 清理缓存失败:", error);
      await msg.edit({ 
        text: `❌ <b>清理缓存失败:</b> ${htmlEscape(error?.message || "未知错误")}`, 
        parseMode: "html" 
      });
    }
  }
}

export default new FadianPlugin();

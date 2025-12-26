"use strict";

import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import _ from "lodash";

// ==========================================
// 🛠️ 内置 Pangu 核心逻辑 (无需外部依赖)
// ==========================================
class PanguSpacer {
  // CJK 字符范围 (包括中日韩统一表意文字、注音、兼容表意文字等)
  private static readonly CJK = 
    "\u2e80-\u2eff\u2f00-\u2fdf\u3040-\u309f\u30a0-\u30fa\u30fc-\u30ff\u3100-\u312f\u3200-\u32ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff";
  
  // 基础正则
  private static readonly ANY_CJK = new RegExp(`[${PanguSpacer.CJK}]`);
  
  // 1. CJK 后面接 ANS (Alphabet/Number/Symbol) -> 加空格
  // 例: "你好World" -> "你好 World"
  // 排除: @ # (通常是标签), % (百分比), / (路径), - (连字符), _ (下划线)
  private static readonly CONVERT_TO_FULLWIDTH_CJK_SYMBOLS_CJK = new RegExp(
    `([${PanguSpacer.CJK}])[ ]*([\\:]+)(?=[${PanguSpacer.CJK}])`, "g"
  );

  private static readonly CJK_QUOTE = new RegExp(
    `([${PanguSpacer.CJK}])([\"\'])`, "g"
  );

  private static readonly QUOTE_CJK = new RegExp(
    `([\"\'])([${PanguSpacer.CJK}])`, "g"
  );

  private static readonly FIX_QUOTE_ANY_QUOTE = /([\"\'])\s*(.+?)\s*([\"\'])/g;

  private static readonly CJK_HASH = new RegExp(
    `([${PanguSpacer.CJK}])(#(\\S+))`, "g"
  );

  private static readonly HASH_CJK = new RegExp(
    `((\\S+)#)([${PanguSpacer.CJK}])`, "g"
  );

  // 核心规则：CJK 与 英数字 的间距
  private static readonly CJK_ANS = new RegExp(
    `([${PanguSpacer.CJK}])([a-z0-9\`~\\!\\$\\^\\&\\*\\-\\=\\+\\\\|\\;\\,\\.\\?\\/])`, "gi"
  );

  private static readonly ANS_CJK = new RegExp(
    `([a-z0-9\`~\\!\\$\\^\\&\\*\\-\\=\\+\\\\|\\;\\,\\.\\?\\/])([${PanguSpacer.CJK}])`, "gi"
  );

  // 处理括号
  private static readonly CJK_BRACKET_CJK = new RegExp(
    `([${PanguSpacer.CJK}])([\\(\\[\\{<>\u201c])(.*)([\\)\\]\\}>\u201d])([${PanguSpacer.CJK}])`, "g"
  );

  private static readonly CJK_BRACKET = new RegExp(
    `([${PanguSpacer.CJK}])([\\(\\[\\{<>\u201c])`, "g"
  );

  private static readonly BRACKET_CJK = new RegExp(
    `([\\)\\]\\}>\u201d])([${PanguSpacer.CJK}])`, "g"
  );

  private static readonly FIX_BRACKET_ANY_BRACKET = /([(\[{<>\u201c]+)(\s*)(.+?)(\s*)([)\]}>"\u201d]+)/g;

  private static readonly CJK_ANS_CJK = new RegExp(
    `([${PanguSpacer.CJK}])([a-z0-9\`~\\!\\$\\^\\&\\*\\-\\=\\+\\\\|\\;\\,\\.\\?\\/]+)([${PanguSpacer.CJK}])`, "gi"
  );

  private static readonly ANS_CJK_ANS = new RegExp(
    `([a-z0-9\`~\\!\\$\\^\\&\\*\\-\\=\\+\\\\|\\;\\,\\.\\?\\/]+)([${PanguSpacer.CJK}])([a-z0-9\`~\\!\\$\\^\\&\\*\\-\\=\\+\\\\|\\;\\,\\.\\?\\/]+)`, "gi"
  );

  /**
   * 执行格式化
   * @param text 原始文本
   */
  public static spacing(text: string): string {
    if (!text || text.length <= 1) return text;
    
    // 如果没有中文，直接返回，节省性能
    if (!PanguSpacer.ANY_CJK.test(text)) {
      return text;
    }

    // 保护 URL：简单的 URL 保护，避免破坏链接
    // 将 URL 替换为占位符 -> 处理文本 -> 还原 URL
    const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
    const urls: string[] = [];
    let tempText = text.replace(urlRegex, (match) => {
      urls.push(match);
      return `\uFFFF${urls.length - 1}\uFFFF`; // 使用特殊字符作为占位符
    });

    let newText = tempText;

    // CJK_QUOTE: CJK + " -> CJK + " " + "
    newText = newText.replace(PanguSpacer.CJK_QUOTE, "$1 $2");
    // QUOTE_CJK: " + CJK -> " " + " + CJK
    newText = newText.replace(PanguSpacer.QUOTE_CJK, "$1 $2");

    newText = newText.replace(PanguSpacer.FIX_QUOTE_ANY_QUOTE, "$1$2$3");

    // CJK_HASH: CJK + #word -> CJK + " " + #word
    newText = newText.replace(PanguSpacer.CJK_HASH, "$1 $2");
    // HASH_CJK: word# + CJK -> word# + " " + CJK
    newText = newText.replace(PanguSpacer.HASH_CJK, "$1 $3");

    // CJK_ANS: CJK + ANS -> CJK + " " + ANS
    newText = newText.replace(PanguSpacer.CJK_ANS, "$1 $2");
    // ANS_CJK: ANS + CJK -> ANS + " " + CJK
    newText = newText.replace(PanguSpacer.ANS_CJK, "$1 $2");

    // CJK_BRACKET: CJK + ( -> CJK + " " + (
    newText = newText.replace(PanguSpacer.CJK_BRACKET, "$1 $2");
    // BRACKET_CJK: ) + CJK -> ) + " " + CJK
    newText = newText.replace(PanguSpacer.BRACKET_CJK, "$1 $2");
    
    newText = newText.replace(PanguSpacer.FIX_BRACKET_ANY_BRACKET, "$1$3$5");
    
    newText = newText.replace(PanguSpacer.CJK_ANS_CJK, "$1 $2 $3");
    newText = newText.replace(PanguSpacer.ANS_CJK_ANS, "$1 $2 $3");

    // 还原 URL
    newText = newText.replace(/\uFFFF(\d+)\uFFFF/g, (_, index) => {
      return urls[parseInt(index)];
    });

    return newText;
  }
}
// ==========================================


// HTML 转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文档
const help_text = `⚙️ <b>pangu - 为消息添加「盘古之白」</b>

<b>📝 功能描述:</b>
• 自动在中英文、数字之间添加空格，使消息更美观易读
• 内置核心引擎，处理 CJK 与 字母/数字/符号 之间的间距
• 智能保护链接不被破坏

<b>🔧 使用方法:</b>
• <code>.pangu</code> - 查看当前状态/显示帮助
• <code>.pangu [文本]</code> - 测试格式化效果
• <code>.pangu on/off</code> - 在当前会话开启/关闭
• <code>.pangu global on/off</code> - 开启/关闭全局模式
• <code>.pangu whitelist add/remove</code> - 将当前会话加入/移出白名单
• <code>.pangu blacklist add/remove</code> - 将当前会话加入/移出黑名单
• <code>.pangu stats</code> - 查看统计信息

<b>📊 优先级说明:</b>
⚪ 白名单 > ⚫ 黑名单 > 💬 会话设置 > 🌐 全局模式`;

// 数据库配置接口
interface PanguConfig {
  version: string;
  chats: Record<string, boolean>;
  whitelist: string[];
  blacklist: string[];
  globalMode: boolean;
  stats: {
    formattedMessages: number;
    lastFormatted: number | null;
    enabledChats: number;
  };
}

// 插件主体
class PanguPlugin extends Plugin {
  name = "pangu";
  description: string = `📝 Pangu 消息格式化插件\n\n${help_text}`;
  private db: any;
  private prefixes: string[];

  constructor() {
    super();
    this.prefixes = getPrefixes();
    this.initDB();
  }

  // 初始化数据库
  private async initDB(): Promise<void> {
    const dir = createDirectoryInAssets("pangu");
    const dbPath = path.join(dir, "config.json");

    const defaultConfig: PanguConfig = {
      version: "1.0.0",
      chats: {},
      whitelist: [],
      blacklist: [],
      globalMode: false,
      stats: {
        formattedMessages: 0,
        lastFormatted: null,
        enabledChats: 0
      }
    };

    this.db = await JSONFilePreset<PanguConfig>(dbPath, defaultConfig);
    this.updateStats();
  }

  // 获取会话ID
  private getChatId(msg: Api.Message): string {
    return msg.peerId.toString();
  }

  // 获取会话模式
  private getChatMode(chatId: string): boolean | null {
    return this.db.data.chats.hasOwnProperty(chatId) ? 
      this.db.data.chats[chatId] : null;
  }

  // 设置会话模式
  private async setChatMode(chatId: string, enabled: boolean): Promise<void> {
    this.db.data.chats[chatId] = enabled;
    this.updateStats();
    await this.db.write();
  }

  // 检查是否为白名单
  private isWhite(chatId: string): boolean {
    return this.db.data.whitelist.includes(chatId);
  }

  // 检查是否为黑名单
  private isBlack(chatId: string): boolean {
    return this.db.data.blacklist.includes(chatId);
  }

  // 更新统计
  private updateStats(): void {
    const enabledChats = Object.values(this.db.data.chats)
      .filter(v => v === true).length;
    this.db.data.stats.enabledChats = enabledChats;
  }

  // 记录格式化消息
  private async recordFormattedMessage(): Promise<void> {
    this.db.data.stats.formattedMessages += 1;
    this.db.data.stats.lastFormatted = Date.now();
    await this.db.write();
  }

  // 检查文本是否发生变化 (忽略空白字符的变化，只看内容)
  private hasContentChanged(original: string, formatted: string): boolean {
    if (original === formatted) return false;
    
    // 移除所有空格后比较，确保只是增加了空格，没有修改内容
    const originalNoSpace = original.replace(/\s+/g, '');
    const formattedNoSpace = formatted.replace(/\s+/g, '');
    
    return originalNoSpace === formattedNoSpace;
  }

  // 白名单处理
  private async handleWhiteList(msg: Api.Message, args: string[]): Promise<void> {
    const chatId = this.getChatId(msg);
    const list = this.db.data.whitelist;
    const subCommand = args[2]?.toLowerCase();

    switch (subCommand) {
      case "add":
        if (!list.includes(chatId)) {
          list.push(chatId);
          await this.db.write();
          await msg.edit({
            text: `✅ 已将当前会话加入白名单`,
            parseMode: "html"
          });
        } else {
          await msg.edit({
            text: `ℹ️ 当前会话已在白名单中`,
            parseMode: "html"
          });
        }
        break;

      case "remove":
      case "rm":
        const removed = _.remove(list, (x: string) => x === chatId);
        if (removed.length > 0) {
          await this.db.write();
          await msg.edit({
            text: `✅ 已将当前会话移出白名单`,
            parseMode: "html"
          });
        } else {
          await msg.edit({
            text: `ℹ️ 当前会话不在白名单中`,
            parseMode: "html"
          });
        }
        break;

      case "list":
      case "ls":
        if (list.length === 0) {
          await msg.edit({
            text: `📝 白名单列表为空`,
            parseMode: "html"
          });
        } else {
          let text = `📝 <b>白名单列表</b> (${list.length} 个)\n\n`;
          list.forEach((id: string, index: number) => {
            text += `${index + 1}. <code>${htmlEscape(id)}</code>\n`;
          });
          await msg.edit({ text, parseMode: "html" });
        }
        break;

      default:
        await msg.edit({ text: help_text, parseMode: "html" });
        break;
    }
  }

  // 黑名单处理
  private async handleBlackList(msg: Api.Message, args: string[]): Promise<void> {
    const chatId = this.getChatId(msg);
    const list = this.db.data.blacklist;
    const subCommand = args[2]?.toLowerCase();

    switch (subCommand) {
      case "add":
        if (!list.includes(chatId)) {
          list.push(chatId);
          await this.db.write();
          await msg.edit({
            text: `✅ 已将当前会话加入黑名单`,
            parseMode: "html"
          });
        } else {
          await msg.edit({
            text: `ℹ️ 当前会话已在黑名单中`,
            parseMode: "html"
          });
        }
        break;

      case "remove":
      case "rm":
        const removed = _.remove(list, (x: string) => x === chatId);
        if (removed.length > 0) {
          await this.db.write();
          await msg.edit({
            text: `✅ 已将当前会话移出黑名单`,
            parseMode: "html"
          });
        } else {
          await msg.edit({
            text: `ℹ️ 当前会话不在黑名单中`,
            parseMode: "html"
          });
        }
        break;

      case "list":
      case "ls":
        if (list.length === 0) {
          await msg.edit({
            text: `📝 黑名单列表为空`,
            parseMode: "html"
          });
        } else {
          let text = `📝 <b>黑名单列表</b> (${list.length} 个)\n\n`;
          list.forEach((id: string, index: number) => {
            text += `${index + 1}. <code>${htmlEscape(id)}</code>\n`;
          });
          await msg.edit({ text, parseMode: "html" });
        }
        break;

      default:
        await msg.edit({ text: help_text, parseMode: "html" });
        break;
    }
  }

  // 全局模式处理
  private async handleGlobalMode(msg: Api.Message, args: string[]): Promise<void> {
    if (args.length === 2) {
      const globalMode = this.db.data.globalMode;
      await msg.edit({
        text: `🌐 <b>全局模式：</b> ${globalMode ? "✅ 开启" : "❌ 关闭"}`,
        parseMode: "html"
      });
      return;
    }

    const modeStr = args[2].toLowerCase();

    if (modeStr === "on" || modeStr === "enable" || modeStr === "true") {
      this.db.data.globalMode = true;
      await this.db.write();
      await msg.edit({
        text: `✅ 全局模式已开启`,
        parseMode: "html"
      });
    } else if (modeStr === "off" || modeStr === "disable" || modeStr === "false") {
      this.db.data.globalMode = false;
      await this.db.write();
      await msg.edit({
        text: `❌ 全局模式已关闭`,
        parseMode: "html"
      });
    } else {
      await msg.edit({
        text: `❌ 无效的参数\n\n使用：<code>.pangu global on</code> 或 <code>.pangu global off</code>`,
        parseMode: "html"
      });
    }
  }

  // 测试格式化
  private async handleTest(msg: Api.Message, text: string): Promise<void> {
    if (!text.trim()) {
      await msg.edit({
        text: `❌ 请提供测试文本\n\n使用：<code>.pangu 你好World123测试</code>`,
        parseMode: "html"
      });
      return;
    }
    
    // 调用内置核心
    const formatted = PanguSpacer.spacing(text);
    
    await msg.edit({
      text: `🔤 <b>Pangu 格式化测试</b>\n\n` +
            `<b>原始文本：</b>\n<code>${htmlEscape(text)}</code>\n\n` +
            `<b>格式化后：</b>\n<code>${htmlEscape(formatted)}</code>\n\n` +
            `<b>状态：</b> ${text === formatted ? "无需调整" : "已优化"}`,
      parseMode: "html"
    });
  }

  // 显示状态
  private async showStatus(msg: Api.Message): Promise<void> {
    const chatId = this.getChatId(msg);
    const chatMode = this.getChatMode(chatId);
    const globalMode = this.db.data.globalMode;
    const white = this.isWhite(chatId);
    const black = this.isBlack(chatId);
    const stats = this.db.data.stats;

    let effectiveStatus = "❓ 未知";
    if (white) {
      effectiveStatus = "✅ 开启 (白名单强制)";
    } else if (black) {
      effectiveStatus = "❌ 关闭 (黑名单强制)";
    } else if (chatMode !== null) {
      effectiveStatus = chatMode ? "✅ 开启" : "❌ 关闭";
    } else {
      effectiveStatus = globalMode ? "✅ 开启 (全局)" : "❌ 关闭 (全局)";
    }

    await msg.edit({
      text: `📊 <b>Pangu 格式化状态</b>\n\n` +
            `💬 <b>当前会话：</b> <code>${htmlEscape(chatId)}</code>\n` +
            `🎯 <b>生效状态：</b> ${effectiveStatus}\n\n` +
            `⚪ <b>白名单：</b> ${white ? "✅ 是" : "❌ 否"}\n` +
            `⚫ <b>黑名单：</b> ${black ? "✅ 是" : "❌ 否"}\n` +
            `💬 <b>会话设置：</b> ${chatMode === null ? "未设置" : (chatMode ? "✅ 开启" : "❌ 关闭")}\n` +
            `🌐 <b>全局模式：</b> ${globalMode ? "✅ 开启" : "❌ 关闭"}\n\n` +
            `📈 <b>统计信息：</b>\n` +
            `• 已格式化消息：${stats.formattedMessages}\n` +
            `• 启用会话数：${stats.enabledChats}\n` +
            `• 最后格式化：${stats.lastFormatted ? new Date(stats.lastFormatted).toLocaleString() : "从未"}`,
      parseMode: "html"
    });
  }

  // 显示统计信息
  private async showStats(msg: Api.Message): Promise<void> {
    const stats = this.db.data.stats;
    await msg.edit({
      text: `📈 <b>Pangu 统计信息</b>\n\n` +
            `• 已格式化消息：${stats.formattedMessages}\n` +
            `• 启用会话数：${stats.enabledChats}\n` +
            `• 最后格式化：${stats.lastFormatted ? new Date(stats.lastFormatted).toLocaleString() : "从未"}\n` +
            `• 白名单数量：${this.db.data.whitelist.length}\n` +
            `• 黑名单数量：${this.db.data.blacklist.length}\n` +
            `• 自定义设置会话数：${Object.keys(this.db.data.chats).length}`,
      parseMode: "html"
    });
  }

  // 命令处理器
  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    pangu: async (msg: Api.Message) => {
      try {
        const text = msg.text || "";
        const args = text.trim().split(/\s+/);
        const chatId = this.getChatId(msg);

        // 提取命令后的文本内容
        const commandPattern = new RegExp(`^[${this.prefixes.map(p => `\\${p}`).join('')}]pangu\\s*`, 'i');
        const remainingText = text.replace(commandPattern, "").trim();

        // 无参数时显示状态/帮助
        if (args.length === 1 || remainingText === "") {
          await this.showStatus(msg);
          return;
        }

        // 检查第一个参数是否为控制命令
        const firstArg = args[1].toLowerCase();
        const subCommands = ["on", "off", "global", "whitelist", "blacklist", "wl", "bl", "stats", "stat", "help", "h", "reset"];
        
        // 如果不是子命令，则视为测试文本
        if (!subCommands.includes(firstArg)) {
          await this.handleTest(msg, remainingText);
          return;
        }

        // 子命令处理
        const subCommand = firstArg;

        if (subCommand === "help" || subCommand === "h") {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        if (subCommand === "whitelist" || subCommand === "wl") {
          await this.handleWhiteList(msg, args);
          return;
        }

        if (subCommand === "blacklist" || subCommand === "bl") {
          await this.handleBlackList(msg, args);
          return;
        }

        if (subCommand === "global" || subCommand === "g") {
          await this.handleGlobalMode(msg, args);
          return;
        }

        if (subCommand === "stats" || subCommand === "stat") {
          await this.showStats(msg);
          return;
        }

        if (subCommand === "on" || subCommand === "enable" || subCommand === "true") {
          await this.setChatMode(chatId, true);
          await msg.edit({
            text: `✅ 已在当前会话开启 pangu 格式化`,
            parseMode: "html"
          });
          return;
        }

        if (subCommand === "off" || subCommand === "disable" || subCommand === "false") {
          await this.setChatMode(chatId, false);
          await msg.edit({
            text: `❌ 已在当前会话关闭 pangu 格式化`,
            parseMode: "html"
          });
          return;
        }

        if (subCommand === "reset") {
          if (this.db.data.chats.hasOwnProperty(chatId)) {
            delete this.db.data.chats[chatId];
            await this.db.write();
            this.updateStats();
            
            await msg.edit({
              text: `🔄 已重置当前会话设置`,
              parseMode: "html"
            });
          } else {
            await msg.edit({
              text: `ℹ️ 当前会话未进行特殊设置`,
              parseMode: "html"
            });
          }
          return;
        }

        await msg.edit({
          text: `❌ 未知命令: <code>${htmlEscape(subCommand)}</code>\n\n${help_text}`,
          parseMode: "html"
        });

      } catch (error: any) {
        console.error(`[pangu] 命令处理错误:`, error);
        await msg.edit({
          text: `❌ <b>处理失败:</b> ${htmlEscape(error.message || "未知错误")}`,
          parseMode: "html"
        });
      }
    }
  };

  // 消息监听器
  listenMessageHandler = async (msg: Api.Message, options?: { isEdited?: boolean }): Promise<void> => {
    try {
      const savedMessage = (msg as any).savedPeerId;
      // 仅处理自己发出的消息 或 Saved Messages
      if (!(msg.out || savedMessage)) return;
      
      // 忽略空消息
      if (!msg.text || msg.text.trim().length === 0) return;

      const chatId = this.getChatId(msg);
      const text = msg.text;

      // 1. 检查是否为命令消息 (忽略)
      const isCommand = this.prefixes.some((p: string) => text.startsWith(p)) || text.startsWith("/");
      if (isCommand) return;

      // 2. 权限/开关检查
      if (this.db.data.whitelist.length > 0) {
        // 如果有白名单，非白名单会话直接忽略
        if (!this.isWhite(chatId)) {
          return;
        }
      } else {
        // 黑名单检查
        if (this.isBlack(chatId)) {
          return;
        }

        // 会话级开关检查
        const chatMode = this.getChatMode(chatId);
        if (chatMode !== null) {
          if (!chatMode) return; // 明确关闭
        } else {
          // 默认检查全局开关
          if (!this.db.data.globalMode) return;
        }
      }

      // 3. 执行核心格式化逻辑
      const formatted = PanguSpacer.spacing(text);
      
      // 4. 检查是否需要更新 (避免无意义的编辑请求)
      if (formatted !== text) {
        try {
          await msg.edit({ text: formatted });
          await this.recordFormattedMessage();
        } catch (error: any) {
          // 可能是消息被删除、网络问题等，记录日志即可
          console.error(`[pangu] 消息编辑失败:`, error.message);
        }
      }
    } catch (error: any) {
      console.error(`[pangu] 监听器错误:`, error);
    }
  };

  listenMessageHandlerIgnoreEdited = false;
}

export default new PanguPlugin();
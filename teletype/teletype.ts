import { Plugin, type PanelSettingsAdapter, type PanelSettingField, type PanelFieldType } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
import { JSONFilePreset } from "lowdb/node";
import type { Low } from "lowdb";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";

import { safeGetMe } from "@utils/authGuards";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { htmlEscape } from "@utils/htmlEscape";

type TeletypeDbData = { autoMode: boolean; enabledUsers: string[] };

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


class TeletypePlugin extends Plugin {

  private readonly PLUGIN_NAME = "teletype";
  private readonly PLUGIN_VERSION = "1.1.0";
  private db!: Awaited<ReturnType<typeof JSONFilePreset<{ autoMode: boolean; enabledUsers: string[] }>>>;
  
  private readonly HELP_TEXT = `⌨️ <b>打字机效果插件</b>

<b>命令格式：</b>
<code>${mainPrefix}teletype [文本]</code> - 手动打字机效果
<code>${mainPrefix}teletype on/off</code> - 开启或关闭自动模式
<code>${mainPrefix}teletype status</code> - 查看状态

<b>使用示例：</b>
<code>${mainPrefix}teletype Hello World!</code>
<code>${mainPrefix}teletype on/off</code>
<code>${mainPrefix}teletype status</code>`;
  
  description = this.HELP_TEXT;
  cmdHandlers = {
    teletype: this.handleTeletype.bind(this)
  };
  
  listenMessageHandler = this.handleAutoTeletype.bind(this);
  listenMessageHandlerIgnoreEdited = true;
  
  constructor() {
    super();
    this.initDatabase();
  }
  
  private async initDatabase(): Promise<void> {
    try {
      const dbPath = path.join(createDirectoryInAssets(this.PLUGIN_NAME), "config.json");
      this.db = await JSONFilePreset(dbPath, {
        autoMode: false as boolean,
        enabledUsers: [] as string[]
      });
    } catch (error: unknown) {
      logger.error(`[${this.PLUGIN_NAME}] 数据库初始化失败:`, error);
      this.db = {
        data: { autoMode: false, enabledUsers: [] },
        write: async () => {}
      } as unknown as Awaited<ReturnType<typeof JSONFilePreset<TeletypeDbData>>>;
    }
  }
  
  private async handleTeletype(msg: MessageContext): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;
    
    try {
      const { subCommand, args, text } = this.parseArguments(msg);
      
      if (!subCommand && !text) {
        await this.showUsage(msg);
        return;
      }
      
      switch (subCommand?.toLowerCase()) {
        case 'on':
          await this.enableAutoMode(msg);
          break;
        case 'off':
          await this.disableAutoMode(msg);
          break;
        case 'status':
          await this.showStatus(msg);
          break;
        default:
          if (text) {
            await this.executeTeletype(msg, text);
          } else {
            await this.showUsage(msg);
          }
      }
      
    } catch (error: unknown) {
      await this.handleError(msg, error);
    }
  }
  
  private parseArguments(msg: MessageContext): { subCommand?: string, args: string[], text?: string } {
    const text = msg.text || "";
    const parts = text.trim().split(/\s+/);
    
    if (parts.length < 2) return { args: [] };
    
    const subCommand = parts[1];
    const remainingParts = parts.slice(2);
    
    if (['on', 'off', 'status'].includes(subCommand.toLowerCase())) {
      return { subCommand, args: remainingParts };
    }
    
    return { args: remainingParts, text: parts.slice(1).join(' ') };
  }
  
  private async showUsage(msg: MessageContext): Promise<void> {
    await msg.edit({
      text: html(`❌ <b>参数错误</b>\n\n${this.HELP_TEXT}`)
    });
  }
  
  private async enableAutoMode(msg: MessageContext): Promise<void> {
    if (!this.db) await this.initDatabase();
    
    const userId = msg.sender?.id.toString();
    if (!userId) {
      await msg.edit({ text: html("❌ <b>无法获取用户ID</b>") });
      return;
    }
    
    if (!this.db.data.enabledUsers) {
      this.db.data.enabledUsers = [];
    }
    
    if (!this.db.data.enabledUsers.includes(userId)) {
      this.db.data.enabledUsers.push(userId);
    }
    
    this.db.data.autoMode = true;
    await this.db.write();
    
    await msg.edit({
      text: html("✅ <b>自动打字机模式已开启</b>")
    });
  }
  
  private async disableAutoMode(msg: MessageContext): Promise<void> {
    if (!this.db) await this.initDatabase();
    
    const userId = msg.sender?.id.toString();
    if (userId && this.db.data.enabledUsers) {
      this.db.data.enabledUsers = this.db.data.enabledUsers.filter((id: string) => id !== userId);
    }
    
    this.db.data.autoMode = false;
    await this.db.write();
    
    await msg.edit({
      text: html("❌ <b>自动打字机模式已关闭</b>")
    });
  }
  
  private async showStatus(msg: MessageContext): Promise<void> {
    if (!this.db) await this.initDatabase();
    
    const userId = msg.sender?.id.toString();
    const isEnabled = userId && this.db.data.enabledUsers ? 
      this.db.data.enabledUsers.includes(userId) : false;
    const status = isEnabled ? "🟢 开启" : "🔴 关闭";
    
    await msg.edit({
      text: html(`📊 <b>状态</b>\n\n自动模式: ${status}`)
    });
  }
  
  private async handleAutoTeletype(msg: MessageContext): Promise<void> {
    if (!this.db) await this.initDatabase();
    if (!this.db?.data?.autoMode) return;
    
    const userId = msg.sender?.id.toString();
    if (!userId || !this.db.data.enabledUsers?.includes(userId)) return;
    
    const text = msg.text || "";
    const prefixes = await this.getPrefixes();
    const isCommand = prefixes.some(prefix => text.startsWith(prefix));
    
    if (isCommand || !text || text.trim().length < 2) return;
    
    const client = await getGlobalClient();
    if (!client) return;
    
    const self = await safeGetMe(client);
  if (!self) return;
    if (msg.sender?.id !== self.id) return;
    
    try {
      await this.executeTeletype(msg, text);
    } catch (error: unknown) {
      logger.error(`[${this.PLUGIN_NAME}] Auto teletype error:`, error);
    }
  }
  
  private async getPrefixes(): Promise<string[]> {
    return [".", "。", "!"];
  }
  
  private async executeTeletype(msg: MessageContext, text: string): Promise<void> {
    const interval = 50;
    const cursor = "█";
    let buffer = "";
    
    await msg.edit({
      text: html(cursor)
    });
    
    await this.sleep(interval);
    
    // 注意：必须按顺序逐字符编辑消息以实现打字机效果，不能并行
    for (const character of text) {
      buffer += character;
      const bufferWithCursor = `${htmlEscape(buffer)}${cursor}`;
      
      try {
        await msg.edit({
          text: html(bufferWithCursor)
        });
        
        await this.sleep(interval);
        
        if (buffer.length > 0) {
          await msg.edit({
            text: html(htmlEscape(buffer))
          });
        }
        
      } catch (error: unknown) {
        if (!getErrorMessage(error).includes("MESSAGE_NOT_MODIFIED")) {
          throw error;
        }
        continue;
      }
      
      await this.sleep(interval);
    }
    
    const finalText = htmlEscape(text);
    try {
      await msg.edit({
        text: html(finalText)
      });
    } catch (error: unknown) {
      if (!getErrorMessage(error).includes("MESSAGE_NOT_MODIFIED")) {
        throw error;
      }
    }
  }
  
  private async handleError(msg: MessageContext, error: unknown): Promise<void> {
    logger.error(`[${this.PLUGIN_NAME}] Error:`, error);
    
    const errMsg = getErrorMessage(error);
    if (errMsg?.includes("MESSAGE_NOT_MODIFIED")) {
      return;
    }
    
    let errorMessage = "❌ <b>操作失败:</b> ";
    
    if (errMsg?.includes("MESSAGE_TOO_LONG")) {
      errorMessage += "消息过长";
    } else {
      errorMessage += htmlEscape(getErrorMessage(error) || "未知错误");
    }
    
    await msg.edit({
      text: html(errorMessage)
    });
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}


  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "teletype",
    title: "电传打字",
    description: "电传打字机配置",
    category: "插件配置",
    icon: "⌨️",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "enabled",
            "label": "启用",
            "type": "boolean"
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("teletype"), "config.json"), {} as any);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("teletype"), "config.json"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };

export default new TeletypePlugin();

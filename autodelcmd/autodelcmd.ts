//@ts-nocheck
import { Api } from "telegram";
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { AliasDB } from "@utils/aliasDB";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import fs from "fs/promises";
import path from "path";

// HTML转义工具（每个插件必须实现）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

const CONFIG_FILE_PATH = path.join(
  createDirectoryInAssets("autodelcmd"),
  "config.json"
);

const EXIT_MSG_FILE_PATH = path.join(
  process.cwd(),
  "temp",
  "autodelcmd_exit_msgs.json"
);

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

interface ExitMessageData {
  cid: number;
  mid: number;
  timestamp: number; // 添加时间戳，用于清理过期记录
}

interface CommandRule {
  id?: string; // 规则唯一标识符
  command: string;
  delay: number; // 删除延迟秒数
  parameters?: string[]; // 特定参数（可选）
  deleteResponse?: boolean; // 是否同时删除响应消息
  exactMatch?: boolean; // 是否精确匹配（只匹配无参数的命令调用）
}

interface AutoDeleteConfig {
  customRules?: CommandRule[]; // 用户自定义规则
  enabled?: boolean; // 功能总开关，默认false
}

// 解析别名到原始命令
function resolveAlias(command: string): string {
  try {
    const aliasDB = new AliasDB();
    const originalCommand = aliasDB.get(command);
    aliasDB.close();
    return originalCommand || command; // 如果没有别名，返回原始命令
  } catch (error) {
    console.error("[autodelcmd] 解析别名时出错:", error);
    return command; // 出错时返回原始命令
  }
}

// 计算现有规则中的最大数字ID
function getMaxRuleId(rules: CommandRule[]): number {
  const existingIds = rules
    .map(r => parseInt(r.id || '0'))
    .filter(id => !isNaN(id));
  
  return existingIds.length > 0 ? Math.max(...existingIds) : 0;
}

// 生成规则唯一ID - 使用简单数字
function generateRuleId(existingRules: CommandRule[]): string {
  return (getMaxRuleId(existingRules) + 1).toString();
}

class AutoDeleteService {
  private client: any;
  private config: AutoDeleteConfig = {};

  constructor(client: any) {
    this.client = client;
  }

  // 获取默认配置规则
  private getDefaultRules(): CommandRule[] {
    return [
      // 10秒删除的命令
      { command: "lang", delay: 10 },
      { command: "alias", delay: 10 },
      { command: "reload", delay: 10 },
      { command: "eat", delay: 10, parameters: ["set"] }, // 只有set参数时删除
      { command: "tpm", delay: 10 },
      
      // tpm特殊参数 120秒删除（合并为一个规则）
      { command: "tpm", delay: 120, parameters: ["s", "search", "ls", "i", "install"] },
      
      // 120秒删除的命令
      { command: "h", delay: 120 },
      { command: "help", delay: 120 },
      { command: "dc", delay: 120 },
      { command: "ip", delay: 120 },
      { command: "ping", delay: 120 },
      { command: "pingdc", delay: 120 },
      { command: "sysinfo", delay: 120 },
      { command: "whois", delay: 120 },
      { command: "bf", delay: 120 },
      { command: "update", delay: 120 },
      { command: "trace", delay: 120 },
      { command: "service", delay: 120 },
      
      // 120秒删除且删除响应的命令
      { command: "s", delay: 120, deleteResponse: true },
      { command: "speedtest", delay: 120, deleteResponse: true },
      { command: "spt", delay: 120, deleteResponse: true },
      { command: "v", delay: 120, deleteResponse: true },
    ];
  }

  // 获取有效的规则集（合并默认规则和用户自定义规则）
  private getEffectiveRules(): CommandRule[] {
    const defaultRules = this.getDefaultRules();
    const customRules = Array.isArray(this.config.customRules) ? this.config.customRules : [];
    
    // 用户自定义规则优先级更高，可以覆盖默认规则
    const ruleMap = new Map<string, CommandRule>();
    
    // 首先添加默认规则
    defaultRules.forEach(rule => {
      const key = this.getRuleKey(rule);
      ruleMap.set(key, rule);
    });
    
    // 然后添加用户自定义规则（会覆盖同名的默认规则）
    customRules.forEach(rule => {
      const key = this.getRuleKey(rule);
      ruleMap.set(key, rule);
    });
    
    return Array.from(ruleMap.values());
  }

  // 生成规则的唯一key
  private getRuleKey(rule: CommandRule): string {
    return `${rule.command}:${rule.parameters?.join(',') || ''}:${rule.exactMatch ? 'exact' : 'normal'}`;
  }

  public async initialize() {
    await this.loadConfig();
    await this.autoDeleteOnStartup();
  }

  private async loadConfig() {
    try {
      await fs.access(CONFIG_FILE_PATH);
      const data = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
      this.config = JSON.parse(data);
      
      // 为没有 ID 的规则生成简单数字 ID
      if (this.config.customRules) {
        let needSave = false;
        let nextId = getMaxRuleId(this.config.customRules) + 1;
        
        // 为没有ID的规则分配连续的数字ID
        this.config.customRules.forEach(rule => {
          if (!rule.id) {
            rule.id = nextId.toString();
            nextId++;
            needSave = true;
          }
        });
        
        if (needSave) {
          await this.saveConfig();
        }
      }
    } catch (error) {
      console.log("[autodelcmd] 未找到配置，使用默认配置。");
    }
  }

  private async saveConfig() {
    try {
      await fs.mkdir(path.dirname(CONFIG_FILE_PATH), { recursive: true });
      await fs.writeFile(
        CONFIG_FILE_PATH,
        JSON.stringify(this.config, null, 2)
      );
    } catch (error) {
      console.error("[autodelcmd] 保存配置失败:", error);
    }
  }

  private async loadExitMessages(): Promise<ExitMessageData[]> {
    try {
      await fs.access(EXIT_MSG_FILE_PATH);
      const data = await fs.readFile(EXIT_MSG_FILE_PATH, "utf-8");
      return JSON.parse(data);
    } catch (error) {
      return [];
    }
  }

  private async saveExitMessages(exitMsgs: ExitMessageData[]) {
    try {
      await fs.mkdir(path.dirname(EXIT_MSG_FILE_PATH), { recursive: true });
      await fs.writeFile(
        EXIT_MSG_FILE_PATH,
        JSON.stringify(exitMsgs, null, 2)
      );
    } catch (error) {
      console.error("[autodelcmd] 保存退出消息失败:", error);
    }
  }

  private async clearExitMessages() {
    try {
      await fs.unlink(EXIT_MSG_FILE_PATH);
    } catch (error) {
      // 文件不存在时忽略错误
      if (error.code !== 'ENOENT') {
        console.error("[autodelcmd] 清除退出消息文件失败:", error);
      }
    }
  }

  private async autoDeleteOnStartup() {
    const exitMsgs = await this.loadExitMessages();
    
    if (exitMsgs.length === 0) {
      console.log(`[autodelcmd] 没有未完成的删除任务`);
      return;
    }
    
    console.log(`[autodelcmd] 检测到 ${exitMsgs.length} 个未完成的删除任务`);
    
    // 处理每个待删除的消息
    for (const exitMsg of exitMsgs) {
      try {
        const message = await this.client.getMessages(exitMsg.cid, { ids: [exitMsg.mid] });
        if (message && message[0]) {
          console.log(`[autodelcmd] 找到消息 ID ${exitMsg.mid}，将在10秒后删除`);
          
          // 使用较短的延迟时间完成未完成的删除任务
          setTimeout(async () => {
            try {
              console.log(`[autodelcmd] 正在执行未完成的删除任务，消息 ID ${exitMsg.mid}`);
              await message[0].delete({ revoke: true });
            } catch (error: any) {
              console.error(`[autodelcmd] 删除消息 ID ${exitMsg.mid} 失败:`, error.message);
            }
          }, 10 * 1000);
        } else {
          console.log(`[autodelcmd] 未找到消息 ID ${exitMsg.mid}，可能已被删除`);
        }
      } catch (error) {
        console.error(`[autodelcmd] 处理消息 ${exitMsg.mid} 时出错:`, error);
      }
    }
    
    // 清除已处理的退出消息记录
    await this.clearExitMessages();
  }

  private getChatId(msg: Api.Message): number | null {
    const chatId = msg.chatId || (msg.peerId && typeof msg.peerId === 'object' && 'userId' in msg.peerId ? msg.peerId.userId : null);
    return chatId ? Number(chatId) : null;
  }

  private async delayDelete(msg: Api.Message, seconds: number) {
    console.log(`[autodelcmd] 设置定时器: ${seconds} 秒后删除消息 ID ${msg.id}`);
    
    // 保存退出消息信息，以便程序重启后能继续删除
    try {
      const chatId = this.getChatId(msg);
      if (chatId) {
        await this.saveExitMessage(chatId, msg.id);
      }
    } catch (error) {
      console.error(`[autodelcmd] 保存删除任务失败:`, error);
    }
    
    setTimeout(async () => {
      try {
        console.log(`[autodelcmd] 正在删除消息 ID ${msg.id}`);
        await msg.delete({ revoke: true });
        
        // 删除成功后，从退出消息记录中移除此条记录
        await this.removeExitMessage(msg);
      } catch (error: any) {
        console.error(`[autodelcmd] 删除消息 ID ${msg.id} 失败:`, error.message);
        
        // 删除失败也要从记录中移除，避免重复尝试
        await this.removeExitMessage(msg);
      }
    }, seconds * 1000);
  }

  public async handleCommandPostprocess(
    msg: Api.Message,
    command: string,
    parameters?: string[]
  ) {

    // 注意：消息处理的权限检查已经在 shouldProcessMessage 中完成
    // 这里不再需要检查 msg.out，因为可能包含 Saved Messages 中的消息

    // 解析别名到原始命令
    const originalCommand = resolveAlias(command);

    // 获取有效的规则配置
    const rules = this.getEffectiveRules();
    
    // 查找匹配的规则
    let matchedRule: CommandRule | null = null;
    
    // 优先匹配有参数要求的规则
    for (const rule of rules) {
      if (rule.command === originalCommand && rule.parameters && rule.parameters.length > 0) {
        if (parameters && parameters.length > 0) {
          // 检查命令的第一个参数是否在规则的参数列表中
          if (rule.parameters.includes(parameters[0])) {
            matchedRule = rule;
            break;
          }
        }
      }
    }
    
    // 如果没有匹配带参数的规则，查找不带参数要求的规则
    if (!matchedRule) {
      let exactMatchRule: CommandRule | null = null;
      let normalMatchRule: CommandRule | null = null;
      
      for (const rule of rules) {
        if (rule.command === originalCommand && (!rule.parameters || rule.parameters.length === 0)) {
          if (rule.exactMatch) {
            // 精确匹配模式：只有当命令没有参数时才匹配
            if ((!parameters || parameters.length === 0) && !exactMatchRule) {
              exactMatchRule = rule;
            }
          } else {
            // 普通模式：匹配所有该命令的调用
            if (!normalMatchRule) {
              normalMatchRule = rule;
            }
          }
        }
      }
      
      // 优先级：精确匹配 > 普通匹配
      matchedRule = exactMatchRule || normalMatchRule;
    }
    
    if (matchedRule) {
      const paramStr = parameters && parameters.length > 0 ? ` ${parameters[0]}` : '';
      console.log(`[autodelcmd] 匹配规则: ${originalCommand}${paramStr} -> ${matchedRule.delay}秒延迟, 删除响应: ${!!matchedRule.deleteResponse}`);
      
      if (matchedRule.deleteResponse) {
        // 删除命令及相关响应
        try {
          const chatId = msg.chatId || msg.peerId;
          const messages = await this.client.getMessages(chatId, { limit: 100 });

          // 查找最近的响应消息并删除
          // 在 Saved Messages 中，需要特殊处理消息的归属
          const msgChatId = this.getChatId(msg);
          const isInSavedMessages = cachedUserId && msgChatId?.toString() === cachedUserId;
          
          for (const message of messages) {
            // 跳过命令消息本身
            if (message.id === msg.id) continue;
            
            let shouldDelete = false;
            
            if (isInSavedMessages) {
              // 在 Saved Messages 中，查找消息ID小于命令消息ID的最近消息作为响应
              // 因为响应通常在命令之后发送，ID会更大，但获取的消息列表是按时间倒序的
              if (message.id > msg.id) {
                shouldDelete = true;
              }
            } else {
              // 在普通聊天中，查找自己发出的消息
              if (message.out) {
                shouldDelete = true;
              }
            }
            
            if (shouldDelete) {
              console.log(`[autodelcmd] 找到响应消息 ID ${message.id}，将一同删除`);
              await this.delayDelete(message, matchedRule.delay);
              break;
            }
          }
          
          // 删除命令消息本身
          await this.delayDelete(msg, matchedRule.delay);
        } catch (error) {
          console.error("[autodelcmd] 处理消息时出错:", error);
        }
      } else {
        // 只删除命令消息
        await this.delayDelete(msg, matchedRule.delay);
      }
    }
  }

  public async saveExitMessage(chatId: number, messageId: number) {
    const exitMsgs = await this.loadExitMessages();
    
    // 检查是否已经存在相同的记录，避免重复保存
    const exists = exitMsgs.some(msg => msg.cid === chatId && msg.mid === messageId);
    if (exists) {
      return;
    }
    
    // 添加新的退出消息记录
    const exitMsg: ExitMessageData = {
      cid: chatId,
      mid: messageId,
      timestamp: Date.now()
    };
    
    exitMsgs.push(exitMsg);
    
    // 清理超过24小时的旧记录，避免积累过多
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const cleanedMsgs = exitMsgs.filter(msg => msg.timestamp > oneDayAgo);
    
    await this.saveExitMessages(cleanedMsgs);
  }

  // 从退出消息记录中移除指定消息
  private async removeExitMessage(msg: Api.Message) {
    try {
      const chatId = this.getChatId(msg);
      if (chatId) {
        const exitMsgs = await this.loadExitMessages();
        const filteredMsgs = exitMsgs.filter(
          exitMsg => !(exitMsg.cid === chatId && exitMsg.mid === msg.id)
        );
        await this.saveExitMessages(filteredMsgs);
      }
    } catch (error) {
      console.error(`[autodelcmd] 清理删除任务失败:`, error);
    }
  }

  // 配置管理方法
  public async addCustomRule(rule: CommandRule): Promise<{ success: boolean; error?: string; merged?: boolean }> {
    if (!this.config.customRules) {
      this.config.customRules = [];
    }
    
    // 只检查自定义规则之间的冲突，不检查与默认规则的冲突
    const existingCustomRules = this.getCustomRules();
    
    // 检查参数冲突（带参数的规则）
    if (rule.parameters && rule.parameters.length > 0) {
      for (const param of rule.parameters) {
        // 查找是否有其他自定义规则使用了相同的参数但条件不同
        const conflictingRule = existingCustomRules.find(r => 
          r.command === rule.command && 
          r.parameters && 
          r.parameters.includes(param) && 
          (r.delay !== rule.delay || !!r.deleteResponse !== !!rule.deleteResponse)
        );
        
        if (conflictingRule) {
          const conflictResponse = conflictingRule.deleteResponse ? " (含响应)" : "";
          const newResponse = rule.deleteResponse ? " (含响应)" : "";
          return {
            success: false,
            error: `参数冲突: 参数 "${param}" 已存在于自定义规则 "${rule.command} → ${conflictingRule.delay}秒删除${conflictResponse}" 中，与新规则 "${rule.command} → ${rule.delay}秒删除${newResponse}" 冲突\n
💡 提示: 使用 "<code>${mainPrefix}autodelcmd del ${conflictingRule.id}</code>" 删除冲突规则后重试`
          };
        }
      }
    }
    
    // 检查不带参数规则的冲突
    if (!rule.parameters || rule.parameters.length === 0) {
      // 查找是否存在相同命令、相同exactMatch模式的不带参数自定义规则但其他条件不同
      const conflictingRule = existingCustomRules.find(r => 
        r.command === rule.command && 
        (!r.parameters || r.parameters.length === 0) &&
        !!r.exactMatch === !!rule.exactMatch && // exactMatch模式必须相同才检查冲突
        (r.delay !== rule.delay || !!r.deleteResponse !== !!rule.deleteResponse)
      );
      
      if (conflictingRule) {
        const conflictResponse = conflictingRule.deleteResponse ? " (含响应)" : "";
        const conflictExact = conflictingRule.exactMatch ? " (精确匹配)" : " (普通匹配)";
        const newResponse = rule.deleteResponse ? " (含响应)" : "";
        const newExact = rule.exactMatch ? " (精确匹配)" : " (普通匹配)";
        
        return {
          success: false,
          error: `规则冲突: 命令 "${rule.command}" 已存在自定义规则 "→ ${conflictingRule.delay}秒删除${conflictResponse}${conflictExact}"，与新规则 "→ ${rule.delay}秒删除${newResponse}${newExact}" 冲突\n
💡 提示: 使用 "<code>${mainPrefix}autodelcmd del ${conflictingRule.id}</code>" 删除冲突规则后重试`
        };
      }
    }
    
    // 查找是否存在相同命令、延迟、deleteResponse和exactMatch设置的规则
    const existingRuleIndex = this.config.customRules.findIndex(r => 
      r.command === rule.command && 
      r.delay === rule.delay && 
      !!r.deleteResponse === !!rule.deleteResponse &&
      !!r.exactMatch === !!rule.exactMatch
    );
    
    if (existingRuleIndex !== -1 && rule.parameters && rule.parameters.length > 0) {
      // 存在相同条件的规则，合并参数
      const existingRule = this.config.customRules[existingRuleIndex];
      
      if (!existingRule.parameters) {
        existingRule.parameters = [];
      }
      
      // 合并参数，去重
      const mergedParams = [...new Set([...existingRule.parameters, ...rule.parameters])];
      existingRule.parameters = mergedParams;
      
      console.log(`[autodelcmd] 合并规则参数: ${rule.command} -> [${mergedParams.join(', ')}]`);
      await this.saveConfig();
      return { success: true, merged: true };
    } else {
      // 删除已存在的完全相同的规则（包括参数）
      const key = this.getRuleKey(rule);
      this.config.customRules = this.config.customRules.filter(r => this.getRuleKey(r) !== key);
      
      // 为新规则生成简单数字ID并添加
      if (!rule.id) {
        rule.id = generateRuleId(this.config.customRules);
      }
      this.config.customRules.push(rule);
      await this.saveConfig();
      return { success: true, merged: false };
    }
  }

  public async removeCustomRuleById(ruleId: string): Promise<{ success: boolean; removedRule?: CommandRule }> {
    if (!this.config.customRules) return { success: false };
    
    const ruleIndex = this.config.customRules.findIndex(r => r.id === ruleId);
    
    if (ruleIndex === -1) {
      return { success: false };
    }
    
    const removedRule = this.config.customRules[ruleIndex];
    this.config.customRules.splice(ruleIndex, 1);
    
    await this.saveConfig();
    return { success: true, removedRule };
  }

  public getCustomRules(): CommandRule[] {
    return this.config.customRules || [];
  }

  public getCustomRulesByCommand(command?: string): CommandRule[] {
    const rules = this.getCustomRules();
    return command ? rules.filter(r => r.command === command) : rules;
  }

  public getAllRules(): CommandRule[] {
    return this.getEffectiveRules();
  }

  public resetToDefaults(): Promise<void> {
    this.config.customRules = [];
    return this.saveConfig();
  }

  // 开关管理方法
  public isEnabled(): boolean {
    return this.config.enabled === true; // 默认false，只有明确设置为true才启用
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    this.config.enabled = enabled;
    await this.saveConfig();
  }
}

// 全局服务实例和缓存的用户信息
let serviceInstance: AutoDeleteService | null = null;
let cachedUserId: string | null = null;

// 统一的服务初始化方法
async function ensureServiceInitialized(): Promise<boolean> {
  if (serviceInstance) return true;
  
  try {
    const client = await getGlobalClient();
    if (!client) return false;
    
    serviceInstance = new AutoDeleteService(client);
    await serviceInstance.initialize();
    return true;
  } catch (error) {
    console.error("[autodelcmd] 初始化服务时出错:", error);
    return false;
  }
}

class AutoDeletePlugin extends Plugin {
  // 插件启动时自动初始化
  constructor() {
    super();
    this.initializeOnStartup();
  }

  private async initializeOnStartup() {
    try {
      console.log("[autodelcmd] 插件启动，开始初始化...");
      const initialized = await ensureServiceInitialized();
      if (initialized) {
        console.log("[autodelcmd] 插件启动初始化成功");
      } else {
        console.log("[autodelcmd] 插件启动初始化失败，将在首次使用时重试");
      }
    } catch (error) {
      console.error("[autodelcmd] 插件启动初始化出错:", error);
    }
  }

  description: string = `🗑️ 自动删除命令消息插件

<b>功能说明:</b>
- 自动监听并延迟删除特定命令的消息
- 支持所有配置的自定义前缀和别名命令
- 支持用户自定义删除规则和延迟时间

<b>消息处理范围:</b>
- 自己发出的所有命令消息
- Saved Messages（收藏夹）中的命令消息

<b>默认删除规则:</b>
• 短延迟 (10秒): lang, alias, reload, eat set, tpm
• 长延迟 (120秒): h, help, dc, ip, ping, pingdc, sysinfo, whois, bf, update, trace, service
• 特殊规则: tpm [s,search,ls,i,install] (120秒), s/speedtest/spt/v (120秒+🔄删除响应)

<b>配置管理命令:</b>
• <code>${mainPrefix}autodelcmd on/off</code> - 启用/禁用自动删除功能
• <code>${mainPrefix}autodelcmd status</code> - 查看功能状态和规则统计
• <code>${mainPrefix}autodelcmd list</code> - 查看所有规则
• <code>${mainPrefix}autodelcmd add [命令] [延迟秒数] [参数1] [参数2] [...] [-r] [-e]</code> - 添加自定义规则
• <code>${mainPrefix}autodelcmd del [规则ID或命令名]</code> - 删除自定义规则或查看规则
• <code>${mainPrefix}autodelcmd reset</code> - 重置为默认配置

<b>特殊选项:</b>
• 🔄 使用 <code>-r</code> 或 <code>--response</code> 参数启用删除响应消息
• 删除响应指同时删除命令触发的最近一条回复消息
• 🎯 使用 <code>-e</code> 或 <code>--exact</code> 参数启用精确匹配模式
• 精确匹配只匹配无参数的命令调用，不匹配带参数的调用

<b>使用示例:</b>
• <code>${mainPrefix}autodelcmd on</code> - 启用自动删除功能
• <code>${mainPrefix}autodelcmd status</code> - 查看功能状态
• <code>${mainPrefix}autodelcmd add ping 30</code> - ping命令30秒后删除
• <code>${mainPrefix}autodelcmd add speedtest 60 -r</code> - speedtest命令60秒后删除（🔄包含响应）
• <code>${mainPrefix}autodelcmd add tpm 60 list ls search</code> - tpm list/ls/search任一命令60秒后删除
• <code>${mainPrefix}autodelcmd add ping 30 -e</code> - 只有无参数的ping命令30秒后删除
• <code>${mainPrefix}autodelcmd del ping</code> - 查看ping命令的所有自定义规则
• <code>${mainPrefix}autodelcmd del 1</code> - 使用ID删除指定规则
• <code>${mainPrefix}autodelcmd off</code> - 禁用自动删除功能

<b>注意:</b> 插件默认处于禁用状态，需要手动启用才能工作。`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    autodelcmd: async (msg) => {
      const parts = msg.message?.trim().split(/\s+/) || [];
      const [, action, ...args] = parts;

      // 确保服务实例已初始化（通常在启动时已完成）
      if (!serviceInstance) {
        const initialized = await ensureServiceInitialized();
        if (!initialized) {
          await msg.edit({ text: "❌ 服务初始化失败", parseMode: "html" });
          return;
        }
      }

      switch (action?.toLowerCase()) {
        case 'status':
        case 'st':
          await this.handleStatus(msg);
          break;
        case 'on':
        case 'enable':
          await this.handleEnable(msg);
          break;
        case 'off':
        case 'disable':
          await this.handleDisable(msg);
          break;
        case 'list':
        case 'ls':
          await this.handleListRules(msg);
          break;
        case 'add':
          await this.handleAddRule(msg, args);
          break;
        case 'del':
        case 'remove':
          await this.handleRemoveRule(msg, args);
          break;
        case 'reset':
          await this.handleReset(msg);
          break;
        default:
          await msg.edit({ text: this.description, parseMode: "html" });
      }
    }
  };

  private async handleListRules(msg: Api.Message) {
    const allRules = serviceInstance!.getAllRules();
    const customRules = serviceInstance!.getCustomRules();
    
    let text = "📋 <b>自动删除规则列表</b>\n\n";
    
    if (customRules.length > 0) {
      text += "🔧 <b>自定义规则:</b>\n";
      customRules.forEach((rule, index) => {
        const params = rule.parameters?.length ? ` [${rule.parameters.join(', ')}]` : '';
        const response = rule.deleteResponse ? ' 🔄' : '';
        const exact = rule.exactMatch ? ' 🎯' : '';
        const ruleId = rule.id || 'unknown';
        text += `${index + 1}. <code>${rule.command}${params}</code> → ${rule.delay}秒${response}${exact} <code>[ID: ${ruleId}]</code>\n`;
      });
      text += "\n";
    }
    
    text += "⚙️ <b>所有有效规则:</b>\n";
    const groupedRules = new Map();
    
    allRules.forEach(rule => {
      const key = `${rule.delay}${rule.deleteResponse ? '_response' : ''}`;
      if (!groupedRules.has(key)) {
        groupedRules.set(key, []);
      }
      groupedRules.get(key).push(rule);
    });
    
    Array.from(groupedRules.entries())
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .forEach(([key, rules]) => {
        const delay = parseInt(key);
        const withResponse = key.includes('_response');
        text += `\n<b>${delay}秒删除${withResponse ? ' 🔄' : ''}:</b>\n`;
        rules.forEach((rule: CommandRule) => {
          const params = rule.parameters?.length ? ` [${rule.parameters.join(', ')}]` : '';
          const response = rule.deleteResponse && !withResponse ? ' 🔄' : '';
          const exact = rule.exactMatch ? ' 🎯' : '';
          text += `• ${rule.command}${params}${response}${exact}\n`;
        });
      });

    // 添加图标说明
    text += `\n<b>📖 图标说明:</b>\n`;
    text += `• 🔄 = 同时删除响应消息\n`;
    text += `• 🎯 = 精确匹配（只匹配无参数调用）`;

    await msg.edit({ text, parseMode: "html" });
  }

  private async handleAddRule(msg: Api.Message, args: string[]) {
    if (args.length < 2) {
      await msg.edit({ 
        text: `❌ 参数不足\n用法: <code>${mainPrefix}autodelcmd add [命令] [延迟秒数] [参数...] [-r] [-e]</code>\n\n` +
              `示例:\n` +
              `• <code>${mainPrefix}autodelcmd add ping 30</code> - ping命令30秒删除(包含带参数的)\n` +
              `• <code>${mainPrefix}autodelcmd add ping 30 -e</code> - 🎯只有无参数的ping命令30秒删除\n` +
              `• <code>${mainPrefix}autodelcmd add speedtest 60 -r</code> - speedtest命令60秒删除(🔄含响应)\n` +
              `• <code>${mainPrefix}autodelcmd add tpm 60 list ls search -r</code> - tpm list/ls/search任一命令60秒删除(🔄含响应)`, 
        parseMode: "html" 
      });
      return;
    }

    // 检查标志参数
    const responseFlags = ['-r', '--response'];
    const exactFlags = ['-e', '--exact'];
    let deleteResponse = false;
    let exactMatch = false;
    let filteredArgs = [...args];
    
    // 从参数中移除响应标志
    for (const flag of responseFlags) {
      const index = filteredArgs.indexOf(flag);
      if (index !== -1) {
        deleteResponse = true;
        filteredArgs.splice(index, 1);
      }
    }
    
    // 从参数中移除精确匹配标志
    for (const flag of exactFlags) {
      const index = filteredArgs.indexOf(flag);
      if (index !== -1) {
        exactMatch = true;
        filteredArgs.splice(index, 1);
      }
    }

    if (filteredArgs.length < 2) {
      await msg.edit({ text: "❌ 移除标志后参数不足", parseMode: "html" });
      return;
    }

    const command = filteredArgs[0];
    const delay = parseInt(filteredArgs[1]);
    const parameters = filteredArgs.slice(2);

    if (isNaN(delay) || delay < 1) {
      await msg.edit({ text: "❌ 延迟时间必须是正整数（秒）", parseMode: "html" });
      return;
    }

    // 检查精确匹配标志与参数的冲突
    if (exactMatch && parameters.length > 0) {
      await msg.edit({ 
        text: "❌ 精确匹配模式（-e/--exact）不能与参数同时使用\n精确匹配专用于只匹配无参数的命令调用", 
        parseMode: "html" 
      });
      return;
    }

    const rule: CommandRule = {
      command,
      delay,
      parameters: parameters.length > 0 ? parameters : undefined,
      deleteResponse: deleteResponse || undefined, // 只有为true时才设置
      exactMatch: exactMatch || undefined // 只有为true时才设置
    };

    const result = await serviceInstance!.addCustomRule(rule);
    
    if (!result.success) {
      // 参数冲突，显示错误信息
      await msg.edit({ 
        text: `❌ <b>添加规则失败</b>\n\n${result.error}`, 
        parseMode: "html" 
      });
      return;
    }
    
    const responseText = deleteResponse ? " (含响应)" : "";
    const exactText = exactMatch ? " (精确匹配)" : "";
    
    if (parameters.length > 0) {
      if (result.merged) {
        // 获取合并后的规则
        const updatedRule = serviceInstance!.getCustomRules().find(r => 
          r.command === command && 
          r.delay === delay && 
          !!r.deleteResponse === !!deleteResponse &&
          !!r.exactMatch === !!exactMatch
        );
        const mergedParams = updatedRule?.parameters || parameters;
        
        await msg.edit({ 
          text: `✅ 已合并自定义规则参数: <code>${command} [${mergedParams.join(', ')}]</code> → ${delay}秒删除${responseText}\n\n` +
                `触发条件: ${command} 命令的第一个参数为 ${mergedParams.map(p => `<code>${p}</code>`).join(' 或 ')} 时` +
                (deleteResponse ? "\n🔄 同时删除响应消息" : ""), 
          parseMode: "html" 
        });
      } else {
        const params = `[${parameters.join(', ')}]`;
        await msg.edit({ 
          text: `✅ 已添加自定义规则: <code>${command} ${params}</code> → ${delay}秒删除${responseText}\n\n` +
                `触发条件: ${command} 命令的第一个参数为 ${parameters.map(p => `<code>${p}</code>`).join(' 或 ')} 时` +
                (deleteResponse ? "\n🔄 同时删除响应消息" : ""), 
          parseMode: "html" 
        });
      }
    } else {
      const matchType = exactMatch ? "只有无参数的" : "任何";
      await msg.edit({ 
        text: `✅ 已添加自定义规则: <code>${command}</code> → ${delay}秒删除${responseText}${exactText}\n\n` +
              `触发条件: ${matchType} ${command} 命令` +
              (deleteResponse ? "\n🔄 同时删除响应消息" : "") +
              (exactMatch ? "\n🎯 精确匹配：不匹配带参数的调用" : ""), 
        parseMode: "html" 
      });
    }
  }

  private async handleRemoveRule(msg: Api.Message, args: string[]) {
    if (args.length < 1) {
      await msg.edit({ 
        text: `❌ 参数不足\n用法: <code>${mainPrefix}autodelcmd del [规则ID或命令名]</code>\n\n` +
              `<b>删除方式:</b>\n` +
              `• 使用规则ID删除: <code>${mainPrefix}autodelcmd del [规则ID]</code>\n` +
              `• 使用命令名查看规则: <code>${mainPrefix}autodelcmd del [命令名]</code>\n\n` +
              `<b>示例:</b>\n` +
              `• <code>${mainPrefix}autodelcmd del 1</code> - 使用ID删除规则\n` +
              `• <code>${mainPrefix}autodelcmd del ping</code> - 查看ping命令的所有规则\n` +
              `• 使用 <code>${mainPrefix}autodelcmd list</code> 查看所有规则和ID`, 
        parseMode: "html" 
      });
      return;
    }

    const input = args[0];
    
    // 首先尝试按 ID 删除
    const result = await serviceInstance!.removeCustomRuleById(input);
    
    if (result.success && result.removedRule) {
      const rule = result.removedRule;
      const params = rule.parameters?.length ? ` [${rule.parameters.join(', ')}]` : '';
      const exact = rule.exactMatch ? ' 🎯' : '';
      const response = rule.deleteResponse ? ' 🔄' : '';
      
      await msg.edit({ 
        text: `✅ 已删除自定义规则:\n<code>${rule.command}${params}</code> → ${rule.delay}秒${response}${exact}\n\n<code>[ID: ${rule.id}]</code>`, 
        parseMode: "html" 
      });
      return;
    }
    
    // 如果 ID 删除失败，尝试按命令名查找规则
    const matchingRules = serviceInstance!.getCustomRulesByCommand(input);
    
    if (matchingRules.length === 0) {
      await msg.edit({ 
        text: `❌ 未找到匹配的规则\n\n• 规则ID "${input}" 不存在\n• 命令 "${input}" 没有自定义规则\n\n使用 <code>${mainPrefix}autodelcmd list</code> 查看所有规则`, 
        parseMode: "html" 
      });
      return;
    }
    
    // 显示匹配的规则供用户选择
    let text = `📋 <b>命令 "${input}" 的自定义规则:</b>\n\n`;
    matchingRules.forEach((rule, index) => {
      const params = rule.parameters?.length ? ` [${rule.parameters.join(', ')}]` : '';
      const exact = rule.exactMatch ? ' 🎯' : '';
      const response = rule.deleteResponse ? ' 🔄' : '';
      const ruleId = rule.id || 'unknown';
      text += `${index + 1}. <code>${rule.command}${params}</code> → ${rule.delay}秒${response}${exact}\n`;
      text += `   <code>删除: ${mainPrefix}autodelcmd del ${ruleId}</code>\n\n`;
    });
    
    await msg.edit({ text, parseMode: "html" });
  }

  private async handleReset(msg: Api.Message) {
    await serviceInstance!.resetToDefaults();
    await msg.edit({ text: "✅ 已重置为默认配置", parseMode: "html" });
  }

  private async handleStatus(msg: Api.Message) {
    const isEnabled = serviceInstance!.isEnabled();
    const allRules = serviceInstance!.getAllRules();
    const customRules = serviceInstance!.getCustomRules();
    
    const statusIcon = isEnabled ? "🟢" : "🔴";
    const statusText = isEnabled ? "已启用" : "已禁用";
    
    let text = `📊 <b>自动删除功能状态</b>\n\n`;
    text += `${statusIcon} 功能状态: <b>${statusText}</b>\n\n`;
    text += `📋 规则统计:\n`;
    text += `• 总规则数: ${allRules.length}\n`;
    text += `• 自定义规则: ${customRules.length}\n`;
    text += `• 默认规则: ${allRules.length - customRules.length}\n\n`;
    
    if (!isEnabled) {
      text += `💡 使用 <code>autodelcmd on</code> 启用功能`;
    } else {
      text += `💡 使用 <code>autodelcmd off</code> 禁用功能`;
    }

    await msg.edit({ text, parseMode: "html" });
  }

  private async handleEnable(msg: Api.Message) {
    await serviceInstance!.setEnabled(true);
    await msg.edit({ 
      text: "🟢 <b>自动删除功能已启用</b>\n\n符合规则的命令消息将自动延迟删除", 
      parseMode: "html" 
    });
  }

  private async handleDisable(msg: Api.Message) {
    await serviceInstance!.setEnabled(false);
    await msg.edit({ 
      text: "🔴 <b>自动删除功能已禁用</b>\n\n命令消息将不再自动删除", 
      parseMode: "html" 
    });
  }

  // 判断是否应该处理此消息
  private async shouldProcessMessage(msg: Api.Message): Promise<boolean> {
    // 1. 处理自己发出的消息
    if (msg.out) return true;
    
    // 2. 检查是否是 Saved Messages
    try {
      // 使用缓存的用户ID，避免重复获取
      if (!cachedUserId) {
        const client = await getGlobalClient();
        if (!client) return false;
        const me = await client.getMe();
        cachedUserId = me.id.toString();
      }
      
      // 检查消息的聊天对象
      const peerId = msg.peerId;
      const chatId = msg.chatId;
      
      // Saved Messages 的特征：chatId 等于当前用户的 ID
      if (chatId && chatId.toString() === cachedUserId) {
        return true;
      }
      
      // 也可以通过 peerId 检查
      if (peerId && typeof peerId === 'object' && 'userId' in peerId) {
        if (peerId.userId.toString() === cachedUserId) {
          return true;
        }
      }
      
    } catch (error) {
      console.error("[autodelcmd] 检查消息来源时出错:", error);
    }
    
    // 3. 其他情况不处理
    return false;
  }

  // 监听所有消息，实现命令后处理
  listenMessageHandler = async (msg: Api.Message) => {
    try {
      // 检查功能是否启用
      if (!serviceInstance || !serviceInstance.isEnabled()) {
        return;
      }
      
      // 检查是否应该处理此消息
      const shouldProcess = await this.shouldProcessMessage(msg);
      if (!shouldProcess) return;
      
      // 检查消息是否以命令前缀开头
      const messageText = msg.message?.trim() || "";
      if (!messageText) return;

      // 检查消息是否以任何一个配置的前缀开头
      let matchedPrefix: string | null = null;
      for (const prefix of prefixes) {
        if (messageText.startsWith(prefix)) {
          matchedPrefix = prefix;
          break;
        }
      }
      
      // 如果没有匹配的前缀，跳过处理
      if (!matchedPrefix) return;

      // 确保服务实例已初始化（通常在启动时已完成，这里是保险措施）
      if (!serviceInstance) {
        const initialized = await ensureServiceInitialized();
        if (!initialized) return;
      }

      // 手动解析命令和参数
      const parts = messageText.trim().split(/\s+/);
      // 移除前缀获取命令名 (例如 ".tpm" -> "tpm")
      const commandWithPrefix = parts[0];
      const command = commandWithPrefix.substring(matchedPrefix.length); // 移除匹配的前缀
      const parameters = parts.slice(1); // 其余都是参数
      
      if (!command) return; // 如果只有前缀没有命令，跳过
      
      console.log(`[autodelcmd] 检测到命令: ${command}, 参数: ${JSON.stringify(parameters)}, 前缀: ${matchedPrefix}, 原始消息: ${messageText}`);

      // 处理命令后删除
      await serviceInstance.handleCommandPostprocess(msg, command, parameters);
    } catch (error) {
      console.error("[autodelcmd] listenMessageHandler 错误:", error);
    }
  };
}

export default new AutoDeletePlugin();


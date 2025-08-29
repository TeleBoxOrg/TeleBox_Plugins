/**
 * Shift plugin for TeleBox - Smart Message Forwarding
 * Converted from PagerMaid-Modify shift.py
 */

import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { TelegramClient } from "telegram";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as fs from "fs";
import * as path from "path";
const BigInteger = require("big-integer");

// 基本类型定义
type MessageType = "silent" | "text" | "all" | "photo" | "document" | "video" | "sticker" | "animation" | "voice" | "audio";

interface ForwardRule {
  target_id: number;
  options: MessageType[];
  target_type: string;
  paused: boolean;
  created_at: string;
  filters: string[];
  migrated?: boolean;
  source_name?: string;  // 存储源的原始用户名
  target_name?: string;  // 存储目标的原始用户名
}

interface ForwardStats {
  total_forwarded: number;
  last_forward_time: string;
  error_count: number;
  daily_stats: { [date: string]: number }; // 每日转发统计
}

interface RuleStats {
  [ruleKey: string]: ForwardStats; // 每个规则的独立统计
}

// 配置常量
const AVAILABLE_OPTIONS: Set<MessageType> = new Set([
  "silent", "text", "all", "photo", "document", "video", 
  "sticker", "animation", "voice", "audio"
]);

// 实体显示名称缓存
const entityCache = new Map<number, { name: string; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

// 实体信息缓存 - 存储从 getDialogs 获取的实体
const entityInfoCache = new Map<number, any>();
let lastDialogsFetch = 0;
const DIALOGS_CACHE_DURATION = 10 * 60 * 1000; // 10分钟缓存对话列表

const HELP_TEXT = `📢 **智能转发助手使用说明**

🔧 **基础命令：**
• \`shift set [源] [目标] [选项...]\` - 设置自动转发
• \`shift del [序号]\` - 删除转发规则
• \`shift list\` - 显示当前转发规则
• \`shift stats\` - 查看转发统计
• \`shift pause [序号]\` - 暂停转发
• \`shift resume [序号]\` - 恢复转发

🔍 **过滤命令：**
• \`shift filter [序号] add [关键词]\` - 添加过滤关键词
• \`shift filter [序号] del [关键词]\` - 删除过滤关键词
• \`shift filter [序号] list\` - 查看过滤列表

🎯 **支持的目标类型：**
• 频道/群组 - @username 或 -100...ID
• 个人用户 - @username 或 user_id
• 当前对话 - 使用 "me" 或 "here"

📝 **消息类型选项：**
• silent, text, photo, document, video, sticker, animation, voice, audio, all

💡 **示例：**
• \`shift set @channel1 @channel2 silent photo\`
• \`shift del 1\`
• \`shift filter 1 add 广告\``;

// 数据存储路径
const SHIFT_DATA_PATH = path.join(createDirectoryInAssets("shift"), "shift_rules.json");

class ShiftManager {
  private rules: Map<number, ForwardRule> = new Map();
  private stats: Map<string, ForwardStats> = new Map(); // 改为按规则键存储

  constructor() {
    this.ensureDataDirectory();
    this.loadRules();
  }

  // 确保数据目录存在
  private ensureDataDirectory(): void {
    // createDirectoryInAssets already ensures directory exists
    // No additional action needed
  }

  // 加载规则数据
  private loadRules(): void {
    try {
      if (fs.existsSync(SHIFT_DATA_PATH)) {
        const data = fs.readFileSync(SHIFT_DATA_PATH, 'utf-8');
        const parsed = JSON.parse(data);
        
        // 加载规则
        if (parsed.rules) {
          for (const [sourceId, rule] of Object.entries(parsed.rules)) {
            this.rules.set(parseInt(sourceId), rule as ForwardRule);
          }
        }
        
        // 加载统计
        if (parsed.stats) {
          for (const [ruleKey, stat] of Object.entries(parsed.stats)) {
            this.stats.set(ruleKey, stat as ForwardStats);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load shift rules:', error);
    }
  }

  // 保存规则数据
  private saveRules(): void {
    try {
      const data = {
        rules: Object.fromEntries(this.rules),
        stats: Object.fromEntries(this.stats),
        updated_at: new Date().toISOString()
      };
      fs.writeFileSync(SHIFT_DATA_PATH, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save shift rules:', error);
    }
  }

  // 获取转发规则
  getRule(sourceId: number): ForwardRule | null {
    return this.rules.get(sourceId) || null;
  }

  // 设置转发规则
  setRule(sourceId: number, rule: ForwardRule): void {
    this.rules.set(sourceId, rule);
    
    // 初始化统计数据
    const ruleKey = `${sourceId}_${rule.target_id}`;
    if (!this.stats.has(ruleKey)) {
      this.stats.set(ruleKey, {
        total_forwarded: 0,
        last_forward_time: new Date().toISOString(),
        error_count: 0,
        daily_stats: {}
      });
    }
    
    this.saveRules();
  }

  // 删除转发规则
  deleteRule(sourceId: number): boolean {
    const rule = this.rules.get(sourceId);
    const deleted = this.rules.delete(sourceId);
    if (deleted && rule) {
      const ruleKey = `${sourceId}_${rule.target_id}`;
      this.stats.delete(ruleKey);
      this.saveRules();
    }
    return deleted;
  }

  // 获取所有规则
  getAllRules(): Array<{ sourceId: number; rule: ForwardRule }> {
    return Array.from(this.rules.entries()).map(([sourceId, rule]) => ({
      sourceId,
      rule
    }));
  }

  // 检查循环转发
  checkCircularForward(sourceId: number, targetId: number): { isCircular: boolean; reason: string } {
    if (sourceId === targetId) {
      return { isCircular: true, reason: "不能设置自己到自己的转发规则" };
    }

    const visited = new Set<number>([sourceId]);
    let currentId = targetId;
    
    // 最多检查20层深度，防止无限循环
    for (let i = 0; i < 20; i++) {
      if (visited.has(currentId)) {
        return { isCircular: true, reason: `检测到间接循环：${currentId}` };
      }
      
      const rule = this.getRule(currentId);
      if (!rule) {
        break;
      }
      
      const nextId = rule.target_id;
      if (nextId === -1) {
        break;
      }
      
      visited.add(currentId);
      currentId = nextId;
    }
    
    return { isCircular: false, reason: "" };
  }

  // 暂停/恢复转发
  toggleRule(sourceId: number, paused: boolean): boolean {
    const rule = this.getRule(sourceId);
    if (!rule) {
      return false;
    }
    
    rule.paused = paused;
    this.setRule(sourceId, rule);
    return true;
  }

  // 获取统计信息
  getStats(sourceId: number, targetId: number): ForwardStats | null {
    const ruleKey = `${sourceId}_${targetId}`;
    return this.stats.get(ruleKey) || null;
  }
  
  // 获取所有统计信息
  getAllStats(): Array<{ ruleKey: string; stats: ForwardStats }> {
    return Array.from(this.stats.entries()).map(([ruleKey, stats]) => ({
      ruleKey,
      stats
    }));
  }

  // 添加过滤关键词
  addFilter(sourceId: number, keyword: string): boolean {
    const rule = this.rules.get(sourceId);
    if (!rule) return false;
    
    if (!rule.filters.includes(keyword)) {
      rule.filters.push(keyword);
      this.setRule(sourceId, rule);
    }
    return true;
  }

  // 删除过滤关键词
  removeFilter(sourceId: number, keyword: string): boolean {
    const rule = this.rules.get(sourceId);
    if (!rule) return false;
    
    const index = rule.filters.indexOf(keyword);
    if (index > -1) {
      rule.filters.splice(index, 1);
      this.setRule(sourceId, rule);
      return true;
    }
    return false;
  }

  // 获取过滤关键词列表
  getFilters(sourceId: number): string[] {
    const rule = this.rules.get(sourceId);
    return rule ? rule.filters : [];
  }

  // 更新转发统计
  updateStats(sourceId: number, targetId: number, success: boolean = true): void {
    const ruleKey = `${sourceId}_${targetId}`;
    let stats = this.stats.get(ruleKey);
    
    if (!stats) {
      stats = {
        total_forwarded: 0,
        last_forward_time: new Date().toISOString(),
        error_count: 0,
        daily_stats: {}
      };
      this.stats.set(ruleKey, stats);
    }
    
    if (success) {
      stats.total_forwarded++;
      stats.last_forward_time = new Date().toISOString();
      
      // 更新每日统计
      const today = new Date().toISOString().split('T')[0];
      stats.daily_stats[today] = (stats.daily_stats[today] || 0) + 1;
      
      console.log(`Stats updated for ${ruleKey}: total=${stats.total_forwarded}, today=${stats.daily_stats[today]}`);
    } else {
      stats.error_count++;
      console.log(`Error stats updated for ${ruleKey}: errors=${stats.error_count}`);
    }
  }
}

// 预缓存对话实体信息
async function cacheDialogEntities(): Promise<void> {
  const now = Date.now();
  if (now - lastDialogsFetch < DIALOGS_CACHE_DURATION) {
    return; // 缓存仍然有效
  }

  try {
    const client = await getGlobalClient();
    const dialogs = await client.getDialogs({ limit: 200 }); // 增加获取数量
    
    for (const dialog of dialogs) {
      const entity = dialog.entity;
      if (entity && 'id' in entity) {
        let entityId = Number(entity.id);
        let originalId = entityId;
        
        // 根据实体类型正确转换ID格式
        if (entity.className === 'Channel') {
          // 频道或超级群组
          entityId = -1000000000000 - originalId;
        } else if (entity.className === 'Chat') {
          // 普通群组
          entityId = -originalId;
        } else if (entity.className === 'User') {
          // 用户保持正数
          entityId = originalId;
        }
        
        // 同时缓存原始ID和转换后的ID
        entityInfoCache.set(entityId, entity);
        entityInfoCache.set(originalId, entity);
        
        const username = ('username' in entity) ? entity.username : 'none';
        const displayInfo = ('title' in entity) ? entity.title : (('firstName' in entity) ? entity.firstName : 'none');
        console.log(`Cached entity: ${entity.className} ${originalId} -> ${entityId}, username: ${username || 'none'}, title: ${displayInfo || 'none'}`);
      }
    }
    
    lastDialogsFetch = now;
    console.log(`Cached ${entityInfoCache.size} dialog entities`);
  } catch (error) {
    console.warn('Failed to cache dialog entities:', error);
  }
}

// 全局管理器实例
const shiftManager = new ShiftManager();

const shiftPlugin: Plugin = {
  command: ["shift"],
  description: "📢 智能转发助手 - 自动转发消息到指定频道/群组",
  cmdHandler: async (msg: Api.Message) => {
    const args = msg.message.slice(1).split(' ').slice(1);
    const command = args[0] || '';

    try {
      switch (command) {
        case 'set':
          await handleSetCommand(msg, args);
          break;
        case 'del':
        case 'delete':
          await handleDeleteCommand(msg, args);
          break;
        case 'list':
          await handleListCommand(msg);
          break;
        case 'stats':
          await handleStatsCommand(msg);
          break;
        case 'pause':
          await handlePauseCommand(msg, args);
          break;
        case 'resume':
          await handleResumeCommand(msg, args);
          break;
        case 'filter':
          await handleFilterCommand(msg, args);
          break;
        case 'help':
        case '':
          await msg.edit({ text: HELP_TEXT });
          break;
        default:
          await msg.edit({ text: "❌ **未知命令**\n\n使用 `shift help` 查看帮助" });
      }
    } catch (error) {
      console.error('Shift plugin error:', error);
      await msg.edit({ text: `❌ **插件错误**\n\n${error}` });
    }
  },
  
  // 消息监听处理器 - 实现自动转发功能
  listenMessageHandler: async (msg: Api.Message) => {
    try {
      await handleMessageForwarding(msg);
    } catch (error) {
      console.error('Message forwarding error:', error);
    }
  },
};

// 命令处理函数
async function handleSetCommand(msg: Api.Message, args: string[]): Promise<void> {
  if (args.length < 3) {
    await msg.edit({ 
      text: "❌ **参数不足**\n\n用法：`shift set [源] [目标] [选项...]`\n\n示例：`shift set @channel1 @channel2 silent photo`" 
    });
    return;
  }

  const sourceArg = args[1];
  const targetArg = args[2];
  const options = args.slice(3);

  try {
    // 解析源和目标
    const sourceId = await parseEntityId(sourceArg, msg);
    const targetId = await parseEntityId(targetArg, msg);

    if (!sourceId || !targetId) {
      await msg.edit({ text: "❌ **无法解析源或目标**\n\n请检查用户名或ID是否正确" });
      return;
    }

    // 验证选项
    const validOptions: MessageType[] = [];
    for (const option of options) {
      if (AVAILABLE_OPTIONS.has(option as MessageType)) {
        validOptions.push(option as MessageType);
      } else {
        await msg.edit({ 
          text: `❌ **无效选项**: ${option}\n\n可用选项：${Array.from(AVAILABLE_OPTIONS).join(', ')}` 
        });
        return;
      }
    }

    if (validOptions.length === 0) {
      validOptions.push('all'); // 默认转发所有类型
    }

    // 检查循环转发
    const circularCheck = shiftManager.checkCircularForward(sourceId, targetId);
    if (circularCheck.isCircular) {
      await msg.edit({ text: `❌ **循环转发检测**\n\n${circularCheck.reason}` });
      return;
    }

    // 创建转发规则
    const rule: ForwardRule = {
      target_id: targetId,
      options: validOptions,
      target_type: 'chat',
      paused: false,
      created_at: new Date().toISOString(),
      filters: [],
      source_name: sourceArg,
      target_name: targetArg
    };

    shiftManager.setRule(sourceId, rule);

    // 构建显示名称，包含原始参数和ID
    const sourceDisplay = `${sourceArg} (ID: ${sourceId})`;
    const targetDisplay = `${targetArg} (ID: ${targetId})`;

    await msg.edit({ 
      text: `✅ **转发规则已设置**\n\n` +
            `📤 **源**：${sourceDisplay}\n` +
            `📥 **目标**：${targetDisplay}\n` +
            `🎯 **类型**：${validOptions.join(', ')}\n` +
            `📅 **创建时间**：${new Date().toLocaleString('zh-CN')}`
    });

  } catch (error) {
    console.error('Set command error:', error);
    await msg.edit({ text: `❌ **设置失败**\n\n${error}` });
  }
}

async function handleDeleteCommand(msg: Api.Message, args: string[]): Promise<void> {
  if (args.length < 2) {
    await msg.edit({ 
      text: "❌ **参数不足**\n\n用法：`shift del [序号]`\n\n使用 `shift list` 查看规则序号" 
    });
    return;
  }

  const indexArg = args[1];
  const index = parseInt(indexArg) - 1; // 用户输入从1开始，数组从0开始

  try {
    const allRules = shiftManager.getAllRules();
    
    if (index < 0 || index >= allRules.length) {
      await msg.edit({ 
        text: `❌ **序号无效**\n\n请输入 1-${allRules.length} 之间的序号` 
      });
      return;
    }

    const { sourceId, rule } = allRules[index];
    const sourceDisplay = await getDisplayName(sourceId);
    const targetDisplay = await getDisplayName(rule.target_id);

    const deleted = shiftManager.deleteRule(sourceId);
    
    if (deleted) {
      await msg.edit({ 
        text: `✅ **转发规则已删除**\n\n` +
              `📤 **源**：${sourceDisplay}\n` +
              `📥 **目标**：${targetDisplay}`
      });
    } else {
      await msg.edit({ text: "❌ **删除失败**\n\n规则可能已被删除" });
    }

  } catch (error) {
    console.error('Delete command error:', error);
    await msg.edit({ text: `❌ **删除失败**\n\n${error}` });
  }
}

async function handleListCommand(msg: Api.Message): Promise<void> {
  try {
    const allRules = shiftManager.getAllRules();
    
    if (allRules.length === 0) {
      await msg.edit({ 
        text: "📋 **转发规则列表**\n\n暂无转发规则\n\n使用 `shift set` 添加规则" 
      });
      return;
    }

    let listText = "📋 **转发规则列表**\n\n";
    
    for (let i = 0; i < allRules.length; i++) {
      const { sourceId, rule } = allRules[i];
      const sourceDisplay = await getDisplayName(sourceId);
      const targetDisplay = await getDisplayName(rule.target_id);
      const status = rule.paused ? "⏸️ 已暂停" : "▶️ 运行中";
      const stats = shiftManager.getStats(sourceId, rule.target_id);
      const forwardCount = stats ? stats.total_forwarded : 0;
      const filterCount = rule.filters ? rule.filters.length : 0;
      
      listText += `${i + 1}. ${status}\n`;
      listText += `📤 源：${sourceDisplay}\n`;
      listText += `📥 目标：${targetDisplay}\n`;
      listText += `🎯 类型：${rule.options.join(', ')}\n`;
      listText += `📊 已转发：${forwardCount} 条\n`;
      if (filterCount > 0) {
        listText += `🔍 过滤规则：${filterCount} 条\n`;
      }
      listText += `📅 创建：${new Date(rule.created_at).toLocaleString('zh-CN')}\n\n`;
    }

    await msg.edit({ text: listText });

  } catch (error) {
    console.error('List command error:', error);
    await msg.edit({ text: `❌ **获取列表失败**\n\n${error}` });
  }
}

async function handleStatsCommand(msg: Api.Message): Promise<void> {
  try {
    const allRules = shiftManager.getAllRules();
    
    if (allRules.length === 0) {
      await msg.edit({ 
        text: "📊 **转发统计**\n\n暂无转发规则" 
      });
      return;
    }

    let totalForwarded = 0;
    let totalErrors = 0;
    let activeRules = 0;
    let pausedRules = 0;

    for (const { sourceId, rule } of allRules) {
      const stats = shiftManager.getStats(sourceId, rule.target_id);
      if (stats) {
        totalForwarded += stats.total_forwarded;
        totalErrors += stats.error_count;
      }
      
      if (rule.paused) {
        pausedRules++;
      } else {
        activeRules++;
      }
    }

    // 总体统计概览
    let statsText = `📊 **转发统计报告**\n\n`;
    statsText += `📈 **总体概览**\n`;
    statsText += `• 总规则数: ${allRules.length} 条\n`;
    statsText += `• 运行中: ${activeRules} 条\n`;
    statsText += `• 已暂停: ${pausedRules} 条\n`;
    statsText += `• 总转发: ${totalForwarded} 条\n`;
    statsText += `• 总错误: ${totalErrors} 条\n\n`;
    
    // 按规则显示详细统计
    statsText += `📋 **详细统计**\n\n`;
    
    for (let i = 0; i < allRules.length; i++) {
      const { sourceId, rule } = allRules[i];
      const sourceDisplay = await getDisplayName(sourceId);
      const targetDisplay = await getDisplayName(rule.target_id);
      const stats = shiftManager.getStats(sourceId, rule.target_id);
      const status = rule.paused ? "⏸️ 已暂停" : "▶️ 运行中";
      
      statsText += `**${i + 1}.** ${status}\n`;
      statsText += `📤 源: ${sourceDisplay}\n`;
      statsText += `📥 目标: ${targetDisplay}\n`;
      
      if (stats && stats.total_forwarded > 0) {
        statsText += `📈 总转发: ${stats.total_forwarded} 条\n`;
        if (stats.error_count > 0) {
          statsText += `❌ 错误: ${stats.error_count} 条\n`;
        }
        
        // 显示最近7天的统计
        if (stats.daily_stats && Object.keys(stats.daily_stats).length > 0) {
          const sortedDates = Object.keys(stats.daily_stats)
            .sort((a, b) => b.localeCompare(a))
            .slice(0, 7);
          
          if (sortedDates.length > 0) {
            statsText += `📅 最近7天:\n`;
            for (const date of sortedDates) {
              const count = stats.daily_stats[date];
              statsText += `  • ${date}: ${count} 条\n`;
            }
          }
        }
      } else {
        statsText += `📈 总转发: 0 条\n`;
      }
      
      if (i < allRules.length - 1) {
        statsText += `\n`;
      }
    }
    
    if (allRules.length === 0) {
      statsText = `📊 转发统计报告\n\n暂无转发规则`;
    }

    await msg.edit({ text: statsText });

  } catch (error) {
    console.error('Stats command error:', error);
    await msg.edit({ text: `❌ **获取统计失败**\n\n${error}` });
  }
}

async function handlePauseCommand(msg: Api.Message, args: string[]): Promise<void> {
  if (args.length < 2) {
    await msg.edit({ 
      text: "❌ **参数不足**\n\n用法：`shift pause [序号]`\n\n使用 `shift list` 查看规则序号" 
    });
    return;
  }

  await toggleRuleStatus(msg, args, true);
}

async function handleResumeCommand(msg: Api.Message, args: string[]): Promise<void> {
  if (args.length < 2) {
    await msg.edit({ 
      text: "❌ **参数不足**\n\n用法：`shift resume [序号]`\n\n使用 `shift list` 查看规则序号" 
    });
    return;
  }

  await toggleRuleStatus(msg, args, false);
}

async function handleFilterCommand(msg: Api.Message, args: string[]): Promise<void> {
  if (args.length < 3) {
    await msg.edit({ 
      text: "❌ **参数不足**\n\n用法：\n• `shift filter [序号] add [关键词]`\n• `shift filter [序号] del [关键词]`\n• `shift filter [序号] list`" 
    });
    return;
  }

  const index = parseInt(args[1]) - 1;
  const action = args[2];
  
  try {
    const allRules = shiftManager.getAllRules();
    
    if (index < 0 || index >= allRules.length) {
      await msg.edit({ text: "❌ **序号无效**\n\n使用 `shift list` 查看有效序号" });
      return;
    }

    const { sourceId } = allRules[index];
    
    switch (action) {
      case 'add':
        if (args.length < 4) {
          await msg.edit({ text: "❌ **缺少关键词**\n\n用法：`shift filter [序号] add [关键词]`" });
          return;
        }
        const addKeyword = args.slice(3).join(' ');
        const addSuccess = shiftManager.addFilter(sourceId, addKeyword);
        
        if (addSuccess) {
          await msg.edit({ text: `✅ **过滤关键词已添加**\n\n关键词：${addKeyword}` });
        } else {
          await msg.edit({ text: "❌ **添加失败**\n\n规则可能不存在" });
        }
        break;
        
      case 'del':
      case 'delete':
        if (args.length < 4) {
          await msg.edit({ text: "❌ **缺少关键词**\n\n用法：`shift filter [序号] del [关键词]`" });
          return;
        }
        const delKeyword = args.slice(3).join(' ');
        const delSuccess = shiftManager.removeFilter(sourceId, delKeyword);
        
        if (delSuccess) {
          await msg.edit({ text: `✅ **过滤关键词已删除**\n\n关键词：${delKeyword}` });
        } else {
          await msg.edit({ text: "❌ **删除失败**\n\n关键词可能不存在" });
        }
        break;
        
      case 'list':
        const filters = shiftManager.getFilters(sourceId);
        const sourceDisplay = await getDisplayName(sourceId);
        
        let filterText = `🔍 **过滤关键词列表**\n\n📤 **源**：${sourceDisplay}\n\n`;
        
        if (filters.length === 0) {
          filterText += "暂无过滤关键词";
        } else {
          filterText += "**关键词：**\n";
          filters.forEach((filter, i) => {
            filterText += `${i + 1}. ${filter}\n`;
          });
        }
        
        await msg.edit({ text: filterText });
        break;
        
      default:
        await msg.edit({ text: "❌ **未知操作**\n\n支持的操作：add, del, list" });
    }
    
  } catch (error) {
    console.error('Filter command error:', error);
    await msg.edit({ text: `❌ **过滤操作失败**\n\n${error}` });
  }
}

async function toggleRuleStatus(msg: Api.Message, args: string[], paused: boolean): Promise<void> {
  const indexArg = args[1];
  const index = parseInt(indexArg) - 1;

  try {
    const allRules = shiftManager.getAllRules();
    
    if (index < 0 || index >= allRules.length) {
      await msg.edit({ 
        text: `❌ **序号无效**\n\n请输入 1-${allRules.length} 之间的序号` 
      });
      return;
    }

    const { sourceId, rule } = allRules[index];
    const sourceDisplay = await getDisplayName(sourceId);
    
    const success = shiftManager.toggleRule(sourceId, paused);
    
    if (success) {
      const action = paused ? "暂停" : "恢复";
      const status = paused ? "⏸️ 已暂停" : "▶️ 运行中";
      
      await msg.edit({ 
        text: `✅ **转发规则已${action}**\n\n` +
              `📤 **源**：${sourceDisplay}\n` +
              `📊 **状态**：${status}`
      });
    } else {
      await msg.edit({ text: "❌ **操作失败**\n\n规则可能不存在" });
    }

  } catch (error) {
    console.error('Toggle rule error:', error);
    await msg.edit({ text: `❌ **操作失败**\n\n${error}` });
  }
}

// 辅助函数
async function parseEntityId(entityArg: string, msg: Api.Message): Promise<number | null> {
  try {
    // 处理特殊关键词
    if (entityArg === 'me' || entityArg === 'here') {
      if (!msg.peerId) return null;
      // 从 peerId 中提取数字ID
      if ('userId' in msg.peerId) {
        return Number(msg.peerId.userId);
      } else if ('chatId' in msg.peerId) {
        return -Number(msg.peerId.chatId);
      } else if ('channelId' in msg.peerId) {
        return -1000000000000 - Number(msg.peerId.channelId);
      }
      return null;
    }

    // 处理数字ID - 直接返回，不做格式转换
    if (/^-?\d+$/.test(entityArg)) {
      const numId = parseInt(entityArg);
      console.log(`Parsing entity ID: ${entityArg} -> ${numId}`);
      return numId;
    }

    // 处理用户名
    if (entityArg.startsWith('@')) {
      try {
        const client = await getGlobalClient();
        const username = entityArg.slice(1); // 移除 @ 符号
        
        // 通过 Telegram API 解析用户名
        const entity = await client.getEntity(username);
        
        if ('id' in entity) {
          // 根据实体类型返回正确的ID格式
          // entity.id 可能是 BigInt 类型，需要安全转换
          const entityId = typeof entity.id === 'bigint' ? Number(entity.id) : Number(entity.id);
          
          console.log(`Resolved username ${username}: type=${entity.className}, id=${entityId}`);
          
          if (entity.className === 'Channel') {
            // 频道或超级群组
            return -1000000000000 - entityId;
          } else if (entity.className === 'Chat') {
            // 普通群组
            return -entityId;
          } else if (entity.className === 'User') {
            // 用户
            return entityId;
          }
          return entityId;
        }
        return null;
      } catch (error) {
        console.error('Username resolution failed:', entityArg, error);
        return null;
      }
    }

    return null;
  } catch (error) {
    console.error('Parse entity error:', error);
    return null;
  }
}

async function getDisplayName(entityId: number): Promise<string> {
  // 检查缓存
  const cached = entityCache.get(entityId);
  if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
    return cached.name;
  }

  // 先尝试预缓存对话实体
  await cacheDialogEntities();

  // 检查是否在对话缓存中（尝试多种ID格式）
  let cachedEntity = entityInfoCache.get(entityId);
  
  // 如果直接查找失败，尝试其他ID格式
  if (!cachedEntity) {
    if (entityId < -1000000000000) {
      // 频道格式，尝试原始ID
      const originalId = Math.abs(entityId + 1000000000000);
      cachedEntity = entityInfoCache.get(originalId);
    } else if (entityId < 0) {
      // 群组格式，尝试原始ID
      const originalId = Math.abs(entityId);
      cachedEntity = entityInfoCache.get(originalId);
    }
  }
  
  if (cachedEntity) {
    let displayName = '';
    
    // 优先显示用户名，其次标题，最后名字
    if ('username' in cachedEntity && cachedEntity.username) {
      displayName = `@${cachedEntity.username}`;
    } else if ('title' in cachedEntity && cachedEntity.title) {
      displayName = String(cachedEntity.title);
    } else if ('firstName' in cachedEntity && cachedEntity.firstName) {
      displayName = String(cachedEntity.firstName);
    } else {
      displayName = `ID: ${entityId}`;
    }
    
    console.log(`Display name resolved from cache: ${entityId} -> ${displayName}`);
    
    // 缓存结果
    entityCache.set(entityId, { name: displayName, timestamp: Date.now() });
    return displayName;
  }

  try {
    const client = await getGlobalClient();
    let actualId = entityId;
    
    // 转换ID格式用于API调用
    if (entityId < -1000000000000) {
      actualId = Math.abs(entityId + 1000000000000);
    } else if (entityId < 0) {
      actualId = Math.abs(entityId);
    }

    console.log(`Attempting to get entity: ${entityId} -> ${actualId}`);
    
    // 尝试获取实体
    const entity = await client.getEntity(actualId);
    
    if (entity) {
      let displayName = '';
      
      // 优先显示用户名，其次标题，最后名字
      if ('username' in entity && entity.username) {
        displayName = `@${entity.username}`;
      } else if ('title' in entity && entity.title) {
        displayName = String(entity.title);
      } else if ('firstName' in entity && entity.firstName) {
        displayName = String(entity.firstName);
      } else {
        displayName = `ID: ${entityId}`;
      }
      
      console.log(`Display name resolved from API: ${entityId} -> ${displayName}`);
      
      // 缓存结果和实体
      entityCache.set(entityId, { name: displayName, timestamp: Date.now() });
      entityInfoCache.set(entityId, entity);
      return displayName;
    }
  } catch (error: any) {
    console.warn(`Failed to get entity ${entityId}:`, error.message || error);
  }

  // 降级方案：显示ID
  const fallbackName = `ID: ${entityId}`;
  console.log(`Using fallback name: ${entityId} -> ${fallbackName}`);
  entityCache.set(entityId, { name: fallbackName, timestamp: Date.now() });
  return fallbackName;
}

// 消息转发处理函数
async function handleMessageForwarding(msg: Api.Message): Promise<void> {
  try {
    // 获取消息来源ID
    const sourceId = getSourceId(msg);
    if (!sourceId) return;
    
    // 跳过自己发送的消息，避免循环
    if (msg.out) return;

    // 获取转发规则
    const rule = shiftManager.getRule(sourceId);
    if (!rule || rule.paused) return;

    // 检查消息类型是否匹配
    if (!shouldForwardMessage(msg, rule.options)) return;

    // 检查过滤关键词
    if (!passesFilter(msg, rule.filters)) return;

    // 执行转发
    await forwardMessage(msg, rule);
    
    // 更新统计
    console.log(`Forwarding successful, updating stats for ${sourceId} -> ${rule.target_id}`);
    shiftManager.updateStats(sourceId, rule.target_id, true);

  } catch (error) {
    console.error('Message forwarding failed:', error);
    if (msg.peerId) {
      const sourceId = getSourceId(msg);
      const rule = sourceId ? shiftManager.getRule(sourceId) : null;
      if (sourceId && rule) {
        shiftManager.updateStats(sourceId, rule.target_id, false);
      }
    }
  }
}

// 获取消息来源ID
function getSourceId(msg: Api.Message): number | null {
  try {
    if (!msg.peerId) return null;
    
    if ('userId' in msg.peerId) {
      return Number(msg.peerId.userId);
    } else if ('chatId' in msg.peerId) {
      return -Number(msg.peerId.chatId);
    } else if ('channelId' in msg.peerId) {
      return -1000000000000 - Number(msg.peerId.channelId);
    }
    return null;
  } catch (error) {
    console.error('Get source ID error:', error);
    return null;
  }
}

// 检查消息是否应该转发
function shouldForwardMessage(msg: Api.Message, options: MessageType[]): boolean {
  // 如果包含 'all'，转发所有消息
  if (options.includes('all')) {
    return true;
  }

  // 检查媒体类型
  if (msg.media) {
    if ('photo' in msg.media && options.includes('photo')) return true;
    if ('video' in msg.media && options.includes('video')) return true;
    if ('document' in msg.media && msg.media.document) {
      const doc = msg.media.document;
      if ('mimeType' in doc && doc.mimeType) {
        if (doc.mimeType.startsWith('image/') && options.includes('photo')) return true;
        if (doc.mimeType.startsWith('video/') && options.includes('video')) return true;
        if (doc.mimeType.startsWith('audio/') && options.includes('audio')) return true;
        if (doc.mimeType === 'application/x-tgsticker' && options.includes('sticker')) return true;
        if (doc.mimeType === 'video/mp4' && options.includes('animation')) return true;
        if (options.includes('document')) return true;
      }
    }
    if ('voice' in msg.media && options.includes('voice')) return true;
    if ('audio' in msg.media && options.includes('audio')) return true;
    if ('sticker' in msg.media && options.includes('sticker')) return true;
  }

  // 检查文本消息
  if (msg.message && options.includes('text')) {
    return true;
  }

  return false;
}

// 检查消息是否通过过滤关键词
function passesFilter(msg: Api.Message, filters: string[]): boolean {
  // 如果没有过滤关键词，直接通过
  if (!filters || filters.length === 0) {
    return true;
  }

  // 获取消息文本内容
  let messageText = '';
  if (msg.message) {
    messageText = msg.message.toLowerCase();
  }
  
  // 也检查媒体标题
  if (msg.media && 'caption' in msg.media && msg.media.caption) {
    messageText += ' ' + String(msg.media.caption).toLowerCase();
  }

  // 检查是否包含任何过滤关键词
  for (const filter of filters) {
    if (messageText.includes(filter.toLowerCase())) {
      console.log(`Message blocked by filter: ${filter}`);
      return false; // 包含过滤关键词，不转发
    }
  }

  return true; // 不包含任何过滤关键词，可以转发
}

// 执行消息转发
async function forwardMessage(msg: Api.Message, rule: ForwardRule): Promise<void> {
  try {
    const client = await getGlobalClient();
    const targetId = rule.target_id;
    
    console.log(`Attempting to forward message ${msg.id} to target ${targetId}`);
    
    // 方案1: 尝试使用高级API转发
    try {
      const result = await client.forwardMessages(targetId, {
        messages: [msg.id],
        fromPeer: msg.peerId,
        silent: rule.options.includes('silent')
      });
      
      if (result && result.length > 0) {
        console.log(`Message ${msg.id} forwarded successfully using high-level API`);
        return;
      }
    } catch (hlError: any) {
      console.warn('High-level forwardMessages failed, trying alternative methods:', hlError.message);
    }
    
    // 方案2: 使用sendMessage复制消息内容（推荐方案）
    try {
      if (msg.message || msg.media) {
        const sendOptions: any = {
          silent: rule.options.includes('silent')
        };
        
        // 复制文本消息
        if (msg.message) {
          sendOptions.message = msg.message;
        }
        
        // 复制媒体消息
        if (msg.media) {
          sendOptions.file = msg.media;
          // 复制媒体标题
          if ('caption' in msg.media && msg.media.caption) {
            sendOptions.caption = String(msg.media.caption);
          }
        }
        
        // 复制回复信息
        if (msg.replyTo) {
          sendOptions.replyTo = msg.replyTo;
        }
        
        await client.sendMessage(targetId, sendOptions);
        console.log(`Message ${msg.id} copied successfully using sendMessage`);
        return;
      }
    } catch (copyError: any) {
      console.warn('Copy message failed:', copyError.message);
    }
    
    // 方案3: 降级到低级API（最后尝试）
    const targetPeer = await getTargetPeer(targetId);
    console.log(`Using low-level API with peer:`, targetPeer.className);
    
    const forwardOptions = {
      fromPeer: msg.peerId,
      toPeer: targetPeer,
      id: [msg.id],
      silent: rule.options.includes('silent'),
      dropAuthor: false,
      dropMediaCaptions: false,
      noforwards: false,
    };

    await client.invoke(
      new Api.messages.ForwardMessages(forwardOptions)
    );

    console.log(`Message ${msg.id} forwarded successfully using low-level API`);

  } catch (error) {
    console.error('All forward methods failed:', error);
    throw error;
  }
}

// 获取目标 Peer 对象
async function getTargetPeer(targetId: number): Promise<any> {
  try {
    const client = await getGlobalClient();
    
    if (targetId > 0) {
      // 用户ID - 直接尝试获取
      try {
        const user = await client.getEntity(targetId);
        return await client.getInputEntity(user);
      } catch (userError) {
        console.warn(`Could not get user entity ${targetId}, trying fallback`);
        return new Api.InputPeerUser({
          userId: BigInteger(targetId),
          accessHash: BigInteger(0)
        });
      }
    } else if (targetId < -1000000000000) {
      // 频道/超级群组ID格式
      const channelId = Math.abs(targetId + 1000000000000);
      try {
        const channel = await client.getEntity(channelId);
        return await client.getInputEntity(channel);
      } catch (channelError) {
        console.warn(`Could not get channel entity ${channelId}, trying fallback`);
        return new Api.InputPeerChannel({
          channelId: BigInteger(channelId),
          accessHash: BigInteger(0)
        });
      }
    } else if (targetId < 0) {
      // 普通群组ID格式
      const chatId = Math.abs(targetId);
      try {
        const chat = await client.getEntity(chatId);
        return await client.getInputEntity(chat);
      } catch (chatError) {
        console.warn(`Could not get chat entity ${chatId}, trying fallback`);
        return new Api.InputPeerChat({
          chatId: BigInteger(chatId)
        });
      }
    } else {
      throw new Error(`Invalid target ID: ${targetId}`);
    }
  } catch (error) {
    console.error('Get target peer completely failed:', error);
    throw error;
  }
}

export default shiftPlugin;

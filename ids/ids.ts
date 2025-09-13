import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";

// HTML转义工具
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 帮助文本定义
const help_text = `🆔 <b>用户信息查询插件</b>

<b>使用方式：</b>
• <code>${mainPrefix}ids</code> - 显示自己的信息
• <code>${mainPrefix}ids @用户名</code> - 查询指定用户信息
• <code>${mainPrefix}ids 用户ID</code> - 通过ID查询用户信息
• 回复消息后使用 <code>${mainPrefix}ids</code> - 查询被回复用户信息

<b>显示信息包括：</b>
• 用户名和显示名称
• 用户ID和DC（数据中心）
• 共同群组数量
• 用户简介
• 三种跳转链接

<b>支持格式：</b>
• @用户名、用户ID、频道ID、回复消息`;

class IdsPlugin extends Plugin {
  description: string = `用户信息查询插件\n\n${help_text}`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    ids: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      // 标准参数解析
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身
      const target = args[0] || "";

      try {
        // 处理帮助命令（help 在前的情况）
        if (target === "help" || target === "h") {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        // 处理 help 在后的情况：.ids [参数] help
        if (args[1] && (args[1].toLowerCase() === "help" || args[1].toLowerCase() === "h")) {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        // 显示处理中状态
        await msg.edit({
          text: "🔍 <b>正在查询用户信息...</b>",
          parseMode: "html"
        });

        let targetUser: any = null;
        let targetId: number | null = null;

        // 1. 如果有参数，解析目标用户
        if (target) {
          const result = await this.parseTarget(client, target);
          targetUser = result.user;
          targetId = result.id;
        }
        // 2. 如果没有参数，尝试从回复消息获取
        else {
          try {
            const reply = await msg.getReplyMessage();
            if (reply && reply.senderId) {
              targetId = Number(reply.senderId);
              targetUser = reply.sender;
            }
          } catch (error) {
            console.error("获取回复消息失败:", error);
          }
        }

        // 3. 如果还是没有目标，显示自己的信息
        if (!targetUser && !targetId) {
          const me = await client.getMe();
          targetUser = me;
          targetId = Number(me.id);
        }

        if (!targetId) {
          await msg.edit({
            text: `❌ <b>无法获取用户信息</b>\n\n💡 使用 <code>${mainPrefix}ids help</code> 查看帮助`,
            parseMode: "html"
          });
          return;
        }

        // 获取详细用户信息
        const userInfo = await this.getUserInfo(client, targetUser, targetId);
        
        // 格式化并显示结果
        const result = this.formatUserInfo(userInfo);
        
        // 检查消息长度限制
        await this.sendLongMessage(msg, result);

      } catch (error: any) {
        console.error("[ids] 插件执行失败:", error);
        
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
          text: `❌ <b>查询失败:</b> ${htmlEscape(error.message || "未知错误")}`,
          parseMode: "html"
        });
      }
    }
  };

  // 解析目标用户
  private async parseTarget(client: any, target: string): Promise<{ user: any; id: number | null }> {
    try {
      // 处理 @用户名
      if (target.startsWith("@")) {
        const entity = await client.getEntity(target);
        return { user: entity, id: Number(entity.id) };
      }
      
      // 处理纯数字ID
      if (/^-?\d+$/.test(target)) {
        const userId = parseInt(target);
        try {
          const entity = await client.getEntity(userId);
          return { user: entity, id: userId };
        } catch (error) {
          // 如果直接获取失败，返回ID但用户为空
          return { user: null, id: userId };
        }
      }

      throw new Error("无效的用户格式，请使用 @用户名 或 用户ID");
    } catch (error: any) {
      throw new Error(`解析用户失败: ${error.message}`);
    }
  }

  // 获取用户详细信息
  private async getUserInfo(client: any, user: any, userId: number): Promise<any> {
    const info: any = {
      id: userId,
      user: user,
      username: null,
      firstName: null,
      lastName: null,
      bio: null,
      dc: null,
      commonChats: 0,
      isBot: false,
      isVerified: false,
      isPremium: false,
      isScam: false,
      isFake: false
    };

    // 从用户对象获取基本信息
    if (user) {
      info.username = user.username || null;
      info.firstName = user.firstName || user.first_name || null;
      info.lastName = user.lastName || user.last_name || null;
      info.isBot = user.bot || false;
      info.isVerified = user.verified || false;
      info.isPremium = user.premium || false;
      info.isScam = user.scam || false;
      info.isFake = user.fake || false;
    }

    // 尝试获取完整用户信息
    try {
      const fullUser = await client.invoke(new Api.users.GetFullUser({
        id: userId
      }));
      
      if (fullUser.fullUser) {
        info.bio = fullUser.fullUser.about || null;
        info.commonChats = fullUser.fullUser.commonChatsCount || 0;
      }

      if (fullUser.users && fullUser.users.length > 0) {
        const userDetail = fullUser.users[0];
        info.username = info.username || userDetail.username || null;
        info.firstName = info.firstName || userDetail.firstName || userDetail.first_name || null;
        info.lastName = info.lastName || userDetail.lastName || userDetail.last_name || null;
        info.isBot = userDetail.bot || info.isBot;
        info.isVerified = userDetail.verified || info.isVerified;
        info.isPremium = userDetail.premium || info.isPremium;
        info.isScam = userDetail.scam || info.isScam;
        info.isFake = userDetail.fake || info.isFake;
      }
    } catch (error) {
      console.log("获取完整用户信息失败:", error);
    }

    // 尝试获取DC信息（多种方法）
    info.dc = await this.getUserDC(client, userId, user);
    

    return info;
  }

  // 获取用户DC信息（多种方法尝试）
  private async getUserDC(client: any, userId: number, user: any): Promise<string> {
    try {
      // 方法1: 通过头像获取DC（最可靠的方法）
      const fullUserForDc = await client.invoke(new Api.users.GetFullUser({
        id: userId
      }));
      
      if (fullUserForDc.users && fullUserForDc.users.length > 0) {
        const userForDc = fullUserForDc.users[0];
        
        // 检查用户是否有头像
        if (userForDc.photo && userForDc.photo.className !== "UserProfilePhotoEmpty") {
          const photo = userForDc.photo as Api.UserProfilePhoto;
          return `DC${photo.dcId}`;
        }
      }

      // 方法2: 尝试从用户对象直接获取（某些情况下可能存在）
      if (user && user.photo && user.photo.className !== "UserProfilePhotoEmpty") {
        const photo = user.photo as Api.UserProfilePhoto;
        return `DC${photo.dcId}`;
      }

      // 方法3: 对于机器人，尝试通过getEntity获取更多信息
      if (user && user.bot) {
        try {
          const botEntity = await client.getEntity(userId);
          if (botEntity.photo && botEntity.photo.className !== "UserProfilePhotoEmpty") {
            const photo = botEntity.photo as Api.UserProfilePhoto;
            return `DC${photo.dcId}`;
          }
        } catch (error) {
          console.log("机器人DC获取失败:", error);
        }
      }

      // 如果所有方法都失败，返回相应的提示
      return "无头像";
      
    } catch (error) {
      console.log("获取DC信息失败:", error);
      return "未知";
    }
  }

  // 发送长消息（消息长度检查）
  private async sendLongMessage(msg: Api.Message, text: string): Promise<void> {
    const MAX_MESSAGE_LENGTH = 4096;
    
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await msg.edit({ text: text, parseMode: "html" });
      return;
    }
    
    // 分割长消息
    const parts: string[] = [];
    let currentPart = "";
    const lines = text.split("\n");
    
    for (const line of lines) {
      if (currentPart.length + line.length + 1 > MAX_MESSAGE_LENGTH) {
        parts.push(currentPart);
        currentPart = line;
      } else {
        currentPart += (currentPart ? "\n" : "") + line;
      }
    }
    
    if (currentPart) {
      parts.push(currentPart);
    }
    
    // 发送分割后的消息
    if (parts.length === 1) {
      await msg.edit({ text: parts[0], parseMode: "html" });
    } else {
      // 编辑第一部分
      await msg.edit({ 
        text: parts[0] + "\n\n📄 (1/" + parts.length + ")", 
        parseMode: "html" 
      });
      
      // 发送剩余部分
      for (let i = 1; i < parts.length; i++) {
        await msg.reply({ 
          message: parts[i] + "\n\n📄 (" + (i + 1) + "/" + parts.length + ")",
          parseMode: "html" 
        });
      }
    }
  }

  // 格式化用户信息显示
  private formatUserInfo(info: any): string {
    const userId = info.id;
    
    // 构建显示名称
    let displayName = "";
    if (info.firstName) {
      displayName = info.firstName;
      if (info.lastName) {
        displayName += ` ${info.lastName}`;
      }
    } else if (info.username) {
      displayName = `@${info.username}`;
    } else {
      displayName = `用户 ${userId}`;
    }

    // 构建用户名信息
    let usernameInfo = "";
    if (info.username) {
      usernameInfo = `@${info.username}`;
    } else {
      usernameInfo = "无用户名";
    }

    // 构建状态标签
    const statusTags = [];
    if (info.isBot) statusTags.push("🤖 机器人");
    if (info.isVerified) statusTags.push("✅ 已验证");
    if (info.isPremium) statusTags.push("⭐ Premium");
    if (info.isScam) statusTags.push("⚠️ 诈骗");
    if (info.isFake) statusTags.push("❌ 虚假");

    // 构建简介信息
    let bioText = info.bio || "无简介";
    if (bioText.length > 200) {
      bioText = bioText.substring(0, 200) + "...";
    }

    // 生成三种跳转链接
    const link1 = `tg://user?id=${userId}`;
    const link2 = info.username ? `https://t.me/${info.username}` : `https://t.me/@id${userId}`;
    const link3 = `tg://openmessage?user_id=${userId}`;

    // 构建最终显示文本
    let result = `👤 <b>${htmlEscape(displayName)}</b>\n\n`;
    
    result += `<b>基本信息：</b>\n`;
    result += `• 用户名：<code>${htmlEscape(usernameInfo)}</code>\n`;
    result += `• 用户ID：<code>${userId}</code>\n`;
    result += `• DC：<code>${info.dc}</code>\n`;
    result += `• 共同群：<code>${info.commonChats}</code> 个\n`;
    
    if (statusTags.length > 0) {
      result += `• 状态：${statusTags.join(" ")}\n`;
    }
    
    result += `\n<b>简介：</b>\n<code>${htmlEscape(bioText)}</code>\n`;
    
    result += `\n<b>跳转链接：</b>\n`;
    result += `• <a href="${link1}">用户资料</a>\n`;
    result += `• <a href="${link2}">聊天链接</a>\n`;
    result += `• <a href="${link3}">打开消息</a>\n`;
    
    result += `\n<b>链接文本：</b>\n`;
    result += `• <code>${link1}</code>\n`;
    result += `• <code>${link2}</code>\n`;
    result += `• <code>${link3}</code>`;

    return result;
  }
}

export default new IdsPlugin();

import { Api } from "telegram";
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { sleep } from "telegram/Helpers";
import { NewMessage } from "telegram/events";

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 机器人用户名
const BOT_USERNAME = "FinelyGirlsBot";

// 帮助文本
const help_text = `🎨 <b>妹子图片插件</b>

<b>命令：</b>
• <code>${mainPrefix}botmzt</code> - 显示插件设置和帮助
• <code>${mainPrefix}rand</code> - 随机图片
• <code>${mainPrefix}pic</code> - 妹子图片
• <code>${mainPrefix}leg</code> - 腿部图片
• <code>${mainPrefix}ass</code> - 臀部图片
• <code>${mainPrefix}chest</code> - 胸部图片
• <code>${mainPrefix}coser</code> - Cosplay图片
• <code>${mainPrefix}nsfw</code> - NSFW图片
• <code>${mainPrefix}naizi</code> - 奶子图片
• <code>${mainPrefix}qd</code> - 签到命令

<b>说明：</b>
所有图片都会以剧透模式发送，需要点击查看。`;

/**
 * 等待机器人回复消息
 * @param client Telegram客户端
 * @param botEntity 机器人实体
 * @param timeout 超时时间（毫秒）
 * @param expectPhoto 是否期望图片回复
 * @returns 机器人回复的消息，如果超时则返回null
 */
async function waitForBotReply(
  client: any, 
  botEntity: any, 
  timeout: number = 30000,
  expectPhoto: boolean = true
): Promise<Api.Message | null> {
  return new Promise((resolve) => {
    let timeoutId: NodeJS.Timeout;
    let eventHandler: (event: any) => void;

    // 设置超时
    timeoutId = setTimeout(() => {
      if (eventHandler) {
        client.removeEventHandler(eventHandler, new NewMessage({}));
      }
      resolve(null);
    }, timeout);

    // 创建事件处理器
    eventHandler = async (event: any) => {
      try {
        const message = event.message;
        
        // 检查是否是来自目标机器人的消息
        if (!message || !message.peerId) return;
        
        // 获取发送者ID
        const senderId = message.senderId?.toString();
        const botId = (botEntity as any).id?.toString();
        
        // 确保消息来自目标机器人
        if (senderId !== botId) return;
        
        // 检查消息时间，只处理最近的消息（避免处理历史消息）
        const messageTime = message.date * 1000; // 转换为毫秒
        const currentTime = Date.now();
        const timeDiff = currentTime - messageTime;
        
        // 如果消息时间差超过5秒，可能是历史消息，忽略
        if (timeDiff > 5000) return;
        
        // 如果期望图片，检查是否包含图片
        if (expectPhoto) {
          const hasPhoto = message.photo || 
                          (message.media && message.media.className === 'MessageMediaPhoto') ||
                          (message.document && message.document.mimeType?.startsWith('image/'));
          
          if (!hasPhoto) {
            // 如果消息包含"没有找到"、"错误"等关键词，也认为是有效回复
            const messageText = message.message?.toLowerCase() || '';
            const errorKeywords = ['没有找到', '错误', 'error', '失败', '不存在', '无法', '无效'];
            const hasErrorKeyword = errorKeywords.some(keyword => messageText.includes(keyword));
            
            if (!hasErrorKeyword) return; // 不是错误消息且没有图片，继续等待
          }
        }
        
        // 清理事件监听器和超时
        clearTimeout(timeoutId);
        client.removeEventHandler(eventHandler, new NewMessage({}));
        
        // 返回找到的消息
        resolve(message);
        
      } catch (error) {
        console.error('[mztnew] 处理机器人回复时出错:', error);
      }
    };

    // 注册事件监听器
    client.addEventHandler(eventHandler, new NewMessage({}));
  });
}

/**
 * 与机器人对话并获取图片（使用实时监听）
 * @param client Telegram客户端
 * @param command 发送给机器人的命令
 * @returns 机器人的响应消息
 */
async function getBotResponse(client: any, command: string): Promise<Api.Message | null> {
  try {
    // 解除对机器人的屏蔽（如果有的话）
    try {
      const botEntity = await client.getEntity(BOT_USERNAME);
      await client.invoke(new Api.contacts.Unblock({
        id: botEntity
      }));
    } catch (error) {
      // 忽略解除屏蔽的错误，可能本来就没有屏蔽
    }

    // 获取机器人实体
    const botEntity = await client.getEntity(BOT_USERNAME);
    
    // 检查是否有对话历史，如果没有先发送 /start
    const recentMessages = await client.getMessages(botEntity, { limit: 3 });
    const hasConversation = recentMessages.length > 0;
    
    if (!hasConversation) {
      await client.sendMessage(botEntity, { message: "/start" });
      await sleep(1000);
    }

    // 开始监听机器人回复（期望图片回复）
    const replyPromise = waitForBotReply(client, botEntity, 15000, true);
    
    // 发送命令给机器人
    await client.sendMessage(botEntity, {
      message: `/${command}`
    });

    // 等待机器人响应
    const botResponse = await replyPromise;
    
    return botResponse;
  } catch (error) {
    console.error(`[mztnew] 获取机器人响应失败:`, error);
    throw error;
  }
}

/**
 * 发送签到命令给机器人
 * @param msg 原始消息
 */
async function sendCheckinCommand(msg: Api.Message): Promise<void> {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ 
      text: "❌ 客户端未初始化", 
      parseMode: "html" 
    });
    return;
  }

  try {
    // 显示处理中状态
    await msg.edit({ 
      text: "📅 正在执行签到...", 
      parseMode: "html" 
    });

    // 解除对机器人的屏蔽（如果有的话）
    try {
      await client.invoke(new Api.contacts.Unblock({
        id: BOT_USERNAME
      }));
    } catch (error) {
      // 忽略解除屏蔽的错误，可能本来就没有屏蔽
    }

    // 获取机器人实体
    const botEntity = await client.getEntity(BOT_USERNAME);
    
    // 检查是否有对话历史，如果没有先发送 /start
    const recentMessages = await client.getMessages(botEntity, { limit: 3 });
    const hasConversation = recentMessages.length > 0;
    
    if (!hasConversation) {
      await client.sendMessage(botEntity, { message: "/start" });
      await sleep(1000);
    }

    // 开始监听机器人回复（签到不期望图片，任何回复都可以）
    const replyPromise = waitForBotReply(client, botEntity, 15000, false);
    
    // 发送签到命令给机器人
    await client.sendMessage(botEntity, {
      message: "/checkin"
    });

    // 等待机器人响应
    const botResponse = await replyPromise;
    
    if (botResponse) {
      // 获取机器人回复内容
      const responseText = botResponse.message || "签到成功";
      
      await msg.edit({
        text: `✅ <b>签到完成</b>\n\n${htmlEscape(responseText)}`,
        parseMode: "html"
      });
    } else {
      await msg.edit({
        text: "❌ 签到超时，机器人可能暂时无响应，请稍后重试",
        parseMode: "html"
      });
    }

  } catch (error: any) {
    console.error(`[mztnew] 签到失败:`, error);
    
    // 处理特定错误
    if (error.message?.includes("FLOOD_WAIT")) {
      const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
      await msg.edit({
        text: `⏳ <b>请求过于频繁</b>\n\n需要等待 ${waitTime} 秒后重试`,
        parseMode: "html"
      });
      return;
    }

    if (error.message?.includes("USER_BLOCKED")) {
      await msg.edit({
        text: `❌ <b>无法访问机器人</b>\n\n请先私聊 @${BOT_USERNAME} 并发送 /start`,
        parseMode: "html"
      });
      return;
    }

    // 通用错误处理
    await msg.edit({
      text: `❌ <b>签到失败:</b> ${htmlEscape(error.message || "未知错误")}`,
      parseMode: "html"
    });
  }
}

/**
 * 发送带剧透效果的图片
 * @param msg 原始消息
 * @param command 机器人命令
 */
async function sendImageWithSpoiler(msg: Api.Message, command: string): Promise<void> {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ 
      text: "❌ 客户端未初始化", 
      parseMode: "html" 
    });
    return;
  }

  let botEntity: any;

  try {
    // 显示处理中状态
    await msg.edit({ 
      text: "🔄 正在获取图片...", 
      parseMode: "html" 
    });

    // 获取机器人实体并解除屏蔽（如果有的话）
    try {
      botEntity = await client.getEntity(BOT_USERNAME);
      await client.invoke(new Api.contacts.Unblock({
        id: botEntity
      }));
    } catch (error) {
      // 如果获取实体失败，尝试只获取实体
      if (!botEntity) {
        botEntity = await client.getEntity(BOT_USERNAME);
      }
    }

    // 获取机器人响应
    const botResponse = await getBotResponse(client, command);
    
    if (!botResponse) {
      await msg.edit({
        text: "❌ 机器人没有响应，请稍后重试",
        parseMode: "html"
      });
      return;
    }

    // 检查是否有图片或文档
    let inputMedia: Api.TypeInputMedia | undefined;
    
    if (botResponse.photo && botResponse.photo instanceof Api.Photo) {
      // 处理图片
      const inputPhoto = new Api.InputPhoto({
        id: botResponse.photo.id,
        accessHash: botResponse.photo.accessHash,
        fileReference: botResponse.photo.fileReference,
      });
      inputMedia = new Api.InputMediaPhoto({
        id: inputPhoto,
        spoiler: true, // 添加剧透效果
      });
    } else if (botResponse.document && botResponse.document instanceof Api.Document) {
      // 处理文档（可能是动图等）
      const inputDoc = new Api.InputDocument({
        id: botResponse.document.id,
        accessHash: botResponse.document.accessHash,
        fileReference: botResponse.document.fileReference,
      });
      inputMedia = new Api.InputMediaDocument({
        id: inputDoc,
        spoiler: true, // 添加剧透效果
      });
    } else {
      // 检查是否是错误消息
      const messageText = botResponse.message?.toLowerCase() || '';
      const errorKeywords = ['没有找到', '错误', 'error', '失败', '不存在', '无法', '无效'];
      const hasErrorKeyword = errorKeywords.some(keyword => messageText.includes(keyword));
      
      if (hasErrorKeyword) {
        await msg.edit({
          text: `❌ <b>机器人返回错误:</b> ${htmlEscape(botResponse.message || "未知错误")}`,
          parseMode: "html"
        });
      } else {
        await msg.edit({
          text: "❌ 机器人没有返回图片，请稍后重试",
          parseMode: "html"
        });
      }
      return;
    }

    // 使用 SendMedia API 发送带剧透效果的图片
    await client.invoke(
      new Api.messages.SendMedia({
        peer: msg.peerId,
        media: inputMedia,
        message: "", // 不添加文字内容
        ...(msg.replyTo?.replyToMsgId ? {
          replyTo: new Api.InputReplyToMessage({
            replyToMsgId: msg.replyTo.replyToMsgId
          })
        } : {})
      })
    );

    // 将机器人的消息标记为已读
    try {
      await client.markAsRead(botEntity);
    } catch (readError) {
      console.error('[mztnew] 标记已读失败:', readError);
    }

    // 删除原始命令消息
    await msg.delete({ revoke: true });

  } catch (error: any) {
    console.error(`[mztnew] 发送图片失败:`, error);
    
    // 处理特定错误
    if (error.message?.includes("FLOOD_WAIT")) {
      const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
      await msg.edit({
        text: `⏳ <b>请求过于频繁</b>\n\n需要等待 ${waitTime} 秒后重试`,
        parseMode: "html"
      });
      return;
    }

    if (error.message?.includes("USER_BLOCKED")) {
      await msg.edit({
        text: `❌ <b>无法访问机器人</b>\n\n请先私聊 @${BOT_USERNAME} 并发送 /start`,
        parseMode: "html"
      });
      return;
    }

    // 通用错误处理
    await msg.edit({
      text: `❌ <b>获取图片失败:</b> ${htmlEscape(error.message || "未知错误")}`,
      parseMode: "html"
    });
  }
}

class MztNewPlugin extends Plugin {
  description: string = `妹子图片插件 - 从 ${BOT_USERNAME} 获取各类图片\n\n${help_text}`;

  cmdHandlers = {
    // 主命令 - 显示帮助和设置
    botmzt: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      try {
        const settingsText = `🎨 <b>妹子图片插件设置</b>

<b>当前配置：</b>
• 机器人: @${BOT_USERNAME}
• 剧透模式: 已启用
• 自动删除命令: 已启用

<b>可用命令：</b>
• <code>${mainPrefix}rand</code> - 随机图片
• <code>${mainPrefix}pic</code> - 妹子图片  
• <code>${mainPrefix}leg</code> - 腿部图片
• <code>${mainPrefix}ass</code> - 臀部图片
• <code>${mainPrefix}chest</code> - 胸部图片
• <code>${mainPrefix}coser</code> - Cosplay图片
• <code>${mainPrefix}nsfw</code> - NSFW图片
• <code>${mainPrefix}naizi</code> - 奶子图片

<b>使用说明：</b>
所有图片都会以剧透模式发送，点击查看。
此消息将在30秒后自动删除。`;

        const statusMsg = await msg.edit({ 
          text: settingsText, 
          parseMode: "html" 
        });

        // 30秒后删除消息
        setTimeout(async () => {
          try {
            if (statusMsg) {
              await statusMsg.delete({ revoke: true });
            }
          } catch (error) {
            // 忽略删除错误
          }
        }, 30000);

      } catch (error: any) {
        console.error("[mztnew] 显示设置失败:", error);
        await msg.edit({
          text: `❌ <b>显示设置失败:</b> ${htmlEscape(error.message)}`,
          parseMode: "html"
        });
      }
    },

    // 随机图片
    rand: async (msg: Api.Message) => {
      await sendImageWithSpoiler(msg, "rand");
    },

    // 妹子图片
    pic: async (msg: Api.Message) => {
      await sendImageWithSpoiler(msg, "pic");
    },

    // 腿部图片
    leg: async (msg: Api.Message) => {
      await sendImageWithSpoiler(msg, "leg");
    },

    // 臀部图片
    ass: async (msg: Api.Message) => {
      await sendImageWithSpoiler(msg, "ass");
    },

    // 胸部图片
    chest: async (msg: Api.Message) => {
      await sendImageWithSpoiler(msg, "chest");
    },

    // Cosplay图片（重命名为coser）
    coser: async (msg: Api.Message) => {
      await sendImageWithSpoiler(msg, "cos");
    },

    // NSFW图片
    nsfw: async (msg: Api.Message) => {
      await sendImageWithSpoiler(msg, "nsfw");
    },

    // 奶子图片
    naizi: async (msg: Api.Message) => {
      await sendImageWithSpoiler(msg, "naizi");
    },

    // 签到命令
    qd: async (msg: Api.Message) => {
      await sendCheckinCommand(msg);
    }
  };
}

export default new MztNewPlugin();
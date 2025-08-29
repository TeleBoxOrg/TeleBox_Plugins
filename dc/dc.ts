import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";

const dcPlugin: Plugin = {
  command: ["dc"],
  description: "获取指定用户或当前群组/频道的 DC",
  cmdHandler: async (msg: Api.Message) => {
    const args = msg.message.slice(1).split(' ').slice(1);
    const param = args[0] || '';
    
    // 参数检查
    if (args.length > 1) {
      await msg.edit({
        text: "❌ 参数错误，最多只能指定一个用户"
      });
      return;
    }
    
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({
        text: "❌ Telegram客户端未初始化"
      });
      return;
    }
    
    await msg.edit({
      text: "🔍 正在获取 DC 信息..."
    });
    
    try {
      // 如果是回复消息
      if (msg.replyTo) {
        const replyMessage = await msg.getReplyMessage();
        if (!replyMessage) {
          await msg.edit({
            text: "❌ 无法获取回复的消息"
          });
          return;
        }
        
        const senderId = replyMessage.senderId;
        if (!senderId) {
          await msg.edit({
            text: "❌ 无法获取回复消息的发送者"
          });
          return;
        }
        
        try {
          // 尝试获取用户信息
          const fullUser = await client.invoke(new Api.users.GetFullUser({
            id: await client.getInputEntity(senderId)
          }));
          
          const user = fullUser.users[0] as Api.User;
          if (!user.photo || user.photo.className === "UserProfilePhotoEmpty") {
            await msg.edit({
              text: "❌ 目标用户没有头像，无法获取 DC 信息"
            });
            return;
          }
          
          const photo = user.photo as Api.UserProfilePhoto;
          const firstName = user.firstName || "未知用户";
          await msg.edit({
            text: `📍 **${firstName}** 所在数据中心为: **DC${photo.dcId}**`,
            parseMode: "markdown"
          });
          return;
          
        } catch (error) {
          // 如果获取用户失败，尝试获取聊天信息
          try {
            const chat = await replyMessage.getChat();
            if (!chat || !('photo' in chat) || !chat.photo || chat.photo.className === "ChatPhotoEmpty") {
              await msg.edit({
                text: "❌ 回复的消息所在对话需要先设置头像"
              });
              return;
            }
            
            const photo = chat.photo as Api.ChatPhoto;
            const title = 'title' in chat ? (chat as any).title : "未知聊天";
            await msg.edit({
              text: `📍 **${title}** 所在数据中心为: **DC${photo.dcId}**`,
              parseMode: "markdown"
            });
            return;
            
          } catch (chatError) {
            await msg.edit({
              text: "❌ 无法获取该对象的 DC 信息"
            });
            return;
          }
        }
      }
      
      // 如果没有参数，获取当前聊天的 DC
      if (!param) {
        const chat = await msg.getChat();
        if (!chat || !('photo' in chat) || !chat.photo || chat.photo.className === "ChatPhotoEmpty") {
          await msg.edit({
            text: "❌ 当前群组/频道没有头像，无法获取 DC 信息"
          });
          return;
        }
        
        const photo = chat.photo as Api.ChatPhoto;
        const title = 'title' in chat ? (chat as any).title : "当前聊天";
        await msg.edit({
          text: `📍 **${title}** 所在数据中心为: **DC${photo.dcId}**`,
          parseMode: "markdown"
        });
        return;
      }
      
      // 处理用户参数
      let targetUser: any = null;
      
      // 检查消息实体（@用户名或电话号码）
      if (msg.entities) {
        for (const entity of msg.entities) {
          if (entity.className === "MessageEntityMentionName") {
            const mentionEntity = entity as Api.MessageEntityMentionName;
            targetUser = mentionEntity.userId.toString();
            break;
          }
          if (entity.className === "MessageEntityPhone") {
            if (/^\d+$/.test(param)) {
              targetUser = parseInt(param);
            }
            break;
          }
        }
      }
      
      // 如果没有找到实体，直接使用参数
      if (!targetUser) {
        if (/^\d+$/.test(param)) {
          targetUser = parseInt(param);
        } else {
          targetUser = param;
        }
      }
      
      if (!targetUser) {
        await msg.edit({
          text: "❌ 请指定有效的用户名或用户ID"
        });
        return;
      }
      
      try {
        // 获取用户实体
        const userEntity = await client.getEntity(targetUser);
        
        // 获取完整用户信息
        const fullUser = await client.invoke(new Api.users.GetFullUser({
          id: await client.getInputEntity(userEntity.id)
        }));
        
        const user = fullUser.users[0] as Api.User;
        if (!user.photo || user.photo.className === "UserProfilePhotoEmpty") {
          await msg.edit({
            text: "❌ 目标用户需要先设置头像才能获取 DC 信息"
          });
          return;
        }
        
        const photo = user.photo as Api.UserProfilePhoto;
        const firstName = user.firstName || "未知用户";
        await msg.edit({
          text: `📍 **${firstName}** 所在数据中心为: **DC${photo.dcId}**`,
          parseMode: "markdown"
        });
        
      } catch (error) {
        const errorStr = String(error);
        
        if (errorStr.includes("Cannot find any entity corresponding to")) {
          await msg.edit({
            text: "❌ 找不到对应的用户或实体"
          });
        } else if (errorStr.includes("No user has")) {
          await msg.edit({
            text: "❌ 没有找到指定的用户"
          });
        } else if (errorStr.includes("Could not find the input entity for")) {
          await msg.edit({
            text: "❌ 无法找到输入的实体"
          });
        } else if (errorStr.includes("int too big to convert")) {
          await msg.edit({
            text: "❌ 用户ID过长，请检查输入"
          });
        } else {
          console.error("DC插件获取用户信息失败:", error);
          await msg.edit({
            text: `❌ 获取用户信息失败: ${errorStr}`
          });
        }
      }
      
    } catch (error) {
      console.error("DC插件执行失败:", error);
      await msg.edit({
        text: `❌ DC 查询失败: ${String(error)}`
      });
    }
  },
};

export default dcPlugin;

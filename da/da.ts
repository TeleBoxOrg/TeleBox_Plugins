import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";

const daPlugin: Plugin = {
  command: ["da"],
  description: "删除群内所有消息。（非群组管理员只删除自己的消息）",
  cmdHandler: async (msg: Api.Message) => {
    const args = msg.message.slice(1).split(' ').slice(1);
    const param = args[0] || '';
    
    // 检查是否在群组中
    if (!msg.chatId || msg.isPrivate) {
      await msg.edit({
        text: "❌ 此命令只能在群组中使用"
      });
      return;
    }
    
    // 安全确认机制
    if (param !== "true") {
      await msg.edit({
        text: `⚠️ **危险操作警告**\n\n此命令将删除群内所有消息！\n\n如果确认执行，请使用：\`da true\``
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
      text: "🔄 正在删除所有消息..."
    });
    
    try {
      const chatId = msg.chatId;
      let messages: Api.Message[] = [];
      let count = 0;
      let processed = 0;
      
      // 获取当前用户信息以判断权限
      const me = await client.getMe();
      const myId = me.id;
      
      // 检查是否为管理员
      let isAdmin = false;
      try {
        const chat = await client.getEntity(chatId);
        if (chat.className === "Channel") {
          try {
            const permissions = await client.invoke(new Api.channels.GetParticipant({
              channel: chat as Api.Channel,
              participant: myId
            }));
            isAdmin = permissions.participant.className === "ChannelParticipantAdmin" || 
                     permissions.participant.className === "ChannelParticipantCreator";
          } catch (permError) {
            // 无法获取权限，假设不是管理员
            isAdmin = false;
          }
        }
      } catch (e) {
        // 如果无法获取权限信息，假设不是管理员
        isAdmin = false;
      }
      
      // 遍历所有消息
      const messageIterator = client.iterMessages(chatId, { minId: 1 });
      for await (const message of messageIterator) {
        // 如果不是管理员，只删除自己的消息
        if (!isAdmin && message.senderId?.toString() !== myId.toString()) {
          continue;
        }
        
        messages.push(message);
        count++;
        
        // 每100条消息批量删除一次
        if (messages.length >= 100) {
          try {
            await client.deleteMessages(chatId, messages.map(m => m.id), { revoke: true });
            processed += messages.length;
            messages = [];
            
            // 更新进度
            if (processed % 500 === 0) {
              try {
                await msg.edit({
                  text: `🔄 正在删除消息... 已处理 ${processed} 条`
                });
              } catch (e) {
                // 忽略编辑失败
              }
            }
          } catch (error) {
            console.error("批量删除消息失败:", error);
          }
        }
      }
      
      // 删除剩余的消息
      if (messages.length > 0) {
        try {
          await client.deleteMessages(chatId, messages.map(m => m.id), { revoke: true });
          processed += messages.length;
        } catch (error) {
          console.error("删除剩余消息失败:", error);
        }
      }
      
      // 发送完成消息
      const resultText = isAdmin 
        ? `✅ 批量删除完成，共删除了 ${processed} 条消息`
        : `✅ 删除完成，共删除了 ${processed} 条自己的消息（非管理员模式）`;
      
      try {
        const resultMsg = await client.sendMessage(chatId, { message: resultText });
        
        // 5秒后删除结果消息
        setTimeout(async () => {
          try {
            await client.deleteMessages(chatId, [resultMsg.id], { revoke: true });
          } catch (e) {
            // 忽略删除失败
          }
        }, 5000);
      } catch (error) {
        console.error("发送结果消息失败:", error);
      }
      
      console.log(`DA插件: ${isAdmin ? '管理员' : '普通用户'}模式删除了 ${processed} 条消息`);
      
    } catch (error) {
      console.error("DA插件执行失败:", error);
      try {
        await msg.edit({
          text: `❌ 删除消息失败: ${String(error)}`
        });
      } catch (e) {
        // 忽略编辑失败
      }
    }
  },
};

export default daPlugin;

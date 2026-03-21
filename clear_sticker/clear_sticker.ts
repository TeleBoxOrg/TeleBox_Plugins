import { Plugin } from "../src/utils/pluginBase";
import { getGlobalClient } from "../src/utils/globalClient";
import { Api } from "teleproto";
import bigInt from "big-integer";
import { getPrefixes } from "@utils/pluginManager";
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];



class ClearStickerPlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  description: string = `🧹 <b>清理群内贴纸消息</b><br/><br/>
<b>命令</b><br/>
• <code>${mainPrefix}clear_sticker [数量]</code> / <code>${mainPrefix}cs [数量]</code><br/><br/>
<b>说明</b><br/>
• 清理群内历史贴纸消息（仅群聊可用）<br/>
• 可选参数“数量”用于限制删除数量（默认清理全部）`;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    "clear_sticker": this.handleClearSticker.bind(this),
    "cs": this.handleClearSticker.bind(this),
  };

  private async handleClearSticker(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    
    if (!client) {
      await msg.edit({
        text: "❌ 客户端未初始化"
      });
      return;
    }
    
    try {

      if (!msg.peerId || !(msg.peerId instanceof Api.PeerChat || msg.peerId instanceof Api.PeerChannel)) {
        await msg.edit({
          text: "❌ 此命令只能在群组中使用。"
        });
        return;
      }


      const args = msg.message?.split(' ').slice(1) || [];
      let maxCount = 2000; // 安全上限，避免一次性过大
      
      if (args.length > 0) {
        const countArg = parseInt(args[0]);
        if (isNaN(countArg) || countArg < 1) {
          await msg.edit({
            text: "❌ 请输入有效的贴纸数量，例如：${mainPrefix}clear_sticker 100"
          });
          return;
        }
        maxCount = Math.min(countArg, 2000);
      }

      const chatId = msg.peerId;
      
      await msg.edit({
        text: `🔍 Searching for sticker messages...\nTarget count: ${maxCount}`
      });

      let deletedCount = 0;
      let offsetId = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore && deletedCount < maxCount) {
        try {
  
          const history = await client.invoke(
            new Api.messages.GetHistory({
              peer: chatId,
              offsetId: offsetId,
              offsetDate: 0,
              addOffset: 0,
              limit: limit,
              maxId: 0,
              minId: 0,
              hash: bigInt(0)
            })
          );

          if (!(history instanceof Api.messages.Messages) && 
              !(history instanceof Api.messages.MessagesSlice) &&
              !(history instanceof Api.messages.ChannelMessages)) {
            break;
          }

          const messages = history.messages;
          
          if (!messages || messages.length === 0) {
            hasMore = false;
            break;
          }

          const stickerMessages: number[] = [];
          
          for (const message of messages) {
            if (message instanceof Api.Message && message.media) {

              if (message.media instanceof Api.MessageMediaDocument) {
                const document = message.media.document;
                if (document instanceof Api.Document) {
                  const isSticker = document.attributes?.some(attr => 
                    attr instanceof Api.DocumentAttributeSticker
                  );
                  
                  if (isSticker) {
                    stickerMessages.push(message.id);
                  }
                }
              }
            }
          }


          if (stickerMessages.length > 0) {
            try {

              const messagesToDelete = deletedCount + stickerMessages.length > maxCount 
                ? stickerMessages.slice(0, maxCount - deletedCount)
                : stickerMessages;
              
              await client.deleteMessages(chatId, messagesToDelete, {
                revoke: true
              });
              deletedCount += messagesToDelete.length;
              

              const progressText = `🗑️ 正在清理贴纸消息...\n进度：${deletedCount}/${maxCount}`;
              await msg.edit({
                text: progressText
              });
            } catch (deleteError) {
              console.error("Failed to delete sticker messages:", deleteError);
            }
          }


          if (messages.length > 0) {
            const lastMessage = messages[messages.length - 1];
            if (lastMessage instanceof Api.Message) {
              offsetId = lastMessage.id;
            }
          }


          if (messages.length < limit) {
            hasMore = false;
          }


          // 节流，避免触发限制
          await new Promise(resolve => setTimeout(resolve, 1200));
          
        } catch (historyError) {
          console.error("Failed to get chat history:", historyError);
          hasMore = false;
        }
      }


      if (deletedCount > 0) {
        const resultText = maxCount === Number.MAX_SAFE_INTEGER 
          ? `✅ 清理完成！\n共删除了 ${deletedCount} 条贴纸消息。`
          : `✅ 清理完成！\n已删除 ${deletedCount} 条贴纸消息。`;
        
        try {
          const finalMsg = await msg.edit({
            text: resultText
          });
          

          setTimeout(async () => {
            try {
              if (finalMsg && typeof finalMsg.delete === 'function') {
                await finalMsg.delete();
              }
            } catch (error) {
              console.error("Failed to delete result message:", error);
            }
          }, 3000);
        } catch (error) {
          console.error("Failed to edit final message:", error);
        }
      } else {
        await msg.edit({
          text: "ℹ️ 未找到贴纸消息。"
        });
      }
      
    } catch (error) {
      console.error("ClearSticker plugin error:", error);
      await msg.edit({
        text: "❌ 清理贴纸消息时出现错误。"
      });
    }
  }
}

export default new ClearStickerPlugin();

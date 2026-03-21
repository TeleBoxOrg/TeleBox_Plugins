import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api, TelegramClient } from "teleproto";
import { getGlobalClient } from "@utils/globalClient";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


// HTML转义工具（每个插件必须实现）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文档常量
const help_text = `<b>⚠️ 一键跑路</b>

<code>${mainPrefix}paolu</code> - 删除群内所有消息并禁言所有成员

<b>警告：</b>此操作不可逆，请谨慎使用！`;

// 工具函数
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class PaoluPlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  description: string = `群组一键跑路插件 - 删除消息并禁言所有成员\n\n${help_text}`;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    paolu: this.handlePaolu.bind(this),
  };

  private async handlePaolu(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端错误", parseMode: "html" });
      return;
    }

    if (!msg.chatId || msg.isPrivate) {
      await msg.edit({ text: "❌ 仅群组可用", parseMode: "html" });
      return;
    }

    const chatId = msg.chatId;

    try {
      // 检查管理员权限
      const me = await client.getMe();
      let isAdmin = false;
      
      try {
        const chat = await client.getEntity(chatId);
        if (chat.className === "Channel") {
          try {
            const result = await client.invoke(
              new Api.channels.GetParticipant({
                channel: chat as Api.Channel,
                participant: me.id,
              })
            );
            isAdmin =
              result.participant instanceof Api.ChannelParticipantAdmin ||
              result.participant instanceof Api.ChannelParticipantCreator;
          } catch (permError) {
            console.log("权限检查失败，尝试备用方法:", permError);
            try {
              const adminResult = await client.invoke(
                new Api.channels.GetParticipants({
                  channel: chat as Api.Channel,
                  filter: new Api.ChannelParticipantsAdmins(),
                  offset: 0,
                  limit: 100,
                  hash: 0 as any,
                })
              );
              if ("users" in adminResult) {
                const admins = adminResult.users as Api.User[];
                isAdmin = admins.some(
                  (admin) => Number(admin.id) === Number(me.id)
                );
              }
            } catch (adminListError) {
              console.log("管理员列表获取失败:", adminListError);
              isAdmin = false;
            }
          }
        }
      } catch (e) {
        console.error("权限检查失败:", e);
        isAdmin = false;
      }

      if (!isAdmin) {
        await msg.edit({ 
          text: "❌ 需要管理员权限才能执行此操作", 
          parseMode: "html" 
        });
        return;
      }

      // 开始执行跑路操作
      await msg.edit({ 
        text: "🚨 <b>一键跑路</b>\n\n正在处理中...", 
        parseMode: "html" 
      });

      // 1. 禁言所有成员
      try {
        await client.invoke(
          new Api.channels.EditBanned({
            channel: chatId,
            participant: "all",
            bannedRights: new Api.ChatBannedRights({
              untilDate: 0,
              viewMessages: true,
              sendMessages: true,
              sendMedia: true,
              sendStickers: true,
              sendGifs: true,
              sendGames: true,
              sendInline: true,
              sendPolls: true,
              changeInfo: true,
              inviteUsers: true,
              pinMessages: true,
            }),
          })
        );
        console.log(`[PAOLU] 已禁言群组 ${chatId}`);
      } catch (banError) {
        console.error("[PAOLU] 禁言操作失败:", banError);
        // 继续执行删除操作，不因禁言失败而停止
      }

      // 2. 批量删除消息（参考da.ts的删除逻辑）
      let deletedCount = 0;
      const BATCH_SIZE = 100;
      
      try {
        // 获取群聊信息用于日志
        let chatName = "未知群组";
        try {
          const chat = await client.getEntity(chatId);
          if ("title" in chat) {
            chatName = chat.title || "未知群组";
          }
        } catch (error) {
          console.error("获取群聊信息失败:", error);
        }

        console.log(`[PAOLU] 开始删除群组 ${chatName} 的消息`);

        // 使用迭代器遍历消息
        const deleteIterator = client.iterMessages(chatId, { 
          minId: 1,
          reverse: true // 从最早的消息开始删除
        });
        
        let messages: Api.Message[] = [];
        
        for await (const message of deleteIterator) {
          // 跳过当前命令消息，最后单独处理
          if (message.id === msg.id) continue;
          
          messages.push(message);

          // 达到批处理大小时执行删除
          if (messages.length >= BATCH_SIZE) {
            const success = await this.fastDeleteBatch(client, chatId, messages);
            if (success) {
              deletedCount += messages.length;
            }
            messages = [];
            
            // 更新进度
            await msg.edit({
              text: `🚨 <b>一键跑路</b>\n\n正在删除消息...\n已删除: ${deletedCount} 条`,
              parseMode: "html"
            });
          }
        }

        // 删除剩余消息
        if (messages.length > 0) {
          const success = await this.fastDeleteBatch(client, chatId, messages);
          if (success) {
            deletedCount += messages.length;
          }
        }

        console.log(`[PAOLU] 删除完成，共删除 ${deletedCount} 条消息`);

      } catch (deleteError) {
        console.error("[PAOLU] 删除消息失败:", deleteError);
        // 继续执行后续操作
      }

      // 3. 删除命令消息本身
      try {
        await msg.delete({ revoke: true });
      } catch (deleteError) {
        console.error("[PAOLU] 删除命令消息失败:", deleteError);
      }

      // 4. 发送完成提示（自动删除）
      try {
        const completionMsg = await client.sendMessage(chatId, {
          message: `✅ <b>跑路完成</b>\n\n• 已禁言所有成员\n• 已删除 ${deletedCount} 条消息\n\n此消息将在10秒后自动删除`,
          parseMode: "html"
        });

        // 10秒后自动删除完成提示
        setTimeout(async () => {
          try {
            await completionMsg.delete({ revoke: true });
          } catch (e) {
            console.error("[PAOLU] 自动删除完成提示失败:", e);
          }
        }, 10000);

      } catch (sendError) {
        console.error("[PAOLU] 发送完成提示失败:", sendError);
      }

    } catch (error: any) {
      console.error("[PAOLU] 插件执行失败:", error);
      
      // 错误处理
      let errorMsg = "❌ 操作失败";
      if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        errorMsg = `⏳ 操作过于频繁，请等待 ${waitTime} 秒后重试`;
      } else if (error.message) {
        errorMsg += `: ${htmlEscape(error.message)}`;
      }
      
      await msg.edit({ text: errorMsg, parseMode: "html" });
    }
  }

  /**
   * 高速删除批处理（参考da.ts）
   */
  private async fastDeleteBatch(
    client: TelegramClient,
    chatId: bigInt.BigInteger,
    messages: Api.Message[]
  ): Promise<boolean> {
    try {
      await client.deleteMessages(
        chatId,
        messages.map((m) => m.id),
        { revoke: true }
      );
      return true;
    } catch (error: any) {
      // FLOOD_WAIT处理
      if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "30") * 1000;
        await sleep(waitTime);
        return this.fastDeleteBatch(client, chatId, messages); // 重试
      }
      
      // 批量失败，逐个删除
      console.warn("[PAOLU] 批量删除失败，转为逐个删除");
      for (const message of messages) {
        try {
          await client.deleteMessages(chatId, [message.id], { revoke: true });
          await sleep(100); // 避免过快触发限制
        } catch (individualError) {
          console.error(`[PAOLU] 删除单条消息失败 (ID: ${message.id}):`, individualError);
        }
      }
      return false;
    }
  }
}

export default new PaoluPlugin();

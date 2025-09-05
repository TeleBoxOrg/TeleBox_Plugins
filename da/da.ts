import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "telegram";
import { getGlobalClient } from "@utils/globalClient";

const da = async (msg: Api.Message) => {
  const args = msg.message.slice(1).split(" ").slice(1);
  const param = args[0] || "";

  // 检查是否在群组中
  if (!msg.chatId || msg.isPrivate) {
    await msg.edit({
      text: "❌ 此命令只能在群组中使用",
      parseMode: "html",
    });
    return;
  }

  // 安全确认机制
  if (param !== "true") {
    await msg.edit({
      text: `⚠️ <b>危险操作警告</b>\n\n此命令将删除群内所有消息！\n\n如果确认执行，请使用：<code>da true</code>`,
      parseMode: "html",
    });
    return;
  }

  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({
      text: "❌ Telegram客户端未初始化",
      parseMode: "html",
    });
    return;
  }

  await msg.edit({
    text: "🔄 <b>正在删除所有消息...</b>",
    parseMode: "html",
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
          const result = await client.invoke(
            new Api.channels.GetParticipant({
              channel: chat as Api.Channel,
              participant: myId,
            })
          );
          isAdmin =
            result.participant instanceof Api.ChannelParticipantAdmin ||
            result.participant instanceof Api.ChannelParticipantCreator;
        } catch (permError) {
          console.log(
            "GetParticipant failed, trying alternative method:",
            permError
          );
          // 备用方法：检查管理员列表
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
                (admin) => Number(admin.id) === Number(myId)
              );
            }
          } catch (adminListError) {
            console.log("GetParticipants admin list failed:", adminListError);
            isAdmin = false;
          }
        }
      }
    } catch (e) {
      console.error("Failed to check admin permissions:", e);
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
          await client.deleteMessages(
            chatId,
            messages.map((m) => m.id),
            { revoke: true }
          );
          processed += messages.length;
          messages = [];

          // 更新进度
          if (processed % 500 === 0) {
            try {
              await msg.edit({
                text: `🔄 <b>正在删除消息...</b> 已处理 <code>${processed}</code> 条`,
                parseMode: "html",
              });
            } catch (e) {
              // 忽略编辑失败
            }
          }
        } catch (error) {
          console.error("批量删除消息失败:", error);
          // 如果批量删除失败，尝试逐个删除
          for (const message of messages) {
            try {
              await client.deleteMessages(chatId, [message.id], {
                revoke: true,
              });
              processed++;
            } catch (singleError) {
              console.error(
                `删除单条消息失败 (ID: ${message.id}):`,
                singleError
              );
            }
          }
          messages = [];
        }
      }
    }

    // 删除剩余的消息
    if (messages.length > 0) {
      try {
        await client.deleteMessages(
          chatId,
          messages.map((m) => m.id),
          { revoke: true }
        );
        processed += messages.length;
      } catch (error) {
        console.error("删除剩余消息失败:", error);
        // 如果批量删除失败，尝试逐个删除剩余消息
        for (const message of messages) {
          try {
            await client.deleteMessages(chatId, [message.id], { revoke: true });
            processed++;
          } catch (singleError) {
            console.error(`删除单条消息失败 (ID: ${message.id}):`, singleError);
          }
        }
      }
    }

    // 发送完成消息
    const resultText = isAdmin
      ? `✅ <b>批量删除完成</b>，共删除了 <code>${processed}</code> 条消息`
      : `✅ <b>删除完成</b>，共删除了 <code>${processed}</code> 条自己的消息（非管理员模式）`;

    try {
      const resultMsg = await client.sendMessage(chatId, {
        message: resultText,
        parseMode: "html",
      });

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

    console.log(
      `DA插件: ${isAdmin ? "管理员" : "普通用户"}模式删除了 ${processed} 条消息`
    );
  } catch (error) {
    console.error("DA插件执行失败:", error);
    try {
      await msg.edit({
        text: `❌ <b>删除消息失败:</b> ${String(error)}`,
        parseMode: "html",
      });
    } catch (e) {
      // 忽略编辑失败
    }
  }
};

class DaPlugin extends Plugin {
  description: string = `删除群内所有消息。（非群组管理员只删除自己的消息）`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    da,
  };
}

export default new DaPlugin();

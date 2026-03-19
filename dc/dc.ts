import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "teleproto";
import { getGlobalClient } from "@utils/globalClient";

const dc = async (msg: Api.Message) => {
  const args = msg.message.slice(1).split(" ").slice(1);
  const param = args[0] || "";

  // 参数检查
  if (args.length > 1) {
    await msg.edit({
      text: "❌ 参数错误，最多只能指定一个用户",
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
    text: "🔍 <b>正在获取 DC 信息...</b>",
    parseMode: "html",
  });

  try {
    // 如果是回复消息
    if (msg.replyTo) {
      const replyMessage = await msg.getReplyMessage();
      if (!replyMessage) {
        await msg.edit({
          text: "❌ 无法获取回复的消息",
          parseMode: "html",
        });
        return;
      }

      const senderId = replyMessage.senderId;
      if (!senderId) {
        await msg.edit({
          text: "❌ 无法获取回复消息的发送者",
          parseMode: "html",
        });
        return;
      }

      try {
        // 尝试获取用户信息
        const fullUser = await client.invoke(
          new Api.users.GetFullUser({
            id: await client.getInputEntity(senderId),
          })
        );

        const user = fullUser.users[0] as Api.User;
        if (!user.photo || user.photo.className === "UserProfilePhotoEmpty") {
          await msg.edit({
            text: "❌ 目标用户没有头像，无法获取 DC 信息",
            parseMode: "html",
          });
          return;
        }

        const photo = user.photo as Api.UserProfilePhoto;
        const firstName = user.firstName || "未知用户";
        await msg.edit({
          text: `📍 <b>${firstName}</b> 所在数据中心为: <b>DC${photo.dcId}</b>`,
          parseMode: "html",
        });
        return;
      } catch (error) {
        // 如果获取用户失败，尝试获取聊天信息
        try {
          const chat = await replyMessage.getChat();
          if (
            !chat ||
            !("photo" in chat) ||
            !chat.photo ||
            chat.photo.className === "ChatPhotoEmpty"
          ) {
            await msg.edit({
              text: "❌ 回复的消息所在对话需要先设置头像",
              parseMode: "html",
            });
            return;
          }

          const photo = chat.photo as Api.ChatPhoto;
          const title = "title" in chat ? (chat as any).title : "未知聊天";
          await msg.edit({
            text: `📍 <b>${title}</b> 所在数据中心为: <b>DC${photo.dcId}</b>`,
            parseMode: "html",
          });
          return;
        } catch (chatError) {
          await msg.edit({
            text: "❌ 无法获取该对象的 DC 信息",
            parseMode: "html",
          });
          return;
        }
      }
    }

    // 如果没有参数，获取当前聊天的 DC
    if (!param) {
      const chat = await msg.getChat();
      if (
        !chat ||
        !("photo" in chat) ||
        !chat.photo ||
        chat.photo.className === "ChatPhotoEmpty"
      ) {
        await msg.edit({
          text: "❌ 当前群组/频道没有头像，无法获取 DC 信息",
          parseMode: "html",
        });
        return;
      }

      const photo = chat.photo as Api.ChatPhoto;
      const title = "title" in chat ? (chat as any).title : "当前聊天";
      await msg.edit({
        text: `📍 <b>${title}</b> 所在数据中心为: <b>DC${photo.dcId}</b>`,
        parseMode: "html",
      });
      return;
    }

    // 处理用户参数
    let targetUser: any = null;

    try {
      // 检查消息实体（@用户名或电话号码）
      if (msg.entities) {
        for (const entity of msg.entities) {
          if (entity instanceof Api.MessageEntityMentionName) {
            targetUser = entity.userId.toString();
            break;
          }
          if (entity instanceof Api.MessageEntityPhone) {
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
    } catch (entityError) {
      console.error("解析消息实体失败:", entityError);
      // 降级为直接使用参数
      if (/^\d+$/.test(param)) {
        targetUser = parseInt(param);
      } else {
        targetUser = param;
      }
    }

    if (!targetUser) {
      await msg.edit({
        text: "❌ 请指定有效的用户名或用户ID",
        parseMode: "html",
      });
      return;
    }

    try {
      // 获取用户实体
      const userEntity = await client.getEntity(targetUser);

      // 获取完整用户信息
      const fullUser = await client.invoke(
        new Api.users.GetFullUser({
          id: await client.getInputEntity(userEntity),
        })
      );

      const user = fullUser.users[0] as Api.User;
      if (!user.photo || user.photo.className === "UserProfilePhotoEmpty") {
        await msg.edit({
          text: "❌ 目标用户需要先设置头像才能获取 DC 信息",
          parseMode: "html",
        });
        return;
      }

      const photo = user.photo as Api.UserProfilePhoto;
      const firstName = user.firstName || "未知用户";
      await msg.edit({
        text: `📍 <b>${firstName}</b> 所在数据中心为: <b>DC${photo.dcId}</b>`,
        parseMode: "html",
      });
    } catch (error) {
      const errorStr = String(error);

      if (errorStr.includes("Cannot find any entity corresponding to")) {
        await msg.edit({
          text: "❌ 找不到对应的用户或实体",
          parseMode: "html",
        });
      } else if (errorStr.includes("No user has")) {
        await msg.edit({
          text: "❌ 没有找到指定的用户",
          parseMode: "html",
        });
      } else if (errorStr.includes("Could not find the input entity for")) {
        await msg.edit({
          text: "❌ 无法找到输入的实体",
          parseMode: "html",
        });
      } else if (errorStr.includes("int too big to convert")) {
        await msg.edit({
          text: "❌ 用户ID过长，请检查输入",
          parseMode: "html",
        });
      } else {
        console.error("DC插件获取用户信息失败:", error);
        await msg.edit({
          text: `❌ <b>获取用户信息失败:</b> ${
            errorStr.length > 100
              ? errorStr.substring(0, 100) + "..."
              : errorStr
          }`,
          parseMode: "html",
        });
      }
    }
  } catch (error) {
    console.error("DC插件执行失败:", error);
    await msg.edit({
      text: `❌ <b>DC 查询失败:</b> ${String(error)}`,
      parseMode: "html",
    });
  }
};

class DcPlugin extends Plugin {
  description: string = `获取指定用户或当前群组/频道的 DC`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    dc,
  };
}

export default new DcPlugin();

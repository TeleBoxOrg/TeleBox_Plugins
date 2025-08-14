import { Plugin } from "@utils/pluginBase";
import { NewMessageEvent } from "telegram/events";
import { conversation } from "@utils/conversation";
import { Api } from "telegram";

const botName = "QuotLyBot";

async function quotLyBotStart(event: NewMessageEvent): Promise<void> {
  const client = event.client;
  try {
    await event.client?.sendMessage(botName, { message: "/start" });
  } catch (error: any) {
    if (error.errorMessage === "YOU_BLOCKED_USER") {
      await client?.invoke(
        new Api.contacts.Unblock({
          id: botName,
        })
      );
    }
  }
}

async function quoteMsgs(event: NewMessageEvent): Promise<void> {
  const message = event.message;
  const [, ...args] = message.message.slice(1).split(" ");
  const repliedMessage = await message.getReplyMessage();
  const count = parseInt(args[0]) || 1;
  const msgs = await event.client?.getMessages(message.peerId, {
    limit: count,
    offsetId: repliedMessage!.id - 1,
    reverse: true,
  });

  await conversation(event.client, botName, async (conv) => {
    await event.client?.forwardMessages(botName, {
      fromPeer: message.peerId,
      messages: msgs!.map((msg) => msg.id),
    });
    const response = await conv.getResponse();
    await event.client?.sendMessage(message.peerId, {
      message: response,
      replyTo: repliedMessage?.id,
    });
    await conv.markAsRead();
    await message.delete();
  });
}

const qPlugin: Plugin = {
  command: "q",
  description: `
  .q [count] - 制作语录表情包
    count: 可选，默认为 1，表示消息的数量
  `,
  async commandHandler(event: NewMessageEvent) {
    const message = event.message;
    if (!message.isReply) {
      await message.edit({ text: "请回复一条消息来制作语录表情包" });
      return;
    }

    await quotLyBotStart(event);

    await quoteMsgs(event);
  },
};

export default qPlugin;

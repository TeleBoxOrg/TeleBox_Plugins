import { Plugin } from "@utils/pluginBase";
import { NewMessageEvent } from "telegram/events";
import { conversation } from "@utils/conversation";
import { Api } from "telegram";

const botName = "QuotLyBot";

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

async function handleQutoe(event:NewMessageEvent) {
  try {
    await quoteMsgs(event);
  } catch (error: any) {
    console.log(error);
    await event.message.edit({
      text: `生成语录表情包错误：${error.errorMessage}`
    })
  }
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

    await handleQutoe(event);
  },
};

export default qPlugin;

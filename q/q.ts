import { Plugin } from "@utils/pluginBase";
import { conversation } from "@utils/conversation";
import { Api } from "telegram";

const botName = "QuotLyBot";

async function quoteMsgs(msg: Api.Message): Promise<void> {
  const [, ...args] = msg.message.slice(1).split(" ");
  const repliedMessage = await msg.getReplyMessage();
  const count = parseInt(args[0]) || 1;
  const msgs = await msg.client?.getMessages(msg.peerId, {
    limit: count,
    offsetId: repliedMessage!.id - 1,
    reverse: true,
  });

  await conversation(msg.client, botName, async (conv) => {
    await msg.client?.forwardMessages(botName, {
      fromPeer: msg.peerId,
      messages: msgs!.map((msg) => msg.id),
    });
    const response = await conv.getResponse();
    await msg.client?.sendMessage(msg.peerId, {
      message: response,
      replyTo: repliedMessage?.id,
    });
    await conv.markAsRead();
    await msg.delete();
  });
}

async function handleQutoe(msg: Api.Message): Promise<void> {
  try {
    await quoteMsgs(msg);
  } catch (error) {
    await msg.edit({
      text: `生成语录表情包错误：${error}`,
    });
  }
}

const qPlugin: Plugin = {
  command: "q",
  description:
    ".q [count] - 制作语录表情包, count: 可选，默认为 1, 表示消息的数量",
  cmdHandler: async (msg) => {
    if (!msg.isReply) {
      await msg.edit({ text: "请回复一条消息来制作语录表情包" });
      return;
    }
    await handleQutoe(msg);
  },
};

export default qPlugin;

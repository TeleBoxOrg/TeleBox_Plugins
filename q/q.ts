import { Plugin } from "@utils/pluginBase";
import { conversation } from "@utils/conversation";
import { Api } from "telegram";

const bots = ["QuotLyBot", "PagerMaid_QuotLyBot"];

async function quoteMsgs(msg: Api.Message): Promise<void> {
  const [, ...args] = msg.message.slice(1).split(" ");
  const repliedMessage = await msg.getReplyMessage();
  const count = parseInt(args[0]) || 1;
  const msgs = await msg.client?.getMessages(msg.peerId, {
    limit: count,
    offsetId: repliedMessage!.id - 1,
    reverse: true,
  });

  // 创建一个竞速的 Promise 数组，哪个机器人先响应就用哪个
  const botPromises = bots.map((botName) => 
    new Promise<Api.Message>(async (resolve, reject) => {
      try {
        await conversation(msg.client, botName, async (conv) => {
          await msg.client?.forwardMessages(botName, {
            fromPeer: msg.peerId,
            messages: msgs!.map((msg) => msg.id),
          });
          const response = await conv.getResponse();
          await conv.markAsRead();
          resolve(response); // 第一个成功的会赢得竞速
        });
      } catch (error) {
        reject(`${botName}: ${error}`);
      }
    })
  );

  try {
    // Promise.race 会返回第一个成功的结果
    const response = await Promise.race(botPromises);
    
    await msg.client?.sendMessage(msg.peerId, {
      message: response,
      replyTo: repliedMessage?.id,
    });
    await msg.delete();
  } catch (error) {
    // 如果 Promise.race 失败，说明所有机器人都失败了
    // 尝试收集所有错误信息
    const errors: string[] = [];
    for (let i = 0; i < botPromises.length; i++) {
      try {
        await botPromises[i];
      } catch (err) {
        errors.push(String(err));
      }
    }
    throw new Error(`所有机器人都失败了:\n${errors.join("\n")}`);
  }
}

async function handleQutoe(msg: Api.Message): Promise<void> {
  try {
    await msg.edit({ text: "🔄 正在生成语录表情包..." });
    await quoteMsgs(msg);
  } catch (error) {
    await msg.edit({
      text: `❌ 生成语录表情包错误：${error}`,
    });
  }
}

const q = async (msg: Api.Message) => {
  if (!msg.isReply) {
    await msg.edit({ text: "请回复一条消息来制作语录表情包" });
    return;
  }
  await handleQutoe(msg);
};

class QPlugin extends Plugin {
  description: string = `.q [count] - 制作语录表情包（同时发送给 @QuotLyBot 和 @PagerMaid_QuotLyBot）, count: 可选，默认为 1, 表示消息的数量`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    q,
  };
}

export default new QPlugin();

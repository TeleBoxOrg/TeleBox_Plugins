import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { conversation } from "@utils/conversation";
import { Api } from "teleproto";
import { safeGetMessages, safeGetReplyMessage } from "@utils/safeGetMessages";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


const bots = ["QuotLyBot", "PagerMaid_QuotLyBot"];

async function firstSuccessfulBotResponse(
  promises: Promise<Api.Message>[],
  controllers: AbortController[]
): Promise<Api.Message> {
  return await new Promise<Api.Message>((resolve, reject) => {
    let pending = promises.length;
    const errors: unknown[] = [];

    promises.forEach((promise, index) => {
      promise.then(
        (response) => {
          controllers.forEach((controller) => {
            if (!controller.signal.aborted) {
              controller.abort("Quote bot race resolved");
            }
          });
          resolve(response);
        },
        (error) => {
          errors[index] = error;
          pending -= 1;
          if (pending === 0) {
            reject(errors);
          }
        }
      );
    });
  });
}

async function quoteMsgs(msg: Api.Message): Promise<void> {
  const [, ...args] = msg.message.slice(1).split(" ");
  const repliedMessage = await safeGetReplyMessage(msg);
  const count = parseInt(args[0]) || 1;
  const msgs = await safeGetMessages(msg.client, msg.peerId, {
    limit: count,
    offsetId: repliedMessage!.id - 1,
    reverse: true,
  });

  const controllers = bots.map(() => new AbortController());
  const botPromises = bots.map((botName, index) => 
    (async (): Promise<Api.Message> => {
      try {
        let response: Api.Message | undefined;
        await conversation(
          msg.client,
          botName,
          { signal: controllers[index].signal },
          async (conv) => {
            await msg.client?.forwardMessages(botName, {
              fromPeer: msg.peerId,
              messages: msgs!.map((msg) => msg.id),
            });
            response = await conv.getResponse();
            await conv.markAsRead();
          }
        );
        if (!response) {
          throw new Error(`${botName}: 未收到响应`);
        }
        return response;
      } catch (error) {
        throw new Error(`${botName}: ${error}`);
      }
    })()
  );

  try {
    const response = await firstSuccessfulBotResponse(botPromises, controllers);
    await Promise.allSettled(botPromises);
    
    await msg.client?.sendMessage(msg.peerId, {
      message: response,
      replyTo: repliedMessage?.id,
    });
    await msg.delete();
  } catch (error) {
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
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  description: string = `${mainPrefix}q [count] - 制作语录表情包（同时发送给 @QuotLyBot 和 @PagerMaid_QuotLyBot）, count: 可选，默认为 1, 表示消息的数量`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    q,
  };
}

export default new QPlugin();

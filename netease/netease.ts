import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { TelegramClient } from "telegram";

// 网易云音乐插件 - 直接音频版（类似Python实现）

const NeteaseHelpMsg = `
网易云音乐插件 - 直接音频版

使用方法：
.netease <歌曲名> - 搜索并发送音频

示例：
.netease 晴天

`;

async function searchAndSendMusic(keyword: string, client: TelegramClient, chatId: any): Promise<void> {
  try {
    // 获取bot实体
    const botEntity = await client.getEntity("Music163bot");

    // 启动Music163bot
    await client.sendMessage(botEntity, { message: "/start" });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 发送搜索命令
    await client.sendMessage(botEntity, { message: `/search ${keyword}` });

    // 等待搜索结果
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 获取搜索结果中的第一条消息
    const messages = await client.getMessages(botEntity, { limit: 5 });

    for (const msg of messages) {
      if (msg.text && msg.text.includes(keyword)) {
        // 查找内联键盘按钮
        if (msg.replyMarkup && 'rows' in msg.replyMarkup && msg.replyMarkup.rows) {
          const firstButton = msg.replyMarkup.rows[0]?.buttons[0];
          if (firstButton && 'data' in firstButton && firstButton.data) {
            // 获取bot实体
            const botEntity = await client.getEntity("Music163bot");

            // 点击第一个按钮获取音频
            await client.invoke(
              new Api.messages.GetBotCallbackAnswer({
                peer: botEntity,
                msgId: msg.id,
                data: firstButton.data as Buffer,
              })
            );

            // 等待音频消息
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // 获取音频消息
            const audioMessages = await client.getMessages(botEntity, {
              limit: 3,
            });
            for (const audioMsg of audioMessages) {
              if (audioMsg.media) {
                // 直接发送音频给用户
                await client.sendFile(chatId, {
                  file: audioMsg.media,
                  caption: `🎵 ${keyword} - 网易云音乐`,
                });
                return;
              }
            }
          }
        }
        break;
      }
    }

    // 如果没找到音频，发送提示
    await client.sendMessage(chatId, {
      message: `未找到歌曲 "${keyword}" 的音频文件，请尝试其他关键词`,
    });
  } catch (error) {
    console.error("搜索错误:", error);
    throw error;
  }
}

async function sendMusicById(songId: string, client: TelegramClient, chatId: any): Promise<void> {
  try {
    // 获取bot实体
    const botEntity = await client.getEntity("Music163bot");

    // 启动Music163bot
    await client.sendMessage(botEntity, { message: "/start" });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 直接通过ID获取
    await client.sendMessage(botEntity, { message: `/music ${songId}` });

    // 等待音频消息
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // 获取最新的音频消息
    const messages = await client.getMessages(botEntity, { limit: 3 });

    for (const msg of messages) {
      if (msg.media) {
        // 直接发送音频给用户
        await client.sendFile(chatId, {
          file: msg.media,
          caption: `🎵 歌曲ID: ${songId} - 网易云音乐`,
        });
        return;
      }
    }

    // 如果没找到音频
    await client.sendMessage(chatId, {
      message: `未找到ID ${songId} 的音频文件`,
    });
  } catch (error) {
    console.error("获取歌曲错误:", error);
    throw error;
  }
}

// 解析网易云链接获取ID
function extractSongId(text: string): string | null {
  const idMatch = text.match(/(?:song\?id=|\/song\/)(\d+)/);
  return idMatch ? idMatch[1] : null;
}

const neteasePlugin: Plugin = {
  command: ["netease"],
  description: "网易云音乐 - 直接发送音频",
  cmdHandler: async (msg: Api.Message) => {
    const text = msg.message || "";
    const args = text.split(" ").slice(1).join(" ").trim();

    if (!args) {
      await msg.edit({ text: NeteaseHelpMsg });
      return;
    }

    try {
      await msg.edit({ text: `正在获取音频: ${args}` });
      const client = await getGlobalClient();

      if (/^\d+$/.test(args.trim())) {
        // 纯数字ID
        await sendMusicById(args.trim(), client, msg.peerId);
      } else if (args.includes("music.163.com")) {
        // 网易云链接
        const songId = extractSongId(args);
        if (songId) {
          await sendMusicById(songId, client, msg.peerId);
        } else {
          await client.sendMessage(msg.peerId, {
            message: "无法解析网易云链接中的歌曲ID",
          });
        }
      } else {
        // 歌曲搜索
        await searchAndSendMusic(args, client, msg.peerId);
      }

      await msg.delete();
    } catch (error: any) {
      console.error('Netease plugin error:', error);
      await msg.edit({ 
        text: `获取音频失败: ${error?.message || "未知错误"}`,
        parseMode: "html"
      });
    }
  },
};

export default neteasePlugin;

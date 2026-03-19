import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getPrefixes } from "@utils/pluginManager";
import { sleep } from "teleproto/Helpers";

// 参考 plugins/music_bot.ts 的结构与实现方式

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const bot = "Music163bot"; // 与原实现保持一致（可用 @ 或不带 @）

const pluginName = "netease";
const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
依赖 @Music163bot

<code>${commandName} 关键词</code> 按关键词搜索并返回音频
<code>${commandName} 链接</code> 解析网易云链接并返回音频
<code>${commandName} ID</code> 通过歌曲ID返回音频

示例：
<code>${commandName} 晴天</code>
<code>${commandName} https://music.163.com/#/song?id=123456</code>
<code>${commandName} 123456</code>
`;

function getRemarkFromMsg(msg: Api.Message | string, n: number): string {
  return (typeof msg === "string" ? msg : msg?.message || "")
    .replace(new RegExp(`^\\S+${Array(n).fill("\\s+\\S+").join("")}`), "")
    .trim();
}

// 解析网易云链接获取ID
function extractSongId(text: string): string | null {
  const idMatch = text.match(/(?:song\?id=|\/song\/)(\d+)/);
  return idMatch ? idMatch[1] : null;
}

async function ensureBotReady(msg: Api.Message) {
  const client = msg.client!;
  // 解除拉黑，静音通知
  try {
    await client.invoke(new Api.contacts.Unblock({ id: bot }));
  } catch {}

  try {
    const inputPeer = await client.getInputEntity(bot);
    await client.invoke(
      new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer: inputPeer }),
        settings: new Api.InputPeerNotifySettings({
          silent: true,
          muteUntil: 2147483647,
        }),
      })
    );
  } catch {}

  // 启动 bot（首次使用）
  try {
    await msg.client?.invoke(
      new Api.messages.StartBot({ bot, peer: bot, startParam: "" })
    );
  } catch {
    try {
      await msg.client?.sendMessage(bot, { message: "/start" });
    } catch {}
  }
}

async function fetchAndSendAudio(
  msg: Api.Message,
  commandToBot: string,
  caption: string
) {
  const client = msg.client!;
  const startTs = Math.floor(Date.now() / 1000);

  // 发送命令
  try {
    await client.sendMessage(bot, { message: commandToBot });
  } catch {
    try {
      // 回退：有些 bot 可能只接收文本
      await client.sendMessage(bot, {
        message: commandToBot.replace(/^\/(?:search|music)\s+/, ""),
      });
    } catch {}
  }

  // 轮询新消息：优先寻找按钮消息，其次直接媒体消息
  let replyWithButtons: any | undefined;
  let mediaMsg: any | undefined;
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const msgs = await client.getMessages(bot, { limit: 6 });
    for (const m of msgs.slice().reverse()) {
      if (!m.out && (m.date || 0) >= startTs) {
        if (!mediaMsg && m.media) mediaMsg = m;
        if (!replyWithButtons && (m.buttonCount || 0) > 0) replyWithButtons = m;
      }
    }
    if (mediaMsg || replyWithButtons) break;
  }

  // 若有按钮则点击第一个按钮
  if (!mediaMsg && replyWithButtons) {
    try {
      await replyWithButtons.click({});
    } catch (e) {
      await msg.edit({ text: `❌ 点击按钮失败：${(e as any)?.message || e}` });
      return;
    }

    // 点击后继续等待媒体
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      const msgs = await client.getMessages(bot, { limit: 6 });
      for (const m of msgs.slice().reverse()) {
        if (
          !m.out &&
          m.media &&
          (m.date || 0) >= (replyWithButtons.date || startTs)
        ) {
          mediaMsg = m;
          break;
        }
      }
      if (mediaMsg) break;
    }
  }

  if (!mediaMsg || !mediaMsg.media) {
    await msg.edit({ text: `❌ 未获取到音乐文件。` });
    return;
  }

  // 以纯上传形式回传
  await client.sendFile(msg.peerId, {
    file: mediaMsg.media,
    caption,
    replyTo: msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId,
  });
}

class NeteasePlugin extends Plugin {
  description: string = `\nnetease\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    netease: async (msg: Api.Message) => {
      const keyword = getRemarkFromMsg(msg, 0);

      if (!keyword) {
        await msg.edit({ text: help_text, parseMode: "html" });
        return;
      }

      const client = msg.client;
      if (!client) return;

      try {
        await msg.edit({
          text: `🔎 处理中：<code>${keyword}</code>`,
          parseMode: "html",
        });
      } catch {}

      await ensureBotReady(msg);

      // 判定命令：ID -> /music，链接 -> 解析ID -> /music，否则 /search
      let commandToBot = `/search ${keyword}`;
      if (/^\d+$/.test(keyword.trim())) {
        commandToBot = `/music ${keyword.trim()}`;
      } else if (keyword.includes("music.163.com")) {
        const id = extractSongId(keyword);
        if (id) commandToBot = `/music ${id}`;
      }

      const caption = `🎵 ${keyword}`;
      await fetchAndSendAudio(msg, commandToBot, caption);

      try {
        await msg.delete();
      } catch {}
    },
  };
}

export default new NeteasePlugin();

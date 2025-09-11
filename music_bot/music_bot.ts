import axios from "axios";
import _ from "lodash";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { sleep } from "telegram/Helpers";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const bots = {
  default: "@music_v1bot",
  vk: "@vkmusic_bot",
  ym: "@LyBot",
};

const pluginName = "music_bot";

const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
依赖 ${Object.values(bots).join(", ")}

<code>${mainPrefix}mbvk 关键词</code>, <code>${commandName} vk 关键词</code> 使用 ${
  bots.vk
} 音乐源搜索

<code>${mainPrefix}mbym 关键词</code>, <code>${commandName} ym 关键词</code> 用 YouTube Music 源搜索

<code>${mainPrefix}mbs 关键词</code>, <code>${commandName} search 关键词</code> 使用 ${
  bots.default
} 搜索音乐，关键词中包含搜索源会自动识别 例如：<code>search 洛天依 网易云</code>
<code>${mainPrefix}mbkg 关键词</code>, <code>${commandName} kugou 关键词</code> 用酷狗源搜索
<code>${mainPrefix}mbkw 关键词</code>, <code>${commandName} kuwo 关键词</code> 用酷我源搜索
<code>${mainPrefix}mbqq 关键词</code>, <code>${commandName} qq 关键词</code> 用 QQ 音乐源搜索
<code>${mainPrefix}mbne 关键词</code>, <code>${commandName} netease 关键词</code> 用网易云音乐源搜索

`;

async function searchAndSendMusic(
  msg: Api.Message,
  action: string,
  keyword: string,
  bot: string
) {
  if (
    !["search", "kugou", "kuwo", "qq", "netease", "vk", "ym"].includes(
      action
    ) ||
    !keyword
  ) {
    await msg.edit({ text: help_text, parseMode: "html" });
    return;
  }

  const client = msg.client;
  if (!client) return;

  // Give quick feedback
  try {
    await msg.edit({
      text: `🔎 搜索中：<code>${keyword}</code>`,
      parseMode: "html",
    });
  } catch {}

  // Ensure bot is unblocked and muted
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
          muteUntil: 2147483647, // mute for a long time
        }),
      })
    );
  } catch {}

  // Try to start the bot (if never used before)
  try {
    await client.invoke(
      new Api.messages.StartBot({
        bot,
        peer: bot,
        startParam: "",
      })
    );
  } catch {
    try {
      await client.sendMessage(bot, { message: "/start" });
    } catch {}
  }

  // Send search command
  const startTs = Math.floor(Date.now() / 1000);
  try {
    await client.sendMessage(bot, {
      message: ["vk", "ym"].includes(action)
        ? keyword
        : `/${action} ${keyword}`,
    });
  } catch {
    // fallback: in case the bot only accepts plain text
    try {
      await client.sendMessage(bot, { message: keyword });
    } catch {}
  }

  // Wait for bot's reply that contains buttons, then click first
  let replyWithButtons: any | undefined;
  for (let i = 0; i < 15; i++) {
    await sleep(700);
    const msgs = await client.getMessages(bot, { limit: 1 });
    for (const m of msgs.slice().reverse()) {
      if (!m.out && (m.date || 0) >= startTs && (m.buttonCount || 0) > 0) {
        replyWithButtons = m;
        break;
      }
    }
    if (replyWithButtons) break;
  }

  if (!replyWithButtons) {
    await msg.edit({ text: `❌ 未找到可点击的结果按钮。` });
    return;
  }

  try {
    // 默认点击第一个按钮
    await replyWithButtons.click({});
  } catch (e) {
    await msg.edit({
      text: `❌ 点击按钮失败：${(e as any)?.message || e}`,
    });
    return;
  }

  // After clicking, wait for the next incoming message with media
  let mediaMsg: any | undefined;
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const msgs = await client.getMessages(bot, { limit: 6 });
    for (const m of msgs.slice().reverse()) {
      if (
        !m.out &&
        (m.date || 0) >= (replyWithButtons.date || startTs) &&
        m.media
      ) {
        mediaMsg = m;
        break;
      }
    }
    if (mediaMsg) break;
  }

  if (!mediaMsg || !mediaMsg.media) {
    await msg.edit({ text: `❌ 未获取到音乐文件。` });
    return;
  }

  // Send the media back to the user without forwarding
  await client.sendFile(msg.peerId, {
    file: mediaMsg.media,
    caption: `🎵 ${keyword}`,
    replyTo: msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId,
  });

  try {
    await msg.delete();
  } catch {}
}

function getRemarkFromMsg(msg: Api.Message | string, n: number): string {
  return (typeof msg === "string" ? msg : msg?.message || "")
    .replace(new RegExp(`^\\S+${Array(n).fill("\\s+\\S+").join("")}`), "")
    .trim();
}

class MusicBotPlugin extends Plugin {
  description: string = `\n多音源音乐搜索\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    music_bot: async (msg: Api.Message, trigger?: Api.Message) => {
      const text = msg.message || "";
      const parts = text.trim().split(/\s+/);
      const action = parts[1] || "";
      const keyword = getRemarkFromMsg(msg, 1);
      await searchAndSendMusic(msg, action, keyword, bots.default);
    },
    mbs: async (msg: Api.Message, trigger?: Api.Message) => {
      const action = "search";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.default);
    },
    mbkw: async (msg: Api.Message, trigger?: Api.Message) => {
      const action = "kuwo";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.default);
    },
    mbkg: async (msg: Api.Message, trigger?: Api.Message) => {
      const action = "kugou";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.default);
    },
    mbqq: async (msg: Api.Message, trigger?: Api.Message) => {
      const action = "qq";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.default);
    },
    mbne: async (msg: Api.Message, trigger?: Api.Message) => {
      const action = "netease";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.default);
    },
    mbvk: async (msg: Api.Message, trigger?: Api.Message) => {
      const action = "vk";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.vk);
    },
    mbym: async (msg: Api.Message, trigger?: Api.Message) => {
      const action = "ym";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.ym);
    },
  };
}

export default new MusicBotPlugin();

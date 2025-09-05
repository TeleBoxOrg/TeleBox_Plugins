import { Plugin } from "@utils/pluginBase";
import path from "path";
import Database from "better-sqlite3";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getEntityWithHash } from "@utils/entityHelpers";
import { Api } from "telegram/tl";
import { TelegramClient } from "telegram";

// Initialize database
let db = new Database(
  path.join(createDirectoryInAssets("lottery"), "lottery.db")
);

// Initialize database table
if (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lottery_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

// HTML escape function
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Database helper functions
function getState() {
  if (!db)
    return {
      start: false,
      chat_id: 0,
      num: 0,
      win: 0,
      title: "",
      keyword: "",
    };

  const getStmt = db.prepare("SELECT value FROM lottery_state WHERE key = ?");

  const getStateValue = (key: string, defaultValue: string): string => {
    const result = getStmt.get(key) as { value: string } | undefined;
    return result?.value || defaultValue;
  };

  return {
    start: JSON.parse(getStateValue("lottery.start", "false")),
    chat_id: parseInt(getStateValue("lottery.chat_id", "0")),
    num: parseInt(getStateValue("lottery.num", "0")),
    win: parseInt(getStateValue("lottery.win", "0")),
    title: getStateValue("lottery.title", ""),
    keyword: getStateValue("lottery.keyword", ""),
  };
}

function getParticipants(): number[] {
  if (!db) return [];

  const getStmt = db.prepare("SELECT value FROM lottery_state WHERE key = ?");
  const result = getStmt.get("lottery.participants") as
    | { value: string }
    | undefined;

  try {
    return JSON.parse(result?.value || "[]");
  } catch {
    return [];
  }
}

function addParticipant(userId: number): number {
  if (!db) return 0;

  const participants = getParticipants();
  if (!participants.includes(userId)) {
    participants.push(userId);
    const setStmt = db.prepare(
      "INSERT OR REPLACE INTO lottery_state (key, value) VALUES (?, ?)"
    );
    setStmt.run("lottery.participants", JSON.stringify(participants));
  }
  return participants.length;
}

function isParticipant(userId: number): boolean {
  return getParticipants().includes(userId);
}

function clearLotteryData(): void {
  if (!db) return;

  const keys = [
    "lottery.start",
    "lottery.participants",
    "lottery.chat_id",
    "lottery.num",
    "lottery.win",
    "lottery.title",
    "lottery.keyword",
  ];

  const deleteStmt = db.prepare("DELETE FROM lottery_state WHERE key = ?");
  for (const key of keys) {
    deleteStmt.run(key);
  }
}

function setState(key: string, value: any): void {
  if (!db) return;

  const setStmt = db.prepare(
    "INSERT OR REPLACE INTO lottery_state (key, value) VALUES (?, ?)"
  );
  setStmt.run(key, typeof value === "string" ? value : JSON.stringify(value));
}

// Format user line for display
function formatUserLine(uid: number, userObj?: any): string {
  // 第一优先级：用户名（纯文本，不用超链接）
  if (userObj && userObj.username) {
    return `• @${userObj.username}`;
  }

  // 第二优先级：昵称+超链接
  let displayName = "";
  if (userObj) {
    if (userObj.firstName && userObj.lastName) {
      displayName = `${userObj.firstName} ${userObj.lastName}`;
    } else if (userObj.firstName) {
      displayName = userObj.firstName;
    } else if (userObj.lastName) {
      displayName = userObj.lastName;
    }
  }

  // 如果有昵称，使用昵称+超链接
  if (displayName) {
    return `• <a href="tg://user?id=${uid}">${htmlEscape(displayName)}</a>`;
  }

  // 兜底：纯ID
  return `• ${uid}`;
}

// Core lottery logic
async function lotteryEnd(client: TelegramClient): Promise<void> {
  const state = getState();
  if (!state.chat_id) {
    return;
  }

  // 防止并发多次开奖
  if (!state.start) {
    return;
  }
  setState("lottery.start", false);

  const allUsers = getParticipants();
  const eligibleUsers = allUsers.slice(0, state.num);

  const winUsers: number[] = [];
  const winUserNum = Math.min(state.win, eligibleUsers.length);

  if (eligibleUsers.length > 0 && winUserNum > 0) {
    // 使用 crypto.getRandomValues 替代 Python 的 secrets
    const shuffled = [...eligibleUsers];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    winUsers.push(...shuffled.slice(0, winUserNum));
  }

  let endText = "";

  if (winUsers.length > 0) {
    const winLines: string[] = [];
    const infoMap: { [key: number]: any } = {};

    // 使用 entityHelpers 获取完整用户信息
    for (const uid of winUsers) {
      try {
        const userEntity = await getEntityWithHash(client, uid);
        if (userEntity && "id" in userEntity) {
          // 获取完整用户信息
          const fullInfo = await client.invoke(
            new Api.users.GetFullUser({
              id: userEntity,
            })
          );
          infoMap[uid] = fullInfo.users[0];
        }
      } catch (error) {
        console.warn(`Failed to get user info for ${uid}:`, error);
      }
    }

    for (const uid of winUsers) {
      winLines.push(formatUserLine(uid, infoMap[uid]));
    }
    const winUsersText = winLines.join("\n");

    endText =
      `🎊 <b>开奖结果</b>\n\n` +
      `🏆 <b>活动名称:</b> ${htmlEscape(state.title)}\n` +
      `🎁 <b>中奖用户:</b>\n\n` +
      `${winUsersText}\n\n` +
      `🎉 <b>恭喜以上用户中奖!</b>\n` +
      `📞 请私聊活动发起者领取奖品\n` +
      `🙏 感谢所有用户的参与!`;
  } else {
    endText =
      `🎊 <b>开奖结果</b>\n\n` +
      `🏆 <b>活动名称:</b> ${htmlEscape(state.title)}\n\n` +
      `😅 <b>很遗憾，本次抽奖没有用户中奖</b>\n` +
      `🙏 感谢大家的参与!`;
  }

  try {
    await client.sendMessage(state.chat_id, {
      message: endText,
      parseMode: "html",
    });
  } catch (error) {
    console.error("Failed to send lottery result:", error);
  }

  clearLotteryData();
}

// Create lottery function
async function createLottery(
  client: TelegramClient,
  chatId: number,
  num: number,
  win: number,
  title: string,
  keyword: string
): Promise<void> {
  if (getState().start) {
    throw new Error("当前已有正在进行的抽奖活动。");
  }

  clearLotteryData();

  setState("lottery.start", true);
  setState("lottery.chat_id", chatId);
  setState("lottery.num", num);
  setState("lottery.win", win);
  setState("lottery.title", title);
  setState("lottery.keyword", keyword);
  setState("lottery.participants", "[]");

  const createText =
    `🎉 <b>抽奖活动已创建</b>\n\n` +
    `🏆 <b>活动名称:</b> ${htmlEscape(title)}\n` +
    `🎁 <b>奖品数量:</b> <b>${win}</b> 个\n` +
    `👥 <b>开奖条件:</b> 达到 <b>${num}</b> 人参与\n\n` +
    `🔑 <b>参与方式:</b>\n` +
    `发送关键词 <code>${htmlEscape(keyword)}</code> 即可参与\n\n` +
    `💡 <b>提示:</b> 创建者本人也可以参与抽奖`;

  const msg = await client.sendMessage(chatId, {
    message: createText,
    parseMode: "html",
  });

  try {
    await client.pinMessage(chatId, msg.id, { notify: false });
  } catch (error) {
    console.warn("Failed to pin lottery message:", error);
  }
}

// Message listener for lottery participation
async function handleLotteryJoin(msg: any): Promise<void> {
  const state = getState();
  if (!state.start || !msg.message || !msg.senderId) {
    return;
  }

  // 获取聊天ID
  let chatId: number;
  try {
    if (msg.chat?.id) {
      chatId = Number(msg.chat.id);
    } else if (msg.peerId) {
      chatId = Number(msg.peerId.toString());
    } else if (msg.chatId) {
      chatId = Number(msg.chatId.toString());
    } else {
      return;
    }
  } catch {
    return;
  }

  // 仅匹配纯口令文本
  if (chatId !== state.chat_id || msg.message.trim() !== state.keyword) {
    return;
  }

  // 检查发送者
  const sender = await msg.getSender();
  if (!sender || sender.bot) {
    return;
  }

  // 延迟删除函数
  const deleteAfter = async (msgObj: any, seconds: number) => {
    try {
      setTimeout(async () => {
        try {
          await msgObj.delete();
        } catch (error) {
          console.warn("Failed to delete message:", error);
        }
      }, seconds * 1000);
    } catch (error) {
      console.warn("Failed to schedule message deletion:", error);
    }
  };

  if (isParticipant(sender.id)) {
    deleteAfter(msg, 3);
    return;
  }

  const currentParticipantsCount = addParticipant(sender.id);

  const joinText =
    `✅ <b>参与成功</b>\n\n` +
    `🎯 <b>活动:</b> ${htmlEscape(state.title)}\n` +
    `🎁 <b>奖品数量:</b> <b>${state.win}</b> 个\n` +
    `👥 <b>开奖条件:</b> <b>${state.num}</b> 人参与\n` +
    `📊 <b>当前进度:</b> <b>${currentParticipantsCount}</b>/<b>${state.num}</b> 人\n\n` +
    `🍀 <b>祝你好运!</b>`;

  try {
    const replyMsg = await msg.reply({
      message: joinText,
      parseMode: "html",
    });
    deleteAfter(replyMsg, 3);
    deleteAfter(msg, 3);
  } catch (error) {
    console.warn("Failed to send join confirmation:", error);
  }

  if (currentParticipantsCount >= state.num) {
    if (msg.client) {
      await lotteryEnd(msg.client);
    }
  }
}

const lotteryHelpMsg = `🎲 <b>抽奖插件使用说明</b>

📝 <b>创建抽奖:</b>
<code>lottery [奖品数]/[总人数] [关键词] [抽奖标题]</code>

💡 <b>示例:</b>
<code>lottery 3/50 抽奖 iPhone15抽奖活动</code>

⚡ <b>强制开奖:</b>
<code>lottery 强制开奖</code>

ℹ️ <b>说明:</b> 用户发送关键词即可参与，达到人数自动开奖`;

const lottery = async (msg: Api.Message) => {
  try {
    const args = msg.message.slice(1).split(" ").slice(1); // Remove command part
    const argsStr = args.join(" ");

    if (!argsStr) {
      await msg.edit({
        text: lotteryHelpMsg,
        parseMode: "html",
        linkPreview: false,
      });
      return;
    }

    if (argsStr === "强制开奖") {
      if (!getState().start) {
        await msg.edit({
          text:
            `❌ <b>无法强制开奖</b>\n\n` +
            `📋 <b>原因:</b> 当前没有正在进行的抽奖活动\n\n` +
            `💡 <b>提示:</b> 请先使用 <code>lottery</code> 创建抽奖`,
          parseMode: "html",
        });
        return;
      }

      await msg.edit({
        text: `⚡ <b>强制开奖中...</b>\n\n` + `🎯 正在抽取中奖用户，请稍候...`,
        parseMode: "html",
      });

      // 获取聊天ID
      let chatId: number;
      try {
        if (msg.chat?.id) {
          chatId = Number(msg.chat.id);
        } else if (msg.peerId) {
          chatId = Number(msg.peerId.toString());
        } else if (msg.chatId) {
          chatId = Number(msg.chatId.toString());
        } else {
          chatId = 0;
        }
      } catch {
        chatId = 0;
      }

      if (msg.client) {
        await lotteryEnd(msg.client);
      }
      return;
    }

    if (args.length < 3) {
      await msg.edit({
        text:
          `❌ <b>参数不足</b>\n\n` +
          `📋 <b>正确格式:</b>\n` +
          `<code>lottery [奖品数]/[总人数] [关键词] [标题]</code>\n\n` +
          `💡 <b>示例:</b>\n` +
          `<code>lottery 1/10 抽奖 新年红包</code>`,
        parseMode: "html",
      });
      return;
    }

    const numList = args[0].split("/");
    if (numList.length !== 2) {
      await msg.edit({
        text:
          `❌ <b>人数格式错误</b>\n\n` +
          `📋 <b>正确格式:</b> <code>[奖品数]/[总人数]</code>\n\n` +
          `💡 <b>示例:</b>\n` +
          `• <code>1/10</code> - 1个奖品，10人参与\n` +
          `• <code>3/50</code> - 3个奖品，50人参与`,
        parseMode: "html",
      });
      return;
    }

    let win: number, num: number;
    try {
      win = parseInt(numList[0]);
      num = parseInt(numList[1]);
      if (win > num || win < 1 || num < 1) {
        await msg.edit({
          text:
            `❌ <b>参数无效</b>\n\n` +
            `📋 <b>规则:</b>\n` +
            `• 奖品数必须 ≤ 总人数\n` +
            `• 奖品数和总人数都必须 ≥ 1\n\n` +
            `💡 <b>示例:</b> <code>3/50</code> 表示50人中抽3个`,
          parseMode: "html",
        });
        return;
      }
    } catch {
      await msg.edit({
        text:
          `❌ <b>数字格式错误</b>\n\n` +
          `📋 <b>要求:</b> 奖品数和总人数必须是整数\n\n` +
          `💡 <b>正确示例:</b>\n` +
          `• <code>1/10</code> ✅\n` +
          `• <code>abc/10</code> ❌`,
        parseMode: "html",
      });
      return;
    }

    const keyword = args[1];
    const title = args.slice(2).join(" ");

    // 获取聊天ID
    let chatId: number;
    try {
      if (msg.chat?.id) {
        chatId = Number(msg.chat.id);
      } else if (msg.peerId) {
        chatId = Number(msg.peerId.toString());
      } else if (msg.chatId) {
        chatId = Number(msg.chatId.toString());
      } else {
        throw new Error("无法获取聊天ID");
      }
    } catch (error) {
      await msg.edit({
        text: `❌ 无法获取聊天ID，请重试。`,
      });
      return;
    }

    try {
      if (!msg.client) {
        await msg.edit({
          text: `❌ 客户端不可用，请重试。`,
        });
        return;
      }
      await createLottery(msg.client, chatId, num, win, title, keyword);
      await msg.delete();
    } catch (error: any) {
      if (error.message.includes("当前已有正在进行的抽奖活动")) {
        await msg.edit({
          text:
            `❌ <b>创建失败</b>\n\n` +
            `📋 <b>原因:</b> ${htmlEscape(error.message)}\n\n` +
            `💡 <b>解决方案:</b> 请先使用 <code>lottery 强制开奖</code> 结束当前抽奖`,
          parseMode: "html",
        });
      } else {
        await msg.edit({
          text:
            `❌ <b>创建抽奖时发生错误</b>\n\n` +
            `🔍 <b>错误详情:</b> ${htmlEscape(error.message || error)}\n\n` +
            `💡 <b>建议:</b> 请检查参数格式是否正确`,
          parseMode: "html",
        });
      }
    }
  } catch (error: any) {
    console.error("Lottery plugin error:", error);
    await msg.edit({
      text: `❌ 操作失败：${error.message || error}`,
    });
  }
};

class LotteryPlugin extends Plugin {
  description: string = `
抽奖插件：
- lottery [奖品数]/[总人数] [关键词] [标题] - 创建抽奖活动
- lottery 强制开奖 - 强制结束当前抽奖
- lottery - 显示帮助信息

示例：lottery 3/50 抽奖 iPhone15抽奖活动
用户发送关键词即可参与，达到人数自动开奖
  `;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    lottery,
  };
  listenMessageHandler?: ((msg: Api.Message) => Promise<void>) | undefined =
    handleLotteryJoin;
}

export default new LotteryPlugin();

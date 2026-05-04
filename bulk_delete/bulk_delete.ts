import { Api } from "teleproto";
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import path from "path";
import { safeGetMessages } from "@utils/safeGetMessages";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


// 数据库文件路径
const filePath = path.join(createDirectoryInAssets("bd"), "bd_config.json");

// 数据库类型定义
interface BdDB {
  userDeleteMode: Record<string, boolean>;
}

// 获取数据库实例
async function getDB() {
  const db = await JSONFilePreset<BdDB>(filePath, { userDeleteMode: {} });
  return db;
}

// 获取用户删除模式设置
async function getUserDeleteMode(userId: string): Promise<boolean> {
  try {
    const db = await getDB();
    return db.data.userDeleteMode[userId] !== false;
  } catch (error) {
    console.warn("获取bd用户设置失败:", error);
    return true; // 默认开启删除他人权限
  }
}

// 保存用户设置到数据库
async function saveUserSetting(userId: string, canDeleteOthers: boolean) {
  try {
    const db = await getDB();
    db.data.userDeleteMode[userId] = canDeleteOthers;
    await db.write();
  } catch (error) {
    console.warn("保存bd用户设置失败:", error);
  }
}

/**
 * 批量向下删除插件
 * 1. 回复一条消息并输入 .bd 来删除从该消息到当前指令之间的所有消息。
 * 2. 输入 .bd <数字> 来删除自己最近的 <数字> 条消息 (最多99条)。
 * 3. 输入 .bd on/off 来切换删除他人消息的权限。
 */
const bd = async (msg: Api.Message) => {
  const client = (msg as any).client;
  if (!client) return;

  const chatId = msg.chatId;
  const me = await client.getMe();
  const userId = me.id.toString();

  // --- 处理开关命令 ---
  const args = msg.message?.split(" ") || [];
  const subCommand = args[1]?.toLowerCase();

  if (subCommand === "on" || subCommand === "off") {
    const canDeleteOthers = subCommand === "on";
    // 持久化保存设置
    await saveUserSetting(userId, canDeleteOthers);
    const status = canDeleteOthers ? "开启" : "关闭";
    const feedbackMsg = await client.sendMessage(chatId, {
      message: `✅ 已${status}删除他人消息权限。`,
    });
    setTimeout(async () => {
      await client.deleteMessages(chatId, [feedbackMsg.id, msg.id], {
        revoke: true,
      });
    }, 2000);
    return;
  }

  // --- 1. 处理非回复消息的情况 ---
  if (!msg.replyTo) {
    const numArgStr = args[1] || "";
    const numArg = parseInt(numArgStr, 10);

    // A. 如果是 .bd <数字>
    if (!isNaN(numArg) && numArg > 0 && numArg <= 99) {
      const messagesToDelete: number[] = [msg.id]; // 包含指令本身
      let count = 0;

      // 获取最近的消息
      const recentMessages = await safeGetMessages(client, chatId, { limit: 100 });
      const filteredMessages = recentMessages.filter((m: Api.Message) => {
        return m.senderId?.equals(me.id) && m.id !== msg.id;
      });

      for (let i = 0; i < Math.min(numArg, filteredMessages.length); i++) {
        messagesToDelete.push(filteredMessages[i].id);
        count++;
      }

      // 执行删除
      if (count > 0) {
        await client.deleteMessages(chatId, messagesToDelete, {
          revoke: true,
        });

        // 修正: 提示语固定为“您最近的”，因为此模式下只删除自己的消息。
        const feedbackMsg = await client.sendMessage(chatId, {
          message: `✅ 成功删除您最近的 ${count} 条消息。`,
        });
        // ======================= 代码修正部分 END =========================
        
        // 2秒后删除反馈消息
        setTimeout(async () => {
          await client.deleteMessages(chatId, [feedbackMsg.id], {
            revoke: true,
          });
        }, 2000);
      } else {
        // 如果没找到可删除的消息，只删除指令本身
        await client.deleteMessages(chatId, [msg.id], { revoke: true });
      }
      return;
    }

    // B. 如果只是 .bd
    const currentMode = (await getUserDeleteMode(userId)) ? "开启" : "关闭";
    const sentMsg = await client.sendMessage(chatId, {
      message: `⚠️ 请回复一条消息以确定删除范围，或使用 \`.bd <数字>\` 删除您最近的消息。\n💡 当前删除他人权限: ${currentMode} (.bd on/off 切换)`,
    });
    // 3秒后删除提示和指令消息
    setTimeout(async () => {
      await client.deleteMessages(chatId, [sentMsg.id, msg.id], {
        revoke: true,
      });
    }, 3000);
    return;
  }

  // --- 2. 处理回复消息的情况
  const startMessage = await safeGetMessages(client, chatId, {
    ids: [msg.replyTo.replyToMsgId],
  });
  const startMsg = startMessage[0];
  if (!startMsg) return;

  const startId = startMsg.id;
  const endId = msg.id;

  let isAdmin = false;
  let canDeleteOthers = await getUserDeleteMode(userId);

  try {
    const chat = await client.getEntity(chatId);
    if (chat && (chat.className === "Channel" || chat.className === "Chat")) {
      try {
        const participant = await client.invoke(
          new Api.channels.GetParticipant({
            channel: chatId,
            participant: me.id,
          })
        );

        if (participant && participant.participant) {
          const p = participant.participant;
          if (
            p.className === "ChannelParticipantCreator" ||
            (p.className === "ChannelParticipantAdmin" &&
              p.adminRights?.deleteMessages)
          ) {
            isAdmin = true;
          }
        }
      } catch (e) {
        // 忽略权限检查错误
      }
    } else {
      isAdmin = true; // 私聊中视为管理员
    }
  } catch (e) {
    console.warn("无法获取权限信息，可能是在私聊中:", e);
  }

  // 结合用户设置的删除权限与实际管理员权限
  const finalCanDeleteOthers = canDeleteOthers && isAdmin;

  const messagesToDelete: number[] = [];
  let successfullyCollected = 0;

  try {
    const messages = await safeGetMessages(client, chatId, {
      minId: startId - 1,
      maxId: endId + 1,
      limit: 100, // 注意: Telegram限制单次最多获取100条
    });

    for (const message of messages) {
      if (message.id >= startId && message.id <= endId) {
        if (
          finalCanDeleteOthers ||
          (message.senderId && message.senderId?.equals(me.id))
        ) {
          messagesToDelete.push(message.id);
          if (message.id !== endId) {
            successfullyCollected++;
          }
        }
      }
    }
  } catch (err) {
    console.error("收集消息时出错:", err);
    const sentMsg = await client.sendMessage(chatId, {
      message: "❌ 收集消息列表时出错。",
    });
    setTimeout(async () => {
      await client.deleteMessages(chatId, [sentMsg.id, msg.id], {
        revoke: true,
      });
    }, 3000);
    return;
  }

  if (successfullyCollected > 0) {
    if (messagesToDelete.length > 0) {
      await client.deleteMessages(chatId, messagesToDelete, { revoke: true });
    }
  } else {
    // 如果一条可删除的消息都没收集到
    const modeStatus = canDeleteOthers
      ? ""
      : "\n💡 当前处于'仅删除自己消息'模式，使用 .bd on 开启删除他人权限";
    const feedbackMsg = await client.sendMessage(chatId, {
      message: `🚫 您没有删除该范围内消息的权限。${modeStatus}`,
      replyTo: startMsg,
    });
    setTimeout(async () => {
      await client.deleteMessages(chatId, [feedbackMsg.id, msg.id], {
        revoke: true,
      });
    }, 3000);
  }
};

class BulkDeletePlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  description: string = `回复消息并使用 ${mainPrefix}bd, 删除从被回复的消息到当前指令之间的所有消息。或使用 ${mainPrefix}bd ＜数字＞ 删除您最近的消息。使用 ${mainPrefix}bd on/off 切换删除他人消息的权限。`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    bd,
  };
}

export default new BulkDeletePlugin();

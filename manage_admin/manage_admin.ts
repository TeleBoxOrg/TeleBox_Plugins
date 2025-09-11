import axios from "axios";
import _ from "lodash";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { sleep } from "telegram/Helpers";
import { getGlobalClient } from "@utils/globalClient";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "manage_admin";

const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
使用 <code>${commandName} add [头衔]</code> 回复一条消息, <code>${commandName} add 用户ID/用户名 [头衔]</code> 提升用户为管理员(若之前不是)并设置/更新/清空头衔(可选), 权限默认只有 ban
使用 <code>${commandName} rm/remove</code> 回复一条消息, <code>${commandName} rm/remove 用户ID/用户名</code> 将用户移除管理员
<code>${commandName} ls/list</code> 查看当前对话所有管理员
`;
async function formatEntity(
  target: any,
  mention?: boolean,
  throwErrorIfFailed?: boolean
) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");
  if (!target) throw new Error("无效的目标");
  let id: any;
  let entity: any;
  try {
    entity = target?.className
      ? target
      : ((await client?.getEntity(target)) as any);
    if (!entity) throw new Error("无法获取 entity");
    id = entity.id;
    if (!id) throw new Error("无法获取 entity id");
  } catch (e: any) {
    console.error(e);
    if (throwErrorIfFailed)
      throw new Error(
        `无法获取 ${target} 的 entity: ${e?.message || "未知错误"}`
      );
  }
  const displayParts: string[] = [];

  if (entity?.title) displayParts.push(entity.title);
  if (entity?.firstName) displayParts.push(entity.firstName);
  if (entity?.lastName) displayParts.push(entity.lastName);
  if (entity?.username)
    displayParts.push(
      mention ? `@${entity.username}` : `<code>@${entity.username}</code>`
    );

  if (id) {
    displayParts.push(
      entity instanceof Api.User
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`
    );
  } else if (!target?.className) {
    displayParts.push(`<code>${target}</code>`);
  }

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}
function getTxtFromMsg(msg: Api.Message | string, n: number): string {
  return (typeof msg === "string" ? msg : msg?.message || "")
    .replace(new RegExp(`^\\S+${Array(n).fill("\\s+\\S+").join("")}`), "")
    .trim();
}
class ManageAdminPlugin extends Plugin {
  description: string = `\n管理管理员\n\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    manage_admin: async (msg: Api.Message, trigger?: Api.Message) => {
      const parts = msg.message.trim().split(/\s+/);
      const sub = (parts[1] || "").toLowerCase();

      const isInGroup = (msg as any).isGroup || (msg as any).isChannel;
      if (!isInGroup) {
        await msg.edit({
          text: `请在群组/频道对话中使用 <code>${commandName}</code> 命令`,
          parseMode: "html",
        });
        return;
      }

      const channel = await msg.getInputChat();
      const chatEntity = await msg.getChat();
      if (!channel || !chatEntity) {
        await msg.edit({ text: "无法获取当前对话实体" });
        return;
      }

      async function resolveUserFromReplyOrArg(arg?: string) {
        const client = await getGlobalClient();
        if (msg.isReply) {
          const r = await msg.getReplyMessage();
          if (!r) return { id: undefined as any, entity: undefined as any };
          // Prefer real sender entity and ensure it's a user
          let sender: any;
          try {
            sender = await (r as any).getSender?.();
          } catch {}
          if (!(sender instanceof Api.User)) {
            // Fallback to fromId user only
            const fromId: any = r.fromId as any;
            const uid = Number(fromId?.userId);
            if (uid && client) {
              try {
                const input = await client.getInputEntity(uid);
                const full = await client.getEntity(input);
                if (full instanceof Api.User) {
                  return { id: Number(full.id), entity: input };
                }
              } catch {}
            }
            return { id: undefined as any, entity: undefined as any };
          }
          const input = await client?.getInputEntity(sender.id);
          return { id: Number(sender.id), entity: input };
        } else if (arg) {
          try {
            const full = await client?.getEntity(arg as any);
            if (!(full instanceof Api.User)) {
              return { id: undefined as any, entity: undefined as any };
            }
            const input = await client?.getInputEntity(full.id);
            return { id: Number(full.id), entity: input };
          } catch (e) {
            // Fallback: if arg is numeric and current chat is channel, scan participants to resolve access hash
            const numericId = Number(arg);
            if ((msg as any).isChannel && Number.isFinite(numericId)) {
              try {
                let offset = 0;
                const limit = 200;
                for (let i = 0; i < 5; i++) {
                  // scan up to 1000 participants
                  const res: any = await client?.invoke(
                    new Api.channels.GetParticipants({
                      channel,
                      filter: new Api.ChannelParticipantsRecent(),
                      offset,
                      limit,
                      hash: 0 as any,
                    })
                  );
                  const participants: any[] = res?.participants || [];
                  const users: any[] = res?.users || [];
                  const found = participants.find(
                    (p: any) => Number(p.userId) === numericId
                  );
                  if (found) {
                    const user = users.find(
                      (u: any) => Number(u.id) === numericId
                    );
                    if (user) {
                      const input = await client?.getInputEntity(user);
                      return { id: Number(user.id), entity: input };
                    }
                  }
                  if (!participants.length) break;
                  offset += participants.length;
                }
              } catch {}
            }
            return { id: undefined as any, entity: undefined as any };
          }
        }
        return { id: undefined as any, entity: undefined as any };
      }

      async function getCurrentParticipant(targetEntity: any) {
        try {
          const client = await getGlobalClient();
          const info = await client?.invoke(
            new Api.channels.GetParticipant({
              channel,
              participant: targetEntity,
            })
          );
          return (info as any)?.participant;
        } catch (e) {
          return undefined;
        }
      }

      async function getSelfIsCreator(): Promise<boolean> {
        try {
          const client = await getGlobalClient();
          const me = await client?.getMe();
          if (!me) return false;
          const info = await client?.invoke(
            new Api.channels.GetParticipant({
              channel,
              participant: (me as any).id,
            })
          );
          const part = (info as any)?.participant;
          return part instanceof Api.ChannelParticipantCreator;
        } catch {
          return false;
        }
      }

      function extractRights(rights?: any): Api.ChatAdminRights {
        if (!rights) return new Api.ChatAdminRights({ banUsers: true });
        // Copy all known flags; undefined flags are treated as false.
        return new Api.ChatAdminRights({
          changeInfo: !!rights.changeInfo,
          postMessages: !!rights.postMessages,
          editMessages: !!rights.editMessages,
          deleteMessages: !!rights.deleteMessages,
          banUsers: rights.banUsers !== undefined ? !!rights.banUsers : true,
          inviteUsers: !!rights.inviteUsers,
          pinMessages: !!rights.pinMessages,
          addAdmins: !!rights.addAdmins,
          anonymous: !!rights.anonymous,
          manageCall: !!rights.manageCall,
          other: !!rights.other,
          manageTopics: !!rights.manageTopics,
          postStories: !!rights.postStories,
          editStories: !!rights.editStories,
          deleteStories: !!rights.deleteStories,
        });
      }

      async function addOrUpdateAdmin(targetArg?: string, titleArg?: string) {
        const targetLike = targetArg;
        const title = titleArg;

        const { entity: userEntity, id: userId } =
          await resolveUserFromReplyOrArg(targetLike);
        if (!userEntity) {
          await msg.edit({ text: "请回复一条消息或提供 用户ID/用户名" });
          return;
        }

        // Normalize title (support clear keywords)
        const rawTitle = (title || "").trim();
        const titleIsProvided = title !== undefined;
        const normalizedTitle = [""].includes(rawTitle.toLowerCase())
          ? ""
          : rawTitle;
        // Telegram 限制头衔最长 16 字符
        const limitedTitle =
          normalizedTitle.length > 16
            ? normalizedTitle.slice(0, 16)
            : normalizedTitle;

        // Per spec: 权限默认只有 ban。无论此前是否为管理员，均设置为仅 ban 权限。
        const participant = await getCurrentParticipant(userEntity);
        // 不传头衔 = 清空
        let rankToUse = limitedTitle; // empty string clears
        let adminRightsToUse: Api.ChatAdminRights = new Api.ChatAdminRights({
          banUsers: true,
        });

        try {
          const client = await getGlobalClient();

          const isChannelChat = chatEntity instanceof Api.Channel;
          if (isChannelChat) {
            await client?.invoke(
              new Api.channels.EditAdmin({
                channel,
                userId: userEntity,
                adminRights: adminRightsToUse!,
                rank: rankToUse,
              })
            );
            // 等待服务器状态同步
            await sleep(1200);
          } else {
            // Basic group fallback: cannot set title/rights granularity
            await client?.invoke(
              new Api.messages.EditChatAdmin({
                chatId: (msg as any).chatId,
                userId: userEntity,
                isAdmin: true as any,
              })
            );
          }

          // Verify rank actually updated
          let appliedRank = rankToUse;
          let selfIsCreator = false;
          try {
            selfIsCreator = await getSelfIsCreator();
            const refreshed = await getCurrentParticipant(userEntity);
            if (
              refreshed instanceof Api.ChannelParticipantAdmin ||
              refreshed instanceof Api.ChannelParticipantCreator
            ) {
              appliedRank = (refreshed as any).rank || "";
            }
          } catch {}

          const u = await formatEntity(userId || userEntity, true);
          const rankOk = appliedRank === rankToUse;
          await msg.edit({
            text:
              `已设置管理员: ${u.display}` +
              (rankToUse
                ? rankOk
                  ? `，头衔：<code>${rankToUse}</code>`
                  : `，但头衔未更新。` +
                    (selfIsCreator
                      ? `可能原因：非超级群或系统暂未同步。`
                      : `可能原因：仅群主可设置头衔；或非超级群；或系统暂未同步。`)
                : ""),
            parseMode: "html",
          });
        } catch (e: any) {
          const extra =
            typeof e?.message === "string" &&
            e.message.includes("USER_ID_INVALID")
              ? "\n可能原因：目标不是当前对话中的用户、匿名管理员、或仅提供了数字ID且无法解析。请改为回复该用户的消息或使用 @用户名。"
              : "";
          await msg.edit({
            text: `设置管理员失败：<code>${e?.message || e}</code>${extra}`,
            parseMode: "html",
          });
        }
      }

      async function removeAdmin(targetArg?: string) {
        const targetLike = targetArg;
        const { entity: userEntity, id: userId } =
          await resolveUserFromReplyOrArg(targetLike);
        if (!userEntity) {
          await msg.edit({ text: "请回复一条消息或提供 用户ID/用户名" });
          return;
        }
        try {
          const client = await getGlobalClient();
          if ((msg as any).isChannel) {
            await client?.invoke(
              new Api.channels.EditAdmin({
                channel,
                userId: userEntity,
                adminRights: new Api.ChatAdminRights({}),
                rank: "",
              })
            );
          } else {
            await client?.invoke(
              new Api.messages.EditChatAdmin({
                chatId: (msg as any).chatId,
                userId: userEntity,
                isAdmin: false as any,
              })
            );
          }
          const u = await formatEntity(userId || userEntity, true);
          await msg.edit({
            text: `已移除管理员: ${u.display}`,
            parseMode: "html",
          });
        } catch (e: any) {
          const extra =
            typeof e?.message === "string" &&
            e.message.includes("USER_ID_INVALID")
              ? "\n可能原因：目标不是当前对话中的用户、匿名管理员、或仅提供了数字ID且无法解析。请改为回复该用户的消息或使用 @用户名。"
              : "";
          await msg.edit({
            text: `移除管理员失败：<code>${e?.message || e}</code>${extra}`,
            parseMode: "html",
          });
        }
      }

      async function listAdmins() {
        try {
          const client = await getGlobalClient();
          if (!(msg as any).isChannel) {
            await msg.edit({ text: "仅支持超级群/频道列出管理员" });
            return;
          }
          const result = await client?.invoke(
            new Api.channels.GetParticipants({
              channel,
              filter: new Api.ChannelParticipantsAdmins(),
              offset: 0,
              limit: 200,
              hash: 0 as any,
            })
          );

          const participants: any[] = (result as any)?.participants || [];
          const users: any[] = (result as any)?.users || [];
          if (!participants.length) {
            await msg.edit({ text: "当前对话没有管理员或无法获取" });
            return;
          }

          const lines: string[] = [];
          for (const p of participants) {
            let uid: any = (p as any).userId;
            if (typeof uid !== "number") uid = Number(uid);
            const user = users.find((u) => Number(u.id) === Number(uid));
            const rank = (p as any).rank || "";
            // Build display
            let display = "";
            if (user) {
              const parts: string[] = [];
              if (user.firstName) parts.push(user.firstName);
              if (user.lastName) parts.push(user.lastName);
              if (user.username) parts.push(`<code>@${user.username}</code>`);
              parts.push(`<a href="tg://user?id=${uid}">${uid}</a>`);
              display = parts.join(" ");
            } else {
              display = `<a href=\"tg://user?id=${uid}\">${uid}</a>`;
            }
            lines.push(
              `- ${display}${rank ? ` | 头衔: <code>${rank}</code>` : ""}`
            );
          }

          await msg.edit({
            text: `当前管理员列表：\n${lines.join("\n")}`,
            parseMode: "html",
          });
        } catch (e: any) {
          await msg.edit({
            text: `获取管理员列表失败：<code>${e?.message || e}</code>`,
            parseMode: "html",
          });
        }
      }

      if (["ls", "list"].includes(sub)) {
        await listAdmins();
        return;
      }
      if (["rm", "remove", "del"].includes(sub)) {
        const targetArg = msg.isReply ? undefined : parts[2];
        await removeAdmin(targetArg);
        return;
      }
      if (["add", "set"].includes(sub)) {
        const targetArg = msg.isReply ? undefined : parts[2];
        let titleArg = msg.isReply
          ? getTxtFromMsg(msg, 1)
          : getTxtFromMsg(msg, 2);

        await addOrUpdateAdmin(targetArg, titleArg);
        return;
      }
      await msg.edit({
        text: `未知命令, 使用 <code>${mainPrefix}help ${pluginName}</code> 查看帮助`,
        parseMode: "html",
      });
    },
  };
}

export default new ManageAdminPlugin();

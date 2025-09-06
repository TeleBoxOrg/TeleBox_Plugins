import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { sleep } from "telegram/Helpers";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

function toInt(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function toStrInt(value: any): string | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : undefined;
}

const CN_TIME_ZONE = "Asia/Shanghai";

function formatDate(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: CN_TIME_ZONE });
}

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
function htmlEscape(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

class DbdjPlugin extends Plugin {
  description: string = `点兵点将\n<code>${mainPrefix}dbdj 消息数 人数 文案</code> - 从最近的消息中随机抽取指定人数的用户`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    dbdj: async (msg: Api.Message, trigger?: Api.Message) => {
      const startAt = Date.now();
      try {
        const parts = msg.message.trim().split(/\s+/);
        // 期望格式: .dbdj 消息数 人数 文案...
        const countStr = parts[1];
        const pickStr = parts[2];
        const note = parts.slice(3).join(" ");

        const scanCount = toInt(countStr);
        const pickCount = toInt(pickStr);

        if (!scanCount || !pickCount || scanCount <= 0 || pickCount <= 0) {
          await msg.edit({
            text: `用法: <code>${mainPrefix}dbdj 消息数 人数 文案</code>\n例如: <code>${mainPrefix}dbdj 50 2 恭喜发财</code>`,
            parseMode: "html",
          });
          return;
        }

        await msg.edit({
          text: `点兵点将...`,
          parseMode: "html",
        });

        const client = msg.client!;
        const offsetId = (msg.id || 1) - 1; // 从命令消息之前开始
        const messages = await client.getMessages(msg.peerId, {
          offsetId,
          limit: scanCount,
        });

        // 收集有效用户: 仅统计来自用户的消息, 排除自身(out)、无 fromId 的消息
        const uniqueUserIds: number[] = [];
        const seen = new Set<number>();
        const filtered = new Set<number>();

        for (const m of messages) {
          // 跳过自己发送的消息
          // if ((m as any).out) continue;
          const from = (m as any).fromId as any;
          const uid = from?.userId ? Number(from.userId) : undefined;
          if (!uid || !Number.isFinite(uid)) continue;

          if (!seen.has(uid) && !filtered.has(uid)) {
            const entity = (await formatEntity(uid))?.entity;

            if (
              !entity ||
              entity?.bot ||
              entity?.deleted ||
              entity?.fake ||
              entity?.scam ||
              entity?.botBusiness
            ) {
              filtered.add(uid);
            } else {
              seen.add(uid);
              uniqueUserIds.push(uid);
            }
          }
        }

        const population = uniqueUserIds.length;
        if (population === 0) {
          await msg.edit({
            text: `未在最近的 <code>${scanCount}</code> 条消息中找到可抽取的有效用户。`,
            parseMode: "html",
          });
          return;
        }

        // 随机选取
        const k = Math.min(pickCount, population);
        // 洗牌抽样
        for (let i = uniqueUserIds.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [uniqueUserIds[i], uniqueUserIds[j]] = [
            uniqueUserIds[j],
            uniqueUserIds[i],
          ];
        }
        const winners = uniqueUserIds.slice(0, k);

        // 格式化展示
        const winnerDisplays = await Promise.all(
          winners.map(async (id) => (await formatEntity(id, true)).display)
        );

        const usedNote = note ? ` ${htmlEscape(note)}` : "";
        const seconds = (
          Math.round(((Date.now() - startAt) / 1000) * 100) / 100
        ).toString();

        const head = `点兵点将, 点到谁... ${winnerDisplays.join(
          ", "
        )}${usedNote}`;
        const stats = [
          `📊 统计信息:`,
          `• 扫描消息数: ${toStrInt(scanCount)}`,
          `• 有效用户数: ${population}`,
          `• 选中人数: ${k}`,
          `• 选中概率: ${
            population > 0
              ? (Math.round((k / population) * 100 * 100) / 100).toString()
              : "0.00"
          }%`,
          `• 耗时: ${seconds} 秒`,
        ].join("\n");

        await msg.edit({
          text: `${head}\n\n${stats}`,
          parseMode: "html",
          linkPreview: false,
        });
      } catch (error: any) {
        await msg.edit({
          text: `执行失败: <code>${htmlEscape(
            error?.message || String(error)
          )}</code>`,
          parseMode: "html",
        });
      }

      if (trigger) {
        try {
          await trigger.delete();
        } catch {}
      }
    },
  };
}

export default new DbdjPlugin();

import { Plugin, type PanelSettingsAdapter, type PanelSettingField, type PanelFieldType } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import type { Message, Video, Document, Chat, User, TelegramClient } from "@mtcute/node";
import { tl } from "@mtcute/node";
import { Long } from "@mtcute/core";
import type { MtcuteFileLocation, MtcuteInputChannel } from "@utils/mtcuteTypes";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import fs from "fs/promises";
import path from "path";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const CONFIG_FILE_PATH = path.join(
  process.cwd(),
  "temp",
  "channel_search_config.json"
);

interface SearchConfig {
  defaultChannel: string | null;
  channelList: { title: string; handle: string; linkedGroup?: string }[];
  adFilters: string[];
}

enum SubCommand {
  Add = "add",
  Delete = "del",
  Default = "default",
  List = "list",
  Export = "export",
  Import = "import",
  Kkp = "kkp",
  Ad = "ad",
}

/** Resolved peer info with commonly needed properties */
interface ResolvedPeerInfo {
  peer: tl.TypeInputPeer;
  chat: Chat;
  rawType: string;
  title?: string;
  username?: string;
  isMegagroup: boolean;
  isBroadcast: boolean;
}

/**
 * Resolve a peer and extract commonly needed properties.
 * Uses type-safe mtcute APIs instead of `as any` casts:
 *   const peer = await client.resolvePeer(id);
 *   const chat = await client.getChat(peer);
 *   const isChannel = chat.raw._ === 'channel';
 *   const title = chat.raw.title;
 */
async function resolvePeerInfo(client: TelegramClient, id: string | number): Promise<ResolvedPeerInfo> {
  const peer = await client.resolvePeer(id);
  // resolvePeer returns tl.TypeInputPeer; for full info we need getChat
  const chat = await client.getChat(peer);
  const raw = chat.raw;
  const rawType = raw._;
  const isChannel = rawType === "channel";
  const isChat = rawType === "chat";
  const channelRaw = raw as tl.RawChannel;
  const chatRaw = raw as tl.RawChat;
  const title = isChannel ? channelRaw.title : isChat ? chatRaw.title : undefined;
  const username = isChannel ? channelRaw.username : undefined;
  const isMegagroup = isChannel ? Boolean(channelRaw.megagroup) : false;
  const isBroadcast = isChannel ? Boolean(channelRaw.broadcast) : false;
  return { peer, chat, rawType, title, username, isMegagroup, isBroadcast };
}

/**
 * Get the video from a message's media, if present.
 * Replaces: (msg as any).video
 */
function getMessageVideo(msg: Message): Video | null {
  const media = msg.media;
  if (media && media.type === "video") {
    return media as Video;
  }
  return null;
}

/**
 * Check if message media is a Document.
 */
function getMessageDocumentMedia(msg: Message): Document | null {
  const media = msg.media;
  if (media && media.type === "document") {
    return media as Document;
  }
  return null;
}

/**
 * Check if message has a webpage in its media.
 * Replaces: (msg as any)._ === 'messageMediaWebPage'
 */
function hasWebPageMedia(msg: Message): boolean {
  const media = msg.media;
  return media != null && media.type === "webpage";
}

/**
 * Get grouped ID as a string for comparison.
 * Replaces: (msg as any).groupedId?.toString()
 */
function getGroupedIdString(msg: Message): string | null {
  const gid = msg.groupedId;
  if (gid === null) return null;
  return String(gid);
}

/**
 * Get reply count from a message.
 * Replaces: (msg as any).replies?.replies
 */
function getReplyCount(msg: Message): number {
  return msg.replies?.count ?? 0;
}

/**
 * Check if message has replies/comments.
 * Replaces: (msg as any).replies
 */
function hasReplies(msg: Message): boolean {
  return msg.replies != null && msg.replies.count > 0;
}

/**
 * Get the document attribute of a specific type from a Video.
 * Replaces: video.video?.attributes?.find((attr: any) attr._ === 'documentAttributeVideo')
 */
function getVideoAttribute(video: Video): tl.RawDocumentAttributeVideo | undefined {
  const doc = video.raw;
  return doc.attributes?.find(
    (attr): attr is tl.RawDocumentAttributeVideo => attr._ === "documentAttributeVideo"
  );
}

/**
 * Get the filename attribute from a Document.
 */
function getDocumentFilenameAttribute(doc: Document): tl.RawDocumentAttributeFilename | undefined {
  return doc.raw.attributes?.find(
    (attr): attr is tl.RawDocumentAttributeFilename => attr._ === "documentAttributeFilename"
  );
}

/**
 * Get message text safely.
 * Replaces: (msg as any).text or (msg as any).message
 */
function getMessageTextSafe(msg: Message): string {
  return msg.text ?? "";
}

/**
 * Get sender ID as string from a message.
 * Replaces: (sender as any).id?.toString()
 */
function getSenderIdString(msg: Message): string {
  const sender = msg.sender;
  return String(sender.id);
}

/**
 * Check if a message is outgoing.
 * Replaces: (msg as any).isOutgoing
 */
function isMessageOutgoing(msg: Message | { raw: { _: string } }): boolean {
  const raw = msg.raw;
  if (raw._ === "message") {
    return Boolean((raw as tl.RawMessage).out);
  }
  return false;
}

/**
 * Get chat ID from a message for forwarding.
 * Replaces: (msg as any).chat?.id || (msg as any).peerId
 */
function getMessageChatId(msg: Message): number | string {
  return msg.chat.id as number | string;
}

class SearchService {
  private client: TelegramClient;
  private config: SearchConfig = {
    defaultChannel: null,
    channelList: [],
    adFilters: [
      "广告", "推广", "赞助", "合作", "代理", "招商", "加盟", "投资", "理财",
      "贷款", "借钱", "网贷", "信用卡", "pos机", "刷单", "兼职", "副业",
      "微商", "代购", "淘宝", "拼多多", "京东", "直播带货", "优惠券",
      "返利", "红包", "现金", "提现", "充值", "游戏币", "点卡",
      "彩票", "博彩", "赌博", "六合彩", "时时彩", "北京赛车",
      "股票", "期货", "外汇", "数字货币", "比特币", "挖矿",
      "保险", "医疗", "整容", "减肥", "丰胸", "壮阳", "药品",
      "假货", "高仿", "A货", "精仿", "原单", "尾单",
      "办证", "刻章", "发票", "学历", "文凭", "证书",
      "黑客", "破解", "外挂", "木马", "病毒", "盗号",
      "vpn", "翻墙", "代理ip", "科学上网", "梯子"
    ]
  };

  constructor(client: TelegramClient) {
    this.client = client;
  }

  public async initialize() {
    await this.loadConfig();
  }

  private async loadConfig() {
    try {
      await fs.access(CONFIG_FILE_PATH);
      const data = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
      this.config = { ...this.config, ...JSON.parse(data) };
    } catch (_e: unknown) {
      logger.info("未找到搜索配置，使用默认配置。");
    }
  }

  private async saveConfig() {
    try {
      await fs.mkdir(path.dirname(CONFIG_FILE_PATH), { recursive: true });
      await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(this.config, null, 2));
    } catch (error: unknown) {
      logger.error("保存配置失败:", error);
    }
  }

  private async discoverLinkedGroup(channel: tl.TypeInputChannel): Promise<string | undefined> {
    try {
      const fullChannel = await this.client.call({
        _: 'channels.getFullChannel',
        channel,
      });

      const fullChat = (fullChannel as { fullChat?: { linkedChatId?: number } }).fullChat;
      if (fullChat?.linkedChatId) {
        const linkedChatId = fullChat.linkedChatId;
        const linkedGroup = await this.client.resolvePeer(linkedChatId);
        const linkedGroupRaw = (linkedGroup as { _?: string; megagroup?: boolean; username?: string });
        if (linkedGroupRaw._ === 'channel' && linkedGroupRaw.megagroup) {
          if (linkedGroupRaw.username) {
            return `@${linkedGroupRaw.username}`;
          } else {
            try {
              const inviteLink = await this.client.call({
                _: 'messages.exportChatInvite',
                peer: linkedGroup,
              });
              const linkObj = inviteLink as { _?: string; link?: string };
              if (linkObj._ === 'chatInviteExported') {
                return linkObj.link;
              }
            } catch (linkError: unknown) {
              logger.info(`获取邀请链接失败: ${getErrorMessage(linkError)}`);
            }
            return undefined;
          }
        }
      }
      return undefined;
    } catch (error: unknown) {
      logger.info(`获取频道关联讨论组失败: ${getErrorMessage(error)}`);
      return undefined;
    }
  }

  private async searchInChannelWithLinkedGroup(
    channelInfo: { title: string; handle: string; linkedGroup?: string },
    query: string
  ): Promise<Message[]> {
    const videos: Message[] = [];
    if (!channelInfo.linkedGroup) return [];

    try {
      const linkedGroupEntity = await this.client.resolvePeer(channelInfo.linkedGroup);
      const groupMessages = await this.client.searchMessages({
        chatId: linkedGroupEntity,
        query,
        limit: 100,
      });

      for (const textMsg of groupMessages) {
        if (this.isMessageMatching(textMsg, query) && hasReplies(textMsg)) {
          logger.info(`找到匹配消息 #${textMsg.id}，正在精确获取其 ${getReplyCount(textMsg)} 条评论...`);
          // TODO: safeGetMessages does not support replyTo-based fetching.
          // Use client.getReplies() or similar mtcute API to fetch actual replies.
          const comments: Message[] = [];

          const videoReplies = comments.filter((msg: Message) =>
            getMessageVideo(msg) != null &&
            !hasWebPageMedia(msg) &&
            !this.isAdContent(msg)
          );

          if (videoReplies.length > 0) {
            logger.info(`在评论区找到 ${videoReplies.length} 个视频。`);
            videos.push(...videoReplies);
            return videos;
          }
        }
      }

      if (videos.length === 0) {
        const groupVideoMessages = await this.client.searchMessages({
          chatId: linkedGroupEntity,
          query,
          limit: 100,
          filter: { _: 'inputMessagesFilterVideo' },
        });

        const pureVideos = groupVideoMessages.filter((v: Message) =>
          getMessageVideo(v) != null &&
          !hasWebPageMedia(v) &&
          !this.isAdContent(v)
        );

        if (pureVideos.length > 0) {
          videos.push(...pureVideos);
        }
      }
    } catch (linkedGroupError: unknown) {
      logger.error(`访问关联讨论组失败: ${getErrorMessage(linkedGroupError)}`);
    }
    return videos;
  }

  public async handle(msg: MessageContext) {
    let fullArgs = msg.text.substring(4).trim();
    const useSpoiler = fullArgs.toLowerCase().includes(" -s");
    const useRandom = fullArgs.toLowerCase().includes(" -r");

    if (useSpoiler) fullArgs = fullArgs.replace(/\s+-s/i, "").trim();
    if (useRandom) fullArgs = fullArgs.replace(/\s+-r/i, "").trim();

    const args = fullArgs.split(/\s+/);
    const subCommand = args[0]?.toLowerCase() as SubCommand;
    const subCommandArgs = args.slice(1).join(" ");

    const adminMsg = await msg.edit({ text: `⚙️ 正在执行命令...` });
    if (!adminMsg) return;

    // Helper to edit the admin message using client.editMessage
    const editAdmin = async (params: { text: string }) => {
      await this.client.editMessage({ chatId: msg.chat.id, message: adminMsg.id, ...params });
    };

    try {
      switch (subCommand) {
        case SubCommand.Add:
          await this.handleAdd(msg, editAdmin, subCommandArgs);
          break;
        case SubCommand.Delete:
          await this.handleDelete(msg, editAdmin, subCommandArgs);
          break;
        case SubCommand.Default:
          await this.handleDefault(msg, editAdmin, subCommandArgs);
          break;
        case SubCommand.List:
          await this.handleList(msg, editAdmin);
          break;
        case SubCommand.Export:
          await this.handleExport(msg);
          break;
        case SubCommand.Import:
          await this.handleImport(msg);
          break;
        case SubCommand.Kkp:
          await this.handleKkp(msg, useSpoiler);
          break;
        case SubCommand.Ad:
          await this.handleAd(msg, subCommandArgs);
          break;
        default:
          await this.handleSearch(msg, fullArgs, useSpoiler, useRandom);
      }
    } catch (error: unknown) {
      await editAdmin({ text: `❌ 错误：\n${getErrorMessage(error)}` });
    }
  }

  private async handleAdd(msg: MessageContext, editAdmin: (params: { text: string }) => Promise<void>, args: string) {
    if (!args) throw new Error("请提供频道链接或 @username，使用 \\ 分隔。");
    const channels = args.split("\\").filter(s => s.trim().length > 0);
    if (channels.length === 0) throw new Error("请提供频道链接或 @username，使用 \\ 分隔。");

    // 并行解析所有频道的 peerInfo，提高批量添加效率
    const peerInfoResults = await Promise.all(
      channels.map(async (channelHandle) => {
        const normalizedHandle = channelHandle.trim();
        try {
          const peerInfo = await resolvePeerInfo(this.client, normalizedHandle);
          return { normalizedHandle, peerInfo, error: null as string | null };
        } catch (error: unknown) {
          return { normalizedHandle, peerInfo: null, error: getErrorMessage(error) };
        }
      })
    );

    // 先报告解析错误
    for (const { normalizedHandle, error } of peerInfoResults) {
      if (error) {
        await editAdmin({ text: `添加频道 ${normalizedHandle} 时出错：${error}` });
      }
    }

    // 过滤出有效且非重复的频道
    const validChannels: Array<{ normalizedHandle: string; peerInfo: NonNullable<typeof peerInfoResults[0]['peerInfo']> }> = [];
    for (const { normalizedHandle, peerInfo, error } of peerInfoResults) {
      if (error || !peerInfo) continue;
      if (peerInfo.rawType !== 'channel' && peerInfo.rawType !== 'chat') {
        await editAdmin({ text: `错误：${normalizedHandle} 不是公开频道、群组或讨论组。` });
        continue;
      }
      if (this.config.channelList.some((c) => c.handle === normalizedHandle)) {
        await editAdmin({ text: `目标 "${peerInfo.title}" 已存在。` });
        continue;
      }
      validChannels.push({ normalizedHandle, peerInfo });
    }

    // 并行发现关联讨论组（仅对非超级群组频道）
    const linkedGroupResults = await Promise.all(
      validChannels.map(async ({ peerInfo }) => {
        if (peerInfo.isBroadcast && !peerInfo.isMegagroup) {
          return this.discoverLinkedGroup(peerInfo.peer as unknown as MtcuteInputChannel);
        }
        return undefined;
      })
    );

    let addedCount = 0;
    for (let i = 0; i < validChannels.length; i++) {
      const { normalizedHandle, peerInfo } = validChannels[i];
      const linkedGroup = linkedGroupResults[i];
      try {
        this.config.channelList.push({
          title: peerInfo.title ?? normalizedHandle,
          handle: normalizedHandle,
          linkedGroup,
        });
        if (!this.config.defaultChannel) this.config.defaultChannel = normalizedHandle;
        addedCount++;
      } catch (err: unknown) {
        await editAdmin({ text: `添加频道 ${normalizedHandle} 时出错：${getErrorMessage(err)}` });
      }
    }
    await Promise.all([
      this.saveConfig(),
      editAdmin({ text: `✅ 成功添加 ${addedCount} 个频道。` }),
    ]);
  }

  private async handleDelete(msg: MessageContext, editAdmin: (params: { text: string }) => Promise<void>, args: string) {
    if (!args) throw new Error(`用法: ${mainPrefix}so del <频道链接|序号> [...] 或 ${mainPrefix}so del all。`);
    if (args.toLowerCase().trim() === "all") {
        const count = this.config.channelList.length;
        this.config.channelList = [];
        this.config.defaultChannel = null;
        await Promise.all([
            this.saveConfig(),
            editAdmin({ text: `✅ 已清空所有 ${count} 个频道。` }),
        ]);
        return;
    }

    const inputs = args.split(/[\s\\]+/).filter(Boolean);
    const handlesToRemove = new Set<string>();
    const removedTitles: string[] = [];

    const currentList = [...this.config.channelList];

    for (const input of inputs) {
        const index = parseInt(input, 10);
        if (!isNaN(index) && index > 0 && index <= currentList.length) {
            const handle = currentList[index - 1].handle;
            handlesToRemove.add(handle);
        } else {
            handlesToRemove.add(input);
        }
    }

    if (handlesToRemove.size === 0) {
        await editAdmin({ text: `❓ 未提供有效的频道链接或序号。` });
        return;
    }

    const originalLength = this.config.channelList.length;

    this.config.channelList = this.config.channelList.filter(channel => {
        if (handlesToRemove.has(channel.handle)) {
            removedTitles.push(channel.title);
            return false;
        }
        return true;
    });

    const removedCount = originalLength - this.config.channelList.length;

    if (removedCount > 0) {
        if (this.config.defaultChannel && handlesToRemove.has(this.config.defaultChannel)) {
            this.config.defaultChannel = this.config.channelList.length > 0 ? this.config.channelList[0].handle : null;
        }
        await Promise.all([
            this.saveConfig(),
            editAdmin({ text: `✅ 成功移除 ${removedCount} 个频道:\n- ${removedTitles.join('\n- ')}` }),
        ]);
    } else {
        await editAdmin({ text: `❓ 在列表中未找到指定的频道或序号。` });
    }
  }

  private async handleDefault(msg: MessageContext, editAdmin: (params: { text: string }) => Promise<void>, args: string) {
    if (!args) throw new Error(`用法: ${mainPrefix}so default <频道链接> 或 ${mainPrefix}so default d。`);
    if (args === "d") {
        this.config.defaultChannel = null;
        await Promise.all([
            this.saveConfig(),
            editAdmin({ text: `✅ 默认频道已移除。` }),
        ]);
        return;
    }
    const normalizedHandle = args.trim();
    if (!this.config.channelList.some((c) => c.handle === normalizedHandle)) {
        throw new Error(`请先使用 \`${mainPrefix}so add\` 添加此频道。`);
    }
    this.config.defaultChannel = normalizedHandle;
    await Promise.all([
        this.saveConfig(),
        editAdmin({ text: `✅ 已将 "${normalizedHandle}" 设为默认频道。` }),
    ]);
  }

  private async handleList(msg: MessageContext, editAdmin: (params: { text: string }) => Promise<void>) {
    if (this.config.channelList.length === 0) {
      await editAdmin({ text: "没有添加任何搜索频道。" });
      return;
    }
    let listText = "**当前搜索频道列表:**\n\n";
    this.config.channelList.forEach((channel, index) => {
      const isDefault = channel.handle === this.config.defaultChannel ? " (默认)" : "";
      listText += `${index + 1}. ${channel.title}${isDefault}\n`;
    });
    await editAdmin({ text: listText });
  }

  private async handleExport(msg: MessageContext) {
    if (this.config.channelList.length === 0) {
        await msg.edit({ text: "没有可导出的频道。" });
        return;
    }
    const backupContent = this.config.channelList.map((c) => c.handle).join("\n");
    const backupFilePath = path.join(process.cwd(), "temp", "so_channels_backup.txt");
    await fs.mkdir(path.dirname(backupFilePath), { recursive: true });
    await fs.writeFile(backupFilePath, backupContent);
    await this.client.sendMedia(msg.chat.id, backupFilePath, { caption: `✅ 您的频道源已导出。`, replyTo: msg.id });
    await fs.unlink(backupFilePath);
  }

  private async handleImport(msg: MessageContext) {
    const replied = await safeGetReplyMessage(msg);
    const docMedia = replied ? getMessageDocumentMedia(replied) : null;
    if (!replied || !docMedia) throw new Error("❌ 请回复备份文件。");

    const buffer = await this.client.downloadAsBuffer(replied.media as MtcuteFileLocation);
    if (!buffer) throw new Error("下载文件失败。");

    const handles = buffer.toString().split("\n").map((h: string) => h.trim()).filter(Boolean);
    if (handles.length === 0) throw new Error("备份文件无效。");

    await msg.edit({ text: `⚙️ 正在导入 ${handles.length} 个源...` });
    this.config.channelList = [];
    this.config.defaultChannel = null;

    const editAdmin = async (params: { text: string }) => {
      await msg.edit(params);
    };
    await this.handleAdd(msg, editAdmin, handles.join("\\"));
  }

  private async handleAd(msg: MessageContext, args: string) {
    const parts = args.split(/\s+/);
    const subCmd = parts[0]?.toLowerCase();
    const keywords = parts.slice(1);

    switch (subCmd) {
      case "add":
        if (keywords.length === 0) throw new Error("请提供关键词。");
        this.config.adFilters.push(...keywords);
        await this.saveConfig();
        await msg.edit({ text: `✅ 成功添加 ${keywords.length} 个广告过滤词。` });
        break;
      case "del":
        if (keywords.length === 0) throw new Error("请提供关键词。");
        const initialLength = this.config.adFilters.length;
        this.config.adFilters = this.config.adFilters.filter(k => !keywords.includes(k));
        await this.saveConfig();
        await msg.edit({ text: `✅ 成功删除 ${initialLength - this.config.adFilters.length} 个广告过滤词。` });
        break;
      case "list":
        if (this.config.adFilters.length === 0) {
          await msg.edit({ text: "当前没有广告过滤词。" });
        } else {
          await msg.edit({ text: `**当前广告过滤词:**\n\n${this.config.adFilters.join(", ")}` });
        }
        break;
      default:
        throw new Error(`用法: ${mainPrefix}so ad <add|del|list> [关键词]`);
    }
  }

  private async handleKkp(msg: MessageContext, useSpoiler: boolean) {
    await this.findAndSendVideo(msg, null, useSpoiler, true, "kkp");
  }

  private async handleSearch(msg: MessageContext, query: string, useSpoiler: boolean, useRandom: boolean) {
    if (!query) throw new Error("请输入搜索关键词。");
    await this.findAndSendVideo(msg, query, useSpoiler, useRandom, "search");
  }

  private async findAndSendVideo(
    msg: MessageContext,
    query: string | null,
    useSpoiler: boolean,
    useRandom: boolean,
    type: "kkp" | "search"
  ) {
    if (this.config.channelList.length === 0)
      throw new Error(`请至少使用 \`${mainPrefix}so add\` 添加一个搜索频道。`);

    const initialMessage = type === "kkp" ? "🎲 正在随机寻找视频..." : "🔍 正在搜索视频...";
    await msg.edit({ text: initialMessage });

    const searchOrder = [...new Set([this.config.defaultChannel, ...this.config.channelList.map((c) => c.handle)].filter(Boolean) as string[])];

    let validVideos: Message[] = [];
    const processedGroupIds = new Set<string>();

    for (const [index, channelHandle] of searchOrder.entries()) {
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, 750));
      }

      const channelInfo = this.config.channelList.find((c) => c.handle === channelHandle);
      if (!channelInfo) continue;

      let videosInCurrentChannel: Message[] = [];

      try {
        const entityPromise = this.client.resolvePeer(channelInfo.handle);
        await msg.edit({ text: `- 正在搜索... (源: ${index + 1}/${searchOrder.length})` });
        const entity = await entityPromise;

        if (type === "search" && query) {
          if (channelInfo.linkedGroup) {
            const linkedVideos = await this.searchInChannelWithLinkedGroup(channelInfo, query);
            if (linkedVideos.length > 0) videosInCurrentChannel.push(...linkedVideos);
          }

          const allQueryMessages = await this.client.searchMessages({
            chatId: entity,
            query,
            limit: 200,
          });

          for (const foundMsg of allQueryMessages) {
            if (this.isMessageMatching(foundMsg, query)) {
              const groupIdStr = getGroupedIdString(foundMsg);
              if (groupIdStr) {
                if (processedGroupIds.has(groupIdStr)) continue;

                const historyResult = await this.client.call({
                  _: 'messages.getHistory' as const,
                  peer: entity,
                  limit: 20,
                  offsetId: foundMsg.id + 10,
                  offsetDate: 0,
                  addOffset: 0,
                  maxId: 0,
                  minId: 0,
                  hash: Long.fromNumber(0),
                }) as tl.messages.RawMessages;
                // Raw TL messages from getHistory; cast to high-level Message for compatibility
                const surroundingMessages = (historyResult.messages ?? []).filter((m): m is tl.TypeMessage => m != null) as unknown as Message[];

                const groupedId = foundMsg.groupedId;
                if (!groupedId) continue;
                const albumMessages = surroundingMessages.filter((m: Message) => {
                  const mGid = getGroupedIdString(m);
                  return mGid === groupIdStr;
                });
                const videosInAlbum = albumMessages.filter((m: Message) => getMessageVideo(m) != null && !this.isAdContent(m));

                if (videosInAlbum.length > 0) {
                  videosInCurrentChannel.push(...videosInAlbum);
                  processedGroupIds.add(groupIdStr);
                }
              } else if (getMessageVideo(foundMsg) != null && !this.isAdContent(foundMsg)) {
                videosInCurrentChannel.push(foundMsg);
              }
            }
          }
        } else if (type === "kkp") {
          const peerInfo = await resolvePeerInfo(this.client, channelInfo.handle);
          const isMegagroup = peerInfo.isMegagroup;
          const messages = await this.client.searchMessages({
            chatId: entity,
            query: "",
            limit: isMegagroup ? 200 : 100,
            filter: { _: 'inputMessagesFilterVideo' },
          });

          const filteredVideos = messages.filter((v: Message) => {
            const video = getMessageVideo(v);
            if (!video || hasWebPageMedia(v) || this.isAdContent(v)) return false;

            const videoAttr = getVideoAttribute(video);
            return videoAttr && videoAttr.duration >= 20 && videoAttr.duration <= 180;
          });
          videosInCurrentChannel.push(...filteredVideos);
        }

        if (videosInCurrentChannel.length > 0) {
          validVideos.push(...videosInCurrentChannel);
          if (type === "search" && !useRandom) {
              logger.info(`在频道 "${channelInfo.title}" 中找到结果，精确模式下停止搜索。`);
              break;
          }
        }

      } catch (error: unknown) {
        if (getErrorMessage(error).includes("Could not find the input entity")) {
            logger.error(`无法找到频道 ${channelInfo.title}，已自动移除。`);
            this.config.channelList = this.config.channelList.filter(c => c.handle !== channelHandle);
            if(this.config.defaultChannel === channelHandle) this.config.defaultChannel = null;
            await this.saveConfig();
        } else {
            logger.error(`在频道 "${channelInfo.title}" 搜索失败: ${getErrorMessage(error)}`);
        }
        continue;
      }
    }

    if (validVideos.length > 0) {
        validVideos = Array.from(new Map(validVideos.map(v => [v.id, v])).values());
    }

    if (validVideos.length === 0) {
      await msg.edit({ text: type === "kkp" ? "🤷‍♂️ 未找到合适的视频。" : "❌ 在任何频道中均未找到匹配结果。" });
      return;
    }

    let selectedVideo: Message;

    if (useRandom || type === "kkp") {
      logger.info(`随机模式开启，从 ${validVideos.length} 个视频中选择...`);
      selectedVideo = this.selectRandomVideo(validVideos);
    } else {
      logger.info(`精确模式，从 ${validVideos.length} 个视频中按相关性选择...`);
      if (validVideos.length > 1) {
          const queryNormalized = this.normalizeSearchTerm(query || "");
          const getScore = (video: Message): number => {
              let score = 0;
              const vid = getMessageVideo(video);
              const doc = vid ? null : getMessageDocumentMedia(video);
              const fileNameAttr = doc ? getDocumentFilenameAttribute(doc) : undefined;
              if (fileNameAttr?.fileName) {
                  const normalizedFileName = this.normalizeSearchTerm(fileNameAttr.fileName);
                  if (normalizedFileName.includes(queryNormalized)) score += 100;
              }
              const text = getMessageTextSafe(video);
              if (text) {
                  const normalizedMessage = this.normalizeSearchTerm(text);
                  if (normalizedMessage.includes(queryNormalized)) score += 50;
              }
              return score;
          };

          validVideos.sort((a, b) => {
              const scoreA = getScore(a);
              const scoreB = getScore(b);
              if (scoreB !== scoreA) return scoreB - scoreA;

              const vidA = getMessageVideo(a);
              const vidB = getMessageVideo(b);
              const durationA = vidA ? (getVideoAttribute(vidA)?.duration ?? 0) : 0;
              const durationB = vidB ? (getVideoAttribute(vidB)?.duration ?? 0) : 0;
              return durationB - durationA;
          });
      }
      selectedVideo = validVideos[0];
    }

    await msg.edit({ text: `✅ 已找到结果，准备发送...` });

    const originalMsg = msg;
    await this.sendVideo(originalMsg, selectedVideo, useSpoiler, query);

    if (!useSpoiler && isMessageOutgoing(originalMsg)) {
      try {
        await this.client.deleteMessagesById(originalMsg.chat.id, [originalMsg.id]);
      } catch (e: unknown) {
        logger.warn("删除原始消息失败，可能已被删除:", e);
      }
    }
  }

  private async sendVideo(originalMsg: MessageContext, video: Message, useSpoiler: boolean, caption?: string | null) {
    if (useSpoiler) {
      await this.downloadAndUploadVideo(originalMsg, video, true, caption);
    } else {
      try {
        await this.client.forwardMessagesById({
          fromChatId: getMessageChatId(video),
          messages: [video.id],
          toChatId: originalMsg.chat.id,
        });
      } catch (forwardError: unknown) {
        logger.info(`转发失败，自动转为下载上传: ${getErrorMessage(forwardError)}`);
        await this.downloadAndUploadVideo(originalMsg, video, false, caption);
      }
    }
  }

  private async downloadAndUploadVideo(originalMsg: MessageContext, video: Message, spoiler: boolean = false, caption?: string | null): Promise<void> {
    const tempDir = path.join(process.cwd(), "temp");
    const tempFilePath = path.join(tempDir, `video_${Date.now()}.mp4`);

    const [statusMsg] = await Promise.all([
      this.client.sendText(originalMsg.chat.id, `🔥 正在下载视频...`, { replyTo: originalMsg.id }),
      fs.mkdir(tempDir, { recursive: true }),
    ]);

    try {
      const buffer = await this.client.downloadAsBuffer(video.media as MtcuteFileLocation);
      await fs.writeFile(tempFilePath, Buffer.from(buffer));
      await this.client.editMessage({ chatId: originalMsg.chat.id, message: statusMsg.id, text: `✅ 下载完成，正在上传...` });

      const videoMedia = getMessageVideo(video);
      if (!videoMedia) throw new Error("消息不包含有效的视频媒体。");

      const videoAttr = getVideoAttribute(videoMedia);

      const mediaInput = {
          type: 'video' as const,
          file: tempFilePath,
          caption: caption || getMessageTextSafe(video) || "",
          duration: videoAttr?.duration ?? 0,
          w: videoAttr?.w ?? 0,
          h: videoAttr?.h ?? 0,
          supportsStreaming: true,
          spoiler: spoiler,
      };

      await this.client.sendMedia(originalMsg.chat.id, mediaInput, {
          replyTo: originalMsg.id
      });
      await this.client.deleteMessagesById(originalMsg.chat.id, [statusMsg.id]);
      if (isMessageOutgoing(originalMsg)) {
        await this.client.deleteMessagesById(originalMsg.chat.id, [originalMsg.id]);
      }
    } catch (error: unknown) {
      logger.error("下载上传视频时出错:", error);
      await this.client.editMessage({ chatId: originalMsg.chat.id, message: statusMsg.id, text: `❌ 发送视频失败: ${getErrorMessage(error)}` });
    } finally {
      try {
        await fs.unlink(tempFilePath);
      } catch (cleanupError: unknown) {
        logger.warn("清理临时文件失败:", cleanupError);
      }
    }
  }

  private isMessageMatching(message: Message, query: string): boolean {
    const normalizedQuery = this.normalizeSearchTerm(query);
    const textSources = [getMessageTextSafe(message)];
    const video = getMessageVideo(message);
    const doc = video ? null : getMessageDocumentMedia(message);
    const fileNameAttr = doc ? getDocumentFilenameAttribute(doc) : undefined;
    if (fileNameAttr?.fileName) textSources.push(fileNameAttr.fileName);

    for (const source of textSources) {
      if (source) {
        const normalizedText = this.normalizeSearchTerm(source);
        if (this.fuzzyMatch(normalizedText, normalizedQuery)) return true;
      }
    }
    return false;
  }

  private normalizeSearchTerm(text: string): string {
    return text.toLowerCase().replace(/[-_\s\.\|\/#]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private fuzzyMatch(text: string, query: string): boolean {
    if (text.includes(query)) return true;
    const queryParts = query.split(' ').filter(part => part.length > 0);
    const textParts = text.split(' ');

    if (queryParts.length === 1 && /[a-z]+\s*\d+/i.test(query)) {
      if (text.replace(/\s+/g, '').includes(query.replace(/\s+/g, ''))) return true;
    }

    return queryParts.every(queryPart => textParts.some(textPart => textPart.includes(queryPart)));
  }

  private isAdContent(message: Message): boolean {
    const text = (getMessageTextSafe(message)).toLowerCase();
    const video = getMessageVideo(message);
    const doc = video ? null : getMessageDocumentMedia(message);
    const fileNameAttr = doc ? getDocumentFilenameAttribute(doc) : undefined;
    const fileName = (fileNameAttr?.fileName || "").toLowerCase();
    return this.config.adFilters.some(filter => text.includes(filter) || fileName.includes(filter));
  }

  private selectRandomVideo(videos: Message[]): Message {
    return videos[Math.floor(Math.random() * videos.length)];
  }
}

const so = async (msg: MessageContext) => {
  const client = await getGlobalClient();
  if (!client) return;

  const service = new SearchService(client);
  await service.initialize();
  await service.handle(msg);
};

class ChannelSearchPlugin extends Plugin {
    cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }


  description: string = `强大的多频道资源搜索插件，具备高级功能：

搜索功能:
- 关键词搜索: ${mainPrefix}so <关键词> （不限制大小和时长）
- 随机速览: ${mainPrefix}so kkp （随机选择20秒-3分钟的视频）

选项:
- 防剧透模式: -s (下载视频并将其作为防剧透消息发送)
- 随机模式: -r (从匹配结果中随机选择)

频道管理:
- 添加频道: .so add <频道链接> (使用 \\ 分隔)
- 删除频道: ${mainPrefix}so del <频道链接|序号> [...] 或 ${mainPrefix}so del all (删除所有)
- 设置默认: ${mainPrefix}so default <频道链接> 或 ${mainPrefix}so default d (移除默认)
- 列出频道: ${mainPrefix}so list
- 导出配置: ${mainPrefix}so export
- 导入配置: ${mainPrefix}so import (回复备份文件)

广告过滤:
- 添加关键词: ${mainPrefix}so ad add <关键词1> <关键词2> ...
- 删除关键词: ${mainPrefix}so ad del <关键词1> <关键词2> ...
- 查看关键词: ${mainPrefix}so ad list`;

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    so,
    search: so,
  };
}


  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "search",
    title: "频道搜索",
    description: "频道搜索配置：默认频道、广告过滤",
    category: "插件配置",
    icon: "🔍",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "defaultChannel",
            "label": "默认频道",
            "type": "string"
      },
      {
            "key": "adFilters",
            "label": "广告过滤词列表",
            "type": "json"
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const CONFIG_FILE_PATH = path.join(process.cwd(), "temp", "channel_search_config.json");
      try {
        const data = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
        return JSON.parse(data) as Record<string, unknown>;
      } catch {
        return {};
      }
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const CONFIG_FILE_PATH = path.join(process.cwd(), "temp", "channel_search_config.json");
      let config: Record<string, unknown> = {};
      try {
        const data = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
        config = JSON.parse(data);
      } catch {}
      Object.assign(config, patch);
      await fs.mkdir(path.dirname(CONFIG_FILE_PATH), { recursive: true });
      await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(config, null, 2));
    },
  };

export default new ChannelSearchPlugin();

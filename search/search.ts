import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram/tl";
import { CustomFile } from "telegram/client/uploads";
import { helpers, utils } from "telegram";
import fs from "fs/promises";
import path from "path";
import { getGlobalClient } from "@utils/globalClient";

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

class SearchService {
  private client: any;
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

  constructor(client: any) {
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
    } catch (error) {
      // Config file doesn't exist or is invalid, use default.
      console.log("未找到搜索配置，使用默认配置。");
    }
  }

  private async saveConfig() {
    try {
      await fs.mkdir(path.dirname(CONFIG_FILE_PATH), { recursive: true });
      await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error("保存配置失败:", error);
    }
  }

  // 发现频道关联的讨论组
  private async discoverLinkedGroup(channel: Api.Channel): Promise<string | undefined> {
    try {
      // 获取频道的完整信息
      const fullChannel = await this.client.invoke(
        new Api.channels.GetFullChannel({
          channel: channel,
        })
      );

      // 检查是否有关联的讨论组
      if (fullChannel.fullChat.linkedChatId) {
        const linkedChatId = fullChannel.fullChat.linkedChatId;
        console.log(`频道 ${channel.title} 关联讨论组ID: ${linkedChatId}`);
        
        // 获取关联讨论组的实体
        const linkedGroup = await this.client.getEntity(linkedChatId);
        if (linkedGroup instanceof Api.Channel && linkedGroup.megagroup) {
          // 如果有用户名，使用@username，否则直接存储ID用于后续访问
          const groupHandle = linkedGroup.username ? `@${linkedGroup.username}` : linkedChatId.toString();
          console.log(`关联讨论组: ${linkedGroup.title} (${linkedGroup.username ? `@${linkedGroup.username}` : `ID: ${linkedChatId}`})`);
          return groupHandle;
        }
      }
      
      return undefined;
    } catch (error: any) {
      console.log(`获取频道关联讨论组失败: ${error.message}`);
      return undefined;
    }
  }

  // 智能过滤视频回复，防止跨越到其他频道消息的讨论
  private filterRelevantVideoReplies(
    messages: Api.Message[], 
    originalQuery: string, 
    keywordMessage: Api.Message
  ): Api.Message[] {
    const relevantVideos: Api.Message[] = [];
    let foundNewKeywordMessage = false;
    
    for (const msg of messages) {
      // 检查是否遇到了新的包含关键词的消息（可能是下一条频道消息的讨论）
      if (this.isMessageMatching(msg, originalQuery) && msg.id !== keywordMessage.id) {
        console.log(`检测到新的关键词消息 (ID: ${msg.id})，停止收集视频以避免跨越`);
        foundNewKeywordMessage = true;
        break;
      }
      
      // 检查是否是纯视频消息
      const isPureVideo =
        msg.video &&
        !(msg.media instanceof Api.MessageMediaWebPage) &&
        !(
          msg.entities &&
          msg.entities.some(
            (entity: any) =>
              entity instanceof Api.MessageEntityUrl ||
              entity instanceof Api.MessageEntityTextUrl
          )
        );
      
      if (isPureVideo && !this.isAdContent(msg)) {
        relevantVideos.push(msg);
      }
      
      // 如果已经收集了足够多的视频（比如20个），也可以停止
      if (relevantVideos.length >= 20) {
        console.log(`已收集到足够的视频数量 (${relevantVideos.length})，停止收集`);
        break;
      }
    }
    
    return relevantVideos;
  }

  // 在频道中搜索关键词消息，然后在关联讨论组中查找视频
  private async searchInChannelWithLinkedGroup(
    channelInfo: { title: string; handle: string; linkedGroup?: string },
    query: string
  ): Promise<Api.Message[]> {
    const videos: Api.Message[] = [];
    
    try {
      const entity = await this.client.getEntity(channelInfo.handle);
      
      // 在频道中搜索包含关键词的消息
      const channelMessages = await this.client.getMessages(entity, {
        limit: 100,
        search: query,
      });
      
      console.log(`在频道 ${channelInfo.title} 中找到 ${channelMessages.length} 条包含关键词的消息`);
      
      // 在关联讨论组中搜索
      if (channelInfo.linkedGroup) {
        const linkedGroupEntity = await this.client.getEntity(channelInfo.linkedGroup);
        
        // 直接在讨论组中搜索包含关键词的消息
        console.log(`在讨论组中搜索关键词: ${query}`);
        const groupMessages = await this.client.getMessages(linkedGroupEntity, {
          limit: 100,
          search: query,
        });
        
        console.log(`在讨论组中找到 ${groupMessages.length} 个包含关键词的消息`);
        
        // 查找包含关键词的消息，然后寻找其后的视频回复
        for (const textMsg of groupMessages) {
          if (this.isMessageMatching(textMsg, query)) {
            console.log(`找到匹配消息: ${textMsg.message?.substring(0, 50)}... (ID: ${textMsg.id})`);
            
            // 获取该消息之后的消息，寻找视频回复
            const followupMessages = await this.client.getMessages(linkedGroupEntity, {
              limit: 50, // 减少获取数量，避免跨越到其他频道消息
              minId: textMsg.id,
              reverse: true, // 按时间正序获取，确保获取的是后续消息
            });
            
            console.log(`获取消息 ${textMsg.id} 之后的 ${followupMessages.length} 条消息，消息ID范围: ${followupMessages.map((m: Api.Message) => m.id).join(', ')}`);
            
            // 智能过滤：只保留与当前关键词相关的视频回复
            const relevantVideoReplies = this.filterRelevantVideoReplies(followupMessages, query, textMsg);
            
            console.log(`经过智能过滤后找到 ${relevantVideoReplies.length} 个相关视频回复: ${relevantVideoReplies.map((v: Api.Message) => v.id).join(', ')}`);
            
            const videoReplies = relevantVideoReplies;
            
            if (videoReplies.length > 0) {
              console.log(`找到 ${videoReplies.length} 个视频回复: ${videoReplies.map((v: Api.Message) => v.id).join(', ')}`);
              videos.push(...videoReplies); // 添加所有找到的视频，供后续随机选择
              break;
            }
          }
        }
        
        // 如果没有找到视频回复，尝试直接搜索包含关键词的视频消息
        if (videos.length === 0) {
          console.log(`未找到视频回复，尝试直接搜索包含关键词的视频消息`);
          const groupVideoMessages = await this.client.getMessages(linkedGroupEntity, {
            limit: 100,
            search: query,
            filter: new Api.InputMessagesFilterVideo(),
          });
          
          const pureVideos = groupVideoMessages.filter((v: Api.Message) => {
            const isPureVideo =
              v.video &&
              !(v.media instanceof Api.MessageMediaWebPage) &&
              !(
                v.entities &&
                v.entities.some(
                  (entity: any) =>
                    entity instanceof Api.MessageEntityUrl ||
                    entity instanceof Api.MessageEntityTextUrl
                )
              );
            return isPureVideo && !this.isAdContent(v);
          });
          
          if (pureVideos.length > 0) {
            console.log(`找到 ${pureVideos.length} 个直接匹配的视频: ${pureVideos.map((v: Api.Message) => v.id).join(', ')}`);
            videos.push(...pureVideos); // 添加所有找到的视频，供后续随机选择
          }
        }
      }
      
      return videos;
    } catch (error: any) {
      console.error(`搜索频道关联讨论组失败: ${error.message}`);
      return [];
    }
  }

  public async handle(msg: Api.Message) {
    let fullArgs = msg.message.substring(4).trim();
    const useSpoiler = fullArgs.toLowerCase().includes(" -s");
    const useRandom = fullArgs.toLowerCase().includes(" -r");

    if (useSpoiler) {
      fullArgs = fullArgs.replace(/\s+-s/i, "").trim();
    }
    if (useRandom) {
      fullArgs = fullArgs.replace(/\s+-r/i, "").trim();
    }

    const args = fullArgs.split(/\s+/);
    const subCommand = args[0]?.toLowerCase() as SubCommand;
    const subCommandArgs = args.slice(1).join(" ");

    const adminMsg = await msg.edit({ text: `⚙️ 正在执行命令...` });
    if (!adminMsg) return;

    try {
      switch (subCommand) {
        case SubCommand.Add:
          await this.handleAdd(adminMsg, subCommandArgs);
          break;
        case SubCommand.Delete:
          await this.handleDelete(adminMsg, subCommandArgs);
          break;
        case SubCommand.Default:
          await this.handleDefault(adminMsg, subCommandArgs);
          break;
        case SubCommand.List:
          await this.handleList(adminMsg);
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
    } catch (error: any) {
      await adminMsg.edit({ text: `❌ 错误：\n${error.message}` });
    }
  }

  private async handleAdd(msg: Api.Message, args: string) {
    if (!args) throw new Error("请提供频道链接或 @username，使用 \\ 分隔。");
    const channels = args.split("\\");
    let addedCount = 0;

    for (const channelHandle of channels) {
      try {
        const normalizedHandle = channelHandle.trim();
        console.log(`正在尝试添加频道: ${normalizedHandle}`);
        
        const entity = await this.client.getEntity(normalizedHandle);
        console.log(`获取到实体: ${entity.className}, ID: ${entity.id}, Title: ${entity.title}`);
        
        // 检查实体类型，允许频道、群组和讨论组
        if (!(entity instanceof Api.Channel) && !(entity instanceof Api.Chat)) {
          const errorMsg = `错误：${normalizedHandle} 不是公开频道、群组或讨论组，而是 ${entity.className}。`;
          console.log(errorMsg);
          await msg.edit({ text: errorMsg });
          continue;
        }

        // 检查是否为讨论组（megagroup）
        if (entity instanceof Api.Channel && entity.megagroup === true) {
          console.log(`添加讨论组: ${entity.title}`);
        }

        // 检查频道是否为私有频道
        if (entity instanceof Api.Channel && entity.megagroup === false && entity.broadcast === true) {
          // 这是一个频道
          if (!entity.username && entity.accessHash) {
            console.log(`频道 ${entity.title} 是私有频道，需要通过邀请链接访问`);
          }
        }
        
        if (this.config.channelList.some((c) => c.handle === normalizedHandle)) {
          await msg.edit({ text: `目标 "${entity.title}" 已存在。` });
          continue;
        }

        // 检查是否为频道，如果是则尝试发现关联的讨论组
        let linkedGroup: string | undefined;
        if (entity instanceof Api.Channel && !entity.megagroup && entity.broadcast) {
          try {
            linkedGroup = await this.discoverLinkedGroup(entity);
            if (linkedGroup) {
              console.log(`发现关联讨论组: ${linkedGroup}`);
            }
          } catch (error: any) {
            console.log(`未能发现关联讨论组: ${error.message}`);
          }
        }

        this.config.channelList.push({
          title: entity.title,
          handle: normalizedHandle,
          linkedGroup: linkedGroup,
        });
        if (!this.config.defaultChannel) this.config.defaultChannel = normalizedHandle;
        addedCount++;
        console.log(`成功添加频道: ${entity.title}${linkedGroup ? ` (关联讨论组: ${linkedGroup})` : ''}`);
      } catch (error: any) {
        const errorMsg = `添加频道 ${channelHandle.trim()} 时出错：${error.message}`;
        console.error(errorMsg);
        console.error(`错误详情:`, error);
        
        // 提供更详细的错误信息
        let detailedError = error.message;
        if (error.message.includes('Could not find the input entity')) {
          detailedError += '\n可能原因：\n1. 频道不存在或已被删除\n2. 频道是私有的，需要先加入\n3. 链接格式不正确\n4. 网络连接问题';
        } else if (error.message.includes('CHANNEL_PRIVATE')) {
          detailedError = '频道是私有的，请先加入该频道后再尝试添加。';
        } else if (error.message.includes('USERNAME_NOT_OCCUPIED')) {
          detailedError = '用户名不存在，请检查频道链接是否正确。';
        }
        
        await msg.edit({
          text: `❌ ${detailedError}`,
        });
      }
    }

    await this.saveConfig();
    await msg.edit({ text: `✅ 成功添加 ${addedCount} 个频道。` });
  }

  private async handleDelete(msg: Api.Message, args: string) {
    if (!args)
      throw new Error("用法: .so del <频道链接> 或 .so del all。使用 \\ 分隔多个频道。");
    
    // 检查是否是删除所有频道
    if (args.toLowerCase().trim() === "all") {
      const totalCount = this.config.channelList.length;
      if (totalCount === 0) {
        await msg.edit({ text: "❓ 当前没有任何频道可删除。" });
        return;
      }
      
      this.config.channelList = [];
      this.config.defaultChannel = null;
      await this.saveConfig();
      await msg.edit({ text: `✅ 已清空所有频道，共移除 ${totalCount} 个频道。` });
      return;
    }
    
    const channels = args.split("\\");
    let removedCount = 0;

    for (const channelHandle of channels) {
      try {
        const normalizedHandle = channelHandle.trim();
        
        const initialLength = this.config.channelList.length;
        this.config.channelList = this.config.channelList.filter(
          (c) => c.handle !== normalizedHandle
        );

        if (this.config.channelList.length === initialLength) {
          await msg.edit({
            text: `❓ 目标 "${normalizedHandle}" 不在列表中。`,
          });
          continue;
        }

        if (this.config.defaultChannel === normalizedHandle) {
          this.config.defaultChannel =
            this.config.channelList.length > 0
              ? this.config.channelList[0].handle
              : null;
        }
        removedCount++;
      } catch (error: any) {
        await msg.edit({
          text: `删除频道 ${channelHandle.trim()} 时出错： ${error.message}`,
        });
      }
    }

    await this.saveConfig();
    await msg.edit({ text: `✅ 成功移除 ${removedCount} 个频道。` });
  }

  private async handleDefault(msg: Api.Message, args: string) {
    if (!args)
      throw new Error(
        "用法: .so default <频道链接> 或 .so default d 删除默认频道。"
      );
    if (args === "d") {
      this.config.defaultChannel = null;
      await this.saveConfig();
      await msg.edit({ text: `✅ 默认频道已移除。` });
      return;
    }

    try {
      const entity = await this.client.getEntity(args);
      if (!(entity instanceof Api.Channel) && !(entity instanceof Api.Chat)) {
        throw new Error("目标不是频道或群组。");
      }

      const normalizedHandle = args.trim();
      
      if (!this.config.channelList.some((c) => c.handle === normalizedHandle)) {
        throw new Error("请先使用 `.so add` 添加此频道。");
      }

      this.config.defaultChannel = normalizedHandle;
      await this.saveConfig();
      await msg.edit({ text: `✅ "${entity.title}" 已被设为默认频道。` });
    } catch (error: any) {
      throw new Error(`设置默认频道时出错: ${error.message}`);
    }
  }

  private async handleList(msg: Api.Message) {
    if (this。config。channelList.length === 0) {
      await msg.edit({ text: "没有添加任何搜索频道。" });
      return;
    }

    let listText = "**当前搜索频道列表 (按搜索顺序):**\n\n";
    const searchOrderHandles = [
      ...new Set(
        [
          this.config.defaultChannel,
          ...this.config.channelList.map((c) => c.handle),
        ]。filter(Boolean)
      )，
    ];
    searchOrderHandles。forEach((handle, index) => {
      const channel = this.config.channelList.find((c) => c.handle === handle);
      if (channel) {
        const isDefault =
          channel。handle === this.config.defaultChannel ? " (默认)" : "";
        listText += `${index + 1}。 ${channel。title}${isDefault}\n`;
      }
    });
    await msg。edit({ text: listText });
  }

  private async handleExport(msg: Api.Message) {
    if (this.config.channelList.length === 0) {
      await msg.edit({ text: "没有可导出的频道。" });
      return;
    }

    const backupContent = this.config.channelList
      .map((c) => c.handle)
      .join("\n");
    const tempDir = path.join(process.cwd(), "temp");
    await fs.mkdir(tempDir, { recursive: true });
    const backupFilePath = path.join(tempDir, "so_channels_backup.txt");
    await fs.writeFile(backupFilePath, backupContent);
    await this.client.sendFile(msg.chatId!, {
      file: backupFilePath,
      caption: `✅ 您的频道源已导出。\n回复此文件并发送 \`.so import\` 即可恢复。`,
      replyTo: msg,
    });
    await fs.unlink(backupFilePath);
  }

  private async handleImport(msg: Api.Message) {
    const replied = await msg.getReplyMessage();
    if (!replied || !replied.document) {
      throw new Error("❌ 请回复由 `.so export` 导出的 `.txt` 备份文件。");
    }

    await msg。edit({ text: `🔥 正在下载并导入...` });
    const buffer = await this.client.downloadMedia(replied.media!);
    if (!buffer || buffer.length === 0)
      throw new Error("下载文件失败或文件为空。");

    const handles = buffer
      .toString()
      .split("\n")
      .map((h: string) => h.trim())
      .filter(Boolean);
    if (handles.length === 0) throw new Error("备份文件中没有有效的频道。");

    await msg.edit({
      text: `⚙️ 正在清除旧配置并重新添加 ${handles.length} 个源...`,
    });
    const newConfig: SearchConfig = { defaultChannel: null, channelList: [], adFilters: [] };
    let successCount = 0;
    let firstAddedHandle: string | null = null;

    for (const handle of handles) {
      try {
        const entity = await this.client.getEntity(handle);
        if (
          (entity instanceof Api.Channel || entity instanceof Api.Chat) &&
          !newConfig.channelList.some((c) => c.handle === handle)
        ) {
          newConfig.channelList.push({
            title: entity.title,
            handle: handle,
          });
          if (!firstAddedHandle) firstAddedHandle = handle;
          successCount++;
        }
      } catch (e) {
        console.error(`导入频道 "${handle}" 失败，已跳过。`);
      }
    }

    newConfig.defaultChannel = firstAddedHandle;
    newConfig.adFilters = this.config.adFilters; // 保留现有的广告过滤词
    this.config = newConfig;
    await this.saveConfig();
    await msg.edit({
      text: `✅ 恢复成功：已导入 ${successCount}/${handles.length} 个频道源。`,
    });
  }

  private async handleAd(msg: Api.Message, args: string) {
    const parts = args.split(/\s+/);
    const subCmd = parts[0]?.toLowerCase();
    const keywords = parts.slice(1);

    switch (subCmd) {
      case "add":
        if (keywords.length === 0) {
          throw new Error("请提供要添加的广告关键词，多个关键词用空格分隔。");
        }
        const newKeywords = keywords.filter(k => !this.config.adFilters.includes(k));
        this.config.adFilters.push(...newKeywords);
        await this.saveConfig();
        await msg.edit({ text: `✅ 成功添加 ${newKeywords.length} 个广告过滤关键词。` });
        break;

      case "del":
        if (keywords。length === 0) {
          throw new 错误("请提供要删除的广告关键词，多个关键词用空格分隔。");
        }
        const initialLength = this。config。adFilters.length;
        this.config.adFilters = this.config.adFilters.filter(k => !keywords.includes(k));
        const removedCount = initialLength - this.config.adFilters.length;
        await this.saveConfig();
        await msg。edit({ text: `✅ 成功删除 ${removedCount} 个广告过滤关键词。` });
        break;

      case "list":
        if (this.config.adFilters.length === 0) {
          await msg.edit({ text: "当前没有设置广告过滤关键词。" });
        } else {
          const listText = `**当前广告过滤关键词 (${this。config。adFilters。length}个):**\n\n${this。config.adFilters.join(", ")}`;
          await msg。edit({ text: listText });
        }
        break;

      default:
        throw new 错误("用法: .so ad add <关键词> | .so ad del <关键词> | .so ad list");
    }
  }

  private async handleKkp(
    msg: Api。Message，
    useSpoiler: boolean
  ) {
    await this.findAndSendVideo(msg, null, useSpoiler, false, "kkp");
  }

  private async handleSearch(
    msg: Api.Message,
    query: string,
    useSpoiler: boolean,
    useRandom: boolean
  ) {
    if (!query) throw new Error("请输入搜索关键词。");
    await this.findAndSendVideo(
      msg,
      query,
      useSpoiler,
      useRandom,
      "search"
    );
  }

  private async findAndSendVideo(
    msg: Api.Message,
    query: string | null,
    useSpoiler: boolean,
    useRandom: boolean,
    输入: "kkp" | "search"
  ) {
    if (this.config.channelList.length === 0)
      throw new 错误("请至少使用 `.so add` 添加一个搜索频道。");
    await msg.edit({
      text: 输入 === "kkp" ? "🎲 正在随机寻找视频..." : "🔍 正在搜索视频...",
    });
    const searchOrder = [
      ...new Set(
        [
          this.config.defaultChannel,
          ...this.config.channelList.map((c) => c.handle),
        ].filter(Boolean) as string[]
      ),
    ];
    let validVideos: Api.Message[] = [];
    for (const channelHandle of searchOrder) {
      const channelInfo = this.config.channelList.find(
        (c) => c.handle === channelHandle
      );
      if (!channelInfo) continue;
      try {
        await msg.edit({
          text: `- 正在搜索... (源: ${searchOrder.indexOf(channelHandle) + 1}/${
            searchOrder.length
          })`,
        });
        
        // 对于搜索模式，优先使用频道关联讨论组搜索
        if (type === "search" && channelInfo.linkedGroup && query) {
          console.log(`使用频道关联讨论组搜索: ${channelInfo.title} -> ${channelInfo.linkedGroup}`);
          const linkedVideos = await this.searchInChannelWithLinkedGroup(channelInfo, query);
          validVideos.push(...linkedVideos);
          
          // 如果在关联讨论组中找到视频，就不再使用传统搜索
          if (linkedVideos.length > 0) {
            console.log(`在关联讨论组中找到 ${linkedVideos.length} 个视频，跳过传统搜索`);
            continue;
          }
        }
        
        // 传统搜索方式（作为备用或用于kkp模式）
        const entity = await this.client.getEntity(channelInfo.handle);
        const isMegagroup = entity instanceof Api.Channel && entity.megagroup === true;
        const videos = await this.client.getMessages(entity, {
          limit: isMegagroup ? 200 : 100,
          filter: new Api.InputMessagesFilterVideo(),
        });
        validVideos.push(
          ...videos.filter((v: Api.Message) => {
            const isPureVideo =
              v.video &&
              !(v.media instanceof Api.MessageMediaWebPage) &&
              !(
                v.entities &&
                v.entities.some(
                  (entity: any) =>
                    entity instanceof Api.MessageEntityUrl ||
                    entity instanceof Api.MessageEntityTextUrl
                )
              );
            if (type === "kkp") {
              const durationAttr = v.video?.attributes.find(
                (attr: Api.TypeDocumentAttribute) => attr instanceof Api.DocumentAttributeVideo
              ) as Api.DocumentAttributeVideo | undefined;
              return (
                isPureVideo &&
                durationAttr &&
                durationAttr.duration !== undefined &&
                durationAttr.duration >= 20 &&
                durationAttr.duration <= 180
              );
            }
            return isPureVideo && this.isMessageMatching(v, query!) && !this.isAdContent(v);
          })
        );
      } catch (error: any) {
        if (
          error instanceof Error &&
          error.message.includes("Could not find the input entity")
        ) {
          console.error(`无法找到频道实体 ${channelInfo.title} (${channelInfo.handle})，从配置中移除...`);
          // 从配置中移除无效的频道
          this.config.channelList = this.config.channelList.filter(c => c.handle !== channelInfo.handle);
          if (this.config.defaultChannel === channelInfo.handle) {
            this.config.defaultChannel = this.config.channelList.length > 0 ? this.config.channelList[0].handle : null;
          }
          await this.saveConfig();
          console.log(`已从配置中移除无效频道: ${channelInfo.title}`);
          continue
        } else {
          console.error(
            `在频道 "${channelInfo.title}" (${channelHandle}) 中失败: ${
              error instanceof Error ? error.message : error
            }`
          );
          continue;
        }
      }
    }
    if (validVideos.length === 0) {
      await msg.edit({
        text:
          type === "kkp"
            ? "🤷‍♂️ 未找到合适的视频。"
            : "❌ 在任何频道中均未找到匹配结果。",
      });
      return;
    }
    
    let selectedVideo;
    if (useRandom || type === "kkp") {
      selectedVideo = this.selectRandomVideo(validVideos);
    } else {
      // 搜索模式下，基于查询内容选择视频，确保不同关键词返回不同视频
      selectedVideo = this.selectVideoByQuery(validVideos, query || "");
    }
    
    await this.sendVideo(
      msg，
      selectedVideo，
      useSpoiler，
      query
    );
  }

  private async sendVideo(
    originalMsg: Api.Message,
    video: Api.Message,
    useSpoiler: boolean,
    caption?: string | null
  ) {
    await originalMsg。edit({ text: `✅ 已找到结果，准备发送...` });

    if (useSpoiler) {
      // 防剧透模式：强制下载上传
      await this.downloadAndUploadVideo(originalMsg, video, true, caption);
    } else {
      // 普通模式：先尝试转发，失败时自动下载上传
      try {
        await this.client.forwardMessages(originalMsg。peerId, {
          messages: [video。id],
          fromPeer: video。peerId,
        });
        console。log("转发成功");
        await originalMsg.delete();
      } catch (forwardError: any) {
        console。log(`转发失败，尝试下载上传: ${forwardError。message}`);
        // 转发失败时自动下载上传
        await this.downloadAndUploadVideo(originalMsg， video, false, caption);
      }
    }
  }

  private async downloadAndUploadVideo(
    originalMsg: Api。Message，
    video: Api.Message,
    spoiler: boolean = false,
    caption?: string | null
  ): Promise<void> {
    const tempDir = path.join(process.cwd(), "temp");
    const tempFilePath = path.join(tempDir, `video_${Date.now()}.mp4`);
    
    try {
      await originalMsg。edit({ text: `🔥 正在下载视频...` });
      
      // 下载视频到临时文件
      await this.client.downloadMedia(video.media!, {
        outputFile: tempFilePath，
      });
      
      await originalMsg。edit({ text: `✅ 下载完成，正在上传...` });

      if (spoiler) {
        // 防剧透模式：使用特殊的上传方式
        if (!video。video) throw new Error("消息不包含有效的视频媒体。");

        const fileStat = await fs.stat(tempFilePath);
        const fileToUpload = new CustomFile(
          path.basename(tempFilePath),
          fileStat.size，
          tempFilePath
        );
        const inputFile = await this.client。uploadFile({
          file: fileToUpload，
          workers: 1,
        });

        // 获取原始视频的所有属性
        const originalAttributes = video.video?.attributes || [];
        const videoAttr = originalAttributes.find(
          (attr: Api.TypeDocumentAttribute): attr is Api.DocumentAttributeVideo =>
            attr instanceof Api.DocumentAttributeVideo
        );
        
        // 构建完整的属性列表，保持原始视频的所有特性
        const attributes = [
          new Api.DocumentAttributeVideo({
            duration: videoAttr?.duration || 0,
            w: videoAttr?.w || 0,
            h: videoAttr?.h || 0，
            supportsStreaming: videoAttr?.supportsStreaming || true,
            roundMessage: videoAttr?.roundMessage || false,
          })，
          new Api.DocumentAttributeFilename({
            fileName: fileToUpload.name,
          }),
        ];
        
        // 添加其他原始属性（如果存在）
        originalAttributes.forEach((attr: Api.TypeDocumentAttribute) => {
          if (!(attr instanceof Api。DocumentAttributeVideo) && 
              !(attr instanceof Api.DocumentAttributeFilename)) {
            attributes。push(attr as any);
          }
        });

        const inputMedia = new Api.InputMediaUploadedDocument({
          file: inputFile,
          mimeType: video.video?.mimeType || "video/mp4"，
          attributes: [
            new Api.DocumentAttributeVideo({
              duration: videoAttr?.duration || 0,
              w: videoAttr?.w || 0,
              h: videoAttr?.h || 0,
              supportsStreaming: true,
            }),
            new Api。DocumentAttributeFilename({
              fileName: fileToUpload.name,
            }),
          ],
          spoiler: true,
        });

        await this.client.invoke(
          new Api.messages.SendMedia({
            peer: originalMsg.peerId,
            media: inputMedia,
            message: caption || video.message || "",
            randomId: (BigInt(Date.now()) * BigInt(1000) + BigInt(Math.floor(Math.random() * 1000))) as any,
          })
        );
      } else {
        // 普通模式：作为视频媒体发送
        const fileStat = await fs.stat(tempFilePath);
        const fileToUpload = new CustomFile(
          path.basename(tempFilePath),
          fileStat.size,
          tempFilePath
        );
        
        // 获取原始视频属性
        const originalAttributes = video.video?.attributes || [];
        const videoAttr = originalAttributes.find(
          (attr: Api.TypeDocumentAttribute): attr is Api.DocumentAttributeVideo =>
            attr instanceof Api.DocumentAttributeVideo
        );
        
        await this.client.sendFile(originalMsg.peerId, {
          file: fileToUpload,
          caption: caption || video.message || "",
          forceDocument: false, // 确保作为媒体发送
          attributes: [
            new Api.DocumentAttributeVideo({
              duration: videoAttr?.duration || 0,
              w: videoAttr?.w || 0,
              h: videoAttr?.h || 0,
              supportsStreaming: true,
            })
          ]
        });
      }

      console.log("视频发送成功");
      await originalMsg.delete();
      
      // 清理临时文件
      try {
        await fs.unlink(tempFilePath);
      } catch (cleanupError) {
        console.warn("清理临时文件失败:", cleanupError);
      }
    } catch (error: any) {
      console.error("下载上传视频时出错:", error);
      await originalMsg.edit({ text: `❌ 发送视频失败: ${error.message}` });
      
      // 清理临时文件
      try {
        await fs.unlink(tempFilePath);
      } catch (cleanupError) {
        console.warn("清理临时文件失败:", cleanupError);
      }
      
      throw new Error(`下载上传视频失败: ${error.message}`);
    }
  }

  private isMessageMatching(message: Api.Message, query: string): boolean {
    const normalizedQuery = this.normalizeSearchTerm(query);
    
    // 搜索消息文本
    if (message.text) {
      const normalizedText = this.normalizeSearchTerm(message.text);
      if (this.fuzzyMatch(normalizedText, normalizedQuery)) {
        return true;
      }
    }

    // 搜索消息内容（message字段）
    if (message.message) {
      const normalizedMessage = this.normalizeSearchTerm(message.message);
      if (this.fuzzyMatch(normalizedMessage, normalizedQuery)) {
        return true;
      }
    }

    // 搜索文件名
    const fileNameAttr = message.video?.attributes.find(
      (attr: Api.TypeDocumentAttribute): attr is Api.DocumentAttributeFilename =>
        attr instanceof Api.DocumentAttributeFilename
    );

    if (fileNameAttr?.fileName) {
      const normalizedFileName = this.normalizeSearchTerm(fileNameAttr.fileName);
      if (this.fuzzyMatch(normalizedFileName, normalizedQuery)) {
        return true;
      }
    }

    return false;
  }

  private normalizeSearchTerm(text: string): string {
    return text
      .toLowerCase()
      // 统一各种分隔符为空格
      .replace(/[-_\s\.\|\\\/#]+/g, ' ')
      // 移除多余空格
      .replace(/\s+/g, ' ')
      .trim();
  }

  private fuzzyMatch(text: string, query: string): boolean {
    // 直接匹配
    if (text.includes(query)) {
      return true;
    }

    // 分词匹配：检查查询词的所有部分是否都在文本中
    const queryParts = query.split(' ').filter(part => part.length > 0);
    const textParts = text.split(' ');
    
    // 对于番号搜索，如果查询包含字母和数字，进行特殊处理
    if (queryParts.length === 1 && /[a-z]+\s*\d+/i.test(query)) {
      const cleanQuery = query.replace(/\s+/g, '');
      const cleanText = text.replace(/\s+/g, '');
      if (cleanText.includes(cleanQuery)) {
        return true;
      }
    }
    
    // 检查所有查询词是否都能在文本中找到
    return queryParts.every(queryPart => 
      textParts.some(textPart => 
        textPart.includes(queryPart) || queryPart.includes(textPart)
      )
    );
  }

  private isAdContent(message: Api.Message): boolean {
    const text = message.text?.toLowerCase() || "";
    const fileNameAttr = message.video?.attributes.find(
      (attr: Api.TypeDocumentAttribute): attr is Api.DocumentAttributeFilename =>
        attr instanceof Api.DocumentAttributeFilename
    );
    const fileName = fileNameAttr?.fileName?.toLowerCase() || "";
    
    return this.config.adFilters.some(filter => 
      text.includes(filter) || fileName.includes(filter)
    );
  }

  private selectRandomVideo(videos: Api.Message[]): Api.Message {
    return videos[Math.floor(Math.random() * videos.length)];
  }

  // 基于查询内容选择视频，确保不同关键词返回不同视频
  private selectVideoByQuery(videos: Api.Message[], query: string): Api.Message {
    if (videos.length === 0) {
      throw new Error("视频列表为空");
    }
    
    if (videos.length === 1) {
      return videos[0];
    }
    
    // 使用查询字符串的哈希值来确定选择哪个视频
    let hash = 0;
    for (let i = 0; i < query.length; i++) {
      const char = query。charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    
    // 确保哈希值为正数并映射到视频数组索引
    const index = Math.abs(hash) % videos。length;
    console。log(`查询 "${query}" 的哈希索引: ${index}/${videos。length}, 选择视频ID: ${videos[index]。id}`);
    
    return videos[index];
  }
}

const so = async (msg: Api。Message) => {
  const client = await getGlobalClient();
  if (!client) {
    return;
  }

  const service = new SearchService(client);
  await service。initialize();
  await service.handle(msg);
};

class ChannelSearchPlugin extends Plugin {
  description: string = `强大的多频道资源搜索插件，具备高级功能：

搜索功能:
- 关键词搜索: .so <关键词> （不限制大小和时长）
- 随机速览: .so kkp （随机选择20秒-3分钟的视频）

选项:
- 防剧透模式: -s (下载视频并将其作为防剧透消息发送)
- 随机模式: -r (从匹配结果中随机选择)

频道管理:
- 添加频道: .so add <频道链接> (使用 \\ 分隔)
- 删除频道: .so del <频道链接> (使用 \\ 分隔) 或 .so del all (删除所有)
- 设置默认: .so default <频道链接> 或 .so default d (移除默认)
- 列出频道: .so list
- 导出配置: .so export
- 导入配置: .so import (回复备份文件)

广告过滤:
- 添加关键词: .so ad add <关键词1> <关键词2> ...
- 删除关键词: .so ad del <关键词1> <关键词2> ...
- 查看关键词: .so ad list

搜索逻辑:
- 优先搜索默认频道
- 并行搜索多个频道
- 智能去重和随机选择
- 自动过滤广告内容
- 优化的模糊匹配算法`;
  cmdHandlers: Record<string, (msg: Api。Message) => Promise<void>> = {
    so，
    search: so，
  };
}

export default new ChannelSearchPlugin();

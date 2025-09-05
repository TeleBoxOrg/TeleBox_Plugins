// 文件名: plugins/search.refactored.ts
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
  channelList: { id: string; title: string; handle: string }[];
}

enum SubCommand {
  Add = "add",
  Delete = "del",
  Default = "default",
  List = "list",
  Export = "export",
  Import = "import",
  Kkp = "kkp",
}

class SearchService {
  private client: any;
  private config: SearchConfig = { defaultChannel: null, channelList: [] };

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
      const tempDir = path.dirname(CONFIG_FILE_PATH);
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(
        CONFIG_FILE_PATH,
        JSON.stringify(this.config, null, 2)
      );
    } catch (error) {
      console.error("保存搜索配置失败：", error);
    }
  }

  public async handle(msg: Api.Message) {
    let fullArgs = msg.message.substring(4).trim();
    const useSpoiler = fullArgs.toLowerCase().includes(" -s");
    const useForceDownload = fullArgs.toLowerCase().includes(" -f");

    if (useSpoiler) {
      fullArgs = fullArgs.replace(/\s+-s/i, "").trim();
    }
    if (useForceDownload) {
      fullArgs = fullArgs.replace(/\s+-f/i, "").trim();
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
          await this.handleKkp(msg, useSpoiler, useForceDownload);
          break;
        default:
          await this.handleSearch(msg, fullArgs, useSpoiler, useForceDownload);
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
        const entity = await this.client.getEntity(channelHandle.trim());
        if (!(entity instanceof Api.Channel) && !(entity instanceof Api.Chat)) {
          await msg.edit({
            text: `错误： ${channelHandle.trim()} 不是公开频道或群组。`,
          });
          continue;
        }

        const channelId = entity.id.toString();
        if (this.config.channelList.some((c) => c.id === channelId)) {
          await msg.edit({ text: `目标 "${entity.title}" 已存在。` });
          continue;
        }

        this.config.channelList.push({
          id: channelId,
          title: entity.title,
          handle: channelHandle.trim(),
        });
        if (!this.config.defaultChannel) this.config.defaultChannel = channelId;
        addedCount++;
      } catch (error: any) {
        await msg.edit({
          text: `添加频道 ${channelHandle.trim()} 时出错： ${error.message}`,
        });
      }
    }

    await this.saveConfig();
    await msg.edit({ text: `✅ 成功添加 ${addedCount} 个频道。` });
  }

  private async handleDelete(msg: Api.Message, args: string) {
    if (!args)
      throw new Error("用法: .so del <频道链接>。使用 \\ 分隔多个频道。");
    const channels = args.split("\\");
    let removedCount = 0;

    for (const channelHandle of channels) {
      try {
        const entity = await this.client.getEntity(channelHandle.trim());
        const channelId = entity.id.toString();
        const initialLength = this.config.channelList.length;
        this.config.channelList = this.config.channelList.filter(
          (c) => c.id !== channelId
        );

        if (this.config.channelList.length === initialLength) {
          await msg.edit({
            text: `❓ 目标 "${(entity as any).title}" 不在列表中。`,
          });
          continue;
        }

        if (this.config.defaultChannel === channelId) {
          this.config.defaultChannel =
            this.config.channelList.length > 0
              ? this.config.channelList[0].id
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

      const channelId = entity.id.toString();
      if (!this.config.channelList.some((c) => c.id === channelId)) {
        throw new Error("请先使用 `.so add` 添加此频道。");
      }

      this.config.defaultChannel = channelId;
      await this.saveConfig();
      await msg.edit({ text: `✅ "${entity.title}" 已被设为默认频道。` });
    } catch (error: any) {
      throw new Error(`设置默认频道时出错: ${error.message}`);
    }
  }

  private async handleList(msg: Api.Message) {
    if (this.config.channelList.length === 0) {
      await msg.edit({ text: "没有添加任何搜索频道。" });
      return;
    }

    let listText = "**当前搜索频道列表 (按搜索顺序):**\n\n";
    const searchOrderIds = [
      ...new Set(
        [
          this.config.defaultChannel,
          ...this.config.channelList.map((c) => c.id),
        ].filter(Boolean)
      ),
    ];
    searchOrderIds.forEach((id, index) => {
      const channel = this.config.channelList.find((c) => c.id === id);
      if (channel) {
        const isDefault =
          channel.id === this.config.defaultChannel ? " (默认)" : "";
        listText += `${index + 1}. ${channel.title}${isDefault}\n`;
      }
    });
    await msg.edit({ text: listText });
  }

  private async handleExport(msg: Api.Message) {
    if (this.config.channelList.length === 0) {
      await msg.edit({ text: "没有可导出的频道。" });
      return;
    }

    const backupContent = this.config.channelList
      .map((c) => c.handle || `https://t.me/c/${c.id.replace("-100", "")}`)
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

    await msg.edit({ text: `🔥 正在下载并导入...` });
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
    const newConfig: SearchConfig = { defaultChannel: null, channelList: [] };
    let successCount = 0;
    let firstAddedId: string | null = null;

    for (const handle of handles) {
      try {
        const entity = await this.client.getEntity(handle);
        if (
          (entity instanceof Api.Channel || entity instanceof Api.Chat) &&
          !newConfig.channelList.some((c) => c.id === entity.id.toString())
        ) {
          const channelId = entity.id.toString();
          newConfig.channelList.push({
            id: channelId,
            title: entity.title,
            handle: handle,
          });
          if (!firstAddedId) firstAddedId = channelId;
          successCount++;
        }
      } catch (e) {
        console.error(`导入频道 "${handle}" 失败，已跳过。`);
      }
    }

    newConfig.defaultChannel = firstAddedId;
    this.config = newConfig;
    await this.saveConfig();
    await msg.edit({
      text: `✅ 恢复成功：已导入 ${successCount}/${handles.length} 个频道源。`,
    });
  }

  private async handleKkp(
    msg: Api.Message,
    useSpoiler: boolean,
    useForceDownload: boolean
  ) {
    await this.findAndSendVideo(msg, null, useSpoiler, useForceDownload, "kkp");
  }

  private async handleSearch(
    msg: Api.Message,
    query: string,
    useSpoiler: boolean,
    useForceDownload: boolean
  ) {
    if (!query) throw new Error("请输入搜索关键词。");
    await this.findAndSendVideo(
      msg,
      query,
      useSpoiler,
      useForceDownload,
      "search"
    );
  }

  private async findAndSendVideo(
    msg: Api.Message,
    query: string | null,
    useSpoiler: boolean,
    useForceDownload: boolean,
    type: "kkp" | "search"
  ) {
    if (this.config.channelList.length === 0)
      throw new Error("请至少使用 `.so add` 添加一个搜索频道。");
    await msg.edit({
      text: type === "kkp" ? "🎲 正在随机寻找视频..." : "🔍 正在搜索视频...",
    });
    const searchOrder = [
      ...new Set(
        [
          this.config.defaultChannel,
          ...this.config.channelList.map((c) => c.id),
        ].filter(Boolean) as string[]
      ),
    ];
    let validVideos: Api.Message[] = [];
    let allVideosForFallback: Api.Message[] = [];
    for (const channelId of searchOrder) {
      const channelInfo = this.config.channelList.find(
        (c) => c.id === channelId
      );
      if (!channelInfo) continue;
      try {
        await msg.edit({
          text: `- 正在搜索... (源: ${searchOrder.indexOf(channelId) + 1}/${
            searchOrder.length
          })`,
        });
        const channelEntity = await this.client.getEntity(channelInfo.id);
        const videos = await this.client.getMessages(
          utils.getInputPeer(channelEntity),
          {
            limit: 100,
            filter: new Api.InputMessagesFilterVideo(),
          }
        );
        if (type === "search") allVideosForFallback.push(...videos);
        validVideos.push(
          ...videos.filter((v: Api.Message) => {
            const isPureVideo =
              v.video &&
              !(v.media instanceof Api.MessageMediaWebPage) &&
              !(
                v.entities &&
                v.entities.some(
                  (e) =>
                    e instanceof Api.MessageEntityUrl ||
                    e instanceof Api.MessageEntityTextUrl
                )
              );
            if (type === "kkp") {
              const durationAttr = v.video?.attributes.find(
                (a) => a instanceof Api.DocumentAttributeVideo
              ) as Api.DocumentAttributeVideo | undefined;
              return (
                isPureVideo &&
                durationAttr &&
                durationAttr.duration !== undefined &&
                durationAttr.duration <= 60
              );
            }
            return isPureVideo && this.isMessageMatching(v, query!);
          })
        );
      } catch (e: any) {
        if (
          e instanceof Error &&
          e.message.includes("Could not find the input entity")
        ) {
          console.error("无法找到频道实体，尝试刷新对话缓存...");
          await this.client.getDialogs();
          try {
            await this.client.getEntity(channelInfo.id);
          } catch (refreshError: unknown) {
            console.error(
              `刷新后仍无法找到频道实体: ${
                refreshError instanceof Error
                  ? refreshError.message
                  : refreshError
              }`
            );
            continue;
          }
        } else {
          console.error(
            `在频道 "${channelInfo.title}" (${channelId}) 中失败: ${
              e instanceof Error ? e.message : e
            }`
          );
          continue;
        }
      }
    }
    if (validVideos.length === 0) {
      if (type === "search" && allVideosForFallback.length > 0) {
        await msg.edit({ text: "🤷‍♂️ 未找到匹配结果，为您随机选择一个视频..." });
        await this.sendVideo(
          msg,
          this.selectRandomVideo(allVideosForFallback),
          useSpoiler,
          useForceDownload,
          `[无匹配] ${query}`
        );
        return;
      }
      await msg.edit({
        text:
          type === "kkp"
            ? "🤷‍♂️ 未找到合适的视频。"
            : "❌ 在任何频道中均未找到结果。",
      });
      return;
    }
    await this.sendVideo(
      msg,
      this.selectRandomVideo(validVideos),
      useSpoiler,
      useForceDownload,
      query
    );
  }

  private async sendVideo(
    originalMsg: Api.Message,
    video: Api.Message,
    useSpoiler: boolean,
    forceDownload: boolean,
    caption?: string | null
  ) {
    await originalMsg.edit({ text: `✅ 已找到结果，准备发送...` });

    const sendAsDownloaded = async () => {
      const tempDir = path.join(process.cwd(), "temp");
      const tempFilePath = path.join(tempDir, `video_${Date.now()}.mp4`);
      try {
        await originalMsg.edit({ text: `🔥 正在下载视频...` });
        await this.client.downloadMedia(video.media!, {
          outputFile: tempFilePath,
        });
        await originalMsg.edit({ text: `✅ 下载完成，正在上传...` });

        if (useSpoiler) {
          if (!video.video) throw new Error("消息不包含有效的视频媒体。");

          const fileStat = await fs.stat(tempFilePath);
          const fileToUpload = new CustomFile(
            path.basename(tempFilePath),
            fileStat.size,
            tempFilePath
          );
          const inputFile = await this.client.uploadFile({
            file: fileToUpload,
            workers: 1,
          });

          const videoAttr = video.video.attributes.find(
            (attr): attr is Api.DocumentAttributeVideo =>
              attr instanceof Api.DocumentAttributeVideo
          );

          const inputMedia = new Api.InputMediaUploadedDocument({
            file: inputFile,
            mimeType: video.video.mimeType,
            attributes: [
              new Api.DocumentAttributeVideo({
                duration: videoAttr?.duration || 0,
                w: videoAttr?.w || 0,
                h: videoAttr?.h || 0,
                supportsStreaming: true,
              }),
              new Api.DocumentAttributeFilename({
                fileName: fileToUpload.name,
              }),
            ],
            spoiler: true,
          });

          await this.client.invoke(
            new Api.messages.SendMedia({
              peer: originalMsg.chatId!,
              media: inputMedia,
              message: caption || "",
              randomId: helpers.generateRandomLong(),
            })
          );
        } else {
          await this.client.sendFile(originalMsg.chatId!, {
            file: tempFilePath,
            caption: caption || video.text || undefined,
          });
        }
      } finally {
        try {
          await fs.unlink(tempFilePath);
        } catch (e) {
          // 忽略错误
        }
      }
    };

    // 为确保防剧透模式可靠，我们强制使用下载模式。直接转发带剧透标记的媒体并不可靠。
    if (useSpoiler || forceDownload) {
      await sendAsDownloaded();
    } else {
      try {
        await this.client.forwardMessages(originalMsg.chatId!, {
          messages: video.id,
          fromPeer: video.peerId,
          dropAuthor: true,
          silent: true,
          noforwards: false,
        });
      } catch (error: any) {
        if (
          error.message &&
          error.message.includes("CHAT_FORWARDS_RESTRICTED")
        ) {
          await originalMsg.edit({
            text: `⚠️ 转发失败，频道限制。正在切换到下载模式...`,
          });
          await sendAsDownloaded();
        } else {
          throw error;
        }
      }
    }
    await originalMsg.delete();
  }

  private isMessageMatching(message: Api.Message, query: string): boolean {
    const lowerQuery = query.toLowerCase();

    if (message.text && message.text.toLowerCase().includes(lowerQuery)) {
      return true;
    }

    const fileNameAttr = message.video?.attributes.find(
      (attr): attr is Api.DocumentAttributeFilename =>
        attr instanceof Api.DocumentAttributeFilename
    );

    if (
      fileNameAttr &&
      fileNameAttr.fileName.toLowerCase().includes(lowerQuery)
    ) {
      return true;
    }

    return false;
  }

  private selectRandomVideo(videos: any[]): any {
    if (!videos.length) return null;
    // 每次都随机选取一个视频
    const idx = Math.floor(Math.random() * videos.length);
    return videos[idx];
  }
}

const so = async (msg: Api.Message) => {
  const client = await getGlobalClient();
  if (!client) {
    return;
  }

  const service = new SearchService(client);
  await service.initialize();
  await service.handle(msg);
};

class ChannelSearchPlugin extends Plugin {
  description: string = `强大的多频道资源搜索插件，具备高级功能：

搜索功能:
- 关键词搜索: .so <关键词> （不限制大小和时长）
- 随机速览: .so kkp （随机选择一个视频，限制时长一分钟以内）

选项:
- 防剧透模式: -s (下载视频并将其作为防剧透消息发送)
- 强制下载: -f (绕过转发限制)

频道管理:
- 添加频道: .so add <频道链接> (使用 \\ 分隔)
- 删除频道: .so del <频道链接> (使用 \\ 分隔)
- 设置默认: .so default <频道链接> 或 .so default d (移除默认)
- 列出频道: .so list
- 导出配置: .so export
- 导入配置: .so import (回复备份文件)

搜索逻辑:
- 优先搜索默认频道
- 并行搜索多个频道
- 智能去重和随机选择
- 优化的模糊匹配算法`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    so,
  };
}

export default new ChannelSearchPlugin();

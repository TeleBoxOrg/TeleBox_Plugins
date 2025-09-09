import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";
import { Api } from "telegram";
import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import { JSONFilePreset } from "lowdb/node";
import { sleep } from "telegram/Helpers";

// 必需工具函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 配置接口
interface PicToStickerConfig {
  defaultEmoji: string;
  quality: number;
  format: 'webp' | 'png';
  size: number;
  background: string;
  autoDelete: boolean;
  compressionLevel: number;
}

class PicToStickerPlugin extends Plugin {
  private help_text = `🖼️ <b>图片转贴纸工具</b>

<b>📝 功能：</b>
• 将图片转换为高质量贴纸
• 支持多种图片格式（JPG/PNG/GIF/WEBP）
• 自动优化贴纸尺寸和质量
• 支持自定义表情和背景
• 批量处理多张图片

<b>🔧 使用：</b>
• <code>${mainPrefix}pts</code> - 转换回复的图片
• <code>${mainPrefix}pts [表情]</code> - 使用自定义表情
• <code>${mainPrefix}pts config</code> - 查看/修改配置
• <code>${mainPrefix}pts batch</code> - 批量转换（回复多张图片）
• <code>${mainPrefix}pts help</code> - 显示帮助

<b>⚙️ 配置选项：</b>
• <code>${mainPrefix}pts config emoji [表情]</code> - 设置默认表情
• <code>${mainPrefix}pts config size [256-512]</code> - 设置贴纸尺寸
• <code>${mainPrefix}pts config quality [1-100]</code> - 设置质量
• <code>${mainPrefix}pts config bg [transparent/white/black]</code> - 设置背景
• <code>${mainPrefix}pts config auto [on/off]</code> - 自动删除原消息

<b>💡 示例：</b>
• <code>${mainPrefix}pts</code> - 使用默认设置转换
• <code>${mainPrefix}pts 😎</code> - 使用太阳镜表情
• <code>${mainPrefix}pts config emoji 🔥</code> - 设置默认表情为火焰
• <code>${mainPrefix}pts batch</code> - 批量转换多张图片

<b>📌 提示：</b>
• 支持回复图片消息或直接发送图片
• GIF动图将转换为动态贴纸
• 自动保持图片透明背景
• 智能压缩确保最佳质量`;

  description = this.help_text;
  private configPath: string;
  private config: PicToStickerConfig;
  private tempDir: string;
  private assetsDir: string;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    "pic_to_sticker": this.handlePicToSticker.bind(this),
    "pts": this.handlePicToSticker.bind(this),
  };

  constructor() {
    super();
    this.assetsDir = createDirectoryInAssets("pic_to_sticker");
    this.tempDir = createDirectoryInTemp("pic_to_sticker");
    this.configPath = path.join(this.assetsDir, "config.json");
    this.config = {
      defaultEmoji: "🙂",
      quality: 90,
      format: 'webp',
      size: 512,
      background: 'transparent',
      autoDelete: true,
      compressionLevel: 6
    };
    this.loadConfig();
  }

  private async loadConfig() {
    try {
      const db = await JSONFilePreset<PicToStickerConfig>(this.configPath, this.config);
      this.config = db.data;
    } catch (error) {
      console.error("[pic_to_sticker] 加载配置失败:", error);
    }
  }

  private async saveConfig() {
    try {
      const db = await JSONFilePreset<PicToStickerConfig>(this.configPath, this.config);
      db.data = this.config;
      await db.write();
    } catch (error) {
      console.error("[pic_to_sticker] 保存配置失败:", error);
    }
  }

  private async handlePicToSticker(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    
    if (!client) {
      await msg.edit({
        text: "❌ 客户端未初始化",
        parseMode: "html"
      });
      return;
    }

    // acron.ts 模式参数解析
    const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
    const parts = lines?.[0]?.split(/\s+/) || [];
    const [, ...args] = parts;
    const sub = (args[0] || "").toLowerCase();

    try {
      // 处理帮助命令
      if (sub === "help" || sub === "h") {
        await msg.edit({ text: this.help_text, parseMode: "html" });
        return;
      }

      // 处理配置命令
      if (sub === "config") {
        await this.handleConfig(msg, args.slice(1));
        return;
      }

      // 处理批量转换
      if (sub === "batch") {
        await this.handleBatchConvert(msg);
        return;
      }

      // 获取自定义表情（如果提供）
      const customEmoji = args[0] && !['help', 'h', 'config', 'batch'].includes(sub) ? args[0] : this.config.defaultEmoji;

      // 处理单张图片转换
      await this.convertSingleImage(msg, customEmoji);
    } catch (error: any) {
      console.error("[pic_to_sticker] 插件执行失败:", error);
      await msg.edit({
        text: `❌ <b>转换失败:</b> ${htmlEscape(error.message || '未知错误')}`,
        parseMode: "html"
      });
    }
  }

  private async handleConfig(msg: Api.Message, args: string[]): Promise<void> {
    const option = (args[0] || "").toLowerCase();
    const value = args[1] || "";

    try {
      // 显示当前配置
      if (!option) {
        const configDisplay = `⚙️ <b>当前配置</b>

` +
          `<b>默认表情:</b> ${this.config.defaultEmoji}
` +
          `<b>贴纸尺寸:</b> ${this.config.size}x${this.config.size}
` +
          `<b>图片质量:</b> ${this.config.quality}%
` +
          `<b>背景颜色:</b> ${this.config.background}
` +
          `<b>自动删除:</b> ${this.config.autoDelete ? '开启' : '关闭'}
` +
          `<b>压缩等级:</b> ${this.config.compressionLevel}

` +
          `💡 使用 <code>${mainPrefix}pts config [选项] [值]</code> 修改配置`;
        
        await msg.edit({ text: configDisplay, parseMode: "html" });
        return;
      }

      // 修改配置
      let updated = false;
      let message = "";

      switch (option) {
        case "emoji":
          if (!value) {
            message = `❌ 请提供表情，例如: <code>${mainPrefix}pts config emoji 🔥</code>`;
          } else {
            this.config.defaultEmoji = value;
            updated = true;
            message = `✅ 默认表情已设置为: ${value}`;
          }
          break;

        case "size":
          const size = parseInt(value);
          if (isNaN(size) || size < 256 || size > 512) {
            message = `❌ 尺寸必须在 256-512 之间`;
          } else {
            this.config.size = size;
            updated = true;
            message = `✅ 贴纸尺寸已设置为: ${size}x${size}`;
          }
          break;

        case "quality":
          const quality = parseInt(value);
          if (isNaN(quality) || quality < 1 || quality > 100) {
            message = `❌ 质量必须在 1-100 之间`;
          } else {
            this.config.quality = quality;
            updated = true;
            message = `✅ 图片质量已设置为: ${quality}%`;
          }
          break;

        case "bg":
        case "background":
          if (!['transparent', 'white', 'black'].includes(value)) {
            message = `❌ 背景必须是: transparent/white/black`;
          } else {
            this.config.background = value;
            updated = true;
            message = `✅ 背景已设置为: ${value}`;
          }
          break;

        case "auto":
          if (!['on', 'off'].includes(value)) {
            message = `❌ 自动删除必须是: on/off`;
          } else {
            this.config.autoDelete = value === 'on';
            updated = true;
            message = `✅ 自动删除已${this.config.autoDelete ? '开启' : '关闭'}`;
          }
          break;

        default:
          message = `❌ 未知配置选项: ${htmlEscape(option)}`;
      }

      if (updated) {
        await this.saveConfig();
      }

      await msg.edit({ text: message, parseMode: "html" });
    } catch (error: any) {
      await msg.edit({
        text: `❌ <b>配置失败:</b> ${htmlEscape(error.message)}`,
        parseMode: "html"
      });
    }
  }

  private async handleBatchConvert(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;

    try {
      // 检查是否回复了消息
      if (!msg.replyTo || !('replyToMsgId' in msg.replyTo)) {
        await msg.edit({
          text: `❌ <b>请回复包含图片的消息</b>\n\n使用方法:\n1. 回复包含多张图片的消息\n2. 发送 <code>${mainPrefix}pts batch</code>`,
          parseMode: "html"
        });
        return;
      }

      await msg.edit({ text: "🔄 正在批量处理图片...", parseMode: "html" });

      // 获取回复的消息
      const replyMsgId = msg.replyTo.replyToMsgId;
      const messages = await client.getMessages(msg.peerId!, {
        ids: [replyMsgId]
      } as any);

      if (!messages || messages.length === 0) {
        await msg.edit({ text: "❌ 无法获取回复的消息", parseMode: "html" });
        return;
      }

      const targetMsg = messages[0];
      let processedCount = 0;
      let failedCount = 0;

      // 处理消息中的所有媒体
      if (targetMsg.media) {
        if (targetMsg.media instanceof Api.MessageMediaPhoto) {
          // 单张图片
          const result = await this.processImage(targetMsg, this.config.defaultEmoji);
          if (result) {
            await client.sendFile(msg.peerId!, {
              file: result.path,
              attributes: [new Api.DocumentAttributeSticker({
                alt: this.config.defaultEmoji,
                stickerset: new Api.InputStickerSetEmpty()
              })],
              replyTo: msg.id
            });
            processedCount++;
            // 清理临时文件
            if (fs.existsSync(result.path)) {
              fs.unlinkSync(result.path);
            }
          } else {
            failedCount++;
          }
        } else if ((targetMsg as any).groupedId) {
          // 媒体组（多张图片）
          const groupMessages = await client.getMessages(msg.peerId!, {
            limit: 10,
            offsetId: targetMsg.id
          } as any);

          for (const groupMsg of groupMessages) {
            if ((groupMsg as any).groupedId === (targetMsg as any).groupedId && 
                groupMsg.media instanceof Api.MessageMediaPhoto) {
              const result = await this.processImage(groupMsg, this.config.defaultEmoji);
              if (result) {
                await client.sendFile(msg.peerId!, {
                  file: result.path,
                  attributes: [new Api.DocumentAttributeSticker({
                    alt: this.config.defaultEmoji,
                    stickerset: new Api.InputStickerSetEmpty()
                  })],
                  replyTo: msg.id
                });
                processedCount++;
                // 清理临时文件
                if (fs.existsSync(result.path)) {
                  fs.unlinkSync(result.path);
                }
                await sleep(500); // 避免发送过快
              } else {
                failedCount++;
              }
            }
          }
        }
      }

      const resultMessage = processedCount > 0 
        ? `✅ <b>批量转换完成</b>\n\n成功: ${processedCount} 张\n失败: ${failedCount} 张`
        : `❌ 未找到可转换的图片`;

      await msg.edit({ text: resultMessage, parseMode: "html" });

      if (this.config.autoDelete && processedCount > 0) {
        await sleep(3000);
        await msg.delete();
      }
    } catch (error: any) {
      console.error("[pic_to_sticker] 批量转换失败:", error);
      await msg.edit({
        text: `❌ <b>批量转换失败:</b> ${htmlEscape(error.message)}`,
        parseMode: "html"
      });
    }
  }

  private async convertSingleImage(msg: Api.Message, emoji: string): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;

    try {
      let targetMsg = msg;
      
      // 检查是否回复了消息
      if (msg.replyTo && 'replyToMsgId' in msg.replyTo && msg.replyTo.replyToMsgId) {
        const replyMsgId = msg.replyTo.replyToMsgId;
        const messages = await client.getMessages(msg.peerId!, {
          ids: [replyMsgId]
        });
        
        if (messages && messages.length > 0) {
          targetMsg = messages[0];
        }
      }

      // 检查是否有图片
      if (!targetMsg.media || !(targetMsg.media instanceof Api.MessageMediaPhoto)) {
        await msg.edit({
          text: `❌ <b>请回复一张图片</b>\n\n💡 使用 <code>${mainPrefix}pts help</code> 查看帮助`,
          parseMode: "html"
        });
        return;
      }

      await msg.edit({ text: "🔍 正在分析图片...", parseMode: "html" });

      // 处理图片
      const result = await this.processImage(targetMsg, emoji);
      if (!result) {
        await msg.edit({ text: "❌ 图片处理失败", parseMode: "html" });
        return;
      }

      await msg.edit({ text: "📤 正在发送贴纸...", parseMode: "html" });

      // 发送贴纸
      await client.sendFile(msg.peerId!, {
        file: result.path,
        attributes: [
          new Api.DocumentAttributeSticker({
            alt: emoji,
            stickerset: new Api.InputStickerSetEmpty()
          })
        ],
        replyTo: msg.id
      });

      // 清理临时文件
      if (fs.existsSync(result.path)) {
        fs.unlinkSync(result.path);
      }

      // 自动删除原消息
      if (this.config.autoDelete) {
        await msg.delete();
      } else {
        await msg.edit({ text: `✅ 贴纸已发送 ${emoji}`, parseMode: "html" });
      }

    } catch (error: any) {
      console.error("[pic_to_sticker] 转换失败:", error);
      
      let errorMsg = "❌ <b>转换失败</b>";
      
      if (error.message?.includes('MEDIA_INVALID')) {
        errorMsg = "❌ <b>无效的媒体文件</b>";
      } else if (error.message?.includes('FILE_PARTS_INVALID')) {
        errorMsg = "❌ <b>文件损坏或格式不支持</b>";
      } else if (error.message?.includes('PHOTO_INVALID')) {
        errorMsg = "❌ <b>无效的图片文件</b>";
      } else if (error.message?.includes('FLOOD_WAIT')) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        errorMsg = `❌ <b>请求过于频繁</b>\n\n请等待 ${waitTime} 秒后重试`;
      }
      
      await msg.edit({ text: errorMsg, parseMode: "html" });
    }
  }

  private async processImage(msg: Api.Message, emoji: string): Promise<{ path: string } | null> {
    const client = await getGlobalClient();
    if (!client || !msg.media) return null;

    try {
      const timestamp = Date.now();
      const originalPath = path.join(this.tempDir, `pic_${timestamp}_${Math.random().toString(36).substring(7)}.jpg`);
      const stickerPath = path.join(this.tempDir, `sticker_${timestamp}_${Math.random().toString(36).substring(7)}.webp`);

      // 下载图片
      const buffer = await client.downloadMedia(msg.media, {
        outputFile: originalPath
      });

      if (!buffer || !fs.existsSync(originalPath)) {
        console.error("[pic_to_sticker] 下载失败");
        return null;
      }

      // 使用 sharp 处理图片
      try {
        // 获取图片信息
        const metadata = await sharp(originalPath).metadata();
        const isAnimated = metadata.pages && metadata.pages > 1;

        if (isAnimated) {
          // 处理动图（GIF）
          await sharp(originalPath, { animated: true })
            .resize(this.config.size, this.config.size, {
              fit: 'contain',
              background: this.config.background === 'transparent' 
                ? { r: 0, g: 0, b: 0, alpha: 0 }
                : this.config.background === 'white'
                ? { r: 255, g: 255, b: 255, alpha: 1 }
                : { r: 0, g: 0, b: 0, alpha: 1 }
            })
            .webp({
              quality: this.config.quality,
              effort: this.config.compressionLevel
            })
            .toFile(stickerPath);
        } else {
          // 处理静态图片
          let pipeline = sharp(originalPath)
            .resize(this.config.size, this.config.size, {
              fit: 'contain',
              background: this.config.background === 'transparent' 
                ? { r: 0, g: 0, b: 0, alpha: 0 }
                : this.config.background === 'white'
                ? { r: 255, g: 255, b: 255, alpha: 1 }
                : { r: 0, g: 0, b: 0, alpha: 1 }
            });

          // 确保输出为正方形
          pipeline = pipeline.extend({
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            background: this.config.background === 'transparent' 
              ? { r: 0, g: 0, b: 0, alpha: 0 }
              : this.config.background === 'white'
              ? { r: 255, g: 255, b: 255, alpha: 1 }
              : { r: 0, g: 0, b: 0, alpha: 1 }
          });

          // 转换为 WebP
          await pipeline
            .webp({
              quality: this.config.quality,
              effort: this.config.compressionLevel,
              lossless: false
            })
            .toFile(stickerPath);
        }

        // 清理原始文件
        if (fs.existsSync(originalPath)) {
          fs.unlinkSync(originalPath);
        }

        // 检查输出文件
        if (!fs.existsSync(stickerPath)) {
          console.error("[pic_to_sticker] 转换失败，输出文件不存在");
          return null;
        }

        // 检查文件大小（Telegram 贴纸限制）
        const stats = fs.statSync(stickerPath);
        if (stats.size > 512 * 1024) { // 512KB 限制
          console.log("[pic_to_sticker] 文件过大，尝试降低质量...");
          
          // 降低质量重新处理
          await sharp(originalPath)
            .resize(this.config.size, this.config.size, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .webp({
              quality: Math.floor(this.config.quality * 0.7),
              effort: 6
            })
            .toFile(stickerPath);
        }

        return { path: stickerPath };

      } catch (sharpError: any) {
        console.error("[pic_to_sticker] Sharp 处理失败:", sharpError);
        
        // 清理文件
        if (fs.existsSync(originalPath)) {
          fs.unlinkSync(originalPath);
        }
        if (fs.existsSync(stickerPath)) {
          fs.unlinkSync(stickerPath);
        }
        
        return null;
      }

    } catch (error) {
      console.error("[pic_to_sticker] 处理图片失败:", error);
      return null;
    }
  }
}

export default new PicToStickerPlugin();

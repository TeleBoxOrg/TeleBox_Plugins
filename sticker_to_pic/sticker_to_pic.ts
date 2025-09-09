import { Plugin } from "../src/utils/pluginBase";
import { getGlobalClient } from "../src/utils/globalClient";
import { getPrefixes } from "../src/utils/pluginManager";
import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as os from "os";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义工具
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 自动安装ImageMagick（静默安装，无需用户干预）
const ensureImageMagick = async (showProgress: boolean = false, msg?: Api.Message): Promise<boolean> => {
  try {
    // 检查是否已安装
    execSync('which convert', { stdio: 'ignore' });
    return true;
  } catch (error) {
    console.log('[sticker_to_pic] ImageMagick未安装，正在自动安装...');
    
    if (showProgress && msg) {
      await msg.edit({ text: "⚙️ 正在自动安装ImageMagick依赖...", parseMode: "html" });
    }
    
    try {
      const platform = os.platform();
      
      if (platform === 'linux') {
        // Ubuntu/Debian系统
        try {
          // 尝试使用sudo（如果可用）
          try {
            execSync('sudo -n true', { stdio: 'ignore' });
            execSync('sudo apt-get update && sudo apt-get install -y imagemagick', { stdio: 'pipe' });
          } catch {
            // 无sudo权限，尝试直接安装
            execSync('apt-get update && apt-get install -y imagemagick', { stdio: 'pipe' });
          }
          console.log('[sticker_to_pic] ImageMagick自动安装成功 (apt)');
          return true;
        } catch (aptError) {
          // 尝试yum (CentOS/RHEL)
          try {
            try {
              execSync('sudo -n true', { stdio: 'ignore' });
              execSync('sudo yum install -y ImageMagick', { stdio: 'pipe' });
            } catch {
              execSync('yum install -y ImageMagick', { stdio: 'pipe' });
            }
            console.log('[sticker_to_pic] ImageMagick自动安装成功 (yum)');
            return true;
          } catch (yumError) {
            // 尝试dnf (Fedora)
            try {
              try {
                execSync('sudo -n true', { stdio: 'ignore' });
                execSync('sudo dnf install -y ImageMagick', { stdio: 'pipe' });
              } catch {
                execSync('dnf install -y ImageMagick', { stdio: 'pipe' });
              }
              console.log('[sticker_to_pic] ImageMagick自动安装成功 (dnf)');
              return true;
            } catch (dnfError) {
              console.error('[sticker_to_pic] Linux系统自动安装失败，可能需要手动安装');
              return false;
            }
          }
        }
      } else if (platform === 'darwin') {
        // macOS系统
        try {
          // 检查是否有Homebrew
          execSync('which brew', { stdio: 'ignore' });
          execSync('brew install imagemagick', { stdio: 'pipe' });
          console.log('[sticker_to_pic] ImageMagick自动安装成功 (brew)');
          return true;
        } catch (brewError) {
          // 尝试安装Homebrew后再安装ImageMagick
          try {
            console.log('[sticker_to_pic] 正在安装Homebrew...');
            execSync('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', { stdio: 'pipe' });
            execSync('brew install imagemagick', { stdio: 'pipe' });
            console.log('[sticker_to_pic] ImageMagick自动安装成功 (brew)');
            return true;
          } catch {
            console.error('[sticker_to_pic] macOS自动安装失败');
            return false;
          }
        }
      } else if (platform === 'win32') {
        // Windows系统 - 尝试使用chocolatey或scoop
        try {
          execSync('where choco', { stdio: 'ignore' });
          execSync('choco install imagemagick -y', { stdio: 'pipe' });
          console.log('[sticker_to_pic] ImageMagick自动安装成功 (chocolatey)');
          return true;
        } catch {
          try {
            execSync('where scoop', { stdio: 'ignore' });
            execSync('scoop install imagemagick', { stdio: 'pipe' });
            console.log('[sticker_to_pic] ImageMagick自动安装成功 (scoop)');
            return true;
          } catch {
            console.error('[sticker_to_pic] Windows系统需要手动安装ImageMagick');
            return false;
          }
        }
      } else {
        console.error('[sticker_to_pic] 不支持的操作系统');
        return false;
      }
    } catch (installError) {
      console.error('[sticker_to_pic] ImageMagick自动安装出错:', installError);
      return false;
    }
  }
};

// 帮助文档
const help_text = `🖼️ <b>贴纸转图片插件</b>

<b>📝 功能描述:</b>
• 🔄 <b>格式转换</b>：将Telegram贴纸转换为JPG/PNG图片
• 🎨 <b>透明处理</b>：支持保持或移除透明背景
• 📄 <b>文档模式</b>：支持以文档形式发送原图
• ⚡ <b>自动安装</b>：自动检测并安装ImageMagick依赖

<b>🔧 使用方法:</b>
• <code>${mainPrefix}sticker_to_pic</code> - 转换为JPG（回复贴纸）
• <code>${mainPrefix}stp</code> - 快捷命令
• <code>${mainPrefix}stp png</code> - 转换为PNG格式
• <code>${mainPrefix}stp transparent</code> - PNG格式保持透明
• <code>${mainPrefix}stp doc</code> - 以文档形式发送源文件

<b>💡 示例:</b>
• <code>${mainPrefix}stp</code> - 转换为JPG图片
• <code>${mainPrefix}stp png</code> - 转换为PNG图片
• <code>${mainPrefix}stp transparent</code> - PNG透明背景
• <code>${mainPrefix}stp doc</code> - 文档模式发送

<b>🔄 管理命令:</b>
• <code>${mainPrefix}stp help</code> - 显示此帮助

<b>📋 支持格式:</b>
• 输入：WebP贴纸文件
• 输出：JPG（默认）、PNG
• 透明：仅PNG格式支持

<b>⚙️ 系统要求:</b>
• ImageMagick（自动安装）
• 支持Linux/macOS自动安装`;

class StickerToPicPlugin extends Plugin {
  description: string = help_text;
  
  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    "sticker_to_pic": this.handleStickerToPic.bind(this),
    "stp": this.handleStickerToPic.bind(this),
  };

  private async handleStickerToPic(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
      return;
    }

    // 参数解析（严格按acron.ts模式）
    const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
    const parts = lines?.[0]?.split(/\s+/) || [];
    const [, ...args] = parts; // 跳过命令本身
    const sub = (args[0] || "").toLowerCase();

    try {
      // 无参数时处理贴纸转换
      if (!sub) {
        await this.processStickerConversion(msg, client, 'jpg', false, false);
        return;
      }

      // 明确请求帮助时才显示
      if (sub === "help" || sub === "h") {
        await msg.edit({
          text: help_text,
          parseMode: "html"
        });
        return;
      }

      // 隐藏的检查命令（不在帮助文档中显示）
      if (sub === "check") {
        await msg.edit({ text: "🔍 正在检查ImageMagick状态...", parseMode: "html" });
        
        // 首先检查是否已安装
        try {
          execSync('which convert', { stdio: 'ignore' });
          // 已安装，获取版本信息
          try {
            const version = execSync('convert -version', { encoding: 'utf8' });
            const versionLine = version.split('\n')[0];
            await msg.edit({
              text: `✅ <b>ImageMagick状态正常</b>\n\n<b>版本信息:</b>\n<code>${htmlEscape(versionLine)}</code>\n\n🎯 <b>功能状态:</b> 可正常使用贴纸转换功能`,
              parseMode: "html"
            });
          } catch (error) {
            await msg.edit({
              text: "✅ <b>ImageMagick已安装</b>\n\n⚠️ 无法获取版本信息，但可正常使用",
              parseMode: "html"
            });
          }
        } catch (error) {
          // 未安装，尝试自动安装
          await msg.edit({ text: "❌ <b>ImageMagick未安装</b>\n\n🔄 正在自动安装，请稍候...", parseMode: "html" });
          
          const isInstalled = await ensureImageMagick(true, msg);
          if (isInstalled) {
            try {
              const version = execSync('convert -version', { encoding: 'utf8' });
              const versionLine = version.split('\n')[0];
              await msg.edit({
                text: `🎉 <b>ImageMagick自动安装成功！</b>\n\n<b>版本信息:</b>\n<code>${htmlEscape(versionLine)}</code>\n\n✅ <b>状态:</b> 现在可以正常使用贴纸转换功能`,
                parseMode: "html"
              });
            } catch (versionError) {
              await msg.edit({
                text: "🎉 <b>ImageMagick自动安装成功！</b>\n\n✅ <b>状态:</b> 现在可以正常使用贴纸转换功能",
                parseMode: "html"
              });
            }
          } else {
            const platform = os.platform();
            let installCmd = '';
            let platformName = '';
            
            if (platform === 'linux') {
              installCmd = 'sudo apt install imagemagick';
              platformName = 'Linux';
            } else if (platform === 'darwin') {
              installCmd = 'brew install imagemagick';
              platformName = 'macOS';
            } else if (platform === 'win32') {
              installCmd = '请访问 https://imagemagick.org/script/download.php#windows';
              platformName = 'Windows';
            } else {
              installCmd = '请查阅官方文档安装ImageMagick';
              platformName = '未知系统';
            }
            
            await msg.edit({
              text: `❌ <b>ImageMagick自动安装失败</b>\n\n<b>检测到系统:</b> ${platformName}\n<b>手动安装命令:</b>\n<code>${htmlEscape(installCmd)}</code>`,
              parseMode: "html"
            });
          }
        }
        return;
      }

      // 解析转换参数
      let outputFormat = 'jpg';
      let keepTransparency = false;
      let sendAsDocument = false;

      if (sub === 'png') {
        outputFormat = 'png';
        keepTransparency = args.includes('transparent');
      } else if (sub === 'transparent') {
        outputFormat = 'png';
        keepTransparency = true;
      } else if (sub === 'doc') {
        sendAsDocument = true;
        if (args.includes('png')) {
          outputFormat = 'png';
          keepTransparency = args.includes('transparent');
        }
      } else {
        // 未知子命令，提示错误
        await msg.edit({
          text: `❌ <b>未知命令:</b> <code>${htmlEscape(sub)}</code>\n\n💡 使用 <code>${mainPrefix}stp help</code> 查看帮助`,
          parseMode: "html"
        });
        return;
      }

      await this.processStickerConversion(msg, client, outputFormat, keepTransparency, sendAsDocument);

    } catch (error: any) {
      console.error("[sticker_to_pic] 插件执行失败:", error);
      await msg.edit({
        text: `❌ <b>插件执行失败:</b> ${htmlEscape(error.message)}`,
        parseMode: "html"
      });
    }
  }

  private async processStickerConversion(
    msg: Api.Message, 
    client: any, 
    outputFormat: string, 
    keepTransparency: boolean, 
    sendAsDocument: boolean
  ): Promise<void> {
    try {
       
      let targetMsg = msg;
      
      if (msg.replyTo && 'replyToMsgId' in msg.replyTo && msg.replyTo.replyToMsgId) {
        try {
          const replyMsgId = msg.replyTo.replyToMsgId;
          const messages = await client.getMessages(msg.peerId!, {
            ids: [replyMsgId]
          });
          
          if (messages && messages.length > 0) {
            targetMsg = messages[0];
          }
        } catch (error) {
          console.error("[sticker_to_pic] 获取回复消息失败:", error);
        }
      }
       
      if (!targetMsg.media || !(targetMsg.media instanceof Api.MessageMediaDocument)) {
        await msg.edit({
          text: `❌ <b>请回复一个贴纸消息</b>\n\n<b>用法:</b>\n1. 回复贴纸消息并使用 <code>${mainPrefix}stp</code>\n2. 发送贴纸后立即使用命令\n\n💡 使用 <code>${mainPrefix}stp help</code> 查看详细帮助`,
          parseMode: "html"
        });
        return;
      }

      const document = targetMsg.media.document;
      if (!(document instanceof Api.Document)) {
        await msg.edit({
          text: "❌ <b>无效的文档类型</b>",
          parseMode: "html"
        });
        return;
      }

      const isSticker = document.attributes?.some(attr => 
        attr instanceof Api.DocumentAttributeSticker
      );
      
      if (!isSticker) {
        await msg.edit({
          text: "❌ <b>这不是一个贴纸文件</b>",
          parseMode: "html"
        });
        return;
      }

      await msg.edit({
        text: "📥 正在下载贴纸...",
        parseMode: "html"
      });

      const tempDir = path.join(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const timestamp = Date.now();
      const stickerPath = path.join(tempDir, `sticker_${timestamp}.webp`);
      const outputPath = path.join(tempDir, `pic_${timestamp}.${outputFormat}`);

      try {
        const buffer = await client.downloadMedia(targetMsg.media, {
          outputFile: stickerPath
        });

        if (!buffer || !fs.existsSync(stickerPath)) {
          await msg.edit({
            text: "❌ <b>贴纸下载失败</b>",
            parseMode: "html"
          });
          return;
        }

        await msg.edit({
          text: `🔄 正在转换为${outputFormat.toUpperCase()}格式...`,
          parseMode: "html"
        });

        // 静默检查并自动安装ImageMagick
        const isImageMagickReady = await ensureImageMagick(false);
        if (!isImageMagickReady) {
          // 如果静默安装失败，显示进度并重试
          await msg.edit({
            text: "⚙️ 正在自动安装ImageMagick依赖，请稍候...",
            parseMode: "html"
          });
          
          const retryInstall = await ensureImageMagick(true, msg);
          if (!retryInstall) {
            const platform = os.platform();
            let installCmd = '';
            
            if (platform === 'linux') {
              installCmd = 'sudo apt install imagemagick';
            } else if (platform === 'darwin') {
              installCmd = 'brew install imagemagick';
            } else if (platform === 'win32') {
              installCmd = '请访问 https://imagemagick.org/script/download.php#windows';
            }
            
            await msg.edit({
              text: `❌ <b>ImageMagick自动安装失败</b>\n\n<b>请手动安装:</b>\n<code>${htmlEscape(installCmd)}</code>`,
              parseMode: "html"
            });
            return;
          }
          
          // 安装成功，继续转换
          await msg.edit({
            text: `🔄 正在转换为${outputFormat.toUpperCase()}格式...`,
            parseMode: "html"
          });
        }


        try {
          let convertCmd: string;
          
          if (outputFormat === 'png') {
            if (keepTransparency) {
              convertCmd = `convert "${stickerPath}" "${outputPath}"`;
            } else {
              convertCmd = `convert "${stickerPath}" -background white -alpha remove "${outputPath}"`;
            }
          } else {
            convertCmd = `convert "${stickerPath}" -background white -alpha remove -alpha off "${outputPath}"`;
          }
          
          execSync(convertCmd, { stdio: 'ignore' });
          
          if (!fs.existsSync(outputPath)) {
            throw new Error('转换失败：输出文件未生成');
          }
          
        } catch (convertError: any) {
          console.error('[sticker_to_pic] ImageMagick转换失败:', convertError);
          await msg.edit({
            text: `❌ <b>贴纸转换失败</b>\n\n<b>错误详情:</b> ${htmlEscape(convertError.message)}\n\n💡 请确保贴纸格式正确`,
            parseMode: "html"
          });
          return;
        }

        await msg.edit({
          text: "📤 正在发送图片...",
          parseMode: "html"
        });

        if (sendAsDocument) {
          // 发送为文档（原图）
          await client.sendFile(msg.peerId!, {
            file: outputPath,
            caption: `📄 <b>贴纸已转换为${outputFormat.toUpperCase()}格式（原图）</b>`,
            replyTo: msg.id,
            forceDocument: true,
            parseMode: "html"
          });
        } else {
          // 发送为图片
          await client.sendFile(msg.peerId!, {
            file: outputPath,
            caption: `🖼️ <b>贴纸已转换为${outputFormat.toUpperCase()}格式</b>${keepTransparency ? '（透明背景）' : ''}`,
            replyTo: msg.id,
            parseMode: "html"
          });
        }

        await msg.delete();
        
      } finally {
        try {
          if (fs.existsSync(stickerPath)) {
            fs.unlinkSync(stickerPath);
          }
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
        } catch (cleanupError) {
          console.error('[sticker_to_pic] 清理临时文件失败:', cleanupError);
        }
      }
    } catch (error: any) {
      console.error("[sticker_to_pic] 处理贴纸转换失败:", error);
      
      let errorMsg = "❌ <b>转换贴纸为图片时出现错误</b>";
      
      if (error.message.includes('MEDIA_INVALID')) {
        errorMsg = "❌ <b>无效的媒体文件</b>";
      } else if (error.message.includes('FILE_PARTS_INVALID')) {
        errorMsg = "❌ <b>文件损坏或格式不支持</b>";
      } else if (error.message.includes('DOCUMENT_INVALID')) {
        errorMsg = "❌ <b>无效的文档文件</b>";
      } else {
        errorMsg += `\n\n<b>错误详情:</b> ${htmlEscape(error.message)}`;
      }
      
      await msg.edit({
        text: errorMsg,
        parseMode: "html"
      });
    }
  };
}

export default new StickerToPicPlugin();

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { Api } from "telegram";
import { Buffer } from "buffer";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CustomFile } from "telegram/client/uploads";

const execAsync = promisify(exec);

// HTML转义函数
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// 检查并安装依赖
async function ensureDependencies(): Promise<void> {
  const missingDeps: string[] = [];
  
  try {
    await execAsync('which qrencode');
  } catch (error) {
    missingDeps.push('qrencode');
  }
  
  try {
    await execAsync('which zbarimg');
  } catch (error) {
    missingDeps.push('zbar-tools/zbar');
  }
  
  if (missingDeps.length > 0) {
    const platform = process.platform;
    let installCmd = '';
    
    if (platform === 'darwin') {
      // macOS
      installCmd = 'brew install qrencode zbar';
    } else if (platform === 'linux') {
      // Linux - 检测发行版
      try {
        await execAsync('which apt-get');
        installCmd = 'sudo apt-get update && sudo apt-get install qrencode zbar-tools';
      } catch {
        try {
          await execAsync('which yum');
          installCmd = 'sudo yum install qrencode zbar';
        } catch {
          try {
            await execAsync('which dnf');
            installCmd = 'sudo dnf install qrencode zbar';
          } catch {
            installCmd = '请使用您的包管理器安装 qrencode 和 zbar-tools';
          }
        }
      }
    } else {
      installCmd = '请在您的系统上安装 qrencode 和 zbar 工具';
    }
    
    throw new Error(`❌ 缺少依赖: ${missingDeps.join(', ')}\n\n📦 安装命令:\n${installCmd}\n\n💡 安装完成后请重试`);
  }
}

// 生成二维码
async function generateQRCode(text: string): Promise<Buffer> {
  await ensureDependencies();
  
  const tempFile = join(tmpdir(), `qr_${Date.now()}.png`);
  
  try {
    // 使用qrencode生成二维码
    await execAsync(`qrencode -o "${tempFile}" -s 6 -m 2 "${text}"`);
    
    if (!existsSync(tempFile)) {
      throw new Error('二维码生成失败');
    }
    
    const imageBuffer = readFileSync(tempFile);
    unlinkSync(tempFile); // 清理临时文件
    
    return imageBuffer;
  } catch (error) {
    // 清理临时文件
    if (existsSync(tempFile)) {
      unlinkSync(tempFile);
    }
    throw error;
  }
}

// 检测编码问题的辅助函数
function hasEncodingIssues(text: string): boolean {
  // 检测常见的乱码字符
  const garbledChars = ['螂', '蟾', 'ｴ', 'ｬ', '･'];
  return garbledChars.some(char => text.includes(char)) || 
         /[\u00C0-\u00FF]{2,}/.test(text) || // 检测连续的Latin-1字符
         /[\uFFFD]/.test(text); // 检测替换字符
}

// 解码二维码
async function decodeQRCode(imageBuffer: Buffer): Promise<string[]> {
  await ensureDependencies();
  
  const tempFile = join(tmpdir(), `qr_decode_${Date.now()}.png`);
  
  try {
    // 保存图片到临时文件
    writeFileSync(tempFile, imageBuffer);
    
    // 使用zbarimg解码二维码，设置环境变量确保UTF-8编码
    const env = { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' };
    const { stdout } = await execAsync(`zbarimg "${tempFile}"`, { 
      encoding: 'utf8',
      env: env
    });
    
    unlinkSync(tempFile); // 清理临时文件
    
    if (!stdout.trim()) {
      return [];
    }
    
    // 解析输出，格式通常是 "QR-Code:内容"
    // 确保正确处理UTF-8编码的字符
    const results = stdout.trim().split('\n')
      .map(line => {
        const content = line.replace(/^QR-Code:/, '').trim();
        
        // 检测并修复编码问题
         if (hasEncodingIssues(content)) {
           // 尝试多种解码方式修复编码问题
           const attempts = [
             // 尝试从ISO-8859-1转UTF-8 (常见于Linux系统)
             () => Buffer.from(content, 'latin1').toString('utf8'),
             // 尝试从Windows-1252转UTF-8
             () => Buffer.from(content, 'binary').toString('utf8'),
             // 尝试处理双重编码问题
             () => Buffer.from(Buffer.from(content, 'latin1').toString('utf8'), 'latin1').toString('utf8'),
             // 原始内容
             () => content
           ];
           
           for (const attempt of attempts) {
             try {
               const decoded = attempt();
               // 检查解码结果是否合理
               if (!hasEncodingIssues(decoded) && decoded.length > 0) {
                 return decoded;
               }
             } catch {
               continue;
             }
           }
         }
        
        return content;
      })
      .filter(line => line.length > 0);
    
    return results;
  } catch (error) {
    // 清理临时文件
    if (existsSync(tempFile)) {
      unlinkSync(tempFile);
    }
    
    // 如果是因为没有找到二维码，返回空数组
    if (error instanceof Error && error.message.includes('no symbols')) {
      return [];
    }
    
    throw error;
  }
}

class QRPlugin extends Plugin {
  description: string = `📱 QR 二维码插件
从 Python 版本转换而来，支持二维码生成和解码功能。
使用前请先安装依赖。

━━━ 核心功能 ━━━
• <code>qr &lt;文本&gt;</code> - 直接生成二维码
• 回复文本消息使用 <code>qr</code> - 将消息内容转为二维码
• 回复图片使用 <code>qr</code> - 解码图中的二维码内容

━━━ 功能特性 ━━━
• 📱 <b>生成二维码</b> - 将文本转换为二维码图片
• 🔍 <b>解码二维码</b> - 从图片中识别和解码二维码内容
• 💬 <b>多种使用方式</b> - 支持命令参数、回复消息等多种交互方式

━━━ 系统依赖 ━━━
<b>macOS:</b>
<code>brew install qrencode zbar</code>

<b>Ubuntu/Debian:</b>
<code>sudo apt-get install qrencode zbar-tools</code>

<b>CentOS/RHEL:</b>
<code>sudo yum install qrencode zbar</code>

━━━ 使用示例 ━━━
• 生成二维码: <code>qr Hello World</code>
• 解码二维码: 回复包含二维码的图片并发送 <code>qr</code>
• 文本转码: 回复文本消息并发送 <code>qr</code>`;

  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    qr: async (msg) => {
      try {
        const args = msg.message.split(' ').slice(1);
        const textToEncode = args.join(' ');
        const replied = msg.replyTo ? await msg.getReplyMessage() : null;

        // 1. 优先处理命令后的文本 (编码)
        if (textToEncode) {
          await msg.edit({
            text: '⏳ 正在生成二维码...'
          });
          try {
            const imageBuffer = await generateQRCode(textToEncode);
            await msg.reply({
              file: new CustomFile('qrcode.png', imageBuffer.length, '', imageBuffer),
              message: '✅ 二维码生成完成'
            });
            await msg.delete();
          } catch (error: any) {
            const errorMsg = error.message || '未知错误';
            await msg.edit({
              text: `❌ <b>生成二维码失败</b>\n\n${errorMsg.includes('❌') ? errorMsg : `<code>${htmlEscape(errorMsg)}</code>`}`,
              parseMode: 'html'
            });
          }
          return;
        }

        // 2. 检查消息本身或回复中是否附带媒体文件 (解码)
        let mediaToProcess = null;
        if (msg.photo || msg.sticker || msg.document) {
          mediaToProcess = msg;
        } else if (replied && (replied.photo || replied.sticker || replied.document)) {
          mediaToProcess = replied;
        }

        if (mediaToProcess) {
          const client = await getGlobalClient();
          if (!client) {
            await msg.edit({
              text: "❌ 客户端未初始化"
            });
            return;
          }

          await msg.edit({
            text: '⏳ 正在解码二维码...'
          });
          try {
            const imageBuffer = await client.downloadMedia(mediaToProcess, {
              outputFile: Buffer.alloc(0)
            }) as Buffer;
            
            const decodedData = await decodeQRCode(imageBuffer);

            if (decodedData.length > 0) {
              const resultText = decodedData
                .map(data => `<code>${htmlEscape(data)}</code>`)
                .join('\n\n');
              await msg.edit({
                text: `✅ <b>成功解码二维码:</b>\n\n${resultText}`,
                parseMode: 'html'
              });
            } else {
              await msg.edit({
                text: '🤷‍♀️ 未在此图片中识别到二维码。'
              });
            }
          } catch (error: any) {
            const errorMsg = error.message || '未知错误';
            await msg.edit({
              text: `❌ <b>解码失败</b>\n\n${errorMsg.includes('❌') ? errorMsg : `<code>${htmlEscape(errorMsg)}</code>`}`,
              parseMode: 'html'
            });
          }
          return;
        }

        // 3. 检查回复的是否是纯文本 (编码)
        if (replied && replied.message) {
          await msg.edit({
            text: '⏳ 正在生成二维码...'
          });
          try {
            const imageBuffer = await generateQRCode(replied.message);
            await replied.reply({
              file: new CustomFile('qrcode.png', imageBuffer.length, '', imageBuffer),
              message: '✅ 二维码生成完成'
            });
            await msg.delete();
          } catch (error: any) {
            const errorMsg = error.message || '未知错误';
            await msg.edit({
              text: `❌ <b>生成二维码失败</b>\n\n${errorMsg.includes('❌') ? errorMsg : `<code>${htmlEscape(errorMsg)}</code>`}`,
              parseMode: 'html'
            });
          }
          return;
        }

        // 4. 如果没有任何有效输入，显示帮助信息
        await msg.edit({
          text: 'ℹ️ <b>QR 工具使用方法:</b>\n\n' +
            '• <code>qr &lt;文本&gt;</code>\n  (将文本转为二维码)\n\n' +
            '• 回复文本消息使用 <code>qr</code>\n  (将消息内容转为二维码)\n\n' +
            '• 回复图片/贴纸使用 <code>qr</code>\n  (解码图中的二维码)',
          parseMode: 'html'
        });
      } catch (error: any) {
        console.error('QR Plugin Error:', error);
        const errorMsg = error.message || '未知错误';
        await msg.edit({
          text: `❌ <b>插件执行失败</b>\n\n${errorMsg.includes('❌') ? errorMsg : `<code>${htmlEscape(errorMsg)}</code>`}`,
          parseMode: 'html'
        });
      }
    }
  };
}

export default new QRPlugin();

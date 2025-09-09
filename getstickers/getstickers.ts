import { Plugin } from "../src/utils/pluginBase";
import { getGlobalClient } from "../src/utils/globalClient";
import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream";
import { promisify } from "util";
import archiver from "archiver";
import bigInt from "big-integer";
import { CustomFile } from "telegram/client/uploads";


class GetStickersPlugin extends Plugin {
  description: string = `🧩 <b>贴纸包打包下载</b><br/><br/>
<b>命令</b><br/>
• <code>.getstickers</code>（回复任意贴纸）<br/><br/>
<b>功能</b><br/>
• 从回复的贴纸中识别贴纸包并下载全部贴纸<br/>
• 自动生成 pack.txt 与全部资源，并以 ZIP 发送<br/><br/>
<b>用法</b><br/>
1) 回复一张贴纸并发送 <code>.getstickers</code><br/><br/>
<b>注意</b><br/>
• 若贴纸包很大，处理时间较长，请耐心等待`;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    "getstickers": this.handleGetStickers.bind(this),
  };

  private async handleGetStickers(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    
    if (!client) {
      await msg.edit({
        text: "❌ 客户端未初始化"
      });
      return;
    }
    
    try {

      const dataDir = path.join(process.cwd(), 'data', 'sticker');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      let sticker: Api.Document | null = null;
      

      if (msg.replyTo && 'replyToMsgId' in msg.replyTo && msg.replyTo.replyToMsgId) {
        try {
          const replyMsgId = msg.replyTo.replyToMsgId;
          const messages = await client.getMessages(msg.peerId!, {
            ids: [replyMsgId]
          });
          
          if (messages && messages.length > 0) {
            const replyMsg = messages[0];
            if (replyMsg.sticker) {
              sticker = replyMsg.sticker;
            } else if (replyMsg.document && replyMsg.document.mimeType?.includes('sticker')) {
              sticker = replyMsg.document;
            }
          }
        } catch (error) {
          console.error('Failed to get reply message:', error);
        }
      } else if (msg.sticker) {
        sticker = msg.sticker;
      } else if (msg.document && msg.document.mimeType?.includes('sticker')) {
        sticker = msg.document;
      }
      
      if (!sticker) {
        await msg.edit({
          text: "请回复一张贴纸。"
        });
        return;
      }
      

      const stickerSetName = this.getStickerSetName(sticker);
      if (!stickerSetName) {
        await msg.edit({
          text: "回复的贴纸不属于任何贴纸包。"
        });
        return;
      }
      
      await this.downloadStickers(client, msg, stickerSetName);
      
    } catch (error) {
      console.error("GetStickers plugin error:", error);
      
      await msg.edit({
        text: "❌ 处理贴纸时出现错误"
      });
    }
  }
  
  private getStickerSetName(sticker: Api.Document): string | null {
    if (sticker.attributes) {
      for (const attr of sticker.attributes) {
        if (attr instanceof Api.DocumentAttributeSticker && attr.stickerset) {
          console.log('贴纸包类型:', attr.stickerset.constructor.name);
          
          // 优先使用shortName，这与Python版本一致
          if (attr.stickerset instanceof Api.InputStickerSetShortName) {
            console.log('找到贴纸包名称:', attr.stickerset.shortName);
            return attr.stickerset.shortName;
          } else if (attr.stickerset instanceof Api.InputStickerSetEmpty) {
            console.log('空贴纸包，跳过');
            continue;
          } else if (attr.stickerset && typeof attr.stickerset === 'object') {
            // 处理VirtualClass和其他类型的贴纸包
            const stickerSet = attr.stickerset as any;
            
            // 尝试多种属性名称来获取贴纸包名称
            if (stickerSet.shortName && typeof stickerSet.shortName === 'string') {
              console.log('从对象提取贴纸包名称 (shortName):', stickerSet.shortName);
              return stickerSet.shortName;
            }
            
            // 对于VirtualClass类型，尝试其他可能的属性
            if (stickerSet.short_name && typeof stickerSet.short_name === 'string') {
              console.log('从对象提取贴纸包名称 (short_name):', stickerSet.short_name);
              return stickerSet.short_name;
            }
            
            // 如果有id/access_hash属性，尝试通过id+access_hash获取贴纸包信息
            const toPlainString = (v: any): string | null => {
              if (v === undefined || v === null) return null;
              if (typeof v === 'string') return v;
              if (typeof v === 'number') return String(v);
              if (typeof v === 'bigint') return v.toString();
              try {
                // 常见: { value: 123n }
                if (typeof v.value !== 'undefined') {
                  const val = v.value;
                  if (typeof val === 'bigint') return val.toString();
                  if (typeof val === 'number' || typeof val === 'string') return String(val);
                }
                const s = v.toString?.();
                if (s && !s.includes('[object')) return s;
              } catch {}
              return String(v);
            };
            const idVal = toPlainString(stickerSet.id) || toPlainString(stickerSet._id);
            const hashVal = toPlainString(stickerSet.accessHash) || toPlainString(stickerSet.access_hash);
            if (idVal && hashVal) {
              console.log('找到贴纸包ID与access_hash，将尝试通过ID查询:', idVal, hashVal);
              // 返回一个包含id与hash的特殊标记，让downloadStickers方法处理ID查询
              return `__ID__${idVal}__HASH__${hashVal}`;
            }
            if (idVal) {
              console.log('找到贴纸包ID（缺少access_hash）:', idVal);
              return `__ID__${idVal}`;
            }
            
            console.log('VirtualClass贴纸包对象属性:', Object.keys(stickerSet));
          }
        }
      }
    }
    console.log('未找到贴纸包信息');
    return null;
  }
  
  private async downloadStickers(client: any, msg: Api.Message, stickerSetName: string): Promise<void> {
    try {
      if (!stickerSetName || stickerSetName.trim() === '') {
        await msg.edit({
          text: "❌ 贴纸包名称无效"
        });
        return;
      }
      
      let stickerSetInput;
      
      // 检查是否是ID查询
      if (stickerSetName.startsWith('__ID__')) {
        // 支持两种格式: __ID__<id> 或 __ID__<id>__HASH__<access_hash>
        const match = stickerSetName.match(/^__ID__(.+?)(?:__HASH__(.+))?$/);
        const idStr = match?.[1]?.trim();
        const hashStr = match?.[2]?.trim();
        if (!idStr || !hashStr) {
          console.warn('ID查询缺少access_hash，无法通过ID获取贴纸包，建议通过shortName查询');
          await msg.edit({ text: '❌ 贴纸包信息不足（缺少 access_hash），无法通过ID查询。请回复来源贴纸或尝试使用短名称。' });
          return;
        }
        console.log('使用ID查询贴纸包:', idStr, 'access_hash:', hashStr);
        stickerSetInput = new Api.InputStickerSetID({
          id: bigInt(idStr),
          accessHash: bigInt(hashStr)
        });
      } else {
        // 使用shortName查询，与Python版本保持一致
        console.log('使用短名称查询贴纸包:', stickerSetName.trim());
        stickerSetInput = new Api.InputStickerSetShortName({
          shortName: stickerSetName.trim()
        });
      }
      
      const stickerSet = await client.invoke(
        new Api.messages.GetStickerSet({
          stickerset: stickerSetInput,
          hash: 0
        })
      );
      
      if (!stickerSet || !stickerSet.documents) {
        await msg.edit({
          text: "回复的贴纸不存在于任何贴纸包中。"
        });
        return;
      }
      
      const setInfo = stickerSet.set;
      const documents = stickerSet.documents;
      const packDir = path.join(process.cwd(), 'data', 'sticker', setInfo.shortName);
      
      // 创建贴纸包目录
      if (fs.existsSync(packDir)) {
        fs.rmSync(packDir, { recursive: true, force: true });
      }
      fs.mkdirSync(packDir, { recursive: true });
      
      await msg.edit({
        text: `正在下载 ${setInfo.shortName} 中的 ${setInfo.count} 张贴纸...\n进度：0/${setInfo.count}`
      });
      
      // 构建表情映射
      const emojis: Record<string, string> = {};
      if (stickerSet.packs) {
        for (const pack of stickerSet.packs) {
          for (const docId of pack.documents) {
            emojis[docId.toString()] = pack.emoticon || '';
          }
        }
      }
      
      // 下载所有贴纸（顺序执行以便稳定更新进度）
      const packFile = path.join(packDir, 'pack.txt');
      if (fs.existsSync(packFile)) {
        fs.unlinkSync(packFile);
      }

      const total = documents.length;
      let downloaded = 0;

      for (let index = 0; index < documents.length; index++) {
        const document: Api.Document = documents[index] as Api.Document;
        try {
          // 确定文件扩展名
          let fileExt = 'webp';
          if (document.attributes) {
            for (const attr of document.attributes) {
              if (attr instanceof Api.DocumentAttributeSticker) {
                if ((attr as any).video) {
                  fileExt = 'mp4';
                } else if ((attr as any).animated) {
                  fileExt = 'tgs';
                }
                break;
              }
            }
          }
          
          const fileName = `${index.toString().padStart(3, '0')}.${fileExt}`;
          const filePath = path.join(packDir, fileName);
          
          // 下载贴纸文件
          await client.downloadFile(
            new Api.InputDocumentFileLocation({
              id: document.id,
              accessHash: document.accessHash,
              fileReference: document.fileReference,
              thumbSize: ''
            }),
            {
              outputFile: filePath
            }
          );
          
          // 写入pack.txt
          const emoji = emojis[document.id.toString()] || '';
          const packEntry = `{'image_file': '${fileName}','emojis':${emoji}},\n`;
          fs.appendFileSync(packFile, packEntry);

          downloaded++;
          if (downloaded === 1 || downloaded % 10 === 0 || downloaded === total) {
            await msg.edit({ text: `正在下载 ${setInfo.shortName} 中的 ${setInfo.count} 张贴纸...\n进度：${downloaded}/${total}` });
          }
          
        } catch (error) {
          console.error(`下载贴纸 ${index} 失败:`, error);
        }
      }
      
      // 打包上传
      await this.uploadStickerPack(client, msg, setInfo, packDir);
      
    } catch (error: any) {
      console.error('下载贴纸包失败:', error);
      let errorMessage = "❌ 下载贴纸包时出现错误";
      
      if (error.errorMessage) {
        switch (error.errorMessage) {
          case 'STICKERSET_INVALID':
            errorMessage = `❌ 贴纸包 "${stickerSetName}" 不存在或无效`;
            break;
          case 'STICKERSET_NOT_MODIFIED':
            errorMessage = "❌ 贴纸包未修改";
            break;
          case 'PEER_ID_INVALID':
            errorMessage = "❌ 无效的用户或群组ID";
            break;
          default:
            errorMessage = `❌ 下载失败: ${error.errorMessage}`;
        }
      }
      
      await msg.edit({
        text: errorMessage
      });
    }
  }
  
  private async uploadStickerPack(client: any, msg: Api.Message, setInfo: any, packDir: string): Promise<void> {
    let zipPath: string | undefined;
    try {
      await msg.edit({
        text: "下载完毕，打包上传中。"
      });
      
      zipPath = path.join(path.dirname(packDir), `${setInfo.shortName}.zip`);
      
      // 创建ZIP文件
      await this.createZipFile(packDir, zipPath);
      
      // 检查ZIP文件是否创建成功
      if (!fs.existsSync(zipPath)) {
        throw new Error('ZIP文件创建失败');
      }
      
      const stats = fs.statSync(zipPath);
      if (stats.size === 0) {
        throw new Error('ZIP文件为空');
      }
      
      console.log(`ZIP文件创建成功，大小: ${stats.size} 字节`);
      
      // 检查文件权限和可读性
      try {
        fs.accessSync(zipPath, fs.constants.R_OK);
        console.log('ZIP文件权限检查通过');
      } catch (accessError) {
        throw new Error(`ZIP文件无法读取: ${accessError}`);
      }
      
      // 尝试读取文件的前几个字节来验证文件完整性
       try {
         const buffer = fs.readFileSync(zipPath);
         if (buffer.length === 0) {
           throw new Error('ZIP文件无法读取或为空');
         }
         // 检查ZIP文件头（应该以PK开头）
         if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4B) {
           console.log('ZIP文件完整性检查通过');
         } else {
           throw new Error('ZIP文件格式无效');
         }
       } catch (readError) {
          throw new Error(`ZIP文件读取测试失败: ${readError}`);
        }
        
        // 等待一小段时间确保文件完全写入磁盘
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('文件写入等待完成');
        
        // 上传ZIP文件
        console.log('开始上传ZIP文件...');
      // 使用 CustomFile 以流式上传，避免一次性读入内存导致的 buffer 创建失败
      const fileName = path.basename(zipPath);
      const customFile = new CustomFile(fileName, stats.size, zipPath);
      await client.sendFile(msg.peerId!, {
        file: customFile,
        caption: setInfo.shortName,
        replyTo: msg.replyTo?.replyToMsgId
      });
      console.log('ZIP文件发送成功');
      
      // 清理临时文件
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
      }
      if (fs.existsSync(packDir)) {
        fs.rmSync(packDir, { recursive: true, force: true });
      }
      
      // 删除原消息
      await msg.delete({ revoke: true });
      
    } catch (error: any) {
      console.error('上传贴纸包失败:', error);
      
      // 清理临时文件
      try {
        if (zipPath && fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
          console.log('已清理ZIP文件:', zipPath);
        }
        if (fs.existsSync(packDir)) {
          fs.rmSync(packDir, { recursive: true, force: true });
          console.log('已清理贴纸目录:', packDir);
        }
      } catch (cleanupError) {
        console.error('清理临时文件失败:', cleanupError);
      }
      
      let errorMessage = "❌ 上传贴纸包时出现错误";
      if (error.message) {
        if (error.message.includes('Could not create buffer')) {
          errorMessage = "❌ 文件读取失败，可能是ZIP文件损坏";
        } else {
          errorMessage = `❌ 上传失败: ${error.message}`;
        }
      }
      
      await msg.edit({
        text: errorMessage
      });
    }
  }
  
  private async createZipFile(sourceDir: string, zipPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 检查源目录是否存在
      if (!fs.existsSync(sourceDir)) {
        reject(new Error(`源目录不存在: ${sourceDir}`));
        return;
      }
      
      // 确保目标目录存在
      const zipDir = path.dirname(zipPath);
      if (!fs.existsSync(zipDir)) {
        fs.mkdirSync(zipDir, { recursive: true });
      }
      
      // 创建输出流
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', {
      zlib: { level: 9 } // 最高压缩级别
    });
      
      // 监听错误事件
       output.on('error', (err: Error) => {
         console.error('输出流错误:', err);
         reject(err);
       });
       
       archive.on('error', (err: Error) => {
         console.error('Archive错误:', err);
         reject(err);
       });
      
      // 监听完成事件
      output.on('close', () => {
        console.log(`ZIP文件创建完成，总大小: ${archive.pointer()} 字节`);
        
        // 验证文件是否正确创建
        if (fs.existsSync(zipPath)) {
          const stats = fs.statSync(zipPath);
          if (stats.size > 0) {
            console.log('ZIP文件验证成功');
            resolve();
          } else {
            reject(new Error('ZIP文件为空'));
          }
        } else {
          reject(new Error('ZIP文件创建失败'));
        }
      });
      
      // 连接输出流
      archive.pipe(output);
      
      // 添加目录中的所有文件，类似Python版本的zipdir函数
      const addDirectory = (dirPath: string, zipPath: string = '') => {
        const files = fs.readdirSync(dirPath);
        
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          const stat = fs.statSync(filePath);
          const zipFilePath = zipPath ? path.join(zipPath, file) : file;
          
          if (stat.isDirectory()) {
            addDirectory(filePath, zipFilePath);
          } else {
            archive.file(filePath, { name: zipFilePath });
          }
        }
      };
      
      // 添加源目录中的所有文件
      addDirectory(sourceDir);
      
      // 完成归档
      archive.finalize();
    });
  }
}

export default new GetStickersPlugin();

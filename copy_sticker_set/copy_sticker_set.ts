import { Plugin } from "../src/utils/pluginBase";
import { getGlobalClient } from "../src/utils/globalClient";
import { getPrefixes } from "../src/utils/pluginManager";
import { Api } from "telegram";

// HTML转义函数
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


class CopyStickerSetPlugin extends Plugin {
  description: string = `📦 <b>复制贴纸包</b><br/><br/>
<b>命令格式</b><br/>
• <code>.copy_sticker_set &lt;贴纸包&gt; [自定义名称] [limit=数字]</code><br/>
• <code>.css &lt;贴纸包&gt; [自定义名称] [limit=数字]</code><br/><br/>
<b>参数说明</b><br/>
• <code>&lt;贴纸包&gt;</code> - 贴纸包链接或短名称（必填）<br/>
• <code>[自定义名称]</code> - 新贴纸包的标题（可选）<br/>
• <code>[limit=数字]</code> - 限制复制数量（最大 120，默认 100）<br/><br/>
<b>使用示例</b><br/>
• <code>.copy_sticker_set https://t.me/addstickers/example</code><br/>
• <code>.copy_sticker_set example_stickers</code><br/>
• <code>.copy_sticker_set example_stickers 我的专属贴纸包</code><br/>
• <code>.css example_stickers 我的专属贴纸包 limit=80</code><br/><br/>
<b>注意事项</b><br/>
• 复制的贴纸包将保存到你的账户中<br/>
• 如不指定名称，将使用原贴纸包名称<br/>
• 支持静态和动态贴纸包<br/>
• 平台限制：最多允许 120 张（超过将报错）`;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    "copy_sticker_set": this.handleCopyStickerSet.bind(this),
    "css": this.handleCopyStickerSet.bind(this),
  };

  private async handleCopyStickerSet(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    
    if (!client) {
      await msg.edit({
        text: "❌ 客户端未初始化"
      });
      return;
    }
    
    try {
      // 按照Telebox规范解析参数
      const lines = (msg.text || '').split('\n');
      const parts = lines[0].split(' ');
      const args = parts.slice(1); // 移除命令部分
      const fullText = lines.slice(1).join('\n'); // 多行内容
      
      if (args.length === 0) {
        await msg.edit({
           text: "📋 <b>复制贴纸包使用说明</b><br/><br/>" +
                 "<b>命令格式</b><br/>" +
                 "<code>.copy_sticker_set &lt;贴纸包&gt; [自定义名称] [limit=数字]</code><br/>" +
                 "<code>.css &lt;贴纸包&gt; [自定义名称] [limit=数字]</code><br/><br/>" +
                 "<b>参数说明</b><br/>" +
                 "• <code>&lt;贴纸包&gt;</code> - 贴纸包链接或短名称（必填）<br/>" +
                 "• <code>[自定义名称]</code> - 新贴纸包的标题（可选）<br/>" +
                 "• <code>[limit=数字]</code> - 限制复制数量（最大 120，默认 100）<br/><br/>" +
                 "<b>使用示例</b><br/>" +
                 "1. 使用完整链接：<br/>" +
                 "   <code>.copy_sticker_set https://t.me/addstickers/example</code><br/><br/>" +
                 "2. 使用短名称：<br/>" +
                 "   <code>.copy_sticker_set example_stickers</code><br/><br/>" +
                 "3. 自定义新贴纸包名称：<br/>" +
                 "   <code>.copy_sticker_set example_stickers 我的专属贴纸包</code><br/><br/>" +
                 "4. 指定数量上限：<br/>" +
                 "   <code>.css example_stickers 我的专属贴纸包 limit=80</code><br/><br/>" +
                 "<b>注意事项</b><br/>" +
                 "• 复制的贴纸包将保存到你的账户中<br/>" +
                 "• 如不指定名称，将使用原贴纸包名称<br/>" +
                 "• 支持静态和动态贴纸包<br/>" +
                 "• 平台限制：最多允许 120 张（超过将报错）",
           parseMode: "html"
         });
        return;
      }

      let stickerSetName = args[0];
      // 解析可选 limit 参数，形式为 limit=数字
      let limitOverride: number | undefined;
      // 其余作为标题
      let restArgs = args.slice(1);
      const restArgsFiltered: string[] = [];
      for (const token of restArgs) {
        const m = token.match(/^limit=(\d+)$/i);
        if (m) {
          const v = parseInt(m[1], 10);
          if (!Number.isFinite(v) || v <= 0) {
            const prefixes = await getPrefixes();
            await msg.edit({ 
              text: `<b>❌ 参数错误</b><br/><br/>limit 参数无效，请使用 <code>limit=正整数</code>（最大120）<br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`,
              parseMode: "html"
            });
            return;
          }
          if (v > 120) {
            const prefixes = await getPrefixes();
            await msg.edit({ 
              text: `<b>❌ 参数错误</b><br/><br/>平台限制：最多 120 张贴纸。请调整 <code>limit&lt;=120</code><br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`,
              parseMode: "html"
            });
            return;
          }
          limitOverride = v;
        } else {
          restArgsFiltered.push(token);
        }
      }
      const newSetTitle = restArgsFiltered.join(' ') || undefined;
      

      if (stickerSetName.includes('t.me/addstickers/')) {
        const match = stickerSetName.match(/t\.me\/addstickers\/([^\/?]+)/);
        if (match) {
          stickerSetName = match[1];
        } else {
          const prefixes = await getPrefixes();
          await msg.edit({
            text: `<b>❌ 链接格式错误</b><br/><br/>无效的贴纸包链接格式<br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`,
            parseMode: "html"
          });
          return;
        }
      }

      await msg.edit({
        text: "🔍 正在获取贴纸包信息..."
      });


      let stickerSet: Api.messages.StickerSet;
      try {
        const result = await client.invoke(
          new Api.messages.GetStickerSet({
            stickerset: new Api.InputStickerSetShortName({
              shortName: stickerSetName
            }),
            hash: 0
          })
        );
        
        if ('set' in result && 'documents' in result) {
          stickerSet = result as Api.messages.StickerSet;
        } else {
          const prefixes = await getPrefixes();
          await msg.edit({
            text: `<b>❌ 获取失败</b><br/><br/>获取贴纸包信息失败<br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`,
            parseMode: "html"
          });
          return;
        }
      } catch (error) {
        console.error('Failed to get sticker set:', error);
        const prefixes = await getPrefixes();
        await msg.edit({
          text: `<b>❌ 贴纸包不存在</b><br/><br/>无法找到贴纸包：<code>${htmlEscape(stickerSetName)}</code><br/>请检查贴纸包名称是否正确<br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`,
          parseMode: "html"
        });
        return;
      }

      const originalSet = stickerSet.set;
      const stickers = stickerSet.documents;
      
      if (!stickers || stickers.length === 0) {
        const prefixes = await getPrefixes();
        await msg.edit({
          text: `<b>❌ 贴纸包为空</b><br/><br/>贴纸包中没有贴纸<br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`,
          parseMode: "html"
        });
        return;
      }

      await msg.edit({
        text: `📦 找到贴纸包：${htmlEscape(originalSet.title)}\n🎯 包含 ${stickers.length} 个贴纸\n\n⏳ 开始复制贴纸包...`
      });


      const timestamp = Date.now();
      const newShortName = `copied_${stickerSetName}_${timestamp}`;
      const finalTitle = newSetTitle || `${originalSet.title} (复制)`;


      // 限制贴纸数量以避免超时
      const safeDefault = 100;
      const desired = limitOverride ?? safeDefault;
      const maxAllowed = 120;
      const maxStickers = Math.min(stickers.length, Math.min(desired, maxAllowed));
      const processStickers = stickers.slice(0, maxStickers);
      
      if (stickers.length > maxStickers) {
        await msg.edit({
          text: `📦 贴纸包：${htmlEscape(originalSet.title)}\n🎯 原包含 ${stickers.length} 个贴纸\n⚠️ 为避免超时，将只复制前 ${maxStickers} 个贴纸（limit=${desired}，最大允许 120）\n\n⏳ 开始处理贴纸...`
        });
      }
      
      // 处理贴纸
      const stickerInputs: Api.InputStickerSetItem[] = [];
      
      for (let i = 0; i < processStickers.length; i++) {
        const sticker = processStickers[i];
        
        if (!(sticker instanceof Api.Document)) {
          continue;
        }

        // 更新进度
        await msg.edit({
          text: `📦 贴纸包：${htmlEscape(originalSet.title)}\n🎯 处理贴纸 ${i + 1}/${processStickers.length}...`
        });

        try {
          let emoji = "🙂";
          const stickerAttr = sticker.attributes?.find(attr => 
            attr instanceof Api.DocumentAttributeSticker
          ) as Api.DocumentAttributeSticker | undefined;
          
          if (stickerAttr && stickerAttr.alt) {
            emoji = stickerAttr.alt;
          }

          // 创建输入贴纸
          const inputSticker = new Api.InputStickerSetItem({
            document: new Api.InputDocument({
              id: sticker.id,
              accessHash: sticker.accessHash,
              fileReference: sticker.fileReference || Buffer.alloc(0)
            }),
            emoji: emoji
          });

          stickerInputs.push(inputSticker);
          
        } catch (stickerError) {
          console.error(`Failed to process sticker ${i}:`, stickerError);
          // 继续处理下一个贴纸
        }
      }

      if (stickerInputs.length === 0) {
        const prefixes = await getPrefixes();
        await msg.edit({
          text: `<b>❌ 处理失败</b><br/><br/>无法处理任何贴纸<br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`,
          parseMode: "html"
        });
        return;
      }

      await msg.edit({
        text: `📦 贴纸包：${htmlEscape(originalSet.title)}\n🎯 已处理 ${stickerInputs.length} 个贴纸\n\n🚀 正在创建新贴纸包...`
      });


      // 创建新贴纸包（添加超时处理）
      try {
        // 设置较长的超时时间
        const createPromise = client.invoke(
          new Api.stickers.CreateStickerSet({
            userId: "me",
            title: finalTitle,
            shortName: newShortName,
            stickers: stickerInputs
          })
        );
        
        // 添加超时处理
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('CreateStickerSet timeout')), 60000); // 60秒超时
        });
        
        const result = await Promise.race([createPromise, timeoutPromise]) as Api.messages.StickerSet;

        if (result instanceof Api.messages.StickerSet) {
          const newSetUrl = `https://t.me/addstickers/${newShortName}`;
          
          await msg.edit({
            text: `✅ 贴纸包复制成功！\n\n📦 原贴纸包：${htmlEscape(originalSet.title)}\n🆕 新贴纸包：${htmlEscape(finalTitle)}\n🔗 链接：${newSetUrl}\n📊 贴纸数量：${stickerInputs.length}（limit=${desired}）\n\n点击链接添加到 Telegram！`
          });
        } else {
          const prefixes = await getPrefixes();
          await msg.edit({
            text: `<b>❌ 创建失败</b><br/><br/>创建贴纸包失败，请稍后重试<br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`,
            parseMode: "html"
          });
        }
        
      } catch (createError) {
        console.error("Failed to create sticker set:", createError);
        
        const prefixes = await getPrefixes();
        let errorMsg = `<b>❌ 创建错误</b><br/><br/>创建贴纸包时出现错误<br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`;
        
        if (createError instanceof Error) {
          if (createError.message.includes('STICKERSET_INVALID')) {
            errorMsg = `<b>❌ 数据无效</b><br/><br/>贴纸包数据无效<br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`;
          } else if (createError.message.includes('PEER_ID_INVALID')) {
            errorMsg = `<b>❌ 用户ID无效</b><br/><br/>用户ID无效<br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`;
          } else if (createError.message.includes('SHORTNAME_OCCUPY_FAILED')) {
            errorMsg = `<b>❌ 名称被占用</b><br/><br/>贴纸包名称已被占用<br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`;
          } else if (createError.message.includes('Timeout') || createError.message.includes('timeout')) {
            errorMsg = `<b>❌ 创建超时</b><br/><br/>创建贴纸包超时，请稍后重试或尝试较小的贴纸包<br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`;
          }
        }
        
        await msg.edit({
          text: errorMsg,
          parseMode: "html"
        });
      }
      
    } catch (error) {
      console.error("CopyStickerSet plugin error:", error);
      const prefixes = await getPrefixes();
      await msg.edit({
        text: `<b>❌ 插件错误</b><br/><br/>复制贴纸包时出现错误：<code>${htmlEscape(error instanceof Error ? error.message : String(error))}</code><br/><br/>使用 <code>${prefixes[0]}copy_sticker_set</code> 查看帮助`,
        parseMode: "html"
      });
    }
  }
}

export default new CopyStickerSetPlugin();

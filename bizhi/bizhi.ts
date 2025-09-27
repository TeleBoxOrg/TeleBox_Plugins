/**
 * bizhi 插件类型参数说明：
 *
 * lx（类型）参数：
 *   - meizi     美女 (people)
 *   - dongman   动漫 (anime)  
 *   - fengjing  风景 (general)
 *   - suiji     随机
 *   - 为空      随机输出
 *
 * 行为：
 *   - 仅输入 bizhi 命令，lx 为空，随机类型壁纸
 *   - bizhi dongman，lx = dongman，输出动漫壁纸
 *   - 其他类型同理
 *
 * 数据源优先级：
 *   1. wallhaven.cc - 高品质壁纸
 *   2. btstu.cn - fallback备用
 */
import axios from "axios";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { CustomFile } from "telegram/client/uploads.js";

// wallhaven API 接口类型
interface WallhavenResponse {
  data: WallhavenWallpaper[];
  meta: {
    current_page: number;
    last_page: number;
    per_page: number;
    total: number;
  };
}

interface WallhavenWallpaper {
  id: string;
  path: string;
  category: string;
  purity: string;
  dimension_x: number;
  dimension_y: number;
  file_size: number;
  file_type: string;
}

const timeout = 60000;
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "bizhi";
const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
随机获取一张高品质壁纸\n\n<code>${commandName} [分类] [-f]</code>\n分类可选：meizi, dongman, fengjing, suiji\n如 <code>${commandName} dongman</code>\n\n✨ 优先从wallhaven.cc获取高品质原图（≥1920×1080）\n🎨 优先内容：动漫、二次元、油画、摄影、日本风景、夜景\n📐 只获取16:9宽高比壁纸，适配主流显示器\n💾 文件大小≥3MB，确保高清画质\n📊 显示分辨率和文件大小信息\n📁 使用 -f 参数发送源文件而非图片
`;

/**
 * 分类映射：将用户输入映射到wallhaven分类和优先标签
 */
function mapCategoryToWallhaven(lx: string): { category: string; tags: string[] } {
  const categoryMap: Record<string, { category: string; tags: string[] }> = {
    'meizi': { 
      category: 'people', 
      tags: ['photography', 'portrait', 'aesthetic'] 
    },
    'dongman': { 
      category: 'anime', 
      tags: ['anime', 'illustration', 'digital painting', 'Studio Ghibli', 'anime screenshot'] 
    },
    'fengjing': { 
      category: 'general', 
      tags: ['nature', 'Japan', 'night', 'architecture', 'oil painting', 'photography'] 
    },
    'suiji': { 
      category: '', 
      tags: ['anime', 'oil painting', 'photography', 'Japan', 'night', 'illustration'] 
    }
  };
  
  return categoryMap[lx] || { category: '', tags: ['anime', 'oil painting', 'photography', 'Japan', 'night'] };
}

/**
 * 生成随机种子
 */
function generateRandomSeed(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * 从wallhaven获取高品质壁纸
 */
async function fetchFromWallhaven(categoryInfo: { category: string; tags: string[] }): Promise<WallhavenWallpaper> {
  const baseUrl = 'https://wallhaven.cc/api/v1/search';
  
  // 使用混合策略：60%完全随机，25%高质量，15%最新
  const rand = Math.random();
  let sorting: string;
  
  if (rand < 0.6) {
    sorting = 'random';
  } else if (rand < 0.85) {
    sorting = 'favorites';
  } else {
    sorting = 'date_added';
  }
  
  const params = new URLSearchParams({
    sorting,
    purity: '100',         // SFW only
    per_page: '24',        // 获取更多选项
    atleast: '1920x1080',  // 最小分辨率要求
    ratios: '16x9'         // 只要16:9宽高比
  });
  
  // 随机排序时添加seed确保真正随机
  if (sorting === 'random') {
    params.append('seed', generateRandomSeed());
  } else {
    params.append('order', 'desc');
  }
  
  // 添加优先标签搜索
  if (categoryInfo.tags.length > 0) {
    // 随机选择1-2个优先标签
    const selectedTags = categoryInfo.tags
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.random() < 0.7 ? 1 : 2);
    params.append('q', selectedTags.join('+'));
  }
  
  // 随机页码增加多样性（1-3页，减少范围确保质量）
  if (Math.random() < 0.2) {
    const randomPage = Math.floor(Math.random() * 3) + 1;
    params.append('page', randomPage.toString());
  }
  
  if (categoryInfo.category) {
    params.append('categories', categoryInfo.category === 'people' ? '001' : categoryInfo.category === 'anime' ? '010' : '100');
  }
  
  const response = await axios.get(`${baseUrl}?${params}`, {
    timeout,
    headers: {
      'User-Agent': 'TeleBox-Bot/1.0'
    }
  });
  
  const data: WallhavenResponse = response.data;
  if (!data.data || data.data.length === 0) {
    throw new Error('No wallpapers found');
  }
  
  // 过滤符合文件大小要求的壁纸（≥3MB）
  const minFileSize = 3 * 1024 * 1024; // 3MB in bytes
  const qualifiedWallpapers = data.data.filter(wallpaper => 
    wallpaper.file_size >= minFileSize &&
    wallpaper.dimension_x >= 1920 && 
    wallpaper.dimension_y >= 1080
  );
  
  // 如果没有符合条件的壁纸，从所有结果中选择
  const wallpapersToChooseFrom = qualifiedWallpapers.length > 0 ? qualifiedWallpapers : data.data;
  
  // 从符合条件的壁纸中随机选择一张
  const randomIndex = Math.floor(Math.random() * wallpapersToChooseFrom.length);
  const selectedWallpaper = wallpapersToChooseFrom[randomIndex];
  
  // 验证图片质量 - 如果分辨率或文件大小不够，重新获取
  if (selectedWallpaper.dimension_x < 1920 || selectedWallpaper.dimension_y < 1080 || selectedWallpaper.file_size < minFileSize) {
    // 使用更高分辨率要求重试，保持16:9比例
    params.set('atleast', '2560x1440');
    params.set('ratios', '16x9'); // 确保重试时也是16:9
    if (sorting === 'random') {
      params.set('seed', generateRandomSeed()); // 新的随机种子
    }
    
    const retryResponse = await axios.get(`${baseUrl}?${params}`, {
      timeout,
      headers: {
        'User-Agent': 'TeleBox-Bot/1.0'
      }
    });
    
    const retryData: WallhavenResponse = retryResponse.data;
    if (retryData.data && retryData.data.length > 0) {
      // 重试时也应用文件大小过滤
      const retryQualified = retryData.data.filter(wallpaper => 
        wallpaper.file_size >= minFileSize &&
        wallpaper.dimension_x >= 2560 && 
        wallpaper.dimension_y >= 1440
      );
      const retryWallpapers = retryQualified.length > 0 ? retryQualified : retryData.data;
      return retryWallpapers[Math.floor(Math.random() * retryWallpapers.length)];
    }
  }
  
  return selectedWallpaper;
}

/**
 * 从fallback API获取壁纸URL
 */
async function fetchFromFallback(lx: string): Promise<string> {
  const apiUrl = `https://api.btstu.cn/sjbz/api.php?method=pc${lx ? `&lx=${lx}` : ""}&format=json`;
  const response = await axios.get(apiUrl, {
    responseType: "json",
    timeout,
  });
  
  const data = response.data;
  if (!data || data.code !== "200" || !data.imgurl) {
    throw new Error('Fallback API failed');
  }
  
  return data.imgurl;
}

/**
 * 主要获取壁纸函数
 */
async function getWallpaper(lx: string): Promise<{imageBuffer: Buffer, filename: string, source: string}> {
  let imageBuffer: Buffer;
  let filename: string;
  let source: string;
  
  try {
    // 优先尝试wallhaven
    const wallhavenCategoryInfo = mapCategoryToWallhaven(lx);
    const wallpaper = await fetchFromWallhaven(wallhavenCategoryInfo);
    
    // 确保使用原图路径，添加质量信息
    const imgResponse = await axios.get(wallpaper.path, {
      responseType: "arraybuffer",
      timeout: timeout * 2, // 原图较大，增加超时时间
      maxContentLength: 50 * 1024 * 1024, // 最大50MB
      headers: {
        'User-Agent': 'TeleBox-Bot/1.0',
        'Referer': 'https://wallhaven.cc/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
      }
    });
    
    imageBuffer = Buffer.from(imgResponse.data);
    
    // 根据实际文件类型设置扩展名
    const fileExtension = wallpaper.file_type === 'image/png' ? 'png' : 
                         wallpaper.file_type === 'image/webp' ? 'webp' : 'jpg';
    
    filename = `wallhaven_${wallpaper.id}_${wallpaper.dimension_x}x${wallpaper.dimension_y}.${fileExtension}`;
    source = `${wallpaper.path}\n📊 ${wallpaper.dimension_x}×${wallpaper.dimension_y}, ${Math.round(wallpaper.file_size/1024/1024*100)/100}MB`;
    
  } catch (wallhavenError) {
    // fallback到原有API
    try {
      const imgUrl = await fetchFromFallback(lx);
      const imgResponse = await axios.get(imgUrl, {
        responseType: "arraybuffer",
        timeout,
      });
      
      imageBuffer = Buffer.from(imgResponse.data);
      filename = `bizhi_${lx || "suiji"}.jpg`;
      source = `${imgUrl}\n📊 来源: btstu.cn`;
      
    } catch (fallbackError) {
      const wallhavenMsg = wallhavenError instanceof Error ? wallhavenError.message : String(wallhavenError);
      const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`所有数据源都失败: wallhaven(${wallhavenMsg}), fallback(${fallbackMsg})`);
    }
  }
  
  if (!imageBuffer || imageBuffer.length === 0) {
    throw new Error("图片下载失败或为空");
  }
  
  return { imageBuffer, filename, source };
}

class BizhiPlugin extends Plugin {
  description: string = `\n高品质壁纸\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    bizhi: async (msg: Api.Message) => {
      const args = msg.message.split(/\s+/);
      
      // 解析参数：分离标志和分类
      const flags = args.filter(arg => arg.startsWith('-'));
      const categories = args.slice(1).filter(arg => !arg.startsWith('-'));
      const lx = categories[0] || "";
      const sendAsFile = flags.includes('-f');
      
      await msg.edit({ text: `正在获取高品质壁纸...` });
      
      try {
        const { imageBuffer, filename, source } = await getWallpaper(lx);
        
        const client = await getGlobalClient();
        const file = new CustomFile(
          filename,
          imageBuffer.length,
          "",
          imageBuffer
        );
        
        if (sendAsFile) {
          // 发送为文件
          await client.sendFile(msg.peerId, {
            file,
            replyTo: msg.id,
            caption: `📁 源文件: ${source}`,
            forceDocument: true // 强制作为文档发送
          });
        } else {
          // 发送为图片
          await client.sendFile(msg.peerId, {
            file,
            replyTo: msg.id,
            caption: `📸 来源: ${source}`
          });
        }
        
        await msg.delete();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await msg.edit({ text: `获取壁纸失败: ${errorMsg}` });
      }
    },
  };
}

export default new BizhiPlugin();

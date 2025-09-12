// Cosplay Plugin - 从 cosplaytele.com 获取随机cosplay图片
//@ts-nocheck
import { Plugin } from "../src/utils/pluginBase";
import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import { getPrefixes } from "../src/utils/pluginManager";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

interface PhotoSet {
  url: string;
  title: string;
}

interface ImageResult {
  imageUrls: string[];
  photoSet: PhotoSet;
}

const CONFIG = {
  BASE_URL: "https://cosplaytele.com/",
  MAX_IMAGES: 10,
  DEFAULT_COUNT: 1,
  REQUEST_TIMEOUT: 30000, // 增加到30秒
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  SUPPORTED_EXTENSIONS: [".jpg", ".jpeg", ".png", ".webp"],
  LINK_MULTIPLIER: 3,
} as const;

interface HttpRequestOptions {
  headers: Record<string, string>;
  timeout: number;
}


function getHttpOptions(): HttpRequestOptions {
  return {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
    },
    timeout: CONFIG.REQUEST_TIMEOUT,
  };
}

async function fetchHtml(url: string, retries: number = 3): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise<string>((resolve, reject) => {
        const client = url.startsWith("https:") ? https : http;
        const options = getHttpOptions();
        
        const req = client.get(url, options, (res) => {
          // 设置响应编码为UTF-8，避免乱码
          res.setEncoding('utf8');
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode === 200) {
              resolve(data);
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
          res.on("error", (err) => {
            reject(new Error(`响应错误: ${err.message}`));
          });
        });
        
        req.on("error", (err) => {
          reject(new Error(`请求错误: ${err.message}`));
        });
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("请求超时"));
        });
        
        // 设置请求超时
        req.setTimeout(CONFIG.REQUEST_TIMEOUT);
      });
    } catch (error: any) {
      console.warn(`fetchHtml 第${attempt}次尝试失败:`, error.message);
      
      if (attempt === retries) {
        throw new Error(`获取页面失败 (${retries}次重试后): ${error.message}`);
      }
      
      // 等待一段时间后重试，每次重试间隔递增
      const delay = attempt * 1000;
      console.log(`等待${delay}ms后进行第${attempt + 1}次重试...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw new Error("不应该到达这里");
}

function extractLinks(html: string, baseUrl: string): string[] {
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  const links: string[] = [];
  let match: RegExpExecArray | null;
  const baseDomain = baseUrl.replace(/^https?:\/\//, "");

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    if (isValidLink(href, baseUrl, baseDomain)) {
      const normalizedLink = normalizeLink(href, baseUrl);
      if (normalizedLink) {
        links.push(normalizedLink);
      }
    }
  }
  return [...new Set(links)];
}

function isValidLink(href: string, baseUrl: string, baseDomain: string): boolean {
  return (
    href.includes(baseDomain) &&
    href !== baseUrl &&
    !href.includes("#") &&
    !href.toLowerCase().startsWith("javascript:") &&
    !href.includes("/page/") &&
    !href.includes("/category/") &&
    !href.includes("/24-hours/") &&
    !href.includes("/3-day/") &&
    !href.includes("/7-day/") &&
    !href.includes("/explore-categories/") &&
    !href.includes("/best-cosplayer/")
  );
}

function normalizeLink(href: string, baseUrl: string): string | null {
  if (href.startsWith("http")) {
    return href;
  } else if (href.startsWith("/")) {
    return baseUrl.replace(/\/$/, "") + href;
  }
  return null;
}

function extractImageUrls(html: string): string[] {
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  const images: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    if (isValidImageUrl(src)) {
      images.push(src);
    }
  }
  return images;
}

function isValidImageUrl(src: string): boolean {
  return (
    src.startsWith("http") &&
    CONFIG.SUPPORTED_EXTENSIONS.some(ext => src.toLowerCase().endsWith(ext))
  );
}

function pickRandom<T>(arr: T[], count: number): T[] {
  if (count >= arr.length) return [...arr];
  const result: T[] = [];
  const used = new Set<number>();
  while (result.length < count) {
    const i = Math.floor(Math.random() * arr.length);
    if (!used.has(i)) {
      used.add(i);
      result.push(arr[i]);
    }
  }
  return result;
}

function generateTempFileName(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2);
  return `cos_${timestamp}_${random}.jpg`;
}

async function downloadImage(url: string, retries: number = 3): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise<string>((resolve, reject) => {
        const client = url.startsWith("https:") ? https : http;
        const options = getHttpOptions();
        
        const req = client.get(url, options, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          
          const temp = os.tmpdir();
          const fileName = generateTempFileName();
          const filePath = path.join(temp, fileName);
          const out = fs.createWriteStream(filePath);
          
          res.pipe(out);
          out.on("finish", () => resolve(filePath));
          out.on("error", (e) => {
            reject(new Error(`文件写入错误: ${e.message}`));
          });
          res.on("error", (err) => {
            reject(new Error(`响应错误: ${err.message}`));
          });
        });
        
        req.on("error", (err) => {
          reject(new Error(`下载请求错误: ${err.message}`));
        });
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("下载超时"));
        });
        
        // 设置请求超时
        req.setTimeout(CONFIG.REQUEST_TIMEOUT);
      });
    } catch (error: any) {
      console.warn(`downloadImage 第${attempt}次尝试失败:`, error.message);
      
      if (attempt === retries) {
        throw new Error(`下载图片失败 (${retries}次重试后): ${error.message}`);
      }
      
      // 等待一段时间后重试，每次重试间隔递增
      const delay = attempt * 1000;
      console.log(`等待${delay}ms后进行第${attempt + 1}次重试...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw new Error("不应该到达这里");
}

async function cleanup(files: string[]): Promise<void> {
  const deletePromises = files.map(async (filePath) => {
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      console.warn(`Failed to delete temp file: ${filePath}`);
    }
  });
  
  await Promise.allSettled(deletePromises);
}

function parseImageCount(text: string): number {
  const args = text.split(" ").slice(1);
  if (!args[0]) return CONFIG.DEFAULT_COUNT;
  
  const n = parseInt(args[0], 10);
  return (!isNaN(n) && n > 0) ? Math.min(n, CONFIG.MAX_IMAGES) : CONFIG.DEFAULT_COUNT;
}

async function getRandomPhotoSetFromPage(retries: number = 3): Promise<PhotoSet> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // 随机选择1-445页中的一页
      const randomPage = Math.floor(Math.random() * 445) + 1;
      const pageUrl = randomPage === 1 ? CONFIG.BASE_URL : `${CONFIG.BASE_URL}page/${randomPage}/`;
      
      console.log(`尝试获取第${randomPage}页套图 (第${attempt + 1}次尝试)`);
      
      // 获取页面HTML
      const html = await fetchHtml(pageUrl);
      
      // 提取页面中的套图链接
      const links = extractLinks(html, CONFIG.BASE_URL);
      
      if (!links.length) {
        throw new Error(`第${randomPage}页没有找到套图链接`);
      }
      
      // 随机选择一个套图
      const randomLink = links[Math.floor(Math.random() * links.length)];
      
      // 尝试从链接中提取标题（简单处理）
      const title = randomLink.split('/').filter(Boolean).pop() || '未知套图';
      
      console.log(`成功获取第${randomPage}页套图: ${title}`);
      
      return {
        url: randomLink,
        title: title.replace(/-/g, ' ')
      };
    } catch (error) {
      lastError = error as Error;
      console.error(`第${attempt + 1}次尝试失败:`, error);
      
      if (attempt < retries - 1) {
        const delay = (attempt + 1) * 2000; // 递增延迟: 2s, 4s, 6s
        console.log(`等待${delay}ms后进行第${attempt + 2}次重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw new Error(`获取套图失败，已重试${retries}次: ${lastError?.message || '未知错误'}`);
}

function extractGalleryImages(html: string): string[] {
  // 提取gallery-item中的图片URL
  const galleryRegex = /<figure[^>]*class=['"]gallery-item['"][^>]*>[\s\S]*?<img[^>]+src=['"]([^'"]+)['"][^>]*>[\s\S]*?<\/figure>/gi;
  const images: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = galleryRegex.exec(html)) !== null) {
    const src = match[1];
    if (isValidImageUrl(src)) {
      images.push(src);
    }
  }
  
  // 如果没找到gallery-item中的图片，应该获取新的套图链接
  if (images.length === 0) {
    // 检查是否存在视频标签
    const hasVideo = /<video[^>]*>|<iframe[^>]*>|<embed[^>]*>/.test(html);
    
    if (hasVideo) {
      console.warn('检测到套图只包含视频内容，没有图片');
    } else {
      console.warn('套图页面没有找到gallery-item图片');
    }
    
    // 返回空数组，让上层逻辑获取新的套图链接
    return [];
  }
  
  return images;
}

async function fetchImageUrls(count: number, retries: number = 3): Promise<ImageResult> {
  let lastError: Error | null = null;
  const maxAttempts = retries * 2; // 增加总尝试次数以应对图片数量不足的情况
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // 从随机页面获取随机套图
      const randomPhotoSet = await getRandomPhotoSetFromPage();
      
      console.log(`尝试获取套图图片: ${randomPhotoSet.title} (第${attempt + 1}次尝试)`);
      
      // 获取套图页面HTML
      const html = await fetchHtml(randomPhotoSet.url);
      
      // 提取gallery-item中的图片
      const galleryImages = extractGalleryImages(html);
      
      if (!galleryImages.length) {
        console.warn(`套图 ${randomPhotoSet.title} 中未找到图片，尝试获取新套图`);
        continue; // 直接尝试下一个套图，不等待
      }
      
      // 检查图片数量是否足够
      if (galleryImages.length < count) {
        console.warn(`套图 ${randomPhotoSet.title} 只有${galleryImages.length}张图片，少于需要的${count}张，尝试获取新套图`);
        continue; // 直接尝试下一个套图，不等待
      }
      
      // 从同一套图中随机选择指定数量的图片
      const selectedImages = pickRandom(galleryImages, count);
      
      console.log(`成功获取${selectedImages.length}张图片`);
      
      return {
        imageUrls: selectedImages,
        photoSet: randomPhotoSet
      };
    } catch (error) {
      lastError = error as Error;
      console.error(`第${attempt + 1}次尝试获取图片失败:`, error);
      
      // 只有在网络错误或其他严重错误时才等待
      if (attempt < maxAttempts - 1 && !error.message.includes('只有') && !error.message.includes('未找到图片')) {
        const delay = Math.min((attempt + 1) * 1000, 3000); // 最大等待3秒
        console.log(`等待${delay}ms后进行第${attempt + 2}次重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw new Error(`获取图片失败，已尝试${maxAttempts}次: ${lastError?.message || '未知错误'}`);
}

async function downloadImages(imageUrls: string[]): Promise<string[]> {
  const downloadPromises = imageUrls.map(async (url) => {
    try {
      return await downloadImage(url);
    } catch (error) {
      console.warn(`Failed to download image: ${url}`, error);
      return null;
    }
  });

  const results = await Promise.allSettled(downloadPromises);
  const tempFiles = results
    .filter((result): result is PromiseFulfilledResult<string> => 
      result.status === 'fulfilled' && result.value !== null
    )
    .map(result => result.value);

  if (!tempFiles.length) {
    throw new Error("所有图片下载失败");
  }

  return tempFiles;
}

async function sendSingleImage(client: any, chatId: any, filePath: string, photoSetUrl?: string): Promise<void> {
  const toUpload = new CustomFile(
    path.basename(filePath), 
    fs.statSync(filePath).size, 
    filePath
  );
  
  const uploaded = await client.uploadFile({
    file: toUpload,
    workers: 1,
  });

  const caption = photoSetUrl ? `套图链接: ${photoSetUrl}` : "";
  
  await client.sendFile(chatId, {
    file: new Api.InputMediaUploadedPhoto({
      file: uploaded,
      spoiler: true,
    }),
    caption,
  });
}

async function sendImageAlbum(client: any, chatId: any, filePaths: string[], photoSetUrl?: string): Promise<void> {
  const files = filePaths.map(filePath => 
    new CustomFile(
      path.basename(filePath), 
      fs.statSync(filePath).size, 
      filePath
    )
  );
  
  // 使用与 reddit.ts 相同的剧透相册发送方法
  try {
    const singles: Api.InputSingleMedia[] = [];
    
    const { getAttributes, getInputPhoto, getInputDocument } = await import(
      "telegram/Utils"
    );

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // 先上传到 Telegram
      const handle = await client.uploadFile({
        file: file,
        workers: 1,
      });

      // 再通过 UploadMedia 换取可直接引用的 Photo
      const uploaded = new Api.InputMediaUploadedPhoto({ file: handle });

      const r = await client.invoke(
        new Api.messages.UploadMedia({
          peer: chatId,
          media: uploaded,
        })
      );

      // 将 UploadMedia 返回值转为 InputMediaPhoto，并加上 spoiler 标记
      let media: Api.TypeInputMedia;
      if (r instanceof Api.MessageMediaPhoto) {
        const id = getInputPhoto(r.photo);
        media = new Api.InputMediaPhoto({ id, spoiler: true });
      } else if (r instanceof Api.MessageMediaDocument) {
        const id = getInputDocument(r.document);
        media = new Api.InputMediaDocument({ id, spoiler: true });
      } else {
        console.warn("cosplay插件: 非预期的 UploadMedia 返回类型，已跳过");
        continue;
      }

      // 在第一张图片中包含套图链接
      const message = (i === 0 && photoSetUrl) ? `套图链接: ${photoSetUrl}` : "";
      
      singles.push(
        new Api.InputSingleMedia({
          media,
          message,
          entities: undefined,
        })
      );
    }

    if (!singles.length) {
      throw new Error("无可发送的媒体");
    }

    await client.invoke(
      new Api.messages.SendMultiMedia({
        peer: chatId,
        multiMedia: singles,
      })
    );
  } catch (err: any) {
    console.warn("cosplay插件: 剧透相册发送失败，尝试逐条发送", err?.message || err);
    // 如果相册发送失败，逐条发送
    for (const filePath of filePaths) {
      await sendSingleImage(client, chatId, filePath);
    }
  }
}

async function sendImages(client: any, chatId: any, tempFiles: string[], photoSetUrl?: string): Promise<void> {
  if (tempFiles.length === 1) {
    await sendSingleImage(client, chatId, tempFiles[0], photoSetUrl);
  } else {
    await sendImageAlbum(client, chatId, tempFiles, photoSetUrl);
  }
}

class CosplayPlugin extends Plugin {
  description: string = (() => {
    const prefixes = getPrefixes();
    const mainPrefix = prefixes[0];
    return `从 cosplaytele.com 随机获取cosplay图片\n\n• ${mainPrefix}cos [数量] - 从随机套图中获取指定数量的cosplay图片 (默认1张，最大10张)\n• ${mainPrefix}cosplay [数量] - 同cos命令\n\n✨ 智能随机: 每次随机选择套图，确保多张图片来自同一套图，只获取高质量的gallery图片\n🔗 套图链接: 发送图片时自动包含原套图链接，方便查看完整套图`;
  })();
  
  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    cos: async (msg: Api.Message) => {
      const count = parseImageCount(msg.text);
      const client: any = msg.client;
      let tempFiles: string[] = [];

      try {
        await msg.edit({ text: `正在从随机套图中获取 ${count} 张图片...` });

        // 获取图片URL和套图信息
        const result = await fetchImageUrls(count);
        
        await msg.edit({ text: `从套图"${result.photoSet.title}"中找到 ${result.imageUrls.length} 张图片，正在下载...` });

        // 下载图片
        tempFiles = await downloadImages(result.imageUrls);
        
        await msg.edit({ text: `下载完成，正在发送...` });

        // 发送图片，包含套图链接
        await sendImages(client, msg.chatId, tempFiles, result.photoSet.url);
        
        await msg.delete();
      } catch (err: any) {
        console.error("cosplay插件错误:", err);
        await msg.edit({
          text: `❌ 出错: ${err?.message || "未知错误"}`,
        });
      } finally {
        if (tempFiles.length) {
          await cleanup(tempFiles);
        }
      }
    },
    cosplay: async (msg: Api.Message) => {
      // 复用cos命令的逻辑
      await this.cmdHandlers.cos(msg);
    },
  };
}

export default new CosplayPlugin();

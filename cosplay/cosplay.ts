// Cosplay Plugin - 从 cosplaytele.com 获取随机cosplay图片
import { Plugin } from "../src/utils/pluginBase";
import { Api } from "teleproto";
import { CustomFile } from "teleproto/client/uploads";
import { getPrefixes } from "../src/utils/pluginManager";
import { npm_install } from "../src/utils/npm_install";
import axios, { AxiosError, AxiosInstance } from "axios";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { pipeline } from "stream/promises";

let cheerio: typeof import("cheerio");
let pLimit: typeof import("p-limit").default;

async function loadDependencies(): Promise<void> {
  npm_install("cheerio");
  npm_install("p-limit");

  cheerio = await import("cheerio");
  pLimit = (await import("p-limit")).default;
}

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
  REQUEST_TIMEOUT: 30000,
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  SUPPORTED_EXTENSIONS: [".jpg", ".jpeg", ".png", ".webp"],
  MAX_RETRIES: 3,
  RETRY_BASE_DELAY: 1000,
  DOWNLOAD_CONCURRENCY: 3,
  MAX_PAGES: 455,
} as const;

type RetryErrorType = "transient" | "permanent";

function classifyError(error: unknown): RetryErrorType {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (!status) {
      return error.code === "ECONNABORTED" || error.code === "ETIMEDOUT"
        ? "transient"
        : "transient";
    }
    return status >= 500 || status === 429 ? "transient" : "permanent";
  }
  return "permanent";
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = CONFIG.MAX_RETRIES
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (classifyError(error) === "permanent" || attempt === retries) {
        throw error;
      }
      const delay = CONFIG.RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

class CosplayScraper {
  private readonly client: AxiosInstance;
  private readonly limit: ReturnType<typeof pLimit>;

  constructor() {
    this.client = axios.create({
      timeout: CONFIG.REQUEST_TIMEOUT,
      headers: { "User-Agent": CONFIG.USER_AGENT },
      maxRedirects: 5,
    });
    this.limit = pLimit(CONFIG.DOWNLOAD_CONCURRENCY);
  }

  async fetchImageUrls(count: number): Promise<ImageResult> {
    const maxAttempts = CONFIG.MAX_RETRIES * 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const photoSet = await this.getRandomPhotoSet();
        const html = await withRetry(() =>
          this.client.get(photoSet.url).then((r) => r.data)
        );
        const images = this.extractGalleryImages(html);

        if (images.length === 0) {
          console.warn(`套图 ${photoSet.title} 未找到图片，重试`);
          continue;
        }

        if (images.length < count) {
          console.warn(
            `套图 ${photoSet.title} 只有${images.length}张，需要${count}张，重试`
          );
          continue;
        }

        const selected = this.pickRandom(images, count);
        return { imageUrls: selected, photoSet };
      } catch (error) {
        lastError = error as Error;
        const errorMessage = error instanceof Error ? error.message : "";
        if (
          attempt < maxAttempts - 1 &&
          !errorMessage.includes("只有") &&
          !errorMessage.includes("未找到")
        ) {
          await new Promise((r) => setTimeout(r, Math.min((attempt + 1) * 1000, 3000)));
        }
      }
    }
    throw new Error(
      `获取图片失败，已尝试${maxAttempts}次: ${lastError?.message || "未知错误"}`
    );
  }

  async downloadImages(imageUrls: string[]): Promise<string[]> {
    const tasks = imageUrls.map((url) =>
      this.limit(async () => {
        try {
          return await this.downloadImage(url);
        } catch (error) {
          console.warn(`下载失败: ${url}`, error);
          return null;
        }
      })
    );

    const results = await Promise.allSettled(tasks);
    const tempFiles = results
      .filter(
        (r): r is PromiseFulfilledResult<string> =>
          r.status === "fulfilled" && r.value !== null
      )
      .map((r) => r.value);

    if (!tempFiles.length) {
      throw new Error("所有图片下载失败");
    }

    return tempFiles;
  }

  private async getRandomPhotoSet(): Promise<PhotoSet> {
    return withRetry(async () => {
      const randomPage = Math.floor(Math.random() * CONFIG.MAX_PAGES) + 1;
      const pageUrl =
        randomPage === 1 ? CONFIG.BASE_URL : `${CONFIG.BASE_URL}page/${randomPage}/`;

      const html = await this.client.get(pageUrl).then((r) => r.data);
      const links = this.extractLinks(html);

      if (!links.length) {
        throw new Error(`第${randomPage}页没有找到套图链接`);
      }

      const randomLink = links[Math.floor(Math.random() * links.length)];
      const title = randomLink.split("/").filter(Boolean).pop() || "未知套图";

      return { url: randomLink, title: title.replace(/-/g, " ") };
    });
  }

  private extractLinks(html: string): string[] {
    const $ = cheerio.load(html);
    const baseDomain = CONFIG.BASE_URL.replace(/^https?:\/\//, "");
    const linkSet = new Set<string>();

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      if (
        href.includes(baseDomain) &&
        href !== CONFIG.BASE_URL &&
        !href.includes("#") &&
        !href.toLowerCase().startsWith("javascript:") &&
        !href.match(/\/(page|category|24-hours|3-day|7-day|explore-categories|best-cosplayer)\//)
      ) {
        const normalized = href.startsWith("http")
          ? href
          : href.startsWith("/")
          ? CONFIG.BASE_URL.replace(/\/$/, "") + href
          : null;
        if (normalized) linkSet.add(normalized);
      }
    });

    return Array.from(linkSet);
  }

  private extractGalleryImages(html: string): string[] {
    const $ = cheerio.load(html);
    const images: string[] = [];

    $("figure.gallery-item img[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (src && src.startsWith("http")) {
        try {
          const url = new URL(src);
          const pathname = url.pathname.toLowerCase();
          if (CONFIG.SUPPORTED_EXTENSIONS.some((ext) => pathname.endsWith(ext))) {
            images.push(src);
          }
        } catch {
          // 无效 URL，跳过
        }
      }
    });

    if (images.length === 0) {
      const hasVideo = /<video[^>]*>|<iframe[^>]*>|<embed[^>]*>/.test(html);
      console.warn(hasVideo ? "套图只包含视频" : "套图无 gallery-item 图片");
    }

    return images;
  }

  private async downloadImage(url: string): Promise<string> {
    return withRetry(async () => {
      const response = await this.client.get(url, { responseType: "stream" });
      const tempFile = path.join(
        os.tmpdir(),
        `cos_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`
      );
      const writer = fs.createWriteStream(tempFile);

      try {
        await pipeline(response.data, writer);
        return tempFile;
      } catch (error) {
        try {
          await fs.promises.unlink(tempFile);
        } catch {}
        throw error;
      }
    });
  }

  private pickRandom<T>(arr: T[], count: number): T[] {
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
}

async function cleanup(files: string[]): Promise<void> {
    // 真实资源清理：释放插件持有的定时器、监听器、运行时状态或临时资源。
  await Promise.allSettled(
    files.map(async (filePath) => {
      try {
        await fs.promises.unlink(filePath);
      } catch (error) {
        console.warn(`清理临时文件失败: ${filePath}`);
      }
    })
  );
}

function parseImageCount(text: string | undefined): number {
  if (!text) return CONFIG.DEFAULT_COUNT;

  const args = text.split(" ").slice(1);
  if (!args[0]) return CONFIG.DEFAULT_COUNT;

  const n = parseInt(args[0], 10);
  return !isNaN(n) && n > 0 ? Math.min(n, CONFIG.MAX_IMAGES) : CONFIG.DEFAULT_COUNT;
}

async function sendSingleImage(
  client: any,
  chatId: any,
  filePath: string,
  photoSetUrl?: string
): Promise<void> {
  const toUpload = new CustomFile(
    path.basename(filePath),
    fs.statSync(filePath).size,
    filePath
  );

  const uploaded = await client.uploadFile({
    file: toUpload,
    workers: 1,
  });

  await client.sendFile(chatId, {
    file: new Api.InputMediaUploadedPhoto({
      file: uploaded,
      spoiler: true,
    }),
    caption: photoSetUrl ? `套图链接: ${photoSetUrl}` : "",
  });
}

async function sendImageAlbum(
  client: any,
  chatId: any,
  filePaths: string[],
  photoSetUrl?: string
): Promise<void> {
  try {
    const files = filePaths.map(
      (filePath) =>
        new CustomFile(path.basename(filePath), fs.statSync(filePath).size, filePath)
    );

    const singles: Api.InputSingleMedia[] = [];

    const { getInputPhoto, getInputDocument } = await import("teleproto/Utils");

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      const handle = await client.uploadFile({ file, workers: 1 });
      const uploaded = new Api.InputMediaUploadedPhoto({ file: handle });

      const r = await client.invoke(
        new Api.messages.UploadMedia({ peer: chatId, media: uploaded })
      );

      let media: Api.TypeInputMedia;
      if (r instanceof Api.MessageMediaPhoto) {
        const id = getInputPhoto(r.photo);
        media = new Api.InputMediaPhoto({ id, spoiler: true });
      } else if (r instanceof Api.MessageMediaDocument) {
        const id = getInputDocument(r.document);
        media = new Api.InputMediaDocument({ id, spoiler: true });
      } else {
        console.warn("非预期的 UploadMedia 返回类型，已跳过");
        continue;
      }

      singles.push(
        new Api.InputSingleMedia({
          media,
          message: i === 0 && photoSetUrl ? `套图链接: ${photoSetUrl}` : "",
          entities: undefined,
        })
      );
    }

    if (!singles.length) {
      throw new Error("无可发送的媒体");
    }

    await client.invoke(
      new Api.messages.SendMultiMedia({ peer: chatId, multiMedia: singles })
    );
  } catch (err: any) {
    console.warn("剧透相册发送失败，尝试逐条发送", err?.message || err);
    for (const filePath of filePaths) {
      await sendSingleImage(client, chatId, filePath, photoSetUrl);
    }
  }
}

async function sendImages(
  client: any,
  chatId: any,
  tempFiles: string[],
  photoSetUrl?: string
): Promise<void> {
  if (tempFiles.length === 1) {
    await sendSingleImage(client, chatId, tempFiles[0], photoSetUrl);
  } else {
    await sendImageAlbum(client, chatId, tempFiles, photoSetUrl);
  }
}

class CosplayPlugin extends Plugin {
  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }
  private scraper: CosplayScraper | null = null;
  private initPromise: Promise<void>;

  constructor() {
    super();
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    await loadDependencies();
    this.scraper = new CosplayScraper();
  }

  description: string = (() => {
    const prefixes = getPrefixes();
    const mainPrefix = prefixes[0];
    return `从 cosplaytele.com 随机获取cosplay图片\n\n• ${mainPrefix}cos [数量] - 从随机套图中获取指定数量的cosplay图片 (默认1张，最大10张)\n• ${mainPrefix}cosplay [数量] - 同cos命令\n\n✨ 智能随机: 每次随机选择套图，确保多张图片来自同一套图，只获取高质量的gallery图片\n🔗 套图链接: 发送图片时自动包含原套图链接，方便查看完整套图`;
  })();

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    cos: async (msg: Api.Message) => {
      await this.initPromise;
      if (!this.scraper) {
        await msg.edit({ text: "❌ 插件初始化失败" });
        return;
      }

      const count = parseImageCount(msg.text);
      const client: any = msg.client;
      let tempFiles: string[] = [];

      try {
        await msg.edit({ text: `正在从随机套图中获取 ${count} 张图片...` });

        const result = await this.scraper.fetchImageUrls(count);

        await msg.edit({
          text: `从套图"${result.photoSet.title}"中找到 ${result.imageUrls.length} 张图片，正在下载...`,
        });

        tempFiles = await this.scraper.downloadImages(result.imageUrls);

        await msg.edit({ text: `下载完成，正在发送...` });

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
      await this.cmdHandlers.cos(msg);
    },
  };
}

export default new CosplayPlugin();
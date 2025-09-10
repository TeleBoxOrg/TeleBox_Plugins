import { Plugin } from "@utils/pluginBase";
import { Api, TelegramClient } from "telegram";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";
import { createDirectoryInAssets } from "@utils/pathHelpers";

// 配置存储键名
const CONFIG_KEYS = {
  GPT_KEY: "gpt_key",
  GPT_API: "gpt_api",
  GPT_MODEL: "gpt_model",
  GPT_VISION_MODEL: "gpt_vision_model",
  GPT_IMAGE_UPLOAD: "gpt_image_upload",
  GPT_WEB_SEARCH: "gpt_web_search",
  GPT_AUTO_REMOVE: "gpt_auto_remove",
  GPT_MAX_TOKENS: "gpt_max_tokens",
  GPT_COLLAPSE: "gpt_collapse",
};

// 默认配置
const DEFAULT_CONFIG = {
  [CONFIG_KEYS.GPT_API]: "https://api.openai.com",
  [CONFIG_KEYS.GPT_MODEL]: "gpt-4o",
  [CONFIG_KEYS.GPT_VISION_MODEL]: "gpt-4o",
  [CONFIG_KEYS.GPT_IMAGE_UPLOAD]: "false",
  [CONFIG_KEYS.GPT_WEB_SEARCH]: "false",
  [CONFIG_KEYS.GPT_AUTO_REMOVE]: "false",
  [CONFIG_KEYS.GPT_MAX_TOKENS]: "888",
  [CONFIG_KEYS.GPT_COLLAPSE]: "false",
};

// 数据库路径
const CONFIG_DB_PATH = path.join(
  createDirectoryInAssets("gpt"),
  "gpt_config.db"
);

// 确保assets目录存在
if (!fs.existsSync(path.dirname(CONFIG_DB_PATH))) {
  fs.mkdirSync(path.dirname(CONFIG_DB_PATH), { recursive: true });
}

// 配置管理器 - 使用SQLite数据库
class ConfigManager {
  private static db: Database.Database;
  private static initialized = false;

  // 初始化数据库
  private static init(): void {
    if (this.initialized) return;

    try {
      this.db = new Database(CONFIG_DB_PATH);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.initialized = true;
    } catch (error) {
      console.error("初始化配置数据库失败:", error);
    }
  }

  static get(key: string, defaultValue?: string): string {
    this.init();

    try {
      const stmt = this.db.prepare("SELECT value FROM config WHERE key = ?");
      const row = stmt.get(key) as { value: string } | undefined;

      if (row) {
        return row.value;
      }
    } catch (error) {
      console.error("读取配置失败:", error);
    }

    return defaultValue || DEFAULT_CONFIG[key] || "";
  }

  static set(key: string, value: string): void {
    this.init();

    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO config (key, value, updated_at) 
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `);
      stmt.run(key, value);
    } catch (error) {
      console.error("保存配置失败:", error);
    }
  }

  // 获取所有配置
  static getAll(): { [key: string]: string } {
    this.init();

    try {
      const stmt = this.db.prepare("SELECT key, value FROM config");
      const rows = stmt.all() as { key: string; value: string }[];

      const config: { [key: string]: string } = {};
      rows.forEach((row) => {
        config[row.key] = row.value;
      });

      return config;
    } catch (error) {
      console.error("读取所有配置失败:", error);
      return {};
    }
  }

  // 删除配置
  static delete(key: string): void {
    this.init();

    try {
      const stmt = this.db.prepare("DELETE FROM config WHERE key = ?");
      stmt.run(key);
    } catch (error) {
      console.error("删除配置失败:", error);
    }
  }

  // 关闭数据库连接
  static close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}

// HTML转义函数
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// 简单的Markdown到HTML转换函数
function markdownToHtml(text: string): string {
  // 首先对特殊HTML字符进行转义，但要保护已经存在的HTML标签
  let result = text;

  // 临时替换现有的HTML标签
  const htmlTags: string[] = [];
  let tagIndex = 0;
  result = result.replace(/<\/?[a-zA-Z][^>]*>/g, (match) => {
    htmlTags.push(match);
    return `__HTML_TAG_${tagIndex++}__`;
  });

  // 转义其他HTML字符
  result = result
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 恢复HTML标签
  htmlTags.forEach((tag, index) => {
    result = result.replace(`__HTML_TAG_${index}__`, tag);
  });

  // 应用markdown转换
  result = result
    // 代码块 (```) - 先处理，避免内部内容被其他规则影响
    .replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
      const escapedCode = code
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      return `<pre><code>${htmlEscape(escapedCode)}</code></pre>`;
    })
    // 行内代码 (`)
    .replace(/`([^`]+)`/g, (match, code) => {
      const escapedCode = code
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      return `<code>${htmlEscape(escapedCode)}</code>`;
    })
    // 粗体 (**)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    // 斜体 (*) - 简化版本，避免与粗体冲突
    .replace(/\*([^*\n]+)\*/g, "<i>$1</i>")
    // 粗体 (__)
    .replace(/__([^_]+)__/g, "<b>$1</b>")
    // 斜体 (_) - 简化版本，避免与粗体冲突
    .replace(/_([^_\n]+)_/g, "<i>$1</i>")
    // 删除线 (~~)
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    // 链接 [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // 标题 (# ## ###)
    .replace(/^### (.+)$/gm, "<b>$1</b>")
    .replace(/^## (.+)$/gm, "<b>$1</b>")
    .replace(/^# (.+)$/gm, "<b>$1</b>")
    // 引用 (>)
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");

  return result;
}

// 睡眠函数
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 图片上传到 fars.ee
async function uploadImage(imagePath: string): Promise<string> {
  const basename = path.basename(imagePath);
  const url = `https://fars.ee/~${basename}`;

  const formData = new FormData();
  const imageBuffer = await fs.promises.readFile(imagePath);
  const imageBlob = new Blob([imageBuffer as any]);

  formData.append("c", imageBlob, basename);
  formData.append("sunset", "120");
  formData.append("private", "1");

  const headers = {
    Accept: "application/json",
  };

  try {
    const response = await axios.post(url, formData, {
      headers,
      timeout: 30000,
    });

    if (response.status !== 200) {
      const location = response.headers.location;
      if (location) {
        return location;
      }
      throw new Error(`响应异常: HTTP ${response.status}`);
    }

    const data = response.data;
    let retUrl = data.url;

    if (!retUrl) {
      retUrl = response.headers.location;
    }

    if (!retUrl) {
      throw new Error("有响应但无法获取图片 URL");
    }

    return retUrl;
  } catch (error: any) {
    throw new Error(`上传图片失败: ${error.message}`);
  }
}

// 下载并处理图片
async function downloadAndProcessImage(
  client: TelegramClient,
  message: Api.Message,
  infoMessage: Api.Message
): Promise<{ imagePath: string; imageSource: string }> {
  const tempDir = os.tmpdir();
  const imageName = `gpt_tmp_${Math.random()
    .toString(36)
    .substring(7)}_${Date.now()}.png`;
  const imagePath = path.join(tempDir, imageName);

  try {
    // 下载图片
    await infoMessage.edit({ text: "下载图片..." });

    let mediaMsg = message;
    const replyMsg = await message.getReplyMessage();
    if (!message.media && replyMsg?.media) {
      mediaMsg = replyMsg;
    }

    if (!mediaMsg.media) {
      throw new Error("未找到图片");
    }

    // 尝试下载图片
    const buffer = await client.downloadMedia(mediaMsg.media, {
      progressCallback: (received: any, total: any) => {
        const percent = (Number(received) * 100) / Number(total);
        infoMessage
          .edit({
            text: `下载图片 ${percent.toFixed(1)}%`,
          })
          .catch(() => {});
      },
    });

    if (!buffer) {
      throw new Error("图片下载失败");
    }

    // 保存图片
    await fs.promises.writeFile(imagePath, buffer as any);
    await infoMessage.edit({ text: "下载图片 100%" });

    // 检查是否需要上传图片
    const imageUploadEnabled =
      ConfigManager.get(CONFIG_KEYS.GPT_IMAGE_UPLOAD).toLowerCase() === "true";

    let imageSource: string;
    if (imageUploadEnabled) {
      const imageUrl = await uploadImage(imagePath);
      imageSource = imageUrl;
    } else {
      const imageBuffer = await fs.promises.readFile(imagePath);
      const base64 = imageBuffer.toString("base64");
      imageSource = `data:image/png;base64,${base64}`;
    }

    return { imagePath, imageSource };
  } catch (error) {
    // 清理临时文件
    try {
      await fs.promises.unlink(imagePath);
    } catch {}
    throw error;
  }
}

// 设置max_tokens参数（兼容不同模型）
function setMaxTokensParam(
  payload: any,
  modelName: string,
  maxTokens: number | null
): void {
  if (maxTokens === null) return;

  const modelLower = modelName.toLowerCase();
  if (modelLower.startsWith("gpt-5") || modelLower.startsWith("o1-")) {
    payload.max_completion_tokens = maxTokens;
  } else {
    payload.max_tokens = maxTokens;
  }
}

// 调用GPT API
async function callGptApi(
  question: string,
  imageSource?: string,
  useVision = false
): Promise<string> {
  const apiKey = ConfigManager.get(CONFIG_KEYS.GPT_KEY);
  const apiUrl = ConfigManager.get(CONFIG_KEYS.GPT_API);
  const model = useVision
    ? ConfigManager.get(CONFIG_KEYS.GPT_VISION_MODEL)
    : ConfigManager.get(CONFIG_KEYS.GPT_MODEL);
  const webSearch =
    ConfigManager.get(CONFIG_KEYS.GPT_WEB_SEARCH).toLowerCase() === "true";
  const maxTokensStr = ConfigManager.get(CONFIG_KEYS.GPT_MAX_TOKENS);

  if (!apiKey) {
    throw new Error("未设置 API Key");
  }
  if (!apiUrl) {
    throw new Error("未设置 API URL");
  }
  if (!model) {
    throw new Error("未设置模型");
  }

  let maxTokens: number | null = null;
  try {
    const parsed = parseInt(maxTokensStr);
    if (parsed === -1) {
      maxTokens = null;
    } else {
      maxTokens = parsed;
    }
  } catch {
    maxTokens = 888;
  }

  const useResponsesApi = webSearch;
  const url = useResponsesApi
    ? `${apiUrl}/v1/responses`
    : `${apiUrl}/v1/chat/completions`;

  let payload: any;

  if (useVision && imageSource) {
    if (useResponsesApi) {
      // Responses API with vision
      payload = {
        model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: question },
              { type: "input_image", image_url: imageSource },
            ],
          },
        ],
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        temperature:
          model.startsWith("o1-") || model.startsWith("gpt-5") ? 1 : 0.5,
      };
      if (maxTokens !== null) {
        payload.max_output_tokens = maxTokens;
      }
    } else {
      // Chat Completions with vision
      payload = {
        stream: false,
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: question },
              { type: "image_url", image_url: { url: imageSource } },
            ],
          },
        ],
        temperature:
          model.startsWith("o1-") || model.startsWith("gpt-5") ? 1 : 0.5,
        presence_penalty: 0,
      };
      setMaxTokensParam(payload, model, maxTokens);
    }
  } else {
    if (useResponsesApi) {
      // Responses API
      payload = {
        model,
        input: question,
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        temperature:
          model.startsWith("o1-") || model.startsWith("gpt-5") ? 1 : 0.5,
      };
      if (maxTokens !== null) {
        payload.max_output_tokens = maxTokens;
      }
    } else {
      // Chat Completions
      payload = {
        stream: false,
        model,
        messages: [{ role: "user", content: question }],
        temperature:
          model.startsWith("o1-") || model.startsWith("gpt-5") ? 1 : 0.5,
        presence_penalty: 0,
      };
      setMaxTokensParam(payload, model, maxTokens);
    }
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const timeout = useResponsesApi ? 120000 : 30000;

  try {
    const response = await axios.post(url, payload, {
      headers,
      timeout,
    });

    if (response.status !== 200) {
      throw new Error(`API 请求失败: HTTP ${response.status}`);
    }

    const data = response.data;
    let answer: string | null = null;

    if (useResponsesApi) {
      // Handle Responses API response
      let responseData = data;
      const startTime = Date.now();

      // Poll if response is still processing
      while (
        responseData.status === "in_progress" ||
        responseData.status === "queued"
      ) {
        if (Date.now() - startTime > timeout - 5000) {
          break;
        }

        await sleep(1000);
        const pollResponse = await axios.get(
          `${apiUrl}/v1/responses/${responseData.id}`,
          { headers, timeout: 20000 }
        );
        responseData = pollResponse.data;
      }

      // Extract answer from Responses API
      answer = responseData.output_text;
      if (!answer && responseData.output) {
        const parts: string[] = [];
        for (const item of responseData.output) {
          if (item.content && Array.isArray(item.content)) {
            for (const c of item.content) {
              const text = c.text || c.content || c.value;
              if (typeof text === "string") {
                parts.push(text);
              }
            }
          }
        }
        answer = parts.join("").trim() || null;
      }
    } else {
      // Handle Chat Completions response
      answer = data.choices?.[0]?.message?.content;
    }

    if (!answer) {
      throw new Error("API 返回了空的回答");
    }

    return answer;
  } catch (error: any) {
    if (error.response?.data?.error?.message) {
      throw new Error(error.response.data.error.message);
    }
    throw new Error(`API 调用失败: ${error.message}`);
  }
}

// 格式化回答消息
function formatResponse(question: string, answer: string): string {
  let finalText = "";

  if (question.trim()) {
    // 添加问题部分
    finalText += "<b>Q:</b>\n";
    const htmlQuestion = markdownToHtml(question);
    finalText += `<blockquote>${htmlQuestion}</blockquote>\n\n`;
  }

  // 添加回答部分
  finalText += "<b>A:</b>\n";
  const htmlAnswer = markdownToHtml(answer);
  finalText += `<blockquote>${htmlAnswer}</blockquote>`;

  return finalText;
}

// 清理临时文件
async function cleanupTempFile(filePath?: string): Promise<void> {
  if (filePath) {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // 忽略清理错误
    }
  }
}

// 主处理函数
async function handleGptRequest(msg: Api.Message): Promise<void> {
  const [, ...args] = msg.message.slice(1).split(" ");
  let tempImagePath: string | undefined;

  try {
    // 检查是否是配置命令
    if (args.length === 2 && args[0].startsWith("_set_")) {
      const configKey = args[0];
      const configValue = args[1].trim();

      let actualKey: string;
      let displayName: string;

      switch (configKey) {
        case "_set_key":
          actualKey = CONFIG_KEYS.GPT_KEY;
          displayName = "API Key";
          break;
        case "_set_api":
          actualKey = CONFIG_KEYS.GPT_API;
          displayName = "API URL";
          break;
        case "_set_model":
          actualKey = CONFIG_KEYS.GPT_MODEL;
          displayName = "模型";
          break;
        case "_set_vision_model":
          actualKey = CONFIG_KEYS.GPT_VISION_MODEL;
          displayName = "图像识别模型";
          break;
        case "_set_image_upload":
          actualKey = CONFIG_KEYS.GPT_IMAGE_UPLOAD;
          displayName = "图片上传";
          break;
        case "_set_web_search":
          actualKey = CONFIG_KEYS.GPT_WEB_SEARCH;
          displayName = "Web搜索";
          break;
        case "_set_auto_remove":
          actualKey = CONFIG_KEYS.GPT_AUTO_REMOVE;
          displayName = "自动删除";
          break;
        case "_set_max_tokens":
          actualKey = CONFIG_KEYS.GPT_MAX_TOKENS;
          displayName = "最大Token数";
          break;
        case "_set_collapse":
          actualKey = CONFIG_KEYS.GPT_COLLAPSE;
          displayName = "折叠引用";
          break;
        default:
          await msg.edit({ text: "❌ 未知的配置项" });
          return;
      }

      ConfigManager.set(actualKey, configValue);
      const confirmMsg = await msg.edit({
        text: `✅ 已设置 ${displayName}: \`${
          actualKey === CONFIG_KEYS.GPT_KEY
            ? configValue.substring(0, 8) + "..."
            : configValue
        }\``,
        parseMode: "markdown",
      });

      await sleep(5000);
      await confirmMsg?.delete();
      return;
    }

    // 获取问题文本
    let question = args.join(" ");
    const replyMsg = await msg.getReplyMessage();
    let questionType: string | null = null;

    // 检查是否有媒体（图片）
    const hasMedia = msg.media || replyMsg?.media;
    const useVision = hasMedia;

    if (useVision) {
      if (!question) {
        question = "用中文描述此图片";
        questionType = "empty";
      }

      // 下载并处理图片
      await msg.edit({ text: "🤔 下载图片中..." });
      const { imagePath, imageSource } = await downloadAndProcessImage(
        msg.client as TelegramClient,
        msg,
        msg
      );
      tempImagePath = imagePath;

      // 如果回复消息有文本，将其加入问题
      if (replyMsg?.text && questionType !== "empty") {
        const replyText = replyMsg.text.trim();
        if (replyText) {
          question = `回复内容: ${replyText}\n\n问题: ${question}`;
        }
      }

      await msg.edit({ text: "🤔 思考中..." });

      // 调用GPT API
      const answer = await callGptApi(question, imageSource, true);

      // 格式化并发送回复
      const formattedText = formatResponse(question, answer);
      await msg.edit({
        text: formattedText,
        linkPreview: false,
        parseMode: "html",
      });
    } else {
      // 文本问答模式
      if (!question) {
        questionType = "empty";
        if (!replyMsg?.text) {
          await msg.edit({ text: "❌ 请直接提问或回复一条有文字内容的消息" });
          return;
        }
        question = replyMsg.text.trim();
        if (!question) {
          await msg.edit({ text: "❌ 请直接提问或回复一条有文字内容的消息" });
          return;
        }
        question = "尽可能简短地回答: " + question;
      } else if (replyMsg?.text) {
        // 如果既有参数又有回复，将回复内容加入问题
        const replyText = replyMsg.text.trim();
        if (replyText) {
          question = `回复内容: ${replyText}\n\n问题: ${question}`;
        }
      }

      await msg.edit({ text: "🤔 思考中..." });

      // 调用GPT API
      const answer = await callGptApi(question, undefined, false);

      // 格式化并发送回复
      const formattedText = formatResponse(
        questionType === "empty" ? "" : question,
        answer
      );
      await msg.edit({
        text: formattedText,
        linkPreview: false,
        parseMode: "html",
      });
    }

    // 自动删除空提问
    const autoRemove =
      ConfigManager.get(CONFIG_KEYS.GPT_AUTO_REMOVE).toLowerCase() === "true";
    if (autoRemove && questionType === "empty") {
      await sleep(1000);
      await msg.delete();
    }
  } catch (error: any) {
    console.error("GPT处理错误:", error);

    const errorMsg = `❌ 错误：${error.message}`;
    await msg.edit({ text: errorMsg });
    await sleep(10000);
    await msg.delete();

    // 自动删除空提问（即使出错）
    const autoRemove =
      ConfigManager.get(CONFIG_KEYS.GPT_AUTO_REMOVE).toLowerCase() === "true";
    if (autoRemove && args.length === 0) {
      await sleep(1000);
      await msg.delete();
    }
  } finally {
    // 清理临时文件
    await cleanupTempFile(tempImagePath);
  }
}

class GptPlugin extends Plugin {
  description: string = `
GPT 助手插件：
直接提问或回复一条消息（自动识别图片）

配置命令：
• \`gpt _set_key <API密钥>\` - 设置API密钥
• \`gpt _set_api <API地址>\` - 设置API地址（默认: https://api.openai.com）
• \`gpt _set_model <模型名>\` - 设置文本模型（默认: gpt-4o）
• \`gpt _set_vision_model <模型名>\` - 设置图像识别模型（默认: gpt-4o）
• \`gpt _set_image_upload <true/false>\` - 启用图片上传（默认: false）
• \`gpt _set_web_search <true/false>\` - 启用Web搜索（默认: false）
• \`gpt _set_auto_remove <true/false>\` - 自动删除空提问（默认: false）
• \`gpt _set_max_tokens <数量>\` - 设置最大Token数（-1表示不限制，默认: 888）
• \`gpt _set_collapse <true/false>\` - 启用折叠引用（默认: false）
  `;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    gpt: handleGptRequest,
  };
}

export default new GptPlugin();

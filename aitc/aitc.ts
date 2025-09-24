import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import axios from "axios";
import Database from "better-sqlite3";
import path from "path";
import { createDirectoryInAssets } from "@utils/pathHelpers";

const CONFIG_KEYS = {
  API_KEY: "aitc_api_key",
  API_URL: "aitc_api_url",
  MODEL: "aitc_model",
  PROMPT: "aitc_prompt",
} as const;

const DEFAULT_CONFIG: Record<string, string> = {
  [CONFIG_KEYS.API_URL]: "https://api.openai.com",
  [CONFIG_KEYS.MODEL]: "gpt-4o-mini",
  [CONFIG_KEYS.PROMPT]:
    "You are an expert in Chinese-English translation, translating user input from Chinese to colloquial English. Users can send content that needs to be translated to the assistant, and the assistant will provide the corresponding translation results, ensuring that they conform to Chinese language conventions. You can adjust the tone and style, taking into account the cultural connotations and regional differences of certain words. As a translator, you need to translate the original text into a translation that meets the standards of accuracy and elegance. Only output the translated content!!!",
};

const CONFIG_DB_PATH = path.join(
  createDirectoryInAssets("aitc"),
  "aitc_config.db",
);

class ConfigManager {
  private static db: Database.Database | null = null;
  private static initialized = false;

  private static ensureInit(): void {
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
      console.error("aitc plugin failed to init config store", error);
      throw error;
    }
  }

  static get(key: string, fallback?: string): string {
    this.ensureInit();
    try {
      const stmt = this.db!.prepare("SELECT value FROM config WHERE key = ?");
      const row = stmt.get(key) as { value: string } | undefined;
      if (row && typeof row.value === "string") {
        return row.value;
      }
    } catch (error) {
      console.error("aitc plugin failed to read config", error);
    }
    if (fallback !== undefined) return fallback;
    return DEFAULT_CONFIG[key] ?? "";
  }

  static set(key: string, value: string): void {
    this.ensureInit();
    try {
      const stmt = this.db!.prepare(
        "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
      );
      stmt.run(key, value);
    } catch (error) {
      console.error("aitc plugin failed to write config", error);
      throw error;
    }
  }

  static getAll(): Record<string, string> {
    this.ensureInit();
    try {
      const stmt = this.db!.prepare("SELECT key, value FROM config");
      const rows = stmt.all() as { key: string; value: string }[];
      const result: Record<string, string> = {};
      for (const row of rows) {
        result[row.key] = row.value;
      }
      return result;
    } catch (error) {
      console.error("aitc plugin failed to dump config", error);
      return {};
    }
  }
}

const htmlEscape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      })[char] || char,
  );

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

async function handleAitcCommand(msg: Api.Message): Promise<void> {
  const rawMessage = msg.message || "";
  const trimmed = rawMessage.trim();
  const parts = trimmed.split(/\s+/);
  const commandToken = parts.shift() || "";
  const rest = trimmed.slice(commandToken.length).trimStart();
  const subcommand = (parts[0] || "").toLowerCase();

  const replyWith = async (text: string) =>
    msg.edit({
      text,
      parseMode: "html",
      linkPreview: false,
    });

  if (!trimmed) {
    await replyWith(
      "ℹ️ <b>aitc 插件</b>\n\n" +
        "• <code>aitc [文本]</code> - 结合当前 Prompt 处理文本\n" +
        "• <code>aitc apikey &lt;OpenAI Key&gt;</code> - 设置 API Key\n" +
        "• <code>aitc model &lt;模型名&gt;</code> - 设置模型\n" +
        "• <code>aitc prompt &lt;提示词&gt;</code> - 设置系统 Prompt\n" +
        "• <code>aitc api &lt;地址&gt;</code> - 自定义 API 地址\n" +
        "• <code>aitc info</code> - 查看当前配置",
    );
    return;
  }

  const subcommandToken = parts[0] || "";
  const subcommandValue = rest.slice(subcommandToken.length).trimStart();

  switch (subcommand) {
    case "apikey":
    case "_set_key": {
      if (!subcommandValue) {
        await replyWith("❌ <b>请提供 OpenAI API Key</b>");
        return;
      }
      ConfigManager.set(CONFIG_KEYS.API_KEY, subcommandValue.trim());
      await replyWith("✅ <b>API Key 已更新</b>");
      return;
    }
    case "api":
    case "_set_api": {
      if (!subcommandValue) {
        await replyWith("❌ <b>请提供 API 地址</b>");
        return;
      }
      ConfigManager.set(
        CONFIG_KEYS.API_URL,
        trimTrailingSlash(subcommandValue.trim()),
      );
      await replyWith("✅ <b>API 地址已更新</b>");
      return;
    }
    case "model":
    case "_set_model": {
      if (!subcommandValue) {
        await replyWith("❌ <b>请提供模型名称</b>");
        return;
      }
      ConfigManager.set(CONFIG_KEYS.MODEL, subcommandValue.trim());
      await replyWith("✅ <b>模型已更新</b>");
      return;
    }
    case "prompt":
    case "_set_prompt": {
      if (!subcommandValue) {
        await replyWith("❌ <b>请提供 Prompt 文本</b>");
        return;
      }
      ConfigManager.set(CONFIG_KEYS.PROMPT, subcommandValue);
      await replyWith("✅ <b>Prompt 已更新</b>");
      return;
    }
    case "info":
    case "_info": {
      const apiUrl = ConfigManager.get(CONFIG_KEYS.API_URL);
      const model = ConfigManager.get(CONFIG_KEYS.MODEL);
      const prompt = ConfigManager.get(CONFIG_KEYS.PROMPT);
      const hasKey = !!ConfigManager.get(CONFIG_KEYS.API_KEY, "");
      await replyWith(
        `🔧 <b>当前配置</b>\n\n` +
          `• API 地址：<code>${htmlEscape(apiUrl)}</code>\n` +
          `• 模型：<code>${htmlEscape(model)}</code>\n` +
          `• Prompt：${htmlEscape(prompt || "(未设置)")}\n` +
          `• API Key：${hasKey ? "已配置" : "未配置"}`,
      );
      return;
    }
    default: {
      if (subcommandToken.startsWith("_")) {
        await replyWith("❌ <b>未知配置命令</b>");
        return;
      }
    }
  }

  let userInput = rest;
  if (!userInput) {
    try {
      const reply = await msg.getReplyMessage();
      const replyText =
        reply?.message || ("text" in (reply || {}) ? (reply as any).text : "");
      if (typeof replyText === "string") {
        userInput = replyText.trim();
      }
    } catch (error) {
      console.error("aitc plugin failed to read reply", error);
    }
  }

  if (!userInput) {
    await replyWith("❌ <b>请在命令后提供文本或回复一条消息</b>");
    return;
  }

  const apiKey = ConfigManager.get(CONFIG_KEYS.API_KEY, "");
  if (!apiKey) {
    await replyWith(
      "❌ <b>未配置 API Key</b>\n请使用 <code>aitc _set_key &lt;OpenAI Key&gt;</code> 设置后再试",
    );
    return;
  }

  const apiUrl = trimTrailingSlash(
    ConfigManager.get(CONFIG_KEYS.API_URL) ||
      DEFAULT_CONFIG[CONFIG_KEYS.API_URL],
  );
  const model =
    ConfigManager.get(CONFIG_KEYS.MODEL) || DEFAULT_CONFIG[CONFIG_KEYS.MODEL];
  const prompt =
    ConfigManager.get(CONFIG_KEYS.PROMPT) || DEFAULT_CONFIG[CONFIG_KEYS.PROMPT];

  await replyWith("⏳ <b>正在请求 OpenAI...</b>");

  try {
    const response = await axios.post(
      `${apiUrl}/v1/chat/completions`,
      {
        model,
        messages: [
          ...(prompt ? [{ role: "system", content: prompt }] : []),
          { role: "user", content: userInput },
        ],
        temperature: 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("OpenAI API 返回空结果");
    }

    const translated = content.trim();
    await replyWith(htmlEscape(translated));
  } catch (error: any) {
    console.error("aitc plugin openai error", error);
    let message = "请求失败，请稍后重试";
    if (error.response?.data?.error?.message) {
      message = error.response.data.error.message;
    } else if (error.response?.status) {
      message = `API 返回状态 ${error.response.status}`;
    } else if (error.message) {
      message = error.message;
    }
    if (message.length > 200) {
      message = message.slice(0, 200) + "...";
    }
    await replyWith(`❌ <b>OpenAI 调用失败：</b>${htmlEscape(message)}`);
  }
}

class AitcPlugin extends Plugin {
  description: string = `
自定义 Prompt 的 OpenAI 转写插件：
- aitc [文本] - 根据 Prompt 处理输入
- aitc apikey <OpenAI Key> - 设置 API Key
- aitc model <模型名> - 指定模型
- aitc api <地址> - 自定义 API 地址
- aitc prompt <提示词> - 定义系统 Prompt
- aitc info - 查看当前配置
  `;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    aitc: handleAitcCommand,
  };
}

export default new AitcPlugin();

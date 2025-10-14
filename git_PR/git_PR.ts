
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getPrefixes } from "@utils/pluginManager";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import axios from "axios";

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;'
  }[m] || m));

// Telegram 长消息处理
const MAX_MESSAGE_LENGTH = 4096;
function splitMessage(text: string): string[] {
  if ((text || "").length <= MAX_MESSAGE_LENGTH) return [text];
  const parts: string[] = [];
  let current = "";
  for (const line of (text || "").split("\n")) {
    if ((current + (current ? "\n" : "") + line).length > MAX_MESSAGE_LENGTH) {
      parts.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) parts.push(current);
  return parts.length ? parts : [text];
}
async function sendLongMessage(msg: Api.Message, text: string) {
  const parts = splitMessage(text);
  if (parts.length === 1) {
    await msg.edit({ text: parts[0], parseMode: "html" });
    return;
  }
  await msg.edit({ text: parts[0] + `\n\n📄 (1/${parts.length})`, parseMode: "html" });
  for (let i = 1; i < parts.length; i++) {
    await msg.reply({ message: parts[i] + `\n\n📄 (${i + 1}/${parts.length})`, parseMode: "html" });
  }
}

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "git";

const help_text = `⚙️ <b>Git PR 管理插件</b>

<b>命令:</b>
• <code>${mainPrefix}${pluginName} login &lt;邮箱&gt; &lt;用户名&gt; &lt;Token&gt;</code> - 登录Git
• <code>${mainPrefix}${pluginName} repos</code> - 列出有编辑权限的仓库
• <code>${mainPrefix}${pluginName} prs &lt;仓库名&gt;</code> - 列出仓库的PR
• <code>${mainPrefix}${pluginName} merge &lt;仓库名&gt; &lt;PR编号&gt;</code> - 合并PR
• <code>${mainPrefix}${pluginName} help</code> - 显示此帮助消息`;

// 配置键
const CONFIG_KEYS = {
  EMAIL: "git_email",
  USERNAME: "git_username",
  TOKEN: "git_token",
  API_BASE_URL: "git_api_base_url",
};

// 默认配置
const DEFAULT_CONFIG: Record<string, string> = {
  [CONFIG_KEYS.EMAIL]: "",
  [CONFIG_KEYS.USERNAME]: "",
  [CONFIG_KEYS.TOKEN]: "",
  [CONFIG_KEYS.API_BASE_URL]: "https://api.github.com",
};

// 配置管理器
class ConfigManager {
  private static db: any = null;
  private static initialized = false;

  private static async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const configPath = path.join(
        createDirectoryInAssets("git_manager"),
        "config.json"
      );
      this.db = await JSONFilePreset<Record<string, any>>(
        configPath,
        { ...DEFAULT_CONFIG }
      );
      this.initialized = true;
    } catch (error) {
      console.error("[git] 初始化配置失败:", error);
    }
  }

  static async get(key: string): Promise<string> {
    await this.init();
    return this.db?.data[key] ?? DEFAULT_CONFIG[key] ?? "";
  }

  static async set(key: string, value: string): Promise<boolean> {
    await this.init();
    if (!this.db) return false;
    try {
      this.db.data[key] = value;
      await this.db.write();
      return true;
    } catch (error) {
      console.error(`[git] 设置配置失败 ${key}:`, error);
      return false;
    }
  }
}

// 统一创建 GitHub API 客户端
async function getApi() {
  const baseURL = await ConfigManager.get(CONFIG_KEYS.API_BASE_URL);
  const token = await ConfigManager.get(CONFIG_KEYS.TOKEN);
  if (!token) throw new Error("请先使用 `login` 命令登录");

  return axios.create({
    baseURL,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "telebox-git-plugin",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
}

class GitManagerPlugin extends Plugin {
  description: string = `通过Git API管理PR\n\n${help_text}`;

  cmdHandlers = {
    [pluginName]: async (msg: Api.Message) => {
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.trim()?.split(/\s+/g) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();

      try {
        // 无参数：显示帮助
        if (!sub) {
          await sendLongMessage(msg, help_text);
          return;
        }

        // help 在前：.git help [sub]
        if (sub === "help" || sub === "h") {
          await sendLongMessage(msg, help_text);
          return;
        }

        // help 在后：.git [sub] help
        if (args[1] && (args[1].toLowerCase() === "help" || args[1].toLowerCase() === "h")) {
          await sendLongMessage(msg, help_text);
          return;
        }

        switch (sub) {
          case "login":
            await this.handleLogin(msg, args.slice(1));
            break;
          case "repos":
            await this.handleRepos(msg);
            break;
          case "prs":
            await this.handlePRs(msg, args.slice(1));
            break;
          case "merge":
            await this.handleMerge(msg, args.slice(1));
            break;
          default:
            await msg.edit({ text: `❌ <b>未知子命令:</b> <code>${htmlEscape(sub)}</code>\n\n${help_text}`, parseMode: "html" });
        }
      } catch (error: any) {
        console.error('[git] 插件执行失败:', error);
        await msg.edit({ text: `❌ <b>操作失败:</b> ${htmlEscape(error.message)}`, parseMode: "html" });
      }
    },
  };

  private async handleLogin(msg: Api.Message, args: string[]) {
    if (args.length < 3) {
      await msg.edit({ text: `❌ <b>参数不足</b>\n\n<b>格式:</b> <code>${mainPrefix}${pluginName} login &lt;邮箱&gt; &lt;用户名&gt; &lt;Token&gt;</code>`, parseMode: "html" });
      return;
    }

    const [email, username, token] = args;
    await ConfigManager.set(CONFIG_KEYS.EMAIL, email);
    await ConfigManager.set(CONFIG_KEYS.USERNAME, username);
    await ConfigManager.set(CONFIG_KEYS.TOKEN, token);

    await msg.edit({ text: "✅ <b>登录信息已保存</b>", parseMode: "html" });
  }

  private async handleRepos(msg: Api.Message) {
    await msg.edit({ text: "🔄 正在获取仓库列表...", parseMode: "html" });
    const api = await getApi();
    const response = await api.get(`/user/repos`, { params: { per_page: 100 } });

    const repos = (response.data as any[])
      .filter((r: any) => r?.permissions?.push || r?.permissions?.admin || r?.permissions?.maintain)
      .map((r: any) => r.full_name);
    if (!repos.length) {
      await msg.edit({ text: "ℹ️ 未找到有编辑权限的仓库。", parseMode: "html" });
      return;
    }

    const repoList = repos.map((repo: string) => `• <code>${htmlEscape(repo)}</code>`).join("\n");
    await sendLongMessage(msg, `🗂️ <b>有编辑权限的仓库:</b>\n\n${repoList}`);
  }

  private async handlePRs(msg: Api.Message, args: string[]) {
    if (args.length < 1) {
      throw new Error("参数不足，需要提供仓库名");
    }
    const repoName = args[0];
    await msg.edit({ text: `🔄 正在获取 <code>${htmlEscape(repoName)}</code> 的PR列表...`, parseMode: "html" });

    const parts = repoName.split("/");
    if (parts.length !== 2) {
      throw new Error("仓库名格式应为 owner/repo，例如 octocat/Hello-World");
    }
    const [owner, repo] = parts;

    const api = await getApi();
    const response = await api.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
      params: { state: "open", per_page: 50 }
    });

    const list: any[] = response.data || [];
    if (!list.length) {
      await msg.edit({ text: `ℹ️ 仓库 <code>${htmlEscape(repoName)}</code> 中没有待处理的PR。`, parseMode: "html" });
      return;
    }

    // 获取可合并状态（可能为 null），尽量标注
    const details = [] as { number: number; title: string; user: string; mergeable?: boolean; state?: string }[];
    for (const item of list) {
      try {
        const pr = await api.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${item.number}`);
        details.push({
          number: item.number,
          title: item.title || "",
          user: item?.user?.login || "",
          mergeable: pr.data?.mergeable,
          state: pr.data?.mergeable_state
        });
      } catch {
        details.push({ number: item.number, title: item.title || "", user: item?.user?.login || "" });
      }
    }

    const prList = details.map((pr) => {
      const flag = pr.mergeable === true ? "✅ 可合并" : pr.mergeable === false ? `⛔ 不可合并(${pr.state || "unknown"})` : "❓ 未知";
      return `• <b>#${pr.number}</b>: ${htmlEscape(pr.title)}\n  作者: <code>${htmlEscape(pr.user)}</code> | 状态: ${flag}`;
    }).join("\n\n");

    await sendLongMessage(msg, `📬 <b>待处理的PR:</b>\n\n${prList}`);
  }

  private async handleMerge(msg: Api.Message, args: string[]) {
    if (args.length < 2) {
      throw new Error("参数不足，需要提供仓库名和PR编号");
    }
    const [repoName, prNumberStr] = args;
    const prNumber = parseInt(prNumberStr, 10);
    if (isNaN(prNumber)) {
      throw new Error("PR编号必须是数字");
    }

    await msg.edit({ text: `🔄 正在合并 <code>${htmlEscape(repoName)}</code> 中的 PR #${prNumber}...`, parseMode: "html" });

    const parts = repoName.split("/");
    if (parts.length !== 2) {
      throw new Error("仓库名格式应为 owner/repo，例如 octocat/Hello-World");
    }
    const [owner, repo] = parts;

    const api = await getApi();
    try {
      await api.put(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/merge`);
      await msg.edit({ text: `✅ 成功合并 PR #${prNumber}`, parseMode: "html" });
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message;
      throw new Error(`合并失败: ${errorMsg}`);
    }
  }
}

export default new GitManagerPlugin();

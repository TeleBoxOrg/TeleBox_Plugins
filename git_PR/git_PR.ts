
import { Plugin, type PanelSettingsAdapter, type PanelSettingField, type PanelFieldType } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
import { getPrefixes } from "@utils/pluginManager";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { resolvePluginAssetFile } from "@utils/pathHelpers";
import axios from "axios";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { htmlEscape } from "@utils/htmlEscape";

// GitHub API types
interface GitHubRepoPermissions {
  push?: boolean;
  admin?: boolean;
  maintain?: boolean;
}

interface GitHubRepo {
  full_name: string;
  permissions?: GitHubRepoPermissions;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  user?: { login?: string };
  mergeable?: boolean;
  mergeable_state?: string;
  state?: string;
  html_url?: string;
  body?: string;
  head?: { sha?: string; ref?: string };
  base?: { sha?: string; ref?: string };
}

interface GitHubPullRequestDetail {
  number: number;
  title: string;
  user: string;
  mergeable?: boolean;
  state?: string;
}

interface GitHubApiError {
  message?: string;
}

function extractGitHubApiError(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { data?: GitHubApiError } }).response;
    if (response?.data?.message) return response.data.message;
  }
  return undefined;
}

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
async function sendLongMessage(msg: MessageContext, text: string) {
  const parts = splitMessage(text);
  if (parts.length === 1) {
    await msg.edit({ text: html(parts[0]) });
    return;
  }
  await msg.edit({ text: html(parts[0] + `\n\n📄 (1/${parts.length})`) });
  // 注意：消息必须按顺序逐条发送，不能并行（每条消息依赖前一条发送完成以保持顺序）
  for (let i = 1; i < parts.length; i++) {
    await msg.replyText(html(parts[i] + `\n\n📄 (${i + 1}/${parts.length})`));
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
• <code>${mainPrefix}${pluginName} mergeall &lt;仓库名&gt;</code> - 按序号合并所有可合并的PR
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
  private static db: Awaited<ReturnType<typeof JSONFilePreset<Record<string, string>>>> | null = null;
  private static initialized = false;

  private static async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const configPath = resolvePluginAssetFile({
        plugin: "git_PR",
        fileName: "config.json",
        legacyDirs: ["git_manager", "git"],
        legacyFiles: [
          { dir: "git_manager", fileName: "config.json" },
          { dir: "git", fileName: "config.json" },
        ],
      });
      this.db = await JSONFilePreset<Record<string, string>>(
        configPath,
        { ...DEFAULT_CONFIG }
      );
      this.initialized = true;
    } catch (error: unknown) {
      logger.error("[git] 初始化配置失败:", error);
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
    } catch (error: unknown) {
      logger.error(`[git] 设置配置失败 ${key}:`, error);
      return false;
    }
  }
}

// 统一创建 GitHub API 客户端
async function getApi() {
  const [baseURL, token] = await Promise.all([
    ConfigManager.get(CONFIG_KEYS.API_BASE_URL),
    ConfigManager.get(CONFIG_KEYS.TOKEN),
  ]);
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
    [pluginName]: async (msg: MessageContext) => {
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
          case "mergeall":
            await this.handleMergeAll(msg, args.slice(1));
            break;
          default:
            await msg.edit({ text: html`❌ <b>未知子命令:</b> <code>${htmlEscape(sub)}</code>\n\n${help_text}` });
        }
      } catch (error: unknown) {
        logger.error('[git] 插件执行失败:', error);
        await msg.edit({ text: html`❌ <b>操作失败:</b> ${htmlEscape(getErrorMessage(error))}` });
      }
    },
  };

  private async handleLogin(msg: MessageContext, args: string[]) {
    if (args.length < 3) {
        await msg.edit({ text: html`❌ <b>参数不足</b>\n\n<b>格式:</b> <code>${mainPrefix}${pluginName} login &lt;邮箱&gt; &lt;用户名&gt; &lt;Token&gt;</code>` });
      return;
    }

    const [email, username, token] = args;
    await ConfigManager.set(CONFIG_KEYS.EMAIL, email);
    await ConfigManager.set(CONFIG_KEYS.USERNAME, username);
    await ConfigManager.set(CONFIG_KEYS.TOKEN, token);

    await msg.edit({ text: html`✅ <b>登录信息已保存</b>` });
  }

  private async handleRepos(msg: MessageContext) {
    await msg.edit({ text: "🔄 正在获取仓库列表..." });
    const api = await getApi();
    const response = await api.get(`/user/repos`, { params: { per_page: 100 } });

    const repos = (response.data as GitHubRepo[])
      .filter((r) => r?.permissions?.push || r?.permissions?.admin || r?.permissions?.maintain)
      .map((r) => r.full_name);
    if (!repos.length) {
      await msg.edit({ text: "ℹ️ 未找到有编辑权限的仓库。" });
      return;
    }

    const repoList = repos.map((repo: string) => `• <code>${htmlEscape(repo)}</code>`).join("\n");
    await sendLongMessage(msg, `🗂️ <b>有编辑权限的仓库:</b>\n\n${repoList}`);
  }

  private async handlePRs(msg: MessageContext, args: string[]) {
    if (args.length < 1) {
      throw new Error("参数不足，需要提供仓库名");
    }
    const repoName = args[0];
    await msg.edit({ text: html`🔄 正在获取 <code>${htmlEscape(repoName)}</code> 的PR列表...` });

    const parts = repoName.split("/");
    if (parts.length !== 2) {
      throw new Error("仓库名格式应为 owner/repo，例如 octocat/Hello-World");
    }
    const [owner, repo] = parts;

    const api = await getApi();
    const response = await api.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
      params: { state: "open", per_page: 50 }
    });

    const list: GitHubPullRequest[] = response.data || [];
    if (!list.length) {
      await msg.edit({ text: html`ℹ️ 仓库 <code>${htmlEscape(repoName)}</code> 中没有待处理的PR。` });
      return;
    }

    // 获取可合并状态（可能为 null），尽量标注（并行请求）
    const details = (await Promise.all(
      list.map(async (item) => {
        try {
          const pr = await api.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${item.number}`);
          return {
            number: item.number,
            title: item.title || "",
            user: item?.user?.login || "",
            mergeable: pr.data?.mergeable,
            state: pr.data?.mergeable_state
          };
        } catch (_e: unknown) {
          return { number: item.number, title: item.title || "", user: item?.user?.login || "" };
        }
      })
    )) as GitHubPullRequestDetail[];

    const prList = details.map((pr) => {
      const flag = pr.mergeable ? "✅ 可合并" : pr.mergeable === false ? `⛔ 不可合并(${pr.state || "unknown"})` : "❓ 未知";
      return `• <b>#${pr.number}</b>: ${htmlEscape(pr.title)}\n  作者: <code>${htmlEscape(pr.user)}</code> | 状态: ${flag}`;
    }).join("\n\n");

    await sendLongMessage(msg, `📬 <b>待处理的PR:</b>\n\n${prList}`);
  }

  private async handleMerge(msg: MessageContext, args: string[]) {
    if (args.length < 2) {
      throw new Error("参数不足，需要提供仓库名和PR编号");
    }
    const [repoName, prNumberStr] = args;
    const prNumber = parseInt(prNumberStr, 10);
    if (isNaN(prNumber)) {
      throw new Error("PR编号必须是数字");
    }

    await msg.edit({ text: html`🔄 正在合并 <code>${htmlEscape(repoName)}</code> 中的 PR #${prNumber}...` });

    const parts = repoName.split("/");
    if (parts.length !== 2) {
      throw new Error("仓库名格式应为 owner/repo，例如 octocat/Hello-World");
    }
    const [owner, repo] = parts;

    const api = await getApi();
    try {
      await api.put(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/merge`);
      await msg.edit({ text: `✅ 成功合并 PR #${prNumber}` });
    } catch (error: unknown) {
      const errObj = error as Record<string, unknown>;
      const resp = errObj.response as Record<string, unknown> | undefined;
      const data = resp?.data as Record<string, unknown> | undefined;
      const errorMsg = (typeof data?.message === "string" ? data.message : undefined) || getErrorMessage(error);
      throw new Error(`合并失败: ${errorMsg}`);
    }
  }

  private async handleMergeAll(msg: MessageContext, args: string[]) {
    if (args.length < 1) {
      throw new Error("参数不足，需要提供仓库名");
    }
    const repoName = args[0];
    await msg.edit({ text: html`🔄 正在准备批量合并 <code>${htmlEscape(repoName)}</code> 的PR...` });

    const parts = repoName.split("/");
    if (parts.length !== 2) {
      throw new Error("仓库名格式应为 owner/repo，例如 octocat/Hello-World");
    }
    const [owner, repo] = parts;

    const api = await getApi();

    // 1. 获取所有PR的详细信息
    const prsResponse = await api.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
      params: { state: "open", per_page: 100 }
    });

    const prsList: GitHubPullRequest[] = prsResponse.data || [];
    if (!prsList.length) {
      await msg.edit({ text: html`ℹ️ 仓库 <code>${htmlEscape(repoName)}</code> 中没有待处理的PR。` });
      return;
    }

    // 2. 筛选可合并的PR（并行请求）
    const mergeablePRs = (await Promise.all(
      prsList.map(async (item) => {
        try {
          const pr = await api.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${item.number}`);
          return pr.data?.mergeable ? item : null;
        } catch (e: unknown) { logger.warn(`[git_PR] 忽略获取详情失败的PR:`, e); return null; }
      })
    )).filter((item): item is NonNullable<typeof item> => item !== null);

    if (mergeablePRs.length === 0) {
      await msg.edit({ text: html`ℹ️ 仓库 <code>${htmlEscape(repoName)}</code> 中没有可自动合并的PR。` });
      return;
    }

    // 按PR编号升序排序
    mergeablePRs.sort((a, b) => a.number - b.number);

    // 3. 依次合并
    let report = `🔀 <b>批量合并报告 for <code>${htmlEscape(repoName)}</code>:</b>\n\n`;
    let successCount = 0;
    let failCount = 0;

    for (const pr of mergeablePRs) {
      try {
        await api.put(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr.number}/merge`);
        report += `✅ <b>#${pr.number}</b>: ${htmlEscape(pr.title)} - <b>成功</b>\n`;
        successCount++;
      } catch (error: unknown) {
        const errorMsg = extractGitHubApiError(error) || getErrorMessage(error);
        report += `❌ <b>#${pr.number}</b>: ${htmlEscape(pr.title)} - <b>失败:</b> ${htmlEscape(errorMsg)}\n`;
        failCount++;
      }
      // 编辑消息以显示进度
      await sendLongMessage(msg, report + `\n🔄 进度: ${successCount + failCount}/${mergeablePRs.length}...`);
    }

    report += `\n🎉 <b>操作完成:</b> ${successCount}个成功, ${failCount}个失败。`;
    await sendLongMessage(msg, report);
  }
}


  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "git_PR",
    title: "Git PR 管理",
    description: "GitHub/GitLab PR 管理配置",
    category: "插件配置",
    icon: "🔀",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "token",
            "label": "Access Token",
            "type": "password",
            "secret": true
      },
      {
            "key": "baseUrl",
            "label": "Git 实例地址",
            "type": "string",
            "default": "https://api.github.com"
      },
      {
            "key": "defaultOwner",
            "label": "默认仓库所有者",
            "type": "string"
      },
      {
            "key": "defaultRepo",
            "label": "默认仓库名",
            "type": "string"
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("git_PR"), "config.json"), DEFAULT_CONFIG);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("git_PR"), "config.json"), DEFAULT_CONFIG);
      Object.assign(db.data, patch);
      await db.write();
    },
  };

export default new GitManagerPlugin();

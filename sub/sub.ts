import { Plugin, type PanelSettingsAdapter, type PanelSettingField, type PanelFieldType } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import type { MessageContext } from "@mtcute/dispatcher";
import type { MtcuteFileDownloadLocation } from "@utils/mtcuteTypes";
import type { Chat } from "@mtcute/node";
import { thtml as html } from "@mtcute/html-parser";
import { getRawType } from "@utils/entityTypeGuards";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import crypto from "crypto";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { getErrorMessage } from "@utils/errorHelpers";
import { logger } from "@utils/logger";
import { sleep } from "@utils/asyncHelpers";

const execFileAsync = promisify(execFile);
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

/** 安全执行外部命令（无 shell） */
async function run(
  command: string,
  args: string[] = [],
  opts: { cwd?: string; timeout?: number; ignoreError?: boolean } = {}
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
    return String(stdout ?? "") + (stderr ? String(stderr) : "");
  } catch (error: unknown) {
    if (opts.ignoreError) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      return String(e.stdout ?? "") + String(e.stderr ?? e.message ?? "");
    }
    throw error;
  }
}

// 检查是否在收藏夹
async function isSavedMessages(msg: MessageContext): Promise<boolean> {
  const client = await getGlobalClient();
  const me = await client?.getMe();
  if (!me) return false;

  return msg.chat.id === me.id;
}

// 检查Docker完整性
async function checkDockerIntegrity(): Promise<{
  valid: boolean;
  error?: string;
}> {
  try {
    await run("which", ["docker"]);
    await run("systemctl", ["is-active", "docker"]);
    await run("docker", ["info"]);
    return { valid: true };
  } catch (error: unknown) {
    if (getErrorMessage(error).includes("Cannot connect to the Docker daemon")) {
      return { valid: false, error: "Docker服务未运行" };
    }
    if (
      getErrorMessage(error).includes("docker: command not found") ||
      getErrorMessage(error).includes("not found")
    ) {
      return { valid: false, error: "Docker未安装" };
    }
    return { valid: false, error: "Docker配置异常" };
  }
}

// 获取Sub-Store版本
async function getSubStoreVersion(): Promise<string> {
  try {
    const names = await run("docker", ["ps", "--format", "{{.Names}}"], {
      ignoreError: true,
    });
    if (!names.split("\n").some((n) => n.trim() === "sub-store")) {
      return "未运行";
    }

    let logOutput = await run("docker", ["logs", "sub-store"], {
      ignoreError: true,
    });
    let versionMatch = logOutput.match(/Sub-Store -- (v[\d.]+)/);

    // 如果没有找到版本信息，可能是日志不完整，重启容器生成完整日志
    if (!versionMatch) {
      await run("docker", ["restart", "sub-store"], { ignoreError: true });
      await sleep(5000);
      logOutput = await run("docker", ["logs", "sub-store"], {
        ignoreError: true,
      });
      versionMatch = logOutput.match(/Sub-Store -- (v[\d.]+)/);
    }

    return versionMatch ? versionMatch[1] : "未知版本";
  } catch (e: unknown) {
    logger.warn("[sub] 解析Sub-Store版本失败:", e);
    return "获取失败";
  }
}

// 获取远程最新版本
async function getRemoteVersion(): Promise<string> {
  try {
    const response = await run("curl", [
      "-s",
      "--max-time",
      "15",
      "https://api.github.com/repos/sub-store-org/Sub-Store/releases/latest",
    ]);
    const releaseData = JSON.parse(response);
    return releaseData.tag_name || "获取失败";
  } catch (e: unknown) {
    logger.warn("[sub] 获取远程Sub-Store版本失败:", e);
    return "获取失败";
  }
}

// 比较版本号
function compareVersions(
  local: string,
  remote: string
): {
  hasUpdate: boolean;
  localVersion: string;
  remoteVersion: string;
} {
  if (local === "未运行" || local === "获取失败" || remote === "获取失败") {
    return { hasUpdate: false, localVersion: local, remoteVersion: remote };
  }

  const parseVersion = (v: string) => {
    const cleaned = v.replace(/^v/, "");
    return cleaned.split(".").map((num) => parseInt(num) || 0);
  };

  const localParts = parseVersion(local);
  const remoteParts = parseVersion(remote);

  for (let i = 0; i < Math.max(localParts.length, remoteParts.length); i++) {
    const localPart = localParts[i] || 0;
    const remotePart = remoteParts[i] || 0;

    if (remotePart > localPart) {
      return { hasUpdate: true, localVersion: local, remoteVersion: remote };
    }
    if (localPart > remotePart) {
      return { hasUpdate: false, localVersion: local, remoteVersion: remote };
    }
  }

  return { hasUpdate: false, localVersion: local, remoteVersion: remote };
}

async function getPublicIp(): Promise<string> {
  try {
    const ip = await run("curl", ["-s", "--max-time", "5", "ifconfig.me"]);
    return ip.trim() || "未知";
  } catch {
    return "未知";
  }
}

const help = `🧩 <b>Sub-Store 管理</b>
• <code>${mainPrefix}sub up</code> - 安装
• <code>${mainPrefix}sub update</code> - 更新容器
• <code>${mainPrefix}sub info</code> - 综合信息查看
• <code>${mainPrefix}sub fix-docker</code> - 重装Docker
• <code>${mainPrefix}sub logs</code> - 导出今日日志文件
• <code>${mainPrefix}sub clean</code> - 卸载
• <code>${mainPrefix}sub backup</code> - 备份
• <code>${mainPrefix}sub restore</code> - 恢复`;

class SubStorePlugin extends Plugin {
  description = `Sub-Store 管理\n\n${help}`;

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    sub: async (msg) => {
      const parts = msg.text?.split(/\s+/) || [];
      const cmd = (parts[1] || "help").toLowerCase();
      const arg = parts[2];

      const chat = msg.chat as Chat;
      if (chat.isGroup || getRawType(chat) === "channel") {
        await msg.edit({
          text: "❌ 为保护用户隐私，禁止在公共对话环境使用",
        });
        return;
      }

      // 检查root权限
      if (
        os.platform() !== "linux" ||
        !process.getuid ||
        process.getuid() !== 0
      ) {
        await msg.edit({ text: "❌ 需要Linux root权限" });
        return;
      }

      try {
        switch (cmd) {
          case "help":
            await msg.edit({ text: html(help) });
            break;

          case "up": {
            // 检查Docker完整性
            await msg.edit({ text: "🔍 检查Docker完整性..." });
            const dockerCheck = await checkDockerIntegrity();
            if (!dockerCheck.valid) {
              await msg.edit({
                text: html`❌ Docker检查失败: ${dockerCheck.error}\n\n🔧 请先执行: <code>${mainPrefix}sub fix-docker</code>`,
              });
              return;
            }

            const secret = crypto.randomBytes(16).toString("hex");

            // 分步骤部署，每步单独执行和检查
            try {
              await msg.edit({ text: "✅ Docker检查通过\n🛠 创建目录..." });
              fs.mkdirSync("/root/sub-store", { recursive: true });
              fs.mkdirSync("/root/sub-store-data", { recursive: true });

              await msg.edit({ text: "✅ 目录创建完成\n🧹 清理旧容器..." });
              await run("docker", ["rm", "-f", "sub-store"], {
                ignoreError: true,
              });

              await msg.edit({ text: "✅ 旧容器已清理\n📝 生成配置..." });
              fs.writeFileSync("/root/sub-store/.secret", secret, "utf8");

              const composeContent = `services:
  sub-store:
    image: xream/sub-store
    container_name: sub-store
    restart: always
    environment:
      - SUB_STORE_FRONTEND_BACKEND_PATH=/${secret}
    ports: ["3001:3001"]
    volumes: ["/root/sub-store-data:/opt/app/data"]`;

              fs.writeFileSync(
                "/root/sub-store/docker-compose.yml",
                composeContent
              );

              await msg.edit({ text: "✅ 配置已生成\n🐳 拉取镜像..." });
              await run("docker", ["compose", "pull"], {
                cwd: "/root/sub-store",
              });

              await msg.edit({ text: "✅ 镜像拉取完成\n🚀 启动容器..." });
              await run("docker", ["compose", "up", "-d"], {
                cwd: "/root/sub-store",
              });

              const ip = await getPublicIp();
              await msg.edit({
                text: `✅ 部署完成\n\n面板: http://${ip}:3001\n后端: http://${ip}:3001/${secret}`,
              });
            } catch (error: unknown) {
              let errorMsg = `❌ 部署失败: ${getErrorMessage(error)}\n\n`;
              if (
                getErrorMessage(error).includes(
                  "Cannot connect to the Docker daemon"
                ) ||
                getErrorMessage(error).includes("docker.service not found")
              ) {
                errorMsg += `🔧 Docker未正确安装，请执行: <code>${mainPrefix}sub fix-docker</code>\n\n`;
              }
              errorMsg += `💡 其他解决方案:\n1. ${mainPrefix}sub check - 系统检查\n2. ${mainPrefix}sub manual - 查看手动步骤`;
              await msg.edit({ text: html(errorMsg) });
            }
            break;
          }

          case "update":
            await msg.edit({ text: "🔄 更新Sub-Store容器中..." });
            try {
              // 检查Docker完整性
              const dockerCheck = await checkDockerIntegrity();
              if (!dockerCheck.valid) {
                await msg.edit({
                  text: `❌ Docker检查失败: ${dockerCheck.error}`,
                });
                return;
              }

              // 检查是否已部署
              if (!fs.existsSync("/root/sub-store/docker-compose.yml")) {
                await msg.edit({
                  text: "❌ Sub-Store未部署，请先执行安装命令",
                });
                return;
              }

              await msg.edit({ text: "🛑 停止容器..." });
              await run("docker", ["stop", "sub-store"]);

              await msg.edit({ text: "🗑️ 删除容器..." });
              await run("docker", ["rm", "sub-store"]);

              await msg.edit({ text: "📥 拉取最新镜像..." });
              await run("docker", ["compose", "pull", "sub-store"], {
                cwd: "/root/sub-store",
              });

              await msg.edit({ text: "🚀 启动新容器..." });
              await run("docker", ["compose", "up", "-d", "sub-store"], {
                cwd: "/root/sub-store",
              });

              await msg.edit({ text: "🧹 清理旧镜像..." });
              await run("docker", ["image", "prune", "-f"]);

              const ip = await getPublicIp();
              const secretFile = "/root/sub-store/.secret";
              const secret = fs.existsSync(secretFile)
                ? fs.readFileSync(secretFile, "utf8").trim()
                : "";

              await msg.edit({ text: "🔍 获取版本信息..." });
              const [localVersion, remoteVersion] = await Promise.all([
                getSubStoreVersion(),
                getRemoteVersion(),
              ]);

              await msg.edit({
                text: `✅ 更新完成\n\n📦 本地版本: ${localVersion}\n🌍 远程版本: ${remoteVersion}\n🌐 面板: http://${ip}:3001\n🔗 后端: http://${ip}:3001/${secret}`,
              });
            } catch (error: unknown) {
              await msg.edit({
                text: `❌ 更新失败: ${getErrorMessage(error)}`,
              });
            }
            break;

          case "info":
          case "check":
          case "status":
            await msg.edit({ text: "🔍 获取综合信息中..." });
            let infoResult = "📊 <b>Sub-Store 综合信息</b>\n\n";

            try {
              // 系统信息
              const platform = os.platform();
              const uid = process.getuid ? process.getuid() : "未知";
              infoResult += `🖥 系统: ${platform}\n👤 UID: ${uid}\n\n`;

              // Docker状态检查
              try {
                await run("which", ["docker"]);
                infoResult += "✅ Docker已安装\n";

                try {
                  await run("systemctl", ["is-active", "docker"]);
                  infoResult += "✅ Docker服务运行中\n";

                  try {
                    await run("docker", ["info"]);
                    infoResult += "✅ Docker可正常连接\n";
                  } catch (e: unknown) {
                    logger.warn("[sub] Docker连接检测失败:", e);
                    infoResult += `❌ Docker连接失败\n`;
                  }
                } catch (e: unknown) {
                  logger.warn("[sub] Docker服务检测失败:", e);
                  infoResult += "❌ Docker服务未启动\n";
                }
              } catch (e: unknown) {
                logger.warn("[sub] Docker安装检测失败:", e);
                infoResult += "❌ Docker未安装\n";
              }

              // Sub-Store部署状态
              const secretFile = "/root/sub-store/.secret";
              if (fs.existsSync(secretFile)) {
                const key = fs.readFileSync(secretFile, "utf8").trim();
                const psOut = await run(
                  "docker",
                  ["ps", "--format", "{{.Names}} {{.Status}}"],
                  { ignoreError: true }
                );
                const containerLine =
                  psOut
                    .split("\n")
                    .map((l) => l.trim())
                    .find((l) => l.startsWith("sub-store ")) || "未运行";
                const ip = await getPublicIp();
                const [localVersion, remoteVersion] = await Promise.all([
                  getSubStoreVersion(),
                  getRemoteVersion(),
                ]);
                const versionCompare = compareVersions(
                  localVersion,
                  remoteVersion
                );

                infoResult += `\n🏠 <b>Sub-Store 状态</b>\n`;
                infoResult += `📦 容器: ${containerLine}\n`;
                infoResult += `🏷️ 本地版本: ${localVersion}\n`;
                infoResult += `🌍 远程版本: ${remoteVersion}\n`;

                if (versionCompare.hasUpdate) {
                  infoResult += `🔄 <b>有可用更新！</b>\n`;
                  infoResult += `💡 使用 <code>${mainPrefix}sub update</code> 更新到最新版本\n`;
                } else if (
                  localVersion !== "未运行" &&
                  remoteVersion !== "获取失败"
                ) {
                  infoResult += `✅ 已是最新版本\n`;
                }

                infoResult += `🌐 面板: http://${ip}:3001\n`;
                infoResult += `🔗 后端: http://${ip}:3001/${key}\n`;
              } else {
                infoResult += `\n❌ Sub-Store 未部署\n`;
              }

              // 网络检查
              try {
                await run("curl", ["-s", "--max-time", "3", "ifconfig.me"]);
                infoResult += `\n✅ 网络连接正常`;
              } catch (e: unknown) {
                logger.warn("[sub] 网络连接检测失败:", e);
                infoResult += `\n❌ 网络连接异常`;
              }
            } catch (error: unknown) {
              infoResult += `❌ 信息获取失败: ${getErrorMessage(error)}`;
            }

            await msg.edit({ text: html(infoResult) });
            break;

          case "fix-docker":
            await msg.edit({ text: "🔧 重装Docker中..." });
            try {
              await msg.edit({ text: "🔧 清理旧Docker包..." });
              await run(
                "apt-get",
                [
                  "purge",
                  "-y",
                  "docker-cli",
                  "docker-buildx-plugin",
                  "docker-compose-plugin",
                ],
                { ignoreError: true }
              );
              await run("apt-get", ["autoremove", "-y"]);

              await msg.edit({ text: "📦 下载Docker安装脚本..." });
              await run("curl", [
                "-fsSL",
                "https://get.docker.com",
                "-o",
                "/tmp/get-docker.sh",
              ]);

              await msg.edit({ text: "⚙️ 安装Docker CE..." });
              await run("bash", ["/tmp/get-docker.sh"]);

              await msg.edit({ text: "🚀 启动Docker服务..." });
              await run("systemctl", ["enable", "docker"]);
              await run("systemctl", ["start", "docker"]);
              await sleep(3000);

              await msg.edit({ text: "✅ 验证Docker安装..." });
              const version = await run("docker", ["--version"]);
              await run("docker", ["info"]);

              await msg.edit({
                text: `✅ Docker重装完成\n\n${version.trim()}\n\n现在可以使用 ${mainPrefix}sub up 部署Sub-Store`,
              });
            } catch (error: unknown) {
              await msg.edit({
                text: `❌ Docker重装失败: ${getErrorMessage(error)}\n\n请手动执行:\ncurl -fsSL https://get.docker.com | bash\nsystemctl start docker`,
              });
            }
            break;

          case "manual": {
            const manualText = `🛠 <b>手动部署方案</b>

<code>1. 启动Docker:</code>
systemctl start docker
systemctl enable docker

<code>2. 创建目录:</code>
mkdir -p /root/sub-store /root/sub-store-data

<code>3. 生成密钥:</code>
SECRET=$(openssl rand -hex 16)
echo $SECRET > /root/sub-store/.secret

<code>4. 创建配置文件:</code>
cat > /root/sub-store/docker-compose.yml << EOF
services:
  sub-store:
    image: xream/sub-store
    container_name: sub-store
    restart: always
    environment:
      - SUB_STORE_FRONTEND_BACKEND_PATH=/\\$SECRET
    ports: ["3001:3001"]
    volumes: ["/root/sub-store-data:/opt/app/data"]
EOF

<code>5. 部署:</code>
cd /root/sub-store
docker compose up -d

<code>6. 查看结果:</code>
IP=$(curl -s ifconfig.me)
echo "面板: http://\\$IP:3001"
echo "后端: http://\\$IP:3001/\\$SECRET"`;

            await msg.edit({ text: html(manualText) });
            break;
          }

          case "logs":
            await msg.edit({ text: "📋 生成今日日志文件..." });
            try {
              const today = new Date().toISOString().split("T")[0];
              const todayLogs = await run(
                "docker",
                ["logs", "sub-store", "--since", `${today}T00:00:00`],
                { ignoreError: true }
              );
              const logBody = todayLogs.trim() || "今日无日志";

              const tmpDir = createDirectoryInTemp("logs");
              const logFile = path.join(tmpDir, `sub-store-logs-${today}.txt`);
              const logContent = `Sub-Store 日志 - ${today}\n${"=".repeat(
                50
              )}\n\n${logBody}`;

              fs.writeFileSync(logFile, logContent, "utf8");

              const client = await getGlobalClient();
              const me = await client?.getMe();
              if (client && me) {
                await client.sendMedia(me.id, {
                  type: "document",
                  file: logFile,
                  fileName: `sub-store-logs-${today}.txt`,
                  caption: `📋 Sub-Store 今日日志 (${today})`,
                });
                const size = fs.statSync(logFile).size;
                await msg.edit({
                  text: `✅ 今日日志已发送至收藏夹\n文件大小: ${(
                    size / 1024
                  ).toFixed(1)}KB`,
                });
              } else {
                await msg.edit({ text: "❌ 无法发送文件到收藏夹" });
              }
            } catch (error: unknown) {
              await msg.edit({
                text: `❌ 日志导出失败: ${getErrorMessage(error)}`,
              });
            }
            break;

          case "clean":
            await msg.edit({ text: "🧹 卸载中..." });
            await run("docker", ["rm", "-f", "sub-store"], {
              ignoreError: true,
            });
            fs.rmSync("/root/sub-store", { recursive: true, force: true });
            fs.rmSync("/root/sub-store-data", { recursive: true, force: true });
            await msg.edit({ text: "✅ 已卸载" });
            break;

          case "backup": {
            await msg.edit({ text: "📦 备份中..." });
            const tmpDir = createDirectoryInTemp("backup");
            const backupFile = path.join(tmpDir, `backup_${Date.now()}.tgz`);
            await run("tar", ["czf", backupFile, "-C", "/root", "sub-store-data"]);

            const client = await getGlobalClient();
            const me = await client?.getMe();
            if (client && me) {
              await client.sendMedia(me.id, {
                type: "document",
                file: backupFile,
                fileName: `sub-store-backup.tgz`,
                caption: "Sub-Store 备份",
              });
            }
            await msg.edit({ text: "✅ 已备份至收藏夹" });
            break;
          }

          case "restore": {
            const reply = await safeGetReplyMessage(msg);
            if (!reply || !reply.media) {
              await msg.edit({ text: "❌ 请回复备份文件" });
              return;
            }
            await msg.edit({ text: "♻️ 恢复中..." });
            const _restoreClient = await getGlobalClient();
            const buf = await _restoreClient.downloadAsBuffer(
              reply.media as MtcuteFileDownloadLocation
            );
            const restoreFile = `/tmp/restore_${Date.now()}.tgz`;
            fs.writeFileSync(restoreFile, Buffer.from(buf));

            await run("docker", ["stop", "sub-store"], { ignoreError: true });
            // 清空数据目录但保留目录本身
            if (fs.existsSync("/root/sub-store-data")) {
              for (const entry of fs.readdirSync("/root/sub-store-data")) {
                fs.rmSync(path.join("/root/sub-store-data", entry), {
                  recursive: true,
                  force: true,
                });
              }
            } else {
              fs.mkdirSync("/root/sub-store-data", { recursive: true });
            }
            await run("tar", ["xzf", restoreFile, "-C", "/root"]);
            await run("docker", ["start", "sub-store"]);
            fs.unlinkSync(restoreFile);
            await msg.edit({ text: "✅ 已恢复" });
            break;
          }

          default:
            await msg.edit({ text: html(help) });
        }
      } catch (error: unknown) {
        await msg.edit({
          text: `❌ ${getErrorMessage(error) || error}`.slice(0, 3500),
        });
      }
    },
  };
}


  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "sub",
    title: "SubStore",
    description: "SubStore 订阅管理配置",
    category: "插件配置",
    icon: "📦",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "url",
            "label": "面板地址",
            "type": "string"
      },
      {
            "key": "token",
            "label": "Token",
            "type": "password",
            "secret": true
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("sub"), "config.json"), {} as any);
      return db.data as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<any>(path.join(createDirectoryInAssets("sub"), "config.json"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };

export default new SubStorePlugin();

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import { exec } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import crypto from "crypto";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 执行命令
function sh(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { shell: "/bin/bash" }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message);
      else resolve(stdout);
    });
  });
}

// 检查是否在收藏夹
async function isSavedMessages(msg: Api.Message): Promise<boolean> {
  const client = await getGlobalClient();
  const me = await client?.getMe();
  if (!me) return false;

  return (
    msg.peerId &&
    "userId" in msg.peerId &&
    msg.peerId.userId?.toString() === me.id.toString()
  );
}

// 检查Docker完整性
async function checkDockerIntegrity(): Promise<{
  valid: boolean;
  error?: string;
}> {
  try {
    await sh("which docker");
    await sh("systemctl is-active docker");
    await sh("docker info");
    return { valid: true };
  } catch (error: any) {
    if (error.message.includes("Cannot connect to the Docker daemon")) {
      return { valid: false, error: "Docker服务未运行" };
    }
    if (error.message.includes("docker: command not found")) {
      return { valid: false, error: "Docker未安装" };
    }
    return { valid: false, error: "Docker配置异常" };
  }
}

// 获取Sub-Store版本
async function getSubStoreVersion(): Promise<string> {
  try {
    const containerStatus = await sh(
      "docker ps --format '{{.Names}}' | grep sub-store"
    );
    if (!containerStatus.trim()) {
      return "未运行";
    }
    
    let logOutput = await sh(
      "docker logs sub-store 2>&1 | grep 'Sub-Store -- v' | head -1"
    );
    
    // 如果没有找到版本信息，可能是日志不完整，重启容器生成完整日志
    if (!logOutput.trim()) {
      await sh("docker restart sub-store");
      await sh("sleep 5"); // 等待容器启动
      logOutput = await sh(
        "docker logs sub-store 2>&1 | grep 'Sub-Store -- v' | head -1"
      );
    }
    
    const versionMatch = logOutput.match(/Sub-Store -- (v[\d.]+)/);
    return versionMatch ? versionMatch[1] : "未知版本";
  } catch (error: any) {
    return "获取失败";
  }
}

// 获取远程最新版本
async function getRemoteVersion(): Promise<string> {
  try {
    const response = await sh(
      "curl -s https://api.github.com/repos/sub-store-org/Sub-Store/releases/latest"
    );
    const releaseData = JSON.parse(response);
    return releaseData.tag_name || "获取失败";
  } catch (error: any) {
    return "获取失败";
  }
}

// 比较版本号
function compareVersions(local: string, remote: string): {
  hasUpdate: boolean;
  localVersion: string;
  remoteVersion: string;
} {
  if (local === "未运行" || local === "获取失败" || remote === "获取失败") {
    return { hasUpdate: false, localVersion: local, remoteVersion: remote };
  }
  
  const parseVersion = (v: string) => {
    const cleaned = v.replace(/^v/, "");
    return cleaned.split(".").map(num => parseInt(num) || 0);
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

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sub: async (msg) => {
      const parts = msg.text?.split(/\s+/) || [];
      const cmd = (parts[1] || "help").toLowerCase();
      const arg = parts[2];

      // // 检查是否在收藏夹
      // if (!(await isSavedMessages(msg))) {
      //   await msg.edit({ text: "⚠️ 此插件仅限在「收藏夹」中使用" });
      //   return;
      // }
      if ((msg as any).isGroup || (msg as any).isChannel) {
        await msg.edit({
          text: "❌ 为保护用户隐私，禁止在公共对话环境使用",
          parseMode: "html",
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
            await msg.edit({ text: help, parseMode: "html" });
            break;

          case "up":
            // 检查Docker完整性
            await msg.edit({ text: "🔍 检查Docker完整性..." });
            const dockerCheck = await checkDockerIntegrity();
            if (!dockerCheck.valid) {
              await msg.edit({
                text: `❌ Docker检查失败: ${dockerCheck.error}\n\n🔧 请先执行: <code>${mainPrefix}sub fix-docker</code>`,
                parseMode: "html",
              });
              return;
            }

            const secret = crypto.randomBytes(16).toString("hex");

            // 分步骤部署，每步单独执行和检查
            try {
              await msg.edit({ text: "✅ Docker检查通过\n🛠 创建目录..." });
              await sh("mkdir -p /root/sub-store /root/sub-store-data");

              await msg.edit({ text: "✅ 目录创建完成\n🧹 清理旧容器..." });
              await sh("docker rm -f sub-store 2>/dev/null || true");

              await msg.edit({ text: "✅ 旧容器已清理\n📝 生成配置..." });
              await sh(`cd /root/sub-store && echo "${secret}" > .secret`);

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
              await sh("cd /root/sub-store && docker compose pull");

              await msg.edit({ text: "✅ 镜像拉取完成\n🚀 启动容器..." });
              await sh("cd /root/sub-store && docker compose up -d");

              const ip = await sh("curl -s ifconfig.me").catch(() => "未知");
              await msg.edit({
                text: `✅ 部署完成\n\n面板: http://${ip.trim()}:3001\n后端: http://${ip.trim()}:3001/${secret}`,
              });
            } catch (error: any) {
              let errorMsg = `❌ 部署失败: ${error.message}\n\n`;
              if (
                error.message.includes("Cannot connect to the Docker daemon") ||
                error.message.includes("docker.service not found")
              ) {
                errorMsg += `🔧 Docker未正确安装，请执行: <code>${mainPrefix}sub fix-docker</code>\n\n`;
              }
              errorMsg += `💡 其他解决方案:\n1. ${mainPrefix}sub check - 系统检查\n2. ${mainPrefix}sub manual - 查看手动步骤`;
              await msg.edit({ text: errorMsg, parseMode: "html" });
            }
            break;

          case "update":
            await msg.edit({ text: "🔄 更新Sub-Store容器中..." });
            try {
              // 检查Docker完整性
              const dockerCheck = await checkDockerIntegrity();
              if (!dockerCheck.valid) {
                await msg.edit({
                  text: `❌ Docker检查失败: ${dockerCheck.error}`,
                  parseMode: "html",
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
              await sh("docker stop sub-store");

              await msg.edit({ text: "🗑️ 删除容器..." });
              await sh("docker rm sub-store");

              await msg.edit({ text: "📥 拉取最新镜像..." });
              await sh("cd /root/sub-store && docker compose pull sub-store");

              await msg.edit({ text: "🚀 启动新容器..." });
              await sh("cd /root/sub-store && docker compose up -d sub-store");

              await msg.edit({ text: "🧹 清理旧镜像..." });
              await sh("docker image prune -f");

              const ip = await sh("curl -s ifconfig.me").catch(() => "未知");
              const secretFile = "/root/sub-store/.secret";
              const secret = fs.existsSync(secretFile) 
                ? fs.readFileSync(secretFile, "utf8").trim() 
                : "";

              await msg.edit({ text: "🔍 获取版本信息..." });
              const localVersion = await getSubStoreVersion();
              const remoteVersion = await getRemoteVersion();

              await msg.edit({
                text: `✅ 更新完成\n\n📦 本地版本: ${localVersion}\n🌍 远程版本: ${remoteVersion}\n🌐 面板: http://${ip.trim()}:3001\n🔗 后端: http://${ip.trim()}:3001/${secret}`,
              });
            } catch (error: any) {
              await msg.edit({
                text: `❌ 更新失败: ${error.message}`,
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
                await sh("which docker");
                infoResult += "✅ Docker已安装\n";

                try {
                  await sh("systemctl is-active docker");
                  infoResult += "✅ Docker服务运行中\n";

                  try {
                    await sh("docker info");
                    infoResult += "✅ Docker可正常连接\n";
                  } catch (e: any) {
                    infoResult += `❌ Docker连接失败\n`;
                  }
                } catch {
                  infoResult += "❌ Docker服务未启动\n";
                }
              } catch {
                infoResult += "❌ Docker未安装\n";
              }

              // Sub-Store部署状态
              const secretFile = "/root/sub-store/.secret";
              if (fs.existsSync(secretFile)) {
                const key = fs.readFileSync(secretFile, "utf8").trim();
                const containerStatus = await sh(
                  "docker ps --format '{{.Names}} {{.Status}}' | grep sub-store || echo '未运行'"
                );
                const ip = await sh("curl -s --max-time 3 ifconfig.me").catch(
                  () => "未知"
                );
                const localVersion = await getSubStoreVersion();
                const remoteVersion = await getRemoteVersion();
                const versionCompare = compareVersions(localVersion, remoteVersion);

                infoResult += `\n🏠 <b>Sub-Store 状态</b>\n`;
                infoResult += `📦 容器: ${containerStatus.trim()}\n`;
                infoResult += `🏷️ 本地版本: ${localVersion}\n`;
                infoResult += `🌍 远程版本: ${remoteVersion}\n`;
                
                if (versionCompare.hasUpdate) {
                  infoResult += `🔄 <b>有可用更新！</b>\n`;
                  infoResult += `💡 使用 <code>${mainPrefix}sub update</code> 更新到最新版本\n`;
                } else if (localVersion !== "未运行" && remoteVersion !== "获取失败") {
                  infoResult += `✅ 已是最新版本\n`;
                }
                
                infoResult += `🌐 面板: http://${ip.trim()}:3001\n`;
                infoResult += `🔗 后端: http://${ip.trim()}:3001/${key}\n`;
              } else {
                infoResult += `\n❌ Sub-Store 未部署\n`;
              }

              // 网络检查
              try {
                await sh("curl -s --max-time 3 ifconfig.me");
                infoResult += `\n✅ 网络连接正常`;
              } catch {
                infoResult += `\n❌ 网络连接异常`;
              }
            } catch (error: any) {
              infoResult += `❌ 信息获取失败: ${error.message}`;
            }

            await msg.edit({ text: infoResult, parseMode: "html" });
            break;

          case "fix-docker":
            await msg.edit({ text: "🔧 重装Docker中..." });
            try {
              await msg.edit({ text: "🔧 清理旧Docker包..." });
              await sh(
                "apt-get purge -y docker-cli docker-buildx-plugin docker-compose-plugin 2>/dev/null || true"
              );
              await sh("apt-get autoremove -y");

              await msg.edit({ text: "📦 下载Docker安装脚本..." });
              await sh(
                "curl -fsSL https://get.docker.com -o /tmp/get-docker.sh"
              );

              await msg.edit({ text: "⚙️ 安装Docker CE..." });
              await sh("bash /tmp/get-docker.sh");

              await msg.edit({ text: "🚀 启动Docker服务..." });
              await sh("systemctl enable docker");
              await sh("systemctl start docker");
              await sh("sleep 3");

              await msg.edit({ text: "✅ 验证Docker安装..." });
              const version = await sh("docker --version");
              await sh("docker info");

              await msg.edit({
                text: `✅ Docker重装完成\n\n${version.trim()}\n\n现在可以使用 ${mainPrefix}sub up 部署Sub-Store`,
              });
            } catch (error: any) {
              await msg.edit({
                text: `❌ Docker重装失败: ${error.message}\n\n请手动执行:\ncurl -fsSL https://get.docker.com | bash\nsystemctl start docker`,
              });
            }
            break;

          case "manual":
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
      - SUB_STORE_FRONTEND_BACKEND_PATH=/\$SECRET
    ports: ["3001:3001"]
    volumes: ["/root/sub-store-data:/opt/app/data"]
EOF

<code>5. 部署:</code>
cd /root/sub-store
docker compose up -d

<code>6. 查看结果:</code>
IP=$(curl -s ifconfig.me)
echo "面板: http://\$IP:3001"
echo "后端: http://\$IP:3001/\$SECRET"`;

            await msg.edit({ text: manualText, parseMode: "html" });
            break;

          case "info":
            const secretFile = "/root/sub-store/.secret";
            if (!fs.existsSync(secretFile)) {
              await msg.edit({ text: "❌ 未部署" });
              return;
            }
            const key = fs.readFileSync(secretFile, "utf8").trim();
            const ip = await sh("curl -s ifconfig.me");
            await msg.edit({
              text: `面板: http://${ip.trim()}:3001\n后端: http://${ip.trim()}:3001/${key}`,
            });
            break;

          case "status":
            const status = await sh(
              "docker ps --format '{{.Names}} {{.Status}}' | grep sub-store || echo '未运行'"
            );
            await msg.edit({ text: `📊 ${status}` });
            break;

          case "logs":
            await msg.edit({ text: "📋 生成今日日志文件..." });
            try {
              const today = new Date().toISOString().split("T")[0];
              const todayLogs = await sh(
                `docker logs sub-store --since ${today}T00:00:00 2>&1 || echo '今日无日志'`
              );

              const tmpDir = createDirectoryInTemp("logs");
              const logFile = path.join(tmpDir, `sub-store-logs-${today}.txt`);
              const logContent = `Sub-Store 日志 - ${today}\n${"=".repeat(
                50
              )}\n\n${todayLogs}`;

              fs.writeFileSync(logFile, logContent, "utf8");

              const client = await getGlobalClient();
              const me = await client?.getMe();
              if (client && me) {
                const size = fs.statSync(logFile).size;
                await client.sendFile(me.id, {
                  file: new CustomFile(
                    `sub-store-logs-${today}.txt`,
                    size,
                    logFile
                  ),
                  caption: `📋 Sub-Store 今日日志 (${today})`,
                });
                await msg.edit({
                  text: `✅ 今日日志已发送至收藏夹\n文件大小: ${(
                    size / 1024
                  ).toFixed(1)}KB`,
                });
              } else {
                await msg.edit({ text: "❌ 无法发送文件到收藏夹" });
              }
            } catch (error: any) {
              await msg.edit({ text: `❌ 日志导出失败: ${error.message}` });
            }
            break;

          case "clean":
            await msg.edit({ text: "🧹 卸载中..." });
            await sh("docker rm -f sub-store 2>/dev/null || true");
            await sh("rm -rf /root/sub-store /root/sub-store-data");
            await msg.edit({ text: "✅ 已卸载" });
            break;

          case "backup":
            await msg.edit({ text: "📦 备份中..." });
            const tmpDir = createDirectoryInTemp("backup");
            const backupFile = path.join(tmpDir, `backup_${Date.now()}.tgz`);
            await sh(`tar czf ${backupFile} -C /root sub-store-data`);

            const client = await getGlobalClient();
            const me = await client?.getMe();
            if (client && me) {
              const size = fs.statSync(backupFile).size;
              await client.sendFile(me.id, {
                file: new CustomFile(`sub-store-backup.tgz`, size, backupFile),
                caption: "Sub-Store 备份",
              });
            }
            await msg.edit({ text: "✅ 已备份至收藏夹" });
            break;

          case "restore":
            const reply = await msg.getReplyMessage();
            if (!reply || !reply.document) {
              await msg.edit({ text: "❌ 请回复备份文件" });
              return;
            }
            await msg.edit({ text: "♻️ 恢复中..." });
            const buf = await (reply as any).downloadMedia();
            const restoreFile = `/tmp/restore_${Date.now()}.tgz`;
            fs.writeFileSync(restoreFile, Buffer.from(buf));

            await sh("docker stop sub-store 2>/dev/null || true");
            await sh("rm -rf /root/sub-store-data/*");
            await sh(`tar xzf ${restoreFile} -C /root`);
            await sh("docker start sub-store");
            fs.unlinkSync(restoreFile);
            await msg.edit({ text: "✅ 已恢复" });
            break;

          default:
            await msg.edit({ text: help, parseMode: "html" });
        }
      } catch (error: any) {
        await msg.edit({ text: `❌ ${error.message || error}`.slice(0, 3500) });
      }
    },
  };
}

export default new SubStorePlugin();

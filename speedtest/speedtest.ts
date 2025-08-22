import { Plugin } from "@utils/pluginBase";
import { exec } from "child_process";
import util from "util";
import fs from "fs";
import path from "path";
import os from "os";
import download from "download";
import { Api } from "telegram";

const execPromise = util.promisify(exec);

// --- 配置路径 ---
const SPEEDTEST_TEMP_PATH = path.join(process.cwd(), "temp", "speedtest");
const BIN_DIR = path.join(process.cwd(), "assets", "speedtest");
const OOKLA_CLI_PATH = path.join(BIN_DIR, "speedtest");
// --- 配置路径结束 ---

async function ensureOoklaCliExists(msg: any): Promise<void> {
  if (fs.existsSync(OOKLA_CLI_PATH)) {
    return;
  }
  await msg.edit({ text: "首次运行，正在为您自动安装 Speedtest CLI..." });
  const arch = os.arch();
  const archMap: { [key: string]: string } = {
    x64: "x86_64",
    arm64: "aarch64",
  };
  const ooklaArch = archMap[arch];
  if (!ooklaArch) {
    throw new Error(`不支持的服务器CPU架构: ${arch}。`);
  }
  await msg.edit({ text: `检测到架构: ${ooklaArch}。正在下载...` });
  const url = `https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-${ooklaArch}.tgz`;
  await download(url, BIN_DIR, {
    extract: true,
    strip: 1, // 解压后只保留根目录
  });
  await msg.edit({ text: "配置中..." });
  fs.chmodSync(OOKLA_CLI_PATH, 0o755);
  await msg.edit({ text: "安装成功！" });
}

async function sendResultAsImageWithCaption(msg: Api.Message, result: any) {
  const resultUrl = result.result.url;
  await msg.edit({ text: "■■■■ 测速完成！正在抓取分享图片..." });

  // 1. 获取图片 URL
  const imageUrl = resultUrl + ".png";
  // 2. 准备图片保存路径
  const imagePath = path.join(
    SPEEDTEST_TEMP_PATH,
    `speedtest_result_${Date.now()}.png`
  );
  // 3. 下载图片
  await download(imageUrl, SPEEDTEST_TEMP_PATH, {
    filename: path.basename(imagePath),
  });
  // 4. 准备要发送的文字说明 (作为图片的标题)
  const downloadMbps = ((result.download.bandwidth * 8) / 1e6).toFixed(2);
  const uploadMbps = ((result.upload.bandwidth * 8) / 1e6).toFixed(2);
  const ping = result.ping.latency.toFixed(2);
  const serverName = result.server.name;
  const location = result.server.location;
  const time =
    result.timestamp.split("T")[0] +
    " " +
    result.timestamp.split("T")[1].split(".")[0];

  const captionText = `
🚀 **Speedtest 测速报告**

**服务器:** ${serverName} (${location})
**Ping:** ${ping} ms
**下载:** ${downloadMbps} Mbps
**上传:** ${uploadMbps} Mbps
**测试时间:** ${time}
    `;

  // 5. 将图片和文字一同发送
  await msg.client?.sendFile(msg.peerId, {
    file: imagePath,
    caption: captionText,
    replyTo: msg,
  });

  // 6. 清理工作
  await msg.delete();
  fs.unlinkSync(imagePath);
}

const speedtestPlugin: Plugin = {
  command: "speedtest",
  description: "运行 Speedtest by Ookla 并以图片形式发送结果。",
  cmdHandler: async (msg) => {
    await msg.edit({ text: "初始化测速环境..." });

    try {
      await ensureOoklaCliExists(msg);
      await msg.edit({ text: "■□□□ 正在执行网络速度测试..." });

      const command = `${OOKLA_CLI_PATH} --format json --accept-license --accept-gdpr`;
      const { stdout } = await execPromise(command);

      const lines = stdout.trim().split("\n");
      const resultLine = lines.find((line) => {
        try {
          return JSON.parse(line).type === "result";
        } catch {
          return false;
        }
      });

      if (!resultLine) {
        throw new Error("无法从 Speedtest CLI 输出中找到最终测试结果。");
      }
      const result = JSON.parse(resultLine);

      console.log("Speedtest Result:", result);

      await sendResultAsImageWithCaption(msg, result);
    } catch (error: any) {
      let errorMessage = `❌ **测速失败。**`;
      if (error.message) {
        errorMessage += `\n**详情:** \`${error.message}\``;
      }
      console.error(error);
      await msg.edit({ text: errorMessage, linkPreview: false });
    }
  },
};

export default speedtestPlugin;

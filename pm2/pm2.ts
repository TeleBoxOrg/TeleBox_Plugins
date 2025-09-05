import { Api, TelegramClient } from "telegram";
import { Plugin } from "@utils/pluginBase";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const pm2HelpMsg = `🔧 <b>PM2 进程管理插件</b>

📋 <b>可用命令:</b>
• <code>pm2r</code> - 🔄 重启所有应用 (pm2 restart all)
• <code>pm2s</code> - ⏸️ 停止所有应用 (pm2 stop all)
• <code>pm2 help</code> - 📖 显示此帮助信息

⚡ <b>特性:</b>
• 静默执行 - 无任何提示或反馈
• 自动删除触发消息
• 适用于快速重启/停止操作

⚠️ <b>注意事项:</b>
• 使用 <code>pm2s</code> 停止后需手动重启 telebox
• 命令执行后不会有任何反馈消息
• 仅在 Linux 环境下有效`;

const fn = async (msg: Api.Message) => {
  try {
    const args = msg.message.slice(1).split(" ");
    const command = args[0];

    // Show help
    if (
      command === "pm2" &&
      (args.length === 1 || args[1] === "help" || args[1] === "h")
    ) {
      await msg.edit({
        text: pm2HelpMsg,
        parseMode: "html",
        linkPreview: false,
      });
      return;
    }

    // Delete trigger message for execution commands
    await msg.delete();

    if (command === "pm2r") {
      await execAsync("pm2 restart all");
    } else if (command === "pm2s") {
      await execAsync("pm2 stop all");
    }

    // Silent execution - no feedback messages
  } catch (error: any) {
    console.error("PM2 command error:", error);
    // Silent execution - no error messages
  }
};

class Pm2Plugin extends Plugin {
  description: string = `
PM2进程管理插件：
- pm2r - 重启所有应用
- pm2s - 停止所有应用
- pm2 help - 显示帮助信息
  `;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    pm2: fn,
    pm2r: fn,
    pm2s: fn,
  };
}

export default new Pm2Plugin();

import { Api } from "telegram";
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { exec } from "child_process";
import util from "util";
import os from "os";

// HTML转义工具（每个插件必须实现）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

const execPromise = util.promisify(exec);

// Telegram数据中心配置
const DCs: Record<number, string> = {
  1: "149.154.175.50",  // DC1 - 美国迈阿密
  2: "149.154.167.51",  // DC2 - 荷兰阿姆斯特丹
  3: "149.154.175.100", // DC3 - 美国迈阿密
  4: "149.154.167.91",  // DC4 - 荷兰阿姆斯特丹
  5: "91.108.56.130",   // DC5 - 新加坡
};

const DC_DESCRIPTIONS: Record<number, string> = {
  1: "DC1(美国-迈阿密)",
  2: "DC2(荷兰-阿姆斯特丹)",
  3: "DC3(美国-迈阿密)",
  4: "DC4(荷兰-阿姆斯特丹)",
  5: "DC5(新加坡)",
};

class PingDCService {
  private async pingHost(host: string): Promise<number> {
    const platform = os.platform();
    let command: string;
    let parseRegex: RegExp;

    if (platform === "win32") {
      command = `ping -n 1 ${host}`;
      parseRegex = /= (.*?)ms/;
    } else {
      command = `ping -c 1 ${host}`;
      parseRegex = /time=([0-9.]+)/;
    }

    try {
      const { stdout } = await execPromise(command);
      const match = stdout.match(parseRegex);
      if (match && match[1]) {
        return parseFloat(match[1]);
      }
      return 0;
    } catch (error) {
      return 0;
    }
  }

  public async testAllDataCenters(): Promise<string> {
    // 并发执行所有ping测试
    const pingPromises = [];
    for (let dc = 1; dc <= 5; dc++) {
      const host = DCs[dc];
      pingPromises.push(this.pingHost(host));
    }
    
    const latencies = await Promise.all(pingPromises);
    
    let message = "Telegram数据中心延迟测试结果\n\n";
    
    for (let dc = 1; dc <= 5; dc++) {
      const description = DC_DESCRIPTIONS[dc];
      const latency = latencies[dc - 1];
      
      const latencyText = latency > 0 ? `${latency.toFixed(1)}ms` : "超时";
      message += `${description}: \`${latencyText}\`\n`;
    }

    return message;
  }
}

const pingdc = async (msg: Api.Message) => {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ text: "❌ 无法获取客户端实例" });
    return;
  }

  const service = new PingDCService();
  
  try {
    await msg.edit({ text: "正在测试Telegram数据中心延迟..." });
    
    const result = await service.testAllDataCenters();
    await msg.edit({ text: result });
  } catch (error: any) {
    await msg.edit({ text: `❌ 测试失败: ${error.message}` });
  }
};

class PingDCPlugin extends Plugin {
  description: string = `Telegram数据中心延迟测试插件

测试所有Telegram数据中心的网络延迟。

使用方法: .pingdc`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    pingdc,
  };
}

export default new PingDCPlugin();

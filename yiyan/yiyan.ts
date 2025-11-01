import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import axios from "axios";

// 类型定义
interface HitokotoResponse {
  hitokoto: string;
  from?: string;
  from_who?: string;
  type: string;
}

// 一言类型映射
const hitokotoTypeMap: Record<string, string> = {
  "a": "动画",
  "b": "漫画", 
  "c": "游戏",
  "d": "文学",
  "e": "原创",
  "f": "网络",
  "g": "其他",
  "h": "影视",
  "i": "诗词",
  "j": "网易云",
  "k": "哲学",
  "l": "抖机灵"
};

class YiyanPlugin extends Plugin {
  // 插件描述
  description = "📝 获取随机一言\n\n使用命令：.yiyan";
  
  // 命令处理器
  cmdHandlers = {
    yiyan: this.getHitokoto.bind(this)
  };

  /**
   * 获取一言
   */
  private async getHitokoto(msg: Api.Message): Promise<void> {
    try {
      // 发送等待消息
      const processingMsg = await msg.edit({
        text: "🔄 正在获取一言...",
        parseMode: "html"
      });

      let hitokotoData: HitokotoResponse | null = null;
      let retryCount = 0;
      const maxRetries = 10;

      // 重试机制
      while (retryCount < maxRetries && !hitokotoData) {
        try {
          const response = await axios.get<HitokotoResponse>(
            "https://v1.hitokoto.cn/?charset=utf-8",
            { timeout: 10000 }
          );
          hitokotoData = response.data;
          break;
        } catch (error) {
          retryCount++;
          if (retryCount >= maxRetries) {
            throw new Error("获取一言失败，请稍后重试");
          }
          // 等待一段时间后重试
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      if (!hitokotoData) {
        throw new Error("无法获取一言数据");
      }

      // 构建来源信息
      let sourceInfo = "";
      if (hitokotoData.from) {
        sourceInfo += `《${hitokotoData.from}》`;
      }
      if (hitokotoData.type && hitokotoTypeMap[hitokotoData.type]) {
        sourceInfo += `（${hitokotoTypeMap[hitokotoData.type]}）`;
      }
      if (hitokotoData.from_who) {
        sourceInfo += ` - ${hitokotoData.from_who}`;
      }

      // 构建最终消息
      const finalText = sourceInfo 
        ? `💬 ${hitokotoData.hitokoto}\n\n📚 ${sourceInfo}`
        : `💬 ${hitokotoData.hitokoto}`;

      // 编辑消息显示结果
      await processingMsg.edit({
        text: finalText,
        parseMode: "html"
      });

    } catch (error: any) {
      // 错误处理
      const errorMsg = error.message || "未知错误";
      await msg.edit({
        text: `❌ <b>获取一言失败：</b>${errorMsg}`,
        parseMode: "html"
      });
    }
  }
}

export default new YiyanPlugin();

import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import * as fs from "fs/promises";
import axios from "axios";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { createDirectoryInAssets } from "@utils/pathHelpers";

const execPromise = promisify(exec);

// 文件名常量
const DATA_FILE_NAME = "tts_data.json";

// 类型定义：单个用户的配置
interface UserConfig {
  apiKey: string;
  defaultRole: string;
  defaultRoleId: string;
}

// 类型定义：所有用户数据的顶层结构
interface AllUserData {
  users: Record<string, UserConfig>;
  roles: Record<string, string>; // 存储语音角色 ID
}

// 数据文件路径
const dataFilePath = path.join(createDirectoryInAssets("tts-plugin"), DATA_FILE_NAME);

// 从文件加载数据
async function loadUserData(): Promise<AllUserData> {
  try {
    const data = await fs.readFile(dataFilePath, 'utf8');
    const parsedData = JSON.parse(data);
    // 确保 'roles' 字段存在，如果不存在则使用默认值
    if (!parsedData.roles) {
      parsedData.roles = getInitialRoles();
    }
    return parsedData as AllUserData;
  } catch (error) {
    // 如果文件不存在或解析失败，初始化一个完整的数据结构并写入文件
    const initialData: AllUserData = {
      users: {},
      roles: getInitialRoles(),
    };
    await saveUserData(initialData);
    return initialData;
  }
}

// 将数据保存到文件
async function saveUserData(userData: AllUserData): Promise<void> {
  try {
    await fs.writeFile(dataFilePath, JSON.stringify(userData, null, 2), 'utf8');
  } catch (error) {
    console.error("保存用户数据失败:", error);
  }
}

// 获取初始化的角色列表
function getInitialRoles(): Record<string, string> {
  return {
    "薯薯": "cc1c9874effe4526883662166456513c",
    "宣传片": "dd43b30d04d9446a94ebe41f301229b5",
    "影视飓风": "91648d8a8d9841c5a1c54fb18e54ab04",
    "丁真": "54a5170264694bfc8e9ad98df7bd89c3",
    "雷军": "aebaa2305aa2452fbdc8f41eec852a79",
    "蔡徐坤": "e4642e5edccd4d9ab61a69e82d4f8a14",
    "邓紫棋": "3b55b3d84d2f453a98d8ca9bb24182d6",
    "周杰伦": "1512d05841734931bf905d0520c272b1",
    "周星驰": "faa3273e5013411199abc13d8f3d6445",
    "孙笑川": "e80ea225770f42f79d50aa98be3cedfc",
    "张顺飞": "c88b80d38d0f4ed0aed1a92a5c19f00f",
    "阿诺": "daeda14f742f47b8ac243ccf21c62df8",
    "卢本伟": "24d524b57c5948f598e9b74c4dacc7ab",
    "电棍": "25d496c425d14109ba4958b6e47ea037",
    "炫狗": "b48533d37bed4ef4b9ad5b11d8b0b694",
    "阿梓": "c2a6125240f343498e26a9cf38db87b7",
    "七海": "a7725771e0974eb5a9b044ba357f6e13",
    "嘉然": "1d11381f42b54487b895486f69fb14fb",
    "东雪莲": "7af4d620be1c4c6686132f21940d51c5",
    "永雏塔菲": "e1cfccf59a1c4492b5f51c7c62a8abd2",
    "可莉": "626bb6d3f3364c9cbc3aa6a67300a664",
    "刻晴": "5611bf78886a4a9998f56538c4ec7d8c",
    "烧姐姐": "60d377ebaae44829ad4425033b94fdea",
    "AD学姐": "7f92f8afb8ec43bf81429cc1c9199cb1",
    "御姐": "f44181a3d6d444beae284ad585a1af37",
    "台湾女": "e855dc04a51f48549b484e41c4d4d4cc",
    "御女茉莉": "6ce7ea8ada884bf3889fa7c7fb206691",
    "真实女声": "c189c7cff21c400ba67592406202a3a0",
    "女大学生": "5c353fdb312f4888836a9a5680099ef0",
    "温情女学生": "a1417155aa234890aab4a18686d12849",
    "蒋介石": "918a8277663d476b95e2c4867da0f6a6",
    "李云龙": "2e576989a8f94e888bf218de90f8c19a",
    "姜文": "ee58439a2e354525bd8fa79380418f4d",
    "黑手": "f7561ff309bd4040a59f1e600f4f4338",
    "马保国": "794ed17659b243f69cfe6838b03fd31a",
    "罗永浩": "9cc8e9b9d9ed471a82144300b608bf7f",
    "祁同伟": "4729cb883a58431996b998f2fca7f38b",
    "郭继承": "ecf03a0cf954498ca0005c472ce7b141",
    "麦克阿瑟": "405736979e244634914add64e37290b0",
    "营销号": "9d2a825024ce4156a16ba3ff799c4554",
    "蜡笔小新": "60b9a847ba6e485fa8abbde1b9470bc4",
    "奶龙": "3d1cb00d75184099992ddbaf0fdd7387",
    "懒羊羊": "131c6b3a889543139680d8b3aa26b98d",
    "剑魔": "ffb55be33cbb4af19b07e9a0ef64dab1",
    "小明剑魔": "a9372068ed0740b48326cf9a74d7496a",
    "唐僧": "0fb04af381e845e49450762bc941508c",
    "孙悟空": "8d96d5525334476aa67677fb43059dc5"
  };
}


async function generateSpeech(text: string, referenceId: string, apiKey: string): Promise<string | null> {
  const api_url = 'https://api.fish.audio/v1/tts';
  const mp3File = 'output_audio.mp3';
  const oggFile = 'output.ogg';

  try {
    const response = await axios.post(api_url, {
      text,
      reference_id: referenceId,
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
    });

    await fs.writeFile(mp3File, response.data);

    try {
      await execPromise(`ffmpeg -y -i ${mp3File} -c:a libopus -b:a 64k -vbr on ${oggFile}`);
    } catch (error: any) {
      console.error(`FFmpeg 命令执行失败: ${error.message}`);
      return null;
    }

    return oggFile;
  } catch (error) {
    console.error("生成语音时发生错误:", error);
    // 清理可能生成的临时文件
    await fs.unlink(mp3File).catch(() => {});
    await fs.unlink(oggFile).catch(() => {});
    return null;
  }
}

async function isFfmpegInstalled(): Promise<boolean> {
  try {
    const { stdout } = await execPromise('ffmpeg -version');
    return stdout.includes('ffmpeg version');
  } catch (error) {
    return false;
  }
}

async function installFfmpeg(): Promise<string> {
  if (process.platform === 'linux') {
    if (await isFfmpegInstalled()) {
      return "ffmpeg 已安装。";
    }
    try {
      await execPromise("sudo apt-get update && sudo apt-get install -y ffmpeg");
      return "ffmpeg 已成功安装！";
    } catch (error: any) {
      return `ffmpeg 安装失败，请检查错误信息：\n${error.message}`;
    }
  }
  return "无法自动安装 ffmpeg，请手动安装。";
}

// HTML转义工具
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#x27;'
  }[m] || m));

// --- 命令处理函数 ---

async function tts(msg: Api.Message): Promise<void> {
  const userId = msg.senderId?.toString();
  if (!userId) {
    await msg.edit({ text: "❌ <b>无法获取用户ID。</b>", parseMode: "html" });
    return;
  }

  const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
  const parts = lines?.[0]?.split(/\s+/) || [];
  const [, ...args] = parts;
  const text = args.join(" ").trim();

  try {
    const userData = await loadUserData();
    const userConfig = userData.users[userId];

    if (!userConfig || !userConfig.apiKey) {
      await msg.edit({
        text: "❌ <b>请先设置您的 API Key，使用指令 <code>.tk 您的APIKey</code>。</b>",
        parseMode: "html"
      });
      return;
    }

    if (!text) {
      await msg.edit({
        text: "❌ <b>请提供要转换的文本。</b>\n\n<b>用法：</b><code>.t 文本内容</code>",
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: "🔄 正在生成语音..." });

    const resultFile = await generateSpeech(text, userConfig.defaultRoleId, userConfig.apiKey);

    if (resultFile) {
      await msg.client?.sendFile(msg.peerId, {
        file: resultFile,
        replyTo: msg.replyTo?.replyToMsgId,
      });
      await msg.delete();
      // 删除所有缓存文件
      await fs.unlink(resultFile).catch(() => {}); // 删除 ogg 文件
      await fs.unlink('output_audio.mp3').catch(() => {}); // 删除 mp3 文件
    } else {
      await msg.edit({
        text: "❌ <b>生成语音失败，请检查 API Key 和网络连接。</b>",
        parseMode: "html"
      });
    }
  } catch (error: any) {
    console.error("[TTSPlugin] 语音生成失败:", error);
    await msg.edit({
      text: `❌ <b>出错了:</b> ${htmlEscape(error.message)}`,
      parseMode: "html"
    });
  }
}

async function ttsSet(msg: Api.Message): Promise<void> {
  const userId = msg.senderId?.toString();
  if (!userId) {
    await msg.edit({ text: "❌ <b>无法获取用户ID。</b>", parseMode: "html" });
    return;
  }

  const [, roleName] = msg.text?.split(/\s+/) || [];

  try {
    const userData = await loadUserData();

    if (roleName && userData.roles[roleName]) {
      if (!userData.users[userId]) {
        // 如果用户不存在，初始化一个默认配置
        userData.users[userId] = {
          apiKey: '',
          defaultRole: '雷军',
          defaultRoleId: userData.roles['雷军']
        };
      }
      
      // 更新用户的默认角色
      userData.users[userId].defaultRole = roleName;
      userData.users[userId].defaultRoleId = userData.roles[roleName];
      await saveUserData(userData);
      
      await msg.edit({
        text: `✅ 默认语音角色已设置为：<b>${htmlEscape(roleName)}</b>`,
        parseMode: "html"
      });
      await new Promise(resolve => setTimeout(resolve, 2000));
      await msg.delete();
    } else {
      const roleList = Object.keys(userData.roles).map(role => `<code>${role}</code>`).join("\n");
      await msg.edit({
        text: `❌ <b>无效的角色名。</b>\n\n<b>请选择以下角色之一：</b>\n${roleList}`,
        parseMode: "html"
      });
    }
  } catch (error: any) {
    console.error("[TTSPlugin] 设置角色失败:", error);
    await msg.edit({
      text: `❌ <b>设置失败:</b> ${htmlEscape(error.message)}`,
      parseMode: "html"
    });
  }
}

async function setApiKey(msg: Api.Message): Promise<void> {
  const userId = msg.senderId?.toString();
  if (!userId) {
    await msg.edit({ text: "❌ <b>无法获取用户ID。</b>", parseMode: "html" });
    return;
  }

  const [, apiKey] = msg.text?.split(/\s+/) || [];

  try {
    if (!apiKey) {
      await msg.edit({
        text: `❌ <b>请提供您的 API Key，格式：</b><code>.tk 您的APIKey</code>`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({ text: "🔍 正在检查 FFmpeg 安装状态..." });
    if (!(await isFfmpegInstalled())) {
      await msg.edit({ text: "🛠️ 检测到 FFmpeg 未安装，正在尝试安装..." });
      const installResult = await installFfmpeg();
      await msg.edit({ text: `<b>安装结果:</b> ${htmlEscape(installResult)}`, parseMode: "html" });
      if (installResult.includes("失败")) {
        return;
      }
    }

    const userData = await loadUserData();
    if (!userData.users[userId]) {
      // 如果用户不存在，初始化一个默认配置
      userData.users[userId] = {
        apiKey: '',
        defaultRole: '雷军',
        defaultRoleId: userData.roles['雷军']
      };
    }
    
    userData.users[userId].apiKey = apiKey;
    await saveUserData(userData);

    await msg.edit({
      text: "✅ 您的 API Key 已成功设置！",
      parseMode: "html"
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    await msg.delete();
  } catch (error: any) {
    console.error("[TTSPlugin] 设置API Key失败:", error);
    await msg.edit({
      text: `❌ <b>设置失败:</b> ${htmlEscape(error.message)}`,
      parseMode: "html"
    });
  }
}

// --- 插件类定义 ---

class TTSPlugin extends Plugin {
  description: string = `
🚀 <b>文字转语音插件</b>
<b>使用方法:</b>
• <code>.t &lt;文本&gt;</code> - 将文本转换为语音
• <code>.tk &lt;APIKey&gt;</code> - 设置你的 API Key
• <code>.ts &lt;角色名&gt;</code> - 设置默认语音角色

<b>示例:</b>
• <code>.t 大家好，我是雷军</code>
• <code>.tk my-private-api-key</code>
• <code>.ts 影视飓风</code>
  `;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    t: tts,
    ts: ttsSet,
    tk: setApiKey,
  };
}

export default new TTSPlugin();

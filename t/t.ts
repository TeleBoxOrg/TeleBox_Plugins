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

// 类型定义
interface UserConfig {
  apiKey: string;
  defaultRole: string;
  defaultRoleId: string;
}

interface AllUserData {
  users: Record<string, UserConfig>;
  roles: Record<string, string>;
}

const dataFilePath = path.join(createDirectoryInAssets("tts-plugin"), DATA_FILE_NAME);
const cacheDir = createDirectoryInAssets("tts-plugin/cache");

async function loadUserData(): Promise<AllUserData> {
  try {
    const data = await fs.readFile(dataFilePath, 'utf8');
    const parsedData = JSON.parse(data);
    if (!parsedData.roles) {
      parsedData.roles = getInitialRoles();
    }
    return parsedData as AllUserData;
  } catch (error) {
    const initialData: AllUserData = {
      users: {},
      roles: getInitialRoles(),
    };
    await saveUserData(initialData);
    return initialData;
  }
}

async function saveUserData(userData: AllUserData): Promise<void> {
  try {
    await fs.writeFile(dataFilePath, JSON.stringify(userData, null, 2), 'utf8');
  } catch (error) {
    console.error("保存用户数据失败:", error);
  }
}

function getInitialRoles(): Record<string, string> {
    return {
        "薯薯": "cc1c9874effe4526883662166456513c", "宣传片": "dd43b30d04d9446a94ebe41f301229b5",
        "影视飓风": "91648d8a8d9841c5a1c54fb18e54ab04", "丁真": "54a5170264694bfc8e9ad98df7bd89c3",
        "雷军": "aebaa2305aa2452fbdc8f41eec852a79", "蔡徐坤": "e4642e5edccd4d9ab61a69e82d4f8a14",
        "邓紫棋": "3b55b3d84d2f453a98d8ca9bb24182d6", "周杰伦": "1512d05841734931bf905d0520c272b1",
        "周星驰": "faa3273e5013411199abc13d8f3d6445", "孙笑川": "e80ea225770f42f79d50aa98be3cedfc",
        "张顺飞": "c88b80d38d0f4ed0aed1a92a5c19f00f", "阿诺": "daeda14f742f47b8ac243ccf21c62df8",
        "卢本伟": "24d524b57c5948f598e9b74c4dacc7ab", "电棍": "25d496c425d14109ba4958b6e47ea037",
        "炫狗": "b48533d37bed4ef4b9ad5b11d8b0b694", "阿梓": "c2a6125240f343498e26a9cf38db87b7",
        "七海": "a7725771e0974eb5a9b044ba357f6e13", "嘉然": "1d11381f42b54487b895486f69fb14fb",
        "东雪莲": "7af4d620be1c4c6686132f21940d51c5", "永雏塔菲": "e1cfccf59a1c4492b5f51c7c62a8abd2",
        "可莉": "626bb6d3f3364c9cbc3aa6a67300a664", "刻晴": "5611bf78886a4a9998f56538c4ec7d8c",
        "烧姐姐": "60d377ebaae44829ad4425033b94fdea", "AD学姐": "7f92f8afb8ec43bf81429cc1c9199cb1",
        "御姐": "f44181a3d6d444beae284ad585a1af37", "台湾女": "e855dc04a51f48549b484e41c4d4d4cc",
        "御女茉莉": "6ce7ea8ada884bf3889fa7c7fb206691", "真实女声": "c189c7cff21c400ba67592406202a3a0",
        "女大学生": "5c353fdb312f4888836a9a5680099ef0", "温情女学生": "a1417155aa234890aab4a18686d12849",
        "蒋介石": "918a8277663d476b95e2c4867da0f6a6", "李云龙": "2e576989a8f94e888bf218de90f8c19a",
        "姜文": "ee58439a2e354525bd8fa79380418f4d", "黑手": "f7561ff309bd4040a59f1e600f4f4338",
        "马保国": "794ed17659b243f69cfe6838b03fd31a", "罗永浩": "9cc8e9b9d9ed471a82144300b608bf7f",
        "祁同伟": "4729cb883a58431996b998f2fca7f38b", "郭继承": "ecf03a0cf954498ca0005c472ce7b141",
        "麦克阿瑟": "405736979e244634914add64e37290b0", "营销号": "9d2a825024ce4156a16ba3ff799c4554",
        "蜡笔小新": "60b9a847ba6e485fa8abbde1b9470bc4", "奶龙": "3d1cb00d75184099992ddbaf0fdd7387",
        "懒羊羊": "131c6b3a889543139680d8b3aa26b98d", "剑魔": "ffb55be33cbb4af19b07e9a0ef64dab1",
        "小明剑魔": "a9372068ed0740b48326cf9a74d7496a", "唐僧": "0fb04af381e845e49450762bc941508c",
        "孙悟空": "8d96d5525334476aa67677fb43059dc5"
    };
}

function cleanTextForTTS(text: string): string {
    if (!text) return "";
    let cleanedText = text;
    const broadSymbolRegex = new RegExp(
        "[" +
        "\u{1F600}-\u{1F64F}" + 
        "\u{1F300}-\u{1F5FF}" + 
        "\u{1F680}-\u{1F6FF}" + 
        "\u{1F700}-\u{1F77F}" + 
        "\u{1F780}-\u{1F7FF}" + 
        "\u{1F800}-\u{1F8FF}" + 
        "\u{1F900}-\u{1F9FF}" + 
        "\u{1FA00}-\u{1FAFF}" + 
        "\u{2600}-\u{26FF}" +   
        "\u{2700}-\u{27BF}" +   
        "\u{2B50}" +           
        "\u{FE0F}" +           
        "\u{200D}" +           
        "]",
        "gu"
    );
    cleanedText = cleanedText.replace(broadSymbolRegex, '');
    const whitelistRegex = /[^\u4e00-\u9fa5a-zA-Z0-9\s，。？！、,?!.]/g;
    cleanedText = cleanedText.replace(whitelistRegex, '');
    cleanedText = cleanedText.replace(/([，。？！、,?!.])\1+/g, '$1');
    return cleanedText.trim();
}

async function generateSpeech(text: string, referenceId: string, apiKey: string): Promise<{ oggFile: string; mp3File: string } | null> {
  const api_url = 'https://api.fish.audio/v1/tts';
  // 仅用于当前请求的临时文件，不做持久缓存
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mp3File = path.join(cacheDir, `tts-${unique}.mp3`);
  const oggFile = path.join(cacheDir, `tts-${unique}.ogg`);

  try {
    const response = await axios.post(api_url, { text, reference_id: referenceId }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
    });
    await fs.writeFile(mp3File, response.data);

    // 使用 ffmpeg 将 mp3 转 opus 语音（ogg）
    const quotedIn = mp3File.replace(/"/g, '\\"');
    const quotedOut = oggFile.replace(/"/g, '\\"');
    await execPromise(`ffmpeg -y -i "${quotedIn}" -c:a libopus -b:a 64k -vbr on "${quotedOut}"`);

    return { oggFile, mp3File };
  } catch (error: any) {
    // 清理可能已产生的临时文件
    try { await fs.unlink(oggFile); } catch {}
    try { await fs.unlink(mp3File); } catch {}
    console.error(`语音生成或转换失败: ${error.message}`);
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
    if (await isFfmpegInstalled()) return "ffmpeg 已安装。";
    try {
      await execPromise("sudo apt-get update && sudo apt-get install -y ffmpeg");
      return "ffmpeg 已成功安装！";
    } catch (error: any) {
      return `ffmpeg 安装失败，请检查错误信息：\n${error.message}`;
    }
  }
  return "无法自动安装 ffmpeg，请手动安装。";
}

const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[m] || m));

async function tts(msg: Api.Message): Promise<void> {
  const userId = msg.senderId?.toString();
  if (!userId) {
    await msg.edit({ text: "❌ <b>无法获取用户ID。</b>", parseMode: "html" });
    return;
  }

  const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
  const parts = lines?.[0]?.split(/\s+/) || [];
  const [, ...args] = parts;
  let text = args.join(" ").trim();

  if (!text && msg.replyTo?.replyToMsgId) {
    try {
      const repliedMsg = await msg.getReplyMessage();
      if (repliedMsg && repliedMsg.text) text = repliedMsg.text;
    } catch (error) {
      console.error("获取被回复的消息失败:", error);
    }
  }

  try {
    const userData = await loadUserData();
    const userConfig = userData.users[userId];

    if (!userConfig || !userConfig.apiKey) {
      await msg.edit({ text: "❌ <b>请先设置您的 API Key，使用指令 <code>.tk 您的APIKey</code>。</b>", parseMode: "html" });
      return;
    }

    if (!text) {
      await msg.edit({ text: "❌ <b>请提供要转换的文本，或使用 <code>.t</code> 回复一条消息。</b>\n\n<b>用法：</b><code>.t 文本内容</code>", parseMode: "html" });
      return;
    }

    const cleanedText = cleanTextForTTS(text);

    if (!cleanedText.trim()) {
      await msg.edit({ text: "❌ <b>文本在过滤掉所有符号后为空，无法生成语音。</b>", parseMode: "html" });
      return;
    }

    await msg.edit({ text: "🔄 正在生成语音..." });
    const resultFile = await generateSpeech(cleanedText, userConfig.defaultRoleId, userConfig.apiKey);

    if (resultFile) {
      await msg.client?.sendFile(msg.peerId, {
        file: resultFile.oggFile,
        replyTo: msg.id,
        attributes: [new (Api as any).DocumentAttributeAudio({ duration: 0, voice: true })],
      });
      // 发送完成后清理缓存文件（按用户要求）
      try {
        // 优先删除已发送的 ogg，再尝试删除 mp3
        try { await fs.unlink(resultFile.oggFile); } catch {}
        try { await fs.unlink(resultFile.mp3File); } catch {}
      } catch (e) {
        console.warn('[TTSPlugin] 缓存清理失败:', e);
      }
      await msg.delete();
    } else {
      await msg.edit({ text: "❌ <b>生成语音失败，可能是API Key有误、余额不足或网络问题。</b>", parseMode: "html" });
    }
  } catch (error: any) {
    console.error("[TTSPlugin] 语音生成失败:", error);
    await msg.edit({ text: `❌ <b>出错了:</b> ${htmlEscape(error.message)}`, parseMode: "html" });
  }
}

async function ttsSet(msg: Api.Message): Promise<void> {
    const userId = msg.senderId?.toString();
    if (!userId) { await msg.edit({ text: "❌ <b>无法获取用户ID。</b>", parseMode: "html" }); return; }

    const [, roleName] = msg.text?.split(/\s+/).filter(Boolean) || [];

    try {
        const userData = await loadUserData();
        if (roleName && userData.roles[roleName]) {
            if (!userData.users[userId]) {
                userData.users[userId] = { apiKey: '', defaultRole: '雷军', defaultRoleId: userData.roles['雷军'] };
            }
            userData.users[userId].defaultRole = roleName;
            userData.users[userId].defaultRoleId = userData.roles[roleName];
            await saveUserData(userData);
            await msg.edit({ text: `✅ 默认语音角色已设置为：<b>${htmlEscape(roleName)}</b>`, parseMode: "html" });
            await new Promise(resolve => setTimeout(resolve, 2000));
            await msg.delete();
        } else {
            const roleList = Object.keys(userData.roles).map(role => `<code>${htmlEscape(role)}</code>`).join("\n");
            await msg.edit({ text: `❌ <b>无效的角色名。</b>\n\n<b>请选择以下角色之一：</b>\n${roleList}`, parseMode: "html" });
        }
    } catch (error: any) {
        console.error("[TTSPlugin] 设置角色失败:", error);
        await msg.edit({ text: `❌ <b>设置失败:</b> ${htmlEscape(error.message)}`, parseMode: "html" });
    }
}

async function setApiKey(msg: Api.Message): Promise<void> {
    const userId = msg.senderId?.toString();
    if (!userId) { await msg.edit({ text: "❌ <b>无法获取用户ID。</b>", parseMode: "html" }); return; }

    const [, apiKey] = msg.text?.split(/\s+/).filter(Boolean) || [];

    try {
        if (!apiKey) {
            await msg.edit({ text: `❌ <b>请提供您的 API Key，格式：</b><code>.tk 您的APIKey</code>`, parseMode: "html" });
            return;
        }

        await msg.edit({ text: "🔍 正在检查 FFmpeg 安装状态..." });
        if (!(await isFfmpegInstalled())) {
            await msg.edit({ text: "🛠️ 检测到 FFmpeg 未安装，正在尝试安装..." });
            const installResult = await installFfmpeg();
            await msg.edit({ text: `<b>安装结果:</b> ${htmlEscape(installResult)}`, parseMode: "html" });
            if (installResult.includes("失败")) return;
        }

        const userData = await loadUserData();
        if (!userData.users[userId]) {
            userData.users[userId] = { apiKey: '', defaultRole: '雷军', defaultRoleId: userData.roles['雷军'] };
        }
        userData.users[userId].apiKey = apiKey;
        await saveUserData(userData);
        await msg.edit({ text: "✅ 您的 API Key 已成功设置！", parseMode: "html" });
        await new Promise(resolve => setTimeout(resolve, 2000));
        await msg.delete();
    } catch (error: any) {
        console.error("[TTSPlugin] 设置API Key失败:", error);
        await msg.edit({ text: `❌ <b>设置失败:</b> ${htmlEscape(error.message)}`, parseMode: "html" });
    }
}

class TTSPlugin extends Plugin {
  description: string = `
🚀 <b>文字转语音插件</b>
<b>使用方法:</b>
• <code>.t &lt;文本&gt;</code> - 将文本转换为语音 (可回复消息)
• <code>.tk &lt;APIKey&gt;</code> - 设置你的 API Key
• <code>.ts &lt;角色名&gt;</code> - 设置默认语音角色

<b>API Key 获取方法:</b>
1. 打开 <a href="https://fish.audio/">fish.audio</a> 官网并登录
2. 左侧菜单 → 开发者 → 计费 → 领取积分
3. 按提示绑定后，创建 API Key 即可
4. <b>提示:</b> 需干净节点, 开无痕方便下次继续白嫖

<b>示例:</b>
• <code>.t 大家好，我是雷军</code>
• (回复某条消息) <code>.t</code>
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

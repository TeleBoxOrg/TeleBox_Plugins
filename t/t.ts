import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import * as fs from "fs/promises";
import axios from "axios";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { createDirectoryInAssets } from "@utils/pathHelpers";

const execPromise = promisify(exec);
const DATA_FILE_NAME = "tts_data.json";

interface UserConfig {
  apiKey: string;
  defaultRole: string;
  defaultRoleId: string;
}

interface AllUserData {
  users: Record<string, UserConfig>;
  roles: Record<string, string>;
  covers?: Record<string, string>;
}

const dataFilePath = path.join(createDirectoryInAssets("tts-plugin"), DATA_FILE_NAME);
const cacheDir = createDirectoryInAssets("tts-plugin/cache");

async function loadUserData(): Promise<AllUserData> {
  try {
    const data = await fs.readFile(dataFilePath, "utf8");
    const parsed = JSON.parse(data);
    if (!parsed.roles) parsed.roles = getInitialRoles();
    if (!parsed.covers) parsed.covers = { "薯薯": "https://raw.githubusercontent.com/Yu9191/-/main/image.png" };
    return parsed;
  } catch {
    const initial: AllUserData = {
      users: {},
      roles: getInitialRoles(),
      covers: { "薯薯": "https://raw.githubusercontent.com/Yu9191/-/main/image.png" }
    };
    await saveUserData(initial);
    return initial;
  }
}

async function saveUserData(userData: AllUserData) {
  await fs.writeFile(dataFilePath, JSON.stringify(userData, null, 2), "utf8");
}

function getInitialRoles(): Record<string, string> {
  return {
    "薯薯": "cc1c9874effe4526883662166456513c", "麦当劳": "4066d617322e41abb30ed70eaeaf273f",
    "影视飓风": "91648d8a8d9841c5a1c54fb18e54ab04", "丁真": "54a5170264694bfc8e9ad98df7bd89c3",
    "雷军": "aebaa2305aa2452fbdc8f41eec852a79", "蔡徐坤": "e4642e5edccd4d9ab61a69e82d4f8a14",
    "邓紫棋": "3b55b3d84d2f453a98d8ca9bb24182d6", "周杰伦": "1512d05841734931bf905d0520c272b1",
    "周星驰": "faa3273e5013411199abc13d8f3d6445", "孙笑川": "e80ea225770f42f79d50aa98be3cedfc",
    "央视配音": "59cb5986671546eaa6ca8ae6f29f6d22", "阿诺": "daeda14f742f47b8ac243ccf21c62df8",
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
    "孙悟空": "8d96d5525334476aa67677fb43059dc5", "王琨": "4f201abba2574feeae11e5ebf737859e",
    "麦辣鸡腿堡": "c293697468924f3089cd9b90520dbc16", "猪八戒": "4313e3ec56f14eb3946630dbdad01059",
    "夏(中配) 蔚蓝档案": "c5fca4f670214e3cb7fbb9d595552e6e", "蔚蓝档案阿洛娜": "6ec8168d8392467c82358a780b35c5ca",
    "蔚蓝档案星野": "057265ac020c41a9a91d57c747d3b4c0"
  };
}


// === 清理文本 ===
function cleanTextForTTS(text: string): string {
  if (!text) return "";
  let cleanedText = text;
  const broadSymbolRegex = new RegExp(
    "[" +
    "\u{1F600}-\u{1F64F}" +
    "\u{1F300}-\u{1F5FF}" +
    "\u{1F680}-\u{1F6FF}" +
    "\u{2600}-\u{26FF}" +
    "\u{2700}-\u{27BF}" +
    "\u{FE0F}" +
    "\u{200D}" +
    "]",
    "gu"
  );
  cleanedText = cleanedText.replace(broadSymbolRegex, "");
  const whitelistRegex = /[^\u4e00-\u9fa5a-zA-Z0-9\s，。？！、,?!.]/g;
  cleanedText = cleanedText.replace(whitelistRegex, "");
  cleanedText = cleanedText.replace(/([，。？！、,?!.])\1+/g, "$1");
  return cleanedText.trim();
}

// === 生成带封面的音乐 ===
async function generateMusic(
  text: string,
  referenceId: string,
  apiKey: string,
  meta: { title: string; artist: string; album: string; cover?: string }
): Promise<string | null> {
  const api_url = "https://api.fish.audio/v1/tts";
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rawFile = path.join(cacheDir, `tts-${unique}.mp3`);
  const finalFile = path.join(cacheDir, `tts-${unique}-meta.mp3`);

  try {
    // TTS API MP3 处理
    const res = await axios.post(
      api_url,
      { text, reference_id: referenceId },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
      }
    );
    await fs.writeFile(rawFile, res.data);

    // ffmpeg 命令
    const cmd: string[] = [`ffmpeg -y -i "${rawFile}"`];

    if (meta.cover) {
      const coverPath = path.join(cacheDir, `${meta.album}.jpg`);

      // 如果本地没有封面文件，再下载
      try {
        await fs.access(coverPath);
      } catch {
        const coverRes = await axios.get(meta.cover, { responseType: "arraybuffer" });
        await fs.writeFile(coverPath, coverRes.data);
      }

      cmd.push(
        `-i "${coverPath}"`,
        `-map 0:a -map 1:v`,
        `-c:a libmp3lame -q:a 2`,
        `-c:v mjpeg`,
        `-id3v2_version 3`,
        `-disposition:v attached_pic`,
        `-metadata:s:v title="Album cover"`,
        `-metadata:s:v comment="Cover (front)"`
      );
    } else {
      cmd.push(`-c:a libmp3lame -q:a 2`);
    }

    cmd.push(
      `-metadata title="${meta.title}"`,
      `-metadata artist="${meta.artist}"`,
      `-metadata album="${meta.album}"`,
      `"${finalFile}"`
    );

    const finalCmd = cmd.join(" ");
    await execPromise(finalCmd);

    return finalFile;
  } catch (e: any) {
    console.error("生成音乐失败:", e.message || e);
    return null;
  } finally {
    try {
      await fs.unlink(rawFile);
    } catch {}
  }
}

async function generateSpeechSimple(
  text: string, referenceId: string, apiKey: string
): Promise<{ oggFile: string; mp3File: string } | null> {
  const api_url = "https://api.fish.audio/v1/tts";
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mp3File = path.join(cacheDir, `tts-${unique}.mp3`);
  const oggFile = path.join(cacheDir, `tts-${unique}.ogg`);
  try {
    const res = await axios.post(api_url, { text, reference_id: referenceId }, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      responseType: "arraybuffer",
    });
    await fs.writeFile(mp3File, res.data);
    await execPromise(`ffmpeg -y -i "${mp3File}" -c:a libopus -b:a 64k -vbr on "${oggFile}"`);
    return { oggFile, mp3File };
  } catch {
    return null;
  }
}

/** 私聊删除命令：为双方删除；群/频道：仅自己删除 */
async function deleteCommandMessage(msg: Api.Message) {
  try {
    // GramJS 提供了 isPrivate，可稳妥判断是否为私聊
    const isPrivate = (msg as any).isPrivate === true
      || (msg.peerId instanceof (Api as any).PeerUser);

    if (isPrivate) {
      await (msg as any).delete({ revoke: true });   // 双向删除
    } else {
      await msg.delete();                             // 普通删除
    }
  } catch {}
}

async function tts(msg: Api.Message) {
  const userId = msg.senderId?.toString();
  if (!userId) return;
  const userData = await loadUserData();
  const cfg = userData.users[userId];
  if (!cfg || !cfg.apiKey) {
    await msg.edit({ text: "❌ 请先设置 API Key (.tk)" });
    return;
  }

  const parts = msg.text?.split(/\s+/).slice(1) || [];

  // fm 设置封面
  if (parts[0] === "fm" && parts[1]) {
    userData.covers![cfg.defaultRole] = parts[1];
    await saveUserData(userData);
    await msg.edit({ text: `✅ 已为角色 ${cfg.defaultRole} 设置封面` });
    return;
  }

  // 音乐模式
  if (parts.length >= 3) {
    const title = parts[0];
    const artist = parts[1];
    let album = cfg.defaultRole;
    let text = "";
    if (parts.length >= 4) {
      album = parts[2];
      text = parts.slice(3).join(" ");
    } else {
      text = parts.slice(2).join(" ");
    }
    const cover = userData.covers?.[cfg.defaultRole];
    await msg.edit({ text: "🎶 正在生成音乐..." });
    const file = await generateMusic(cleanTextForTTS(text), cfg.defaultRoleId, cfg.apiKey, { title, artist, album, cover });
    if (file) {
      // 计算回复目标：优先被你回复的那条消息
      const rep = msg.replyTo?.replyToMsgId ? await msg.getReplyMessage() : null;
      const replyToId = rep?.id ?? msg.id;

      await msg.client?.sendFile(msg.peerId, {
        file,
        caption: `${title} - ${artist}`,
        replyTo: replyToId,
        attributes: [
          new (Api as any).DocumentAttributeAudio({
            duration: 0,
            title: title,
            performer: artist,
          }),
        ],
      });
      try { await fs.unlink(file); } catch {}
      await deleteCommandMessage(msg);   // ← 按会话类型选择删除方式
    } else {
      await msg.edit({ text: "❌ 生成失败" });
    }
    return;
  }

  // 普通语音
  let text = parts.join(" ");
  let replyToId = msg.id;
  if (msg.replyTo?.replyToMsgId) {
    const rep = await msg.getReplyMessage();
    if (rep?.text) text = text || rep.text;
    if (rep?.id) replyToId = rep.id;
  }
  if (!text) {
    await msg.edit({ text: "❌ 用法: .t 文本 或 .t 歌曲名 歌手 [专辑名] 文本" });
    return;
  }
  await msg.edit({ text: "🎤 正在生成语音..." });
  const r = await generateSpeechSimple(cleanTextForTTS(text), cfg.defaultRoleId, cfg.apiKey);
  if (r) {
    await msg.client?.sendFile(msg.peerId, {
      file: r.oggFile,
      replyTo: replyToId,
      attributes: [new (Api as any).DocumentAttributeAudio({ duration: 0, voice: true })],
    });
    try { await fs.unlink(r.oggFile); await fs.unlink(r.mp3File); } catch {}
    await deleteCommandMessage(msg);     // ← 按会话类型选择删除方式
  } else {
    await msg.edit({ text: "❌ 生成失败" });
  }
}

// === 角色/Key 设置 ===
async function ttsSet(msg: Api.Message) {
  const userId = msg.senderId?.toString();
  if (!userId) return;
  const [, roleName] = msg.text?.split(/\s+/).filter(Boolean) || [];
  const userData = await loadUserData();

  // 不带角色名：列出所有
  if (!roleName) {
    const names = Object.keys(userData.roles);
    const list = names.map((n, i) => `${i + 1}. ${n}`).join("\n");
    await msg.edit({
      text:
        `🎭 可用角色（${names.length}）\n` +
        `当前：${userData.users[userId]?.defaultRole || "未设置"}\n\n` +
        list + `\n\n用法：.ts 角色名`,
    });
    return;
  }

  if (userData.roles[roleName]) {
    if (!userData.users[userId]) {
      userData.users[userId] = { apiKey: "", defaultRole: "雷军", defaultRoleId: userData.roles["雷军"] };
    }
    userData.users[userId].defaultRole = roleName;
    userData.users[userId].defaultRoleId = userData.roles[roleName];
    await saveUserData(userData);
    await msg.edit({ text: `✅ 默认角色已切换为: ${roleName}` });
  } else {
    await msg.edit({ text: "❌ 无效的角色名" });
  }
}

async function setApiKey(msg: Api.Message) {
  const userId = msg.senderId?.toString();
  if (!userId) return;
  const [, apiKey] = msg.text?.split(/\s+/).filter(Boolean) || [];
  if (!apiKey) {
    await msg.edit({ text: "❌ 请提供 API Key" });
    return;
  }
  const userData = await loadUserData();
  if (!userData.users[userId]) {
    userData.users[userId] = { apiKey, defaultRole: "雷军", defaultRoleId: userData.roles["雷军"] };
  }
  userData.users[userId].apiKey = apiKey;
  await saveUserData(userData);
  await msg.edit({ text: "✅ API Key 设置成功" });
}

class TTSPlugin extends Plugin {
  description = `
🚀 <b>文字转语音/音乐插件</b>
• <code>.t 文本</code> - 普通语音
• <code>.t 歌曲名 歌手 文本</code> - 音乐模式
• <code>.t 歌曲名 歌手 专辑名 文本</code> - 音乐模式(指定专辑)
• <code>.t fm 封面链接</code> - 设置当前角色封面
• <code>.ts [角色名]</code> - 切换角色；不带参数显示角色列表
• <code>.tk APIKey</code> - 设置 API Key
`;

  cmdHandlers = { t: tts, ts: ttsSet, tk: setApiKey };
}

export default new TTSPlugin();

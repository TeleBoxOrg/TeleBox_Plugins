import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "teleproto";

// HTML转义工具
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 帮助文本定义
const help_text = `🆔 <b>用户信息查询插件</b>

<b>使用方式：</b>
• <code>${mainPrefix}ids</code> - 显示自己的信息
• <code>${mainPrefix}ids @用户名</code> - 查询指定用户信息
• <code>${mainPrefix}ids 用户ID</code> - 通过ID查询用户信息
• 回复消息后使用 <code>${mainPrefix}ids</code> - 查询被回复用户信息

<b>显示信息包括：</b>
• 用户名和显示名称
• 用户ID、注册时间、DC
• <b>入群时间</b>（仅群组有效）
• 共同群组数量
• 用户简介
• 三种跳转链接

<b>支持格式：</b>
• @用户名、用户ID、频道ID、回复消息`;

class IdsPlugin extends Plugin {
  description: string = `用户信息查询插件\n\n${help_text}`;

  // 高精度采样点 (ID, Timestamp) - 2026最新校准
  private readonly ID_DATA_POINTS: [number, number][] = [
    [0, 1376438400], [50000000, 1400000000], [150000000, 1451606400],
    [350000000, 1483228800], [500000000, 1514764800], [900000000, 1559347200],
    [1100000000, 1585699200], [1450000000, 1609459200], [2150000000, 1640995200],
    [5100000000, 1654041600], [5600000000, 1672531200], [6800000000, 1704067200],
    [7800000000, 1735689600], [8500000000, 1767225600]
  ];

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    ids: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const target = args[0] || "";

      try {
        if (target === "help" || target === "h") {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        await msg.edit({ text: "🔍 <b>正在查询用户信息...</b>", parseMode: "html" });

        let targetUser: any = null;
        let targetId: number | null = null;

        if (target) {
          const result = await this.parseTarget(client, target);
          targetUser = result.user; targetId = result.id;
        } else {
          try {
            const reply = await msg.getReplyMessage();
            if (reply?.senderId) {
              targetId = Number(reply.senderId);
              targetUser = reply.sender;
            }
          } catch {}
        }

        if (!targetUser && !targetId) {
          const me = await client.getMe();
          targetUser = me; targetId = Number(me.id);
        }

        if (!targetId) {
          await msg.edit({ text: `❌ 无法获取用户信息`, parseMode: "html" });
          return;
        }

        const userInfo = await this.getUserInfo(client, targetUser, targetId, msg);
        const result = this.formatUserInfo(userInfo);
        await this.sendLongMessage(msg, result);

      } catch (error: any) {
        await msg.edit({ text: `❌ <b>查询失败:</b> ${htmlEscape(error.message || "未知错误")}`, parseMode: "html" });
      }
    }
  };

  private getPreciseRegDate(userId: number): string {
    if (userId < 0) return "频道/群组";
    let lower = this.ID_DATA_POINTS[0], upper = this.ID_DATA_POINTS[this.ID_DATA_POINTS.length - 1];
    for (let i = 0; i < this.ID_DATA_POINTS.length - 1; i++) {
      if (userId >= this.ID_DATA_POINTS[i][0] && userId <= this.ID_DATA_POINTS[i + 1][0]) {
        lower = this.ID_DATA_POINTS[i]; upper = this.ID_DATA_POINTS[i + 1]; break;
      }
    }
    const ts = lower[1] + (userId - lower[0]) * (upper[1] - lower[1]) / (upper[0] - lower[0]);
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  }

  private async getUserInfo(client: any, user: any, userId: number, msg: Api.Message): Promise<any> {
    const info: any = {
      id: userId, user, username: user?.username || null,
      firstName: user?.firstName || user?.first_name || null,
      lastName: user?.lastName || user?.last_name || null,
      isBot: user?.bot || false, isVerified: user?.verified || false,
      isPremium: user?.premium || false, isScam: user?.scam || false,
      isFake: user?.fake || false, dc: "未知", bio: null, commonChats: 0,
      regDate: this.getPreciseRegDate(userId), joinedDate: null
    };

    try {
      const full = await client.invoke(new Api.users.GetFullUser({ id: userId }));
      if (full.fullUser) {
        info.bio = full.fullUser.about || null;
        info.commonChats = full.fullUser.commonChatsCount || 0;
      }
    } catch {}

    if (msg.isGroup || msg.isChannel) {
      try {
        const p = await client.invoke(new Api.channels.GetParticipant({ channel: msg.peerId, participant: userId }));
        if ((p.participant as any).date) {
          const jd = new Date((p.participant as any).date * 1000);
          info.joinedDate = `${jd.getFullYear()}-${(jd.getMonth()+1).toString().padStart(2,'0')}-${jd.getDate().toString().padStart(2,'0')} ${jd.getHours().toString().padStart(2,'0')}:${jd.getMinutes().toString().padStart(2,'0')}`;
        }
      } catch {}
    }

    info.dc = await this.getUserDC(client, userId, user);
    return info;
  }

  private async getUserDC(client: any, userId: number, user: any): Promise<string> {
    try {
      const full = await client.invoke(new Api.users.GetFullUser({ id: userId }));
      const u = full.users[0];
      if (u.photo?.className !== "UserProfilePhotoEmpty") return `DC${(u.photo as any).dcId}`;
      return "无头像";
    } catch { return "未知"; }
  }

  private formatUserInfo(info: any): string {
    const userId = info.id;
    let displayName = info.firstName ? `${info.firstName}${info.lastName ? ' ' + info.lastName : ''}` : (info.username ? `@${info.username}` : `用户 ${userId}`);
    let usernameInfo = info.username ? `@${info.username}` : "无用户名";

    const statusTags = [];
    if (info.isBot) statusTags.push("🤖 机器人");
    if (info.isVerified) statusTags.push("✅ 已验证");
    if (info.isPremium) statusTags.push("⭐ Premium");
    if (info.isScam) statusTags.push("⚠️ 诈骗");
    if (info.isFake) statusTags.push("❌ 虚假");

    let bioText = info.bio || "无简介";
    if (bioText.length > 200) bioText = bioText.substring(0, 200) + "...";

    const link1 = `tg://user?id=${userId}`, link2 = info.username ? `https://t.me/${info.username}` : `https://t.me/@id${userId}`, link3 = `tg://openmessage?user_id=${userId}`;

    let result = `👤 <b>${htmlEscape(displayName)}</b>\n\n`;
    result += `<b>基本信息：</b>\n`;
    result += `• 用户名：<code>${htmlEscape(usernameInfo)}</code>\n`;
    result += `• 用户ID：<code>${userId}</code>\n`;
    result += `• 注册时间：<code>${info.regDate} (±2月)</code>\n`;
    if (info.joinedDate) result += `• 入群时间：<code>${info.joinedDate}</code>\n`;
    result += `• DC：<code>${info.dc}</code>\n`;
    result += `• 共同群：<code>${info.commonChats}</code> 个\n`;
    if (statusTags.length > 0) result += `• 状态：${statusTags.join(" ")}\n`;
    
    result += `\n<b>简介：</b>\n<code>${htmlEscape(bioText)}</code>\n`;
    result += `\n<b>跳转链接：</b>\n`;
    result += `• <a href="${link1}">用户资料</a>\n• <a href="${link2}">聊天链接</a>\n• <a href="${link3}">打开消息</a>\n`;
    result += `\n<b>链接文本：</b>\n`;
    result += `• <code>${link1}</code>\n• <code>${link2}</code>\n• <code>${link3}</code>`;

    return result;
  }

  private async parseTarget(client: any, target: string) {
    if (target.startsWith("@")) {
      const e = await client.getEntity(target);
      return { user: e, id: Number(e.id) };
    }
    const id = parseInt(target);
    if (!isNaN(id)) {
      try { return { user: await client.getEntity(id), id }; } catch { return { user: null, id }; }
    }
    throw new Error("无效格式");
  }

  private async sendLongMessage(msg: Api.Message, text: string) {
    if (text.length <= 4096) { await msg.edit({ text, parseMode: "html" }); return; }
    const parts = text.match(/[\s\S]{1,4000}/g) || [];
    for (let i = 0; i < parts.length; i++) {
      if (i === 0) await msg.edit({ text: parts[i] + `\n\n📄 (1/${parts.length})`, parseMode: "html" });
      else await msg.reply({ message: parts[i] + `\n\n📄 (${i + 1}/${parts.length})`, parseMode: "html" });
    }
  }
}

export default new IdsPlugin();

/*自动昵称更新插件 v3*/

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api } from "teleproto";
import { JSONFilePreset } from "lowdb/node";
import { cronManager } from "@utils/cronManager";
import * as path from "path";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// === 配置与工具函数 ===
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;'}[m] || m));

// 帮助文本定义（必需）
const help_text = `🤖 <b>自动昵称更新插件 v3</b>

让您的昵称动起来！自动显示时间或个性文案 ⏰

<b>📌 快速开始（按顺序执行）：</b>
1️⃣ <code>${mainPrefix}acn save</code> - 保存当前昵称（首次使用必须）
2️⃣ <code>${mainPrefix}acn on/off</code> - 开启或关闭自动更新
3️⃣ <code>${mainPrefix}acn mode</code> - 切换显示模式
4️⃣ 等待一分钟，昵称会自动更新

<b>🔧 基础操作：</b>
<blockquote expandable>• <code>${mainPrefix}acn save</code>
  保存您当前的昵称为"原始昵称"。这是所有动态更新的基础
  保存后，插件会以此为基准，在每次更新时加上时间、文案等内容
  ⚠️ 建议在"干净"昵称下执行（不含时间等动态内容）
• <code>${mainPrefix}acn on</code> / <code>off</code>
  开启或关闭自动昵称更新功能
  开启后每分钟自动更新一次，关闭后昵称保持当前状态不变
• <code>${mainPrefix}acn enable</code> / <code>disable</code>
  同上（别名命令）
• <code>${mainPrefix}acn mode</code>
  循环切换显示模式：time → text → both → time
  • <code>time</code> - 只显示昵称 + 时间（如：张三 09:30）
  • <code>text</code> - 只显示昵称 + 文案（如：张三 摸鱼中）
  • <code>both</code> - 显示昵称 + 文案 + 时间（如：张三 摸鱼中 09:30）
• <code>${mainPrefix}acn update</code> / <code>now</code>
  立即手动更新一次昵称，不等下一分钟
• <code>${mainPrefix}acn reset</code>
  恢复原始昵称并停止自动更新（不删除配置）
• <code>${mainPrefix}acn status</code>
  查看插件运行状态：自动更新是否运行、启用的用户数量</blockquote>
<b>🌍 时区管理：</b>
<blockquote expandable>• <code>${mainPrefix}acn tz Asia/Shanghai</code>
  设置您的时区。参数为 IANA 时区标识符
  常用时区：Asia/Shanghai（北京）、America/New_York（纽约）、Europe/London（伦敦）等
• <code>${mainPrefix}acn tz list</code>
  查看常用时区列表，方便复制使用
• <code>${mainPrefix}acn tz on</code> / <code>off</code>
  控制昵称中是否显示时区信息（如 GMT+8）
  开启后昵称示例：张三 09:30 GMT+8
• <code>${mainPrefix}acn tz format GMT</code>
  设置时区的显示格式，可选值：
  • <code>GMT</code> - 显示 GMT+8（默认）
  • <code>UTC</code> - 显示 UTC+8
  • <code>simp</code> - 显示时区缩写，如 HKT / CST / EDT
  • <code>offset</code> - 显示纯偏移量，如 +8:00
  • <code>custom:文字</code> - 自定义显示文字，如 custom:北京时间
• <code>${mainPrefix}acn timezone</code>
  等同于 <code>${mainPrefix}acn tz</code>（别名）</blockquote>
<b>🎨 外观设置：</b>
<blockquote expandable>• <code>${mainPrefix}acn emoji on</code> / <code>off</code>
  开启或关闭时钟 emoji（🕐🕑🕒...）
  时钟 emoji 会根据当前小时自动匹配对应的钟面
• <code>${mainPrefix}acn time on</code> / <code>off</code>
  开启或关闭时间显示
• <code>${mainPrefix}acn text on</code> / <code>off</code>
  开启或关闭随机文案显示
• <code>${mainPrefix}acn weather on</code> / <code>off</code>
  开启或关闭天气显示（需先设置地点）
• <code>${mainPrefix}acn style italic</code>
  切换昵称中动态内容的文字样式
  可选：normal（默认）/ italic / double / sans / mono / outline
  样式效果示例：
  • normal: 123abc
  • italic: 𝟏𝟐𝟑𝐚𝐛𝐜
  • double: 𝟙𝟚𝟛𝕒𝕓𝕔
  • sans: 𝟭𝟮𝟯𝗮𝗯𝗰
  • mono: 𝟷𝟸𝟹𝚊𝚋𝚌
  • outline: 𝟣𝟤𝟥𝖺𝖻𝖼
• <code>${mainPrefix}acn order</code>
  查看当前组件的显示顺序
• <code>${mainPrefix}acn order name,text,time,weather,emoji</code>
  自定义昵称中各组件的排列顺序
  可用组件：name（昵称）、text（文案）、time（时间）、weather（天气）、emoji（时钟表情）、timezone（时区）</blockquote>
<b>📝 文案管理：</b>
<blockquote expandable>• <code>${mainPrefix}acn text add 摸鱼中</code>
  添加一条随机文案。支持多行批量添加（每行一条）
  文案最长 50 字符，建议简短有趣
  添加的文案会在 text/both 模式下随机循环显示
• <code>${mainPrefix}acn text del 1</code>
  删除指定序号的文案（序号从 1 开始）
• <code>${mainPrefix}acn text list</code>
  查看所有已添加的文案列表及序号
• <code>${mainPrefix}acn text clear</code>
  清空所有文案</blockquote>
<b>🌤️ 天气显示：</b>
<blockquote expandable>• <code>${mainPrefix}acn weather set 北京</code>
  设置天气地点并自动开启天气显示
  地点支持中文城市名或英文名（如 Beijing）
• <code>${mainPrefix}acn weather on</code> / <code>off</code>
  手动开启或关闭天气显示（需先设置地点）
• <code>${mainPrefix}acn weather</code>
  查看当前天气配置：地点、开关状态、预览
• 天气信息会缓存 30 分钟，避免频繁请求天气接口</blockquote>

<b>📊 查看配置：</b>
• <code>${mainPrefix}acn status</code>
  查看插件运行状态（自动更新是否运行、启用用户数）
• <code>${mainPrefix}acn config</code>
  查看您的完整配置状态，包括所有设置项的当前值

<b>💡 使用技巧：</b>
• 昵称每分钟自动更新一次，天气每半小时自动更新一次
• 文案会按添加顺序循环显示
• 被限流时会自动暂停，无需手动干预

<b>❓ 遇到问题？</b>
• 使用 <code>${mainPrefix}acn status</code> 检查运行状态
• 使用 <code>${mainPrefix}acn reset</code> 重置所有设置
• 重新执行 <code>${mainPrefix}acn save</code> 保存昵称`;

// === 类型定义 ===
interface UserSettings {
  user_id: number;
  timezone: string;
  original_first_name: string | null;
  original_last_name: string | null;
  is_enabled: boolean;
  mode: "time" | "text" | "both";
  last_update: string | null;
  text_index: number;
  show_clock_emoji?: boolean;
  show_time?: boolean;
  show_timezone?: boolean;
  display_order?: string;
  timezone_format?: string;
  weather_enabled?: boolean;
  weather_location?: string;
  weather_compact?: string;
  weather_cache_ts?: number;
  text_style?: "normal" | "italic" | "double" | "sans" | "mono" | "outline";
  displayComponents?: string[];
}

type TextStyleMode = NonNullable<UserSettings["text_style"]>;

type SeasonalAbbreviation = { standard: string; daylight: string };

interface WeatherGeocodingResponse {
  results?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    country_code: string;
    admin1?: string;
    admin2?: string;
  }>;
}

interface WeatherForecastResponse {
  current?: {
    temperature_2m: number;
    weather_code: number;
  };
}

interface ConfigData {
  users: Record<string, UserSettings>;
  random_texts: string[];
}

// === 数据管理层 ===
class DataManager {
  private static db: Awaited<ReturnType<typeof JSONFilePreset<ConfigData>>> | null = null;
  private static initPromise: Promise<void> | null = null;

  private static async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const dbPath = path.join(createDirectoryInAssets("autochangename"), "autochangename.json");
      this.db = await JSONFilePreset<ConfigData>(dbPath, { users: {}, random_texts: [] });
      console.log("[AutoChangeName] 数据库初始化成功");
    })();
    
    return this.initPromise;
  }

  static async getUserSettings(userId: number): Promise<UserSettings | null> {
    if (!userId || isNaN(userId)) return null;
    await this.init();
    return this.db?.data?.users?.[userId.toString()] ?? null;
  }

  static async saveUserSettings(settings: UserSettings): Promise<boolean> {
    if (!settings?.user_id) return false;
    await this.init();
    try {
      this.db!.data.users[settings.user_id.toString()] = { ...settings };
      await this.db!.write();
      return true;
    } catch { return false; }
  }

  static async getRandomTexts(): Promise<string[]> {
    await this.init();
    return this.db?.data?.random_texts ?? [];
  }

  static async saveRandomTexts(texts: string[]): Promise<boolean> {
    await this.init();
    try {
      this.db!.data.random_texts = texts.slice(0, 100)
        .filter((t): t is string => Boolean(t) && typeof t === 'string')
        .map(t => t.trim())
        .filter(t => t.length > 0 && t.length <= 50);
      await this.db!.write();
      return true;
    } catch { return false; }
  }

  static async getAllEnabledUsers(): Promise<number[]> {
    await this.init();
    const users = this.db?.data?.users ?? {};
    return Object.entries(users)
      .filter(([_, v]) => v.is_enabled)
      .map(([k]) => parseInt(k, 10));
  }
}

// === 昵称管理层 ===
class NameManager {
  private readonly TASK_NAME = "autochangename_update";
  private static instance: NameManager;
  private isUpdating = false;
  private profileCache: { data: any; timestamp: number } | null = null;
  private readonly CACHE_TTL = 60000;
  private readonly timezoneAbbreviationMap: Record<string, string> = {
    'Africa/Abidjan': 'GMT', 'Africa/Accra': 'GMT', 'Africa/Addis_Ababa': 'EAT', 'Africa/Algiers': 'CET',
    'Africa/Asmara': 'EAT', 'Africa/Bamako': 'GMT', 'Africa/Bangui': 'WAT', 'Africa/Banjul': 'GMT',
    'Africa/Bissau': 'GMT', 'Africa/Blantyre': 'CAT', 'Africa/Brazzaville': 'WAT', 'Africa/Cairo': 'EET',
    'Africa/Casablanca': 'WET', 'Africa/Ceuta': 'CET', 'Africa/Dakar': 'GMT', 'Africa/Dar_es_Salaam': 'EAT',
    'Africa/Djibouti': 'EAT', 'Africa/Douala': 'WAT', 'Africa/El_Aaiun': 'WET', 'Africa/Freetown': 'GMT',
    'Africa/Gaborone': 'CAT', 'Africa/Harare': 'CAT', 'Africa/Johannesburg': 'SAST', 'Africa/Juba': 'CAT',
    'Africa/Kampala': 'EAT', 'Africa/Khartoum': 'CAT', 'Africa/Kigali': 'CAT', 'Africa/Kinshasa': 'WAT',
    'Africa/Lagos': 'WAT', 'Africa/Libreville': 'WAT', 'Africa/Lome': 'GMT', 'Africa/Luanda': 'WAT',
    'Africa/Lubumbashi': 'CAT', 'Africa/Lusaka': 'CAT', 'Africa/Malabo': 'WAT', 'Africa/Maputo': 'CAT',
    'Africa/Maseru': 'SAST', 'Africa/Mbabane': 'SAST', 'Africa/Mogadishu': 'EAT', 'Africa/Monrovia': 'GMT',
    'Africa/Nairobi': 'EAT', 'Africa/Ndjamena': 'WAT', 'Africa/Niamey': 'WAT', 'Africa/Nouakchott': 'GMT',
    'Africa/Ouagadougou': 'GMT', 'Africa/Porto-Novo': 'WAT', 'Africa/Sao_Tome': 'GMT', 'Africa/Tripoli': 'EET',
    'Africa/Tunis': 'CET', 'Africa/Windhoek': 'CAT', 'America/Adak': 'HST', 'America/Anchorage': 'AKST',
    'America/Anguilla': 'AST', 'America/Antigua': 'AST', 'America/Araguaina': 'BRT', 'America/Argentina/Buenos_Aires': 'ART',
    'America/Argentina/Catamarca': 'ART', 'America/Argentina/Cordoba': 'ART', 'America/Argentina/Mendoza': 'ART',
    'America/Aruba': 'AST', 'America/Asuncion': 'PYT', 'America/Atikokan': 'EST', 'America/Bahia': 'BRT',
    'America/Bahia_Banderas': 'CST', 'America/Barbados': 'AST', 'America/Belem': 'BRT', 'America/Belize': 'CST',
    'America/Blanc-Sablon': 'AST', 'America/Boa_Vista': 'AMT', 'America/Bogota': 'COT', 'America/Boise': 'MST',
    'America/Cambridge_Bay': 'MST', 'America/Campo_Grande': 'AMT', 'America/Cancun': 'EST', 'America/Caracas': 'VET',
    'America/Cayenne': 'GFT', 'America/Cayman': 'EST', 'America/Chicago': 'CST', 'America/Chihuahua': 'MST',
    'America/Ciudad_Juarez': 'MST', 'America/Costa_Rica': 'CST', 'America/Creston': 'MST', 'America/Cuiaba': 'AMT',
    'America/Curacao': 'AST', 'America/Danmarkshavn': 'GMT', 'America/Dawson': 'MST', 'America/Dawson_Creek': 'MST',
    'America/Denver': 'MST', 'America/Detroit': 'EST', 'America/Dominica': 'AST', 'America/Edmonton': 'MST',
    'America/Eirunepe': 'ACT', 'America/El_Salvador': 'CST', 'America/Fort_Nelson': 'MST', 'America/Fortaleza': 'BRT',
    'America/Glace_Bay': 'AST', 'America/Goose_Bay': 'AST', 'America/Grand_Turk': 'EST', 'America/Guatemala': 'CST',
    'America/Guayaquil': 'ECT', 'America/Guyana': 'GYT', 'America/Halifax': 'AST', 'America/Havana': 'CST',
    'America/Hermosillo': 'MST', 'America/Indiana/Indianapolis': 'EST', 'America/Indiana/Knox': 'CST',
    'America/Indiana/Marengo': 'EST', 'America/Indiana/Petersburg': 'EST', 'America/Indiana/Tell_City': 'CST',
    'America/Indiana/Vevay': 'EST', 'America/Indiana/Vincennes': 'EST', 'America/Indiana/Winamac': 'EST',
    'America/Inuvik': 'MST', 'America/Iqaluit': 'EST', 'America/Jamaica': 'EST', 'America/Juneau': 'AKST',
    'America/Kentucky/Louisville': 'EST', 'America/Kentucky/Monticello': 'EST', 'America/Kralendijk': 'AST',
    'America/La_Paz': 'BOT', 'America/Lima': 'PET', 'America/Los_Angeles': 'PST', 'America/Maceio': 'BRT',
    'America/Managua': 'CST', 'America/Manaus': 'AMT', 'America/Martinique': 'AST', 'America/Matamoros': 'CST',
    'America/Mazatlan': 'MST', 'America/Menominee': 'CST', 'America/Merida': 'CST', 'America/Metlakatla': 'AKST',
    'America/Mexico_City': 'CST', 'America/Miquelon': 'PMST', 'America/Moncton': 'AST', 'America/Monterrey': 'CST',
    'America/Montevideo': 'UYT', 'America/Nassau': 'EST', 'America/New_York': 'EST', 'America/Nipigon': 'EST',
    'America/Nome': 'AKST', 'America/Noronha': 'FNT', 'America/North_Dakota/Beulah': 'CST', 'America/North_Dakota/Center': 'CST',
    'America/North_Dakota/New_Salem': 'CST', 'America/Nuuk': 'WGT', 'America/Ojinaga': 'CST', 'America/Panama': 'EST',
    'America/Paramaribo': 'SRT', 'America/Phoenix': 'MST', 'America/Port_of_Spain': 'AST', 'America/Port-au-Prince': 'EST',
    'America/Porto_Velho': 'AMT', 'America/Puerto_Rico': 'AST', 'America/Punta_Arenas': 'CLT', 'America/Rainy_River': 'CST',
    'America/Rankin_Inlet': 'CST', 'America/Recife': 'BRT', 'America/Regina': 'CST', 'America/Resolute': 'CST',
    'America/Rio_Branco': 'ACT', 'America/Santarem': 'BRT', 'America/Santiago': 'CLT', 'America/Santo_Domingo': 'AST',
    'America/Sao_Paulo': 'BRT', 'America/Scoresbysund': 'EGT', 'America/Sitka': 'AKST', 'America/St_Johns': 'NST',
    'America/Swift_Current': 'CST', 'America/Tegucigalpa': 'CST', 'America/Thule': 'AST', 'America/Thunder_Bay': 'EST',
    'America/Tijuana': 'PST', 'America/Toronto': 'EST', 'America/Tortola': 'AST', 'America/Vancouver': 'PST',
    'America/Whitehorse': 'MST', 'America/Winnipeg': 'CST', 'America/Yakutat': 'AKST', 'America/Yellowknife': 'MST',
    'Antarctica/Casey': 'AWST', 'Antarctica/Davis': 'DAVT', 'Antarctica/DumontDUrville': 'DDUT', 'Antarctica/Macquarie': 'AEST',
    'Antarctica/Mawson': 'MAWT', 'Antarctica/McMurdo': 'NZST', 'Antarctica/Palmer': 'CLT', 'Antarctica/Rothera': 'ROT',
    'Antarctica/South_Pole': 'NZST', 'Antarctica/Syowa': 'SYOT', 'Antarctica/Troll': 'UTC', 'Antarctica/Vostok': 'VOST',
    'Asia/Aden': 'AST', 'Asia/Almaty': 'ALMT', 'Asia/Amman': 'EET', 'Asia/Anadyr': 'ANAT', 'Asia/Aqtau': 'AQTT',
    'Asia/Aqtobe': 'AQTT', 'Asia/Ashgabat': 'TMT', 'Asia/Atyrau': 'AQTT', 'Asia/Baghdad': 'AST', 'Asia/Bahrain': 'AST',
    'Asia/Baku': 'AZT', 'Asia/Bangkok': 'ICT', 'Asia/Barnaul': 'KRAT', 'Asia/Beirut': 'EET', 'Asia/Bishkek': 'KGT',
    'Asia/Brunei': 'BNT', 'Asia/Calcutta': 'IST', 'Asia/Chita': 'YAKT', 'Asia/Choibalsan': 'CHOT', 'Asia/Chongqing': 'CST',
    'Asia/Colombo': 'IST', 'Asia/Damascus': 'EET', 'Asia/Dhaka': 'BDT', 'Asia/Dili': 'TLT', 'Asia/Dubai': 'GST',
    'Asia/Dushanbe': 'TJT', 'Asia/Famagusta': 'EET', 'Asia/Gaza': 'EET', 'Asia/Harbin': 'CST', 'Asia/Hebron': 'EET',
    'Asia/Ho_Chi_Minh': 'ICT', 'Asia/Hong_Kong': 'HKT', 'Asia/Hovd': 'HOVT', 'Asia/Irkutsk': 'IRKT', 'Asia/Istanbul': 'TRT',
    'Asia/Jakarta': 'WIB', 'Asia/Jayapura': 'WIT', 'Asia/Jerusalem': 'IST', 'Asia/Kabul': 'AFT', 'Asia/Kamchatka': 'PETT',
    'Asia/Karachi': 'PKT', 'Asia/Kashgar': 'XJT', 'Asia/Kathmandu': 'NPT', 'Asia/Khandyga': 'YAKT', 'Asia/Kolkata': 'IST',
    'Asia/Krasnoyarsk': 'KRAT', 'Asia/Kuala_Lumpur': 'MYT', 'Asia/Kuching': 'MYT', 'Asia/Kuwait': 'AST', 'Asia/Macao': 'CST',
    'Asia/Magadan': 'MAGT', 'Asia/Makassar': 'WITA', 'Asia/Manila': 'PST', 'Asia/Muscat': 'GST', 'Asia/Nicosia': 'EET',
    'Asia/Novokuznetsk': 'KRAT', 'Asia/Novosibirsk': 'NOVT', 'Asia/Omsk': 'OMST', 'Asia/Oral': 'ORAT', 'Asia/Phnom_Penh': 'ICT',
    'Asia/Pontianak': 'WIB', 'Asia/Pyongyang': 'KST', 'Asia/Qatar': 'AST', 'Asia/Qostanay': 'QYZT', 'Asia/Qyzylorda': 'QYZT',
    'Asia/Rangoon': 'MMT', 'Asia/Riyadh': 'AST', 'Asia/Sakhalin': 'SAKT', 'Asia/Samarkand': 'UZT', 'Asia/Seoul': 'KST',
    'Asia/Shanghai': 'CST', 'Asia/Singapore': 'SGT', 'Asia/Srednekolymsk': 'SRET', 'Asia/Taipei': 'CST', 'Asia/Tashkent': 'UZT',
    'Asia/Tbilisi': 'GET', 'Asia/Tehran': 'IRST', 'Asia/Tel_Aviv': 'IST', 'Asia/Thimphu': 'BTT', 'Asia/Tokyo': 'JST',
    'Asia/Tomsk': 'TOMT', 'Asia/Ulaanbaatar': 'ULAT', 'Asia/Urumqi': 'XJT', 'Asia/Ust-Nera': 'VLAT', 'Asia/Vientiane': 'ICT',
    'Asia/Vladivostok': 'VLAT', 'Asia/Yakutsk': 'YAKT', 'Asia/Yangon': 'MMT', 'Asia/Yekaterinburg': 'YEKT', 'Asia/Yerevan': 'AMT',
    'Atlantic/Azores': 'AZOT', 'Atlantic/Bermuda': 'AST', 'Atlantic/Canary': 'WET', 'Atlantic/Cape_Verde': 'CVT',
    'Atlantic/Faeroe': 'WET', 'Atlantic/Faroe': 'WET', 'Atlantic/Jan_Mayen': 'CET', 'Atlantic/Madeira': 'WET',
    'Atlantic/Reykjavik': 'GMT', 'Atlantic/South_Georgia': 'GST', 'Atlantic/St_Helena': 'GMT', 'Atlantic/Stanley': 'FKST',
    'Arctic/Longyearbyen': 'CET', 'Australia/ACT': 'AEST', 'Australia/Adelaide': 'ACST', 'Australia/Brisbane': 'AEST',
    'Australia/Broken_Hill': 'ACST', 'Australia/Canberra': 'AEST', 'Australia/Currie': 'AEST', 'Australia/Darwin': 'ACST',
    'Australia/Eucla': 'ACWST', 'Australia/Hobart': 'AEST', 'Australia/LHI': 'LHST', 'Australia/Lindeman': 'AEST',
    'Australia/Lord_Howe': 'LHST', 'Australia/Melbourne': 'AEST', 'Australia/North': 'ACST', 'Australia/NSW': 'AEST',
    'Australia/Perth': 'AWST', 'Australia/Queensland': 'AEST', 'Australia/South': 'ACST', 'Australia/Sydney': 'AEST',
    'Australia/Tasmania': 'AEST', 'Australia/Victoria': 'AEST', 'Australia/West': 'AWST', 'Australia/Yancowinna': 'ACST',
    'Europe/Andorra': 'CET', 'Europe/Astrakhan': 'SAMT', 'Europe/Athens': 'EET', 'Europe/Belgrade': 'CET',
    'Europe/Berlin': 'CET', 'Europe/Brussels': 'CET', 'Europe/Bucharest': 'EET', 'Europe/Budapest': 'CET',
    'Europe/Chisinau': 'EET', 'Europe/Dublin': 'GMT', 'Europe/Gibraltar': 'CET', 'Europe/Helsinki': 'EET',
    'Europe/Istanbul': 'TRT', 'Europe/Kaliningrad': 'EET', 'Europe/Kirov': 'MSK', 'Europe/Kyiv': 'EET',
    'Europe/Lisbon': 'WET', 'Europe/London': 'GMT', 'Europe/Madrid': 'CET', 'Europe/Malta': 'CET',
    'Europe/Minsk': 'MSK', 'Europe/Moscow': 'MSK', 'Europe/Paris': 'CET', 'Europe/Prague': 'CET',
    'Europe/Riga': 'EET', 'Europe/Rome': 'CET', 'Europe/Samara': 'SAMT', 'Europe/Saratov': 'SAMT',
    'Europe/Simferopol': 'MSK', 'Europe/Sofia': 'EET', 'Europe/Tallinn': 'EET', 'Europe/Tirane': 'CET',
    'Europe/Ulyanovsk': 'SAMT', 'Europe/Vienna': 'CET', 'Europe/Vilnius': 'EET', 'Europe/Volgograd': 'MSK',
    'Europe/Warsaw': 'CET', 'Europe/Zurich': 'CET', 'Indian/Chagos': 'IOT', 'Indian/Christmas': 'CXT',
    'Indian/Cocos': 'CCT', 'Indian/Kerguelen': 'TFT', 'Indian/Maldives': 'MVT', 'Indian/Mauritius': 'MUT',
    'Indian/Mayotte': 'EAT', 'Indian/Reunion': 'RET', 'Pacific/Apia': 'WST', 'Pacific/Auckland': 'NZST',
    'Pacific/Bougainville': 'BST', 'Pacific/Chatham': 'CHAST', 'Pacific/Easter': 'EASST', 'Pacific/Efate': 'VUT',
    'Pacific/Fakaofo': 'TKT', 'Pacific/Fiji': 'FJT', 'Pacific/Galapagos': 'GALT', 'Pacific/Gambier': 'GAMT',
    'Pacific/Guadalcanal': 'SBT', 'Pacific/Guam': 'ChST', 'Pacific/Honolulu': 'HST', 'Pacific/Kanton': 'PHOT',
    'Pacific/Kiritimati': 'LINT', 'Pacific/Kosrae': 'KOST', 'Pacific/Kwajalein': 'MHT', 'Pacific/Marquesas': 'MART',
    'Pacific/Nauru': 'NRT', 'Pacific/Niue': 'NUT', 'Pacific/Norfolk': 'NFT', 'Pacific/Noumea': 'NCT',
    'Pacific/Pago_Pago': 'SST', 'Pacific/Palau': 'PWT', 'Pacific/Pitcairn': 'PST', 'Pacific/Port_Moresby': 'PGT',
    'Pacific/Rarotonga': 'CKT', 'Pacific/Tahiti': 'TAHT', 'Pacific/Tarawa': 'GILT', 'Pacific/Tongatapu': 'TOT',
    'Pacific/Wake': 'WAKT', 'Pacific/Wallis': 'WFT', 'UTC': 'UTC', 'Etc/UTC': 'UTC', 'Etc/GMT': 'GMT'
  };
  private readonly offsetAbbreviationFallbacks: Record<string, string> = {
    '+00:00': 'GMT', '+01:00': 'CET', '+02:00': 'EET', '+03:00': 'MSK', '+04:00': 'GST',
    '+05:00': 'PKT', '+05:30': 'IST', '+05:45': 'NPT', '+06:00': 'BST', '+06:30': 'MMT',
    '+07:00': 'ICT', '+08:00': 'CST', '+08:45': 'ACWST', '+09:00': 'JST', '+09:30': 'ACST',
    '+10:00': 'AEST', '+10:30': 'LHST', '+11:00': 'AEDT', '+12:00': 'NZST', '+13:00': 'NZDT',
    '+14:00': 'LINT', '-01:00': 'AZOT', '-02:00': 'GST', '-03:00': 'ART', '-03:30': 'NST',
    '-04:00': 'AST', '-05:00': 'EST', '-06:00': 'CST', '-07:00': 'MST', '-08:00': 'PST',
    '-09:00': 'AKST', '-10:00': 'HST', '-11:00': 'SST', '-12:00': 'AoE'
  };

  private readonly seasonalTimezoneAbbreviationMap: Record<string, SeasonalAbbreviation> = {
    'America/Anchorage': { standard: 'AKST', daylight: 'AKDT' },
    'America/Chicago': { standard: 'CST', daylight: 'CDT' },
    'America/Denver': { standard: 'MST', daylight: 'MDT' },
    'America/Detroit': { standard: 'EST', daylight: 'EDT' },
    'America/Halifax': { standard: 'AST', daylight: 'ADT' },
    'America/Los_Angeles': { standard: 'PST', daylight: 'PDT' },
    'America/New_York': { standard: 'EST', daylight: 'EDT' },
    'America/Santiago': { standard: 'CLT', daylight: 'CLST' },
    'America/St_Johns': { standard: 'NST', daylight: 'NDT' },
    'America/Toronto': { standard: 'EST', daylight: 'EDT' },
    'America/Vancouver': { standard: 'PST', daylight: 'PDT' },
    'America/Winnipeg': { standard: 'CST', daylight: 'CDT' },
    'Atlantic/Azores': { standard: 'AZOT', daylight: 'AZOST' },
    'Atlantic/Bermuda': { standard: 'AST', daylight: 'ADT' },
    'Australia/Adelaide': { standard: 'ACST', daylight: 'ACDT' },
    'Australia/Hobart': { standard: 'AEST', daylight: 'AEDT' },
    'Australia/Melbourne': { standard: 'AEST', daylight: 'AEDT' },
    'Australia/Sydney': { standard: 'AEST', daylight: 'AEDT' },
    'Europe/Athens': { standard: 'EET', daylight: 'EEST' },
    'Europe/Berlin': { standard: 'CET', daylight: 'CEST' },
    'Europe/Brussels': { standard: 'CET', daylight: 'CEST' },
    'Europe/Dublin': { standard: 'GMT', daylight: 'IST' },
    'Europe/Helsinki': { standard: 'EET', daylight: 'EEST' },
    'Europe/Lisbon': { standard: 'WET', daylight: 'WEST' },
    'Europe/London': { standard: 'GMT', daylight: 'BST' },
    'Europe/Madrid': { standard: 'CET', daylight: 'CEST' },
    'Europe/Paris': { standard: 'CET', daylight: 'CEST' },
    'Europe/Prague': { standard: 'CET', daylight: 'CEST' },
    'Europe/Rome': { standard: 'CET', daylight: 'CEST' },
    'Europe/Vienna': { standard: 'CET', daylight: 'CEST' },
    'Europe/Warsaw': { standard: 'CET', daylight: 'CEST' },
    'Europe/Zurich': { standard: 'CET', daylight: 'CEST' },
    'Pacific/Auckland': { standard: 'NZST', daylight: 'NZDT' },
    'Pacific/Chatham': { standard: 'CHAST', daylight: 'CHADT' }
  };

  static getInstance(): NameManager {
    return NameManager.instance ??= new NameManager();
  }

  private getOffsetKey(sign: string, hours: number, minutes: number): string {
    return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }

  private getIntlTimezoneAbbreviation(timezone: string): string | null {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'short'
      }).formatToParts(new Date());

      const abbreviation = parts.find(part => part.type === 'timeZoneName')?.value?.trim();
      if (!abbreviation) return null;
      if (/^GMT[+-]/.test(abbreviation)) return null;
      return abbreviation;
    } catch {
      return null;
    }
  }

  private getOffsetMinutesForDate(timezone: string, date: Date): number | null {
    try {
      const parts = new Intl.DateTimeFormat('en', {
        timeZone: timezone,
        timeZoneName: 'longOffset'
      }).formatToParts(date);

      const offsetPart = parts.find(part => part.type === 'timeZoneName')?.value;
      if (!offsetPart) return null;

      const match = offsetPart.match(/GMT([+-])(\d{2}):(\d{2})/);
      if (!match) return null;

      const sign = match[1] === '+' ? 1 : -1;
      const hours = parseInt(match[2], 10);
      const minutes = parseInt(match[3], 10);
      return sign * (hours * 60 + minutes);
    } catch {
      return null;
    }
  }

  private getSeasonalTimezoneAbbreviation(timezone: string): string | null {
    const abbreviations = this.seasonalTimezoneAbbreviationMap[timezone];
    if (!abbreviations) return null;

    const now = new Date();
    const year = now.getUTCFullYear();
    const januaryOffset = this.getOffsetMinutesForDate(timezone, new Date(Date.UTC(year, 0, 1, 12, 0, 0)));
    const julyOffset = this.getOffsetMinutesForDate(timezone, new Date(Date.UTC(year, 6, 1, 12, 0, 0)));
    const currentOffset = this.getOffsetMinutesForDate(timezone, now);

    if (januaryOffset === null || julyOffset === null || currentOffset === null || januaryOffset === julyOffset) {
      return null;
    }

    const daylightOffset = Math.max(januaryOffset, julyOffset);
    return currentOffset === daylightOffset ? abbreviations.daylight : abbreviations.standard;
  }

  private getTimezoneAbbreviation(timezone: string, sign: string, hours: number, minutes: number): string {
    const intlAbbreviation = this.getIntlTimezoneAbbreviation(timezone);
    if (intlAbbreviation) return intlAbbreviation;

    const seasonalAbbreviation = this.getSeasonalTimezoneAbbreviation(timezone);
    if (seasonalAbbreviation) return seasonalAbbreviation;

    const exact = this.timezoneAbbreviationMap[timezone];
    if (exact) return exact;

    const offsetKey = this.getOffsetKey(sign, hours, minutes);
    return this.offsetAbbreviationFallbacks[offsetKey] || `GMT${offsetKey}`;
  }

  async getCurrentProfile(): Promise<{ firstName: string; lastName: string } | null> {
    if (this.profileCache && Date.now() - this.profileCache.timestamp < this.CACHE_TTL) {
      return this.profileCache.data;
    }
    
    try {
      const client = await getGlobalClient();
      if (!client) return null;

      const me = await client.getMe();
      const profile = { firstName: me.firstName || "", lastName: me.lastName || "" };
      
      this.profileCache = { data: profile, timestamp: Date.now() };
      return profile;
    } catch {
      return null;
    }
  }

  async saveCurrentNickname(userId: number): Promise<boolean> {
    const profile = await this.getCurrentProfile();
    if (!profile) return false;

    const settings: UserSettings = {
      user_id: userId,
      timezone: "Asia/Shanghai",
      original_first_name: this.cleanTimeFromName(profile.firstName),
      original_last_name: this.cleanTimeFromName(profile.lastName) || null,
      is_enabled: false,
      mode: "time",
      last_update: null,
      text_index: 0,
      show_clock_emoji: false,  // 默认关闭时钟emoji
      show_time: true,          // 默认开启时间显示
      show_timezone: false,     // 默认关闭时区显示  
      timezone_format: "GMT",  // 默认时区格式
      display_order: "name,time", // 默认只显示姓名和时间
      weather_enabled: false,
      weather_location: "",
      weather_compact: "",
      weather_cache_ts: 0,
      text_style: "normal"
    };

    return await DataManager.saveUserSettings(settings);
  }

  private readonly cleanTimeRegex = /\b\d{1,2}:\d{2}(\s?(AM|PM))?\b/gi;
  private readonly clockEmojiRegex = /[\u{1F550}-\u{1F567}]/gu;
  
  cleanTimeFromName(name: string): string {
    if (!name) return "";
    return name.substring(0, 128)
      .replace(this.cleanTimeRegex, "")
      .replace(this.clockEmojiRegex, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  formatTime(timezone: string): string {
    try {
      const timeStr = new Date().toLocaleTimeString("zh-CN", {
        timeZone: timezone, hour12: false, hour: "2-digit", minute: "2-digit"
      });
      if (timeStr.startsWith("24:")) {
        return "00:" + timeStr.slice(3);
      }
      return timeStr;
    } catch {
      const now = new Date();
      return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }
  }

  getClockEmoji(timezone: string): string {
    try {
      const hour = parseInt(new Date().toLocaleTimeString("zh-CN", {
        timeZone: timezone, hour12: false, hour: "2-digit"
      }).split(':')[0]);
      const clocks = ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚'];
      return clocks[hour % 12];
    } catch { return '🕐'; }
  }

  private getDoubleStruckUpper(char: string): string {
    const map: Record<string, string> = {
      A: '𝔸', B: '𝔹', C: 'ℂ', D: '𝔻', E: '𝔼', F: '𝔽', G: '𝔾', H: 'ℍ', I: '𝕀', J: '𝕁',
      K: '𝕂', L: '𝕃', M: '𝕄', N: 'ℕ', O: '𝕆', P: 'ℙ', Q: 'ℚ', R: 'ℝ', S: '𝕊', T: '𝕋',
      U: '𝕌', V: '𝕍', W: '𝕎', X: '𝕏', Y: '𝕐', Z: 'ℤ'
    };
    return map[char] || char;
  }

  private stylizeChar(char: string, style: TextStyleMode): string {
    if (style === "normal") return char;

    const code = char.codePointAt(0);
    if (code === undefined) return char;

    if (style === "italic") {
      if (char >= '0' && char <= '9') return String.fromCodePoint(0x1D7CE + (code - 0x30));
      if (char >= 'A' && char <= 'Z') return String.fromCodePoint(0x1D400 + (code - 0x41));
      if (char >= 'a' && char <= 'z') return String.fromCodePoint(0x1D41A + (code - 0x61));
      return char;
    }

    if (style === "double") {
      if (char >= '0' && char <= '9') return String.fromCodePoint(0x1D7D8 + (code - 0x30));
      if (char >= 'A' && char <= 'Z') return this.getDoubleStruckUpper(char);
      if (char >= 'a' && char <= 'z') return String.fromCodePoint(0x1D552 + (code - 0x61));
      return char;
    }

    if (style === "sans") {
      if (char >= '0' && char <= '9') return String.fromCodePoint(0x1D7EC + (code - 0x30));
      if (char >= 'A' && char <= 'Z') return String.fromCodePoint(0x1D5D4 + (code - 0x41));
      if (char >= 'a' && char <= 'z') return String.fromCodePoint(0x1D5EE + (code - 0x61));
      return char;
    }

    if (style === "mono") {
      if (char >= '0' && char <= '9') return String.fromCodePoint(0x1D7F6 + (code - 0x30));
      if (char >= 'A' && char <= 'Z') return String.fromCodePoint(0x1D670 + (code - 0x41));
      if (char >= 'a' && char <= 'z') return String.fromCodePoint(0x1D68A + (code - 0x61));
      return char;
    }

    if (style === "outline") {
      if (char >= '0' && char <= '9') return String.fromCodePoint(0x1D7E2 + (code - 0x30));
      if (char >= 'A' && char <= 'Z') return String.fromCodePoint(0x1D5A0 + (code - 0x41));
      if (char >= 'a' && char <= 'z') return String.fromCodePoint(0x1D5BA + (code - 0x61));
      return char;
    }

    return char;
  }

  applyTextStyle(text: string, style?: TextStyleMode): string {
    const finalStyle = style || "normal";
    if (finalStyle === "normal" || !text) return text;
    return Array.from(text).map(char => this.stylizeChar(char, finalStyle)).join("");
  }

  private async normalizeWeatherLocation(location: string): Promise<string> {
    const normalized = location.trim();
    if (!normalized || !/[\u4e00-\u9fa5]/.test(normalized)) {
      return normalized;
    }

    const quickMap: Record<string, string> = {
      "北京": "Beijing", "上海": "Shanghai", "广州": "Guangzhou", "深圳": "Shenzhen",
      "成都": "Chengdu", "杭州": "Hangzhou", "武汉": "Wuhan", "西安": "Xi'an",
      "重庆": "Chongqing", "南京": "Nanjing", "天津": "Tianjin", "苏州": "Suzhou",
      "香港": "Hong Kong", "澳门": "Macau", "台北": "Taipei", "东京": "Tokyo",
      "首尔": "Seoul", "曼谷": "Bangkok", "新加坡": "Singapore", "伦敦": "London",
      "巴黎": "Paris", "柏林": "Berlin", "纽约": "New York", "洛杉矶": "Los Angeles",
      "旧金山": "San Francisco", "悉尼": "Sydney", "墨尔本": "Melbourne"
    };

    if (quickMap[normalized]) return quickMap[normalized];

    try {
      const translateModule = await import("@vitalets/google-translate-api");
      const translate = translateModule.translate || translateModule.default;
      if (typeof translate !== "function") return normalized;

      const result = await translate(normalized, { to: "en" });
      const translated = typeof result === "string" ? result : result?.text;
      return typeof translated === "string" && translated.trim() ? translated.trim() : normalized;
    } catch {
      return normalized;
    }
  }

  private weatherCodeEmoji(code: number): string {
    const map: Record<number, string> = {
      0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️',
      51: '🌦️', 53: '🌦️', 55: '🌧️', 56: '🌨️', 57: '🌨️',
      61: '🌧️', 63: '🌧️', 65: '🌧️', 66: '🌨️', 67: '🌨️',
      71: '❄️', 73: '❄️', 75: '❄️', 77: '🌨️',
      80: '🌦️', 81: '🌧️', 82: '⛈️', 85: '🌨️', 86: '🌨️', 95: '⛈️', 96: '⛈️', 99: '⛈️'
    };
    return map[code] || '🌤️';
  }

  public async getWeatherCompact(settings: UserSettings): Promise<string> {
    const rawLocation = settings.weather_location?.trim() || "";
    if (!rawLocation) return "";

    const now = Date.now();
    const successTtl = 30 * 60 * 1000;
    const failureTtl = 5 * 60 * 1000;
    const cachedCompact = settings.weather_compact || "";
    const cacheTs = typeof settings.weather_cache_ts === "number" ? settings.weather_cache_ts : 0;
    const cacheAge = cacheTs > 0 ? now - cacheTs : Number.POSITIVE_INFINITY;

    if ((cachedCompact && cacheAge < successTtl) || (!cachedCompact && cacheTs > 0 && cacheAge < failureTtl)) {
      return cachedCompact;
    }

    try {
      const axios = (await import("axios")).default;
      const geocodingName = await this.normalizeWeatherLocation(rawLocation);

      const geoResp = await axios.get<WeatherGeocodingResponse>("https://geocoding-api.open-meteo.com/v1/search", {
        params: { name: geocodingName, count: 5, language: "zh", format: "json" },
        timeout: 10000
      });

      const results = geoResp.data?.results || [];
      if (results.length === 0) throw new Error("城市未找到");

      const loc = results[0];
      const wResp = await axios.get<WeatherForecastResponse>("https://api.open-meteo.com/v1/forecast", {
        params: { latitude: loc.latitude, longitude: loc.longitude, current: "temperature_2m,weather_code", timezone: "auto" },
        timeout: 10000
      });

      const current = wResp.data.current;
      if (!current) throw new Error("天气数据不可用");
      const temp = Math.round(current.temperature_2m);
      const emoji = this.weatherCodeEmoji(current.weather_code);
      const compact = `${emoji} ${temp}°C`;

      settings.weather_compact = compact;
      settings.weather_cache_ts = now;
      await DataManager.saveUserSettings(settings);
      return compact;
    } catch {
      settings.weather_compact = "";
      settings.weather_cache_ts = now;
      try { await DataManager.saveUserSettings(settings); } catch { /* ignore */ }
      return "";
    }
  }

  getTimezoneDisplay(timezone: string, format?: string): string {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' });
      const parts = formatter.formatToParts(now);
      const offsetPart = parts.find(part => part.type === 'timeZoneName');
      
      if (offsetPart && offsetPart.value) {
        const match = offsetPart.value.match(/GMT([+-])(\d{2}):(\d{2})/);
        if (match) {
          const sign = match[1];
          const hours = parseInt(match[2], 10);
          const minutes = parseInt(match[3], 10);
          
          if (format) {
            switch (format) {
              case 'GMT': return minutes > 0 ? `GMT${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `GMT${sign}${hours}`;
              case 'UTC': return minutes > 0 ? `UTC${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `UTC${sign}${hours}`;
              case 'SIMP': return this.getTimezoneAbbreviation(timezone, sign, hours, minutes);
              case 'offset': return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
              default:
                if (format.startsWith('custom:')) return format.substring(7);
                return minutes > 0 ? `GMT${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `GMT${sign}${hours}`;
            }
          }
          
          return minutes > 0 ? `GMT${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `GMT${sign}${hours}`;
        }
      }
      
      const utcNow = new Date();
      const localTime = new Date(utcNow.toLocaleString('en-US', { timeZone: timezone }));
      const utcTime = new Date(utcNow.toLocaleString('en-US', { timeZone: 'UTC' }));
      const offsetMs = localTime.getTime() - utcTime.getTime();
      const totalMinutes = Math.round(offsetMs / (1000 * 60));
      const offsetHours = Math.floor(Math.abs(totalMinutes) / 60);
      const offsetMinutes = Math.abs(totalMinutes) % 60;
      const sign = totalMinutes >= 0 ? '+' : '-';
      
      if (offsetMinutes > 0) {
        return `GMT${sign}${offsetHours.toString().padStart(2, '0')}:${offsetMinutes.toString().padStart(2, '0')}`;
      } else {
        return `GMT${sign}${offsetHours}`;
      }
      
    } catch (error) {
      console.error('[AutoChangeName] 时区计算失败:', error);
      return 'GMT+8';
    }
  }

  private getEnabledComponents(settings: UserSettings): string[] {
    const base: string[] = [];
    
    // 根据 mode 决定基础组件，但受 show_time 控制
    if (settings.mode === "time") {
      if (settings.show_time !== false) base.push("time");
    } else if (settings.mode === "text") {
      base.push("text");
    } else if (settings.mode === "both") {
      base.push("text");
      if (settings.show_time !== false) base.push("time");
    }

    // 确保独立的开关状态同步到 enabledComponents 中，防止在后续流程被意外过滤掉
    if (settings.show_clock_emoji && !base.includes("emoji")) base.push("emoji");
    if (settings.show_timezone && !base.includes("timezone")) base.push("timezone");
    if (settings.weather_enabled && !base.includes("weather")) base.push("weather");

    return base;
  }

  async generateNewName(settings: UserSettings): Promise<{ firstName: string; lastName: string | null }> {
    const cleanFirstName = settings.original_first_name || "";
    const cleanLastName = settings.original_last_name;
    const currentTime = this.formatTime(settings.timezone);
    
    const components: { [key: string]: string } = {
      name: cleanFirstName,
      time: currentTime,
      text: '',
      emoji: settings.show_clock_emoji ? this.getClockEmoji(settings.timezone) : '',
      timezone: settings.show_timezone ? this.getTimezoneDisplay(settings.timezone, settings.timezone_format) : '',
      weather: ''
    };

    if (settings.mode === "text" || settings.mode === "both") {
      const texts = await DataManager.getRandomTexts();
      if (texts.length > 0) {
        components.text = texts[settings.text_index % texts.length];
      }
    }

    if (settings.weather_enabled && settings.weather_location) {
      components.weather = await this.getWeatherCompact(settings);
    }

    const enabledComponents = this.getEnabledComponents(settings);
    
    let displayOrder: string[];
    if (settings.display_order) {
      displayOrder = settings.display_order.split(',').map(s => s.trim());
      
      if (settings.show_timezone && !displayOrder.includes('timezone')) {
        const timeIndex = displayOrder.indexOf('time');
        if (timeIndex !== -1) displayOrder.splice(timeIndex + 1, 0, 'timezone');
        else displayOrder.push('timezone');
      }
      
      if (settings.show_clock_emoji && !displayOrder.includes('emoji')) {
        displayOrder.push('emoji');
      }

      if (settings.weather_enabled && settings.weather_location && !displayOrder.includes('weather')) {
        const timezoneIndex = displayOrder.indexOf('timezone');
        const timeIndex = displayOrder.indexOf('time');
        if (timezoneIndex !== -1) displayOrder.splice(timezoneIndex + 1, 0, 'weather');
        else if (timeIndex !== -1) displayOrder.splice(timeIndex + 1, 0, 'weather');
        else displayOrder.push('weather');
      }
      
      displayOrder = ["name", ...displayOrder.filter(comp => enabledComponents.includes(comp))];
    } else {
      displayOrder = ["name", ...enabledComponents];
    }

    const finalParts = displayOrder
      .map((comp: string) => {
        const value = components[comp];
        if (!value || value.length === 0) return "";
        return comp === 'name' ? value : this.applyTextStyle(value, settings.text_style || "normal");
      })
      .filter((part: string) => part && part.length > 0);
    
    return {
      firstName: finalParts.join(' ') || cleanFirstName,
      lastName: cleanLastName
    };
  }

  async updateUserProfile(userId: number, forceUpdate: boolean = false): Promise<boolean> {
    try {
      const client = await getGlobalClient();
      if (!client) return false;

      const settings = await DataManager.getUserSettings(userId);
      if (!settings) return false;
      
      if (!forceUpdate && !settings.is_enabled) return false;

      if (!forceUpdate && settings.last_update) {
        const timeDiff = new Date().getTime() - new Date(settings.last_update).getTime();
        if (timeDiff < 30000) return false;
      }

      const newName = await this.generateNewName(settings);
      
      if (newName.firstName.length > 64) newName.firstName = newName.firstName.substring(0, 64);
      if (newName.lastName && newName.lastName.length > 64) newName.lastName = newName.lastName.substring(0, 64);

      await client.invoke(
        new Api.account.UpdateProfile({
          firstName: newName.firstName,
          lastName: newName.lastName || undefined
        })
      );

      if (settings.mode !== "time") {
        const texts = await DataManager.getRandomTexts();
        if (texts.length > 0) {
          settings.text_index = (settings.text_index + 1) % texts.length;
        }
      }

      settings.last_update = new Date().toISOString();
      await DataManager.saveUserSettings(settings);
      return true;
    } catch (error: any) {
      if (error.message?.includes("FLOOD_WAIT")) {
        const settings = await DataManager.getUserSettings(userId);
        if (settings && settings.is_enabled) {
          settings.is_enabled = false;
          await DataManager.saveUserSettings(settings);
        }
      } else if (error.message?.includes("USERNAME_NOT_MODIFIED")) {
        return true;
      }
      return false;
    }
  }

  startAutoUpdate(): void {
    try {
      if (cronManager.has(this.TASK_NAME)) cronManager.del(this.TASK_NAME);

      cronManager.set(this.TASK_NAME, "0 * * * * *", async () => {
        if (this.isUpdating) return;
        this.isUpdating = true;
        try {
          const enabledUsers = await DataManager.getAllEnabledUsers();
          if (enabledUsers.length === 0) return;
          
          const updatePromises = enabledUsers.map(userId => 
            this.updateUserProfile(userId).catch(() => false)
          );
          await Promise.allSettled(updatePromises);
        } finally {
          this.isUpdating = false;
        }
      });
    } catch (error) {
      console.error("[AutoChangeName] 启动自动更新失败:", error);
    }
  }

  stopAutoUpdate(): void {
    if (cronManager.has(this.TASK_NAME)) {
      cronManager.del(this.TASK_NAME);
    }
  }
  
  cleanup(): void {
    this.stopAutoUpdate();
    this.profileCache = null;
    this.isUpdating = false;
  }

  isSchedulerRunning(): boolean {
    return cronManager.has(this.TASK_NAME);
  }
}

const nameManager = NameManager.getInstance();

async function requireSettings(userId: number, msg: Api.Message): Promise<UserSettings | null> {
  const settings = await DataManager.getUserSettings(userId);
  if (!settings) {
    await msg.edit({
      text: `❌ 请先使用 <code>${mainPrefix}acn save</code> 保存昵称`,
      parseMode: "html"
    });
    return null;
  }
  return settings;
}

class AutoChangeNamePlugin extends Plugin {
  cleanup(): void {
    nameManager.cleanup();
  }

  description: string = help_text;

  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    acn: async (msg: Api.Message, trigger?: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();

      try {
        let userId: number | null = null;
        
        if (msg.fromId && msg.fromId.className === 'PeerChannel') {
          await msg.edit({
            text: `⚠️ <b>不支持在频道中使用此命令</b>\n\n请在私聊中发送命令来管理动态昵称。`,
            parseMode: "html"
          });
          return;
        }
        
        if (msg.senderId) {
          userId = Number(msg.senderId.toString());
        } else if (msg.fromId && msg.fromId.className === 'PeerUser') {
          userId = Number(msg.fromId.userId.toString());
        }
        
        if (!userId || isNaN(userId)) {
          await msg.edit({ text: `❌ <b>无法识别您的身份</b>\n\n请确保在私聊中使用此命令。`, parseMode: "html" });
          return;
        }

        if (!sub || sub === "help" || sub === "h") {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        const settings = await DataManager.getUserSettings(userId);
        const isFirstTime = !settings;
        const needsSave = !settings?.original_first_name;
        
        if (isFirstTime && !["save", "help", "h", "status"].includes(sub)) {
          await msg.edit({
            text: `⚠️ <b>请先保存昵称</b>\n\n您还没有保存过昵称。\n\n请先执行 <code>${mainPrefix}acn save</code> 保存您的当前昵称。`,
            parseMode: "html"
          });
          return;
        }
        
        if (needsSave && !isFirstTime && !["save", "help", "h", "status", "reset"].includes(sub)) {
          await msg.edit({
            text: `⚠️ <b>配置不完整</b>\n\n请先执行 <code>${mainPrefix}acn save</code> 保存您的当前"干净"昵称。`,
            parseMode: "html"
          });
          return;
        }

        switch (sub) {
          case "save": await this.handleSave(msg, userId); break;
          case "on": case "enable": await this.handleToggle(msg, userId, true); break;
          case "off": case "disable": await this.handleToggle(msg, userId, false); break;
          case "mode": await this.handleMode(msg, userId); break;
          case "status": await this.handleStatus(msg); break;
          case "text": await this.handleText(msg, args.slice(1)); break;
          case "tz": case "timezone": await this.handleTimezone(msg, userId, args.slice(1)); break;
          case "update": case "now": await this.handleUpdate(msg, userId); break;
          case "reset": await this.handleReset(msg, userId); break;
          case "emoji": await this.handleEmojiToggle(msg, userId, args.slice(1)); break;
          case "order": await this.handleDisplayOrder(msg, userId, args.slice(1)); break;
          case "config": await this.handleShowConfig(msg, userId); break;
          case "weather": await this.handleWeather(msg, userId, args.slice(1)); break;
          case "style": await this.handleTextStyle(msg, userId, args.slice(1)); break;
          case "time": await this.handleTimeToggle(msg, userId, args.slice(1)); break;
          default:
            await msg.edit({
              text: `❌ <b>未知命令</b>\n\n未知的子命令: <code>${htmlEscape(sub)}</code>\n\n输入 <code>${mainPrefix}acn</code> 查看帮助。`,
              parseMode: "html"
            });
        }

      } catch (error: any) {
        if (error.message?.includes("FLOOD_WAIT")) {
          const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
          await msg.edit({ text: `⏳ <b>请求过于频繁</b>\n\n需要等待 ${waitTime} 秒后重试`, parseMode: "html" });
        } else if (!error.message?.includes("MESSAGE_ID_INVALID")) {
          const safeErrorMsg = (error.message || "未知错误").substring(0, 100);
          await msg.edit({ text: `❌ <b>操作失败:</b> ${htmlEscape(safeErrorMsg)}`, parseMode: "html" });
        }
      }
    },
    autochangename: async (msg: Api.Message, trigger?: Api.Message) => this.cmdHandlers.acn(msg, trigger)
  };

  private async handleSave(msg: Api.Message, userId: number): Promise<void> {
    await msg.edit({ text: "⏳ 正在保存当前昵称...", parseMode: "html" });
    const success = await nameManager.saveCurrentNickname(userId);
    if (success) {
      const settings = await DataManager.getUserSettings(userId);
      if (settings && !settings.last_update) {
        await msg.edit({
          text: `🎉 <b>昵称保存成功！</b>\n\n<b>✅ 已保存的原始昵称：</b>\n• 姓名: <code>${htmlEscape(settings.original_first_name || "")}</code>\n• 姓氏: <code>${htmlEscape(settings.original_last_name || "(空)")}</code>\n\n<b>🚀 接下来您可以：</b>\n<code>${mainPrefix}acn on/off</code> - 开启或关闭自动昵称更新`,
          parseMode: "html"
        });
      } else if (settings) {
        await msg.edit({
          text: `✅ <b>昵称已重新保存</b>\n\n<b>姓名:</b> <code>${htmlEscape(settings.original_first_name || "")}</code>\n<b>姓氏:</b> <code>${htmlEscape(settings.original_last_name || "(空)")}</code>`,
          parseMode: "html"
        });
      }
    } else {
      await msg.edit({ text: "❌ 保存失败，请稍后重试", parseMode: "html" });
    }
  }

  private async handleToggle(msg: Api.Message, userId: number, enable: boolean): Promise<void> {
    await msg.edit({ text: "⏳ 正在处理...", parseMode: "html" });
    let settings = await DataManager.getUserSettings(userId);
    
    if (!settings || (!settings.original_first_name && enable)) {
      await msg.edit({ text: `❌ <b>未保存原始昵称</b>\n请先执行：<code>${mainPrefix}acn save</code>`, parseMode: "html" });
      return;
    }

    settings.is_enabled = enable;
    if (await DataManager.saveUserSettings(settings)) {
      if (enable) {
        if (!nameManager.isSchedulerRunning()) nameManager.startAutoUpdate();
        await nameManager.updateUserProfile(userId, true);
        await msg.edit({ text: `✅ <b>动态昵称已启用</b>\n\n🕐 当前时区: <code>${settings.timezone}</code>\n📝 显示模式: <code>${settings.mode}</code>\n⏰ 更新频率: 每分钟`, parseMode: "html" });
      } else {
        await msg.edit({ text: `✅ <b>动态昵称已禁用</b>`, parseMode: "html" });
      }
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  private async handleMode(msg: Api.Message, userId: number): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    if (settings.mode === "time") settings.mode = "text";
    else if (settings.mode === "text") settings.mode = "both";
    else settings.mode = "time";

    await DataManager.saveUserSettings(settings);
    if (settings.is_enabled) await nameManager.updateUserProfile(userId, true);

    await msg.edit({
      text: `✅ <b>显示模式已切换</b>\n\n📝 当前模式: <code>${settings.mode}</code>\n\n• <code>time</code> - 昵称+时间\n• <code>text</code> - 昵称+文案\n• <code>both</code> - 昵称+文案+时间`,
      parseMode: "html"
    });
  }

  private async handleShow(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const action = (args[0] || "").toLowerCase();
    const target = (args[1] || "").toLowerCase();

    const defaultByMode: Record<string, string[]> = {
      time: ["time"], text: ["text", "time"], both: ["text", "time"]
    };

    if (!action || action === "help" || action === "h") {
      const current = settings.displayComponents || defaultByMode[settings.mode] || ["time"];
      const statusLines = [
        `• <code>time</code> ${current.includes("time") ? "✅ 开启" : "❌ 关闭"}`,
        `• <code>text</code> ${current.includes("text") ? "✅ 开启" : "❌ 关闭"}`,
        `• <code>weather</code> ${settings.weather_enabled ? "✅ 开启" : "❌ 关闭"}`,
        `• <code>emoji</code> ${settings.show_clock_emoji ? "✅ 开启" : "❌ 关闭"}`,
        `• <code>timezone</code> ${settings.show_timezone ? "✅ 开启" : "❌ 关闭"}`,
      ];

      await msg.edit({
        text: `🎛️ <b>显示组件管理</b>\n\n当前组件: <code>${current.join(", ")}</code>\n\n<b>组件状态：</b>\n${statusLines.join("\n")}\n\n<b>使用说明：</b>\n• <code>${mainPrefix}acn show time on/off</code> — 显示或隐藏时间\n• <code>${mainPrefix}acn show text on/off</code> — 显示或隐藏文案\n• <code>${mainPrefix}acn show weather on/off</code> — 显示或隐藏天气\n• <code>${mainPrefix}acn show reset</code> — 重置为模式默认值\n\n⚠ emoji 和 timezone 请使用专属命令管理`,
        parseMode: "html"
      });
      return;
    }

    if (action === "reset") {
      settings.displayComponents = defaultByMode[settings.mode] || ["time"];
      if (await DataManager.saveUserSettings(settings)) {
        if (settings.is_enabled) await nameManager.updateUserProfile(userId, true);
        await msg.edit({ text: `✅ <b>已重置为默认值</b>\n\n当前模式默认组件: <code>${settings.displayComponents.join(", ")}</code>`, parseMode: "html" });
      } else {
        await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
      }
      return;
    }

    const toggleableComponents = ["time", "text", "weather"] as const;
    if (!toggleableComponents.includes(action as any)) {
      await msg.edit({
        text: `❌ <b>acn show 仅支持管理 time/text/weather</b>\n\nemoji 请使用：\n• <code>${mainPrefix}acn emoji on/off</code>`,
        parseMode: "html"
      });
      return;
    }

    if (target !== "on" && target !== "off") {
      await msg.edit({ text: `❌ <b>请指定 on 或 off</b>\n使用: <code>${mainPrefix}acn show ${action} on/off</code>`, parseMode: "html" });
      return;
    }

    if (action === "weather") {
        if (target === "on" && !settings.weather_location?.trim()) {
            await msg.edit({ text: `❌ <b>请先设置天气地点</b>\n使用 <code>${mainPrefix}acn weather set 北京</code>`, parseMode: "html" });
            return;
        }
        settings.weather_enabled = (target === "on");
    }

    const current = settings.displayComponents ? [...settings.displayComponents] : [...(defaultByMode[settings.mode] || ["time"])];
    
    if (target === "on") {
      if (!current.includes(action)) current.push(action);
    } else {
      const idx = current.indexOf(action);
      if (idx !== -1) current.splice(idx, 1);
    }
    
    settings.displayComponents = current;

    if (await DataManager.saveUserSettings(settings)) {
      if (settings.is_enabled) await nameManager.updateUserProfile(userId, true);
      await msg.edit({ text: `✅ <b>组件已${target === "on" ? "开启" : "关闭"}</b>\n\n<code>${action}</code> ${target === "on" ? "已启用" : "已禁用"}\n当前组件: <code>${settings.displayComponents.join(", ")}</code>`, parseMode: "html" });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  private async handleStatus(msg: Api.Message): Promise<void> {
    const enabledUsers = await DataManager.getAllEnabledUsers();
    await msg.edit({
      text: `📊 <b>动态昵称状态</b>\n\n🔄 自动更新: <code>${nameManager.isSchedulerRunning() ? "运行中" : "已停止"}</code>\n👥 启用用户: <code>${enabledUsers.length}</code>`,
      parseMode: "html"
    });
  }

  private async handleText(msg: Api.Message, args: string[]): Promise<void> {
    const action = args[0] || "";
    const texts = await DataManager.getRandomTexts();

    if (action === "add") {
      // Extract text after "acn text add" - join remaining args
      const inputText = args.slice(1).join(" ").trim();
      
      if (!inputText) return void await msg.edit({ text: "❌ 请提供要添加的文本内容", parseMode: "html" });
      
      const lines = inputText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
      const validLines: string[] = [];
      const duplicateLines: string[] = [];
      const invalidLines: string[] = [];
      
      for (const line of lines) {
        if (line.length > 50) invalidLines.push(line);
        else if (texts.includes(line) || validLines.includes(line)) duplicateLines.push(line);
        else validLines.push(line);
      }
      
      texts.push(...validLines);
      if (await DataManager.saveRandomTexts(texts)) {
        let res = `✅ <b>文本添加结果</b>\n\n`;
        if (validLines.length > 0) res += `✅ 成功添加 ${validLines.length} 条\n`;
        if (duplicateLines.length > 0) res += `⚠️ 跳过 ${duplicateLines.length} 条重复\n`;
        if (invalidLines.length > 0) res += `❌ 跳过 ${invalidLines.length} 条超长\n`;
        await msg.edit({ text: res + `\n📊 当前总数: ${texts.length}`, parseMode: "html" });
      } else {
        await msg.edit({ text: "❌ 添加失败", parseMode: "html" });
      }
    } else if (action === "del" && args.length > 1) {
      const index = parseInt(args[1]) - 1;
      if (index >= 0 && index < texts.length) {
        texts.splice(index, 1);
        if (await DataManager.saveRandomTexts(texts)) {
          await msg.edit({ text: `✅ <b>文本已删除</b>\n📊 剩余数量: ${texts.length}`, parseMode: "html" });
        } else await msg.edit({ text: "❌ 删除失败", parseMode: "html" });
      } else await msg.edit({ text: "❌ 无效的索引号", parseMode: "html" });
    } else if (action === "list") {
      if (texts.length === 0) await msg.edit({ text: `📝 <b>无随机文本</b>\n使用 <code>${mainPrefix}acn text add 文本</code> 添加`, parseMode: "html" });
      else await msg.edit({ text: `📝 <b>随机文本列表</b>\n\n${texts.map((t, i) => `${i + 1}. ${htmlEscape(t)}`).join("\n")}\n\n📊 总数量: ${texts.length}`, parseMode: "html" });
    } else if (action === "clear") {
      if (await DataManager.saveRandomTexts([])) await msg.edit({ text: "✅ 所有文本已清空", parseMode: "html" });
    } else {
      await msg.edit({ text: `❌ <b>命令格式错误</b>\n请使用 add, del, list, clear`, parseMode: "html" });
    }
  }

  private async handleTimezone(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    if (args.length === 0) {
      await msg.edit({ text: `🌍 <b>时区管理</b>

• <code>${mainPrefix}acn tz Asia/Shanghai</code> - 设置时区
• <code>${mainPrefix}acn tz list</code> - 时区列表
• <code>${mainPrefix}acn tz on/off</code> - 显示控制
• <code>${mainPrefix}acn tz format GMT</code> - 格式设置`, parseMode: "html" });
      return;
    }
    const sub = (args[0] || "").toLowerCase();
    if (sub === "list") return void await msg.edit({ text: `🌍 <b>常用时区列表</b>

Asia/Shanghai
Asia/Tokyo
Europe/London
America/New_York

使用 <code>${mainPrefix}acn tz ＜时区＞</code> 设置`, parseMode: "html" });
    if (sub === "on" || sub === "off") {
      const settings = await requireSettings(userId, msg);
      if (!settings) return;
      settings.show_timezone = (sub === "on");
      if (await DataManager.saveUserSettings(settings)) {
        if (settings.is_enabled) await nameManager.updateUserProfile(userId, true);
        await msg.edit({ text: `✅ <b>时区显示已${sub === "on" ? "开启" : "关闭"}</b>`, parseMode: "html" });
      } else {
        await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
      }
      return;
    }
    if (sub === "format") return this.handleTimezoneFormat(msg, userId, args.slice(1));

    const newTimezone = (sub === "set" ? args.slice(1) : args).join(" ").trim();
    try { new Date().toLocaleString("en-US", { timeZone: newTimezone }); } catch {
      return void await msg.edit({ text: `❌ <b>无效的时区标识符</b>`, parseMode: "html" });
    }

    const settings = await requireSettings(userId, msg);
    if (!settings) return;
    settings.timezone = newTimezone;
    if (await DataManager.saveUserSettings(settings)) {
      if (settings.is_enabled) await nameManager.updateUserProfile(userId, true);
      await msg.edit({ text: `✅ <b>时区已更新为:</b> <code>${newTimezone}</code>`, parseMode: "html" });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  private async handleUpdate(msg: Api.Message, userId: number): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings || !settings.original_first_name) return void await msg.edit({ text: `❌ 请先 <code>${mainPrefix}acn save</code>`, parseMode: "html" });
    
    if (await nameManager.updateUserProfile(userId, true)) {
      await msg.edit({ text: `✅ <b>昵称已手动更新</b>`, parseMode: "html" });
    } else {
      await msg.edit({ text: "❌ 更新失败", parseMode: "html" });
    }
  }

  private async handleEmojiToggle(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    await this.handleToggleSetting(msg, userId, args, {
      key: "show_clock_emoji",
      settingName: "时钟Emoji",
      command: "emoji"
    });
  }

  private async handleTimeToggle(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    await this.handleToggleSetting(msg, userId, args, {
      key: "show_time",
      settingName: "时间显示",
      command: "time",
      defaultOn: true
    });
  }

  private async handleTimezoneFormat(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const format = args[0]?.toLowerCase();
    if (!format) {
      return void await msg.edit({ text: `🌐 <b>时区格式设置</b>\n当前: <code>${settings.timezone_format || 'GMT'}</code>\n可用: GMT, UTC, simp, offset, custom:文本`, parseMode: "html" });
    }

    settings.timezone_format = format.startsWith('custom:') ? args.join(' ') : format.toUpperCase();
    if (await DataManager.saveUserSettings(settings)) {
      if (settings.is_enabled) await nameManager.updateUserProfile(userId, true);
      await msg.edit({ text: `✅ <b>时区格式已更新为:</b> <code>${htmlEscape(settings.timezone_format)}</code>`, parseMode: "html" });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  private async handleToggleSetting(
    msg: Api.Message, 
    userId: number, 
    args: string[], 
    options: {
      key: keyof UserSettings;
      settingName: string;
      command: string;
      defaultOn?: boolean;
    }
  ): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const action = args[0]?.toLowerCase();
    if (action === "on" || action === "off") {
      (settings as any)[options.key] = action === "on";
      if (await DataManager.saveUserSettings(settings)) {
        if (settings.is_enabled) await nameManager.updateUserProfile(userId, true);
        await msg.edit({ text: `<b>${options.settingName}已${action === "on" ? "开启" : "关闭"}</b>`, parseMode: "html" });
      } else {
        await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
      }
    } else {
      const isOn = options.defaultOn 
        ? (settings as any)[options.key] !== false 
        : (settings as any)[options.key] === true;
      await msg.edit({ text: `<b>${options.settingName}</b>\n当前: <code>${isOn ? "开启" : "关闭"}</code>\n使用 <code>${mainPrefix}acn ${options.command} on/off</code> 切换`, parseMode: "html" });
    }
  }

  private async handleTextStyle(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const styleArg = (args[0] || "").toLowerCase();
    const validStyles: Record<string, TextStyleMode> = {
      normal: "normal", italic: "italic", double: "double",
      sans: "sans", mono: "mono", outline: "outline"
    };

    if (!validStyles[styleArg]) {
      return void await msg.edit({ text: `🎨 <b>文字样式</b>\n可用: normal, italic, double, sans, mono, outline`, parseMode: "html" });
    }

    settings.text_style = validStyles[styleArg];
    if (await DataManager.saveUserSettings(settings)) {
      if (settings.is_enabled) await nameManager.updateUserProfile(userId, true);
      await msg.edit({ text: `✅ <b>文字样式已更新为:</b> <code>${settings.text_style}</code>`, parseMode: "html" });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  private async handleWeather(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const arg0 = (args[0] || "").toLowerCase();
    if (!arg0 || arg0 === "help") {
      const prev = await nameManager.getWeatherCompact(settings);
      return void await msg.edit({ text: `🌤️ <b>天气配置</b>\n开关: <code>${settings.weather_enabled ? "开" : "关"}</code>\n地点: <code>${settings.weather_location || "未设置"}</code>\n预览: <code>${prev}</code>`, parseMode: "html" });
    }

    if (arg0 === "on" || arg0 === "off") {
      if (arg0 === "on" && !settings.weather_location) return void await msg.edit({ text: `❌ 请先设置地点: <code>${mainPrefix}acn weather set 北京</code>`, parseMode: "html" });
      settings.weather_enabled = (arg0 === "on");
    } else {
      settings.weather_location = (arg0 === "set" ? args.slice(1) : args).join(" ").trim();
      settings.weather_enabled = true;
      settings.weather_compact = "";
      settings.weather_cache_ts = 0;
    }

    if (await DataManager.saveUserSettings(settings)) {
      if (settings.is_enabled) await nameManager.updateUserProfile(userId, true);
      await msg.edit({ text: `✅ <b>天气配置已更新</b>`, parseMode: "html" });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  private async handleDisplayOrder(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    if (args.length === 0) {
      return void await msg.edit({ text: `📋 <b>当前显示顺序</b>\n<code>${settings.display_order || "默认"}</code>\n使用 <code>${mainPrefix}acn order name,time,text...</code> 调整`, parseMode: "html" });
    }

    const newOrder = args.join("").toLowerCase();
    const valid = ["name", "text", "time", "weather", "emoji", "timezone"];
    const invalid = newOrder.split(",").map(s => s.trim()).filter(c => !valid.includes(c));
    
    if (invalid.length > 0) return void await msg.edit({ text: `❌ 无效组件: <code>${invalid.join(", ")}</code>`, parseMode: "html" });

    settings.display_order = newOrder;
    if (await DataManager.saveUserSettings(settings)) {
      if (settings.is_enabled) await nameManager.updateUserProfile(userId, true);
      await msg.edit({ text: `✅ <b>显示顺序已更新为:</b>\n<code>${newOrder}</code>`, parseMode: "html" });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  private async handleShowConfig(msg: Api.Message, userId: number): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const texts = await DataManager.getRandomTexts();
    const configText = `🔧 <b>您的配置状态</b>
自动更新: <code>${settings.is_enabled ? "开" : "关"}</code>
模式: <code>${settings.mode}</code>
时区: <code>${settings.timezone}</code>
样式: <code>${settings.text_style || "normal"}</code>
文案数: <code>${texts.length}</code>
姓名: <code>${htmlEscape(settings.original_first_name || "")} ${htmlEscape(settings.original_last_name || "")}</code>`;
    await msg.edit({ text: configText, parseMode: "html" });
  }

  private async handleReset(msg: Api.Message, userId: number): Promise<void> {
    const settings = await DataManager.getUserSettings(userId);
    if (!settings) return void await msg.edit({ text: "❌ 未找到设置", parseMode: "html" });

    try {
      const client = await getGlobalClient();
      if (client) await client.invoke(new Api.account.UpdateProfile({ firstName: settings.original_first_name || "", lastName: settings.original_last_name || undefined }));
      settings.is_enabled = false;
      await DataManager.saveUserSettings(settings);
      await msg.edit({ text: "✅ <b>已恢复原始昵称并禁用自动更新</b>", parseMode: "html" });
    } catch {
      await msg.edit({ text: "❌ 重置失败", parseMode: "html" });
    }
  }

  async init(): Promise<void> {
    try {
      const enabledUsers = await DataManager.getAllEnabledUsers();
      for (const userId of enabledUsers) {
        const settings = await DataManager.getUserSettings(userId);
        if (settings && !settings.original_first_name) {
          settings.is_enabled = false;
          await DataManager.saveUserSettings(settings);
        }
      }
      if (enabledUsers.length > 0) nameManager.startAutoUpdate();
    } catch (e) {
      console.error("[AutoChangeName] 初始化失败:", e);
    }
  }

  destroy(): void {
    nameManager.cleanup();
  }
}

const plugin = new AutoChangeNamePlugin();

if (process.env.TELEBOX_AUTO_INIT !== 'false') {
  (async () => { try { await plugin.init(); } catch (e) {} })();
}

export const __test__ = {
  htmlEscape,
  cleanTimeFromName: nameManager.cleanTimeFromName.bind(nameManager),
  formatTime: nameManager.formatTime.bind(nameManager),
  getClockEmoji: nameManager.getClockEmoji.bind(nameManager),
  getTimezoneDisplay: nameManager.getTimezoneDisplay.bind(nameManager),
  applyTextStyle: nameManager.applyTextStyle.bind(nameManager),
  generateNewName: nameManager.generateNewName.bind(nameManager)
};

export default plugin;

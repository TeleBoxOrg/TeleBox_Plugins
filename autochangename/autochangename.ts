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
• <code>${mainPrefix}acn tz show on</code> / <code>off</code>
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
  等同于 <code>${mainPrefix}acn tz</code>（旧命令）
• <code>${mainPrefix}acn showtz on/off</code>
  等同于 <code>${mainPrefix}acn tz show on/off</code>（旧命令）
• <code>${mainPrefix}acn tzformat GMT</code>
  等同于 <code>${mainPrefix}acn tz format GMT</code>（旧命令）</blockquote>
<b>🎨 外观设置：</b>
<blockquote expandable>• <code>${mainPrefix}acn emoji on</code> / <code>off</code>
  开启或关闭时钟 emoji（🕐🕑🕒...）
  时钟 emoji 会根据当前小时自动匹配对应的钟面
• <code>${mainPrefix}acn show</code>
  查看或管理昵称中的显示组件（时间/文案/天气等）
  可用组件：time（时间）、text（文案）、weather（天气）、emoji（表情）、timezone（时区）
  ⚠这和控件是否打开无关，例如weather处于off状态时反复使用<code>${mainPrefix}acn show weather on</code>是无用的
• <code>${mainPrefix}acn show time on/off</code>
  开启或关闭时间显示
• <code>${mainPrefix}acn show text on/off</code>
  开启或关闭随机文案显示
• <code>${mainPrefix}acn show weather on/off</code>
  开启或关闭天气显示
• <code>${mainPrefix}acn show reset</code>
  重置显示组件为当前模式的默认值
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
  show_timezone?: boolean;
  display_order?: string;
  timezone_format?: string;  // 自定义时区格式："GMT" | "UTC" | "SIMP" | "offset" | "custom:xxx"
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
  private static db: any = null;
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
    return this.db?.data.users[userId.toString()] || null;
  }

  static async saveUserSettings(settings: UserSettings): Promise<boolean> {
    if (!settings?.user_id) return false;
    await this.init();
    try {
      this.db.data.users[settings.user_id.toString()] = { ...settings };
      await this.db.write();
      return true;
    } catch { return false; }
  }

  static async getRandomTexts(): Promise<string[]> {
    await this.init();
    return this.db?.data.random_texts || [];
  }

  static async saveRandomTexts(texts: string[]): Promise<boolean> {
    await this.init();
    try {
      this.db.data.random_texts = texts.slice(0, 100)
        .filter(t => t && typeof t === 'string')
        .map(t => t.trim())
        .filter(t => t.length > 0 && t.length <= 50);
      await this.db.write();
      return true;
    } catch { return false; }
  }

  static async getAllEnabledUsers(): Promise<number[]> {
    await this.init();
    const users = this.db?.data.users || {};
    return Object.keys(users)
      .filter(key => users[key].is_enabled)
      .map(key => parseInt(key));
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
    'Africa/Abidjan': 'GMT',
    'Africa/Accra': 'GMT',
    'Africa/Addis_Ababa': 'EAT',
    'Africa/Algiers': 'CET',
    'Africa/Asmara': 'EAT',
    'Africa/Bamako': 'GMT',
    'Africa/Bangui': 'WAT',
    'Africa/Banjul': 'GMT',
    'Africa/Bissau': 'GMT',
    'Africa/Blantyre': 'CAT',
    'Africa/Brazzaville': 'WAT',
    'Africa/Cairo': 'EET',
    'Africa/Casablanca': 'WET',
    'Africa/Ceuta': 'CET',
    'Africa/Dakar': 'GMT',
    'Africa/Dar_es_Salaam': 'EAT',
    'Africa/Djibouti': 'EAT',
    'Africa/Douala': 'WAT',
    'Africa/El_Aaiun': 'WET',
    'Africa/Freetown': 'GMT',
    'Africa/Gaborone': 'CAT',
    'Africa/Harare': 'CAT',
    'Africa/Johannesburg': 'SAST',
    'Africa/Juba': 'CAT',
    'Africa/Kampala': 'EAT',
    'Africa/Khartoum': 'CAT',
    'Africa/Kigali': 'CAT',
    'Africa/Kinshasa': 'WAT',
    'Africa/Lagos': 'WAT',
    'Africa/Libreville': 'WAT',
    'Africa/Lome': 'GMT',
    'Africa/Luanda': 'WAT',
    'Africa/Lubumbashi': 'CAT',
    'Africa/Lusaka': 'CAT',
    'Africa/Malabo': 'WAT',
    'Africa/Maputo': 'CAT',
    'Africa/Maseru': 'SAST',
    'Africa/Mbabane': 'SAST',
    'Africa/Mogadishu': 'EAT',
    'Africa/Monrovia': 'GMT',
    'Africa/Nairobi': 'EAT',
    'Africa/Ndjamena': 'WAT',
    'Africa/Niamey': 'WAT',
    'Africa/Nouakchott': 'GMT',
    'Africa/Ouagadougou': 'GMT',
    'Africa/Porto-Novo': 'WAT',
    'Africa/Sao_Tome': 'GMT',
    'Africa/Tripoli': 'EET',
    'Africa/Tunis': 'CET',
    'Africa/Windhoek': 'CAT',
    'America/Adak': 'HST',
    'America/Anchorage': 'AKST',
    'America/Anguilla': 'AST',
    'America/Antigua': 'AST',
    'America/Araguaina': 'BRT',
    'America/Argentina/Buenos_Aires': 'ART',
    'America/Argentina/Catamarca': 'ART',
    'America/Argentina/Cordoba': 'ART',
    'America/Argentina/Mendoza': 'ART',
    'America/Aruba': 'AST',
    'America/Asuncion': 'PYT',
    'America/Atikokan': 'EST',
    'America/Bahia': 'BRT',
    'America/Bahia_Banderas': 'CST',
    'America/Barbados': 'AST',
    'America/Belem': 'BRT',
    'America/Belize': 'CST',
    'America/Blanc-Sablon': 'AST',
    'America/Boa_Vista': 'AMT',
    'America/Bogota': 'COT',
    'America/Boise': 'MST',
    'America/Cambridge_Bay': 'MST',
    'America/Campo_Grande': 'AMT',
    'America/Cancun': 'EST',
    'America/Caracas': 'VET',
    'America/Cayenne': 'GFT',
    'America/Cayman': 'EST',
    'America/Chicago': 'CST',
    'America/Chihuahua': 'MST',
    'America/Ciudad_Juarez': 'MST',
    'America/Costa_Rica': 'CST',
    'America/Creston': 'MST',
    'America/Cuiaba': 'AMT',
    'America/Curacao': 'AST',
    'America/Danmarkshavn': 'GMT',
    'America/Dawson': 'MST',
    'America/Dawson_Creek': 'MST',
    'America/Denver': 'MST',
    'America/Detroit': 'EST',
    'America/Dominica': 'AST',
    'America/Edmonton': 'MST',
    'America/Eirunepe': 'ACT',
    'America/El_Salvador': 'CST',
    'America/Fort_Nelson': 'MST',
    'America/Fortaleza': 'BRT',
    'America/Glace_Bay': 'AST',
    'America/Goose_Bay': 'AST',
    'America/Grand_Turk': 'EST',
    'America/Guatemala': 'CST',
    'America/Guayaquil': 'ECT',
    'America/Guyana': 'GYT',
    'America/Halifax': 'AST',
    'America/Havana': 'CST',
    'America/Hermosillo': 'MST',
    'America/Indiana/Indianapolis': 'EST',
    'America/Indiana/Knox': 'CST',
    'America/Indiana/Marengo': 'EST',
    'America/Indiana/Petersburg': 'EST',
    'America/Indiana/Tell_City': 'CST',
    'America/Indiana/Vevay': 'EST',
    'America/Indiana/Vincennes': 'EST',
    'America/Indiana/Winamac': 'EST',
    'America/Inuvik': 'MST',
    'America/Iqaluit': 'EST',
    'America/Jamaica': 'EST',
    'America/Juneau': 'AKST',
    'America/Kentucky/Louisville': 'EST',
    'America/Kentucky/Monticello': 'EST',
    'America/Kralendijk': 'AST',
    'America/La_Paz': 'BOT',
    'America/Lima': 'PET',
    'America/Los_Angeles': 'PST',
    'America/Maceio': 'BRT',
    'America/Managua': 'CST',
    'America/Manaus': 'AMT',
    'America/Martinique': 'AST',
    'America/Matamoros': 'CST',
    'America/Mazatlan': 'MST',
    'America/Menominee': 'CST',
    'America/Merida': 'CST',
    'America/Metlakatla': 'AKST',
    'America/Mexico_City': 'CST',
    'America/Miquelon': 'PMST',
    'America/Moncton': 'AST',
    'America/Monterrey': 'CST',
    'America/Montevideo': 'UYT',
    'America/Nassau': 'EST',
    'America/New_York': 'EST',
    'America/Nipigon': 'EST',
    'America/Nome': 'AKST',
    'America/Noronha': 'FNT',
    'America/North_Dakota/Beulah': 'CST',
    'America/North_Dakota/Center': 'CST',
    'America/North_Dakota/New_Salem': 'CST',
    'America/Nuuk': 'WGT',
    'America/Ojinaga': 'CST',
    'America/Panama': 'EST',
    'America/Paramaribo': 'SRT',
    'America/Phoenix': 'MST',
    'America/Port_of_Spain': 'AST',
    'America/Port-au-Prince': 'EST',
    'America/Porto_Velho': 'AMT',
    'America/Puerto_Rico': 'AST',
    'America/Punta_Arenas': 'CLT',
    'America/Rainy_River': 'CST',
    'America/Rankin_Inlet': 'CST',
    'America/Recife': 'BRT',
    'America/Regina': 'CST',
    'America/Resolute': 'CST',
    'America/Rio_Branco': 'ACT',
    'America/Santarem': 'BRT',
    'America/Santiago': 'CLT',
    'America/Santo_Domingo': 'AST',
    'America/Sao_Paulo': 'BRT',
    'America/Scoresbysund': 'EGT',
    'America/Sitka': 'AKST',
    'America/St_Johns': 'NST',
    'America/Swift_Current': 'CST',
    'America/Tegucigalpa': 'CST',
    'America/Thule': 'AST',
    'America/Thunder_Bay': 'EST',
    'America/Tijuana': 'PST',
    'America/Toronto': 'EST',
    'America/Tortola': 'AST',
    'America/Vancouver': 'PST',
    'America/Whitehorse': 'MST',
    'America/Winnipeg': 'CST',
    'America/Yakutat': 'AKST',
    'America/Yellowknife': 'MST',
    'Antarctica/Casey': 'AWST',
    'Antarctica/Davis': 'DAVT',
    'Antarctica/DumontDUrville': 'DDUT',
    'Antarctica/Macquarie': 'AEST',
    'Antarctica/Mawson': 'MAWT',
    'Antarctica/McMurdo': 'NZST',
    'Antarctica/Palmer': 'CLT',
    'Antarctica/Rothera': 'ROT',
    'Antarctica/South_Pole': 'NZST',
    'Antarctica/Syowa': 'SYOT',
    'Antarctica/Troll': 'UTC',
    'Antarctica/Vostok': 'VOST',
    'Asia/Aden': 'AST',
    'Asia/Almaty': 'ALMT',
    'Asia/Amman': 'EET',
    'Asia/Anadyr': 'ANAT',
    'Asia/Aqtau': 'AQTT',
    'Asia/Aqtobe': 'AQTT',
    'Asia/Ashgabat': 'TMT',
    'Asia/Atyrau': 'AQTT',
    'Asia/Baghdad': 'AST',
    'Asia/Bahrain': 'AST',
    'Asia/Baku': 'AZT',
    'Asia/Bangkok': 'ICT',
    'Asia/Barnaul': 'KRAT',
    'Asia/Beirut': 'EET',
    'Asia/Bishkek': 'KGT',
    'Asia/Brunei': 'BNT',
    'Asia/Calcutta': 'IST',
    'Asia/Chita': 'YAKT',
    'Asia/Choibalsan': 'CHOT',
    'Asia/Chongqing': 'CST',
    'Asia/Colombo': 'IST',
    'Asia/Damascus': 'EET',
    'Asia/Dhaka': 'BDT',
    'Asia/Dili': 'TLT',
    'Asia/Dubai': 'GST',
    'Asia/Dushanbe': 'TJT',
    'Asia/Famagusta': 'EET',
    'Asia/Gaza': 'EET',
    'Asia/Harbin': 'CST',
    'Asia/Hebron': 'EET',
    'Asia/Ho_Chi_Minh': 'ICT',
    'Asia/Hong_Kong': 'HKT',
    'Asia/Hovd': 'HOVT',
    'Asia/Irkutsk': 'IRKT',
    'Asia/Istanbul': 'TRT',
    'Asia/Jakarta': 'WIB',
    'Asia/Jayapura': 'WIT',
    'Asia/Jerusalem': 'IST',
    'Asia/Kabul': 'AFT',
    'Asia/Kamchatka': 'PETT',
    'Asia/Karachi': 'PKT',
    'Asia/Kashgar': 'XJT',
    'Asia/Kathmandu': 'NPT',
    'Asia/Khandyga': 'YAKT',
    'Asia/Kolkata': 'IST',
    'Asia/Krasnoyarsk': 'KRAT',
    'Asia/Kuala_Lumpur': 'MYT',
    'Asia/Kuching': 'MYT',
    'Asia/Kuwait': 'AST',
    'Asia/Macao': 'CST',
    'Asia/Magadan': 'MAGT',
    'Asia/Makassar': 'WITA',
    'Asia/Manila': 'PST',
    'Asia/Muscat': 'GST',
    'Asia/Nicosia': 'EET',
    'Asia/Novokuznetsk': 'KRAT',
    'Asia/Novosibirsk': 'NOVT',
    'Asia/Omsk': 'OMST',
    'Asia/Oral': 'ORAT',
    'Asia/Phnom_Penh': 'ICT',
    'Asia/Pontianak': 'WIB',
    'Asia/Pyongyang': 'KST',
    'Asia/Qatar': 'AST',
    'Asia/Qostanay': 'QYZT',
    'Asia/Qyzylorda': 'QYZT',
    'Asia/Rangoon': 'MMT',
    'Asia/Riyadh': 'AST',
    'Asia/Sakhalin': 'SAKT',
    'Asia/Samarkand': 'UZT',
    'Asia/Seoul': 'KST',
    'Asia/Shanghai': 'CST',
    'Asia/Singapore': 'SGT',
    'Asia/Srednekolymsk': 'SRET',
    'Asia/Taipei': 'CST',
    'Asia/Tashkent': 'UZT',
    'Asia/Tbilisi': 'GET',
    'Asia/Tehran': 'IRST',
    'Asia/Tel_Aviv': 'IST',
    'Asia/Thimphu': 'BTT',
    'Asia/Tokyo': 'JST',
    'Asia/Tomsk': 'TOMT',
    'Asia/Ulaanbaatar': 'ULAT',
    'Asia/Urumqi': 'XJT',
    'Asia/Ust-Nera': 'VLAT',
    'Asia/Vientiane': 'ICT',
    'Asia/Vladivostok': 'VLAT',
    'Asia/Yakutsk': 'YAKT',
    'Asia/Yangon': 'MMT',
    'Asia/Yekaterinburg': 'YEKT',
    'Asia/Yerevan': 'AMT',
    'Atlantic/Azores': 'AZOT',
    'Atlantic/Bermuda': 'AST',
    'Atlantic/Canary': 'WET',
    'Atlantic/Cape_Verde': 'CVT',
    'Atlantic/Faeroe': 'WET',
    'Atlantic/Faroe': 'WET',
    'Atlantic/Jan_Mayen': 'CET',
    'Atlantic/Madeira': 'WET',
    'Atlantic/Reykjavik': 'GMT',
    'Atlantic/South_Georgia': 'GST',
    'Atlantic/St_Helena': 'GMT',
    'Atlantic/Stanley': 'FKST',
    'Arctic/Longyearbyen': 'CET',
    'Australia/ACT': 'AEST',
    'Australia/Adelaide': 'ACST',
    'Australia/Brisbane': 'AEST',
    'Australia/Broken_Hill': 'ACST',
    'Australia/Canberra': 'AEST',
    'Australia/Currie': 'AEST',
    'Australia/Darwin': 'ACST',
    'Australia/Eucla': 'ACWST',
    'Australia/Hobart': 'AEST',
    'Australia/LHI': 'LHST',
    'Australia/Lindeman': 'AEST',
    'Australia/Lord_Howe': 'LHST',
    'Australia/Melbourne': 'AEST',
    'Australia/North': 'ACST',
    'Australia/NSW': 'AEST',
    'Australia/Perth': 'AWST',
    'Australia/Queensland': 'AEST',
    'Australia/South': 'ACST',
    'Australia/Sydney': 'AEST',
    'Australia/Tasmania': 'AEST',
    'Australia/Victoria': 'AEST',
    'Australia/West': 'AWST',
    'Australia/Yancowinna': 'ACST',
    'Europe/Andorra': 'CET',
    'Europe/Astrakhan': 'SAMT',
    'Europe/Athens': 'EET',
    'Europe/Belgrade': 'CET',
    'Europe/Berlin': 'CET',
    'Europe/Brussels': 'CET',
    'Europe/Bucharest': 'EET',
    'Europe/Budapest': 'CET',
    'Europe/Chisinau': 'EET',
    'Europe/Dublin': 'GMT',
    'Europe/Gibraltar': 'CET',
    'Europe/Helsinki': 'EET',
    'Europe/Istanbul': 'TRT',
    'Europe/Kaliningrad': 'EET',
    'Europe/Kirov': 'MSK',
    'Europe/Kyiv': 'EET',
    'Europe/Lisbon': 'WET',
    'Europe/London': 'GMT',
    'Europe/Madrid': 'CET',
    'Europe/Malta': 'CET',
    'Europe/Minsk': 'MSK',
    'Europe/Moscow': 'MSK',
    'Europe/Paris': 'CET',
    'Europe/Prague': 'CET',
    'Europe/Riga': 'EET',
    'Europe/Rome': 'CET',
    'Europe/Samara': 'SAMT',
    'Europe/Saratov': 'SAMT',
    'Europe/Simferopol': 'MSK',
    'Europe/Sofia': 'EET',
    'Europe/Tallinn': 'EET',
    'Europe/Tirane': 'CET',
    'Europe/Ulyanovsk': 'SAMT',
    'Europe/Vienna': 'CET',
    'Europe/Vilnius': 'EET',
    'Europe/Volgograd': 'MSK',
    'Europe/Warsaw': 'CET',
    'Europe/Zurich': 'CET',
    'Indian/Chagos': 'IOT',
    'Indian/Christmas': 'CXT',
    'Indian/Cocos': 'CCT',
    'Indian/Kerguelen': 'TFT',
    'Indian/Maldives': 'MVT',
    'Indian/Mauritius': 'MUT',
    'Indian/Mayotte': 'EAT',
    'Indian/Reunion': 'RET',
    'Pacific/Apia': 'WST',
    'Pacific/Auckland': 'NZST',
    'Pacific/Bougainville': 'BST',
    'Pacific/Chatham': 'CHAST',
    'Pacific/Easter': 'EASST',
    'Pacific/Efate': 'VUT',
    'Pacific/Fakaofo': 'TKT',
    'Pacific/Fiji': 'FJT',
    'Pacific/Galapagos': 'GALT',
    'Pacific/Gambier': 'GAMT',
    'Pacific/Guadalcanal': 'SBT',
    'Pacific/Guam': 'ChST',
    'Pacific/Honolulu': 'HST',
    'Pacific/Kanton': 'PHOT',
    'Pacific/Kiritimati': 'LINT',
    'Pacific/Kosrae': 'KOST',
    'Pacific/Kwajalein': 'MHT',
    'Pacific/Marquesas': 'MART',
    'Pacific/Nauru': 'NRT',
    'Pacific/Niue': 'NUT',
    'Pacific/Norfolk': 'NFT',
    'Pacific/Noumea': 'NCT',
    'Pacific/Pago_Pago': 'SST',
    'Pacific/Palau': 'PWT',
    'Pacific/Pitcairn': 'PST',
    'Pacific/Port_Moresby': 'PGT',
    'Pacific/Rarotonga': 'CKT',
    'Pacific/Tahiti': 'TAHT',
    'Pacific/Tarawa': 'GILT',
    'Pacific/Tongatapu': 'TOT',
    'Pacific/Wake': 'WAKT',
    'Pacific/Wallis': 'WFT',
    'UTC': 'UTC',
    'Etc/UTC': 'UTC',
    'Etc/GMT': 'GMT'
  };
  private readonly offsetAbbreviationFallbacks: Record<string, string> = {
    '+00:00': 'GMT',
    '+01:00': 'CET',
    '+02:00': 'EET',
    '+03:00': 'MSK',
    '+04:00': 'GST',
    '+05:00': 'PKT',
    '+05:30': 'IST',
    '+05:45': 'NPT',
    '+06:00': 'BST',
    '+06:30': 'MMT',
    '+07:00': 'ICT',
    '+08:00': 'CST',
    '+08:45': 'ACWST',
    '+09:00': 'JST',
    '+09:30': 'ACST',
    '+10:00': 'AEST',
    '+10:30': 'LHST',
    '+11:00': 'AEDT',
    '+12:00': 'NZST',
    '+13:00': 'NZDT',
    '+14:00': 'LINT',
    '-01:00': 'AZOT',
    '-02:00': 'GST',
    '-03:00': 'ART',
    '-03:30': 'NST',
    '-04:00': 'AST',
    '-05:00': 'EST',
    '-06:00': 'CST',
    '-07:00': 'MST',
    '-08:00': 'PST',
    '-09:00': 'AKST',
    '-10:00': 'HST',
    '-11:00': 'SST',
    '-12:00': 'AoE'
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
      if (!abbreviation) {
        return null;
      }

      if (/^GMT[+-]/.test(abbreviation)) {
        return null;
      }

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
      if (!offsetPart) {
        return null;
      }

      const match = offsetPart.match(/GMT([+-])(\d{2}):(\d{2})/);
      if (!match) {
        return null;
      }

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
    if (!abbreviations) {
      return null;
    }

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
    if (intlAbbreviation) {
      return intlAbbreviation;
    }

    const seasonalAbbreviation = this.getSeasonalTimezoneAbbreviation(timezone);
    if (seasonalAbbreviation) {
      return seasonalAbbreviation;
    }

    const exact = this.timezoneAbbreviationMap[timezone];
    if (exact) {
      return exact;
    }

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
      return new Date().toLocaleTimeString("zh-CN", {
        timeZone: timezone, hour12: false, hour: "2-digit", minute: "2-digit"
      });
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
    if (finalStyle === "normal" || !text) {
      return text;
    }

    return Array.from(text).map(char => this.stylizeChar(char, finalStyle)).join("");
  }

  private async normalizeWeatherLocation(location: string): Promise<string> {
    const normalized = location.trim();
    if (!normalized || !/[\u4e00-\u9fa5]/.test(normalized)) {
      return normalized;
    }

    const quickMap: Record<string, string> = {
      "北京": "Beijing",
      "上海": "Shanghai",
      "广州": "Guangzhou",
      "深圳": "Shenzhen",
      "成都": "Chengdu",
      "杭州": "Hangzhou",
      "武汉": "Wuhan",
      "西安": "Xi'an",
      "重庆": "Chongqing",
      "南京": "Nanjing",
      "天津": "Tianjin",
      "苏州": "Suzhou",
      "香港": "Hong Kong",
      "澳门": "Macau",
      "台北": "Taipei",
      "东京": "Tokyo",
      "首尔": "Seoul",
      "曼谷": "Bangkok",
      "新加坡": "Singapore",
      "伦敦": "London",
      "巴黎": "Paris",
      "柏林": "Berlin",
      "纽约": "New York",
      "洛杉矶": "Los Angeles",
      "旧金山": "San Francisco",
      "悉尼": "Sydney",
      "墨尔本": "Melbourne"
    };

    if (quickMap[normalized]) {
      return quickMap[normalized];
    }

    try {
      const translateModule = await import("@vitalets/google-translate-api");
      const translate = translateModule.translate || translateModule.default;
      if (typeof translate !== "function") {
        return normalized;
      }

      const result = await translate(normalized, {
        to: "en"
      });
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
    if (!rawLocation) {
      return "";
    }

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
        params: {
          name: geocodingName,
          count: 5,
          language: "zh",
          format: "json"
        },
        timeout: 10000
      });

      const results = geoResp.data?.results || [];
      if (results.length === 0) throw new Error("城市未找到");

      const loc = results[0];
      const locationNameParts: string[] = [];
      if (loc.name) locationNameParts.push(loc.name);
      if (loc.admin1 && loc.admin1 !== loc.name) locationNameParts.push(loc.admin1);
      if (loc.country) locationNameParts.push(loc.country);
      const wResp = await axios.get<WeatherForecastResponse>("https://api.open-meteo.com/v1/forecast", {
        params: {
          latitude: loc.latitude,
          longitude: loc.longitude,
          current: "temperature_2m,weather_code",
          timezone: "auto"
        },
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
      // 发生错误时缓存空文本，避免频繁重试
      settings.weather_compact = "";
      settings.weather_cache_ts = now;
      try { await DataManager.saveUserSettings(settings); } catch { /* ignore */ }
      return "";
    }
  }

  // 获取时区显示格式（支持自定义格式）
  getTimezoneDisplay(timezone: string, format?: string): string {
    try {
      // 使用正确的方法计算时区偏移
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en', {
        timeZone: timezone,
        timeZoneName: 'longOffset'
      });
      
      const parts = formatter.formatToParts(now);
      const offsetPart = parts.find(part => part.type === 'timeZoneName');
      
      if (offsetPart && offsetPart.value) {
        // 解析GMT偏移 (格式: GMT+08:00)
        const match = offsetPart.value.match(/GMT([+-])(\d{2}):(\d{2})/);
        if (match) {
          const sign = match[1];
          const hours = parseInt(match[2], 10);
          const minutes = parseInt(match[3], 10);
          const offsetHours = sign === '+' ? hours : -hours;
          
          console.log(`[AutoChangeName] 时区计算: ${timezone} -> 偏移 ${sign}${hours} 小时`);
          
          // 处理自定义格式
          if (format) {
            switch (format) {
              case 'GMT':
                return minutes > 0 ? `GMT${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `GMT${sign}${hours}`;
              case 'UTC':
                return minutes > 0 ? `UTC${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `UTC${sign}${hours}`;
              case 'SIMP':
                return this.getTimezoneAbbreviation(timezone, sign, hours, minutes);
              case 'offset':
                return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
              default:
                // 自定义格式 "custom:xxx"
                if (format.startsWith('custom:')) {
                  return format.substring(7);
                }
                return minutes > 0 ? `GMT${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `GMT${sign}${hours}`;
            }
          }
          
          // 默认GMT格式 - 处理半小时偏移
          const result = minutes > 0 ? `GMT${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}` : `GMT${sign}${hours}`;
          console.log(`[AutoChangeName] 时区显示结果: ${result}`);
          return result;
        }
      }
      
      // 备用方法：使用更精确的时区偏移计算
      const utcNow = new Date();
      const localTime = new Date(utcNow.toLocaleString('en-US', { timeZone: timezone }));
      const utcTime = new Date(utcNow.toLocaleString('en-US', { timeZone: 'UTC' }));
      
      const offsetMs = localTime.getTime() - utcTime.getTime();
      const totalMinutes = Math.round(offsetMs / (1000 * 60));
      const offsetHours = Math.floor(Math.abs(totalMinutes) / 60);
      const offsetMinutes = Math.abs(totalMinutes) % 60;
      const sign = totalMinutes >= 0 ? '+' : '-';
      
      console.log(`[AutoChangeName] 备用计算: ${timezone} -> 偏移 ${sign}${offsetHours}:${offsetMinutes.toString().padStart(2, '0')}`);
      
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
    if (settings.displayComponents && settings.displayComponents.length > 0) {
      return settings.displayComponents;
    }
    switch (settings.mode) {
      case "time": return ["time"];
      case "text": return ["text", "time"];
      case "both": return ["text", "time"];
      default: return ["time"];
    }
  }

  // 生成新昵称
  async generateNewName(settings: UserSettings): Promise<{ firstName: string; lastName: string | null }> {
    const cleanFirstName = settings.original_first_name || "";
    const cleanLastName = settings.original_last_name;
    const currentTime = this.formatTime(settings.timezone);
    
    // 准备各个组件
    const components: { [key: string]: string } = {
      name: cleanFirstName,
      time: currentTime,
      text: '',
      emoji: settings.show_clock_emoji ? this.getClockEmoji(settings.timezone) : '',
      timezone: settings.show_timezone ? this.getTimezoneDisplay(settings.timezone, settings.timezone_format) : '',
      weather: ''
    };
    
    // 调试日志：显示各组件值
    console.log(`[AutoChangeName] 组件值: name="${components.name}", time="${components.time}", emoji="${components.emoji}", timezone="${components.timezone}"`);

    // 获取随机文本
    if (settings.mode === "text" || settings.mode === "both") {
      const texts = await DataManager.getRandomTexts();
      if (texts.length > 0) {
        components.text = texts[settings.text_index % texts.length];
      }
    }

    // 读取天气（若启用）并填充组件
    if (settings.weather_enabled && settings.weather_location) {
      const weatherText = await this.getWeatherCompact(settings);
      components.weather = weatherText;
    }

    const enabledComponents = this.getEnabledComponents(settings);
    
    // 根据用户自定义顺序重新排列组件
    let displayOrder: string[];
    if (settings.display_order) {
      displayOrder = settings.display_order.split(',').map(s => s.trim());
      console.log(`[AutoChangeName] 用户自定义顺序: [${displayOrder.join(', ')}]`);
      
      // 自动修复：如果开启了时区但display_order中没有timezone，自动添加
      if (settings.show_timezone && !displayOrder.includes('timezone')) {
        const timeIndex = displayOrder.indexOf('time');
        if (timeIndex !== -1) {
          displayOrder.splice(timeIndex + 1, 0, 'timezone');
        } else {
          displayOrder.push('timezone');
        }
        console.log(`[AutoChangeName] 自动添加timezone到顺序: [${displayOrder.join(', ')}]`);
      }
      
      // 自动修复：如果开启了emoji但display_order中没有emoji，自动添加
      if (settings.show_clock_emoji && !displayOrder.includes('emoji')) {
        displayOrder.push('emoji');
        console.log(`[AutoChangeName] 自动添加emoji到顺序: [${displayOrder.join(', ')}]`);
      }

      if (settings.weather_enabled && settings.weather_location && !displayOrder.includes('weather')) {
        const timezoneIndex = displayOrder.indexOf('timezone');
        const timeIndex = displayOrder.indexOf('time');
        if (timezoneIndex !== -1) {
          displayOrder.splice(timezoneIndex + 1, 0, 'weather');
        } else if (timeIndex !== -1) {
          displayOrder.splice(timeIndex + 1, 0, 'weather');
        } else {
          displayOrder.push('weather');
        }
        console.log(`[AutoChangeName] 自动添加weather到顺序: [${displayOrder.join(', ')}]`);
      }
      
      displayOrder = ["name", ...displayOrder.filter(comp => enabledComponents.includes(comp))];
      console.log(`[AutoChangeName] 过滤后的顺序: [${displayOrder.join(', ')}]`);
    } else {
      displayOrder = ["name", ...enabledComponents];
    }

    // 组合最终显示文本（只获取有值的组件内容）
    console.log(`[AutoChangeName] 显示组件顺序: [${displayOrder.join(', ')}]`);
    
    const finalParts = displayOrder
      .map((comp: string) => {
        const value = components[comp];
        console.log(`[AutoChangeName] 组件 ${comp}: "${value}" (长度: ${value ? value.length : 0})`);
        if (!value || value.length === 0) {
          return "";
        }

        return comp === 'name'
          ? value
          : this.applyTextStyle(value, settings.text_style || "normal");
      })
      .filter((part: string) => part && part.length > 0);
    
    console.log(`[AutoChangeName] 过滤后的组件: ["${finalParts.join('", "')}"]`);
    const finalName = finalParts.join(' ');

    return {
      firstName: finalName || cleanFirstName,
      lastName: cleanLastName
    };
  }

  // 更新用户昵称
  async updateUserProfile(userId: number, forceUpdate: boolean = false): Promise<boolean> {
    try {
      const client = await getGlobalClient();
      if (!client) {
        console.warn("[AutoChangeName] 客户端未就绪，跳过更新");
        return false;
      }

      const settings = await DataManager.getUserSettings(userId);
      if (!settings) {
        console.warn(`[AutoChangeName] 用户 ${userId} 设置不存在`);
        return false;
      }
      
      if (!forceUpdate && !settings.is_enabled) {
        return false;
      }

      // 检查上次更新时间，避免过于频繁的更新
      if (!forceUpdate && settings.last_update) {
        const lastUpdate = new Date(settings.last_update);
        const now = new Date();
        const timeDiff = now.getTime() - lastUpdate.getTime();
        
        // 如果距离上次更新不足30秒，跳过
        if (timeDiff < 30000) {
          const remainTime = Math.ceil((30000 - timeDiff) / 1000);
          console.log(`[AutoChangeName] 用户 ${userId} 更新过于频繁，还需等待 ${remainTime} 秒`);
          return false;
        }
      }

      const newName = await this.generateNewName(settings);
      
      // 验证长度限制
      if (newName.firstName.length > 64) {
        newName.firstName = newName.firstName.substring(0, 64);
      }
      if (newName.lastName && newName.lastName.length > 64) {
        newName.lastName = newName.lastName.substring(0, 64);
      }

      // 打印详细日志
      console.log(`[AutoChangeName] 用户 ${userId} 昵称更新: "${newName.firstName}"${newName.lastName ? ` 姓氏: "${newName.lastName}"` : ''}`);
      console.log(`[AutoChangeName] 当前配置 - 模式: ${settings.mode}, emoji: ${settings.show_clock_emoji ? '开' : '关'}, 时区: ${settings.show_timezone ? '开' : '关'}`);

      await client.invoke(
        new Api.account.UpdateProfile({
          firstName: newName.firstName,
          lastName: newName.lastName || undefined
        })
      );

      // 更新文本索引
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
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        console.error(`[AutoChangeName] 用户 ${userId} 被限流，需等待 ${waitTime} 秒`);
        
        // 临时禁用该用户的自动更新，避免持续触发限流
        const settings = await DataManager.getUserSettings(userId);
        if (settings && settings.is_enabled) {
          settings.is_enabled = false;
          await DataManager.saveUserSettings(settings);
          console.log(`[AutoChangeName] 已临时禁用用户 ${userId} 的自动更新`);
        }
      } else if (error.message?.includes("USERNAME_NOT_MODIFIED")) {
        // 昵称未改变，不算错误
        return true;
      } else {
        console.error(`[AutoChangeName] 用户 ${userId} 更新失败:`, error.message || error);
      }
      return false;
    }
  }

  // 启动自动更新
  startAutoUpdate(): void {
    try {
      // 先清理旧任务
      if (cronManager.has(this.TASK_NAME)) {
        cronManager.del(this.TASK_NAME);
      }

      // 创建新的定时任务（每分钟执行一次）
      cronManager.set(this.TASK_NAME, "0 * * * * *", async () => {
        if (this.isUpdating) {
          console.log("[AutoChangeName] 更新任务正在执行中，跳过本次");
          return;
        }
        
        this.isUpdating = true;
        try {
          const enabledUsers = await DataManager.getAllEnabledUsers();
          if (enabledUsers.length === 0) {
            return;
          }
          
          console.log(`[AutoChangeName] ===== 开始更新 ${enabledUsers.length} 个用户的昵称 =====`);
          
          const updatePromises = enabledUsers.map(userId => 
            this.updateUserProfile(userId).catch(error => {
              console.error(`[AutoChangeName] 用户 ${userId} 更新失败:`, error);
              return false;
            })
          );
          
          const results = await Promise.allSettled(updatePromises);
          const successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
          
          if (successCount > 0) {
            console.log(`[AutoChangeName] 本次更新完成: ${successCount}/${enabledUsers.length} 个用户成功`);
          }
          console.log(`[AutoChangeName] ===== 更新任务结束 =====`);
          console.log(''); // 空行分隔
        } catch (error) {
          console.error("[AutoChangeName] 批量更新时发生错误:", error);
        } finally {
          this.isUpdating = false;
        }
      });

      console.log("[AutoChangeName] 自动更新任务已启动");
    } catch (error) {
      console.error("[AutoChangeName] 启动自动更新失败:", error);
    }
  }

  // 停止自动更新
  stopAutoUpdate(): void {
    if (cronManager.has(this.TASK_NAME)) {
      cronManager.del(this.TASK_NAME);
      console.log("[AutoChangeName] 自动更新任务已停止");
    }
  }
  
  // 清理资源
  cleanup(): void {
    // 真实资源清理：停止自动更新任务并重置运行时缓存。
    this.stopAutoUpdate();
    this.profileCache = null;
    this.isUpdating = false;
  }

  // 检查调度器状态
  isSchedulerRunning(): boolean {
    return cronManager.has(this.TASK_NAME);
  }
}

// 获取管理器实例（单例模式，防止内存泄漏）
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

// 插件类
class AutoChangeNamePlugin extends Plugin {
  cleanup(): void {
    // 真实资源清理：停止自动更新任务并重置运行时缓存。
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

      // 标准参数解析
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();

      try {
        // 获取用户ID - 优化频道身份处理
        let userId: number | null = null;
        let isChannelMessage = false;
        
        // 检查是否为频道身份发言
        if (msg.fromId && msg.fromId.className === 'PeerChannel') {
          isChannelMessage = true;
          await msg.edit({
            text: `⚠️ <b>不支持在频道中使用此命令</b>\n\n请在私聊中发送命令来管理动态昵称。`,
            parseMode: "html"
          });
          return;
        }
        
        // 获取真实用户ID
        if (msg.senderId) {
          userId = Number(msg.senderId.toString());
        } else if (msg.fromId && msg.fromId.className === 'PeerUser') {
          userId = Number(msg.fromId.userId.toString());
        }
        
        if (!userId || isNaN(userId)) {
          await msg.edit({
            text: `❌ <b>无法识别您的身份</b>\n\n请确保在私聊中使用此命令。`,
            parseMode: "html"
          });
          return;
        }

        // 处理帮助
        if (!sub || sub === "help" || sub === "h") {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        // 智能首次使用检测和引导
        const settings = await DataManager.getUserSettings(userId);
        const isFirstTime = !settings;
        const needsSave = !settings?.original_first_name;
        
        // 对于非save、help、status命令，检查是否需要引导
        if (isFirstTime && !["save", "help", "h", "status"].includes(sub)) {
          await msg.edit({
            text: `⚠️ <b>请先保存昵称</b>\n\n您还没有保存过昵称。\n\n请先执行 <code>${mainPrefix}acn save</code> 保存您的当前昵称。`,
            parseMode: "html"
          });
          return;
        }
        
        // 对于已有设置但未保存昵称的用户
        if (needsSave && !isFirstTime && !["save", "help", "h", "status", "reset"].includes(sub)) {
          await msg.edit({
            text: `⚠️ <b>配置不完整</b>\n\n<b>您想要执行：</b> <code>${sub}</code>\n\n<b>⚠️ 检测到问题：</b>\n您的配置中缺少原始昵称记录\n\n<b>🔧 解决方法：</b>\n请先执行 <code>${mainPrefix}acn save</code> 保存您的当前昵称\n\n<b>💡 小提示：</b>\n确保当前昵称是"干净"的（不含时间等动态内容），\n这样恢复时才能得到正确的原始昵称。`,
            parseMode: "html"
          });
          return;
        }

        // 处理各种命令
        switch (sub) {
          case "save":
            await this.handleSave(msg, userId);
            break;

          case "on":
          case "enable":
            await this.handleToggle(msg, userId, true);
            break;

          case "off":
          case "disable":
            await this.handleToggle(msg, userId, false);
            break;

          case "mode":
            await this.handleMode(msg, userId);
            break;

          case "status":
            await this.handleStatus(msg);
            break;

          case "text":
            await this.handleText(msg, args.slice(1));
            break;

          case "tz":
          case "timezone":
            await this.handleTimezone(msg, userId, args.slice(1));
            break;

          case "update":
          case "now":
            await this.handleUpdate(msg, userId);
            break;

          case "reset":
            await this.handleReset(msg, userId);
            break;

          case "emoji":
            await this.handleEmojiToggle(msg, userId, args.slice(1));
            break;

          case "showtz":
            await this.handleTimezoneToggle(msg, userId, args.slice(1));
            break;

          case "order":
            await this.handleDisplayOrder(msg, userId, args.slice(1));
            break;

          case "config":
            await this.handleShowConfig(msg, userId);
            break;

          case "weather":
            await this.handleWeather(msg, userId, args.slice(1));
            break;

          case "style":
            await this.handleTextStyle(msg, userId, args.slice(1));
            break;

          case "show":
            await this.handleShow(msg, userId, args.slice(1));
            break;

          case "tzformat":
            await this.handleTimezoneFormat(msg, userId, args.slice(1));
            break;

          default:
            await msg.edit({
              text: `❌ <b>未知命令</b>\n\n未知的子命令: <code>${htmlEscape(sub)}</code>\n\n输入 <code>${mainPrefix}acn</code> 或 <code>${mainPrefix}acn help</code> 查看帮助。`,
              parseMode: "html"
            });
        }

      } catch (error: any) {
        console.error("[AutoChangeName] 命令执行失败:", error);
        
        if (error.message?.includes("FLOOD_WAIT")) {
          const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
          await msg.edit({
            text: `⏳ <b>请求过于频繁</b>\n\n需要等待 ${waitTime} 秒后重试`,
            parseMode: "html"
          });
        } else if (error.message?.includes("MESSAGE_ID_INVALID")) {
          console.error("[AutoChangeName] 消息已失效");
        } else {
          const errorMsg = error.message || "未知错误";
          // 限制错误消息长度
          const safeErrorMsg = errorMsg.length > 100 ? errorMsg.substring(0, 100) + "..." : errorMsg;
          await msg.edit({
            text: `❌ <b>操作失败:</b> ${htmlEscape(safeErrorMsg)}`,
            parseMode: "html"
          });
        }
      }
    },

    autochangename: async (msg: Api.Message, trigger?: Api.Message) => {
      // 别名支持
      return this.cmdHandlers.acn(msg, trigger);
    }
  };

  // 处理保存命令
  private async handleSave(msg: Api.Message, userId: number): Promise<void> {
    await msg.edit({ text: "⏳ 正在保存当前昵称...", parseMode: "html" });

    const success = await nameManager.saveCurrentNickname(userId);
    if (success) {
      const settings = await DataManager.getUserSettings(userId);
      if (settings) {
        // 检查是否为首次保存
        const texts = await DataManager.getRandomTexts();
        const isFirstTimeSave = !settings.last_update;
        
        if (isFirstTimeSave) {
          // 首次保存，提供完整引导
          await msg.edit({
            text: `🎉 <b>昵称保存成功！设置完成</b>\n\n<b>✅ 已保存的原始昵称：</b>\n• 姓名: <code>${htmlEscape(settings.original_first_name || "")}</code>\n• 姓氏: <code>${htmlEscape(settings.original_last_name || "(空)")}</code>\n\n<b>🚀 接下来您可以：</b>\n\n<b>1. 立即开始使用</b>\n<code>${mainPrefix}acn on/off</code> - 开启或关闭自动昵称更新\n\n<b>2. 个性化设置（推荐）</b>\n<code>${mainPrefix}acn text add 工作中</code> - 添加状态文案\n<code>${mainPrefix}acn emoji on/off</code> - 开启或关闭时钟表情 🕐\n<code>${mainPrefix}acn showtz on/off</code> - 显示或隐藏时区 GMT+8\n\n\n<b>💡 小提示：</b>昵称会每分钟自动更新。`,
            parseMode: "html"
          });
        } else {
          // 非首次保存，简化提示
          await msg.edit({
            text: `✅ <b>昵称已重新保存</b>\n\n<b>姓名:</b> <code>${htmlEscape(settings.original_first_name || "")}</code>\n<b>姓氏:</b> <code>${htmlEscape(settings.original_last_name || "(空)")}</code>\n\n${settings.is_enabled ? '自动更新仍在运行中' : '可按需重新启用动态昵称'}`,
            parseMode: "html"
          });
        }
      } else {
        await msg.edit({ text: "✅ 昵称已保存", parseMode: "html" });
      }
    } else {
      await msg.edit({ text: "❌ 保存失败，请稍后重试", parseMode: "html" });
    }
  }

  // 处理开关命令
  private async handleToggle(msg: Api.Message, userId: number, enable: boolean): Promise<void> {
    await msg.edit({ text: "⏳ 正在处理...", parseMode: "html" });

    let settings = await DataManager.getUserSettings(userId);
    
    if (!settings) {
      if (!enable) {
        await msg.edit({ text: "❌ 未找到设置，请先保存昵称", parseMode: "html" });
        return;
      }

      // 首次使用，提供详细的引导
      await msg.edit({
        text: `⚠️ <b>请先保存昵称</b>\n\n在开启自动更新之前，请先执行:\n\n<code>${mainPrefix}acn save</code>\n\n这将保存您当前的昵称作为基准。`,
        parseMode: "html"
      });
      return;
    }

    // 检查是否已保存原始昵称
    if (!settings.original_first_name && enable) {
      await msg.edit({
        text: `❌ <b>未保存原始昵称</b>\n\n检测到您的配置中没有原始昵称记录。\n请先执行：\n\n<code>${mainPrefix}acn save</code>\n\n保存您的原始昵称后再开启自动更新。`,
        parseMode: "html"
      });
      return;
    }

    settings.is_enabled = enable;
    const success = await DataManager.saveUserSettings(settings);

    if (success) {
      if (enable) {
        // 确保定时任务已启动
        if (!nameManager.isSchedulerRunning()) {
          nameManager.startAutoUpdate();
        }
        
        // 立即更新昵称
        const updateSuccess = await nameManager.updateUserProfile(userId, true);
        if (updateSuccess) {
          await msg.edit({
            text: `✅ <b>动态昵称已启用</b>\n\n🕐 当前时区: <code>${settings.timezone}</code>\n📝 显示模式: <code>${settings.mode}</code>\n⏰ 更新频率: 每分钟`,
            parseMode: "html"
          });
        } else {
          await msg.edit({ text: "❌ 启用失败，请检查权限", parseMode: "html" });
        }
      } else {
        await msg.edit({
          text: `✅ <b>动态昵称已禁用</b>\n\n使用 <code>${mainPrefix}acn on</code> 重新启用`,
          parseMode: "html"
        });
      }
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  // 处理模式切换
  private async handleMode(msg: Api.Message, userId: number): Promise<void> {
    const settings = await DataManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({
        text: `❌ 请先使用 <code>${mainPrefix}acn save</code> 保存昵称`,
        parseMode: "html"
      });
      return;
    }

    // 检查是否已保存原始昵称
    if (!settings.original_first_name) {
      await msg.edit({
        text: `⚠️ <b>提示</b>\n\n您还未保存原始昵称，建议先执行：\n<code>${mainPrefix}acn save</code>\n\n这样可以确保恢复时能还原到正确的昵称。\n\n当前仅切换了显示模式。`,
        parseMode: "html"
      });
      // 继续执行模式切换，但给出警告
    }

    // 循环切换模式
    if (settings.mode === "time") {
      settings.mode = "text";
    } else if (settings.mode === "text") {
      settings.mode = "both";
    } else {
      settings.mode = "time";
    }

    await DataManager.saveUserSettings(settings);

    if (settings.is_enabled) {
      await nameManager.updateUserProfile(userId, true);
    }

    await msg.edit({
      text: `✅ <b>显示模式已切换</b>\n\n📝 当前模式: <code>${settings.mode}</code>\n\n模式说明：\n• <code>time</code> - 只显示昵称+时间\n• <code>text</code> - 只显示昵称+文案\n• <code>both</code> - 显示昵称+文案+时间`,
      parseMode: "html"
    });
  }

  // 处理显示组件管理
  private async handleShow(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const action = (args[0] || "").toLowerCase();
    const target = (args[1] || "").toLowerCase();

    const allComponents = ["time", "text", "weather", "emoji", "timezone"] as const;
    const defaultByMode: Record<string, string[]> = {
      time: ["time"],
      text: ["text", "time"],
      both: ["text", "time"]
    };

    if (!action || action === "help" || action === "h") {
      const current = settings.displayComponents || defaultByMode[settings.mode] || ["time"];
      const status = allComponents.map(comp => {
        const enabled = current.includes(comp);
        const label = enabled ? "✅ 开启" : "❌ 关闭";
        return `• <code>${comp}</code> ${label}`;
      }).join("\n");

      await msg.edit({
        text: `🎛️ <b>显示组件管理</b>\n\n当前启用的组件: <code>${current.join(", ")}</code>\n\n<b>组件状态：</b>\n${status}\n\n<b>使用说明：</b>\n• <code>${mainPrefix}acn show</code> — 查看当前组件状态\n• <code>${mainPrefix}acn show &lt;组件&gt; on/off</code> — 开启或关闭组件\n• <code>${mainPrefix}acn show reset</code> — 重置为模式默认值`,
        parseMode: "html"
      });
      return;
    }

    if (action === "reset") {
      const defaults = defaultByMode[settings.mode] || ["time"];
      settings.displayComponents = defaults;
      const success = await DataManager.saveUserSettings(settings);
      if (success) {
        if (settings.is_enabled) {
          await nameManager.updateUserProfile(userId, true);
        }
        await msg.edit({
          text: `✅ <b>已重置为默认值</b>\n\n当前模式 (<code>${settings.mode}</code>) 的默认组件: <code>${defaults.join(", ")}</code>`,
          parseMode: "html"
        });
      } else {
        await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
      }
      return;
    }

    if (!allComponents.includes(action as typeof allComponents[number])) {
      await msg.edit({
        text: `❌ <b>未知的组件</b>\n\n可用组件: <code>${allComponents.join(", ")}</code>`,
        parseMode: "html"
      });
      return;
    }

    if (target !== "on" && target !== "off") {
      await msg.edit({
        text: `❌ <b>请指定 on 或 off</b>\n\n使用方法: <code>${mainPrefix}acn show ${action} on/off</code>`,
        parseMode: "html"
      });
      return;
    }

    const current = settings.displayComponents
      ? [...settings.displayComponents]
      : [...(defaultByMode[settings.mode] || ["time"])];

    if (target === "on") {
      if (!current.includes(action)) {
        current.push(action);
      }
      settings.displayComponents = current;
    } else {
      settings.displayComponents = current.filter(c => c !== action);
    }

    const success = await DataManager.saveUserSettings(settings);
    if (success) {
      if (settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }
      await msg.edit({
        text: `✅ <b>组件已${target === "on" ? "开启" : "关闭"}</b>\n\n<code>${action}</code> ${target === "on" ? "已启用" : "已禁用"}\n当前组件: <code>${settings.displayComponents!.join(", ")}</code>`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  // 处理状态查询
  private async handleStatus(msg: Api.Message): Promise<void> {
    const enabledUsers = await DataManager.getAllEnabledUsers();
    const isRunning = nameManager.isSchedulerRunning();

    await msg.edit({
      text: `📊 <b>动态昵称状态</b>\n\n🔄 自动更新: <code>${isRunning ? "运行中" : "已停止"}</code>\n👥 启用用户: <code>${enabledUsers.length}</code>\n⏰ 更新频率: <code>每分钟</code>`,
      parseMode: "html"
    });
  }

  // 处理文本管理
  private async handleText(msg: Api.Message, args: string[]): Promise<void> {
    const action = args[0] || "";
    const texts = await DataManager.getRandomTexts();

    if (action === "add") {
      // 从原始消息文本中提取内容，支持真正的多行
      const rawText = msg.message || "";
      const cmdPrefix = rawText.split(' ').slice(0, 3).join(' '); // "acn text add"
      const inputText = rawText.substring(cmdPrefix.length).trim();
      
      if (!inputText) {
        await msg.edit({ text: "❌ 请提供要添加的文本内容", parseMode: "html" });
        return;
      }
      
      // 支持多行文本：按行分割并批量添加
      console.log(`[AutoChangeName] 原始输入文本: "${inputText}"`);
      console.log(`[AutoChangeName] 输入文本长度: ${inputText.length}`);
      
      // 按行分割批量添加
      const lines = inputText.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
      
      console.log(`[AutoChangeName] 分割后的行数: ${lines.length}`);
      console.log(`[AutoChangeName] 分割结果: ["${lines.join('", "')}"]`);
      
      if (lines.length === 0) {
        await msg.edit({ text: "❌ 没有有效的文本内容", parseMode: "html" });
        return;
      }
      
      const validLines: string[] = [];
      const invalidLines: string[] = [];
      const duplicateLines: string[] = [];
      
      for (const line of lines) {
        if (line.length > 50) {
          invalidLines.push(`"${line.substring(0, 30)}..." (过长)`);
        } else if (texts.includes(line) || validLines.includes(line)) {
          duplicateLines.push(`"${line}"`);
        } else {
          validLines.push(line);
        }
      }
      
      // 添加有效文本
      texts.push(...validLines);
      const success = await DataManager.saveRandomTexts(texts);

      if (success) {
        let resultText = `✅ <b>文本添加结果</b>\n\n`;
        
        if (validLines.length > 0) {
          resultText += `✅ 成功添加 <b>${validLines.length}</b> 条文本\n`;
          if (validLines.length <= 3) {
            resultText += validLines.map(line => `• "${htmlEscape(line)}"`).join('\n') + '\n';
          }
        }
        
        if (duplicateLines.length > 0) {
          resultText += `\n⚠️ 跳过 <b>${duplicateLines.length}</b> 条重复文本\n`;
        }
        
        if (invalidLines.length > 0) {
          resultText += `\n❌ 跳过 <b>${invalidLines.length}</b> 条过长文本\n`;
        }
        
        resultText += `\n📊 当前文本总数: <b>${texts.length}</b>`;
        
        await msg.edit({ text: resultText, parseMode: "html" });
      } else {
        await msg.edit({ text: "❌ 添加失败", parseMode: "html" });
      }

    } else if (action === "del" && args.length > 1) {
      const index = parseInt(args[1]) - 1;
      if (index >= 0 && index < texts.length) {
        const deletedText = texts.splice(index, 1)[0];
        const success = await DataManager.saveRandomTexts(texts);

        if (success) {
          await msg.edit({
            text: `✅ <b>随机文本已删除</b>\n\n📝 删除的文本: <code>${htmlEscape(deletedText)}</code>\n📊 剩余数量: <code>${texts.length}</code>`,
            parseMode: "html"
          });
        } else {
          await msg.edit({ text: "❌ 删除失败", parseMode: "html" });
        }
      } else {
        await msg.edit({ text: "❌ 无效的索引号", parseMode: "html" });
      }

    } else if (action === "list") {
      if (texts.length === 0) {
        await msg.edit({
          text: `📝 <b>随机文本列表</b>\n\n暂无随机文本\n\n使用 <code>${mainPrefix}acn text add 文本内容</code> 添加随机文本`,
          parseMode: "html"
        });
      } else {
        const textList = texts
          .map((text, index) => `${index + 1}. ${htmlEscape(text)}`)
          .join("\n");

        await msg.edit({
          text: `📝 <b>随机文本列表</b>\n\n${textList}\n\n📊 总数量: <code>${texts.length}</code>`,
          parseMode: "html"
        });
      }

    } else if (action === "clear") {
      const success = await DataManager.saveRandomTexts([]);
      if (success) {
        await msg.edit({ text: "✅ 所有随机文本已清空", parseMode: "html" });
      } else {
        await msg.edit({ text: "❌ 清空失败", parseMode: "html" });
      }

    } else {
      await msg.edit({
        text: `❌ <b>无效的命令格式</b>\n\n使用方法：\n• <code>${mainPrefix}acn text add 文本内容</code>\n• <code>${mainPrefix}acn text del 序号</code>\n• <code>${mainPrefix}acn text list</code>\n• <code>${mainPrefix}acn text clear</code>`,
        parseMode: "html"
      });
    }
  }

  private async handleTimezone(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    if (args.length === 0) {
      await msg.edit({
        text: `🌍 <b>时区管理</b>\n\n<b>可用子命令：</b>\n• <code>${mainPrefix}acn tz Asia/Shanghai</code> — 设置时区\n• <code>${mainPrefix}acn tz list</code> — 查看常用时区列表\n• <code>${mainPrefix}acn tz show on/off</code> — 显示 / 隐藏昵称中的时区信息\n• <code>${mainPrefix}acn tz format GMT</code> — 设置时区显示格式\n\n<b>时区格式可选值：</b>\n• <code>GMT</code> — GMT+8\n• <code>UTC</code> — UTC+8\n• <code>simp</code> — 时区缩写（如 HKT / CST / EDT）\n• <code>offset</code> — +8:00\n• <code>custom:文字</code> — 自定义显示`,
        parseMode: "html"
      });
      return;
    }

    const sub = (args[0] || "").toLowerCase();

    if (sub === "list") {
      const commonTimezones = [
        "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul", "Asia/Hong_Kong",
        "Asia/Singapore", "Europe/London", "Europe/Paris", "Europe/Berlin",
        "America/New_York", "America/Los_Angeles", "America/Chicago", "Australia/Sydney"
      ];
      const timezoneList = commonTimezones.map(tz => `• <code>${tz}</code>`).join("\n");

      await msg.edit({
        text: `🌍 <b>常用时区列表</b>\n\n${timezoneList}\n\n使用 <code>${mainPrefix}acn tz &lt;时区&gt;</code> 设置时区`,
        parseMode: "html"
      });
      return;
    }

    if (sub === "show") {
      await this.handleTimezoneToggle(msg, userId, args.slice(1));
      return;
    }

    if (sub === "format") {
      await this.handleTimezoneFormat(msg, userId, args.slice(1));
      return;
    }

    if (sub === "set") {
      if (args.length < 2) {
        await msg.edit({
          text: `❌ <b>未提供时区</b>\n\n使用 <code>${mainPrefix}acn tz Asia/Shanghai</code> 设置时区`,
          parseMode: "html"
        });
        return;
      }
      args = args.slice(1);
    }

    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const newTimezone = args.join(" ").trim();

    // 验证时区是否有效
    try {
      new Date().toLocaleString("en-US", { timeZone: newTimezone });
    } catch (error) {
      await msg.edit({
        text: `❌ <b>无效的时区</b>\n\n<code>${htmlEscape(newTimezone)}</code> 不是有效的时区标识符\n\n请使用标准的IANA时区标识符，如 Asia/Shanghai`,
        parseMode: "html"
      });
      return;
    }
    settings.timezone = newTimezone;
    const success = await DataManager.saveUserSettings(settings);

    if (success) {
      if (settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }

      const currentTime = nameManager.formatTime(newTimezone);
      await msg.edit({
        text: `✅ <b>时区已更新</b>\n\n🕐 新时区: <code>${newTimezone}</code>\n⏰ 当前时间: <code>${currentTime}</code>`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 时区设置失败", parseMode: "html" });
    }
  }

  // 处理立即更新
  private async handleUpdate(msg: Api.Message, userId: number): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    // 检查是否已保存原始昵称
    if (!settings.original_first_name) {
      await msg.edit({
        text: `❌ <b>未保存原始昵称</b>\n\n请先使用 <code>${mainPrefix}acn save</code> 保存您的原始昵称`,
        parseMode: "html"
      });
      return;
    }

    const success = await nameManager.updateUserProfile(userId, true);
    if (success) {
      const currentTime = nameManager.formatTime(settings.timezone);
      await msg.edit({
        text: `✅ <b>昵称已手动更新</b>\n\n🕐 当前时间: <code>${currentTime}</code>\n🌍 时区: <code>${settings.timezone}</code>`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 更新失败，请检查权限", parseMode: "html" });
    }
  }

  // 处理emoji开关
  private async handleEmojiToggle(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const action = args[0]?.toLowerCase();
    if (action === "on") {
      settings.show_clock_emoji = true;
    } else if (action === "off") {
      settings.show_clock_emoji = false;
    } else {
      // 没有参数时显示当前状态
      await msg.edit({
        text: `🕐 <b>时钟Emoji设置</b>\n\n当前状态: <code>${settings.show_clock_emoji ? "开启" : "关闭"}</code>\n\n使用方法：\n• <code>${mainPrefix}acn emoji on/off</code> - 开启或关闭时钟emoji`,
        parseMode: "html"
      });
      return;
    }

    const success = await DataManager.saveUserSettings(settings);
    if (success) {
      if (settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }
      await msg.edit({
        text: `✅ <b>时钟Emoji已${settings.show_clock_emoji ? "开启" : "关闭"}</b>\n\n${settings.show_clock_emoji ? "现在您的昵称将显示对应时间的时钟表情 🕐" : "时钟表情已从昵称中移除"}`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  // 处理时区显示开关
  private async handleTimezoneToggle(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const action = args[0]?.toLowerCase();
    if (action === "on") {
      settings.show_timezone = true;
    } else if (action === "off") {
      settings.show_timezone = false;
    } else {
      // 没有参数时显示当前状态
      await msg.edit({
        text: `🌍 <b>时区显示设置</b>\n\n当前状态: <code>${settings.show_timezone ? "开启" : "关闭"}</code>\n\n使用方法：\n• <code>${mainPrefix}acn showtz on/off</code> - 显示或隐藏时区`,
        parseMode: "html"
      });
      return;
    }

    const success = await DataManager.saveUserSettings(settings);
    if (success) {
      if (settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }
      const tzDisplay = nameManager.getTimezoneDisplay(settings.timezone, settings.timezone_format);
      await msg.edit({
        text: `✅ <b>时区显示已${settings.show_timezone ? "开启" : "关闭"}</b>\n\n${settings.show_timezone ? `当前时区: ${tzDisplay}` : "时区信息已从昵称中移除"}`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  // 处理时区格式设置
  private async handleTimezoneFormat(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const format = args[0]?.toLowerCase();
    
    if (!format) {
      await msg.edit({
        text: `🌐 <b>时区显示格式设置</b>\n\n当前格式: <code>${settings.timezone_format || 'GMT'}</code>\n\n<b>可用格式：</b>\n• <code>GMT</code> - 显示 GMT+8\n• <code>UTC</code> - 显示 UTC+8\n• <code>simp</code> - 显示时区缩写（如：HKT / CST / JST）\n• <code>offset</code> - 显示 +8:00\n• <code>custom:自定义文字</code> - 自定义显示\n\n<b>使用示例：</b>\n<code>${mainPrefix}acn tzformat GMT</code>\n<code>${mainPrefix}acn tzformat simp</code>\n<code>${mainPrefix}acn tzformat custom:北京时间</code>`,
        parseMode: "html"
      });
      return;
    }

    // 处理自定义格式
    let finalFormat = format;
    if (format.startsWith('custom:')) {
      finalFormat = args.join(' ');
    } else if (!['gmt', 'utc', 'simp', 'offset'].includes(format)) {
      await msg.edit({
        text: `❌ <b>无效格式</b>\n\n请使用: GMT, UTC, simp, offset 或 custom:自定义`,
        parseMode: "html"
      });
      return;
    }

    settings.timezone_format = finalFormat.toUpperCase();
    const success = await DataManager.saveUserSettings(settings);
    
    if (success) {
      if (settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }
      const preview = nameManager.getTimezoneDisplay(settings.timezone, settings.timezone_format);
      await msg.edit({
        text: `✅ <b>时区格式已更新</b>\n\n新格式: <code>${htmlEscape(settings.timezone_format)}</code>\n预览: <code>${preview}</code>`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  private async handleTextStyle(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const styleArg = (args[0] || "").toLowerCase();
    const styleAliases: Record<string, TextStyleMode> = {
      normal: "normal",
      italic: "italic",
      bold: "italic",
      double: "double",
      sans: "sans",
      mono: "mono",
      outline: "outline",
      style1: "italic",
      style2: "double",
      style3: "sans",
      style4: "mono",
      style5: "outline"
    };
    const validStyles: TextStyleMode[] = ["normal", "italic", "double", "sans", "mono", "outline"];
    const styleExamples: Record<TextStyleMode, string> = {
      normal: "123abc",
      italic: "𝟏𝟐𝟑𝐚𝐛𝐜",
      double: "𝟙𝟚𝟛𝕒𝕓𝕔",
      sans: "𝟭𝟮𝟯𝗮𝗯𝗰",
      mono: "𝟷𝟸𝟹𝚊𝚋𝚌",
      outline: "𝟣𝟤𝟥𝖺𝖻𝖼"
    };
    const resolvedStyle = styleAliases[styleArg];

    if (!styleArg || styleArg === "help" || styleArg === "h") {
      const currentStyle = settings.text_style || "normal";
      const preview = nameManager.applyTextStyle("123abc ABC", currentStyle);
      await msg.edit({
        text: `🎨 <b>文字样式设置</b>

当前样式: <code>${currentStyle}</code>
当前预览: <code>${htmlEscape(preview)}</code>

可用样式：
• <code>normal</code> - ${htmlEscape(styleExamples.normal)}
• <code>italic</code> - ${htmlEscape(styleExamples.italic)}
• <code>double</code> - ${htmlEscape(styleExamples.double)}
• <code>sans</code> - ${htmlEscape(styleExamples.sans)}
• <code>mono</code> - ${htmlEscape(styleExamples.mono)}
• <code>outline</code> - ${htmlEscape(styleExamples.outline)}

使用方法：
• <code>${mainPrefix}acn style italic</code>
• <code>${mainPrefix}acn style normal</code>`,
        parseMode: "html"
      });
      return;
    }

    if (!resolvedStyle || !validStyles.includes(resolvedStyle)) {
      await msg.edit({
        text: `❌ <b>无效的样式名称</b>

可用样式: <code>normal, italic, double, sans, mono, outline</code>
兼容旧名称: <code>style1 ~ style5</code>`,
        parseMode: "html"
      });
      return;
    }

    settings.text_style = resolvedStyle;
    const success = await DataManager.saveUserSettings(settings);
    if (!success) {
      await msg.edit({ text: "❌ 样式设置保存失败", parseMode: "html" });
      return;
    }

    if (settings.is_enabled) {
      await nameManager.updateUserProfile(userId, true);
    }

    const preview = nameManager.applyTextStyle("123abc ABC", settings.text_style);
    await msg.edit({
      text: `✅ <b>文字样式已更新</b>

当前样式: <code>${settings.text_style}</code>
预览: <code>${htmlEscape(preview)}</code>`,
      parseMode: "html"
    });
  }

  private async handleWeather(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const arg0 = (args[0] || "").toLowerCase();
    if (!arg0 || arg0 === "help" || arg0 === "h") {
      const preview = await nameManager.getWeatherCompact(settings);
      await msg.edit({
        text: `🌤️ <b>天气配置</b>

• 当前开关: <code>${settings.weather_enabled ? "开启" : "关闭"}</code>
• 地点: <code>${htmlEscape(settings.weather_location || "(未设置)")}</code>${preview ? `
• 当前预览: <code>${htmlEscape(preview)}</code>` : ""}

使用方法：
• <code>${mainPrefix}acn weather set 北京</code>
• <code>${mainPrefix}acn weather 北京</code>
• <code>${mainPrefix}acn weather on/off</code>`,
        parseMode: "html"
      });
      return;
    }

    if (arg0 === "on" || arg0 === "enable" || arg0 === "true") {
      if (!settings.weather_location?.trim()) {
        await msg.edit({
          text: `❌ <b>请先设置天气地点</b>\n\n使用 <code>${mainPrefix}acn weather set 北京</code> 或 <code>${mainPrefix}acn weather 北京</code>`,
          parseMode: "html"
        });
        return;
      }

      settings.weather_enabled = true;
      const success = await DataManager.saveUserSettings(settings);
      if (success && settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }
      const preview = await nameManager.getWeatherCompact(settings);
      await msg.edit({
        text: `✅ <b>天气显示已开启</b>\n\n地点: <code>${htmlEscape(settings.weather_location || "(未设置)")}</code>${preview ? `\n预览: <code>${htmlEscape(preview)}</code>` : ""}`,
        parseMode: "html"
      });
      return;
    }

    if (arg0 === "off" || arg0 === "disable" || arg0 === "false") {
      settings.weather_enabled = false;
      const success = await DataManager.saveUserSettings(settings);
      if (success) {
        if (settings.is_enabled) {
          await nameManager.updateUserProfile(userId, true);
        }
        await msg.edit({
          text: `✅ <b>天气显示已关闭</b>`,
          parseMode: "html"
        });
      } else {
        await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
      }
      return;
    }

    const locationInput = (arg0 === "set" ? args.slice(1) : args).join(" ").trim();
    if (locationInput.length === 0) {
      await msg.edit({ text: `❌ <b>未提供天气地点</b>\n\n请使用 <code>${mainPrefix}acn weather set 北京</code>`, parseMode: "html"});
      return;
    }

    settings.weather_location = locationInput;
    settings.weather_enabled = true;
    settings.weather_compact = "";
    settings.weather_cache_ts = 0;
    const success = await DataManager.saveUserSettings(settings);
    if (success) {
      if (settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }
      const preview = await nameManager.getWeatherCompact(settings);
      await msg.edit({
        text: `✅ <b>天气配置已更新</b>\n\n地点: <code>${htmlEscape(locationInput)}</code>\n天气显示: <code>已开启</code>${preview ? `\n预览: <code>${htmlEscape(preview)}</code>` : ""}`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 天气配置保存失败", parseMode: "html" });
    }
  }

  // 处理显示顺序设置
  private async handleDisplayOrder(msg: Api.Message, userId: number, args: string[]): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    if (args.length === 0) {
      // 显示当前顺序
      const currentOrder = settings.display_order || "name,time";
      const orderExamples = [
        "• <code>name,text,time,timezone,weather,emoji</code> → 张三 摸鱼中 09:30 GMT+8 ☀️ 23°C 🕐",
        "• <code>text,time,timezone,weather,name</code> → 摸鱼中 09:30 GMT+8 ☀️ 23°C 张三",
        "• <code>name,emoji,time,timezone,weather,text</code> → 张三 🕐 09:30 GMT+8 ☀️ 23°C 摸鱼中",
        "• <code>emoji,time,timezone,weather,text,name</code> → 🕐 09:30 GMT+8 ☀️ 23°C 摸鱼中 张三"
      ].join("\n");

      await msg.edit({
        text: `📋 <b>显示顺序设置</b>\n\n当前顺序: <code>${htmlEscape(currentOrder)}</code>\n\n<b>可用组件：</b>\n• <code>name</code> - 您的昵称\n• <code>text</code> - 随机文案\n• <code>time</code> - 当前时间\n• <code>weather</code> - 当前天气\n• <code>emoji</code> - 时钟表情\n• <code>timezone</code> - 时区显示\n\n<b>设置示例：</b>\n${orderExamples}\n\n使用 <code>${mainPrefix}acn order 组件1,组件2,...</code> 自定义顺序`,
        parseMode: "html"
      });
      return;
    }

    // 设置新顺序
    const newOrder = args.join("").toLowerCase();
    const validComponents = ["name", "text", "time", "weather", "emoji", "timezone"];
    const components = newOrder.split(",").map(s => s.trim());
    
    // 验证组件名称
    const invalidComponents = components.filter(comp => !validComponents.includes(comp));
    if (invalidComponents.length > 0) {
      await msg.edit({
        text: `❌ <b>无效的组件名称</b>\n\n无效组件: <code>${htmlEscape(invalidComponents.join(", "))}</code>\n\n有效组件: <code>name, text, time, weather, emoji, timezone</code>`,
        parseMode: "html"
      });
      return;
    }

    settings.display_order = newOrder;
    const success = await DataManager.saveUserSettings(settings);
    
    if (success) {
      if (settings.is_enabled) {
        await nameManager.updateUserProfile(userId, true);
      }
      await msg.edit({
        text: `✅ <b>显示顺序已更新</b>\n\n新顺序: <code>${htmlEscape(newOrder)}</code>\n\n昵称将按此顺序显示各个组件`,
        parseMode: "html"
      });
    } else {
      await msg.edit({ text: "❌ 设置保存失败", parseMode: "html" });
    }
  }

  // 显示当前配置
  private async handleShowConfig(msg: Api.Message, userId: number): Promise<void> {
    const settings = await requireSettings(userId, msg);
    if (!settings) return;

    const texts = await DataManager.getRandomTexts();
    const currentTime = nameManager.formatTime(settings.timezone);
    const clockEmoji = nameManager.getClockEmoji(settings.timezone);
    const tzDisplay = nameManager.getTimezoneDisplay(settings.timezone, settings.timezone_format);
    const weatherPreview = settings.weather_enabled && settings.weather_location
      ? await nameManager.getWeatherCompact(settings)
      : settings.weather_compact || "";
    const styledPreview = nameManager.applyTextStyle("123abc ABC", settings.text_style || "normal");

    const configText = `🔧 <b>当前配置</b>

<b>⚙️ 基础设置</b>
• 自动更新: <code>${settings.is_enabled ? "开启" : "关闭"}</code>
• 显示模式: <code>${settings.mode}</code>
• 显示组件: <code>${(settings.displayComponents || []).join(", ")}</code>
• 时区: <code>${settings.timezone}</code>
• 当前时间: <code>${currentTime}</code>

<b>🎨 显示选项</b>
• 时钟Emoji: <code>${settings.show_clock_emoji ? "开启" : "关闭"}</code>${settings.show_clock_emoji ? ` ${clockEmoji}` : ""}
• 时区显示: <code>${settings.show_timezone ? "开启" : "关闭"}</code>${settings.show_timezone ? ` ${tzDisplay}` : ""}
• 时区格式: <code>${settings.timezone_format || "GMT"}</code>
• 文字样式: <code>${settings.text_style || "normal"}</code>（预览: ${htmlEscape(styledPreview)}）
• 显示顺序: <code>${settings.display_order || "无（使用默认值）"}</code>

<b>🌤️ 天气</b>
• 天气显示: <code>${settings.weather_enabled ? "开启" : "关闭"}</code>
• 天气地点: <code>${htmlEscape(settings.weather_location || "(未设置)")}</code>
• 天气预览: <code>${htmlEscape(weatherPreview || "(暂无)")}</code>

<b>📝 文案</b>
• 文案数量: <code>${texts.length}</code>
• 当前索引: <code>${settings.text_index}</code>

<b>👤 原始昵称</b>
• 姓名: <code>${htmlEscape(settings.original_first_name || "(空)")}</code>
• 姓氏: <code>${htmlEscape(settings.original_last_name || "(空)")}</code>`;

    await msg.edit({ text: configText, parseMode: "html" });
  }

  // 处理重置
  private async handleReset(msg: Api.Message, userId: number): Promise<void> {
    const settings = await DataManager.getUserSettings(userId);
    if (!settings) {
      await msg.edit({ text: "❌ 未找到设置", parseMode: "html" });
      return;
    }

    try {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      await client.invoke(
        new Api.account.UpdateProfile({
          firstName: settings.original_first_name || "",
          lastName: settings.original_last_name || undefined
        })
      );

      settings.is_enabled = false;
      await DataManager.saveUserSettings(settings);

      await msg.edit({
        text: "✅ <b>已恢复原始昵称并禁用自动更新</b>",
        parseMode: "html"
      });
    } catch (error) {
      await msg.edit({ text: "❌ 重置失败，请检查权限", parseMode: "html" });
    }
  }

  // 插件初始化
  async init(): Promise<void> {
    try {
      // 初始化数据库（通过调用 getAllEnabledUsers 自动初始化）
      const enabledUsers = await DataManager.getAllEnabledUsers();
      
      // 检查所有启用的用户是否已保存原始昵称
      let validUsers = 0;
      const userDetails: string[] = [];
      
      for (const userId of enabledUsers) {
        const settings = await DataManager.getUserSettings(userId);
        if (settings && settings.original_first_name) {
          validUsers++;
          userDetails.push(`  - 用户 ${userId}: 模式=${settings.mode}, emoji=${settings.show_clock_emoji ? '开' : '关'}, 时区=${settings.show_timezone ? '开' : '关'}`);
        } else {
          // 如果发现用户没有保存原始昵称，自动禁用其自动更新
          if (settings) {
            console.warn(`[AutoChangeName] 用户 ${userId} 未保存原始昵称，已自动禁用自动更新`);
            settings.is_enabled = false;
            await DataManager.saveUserSettings(settings);
          }
        }
      }
      
      if (validUsers > 0) {
        nameManager.startAutoUpdate();
        console.log(`[AutoChangeName] 插件已启动，${validUsers} 个用户已启用自动更新`);
        if (userDetails.length > 0) {
          console.log('[AutoChangeName] 用户配置:');
          userDetails.forEach(detail => console.log(detail));
        }
      } else {
        console.log("[AutoChangeName] 插件已启动，暂无有效用户启用自动更新");
      }
    } catch (error) {
      console.error("[AutoChangeName] 插件初始化失败:", error);
    }
  }

  // 插件销毁
  destroy(): void {
    nameManager.cleanup();
    console.log("[AutoChangeName] 插件已停止并清理资源");
  }
}

// 创建并初始化插件实例
const plugin = new AutoChangeNamePlugin();

// 自动初始化（测试时可通过设置 TELEBOX_AUTO_INIT=false 跳过）
if (process.env.TELEBOX_AUTO_INIT !== 'false') {
  (async () => {
    try {
      await plugin.init();
    } catch (error) {
      console.error("[AutoChangeName] 自动初始化失败:", error);
    }
  })();
}

// 导出测试辅助（纯函数绑定，便于在不初始化插件的情况下进行单元测试）
export const __test__ = {
  htmlEscape,
  cleanTimeFromName: nameManager.cleanTimeFromName.bind(nameManager),
  formatTime: nameManager.formatTime.bind(nameManager),
  getClockEmoji: nameManager.getClockEmoji.bind(nameManager),
  getTimezoneDisplay: nameManager.getTimezoneDisplay.bind(nameManager),
  applyTextStyle: nameManager.applyTextStyle.bind(nameManager),
  generateNewName: nameManager.generateNewName.bind(nameManager)
};

// 导出插件实例
export default plugin;

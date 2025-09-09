import { Plugin } from "../src/utils/pluginBase";
import { getGlobalClient } from "../src/utils/globalClient";
import { getPrefixes } from "../src/utils/pluginManager";
import { Api } from "telegram";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义工具
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// Open-Meteo API 响应接口
interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  timezone_abbreviation: string;
  elevation: number;
  current?: {
    time: string;
    interval: number;
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    precipitation: number;
    rain: number;
    snowfall: number;
    weather_code: number;
    cloud_cover: number;
    pressure_msl: number;
    surface_pressure: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    wind_gusts_10m: number;
  };
  daily?: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    sunrise: string[];
    sunset: string[];
    precipitation_sum: number[];
    wind_speed_10m_max: number[];
  };
}

// 地理编码接口
interface GeocodingResult {
  results?: Array<{
    id: number;
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    country_code: string;
    admin1?: string;
    admin2?: string;
  }>;
}

// WMO天气代码映射
const weatherCodeMap: Record<number, { icon: string; description: string }> = {
  0: { icon: "☀️", description: "晴朗" },
  1: { icon: "🌤️", description: "大部晴朗" },
  2: { icon: "⛅", description: "部分多云" },
  3: { icon: "☁️", description: "阴天" },
  45: { icon: "🌫️", description: "有雾" },
  48: { icon: "🌫️", description: "沉积雾凇" },
  51: { icon: "🌦️", description: "轻度细雨" },
  53: { icon: "🌦️", description: "中度细雨" },
  55: { icon: "🌦️", description: "密集细雨" },
  56: { icon: "🌨️", description: "轻度冻雨" },
  57: { icon: "🌨️", description: "密集冻雨" },
  61: { icon: "🌧️", description: "轻度降雨" },
  63: { icon: "🌧️", description: "中度降雨" },
  65: { icon: "🌧️", description: "强降雨" },
  66: { icon: "🌨️", description: "轻度冻雨" },
  67: { icon: "🌨️", description: "强冻雨" },
  71: { icon: "❄️", description: "轻度降雪" },
  73: { icon: "❄️", description: "中度降雪" },
  75: { icon: "❄️", description: "强降雪" },
  77: { icon: "🌨️", description: "雪粒" },
  80: { icon: "🌦️", description: "轻度阵雨" },
  81: { icon: "🌧️", description: "中度阵雨" },
  82: { icon: "⛈️", description: "强阵雨" },
  85: { icon: "🌨️", description: "轻度阵雪" },
  86: { icon: "🌨️", description: "强阵雪" },
  95: { icon: "⛈️", description: "雷暴" },
  96: { icon: "⛈️", description: "轻度冰雹雷暴" },
  99: { icon: "⛈️", description: "强冰雹雷暴" }
};

// 风向计算
function calcWindDirection(deg: number): string {
  const dirs = ["北", "北东北", "东北", "东东北", "东", "东东南", "东南", "南东南",
                "南", "南西南", "西南", "西西南", "西", "西西北", "西北", "北西北"];
  const ix = Math.round(deg / 22.5);
  return dirs[ix % 16];
}

// 帮助文档
const help_text = `🌤️ <b>天气查询插件</b>

<b>📝 功能描述:</b>
• 🌡️ <b>实时天气</b>：查询全球城市实时天气信息
• 🌍 <b>自动识别</b>：自动识别中文城市名并转换
• 📊 <b>详细数据</b>：温度、湿度、风速、气压等
• 🌅 <b>日出日落</b>：显示当地日出日落时间
• 🆓 <b>完全免费</b>：使用 Open-Meteo 免费API

<b>🔧 使用方法:</b>
• <code>${mainPrefix}weather &lt;城市名&gt;</code> - 查询指定城市天气
• <code>${mainPrefix}weather help</code> - 显示此帮助

<b>💡 使用示例:</b>
• <code>${mainPrefix}weather 北京</code> - 查询北京天气
• <code>${mainPrefix}weather beijing</code> - 使用英文查询
• <code>${mainPrefix}weather New York</code> - 查询纽约天气
• <code>${mainPrefix}weather 东京</code> - 查询东京天气

<b>🌐 支持格式:</b>
• 中文城市名：自动翻译为英文（使用Google翻译）
• 英文城市名：直接查询
• 支持全球所有城市

<b>📌 注意事项:</b>
• 城市名不区分大小写
• 中文自动识别并转换
• 数据来源：Open-Meteo (免费、无需API密钥)`;

class WeatherPlugin extends Plugin {
  description: string = help_text;
  private apiUrl: string = "https://api.open-meteo.com/v1";
  private geocodingUrl: string = "https://geocoding-api.open-meteo.com/v1/search";

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    weather: async (msg: Api.Message) => await this.handleWeather(msg)
  };

  private async handleWeather(msg: Api.Message): Promise<void> {
    const client = await getGlobalClient();
    
    if (!client) {
      await msg.edit({
        text: "❌ <b>客户端未初始化</b>",
        parseMode: "html"
      });
      return;
    }
    
    try {
      // 参数解析（严格按acron.ts模式）
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      
      // 无参数时显示错误提示
      if (args.length === 0) {
        await msg.edit({
          text: `❌ <b>参数不足</b>\n\n💡 使用 <code>${mainPrefix}weather help</code> 查看帮助\n\n<b>快速示例:</b>\n• <code>${mainPrefix}weather 北京</code>\n• <code>${mainPrefix}weather Shanghai</code>\n• <code>${mainPrefix}weather New York</code>`,
          parseMode: "html"
        });
        return;
      }

      // 明确请求帮助时才显示
      if (args[0].toLowerCase() === "help" || args[0].toLowerCase() === "h") {
        await msg.edit({
          text: help_text,
          parseMode: "html"
        });
        return;
      }

      let cityName = args.join(' ');
      const originalCityInput = cityName;
      
      // 渐进式状态反馈
      await msg.edit({ 
        text: `🔍 <b>正在识别城市...</b>\n<i>${htmlEscape(originalCityInput)}</i>`, 
        parseMode: "html" 
      });

      // 自动检测并转换中文
      cityName = await this.processCityName(cityName);
      
      // 如果进行了翻译，显示翻译结果
      if (cityName !== originalCityInput) {
        await msg.edit({ 
          text: `🌍 <b>正在搜索...</b>\n<i>${htmlEscape(originalCityInput)} → ${htmlEscape(cityName)}</i>`, 
          parseMode: "html" 
        });
      } else {
        await msg.edit({ 
          text: `🌍 <b>正在搜索 ${htmlEscape(cityName)}...</b>`, 
          parseMode: "html" 
        });
      }
      
      // 动态导入axios
      const axios = (await import("axios")).default;
      
      // 地理编码：获取城市坐标
      const geoResponse = await axios.get(this.geocodingUrl, {
        params: {
          name: cityName,
          count: 10,
          language: "zh",
          format: "json"
        },
        timeout: 10000
      });

      if (!geoResponse.data.results || geoResponse.data.results.length === 0) {
        await msg.edit({
          text: `❌ <b>城市未找到</b>\n\n无法找到城市: <code>${htmlEscape(originalCityInput)}</code>\n\n<b>💡 建议:</b>\n• 检查城市名拼写\n• 尝试使用英文名称\n• 尝试添加国家名，如: Beijing China\n\n<b>示例:</b>\n• <code>${mainPrefix}weather beijing</code>\n• <code>${mainPrefix}weather 上海</code>\n• <code>${mainPrefix}weather London</code>`,
          parseMode: "html"
        });
        return;
      }

      // 选择第一个匹配结果
      const location = geoResponse.data.results[0];
      
      // 构建位置名称，过滤undefined的地区信息
      const locationParts = [];
      
      // 主要城市名
      if (location.name && location.name !== 'undefined') {
        locationParts.push(location.name);
      }
      
      // 省/州级行政区
      if (location.admin1 && location.admin1 !== 'undefined' && location.admin1 !== location.name) {
        locationParts.push(location.admin1);
      }
      
      // 国家名
      if (location.country && location.country !== 'undefined') {
        locationParts.push(location.country);
      }
      
      const locationName = locationParts.join(', ');
      
      await msg.edit({ 
        text: `🌡️ <b>正在获取 ${htmlEscape(locationName)} 的天气...</b>`, 
        parseMode: "html" 
      });

      // 获取天气数据
      const weatherResponse = await axios.get(`${this.apiUrl}/forecast`, {
        params: {
          latitude: location.latitude,
          longitude: location.longitude,
          current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
          daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,wind_speed_10m_max",
          timezone: "auto",
          forecast_days: 1
        },
        timeout: 10000
      });

      const data: OpenMeteoResponse = weatherResponse.data;
      
      if (!data.current) {
        await msg.edit({
          text: "❌ <b>无法获取天气数据</b>",
          parseMode: "html"
        });
        return;
      }

      // 构建天气报告
      const weatherReport = this.buildWeatherReport(data, locationName);
      
      await msg.edit({
        text: weatherReport,
        parseMode: "html"
      });
      
    } catch (error: any) {
      console.error("[weather] 插件执行失败:", error);
      
      // 检查是否为超时错误
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
        await msg.edit({
          text: `❌ <b>请求超时</b>\n\n网络连接缓慢，请稍后重试`,
          parseMode: "html"
        });
        return;
      }
      
      await msg.edit({
        text: `❌ <b>查询失败</b>\n\n${htmlEscape(error.message || '未知错误')}\n\n请检查网络连接或稍后重试`,
        parseMode: "html"
      });
    }
  }

  // 处理城市名（使用Google翻译API）
  private async processCityName(cityName: string): Promise<string> {
    // 快速映射常见城市（提高响应速度）
    const quickMap: Record<string, string> = {
      // 中国城市
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
      "长沙": "Changsha",
      "郑州": "Zhengzhou",
      "青岛": "Qingdao",
      "大连": "Dalian",
      "厦门": "Xiamen",
      "香港": "Hong Kong",
      "澳门": "Macau",
      "台北": "Taipei",
      // 亚洲城市
      "东京": "Tokyo",
      "大阪": "Osaka",
      "京都": "Kyoto",
      "首尔": "Seoul",
      "釜山": "Busan",
      "曼谷": "Bangkok",
      "新加坡": "Singapore",
      "吉隆坡": "Kuala Lumpur",
      "雅加达": "Jakarta",
      "马尼拉": "Manila",
      "河内": "Hanoi",
      "胡志明市": "Ho Chi Minh City",
      "迪拜": "Dubai",
      "新德里": "New Delhi",
      "孟买": "Mumbai",
      // 欧美城市
      "伦敦": "London",
      "巴黎": "Paris",
      "柏林": "Berlin",
      "罗马": "Rome",
      "马德里": "Madrid",
      "巴塞罗那": "Barcelona",
      "阿姆斯特丹": "Amsterdam",
      "莫斯科": "Moscow",
      "纽约": "New York",
      "洛杉矶": "Los Angeles",
      "旧金山": "San Francisco",
      "芝加哥": "Chicago",
      "华盛顿": "Washington",
      "波士顿": "Boston",
      "西雅图": "Seattle",
      "多伦多": "Toronto",
      "温哥华": "Vancouver",
      // 大洋洲
      "悉尼": "Sydney",
      "墨尔本": "Melbourne",
      "奥克兰": "Auckland",
      "惠灵顿": "Wellington"
    };
    
    // 优先使用快速映射
    if (quickMap[cityName]) {
      console.log(`[weather] 使用快速映射: ${cityName} -> ${quickMap[cityName]}`);
      return quickMap[cityName];
    }
    
    // 如果没有中文字符，直接返回
    if (!/[\u4e00-\u9fa5]/.test(cityName)) {
      return cityName;
    }
    
    // 使用Google翻译API将中文翻译为英文
    try {
      console.log(`[weather] 正在翻译中文地名: ${cityName}`);
      
      // 动态导入翻译库
      const translateModule = await import("@vitalets/google-translate-api");
      const translate = translateModule.translate || translateModule.default;
      
      if (!translate || typeof translate !== "function") {
        console.error("[weather] 翻译服务未正确加载");
        return cityName;
      }
      
      // 执行翻译
      const translateOptions = {
        to: "en",
        timeout: 5000, // 5秒超时
      };
      
      const result = await translate(cityName, translateOptions);
      const translated = result?.text || result;
      
      if (!translated || typeof translated !== "string" || translated.trim() === "") {
        console.error("[weather] 翻译结果为空");
        return cityName;
      }
      
      console.log(`[weather] 翻译成功: ${cityName} -> ${translated}`);
      return translated.trim();
      
    } catch (error: any) {
      console.error(`[weather] 翻译失败，使用原始输入: ${error.message}`);
      return cityName;
    }
  }

  // 构建天气报告
  private buildWeatherReport(data: OpenMeteoResponse, locationName: string): string {
    const current = data.current!;
    const daily = data.daily!;
    
    // 获取天气图标和描述
    const weatherInfo = weatherCodeMap[current.weather_code] || { icon: "🌤️", description: "未知" };
    
    // 风向
    const windDir = calcWindDirection(current.wind_direction_10m);
    
    // 日出日落时间
    const sunrise = daily.sunrise[0].split('T')[1].substring(0, 5);
    const sunset = daily.sunset[0].split('T')[1].substring(0, 5);
    
    let result = `<b>📍 ${htmlEscape(locationName)}</b>\n\n`;
    result += `${weatherInfo.icon} <b>${weatherInfo.description}</b>\n\n`;
    result += `🌡️ <b>温度:</b> ${current.temperature_2m}°C\n`;
    result += `🤔 <b>体感:</b> ${current.apparent_temperature}°C\n`;
    result += `📊 <b>今日最高/最低:</b> ${daily.temperature_2m_max[0]}°C / ${daily.temperature_2m_min[0]}°C\n`;
    result += `💧 <b>湿度:</b> ${current.relative_humidity_2m}%\n`;
    result += `💨 <b>风速:</b> ${current.wind_speed_10m} km/h (${windDir}风)\n`;
    
    if (current.wind_gusts_10m > 0) {
      result += `🌪️ <b>阵风:</b> ${current.wind_gusts_10m} km/h\n`;
    }
    
    result += `🔵 <b>气压:</b> ${Math.round(current.pressure_msl)} hPa\n`;
    result += `☁️ <b>云量:</b> ${current.cloud_cover}%\n`;
    
    if (current.precipitation > 0) {
      result += `🌧️ <b>降水量:</b> ${current.precipitation} mm\n`;
    }
    if (current.rain > 0) {
      result += `☔ <b>降雨量:</b> ${current.rain} mm\n`;
    }
    if (current.snowfall > 0) {
      result += `❄️ <b>降雪量:</b> ${current.snowfall} cm\n`;
    }
    
    result += `🌅 <b>日出:</b> ${sunrise}\n`;
    result += `🌇 <b>日落:</b> ${sunset}\n\n`;
    
    // 天气预警
    const warnings = this.checkWeatherWarnings(current, daily);
    if (warnings.length > 0) {
      result += `<b>⚠️ 天气提醒</b>\n`;
      for (const warning of warnings) {
        result += `${warning}\n`;
      }
      result += `\n`;
    }
    
    result += `<i>数据来源: Open-Meteo (免费API)</i>`;
    
    return result;
  }

  // 检查天气预警
  private checkWeatherWarnings(current: any, daily: any): string[] {
    const warnings: string[] = [];
    
    // 极端温度
    if (current.temperature_2m > 35) {
      warnings.push(`🔥 高温预警：${current.temperature_2m}°C`);
    } else if (current.temperature_2m < -10) {
      warnings.push(`❄️ 低温预警：${current.temperature_2m}°C`);
    }
    
    // 强风
    if (current.wind_speed_10m > 40) {
      warnings.push(`💨 大风预警：风速 ${current.wind_speed_10m} km/h`);
    }
    
    // 强降水
    if (current.precipitation > 10) {
      warnings.push(`🌧️ 强降水预警：${current.precipitation} mm`);
    }
    
    // 特殊天气
    const code = current.weather_code;
    if (code >= 95 && code <= 99) {
      warnings.push(`⛈️ 雷暴预警：请注意安全`);
    } else if (code >= 71 && code <= 77) {
      warnings.push(`🌨️ 降雪预警：路面可能结冰`);
    } else if (code === 45 || code === 48) {
      warnings.push(`🌫️ 大雾预警：能见度低`);
    }
    
    return warnings;
  }
}

export default new WeatherPlugin();

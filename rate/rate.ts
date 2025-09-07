import { Api } from "telegram";
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";


interface CoinGeckoResponse {
  [coinId: string]: {
    [key: string]: number;
  } & {
    last_updated_at?: number;
  };
}

// HTML转义工具
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

const help_text = `🚀 <b>智能加密货币汇率助手</b>

💡 <b>快速查询</b>
• <code>rate BTC</code> - 实时价格查询
• <code>rate ETH CNY</code> - 指定法币价格

💰 <b>精准换算</b>
• <code>rate BTC CNY 0.5</code> - 加密货币转法币
• <code>rate CNY USDT 7000</code> - 法币转加密货币
• <code>rate BTC USDT 1</code> - 加密货币间兑换

▎支持的币种

主流币种: BTC/比特币 • ETH/以太坊 • BNB/币安币 • ADA/艾达币 • DOT/波卡 • SOL/索拉纳 • AVAX/雪崩 • MATIC/马蹄 • LINK/链接 • UNI/独角兽 • LTC/莱特币 • XRP/瑞波币 • DOGE/狗狗币 • SHIB/柴犬币

稳定币: USDT/泰达币 • USDC/美元币 • BUSD/币安美元 • DAI/戴币 • TUSD/真美元 • USDP/帕克索斯 • GUSD/双子星美元 • HUSD/火币美元 • FEI • FRAX • LUSD

▎支持的法币

主要法币: USD/美元 • CNY/人民币 • EUR/欧元 • JPY/日元 • KRW/韩元 • GBP/英镑 • TRY/土耳其里拉 • NGN/尼日利亚奈拉 • AUD/澳元 • CAD/加元 • CHF/瑞士法郎 • HKD/港币 • SGD/新加坡元 • INR/印度卢比 • THB/泰铢 • RUB/俄罗斯卢布 • BRL/巴西雷亚尔 • MXN/墨西哥比索 • SAR/沙特里亚尔

▎示例

• <code>rate btc</code> - 比特币美元价格
• <code>rate eth cny</code> - 以太坊人民币价格
• <code>rate usdt cny 1000</code> - 1000 USDT 换算人民币
• <code>rate cny usdt 7000</code> - 7000 人民币换算 USDT
• <code>汇率 比特币 人民币 0.5</code> - 0.5个比特币价值`;

class RatePlugin extends Plugin {
  description: string = `加密货币汇率查询 & 数量换算\n\n${help_text}`;

  // 支持的加密货币映射
  private cryptoMap: Record<string, string> = {
    // 主流币种
    'btc': 'bitcoin',
    'bitcoin': 'bitcoin',
    '比特币': 'bitcoin',
    'eth': 'ethereum',
    'ethereum': 'ethereum',
    '以太坊': 'ethereum',
    'bnb': 'binancecoin',
    'binance': 'binancecoin',
    '币安币': 'binancecoin',
    'ada': 'cardano',
    'cardano': 'cardano',
    '艾达币': 'cardano',
    'dot': 'polkadot',
    'polkadot': 'polkadot',
    '波卡': 'polkadot',
    'sol': 'solana',
    'solana': 'solana',
    '索拉纳': 'solana',
    'avax': 'avalanche-2',
    'avalanche': 'avalanche-2',
    '雪崩': 'avalanche-2',
    'matic': 'matic-network',
    'polygon': 'matic-network',
    '马蹄': 'matic-network',
    'link': 'chainlink',
    'chainlink': 'chainlink',
    '链接': 'chainlink',
    'uni': 'uniswap',
    'uniswap': 'uniswap',
    '独角兽': 'uniswap',
    'ltc': 'litecoin',
    'litecoin': 'litecoin',
    '莱特币': 'litecoin',
    'xrp': 'ripple',
    'ripple': 'ripple',
    '瑞波币': 'ripple',
    'doge': 'dogecoin',
    'dogecoin': 'dogecoin',
    '狗狗币': 'dogecoin',
    'shib': 'shiba-inu',
    'shiba': 'shiba-inu',
    '柴犬币': 'shiba-inu',
    
    // 稳定币
    'usdt': 'tether',
    'tether': 'tether',
    '泰达币': 'tether',
    'usdc': 'usd-coin',
    'usdcoin': 'usd-coin',
    '美元币': 'usd-coin',
    'busd': 'binance-usd',
    'binanceusd': 'binance-usd',
    '币安美元': 'binance-usd',
    'dai': 'dai',
    'makerdao': 'dai',
    '戴币': 'dai',
    'tusd': 'true-usd',
    'trueusd': 'true-usd',
    '真美元': 'true-usd',
    'pax': 'paxos-standard',
    'paxos': 'paxos-standard',
    'usdp': 'paxos-standard',
    '帕克索斯': 'paxos-standard',
    'gusd': 'gemini-dollar',
    'geminidollar': 'gemini-dollar',
    '双子星美元': 'gemini-dollar',
    'husd': 'husd',
    '火币美元': 'husd',
    'fei': 'fei-usd',
    'feiusd': 'fei-usd',
    'frax': 'frax',
    '分数算法': 'frax',
    'lusd': 'liquity-usd',
    'liquityusd': 'liquity-usd',
    '流动性美元': 'liquity-usd'
  };

  // 支持的法币 (基于CoinGecko API支持的货币)
  private fiatMap: Record<string, string> = {
    // 主要货币
    'usd': 'usd',
    '美元': 'usd',
    'cny': 'cny',
    '人民币': 'cny',
    'eur': 'eur',
    '欧元': 'eur',
    'jpy': 'jpy',
    '日元': 'jpy',
    'krw': 'krw',
    '韩元': 'krw',
    'gbp': 'gbp',
    '英镑': 'gbp',
    
    // 新增货币
    'try': 'try',
    '土耳其里拉': 'try',
    '里拉': 'try',
    'ngn': 'ngn',
    '尼日利亚奈拉': 'ngn',
    '奈拉': 'ngn',
    
    // 其他常用货币
    'aud': 'aud',
    '澳元': 'aud',
    'cad': 'cad',
    '加元': 'cad',
    'chf': 'chf',
    '瑞士法郎': 'chf',
    'hkd': 'hkd',
    'hkt': 'hkd', // 常见误写
    '港币': 'hkd',
    'sgd': 'sgd',
    '新加坡元': 'sgd',
    'nzd': 'nzd',
    '新西兰元': 'nzd',
    'sek': 'sek',
    '瑞典克朗': 'sek',
    'nok': 'nok',
    '挪威克朗': 'nok',
    'dkk': 'dkk',
    '丹麦克朗': 'dkk',
    'pln': 'pln',
    '波兰兹罗提': 'pln',
    'czk': 'czk',
    '捷克克朗': 'czk',
    'huf': 'huf',
    '匈牙利福林': 'huf',
    'ron': 'ron',
    '罗马尼亚列伊': 'ron',
    'bgn': 'bgn',
    '保加利亚列弗': 'bgn',
    'hrk': 'hrk',
    '克罗地亚库纳': 'hrk',
    'rub': 'rub',
    '俄罗斯卢布': 'rub',
    'uah': 'uah',
    '乌克兰格里夫纳': 'uah',
    'inr': 'inr',
    '印度卢比': 'inr',
    'thb': 'thb',
    '泰铢': 'thb',
    'myr': 'myr',
    '马来西亚林吉特': 'myr',
    'idr': 'idr',
    '印尼盾': 'idr',
    'php': 'php',
    '菲律宾比索': 'php',
    'vnd': 'vnd',
    '越南盾': 'vnd',
    'pkr': 'pkr',
    '巴基斯坦卢比': 'pkr',
    'lkr': 'lkr',
    '斯里兰卡卢比': 'lkr',
    'bdt': 'bdt',
    '孟加拉塔卡': 'bdt',
    'mmk': 'mmk',
    '缅甸缅元': 'mmk',
    'sar': 'sar',
    '沙特里亚尔': 'sar',
    'aed': 'aed',
    '阿联酋迪拉姆': 'aed',
    'ils': 'ils',
    '以色列新谢克尔': 'ils',
    'zar': 'zar',
    '南非兰特': 'zar',
    'brl': 'brl',
    '巴西雷亚尔': 'brl',
    'ars': 'ars',
    '阿根廷比索': 'ars',
    'clp': 'clp',
    '智利比索': 'clp',
    'cop': 'cop',
    '哥伦比亚比索': 'cop',
    'pen': 'pen',
    '秘鲁索尔': 'pen',
    'mxn': 'mxn',
    '墨西哥比索': 'mxn'
  };

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    rate: async (msg: Api.Message) => {
      await this.handleRate(msg);
    }
  };

  private async fetchCryptoPrice(coinIds: string[], currencies: string[]): Promise<CoinGeckoResponse> {
    let axios: any;
    
    try {
      // 动态导入axios
      const axiosModule = await import("axios");
      axios = axiosModule.default || axiosModule;
      
      if (!axios || typeof axios.get !== "function") {
        throw new Error("Axios未正确加载");
      }
    } catch (importError: any) {
      console.error("Failed to import axios:", importError);
      throw new Error(`网络库加载失败: ${importError.message || importError}`);
    }

    try {
      const coinIdsStr = coinIds.join(',');
      const currenciesStr = currencies.join(',');
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinIdsStr}&vs_currencies=${currenciesStr}&include_last_updated_at=true`;
      
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'TeleBox-Rate-Plugin/1.0',
          'Accept': 'application/json'
        }
      });
      
      if (response.status !== 200) {
        throw new Error(`API请求失败: ${response.status}`);
      }
      
      return response.data;
    } catch (error: any) {
      console.error('[RatePlugin] 获取加密货币价格失败:', error);
      
      if (error.code === 'ECONNABORTED') {
        throw new Error('请求超时，请检查网络连接');
      } else if (error.response) {
        throw new Error(`API错误: ${error.response.status} - ${error.response.statusText}`);
      } else if (error.request) {
        throw new Error('网络连接失败，请检查网络设置');
      } else {
        throw new Error(`请求失败: ${error.message}`);
      }
    }
  }

  private formatPrice(price: number, currency: string): string {
    const currencySymbols: Record<string, string> = {
      'usd': '$',
      'cny': '¥',
      'eur': '€',
      'jpy': '¥',
      'krw': '₩',
      'gbp': '£',
      'try': '₺',
      'ngn': '₦',
      'aud': 'A$',
      'cad': 'C$',
      'chf': 'CHF',
      'hkd': 'HK$',
      'sgd': 'S$',
      'nzd': 'NZ$',
      'sek': 'kr',
      'nok': 'kr',
      'dkk': 'kr',
      'pln': 'zł',
      'czk': 'Kč',
      'huf': 'Ft',
      'ron': 'lei',
      'bgn': 'лв',
      'hrk': 'kn',
      'rub': '₽',
      'uah': '₴',
      'inr': '₹',
      'thb': '฿',
      'myr': 'RM',
      'idr': 'Rp',
      'php': '₱',
      'vnd': '₫',
      'pkr': '₨',
      'lkr': '₨',
      'bdt': '৳',
      'mmk': 'K',
      'sar': '﷼',
      'aed': 'د.إ',
      'ils': '₪',
      'zar': 'R',
      'brl': 'R$',
      'ars': '$',
      'clp': '$',
      'cop': '$',
      'pen': 'S/',
      'mxn': '$'
    };

    const symbol = currencySymbols[currency.toLowerCase()] || currency.toUpperCase();
    
    if (price >= 1) {
      return `${symbol}${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else if (price >= 0.01) {
      return `${symbol}${price.toFixed(4)}`;
    } else {
      return `${symbol}${price.toFixed(8)}`;
    }
  }

  private getCoinName(coinId: string): string {
    const nameMap: Record<string, string> = {
      // 主流币种
      'bitcoin': '比特币 (BTC)',
      'ethereum': '以太坊 (ETH)',
      'binancecoin': '币安币 (BNB)',
      'cardano': '艾达币 (ADA)',
      'polkadot': '波卡 (DOT)',
      'solana': '索拉纳 (SOL)',
      'avalanche-2': '雪崩 (AVAX)',
      'matic-network': '马蹄 (MATIC)',
      'chainlink': '链接 (LINK)',
      'uniswap': '独角兽 (UNI)',
      'litecoin': '莱特币 (LTC)',
      'ripple': '瑞波币 (XRP)',
      'dogecoin': '狗狗币 (DOGE)',
      'shiba-inu': '柴犬币 (SHIB)',
      
      // 稳定币
      'tether': '泰达币 (USDT)',
      'usd-coin': '美元币 (USDC)',
      'binance-usd': '币安美元 (BUSD)',
      'dai': '戴币 (DAI)',
      'true-usd': '真美元 (TUSD)',
      'paxos-standard': '帕克索斯 (USDP)',
      'gemini-dollar': '双子星美元 (GUSD)',
      'husd': '火币美元 (HUSD)',
      'fei-usd': 'FEI美元 (FEI)',
      'frax': '分数算法 (FRAX)',
      'liquity-usd': '流动性美元 (LUSD)'
    };
    return nameMap[coinId] || coinId.toUpperCase();
  }

  private async handleRate(msg: Api.Message): Promise<void> {
    const text = msg.text?.trim() || "";
    const parts = text.split(/\s+/) || [];
    const [, ...args] = parts; // 跳过命令本身

    try {
      if (!args[0]) {
        await msg.edit({
          text: help_text,
          parseMode: "html",
        });
        return;
      }

      if (args[0] === 'help' || args[0] === 'h') {
        await msg.edit({
          text: help_text,
          parseMode: "html",
        });
        return;
      }

      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      await msg.edit({ text: "⚡ 正在获取最新汇率数据...", parseMode: "html" });
      
      // 解析参数 - 智能识别货币类型
      const input1 = args[0]?.toLowerCase();
      const input2 = args[1]?.toLowerCase() || 'usd';
      const amountStr = args[2];
      let amount = 1;

      // 检查是否为数量转换
      if (amountStr && !isNaN(parseFloat(amountStr))) {
        amount = parseFloat(amountStr);
      }

      // 智能识别货币类型
      const isCrypto1 = this.cryptoMap[input1!] !== undefined;
      const isFiat1 = this.fiatMap[input1!] !== undefined;
      const isCrypto2 = this.cryptoMap[input2!] !== undefined;
      const isFiat2 = this.fiatMap[input2!] !== undefined;

      let cryptoInput: string;
      let fiatInput: string;
      let isReverse = false;
      let isCryptoCrypto = false;
      let targetCrypto: string | undefined;

      // 智能判断货币类型组合
      if (isCrypto1 && isFiat2) {
        // 加密货币 -> 法币 (正向)
        cryptoInput = input1!;
        fiatInput = input2!;
        isReverse = false;
      } else if (isFiat1 && isCrypto2) {
        // 法币 -> 加密货币 (反向)
        cryptoInput = input2!;
        fiatInput = input1!;
        isReverse = true;
      } else if (isCrypto1 && isCrypto2) {
        // 加密货币间转换
        cryptoInput = input1!;
        targetCrypto = input2!;
        fiatInput = 'usd';
        isReverse = false;
        isCryptoCrypto = true;
      } else if (isCrypto1 && !input2) {
        // 只有加密货币，默认美元
        cryptoInput = input1!;
        fiatInput = 'usd';
        isReverse = false;
      } else if (isFiat1 && !input2) {
        // 只有法币，错误情况
        await msg.edit({
          text: `🚫 <b>输入有误</b>\n\n请指定要查询的加密货币\n\n✨ <b>正确格式:</b> <code>rate BTC CNY 100</code>`,
          parseMode: "html"
        });
        return;
      } else {
        // 无法识别的组合
        const unknownCurrency = !isCrypto1 && !isFiat1 ? input1 : input2;
        await msg.edit({
          text: `🔍 <b>未识别的货币:</b> "${htmlEscape(unknownCurrency!)}"\n\n📋 输入 <code>rate help</code> 查看完整支持列表`,
          parseMode: "html"
        });
        return;
      }

      // 获取标准化名称
      const cryptoId = this.cryptoMap[cryptoInput];
      const fiatCurrency = this.fiatMap[fiatInput];

      // 验证货币映射（理论上不应该失败，因为上面已经检查过）
      if (!cryptoId || !fiatCurrency) {
        await msg.edit({
          text: `❌ <b>系统错误:</b> 货币映射失败\n\n💡 请重试或联系管理员`,
          parseMode: "html"
        });
        return;
      }

      // 显示加载状态
      await msg.edit({
        text: "🔍 正在获取最新汇率...",
        parseMode: "html"
      });

      // 调用CoinGecko API
      const axios = (await import('axios')).default;
      const response = await axios.get<CoinGeckoResponse>(
        `https://api.coingecko.com/api/v3/simple/price?ids=${cryptoId}&vs_currencies=${fiatCurrency}&include_last_updated_at=true`
      );

      const priceData = response.data[cryptoId];
      if (!priceData || !priceData[fiatCurrency]) {
        await msg.edit({
          text: "❌ <b>API错误:</b> 无法获取价格数据，请稍后重试",
          parseMode: "html"
        });
        return;
      }

      const price = priceData[fiatCurrency];
      const lastUpdated = priceData.last_updated_at ? new Date(priceData.last_updated_at * 1000) : new Date();

      // 格式化价格显示 - 显示完整数字
      const formatPrice = (value: number): string => {
        if (value >= 1) {
          return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        } else if (value >= 0.01) {
          return value.toFixed(4);
        } else if (value >= 0.0001) {
          return value.toFixed(6);
        } else {
          return value.toExponential(2);
        }
      };

      // 格式化数量显示 - 显示完整数字
      const formatAmount = (value: number): string => {
        if (value >= 1) {
          return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        } else {
          return value.toFixed(6);
        }
      };

      // 构建响应消息
      let responseText: string;
      
      if (isCryptoCrypto) {
        // 加密货币间转换 - 需要获取目标加密货币价格
        const targetCryptoId = this.cryptoMap[targetCrypto!];
        if (!targetCryptoId) {
          await msg.edit({
            text: `🔍 <b>未识别的目标货币:</b> "${htmlEscape(targetCrypto!)}"\n\n📋 输入 <code>rate help</code> 查看完整支持列表`,
            parseMode: "html"
          });
          return;
        }

        // 获取目标加密货币价格
        const targetResponse = await this.fetchCryptoPrice([targetCryptoId], ['usd']);
        const targetPriceData = targetResponse[targetCryptoId];
        
        if (!targetPriceData || !targetPriceData.usd) {
          await msg.edit({
            text: "❌ <b>API错误:</b> 无法获取目标货币价格数据，请稍后重试",
            parseMode: "html"
          });
          return;
        }

        const targetPrice = targetPriceData.usd;
        const conversionRate = price / targetPrice;
        const convertedAmount = amount * conversionRate;
        
        const sourceCryptoSymbol = Object.keys(this.cryptoMap).find(key => this.cryptoMap[key] === cryptoId)?.toUpperCase() || cryptoId?.toUpperCase() || 'UNKNOWN';
        const targetCryptoSymbol = Object.keys(this.cryptoMap).find(key => this.cryptoMap[key] === targetCryptoId)?.toUpperCase() || targetCryptoId?.toUpperCase() || 'UNKNOWN';
        
        responseText = `🔄 <b>加密货币间兑换</b>\n\n` +
          `<code>${formatAmount(amount)} ${sourceCryptoSymbol} ≈</code>\n` +
          `<code>${formatAmount(convertedAmount)} ${targetCryptoSymbol}</code>\n\n` +
          `💎 <b>兑换比率:</b> <code>1 ${sourceCryptoSymbol} = ${formatAmount(conversionRate)} ${targetCryptoSymbol}</code>\n` +
          `📊 <b>基准价格:</b> <code>${sourceCryptoSymbol} $${formatPrice(price)} • ${targetCryptoSymbol} $${formatPrice(targetPrice)}</code>\n` +
          `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      } else if (isReverse) {
        // 法币到加密货币的转换
        const cryptoAmount = amount / price;
        const cryptoSymbol = Object.keys(this.cryptoMap).find(key => this.cryptoMap[key] === cryptoId)?.toUpperCase() || cryptoId?.toUpperCase() || 'UNKNOWN';
        const fiatSymbol = Object.keys(this.fiatMap).find(key => this.fiatMap[key] === fiatCurrency)?.toUpperCase() || fiatCurrency?.toUpperCase() || 'UNKNOWN';
        
        responseText = `💱 <b>法币兑换加密货币</b>\n\n` +
          `<code>${formatAmount(amount)} ${fiatSymbol} ≈</code>\n` +
          `<code>${formatAmount(cryptoAmount)} ${cryptoSymbol}</code>\n\n` +
          `💎 <b>当前汇率:</b> <code>1 ${cryptoSymbol} = ${formatPrice(price)} ${fiatSymbol}</code>\n` +
          `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      } else if (amount !== 1) {
        // 加密货币到法币的数量转换
        const totalValue = amount * price;
        const cryptoSymbol = Object.keys(this.cryptoMap).find(key => this.cryptoMap[key] === cryptoId)?.toUpperCase() || cryptoId?.toUpperCase() || 'UNKNOWN';
        const fiatSymbol = Object.keys(this.fiatMap).find(key => this.fiatMap[key] === fiatCurrency)?.toUpperCase() || fiatCurrency?.toUpperCase() || 'UNKNOWN';
        
        responseText = `🪙 <b>加密货币兑换法币</b>\n\n` +
          `<code>${formatAmount(amount)} ${cryptoSymbol} ≈</code>\n` +
          `<code>${formatAmount(totalValue)} ${fiatSymbol}</code>\n\n` +
          `💎 <b>当前汇率:</b> <code>1 ${cryptoSymbol} = ${formatPrice(price)} ${fiatSymbol}</code>\n` +
          `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      } else {
        // 基础价格查询
        const cryptoSymbol = Object.keys(this.cryptoMap).find(key => this.cryptoMap[key] === cryptoId)?.toUpperCase() || cryptoId?.toUpperCase() || 'UNKNOWN';
        const fiatSymbol = Object.keys(this.fiatMap).find(key => this.fiatMap[key] === fiatCurrency)?.toUpperCase() || fiatCurrency?.toUpperCase() || 'UNKNOWN';
        
        responseText = `📈 <b>实时市场价格</b>\n\n` +
          `<code>1 ${cryptoSymbol} = ${formatPrice(price)} ${fiatSymbol}</code>\n\n` +
          `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      }

      await msg.edit({
        text: responseText,
        parseMode: "html"
      });  
    } catch (error: any) {
      console.error('[Rate Plugin] 操作失败:', error);
      await msg.edit({ 
        text: `❌ 操作失败: ${error?.message || error}`,
        parseMode: "html"
      });
    }
  }

  private formatCryptoAmount(amount: number): string {
    if (amount >= 1) {
      return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
    } else if (amount >= 0.000001) {
      return amount.toFixed(8);
    } else {
      return amount.toExponential(4);
    }
  }
}

export default new RatePlugin();

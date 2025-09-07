import { Api } from "telegram";
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import axios, { AxiosError } from "axios";


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

const help_text = `🚀 <b>智能汇率查询助手</b>

💡 <b>支持功能</b>
• 加密货币实时价格
• 法币汇率转换
• 多币种智能换算

📊 <b>使用示例</b>
• <code>rate BTC</code> - 比特币美元价
• <code>rate ETH CNY</code> - 以太坊人民币价
• <code>rate CNY TRY</code> - 人民币兑土耳其里拉
• <code>rate BTC CNY 0.5</code> - 0.5个BTC换算
• <code>rate CNY USDT 7000</code> - 7000元换USDT

💰 <b>常用加密货币</b>
BTC ETH BNB SOL XRP ADA DOGE
MATIC AVAX DOT SHIB LTC UNI LINK
USDT USDC BUSD DAI

💵 <b>常用法币</b>
USD CNY EUR JPY GBP KRW TRY
RUB INR AUD CAD HKD SGD THB
BRL MXN SAR AED TWD CHF

💡 <b>小贴士</b>
• 支持所有CoinGecko上的加密货币和法币
• 货币代码不区分大小写
• 可添加数量进行换算
• 法币优先：TRY=土耳其里拉，USD=美元等`;

class RatePlugin extends Plugin {
  description: string = `加密货币汇率查询 & 数量换算\n\n${help_text}`;

  // 货币缓存 - 提高性能，避免重复API调用
  private currencyCache: Record<string, {id: string, symbol: string, name: string, type: 'crypto' | 'fiat'}> = {};
  
  // 常用法币列表 - 用于判断货币类型
  private commonFiats = ['usd', 'cny', 'eur', 'jpy', 'krw', 'gbp', 'try', 'rub', 'inr', 'aud', 'cad', 'hkd', 'sgd', 'thb', 'brl', 'mxn', 'sar', 'aed', 'twd', 'chf'];

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    rate: async (msg: Api.Message) => {
      await this.handleRate(msg);
    }
  };

  // 搜索货币的API函数 - 支持加密货币和法币
  private async searchCurrency(query: string): Promise<{id: string, symbol: string, name: string, type: 'crypto' | 'fiat'} | null> {
    // 检查缓存
    const cached = this.currencyCache[query.toLowerCase()];
    if (cached) {
      return cached;
    }
    
    // 优先检查是否为常用法币 - 避免与加密货币符号冲突
    if (this.commonFiats.includes(query.toLowerCase())) {
      const result = {
        id: query.toLowerCase(),
        symbol: query.toUpperCase(),
        name: query.toUpperCase(),
        type: 'fiat' as const
      };
      this.currencyCache[query.toLowerCase()] = result;
      return result;
    }
    
    const searchEndpoints = [
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`,
      `https://api.coingecko.com/api/v3/coins/list`
    ];
    
    for (const endpoint of searchEndpoints) {
      try {
        const response = await axios.get(endpoint, {
          timeout: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
          }
        });
        
        if (endpoint.includes('search')) {
          // 使用搜索API
          const coins = response.data?.coins || [];
          const match = coins.find((coin: any) => 
            coin.symbol?.toLowerCase() === query.toLowerCase() ||
            coin.id?.toLowerCase() === query.toLowerCase() ||
            coin.name?.toLowerCase().includes(query.toLowerCase())
          );
          if (match) {
            const result = { 
              id: match.id, 
              symbol: match.symbol, 
              name: match.name, 
              type: 'crypto' as const
            };
            // 缓存结果
            this.currencyCache[query.toLowerCase()] = result;
            return result;
          }
        } else {
          // 使用完整列表API
          const coins = response.data || [];
          const match = coins.find((coin: any) => 
            coin.symbol?.toLowerCase() === query.toLowerCase() ||
            coin.id?.toLowerCase() === query.toLowerCase()
          );
          if (match) {
            const result = { 
              id: match.id, 
              symbol: match.symbol, 
              name: match.name, 
              type: 'crypto' as const
            };
            // 缓存结果
            this.currencyCache[query.toLowerCase()] = result;
            return result;
          }
        }
      } catch (error) {
        console.warn(`[RatePlugin] 搜索货币失败: ${error}`);
        continue;
      }
    }
    
    
    return null;
  }

  private async fetchCryptoPrice(coinIds: string[], currencies: string[]): Promise<CoinGeckoResponse> {
    const coinIdsStr = coinIds.join(',');
    const currenciesStr = currencies.join(',');
    
    // 尝试多个API端点
    const apiEndpoints = [
      {
        name: 'CoinGecko Main',
        url: `https://api.coingecko.com/api/v3/simple/price?ids=${coinIdsStr}&vs_currencies=${currenciesStr}&include_last_updated_at=true`
      },
      {
        name: 'CoinGecko Alternative',
        url: `https://api.coingecko.com/api/v3/simple/price?ids=${coinIdsStr}&vs_currencies=${currenciesStr}&include_last_updated_at=true`
      }
    ];
    
    let lastError: Error | null = null;
    
    for (const endpoint of apiEndpoints) {
      try {
        console.log(`[RatePlugin] 尝试使用 ${endpoint.name}...`);
        
        const response = await axios.get(endpoint.url, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
          },
          validateStatus: (status) => status < 500 // 接受所有非5xx响应
        });
        
        if (response.status === 429) {
          console.warn(`[RatePlugin] ${endpoint.name} 限流，尝试下一个端点...`);
          lastError = new Error('API请求过于频繁');
          continue;
        }
        
        if (response.status !== 200) {
          console.warn(`[RatePlugin] ${endpoint.name} 返回状态码 ${response.status}`);
          lastError = new Error(`API返回错误状态: ${response.status}`);
          continue;
        }
        
        if (response.data && typeof response.data === 'object') {
          console.log(`[RatePlugin] 成功从 ${endpoint.name} 获取数据`);
          return response.data;
        }
        
        lastError = new Error('API返回数据格式错误');
        
      } catch (error: any) {
        console.error(`[RatePlugin] ${endpoint.name} 请求失败:`, error.message);
        
        if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError;
          
          if (axiosError.code === 'ECONNABORTED') {
            lastError = new Error('请求超时');
          } else if (axiosError.response) {
            const status = axiosError.response.status;
            if (status === 429) {
              lastError = new Error('API限流，请稍后重试');
            } else if (status >= 500) {
              lastError = new Error('服务器错误，请稍后重试');
            } else {
              lastError = new Error(`API错误: ${status}`);
            }
          } else if (axiosError.request) {
            lastError = new Error('网络连接失败');
          } else {
            lastError = new Error(axiosError.message || '请求失败');
          }
        } else {
          lastError = error;
        }
      }
    }
    
    // 所有端点都失败了
    throw lastError || new Error('无法获取价格数据');
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
      console.log(`[RatePlugin] 收到命令: ${text}`);
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

      // 使用API搜索所有货币
      await msg.edit({
        text: "🔍 正在识别货币类型...",
        parseMode: "html"
      });
      
      let currency1: {id: string, symbol: string, name: string, type: 'crypto' | 'fiat'} | null = null;
      let currency2: {id: string, symbol: string, name: string, type: 'crypto' | 'fiat'} | null = null;
      
      // 搜索第一个货币
      currency1 = await this.searchCurrency(input1!);
      if (!currency1) {
        await msg.edit({
          text: `❌ <b>货币未找到</b>\n\n无法找到货币: "${htmlEscape(input1!)}"\n\n💡 <b>建议:</b>\n• 检查拼写是否正确\n• 使用完整货币名称或标准代码\n• 输入 <code>rate help</code> 查看使用说明`,
          parseMode: "html"
        });
        return;
      }
      
      // 搜索第二个货币（如果存在）
      if (input2) {
        currency2 = await this.searchCurrency(input2!);
        if (!currency2) {
          await msg.edit({
            text: `❌ <b>货币未找到</b>\n\n无法找到货币: "${htmlEscape(input2!)}"\n\n💡 <b>建议:</b>\n• 检查拼写是否正确\n• 使用完整货币名称或标准代码\n• 输入 <code>rate help</code> 查看使用说明`,
            parseMode: "html"
          });
          return;
        }
      } else {
        // 默认使用USD
        currency2 = { id: 'usd', symbol: 'USD', name: 'USD', type: 'fiat' };
      }
      
      let cryptoInput: string = '';
      let fiatInput: string = '';
      let isReverse = false;
      let isCryptoCrypto = false;
      let isFiatFiat = false;
      let targetCrypto: string | undefined;
      let targetFiat: string | undefined;
      
      // 智能判断货币类型组合
      if (currency1.type === 'crypto' && currency2.type === 'fiat') {
        // 加密货币 -> 法币 (正向)
        cryptoInput = input1!;
        fiatInput = input2!;
        isReverse = false;
      } else if (currency1.type === 'fiat' && currency2.type === 'crypto') {
        // 法币 -> 加密货币 (反向)
        cryptoInput = input2!;
        fiatInput = input1!;
        isReverse = true;
      } else if (currency1.type === 'crypto' && currency2.type === 'crypto') {
        // 加密货币间转换
        cryptoInput = input1!;
        targetCrypto = input2!;
        fiatInput = 'usd';
        isReverse = false;
        isCryptoCrypto = true;
      } else if (currency1.type === 'fiat' && currency2.type === 'fiat') {
        // 法币间汇率查询 - 使用USDT作为中间货币
        cryptoInput = 'usdt';
        fiatInput = input1!;
        targetFiat = input2!;
        isReverse = false;
        isFiatFiat = true;
      } else if (currency1.type === 'crypto' && !input2) {
        // 只有加密货币，默认美元
        cryptoInput = input1!;
        fiatInput = 'usd';
        isReverse = false;
      } else if (currency1.type === 'fiat' && !input2) {
        // 只有法币，错误情况
        await msg.edit({
          text: `🚫 <b>输入有误</b>\n\n请指定要查询的加密货币\n\n✨ <b>正确格式:</b> <code>rate BTC CNY</code>`,
          parseMode: "html"
        });
        return;
      }

      // 获取标准化名称
      let cryptoId: string;
      let fiatCurrency: string;
      
      if (isFiatFiat) {
        cryptoId = 'tether'; // USDT作为桥梁
        fiatCurrency = fiatInput;
      } else {
        // 从缓存或搜索结果获取ID
        const cryptoCurrency = this.currencyCache[cryptoInput.toLowerCase()];
        if (!cryptoCurrency) {
          const searchResult = await this.searchCurrency(cryptoInput);
          if (!searchResult) {
            await msg.edit({
              text: `❌ <b>无法获取货币信息:</b> ${cryptoInput}`,
              parseMode: "html"
            });
            return;
          }
          cryptoId = searchResult.id;
        } else {
          cryptoId = cryptoCurrency.id;
        }
        
        fiatCurrency = fiatInput;
      }

      // 显示加载状态
      await msg.edit({
        text: "⏳ 正在连接汇率服务器...",
        parseMode: "html"
      });
      
      console.log(`[RatePlugin] 查询: ${cryptoId} -> ${fiatCurrency}, 数量: ${amount}`);

      // 调用CoinGecko API
      let priceData: any;
      try {
        const response = await this.fetchCryptoPrice([cryptoId], [fiatCurrency]);
        priceData = response[cryptoId];
      } catch (error: any) {
        await msg.edit({
          text: `❌ <b>获取价格失败:</b> ${error.message}`,
          parseMode: "html"
        });
        return;
      }

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
      
      if (isFiatFiat) {
        // 法币间汇率转换
        const sourceFiatSymbol = input1!.toUpperCase();
        const targetFiatSymbol = input2!.toUpperCase();
        
        // 获取两种法币对USDT的汇率
        try {
          const response = await this.fetchCryptoPrice(['tether'], [fiatInput, targetFiat!]);
          const usdtData = response['tether'];
          
          if (!usdtData || !usdtData[fiatInput] || !usdtData[targetFiat!]) {
            await msg.edit({
              text: "❌ <b>无法获取汇率数据</b>",
              parseMode: "html"
            });
            return;
          }
          
          const sourceRate = usdtData[fiatInput];  // 1 USDT = X CNY
          const targetRate = usdtData[targetFiat!]; // 1 USDT = Y TRY
          // 汇率计算：1 CNY = (Y/X) TRY
          const exchangeRate = targetRate / sourceRate;
          const convertedAmount = amount * exchangeRate;
          
          responseText = `💱 <b>法币汇率</b>\n\n` +
            `<code>${formatAmount(amount)} ${sourceFiatSymbol} ≈</code>\n` +
            `<code>${formatAmount(convertedAmount)} ${targetFiatSymbol}</code>\n\n` +
            `📊 <b>汇率:</b> <code>1 ${sourceFiatSymbol} = ${formatAmount(exchangeRate)} ${targetFiatSymbol}</code>\n` +
            `⏰ <b>更新时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
        } catch (error: any) {
          await msg.edit({
            text: `❌ <b>获取汇率失败:</b> ${error.message}`,
            parseMode: "html"
          });
          return;
        }
      } else if (isCryptoCrypto) {
        // 加密货币间转换 - 需要获取目标加密货币价格
        const targetCryptoCurrency = this.currencyCache[targetCrypto!.toLowerCase()];
        let targetCryptoId: string;
        
        if (!targetCryptoCurrency) {
          const searchResult = await this.searchCurrency(targetCrypto!);
          if (!searchResult) {
            await msg.edit({
              text: `🔍 <b>未识别的目标货币:</b> "${htmlEscape(targetCrypto!)}"\n\n💡 请检查拼写或使用完整货币名称`,
              parseMode: "html"
            });
            return;
          }
          targetCryptoId = searchResult.id;
        } else {
          targetCryptoId = targetCryptoCurrency.id;
        }

        // 获取目标加密货币价格
        let targetPriceData: any;
        try {
          const targetResponse = await this.fetchCryptoPrice([targetCryptoId], ['usd']);
          targetPriceData = targetResponse[targetCryptoId];
        } catch (error: any) {
          await msg.edit({
            text: `❌ <b>获取目标货币价格失败:</b> ${error.message}`,
            parseMode: "html"
          });
          return;
        }
        
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
        
        const sourceCryptoSymbol = currency1?.symbol?.toUpperCase() || cryptoInput?.toUpperCase() || 'UNKNOWN';
        const targetCryptoSymbol = currency2?.symbol?.toUpperCase() || targetCrypto?.toUpperCase() || 'UNKNOWN';
        
        responseText = `🔄 <b>加密货币间兑换</b>\n\n` +
          `<code>${formatAmount(amount)} ${sourceCryptoSymbol} ≈</code>\n` +
          `<code>${formatAmount(convertedAmount)} ${targetCryptoSymbol}</code>\n\n` +
          `💎 <b>兑换比率:</b> <code>1 ${sourceCryptoSymbol} = ${formatAmount(conversionRate)} ${targetCryptoSymbol}</code>\n` +
          `📊 <b>基准价格:</b> <code>${sourceCryptoSymbol} $${formatPrice(price)} • ${targetCryptoSymbol} $${formatPrice(targetPrice)}</code>\n` +
          `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      } else if (isReverse) {
        // 法币到加密货币的转换
        const cryptoAmount = amount / price;
        const cryptoSymbol = (isReverse ? currency2?.symbol : currency1?.symbol)?.toUpperCase() || cryptoInput?.toUpperCase() || 'UNKNOWN';
        const fiatSymbol = (isReverse ? currency1?.symbol : currency2?.symbol)?.toUpperCase() || fiatInput?.toUpperCase() || 'UNKNOWN';
        
        responseText = `💱 <b>法币兑换加密货币</b>\n\n` +
          `<code>${formatAmount(amount)} ${fiatSymbol} ≈</code>\n` +
          `<code>${formatAmount(cryptoAmount)} ${cryptoSymbol}</code>\n\n` +
          `💎 <b>当前汇率:</b> <code>1 ${cryptoSymbol} = ${formatPrice(price)} ${fiatSymbol}</code>\n` +
          `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      } else if (amount !== 1) {
        // 加密货币到法币的数量转换
        const totalValue = amount * price;
        const cryptoSymbol = currency1?.symbol?.toUpperCase() || cryptoInput?.toUpperCase() || 'UNKNOWN';
        const fiatSymbol = currency2?.symbol?.toUpperCase() || fiatInput?.toUpperCase() || 'UNKNOWN';
        
        responseText = `🪙 <b>加密货币兑换法币</b>\n\n` +
          `<code>${formatAmount(amount)} ${cryptoSymbol} ≈</code>\n` +
          `<code>${formatAmount(totalValue)} ${fiatSymbol}</code>\n\n` +
          `💎 <b>当前汇率:</b> <code>1 ${cryptoSymbol} = ${formatPrice(price)} ${fiatSymbol}</code>\n` +
          `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      } else {
        // 基础价格查询
        const cryptoSymbol = currency1?.symbol?.toUpperCase() || cryptoInput?.toUpperCase() || 'UNKNOWN';
        const fiatSymbol = currency2?.symbol?.toUpperCase() || fiatInput?.toUpperCase() || 'UNKNOWN';
        
        responseText = `📈 <b>实时市场价格</b>\n\n` +
          `<code>1 ${cryptoSymbol} = ${formatPrice(price)} ${fiatSymbol}</code>\n\n` +
          `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      }

      await msg.edit({
        text: responseText,
        parseMode: "html"
      });  
    } catch (error: any) {
      console.error('[RatePlugin] 操作失败:', error);
      
      let errorMessage = '未知错误';
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }
      
      // 提供更友好的错误提示
      let userMessage = `❌ <b>操作失败</b>\n\n`;
      
      if (errorMessage.includes('网络')) {
        userMessage += `🌐 网络连接问题，请检查:\n`;
        userMessage += `• 网络是否正常连接\n`;
        userMessage += `• 是否能访问国际网站\n`;
        userMessage += `• 防火墙或代理设置\n\n`;
        userMessage += `💡 稍后重试或使用代理`;
      } else if (errorMessage.includes('限流') || errorMessage.includes('429')) {
        userMessage += `⏱ API请求过于频繁\n\n`;
        userMessage += `请等待几分钟后再试`;
      } else if (errorMessage.includes('超时')) {
        userMessage += `⏱ 请求超时\n\n`;
        userMessage += `可能是网络延迟较高，请稍后重试`;
      } else {
        userMessage += `错误详情: ${errorMessage}\n\n`;
        userMessage += `💡 如果问题持续，请联系管理员`;
      }
      
      await msg.edit({ 
        text: userMessage,
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

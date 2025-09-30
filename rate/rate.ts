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

📊 <b>使用示例</b>
• <code>rate BTC</code> - 比特币美元价
• <code>rate ETH CNY</code> - 以太坊人民币价
• <code>rate CNY TRY</code> - 人民币兑土耳其里拉
• <code>rate BTC CNY 0.5</code> - 0.5个BTC换算
• <code>rate CNY USDT 7000</code> - 7000元换USDT`;

class RatePlugin extends Plugin {
  description: string = `加密货币汇率查询 & 数量换算\n\n${help_text}`;

  // 货币缓存 - 提高性能，避免重复API调用
  private currencyCache: Record<string, {id: string, symbol: string, name: string, type: 'crypto' | 'fiat'}> = {};
  // 支持的法币集（从 CoinGecko 动态获取并缓存）
  private vsFiats: Set<string> | null = null;
  private vsFiatsTs: number = 0;
  // 法币汇率缓存（按基准币种缓存一篮子）
  private fiatRatesCache: Record<string, { rates: Record<string, number>, ts: number }> = {};
  
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    rate: async (msg: Api.Message) => {
      await this.handleRate(msg);
    }
  };

  // 规范化货币代码（别名归一）
  private normalizeCode(s: string | undefined): string {
    const map: Record<string, string> = { rmb: 'cny', yuan: 'cny', cnh: 'cny' };
    const k = (s || '').toLowerCase();
    return map[k] || k;
  }

  // 获取法币汇率（带多源回退与5分钟缓存）
  private async fetchFiatRates(base: string): Promise<Record<string, number>> {
    const key = base.toLowerCase();
    const now = Date.now();
    const cached = this.fiatRatesCache[key];
    if (cached && now - cached.ts < 5 * 60 * 1000) return cached.rates;
    const endpoints = [
      `https://api.exchangerate.host/latest?base=${encodeURIComponent(key)}`,
      `https://open.er-api.com/v6/latest/${encodeURIComponent(key)}`,
      `https://api.frankfurter.app/latest?from=${encodeURIComponent(key)}`,
      // Coinbase 公共汇率（含法币与加密货币）
      `https://api.coinbase.com/v2/exchange-rates?currency=${encodeURIComponent(key.toUpperCase())}`,
      // jsDelivr 镜像的每日更新静态汇率（无钥，稳定）
      `https://cdn.jsdelivr.net/gh/fawazahmed0/currency-api@1/latest/currencies/${encodeURIComponent(key.toLowerCase())}.json`
    ];
    for (const url of endpoints) {
      try {
        const { data } = await axios.get(url, { timeout: 8000 });
        let rates: Record<string, number> | null = null;
        // 标准结构与 open.er-api、frankfurter
        if (data?.rates) rates = data.rates;
        if (data?.result === 'success' && data?.rates) rates = data.rates;
        // Coinbase 结构: { data: { rates: { USD: "1", ... } } }
        if (!rates && data?.data?.rates) rates = data.data.rates;
        // Fawaz Ahmed currency API: { date: '...', usd: { eur: 0.93, ... } }
        if (!rates && typeof data === 'object' && data && data[key]) rates = data[key];
        if (rates) {
          const normalized = Object.fromEntries(
            Object.entries(rates).map(([k, v]) => [k.toLowerCase(), Number(v)])
          );
          this.fiatRatesCache[key] = { rates: normalized, ts: now };
          return normalized;
        }
      } catch {}
    }
    throw new Error('法币汇率服务不可用');
  }

  // 智能解析参数：抓取两种货币与数量（数量可在任意位置）
  private parseArgs(args: string[]): { base: string, quote: string, amount: number } {
    const tokens = (args || []).map(a => this.normalizeCode(a));
    let amount = 1;
    const curr: string[] = [];
    for (const t of tokens) {
      const n = parseFloat(t);
      if (!isNaN(n) && isFinite(n)) amount = n; else curr.push(t);
    }
    const base = curr[0] || 'btc';
    const quote = curr[1] || 'usd';
    return { base, quote, amount };
  }

  // 获取加密货币对法币价格，失败则经USD桥接回退
  private async getCryptoPrice(cryptoId: string, fiat: string): Promise<{ price: number, lastUpdated: Date }> {
    try {
      const resp = await this.fetchCryptoPrice([cryptoId], [fiat]);
      const data = resp[cryptoId];
      const p = data?.[fiat];
      if (typeof p === 'number') {
        const ts = data.last_updated_at ? new Date(data.last_updated_at * 1000) : new Date();
        return { price: p, lastUpdated: ts };
      }
    } catch {}
    // 回退：USD桥接
    const usdResp = await this.fetchCryptoPrice([cryptoId], ['usd']);
    const usdData = usdResp[cryptoId];
    const usdPrice = usdData?.usd;
    const ts = usdData?.last_updated_at ? new Date(usdData.last_updated_at * 1000) : new Date();
    if (typeof usdPrice !== 'number') throw new Error('无法获取USD价格');
    if (fiat.toLowerCase() === 'usd') {
      return { price: usdPrice, lastUpdated: ts };
    }
    const rates = await this.fetchFiatRates('usd');
    const rate = rates[fiat.toLowerCase()];
    if (!rate) throw new Error('无法获取法币汇率');
    return { price: usdPrice * rate, lastUpdated: ts };
  }

  // 动态判断是否为法币（优先使用网络列表，失败则回退本地列表）
  private async isFiat(query: string): Promise<boolean> {
    const now = Date.now();
    if (!this.vsFiats || now - this.vsFiatsTs > 6 * 60 * 60 * 1000) {
      // 1) CoinGecko vs_currencies
      try {
        const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/supported_vs_currencies', { timeout: 8000 });
        this.vsFiats = new Set((data || []).map((x: string) => x.toLowerCase()));
        this.vsFiatsTs = now;
      } catch {}
      // 2) exchangerate.host /symbols
      if (!this.vsFiats || this.vsFiats.size === 0) {
        try {
          const { data } = await axios.get('https://api.exchangerate.host/symbols', { timeout: 8000 });
          const symbols = data?.symbols || {};
          this.vsFiats = new Set(Object.keys(symbols).map(k => k.toLowerCase()));
          this.vsFiatsTs = now;
        } catch {}
      }
      // 3) frankfurter.app /currencies
      if (!this.vsFiats || this.vsFiats.size === 0) {
        try {
          const { data } = await axios.get('https://api.frankfurter.app/currencies', { timeout: 8000 });
          this.vsFiats = new Set(Object.keys(data || {}).map(k => k.toLowerCase()));
          this.vsFiatsTs = now;
        } catch {}
      }
      // 最后兜底：空集合（不使用本地映射）
      if (!this.vsFiats) {
        this.vsFiats = new Set();
        this.vsFiatsTs = now;
      }
    }
    return this.vsFiats.has(query.toLowerCase());
  }

  // 搜索货币的API函数 - 支持加密货币和法币
  private async searchCurrency(query: string): Promise<{id: string, symbol: string, name: string, type: 'crypto' | 'fiat'} | null> {
    // 检查缓存
    const cached = this.currencyCache[query.toLowerCase()];
    if (cached) {
      return cached;
    }
    
    // 优先动态检查是否为法币 - 避免与加密货币符号冲突
    if (await this.isFiat(query)) {
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

  private formatPrice(value: number): string {
    if (value >= 1) {
      return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (value >= 0.01) {
      return value.toFixed(4);
    } else if (value >= 0.0001) {
      return value.toFixed(6);
    } else {
      return value.toExponential(2);
    }
  }

  private formatAmount(value: number): string {
    if (value >= 1) {
      return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else {
      return value.toFixed(6);
    }
  }

  private buildFiatToFiatResponse(amount: number, convertedAmount: number, rate: number, sourceSymbol: string, targetSymbol: string): string {
    return `💱 <b>汇率</b>\n\n` +
      `<code>${this.formatAmount(amount)} ${sourceSymbol} ≈</code>\n` +
      `<code>${this.formatAmount(convertedAmount)} ${targetSymbol}</code>\n\n` +
      `📊 <b>汇率:</b> <code>1 ${sourceSymbol} = ${this.formatAmount(rate)} ${targetSymbol}</code>\n` +
      `⏰ <b>更新时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  }

  private buildCryptoToCryptoResponse(amount: number, convertedAmount: number, conversionRate: number, price: number, targetPrice: number, sourceSymbol: string, targetSymbol: string, lastUpdated: Date): string {
    return `💱 <b>汇率</b>\n\n` +
      `<code>${this.formatAmount(amount)} ${sourceSymbol} ≈</code>\n` +
      `<code>${this.formatAmount(convertedAmount)} ${targetSymbol}</code>\n\n` +
      `💎 <b>兑换比率:</b> <code>1 ${sourceSymbol} = ${this.formatAmount(conversionRate)} ${targetSymbol}</code>\n` +
      `📊 <b>基准价格:</b> <code>${sourceSymbol} $${this.formatPrice(price)} • ${targetSymbol} $${this.formatPrice(targetPrice)}</code>\n` +
      `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  }

  private buildFiatToCryptoResponse(amount: number, cryptoAmount: number, price: number, cryptoSymbol: string, fiatSymbol: string, lastUpdated: Date): string {
    return `💱 <b>汇率</b>\n\n` +
      `<code>${this.formatAmount(amount)} ${fiatSymbol} ≈</code>\n` +
      `<code>${this.formatAmount(cryptoAmount)} ${cryptoSymbol}</code>\n\n` +
      `💎 <b>当前汇率:</b> <code>1 ${cryptoSymbol} = ${this.formatPrice(price)} ${fiatSymbol}</code>\n` +
      `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  }

  private buildCryptoToFiatResponse(amount: number, totalValue: number, price: number, cryptoSymbol: string, fiatSymbol: string, lastUpdated: Date): string {
    return `💱 <b>汇率</b>\n\n` +
      `<code>${this.formatAmount(amount)} ${cryptoSymbol} ≈</code>\n` +
      `<code>${this.formatAmount(totalValue)} ${fiatSymbol}</code>\n\n` +
      `💎 <b>当前汇率:</b> <code>1 ${cryptoSymbol} = ${this.formatPrice(price)} ${fiatSymbol}</code>\n` +
      `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  }

  private buildPriceResponse(price: number, cryptoSymbol: string, fiatSymbol: string, lastUpdated: Date): string {
    return `💱 <b>汇率</b>\n\n` +
      `<code>1 ${cryptoSymbol} = ${this.formatPrice(price)} ${fiatSymbol}</code>\n\n` +
      `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
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
      const parsed = this.parseArgs(args as string[]);
      const input1 = parsed.base;
      const input2 = parsed.quote;
      const amount = parsed.amount;

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

      // 获取价格（支持USD桥接回退），法币↔法币无需获取
      let price: number = 0;
      let lastUpdated: Date = new Date();
      if (!isFiatFiat) {
        let market: { price: number, lastUpdated: Date };
        try {
          market = await this.getCryptoPrice(cryptoId, fiatCurrency);
        } catch (error: any) {
          await msg.edit({
            text: `❌ <b>获取价格失败:</b> ${error.message}`,
            parseMode: "html"
          });
          return;
        }
        price = market.price;
        lastUpdated = market.lastUpdated;
      }


      // 构建响应消息
      let responseText: string;
      
      if (isFiatFiat) {
        const sourceFiatSymbol = input1!.toUpperCase();
        const targetFiatSymbol = input2!.toUpperCase();
        try {
          const rates = await this.fetchFiatRates(input1!);
          const rate = rates[input2!];
          if (!rate) {
            await msg.edit({ text: '❌ <b>无法获取目标汇率</b>', parseMode: 'html' });
            return;
          }
          const convertedAmount = amount * rate;
          responseText = this.buildFiatToFiatResponse(amount, convertedAmount, rate, sourceFiatSymbol, targetFiatSymbol);
        } catch (error: any) {
          await msg.edit({ text: `❌ <b>获取汇率失败:</b> ${error.message}`, parseMode: 'html' });
          return;
        }
      } else if (isCryptoCrypto) {
        const targetCryptoCurrency = this.currencyCache[targetCrypto!.toLowerCase()];
        let targetCryptoId: string;
        if (!targetCryptoCurrency) {
          const searchResult = await this.searchCurrency(targetCrypto!);
          if (!searchResult) {
            await msg.edit({ text: `🔍 <b>未识别的目标货币:</b> "${htmlEscape(targetCrypto!)}"\n\n💡 请检查拼写或使用完整货币名称`, parseMode: "html" });
            return;
          }
          targetCryptoId = searchResult.id;
        } else {
          targetCryptoId = targetCryptoCurrency.id;
        }

        let targetResponse: CoinGeckoResponse;
        try {
          targetResponse = await this.fetchCryptoPrice([targetCryptoId], ['usd']);
        } catch (error: any) {
          await msg.edit({ text: `❌ <b>获取目标货币价格失败:</b> ${error.message}`, parseMode: "html" });
          return;
        }

        const targetPriceData = targetResponse[targetCryptoId];
        if (!targetPriceData || !targetPriceData.usd) {
          await msg.edit({ text: "❌ <b>API错误:</b> 无法获取目标货币价格数据，请稍后重试", parseMode: "html" });
          return;
        }

        const targetPrice = targetPriceData.usd;
        const conversionRate = price / targetPrice;
        const convertedAmount = amount * conversionRate;
        const sourceCryptoSymbol = currency1?.symbol?.toUpperCase() || cryptoInput?.toUpperCase() || 'UNKNOWN';
        const targetCryptoSymbol = currency2?.symbol?.toUpperCase() || targetCrypto?.toUpperCase() || 'UNKNOWN';
        responseText = this.buildCryptoToCryptoResponse(amount, convertedAmount, conversionRate, price, targetPrice, sourceCryptoSymbol, targetCryptoSymbol, lastUpdated);
      } else if (isReverse) {
        const cryptoAmount = amount / price;
        const cryptoSymbol = (isReverse ? currency2?.symbol : currency1?.symbol)?.toUpperCase() || cryptoInput?.toUpperCase() || 'UNKNOWN';
        const fiatSymbol = (isReverse ? currency1?.symbol : currency2?.symbol)?.toUpperCase() || fiatInput?.toUpperCase() || 'UNKNOWN';
        responseText = this.buildFiatToCryptoResponse(amount, cryptoAmount, price, cryptoSymbol, fiatSymbol, lastUpdated);
      } else if (amount !== 1) {
        const totalValue = amount * price;
        const cryptoSymbol = currency1?.symbol?.toUpperCase() || cryptoInput?.toUpperCase() || 'UNKNOWN';
        const fiatSymbol = currency2?.symbol?.toUpperCase() || fiatInput?.toUpperCase() || 'UNKNOWN';
        responseText = this.buildCryptoToFiatResponse(amount, totalValue, price, cryptoSymbol, fiatSymbol, lastUpdated);
      } else {
        const cryptoSymbol = currency1?.symbol?.toUpperCase() || cryptoInput?.toUpperCase() || 'UNKNOWN';
        const fiatSymbol = currency2?.symbol?.toUpperCase() || fiatInput?.toUpperCase() || 'UNKNOWN';
        responseText = this.buildPriceResponse(price, cryptoSymbol, fiatSymbol, lastUpdated);
      }

      await msg.edit({
        text: responseText,
        parseMode: "html"
      });  
    } catch (error: any) {
      console.error('[RatePlugin] 操作失败:', error);
      
      let errorMessage = '未知错误';
      let errorCode = '';
      
      if (axios.isAxiosError(error)) {
        errorCode = error.code || '';
        errorMessage = error.message;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }
      
      // 提供更友好的错误提示
      let userMessage = `❌ <b>操作失败</b>\n\n`;
      
      // 检查网络不可达错误
      if (errorCode === 'ENOTFOUND' || errorCode === 'ECONNREFUSED' || errorCode === 'ENETUNREACH') {
        userMessage += `🌐 <b>服务不可达</b>\n\n`;
        userMessage += `无法连接到汇率服务器，可能原因:\n`;
        userMessage += `• DNS 解析失败\n`;
        userMessage += `• 网络连接中断\n`;
        userMessage += `• 防火墙阻止访问\n`;
        userMessage += `• 需要配置代理\n\n`;
        userMessage += `💡 请检查网络设置后重试`;
      } else if (errorCode === 'ECONNABORTED' || errorMessage.includes('超时') || errorMessage.includes('timeout')) {
        userMessage += `⏱ <b>请求超时</b>\n\n`;
        userMessage += `网络延迟过高或服务器响应缓慢\n\n`;
        userMessage += `💡 请稍后重试`;
      } else if (errorMessage.includes('限流') || errorMessage.includes('429')) {
        userMessage += `⏱ <b>API请求过于频繁</b>\n\n`;
        userMessage += `请等待几分钟后再试`;
      } else if (errorMessage.includes('网络')) {
        userMessage += `🌐 <b>网络连接问题</b>\n\n`;
        userMessage += `请检查网络连接是否正常`;
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
}

export default new RatePlugin();

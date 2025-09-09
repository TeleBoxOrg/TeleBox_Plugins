import { Plugin } from "../src/utils/pluginBase";
import { getGlobalClient } from "../src/utils/globalClient";
import { Api } from "telegram";

// HTML转义工具
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

class YinglishPlugin extends Plugin {
  description: string = `💋 <b>淫语翻译</b><br/><br/>
<b>命令</b><br/>
• <code>.yinglish [文本]</code>（也可回复一条消息使用）<br/><br/>
<b>功能</b><br/>
• 将中文/英文智能分词并随机替换为“淫语”风格文本<br/>
• 支持回复消息直接转换<br/><br/>
<b>示例</b><br/>
• <code>.yinglish 你好世界</code><br/>
• 回复一条消息后发送 <code>.yinglish</code>`;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    yinglish: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      try {
        // 参数解析
        const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
        const parts = lines?.[0]?.split(/\s+/) || [];
        const [, ...args] = parts; // 跳过命令本身
        const sub = (args[0] || "").toLowerCase();

        let text = '';
        
        // 从参数获取文本
        if (args.length > 0) {
          text = args.join(' ');
        }
        // 从回复消息获取文本
        else if (msg.replyTo && 'replyToMsgId' in msg.replyTo && msg.replyTo.replyToMsgId) {
          try {
            const replyMsgId = msg.replyTo.replyToMsgId;
            const messages = await client.getMessages(msg.peerId!, {
              ids: [replyMsgId]
            });
            
            if (messages && messages.length > 0 && messages[0].message) {
              text = messages[0].message;
            } else {
              await msg.edit({
                text: "❌ 无法获取回复消息的内容",
                parseMode: "html"
              });
              return;
            }
          } catch (error) {
            await msg.edit({
              text: "❌ 获取回复消息失败",
              parseMode: "html"
            });
            return;
          }
        }
        else {
          await msg.edit({
            text: '❌ <b>参数不足</b>\n\n💡 请提供要转换的文本或回复一条消息\n\n<b>用法:</b>\n• <code>.yinglish 你好世界</code> - 转换指定文本\n• <code>.yinglish</code> (回复消息) - 转换回复消息的内容',
            parseMode: "html"
          });
          return;
        }

        if (!text.trim()) {
          await msg.edit({
            text: "❌ 文本内容为空",
            parseMode: "html"
          });
          return;
        }

        await msg.edit({ text: "🔄 正在转换...", parseMode: "html" });
        
        const result = this.chs2yin(text);
        await msg.edit({
          text: result,
          parseMode: "html"
        });
        
      } catch (error: any) {
        console.error('Yinglish conversion error:', error);
        await msg.edit({
          text: `❌ <b>转换失败:</b> ${htmlEscape(error.message)}`,
          parseMode: "html"
        });
      }
    }
  };

  // 简单的中文分词函数（模拟 jieba 的基本功能）
  private simpleSegment(text: string): Array<{word: string, flag: string}> {
    const segments: Array<{word: string, flag: string}> = [];
    let i = 0;
    
    while (i < text.length) {
      const char = text[i];
      
      // 检查是否为标点符号
      if (/[，。！？；：、""（）【】《》\[\]{}]/.test(char)) {
        segments.push({word: char, flag: 'x'});
        i++;
        continue;
      }
      
      // 检查是否为数字
      if (/\d/.test(char)) {
        let num = char;
        i++;
        while (i < text.length && /\d/.test(text[i])) {
          num += text[i];
          i++;
        }
        segments.push({word: num, flag: 'm'});
        continue;
      }
      
      // 检查是否为英文单词
      if (/[a-zA-Z]/.test(char)) {
        let word = char;
        i++;
        while (i < text.length && /[a-zA-Z]/.test(text[i])) {
          word += text[i];
          i++;
        }
        segments.push({word: word, flag: 'eng'});
        continue;
      }
      
      // 中文字符处理 - 尝试匹配常见词汇
      let matched = false;
      const commonWords = [
        '什么', '怎么', '为什么', '可以', '不是', '没有', '知道', '时候', '喜欢', '讨厌',
        '高兴', '难过', '生气', '害怕', '惊讶', '感谢', '对不起', '没关系', '再见', '现在',
        '以前', '以后', '今天', '明天', '昨天', '虽然', '然后', '因为', '所以', '如果'
      ];
      
      for (const word of commonWords) {
        if (text.substr(i, word.length) === word) {
          segments.push({word: word, flag: 'n'});
          i += word.length;
          matched = true;
          break;
        }
      }
      
      if (!matched) {
        // 单个中文字符
        segments.push({word: char, flag: 'n'});
        i++;
      }
    }
    
    return segments;
  }

  // 随机化处理函数（模拟 Python 版本的 chaos 函数）
  private chaos(word: string, flag: string, chaosRate: number = 0.8): string {
    if (Math.random() > chaosRate) {
      return word;
    }
    
    // 处理特殊字符
    if (word === '[' || word === ']') {
      return '';
    }
    
    if (word === '，') {
      return '…';
    }
    
    if (word === '!' || word === '！') {
      return '‼‼‼';
    }
    
    if (word === '。') {
      return '❗';
    }
    
    // 处理长词汇的特殊效果
    if (word.length > 1 && Math.random() < 0.1) {
      return `${word[0]}…${word}`;
    }
    
    if (word.length > 1 && Math.random() < 0.4) {
      return `${word[0]}♥${word}`;
    }
    
    // 处理名词的特殊效果
    if (flag === 'n' && Math.random() < 0.1) {
      const circles = '⭕'.repeat(word.length);
      return `…${circles}`;
    }
    
    if (word === '\\……n' || word === '\\♥n') {
      return '\\n';
    }
    
    if (word === '…………') {
      return '……';
    }
    
    if (flag === 'n' && Math.random() < 0.2) {
      const circles = '⭕'.repeat(word.length);
      return `……${circles}`;
    }
    
    // 应用字符替换规则
    const charRules: Record<string, string> = {
      '你': '伱', '您': '伱', '好': '恏', '的': '哋', '地': '哋', '得': '哋',
      '是': '湜', '不': '卟', '了': '叻', '我': '莪', '他': '怹', '她': '怹', '它': '怹',
      '们': '們', '在': '茬', '有': '冇', '会': '浍', '这': '淛', '那': '哪',
      '说': '説', '话': '話', '看': '瞧', '听': '聽', '想': '想', '要': '婹',
      '来': '唻', '去': '呿', '做': '莋', '给': '給', '让': '讓', '把': '紦',
      '被': '被', '从': '苁', '到': '菿', '对': '對', '和': '咊', '与': '玙',
      '或': '戓', '但': '泹', '而': '洏', '上': '丄', '下': '丅', '里': '裡',
      '外': '迯', '前': '湔', '后': '後', '左': '咗', '右': '祐', '中': '狆',
      '大': '夶', '小': '尛', '多': '哆', '少': '尐', '高': '滈', '低': '低',
      '长': '萇', '短': '短', '新': '噺', '旧': '舊', '快': '筷', '慢': '嫚',
      '早': '蚤', '晚': '晚', '远': '逺', '近': '菦', '坏': '壞', '美': '媄',
      '丑': '醜', '年': '姩', '月': '仴', '日': 'ㄖ', '天': '兲', '人': '亾',
      '男': '侽', '女': '囡', '老': '咾', '生': '甡', '死': '迉', '爱': '愛',
      '恨': '恨'
    };
    
    // 处理词汇替换
    const wordRules: Record<string, string> = {
      '可以': '岢苡', '什么': '什庅', '怎么': '怎庅', '为什么': '潙什庅',
      '时候': '溡堠', '知道': '倁檤', '所以': '葰苡', '因为': '洇潙',
      '如果': '洳淉', '虽然': '雖嘫', '然后': '嘫後', '现在': '哯茬',
      '以前': '苡湔', '以后': '苡後', '今天': '妗兲', '明天': '朙兲',
      '昨天': '昨兲', '喜欢': '囍歡', '讨厌': '討厭', '高兴': '滈興',
      '难过': '難過', '生气': '甡氣', '害怕': '嗐袙', '惊讶': '驚訝',
      '感谢': '感謝', '对不起': '對卟起', '没关系': '莈関係', '再见': '侢見'
    };
    
    // 优先匹配完整词汇
    if (wordRules[word]) {
      return wordRules[word];
    }
    
    // 处理英文单词
    if (flag === 'eng') {
      const englishRules: Record<string, string> = {
        'hello': 'heLLo', 'hi': 'heLLo', 'goodbye': 'goodBye', 'bye': 'goodBye',
        'yes': 'yeS', 'no': 'nO', 'ok': 'oK', 'okay': 'oK', 'thank': 'tHank',
        'sorry': 'soRRy', 'please': 'pLease', 'welcome': 'weLcome',
        'love': 'loVe', 'like': 'liKe', 'hate': 'haTe', 'happy': 'haPPy',
        'sad': 'saD', 'angry': 'anGRy', 'good': 'gooD', 'bad': 'baD',
        'beautiful': 'beauTiful', 'ugly': 'ugLy', 'big': 'biG', 'small': 'smaLL',
        'new': 'neW', 'old': 'olD', 'fast': 'fasT', 'slow': 'sloW',
        'hot': 'hoT', 'cold': 'colD', 'long': 'lonG', 'short': 'shorT',
        'high': 'hiGh', 'low': 'loW', 'easy': 'easY', 'hard': 'harD',
        'right': 'righT', 'wrong': 'wronG', 'true': 'truE', 'false': 'falsE'
      };
      
      const lowerWord = word.toLowerCase();
      if (englishRules[lowerWord]) {
        return englishRules[lowerWord];
      }
    }
    
    // 逐字符替换
    let result = '';
    for (const char of word) {
      result += charRules[char] || char;
    }
    
    return `……${result}`;
  }

  private chs2yin(text: string, chaosRate: number = 0.8): string {
    const segments = this.simpleSegment(text);
    return segments.map(seg => this.chaos(seg.word, seg.flag, chaosRate)).join('');
  }

}

export default new YinglishPlugin();

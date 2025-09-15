const https = require('https');
const { URL } = require('url');

// 常量定义
const API_CONFIG = {
  HOST: 'generativelanguage.googleapis.com',
  BASE_PATH: '/v1beta/models',
  MODEL: 'gemini-2.0-flash-exp',
  TIMEOUT: 30000,
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
  MAX_OUTPUT_TOKENS: 4096,
  TEMPERATURE: 0.7
};

// 错误类型枚举
const ErrorTypes = {
  API_KEY_MISSING: 'API_KEY_MISSING',
  NETWORK_ERROR: 'NETWORK_ERROR',
  API_ERROR: 'API_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  INVALID_RESPONSE: 'INVALID_RESPONSE'
};

/**
 * 自定义错误类
 */
class GeminiError extends Error {
  constructor(type, message, details = {}) {
    super(message);
    this.name = 'GeminiError';
    this.type = type;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * 日志记录器
 */
class Logger {
  static levels = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
  };

  constructor(level = Logger.levels.INFO) {
    this.level = level;
  }

  _log(level, emoji, message, data = null) {
    if (level >= this.level) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] ${emoji} ${message}`;
      console.log(logMessage);
      if (data && level >= Logger.levels.DEBUG) {
        console.log('  📊 Data:', JSON.stringify(data, null, 2));
      }
    }
  }

  debug(message, data) { this._log(Logger.levels.DEBUG, '🔍', message, data); }
  info(message, data) { this._log(Logger.levels.INFO, '📢', message, data); }
  warn(message, data) { this._log(Logger.levels.WARN, '⚠️', message, data); }
  error(message, data) { this._log(Logger.levels.ERROR, '❌', message, data); }
}

const logger = new Logger(process.env.LOG_LEVEL === 'DEBUG' ? Logger.levels.DEBUG : Logger.levels.INFO);

// 更新日志模板
const UPDATE_TEMPLATE = {
  // 标题格式: 📢 TeleBox 更新 | YYYY/MM/DD
  titleFormat: (date) => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `📢 TeleBox 更新 | ${year}/${month}/${day}`;
  },
  
  // 版本号格式: 🗓 [版本号] --日期
  versionFormat: (version, date) => {
    return `🗓 [${version}] --${date}`;
  },
  
  // 分类图标映射
  categoryIcons: {
    'core': '🔧 本体',
    'plugins': '🧩 插件',
    'packages': '📦',
    'features': '✨ 新增功能',
    'music': '🎵 音乐娱乐',
    'ai': '🤖 AI 助手',
    'admin': '👮 群组管理',
    'media': '🎨 媒体处理',
    'entertainment': '🎮 娱乐功能',
    'tools': '🔧 系统工具',
    'info': '📊 信息查询',
    'utility': '📱 实用工具',
    'schedule': '⏰ 定时任务',
    'monitor': '🔍 监控服务',
    'performance': '⚡ 性能优化',
    'bugfix': '🐛 问题修复',
    'docs': '📚 文档更新',
    'cicd': '🔄 CI/CD',
    'update': '⚙️ 更新方式',
    'notice': '📢 声明'
  },
  
  // 更新方式模板
  updateInstructions: `⚙️ 更新方式
• 更新主程序：update -f
• 安装新插件：tpm i <插件名>
• 一键安装全部插件：tpm i all`,
  
  // 声明模板
  disclaimer: `📢 声明
⚠️ 部分插件的数据库需要手动迁移
建议先备份 导出

若出现 bug，会在后续快速修复，敬请耐心等待`
};

/**
 * 生成增强版 Gemini AI 提示词
 * @param {string} date - 日期字符串 YYYY-MM-DD
 * @param {string} version - 版本号
 * @returns {string} 格式化的提示词
 */
function generatePrompt(date = new Date().toISOString().split('T')[0], version = '0.0.0') {
  return `你是 TeleBox 项目的专业更新日志生成助手。请严格按照以下模板格式分析提交记录，生成结构化的更新日志。

# 输出格式规范

## 标题部分
📢 TeleBox 更新 | ${date}

## 版本信息
🗓 [${version}] --${date}

## 内容结构

### 🔧 本体
- 核心框架功能更新
- API 接口变更
- 性能优化
- Bug 修复

### 🧩 插件
- 插件系统架构更新
- 插件通用功能改进
- 插件兼容性调整

### 📦 [具体插件名]
- 新增功能
- 优化改进  
- Bug 修复
- 破坏性变更（如有）

### ⚙️ 更新方式
- 更新主程序：update -f
- 安装新插件：tpm i <插件名>
- 一键安装全部插件：tpm i all

### 📢 声明
⚠️ 更新前建议先备份 导出

若出现 bug，会在后续快速修复，敬请耐心等待

# 分析要求

1. **提交分类**
   - feat: 新功能 → 归类到对应模块
   - fix: 修复 → 说明修复的具体问题
   - perf: 性能 → 强调性能提升效果
   - refactor: 重构 → 简述重构目的
   - docs: 文档 → 可选择性包含
   - chore: 杂项 → 通常忽略

2. **内容组织**
   - 按重要性排序
   - 合并相关提交
   - 使用用户友好的描述
   - 突出破坏性变更

3. **语言风格**
   - 使用简洁的中文
   - 避免技术术语
   - 保持专业语气
   - 条目以动词开头
   - 不要使用反引号包裹函数名或代码
   - 直接使用纯文本描述

4. **质量标准**
   - 每个条目信息完整
   - 避免重复内容
   - 保持格式一致
   - 控制总长度适中

5. **重要要求**
   - 不要在输出中包含任何示例文本或占位符说明
   - 不要使用“示例日期”、“请替换为实际”等提示词
   - 直接使用提供的实际日期和版本号
   - 函数名、变量名等代码元素直接作为普通文本写出，不用反引号

# 待分析的提交记录

提交记录：
`;
}

// 导出基础提示词供兼容
const ENHANCED_PROMPT = generatePrompt();

/**
 * 输入验证器
 */
class Validator {
  /**
   * 验证 API Key
   * @param {string} apiKey 
   * @returns {boolean}
   */
  static validateApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string') {
      return false;
    }
    // Google API Key 格式: AIza 开头，总长度 39 字符
    return /^AIza[0-9A-Za-z\-_]{35}$/.test(apiKey);
  }

  /**
   * 验证提示词
   * @param {string} prompt 
   * @returns {boolean}
   */
  static validatePrompt(prompt) {
    if (!prompt || typeof prompt !== 'string') {
      return false;
    }
    // 检查长度限制（Gemini 限制约 30000 tokens，约 120000 字符）
    return prompt.length > 0 && prompt.length < 120000;
  }

  /**
   * 清理和规范化输入
   * @param {string} text 
   * @returns {string}
   */
  static sanitizeInput(text) {
    if (!text) return '';
    return text
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // 移除控制字符
      .trim();
  }
}

/**
 * HTTP 请求包装器
 */
class HttpClient {
  /**
   * 执行 HTTPS 请求
   * @param {Object} options - 请求选项
   * @param {string} data - 请求数据
   * @returns {Promise<Object>}
   */
  static async request(options, data) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: responseData
          });
        });
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      if (data) {
        req.write(data);
      }
      
      req.end();
    });
  }
}

/**
 * Gemini API 客户端
 */
class GeminiClient {
  constructor(apiKey, config = {}) {
    if (!Validator.validateApiKey(apiKey)) {
      throw new GeminiError(
        ErrorTypes.API_KEY_MISSING,
        'Invalid or missing API key',
        { provided: !!apiKey, format: 'Invalid format' }
      );
    }
    
    this.apiKey = apiKey;
    this.config = { ...API_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * 构建请求选项
   * @param {string} prompt 
   * @returns {Object}
   */
  buildRequestOptions(prompt) {
    const postData = JSON.stringify({
      contents: [{
        parts: [{
          text: prompt
        }]
      }],
      generationConfig: {
        temperature: this.config.TEMPERATURE,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: this.config.MAX_OUTPUT_TOKENS
      },
      safetySettings: [
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_NONE"
        },
        {
          category: "HARM_CATEGORY_HARASSMENT",
          threshold: "BLOCK_NONE"
        },
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: "BLOCK_NONE"
        },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_NONE"
        }
      ]
    });

    return {
      options: {
        hostname: this.config.HOST,
        port: 443,
        path: `${this.config.BASE_PATH}/${this.config.MODEL}:generateContent?key=${this.apiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'TeleBox-UpdateGenerator/2.0'
        },
        timeout: this.config.TIMEOUT
      },
      data: postData
    };
  }

  /**
   * 解析 API 响应
   * @param {Object} response 
   * @returns {Object}
   */
  parseResponse(response) {
    const { statusCode, data } = response;
    
    // 处理 HTTP 错误
    if (statusCode !== 200) {
      const errorInfo = this.parseErrorResponse(statusCode, data);
      throw new GeminiError(
        errorInfo.type,
        errorInfo.message,
        { statusCode, response: data.substring(0, 500) }
      );
    }
    
    // 解析 JSON
    let jsonData;
    try {
      jsonData = JSON.parse(data);
    } catch (error) {
      throw new GeminiError(
        ErrorTypes.PARSE_ERROR,
        'Failed to parse API response',
        { error: error.message, data: data.substring(0, 500) }
      );
    }
    
    // 验证响应结构
    if (!jsonData.candidates || !jsonData.candidates[0] || !jsonData.candidates[0].content) {
      throw new GeminiError(
        ErrorTypes.INVALID_RESPONSE,
        'Invalid response structure',
        { structure: Object.keys(jsonData) }
      );
    }
    
    return jsonData.candidates[0].content.parts[0].text;
  }

  /**
   * 解析错误响应
   * @param {number} statusCode 
   * @param {string} data 
   * @returns {Object}
   */
  parseErrorResponse(statusCode, data) {
    const errorMap = {
      400: { type: ErrorTypes.API_ERROR, message: 'Bad request - Invalid parameters' },
      401: { type: ErrorTypes.API_KEY_MISSING, message: 'Invalid API key' },
      403: { type: ErrorTypes.API_ERROR, message: 'API key lacks required permissions' },
      404: { type: ErrorTypes.API_ERROR, message: 'Model not found' },
      429: { type: ErrorTypes.RATE_LIMIT, message: 'Rate limit exceeded' },
      500: { type: ErrorTypes.API_ERROR, message: 'Internal server error' },
      503: { type: ErrorTypes.API_ERROR, message: 'Service temporarily unavailable' }
    };
    
    return errorMap[statusCode] || {
      type: ErrorTypes.API_ERROR,
      message: `HTTP error ${statusCode}`
    };
  }

  /**
   * 执行 API 调用（带重试）
   * @param {string} prompt 
   * @param {number} retryCount 
   * @returns {Promise<Object>}
   */
  async executeWithRetry(prompt, retryCount = 0) {
    try {
      this.logger.info(`Calling Gemini API (attempt ${retryCount + 1}/${this.config.MAX_RETRIES})`);
      
      const { options, data } = this.buildRequestOptions(prompt);
      const response = await HttpClient.request(options, data);
      const content = this.parseResponse(response);
      
      this.logger.info('API call successful', { contentLength: content.length });
      return { success: true, content };
      
    } catch (error) {
      this.logger.error(`API call failed (attempt ${retryCount + 1})`, {
        error: error.message,
        type: error.type || 'UNKNOWN'
      });
      
      // 判断是否需要重试
      if (retryCount < this.config.MAX_RETRIES - 1) {
        const shouldRetry = this.shouldRetry(error);
        
        if (shouldRetry) {
          const delay = this.config.RETRY_DELAY * Math.pow(2, retryCount); // 指数退避
          this.logger.info(`Retrying after ${delay}ms...`);
          
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.executeWithRetry(prompt, retryCount + 1);
        }
      }
      
      // 不重试或重试次数用尽
      return {
        success: false,
        error: error.message,
        type: error.type || ErrorTypes.NETWORK_ERROR,
        details: error.details
      };
    }
  }

  /**
   * 判断是否应该重试
   * @param {Error} error 
   * @returns {boolean}
   */
  shouldRetry(error) {
    // 不重试的错误类型
    const noRetryErrors = [
      ErrorTypes.API_KEY_MISSING,
      ErrorTypes.PARSE_ERROR,
      ErrorTypes.INVALID_RESPONSE
    ];
    
    if (error.type && noRetryErrors.includes(error.type)) {
      return false;
    }
    
    // 网络错误和超时错误可以重试
    if (error.type === ErrorTypes.NETWORK_ERROR || 
        error.type === ErrorTypes.TIMEOUT_ERROR ||
        error.type === ErrorTypes.RATE_LIMIT) {
      return true;
    }
    
    // 5xx 错误可以重试
    if (error.details && error.details.statusCode >= 500) {
      return true;
    }
    
    return false;
  }

  /**
   * 生成内容
   * @param {string} prompt 
   * @returns {Promise<Object>}
   */
  async generateContent(prompt) {
    // 验证输入
    if (!Validator.validatePrompt(prompt)) {
      return {
        success: false,
        error: 'Invalid prompt',
        type: ErrorTypes.API_ERROR
      };
    }
    
    // 清理输入
    const sanitizedPrompt = Validator.sanitizeInput(prompt);
    
    // 执行 API 调用
    return this.executeWithRetry(sanitizedPrompt);
  }
}

/**
 * 增强的 Gemini API 调用函数（向后兼容）
 * @param {string} apiKey - API 密钥
 * @param {string} prompt - 提示词
 * @returns {Promise<Object>} 调用结果
 */
async function callGeminiAPI(apiKey, prompt) {
  try {
    const client = new GeminiClient(apiKey);
    return await client.generateContent(prompt);
  } catch (error) {
    logger.error('Failed to initialize Gemini client', {
      error: error.message,
      type: error.type
    });
    return {
      success: false,
      error: error.message,
      type: error.type || ErrorTypes.API_ERROR
    };
  }
}

/**
 * 提交记录解析器
 */
class CommitParser {
  /**
   * 解析提交记录为结构化格式
   * @param {Array} commits - 提交记录数组
   * @returns {Object} 结构化的提交信息
   */
  static parseCommitsToStructure(commits) {
    if (!Array.isArray(commits)) {
      logger.warn('Invalid commits format, expected array');
      return this.getEmptyStructure();
    }

    const structure = this.getEmptyStructure();
    
    commits.forEach(commit => {
      this.categorizeCommit(commit, structure);
    });
    
    return structure;
  }

  /**
   * 获取空结构
   * @returns {Object}
   */
  static getEmptyStructure() {
    return {
      core: [],
      plugins: {
        general: [],
        specific: {}
      },
      stats: {
        totalCommits: 0,
        coreCommits: 0,
        pluginCommits: 0
      }
    };
  }

  /**
   * 分类单个提交
   * @param {Object} commit 
   * @param {Object} structure 
   */
  static categorizeCommit(commit, structure) {
    if (!commit || !commit.message) return;
    
    const msg = commit.message.toLowerCase();
    const originalMsg = commit.message;
    structure.stats.totalCommits++;
    
    // 核心/本体更新模式
    const corePatterns = [
      /^feat\(core\)/i,
      /^fix\(core\)/i,
      /本体/,
      /核心框架/,
      /主程序/,
      /\bcore\b/i,
      /\bframework\b/i
    ];
    
    // 插件模式（改进的识别算法）
    const pluginPatterns = [
      /^feat\(([^)]+)\):/i,
      /^fix\(([^)]+)\):/i,
      /^perf\(([^)]+)\):/i,
      /^refactor\(([^)]+)\):/i,
      /插件[：:]/,
      /\[([^\]]+)\]/,
      // 常见插件名称模式
      /\b(sure|eatgif?|eat|gpt|gemini|acron|aban|dbdj|music|help|debug|sudo|re|ping|shift|bf|npm|tpm)\b[：:]/i,
      /\b(sure|eatgif?|eat|gpt|gemini|acron|aban|dbdj|music|help|debug|sudo|re|ping|shift|bf|npm|tpm)\s+[使使用修复优化新增]/i
    ];
    
    // 检查是否为核心更新
    if (corePatterns.some(pattern => pattern.test(msg))) {
      structure.core.push(this.formatCommitMessage(originalMsg));
      structure.stats.coreCommits++;
      return;
    }
    
    // 检查是否为插件更新
    for (const pattern of pluginPatterns) {
      const match = originalMsg.match(pattern);
      if (match) {
        let pluginName = match[1] || match[0]; // 获取匹配的插件名
        
        // 清理插件名称
        pluginName = pluginName
          .replace(/^(feat|fix|perf|refactor)\(|\):|[：:].*$/gi, '')
          .replace(/\s+(使用|修复|优化|新增).*$/i, '')
          .trim()
          .toLowerCase();
        
        // 检查是否为通用插件更新
        if (pluginName === 'plugins' || pluginName === '插件系统' || pluginName === 'plugin') {
          structure.plugins.general.push(this.formatCommitMessage(originalMsg));
        } else if (pluginName) {
          // 特定插件更新
          if (!structure.plugins.specific[pluginName]) {
            structure.plugins.specific[pluginName] = [];
          }
          structure.plugins.specific[pluginName].push(this.formatCommitMessage(originalMsg));
        }
        structure.stats.pluginCommits++;
        return;
      }
    }
    
    // 额外检查：直接提到插件名的提交
    const pluginNames = ['sure', 'eatgif', 'eat', 'gpt', 'gemini', 'acron', 'aban', 'dbdj', 'music', 'help', 'debug', 'sudo', 're', 'ping', 'shift', 'bf', 'npm', 'tpm'];
    for (const plugin of pluginNames) {
      if (msg.includes(plugin)) {
        if (!structure.plugins.specific[plugin]) {
          structure.plugins.specific[plugin] = [];
        }
        structure.plugins.specific[plugin].push(this.formatCommitMessage(originalMsg));
        structure.stats.pluginCommits++;
        return;
      }
    }
    
    // 默认归类
    if (msg.includes('插件')) {
      structure.plugins.general.push(this.formatCommitMessage(originalMsg));
      structure.stats.pluginCommits++;
    } else {
      structure.core.push(this.formatCommitMessage(originalMsg));
      structure.stats.coreCommits++;
    }
  }

  /**
   * 格式化提交消息
   * @param {string} message 
   * @returns {string}
   */
  static formatCommitMessage(message) {
    // 移除常见的提交前缀
    const prefixPattern = /^(feat|fix|perf|refactor|docs|style|test|chore|build|ci)(\([^)]*\))?:\s*/i;
    let formatted = message.replace(prefixPattern, '');
    
    // 确保首字母大写
    if (formatted.length > 0) {
      formatted = formatted.charAt(0).toUpperCase() + formatted.slice(1);
    }
    
    return formatted;
  }
}

/**
 * 更新日志格式化器
 */
class LogFormatter {
  /**
   * 生成格式化的更新日志
   * @param {Object} structure - 结构化的提交信息
   * @param {Object} template - 模板对象
   * @param {string} version - 版本号
   * @param {Date} date - 日期
   * @returns {string} 格式化的更新日志
   */
  static formatUpdateLog(structure, template = UPDATE_TEMPLATE, version = '0.2.0', date = new Date()) {
    const sections = [];
    
    // 标题
    sections.push(template.titleFormat(date));
    sections.push('');
    
    // 版本信息
    sections.push(template.versionFormat(version, date.toISOString().split('T')[0]));
    sections.push('');
    
    // 本体更新
    if (structure.core && structure.core.length > 0) {
      sections.push(template.categoryIcons.core);
      structure.core.forEach(item => {
        sections.push(`• ${item}`);
      });
      sections.push('');
    }
    
    // 插件通用更新
    if (structure.plugins && structure.plugins.general && structure.plugins.general.length > 0) {
      sections.push(template.categoryIcons.plugins);
      structure.plugins.general.forEach(item => {
        sections.push(`• ${item}`);
      });
      sections.push('');
    }
    
    // 特定插件更新
    if (structure.plugins && structure.plugins.specific) {
      Object.entries(structure.plugins.specific).forEach(([plugin, updates]) => {
        if (updates && updates.length > 0) {
          sections.push(`${template.categoryIcons.packages} ${plugin}`);
          updates.forEach(update => {
            sections.push(`• ${update}`);
          });
          sections.push('');
        }
      });
    }
    
    // 添加更新方式
    sections.push(template.updateInstructions);
    sections.push('');
    
    // 添加声明
    sections.push(template.disclaimer);
    
    return sections.join('\n');
  }

  /**
   * 生成统计摘要
   * @param {Object} stats 
   * @returns {string}
   */
  static generateStatsSummary(stats) {
    if (!stats) return '';
    
    const lines = [];
    lines.push('📊 本次更新统计：');
    lines.push(`• 总提交数：${stats.totalCommits || 0}`);
    lines.push(`• 核心更新：${stats.coreCommits || 0}`);
    lines.push(`• 插件更新：${stats.pluginCommits || 0}`);
    
    return lines.join('\n');
  }
}

/**
 * 模块导出
 * 提供向后兼容的接口
 */
module.exports = {
  // 配置和常量
  UPDATE_TEMPLATE,
  ENHANCED_PROMPT,
  API_CONFIG,
  ErrorTypes,
  
  // 类
  GeminiError,
  GeminiClient,
  CommitParser,
  LogFormatter,
  Validator,
  Logger,
  
  // 主要函数（向后兼容）
  callGeminiAPI,
  parseCommitsToStructure: CommitParser.parseCommitsToStructure.bind(CommitParser),
  formatUpdateLog: LogFormatter.formatUpdateLog.bind(LogFormatter),
  
  // 工具函数
  generatePrompt,
  formatCommitMessage: CommitParser.formatCommitMessage.bind(CommitParser),
  generateStatsSummary: LogFormatter.generateStatsSummary.bind(LogFormatter)
};

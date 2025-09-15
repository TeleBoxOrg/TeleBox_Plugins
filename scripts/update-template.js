const https = require('https');

// 更新日志模板配置
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
建议先备份导出

若出现 bug，会在后续快速修复，敬请耐心等待`
};

// Gemini AI 增强版提示词
const ENHANCED_PROMPT = `你是 TeleBox 项目的更新日志生成助手。请分析以下提交记录，生成一份结构化的更新日志。

输出格式要求：

🔧 本体
• [具体更新内容，保持原始提交的关键信息]
• [支持xxx功能的描述]
• [优化、修复等描述]

🧩 插件
• [插件整体性更新说明]
• [重要变更说明]

📦 [插件名1], [插件名2], [插件名3]
• [这些插件的共同更新内容]
• [具体功能改进]

📦 [单个插件名]
• [该插件的具体更新]
• [新增功能说明]

重要规则：
1. 保持原始提交信息的技术细节
2. 相关插件可以合并在一个📦标题下，用逗号分隔
3. 重要的插件单独列出
4. 使用中文描述
5. 保持条目简洁但信息完整
6. 对于涉及多个插件的通用更新，放在"🧩 插件"部分
7. 突出用户可感知的功能变化

提交记录：
`;

// 增强的 Gemini API 调用（带详细日志）
async function callGeminiAPI(apiKey, prompt) {
  console.log('🔑 API Key 状态:', apiKey ? `已配置 (长度: ${apiKey.length})` : '❌ 未配置');
  
  if (!apiKey) {
    return { success: false, error: 'API Key 未配置' };
  }
  
  const postData = JSON.stringify({
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048
    }
  });
  
  return new Promise((resolve) => {
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1beta/models/gemini-pro:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 30000 // 30秒超时
    };
    
    console.log('📡 正在调用 Gemini API...');
    const startTime = Date.now();
    
    const req = https.request(options, (res) => {
      let data = '';
      
      console.log('📊 API 响应状态码:', res.statusCode);
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        const duration = Date.now() - startTime;
        console.log(`⏱️ API 响应时间: ${duration}ms`);
        
        try {
          const response = JSON.parse(data);
          
          // 检查错误响应
          if (response.error) {
            console.error('❌ Gemini API 错误:', response.error.message);
            console.error('错误代码:', response.error.code);
            console.error('错误详情:', JSON.stringify(response.error, null, 2));
            resolve({ success: false, error: response.error.message });
            return;
          }
          
          // 检查正常响应
          if (response.candidates && response.candidates[0] && response.candidates[0].content) {
            const content = response.candidates[0].content.parts[0].text;
            console.log('✅ Gemini API 调用成功，返回内容长度:', content.length);
            resolve({ success: true, content });
          } else {
            console.warn('⚠️ Gemini 返回了空响应');
            console.warn('响应结构:', JSON.stringify(response, null, 2));
            resolve({ success: false, error: '响应内容为空' });
          }
        } catch (error) {
          console.error('❌ 解析 Gemini 响应失败:', error.message);
          console.error('原始响应:', data.substring(0, 500));
          resolve({ success: false, error: `解析失败: ${error.message}` });
        }
      });
    });
    
    req.on('timeout', () => {
      console.error('❌ Gemini API 请求超时');
      req.destroy();
      resolve({ success: false, error: '请求超时' });
    });
    
    req.on('error', (error) => {
      console.error('❌ Gemini API 请求失败:', error.message);
      if (error.code === 'ECONNRESET') {
        console.error('连接被重置，可能是网络问题或API限制');
      } else if (error.code === 'ETIMEDOUT') {
        console.error('连接超时，请检查网络连接');
      }
      resolve({ success: false, error: error.message });
    });
    
    req.write(postData);
    req.end();
  });
}

// 解析提交记录为结构化格式
function parseCommitsToStructure(commits) {
  const structure = {
    core: [],
    plugins: {
      general: [],
      specific: {}
    }
  };
  
  commits.forEach(commit => {
    const msg = commit.message;
    
    // 识别本体更新
    if (msg.includes('本体') || msg.includes('TeleBox') || 
        msg.includes('核心') || msg.includes('主程序')) {
      structure.core.push(msg);
    }
    // 识别插件更新
    else if (msg.includes('插件')) {
      // 通用插件更新
      if (msg.includes('所有插件') || msg.includes('全部插件') || 
          msg.includes('插件系统')) {
        structure.plugins.general.push(msg);
      } else {
        // 特定插件更新
        const pluginMatch = msg.match(/([a-zA-Z_]+)\s*(插件|:)/);
        if (pluginMatch) {
          const pluginName = pluginMatch[1];
          if (!structure.plugins.specific[pluginName]) {
            structure.plugins.specific[pluginName] = [];
          }
          structure.plugins.specific[pluginName].push(msg);
        }
      }
    }
  });
  
  return structure;
}

// 生成格式化的更新日志
function formatUpdateLog(structure, template, version = '0.2.0', date = new Date()) {
  let log = '';
  
  // 添加标题
  log += template.titleFormat(date) + '\n\n';
  
  // 添加版本号
  log += template.versionFormat(version, date.toISOString().split('T')[0]) + '\n\n';
  
  // 本体更新
  if (structure.core.length > 0) {
    log += template.categoryIcons.core + '\n';
    structure.core.forEach(item => {
      log += `• ${item}\n`;
    });
    log += '\n';
  }
  
  // 插件通用更新
  if (structure.plugins.general.length > 0) {
    log += template.categoryIcons.plugins + '\n';
    structure.plugins.general.forEach(item => {
      log += `• ${item}\n`;
    });
    log += '\n';
  }
  
  // 特定插件更新
  Object.entries(structure.plugins.specific).forEach(([plugin, updates]) => {
    log += `${template.categoryIcons.packages} ${plugin}\n`;
    updates.forEach(update => {
      log += `• ${update}\n`;
    });
    log += '\n';
  });
  
  // 添加更新方式
  log += template.updateInstructions + '\n\n';
  
  // 添加声明
  log += template.disclaimer;
  
  return log;
}

module.exports = {
  UPDATE_TEMPLATE,
  ENHANCED_PROMPT,
  callGeminiAPI,
  parseCommitsToStructure,
  formatUpdateLog
};

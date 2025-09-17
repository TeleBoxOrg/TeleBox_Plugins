const { execSync } = require('child_process');
const https = require('https');
const querystring = require('querystring');
const { UPDATE_TEMPLATE, ENHANCED_PROMPT, callGeminiAPI, generatePrompt } = require('./update-template');

// 配置
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TARGET_DATE = process.env.TARGET_DATE || new Date().toISOString().split('T')[0];
const CHECKOUT_SUCCESS = process.env.CHECKOUT_SUCCESS === 'true';

// 验证环境变量
if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ 缺少必要的环境变量: TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID');
  process.exit(1);
}

console.log(`📅 生成 ${TARGET_DATE} 的提交摘要`);
console.log('🔍 环境变量状态:');
console.log(`  - TELEGRAM_BOT_TOKEN: ${BOT_TOKEN ? '✅ 已配置' : '❌ 未配置'}`);
console.log(`  - TELEGRAM_CHAT_ID: ${CHAT_ID ? '✅ 已配置' : '❌ 未配置'}`);
console.log(`  - GEMINI_API_KEY: ${GEMINI_API_KEY ? `✅ 已配置 (长度: ${GEMINI_API_KEY.length})` : '❌ 未配置'}`);

// 增强版 Gemini AI 总结功能
async function summarizeWithGemini(commits) {
  console.log('\n🤖 === Gemini AI 处理开始 ===');
  
  if (!GEMINI_API_KEY) {
    console.warn('⚠️ 未配置 GEMINI_API_KEY，使用基础总结模式');
    console.warn('   请在 GitHub Settings → Secrets → Actions 中添加 GEMINI_API_KEY');
    return null;
  }
  
  try {
    // 准备提交记录文本
    const commitsText = commits.map(c => 
      `- [${c.author}] ${c.message}`
    ).join('\n');
    
    // 获取实际日期和版本号
    const currentDate = TARGET_DATE || new Date().toISOString().split('T')[0];
    const version = `0.${new Date().getMonth() + 1}.${new Date().getDate()}`; // 动态生成版本号
    
    // 使用更新的提示词生成函数
    const { generatePrompt } = require('./update-template');
    const promptTemplate = generatePrompt(currentDate, version);
    const fullPrompt = promptTemplate + commitsText;
    console.log('📏 Prompt 长度:', fullPrompt.length, '字符');
    
    // 使用增强的 API 调用
    const result = await callGeminiAPI(GEMINI_API_KEY, fullPrompt);
    
    if (result.success) {
      console.log('✅ === Gemini AI 处理成功 ===\n');
      return result.content;
    } else {
      console.error('❌ === Gemini AI 处理失败 ===');
      console.error('   错误信息:', result.error);
      
      // 尝试诊断常见问题
      if (result.error.includes('API key not valid')) {
        console.error('   💡 解决方案: 请检查 GEMINI_API_KEY 是否正确');
      } else if (result.error.includes('quota')) {
        console.error('   💡 解决方案: API 配额已用完，请检查 Google Cloud Console');
      } else if (result.error.includes('timeout')) {
        console.error('   💡 解决方案: 网络超时，可能需要配置代理或稍后重试');
      }
      
      return null;
    }
  } catch (error) {
    console.error('❌ 意外错误:', error.message);
    console.error('   错误堆栈:', error.stack);
    return null;
  }
}

// 获取指定日期的提交
function getCommitsForDate(repoPath, repoName, date) {
  try {
    const since = `${date} 00:00:00`;
    const until = `${date} 23:59:59`;
    
    const gitLog = execSync(
      `cd ${repoPath} && git log --since="${since}" --until="${until}" --pretty=format:"%h|%s|%an|%ad" --date=format:"%H:%M"`,
      { encoding: 'utf8' }
    ).trim();
    
    if (!gitLog) {
      return [];
    }
    
    return gitLog.split('\n').map(line => {
      const [hash, message, author, time] = line.split('|');
      return {
        hash: hash.trim(),
        message: message.trim(),
        author: author.trim(),
        time: time.trim(),
        repo: repoName
      };
    });
  } catch (error) {
    console.warn(`⚠️ 获取 ${repoName} 提交记录失败:`, error.message);
    return [];
  }
}

// 去重和过滤提交信息
function deduplicateCommits(commits) {
  const seen = new Set();
  const filtered = [];
  
  for (const commit of commits) {
    // 跳过自动化提交
    if (commit.message.includes('🤖 自动更新插件列表') || 
        commit.message.includes('Merge pull request') ||
        commit.message.match(/^Update \w+\.(json|yml|md)$/)) {
      continue;
    }
    
    // 基于消息内容去重
    const key = commit.message.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      filtered.push(commit);
    }
  }
  
  return filtered;
}

// 插件分类配置
const PLUGIN_CATEGORIES = {
  '🎵 音乐娱乐': ['music', 'music_bot', 'netease', 'audio_to_voice', 't'],
  '🤖 AI 助手': ['gpt', 'gemini'],
  '👮 群组管理': ['aban', 'clean_member', 'bulk_delete', 'manage_admin', 'atadmins', 'sunremove', 'clearblocked', 'clear_sticker', 'da', 'dme'],
  '🎨 媒体处理': ['convert', 'gif', 'sticker', 'sticker_to_pic', 'pic_to_sticker', 'getstickers', 'copy_sticker_set', 'q', 'eat', 'eatgif'],
  '🎮 娱乐功能': ['cosplay', 'crazy4', 'bizhi', 'httpcat', 'moyu', 'lottery', 'dbdj', 'yvlu'],
  '🔧 系统工具': ['speedtest', 'speedlink', 'ssh', 'ntp', 'dig', 'whois', 'encode', 'dc', 'trace'],
  '📊 信息查询': ['weather', 'rate', 'news', 'ip', 'ids', 'his'],
  '📱 实用工具': ['qr', 'gt', 'yt-dlp', 'search', 'shift', 'keyword', 'oxost', 'yinglish'],
  '⏰ 定时任务': ['acron', 'autodel', 'autochangename'],
  '🔍 监控服务': ['komari', 'kitt']
};

// 根据插件名获取分类
function getPluginCategory(pluginName) {
  for (const [category, plugins] of Object.entries(PLUGIN_CATEGORIES)) {
    if (plugins.includes(pluginName.toLowerCase())) {
      return category;
    }
  }
  return '🔧 其他功能';
}

// 按功能分组提交信息
function groupCommitsByFeature(commits) {
  const groups = {};
  
  commits.forEach(commit => {
    let category = '';
    let description = commit.message;
    
    // 识别插件名称
    const pluginMatch = description.match(/^(新增|更新|修复|优化|删除)?\s*([a-zA-Z_]+)\s*(插件|功能)?/);
    if (pluginMatch) {
      const pluginName = pluginMatch[2];
      category = getPluginCategory(pluginName);
      description = description.replace(/^(新增|更新|修复|优化|删除)?\s*[a-zA-Z_]+\s*(插件|功能)?\s*/, '');
    } else {
      // 通用功能识别
      if (description.includes('插件')) {
        const match = description.match(/([a-zA-Z_]+)\s*插件/);
        if (match) {
          category = getPluginCategory(match[1]);
        } else {
          category = '🔧 其他功能';
        }
      } else if (description.includes('修复')) {
        category = '🐛 问题修复';
      } else if (description.includes('优化')) {
        category = '⚡ 性能优化';
      } else if (description.includes('新增') || description.includes('添加')) {
        category = '✨ 新增功能';
      } else if (description.includes('文档') || description.includes('README')) {
        category = '📚 文档更新';
      } else if (description.includes('工作流') || description.includes('CI') || description.includes('workflow')) {
        category = '🔄 CI/CD';
      } else {
        category = '🔧 其他功能';
      }
    }
    
    if (!groups[category]) {
      groups[category] = [];
    }
    
    // 清理描述文本
    description = description
      .replace(/^(feat|fix|docs|style|refactor|test|chore|perf)(\(.+\))?: /, '')
      .replace(/^(🎉|🐛|📝|💄|♻️|✅|🔧|⚡|🚀|📦|🔀|⏪|🔖|💚|👷|📈|♿|🍱|🚨|🔇|👥|🚚|📄|⚗️|🏷️|🌐|💫|🗑️|🔊|🔇|🐛|💩|⏪|🔀|📦|👽|🚚|📱|🤡|🥚|🙈|📸|⚗️|🔍|🏷️|🌱|🚩|💥|🍱|♿|💬|🗃️|🔊|📈|⚗️|🔍|🏷️)\s*/, '')
      .replace(/^:\s*/, '') // 去除开头的冒号和空格
      .replace(/^\s*-\s*:\s*/, '- ') // 修复 "- : " 格式为 "- "
      .trim();
    
    if (description) {
      groups[category].push(description);
    }
  });
  
  return groups;
}

// 生成基础摘要
function generateBasicSummary(commitsByRepo) {
  let basicSummary = '';
  const allFeatureGroups = {};
  
  // 合并所有仓库的提交到统一的分类中
  for (const [repoName, commits] of Object.entries(commitsByRepo)) {
    if (commits.length === 0) continue;
    
    const featureGroups = groupCommitsByFeature(commits);
    
    Object.entries(featureGroups).forEach(([category, descriptions]) => {
      if (!allFeatureGroups[category]) {
        allFeatureGroups[category] = [];
      }
      allFeatureGroups[category].push(...descriptions);
    });
  }
  
  // 按分类输出，使用预定义的顺序
  const categoryOrder = [
    '✨ 新增功能',
    '🎵 音乐娱乐', 
    '🤖 AI 助手',
    '👮 群组管理',
    '🎨 媒体处理',
    '🎮 娱乐功能',
    '🔧 系统工具',
    '📊 信息查询',
    '📱 实用工具',
    '⏰ 定时任务',
    '🔍 监控服务',
    '⚡ 性能优化',
    '🐛 问题修复',
    '📚 文档更新',
    '🔄 CI/CD',
    '🔧 其他功能'
  ];
  
  categoryOrder.forEach(category => {
    if (allFeatureGroups[category] && allFeatureGroups[category].length > 0) {
      basicSummary += `${category}\n`;
      
      // 去重描述并格式化
      const uniqueDescriptions = [...new Set(allFeatureGroups[category])];
      uniqueDescriptions.forEach(desc => {
        if (desc.length > 0) {
          basicSummary += `• ${desc}\n`;
        }
      });
      
      basicSummary += '\n';
    }
  });
  
  return basicSummary;
}

// 发送到 Telegram
function sendToTelegram(text) {
  const data = querystring.stringify({
    chat_id: CHAT_ID,
    text: text,
    disable_web_page_preview: true
  });
  
  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(data)
    }
  };
  
  const req = https.request(options, (res) => {
    let responseData = '';
    
    res.on('data', (chunk) => {
      responseData += chunk;
    });
    
    res.on('end', () => {
      try {
        const response = JSON.parse(responseData);
        if (response.ok) {
          console.log('✅ 消息已成功发送到 Telegram');
        } else {
          console.error('❌ Telegram API 错误:', response.description);
          process.exit(1);
        }
      } catch (error) {
        console.error('❌ 解析响应失败:', error.message);
        console.error('响应内容:', responseData);
        process.exit(1);
      }
    });
  });
  
  req.on('error', (error) => {
    console.error('❌ 发送请求失败:', error.message);
    process.exit(1);
  });
  
  req.write(data);
  req.end();
}

// 主函数
async function main() {
  // 获取两个仓库的提交
  const teleboxCommits = CHECKOUT_SUCCESS ? getCommitsForDate('TeleBox', 'TeleBox', TARGET_DATE) : [];
  const pluginsCommits = getCommitsForDate('TeleBox_Plugins', 'TeleBox_Plugins', TARGET_DATE);
  
  if (!CHECKOUT_SUCCESS) {
    console.warn('⚠️ TeleBox 仓库访问失败，仅统计 TeleBox_Plugins 提交');
  }
  
  const dedupedTeleboxCommits = deduplicateCommits(teleboxCommits);
  const dedupedPluginsCommits = deduplicateCommits(pluginsCommits);
  const allCommits = [...dedupedTeleboxCommits, ...dedupedPluginsCommits];
  
  if (allCommits.length === 0) {
    console.log('📭 今日无提交记录');
    
    // 发送无提交的通知
    const noCommitsMessage = `📅 TeleBox 日报 - ${TARGET_DATE}\n\n🌙 今日无代码提交\n\n保持代码整洁，明日再战！`;
    
    sendToTelegram(noCommitsMessage);
    return;
  }
  
  // 按仓库分组提交
  const commitsByRepo = {
    'TeleBox': dedupedTeleboxCommits,
    'TeleBox_Plugins': dedupedPluginsCommits
  };
  
  // 尝试使用 Gemini AI 生成智能摘要
  console.log('\n' + '='.repeat(50));
  console.log('🚀 开始生成更新日志');
  console.log('='.repeat(50));
  
  const geminiSummary = await summarizeWithGemini(allCommits);
  
  // 生成摘要消息
  let message = `📅 TeleBox 日报 - ${TARGET_DATE}\n\n`;
  message += `📊 今日提交统计\n`;
  message += `• 总提交数: ${allCommits.length}\n`;
  message += `• TeleBox: ${dedupedTeleboxCommits.length} 次提交\n`;
  message += `• TeleBox_Plugins: ${dedupedPluginsCommits.length} 次提交\n\n`;
  
  // 如果有 Gemini 摘要，使用 AI 生成的内容
  if (geminiSummary) {
    console.log('\n✅ 使用 Gemini AI 生成的智能摘要');
    console.log('📊 摘要长度:', geminiSummary.length, '字符');
    // 清理输出，移除多余的提示和重复标题
    const cleanedSummary = geminiSummary
      .replace(/好的，根据您提供的提交记录，我将生成以下更新日志：\n+/g, '')
      .replace(/^#\s+/gm, '') // 移除markdown标题符号
      .replace(/📢\s*TeleBox\s*更新\s*\|[^\n]*\n+/g, '') // 移除重复的标题行
      .replace(/🗓\s*\[[^\]]*\]\s*--[^\n]*\n+/g, '') // 移除重复的版本行
      .trim();
    message += `🤖 AI 智能摘要\n${cleanedSummary}\n\n`;
  } else {
    console.log('\n📝 使用基础分组摘要（Fallback 模式）');
    console.log('   原因: Gemini AI 不可用或返回空结果');
    // 按功能分组提交信息（作为 fallback）
    message += generateBasicSummary(commitsByRepo);
  }
  
  // 添加贡献者统计
  const contributors = [...new Set(allCommits.map(c => c.author))];
  if (contributors.length > 0) {
    message += `👥 今日贡献者\n`;
    contributors.forEach(author => {
      const authorCommits = allCommits.filter(c => c.author === author).length;
      message += `• ${author}: ${authorCommits} 次提交\n`;
    });
    message += '\n';
  }
  
  // 检查消息长度，Telegram 限制为 4096 字符
  if (message.length > 4000) {
    console.warn('⚠️ 消息过长，进行截断处理');
    message = message.substring(0, 3900) + '\n\n_... 消息过长已截断_';
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('📝 最终消息预览:');
  console.log('='.repeat(50));
  console.log(message.substring(0, 500) + (message.length > 500 ? '\n... [省略剩余内容]' : ''));
  console.log('\n📊 消息统计:');
  console.log(`  - 总长度: ${message.length} 字符`);
  console.log(`  - AI 摘要: ${geminiSummary ? '是' : '否'}`);
  console.log(`  - 提交数: ${allCommits.length}`);
  
  // 发送到 Telegram
  console.log('\n📤 发送到 Telegram...');
  sendToTelegram(message);
}

// 运行主函数
main().catch(error => {
  console.error('❌ 脚本执行失败:', error.message);
  process.exit(1);
});

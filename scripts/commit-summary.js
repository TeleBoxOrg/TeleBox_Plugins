const { execSync } = require('child_process');
const https = require('https');
const querystring = require('querystring');
const { UPDATE_TEMPLATE, ENHANCED_PROMPT, callGeminiAPI, generatePrompt } = require('./update-template');

// 配置
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LOCAL_TZ = 'Asia/Shanghai';
const LOCAL_TZ_OFFSET = '+08:00';
const LOCAL_TZ_OFFSET_MINUTES = 8 * 60;
const formatDateInTimeZone = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
const formatDateTimeWithOffset = (date, offsetMinutes) => {
  const pad = (value) => String(value).padStart(2, '0');
  const adjusted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  const yyyy = adjusted.getUTCFullYear();
  const MM = pad(adjusted.getUTCMonth() + 1);
  const dd = pad(adjusted.getUTCDate());
  const hh = pad(adjusted.getUTCHours());
  const mm = pad(adjusted.getUTCMinutes());
  const ss = pad(adjusted.getUTCSeconds());
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offH = pad(Math.floor(abs / 60));
  const offM = pad(abs % 60);

  return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}${sign}${offH}:${offM}`;
};
const getCommitWindow = (date) => {
  const end = new Date(`${date}T23:00:00${LOCAL_TZ_OFFSET}`);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

  return {
    since: formatDateTimeWithOffset(start, LOCAL_TZ_OFFSET_MINUTES),
    until: formatDateTimeWithOffset(end, LOCAL_TZ_OFFSET_MINUTES)
  };
};
const TARGET_DATE = process.env.TARGET_DATE || formatDateInTimeZone(new Date(), LOCAL_TZ);
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
    const currentDate = TARGET_DATE || formatDateInTimeZone(new Date(), LOCAL_TZ);
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
    const { since, until } = getCommitWindow(date);
    
    const gitLog = execSync(
      `cd ${repoPath} && git log --since="${since}" --until="${until}" --pretty=format:"%h|%s|%an|%ad" --date=format:"%H:%M" --name-only`,
      { encoding: 'utf8' }
    ).trim();
    
    if (!gitLog) {
      return [];
    }
    
    const commits = [];
    const commitBlocks = gitLog.split('\n\n');
    
    commitBlocks.forEach(block => {
      const lines = block.trim().split('\n');
      if (lines.length === 0) return;
      
      const [hash, message, author, time] = lines[0].split('|');
      const changedFiles = lines.slice(1).filter(file => file.trim());
      
      // 从文件路径提取插件名
      const detectedPlugins = extractPluginNames(changedFiles, repoName);
      
      commits.push({
        hash: hash.trim(),
        message: message.trim(),
        author: author.trim(),
        time: time.trim(),
        repo: repoName,
        changedFiles: changedFiles,
        detectedPlugins: detectedPlugins
      });
    });
    
    return commits;
  } catch (error) {
    console.warn(`⚠️ 获取 ${repoName} 提交记录失败:`, error.message);
    return [];
  }
}

// 从文件路径提取插件名
function extractPluginNames(changedFiles, repoName) {
  const plugins = new Set();
  
  changedFiles.forEach(filePath => {
    // 处理 TeleBox-Plugins 仓库的插件文件
    if (repoName === 'TeleBox-Plugins') {
      // 插件目录直接包含插件名
      const pluginMatch = filePath.match(/^([a-zA-Z_]+)\//);
      if (pluginMatch) {
        plugins.add(pluginMatch[1]);
      }
      // 根目录下的 .ts 文件也是插件
      const rootPluginMatch = filePath.match(/^([a-zA-Z_]+)\.ts$/);
      if (rootPluginMatch) {
        plugins.add(rootPluginMatch[1]);
      }
      // plugins 目录下的插件
      const pluginsMatch = filePath.match(/^plugins\/([a-zA-Z_]+)\.ts$/);
      if (pluginsMatch) {
        plugins.add(pluginsMatch[1]);
      }
    }
    
    // 处理 TeleBox 仓库的插件文件
    if (repoName === 'TeleBox') {
      // src/plugin 目录下的插件
      const srcPluginMatch = filePath.match(/^src\/plugin\/([a-zA-Z_]+)\.ts$/);
      if (srcPluginMatch) {
        plugins.add(srcPluginMatch[1]);
      }
      // plugins 目录下的插件
      const pluginsMatch = filePath.match(/^plugins\/([a-zA-Z_]+)\.ts$/);
      if (pluginsMatch) {
        plugins.add(pluginsMatch[1]);
      }
    }
  });
  
  return Array.from(plugins);
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
  const pluginGroups = {};
  const coreUpdates = [];
  
  commits.forEach(commit => {
    let description = commit.message
      .replace(/^(feat|fix|docs|style|refactor|test|chore|perf)(\(.+\))?: /, '')
      .replace(/^(🎉|🐛|📝|💄|♻️|✅|🔧|⚡|🚀|📦|🔀|⏪|🔖|💚|👷|📈|♿|🍱|🚨|🔇|👥|🚚|📄|⚗️|🏷️|🌐|💫|🗑️|🔊|🔇|🐛|💩|⏪|🔀|📦|👽|🚚|📱|🤡|🥚|🙈|📸|⚗️|🔍|🏷️|🌱|🚩|💥|🍱|♿|💬|🗃️|🔊|📈|⚗️|🔍|🏷️)\s*/, '')
      .replace(/^:\s*/, '')
      .replace(/^\s*-\s*:\s*/, '- ')
      .trim();
    
    if (!description) return;
    
    if (commit.detectedPlugins && commit.detectedPlugins.length > 0) {
      commit.detectedPlugins.forEach(plugin => {
        if (!pluginGroups[plugin]) {
          pluginGroups[plugin] = [];
        }
        pluginGroups[plugin].push(description);
      });
    } else if (commit.repo === 'TeleBox') {
      coreUpdates.push(description);
    }
  });
  
  return { pluginGroups, coreUpdates };
}

// 生成基础摘要
function generateBasicSummary(commitsByRepo) {
  let basicSummary = '';
  const allPluginGroups = {};
  const allCoreUpdates = [];
  
  for (const [repoName, commits] of Object.entries(commitsByRepo)) {
    if (commits.length === 0) continue;
    
    const { pluginGroups, coreUpdates } = groupCommitsByFeature(commits);
    
    Object.entries(pluginGroups).forEach(([plugin, descriptions]) => {
      if (!allPluginGroups[plugin]) {
        allPluginGroups[plugin] = [];
      }
      allPluginGroups[plugin].push(...descriptions);
    });
    
    allCoreUpdates.push(...coreUpdates);
  }
  
  if (Object.keys(allPluginGroups).length > 0) {
    basicSummary += '🔌 插件更新\n';
    
    const sortedPlugins = Object.keys(allPluginGroups).sort();
    sortedPlugins.forEach(plugin => {
      const uniqueDescriptions = [...new Set(allPluginGroups[plugin])];
      if (uniqueDescriptions.length === 1) {
        basicSummary += `• ${plugin}: ${uniqueDescriptions[0]}\n`;
      } else {
        basicSummary += `• ${plugin}:\n`;
        uniqueDescriptions.forEach(desc => {
          basicSummary += `  - ${desc}\n`;
        });
      }
    });
    
    basicSummary += '\n';
  }
  
  if (allCoreUpdates.length > 0) {
    basicSummary += '🏗️ 本体更新\n';
    const uniqueCoreUpdates = [...new Set(allCoreUpdates)];
    uniqueCoreUpdates.forEach(desc => {
      basicSummary += `• ${desc}\n`;
    });
    basicSummary += '\n';
  }
  
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
  const pluginsCommits = getCommitsForDate('TeleBox-Plugins', 'TeleBox-Plugins', TARGET_DATE);
  
  if (!CHECKOUT_SUCCESS) {
    console.warn('⚠️ TeleBox 仓库访问失败，仅统计 TeleBox-Plugins 提交');
  }
  
  const dedupedTeleboxCommits = deduplicateCommits(teleboxCommits);
  const dedupedPluginsCommits = deduplicateCommits(pluginsCommits);
  const allCommits = [...dedupedTeleboxCommits, ...dedupedPluginsCommits];
  
  if (allCommits.length === 0) {
    console.log('📭 今日无提交记录，跳过发布');
    return;
  }
  
  // 按仓库分组提交
  const commitsByRepo = {
    'TeleBox': dedupedTeleboxCommits,
    'TeleBox-Plugins': dedupedPluginsCommits
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
  message += `• TeleBox-Plugins: ${dedupedPluginsCommits.length} 次提交\n\n`;
  
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
    message += `${cleanedSummary}\n\n`;
  } else {
    console.log('\n📝 使用基础分组摘要（Fallback 模式）');
    console.log('   原因: Gemini AI 不可用或返回空结果');
    // 按功能分组提交信息（作为 fallback）
    message += generateBasicSummary(commitsByRepo);
  }
  
  // 贡献者统计已移除（精简输出）
  
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

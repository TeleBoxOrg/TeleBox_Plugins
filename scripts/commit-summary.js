const { execSync } = require('child_process');
const https = require('https');
const querystring = require('querystring');

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

// Gemini AI 总结功能
async function summarizeWithGemini(commits) {
  if (!GEMINI_API_KEY) {
    console.warn('⚠️ 未配置 GEMINI_API_KEY，使用基础总结模式');
    return null;
  }
  
  try {
    const commitMessages = commits.map(c => c.message).join('\n');
    
    const prompt = `请分析以下 TeleBox 项目的提交记录，按功能模块进行智能分组和总结。

提交记录：
${commitMessages}

请按以下格式输出：
📦 [功能模块名] 插件/功能
- [具体改进描述]
- [具体改进描述]

要求：
1. 将相关提交合并到同一功能模块下
2. 用简洁的中文描述具体改进内容
3. 去掉技术细节，专注于用户可感知的功能变化
4. 如果是新增插件，说明插件的主要功能
5. 如果是修复，说明修复了什么问题
6. 最多输出10个功能模块`;

    const postData = JSON.stringify({
      contents: [{
        parts: [{
          text: prompt
        }]
      }]
    });
    
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: '/v1beta/models/gemini-pro:generateContent?key=' + GEMINI_API_KEY,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.candidates && response.candidates[0] && response.candidates[0].content) {
              resolve(response.candidates[0].content.parts[0].text);
            } else {
              console.warn('⚠️ Gemini 返回空响应');
              resolve(null);
            }
          } catch (error) {
            console.warn('⚠️ Gemini 响应解析失败:', error.message);
            resolve(null);
          }
        });
      });
      
      req.on('error', (error) => {
        console.warn('⚠️ Gemini API 调用失败:', error.message);
        resolve(null);
      });
      
      req.write(postData);
      req.end();
    });
  } catch (error) {
    console.warn('⚠️ Gemini API 调用失败:', error.message);
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

// 按功能分组提交信息
function groupCommitsByFeature(commits) {
  const groups = {};
  
  commits.forEach(commit => {
    let feature = '';
    let description = commit.message;
    
    // 识别插件名称
    const pluginMatch = description.match(/^(新增|更新|修复|优化|删除)?\s*([a-zA-Z_]+)\s*(插件|功能)?/);
    if (pluginMatch) {
      feature = pluginMatch[2];
      description = description.replace(/^(新增|更新|修复|优化|删除)?\s*[a-zA-Z_]+\s*(插件|功能)?\s*/, '');
    } else {
      // 通用功能识别
      if (description.includes('插件')) {
        const match = description.match(/([a-zA-Z_]+)\s*插件/);
        if (match) feature = match[1];
      } else if (description.includes('修复')) {
        feature = '修复';
      } else if (description.includes('优化')) {
        feature = '优化';
      } else if (description.includes('新增')) {
        feature = '新功能';
      } else {
        feature = '其他';
      }
    }
    
    if (!groups[feature]) {
      groups[feature] = [];
    }
    
    // 清理描述文本
    description = description
      .replace(/^(feat|fix|docs|style|refactor|test|chore|perf)(\(.+\))?: /, '')
      .replace(/^(🎉|🐛|📝|💄|♻️|✅|🔧|⚡|🚀|📦|🔀|⏪|🔖|💚|👷|📈|♿|🍱|🚨|🔇|👥|🚚|📄|⚗️|🏷️|🌐|💫|🗑️|🔊|🔇|🐛|💩|⏪|🔀|📦|👽|🚚|📱|🤡|🥚|🙈|📸|⚗️|🔍|🏷️|🌱|🚩|💥|🍱|♿|💬|🗃️|🔊|📈|⚗️|🔍|🏷️)\s*/, '')
      .replace(/^:\s*/, '') // 去除开头的冒号和空格
      .replace(/^\s*-\s*:\s*/, '- ') // 修复 "- : " 格式为 "- "
      .trim();
    
    if (description) {
      groups[feature].push(description);
    }
  });
  
  return groups;
}

// 生成基础摘要
function generateBasicSummary(commitsByRepo) {
  let basicSummary = '';
  
  for (const [repoName, commits] of Object.entries(commitsByRepo)) {
    if (commits.length === 0) continue;
    
    const featureGroups = groupCommitsByFeature(commits);
    
    Object.entries(featureGroups).forEach(([feature, descriptions]) => {
      if (descriptions.length === 0) return;
      
      basicSummary += `📦 ${feature} 插件/功能\n`;
      
      // 去重描述并格式化
      const uniqueDescriptions = [...new Set(descriptions)];
      uniqueDescriptions.forEach(desc => {
        if (desc.length > 0) {
          basicSummary += `- ${desc}\n`;
        }
      });
      
      basicSummary += '\n';
    });
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
  console.log('🤖 尝试使用 Gemini AI 生成智能摘要...');
  const geminiSummary = await summarizeWithGemini(allCommits);
  
  // 生成摘要消息
  let message = `📅 TeleBox 日报 - ${TARGET_DATE}\n\n`;
  message += `📊 今日提交统计\n`;
  message += `• 总提交数: ${allCommits.length}\n`;
  message += `• TeleBox: ${dedupedTeleboxCommits.length} 次提交\n`;
  message += `• TeleBox_Plugins: ${dedupedPluginsCommits.length} 次提交\n\n`;
  
  // 如果有 Gemini 摘要，使用 AI 生成的内容
  if (geminiSummary) {
    console.log('✅ 使用 Gemini AI 生成的智能摘要');
    message += `🤖 AI 智能摘要\n${geminiSummary}\n\n`;
  } else {
    console.log('📝 使用基础分组摘要');
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
  
  // 添加时间戳
  message += `⏰ 报告生成时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  
  // 检查消息长度，Telegram 限制为 4096 字符
  if (message.length > 4000) {
    console.warn('⚠️ 消息过长，进行截断处理');
    message = message.substring(0, 3900) + '\n\n_... 消息过长已截断_';
  }
  
  console.log('📝 生成的消息:');
  console.log(message);
  
  // 发送到 Telegram
  sendToTelegram(message);
}

// 运行主函数
main().catch(error => {
  console.error('❌ 脚本执行失败:', error.message);
  process.exit(1);
});

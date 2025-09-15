#!/usr/bin/env node

const https = require('https');

// 从命令行参数或环境变量获取 API Key
const API_KEY = process.argv[2] || process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('❌ 请提供 API Key');
  console.error('用法: node test-gemini.js YOUR_API_KEY');
  console.error('或设置环境变量 GEMINI_API_KEY');
  process.exit(1);
}

console.log('🔑 API Key 长度:', API_KEY.length);
console.log('🔑 API Key 前6位:', API_KEY.substring(0, 6) + '...');

// 测试 API 调用
async function testGeminiAPI() {
  const testPrompt = '请用一句话介绍 TeleBox 项目';
  
  const postData = JSON.stringify({
    contents: [{
      parts: [{
        text: testPrompt
      }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 100
    }
  });
  
  return new Promise((resolve) => {
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1beta/models/gemini-pro:generateContent?key=${API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 15000
    };
    
    console.log('\n📡 测试 Gemini API...');
    console.log('🌐 API 端点:', `https://${options.hostname}${options.path.split('?')[0]}`);
    
    const startTime = Date.now();
    
    const req = https.request(options, (res) => {
      let data = '';
      
      console.log('📊 响应状态码:', res.statusCode);
      console.log('📋 响应头:', JSON.stringify(res.headers, null, 2));
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        const duration = Date.now() - startTime;
        console.log(`⏱️ 响应时间: ${duration}ms\n`);
        
        try {
          const response = JSON.parse(data);
          
          // 检查错误
          if (response.error) {
            console.error('❌ API 返回错误:');
            console.error('  错误代码:', response.error.code);
            console.error('  错误消息:', response.error.message);
            console.error('  错误状态:', response.error.status);
            
            // 诊断常见问题
            if (response.error.code === 400 && response.error.status === 'INVALID_ARGUMENT') {
              console.error('\n💡 可能的原因:');
              console.error('  1. API Key 格式不正确');
              console.error('  2. API Key 已被撤销');
              console.error('  3. 项目未启用 Gemini API');
            } else if (response.error.code === 403) {
              console.error('\n💡 可能的原因:');
              console.error('  1. API Key 无权限');
              console.error('  2. 地区限制（某些地区无法使用）');
              console.error('  3. 项目未启用计费');
            } else if (response.error.code === 429) {
              console.error('\n💡 可能的原因:');
              console.error('  1. API 配额已用完');
              console.error('  2. 请求频率过高');
            }
            
            resolve(false);
          } else if (response.candidates && response.candidates[0]) {
            console.log('✅ API 调用成功！');
            console.log('📝 AI 响应:', response.candidates[0].content.parts[0].text);
            
            // 显示使用统计
            if (response.usageMetadata) {
              console.log('\n📊 Token 使用统计:');
              console.log('  Prompt Tokens:', response.usageMetadata.promptTokenCount);
              console.log('  Response Tokens:', response.usageMetadata.candidatesTokenCount);
              console.log('  Total Tokens:', response.usageMetadata.totalTokenCount);
            }
            
            resolve(true);
          } else {
            console.warn('⚠️ 未知响应格式:');
            console.warn(JSON.stringify(response, null, 2));
            resolve(false);
          }
        } catch (error) {
          console.error('❌ 解析响应失败:', error.message);
          console.error('原始响应:', data.substring(0, 500));
          resolve(false);
        }
      });
    });
    
    req.on('timeout', () => {
      console.error('❌ 请求超时（15秒）');
      console.error('💡 可能需要检查网络连接或使用代理');
      req.destroy();
      resolve(false);
    });
    
    req.on('error', (error) => {
      console.error('❌ 请求失败:', error.message);
      
      if (error.code === 'ECONNRESET') {
        console.error('💡 连接被重置，可能是网络问题');
      } else if (error.code === 'ETIMEDOUT') {
        console.error('💡 连接超时，可能需要使用代理');
      } else if (error.code === 'ENOTFOUND') {
        console.error('💡 无法解析域名，请检查 DNS 设置');
      }
      
      resolve(false);
    });
    
    req.write(postData);
    req.end();
  });
}

// 运行测试
async function main() {
  console.log('🚀 Gemini API 测试工具');
  console.log('=' .repeat(50));
  
  const success = await testGeminiAPI();
  
  console.log('\n' + '='.repeat(50));
  if (success) {
    console.log('🎉 测试通过！API Key 有效且可以正常使用');
    console.log('\n下一步:');
    console.log('1. 确认 GitHub Actions 中的 Secret 值与此 Key 一致');
    console.log('2. 检查 Actions 运行日志中的详细错误信息');
    console.log('3. 可能需要在 Actions 环境中配置代理');
  } else {
    console.log('❌ 测试失败！请检查上述错误信息');
    console.log('\n建议:');
    console.log('1. 访问 https://makersuite.google.com/app/apikey 重新生成 Key');
    console.log('2. 确保在 Google Cloud Console 中启用了 Generative Language API');
    console.log('3. 检查项目是否有有效的计费账户');
  }
}

main();

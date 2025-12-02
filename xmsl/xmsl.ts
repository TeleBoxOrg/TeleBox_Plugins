import { Plugin } from '@utils/pluginBase';
import { Api } from 'telegram';
import axios from 'axios';
import { createDirectoryInAssets } from '@utils/pathHelpers';
import * as path from 'path';
import { JSONFilePreset } from 'lowdb/node';

type APIMode = 'openai' | 'gemini';

interface XMSLConfig {
	apiMode: APIMode;
	baseUrl: string;
	apiKey: string;
	model: string;
}

const MAX_RESPONSE_TOKENS = 4000;
const SYSTEM_PROMPT = `你的任务是对用户的内容做出一句"羡慕 + 调侃式的称呼或短语"的回复。

规则（调侃版本）：

1. 输出永远只有一句话："羡慕XXX"。
2. XXX 必须是来自用户内容的"可以被轻松调侃"的点。
3. 不要书面语言，不要抽象词汇，用口语、俚语、小坏笑的风格，比如：
   - "富哥"
   - "狠人"
   - "老整活"
   - "会玩"
   - "大聪明"
   - "神仙操作"
   - "小日子"
4. 回复越短越好，2～4 个字优先。
5. 回复带点调侃，不要太认真，也不要太过火。
6. 负面内容也可以轻轻调侃：
   - 倒霉 → "霉神"
   - 加班 → "打工魂"
   - 心情差 → "情绪达人"
7. 不要解释，不要分析，不要问问题，不要重复用户原句。

示例（只是风格参考）：
用户：我今天吃寿司。  
你：羡慕会享受

用户：我下午要加班。  
你：羡慕打工魂

用户：我今天心情不好。  
你：羡慕情绪达人

用户：我买新手机了。  
你：羡慕富哥

用户：我多任务切换很快。  
你：羡慕大聪明

用户：我又在复读一句话。  
你：羡慕会玩`;

class XMSLPlugin extends Plugin {
	name = 'xmsl';
	private config: XMSLConfig = {
		apiMode: 'openai',
		baseUrl: 'https://api.openai.com/v1',
		apiKey: '',
		model: 'gpt-4',
	};
	private db: any = null;
	private baseDir: string = '';

	description = `🤢 <b>羡慕死了插件 - 快速赛博乞讨</b>

<b>📋 命令列表</b>
• <code>.xmsl [内容]</code> - 生成羡慕语句
• <code>.xmsl</code> - 显示状态
• <code>.xmsl set [key] [value]</code> - 修改配置
• <code>.xmsl show</code> - 显示配置
• <code>.xmsl help</code> - 显示帮助

<b>⚙️ 配置项</b>
• <code>mode</code> - API模式 (openai|gemini)
• <code>key</code> - API密钥
• <code>url</code> - API地址
• <code>model</code> - 模型名称`;

	cmdHandlers = {
		xmsl: this.handleXmsl.bind(this),
	};

	constructor() {
		super();
		this.init().catch(console.error);
	}

	private async init() {
		this.baseDir = createDirectoryInAssets('xmsl');
		const configPath = path.join(this.baseDir, 'config.json');
		this.db = await JSONFilePreset<XMSLConfig>(configPath, this.config);
		this.config = this.db.data;

		// 从环境变量加载配置
		if (!this.config.apiKey && process.env.XMSL_API_KEY) {
			this.config.apiKey = process.env.XMSL_API_KEY;
		}
		if (!this.config.baseUrl && process.env.XMSL_BASE_URL) {
			this.config.baseUrl = process.env.XMSL_BASE_URL;
		}
		if (!this.config.model && process.env.XMSL_MODEL) {
			this.config.model = process.env.XMSL_MODEL.toLowerCase();
		}
		if (!this.config.apiMode && process.env.XMSL_API_MODE) {
			this.config.apiMode = (process.env.XMSL_API_MODE.toLowerCase() as APIMode);
		}

		await this.saveConfig();
	}

	private async saveConfig() {
		if (this.db) {
			this.db.data = this.config;
			await this.db.write();
		}
	}

	private htmlEscape(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	private removeThinkTags(text: string): string {
		if (text.includes('<think>') && text.includes('</think>')) {
			const match = text.match(/<\/think>\s*([\s\S]*?)$/);
			if (match) {
				return match[1].trim();
			}
		}
		return text;
	}

	private async handleXmsl(msg: Api.Message) {
		try {
			const text = (msg.text || '').trim();
			const args = text.split(/\s+/).slice(1);
			const command = args[0]?.toLowerCase();

			// 如果是回复消息且没有参数，则尝试获取被回复消息的内容
			if (msg.replyToMsgId && args.length === 0) {
				try {
					const replyMsg = await msg.getReplyMessage();
					if (replyMsg) {
						const question = (replyMsg.text || '').trim();
						if (question) {
							await this.askAI(msg, question);
							return;
						}
					}
				} catch (error) {
					// 如果获取失败，继续显示状态
				}
			}

			if (args.length === 0) {
				// 显示状态
				await this.showStatus(msg);
				return;
			}

			switch (command) {
				case 'set':
					await this.handleSet(msg, args.slice(1));
					break;
				case 'show':
					await this.showConfig(msg);
					break;
				case 'help':
					await msg.edit({ text: this.description, parseMode: 'html' });
					break;
				default:
					// 作为问题发送给AI
					await this.askAI(msg, args.join(' '));
					break;
			}
		} catch (error: any) {
			await msg.edit({
				text: `❌ 处理失败: ${this.htmlEscape(error.message)}`,
				parseMode: 'html',
			});
		}
	}

	private async handleSet(msg: Api.Message, args: string[]) {
		if (args.length < 2) {
			await msg.edit({
				text: '❌ 参数错误\n使用: <code>.xmsl set [key] [value]</code>',
				parseMode: 'html',
			});
			return;
		}

		const key = args[0].toLowerCase();
		const value = args.slice(1).join(' ');

		try {
			switch (key) {
				case 'mode':
					if (!['openai', 'gemini'].includes(value.toLowerCase())) {
						await msg.edit({
							text: "❌ mode 只能是 'openai' 或 'gemini'",
							parseMode: 'html',
						});
						return;
					}
					this.config.apiMode = value.toLowerCase() as APIMode;
					break;

				case 'key':
					this.config.apiKey = value;
					break;

				case 'url':
					this.config.baseUrl = value.endsWith('/') ? value : value + '/';
					break;

			case 'model':
				this.config.model = value.toLowerCase();
				break;

			default:
				await msg.edit({
					text: '❌ 未知配置项\n支持: mode, key, url, model',
						parseMode: 'html',
					});
					return;
			}

			await this.saveConfig();
			await msg.edit({
				text: `✅ ${key} 已设置为: <code>${this.htmlEscape(value)}</code>`,
				parseMode: 'html',
			});
		} catch (error: any) {
			await msg.edit({
				text: `❌ 设置失败: ${this.htmlEscape(error.message)}`,
				parseMode: 'html',
			});
		}
	}

	private async showStatus(msg: Api.Message) {
		const modeEmoji = this.config.apiMode === 'gemini' ? '🔵' : '🟠';
		const statusText = `🧠 <b>XMSL 状态</b>

${modeEmoji} 模式: ${this.config.apiMode}
🔑 密钥: ${this.config.apiKey ? '✅ 已设置' : '❌ 未设置'}
📍 地址: ${this.htmlEscape(this.config.baseUrl.replace(/\/$/, ''))}
🤖 模型: ${this.config.model}

使用 <code>.xmsl help</code> 查看帮助`;

		await msg.edit({ text: statusText, parseMode: 'html' });
	}

	private async showConfig(msg: Api.Message) {
		const configText = `<b>⚙️ 配置信息</b>

mode: ${this.config.apiMode}
key: ${this.config.apiKey ? '✅ 已设置' : '❌ 未设置'}
url: <code>${this.htmlEscape(this.config.baseUrl.replace(/\/$/, ''))}</code>
model: <code>${this.htmlEscape(this.config.model)}</code>

使用 <code>.xmsl set [key] [value]</code> 修改配置`;

		await msg.edit({ text: configText, parseMode: 'html' });
	}

	private async askAI(msg: Api.Message, question: string) {
		if (!this.config.apiKey) {
			await msg.edit({
				text: '❌ 未设置 API 密钥\n使用: <code>.xmsl set key [你的密钥]</code>',
				parseMode: 'html',
			});
			return;
		}

		if (!this.config.model) {
			await msg.edit({
				text: '❌ 未设置模型\n使用: <code>.xmsl set model [模型名]</code>',
				parseMode: 'html',
			});
			return;
		}

		try {
			await msg.edit({
				text: '🔄 处理中...',
				parseMode: 'html',
			});

			let answer: string;
			if (this.config.apiMode === 'gemini') {
				answer = await this.callGemini(question);
			} else {
				answer = await this.callOpenAI(question);
			}

			// 移除think标签
			answer = this.removeThinkTags(answer);

			// 检查token数量
			const estimatedTokens = Math.ceil(answer.length / 4);
			if (estimatedTokens > MAX_RESPONSE_TOKENS) {
				answer = `⚠️ 回复过长(${estimatedTokens} tokens, 超过限制${MAX_RESPONSE_TOKENS})\n\n${answer.substring(
					0,
					1000
				)}...`;
			}

			await msg.edit({
				text: answer,
				parseMode: 'html',
			});
		} catch (error: any) {
			console.error('API Error:', error);
			let errorMsg = '❌ API 调用失败';

			if (error.response?.status === 401) {
				errorMsg = '❌ API 密钥无效';
			} else if (error.response?.status === 429) {
				errorMsg = '❌ 请求过于频繁，请稍后重试';
			} else if (error.code === 'ECONNREFUSED') {
				errorMsg = '❌ 无法连接到 API 服务器';
			} else if (error.message) {
				errorMsg = `❌ ${this.htmlEscape(error.message)}`;
			}

			await msg.edit({
				text: errorMsg,
				parseMode: 'html',
			});
		}
	}

	private async callOpenAI(question: string): Promise<string> {
		const client = axios.create({
			baseURL: this.config.baseUrl.replace(/\/$/, ''),
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				'Content-Type': 'application/json',
			},
			timeout: 60000,
		});

		const messages: any[] = [];
		if (SYSTEM_PROMPT) {
			messages.push({ role: 'system', content: SYSTEM_PROMPT });
		}
		messages.push({ role: 'user', content: question });

		const response = await client.post('/chat/completions', {
			model: this.config.model,
			messages,
			temperature: 0.7,
		});

		return response.data.choices[0]?.message?.content?.trim() || '无法获取回复';
	}

	private async callGemini(question: string): Promise<string> {
		const baseUrl = this.config.baseUrl.replace(/\/$/, '');
		const url = `${baseUrl}/models/${encodeURIComponent(
			this.config.model
		)}:generateContent`;

		const requestBody: any = {
			contents: [
				{
					parts: [{ text: question }],
				},
			],
			generationConfig: {
				temperature: 0.7,
			},
		};

		if (SYSTEM_PROMPT) {
			requestBody.systemInstruction = {
				parts: [{ text: SYSTEM_PROMPT }],
			};
		}

		const response = await axios.post(
			url,
			requestBody,
			{
				params: { key: this.config.apiKey },
				headers: { 'Content-Type': 'application/json' },
				timeout: 60000,
			}
		);

		const parts = response.data?.candidates?.[0]?.content?.parts || [];
		return (
			parts
				.map((p: any) => p.text || '')
				.join('')
				.trim() || '无法获取回复'
		);
	}
}

export default new XMSLPlugin();

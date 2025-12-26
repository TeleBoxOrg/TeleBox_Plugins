import { Plugin } from '@utils/pluginBase';
import { Api } from 'telegram';
import axios from 'axios';
import { createDirectoryInAssets } from '@utils/pathHelpers';
import * as path from 'path';
import { JSONFilePreset } from 'lowdb/node';
import { getGlobalClient } from '@utils/globalClient';

type APIMode = 'openai' | 'gemini';

interface XMSLConfig {
	apiMode: APIMode;
	baseUrl: string;
	apiKey: string;
	model: string;
}

interface MediaInfo {
	base64: string;
	mimeType: string;
	mediaType: 'photo' | 'sticker' | 'document';
	isAnimated?: boolean;
}

const MAX_RESPONSE_TOKENS = 4000;
const SUPPORTED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const TGS_MIME = 'application/x-tgsticker';
const WEBM_MIME = 'video/webm';

// 通过文件头检测图片格式
function detectImageMime(buffer: Buffer): string | null {
	if (buffer.length < 4) return null;

	// JPEG: FF D8 FF
	if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
		return 'image/jpeg';
	}
	// PNG: 89 50 4E 47
	if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
		return 'image/png';
	}
	// GIF: 47 49 46 38
	if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
		return 'image/gif';
	}
	// WebP: 52 49 46 46 ... 57 45 42 50
	if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
		buffer.length >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
		return 'image/webp';
	}
	return null;
}
const SYSTEM_PROMPT = `你的任务是对用户的内容（文字或图片）做出一句"羡慕 + 调侃式的称呼或短语"的回复。

规则（调侃版本）：

1. 输出永远只有一句话："羡慕XXX"。
2. XXX 必须是来自用户内容的"可以被轻松调侃"的点。
3. 如果用户发送图片，请识别图片内容并找到可以调侃的点。
4. 不要书面语言，不要抽象词汇，用口语、俚语、小坏笑的风格，比如：
   - "富哥"
   - "狠人"
   - "老整活"
   - "会玩"
   - "大聪明"
   - "神仙操作"
   - "小日子"
5. 回复越短越好，2～4 个字优先。
6. 回复带点调侃，不要太认真，也不要太过火。
7. 负面内容也可以轻轻调侃：
   - 倒霉 → "霉神"
   - 加班 → "打工魂"
   - 心情差 → "情绪达人"
8. 不要解释，不要分析，不要问问题，不要重复用户原句。

示例（只是风格参考）：
用户：我今天吃寿司。
你：羡慕会享受

用户：我下午要加班。
你：羡慕打工魂

用户：我今天心情不好。
你：羡慕情绪达人

用户：我买新手机了。
你：羡慕富哥

用户：[一张豪华跑车图片]
你：羡慕富哥

用户：[一张可爱猫咪贴纸]
你：羡慕猫奴

用户：[一张美食图片]
你：羡慕会吃`;

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
• <code>.xmsl</code>回复图片/贴纸 - 识别图片生成羡慕语句
• <code>.xmsl</code> - 显示状态
• <code>.xmsl set [key] [value]</code> - 修改配置
• <code>.xmsl show</code> - 显示配置
• <code>.xmsl help</code> - 显示帮助
<b>🖼️ 支持的媒体类型</b>
• 图片 (jpeg/png/gif)
• 静态贴纸 (webp)
• 视频贴纸 (webm) - 暂不支持
• 动态贴纸 (tgs) - 暂不支持

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

	/**
	 * 从消息中提取媒体信息
	 */
	private async extractMediaInfo(message: Api.Message): Promise<MediaInfo | null> {
		if (!message.media) return null;

		const client = await getGlobalClient();
		if (!client) return null;

		try {
			// 处理图片
			if (message.media instanceof Api.MessageMediaPhoto) {
				const buffer = await client.downloadMedia(message.media, { workers: 1 });
				if (buffer && Buffer.isBuffer(buffer)) {
					const detectedMime = detectImageMime(buffer);
					if (detectedMime) {
						return {
							base64: buffer.toString('base64'),
							mimeType: detectedMime,
							mediaType: 'photo',
						};
					}
				}
			}

			// 处理文档类型（贴纸、图片文件等）
			if (message.media instanceof Api.MessageMediaDocument) {
				const doc = message.media.document;
				if (!(doc instanceof Api.Document)) return null;

				const mimeType = doc.mimeType || '';

				// 检测是否为贴纸
				const isSticker = doc.attributes?.some(
					(a: any) => a instanceof Api.DocumentAttributeSticker
				);

				// tgs 动态贴纸暂不支持
				if (mimeType === TGS_MIME) {
					return null;
				}

				// 视频贴纸 (webm) - 暂不支持，缩略图可能不是有效图片
				if (mimeType === WEBM_MIME) {
					return null;
				}

				// 静态图片和贴纸
				if (SUPPORTED_IMAGE_MIMES.includes(mimeType)) {
					// 已知支持的图片格式，直接下载
					const buffer = await client.downloadMedia(message.media, { workers: 1 });
					if (buffer && Buffer.isBuffer(buffer)) {
						const detectedMime = detectImageMime(buffer);
						if (detectedMime) {
							return {
								base64: buffer.toString('base64'),
								mimeType: detectedMime,
								mediaType: isSticker ? 'sticker' : 'document',
							};
						}
					}
				} else if (isSticker) {
					// 其他贴纸类型（未知格式），尝试下载缩略图
					const buffer = await client.downloadMedia(message.media, {
						workers: 1,
						thumb: 1
					});
					if (buffer && Buffer.isBuffer(buffer)) {
						const detectedMime = detectImageMime(buffer);
						if (detectedMime) {
							return {
								base64: buffer.toString('base64'),
								mimeType: detectedMime,
								mediaType: 'sticker',
							};
						}
					}
				}
			}
		} catch (error) {
			console.error('[xmsl] 媒体提取失败:', error);
		}

		return null;
	}

	private async handleXmsl(msg: Api.Message) {
		try {
			const text = (msg.text || '').trim();
			const args = text.split(/\s+/).slice(1);
			const command = args[0]?.toLowerCase();

			// 如果是回复消息且没有参数，则尝试获取被回复消息的内容或媒体
			if (msg.replyToMsgId && args.length === 0) {
				try {
					const replyMsg = await msg.getReplyMessage();
					if (replyMsg) {
						// 优先尝试提取媒体
						const mediaInfo = await this.extractMediaInfo(replyMsg);
						if (mediaInfo) {
							const textContent = (replyMsg.text || '').trim();
							await this.askAI(msg, textContent, mediaInfo);
							return;
						}

						// 如果没有媒体，尝试获取文本
						const question = (replyMsg.text || '').trim();
						if (question) {
							await this.askAI(msg, question);
							return;
						}

						// 检查是否是不支持的贴纸格式
						if (replyMsg.media instanceof Api.MessageMediaDocument) {
							const doc = (replyMsg.media as Api.MessageMediaDocument).document;
							if (doc instanceof Api.Document) {
								if (doc.mimeType === TGS_MIME) {
									await msg.edit({
										text: '❌ 暂不支持 TGS 动态贴纸识别',
										parseMode: 'html',
									});
									return;
								}
								if (doc.mimeType === WEBM_MIME) {
									await msg.edit({
										text: '❌ 暂不支持 WebM 视频贴纸识别',
										parseMode: 'html',
									});
									return;
								}
							}
						}
					}
				} catch (error) {
					console.error('[xmsl] 获取回复消息失败:', error);
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

	private async askAI(msg: Api.Message, question: string, imageInfo?: MediaInfo) {
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
			const processingText = imageInfo
				? '🔄 正在识别图片...'
				: '🔄 处理中...';
			await msg.edit({
				text: processingText,
				parseMode: 'html',
			});

			let answer: string;
			if (this.config.apiMode === 'gemini') {
				answer = await this.callGemini(question, imageInfo);
			} else {
				answer = await this.callOpenAI(question, imageInfo);
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
			console.error('[xmsl] API Error:', error);
			// 打印 API 返回的详细错误信息
			if (error.response?.data) {
				console.error('[xmsl] API Response:', JSON.stringify(error.response.data, null, 2));
			}
			let errorMsg = '❌ API 调用失败';

			if (error.response?.status === 400) {
				const apiError = error.response?.data?.error?.message || '请求格式错误';
				errorMsg = `❌ API 请求错误: ${this.htmlEscape(apiError)}`;
			} else if (error.response?.status === 401) {
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

	private async callOpenAI(question: string, imageInfo?: MediaInfo): Promise<string> {
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

		// 构建用户消息内容
		if (imageInfo) {
			const content: any[] = [];
			if (question) {
				content.push({ type: 'text', text: question });
			} else {
				content.push({ type: 'text', text: '请识别这张图片/贴纸的内容' });
			}
			content.push({
				type: 'image_url',
				image_url: {
					url: `data:${imageInfo.mimeType};base64,${imageInfo.base64}`,
				},
			});
			messages.push({ role: 'user', content });
		} else {
			messages.push({ role: 'user', content: question });
		}

		const response = await client.post('/chat/completions', {
			model: this.config.model,
			messages,
			temperature: 0.7,
		});

		return response.data.choices[0]?.message?.content?.trim() || '无法获取回复';
	}

	private async callGemini(question: string, imageInfo?: MediaInfo): Promise<string> {
		const baseUrl = this.config.baseUrl.replace(/\/$/, '');
		const url = `${baseUrl}/models/${encodeURIComponent(
			this.config.model
		)}:generateContent`;

		// 构建内容部分
		const parts: any[] = [];
		if (question) {
			parts.push({ text: question });
		} else if (imageInfo) {
			parts.push({ text: '请识别这张图片/贴纸的内容' });
		}

		if (imageInfo) {
			parts.push({
				inlineData: {
					mimeType: imageInfo.mimeType,
					data: imageInfo.base64,
				},
			});
		}

		const requestBody: any = {
			contents: [{ parts }],
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

		const responseParts = response.data?.candidates?.[0]?.content?.parts || [];
		return (
			responseParts
				.map((p: any) => p.text || '')
				.join('')
				.trim() || '无法获取回复'
		);
	}
}

export default new XMSLPlugin();

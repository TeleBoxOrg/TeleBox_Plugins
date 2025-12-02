import { Plugin } from '@utils/pluginBase';
import { createDirectoryInTemp } from '@utils/pathHelpers';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Api } from 'telegram';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const FAN_TEMP_DIR = createDirectoryInTemp('rev');

type FlipMode = 'h' | 'v' | null;

interface MediaOptions {
	flipMode: FlipMode;
	invertColors: boolean;
	remaining: string[];
}

interface TransformOptions {
	inputPath: string;
	outputPath: string;
	flipMode: FlipMode;
	invertColors: boolean;
	isGif: boolean;
	isWebm: boolean;
}

class REVPlugin extends Plugin {
	name = 'rev';

	description = `🔄 <b>反转插件</b>

<b>✨ 功能介绍</b>
支持文字和媒体的多种反转操作，让你的内容倒过来！

<b>📝 文字反转</b>
• <code>.rev [文字]</code> - 反转文字内容（支持 emoji）
• <code>.rev</code>（回复文字消息）- 反转回复的文字

<b>🖼️ 媒体反转</b>
支持格式：图片 / GIF / WebM / WebP
• <code>.rev</code>（回复媒体）- 水平翻转
• <code>.rev h</code> - 水平翻转（左右镜像）
• <code>.rev v</code> - 垂直翻转（上下镜像）
• <code>.rev c</code> - 颜色反转（负片效果）
• <code>.rev h c</code> - 组合使用（水平翻转 + 颜色反转）

<b>💡 使用示例</b>
• <code>.rev 你好世界</code> → 界世好你
• 回复图片 + <code>.rev v</code> → 上下翻转的图片
• 回复 GIF + <code>.rev c</code> → 负片效果的 GIF
• 回复 WebM + <code>.rev h c</code> → 水平翻转 + 负片效果`;

	cmdHandlers = {
		rev: async (msg: Api.Message) => {
			try {
				const args = this.parseArgs(msg);
				const { flipMode, invertColors, remaining } =
					this.extractMediaOptions(args);
				const inputText = remaining.join(' ').trim();

				// 处理文本反转
				if (inputText) {
					await this.handleTextReverse(msg, inputText);
					return;
				}

				// 处理媒体反转
				const replyMsg = await msg.getReplyMessage();
				if (replyMsg) {
					const handled = await this.handleReplyMessage(
						msg,
						replyMsg,
						flipMode,
						invertColors
					);
					if (handled) return;
				}

				// 无有效内容时的提示
				await msg.edit({
					text: '❌ 请提供文本内容或回复一条支持的消息\n\n<b>支持的格式：</b>\n• 文本消息（逐行反转）\n• 图片（JPG/PNG/BMP/WebP）\n• 动图（GIF/.gif.mp4）\n• 贴纸（WebM）\n\n💡 <b>使用方法：</b>\n<code>.rev [文本]</code> 或回复消息使用 <code>.rev [参数]</code>',
					parseMode: 'html',
				});
			} catch (error: any) {
				await msg.edit({
					text: `❌ 处理失败: ${this.htmlEscape(error.message)}`,
					parseMode: 'html',
				});
			}
		},
	};

	// ==================== 文本处理 ====================

	private parseArgs(msg: Api.Message): string[] {
		const text = (msg.text || '').trim();
		return text ? text.split(/\s+/).slice(1) : [];
	}

	private async handleReplyMessage(
		msg: Api.Message,
		replyMsg: Api.Message,
		flipMode: FlipMode,
		invertColors: boolean
	): Promise<boolean> {
		const replyText = (replyMsg.message || '').trim();
		const replyEntities = replyMsg.entities || [];

		// 优先尝试媒体处理
		const handledMedia = await this.tryHandleMediaTransform(
			msg,
			replyMsg,
			flipMode,
			invertColors,
			replyText,
			replyEntities
		);
		if (handledMedia) return true;

		// 回退到文本处理
		if (replyText) {
			await this.handleTextReverse(msg, replyText, replyEntities);
			return true;
		}

		return false;
	}

	private async handleTextReverse(
		msg: Api.Message,
		content: string,
		entities: any[] = []
	) {
		const { reversed, reversedEntities } = this.reverseStringWithEntities(
			content,
			entities
		);

		if (reversedEntities.length > 0 && msg.client) {
			try {
				const peerId = await msg.client.getInputEntity(msg.peerId);
				await msg.client.invoke(
					new Api.messages.EditMessage({
						peer: peerId,
						id: msg.id,
						message: reversed,
						entities: reversedEntities as any,
					})
				);
				return;
			} catch (err) {}
		}

		await msg.edit({ text: reversed });
	}

	private reverseStringWithEntities(text: string, entities: any[] = []) {
		// 逐行反转字符顺序，保持行的顺序不变
		const lines = text.split('\n');
		const reversedLines = lines.map((line) =>
			Array.from(line).reverse().join('')
		);
		const reversed = reversedLines.join('\n');
		const textLength = text.length;

		// 反转实体的位置偏移
		const reversedEntities = entities.map((entity: any) => {
			const newEntity = { ...entity };
			newEntity.offset = textLength - entity.offset - entity.length;
			return newEntity;
		});

		return { reversed, reversedEntities };
	}

	// ==================== 媒体处理 ====================

	private async tryHandleMediaTransform(
		msg: Api.Message,
		replyMsg: Api.Message,
		flipMode: FlipMode,
		invertColors: boolean,
		captionText?: string,
		captionEntities: any[] = []
	): Promise<boolean> {
		const media = replyMsg.media;
		if (!this.isSupportedMedia(media)) {
			return false;
		}

		const client = msg.client;
		if (!client) {
			throw new Error('Telegram 客户端未就绪，无法处理媒体');
		}

		await this.safeEditMessage(msg, '🔄 正在处理媒体，请稍候...');

		const { inputPath, outputPath, isGif, isWebm, isWebp } =
			this.prepareMediaPaths(media);

		try {
			await this.downloadMedia(client, replyMsg, inputPath);
			await this.transformMedia(
				inputPath,
				outputPath,
				flipMode,
				invertColors,
				isGif,
				isWebm
			);
			await this.sendTransformedMedia(
				client,
				msg,
				replyMsg,
				outputPath,
				isWebm,
				isWebp,
				captionText,
				captionEntities
			);
			await this.cleanupMessage(msg);
			return true;
		} finally {
			this.cleanupFiles([inputPath, outputPath]);
		}
	}

	private prepareMediaPaths(media: any) {
		const extension = this.getExtensionFromMedia(media);
		const uniqueId = `${Date.now().toString(36)}_${Math.random()
			.toString(36)
			.slice(2, 8)}`;
		const inputPath = path.join(
			FAN_TEMP_DIR,
			`fan_src_${uniqueId}${extension}`
		);
		const outputPath = path.join(
			FAN_TEMP_DIR,
			`fan_flip_${uniqueId}${extension}`
		);
		const isGif = this.isGifMedia(media);
		const isWebm = this.isWebmMedia(media);
		const isWebp = extension === '.webp';

		return { inputPath, outputPath, isGif, isWebm, isWebp };
	}

	private async downloadMedia(
		client: any,
		replyMsg: Api.Message,
		inputPath: string
	) {
		await client.downloadMedia(replyMsg, { outputFile: inputPath });
		if (!fs.existsSync(inputPath)) {
			throw new Error('下载媒体失败，请稍后再试');
		}
	}

	private async transformMedia(
		inputPath: string,
		outputPath: string,
		flipMode: FlipMode,
		invertColors: boolean,
		isGif: boolean,
		isWebm: boolean
	) {
		await this.runFfmpegTransform({
			inputPath,
			outputPath,
			flipMode,
			invertColors,
			isGif,
			isWebm,
		});

		if (!fs.existsSync(outputPath)) {
			throw new Error('ffmpeg 未生成输出文件');
		}
	}

	private async sendTransformedMedia(
		client: any,
		msg: Api.Message,
		replyMsg: Api.Message,
		outputPath: string,
		isWebm: boolean,
		isWebp: boolean,
		captionText?: string,
		captionEntities: any[] = []
	) {
		const sendOptions: any = {
			file: outputPath,
			replyTo: replyMsg.id,
		};

		// 处理文字说明
		if (captionText) {
			const { reversed, reversedEntities } = this.reverseStringWithEntities(
				captionText,
				captionEntities
			);
			sendOptions.caption = reversed;
			if (reversedEntities.length > 0) {
				sendOptions.entities = reversedEntities;
			}
		}

		// WebM 和 WebP 作为贴纸发送
		if (isWebm || isWebp) {
			sendOptions.attributes = [
				new Api.DocumentAttributeSticker({
					alt: 'fan',
					stickerset: new Api.InputStickerSetEmpty(),
				}),
			];
		}

		await client.sendFile(msg.peerId, sendOptions);
	}

	private async cleanupMessage(msg: Api.Message) {
		const deleted = await this.safeDeleteMessage(msg);
		if (!deleted) {
			await this.safeEditMessage(msg, '✅ 媒体已处理完成');
		}
	}

	private cleanupFiles(paths: string[]) {
		for (const filePath of paths) {
			try {
				if (fs.existsSync(filePath)) {
					fs.unlinkSync(filePath);
				}
			} catch (err) {
				console.warn('清理临时文件失败', err);
			}
		}
	}

	// ==================== 媒体检测 ====================

	private isSupportedMedia(media: any): boolean {
		if (!media) return false;
		if (media instanceof Api.MessageMediaPhoto) return true;
		if (media instanceof Api.MessageMediaDocument) {
			const doc = media.document as Api.Document;
			const mime = doc?.mimeType || '';
			const fileName = this.getFileNameFromDocument(doc);
			// 支持 .gif.mp4（Telegram 动图格式），但不支持普通 .mp4
			if (fileName && fileName.toLowerCase().endsWith('.gif.mp4')) {
				return true;
			}
			return (
				mime.startsWith('image/') ||
				mime === 'video/webm' ||
				mime.endsWith('/webm')
			);
		}
		return false;
	}

	private getFileNameFromDocument(doc: Api.Document): string | null {
		if (!doc || !doc.attributes) return null;
		for (const attr of doc.attributes) {
			if (attr instanceof Api.DocumentAttributeFilename) {
				return attr.fileName;
			}
		}
		return null;
	}

	private isGifMedia(media: any): boolean {
		if (media instanceof Api.MessageMediaDocument) {
			const doc = media.document as Api.Document;
			const fileName = this.getFileNameFromDocument(doc);
			// .gif.mp4 按 GIF 处理（使用调色板优化）
			if (fileName && fileName.toLowerCase().endsWith('.gif.mp4')) {
				return true;
			}
			return (doc?.mimeType || '').toLowerCase().includes('gif');
		}
		return false;
	}

	private isWebmMedia(media: any): boolean {
		if (media instanceof Api.MessageMediaDocument) {
			const doc = media.document as Api.Document;
			return (doc?.mimeType || '').toLowerCase().includes('webm');
		}
		return false;
	}

	private getExtensionFromMedia(media: any): string {
		if (media instanceof Api.MessageMediaDocument) {
			const doc = media.document as Api.Document;
			const fileName = this.getFileNameFromDocument(doc);
			// 保留 .gif.mp4 完整扩展名
			if (fileName && fileName.toLowerCase().endsWith('.gif.mp4')) {
				return '.gif.mp4';
			}
			return this.getExtensionFromMime(doc?.mimeType);
		}
		return '.jpg';
	}

	private getExtensionFromMime(mime?: string): string {
		if (!mime) return '.jpg';
		if (mime.includes('png')) return '.png';
		if (mime.includes('webp')) return '.webp';
		if (mime.includes('bmp')) return '.bmp';
		if (mime.includes('gif')) return '.gif';
		if (mime.includes('webm')) return '.webm';
		if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
		return '.jpg';
	}

	// ==================== FFmpeg 转换 ====================

	private async runFfmpegTransform(options: TransformOptions): Promise<void> {
		const { inputPath, outputPath, flipMode, invertColors, isGif, isWebm } =
			options;

		const filters = this.buildVideoFilters(flipMode, invertColors);
		const args = this.buildFfmpegArgs(
			inputPath,
			outputPath,
			filters,
			isGif,
			isWebm
		);

		try {
			await execFileAsync('ffmpeg', args);
		} catch (error: any) {
			if (error?.code === 'ENOENT') {
				throw new Error('未找到 ffmpeg，请先安装后再试');
			}
			const stderr =
				typeof error?.stderr === 'string' ? error.stderr.trim() : '';
			if (stderr) {
				throw new Error(`ffmpeg 处理失败: ${stderr.split('\n')[0]}`);
			}
			throw new Error(`ffmpeg 处理失败: ${error?.message || String(error)}`);
		}
	}

	private buildVideoFilters(
		flipMode: FlipMode,
		invertColors: boolean
	): string[] {
		const filters: string[] = [];

		if (flipMode === 'v') {
			filters.push('vflip');
		} else if (flipMode === 'h') {
			filters.push('hflip');
		}

		if (invertColors) {
			filters.push('negate');
		}

		return filters;
	}

	private buildFfmpegArgs(
		inputPath: string,
		outputPath: string,
		filters: string[],
		isGif: boolean,
		isWebm: boolean
	): string[] {
		const args = ['-y', '-i', inputPath];
		const filterChain = filters.join(',');

		// GIF 使用调色板优化保持质量
		if (isGif) {
			const baseFilter = filterChain || 'null';
			const paletteGraph = `[0:v]${baseFilter}[flip];[flip]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`;
			args.push('-filter_complex', paletteGraph, '-loop', '0');
		} else if (filterChain) {
			args.push('-vf', filterChain);
		}

		// WebM 特殊编码参数（贴纸格式）
		if (isWebm) {
			args.push(
				'-c:v',
				'libvpx-vp9',
				'-pix_fmt',
				'yuva420p',
				'-b:v',
				'0',
				'-crf',
				'32',
				'-auto-alt-ref',
				'0'
			);
		}

		args.push(outputPath);
		return args;
	}

	// ==================== 参数解析 ====================

	// 解析媒体处理参数: h=水平翻转, v=垂直翻转, c=颜色反转
	private extractMediaOptions(args: string[]): MediaOptions {
		let flipMode: FlipMode = null;
		let flipSpecified = false;
		let invertColors = false;
		let index = 0;
		const totalArgs = args.length;

		while (index < args.length) {
			const token = args[index].toLowerCase();

			if (token === 'h') {
				flipMode = 'h';
				flipSpecified = true;
				index++;
			} else if (token === 'v') {
				flipMode = 'v';
				flipSpecified = true;
				index++;
			} else if (token === 'c') {
				invertColors = true;
				index++;
			} else {
				break;
			}
		}

		// 默认行为：如果只有 c 参数，不添加翻转；否则默认水平翻转
		if (
			!flipSpecified &&
			!(invertColors && index === totalArgs && totalArgs > 0)
		) {
			flipMode = 'h';
		}

		return {
			flipMode,
			invertColors,
			remaining: args.slice(index),
		};
	}

	// ==================== 工具方法 ====================

	private async safeEditMessage(
		msg: Api.Message,
		text: string
	): Promise<boolean> {
		try {
			await msg.edit({ text, parseMode: 'html' });
			return true;
		} catch (error) {
			console.warn('编辑消息失败', error);
			return false;
		}
	}

	private async safeDeleteMessage(msg: Api.Message): Promise<boolean> {
		try {
			await msg.delete();
			return true;
		} catch (error) {
			console.warn('删除消息失败', error);
			return false;
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
}

const revPlugin = new REVPlugin();
export default revPlugin;

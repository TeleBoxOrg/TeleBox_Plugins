import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";

/**
 * HTML转义函数
 */
function htmlEscape(text: string): string {
    return text.replace(/[&<>"']/g, m => ({ 
        '&': '&amp;', 
        '<': '&lt;', 
        '>': '&gt;', 
        '"': '&quot;', 
        "'": '&#x27;' 
    }[m] || m));
}

// 帮助文本
const help_text = `🧹 <b>GetDel - 死号检测清理</b>

<b>功能说明：</b>
检测群组中的已删除账号（死号），并可选择自动清理。

<b>使用方式：</b>
• <code>.getdel</code> - 仅检测死号数量
• <code>.getdel 清理</code> - 检测并自动清理死号

<b>注意事项：</b>
• 仅在群组中有效
• 需要管理员权限
• 清理功能需要封禁用户权限`;

class GetDelPlugin extends Plugin {
    // 插件描述
    description = help_text;

    // 命令处理器
    cmdHandlers = {
        getdel: this.handleGetDel.bind(this)
    };

    /**
     * 处理getdel命令
     */
    private async handleGetDel(msg: Api.Message): Promise<void> {
        const client = await getGlobalClient();
        if (!client) return;

        try {
            // 检查是否在群组中
            if (!msg.chatId) {
                await msg.edit({
                    text: "❌ 此命令仅在群组中有效",
                    parseMode: "html"
                });
                return;
            }

            const chatId = msg.chatId;
            const args = msg.text?.split(/\s+/) || [];
            const needClean = args.includes("清理");
            
            await msg.edit({
                text: "🔄 正在遍历群组成员...",
                parseMode: "html"
            });

            // 检查管理员权限
            if (needClean) {
                const hasBanPermission = await this.checkBanPermission(client, chatId);
                if (!hasBanPermission) {
                    await msg.edit({
                        text: "❌ 你没有封禁用户的权限，无法执行清理操作",
                        parseMode: "html"
                    });
                    return;
                }
            }

            let deletedCount = 0;
            let processedCount = 0;

            // 遍历群组成员
            for await (const participant of client.iterParticipants(chatId)) {
                processedCount++;
                
                // 更新进度（每处理50个成员更新一次）
                if (processedCount % 50 === 0) {
                    await msg.edit({
                        text: `🔄 已处理 ${processedCount} 个成员，发现 ${deletedCount} 个死号...`,
                        parseMode: "html"
                    });
                }

                // 检查是否为已删除账号
                if (await this.isDeletedAccount(client, participant)) {
                    deletedCount++;
                    
                    // 如果需要清理，则踢出该成员
                    if (needClean) {
                        try {
                            await this.kickDeletedUser(client, chatId, participant);
                        } catch (error) {
                            console.warn(`无法踢出用户 ${participant.id}:`, error);
                            // 继续处理其他成员
                        }
                    }
                }
            }

            // 显示最终结果
            let resultText: string;
            if (needClean) {
                resultText = `✅ 清理完成！\n\n` +
                           `📊 统计信息：\n` +
                           `• 总检查成员数：${processedCount}\n` +
                           `• 发现死号数：${deletedCount}\n` +
                           `• 已自动清理所有死号`;
            } else {
                resultText = `📊 检测完成！\n\n` +
                           `统计信息：\n` +
                           `• 总检查成员数：${processedCount}\n` +
                           `• 发现死号数：${deletedCount}\n\n` +
                           `💡 使用 <code>.getdel 清理</code> 自动清理死号`;
            }

            await msg.edit({
                text: resultText,
                parseMode: "html"
            });

        } catch (error: any) {
            await this.handleError(msg, error);
        }
    }

    /**
     * 检查是否具有封禁权限
     */
    private async checkBanPermission(client: any, chatId: any): Promise<boolean> {
        try {
            const me = await client.getMe();
            const myParticipant = await client.getParticipant(chatId, me.id);
            
            // 检查是否是管理员且有封禁权限
            if (myParticipant instanceof Api.ChannelParticipantAdmin ||
                myParticipant instanceof Api.ChatParticipantAdmin) {
                return true;
            }
            
            // 对于Channel，检查admin rights
            if (myParticipant instanceof Api.ChannelParticipantAdmin) {
                return myParticipant.adminRights?.banUsers || false;
            }
            
            return false;
        } catch (error) {
            console.error("检查权限失败:", error);
            return false;
        }
    }

    /**
     * 检查是否为已删除账号
     */
    private async isDeletedAccount(client: any, user: any): Promise<boolean> {
        try {
            // 已删除账号通常具有以下特征：
            // 1. 用户名为 "Deleted Account"
            // 2. 没有头像
            // 3. 无法获取详细信息
            
            if (!user || !user.user) return false;
            
            const userEntity = user.user;
            
            // 检查用户名是否为删除账号的典型名称
            if (userEntity.firstName === "Deleted Account" || 
                userEntity.firstName === "账号已注销") {
                return true;
            }
            
            // 尝试获取用户详细信息，如果失败可能是删除账号
            try {
                await client.getEntity(userEntity.id);
            } catch (error: any) {
                if (error.message?.includes("USERNAME_NOT_OCCUPIED") ||
                    error.message?.includes("USER_ID_INVALID") ||
                    error.message?.includes("USER_NOT_PARTICIPANT")) {
                    return true;
                }
            }
            
            return false;
        } catch (error) {
            console.warn("检查用户状态失败:", error);
            return false;
        }
    }

    /**
     * 踢出已删除的用户
     */
    private async kickDeletedUser(client: any, chatId: any, user: any): Promise<void> {
        if (!user || !user.user) return;
        
        try {
            // 封禁用户5分钟（相当于踢出）
            await client.invoke(
                new Api.channels.EditBanned({
                    channel: chatId,
                    participant: user.user.id,
                    bannedRights: new Api.ChatBannedRights({
                        untilDate: Math.floor(Date.now() / 1000) + 300, // 5分钟
                        viewMessages: true,
                        sendMessages: true,
                        sendMedia: true,
                        sendStickers: true,
                        sendGifs: true,
                        sendGames: true,
                        sendInline: true,
                        embedLinks: true,
                    })
                })
            );
            
            // 立即解封（完成踢出操作）
            await client.invoke(
                new Api.channels.EditBanned({
                    channel: chatId,
                    participant: user.user.id,
                    bannedRights: new Api.ChatBannedRights({
                        untilDate: 0,
                        viewMessages: false,
                        sendMessages: false,
                        sendMedia: false,
                        sendStickers: false,
                        sendGifs: false,
                        sendGames: false,
                        sendInline: false,
                        embedLinks: false,
                    })
                })
            );
            
        } catch (error) {
            // 如果封禁失败，可能是用户已不在群中或其他原因
            throw error;
        }
    }

    /**
     * 错误处理
     */
    private async handleError(msg: Api.Message, error: any): Promise<void> {
        console.error("GetDel插件错误:", error);
        
        let errorMessage = "❌ 操作失败";
        
        if (error.message?.includes("FLOOD_WAIT")) {
            const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
            errorMessage = `⏳ 请求过于频繁，请等待 ${waitTime} 秒后重试`;
        } else if (error.message?.includes("CHAT_ADMIN_REQUIRED")) {
            errorMessage = "❌ 需要管理员权限才能执行此操作";
        } else if (error.message?.includes("USER_NOT_PARTICIPANT")) {
            errorMessage = "❌ 机器人不是群组成员";
        } else {
            errorMessage = `❌ 错误: ${htmlEscape(error.message || "未知错误")}`;
        }
        
        await msg.edit({
            text: errorMessage,
            parseMode: "html"
        });
    }
}

export default new GetDelPlugin();

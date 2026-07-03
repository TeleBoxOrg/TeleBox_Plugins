# TeleBox FBI 🕵️

跨群组消息追踪插件 — 单文件，零新增依赖。

## 命令

| 命令 | 功能 |
|---|---|
| `.fbi cs [目标]` | 🔍 搜索目标在**公开群**的最新消息（内存缓存，零 API） |
| `.fbi sv [目标]` | 👁️ 蹲守目标下一条消息（实时监听） |
| `.fbi ds [目标]` | 🧭 分析目标最活跃的**公开群**（内存缓存，零 API） |
| `.fbi ssv` | 🛑 终止所有蹲守 |
| `.fbi cache` | 📦 查看缓存状态 |
| `.fbi cache rebuild` | 🔄 手动重建缓存（拉取全部公开群） |
| `.fbi cache limit [N]` | 设置拉取上限（10~1000，默认 300） |
| `.fbi help` | 显示帮助 |

### 目标格式

- `@username`
- 用户 ID（纯数字）
- 回复一条消息（自动取被回复者）

## 快速开始

```bash
# 复制到 TeleBox 插件目录
scp fbi.ts user@host:/path/to/TeleBox/plugins/

# 重启 TeleBox
pm2 restart telebox
```

## 架构

### 缓存

cs 和 ds 不调任何 Telegram API。数据来源是实时的内存 + 磁盘双写缓存：

```
启动 → 从 db.json 加载缓存到内存 (chatCache)
     → listenMessageHandler 每收到消息更新内存
     → debounced 10s 自动写盘 (schedulePersistCache)
     → 重启从文件恢复，无需 rebuild
```

- **`chatCache`**：`Map<chatId, { username?, title?, msgs: CachedMsg[] }>`
- **`CachedMsg`**：只存 id/senderId/date/text，省 80%+ 内存
- 每个群最多 200 条消息（`CACHE_MSG_LIMIT`），新消息顶掉最旧的
- **只缓存公开群**：onMsg 第一条消息调 `getEntity` 检查 username + className
- 缓存自动写盘（debounced 10s），**重启不丢**

### 命令与缓存的关系

| 命令 | 数据来源 | API 调用 |
|------|----------|----------|
| cs | 遍历 `chatCache` | 零 |
| ds | 遍历 `chatCache` | 零 |
| sv | 实时监听 + lowdb 持久化 | 仅确认目标 |
| cache rebuild | 逐个拉取所有公开群 | 有 |

### 手动重建

`.fbi cache rebuild` 逐个拉取公开群的最近 200 条消息（500~2000ms 随机间隔），写盘。仅在刚启动就需要 cs/ds 可用时使用。

## 持久化

- **LowDB**：`assets/fbi/db.json`
- 持久化内容：蹲守任务 + **消息缓存**
- 缓存自动落盘，**重启不丢**

## 依赖

- `teleproto` — Telegram MTProto 层（TeleBox 内置）
- `lowdb@1.0.0` — JSON 持久化（TeleBox 内置）
- `@utils/*` — TeleBox 内部工具函数（pluginBase, globalClient 等）
  - `createDirectoryInAssets`
  - `safeGetReplyMessage`
  - `getPrefixes`

# 🔒 PMCaptcha 私聊人机验证插件

陌生人发来第一条私信时，自动发送验证题目，通过前对话保持归档静音状态。

---

## 功能特性

- **4 种验证模式**：数学计算、文字关键词、纯数字图片验证码、字母+数字混合图片验证码
- **自动归档静音**：陌生人发消息时立即归档并静音，等待通过验证
- **图片验证码容错**：允许 1 个字符的编辑距离，防止输入法误触导致失败
- **白名单管理**：手动添加/移除信任用户，白名单内用户直接放行
- **验证记录**：独立持久化的通过/失败记录，含时间戳，可点击查看用户资料
- **失败操作**：屏蔽、删除对话、双端撤回、举报、静音、归档（可复选）
- **通过操作**：自动取消静音、取消归档（可复选）
- **数据持久化**：白名单与验证记录存储于独立文件，更新插件不会丢失

---

## 数据文件

插件使用两个独立的 JSON 文件：

| 文件 | 路径 | 内容 | 更新时是否重置 |
|------|------|------|--------------|
| 插件配置 | `assets/pmcaptcha/pmcaptcha_config.json` | 验证模式、超时、操作等设置 | 可能重置 |
| 用户数据 | `./pmcaptcha_userdata/pmcaptcha_data.json` | 白名单、通过/失败记录 | **永不重置** |

> 用户数据文件路径可在 `.pmc status` 末尾查看，建议定期备份。

---

## 命令参考

所有命令前缀默认为 `.`，即 `.pmc` 或 `.pmcaptcha`（两者等价）。

### 插件开关

```
.pmc on          启用插件
.pmc off         禁用插件
.pmc status      查看当前配置与统计
.pmc help        显示帮助
```

### 验证功能

```
.pmc captcha              查看验证状态
.pmc captcha on           开启验证功能（默认关闭）
.pmc captcha off          关闭验证功能

.pmc captcha mode         查看当前模式与可用模式列表
.pmc captcha mode math        数学计算题（默认）
.pmc captcha mode text        文字关键词回复
.pmc captcha mode img_digit   图片验证码（纯数字）
.pmc captcha mode img_mixed   图片验证码（字母+数字混合）
```

### 参数设置

```
.pmc set timeout <秒>      验证超时时间（0 = 不限，默认 30）
.pmc set tries <次>        最大错误次数（0 = 不限，默认 3）
.pmc set keyword <词>      文字模式的目标关键词（默认"我同意"）
.pmc set prompt <文本>     自定义验证提示语（留空恢复默认）
                           占位符：math 模式 {question}，text 模式 {keyword}
```

#### 失败操作（可复选，空格分隔）

```
.pmc set fail none              清除所有额外失败操作
.pmc set fail block             屏蔽用户
.pmc set fail delete            删除对话记录（己方）
.pmc set fail delete_revoke     删除对话记录（双端撤回）
.pmc set fail report            举报为垃圾信息
.pmc set fail mute              永久静音（失败时默认已执行）
.pmc set fail archive           归档（失败时默认已执行）

# 示例：屏蔽并举报
.pmc set fail block report
```

#### 通过操作（可复选）

```
.pmc set pass none          清除所有通过操作
.pmc set pass unmute        验证通过后取消静音
.pmc set pass unarchive     验证通过后取消归档

# 示例：同时取消静音和归档
.pmc set pass unmute unarchive
```

### 白名单

```
.pmc wl                      查看白名单（可点击查看用户资料）
.pmc wl add <ID/@user>       手动加入白名单
.pmc wl add                  回复某条消息时可直接添加该消息的发送者
.pmc wl del <ID/@user>       从白名单移除指定用户
.pmc wl del all              清空白名单
.pmc wl pass <ID/@user>      手动标记验证通过并加入白名单（同时清除验证状态）
```

### 验证记录

```
.pmc record                          通过/失败人数摘要
.pmc record verified                 查看通过记录（含时间，可点击用户资料）
.pmc record failed                   查看失败记录（含原因与时间）
.pmc record del verified <ID>        删除指定用户的通过记录
.pmc record del verified all         清空所有通过记录
.pmc record del failed <ID>          删除指定用户的失败记录
.pmc record del failed all           清空所有失败记录
```

---

## 验证模式说明

### `math` — 数学计算题

随机生成加减乘除、两步混合、整除、平方等题目，答案须为精确数字。

```
🔒 人机验证

请回复以下算式的答案：

7 × 14 + 3 = ?

⏱ 验证时间：30 秒
🔢 剩余次数：3 次
⚠️ 验证失败将会：仅归档并静音
```

### `text` — 文字关键词

使用默认关键词 `我同意` 时，从内置题库随机出题；自定义关键词时要求用户回复指定词语。

```
# 默认（随机问答）
🔒 人机验证

请回答以下问题：

天空是什么颜色？（中文）

# 自定义关键词
.pmc set keyword 我同意
```

### `img_digit` / `img_mixed` — 图片验证码

自动安装 `canvas` 模块并生成 5 位噪点验证码图片。

- `img_digit`：纯数字（`0–9`）
- `img_mixed`：大写字母+数字（已排除易混淆字符 `0/O`、`1/I`）
- 支持 **1 字符容错**（Levenshtein 编辑距离 ≤ 1），防止输入法误触

> 首次使用图片模式时会自动执行 `npm install canvas`，需要网络连接，耗时约 1–2 分钟。

---

## 行为逻辑

```
陌生人发消息
    │
    ├─ 白名单用户？→ 直接放行
    │
    ├─ 正在验证中？→ 判断答案
    │       ├─ 正确 → 记录通过，执行通过操作，发送通过消息
    │       └─ 错误 → 计次，超过上限则执行失败操作
    │
    └─ 初次来信 → 归档 + 静音 → 发送验证题目
                                    │
                                    └─ 超时 → 执行失败操作
```

**注意：**
- 验证通过后**不会**自动加入白名单，需要用 `.pmc wl pass` 手动操作
- 失败操作始终包含归档+静音，`block/delete/report` 等为额外操作
- 非文字消息（贴纸、图片等）在验证期间会被忽略，不计入错误次数

---

## 典型配置示例

**基础防骚扰（推荐新手）**

```
.pmc captcha on
.pmc captcha mode math
.pmc set timeout 60
.pmc set tries 3
.pmc set pass unmute unarchive
```

**严格模式（高风险账号）**

```
.pmc captcha on
.pmc captcha mode img_mixed
.pmc set timeout 30
.pmc set tries 1
.pmc set fail block delete_revoke report
.pmc set pass unmute unarchive
```

**宽松关键词模式**

```
.pmc captcha on
.pmc captcha mode text
.pmc set keyword 我同意
.pmc set timeout 0
.pmc set tries 0
.pmc set pass unmute unarchive
```

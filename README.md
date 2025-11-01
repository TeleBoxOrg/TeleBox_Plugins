# TeleBox_Plugins

## 简介
TeleBox_Plugins 是 TeleBox 项目的官方插件仓库，提供丰富的功能插件扩展。

## 插件安装方式
```bash
npm i <插件名>
```

## 可用插件列表
- `aban` - 高级封禁管理工具  
- `acron` - 定时发送/转发/复制/置顶/取消置顶/删除消息/执行命令  
- `ai` - ai聚合插件  
- `aitc` - AI Prompt 转写  
- `atadmins` - 一键艾特全部管理员  
- `audio_to_voice` - 音乐转音频  
- `autochangename` - 自动定时修改用户名插  
- `autodel` - 定时删除消息  
- `autodelcmd` - 自动删除命令消息插件  
- `banana` - Nano-Banana 图像编辑  
- `bin` - 卡头检测  
- `bizhi` - 发送一张壁纸  
- `bs` - 保送  
- `bulk_delete` - 批量删除消息工具  
- `calc` - 计算器  
- `clean_member` - 群组成员清理工具  
- `clear_sticker` - 批量删除群组内贴纸  
- `clearblocked` - 批量清理已拉黑用户  
- `convert` - 视频转音频插件  
- `copy_sticker_set` - 复制贴纸包  
- `cosplay` - 获取随机cos写真  
- `crazy4` - 疯狂星期四文案  
- `da` - 删除群内所有消息  
- `dbdj` - 点兵点将 - 从最近的消息中随机抽取指定人数的用户  
- `dc` - 获取实体DC  
- `dig` - DNS 查询工具  
- `dme` - 删除指定数量的自己发送的消息  
- `eat` - 生成带头像表情包  
- `eatgif` - 生成"吃掉"动图表情包  
- `encode` - 简单的编码解码插件  
- `fadian` - fadian语录  
- `getstickers` - 下载整个贴纸包  
- `gfw` - 快速检查域名/IP是否被墙  
- `gif` - GIF与视频转贴纸插件  
- `git_PR` - Git PR 管理插件  
- `gt` - 谷歌中英文互译  
- `his` - 查看被回复者最近消息  
- `httpcat` - 发送一张http状态码主题的猫猫图片  
- `ids` - 用户信息显示以及跳转链接  
- `im` - 群组媒体消息监控封禁  
- `ip` - IP 地址查询  
- `javdb` - 寻找番号封面  
- `keyword` - 关键词自动回复  
- `kitt` - 高级触发器: 匹配 -> 执行, 高度自定义, 逻辑自由  
- `komari` - Komari 服务器监控插件  
- `lottery` - 抽奖工具  
- `manage_admin` - 管理管理员  
- `moyu` - 摸鱼日报  
- `music` - YouTube音乐  
- `music_bot` - 多音源音乐搜索  
- `netease` - 网易云音乐  
- `news` - 每日新闻插件  
- `ntp` - NTP 时间同步插件  
- `oxost` - 回复聊天中的文件与媒体 得到一个临时的下载链接  
- `parsehub` - 社交媒体链接解析助手  
- `pic_to_sticker` - 图片转表情  
- `pmcaptcha` - pmcaptcha私聊验证  
- `q` - 消息引用生成贴纸  
- `qr` - QR 二维码插件  
- `rate` - 货币实时汇率查询与计算  
- `search` - 频道消息搜索工具  
- `service` - systemd服务状态查看工具  
- `shift` - 智能消息转发系统  
- `soutu` - soutu搜图插件  
- `speedlink` - 对其他服务器测速  
- `speedtest` - 网络速度测试工具  
- `ssh` - ssh管理  
- `sticker` - 偷表情  
- `sticker_to_pic` - 表情转图片  
- `sub` - substore简单管理  
- `sunremove` - 定向批量解除封禁用户  
- `t` - 文字转语音  
- `tel` - 手机号码相关信息查询  
- `trace` - 全局追踪点赞插件  
- `warp` - warp管理  
- `weather` - 天气查询  
- `whois` - 域名查询插件  
- `xm` - 全自动羡慕插件  
- `yinglish` - 淫语翻译  
- `yt-dlp` - YouTube 视频下载工具  
- `yvlu` - 为被回复用户生成语录  
- `zhijiao` - 掷筊 强随机 使用 笅杯卦辞廿七句  
- `zpr` - 二次元图片  

## 技术栈

- **开发语言**: TypeScript
- **数据库**: SQLite (better-sqlite3)
- **任务调度**: node-schedule
- **Telegram API**: telegram (GramJS)
- **图像处理**: Sharp
- **其他依赖**: axios, lodash 等
  

## 贡献指南

欢迎提交新插件或改进现有插件。请确保：
1. 遵循 TypeScript 编码规范
2. 包含完整的功能说明
3. 添加适当的错误处理
4. 更新 plugins.json 配置文件

## 声明

本仓库的表情素材等均来自网络，如有侵权请联系作者删除

## 许可证

本项目采用开源许可证，具体请查看各插件的许可证声明。

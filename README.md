# DSM-gmgn v2.6.8 — Edge-TTS 播报版

Chrome 扩展，提供 GMGN 推特监控播报、跨屏搜索、已看 CA 标记和 5 秒决策辅助。

## 推特监控播报

- 与 [Tech-Melon/GmgnTwitterAudioPlayer](https://github.com/Tech-Melon/GmgnTwitterAudioPlayer) 一致，在 MAIN world 监听 GMGN 的 `twitter_user_monitor_basic` WebSocket。
- 博主名称读取服务端字段 `u.n`，缺失时回退 Twitter ID `u.s`。
- 播报格式为“名称 发推啦”；同一推送中的多位博主使用顿号合并。
- 使用参考插件同款 Cloudflare Edge-TTS 接口生成 MP3，不下载本地模型。
- 音频在扩展 offscreen 页面顺序播放，支持后台标签页和多标签去重。
- 表情、旗帜及装饰符号会在送入 TTS 前清理。

## 音色与语速

- 晓晓：`zh-CN-XiaoxiaoNeural`
- 云健：`zh-CN-YunjianNeural`
- 晓伊：`zh-CN-XiaoyiNeural`
- Ava：`en-US-AvaMultilingualNeural`
- 语速：较快 `+15%`、极快 `+50%`、闪电 `+75%`

Edge-TTS 需要联网。当前使用参考插件的公共 Worker：
`https://cloudflare-edge-tts.tech-melon.workers.dev/tts`

## 其他功能

- 已看 CA：多标签同步隐藏已查看卡片的紫色标记。
- 跨屏正文划词搜索和 GMGN 绿色高亮词直搜。
- 5 秒决策倒计时、尺寸/位置和休息提醒设置。

## 安装与升级

1. 打开 `chrome://extensions/`。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”并选中本目录。
4. 升级后点击扩展的“重新加载”，再刷新所有 GMGN 标签页。

## 验证重点

- 在扩展面板选择音色后点击“试听”，应立即联网生成并播放“币安 Binance 华语 发推啦”。
- 新推文到达时应只播一次对应的 GMGN 推送显示名。
- 多人同批消息应合并为“名称一、名称二 发推啦”。

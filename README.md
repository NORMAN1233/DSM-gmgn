# DSM-gmgn v2.7.0 — 双引擎播报版

Chrome 扩展，提供 GMGN 推特监控播报、跨屏搜索、已看 CA 标记和 5 秒决策辅助。

## 推特监控播报

- 与 [Tech-Melon/GmgnTwitterAudioPlayer](https://github.com/Tech-Melon/GmgnTwitterAudioPlayer) 一致，在 MAIN world 监听 GMGN 的 `twitter_user_monitor_basic` WebSocket。
- 播报名优先级：**GMGN 自定义备注（橙色）→ 服务端昵称 `u.n` → Twitter ID `u.s`**。
- 备注从监控卡片 DOM 抓取（内联橙色 `rgb(248,185,81)` 是唯一识别信号），缓存于
  `chrome.storage.local`（key `dsmTwitterRemarksV1`），跨会话生效；每 5 秒后台扫描一次保持新鲜。
  若 WS 帧里的 id/tw 与页面 handle 对不上，还会用「昵称 → handle」映射反查。
- 新推文卡片常比 WS 帧晚渲染：播报前若备注尚未命中，会边补抓边等待（每 160ms 一轮，
  最多约 1.2 秒），全部命中立即播；缓存已热时零延迟。
- 播报格式为“名称 发推啦”；同一推送中的多位博主使用顿号合并。
- 双引擎按语言自动路由（2026-08-22）：**含中文的播报（含中英混合）走 Chrome 内置
  `chrome.tts` 系统引擎**，纯英文文本走参考插件同款 Cloudflare Edge-TTS 接口。
  原因：该公共 worker 的中文合成路径已损坏——纯中文上游直接报错、混合文本被截断成
  首词碎片（本地 Whisper 转写实证），仅纯英文正常；chrome.tts 的中文语音可顺带读出
  其中的英文单词。音色设置仅对 Edge-TTS 生效，系统引擎自动挑选最优中文语音；
  语速对两个引擎都生效。
- 音频在扩展 offscreen 页面顺序播放（Edge-TTS 路径），支持后台标签页和多标签去重。
- 表情、旗帜及装饰符号会在送入 TTS 前清理；希腊形近字（如 DΞGEN）、被空格/点隔开的
  字母串（如 D E G E N）会先归一成普通单词再合成；含数字的全大写词（如 FOMO3、
  SHIB2MOON）会转为首字母大写避免逐字母拼读；中英贴邻处自动补空格。
  实测验证：该 TTS 引擎对正常大小写英文均按单词朗读。

## 备注播报排查方法

1. 重载扩展并打开监控页，等约 5 秒。
2. DevTools 控制台（上下文切到 DSM-gmgn 扩展）执行 `__dsmRemarks()`，应看到 handle→备注映射；
   内容脚本也会在缓存变化时输出 `[DSM remark] 缓存更新:` 日志。
3. 触发播报时控制台输出 `[DSM speak] 备注命中(handle)` 或 `无备注，回退昵称`，
   Service Worker 控制台输出 `[DSM-TTS]` 最终送入合成的文本。
4. 若始终「无备注」，在页面主世界控制台（默认上下文）输入 `__dsmLastWsSample`
   查看最近一帧 WS 的原始 id/tw/name 字段，与 `__dsmRemarks()` 的 handle
   对照即可定位是字段对不上还是抓取没命中。

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

# DSM-gmgn v2.8.2 — GMGN + Axiom 版

Chrome 扩展，提供 GMGN 推特监控播报，以及同时覆盖 GMGN / Axiom 的跨屏搜索、已看 CA 标记和 5 秒决策辅助。

弹窗采用 DataStorm 风格的 Fusion Pixel 中文像素字体与极简高对比布局，并提供容量受限的本地运行日志。日志仅在语音、
跨屏搜索和设置变更等关键事件发生时写入，最多保留 120 条，不增加交易页面的高频轮询或渲染负担。
运行日志页支持一键导出：工具栏「导出」按钮把全量日志（忽略筛选）下载为
`dsm-gmgn-logs-日期-时间.txt`，含扩展版本、导出时间与每条记录的时间/级别/分类/标题/详情，方便贴给排查。

## 推特监控播报

- 与 [Tech-Melon/GmgnTwitterAudioPlayer](https://github.com/Tech-Melon/GmgnTwitterAudioPlayer) 一致，在 MAIN world 监听 GMGN 的 `twitter_user_monitor_basic` WebSocket。
- 播报名优先级：**GMGN 自定义备注（橙色）→ 服务端昵称 `u.n` → Twitter ID `u.s`**。
- 备注从监控卡片 DOM 抓取（内联橙色 `rgb(248,185,81)` 是唯一识别信号），按 handle 独立缓存于
  `chrome.storage.local`（前缀 `dsmTwitterRemarkV2:`），跨会话生效，并兼容读取旧版
  `dsmTwitterRemarksV1`；每 5 秒后台扫描一次保持新鲜。普通昵称出现时不会删除已知备注，
  多个 GMGN 标签页更新不同博主时也不会整表互相覆盖。
  若 WS 帧里的 id/tw 与页面 handle 对不上，还会用持久化的「昵称 → handle」映射反查。
- 新推文卡片常比 WS 帧晚渲染：播报前若备注尚未命中，会边补抓边等待（每 160ms 一轮，
  同时约每 800ms 精确复查持久缓存，最多约 4.8 秒），全部命中立即播；缓存已热时零延迟。
- 播报格式为“名称 发推啦”；同一推送中的多位博主使用顿号合并。
- 「回复 @某人」类监控事件不播报：注入层按 `in_reply_to_*` / `reply_*` / `parent_*` 字段、
  `referenced_tweets` 的 replied_to 及 type 文本识别回复事件并剔除，只对原推说“发推啦”。
  若仍误播回复或原推漏播，在页面主世界控制台输入 `__dsmLastWsRawSample` 查看最近一帧的
  完整原始字段（kept / droppedAsReply 计数 + 每条 item），据此增删 `twitter-inject.js`
  里 `isReplyItem` 的识别清单。
- 「回复 @某人」标签不会再被误存为备注（v2.7.4，真机日志实证播报念成“回复 XXX
  发推啦”）：该标签的 `text-yellow-100` 与备注同色，且外层 span 把 @handle 链接包在
  里面。修复：抓取层跳过内含 x.com/twitter.com 链接的 span；文本层拒收“回复/Reply”
  开头的候选；旧版 V1/V2 存储里的此类脏项在加载与合并时自动清除。
- 使用参考插件同款 Cloudflare Edge-TTS 接口生成 MP3，不下载本地模型。
- 音频在扩展 offscreen 页面顺序播放，支持后台标签页和多标签去重。
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

- 已看 CA：GMGN / Axiom 共用一份记录；GMGN 隐藏已查看卡片紫条，Axiom 卡片降低饱和度并显示“已看”。
- 跨屏搜索：从 GMGN 正文划词或绿色高亮词发起，可投送到另一屏 GMGN 或 Axiom 全局搜索。
- “Axiom 作为主搜索页”默认关闭；开启后划词/高亮词只投送到已打开的 Axiom 页面，自动打开全局搜索并填入关键词。未打开 Axiom 时会直接提示，不会回退到 GMGN。
- 5 秒决策：GMGN `/token/`、`/pump/` 与 Axiom `/meme/{CA}` 详情页均自动启动倒计时。
- 圆形尺寸/位置和非阻塞休息提醒同样支持两平台。
- 推特 WebSocket 监听、备注提取和 Edge-TTS 播报仍只在 GMGN 页面运行。

## 安装与升级

1. 打开 `chrome://extensions/`。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”并选中本目录。
4. 升级后点击扩展的“重新加载”，再刷新所有 GMGN / Axiom 标签页。

## 验证重点

- 在扩展面板选择音色后点击“试听”，应立即联网生成并播放“币安 Binance 华语 发推啦”。
- 新推文到达时应只播一次对应的 GMGN 推送显示名。
- 多人同批消息应合并为“名称一、名称二 发推啦”。
- 打开 Axiom `/meme/{CA}` 详情页时应出现 5 秒倒计时，返回 Pulse 后该 CA 卡片应显示“已看”。
- GMGN 划词或绿色高亮词应能投送到另一屏的 Axiom 全局搜索。

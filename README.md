# DSM-gmgn v2.9.8 — GMGN + Axiom 版

Chrome 扩展，提供 GMGN 推特监控播报，以及同时覆盖 GMGN / Axiom 的跨屏搜索、已看 CA 标记和 5 秒决策辅助。

弹窗采用 DataStorm 风格的 Fusion Pixel 中文像素字体与极简高对比布局，并提供容量受限的本地运行日志。日志仅在语音、
跨屏搜索和设置变更等关键事件发生时写入，最多保留 120 条，不增加交易页面的高频轮询或渲染负担。
运行日志页支持一键导出：工具栏「导出」按钮把全量日志（忽略筛选）下载为
`dsm-gmgn-logs-日期-时间.txt`，含扩展版本、导出时间与每条记录的时间/级别/分类/标题/详情，方便贴给排查。

## 推特监控播报

- 与 [Tech-Melon/GmgnTwitterAudioPlayer](https://github.com/Tech-Melon/GmgnTwitterAudioPlayer) 一致，在 MAIN world 监听 GMGN 的 `twitter_user_monitor_basic` WebSocket。
- 播报名优先级：**GMGN 自定义备注（橙色）→ 服务端昵称 `u.n` → Twitter ID `u.s`**。
- 播报按 Twitter 账号身份合并：同一账号一旦命中 GMGN 备注，备注会覆盖该账号的昵称/句柄，
  两者不会再并列播出；旧缓存中的“备注 + @句柄”组合会在读取时自动清洗。
- 备注从监控卡片 DOM 抓取（内联橙色 `rgb(248,185,81)` 是唯一识别信号），按 handle 独立缓存于
  `chrome.storage.local`（前缀 `dsmTwitterRemarkV2:`），跨会话生效，并兼容读取旧版
  `dsmTwitterRemarksV1`；每 5 秒后台扫描一次保持新鲜。普通昵称出现时不会删除已知备注，
  多个 GMGN 标签页更新不同博主时也不会整表互相覆盖。
  若 WS 帧里的 id/tw 与页面 handle 对不上，还会用持久化的「昵称 → handle」映射反查；发现
  同名账号时会废弃这条歧义映射，避免把甲账号的备注套到乙账号。
- **零等待即时播报（v2.9.2）**：WS 帧到达即刻出声，不再为等备注阻塞。备注命中只取决于
  持久缓存（启动全量加载 + MutationObserver/5 秒扫描 + storage.onChanged 跨标签实时合并）：
  缓存里有的博主念备注，没有的直接念昵称，备注稍后渲染出来会照常入缓存、下一条即命中。
  旧版为抓齐备注最多轮询等待 4.8 秒，而新卡片渲染总晚于 WS 帧，是播报延迟的最大来源。
  弹窗日志的播报条目现在带「｜等Xms」后缀，可直接对证每条的 content 侧耗时。
- **同文冷却（v2.9.3）**：GMGN 监控通道会把同一条推文随快照反复重发（实测 2~10 秒一帧），
  而注入层指纹取帧内推文 ID 列表哈希、item 缺 ID 字段时退化为易变 JSON，重发即换指纹，
  60 秒 key 去重挡不住，同一句「XX 发推啦」会连播两三遍。现在对最终播报文本做 25 秒
  冷却：content 侧拦截重发，background 侧按文本再兜底（覆盖多标签页不同指纹），
  同一句 25 秒内只播首条；不同博主、含条数的合并文案不受影响。
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
- 音频在扩展 offscreen 页面顺序播放；语音合成与播放解耦（v2.9.2）：上一条在播放时，
  下一条已并行合成，突发多条推文不再以「合成+播放」总时长逐条排队。GMGN 页面以 20s
  心跳保持 service worker 常驻并预建 offscreen，播报免去冷启动。支持后台标签页和多标签去重。
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
- 跨屏路由：从 GMGN 正文划词或绿色高亮词发起；Axiom 主页面模式下，合法 CA 会通过
  Axiom 当前搜索结果的真实链接进入 K 线详情，名称/Ticker 等普通关键词只停留在全局搜索。
- **划词投送修复（v2.9.4）**：GMGN 搜索注入函数此前要求「点击启动器后出现全新弹窗输入框」，
  而首次搜索成功后结果弹窗会保持打开——同一弹窗再投送时既不是新节点、焦点也不会自动落入，
  必然报 `modal-search-input-not-found`（真机日志连续 8 条实证）。现在弹窗已打开时直接把新
  关键词打进现有弹窗；页头搜索框位置判定（top<180）也放宽为占位词命中即可；失败原因细分为
  `gmgn-search-launcher-not-found` / `modal-search-input-not-found` 便于日志定位。
- **探针同步放宽（v2.9.5）**：目标页探测（`no-gmgn-search-page` 的来源）此前比注入函数更严，
  同样有 top<180 和占位词硬性要求——GMGN 改占位词或目标页滚动后头部不吸顶时，所有标签页
  被误判「无全局搜索框」，划词直接哑火。现在探测与注入用同一套放宽判定，另加
  `[data-sentry-component="Search"]` 组件标记兜底层；失败日志会写明每一屏的探测结果：
  「未响应(请刷新该标签页)」= 重载扩展后的孤儿脚本，「无搜索框(pi-input×N)」= 对照 N 值
  判断 GMGN 是否改版。
- “Axiom 作为主搜索页”默认关闭；开启后划词/高亮词只投送到已打开的 Axiom 页面：CA 直达 K 线，
  其他关键词自动打开全局搜索并填入。未打开 Axiom 时会直接提示，不会回退到 GMGN。
- **倒计时配音（v2.9.7，v2.9.8 扩为全程报数）**：决策读秒逐秒语音报数——设定几秒
  就从几一路报到 1（v2.9.8 起，不再只报最后 5 秒），走完未确认报「时间到」
  （弹窗可关；音色/语速/音量复用语音设置）。片段只合成一次并持久缓存
  （`dsmCountdownClipsV1`，按音色+语速整组替换，覆盖 1~60），进决策模块按当前
  设定秒数预合成、决策页 20s 心跳保 offscreen 常驻——每一拍都即时出声。
  配音走 offscreen 独立声道：数字被下一拍顶掉、绝不排队，也不打断推文播报。
- **红绿灯语义与丝滑动画（v2.9.6）**：决策圆球改为标准红绿灯——读秒中绿灯，
  倒计时走完未确认变红灯 ✕（弹一下提示），读秒内点击圆圈 = 手动确认绿灯 ✓。
  换灯用红/绿双层伪元素按 opacity 交叉淡化（radial-gradient 本身不可插值，
  旧版直接换 class 是瞬跳）；显隐只过渡 transform/opacity 交由合成器渲染，
  从 K 线详情页切到扫链页时主线程再忙，圆球淡出也不掉帧。
- 5 秒决策：GMGN `/token/`、`/pump/` 与 Axiom `/meme/{CA}` 详情页均自动启动倒计时。
- Axiom 快捷键：`C` 同步触发顶部原生“Paste CA”按钮，由 Axiom 读取剪贴板并进入 K 线详情；
  按住 `X` 打开 Axiom 原生 X 预览，松开立即关闭。
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
- GMGN 点击合法 CA 高亮词时，另一屏 Axiom 应直接进入 `/meme/{CA}` K 线详情，不应停留在搜索页；
  名称/Ticker 等普通词仍应进入 Axiom 全局搜索。

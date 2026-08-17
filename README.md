# DSM-gmgn

合并插件：
- `jiankongtiao`：GMGN 已看 CA 标记
- `GMGN-5s-Decision`：GMGN 5 秒极速辅助决策

UI 对齐 DataStorm：使用 Fusion Pixel 字体、深色像素网格风格；Logo 使用 GMGN 黑白小鳄鱼。

## 功能

- 已看 CA 标记：进入 K 线页自动记录 CA，返回钱包监控页后隐藏该卡片左侧紫色长条。
- 圆形 5 秒决策：GMGN K 线详情页显示可拖动、可调大小的圆形倒计时。
  - 滚轮上下滚动可调整秒数（1–60 秒）
  - 右下角圆点可拖动调整大小（60–400px）
  - 倒计时中点击圆圈可手动确认狙击，变绿显示 ✓
- 电池休息提醒：到时间后只显示右上角非阻塞提醒，不再盖住整个画面。
- 功能开关与设置：Popup 中可开关每个模块，并调整秒数、圆形大小、电池时长、休息时长。

## 安装

1. 打开 Chrome，进入 `chrome://extensions/`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本文件夹：

```
D:\ai project\gmgn小工具插件\DSM-gmgn
```

5. 刷新 GMGN 页面。

## 目录

- `manifest.json` - MV3 插件清单
- `content.js` - 合并后的页面脚本（轻量化，无全页 MutationObserver）
- `styles.css` - 页面内圆形倒计时 / 休息提醒 / 已看标记样式
- `popup.html` / `popup.js` - 插件设置面板
- `popup.css` / `gmgn-theme.css` / `font-fix.css` / `dsm-custom.css` - DataStorm 风格 UI
- `fusion-pixel-12px-zh-hans.woff2` / `FUSION-PIXEL-FONT-OFL.txt` - 字体与许可证
- `gmgn-logo.svg` / `gmgn-logo.png` - GMGN 黑白小鳄鱼 Logo

## 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 已看 CA 标记 | 开 | 隐藏已查看卡片的紫色长条 |
| 5 秒极速决策 | 开 | K 线页显示圆形倒计时 |
| 电池休息提醒 | 开 | 到时间后右上角非阻塞提醒 |
| 倒计时秒数 | 5 | 1–60 秒，也可在圆圈上滚轮调整 |
| 圆形大小 | 120 | 60–400px，也可拖右下角圆点调整 |
| 电池时长 | 40 | 10–240 分钟 |
| 休息时长 | 20 | 5–120 分钟 |

## 性能说明

- 不注入全页 MutationObserver。
- 已看 CA 只在钱包监控页用 `requestIdleCallback` 空闲时扫描。
- 决策扫描只在开始和结束时各执行一次，避免频繁读取大段 DOM 文本。
- SPA 路由检测使用 history 包装 + 低频轮询，不再监听巨大 DOM 树。


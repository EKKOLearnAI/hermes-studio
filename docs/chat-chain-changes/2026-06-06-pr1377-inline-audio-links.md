---
date: 2026-06-06
pr: 1377
feature: Markdown 音频链接内联播放
impact: Chat markdown 渲染会把本地音频链接显示为内联播放控件，而不是通用文件卡片。
---

`MarkdownRenderer` 现在将音频扩展名单独分类；`mp3` 等本地音频附件会渲染为内联 `<audio>` 控件，不再落到通用文件卡片路径。

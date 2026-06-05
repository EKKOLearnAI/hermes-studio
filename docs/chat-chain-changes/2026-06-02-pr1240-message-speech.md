---
date: 2026-06-02
pr: 1240
commit: 6792a451
feature: 消息语音播放
impact: 修复浏览器语音无法按同一消息切换暂停/继续的问题。
---

普通 Chat 的 `MessageItem.vue` 使用 `useSpeech.toggleBrowser()` 处理 Web Speech 播放/暂停；同时更新 bridge OpenRouter attribution 环境变量品牌值。

---
date: 2026-06-05
pr: 1353
feature: TTS 后端合成播放入口
impact: Chat 和 Group Chat 的 assistant 消息播放按钮改为走统一后端 synthesize，并保持 pending TTS 请求可停止/中断。
---

`MessageItem` 和 `GroupMessageItem` 的 TTS 播放入口对齐到统一后端合成路径。用户点击播放时仍在消息气泡内触发，停止或切换播放会 abort pending synthesize request，避免旧请求继续占用播放状态。

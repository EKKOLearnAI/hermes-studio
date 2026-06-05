---
date: 2026-06-05
pr: 1347
feature: Chat 流式滚动和桌面启动淡入
impact: 用户滚离底部后流式输出不再强制拉回底部，Windows 桌面窗口显示恢复 ready 后淡入。
---

`MessageList` 和 `VirtualMessageList` 收紧自动贴底策略：流式更新只在用户仍接近底部时做单帧滚动，用户手动滚离底部会取消 pending bottom frames；切 session 和 run start 的初始定位使用有限保活，减少虚拟列表重建后的抖动。

桌面主窗口改为默认隐藏，ready 后通过统一显示路径在 Windows 上淡入；自动更新重启和托盘打开窗口都复用同一逻辑。

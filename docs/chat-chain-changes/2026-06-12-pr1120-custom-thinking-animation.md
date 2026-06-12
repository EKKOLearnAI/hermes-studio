---
date: 2026-06-12
pr: 1120
commit: f67effa
feature: 自定义思考动画 + 头像大小可调（per profile）
impact: 不改变 /chat-run 协议、消息落库或 run 生命周期；仅影响流式输出指示器的动画图片和聊天消息中头像的渲染尺寸。
---

`MessageList.vue` 引入 `profilesStore`，通过 `thinkingImageUrl` computed 读取当前 profile 的自定义思考动画（支持关闭），fallback 到内置 dark/light GIF；当用户关闭 thinking animation 时流式指示器不显示。

`MessageItem.vue` 读取 profile avatar 的 `avatar_size` 字段（默认 40px），将 assistant 头像从固定尺寸改为动态绑定：`:size` prop + inline `:style` 覆盖 scoped CSS。

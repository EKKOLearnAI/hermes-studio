---
date: 2026-08-01
pr: 2226
commit: pending
feature: Group Chat participant avatar direct runtime controls
impact: Existing Room, participant, Session and message identities stay unchanged. Participant provider, model, API mode and reasoning overrides apply from the next run; structured @ insertion continues to route by stable participantId.
---

Group Chat 的成员头像列表新增单层 inline 快捷配置：直接选择模型与 API 模式、滑动推理强度，并插入结构化 Mention。配置更新不打断当前 run；Hermes participant 的 API mode 会真实传入 Agent Bridge。旧 Room 中缺失或为空的 runtime/config 字段继续按既有默认值兼容读取，无需迁移历史消息或 Session。

---
date: 2026-08-02
pr: 2226
commit: pending
feature: Group Chat participant quick-setting Room authority generation fence
impact: Participant quick-setting PATCH responses are bound to the exact Room authority generation. Leaving and re-entering the same Room invalidates stale success, failure, rollback and notification publication while preserving the newer Room state and user intent.
---

Group Chat 的 participant 快捷配置队列新增单调 Room authority generation。即使用户执行 A → B → A，旧 epoch 的 PATCH 成功回包也不能覆盖重新加载的 participant；旧失败不能写入当前 Store error，也不能触发当前 epoch 的 rollback 或 toast。返回 A 后产生的新配置 intent 继续保持权威。

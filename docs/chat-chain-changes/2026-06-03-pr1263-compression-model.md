---
date: 2026-06-03
pr: 1263
commit: e6648456
feature: 上下文压缩辅助模型配置
impact: Chat 压缩链路可以使用 profile 级 compression 专用 provider/model。
---

新增 profile 级 `auxiliary.compression` 设置。Chat 压缩链路在 `buildCompressedHistory()`、bridge forced compression 和运行中 compression request 中都会解析 compression 专用 provider/model；`auto` 使用当前 session model/provider，`main` 使用 profile 默认模型，显式配置则使用 compression 专用模型。

---
date: 2026-08-09
pr: 2445
commit: pending
feature: Group Chat 大工具结果 token 记账与确定性消息游标
impact: 超大消息在 Group Chat 持久化记账与 Ekko Agent 请求用量估算两条链路中都以固定工作量返回保守估算，避免随输入长度线性阻塞 Node 主线程；Group Chat canonical ID 排序与 SQLite UTF-8 BINARY 顺序一致，避免补充平面 Unicode 游标漏消息；实时 mention 路由继续保留 absent metadata 为 undefined。
---

本次在已有增量 token cache 修复上补齐终审发现的边界：Group Chat 持久化记账与 Ekko Agent 请求用量估算都在超过 8 Mi UTF-16 code units 后使用基于 UTF-8 byte 上界的常数时间保守估算；等时间戳消息以 UTF-8 bytes 比较 ID；`upsertMessage()` 返回规范化持久化内容的同时保持调用方 structured mentions 三态语义。

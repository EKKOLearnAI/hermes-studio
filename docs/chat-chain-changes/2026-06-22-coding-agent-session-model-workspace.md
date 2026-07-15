---
date: 2026-06-22
commit: local
feature: 会话默认 workspace 持久化
impact: Hermes/Claude/Codex 未显式选择 workspace 时会落库默认 workspace，模型切换后继续沿用。
---

Hermes bridge run 在创建或首次使用 session 时会把 profile 下的默认 `workspace` 目录写入本地 session store。Coding agent launch 会优先使用 session store 里已有的 workspace；未显式选择 workspace 的新 Claude/Codex session 仍由 launcher 计算默认目录并写回 DB。`/api/hermes/sessions/:id/model` 对 coding agent session 不再通知 Hermes bridge 热切换，也不会在点击切换时停止当前 hidden runner；模型或 provider 变化时只清空旧 `agent_native_session_id`，下一条消息会用更新后的 model/provider/protocol 启动新的 proxy/native 会话，并沿用 DB 中的 workspace。前端 coding agent session 切换模型时会先选择模型，再弹出协议选择，确认协议后才提交切换。

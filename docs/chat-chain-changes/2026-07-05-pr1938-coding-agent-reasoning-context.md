---
date: 2026-07-05
pr: 1938
commit: a087a1e
feature: coding agent reasoning and context controls
impact: Codex / Claude Code 单聊会话复用 Hermes 输入栏的推理强度与上下文长度设置，发送时会把 reasoning_effort 传入 coding-agent 启动与代理链路。
---

前端不再对 `source === "coding_agent"` 隐藏推理强度选择器，也会在新会话显示上下文长度行，方便直接编辑模型上下文窗口。

后端 socket run payload 接收 `reasoning_effort`，coding-agent launch / run manager / proxy target 会携带该设置；当推理强度变化时，隐藏的 Codex / Claude Code 进程会重新启动以应用新配置。

代理适配层会按上游模式透传推理字段：OpenAI Chat Completions 使用 `reasoning_effort`，OpenAI Responses 使用 `reasoning: { effort }`，Anthropic-compatible 请求使用 `reasoning_effort`。Codex model catalog 同步声明 `none` / `minimal` 推理等级。

补充：全局 coding-agent 模式继续依赖用户本机 CLI 配置，不从 Web UI payload 注入 `reasoning_effort`；scoped 模式才会透传该会话级设置。

补充：coding-agent 响应完成后会刷新并持久化 token usage，前端通过 `usage.updated` 接收最新 `contextTokens`，避免 Codex / Claude Code 会话上下文用量停留在旧值。

修正：coding-agent usage 刷新现在按会话串行化，并在同一事件中发送 input/output/context 的完整快照；统计失败时保留旧值，避免上下文用量因竞态或异常短暂跳变为 0。

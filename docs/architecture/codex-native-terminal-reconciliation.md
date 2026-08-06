# Codex 原生成功被代理流失败误判：根因与修复

## 结论

当 Hermes Studio 以 Codex Coding Agent 运行任务时，Codex CLI 子进程和 Studio Provider Proxy 会同时观察同一次模型调用：

- Codex CLI 的 JSONL/进程退出是 Coding Agent Run 的原生执行终态；
- Provider Proxy 的 Responses 事件用于流式文本、工具展示和 usage 采集。

故障发生在代理流短暂断开但 Codex CLI 自己成功重连并完成任务时。旧实现只在 Codex 子进程仍运行时忽略代理层 `response.completed`，却接受代理层 `response.failed`，把它缓存为整个 Run 的 `run.failed`。随后 Codex CLI 已生成最终消息并以退出码 `0` 结束，但子进程退出处理优先提交先前缓存的失败，导致群聊只持久化错误而没有持久化真实最终回复。

## 用户可见现象

群聊出现：

```text
Error: Reconnecting... 1/5
(stream disconnected before completion: stream closed before response.completed)
```

与此同时，Coding Agent 可能已经完成代码修改、测试、提交和推送，并在 Codex rollout 中生成完整最终回复。

## 现场证据

受影响 Run 的时间线：

| UTC 时间 | 证据 | 含义 |
|---|---|---|
| 01:45:46.000 | Codex rollout `agent_message` | 完整最终回复已生成 |
| 01:45:46.074 | Codex rollout `task_complete`，`duration_ms=775683` | Codex 原生任务完成 |
| 01:45:55.305 | 群聊 `gc_messages` 写入 `finish_reason=error` | Studio 约 9 秒后将代理流失败作为 Run 终态 |

同一时间窗口内：

- Studio 容器健康，未重启，未 OOM；
- Room API 返回 `200`；
- Socket.IO WebSocket upgrade 返回 `101`；
- 未发现对应的 Nginx `499/500/502/504`。

因此，现有证据支持“应用层终态仲裁错误”，不支持“容器重启、OOM 或反向代理中断导致任务未执行”。代理流最初为什么关闭仍不能仅凭这些证据精确归责到具体上游组件，但这不影响确认 Studio 的误判机制。

## 根因代码路径

`CodingAgentRunManager.handleResponseEvent()` 将以下事件视为 terminal event：

```ts
response.completed
response.failed
```

旧逻辑在 Codex 子进程仍运行时仅特殊处理 `response.completed`：

```ts
if (
  run.launch.agentId === 'codex' &&
  storageSafeResponseEvent.type === 'response.completed' &&
  childIsRunning(run.currentChild)
) {
  // 只保存 usage
  return
}
```

因此 `response.failed` 会继续执行：

1. 设置 `terminalEventHandled=true`；
2. 刷新并落库代理层错误响应；
3. 设置 `pendingChatCompletionEvent='run.failed'`。

Codex 子进程退出时，退出处理先检查 `pendingChatCompletionEvent`：

```ts
if (run.pendingChatCompletionEvent) {
  this.emitAndMarkPrintChatRunCompleted(...)
  return
}
if (code === 0) {
  this.completeCodexExecTurn(...)
}
```

所以旧的代理失败优先于退出码 `0`，原生成功无法成为最终 Run 状态。

## 修复原则

Codex 原生进程运行期间：

- 代理层 `response.completed`：只采集 usage，不裁决整个 Run；
- 代理层 `response.failed`：不裁决整个 Run；
- Codex 原生 JSONL `turn.failed` / `error`：必须立即保留为权威失败；
- 最终成功或失败由 Codex 原生 JSONL 和子进程退出状态决定。

代码通过 `acceptingPrintEvent` 区分事件来源：原生 JSONL 事件由 `handleClaudePrintResponseEvent()` 包装，处理期间该标志为 `true`；Provider Proxy 事件则为 `false`。`response.completed` 无论来源都需等待活跃 Codex 子进程退出，以免提前刷出工具边界；只有 `response.failed` 需要按来源区分。

Claude Code 和没有活跃原生 Codex 子进程的路径保持原语义。

## 最小修复

将 Codex 运行期间的判断扩展到所有代理 terminal event：

```ts
if (
  run.launch.agentId === 'codex' &&
  isTerminalEvent &&
  childIsRunning(run.currentChild)
) {
  if (storageSafeResponseEvent.type === 'response.completed') {
    // 保留 usage
  }
  return
}
```

这不是把真实失败改成成功。若 Codex 无法恢复，原生进程会以非零退出码或原生失败事件结束，现有退出处理仍会产生 `run.failed`。

## TDD 证据

新增双向回归测试：

1. **Proxy 可恢复断流**：Codex 原生子进程仍在运行时，Provider Proxy 发出 `response.failed`；断言不得设置 `terminalEventHandled`、不得缓存 `pendingChatCompletionEvent='run.failed'`、不得提前发出群聊 `run.failed`。
2. **原生失败**：Codex 原生 JSONL 在 child 仍运行时发出 `turn.failed`；断言必须设置 `terminalEventHandled`、缓存 `run.failed`，并保留原生错误。
3. **完成时序回归**：`response.completed` 在 child 仍运行时不得提前刷出工具消息或 `run.completed`，继续等待进程退出。

### RED

第一条修复前测试按预期失败：

```text
expected true not to be true
run.terminalEventHandled === true
```

独立复审发现最初修复会吞掉原生失败后，第二条测试也按预期失败：

```text
expected undefined to be true
run.terminalEventHandled === undefined
```

### GREEN

按事件来源收紧仲裁后：

```text
双向与完成时序定向测试：3 passed
agent-runner-utils.test.ts: 52 passed
agent-runner-utils.test.ts + coding-agents-launch.test.ts: 90 passed
```

## 验收要求

自动化测试通过后，还需在包含本修复的独立部署中执行真实运行时验收：

1. 启动 Codex Coding Agent Run；
2. 让代理层出现可恢复的 stream retry/failure；
3. 确认 Codex 原生任务最终成功；
4. 确认群聊最终持久化完整回复且 `finish_reason` 不是 `error`；
5. 再验证不可恢复失败仍产生 `run.failed`；
6. 回读 Run、消息、Session `end_reason` 与 workspace/Git 副作用，避免只看 UI 状态。

## 边界与未决事项

- 本修复解决 Studio 对双终态来源的错误仲裁。
- 本修复不声称消除 Provider 网络或上游 stream 断开。
- 首次 stream 关闭的最底层归属目前仍是 unknown；需要 Provider/AxonHub 与 Codex 请求级日志才能进一步精确定位。
- 在修复版本部署并完成真实断流验收前，生产环境只能判定“代码级修复和自动化回归通过”，不能宣称运行时问题已完全闭环。

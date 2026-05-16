# CLI/Bridge Chat Sessions 实现文档

> 状态：本文档描述当前 `main` 中 Web UI 聊天会话的 API Server / Bridge(beta) 双路径实现。

## 概述

当前实现把原来的聊天通道统一到 Socket.IO namespace `/chat-run`。前端仍使用同一套 `ChatPanel + MessageList + ChatInput`，通过会话的 `source` 字段区分运行方式：

| source | 运行路径 | 说明 |
|--------|----------|------|
| `api_server` | Web UI Server → Hermes Gateway `/v1/responses` | 默认聊天路径 |
| `cli` | Web UI Server → Python agent bridge → `AIAgent` | Bridge(beta)，在 Web UI 服务端子进程里直接运行 Hermes Agent |

Bridge 会话不是一个独立 UI 面板，而是普通会话的一种来源。用户通过“新建聊天”下拉菜单选择 `API` 或 `Bridge (beta)`。

Bridge 模式支持：

- 流式文本输出
- reasoning/thinking 增量
- tool started/completed 事件
- 工具审批请求与响应
- abort 中断
- per-session 队列
- profile 隔离
- 从 DB resume 会话
- 与 API Server 路径共用上下文压缩逻辑

当前不再支持旧文档里的独立 `/cli-chat-run` namespace、`CliChatPanel.vue`、`cli-chat.ts` 和独立 `command` / `steer` socket 事件。CLI/Bridge 会话中的 slash command 现在通过统一 `/chat-run` 的 `run` payload 进入后端解析；当前支持 `/usage`、`/status`、`/abort`、`/queue`、`/clear`、`/title`、`/compress`、`/steer`、`/destroy`。

---

## 整体架构

```text
ChatPanel.vue
  ├─ MessageList.vue
  └─ ChatInput.vue
        │
        │ Socket.IO /chat-run
        ▼
ChatRunSocket (Node.js)
  ├─ source=api_server → Hermes Gateway /v1/responses
  └─ source=cli        → AgentBridgeClient
                              │ TCP/Unix socket, newline JSON
                              ▼
                         hermes_bridge.py
                              │ in-process import
                              ▼
                         AIAgent (hermes-agent)
```

### 分流规则

`ChatRunSocket.resolveRunSource()` 决定本轮运行走哪个后端：

1. `run` payload 中 `source === 'cli'` 时走 bridge。
2. `source === 'api_server'` 时走 gateway。
3. 未显式传 `source` 时，如果 DB 中已有 session 的 `source` 是 `cli`，继续走 bridge。
4. 其他情况默认走 `api_server`。

---

## 主要文件

### 前端

| 文件 | 说明 |
|------|------|
| `packages/client/src/components/hermes/chat/ChatPanel.vue` | 统一聊天面板；新建菜单包含 `API` 和 `Bridge (beta)`；渲染审批条 |
| `packages/client/src/components/hermes/chat/MessageList.vue` | 统一消息列表；展示文本、reasoning、tool 消息等 |
| `packages/client/src/components/hermes/chat/ChatInput.vue` | 统一输入框；发送、停止、附件上传入口 |
| `packages/client/src/api/hermes/chat.ts` | `/chat-run` Socket.IO 客户端；注册 session 事件处理器；发送 run/abort/approval |
| `packages/client/src/stores/hermes/chat.ts` | 会话状态、发送流程、resume、队列、审批、消息映射 |

### 后端

| 文件 | 说明 |
|------|------|
| `packages/server/src/services/hermes/run-chat/index.ts` | `/chat-run` Socket.IO 入口；按 `source` 分流 API Server 与 Bridge 运行 |
| `packages/server/src/services/hermes/run-chat/handle-api-run.ts` | API Server 路径；调用 Hermes Gateway `/v1/responses` 并消费流式响应 |
| `packages/server/src/services/hermes/run-chat/handle-bridge-run.ts` | Bridge 路径；调用 Agent Bridge 并写入本地会话库 |
| `packages/server/src/services/hermes/run-chat/session-command.ts` | CLI/Bridge slash command 解析与处理 |
| `packages/server/src/services/hermes/agent-bridge/client.ts` | Node 端 bridge 客户端；通过 socket 请求 Python bridge |
| `packages/server/src/services/hermes/agent-bridge/manager.ts` | Python bridge 子进程生命周期管理 |
| `packages/server/src/services/hermes/agent-bridge/hermes_bridge.py` | Python bridge 服务；创建并复用 `AIAgent` 实例 |
| `packages/server/src/services/hermes/agent-bridge/index.ts` | bridge 模块导出 |
| `packages/server/src/index.ts` | 启动 `AgentBridgeManager` 和 `ChatRunSocket` |
| `packages/server/src/services/shutdown.ts` | 关闭时停止 chat socket 和 bridge 子进程 |
| `packages/server/src/controllers/hermes/sessions.ts` | 会话列表和详情读取，包含 `source` 信息 |
| `packages/server/src/controllers/hermes/profiles.ts` | profile 切换/管理时清理 bridge 内存会话 |

### 已移除的旧文件

| 文件 | 状态 |
|------|------|
| `packages/client/src/api/hermes/cli-chat.ts` | 已删除 |
| `packages/client/src/components/hermes/chat/CliChatPanel.vue` | 已删除 |
| `packages/server/src/services/hermes/cli-chat-run-socket.ts` | 已删除 |

---

## 前端流程

### 新建会话

`ChatPanel.vue` 中的新建按钮使用下拉菜单：

- `API`：调用 `chatStore.newChat()`，创建默认 `api_server` 会话。
- `Bridge (beta)`：调用 `chatStore.newCliSession()`，创建 `source: 'cli'` 会话。

Bridge 会话 ID 使用类似 `YYYYMMDD_HHMMSS_xxxxxx` 的格式，便于与 Hermes CLI 风格的 session ID 对齐。

### 发送消息

1. `ChatInput.vue` 触发 store 的发送逻辑。
2. `chat.ts` 根据 active session 组装输入内容，附件会被转为 `ContentBlock[]`。
3. 调用 `startRunViaSocket()`。
4. 前端向 `/chat-run` emit：

```ts
socket.emit('run', {
  session_id,
  input,
  instructions,
  model,
  queue_id,
  source, // api_server 或 cli
})
```

5. 前端注册本 session 的事件 handler，通过 `session_id` 隔离多会话并发事件。

### Resume

切换会话、页面恢复可见、或刷新后，前端通过：

```ts
socket.emit('resume', { session_id })
```

服务端返回：

```ts
{
  session_id,
  messages,
  isWorking,
  isAborting,
  events,
  inputTokens,
  outputTokens,
  queueLength,
}
```

如果服务端发现该 session 仍在运行，前端会重新注册 handler，并允许继续 abort。

### 审批

Bridge 工具需要人工确认时，服务端会发 `approval.requested`，前端 store 记录为 `activePendingApproval`，`ChatPanel.vue` 在输入框上方显示审批条。

前端响应审批：

```ts
socket.emit('approval.respond', {
  session_id,
  approval_id,
  choice, // once | session | always | deny
})
```

---

## `/chat-run` Socket.IO 协议

### 客户端 → 服务端

| 事件 | 数据 | 说明 |
|------|------|------|
| `run` | `{ session_id, input, model?, instructions?, queue_id?, source? }` | 启动一轮运行；`source` 决定 API Server 或 Bridge |
| `resume` | `{ session_id }` | 加入 session room 并恢复状态 |
| `abort` | `{ session_id }` | 中断当前运行 |
| `cancel_queued_run` | `{ session_id, queue_id }` | 取消等待队列中的一条 run |
| `approval.respond` | `{ session_id, approval_id, choice }` | 响应 Bridge 工具审批 |

客户端不再发送独立 `command` 或 `steer` Socket.IO 事件；slash command 作为普通 `run.input` 进入 `/chat-run`，由服务端在 `source=cli` 时解析。

### 服务端 → 客户端

| 事件 | 说明 |
|------|------|
| `resumed` | 返回 DB 消息、运行状态、队列长度和最近事件 |
| `run.started` | 运行开始 |
| `run.queued` | 当前 session 已有运行，新请求进入队列 |
| `message.delta` | 文本增量 |
| `reasoning.delta` | reasoning 增量 |
| `thinking.delta` | thinking 增量 |
| `reasoning.available` | reasoning 内容可用 |
| `tool.started` | 工具调用开始 |
| `tool.completed` | 工具调用结束 |
| `approval.requested` | Bridge 工具请求人工审批 |
| `approval.resolved` | 审批完成或超时 |
| `compression.started` | 上下文压缩开始 |
| `compression.completed` | 上下文压缩结束 |
| `usage.updated` | token 用量更新 |
| `abort.started` | 中断开始 |
| `abort.completed` | 中断结束 |
| `session.command` | slash command 的执行结果或错误反馈 |
| `run.completed` | 运行完成 |
| `run.failed` | 运行失败 |

### 认证

`/chat-run` 使用 Socket.IO auth token：

```ts
io(`${baseUrl}/chat-run`, {
  auth: { token },
  query: { profile },
})
```

如果未设置 `AUTH_DISABLED=1`，服务端会与 Web UI token 比对。

---

## ChatRunSocket 后端行为

### API Server 路径

`source=api_server` 时：

1. 写入用户消息到 Web UI 本地 session DB。
2. 通过 `buildCompressedHistory()` 构建上下文。
3. 请求当前 profile 的 Hermes Gateway：

```text
POST <upstream>/v1/responses
```

4. 读取 SSE frame，映射为统一的 `/chat-run` 事件。
5. 完成后写入 assistant/tool 消息，更新 usage。

### Bridge 路径

`source=cli` 时：

1. 写入用户消息到 Web UI 本地 session DB。
2. 复用同一套 `buildCompressedHistory()` 构建压缩上下文。
3. 调用：

```ts
this.bridge.chat(session_id, input, history, instructions, profile)
```

4. 轮询 `AgentBridgeClient.streamOutput(run_id)`。
5. 将 Python bridge 的 delta 和 events 映射成统一事件。
6. 将 assistant 文本、reasoning、tool 调用结果 flush 回 DB。

### 队列

同一个 `session_id` 同时只能有一个 active run。新的 `run` 到达时：

- 如果当前 session 正在运行，则放入 `state.queue`。
- 发送 `run.queued` 更新队列长度。
- 当前 run 结束或 abort 完成后，自动执行下一条 queued run。

---

## Python Agent Bridge

### 通信协议

Node 和 Python bridge 之间使用本地 socket 的单行 JSON 协议：

```json
{ "action": "chat", "session_id": "xxx", "message": "hello" }
```

响应也是单行 JSON：

```json
{ "ok": true, "run_id": "xxx", "session_id": "xxx", "status": "running" }
```

### Endpoint

默认 endpoint 按平台选择：

| 平台 | 默认 endpoint |
|------|---------------|
| Windows | `tcp://127.0.0.1:18765` |
| macOS/Linux | `ipc:///tmp/hermes-agent-bridge.sock` |

Windows 使用 TCP 是因为部分 Python/Windows 环境没有 Unix domain socket 支持。

### 当前实际使用的 action

| Action | 说明 |
|--------|------|
| `chat` | 启动一轮 `AIAgent.run_conversation()` |
| `get_output` | 通过 `cursor` 和 `event_cursor` 获取增量文本与事件 |
| `interrupt` | 调用 agent 中断当前运行 |
| `approval_respond` | 响应工具审批 |
| `destroy_all` | profile 切换/管理时销毁全部 bridge 内存 session |

bridge 代码里还保留了一些调试/维护 action，例如 `ping`、`get_result`、`get_history`、`destroy`、`list`、`shutdown`、`steer`。当前 `/chat-run` 前端路径不会直接暴露这些 action；需要的能力由 Node `/chat-run` 层封装，例如 `/steer` slash command 会调用 `steer` action。

旧的 `command` action 已移除，Python bridge 不再直接解析 `/new`、`/undo`、`/retry`、`/branch` 等旧斜杠命令；当前 CLI/Bridge slash command 支持范围以 Node `/chat-run` 的 `session-command.ts` 为准。

### 会话和 profile

`AgentPool` 维护 `session_id -> AgentSession`：

- 每个 session 持有独立 `AIAgent` 实例。
- session 按 profile 创建，profile 改变时会重建对应 agent。
- `HERMES_HOME` 会在创建 agent 时临时切到 profile home。
- `SessionDB` 按 profile 的 `state.db` 路径缓存。
- 空闲 session 会被 bridge GC，默认 30 分钟无运行后销毁内存态。

### 工具和审批事件

bridge 从 `AIAgent` 回调中收集事件：

- `stream.delta`
- `reasoning.delta`
- `thinking.delta`
- `tool.started`
- `tool.completed`
- `tool.progress`
- `approval.requested`
- `approval.resolved`
- `turn.boundary`
- `status`

`ChatRunSocket` 会把这些事件转换为前端统一事件，并负责 DB 落盘。

审批默认等待 60 秒，超时自动 `deny`。

---

## AgentBridgeClient

`AgentBridgeClient` 是 Node 端本地 socket 客户端。

行为：

- 支持 `ipc://` 和 `tcp://` endpoint。
- 每次请求新建 socket，发送一行 JSON，读取一行 JSON。
- 请求通过内部 lock 串行化。
- 默认请求响应超时为 `120000ms`。
- `streamOutput()` 每 100ms 轮询一次 `get_output`。

示例：

```ts
const started = await bridge.chat(sessionId, input, history, instructions, profile)

for await (const chunk of bridge.streamOutput(started.run_id)) {
  // chunk.delta
  // chunk.events
  // chunk.done
}
```

注意：目前 socket connect 阶段没有独立 connect timeout，主要依赖系统连接错误和请求响应 timeout。

---

## AgentBridgeManager

`AgentBridgeManager` 负责启动和停止 Python bridge。

启动流程：

1. 定位 `hermes_bridge.py`。
2. 发现 `hermes-agent` 根目录。
3. 选择 Python 解释器。
4. 以子进程启动：

```text
python hermes_bridge.py --endpoint <endpoint> --agent-root <root> --hermes-home <home>
```

5. 监听 stdout，等待：

```json
{ "event": "ready", "endpoint": "..." }
```

6. 默认 ready 超时为 `120000ms`。

Python 选择优先级：

1. `HERMES_AGENT_BRIDGE_PYTHON`
2. `agentRoot/venv` 或 `agentRoot/.venv`
3. installed `hermes` 命令 shebang
4. `uv run --project <agentRoot> python`
5. 系统 `python3` / `python`

关闭时先发 `SIGTERM`，1.5 秒后仍未退出则 `SIGKILL`。

---

## 启动与关闭

### 启动

`bootstrap()` 中会先尝试启动 bridge：

```ts
agentBridgeManager = await startAgentBridgeManager()
```

bridge 启动失败不会阻止 Web UI 启动，但 Bridge(beta) 会话后续运行会失败。

随后创建统一的 chat socket：

```ts
chatRunServer = new ChatRunSocket(groupChatServer.getIO(), getGatewayManagerInstance())
chatRunServer.init()
```

### 关闭

服务关闭时会清理：

- `/chat-run` Socket.IO 状态
- Python agent bridge 子进程
- 其他 WebSocket/Socket.IO 服务

---

## 环境变量

| 变量 | 说明 |
|------|------|
| `HERMES_AGENT_BRIDGE_ENDPOINT` | Bridge endpoint；Windows 默认 `tcp://127.0.0.1:18765`，macOS/Linux 默认 `ipc:///tmp/hermes-agent-bridge.sock` |
| `HERMES_AGENT_BRIDGE_TIMEOUT_MS` | Node 等待 bridge 请求响应的超时，默认 `120000` ms |
| `HERMES_AGENT_BRIDGE_STARTUP_TIMEOUT_MS` | Node 等待 Python bridge ready 的超时，默认 `120000` ms |
| `HERMES_AGENT_BRIDGE_PYTHON` | 指定 Python 解释器路径 |
| `HERMES_AGENT_ROOT` | hermes-agent 安装目录 |
| `HERMES_AGENT_BRIDGE_UV` | 指定 uv 可执行文件路径 |
| `HERMES_AGENT_BRIDGE_PLATFORM` | bridge 传给 Hermes Agent 的平台标识，默认 `cli` |
| `HERMES_BRIDGE_PROVIDER` | 覆盖 bridge 使用的 provider |
| `HERMES_BRIDGE_MAX_TURNS` | 覆盖 bridge 最大轮数 |
| `UV` | uv 可执行文件路径 fallback |

Windows 首次启动慢时可以临时放大：

```powershell
$env:HERMES_AGENT_BRIDGE_STARTUP_TIMEOUT_MS = "300000"
$env:HERMES_AGENT_BRIDGE_TIMEOUT_MS = "300000"
```

---

## 当前限制

- Bridge(beta) 仍依赖 Python bridge 成功启动；启动失败时 Web UI 可用，但 bridge 会话不可用。
- bridge socket connect 阶段还没有单独 connect timeout。
- 旧 CLI 独立面板和独立 `/cli-chat-run` namespace 已移除。
- 旧 bridge `command/steer` socket 控制层已移除；CLI/Bridge slash command 现在通过统一 `/chat-run` 的 `run.input` 解析并以 `session.command` 反馈。

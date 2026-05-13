# CLI Chat Sessions 功能设计文档

> 分支：`feat/cli-chat-sessions`

## 概述

本功能为 Hermes Web UI 新增了 **CLI 聊天会话**模式。用户可以在 Web UI 中创建 CLI 类型的会话，通过 Socket.IO 直接与 Hermes Agent 的 Python `AIAgent` 进程交互，绕过原有的 API Server `/v1/responses` 路径。

CLI 会话支持：流式对话、斜杠命令（`/new`、`/reset`、`/undo`、`/retry`、`/branch`、`/compress`、`/save`、`/title` 等）、中断（abort）、转向（steer）、会话恢复（resume）。

---

## 架构

### 整体数据流

```
前端 CliChatPanel
  ↕ Socket.IO (/cli-chat-run)
CliChatRunSocket (Node.js)
  ↕ TCP/Unix Socket (JSON 协议)
hermes_bridge.py (Python 子进程)
  ↕ 直接 import
AIAgent (hermes-agent)
```

### 组件关系

```
┌─────────────────────────────────────────────────────┐
│                    ChatPanel.vue                     │
│  source === 'cli' ? CliChatPanel : MessageList+Input│
└──────────────────┬──────────────────────────────────┘
                   │
         ┌─────────┴──────────┐
         │  CliChatPanel.vue  │
         │  ├─ MessageList    │
         │  └─ ChatInput      │
         └─────────┬──────────┘
                   │ Socket.IO
         ┌─────────┴──────────────┐
         │  CliChatRunSocket      │
         │  (namespace: /cli-chat-run)│
         └─────────┬──────────────┘
                   │ AgentBridgeClient
         ┌─────────┴──────────────┐
         │  hermes_bridge.py       │
         │  (Python 子进程)        │
         │  └─ AgentPool           │
         │     └─ AIAgent instances│
         └────────────────────────┘
```

---

## 新增文件

### 后端

| 文件 | 说明 |
|------|------|
| `packages/server/src/services/hermes/agent-bridge/index.ts` | 模块入口，re-export client 和 manager |
| `packages/server/src/services/hermes/agent-bridge/client.ts` | `AgentBridgeClient` — 通过 TCP/Unix socket 与 Python bridge 通信的 Node.js 客户端 |
| `packages/server/src/services/hermes/agent-bridge/manager.ts` | `AgentBridgeManager` — 管理 Python 子进程的生命周期（启动、就绪检测、关闭） |
| `packages/server/src/services/hermes/agent-bridge/hermes_bridge.py` | Python bridge 服务 — 在进程内直接运行 `AIAgent`，管理会话池，暴露 JSON 协议 |
| `packages/server/src/services/hermes/cli-chat-run-socket.ts` | `CliChatRunSocket` — Socket.IO namespace `/cli-chat-run`，桥接前端与 `AgentBridgeClient` |

### 前端

| 文件 | 说明 |
|------|------|
| `packages/client/src/api/hermes/cli-chat.ts` | 前端 Socket.IO 客户端，提供 `connectCliChatRun`、`startCliRun`、`watchCliSession`、`resumeCliSession` |
| `packages/client/src/components/hermes/chat/CliChatPanel.vue` | CLI 聊天专用面板，管理消息渲染、流式 delta、斜杠命令、中断/转向 |

---

## 修改文件

### 前端组件

**`ChatInput.vue`** — 新增 props 使其可被外部控制：

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sendHandler` | `(text, attachments?) => void \| Promise<void>` | — | 覆盖默认的 `chatStore.sendMessage` |
| `stopHandler` | `() => void` | — | 覆盖默认的 `chatStore.stopStreaming` |
| `streaming` | `boolean` | `chatStore.isStreaming` | 外部注入流式状态 |
| `aborting` | `boolean` | `chatStore.isAborting` | 外部注入中止状态 |
| `allowAttachments` | `boolean` | `true` | 是否允许附件上传 |
| `showTopBar` | `boolean` | `true` | 是否显示顶部工具栏 |

**`MessageList.vue`** — 新增 props：

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `runActive` | `boolean` | `chatStore.isRunActive` | 外部注入运行状态 |
| `abortState` | `{ aborting: boolean; synced?: boolean \| null } \| null` | `chatStore.abortState` | 外部注入中止状态 |

**`ChatPanel.vue`** — 变更：

- 新增 `handleNewCliChat()` 方法和"新建 CLI"按钮（终端图标 `>_`）
- 会话列表头部和空状态均显示"新建 CLI"按钮
- 当 `activeSession.source === 'cli'` 时渲染 `CliChatPanel` 替代 `MessageList + ChatInput`

### Pinia Store

**`chat.ts`** — 变更：

- `createSession(source)` — 新增 `source` 参数（默认 `'api_server'`）
- `newCliChat()` — 创建 `source: 'cli'` 的会话
- `replaceActiveSessionId(nextId)` — 替换当前会话 ID（用于 `/new`、`/reset` 命令后服务端返回新 session_id 的场景）
- `isCliSession(session)` — 判断是否为 CLI 会话
- `loadSessionDetailFromHistory(session)` — 从 Hermes `state.db` 加载 CLI 会话详情
- `uploadFiles` / `buildContentBlocks` — 从私有导出改为公开导出（供 `CliChatPanel` 使用）
- 切换会话时，CLI 会话直接从 DB 加载而非走 Socket.IO resume
- 页面可见性恢复时，CLI 会话走 `refreshActiveSession` 而非 resume

### 后端 Controller

**`sessions.ts`** — 变更：

- `list()` — 合并本地 store（`api_server` 会话）和 Hermes `state.db`（`cli` 会话），按 `last_active` 排序
- `get()` — 先查本地 store，未命中则回退到 Hermes `state.db`
- `listHermesSessions()` — 过滤掉 `cli` 来源（避免重复）

### 服务器启动与关闭

**`index.ts`** — 变更：

- 启动 `AgentBridgeManager`（Python 子进程）
- 创建 `CliChatRunSocket` 并挂载到 Socket.IO

**`shutdown.ts`** — 变更：

- 关闭时依次停止：`agentBridgeManager.stop()` → `cliChatRunServer.close()`

### 构建

**`build-server.mjs`** — 变更：

- 构建后将 `hermes_bridge.py` 复制到 `dist/server/agent-bridge/`

### 国际化

**`en.ts` / `zh.ts`** — 新增：

- `chat.newCliChat`: `"New CLI"` / `"新建 CLI"`

### 其他

**`.gitignore`** — 新增忽略 `__pycache__/` 和 `*.py[cod]`

---

## Python Bridge（hermes_bridge.py）

### 协议

请求/响应均为单行 JSON，通过 socket 以 `\n` 分隔。

**请求格式：**

```json
{ "action": "chat", "session_id": "xxx", "message": "hello" }
```

**响应格式：**

```json
{ "ok": true, "run_id": "xxx", "session_id": "xxx", "status": "running" }
```

### 支持的 action

| Action | 说明 |
|--------|------|
| `ping` | 健康检查 |
| `chat` | 启动一轮对话（异步，返回 `run_id`） |
| `command` | 执行斜杠命令 |
| `get_output` | 获取 run 的增量输出（通过 `cursor` 实现流式） |
| `get_result` | 获取 run 的完整结果 |
| `interrupt` | 中断当前运行 |
| `steer` | 向运行中的 agent 注入提示 |
| `get_history` | 获取会话历史 |
| `destroy` | 销毁会话 |
| `list` | 列出所有活跃会话 |
| `shutdown` | 关闭 bridge 服务 |

### 支持的斜杠命令

| 命令 | 说明 |
|------|------|
| `/new` `/reset` | 重置会话（返回 `new_session_id`） |
| `/clear` | 清空会话 |
| `/undo` | 撤销最后一轮对话 |
| `/retry` | 重试最后一轮对话 |
| `/save` | 保存对话快照到文件 |
| `/title <text>` | 设置会话标题 |
| `/branch` `/fork` | 分支当前会话 |
| `/compress` | 压缩上下文 |
| `/stop` | 停止当前运行 |
| `/steer <prompt>` | 向运行中的 agent 注入提示 |
| `/status` | 查看会话状态 |
| `/history` | 查看对话历史摘要 |
| `/help` | 显示帮助 |

### 会话管理

- `AgentPool` 维护 `session_id → AgentSession` 映射，每个会话持有独立的 `AIAgent` 实例
- 首次访问时通过 `state.db`（`SessionDB`）加载历史消息并注入 agent
- agent 运行在独立线程中，通过 `stream_callback` 收集 delta
- `RunRecord` 跟踪每次运行的状态、delta 列表和事件

---

## AgentBridgeClient（Node.js）

### 通信方式

- 支持 `ipc:///path/to.sock`（Unix domain socket）和 `tcp://host:port` 两种端点
- 每次请求建立新的 socket 连接，发送一行 JSON，读取一行 JSON 响应
- 请求通过 `lock` 串行化，避免并发

### 流式输出

`streamOutput(runId)` 是一个 `AsyncGenerator`，以固定间隔（默认 100ms）轮询 `get_output`，通过 `cursor` 机制获取增量 delta：

```ts
for await (const chunk of client.streamOutput(runId)) {
  // chunk.delta — 增量文本
  // chunk.done  — 是否结束
}
```

---

## AgentBridgeManager（Node.js）

### 职责

1. 发现 `hermes-agent` 安装路径（按优先级搜索多个候选目录）
2. 发现 Python 解释器（venv → shebang → uv → 系统 python）
3. 以子进程方式启动 `hermes_bridge.py`
4. 监听 stdout，等待 `{"event": "ready"}` 信号
5. 15 秒启动超时
6. 关闭时发送 `SIGTERM`，1.5 秒后 `SIGKILL`

### Python 路径发现优先级

1. `HERMES_AGENT_BRIDGE_PYTHON` 环境变量
2. `agentRoot/venv/bin/python3`
3. `hermes` 二进制的 shebang 行
4. `uv run --project <agentRoot> python`
5. 系统 `python3` / `python`

---

## Socket.IO 事件（/cli-chat-run）

### 客户端 → 服务端

| 事件 | 数据 | 说明 |
|------|------|------|
| `resume` | `{ session_id }` | 恢复会话，获取当前状态 |
| `run` | `{ session_id, input }` | 发送消息启动对话 |
| `command` | `{ session_id, command }` | 执行斜杠命令 |
| `abort` | `{ session_id, message? }` | 中断当前运行 |
| `steer` | `{ session_id, text }` | 注入提示 |

### 服务端 → 客户端

| 事件 | 说明 |
|------|------|
| `resumed` | 恢复完成，返回工作状态和已有输出 |
| `run.started` | 对话开始 |
| `message.delta` | 增量文本输出 |
| `run.completed` | 对话完成 |
| `run.failed` | 对话失败 |
| `abort.started` | 开始中断 |
| `abort.completed` | 中断完成（含 `synced` 状态） |
| `steer.completed` | 转向完成 |
| `command.started` | 命令开始执行 |
| `command.completed` | 命令执行完成（含 `new_session_id`、`retry`、`history` 等） |

### 认证

与现有 Socket.IO 认证一致：通过 `socket.handshake.auth.token` 传递 Bearer token，与服务器 token 比对。

---

## 前端 API 层（cli-chat.ts）

### 核心函数

| 函数 | 说明 |
|------|------|
| `connectCliChatRun()` | 建立或复用 Socket.IO 连接 |
| `disconnectCliChatRun()` | 断开连接 |
| `startCliRun(sessionId, input, handlers)` | 发送消息并监听事件，返回 `{ abort, steer, command, cleanup }` |
| `watchCliSession(sessionId, handlers)` | 仅监听事件不发送消息（用于恢复/旁观） |
| `resumeCliSession(sessionId, onResumed)` | 恢复已有会话 |

### 事件处理器（CliRunHandlers）

```ts
interface CliRunHandlers {
  onStarted?: (event: CliRunEvent) => void
  onDelta?: (event: CliRunEvent) => void
  onCompleted?: (event: CliRunEvent) => void
  onFailed?: (event: CliRunEvent) => void
  onAbortStarted?: (event: CliRunEvent) => void
  onAbortCompleted?: (event: CliRunEvent) => void
  onSteerCompleted?: (event: CliRunEvent) => void
  onCommandCompleted?: (event: CliRunEvent) => void
}
```

---

## CliChatPanel.vue 工作流程

### 发送消息

1. 用户输入文本 → `handleSend(text, attachments)`
2. 如有附件，上传文件并构建 `ContentBlock[]`
3. 将用户消息追加到本地 `session.messages`
4. 创建空的 assistant 消息（`isStreaming: true`）
5. 调用 `startCliRun(sessionId, input, handlers)`
6. `onDelta` 追加文本到 assistant 消息
7. `onCompleted` 标记完成，更新标题

### 斜杠命令

1. 用户输入 `/command` 开头的文本
2. 显示 "Running /xxx..." 系统消息
3. 调用 `activeHandle.command(text)`
4. `onCommandCompleted` 处理结果：
   - `new_session_id`：调用 `replaceActiveSessionId`，清空消息（`/new`、`/reset`、`/clear`）
   - `retry` + `retry_input`：自动重新发送上一条用户消息
   - `history`：用 bridge 返回的历史替换本地消息列表
   - `title`：更新会话标题

### 中断与转向

- **中断**：`handleStop()` → `activeHandle.abort()` → `onAbortStarted` / `onAbortCompleted`
- **转向**：`activeHandle.steer(text)` → `onSteerCompleted`

### 会话恢复

- `onMounted` 和 `activeCliSessionId` 变化时调用 `attachToActiveSession()`
- `watchCliSession` + `resumeCliSession` 恢复已有会话状态

---

## 与原有 Chat 系统的对比

| 维度 | API Server Chat（原有） | CLI Chat（新增） |
|------|------------------------|-----------------|
| 后端通道 | SSE (`EventSource`) → `/v1/runs` | Socket.IO → Python bridge → `AIAgent` |
| Agent 运行位置 | Hermes Gateway 进程 | Web UI 服务端子进程内 |
| 会话来源 | `api_server` | `cli` |
| 消息加载 | Socket.IO resume（从 DB） | 直接从 Hermes `state.db` 查询 |
| 附件支持 | 支持 | 支持（上传后构建 ContentBlock） |
| 斜杠命令 | 无 | 支持（`/new`、`/undo`、`/retry` 等） |
| 中断机制 | HTTP abort | `agent.interrupt()` |
| 转向 | 无 | `agent.steer()` |

---

## 环境变量

| 变量 | 说明 |
|------|------|
| `HERMES_AGENT_BRIDGE_ENDPOINT` | Bridge 服务端点（默认 Unix/macOS 为 `ipc:///tmp/hermes-agent-bridge.sock`，Windows 为 `tcp://127.0.0.1:18765`） |
| `HERMES_AGENT_BRIDGE_TIMEOUT_MS` | Bridge 请求响应超时（默认 `120000` ms） |
| `HERMES_AGENT_BRIDGE_STARTUP_TIMEOUT_MS` | Bridge 启动 ready 超时（默认 `120000` ms） |
| `HERMES_AGENT_BRIDGE_PYTHON` | 指定 Python 解释器路径 |
| `HERMES_AGENT_ROOT` | hermes-agent 安装目录 |
| `HERMES_AGENT_BRIDGE_UV` | uv 可执行文件路径 |
| `HERMES_AGENT_BRIDGE_PLATFORM` | Bridge 平台标识（默认 `cli`） |
| `HERMES_AGENT_BRIDGE_TOOLSETS` | 启用的工具集（逗号分隔，`all` 或 `*` 表示全部） |
| `HERMES_BRIDGE_PROVIDER` | 指定推理 provider |
| `HERMES_BRIDGE_MAX_TURNS` | 最大对话轮数 |
| `UV` | uv 可执行文件路径 |

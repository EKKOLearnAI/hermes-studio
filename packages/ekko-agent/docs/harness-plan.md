# Ekko Agent Harness 架构与实施规划

## 状态

本文档是实现规划，不表示当前 Ekko Agent 已经具备完整的 Thread Harness 或 Codex 风格的
测试 Harness。

本文所说的 **Harness** 包含两层，后续实现和讨论必须明确区分：

- **生产 Harness**：位于 Host 与模型循环之间，管理 Thread、Turn、输入操作、流式事件、
  审批、取消、持久化和资源清理。
- **测试 Harness**：启动真实生产 Harness，只替换模型、时钟、认证和远端执行环境等
  非确定边界，并提供编排响应与语义断言的测试 API。

Ekko 的目标不是逐文件移植 Codex，而是采用它最重要的结构性原则：**用公开协议驱动真实
运行时，只在系统边界使用可控替身**。

## 为什么现在需要 Harness

当前 `AgentRuntime.run()` 已能完成模型调用、流式输出、工具循环、记忆、skills 和委派，
但它仍更接近一次函数调用，而不是一个可长期托管的 Agent 会话：

- 调用方通过 `run(input)` 启动工作，通过 `onEvent` 接收同步回调，缺少独立的输入与事件通道。
- `runId` 只能关联一次运行，没有稳定的 `threadId / turnId / submissionId / event sequence`。
- 同一 Runtime 可以被并发调用，没有统一的“每个 Thread 最多一个前台 Turn”状态机。
- steering、审批答复、结构化用户输入、取消和 shutdown 没有统一的操作协议。
- `run()` 返回完整 `messages / steps / events`，长会话会持续放大内存和返回值。
- 会话上下文、对话存储、日志和 Runtime 内部状态还没有形成可恢复的一致提交边界。
- 测试各自实现 `modelClient()`、SSE `fetchMock`、临时目录和事件数组，难以覆盖恢复、取消、
  背压、审批时序及跨 provider 的一致性。

Harness 的职责是把已有的模型—工具循环包进一个稳定的会话内核，而不是重写已有能力。

## Codex 的 Harness 是如何工作的

### 一、生产层：Thread 是双向状态机

Codex Core 对外暴露的关键对象不是一个返回完整结果的 `run()`，而是 `CodexThread`：

```text
Host / app-server
  -> submit(Op)
  -> bounded submission queue
  -> Session submission_loop
  -> Turn input router
  -> SessionTask (regular / review / compact)
  -> model + tool loop
  -> Event { id, msg }
  -> event receiver / app-server notifications
```

`CodexThread` 提供两个方向相互独立的通道：

- Host 通过 `submit(Op)` 提交开始 Turn、steer、interrupt、审批答复、用户输入答复、compact、
  review、shutdown 等操作。
- Host 通过 `next_event()` 持续消费 session、turn、item、模型、工具、审批和错误事件。

这让一次 Agent 运行不再等价于一个 Promise。模型采样期间，Host 仍可以发送审批答复、
追加输入或请求取消；事件也可以在 Turn 最终完成之前持续抵达。

### 二、Thread、Turn、Item 各自有明确身份

Codex app-server 向上层暴露三个主要概念：

- **Thread**：一段可恢复、可 fork 的对话，包含多个 Turn。
- **Turn**：一次从用户输入到完成、中断或失败的 Agent 工作。
- **Item**：Turn 内持久化并可流式观察的消息、reasoning、命令、文件修改等内容。

Core 的 `Event` 还带有提交关联 id；app-server 再把内部事件投影成 `thread/*`、`turn/*`、
`item/*` 通知。调用方不需要读取 Session 私有字段来判断某个 Turn 是否开始或结束。

### 三、所有控制输入都经过同一个串行循环

Session 创建一个有界 submission channel，并由 `submission_loop` 串行处理 `Op`。开始 Turn、
steer、审批回复、动态工具回复、compact 和 shutdown 不会绕过状态机直接修改内部状态。

Turn 输入由专门的路由层判断：

- `start_or_steer`：空闲时新建 Turn，活跃时把输入送入当前 Turn。
- `start_if_idle`：只有空闲时才能启动，否则明确拒绝。
- `steer`：只有兼容的活跃 Turn 才能接收。

一个 Session 同时最多有一个前台 Task。启动新 Task、取消旧 Task、清理资源、写完成事件和
持久化收尾都走统一的生命周期路径，避免不同工作流各自实现半套 teardown。

### 四、Task 把工作流和 Session 生命周期分开

Codex 用 `SessionTask` 表达 regular turn、review、compact 等不同工作流。Session 负责：

- 建立 cancellation token 和 active-turn 状态。
- 启动、替换、终止 Task。
- 统一记录生命周期与 telemetry。
- 在完成事件前刷新 rollout。
- 无论成功、失败、panic 或取消，都执行统一的 `on_task_finished` 清理。

Task 负责自己的业务循环。普通 Task 才进入模型—工具循环，并在收到 pending input 时继续
下一次采样。这种分工避免把 review、compact、恢复和普通对话全部堆进主循环。

### 五、每次模型采样使用一致快照

普通 Turn 在一次模型请求开始时捕获 step snapshot。上下文、可用工具和工具调用依据同一个
请求视图构建，不能在组装请求的中途各自读取不断变化的 Session 状态。

每次采样后再处理：

- pending steer 或 mailbox 输入。
- token 使用和 context-window 状态。
- 需要时在 Turn 中途自动 compact。
- 模型断流、限流和临时错误的有界退避重试。

这保证“模型看见了什么”和“本步允许调用什么”能够被复现和测试。

### 六、工具执行是独立的编排边界

Codex 的工具 Router/Registry 负责找到 handler，Orchestrator 统一处理：

- 参数解析与工具能力检查。
- 是否允许并行执行。
- 审批请求与答复。
- sandbox 选择和降级/重试规则。
- 进程取消、输出收集与结果回传。

工具 handler 不应各自重新实现审批和 sandbox。并行也不是默认开启：只有明确声明支持的工具，
以及满足只读或显式 opt-in 条件的 MCP 调用，才进入并行路径。

### 七、持久化是生命周期的一部分

Codex 使用 rollout/thread store 保存可恢复历史。Thread 可以 start、resume 和 fork；shutdown
会等待 Session 完成收尾。Turn 完成事件与历史刷新有明确顺序，因此“界面显示已完成，但恢复
后缺少最后一步”的窗口被压到统一提交边界内。

生产 sandbox 也属于 Harness，而不是终端工具的可选装饰。Codex 根据平台选择 Seatbelt、
Landlock/bubblewrap 或 Windows 后端；策略无法落实时应 fail closed，而不是静默变成全权限。

## Codex 的测试 Harness 是如何工作的

### 核心原则：真实运行时，模拟边界

`TestCodexHarness` 没有重写一套简化 Session。Builder 会创建真实的：

- `ThreadManager`
- `CodexThread` / `Session`
- submission loop 和 Turn task
- 工具 registry 与执行环境
- rollout、thread store 和 state database

主要替换的是模型服务：真实 Model Client 指向测试 HTTP server，由测试按顺序返回 SSE 或
WebSocket 事件。测试还可以控制认证、时钟、临时 home/workspace 和远端执行环境。

因此，一条集成测试实际走过：

```text
编排模型响应
  -> 通过公开 Thread API 提交用户输入
  -> 真实 Session/Turn/Tool loop
  -> 收集并关联公开 Event
  -> 断言发送给模型的请求
  -> 断言工具副作用和持久化结果
```

这比直接 mock `AgentRuntime` 更有价值，因为状态机、序列化、工具回填、取消和持久化仍然是
生产代码。

### Builder 负责隔离环境

`TestCodexBuilder` 可以配置 model、config、auth、home、workspace、extensions、时钟和执行
环境。默认关闭会引入外部变化的能力，创建独立临时目录，并保留需要断言的真实存储。

测试还可以关闭旧 Thread、在同一 home 和 rollout 上重新构建 Harness，从而验证 resume，
而不是直接把私有内存复制给新对象。

### Response Mock 是语义测试 API

Codex 的响应测试工具不只返回一段字符串。它能：

- 构造 response created、text delta、reasoning、function call、completed 和 error 事件。
- 按顺序挂载多次模型响应，精确检查请求次数，多一次调用也失败。
- 保存收到的所有 `/responses` 请求。
- 提取 function call output 等语义字段。
- 去掉 response id 等传输噪声后再做稳定断言。
- 模拟流式 SSE、分段/延迟 SSE、WebSocket 和断连。

事件等待也不是“找到最后一个 completed 就算结束”。Harness 会用 Turn id 关联
`TurnStarted` 和 `TurnComplete`，防止后台事件或相邻 Turn 造成测试误通过。

### 测试观察公开行为

Codex 集成测试主要断言四类事实：

| 观察面 | 断言内容 |
| --- | --- |
| 输入协议 | 提交是否被接受、拒绝、steer 或取消 |
| 输出协议 | Turn/Item/Tool/Approval 事件的顺序、关联 id 和终态 |
| 模型边界 | 请求体、工具定义、上下文回放、工具结果是否正确 |
| 外部状态 | 文件副作用、执行结果、rollout、restart/resume 后状态 |

私有锁、私有数组和内部函数调用次数不是主要契约。这使重构内部实现时测试仍有价值。

## 对 Ekko 的结论

### 应直接借鉴

- 生产 Harness 和测试 Harness 使用同一套公开 Thread/Turn/Event 协议。
- 一个 Thread 同时只允许一个前台 Turn，由单一操作队列串行决定 start、steer 和 interrupt。
- 所有异步交互都建模成 operation/reply，而不是临时回调或直接改内部状态。
- 事件必须拥有稳定关联字段和单调 sequence，不能只靠 `event.type` 猜归属。
- Turn 生命周期、取消、持久化刷新和 teardown 必须只有一个所有工作流共用的出口。
- 测试运行真实 Runtime，只模拟模型、时钟、审批人和远端环境等边界。
- 模型 mock 必须记录真实请求，并对响应序列和请求次数做严格检查。
- restart/resume、审批等待、取消竞态、断流重试和工具副作用必须成为一等测试场景。

### 不应原样照搬

- Codex Core 当前 submission queue 有界、部分内部 event channel 仍是无界。Ekko 应从第一版
  明确事件缓冲、慢消费者和 delta 丢弃/合并策略，不能允许无界增长。
- 不需要一次实现 Codex 已积累的所有 app-server API。Ekko v1 只覆盖 start/resume、
  start/steer/interrupt、审批/输入答复、事件流和 shutdown。
- 不把 provider 的 OpenAI Responses wire schema 当成 Ekko 测试脚本的内部协议。测试脚本先描述
  Ekko 的规范化 `ModelEvent`，provider contract test 再验证各种 wire format 到它的转换。
- 不让单个 Runtime 文件继续吸收 Thread 管理、持久化、sandbox、transport 和测试辅助代码。
- 不以访问私有状态换取测试便利；确实需要观察的状态应提升为诊断快照或公开事件。

## Ekko 当前能力映射

| Codex 概念 | Ekko 当前实现 | 主要缺口 | 目标 |
| --- | --- | --- | --- |
| `ThreadManager` | `EkkoRuntimeManager.create()` | 只创建 Runtime，不管理稳定 Thread、恢复、fork 或 shutdown | `EkkoThreadManager` |
| `CodexThread` / `SessionIo` | `AgentRuntime` | 输入是直接方法调用，事件是单次 `onEvent` 回调 | 双向 `submit()` + `events()` |
| `Op` | `run()`、interrupt 方法、tool authorizer 回调 | 控制入口分散，无法序列化或跨 transport | 版本化 `EkkoHarnessOp` |
| `Event { id, msg }` | `AgentRuntimeEvent` | 只有 `runId`，没有 thread/turn/submission/seq | 统一事件 envelope |
| Turn input router | 无 | 同 Thread 并发规则不明确，没有 start/steer/reject 状态机 | 单前台 Turn controller |
| `SessionTask` | `AgentRuntime.run()` 内部分支 | regular、compact、review、后台任务生命周期未统一 | `EkkoSessionTask` |
| Tool Orchestrator | registry + 各工具执行逻辑 | 审批、sandbox、并行安全和重试边界仍分散 | 统一 Tool Execution Boundary |
| rollout/thread store | conversation、memory、log 分散保存 | 缺少可恢复的 Turn 提交边界 | journal + checkpoint |
| `TestCodexHarness` | 各测试自建 ModelClient/fetch mock | 没有统一 builder、事件 probe、restart 和故障注入 | `ekko-agent/testing` |
| Responses mock | 手写 SSE frame 和 request body 数组 | 重复且容易漏掉额外请求 | scripted model + request inspector |

现有 `scripts/api-doc-harness.mjs` 是公共 API 文档一致性检查，应保留，但它不是本文所定义的
Agent Test Harness。后续可以把当前 `harness:check` 改名或在 README 中注明其含义，避免名称
继续混用。

## 目标架构

```text
Host adapters (library / CLI / desktop / service)
  -> EkkoThreadManager
      -> EkkoThread
          -> bounded operation queue
          -> SessionLoop
              -> TurnController
                  -> SessionTask
                      -> AgentTurnEngine
                          -> Model Boundary
                          -> Tool Execution Boundary
          -> EventJournal + bounded EventHub
          -> ThreadStore / CheckpointStore

Testing adapter
  -> EkkoTestHarnessBuilder
      -> real EkkoThreadManager + EkkoThread
      -> ScriptedModel / MockModelServer
      -> FakeClock / ApprovalDriver / TestWorkspace
      -> EventProbe / RequestInspector / StateInspector
```

### 目录边界

建议先按下面的边界拆分，不要求第一批 PR 一次创建全部文件：

```text
src/harness/
  protocol.ts
  events.ts
  thread.ts
  thread-manager.ts
  session-loop.ts
  turn-controller.ts
  task.ts
  event-hub.ts
  persistence.ts
  limits.ts
  index.ts

src/runtime/
  turn-engine.ts
  tool-orchestrator.ts
  context-controller.ts

src/testing/
  builder.ts
  harness.ts
  scripted-model.ts
  mock-model-server.ts
  event-probe.ts
  request-inspector.ts
  approval-driver.ts
  workspace.ts
  index.ts
```

`AgentRuntime` 在迁移期保留兼容 API，但内部逐步变成 `AgentTurnEngine` 的 facade。Harness 负责编排
Thread 和 Turn；Turn Engine 只负责给定快照下的模型—工具循环。

### 公开协议

v1 协议从最小集合开始。所有 operation 和 event payload 都必须是 JSON 可序列化值，不能把
`Error`、函数、stream、AbortSignal 或 Runtime 私有对象放到协议里：

```ts
type EkkoHarnessJSONValue =
  | null
  | boolean
  | number
  | string
  | EkkoHarnessJSONValue[]
  | { [key: string]: EkkoHarnessJSONValue }

type EkkoHarnessOp =
  | { type: 'turn.start'; input: EkkoTurnInput; mode?: 'reject-if-busy' | 'steer-if-busy' }
  | { type: 'turn.steer'; turnId: string; input: EkkoTurnInput }
  | { type: 'turn.interrupt'; turnId: string }
  | { type: 'approval.resolve'; requestId: string; decision: EkkoApprovalDecision }
  | { type: 'input.resolve'; requestId: string; value: EkkoHarnessJSONValue }
  | { type: 'thread.compact' }
  | { type: 'thread.shutdown' }

interface EkkoHarnessEvent<
  TType extends string = string,
  TData extends EkkoHarnessJSONValue = EkkoHarnessJSONValue,
> {
  protocol: 'ekko-harness/v1'
  threadId: string
  submissionId: string
  turnId?: string
  sequence: number
  timestamp: string
  type: TType
  data: TData
}

interface EkkoThread {
  readonly id: string
  submit(op: EkkoHarnessOp): Promise<{ submissionId: string }>
  events(options?: { fromSequence?: number; signal?: AbortSignal }): AsyncIterable<EkkoHarnessEvent>
  snapshot(): Promise<EkkoThreadSnapshot>
  shutdown(): Promise<void>
}
```

操作提交成功只表示进入队列，不等于 Turn 已开始或审批已生效；事实状态通过事件确认。需要同步
拒绝的情况，例如协议无效或队列已满，应返回类型化错误。

### 身份与状态规则

- `threadId` 在恢复后保持稳定；fork 生成新 `threadId` 并记录 parent。
- `submissionId` 标识一次 Host 操作，可由 Harness 生成，也允许 Host 提供幂等 key。
- `turnId` 标识一个前台工作流；steer 和 interrupt 必须显式指向它。
- `sequence` 在单个 Thread 内严格递增，恢复后继续递增。
- 一个 Thread 最多一个前台 Turn；不同 Thread 可以并行。
- 后台子任务拥有独立 `taskId`，但必须记录 parent thread/turn，并受每 Thread 和全局并发上限控制。
- Thread 状态至少包括 `idle / running / waiting / shutting_down / closed / failed`。
- Turn 终态至少包括 `completed / failed / interrupted / max_steps`，且只能发出一次终态事件。

### 事件与背压

Ekko 不应简单复制无界事件队列。建议使用两层：

1. `EventJournal` 接收需要恢复或审计的结构化生命周期事件。
2. `EventHub` 向活跃订阅者分发实时事件，使用有界 ring buffer。

事件分为三类：

- **durable**：Turn start/end、完整消息、工具调用/结果摘要、审批、错误、usage、checkpoint。
- **ephemeral**：文本 delta、reasoning delta、终端 stdout delta、进度提示。
- **diagnostic**：上下文估算、重试原因、队列水位和性能指标。

慢消费者策略必须显式：durable 事件不能静默丢失；ephemeral delta 可以合并，并发出
`stream.gap` 提示客户端从 durable item 或 snapshot 重建。单事件和单字段都设置字节上限；工具
输出先裁剪/落盘为 artifact，再进入事件和模型上下文。

### Turn 生命周期

标准 Turn 按以下顺序执行：

```text
accepted
  -> turn.started
  -> capture step snapshot
  -> model request
  -> model events
  -> zero or more tool calls
  -> append tool results
  -> next step or finish
  -> persist durable items + checkpoint
  -> turn.completed / failed / interrupted
  -> release active-turn slot
```

必须覆盖的异常出口包括模型异常、工具异常、approval 超时、Host 断开、Thread shutdown、进程
信号和内部 invariant 失败。所有出口最终进入同一个 finalize，并且 finalize 可幂等重试。

### 持久化边界

第一版不需要复制 Codex rollout 格式，但需要同等语义：

- append-only journal 保存 durable event 或规范化 item。
- checkpoint 保存下一步模型请求所需的最小稳定状态。
- Turn 终态只有在 durable 数据刷新成功后才能对外确认。
- 进程在 tool side effect 后、tool result 持久化前崩溃时，恢复必须标记为
  `recovery_required`，不能无条件重放有副作用的工具。
- ephemeral Thread 可以只存在内存，但仍使用同一状态机和事件协议。
- resume 通过公开 Store 重建，测试不能直接注入旧 Session 私有对象。

### 审批、输入和工具执行

审批和用户输入都改成 request/reply 事件：

```text
tool requested
  -> approval.requested { requestId, risk, summary, expiresAt }
  -> Thread state = waiting
  -> approval.resolve Op
  -> approval.resolved
  -> execute or deny
```

Harness 只负责协议、挂起和恢复；Host 负责展示和收集决定。Tool Orchestrator 必须成为所有有
副作用工具的唯一入口，并统一应用：

- 路径和 symlink 校验。
- sandbox/permission profile。
- 环境变量与 secret 过滤。
- stdout/stderr、结果字节和执行时间限制。
- 审批策略。
- 并行安全声明和取消。

## Ekko 测试 Harness 设计

### 建议 API

```ts
const harness = await new EkkoTestHarnessBuilder()
  .withConfig({ maxSteps: 4 })
  .withModelScript([
    model.toolCall('call_1', 'read_file', { path: 'note.txt' }),
    model.text('done'),
  ])
  .withWorkspace({ 'note.txt': 'hello' })
  .build()

const submission = await harness.startTurn('read note.txt')
const completed = await harness.events.waitForTurnCompleted(submission)

expect(harness.model.requests()).toHaveLength(2)
expect(harness.model.request(1).toolResult('call_1')).toContain('hello')
expect(completed.status).toBe('completed')

await harness.restart()
expect(await harness.thread.snapshot()).toMatchObject({ status: 'idle' })
```

Builder 默认值必须可重复：固定时区/locale，隔离的 home/workspace，假 API key，关闭真实网络，
清空外部 MCP/skills，并在测试结束时自动 shutdown。需要外部能力的测试显式 opt-in。

### 两级模型替身

为了兼顾速度和 provider 兼容性，提供两级替身：

1. **ScriptedModelClient**：直接产生规范化 `ModelEvent`，用于大多数 Harness 集成测试。
2. **MockModelServer**：产生 OpenAI Responses、Chat Completions、Anthropic 或 Gemini 的真实
   HTTP/SSE 帧，用于各 adapter 的 contract test 和少量端到端测试。

两者共享 `ModelScenario` 描述和 `RequestInspector`，场景必须声明预期调用次数。响应序列耗尽、
收到额外请求或测试结束仍有未消费响应时都失败。

第一批场景构造器：

- `text()` / `textDeltas()`
- `reasoning()`
- `toolCall()` / `parallelToolCalls()`
- `usage()` / `completed()`
- `httpError()` / `streamError()` / `disconnect()` / `stall()`

### EventProbe

`EventProbe` 必须按 `threadId + turnId + submissionId` 关联，不提供容易误用的全局
`waitForCompleted()`。建议 API：

- `waitForTurnStarted(submission)`
- `waitForTurnCompleted(turnId)`
- `waitForApproval(turnId)`
- `collectTurn(turnId)`
- `expectSequence(turnId, types)`
- `assertNoEvent(predicate, duration)`

等待都必须有短而明确的默认超时，并在失败消息中输出最近事件、当前 Thread snapshot 和模型
请求摘要，避免测试只报“timed out”。

### 必须建立的测试矩阵

| 类别 | 最小场景 |
| --- | --- |
| 生命周期 | start、busy reject、steer、interrupt、shutdown、重复终态保护 |
| 模型循环 | 普通文本、流式文本、tool loop、多步、max steps、usage |
| 工具 | 成功、失败、超时、取消、输出截断、并行安全、artifact |
| 审批 | allow、deny、超时、迟到回复、错误 requestId、shutdown while waiting |
| 可靠性 | 429/5xx 重试、Retry-After、断流、额外模型调用检测、AbortSignal |
| 上下文 | hard token/byte cap、compaction、工具结果预算、单项 10K token 上限 |
| 持久化 | completed resume、mid-turn crash、fork、corrupt checkpoint、schema upgrade |
| 隔离 | 两 Thread 并行、同 Thread 单前台 Turn、profile/workspace/secret 隔离 |
| Provider contract | Responses、Chat、Anthropic、Gemini 请求与流式归一化 |
| MCP/委派 | server 断开、只读并行、子任务上限、父 Turn 取消、后台任务 shutdown |

## 分阶段实施

### Phase 0：冻结契约与测试基础

目标是在不改变生产行为的前提下，先消除测试替身的重复。

- 新建 `src/testing`，抽取 `ScriptedModelClient`、`ModelScenario`、`RequestInspector`、
  `TestWorkspace` 和通用 SSE frame builder。
- 把 `tests/runtime.test.ts` 与 `tests/model-request.test.ts` 中重复的 model/fetch mock 迁移到
  testkit。
- 为当前 `AgentRuntimeEvent` 增加事件顺序辅助断言，但暂不修改公开事件格式。
- 每个 scripted scenario 严格检查模型调用次数和未消费响应。
- 将测试网络默认封闭，只有显式配置的 mock URL 可访问。

完成标准：现有测试全通过；至少三个 provider contract test 和主要 tool loop 使用公共 testkit；
没有生产 API 变化。

### Phase 1：最小 Thread Harness

- 定义 `ekko-harness/v1` operation、event envelope 和类型化错误。
- 实现 `EkkoThread`、有界 operation queue、`SessionLoop` 和 `EventHub`。
- 实现 `turn.start / turn.steer / turn.interrupt / thread.shutdown`。
- 强制一个 Thread 一个前台 Turn；不同 Thread 可以并行。
- 把当前 `AgentRuntime.run()` 接到 `AgentTurnEngine`，先不改模型和工具行为。
- 保留 `AgentRuntime.run()` 兼容层：它创建 ephemeral Thread、收集终态并返回旧结果结构。

完成标准：Host 可只通过 `submit + events` 完成一个 tool loop；start/steer/interrupt 的竞态有
确定测试；旧 API 与旧测试继续通过。

### Phase 2：事件预算与统一生命周期

- 引入 durable/ephemeral/diagnostic 事件分类和每事件字节限制。
- `events()` 使用有界缓冲，定义慢消费者、delta 合并和 `stream.gap` 行为。
- 把 regular、compact、skill review 和可等待交互变成统一 `SessionTask` 生命周期。
- 所有任务共用 finalize、cleanup 和 exactly-once terminal event 保护。
- 增加全局与每 Thread 后台任务并发限制。
- `run()` 默认不再无界收集完整 delta；旧 `events` 返回字段设总字节上限并记录 truncation。

完成标准：慢订阅者和万级 delta 压测下内存有固定上界；取消、失败、shutdown 均无悬挂 Task。

### Phase 3：Journal、Checkpoint 与恢复

- 定义 Thread/Turn/Item schema version。
- 实现 append-only durable journal 和 checkpoint store。
- 支持 `thread.start / resume / fork`，ephemeral Thread 复用同一代码路径。
- 将 conversation、模型 context 和必要的 runtime state 纳入一致恢复边界。
- 记录不确定 side effect，恢复时禁止自动重复执行。
- Harness 提供 `restart()`，所有恢复测试只使用公开 Store 和 Manager API。

完成标准：正常完成、中断、模型请求中崩溃和工具执行边界崩溃均有恢复测试；Turn 完成事件不会
领先于 durable flush。

### Phase 4：Tool Execution Boundary

- 把审批变成 `approval.requested` 事件与 `approval.resolve` operation。
- 统一文件、terminal、code execution、browser 和 MCP 的执行上下文。
- 引入真实 sandbox runner；策略无法实现时 fail closed。
- 修复 symlink escape，限制环境变量、进程时长、并发和 stdout/stderr。
- 结果超过模型预算时生成 artifact reference 和有界摘要。
- 工具并行必须显式声明安全；有副作用工具默认串行。

完成标准：不存在通过“先写脚本再执行”绕过审批的路径；工具输出、进程和后台任务都有硬上限；
审批等待可取消、可恢复、可测试。

### Phase 5：可靠性与 Host Adapter

- 将模型重试改为只重试可恢复错误，支持指数退避、jitter 和 Retry-After。
- 实现 context hard cap 和 Turn 中途 compaction。
- 提供 library adapter；需要时再增加 stdio/JSON-RPC adapter，不让 transport 进入 Core。
- 增加故障注入、长会话 soak、并发 Thread 和 shutdown 压测。
- 发布 `ekko-agent/testing` 子路径，只导出测试 API，不进入普通生产 bundle。

完成标准：同一套 conformance suite 可以驱动 library 和 transport adapter；长会话、慢消费者、
模型断流和 Host 断开都不会造成无界内存或遗留进程。

## 推荐的 PR 切分

1. `testing: add scripted model and request inspector`
2. `testing: migrate runtime and provider fixtures`
3. `harness: add v1 protocol and event envelope`
4. `harness: add thread session loop and single-turn invariant`
5. `runtime: extract turn engine behind compatibility facade`
6. `harness: add event budgets and lifecycle finalizer`
7. `harness: add journal, checkpoint and restart tests`
8. `tools: centralize approval and execution boundary`
9. `tools: add sandbox and artifact-backed output limits`
10. `harness: add retries, compaction and conformance suite`

每个 PR 都应同时带基于公开 Harness 的集成测试；避免一个 PR 同时修改协议、持久化格式和工具
执行语义。公开协议变化必须更新 `docs/API.md`，并运行当前 API 文档一致性检查。

## 验收指标

Harness 第一阶段不是以“类和文件都创建了”为完成，而是以下行为可以被证明：

- 同一 Thread 永远不会有两个前台 Turn 同时执行。
- 每个 Turn 只有一个终态，所有事件都能用 id 和 sequence 关联。
- 慢消费者、工具大输出和长会话不会导致无界内存增长。
- shutdown 有时间界限，并能报告未完成的 Thread、Task 和进程。
- 进程重启后，已确认完成的 Turn 不丢失，未确认 side effect 不被静默重放。
- 测试能够精确发现多一次模型请求、错误工具回填、错误事件归属和资源泄漏。
- provider adapter 与 Harness Core 可分别测试，协议变化不会要求复制整套用例。
- `AgentRuntime.run()` 在迁移期保持兼容，新的 Host 不再依赖它保存长期会话。

建议 CI 最终分为：

```text
typecheck
  -> unit tests
  -> provider contract tests
  -> harness integration tests
  -> persistence/restart tests
  -> sandbox platform tests
  -> API docs check
```

## 源码依据

本文对 Codex 的判断主要来自以下本地源码，而不是仅依据产品表象：

- [`codex_thread.rs`](../../../../codex/codex-rs/core/src/codex_thread.rs)：公开 Thread conduit。
- [`protocol.rs`](../../../../codex/codex-rs/protocol/src/protocol.rs)：`Op`、`Event` 和 `EventMsg`。
- [`session/mod.rs`](../../../../codex/codex-rs/core/src/session/mod.rs)：Session channel 和启动循环。
- [`session/handlers.rs`](../../../../codex/codex-rs/core/src/session/handlers.rs)：串行 operation dispatch。
- [`session/turn_input.rs`](../../../../codex/codex-rs/core/src/session/turn_input.rs)：start/steer 状态决策。
- [`tasks/mod.rs`](../../../../codex/codex-rs/core/src/tasks/mod.rs)：Task 生命周期与统一清理。
- [`session/turn.rs`](../../../../codex/codex-rs/core/src/session/turn.rs)：模型—工具 Turn 循环。
- [`thread_manager.rs`](../../../../codex/codex-rs/core/src/thread_manager.rs)：start/resume/fork/shutdown。
- [`tools/orchestrator.rs`](../../../../codex/codex-rs/core/src/tools/orchestrator.rs)：审批、sandbox 和执行编排。
- [`test_codex.rs`](../../../../codex/codex-rs/core/tests/common/test_codex.rs)：`TestCodexBuilder` 与
  `TestCodexHarness`。
- [`responses.rs`](../../../../codex/codex-rs/core/tests/common/responses.rs)：模型响应编排和请求断言。
- [`app-server README`](../../../../codex/codex-rs/app-server/README.md)：Thread/Turn/Item 公共协议和生命周期。

## 最终方向

Ekko 不需要变成一个缩小版 Codex。Codex 最值得借鉴的不是 Rust 类型名称，而是边界：Host 只
提交操作和消费事件，Session 只维护状态机，Turn Task 只管理工作流，模型和工具位于可替换
边界，持久化与完成事件共享生命周期，测试则完整穿过这些真实边界。

按照这个方向推进，Ekko 现有模型、工具、记忆、skills 和委派能力都可以保留，但会从“一次
可调用的 Agent Runtime”升级为“可托管、可恢复、可观察、可严格测试的 Agent Harness”。

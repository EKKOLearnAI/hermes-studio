# Cross-Agent Session Handoff（Codex / Claude Code -> Hermes）

> 状态：第一期已实现（当前分支），第二/三期尚未实现。
> 日期：2026-08-15
> 基线：`main @ 1a0b7246`
> 相关 issue：#1317、#1005

## 1. 目标

让用户把 Codex 或 Claude Code 的已有会话接续到一个新的 Hermes 会话，在新的 Hermes 会话中继续原任务，不需要粘贴历史或重新描述上下文。

MVP 只做“Studio 内已运行的 Codex / Claude Code 会话 -> Hermes 新会话”，不承诺跨 Agent 原生 resume。

## 2. 为什么先做 Codex / Claude Code -> Hermes

- Hermes 是本仓库的核心运行路径，接续到 Hermes 可以复用 bridge、压缩、workspace、usage 整条链路。
- Codex / Claude Code 的会话数据已经在 Studio 自己的 SQLite 里，第一期不需要解析外部 JSONL。
- 这个方向是 #1317（统一查看并继续 Claude/Codex CLI 会话）和 #1005（会话 fork 并指定目标）的自然延伸。

## 3. 现有机制

- Studio 有统一 SQLite 会话库：`sessions` + `messages`，已支持 `agent`、`agent_mode`、`agent_session_id`、`agent_native_session_id`、`parent_session_id`、`fork_point_message_id`、`workspace` 等字段。
- 已有同 Agent 原生 resume：`coding-agents.ts` 的 `canResumeNativeSession` 只允许相同 agent/mode/provider/model/apiMode 时继续。
- 已有 `/branch` 和 `createBranchedSession()`，但明确禁止 branch Coding Agent 会话。
- 已有 Hermes CLI 历史导入、session 导出（full/compressed JSON/TXT）。
- 已有 Coding Agent 记忆导出：`nmem threads save --from codex|claude-code`。
- Hermes 普通 Chat 运行时通过 `buildCompressedHistory()` 从本地 SQLite 构建上下文。

## 4. MVP 范围

### 4.1 来源

- `agent = codex` 或 `agent = claude`
- `source = coding_agent`
- 会话已完成或已中止，运行中的会话不允许接续
- 第一期只支持 Studio 内已有会话；外部 CLI JSONL 导入放到第二期

### 4.2 目标

- 新 Hermes 会话：`agent = hermes`、`source = cli`
- 新会话保留来源会话的 `parent_session_id` 和 workspace
- 新会话的 model/provider 使用目标 Hermes profile 的默认配置，不复制来源 Agent 的模型配置
- 来源会话不可被修改

### 4.3 UI 入口

- 在 ChatPanel 和 HistoryView 的会话右键菜单增加“接续到 Hermes”
- 点击后创建新会话并切换到该会话

## 5. 数据流

```text
用户选择 Codex / Claude Code 会话
  -> 服务端校验来源会话和权限
  -> 创建 Hermes handoff 会话（lineage + 规范化消息）
  -> 可选：生成 handoff 上下文摘要
  -> 前端切换到新 Hermes 会话
  -> 用户发送第一条消息
  -> handleBridgeRun() / buildCompressedHistory() 读取上下文
  -> Hermes Agent 执行
```

## 6. 消息转换

Codex / Claude Code 消息不能原样交给 Hermes bridge，需要规范化：

- 保留 `user` 和 `assistant` 文本。
- `command` 消息保留为展示，运行上下文按需降级。
- `tool` / tool calls / reasoning 不作为完整原始消息复制，转换为可读摘要。
- 推荐使用“summary + 最近 N 轮”策略，而不是全量复制工具细节。
- 不复制来源会话的 `agent_native_session_id`，避免 Hermes 误认为自己可以原生 resume 另一个 Agent。

转换后的消息写入新 Hermes 会话的 `messages` 表，作为展示和首次运行的上下文来源。

## 7. 分阶段实施

### 第一期：Studio 会话 -> Hermes

- 新增 `createHandoffSession()`，复用 `createBranchedSession()` 的 lineage 逻辑。
- 新增“接续到 Hermes”API 和前端入口。
- 覆盖 Codex/CC 消息规范化、权限、运行状态校验。
- 补单元测试和必要的浏览器测试。

### 第二期：外部 CLI JSONL 只读导入

- 读取 Claude Code `~/.claude/projects/**/*.jsonl`。
- 读取 Codex `$CODEX_HOME/sessions/**/*.jsonl`。
- 归一化成 Studio session 后走第一期的接续链路。

### 第三期：反向和其他 Agent

- Hermes -> Codex / Claude Code。
- Ekko 等其它 Agent 之间的接续。

## 8. 主要代码触点

| 层 | 文件 | 改动 |
| --- | --- | --- |
| DB | `packages/server/src/db/hermes/session-store.ts` | 新增 `createHandoffSession()` 或扩展 branch 逻辑 |
| 服务 | `packages/server/src/services/hermes/run-chat/session-command.ts` | 复用/抽出 branch 逻辑 |
| 控制器 | `packages/server/src/controllers/hermes/sessions.ts` | 新增 handoff API |
| 运行 | `packages/server/src/services/hermes/run-chat/handle-bridge-run.ts` | 确认新会话上下文可被 `buildCompressedHistory()` 消费 |
| 客户端 API | `packages/client/src/api/hermes/sessions.ts` | 新增接续请求 |
| UI | `ChatPanel.vue` / `HistoryView.vue` | 右键菜单入口 |
| i18n | `packages/client/src/i18n/locales/*` | 新增文案 |

## 9. 测试

- 来源会话不被修改。
- 新会话 lineage、workspace、profile 正确。
- Codex/CC 的 tool/reasoning 消息被正确规范化，Hermes bridge 可接受。
- 运行中的会话不能接续。
- 权限校验：用户只能接续自己有权访问的 profile/session。
- 首次 Hermes 运行时上下文包含来源摘要和最近轮次。

## 10. 待确认决策

- 接续时是全量复制消息，还是“摘要 + 最近 N 轮”。
- 来源与目标 profile/workspace 不一致时如何处理。
- handoff 摘要是否在创建会话时同步生成，还是在首次运行时懒生成。
- 是否允许接续 Group Chat、Workflow 等非普通会话来源。

## 11. Issue 草稿

标题：`[Feature]: Continue a Codex / Claude Code session in a new Hermes session`

正文要点：

- 背景：Codex / Claude Code 与 Hermes 会话割裂，用户切换 Agent 时无法保留上下文。
- 目标：从 Studio 内已有 Codex/CC 会话创建新的 Hermes 会话，并携带任务上下文。
- 范围：只做 Codex/CC -> Hermes，只做 Studio 内已有会话；不做原生跨 Agent resume。
- 验收：
  - 右键菜单出现“接续到 Hermes”。
  - 新会话正确指向来源会话并保留 workspace。
  - 来源会话不被修改。
  - Hermes 首次运行能读到来源摘要和最近轮次。
  - 权限和运行状态校验生效。
  - 单元测试和必要 E2E 通过。
- 关联：#1317、#1005。

## 12. 合并策略

- 第一期做成一个独立小 PR，避免混入 JSONL 导入和反向接续。
- PR 描述关联 #1317 / #1005，说明这是“统一会话历史”能力的一部分。
- 如果维护方更希望先只做“历史导入展示”，则把第一期拆成“handoff 数据层”和“UI 入口”两步。

## 13. 当前实现状态

- 新增 `POST /api/hermes/sessions/:id/handoff`，从 Codex / Claude Code 会话创建 Hermes 接续会话。
- 新增 `createHandoffSession()`，写入 `parent_session_id` 和 `fork_point_message_id`，不修改来源会话。
- 消息转换只保留 `user` / `assistant` 文本，tool 和 command 行暂不复制。
- ChatPanel 与 HistoryView 的会话右键菜单新增“接续到 Hermes”。
- 已补服务层和 DB 层单元测试；`npm run harness:check` 与 `npm run build` 通过。

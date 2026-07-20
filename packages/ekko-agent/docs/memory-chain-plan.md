# Ekko Agent 单一记忆系统

Ekko Agent 只维护一种可操作的长期记忆。记忆按 Hermes profile 隔离，模型和用户不再选择
`session`、`workspace`、`user` 或 `global` scope。会话消息和滚动摘要仍作为内部整理游标，
但不是可查询、可修改的另一类长期记忆。

## 核心目标

- 保存明确、耐久、对未来对话有帮助的信息。
- 用户纠正信息时，快速找到旧记忆并用新版本覆盖。
- 用户要求忘记时，精确删除；范围不清或物理删除时要求确认。
- 避免重复、冲突和过时记忆同时保持 active。
- 记忆失败不能阻断主 Agent 回复。

## 运行链路

```text
Ekko Agent turn
  -> 保存当前会话消息
  -> 按 profile 检索相关 active memory_nodes
  -> 注入最新会话摘要和相关长期记忆
  -> 主模型回答，可直接使用四个 memory tools
  -> 每次回复完成后由专用记忆 Agent 异步整理新增消息
  -> 写入结构化记忆、滚动摘要和审计事件
```

默认每个完成的用户回合都启动整理，由专用模型判断 `create / supersede / delete / noop`。
如果调用方为了成本显式配置了批量阈值，身份、关系、称呼、偏好、工作流、纠正、忘记等
高信号陈述仍会立即绕过阈值。用户无需先说“记住”。

## 单一记忆模型

`memory_nodes` 中每条记忆都属于一个 `profile_id`。`type`、`domain`、`key` 和标签只是检索
字段，不形成不同的权限层级或存储 scope。

```ts
type MemoryNode = {
  id: string
  profileId: string
  parentId?: string
  supersedesId?: string
  domain: string
  categoryPath: string[]
  type: 'preference' | 'fact' | 'decision' | 'task' | 'recipe' | 'skill' | 'constraint' | 'correction'
  key: string              // 服务端生成的规范槽位 key
  revision: number         // 每次修改或 soft delete 递增
  valueJson?: unknown
  title: string
  content: string
  status: 'active' | 'superseded' | 'expired' | 'deleted'
  confidence: number
  importance: number
  tags: string[]
  entities: string[]
  sourceMessageIds: string[]
  createdAt: string
  updatedAt: string
  expiresAt?: string
}
```

## 灵敏的增删改规则

### 保存

- 模型只提交受控 `kind` 和可选 `itemKey`；服务端生成 `domain / type / key`。
- `entities` 由受控结构化值重新生成；`sourceMessageIds` 只由运行时绑定当前用户消息，模型不能伪造来源。
- `interaction_contract` 必须使用结构化 `valueJson`，包含 `userRole / assistantRole / addressUserAs`
  中的至少一项；只写自由文本会被服务端拒绝。
- 服务端在 `(profile_id, key)` 上保证最多一条 active 记忆。
- 同槽位、同内容直接 noop；同槽位、不同内容自动建立新 revision 并 supersede 旧版。
- 可并存的多值偏好使用稳定 `itemKey`，例如 `preference.food.avoid:<ingredient>`。

### 修改与纠正

- 先从系统提示词卡片或 `memory_search / memory_get` 取得 `id + key + revision + value`。
- 修改必须提交 `targetId + expectedRevision`；服务端保留原 canonical key。
- revision 不匹配时拒绝写入，要求重新检索，避免过期 Agent 覆盖新记忆。
- 对象值优先用 `valuePatch / unsetValueFields` 精确修改字段，不重写无关内容。
- 旧节点标记为 `superseded`，新节点通过 `supersedesId` 关联并将 revision 加一。
- 用户明确说旧陈述是玩笑、假设、错误或已取消时，精确 soft delete 旧记忆；
  不保留“这件事是玩笑”一类 active 负面墓碑。

### 删除

- 按 id 删除必须同时提交 `expectedRevision`；精确命中一条时可直接 soft delete。
- 命中多条时必须确认删除范围。
- hard delete 始终需要确认，并同时删除 FTS 和 embedding 数据。
- 所有修改和删除写入 `memory_audit_events`。
- 每条 create / supersede / expire / delete 审计都带触发它的 session id。

### 检索

- `memory_search` 只返回与查询文本、过滤条件或 canonical key 真正匹配的记忆；重要度和置信度不能让零文本命中的记忆混入结果。
- 主 Agent 的自动上下文仍会无条件保留偏好、约束和纠正，其他事实按当前问题相关性注入。

## 独立整理模型

记忆整理只注册以下工具：

- `memory_search`
- `memory_get`
- `memory_propose_update`
- `memory_forget`

它不加载文件、终端、浏览器、MCP、skills 或主 Agent 系统提示词。工具结果不进入整理
transcript；外部获取的短期结果不会进入滚动摘要。模型失败后使用安全的规则
摘要降级，不能影响已经完成的主回复。

整理提示词会同时收到现有记忆卡，每张显式包含 `id / key / revision / value / content`。
它使用三类通用判断：信息是否可能跨 session 保持真实且有用；证据是否来自用户的
明确陈述或确认；新证据与旧记忆冲突时应当替换、局部修改还是删除。当前请求、
未承诺的可能性、已完成工作和外部短期结果只进入 session state。助手陈述、工具输出和
检索内容不作为用户事实，除非用户明确确认。记忆只保留当前有效状态，不保留纠错或撤回历史。

## 数据库

开发环境使用 `packages/ekko-agent/sql-data/ekko-agent.db`，其他环境使用
`HERMES_WEB_UI_HOME/ekko/ekko.db`。服务端 canonical key 与 revision 模型采用 memory schema version 3；升级时直接删除
旧记忆表并重建，不迁移旧 scope 数据。

数据库包含：

- `memory_messages`：会话原始消息和整理来源。
- `memory_summaries`：每个 session 的滚动摘要链。
- `memory_nodes`：唯一的长期记忆集合。
- `memory_audit_events`：保存、覆盖、过期和删除审计。
- `memory_session_state`：增量整理游标。
- `memory_embeddings`：后续语义检索预留。

当前生产入口仍显式关闭 Ekko 长期记忆；正式开启前需要同时处理跨 session 整理队列和
graceful shutdown。

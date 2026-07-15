# Ekko Agent 链式记忆系统规划

本文档规划 Ekko Agent 的长期记忆能力。目标不是把完整聊天历史反复塞进模型上下文，而是把对话沉淀成可追踪、可更新、可检索的结构化记忆。

## 目标

- 支持跨轮、跨会话延续上下文。
- 自动从对话中抽取用户偏好、项目事实、决策、任务和知识条目。
- 用链式结构记录记忆演化，保留来源和覆盖关系。
- 支持领域分类，例如 `生活技能 / 做饭 / 菜谱`。
- 控制 token 成本，只在回复时注入少量相关记忆。
- 后续可接入向量检索或知识图谱，但第一版不强依赖。

## 非目标

- 第一版不做完整知识图谱推理。
- 第一版不要求部署 embedding 模型。
- 第一版不让模型直接修改不可追溯的全局记忆。
- 第一版不把所有历史总结成一个不可审计的大摘要。

## 第一版实现约束

- Ekko Agent 自主管理 SQLite 数据库，不复用 server 的业务数据库。
- 生产数据目录固定在 `HERMES_WEB_UI_HOME/ekko`，默认是 `~/.hermes-web-ui/ekko`；开发环境使用 `packages/ekko-agent/sql-data`，便于通过 Navicat 直接查看。
- 数据库使用通用名称 `ekko.db`，不命名为 `memory.db`，便于后续容纳 Ekko Agent 的其他持久化组件。
- `src/database.ts` 专门管理目录创建、连接、事务和按组件版本迁移；记忆模块通过 `SqliteMemoryStore` 使用数据库。
- 数据库初始化失败时，记忆能力降级关闭，但不能阻断 Agent 正常回复。
- 正常对话完成后始终保存原始消息，但不每轮调用模型；默认累计 8 条新的用户消息后，复用当前会话所选模型运行一次独立的记忆整理。手动整理可绕过阈值，供后续会话结束或空闲触发使用。
- 记忆整理调用只注册四个记忆工具，不注入文件、终端、浏览器、MCP、skills 或主 Agent 系统提示词。
- 记忆整理模型只读取上一份滚动摘要和上次整理后的新增消息；上一份摘要最多 4,000 字符，新增消息最多 12,000 字符，优先保留最新内容。
- 原始工具结果不进入记忆整理模型的 transcript；天气、新闻、榜单和网页抓取等一次性结果在请求完成后不保留到滚动摘要。
- 模型通过记忆工具写入结构化长期记忆，并输出 JSON 格式的滚动会话状态；服务端校验活动目标、过滤时效性指标和未经用户确认的强化表述，再根据结构化字段生成最多 500 字符的摘要。模型请求默认重试 3 次，无效 JSON 额外修复 1 次；全部失败后生成紧凑安全摘要并在审核事件中记录回退原因，不能影响主 Agent 已完成的回复。
- 每次周期性摘要模型响应以 `purpose = ekko-memory-summary` 单独写入会话 usage 表，计入实际模型调用和 token 开销，但不与主回答的 `model.usage` 重复记录。
- 模型直接返回并持久化 `constraints`、`preferences`、`decisions`、`completedWork`、`pendingWork` 和 `knownIssues`；当 `pendingWork` 与 `knownIssues` 都为空时服务端强制清空 `currentGoal`。正则分类只用于模型提取失败时的降级路径。
- 无服务端 ID 的消息按 `session + role + content + metadata + 同内容出现序号` 生成稳定 ID，历史中插入其他消息不会导致整段对话被重复采集。

## 记忆分层

### 1. 原始消息日志

保存完整用户消息、助手消息、工具调用、工具结果和运行元数据。

用途：

- 审计和回放。
- 重新生成摘要。
- 追溯结构化记忆来源。
- 调试模型错误抽取。

### 2. 链式摘要

每隔一段对话生成一个摘要节点。新摘要只依赖上一个摘要和新增消息，避免每次读取完整历史。

示例：

```txt
summary_001 -> summary_002 -> summary_003
```

摘要应包含：

- 当前目标。
- 已完成工作。
- 未完成事项。
- 关键约束。
- 用户偏好。
- 重要决策。
- 已知问题。

### 3. 结构化记忆

结构化记忆保存可以被程序理解和筛选的事实。

推荐类型：

- `preference`: 用户偏好。
- `fact`: 稳定事实。
- `decision`: 决策。
- `task`: 待办或当前任务。
- `recipe`: 菜谱类知识。
- `skill`: 技能步骤或方法。
- `constraint`: 约束。
- `correction`: 用户纠正。

### 4. 可选检索索引

后续可增加：

- keyword/full-text search。
- embedding 向量索引。
- entity/relationship 图索引。

第一版建议先做结构化字段和关键词检索，等数据量变大后再加向量。

## 核心数据模型

### MemoryMessage

```ts
type MemoryMessage = {
  id: string
  sessionId: string
  parentId?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  metadata?: Record<string, unknown>
  createdAt: string
}
```

### MemorySummary

```ts
type MemorySummary = {
  id: string
  sessionId: string
  parentSummaryId?: string
  fromMessageId: string
  toMessageId: string
  summary: string
  currentGoal?: string
  constraints: string[]
  preferences: string[]
  decisions: string[]
  completedWork: string[]
  pendingWork: string[]
  knownIssues: string[]
  createdAt: string
}
```

### MemoryNode

```ts
type MemoryNode = {
  id: string
  parentId?: string
  supersedesId?: string
  sessionId?: string
  workspaceId?: string
  userId?: string
  scope: 'session' | 'workspace' | 'user' | 'global'
  domain: string
  categoryPath: string[]
  type: 'preference' | 'fact' | 'decision' | 'task' | 'recipe' | 'skill' | 'constraint' | 'correction'
  key?: string
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

## 存取设计

记忆系统建议拆成三个物理表或集合：

```txt
memory_messages
memory_summaries
memory_nodes
memory_audit_events
```

后续如果引入向量，再增加：

```txt
memory_embeddings
```

### 怎么存

一次 agent turn 建议分两段存。

第一段是同步写入原始消息，发生在模型调用前后：

```txt
用户消息进入
  -> append MemoryMessage(role = user)
  -> 组装上下文
  -> 调模型
  -> append MemoryMessage(role = assistant)
```

第二段是异步整理记忆，发生在回复完成后：

```txt
读取上一条 MemorySummary
读取本轮新增 MemoryMessage
调用独立的 model memory extractor
  -> 仅提供 memory_search / memory_get / memory_propose_update / memory_forget
  -> 模型按需写入 MemoryNode
  -> 模型返回滚动 summary JSON
每个成功 turn append MemorySummary
失败时回退到 rule-based extractor
```

写入规则：

- 原始消息只追加，不覆盖。
- 摘要只追加，通过 `parentSummaryId` 串成链。
- 结构化记忆默认 upsert，但旧版本不硬删。
- 用户纠正时新建节点，并把旧节点标记为 `superseded`。
- 临时信息写 `expiresAt`，过期后默认不注入上下文。

### 怎么取

回复前取记忆时，不应该读取全部历史。推荐分四路查询后合并：

```txt
1. recentMessages: 当前 session 最近 3-8 条原始消息
2. latestSummary: 当前 session 最新摘要
3. activeNodes: 当前 scope 下高优先级 active 结构化记忆
4. relevantNodes: 根据当前输入做关键词、分类、标签或向量召回
```

查询优先级：

```txt
session scope
> workspace scope
> user scope
> global scope
```

同类记忆冲突时：

```txt
更新的 > 旧的
高置信 > 低置信
临时有效约束 > 长期偏好
用户明确纠正 > 模型推断
```

### Store 接口

第一版可以先定义接口，不绑定具体数据库。

```ts
type MemoryStore = {
  appendMessage(message: MemoryMessage): Promise<void>
  listRecentMessages(input: {
    sessionId: string
    limit: number
  }): Promise<MemoryMessage[]>

  appendSummary(summary: MemorySummary): Promise<void>
  getLatestSummary(input: {
    sessionId: string
  }): Promise<MemorySummary | undefined>

  upsertNode(node: MemoryNode): Promise<void>
  supersedeNode(input: {
    oldNodeId: string
    newNode: MemoryNode
  }): Promise<void>
  deleteNode(input: {
    nodeId: string
    mode: 'soft' | 'hard'
    reason: string
  }): Promise<void>
  listActiveNodes(input: {
    userId?: string
    sessionId?: string
    workspaceId?: string
    domain?: string
    categoryPath?: string[]
    types?: MemoryNode['type'][]
    limit: number
  }): Promise<MemoryNode[]>
  searchNodes(input: {
    query: string
    userId?: string
    sessionId?: string
    workspaceId?: string
    domain?: string
    tags?: string[]
    limit: number
  }): Promise<MemoryNode[]>
}
```

### 精确检索字段

如果要精确回答“用户是不是不吃香菜”这种问题，不能只靠 `title` 和 `content`。需要把可判断的事实写入 `key` 和 `valueJson`。

示例：

```json
{
  "type": "preference",
  "key": "avoid_ingredient",
  "valueJson": "香菜"
}
```

另一个例子：

```json
{
  "type": "preference",
  "key": "flavor_profile",
  "valueJson": {
    "oil": "low",
    "spicy": "low"
  }
}
```

精确检索优先使用：

```txt
scope + domain + categoryPath + type + key + valueJson + status + expiresAt
```

模糊检索才使用：

```txt
title + content + tags + entities + FTS/embedding
```

### Memory Query 接口

`MemoryStore` 面向数据库操作，`MemoryService` 面向 agent 运行时。运行时不应该拼 SQL，而是传入结构化查询。

```ts
type MemoryQuery = {
  userId?: string
  workspaceId?: string
  sessionId?: string
  scopes?: MemoryNode['scope'][]
  domain?: string
  categoryPathPrefix?: string[]
  types?: MemoryNode['type'][]
  key?: string
  valueJson?: unknown
  tags?: string[]
  entities?: string[]
  queryText?: string
  includeExpired?: boolean
  limit?: number
}
```

返回值不是数据库裸结果，而是已经过滤、排序、去冲突后的结果：

```ts
type MemoryQueryResult = {
  exact: MemoryNode[]
  relevant: MemoryNode[]
  omitted: Array<{
    nodeId: string
    reason: 'expired' | 'superseded' | 'low_confidence' | 'conflict_lost' | 'over_limit'
  }>
}
```

## Agent 和 Memory Service 边界

记忆系统不建议设计成一个永远自主运行的 agent。第一版更适合设计成常驻存储和运行时服务：

```txt
AgentRuntime
  -> MemoryService
      -> MemoryStore(SQLite)
      -> MemoryRetriever
      -> MemoryExtractor
      -> MemoryContextBuilder
```

职责边界：

- 主 Agent 负责理解用户请求、推理、调用业务工具、产出回复。
- Memory Service 负责查库、过滤、排序、冲突消解和上下文压缩。
- Memory Extractor 负责在回复后从新增对话中抽取候选记忆。
- Memory Store 负责 SQLite 持久化。

主 Agent 不应该直接：

- 拼 SQL。
- 遍历完整记忆库。
- 判断过期和覆盖关系。
- 自己解决同类记忆冲突。

主 Agent 可以：

- 接收 runtime 自动注入的 `MemoryContext`。
- 在复杂任务里通过 memory tool 请求更多记忆。
- 提出记忆写入建议，但最终由 Memory Service 校验和落库。
- 当用户明确要求记录某件事时，立即调用 memory tool 提交写入请求。

### 默认自动检索

每次调用主模型前，`AgentRuntime` 自动执行一次轻量检索：

```txt
用户消息
  -> buildDefaultMemoryQuery()
  -> MemoryService.retrieve()
  -> buildMemoryContext()
  -> 注入主模型上下文
```

默认检索内容：

- 当前 session 最近消息。
- 当前 session 最新摘要。
- 当前 session active tasks。
- 当前 workspace active constraints / decisions / facts。
- 用户级高优先级 preferences。

这部分不需要主 Agent 主动调用。

### 按需 Memory Tool

复杂场景给主 Agent 暴露工具，但工具背后仍然走 Memory Service。

建议工具：

```ts
memory_search(input: MemoryQuery): Promise<MemoryQueryResult>
```

```ts
memory_get(input: {
  id?: string
  type?: MemoryNode['type']
  key?: string
  valueJson?: unknown
  scope?: MemoryNode['scope']
  domain?: string
}): Promise<MemoryNode | undefined>
```

```ts
memory_propose_update(input: {
  operation: 'create' | 'update' | 'supersede' | 'expire' | 'delete'
  targetId?: string
  node: Partial<MemoryNode>
  reason: string
}): Promise<{
  accepted: boolean
  nodeId?: string
  reason?: string
}>
```

`memory_propose_update` 使用 propose 命名，是为了避免主 Agent 未经校验直接污染长期记忆。Memory Service 需要检查 scope、来源、置信度和冲突关系后再写入。

```ts
memory_forget(input: {
  id?: string
  scope?: MemoryNode['scope']
  domain?: string
  categoryPathPrefix?: string[]
  type?: MemoryNode['type']
  key?: string
  valueJson?: unknown
  mode?: 'soft' | 'hard'
  reason: string
}): Promise<{
  deletedIds: string[]
  mode: 'soft' | 'hard'
  requiresConfirmation?: boolean
  reason?: string
}>
```

### 明确记忆写入

后台 Memory Extractor 适合低频、批量整理；但用户明确要求“记住”“以后都按这个来”“帮我记录一下”时，不应该等到下一次批处理。主 Agent 应该立即调用 `memory_propose_update`，由 Memory Service 校验后同步或准同步写入。

明确写入示例：

```txt
用户：记住，我以后做饭不要香菜。
```

主 Agent 不直接写数据库，而是调用：

```ts
memory_propose_update({
  operation: 'create',
  node: {
    scope: 'user',
    domain: '生活技能',
    categoryPath: ['生活技能', '做饭', '饮食偏好'],
    type: 'preference',
    key: 'avoid_ingredient',
    valueJson: '香菜',
    title: '用户不吃香菜',
    content: '用户明确要求以后做饭推荐不要香菜。',
    status: 'active',
    confidence: 0.99,
    importance: 0.95,
    tags: ['忌口', '菜谱推荐'],
    entities: ['香菜'],
  },
  reason: '用户明确要求记录长期饮食偏好',
})
```

Memory Service 接收到请求后需要：

- 校验 `scope` 是否允许写入。
- 绑定 `sourceMessageIds`，保证可追溯。
- 检查是否已有同类 active 记忆。
- 如果冲突，执行 `supersede` 或要求更明确的用户确认。
- 写入 SQLite 事务。
- 返回是否 accepted。

写入成功后，主 Agent 可以自然确认：

```txt
记住了，以后推荐做饭相关内容时会避开香菜。
```

不建议立即写入的情况：

- 用户只是临时描述状态，例如“今天有点胃不舒服”。
- 模型自己推断出来的偏好，用户没有明确表达。
- 敏感信息或可能涉及隐私的信息。
- scope 不明确且可能影响长期行为的记忆。

这类内容可以进入后台抽取流程，或者先作为 session-scope 临时记忆。

### 删除和遗忘

记忆系统必须支持删除。用户说“忘掉这个”“不要再记这个”“删除我的做饭偏好”时，主 Agent 应调用 `memory_forget`，由 Memory Service 执行删除策略。

删除分两种：

```txt
soft delete: 把 memory_nodes.status 改成 deleted，默认不再检索和注入，但保留审计记录。
hard delete: 从 SQLite 中物理删除节点，并清理 FTS/embedding 索引。
```

第一版默认使用 soft delete。hard delete 适合用户明确要求清除隐私数据，或者执行数据合规删除。

示例：

```txt
用户：忘掉我不吃香菜这件事。
```

主 Agent 调用：

```ts
memory_forget({
  scope: 'user',
  domain: '生活技能',
  categoryPathPrefix: ['生活技能', '做饭', '饮食偏好'],
  type: 'preference',
  key: 'avoid_ingredient',
  valueJson: '香菜',
  mode: 'soft',
  reason: '用户明确要求忘记该饮食偏好',
})
```

Memory Service 需要：

- 先精确查找候选节点。
- 如果命中多条，返回 `requiresConfirmation = true`，让主 Agent 向用户确认范围。
- soft delete 时设置 `status = deleted`，更新 `updatedAt`。
- hard delete 时删除节点、FTS 记录、embedding 记录。
- 记录删除原因和操作者，方便审计。

删除范围建议：

```txt
删除单条记忆：按 id 删除。
删除某类记忆：按 scope + domain + categoryPath + type 删除。
删除某个 workspace 记忆：按 workspaceId 删除。
删除某个用户长期记忆：按 userId + scope=user 删除。
删除来源消息关联记忆：按 sourceMessageIds 删除。
```

注意：删除结构化记忆不一定等于删除原始消息日志。用户如果要求“彻底删除相关对话”，需要同时清理 `memory_messages`、`memory_summaries` 中的相关内容，或者重新生成受影响摘要。

### 冲突消解

Memory Service 在返回记忆前做冲突消解。

排序规则：

```txt
session > workspace > user > global
未过期 > 已过期
用户明确表达 > 模型推断
临时有效约束 > 长期偏好
更新的 > 旧的
高置信 > 低置信
高重要性 > 低重要性
```

示例：

```txt
长期偏好：用户喜欢川菜。
临时约束：用户今天胃不舒服，少辣。
```

当天推荐晚餐时，Memory Service 应返回“少辣”作为更高优先级约束，同时可以保留“喜欢川菜”作为低优先级偏好。

### 写入示例

用户说：

```txt
以后做饭别给我推荐香菜，我喜欢少油少辣。
```

同步写入：

```json
{
  "role": "user",
  "content": "以后做饭别给我推荐香菜，我喜欢少油少辣。"
}
```

异步抽取后写入两个节点：

```json
{
  "scope": "user",
  "domain": "生活技能",
  "categoryPath": ["生活技能", "做饭", "饮食偏好"],
  "type": "preference",
  "title": "用户不吃香菜",
  "content": "推荐菜谱时避免香菜。",
  "status": "active",
  "confidence": 0.98,
  "importance": 0.9,
  "tags": ["忌口", "菜谱推荐"],
  "entities": ["香菜"]
}
```

```json
{
  "scope": "user",
  "domain": "生活技能",
  "categoryPath": ["生活技能", "做饭", "饮食偏好"],
  "type": "preference",
  "title": "用户偏好少油少辣",
  "content": "推荐菜谱时优先少油少辣。",
  "status": "active",
  "confidence": 0.95,
  "importance": 0.85,
  "tags": ["口味", "菜谱推荐"],
  "entities": ["少油", "少辣"]
}
```

### 读取示例

用户下一次问：

```txt
今晚吃什么？
```

检索条件：

```txt
domain = 生活技能
categoryPath startsWith 生活技能/做饭
types = preference, constraint, recipe
status = active
```

组装给模型的上下文片段：

```txt
用户做饭偏好：
- 推荐菜谱时避免香菜。
- 推荐菜谱时优先少油少辣。
```

模型最终推荐时就不需要知道完整历史，只需要这两条结构化记忆。

### 更新示例

用户后来补充：

```txt
香菜现在可以接受一点，但不要太多。
```

处理方式：

```txt
旧节点：用户不吃香菜 -> status = superseded
新节点：用户可接受少量香菜 -> status = active, supersedesId = oldNodeId
```

这样系统不会丢掉历史，也不会继续按旧偏好推荐。

## SQLite 落地方案

第一版推荐使用 SQLite。它比 JSONL 更适合做查询、索引、事务和状态更新，同时不需要引入服务端数据库。

### 文件位置

第一版统一存放在 Web UI 状态目录：

```txt
packages/ekko-agent/sql-data/ekko-agent.db  # development
HERMES_WEB_UI_HOME/ekko/ekko.db             # production
```

没有配置状态目录时，默认路径是：

```txt
~/.hermes-web-ui/ekko/ekko.db
```

scope 通过表字段隔离，不按 workspace 或 user 拆分数据库文件。开发环境的
`ekko-agent.db` 与生产环境的 `ekko.db` 都是 Ekko Agent 的通用数据库，
由 `src/database.ts` 统一管理连接、事务和组件迁移。

### 表结构

SQLite 不需要把所有数组拆成多张表。第一版可以把数组字段存成 JSON text，常用筛选字段单独建列。

```sql
create table if not exists memory_messages (
  id text primary key,
  session_id text not null,
  parent_id text,
  role text not null,
  content text not null,
  metadata_json text,
  created_at text not null
);

create table if not exists memory_summaries (
  id text primary key,
  session_id text not null,
  parent_summary_id text,
  from_message_id text not null,
  to_message_id text not null,
  summary text not null,
  current_goal text,
  constraints_json text not null default '[]',
  preferences_json text not null default '[]',
  decisions_json text not null default '[]',
  completed_work_json text not null default '[]',
  pending_work_json text not null default '[]',
  known_issues_json text not null default '[]',
  created_at text not null
);

create table if not exists memory_nodes (
  id text primary key,
  parent_id text,
  supersedes_id text,
  session_id text,
  workspace_id text,
  user_id text,
  scope text not null,
  domain text not null,
  category_path_json text not null,
  category_path_text text not null,
  type text not null,
  key text,
  value_json text,
  title text not null,
  content text not null,
  status text not null,
  confidence real not null,
  importance real not null,
  tags_json text not null default '[]',
  entities_json text not null default '[]',
  source_message_ids_json text not null default '[]',
  created_at text not null,
  updated_at text not null,
  expires_at text
);

create table if not exists memory_audit_events (
  id text primary key,
  event_type text not null,
  node_id text,
  session_id text,
  workspace_id text,
  user_id text,
  actor text not null,
  reason text not null,
  payload_json text,
  created_at text not null
);
```

`category_path_text` 用 `/` 拼接，方便做前缀查询：

```txt
生活技能/做饭/饮食偏好
```

### 索引

```sql
create index if not exists idx_memory_messages_session_created
  on memory_messages (session_id, created_at);

create index if not exists idx_memory_summaries_session_created
  on memory_summaries (session_id, created_at);

create index if not exists idx_memory_nodes_lookup
  on memory_nodes (scope, status, domain, type, importance, updated_at);

create index if not exists idx_memory_nodes_key
  on memory_nodes (scope, status, domain, type, key, updated_at);

create index if not exists idx_memory_nodes_category
  on memory_nodes (category_path_text);

create index if not exists idx_memory_nodes_session
  on memory_nodes (session_id, status, updated_at);

create index if not exists idx_memory_nodes_workspace
  on memory_nodes (workspace_id, status, updated_at);

create index if not exists idx_memory_nodes_user
  on memory_nodes (user_id, status, updated_at);

create index if not exists idx_memory_audit_events_node
  on memory_audit_events (node_id, created_at);
```

可选增加 FTS5，用于关键词检索：

```sql
create virtual table if not exists memory_nodes_fts using fts5(
  title,
  content,
  tags,
  entities,
  content='memory_nodes',
  content_rowid='rowid'
);
```

如果使用 FTS，需要在 upsert memory node 时同步维护 FTS 表，或使用 trigger。

### 典型查询

取最近消息：

```sql
select *
from memory_messages
where session_id = ?
order by created_at desc
limit ?;
```

取最新摘要：

```sql
select *
from memory_summaries
where session_id = ?
order by created_at desc
limit 1;
```

取做饭相关 active 记忆：

```sql
select *
from memory_nodes
where status = 'active'
  and domain = '生活技能'
  and category_path_text like '生活技能/做饭/%'
  and (expires_at is null or expires_at > ?)
order by importance desc, confidence desc, updated_at desc
limit ?;
```

取当前 workspace 的约束和决策：

```sql
select *
from memory_nodes
where status = 'active'
  and workspace_id = ?
  and type in ('constraint', 'decision', 'fact')
  and (expires_at is null or expires_at > ?)
order by importance desc, updated_at desc
limit ?;
```

### 事务写入

一次记忆整理应该放在事务里：

```txt
begin
  insert summary if needed
  insert new nodes
  update superseded old nodes
  update fts index if enabled
commit
```

这样可以避免出现“新记忆写入了，但旧记忆没失效”的半完成状态。

每次 create、update、supersede、expire、delete 都应该追加一条 `memory_audit_events`。审计事件不参与模型上下文注入，只用于调试、用户解释和回滚。

### 迁移

建议维护一个简单版本表：

```sql
create table if not exists memory_schema_migrations (
  version integer primary key,
  applied_at text not null
);
```

Ekko Agent 启动 memory store 时：

```txt
打开 SQLite
读取 migration version
按顺序执行缺失 migration
创建索引
返回 SqliteMemoryStore
```

## 受控 Schema

精确检索依赖稳定 schema。不能让模型自由发明 `key`，否则同一个意思可能被写成 `avoid_food`、`avoid_ingredient`、`excluded_ingredient`，后续 SQL 很难稳定命中。

建议按 domain 维护受控 schema：

```ts
type MemorySchemaRule = {
  domain: string
  categoryPathPrefix?: string[]
  type: MemoryNode['type']
  allowedKeys: string[]
  valueShape: 'string' | 'number' | 'boolean' | 'string[]' | 'object'
  defaultScope: MemoryNode['scope']
  requiresExplicitUserIntent: boolean
}
```

做饭偏好示例：

```ts
const cookingPreferenceSchema = {
  domain: '生活技能',
  categoryPathPrefix: ['生活技能', '做饭'],
  type: 'preference',
  allowedKeys: [
    'avoid_ingredient',
    'preferred_ingredient',
    'flavor_profile',
    'dietary_restriction',
    'cooking_time_preference',
  ],
  valueShape: 'object',
  defaultScope: 'user',
  requiresExplicitUserIntent: true,
}
```

Memory Service 在写入前需要做 normalization：

```txt
同义 key 归一：disliked_ingredient -> avoid_ingredient
中文值归一：少辣 -> { spicy: 'low' }
scope 归一：项目技术约束默认 workspace，不默认 user
status 归一：没有 expiresAt 的临时状态不能进入长期 user-scope
```

模型抽取结果如果不符合受控 schema，应被拒绝或降级为 session-scope 临时记忆。

## 权限和确认策略

不同 scope 的写入风险不同：

```txt
session: 默认允许，适合临时状态和当前任务。
workspace: 允许明确项目事实、技术约束、任务状态。
user: 只允许用户明确表达的长期偏好和稳定事实。
global: 第一版不允许 agent 写入。
```

需要确认的情况：

- 写入 user-scope 长期记忆，但用户没有使用“记住”“以后都”等明确表达。
- 删除命中多条记忆。
- hard delete。
- 写入或删除敏感信息。
- 覆盖高置信历史记忆，但新消息表达不够明确。

不需要确认的情况：

- session-scope 临时记忆。
- 用户明确要求记录的低风险偏好。
- workspace-scope 的当前任务状态。
- soft delete 单条精确命中的记忆。

## 失败和降级

记忆系统不能阻塞主对话。

失败处理：

```txt
SQLite 打不开：跳过记忆检索，主 Agent 正常回答，并记录 runtime warning。
检索失败：只使用最近消息和当前输入。
抽取失败：不重试阻塞当前回复，放入后台 retry queue。
写入失败：告诉主 Agent 写入未成功，不要回复“记住了”。
迁移失败：禁用 memory store，避免写入未知 schema。
```

`MemoryContext` 应包含诊断字段：

```ts
type MemoryContextDiagnostics = {
  enabled: boolean
  storeStatus: 'ok' | 'disabled' | 'degraded'
  warnings: string[]
  retrievedNodeCount: number
  omittedNodeCount: number
}
```

## 可观测性和解释

每次回复最好保留本轮使用过的记忆 id，但不一定展示给用户。

```ts
type MemoryContext = {
  latestSummary?: MemorySummary
  recentMessages: MemoryMessage[]
  activeTasks: MemoryNode[]
  relevantNodes: MemoryNode[]
  constraints: MemoryNode[]
  preferences: MemoryNode[]
  usedMemoryIds: string[]
  diagnostics: MemoryContextDiagnostics
}
```

当用户问“你为什么这么推荐”时，主 Agent 可以基于 `usedMemoryIds` 解释：

```txt
因为我记录到你做饭偏好少油少辣，并且不希望推荐香菜。
```

解释时不要暴露内部 SQL、embedding 分数或无关历史消息。

## 测试验收

第一版至少覆盖这些测试：

- append message 后可以按 session 取最近消息。
- append summary 后可以取最新摘要。
- create node 后 active 查询能命中。
- `key/valueJson` 精确查询能命中做饭偏好。
- supersede 后旧节点不再进入默认上下文。
- expiresAt 过期后不再注入。
- soft delete 后不再检索。
- hard delete 后节点、FTS、embedding 记录被清理。
- 命中多条删除候选时返回 `requiresConfirmation`。
- SQLite 事务失败时不会出现半写入状态。
- memory store 失败时主 Agent 能降级继续运行。
- schema normalization 能把同义 key 归一到受控 key。

## 分类体系

分类树用于归档，记忆节点用于表达事实和演化。不要把目录树当成全部记忆。

示例：

```txt
生活技能
  做饭
    菜谱
    食材处理
    厨房工具
    烹饪技巧
    营养搭配
    采购清单
    饮食偏好
  家务
  理财
  健康
  出行
```

一条记忆可以挂在一个主分类下，同时用 tags 和 entities 表达交叉关系。

示例：

```json
{
  "domain": "生活技能",
  "categoryPath": ["生活技能", "做饭", "饮食偏好"],
  "type": "preference",
  "title": "用户不吃香菜",
  "content": "用户明确表示以后不要推荐带香菜的菜。",
  "tags": ["做饭", "菜谱推荐", "忌口"],
  "entities": ["香菜"],
  "confidence": 0.98
}
```

菜谱示例：

```json
{
  "domain": "生活技能",
  "categoryPath": ["生活技能", "做饭", "菜谱"],
  "type": "recipe",
  "title": "番茄炒蛋",
  "content": "家常快手菜，主要食材是番茄和鸡蛋。可按用户偏好少油、不放香菜。",
  "tags": ["家常菜", "快手菜", "少辣"],
  "entities": ["番茄", "鸡蛋"]
}
```

## 抽取流程

在 agent 回复后异步执行记忆整理。

触发条件：

- 新增 6-10 条消息。
- 新增上下文超过指定 token 阈值。
- 用户表达明确偏好、决策、纠正或长期目标。
- 任务状态发生变化。

流程：

```txt
新增消息
  -> 保存原始日志
  -> 读取上一条摘要
  -> 抽取结构化候选记忆
  -> 判断新增、更新、覆盖或过期
  -> 写入 MemoryNode
  -> 必要时生成 MemorySummary
```

抽取器输出建议：

```ts
type MemoryExtraction = {
  summaryPatch?: string
  nodes: Array<{
    operation: 'create' | 'update' | 'supersede' | 'expire' | 'ignore'
    targetId?: string
    node: Partial<MemoryNode>
    reason: string
  }>
}
```

## 覆盖和冲突

用户纠正优先级高于历史记忆。

示例：

```txt
旧记忆：用户喜欢吃辣。
新消息：最近胃不舒服，先别推荐辣的。
```

处理方式：

- 不一定删除旧记忆。
- 新建一条临时偏好，`status = active`。
- 旧记忆仍保留，但检索注入时被新记忆压过。
- 如果用户明确说“以后都不吃辣”，再 supersede 旧记忆。

## 回复前上下文组装

每次模型回复前只注入最小必要记忆。

优先级：

```txt
当前用户消息
> 最近几轮原始消息
> 当前任务状态
> 最新摘要
> 高置信结构化记忆
> 相关历史记忆
> 低置信或过期记忆
```

上下文包：

```ts
type MemoryContext = {
  latestSummary?: MemorySummary
  recentMessages: MemoryMessage[]
  activeTasks: MemoryNode[]
  relevantNodes: MemoryNode[]
  constraints: MemoryNode[]
  preferences: MemoryNode[]
}
```

建议限制：

- 最新摘要：1 条。
- 最近消息：3-8 条。
- 结构化记忆：最多 10-20 条。
- 单条记忆内容保持短文本。

## Token 成本策略

- 不每轮抽取，按阈值批处理。
- 抽取只看上一条摘要和新增消息。
- 记忆抽取可使用便宜模型或本地小模型。
- 回复时只注入相关记忆，不注入完整记忆库。
- 已完成任务和临时日志降低重要性或设置过期时间。

## 第一版落地建议

### Phase 1: 本地结构化记忆

- 增加 memory 模块。
- 保存 messages、summaries、nodes。
- 支持基础分类、状态、来源追踪。
- 实现基于规则和模型 JSON 输出的抽取接口。
- 回复前注入最近摘要和 active nodes。

### Phase 2: 检索和覆盖

- 增加关键词搜索。
- 增加 `supersedesId` 和冲突处理。
- 增加 task/preference/decision 的专用 upsert 逻辑。
- 增加记忆重要性和过期机制。

### Phase 3: 向量和图关系

- 对 MemoryNode 生成 embedding。
- 增加 topK 语义召回。
- 抽取 entities 和 relationships。
- 支持 temporal graph 查询。

## 与 Ekko Agent 当前模块的关系

建议新增目录：

```txt
packages/ekko-agent/src/memory/
  context.ts
  extraction.ts
  store.ts
  types.ts
  retrieval.ts
```

职责：

- `types.ts`: 记忆数据结构。
- `store.ts`: 存储接口和 SQLite 实现。
- `extraction.ts`: 从消息中抽取结构化记忆。
- `retrieval.ts`: 根据当前输入检索相关记忆。
- `context.ts`: 组装给模型的 MemoryContext。

`AgentRuntime` 后续可以在两个位置接入：

- 回复前：调用 retrieval/context，把记忆注入系统提示或上下文消息。
- 回复后：调用 extraction/store，异步更新记忆。

## 开放问题

- 哪些记忆需要用户可见和可编辑。
- 除明确用户意图外，是否允许模型抽取器自动写入更多 user-scope 长期记忆。
- 记忆抽取使用哪个模型和预算。
- 是否需要多租户隔离和加密。

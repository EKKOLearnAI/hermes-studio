# Think 块与正文分离、可折叠展示 — 设计稿

- **Issue**: 上游 #164 —【Feature】think 块与正文区分开
- **日期**: 2026-04-23
- **分支**: `feat/thinking-block-collapse`
- **状态**: 设计稿（含 rubber-duck 审查反馈修订）

---

## 1. 背景

当前 assistant 回复中，思考链（reasoning/think）内容直接以 `<think>...</think>` 等原始标签形式嵌在 `Message.content` 里，由 `MarkdownRenderer` 原样渲染。用户反馈：

1. think 块与正文混在一起，大段文本难以快速定位正文；
2. 正文输出完成后，think 内容无法单独收起/查看；
3. 已存在的 `settings.display.show_reasoning` 开关目前未真正影响渲染。

## 2. 目标

- assistant 消息中，**识别并分离** think 块与正文；
- think 块以**可折叠 header** 形式展示，复用项目已有的 `tool-line` 折叠样式；
- 折叠 header 显示**字数摘要**，正在流式观察到的消息额外显示**观察到的耗时**；
- 默认展开/收起由 `settings.display.show_reasoning` 控制，每条消息可独立覆盖（运行时 transient 状态）；
- 流式中未闭合标签**容错解析**；流结束时仍未闭合则**降级保留为正文**；
- 代码块/内联 code 中出现的伪 `<think>` 标签**不识别**；
- 不改动上游 SSE 协议、不修改 `Message.content`、不破坏 localStorage 旧数据。

## 3. 非目标

- 不修改后端 gateway 协议，不新增 SSE 事件类型；
- 不持久化 thinking 耗时摘要 — 历史/刷新后恢复的消息仅显示字数；
- 不持久化每条消息的手动折叠状态 — transient，刷新后回默认；
- 不支持同名嵌套标签（`<think><think>...</think>...</think>` 内层按纯文本处理）。

## 4. 识别规则

### 4.1 标签范围

正则匹配以下三类标签（大小写不敏感）：

```
<think>...</think>
<thinking>...</thinking>
<reasoning>...</reasoning>
```

> 选择理由：覆盖 DeepSeek R1、GLM reasoner、通义 Qwen reasoning、Claude thinking 等主流推理模型。

### 4.2 代码块保护（首版必做）

解析前先将 markdown 代码块内容替换为占位符，避免误识别：

1. **Fenced code block**：匹配 `` ```lang\n...\n``` ``（含 `~~~` 变体）；
2. **Inline code**：匹配 `` `...` ``（单反引号，非转义）；

替换为 `\u0000CODE_N\u0000` 占位符 → 对剩余文本执行 4.3 → 解析完成后把占位符原位还原回 `body` 与 `segments`（segments 内本不应出现 code，但为简单起见统一还原，不影响结果）。

### 4.3 解析算法

对剥离代码块后的一条 assistant `content`：

1. 非贪婪匹配所有 `<(think|thinking|reasoning)>[\s\S]*?</\1>`（大小写不敏感）；
2. 同名嵌套**不支持**：内层同名开始标签被外层 `</>` 先闭合吞掉；解析器不处理 dangling 内层 `</tag>`，会作为正文残留（罕见场景可接受）；
3. 若还残留一个**未闭合**的 `<think|thinking|reasoning>`：
   - **流式中**（调用方传 `streaming=true`）→ 从该标签起到末尾视为 `pending` thinking；
   - **非流式**（`streaming=false`）→ **降级**：视为正文保留（含标签字符原样），`pending=null`；
4. 其余纯文本按顺序拼接为 `body`；
5. 还原所有代码块占位符。

### 4.4 TypeScript 签名

文件位置：**`packages/client/src/utils/thinking-parser.ts`**（中性 utils 目录，避免 store → components 反向依赖）

```ts
export interface ParsedThinking {
  /** 所有已闭合 thinking 片段纯文本（不含标签） */
  segments: string[]
  /** 流式中未闭合的 thinking；非流式时始终为 null */
  pending: string | null
  /** 正文（已剔除 thinking） */
  body: string
  /** 是否存在任何 thinking 内容（segments 非空 或 pending 非空） */
  hasThinking: boolean
}

export function parseThinking(content: string, opts: { streaming: boolean }): ParsedThinking

/** 检测 content 从 prev 变到 next 期间，是否跨越了"首次出现开始/结束标签"的边界 */
export function detectThinkingBoundary(prev: string, next: string): {
  startedAtBoundary: boolean
  endedAtBoundary: boolean
}
```

## 5. 数据模型

### 5.1 `Message.content` 保持不变

原始字符串原样存储 & 持久化。localStorage / sessions export 向前兼容。

### 5.2 不新增持久化字段

**采纳 rubber-duck #4 审查反馈**：不在 `Message` 接口上新增 `thinkingStartedAt/EndedAt` 字段。理由：

- `mapHermesMessages()` 只映射服务端已知字段，新字段会被刷新/重连覆盖丢失；
- `switchSession` / `startPolling` / `refreshActiveSession` 会用 server 数据覆盖本地消息；
- thinking 耗时的语义本就是"前端观察到的 wall-clock 时间"，非模型真实思考时间，持久化反而误导。

### 5.3 运行时观察态（store 内 Map）

在 `stores/hermes/chat.ts` 新增：

```ts
/** Map<messageId, { startedAt, endedAt }>，仅记录本次会话流式期间观察到的时间戳 */
const thinkingObservation = reactive(new Map<string, { startedAt?: number; endedAt?: number }>())
```

- 在 `message.delta` 事件处理中调用 `detectThinkingBoundary(prev, next)`，首次 started 写入 `startedAt`，首次 ended 写入 `endedAt`；
- `run.completed` / `run.failed` 后不清除该 entry（以便流式结束后仍能展示"本次会话的观察耗时"，直到用户刷新或切换会话）；
- `switchSession` 时清空 Map（跨会话不保留）；
- 历史消息、刷新后恢复的消息、polling 拉取的消息均**无** entry，不显示耗时，仅显示字数。

## 6. UI 设计

### 6.1 位置

assistant 气泡**内部顶部**，`MarkdownRenderer`（渲染 body）**之前**，独立渲染一个 thinking 折叠区。只有 `parsedThinking.hasThinking === true` 时才渲染。

### 6.2 视觉样式

复用现有 `tool-line` 折叠样式：

```
▸ 💭 思考过程 · 412 字                 （历史消息，仅字数）
▸ 💭 思考过程 · 已观察 3s · 412 字       （本次会话流式完成的消息）
▾ 💭 思考中… · 128 字                   （流式进行中）
```

展开后：

```
▾ 💭 ...
  ┌─────────────────────────
  │ thinking 内容（Markdown 渲染，
  │ 字体略小、弱对比色）
  └─────────────────────────
```

新增 SCSS 类 `.thinking-block`，复用 `.tool-line` / `.tool-details` 的布局，文本弱化（opacity 0.85 + italic 可选）。

### 6.3 默认展开状态

- **流式进行中**（`message.isStreaming && parsedThinking.pending`）→ **强制展开**；
- **非流式**：
  - `settings.display.show_reasoning === true` → 默认展开；
  - `settings.display.show_reasoning === false` → 默认收起；
- 用户手动点击 chevron 切换后，以组件内 `ref<boolean | null>(null)` 记录覆盖态（null = 跟随默认）。**Transient**：刷新 / 切会话 / 重挂载后回默认。

### 6.4 Header 摘要计算

两条独立响应链避免性能问题（采纳 rubber-duck #7）：

```ts
// 仅依赖 content 变化，重解析
const parsed = computed(() => parseThinking(message.content, { streaming: message.isStreaming }))

// 字数：Unicode 字符数
const thinkingChars = computed(() => {
  const len = (s: string) => [...s].length
  return parsed.value.segments.reduce((a, s) => a + len(s), 0) + len(parsed.value.pending || '')
})

// 耗时：仅活跃 streaming 消息开秒表；非活跃时取定值或不显示
const observation = chatStore.getThinkingObservation(message.id) // 可能为 undefined
const liveNowTick = /* useInterval(1000) 仅在 isStreaming 时启用 */
const durationMs = computed(() => {
  if (!observation?.startedAt) return null
  const end = observation.endedAt ?? (message.isStreaming ? liveNowTick.value : observation.startedAt)
  return end - observation.startedAt
})
```

- 字数计算开销小，随 content 变化；
- duration interval 仅在 `message.isStreaming && observation?.startedAt && !observation?.endedAt` 时启用，非活跃消息不耗 CPU。

### 6.5 终止态降级（采纳 rubber-duck #2）

当 SSE `run.completed` / `run.failed` 触发后：

- 消息 `isStreaming` 变为 `false`；
- 解析时传入 `streaming: false`；
- `parseThinking` 中未闭合的 `<think>` 不再视为 pending，**保留为正文的一部分**；
- 避免"答案被永久折叠看不见"。

### 6.6 i18n 新增 key（8 语言）

```
chat.thinkingLabel          "思考过程" / "Thinking"
chat.thinkingInProgress     "思考中…" / "Thinking…"
chat.thinkingShow           "展开思考过程"
chat.thinkingHide           "收起思考过程"
chat.thinkingDuration       "已观察 {duration}" / "Observed {duration}"
chat.thinkingChars          "{count} 字" / "{count} chars"
```

## 7. 涉及文件

| 文件 | 变更 |
|---|---|
| `packages/client/src/utils/thinking-parser.ts` | **新增** — 纯函数解析器 + 边界检测 |
| `packages/client/src/components/hermes/chat/MessageItem.vue` | 新增 thinking 折叠区渲染，computed 拆分 |
| `packages/client/src/stores/hermes/chat.ts` | 新增 `thinkingObservation` Map；`message.delta` 中写入边界；`switchSession` 清理；导出 `getThinkingObservation(messageId)` |
| `packages/client/src/i18n/locales/{en,zh,de,es,fr,ja,ko,pt}.ts` | 新增 6 条 i18n key |
| `tests/client/utils/thinking-parser.test.ts` | **新增** — 解析器单元测试 |
| `tests/client/stores/chat-thinking-boundary.test.ts` | **新增** — 边界检测 / switchSession 清理测试 |

## 8. 测试策略

### 8.1 解析器（必测，覆盖边界）

- 单个闭合 `<think>...</think>` → segments=[...], body=''
- 多个闭合片段按顺序
- 未闭合 `<think>x`，`streaming=true` → pending='x'
- 未闭合 `<think>x`，`streaming=false`（终止态降级）→ body 原样保留 `<think>x`，pending=null
- `<thinking>` / `<reasoning>` 变体
- 大小写变体 `<Think>`, `<REASONING>`
- **同名嵌套** `<think>a<think>b</think>c</think>` → segments=['a<think>b'], body='c</think>'（明确文档化此行为）
- **Fenced code block 保护** `\`\`\`\n<think>not real</think>\n\`\`\`` → 不识别
- **Inline code 保护** `` `<think>` `` → 不识别
- 空 content → hasThinking=false
- 纯正文 → hasThinking=false, body 原样
- Chunk 边界场景（前半 `<thin`，后半 `k>hi</think>`）→ 基于累积 content 正确解析

### 8.2 边界检测（必测）

- `detectThinkingBoundary('', '<think>hi')` → startedAtBoundary=true
- `detectThinkingBoundary('<think>hi', '<think>hi</think>')` → endedAtBoundary=true
- `detectThinkingBoundary('abc', 'abcdef')` → both false
- 代码块里的伪标签不触发边界

### 8.3 Store 行为（必测）

- `message.delta` 首次出现开始标签 → `thinkingObservation` Map 写入 startedAt
- 首次结束标签 → 写入 endedAt
- `switchSession` → Map 清空
- `refreshActiveSession` 覆盖消息后，Map 已写入的 entry 保留（即仅 switchSession 清理）

### 8.4 组件（若已有 Vue test-utils 基建）

- 无 thinking 时 `.thinking-block` 不渲染
- `show_reasoning=true` 默认展开；`=false` 默认收起
- 流式且有 pending 时强制展开（忽略 show_reasoning）
- 点击切换不改设置
- 有 observation 显示 duration，无 observation 仅显示字数

## 9. 兼容性与迁移

### 9.1 数据层（完全兼容）

- **`Message.content` 字段未变**：仍是原始字符串（含 `<think>...</think>` 等标签）；
- **`Message` 接口无新持久化字段**（采纳 rubber-duck #4）；
- **localStorage 旧数据**：无 schema 迁移，原样可读；
- **Sessions export/import JSON 格式**：无变化；
- **上游 hermes CLI `sessions export`**：读取的仍是 content 字符串，无副作用。

### 9.2 渲染行为变化（正是需求本身）

**升级到含本功能的版本后，老消息的视觉表现会发生变化**，这是功能预期效果：

| 场景 | 旧版渲染 | 新版渲染 |
|---|---|---|
| `<think>x</think>body` | think 标签原样出现在正文中（或被 Markdown 当作 HTML 忽略） | 识别为独立可折叠块 + 正文 |
| 仅 `<think>x</think>` 无正文 | 整条消息显示 think 内容（含标签） | 仅显示折叠 thinking，正文为空 |
| 代码块中演示 `<think>` 字面量 | 同样原样显示 | **不识别**，保持原样 |

**历史消息在新版下的限制**：

- 无 `thinkingObservation` entry → **不显示耗时**，header 文案降级为 `💭 思考过程 · X 字`；
- 该限制是刻意设计：耗时语义为"本次会话前端观察到的 wall-clock 时间"，历史消息无法回溯，显示任何数字都会误导。

### 9.3 边界情况

- **老消息中 `<think>` 未闭合**（极罕见，如旧版前端流式中断未完整保存）→ §6.5 终止态降级保留为正文，不会吞答案；
- **同名嵌套 / 代码块伪标签 / chunk 边界** → §4 解析规则已明确处理。

### 9.4 未来扩展

若上游新增独立 `reasoning.delta` SSE 事件，可在 chat store 将 delta 单独拼接到 segments 虚拟字段，UI 层无需变动（解析器仍兼容标签形式）。

## 10. 风险与决议

| 风险 | 缓解 |
|---|---|
| 超长 content regex 性能 | `computed` 缓存；代码块替换 + 一次正则扫描级别 |
| 代码块内伪标签误识别 | 首版即做代码块保护（4.2）|
| 流式结束时标签未闭合，正文被吞 | 终止态降级（6.5）保留为正文 |
| 嵌套标签误匹配 | 显式不支持，文档化；实际场景极罕见 |
| 刷新后时间戳丢失 | 纯运行时派生，不持久化；历史消息仅显示字数 |
| 多段 reasoning 的耗时失真 | 按"首个 started / 最后 ended"聚合；字数累加 |
| duration 秒表造成非活跃消息 CPU 占用 | interval 只在 `isStreaming && hasStartedAt && !hasEndedAt` 时启动 |

## 11. 实施阶段（交给 writing-plans 细化）

1. 实现 `utils/thinking-parser.ts` + 解析器单测（TDD）
2. 实现边界检测 + switchSession 清理 + store 单测
3. `MessageItem.vue` 集成折叠 UI（两条响应链 + transient 状态）
4. SCSS 复用 tool-line 样式
5. i18n 8 语言
6. 集成自测（DeepSeek R1 / GLM 真实对话）+ 手动验证刷新、切会话场景
7. `npm run build` + `npm run test` 验证

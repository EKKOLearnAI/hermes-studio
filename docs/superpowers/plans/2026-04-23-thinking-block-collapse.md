# Think 块与正文分离、可折叠展示 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 识别 assistant 消息中 `<think>/<thinking>/<reasoning>` 标签，分离为可折叠思考块展示，不破坏历史数据。

**Architecture:** 新增纯函数解析器位于 `utils/`；chat store 用运行时 Map 记录流式观察到的时间戳；`MessageItem.vue` 用两条独立响应链（parsed computed + duration interval）渲染折叠区。

**Tech Stack:** Vue 3 Composition API, TypeScript (strict), Pinia, Naive UI, Vitest, SCSS。

**Spec:** `docs/superpowers/specs/2026-04-23-thinking-block-collapse-design.md`

---

## 文件结构

| 路径 | 角色 |
|---|---|
| `packages/client/src/utils/thinking-parser.ts` | **新建** 纯函数：`parseThinking`、`detectThinkingBoundary`、`countThinkingChars` |
| `packages/client/src/stores/hermes/chat.ts` | **修改** 新增 `thinkingObservation` Map + getter + `switchSession` 清理 + `message.delta` 边界写入 |
| `packages/client/src/components/hermes/chat/MessageItem.vue` | **修改** 新增 `.thinking-block` 渲染区 + 两条 computed/interval |
| `packages/client/src/i18n/locales/{en,zh,de,es,fr,ja,ko,pt}.ts` | **修改** 新增 6 条 `chat.thinking*` key |
| `tests/client/thinking-parser.test.ts` | **新建** 解析器单测 |
| `tests/client/chat-store-thinking.test.ts` | **新建** store 观察态单测 |

---

## Task 1: 解析器骨架 + 第一个闭合标签测试

**Files:**
- Create: `tests/client/thinking-parser.test.ts`
- Create: `packages/client/src/utils/thinking-parser.ts`

- [ ] **Step 1.1: 写首个失败测试（单个闭合 think）**

```ts
// tests/client/thinking-parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseThinking } from '@/utils/thinking-parser'

describe('parseThinking', () => {
  it('splits a single closed <think> block from body', () => {
    const r = parseThinking('<think>inner</think>body', { streaming: false })
    expect(r.segments).toEqual(['inner'])
    expect(r.body).toBe('body')
    expect(r.pending).toBeNull()
    expect(r.hasThinking).toBe(true)
  })
})
```

- [ ] **Step 1.2: 运行测试确认失败**

Run: `npx vitest run tests/client/thinking-parser.test.ts`
Expected: FAIL — `Cannot find module '@/utils/thinking-parser'`

- [ ] **Step 1.3: 实现最小骨架**

```ts
// packages/client/src/utils/thinking-parser.ts
export interface ParsedThinking {
  segments: string[]
  pending: string | null
  body: string
  hasThinking: boolean
}

export interface ParseOptions {
  streaming: boolean
}

const TAG_RE = /<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi

export function parseThinking(content: string, opts: ParseOptions): ParsedThinking {
  const segments: string[] = []
  let pending: string | null = null
  let body = ''
  let lastIndex = 0

  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(content)) !== null) {
    body += content.slice(lastIndex, m.index)
    segments.push(m[2])
    lastIndex = m.index + m[0].length
  }
  const rest = content.slice(lastIndex)

  const openRe = /<(think|thinking|reasoning)>([\s\S]*)$/i
  const openMatch = rest.match(openRe)
  if (openMatch) {
    body += rest.slice(0, openMatch.index)
    if (opts.streaming) {
      pending = openMatch[2]
    } else {
      body += rest.slice(openMatch.index!)
    }
  } else {
    body += rest
  }

  return {
    segments,
    pending,
    body,
    hasThinking: segments.length > 0 || pending !== null,
  }
}
```

- [ ] **Step 1.4: 运行测试确认通过**

Run: `npx vitest run tests/client/thinking-parser.test.ts`
Expected: PASS (1 test)

- [ ] **Step 1.5: 提交**

```bash
git add tests/client/thinking-parser.test.ts packages/client/src/utils/thinking-parser.ts
git commit -m "feat(thinking-parser): 首个闭合 <think> 标签拆分

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: 解析器：多段、变体标签、大小写、空输入

**Files:**
- Modify: `tests/client/thinking-parser.test.ts`

- [ ] **Step 2.1: 追加测试**

```ts
  it('collects multiple closed blocks in order', () => {
    const r = parseThinking('<think>a</think>mid<thinking>b</thinking>end', { streaming: false })
    expect(r.segments).toEqual(['a', 'b'])
    expect(r.body).toBe('midend')
  })

  it('supports <thinking> and <reasoning> variants', () => {
    const r = parseThinking('<reasoning>r</reasoning>body', { streaming: false })
    expect(r.segments).toEqual(['r'])
    expect(r.body).toBe('body')
  })

  it('is case-insensitive on tag names', () => {
    const r = parseThinking('<Think>x</Think><REASONING>y</REASONING>z', { streaming: false })
    expect(r.segments).toEqual(['x', 'y'])
    expect(r.body).toBe('z')
  })

  it('returns hasThinking=false and body unchanged for plain text', () => {
    const r = parseThinking('hello world', { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe('hello world')
    expect(r.segments).toEqual([])
  })

  it('returns hasThinking=false for empty content', () => {
    const r = parseThinking('', { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe('')
  })
```

- [ ] **Step 2.2: 运行**

Run: `npx vitest run tests/client/thinking-parser.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 2.3: 提交**

```bash
git add tests/client/thinking-parser.test.ts
git commit -m "test(thinking-parser): 覆盖多段/变体标签/大小写/空输入

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: 流式未闭合 + 终止态降级

**Files:**
- Modify: `tests/client/thinking-parser.test.ts`

- [ ] **Step 3.1: 追加测试**

```ts
  it('treats trailing unclosed tag as pending when streaming', () => {
    const r = parseThinking('body<think>in-progress', { streaming: true })
    expect(r.pending).toBe('in-progress')
    expect(r.body).toBe('body')
    expect(r.segments).toEqual([])
    expect(r.hasThinking).toBe(true)
  })

  it('degrades trailing unclosed tag to body when NOT streaming (terminal state)', () => {
    const r = parseThinking('body<think>orphan', { streaming: false })
    expect(r.pending).toBeNull()
    expect(r.body).toBe('body<think>orphan')
    expect(r.segments).toEqual([])
    expect(r.hasThinking).toBe(false)
  })

  it('combines closed segments with trailing pending (streaming)', () => {
    const r = parseThinking('<think>done</think>mid<thinking>now', { streaming: true })
    expect(r.segments).toEqual(['done'])
    expect(r.pending).toBe('now')
    expect(r.body).toBe('mid')
  })
```

- [ ] **Step 3.2: 运行 + 提交**

Run: `npx vitest run tests/client/thinking-parser.test.ts`
Expected: PASS (9 tests)

```bash
git add tests/client/thinking-parser.test.ts
git commit -m "test(thinking-parser): 流式 pending 与终止态降级

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: 代码块保护（fenced + inline）

**Files:**
- Modify: `tests/client/thinking-parser.test.ts`
- Modify: `packages/client/src/utils/thinking-parser.ts`

- [ ] **Step 4.1: 写失败测试**

```ts
  it('does NOT recognize <think> inside fenced code block', () => {
    const src = 'before\n```\n<think>fake</think>\n```\nafter'
    const r = parseThinking(src, { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe(src)
  })

  it('does NOT recognize <think> inside tilde-fenced code block', () => {
    const src = '~~~\n<think>fake</think>\n~~~'
    const r = parseThinking(src, { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe(src)
  })

  it('does NOT recognize <think> inside inline code', () => {
    const src = 'the tag `<think>x</think>` is a literal'
    const r = parseThinking(src, { streaming: false })
    expect(r.hasThinking).toBe(false)
    expect(r.body).toBe(src)
  })

  it('parses real <think> outside code blocks even when code blocks contain fake ones', () => {
    const src = '<think>real</think>text\n```\n<think>fake</think>\n```'
    const r = parseThinking(src, { streaming: false })
    expect(r.segments).toEqual(['real'])
    expect(r.body).toBe('text\n```\n<think>fake</think>\n```')
  })
```

- [ ] **Step 4.2: 运行确认失败**

Run: `npx vitest run tests/client/thinking-parser.test.ts`
Expected: FAIL on 4 new tests

- [ ] **Step 4.3: 重构实现加入代码块保护**

替换 `packages/client/src/utils/thinking-parser.ts` 整个 `parseThinking` 相关部分为：

```ts
const PLACEHOLDER_PREFIX = '\u0000THKCODE'
const PLACEHOLDER_SUFFIX = '\u0000'

const FENCED_RE = /(```|~~~)([\s\S]*?)\1/g
const INLINE_CODE_RE = /`[^`\n]*`/g

function protectCodeBlocks(input: string): { masked: string; blocks: string[] } {
  const blocks: string[] = []
  let masked = input.replace(FENCED_RE, (m) => {
    blocks.push(m)
    return `${PLACEHOLDER_PREFIX}${blocks.length - 1}${PLACEHOLDER_SUFFIX}`
  })
  masked = masked.replace(INLINE_CODE_RE, (m) => {
    blocks.push(m)
    return `${PLACEHOLDER_PREFIX}${blocks.length - 1}${PLACEHOLDER_SUFFIX}`
  })
  return { masked, blocks }
}

function restoreCodeBlocks(text: string, blocks: string[]): string {
  if (blocks.length === 0) return text
  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, idx) => blocks[Number(idx)] ?? '',
  )
}

export function parseThinking(content: string, opts: ParseOptions): ParsedThinking {
  const { masked, blocks } = protectCodeBlocks(content)

  const segments: string[] = []
  let pending: string | null = null
  let body = ''
  let lastIndex = 0

  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(masked)) !== null) {
    body += masked.slice(lastIndex, m.index)
    segments.push(m[2])
    lastIndex = m.index + m[0].length
  }
  const rest = masked.slice(lastIndex)

  const openRe = /<(think|thinking|reasoning)>([\s\S]*)$/i
  const openMatch = rest.match(openRe)
  if (openMatch) {
    body += rest.slice(0, openMatch.index)
    if (opts.streaming) {
      pending = openMatch[2]
    } else {
      body += rest.slice(openMatch.index!)
    }
  } else {
    body += rest
  }

  return {
    segments: segments.map(s => restoreCodeBlocks(s, blocks)),
    pending: pending === null ? null : restoreCodeBlocks(pending, blocks),
    body: restoreCodeBlocks(body, blocks),
    hasThinking: segments.length > 0 || pending !== null,
  }
}
```

- [ ] **Step 4.4: 运行确认全部通过**

Run: `npx vitest run tests/client/thinking-parser.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 4.5: 提交**

```bash
git add tests/client/thinking-parser.test.ts packages/client/src/utils/thinking-parser.ts
git commit -m "feat(thinking-parser): 代码块保护避免误识别伪标签

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: 同名嵌套 & chunk 边界 行为文档化

**Files:**
- Modify: `tests/client/thinking-parser.test.ts`

- [ ] **Step 5.1: 追加行为说明测试**

```ts
  it('same-name nesting: inner tag absorbed into first segment (documented limitation)', () => {
    const r = parseThinking('<think>a<think>b</think>c</think>', { streaming: false })
    expect(r.segments).toEqual(['a<think>b'])
    expect(r.body).toBe('c</think>')
  })

  it('handles chunk boundary: partial opening tag not yet identified', () => {
    const mid = parseThinking('<thin', { streaming: true })
    expect(mid.hasThinking).toBe(false)
    expect(mid.body).toBe('<thin')

    const after = parseThinking('<think>hi</think>done', { streaming: true })
    expect(after.segments).toEqual(['hi'])
    expect(after.body).toBe('done')
  })
```

- [ ] **Step 5.2: 运行 + 提交**

Run: `npx vitest run tests/client/thinking-parser.test.ts`
Expected: PASS (15 tests)

```bash
git add tests/client/thinking-parser.test.ts
git commit -m "test(thinking-parser): 同名嵌套与 chunk 边界行为

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: 字数计数 `countThinkingChars`

**Files:**
- Modify: `tests/client/thinking-parser.test.ts`
- Modify: `packages/client/src/utils/thinking-parser.ts`

- [ ] **Step 6.1: 写测试**

```ts
import { countThinkingChars } from '@/utils/thinking-parser'

describe('countThinkingChars', () => {
  it('counts all segments + pending as Unicode chars', () => {
    const n = countThinkingChars({
      segments: ['abc', '你好'],
      pending: '🎉!',
      body: '',
      hasThinking: true,
    })
    expect(n).toBe(7)
  })

  it('returns 0 when no thinking', () => {
    expect(countThinkingChars({ segments: [], pending: null, body: 'x', hasThinking: false })).toBe(0)
  })
})
```

- [ ] **Step 6.2: 实现**

在 `packages/client/src/utils/thinking-parser.ts` 末尾追加：

```ts
export function countThinkingChars(parsed: ParsedThinking): number {
  const len = (s: string) => [...s].length
  return parsed.segments.reduce((a, s) => a + len(s), 0) + len(parsed.pending || '')
}
```

- [ ] **Step 6.3: 运行 + 提交**

Run: `npx vitest run tests/client/thinking-parser.test.ts`
Expected: PASS (17 tests)

```bash
git add tests/client/thinking-parser.test.ts packages/client/src/utils/thinking-parser.ts
git commit -m "feat(thinking-parser): countThinkingChars 辅助函数

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: 边界检测 `detectThinkingBoundary`

**Files:**
- Modify: `tests/client/thinking-parser.test.ts`
- Modify: `packages/client/src/utils/thinking-parser.ts`

- [ ] **Step 7.1: 测试**

```ts
import { detectThinkingBoundary } from '@/utils/thinking-parser'

describe('detectThinkingBoundary', () => {
  it('detects first appearance of opening tag', () => {
    const r = detectThinkingBoundary('', '<think>x')
    expect(r.startedAtBoundary).toBe(true)
    expect(r.endedAtBoundary).toBe(false)
  })

  it('detects first appearance of closing tag', () => {
    const r = detectThinkingBoundary('<think>hi', '<think>hi</think>')
    expect(r.startedAtBoundary).toBe(false)
    expect(r.endedAtBoundary).toBe(true)
  })

  it('detects both when both emerge in one delta', () => {
    const r = detectThinkingBoundary('', '<think>x</think>')
    expect(r.startedAtBoundary).toBe(true)
    expect(r.endedAtBoundary).toBe(true)
  })

  it('reports no boundary when neither crossed', () => {
    const r = detectThinkingBoundary('abc', 'abcdef')
    expect(r.startedAtBoundary).toBe(false)
    expect(r.endedAtBoundary).toBe(false)
  })

  it('ignores fake tags inside code blocks', () => {
    const r = detectThinkingBoundary('', '```\n<think>fake</think>\n```')
    expect(r.startedAtBoundary).toBe(false)
    expect(r.endedAtBoundary).toBe(false)
  })

  it('is idempotent for repeated open/close after initial', () => {
    const r = detectThinkingBoundary(
      '<think>a</think><think>b',
      '<think>a</think><think>b</think>',
    )
    expect(r.startedAtBoundary).toBe(false)
    expect(r.endedAtBoundary).toBe(false)
  })
})
```

- [ ] **Step 7.2: 实现**

在 `packages/client/src/utils/thinking-parser.ts` 末尾追加：

```ts
export interface ThinkingBoundary {
  startedAtBoundary: boolean
  endedAtBoundary: boolean
}

const ANY_OPEN_RE = /<(think|thinking|reasoning)>/i
const ANY_CLOSE_RE = /<\/(think|thinking|reasoning)>/i

export function detectThinkingBoundary(prev: string, next: string): ThinkingBoundary {
  const prevMasked = protectCodeBlocks(prev).masked
  const nextMasked = protectCodeBlocks(next).masked
  return {
    startedAtBoundary: !ANY_OPEN_RE.test(prevMasked) && ANY_OPEN_RE.test(nextMasked),
    endedAtBoundary: !ANY_CLOSE_RE.test(prevMasked) && ANY_CLOSE_RE.test(nextMasked),
  }
}
```

- [ ] **Step 7.3: 运行 + 提交**

Run: `npx vitest run tests/client/thinking-parser.test.ts`
Expected: PASS (23 tests)

```bash
git add tests/client/thinking-parser.test.ts packages/client/src/utils/thinking-parser.ts
git commit -m "feat(thinking-parser): detectThinkingBoundary 边界检测

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: chat store 集成 `thinkingObservation`

**Files:**
- Create: `tests/client/chat-store-thinking.test.ts`
- Modify: `packages/client/src/stores/hermes/chat.ts`

- [ ] **Step 8.1: 写 store 单测**

```ts
// tests/client/chat-store-thinking.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '@/stores/hermes/chat'

describe('chat store thinkingObservation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts empty', () => {
    const store = useChatStore()
    expect(store.getThinkingObservation('any-id')).toBeUndefined()
  })

  it('records startedAt when delta first introduces an opening tag', () => {
    const store = useChatStore()
    store.noteThinkingDelta('msg-1', '', '<think>hi')
    const ob = store.getThinkingObservation('msg-1')
    expect(ob).toBeDefined()
    expect(typeof ob!.startedAt).toBe('number')
    expect(ob!.endedAt).toBeUndefined()
  })

  it('records endedAt when delta first introduces closing tag', () => {
    const store = useChatStore()
    store.noteThinkingDelta('msg-1', '', '<think>hi')
    store.noteThinkingDelta('msg-1', '<think>hi', '<think>hi</think>done')
    const ob = store.getThinkingObservation('msg-1')
    expect(ob!.startedAt).toBeDefined()
    expect(typeof ob!.endedAt).toBe('number')
  })

  it('is idempotent for subsequent openings/closings', () => {
    const store = useChatStore()
    store.noteThinkingDelta('m', '', '<think>a</think>')
    const first = store.getThinkingObservation('m')!
    const firstStarted = first.startedAt
    const firstEnded = first.endedAt
    store.noteThinkingDelta(
      'm',
      '<think>a</think>',
      '<think>a</think><think>b</think>',
    )
    const second = store.getThinkingObservation('m')!
    expect(second.startedAt).toBe(firstStarted)
    expect(second.endedAt).toBe(firstEnded)
  })

  it('is ignored when delta is inside a code block', () => {
    const store = useChatStore()
    store.noteThinkingDelta('m', '', '```\n<think>fake</think>\n```')
    expect(store.getThinkingObservation('m')).toBeUndefined()
  })

  it('clears observations on clearThinkingObservationFor', () => {
    const store = useChatStore()
    store.noteThinkingDelta('m', '', '<think>hi</think>')
    expect(store.getThinkingObservation('m')).toBeDefined()
    store.clearThinkingObservationFor('any-session')
    expect(store.getThinkingObservation('m')).toBeUndefined()
  })
})
```

- [ ] **Step 8.2: 运行确认失败**

Run: `npx vitest run tests/client/chat-store-thinking.test.ts`
Expected: FAIL — 方法未定义

- [ ] **Step 8.3: 修改 chat.ts 导入 detectThinkingBoundary**

在 `packages/client/src/stores/hermes/chat.ts` import 区域追加一行：

```ts
import { detectThinkingBoundary } from '@/utils/thinking-parser'
```

- [ ] **Step 8.4: 在 store setup 函数内新增状态与方法**

定位 `defineStore('chat', () => { ... })` 内部（建议在已有 `const streamStates = ...` 等 ref 声明附近），追加：

```ts
  // Transient observation of <think> boundaries during active streaming.
  // Not persisted; cleared on session switch. See spec §5.3.
  const thinkingObservation = new Map<string, { startedAt?: number; endedAt?: number }>()

  function getThinkingObservation(messageId: string) {
    return thinkingObservation.get(messageId)
  }

  function noteThinkingDelta(messageId: string, prevContent: string, nextContent: string) {
    const { startedAtBoundary, endedAtBoundary } = detectThinkingBoundary(prevContent, nextContent)
    if (!startedAtBoundary && !endedAtBoundary) return
    const existing = thinkingObservation.get(messageId) || {}
    if (startedAtBoundary && existing.startedAt === undefined) {
      existing.startedAt = Date.now()
    }
    if (endedAtBoundary && existing.endedAt === undefined) {
      existing.endedAt = Date.now()
    }
    thinkingObservation.set(messageId, existing)
  }

  function clearThinkingObservationFor(_sessionId: string) {
    // messageId 与 sessionId 的关联未单独持有；方案是切会话时一律清空。
    // 这符合 spec 定义：observation 是"当前会话范围内"的 transient 状态。
    thinkingObservation.clear()
  }
```

在 store `return { ... }` 块末尾新增导出：

```ts
    getThinkingObservation,
    noteThinkingDelta,
    clearThinkingObservationFor,
```

- [ ] **Step 8.5: 运行测试确认通过**

Run: `npx vitest run tests/client/chat-store-thinking.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 8.6: 提交**

```bash
git add packages/client/src/stores/hermes/chat.ts tests/client/chat-store-thinking.test.ts
git commit -m "feat(chat-store): 新增 thinkingObservation 运行时 Map

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 9: 接入 `message.delta` 与 `switchSession`

**Files:**
- Modify: `packages/client/src/stores/hermes/chat.ts`

- [ ] **Step 9.1: 定位 switchSession**

Run: `grep -n "async function switchSession\|function switchSession\|switchSession =\|function selectSession" packages/client/src/stores/hermes/chat.ts`

记下函数起始行号。

- [ ] **Step 9.2: 修改 message.delta 分支**

把 `packages/client/src/stores/hermes/chat.ts` 中 `case 'message.delta':` 分支（约 817-833 行）整体替换为：

```ts
            case 'message.delta': {
              const msgs = getSessionMsgs(sid)
              const last = msgs[msgs.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) {
                const prev = last.content
                const next = prev + (evt.delta || '')
                noteThinkingDelta(last.id, prev, next)
                last.content = next
              } else {
                const newId = uid()
                const nextContent = evt.delta || ''
                noteThinkingDelta(newId, '', nextContent)
                addMessage(sid, {
                  id: newId,
                  role: 'assistant',
                  content: nextContent,
                  timestamp: Date.now(),
                  isStreaming: true,
                })
              }
              schedulePersist()
              break
            }
```

- [ ] **Step 9.3: 在 switchSession 函数最开头加一行清理**

根据 Step 9.1 找到的 switchSession 函数入口（形如 `async function switchSession(sessionId: string) {`），在函数体第一行加入：

```ts
    clearThinkingObservationFor(sessionId)
```

（参数名以实际函数签名为准。）

- [ ] **Step 9.4: 运行所有测试**

Run: `npm run test -- --run`
Expected: 全部通过（新增 + 原有）

Run: `npx vue-tsc -b --noEmit`
Expected: 通过

- [ ] **Step 9.5: 提交**

```bash
git add packages/client/src/stores/hermes/chat.ts
git commit -m "feat(chat-store): message.delta 写入 thinking 边界 + switchSession 清理

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 10: i18n 8 语言新增 thinking key

**Files:**
- Modify: `packages/client/src/i18n/locales/{en,zh,de,es,fr,ja,ko,pt}.ts`

在每个 locale 的 `chat: { ... }` 对象**末尾**（闭合 `},` 前）追加 6 条 key。各语言内容如下：

**zh.ts**
```ts
    thinkingLabel: '思考过程',
    thinkingInProgress: '思考中…',
    thinkingShow: '展开思考过程',
    thinkingHide: '收起思考过程',
    thinkingDuration: '已观察 {duration}',
    thinkingChars: '{count} 字',
```

**en.ts**
```ts
    thinkingLabel: 'Thinking',
    thinkingInProgress: 'Thinking…',
    thinkingShow: 'Show thinking',
    thinkingHide: 'Hide thinking',
    thinkingDuration: 'Observed {duration}',
    thinkingChars: '{count} chars',
```

**de.ts**
```ts
    thinkingLabel: 'Denkprozess',
    thinkingInProgress: 'Denkt…',
    thinkingShow: 'Denkprozess anzeigen',
    thinkingHide: 'Denkprozess ausblenden',
    thinkingDuration: 'Beobachtet {duration}',
    thinkingChars: '{count} Zeichen',
```

**es.ts**
```ts
    thinkingLabel: 'Pensamiento',
    thinkingInProgress: 'Pensando…',
    thinkingShow: 'Mostrar pensamiento',
    thinkingHide: 'Ocultar pensamiento',
    thinkingDuration: 'Observado {duration}',
    thinkingChars: '{count} caracteres',
```

**fr.ts**
```ts
    thinkingLabel: 'Raisonnement',
    thinkingInProgress: 'En réflexion…',
    thinkingShow: 'Afficher le raisonnement',
    thinkingHide: 'Masquer le raisonnement',
    thinkingDuration: 'Observé {duration}',
    thinkingChars: '{count} caractères',
```

**ja.ts**
```ts
    thinkingLabel: '思考過程',
    thinkingInProgress: '思考中…',
    thinkingShow: '思考過程を表示',
    thinkingHide: '思考過程を隠す',
    thinkingDuration: '観測 {duration}',
    thinkingChars: '{count} 文字',
```

**ko.ts**
```ts
    thinkingLabel: '사고 과정',
    thinkingInProgress: '사고 중…',
    thinkingShow: '사고 과정 펼치기',
    thinkingHide: '사고 과정 접기',
    thinkingDuration: '관측 {duration}',
    thinkingChars: '{count}자',
```

**pt.ts**
```ts
    thinkingLabel: 'Raciocínio',
    thinkingInProgress: 'Pensando…',
    thinkingShow: 'Mostrar raciocínio',
    thinkingHide: 'Ocultar raciocínio',
    thinkingDuration: 'Observado {duration}',
    thinkingChars: '{count} caracteres',
```

- [ ] **Step 10.1: 追加 8 个 locale 文件中的 key**（如上）

- [ ] **Step 10.2: Type-check**

Run: `npx vue-tsc -b --noEmit`
Expected: 通过

- [ ] **Step 10.3: 提交**

```bash
git add packages/client/src/i18n/locales/
git commit -m "i18n: 新增 thinking 块 6 条 key（8 语言）

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 11: `MessageItem.vue` 渲染 thinking 折叠区

**Files:**
- Modify: `packages/client/src/components/hermes/chat/MessageItem.vue`

- [ ] **Step 11.1: 补充 `<script setup>` 导入与状态**

在现有 import 后追加：

```ts
import { computed, onBeforeUnmount, ref, watchEffect } from 'vue'
import { parseThinking, countThinkingChars } from '@/utils/thinking-parser'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
```

（注意：`computed, ref` 如已 import，不重复导入；实际只新增 `onBeforeUnmount, watchEffect`。）

在 `const timeStr = computed(...)` 附近追加：

```ts
const chatStore = useChatStore()
const settingsStore = useSettingsStore()

const parsedThinking = computed(() =>
  parseThinking(props.message.content || '', { streaming: !!props.message.isStreaming }),
)

const thinkingCharCount = computed(() => countThinkingChars(parsedThinking.value))

const thinkingOverride = ref<boolean | null>(null)

const thinkingExpanded = computed(() => {
  if (props.message.isStreaming && parsedThinking.value.pending !== null) return true
  if (thinkingOverride.value !== null) return thinkingOverride.value
  return !!settingsStore.display.show_reasoning
})

function toggleThinking() {
  thinkingOverride.value = !thinkingExpanded.value
}

const nowTick = ref(Date.now())
let tickTimer: number | null = null

function ensureTick() {
  const ob = chatStore.getThinkingObservation(props.message.id)
  const shouldTick = !!(
    props.message.isStreaming &&
    ob?.startedAt !== undefined &&
    ob.endedAt === undefined
  )
  if (shouldTick && tickTimer === null) {
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now()
    }, 1000)
  } else if (!shouldTick && tickTimer !== null) {
    window.clearInterval(tickTimer)
    tickTimer = null
  }
}

watchEffect(ensureTick)

onBeforeUnmount(() => {
  if (tickTimer !== null) window.clearInterval(tickTimer)
})

const thinkingDurationMs = computed<number | null>(() => {
  const ob = chatStore.getThinkingObservation(props.message.id)
  if (!ob?.startedAt) return null
  const end = ob.endedAt ?? (props.message.isStreaming ? nowTick.value : ob.startedAt)
  return Math.max(0, end - ob.startedAt)
})

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r === 0 ? `${m}m` : `${m}m ${r}s`
}

const thinkingFullText = computed(() => {
  const parts = parsedThinking.value.segments.slice()
  if (parsedThinking.value.pending) parts.push(parsedThinking.value.pending)
  return parts.join('\n\n')
})
```

- [ ] **Step 11.2: 在 assistant 气泡模板中插入 thinking 区块**

在 `MessageItem.vue` `<template>` 中，找到：

```vue
            <MarkdownRenderer
              v-if="message.content"
              :content="message.content"
            />
```

替换为：

```vue
            <div
              v-if="parsedThinking.hasThinking"
              class="thinking-block"
              :class="{ expanded: thinkingExpanded }"
            >
              <div class="thinking-header" @click="toggleThinking">
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="thinking-chevron"
                  :class="{ rotated: thinkingExpanded }"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                <span class="thinking-icon">💭</span>
                <span class="thinking-label">
                  {{
                    message.isStreaming && parsedThinking.pending !== null
                      ? t('chat.thinkingInProgress')
                      : t('chat.thinkingLabel')
                  }}
                </span>
                <span v-if="thinkingDurationMs !== null" class="thinking-meta">
                  · {{ t('chat.thinkingDuration', { duration: formatDuration(thinkingDurationMs) }) }}
                </span>
                <span class="thinking-meta">
                  · {{ t('chat.thinkingChars', { count: thinkingCharCount }) }}
                </span>
              </div>
              <div v-if="thinkingExpanded" class="thinking-body">
                <MarkdownRenderer :content="thinkingFullText" />
              </div>
            </div>
            <MarkdownRenderer
              v-if="parsedThinking.body"
              :content="parsedThinking.body"
            />
```

- [ ] **Step 11.3: 追加 SCSS 样式**

在 `<style scoped lang="scss">` 区域，`.msg-attachment-file { ... }` 结束后追加：

```scss
.thinking-block {
  margin-bottom: 8px;
  padding: 4px 0;
  border-bottom: 1px dashed $border-light;

  .thinking-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: $text-muted;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: $radius-sm;
    user-select: none;

    &:hover {
      background: rgba(0, 0, 0, 0.03);
    }
  }

  .thinking-chevron {
    flex-shrink: 0;
    transition: transform 0.15s ease;

    &.rotated {
      transform: rotate(90deg);
    }
  }

  .thinking-icon {
    font-size: 11px;
    flex-shrink: 0;
  }

  .thinking-label {
    font-weight: 500;
    flex-shrink: 0;
  }

  .thinking-meta {
    color: $text-muted;
    font-variant-numeric: tabular-nums;
  }

  .thinking-body {
    margin-top: 6px;
    padding: 6px 10px;
    border-left: 2px solid $border-light;
    font-size: 13px;
    opacity: 0.85;
    font-style: italic;

    :deep(p) { margin: 0.3em 0; }
  }
}
```

- [ ] **Step 11.4: Type-check + build**

Run: `npx vue-tsc -b --noEmit`
Expected: 通过

Run: `npm run test -- --run`
Expected: 全部通过

- [ ] **Step 11.5: 提交**

```bash
git add packages/client/src/components/hermes/chat/MessageItem.vue
git commit -m "feat(chat): MessageItem 渲染 thinking 折叠区

- 复用 tool-line 风格 chevron
- 两条响应链：parse computed + duration interval
- 流式+pending 强制展开
- show_reasoning 控制默认态

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 12: 完整构建 + 手动验证 + 推送

- [ ] **Step 12.1: 完整 build**

Run: `npm run build`
Expected: 构建通过，无 type 错误

- [ ] **Step 12.2: 完整测试**

Run: `npm run test -- --run`
Expected: 全部通过

- [ ] **Step 12.3: 手动验证清单（需用户配合）**

启动 dev 服务器（`npm run dev`）后逐项检查：

1. 用 DeepSeek R1 / GLM reasoner 等输出 `<think>...</think>` 的模型发起对话
2. **流式中**：thinking 区展开实时滚动
3. **完成后**：按 `show_reasoning` 设置决定默认折叠；header 显示 `💭 思考过程 · 已观察 Xs · Y 字`
4. **设置切换**：Display Settings → `show_reasoning` 开/关 → 新消息与刷新后应遵循
5. **手动展开/收起**：点击 chevron；刷新后回默认
6. **代码块保护**：让模型输出 "`<think>` 标签用法示例" 并包含 code block → code block 内 `<think>` **不被识别**
7. **老消息**：加载升级前的老会话（若有） → thinking 正确识别（只显示字数）
8. **切会话**：切到另一会话再回 → 耗时消息消失（observation 已清）

- [ ] **Step 12.4: 推送分支**

```bash
git push -u origin feat/thinking-block-collapse
```

---

## 自我检查清单（Plan Self-Review）

- [x] Spec §4 识别规则 → Tasks 1-5
- [x] Spec §5.3 运行时 Map → Tasks 8-9
- [x] Spec §6.3 默认展开逻辑 → Task 11
- [x] Spec §6.4 两条响应链 → Task 11
- [x] Spec §6.5 终止态降级 → Task 3 测试 + parser 实现
- [x] Spec §6.6 i18n → Task 10
- [x] Spec §8 测试策略 → Tasks 1-9
- [x] Spec §9 兼容性 → Task 12.3 #7

**实施完成标准**：所有 Tasks checkbox 勾选；`npm run build` 与 `npm run test -- --run` 全绿；分支推送。

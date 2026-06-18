/**
 * Chat Context Compressor
 *
 * Compresses 1:1 chat conversation history before sending to upstream.
 * Uses the Hermes structured summary prompt for LLM-based compression.
 *
 * Algorithm:
 * 1. If total tokens < trigger threshold → return as-is
 * 2. Pre-clean: truncate old tool results (no LLM call)
 * 3. Load snapshot from SQLite for incremental update
 * 4. Keep last 10 messages verbatim (tail protection by message count)
 * 5. Summarize everything before the tail
 * 6. Save snapshot: last_message_index = index where compression ends
 */

import { encodingForModel, getEncoding } from 'js-tiktoken'
import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { logger } from '../../services/logger'
import { AgentBridgeClient, type AgentBridgeRunResult } from '../../services/hermes/agent-bridge'
import {
  getCompressionSnapshot,
  saveCompressionSnapshot,
  deleteCompressionSnapshot,
} from '../../db/hermes/compression-snapshot'

// ─── Types ───────────────────────────────────────────────

export interface ContentBlock {
  type: 'text' | 'image' | 'file'
  text?: string
  path?: string
  source?: { type: string; media_type?: string; data?: string }
}

export interface ChatMessage {
  role: string
  content: string | ContentBlock[]
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
  reasoning_content?: string | null
}

export interface CompressionConfig {
  /** Token threshold to trigger compression (default: contextLength / 2) */
  triggerTokens: number
  /** Summary token target (default: 8000) */
  summaryBudget: number
  /** Number of earliest messages to keep verbatim (default: 0) */
  headMessageCount: number
  /** Number of recent messages to keep verbatim (default: 10) */
  tailMessageCount: number
  /** Timeout for LLM summarization call (default: 300_000ms) */
  summarizationTimeoutMs: number
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  triggerTokens: 100_000,
  summaryBudget: 8_000,
  headMessageCount: 0,
  tailMessageCount: 10,
  summarizationTimeoutMs: 300_000,
}

export interface CompressedResult {
  messages: ChatMessage[]
  meta: {
    totalMessages: number
    compressed: boolean
    /** true = actually called LLM to summarize; false = assembled from existing snapshot or returned as-is */
    llmCompressed: boolean
    summaryTokenEstimate: number
    verbatimCount: number
    compressedStartIndex: number
  }
}

export interface SummarizerOptions {
  profile?: string
  model?: string | null
  provider?: string | null
  workerKey?: string
}

const SUMMARIZER_TRIGGER_MESSAGE = 'Generate the context checkpoint summary now.'
const SUMMARIZER_DEBUG_DIR = 'logs/context-compressor'
const SUMMARIZER_DEBUG_FILE = 'summarizer-debug.json'

async function writeSummarizerDebugDump(payload: Record<string, unknown>): Promise<void> {
  if (process.env.NODE_ENV !== 'development') return
  try {
    const debugDir = resolve(process.cwd(), SUMMARIZER_DEBUG_DIR)
    await mkdir(debugDir, { recursive: true })
    await writeFile(
      resolve(debugDir, SUMMARIZER_DEBUG_FILE),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8',
    )
  } catch (err) {
    logger.warn(err, '[context-compressor] failed to write summarizer debug dump')
  }
}

// ─── Token counting ─────────────────────────────────────

let _encoder: ReturnType<typeof getEncoding> | null = null

function getEncoder() {
  if (!_encoder) {
    _encoder = getEncoding('cl100k_base')
  }
  return _encoder
}

// js-tiktoken's BPE merge loop is O(n²) over the bytes of a single
// pre-tokenizer "piece". The GPT pat_str groups contiguous \p{L} characters
// into one piece, and CJK text has no spaces, so a long CJK run becomes a
// single huge piece (e.g. 14k chars → 42k bytes → ~1.8B ops) that pins the
// event loop at 100% CPU and never returns — encode() doesn't throw, it just
// hangs, so the catch-based heuristic fallback never fires. Detect that
// pathological case up front and use the cheap heuristic instead. Normal text
// (even very long, but space-separated) keeps the exact tiktoken path.
const MAX_LETTER_RUN = 2000

function hasPathologicalRun(text: string): boolean {
  let maxRun = 0
  let run = 0
  for (let i = 0; i < text.length; i++) {
    const cc = text.charCodeAt(i)
    // ASCII letters or anything at/above CJK/extended ranges (>0x2e7f)
    if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc > 0x2e7f) {
      if (++run > maxRun) maxRun = run
      if (maxRun > MAX_LETTER_RUN) return true
    } else {
      run = 0
    }
  }
  return false
}

function heuristicTokens(text: string): number {
  const cjk = (text.match(/[\u2e80-\u9fff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk * 1.5 + other / 4)
}

export function countTokens(text: string): number {
  if (hasPathologicalRun(text)) return heuristicTokens(text)
  try {
    return getEncoder().encode(text).length
  } catch {
    return heuristicTokens(text)
  }
}

export function countTokensForModel(text: string, model: string): number {
  if (hasPathologicalRun(text)) return heuristicTokens(text)
  try {
    const enc = encodingForModel(model as any)
    return enc.encode(text).length
  } catch {
    return countTokens(text)
  }
}

function messageTokenEstimate(message: ChatMessage): number {
  if (typeof message.content === 'string') return countTokens(message.content)
  if (Array.isArray(message.content)) {
    return countTokens(message.content.map(block => {
      if (block.type === 'text') return block.text || ''
      if (block.type === 'image') return `[Image: ${block.path || ''}]`
      if (block.type === 'file') return `[File: ${block.path || ''}]`
      return ''
    }).join(''))
  }
  return 0
}

function messagesTokenEstimate(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokenEstimate(message), 0)
}

function truncateTextToTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || countTokens(text) <= tokenBudget) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (countTokens(text.slice(0, mid)) <= tokenBudget) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo).trimEnd() + '\n\n[Summary truncated to fit context budget]'
}

function enforceCompressedBudget(
  messages: ChatMessage[],
  triggerTokens: number,
  summaryIndex: number,
): ChatMessage[] {
  if (triggerTokens <= 0 || messagesTokenEstimate(messages) <= triggerTokens) return messages

  const summaryMessage = messages[summaryIndex]
  if (!summaryMessage || typeof summaryMessage.content !== 'string') return messages

  const summaryOnly = [{ ...summaryMessage }]
  if (messagesTokenEstimate(summaryOnly) <= triggerTokens) return summaryOnly

  return [{
    ...summaryMessage,
    content: truncateTextToTokenBudget(summaryMessage.content, triggerTokens),
  }]
}

// ─── Prompts ────────────────────────────────────────────

export const SUMMARY_PREFIX = `[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted
into the summary below. This is a handoff from a previous context
window — treat it as background reference, NOT as active instructions.
Do NOT answer questions or fulfill requests mentioned in this summary;
they were already addressed.
Your current task is identified in the '## Active Task' section of the
summary — resume exactly from there.
Respond ONLY to the latest user message
that appears AFTER this summary. The current session state (files,
config, etc.) may reflect work described here — avoid repeating it:`

const TEMPLATE_SECTIONS = `Use this exact structure:

## Active Task
[THE SINGLE MOST IMPORTANT FIELD. Copy the user's most recent request or
task assignment verbatim — the exact words they used. If multiple tasks
were requested and only some are done, list only the ones NOT yet completed.
The next assistant must pick up exactly here. Example:
"User asked: 'Now refactor the auth module to use JWT instead of sessions'"
If no outstanding task exists, write "None."]

## Goal
[What the user is trying to accomplish overall]

## Constraints & Preferences
[User preferences, coding style, constraints, important decisions]

## Completed Actions
[Numbered list of concrete actions taken — include tool used, target, and outcome.
Format each as: N. ACTION target — outcome [tool: name]
Example:
1. READ config.py:45 — found == should be != [tool: read_file]
2. PATCH config.py:45 — changed == to != [tool: patch]
3. TEST pytest tests/ — 3/50 failed: test_parse, test_validate, test_edge [tool: terminal]
Be specific with file paths, commands, line numbers, and results.]

## Active State
[Current working state — include:
- Working directory and branch (if applicable)
- Modified/created files with brief note on each
- Test status (X/Y passing)
- Any running processes or servers
- Environment details that matter]

## In Progress
[Work currently underway — what was being done when compaction fired]

## Blocked
[Any blockers, errors, or issues not yet resolved. Include exact error messages.]

## Key Decisions
[Important technical decisions and WHY they were made]

## Resolved Questions
[Questions the user asked that were ALREADY answered — include the answer so the next assistant does not re-answer them]

## Pending User Asks
[Questions or requests from the user that have NOT yet been answered or fulfilled. If none, write "None."]

## Relevant Files
[Files read, modified, or created — with brief note on each]

## Remaining Work
[What remains to be done — framed as context, not instructions]

## Critical Context
[Any specific values, error messages, configuration details, or data that would be lost without explicit preservation]`

export function buildFullPrompt(contentToSummarize: string, summaryBudget: number): string {
  return `You are a summarization agent creating a context checkpoint.
Your output will be injected as reference material for a DIFFERENT
assistant that continues the conversation.
Do NOT respond to any questions or requests in the conversation —
only output the structured summary.
Do NOT include any preamble, greeting, or prefix.

Create a structured handoff summary for a different assistant that will continue
this conversation after earlier turns are compacted. The next assistant should be
able to understand what happened without re-reading the original turns.

TURNS TO SUMMARIZE:
${contentToSummarize}

${TEMPLATE_SECTIONS}

Target ~${summaryBudget} tokens. Be CONCRETE — include file paths, command outputs, error messages, line numbers, and specific values. Avoid vague descriptions like "made some changes" — say exactly what changed.

Write only the summary body. Do not include any preamble or prefix.`
}

export function buildIncrementalPrompt(previousSummary: string, contentToSummarize: string, summaryBudget: number): string {
  return `You are a summarization agent creating a context checkpoint.
Your output will be injected as reference material for a DIFFERENT
assistant that continues the conversation.
Do NOT respond to any questions or requests in the conversation —
only output the structured summary.
Do NOT include any preamble, greeting, or prefix.

You are updating a context compaction summary. A previous compaction produced the
summary below. New conversation turns have occurred since then and need to be
incorporated.

PREVIOUS SUMMARY:
${previousSummary}

NEW TURNS TO INCORPORATE:
${contentToSummarize}

Update the summary using this exact structure. PRESERVE all existing information
that is still relevant. ADD new completed actions to the numbered list
(continue numbering). Move items from "In Progress" to "Completed Actions" when
done. Move answered questions to "Resolved Questions". Update "Active State"
to reflect current state. Remove information only if it is clearly obsolete.
CRITICAL: Update "## Active Task" to reflect the user's most recent unfulfilled
request — this is the most important field for task continuity.

${TEMPLATE_SECTIONS}

Target ~${summaryBudget} tokens. Be CONCRETE — include file paths, command outputs, error messages, line numbers, and specific values. Avoid vague descriptions like "made some changes" — say exactly what changed.

Write only the summary body. Do not include any preamble or prefix.`
}

// ─── Pre-cleaning ───────────────────────────────────────

export function serializeForSummary(messages: ChatMessage[]): string {
  const parts: string[] = []

  function contentToString(content: string | ContentBlock[]): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map(block => {
        if (block.type === 'text') return block.text || ''
        if (block.type === 'image') return `[Image: ${block.path || ''}]`
        if (block.type === 'file') return `[File: ${block.path || ''}]`
        return ''
      }).join('')
    }
    return ''
  }

  for (const msg of messages) {
    const role = msg.role === 'tool' ? `[tool:${msg.name || 'unknown'}]` : msg.role
    let content = contentToString(msg.content || '')

    if (msg.role === 'tool' && content.length > 5500) {
      content = content.slice(0, 4000) + '\n... [truncated]\n...' + content.slice(-1500)
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const toolsInfo = msg.tool_calls.map(tc => {
        let args = tc.function.arguments
        if (args.length > 1500) args = args.slice(0, 1500) + '...'
        return `[tool_call: ${tc.function.name}(${args})]`
      }).join('\n')
      parts.push(`${role}: ${toolsInfo}`)
      if (content.trim()) parts.push(`${role}: ${content}`)
    } else {
      parts.push(`${role}: ${content}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * Convert messages to conversation history format for LLM API.
 * Tool calls are converted to text format within assistant messages.
 */
export function buildConversationHistory(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = []

  for (const msg of messages) {
    if (msg.role === 'tool') {
      // Convert tool result to text and append to previous assistant message
      const toolText = `[Tool result: ${msg.name || 'unknown'}]\n${(msg.content || '').slice(0, 4000)}${msg.content && msg.content.length > 4000 ? '...' : ''}`
      // Find the last assistant message and append to it
      const lastAssistant = result.findLast(m => m.role === 'assistant')
      if (lastAssistant) {
        lastAssistant.content += `\n\n${toolText}`
      } else {
        // Fallback: create an assistant message
        result.push({ role: 'assistant', content: toolText })
      }
    } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // Include tool calls in assistant message
      const toolsInfo = msg.tool_calls.map(tc => {
        let args = tc.function.arguments
        if (args.length > 4000) args = args.slice(0, 4000) + '...'
        return `[Calling tool: ${tc.function.name} with arguments: ${args}]`
      }).join('\n')
      const content = msg.content ? `${msg.content}\n\n${toolsInfo}` : toolsInfo
      result.push({ role: msg.role, content })
    } else if (msg.role === 'user') {
      // Handle ContentBlock[] format: { type: 'text', text: '...' } or { type: 'image', path: '...' }
      let contentStr = ''
      const content = msg.content || ''
      if (typeof content === 'string') {
        contentStr = content
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            contentStr += block.text || ''
          } else if (block.type === 'image') {
            contentStr += `[Image: ${block.path || ''}]`
          } else if (block.type === 'file') {
            contentStr += `[File: ${block.path || ''}]`
          }
        }
      }
      if (contentStr.length > 4000) contentStr = contentStr.slice(0, 4000) + '...'
      result.push({ role: 'user', content: contentStr })
    } else if (msg.role === 'assistant' || msg.role === 'system') {
      let contentStr = ''
      const content = msg.content
      if (typeof content === 'string') {
        contentStr = content
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            contentStr += block.text || ''
          } else if (block.type === 'image') {
            contentStr += `[Image: ${block.path || ''}]`
          } else if (block.type === 'file') {
            contentStr += `[File: ${block.path || ''}]`
          }
        }
      }
      if (contentStr.length > 4000) contentStr = contentStr.slice(0, 4000) + '...'
      result.push({ role: msg.role, content: contentStr })
    }
    // Skip other roles
  }

  return result
}

export function pruneOldToolResults(messages: ChatMessage[], keepRecentCount: number): ChatMessage[] {
  if (messages.length <= keepRecentCount) return messages

  const tail = messages.slice(-keepRecentCount)
  const head = messages.slice(0, -keepRecentCount)

  const pruned = head.map(msg => {
    if (msg.role !== 'tool') return msg
    let content = ''
    if (typeof msg.content === 'string') {
      content = msg.content
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map(block => {
        if (block.type === 'text') return block.text || ''
        return `[${block.type}]`
      }).join('')
    }
    const preview = content.slice(0, 100).replace(/\n/g, ' ')
    const truncated = content.length > 100 ? '...' : ''
    return { ...msg, content: `[${msg.name || 'tool'}] ${preview}${truncated}` }
  })

  return [...pruned, ...tail]
}

function pruneFallbackToolResults(messages: ChatMessage[], keepRecentCount: number): ChatMessage[] {
  return pruneOldToolResults(messages, keepRecentCount)
}

// ─── LLM Summarization ──────────────────────────────────

export async function callSummarizer(
  upstream: string,
  apiKey: string | undefined,
  prompt: string,
  history: Array<{ role: string; content: string }>,
  timeoutMs: number,
  previousSummary?: string,
  summarizer?: string | SummarizerOptions,
): Promise<string> {
  void upstream
  void apiKey
  const options: SummarizerOptions = typeof summarizer === 'string'
    ? { profile: summarizer }
    : summarizer || {}
  const profile = options.profile || 'default'
  void history
  const convHistory: Array<{ role: string; content: string }> = []

  if (previousSummary) {
    convHistory.unshift(
      { role: 'user', content: `[Previous summary]\n${previousSummary}` },
      { role: 'assistant', content: 'Understood, I will update the summary.' },
      { role: 'user', content: prompt },
    )
  } else {
    convHistory.unshift({ role: 'user', content: prompt })
  }

  const bridge = new AgentBridgeClient({ timeoutMs: timeoutMs + 15_000 })
  const sessionId = `compress_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const workerKey = options.workerKey || `${profile}:compression:${sessionId}`
  const message = SUMMARIZER_TRIGGER_MESSAGE

  await writeSummarizerDebugDump({
    writtenAt: new Date().toISOString(),
    sessionId,
    workerKey,
    profile,
    model: options.model || null,
    provider: options.provider || null,
    message,
    convHistory,
  })

  try {
    const result = await bridge.request<AgentBridgeRunResult>({
      action: 'chat',
      session_id: sessionId,
      message,
      conversation_history: convHistory,
      profile,
      worker_key: workerKey,
      source: 'api_server',
      wait: true,
      timeout: Math.ceil(timeoutMs / 1000),
      ...(options.model ? { model: options.model } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
    }, { timeoutMs: timeoutMs + 15_000 })

    if (result.status === 'error') {
      throw new Error(result.error || 'Summarization bridge run failed')
    }

    const payload = result.result as any
    const output = String(
      payload?.final_response ||
      result.output ||
      '',
    ).trim()
    if (!output) throw new Error('Empty summarization response')
    return output
  } finally {
    await bridge.destroy(sessionId, profile, workerKey).catch(() => undefined)
  }
}

// ─── Main Compressor ────────────────────────────────────

export class ChatContextCompressor {
  private config: CompressionConfig

  constructor(opts?: {
    config?: Partial<CompressionConfig>
  }) {
    this.config = { ...DEFAULT_COMPRESSION_CONFIG, ...opts?.config }
  }

  /**
   * Assemble and compress conversation history.
   *
   * Flow:
   * 1. Check snapshot → if exists, assemble = summary + new messages after snapshot index
   * 2. If no snapshot → assemble = all messages
   * 3. Count tokens of assembled context
   * 4. Under threshold → return assembled as-is (no LLM call)
   * 5. Over threshold → LLM compress, keep last N messages, save new snapshot
   */
  async compress(
    messages: ChatMessage[],
    upstream: string,
    apiKey: string | undefined,
    sessionId?: string,
    summarizer?: string | SummarizerOptions,
  ): Promise<CompressedResult> {
    const total = messages.length

    const makeMeta = (opts: Partial<CompressedResult['meta']> = {}): CompressedResult['meta'] => ({
      totalMessages: total,
      compressed: false,
      llmCompressed: false,
      summaryTokenEstimate: 0,
      verbatimCount: total,
      compressedStartIndex: -1,
      ...opts,
    })

    // Check if we have a previous compression snapshot
    const snapshot = sessionId ? getCompressionSnapshot(sessionId) : null

    if (snapshot && snapshot.lastMessageIndex >= 0 && snapshot.lastMessageIndex < messages.length) {
      // Has snapshot → incremental compress (merge old summary with new messages)
      logger.info(
        '[context-compressor] session=%s: incremental compress with snapshot at index %d',
        sessionId, snapshot.lastMessageIndex,
      )
      return this.incrementalCompress(
        messages, snapshot, upstream, apiKey, sessionId!, makeMeta(), summarizer,
      )
    } else {
      if (snapshot && sessionId) {
        const fallbackLastMessageIndex = Math.max(-1, messages.length - this.config.tailMessageCount - 1)
        logger.warn(
          '[context-compressor] session=%s: stale snapshot index %d for %d messages; using summary plus tail from index %d',
          sessionId, snapshot.lastMessageIndex, messages.length, fallbackLastMessageIndex,
        )
        return this.incrementalCompress(
          messages,
          { summary: snapshot.summary, lastMessageIndex: fallbackLastMessageIndex },
          upstream,
          apiKey,
          sessionId,
          makeMeta(),
          summarizer,
        )
      }
      // No snapshot → full compress (compress all messages)
      logger.info(
        '[context-compressor] session=%s: full compress %d messages',
        sessionId, total,
      )
      return this.fullCompress(messages, upstream, apiKey, sessionId!, makeMeta(), summarizer)
    }
  }

  private async incrementalCompress(
    messages: ChatMessage[],
    snapshot: { summary: string; lastMessageIndex: number },
    upstream: string,
    apiKey: string | undefined,
    sessionId: string,
    meta: CompressedResult['meta'],
    summarizer?: string | SummarizerOptions,
  ): Promise<CompressedResult> {
    const { summary: previousSummary, lastMessageIndex } = snapshot
    const total = messages.length
    const headCount = Math.min(this.config.headMessageCount, Math.max(0, lastMessageIndex + 1))
    const head = messages.slice(0, headCount)
    const newMessages = messages.slice(lastMessageIndex + 1)
    const tailCount = this.config.tailMessageCount
    const previousSummaryMessage: ChatMessage = { role: 'user', content: SUMMARY_PREFIX + '\n\n' + previousSummary }
    const assembledWithPrevious = [
      ...head,
      previousSummaryMessage,
      ...newMessages,
    ]
    const assembledOverBudget = messagesTokenEstimate(assembledWithPrevious) > this.config.triggerTokens
    const canKeepTailWindow = newMessages.length > tailCount

    // If the new segment itself is too small to split but already over budget,
    // fold all new messages into the existing summary instead of preserving them verbatim.
    const tailStart = assembledOverBudget && !canKeepTailWindow
      ? newMessages.length
      : Math.max(0, newMessages.length - tailCount)
    const toCompress = newMessages.slice(0, tailStart)
    const tail = newMessages.slice(tailStart)

    if (toCompress.length === 0) {
      return {
        messages: assembledWithPrevious,
        meta: {
          ...meta,
          compressed: true,
          llmCompressed: false,
          summaryTokenEstimate: countTokens(SUMMARY_PREFIX + previousSummary),
          verbatimCount: head.length + newMessages.length,
          compressedStartIndex: lastMessageIndex,
        },
      }
    }

    logger.info(
      '[context-compressor] [incremental-llm] compressing %d of %d new messages, keeping %d tail',
      toCompress.length, newMessages.length, tail.length,
    )

    let summary: string | null = null
    try {
      const contentToSummarize = serializeForSummary(toCompress)
      const prompt = buildIncrementalPrompt(previousSummary, contentToSummarize, this.config.summaryBudget)

      const t0 = Date.now()
      summary = await callSummarizer(upstream, apiKey, prompt, [], this.config.summarizationTimeoutMs, previousSummary, summarizer)
      logger.info('[context-compressor] incremental-llm done in %dms, %d chars', Date.now() - t0, summary.length)
    } catch (err: any) {
      logger.warn('[context-compressor] incremental-llm failed: %s — keeping new messages verbatim', err.message)
      const fallback = [
        ...head,
        previousSummaryMessage,
        ...newMessages,
      ]
      const prunedFallback = pruneFallbackToolResults(fallback, this.config.tailMessageCount)
      const budgetedFallback = enforceCompressedBudget(prunedFallback, this.config.triggerTokens, head.length)
      return {
        messages: budgetedFallback,
        meta: {
          ...meta,
          compressed: true,
          llmCompressed: false,
          summaryTokenEstimate: countTokens(SUMMARY_PREFIX + previousSummary),
          verbatimCount: budgetedFallback.length === fallback.length ? head.length + newMessages.length : 0,
          compressedStartIndex: lastMessageIndex,
        },
      }
    }

    let result: ChatMessage[] = [
      ...head,
      { role: 'user', content: SUMMARY_PREFIX + '\n\n' + summary },
      ...tail,
    ]
    result = enforceCompressedBudget(result, this.config.triggerTokens, head.length)

    const newLastIndex = lastMessageIndex + tailStart
    if (sessionId) {
      saveCompressionSnapshot(sessionId, summary, newLastIndex, total)
    }

    return {
      messages: result,
      meta: {
        ...meta,
        compressed: true,
        llmCompressed: true,
        summaryTokenEstimate: countTokens(SUMMARY_PREFIX + summary),
        verbatimCount: result.length === head.length + 1 + tail.length ? head.length + tail.length : 0,
        compressedStartIndex: newLastIndex,
      },
    }
  }

  private async fullCompress(
    messages: ChatMessage[],
    upstream: string,
    apiKey: string | undefined,
    sessionId: string,
    meta: CompressedResult['meta'],
    summarizer?: string | SummarizerOptions,
  ): Promise<CompressedResult> {
    const total = messages.length
    const requestedHeadCount = Math.min(this.config.headMessageCount, total)
    const requestedTailCount = this.config.tailMessageCount
    const canKeepProtectedWindows = total > requestedHeadCount + requestedTailCount
    const headCount = canKeepProtectedWindows ? requestedHeadCount : 0
    const tailCount = canKeepProtectedWindows ? requestedTailCount : 0

    const tailStart = total - tailCount
    const head = messages.slice(0, headCount)
    const toCompress = messages.slice(headCount, tailStart)
    const tail = messages.slice(tailStart)

    logger.info(
      '[context-compressor] [full-llm] compressing messages %d-%d, keeping first %d and last %d',
      headCount, tailStart - 1, head.length, tail.length,
    )

    const contentToSummarize = serializeForSummary(toCompress)
    const prompt = buildFullPrompt(contentToSummarize, this.config.summaryBudget)

    let summary: string | null = null
    try {
      const t0 = Date.now()
      summary = await callSummarizer(upstream, apiKey, prompt, [], this.config.summarizationTimeoutMs, undefined, summarizer)
      logger.info('[context-compressor] full-llm done in %dms, %d chars', Date.now() - t0, summary.length)
    } catch (err: any) {
      logger.warn('[context-compressor] full-llm failed: %s', err.message)
    }

    if (!summary) {
      return { messages: pruneFallbackToolResults(messages, this.config.tailMessageCount), meta }
    }

    const result: ChatMessage[] = []

    result.push(...head)
    result.push({ role: 'user', content: SUMMARY_PREFIX + '\n\n' + summary })
    if (sessionId) {
      saveCompressionSnapshot(sessionId, summary, tailStart - 1, total)
    }

    result.push(...tail)
    const budgetedResult = enforceCompressedBudget(result, this.config.triggerTokens, head.length)

    return {
      messages: budgetedResult,
      meta: {
        ...meta,
        compressed: true,
        llmCompressed: !!summary,
        summaryTokenEstimate: summary ? countTokens(SUMMARY_PREFIX + summary) : 0,
        verbatimCount: budgetedResult.length === result.length ? head.length + tail.length : 0,
        compressedStartIndex: tailStart - 1,
      },
    }
  }

  /** Remove snapshot for a session (e.g. when session is deleted) */
  static invalidateSnapshot(sessionId: string): void {
    deleteCompressionSnapshot(sessionId)
  }
}

async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const frame = parseSseFrame(raw)
        if (frame?.data) yield frame
        boundary = buffer.indexOf('\n\n')
      }
    }

    buffer += decoder.decode()
    const frame = parseSseFrame(buffer)
    if (frame?.data) yield frame
  } finally {
    reader.releaseLock()
  }
}

function parseSseFrame(raw: string): { event?: string; data: string } | null {
  let event: string | undefined
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart())
    }
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

function extractResponseText(response: any): string {
  const output = Array.isArray(response?.output) ? response.output : []
  const parts: string[] = []
  for (const item of output) {
    if (item.type !== 'message') continue
    const content = Array.isArray(item.content) ? item.content : []
    for (const part of content) {
      if (part.type === 'output_text' || part.type === 'text') {
        parts.push(part.text || '')
      }
    }
  }
  if (parts.length > 0) return parts.join('')
  return typeof response?.output_text === 'string' ? response.output_text : ''
}

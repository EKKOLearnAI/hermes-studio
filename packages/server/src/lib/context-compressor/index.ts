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
 * 4. Keep last 20 messages verbatim (tail protection by message count)
 * 5. Summarize everything before the tail
 * 6. Save snapshot: last_message_index = index where compression ends
 */

import { EventSource } from 'eventsource'
import { encodingForModel, getEncoding } from 'js-tiktoken'
import { logger } from '../../services/logger'
import {
  getCompressionSnapshot,
  saveCompressionSnapshot,
  deleteCompressionSnapshot,
} from '../../db/hermes/compression-snapshot'
import { getDb } from '../../db/index'

// ─── Types ───────────────────────────────────────────────

export interface ChatMessage {
  role: string
  content: string
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
  /** Number of recent messages to keep verbatim (default: 20) */
  tailMessageCount: number
  /** Timeout for LLM summarization call (default: 60_000ms) */
  summarizationTimeoutMs: number
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  triggerTokens: 100_000,
  summaryBudget: 8_000,
  tailMessageCount: 20,
  summarizationTimeoutMs: 120_000,
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

// ─── Token counting ─────────────────────────────────────

let _encoder: ReturnType<typeof getEncoding> | null = null

function getEncoder() {
  if (!_encoder) {
    _encoder = getEncoding('cl100k_base')
  }
  return _encoder
}

export function countTokens(text: string): number {
  try {
    return getEncoder().encode(text).length
  } catch {
    const cjk = (text.match(/[\u2e80-\u9fff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g) || []).length
    const other = text.length - cjk
    return Math.ceil(cjk * 1.5 + other / 4)
  }
}

export function countTokensForModel(text: string, model: string): number {
  try {
    const enc = encodingForModel(model as any)
    return enc.encode(text).length
  } catch {
    return countTokens(text)
  }
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

function buildFullPrompt(contentToSummarize: string, summaryBudget: number): string {
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

function buildIncrementalPrompt(previousSummary: string, contentToSummarize: string, summaryBudget: number): string {
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

function serializeForSummary(messages: ChatMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    const role = msg.role === 'tool' ? `[tool:${msg.name || 'unknown'}]` : msg.role
    let content = msg.content || ''

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
function buildConversationHistory(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = []

  for (const msg of messages) {
    if (msg.role === 'tool') {
      // Convert tool result to text and append to previous assistant message
      const toolText = `[Tool result: ${msg.name || 'unknown'}]\n${(msg.content || '').slice(0, 500)}${msg.content && msg.content.length > 500 ? '...' : ''}`
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
        if (args.length > 1000) args = args.slice(0, 1000) + '...'
        return `[Calling tool: ${tc.function.name} with arguments: ${args}]`
      }).join('\n')
      const content = msg.content ? `${msg.content}\n\n${toolsInfo}` : toolsInfo
      result.push({ role: msg.role, content })
    } else if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') {
      result.push({ role: msg.role, content: msg.content || '' })
    }
    // Skip other roles
  }

  return result
}

function pruneOldToolResults(messages: ChatMessage[], keepRecentCount: number): ChatMessage[] {
  if (messages.length <= keepRecentCount) return messages

  const tail = messages.slice(-keepRecentCount)
  const head = messages.slice(0, -keepRecentCount)

  const pruned = head.map(msg => {
    if (msg.role !== 'tool') return msg
    const content = msg.content || ''
    const preview = content.slice(0, 100).replace(/\n/g, ' ')
    const truncated = content.length > 100 ? '...' : ''
    return { ...msg, content: `[${msg.name || 'tool'}] ${preview}${truncated}` }
  })

  return [...pruned, ...tail]
}

// ─── LLM Summarization ──────────────────────────────────

async function callSummarizer(
  upstream: string,
  apiKey: string | undefined,
  prompt: string,
  history: Array<{ role: string; content: string }>,
  timeoutMs: number,
  previousSummary?: string,
  profile?: string,
): Promise<string> {
  const sessionId = `compress_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  const convHistory: Array<{ role: string; content: string }> = [...history]

  if (previousSummary) {
    convHistory.unshift(
      { role: 'user', content: `[Previous summary]\n${previousSummary}` },
      { role: 'assistant', content: 'Understood, I will update the summary.' },
    )
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const res = await fetch(`${upstream}/v1/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      input: prompt,
      conversation_history: convHistory,
      session_id: sessionId,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) {
    throw new Error(`Summarization run failed: ${res.status}`)
  }

  const { run_id } = await res.json() as { run_id: string }

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      source.close()
      reject(new Error('Summarization timed out'))
    }, timeoutMs)

    const eventsUrl = new URL(`${upstream}/v1/runs/${run_id}/events`)

    // Use Authorization header instead of query parameter for better compatibility
    const eventSourceInit: any = apiKey ? {
      fetch: (url: string, init: any = {}) => fetch(url, {
        ...init,
        headers: {
          ...(init.headers || {}),
          Authorization: `Bearer ${apiKey}`,
        },
      }),
    } : {}

    // @ts-ignore - eventsource library types are too strict
    const source = new EventSource(eventsUrl.toString(), eventSourceInit)

    source.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data)
        if (parsed.event === 'run.completed') {
          clearTimeout(timer)
          source.close()
          deleteCompressSession(sessionId, profile).catch(() => { })
          const output = parsed.output
          if (!output || typeof output !== 'string' || output.trim() === '') {
            reject(new Error('Empty summarization response'))
            return
          }
          resolve(output.trim())
        } else if (parsed.event === 'run.failed') {
          clearTimeout(timer)
          source.close()
          deleteCompressSession(sessionId, profile).catch(() => { })
          reject(new Error(parsed.error || 'Summarization run failed'))
        }
      } catch { /* ignore parse errors */ }
    }

    source.onerror = () => {
      clearTimeout(timer)
      source.close()
      deleteCompressSession(sessionId, profile).catch(() => { })
      reject(new Error('Summarization SSE connection error'))
    }
  })
}

/** Enqueue compression session for later deletion instead of deleting immediately */
async function deleteCompressSession(sessionId: string, profile?: string): Promise<void> {
  try {
    const db = getDb()
    if (!db) return
    const now = Date.now()
    db.prepare(
      `INSERT INTO gc_pending_session_deletes (session_id, profile_name, status, attempt_count, last_error, created_at, updated_at, next_attempt_at)
       VALUES (?, ?, 'pending', 0, NULL, ?, ?, 0)
       ON CONFLICT(session_id) DO NOTHING`,
    ).run(sessionId, profile || 'default', now, now)
  } catch { /* best-effort */ }
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
    profile?: string,
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

    if (snapshot) {
      // Has snapshot → incremental compress (merge old summary with new messages)
      logger.info(
        '[context-compressor] session=%s: incremental compress with snapshot at index %d',
        sessionId, snapshot.lastMessageIndex,
      )
      return this.incrementalCompress(
        messages, snapshot, upstream, apiKey, sessionId!, makeMeta(), profile,
      )
    } else {
      // No snapshot → full compress (compress all messages)
      logger.info(
        '[context-compressor] session=%s: full compress %d messages',
        sessionId, total,
      )
      return this.fullCompress(messages, upstream, apiKey, sessionId!, makeMeta(), profile)
    }
  }

  private async incrementalCompress(
    messages: ChatMessage[],
    snapshot: { summary: string; lastMessageIndex: number },
    upstream: string,
    apiKey: string | undefined,
    sessionId: string,
    meta: CompressedResult['meta'],
    profile?: string,
  ): Promise<CompressedResult> {
    const { summary: previousSummary, lastMessageIndex } = snapshot
    const total = messages.length
    const cleaned = pruneOldToolResults(messages, this.config.tailMessageCount)
    const newMessages = cleaned.slice(lastMessageIndex + 1)
    const tailCount = this.config.tailMessageCount

    // Keep last N of new messages, compress the rest
    const tailStart = Math.max(0, newMessages.length - tailCount)
    const toCompress = newMessages.slice(0, tailStart)
    const tail = newMessages.slice(tailStart)

    logger.info(
      '[context-compressor] [incremental-llm] compressing %d of %d new messages, keeping %d tail',
      toCompress.length, newMessages.length, tail.length,
    )

    let summary: string | null = null
    try {
      const contentToSummarize = serializeForSummary(toCompress)
      const prompt = buildIncrementalPrompt(previousSummary, contentToSummarize, this.config.summaryBudget)
      const history = buildConversationHistory(toCompress)

      const t0 = Date.now()
      summary = await callSummarizer(upstream, apiKey, prompt, history, this.config.summarizationTimeoutMs, previousSummary, profile)
      logger.info('[context-compressor] incremental-llm done in %dms, %d chars', Date.now() - t0, summary.length)
    } catch (err: any) {
      logger.warn('[context-compressor] incremental-llm failed: %s — reusing previous summary', err.message)
      summary = previousSummary
    }

    const result: ChatMessage[] = [
      { role: 'system', content: SUMMARY_PREFIX + '\n\n' + summary },
      ...tail,
    ]

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
        verbatimCount: tail.length,
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
    profile?: string,
  ): Promise<CompressedResult> {
    const total = messages.length
    const cleaned = pruneOldToolResults(messages, this.config.tailMessageCount)
    const tailCount = this.config.tailMessageCount

    if (total <= tailCount) {
      return { messages: cleaned, meta }
    }

    const tailStart = total - tailCount
    const toCompress = cleaned.slice(0, tailStart)
    const tail = cleaned.slice(tailStart)

    logger.info(
      '[context-compressor] [full-llm] compressing messages 0-%d, keeping %d-%d',
      tailStart - 1, tailStart, total - 1,
    )

    const contentToSummarize = serializeForSummary(toCompress)
    const prompt = buildFullPrompt(contentToSummarize, this.config.summaryBudget)
    const history = buildConversationHistory(toCompress)

    let summary: string | null = null
    try {
      const t0 = Date.now()
      summary = await callSummarizer(upstream, apiKey, prompt, history, this.config.summarizationTimeoutMs, undefined, profile)
      logger.info('[context-compressor] full-llm done in %dms, %d chars', Date.now() - t0, summary.length)
    } catch (err: any) {
      logger.warn('[context-compressor] full-llm failed: %s', err.message)
    }

    const result: ChatMessage[] = []

    if (summary) {
      result.push({ role: 'system', content: SUMMARY_PREFIX + '\n\n' + summary })
      if (sessionId) {
        saveCompressionSnapshot(sessionId, summary, tailStart - 1, total)
      }
    }

    result.push(...tail)

    return {
      messages: result,
      meta: {
        ...meta,
        compressed: true,
        llmCompressed: !!summary,
        summaryTokenEstimate: summary ? countTokens(SUMMARY_PREFIX + summary) : 0,
        verbatimCount: tail.length,
        compressedStartIndex: tailStart - 1,
      },
    }
  }

  /** Remove snapshot for a session (e.g. when session is deleted) */
  static invalidateSnapshot(sessionId: string): void {
    deleteCompressionSnapshot(sessionId)
  }
}

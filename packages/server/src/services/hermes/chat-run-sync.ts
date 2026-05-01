import { getDb } from '../../db/index'
import { addMessage, findUnmappedMatchingMessage, getSession, updateSessionStats, type HermesMessageRow } from '../../db/hermes/session-store'
import { updateUsage } from '../../db/hermes/usage-store'
import {
  getChatSessionRunByHermesSessionId,
  getSyncedMessageLocalId,
  listRepairableChatSessionRuns,
  markChatSessionRunSyncFailed,
  markChatSessionRunSynced,
  recordSyncedMessage,
} from '../../db/hermes/chat-run-store'
import {
  getSessionMessagesFromDb,
  getSessionMessagesFromDbWithProfile,
  type HermesSessionRow,
} from '../../db/hermes/sessions-db'
import { logger } from '../logger'

export interface SyncHermesRunOptions {
  localSessionId: string
  hermesSessionId: string
  profile?: string
  memoryMessages?: Array<Pick<HermesMessageRow, 'role' | 'reasoning'>>
}

export interface SyncHermesRunResult {
  hermesSessionId: string
  inserted: number
  skipped: number
  sourceMessages: number
  status: 'synced' | 'no_data' | 'pending' | 'error'
  error?: string
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTerminalSession(session: HermesSessionRow | null): boolean {
  return Boolean(session && (session.ended_at != null || session.end_reason))
}

function buildToolNameMap(messages: HermesMessageRow[]): Map<string, string> {
  const toolNameMap = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue
    for (const tc of msg.tool_calls) {
      const id = tc.id || tc.call_id || tc.tool_call_id
      const name = tc.function?.name || tc.name
      if (id && name) toolNameMap.set(id, name)
    }
  }
  return toolNameMap
}

function mergeReasoningFromMemory(sourceRows: HermesMessageRow[], memoryMessages: Array<Pick<HermesMessageRow, 'role' | 'reasoning'>>): void {
  let memoryIdx = 0
  for (const sourceRow of sourceRows) {
    while (memoryIdx < memoryMessages.length && memoryMessages[memoryIdx].role === 'user') {
      memoryIdx++
    }
    if (memoryIdx >= memoryMessages.length) break
    const memoryMsg = memoryMessages[memoryIdx]
    if (sourceRow.role === memoryMsg.role && !sourceRow.reasoning && memoryMsg.reasoning) {
      sourceRow.reasoning = memoryMsg.reasoning
    }
    memoryIdx++
  }
}

function recordUsage(localSessionId: string, sourceSession: HermesSessionRow | null, profile?: string): void {
  if (!sourceSession) return
  updateUsage(localSessionId, {
    inputTokens: sourceSession.input_tokens,
    outputTokens: sourceSession.output_tokens,
    cacheReadTokens: sourceSession.cache_read_tokens,
    cacheWriteTokens: sourceSession.cache_write_tokens,
    reasoningTokens: sourceSession.reasoning_tokens,
    model: sourceSession.model,
    profile: profile || 'default',
  })
}

export function enqueueEphemeralSessionDelete(hermesSessionId: string, profile?: string): void {
  try {
    const db = getDb()
    if (!db) return
    const now = Date.now()
    db.prepare(
      `INSERT INTO gc_pending_session_deletes (session_id, profile_name, status, attempt_count, last_error, created_at, updated_at, next_attempt_at)
       VALUES (?, ?, 'pending', 0, NULL, ?, ?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
    ).run(hermesSessionId, profile || 'default', now, now, now)
    logger.info('[chat-run-sync] enqueued ephemeral session %s for deletion', hermesSessionId)
  } catch { /* best-effort */ }
}

export async function syncHermesRunToLocalSession(options: SyncHermesRunOptions): Promise<SyncHermesRunResult> {
  const { localSessionId, hermesSessionId, profile, memoryMessages = [] } = options
  try {
    let runBefore = getChatSessionRunByHermesSessionId(hermesSessionId)
    if (!getSession(localSessionId) || !runBefore || runBefore.wui_session_id !== localSessionId) {
      logger.info('[chat-run-sync] aborting sync for Hermes session %s because local session or run mapping no longer exists', hermesSessionId)
      return { hermesSessionId, inserted: 0, skipped: 0, sourceMessages: 0, status: 'no_data' }
    }

    const source = profile
      ? await getSessionMessagesFromDbWithProfile(hermesSessionId, profile)
      : await getSessionMessagesFromDb(hermesSessionId)

    if (!source || (!source.session && !source.messages.length)) {
      markChatSessionRunSyncFailed(hermesSessionId, 'Hermes session not found')
      logger.warn('[chat-run-sync] no Hermes session data for %s', hermesSessionId)
      return { hermesSessionId, inserted: 0, skipped: 0, sourceMessages: 0, status: 'no_data' }
    }

    if (!isTerminalSession(source.session)) {
      logger.info('[chat-run-sync] Hermes session %s is not terminal yet; leaving run repairable', hermesSessionId)
      return { hermesSessionId, inserted: 0, skipped: 0, sourceMessages: source.messages.length, status: 'pending' }
    }

    const toInsert = source.messages.filter(m => m.role !== 'user')
    if (!toInsert.length) {
      updateSessionStats(localSessionId)
      markChatSessionRunSynced(hermesSessionId)
      enqueueEphemeralSessionDelete(hermesSessionId, profile)
      logger.warn('[chat-run-sync] terminal Hermes session %s has no non-user messages', hermesSessionId)
      return { hermesSessionId, inserted: 0, skipped: 0, sourceMessages: source.messages.length, status: 'no_data' }
    }

    if (memoryMessages.length) {
      mergeReasoningFromMemory(toInsert, memoryMessages)
    }

    const db = getDb()
    if (!db) {
      throw new Error('Local SQLite DB is unavailable')
    }

    runBefore = getChatSessionRunByHermesSessionId(hermesSessionId)
    if (!getSession(localSessionId) || !runBefore || runBefore.wui_session_id !== localSessionId) {
      logger.info('[chat-run-sync] aborting sync for Hermes session %s because local session or run mapping disappeared before insert', hermesSessionId)
      return { hermesSessionId, inserted: 0, skipped: 0, sourceMessages: source.messages.length, status: 'no_data' }
    }
    const shouldRecordUsage = runBefore.status !== 'synced'
    const toolNameMap = buildToolNameMap(source.messages)
    let inserted = 0
    let skipped = 0

    db.exec('BEGIN IMMEDIATE')
    try {
      for (const msg of toInsert) {
        const sourceMessageId = msg.id
        if (getSyncedMessageLocalId(hermesSessionId, sourceMessageId)) {
          skipped++
          continue
        }

        let toolName = msg.tool_name || null
        if (!toolName && msg.tool_call_id) {
          toolName = toolNameMap.get(msg.tool_call_id) || null
        }

        const localMessageInput = {
          session_id: localSessionId,
          role: msg.role,
          content: msg.content || '',
          tool_call_id: msg.tool_call_id || null,
          tool_calls: msg.tool_calls || null,
          tool_name: toolName,
          timestamp: msg.timestamp || nowSeconds(),
          token_count: msg.token_count || null,
          finish_reason: msg.finish_reason || null,
          reasoning: msg.reasoning || null,
          reasoning_details: msg.reasoning_details || null,
          reasoning_content: msg.reasoning_content || null,
          codex_reasoning_items: msg.codex_reasoning_items || null,
        }
        const existingMessage = findUnmappedMatchingMessage(localMessageInput, hermesSessionId)
        const localMessageId = existingMessage?.id ?? addMessage(localMessageInput)

        if (localMessageId == null) {
          throw new Error(`Failed to insert or locate local message for Hermes message ${sourceMessageId}`)
        }

        recordSyncedMessage({
          wuiSessionId: localSessionId,
          hermesSessionId,
          hermesMessageId: sourceMessageId,
          localMessageId,
          role: msg.role,
        })
        if (existingMessage) {
          skipped++
        } else {
          inserted++
        }
      }

      updateSessionStats(localSessionId)
      if (shouldRecordUsage && inserted > 0) {
        recordUsage(localSessionId, source.session, profile)
      }
      markChatSessionRunSynced(hermesSessionId)
      enqueueEphemeralSessionDelete(hermesSessionId, profile)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* ignore rollback failure */ }
      throw error
    }

    logger.info('[chat-run-sync] synced Hermes session %s to local session %s (inserted=%d skipped=%d)',
      hermesSessionId, localSessionId, inserted, skipped)

    return { hermesSessionId, inserted, skipped, sourceMessages: source.messages.length, status: 'synced' }
  } catch (error) {
    const message = errorMessage(error)
    markChatSessionRunSyncFailed(hermesSessionId, message)
    logger.warn(error, '[chat-run-sync] failed to sync Hermes session %s to local session %s', hermesSessionId, localSessionId)
    throw error
  }
}

export async function repairUnsyncedChatRuns(localSessionId: string, profile?: string): Promise<SyncHermesRunResult[]> {
  const runs = listRepairableChatSessionRuns(localSessionId)
  const results: SyncHermesRunResult[] = []
  for (const run of runs) {
    try {
      const result = await syncHermesRunToLocalSession({
        localSessionId,
        hermesSessionId: run.hermes_session_id,
        profile: run.profile || profile,
      })
      results.push(result)
    } catch (error) {
      results.push({
        hermesSessionId: run.hermes_session_id,
        inserted: 0,
        skipped: 0,
        sourceMessages: 0,
        status: 'error',
        error: errorMessage(error),
      })
    }
  }
  return results
}

/**
 * Sync Hermes sessions from all profiles on startup.
 * Reads webui/api_server sessions from Hermes state.db and imports missing sessions into local DB.
 * Runs incrementally and skips sessions that were already mirrored.
 *
 * Uses sessions-db.ts query logic to properly aggregate session chains.
 */
import { readdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { getProfileDir } from './hermes-profile'
import { createSession, addMessage, updateSession, getSession } from '../../db/hermes/session-store'
import { getDb } from '../../db/index'
import { logger } from '../logger'
import {
  getSessionDetailFromDbWithProfile,
  listSessionSummaries as listHermesSessionSummaries,
} from '../../db/hermes/sessions-db'

const HERMES_BASE = resolve(homedir(), '.hermes')
const PROFILES_DIR = join(HERMES_BASE, 'profiles')
const SYNC_SOURCES = ['webui', 'api_server'] as const

/**
 * Get all available profile names including 'default'
 */
function getAllProfiles(): string[] {
  const profiles = ['default']

  if (existsSync(PROFILES_DIR)) {
    const dirs = readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
    profiles.push(...dirs)
  }

  return profiles
}

function hasMatchingLegacyImport(profile: string, hermesSession: { source: string; started_at: number; title: string | null }): boolean {
  const db = getDb()
  if (!db) return false

  const row = db.prepare(
    `SELECT id FROM sessions
     WHERE profile = ?
       AND source = ?
       AND started_at = ?
       AND COALESCE(title, '') = COALESCE(?, '')
     LIMIT 1`,
  ).get(profile, hermesSession.source, hermesSession.started_at, hermesSession.title) as { id: string } | undefined

  return !!row
}

function isAlreadySynced(profile: string, localSessionId: string, hermesSession: { source: string; started_at: number; title: string | null }): boolean {
  return !!getSession(localSessionId) || hasMatchingLegacyImport(profile, hermesSession)
}

/**
 * Sync configured Hermes session sources from a single profile.
 * Uses sessions-db.ts query logic to properly aggregate session chains.
 */
async function syncProfileSessions(profile: string): Promise<{
  synced: number
  skipped: number
  errors: string[]
}> {
  const result = { synced: 0, skipped: 0, errors: [] as string[] }

  for (const source of SYNC_SOURCES) {
    try {
      // Use listSessionSummaries to get aggregated session chains.
      // This returns only root sessions with aggregated stats from the entire chain.
      const summaries = await listHermesSessionSummaries(source, 10000, profile)

      logger.info(`[session-sync] profile '${profile}', source '${source}': found ${summaries.length} aggregated session chains`)

      for (const hermesSession of summaries) {
        // Skip ephemeral sessions (created internally by chat-run-socket)
        if (hermesSession.id.startsWith('eph_')) continue

        try {
          // Use Hermes' stable session id in the local mirror so startup sync is idempotent.
          const localSessionId = hermesSession.id

          if (isAlreadySynced(profile, localSessionId, hermesSession)) {
            result.skipped++
            continue
          }

          // Get full detail including all messages from the session chain before mutating the mirror.
          const detail = await getSessionDetailFromDbWithProfile(hermesSession.id, profile)

          if (!detail || !detail.messages) {
            result.errors.push(`session ${hermesSession.id}: failed to load messages`)
            logger.warn(`[session-sync] failed to load messages for session ${hermesSession.id}`)
            continue
          }

          // Create session in local DB
          createSession({
            id: localSessionId,
            profile,
            model: hermesSession.model,
            title: hermesSession.title || undefined,
          })

          // Insert all messages from the entire chain
          for (const msg of detail.messages) {
            addMessage({
              session_id: localSessionId,
              role: msg.role,
              content: msg.content,
              tool_call_id: msg.tool_call_id,
              tool_calls: msg.tool_calls,
              tool_name: msg.tool_name,
              timestamp: msg.timestamp,
              token_count: msg.token_count,
              finish_reason: msg.finish_reason,
              reasoning: msg.reasoning,
              reasoning_details: msg.reasoning_details,
              reasoning_content: msg.reasoning_content,
              codex_reasoning_items: msg.codex_reasoning_items,
            })
          }

          // Update session with aggregated stats from Hermes
          updateSession(localSessionId, {
            source: hermesSession.source,
            user_id: hermesSession.user_id,
            started_at: hermesSession.started_at,
            ended_at: hermesSession.ended_at,
            end_reason: hermesSession.end_reason,
            message_count: detail.messages.length,
            tool_call_count: hermesSession.tool_call_count,
            input_tokens: hermesSession.input_tokens,
            output_tokens: hermesSession.output_tokens,
            cache_read_tokens: hermesSession.cache_read_tokens,
            cache_write_tokens: hermesSession.cache_write_tokens,
            reasoning_tokens: hermesSession.reasoning_tokens,
            billing_provider: hermesSession.billing_provider,
            estimated_cost_usd: hermesSession.estimated_cost_usd,
            actual_cost_usd: hermesSession.actual_cost_usd,
            cost_status: hermesSession.cost_status,
            last_active: hermesSession.last_active,
            preview: hermesSession.preview,
          })

          result.synced++
          logger.info(`[session-sync] synced Hermes session ${hermesSession.id} (${source}) -> ${localSessionId} (${detail.messages.length} messages, thread_session_count=${detail.thread_session_count})`)
        } catch (err: any) {
          result.errors.push(`session ${hermesSession.id}: ${err.message}`)
          logger.warn(err, `[session-sync] failed to sync session ${hermesSession.id}`)
        }
      }
    } catch (err: any) {
      if (!err.message.includes('state.db not found')) {
        result.errors.push(`${source}: ${err.message}`)
        logger.warn(err, `[session-sync] failed to open state.db for profile '${profile}', source '${source}'`)
      }
    }
  }

  return result
}

/**
 * Main entry point: incrementally sync missing Hermes web UI/API sessions.
 */
export async function syncAllHermesSessionsOnStartup(): Promise<void> {
  const db = getDb()
  if (!db) {
    logger.info('[session-sync] SQLite not available, skipping Hermes sync')
    return
  }

  const countResult = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number } | undefined
  logger.info('[session-sync] local DB has %d sessions, starting incremental Hermes session sync...', countResult?.count ?? 0)

  const profiles = getAllProfiles()
  logger.info(`[session-sync] found ${profiles.length} profiles: ${profiles.join(', ')}`)

  let totalSynced = 0
  let totalSkipped = 0
  let totalErrors = 0

  for (const profile of profiles) {
    const result = await syncProfileSessions(profile)
    totalSynced += result.synced
    totalSkipped += result.skipped
    totalErrors += result.errors.length

    if (result.errors.length > 0) {
      logger.warn(`[session-sync] profile '${profile}' had ${result.errors.length} errors`)
      for (const err of result.errors.slice(0, 5)) {
        logger.warn(`[session-sync]   - ${err}`)
      }
      if (result.errors.length > 5) {
        logger.warn(`[session-sync]   - ... and ${result.errors.length - 5} more errors`)
      }
    }
  }

  logger.info(`[session-sync] sync complete: synced=${totalSynced}, skipped=${totalSkipped}, errors=${totalErrors}`)
}

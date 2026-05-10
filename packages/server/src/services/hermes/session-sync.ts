/**
 * Sync Hermes sessions from all profiles on startup.
 * Reads api_server sessions from Hermes state.db and imports into local DB.
 * Only runs when local DB is empty (first startup).
 *
 * Uses sessions-db.ts query logic to properly aggregate session chains.
 */
import { readdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { getProfileDir } from './hermes-profile'
import { createSession, addMessage, updateSession } from '../../db/hermes/session-store'
import { getDb } from '../../db/index'
import { logger } from '../logger'
import { listSessionSummaries as listHermesSessionSummaries } from '../../db/hermes/sessions-db'

const HERMES_BASE = resolve(homedir(), '.hermes')
const PROFILES_DIR = join(HERMES_BASE, 'profiles')

/**
 * Generate a UUID v4 without external dependencies
 */
function generateUuid(): string {
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // Version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // Variant 10
  return [
    bytes.subarray(0, 4).toString('hex'),
    bytes.subarray(4, 6).toString('hex'),
    bytes.subarray(6, 8).toString('hex'),
    bytes.subarray(8, 10).toString('hex'),
    bytes.subarray(10, 16).toString('hex'),
  ].join('-')
}

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

/**
 * Sync api_server sessions from a single profile.
 * Uses sessions-db.ts query logic to properly aggregate session chains.
 */
async function syncProfileSessions(profile: string): Promise<{
  synced: number
  errors: string[]
}> {
  const result = { synced: 0, errors: [] as string[] }

  try {
    // Use listSessionSummaries to get aggregated session chains
    // This returns only root sessions with aggregated stats from the entire chain
    const summaries = await listHermesSessionSummaries('api_server', 10000, profile)

    logger.info(`[session-sync] profile '${profile}': found ${summaries.length} aggregated session chains`)

    for (const hermesSession of summaries) {
      // Skip ephemeral sessions (created internally by chat-run-socket)
      if (hermesSession.id.startsWith('eph_')) continue
      try {
        // Generate new session ID for local DB
        const newSessionId = generateUuid()

        // Create session in local DB
        createSession({
          id: newSessionId,
          profile,
          model: hermesSession.model,
          title: hermesSession.title || undefined,
        })

        // Get full detail including all messages from the session chain
        const { getSessionDetailFromDbWithProfile } = await import('../../db/hermes/sessions-db')
        const detail = await getSessionDetailFromDbWithProfile(hermesSession.id, profile)

        if (!detail || !detail.messages) {
          result.errors.push(`session ${hermesSession.id}: failed to load messages`)
          logger.warn(`[session-sync] failed to load messages for session ${hermesSession.id}`)
          continue
        }

        // Insert all messages from the entire chain
        for (const msg of detail.messages) {
          addMessage({
            session_id: newSessionId,
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
          })
        }

        // Update session with aggregated stats from Hermes
        updateSession(newSessionId, {
          started_at: hermesSession.started_at,
          ended_at: hermesSession.ended_at,
          end_reason: hermesSession.end_reason,
          input_tokens: hermesSession.input_tokens,
          output_tokens: hermesSession.output_tokens,
          cache_read_tokens: hermesSession.cache_read_tokens,
          cache_write_tokens: hermesSession.cache_write_tokens,
          reasoning_tokens: hermesSession.reasoning_tokens,
          estimated_cost_usd: hermesSession.estimated_cost_usd,
          last_active: hermesSession.last_active,
          preview: hermesSession.preview,
        })

        result.synced++
        logger.info(`[session-sync] synced Hermes session ${hermesSession.id} -> ${newSessionId} (${detail.messages.length} messages, thread_session_count=${detail.thread_session_count})`)
      } catch (err: any) {
        result.errors.push(`session ${hermesSession.id}: ${err.message}`)
        logger.warn(err, `[session-sync] failed to sync session ${hermesSession.id}`)
      }
    }
  } catch (err: any) {
    if (!err.message.includes('state.db not found')) {
      result.errors.push(err.message)
      logger.warn(err, `[session-sync] failed to open state.db for profile '${profile}'`)
    }
  }

  return result
}

/**
 * Main entry point: sync all profiles on startup
 * Only runs if local DB is empty (first startup or after DB reset)
 */
export async function syncAllHermesSessionsOnStartup(): Promise<void> {
  // Check if local DB has any sessions - only sync if completely empty
  const db = getDb()
  if (!db) {
    logger.info('[session-sync] SQLite not available, skipping Hermes sync')
    return
  }

  const countResult = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number } | undefined
  const hasExistingSessions = countResult && countResult.count > 0

  if (hasExistingSessions) {
    logger.info('[session-sync] local DB has %d sessions, skipping Hermes sync', countResult!.count)
    return
  }

  logger.info('[session-sync] local DB is empty, starting Hermes session sync...')

  const profiles = getAllProfiles()
  logger.info(`[session-sync] found ${profiles.length} profiles: ${profiles.join(', ')}`)

  let totalSynced = 0
  let totalErrors = 0

  for (const profile of profiles) {
    const result = await syncProfileSessions(profile)
    totalSynced += result.synced
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

  logger.info(`[session-sync] sync complete: synced=${totalSynced}, errors=${totalErrors}`)
}

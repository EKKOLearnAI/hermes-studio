/**
 * Sync Hermes sessions from all profiles on startup.
 * Reads api_server sessions from Hermes state.db and imports into local DB.
 * Only runs when local DB is empty (first startup).
 */
import { readdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'crypto'
import { getProfileDir } from './hermes-profile'
import { createSession, addMessage, updateSession, getSession } from '../../db/hermes/session-store'
import { getDb } from '../../db/index'
import { logger } from '../logger'

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

const HERMES_BASE = resolve(homedir(), '.hermes')
const PROFILES_DIR = join(HERMES_BASE, 'profiles')

interface HermesSessionRow {
  id: string
  source: string
  model: string
  title: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  estimated_cost_usd: number
  last_active: number
}

interface HermesMessageRow {
  id: number | string
  session_id: string
  role: string
  content: string
  tool_call_id: string | null
  tool_calls: any[] | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
  reasoning_details: string | null
  reasoning_content: string | null
  codex_reasoning_items: string | null
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
 * Open Hermes state.db for a specific profile
 */
function openHermesStateDb(profile: string): DatabaseSync {
  const profileDir = getProfileDir(profile)
  const dbPath = join(profileDir, 'state.db')

  if (!existsSync(dbPath)) {
    throw new Error(`Hermes state.db not found for profile '${profile}' at ${dbPath}`)
  }

  return new DatabaseSync(dbPath, { readOnly: true })
}

/**
 * Sync api_server sessions from a single profile
 */
function syncProfileSessions(profile: string): {
  synced: number
  skipped: number
  errors: string[]
} {
  const result = { synced: 0, skipped: 0, errors: [] as string[] }

  try {
    const db = openHermesStateDb(profile)

    try {
      // Get all api_server sessions
      const sessions = db.prepare(`
        SELECT
          id,
          source,
          COALESCE(model, '') AS model,
          title,
          started_at,
          ended_at,
          end_reason,
          message_count,
          tool_call_count,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          cache_write_tokens,
          reasoning_tokens,
          estimated_cost_usd
        FROM sessions
        WHERE source = 'api_server'
        ORDER BY started_at ASC
      `).all() as unknown as Omit<HermesSessionRow, 'preview' | 'last_active'>[]

      logger.info(`[session-sync] profile '${profile}': found ${sessions.length} api_server sessions`)
      for (const hermesSession of sessions) {
        try {
          // Check if this Hermes session ID already exists in local DB
          const existing = getSession(hermesSession.id)
          if (existing) {
            result.skipped++
            continue
          }

          // Generate new session ID
          const newSessionId = generateUuid()

          // Create session in local DB
          createSession({
            id: newSessionId,
            profile,
            model: hermesSession.model,
            title: hermesSession.title || undefined,
          })

          // Get all messages for this session
          const messages = db.prepare(`
            SELECT
              id,
              session_id,
              role,
              content,
              tool_call_id,
              tool_calls,
              tool_name,
              timestamp,
              token_count,
              finish_reason,
              reasoning,
              reasoning_details,
              reasoning_content,
              codex_reasoning_items
            FROM messages
            WHERE session_id = ?
            ORDER BY timestamp, id
          `).all(hermesSession.id) as unknown as HermesMessageRow[]

          // Insert all messages
          for (const msg of messages) {
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
              codex_reasoning_items: msg.codex_reasoning_items,
            })
          }

          // Generate preview from first user message
          const firstUserMessage = messages.find(m => m.role === 'user' && m.content)
          let preview = ''
          if (firstUserMessage && firstUserMessage.content) {
            // Remove newlines, truncate to 63 chars
            preview = firstUserMessage.content
              .replace(/[\n\r]/g, ' ')
              .trim()
              .slice(0, 63)
          }

          // Update session with Hermes data
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
            last_active: hermesSession.started_at, // Use started_at as fallback since last_active doesn't exist in Hermes state.db
            preview,
          })

          result.synced++
          logger.info(`[session-sync] synced Hermes session ${hermesSession.id} -> ${newSessionId} (${messages.length} messages)`)
        } catch (err: any) {
          result.errors.push(`session ${hermesSession.id}: ${err.message}`)
          logger.warn(err, `[session-sync] failed to sync session ${hermesSession.id}`)
        }
      }
    } finally {
      db.close()
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
export function syncAllHermesSessionsOnStartup(): void {
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
  let totalSkipped = 0
  let totalErrors = 0

  for (const profile of profiles) {
    const result = syncProfileSessions(profile)
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

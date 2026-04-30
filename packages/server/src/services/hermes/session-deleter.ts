/**
 * Session Deleter — periodically drains pending session deletes.
 *
 * Reads from gc_pending_session_deletes table, executes deletion via
 * Hermes CLI, tracks failures (max 3 attempts), and auto-drains on
 * a timer + profile switch.
 *
 * Race-condition guard: callers that are still ASYNCHRONOUSLY reading
 * a Hermes session (e.g. chat-run-socket.syncFromHermes) must register
 * the hermes session id in `inFlightHermesSessionIds` BEFORE the read
 * starts and remove it AFTER the read completes (success or failure).
 * The drain loop will skip any id present in that set, so the periodic
 * timer / profile-switch tick cannot delete a session out from under
 * an in-flight reader. See issue #352.
 */
import { getDb } from '../../db/index'
import { deleteSession as hermesDeleteSession } from './hermes-cli'
import { logger } from '../logger'

const MAX_ATTEMPTS = 3
const DRAIN_INTERVAL_MS = 300_000

/**
 * Hermes session ids currently being read by an async consumer
 * (e.g. syncFromHermes). The drain loop skips any id in this set so
 * that periodic deletion cannot race with an in-flight read and leave
 * the local DB missing assistant/tool messages. See issue #352.
 *
 * Producers must:
 *   inFlightHermesSessionIds.add(id)
 *   try { ...read... } finally { inFlightHermesSessionIds.delete(id) }
 */
export const inFlightHermesSessionIds = new Set<string>()

export class SessionDeleter {
  private static _instance: SessionDeleter | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private currentProfile: string = 'default'

  static getInstance(): SessionDeleter {
    if (!SessionDeleter._instance) {
      SessionDeleter._instance = new SessionDeleter()
    }
    return SessionDeleter._instance
  }

  /** Start periodic drain for the given profile */
  start(profile: string): void {
    this.currentProfile = profile
    this.stop()
    logger.info('[SessionDeleter] started, profile=%s, interval=%dms', profile, DRAIN_INTERVAL_MS)
    // Drain immediately on start, then on interval
    this.drain(profile).catch(() => {})
    this.timer = setInterval(() => {
      this.drain(profile).catch(() => {})
    }, DRAIN_INTERVAL_MS)
  }

  /** Switch to a new profile, stop old timer and start new one */
  switchProfile(newProfile: string): void {
    if (newProfile !== this.currentProfile) {
      logger.info('[SessionDeleter] switching profile %s -> %s', this.currentProfile, newProfile)
      this.start(newProfile)
    }
  }

  /** Stop periodic drain */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Drain pending deletes for a specific profile (called on profile switch or manually) */
  async drain(profile: string): Promise<{ deleted: string[]; skipped: string[]; failed: string[] }> {
    const db = getDb()
    if (!db) return { deleted: [], skipped: [], failed: [] }

    const now = Date.now()
    const rows = db.prepare(`
      SELECT session_id, profile_name, status, attempt_count, last_error
      FROM gc_pending_session_deletes
      WHERE profile_name = ? AND status = 'pending' AND attempt_count < ? AND next_attempt_at <= ?
      ORDER BY created_at ASC
      LIMIT 50
    `).all(profile, MAX_ATTEMPTS, now) as Array<{
      session_id: string
      profile_name: string
      status: string
      attempt_count: number
      last_error: string | null
    }>

    if (rows.length === 0) return { deleted: [], skipped: [], failed: [] }

    // Skip any session that an async reader (e.g. syncFromHermes) is still
    // pulling messages out of. Without this guard, drain can delete a session
    // before the reader finishes, dropping assistant/tool messages from the
    // local mirror — see issue #352.
    const eligibleRows = rows.filter(r => !inFlightHermesSessionIds.has(r.session_id))
    if (eligibleRows.length === 0) {
      logger.debug(
        '[SessionDeleter] all %d candidate(s) deferred (in-flight reads in progress)',
        rows.length,
      )
      return { deleted: [], skipped: rows.map(r => r.session_id), failed: [] }
    }
    if (eligibleRows.length < rows.length) {
      logger.debug(
        '[SessionDeleter] deferred %d candidate(s) due to in-flight reads',
        rows.length - eligibleRows.length,
      )
    }

    const deleted: string[] = []
    const skipped: string[] = []
    const failed: string[] = []

    for (const row of eligibleRows) {
      try {
        const ok = await hermesDeleteSession(row.session_id)
        if (ok) {
          db.prepare('DELETE FROM gc_pending_session_deletes WHERE session_id = ?').run(row.session_id)
          db.prepare('DELETE FROM gc_session_profiles WHERE session_id = ?').run(row.session_id)
          deleted.push(row.session_id)
        } else {
          skipped.push(row.session_id)
        }
      } catch (err: any) {
        const msg = err?.message || 'Unknown error'
        db.prepare(
          `UPDATE gc_pending_session_deletes
           SET status = 'pending', attempt_count = attempt_count + 1, last_error = ?, updated_at = ?, next_attempt_at = ?
           WHERE session_id = ?`,
        ).run(msg, now, now + 60_000, row.session_id)
        failed.push(row.session_id)
        logger.warn('[SessionDeleter] failed to delete %s (attempt %d): %s', row.session_id, row.attempt_count + 1, msg)
      }
    }

    if (deleted.length || failed.length) {
      logger.info('[SessionDeleter] profile=%s: deleted=%d, failed=%d', profile, deleted.length, failed.length)
    }

    return { deleted, skipped, failed }
  }
}

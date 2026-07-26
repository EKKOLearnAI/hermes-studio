/**
 * Session Deleter — periodically drains pending session deletes.
 *
 * Reads from gc_pending_session_deletes table, executes deletion via
 * Hermes CLI, tracks failures with bounded backoff, and auto-drains on
 * a timer + profile switch.
 */
import { getDb } from '../../db/index'
import { deleteSessionForProfile as hermesDeleteSessionForProfile } from './hermes-cli'
import { logger } from '../logger'

const DRAIN_INTERVAL_MS = 300_000
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 3_600_000

function retryDelayMs(previousAttempts: number): number {
  const exponent = Math.min(10, Math.max(0, Math.floor(previousAttempts)))
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** exponent))
}

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
    // Drain every recorded profile immediately, then on interval.
    this.drainAllProfiles(profile).catch(() => {})
    this.timer = setInterval(() => {
      this.drainAllProfiles(profile).catch(() => {})
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

  /** Drain all profiles represented in the durable outbox, plus the active fallback profile. */
  async drainAllProfiles(fallbackProfile = this.currentProfile): Promise<void> {
    const db = getDb()
    if (!db) return
    const rows = db.prepare(
      `SELECT DISTINCT profile_name
       FROM gc_pending_session_deletes
       WHERE status IN ('pending', 'processing')`,
    ).all() as Array<{ profile_name: string }>
    const profiles = new Set<string>([fallbackProfile])
    for (const row of rows) {
      const profile = String(row.profile_name || '').trim()
      if (profile) profiles.add(profile)
    }
    for (const profile of profiles) {
      await this.drain(profile)
    }
  }

  /** Drain pending deletes for a specific profile (called on profile switch or manually) */
  async drain(profile: string): Promise<{ deleted: string[]; skipped: string[]; failed: string[] }> {
    const db = getDb()
    if (!db) return { deleted: [], skipped: [], failed: [] }

    const now = Date.now()
    db.prepare(
      `UPDATE gc_pending_session_deletes
       SET status = 'pending', updated_at = ?, next_attempt_at = 0
       WHERE status = 'processing'`,
    ).run(now)
    const rows = db.prepare(`
      SELECT session_id, profile_name, status, attempt_count, last_error
      FROM gc_pending_session_deletes
      WHERE profile_name = ? AND status = 'pending' AND next_attempt_at <= ?
      ORDER BY created_at ASC
      LIMIT 50
    `).all(profile, now) as Array<{
      session_id: string
      profile_name: string
      status: string
      attempt_count: number
      last_error: string | null
    }>

    if (rows.length === 0) return { deleted: [], skipped: [], failed: [] }

    const deleted: string[] = []
    const skipped: string[] = []
    const failed: string[] = []

    for (const row of rows) {
      try {
        const ok = await hermesDeleteSessionForProfile(row.session_id, row.profile_name)
        if (ok) {
          db.prepare('DELETE FROM gc_pending_session_deletes WHERE session_id = ?').run(row.session_id)
          db.prepare('DELETE FROM gc_session_profiles WHERE session_id = ?').run(row.session_id)
          deleted.push(row.session_id)
        } else {
          const failedAt = Date.now()
          db.prepare(
            `UPDATE gc_pending_session_deletes
             SET status = 'pending', attempt_count = attempt_count + 1, last_error = ?, updated_at = ?, next_attempt_at = ?
             WHERE session_id = ?`,
          ).run(
            'Hermes CLI session delete returned false',
            failedAt,
            failedAt + retryDelayMs(row.attempt_count),
            row.session_id,
          )
          skipped.push(row.session_id)
        }
      } catch (err: any) {
        const msg = err?.message || 'Unknown error'
        const failedAt = Date.now()
        db.prepare(
          `UPDATE gc_pending_session_deletes
           SET status = 'pending', attempt_count = attempt_count + 1, last_error = ?, updated_at = ?, next_attempt_at = ?
           WHERE session_id = ?`,
        ).run(msg, failedAt, failedAt + retryDelayMs(row.attempt_count), row.session_id)
        failed.push(row.session_id)
        logger.warn('[SessionDeleter] failed to delete %s (attempt %d): %s', row.session_id, row.attempt_count + 1, msg)
      }
    }

    if (deleted.length || failed.length || skipped.length) {
      logger.info(
        '[SessionDeleter] profile=%s: deleted=%d, skipped=%d, failed=%d',
        profile,
        deleted.length,
        skipped.length,
        failed.length,
      )
    }

    return { deleted, skipped, failed }
  }
}

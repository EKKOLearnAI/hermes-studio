/**
 * In-process cron scheduler for web-ui-owned jobs.
 *
 * Runs inside the single long-lived Node server (no second daemon, no OS cron).
 * On start it arms one timer per scheduled job across every profile; REST
 * mutations call `reload()` to re-arm the affected job. When a timer fires it
 * runs the job (skipping if a prior run of the same job is still in flight),
 * then re-arms from the freshly persisted record so repeat-exhausted/paused jobs
 * stop on their own.
 *
 * Gated by `HERMES_WEBUI_CRON_SCHEDULER` (set to `0` to disable, e.g. when the
 * Hermes runtime scheduler still owns firing during migration).
 */

import { logger } from '../../logger'
import { listProfileNamesFromDisk } from '../hermes-profile'
import { findJobRecord, type JobRecord, jobScheduleExpr, readJobRecords } from './job-store'
import { runJobNow } from './run-job'
import { nextRunAfter, parseSchedule } from './schedule'

// setTimeout caps delays at a 32-bit signed int; longer waits are re-armed.
const MAX_TIMEOUT_MS = 2 ** 31 - 1

function keyOf(profile: string, jobId: string): string {
  return `${profile}\u0000${jobId}`
}

function isSchedulable(job: JobRecord): boolean {
  if (job.enabled === false) return false
  if (job.state && job.state !== 'scheduled') return false
  return jobScheduleExpr(job) != null
}

function nextDelayMs(job: JobRecord, from: Date): number | null {
  const expr = jobScheduleExpr(job)
  if (!expr) return null
  let next: Date | null
  try {
    next = nextRunAfter(parseSchedule(expr), from)
  } catch {
    return null
  }
  if (!next) return null
  return Math.max(0, next.getTime() - from.getTime())
}

export class CronScheduler {
  #timers = new Map<string, NodeJS.Timeout>()
  #running = new Set<string>()
  #started = false

  start(): void {
    if (this.#started) return
    this.#started = true
    try {
      for (const profile of listProfileNamesFromDisk()) {
        this.#armProfile(profile)
      }
      logger.info('[cron] scheduler started (%d timers)', this.#timers.size)
    } catch (error) {
      // Never let scheduler arming abort server bootstrap.
      logger.warn(error, '[cron] scheduler failed to arm jobs on start')
    }
  }

  stop(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
    this.#started = false
  }

  /** Re-arm after a mutation. `(profile, jobId)` for one job, `(profile)` for a whole profile. */
  reload(profile?: string, jobId?: string): void {
    if (!this.#started) return
    if (profile && jobId) {
      const job = findJobRecord(profile, jobId)
      if (job) this.#arm(profile, job)
      else this.#clear(keyOf(profile, jobId))
      return
    }
    if (profile) {
      this.#clearProfile(profile)
      this.#armProfile(profile)
      return
    }
    this.stop()
    this.start()
  }

  #armProfile(profile: string): void {
    for (const job of readJobRecords(profile, true)) {
      this.#arm(profile, job)
    }
  }

  #clearProfile(profile: string): void {
    const prefix = `${profile}\u0000`
    for (const key of [...this.#timers.keys()]) {
      if (key.startsWith(prefix)) this.#clear(key)
    }
  }

  #clear(key: string): void {
    const timer = this.#timers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.#timers.delete(key)
    }
  }

  #arm(profile: string, job: JobRecord): void {
    const key = keyOf(profile, job.job_id)
    this.#clear(key)
    if (!isSchedulable(job)) return

    const delay = nextDelayMs(job, new Date())
    if (delay == null) return

    const wait = Math.min(delay, MAX_TIMEOUT_MS)
    const timer = setTimeout(() => {
      if (wait < delay) {
        // Long delay: re-arm to cover the remaining wait.
        this.#timers.delete(key)
        this.#arm(profile, job)
        return
      }
      void this.#fire(profile, job.job_id)
    }, wait)
    timer.unref?.()
    this.#timers.set(key, timer)
  }

  async #fire(profile: string, jobId: string): Promise<void> {
    const key = keyOf(profile, jobId)
    this.#timers.delete(key)

    if (!this.#running.has(key)) {
      this.#running.add(key)
      try {
        const job = findJobRecord(profile, jobId)
        if (job && isSchedulable(job)) {
          await runJobNow(profile, job, { countsTowardRepeat: true })
        }
      } catch (error) {
        logger.warn(error, '[cron] job %s failed to run', jobId)
      } finally {
        this.#running.delete(key)
      }
    }

    // Re-arm from fresh state (the run may have exhausted repeat / disabled it).
    const fresh = findJobRecord(profile, jobId)
    if (fresh) this.#arm(profile, fresh)
  }
}

let scheduler: CronScheduler | null = null

export function getCronScheduler(): CronScheduler {
  if (!scheduler) scheduler = new CronScheduler()
  return scheduler
}

export function isCronSchedulerEnabled(): boolean {
  return process.env.HERMES_WEBUI_CRON_SCHEDULER !== '0'
}

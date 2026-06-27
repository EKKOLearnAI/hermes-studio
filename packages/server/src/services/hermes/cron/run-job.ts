/**
 * Executes one job: pick the runner (omp agent vs script), capture output, write
 * the run artifact, and record status/repeat bookkeeping in jobs.json.
 *
 * Platform delivery (telegram/discord/…) is intentionally NOT implemented yet —
 * every run produces the local `cron/output/<jobId>/*.md` artifact (the `local`
 * behavior), regardless of the job's `deliver` target. Delivery adapters are a
 * follow-up; `deliver` is preserved on the record for when they land.
 */

import { logger } from '../../logger'
import { ensureHermesRunWorkspace } from '../run-chat/workspace'
import { type JobRecord, recordRunResult } from './job-store'
import { runOmpPrompt, runScript, type RunOutcome } from './omp-runner'
import { writeRunOutput } from './output-writer'

export interface RunJobOptions {
  /** Scheduled fires count toward the repeat budget; manual runs do not. */
  countsTowardRepeat: boolean
}

async function execute(job: JobRecord, cwd: string): Promise<RunOutcome> {
  if (job.no_agent === true || (typeof job.script === 'string' && job.script.trim())) {
    return runScript({ script: String(job.script ?? ''), cwd })
  }
  return runOmpPrompt({ prompt: job.prompt, model: job.model, cwd })
}

/**
 * Run a job end to end. Returns the updated, normalized record (or null if the
 * job vanished mid-run). Never throws — failures are captured as `last_status`.
 */
export async function runJobNow(profile: string, job: JobRecord, options: RunJobOptions): Promise<JobRecord | null> {
  const ranAt = new Date().toISOString()
  let outcome: RunOutcome

  try {
    // Run inside the profile's writable run workspace (matches the chat path).
    // Never the profile/credential dir, which omp's write guard protects.
    const cwd = await ensureHermesRunWorkspace(profile, typeof job.workdir === 'string' ? job.workdir : null)
    outcome = await execute(job, cwd)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    outcome = { status: 'error', output: '', error: message, exitCode: null }
  }

  const text = outcome.output.trim()
  if (text) {
    try {
      writeRunOutput(profile, job.job_id, outcome.output)
    } catch (error) {
      logger.warn(error, '[cron] failed to write run output for job %s', job.job_id)
    }
  }

  logger.info('[cron] job %s finished status=%s', job.job_id, outcome.status)
  return recordRunResult(profile, job.job_id, {
    status: outcome.status,
    error: outcome.error ?? null,
    ranAt,
    countsTowardRepeat: options.countsTowardRepeat,
  })
}

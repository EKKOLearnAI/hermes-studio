/**
 * Writes cron run artifacts to `<profileDir>/cron/output/<jobId>/<ts>.md`, the
 * exact layout the `cron-history` controller reads. Filenames use an ISO-like
 * timestamp with `:` replaced by `-` so they are filesystem-safe and still match
 * the controller's `toDisplayTime` ISO regex.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getProfileDir } from '../hermes-profile'

export interface RunArtifact {
  fileName: string
  runTime: string
}

/** ISO timestamp safe for filenames: `2026-06-26T14-30-00`. */
function timestampForFile(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
}

export function getCronOutputDir(profile: string, jobId: string): string {
  return join(getProfileDir(profile || 'default'), 'cron', 'output', jobId)
}

/** Persist a run's markdown output; returns the file metadata. */
export function writeRunOutput(profile: string, jobId: string, content: string, at: Date = new Date()): RunArtifact {
  const dir = getCronOutputDir(profile, jobId)
  mkdirSync(dir, { recursive: true })
  const stamp = timestampForFile(at)
  const fileName = `${stamp}.md`
  writeFileSync(join(dir, fileName), content, 'utf-8')
  return { fileName, runTime: stamp }
}

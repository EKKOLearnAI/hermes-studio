import type { Context } from 'koa'
import { readdir, stat, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'

const HERMES_BASE = join(homedir(), '.hermes')
const CRON_OUTPUT = join(HERMES_BASE, 'cron', 'output')

export interface RunEntry {
  jobId: string
  fileName: string
  runTime: string
  size: number
}

export interface RunDetail {
  jobId: string
  fileName: string
  runTime: string
  content: string
}

/** List all run output files, optionally filtered by job ID */
export async function listRuns(ctx: Context) {
  const jobId = ctx.query.jobId as string | undefined

  if (!existsSync(CRON_OUTPUT)) {
    ctx.body = { runs: [] }
    return
  }

  try {
    const dirs = await readdir(CRON_OUTPUT)
    const runs: RunEntry[] = []

    const targetDirs = jobId ? dirs.filter(d => d === jobId) : dirs

    for (const dir of targetDirs) {
      const dirPath = join(CRON_OUTPUT, dir)
      try {
        const dirStat = await stat(dirPath)
        if (!dirStat.isDirectory()) continue

        const files = await readdir(dirPath)
        // Sort by filename descending (newest first, since filenames are timestamps)
        const sorted = files.sort().reverse()

        for (const file of sorted) {
          if (!file.endsWith('.md')) continue
          const filePath = join(dirPath, file)
          try {
            const fileStat = await stat(filePath)
            // Parse run time from filename: 2026-04-18_12-01-40.md → 2026-04-18 12:01:40
            const match = file.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.md$/)
            const runTime = match ? `${match[1]} ${match[2].replace(/-/g, ':')}` : file

            runs.push({
              jobId: dir,
              fileName: file,
              runTime,
              size: fileStat.size,
            })
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable dirs */ }
    }

    // Sort all runs by runTime descending
    runs.sort((a, b) => b.runTime.localeCompare(a.runTime))

    ctx.body = { runs }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

/** Read a specific run output file */
export async function readRun(ctx: Context) {
  const { jobId, fileName } = ctx.params

  if (!jobId || !fileName) {
    ctx.status = 400
    ctx.body = { error: 'jobId and fileName are required' }
    return
  }

  // Prevent path traversal
  if (jobId.includes('..') || fileName.includes('..') || jobId.includes('/') || fileName.includes('/')) {
    ctx.status = 400
    ctx.body = { error: 'Invalid path' }
    return
  }

  const filePath = join(CRON_OUTPUT, jobId, fileName)

  if (!existsSync(filePath)) {
    ctx.status = 404
    ctx.body = { error: 'Run output not found' }
    return
  }

  try {
    const content = await readFile(filePath, 'utf-8')
    const match = fileName.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.md$/)
    const runTime = match ? `${match[1]} ${match[2].replace(/-/g, ':')}` : fileName

    ctx.body = { jobId, fileName, runTime, content } satisfies RunDetail
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

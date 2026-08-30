import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EKKO_LOG_FILE_NAME,
  EkkoFileLogReader,
  EkkoFileLogger,
} from '../../packages/ekko-agent/src'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ekko-file-logger-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('EkkoFileLogger', () => {
  it('writes redacted JSONL and queries structured records', async () => {
    let tick = 0
    const logger = new EkkoFileLogger({
      directory: root,
      now: () => new Date(Date.UTC(2026, 6, 27, 4, 0, tick++)),
    })
    expect(logger.write({
      category: 'model',
      event: 'model.started',
      profile: 'default',
      sessionId: 'session-1',
      runId: 'run-1',
      data: {
        apiKey: 'top-secret',
        accessToken: 'oauth-access-secret',
        refreshToken: 'oauth-refresh-secret',
        clientSecret: 'oauth-client-secret',
        header: 'Bearer actual-token',
      },
    })).toBe(true)
    expect(logger.write({
      category: 'tool',
      event: 'tool.failed',
      level: 'warn',
      profile: 'default',
      sessionId: 'session-2',
      runId: 'run-2',
      data: { error: 'timed out' },
    })).toBe(true)

    const raw = await readFile(join(root, EKKO_LOG_FILE_NAME), 'utf8')
    expect(raw).not.toContain('top-secret')
    expect(raw).not.toContain('actual-token')
    expect(raw).not.toContain('oauth-access-secret')
    expect(raw).not.toContain('oauth-refresh-secret')
    expect(raw).not.toContain('oauth-client-secret')
    expect(raw).toContain('[REDACTED]')
    expect(logger.query({ sessionId: 'session-1' })).toMatchObject([
      {
        category: 'model',
        event: 'model.started',
        sessionId: 'session-1',
        runId: 'run-1',
      },
    ])
    expect(logger.query({ level: 'warn', text: 'timed out' })).toHaveLength(1)
    expect(logger.query({ limit: 1 })[0]).toMatchObject({ sessionId: 'session-2' })
  })

  it('keeps one file and discards old content when the size limit is reached', async () => {
    const logger = new EkkoFileLogger({ directory: root, maxBytes: 700 })
    logger.write({
      category: 'tool',
      event: 'tool.started',
      sessionId: 'old-session',
      data: { output: 'x'.repeat(450) },
    })
    logger.write({
      category: 'run',
      event: 'run.completed',
      sessionId: 'current-session',
      data: { output: 'y'.repeat(180) },
    })

    expect(await readdir(root)).toEqual([EKKO_LOG_FILE_NAME])
    const raw = await readFile(join(root, EKKO_LOG_FILE_NAME), 'utf8')
    expect(raw).not.toContain('old-session')
    expect(raw).toContain('log.size_limit_reset')
    expect(raw).toContain('current-session')
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(700)
  })

  it('does not create files or directories when opened for reading', () => {
    const missingDirectory = join(root, 'missing')
    const reader = new EkkoFileLogReader({ directory: missingDirectory })

    expect(reader.query()).toEqual([])
    expect(existsSync(missingDirectory)).toBe(false)
  })

  it('degrades without throwing when the log directory is blocked', async () => {
    const blockedDirectory = join(root, 'blocked')
    await rm(root, { recursive: true })
    await writeFile(root, 'not a directory')
    const errors: unknown[] = []

    const logger = new EkkoFileLogger({
      directory: blockedDirectory,
      onError: error => errors.push(error),
    })

    expect(logger.write({ category: 'system', event: 'logging.degraded' })).toBe(false)
    expect(errors.length).toBeGreaterThanOrEqual(2)
  })
})

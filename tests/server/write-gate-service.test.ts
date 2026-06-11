import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const originalHermesHome = process.env.HERMES_HOME
let hermesHome = ''

async function loadService() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/services/hermes/write-gate')
}

beforeEach(async () => {
  hermesHome = await mkdtemp(join(tmpdir(), 'hermes-write-gate-'))
})

afterEach(async () => {
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  await rm(hermesHome, { recursive: true, force: true })
  hermesHome = ''
})

describe('write gate service', () => {
  it('lists pending memory and skill records from the active profile', async () => {
    await mkdir(join(hermesHome, 'pending', 'memory'), { recursive: true })
    await mkdir(join(hermesHome, 'pending', 'skills'), { recursive: true })
    await writeFile(join(hermesHome, 'pending', 'memory', 'mem123.json'), JSON.stringify({
      id: 'mem123',
      subsystem: 'memory',
      action: 'add',
      summary: 'remember concise answers',
      origin: 'foreground',
      created_at: 2,
      payload: { target: 'user' },
    }), 'utf-8')
    await writeFile(join(hermesHome, 'pending', 'skills', 'skill123.json'), JSON.stringify({
      id: 'skill123',
      subsystem: 'skills',
      action: 'patch',
      summary: 'patch demo skill',
      origin: 'background_review',
      created_at: 1,
      payload: { name: 'demo' },
    }), 'utf-8')

    const { listPendingWrites } = await loadService()
    const result = await listPendingWrites('default')

    expect(result.counts).toEqual({ memory: 1, skills: 1 })
    expect(result.records.map(record => record.id)).toEqual(['skill123', 'mem123'])
    expect(result.records[0]).toMatchObject({
      subsystem: 'skills',
      summary: 'patch demo skill',
      payload: { name: 'demo' },
    })
  })

  it('rejects unsafe subsystem and pending ids before running Hermes Python', async () => {
    const { getPendingWriteDiff } = await loadService()

    await expect(getPendingWriteDiff('default', 'files', 'abc123')).rejects.toThrow('Invalid write gate subsystem')
    await expect(getPendingWriteDiff('default', 'memory', '../abc')).rejects.toThrow('Invalid pending write id')
  })
})

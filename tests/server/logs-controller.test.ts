import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EkkoFileLogReader, EkkoFileLogger } from '../../packages/ekko-agent/src'

const mocks = vi.hoisted(() => ({
  appHome: `/tmp/hermes-web-ui-logs-controller-${process.pid}`,
  listLogFiles: vi.fn(async () => []),
  readLogs: vi.fn(async () => ''),
  hermesAvailable: true,
}))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: { appHome: mocks.appHome },
}))

vi.mock('../../packages/server/src/modules/studio/public/agent-logs', () => ({
  listPrimaryAgentLogFiles: mocks.listLogFiles,
  readPrimaryAgentLogs: mocks.readLogs,
  getEkkoLogSource: (profile: string) => {
    const directory = join(mocks.appHome, '.ekko', 'logs', profile)
    return new EkkoFileLogReader({ directory })
  },
}))

vi.mock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({
  isHermesAgentAvailable: vi.fn(() => mocks.hermesAvailable),
}))

describe('Hermes logs controller Ekko source', () => {
  beforeAll(async () => {
    await rm(mocks.appHome, { recursive: true, force: true })
    await mkdir(mocks.appHome, { recursive: true })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hermesAvailable = true
  })

  afterAll(async () => {
    await rm(mocks.appHome, { recursive: true, force: true })
  })

  it('lists and reads the current profile Ekko log through the existing logs API', async () => {
    const directory = join(mocks.appHome, '.ekko', 'logs', 'work')
    const logger = new EkkoFileLogger({ directory })
    logger.write({
      category: 'model',
      event: 'model.started',
      profile: 'work',
      sessionId: 'session-other',
      runId: 'run-other',
    })
    logger.write({
      category: 'tool',
      event: 'tool.failed',
      level: 'warn',
      profile: 'work',
      sessionId: 'session-target',
      runId: 'run-target',
      data: { error: 'timed out' },
    })

    const controller = await import('../../packages/server/src/modules/studio/controllers/logs')
    const listContext: any = {
      state: { profile: { name: 'work' } },
      query: {},
      body: null,
    }
    await controller.list(listContext)
    expect(listContext.body.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ekko-agent' }),
    ]))

    const readContext: any = {
      state: { profile: { name: 'work' } },
      params: { name: 'ekko-agent' },
      query: { lines: '100', session: 'session-target', level: 'WARNING' },
      body: null,
    }
    await controller.read(readContext)

    expect(readContext.body.entries).toHaveLength(1)
    expect(readContext.body.entries[0]).toMatchObject({
      level: 'WARNING',
      logger: 'ekko-agent/tool',
    })
    expect(readContext.body.entries[0].message).toContain('tool.failed')
    expect(readContext.body.entries[0].message).toContain('session=session-target')
  })

  it('keeps Studio logs but does not query Hermes logs when Hermes is unavailable', async () => {
    mocks.hermesAvailable = false
    const controller = await import('../../packages/server/src/modules/studio/controllers/logs')
    const listContext: any = { state: { profile: { name: 'work' } }, query: {}, body: null }

    await controller.list(listContext)

    expect(mocks.listLogFiles).not.toHaveBeenCalled()
    expect(listContext.body.files.map((file: any) => file.name)).not.toContain('agent')

    const readContext: any = {
      params: { name: 'agent' },
      query: { lines: '100' },
      body: null,
    }
    await controller.read(readContext)

    expect(mocks.readLogs).not.toHaveBeenCalled()
    expect(readContext.body).toEqual({ entries: [] })
  })
})

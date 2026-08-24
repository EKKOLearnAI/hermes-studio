import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('session push setting store', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  it('defaults new sessions to not pushed and persists changes', async () => {
    const { createSession, getSession, setSessionPushEnabled } = await import(
      '../../packages/server/src/db/hermes/session-store'
    )

    createSession({ id: 'session-1' })
    expect(getSession('session-1')?.push_enabled).toBe(0)

    expect(setSessionPushEnabled('session-1', true)).toBe(true)
    expect(getSession('session-1')?.push_enabled).toBe(1)

    expect(setSessionPushEnabled('session-1', false)).toBe(true)
    expect(getSession('session-1')?.push_enabled).toBe(0)
  })
})

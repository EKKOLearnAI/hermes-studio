import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('session pin preferences store', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('keeps pins isolated by authenticated user and profile', async () => {
    const { listSessionPins, setSessionPinned } = await import(
      '../../packages/server/src/modules/studio/repositories/session-pin-preferences-store'
    )

    setSessionPinned(7, 'default', 'desktop-pin', true)
    setSessionPinned(7, 'work', 'work-pin', true)
    setSessionPinned(8, 'default', 'other-user-pin', true)

    expect(listSessionPins(7, 'default')).toEqual(['desktop-pin'])
    expect(listSessionPins(7, 'work')).toEqual(['work-pin'])
    expect(listSessionPins(8, 'default')).toEqual(['other-user-pin'])
  })

  it('merges legacy device pins without overwriting pins from another device', async () => {
    const { listSessionPins, mergeSessionPins, setSessionPinned } = await import(
      '../../packages/server/src/modules/studio/repositories/session-pin-preferences-store'
    )

    setSessionPinned(7, 'default', 'mobile-pin', true)
    expect(mergeSessionPins(7, 'default', ['desktop-pin', 'mobile-pin'])).toEqual([
      'mobile-pin',
      'desktop-pin',
    ])
    expect(listSessionPins(7, 'default')).toEqual(['mobile-pin', 'desktop-pin'])
  })

  it('removes only the requested pin', async () => {
    const { listSessionPins, mergeSessionPins, setSessionPinned } = await import(
      '../../packages/server/src/modules/studio/repositories/session-pin-preferences-store'
    )

    mergeSessionPins(7, 'default', ['one', 'two'])
    setSessionPinned(7, 'default', 'one', false)

    expect(listSessionPins(7, 'default')).toEqual(['two'])
  })

  it('atomically imports legacy pins with the first pin mutation', async () => {
    const { listSessionPins, setSessionPinned } = await import(
      '../../packages/server/src/modules/studio/repositories/session-pin-preferences-store'
    )

    expect(setSessionPinned(7, 'default', 'new-pin', true, ['legacy-pin'])).toEqual([
      'legacy-pin',
      'new-pin',
    ])
    expect(listSessionPins(7, 'default')).toEqual(['legacy-pin', 'new-pin'])
  })
})

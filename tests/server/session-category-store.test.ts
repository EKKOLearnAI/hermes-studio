import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('session category store', () => {
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

  it('creates normalized global categories without case-insensitive duplicates', async () => {
    const { createSessionCategory, listSessionCategories } = await import(
      '../../packages/server/src/db/hermes/session-category-store'
    )

    const created = createSessionCategory('  Client   Work  ')
    const existing = createSessionCategory('client work')

    expect(created.name).toBe('Client Work')
    expect(existing.id).toBe(created.id)
    expect(listSessionCategories()).toEqual([created])
  })

  it('stores one nullable category id directly on a session', async () => {
    const { createSessionCategory, deleteSessionCategory, renameSessionCategory, setSessionCategory } = await import(
      '../../packages/server/src/db/hermes/session-category-store'
    )
    const { createSession, getSession } = await import('../../packages/server/src/db/hermes/session-store')
    const category = createSessionCategory('Work')
    createSession({ id: 'session-1', profile: 'profile-a', category_id: category.id })
    createSession({ id: 'session-2', profile: 'profile-b', category_id: category.id })

    expect(getSession('session-1')?.category_id).toBe(category.id)
    expect(getSession('session-2')?.category_id).toBe(category.id)
    expect(setSessionCategory('session-1', null)).toBe(true)
    expect(getSession('session-1')?.category_id).toBeNull()
    expect(setSessionCategory('session-1', 999)).toBe(false)

    const renamed = renameSessionCategory(category.id, 'Client Work')
    expect(renamed?.name).toBe('Client Work')
    expect(setSessionCategory('session-1', category.id)).toBe(true)
    expect(deleteSessionCategory(category.id)).toBe(true)
    expect(getSession('session-1')?.category_id).toBeNull()
  })
})

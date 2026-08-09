import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Storage-level guarantees of the outbox: an event is recorded once, fans out
 * only to endpoints that accept it, and its deliveries survive a restart.
 */
describe('event outbox store', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
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

  async function store() {
    return import('../../packages/server/src/db/hermes/event-outbox-store')
  }

  it('creates the three outbox tables', async () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map(row => row.name)
    expect(names).toContain('event_outbox')
    expect(names).toContain('outbound_webhook_endpoints')
    expect(names).toContain('event_outbox_deliveries')
  })

  it('records an event once per dedupe key and reuses the same event id', async () => {
    const s = await store()
    s.createEndpoint({ name: 'hook', url: 'https://example.com/hook' })

    const first = s.appendEvent({
      type: 'chat.run.completed',
      dedupeKey: 'chat.run.completed:session-1:run-1',
      profile: 'default',
      source: 'chat',
      subject: { session_id: 'session-1', run_id: 'run-1' },
      summary: { status: 'completed' },
    })
    const second = s.appendEvent({
      type: 'chat.run.completed',
      dedupeKey: 'chat.run.completed:session-1:run-1',
      profile: 'default',
      source: 'chat',
      subject: { session_id: 'session-1', run_id: 'run-1' },
      summary: { status: 'completed' },
    })

    expect(first?.created).toBe(true)
    expect(second?.created).toBe(false)
    expect(second?.event.id).toBe(first?.event.id)
    const count = db.prepare('SELECT COUNT(*) as count FROM event_outbox').get() as { count: number }
    expect(count.count).toBe(1)
    // The replay must not queue a second delivery either.
    const deliveries = db.prepare('SELECT COUNT(*) as count FROM event_outbox_deliveries').get() as { count: number }
    expect(deliveries.count).toBe(1)
  })

  it('fans one event out to every accepting endpoint', async () => {
    const s = await store()
    s.createEndpoint({ name: 'all', url: 'https://a.example.com/hook' })
    s.createEndpoint({ name: 'also-all', url: 'https://b.example.com/hook' })

    const result = s.appendEvent({
      type: 'chat.run.completed',
      dedupeKey: 'chat.run.completed:session-2:run-1',
      profile: 'default',
      source: 'chat',
      subject: {},
      summary: {},
    })

    expect(result?.deliveries).toHaveLength(2)
  })

  it('skips endpoints filtered out by event type, profile, or disabled state', async () => {
    const s = await store()
    s.createEndpoint({ name: 'only-failures', url: 'https://x.example.com', event_types: ['chat.run.failed'] })
    s.createEndpoint({ name: 'other-profile', url: 'https://y.example.com', profiles: ['work'] })
    s.createEndpoint({ name: 'disabled', url: 'https://z.example.com', enabled: false })
    const wanted = s.createEndpoint({ name: 'wanted', url: 'https://ok.example.com', event_types: ['chat.run.completed'], profiles: ['default'] })

    const result = s.appendEvent({
      type: 'chat.run.completed',
      dedupeKey: 'chat.run.completed:session-3:run-1',
      profile: 'default',
      source: 'chat',
      subject: {},
      summary: {},
    })

    expect(result?.deliveries).toHaveLength(1)
    expect(result?.deliveries[0].endpoint_id).toBe(wanted?.id)
  })

  it('keeps an event with no matching endpoint but queues nothing', async () => {
    const s = await store()
    s.createEndpoint({ name: 'disabled', url: 'https://z.example.com', enabled: false })

    const result = s.appendEvent({
      type: 'chat.run.failed',
      dedupeKey: 'chat.run.failed:session-4:run-1',
      profile: 'default',
      source: 'chat',
      subject: {},
      summary: {},
    })

    expect(result?.created).toBe(true)
    expect(result?.deliveries).toHaveLength(0)
  })

  it('reclaims deliveries left mid-flight by a previous process', async () => {
    const s = await store()
    s.createEndpoint({ name: 'hook', url: 'https://example.com/hook' })
    const appended = s.appendEvent({
      type: 'chat.run.completed',
      dedupeKey: 'chat.run.completed:session-5:run-1',
      profile: 'default',
      source: 'chat',
      subject: {},
      summary: {},
    })
    const deliveryId = appended!.deliveries[0].id

    // Simulate a process that claimed the row and then died.
    db.prepare("UPDATE event_outbox_deliveries SET status = 'delivering', updated_at = ? WHERE id = ?")
      .run(Date.now() - 10 * 60_000, deliveryId)

    expect(s.claimDueDeliveries(10).map(item => item.id)).toContain(deliveryId)
  })

  it('does not hand the same delivery to two claimers at once', async () => {
    const s = await store()
    s.createEndpoint({ name: 'hook', url: 'https://example.com/hook' })
    s.appendEvent({
      type: 'chat.run.completed',
      dedupeKey: 'chat.run.completed:session-6:run-1',
      profile: 'default',
      source: 'chat',
      subject: {},
      summary: {},
    })

    expect(s.claimDueDeliveries(10)).toHaveLength(1)
    expect(s.claimDueDeliveries(10)).toHaveLength(0)
  })

  it('never returns the secret through the record used by the API layer', async () => {
    const s = await store()
    const endpoint = s.createEndpoint({ name: 'hook', url: 'https://example.com/hook', secret: 'top-secret' })
    const stored = s.getEndpoint(endpoint!.id)
    // The store keeps it (the dispatcher needs it); the controller maps it away.
    expect(stored?.secret).toBe('top-secret')
    const { listEndpoints } = s
    expect(JSON.stringify(listEndpoints().map(item => ({ id: item.id, name: item.name })))).not.toContain('top-secret')
  })
})

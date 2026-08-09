import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'crypto'

/**
 * Delivery behaviour: signing, retry classification, restart recovery, and the
 * promise that a default payload carries no conversation content.
 */
describe('event outbox dispatcher', () => {
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

  function jsonResponse(status: number, body = '') {
    return {
      status,
      ok: status >= 200 && status < 300,
      async text() { return body },
    } as any
  }

  async function modules() {
    const store = await import('../../packages/server/src/db/hermes/event-outbox-store')
    const dispatcher = await import('../../packages/server/src/services/hermes/event-outbox/dispatcher')
    return { store, dispatcher }
  }

  async function seedEvent(store: any, overrides: Record<string, unknown> = {}) {
    return store.appendEvent({
      type: 'chat.run.completed',
      dedupeKey: `chat.run.completed:session-1:${Math.random()}`,
      profile: 'default',
      source: 'chat',
      subject: { session_id: 'session-1', run_id: 'run-1' },
      summary: { status: 'completed', input_tokens: 10, output_tokens: 20 },
      ...overrides,
    })
  }

  it('marks a 2xx as delivered and stops retrying', async () => {
    const { store, dispatcher } = await modules()
    store.createEndpoint({ name: 'hook', url: 'https://example.com/hook' })
    await seedEvent(store)

    const fetchImpl = vi.fn(async () => jsonResponse(204))
    const runner = new dispatcher.EventOutboxDispatcher({ fetchImpl: fetchImpl as any })
    expect(await runner.tick()).toBe(1)

    const rows = db.prepare('SELECT status, attempts FROM event_outbox_deliveries').all() as any[]
    expect(rows[0].status).toBe('delivered')
    expect(rows[0].attempts).toBe(1)
    expect(await runner.tick()).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('signs the body with HMAC-SHA256 over timestamp + "." + rawBody', async () => {
    const { store, dispatcher } = await modules()
    store.createEndpoint({ name: 'hook', url: 'https://example.com/hook', secret: 'shhh' })
    await seedEvent(store)

    let captured: any = null
    const fetchImpl = vi.fn(async (_url: string, init: any) => { captured = init; return jsonResponse(200) })
    await new dispatcher.EventOutboxDispatcher({ fetchImpl: fetchImpl as any }).tick()

    const timestamp = captured.headers['X-Hermes-Timestamp']
    const signature = captured.headers['X-Hermes-Signature-256']
    const expected = `sha256=${createHmac('sha256', 'shhh').update(`${timestamp}.${captured.body}`).digest('hex')}`
    expect(signature).toBe(expected)
    expect(dispatcher.verifySignature('shhh', timestamp, captured.body, signature)).toBe(true)
    expect(dispatcher.verifySignature('wrong', timestamp, captured.body, signature)).toBe(false)
    expect(captured.headers['X-Hermes-Event']).toBe('chat.run.completed')
    expect(captured.headers['X-Hermes-Delivery']).toBeTruthy()
    expect(captured.redirect).toBe('manual')
  })

  it('omits the signature header when no secret is configured', async () => {
    const { store, dispatcher } = await modules()
    store.createEndpoint({ name: 'hook', url: 'https://example.com/hook' })
    await seedEvent(store)

    let captured: any = null
    const fetchImpl = vi.fn(async (_url: string, init: any) => { captured = init; return jsonResponse(200) })
    await new dispatcher.EventOutboxDispatcher({ fetchImpl: fetchImpl as any }).tick()

    expect(captured.headers['X-Hermes-Signature-256']).toBeUndefined()
  })

  it('prefers a secret named by secret_env over a stored one', async () => {
    const { store, dispatcher } = await modules()
    const endpoint = store.createEndpoint({
      name: 'hook',
      url: 'https://example.com/hook',
      secret: 'stored',
      secret_env: 'MY_HOOK_SECRET',
    })
    expect(dispatcher.resolveEndpointSecret(endpoint!, { MY_HOOK_SECRET: 'from-env' } as any)).toBe('from-env')
    expect(dispatcher.resolveEndpointSecret(endpoint!, {} as any)).toBe('stored')
  })

  it('retries a 500 and delivers on the next attempt', async () => {
    const { store, dispatcher } = await modules()
    store.createEndpoint({ name: 'hook', url: 'https://example.com/hook' })
    await seedEvent(store)

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(500, 'boom'))
      .mockResolvedValueOnce(jsonResponse(200))
    const runner = new dispatcher.EventOutboxDispatcher({ fetchImpl: fetchImpl as any })

    await runner.tick()
    let row = db.prepare('SELECT status, attempts, next_attempt_at, last_status_code FROM event_outbox_deliveries').get() as any
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.last_status_code).toBe(500)
    expect(row.next_attempt_at).toBeGreaterThan(Date.now())

    // Make it due again, as the backoff would after waiting.
    db.prepare('UPDATE event_outbox_deliveries SET next_attempt_at = ?').run(Date.now() - 1)
    await runner.tick()
    row = db.prepare('SELECT status, attempts FROM event_outbox_deliveries').get() as any
    expect(row.status).toBe('delivered')
    expect(row.attempts).toBe(2)
  })

  it('retries network failures, 408 and 429 but not a 400', async () => {
    const { dispatcher } = await modules()
    expect(dispatcher.isRetryableStatus(408)).toBe(true)
    expect(dispatcher.isRetryableStatus(429)).toBe(true)
    expect(dispatcher.isRetryableStatus(503)).toBe(true)
    expect(dispatcher.isRetryableStatus(400)).toBe(false)
    expect(dispatcher.isRetryableStatus(404)).toBe(false)
  })

  it('dead-letters a permanent failure without further attempts', async () => {
    const { store, dispatcher } = await modules()
    store.createEndpoint({ name: 'hook', url: 'https://example.com/hook' })
    await seedEvent(store)

    const fetchImpl = vi.fn(async () => jsonResponse(400, 'bad request'))
    const runner = new dispatcher.EventOutboxDispatcher({ fetchImpl: fetchImpl as any })
    await runner.tick()

    const row = db.prepare('SELECT status, last_status_code FROM event_outbox_deliveries').get() as any
    expect(row.status).toBe('dead')
    expect(row.last_status_code).toBe(400)
    await runner.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('dead-letters once max_attempts is exhausted', async () => {
    const { store, dispatcher } = await modules()
    store.createEndpoint({ name: 'hook', url: 'https://example.com/hook', max_attempts: 2 })
    await seedEvent(store)

    const fetchImpl = vi.fn(async () => jsonResponse(500, 'still down'))
    const runner = new dispatcher.EventOutboxDispatcher({ fetchImpl: fetchImpl as any })

    await runner.tick()
    db.prepare('UPDATE event_outbox_deliveries SET next_attempt_at = ?').run(Date.now() - 1)
    await runner.tick()

    const row = db.prepare('SELECT status, attempts FROM event_outbox_deliveries').get() as any
    expect(row.status).toBe('dead')
    expect(row.attempts).toBe(2)
  })

  it('picks up deliveries left behind by a restart', async () => {
    const { store, dispatcher } = await modules()
    store.createEndpoint({ name: 'hook', url: 'https://example.com/hook' })
    const appended = await seedEvent(store)
    // A previous process claimed this row and never came back.
    db.prepare("UPDATE event_outbox_deliveries SET status = 'delivering', updated_at = ? WHERE id = ?")
      .run(Date.now() - 10 * 60_000, appended!.deliveries[0].id)

    const fetchImpl = vi.fn(async () => jsonResponse(200))
    expect(await new dispatcher.EventOutboxDispatcher({ fetchImpl: fetchImpl as any }).tick()).toBe(1)
    const row = db.prepare('SELECT status FROM event_outbox_deliveries').get() as any
    expect(row.status).toBe('delivered')
  })

  it('backs off exponentially with jitter, bounded below and above', async () => {
    const { dispatcher } = await modules()
    const low = dispatcher.nextBackoffMs(0, () => 0)
    const high = dispatcher.nextBackoffMs(0, () => 1)
    expect(low).toBeGreaterThanOrEqual(5_000)
    expect(high).toBeGreaterThanOrEqual(low)
    expect(dispatcher.nextBackoffMs(3, () => 1)).toBeGreaterThan(dispatcher.nextBackoffMs(1, () => 1))
    expect(dispatcher.nextBackoffMs(50, () => 1)).toBeLessThanOrEqual(60 * 60_000)
  })

  it('sends identifiers and counts, never message content', async () => {
    const { store, dispatcher } = await modules()
    store.createEndpoint({ name: 'hook', url: 'https://example.com/hook' })
    await seedEvent(store, {
      summary: { status: 'completed', input_tokens: 10, output_tokens: 20 },
    })

    let captured: any = null
    const fetchImpl = vi.fn(async (_url: string, init: any) => { captured = init; return jsonResponse(200) })
    await new dispatcher.EventOutboxDispatcher({ fetchImpl: fetchImpl as any }).tick()

    const body = JSON.parse(captured.body)
    expect(body.schema_version).toBe(1)
    expect(body.type).toBe('chat.run.completed')
    expect(body.subject.session_id).toBe('session-1')
    expect(body.summary.output_tokens).toBe(20)
    // No field anywhere in the envelope may carry the conversation itself.
    for (const key of ['content', 'message', 'messages', 'output', 'text', 'prompt', 'instructions']) {
      expect(JSON.stringify(body)).not.toContain(`"${key}"`)
    }
  })

  it('leaves a disabled endpoint queue intact instead of dropping it', async () => {
    const { store, dispatcher } = await modules()
    const endpoint = store.createEndpoint({ name: 'hook', url: 'https://example.com/hook' })
    await seedEvent(store)
    store.updateEndpoint(endpoint!.id, { enabled: false })

    const fetchImpl = vi.fn(async () => jsonResponse(200))
    await new dispatcher.EventOutboxDispatcher({ fetchImpl: fetchImpl as any }).tick()

    expect(fetchImpl).not.toHaveBeenCalled()
    const row = db.prepare('SELECT status FROM event_outbox_deliveries').get() as any
    expect(row.status).toBe('pending')
  })
})

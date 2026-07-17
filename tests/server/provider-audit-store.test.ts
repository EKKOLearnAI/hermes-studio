import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync | null = null

beforeEach(() => {
  vi.resetModules()
  db = new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/db/index', () => ({
    getDb: () => db,
    getStoragePath: () => ':memory:',
  }))
})

afterEach(() => {
  vi.doUnmock('../../packages/server/src/db/index')
  vi.resetModules()
  db?.close()
  db = null
})

describe('provider audit store', () => {
  it('stores structured audit events without credential material', async () => {
    const sensitiveValue = ['sensitive', 'value'].join('-')
    const { appendProviderAuditEvent, listProviderAuditEvents } = await import(
      '../../packages/server/src/db/hermes/provider-audit-store'
    )

    appendProviderAuditEvent({
      actor: { id: 7, username: 'operator', role: 'admin' },
      profile: 'research',
      providerId: 'custom:research',
      providerLabel: 'Research',
      action: 'provider.editor.update',
      fields: ['base_url', 'api_key_replaced'],
      details: {
        api_key: sensitiveValue,
        nested: { authorization: sensitiveValue },
        base_url: 'https://user:pass@example.com/v1?credential=visible#fragment',
        model_count: 12,
      },
      revisionBefore: 'before',
      revisionAfter: 'after',
    })

    const events = listProviderAuditEvents({ profile: 'research' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actor_user_id: 7,
      actor_username: 'operator',
      actor_role: 'admin',
      profile: 'research',
      provider_id: 'custom:research',
      action: 'provider.editor.update',
      fields: ['base_url', 'api_key_replaced'],
      revision_before: 'before',
      revision_after: 'after',
    })
    expect(events[0].details).toEqual({
      api_key: '[redacted]',
      nested: { authorization: '[redacted]' },
      base_url: 'https://example.com/v1',
      model_count: 12,
    })
    expect(JSON.stringify(events)).not.toContain(sensitiveValue)
  })

  it('enforces the 90-day retention boundary when appending events', async () => {
    const { appendProviderAuditEvent, listProviderAuditEvents } = await import(
      '../../packages/server/src/db/hermes/provider-audit-store'
    )
    const now = Date.now()
    appendProviderAuditEvent({
      profile: 'default',
      providerId: 'deepseek',
      action: 'old-event',
      createdAt: now - 91 * 24 * 60 * 60 * 1000,
    })
    appendProviderAuditEvent({
      profile: 'default',
      providerId: 'deepseek',
      action: 'current-event',
      createdAt: now,
    })

    expect(listProviderAuditEvents({ providerId: 'deepseek' }).map(event => event.action))
      .toEqual(['current-event'])
  })
})

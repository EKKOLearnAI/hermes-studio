import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  appendFabricAuditEvent,
  appendFabricOutbox,
  claimPendingFabricOutbox,
  getFabricControlState,
  listFabricAuditEvents,
  listPendingFabricOutbox,
  markFabricOutboxPublished,
  setFabricEmergencyStop,
  verifyFabricAuditChain,
  withActionFabricDb,
} from '../../packages/server/src/services/hermes/action-fabric'

describe('action fabric audit, outbox, and control', () => {
  const originalHermesHome = process.env.HERMES_HOME
  const originalAuditKey = process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-fabric-audit-'))
    process.env.HERMES_HOME = hermesHome
    delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (originalAuditKey === undefined) delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    else process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = originalAuditKey
    rmSync(hermesHome, { recursive: true, force: true })
  })

  const append = (payload: Record<string, unknown>, eventType = 'workflow.created') => withActionFabricDb(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const event = appendFabricAuditEvent(db, {
        eventType,
        actorUserId: 'user-1',
        aggregateType: 'workflow',
        aggregateId: 'workflow-1',
        payload,
        occurredAt: '2026-07-12T00:00:00.000Z',
      })
      db.exec('COMMIT')
      return event
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })

  it('canonicalizes object keys and chains deterministic immutable event hashes', () => {
    process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = 'deterministic-test-audit-key-32-bytes'
    const first = append({ z: 1, nested: { b: true, a: 'x' } })
    const second = append({ nested: { a: 'x', b: true }, z: 1 }, 'workflow.updated')

    expect(first).toMatchObject({ sequence: 1, previousHash: '0'.repeat(64) })
    expect(first.id).toMatch(/^audit-1-[a-f0-9]{24}$/)
    expect(second.sequence).toBe(2)
    expect(second.previousHash).toBe(first.hash)
    expect(verifyFabricAuditChain()).toEqual({ valid: true, checked: 2, firstInvalidSequence: null })

    const secondHome = mkdtempSync(join(tmpdir(), 'hwui-fabric-audit-determinism-'))
    process.env.HERMES_HOME = secondHome
    try {
      expect(append({ nested: { a: 'x', b: true }, z: 1 }).hash).toBe(first.hash)
    } finally {
      rmSync(secondHome, { recursive: true, force: true })
      process.env.HERMES_HOME = hermesHome
    }
  })

  it.each([
    ['tampering', "UPDATE fabric_audit_events SET payload_json='{}' WHERE sequence=1"],
    ['deletion', 'DELETE FROM fabric_audit_events WHERE sequence=2'],
    ['reordering', 'UPDATE fabric_audit_events SET sequence=9 WHERE sequence=1'],
  ])('detects direct database %s', (_label, mutation) => {
    append({ state: 'draft' })
    append({ state: 'running' }, 'workflow.updated')
    withActionFabricDb(db => db.exec(mutation))

    expect(verifyFabricAuditChain()).toMatchObject({ valid: false })
  })

  it('refuses to append over a deleted audit tail', () => {
    append({ state: 'draft' })
    append({ state: 'running' }, 'workflow.updated')
    withActionFabricDb(db => db.exec('DELETE FROM fabric_audit_events WHERE sequence=2'))

    expect(() => append({ state: 'succeeded' }, 'workflow.updated')).toThrow('FABRIC_AUDIT_CHAIN_CORRUPT')
  })

  it('recursively redacts secrets, semantic key/value pairs, paths, connections, and raw errors', () => {
    append({
      benign: 'visible',
      nested: {
        password: 'hunter2', token: 'abc', api_key: 'secret-key', cookie: 'session=x', authorization: 'Bearer x',
        filePath: 'C:\\private\\secret.txt', connectionUri: 'postgres://user:pass@host/db',
        setting: { name: 'client_secret', value: 'semantic-secret', note: 'keep' },
        failure: new Error('raw failure at C:\\private\\secret.txt'),
      },
    })

    const payload = listFabricAuditEvents()[0].payload
    expect(payload.benign).toBe('visible')
    expect(JSON.stringify(payload)).not.toMatch(/hunter2|abc|secret-key|session=x|Bearer x|private|postgres|semantic-secret|raw failure/i)
    expect(JSON.stringify(payload)).toContain('[REDACTED]')
  })

  it('redacts credential and absolute-path content even below benign keys and inside arrays', () => {
    const sensitive = [
      'postgres://alice:password@db.example/app',
      'mysql://alice:password@db.example/app',
      'mssql://db.example/app',
      'sqlite:///C:/private/data.db',
      'jdbc:postgresql://alice:password@db.example/app',
      'mongodb+srv://alice:password@cluster.example/app',
      'redis://:password@cache.example/0',
      'amqps://alice:password@queue.example/vhost',
      'https://alice:password@example.com/private',
      'C:\\Users\\Alice\\private\\notes.txt',
      '\\\\server\\share\\private\\notes.txt',
      '/home/alice/.ssh/id_rsa',
      'file:///etc/passwd',
      'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
      'api_key=sk-live-secret-value',
      'sk-proj-AbCdEf0123456789secret',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123',
      '-----BEGIN PRIVATE KEY----- private material',
      'Database error: redis://:password@cache.example/0 at /var/log/service.log',
    ]
    append({ detail: sensitive[0], nested: [{ detail: sensitive.slice(1, 8) }, sensitive.slice(8)] })

    const payload = listFabricAuditEvents()[0].payload
    const encoded = JSON.stringify(payload)
    for (const value of sensitive) expect(encoded).not.toContain(value)
    const markers = encoded.match(/\[REDACTED\]/g) ?? []
    expect(markers.length).toBe(sensitive.length)
  })

  it('preserves benign prose, relative labels, and ordinary HTTPS URLs below benign detail keys', () => {
    const benign = [
      'Request completed normally',
      'postgres is the selected database family',
      'reports/weekly-summary.json',
      './fixtures/example.json',
      'docs/api/reference',
      'https://example.com/docs/getting-started?section=auth',
      'The key result is customer retention',
    ]
    append({ detail: benign[0], nested: [{ detail: benign.slice(1, 4) }, benign.slice(4)] })

    expect(listFabricAuditEvents()[0].payload).toEqual({
      detail: benign[0],
      nested: [{ detail: benign.slice(1, 4) }, benign.slice(4)],
    })
  })

  it('preserves benign bare key/value traceability but redacts semantic secret and path values', () => {
    append({
      preference: { key: 'theme', value: 'dark' },
      first: { key: 'apiKey', value: 'top-secret' },
      second: { name: 'workspacePath', value: '/workspace/private/project' },
    })

    expect(listFabricAuditEvents()[0].payload).toEqual({
      first: { key: 'apiKey', value: '[REDACTED]' },
      second: { name: 'workspacePath', value: '[REDACTED]' },
      preference: { key: 'theme', value: 'dark' },
    })
  })

  it('redacts general clearly absolute Unix paths without redacting relative labels or prose routes', () => {
    append({
      values: ['/usr/local/bin/tool', '/app/runtime/config.json', '/workspace/repo/file.ts', '/data/private/item'],
      relative: ['usr/local/bin/tool', 'workspace/repo/file.ts', 'See /docs/api/reference for help'],
    })
    expect(listFabricAuditEvents()[0].payload).toEqual({
      relative: ['usr/local/bin/tool', 'workspace/repo/file.ts', 'See /docs/api/reference for help'],
      values: ['[REDACTED]', '[REDACTED]', '[REDACTED]', '[REDACTED]'],
    })
  })

  it('bounds persisted JSON and rejects invalid or oversized scalar input', () => {
    const longA = append({ value: 'a'.repeat(4_000), list: Array.from({ length: 64 }, (_, index) => index) })
    const longB = append({ value: `${'a'.repeat(3_999)}b`, list: Array.from({ length: 64 }, (_, index) => index) }, 'workflow.other')
    const rows = listFabricAuditEvents()

    expect(JSON.stringify(rows[0].payload).length).toBeLessThan(40_000)
    expect(longA.hash).not.toBe(longB.hash)
    expect(() => append({ invalid: Number.NaN })).toThrow('FABRIC_AUDIT_INVALID_JSON')
    expect(() => append({ invalid: undefined })).toThrow('FABRIC_AUDIT_INVALID_JSON')
    expect(() => append({ value: 'x'.repeat(100_000) })).toThrow('FABRIC_AUDIT_INPUT_LIMIT')
  })

  it('truncates deep discarded subtrees early and rejects very wide input safely', () => {
    let deep: Record<string, unknown> = { leaf: 'not visited' }
    for (let index = 0; index < 10_000; index += 1) deep = { child: deep }

    expect(() => append({ deep })).not.toThrow()
    let boundary: object = new Proxy({}, {
      getPrototypeOf: () => { throw new Error('discarded subtree was inspected') },
    })
    for (let index = 0; index < 7; index += 1) boundary = { child: boundary }
    expect(() => append({ boundary }, 'workflow.boundary')).not.toThrow()
    const oversizedArray = new Proxy(new Array(10_000), {
      ownKeys: () => { throw new Error('discarded array keys were traversed') },
    })
    expect(() => append({ oversizedArray }, 'workflow.array')).toThrow('FABRIC_AUDIT_INPUT_LIMIT')
    expect(() => append({ wide: Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`key-${index}`, { nested: 'not visited' }]),
    ) }, 'workflow.wide')).toThrow('FABRIC_AUDIT_INPUT_LIMIT')
  })

  it('requires caller transactions and rolls audit plus outbox back together', () => {
    expect(() => withActionFabricDb(db => appendFabricAuditEvent(db, {
      eventType: 'test', actorUserId: 'user-1', aggregateType: 'system', aggregateId: 'system', payload: {},
    }))).toThrow('FABRIC_TRANSACTION_REQUIRED')

    expect(() => withActionFabricDb(db => {
      db.exec('BEGIN IMMEDIATE')
      try {
        appendFabricAuditEvent(db, {
          eventType: 'test', actorUserId: 'user-1', aggregateType: 'system', aggregateId: 'system', payload: {},
        })
        appendFabricOutbox(db, 'fabric.test', 'system', { ok: true })
        throw new Error('rollback')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    })).toThrow('rollback')
    expect(listFabricAuditEvents()).toEqual([])
    expect(listPendingFabricOutbox()).toEqual([])
  })

  it('lists pending outbox records observationally and publishes only a current matching claim', () => {
    withActionFabricDb(db => {
      db.exec('BEGIN IMMEDIATE')
      appendFabricOutbox(db, 'fabric.one', 'a', { order: 1 })
      appendFabricOutbox(db, 'fabric.two', 'b', { order: 2 })
      db.exec('COMMIT')
    })
    expect(listPendingFabricOutbox(1)).toHaveLength(1)
    expect(listPendingFabricOutbox(10).map(item => item.payload)).toEqual([{ order: 1 }, { order: 2 }])

    const claimed = claimPendingFabricOutbox({ limit: 1, leaseMs: 30_000, now: '2026-07-12T00:00:00.000Z' })
    const { id, claimToken } = claimed[0]
    expect(markFabricOutboxPublished(id, 'stale-token')).toBe(false)
    expect(markFabricOutboxPublished(id, claimToken, '2026-07-12T00:00:01.000Z')).toBe(true)
    expect(markFabricOutboxPublished(id, claimToken, '2026-07-12T00:00:02.000Z')).toBe(false)
    expect(listPendingFabricOutbox()).toHaveLength(1)
    expect(withActionFabricDb(db => db.prepare('SELECT status, attempts FROM fabric_outbox WHERE id=?').get(id)))
      .toEqual({ status: 'published', attempts: 1 })
  })

  it('atomically leases outbox records and reclaims the same immutable ID only after expiry', () => {
    withActionFabricDb(db => {
      db.exec('BEGIN IMMEDIATE')
      appendFabricOutbox(db, 'fabric.one', 'a', { order: 1 })
      db.exec('COMMIT')
    })
    const first = claimPendingFabricOutbox({ limit: 1, leaseMs: 1_000, now: '2026-07-12T00:00:00.000Z' })
    expect(first).toHaveLength(1)
    expect(claimPendingFabricOutbox({ limit: 1, leaseMs: 1_000, now: '2026-07-12T00:00:00.500Z' })).toEqual([])

    const reclaimed = claimPendingFabricOutbox({ limit: 1, leaseMs: 1_000, now: '2026-07-12T00:00:01.001Z' })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0].id).toBe(first[0].id)
    expect(reclaimed[0].claimToken).not.toBe(first[0].claimToken)
    expect(markFabricOutboxPublished(first[0].id, first[0].claimToken, '2026-07-12T00:00:01.100Z')).toBe(false)
    expect(markFabricOutboxPublished(reclaimed[0].id, reclaimed[0].claimToken, '2026-07-12T00:00:01.100Z')).toBe(true)
  })

  it('uses a stable private HMAC key outside the database and rejects invalid managed keys', () => {
    const first = append({ state: 'draft' })
    const keyPath = join(hermesHome, 'personal', '.action-fabric-audit-key')
    const key = readFileSync(keyPath, 'utf8')
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    if (process.platform !== 'win32') expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    expect(verifyFabricAuditChain()).toEqual({ valid: true, checked: 1, firstInvalidSequence: null })
    expect(listFabricAuditEvents()[0].hash).toBe(first.hash)

    process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = 'short'
    expect(() => verifyFabricAuditChain()).toThrow('FABRIC_AUDIT_KEY_INVALID')
  })

  it('does not accept a database-only attacker replacing event and head hashes with SHA-256', () => {
    append({ state: 'draft' })
    withActionFabricDb(db => {
      const forged = 'a'.repeat(64)
      db.prepare('UPDATE fabric_audit_events SET hash = ? WHERE sequence = 1').run(forged)
      db.prepare("UPDATE fabric_meta SET value = ? WHERE key = 'audit_chain_head'")
        .run(JSON.stringify({ hash: forged, sequence: 1 }))
    })
    expect(verifyFabricAuditChain()).toEqual({ valid: false, checked: 0, firstInvalidSequence: 1 })
    expect(() => append({ state: 'running' })).toThrow('FABRIC_AUDIT_CHAIN_CORRUPT')
  })

  it('refuses to silently mix an unmarked legacy audit format with HMAC events', () => {
    append({ state: 'draft' })
    withActionFabricDb(db => db.prepare("DELETE FROM fabric_meta WHERE key = 'audit_format'").run())

    expect(verifyFabricAuditChain()).toEqual({ valid: false, checked: 0, firstInvalidSequence: 1 })
    expect(() => append({ state: 'running' })).toThrow('FABRIC_AUDIT_FORMAT_MIGRATION_REQUIRED')
  })

  it('starts control at level zero and rejects stale concurrent updates', () => {
    expect(getFabricControlState()).toMatchObject({ level: 0, version: 0, actorUserId: null, reason: '' })
    expect(setFabricEmergencyStop(1, 'admin-1', 'maintenance', 0)).toMatchObject({ level: 1, version: 1 })
    expect(() => setFabricEmergencyStop(2, 'admin-2', 'stale', 0)).toThrow('FABRIC_CONTROL_VERSION_CONFLICT')
    expect(getFabricControlState()).toMatchObject({ level: 1, version: 1, actorUserId: 'admin-1' })
  })

  it('persists control, audit, and outbox atomically with bounded public values', () => {
    setFabricEmergencyStop(3, 'admin-1', 'external writes disabled', 0)

    expect(listFabricAuditEvents()).toHaveLength(1)
    expect(listFabricAuditEvents()[0]).toMatchObject({ eventType: 'control.emergency_stop.changed', aggregateType: 'control' })
    expect(listPendingFabricOutbox()).toHaveLength(1)
    expect(listPendingFabricOutbox()[0]).toMatchObject({ topic: 'fabric.control.changed', aggregateId: 'global' })
    expect(() => setFabricEmergencyStop(4 as 3, 'admin-1', 'invalid')).toThrow('FABRIC_CONTROL_INVALID_LEVEL')
    expect(() => setFabricEmergencyStop(1, '', 'invalid')).toThrow('FABRIC_CONTROL_INVALID_ACTOR')
    expect(() => setFabricEmergencyStop(1, 'admin-1', 'x'.repeat(2_001))).toThrow('FABRIC_CONTROL_INVALID_REASON')
  })
})

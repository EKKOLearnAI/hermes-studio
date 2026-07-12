import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  appendFabricAuditEvent,
  appendFabricOutbox,
  claimPendingFabricOutbox,
  getFabricControlState,
  listFabricAuditEvents,
  listPendingFabricOutbox,
  markFabricOutboxPublished,
  migrateLegacyFabricAuditChain,
  setFabricEmergencyStop,
  verifyFabricAuditChain,
  withFabricAuditedTransaction,
  withActionFabricDb,
} from '../../packages/server/src/services/hermes/action-fabric'

describe('action fabric audit, outbox, and control', () => {
  const originalHermesHome = process.env.HERMES_HOME
  const originalAuditKey = process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
  const originalLegacyHead = process.env.HERMES_ACTION_FABRIC_LEGACY_AUDIT_HEAD
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-fabric-audit-'))
    process.env.HERMES_HOME = hermesHome
    process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = 'audit-test-managed-key-at-least-32-bytes'
    delete process.env.HERMES_ACTION_FABRIC_LEGACY_AUDIT_HEAD
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (originalAuditKey === undefined) delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    else process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = originalAuditKey
    if (originalLegacyHead === undefined) delete process.env.HERMES_ACTION_FABRIC_LEGACY_AUDIT_HEAD
    else process.env.HERMES_ACTION_FABRIC_LEGACY_AUDIT_HEAD = originalLegacyHead
    rmSync(hermesHome, { recursive: true, force: true })
  })

  const append = (payload: Record<string, unknown>, eventType = 'workflow.created') => withFabricAuditedTransaction(db => {
      return appendFabricAuditEvent(db, {
        eventType,
        actorUserId: 'user-1',
        aggregateType: 'workflow',
        aggregateId: 'workflow-1',
        payload,
        occurredAt: '2026-07-12T00:00:00.000Z',
      })
  })

  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value !== null && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    }
    return JSON.stringify(value)
  }

  const plusMilliseconds = (timestamp: string, milliseconds: number) =>
    new Date(new Date(timestamp).getTime() + milliseconds).toISOString()

  const seedLegacyChain = () => withActionFabricDb(db => {
    db.exec('BEGIN IMMEDIATE')
    let previousHash = '0'.repeat(64)
    const hashes: string[] = []
    for (const sequence of [1, 2]) {
      const immutable = {
        sequence,
        eventType: sequence === 1 ? 'legacy.created' : 'legacy.updated',
        actorUserId: 'legacy-user',
        aggregateType: 'workflow',
        aggregateId: 'legacy-workflow',
        payload: { sequence, state: sequence === 1 ? 'draft' : 'running' },
        occurredAt: `2026-07-12T00:00:0${sequence}.000Z`,
        previousHash,
      }
      const hash = createHash('sha256').update(canonical(immutable)).digest('hex')
      db.prepare(`INSERT INTO fabric_audit_events(
        sequence,id,event_type,actor_user_id,aggregate_type,aggregate_id,payload_json,occurred_at,previous_hash,hash
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        sequence, `audit-${sequence}-${hash.slice(0, 24)}`, immutable.eventType, immutable.actorUserId,
        immutable.aggregateType, immutable.aggregateId, canonical(immutable.payload), immutable.occurredAt,
        previousHash, hash,
      )
      previousHash = hash
      hashes.push(hash)
    }
    db.prepare("INSERT INTO fabric_meta(key,value) VALUES ('audit_chain_head',?)")
      .run(canonical({ sequence: 2, hash: previousHash }))
    db.exec('COMMIT')
    return hashes
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

    expect(() => append({ state: 'succeeded' }, 'workflow.updated')).toThrow('FABRIC_AUDIT_ANCHOR_MISMATCH')
  })

  it('keeps audited append tail validation constant-query while explicit verification scans history', () => {
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    try {
      for (let index = 0; index < 40; index += 1) {
        append({ index }, `workflow.scale.${index}`)
      }
      const fullScansBeforeVerify = prepare.mock.calls.filter(([sql]) =>
        String(sql).includes('SELECT * FROM fabric_audit_events ORDER BY sequence ASC'))
      expect(fullScansBeforeVerify).toHaveLength(0)

      expect(verifyFabricAuditChain()).toEqual({ valid: true, checked: 40, firstInvalidSequence: null })
      const fullScansAfterVerify = prepare.mock.calls.filter(([sql]) =>
        String(sql).includes('SELECT * FROM fabric_audit_events ORDER BY sequence ASC'))
      expect(fullScansAfterVerify).toHaveLength(1)
    } finally {
      prepare.mockRestore()
    }
  })

  it('retains explicit full-chain detection for tampering before the validated tail window', () => {
    for (let index = 0; index < 5; index += 1) append({ index }, `workflow.history.${index}`)
    withActionFabricDb(db => db.prepare("UPDATE fabric_audit_events SET payload_json='{}' WHERE sequence=1").run())

    expect(verifyFabricAuditChain()).toMatchObject({ valid: false, firstInvalidSequence: 1 })
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

  it('redacts single-segment and embedded sensitive absolute paths while preserving API route prose', () => {
    append({
      values: ['/database.sqlite', 'failure at /builds/repo/db.sqlite', 'loaded /secrets.env during startup'],
      benign: ['/api/v1/profiles', 'Call /api/v1/profiles to continue', 'relative/database.sqlite'],
    })
    expect(listFabricAuditEvents()[0].payload).toEqual({
      benign: ['/api/v1/profiles', 'Call /api/v1/profiles to continue', 'relative/database.sqlite'],
      values: ['[REDACTED]', '[REDACTED]', '[REDACTED]'],
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
      } finally {
        db.exec('ROLLBACK')
      }
    })).toThrow('FABRIC_AUDITED_TRANSACTION_REQUIRED')

    expect(() => withFabricAuditedTransaction(db => {
        appendFabricAuditEvent(db, {
          eventType: 'test', actorUserId: 'user-1', aggregateType: 'system', aggregateId: 'system', payload: {},
        })
        appendFabricOutbox(db, 'fabric.test', 'system', { ok: true })
        throw new Error('rollback')
    })).toThrow('rollback')
    expect(listFabricAuditEvents()).toEqual([])
    expect(listPendingFabricOutbox()).toEqual([])
  })

  it('lists pending outbox records observationally and publishes only a current matching claim', () => {
    const availableAt = withActionFabricDb(db => {
      db.exec('BEGIN IMMEDIATE')
      const first = appendFabricOutbox(db, 'fabric.one', 'a', { order: 1 })
      appendFabricOutbox(db, 'fabric.two', 'b', { order: 2 })
      db.exec('COMMIT')
      return first.availableAt
    })
    expect(listPendingFabricOutbox(1)).toHaveLength(1)
    expect(listPendingFabricOutbox(10).map(item => item.payload)).toEqual([{ order: 1 }, { order: 2 }])

    const claimed = claimPendingFabricOutbox({ limit: 1, leaseMs: 30_000, now: availableAt })
    const { id, claimToken } = claimed[0]
    expect(markFabricOutboxPublished(id, 'stale-token')).toBe(false)
    expect(markFabricOutboxPublished(id, claimToken, plusMilliseconds(availableAt, 1_000))).toBe(true)
    expect(markFabricOutboxPublished(id, claimToken, plusMilliseconds(availableAt, 2_000))).toBe(false)
    expect(listPendingFabricOutbox()).toHaveLength(1)
    expect(withActionFabricDb(db => db.prepare('SELECT status, attempts FROM fabric_outbox WHERE id=?').get(id)))
      .toEqual({ status: 'published', attempts: 1 })
  })

  it('atomically leases outbox records and reclaims the same immutable ID only after expiry', () => {
    const availableAt = withActionFabricDb(db => {
      db.exec('BEGIN IMMEDIATE')
      const outbox = appendFabricOutbox(db, 'fabric.one', 'a', { order: 1 })
      db.exec('COMMIT')
      return outbox.availableAt
    })
    const first = claimPendingFabricOutbox({ limit: 1, leaseMs: 1_000, now: availableAt })
    expect(first).toHaveLength(1)
    expect(claimPendingFabricOutbox({
      limit: 1, leaseMs: 1_000, now: plusMilliseconds(availableAt, 500),
    })).toEqual([])

    const reclaimed = claimPendingFabricOutbox({
      limit: 1, leaseMs: 1_000, now: plusMilliseconds(availableAt, 1_001),
    })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0].id).toBe(first[0].id)
    expect(reclaimed[0].claimToken).not.toBe(first[0].claimToken)
    const publishAt = plusMilliseconds(availableAt, 1_100)
    expect(markFabricOutboxPublished(first[0].id, first[0].claimToken, publishAt)).toBe(false)
    expect(markFabricOutboxPublished(reclaimed[0].id, reclaimed[0].claimToken, publishAt)).toBe(true)
  })

  it('uses a stable managed HMAC key and rejects invalid managed keys', () => {
    const first = append({ state: 'draft' })
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
    expect(() => append({ state: 'running' })).toThrow('FABRIC_AUDIT_ANCHOR_MISMATCH')
  })

  it('reports a valid legacy chain as needing migration and requires explicit pre-bound migration', () => {
    const legacyHashes = seedLegacyChain()
    expect(verifyFabricAuditChain()).toEqual({
      valid: false, checked: 2, firstInvalidSequence: null, legacyValid: true, needsMigration: true,
    })
    expect(() => append({ state: 'succeeded' }, 'workflow.updated'))
      .toThrow('FABRIC_AUDIT_FORMAT_MIGRATION_REQUIRED')
    expect(() => setFabricEmergencyStop(1, 'admin-1', 'maintenance', 0))
      .toThrow('FABRIC_AUDIT_FORMAT_MIGRATION_REQUIRED')
    expect(() => migrateLegacyFabricAuditChain()).toThrow('FABRIC_AUDIT_LEGACY_AUTH_REQUIRED')

    process.env.HERMES_ACTION_FABRIC_LEGACY_AUDIT_HEAD = '0'.repeat(64)
    expect(() => migrateLegacyFabricAuditChain()).toThrow('FABRIC_AUDIT_LEGACY_HEAD_MISMATCH')
    expect(withActionFabricDb(db => db.prepare("SELECT value FROM fabric_meta WHERE key='audit_format'").get()))
      .toBeUndefined()
    process.env.HERMES_ACTION_FABRIC_LEGACY_AUDIT_HEAD = legacyHashes.at(-1)!
    expect(migrateLegacyFabricAuditChain()).toEqual({ migrated: true, checked: 2 })
    append({ state: 'succeeded' }, 'workflow.updated')
    setFabricEmergencyStop(1, 'admin-1', 'maintenance', 0)

    expect(verifyFabricAuditChain()).toEqual({ valid: true, checked: 4, firstInvalidSequence: null })
    const migrated = listFabricAuditEvents()
    expect(migrated.slice(0, 2).map(event => event.hash)).not.toEqual(legacyHashes)
    expect(withActionFabricDb(db => db.prepare("SELECT value FROM fabric_meta WHERE key='audit_format'").get()))
      .toEqual({ value: 'hmac-sha256-v1' })
    expect(migrateLegacyFabricAuditChain()).toEqual({ migrated: false, checked: 4 })
  })

  it('refuses a tampered legacy chain without changing rows or metadata', () => {
    const legacyHashes = seedLegacyChain()
    withActionFabricDb(db => db.prepare("UPDATE fabric_audit_events SET payload_json='{}' WHERE sequence=1").run())
    const before = withActionFabricDb(db => ({
      rows: db.prepare('SELECT * FROM fabric_audit_events ORDER BY sequence').all(),
      meta: db.prepare("SELECT * FROM fabric_meta WHERE key LIKE 'audit_%' ORDER BY key").all(),
    }))

    expect(verifyFabricAuditChain()).toMatchObject({ valid: false, firstInvalidSequence: 1 })
    expect(() => append({ state: 'failed' })).toThrow('FABRIC_AUDIT_FORMAT_MIGRATION_REQUIRED')
    process.env.HERMES_ACTION_FABRIC_LEGACY_AUDIT_HEAD = legacyHashes.at(-1)!
    expect(() => migrateLegacyFabricAuditChain()).toThrow('FABRIC_AUDIT_LEGACY_INVALID')
    expect(withActionFabricDb(db => ({
      rows: db.prepare('SELECT * FROM fabric_audit_events ORDER BY sequence').all(),
      meta: db.prepare("SELECT * FROM fabric_meta WHERE key LIKE 'audit_%' ORDER BY key").all(),
    }))).toEqual(before)
  })

  it('rolls legacy migration back on interruption and retries idempotently', () => {
    const legacyHashes = seedLegacyChain()
    process.env.HERMES_ACTION_FABRIC_LEGACY_AUDIT_HEAD = legacyHashes.at(-1)!
    const before = withActionFabricDb(db => db.prepare('SELECT * FROM fabric_audit_events ORDER BY sequence').all())
    withActionFabricDb(db => db.exec(`CREATE TRIGGER fail_legacy_migration BEFORE UPDATE ON fabric_audit_events
      WHEN OLD.sequence=2 BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END`))
    expect(() => migrateLegacyFabricAuditChain()).toThrow()
    expect(withActionFabricDb(db => db.prepare('SELECT * FROM fabric_audit_events ORDER BY sequence').all())).toEqual(before)
    expect(withActionFabricDb(db => db.prepare("SELECT value FROM fabric_meta WHERE key='audit_format'").get())).toBeUndefined()

    withActionFabricDb(db => db.exec('DROP TRIGGER fail_legacy_migration'))
    expect(migrateLegacyFabricAuditChain()).toEqual({ migrated: true, checked: 2 })
    append({ state: 'running' })
    append({ state: 'succeeded' })
    expect(verifyFabricAuditChain()).toEqual({ valid: true, checked: 4, firstInvalidSequence: null })
  })

  it('prevents a database-only attacker from downgrading HMAC rows into a valid public SHA chain', () => {
    append({ state: 'draft' })
    append({ state: 'running' }, 'workflow.updated')
    withActionFabricDb(db => {
      db.exec('BEGIN IMMEDIATE')
      let previousHash = '0'.repeat(64)
      let finalHash = previousHash
      for (const row of db.prepare('SELECT * FROM fabric_audit_events ORDER BY sequence').all() as Array<{
        sequence: number; event_type: string; actor_user_id: string; aggregate_type: string
        aggregate_id: string; payload_json: string; occurred_at: string
      }>) {
        const immutable = {
          sequence: row.sequence, eventType: row.event_type, actorUserId: row.actor_user_id,
          aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
          payload: JSON.parse(row.payload_json), occurredAt: row.occurred_at, previousHash,
        }
        finalHash = createHash('sha256').update(canonical(immutable)).digest('hex')
        db.prepare('UPDATE fabric_audit_events SET id=?, previous_hash=?, hash=? WHERE sequence=?').run(
          `audit-${row.sequence}-${finalHash.slice(0, 24)}`, previousHash, finalHash, row.sequence,
        )
        previousHash = finalHash
      }
      db.prepare("DELETE FROM fabric_meta WHERE key='audit_format'").run()
      db.prepare("UPDATE fabric_meta SET value=? WHERE key='audit_chain_head'")
        .run(canonical({ sequence: 2, hash: finalHash }))
      db.exec('COMMIT')
    })

    expect(verifyFabricAuditChain()).toEqual({
      valid: false, checked: 2, firstInvalidSequence: null, legacyValid: true, needsMigration: true,
    })
    expect(() => append({ state: 'succeeded' })).toThrow('FABRIC_AUDIT_FORMAT_MIGRATION_REQUIRED')
    expect(() => setFabricEmergencyStop(2, 'admin-1', 'downgrade test', 0))
      .toThrow('FABRIC_AUDIT_FORMAT_MIGRATION_REQUIRED')
    expect(() => migrateLegacyFabricAuditChain()).toThrow('FABRIC_AUDIT_LEGACY_AUTH_REQUIRED')
  })

  it('verifies audit chains with a constant-memory SQLite iterator', () => {
    const source = readFileSync(join(process.cwd(), 'packages/server/src/services/hermes/action-fabric/audit.ts'), 'utf8')
    expect(source).toContain('.iterate() as IterableIterator<AuditRow>')
    expect(source).not.toMatch(/SELECT \* FROM fabric_audit_events ORDER BY sequence ASC['`]\)\.all\(/)
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

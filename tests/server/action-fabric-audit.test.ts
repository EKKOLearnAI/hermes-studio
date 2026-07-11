import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  appendFabricAuditEvent,
  appendFabricOutbox,
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
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-fabric-audit-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
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

  it('bounds persisted JSON without making distinct dropped data hash-identical and rejects non-JSON input', () => {
    const longA = append({ value: 'a'.repeat(50_000), list: Array.from({ length: 500 }, (_, index) => index) })
    const longB = append({ value: `${'a'.repeat(49_999)}b`, list: Array.from({ length: 500 }, (_, index) => index) }, 'workflow.other')
    const rows = listFabricAuditEvents()

    expect(JSON.stringify(rows[0].payload).length).toBeLessThan(40_000)
    expect(longA.hash).not.toBe(longB.hash)
    expect(() => append({ invalid: Number.NaN })).toThrow('FABRIC_AUDIT_INVALID_JSON')
    expect(() => append({ invalid: undefined })).toThrow('FABRIC_AUDIT_INVALID_JSON')
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

  it('lists pending outbox records deterministically with bounds and marks publication idempotently', () => {
    withActionFabricDb(db => {
      db.exec('BEGIN IMMEDIATE')
      appendFabricOutbox(db, 'fabric.one', 'a', { order: 1 })
      appendFabricOutbox(db, 'fabric.two', 'b', { order: 2 })
      db.exec('COMMIT')
    })
    expect(listPendingFabricOutbox(1)).toHaveLength(1)
    expect(listPendingFabricOutbox(10).map(item => item.payload)).toEqual([{ order: 1 }, { order: 2 }])

    const id = listPendingFabricOutbox()[0].id
    markFabricOutboxPublished(id)
    markFabricOutboxPublished(id)
    expect(listPendingFabricOutbox()).toHaveLength(1)
    expect(withActionFabricDb(db => db.prepare('SELECT status, attempts FROM fabric_outbox WHERE id=?').get(id)))
      .toEqual({ status: 'published', attempts: 1 })
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

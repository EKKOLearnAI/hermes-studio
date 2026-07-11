import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  appendFabricAuditEvent,
  getFabricControlState,
  setFabricEmergencyStop,
  verifyFabricAuditChain,
  withActionFabricDb,
  withFabricAuditedTransaction,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  getFabricAuditAnchorPath,
  readFabricAuditAnchor,
  writeFabricAuditAnchor,
} from '../../packages/server/src/services/hermes/action-fabric/audit-anchor'

describe('action fabric external audit anchor', () => {
  const originalHome = process.env.HERMES_HOME
  const originalKey = process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
  let home = ''
  const keyText = 'anchor-test-managed-key-at-least-32-bytes'
  const key = Buffer.from(keyText)
  const genesis = { sequence: 0, hash: '0'.repeat(64) }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fabric-audit-anchor-'))
    process.env.HERMES_HOME = home
    process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = keyText
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (originalKey === undefined) delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    else process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = originalKey
    rmSync(home, { recursive: true, force: true })
  })

  const event = (db: Parameters<Parameters<typeof withFabricAuditedTransaction>[0]>[0], type: string) =>
    appendFabricAuditEvent(db, {
      eventType: type, actorUserId: 'user-1', aggregateType: 'workflow', aggregateId: 'workflow-1', payload: { type },
    })

  it('finalizes one external committed checkpoint for multiple events', () => {
    withFabricAuditedTransaction(db => {
      event(db, 'one')
      event(db, 'two')
    })
    const directory = join(home, 'personal')
    const anchor = readFabricAuditAnchor(directory, key)
    expect(anchor).toMatchObject({ committed: { sequence: 2 }, pending: null })
    expect(anchor?.committed.hash).toBe(withActionFabricDb(db => (
      db.prepare('SELECT hash FROM fabric_audit_events WHERE sequence=2').get() as { hash: string }
    ).hash))
  })

  it('rolls database and pending anchor back together on caught failure', () => {
    expect(() => withFabricAuditedTransaction(db => {
      event(db, 'rolled-back')
      throw new Error('rollback')
    })).toThrow('rollback')
    expect(withActionFabricDb(db => db.prepare('SELECT COUNT(*) AS count FROM fabric_audit_events').get()))
      .toEqual({ count: 0 })
    expect(readFabricAuditAnchor(join(home, 'personal'), key)).toMatchObject({ committed: genesis, pending: null })
  })

  it('recovers pending-before-commit and committed-before-finalize states deterministically', () => {
    const first = withFabricAuditedTransaction(db => event(db, 'one'))
    const directory = join(home, 'personal')
    const checkpoint1 = { sequence: first.sequence, hash: first.hash }
    const hypothetical2 = { sequence: 2, hash: '2'.repeat(64) }
    writeFabricAuditAnchor(directory, key, {
      committed: checkpoint1, pending: { previous: checkpoint1, next: hypothetical2 },
    })
    withFabricAuditedTransaction(db => db.prepare('SELECT 1').get())
    expect(readFabricAuditAnchor(directory, key)).toMatchObject({ committed: checkpoint1, pending: null })

    const second = withFabricAuditedTransaction(db => event(db, 'two'))
    const checkpoint2 = { sequence: second.sequence, hash: second.hash }
    writeFabricAuditAnchor(directory, key, {
      committed: checkpoint1, pending: { previous: checkpoint1, next: checkpoint2 },
    })
    withFabricAuditedTransaction(db => db.prepare('SELECT 1').get())
    expect(readFabricAuditAnchor(directory, key)).toMatchObject({ committed: checkpoint2, pending: null })
  })

  it('detects genuine-head database truncation against the external monotonic checkpoint', () => {
    withFabricAuditedTransaction(db => { event(db, 'one'); event(db, 'two') })
    const anchorPath = getFabricAuditAnchorPath(join(home, 'personal'))
    const anchorBefore = readFileSync(anchorPath, 'utf8')
    withActionFabricDb(db => {
      const first = db.prepare('SELECT hash FROM fabric_audit_events WHERE sequence=1').get() as { hash: string }
      db.prepare('DELETE FROM fabric_audit_events WHERE sequence=2').run()
      db.prepare("UPDATE fabric_meta SET value=? WHERE key='audit_chain_head'")
        .run(JSON.stringify({ sequence: 1, hash: first.hash }))
    })

    expect(verifyFabricAuditChain()).toMatchObject({ valid: false })
    expect(() => withFabricAuditedTransaction(db => event(db, 'three'))).toThrow('FABRIC_AUDIT_ANCHOR_MISMATCH')
    expect(() => setFabricEmergencyStop(1, 'admin-1', 'test', 0)).toThrow('FABRIC_AUDIT_ANCHOR_MISMATCH')
    expect(readFileSync(anchorPath, 'utf8')).toBe(anchorBefore)
    expect(getFabricControlState()).toMatchObject({ level: 0, version: 0 })
  })

  it.each(['missing', 'tampered'])('fails closed for a %s anchor with nonempty HMAC history', mode => {
    withFabricAuditedTransaction(db => event(db, 'one'))
    const path = getFabricAuditAnchorPath(join(home, 'personal'))
    if (mode === 'missing') unlinkSync(path)
    else writeFileSync(path, '{"committed":{"sequence":1}}')
    expect(existsSync(path)).toBe(mode === 'tampered')
    expect(verifyFabricAuditChain()).toMatchObject({ valid: false })
    expect(() => withFabricAuditedTransaction(db => event(db, 'two'))).toThrow(/FABRIC_AUDIT_ANCHOR_/)
  })

  it('rejects replacement with an older valid signed anchor', () => {
    withFabricAuditedTransaction(db => event(db, 'one'))
    const path = getFabricAuditAnchorPath(join(home, 'personal'))
    const oldAnchor = readFileSync(path, 'utf8')
    withFabricAuditedTransaction(db => event(db, 'two'))
    writeFileSync(path, oldAnchor)

    expect(verifyFabricAuditChain()).toMatchObject({ valid: false })
    expect(() => withFabricAuditedTransaction(db => event(db, 'three'))).toThrow('FABRIC_AUDIT_ANCHOR_MISMATCH')
  })
})

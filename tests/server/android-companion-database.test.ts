import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('Android companion database', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'android-companion-'))
    process.env.HERMES_HOME = home
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it('creates one global schema for trust, commands, receipts, observations, artifacts, and takeover', async () => {
    const { getAndroidCompanionDbPath, withAndroidCompanionDb } = await import(
      '../../packages/server/src/services/hermes/android-companion'
    )
    expect(getAndroidCompanionDbPath()).toBe(join(home, 'personal', 'android-companion.db'))
    withAndroidCompanionDb(db => db.prepare('SELECT 1').get())
    expect(existsSync(getAndroidCompanionDbPath())).toBe(true)

    const db = new DatabaseSync(getAndroidCompanionDbPath(), { readOnly: true })
    expect(db.prepare("SELECT value FROM android_companion_meta WHERE key='schema_version'").get())
      .toEqual({ value: '2' })
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'android_%' ORDER BY name")
      .all() as Array<{ name: string }>).map(row => row.name)).toEqual([
      'android_companion_capabilities',
      'android_companion_commands',
      'android_companion_devices',
      'android_companion_meta',
      'android_execution_receipts',
      'android_notification_observations',
      'android_screen_artifacts',
      'android_takeovers',
    ])
    expect(columns(db, 'android_companion_devices')).toEqual([
      'id', 'installation_id', 'signing_public_key', 'exchange_public_key', 'signing_fingerprint',
      'exchange_fingerprint', 'label', 'android_version', 'app_version', 'state', 'capabilities_revision',
      'capabilities_digest', 'last_received_sequence', 'last_sent_sequence', 'version', 'paired_at',
      'revoked_at', 'revocation_reason', 'last_seen_at', 'created_at', 'updated_at',
    ])
    expect(columns(db, 'android_companion_commands')).toEqual([
      'id', 'workflow_id', 'execution_token', 'material_digest', 'device_id', 'capability_id',
      'capability_version', 'kind', 'payload_json', 'status', 'delivery_sequence', 'delivery_attempts',
      'response_json', 'error_code', 'version', 'expires_at', 'created_at', 'updated_at', 'completed_at',
    ])
    expect(indexColumns(db, 'idx_android_commands_status_updated')).toEqual(['status', 'updated_at', 'id'])
    expect(indexColumns(db, 'idx_android_takeovers_status_expiry')).toEqual(['status', 'expires_at', 'id'])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })

  it('enforces durable identity, monotonic version, revocation, JSON, and history constraints directly', async () => {
    const { initAndroidCompanionSchema } = await import(
      '../../packages/server/src/services/hermes/android-companion'
    )
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initAndroidCompanionSchema(db)
    insertDevice(db)
    insertCommand(db)

    expect(() => db.prepare("UPDATE android_companion_devices SET signing_public_key=?,version=2 WHERE id=?")
      .run('z'.repeat(100), deviceId)).toThrow(/identity is immutable/i)
    expect(() => db.prepare("UPDATE android_companion_devices SET label='Phone 2',version=3 WHERE id=?")
      .run(deviceId)).toThrow(/version must increase/i)
    db.prepare(`UPDATE android_companion_devices SET state='revoked',revoked_at='now',
      revocation_reason='USER_REVOKED',version=2,updated_at='now' WHERE id=?`).run(deviceId)
    expect(() => db.prepare(`UPDATE android_companion_devices SET state='paired',revoked_at=NULL,
      revocation_reason=NULL,version=3,updated_at='now' WHERE id=?`).run(deviceId)).toThrow(/permanent/i)
    expect(() => db.prepare('DELETE FROM android_companion_devices WHERE id=?').run(deviceId))
      .toThrow(/immutable/i)

    expect(() => db.prepare("UPDATE android_companion_commands SET payload_json='[]',version=2 WHERE id='command-android-1'")
      .run()).toThrow()
    expect(() => db.prepare("UPDATE android_companion_commands SET status='delivered',version=3 WHERE id='command-android-1'")
      .run()).toThrow(/version must increase/i)
    db.prepare("UPDATE android_companion_commands SET status='delivered',version=2 WHERE id='command-android-1'").run()
    expect(() => db.prepare("DELETE FROM android_companion_commands WHERE id='command-android-1'").run())
      .toThrow(/immutable/i)

    db.prepare(`INSERT INTO android_notification_observations
      (id,device_id,package_binding,notification_key_hash,category,channel_hash,title_summary,text_summary,
       sensitivity,source_sequence,provenance_digest,posted_at,removed_at,version,created_at,updated_at)
      VALUES('notification-1',?,'ai.hermes.companion',?,'workflow.status',NULL,'Ready','Continue',
       'standard',1,?,'posted',NULL,1,'now','now')`).run(deviceId, 'e'.repeat(64), 'f'.repeat(64))
    db.prepare("UPDATE android_notification_observations SET source_sequence=2,version=2 WHERE id='notification-1'").run()
    expect(() => db.prepare(`UPDATE android_notification_observations
      SET title_summary='Changed',version=3 WHERE id='notification-1'`).run()).toThrow(/identity is immutable/i)
    expect(() => db.prepare(`UPDATE android_notification_observations
      SET source_sequence=1,version=3 WHERE id='notification-1'`).run()).toThrow(/identity is immutable/i)

    expect(() => db.prepare(`INSERT INTO android_screen_artifacts
      (id,device_id,workflow_id,command_id,digest,mime_type,width,height,byte_size,encryption_context_digest,captured_at,created_at)
      VALUES('artifact-1',?,'workflow-android-1','command-android-1',?,'image/png',1080,2400,1024,?,'now','now')`)
      .run(deviceId, 'c'.repeat(64), 'd'.repeat(64))).not.toThrow()
    expect(() => db.prepare("UPDATE android_screen_artifacts SET width=1 WHERE id='artifact-1'").run())
      .toThrow(/immutable/i)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })

  it('reopens idempotently and fails closed for future or tampered schemas', async () => {
    const { initAndroidCompanionSchema } = await import(
      '../../packages/server/src/services/hermes/android-companion'
    )
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initAndroidCompanionSchema(db)
    expect(() => initAndroidCompanionSchema(db)).not.toThrow()
    db.prepare("UPDATE android_companion_meta SET value='3' WHERE key='schema_version'").run()
    expect(() => initAndroidCompanionSchema(db)).toThrow(/newer than supported/i)
    db.prepare("UPDATE android_companion_meta SET value='2' WHERE key='schema_version'").run()
    db.exec('DROP INDEX idx_android_devices_state_updated')
    expect(() => initAndroidCompanionSchema(db)).not.toThrow()
    db.exec('DROP TRIGGER android_devices_identity_immutable')
    expect(() => initAndroidCompanionSchema(db)).not.toThrow()
    db.exec(`DROP TRIGGER android_devices_identity_immutable;
      CREATE TRIGGER android_devices_identity_immutable BEFORE UPDATE ON android_companion_devices
      BEGIN SELECT 1; END;`)
    expect(() => initAndroidCompanionSchema(db)).toThrow(/trigger signature mismatch/i)
    db.close()
  })

  it('rejects asynchronous managed operations and closes the connection', async () => {
    const { withAndroidCompanionDb } = await import(
      '../../packages/server/src/services/hermes/android-companion'
    )
    let captured: DatabaseSync | null = null
    expect(() => withAndroidCompanionDb((db => {
      captured = db
      return Promise.resolve('nope')
    }) as never)).toThrow(/must be synchronous/i)
    expect(() => captured?.prepare('SELECT 1')).toThrow(/not open/i)
  })
})

const deviceId = `hwui_${'a'.repeat(32)}`

function insertDevice(db: DatabaseSync): void {
  db.prepare(`INSERT INTO android_companion_devices
    (id,installation_id,signing_public_key,exchange_public_key,signing_fingerprint,exchange_fingerprint,
     label,android_version,app_version,state,capabilities_revision,capabilities_digest,last_received_sequence,
     last_sent_sequence,version,paired_at,revoked_at,revocation_reason,last_seen_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'Phone','15','1.0','paired',0,NULL,0,0,1,'now',NULL,NULL,NULL,'now','now')`)
    .run(deviceId, 'installation-1', 's'.repeat(100), 'x'.repeat(100), 'a'.repeat(64), 'b'.repeat(64))
}

function insertCommand(db: DatabaseSync): void {
  db.prepare(`INSERT INTO android_companion_commands
    (id,workflow_id,execution_token,material_digest,device_id,capability_id,capability_version,kind,payload_json,
     status,delivery_sequence,delivery_attempts,response_json,error_code,version,expires_at,created_at,updated_at,completed_at)
    VALUES('command-android-1','workflow-android-1','execution-1',?,?, 'android.app.launch',1,'app_launch','{}',
      'queued',NULL,0,NULL,NULL,1,'later','now','now',NULL)`)
    .run('a'.repeat(64), deviceId)
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(row => row.name)
}

function indexColumns(db: DatabaseSync, index: string): string[] {
  return (db.prepare(`PRAGMA index_info('${index}')`).all() as Array<{ seqno: number; name: string }>)
    .sort((left, right) => left.seqno - right.seqno).map(row => row.name)
}

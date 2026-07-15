import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('internet execution database', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'internet-execution-'))
    process.env.HERMES_HOME = home
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it('creates one global schema with exact durable receipt and checkpoint signatures', async () => {
    const { getInternetExecutionDbPath, InternetExecutionStore, withInternetExecutionDb } = await import(
      '../../packages/server/src/services/hermes/internet-execution'
    )
    expect(getInternetExecutionDbPath()).toBe(join(home, 'personal', 'internet-execution.db'))
    withInternetExecutionDb(db => new InternetExecutionStore(db).prepareReceipt({
      workflowId: 'workflow-reopen', intentId: 'intent-reopen', materialDigest: 'a'.repeat(64),
      capabilityId: 'bilibili.video.search', provider: 'bilibili', profile: 'default', executorId: 'bilibili-mcp',
      executorType: 'mcp', environment: 'production', operation: 'search', request: { query: 'Hermes' },
      safeToReplay: true,
    }))
    expect(withInternetExecutionDb(db => new InternetExecutionStore(db).getReceipt('workflow-reopen')))
      .toMatchObject({ status: 'prepared', version: 1, request: { query: 'Hermes' } })
    expect(existsSync(getInternetExecutionDbPath())).toBe(true)

    const db = new DatabaseSync(getInternetExecutionDbPath(), { readOnly: true })
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'internet_%' ORDER BY name")
      .all() as Array<{ name: string }>).map(row => row.name)).toEqual([
      'internet_execution_checkpoints', 'internet_execution_receipts', 'internet_meta',
    ])
    expect(db.prepare("SELECT value FROM internet_meta WHERE key='schema_version'").get()).toEqual({ value: '1' })
    expect(columns(db, 'internet_execution_receipts')).toEqual([
      'workflow_id', 'intent_id', 'material_digest', 'capability_id', 'provider', 'profile', 'executor_id',
      'executor_type', 'environment', 'operation', 'request_json', 'safe_to_replay', 'status',
      'provider_request_id', 'result_json', 'error_code', 'version', 'created_at', 'updated_at', 'completed_at',
    ])
    expect(columns(db, 'internet_execution_checkpoints')).toEqual([
      'workflow_id', 'ordinal', 'kind', 'public_url', 'evidence_digest', 'details_json', 'observed_at', 'created_at',
    ])
    expect(indexColumns(db, 'idx_internet_receipts_status_updated')).toEqual(['status', 'updated_at', 'workflow_id'])
    expect(indexColumns(db, 'idx_internet_checkpoints_kind_created')).toEqual(['kind', 'created_at', 'workflow_id'])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })

  it('enforces executor, digest, JSON, foreign key, and immutable history constraints directly', async () => {
    const { initInternetExecutionSchema } = await import(
      '../../packages/server/src/services/hermes/internet-execution'
    )
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initInternetExecutionSchema(db)
    insertReceipt(db)

    expect(() => insertReceipt(db, 'workflow-browser', { executorType: 'shell' })).toThrow()
    expect(() => insertReceipt(db, 'workflow-bad-digest', { digest: 'bad' })).toThrow()
    expect(() => insertReceipt(db, 'workflow-bad-json', { requestJson: '[]' })).toThrow()
    expect(() => db.prepare(`INSERT INTO internet_execution_checkpoints
      (workflow_id,ordinal,kind,public_url,evidence_digest,details_json,observed_at,created_at)
      VALUES('workflow-missing',0,'mcp_call',NULL,NULL,'{}','now','now')`).run()).toThrow()
    expect(() => db.prepare("UPDATE internet_execution_receipts SET provider='changed',version=2").run()).toThrow(/immutable/i)
    expect(() => db.prepare("UPDATE internet_execution_receipts SET status='executing',version=3").run()).toThrow(/version/i)
    expect(() => db.prepare("DELETE FROM internet_execution_receipts").run()).toThrow(/immutable/i)

    db.prepare(`INSERT INTO internet_execution_checkpoints
      (workflow_id,ordinal,kind,public_url,evidence_digest,details_json,observed_at,created_at)
      VALUES('workflow-fixture',0,'mcp_call',NULL,NULL,'{}','now','now')`).run()
    expect(() => db.prepare("UPDATE internet_execution_checkpoints SET details_json='{}'").run()).toThrow(/immutable/i)
    expect(() => db.prepare('DELETE FROM internet_execution_checkpoints').run()).toThrow(/immutable/i)
    db.close()
  })

  it('reopens idempotently and fails closed for future or tampered schemas', async () => {
    const { initInternetExecutionSchema } = await import(
      '../../packages/server/src/services/hermes/internet-execution'
    )
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initInternetExecutionSchema(db)
    expect(() => initInternetExecutionSchema(db)).not.toThrow()
    db.prepare("UPDATE internet_meta SET value='2' WHERE key='schema_version'").run()
    expect(() => initInternetExecutionSchema(db)).toThrow(/newer than supported/i)
    db.prepare("UPDATE internet_meta SET value='1' WHERE key='schema_version'").run()
    db.exec('DROP INDEX idx_internet_receipts_status_updated')
    expect(() => initInternetExecutionSchema(db)).not.toThrow()
    db.exec('DROP TRIGGER internet_receipts_identity_immutable')
    expect(() => initInternetExecutionSchema(db)).not.toThrow()
    db.exec(`DROP TRIGGER internet_receipts_identity_immutable;
      CREATE TRIGGER internet_receipts_identity_immutable BEFORE UPDATE ON internet_execution_receipts
      BEGIN SELECT 1; END;`)
    expect(() => initInternetExecutionSchema(db)).toThrow(/trigger signature mismatch/i)
    db.exec('DROP TRIGGER internet_receipts_identity_immutable')
    expect(() => initInternetExecutionSchema(db)).not.toThrow()
    db.exec('DROP TABLE internet_execution_checkpoints')
    db.exec(`CREATE TABLE internet_execution_checkpoints (
      workflow_id TEXT NOT NULL,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,public_url TEXT,
      evidence_digest TEXT,details_json TEXT NOT NULL,observed_at TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(workflow_id,ordinal))`)
    expect(() => initInternetExecutionSchema(db)).toThrow(/table signature mismatch/i)
    db.close()
  })

  it('rejects asynchronous managed operations and closes the connection', async () => {
    const { withInternetExecutionDb } = await import(
      '../../packages/server/src/services/hermes/internet-execution'
    )
    let captured: DatabaseSync | null = null
    expect(() => withInternetExecutionDb((db => {
      captured = db
      return Promise.resolve('nope')
    }) as never)).toThrow(/must be synchronous/i)
    expect(() => captured?.prepare('SELECT 1')).toThrow(/not open/i)
  })
})

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(row => row.name)
}

function indexColumns(db: DatabaseSync, index: string): string[] {
  return (db.prepare(`PRAGMA index_info('${index}')`).all() as Array<{ seqno: number; name: string }>)
    .sort((left, right) => left.seqno - right.seqno).map(row => row.name)
}

function insertReceipt(
  db: DatabaseSync,
  workflowId = 'workflow-fixture',
  overrides: { executorType?: string; digest?: string; requestJson?: string } = {},
): void {
  db.prepare(`INSERT INTO internet_execution_receipts
    (workflow_id,intent_id,material_digest,capability_id,provider,profile,executor_id,executor_type,environment,
     operation,request_json,safe_to_replay,status,provider_request_id,result_json,error_code,version,
     created_at,updated_at,completed_at)
    VALUES(?,?,?,?,?,'default','bilibili-mcp',?,'production','search',?,1,'prepared',NULL,NULL,NULL,1,'now','now',NULL)`)
    .run(workflowId, 'intent-fixture', overrides.digest ?? 'a'.repeat(64), 'bilibili.video.search', 'bilibili',
      overrides.executorType ?? 'mcp', overrides.requestJson ?? '{}')
}

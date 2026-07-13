import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REQUIRED_TABLES = [
  'fabric_action_intents',
  'fabric_audit_events',
  'fabric_budget_ledger',
  'fabric_capabilities',
  'fabric_control_state',
  'fabric_executor_capabilities',
  'fabric_executors',
  'fabric_meta',
  'fabric_outbox',
  'fabric_policy_decisions',
  'fabric_steps',
  'fabric_workflows',
]

const REQUIRED_INDEX_SIGNATURES = [
  { name: 'idx_fabric_audit_sequence', table: 'fabric_audit_events', unique: 1, columns: ['sequence'], partial: 0 },
  { name: 'idx_fabric_budget_daily', table: 'fabric_budget_ledger', unique: 0, columns: ['requested_by_user_id', 'requested_by_role_id', 'ledger_date', 'currency', 'status'], partial: 0 },
  { name: 'idx_fabric_executor_capability', table: 'fabric_executor_capabilities', unique: 0, columns: ['capability_id', 'capability_version', 'executor_id'], partial: 0 },
  { name: 'idx_fabric_intent_idempotency', table: 'fabric_action_intents', unique: 1, columns: ['requested_by_user_id', 'requested_by_role_id', 'idempotency_key'], partial: 0 },
  { name: 'idx_fabric_outbox_pending', table: 'fabric_outbox', unique: 0, columns: ['status', 'available_at', 'created_at'], partial: 0 },
  { name: 'idx_fabric_policy_intent', table: 'fabric_policy_decisions', unique: 0, columns: ['intent_id', 'created_at'], partial: 0 },
  { name: 'idx_fabric_steps_workflow_ordinal', table: 'fabric_steps', unique: 1, columns: ['workflow_id', 'ordinal'], partial: 0 },
  { name: 'idx_fabric_workflows_state_lease', table: 'fabric_workflows', unique: 0, columns: ['state', 'lease_expires_at', 'retry_at'], partial: 0 },
]

const REQUIRED_JSON_TRIGGERS = [
  'fabric_capabilities_json_insert',
  'fabric_capabilities_json_update',
  'fabric_executors_json_insert',
  'fabric_executors_json_update',
  'fabric_action_intents_json_insert',
  'fabric_action_intents_json_update',
  'fabric_policy_decisions_json_insert',
  'fabric_policy_decisions_json_update',
  'fabric_steps_json_insert',
  'fabric_steps_json_update',
  'fabric_audit_events_json_insert',
  'fabric_audit_events_json_update',
  'fabric_outbox_json_insert',
  'fabric_outbox_json_update',
]

function seedJsonConstrainedRows(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO fabric_capabilities(
      id, version, domain, verb, description, input_schema_json, output_schema_json, risk,
      side_effect, idempotency, reversible, verification_strategy, authentication_json,
      target_restrictions_json, contract_digest, enabled, created_at, updated_at
    ) VALUES ('json.capability', 1, 'test', 'json', 'JSON fixture', '{}', '{}', 'none',
      0, 'supported', 0, 'result_match', '[]', '[]', 'digest', 1, 'now', 'now');
    INSERT INTO fabric_executors(
      id, type, name, environment, health, health_details_json, configuration_json,
      enabled, policy_version, created_at, updated_at
    ) VALUES ('json-executor', 'simulator', 'JSON fixture', 'simulator', 'healthy', '{}', '{}',
      1, 1, 'now', 'now');
    INSERT INTO fabric_executor_capabilities(
      executor_id, capability_id, capability_version, contract_digest, created_at
    ) VALUES ('json-executor', 'json.capability', 1, 'digest', 'now');
    INSERT INTO fabric_action_intents(
      id, capability_id, capability_version, requested_by_role_id, requested_by_user_id,
      idempotency_key, goal, target_json, input_json, constraints_json, rationale,
      material_input_digest, sanitized_summary_json, created_at, updated_at
    ) VALUES ('json-intent', 'json.capability', 1, 'role', 'user', 'json-key', 'JSON fixture',
      '{}', '{}', '{}', 'test', 'digest', '{}', 'now', 'now');
    INSERT INTO fabric_policy_decisions(
      id, intent_id, executor_id, outcome, reason_codes_json, policy_version,
      material_input_digest, policy_snapshot_json, sanitized_summary_json, created_at
    ) VALUES ('json-policy', 'json-intent', 'json-executor', 'allow', '[]', 1,
      'digest', '{}', '{}', 'now');
    INSERT INTO fabric_workflows(
      id, intent_id, executor_id, policy_decision_id, state, created_at, updated_at
    ) VALUES ('json-workflow', 'json-intent', 'json-executor', 'json-policy', 'draft', 'now', 'now');
    INSERT INTO fabric_steps(
      id, workflow_id, ordinal, kind, state, execution_token, executor_id,
      input_json, output_json, evidence_json, created_at, updated_at
    ) VALUES ('json-step', 'json-workflow', 0, 'execute', 'pending', 'json-token', 'json-executor',
      '{}', '{}', '[]', 'now', 'now');
    INSERT INTO fabric_audit_events(
      id, event_type, actor_user_id, aggregate_type, aggregate_id, payload_json,
      occurred_at, previous_hash, hash
    ) VALUES ('json-audit', 'test', 'user', 'system', 'json', '{}', 'now', 'previous', 'hash');
    INSERT INTO fabric_outbox(
      id, topic, aggregate_id, payload_json, status, attempts, available_at, created_at
    ) VALUES ('json-outbox', 'test', 'json', '{}', 'pending', 0, 'now', 'now');
  `)
}

describe('action fabric database', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-action-fabric-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('creates one global database below Hermes home with schema version four', async () => {
    const { getActionFabricDbPath, withActionFabricDb } = await import(
      '../../packages/server/src/services/hermes/action-fabric'
    )

    expect(getActionFabricDbPath()).toBe(join(hermesHome, 'personal', 'action-fabric.db'))
    withActionFabricDb(db => db.prepare('SELECT 1').get())
    expect(existsSync(getActionFabricDbPath())).toBe(true)

    const db = new DatabaseSync(getActionFabricDbPath(), { readOnly: true })
    try {
      const tables = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fabric_%' ORDER BY name",
      ).all() as Array<{ name: string }>).map(row => row.name)
      const indexes = new Set((db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_fabric_%'",
      ).all() as Array<{ name: string }>).map(row => row.name))
      const triggers = new Set((db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'fabric_%_json_%'",
      ).all() as Array<{ name: string }>).map(row => row.name))

      expect(tables).toEqual(REQUIRED_TABLES)
      expect(REQUIRED_INDEX_SIGNATURES.every(signature => indexes.has(signature.name))).toBe(true)
      expect([...triggers].sort()).toEqual([...REQUIRED_JSON_TRIGGERS].sort())
      for (const signature of REQUIRED_INDEX_SIGNATURES) {
        const index = (db.prepare(`PRAGMA index_list("${signature.table}")`).all() as Array<{
          name: string
          unique: number
          partial: number
        }>).find(row => row.name === signature.name)
        const columns = (db.prepare(`PRAGMA index_info("${signature.name}")`).all() as Array<{
          seqno: number
          name: string
        }>).sort((left, right) => left.seqno - right.seqno).map(row => row.name)
        expect(index).toMatchObject({ unique: signature.unique, partial: signature.partial })
        expect(columns).toEqual(signature.columns)
      }
      expect(db.prepare("SELECT value FROM fabric_meta WHERE key = 'schema_version'").get()).toEqual({ value: '4' })
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fabric_executors'").get() as { sql: string }).sql)
        .toContain("'connector'")
      expect((db.prepare('PRAGMA table_info(fabric_outbox)').all() as Array<{
        name: string; type: string; notnull: number; dflt_value: string | null; pk: number
      }>).find(row => row.name === 'claim_token')).toMatchObject({
        type: 'TEXT', notnull: 0, dflt_value: null, pk: 0,
      })
      expect(db.prepare('SELECT id, level, version FROM fabric_control_state').all()).toEqual([
        { id: 1, level: 0, version: 0 },
      ])
    } finally {
      db.close()
    }
  }, 30_000)

  it('upgrades an explicitly empty version zero atomically and is idempotent', async () => {
    const { getActionFabricDbPath, initActionFabricSchema } = await import(
      '../../packages/server/src/services/hermes/action-fabric'
    )
    const path = getActionFabricDbPath()
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE fabric_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO fabric_meta(key, value) VALUES (?, ?)').run('schema_version', '0')

    initActionFabricSchema(db)
    initActionFabricSchema(db)

    try {
      expect(db.prepare("SELECT value FROM fabric_meta WHERE key = 'schema_version'").get()).toEqual({ value: '4' })
      expect(db.prepare('SELECT COUNT(*) AS count FROM fabric_control_state').get()).toEqual({ count: 1 })
      expect((db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fabric_%'",
      ).all() as Array<{ name: string }>)).toHaveLength(REQUIRED_TABLES.length)
    } finally {
      db.close()
    }
  })

  it('migrates version three executors to connector support without losing references', async () => {
    const { initActionFabricSchema } = await import('../../packages/server/src/services/hermes/action-fabric')
    const db = new DatabaseSync(':memory:')
    initActionFabricSchema(db)
    db.prepare("UPDATE fabric_meta SET value='3' WHERE key='schema_version'").run()
    db.exec("PRAGMA foreign_keys=OFF")
    db.exec(`
      DROP TRIGGER fabric_executors_json_insert;
      DROP TRIGGER fabric_executors_json_update;
      CREATE TABLE fabric_executors_v3 (
        id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('simulator','internal')), name TEXT NOT NULL,
        environment TEXT NOT NULL CHECK(environment IN ('simulator','internal','sandbox','production')),
        health TEXT NOT NULL CHECK(health IN ('unknown','healthy','degraded','unhealthy')),
        health_details_json TEXT NOT NULL DEFAULT '{}', configuration_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version > 0),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO fabric_executors_v3 SELECT * FROM fabric_executors;
      DROP TABLE fabric_executors;
      ALTER TABLE fabric_executors_v3 RENAME TO fabric_executors;
    `)
    db.exec('PRAGMA foreign_keys=ON')

    initActionFabricSchema(db)

    try {
      expect(db.prepare("SELECT value FROM fabric_meta WHERE key='schema_version'").get()).toEqual({ value: '4' })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(() => db.prepare(`INSERT INTO fabric_executors(
        id,type,name,environment,health,health_details_json,configuration_json,enabled,policy_version,created_at,updated_at
      ) VALUES ('migrated-connector','connector','Connector','production','healthy','{}','{\"externalWrite\":false}',1,1,'now','now')`).run()).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('fails a v4 migration closed on orphaned child rows and preserves the version-three database', async () => {
    const { ensureBuiltInFabricRegistry, getActionFabricDbPath, initActionFabricSchema } = await import(
      '../../packages/server/src/services/hermes/action-fabric'
    )
    ensureBuiltInFabricRegistry()
    const db = new DatabaseSync(getActionFabricDbPath())
    try {
      db.prepare("UPDATE fabric_meta SET value='3' WHERE key='schema_version'").run()
      db.exec('PRAGMA foreign_keys=OFF')
      db.exec(`
        DROP TRIGGER fabric_executors_json_insert;
        DROP TRIGGER fabric_executors_json_update;
        CREATE TABLE fabric_executors_v3 (
          id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('simulator','internal')), name TEXT NOT NULL,
          environment TEXT NOT NULL CHECK(environment IN ('simulator','internal','sandbox','production')),
          health TEXT NOT NULL CHECK(health IN ('unknown','healthy','degraded','unhealthy')),
          health_details_json TEXT NOT NULL DEFAULT '{}', configuration_json TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version > 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO fabric_executors_v3 SELECT * FROM fabric_executors WHERE type<>'connector';
        DROP TABLE fabric_executors;
        ALTER TABLE fabric_executors_v3 RENAME TO fabric_executors;
        DELETE FROM fabric_executors WHERE id='simulator-main';
      `)
      const before = db.prepare('SELECT COUNT(*) count FROM fabric_executor_capabilities').get()
      expect(() => initActionFabricSchema(db)).toThrow(/foreign key integrity/i)
      expect(db.prepare("SELECT value FROM fabric_meta WHERE key='schema_version'").get()).toEqual({ value: '3' })
      expect(db.prepare('SELECT COUNT(*) count FROM fabric_executor_capabilities').get()).toEqual(before)
    } finally { db.close() }
  })

  it('migrates schema version one outbox rows to lease claims without data loss', async () => {
    const { getActionFabricDbPath, initActionFabricSchema } = await import(
      '../../packages/server/src/services/hermes/action-fabric'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(getActionFabricDbPath())
    db.exec(`
      CREATE TABLE fabric_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO fabric_meta(key, value) VALUES ('schema_version', '1');
    `)
    // Build the released v1 shape through a temporary v0 initialization, then restore its marker.
    db.prepare("UPDATE fabric_meta SET value = '0' WHERE key = 'schema_version'").run()
    initActionFabricSchema(db)
    db.prepare("UPDATE fabric_meta SET value = '1' WHERE key = 'schema_version'").run()
    db.exec('ALTER TABLE fabric_outbox DROP COLUMN claim_token')
    db.prepare(`INSERT INTO fabric_outbox(
      id, topic, aggregate_id, payload_json, status, attempts, available_at, created_at
    ) VALUES ('outbox-existing', 'fabric.test', 'aggregate', '{}', 'pending', 0, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')`).run()

    initActionFabricSchema(db)
    expect(db.prepare("SELECT value FROM fabric_meta WHERE key = 'schema_version'").get()).toEqual({ value: '4' })
    expect(db.prepare('SELECT id, claim_token FROM fabric_outbox').all()).toEqual([
      { id: 'outbox-existing', claim_token: null },
    ])
    db.close()
  })

  it('migrates valid version two JSON rows without data loss and remains idempotent', async () => {
    const { initActionFabricSchema } = await import('../../packages/server/src/services/hermes/action-fabric')
    const db = new DatabaseSync(':memory:')
    initActionFabricSchema(db)
    for (const trigger of REQUIRED_JSON_TRIGGERS) db.exec(`DROP TRIGGER "${trigger}"`)
    db.prepare("UPDATE fabric_meta SET value = '2' WHERE key = 'schema_version'").run()
    seedJsonConstrainedRows(db)

    initActionFabricSchema(db)
    initActionFabricSchema(db)

    try {
      expect(db.prepare("SELECT value FROM fabric_meta WHERE key = 'schema_version'").get()).toEqual({ value: '4' })
      expect(db.prepare("SELECT payload_json FROM fabric_outbox WHERE id = 'json-outbox'").get()).toEqual({ payload_json: '{}' })
      expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'fabric_%_json_%'").get())
        .toEqual({ count: REQUIRED_JSON_TRIGGERS.length })
    } finally {
      db.close()
    }
  })

  it('fails closed when a legacy database contains invalid JSON and preserves its version and data', async () => {
    const { initActionFabricSchema } = await import('../../packages/server/src/services/hermes/action-fabric')
    const db = new DatabaseSync(':memory:')
    initActionFabricSchema(db)
    for (const trigger of REQUIRED_JSON_TRIGGERS) db.exec(`DROP TRIGGER "${trigger}"`)
    db.prepare("UPDATE fabric_meta SET value = '2' WHERE key = 'schema_version'").run()
    seedJsonConstrainedRows(db)
    db.prepare("UPDATE fabric_outbox SET payload_json = '{' WHERE id = 'json-outbox'").run()

    expect(() => initActionFabricSchema(db)).toThrow(/legacy JSON.*fabric_outbox\.payload_json/i)

    try {
      expect(db.prepare("SELECT value FROM fabric_meta WHERE key = 'schema_version'").get()).toEqual({ value: '2' })
      expect(db.prepare("SELECT payload_json FROM fabric_outbox WHERE id = 'json-outbox'").get()).toEqual({ payload_json: '{' })
      expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'fabric_%_json_%'").get())
        .toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('rejects invalid, scalar, and oversized JSON on direct SQLite inserts and updates', async () => {
    const { withActionFabricDb } = await import('../../packages/server/src/services/hermes/action-fabric')
    const registryLimit = 131_072
    const payloadLimit = 32_768
    const objectOver = JSON.stringify({ data: 'x'.repeat(registryLimit) })
    const payloadObjectOver = JSON.stringify({ data: 'x'.repeat(payloadLimit) })
    const arrayOver = JSON.stringify(['x'.repeat(registryLimit)])
    const payloadArrayOver = JSON.stringify(['x'.repeat(payloadLimit)])
    const utf8Over = JSON.stringify({ data: '界'.repeat(11_000) })

    withActionFabricDb(db => {
      seedJsonConstrainedRows(db)
      const columns = [
        ['fabric_capabilities', 'id', 'json.capability', 'input_schema_json', 'object', registryLimit],
        ['fabric_capabilities', 'id', 'json.capability', 'output_schema_json', 'object', registryLimit],
        ['fabric_capabilities', 'id', 'json.capability', 'authentication_json', 'array', registryLimit],
        ['fabric_capabilities', 'id', 'json.capability', 'target_restrictions_json', 'array', registryLimit],
        ['fabric_executors', 'id', 'json-executor', 'health_details_json', 'object', registryLimit],
        ['fabric_executors', 'id', 'json-executor', 'configuration_json', 'object', registryLimit],
        ['fabric_action_intents', 'id', 'json-intent', 'target_json', 'object', payloadLimit],
        ['fabric_action_intents', 'id', 'json-intent', 'input_json', 'object', payloadLimit],
        ['fabric_action_intents', 'id', 'json-intent', 'constraints_json', 'object', payloadLimit],
        ['fabric_action_intents', 'id', 'json-intent', 'sanitized_summary_json', 'object', payloadLimit],
        ['fabric_policy_decisions', 'id', 'json-policy', 'reason_codes_json', 'array', payloadLimit],
        ['fabric_policy_decisions', 'id', 'json-policy', 'policy_snapshot_json', 'object', payloadLimit],
        ['fabric_policy_decisions', 'id', 'json-policy', 'sanitized_summary_json', 'object', payloadLimit],
        ['fabric_steps', 'id', 'json-step', 'input_json', 'object', payloadLimit],
        ['fabric_steps', 'id', 'json-step', 'output_json', 'object', payloadLimit],
        ['fabric_steps', 'id', 'json-step', 'evidence_json', 'array', payloadLimit],
        ['fabric_audit_events', 'sequence', 1, 'payload_json', 'object', payloadLimit],
        ['fabric_outbox', 'id', 'json-outbox', 'payload_json', 'object', payloadLimit],
      ] as const

      for (const [table, key, value, column, type, limit] of columns) {
        const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`)
        expect(() => update.run('{', value), `${table}.${column} invalid`).toThrow(/JSON constraint/i)
        expect(() => update.run('1', value), `${table}.${column} scalar`).toThrow(/JSON constraint/i)
        const oversized = type === 'array'
          ? (limit === registryLimit ? arrayOver : payloadArrayOver)
          : (limit === registryLimit ? objectOver : payloadObjectOver)
        expect(() => update.run(oversized, value), `${table}.${column} oversized`).toThrow(/JSON constraint/i)
      }

      const insertOutbox = db.prepare(`INSERT INTO fabric_outbox(
        id, topic, aggregate_id, payload_json, status, attempts, available_at, created_at
      ) VALUES (?, 'test', 'json', ?, 'pending', 0, 'now', 'now')`)
      expect(() => insertOutbox.run('insert-invalid', '{')).toThrow(/JSON constraint/i)
      expect(() => insertOutbox.run('insert-scalar', 'false')).toThrow(/JSON constraint/i)
      expect(() => insertOutbox.run('insert-oversized', payloadObjectOver)).toThrow(/JSON constraint/i)
      expect(() => insertOutbox.run('insert-utf8-oversized', utf8Over)).toThrow(/JSON constraint/i)
      expect(() => insertOutbox.run('insert-json-blob', Buffer.from('{}'))).toThrow(/JSON constraint/i)
    })
  })

  it('accepts legal UTF-8 JSON boundaries and 24KB executor evidence', async () => {
    const { withActionFabricDb } = await import('../../packages/server/src/services/hermes/action-fabric')
    const objectAt = (bytes: number) => JSON.stringify({ data: 'x'.repeat(bytes - 11) })
    const arrayAt = (bytes: number) => JSON.stringify(['x'.repeat(bytes - 4)])

    expect(Buffer.byteLength(objectAt(32_768), 'utf8')).toBe(32_768)
    expect(Buffer.byteLength(arrayAt(32_768), 'utf8')).toBe(32_768)
    expect(Buffer.byteLength(objectAt(131_072), 'utf8')).toBe(131_072)

    withActionFabricDb(db => {
      seedJsonConstrainedRows(db)
      db.prepare("UPDATE fabric_capabilities SET input_schema_json = ?, authentication_json = ? WHERE id = 'json.capability'")
        .run(objectAt(131_072), arrayAt(131_072))
      db.prepare("UPDATE fabric_action_intents SET input_json = ? WHERE id = 'json-intent'").run(objectAt(32_768))
      db.prepare("UPDATE fabric_steps SET evidence_json = ? WHERE id = 'json-step'").run(arrayAt(24_000))
      db.prepare("UPDATE fabric_outbox SET payload_json = ? WHERE id = 'json-outbox'").run(objectAt(32_768))
    })
  })

  it('enables foreign keys for every managed connection', async () => {
    const { withActionFabricDb } = await import('../../packages/server/src/services/hermes/action-fabric')

    expect(withActionFabricDb(db => db.prepare('PRAGMA foreign_keys').get())).toEqual({ foreign_keys: 1 })
  })

  it('closes managed connections after successful operations and synchronous errors', async () => {
    const { withActionFabricDb } = await import('../../packages/server/src/services/hermes/action-fabric')
    let successfulDb: DatabaseSync | null = null
    let throwingDb: DatabaseSync | null = null

    expect(withActionFabricDb(db => {
      successfulDb = db
      return 'done'
    })).toBe('done')
    expect(() => successfulDb?.prepare('SELECT 1')).toThrow(/database is not open/i)

    expect(() => withActionFabricDb(db => {
      throwingDb = db
      throw new Error('operation failed')
    })).toThrow('operation failed')
    expect(() => throwingDb?.prepare('SELECT 1')).toThrow(/database is not open/i)
  })

  it('rejects PromiseLike operation results, closes the connection, and observes rejections', async () => {
    const { withActionFabricDb } = await import('../../packages/server/src/services/hermes/action-fabric')
    let asyncDb: DatabaseSync | null = null
    const asyncOperation = ((db: DatabaseSync) => {
      asyncDb = db
      return Promise.reject(new Error('async failure'))
    }) as unknown as (db: DatabaseSync) => unknown

    expect(() => withActionFabricDb(asyncOperation)).toThrow(/operation must be synchronous/i)
    expect(() => asyncDb?.prepare('SELECT 1')).toThrow(/database is not open/i)
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('rejects a database created by a future schema version', async () => {
    const { getActionFabricDbPath, withActionFabricDb } = await import(
      '../../packages/server/src/services/hermes/action-fabric'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(getActionFabricDbPath())
    db.exec('CREATE TABLE fabric_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO fabric_meta(key, value) VALUES (?, ?)').run('schema_version', '5')
    db.close()

    expect(() => withActionFabricDb(current => current.prepare('SELECT 1').get())).toThrow(
      /newer than supported version/i,
    )
  })

  it.each(['', ' ', '\t', '1.0', '+1', '01', 'version-1'])(
    'rejects corrupt schema version marker %j',
    async marker => {
      const { getActionFabricDbPath, withActionFabricDb } = await import(
        '../../packages/server/src/services/hermes/action-fabric'
      )
      mkdirSync(join(hermesHome, 'personal'), { recursive: true })
      const db = new DatabaseSync(getActionFabricDbPath())
      db.exec('CREATE TABLE fabric_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      db.prepare('INSERT INTO fabric_meta(key, value) VALUES (?, ?)').run('schema_version', marker)
      db.close()

      expect(() => withActionFabricDb(current => current.prepare('SELECT 1').get())).toThrow(
        /schema version is invalid/i,
      )
    },
  )

  it('repairs a dropped required index from a current schema deterministically', async () => {
    const { withActionFabricDb } = await import('../../packages/server/src/services/hermes/action-fabric')
    withActionFabricDb(db => db.exec('DROP INDEX idx_fabric_intent_idempotency'))

    expect(withActionFabricDb(db => db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_fabric_intent_idempotency'",
    ).get())).toEqual({ name: 'idx_fabric_intent_idempotency' })
  })

  it('rejects a same-name index with an incompatible signature', async () => {
    const { withActionFabricDb } = await import('../../packages/server/src/services/hermes/action-fabric')
    withActionFabricDb(db => db.exec(`
      DROP INDEX idx_fabric_intent_idempotency;
      CREATE INDEX idx_fabric_intent_idempotency ON fabric_action_intents(id);
    `))

    expect(() => withActionFabricDb(db => db.prepare('SELECT 1').get())).toThrow(
      /index signature mismatch.*idx_fabric_intent_idempotency/i,
    )
  })

  it('does not reserve a writer lock for steady-state managed reads', async () => {
    const { getActionFabricDbPath, withActionFabricDb } = await import(
      '../../packages/server/src/services/hermes/action-fabric'
    )
    withActionFabricDb(db => db.prepare('SELECT 1').get())
    const writer = new DatabaseSync(getActionFabricDbPath())
    writer.exec('PRAGMA journal_mode = WAL')
    writer.exec('BEGIN IMMEDIATE')

    try {
      expect(withActionFabricDb(db => db.prepare("SELECT value FROM fabric_meta WHERE key = 'schema_version'").get()))
        .toEqual({ value: '4' })
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
  })

  it('serializes migrations behind an existing writer transaction', async () => {
    const { getActionFabricDbPath, initActionFabricSchema } = await import(
      '../../packages/server/src/services/hermes/action-fabric'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const writer = new DatabaseSync(getActionFabricDbPath())
    const migrator = new DatabaseSync(getActionFabricDbPath())
    migrator.exec('PRAGMA busy_timeout = 0')
    writer.exec('BEGIN IMMEDIATE')

    try {
      expect(() => initActionFabricSchema(migrator)).toThrow(/database is locked/i)
    } finally {
      writer.exec('ROLLBACK')
      migrator.close()
      writer.close()
    }
  })

  it('restores foreign-key enforcement when a version three migration cannot acquire its writer lock', async () => {
    const { getActionFabricDbPath, initActionFabricSchema } = await import(
      '../../packages/server/src/services/hermes/action-fabric'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const setup = new DatabaseSync(getActionFabricDbPath())
    initActionFabricSchema(setup)
    setup.prepare("UPDATE fabric_meta SET value='3' WHERE key='schema_version'").run()
    setup.exec('PRAGMA foreign_keys=OFF')
    setup.exec(`
      DROP TRIGGER fabric_executors_json_insert;
      DROP TRIGGER fabric_executors_json_update;
      CREATE TABLE fabric_executors_v3 (
        id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('simulator','internal')), name TEXT NOT NULL,
        environment TEXT NOT NULL CHECK(environment IN ('simulator','internal','sandbox','production')),
        health TEXT NOT NULL CHECK(health IN ('unknown','healthy','degraded','unhealthy')),
        health_details_json TEXT NOT NULL DEFAULT '{}', configuration_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version > 0),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO fabric_executors_v3 SELECT * FROM fabric_executors;
      DROP TABLE fabric_executors;
      ALTER TABLE fabric_executors_v3 RENAME TO fabric_executors;
    `)
    setup.close()
    const writer = new DatabaseSync(getActionFabricDbPath())
    const migrator = new DatabaseSync(getActionFabricDbPath())
    writer.exec('BEGIN IMMEDIATE')
    migrator.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON')

    try {
      expect(() => initActionFabricSchema(migrator)).toThrow(/database is locked/i)
      expect(migrator.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    } finally {
      writer.exec('ROLLBACK')
      migrator.close()
      writer.close()
    }
  })

  it('rolls back a failed migration without tables or a partial version update', async () => {
    const { initActionFabricSchema } = await import('../../packages/server/src/services/hermes/action-fabric')
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE fabric_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO fabric_meta(key, value) VALUES ('schema_version', '0');
      CREATE VIEW fabric_capabilities AS SELECT 1 AS incompatible;
    `)

    expect(() => initActionFabricSchema(db)).toThrow()

    try {
      expect(db.prepare("SELECT value FROM fabric_meta WHERE key = 'schema_version'").get()).toEqual({ value: '0' })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fabric_executors'").get()).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('rejects an incompatible current-version schema instead of accepting matching names', async () => {
    const { initActionFabricSchema } = await import('../../packages/server/src/services/hermes/action-fabric')
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE fabric_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO fabric_meta(key, value) VALUES ('schema_version', '4');
      CREATE VIEW fabric_capabilities AS SELECT 1 AS incompatible;
    `)

    try {
      expect(() => initActionFabricSchema(db)).toThrow()
      expect(db.prepare("SELECT value FROM fabric_meta WHERE key = 'schema_version'").get()).toEqual({ value: '4' })
    } finally {
      db.close()
    }
  })

  it('enforces relational and singleton schema constraints', async () => {
    const { withActionFabricDb } = await import('../../packages/server/src/services/hermes/action-fabric')

    withActionFabricDb(db => {
      expect(() => db.prepare(
        "INSERT INTO fabric_executor_capabilities(executor_id, capability_id, capability_version, contract_digest, created_at) VALUES ('missing', 'missing', 1, 'digest', 'now')",
      ).run()).toThrow(/foreign key constraint/i)
      expect(() => db.prepare(
        "INSERT INTO fabric_control_state(id, level, version, updated_at) VALUES (2, 0, 0, 'now')",
      ).run()).toThrow(/check constraint/i)
      expect(() => db.prepare(
        "UPDATE fabric_control_state SET level = 1, version = 0, updated_at = 'later' WHERE id = 1",
      ).run()).toThrow(/version must increase/i)
      db.prepare(`
        INSERT INTO fabric_capabilities(
          id, version, domain, verb, description, input_schema_json, output_schema_json, risk,
          side_effect, idempotency, reversible, verification_strategy, authentication_json,
          target_restrictions_json, contract_digest, enabled, created_at, updated_at
        ) VALUES ('simulator.echo', 1, 'simulator', 'echo', 'Echo', '{}', '{}', 'none',
          0, 'supported', 0, 'result_match', '[]', '[]', 'digest', 1, 'now', 'now')
      `).run()
      db.prepare(`
        INSERT INTO fabric_action_intents(
          id, capability_id, capability_version, requested_by_role_id, requested_by_user_id,
          idempotency_key, goal, target_json, input_json, constraints_json, rationale,
          material_input_digest, sanitized_summary_json, created_at, updated_at
        ) VALUES ('intent-1', 'simulator.echo', 1, 'role-1', 'user-1', 'key-1', 'Echo',
          '{}', '{}', '{}', 'test', 'digest', '{}', 'now', 'now')
      `).run()
      expect(() => db.prepare(
        "INSERT INTO fabric_workflows(id, intent_id, state, lease_owner, lease_expires_at, created_at, updated_at) VALUES ('workflow-1', 'intent-1', 'draft', 'worker', NULL, 'now', 'now')",
      ).run()).toThrow(/check constraint/i)
    })
  })

  it('rejects half-specified currency and amount pairs', async () => {
    const { withActionFabricDb } = await import('../../packages/server/src/services/hermes/action-fabric')

    withActionFabricDb(db => {
      const insertCapability = db.prepare(`
        INSERT INTO fabric_capabilities(
          id, version, domain, verb, description, input_schema_json, output_schema_json, risk,
          side_effect, idempotency, reversible, verification_strategy, authentication_json,
          target_restrictions_json, cost_currency, cost_estimated_minor, contract_digest, enabled,
          created_at, updated_at
        ) VALUES (?, 1, 'simulator', 'echo', 'Echo', '{}', '{}', 'none', 0, 'supported', 0,
          'result_match', '[]', '[]', ?, ?, 'digest', 1, 'now', 'now')
      `)
      expect(() => insertCapability.run('simulator.paid', null, 1)).toThrow(/check constraint/i)
      insertCapability.run('simulator.echo', null, 0)

      const insertIntent = db.prepare(`
        INSERT INTO fabric_action_intents(
          id, capability_id, capability_version, requested_by_role_id, requested_by_user_id,
          idempotency_key, goal, target_json, input_json, constraints_json, rationale,
          expected_cost_currency, expected_cost_minor, material_input_digest, sanitized_summary_json,
          created_at, updated_at
        ) VALUES (?, 'simulator.echo', 1, 'role-1', 'user-1', ?, 'Echo', '{}', '{}', '{}',
          'test', ?, ?, 'digest', '{}', 'now', 'now')
      `)
      expect(() => insertIntent.run('intent-currency-only', 'key-currency', 'USD', null)).toThrow(/check constraint/i)
      expect(() => insertIntent.run('intent-amount-only', 'key-amount', null, 100)).toThrow(/check constraint/i)
      insertIntent.run('intent-free', 'key-free', null, null)

      const insertPolicy = db.prepare(`
        INSERT INTO fabric_policy_decisions(
          id, intent_id, outcome, reason_codes_json, policy_version, material_input_digest,
          policy_snapshot_json, sanitized_summary_json, budget_currency, budget_amount_minor, created_at
        ) VALUES (?, 'intent-free', 'allow', '[]', 1, 'digest', '{}', '{}', ?, ?, 'now')
      `)
      expect(() => insertPolicy.run('policy-currency-only', 'USD', null)).toThrow(/check constraint/i)
      expect(() => insertPolicy.run('policy-amount-only', null, 100)).toThrow(/check constraint/i)
    })
  })
})

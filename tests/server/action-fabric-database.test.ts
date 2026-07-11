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

const REQUIRED_INDEXES = [
  'idx_fabric_audit_sequence',
  'idx_fabric_budget_daily',
  'idx_fabric_executor_capability',
  'idx_fabric_intent_idempotency',
  'idx_fabric_outbox_pending',
  'idx_fabric_policy_intent',
  'idx_fabric_steps_workflow_ordinal',
  'idx_fabric_workflows_state_lease',
]

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

  it('creates one global database below Hermes home with schema version one', async () => {
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

      expect(tables).toEqual(REQUIRED_TABLES)
      expect(REQUIRED_INDEXES.every(name => indexes.has(name))).toBe(true)
      expect(db.prepare("SELECT value FROM fabric_meta WHERE key = 'schema_version'").get()).toEqual({ value: '1' })
      expect(db.prepare('SELECT id, level, version FROM fabric_control_state').all()).toEqual([
        { id: 1, level: 0, version: 0 },
      ])
    } finally {
      db.close()
    }
  })

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
      expect(db.prepare("SELECT value FROM fabric_meta WHERE key = 'schema_version'").get()).toEqual({ value: '1' })
      expect(db.prepare('SELECT COUNT(*) AS count FROM fabric_control_state').get()).toEqual({ count: 1 })
      expect((db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fabric_%'",
      ).all() as Array<{ name: string }>)).toHaveLength(REQUIRED_TABLES.length)
    } finally {
      db.close()
    }
  })

  it('enables foreign keys for every managed connection', async () => {
    const { withActionFabricDb } = await import('../../packages/server/src/services/hermes/action-fabric')

    expect(withActionFabricDb(db => db.prepare('PRAGMA foreign_keys').get())).toEqual({ foreign_keys: 1 })
  })

  it('rejects a database created by a future schema version', async () => {
    const { getActionFabricDbPath, withActionFabricDb } = await import(
      '../../packages/server/src/services/hermes/action-fabric'
    )
    mkdirSync(join(hermesHome, 'personal'), { recursive: true })
    const db = new DatabaseSync(getActionFabricDbPath())
    db.exec('CREATE TABLE fabric_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO fabric_meta(key, value) VALUES (?, ?)').run('schema_version', '2')
    db.close()

    expect(() => withActionFabricDb(current => current.prepare('SELECT 1').get())).toThrow(
      /newer than supported version/i,
    )
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
})

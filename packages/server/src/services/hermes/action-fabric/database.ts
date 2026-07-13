import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getHermesBaseDir } from '../hermes-profile'

const SCHEMA_VERSION = 4
const REGISTRY_JSON_MAX_BYTES = 131_072
const PAYLOAD_JSON_MAX_BYTES = 32_768
const REQUIRED_TABLES = [
  'fabric_meta',
  'fabric_capabilities',
  'fabric_executors',
  'fabric_executor_capabilities',
  'fabric_action_intents',
  'fabric_workflows',
  'fabric_steps',
  'fabric_policy_decisions',
  'fabric_budget_ledger',
  'fabric_audit_events',
  'fabric_outbox',
  'fabric_control_state',
]
interface RequiredIndexSignature {
  name: string
  table: string
  unique: boolean
  columns: string[]
  partial: boolean
}

interface RequiredForeignKeySignature {
  table: string
  from: string
  targetTable: string
  to: string
  onDelete: 'NO ACTION' | 'CASCADE'
}

interface JsonColumnConstraint {
  column: string
  type: 'object' | 'array'
  maxBytes: number
  nullable?: boolean
}

interface JsonTableConstraint {
  table: string
  columns: JsonColumnConstraint[]
}

const JSON_TABLE_CONSTRAINTS: JsonTableConstraint[] = [
  { table: 'fabric_capabilities', columns: [
    { column: 'input_schema_json', type: 'object', maxBytes: REGISTRY_JSON_MAX_BYTES },
    { column: 'output_schema_json', type: 'object', maxBytes: REGISTRY_JSON_MAX_BYTES },
    { column: 'authentication_json', type: 'array', maxBytes: REGISTRY_JSON_MAX_BYTES },
    { column: 'target_restrictions_json', type: 'array', maxBytes: REGISTRY_JSON_MAX_BYTES },
  ] },
  { table: 'fabric_executors', columns: [
    { column: 'health_details_json', type: 'object', maxBytes: REGISTRY_JSON_MAX_BYTES },
    { column: 'configuration_json', type: 'object', maxBytes: REGISTRY_JSON_MAX_BYTES },
  ] },
  { table: 'fabric_action_intents', columns: [
    { column: 'target_json', type: 'object', maxBytes: PAYLOAD_JSON_MAX_BYTES },
    { column: 'input_json', type: 'object', maxBytes: PAYLOAD_JSON_MAX_BYTES },
    { column: 'constraints_json', type: 'object', maxBytes: PAYLOAD_JSON_MAX_BYTES },
    { column: 'sanitized_summary_json', type: 'object', maxBytes: PAYLOAD_JSON_MAX_BYTES },
  ] },
  { table: 'fabric_policy_decisions', columns: [
    { column: 'reason_codes_json', type: 'array', maxBytes: PAYLOAD_JSON_MAX_BYTES },
    { column: 'policy_snapshot_json', type: 'object', maxBytes: PAYLOAD_JSON_MAX_BYTES },
    { column: 'sanitized_summary_json', type: 'object', maxBytes: PAYLOAD_JSON_MAX_BYTES },
  ] },
  { table: 'fabric_steps', columns: [
    { column: 'input_json', type: 'object', maxBytes: PAYLOAD_JSON_MAX_BYTES },
    { column: 'output_json', type: 'object', maxBytes: PAYLOAD_JSON_MAX_BYTES, nullable: true },
    { column: 'evidence_json', type: 'array', maxBytes: PAYLOAD_JSON_MAX_BYTES },
  ] },
  { table: 'fabric_audit_events', columns: [
    { column: 'payload_json', type: 'object', maxBytes: PAYLOAD_JSON_MAX_BYTES },
  ] },
  { table: 'fabric_outbox', columns: [
    { column: 'payload_json', type: 'object', maxBytes: PAYLOAD_JSON_MAX_BYTES },
  ] },
]

const REQUIRED_INDEX_SIGNATURES: RequiredIndexSignature[] = [
  { name: 'idx_fabric_audit_sequence', table: 'fabric_audit_events', unique: true, columns: ['sequence'], partial: false },
  { name: 'idx_fabric_budget_daily', table: 'fabric_budget_ledger', unique: false, columns: ['requested_by_user_id', 'requested_by_role_id', 'ledger_date', 'currency', 'status'], partial: false },
  { name: 'idx_fabric_executor_capability', table: 'fabric_executor_capabilities', unique: false, columns: ['capability_id', 'capability_version', 'executor_id'], partial: false },
  { name: 'idx_fabric_intent_idempotency', table: 'fabric_action_intents', unique: true, columns: ['requested_by_user_id', 'requested_by_role_id', 'idempotency_key'], partial: false },
  { name: 'idx_fabric_outbox_pending', table: 'fabric_outbox', unique: false, columns: ['status', 'available_at', 'created_at'], partial: false },
  { name: 'idx_fabric_policy_intent', table: 'fabric_policy_decisions', unique: false, columns: ['intent_id', 'created_at'], partial: false },
  { name: 'idx_fabric_steps_workflow_ordinal', table: 'fabric_steps', unique: true, columns: ['workflow_id', 'ordinal'], partial: false },
  { name: 'idx_fabric_workflows_state_lease', table: 'fabric_workflows', unique: false, columns: ['state', 'lease_expires_at', 'retry_at'], partial: false },
]
const REQUIRED_COLUMNS = [{
  table: 'fabric_outbox', column: 'claim_token', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0,
}]
const REQUIRED_FOREIGN_KEYS: RequiredForeignKeySignature[] = [
  { table: 'fabric_capabilities', from: 'compensation_capability_id', targetTable: 'fabric_capabilities', to: 'id', onDelete: 'NO ACTION' },
  { table: 'fabric_executor_capabilities', from: 'executor_id', targetTable: 'fabric_executors', to: 'id', onDelete: 'CASCADE' },
  { table: 'fabric_executor_capabilities', from: 'capability_id', targetTable: 'fabric_capabilities', to: 'id', onDelete: 'CASCADE' },
  { table: 'fabric_action_intents', from: 'capability_id', targetTable: 'fabric_capabilities', to: 'id', onDelete: 'NO ACTION' },
  { table: 'fabric_policy_decisions', from: 'intent_id', targetTable: 'fabric_action_intents', to: 'id', onDelete: 'CASCADE' },
  { table: 'fabric_policy_decisions', from: 'executor_id', targetTable: 'fabric_executors', to: 'id', onDelete: 'NO ACTION' },
  { table: 'fabric_workflows', from: 'intent_id', targetTable: 'fabric_action_intents', to: 'id', onDelete: 'CASCADE' },
  { table: 'fabric_workflows', from: 'executor_id', targetTable: 'fabric_executors', to: 'id', onDelete: 'NO ACTION' },
  { table: 'fabric_workflows', from: 'policy_decision_id', targetTable: 'fabric_policy_decisions', to: 'id', onDelete: 'NO ACTION' },
  { table: 'fabric_workflows', from: 'compensation_intent_id', targetTable: 'fabric_action_intents', to: 'id', onDelete: 'NO ACTION' },
  { table: 'fabric_steps', from: 'workflow_id', targetTable: 'fabric_workflows', to: 'id', onDelete: 'CASCADE' },
  { table: 'fabric_steps', from: 'executor_id', targetTable: 'fabric_executors', to: 'id', onDelete: 'NO ACTION' },
  { table: 'fabric_budget_ledger', from: 'decision_id', targetTable: 'fabric_policy_decisions', to: 'id', onDelete: 'NO ACTION' },
  { table: 'fabric_budget_ledger', from: 'workflow_id', targetTable: 'fabric_workflows', to: 'id', onDelete: 'NO ACTION' },
]

type SynchronousResult<T> = T & (T extends PromiseLike<unknown> ? never : unknown)

export function getActionFabricDbPath(): string {
  return join(getHermesBaseDir(), 'personal', 'action-fabric.db')
}

export function withActionFabricDb<T>(operation: (db: DatabaseSync) => SynchronousResult<T>): T {
  const path = getActionFabricDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA journal_mode = WAL')
    initActionFabricSchema(db)
    const result = operation(db)
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined)
      throw new TypeError('Action Fabric database operation must be synchronous')
    }
    return result
  } finally {
    db.close()
  }
}

export function initActionFabricSchema(db: DatabaseSync): void {
  const currentVersion = readSchemaVersion(db)
  if (currentVersion !== null) {
    assertSupportedVersion(currentVersion)
    if (currentVersion === SCHEMA_VERSION && isSchemaComplete(db)) return
  }

  const rebuildExecutors = currentVersion !== null && currentVersion > 0 && currentVersion < 4
  if (rebuildExecutors) db.exec('PRAGMA foreign_keys = OFF')
  let transactionStarted = false
  try {
    db.exec('BEGIN IMMEDIATE')
    transactionStarted = true
    db.exec('CREATE TABLE IF NOT EXISTS fabric_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = db.prepare("SELECT value FROM fabric_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
    const version = parseSchemaVersion(row?.value)
    assertSupportedVersion(version)
    if (version < 1) {
      createSchemaV1(db)
      setSchemaVersion(db, 1)
    } else {
      createSchemaV1(db)
    }
    if (version < 2) {
      migrateSchemaV2(db)
      setSchemaVersion(db, 2)
    }
    if (version < 3) {
      migrateSchemaV3(db)
      setSchemaVersion(db, 3)
    } else {
      createSchemaV3Triggers(db)
    }
    if (version < 4) {
      migrateSchemaV4(db)
      setSchemaVersion(db, 4)
    }
    assertSchemaComplete(db, SCHEMA_VERSION)
    db.exec('COMMIT')
  } catch (error) {
    if (transactionStarted) db.exec('ROLLBACK')
    throw error
  } finally {
    if (rebuildExecutors) db.exec('PRAGMA foreign_keys = ON')
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  return typeof (value as { then?: unknown }).then === 'function'
}

function readSchemaVersion(db: DatabaseSync): number | null {
  const meta = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'fabric_meta'",
  ).get()
  if (meta === undefined) return null
  const row = db.prepare("SELECT value FROM fabric_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
  return parseSchemaVersion(row?.value)
}

function parseSchemaVersion(value: string | undefined): number {
  if (value === undefined) return 0
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Action Fabric schema version is invalid: ${value}`)
  }
  const version = Number(value)
  if (!Number.isSafeInteger(version)) {
    throw new Error(`Action Fabric schema version is invalid: ${value}`)
  }
  return version
}

function assertSupportedVersion(version: number): void {
  if (version > SCHEMA_VERSION) {
    throw new Error(`Action Fabric schema version ${version} is newer than supported version ${SCHEMA_VERSION}`)
  }
}

function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(`
    INSERT INTO fabric_meta(key, value) VALUES('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(version))
}

function assertSchemaComplete(db: DatabaseSync, version: number): void {
  const tables = new Set((db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fabric_%'",
  ).all() as Array<{ name: string }>).map(row => row.name))
  const indexes = new Set((db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_fabric_%'",
  ).all() as Array<{ name: string }>).map(row => row.name))
  const missing = [
    ...REQUIRED_TABLES.filter(name => !tables.has(name)),
    ...REQUIRED_INDEX_SIGNATURES.map(signature => signature.name).filter(name => !indexes.has(name)),
  ]
  if (missing.length > 0) {
    throw new Error(`Action Fabric schema version ${version} is incomplete: missing ${missing.join(', ')}`)
  }
  for (const signature of REQUIRED_INDEX_SIGNATURES) assertIndexSignature(db, signature)
  for (const constraint of JSON_TABLE_CONSTRAINTS) {
    assertJsonTriggerSignature(db, constraint, 'INSERT')
    assertJsonTriggerSignature(db, constraint, 'UPDATE')
  }
  for (const required of REQUIRED_COLUMNS) {
    const column = (db.prepare(`PRAGMA table_info("${required.table}")`).all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null; pk: number
    }>).find(row => row.name === required.column)
    if (column?.type !== required.type || column.notnull !== required.notnull
      || column.dflt_value !== required.defaultValue || column.pk !== required.pk) {
      throw new Error(`Action Fabric schema version ${version} is incomplete: missing ${required.table}.${required.column}`)
    }
  }
  assertExecutorTypeConstraint(db)
  assertForeignKeySignatures(db)
  const violations = db.prepare('PRAGMA foreign_key_check').all()
  if (violations.length > 0) throw new Error('Action Fabric schema foreign key integrity check failed')
}

function assertForeignKeySignatures(db: DatabaseSync): void {
  const grouped = new Map<string, RequiredForeignKeySignature[]>()
  for (const expected of REQUIRED_FOREIGN_KEYS) grouped.set(expected.table, [...(grouped.get(expected.table) ?? []), expected])
  for (const [table, expected] of grouped) {
    const actual = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
      table: string; from: string; to: string; on_update: string; on_delete: string; match: string
    }>
    const matches = actual.length === expected.length && expected.every(item => actual.some(row =>
      row.from === item.from && row.table === item.targetTable && row.to === item.to
      && row.on_update === 'NO ACTION' && row.on_delete === item.onDelete && row.match === 'NONE'))
    if (!matches) throw new Error(`Action Fabric schema foreign key signature mismatch: ${table}`)
  }
}

function assertExecutorTypeConstraint(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fabric_executors'").get() as
    { sql: string | null } | undefined
  const sql = row?.sql?.replace(/\s+/g, ' ').toLowerCase() ?? ''
  if (!/type\s+text\s+not\s+null\s+check\s*\(\s*type\s+in\s*\(\s*'simulator'\s*,\s*'internal'\s*,\s*'connector'\s*\)\s*\)/.test(sql)) {
    throw new Error('Action Fabric schema executor type signature mismatch')
  }
}

function assertJsonTriggerSignature(
  db: DatabaseSync,
  constraint: JsonTableConstraint,
  operation: 'INSERT' | 'UPDATE',
): void {
  const name = jsonTriggerName(constraint.table, operation)
  const row = db.prepare(
    "SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  ).get(name) as { tbl_name: string; sql: string | null } | undefined
  const expected = normalizeTriggerSql(jsonTriggerSql(constraint, operation))
  if (row?.tbl_name !== constraint.table || row.sql === null || normalizeTriggerSql(row.sql) !== expected) {
    throw new Error(`Action Fabric schema JSON trigger signature mismatch: ${name}`)
  }
}

function normalizeTriggerSql(sql: string): string {
  return sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function assertIndexSignature(db: DatabaseSync, expected: RequiredIndexSignature): void {
  const schemaRow = db.prepare(
    "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get(expected.name) as { tbl_name: string } | undefined
  const indexRow = (db.prepare(`PRAGMA index_list("${expected.table}")`).all() as Array<{
    name: string
    unique: number
    partial: number
  }>).find(row => row.name === expected.name)
  const columns = (db.prepare(`PRAGMA index_info("${expected.name}")`).all() as Array<{
    seqno: number
    name: string
  }>).sort((left, right) => left.seqno - right.seqno).map(row => row.name)
  const matches = schemaRow?.tbl_name === expected.table
    && indexRow?.unique === Number(expected.unique)
    && indexRow.partial === Number(expected.partial)
    && columns.length === expected.columns.length
    && columns.every((column, index) => column === expected.columns[index])
  if (!matches) {
    throw new Error(`Action Fabric schema index signature mismatch: ${expected.name}`)
  }
}

function isSchemaComplete(db: DatabaseSync): boolean {
  try {
    assertSchemaComplete(db, SCHEMA_VERSION)
    return true
  } catch {
    return false
  }
}

function createSchemaV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fabric_capabilities (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK(version > 0),
      domain TEXT NOT NULL,
      verb TEXT NOT NULL,
      description TEXT NOT NULL,
      input_schema_json TEXT NOT NULL,
      output_schema_json TEXT NOT NULL,
      risk TEXT NOT NULL CHECK(risk IN ('none','low','medium','high','critical')),
      side_effect INTEGER NOT NULL CHECK(side_effect IN (0,1)),
      idempotency TEXT NOT NULL CHECK(idempotency IN ('required','supported','none')),
      reversible INTEGER NOT NULL CHECK(reversible IN (0,1)),
      compensation_capability_id TEXT,
      verification_strategy TEXT NOT NULL,
      authentication_json TEXT NOT NULL,
      target_restrictions_json TEXT NOT NULL,
      cost_currency TEXT,
      cost_estimated_minor INTEGER NOT NULL DEFAULT 0 CHECK(cost_estimated_minor >= 0),
      contract_digest TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(cost_currency IS NOT NULL OR cost_estimated_minor = 0),
      FOREIGN KEY(compensation_capability_id) REFERENCES fabric_capabilities(id)
    );

    CREATE TABLE IF NOT EXISTS fabric_executors (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('simulator','internal','connector')),
      name TEXT NOT NULL,
      environment TEXT NOT NULL CHECK(environment IN ('simulator','internal','sandbox','production')),
      health TEXT NOT NULL CHECK(health IN ('unknown','healthy','degraded','unhealthy')),
      health_details_json TEXT NOT NULL DEFAULT '{}',
      configuration_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fabric_executor_capabilities (
      executor_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      capability_version INTEGER NOT NULL CHECK(capability_version > 0),
      contract_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(executor_id, capability_id),
      FOREIGN KEY(executor_id) REFERENCES fabric_executors(id) ON DELETE CASCADE,
      FOREIGN KEY(capability_id) REFERENCES fabric_capabilities(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_fabric_executor_capability
      ON fabric_executor_capabilities(capability_id, capability_version, executor_id);

    CREATE TABLE IF NOT EXISTS fabric_action_intents (
      id TEXT PRIMARY KEY,
      capability_id TEXT NOT NULL,
      capability_version INTEGER NOT NULL CHECK(capability_version > 0),
      requested_by_role_id TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      goal TEXT NOT NULL,
      target_json TEXT NOT NULL,
      input_json TEXT NOT NULL,
      constraints_json TEXT NOT NULL,
      rationale TEXT NOT NULL,
      expected_cost_currency TEXT,
      expected_cost_minor INTEGER CHECK(expected_cost_minor IS NULL OR expected_cost_minor >= 0),
      material_input_digest TEXT NOT NULL,
      sanitized_summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK((expected_cost_currency IS NULL) = (expected_cost_minor IS NULL)),
      FOREIGN KEY(capability_id) REFERENCES fabric_capabilities(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fabric_intent_idempotency
      ON fabric_action_intents(requested_by_user_id, requested_by_role_id, idempotency_key);

    CREATE TABLE IF NOT EXISTS fabric_policy_decisions (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      executor_id TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('allow','deny','waiting_user')),
      reason_codes_json TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK(policy_version > 0),
      material_input_digest TEXT NOT NULL,
      policy_snapshot_json TEXT NOT NULL,
      sanitized_summary_json TEXT NOT NULL,
      budget_currency TEXT,
      budget_amount_minor INTEGER CHECK(budget_amount_minor IS NULL OR budget_amount_minor >= 0),
      created_at TEXT NOT NULL,
      CHECK((budget_currency IS NULL) = (budget_amount_minor IS NULL)),
      FOREIGN KEY(intent_id) REFERENCES fabric_action_intents(id) ON DELETE CASCADE,
      FOREIGN KEY(executor_id) REFERENCES fabric_executors(id)
    );
    CREATE INDEX IF NOT EXISTS idx_fabric_policy_intent
      ON fabric_policy_decisions(intent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS fabric_workflows (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL UNIQUE,
      executor_id TEXT,
      policy_decision_id TEXT,
      compensation_intent_id TEXT,
      state TEXT NOT NULL CHECK(state IN (
        'draft','policy_check','preparing','executing','verifying','waiting_user','retrying',
        'compensating','succeeded','denied','cancelled','failed','dead_letter','compensated'
      )),
      version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts > 0),
      lease_owner TEXT,
      lease_expires_at TEXT,
      retry_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK((lease_owner IS NULL) = (lease_expires_at IS NULL)),
      FOREIGN KEY(intent_id) REFERENCES fabric_action_intents(id) ON DELETE CASCADE,
      FOREIGN KEY(executor_id) REFERENCES fabric_executors(id),
      FOREIGN KEY(policy_decision_id) REFERENCES fabric_policy_decisions(id),
      FOREIGN KEY(compensation_intent_id) REFERENCES fabric_action_intents(id)
    );
    CREATE INDEX IF NOT EXISTS idx_fabric_workflows_state_lease
      ON fabric_workflows(state, lease_expires_at, retry_at);

    CREATE TABLE IF NOT EXISTS fabric_steps (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','running','waiting_user','succeeded','failed','cancelled','compensated')),
      execution_token TEXT NOT NULL UNIQUE,
      executor_id TEXT,
      input_json TEXT NOT NULL,
      output_json TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY(workflow_id) REFERENCES fabric_workflows(id) ON DELETE CASCADE,
      FOREIGN KEY(executor_id) REFERENCES fabric_executors(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fabric_steps_workflow_ordinal
      ON fabric_steps(workflow_id, ordinal);

    CREATE TABLE IF NOT EXISTS fabric_budget_ledger (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      workflow_id TEXT,
      requested_by_user_id TEXT NOT NULL,
      requested_by_role_id TEXT NOT NULL,
      ledger_date TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
      status TEXT NOT NULL CHECK(status IN ('reserved','committed','released')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(decision_id) REFERENCES fabric_policy_decisions(id),
      FOREIGN KEY(workflow_id) REFERENCES fabric_workflows(id)
    );
    CREATE INDEX IF NOT EXISTS idx_fabric_budget_daily
      ON fabric_budget_ledger(requested_by_user_id, requested_by_role_id, ledger_date, currency, status);

    CREATE TABLE IF NOT EXISTS fabric_audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fabric_audit_sequence
      ON fabric_audit_events(sequence);

    CREATE TABLE IF NOT EXISTS fabric_outbox (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','published','failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      available_at TEXT NOT NULL,
      locked_until TEXT,
      created_at TEXT NOT NULL,
      published_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fabric_outbox_pending
      ON fabric_outbox(status, available_at, created_at);

    CREATE TABLE IF NOT EXISTS fabric_control_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      level INTEGER NOT NULL CHECK(level BETWEEN 0 AND 3),
      version INTEGER NOT NULL CHECK(version >= 0),
      actor_user_id TEXT,
      reason TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO fabric_control_state(id, level, version, actor_user_id, reason, updated_at)
      VALUES(1, 0, 0, NULL, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    CREATE TRIGGER IF NOT EXISTS fabric_control_state_prevent_delete
      BEFORE DELETE ON fabric_control_state BEGIN SELECT RAISE(ABORT, 'fabric control state is required'); END;
    CREATE TRIGGER IF NOT EXISTS fabric_control_state_monotonic_version
      BEFORE UPDATE ON fabric_control_state WHEN NEW.version <= OLD.version
      BEGIN SELECT RAISE(ABORT, 'fabric control state version must increase'); END;
  `)
}

function migrateSchemaV2(db: DatabaseSync): void {
  const columns = (db.prepare('PRAGMA table_info("fabric_outbox")').all() as Array<{ name: string }>)
    .map(row => row.name)
  if (!columns.includes('claim_token')) db.exec('ALTER TABLE fabric_outbox ADD COLUMN claim_token TEXT')
}

function migrateSchemaV3(db: DatabaseSync): void {
  assertLegacyJsonRows(db)
  createSchemaV3Triggers(db)
}

function migrateSchemaV4(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fabric_executors'").get() as
    { sql: string | null } | undefined
  if (row?.sql?.toLowerCase().includes("'connector'")) return
  db.exec(`
    CREATE TABLE fabric_executors_v4 (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('simulator','internal','connector')),
      name TEXT NOT NULL,
      environment TEXT NOT NULL CHECK(environment IN ('simulator','internal','sandbox','production')),
      health TEXT NOT NULL CHECK(health IN ('unknown','healthy','degraded','unhealthy')),
      health_details_json TEXT NOT NULL DEFAULT '{}',
      configuration_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO fabric_executors_v4 SELECT * FROM fabric_executors;
    DROP TABLE fabric_executors;
    ALTER TABLE fabric_executors_v4 RENAME TO fabric_executors;
  `)
  createSchemaV3Triggers(db)
}

function assertLegacyJsonRows(db: DatabaseSync): void {
  for (const table of JSON_TABLE_CONSTRAINTS) {
    for (const column of table.columns) {
      const invalid = db.prepare(
        `SELECT rowid FROM "${table.table}" WHERE ${jsonColumnInvalidExpression(column, column.column)} LIMIT 1`,
      ).get()
      if (invalid !== undefined) {
        throw new Error(`Action Fabric legacy JSON constraint failed: ${table.table}.${column.column}`)
      }
    }
  }
}

function createSchemaV3Triggers(db: DatabaseSync): void {
  for (const constraint of JSON_TABLE_CONSTRAINTS) {
    db.exec(jsonTriggerSql(constraint, 'INSERT'))
    db.exec(jsonTriggerSql(constraint, 'UPDATE'))
  }
}

function jsonTriggerName(table: string, operation: 'INSERT' | 'UPDATE'): string {
  return `${table}_json_${operation.toLowerCase()}`
}

function jsonTriggerSql(constraint: JsonTableConstraint, operation: 'INSERT' | 'UPDATE'): string {
  const invalid = constraint.columns
    .map(column => jsonColumnInvalidExpression(column, `NEW."${column.column}"`))
    .join('\n        OR ')
  return `
    CREATE TRIGGER IF NOT EXISTS "${jsonTriggerName(constraint.table, operation)}"
    BEFORE ${operation} ON "${constraint.table}"
    WHEN ${invalid}
    BEGIN
      SELECT RAISE(ABORT, 'Action Fabric JSON constraint failed: ${constraint.table}');
    END
  `
}

function jsonColumnInvalidExpression(column: JsonColumnConstraint, reference: string): string {
  const valid = `CASE
          WHEN ${reference} IS NULL THEN ${column.nullable ? 1 : 0}
          WHEN typeof(${reference}) <> 'text' THEN 0
          WHEN json_valid(${reference}) = 0 THEN 0
          WHEN json_type(${reference}) <> '${column.type}' THEN 0
          WHEN length(CAST(${reference} AS BLOB)) > ${column.maxBytes} THEN 0
          ELSE 1
        END`
  return `${valid} = 0`
}

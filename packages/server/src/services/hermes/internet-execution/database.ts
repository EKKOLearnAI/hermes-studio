import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getHermesBaseDir } from '../hermes-profile'

const SCHEMA_VERSION = 1

const RECEIPTS_SQL = `CREATE TABLE internet_execution_receipts (
  workflow_id TEXT PRIMARY KEY CHECK(length(workflow_id) BETWEEN 10 AND 200 AND workflow_id LIKE 'workflow-%'),
  intent_id TEXT NOT NULL CHECK(length(intent_id) BETWEEN 8 AND 200 AND intent_id LIKE 'intent-%'),
  material_digest TEXT NOT NULL CHECK(length(material_digest)=64 AND material_digest NOT GLOB '*[^a-f0-9]*'),
  capability_id TEXT NOT NULL CHECK(length(capability_id) BETWEEN 3 AND 160),
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 80),
  profile TEXT NOT NULL CHECK(length(profile) BETWEEN 1 AND 200),
  executor_id TEXT NOT NULL CHECK(length(executor_id) BETWEEN 1 AND 160),
  executor_type TEXT NOT NULL CHECK(executor_type IN ('mcp','browser')),
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 100),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)=1 AND json_type(request_json)='object'
    AND length(CAST(request_json AS BLOB))<=65536),
  safe_to_replay INTEGER NOT NULL CHECK(safe_to_replay IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('prepared','executing','executed','verifying','verified','unknown','mismatch','failed','waiting_user')),
  provider_request_id TEXT CHECK(provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 255),
  result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json)=1 AND json_type(result_json)='object'
    AND length(CAST(result_json AS BLOB))<=65536)),
  error_code TEXT CHECK(error_code IS NULL OR (length(error_code) BETWEEN 2 AND 128 AND error_code NOT GLOB '*[^A-Z0-9_]*')),
  version INTEGER NOT NULL CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
)`

const CHECKPOINTS_SQL = `CREATE TABLE internet_execution_checkpoints (
  workflow_id TEXT NOT NULL REFERENCES internet_execution_receipts(workflow_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  kind TEXT NOT NULL CHECK(kind IN ('mcp_call','browser_navigate','browser_snapshot','verification_read')),
  public_url TEXT CHECK(public_url IS NULL OR (length(public_url) BETWEEN 8 AND 2048 AND public_url LIKE 'https://%')),
  evidence_digest TEXT CHECK(evidence_digest IS NULL OR (length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^a-f0-9]*')),
  details_json TEXT NOT NULL CHECK(json_valid(details_json)=1 AND json_type(details_json)='object'
    AND length(CAST(details_json AS BLOB))<=65536),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workflow_id,ordinal)
)`

const TRIGGER_SQL = {
  internet_receipts_identity_immutable: `CREATE TRIGGER internet_receipts_identity_immutable
    BEFORE UPDATE ON internet_execution_receipts
    WHEN NEW.workflow_id<>OLD.workflow_id OR NEW.intent_id<>OLD.intent_id
      OR NEW.material_digest<>OLD.material_digest OR NEW.capability_id<>OLD.capability_id
      OR NEW.provider<>OLD.provider OR NEW.profile<>OLD.profile OR NEW.executor_id<>OLD.executor_id
      OR NEW.executor_type<>OLD.executor_type OR NEW.environment<>OLD.environment
      OR NEW.operation<>OLD.operation OR NEW.request_json<>OLD.request_json
      OR NEW.safe_to_replay<>OLD.safe_to_replay OR NEW.created_at<>OLD.created_at
    BEGIN SELECT RAISE(ABORT,'Internet execution receipt identity is immutable'); END`,
  internet_receipts_version_monotonic: `CREATE TRIGGER internet_receipts_version_monotonic
    BEFORE UPDATE ON internet_execution_receipts WHEN NEW.version<>OLD.version+1
    BEGIN SELECT RAISE(ABORT,'Internet execution receipt version must increase'); END`,
  internet_receipts_no_delete: `CREATE TRIGGER internet_receipts_no_delete
    BEFORE DELETE ON internet_execution_receipts
    BEGIN SELECT RAISE(ABORT,'Internet execution receipts are immutable records'); END`,
  internet_checkpoints_no_update: `CREATE TRIGGER internet_checkpoints_no_update
    BEFORE UPDATE ON internet_execution_checkpoints
    BEGIN SELECT RAISE(ABORT,'Internet execution checkpoints are immutable'); END`,
  internet_checkpoints_no_delete: `CREATE TRIGGER internet_checkpoints_no_delete
    BEFORE DELETE ON internet_execution_checkpoints
    BEGIN SELECT RAISE(ABORT,'Internet execution checkpoints are immutable'); END`,
} as const

type SyncResult<T> = T & (T extends PromiseLike<unknown> ? never : unknown)

export function getInternetExecutionDbPath(): string {
  return join(getHermesBaseDir(), 'personal', 'internet-execution.db')
}

export function withInternetExecutionDb<T>(operation: (db: DatabaseSync) => SyncResult<T>): T {
  const path = getInternetExecutionDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL')
    initInternetExecutionSchema(db)
    const result = operation(db)
    if (result !== null && (typeof result === 'object' || typeof result === 'function')
      && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => undefined)
      throw new TypeError('Internet execution database operation must be synchronous')
    }
    return result
  } finally {
    db.close()
  }
}

export function initInternetExecutionSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE IF NOT EXISTS internet_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    const row = db.prepare("SELECT value FROM internet_meta WHERE key='schema_version'").get() as
      { value: string } | undefined
    const version = parseVersion(row?.value)
    if (version > SCHEMA_VERSION) {
      throw new Error(`Internet execution schema version ${version} is newer than supported version ${SCHEMA_VERSION}`)
    }
    if (version < 1) {
      createSchemaV1(db)
      db.prepare("INSERT INTO internet_meta(key,value) VALUES('schema_version','1') ON CONFLICT(key) DO UPDATE SET value='1'").run()
    } else {
      createSchemaV1(db)
    }
    assertSchema(db)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function createSchemaV1(db: DatabaseSync): void {
  db.exec(`
    ${RECEIPTS_SQL.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')};
    CREATE INDEX IF NOT EXISTS idx_internet_receipts_status_updated
      ON internet_execution_receipts(status,updated_at,workflow_id);
    ${CHECKPOINTS_SQL.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')};
    CREATE INDEX IF NOT EXISTS idx_internet_checkpoints_kind_created
      ON internet_execution_checkpoints(kind,created_at,workflow_id);
    ${Object.values(TRIGGER_SQL).map(sql => sql.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS ')).join(';')};
  `)
}

function parseVersion(value: string | undefined): number {
  if (value === undefined) return 0
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Internet execution schema version is invalid: ${value}`)
  const version = Number(value)
  if (!Number.isSafeInteger(version)) throw new Error(`Internet execution schema version is invalid: ${value}`)
  return version
}

function assertSchema(db: DatabaseSync): void {
  const tables = new Set((db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'internet_%'",
  ).all() as Array<{ name: string }>).map(row => row.name))
  for (const name of ['internet_meta', 'internet_execution_receipts', 'internet_execution_checkpoints']) {
    if (!tables.has(name)) throw new Error(`Internet execution schema is incomplete: ${name}`)
  }
  assertTableSql(db, 'internet_execution_receipts', RECEIPTS_SQL)
  assertTableSql(db, 'internet_execution_checkpoints', CHECKPOINTS_SQL)
  assertIndex(db, 'internet_execution_receipts', 'idx_internet_receipts_status_updated',
    ['status', 'updated_at', 'workflow_id'])
  assertIndex(db, 'internet_execution_checkpoints', 'idx_internet_checkpoints_kind_created',
    ['kind', 'created_at', 'workflow_id'])
  for (const [name, expected] of Object.entries(TRIGGER_SQL)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as
      { sql: string } | undefined
    if (!row || canonicalSql(row.sql) !== canonicalSql(expected)) {
      throw new Error(`Internet execution schema trigger signature mismatch: ${name}`)
    }
  }
  if ((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length) {
    throw new Error('Internet execution schema foreign key integrity check failed')
  }
}

function assertTableSql(db: DatabaseSync, name: string, expected: string): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as
    { sql: string } | undefined
  if (!row || canonicalSql(row.sql) !== canonicalSql(expected)) {
    throw new Error(`Internet execution schema table signature mismatch: ${name}`)
  }
}

function assertIndex(db: DatabaseSync, table: string, name: string, expectedColumns: string[]): void {
  const index = (db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{
    name: string; unique: number; partial: number
  }>).find(item => item.name === name)
  const columns = index ? (db.prepare(`PRAGMA index_info('${name}')`).all() as Array<{ seqno: number; name: string }>)
    .sort((left, right) => left.seqno - right.seqno).map(item => item.name) : []
  if (!index || index.unique !== 0 || index.partial !== 0
    || columns.length !== expectedColumns.length || columns.some((column, position) => column !== expectedColumns[position])) {
    throw new Error(`Internet execution schema index signature mismatch: ${name}`)
  }
}

function canonicalSql(value: string): string {
  return value.replace(/\bIF\s+NOT\s+EXISTS\b/gi, '').replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase()
}

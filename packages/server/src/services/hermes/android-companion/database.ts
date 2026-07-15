import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getHermesBaseDir } from '../hermes-profile'

const SCHEMA_VERSION = 2

const TABLE_SQL = {
  android_companion_devices: `CREATE TABLE android_companion_devices (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 20 AND 80),
    installation_id TEXT NOT NULL UNIQUE CHECK(length(installation_id) BETWEEN 8 AND 160),
    signing_public_key TEXT NOT NULL CHECK(length(signing_public_key) BETWEEN 80 AND 4096),
    exchange_public_key TEXT NOT NULL CHECK(length(exchange_public_key) BETWEEN 80 AND 4096),
    signing_fingerprint TEXT NOT NULL CHECK(length(signing_fingerprint)=64 AND signing_fingerprint NOT GLOB '*[^a-f0-9]*'),
    exchange_fingerprint TEXT NOT NULL CHECK(length(exchange_fingerprint)=64 AND exchange_fingerprint NOT GLOB '*[^a-f0-9]*'),
    label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
    android_version TEXT NOT NULL CHECK(length(android_version) BETWEEN 1 AND 80),
    app_version TEXT NOT NULL CHECK(length(app_version) BETWEEN 1 AND 80),
    state TEXT NOT NULL CHECK(state IN ('paired','revoked')),
    capabilities_revision INTEGER NOT NULL DEFAULT 0 CHECK(capabilities_revision>=0),
    capabilities_digest TEXT CHECK(capabilities_digest IS NULL OR (length(capabilities_digest)=64 AND capabilities_digest NOT GLOB '*[^a-f0-9]*')),
    last_received_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_received_sequence>=0),
    last_sent_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sent_sequence>=0),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
    paired_at TEXT NOT NULL,
    revoked_at TEXT,
    revocation_reason TEXT CHECK(revocation_reason IS NULL OR (length(revocation_reason) BETWEEN 2 AND 128 AND revocation_reason NOT GLOB '*[^A-Z0-9_]*')),
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((state='paired' AND revoked_at IS NULL AND revocation_reason IS NULL)
      OR (state='revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
  )`,
  android_companion_capabilities: `CREATE TABLE android_companion_capabilities (
    device_id TEXT NOT NULL REFERENCES android_companion_devices(id) ON DELETE CASCADE,
    capability_id TEXT NOT NULL CHECK(length(capability_id) BETWEEN 3 AND 160),
    capability_version INTEGER NOT NULL CHECK(capability_version>0),
    package_binding TEXT NOT NULL CHECK(length(package_binding) BETWEEN 3 AND 255),
    package_fingerprint TEXT NOT NULL CHECK(length(package_fingerprint)=64 AND package_fingerprint NOT GLOB '*[^a-f0-9]*'),
    driver_version TEXT NOT NULL CHECK(length(driver_version) BETWEEN 1 AND 80),
    permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)=1 AND json_type(permissions_json)='array'
      AND length(CAST(permissions_json AS BLOB))<=16384),
    verification_strategy TEXT NOT NULL CHECK(length(verification_strategy) BETWEEN 1 AND 160),
    health TEXT NOT NULL CHECK(health IN ('healthy','degraded','unavailable')),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    report_revision INTEGER NOT NULL CHECK(report_revision>0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(device_id,capability_id)
  )`,
  android_companion_commands: `CREATE TABLE android_companion_commands (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 10 AND 200),
    workflow_id TEXT NOT NULL CHECK(length(workflow_id) BETWEEN 10 AND 200 AND workflow_id LIKE 'workflow-%'),
    execution_token TEXT NOT NULL CHECK(length(execution_token) BETWEEN 8 AND 200),
    material_digest TEXT NOT NULL CHECK(length(material_digest)=64 AND material_digest NOT GLOB '*[^a-f0-9]*'),
    device_id TEXT NOT NULL REFERENCES android_companion_devices(id),
    capability_id TEXT NOT NULL CHECK(length(capability_id) BETWEEN 3 AND 160),
    capability_version INTEGER NOT NULL CHECK(capability_version>0),
    kind TEXT NOT NULL CHECK(kind IN ('app_launch','screen_capture','foreground_verify','cancel')),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)=1 AND json_type(payload_json)='object'
      AND length(CAST(payload_json AS BLOB))<=32768),
    status TEXT NOT NULL CHECK(status IN ('queued','delivered','acknowledged','succeeded','failed','unknown','waiting_user','cancelled')),
    delivery_sequence INTEGER CHECK(delivery_sequence IS NULL OR delivery_sequence>0),
    delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempts>=0),
    response_json TEXT CHECK(response_json IS NULL OR (json_valid(response_json)=1 AND json_type(response_json)='object'
      AND length(CAST(response_json AS BLOB))<=32768)),
    error_code TEXT CHECK(error_code IS NULL OR (length(error_code) BETWEEN 2 AND 128 AND error_code NOT GLOB '*[^A-Z0-9_]*')),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(workflow_id,execution_token,kind)
  )`,
  android_execution_receipts: `CREATE TABLE android_execution_receipts (
    workflow_id TEXT PRIMARY KEY CHECK(length(workflow_id) BETWEEN 10 AND 200 AND workflow_id LIKE 'workflow-%'),
    intent_id TEXT NOT NULL CHECK(length(intent_id) BETWEEN 8 AND 200 AND intent_id LIKE 'intent-%'),
    material_digest TEXT NOT NULL CHECK(length(material_digest)=64 AND material_digest NOT GLOB '*[^a-f0-9]*'),
    device_id TEXT NOT NULL REFERENCES android_companion_devices(id),
    capability_id TEXT NOT NULL CHECK(length(capability_id) BETWEEN 3 AND 160),
    capability_version INTEGER NOT NULL CHECK(capability_version>0),
    target_json TEXT NOT NULL CHECK(json_valid(target_json)=1 AND json_type(target_json)='object'
      AND length(CAST(target_json AS BLOB))<=32768),
    status TEXT NOT NULL CHECK(status IN ('prepared','executing','executed','verifying','verified','unknown','mismatch','failed','waiting_user')),
    command_id TEXT REFERENCES android_companion_commands(id),
    result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json)=1 AND json_type(result_json)='object'
      AND length(CAST(result_json AS BLOB))<=32768)),
    verification_json TEXT CHECK(verification_json IS NULL OR (json_valid(verification_json)=1 AND json_type(verification_json)='object'
      AND length(CAST(verification_json AS BLOB))<=32768)),
    error_code TEXT CHECK(error_code IS NULL OR (length(error_code) BETWEEN 2 AND 128 AND error_code NOT GLOB '*[^A-Z0-9_]*')),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  android_notification_observations: `CREATE TABLE android_notification_observations (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 10 AND 200),
    device_id TEXT NOT NULL REFERENCES android_companion_devices(id),
    package_binding TEXT NOT NULL CHECK(length(package_binding) BETWEEN 3 AND 255),
    notification_key_hash TEXT NOT NULL CHECK(length(notification_key_hash)=64 AND notification_key_hash NOT GLOB '*[^a-f0-9]*'),
    category TEXT NOT NULL CHECK(length(category) BETWEEN 1 AND 80),
    channel_hash TEXT CHECK(channel_hash IS NULL OR (length(channel_hash)=64 AND channel_hash NOT GLOB '*[^a-f0-9]*')),
    title_summary TEXT NOT NULL CHECK(length(title_summary)<=500),
    text_summary TEXT NOT NULL CHECK(length(text_summary)<=1000),
    sensitivity TEXT NOT NULL CHECK(sensitivity IN ('metadata','minimized','standard')),
    source_sequence INTEGER NOT NULL CHECK(source_sequence>0),
    provenance_digest TEXT NOT NULL CHECK(length(provenance_digest)=64 AND provenance_digest NOT GLOB '*[^a-f0-9]*'),
    posted_at TEXT NOT NULL,
    removed_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(device_id,notification_key_hash,posted_at)
  )`,
  android_screen_artifacts: `CREATE TABLE android_screen_artifacts (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 10 AND 200),
    device_id TEXT NOT NULL REFERENCES android_companion_devices(id),
    workflow_id TEXT NOT NULL CHECK(length(workflow_id) BETWEEN 10 AND 200 AND workflow_id LIKE 'workflow-%'),
    command_id TEXT NOT NULL REFERENCES android_companion_commands(id),
    digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*'),
    mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/webp')),
    width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 16384),
    height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 16384),
    byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 52428800),
    encryption_context_digest TEXT NOT NULL CHECK(length(encryption_context_digest)=64 AND encryption_context_digest NOT GLOB '*[^a-f0-9]*'),
    captured_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  android_takeovers: `CREATE TABLE android_takeovers (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 10 AND 200),
    workflow_id TEXT NOT NULL CHECK(length(workflow_id) BETWEEN 10 AND 200 AND workflow_id LIKE 'workflow-%'),
    command_id TEXT NOT NULL REFERENCES android_companion_commands(id),
    device_id TEXT NOT NULL REFERENCES android_companion_devices(id),
    capability_id TEXT NOT NULL CHECK(length(capability_id) BETWEEN 3 AND 160),
    reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 2 AND 128 AND reason_code NOT GLOB '*[^A-Z0-9_]*'),
    generation INTEGER NOT NULL CHECK(generation>0),
    status TEXT NOT NULL CHECK(status IN ('requested','claimed','completed','expired','cancelled')),
    claim_digest TEXT CHECK(claim_digest IS NULL OR (length(claim_digest)=64 AND claim_digest NOT GLOB '*[^a-f0-9]*')),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
    requested_at TEXT NOT NULL,
    claimed_at TEXT,
    completed_at TEXT,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workflow_id,generation)
  )`,
} as const

const INDEXES = {
  idx_android_devices_state_updated: ['android_companion_devices', ['state', 'updated_at', 'id']],
  idx_android_capabilities_id_health: ['android_companion_capabilities', ['capability_id', 'health', 'device_id']],
  idx_android_commands_status_updated: ['android_companion_commands', ['status', 'updated_at', 'id']],
  idx_android_commands_workflow: ['android_companion_commands', ['workflow_id', 'created_at', 'id']],
  idx_android_receipts_status_updated: ['android_execution_receipts', ['status', 'updated_at', 'workflow_id']],
  idx_android_notifications_device_posted: ['android_notification_observations', ['device_id', 'posted_at', 'id']],
  idx_android_artifacts_workflow: ['android_screen_artifacts', ['workflow_id', 'captured_at', 'id']],
  idx_android_takeovers_status_expiry: ['android_takeovers', ['status', 'expires_at', 'id']],
} as const

const TRIGGERS = {
  android_devices_identity_immutable: `CREATE TRIGGER android_devices_identity_immutable
    BEFORE UPDATE ON android_companion_devices
    WHEN NEW.id<>OLD.id OR NEW.installation_id<>OLD.installation_id
      OR NEW.signing_public_key<>OLD.signing_public_key OR NEW.exchange_public_key<>OLD.exchange_public_key
      OR NEW.signing_fingerprint<>OLD.signing_fingerprint OR NEW.exchange_fingerprint<>OLD.exchange_fingerprint
      OR NEW.paired_at<>OLD.paired_at OR NEW.created_at<>OLD.created_at
    BEGIN SELECT RAISE(ABORT,'Android companion trust identity is immutable'); END`,
  android_devices_version_monotonic: `CREATE TRIGGER android_devices_version_monotonic
    BEFORE UPDATE ON android_companion_devices WHEN NEW.version<>OLD.version+1
    BEGIN SELECT RAISE(ABORT,'Android companion device version must increase'); END`,
  android_devices_no_unrevoke: `CREATE TRIGGER android_devices_no_unrevoke
    BEFORE UPDATE ON android_companion_devices WHEN OLD.state='revoked' AND NEW.state<>'revoked'
    BEGIN SELECT RAISE(ABORT,'Android companion revocation is permanent'); END`,
  android_devices_no_delete: `CREATE TRIGGER android_devices_no_delete
    BEFORE DELETE ON android_companion_devices
    BEGIN SELECT RAISE(ABORT,'Android companion trust records are immutable'); END`,
  android_commands_identity_immutable: `CREATE TRIGGER android_commands_identity_immutable
    BEFORE UPDATE ON android_companion_commands
    WHEN NEW.id<>OLD.id OR NEW.workflow_id<>OLD.workflow_id OR NEW.execution_token<>OLD.execution_token
      OR NEW.material_digest<>OLD.material_digest OR NEW.device_id<>OLD.device_id
      OR NEW.capability_id<>OLD.capability_id OR NEW.capability_version<>OLD.capability_version
      OR NEW.kind<>OLD.kind OR NEW.payload_json<>OLD.payload_json OR NEW.expires_at<>OLD.expires_at
      OR NEW.created_at<>OLD.created_at
    BEGIN SELECT RAISE(ABORT,'Android companion command identity is immutable'); END`,
  android_commands_version_monotonic: `CREATE TRIGGER android_commands_version_monotonic
    BEFORE UPDATE ON android_companion_commands WHEN NEW.version<>OLD.version+1
    BEGIN SELECT RAISE(ABORT,'Android companion command version must increase'); END`,
  android_commands_no_delete: `CREATE TRIGGER android_commands_no_delete
    BEFORE DELETE ON android_companion_commands
    BEGIN SELECT RAISE(ABORT,'Android companion commands are immutable records'); END`,
  android_receipts_identity_immutable: `CREATE TRIGGER android_receipts_identity_immutable
    BEFORE UPDATE ON android_execution_receipts
    WHEN NEW.workflow_id<>OLD.workflow_id OR NEW.intent_id<>OLD.intent_id
      OR NEW.material_digest<>OLD.material_digest OR NEW.device_id<>OLD.device_id
      OR NEW.capability_id<>OLD.capability_id OR NEW.capability_version<>OLD.capability_version
      OR NEW.target_json<>OLD.target_json OR NEW.created_at<>OLD.created_at
    BEGIN SELECT RAISE(ABORT,'Android execution receipt identity is immutable'); END`,
  android_receipts_version_monotonic: `CREATE TRIGGER android_receipts_version_monotonic
    BEFORE UPDATE ON android_execution_receipts WHEN NEW.version<>OLD.version+1
    BEGIN SELECT RAISE(ABORT,'Android execution receipt version must increase'); END`,
  android_receipts_no_delete: `CREATE TRIGGER android_receipts_no_delete
    BEFORE DELETE ON android_execution_receipts
    BEGIN SELECT RAISE(ABORT,'Android execution receipts are immutable records'); END`,
  android_notifications_identity_immutable: `CREATE TRIGGER android_notifications_identity_immutable
    BEFORE UPDATE ON android_notification_observations
    WHEN NEW.id<>OLD.id OR NEW.device_id<>OLD.device_id OR NEW.package_binding<>OLD.package_binding
      OR NEW.notification_key_hash<>OLD.notification_key_hash OR NEW.category<>OLD.category
      OR NEW.channel_hash IS NOT OLD.channel_hash OR NEW.title_summary<>OLD.title_summary
      OR NEW.text_summary<>OLD.text_summary OR NEW.sensitivity<>OLD.sensitivity
      OR NEW.source_sequence<OLD.source_sequence OR NEW.provenance_digest<>OLD.provenance_digest
      OR NEW.posted_at<>OLD.posted_at OR NEW.created_at<>OLD.created_at
    BEGIN SELECT RAISE(ABORT,'Android notification observation identity is immutable'); END`,
  android_notifications_version_monotonic: `CREATE TRIGGER android_notifications_version_monotonic
    BEFORE UPDATE ON android_notification_observations WHEN NEW.version<>OLD.version+1
    BEGIN SELECT RAISE(ABORT,'Android notification version must increase'); END`,
  android_notifications_no_delete: `CREATE TRIGGER android_notifications_no_delete
    BEFORE DELETE ON android_notification_observations
    BEGIN SELECT RAISE(ABORT,'Android notification observations are immutable records'); END`,
  android_artifacts_no_update: `CREATE TRIGGER android_artifacts_no_update
    BEFORE UPDATE ON android_screen_artifacts
    BEGIN SELECT RAISE(ABORT,'Android screen artifact metadata is immutable'); END`,
  android_artifacts_no_delete: `CREATE TRIGGER android_artifacts_no_delete
    BEFORE DELETE ON android_screen_artifacts
    BEGIN SELECT RAISE(ABORT,'Android screen artifact metadata is immutable'); END`,
  android_takeovers_identity_immutable: `CREATE TRIGGER android_takeovers_identity_immutable
    BEFORE UPDATE ON android_takeovers
    WHEN NEW.id<>OLD.id OR NEW.workflow_id<>OLD.workflow_id OR NEW.command_id<>OLD.command_id
      OR NEW.device_id<>OLD.device_id OR NEW.capability_id<>OLD.capability_id
      OR NEW.reason_code<>OLD.reason_code OR NEW.generation<>OLD.generation
      OR NEW.requested_at<>OLD.requested_at OR NEW.expires_at<>OLD.expires_at
    BEGIN SELECT RAISE(ABORT,'Android takeover identity is immutable'); END`,
  android_takeovers_version_monotonic: `CREATE TRIGGER android_takeovers_version_monotonic
    BEFORE UPDATE ON android_takeovers WHEN NEW.version<>OLD.version+1
    BEGIN SELECT RAISE(ABORT,'Android takeover version must increase'); END`,
  android_takeovers_no_delete: `CREATE TRIGGER android_takeovers_no_delete
    BEFORE DELETE ON android_takeovers
    BEGIN SELECT RAISE(ABORT,'Android takeovers are immutable records'); END`,
  android_pairing_digest_immutable: `CREATE TRIGGER android_pairing_digest_immutable
    BEFORE UPDATE ON android_companion_meta WHEN OLD.key LIKE 'pairing_capabilities_digest:%'
    BEGIN SELECT RAISE(ABORT,'Android pairing capability digest is immutable'); END`,
  android_pairing_digest_no_delete: `CREATE TRIGGER android_pairing_digest_no_delete
    BEFORE DELETE ON android_companion_meta WHEN OLD.key LIKE 'pairing_capabilities_digest:%'
    BEGIN SELECT RAISE(ABORT,'Android pairing capability digest is immutable'); END`,
} as const

type SyncResult<T> = T & (T extends PromiseLike<unknown> ? never : unknown)

export function getAndroidCompanionDbPath(): string {
  return join(getHermesBaseDir(), 'personal', 'android-companion.db')
}

export function withAndroidCompanionDb<T>(operation: (db: DatabaseSync) => SyncResult<T>): T {
  const path = getAndroidCompanionDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL')
    initAndroidCompanionSchema(db)
    const result = operation(db)
    if (result !== null && (typeof result === 'object' || typeof result === 'function')
      && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => undefined)
      throw new TypeError('Android companion database operation must be synchronous')
    }
    return result
  } finally {
    db.close()
  }
}

export function openAndroidCompanionDatabase(path = getAndroidCompanionDbPath()): {
  database: DatabaseSync
  close(): void
} {
  mkdirSync(dirname(path), { recursive: true })
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL')
    initAndroidCompanionSchema(database)
  } catch (error) {
    database.close()
    throw error
  }
  let closed = false
  return {
    database,
    close() {
      if (closed) return
      closed = true
      database.close()
    },
  }
}

export function initAndroidCompanionSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE IF NOT EXISTS android_companion_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    const row = db.prepare("SELECT value FROM android_companion_meta WHERE key='schema_version'").get() as
      { value: string } | undefined
    const version = parseVersion(row?.value)
    if (version > SCHEMA_VERSION) {
      throw new Error(`Android companion schema version ${version} is newer than supported version ${SCHEMA_VERSION}`)
    }
    createSchemaV1(db)
    if (version < 1) {
      db.prepare("INSERT INTO android_companion_meta(key,value) VALUES('schema_version','1') ON CONFLICT(key) DO UPDATE SET value='1'").run()
    }
    if (version < 2) migrateSchemaV2(db)
    assertSchema(db)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function migrateSchemaV2(db: DatabaseSync): void {
  db.exec('DROP TRIGGER IF EXISTS android_notifications_identity_immutable')
  db.exec(TRIGGERS.android_notifications_identity_immutable)
  db.prepare("UPDATE android_companion_meta SET value='2' WHERE key='schema_version'").run()
}

function createSchemaV1(db: DatabaseSync): void {
  for (const sql of Object.values(TABLE_SQL)) db.exec(sql.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '))
  for (const [name, [table, columns]] of Object.entries(INDEXES)) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns.join(',')})`)
  }
  for (const sql of Object.values(TRIGGERS)) db.exec(sql.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS '))
}

function parseVersion(value: string | undefined): number {
  if (value === undefined) return 0
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Android companion schema version is invalid: ${value}`)
  const version = Number(value)
  if (!Number.isSafeInteger(version)) throw new Error(`Android companion schema version is invalid: ${value}`)
  return version
}

function assertSchema(db: DatabaseSync): void {
  for (const [name, expected] of Object.entries(TABLE_SQL)) assertTable(db, name, expected)
  for (const [name, [table, columns]] of Object.entries(INDEXES)) assertIndex(db, table, name, [...columns])
  for (const [name, expected] of Object.entries(TRIGGERS)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as
      { sql: string } | undefined
    if (!row || canonicalSql(row.sql) !== canonicalSql(expected)) {
      throw new Error(`Android companion schema trigger signature mismatch: ${name}`)
    }
  }
  if ((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length) {
    throw new Error('Android companion schema foreign key integrity check failed')
  }
}

function assertTable(db: DatabaseSync, name: string, expected: string): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as
    { sql: string } | undefined
  if (!row || canonicalSql(row.sql) !== canonicalSql(expected)) {
    throw new Error(`Android companion schema table signature mismatch: ${name}`)
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
    throw new Error(`Android companion schema index signature mismatch: ${name}`)
  }
}

function canonicalSql(value: string): string {
  return value.replace(/\bIF\s+NOT\s+EXISTS\b/gi, '').replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase()
}

import { chmodSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getHermesBaseDir } from '../hermes-profile'

const SCHEMA_VERSION = 1

const TABLE_SQL = {
  life_accounts: `CREATE TABLE life_accounts (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 160),
    source_kind TEXT NOT NULL CHECK(source_kind IN ('calendar','contacts','travel','music','games','subscriptions')),
    mode TEXT NOT NULL CHECK(mode IN ('observe','shadow','live')),
    executor_id TEXT CHECK(executor_id IS NULL OR length(executor_id) BETWEEN 1 AND 160),
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160),
    health TEXT NOT NULL CHECK(health IN ('unknown','healthy','degraded','unhealthy','revoked')),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    policy_epoch INTEGER NOT NULL CHECK(policy_epoch>=1),
    version INTEGER NOT NULL CHECK(version>=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revoked_at TEXT,
    CHECK((health='revoked' AND enabled=0 AND revoked_at IS NOT NULL)
      OR (health<>'revoked' AND revoked_at IS NULL))
  )`,
  life_commitments: `CREATE TABLE life_commitments (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    account_id TEXT NOT NULL REFERENCES life_accounts(id),
    provider_item_id TEXT NOT NULL CHECK(length(provider_item_id) BETWEEN 1 AND 200),
    label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 300),
    category TEXT NOT NULL CHECK(category IN ('work','personal','health','travel','leisure','other')),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    all_day INTEGER NOT NULL CHECK(all_day IN (0,1)),
    busy INTEGER NOT NULL CHECK(busy IN (0,1)),
    location_class TEXT NOT NULL CHECK(location_class IN ('remote','home','local','out_of_area','unknown')),
    participant_alias_ids_json TEXT NOT NULL CHECK(json_valid(participant_alias_ids_json)=1
      AND json_type(participant_alias_ids_json)='array' AND length(CAST(participant_alias_ids_json AS BLOB))<=16384),
    observed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
    created_at TEXT NOT NULL,
    UNIQUE(account_id,provider_item_id,source_digest),
    CHECK(ends_at>starts_at AND expires_at>observed_at)
  )`,
  life_contact_aliases: `CREATE TABLE life_contact_aliases (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    account_id TEXT NOT NULL REFERENCES life_accounts(id),
    provider_contact_id TEXT NOT NULL CHECK(length(provider_contact_id) BETWEEN 1 AND 200),
    alias TEXT NOT NULL CHECK(length(alias) BETWEEN 1 AND 160),
    relationship_tags_json TEXT NOT NULL CHECK(json_valid(relationship_tags_json)=1
      AND json_type(relationship_tags_json)='array' AND length(CAST(relationship_tags_json AS BLOB))<=8192),
    availability_tags_json TEXT NOT NULL CHECK(json_valid(availability_tags_json)=1
      AND json_type(availability_tags_json)='array' AND length(CAST(availability_tags_json AS BLOB))<=8192),
    observed_at TEXT NOT NULL,
    source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
    created_at TEXT NOT NULL,
    UNIQUE(account_id,provider_contact_id,source_digest)
  )`,
  life_options: `CREATE TABLE life_options (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    account_id TEXT REFERENCES life_accounts(id),
    kind TEXT NOT NULL CHECK(kind IN ('travel','video','music','game')),
    source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 80),
    provider_item_id TEXT NOT NULL CHECK(length(provider_item_id) BETWEEN 1 AND 200),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 500),
    category_tags_json TEXT NOT NULL CHECK(json_valid(category_tags_json)=1
      AND json_type(category_tags_json)='array' AND length(CAST(category_tags_json AS BLOB))<=16384),
    duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 1 AND 10080),
    exertion TEXT NOT NULL CHECK(exertion IN ('low','medium','high')),
    screen_based INTEGER NOT NULL CHECK(screen_based IN (0,1)),
    location_class TEXT NOT NULL CHECK(location_class IN ('remote','home','local','out_of_area','unknown')),
    cost_currency TEXT CHECK(cost_currency IS NULL OR (length(cost_currency)=3 AND cost_currency NOT GLOB '*[^A-Z]*')),
    cost_minor INTEGER CHECK(cost_minor IS NULL OR cost_minor BETWEEN 0 AND 9007199254740991),
    available INTEGER NOT NULL CHECK(available IN (0,1)),
    observed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
    created_at TEXT NOT NULL,
    UNIQUE(source,provider_item_id,source_digest),
    CHECK((cost_currency IS NULL AND cost_minor IS NULL) OR (cost_currency IS NOT NULL AND cost_minor IS NOT NULL)),
    CHECK(expires_at>observed_at)
  )`,
  life_subscriptions: `CREATE TABLE life_subscriptions (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    account_id TEXT NOT NULL REFERENCES life_accounts(id),
    provider_subscription_id TEXT NOT NULL CHECK(length(provider_subscription_id) BETWEEN 1 AND 200),
    service_label TEXT NOT NULL CHECK(length(service_label) BETWEEN 1 AND 200),
    plan_label TEXT NOT NULL CHECK(length(plan_label) BETWEEN 1 AND 200),
    currency TEXT NOT NULL CHECK(length(currency)=3 AND currency NOT GLOB '*[^A-Z]*'),
    recurring_cost_minor INTEGER NOT NULL CHECK(recurring_cost_minor BETWEEN 0 AND 9007199254740991),
    renewal_at TEXT NOT NULL,
    cancellation_deadline TEXT,
    state TEXT NOT NULL CHECK(state IN ('active','trial','paused','cancel_pending','cancelled','expired')),
    observed_at TEXT NOT NULL,
    source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
    version INTEGER NOT NULL CHECK(version>=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id,provider_subscription_id)
  )`,
  life_constraint_snapshots: `CREATE TABLE life_constraint_snapshots (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 200),
    horizon_start TEXT NOT NULL,
    horizon_end TEXT NOT NULL,
    timezone TEXT NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100),
    free_windows_json TEXT NOT NULL CHECK(json_valid(free_windows_json)=1 AND json_type(free_windows_json)='array'
      AND length(CAST(free_windows_json AS BLOB))<=32768),
    commitment_ids_json TEXT NOT NULL CHECK(json_valid(commitment_ids_json)=1 AND json_type(commitment_ids_json)='array'
      AND length(CAST(commitment_ids_json AS BLOB))<=32768),
    readiness TEXT NOT NULL CHECK(readiness IN ('unknown','low','normal','high')),
    recovery TEXT NOT NULL CHECK(recovery IN ('unknown','poor','fair','good')),
    sleep_debt TEXT NOT NULL CHECK(sleep_debt IN ('unknown','none','moderate','high')),
    screen_time_used_minutes INTEGER NOT NULL CHECK(screen_time_used_minutes BETWEEN 0 AND 10080),
    screen_time_limit_minutes INTEGER NOT NULL CHECK(screen_time_limit_minutes BETWEEN 0 AND 10080),
    leisure_time_limit_minutes INTEGER NOT NULL CHECK(leisure_time_limit_minutes BETWEEN 0 AND 10080),
    budget_currency TEXT NOT NULL CHECK(length(budget_currency)=3 AND budget_currency NOT GLOB '*[^A-Z]*'),
    budget_minor INTEGER NOT NULL CHECK(budget_minor BETWEEN 0 AND 9007199254740991),
    quiet_start_minute INTEGER NOT NULL CHECK(quiet_start_minute BETWEEN 0 AND 1439),
    quiet_end_minute INTEGER NOT NULL CHECK(quiet_end_minute BETWEEN 0 AND 1439),
    max_travel_radius_km INTEGER NOT NULL CHECK(max_travel_radius_km BETWEEN 0 AND 40075),
    excluded_categories_json TEXT NOT NULL CHECK(json_valid(excluded_categories_json)=1
      AND json_type(excluded_categories_json)='array' AND length(CAST(excluded_categories_json AS BLOB))<=16384),
    preferred_categories_json TEXT NOT NULL CHECK(json_valid(preferred_categories_json)=1
      AND json_type(preferred_categories_json)='array' AND length(CAST(preferred_categories_json AS BLOB))<=16384),
    fact_refs_json TEXT NOT NULL CHECK(json_valid(fact_refs_json)=1 AND json_type(fact_refs_json)='array'
      AND length(CAST(fact_refs_json AS BLOB))<=32768),
    material_digest TEXT NOT NULL UNIQUE CHECK(length(material_digest)=64 AND material_digest NOT GLOB '*[^a-f0-9]*'),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    CHECK(horizon_end>horizon_start AND expires_at>created_at)
  )`,
  life_plan_revisions: `CREATE TABLE life_plan_revisions (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    constraint_snapshot_id TEXT NOT NULL REFERENCES life_constraint_snapshots(id),
    constraint_digest TEXT NOT NULL CHECK(length(constraint_digest)=64 AND constraint_digest NOT GLOB '*[^a-f0-9]*'),
    candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json)=1 AND json_type(candidates_json)='array'
      AND length(CAST(candidates_json AS BLOB))<=65536),
    sessions_json TEXT NOT NULL CHECK(json_valid(sessions_json)=1 AND json_type(sessions_json)='array'
      AND length(CAST(sessions_json AS BLOB))<=65536),
    total_minutes INTEGER NOT NULL CHECK(total_minutes BETWEEN 0 AND 10080),
    total_currency TEXT NOT NULL CHECK(length(total_currency)=3 AND total_currency NOT GLOB '*[^A-Z]*'),
    total_cost_minor INTEGER NOT NULL CHECK(total_cost_minor BETWEEN 0 AND 9007199254740991),
    plan_digest TEXT NOT NULL UNIQUE CHECK(length(plan_digest)=64 AND plan_digest NOT GLOB '*[^a-f0-9]*'),
    state TEXT NOT NULL CHECK(state IN ('proposed','reserved','superseded','completed','expired')),
    version INTEGER NOT NULL CHECK(version>=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  life_calendar_holds: `CREATE TABLE life_calendar_holds (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    workflow_id TEXT NOT NULL UNIQUE CHECK(length(workflow_id) BETWEEN 10 AND 200 AND workflow_id LIKE 'workflow-%'),
    intent_id TEXT NOT NULL CHECK(length(intent_id) BETWEEN 8 AND 200 AND intent_id LIKE 'intent-%'),
    account_id TEXT NOT NULL REFERENCES life_accounts(id),
    plan_revision_id TEXT NOT NULL REFERENCES life_plan_revisions(id),
    plan_digest TEXT NOT NULL CHECK(length(plan_digest)=64 AND plan_digest NOT GLOB '*[^a-f0-9]*'),
    option_id TEXT NOT NULL REFERENCES life_options(id),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    provider_request_id TEXT NOT NULL CHECK(length(provider_request_id) BETWEEN 8 AND 200),
    provider_hold_id TEXT CHECK(provider_hold_id IS NULL OR length(provider_hold_id) BETWEEN 1 AND 200),
    receipt_digest TEXT CHECK(receipt_digest IS NULL OR (length(receipt_digest)=64 AND receipt_digest NOT GLOB '*[^a-f0-9]*')),
    state TEXT NOT NULL CHECK(state IN ('requested','submitting','confirmed','cancel_requested','cancelling',
      'cancelled','lookup_required','waiting_user','failed')),
    policy_epoch INTEGER NOT NULL CHECK(policy_epoch>=1),
    version INTEGER NOT NULL CHECK(version>=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(account_id,provider_request_id),
    CHECK(ends_at>starts_at)
  )`,
  life_subscription_cancellations: `CREATE TABLE life_subscription_cancellations (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    workflow_id TEXT NOT NULL UNIQUE CHECK(length(workflow_id) BETWEEN 10 AND 200 AND workflow_id LIKE 'workflow-%'),
    intent_id TEXT NOT NULL CHECK(length(intent_id) BETWEEN 8 AND 200 AND intent_id LIKE 'intent-%'),
    account_id TEXT NOT NULL REFERENCES life_accounts(id),
    subscription_id TEXT NOT NULL REFERENCES life_subscriptions(id),
    subscription_digest TEXT NOT NULL CHECK(length(subscription_digest)=64 AND subscription_digest NOT GLOB '*[^a-f0-9]*'),
    provider_request_id TEXT NOT NULL CHECK(length(provider_request_id) BETWEEN 8 AND 200),
    reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 2 AND 128 AND reason_code NOT GLOB '*[^A-Z0-9_]*'),
    provider_receipt_id TEXT CHECK(provider_receipt_id IS NULL OR length(provider_receipt_id) BETWEEN 1 AND 200),
    receipt_digest TEXT CHECK(receipt_digest IS NULL OR (length(receipt_digest)=64 AND receipt_digest NOT GLOB '*[^a-f0-9]*')),
    state TEXT NOT NULL CHECK(state IN ('requested','submitting','processing','cancelled','rejected',
      'lookup_required','waiting_user','failed')),
    policy_epoch INTEGER NOT NULL CHECK(policy_epoch>=1),
    version INTEGER NOT NULL CHECK(version>=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(account_id,provider_request_id)
  )`,
  life_handoffs: `CREATE TABLE life_handoffs (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    plan_revision_id TEXT NOT NULL REFERENCES life_plan_revisions(id),
    option_id TEXT NOT NULL REFERENCES life_options(id),
    kind TEXT NOT NULL CHECK(kind IN ('commerce','internet','android')),
    target_capability_id TEXT NOT NULL CHECK(length(target_capability_id) BETWEEN 1 AND 200),
    material_digest TEXT NOT NULL CHECK(length(material_digest)=64 AND material_digest NOT GLOB '*[^a-f0-9]*'),
    state TEXT NOT NULL CHECK(state IN ('proposed','accepted','expired','cancelled')),
    version INTEGER NOT NULL CHECK(version>=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(plan_revision_id,option_id,kind)
  )`,
  life_checkpoints: `CREATE TABLE life_checkpoints (
    aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('calendar_hold','subscription_cancellation')),
    aggregate_id TEXT NOT NULL CHECK(length(aggregate_id) BETWEEN 1 AND 200),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    stage TEXT NOT NULL CHECK(length(stage) BETWEEN 2 AND 80),
    evidence_digest TEXT CHECK(evidence_digest IS NULL OR (length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^a-f0-9]*')),
    error_code TEXT CHECK(error_code IS NULL OR (length(error_code) BETWEEN 2 AND 128 AND error_code NOT GLOB '*[^A-Z0-9_]*')),
    details_json TEXT NOT NULL CHECK(json_valid(details_json)=1 AND json_type(details_json)='object'
      AND length(CAST(details_json AS BLOB))<=32768),
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(aggregate_kind,aggregate_id,ordinal)
  )`,
  life_activation_reviews: `CREATE TABLE life_activation_reviews (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    account_id TEXT NOT NULL REFERENCES life_accounts(id),
    from_mode TEXT NOT NULL CHECK(from_mode IN ('observe','shadow','live')),
    to_mode TEXT NOT NULL CHECK(to_mode IN ('observe','shadow','live')),
    actor_user_id TEXT NOT NULL CHECK(length(actor_user_id) BETWEEN 1 AND 160),
    shadow_evidence_digest TEXT CHECK(shadow_evidence_digest IS NULL OR (length(shadow_evidence_digest)=64
      AND shadow_evidence_digest NOT GLOB '*[^a-f0-9]*')),
    limits_digest TEXT NOT NULL CHECK(length(limits_digest)=64 AND limits_digest NOT GLOB '*[^a-f0-9]*'),
    approved INTEGER NOT NULL CHECK(approved IN (0,1)),
    created_at TEXT NOT NULL,
    CHECK(from_mode<>to_mode)
  )`,
} as const

const INDEXES = {
  idx_life_accounts_kind_mode: ['life_accounts', ['source_kind', 'mode', 'health', 'id']],
  idx_life_commitments_account_start: ['life_commitments', ['account_id', 'starts_at', 'ends_at', 'id']],
  idx_life_contacts_account_observed: ['life_contact_aliases', ['account_id', 'observed_at', 'id']],
  idx_life_options_kind_expiry: ['life_options', ['kind', 'available', 'expires_at', 'id']],
  idx_life_subscriptions_account_renewal: ['life_subscriptions', ['account_id', 'state', 'renewal_at', 'id']],
  idx_life_plans_state_updated: ['life_plan_revisions', ['state', 'updated_at', 'id']],
  idx_life_holds_state_updated: ['life_calendar_holds', ['state', 'updated_at', 'id']],
  idx_life_cancellations_state_updated: ['life_subscription_cancellations', ['state', 'updated_at', 'id']],
  idx_life_activation_account_created: ['life_activation_reviews', ['account_id', 'created_at', 'id']],
} as const

const IMMUTABLE_TABLES = [
  'life_commitments', 'life_contact_aliases', 'life_options', 'life_constraint_snapshots',
  'life_checkpoints', 'life_activation_reviews',
] as const

const TRIGGERS: Record<string, string> = {
  life_accounts_identity_immutable: identityTrigger('life_accounts', ['id', 'source_kind', 'created_at']),
  life_accounts_version_monotonic: versionTrigger('life_accounts'),
  life_accounts_no_unrevoke: `CREATE TRIGGER life_accounts_no_unrevoke BEFORE UPDATE ON life_accounts
    WHEN OLD.health='revoked' AND NEW.health<>'revoked'
    BEGIN SELECT RAISE(ABORT,'Life account revocation is permanent'); END`,
  life_accounts_no_delete: noDeleteTrigger('life_accounts'),
  life_subscriptions_identity_immutable: identityTrigger('life_subscriptions', [
    'id', 'account_id', 'provider_subscription_id', 'created_at',
  ]),
  life_subscriptions_version_monotonic: versionTrigger('life_subscriptions'),
  life_subscriptions_state_monotonic: stateTrigger('life_subscriptions', 'subscription', `
    NEW.state=OLD.state OR
    (OLD.state='trial' AND NEW.state IN ('active','cancel_pending','cancelled','expired')) OR
    (OLD.state='active' AND NEW.state IN ('paused','cancel_pending','cancelled','expired')) OR
    (OLD.state='paused' AND NEW.state IN ('active','cancel_pending','cancelled','expired')) OR
    (OLD.state='cancel_pending' AND NEW.state IN ('active','cancelled','expired'))`),
  life_subscriptions_no_delete: noDeleteTrigger('life_subscriptions'),
  life_plan_revisions_identity_immutable: identityTrigger('life_plan_revisions', [
    'id', 'constraint_snapshot_id', 'constraint_digest', 'candidates_json', 'sessions_json', 'total_minutes',
    'total_currency', 'total_cost_minor', 'plan_digest', 'created_at',
  ]),
  life_plan_revisions_version_monotonic: versionTrigger('life_plan_revisions'),
  life_plan_revisions_state_monotonic: stateTrigger('life_plan_revisions', 'plan', `
    (OLD.state='proposed' AND NEW.state IN ('reserved','superseded','expired')) OR
    (OLD.state='reserved' AND NEW.state IN ('completed','superseded','expired'))`),
  life_plan_revisions_no_delete: noDeleteTrigger('life_plan_revisions'),
  life_calendar_holds_identity_immutable: identityTrigger('life_calendar_holds', [
    'id', 'workflow_id', 'intent_id', 'account_id', 'plan_revision_id', 'plan_digest', 'option_id',
    'starts_at', 'ends_at', 'provider_request_id', 'policy_epoch', 'created_at',
  ]),
  life_calendar_holds_version_monotonic: versionTrigger('life_calendar_holds'),
  life_calendar_holds_state_monotonic: stateTrigger('life_calendar_holds', 'calendar hold', `
    (OLD.state='requested' AND NEW.state IN ('submitting','failed')) OR
    (OLD.state='submitting' AND NEW.state IN ('confirmed','lookup_required','waiting_user','failed')) OR
    (OLD.state='confirmed' AND NEW.state='cancel_requested') OR
    (OLD.state='cancel_requested' AND NEW.state IN ('cancelling','failed')) OR
    (OLD.state='cancelling' AND NEW.state IN ('cancelled','lookup_required','waiting_user','failed')) OR
    (OLD.state='lookup_required' AND NEW.state IN ('submitting','cancelling','confirmed','cancelled','waiting_user','failed')) OR
    (OLD.state='waiting_user' AND NEW.state IN ('submitting','cancelling','lookup_required','failed'))`),
  life_calendar_holds_no_delete: noDeleteTrigger('life_calendar_holds'),
  life_subscription_cancellations_identity_immutable: identityTrigger('life_subscription_cancellations', [
    'id', 'workflow_id', 'intent_id', 'account_id', 'subscription_id', 'subscription_digest',
    'provider_request_id', 'reason_code', 'policy_epoch', 'created_at',
  ]),
  life_subscription_cancellations_version_monotonic: versionTrigger('life_subscription_cancellations'),
  life_subscription_cancellations_state_monotonic: stateTrigger('life_subscription_cancellations',
    'subscription cancellation', `
    (OLD.state='requested' AND NEW.state IN ('submitting','failed')) OR
    (OLD.state='submitting' AND NEW.state IN ('processing','cancelled','rejected','lookup_required','waiting_user','failed')) OR
    (OLD.state='processing' AND NEW.state IN ('cancelled','rejected','lookup_required','waiting_user','failed')) OR
    (OLD.state='lookup_required' AND NEW.state IN ('submitting','processing','cancelled','rejected','waiting_user','failed')) OR
    (OLD.state='waiting_user' AND NEW.state IN ('submitting','lookup_required','failed'))`),
  life_subscription_cancellations_no_delete: noDeleteTrigger('life_subscription_cancellations'),
  life_handoffs_identity_immutable: identityTrigger('life_handoffs', [
    'id', 'plan_revision_id', 'option_id', 'kind', 'target_capability_id', 'material_digest', 'created_at',
  ]),
  life_handoffs_version_monotonic: versionTrigger('life_handoffs'),
  life_handoffs_state_monotonic: stateTrigger('life_handoffs', 'handoff', `
    OLD.state='proposed' AND NEW.state IN ('accepted','expired','cancelled')`),
  life_handoffs_no_delete: noDeleteTrigger('life_handoffs'),
}

for (const table of IMMUTABLE_TABLES) {
  TRIGGERS[`${table}_no_update`] = noUpdateTrigger(table)
  TRIGGERS[`${table}_no_delete`] = noDeleteTrigger(table)
}

type SyncResult<T> = T & (T extends PromiseLike<unknown> ? never : unknown)

export function getLifeOrchestrationDbPath(): string {
  return join(getHermesBaseDir(), 'personal', 'life-orchestration.db')
}

export function withLifeOrchestrationDb<T>(operation: (db: DatabaseSync) => SyncResult<T>): T {
  const path = getLifeOrchestrationDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const existed = existsSync(path)
  const db = new DatabaseSync(path)
  if (!existed) {
    try { chmodSync(path, 0o600) } catch { /* parent ACL remains authoritative where POSIX modes are unavailable */ }
  }
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL')
    initLifeOrchestrationSchema(db)
    const result = operation(db)
    if (result !== null && (typeof result === 'object' || typeof result === 'function')
      && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => undefined)
      throw new TypeError('Life orchestration database operation must be synchronous')
    }
    return result
  } finally { db.close() }
}

export function initLifeOrchestrationSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE IF NOT EXISTS life_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    const row = db.prepare("SELECT value FROM life_meta WHERE key='schema_version'").get() as
      { value: string } | undefined
    const version = parseVersion(row?.value)
    if (version > SCHEMA_VERSION) {
      throw new Error(`Life orchestration schema version ${version} is newer than supported version ${SCHEMA_VERSION}`)
    }
    createSchemaV1(db)
    if (version < 1) db.prepare("INSERT INTO life_meta(key,value) VALUES('schema_version','1')").run()
    assertLifeOrchestrationSchema(db)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function createSchemaV1(db: DatabaseSync): void {
  db.exec(Object.values(TABLE_SQL).map(sql => sql.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')).join(';'))
  for (const [name, [table, columns]] of Object.entries(INDEXES)) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns.join(',')})`)
  }
  db.exec(Object.values(TRIGGERS).map(sql => sql.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS ')).join(';'))
}

function assertLifeOrchestrationSchema(db: DatabaseSync): void {
  const expectedTables = ['life_meta', ...Object.keys(TABLE_SQL)]
  const actual = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'life_%'")
    .all() as Array<{ name: string }>).map(row => row.name))
  for (const name of expectedTables) if (!actual.has(name)) throw new Error(`Life orchestration schema is incomplete: ${name}`)
  for (const [name, expected] of Object.entries(TABLE_SQL)) assertTableSql(db, name, expected)
  for (const [name, [table, columns]] of Object.entries(INDEXES)) assertIndex(db, table, name, [...columns])
  for (const [name, expected] of Object.entries(TRIGGERS)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as
      { sql: string } | undefined
    if (!row || canonicalSql(row.sql) !== canonicalSql(expected)) {
      throw new Error(`Life orchestration schema trigger signature mismatch: ${name}`)
    }
  }
  if ((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length) {
    throw new Error('Life orchestration schema foreign key integrity check failed')
  }
}

function parseVersion(value: string | undefined): number {
  if (value === undefined) return 0
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Life orchestration schema version is invalid: ${value}`)
  const version = Number(value)
  if (!Number.isSafeInteger(version)) throw new Error(`Life orchestration schema version is invalid: ${value}`)
  return version
}
function assertTableSql(db: DatabaseSync, name: string, expected: string): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as
    { sql: string } | undefined
  if (!row || canonicalSql(row.sql) !== canonicalSql(expected)) {
    throw new Error(`Life orchestration schema table signature mismatch: ${name}`)
  }
}
function assertIndex(db: DatabaseSync, table: string, name: string, expectedColumns: string[]): void {
  const index = (db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{
    name: string; unique: number; partial: number
  }>).find(item => item.name === name)
  const columns = index ? (db.prepare(`PRAGMA index_info('${name}')`).all() as Array<{ seqno: number; name: string }>)
    .sort((left, right) => left.seqno - right.seqno).map(item => item.name) : []
  if (!index || index.unique !== 0 || index.partial !== 0 || columns.length !== expectedColumns.length
    || columns.some((column, position) => column !== expectedColumns[position])) {
    throw new Error(`Life orchestration schema index signature mismatch: ${name}`)
  }
}
function identityTrigger(table: string, columns: string[]): string {
  return `CREATE TRIGGER ${table}_identity_immutable BEFORE UPDATE ON ${table}
    WHEN ${columns.map(column => `NEW.${column} IS NOT OLD.${column}`).join(' OR ')}
    BEGIN SELECT RAISE(ABORT,'Life record identity is immutable'); END`
}
function versionTrigger(table: string): string {
  return `CREATE TRIGGER ${table}_version_monotonic BEFORE UPDATE ON ${table} WHEN NEW.version<>OLD.version+1
    BEGIN SELECT RAISE(ABORT,'Life record version must increase'); END`
}
function stateTrigger(table: string, label: string, expression: string): string {
  return `CREATE TRIGGER ${table}_state_monotonic BEFORE UPDATE ON ${table} WHEN NOT (${expression})
    BEGIN SELECT RAISE(ABORT,'Life ${label} state transition is invalid'); END`
}
function noUpdateTrigger(table: string): string {
  return `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Life immutable record cannot be updated'); END`
}
function noDeleteTrigger(table: string): string {
  return `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Life durable record cannot be deleted'); END`
}
function canonicalSql(value: string): string {
  return value.replace(/\bIF\s+NOT\s+EXISTS\b/gi, '').replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase()
}


import { chmodSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getHermesBaseDir } from '../hermes-profile'

const SCHEMA_VERSION = 1

const TABLE_SQL = {
  commerce_accounts: `CREATE TABLE commerce_accounts (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 160),
    provider TEXT NOT NULL CHECK(provider IN ('virtual','food_delivery','taobao')),
    mode TEXT NOT NULL CHECK(mode IN ('observe','shadow','live')),
    currency TEXT NOT NULL CHECK(length(currency)=3 AND currency NOT GLOB '*[^A-Z]*'),
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
  commerce_offer_snapshots: `CREATE TABLE commerce_offer_snapshots (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    account_id TEXT NOT NULL REFERENCES commerce_accounts(id),
    provider TEXT NOT NULL CHECK(provider IN ('virtual','food_delivery','taobao')),
    provider_offer_id TEXT NOT NULL CHECK(length(provider_offer_id) BETWEEN 1 AND 200),
    product_id TEXT NOT NULL CHECK(length(product_id) BETWEEN 1 AND 200),
    sku_id TEXT NOT NULL CHECK(length(sku_id) BETWEEN 1 AND 200),
    merchant_id TEXT NOT NULL CHECK(length(merchant_id) BETWEEN 1 AND 200),
    merchant_name TEXT NOT NULL CHECK(length(merchant_name) BETWEEN 1 AND 200),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 500),
    unit_label TEXT NOT NULL CHECK(length(unit_label) BETWEEN 1 AND 80),
    currency TEXT NOT NULL CHECK(length(currency)=3 AND currency NOT GLOB '*[^A-Z]*'),
    unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor BETWEEN 0 AND 9007199254740991),
    available INTEGER NOT NULL CHECK(available IN (0,1)),
    max_quantity INTEGER NOT NULL CHECK(max_quantity BETWEEN 0 AND 9999),
    fulfillment TEXT NOT NULL CHECK(fulfillment IN ('delivery','shipping','pickup')),
    fulfillment_minutes INTEGER CHECK(fulfillment_minutes IS NULL OR fulfillment_minutes BETWEEN 0 AND 525600),
    observed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
    created_at TEXT NOT NULL,
    UNIQUE(account_id,provider_offer_id,source_digest)
  )`,
  commerce_comparisons: `CREATE TABLE commerce_comparisons (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    account_id TEXT NOT NULL REFERENCES commerce_accounts(id),
    requirement_json TEXT NOT NULL CHECK(json_valid(requirement_json)=1 AND json_type(requirement_json)='object'
      AND length(CAST(requirement_json AS BLOB))<=32768),
    candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json)=1 AND json_type(candidates_json)='array'
      AND length(CAST(candidates_json AS BLOB))<=65536),
    selected_offer_snapshot_id TEXT REFERENCES commerce_offer_snapshots(id),
    input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^a-f0-9]*'),
    created_at TEXT NOT NULL,
    UNIQUE(account_id,input_digest)
  )`,
  commerce_cart_revisions: `CREATE TABLE commerce_cart_revisions (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    account_id TEXT NOT NULL REFERENCES commerce_accounts(id),
    revision INTEGER NOT NULL CHECK(revision>=1),
    items_json TEXT NOT NULL CHECK(json_valid(items_json)=1 AND json_type(items_json)='array'
      AND length(CAST(items_json AS BLOB))<=32768),
    destination_token TEXT NOT NULL CHECK(length(destination_token) BETWEEN 8 AND 200),
    recipient_token TEXT NOT NULL CHECK(length(recipient_token) BETWEEN 8 AND 200),
    substitution TEXT NOT NULL CHECK(substitution IN ('deny','same_sku_only')),
    content_digest TEXT NOT NULL CHECK(length(content_digest)=64 AND content_digest NOT GLOB '*[^a-f0-9]*'),
    created_at TEXT NOT NULL,
    UNIQUE(account_id,revision),
    UNIQUE(account_id,content_digest)
  )`,
  commerce_quotes: `CREATE TABLE commerce_quotes (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    account_id TEXT NOT NULL REFERENCES commerce_accounts(id),
    cart_revision_id TEXT NOT NULL REFERENCES commerce_cart_revisions(id),
    cart_digest TEXT NOT NULL CHECK(length(cart_digest)=64 AND cart_digest NOT GLOB '*[^a-f0-9]*'),
    provider_quote_id TEXT NOT NULL CHECK(length(provider_quote_id) BETWEEN 1 AND 200),
    currency TEXT NOT NULL CHECK(length(currency)=3 AND currency NOT GLOB '*[^A-Z]*'),
    items_minor INTEGER NOT NULL CHECK(items_minor BETWEEN 0 AND 9007199254740991),
    delivery_minor INTEGER NOT NULL CHECK(delivery_minor BETWEEN 0 AND 9007199254740991),
    service_minor INTEGER NOT NULL CHECK(service_minor BETWEEN 0 AND 9007199254740991),
    tax_minor INTEGER NOT NULL CHECK(tax_minor BETWEEN 0 AND 9007199254740991),
    discount_minor INTEGER NOT NULL CHECK(discount_minor BETWEEN 0 AND 9007199254740991),
    total_minor INTEGER NOT NULL CHECK(total_minor BETWEEN 0 AND 9007199254740991),
    quote_digest TEXT NOT NULL CHECK(length(quote_digest)=64 AND quote_digest NOT GLOB '*[^a-f0-9]*'),
    status TEXT NOT NULL CHECK(status IN ('active','expired','superseded','consumed')),
    version INTEGER NOT NULL CHECK(version>=1),
    observed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id,provider_quote_id,quote_digest),
    CHECK(total_minor=items_minor+delivery_minor+service_minor+tax_minor-discount_minor)
  )`,
  commerce_transactions: `CREATE TABLE commerce_transactions (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    workflow_id TEXT NOT NULL UNIQUE CHECK(length(workflow_id) BETWEEN 10 AND 200 AND workflow_id LIKE 'workflow-%'),
    intent_id TEXT NOT NULL CHECK(length(intent_id) BETWEEN 8 AND 200 AND intent_id LIKE 'intent-%'),
    account_id TEXT NOT NULL REFERENCES commerce_accounts(id),
    provider TEXT NOT NULL CHECK(provider IN ('virtual','food_delivery','taobao')),
    mode TEXT NOT NULL CHECK(mode IN ('observe','shadow','live')),
    policy_epoch INTEGER NOT NULL CHECK(policy_epoch>=1),
    quote_id TEXT NOT NULL REFERENCES commerce_quotes(id),
    quote_digest TEXT NOT NULL CHECK(length(quote_digest)=64 AND quote_digest NOT GLOB '*[^a-f0-9]*'),
    provider_request_id TEXT NOT NULL CHECK(length(provider_request_id) BETWEEN 8 AND 200),
    provider_order_id TEXT CHECK(provider_order_id IS NULL OR length(provider_order_id) BETWEEN 1 AND 200),
    currency TEXT NOT NULL CHECK(length(currency)=3 AND currency NOT GLOB '*[^A-Z]*'),
    expected_amount_minor INTEGER NOT NULL CHECK(expected_amount_minor BETWEEN 0 AND 9007199254740991),
    actual_amount_minor INTEGER CHECK(actual_amount_minor IS NULL OR actual_amount_minor BETWEEN 0 AND 9007199254740991),
    state TEXT NOT NULL CHECK(state IN ('proposed','quoted','waiting_approval','submitting_order','lookup_required',
      'order_pending','waiting_payment','submitting_payment','paid','fulfilling','delivered','cancelling',
      'cancelled','refunding','refunded','waiting_user','failed')),
    version INTEGER NOT NULL CHECK(version>=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(account_id,provider_request_id)
  )`,
  commerce_payment_attempts: `CREATE TABLE commerce_payment_attempts (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    transaction_id TEXT NOT NULL REFERENCES commerce_transactions(id),
    provider_request_id TEXT NOT NULL CHECK(length(provider_request_id) BETWEEN 8 AND 200),
    approval_id TEXT CHECK(approval_id IS NULL OR length(approval_id) BETWEEN 8 AND 200),
    method_label TEXT CHECK(method_label IS NULL OR length(method_label) BETWEEN 1 AND 80),
    method_fingerprint TEXT CHECK(method_fingerprint IS NULL OR (length(method_fingerprint)=64
      AND method_fingerprint NOT GLOB '*[^a-f0-9]*')),
    currency TEXT NOT NULL CHECK(length(currency)=3 AND currency NOT GLOB '*[^A-Z]*'),
    amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 0 AND 9007199254740991),
    state TEXT NOT NULL CHECK(state IN ('not_started','approval_required','submitting','lookup_required',
      'paid','declined','unknown','cancelled')),
    provider_receipt_id TEXT CHECK(provider_receipt_id IS NULL OR length(provider_receipt_id) BETWEEN 1 AND 200),
    evidence_digest TEXT CHECK(evidence_digest IS NULL OR (length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^a-f0-9]*')),
    version INTEGER NOT NULL CHECK(version>=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(transaction_id),
    UNIQUE(transaction_id,provider_request_id)
  )`,
  commerce_delivery_observations: `CREATE TABLE commerce_delivery_observations (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    transaction_id TEXT NOT NULL REFERENCES commerce_transactions(id),
    provider_event_id TEXT NOT NULL CHECK(length(provider_event_id) BETWEEN 1 AND 200),
    state TEXT NOT NULL CHECK(state IN ('not_started','preparing','ready','in_transit','delivered','failed','cancelled','unknown')),
    eta_at TEXT,
    evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^a-f0-9]*'),
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(transaction_id,provider_event_id)
  )`,
  commerce_cancellation_requests: `CREATE TABLE commerce_cancellation_requests (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    transaction_id TEXT NOT NULL REFERENCES commerce_transactions(id),
    provider_request_id TEXT NOT NULL CHECK(length(provider_request_id) BETWEEN 8 AND 200),
    reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 2 AND 128 AND reason_code NOT GLOB '*[^A-Z0-9_]*'),
    eligibility_digest TEXT NOT NULL CHECK(length(eligibility_digest)=64 AND eligibility_digest NOT GLOB '*[^a-f0-9]*'),
    state TEXT NOT NULL CHECK(state IN ('not_requested','requested','lookup_required','cancelled','rejected','unknown')),
    provider_receipt_id TEXT CHECK(provider_receipt_id IS NULL OR length(provider_receipt_id) BETWEEN 1 AND 200),
    version INTEGER NOT NULL CHECK(version>=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(transaction_id,provider_request_id)
  )`,
  commerce_refund_requests: `CREATE TABLE commerce_refund_requests (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    transaction_id TEXT NOT NULL REFERENCES commerce_transactions(id),
    provider_request_id TEXT NOT NULL CHECK(length(provider_request_id) BETWEEN 8 AND 200),
    reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 2 AND 128 AND reason_code NOT GLOB '*[^A-Z0-9_]*'),
    currency TEXT NOT NULL CHECK(length(currency)=3 AND currency NOT GLOB '*[^A-Z]*'),
    expected_amount_minor INTEGER NOT NULL CHECK(expected_amount_minor BETWEEN 0 AND 9007199254740991),
    actual_amount_minor INTEGER CHECK(actual_amount_minor IS NULL OR actual_amount_minor BETWEEN 0 AND 9007199254740991),
    eligibility_digest TEXT NOT NULL CHECK(length(eligibility_digest)=64 AND eligibility_digest NOT GLOB '*[^a-f0-9]*'),
    state TEXT NOT NULL CHECK(state IN ('not_requested','requested','lookup_required','processing','refunded','rejected','unknown')),
    provider_receipt_id TEXT CHECK(provider_receipt_id IS NULL OR length(provider_receipt_id) BETWEEN 1 AND 200),
    version INTEGER NOT NULL CHECK(version>=1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(transaction_id,provider_request_id)
  )`,
  commerce_checkpoints: `CREATE TABLE commerce_checkpoints (
    transaction_id TEXT NOT NULL REFERENCES commerce_transactions(id),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    stage TEXT NOT NULL CHECK(length(stage) BETWEEN 2 AND 80),
    evidence_digest TEXT CHECK(evidence_digest IS NULL OR (length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^a-f0-9]*')),
    error_code TEXT CHECK(error_code IS NULL OR (length(error_code) BETWEEN 2 AND 128 AND error_code NOT GLOB '*[^A-Z0-9_]*')),
    details_json TEXT NOT NULL CHECK(json_valid(details_json)=1 AND json_type(details_json)='object'
      AND length(CAST(details_json AS BLOB))<=32768),
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(transaction_id,ordinal)
  )`,
  commerce_activation_reviews: `CREATE TABLE commerce_activation_reviews (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    account_id TEXT NOT NULL REFERENCES commerce_accounts(id),
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
  idx_commerce_accounts_mode_health: ['commerce_accounts', ['mode', 'health', 'id']],
  idx_commerce_offers_account_expiry: ['commerce_offer_snapshots', ['account_id', 'expires_at', 'id']],
  idx_commerce_comparisons_account_created: ['commerce_comparisons', ['account_id', 'created_at', 'id']],
  idx_commerce_quotes_account_status_expiry: ['commerce_quotes', ['account_id', 'status', 'expires_at', 'id']],
  idx_commerce_transactions_state_updated: ['commerce_transactions', ['state', 'updated_at', 'id']],
  idx_commerce_payments_transaction_state: ['commerce_payment_attempts', ['transaction_id', 'state', 'id']],
  idx_commerce_delivery_transaction_observed: ['commerce_delivery_observations', ['transaction_id', 'observed_at', 'id']],
  idx_commerce_cancellations_transaction_state: ['commerce_cancellation_requests', ['transaction_id', 'state', 'id']],
  idx_commerce_refunds_transaction_state: ['commerce_refund_requests', ['transaction_id', 'state', 'id']],
  idx_commerce_activation_account_created: ['commerce_activation_reviews', ['account_id', 'created_at', 'id']],
} as const

const IMMUTABLE_TABLES = [
  'commerce_offer_snapshots', 'commerce_comparisons', 'commerce_cart_revisions',
  'commerce_delivery_observations', 'commerce_checkpoints', 'commerce_activation_reviews',
] as const

const TRIGGERS: Record<string, string> = {
  commerce_accounts_identity_immutable: `CREATE TRIGGER commerce_accounts_identity_immutable
    BEFORE UPDATE ON commerce_accounts
    WHEN NEW.id<>OLD.id OR NEW.provider<>OLD.provider OR NEW.currency<>OLD.currency OR NEW.created_at<>OLD.created_at
    BEGIN SELECT RAISE(ABORT,'Commerce account identity is immutable'); END`,
  commerce_accounts_version_monotonic: `CREATE TRIGGER commerce_accounts_version_monotonic
    BEFORE UPDATE ON commerce_accounts WHEN NEW.version<>OLD.version+1
    BEGIN SELECT RAISE(ABORT,'Commerce account version must increase'); END`,
  commerce_accounts_no_unrevoke: `CREATE TRIGGER commerce_accounts_no_unrevoke
    BEFORE UPDATE ON commerce_accounts WHEN OLD.health='revoked' AND NEW.health<>'revoked'
    BEGIN SELECT RAISE(ABORT,'Commerce account revocation is permanent'); END`,
  commerce_accounts_no_delete: noDeleteTrigger('commerce_accounts'),
  commerce_quotes_identity_immutable: identityTrigger('commerce_quotes', [
    'id', 'account_id', 'cart_revision_id', 'cart_digest', 'provider_quote_id', 'currency', 'items_minor',
    'delivery_minor', 'service_minor', 'tax_minor', 'discount_minor', 'total_minor', 'quote_digest',
    'observed_at', 'expires_at', 'created_at',
  ]),
  commerce_quotes_version_monotonic: versionTrigger('commerce_quotes'),
  commerce_quotes_state_monotonic: `CREATE TRIGGER commerce_quotes_state_monotonic
    BEFORE UPDATE ON commerce_quotes WHEN NOT (
      OLD.status='active' AND NEW.status IN ('expired','superseded','consumed'))
    BEGIN SELECT RAISE(ABORT,'Commerce quote state transition is invalid'); END`,
  commerce_quotes_no_delete: noDeleteTrigger('commerce_quotes'),
  commerce_transactions_identity_immutable: identityTrigger('commerce_transactions', [
    'id', 'workflow_id', 'intent_id', 'account_id', 'provider', 'mode', 'policy_epoch', 'quote_id',
    'quote_digest', 'provider_request_id', 'currency', 'expected_amount_minor', 'created_at',
  ]),
  commerce_transactions_version_monotonic: versionTrigger('commerce_transactions'),
  commerce_transactions_state_monotonic: `CREATE TRIGGER commerce_transactions_state_monotonic
    BEFORE UPDATE ON commerce_transactions WHEN NOT (
      (OLD.state='proposed' AND NEW.state IN ('quoted','failed')) OR
      (OLD.state='quoted' AND NEW.state IN ('waiting_approval','submitting_order','failed')) OR
      (OLD.state='waiting_approval' AND NEW.state IN ('submitting_order','waiting_user','failed')) OR
      (OLD.state='submitting_order' AND NEW.state IN ('order_pending','lookup_required','waiting_user','failed')) OR
      (OLD.state='lookup_required' AND NEW.state IN ('order_pending','waiting_payment','paid','waiting_user','failed')) OR
      (OLD.state='order_pending' AND NEW.state IN ('waiting_payment','paid','fulfilling','cancelling','cancelled','failed')) OR
      (OLD.state='waiting_payment' AND NEW.state IN ('submitting_payment','cancelling','cancelled','waiting_user','failed')) OR
      (OLD.state='submitting_payment' AND NEW.state IN ('paid','lookup_required','waiting_user','failed')) OR
      (OLD.state='paid' AND NEW.state IN ('fulfilling','cancelling','refunding','failed')) OR
      (OLD.state='fulfilling' AND NEW.state IN ('delivered','cancelling','refunding','failed')) OR
      (OLD.state='delivered' AND NEW.state='refunding') OR
      (OLD.state='cancelling' AND NEW.state IN ('cancelled','lookup_required','waiting_user','failed')) OR
      (OLD.state='cancelled' AND NEW.state='refunding') OR
      (OLD.state='refunding' AND NEW.state IN ('refunded','lookup_required','waiting_user','failed')) OR
      (OLD.state='waiting_user' AND NEW.state IN ('lookup_required','waiting_approval','submitting_order',
        'submitting_payment','cancelling','refunding','failed')))
    BEGIN SELECT RAISE(ABORT,'Commerce transaction state transition is invalid'); END`,
  commerce_transactions_no_delete: noDeleteTrigger('commerce_transactions'),
  commerce_payment_attempts_identity_immutable: identityTrigger('commerce_payment_attempts', [
    'id', 'transaction_id', 'provider_request_id', 'currency', 'amount_minor', 'created_at',
  ]),
  commerce_payment_attempts_version_monotonic: versionTrigger('commerce_payment_attempts'),
  commerce_payments_state_monotonic: `CREATE TRIGGER commerce_payments_state_monotonic
    BEFORE UPDATE ON commerce_payment_attempts WHEN NOT (
      (OLD.state='not_started' AND NEW.state IN ('approval_required','cancelled')) OR
      (OLD.state='approval_required' AND NEW.state IN ('submitting','cancelled')) OR
      (OLD.state='submitting' AND NEW.state IN ('lookup_required','paid','declined','unknown')) OR
      (OLD.state='lookup_required' AND NEW.state IN ('paid','declined','unknown','cancelled')) OR
      (OLD.state='unknown' AND NEW.state IN ('lookup_required','cancelled')))
    BEGIN SELECT RAISE(ABORT,'Commerce payment state transition is invalid'); END`,
  commerce_payment_attempts_no_delete: noDeleteTrigger('commerce_payment_attempts'),
  commerce_cancellation_requests_identity_immutable: identityTrigger('commerce_cancellation_requests', [
    'id', 'transaction_id', 'provider_request_id', 'reason_code', 'eligibility_digest', 'created_at',
  ]),
  commerce_cancellation_requests_version_monotonic: versionTrigger('commerce_cancellation_requests'),
  commerce_cancellation_requests_state_monotonic: stateTrigger('commerce_cancellation_requests', 'cancellation', `
    (OLD.state='not_requested' AND NEW.state='requested') OR
    (OLD.state='requested' AND NEW.state IN ('lookup_required','cancelled','rejected','unknown')) OR
    (OLD.state='lookup_required' AND NEW.state IN ('cancelled','rejected','unknown')) OR
    (OLD.state='unknown' AND NEW.state='lookup_required')`),
  commerce_cancellation_requests_no_delete: noDeleteTrigger('commerce_cancellation_requests'),
  commerce_refund_requests_identity_immutable: identityTrigger('commerce_refund_requests', [
    'id', 'transaction_id', 'provider_request_id', 'reason_code', 'currency', 'expected_amount_minor',
    'eligibility_digest', 'created_at',
  ]),
  commerce_refund_requests_version_monotonic: versionTrigger('commerce_refund_requests'),
  commerce_refund_requests_state_monotonic: stateTrigger('commerce_refund_requests', 'refund', `
    (OLD.state='not_requested' AND NEW.state='requested') OR
    (OLD.state='requested' AND NEW.state IN ('lookup_required','processing','refunded','rejected','unknown')) OR
    (OLD.state='lookup_required' AND NEW.state IN ('processing','refunded','rejected','unknown')) OR
    (OLD.state='processing' AND NEW.state IN ('refunded','rejected','unknown')) OR
    (OLD.state='unknown' AND NEW.state='lookup_required')`),
  commerce_refund_requests_no_delete: noDeleteTrigger('commerce_refund_requests'),
}

for (const table of IMMUTABLE_TABLES) {
  TRIGGERS[`${table}_no_update`] = noUpdateTrigger(table)
  TRIGGERS[`${table}_no_delete`] = noDeleteTrigger(table)
}

type SyncResult<T> = T & (T extends PromiseLike<unknown> ? never : unknown)

export function getCommerceAutonomyDbPath(): string {
  return join(getHermesBaseDir(), 'personal', 'commerce-autonomy.db')
}

export function withCommerceAutonomyDb<T>(operation: (db: DatabaseSync) => SyncResult<T>): T {
  const path = getCommerceAutonomyDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const existed = existsSync(path)
  const db = new DatabaseSync(path)
  if (!existed) {
    try { chmodSync(path, 0o600) } catch { /* parent ACL remains authoritative on platforms without POSIX modes */ }
  }
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL')
    initCommerceAutonomySchema(db)
    const result = operation(db)
    if (result !== null && (typeof result === 'object' || typeof result === 'function')
      && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => undefined)
      throw new TypeError('Commerce autonomy database operation must be synchronous')
    }
    return result
  } finally {
    db.close()
  }
}

export function initCommerceAutonomySchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE IF NOT EXISTS commerce_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    const row = db.prepare("SELECT value FROM commerce_meta WHERE key='schema_version'").get() as
      { value: string } | undefined
    const version = parseVersion(row?.value)
    if (version > SCHEMA_VERSION) {
      throw new Error(`Commerce autonomy schema version ${version} is newer than supported version ${SCHEMA_VERSION}`)
    }
    createSchemaV1(db)
    if (version < 1) {
      db.prepare("INSERT INTO commerce_meta(key,value) VALUES('schema_version','1')").run()
    }
    assertCommerceAutonomySchema(db)
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

function assertCommerceAutonomySchema(db: DatabaseSync): void {
  const expectedTables = ['commerce_meta', ...Object.keys(TABLE_SQL)]
  const actualTables = new Set((db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'commerce_%'",
  ).all() as Array<{ name: string }>).map(row => row.name))
  for (const name of expectedTables) {
    if (!actualTables.has(name)) throw new Error(`Commerce autonomy schema is incomplete: ${name}`)
  }
  for (const [name, expected] of Object.entries(TABLE_SQL)) assertTableSql(db, name, expected)
  for (const [name, [table, columns]] of Object.entries(INDEXES)) assertIndex(db, table, name, [...columns])
  for (const [name, expected] of Object.entries(TRIGGERS)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as
      { sql: string } | undefined
    if (!row || canonicalSql(row.sql) !== canonicalSql(expected)) {
      throw new Error(`Commerce autonomy schema trigger signature mismatch: ${name}`)
    }
  }
  if ((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length) {
    throw new Error('Commerce autonomy schema foreign key integrity check failed')
  }
}

function parseVersion(value: string | undefined): number {
  if (value === undefined) return 0
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Commerce autonomy schema version is invalid: ${value}`)
  const version = Number(value)
  if (!Number.isSafeInteger(version)) throw new Error(`Commerce autonomy schema version is invalid: ${value}`)
  return version
}

function assertTableSql(db: DatabaseSync, name: string, expected: string): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as
    { sql: string } | undefined
  if (!row || canonicalSql(row.sql) !== canonicalSql(expected)) {
    throw new Error(`Commerce autonomy schema table signature mismatch: ${name}`)
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
    throw new Error(`Commerce autonomy schema index signature mismatch: ${name}`)
  }
}

function identityTrigger(table: string, columns: string[]): string {
  return `CREATE TRIGGER ${table}_identity_immutable BEFORE UPDATE ON ${table}
    WHEN ${columns.map(column => `NEW.${column}<>OLD.${column}`).join(' OR ')}
    BEGIN SELECT RAISE(ABORT,'Commerce record identity is immutable'); END`
}

function versionTrigger(table: string): string {
  return `CREATE TRIGGER ${table}_version_monotonic BEFORE UPDATE ON ${table} WHEN NEW.version<>OLD.version+1
    BEGIN SELECT RAISE(ABORT,'Commerce record version must increase'); END`
}

function stateTrigger(table: string, label: string, expression: string): string {
  return `CREATE TRIGGER ${table}_state_monotonic BEFORE UPDATE ON ${table} WHEN NOT (${expression})
    BEGIN SELECT RAISE(ABORT,'Commerce ${label} state transition is invalid'); END`
}

function noUpdateTrigger(table: string): string {
  return `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Commerce immutable record cannot be updated'); END`
}

function noDeleteTrigger(table: string): string {
  return `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Commerce durable record cannot be deleted'); END`
}

function canonicalSql(value: string): string {
  return value.replace(/\bIF\s+NOT\s+EXISTS\b/gi, '').replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase()
}

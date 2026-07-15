import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getLifeOrchestrationDbPath,
  initLifeOrchestrationSchema,
  withLifeOrchestrationDb,
} from '../../packages/server/src/services/hermes/life-orchestration'

describe('life orchestration database', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-life-db-'))
    process.env.HERMES_HOME = home
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('creates the dedicated versioned schema with foreign keys and WAL', () => {
    expect(getLifeOrchestrationDbPath()).toBe(join(home, 'personal', 'life-orchestration.db'))
    const snapshot = withLifeOrchestrationDb(db => ({
      version: db.prepare("SELECT value FROM life_meta WHERE key='schema_version'").get(),
      journal: db.prepare('PRAGMA journal_mode').get(),
      foreignKeys: db.prepare('PRAGMA foreign_keys').get(),
      tables: (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'life_%' ORDER BY name")
        .all() as Array<{ name: string }>).map(row => row.name),
    }))
    expect(snapshot.version).toEqual({ value: '1' })
    expect(snapshot.journal).toEqual({ journal_mode: 'wal' })
    expect(snapshot.foreignKeys).toEqual({ foreign_keys: 1 })
    expect(snapshot.tables).toEqual([
      'life_accounts', 'life_activation_reviews', 'life_calendar_holds', 'life_checkpoints',
      'life_commitments', 'life_constraint_snapshots', 'life_contact_aliases', 'life_handoffs', 'life_meta',
      'life_options', 'life_plan_revisions', 'life_subscription_cancellations', 'life_subscriptions',
    ])
  })

  it('enforces source, JSON, money, time, uniqueness, and foreign-key constraints', () => {
    withLifeOrchestrationDb(db => {
      insertAccount(db, 'calendar-account', 'calendar')
      expect(() => insertAccount(db, 'bad-account', 'browser')).toThrow(/constraint/i)
      expect(() => insertCommitment(db, { accountId: 'missing' })).toThrow(/foreign key/i)
      expect(() => insertCommitment(db, { id: 'bad-json', participants: '{bad' })).toThrow(/constraint/i)
      insertCommitment(db)
      expect(() => insertOption(db, { id: 'bad-cost', costMinor: -1 })).toThrow(/constraint/i)
      expect(() => insertOption(db, { id: 'bad-time', expiresAt: NOW })).toThrow(/constraint/i)
      insertOption(db)
      insertConstraint(db)
      insertPlan(db)
      expect(() => insertPlan(db, { id: 'plan-duplicate', digest: 'd'.repeat(64) })).toThrow(/unique/i)
    })
  })

  it('makes observations immutable and authority, subscription, and plan transitions monotonic', () => {
    withLifeOrchestrationDb(db => {
      seedPlan(db)
      expect(() => db.prepare("UPDATE life_commitments SET label='Changed' WHERE id='commitment-1'").run())
        .toThrow(/immutable/i)
      expect(() => db.prepare("UPDATE life_options SET title='Changed' WHERE id='option-1'").run())
        .toThrow(/immutable/i)

      db.prepare("UPDATE life_accounts SET health='revoked',enabled=0,revoked_at=?,version=2,updated_at=? WHERE id='calendar-account'")
        .run(LATER, LATER)
      expect(() => db.prepare("UPDATE life_accounts SET health='healthy',enabled=1,revoked_at=NULL,version=3 WHERE id='calendar-account'").run())
        .toThrow(/revocation|constraint/i)

      db.prepare("UPDATE life_plan_revisions SET state='reserved',version=2,updated_at=? WHERE id='plan-1'").run(LATER)
      expect(() => db.prepare("UPDATE life_plan_revisions SET state='proposed',version=3,updated_at=? WHERE id='plan-1'").run(LATER))
        .toThrow(/transition/i)
      expect(() => db.prepare("UPDATE life_plan_revisions SET state='completed',version=4,updated_at=? WHERE id='plan-1'").run(LATER))
        .toThrow(/version/i)
      db.prepare("UPDATE life_plan_revisions SET state='completed',version=3,updated_at=? WHERE id='plan-1'").run(LATER)
    })
  })

  it('enforces calendar hold and subscription cancellation identity, version, and transitions', () => {
    withLifeOrchestrationDb(db => {
      seedPlan(db)
      insertHold(db)
      db.prepare("UPDATE life_calendar_holds SET state='submitting',version=2,updated_at=? WHERE id='hold-1'").run(LATER)
      expect(() => db.prepare("UPDATE life_calendar_holds SET provider_request_id='changed-request',state='confirmed',version=3,updated_at=? WHERE id='hold-1'").run(LATER))
        .toThrow(/identity/i)
      db.prepare("UPDATE life_calendar_holds SET provider_hold_id='provider-hold-1',receipt_digest=?,state='confirmed',version=3,updated_at=? WHERE id='hold-1'")
        .run('f'.repeat(64), LATER)

      insertAccount(db, 'subscription-account', 'subscriptions')
      insertSubscription(db)
      insertCancellation(db)
      db.prepare("UPDATE life_subscription_cancellations SET state='submitting',version=2,updated_at=? WHERE id='cancellation-1'")
        .run(LATER)
      expect(() => db.prepare("UPDATE life_subscription_cancellations SET state='requested',version=3,updated_at=? WHERE id='cancellation-1'").run(LATER))
        .toThrow(/transition/i)
      db.prepare("UPDATE life_subscription_cancellations SET state='cancelled',provider_receipt_id='receipt-1',receipt_digest=?,version=3,updated_at=?,completed_at=? WHERE id='cancellation-1'")
        .run('e'.repeat(64), LATER, LATER)
    })
  })

  it('fails closed on a future version and schema trigger tampering', () => {
    withLifeOrchestrationDb(db => db.prepare("UPDATE life_meta SET value='2' WHERE key='schema_version'").run())
    expect(() => withLifeOrchestrationDb(() => undefined)).toThrow(/newer than supported/i)

    rmSync(getLifeOrchestrationDbPath(), { force: true })
    withLifeOrchestrationDb(() => undefined)
    const db = new DatabaseSync(getLifeOrchestrationDbPath())
    try {
      db.exec(`DROP TRIGGER life_accounts_no_delete;
        CREATE TRIGGER life_accounts_no_delete BEFORE DELETE ON life_accounts BEGIN SELECT 1; END`)
    } finally { db.close() }
    expect(() => withLifeOrchestrationDb(() => undefined)).toThrow(/trigger signature mismatch/i)
  })

  it('rejects asynchronous callbacks and rolls back incomplete initialization', () => {
    expect(() => withLifeOrchestrationDb((() => Promise.resolve('nope')) as never)).toThrow(/must be synchronous/i)
    const db = new DatabaseSync(':memory:')
    try {
      db.exec("CREATE TABLE life_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO life_meta VALUES('schema_version','invalid')")
      expect(() => initLifeOrchestrationSchema(db)).toThrow(/version is invalid/i)
      expect(db.prepare("SELECT value FROM life_meta WHERE key='schema_version'").get()).toEqual({ value: 'invalid' })
    } finally { db.close() }
  })
})

const NOW = '2026-07-15T10:00:00.000Z'
const LATER = '2026-07-15T11:00:00.000Z'
const END = '2026-07-15T12:00:00.000Z'
const EXPIRES = '2026-07-16T10:00:00.000Z'

function seedPlan(db: DatabaseSync): void {
  insertAccount(db, 'calendar-account', 'calendar')
  insertCommitment(db)
  insertOption(db)
  insertConstraint(db)
  insertPlan(db)
}

function insertAccount(db: DatabaseSync, id: string, sourceKind: string): void {
  db.prepare(`INSERT INTO life_accounts(id,source_kind,mode,executor_id,display_name,health,enabled,policy_epoch,
    version,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, sourceKind, 'shadow', 'life-shadow', id, 'healthy', 1, 1, 1, NOW, NOW, null,
  )
}

function insertCommitment(db: DatabaseSync, override: Partial<{
  id: string; accountId: string; participants: string
}> = {}): void {
  db.prepare(`INSERT INTO life_commitments(id,account_id,provider_item_id,label,category,starts_at,ends_at,
    all_day,busy,location_class,participant_alias_ids_json,observed_at,expires_at,source_digest,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    override.id ?? 'commitment-1', override.accountId ?? 'calendar-account', 'provider-event-1', 'Work block',
    'work', NOW, LATER, 0, 1, 'remote', override.participants ?? '[]', NOW, EXPIRES, 'a'.repeat(64), NOW,
  )
}

function insertOption(db: DatabaseSync, override: Partial<{
  id: string; costMinor: number; expiresAt: string
}> = {}): void {
  db.prepare(`INSERT INTO life_options(id,account_id,kind,source,provider_item_id,title,category_tags_json,
    duration_minutes,exertion,screen_based,location_class,cost_currency,cost_minor,available,observed_at,
    expires_at,source_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    override.id ?? 'option-1', 'calendar-account', 'game', 'virtual-games', 'provider-option-1', 'Puzzle game',
    '["puzzle"]', 60, 'low', 1, 'home', 'CNY', override.costMinor ?? 100,
    1, NOW, override.expiresAt ?? EXPIRES, 'b'.repeat(64), NOW,
  )
}

function insertConstraint(db: DatabaseSync): void {
  db.prepare(`INSERT INTO life_constraint_snapshots(id,subject_id,horizon_start,horizon_end,timezone,
    free_windows_json,commitment_ids_json,readiness,recovery,sleep_debt,screen_time_used_minutes,
    screen_time_limit_minutes,leisure_time_limit_minutes,budget_currency,budget_minor,quiet_start_minute,
    quiet_end_minute,max_travel_radius_km,excluded_categories_json,preferred_categories_json,fact_refs_json,
    material_digest,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'constraint-1', 'person:self', LATER, END, 'Asia/Shanghai',
    `[{"startsAt":"${LATER}","endsAt":"${END}"}]`, '["commitment-1"]', 'normal', 'good', 'none',
    30, 120, 60, 'CNY', 1000, 1380, 420, 20, '[]', '["puzzle"]', '[]', 'c'.repeat(64), NOW, EXPIRES,
  )
}

function insertPlan(db: DatabaseSync, override: Partial<{ id: string; digest: string }> = {}): void {
  db.prepare(`INSERT INTO life_plan_revisions(id,constraint_snapshot_id,constraint_digest,candidates_json,
    sessions_json,total_minutes,total_currency,total_cost_minor,plan_digest,state,version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    override.id ?? 'plan-1', 'constraint-1', 'c'.repeat(64),
    '[{"optionId":"option-1","eligible":true,"score":100,"exclusionCodes":[],"rationaleCodes":["PREFERENCE_MATCH"]}]',
    `[{"optionId":"option-1","startsAt":"${LATER}","endsAt":"${END}","cost":{"currency":"CNY","amountMinor":100},"rationaleCodes":["PREFERENCE_MATCH"]}]`,
    60, 'CNY', 100, override.digest ?? 'd'.repeat(64), 'proposed', 1, NOW, NOW,
  )
}

function insertHold(db: DatabaseSync): void {
  db.prepare(`INSERT INTO life_calendar_holds(id,workflow_id,intent_id,account_id,plan_revision_id,plan_digest,
    option_id,starts_at,ends_at,provider_request_id,provider_hold_id,receipt_digest,state,policy_epoch,version,
    created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'hold-1', 'workflow-hold-1', 'intent-hold-1', 'calendar-account', 'plan-1', 'd'.repeat(64), 'option-1',
    LATER, END, 'hold-request-1', null, null, 'requested', 1, 1, NOW, NOW, null,
  )
}

function insertSubscription(db: DatabaseSync): void {
  db.prepare(`INSERT INTO life_subscriptions(id,account_id,provider_subscription_id,service_label,plan_label,
    currency,recurring_cost_minor,renewal_at,cancellation_deadline,state,observed_at,source_digest,version,
    created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'subscription-1', 'subscription-account', 'provider-subscription-1', 'Music', 'Plus', 'CNY', 1_500,
    EXPIRES, LATER, 'active', NOW, 'f'.repeat(64), 1, NOW, NOW,
  )
}

function insertCancellation(db: DatabaseSync): void {
  db.prepare(`INSERT INTO life_subscription_cancellations(id,workflow_id,intent_id,account_id,subscription_id,
    subscription_digest,provider_request_id,reason_code,provider_receipt_id,receipt_digest,state,policy_epoch,
    version,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'cancellation-1', 'workflow-cancel-1', 'intent-cancel-1', 'subscription-account', 'subscription-1',
    'f'.repeat(64), 'cancel-request-1', 'USER_REQUEST', null, null, 'requested', 1, 1, NOW, NOW, null,
  )
}

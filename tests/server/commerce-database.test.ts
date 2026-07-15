import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getCommerceAutonomyDbPath,
  initCommerceAutonomySchema,
  withCommerceAutonomyDb,
} from '../../packages/server/src/services/hermes/commerce-autonomy'

describe('commerce autonomy database', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hermes-commerce-db-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
  })

  it('creates the dedicated versioned schema with foreign keys and WAL', () => {
    expect(getCommerceAutonomyDbPath()).toBe(join(hermesHome, 'personal', 'commerce-autonomy.db'))
    const snapshot = withCommerceAutonomyDb(db => ({
      version: db.prepare("SELECT value FROM commerce_meta WHERE key='schema_version'").get(),
      journal: db.prepare('PRAGMA journal_mode').get(),
      foreignKeys: db.prepare('PRAGMA foreign_keys').get(),
      tables: (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'commerce_%' ORDER BY name")
        .all() as Array<{ name: string }>).map(row => row.name),
    }))

    expect(snapshot.version).toEqual({ value: '1' })
    expect(snapshot.journal).toEqual({ journal_mode: 'wal' })
    expect(snapshot.foreignKeys).toEqual({ foreign_keys: 1 })
    expect(snapshot.tables).toEqual([
      'commerce_accounts',
      'commerce_activation_reviews',
      'commerce_cancellation_requests',
      'commerce_cart_revisions',
      'commerce_checkpoints',
      'commerce_comparisons',
      'commerce_delivery_observations',
      'commerce_meta',
      'commerce_offer_snapshots',
      'commerce_payment_attempts',
      'commerce_quotes',
      'commerce_refund_requests',
      'commerce_transactions',
    ])
  })

  it('enforces account, offer, quote, money, and foreign-key constraints', () => {
    withCommerceAutonomyDb(db => {
      insertAccount(db)
      expect(() => insertAccount(db, { id: 'bad-provider', provider: 'browser' })).toThrow(/constraint/i)
      expect(() => insertAccount(db, { id: 'bad-currency', currency: 'cny' })).toThrow(/constraint/i)
      expect(() => insertOffer(db, { id: 'offer-bad-money', unitPriceMinor: -1 })).toThrow(/constraint/i)
      expect(() => insertOffer(db, { id: 'offer-orphan', accountId: 'missing' })).toThrow(/foreign key/i)

      insertOffer(db)
      insertCart(db)
      expect(() => insertQuote(db, { totalMinor: 1_101 })).toThrow(/constraint/i)
      insertQuote(db)
      insertTransaction(db)
      expect(() => insertTransaction(db, { id: 'tx-duplicate-request', workflowId: 'workflow-other-1' }))
        .toThrow(/unique/i)
    })
  })

  it('makes observations immutable and authority, quote, and transaction transitions monotonic', () => {
    withCommerceAutonomyDb(db => {
      seedTransaction(db)
      expect(() => db.prepare("UPDATE commerce_offer_snapshots SET title='Changed' WHERE id='offer-1'").run())
        .toThrow(/immutable/i)

      db.prepare("UPDATE commerce_accounts SET health='revoked',enabled=0,revoked_at=?,version=2,updated_at=? WHERE id='account-1'")
        .run(now(), now())
      expect(() => db.prepare("UPDATE commerce_accounts SET health='healthy',enabled=1,revoked_at=NULL,version=3 WHERE id='account-1'").run())
        .toThrow(/revocation|constraint/i)

      db.prepare("UPDATE commerce_quotes SET status='consumed',version=2,updated_at=? WHERE id='quote-1'").run(now())
      expect(() => db.prepare("UPDATE commerce_quotes SET status='expired',version=3,updated_at=? WHERE id='quote-1'").run(now()))
        .toThrow(/transition/i)

      db.prepare("UPDATE commerce_transactions SET state='quoted',version=2,updated_at=? WHERE id='transaction-1'").run(now())
      expect(() => db.prepare("UPDATE commerce_transactions SET state='paid',version=3,updated_at=? WHERE id='transaction-1'").run(now()))
        .toThrow(/transition/i)
      expect(() => db.prepare("UPDATE commerce_transactions SET state='waiting_approval',version=4,updated_at=? WHERE id='transaction-1'").run(now()))
        .toThrow(/version/i)
      db.prepare("UPDATE commerce_transactions SET state='waiting_approval',version=3,updated_at=? WHERE id='transaction-1'").run(now())
    })
  })

  it('enforces payment lookup transitions and immutable request identity', () => {
    withCommerceAutonomyDb(db => {
      seedTransaction(db)
      db.prepare(`INSERT INTO commerce_payment_attempts(id,transaction_id,provider_request_id,approval_id,
        method_label,method_fingerprint,currency,amount_minor,state,provider_receipt_id,evidence_digest,
        version,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        'payment-1', 'transaction-1', 'pay-request-1', null, 'Wallet', 'd'.repeat(64), 'CNY', 1_100,
        'not_started', null, null, 1, now(), now(), null,
      )
      db.prepare("UPDATE commerce_payment_attempts SET state='approval_required',approval_id='approval-1',version=2,updated_at=? WHERE id='payment-1'")
        .run(now())
      expect(() => db.prepare("UPDATE commerce_payment_attempts SET state='paid',version=3,updated_at=? WHERE id='payment-1'").run(now()))
        .toThrow(/transition/i)
      expect(() => db.prepare("UPDATE commerce_payment_attempts SET provider_request_id='pay-request-2',state='submitting',version=3,updated_at=? WHERE id='payment-1'").run(now()))
        .toThrow(/identity/i)
      db.prepare("UPDATE commerce_payment_attempts SET state='submitting',version=3,updated_at=? WHERE id='payment-1'").run(now())
      db.prepare("UPDATE commerce_payment_attempts SET state='lookup_required',version=4,updated_at=? WHERE id='payment-1'").run(now())
    })
  })

  it('fails closed on a future version and on schema trigger tampering', () => {
    withCommerceAutonomyDb(db => db.prepare("UPDATE commerce_meta SET value='2' WHERE key='schema_version'").run())
    expect(() => withCommerceAutonomyDb(() => undefined)).toThrow(/newer than supported/i)

    rmSync(getCommerceAutonomyDbPath(), { force: true })
    withCommerceAutonomyDb(() => undefined)
    const db = new DatabaseSync(getCommerceAutonomyDbPath())
    try {
      db.exec(`DROP TRIGGER commerce_accounts_no_delete;
        CREATE TRIGGER commerce_accounts_no_delete BEFORE DELETE ON commerce_accounts BEGIN SELECT 1; END`)
    } finally { db.close() }
    expect(() => withCommerceAutonomyDb(() => undefined)).toThrow(/trigger signature mismatch/i)
  })

  it('rejects asynchronous callbacks and rolls back incomplete schema initialization', () => {
    expect(() => withCommerceAutonomyDb((() => Promise.resolve('nope')) as never)).toThrow(/must be synchronous/i)

    const db = new DatabaseSync(':memory:')
    try {
      db.exec("CREATE TABLE commerce_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO commerce_meta VALUES('schema_version','invalid')")
      expect(() => initCommerceAutonomySchema(db)).toThrow(/version is invalid/i)
      expect(db.prepare("SELECT value FROM commerce_meta WHERE key='schema_version'").get()).toEqual({ value: 'invalid' })
    } finally { db.close() }
  })
})

function seedTransaction(db: DatabaseSync): void {
  insertAccount(db)
  insertOffer(db)
  insertCart(db)
  insertQuote(db)
  insertTransaction(db)
}

function insertAccount(db: DatabaseSync, override: Partial<{
  id: string; provider: string; currency: string
}> = {}): void {
  db.prepare(`INSERT INTO commerce_accounts(id,provider,mode,currency,executor_id,display_name,health,
    enabled,policy_epoch,version,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    override.id ?? 'account-1', override.provider ?? 'virtual', 'shadow', override.currency ?? 'CNY', null,
    'Virtual commerce', 'healthy', 1, 1, 1, now(), now(), null,
  )
}

function insertOffer(db: DatabaseSync, override: Partial<{
  id: string; accountId: string; unitPriceMinor: number
}> = {}): void {
  db.prepare(`INSERT INTO commerce_offer_snapshots(id,account_id,provider,provider_offer_id,product_id,
    sku_id,merchant_id,merchant_name,title,unit_label,currency,unit_price_minor,available,max_quantity,
    fulfillment,fulfillment_minutes,observed_at,expires_at,source_digest,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    override.id ?? 'offer-1', override.accountId ?? 'account-1', 'virtual', 'provider-offer-1', 'product-1',
    'sku-1', 'merchant-1', 'Merchant', 'Meal', 'serving', 'CNY', override.unitPriceMinor ?? 1_000,
    1, 10, 'delivery', 30, now(), later(), 'a'.repeat(64), now(),
  )
}

function insertCart(db: DatabaseSync): void {
  db.prepare(`INSERT INTO commerce_cart_revisions(id,account_id,revision,items_json,destination_token,
    recipient_token,substitution,content_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    'cart-1', 'account-1', 1, '[{"offerSnapshotId":"offer-1","quantity":1}]',
    'destination-1', 'recipient-1', 'deny', 'b'.repeat(64), now(),
  )
}

function insertQuote(db: DatabaseSync, override: Partial<{ totalMinor: number }> = {}): void {
  db.prepare(`INSERT INTO commerce_quotes(id,account_id,cart_revision_id,cart_digest,provider_quote_id,
    currency,items_minor,delivery_minor,service_minor,tax_minor,discount_minor,total_minor,quote_digest,
    status,version,observed_at,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'quote-1', 'account-1', 'cart-1', 'b'.repeat(64), 'provider-quote-1', 'CNY', 1_000, 100, 0, 0, 0,
    override.totalMinor ?? 1_100, 'c'.repeat(64), 'active', 1, now(), later(), now(), now(),
  )
}

function insertTransaction(db: DatabaseSync, override: Partial<{ id: string; workflowId: string }> = {}): void {
  db.prepare(`INSERT INTO commerce_transactions(id,workflow_id,intent_id,account_id,provider,mode,
    policy_epoch,quote_id,quote_digest,provider_request_id,provider_order_id,currency,expected_amount_minor,
    actual_amount_minor,state,version,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    override.id ?? 'transaction-1', override.workflowId ?? 'workflow-12345', 'intent-12345', 'account-1',
    'virtual', 'shadow', 1, 'quote-1', 'c'.repeat(64), 'request-order-1', null, 'CNY', 1_100, null,
    'proposed', 1, now(), now(), null,
  )
}

function now(): string { return '2026-07-15T10:00:00.000Z' }
function later(): string { return '2026-07-15T10:15:00.000Z' }

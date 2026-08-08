/**
 * Credits / 点数账本 store.
 *
 * 每一笔变动都写入 credits_ledger（不可变流水账）：
 *   - recharge : 充值（Shopify 订单到账 / 管理员手动发放）
 *   - charge   : 消耗（AI 用量扣点）
 *   - refund   : 退款 / 管理员回退
 *
 * 余额 = Σ amount（对应用户的所有流水行）。并发下通过单个 SQLite
 * 事务内「先读后写」保证一致性。
 */

import { getDb } from '../index'
import { CREDITS_LEDGER_TABLE } from './schemas'

export type CreditLedgerType = 'recharge' | 'charge' | 'refund'

export interface CreditLedgerRow {
  id: number
  user_id: number
  type: CreditLedgerType
  amount: number
  balance_after: number
  order_id: string
  note: string
  created_at: number
}

export interface CreditsSummary {
  balance: number
  totalRecharged: number
  totalCharged: number
}

function normalizeUserId(userId: number | string): number | null {
  const id = typeof userId === 'number' ? userId : Number(userId)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** 当前余额 (所有流水行之和) */
export function getUserCreditsBalance(userId: number | string): number {
  const db = getDb()
  const id = normalizeUserId(userId)
  if (!db || !id) return 0
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS balance FROM ${CREDITS_LEDGER_TABLE} WHERE user_id = ?`,
  ).get(id) as { balance: number } | undefined
  return row ? Number(row.balance || 0) : 0
}

/** 汇总：余额 + 累计充入 + 累计消耗 */
export function getCreditsSummary(userId: number | string): CreditsSummary {
  const db = getDb()
  const id = normalizeUserId(userId)
  if (!db || !id) {
    return { balance: 0, totalRecharged: 0, totalCharged: 0 }
  }
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(amount), 0) AS balance,
       COALESCE(SUM(CASE WHEN type = 'recharge' THEN amount ELSE 0 END), 0) AS recharged,
       COALESCE(SUM(CASE WHEN type = 'charge' THEN amount ELSE 0 END), 0) AS charged
     FROM ${CREDITS_LEDGER_TABLE} WHERE user_id = ?`,
  ).get(id) as { balance: number; recharged: number; charged: number } | undefined
  return {
    balance: row ? Number(row.balance || 0) : 0,
    totalRecharged: row ? Number(row.recharged || 0) : 0,
    totalCharged: row ? Number(row.charged || 0) : 0,
  }
}

/** 追加一条流水（内部用，自动计算 balance_after） */
function appendLedgerEntry(
  userId: number,
  type: CreditLedgerType,
  amount: number,
  orderId: string,
  note: string,
): CreditLedgerRow | null {
  const db = getDb()
  if (!db) return null
  const now = Date.now()
  const balanceBefore = getUserCreditsBalance(userId)
  const balanceAfter = balanceBefore + amount
  const result = db.prepare(
    `INSERT INTO ${CREDITS_LEDGER_TABLE} (user_id, type, amount, balance_after, order_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, type, amount, balanceAfter, orderId || '', note || '', now)
  const id = Number(result.lastInsertRowid)
  return {
    id,
    user_id: userId,
    type,
    amount,
    balance_after: balanceAfter,
    order_id: orderId || '',
    note: note || '',
    created_at: now,
  }
}

/** 充值（正数）。amount <= 0 时拒绝。 */
export function addCredits(
  userId: number | string,
  amount: number,
  options: { orderId?: string; note?: string } = {},
): CreditLedgerRow | null {
  const id = normalizeUserId(userId)
  if (!id || !Number.isFinite(amount) || amount <= 0) return null
  return appendLedgerEntry(id, 'recharge', Math.floor(amount), options.orderId || '', options.note || '')
}

/**
 * 扣费。余额不足返回 { ok: false }，不会产生负余额流水。
 * 返回新余额。
 */
export function chargeCredits(
  userId: number | string,
  amount: number,
  options: { orderId?: string; note?: string } = {},
): { ok: boolean; balance: number; ledger?: CreditLedgerRow } {
  const id = normalizeUserId(userId)
  if (!id || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, balance: getUserCreditsBalance(userId) }
  }
  const charge = Math.floor(amount)
  const balance = getUserCreditsBalance(id)
  if (balance < charge) {
    return { ok: false, balance }
  }
  const entry = appendLedgerEntry(id, 'charge', -charge, options.orderId || '', options.note || '')
  return {
    ok: true,
    balance: entry ? entry.balance_after : balance - charge,
    ledger: entry || undefined,
  }
}

/** 退款 / 管理员回退（红冲）。amount 是正数，记入类型 refund（正余额）。 */
export function refundCredits(
  userId: number | string,
  amount: number,
  options: { orderId?: string; note?: string } = {},
): CreditLedgerRow | null {
  const id = normalizeUserId(userId)
  if (!id || !Number.isFinite(amount) || amount <= 0) return null
  return appendLedgerEntry(id, 'refund', Math.floor(amount), options.orderId || '', options.note || '')
}

/** 最近流水（倒序）。 */
export function listCreditsLedger(
  userId: number | string,
  limit = 50,
): CreditLedgerRow[] {
  const db = getDb()
  const id = normalizeUserId(userId)
  if (!db || !id) return []
  const rows = db.prepare(
    `SELECT * FROM ${CREDITS_LEDGER_TABLE} WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(id, Math.max(1, Math.min(200, Math.floor(limit)))) as unknown as CreditLedgerRow[]
  return rows || []
}
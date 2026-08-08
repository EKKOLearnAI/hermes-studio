/**
 * Credits / 点数 API controllers.
 *
 * 端点：
 *   GET  /api/hermes/credits/me          当前用户余额+汇总
 *   GET  /api/hermes/credits/me/ledger   当前用户流水
 *   POST /api/hermes/credits/recharge    [super_admin] 手动充值（模拟 Shopify 到账）
 *   POST /api/hermes/credits/refund      [super_admin] 手动退款/回退
 *   GET  /api/hermes/credits/users/:id   [super_admin] 指定用户余额
 */

import type { Context } from 'koa'
import {
  addCredits,
  getCreditsSummary,
  listCreditsLedger,
  refundCredits,
} from '../../db/hermes/credits-store'
import { findUserByUsername, findUserById } from '../../db/hermes/users-store'
import { logger } from '../../services/logger'

/** 解析 body 数值，非法返回 null */
function parsePositiveAmount(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/** GET /api/hermes/credits/me — 当前登录用户余额与汇总 */
export async function me(ctx: Context) {
  const user = ctx.state.user as { id: number; username: string } | undefined
  if (!user) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  const summary = getCreditsSummary(user.id)
  ctx.body = { username: user.username, ...summary }
}

/** GET /api/hermes/credits/me/ledger — 当前用户流水 */
export async function myLedger(ctx: Context) {
  const user = ctx.state.user as { id: number; username: string } | undefined
  if (!user) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  const limit = Number(ctx.query.limit) || 50
  ctx.body = { ledger: listCreditsLedger(user.id, limit) }
}

/** GET /api/hermes/credits/users/:id — 任意用户汇总（super_admin） */
export async function userSummary(ctx: Context) {
  const id = Number(ctx.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    ctx.status = 400
    ctx.body = { error: 'invalid user id' }
    return
  }
  const user = findUserById(id)
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'user not found' }
    return
  }
  ctx.body = { username: user.username, ...getCreditsSummary(user.id) }
}

/** POST /api/hermes/credits/recharge — 手动充值（模拟 Shopify 订单到账） */
export async function recharge(ctx: Context) {
  const { username, amount, orderId, note } = (ctx.request.body || {}) as Record<string, unknown>
  const positive = parsePositiveAmount(amount)
  if (typeof username !== 'string' || !username.trim() || !positive) {
    ctx.status = 400
    ctx.body = { error: 'username and positive amount are required' }
    return
  }
  const user = findUserByUsername(username.trim())
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'user not found' }
    return
  }
  const entry = addCredits(user.id, positive, {
    orderId: typeof orderId === 'string' ? orderId : '',
    note: typeof note === 'string' ? note : '',
  })
  if (!entry) {
    ctx.status = 500
    ctx.body = { error: 'failed to add credits' }
    return
  }
  logger.info('[credits] recharge user=%s amount=%s orderId=%s', user.username, positive, entry.order_id)
  ctx.body = { ok: true, entry }
}

/** POST /api/hermes/credits/refund — 手动退款回退 */
export async function refund(ctx: Context) {
  const { username, amount, note } = (ctx.request.body || {}) as {
    username?: unknown
    amount?: unknown
    note?: unknown
  }
  const positive = parsePositiveAmount(amount)
  if (typeof username !== 'string' || !username.trim() || !positive) {
    ctx.status = 400
    ctx.body = { error: 'username and positive amount are required' }
    return
  }
  const user = findUserByUsername(username.trim())
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'user not found' }
    return
  }
  const entry = refundCredits(user.id, positive, {
    note: typeof note === 'string' ? note : '',
  })
  if (!entry) {
    ctx.status = 500
    ctx.body = { error: 'failed to refund credits' }
    return
  }
  ctx.body = { ok: true, entry }
}
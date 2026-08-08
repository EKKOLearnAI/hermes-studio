/**
 * Credits billing hooks — 挂在 run-chat 完成时按真实 token 用量扣点。
 *
 * 扣费规则（可在环境变量覆盖）：
 *   HERMES_WEB_UI_CREDITS_TOKENS_PER_POINT : 每点数对应的 token 数（默认 1000）
 *   HERMES_WEB_UI_CREDITS_ENABLED          : '0' 时关闭扣费（默认开启）
 *
 * super_admin 不扣费（演示/管理用途），普通用户每次 run 完成后结算。
 */

import { getCreditsSummary, chargeCredits } from '../db/hermes/credits-store'
import type { AuthenticatedUser } from '../middleware/user-auth'
import { logger } from './logger'

const DEFAULT_TOKENS_PER_POINT = 1000

function tokensPerPoint(): number {
  const raw = process.env.HERMES_WEB_UI_CREDITS_TOKENS_PER_POINT
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TOKENS_PER_POINT
}

export function creditsEnabled(): boolean {
  return process.env.HERMES_WEB_UI_CREDITS_ENABLED !== '0'
}

/** 换算 tokens → 应扣点数（不足一点按一点，避免免费蹭） */
export function tokensToCredits(inputTokens: number, outputTokens: number): number {
  const per = tokensPerPoint()
  const total = Math.max(0, Math.floor(inputTokens || 0)) + Math.max(0, Math.floor(outputTokens || 0))
  return Math.max(1, Math.ceil(total / per))
}

export interface ChargeRunResult {
  charged: boolean
  points: number
  balance: number
  reason?: string
}

/**
 * run 完成后调用：对非 super_admin 用户按这次 run 的 token 用量扣点。
 * - 余额不足返回 charged=false, reason='insufficient_balance'（不阻塞，仅记录）
 */
export function chargeUserRun(
  user: AuthenticatedUser | undefined,
  inputTokens: number,
  outputTokens: number,
  context: { sessionId?: string; runId?: string },
): ChargeRunResult {
  if (!user) return { charged: false, points: 0, balance: 0, reason: 'no_user' }
  if (!creditsEnabled()) return { charged: false, points: 0, balance: 0, reason: 'disabled' }
  if (user.role === 'super_admin') return { charged: false, points: 0, balance: 0, reason: 'super_admin_exempt' }

  const points = tokensToCredits(inputTokens, outputTokens)
  const result = chargeCredits(user.id, points, {
    note: `AI 用量 ${Math.floor(inputTokens || 0)} in / ${Math.floor(outputTokens || 0)} out tokens (${context.sessionId || ''} ${context.runId || ''})`,
  })
  if (!result.ok) {
    logger.warn(
      { userId: user.id, username: user.username, points, balance: result.balance },
      '[credits] run charge rejected: insufficient balance',
    )
    return { charged: false, points, balance: result.balance, reason: 'insufficient' }
  }
  logger.info(
    { userId: user.id, username: user.username, points, balance: result.balance },
    '[credits] run charged %d points',
    points,
  )
  return { charged: true, points, balance: result.balance }
}

/** run 开始前调用：检查用户是否有余额（有余额才放行，余额为 0 拒绝） */
export function canUserRun(user: AuthenticatedUser | undefined): { allowed: boolean; balance: number; reason?: string } {
  if (!user) return { allowed: false, balance: 0, reason: 'no_user' }
  if (!creditsEnabled()) return { allowed: true, balance: 0 }
  if (user.role === 'super_admin') return { allowed: true, balance: 0 }
  const { balance } = getCreditsSummary(user.id)
  if (balance <= 0) {
    return { allowed: false, balance, reason: 'insufficient_balance' }
  }
  return { allowed: true, balance }
}
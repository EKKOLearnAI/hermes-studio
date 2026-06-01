export type PaperExecutionSide = 'BUY' | 'SELL'

export interface PessimisticExecutionInput {
  side: PaperExecutionSide
  marketPrice: number
  slippageRate?: number
}

export interface PessimisticExecutionResult {
  side: PaperExecutionSide
  marketPrice: number
  executionPrice: number
  slippageRate: number
  slippageAmount: number
}

export const SLIPPAGE_RATE = 0.0015

export function applyPessimisticExecution(input: PessimisticExecutionInput): PessimisticExecutionResult {
  const marketPrice = finitePositive(input.marketPrice)
  const slippageRate = finiteNonNegative(input.slippageRate ?? SLIPPAGE_RATE)
  const direction = input.side === 'BUY' ? 1 : -1
  const executionPrice = round4(marketPrice * (1 + direction * slippageRate))

  return {
    side: input.side,
    marketPrice,
    executionPrice,
    slippageRate,
    slippageAmount: round4(Math.abs(executionPrice - marketPrice)),
  }
}

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : SLIPPAGE_RATE
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

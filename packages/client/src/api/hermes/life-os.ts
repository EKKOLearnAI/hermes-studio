import { request } from '@/api/client'

export interface LifeOsIdentity {
  name: string
  birthdate: string
  astrology: string
  chineseZodiac: string
  gender: string
  occupation: string
}

export interface LifeOsFinancialState {
  cashAndLiquidity: {
    twdAvailable: number
    twdFixedReserve: number
    foreignCurrencyReserve: number
  }
  investmentEquity: {
    domesticStocks: LifeOsStockItem[]
    usStocks: LifeOsStockItem[]
  }
  liabilities: {
    loanTotal: number
  }
  monthlyInflow: {
    totalIncome: number
  }
  monthlyOutflow: {
    fixedEssential: number
    discretionaryLiving: number
    subscriptionsAndEducation: number
    annualExpenseAmortized: number
  }
}

export interface LifeOsMarketSettings {
  usdTwdRate: number
  usdTwdSource?: string
  updatedAt?: string
}

export type LifeOsBudgetAccountType = '活存' | '定存' | '外幣' | '證券戶' | '信用卡' | '貸款' | string

export interface LifeOsBudgetAccount {
  id: string
  name: string
  type: LifeOsBudgetAccountType
  balance: number
}

export interface LifeOsBudgetCategory {
  id: string
  name: string
  group: string
  budgeted: number
}

export interface LifeOsBudgetTransaction {
  id: string
  date: string
  accountId: string
  categoryId: string
  payee: string
  amount: number
  note: string
}

export interface LifeOsBudgeting {
  month: string
  accounts: LifeOsBudgetAccount[]
  categories: LifeOsBudgetCategory[]
  transactions: LifeOsBudgetTransaction[]
}

export interface LifeOsStockItem {
  symbol: string
  name: string
  shares: number
  costBasis: number
  currentPrice: number
}

export interface LifeOsStockItemWithMetrics extends LifeOsStockItem {
  marketValue: number
  gainLoss: number
  gainLossPct: number
  currency: 'TWD' | 'USD'
  fxRate: number
  marketValueTwd: number
  costTwd: number
  gainLossTwd: number
}

export interface LifeOsStockMetrics {
  items: LifeOsStockItemWithMetrics[]
  currency: 'TWD' | 'USD'
  fxRate: number
  totalMarketValue: number
  totalCost: number
  totalGainLoss: number
  totalGainLossPct: number
  totalMarketValueTwd: number
  totalCostTwd: number
  totalGainLossTwd: number
}

export type LifeOsQuestStatus = '未開始' | '進行中' | '已完成' | '暫停' | string

export interface LifeOsLearningQuest {
  id: string
  title: string
  category: string
  expectedImpact: string
  status: LifeOsQuestStatus
}

export interface LifeOsSkill {
  name: string
  level: number
}

export interface LifeOsEvolution {
  learningQuests: LifeOsLearningQuest[]
  skills: LifeOsSkill[]
}

export interface LifeOsLifeScores {
  finance: number
  discipline: number
  learning: number
  business: number
  retirement: number
}

export interface LifeOsComputedMetrics {
  totalCash: number
  totalStocks: number
  totalAssets: number
  netWorth: number
  totalExpenses: number
  investmentTransfers: number
  netMonthlyCashFlow: number
  cashReserveMonths: number
  investmentRatio: number
  usdTwdRate: number
  domesticStocksTwd: number
  usStocksTwd: number
  fireTarget: number
  fireProgress: number
  budgetMetrics: LifeOsBudgetMetrics
  domesticStockMetrics: LifeOsStockMetrics
  usStockMetrics: LifeOsStockMetrics
}

export interface LifeOsBudgetCategoryMetric extends LifeOsBudgetCategory {
  spent: number
  remaining: number
}

export interface LifeOsBudgetMetrics {
  totalBudgeted: number
  totalSpent: number
  operatingSpent: number
  transferSpent: number
  totalRemaining: number
  availableToBudget: number
  categories: LifeOsBudgetCategoryMetric[]
}

export interface LifeOsState {
  identity: LifeOsIdentity
  financialState: LifeOsFinancialState
  marketSettings: LifeOsMarketSettings
  budgeting: LifeOsBudgeting
  evolution: LifeOsEvolution
  lifeScores: LifeOsLifeScores
  targetMonthlyPassiveIncome: number
  computedMetrics: LifeOsComputedMetrics
}

export interface LifeOsMonthlySettlementSummary {
  netWorth: number
  totalAssets: number
  totalCash: number
  totalStocks: number
  totalExpenses: number
  investmentTransfers: number
  netMonthlyCashFlow: number
  cashReserveMonths: number
  fireProgress: number
  usdTwdRate: number
  domesticStocksTwd: number
  usStocksTwd: number
  domesticStockGainLossPct: number
  usStockGainLossPct: number
}

export interface LifeOsMonthlySettlement {
  id: string
  month: string
  createdAt: string
  identityName: string
  summary: LifeOsMonthlySettlementSummary
  snapshot: LifeOsState
}

export interface LifeOsMonthlySettlementList {
  currentMonth: string
  currentMonthClosed: boolean
  latest: LifeOsMonthlySettlement | null
  items: LifeOsMonthlySettlement[]
}

export interface LifeOsMonthlySettlementCreateResponse {
  currentMonth: string
  currentMonthClosed: boolean
  settlement: LifeOsMonthlySettlement
  items: LifeOsMonthlySettlement[]
}

export interface LifeOsBackupExport {
  exportedAt: string
  kind: 'life-os-backup'
  version: number
  state: LifeOsState
  settlements: LifeOsMonthlySettlement[]
}

export interface LifeOsBackupCreateResponse {
  exportedAt: string
  fileName: string
  path: string
  backup: LifeOsBackupExport
}

export type LifeOsMarketKind = 'domestic' | 'us'

export interface LifeOsPriceUpdate {
  symbol: string
  providerSymbol: string
  market: LifeOsMarketKind
  status: 'ok' | 'failed' | 'skipped'
  price?: number
  name?: string
  detail: string
}

export interface LifeOsPriceRefreshResponse {
  updatedAt: string
  state: LifeOsState
  updates: LifeOsPriceUpdate[]
}

export interface LifeOsDebateFeed {
  alpha: string
  beta: string
  prime: string
}

export interface LifeOsBriefingGenerateResponse {
  success: boolean
  ok: boolean
  date: string
  mode: 'hermes-gateway' | 'custom-provider' | 'local-fallback'
  watchSymbols: string[]
  marketIntelFound: boolean
  wikiContextFound: boolean
  debateFound: boolean
  debateFeed: LifeOsDebateFeed | string | null
  content: string
}

export function getLifeOsState(options: RequestInit = {}): Promise<LifeOsState> {
  return request<LifeOsState>('/api/hermes/life-os/state', options)
}

export function updateLifeOsState(state: LifeOsState): Promise<LifeOsState> {
  return request<LifeOsState>('/api/hermes/life-os/state', {
    method: 'PUT',
    body: JSON.stringify({ state }),
  })
}

export function getLifeOsMonthlySettlements(): Promise<LifeOsMonthlySettlementList> {
  return request<LifeOsMonthlySettlementList>('/api/hermes/life-os/monthly-settlements')
}

export function createLifeOsMonthlySettlement(state: LifeOsState): Promise<LifeOsMonthlySettlementCreateResponse> {
  return request<LifeOsMonthlySettlementCreateResponse>('/api/hermes/life-os/monthly-settlements', {
    method: 'POST',
    body: JSON.stringify({ state }),
  })
}

export function createLifeOsBackup(): Promise<LifeOsBackupCreateResponse> {
  return request<LifeOsBackupCreateResponse>('/api/hermes/life-os/backups', {
    method: 'POST',
  })
}

export function refreshLifeOsPrices(state: LifeOsState): Promise<LifeOsPriceRefreshResponse> {
  return request<LifeOsPriceRefreshResponse>('/api/hermes/life-os/refresh-prices', {
    method: 'POST',
    body: JSON.stringify({ state }),
  })
}

export function generateLifeOsBriefing(date?: string): Promise<LifeOsBriefingGenerateResponse> {
  return request<LifeOsBriefingGenerateResponse>('/api/hermes/generate-briefing', {
    method: 'POST',
    body: JSON.stringify(date ? { date } : {}),
  })
}

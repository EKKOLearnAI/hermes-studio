import Router from '@koa/router'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { searchWIKI, writeDailyBriefing } from '../../services/obsidianService'
import { fetchMarketTrend } from '../../services/openClawService'
import { extractActionableIntel } from '../../services/miroFishService'
import { runStrategicDebate, type StrategicDebateResult } from '../../services/debateService'

export const lifeOsRoutes = new Router()

interface LifeOsIdentity {
  name: string
  birthdate: string
  astrology: string
  chineseZodiac: string
  gender: string
  occupation: string
}

interface LifeOsFinancialState {
  cashAndLiquidity: {
    twdAvailable: number
    twdFixedReserve: number
    foreignCurrencyReserve: number
  }
  investmentEquity: {
    domesticStocks: StockItem[]
    usStocks: StockItem[]
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

interface LifeOsMarketSettings {
  usdTwdRate: number
  usdTwdSource?: string
  updatedAt?: string
}

interface LifeOsBudgetAccount {
  id: string
  name: string
  type: string
  balance: number
}

interface LifeOsBudgetCategory {
  id: string
  name: string
  group: string
  budgeted: number
}

interface LifeOsBudgetTransaction {
  id: string
  date: string
  accountId: string
  categoryId: string
  payee: string
  amount: number
  note: string
}

interface LifeOsBudgeting {
  month: string
  accounts: LifeOsBudgetAccount[]
  categories: LifeOsBudgetCategory[]
  transactions: LifeOsBudgetTransaction[]
}

interface StockItem {
  symbol: string
  name: string
  shares: number
  costBasis: number
  currentPrice: number
}

interface StockItemWithMetrics extends StockItem {
  marketValue: number
  gainLoss: number
  gainLossPct: number
  currency: 'TWD' | 'USD'
  fxRate: number
  marketValueTwd: number
  costTwd: number
  gainLossTwd: number
}

interface StockMetrics {
  items: StockItemWithMetrics[]
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

type LifeOsMarketKind = 'domestic' | 'us'

interface LifeOsPriceUpdate {
  symbol: string
  providerSymbol: string
  market: LifeOsMarketKind
  status: 'ok' | 'failed' | 'skipped'
  price?: number
  name?: string
  detail: string
}

interface LifeOsPriceRefreshResponse {
  updatedAt: string
  state: LifeOsStateResponse
  updates: LifeOsPriceUpdate[]
}

interface LifeOsLearningQuest {
  id: string
  title: string
  category: string
  expectedImpact: string
  status: string
}

interface LifeOsSkill {
  name: string
  level: number
}

interface LifeOsEvolution {
  learningQuests: LifeOsLearningQuest[]
  skills: LifeOsSkill[]
}

interface LifeOsLifeScores {
  finance: number
  discipline: number
  learning: number
  business: number
  retirement: number
}

interface LifeOsState {
  identity: LifeOsIdentity
  financialState: LifeOsFinancialState
  marketSettings: LifeOsMarketSettings
  budgeting?: LifeOsBudgeting
  evolution: LifeOsEvolution
  lifeScores: LifeOsLifeScores
  targetMonthlyPassiveIncome: number
}

interface BudgetCategoryMetric extends LifeOsBudgetCategory {
  spent: number
  remaining: number
}

interface BudgetMetrics {
  totalBudgeted: number
  totalSpent: number
  operatingSpent: number
  transferSpent: number
  totalRemaining: number
  availableToBudget: number
  categories: BudgetCategoryMetric[]
}

interface LifeOsComputedMetrics {
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
  budgetMetrics: BudgetMetrics
  domesticStockMetrics: StockMetrics
  usStockMetrics: StockMetrics
}

interface LifeOsStateResponse extends LifeOsState {
  computedMetrics: LifeOsComputedMetrics
}

interface MonthlySettlementSummary {
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

interface MonthlySettlement {
  id: string
  month: string
  createdAt: string
  identityName: string
  summary: MonthlySettlementSummary
  snapshot: LifeOsStateResponse
}

function lifeOsStatePath(): string {
  return resolve(process.cwd(), 'data', 'life-os-state.json')
}

function monthlySettlementPath(): string {
  return resolve(process.cwd(), 'data', 'life-os-monthly-settlements.json')
}

function lifeOsBackupDir(): string {
  return resolve(process.cwd(), 'data', 'life-os-backups')
}

const DEFAULT_USD_TWD_RATE = 32
const BASELINE_MONTHLY_EXPENSE = 35000

function ensureDataDir(): void {
  mkdirSync(resolve(process.cwd(), 'data'), { recursive: true })
}

function ensureBackupDir(): void {
  ensureDataDir()
  mkdirSync(lifeOsBackupDir(), { recursive: true })
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeStocks(stocks: unknown): StockItem[] {
  if (!Array.isArray(stocks)) return []
  return stocks.map((stock: any) => ({
    symbol: String(stock?.symbol || '').trim(),
    name: String(stock?.name || '').trim(),
    shares: numberOrZero(stock?.shares),
    costBasis: numberOrZero(stock?.costBasis),
    currentPrice: numberOrZero(stock?.currentPrice),
  }))
}

function normalizeMarketSettings(settings: unknown): LifeOsMarketSettings {
  const source = (settings || {}) as any
  const usdTwdRate = numberOrZero(source.usdTwdRate)
  return {
    usdTwdRate: usdTwdRate > 0 ? usdTwdRate : DEFAULT_USD_TWD_RATE,
    usdTwdSource: String(source.usdTwdSource || 'default'),
    updatedAt: String(source.updatedAt || ''),
  }
}

function normalizeBudgeting(budgeting: unknown): LifeOsBudgeting {
  const source = (budgeting || {}) as any
  const accounts = Array.isArray(source.accounts) ? source.accounts : []
  const categories = Array.isArray(source.categories) ? source.categories : []
  const transactions = Array.isArray(source.transactions) ? source.transactions : []

  const normalizedAccounts: LifeOsBudgetAccount[] = accounts.map((account: any, index: number) => ({
    id: String(account?.id || `account-${index + 1}`),
    name: String(account?.name || '未命名帳戶'),
    type: String(account?.type || '活存'),
    balance: numberOrZero(account?.balance),
  }))

  if (!normalizedAccounts.some((account) => account.id === 'brokerage-cash' || account.type === '證券戶')) {
    normalizedAccounts.push({
      id: 'brokerage-cash',
      name: '證券戶市值',
      type: '證券戶',
      balance: 0,
    })
  } else {
    const brokerage = normalizedAccounts.find((account) => account.id === 'brokerage-cash' || account.type === '證券戶')
    if (brokerage) {
      brokerage.type = '證券戶'
      if (!brokerage.name || brokerage.name === '證券戶現金') {
        brokerage.name = '證券戶市值'
      }
    }
  }

  return {
    month: String(source.month || currentMonthKey()),
    accounts: normalizedAccounts,
    categories: categories.map((category: any, index: number) => ({
      id: String(category?.id || `category-${index + 1}`),
      name: String(category?.name || '未命名分類'),
      group: String(category?.group || '生活'),
      budgeted: numberOrZero(category?.budgeted),
    })),
    transactions: transactions.map((transaction: any, index: number) => ({
      id: String(transaction?.id || `tx-${index + 1}`),
      date: String(transaction?.date || new Date().toISOString().slice(0, 10)),
      accountId: String(transaction?.accountId || ''),
      categoryId: String(transaction?.categoryId || ''),
      payee: String(transaction?.payee || ''),
      amount: numberOrZero(transaction?.amount),
      note: String(transaction?.note || ''),
    })),
  }
}

function normalizeEvolution(evolution: unknown): LifeOsEvolution {
  const source = (evolution || {}) as any
  const learningQuests = Array.isArray(source.learningQuests) ? source.learningQuests : []
  const skills = Array.isArray(source.skills) ? source.skills : []

  return {
    learningQuests: learningQuests.map((quest: any, index: number) => ({
      id: String(quest?.id || `q${index + 1}`),
      title: String(quest?.title || '未命名任務'),
      category: String(quest?.category || '學習'),
      expectedImpact: String(quest?.expectedImpact || '紀律 +1'),
      status: String(quest?.status || '未開始'),
    })),
    skills: skills.map((skill: any) => ({
      name: String(skill?.name || '未命名技能'),
      level: Math.min(100, Math.max(0, numberOrZero(skill?.level))),
    })),
  }
}

function normalizeLifeScores(scores: unknown): LifeOsLifeScores {
  const source = (scores || {}) as any
  const clampScore = (value: unknown) => Math.min(100, Math.max(0, numberOrZero(value)))

  return {
    finance: clampScore(source.finance),
    discipline: clampScore(source.discipline),
    learning: clampScore(source.learning),
    business: clampScore(source.business),
    retirement: clampScore(source.retirement),
  }
}

function normalizeLifeOsState(state: unknown): LifeOsState {
  const source = (state || {}) as any
  const financial = source.financialState || {}
  const cashAndLiquidity = financial.cashAndLiquidity || {}
  const investmentEquity = financial.investmentEquity || {}
  const liabilities = financial.liabilities || {}
  const monthlyInflow = financial.monthlyInflow || {}
  const monthlyOutflow = financial.monthlyOutflow || {}
  const identity = source.identity || {}

  return {
    identity: {
      name: String(identity.name || ''),
      birthdate: String(identity.birthdate || ''),
      astrology: String(identity.astrology || ''),
      chineseZodiac: String(identity.chineseZodiac || ''),
      gender: String(identity.gender || ''),
      occupation: String(identity.occupation || ''),
    },
    financialState: {
      cashAndLiquidity: {
        twdAvailable: numberOrZero(cashAndLiquidity.twdAvailable),
        twdFixedReserve: numberOrZero(cashAndLiquidity.twdFixedReserve),
        foreignCurrencyReserve: numberOrZero(cashAndLiquidity.foreignCurrencyReserve),
      },
      investmentEquity: {
        domesticStocks: normalizeStocks(investmentEquity.domesticStocks),
        usStocks: normalizeStocks(investmentEquity.usStocks),
      },
      liabilities: {
        loanTotal: numberOrZero(liabilities.loanTotal),
      },
      monthlyInflow: {
        totalIncome: numberOrZero(monthlyInflow.totalIncome),
      },
      monthlyOutflow: {
        fixedEssential: numberOrZero(monthlyOutflow.fixedEssential),
        discretionaryLiving: numberOrZero(monthlyOutflow.discretionaryLiving),
        subscriptionsAndEducation: numberOrZero(monthlyOutflow.subscriptionsAndEducation),
        annualExpenseAmortized: numberOrZero(monthlyOutflow.annualExpenseAmortized),
      },
    },
    marketSettings: normalizeMarketSettings(source.marketSettings),
    budgeting: normalizeBudgeting(source.budgeting),
    evolution: normalizeEvolution(source.evolution),
    lifeScores: normalizeLifeScores(source.lifeScores),
    targetMonthlyPassiveIncome: numberOrZero(source.targetMonthlyPassiveIncome),
  }
}

function isBrokerageAccount(account: LifeOsBudgetAccount): boolean {
  return account.id === 'brokerage-cash' || account.type === '證券戶'
}

function isLiquidityAccount(account: LifeOsBudgetAccount): boolean {
  return !isBrokerageAccount(account) && !['信用卡', '貸款'].includes(account.type)
}

function isTransferBudgetCategory(category: LifeOsBudgetCategory | undefined): boolean {
  if (!category) return false
  return category.id === 'investing' || category.group === '資產'
}

function computeBudgetMetrics(budgeting: LifeOsBudgeting, totalCash: number): BudgetMetrics {
  const spendByCategory = new Map<string, number>()
  const categoryById = new Map(budgeting.categories.map((category) => [category.id, category]))

  for (const transaction of budgeting.transactions) {
    if (transaction.amount >= 0 || !transaction.categoryId) continue
    spendByCategory.set(
      transaction.categoryId,
      numberOrZero(spendByCategory.get(transaction.categoryId)) + Math.abs(transaction.amount),
    )
  }

  const categories = budgeting.categories.map((category) => {
    const spent = Math.round(numberOrZero(spendByCategory.get(category.id)))
    const budgeted = Math.round(numberOrZero(category.budgeted))
    return {
      ...category,
      budgeted,
      spent,
      remaining: budgeted - spent,
    }
  })

  const totalBudgeted = categories.reduce((sum, category) => sum + category.budgeted, 0)
  const totalSpent = categories.reduce((sum, category) => sum + category.spent, 0)
  const transferSpent = categories.reduce((sum, category) => (
    isTransferBudgetCategory(categoryById.get(category.id)) ? sum + category.spent : sum
  ), 0)
  const operatingSpent = Math.max(0, totalSpent - transferSpent)
  const totalRemaining = categories.reduce((sum, category) => sum + category.remaining, 0)

  return {
    totalBudgeted,
    totalSpent,
    operatingSpent,
    transferSpent,
    totalRemaining,
    availableToBudget: totalCash - totalBudgeted,
    categories,
  }
}

function baselineMonthlyExpense(monthlyOutflow: LifeOsState['financialState']['monthlyOutflow'], budgeting: LifeOsBudgeting): number {
  const plannedExpenses =
    numberOrZero(monthlyOutflow.fixedEssential) +
    numberOrZero(monthlyOutflow.discretionaryLiving) +
    numberOrZero(monthlyOutflow.subscriptionsAndEducation) +
    numberOrZero(monthlyOutflow.annualExpenseAmortized)
  if (plannedExpenses > 0) return plannedExpenses

  const budgetedOperating = budgeting.categories
    .filter((category) => !isTransferBudgetCategory(category))
    .reduce((sum, category) => sum + numberOrZero(category.budgeted), 0)
  return budgetedOperating > 0 ? budgetedOperating : BASELINE_MONTHLY_EXPENSE
}

function calculateStockMetrics(stocks: StockItem[], currency: 'TWD' | 'USD', fxRate: number): StockMetrics {
  let totalMarketValue = 0
  let totalCost = 0
  let totalMarketValueTwd = 0
  let totalCostTwd = 0

  const items = normalizeStocks(stocks).map((stock) => {
    const marketValue = stock.shares * stock.currentPrice
    const cost = stock.shares * stock.costBasis
    const gainLoss = marketValue - cost
    const gainLossPct = cost > 0 ? (gainLoss / cost) * 100 : 0
    const marketValueTwd = marketValue * fxRate
    const costTwd = cost * fxRate
    const gainLossTwd = gainLoss * fxRate

    totalMarketValue += marketValue
    totalCost += cost
    totalMarketValueTwd += marketValueTwd
    totalCostTwd += costTwd

    return {
      ...stock,
      marketValue: Math.round(marketValue),
      gainLoss: Math.round(gainLoss),
      gainLossPct: round(gainLossPct, 2),
      currency,
      fxRate,
      marketValueTwd: Math.round(marketValueTwd),
      costTwd: Math.round(costTwd),
      gainLossTwd: Math.round(gainLossTwd),
    }
  })

  const totalGainLoss = totalMarketValue - totalCost
  const totalGainLossPct = totalCost > 0 ? (totalGainLoss / totalCost) * 100 : 0
  const totalGainLossTwd = totalMarketValueTwd - totalCostTwd

  return {
    currency,
    fxRate,
    items,
    totalMarketValue: Math.round(totalMarketValue),
    totalCost: Math.round(totalCost),
    totalGainLoss: Math.round(totalGainLoss),
    totalGainLossPct: round(totalGainLossPct, 2),
    totalMarketValueTwd: Math.round(totalMarketValueTwd),
    totalCostTwd: Math.round(totalCostTwd),
    totalGainLossTwd: Math.round(totalGainLossTwd),
  }
}

function providerSymbolForStock(symbol: string, market: LifeOsMarketKind): string {
  const cleaned = symbol.trim().toUpperCase()
  if (!cleaned) return ''
  if (market === 'domestic' && /^\d{4,6}$/.test(cleaned)) return `${cleaned}.TW`
  return cleaned
}

function latestNumber(values: Array<number | null | undefined> | undefined): number | null {
  if (!Array.isArray(values)) return null
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = Number(values[index])
    if (Number.isFinite(value) && value > 0) return value
  }
  return null
}

async function fetchYahooChartPrice(symbol: string, market: LifeOsMarketKind): Promise<LifeOsPriceUpdate> {
  const providerSymbol = providerSymbolForStock(symbol, market)
  if (!providerSymbol) {
    return {
      symbol,
      providerSymbol,
      market,
      status: 'skipped',
      detail: 'Missing stock symbol.',
    }
  }

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}` +
    '?range=5d&interval=1d&includePrePost=false'
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 Hermes Life OS/0.1',
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    throw new Error(`Yahoo Chart HTTP ${res.status}`)
  }

  const json = await res.json() as {
    chart?: {
      error?: { code?: string; description?: string }
      result?: Array<{
        meta?: {
          symbol?: string
          shortName?: string
          longName?: string
          regularMarketPrice?: number
          previousClose?: number
          chartPreviousClose?: number
        }
        indicators?: {
          quote?: Array<{
            close?: Array<number | null>
          }>
        }
      }>
    }
  }

  const chartError = json.chart?.error
  if (chartError) {
    throw new Error(chartError.description || chartError.code || 'Yahoo Chart error')
  }

  const result = json.chart?.result?.[0]
  const meta = result?.meta
  const close = latestNumber(result?.indicators?.quote?.[0]?.close)
  const price = Number(meta?.regularMarketPrice ?? close)
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`No valid price returned for ${providerSymbol}`)
  }

  return {
    symbol: symbol.trim().toUpperCase(),
    providerSymbol: String(meta?.symbol || providerSymbol),
    market,
    status: 'ok',
    price: round(price, 4),
    name: meta?.shortName || meta?.longName,
    detail: `Yahoo Chart ${providerSymbol} price ${round(price, 4)}`,
  }
}

async function refreshUsdTwdRate(settings: LifeOsMarketSettings): Promise<LifeOsMarketSettings> {
  try {
    const update = await fetchYahooChartPrice('TWD=X', 'us')
    if (update.status === 'ok' && typeof update.price === 'number' && update.price > 0) {
      return {
        usdTwdRate: update.price,
        usdTwdSource: 'Yahoo Chart TWD=X',
        updatedAt: new Date().toISOString(),
      }
    }
  } catch {
    // Keep the last valid rate; price refresh should not fail just because FX is temporarily unavailable.
  }

  return {
    ...settings,
    updatedAt: settings.updatedAt || new Date().toISOString(),
  }
}

async function refreshStockGroupPrices(stocks: StockItem[], market: LifeOsMarketKind): Promise<LifeOsPriceUpdate[]> {
  const updates = await Promise.all(stocks.map(async (stock) => {
    const symbol = String(stock.symbol || '').trim()
    if (!symbol) {
      return {
        symbol,
        providerSymbol: '',
        market,
        status: 'skipped' as const,
        detail: 'Missing stock symbol.',
      }
    }

    try {
      const update = await fetchYahooChartPrice(symbol, market)
      if (update.status === 'ok' && typeof update.price === 'number') {
        stock.symbol = update.symbol
        stock.currentPrice = update.price
        if (!stock.name && update.name) stock.name = update.name
      }
      return update
    } catch (err: any) {
      return {
        symbol: symbol.toUpperCase(),
        providerSymbol: providerSymbolForStock(symbol, market),
        market,
        status: 'failed' as const,
        detail: err?.message || 'Price refresh failed.',
      }
    }
  }))

  return updates
}

async function refreshLifeOsPrices(state: LifeOsState): Promise<{ state: LifeOsState; updates: LifeOsPriceUpdate[] }> {
  const nextState = normalizeLifeOsState(state)
  const [marketSettings, domesticUpdates, usUpdates] = await Promise.all([
    refreshUsdTwdRate(nextState.marketSettings),
    refreshStockGroupPrices(nextState.financialState.investmentEquity.domesticStocks, 'domestic'),
    refreshStockGroupPrices(nextState.financialState.investmentEquity.usStocks, 'us'),
  ])
  nextState.marketSettings = marketSettings

  return {
    state: nextState,
    updates: [...domesticUpdates, ...usUpdates],
  }
}

function computeLifeOsMetrics(state: LifeOsState): LifeOsComputedMetrics {
  const { cashAndLiquidity, investmentEquity, liabilities, monthlyInflow, monthlyOutflow } = state.financialState
  const budgeting = normalizeBudgeting(state.budgeting)
  const marketSettings = normalizeMarketSettings(state.marketSettings)
  const usdTwdRate = marketSettings.usdTwdRate
  const domesticStockMetrics = calculateStockMetrics(investmentEquity.domesticStocks, 'TWD', 1)
  const usStockMetrics = calculateStockMetrics(investmentEquity.usStocks, 'USD', usdTwdRate)
  const budgetCash = budgeting.accounts
    .filter(isLiquidityAccount)
    .reduce((sum, account) => sum + numberOrZero(account.balance), 0)
  const legacyCash =
    numberOrZero(cashAndLiquidity.twdAvailable) +
    numberOrZero(cashAndLiquidity.twdFixedReserve) +
    numberOrZero(cashAndLiquidity.foreignCurrencyReserve)
  const totalCash = budgeting.accounts.length > 0 ? budgetCash : legacyCash
  const domesticStocksTwd = domesticStockMetrics.totalMarketValueTwd
  const usStocksTwd = usStockMetrics.totalMarketValueTwd
  const totalStocks = domesticStocksTwd + usStocksTwd
  const totalAssets = totalCash + totalStocks
  const netWorth = totalAssets - numberOrZero(liabilities.loanTotal)
  const budgetMetrics = computeBudgetMetrics(budgeting, totalCash)
  const totalExpenses = baselineMonthlyExpense(monthlyOutflow, budgeting)
  const investmentTransfers = budgetMetrics.transferSpent
  const netMonthlyCashFlow = numberOrZero(monthlyInflow.totalIncome) - totalExpenses
  const cashReserveMonths = totalExpenses > 0 ? round(totalCash / totalExpenses, 1) : 0
  const investmentRatio = totalAssets > 0 ? round((totalStocks / totalAssets) * 100, 2) : 0
  const fireTarget = totalExpenses * 12 * 25
  const fireProgress = fireTarget > 0 ? round((netWorth / fireTarget) * 100, 2) : 0

  return {
    totalCash,
    totalStocks,
    totalAssets,
    netWorth,
    totalExpenses,
    investmentTransfers,
    netMonthlyCashFlow,
    cashReserveMonths,
    investmentRatio,
    usdTwdRate,
    domesticStocksTwd,
    usStocksTwd,
    fireTarget,
    fireProgress,
    budgetMetrics,
    domesticStockMetrics,
    usStockMetrics,
  }
}

function readLifeOsState(): LifeOsState {
  const raw = readFileSync(lifeOsStatePath(), 'utf-8')
  return JSON.parse(raw) as LifeOsState
}

function writeLifeOsState(state: LifeOsState): void {
  ensureDataDir()
  writeFileSync(lifeOsStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
}

function buildStateResponse(state: LifeOsState): LifeOsStateResponse {
  const normalized = normalizeLifeOsState(state)
  return {
    ...normalized,
    computedMetrics: computeLifeOsMetrics(normalized),
  }
}

function currentMonthKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function readMonthlySettlements(): MonthlySettlement[] {
  const filePath = monthlySettlementPath()
  if (!existsSync(filePath)) return []
  const raw = readFileSync(filePath, 'utf-8').trim()
  if (!raw) return []
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed as MonthlySettlement[] : []
}

function writeMonthlySettlements(items: MonthlySettlement[]): void {
  ensureDataDir()
  writeFileSync(monthlySettlementPath(), `${JSON.stringify(items, null, 2)}\n`, 'utf-8')
}

function buildMonthlySettlement(state: LifeOsState, month = currentMonthKey()): MonthlySettlement {
  const snapshot = buildStateResponse(state)
  const metrics = snapshot.computedMetrics
  return {
    id: month,
    month,
    createdAt: new Date().toISOString(),
    identityName: snapshot.identity.name,
    summary: {
      netWorth: metrics.netWorth,
      totalAssets: metrics.totalAssets,
      totalCash: metrics.totalCash,
      totalStocks: metrics.totalStocks,
      totalExpenses: metrics.totalExpenses,
      investmentTransfers: metrics.investmentTransfers,
      netMonthlyCashFlow: metrics.netMonthlyCashFlow,
      cashReserveMonths: metrics.cashReserveMonths,
      fireProgress: metrics.fireProgress,
      usdTwdRate: metrics.usdTwdRate,
      domesticStocksTwd: metrics.domesticStocksTwd,
      usStocksTwd: metrics.usStocksTwd,
      domesticStockGainLossPct: metrics.domesticStockMetrics.totalGainLossPct,
      usStockGainLossPct: metrics.usStockMetrics.totalGainLossPct,
    },
    snapshot,
  }
}

function buildBackupPayload() {
  const state = buildStateResponse(readLifeOsState())
  const settlements = readMonthlySettlements().sort((a, b) => b.month.localeCompare(a.month))
  return {
    exportedAt: new Date().toISOString(),
    kind: 'life-os-backup',
    version: 1,
    state,
    settlements,
  }
}

function currentDateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function formatTwd(value: number): string {
  return `NT$${Math.round(value).toLocaleString('en-US')}`
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${round(value, 2)}%`
}

function getBriefingBudgetBreaches(state: LifeOsStateResponse): BudgetCategoryMetric[] {
  return state.computedMetrics.budgetMetrics.categories.filter((category) => (
    category.id !== 'investing' && category.remaining < 0
  ))
}

function getBriefingWatchSymbols(state: LifeOsStateResponse, maxItems = 3): string[] {
  const items = [
    ...state.computedMetrics.usStockMetrics.items,
    ...state.computedMetrics.domesticStockMetrics.items,
  ]

  const preferred = ['NVDA', 'TSLA']
  const scored = items
    .map((stock) => ({
      symbol: stock.symbol.toUpperCase(),
      score:
        (preferred.includes(stock.symbol.toUpperCase()) ? 1_000_000 : 0) +
        Math.abs(stock.gainLossPct) * 10_000 +
        stock.marketValueTwd,
    }))
    .filter((stock) => stock.symbol)
    .sort((a, b) => b.score - a.score)

  return scored
    .map((stock) => stock.symbol)
    .filter((symbol, index, all) => all.indexOf(symbol) === index)
    .slice(0, maxItems)
}

async function buildBriefingMarketIntel(symbols: string[]): Promise<string> {
  if (symbols.length === 0) return ''

  const chunks: string[] = []
  for (const symbol of symbols) {
    try {
      const rawIntel = await fetchMarketTrend(symbol)
      const cleanIntel = await extractActionableIntel(rawIntel)
      if (cleanIntel) chunks.push(`### ${symbol}\n${cleanIntel}`)
    } catch (error) {
      console.warn('[life-os] Briefing market intel skipped:', symbol, error instanceof Error ? error.message : error)
    }
  }

  return chunks.join('\n\n')
}

function buildLocalBriefingMarkdown(dateStr: string, state: LifeOsStateResponse, marketIntel: string, wikiContext: string): string {
  const metrics = state.computedMetrics
  const breaches = getBriefingBudgetBreaches(state)
  const topStocks = [...metrics.usStockMetrics.items, ...metrics.domesticStockMetrics.items]
    .sort((a, b) => b.marketValueTwd - a.marketValueTwd)
    .slice(0, 3)
  const breachLines = breaches.length > 0
    ? breaches.map((category) => `- ${category.name}: 超支 ${formatTwd(Math.abs(category.remaining))}，今日停止同類支出。`).join('\n')
    : '- 沒有非投資預算突破；維持現金防線。'
  const stockLines = topStocks.length > 0
    ? topStocks.map((stock) => `- ${stock.symbol}: 台幣市值 ${formatTwd(stock.marketValueTwd)}，未實現損益 ${formatPct(stock.gainLossPct)}。`).join('\n')
    : '- 目前沒有持倉可檢討。'
  const intelLine = marketIntel
    ? marketIntel.split('\n').slice(0, 5).join('\n')
    : 'OpenClaw 未取得可用外部情報；今日以資產配置與現金流紀律為主。'
  const wikiLine = wikiContext
    ? 'Obsidian 已提供本地專案/技能線索，優先推進可收費、可驗證的 HERMES / AI Agent MVP。'
    : 'Obsidian 暫無可用線索；今日以 HERMES 閘道器專案作為變現主軸。'

  return `
# LifeOS 戰術晨報：${dateStr}

## 昨日財務檢討
- 淨資產：${formatTwd(metrics.netWorth)}；現金水位：${metrics.cashReserveMonths} 個月；FIRE 進度：${metrics.fireProgress}%。
- 月現金流基準：${formatTwd(metrics.netMonthlyCashFlow)}；投資佔比：${metrics.investmentRatio}%。
${breachLines}

## 核心資產夜間異動
${stockLines}

${intelLine}

## 今日最高優先級 FIRE 變現任務
- ${wikiLine}
- 上午：整理一個可交付的 HERMES 功能 demo，目標是能被截圖、說明、報價。
- 下午：把 demo 拆成一頁提案與三個可收費模組，避免做無法變現的工程潔癖。
- 晚上：回寫進度到 Obsidian，保留明日可接續的最小下一步。
`.trim()
}

function buildDebatePortfolioPayload(state: LifeOsStateResponse) {
  const stockItems = [
    ...state.computedMetrics.usStockMetrics.items,
    ...state.computedMetrics.domesticStockMetrics.items,
  ]

  return stockItems
    .sort((a, b) => Math.abs(b.gainLossPct) - Math.abs(a.gainLossPct))
    .slice(0, 10)
    .map((stock) => ({
      symbol: stock.symbol,
      name: stock.name,
      shares: stock.shares,
      marketValueTwd: stock.marketValueTwd,
      costTwd: stock.costTwd,
      gainLossTwd: stock.gainLossTwd,
      gainLossPct: stock.gainLossPct,
      currency: stock.currency,
    }))
}

function buildDebateFinancialPayload(state: LifeOsStateResponse) {
  const metrics = state.computedMetrics
  const breaches = getBriefingBudgetBreaches(state)

  return {
    netWorth: metrics.netWorth,
    totalCash: metrics.totalCash,
    totalStocks: metrics.totalStocks,
    cashReserveMonths: metrics.cashReserveMonths,
    fireProgress: metrics.fireProgress,
    investmentRatio: metrics.investmentRatio,
    monthlyNetCashFlow: metrics.netMonthlyCashFlow,
    totalExpenses: metrics.totalExpenses,
    investmentTransfers: metrics.investmentTransfers,
    budgetBreaches: breaches.map((category) => ({
      name: category.name,
      budgeted: category.budgeted,
      spent: category.spent,
      remaining: category.remaining,
    })),
  }
}

function buildLocalStrategicDebate(state: LifeOsStateResponse, marketIntel: string): StrategicDebateResult {
  const metrics = state.computedMetrics
  const portfolio = buildDebatePortfolioPayload(state)
  const strongest = portfolio
    .slice()
    .sort((a, b) => b.gainLossPct - a.gainLossPct)[0]
  const weakest = portfolio
    .slice()
    .sort((a, b) => a.gainLossPct - b.gainLossPct)[0]
  const breaches = getBriefingBudgetBreaches(state)
  const breachText = breaches.length > 0
    ? breaches.map((category) => `${category.name} 超支 ${formatTwd(Math.abs(category.remaining))}`).join('、')
    : '未偵測到非投資預算突破'

  return {
    mode: 'local-fallback',
    alphaProposal: strongest
      ? `攻擊策略：${strongest.symbol} 目前為最強持倉，未實現損益 ${formatPct(strongest.gainLossPct)}，可列為觀察核心。${marketIntel ? '外部情報已有可用片段，優先追蹤催化是否延續。' : '外部情報不足，先不放大部位，只保留動能觀察。'}`
      : '[系統斷線] 無法獲取激進派提案。暫不擴張風險，只建立候選清單與價格警報。',
    betaRebuttal: `風控反駁：現金水位 ${metrics.cashReserveMonths} 個月，月現金流 ${formatTwd(metrics.netMonthlyCashFlow)}，${breachText}。任何新增投資都不得壓縮生活防線；若持倉集中或預算破口擴大，優先降載而非追價。${weakest ? `最弱持倉 ${weakest.symbol} 損益 ${formatPct(weakest.gainLossPct)}，必須設定退出條件。` : ''}`,
    primeDecision: [
      '## 資產操作判定',
      '[離線裁決] HERMES Gateway 發生解析錯誤或回傳不可用內容。維持紙上推演與風控觀察，不產生真實交易指令。強勢標的只允許追蹤催化，弱勢標的必須補上停損或減碼條件。',
      '',
      '## 今日行動指令',
      '先修補現金流與預算防線，再推進 HERMES / AI Agent 可展示模組。今天只做能增加收入或降低風險的行動。',
    ].join('\n'),
  }
}

function buildDisconnectedDebate(reason = 'HERMES Gateway (Python) 發生解析錯誤。'): StrategicDebateResult {
  return {
    mode: 'local-fallback',
    alphaProposal: '[系統斷線] 無法獲取激進派提案。',
    betaRebuttal: '[系統斷線] 無法獲取保守派風控建議。',
    primeDecision: `[離線裁決] ${reason}請維持現有現金水位，停止不必要開銷。`,
  }
}

function buildDebateBriefingMarkdown(
  dateStr: string,
  state: LifeOsStateResponse,
  marketIntel: string,
  wikiContext: string,
  debate: StrategicDebateResult,
): string {
  const metrics = state.computedMetrics
  const breaches = getBriefingBudgetBreaches(state)
  const breachLines = breaches.length > 0
    ? breaches.map((category) => `- ${category.name}: 超支 ${formatTwd(Math.abs(category.remaining))}。`).join('\n')
    : '- 未偵測到非投資預算突破。'
  const contextLines = [
    `- 淨資產：${formatTwd(metrics.netWorth)}；現金水位：${metrics.cashReserveMonths} 個月；FIRE 進度：${metrics.fireProgress}%。`,
    `- 投資佔比：${metrics.investmentRatio}%；月現金流：${formatTwd(metrics.netMonthlyCashFlow)}。`,
    breachLines,
  ].join('\n')

  return `
# LifeOS 戰術晨報：${dateStr}

## 昨日財務檢討
${contextLines}

## 核心資產夜間異動
${marketIntel || 'OpenClaw 未取得可用外部情報；今日以本地持倉、預算防線與現金流紀律為主。'}

## 背景辯論逐字稿摘要

### Agent Alpha / OpenClaw 情報激進派
${debate.alphaProposal}

### Agent Beta / MiroFish 風控保守派
${debate.betaRebuttal}

### Agent Prime / NEXUS 總裁決
${debate.primeDecision}

## 今日最高優先級 FIRE 變現任務
${wikiContext
    ? '- Obsidian 已提供本地技能/專案線索。今日只推進能被展示、報價、交付的 HERMES / AI Agent 變現模組。'
    : '- Obsidian 暫無可用線索。今日以 HERMES 閘道器或 AI Agent MVP 做最低成本變現驗證。'}
- 所有投資判定僅作研究與紙上推演，不作真實交易指令。
`.trim()
}

lifeOsRoutes.get('/api/hermes/life-os/state', async (ctx) => {
  try {
    ctx.body = buildStateResponse(readLifeOsState())
  } catch (err: any) {
    ctx.status = 500
    ctx.body = {
      error: err?.message || 'Failed to read Life OS state',
      code: err?.code || 'life_os_state_read_failed',
      path: lifeOsStatePath(),
    }
  }
})

lifeOsRoutes.put('/api/hermes/life-os/state', async (ctx) => {
  try {
    const body = ctx.request.body as { state?: unknown } | undefined
    const nextState = normalizeLifeOsState(body?.state ?? body)
    writeLifeOsState(nextState)
    ctx.body = buildStateResponse(nextState)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = {
      error: err?.message || 'Failed to save Life OS state',
      code: err?.code || 'life_os_state_write_failed',
      path: lifeOsStatePath(),
    }
  }
})

lifeOsRoutes.post('/api/hermes/life-os/refresh-prices', async (ctx) => {
  try {
    const body = ctx.request.body as { state?: unknown } | undefined
    const sourceState = body?.state ? normalizeLifeOsState(body.state) : readLifeOsState()
    const result = await refreshLifeOsPrices(sourceState)
    writeLifeOsState(result.state)
    const response: LifeOsPriceRefreshResponse = {
      updatedAt: new Date().toISOString(),
      state: buildStateResponse(result.state),
      updates: result.updates,
    }
    ctx.body = response
  } catch (err: any) {
    ctx.status = 500
    ctx.body = {
      error: err?.message || 'Failed to refresh Life OS prices',
      code: err?.code || 'life_os_price_refresh_failed',
    }
  }
})

lifeOsRoutes.get('/api/hermes/life-os/export', async (ctx) => {
  try {
    ctx.body = buildBackupPayload()
  } catch (err: any) {
    ctx.status = 500
    ctx.body = {
      error: err?.message || 'Failed to export Life OS backup',
      code: err?.code || 'life_os_backup_export_failed',
    }
  }
})

lifeOsRoutes.post('/api/hermes/life-os/backups', async (ctx) => {
  try {
    const payload = buildBackupPayload()
    const safeTimestamp = payload.exportedAt.replace(/[:.]/g, '-')
    const fileName = `life-os-backup-${safeTimestamp}.json`
    const filePath = resolve(lifeOsBackupDir(), fileName)
    ensureBackupDir()
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
    ctx.status = 201
    ctx.body = {
      exportedAt: payload.exportedAt,
      fileName,
      path: filePath,
      backup: payload,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = {
      error: err?.message || 'Failed to create Life OS backup',
      code: err?.code || 'life_os_backup_create_failed',
    }
  }
})

lifeOsRoutes.post('/api/hermes/generate-briefing', async (ctx) => {
  try {
    const body = ctx.request.body as { date?: string } | undefined
    const dateStr = body?.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : currentDateKey()
    const state = buildStateResponse(readLifeOsState())
    const watchSymbols = getBriefingWatchSymbols(state)

    const [marketIntelResult, wikiResult] = await Promise.allSettled([
      buildBriefingMarketIntel(watchSymbols),
      searchWIKI(['副業', '變現', 'SaaS', '接案', 'HERMES', 'AI Agent', '投資紀律', '風控'], 2800),
    ])
    const marketIntel = marketIntelResult.status === 'fulfilled' ? marketIntelResult.value : ''
    const wikiContext = wikiResult.status === 'fulfilled' ? wikiResult.value : ''

    if (marketIntelResult.status === 'rejected') {
      console.warn('[life-os] Briefing market intel skipped:', marketIntelResult.reason)
    }
    if (wikiResult.status === 'rejected') {
      console.warn('[life-os] Briefing wiki context skipped:', wikiResult.reason)
    }

    let mode: 'hermes-gateway' | 'custom-provider' | 'local-fallback' = 'hermes-gateway'
    let content: string
    let debate: StrategicDebateResult | null = null

    try {
      debate = await runStrategicDebate(
        buildDebatePortfolioPayload(state),
        {
          openClawMarketIntel: marketIntel,
          obsidianWikiContext: wikiContext,
        },
        buildDebateFinancialPayload(state),
      )
      content = buildDebateBriefingMarkdown(dateStr, state, marketIntel, wikiContext, debate)
      mode = debate.mode
    } catch (error) {
      mode = 'local-fallback'
      console.warn('[life-os] Strategic debate fallback:', error instanceof Error ? error.message : error)
      debate = buildLocalStrategicDebate(state, marketIntel)
      content = buildDebateBriefingMarkdown(dateStr, state, marketIntel, wikiContext, debate)
    }

    const written = await writeDailyBriefing(dateStr, content)
    ctx.status = written ? 201 : 200
    ctx.body = {
      success: written && mode !== 'local-fallback',
      ok: written,
      date: dateStr,
      mode,
      watchSymbols,
      marketIntelFound: Boolean(marketIntel),
      wikiContextFound: Boolean(wikiContext),
      debateFound: Boolean(debate),
      debateFeed: debate
        ? {
            alpha: debate.alphaProposal,
            beta: debate.betaRebuttal,
            prime: debate.primeDecision,
          }
        : null,
      debate,
      content,
    }
  } catch (err: any) {
    const fallbackDebate = buildDisconnectedDebate()
    ctx.status = 200
    ctx.body = {
      success: false,
      ok: false,
      date: currentDateKey(),
      mode: 'local-fallback',
      watchSymbols: [],
      marketIntelFound: false,
      wikiContextFound: false,
      debateFound: true,
      debateFeed: {
        alpha: fallbackDebate.alphaProposal,
        beta: fallbackDebate.betaRebuttal,
        prime: fallbackDebate.primeDecision,
      },
      debate: fallbackDebate,
      content: buildDebateBriefingMarkdown(currentDateKey(), buildStateResponse(normalizeLifeOsState({})), '', '', fallbackDebate),
      error: err?.message || 'Failed to generate Life OS briefing',
      code: err?.code || 'life_os_briefing_generate_failed',
    }
  }
})

lifeOsRoutes.get('/api/hermes/life-os/monthly-settlements', async (ctx) => {
  try {
    const items = readMonthlySettlements().sort((a, b) => b.month.localeCompare(a.month))
    const month = currentMonthKey()
    ctx.body = {
      currentMonth: month,
      currentMonthClosed: items.some((item) => item.month === month),
      latest: items[0] || null,
      items,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = {
      error: err?.message || 'Failed to read Life OS monthly settlements',
      code: err?.code || 'life_os_monthly_settlement_read_failed',
      path: monthlySettlementPath(),
    }
  }
})

lifeOsRoutes.post('/api/hermes/life-os/monthly-settlements', async (ctx) => {
  try {
    const month = currentMonthKey()
    const items = readMonthlySettlements()
    const existing = items.find((item) => item.month === month)
    if (existing) {
      ctx.status = 409
      ctx.body = {
        error: `${month} settlement already exists`,
        code: 'life_os_monthly_settlement_exists',
        currentMonth: month,
        settlement: existing,
      }
      return
    }

    const body = ctx.request.body as { state?: LifeOsState } | undefined
    const state = body?.state ? body.state : readLifeOsState()
    const settlement = buildMonthlySettlement(state, month)
    const nextItems = [...items, settlement].sort((a, b) => b.month.localeCompare(a.month))
    writeMonthlySettlements(nextItems)

    ctx.status = 201
    ctx.body = {
      currentMonth: month,
      currentMonthClosed: true,
      settlement,
      items: nextItems,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = {
      error: err?.message || 'Failed to create Life OS monthly settlement',
      code: err?.code || 'life_os_monthly_settlement_create_failed',
      path: monthlySettlementPath(),
    }
  }
})

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  createLifeOsMonthlySettlement,
  createLifeOsBackup,
  generateLifeOsBriefing,
  getLifeOsMonthlySettlements,
  getLifeOsState,
  refreshLifeOsPrices,
  updateLifeOsState,
  type LifeOsBudgetAccount,
  type LifeOsBudgetCategory,
  type LifeOsBudgetCategoryMetric,
  type LifeOsBudgeting,
  type LifeOsBudgetMetrics,
  type LifeOsBudgetTransaction,
  type LifeOsComputedMetrics,
  type LifeOsDebateFeed,
  type LifeOsEvolution,
  type LifeOsLifeScores,
  type LifeOsMarketKind,
  type LifeOsMarketSettings,
  type LifeOsMonthlySettlement,
  type LifeOsMonthlySettlementList,
  type LifeOsPriceUpdate,
  type LifeOsState,
  type LifeOsStockItem,
  type LifeOsStockMetrics,
} from '@/api/hermes/life-os'
import { evaluateNexus, type NexusEvaluateResponse } from '@/api/hermes/nexus'

type MacroRegime = 'Risk-On' | 'Chop' | 'Risk-Off'

interface LoanRuntime {
  name: string
  monthlyPayment: number
  interestRate: number
}

interface DailyExpenseForm {
  date: string
  categoryId: string
  payee: string
  amount: number
  note: string
}

type DailyEntryMode = 'expense' | 'income'

interface CalendarDay {
  key: string
  date: string
  day: number
  isCurrentMonth: boolean
  isToday: boolean
  income: number
  expense: number
  transferOut: number
  net: number
  count: number
}

interface DeletedTransactionSnapshot {
  transaction: LifeOsBudgetTransaction
  index: number
  accountId: string
}

const props = withDefaults(defineProps<{
  macroRegime?: string | null
  macroInsight?: string | null
  embedded?: boolean
}>(), {
  macroRegime: null,
  macroInsight: null,
  embedded: false,
})

const ANNUAL_RETURN_RATE = 0.08
const BASELINE_MONTHLY_EXPENSE = 35000
const RECENT_TRANSACTION_LIMIT = 10
const BUDGET_WARNING_RATIO = 0.9

const DEFAULT_LIFE_OS_STATE: LifeOsState = {
  identity: {
    name: '賴郁凱',
    birthdate: '1988-02-17',
    astrology: '水瓶座',
    chineseZodiac: '龍',
    gender: '男',
    occupation: '系統架構師',
  },
  financialState: {
    cashAndLiquidity: {
      twdAvailable: 80000,
      twdFixedReserve: 100000,
      foreignCurrencyReserve: 53897,
    },
    investmentEquity: {
      domesticStocks: [
        { symbol: '2330', name: '台積電', shares: 500, costBasis: 650, currentPrice: 840 },
      ],
      usStocks: [
        { symbol: 'NVDA', name: 'NVIDIA', shares: 40, costBasis: 450, currentPrice: 950 },
        { symbol: 'AAPL', name: 'Apple', shares: 15, costBasis: 170, currentPrice: 180 },
      ],
    },
    liabilities: {
      loanTotal: 783565,
    },
    monthlyInflow: {
      totalIncome: 70000,
    },
    monthlyOutflow: {
      fixedEssential: 20000,
      discretionaryLiving: 8000,
      subscriptionsAndEducation: 3000,
      annualExpenseAmortized: 4000,
    },
  },
  marketSettings: {
    usdTwdRate: 32,
    usdTwdSource: 'default',
    updatedAt: '',
  },
  budgeting: {
    month: '2026-05',
    accounts: [
      { id: 'cash-main', name: '主要活存', type: '活存', balance: 80000 },
      { id: 'cash-reserve', name: '固定儲備', type: '定存', balance: 100000 },
      { id: 'fx-reserve', name: '外幣儲備', type: '外幣', balance: 53897 },
      { id: 'brokerage-cash', name: '證券戶市值', type: '證券戶', balance: 0 },
    ],
    categories: [
      { id: 'housing', name: '固定必要支出', group: '生活', budgeted: 20000 },
      { id: 'living', name: '彈性生活支出', group: '生活', budgeted: 8000 },
      { id: 'learning', name: '訂閱與教育', group: '成長', budgeted: 3000 },
      { id: 'annual', name: '年費攤提', group: '準備金', budgeted: 4000 },
      { id: 'investing', name: '投資補給', group: '資產', budgeted: 15000 },
    ],
    transactions: [
      { id: 'tx-202605-001', date: '2026-05-01', accountId: 'cash-main', categoryId: 'housing', payee: '房租與固定帳單', amount: -20000, note: '固定支出' },
      { id: 'tx-202605-002', date: '2026-05-05', accountId: 'cash-main', categoryId: 'learning', payee: 'AI / 金融工具訂閱', amount: -1800, note: '生產力與研究' },
      { id: 'tx-202605-003', date: '2026-05-12', accountId: 'cash-main', categoryId: 'living', payee: '生活採買', amount: -3200, note: '日常支出' },
      { id: 'tx-202605-004', date: '2026-05-25', accountId: 'cash-main', categoryId: 'income', payee: '主業收入', amount: 70000, note: '月收入入帳' },
    ],
  },
  evolution: {
    learningQuests: [
      { id: 'q1', title: '閱讀《投資心理學》', category: '學習', expectedImpact: '投資紀律 +2', status: '進行中' },
      { id: 'q2', title: '建立 AI 工具副業 MVP', category: '副業', expectedImpact: '創業準備 +5', status: '未開始' },
    ],
    skills: [
      { name: 'AI 系統整合', level: 85 },
      { name: '量化風控', level: 60 },
    ],
  },
  lifeScores: {
    finance: 72,
    discipline: 65,
    learning: 58,
    business: 41,
    retirement: 18,
  },
  targetMonthlyPassiveIncome: 1000,
  computedMetrics: {
    totalCash: 233897,
    totalStocks: 460700,
    totalAssets: 694597,
    netWorth: -88968,
    totalExpenses: 35000,
    investmentTransfers: 0,
    netMonthlyCashFlow: 35000,
    cashReserveMonths: 6.7,
    investmentRatio: 66.32,
    usdTwdRate: 32,
    domesticStocksTwd: 420000,
    usStocksTwd: 1302400,
    fireTarget: 300000,
    fireProgress: -29.66,
    budgetMetrics: {
      totalBudgeted: 50000,
      totalSpent: 25000,
      operatingSpent: 25000,
      transferSpent: 0,
      totalRemaining: 25000,
      availableToBudget: 183897,
      categories: [
        { id: 'housing', name: '固定必要支出', group: '生活', budgeted: 20000, spent: 20000, remaining: 0 },
        { id: 'living', name: '彈性生活支出', group: '生活', budgeted: 8000, spent: 3200, remaining: 4800 },
        { id: 'learning', name: '訂閱與教育', group: '成長', budgeted: 3000, spent: 1800, remaining: 1200 },
        { id: 'annual', name: '年費攤提', group: '準備金', budgeted: 4000, spent: 0, remaining: 4000 },
        { id: 'investing', name: '投資補給', group: '資產', budgeted: 15000, spent: 0, remaining: 15000 },
      ],
    },
    domesticStockMetrics: {
      items: [
        { symbol: '2330', name: '台積電', shares: 500, costBasis: 650, currentPrice: 840, marketValue: 420000, gainLoss: 95000, gainLossPct: 29.23, currency: 'TWD', fxRate: 1, marketValueTwd: 420000, costTwd: 325000, gainLossTwd: 95000 },
      ],
      currency: 'TWD',
      fxRate: 1,
      totalMarketValue: 420000,
      totalCost: 325000,
      totalGainLoss: 95000,
      totalGainLossPct: 29.23,
      totalMarketValueTwd: 420000,
      totalCostTwd: 325000,
      totalGainLossTwd: 95000,
    },
    usStockMetrics: {
      items: [
        { symbol: 'NVDA', name: 'NVIDIA', shares: 40, costBasis: 450, currentPrice: 950, marketValue: 38000, gainLoss: 20000, gainLossPct: 111.11, currency: 'USD', fxRate: 32, marketValueTwd: 1216000, costTwd: 576000, gainLossTwd: 640000 },
        { symbol: 'AAPL', name: 'Apple', shares: 15, costBasis: 170, currentPrice: 180, marketValue: 2700, gainLoss: 150, gainLossPct: 5.88, currency: 'USD', fxRate: 32, marketValueTwd: 86400, costTwd: 81600, gainLossTwd: 4800 },
      ],
      currency: 'USD',
      fxRate: 32,
      totalMarketValue: 40700,
      totalCost: 20550,
      totalGainLoss: 20150,
      totalGainLossPct: 98.05,
      totalMarketValueTwd: 1302400,
      totalCostTwd: 657600,
      totalGainLossTwd: 644800,
    },
  },
}

const lifeOsState = reactive<LifeOsState>(cloneState(DEFAULT_LIFE_OS_STATE))
const loanRuntime = reactive<LoanRuntime>({
  name: '主要貸款',
  monthlyPayment: 0,
  interestRate: 0,
})
const currentTime = ref(new Date())
const loading = ref(false)
const loadError = ref('')
const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
const saveError = ref('')
const lastSavedAt = ref<Date | null>(null)
const monthlySettlementState = ref<'idle' | 'loading' | 'closing' | 'closed' | 'error'>('idle')
const monthlySettlementError = ref('')
const monthlySettlementList = ref<LifeOsMonthlySettlementList | null>(null)
const monthlyEditUnlocked = ref(false)
const backupState = ref<'idle' | 'creating' | 'created' | 'error'>('idle')
const backupMessage = ref('')
const priceRefreshState = ref<'idle' | 'loading' | 'updated' | 'partial' | 'error'>('idle')
const priceRefreshMessage = ref('')
const priceRefreshUpdates = ref<LifeOsPriceUpdate[]>([])
const nexusState = ref<'idle' | 'thinking' | 'ready' | 'error'>('idle')
const nexusAdvice = ref('')
const displayedNexusAdvice = ref('')
const nexusError = ref('')
const nexusResult = ref<NexusEvaluateResponse | null>(null)
const briefingState = ref<'idle' | 'generating' | 'ready' | 'error'>('idle')
const briefingError = ref('')
const debateFeed = ref<LifeOsDebateFeed | null>(null)
const displayedDebateFeed = reactive<LifeOsDebateFeed>({
  alpha: '',
  beta: '',
  prime: '',
})
const dailyExpenseForm = reactive<DailyExpenseForm>({
  date: todayKey(),
  categoryId: 'living',
  payee: '',
  amount: 0,
  note: '',
})
const dailyEntryMode = ref<DailyEntryMode>('expense')
const selectedCalendarDate = ref(todayKey())
const pendingDeleteTransactionId = ref<string | null>(null)
const deletedTransactionSnapshot = ref<DeletedTransactionSnapshot | null>(null)

let clockTimer: number | null = null
let saveTimer: number | null = null
let undoTimer: number | null = null
let nexusTimer: number | null = null
let nexusTypeTimer: number | null = null
let debateTypeTimer: number | null = null
let hasLoadedState = false
let monthlyIncomeBaseline = numberOrZero(DEFAULT_LIFE_OS_STATE.financialState.monthlyInflow.totalIncome)
let incomeReconciliationPending = false
let brokerageSyncPending = false

const GATEWAY_ERROR_PATTERN = /NoneType|object is not iterable|Traceback|TypeError|ValueError|Internal Server Error|HTTP\s*500|\b500\b/i

const metrics = computed(() => computeMetricsFromState(lifeOsState))
const netWorth = computed(() => metrics.value.netWorth)
const totalIncome = computed(() => numberOrZero(lifeOsState.financialState.monthlyInflow.totalIncome))
const actualMonthlySpent = computed(() => metrics.value.budgetMetrics.operatingSpent)
const monthlySurplus = computed(() => totalIncome.value - actualMonthlySpent.value)
const savingsRate = computed(() => {
  if (totalIncome.value <= 0) return 0
  return round((monthlySurplus.value / totalIncome.value) * 100, 1)
})
const fireMetrics = computed(() => {
  const currentNetWorth = metrics.value.netWorth || 0
  const monthlyExpenses = metrics.value.totalExpenses || BASELINE_MONTHLY_EXPENSE
  const monthlyInvestment = metrics.value.netMonthlyCashFlow || 0
  const totalCash = metrics.value.totalCash || 0
  const targetAmount = monthlyExpenses * 12 * 25
  const progress = Math.max((currentNetWorth / targetAmount) * 100, 0)
  let yearsRemaining = '計算中...'

  if (currentNetWorth >= targetAmount) {
    yearsRemaining = '0.0'
  } else if (totalCash < 0) {
    yearsRemaining = '∞ (現金流斷裂)'
  } else if (monthlyInvestment <= 0) {
    yearsRemaining = '∞ (現金流斷裂)'
  } else {
    const monthlyReturnRate = ANNUAL_RETURN_RATE / 12
    let currentCapital = currentNetWorth
    let months = 0
    const maxMonths = 1200

    while (currentCapital < targetAmount && months < maxMonths) {
      currentCapital = currentCapital * (1 + monthlyReturnRate) + monthlyInvestment
      months += 1
    }

    yearsRemaining = months >= maxMonths ? '> 100' : (months / 12).toFixed(1)
  }

  return {
    targetAmount,
    progressPct: progress.toFixed(2),
    yearsRemaining,
  }
})
const fireYearsLabel = computed(() => {
  const years = fireMetrics.value.yearsRemaining
  if (years.includes('∞') || years.includes('計算中')) return years
  return `${years} 年`
})
const fireProgressWidth = computed(() => clamp(Number(fireMetrics.value.progressPct), 0, 100))
const basicExpenseMonths = computed(() => {
  return metrics.value.cashReserveMonths
})
const cashDebtAccounts = computed(() =>
  lifeOsState.budgeting.accounts.filter((account) => isLiquidityAccount(account) || isBrokerageAccount(account)),
)
const budgetRows = computed(() => metrics.value.budgetMetrics.categories)
const warningBudgetRows = computed(() => budgetRows.value.filter((category) => (
  !isTransferBudgetCategory(category)
  && category.remaining >= 0
  && category.budgeted > 0
  && category.spent / category.budgeted >= BUDGET_WARNING_RATIO
)))
const breachedBudgetRows = computed(() => budgetRows.value.filter((category) => (
  !isTransferBudgetCategory(category) && category.remaining < 0
)))
const dailyExpenseReady = computed(() =>
  numberOrZero(dailyExpenseForm.amount) > 0 && (dailyEntryMode.value === 'income' || dailyExpenseForm.categoryId.length > 0),
)
const quickEntryHint = computed(() =>
  dailyEntryMode.value === 'income' ? '送出後自動加到主要活存' : '送出後自動扣主要活存',
)
const quickEntryButtonLabel = computed(() => {
  if (isMonthLocked.value) return '本月已鎖定'
  return dailyEntryMode.value === 'income' ? '新增收入' : '新增開銷'
})
const quickEntryPayeePlaceholder = computed(() =>
  dailyEntryMode.value === 'income' ? '例如：薪資 / 副業 / 股息' : '例如：午餐 / 咖啡 / 捷運',
)
const recentTransactions = computed(() =>
  [...lifeOsState.budgeting.transactions]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, RECENT_TRANSACTION_LIMIT),
)
const calendarMonthLabel = computed(() => lifeOsState.budgeting.month || todayKey().slice(0, 7))
const selectedDateTransactions = computed(() =>
  lifeOsState.budgeting.transactions.filter((transaction) => transaction.date === selectedCalendarDate.value),
)
const selectedDateNet = computed(() =>
  selectedDateTransactions.value.reduce((sum, transaction) => sum + numberOrZero(transaction.amount), 0),
)
const calendarDays = computed<CalendarDay[]>(() => {
  const { year, monthIndex } = monthParts(calendarMonthLabel.value)
  const today = todayKey()
  const firstDay = new Date(year, monthIndex, 1)
  const startDate = new Date(year, monthIndex, 1 - firstDay.getDay())

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(startDate)
    date.setDate(startDate.getDate() + index)
    const key = formatDateKey(date)
    const transactions = transactionsForDate(key)
    const income = transactions
      .filter((transaction) => transaction.amount > 0)
      .reduce((sum, transaction) => sum + numberOrZero(transaction.amount), 0)
    const expense = transactions
      .filter(isOperatingExpenseTransaction)
      .reduce((sum, transaction) => sum + Math.abs(numberOrZero(transaction.amount)), 0)
    const transferOut = transactions
      .filter(isTransferOutTransaction)
      .reduce((sum, transaction) => sum + Math.abs(numberOrZero(transaction.amount)), 0)

    return {
      key: `${key}-${index}`,
      date: key,
      day: date.getDate(),
      isCurrentMonth: date.getMonth() === monthIndex,
      isToday: key === today,
      income,
      expense,
      transferOut,
      net: income - expense - transferOut,
      count: transactions.length,
    }
  })
})
const nexusSignals = computed(() => {
  const signals: string[] = []
  if (breachedBudgetRows.value.length > 0) {
    for (const category of breachedBudgetRows.value) {
      const overrun = Math.abs(category.remaining)
      if (category.id === 'living') {
        signals.push(`[系統警告] 彈性生活防線崩潰，超支 ${formatMoney(overrun)}。`)
        signals.push('[戰術指令] 你為了短暫的口腹之慾破壞了本月的儲蓄紀律。立刻停止消費，本週末的聚餐全部取消，在家推進你的 HERMES 閘道器專案以彌補虧空。')
      } else {
        signals.push(`[系統警告] ${category.name} 預算防線被突破，超支 ${formatMoney(overrun)}。`)
        signals.push('[戰術指令] 暫停同類支出，先用本週可控時間補回現金流缺口。')
      }
    }
  } else if (warningBudgetRows.value.length > 0) {
    signals.push(`預算黃燈：${warningBudgetRows.value.map((category) => category.name).join(' / ')} 已接近上限，下一筆同類支出需先確認必要性。`)
  }
  if (metrics.value.investmentTransfers > 0) {
    signals.push(`本月投資轉倉 ${formatMoney(metrics.value.investmentTransfers)}，已排除在生活開銷與 FIRE 消耗率之外。`)
  }
  if (basicExpenseMonths.value < 6) {
    signals.push(`現金水位 ${basicExpenseMonths.value.toFixed(1)} 個月，低於 6 個月防線。`)
  }
  if (metrics.value.budgetMetrics.availableToBudget < 0) {
    signals.push('已分配預算超過可用現金，需回收部分 envelope。')
  }
  if (signals.length === 0) {
    signals.push('現金流與預算分配穩定，維持月結與投資補給節奏。')
  }
  return signals
})
const portfolioSections = computed(() => [
  {
    label: '台股',
    market: 'domestic' as LifeOsMarketKind,
    defaultSymbol: '2330',
    rows: lifeOsState.financialState.investmentEquity.domesticStocks,
  },
  {
    label: '美股',
    market: 'us' as LifeOsMarketKind,
    defaultSymbol: 'NEW',
    rows: lifeOsState.financialState.investmentEquity.usStocks,
  },
])
const priceRefreshStatusLabel = computed(() => {
  if (priceRefreshState.value === 'loading') return '更新中'
  if (priceRefreshState.value === 'updated') return priceRefreshMessage.value || '現價已更新'
  if (priceRefreshState.value === 'partial') return priceRefreshMessage.value || '部分更新'
  if (priceRefreshState.value === 'error') return priceRefreshMessage.value || '更新失敗'
  return priceRefreshMessage.value || '現價來源 Yahoo Chart'
})
const normalizedMacroRegime = computed<MacroRegime>(() => {
  const raw = String(props.macroRegime || '').toLowerCase()
  if (raw.includes('risk-off') || raw.includes('避險')) return 'Risk-Off'
  if (raw.includes('risk-on') || raw.includes('偏好')) return 'Risk-On'
  return 'Chop'
})
const systemTime = computed(() =>
  currentTime.value.toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
)
const saveStatusLabel = computed(() => {
  if (saveState.value === 'saving') return '儲存中'
  if (saveState.value === 'error') return '儲存失敗'
  if (saveState.value === 'saved') {
    const savedAt = lastSavedAt.value?.toLocaleTimeString('zh-TW', { hour12: false })
    return savedAt ? `已儲存 ${savedAt}` : '已儲存'
  }
  return '本機編輯'
})
const nexusSourceTags = computed(() => {
  const result = nexusResult.value
  const tags = ['LifeOS JSON']
  if (result?.knowledgeContextFound) tags.push('Obsidian WIKI')
  if (result?.openClawContextFound) tags.push('OpenClaw')
  if (result?.mode === 'local-fallback') tags.push('Local fallback')
  if (result?.mode === 'hermes-gateway') tags.push('Hermes Gateway')
  if (result?.mode === 'custom-provider') tags.push('Custom Provider')
  if (!result && nexusState.value === 'idle') tags.push('Local rules')
  return [...new Set(tags)]
})
const nexusStatusLabel = computed(() => {
  if (briefingState.value === 'generating') return '晨報辯論中'
  if (briefingState.value === 'ready') return '晨報已生成'
  if (briefingState.value === 'error') return '晨報生成失敗'
  if (nexusState.value === 'thinking') return 'NEXUS 推演中'
  if (nexusState.value === 'error') return 'NEXUS 連線失敗'
  if (nexusState.value === 'ready') return 'NEXUS 已更新'
  return '本機規則待命'
})
const hasValidDebateFeed = computed(() => isValidDebateFeed(debateFeed.value))
const latestMonthlySettlement = computed<LifeOsMonthlySettlement | null>(() =>
  monthlySettlementList.value?.latest || null,
)
const currentMonthLabel = computed(() =>
  monthlySettlementList.value?.currentMonth || lifeOsState.budgeting.month || systemTime.value.slice(0, 7),
)
const currentMonthClosed = computed(() =>
  Boolean(monthlySettlementList.value?.currentMonthClosed),
)
const isMonthLocked = computed(() => currentMonthClosed.value && !monthlyEditUnlocked.value)
const monthlySettlementStatusLabel = computed(() => {
  if (monthlySettlementState.value === 'loading') return '讀取月結'
  if (monthlySettlementState.value === 'closing') return '封存中'
  if (isMonthLocked.value) return '本月已鎖定'
  if (currentMonthClosed.value) return '本月已結算'
  if (monthlySettlementState.value === 'error') return '月結失敗'
  return '等待月結'
})
const selectedDateIncome = computed(() =>
  selectedDateTransactions.value
    .filter((transaction) => transaction.amount > 0)
    .reduce((sum, transaction) => sum + numberOrZero(transaction.amount), 0),
)
const selectedDateExpense = computed(() =>
  selectedDateTransactions.value
    .filter(isOperatingExpenseTransaction)
    .reduce((sum, transaction) => sum + Math.abs(numberOrZero(transaction.amount)), 0),
)
const selectedDateTransferOut = computed(() =>
  selectedDateTransactions.value
    .filter(isTransferOutTransaction)
    .reduce((sum, transaction) => sum + Math.abs(numberOrZero(transaction.amount)), 0),
)
const selectedDateTransactionCount = computed(() => selectedDateTransactions.value.length)
const backupStatusLabel = computed(() => {
  if (backupState.value === 'creating') return '備份中'
  if (backupState.value === 'created') return backupMessage.value || '備份完成'
  if (backupState.value === 'error') return backupMessage.value || '備份失敗'
  return '建立備份'
})

function cloneState(state: LifeOsState): LifeOsState {
  return JSON.parse(JSON.stringify(state)) as LifeOsState
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function monthParts(monthKey: string): { year: number, monthIndex: number } {
  const [rawYear, rawMonth] = String(monthKey || '').split('-')
  const current = new Date()
  const year = Number.parseInt(rawYear || '', 10)
  const month = Number.parseInt(rawMonth || '', 10)

  return {
    year: Number.isFinite(year) ? year : current.getFullYear(),
    monthIndex: Number.isFinite(month) && month >= 1 && month <= 12 ? month - 1 : current.getMonth(),
  }
}

function transactionsForDate(date: string): LifeOsBudgetTransaction[] {
  return lifeOsState.budgeting.transactions.filter((transaction) => transaction.date === date)
}

function categoryForTransaction(transaction: LifeOsBudgetTransaction): LifeOsBudgetCategory | undefined {
  return lifeOsState.budgeting.categories.find((category) => category.id === transaction.categoryId)
}

function isTransferOutTransaction(transaction: LifeOsBudgetTransaction): boolean {
  return transaction.amount < 0 && isTransferBudgetCategory(categoryForTransaction(transaction))
}

function isOperatingExpenseTransaction(transaction: LifeOsBudgetTransaction): boolean {
  return transaction.amount < 0 && !isTransferOutTransaction(transaction)
}

function selectCalendarDate(date: string): void {
  selectedCalendarDate.value = date
  dailyExpenseForm.date = date
}

function eventValue(event: Event): string {
  return event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
    ? event.target.value
    : ''
}

function syncMonthlyIncomeBaseline(): void {
  monthlyIncomeBaseline = numberOrZero(lifeOsState.financialState.monthlyInflow.totalIncome)
}

function monthlyIncomeTransaction(): LifeOsBudgetTransaction | undefined {
  const month = currentMonthLabel.value
  return lifeOsState.budgeting.transactions.find((transaction) =>
    transaction.categoryId === 'income' &&
    transaction.date.startsWith(month) &&
    (transaction.payee === '主業收入' || transaction.id.startsWith(`tx-income-${month}`)),
  )
}

function monthlyIncomeLedgerAmount(): number {
  const month = currentMonthLabel.value
  return lifeOsState.budgeting.transactions
    .filter((transaction) => transaction.categoryId === 'income' && transaction.date.startsWith(month))
    .reduce((sum, transaction) => sum + Math.max(0, numberOrZero(transaction.amount)), 0)
}

function upsertMonthlyIncomeTransaction(amount: number): void {
  const nextAmount = round(Math.max(0, numberOrZero(amount)), 2)
  const account = primaryCashAccount()
  const month = currentMonthLabel.value
  const existing = monthlyIncomeTransaction()

  if (existing) {
    existing.accountId = account.id
    existing.categoryId = 'income'
    existing.amount = nextAmount
    existing.payee = '主業收入'
    existing.note = '主業收入入帳'
    if (!existing.date.startsWith(month)) existing.date = `${month}-01`
    return
  }

  if (nextAmount <= 0) return
  lifeOsState.budgeting.transactions.unshift({
    id: `tx-income-${month}`,
    date: todayKey(),
    accountId: account.id,
    categoryId: 'income',
    payee: '主業收入',
    amount: nextAmount,
    note: '主業收入入帳',
  })
}

function reconcileMonthlyIncomeLedger(): boolean {
  const income = round(Math.max(0, numberOrZero(lifeOsState.financialState.monthlyInflow.totalIncome)), 2)
  const ledgeredIncome = round(monthlyIncomeLedgerAmount(), 2)
  const missingIncome = round(income - ledgeredIncome, 2)
  if (missingIncome <= 0) return false

  const account = primaryCashAccount()
  account.balance = round(numberOrZero(account.balance) + missingIncome, 2)
  lifeOsState.budgeting.transactions.unshift({
    id: `tx-income-reconcile-${currentMonthLabel.value}-${Date.now()}`,
    date: todayKey(),
    accountId: account.id,
    categoryId: 'income',
    payee: '主業收入',
    amount: missingIncome,
    note: '收入欄位補齊入帳；由 Life OS 複式簿記同步建立',
  })

  return true
}

function applyMonthlyIncomeChange(nextValue: string | number): void {
  if (isMonthLocked.value) return
  const nextIncome = round(Math.max(0, numberOrZero(typeof nextValue === 'string' ? Number(nextValue) : nextValue)), 2)
  const delta = round(nextIncome - monthlyIncomeBaseline, 2)

  lifeOsState.financialState.monthlyInflow.totalIncome = nextIncome
  if (delta !== 0) {
    const account = primaryCashAccount()
    account.balance = round(numberOrZero(account.balance) + delta, 2)
  }
  upsertMonthlyIncomeTransaction(nextIncome)
  monthlyIncomeBaseline = nextIncome
}

function normalizeStock(stock: Partial<LifeOsStockItem>): LifeOsStockItem {
  return {
    symbol: String(stock.symbol || '').trim(),
    name: String(stock.name || '').trim(),
    shares: numberOrZero(stock.shares),
    costBasis: numberOrZero(stock.costBasis),
    currentPrice: numberOrZero(stock.currentPrice),
  }
}

function normalizeBudgetAccount(account: Partial<LifeOsBudgetAccount>, index: number): LifeOsBudgetAccount {
  return {
    id: String(account.id || `account-${index + 1}`),
    name: String(account.name || '').trim() || '未命名帳戶',
    type: String(account.type || '').trim() || '活存',
    balance: numberOrZero(account.balance),
  }
}

function normalizeBudgetCategory(category: Partial<LifeOsBudgetCategory>, index: number): LifeOsBudgetCategory {
  return {
    id: String(category.id || `category-${index + 1}`),
    name: String(category.name || '').trim() || '未命名分類',
    group: String(category.group || '').trim() || '生活',
    budgeted: numberOrZero(category.budgeted),
  }
}

function normalizeBudgetTransaction(transaction: Partial<LifeOsBudgetTransaction>, index: number): LifeOsBudgetTransaction {
  return {
    id: String(transaction.id || `tx-${index + 1}`),
    date: String(transaction.date || new Date().toISOString().slice(0, 10)),
    accountId: String(transaction.accountId || ''),
    categoryId: String(transaction.categoryId || ''),
    payee: String(transaction.payee || ''),
    amount: numberOrZero(transaction.amount),
    note: String(transaction.note || ''),
  }
}

function normalizeMarketSettings(settings: Partial<LifeOsMarketSettings> | undefined): LifeOsMarketSettings {
  const usdTwdRate = numberOrZero(settings?.usdTwdRate)
  return {
    usdTwdRate: usdTwdRate > 0 ? usdTwdRate : 32,
    usdTwdSource: String(settings?.usdTwdSource || 'default'),
    updatedAt: String(settings?.updatedAt || ''),
  }
}

function normalizeBudgeting(budgeting: Partial<LifeOsBudgeting> | undefined): LifeOsBudgeting {
  const fallback = DEFAULT_LIFE_OS_STATE.budgeting
  const accounts = Array.isArray(budgeting?.accounts) && budgeting.accounts.length > 0
    ? budgeting.accounts
    : fallback.accounts
  const categories = Array.isArray(budgeting?.categories) && budgeting.categories.length > 0
    ? budgeting.categories
    : fallback.categories
  const transactions = Array.isArray(budgeting?.transactions)
    ? budgeting.transactions
    : fallback.transactions

  const normalizedAccounts = accounts.map(normalizeBudgetAccount)
  const existingBrokerage = normalizedAccounts.find((account) => account.id === 'brokerage-cash' || account.type === '證券戶')
  if (!existingBrokerage) {
    normalizedAccounts.push({
      id: 'brokerage-cash',
      name: '證券戶市值',
      type: '證券戶',
      balance: 0,
    })
  } else {
    existingBrokerage.type = '證券戶'
    if (!existingBrokerage.name || existingBrokerage.name === '證券戶現金') {
      existingBrokerage.name = '證券戶市值'
    }
  }

  return {
    month: String(budgeting?.month || fallback.month),
    accounts: normalizedAccounts,
    categories: categories.map(normalizeBudgetCategory),
    transactions: transactions.map(normalizeBudgetTransaction),
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

function normalizeEvolution(evolution: Partial<LifeOsEvolution> | undefined): LifeOsEvolution {
  const fallback = DEFAULT_LIFE_OS_STATE.evolution
  return {
    learningQuests: (Array.isArray(evolution?.learningQuests) ? evolution.learningQuests : fallback.learningQuests).map((quest, index) => ({
      id: String(quest?.id || `q${index + 1}`),
      title: String(quest?.title || '').trim() || '未命名任務',
      category: String(quest?.category || '').trim() || '學習',
      expectedImpact: String(quest?.expectedImpact || '').trim() || '紀律 +1',
      status: String(quest?.status || '未開始'),
    })),
    skills: (Array.isArray(evolution?.skills) ? evolution.skills : fallback.skills).map((skill) => ({
      name: String(skill?.name || '').trim() || '未命名技能',
      level: clamp(numberOrZero(skill?.level), 0, 100),
    })),
  }
}

function normalizeLifeScores(scores: Partial<LifeOsLifeScores> | undefined): LifeOsLifeScores {
  const fallback = DEFAULT_LIFE_OS_STATE.lifeScores
  return {
    finance: clamp(numberOrZero(scores?.finance ?? fallback.finance), 0, 100),
    discipline: clamp(numberOrZero(scores?.discipline ?? fallback.discipline), 0, 100),
    learning: clamp(numberOrZero(scores?.learning ?? fallback.learning), 0, 100),
    business: clamp(numberOrZero(scores?.business ?? fallback.business), 0, 100),
    retirement: clamp(numberOrZero(scores?.retirement ?? fallback.retirement), 0, 100),
  }
}

function calculateStockMetrics(stocks: LifeOsStockItem[], currency: 'TWD' | 'USD', fxRate: number): LifeOsStockMetrics {
  let totalMarketValue = 0
  let totalCost = 0
  let totalMarketValueTwd = 0
  let totalCostTwd = 0

  const items = stocks.map((rawStock) => {
    const stock = normalizeStock(rawStock)
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

function computeBudgetMetrics(budgeting: LifeOsBudgeting, totalCash: number): LifeOsBudgetMetrics {
  const spendByCategory = new Map<string, number>()
  const categoryById = new Map(budgeting.categories.map((category) => [category.id, category]))

  for (const transaction of budgeting.transactions) {
    if (transaction.amount >= 0 || !transaction.categoryId) continue
    spendByCategory.set(
      transaction.categoryId,
      numberOrZero(spendByCategory.get(transaction.categoryId)) + Math.abs(transaction.amount),
    )
  }

  const categories: LifeOsBudgetCategoryMetric[] = budgeting.categories.map((category) => {
    const budgeted = Math.round(numberOrZero(category.budgeted))
    const spent = Math.round(numberOrZero(spendByCategory.get(category.id)))
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

function computeMetricsFromState(state: LifeOsState): LifeOsComputedMetrics {
  const { cashAndLiquidity, investmentEquity, liabilities, monthlyInflow, monthlyOutflow } = state.financialState
  const budgeting = normalizeBudgeting(state.budgeting)
  const marketSettings = normalizeMarketSettings(state.marketSettings)
  const domesticStockMetrics = calculateStockMetrics(investmentEquity.domesticStocks, 'TWD', 1)
  const usStockMetrics = calculateStockMetrics(investmentEquity.usStocks, 'USD', marketSettings.usdTwdRate)
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
    usdTwdRate: marketSettings.usdTwdRate,
    domesticStocksTwd,
    usStocksTwd,
    fireTarget,
    fireProgress,
    budgetMetrics,
    domesticStockMetrics,
    usStockMetrics,
  }
}

function assignLifeOsState(next: LifeOsState): void {
  Object.assign(lifeOsState.identity, next.identity || DEFAULT_LIFE_OS_STATE.identity)
  Object.assign(lifeOsState.financialState.cashAndLiquidity, next.financialState?.cashAndLiquidity || DEFAULT_LIFE_OS_STATE.financialState.cashAndLiquidity)
  lifeOsState.financialState.investmentEquity.domesticStocks.splice(
    0,
    lifeOsState.financialState.investmentEquity.domesticStocks.length,
    ...(next.financialState?.investmentEquity?.domesticStocks || DEFAULT_LIFE_OS_STATE.financialState.investmentEquity.domesticStocks).map(normalizeStock),
  )
  lifeOsState.financialState.investmentEquity.usStocks.splice(
    0,
    lifeOsState.financialState.investmentEquity.usStocks.length,
    ...(next.financialState?.investmentEquity?.usStocks || DEFAULT_LIFE_OS_STATE.financialState.investmentEquity.usStocks).map(normalizeStock),
  )
  Object.assign(lifeOsState.financialState.liabilities, next.financialState?.liabilities || DEFAULT_LIFE_OS_STATE.financialState.liabilities)
  Object.assign(lifeOsState.financialState.monthlyInflow, next.financialState?.monthlyInflow || DEFAULT_LIFE_OS_STATE.financialState.monthlyInflow)
  Object.assign(lifeOsState.financialState.monthlyOutflow, next.financialState?.monthlyOutflow || DEFAULT_LIFE_OS_STATE.financialState.monthlyOutflow)
  Object.assign(lifeOsState.marketSettings, normalizeMarketSettings(next.marketSettings || DEFAULT_LIFE_OS_STATE.marketSettings))
  const nextBudgeting = normalizeBudgeting(next.budgeting)
  lifeOsState.budgeting.month = nextBudgeting.month
  lifeOsState.budgeting.accounts.splice(0, lifeOsState.budgeting.accounts.length, ...nextBudgeting.accounts)
  lifeOsState.budgeting.categories.splice(0, lifeOsState.budgeting.categories.length, ...nextBudgeting.categories)
  lifeOsState.budgeting.transactions.splice(0, lifeOsState.budgeting.transactions.length, ...nextBudgeting.transactions)
  brokerageSyncPending = syncBrokerageAccountBalance()
  const nextEvolution = normalizeEvolution(next.evolution)
  lifeOsState.evolution.learningQuests.splice(0, lifeOsState.evolution.learningQuests.length, ...nextEvolution.learningQuests)
  lifeOsState.evolution.skills.splice(0, lifeOsState.evolution.skills.length, ...nextEvolution.skills)
  Object.assign(lifeOsState.lifeScores, normalizeLifeScores(next.lifeScores))
  lifeOsState.targetMonthlyPassiveIncome = numberOrZero(next.targetMonthlyPassiveIncome || DEFAULT_LIFE_OS_STATE.targetMonthlyPassiveIncome)
  Object.assign(lifeOsState.computedMetrics, computeMetricsFromState(lifeOsState))
  incomeReconciliationPending = reconcileMonthlyIncomeLedger()
  syncMonthlyIncomeBaseline()
}

async function loadLifeOsState(): Promise<void> {
  loading.value = true
  loadError.value = ''
  hasLoadedState = false
  try {
    assignLifeOsState(await getLifeOsState())
  } catch (error: any) {
    loadError.value = error?.message || 'Life OS state failed to load'
  } finally {
    loading.value = false
    window.setTimeout(() => {
      hasLoadedState = true
      if (incomeReconciliationPending || brokerageSyncPending) {
        incomeReconciliationPending = false
        brokerageSyncPending = false
        scheduleSave()
      }
    }, 0)
  }
}

async function loadMonthlySettlements(): Promise<void> {
  monthlySettlementState.value = 'loading'
  monthlySettlementError.value = ''
  try {
    monthlySettlementList.value = await getLifeOsMonthlySettlements()
    monthlyEditUnlocked.value = false
    monthlySettlementState.value = 'idle'
  } catch (error: any) {
    monthlySettlementError.value = error?.message || 'Life OS monthly settlements failed to load'
    monthlySettlementState.value = 'error'
  }
}

async function closeCurrentMonth(): Promise<void> {
  if (currentMonthClosed.value || monthlySettlementState.value === 'closing') return
  monthlySettlementState.value = 'closing'
  monthlySettlementError.value = ''
  try {
    await saveLifeOsState()
    const result = await createLifeOsMonthlySettlement(cloneState(lifeOsState))
    monthlySettlementList.value = {
      currentMonth: result.currentMonth,
      currentMonthClosed: result.currentMonthClosed,
      latest: result.settlement,
      items: result.items,
    }
    monthlySettlementState.value = 'closed'
  } catch (error: any) {
    monthlySettlementError.value = error?.message || 'Life OS monthly settlement failed'
    monthlySettlementState.value = 'error'
    void loadMonthlySettlements()
  }
}

function toggleMonthEditUnlock(): void {
  if (!currentMonthClosed.value) return
  monthlyEditUnlocked.value = !monthlyEditUnlocked.value
}

function clearSaveTimer(): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
}

function scheduleSave(): void {
  if (!hasLoadedState || loading.value) return
  clearSaveTimer()
  saveState.value = 'idle'
  saveError.value = ''
  saveTimer = window.setTimeout(() => {
    void saveLifeOsState()
  }, 1200)
}

function clearNexusTimer(): void {
  if (nexusTimer !== null) {
    window.clearTimeout(nexusTimer)
    nexusTimer = null
  }
}

function clearNexusTypeTimer(): void {
  if (nexusTypeTimer !== null) {
    window.clearInterval(nexusTypeTimer)
    nexusTypeTimer = null
  }
}

function clearDebateTypeTimer(): void {
  if (debateTypeTimer !== null) {
    window.clearInterval(debateTypeTimer)
    debateTypeTimer = null
  }
}

function isGatewayErrorText(value: unknown): boolean {
  return typeof value === 'string' && GATEWAY_ERROR_PATTERN.test(value)
}

function isSafeText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !isGatewayErrorText(value)
}

function isValidDebateFeed(value: unknown): value is LifeOsDebateFeed {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LifeOsDebateFeed>
  return isSafeText(candidate.alpha) && isSafeText(candidate.beta) && isSafeText(candidate.prime)
}

function typeNexusAdvice(text: string): void {
  clearNexusTypeTimer()
  displayedNexusAdvice.value = ''
  if (!isSafeText(text)) {
    nexusError.value = 'AI 閘道器無回應'
    nexusState.value = 'error'
    return
  }

  let index = 0
  nexusTypeTimer = window.setInterval(() => {
    displayedNexusAdvice.value += text[index] || ''
    index += 1
    if (index >= text.length) {
      clearNexusTypeTimer()
    }
  }, 18)
}

function resetDisplayedDebateFeed(): void {
  clearDebateTypeTimer()
  displayedDebateFeed.alpha = ''
  displayedDebateFeed.beta = ''
  displayedDebateFeed.prime = ''
}

function typeDebateSegment(key: keyof LifeOsDebateFeed, text: string): Promise<void> {
  return new Promise((resolve) => {
    displayedDebateFeed[key] = ''
    if (!text) {
      resolve()
      return
    }

    let index = 0
    debateTypeTimer = window.setInterval(() => {
      displayedDebateFeed[key] += text[index] || ''
      index += 1
      if (index >= text.length) {
        clearDebateTypeTimer()
        window.setTimeout(resolve, 140)
      }
    }, 12)
  })
}

async function typeDebateFeed(feed: LifeOsDebateFeed): Promise<void> {
  if (!isValidDebateFeed(feed)) {
    briefingError.value = 'AI 閘道器無回應'
    briefingState.value = 'error'
    resetDisplayedDebateFeed()
    return
  }
  resetDisplayedDebateFeed()
  await typeDebateSegment('alpha', feed.alpha)
  await typeDebateSegment('beta', feed.beta)
  await typeDebateSegment('prime', feed.prime)
}

function scheduleNexusEvaluation(): void {
  if (!hasLoadedState || loading.value) return
  clearNexusTimer()
  nexusTimer = window.setTimeout(() => {
    void fetchNexusAdvice()
  }, 1800)
}

async function fetchNexusAdvice(): Promise<void> {
  if (loading.value) return
  nexusState.value = 'thinking'
  nexusError.value = ''

  try {
    const result = await evaluateNexus(cloneState(lifeOsState))
    nexusResult.value = result
    nexusAdvice.value = result.advice || ''
    nexusState.value = 'ready'
    typeNexusAdvice(nexusAdvice.value)
  } catch (error: any) {
    nexusError.value = error?.message || 'NEXUS evaluation failed'
    nexusState.value = 'error'
  }
}

async function generateBriefingDebate(): Promise<void> {
  if (briefingState.value === 'generating') return
  briefingState.value = 'generating'
  briefingError.value = ''
  debateFeed.value = null
  resetDisplayedDebateFeed()

  try {
    const result = await generateLifeOsBriefing(todayKey())
    if (!isValidDebateFeed(result.debateFeed)) {
      throw new Error('AI 閘道器無回應')
    }
    debateFeed.value = result.debateFeed
    briefingState.value = 'ready'
    await typeDebateFeed(result.debateFeed)
  } catch (error: any) {
    briefingError.value = isGatewayErrorText(error?.message) ? 'AI 閘道器無回應' : (error?.message || 'Generate briefing failed')
    briefingState.value = 'error'
  }
}

async function saveLifeOsState(): Promise<void> {
  if (loading.value) return
  clearSaveTimer()
  saveState.value = 'saving'
  saveError.value = ''

  try {
    await updateLifeOsState(cloneState(lifeOsState))
    lastSavedAt.value = new Date()
    saveState.value = 'saved'
  } catch (error: any) {
    saveError.value = error?.message || 'Life OS state failed to save'
    saveState.value = 'error'
  }
}

function stockMarketValue(stock: LifeOsStockItem): number {
  return numberOrZero(stock.shares) * numberOrZero(stock.currentPrice)
}

function fxRateForMarket(market: LifeOsMarketKind): number {
  return market === 'us' ? metrics.value.usdTwdRate : 1
}

function currencyForMarket(market: LifeOsMarketKind): 'TWD' | 'USD' {
  return market === 'us' ? 'USD' : 'TWD'
}

function stockMarketValueTwd(stock: LifeOsStockItem, market: LifeOsMarketKind): number {
  return stockMarketValue(stock) * fxRateForMarket(market)
}

function currentPortfolioMarketValueTwd(): number {
  const domesticValue = lifeOsState.financialState.investmentEquity.domesticStocks
    .reduce((sum, stock) => sum + stockMarketValueTwd(stock, 'domestic'), 0)
  const usValue = lifeOsState.financialState.investmentEquity.usStocks
    .reduce((sum, stock) => sum + stockMarketValueTwd(stock, 'us'), 0)
  return round(domesticValue + usValue, 2)
}

function brokerageAccount(): LifeOsBudgetAccount {
  let account = lifeOsState.budgeting.accounts.find(isBrokerageAccount)

  if (!account) {
    account = {
      id: 'brokerage-cash',
      name: '證券戶市值',
      type: '證券戶',
      balance: 0,
    }
    lifeOsState.budgeting.accounts.push(account)
  }

  account.id = account.id || 'brokerage-cash'
  account.name = account.name && account.name !== '證券戶現金' ? account.name : '證券戶市值'
  account.type = '證券戶'
  return account
}

function syncBrokerageAccountBalance(): boolean {
  const account = brokerageAccount()
  const nextBalance = currentPortfolioMarketValueTwd()
  if (numberOrZero(account.balance) === nextBalance) return false
  account.balance = nextBalance
  return true
}

function stockCost(stock: LifeOsStockItem): number {
  return numberOrZero(stock.shares) * numberOrZero(stock.costBasis)
}

function stockCostTwd(stock: LifeOsStockItem, market: LifeOsMarketKind): number {
  return stockCost(stock) * fxRateForMarket(market)
}

function stockGainLoss(stock: LifeOsStockItem): number {
  return stockMarketValue(stock) - stockCost(stock)
}

function stockGainLossPct(stock: LifeOsStockItem): number {
  const cost = stockCost(stock)
  if (cost <= 0) return 0
  return round((stockGainLoss(stock) / cost) * 100, 2)
}

function addStockHolding(rows: LifeOsStockItem[], defaultSymbol: string): void {
  rows.push({
    symbol: defaultSymbol,
    name: '',
    shares: 0,
    costBasis: 0,
    currentPrice: 0,
  })
}

function primaryCashAccount(): LifeOsBudgetAccount {
  let account = lifeOsState.budgeting.accounts.find((item) => item.id === 'cash-main')
    || lifeOsState.budgeting.accounts.find((item) => item.type === '活存')
    || lifeOsState.budgeting.accounts.find(isLiquidityAccount)

  if (!account) {
    account = {
      id: `cash-${Date.now()}`,
      name: '主要活存',
      type: '活存',
      balance: 0,
    }
    lifeOsState.budgeting.accounts.unshift(account)
  }

  return account
}

function accountForTransaction(transaction: LifeOsBudgetTransaction): LifeOsBudgetAccount {
  return lifeOsState.budgeting.accounts.find((account) => account.id === transaction.accountId)
    || primaryCashAccount()
}

function updateTransactionAmount(transaction: LifeOsBudgetTransaction, nextValue: string | number): void {
  if (isMonthLocked.value) return
  const nextAmount = round(numberOrZero(typeof nextValue === 'string' ? Number(nextValue) : nextValue), 2)
  const previousAmount = numberOrZero(transaction.amount)
  const delta = nextAmount - previousAmount
  if (delta === 0) return

  const account = accountForTransaction(transaction)
  account.balance = round(numberOrZero(account.balance) + delta, 2)
  transaction.amount = nextAmount
}

function clearUndoTimer(): void {
  if (undoTimer !== null) {
    window.clearTimeout(undoTimer)
    undoTimer = null
  }
}

function scheduleUndoExpiry(): void {
  clearUndoTimer()
  undoTimer = window.setTimeout(() => {
    deletedTransactionSnapshot.value = null
    undoTimer = null
  }, 12000)
}

function requestDeleteTransaction(transaction: LifeOsBudgetTransaction): void {
  if (isMonthLocked.value) return
  if (pendingDeleteTransactionId.value === transaction.id) {
    deleteTransaction(transaction)
    return
  }

  pendingDeleteTransactionId.value = transaction.id
}

function cancelDeleteTransaction(): void {
  pendingDeleteTransactionId.value = null
}

function deleteTransaction(transaction: LifeOsBudgetTransaction): void {
  if (isMonthLocked.value) return
  const index = lifeOsState.budgeting.transactions.findIndex((item) => item.id === transaction.id)
  if (index < 0) return

  const account = accountForTransaction(transaction)
  const snapshot: DeletedTransactionSnapshot = {
    transaction: {
      ...transaction,
      accountId: account.id,
    },
    index,
    accountId: account.id,
  }
  account.balance = round(numberOrZero(account.balance) - numberOrZero(transaction.amount), 2)
  lifeOsState.budgeting.transactions.splice(index, 1)
  pendingDeleteTransactionId.value = null
  deletedTransactionSnapshot.value = snapshot
  scheduleUndoExpiry()
}

function restoreDeletedTransaction(): void {
  if (isMonthLocked.value) return
  const snapshot = deletedTransactionSnapshot.value
  if (!snapshot) return

  const account = lifeOsState.budgeting.accounts.find((item) => item.id === snapshot.accountId)
    || primaryCashAccount()
  const restoredTransaction = { ...snapshot.transaction, accountId: account.id }
  const insertIndex = Math.min(snapshot.index, lifeOsState.budgeting.transactions.length)

  account.balance = round(numberOrZero(account.balance) + numberOrZero(restoredTransaction.amount), 2)
  lifeOsState.budgeting.transactions.splice(insertIndex, 0, restoredTransaction)
  selectedCalendarDate.value = restoredTransaction.date
  dailyExpenseForm.date = restoredTransaction.date
  deletedTransactionSnapshot.value = null
  clearUndoTimer()
}

function addDailyExpense(): void {
  if (isMonthLocked.value) return
  const amount = round(Math.abs(numberOrZero(dailyExpenseForm.amount)), 2)
  if (amount <= 0 || (dailyEntryMode.value === 'expense' && !dailyExpenseForm.categoryId)) return

  const account = primaryCashAccount()
  const entryDate = dailyExpenseForm.date || selectedCalendarDate.value || todayKey()

  if (dailyEntryMode.value === 'income') {
    const payee = dailyExpenseForm.payee.trim() || '收入入帳'
    account.balance = round(numberOrZero(account.balance) + amount, 2)
    lifeOsState.financialState.monthlyInflow.totalIncome = round(totalIncome.value + amount, 2)
    monthlyIncomeBaseline = numberOrZero(lifeOsState.financialState.monthlyInflow.totalIncome)
    lifeOsState.budgeting.transactions.unshift({
      id: `tx-income-quick-${Date.now()}`,
      date: entryDate,
      accountId: account.id,
      categoryId: 'income',
      payee,
      amount,
      note: dailyExpenseForm.note.trim(),
    })

    selectedCalendarDate.value = entryDate
    dailyExpenseForm.date = entryDate
    dailyExpenseForm.payee = ''
    dailyExpenseForm.amount = 0
    dailyExpenseForm.note = ''
    return
  }

  const category = lifeOsState.budgeting.categories.find((item) => item.id === dailyExpenseForm.categoryId)
  const payee = dailyExpenseForm.payee.trim() || category?.name || '每日開銷'

  account.balance = round(numberOrZero(account.balance) - amount, 2)
  lifeOsState.budgeting.transactions.unshift({
    id: `tx-expense-${Date.now()}`,
    date: entryDate,
    accountId: account.id,
    categoryId: dailyExpenseForm.categoryId,
    payee,
    amount: -amount,
    note: dailyExpenseForm.note.trim(),
  })

  selectedCalendarDate.value = entryDate
  dailyExpenseForm.date = entryDate
  dailyExpenseForm.payee = ''
  dailyExpenseForm.amount = 0
  dailyExpenseForm.note = ''
}

function handleQuickEntry(): void {
  addDailyExpense()
}

function sellAndRemoveStockHolding(rows: LifeOsStockItem[], index: number, market: LifeOsMarketKind): void {
  if (isMonthLocked.value) return
  const stock = rows[index]
  if (!stock) return

  const proceeds = round(stockMarketValueTwd(stock, market), 2)
  const label = stock.symbol || stock.name || '未命名持倉'

  if (proceeds > 0) {
    const account = primaryCashAccount()
    account.balance = round(numberOrZero(account.balance) + proceeds, 2)
    lifeOsState.budgeting.transactions.unshift({
      id: `tx-sell-${Date.now()}`,
      date: new Date().toISOString().slice(0, 10),
      accountId: account.id,
      categoryId: 'investing',
      payee: `賣出 ${label}`,
      amount: proceeds,
      note: `持倉移除，自動回補主要活存；股數 ${stock.shares}，現價 ${stock.currentPrice} ${currencyForMarket(market)}，匯率 ${fxRateForMarket(market).toFixed(2)}`,
    })
  }

  rows.splice(index, 1)
  syncBrokerageAccountBalance()
}

function recordStockPurchase(stock: LifeOsStockItem, market: LifeOsMarketKind): void {
  if (isMonthLocked.value) return
  const shares = numberOrZero(stock.shares)
  const cost = numberOrZero(stock.costBasis || stock.currentPrice)
  const totalCost = round(stockCostTwd({ ...stock, shares, costBasis: cost }, market), 2)
  if (shares <= 0 || totalCost <= 0) return

  const account = primaryCashAccount()
  const label = stock.symbol || stock.name || '未命名持倉'
  account.balance = round(numberOrZero(account.balance) - totalCost, 2)
  lifeOsState.budgeting.transactions.unshift({
    id: `tx-buy-${Date.now()}`,
    date: todayKey(),
    accountId: account.id,
    categoryId: 'investing',
    payee: `買入 ${label}`,
    amount: -totalCost,
    note: `投資持倉入帳；股數 ${shares}，成本 ${cost} ${currencyForMarket(market)}，匯率 ${fxRateForMarket(market).toFixed(2)}`,
  })
  syncBrokerageAccountBalance()
  selectedCalendarDate.value = todayKey()
  dailyExpenseForm.date = todayKey()
}

async function refreshPortfolioPrices(): Promise<void> {
  if (isMonthLocked.value || priceRefreshState.value === 'loading') return
  priceRefreshState.value = 'loading'
  priceRefreshMessage.value = ''
  priceRefreshUpdates.value = []

  try {
    await saveLifeOsState()
    const result = await refreshLifeOsPrices(cloneState(lifeOsState))
    assignLifeOsState(result.state)
    priceRefreshUpdates.value = result.updates
    const okCount = result.updates.filter((update) => update.status === 'ok').length
    const failedCount = result.updates.filter((update) => update.status === 'failed').length
    const skippedCount = result.updates.filter((update) => update.status === 'skipped').length
    priceRefreshState.value = failedCount > 0 ? 'partial' : 'updated'
    priceRefreshMessage.value = `已更新 ${okCount} 檔${failedCount ? `，失敗 ${failedCount} 檔` : ''}${skippedCount ? `，略過 ${skippedCount} 檔` : ''}`
    lastSavedAt.value = new Date(result.updatedAt)
    saveState.value = 'saved'
  } catch (error: any) {
    priceRefreshState.value = 'error'
    priceRefreshMessage.value = error?.message || '現價更新失敗'
  }
}

async function backupLifeOsState(): Promise<void> {
  if (backupState.value === 'creating') return
  backupState.value = 'creating'
  backupMessage.value = ''

  try {
    await saveLifeOsState()
    const result = await createLifeOsBackup()
    backupState.value = 'created'
    backupMessage.value = `已備份 ${result.fileName}`
  } catch (error: any) {
    backupState.value = 'error'
    backupMessage.value = error?.message || 'Life OS backup failed'
  }
}

function budgetCategoryMetric(categoryId: string): LifeOsBudgetCategoryMetric | undefined {
  return budgetRows.value.find((category) => category.id === categoryId)
}

function categorySpent(categoryId: string): number {
  return budgetCategoryMetric(categoryId)?.spent ?? 0
}

function categoryRemaining(categoryId: string): number {
  const category = budgetCategoryMetric(categoryId)
  if (!category) return 0
  return isTransferBudgetCategory(category) ? 0 : category.remaining
}

function categoryRemainingClass(categoryId: string): string {
  const category = budgetCategoryMetric(categoryId)
  if (!category) return 'positive'
  if (isTransferBudgetCategory(category)) return 'pending'
  if (category.remaining < 0) return 'negative budget-breach-text'
  if (category.budgeted > 0 && category.spent / category.budgeted >= BUDGET_WARNING_RATIO) return 'warning'
  return 'positive'
}

function budgetRowClass(categoryId: string): Record<string, boolean> {
  const category = budgetCategoryMetric(categoryId)
  if (!category || isTransferBudgetCategory(category)) return {}
  return {
    'budget-row--warning': category.remaining >= 0 && category.budgeted > 0 && category.spent / category.budgeted >= BUDGET_WARNING_RATIO,
    'budget-row--breached': category.remaining < 0,
  }
}

function budgetStatusLabel(categoryId: string): string {
  const category = budgetCategoryMetric(categoryId)
  if (!category || isTransferBudgetCategory(category)) return ''
  if (category.remaining < 0) return 'BREACHED'
  if (category.budgeted > 0 && category.spent / category.budgeted >= BUDGET_WARNING_RATIO) return 'WARNING'
  return ''
}

function formatMoney(value: number): string {
  const prefix = value < 0 ? '-NT$' : 'NT$'
  return `${prefix}${Math.abs(Math.round(value)).toLocaleString('en-US')}`
}

function formatPct(value: number, digits = 1): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}%`
}

watch(
  lifeOsState,
  () => {
    scheduleSave()
    scheduleNexusEvaluation()
  },
  { deep: true },
)

watch(
  () => metrics.value.totalStocks,
  () => {
    if (!hasLoadedState || loading.value) return
    if (syncBrokerageAccountBalance()) {
      scheduleSave()
    }
  },
)

watch(currentMonthClosed, (closed) => {
  if (closed) monthlyEditUnlocked.value = false
})

onMounted(() => {
  clockTimer = window.setInterval(() => {
    currentTime.value = new Date()
  }, 1000)
  void loadLifeOsState()
  void loadMonthlySettlements()
  window.setTimeout(() => {
    if (hasLoadedState) void fetchNexusAdvice()
  }, 1400)
})

onBeforeUnmount(() => {
  clearSaveTimer()
  clearUndoTimer()
  clearNexusTimer()
  clearNexusTypeTimer()
  clearDebateTypeTimer()
  if (clockTimer !== null) {
    window.clearInterval(clockTimer)
    clockTimer = null
  }
})
</script>

<template>
  <div
    class="lifeos-grid-dashboard grid grid-cols-12 gap-4 p-4 min-h-screen bg-[#050505] text-gray-300 font-mono select-none"
    :class="{ 'lifeos-grid-dashboard--embedded': embedded, 'is-month-locked': isMonthLocked }"
  >
    <header class="terminal-header">
      <div>
        <span>LIFE OS</span>
        <h1>BRUTAL TRUTH // PERSONAL BALANCE SHEET</h1>
      </div>
      <div class="terminal-status">
        <span>{{ normalizedMacroRegime }}</span>
        <span>LOCAL STATE {{ loading ? 'LOADING' : 'READY' }}</span>
        <span :class="{ positive: saveState === 'saved', negative: saveState === 'error', pending: saveState === 'saving' }">
          儲存狀態：{{ saveStatusLabel }}
        </span>
        <span :class="{ positive: nexusState === 'ready', negative: nexusState === 'error', pending: nexusState === 'thinking' }">
          {{ nexusStatusLabel }}
        </span>
        <span v-if="isMonthLocked" class="pending">MONTH LOCKED</span>
        <strong>{{ systemTime }}</strong>
      </div>
    </header>

    <section class="truth-bar">
      <div class="truth-metric">
        <span>當前淨資產 / NET WORTH</span>
        <strong :class="netWorth >= 0 ? 'positive' : 'negative'">{{ formatMoney(netWorth) }}</strong>
      </div>
      <div class="truth-metric">
        <span>本月儲蓄率 / SAVINGS RATE</span>
        <strong :class="savingsRate >= 0 ? 'positive' : 'negative'">{{ formatPct(savingsRate) }}</strong>
      </div>
      <div class="truth-metric">
        <span>FIRE 殘酷倒數 / YEARS TO FIRE</span>
        <strong :class="fireMetrics.yearsRemaining.includes('∞') ? 'negative' : 'pending'">{{ fireYearsLabel }}</strong>
      </div>

      <div class="fire-progress">
        <div class="fire-progress-head">
          <span>FIRE TARGET {{ formatMoney(fireMetrics.targetAmount) }}</span>
          <strong>{{ fireMetrics.progressPct }}%</strong>
        </div>
        <div class="fire-track">
          <div class="fire-fill" :style="{ width: `${fireProgressWidth}%` }" />
        </div>
      </div>
    </section>

    <section class="monthly-close-strip">
      <div class="monthly-command">
        <span>MONTHLY CLOSE</span>
        <strong>{{ currentMonthLabel }}</strong>
        <small :class="{ positive: currentMonthClosed, negative: monthlySettlementState === 'error', pending: monthlySettlementState === 'closing' || monthlySettlementState === 'loading' }">
          {{ monthlySettlementStatusLabel }}
        </small>
      </div>
      <div class="monthly-metrics">
        <div>
          <span>最新月結淨值</span>
          <strong :class="(latestMonthlySettlement?.summary.netWorth ?? netWorth) >= 0 ? 'positive' : 'negative'">
            {{ formatMoney(latestMonthlySettlement?.summary.netWorth ?? netWorth) }}
          </strong>
        </div>
        <div>
          <span>月現金流</span>
          <strong :class="(latestMonthlySettlement?.summary.netMonthlyCashFlow ?? monthlySurplus) >= 0 ? 'positive' : 'negative'">
            {{ formatMoney(latestMonthlySettlement?.summary.netMonthlyCashFlow ?? monthlySurplus) }}
          </strong>
        </div>
        <div>
          <span>現金水位</span>
          <strong>{{ metrics.cashReserveMonths.toFixed(1) }} 個月</strong>
        </div>
        <div>
          <span>投資損益</span>
          <strong :class="(latestMonthlySettlement?.summary.usStockGainLossPct ?? metrics.usStockMetrics.totalGainLossPct) >= 0 ? 'positive' : 'negative'">
            US {{ formatPct(latestMonthlySettlement?.summary.usStockGainLossPct ?? metrics.usStockMetrics.totalGainLossPct, 2) }}
          </strong>
        </div>
      </div>
      <div class="monthly-actions">
        <button
          v-if="currentMonthClosed"
          type="button"
          class="monthly-close-button"
          @click="toggleMonthEditUnlock"
        >
          {{ monthlyEditUnlocked ? '重新鎖定' : '解鎖編輯' }}
        </button>
        <button
          v-else
          type="button"
          class="monthly-close-button"
          :disabled="monthlySettlementState === 'closing' || monthlySettlementState === 'loading'"
          @click="closeCurrentMonth"
        >
          {{ monthlySettlementState === 'closing' ? '封存中' : '結算本月' }}
        </button>
        <button
          type="button"
          class="monthly-close-button backup-button"
          :disabled="backupState === 'creating'"
          @click="backupLifeOsState"
        >
          {{ backupState === 'creating' ? '備份中' : '建立備份' }}
        </button>
      </div>
      <p v-if="monthlySettlementError" class="monthly-error">{{ monthlySettlementError }}</p>
      <p v-if="backupMessage" class="monthly-error" :class="{ positive: backupState === 'created', negative: backupState === 'error' }">
        {{ backupStatusLabel }}
      </p>
    </section>

    <main class="lifeos-workspace">
      <section class="grid-panel cash-debt-panel">
        <header class="panel-header">
          <span>01</span>
          <strong>現金與負債</strong>
          <small>CASH / DEBT</small>
        </header>
        <div class="panel-body-stack">
          <table class="terminal-table">
            <thead>
              <tr>
                <th>帳戶名稱</th>
                <th>類型</th>
                <th>當前餘額</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="account in cashDebtAccounts" :key="account.id">
                <td><input v-model="account.name" :disabled="isMonthLocked || isBrokerageAccount(account)" type="text"></td>
                <td><input v-model="account.type" :disabled="isMonthLocked || isBrokerageAccount(account)" type="text"></td>
                <td><input v-model.number="account.balance" :disabled="isMonthLocked || isBrokerageAccount(account)" type="number"></td>
              </tr>
            </tbody>
          </table>

          <table class="terminal-table compact-table">
            <thead>
              <tr>
                <th>貸款名稱</th>
                <th>剩餘本金</th>
                <th>每月應繳</th>
                <th>利率</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{{ loanRuntime.name }}</td>
                <td><input v-model.number="lifeOsState.financialState.liabilities.loanTotal" :disabled="isMonthLocked" type="number" min="0"></td>
                <td><input v-model.number="loanRuntime.monthlyPayment" :disabled="isMonthLocked" type="number" min="0"></td>
                <td><input v-model.number="loanRuntime.interestRate" :disabled="isMonthLocked" type="number" min="0" step="0.01"></td>
              </tr>
            </tbody>
          </table>

          <div class="cashflow-summary-grid">
            <div>
              <span>主業收入</span>
              <input
                :value="lifeOsState.financialState.monthlyInflow.totalIncome"
                :disabled="isMonthLocked"
                type="number"
                min="0"
                @change="applyMonthlyIncomeChange(eventValue($event))"
              >
            </div>
            <div>
              <span>本月生活已花</span>
              <strong>{{ formatMoney(actualMonthlySpent) }}</strong>
            </div>
            <div>
              <span>本月結餘</span>
              <strong :class="monthlySurplus >= 0 ? 'positive' : 'negative'">{{ formatMoney(monthlySurplus) }}</strong>
            </div>
          </div>
        </div>
        <footer class="panel-total">
          <div>
            <span>總可用現金</span>
            <strong class="positive">{{ formatMoney(metrics.totalCash) }}</strong>
          </div>
          <div>
            <span>基本開銷支撐</span>
            <strong>{{ basicExpenseMonths.toFixed(1) }} 個月</strong>
          </div>
        </footer>
      </section>

      <section class="grid-panel portfolio-workbench">
        <header class="panel-header">
          <span>02</span>
          <strong>資本引擎</strong>
          <div class="portfolio-header-actions">
            <button type="button" :disabled="isMonthLocked || priceRefreshState === 'loading'" @click="refreshPortfolioPrices">
              {{ priceRefreshState === 'loading' ? '更新中' : '更新現價' }}
            </button>
            <small :class="{ positive: priceRefreshState === 'updated', pending: priceRefreshState === 'partial' || priceRefreshState === 'loading', negative: priceRefreshState === 'error' }">
              {{ priceRefreshStatusLabel }}
            </small>
          </div>
        </header>
        <div class="table-scroll">
          <table class="terminal-table portfolio-table">
            <thead>
              <tr>
                <th>標的</th>
                <th>股數</th>
                <th>成本</th>
                <th>現價</th>
                <th>未實現損益</th>
                <th>台幣市值</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="section in portfolioSections" :key="section.label">
                <tr class="section-row">
                  <td colspan="7">
                    <div class="section-row-content">
                      <span>{{ section.label }}</span>
                      <button type="button" :disabled="isMonthLocked" @click="addStockHolding(section.rows, section.defaultSymbol)">+ 新增持倉</button>
                    </div>
                  </td>
                </tr>
                <tr v-for="(stock, index) in section.rows" :key="`${section.label}-${index}-${stock.symbol}-${stock.name}`">
                  <td>
                    <div class="symbol-cell">
                      <input v-model="stock.symbol" class="symbol-input" :disabled="isMonthLocked" type="text" placeholder="代號">
                      <input v-model="stock.name" class="symbol-input muted" :disabled="isMonthLocked" type="text" placeholder="名稱">
                    </div>
                  </td>
                  <td><input v-model.number="stock.shares" :disabled="isMonthLocked" type="number" min="0" step="any"></td>
                  <td><input v-model.number="stock.costBasis" :disabled="isMonthLocked" type="number" min="0" step="any"></td>
                  <td><input v-model.number="stock.currentPrice" :disabled="isMonthLocked" type="number" min="0" step="any"></td>
                  <td :class="stockGainLossPct(stock) >= 0 ? 'positive' : 'negative'">
                    {{ formatPct(stockGainLossPct(stock), 2) }}
                  </td>
                  <td class="positive">{{ formatMoney(stockMarketValueTwd(stock, section.market)) }}</td>
                  <td>
                    <div class="stock-action-stack">
                      <button class="buy-record-button" type="button" :disabled="isMonthLocked || stockCost(stock) <= 0" @click="recordStockPurchase(stock, section.market)">
                        買入入帳
                      </button>
                      <button class="sell-remove-button" type="button" :disabled="isMonthLocked" @click="sellAndRemoveStockHolding(section.rows, index, section.market)">
                        賣出移除
                      </button>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <footer class="panel-total">
          <div>
            <span>股票市值</span>
            <strong class="positive">{{ formatMoney(metrics.totalStocks) }}</strong>
          </div>
          <div>
            <span>USD/TWD</span>
            <strong>{{ metrics.usdTwdRate.toFixed(2) }}</strong>
          </div>
          <div>
            <span>投資比率</span>
            <strong>{{ formatPct(metrics.investmentRatio) }}</strong>
          </div>
        </footer>
      </section>

      <aside class="grid-panel quick-entry-panel">
        <header class="panel-header">
          <span>03</span>
          <strong>每日開銷輸入</strong>
          <small>QUICK ENTRY</small>
        </header>
        <form class="daily-expense-form daily-expense-form--stacked" @submit.prevent="handleQuickEntry">
          <header>
            <strong>快速記帳</strong>
            <span>{{ quickEntryHint }}</span>
          </header>
          <div class="quick-entry-tabs" role="tablist" aria-label="記帳模式">
            <button
              type="button"
              :class="{ active: dailyEntryMode === 'expense' }"
              :disabled="isMonthLocked"
              @click="dailyEntryMode = 'expense'"
            >
              紀錄支出
            </button>
            <button
              type="button"
              :class="{ active: dailyEntryMode === 'income' }"
              :disabled="isMonthLocked"
              @click="dailyEntryMode = 'income'"
            >
              紀錄收入
            </button>
          </div>
          <label>
            <span>日期</span>
            <input v-model="dailyExpenseForm.date" :disabled="isMonthLocked" type="date" aria-label="日期">
          </label>
          <label v-if="dailyEntryMode === 'expense'">
            <span>分類</span>
            <select v-model="dailyExpenseForm.categoryId" :disabled="isMonthLocked" aria-label="分類">
              <option v-for="category in lifeOsState.budgeting.categories" :key="category.id" :value="category.id">
                {{ category.name }}
              </option>
            </select>
          </label>
          <label>
            <span>項目 / 店家</span>
            <input v-model="dailyExpenseForm.payee" :disabled="isMonthLocked" type="text" :placeholder="quickEntryPayeePlaceholder">
          </label>
          <label>
            <span>金額</span>
            <input v-model.number="dailyExpenseForm.amount" :disabled="isMonthLocked" type="number" min="0" placeholder="0">
          </label>
          <label>
            <span>備註</span>
            <input v-model="dailyExpenseForm.note" :disabled="isMonthLocked" type="text" placeholder="可留空">
          </label>
          <button type="submit" :disabled="isMonthLocked || !dailyExpenseReady">{{ quickEntryButtonLabel }}</button>
        </form>
        <footer class="quick-entry-summary">
          <div>
            <span>本月生活已花</span>
            <strong>{{ formatMoney(actualMonthlySpent) }}</strong>
          </div>
          <div>
            <span>本月結餘</span>
            <strong :class="monthlySurplus >= 0 ? 'positive' : 'negative'">{{ formatMoney(monthlySurplus) }}</strong>
          </div>
        </footer>
      </aside>
    </main>

    <section class="budget-nexus-grid">
      <section class="grid-panel budget-panel">
        <header class="panel-header">
          <span>04</span>
          <strong>分類預算</strong>
          <small>ENVELOPE BUDGET</small>
        </header>
        <div class="budget-stack">
          <table class="terminal-table budget-table">
            <thead>
              <tr>
                <th>分類</th>
                <th>群組</th>
                <th>預算</th>
                <th>已花</th>
                <th>剩餘</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="category in lifeOsState.budgeting.categories"
                :key="category.id"
                :class="budgetRowClass(category.id)"
              >
                <td>{{ category.name }}</td>
                <td>{{ category.group }}</td>
                <td>
                  <input v-model.number="category.budgeted" :disabled="isMonthLocked" type="number" min="0">
                </td>
                <td>{{ formatMoney(categorySpent(category.id)) }}</td>
                <td :class="categoryRemainingClass(category.id)">
                  {{ formatMoney(categoryRemaining(category.id)) }}
                  <span v-if="budgetStatusLabel(category.id)" class="budget-status-tag">
                    [{{ budgetStatusLabel(category.id) }}]
                  </span>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="budget-summary">
            <span>已分配 {{ formatMoney(metrics.budgetMetrics.totalBudgeted) }}</span>
            <span>營運支出 {{ formatMoney(metrics.budgetMetrics.operatingSpent) }}</span>
            <span>投資轉倉 {{ formatMoney(metrics.budgetMetrics.transferSpent) }}</span>
            <span :class="metrics.budgetMetrics.availableToBudget >= 0 ? 'positive' : 'negative'">
              可再分配 {{ formatMoney(metrics.budgetMetrics.availableToBudget) }}
            </span>
          </div>
        </div>
        <footer v-if="loadError || saveError" class="load-error">
          {{ loadError ? `API FALLBACK: ${loadError}` : `SAVE FAILED: ${saveError}` }}
        </footer>
      </section>

      <section class="grid-panel calendar-panel">
        <header class="panel-header">
          <span>05</span>
          <strong>月曆視圖</strong>
          <small>{{ calendarMonthLabel }}</small>
        </header>
        <div class="budget-calendar">
          <div class="calendar-weekdays">
            <span v-for="weekday in ['日', '一', '二', '三', '四', '五', '六']" :key="weekday">{{ weekday }}</span>
          </div>
          <div class="calendar-grid">
            <button
              v-for="day in calendarDays"
              :key="day.key"
              type="button"
              class="calendar-day"
              :class="{
                'is-muted': !day.isCurrentMonth,
                'is-today': day.isToday,
                'is-selected': day.date === selectedCalendarDate,
                'has-expense': day.expense > 0,
                'has-income': day.income > 0,
                'has-transfer': day.transferOut > 0,
              }"
              @click="selectCalendarDate(day.date)"
            >
              <span class="calendar-day-number">{{ day.day }}</span>
              <small v-if="day.expense > 0" class="negative">-{{ formatMoney(day.expense).replace('NT$', '') }}</small>
              <small v-if="day.transferOut > 0" class="pending">T-{{ formatMoney(day.transferOut).replace('NT$', '') }}</small>
              <small v-if="day.income > 0" class="positive">+{{ formatMoney(day.income).replace('NT$', '') }}</small>
              <em v-if="day.count > 0">{{ day.count }}</em>
            </button>
          </div>

          <footer class="selected-date-summary">
            <div>
              <span>選取日期</span>
              <strong>{{ selectedCalendarDate }}</strong>
            </div>
            <div>
              <span>交易筆數</span>
              <strong>{{ selectedDateTransactionCount }} 筆</strong>
            </div>
            <div>
              <span>當日收入</span>
              <strong class="positive">{{ formatMoney(selectedDateIncome) }}</strong>
            </div>
            <div>
              <span>生活支出</span>
              <strong class="negative">{{ formatMoney(selectedDateExpense) }}</strong>
            </div>
            <div>
              <span>投資轉倉</span>
              <strong class="pending">{{ formatMoney(selectedDateTransferOut) }}</strong>
            </div>
            <div>
              <span>當日淨流量</span>
              <strong :class="selectedDateNet >= 0 ? 'positive' : 'negative'">{{ formatMoney(selectedDateNet) }}</strong>
            </div>
          </footer>

          <div v-if="deletedTransactionSnapshot" class="undo-transaction-banner">
            <span>
              已刪除：{{ deletedTransactionSnapshot.transaction.payee || '未命名交易' }}
              / {{ formatMoney(deletedTransactionSnapshot.transaction.amount) }}
            </span>
            <button type="button" :disabled="isMonthLocked" @click="restoreDeletedTransaction">復原</button>
          </div>

          <table class="terminal-table selected-date-table">
            <thead>
              <tr>
                <th>分類</th>
                <th>項目</th>
                <th>金額</th>
                <th>備註</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="tx in selectedDateTransactions" :key="tx.id">
                <td>
                  <select v-model="tx.categoryId" :disabled="isMonthLocked" aria-label="分類">
                    <option v-for="category in lifeOsState.budgeting.categories" :key="category.id" :value="category.id">
                      {{ category.name }}
                    </option>
                    <option value="income">收入</option>
                  </select>
                </td>
                <td><input v-model="tx.payee" :disabled="isMonthLocked" type="text" aria-label="項目"></td>
                <td>
                  <input
                    :class="tx.amount >= 0 ? 'positive' : 'negative'"
                    :value="tx.amount"
                    :disabled="isMonthLocked"
                    type="number"
                    aria-label="金額"
                    @change="updateTransactionAmount(tx, eventValue($event))"
                  >
                </td>
                <td><input v-model="tx.note" :disabled="isMonthLocked" type="text" aria-label="備註"></td>
                <td>
                  <div v-if="pendingDeleteTransactionId === tx.id" class="transaction-confirm-actions">
                    <button class="transaction-delete-button is-confirm" type="button" :disabled="isMonthLocked" @click="requestDeleteTransaction(tx)">
                      確認
                    </button>
                    <button class="transaction-cancel-button" type="button" :disabled="isMonthLocked" @click="cancelDeleteTransaction">
                      取消
                    </button>
                  </div>
                  <button v-else class="transaction-delete-button" type="button" :disabled="isMonthLocked" @click="requestDeleteTransaction(tx)">
                    刪除
                  </button>
                </td>
              </tr>
              <tr v-if="selectedDateTransactions.length === 0">
                <td colspan="5">此日期尚無交易</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="grid-panel nexus-panel">
        <header class="panel-header">
          <span>06</span>
          <strong>Nexus 建議</strong>
          <small>{{ nexusStatusLabel }}</small>
        </header>
        <div class="nexus-actions">
          <button
            class="nexus-action-button"
            type="button"
            :disabled="briefingState === 'generating'"
            @click="generateBriefingDebate"
          >
            {{ briefingState === 'generating' ? '幕僚會議中' : '生成晨報' }}
          </button>
        </div>
        <div class="nexus-source-bar" aria-label="NEXUS 資料來源">
          <span v-for="tag in nexusSourceTags" :key="tag" class="nexus-source-chip">
            {{ tag }}
          </span>
        </div>
        <div class="nexus-feed" :class="{ 'nexus-feed--thinking': nexusState === 'thinking', 'nexus-feed--error': nexusState === 'error' }">
          <strong>[NEXUS STRATEGY FEED]</strong>
          <p v-if="briefingState === 'generating'">[幕僚會議] OpenClaw / MiroFish / NEXUS 正在依序辯論<span class="terminal-cursor">_</span></p>
          <p v-else-if="briefingState === 'error'" class="negative">[SYSTEM ERROR] {{ briefingError || 'AI 閘道器無回應。' }}</p>
          <div v-else-if="hasValidDebateFeed && (displayedDebateFeed.alpha || displayedDebateFeed.beta || displayedDebateFeed.prime)" class="debate-feed">
            <transition name="debate-fade">
              <section v-if="displayedDebateFeed.alpha" class="debate-agent debate-agent--alpha">
                <strong>[OpenClaw | 激進派]</strong>
                <p v-for="line in displayedDebateFeed.alpha.split('\n').filter(Boolean)" :key="`alpha-${line}`">{{ line }}</p>
              </section>
            </transition>
            <transition name="debate-fade">
              <section v-if="displayedDebateFeed.beta" class="debate-agent debate-agent--beta">
                <strong>[MiroFish | 保守派]</strong>
                <p v-for="line in displayedDebateFeed.beta.split('\n').filter(Boolean)" :key="`beta-${line}`">{{ line }}</p>
              </section>
            </transition>
            <transition name="debate-fade">
              <section v-if="displayedDebateFeed.prime" class="debate-agent debate-agent--prime">
                <strong>[NEXUS | 總裁決]</strong>
                <p v-for="line in displayedDebateFeed.prime.split('\n').filter(Boolean)" :key="`prime-${line}`">{{ line }}</p>
              </section>
            </transition>
          </div>
          <p v-else-if="nexusState === 'thinking'">[戰略評估] NEXUS 正在合併 LifeOS JSON、WIKI 與外部情報脈絡<span class="terminal-cursor">_</span></p>
          <p v-else-if="nexusState === 'error'" class="negative">[系統警告] {{ nexusError || 'NEXUS 連線失敗，已保留本機規則。' }}</p>
          <template v-else-if="displayedNexusAdvice">
            <p v-for="line in displayedNexusAdvice.split('\n').filter(Boolean)" :key="line">{{ line }}</p>
          </template>
          <template v-else>
            <p v-for="signal in nexusSignals" :key="signal">{{ signal }}</p>
          </template>
          <div v-if="nexusResult?.breachedBudgets?.length" class="nexus-alert-line">
            預算突破：{{ nexusResult.breachedBudgets.join(' / ') }}
          </div>
        </div>
      </section>
    </section>

    <section class="history-grid">
      <section class="grid-panel history-panel">
        <header class="panel-header">
          <span>07</span>
          <strong>近期交易流水</strong>
          <small>最近 {{ recentTransactions.length }} 筆 / {{ lifeOsState.budgeting.month }}</small>
        </header>
        <table class="terminal-table transactions-table">
          <thead>
            <tr>
              <th>日期</th>
              <th>項目</th>
              <th>金額</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="tx in recentTransactions" :key="tx.id">
              <td>{{ tx.date }}</td>
              <td>{{ tx.payee }}</td>
              <td>
                <input
                  :value="tx.amount"
                  :disabled="isMonthLocked"
                  type="number"
                  @change="updateTransactionAmount(tx, eventValue($event))"
                >
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="grid-panel settlement-history-panel">
        <header class="panel-header">
          <span>08</span>
          <strong>月結歷史</strong>
          <small>SETTLEMENTS</small>
        </header>
        <table class="terminal-table transactions-table">
          <thead>
            <tr>
              <th>月份</th>
              <th>淨資產</th>
              <th>月現金流</th>
              <th>現金水位</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in monthlySettlementList?.items || []" :key="item.month">
              <td>{{ item.month }}</td>
              <td :class="item.summary.netWorth >= 0 ? 'positive' : 'negative'">{{ formatMoney(item.summary.netWorth) }}</td>
              <td :class="item.summary.netMonthlyCashFlow >= 0 ? 'positive' : 'negative'">{{ formatMoney(item.summary.netMonthlyCashFlow) }}</td>
              <td>{{ item.summary.cashReserveMonths.toFixed(1) }} 個月</td>
            </tr>
            <tr v-if="!(monthlySettlementList?.items || []).length">
              <td colspan="4">尚無月結紀錄</td>
            </tr>
          </tbody>
        </table>
      </section>
    </section>
  </div>
</template>

<style scoped>
.lifeos-grid-dashboard {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 12px;
  align-items: stretch;
  min-height: 100vh;
  width: 100%;
  overflow: auto;
  background:
    linear-gradient(rgba(0, 229, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 229, 255, 0.035) 1px, transparent 1px),
    #050505;
  background-size: 38px 38px;
  color: #d1d5db;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  letter-spacing: 0;
  padding: 14px;
  user-select: none;
}

.lifeos-grid-dashboard,
.lifeos-grid-dashboard * {
  box-sizing: border-box;
  min-width: 0;
}

.lifeos-grid-dashboard--embedded {
  min-height: 100%;
}

.terminal-header {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  border: 1px solid #1f2937;
  background: rgba(0, 0, 0, 0.68);
  padding: 10px 12px;
}

.terminal-header span,
.terminal-status,
.truth-metric span,
.panel-header span,
.panel-header small,
.panel-total span,
.symbol-cell small {
  color: #6b7280;
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
}

.terminal-header h1 {
  margin: 2px 0 0;
  color: #00e5ff;
  font-size: 15px;
  text-shadow: 0 0 12px rgba(0, 229, 255, 0.42);
}

.terminal-status {
  display: flex;
  align-items: center;
  gap: 12px;
  white-space: nowrap;
}

.terminal-status strong {
  color: #00ff88;
  font-size: 12px;
}

.pending {
  color: #b026ff !important;
}

.warning {
  color: #ffd700 !important;
  text-shadow: 0 0 10px rgba(255, 215, 0, 0.45);
}

.budget-status-tag {
  display: inline-block;
  margin-left: 8px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.08em;
  vertical-align: middle;
}

.budget-row--warning {
  background:
    linear-gradient(90deg, rgba(255, 215, 0, 0.09), transparent 55%),
    rgba(0, 0, 0, 0.28);
}

.budget-row--breached {
  background:
    linear-gradient(90deg, rgba(255, 54, 94, 0.18), transparent 62%),
    rgba(30, 0, 8, 0.52);
}

.budget-breach-text {
  animation: budget-breach-flash 0.72s steps(2, end) infinite;
  font-weight: 900;
  text-shadow: 0 0 14px rgba(255, 54, 94, 0.82);
}

@keyframes budget-breach-flash {
  0%,
  100% {
    color: #ff365e;
    filter: brightness(1);
  }

  50% {
    color: #ffffff;
    filter: brightness(1.65);
  }
}

.truth-bar {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  border: 1px solid #1f2937;
  border-top: 0;
  background: rgba(0, 0, 0, 0.58);
  padding: 12px;
}

.truth-metric {
  container-type: inline-size;
  display: flex;
  min-height: 112px;
  flex-direction: column;
  justify-content: center;
  border: 1px solid #111827;
  padding: 12px;
}

.truth-metric strong {
  margin-top: 7px;
  font-size: clamp(30px, 14cqw, 66px);
  line-height: 0.96;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 0 18px currentColor;
  white-space: nowrap;
}

.truth-metric .pending {
  color: #b026ff;
}

.fire-progress {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 2px;
}

.fire-progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: #9ca3af;
  font-size: 11px;
}

.fire-progress-head strong {
  color: #00ff88;
}

.fire-track {
  height: 8px;
  border: 1px solid #1f2937;
  background: #020617;
}

.fire-fill {
  height: 100%;
  min-width: 1px;
  background: linear-gradient(90deg, #b026ff, #00ff88);
  box-shadow: 0 0 18px rgba(0, 255, 136, 0.38);
}

.monthly-close-strip {
  grid-column: 10 / span 3;
  grid-row: 6;
  display: grid;
  grid-template-columns: 1fr;
  align-items: stretch;
  gap: 10px;
  border: 1px solid #1f2937;
  background: rgba(0, 0, 0, 0.62);
  padding: 10px 12px;
  position: relative;
}

.monthly-command,
.monthly-metrics > div,
.monthly-close-button {
  border: 1px solid #111827;
  background: rgba(2, 6, 23, 0.52);
}

.monthly-command {
  display: flex;
  flex-direction: column;
  gap: 4px;
  justify-content: center;
  padding: 10px;
}

.monthly-command span,
.monthly-command small,
.monthly-metrics span {
  color: #6b7280;
  font-size: 10px;
  font-weight: 900;
  text-transform: uppercase;
}

.monthly-command strong {
  color: #00e5ff;
  font-size: 18px;
  text-shadow: 0 0 12px rgba(0, 229, 255, 0.32);
}

.monthly-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.monthly-metrics > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
  justify-content: center;
  padding: 10px;
}

.monthly-metrics strong {
  color: #f9fafb;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.monthly-close-button {
  color: #00ff88;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0;
  outline: none;
  padding: 0 12px;
  text-transform: uppercase;
}

.monthly-close-button:hover:not(:disabled) {
  border-color: #00ff88;
  box-shadow: 0 0 14px rgba(0, 255, 136, 0.28);
}

.monthly-close-button:disabled {
  color: #6b7280;
  cursor: not-allowed;
}

.monthly-actions {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.backup-button {
  color: #00e5ff;
}

.monthly-error {
  grid-column: 1 / -1;
  margin: 0;
  color: #ff365e;
  font-size: 11px;
}

.lifeos-workspace {
  display: contents;
}

.cash-debt-panel {
  grid-column: 1 / span 3;
  grid-row: 3;
  min-height: 430px;
}

.portfolio-workbench {
  grid-column: 4 / span 6;
  grid-row: 3 / span 2;
  min-height: 560px;
}

.quick-entry-panel {
  grid-column: 10 / span 3;
  grid-row: 3;
  min-height: 430px;
}

.portfolio-workbench {
  min-width: 0;
}

.portfolio-header-actions {
  display: flex;
  min-width: 180px;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.portfolio-header-actions button {
  border: 1px solid rgba(0, 255, 136, 0.42);
  border-radius: 0;
  background: rgba(0, 255, 136, 0.06);
  color: #00ff88;
  cursor: pointer;
  font: inherit;
  font-size: 10px;
  font-weight: 900;
  outline: none;
  padding: 5px 8px;
  white-space: nowrap;
}

.portfolio-header-actions button:hover:not(:disabled) {
  border-color: #00ff88;
  box-shadow: 0 0 12px rgba(0, 255, 136, 0.26);
}

.portfolio-header-actions button:disabled {
  border-color: #1f2937;
  color: #4b5563;
  cursor: not-allowed;
  box-shadow: none;
}

.portfolio-header-actions small {
  max-width: 210px;
}

.panel-body-stack {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  overflow: auto;
  padding: 10px;
}

.compact-table th,
.compact-table td {
  padding-top: 7px;
  padding-bottom: 7px;
  white-space: nowrap;
}

.compact-table {
  min-width: 520px;
}

.cashflow-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.cashflow-summary-grid > div,
.quick-entry-summary > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
  border: 1px solid #111827;
  background: rgba(2, 6, 23, 0.52);
  overflow: hidden;
  padding: 10px;
}

.cashflow-summary-grid span,
.quick-entry-summary span {
  color: #6b7280;
  font-size: 10px;
  font-weight: 900;
  text-transform: uppercase;
}

.cashflow-summary-grid strong,
.quick-entry-summary strong {
  color: #f9fafb;
  font-size: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cashflow-summary-grid input {
  width: 100%;
  border: 1px solid rgba(0, 229, 255, 0.18);
  border-radius: 0;
  background: #020617;
  color: #00ff88;
  font: inherit;
  font-size: 12px;
  outline: none;
  padding: 7px 8px;
  text-align: right;
}

.quick-entry-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: auto;
  padding: 0 10px 10px;
}

.budget-nexus-grid {
  display: contents;
}

.budget-panel {
  grid-column: 1 / span 3;
  grid-row: 4 / span 3;
  min-height: 520px;
}

.calendar-panel {
  grid-column: 4 / span 6;
  grid-row: 5;
  min-height: 360px;
}

.nexus-panel {
  grid-column: 10 / span 3;
  grid-row: 4 / span 2;
  min-height: 260px;
}

.history-grid {
  display: contents;
}

.history-panel {
  grid-column: 4 / span 6;
  grid-row: 6;
  min-height: 230px;
}

.settlement-history-panel {
  grid-column: 10 / span 3;
  grid-row: 7;
  min-height: 230px;
}

.core-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding-top: 10px;
}

.grid-panel {
  container-type: inline-size;
  display: flex;
  min-height: 330px;
  flex-direction: column;
  border: 1px solid #1f2937;
  background: rgba(0, 0, 0, 0.58);
}

.panel-header {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) minmax(0, auto);
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid #111827;
  padding: 9px 10px;
}

.panel-header strong {
  color: #f9fafb;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-header small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-scroll {
  overflow: auto;
}

.terminal-table {
  width: 100%;
  border-collapse: collapse;
  color: #cbd5e1;
  font-size: 12px;
  table-layout: fixed;
  text-align: left;
}

.terminal-table th {
  border-bottom: 1px solid #1f2937;
  color: #6b7280;
  font-size: 10px;
  font-weight: 800;
  overflow: hidden;
  padding: 8px 10px;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.terminal-table td {
  border-bottom: 1px solid #111827;
  overflow: hidden;
  overflow-wrap: anywhere;
  padding: 8px 10px;
  text-overflow: ellipsis;
  vertical-align: middle;
}

.terminal-table input {
  width: 100%;
  min-width: 0;
  border: 1px solid rgba(0, 229, 255, 0.18);
  border-radius: 0;
  background: #020617;
  color: #00ff88;
  font: inherit;
  font-size: 12px;
  outline: none;
  padding: 6px 8px;
  text-align: right;
}

.terminal-table input:focus {
  border-color: #00e5ff;
  box-shadow: 0 0 12px rgba(0, 229, 255, 0.22);
}

.terminal-table input:disabled,
.terminal-table select:disabled,
.daily-expense-form input:disabled,
.daily-expense-form select:disabled {
  border-color: #111827;
  background: rgba(2, 6, 23, 0.35);
  color: #64748b;
  cursor: not-allowed;
}

.terminal-table input[type="text"] {
  color: #cbd5e1;
  text-align: left;
}

.portfolio-table {
  min-width: 980px;
}

.section-row td {
  background: rgba(176, 38, 255, 0.08);
  color: #b026ff;
  font-size: 10px;
  font-weight: 900;
  text-transform: uppercase;
}

.section-row-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-row-content button,
.sell-remove-button,
.buy-record-button {
  border: 1px solid rgba(0, 255, 136, 0.38);
  border-radius: 0;
  background: rgba(0, 255, 136, 0.06);
  color: #00ff88;
  cursor: pointer;
  font: inherit;
  font-size: 10px;
  font-weight: 900;
  outline: none;
  padding: 5px 8px;
}

.section-row-content button:hover:not(:disabled),
.buy-record-button:hover:not(:disabled) {
  border-color: #00ff88;
  box-shadow: 0 0 12px rgba(0, 255, 136, 0.26);
}

.stock-action-stack {
  display: grid;
  grid-template-columns: 1fr;
  gap: 5px;
}

.buy-record-button {
  white-space: nowrap;
}

.sell-remove-button {
  border-color: rgba(255, 54, 94, 0.5);
  background: rgba(255, 54, 94, 0.06);
  color: #ff365e;
  white-space: nowrap;
}

.sell-remove-button:hover:not(:disabled) {
  border-color: #ff365e;
  box-shadow: 0 0 12px rgba(255, 54, 94, 0.26);
}

.section-row-content button:disabled,
.sell-remove-button:disabled,
.buy-record-button:disabled,
.transaction-delete-button:disabled,
.transaction-cancel-button:disabled,
.undo-transaction-banner button:disabled {
  border-color: #1f2937;
  color: #4b5563;
  cursor: not-allowed;
  box-shadow: none;
}

.symbol-cell {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.symbol-cell strong {
  color: #f9fafb;
  font-size: 12px;
}

.symbol-cell .symbol-input {
  min-width: 0;
  text-align: left;
}

.symbol-cell .symbol-input.muted {
  color: #94a3b8;
}

.cashflow-table {
  margin-top: 10px;
}

.panel-total {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
  margin-top: auto;
  border-top: 1px solid #1f2937;
}

.panel-total > div {
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-right: 1px solid #111827;
  padding: 10px;
}

.panel-total > div:last-child {
  border-right: 0;
}

.panel-total strong {
  color: #f9fafb;
  font-size: 17px;
}

.placeholder-feed {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: 13px;
  padding: 18px;
}

.budget-stack {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
  overflow: auto;
  padding: 10px;
}

.budget-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}

.budget-summary span,
.transactions-panel header,
.nexus-feed,
.daily-expense-form {
  border: 1px solid #111827;
  background: rgba(2, 6, 23, 0.52);
  color: #9ca3af;
  font-size: 11px;
  font-weight: 800;
  padding: 9px;
}

.budget-summary span,
.nexus-feed,
.undo-transaction-banner,
.selected-date-summary > div {
  min-width: 0;
  overflow: hidden;
}

.budget-summary span,
.nexus-feed p,
.undo-transaction-banner span,
.selected-date-summary strong {
  overflow: hidden;
  text-overflow: ellipsis;
}

.budget-calendar {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
  overflow: auto;
  padding: 10px;
}

.calendar-weekdays,
.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(42px, 1fr));
  gap: 3px;
}

.calendar-weekdays span {
  color: #6b7280;
  font-size: 10px;
  font-weight: 900;
  text-align: center;
}

.calendar-day {
  container-type: inline-size;
  display: flex;
  position: relative;
  min-height: clamp(44px, 16cqw, 62px);
  flex-direction: column;
  gap: 3px;
  border: 1px solid #111827;
  border-radius: 0;
  background: rgba(2, 6, 23, 0.55);
  color: #cbd5e1;
  cursor: pointer;
  font: inherit;
  outline: none;
  overflow: hidden;
  padding: 6px;
  text-align: left;
}

.calendar-day:hover {
  border-color: #00e5ff;
  box-shadow: 0 0 12px rgba(0, 229, 255, 0.18);
}

.calendar-day.is-muted {
  opacity: 0.35;
}

.calendar-day.is-today {
  border-color: rgba(176, 38, 255, 0.85);
}

.calendar-day.is-selected {
  border-color: #00ff88;
  box-shadow: 0 0 16px rgba(0, 255, 136, 0.26);
}

.calendar-day.has-expense {
  background: linear-gradient(135deg, rgba(255, 54, 94, 0.12), rgba(2, 6, 23, 0.55) 55%);
}

.calendar-day.has-income {
  background: linear-gradient(135deg, rgba(0, 255, 136, 0.13), rgba(2, 6, 23, 0.55) 55%);
}

.calendar-day.has-transfer {
  background: linear-gradient(135deg, rgba(176, 38, 255, 0.13), rgba(2, 6, 23, 0.55) 55%);
}

.calendar-day.has-expense.has-income {
  background:
    linear-gradient(135deg, rgba(0, 255, 136, 0.14), transparent 45%),
    linear-gradient(315deg, rgba(255, 54, 94, 0.13), rgba(2, 6, 23, 0.55) 55%);
}

.calendar-day.has-expense.has-transfer {
  background:
    linear-gradient(135deg, rgba(255, 54, 94, 0.12), transparent 45%),
    linear-gradient(315deg, rgba(176, 38, 255, 0.13), rgba(2, 6, 23, 0.55) 55%);
}

.calendar-day.has-income.has-transfer {
  background:
    linear-gradient(135deg, rgba(0, 255, 136, 0.13), transparent 45%),
    linear-gradient(315deg, rgba(176, 38, 255, 0.13), rgba(2, 6, 23, 0.55) 55%);
}

.calendar-day.has-expense.has-income.has-transfer {
  background:
    linear-gradient(135deg, rgba(0, 255, 136, 0.13), transparent 34%),
    linear-gradient(225deg, rgba(255, 54, 94, 0.12), transparent 50%),
    linear-gradient(315deg, rgba(176, 38, 255, 0.13), rgba(2, 6, 23, 0.55) 60%);
}

.calendar-day-number {
  color: #f9fafb;
  font-size: clamp(10px, 18cqw, 12px);
  font-weight: 900;
}

.calendar-day small {
  display: block;
  max-width: calc(100% - 12px);
  overflow: hidden;
  font-size: clamp(8px, 14cqw, 10px);
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.calendar-day em {
  position: absolute;
  top: 5px;
  right: 6px;
  max-width: 14px;
  color: #00e5ff;
  font-size: 10px;
  font-style: normal;
  font-weight: 900;
  overflow: hidden;
  text-overflow: clip;
}

.selected-date-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.selected-date-summary > div {
  display: flex;
  flex-direction: column;
  gap: 5px;
  border: 1px solid #111827;
  background: rgba(2, 6, 23, 0.52);
  padding: 9px;
}

.selected-date-summary span {
  color: #6b7280;
  font-size: 10px;
  font-weight: 900;
  text-transform: uppercase;
}

.selected-date-summary strong {
  color: #f9fafb;
  font-size: 13px;
}

.undo-transaction-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid rgba(176, 38, 255, 0.55);
  background: rgba(176, 38, 255, 0.08);
  color: #cbd5e1;
  font-size: 11px;
  font-weight: 800;
  padding: 8px 9px;
}

.undo-transaction-banner button {
  border: 1px solid rgba(0, 255, 136, 0.45);
  border-radius: 0;
  background: rgba(0, 255, 136, 0.08);
  color: #00ff88;
  cursor: pointer;
  font: inherit;
  font-size: 10px;
  font-weight: 900;
  outline: none;
  padding: 5px 9px;
}

.undo-transaction-banner button:hover {
  border-color: #00ff88;
  box-shadow: 0 0 12px rgba(0, 255, 136, 0.24);
}

.selected-date-table {
  min-width: 680px;
}

.selected-date-table td:nth-child(1) {
  width: 148px;
}

.selected-date-table td:nth-child(3) {
  width: 128px;
}

.selected-date-table td:nth-child(5) {
  width: 78px;
}

.selected-date-table select {
  width: 100%;
  min-width: 118px;
  max-width: 100%;
  border: 1px solid rgba(0, 229, 255, 0.18);
  border-radius: 0;
  background: #020617;
  color: #cbd5e1;
  font: inherit;
  font-size: 12px;
  outline: none;
  padding: 6px 8px;
}

.selected-date-table input {
  min-width: 90px;
  max-width: 100%;
}

.transaction-confirm-actions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(42px, 1fr));
  gap: 5px;
}

.transaction-delete-button {
  width: 100%;
  border: 1px solid rgba(255, 54, 94, 0.5);
  border-radius: 0;
  background: rgba(255, 54, 94, 0.06);
  color: #ff365e;
  cursor: pointer;
  font: inherit;
  font-size: 10px;
  font-weight: 900;
  outline: none;
  padding: 6px 8px;
}

.transaction-delete-button:hover {
  border-color: #ff365e;
  box-shadow: 0 0 12px rgba(255, 54, 94, 0.26);
}

.transaction-delete-button.is-confirm {
  background: rgba(255, 54, 94, 0.16);
  color: #ff365e;
}

.transaction-cancel-button {
  width: 100%;
  border: 1px solid rgba(0, 229, 255, 0.36);
  border-radius: 0;
  background: rgba(0, 229, 255, 0.06);
  color: #00e5ff;
  cursor: pointer;
  font: inherit;
  font-size: 10px;
  font-weight: 900;
  outline: none;
  padding: 6px 8px;
}

.transaction-cancel-button:hover {
  border-color: #00e5ff;
  box-shadow: 0 0 12px rgba(0, 229, 255, 0.22);
}

.daily-expense-form {
  display: grid;
  grid-template-columns: 130px minmax(120px, 0.9fr) minmax(160px, 1.2fr) minmax(100px, 0.8fr) 108px;
  gap: 8px;
}

.daily-expense-form header {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.daily-expense-form header strong {
  color: #00e5ff;
}

.quick-entry-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.quick-entry-tabs button {
  border: 1px solid #1f2937;
  border-radius: 0;
  background: rgba(2, 6, 23, 0.65);
  color: #94a3b8;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 900;
  outline: none;
  padding: 7px 8px;
}

.quick-entry-tabs button.active {
  border-color: #00ff88;
  background: rgba(0, 255, 136, 0.08);
  color: #00ff88;
  box-shadow: 0 0 12px rgba(0, 255, 136, 0.2);
}

.quick-entry-tabs button:disabled {
  color: #4b5563;
  cursor: not-allowed;
  box-shadow: none;
}

.daily-expense-form input,
.daily-expense-form select,
.daily-expense-form button {
  min-width: 0;
  border: 1px solid rgba(0, 229, 255, 0.18);
  border-radius: 0;
  background: #020617;
  color: #00ff88;
  font: inherit;
  outline: none;
  padding: 7px 8px;
}

.daily-expense-form input[type="text"],
.daily-expense-form select {
  color: #cbd5e1;
}

.daily-expense-form button {
  border-color: rgba(0, 255, 136, 0.42);
  cursor: pointer;
  font-weight: 900;
}

.daily-expense-form button:hover:not(:disabled) {
  border-color: #00ff88;
  box-shadow: 0 0 12px rgba(0, 255, 136, 0.24);
}

.daily-expense-form button:disabled {
  color: #4b5563;
  cursor: not-allowed;
  box-shadow: none;
}

.quick-entry-tabs button {
  border-color: #1f2937;
  background: rgba(2, 6, 23, 0.65);
  color: #94a3b8;
}

.quick-entry-tabs button.active {
  border-color: #00ff88;
  background: rgba(0, 255, 136, 0.08);
  color: #00ff88;
  box-shadow: 0 0 12px rgba(0, 255, 136, 0.2);
}

.daily-expense-form--stacked {
  grid-template-columns: 1fr;
  margin: 10px;
}

.daily-expense-form--stacked label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.daily-expense-form--stacked label span {
  color: #6b7280;
  font-size: 10px;
  font-weight: 900;
  text-transform: uppercase;
}

.daily-expense-form--stacked input,
.daily-expense-form--stacked select,
.daily-expense-form--stacked button {
  width: 100%;
}

.transactions-panel header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 0;
}

.transactions-panel header strong {
  color: #00e5ff;
}

.transactions-table td:nth-child(1) {
  width: 96px;
  color: #6b7280;
}

.transactions-table td:nth-child(2) {
  color: #d1d5db;
}

.transactions-table td:nth-child(3) {
  width: 160px;
}

.nexus-feed {
  border-color: rgba(176, 38, 255, 0.45);
}

.nexus-source-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 10px 0;
}

.nexus-actions {
  display: flex;
  justify-content: flex-end;
  padding: 10px 10px 0;
}

.nexus-action-button {
  background: rgba(176, 38, 255, 0.08);
  border: 1px solid rgba(176, 38, 255, 0.75);
  color: #b026ff;
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  font-weight: 900;
  min-height: 30px;
  padding: 0 12px;
}

.nexus-action-button:disabled {
  border-color: rgba(107, 114, 128, 0.6);
  color: #6b7280;
  cursor: wait;
}

.nexus-action-button:not(:disabled):hover {
  border-color: #00ff88;
  color: #00ff88;
}

.nexus-source-chip {
  border: 1px solid rgba(0, 229, 255, 0.42);
  background: rgba(0, 229, 255, 0.06);
  color: #00e5ff;
  font-size: 10px;
  font-weight: 900;
  line-height: 1;
  padding: 5px 7px;
  text-transform: uppercase;
}

.nexus-feed--thinking {
  border-color: rgba(176, 38, 255, 0.88);
  animation: nexusPulse 1s ease-in-out infinite alternate;
}

.nexus-feed--error {
  border-color: rgba(255, 54, 94, 0.72);
}

.nexus-feed strong {
  display: block;
  color: #b026ff;
  margin-bottom: 8px;
}

.nexus-feed p {
  margin: 6px 0 0;
  color: #00e5ff;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.debate-feed {
  display: grid;
  gap: 10px;
}

.debate-agent {
  border-left: 2px solid rgba(0, 229, 255, 0.7);
  padding: 2px 0 2px 10px;
}

.debate-agent strong {
  margin-bottom: 4px;
}

.debate-agent--alpha {
  border-left-color: #00e5ff;
}

.debate-agent--alpha strong,
.debate-agent--alpha p {
  color: #00e5ff;
}

.debate-agent--beta {
  border-left-color: #f59e0b;
}

.debate-agent--beta strong,
.debate-agent--beta p {
  color: #f59e0b;
}

.debate-agent--prime {
  border-left-color: #b026ff;
}

.debate-agent--prime strong {
  color: #f8f4ff;
}

.debate-agent--prime p {
  color: #b026ff;
  font-weight: 900;
}

.debate-fade-enter-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.debate-fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.nexus-alert-line {
  margin-top: 10px;
  border-top: 1px solid rgba(255, 54, 94, 0.35);
  color: #ff365e;
  font-size: 11px;
  font-weight: 900;
  padding-top: 8px;
}

.terminal-cursor {
  color: #00ff88;
  animation: cursorBlink 0.85s step-end infinite;
}

@keyframes nexusPulse {
  from {
    box-shadow: inset 0 0 0 rgba(176, 38, 255, 0);
  }
  to {
    box-shadow: inset 0 0 20px rgba(176, 38, 255, 0.16), 0 0 16px rgba(176, 38, 255, 0.14);
  }
}

@keyframes cursorBlink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

.placeholder-feed strong {
  color: #00e5ff;
  font-size: 24px;
  text-shadow: 0 0 14px rgba(0, 229, 255, 0.28);
}

.placeholder-feed p {
  max-width: 620px;
  margin: 0;
  color: #9ca3af;
  font-size: 13px;
  line-height: 1.7;
}

.feed-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.feed-strip span {
  border: 1px solid #111827;
  color: #00ff88;
  font-size: 11px;
  font-weight: 800;
  overflow: hidden;
  padding: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.load-error {
  border-top: 1px solid #1f2937;
  color: #ff365e;
  font-size: 11px;
  padding: 10px;
}

.positive {
  color: #00ff88 !important;
}

.negative {
  color: #ff365e !important;
}

@container (max-width: 560px) {
  .cashflow-summary-grid,
  .budget-summary,
  .selected-date-summary,
  .feed-strip {
    grid-template-columns: 1fr;
  }

  .panel-total,
  .quick-entry-summary {
    grid-template-columns: 1fr;
  }

  .panel-header {
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 8px;
  }

  .panel-header small {
    grid-column: 2;
    justify-self: start;
  }

  .terminal-table {
    font-size: 11px;
  }
}

@container (max-width: 64px) {
  .calendar-day {
    min-height: 42px;
    padding: 4px;
  }

  .calendar-day small {
    max-width: 100%;
  }

  .calendar-day em {
    top: 3px;
    right: 4px;
    transform: scale(0.85);
    transform-origin: top right;
  }
}

@container (max-width: 48px) {
  .calendar-day small {
    display: none;
  }
}

@media (max-width: 1480px) {
  .lifeos-grid-dashboard {
    grid-template-columns: repeat(12, minmax(0, 1fr));
  }
}

@media (max-width: 920px) {
  .truth-metric strong {
    white-space: normal;
  }

  .terminal-status,
  .fire-progress-head,
  .daily-expense-form header {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 1180px) {
  .lifeos-grid-dashboard {
    grid-template-columns: 1fr;
  }

  .cash-debt-panel,
  .portfolio-workbench,
  .quick-entry-panel,
  .budget-panel,
  .calendar-panel,
  .nexus-panel,
  .history-panel,
  .settlement-history-panel,
  .monthly-close-strip {
    grid-column: 1;
    grid-row: auto;
  }

  .truth-bar,
  .core-grid,
  .lifeos-workspace,
  .budget-nexus-grid,
  .history-grid,
  .monthly-close-strip,
  .monthly-metrics,
  .daily-expense-form {
    grid-template-columns: 1fr;
  }

  .terminal-header,
  .terminal-status {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>

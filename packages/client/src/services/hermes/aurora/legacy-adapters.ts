import { fetchMemory, type MemoryData } from '@/api/hermes/skills'
import {
  generateLifeOsBriefing,
  getLifeOsState,
  type LifeOsBriefingGenerateResponse,
  type LifeOsBudgetCategoryMetric,
  type LifeOsState,
  type LifeOsStockItemWithMetrics,
} from '@/api/hermes/life-os'
import {
  createTask,
  getStats,
  listTasks,
  type KanbanCreateRequest,
  type KanbanStats,
  type KanbanTask,
} from '@/api/hermes/kanban'
import {
  getQuantLabPhaseValidation,
  getQuantLabSnapshot,
  updateQuantLabPaperAccount,
  type QuantLabPaperAccount,
  type QuantLabPhaseValidationReport,
  type QuantLabTopPick,
} from '@/api/hermes/quant-lab'
import { DEFAULT_KANBAN_BOARD, normalizeBoardSlug } from '@/stores/hermes/kanban'

export interface LegacyTaskQuery {
  board?: string
  today?: boolean
  includeDone?: boolean
}

export interface LegacyTaskResult {
  board: string
  tasks: KanbanTask[]
  activeTasks: KanbanTask[]
  createdToday: KanbanTask[]
  completedToday: KanbanTask[]
  stats: KanbanStats | null
  raw: {
    board: string
    tasks: KanbanTask[]
    stats: KanbanStats | null
  }
}

export interface LegacyMemorySearchResult {
  query: string
  matches: Array<{
    section: keyof Pick<MemoryData, 'memory' | 'user' | 'soul'>
    title: string
    snippet: string
  }>
  raw: MemoryData
}

export interface LifeOsOverviewResult {
  state: LifeOsState
  metrics: LifeOsState['computedMetrics']
  budgetBreaches: LifeOsBudgetCategoryMetric[]
  topPortfolio: Array<LifeOsStockItemWithMetrics & { rank: number }>
  raw: LifeOsState
}

export interface QuantTop10Result {
  generatedAt: string
  source: string
  topPicks: QuantLabTopPick[]
  decision: Awaited<ReturnType<typeof getQuantLabSnapshot>>['decision']
  dataHealth: Awaited<ReturnType<typeof getQuantLabSnapshot>>['dataHealth']
  raw: Awaited<ReturnType<typeof getQuantLabSnapshot>>
}

export interface QuantPhaseCheckResult {
  report: QuantLabPhaseValidationReport
  passedCount: number
  totalCount: number
  firstFailed: QuantLabPhaseValidationReport['firstFailedPhase']
  raw: QuantLabPhaseValidationReport
}

export interface QuantPaperJournalRequest {
  ticker?: string
  note: string
  journalAction?: 'BUY' | 'SELL' | 'HOLD' | 'WATCH' | 'MARK' | 'RESET'
}

function getSelectedBoard(): string {
  if (typeof window === 'undefined') return DEFAULT_KANBAN_BOARD
  try {
    return normalizeBoardSlug(window.localStorage.getItem('hermes.kanban.selectedBoard'))
  } catch {
    return DEFAULT_KANBAN_BOARD
  }
}

function toMs(timestamp: number | null | undefined): number {
  if (!timestamp) return 0
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000
}

function isToday(timestamp: number | null | undefined): boolean {
  const ms = toMs(timestamp)
  if (!ms) return false
  const date = new Date(ms)
  const now = new Date()
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  )
}

function isActiveTask(task: KanbanTask): boolean {
  return task.status !== 'done' && task.status !== 'archived'
}

export async function queryLegacyKanbanTasks(query: LegacyTaskQuery = {}): Promise<LegacyTaskResult> {
  const board = normalizeBoardSlug(query.board || getSelectedBoard())
  const includeDone = query.includeDone === true
  const tasks = await listTasks({ board, includeArchived: false })
  const stats = await getStats({ board }).catch(() => null)

  const activeTasks = tasks.filter(isActiveTask)
  const createdToday = tasks.filter(task => isToday(task.created_at))
  const completedToday = tasks.filter(task => isToday(task.completed_at))
  const visibleTasks = query.today
    ? tasks.filter(task =>
        isActiveTask(task) ||
        isToday(task.created_at) ||
        isToday(task.completed_at),
      )
    : tasks

  return {
    board,
    tasks: includeDone ? visibleTasks : visibleTasks.filter(task => task.status !== 'archived'),
    activeTasks,
    createdToday,
    completedToday,
    stats,
    raw: {
      board,
      tasks: visibleTasks,
      stats,
    },
  }
}

export async function createLegacyKanbanTask(
  request: KanbanCreateRequest,
  opts: { board?: string } = {},
): Promise<KanbanTask> {
  const board = normalizeBoardSlug(opts.board || getSelectedBoard())
  return createTask(request, { board })
}

function normalizeSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，.。:：;；!?！？]+/)
    .map(term => term.trim())
    .filter(term => term.length >= 2)
}

function makeSnippet(content: string, terms: string[]): string {
  const clean = content.replace(/§/g, '\n\n').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const lower = clean.toLowerCase()
  const hit = terms
    .map(term => lower.indexOf(term))
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0]
  const start = hit == null ? 0 : Math.max(0, hit - 56)
  const snippet = clean.slice(start, start + 180)
  return `${start > 0 ? '...' : ''}${snippet}${start + snippet.length < clean.length ? '...' : ''}`
}

export async function searchLegacyMemory(query: string): Promise<LegacyMemorySearchResult> {
  const raw = await fetchMemory()
  const terms = normalizeSearchTerms(query)
  const sections: Array<{
    key: keyof Pick<MemoryData, 'memory' | 'user' | 'soul'>
    title: string
    content: string
  }> = [
    { key: 'memory', title: 'My Notes', content: raw.memory || '' },
    { key: 'user', title: 'User Profile', content: raw.user || '' },
    { key: 'soul', title: 'Soul', content: raw.soul || '' },
  ]

  const matches = sections
    .filter(section => {
      const content = section.content.toLowerCase()
      return terms.length === 0
        ? section.content.trim().length > 0
        : terms.some(term => content.includes(term))
    })
    .map(section => ({
      section: section.key,
      title: section.title,
      snippet: makeSnippet(section.content, terms),
    }))
    .filter(match => match.snippet.length > 0)

  return {
    query,
    matches,
    raw,
  }
}

export async function readLifeOsOverview(): Promise<LifeOsOverviewResult> {
  const state = await getLifeOsState()
  const metrics = state.computedMetrics
  const budgetBreaches = metrics.budgetMetrics.categories.filter(category => (
    category.id !== 'investing' && category.remaining < 0
  ))
  const topPortfolio = [
    ...metrics.usStockMetrics.items,
    ...metrics.domesticStockMetrics.items,
  ]
    .sort((a, b) => b.marketValueTwd - a.marketValueTwd)
    .slice(0, 5)
    .map((item, index) => ({ ...item, rank: index + 1 }))

  return {
    state,
    metrics,
    budgetBreaches,
    topPortfolio,
    raw: state,
  }
}

export async function generateLifeOsTacticalBriefing(): Promise<LifeOsBriefingGenerateResponse> {
  return generateLifeOsBriefing()
}

export async function readQuantTop10(): Promise<QuantTop10Result> {
  const snapshot = await getQuantLabSnapshot()
  return {
    generatedAt: snapshot.generatedAt,
    source: snapshot.source,
    topPicks: snapshot.topPicks.slice(0, 10),
    decision: snapshot.decision,
    dataHealth: snapshot.dataHealth,
    raw: snapshot,
  }
}

export async function runQuantPhaseCheck(): Promise<QuantPhaseCheckResult> {
  const report = await getQuantLabPhaseValidation({ ensure: false })
  const passedCount = report.phases.filter(phase => phase.status === 'PASS').length
  return {
    report,
    passedCount,
    totalCount: report.phases.length,
    firstFailed: report.firstFailedPhase,
    raw: report,
  }
}

export async function createQuantPaperJournalEntry(
  request: QuantPaperJournalRequest,
): Promise<QuantLabPaperAccount> {
  return updateQuantLabPaperAccount({
    action: 'JOURNAL',
    ticker: request.ticker,
    journalAction: request.journalAction || 'WATCH',
    note: request.note,
  })
}

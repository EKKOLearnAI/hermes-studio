import type { KanbanTask } from '@/api/hermes/kanban'
import type { LifeOsBriefingGenerateResponse } from '@/api/hermes/life-os'
import type { QuantLabPaperAccount } from '@/api/hermes/quant-lab'
import { getAuroraAppCapability, type AuroraAppKind } from './capability-manifest'
import type {
  AuroraToolExecution,
  GeneratedWidgetListResult,
  GeneratedWidgetLoadResult,
  LegacyAppOpenResult,
} from './tool-registry'
import type {
  LegacyMemorySearchResult,
  LegacyTaskResult,
  LifeOsOverviewResult,
  QuantPhaseCheckResult,
  QuantTop10Result,
} from './legacy-adapters'
import type { CandidateMemory } from '@/stores/hermes/memory-queue'

export interface AuroraResultItem {
  id: string
  title: string
  meta?: string
  status?: string
  priority?: number
}

export interface AuroraResultSection {
  title: string
  body?: string
  items?: AuroraResultItem[]
}

export interface AuroraResultStat {
  id: string
  label: string
  value: string
  detail?: string
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
}

export interface AuroraTaskWidgetItem {
  id: string
  title: string
  body?: string
  meta?: string
  status: string
  priority: number
  assignee?: string
  checked: boolean
}

export interface AuroraQuantWidgetPick {
  id: string
  ticker: string
  score: string
  action: string
  risk: string
  price: string
  trend: string
  reason: string
  confidence?: string
  tone?: 'buy' | 'hold' | 'watch' | 'sell' | 'neutral'
}

export interface AuroraMemoryWidgetSnippet {
  id: string
  title: string
  snippet: string
  source: string
  confidence: string
}

export interface AuroraFinancialWidgetLine {
  id: string
  label: string
  value: string
  detail?: string
  tone?: AuroraResultStat['tone']
}

export interface AuroraResultWidgetAppAction {
  kind: AuroraAppKind
  label: string
  payload?: Record<string, unknown> | null
}

export type AuroraResultWidget = (
  | {
      type: 'task-list'
      title: string
      emptyText: string
      stats: AuroraResultStat[]
      tasks: AuroraTaskWidgetItem[]
    }
  | {
      type: 'metric-grid'
      title: string
      metrics: AuroraResultStat[]
      picks: AuroraQuantWidgetPick[]
      footer?: string
    }
  | {
      type: 'financial-dashboard'
      title: string
      metrics: AuroraResultStat[]
      budgetLines: AuroraFinancialWidgetLine[]
      portfolioLines: AuroraFinancialWidgetLine[]
      footer?: string
    }
  | {
      type: 'memory-snippets'
      title: string
      query: string
      emptyText: string
      snippets: AuroraMemoryWidgetSnippet[]
    }
  | {
      type: 'generated-widget'
      title: string
      widgetName: string
      componentPath: string
      requestedAt: string
    }
  | {
      type: 'generated-widget-library'
      title: string
      emptyText: string
      widgets: Array<{
        id: string
        widgetName: string
        componentPath: string
        deployedAt: string | null
        buildId: string | null
        spec: string | null
        source: string
        securityStatus: 'passed' | 'blocked'
        permissions?: {
          network: boolean
          localStorage: boolean
          workingMemory: boolean
          cookies: boolean
          filesystem: boolean
        }
        loadable: boolean
      }>
      generatedAt: string
      manifestSource: 'backend' | 'bundle-fallback'
    }
  | {
      type: 'app-launch'
      title: string
    }
) & {
  app?: AuroraResultWidgetAppAction
}

export interface AuroraResult {
  id: string
  title: string
  subtitle: string
  toolName: string
  securityLevel: AuroraToolExecution['securityLevel']
  summary: string
  sections: AuroraResultSection[]
  rawJson: string
  widget?: AuroraResultWidget
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function formatTimestamp(timestamp: number | null | undefined): string {
  if (!timestamp) return ''
  const ms = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

function formatIsoTimestamp(timestamp: string | null | undefined): string {
  if (!timestamp) return ''
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function formatTwd(value: number): string {
  return `NT$${Math.round(value).toLocaleString()}`
}

function formatCurrency(value: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatPercent(value: number, digits = 1): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function taskToItem(task: KanbanTask): AuroraResultItem {
  const createdAt = formatTimestamp(task.created_at)
  const owner = task.assignee ? `@${task.assignee}` : 'unassigned'
  return {
    id: task.id,
    title: task.title,
    meta: [task.id, owner, createdAt].filter(Boolean).join(' · '),
    status: task.status,
    priority: task.priority,
  }
}

function taskToWidgetItem(task: KanbanTask): AuroraTaskWidgetItem {
  const createdAt = formatTimestamp(task.created_at)
  const owner = task.assignee ? `@${task.assignee}` : 'unassigned'
  return {
    id: task.id,
    title: task.title,
    body: task.body || undefined,
    meta: [task.id, owner, createdAt].filter(Boolean).join(' · '),
    status: task.status,
    priority: task.priority,
    assignee: task.assignee || undefined,
    checked: task.status === 'done',
  }
}

function formatTaskResult(result: LegacyTaskResult, tool: AuroraToolExecution): AuroraResult {
  const visible = result.tasks
    .filter(task => task.status !== 'archived')
    .sort((a, b) => {
      const statusRank = Number(a.status === 'done') - Number(b.status === 'done')
      if (statusRank !== 0) return statusRank
      return b.created_at - a.created_at
    })
    .slice(0, 12)

  const summary = [
    `${result.activeTasks.length} active`,
    `${result.createdToday.length} created today`,
    `${result.completedToday.length} completed today`,
  ].join(' · ')

  return {
    id: makeId('tasks'),
    title: 'Today Tasks',
    subtitle: `Legacy Kanban · board: ${result.board}`,
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary,
    sections: [
      {
        title: visible.length ? 'Current task lane' : 'Current task lane',
        body: visible.length ? undefined : 'No active or updated tasks were returned by the Kanban backend.',
        items: visible.map(taskToItem),
      },
    ],
    rawJson: JSON.stringify(result.raw, null, 2),
    widget: {
      type: 'task-list',
      title: 'Task Widget',
      emptyText: 'No active or updated tasks were returned by the Kanban backend.',
      stats: [
        {
          id: 'active',
          label: 'Active',
          value: String(result.activeTasks.length),
          tone: result.activeTasks.length ? 'info' : 'neutral',
        },
        {
          id: 'created-today',
          label: 'Created Today',
          value: String(result.createdToday.length),
          tone: result.createdToday.length ? 'success' : 'neutral',
        },
        {
          id: 'completed-today',
          label: 'Completed Today',
          value: String(result.completedToday.length),
          tone: result.completedToday.length ? 'success' : 'neutral',
        },
      ],
      tasks: visible.map(taskToWidgetItem),
    },
  }
}

function formatMemoryResult(result: LegacyMemorySearchResult, tool: AuroraToolExecution): AuroraResult {
  const confidenceBySource: Record<string, string> = {
    memory: '95%',
    user: '90%',
    soul: '86%',
  }

  return {
    id: makeId('memory'),
    title: 'Memory Search',
    subtitle: 'Legacy Memory',
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary: result.matches.length
      ? `${result.matches.length} matching section${result.matches.length > 1 ? 's' : ''}`
      : 'No matching memory sections found.',
    sections: [
      {
        title: 'Matches',
        body: result.matches.length ? undefined : 'Try a more specific memory keyword.',
        items: result.matches.map(match => ({
          id: match.section,
          title: match.title,
          meta: match.section,
          status: 'memory',
        })),
      },
      ...result.matches.map(match => ({
        title: match.title,
        body: match.snippet,
      })),
    ],
    rawJson: JSON.stringify(result.raw, null, 2),
    widget: {
      type: 'memory-snippets',
      title: 'Memory Widget',
      query: result.query,
      emptyText: 'No matching memory snippets were returned by the legacy Memory module.',
      snippets: result.matches.map(match => ({
        id: match.section,
        title: match.title,
        snippet: match.snippet,
        source: match.section,
        confidence: confidenceBySource[match.section] || '88%',
      })),
    },
  }
}

function formatCreateTaskResult(task: KanbanTask, tool: AuroraToolExecution): AuroraResult {
  return {
    id: makeId('created-task'),
    title: 'Task Created',
    subtitle: 'Legacy Kanban',
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary: `${task.title} was created in Kanban.`,
    sections: [
      {
        title: 'Created task',
        items: [taskToItem(task)],
      },
    ],
    rawJson: JSON.stringify(task, null, 2),
  }
}

function formatProposeMemoryResult(memory: CandidateMemory, tool: AuroraToolExecution): AuroraResult {
  return {
    id: makeId('candidate-memory'),
    title: 'Candidate Memory Queued',
    subtitle: 'Memory Governance',
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary: 'Aurora drafted a memory candidate for human review. No long-term memory was written.',
    sections: [
      {
        title: 'Candidate memory',
        body: memory.content,
        items: [
          {
            id: memory.id,
            title: `${memory.confidenceScore}% confidence`,
            meta: `${memory.source} · ${formatTimestamp(memory.timestamp)}`,
            status: memory.status,
          },
        ],
      },
    ],
    rawJson: JSON.stringify(memory, null, 2),
  }
}

function formatLifeOsOverviewResult(result: LifeOsOverviewResult, tool: AuroraToolExecution): AuroraResult {
  const metrics = result.metrics
  const summary = [
    `Net worth ${formatTwd(metrics.netWorth)}`,
    `FIRE ${metrics.fireProgress.toFixed(1)}%`,
    `${metrics.cashReserveMonths} reserve months`,
  ].join(' · ')

  return {
    id: makeId('lifeos-overview'),
    title: 'LifeOS Overview',
    subtitle: 'FIRE · Budget · Portfolio',
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary,
    sections: [
      {
        title: 'FIRE cockpit',
        items: [
          {
            id: 'net-worth',
            title: formatTwd(metrics.netWorth),
            meta: 'Net worth',
            status: `${metrics.fireProgress.toFixed(1)}% FIRE`,
          },
          {
            id: 'cash-reserve',
            title: `${metrics.cashReserveMonths} months`,
            meta: `Cash ${formatTwd(metrics.totalCash)}`,
            status: 'reserve',
          },
          {
            id: 'cashflow',
            title: formatTwd(metrics.netMonthlyCashFlow),
            meta: `Income minus baseline expenses ${formatTwd(metrics.totalExpenses)}`,
            status: 'monthly',
          },
        ],
      },
      {
        title: result.budgetBreaches.length ? 'Budget breaches' : 'Budget guard',
        body: result.budgetBreaches.length
          ? undefined
          : 'No non-investing budget breach was returned by LifeOS.',
        items: result.budgetBreaches.map(category => ({
          id: category.id,
          title: category.name,
          meta: `${formatTwd(category.spent)} spent / ${formatTwd(category.budgeted)} budgeted`,
          status: `${formatTwd(category.remaining)} remaining`,
        })),
      },
      {
        title: 'Largest portfolio exposures',
        items: result.topPortfolio.map(stock => ({
          id: `${stock.rank}-${stock.symbol}`,
          title: `${stock.rank}. ${stock.symbol}`,
          meta: `${stock.name || stock.currency} · ${formatTwd(stock.marketValueTwd)}`,
          status: formatPercent(stock.gainLossPct),
        })),
      },
    ],
    rawJson: JSON.stringify(result.raw, null, 2),
    widget: {
      type: 'financial-dashboard',
      title: 'LifeOS Financial Dashboard',
      metrics: [
        {
          id: 'net-worth',
          label: 'Total Net Worth',
          value: formatTwd(metrics.netWorth),
          detail: `Assets ${formatTwd(metrics.totalAssets)}`,
          tone: metrics.netWorth >= 0 ? 'success' : 'warning',
        },
        {
          id: 'fire-progress',
          label: 'FIRE Progress',
          value: `${metrics.fireProgress.toFixed(1)}%`,
          detail: `Target ${formatTwd(metrics.fireTarget)}`,
          tone: metrics.fireProgress >= 75 ? 'success' : metrics.fireProgress >= 35 ? 'info' : 'warning',
        },
        {
          id: 'cashflow',
          label: 'Monthly Cashflow',
          value: formatTwd(metrics.netMonthlyCashFlow),
          detail: `${metrics.cashReserveMonths.toFixed(1)} reserve months`,
          tone: metrics.netMonthlyCashFlow >= 0 ? 'success' : 'danger',
        },
      ],
      budgetLines: (result.budgetBreaches.length
        ? result.budgetBreaches
        : metrics.budgetMetrics.categories.slice(0, 3)
      ).map(category => ({
        id: category.id,
        label: category.name,
        value: formatTwd(category.remaining),
        detail: `${formatTwd(category.spent)} spent / ${formatTwd(category.budgeted)} budgeted`,
        tone: category.remaining < 0 ? 'danger' : category.remaining === 0 ? 'warning' : 'neutral',
      })),
      portfolioLines: result.topPortfolio.map(stock => ({
        id: `${stock.rank}-${stock.symbol}`,
        label: `${stock.rank}. ${stock.symbol}`,
        value: formatTwd(stock.marketValueTwd),
        detail: `${stock.name || stock.currency} · ${formatPercent(stock.gainLossPct)}`,
        tone: stock.gainLossPct >= 0 ? 'success' : 'danger',
      })),
      footer: `Cash reserve ${metrics.cashReserveMonths.toFixed(1)} months · Investment ratio ${metrics.investmentRatio.toFixed(1)}%`,
      app: {
        kind: 'life-os',
        label: '全螢幕展開',
      },
    },
  }
}

function formatLifeOsBriefingResult(result: LifeOsBriefingGenerateResponse, tool: AuroraToolExecution): AuroraResult {
  const debate = typeof result.debateFeed === 'object' && result.debateFeed
    ? result.debateFeed
    : null

  return {
    id: makeId('lifeos-briefing'),
    title: 'LifeOS Briefing',
    subtitle: `${result.mode} · ${result.date}`,
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary: result.content.split(/\n+/).find(Boolean)?.slice(0, 180) || 'LifeOS briefing generated.',
    sections: [
      {
        title: 'Signals',
        items: [
          {
            id: 'market-intel',
            title: result.marketIntelFound ? 'Market intel found' : 'No market intel',
            meta: result.watchSymbols.join(' / ') || 'No watch symbols',
            status: result.mode,
          },
          {
            id: 'wiki-context',
            title: result.wikiContextFound ? 'WIKI context found' : 'No WIKI context',
            meta: result.debateFound ? 'Debate available' : 'No debate feed',
            status: result.ok ? 'ready' : 'failed',
          },
        ],
      },
      ...(debate ? [
        { title: 'Alpha', body: debate.alpha },
        { title: 'Beta', body: debate.beta },
        { title: 'Prime', body: debate.prime },
      ] : []),
      {
        title: 'Briefing',
        body: result.content,
      },
    ],
    rawJson: JSON.stringify(result, null, 2),
  }
}

function formatQuantTop10Result(result: QuantTop10Result, tool: AuroraToolExecution): AuroraResult {
  const healthStatus = result.dataHealth.status || 'UNKNOWN'
  const healthTone: AuroraResultStat['tone'] =
    healthStatus === 'OK' ? 'success'
      : healthStatus === 'ERROR' ? 'danger'
        : healthStatus === 'DEGRADED' || healthStatus === 'FALLBACK' ? 'warning'
          : 'neutral'
  const decisionAction = result.decision.synthesisAction || result.decision.action || 'WATCH'

  return {
    id: makeId('quant-top10'),
    title: 'Quant Top 10',
    subtitle: `${result.source} · ${formatIsoTimestamp(result.generatedAt)}`,
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary: result.decision.conclusion || `${result.topPicks.length} candidates returned by Quant Lab.`,
    sections: [
      {
        title: 'Candidates',
        items: result.topPicks.map((pick, index) => ({
          id: `${index + 1}-${pick.ticker}`,
          title: `${index + 1}. ${pick.ticker} · ${pick.score.toFixed(1)}`,
          meta: `${formatCurrency(pick.price)} · ${pick.trend} · risk ${pick.risk}`,
          status: pick.action,
        })),
      },
      {
        title: 'Decision',
        body: [
          result.decision.action,
          result.decision.invalidation,
          result.decision.macroInsight,
        ].filter(Boolean).join('\n'),
      },
      {
        title: 'Data health',
        body: [
          `Status: ${result.dataHealth.status || 'UNKNOWN'}`,
          `Quote source: ${result.dataHealth.quoteSource}`,
          `Coverage: ${result.dataHealth.quoteCoverage}`,
          `Provider chain: ${(result.dataHealth.providerChain || []).join(' -> ') || 'n/a'}`,
        ].join('\n'),
      },
    ],
    rawJson: JSON.stringify(result.raw, null, 2),
    widget: {
      type: 'metric-grid',
      title: 'Quant Snapshot',
      metrics: [
        {
          id: 'decision',
          label: 'Decision',
          value: decisionAction,
          detail: result.decision.weightRegimeLabel || result.decision.macroRegime || result.decision.conclusion,
          tone: /buy/i.test(decisionAction) ? 'success' : /reject|sell/i.test(decisionAction) ? 'danger' : 'info',
        },
        {
          id: 'data-health',
          label: 'Data Health',
          value: healthStatus,
          detail: `${result.dataHealth.quoteCoverage} · ${result.dataHealth.quoteSource}`,
          tone: healthTone,
        },
        {
          id: 'generated',
          label: 'Generated',
          value: formatIsoTimestamp(result.generatedAt) || 'Now',
          detail: result.source,
          tone: 'neutral',
        },
      ],
      picks: result.topPicks.map((pick, index) => ({
        id: `${index + 1}-${pick.ticker}`,
        ticker: pick.ticker,
        score: pick.score.toFixed(1),
        action: pick.action,
        risk: pick.risk,
        price: formatCurrency(pick.price),
        trend: pick.trend,
        reason: pick.reason,
        confidence: pick.scoreBreakdown?.confidence,
        tone: pick.action.toLowerCase() as AuroraQuantWidgetPick['tone'],
      })),
      footer: result.decision.conclusion,
      app: {
        kind: 'quant-lab',
        label: '全螢幕展開',
      },
    },
  }
}

function formatQuantPhaseCheckResult(result: QuantPhaseCheckResult, tool: AuroraToolExecution): AuroraResult {
  const firstFailed = result.firstFailed
    ? `${result.firstFailed.title} (${result.firstFailed.key})`
    : 'All phases passed'
  return {
    id: makeId('quant-phase-check'),
    title: 'Quant Phase Check',
    subtitle: `${result.report.source} · ${formatIsoTimestamp(result.report.generatedAt)}`,
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary: `${result.passedCount}/${result.totalCount} phases PASS · ${firstFailed}`,
    sections: [
      {
        title: 'Phases',
        items: result.report.phases.map(phase => ({
          id: phase.key,
          title: `Phase ${phase.phase}: ${phase.title}`,
          meta: phase.checks.map(check => `${check.label}: ${check.status}`).join(' · '),
          status: phase.status,
        })),
      },
      {
        title: 'Market data',
        body: [
          `Quote coverage: ${result.report.quoteCoverage}`,
          `Universe size: ${result.report.universeSize}`,
          `Stock universe: ${result.report.stockUniverseSize ?? 'n/a'}`,
        ].join('\n'),
      },
    ],
    rawJson: JSON.stringify(result.raw, null, 2),
  }
}

function formatQuantPaperJournalResult(result: QuantLabPaperAccount, tool: AuroraToolExecution): AuroraResult {
  const latest = result.journal[0]
  return {
    id: makeId('quant-paper-journal'),
    title: 'Paper Journal Added',
    subtitle: `Quant Lab · ${formatIsoTimestamp(result.updatedAt)}`,
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary: latest?.note || 'Paper journal entry was added.',
    sections: [
      {
        title: 'Latest entry',
        items: latest ? [
          {
            id: `${latest.time}-${latest.ticker}`,
            title: `${latest.action} ${latest.ticker}`,
            meta: formatIsoTimestamp(latest.time),
            status: 'journal',
          },
        ] : [],
        body: latest?.note,
      },
      {
        title: 'Paper account',
        items: [
          {
            id: 'equity',
            title: formatCurrency(result.equity),
            meta: `Cash ${formatCurrency(result.cash)}`,
            status: formatPercent(result.returnPct),
          },
          {
            id: 'positions',
            title: `${result.positions.length} positions`,
            meta: `${result.tradeCount} trades · win ${result.winRate.toFixed(1)}%`,
            status: result.guardrails?.status || 'guard',
          },
        ],
      },
    ],
    rawJson: JSON.stringify(result, null, 2),
  }
}

function formatGeneratedWidgetResult(result: GeneratedWidgetLoadResult, tool: AuroraToolExecution): AuroraResult {
  return {
    id: makeId('generated-widget'),
    title: result.widgetName,
    subtitle: 'Aurora Generated Widget',
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary: `Loading ${result.componentPath} in a sandboxed Aurora renderer.`,
    sections: [],
    rawJson: JSON.stringify(result, null, 2),
    widget: {
      type: 'generated-widget',
      title: result.widgetName,
      widgetName: result.widgetName,
      componentPath: result.componentPath,
      requestedAt: result.requestedAt,
    },
  }
}

function formatGeneratedWidgetListResult(result: GeneratedWidgetListResult, tool: AuroraToolExecution): AuroraResult {
  return {
    id: makeId('generated-widget-library'),
    title: 'Generated Widget Library',
    subtitle: `Aurora Widgets · ${formatIsoTimestamp(result.generatedAt)}`,
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary: result.widgets.length
      ? `${result.widgets.length} generated widget${result.widgets.length > 1 ? 's' : ''} available.`
      : 'No generated widgets are currently available.',
    sections: [],
    rawJson: JSON.stringify(result, null, 2),
    widget: {
      type: 'generated-widget-library',
      title: 'Generated Widget Library',
      emptyText: 'No generated widgets were found in components/generated.',
      generatedAt: result.generatedAt,
      manifestSource: result.manifestSource,
      widgets: result.widgets.map(widget => ({
        id: widget.widgetName,
        widgetName: widget.widgetName,
        componentPath: widget.componentPath,
        deployedAt: widget.deployedAt,
        buildId: widget.buildId,
        spec: widget.spec,
        source: widget.source,
        securityStatus: widget.securityStatus,
        permissions: widget.permissions,
        loadable: widget.loadable,
      })),
    },
  }
}

function formatLegacyAppOpenResult(result: LegacyAppOpenResult, tool: AuroraToolExecution): AuroraResult {
  const label = getAuroraAppCapability(result.kind).title
  return {
    id: makeId('app-launch'),
    title: label,
    subtitle: 'Aurora App Mode',
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary: `Opening ${label} inside Aurora App Mode.`,
    sections: [],
    rawJson: JSON.stringify(result, null, 2),
    widget: {
      type: 'app-launch',
      title: label,
      app: {
        kind: result.kind,
        label: 'Open App',
        ...(result.payload ? { payload: result.payload } : {}),
      },
    },
  }
}

type AuroraResultPresenter = (payload: unknown, tool: AuroraToolExecution) => AuroraResult

const AURORA_RESULT_PRESENTERS: Record<string, AuroraResultPresenter> = {
  'legacy.kanban.listTasks': (payload, tool) => formatTaskResult(payload as LegacyTaskResult, tool),
  'legacy.memory.search': (payload, tool) => formatMemoryResult(payload as LegacyMemorySearchResult, tool),
  'legacy.kanban.createTask': (payload, tool) => formatCreateTaskResult(payload as KanbanTask, tool),
  'aurora.memory.propose': (payload, tool) => formatProposeMemoryResult(payload as CandidateMemory, tool),
  'lifeos.readOverview': (payload, tool) => formatLifeOsOverviewResult(payload as LifeOsOverviewResult, tool),
  'lifeos.viewState': (payload, tool) => formatLifeOsOverviewResult(payload as LifeOsOverviewResult, tool),
  'lifeos.generateBriefing': (payload, tool) => formatLifeOsBriefingResult(payload as LifeOsBriefingGenerateResponse, tool),
  'quant.readTop10': (payload, tool) => formatQuantTop10Result(payload as QuantTop10Result, tool),
  'quant.viewLab': (payload, tool) => formatQuantTop10Result(payload as QuantTop10Result, tool),
  'quant.phaseCheck': (payload, tool) => formatQuantPhaseCheckResult(payload as QuantPhaseCheckResult, tool),
  'quant.mirofish.graph.open': (payload, tool) => formatLegacyAppOpenResult(payload as LegacyAppOpenResult, tool),
  'quant.mirofish.run': (payload, tool) => formatLegacyAppOpenResult(payload as LegacyAppOpenResult, tool),
  'quant.paperJournal.create': (payload, tool) => formatQuantPaperJournalResult(payload as QuantLabPaperAccount, tool),
  'aurora.videoStudio.open': (payload, tool) => formatLegacyAppOpenResult(payload as LegacyAppOpenResult, tool),
  'aurora.browser.open': (payload, tool) => formatLegacyAppOpenResult(payload as LegacyAppOpenResult, tool),
  'aurora.legacyApp.open': (payload, tool) => formatLegacyAppOpenResult(payload as LegacyAppOpenResult, tool),
  'aurora.generatedWidget.list': (payload, tool) => formatGeneratedWidgetListResult(payload as GeneratedWidgetListResult, tool),
  'aurora.generatedWidget.load': (payload, tool) => formatGeneratedWidgetResult(payload as GeneratedWidgetLoadResult, tool),
}

export function listAuroraResultPresenterToolIds(): string[] {
  return Object.keys(AURORA_RESULT_PRESENTERS)
}

export function formatAuroraResult(payload: unknown, tool: AuroraToolExecution): AuroraResult {
  const presenter = AURORA_RESULT_PRESENTERS[tool.toolId]
  if (presenter) return presenter(payload, tool)
  return {
    id: makeId('tool-result'),
    title: tool.toolName,
    subtitle: tool.securityLevel,
    toolName: tool.toolName,
    securityLevel: tool.securityLevel,
    summary: 'Tool completed.',
    sections: [],
    rawJson: JSON.stringify(payload, null, 2),
  }
}

import { describe, expect, it } from 'vitest'
import { formatAuroraResult } from '@/services/hermes/aurora/result-presenters'
import type { KanbanTask } from '@/api/hermes/kanban'
import type {
  LegacyMemorySearchResult,
  LegacyTaskResult,
  LifeOsOverviewResult,
  QuantTop10Result,
} from '@/services/hermes/aurora/legacy-adapters'
import type { AuroraToolExecution, AuroraToolSecurityLevel } from '@/services/hermes/aurora/tool-types'

function tool(
  toolId: string,
  toolName: string,
  securityLevel: AuroraToolSecurityLevel = 'L1_ReadOnly',
): AuroraToolExecution<unknown> {
  return {
    toolId,
    toolName,
    securityLevel,
    args: {},
    execute: async () => null,
  }
}

function kanbanTask(overrides: Partial<KanbanTask>): KanbanTask {
  return {
    id: 'task-default',
    title: 'Default task',
    body: null,
    assignee: null,
    status: 'todo',
    priority: 0,
    created_by: 'aurora-test',
    created_at: 1_764_200_000,
    started_at: null,
    completed_at: null,
    workspace_kind: 'repo',
    workspace_path: null,
    tenant: null,
    result: null,
    skills: null,
    ...overrides,
  }
}

describe('Aurora result presenters', () => {
  it('renders legacy Kanban task results as a task-list widget instead of plain raw JSON', () => {
    const activeTask = kanbanTask({
      id: 'task-active',
      title: 'Review Aurora widget route',
      body: 'Check that Kanban becomes a widget.',
      status: 'running',
      priority: 2,
      assignee: 'kk',
      created_at: 1_764_300_000,
    })
    const doneTask = kanbanTask({
      id: 'task-done',
      title: 'Ship old milestone',
      status: 'done',
      priority: 0,
      completed_at: 1_764_310_000,
    })
    const archivedTask = kanbanTask({
      id: 'task-archived',
      title: 'Archived task should stay out of widget',
      status: 'archived',
    })
    const payload: LegacyTaskResult = {
      board: 'aurora',
      tasks: [doneTask, archivedTask, activeTask],
      activeTasks: [activeTask],
      createdToday: [activeTask],
      completedToday: [doneTask],
      stats: null,
      raw: {
        board: 'aurora',
        tasks: [doneTask, archivedTask, activeTask],
        stats: null,
      },
    }

    const result = formatAuroraResult(payload, tool('legacy.kanban.listTasks', 'ListTasksTool'))

    expect(result.title).toBe('Today Tasks')
    expect(result.summary).toContain('1 active')
    expect(result.widget?.type).toBe('task-list')
    if (result.widget?.type !== 'task-list') throw new Error('Expected task-list widget')
    expect(result.widget.tasks.map(task => task.title)).toEqual([
      'Review Aurora widget route',
      'Ship old milestone',
    ])
    expect(result.widget.tasks.find(task => task.id === 'task-done')?.checked).toBe(true)
    expect(result.widget.tasks.map(task => task.id)).not.toContain('task-archived')
  })

  it('renders legacy Memory search results as memory snippets with source confidence', () => {
    const payload: LegacyMemorySearchResult = {
      query: 'Aurora',
      matches: [
        {
          section: 'memory',
          title: 'My Notes',
          snippet: 'Aurora prefers glassmorphic widgets.',
        },
        {
          section: 'user',
          title: 'User Profile',
          snippet: 'User wants Traditional Chinese summaries.',
        },
      ],
      raw: {
        memory: 'Aurora prefers glassmorphic widgets.',
        user: 'User wants Traditional Chinese summaries.',
        soul: '',
      },
    }

    const result = formatAuroraResult(payload, tool('legacy.memory.search', 'SearchMemoryTool'))

    expect(result.widget?.type).toBe('memory-snippets')
    if (result.widget?.type !== 'memory-snippets') throw new Error('Expected memory-snippets widget')
    expect(result.widget.query).toBe('Aurora')
    expect(result.widget.snippets).toEqual([
      expect.objectContaining({ source: 'memory', confidence: '95%' }),
      expect.objectContaining({ source: 'user', confidence: '90%' }),
    ])
    expect(result.sections.some(section => section.body?.includes('glassmorphic'))).toBe(true)
  })

  it('renders Quant Top 10 results as a metric-grid widget with an App Mode action', () => {
    const payload: QuantTop10Result = {
      generatedAt: '2026-05-28T12:00:00.000Z',
      source: 'fixture',
      topPicks: [
        {
          ticker: 'NVDA',
          score: 91.25,
          action: 'BUY',
          trend: 'uptrend',
          risk: 'M',
          reason: 'Momentum and liquidity alignment.',
          price: 128.42,
          scoreBreakdown: {
            quality: 90,
            momentum: 92,
            regime: 88,
            risk: 15,
            final: 91.25,
            confidence: 'high',
            source: 'fixture',
            notes: ['clean trend'],
          },
        },
      ],
      decision: {
        conclusion: 'NVDA leads the current candidate set.',
        action: 'BUY',
        invalidation: 'Break below support.',
        macroInsight: 'Risk-on regime.',
        synthesisAction: 'BUY',
        weightRegimeLabel: 'Risk-on',
      },
      dataHealth: {
        status: 'OK',
        quoteSource: 'fixture',
        quoteCoverage: '1/1',
        missingSymbols: [],
        backtestSource: 'fixture',
        updatedAt: '2026-05-28T12:00:00.000Z',
        providerChain: ['fixture'],
      },
      raw: {} as QuantTop10Result['raw'],
    }

    const result = formatAuroraResult(payload, tool('quant.readTop10', 'ViewQuantLabTool'))

    expect(result.widget?.type).toBe('metric-grid')
    if (result.widget?.type !== 'metric-grid') throw new Error('Expected metric-grid widget')
    expect(result.widget.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'decision', value: 'BUY' }),
      expect.objectContaining({ id: 'data-health', value: 'OK' }),
    ]))
    expect(result.widget.picks[0]).toMatchObject({
      ticker: 'NVDA',
      score: '91.3',
      action: 'BUY',
      confidence: 'high',
    })
    expect(result.widget.app).toEqual({ kind: 'quant-lab', label: '全螢幕展開' })
  })

  it('renders LifeOS overview results as a financial dashboard with an App Mode action', () => {
    const category = {
      id: 'food',
      name: 'Food',
      group: 'living',
      budgeted: 12000,
      spent: 13500,
      remaining: -1500,
    }
    const payload: LifeOsOverviewResult = {
      state: {} as LifeOsOverviewResult['state'],
      raw: {} as LifeOsOverviewResult['raw'],
      metrics: {
        totalCash: 245255,
        totalStocks: 783565,
        totalAssets: 1028820,
        netWorth: 717876,
        totalExpenses: 42000,
        investmentTransfers: 12000,
        netMonthlyCashFlow: 18000,
        cashReserveMonths: 5.8,
        investmentRatio: 76.2,
        usdTwdRate: 32,
        domesticStocksTwd: 220000,
        usStocksTwd: 563565,
        fireTarget: 3000000,
        fireProgress: 23.9,
        budgetMetrics: {
          totalBudgeted: 60000,
          totalSpent: 61500,
          operatingSpent: 49500,
          transferSpent: 12000,
          totalRemaining: -1500,
          availableToBudget: 18000,
          categories: [category],
        },
        domesticStockMetrics: {
          items: [],
          currency: 'TWD',
          fxRate: 1,
          totalMarketValue: 220000,
          totalCost: 200000,
          totalGainLoss: 20000,
          totalGainLossPct: 10,
          totalMarketValueTwd: 220000,
          totalCostTwd: 200000,
          totalGainLossTwd: 20000,
        },
        usStockMetrics: {
          items: [],
          currency: 'USD',
          fxRate: 32,
          totalMarketValue: 17611.4,
          totalCost: 15000,
          totalGainLoss: 2611.4,
          totalGainLossPct: 17.4,
          totalMarketValueTwd: 563565,
          totalCostTwd: 480000,
          totalGainLossTwd: 83565,
        },
      },
      budgetBreaches: [category],
      topPortfolio: [
        {
          rank: 1,
          symbol: 'NVDA',
          name: 'NVIDIA',
          shares: 5,
          costBasis: 100,
          currentPrice: 128,
          marketValue: 640,
          gainLoss: 140,
          gainLossPct: 28,
          currency: 'USD',
          fxRate: 32,
          marketValueTwd: 20480,
          costTwd: 16000,
          gainLossTwd: 4480,
        },
      ],
    }

    const result = formatAuroraResult(payload, tool('lifeos.readOverview', 'ViewLifeOSTool'))

    expect(result.widget?.type).toBe('financial-dashboard')
    if (result.widget?.type !== 'financial-dashboard') throw new Error('Expected financial-dashboard widget')
    expect(result.widget.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'net-worth', value: 'NT$717,876' }),
      expect.objectContaining({ id: 'fire-progress', value: '23.9%' }),
      expect.objectContaining({ id: 'cashflow', value: 'NT$18,000' }),
    ]))
    expect(result.widget.budgetLines[0]).toMatchObject({
      id: 'food',
      value: 'NT$-1,500',
      tone: 'danger',
    })
    expect(result.widget.portfolioLines[0]).toMatchObject({
      id: '1-NVDA',
      label: '1. NVDA',
    })
    expect(result.widget.app).toEqual({ kind: 'life-os', label: '全螢幕展開' })
  })

  it('keeps generated widgets and app launches structured while unknown tools fall back to raw JSON', () => {
    const generated = formatAuroraResult({
      widgetName: 'PomodoroGlassWidget',
      componentPath: '../../components/generated/PomodoroGlassWidget.vue',
      query: 'open PomodoroGlassWidget',
      requestedAt: '2026-05-28T12:00:00.000Z',
    }, tool('aurora.generatedWidget.load', 'LoadGeneratedWidgetTool'))

    expect(generated.widget?.type).toBe('generated-widget')
    if (generated.widget?.type !== 'generated-widget') throw new Error('Expected generated-widget widget')
    expect(generated.widget.widgetName).toBe('PomodoroGlassWidget')

    const appLaunch = formatAuroraResult({
      kind: 'quant-lab',
      query: 'open Quant Lab',
      requestedAt: '2026-05-28T12:00:00.000Z',
    }, tool('aurora.legacyApp.open', 'OpenLegacyAppTool'))

    expect(appLaunch.widget?.type).toBe('app-launch')
    expect(appLaunch.widget?.app).toEqual({ kind: 'quant-lab', label: 'Open App' })

    const graphLaunch = formatAuroraResult({
      kind: 'mirofish-graph',
      query: 'open MiroFish graph',
      requestedAt: '2026-05-28T12:00:00.000Z',
      payload: {
        projectId: 'preview-project',
        initialUrl: 'http://localhost:3000',
      },
    }, tool('quant.mirofish.graph.open', 'OpenMiroFishGraphTool'))

    expect(graphLaunch.widget?.type).toBe('app-launch')
    expect(graphLaunch.widget?.app).toEqual({
      kind: 'mirofish-graph',
      label: 'Open App',
      payload: {
        projectId: 'preview-project',
        initialUrl: 'http://localhost:3000',
      },
    })

    const fallback = formatAuroraResult({ ok: true }, tool('unknown.tool', 'Unknown Tool'))
    expect(fallback.widget).toBeUndefined()
    expect(fallback.rawJson).toContain('"ok": true')
  })
})

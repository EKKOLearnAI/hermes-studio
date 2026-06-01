// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import QuantTerminal from '@/components/hermes/quant-lab/QuantTerminal.vue'

vi.mock('@/composables/useTerminalState', async () => {
  const { ref } = await vi.importActual<typeof import('vue')>('vue')
  return {
    useTerminalState: () => ({
      activeTicker: ref(''),
      focusMode: ref(false),
      setActiveTicker: vi.fn(),
      clearFocus: vi.fn(),
    }),
  }
})

vi.mock('@/composables/useTerminalActions', async () => {
  const { ref } = await vi.importActual<typeof import('vue')>('vue')
  return {
    useTerminalActions: () => ({
      latestAction: ref(null),
      actionAuditLog: ref([]),
    }),
  }
})

const baseProps = {
  marketPulse: [{ label: 'Regime', value: 'risk-on', tone: 'up' }],
  topPicks: [{
    ticker: 'TEST',
    score: 91,
    action: 'BUY',
    risk: 'M',
    trend: '+3.2%',
    price: 123.45,
    reason: 'unit test candidate',
    scoreBreakdown: {
      valuation: {
        delta: '-9.00',
        riskTier: 'expensive',
        scoreCap: 72,
        maxAction: 'HOLD',
        warning: 'valuation cap blocks paper buy',
      },
    },
  }],
  decision: { action: 'WATCH', invalidation: 'unit-test' },
  account: {
    initialCapital: 100000,
    cash: 100000,
    realizedPnl: 0,
    maxEquity: 100000,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    grossProfit: 0,
    grossLoss: 0,
    positions: [],
    journal: [],
  },
  journal: [],
  guardrails: null,
  latestSeed: null,
  mirofishInference: null,
  mirofishTaskStatus: null,
  mirofishGraphSummary: null,
  evidenceArchives: [],
  dataHealth: {
    status: 'OK',
    quoteCoverage: '1/1',
    quoteSource: 'unit-test',
    missingSymbols: [],
    universeSize: 1,
    stockUniverseSize: 1,
    backtestSource: 'unit-test',
  },
  phaseValidationItems: [
    { label: 'Phase Validation', value: '10/10', detail: 'all phases pass', tone: 'up' },
    {
      label: 'Valuation Paper-Buy Guard',
      value: 'PASS',
      detail: 'valuation-paper-buy-guard blocks synthetic BUY when maxAction is HOLD',
      tone: 'up',
    },
  ],
  backtests: [],
  snapshotSource: 'unit-test',
  snapshotGeneratedAt: '2026-06-01T00:00:00.000Z',
  loadingSnapshot: false,
  runningBrief: null,
  runningWeeklySummary: false,
  runningMiroFish: false,
  loadingMiroFishTask: false,
  loadingMiroFishGraph: false,
  paperActionPending: '',
  savingReport: false,
  sendingTelegram: false,
  briefStatus: '',
  saveStatus: '',
  telegramStatus: '',
  socketStatus: 'closed',
  socketMessageCount: 0,
  socketFlushCount: 0,
  candles: [],
  candleTruth: null,
  candleSource: 'unit-test',
  candleStatus: '',
  loadingCandles: false,
  candleTimeframe: '1d',
  providerSettings: null,
  providerSettingsStatus: '',
  savingProviderSettings: false,
  providerTest: null,
  testingProviderFeeds: false,
} as const

describe('QuantTerminal phase validation strip', () => {
  it('shows valuation-paper-buy-guard status in the Top 10 panel', async () => {
    const wrapper = mount(QuantTerminal, {
      props: baseProps,
      global: {
        stubs: {
          FastMoneyText: { template: '<span class="fast-money-stub">100000</span>' },
          TerminalCandlestickChart: { template: '<div />' },
          TerminalEquityChart: { template: '<div />' },
          MiroFishScenarioGraph: { template: '<div />' },
          MemoryVaultPanel: { template: '<div />' },
          PnLDashboard: { template: '<div />' },
        },
      },
    })

    await wrapper.findAll('nav.section-tabs button')[1].trigger('click')

    const strip = wrapper.get('[aria-label="Quant Lab phase validation"]')
    expect(strip.text()).toContain('Phase Validation')
    expect(strip.text()).toContain('10/10')
    expect(strip.text()).toContain('Valuation Paper-Buy Guard')
    expect(strip.text()).toContain('PASS')
    expect(strip.text()).toContain('valuation-paper-buy-guard blocks synthetic BUY')
  })
})

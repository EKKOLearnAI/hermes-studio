import type { Page, Request, Route } from '@playwright/test'

export const TEST_ACCESS_KEY = 'playwright-access-key'

export interface MockedRequest {
  method: string
  pathname: string
  search: string
  headers: Record<string, string>
  postData: string | null
}

interface MockHermesApiOptions {
  tokenValidationStatus?: number
  initialProfileName?: 'default' | 'research'
  sessions?: unknown[]
}

const sampleModelGroup = {
  provider: 'test-provider',
  label: 'Test Provider',
  base_url: 'https://example.invalid/v1',
  models: ['test-model'],
  available_models: ['test-model'],
  api_key: '',
  builtin: true,
}

const sampleJob = {
  job_id: 'job-smoke',
  id: 'job-smoke',
  name: 'Nightly Smoke',
  prompt: 'Run the smoke check',
  prompt_preview: 'Run the smoke check',
  skills: [],
  skill: null,
  model: 'test-model',
  provider: 'test-provider',
  base_url: null,
  script: null,
  schedule: '0 9 * * *',
  schedule_display: '0 9 * * *',
  repeat: { times: null, completed: 0 },
  enabled: true,
  state: 'scheduled',
  paused_at: null,
  paused_reason: null,
  created_at: '2026-01-01T00:00:00.000Z',
  next_run_at: '2026-01-02T09:00:00.000Z',
  last_run_at: null,
  last_status: null,
  last_error: null,
  deliver: 'origin',
  origin: null,
  last_delivery_error: null,
}

const sampleKanbanTasks = [
  {
    id: 'task-aurora-widget',
    title: 'Ship Aurora widgetization',
    body: 'Render legacy task JSON as a native Aurora card.',
    assignee: 'kk',
    status: 'running',
    priority: 2,
    created_by: 'playwright',
    created_at: 1779936000000,
    started_at: 1779939600000,
    completed_at: null,
    workspace_kind: 'local',
    workspace_path: null,
    tenant: null,
    result: null,
    skills: null,
  },
  {
    id: 'task-aurora-review',
    title: 'Review widget polish',
    body: null,
    assignee: null,
    status: 'todo',
    priority: 0,
    created_by: 'playwright',
    created_at: 1779932400000,
    started_at: null,
    completed_at: null,
    workspace_kind: 'local',
    workspace_path: null,
    tenant: null,
    result: null,
    skills: null,
  },
]

const sampleKanbanBoards = [
  {
    slug: 'default',
    name: 'Default',
    description: 'Playwright default board',
    icon: '',
    color: '',
    created_at: 1779930000000,
    archived: false,
    counts: { running: 1, todo: 1 },
    total: 2,
    is_current: true,
  },
]

const sampleKanbanCapabilities = {
  source: 'hermes-cli',
  supports: {
    commentsWrite: false,
    links: false,
    bulk: false,
    taskLog: false,
    diagnostics: false,
    reclaim: false,
    reassign: false,
    specify: false,
    dispatch: false,
    events: false,
  },
  missing: ['events'],
  capabilities: [
    { key: 'events', status: 'missing', requiresBoard: true, reason: 'Fixture disables event sockets.' },
  ],
}

const sampleKanbanAssignees = [
  {
    name: 'kk',
    on_disk: true,
    counts: { running: 1 },
  },
  {
    name: 'unassigned',
    on_disk: false,
    counts: { todo: 1 },
  },
]

const sampleMemory = {
  memory: 'Aurora prefers glassmorphic widgets with human approval for durable memory writes.',
  user: 'kk is migrating Hermes legacy tools into Aurora OS.',
  soul: 'Build with calm, careful interface polish.',
  memory_mtime: 1779936000,
  user_mtime: 1779936000,
  soul_mtime: 1779936000,
}

const sampleSkillsResponse = {
  categories: [
    {
      name: 'aurora',
      description: 'Aurora fixture skills',
      skills: [
        {
          name: 'aurora-memory-governance',
          description: 'Review candidate memories before durable writes.',
          enabled: true,
          source: 'local',
          pinned: true,
        },
        {
          name: 'hub-hidden-skill',
          description: 'Should remain out of Aurora slash summon.',
          enabled: true,
          source: 'hub',
        },
      ],
    },
  ],
  archived: [],
}

const samplePluginsResponse = {
  plugins: [
    {
      key: 'aurora-sandbox',
      name: 'Aurora Sandbox',
      kind: 'tool',
      source: 'fixture',
      configStatus: 'enabled',
      effectiveStatus: 'enabled',
      version: '0.1.0',
      description: 'Runs sandbox checks for Aurora build mode.',
      author: 'fixture',
      path: '/tmp/aurora-sandbox',
      providesTools: ['sandbox'],
      providesHooks: [],
      requiresEnv: [],
    },
  ],
  warnings: [],
  metadata: {
    hermesAgentRoot: '/tmp/hermes-agent',
    pythonExecutable: '/usr/bin/python3',
    cwd: '/tmp/hermes-web-ui',
    projectPluginsEnabled: true,
  },
}

const sampleVibeBuildResponse = {
  buildId: 'vibe-fixture-pomodoro',
  widgetName: 'PomodoroGlassWidget',
  componentPath: 'packages/client/src/components/generated/PomodoroGlassWidget.vue',
  spec: 'A glassmorphic Pomodoro widget with focus, break, and progress states.',
  uiMock: 'Centered frosted card, circular timer, mode pills, and a purple start button.',
  code: [
    '<template>',
    '  <section class="rounded-2xl border border-white/40 bg-white/60 p-5 shadow-xl backdrop-blur-2xl">',
    '    <p class="text-xs font-bold uppercase text-indigo-500">Pomodoro</p>',
    '    <h2 class="mt-2 text-3xl font-black text-slate-900">{{ minutes }}:00</h2>',
    '    <button class="mt-4 rounded-full bg-indigo-500 px-4 py-2 text-white">Start focus</button>',
    '  </section>',
    '</template>',
    '',
    '<script setup lang="ts">',
    "import { ref } from 'vue'",
    'const minutes = ref(25)',
    '</script>',
  ].join('\n'),
  patchDiff: [
    'diff --git a/packages/client/src/components/generated/PomodoroGlassWidget.vue b/packages/client/src/components/generated/PomodoroGlassWidget.vue',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/packages/client/src/components/generated/PomodoroGlassWidget.vue',
    '@@ -0,0 +1,11 @@',
    '+<template>',
    '+  <section class="rounded-2xl border border-white/40 bg-white/60 p-5 shadow-xl backdrop-blur-2xl">',
    '+    <p class="text-xs font-bold uppercase text-indigo-500">Pomodoro</p>',
    '+    <h2 class="mt-2 text-3xl font-black text-slate-900">{{ minutes }}:00</h2>',
    '+    <button class="mt-4 rounded-full bg-indigo-500 px-4 py-2 text-white">Start focus</button>',
    '+  </section>',
    '+</template>',
    '+',
    '+<script setup lang="ts">',
    "+import { ref } from 'vue'",
    '+const minutes = ref(25)',
    '+</script>',
  ].join('\n'),
  securityReport: [],
  blocked: false,
  runtime: {
    mode: 'fixture',
    provider: 'test-provider',
    model: 'test-model',
  },
}

const sampleGeneratedWidgetManifest = {
  generatedAt: '2026-05-28T12:00:00.000Z',
  root: 'packages/client/src/components/generated',
  widgets: [
    {
      widgetName: 'PomodoroGlassWidget',
      fileName: 'PomodoroGlassWidget.vue',
      componentPath: 'packages/client/src/components/generated/PomodoroGlassWidget.vue',
      manifestPath: 'packages/client/src/components/generated/PomodoroGlassWidget.manifest.json',
      permissions: {
        network: false,
        localStorage: false,
        workingMemory: false,
        cookies: false,
        filesystem: false,
      },
      deployedAt: '2026-05-28T12:00:00.000Z',
      buildId: 'vibe-fixture-pomodoro',
      spec: 'A glassmorphic Pomodoro widget with focus, break, and progress states.',
      source: 'vibe-build',
      securityStatus: 'passed',
      securityReport: [],
    },
  ],
}

const sampleQuantSnapshot = {
  generatedAt: '2026-05-28T12:00:00.000Z',
  source: 'playwright-fixture',
  marketPulse: [
    { label: 'NASDAQ', value: '+0.8%', tone: 'up' },
  ],
  topPicks: [
    {
      ticker: 'NVDA',
      score: 91.4,
      action: 'BUY',
      trend: 'Momentum expanding',
      risk: 'M',
      reason: 'Strong quality and momentum score with acceptable risk.',
      price: 126.42,
      scoreBreakdown: {
        quality: 92,
        momentum: 95,
        earnings: 88,
        liquidity: 90,
        regime: 84,
        risk: 72,
        final: 91.4,
        confidence: 'high',
        source: 'fixture',
        sector: 'Semiconductors',
        theme: 'AI compute',
        notes: ['fixture'],
      },
    },
    {
      ticker: 'MSFT',
      score: 87.2,
      action: 'WATCH',
      trend: 'Steady uptrend',
      risk: 'L',
      reason: 'Durable trend, but current entry is less favorable.',
      price: 434.1,
    },
  ],
  riskRules: [],
  decision: {
    conclusion: 'NVDA leads the current fixture ranking.',
    action: 'BUY NVDA if risk controls pass.',
    invalidation: 'Break below the 20-day moving average.',
    expectedScore: 91.4,
    quantScore: 91.4,
    mirofishScore: null,
    macroRisk: 0.2,
    vix: 14.8,
    riskMultiplier: 1,
    macroRegime: 'risk-on',
    macroInsight: 'Liquidity remains supportive.',
    weights: { w1: 0.4, w2: 0.4, w3: 0.2 },
    weightRegime: 'risk-on',
    weightRegimeLabel: 'Risk-on',
    synthesisAction: 'BUY',
    synthesisReasons: ['fixture'],
    synthesisFormula: 'fixture',
  },
  chartCaption: [],
  graphCaption: [],
  backtests: [],
  backtestSummary: [],
  dataHealth: {
    status: 'OK',
    quoteSource: 'fixture',
    quoteCoverage: '2/2',
    missingSymbols: [],
    providerChain: ['fixture'],
    backtestSource: 'fixture',
    updatedAt: '2026-05-28T12:00:00.000Z',
  },
  mirofishSeed: null,
  mirofishInference: null,
}

const sampleMiroFishRunResponse = {
  ok: true,
  phase: 'premarket',
  source: 'fixture',
  generatedAt: '2026-05-28T12:00:00.000Z',
  evidenceCount: 9,
  mirofish: {
    status: 'report_ready',
    seed: {
      path: '/tmp/hermes-fixture/mirofish-seed.json',
      relativePath: 'fixture/mirofish-seed.json',
    },
    requirement: 'Fixture sandbox debate only.',
    evidenceArchive: {
      path: '/tmp/hermes-fixture/mirofish-evidence.md',
      relativePath: 'fixture/mirofish-evidence.md',
      graphOk: true,
      graphId: 'fixture-graph',
      graphSource: 'local-file',
      journalNote: 'Fixture evidence archive.',
      topDegrees: [{ ticker: 'NVDA', degree: 4 }],
    },
    inference: {
      status: 'report_ready',
      confidence: 'high',
      support: ['Bull case sees NVDA momentum and AI demand confirming upside asymmetry.'],
      oppose: ['Bear case flags valuation compression and gap-down risk if macro liquidity weakens.'],
      neutral: ['Macro regime is risk-on but not euphoric; size discipline remains required.'],
      evidenceCount: 9,
      updatedAt: '2026-05-28T12:00:00.000Z',
      reportRelativePath: 'fixture/mirofish-report.md',
      debate: {
        macro: {
          Regime: 'Risk-On',
          RiskMultiplier: 0.82,
          MacroInsight: 'Liquidity and volatility remain supportive, but the setup needs tight invalidation.',
        },
        scenarios: {
          bullish: {
            probability: 0.62,
            confidence: 0.78,
            reasoning: 'Breakout continuation remains the base case.',
          },
          neutral: {
            probability: 0.24,
            confidence: 0.7,
            reasoning: 'Chop is possible if the index pauses.',
          },
          bearish: {
            probability: 0.14,
            confidence: 0.66,
            reasoning: 'Bear case requires macro shock or failed breakout.',
          },
        },
        key_risks: ['Valuation compression', 'Macro shock'],
        bull: {
          role: 'bull',
          title: 'Bull agent: Momentum is still expanding',
          content: 'NVDA leads the fixture ranking with durable momentum and quality confirmation.',
          citations: [],
          generatedAt: '2026-05-28T12:00:00.000Z',
        },
        bear: {
          role: 'bear',
          title: 'Bear agent: Mind the valuation air pocket',
          content: 'The bearish path is lower probability but has high impact if liquidity turns.',
          citations: [],
          generatedAt: '2026-05-28T12:00:00.000Z',
        },
        judgeRaw: 'Hermes Synthesizer favors BUY with reduced size and a clear invalidation level.',
        mode: 'local',
        ok: true,
        generatedAt: '2026-05-28T12:00:00.000Z',
      },
    },
  },
  topPicks: sampleQuantSnapshot.topPicks,
}

function sampleMiroFishRunResponseForTarget(targetTicker: unknown) {
  const ticker = typeof targetTicker === 'string' ? targetTicker.trim().toUpperCase() : ''
  const target = sampleQuantSnapshot.topPicks.find(pick => pick.ticker === ticker)
  if (!target) return sampleMiroFishRunResponse

  const topPicks = [
    target,
    ...sampleQuantSnapshot.topPicks.filter(pick => pick.ticker !== ticker),
  ]

  return {
    ...sampleMiroFishRunResponse,
    topPicks,
    mirofish: {
      ...sampleMiroFishRunResponse.mirofish,
      evidenceArchive: {
        ...sampleMiroFishRunResponse.mirofish.evidenceArchive,
        topDegrees: [{ ticker, degree: ticker === 'NVDA' ? 4 : 3 }],
      },
      inference: {
        ...sampleMiroFishRunResponse.mirofish.inference,
        support: [`Bull case sees ${ticker} risk bridge context with quant score ${target.score}.`],
        oppose: [`Bear case challenges ${ticker} with position sizing and invalidation risk.`],
        debate: {
          ...sampleMiroFishRunResponse.mirofish.inference.debate,
          bull: {
            ...sampleMiroFishRunResponse.mirofish.inference.debate.bull,
            content: `${ticker} is the focused Quant Risk Bridge candidate.`,
          },
          judgeRaw: `Hermes Synthesizer favors ${target.action} for focused ${ticker} review with reduced size.`,
        },
      },
    },
  }
}

const sampleMiroFishAuditSnapshots = {
  ok: true,
  entries: [
    {
      fileName: 'mirofish-audit-20260528120000-buy-nvda.md',
      path: '/tmp/hermes-fixture-journal/mirofish-audit-20260528120000-buy-nvda.md',
      relativePath: 'trading-journal/mirofish-audit-20260528120000-buy-nvda.md',
      kind: 'audit-snapshot',
      categoryLabel: 'Audit Snapshot',
      extension: 'md',
      title: 'MiroFish Audit Snapshot - BUY NVDA',
      summary: 'Decision delta: BUY NVDA vs WATCH; risk 0.82x; archive Medium.',
      signal: 'BUY NVDA',
      confidence: 'High',
      driftScore: '0',
      createdAt: '2026-05-28T12:00:00.000Z',
      mtimeMs: 1779969600000,
      content: [
        '# MiroFish Audit Snapshot',
        '',
        '> Decision delta: BUY NVDA vs WATCH; risk 0.82x; archive Medium.',
        '',
        '## Current Decision',
        '',
        '- Action: BUY',
        '- Signal: BUY NVDA',
        '- Risk: 0.82x',
        '',
        '## Baseline Drift',
        '',
        '- Drift Score: 0',
        '- Severity: Low',
        '',
        '## Scenario Matrix',
        '',
        '| Scenario | Action | Risk |',
        '| --- | --- | --- |',
        '| Base | BUY | 0.82x |',
        '| Bear Shock | SELL | 1.17x |',
      ].join('\n'),
    },
    {
      fileName: 'mirofish-audit-20260527170000-watch-msft.md',
      path: '/tmp/hermes-fixture-journal/mirofish-audit-20260527170000-watch-msft.md',
      relativePath: 'trading-journal/mirofish-audit-20260527170000-watch-msft.md',
      kind: 'audit-snapshot',
      categoryLabel: 'Audit Snapshot',
      extension: 'md',
      title: 'MiroFish Audit Snapshot - WATCH MSFT',
      summary: 'Decision delta: WATCH MSFT vs HOLD; risk 1.00x; archive Low.',
      signal: 'WATCH MSFT',
      confidence: 'Medium',
      driftScore: '12',
      createdAt: '2026-05-27T17:00:00.000Z',
      mtimeMs: 1779872400000,
      content: [
        '# MiroFish Audit Snapshot',
        '',
        '> Decision delta: WATCH MSFT vs HOLD; risk 1.00x; archive Low.',
        '',
        '## Current Decision',
        '',
        '- Action: WATCH',
        '- Signal: WATCH MSFT',
        '',
        '## Scenario Matrix',
        '',
        '| Scenario | Action | Risk |',
        '| --- | --- | --- |',
        '| Base | WATCH | 1.00x |',
      ].join('\n'),
    },
    {
      fileName: 'mirofish-batch-20260528123000-base.md',
      path: '/tmp/hermes-fixture-journal/mirofish-batch-20260528123000-base.md',
      relativePath: 'trading-journal/mirofish-batch-20260528123000-base.md',
      kind: 'batch-markdown',
      categoryLabel: 'Batch Markdown',
      extension: 'md',
      title: 'MiroFish Batch Risk Bridge - Base',
      summary: '2/2 candidates completed in Base; 0 failed. Backend submission remained disabled.',
      signal: 'Base',
      confidence: 'n/a',
      driftScore: 'n/a',
      createdAt: '2026-05-28T12:30:00.000Z',
      mtimeMs: 1779971400000,
      content: [
        '# MiroFish Batch Risk Bridge',
        '',
        '> 2/2 candidates completed in Base; 0 failed. Backend submission remained disabled.',
        '',
        '## Candidate Results',
        '',
        '| Ticker | Action | Score | Risk |',
        '| --- | --- | ---: | --- |',
        '| NVDA | BUY | 91.4 | M |',
        '| MSFT | WATCH | 87.2 | L |',
      ].join('\n'),
    },
    {
      fileName: 'mirofish-compare-20260528124500-buy-nvda-vs-watch-msft.md',
      path: '/tmp/hermes-fixture-journal/mirofish-compare-20260528124500-buy-nvda-vs-watch-msft.md',
      relativePath: 'trading-journal/mirofish-compare-20260528124500-buy-nvda-vs-watch-msft.md',
      kind: 'compare-markdown',
      categoryLabel: 'Compare Report',
      extension: 'md',
      title: 'MiroFish Snapshot Compare - BUY NVDA vs WATCH MSFT',
      summary: 'BUY NVDA compared with WATCH MSFT. Paper trading research only; no backend trade submission.',
      signal: 'BUY NVDA vs WATCH MSFT',
      confidence: 'n/a',
      driftScore: 'n/a',
      createdAt: '2026-05-28T12:45:00.000Z',
      mtimeMs: 1779972300000,
      content: [
        '---',
        'title: "MiroFish Snapshot Compare - BUY NVDA vs WATCH MSFT"',
        'date: "2026-05-28T12:45:00.000Z"',
        'type: mirofish-audit-compare',
        'current: "mirofish-audit-20260528120000-buy-nvda.md"',
        'baseline: "mirofish-audit-20260527170000-watch-msft.md"',
        'submit_backend: false',
        '---',
        '',
        '# MiroFish Snapshot Compare',
        '',
        '> BUY NVDA compared with WATCH MSFT. Paper trading research only; no backend trade submission.',
        '',
        '## Compare Rows',
        '',
        '| Metric | Current | Baseline | Tone | Detail |',
        '| --- | --- | --- | --- | --- |',
        '| Signal | BUY NVDA | WATCH MSFT | changed | Decision signal from the exported snapshot frontmatter. |',
        '| Action | BUY | WATCH | risk | Action extracted from the Current Decision block. |',
      ].join('\n'),
    },
    {
      fileName: 'mirofish-batch-20260528123000-base.csv',
      path: '/tmp/hermes-fixture-journal/mirofish-batch-20260528123000-base.csv',
      relativePath: 'trading-journal/mirofish-batch-20260528123000-base.csv',
      kind: 'batch-csv',
      categoryLabel: 'Batch CSV',
      extension: 'csv',
      title: 'mirofish-batch-20260528123000-base.csv',
      summary: 'Batch CSV export with 2 candidates: NVDA, MSFT.',
      signal: 'Batch CSV',
      confidence: 'n/a',
      driftScore: 'n/a',
      createdAt: '2026-05-28T12:30:00.000Z',
      mtimeMs: 1779971401000,
      content: [
        '"ticker","action","score","risk","confidence","risk_multiplier","status","summary"',
        '"NVDA","BUY","91.4","M","High","0.82x","complete","Fixture batch completed for NVDA."',
        '"MSFT","WATCH","87.2","L","High","0.82x","complete","Fixture batch completed for MSFT."',
      ].join('\n'),
    },
  ],
  path: '/tmp/hermes-fixture-journal',
  relativePath: 'trading-journal',
  updatedAt: '2026-05-28T12:00:00.000Z',
}

const sampleMiroFishMemoryRecords = {
  ok: true,
  path: '/tmp/hermes-fixture-vault/MiroFish_Records',
  relativePath: 'MiroFish_Records',
  directories: ['MiroFish_Records'],
  updatedAt: '2026-05-30T09:00:00.000Z',
  records: [
    {
      id: 'fixture-memory-open-source',
      fileName: '2026-05-30-aurora-open-source.md',
      path: '/tmp/hermes-fixture-vault/MiroFish_Records/2026-05-30-aurora-open-source.md',
      relativePath: 'MiroFish_Records/2026-05-30-aurora-open-source.md',
      title: 'Aurora OS open-source strategy',
      question: '推演 Aurora OS 開源策略',
      date: '2026-05-30T08:30:00.000Z',
      finalVerdict: 'SYNTH PROCEED · pilot 62%',
      summary: 'Proceed with a staged open-source pilot while keeping gateways and private vault paths isolated.',
      source: 'aurora-universal-brain',
      tags: ['aurora', 'mirofish'],
      size: 2048,
      updatedAt: '2026-05-30T08:30:00.000Z',
    },
    {
      id: 'fixture-memory-vite-risk',
      fileName: '2026-05-30-vite-webpack-risk.md',
      path: '/tmp/hermes-fixture-vault/MiroFish_Records/2026-05-30-vite-webpack-risk.md',
      relativePath: 'MiroFish_Records/2026-05-30-vite-webpack-risk.md',
      title: 'Vite migration risk',
      question: '分析 Vite 替換 webpack 的風險',
      date: '2026-05-30T07:10:00.000Z',
      finalVerdict: 'SYNTH HOLD · require spike',
      summary: 'Hold broad migration until plugin compatibility and chunk strategy are verified.',
      source: 'aurora-universal-brain',
      tags: ['architecture', 'mirofish'],
      size: 1536,
      updatedAt: '2026-05-30T07:10:00.000Z',
    },
  ],
}

const sampleLifeOsState = {
  identity: {
    name: 'kk',
    birthdate: '1988-02-17',
    astrology: 'Aquarius',
    chineseZodiac: 'Dragon',
    gender: 'male',
    occupation: 'System Architect',
  },
  financialState: {
    cashAndLiquidity: {
      twdAvailable: 180000,
      twdFixedReserve: 120000,
      foreignCurrencyReserve: 50000,
    },
    investmentEquity: {
      domesticStocks: [
        { symbol: '2330', name: 'TSMC', shares: 500, costBasis: 650, currentPrice: 840 },
      ],
      usStocks: [
        { symbol: 'NVDA', name: 'NVIDIA', shares: 20, costBasis: 450, currentPrice: 126.42 },
        { symbol: 'MSFT', name: 'Microsoft', shares: 12, costBasis: 300, currentPrice: 434.1 },
      ],
    },
    liabilities: {
      loanTotal: 300000,
    },
    monthlyInflow: {
      totalIncome: 90000,
    },
    monthlyOutflow: {
      fixedEssential: 28000,
      discretionaryLiving: 12000,
      subscriptionsAndEducation: 5000,
      annualExpenseAmortized: 6000,
    },
  },
  marketSettings: {
    usdTwdRate: 32,
    usdTwdSource: 'fixture',
    updatedAt: '2026-05-28T12:00:00.000Z',
  },
  budgeting: {
    month: '2026-05',
    accounts: [
      { id: 'cash-main', name: 'Main Cash', type: '活存', balance: 180000 },
      { id: 'cash-reserve', name: 'Reserve', type: '定存', balance: 120000 },
      { id: 'brokerage-cash', name: 'Brokerage', type: '證券戶', balance: 0 },
    ],
    categories: [
      { id: 'housing', name: 'Housing', group: 'Life', budgeted: 28000 },
      { id: 'living', name: 'Living', group: 'Life', budgeted: 12000 },
      { id: 'learning', name: 'Learning', group: 'Growth', budgeted: 5000 },
      { id: 'investing', name: 'Investing', group: 'Assets', budgeted: 20000 },
    ],
    transactions: [
      { id: 'tx-income', date: '2026-05-25', accountId: 'cash-main', categoryId: 'income', payee: 'Salary', amount: 90000, note: 'fixture' },
      { id: 'tx-housing', date: '2026-05-01', accountId: 'cash-main', categoryId: 'housing', payee: 'Rent', amount: -28000, note: 'fixture' },
      { id: 'tx-living', date: '2026-05-12', accountId: 'cash-main', categoryId: 'living', payee: 'Daily', amount: -9000, note: 'fixture' },
    ],
  },
  evolution: {
    learningQuests: [
      { id: 'quest-ai', title: 'Ship Aurora OS', category: 'AI', expectedImpact: 'Operating layer +5', status: '進行中' },
    ],
    skills: [
      { name: 'AI Systems', level: 86 },
      { name: 'Quant Risk', level: 64 },
    ],
  },
  lifeScores: {
    finance: 74,
    discipline: 68,
    learning: 72,
    business: 54,
    retirement: 31,
  },
  targetMonthlyPassiveIncome: 100000,
  computedMetrics: {
    totalCash: 350000,
    totalStocks: 667876,
    totalAssets: 1017876,
    netWorth: 717876,
    totalExpenses: 51000,
    investmentTransfers: 0,
    netMonthlyCashFlow: 39000,
    cashReserveMonths: 6.9,
    investmentRatio: 65.6,
    usdTwdRate: 32,
    domesticStocksTwd: 420000,
    usStocksTwd: 247876,
    fireTarget: 3000000,
    fireProgress: 23.9,
    budgetMetrics: {
      totalBudgeted: 65000,
      totalSpent: 37000,
      operatingSpent: 37000,
      transferSpent: 0,
      totalRemaining: 28000,
      availableToBudget: 350000,
      categories: [
        { id: 'housing', name: 'Housing', group: 'Life', budgeted: 28000, spent: 28000, remaining: 0 },
        { id: 'living', name: 'Living', group: 'Life', budgeted: 12000, spent: 9000, remaining: 3000 },
        { id: 'learning', name: 'Learning', group: 'Growth', budgeted: 5000, spent: 0, remaining: 5000 },
        { id: 'investing', name: 'Investing', group: 'Assets', budgeted: 20000, spent: 0, remaining: 20000 },
      ],
    },
    domesticStockMetrics: {
      items: [
        { symbol: '2330', name: 'TSMC', shares: 500, costBasis: 650, currentPrice: 840, marketValue: 420000, gainLoss: 95000, gainLossPct: 29.23, currency: 'TWD', fxRate: 1, marketValueTwd: 420000, costTwd: 325000, gainLossTwd: 95000 },
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
        { symbol: 'NVDA', name: 'NVIDIA', shares: 20, costBasis: 450, currentPrice: 126.42, marketValue: 2528.4, gainLoss: -6471.6, gainLossPct: -71.91, currency: 'USD', fxRate: 32, marketValueTwd: 80908.8, costTwd: 288000, gainLossTwd: -207091.2 },
        { symbol: 'MSFT', name: 'Microsoft', shares: 12, costBasis: 300, currentPrice: 434.1, marketValue: 5209.2, gainLoss: 1609.2, gainLossPct: 44.7, currency: 'USD', fxRate: 32, marketValueTwd: 166694.4, costTwd: 115200, gainLossTwd: 51494.4 },
      ],
      currency: 'USD',
      fxRate: 32,
      totalMarketValue: 7737.6,
      totalCost: 12600,
      totalGainLoss: -4862.4,
      totalGainLossPct: -38.59,
      totalMarketValueTwd: 247603.2,
      totalCostTwd: 403200,
      totalGainLossTwd: -155596.8,
    },
  },
}

const sampleQuantPaperAccount = {
  updatedAt: '2026-05-28T12:00:00.000Z',
  initialCapital: 1000,
  cash: 940,
  equity: 1025,
  realizedPnl: 25,
  returnPct: 2.5,
  dailyReturnPct: 0.4,
  maxDrawdownPct: 1.1,
  maxEquity: 1030,
  tradeCount: 2,
  wins: 1,
  losses: 0,
  winRate: 50,
  grossProfit: 25,
  grossLoss: 0,
  profitFactor: null,
  positions: [
    { ticker: 'NVDA', shares: 1, avgCost: 120, lastPrice: 126.42, stop: '116' },
  ],
  journal: [
    { id: 'journal-fixture', time: '2026-05-28T12:00:00.000Z', ticker: 'NVDA', action: 'WATCH', note: 'Fixture journal entry.' },
  ],
  guardrails: { status: 'OK', messages: [], maxPositions: 5, maxSinglePositionPct: 20 },
}

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }
}

function recordRequest(request: Request): MockedRequest {
  const url = new URL(request.url())
  return {
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
    headers: request.headers(),
    postData: request.postData(),
  }
}

export async function mockHermesApi(page: Page, options: MockHermesApiOptions = {}) {
  const requests: MockedRequest[] = []
  const unexpectedRequests: MockedRequest[] = []
  const tokenValidationStatus = options.tokenValidationStatus ?? 200
  let activeProfileName = options.initialProfileName ?? 'research'
  let auroraIntentAuditRecords: unknown[] = []
  const auroraProfilePreferences = new Map<string, unknown>()

  await page.route('**/*', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (!(pathname === '/health' || pathname.startsWith('/api/') || pathname.startsWith('/v1/'))) {
      await route.continue()
      return
    }

    requests.push(recordRequest(request))

    if (pathname === '/health') {
      await route.fulfill(jsonResponse({ status: 'ok', webui_version: '0.5.23', node_version: '23.0.0' }))
      return
    }

    if (pathname === '/api/auth/status') {
      await route.fulfill(jsonResponse({ hasPasswordLogin: true, username: 'playwright' }))
      return
    }

    if (pathname === '/api/auth/login') {
      if (request.method() !== 'POST') {
        await route.fulfill(jsonResponse({ error: 'Method not allowed' }, 405))
        return
      }
      if (tokenValidationStatus !== 200) {
        await route.fulfill(jsonResponse({ error: 'Invalid username or password' }, tokenValidationStatus))
        return
      }
      await route.fulfill(jsonResponse({ token: TEST_ACCESS_KEY }))
      return
    }

    if (pathname === '/api/auth/me') {
      await route.fulfill(jsonResponse({
        user: {
          id: 1,
          username: 'playwright',
          role: 'super_admin',
          status: 'active',
          created_at: 0,
          updated_at: 0,
          last_login_at: 0,
        },
      }))
      return
    }

    if (pathname === '/api/hermes/sessions') {
      await route.fulfill(jsonResponse({ sessions: options.sessions ?? [] }, tokenValidationStatus))
      return
    }

    if (pathname === '/api/hermes/sessions/hermes') {
      await route.fulfill(jsonResponse({ sessions: [] }))
      return
    }

    if (pathname === '/api/hermes/sessions/context-length') {
      await route.fulfill(jsonResponse({ context_length: 256000 }))
      return
    }

    if (pathname === '/api/hermes/files/list') {
      await route.fulfill(jsonResponse({ entries: [], path: '' }))
      return
    }

    if (pathname === '/api/hermes/auth/copilot/check-token') {
      await route.fulfill(jsonResponse({ has_token: false, source: null, enabled: false }))
      return
    }

    if (pathname === '/api/auth/locked-ips') {
      await route.fulfill(jsonResponse({ locks: [] }))
      return
    }

    if (pathname === '/api/hermes/available-models') {
      await route.fulfill(jsonResponse({
        default: 'test-model',
        default_provider: 'test-provider',
        groups: [sampleModelGroup],
        allProviders: [sampleModelGroup],
        model_aliases: {},
        model_visibility: {},
      }))
      return
    }

    if (pathname === '/api/hermes/provider-models') {
      await route.fulfill(jsonResponse({ models: ['proxy-model-a', 'proxy-model-b'] }))
      return
    }

    if (pathname === '/api/hermes/profiles') {
      await route.fulfill(jsonResponse({
        profiles: [
          { name: 'default', active: activeProfileName === 'default', model: 'test-model', gateway: 'test', alias: 'Default' },
          { name: 'research', active: activeProfileName === 'research', model: 'test-model', gateway: 'test', alias: 'Research' },
        ],
      }))
      return
    }

    if (pathname === '/api/hermes/profiles/runtime-statuses') {
      await route.fulfill(jsonResponse({
        profiles: [
          {
            profile: 'default',
            bridge: { running: activeProfileName === 'default', profile: 'default', reachable: true },
            gateway: { running: true, profile: 'default' },
          },
          {
            profile: 'research',
            bridge: { running: activeProfileName === 'research', profile: 'research', reachable: true },
            gateway: { running: true, profile: 'research' },
          },
        ],
      }))
      return
    }

    if (pathname === '/api/hermes/profiles/active') {
      if (request.method() !== 'PUT') {
        await route.fulfill(jsonResponse({ error: 'Method not allowed' }, 405))
        return
      }

      let body: { name?: unknown }
      try {
        body = JSON.parse(request.postData() || '{}')
      } catch {
        await route.fulfill(jsonResponse({ error: 'Invalid JSON body' }, 400))
        return
      }

      if (body.name !== 'default' && body.name !== 'research') {
        await route.fulfill(jsonResponse({ error: 'Unknown profile' }, 400))
        return
      }

      activeProfileName = body.name
      await route.fulfill(jsonResponse({ success: true, active: activeProfileName }))
      return
    }

    const auroraPreferencesMatch = pathname.match(/^\/api\/hermes\/profiles\/([^/]+)\/aurora-preferences$/)
    if (auroraPreferencesMatch) {
      const profileName = decodeURIComponent(auroraPreferencesMatch[1])
      if (profileName !== 'default' && profileName !== 'research') {
        await route.fulfill(jsonResponse({ error: 'Profile not found' }, 404))
        return
      }
      if (request.method() === 'GET') {
        const preferences = auroraProfilePreferences.get(profileName) || {
          schemaVersion: 1,
          updatedAt: '2026-05-28T12:00:00.000Z',
          desktop: {
            pinnedApps: ['life-os', 'quant-lab'],
            updatedAt: '2026-05-28T12:00:00.000Z',
          },
        }
        await route.fulfill(jsonResponse({
          profile: profileName,
          storage: auroraProfilePreferences.has(profileName) ? 'profile' : 'default',
          preferences,
        }))
        return
      }
      if (request.method() === 'PUT') {
        let body: { desktop?: { pinnedApps?: unknown } }
        try {
          body = JSON.parse(request.postData() || '{}')
        } catch {
          await route.fulfill(jsonResponse({ error: 'Invalid JSON body' }, 400))
          return
        }
        const pinnedApps = Array.isArray(body.desktop?.pinnedApps)
          ? body.desktop.pinnedApps.filter((item): item is string => typeof item === 'string')
          : ['life-os', 'quant-lab']
        const preferences = {
          schemaVersion: 1,
          updatedAt: '2026-05-28T12:05:00.000Z',
          desktop: {
            pinnedApps,
            updatedAt: '2026-05-28T12:05:00.000Z',
          },
        }
        auroraProfilePreferences.set(profileName, preferences)
        await route.fulfill(jsonResponse({
          profile: profileName,
          storage: 'profile',
          preferences,
        }))
        return
      }
    }

    if (pathname === '/api/hermes/config') {
      await route.fulfill(jsonResponse({
        display: { streaming: true, show_reasoning: true, show_cost: true },
        agent: {},
        memory: {},
        session_reset: {},
        privacy: {},
        approvals: {},
        telegram: { require_mention: true, reactions: true },
        discord: { require_mention: true, auto_thread: true },
        slack: { require_mention: false },
        whatsapp: {},
        matrix: {},
        weixin: {},
        wecom: {},
        feishu: {},
        dingtalk: {},
        qqbot: {},
        platforms: {
          telegram: { enabled: true, token: 'fixture-telegram-token' },
          discord: { enabled: true, token: 'fixture-discord-token' },
        },
      }))
      return
    }

    if (pathname === '/api/hermes/jobs') {
      await route.fulfill(jsonResponse({ jobs: [sampleJob] }))
      return
    }

    if (pathname === '/api/hermes/kanban' && request.method() === 'POST') {
      const payload = JSON.parse(request.postData() || '{}') as { title?: string; body?: string; priority?: number }
      await route.fulfill(jsonResponse({
        task: {
          ...sampleKanbanTasks[0],
          id: 'task-created-governance',
          title: payload.title || 'Created from Aurora',
          body: payload.body || null,
          priority: typeof payload.priority === 'number' ? payload.priority : 0,
          status: 'todo',
          created_at: Date.now(),
          started_at: null,
          completed_at: null,
        },
      }))
      return
    }

    if (pathname === '/api/hermes/kanban') {
      await route.fulfill(jsonResponse({ tasks: sampleKanbanTasks }))
      return
    }

    if (pathname === '/api/hermes/kanban/boards') {
      await route.fulfill(jsonResponse({ boards: sampleKanbanBoards }))
      return
    }

    if (pathname === '/api/hermes/kanban/capabilities') {
      await route.fulfill(jsonResponse({ capabilities: sampleKanbanCapabilities }))
      return
    }

    if (pathname === '/api/hermes/kanban/stats') {
      await route.fulfill(jsonResponse({
        stats: {
          total: sampleKanbanTasks.length,
          by_status: { running: 1, todo: 1 },
          by_assignee: { kk: 1, unassigned: 1 },
        },
      }))
      return
    }

    if (pathname === '/api/hermes/kanban/assignees') {
      await route.fulfill(jsonResponse({ assignees: sampleKanbanAssignees }))
      return
    }

    if (pathname === '/api/hermes/memory') {
      await route.fulfill(jsonResponse(sampleMemory))
      return
    }

    if (pathname === '/api/hermes/skills') {
      await route.fulfill(jsonResponse(sampleSkillsResponse))
      return
    }

    if (pathname === '/api/hermes/plugins') {
      await route.fulfill(jsonResponse(samplePluginsResponse))
      return
    }

    if (pathname === '/api/hermes/group-chat/rooms') {
      await route.fulfill(jsonResponse({
        rooms: [
          {
            id: 'room-aurora-fixture',
            name: 'Aurora Review Room',
            inviteCode: 'AURORA',
            triggerTokens: 100000,
            maxHistoryTokens: 32000,
            tailMessageCount: 10,
            totalTokens: 0,
          },
        ],
      }))
      return
    }

    if (pathname === '/api/hermes/system-status') {
      await route.fulfill(jsonResponse({
        status: 'ok',
        checked_at: '2026-05-30T09:00:00.000Z',
        profile: activeProfileName,
        hermes_home: '/tmp/hermes-fixture',
        components: [
          {
            key: 'aurora-shell',
            label: 'Aurora OS Shell',
            status: 'ok',
            summary: 'Intent-first shell is serving the retired Hermes UI surface.',
            detail: 'Playwright fixture status.',
            updated_at: '2026-05-30T09:00:00.000Z',
            metadata: { profile: activeProfileName, mode: 'aurora' },
          },
          {
            key: 'mirofish-backend',
            label: 'MiroFish Backend',
            status: 'ok',
            summary: 'Sandbox inference endpoint ready.',
            updated_at: '2026-05-30T09:00:00.000Z',
            metadata: { running: true, port: 5174 },
          },
        ],
      }))
      return
    }

    if (pathname === '/api/hermes/system-status/action') {
      await route.fulfill(jsonResponse({
        ok: true,
        action: 'open-mirofish',
        message: 'Fixture system action accepted.',
      }))
      return
    }

    if (pathname === '/api/aurora/intent-audit') {
      if (request.method() === 'GET') {
        await route.fulfill(jsonResponse({
          generatedAt: '2026-05-28T12:00:00.000Z',
          storage: 'server',
          records: auroraIntentAuditRecords,
        }))
        return
      }

      if (request.method() === 'POST') {
        let body: { record?: unknown }
        try {
          body = JSON.parse(request.postData() || '{}')
        } catch {
          await route.fulfill(jsonResponse({ error: 'Invalid JSON body' }, 400))
          return
        }

        if (body.record && typeof body.record === 'object') {
          const record = body.record as { id?: unknown }
          auroraIntentAuditRecords = [
            body.record,
            ...auroraIntentAuditRecords.filter(existing =>
              !record.id || (existing as { id?: unknown }).id !== record.id,
            ),
          ].slice(0, 50)
        }
        await route.fulfill(jsonResponse({ ok: true, record: body.record, count: auroraIntentAuditRecords.length }))
        return
      }

      if (request.method() === 'DELETE') {
        auroraIntentAuditRecords = []
        await route.fulfill(jsonResponse({ ok: true, count: 0 }))
        return
      }
    }

    if (pathname === '/api/aurora/compute-load') {
      await route.fulfill(jsonResponse({
        active: 0,
        queued: 0,
        maxConcurrency: 2,
        completed: 4,
        failed: 0,
        byPriority: {
          high: 0,
          medium: 0,
          low: 0,
        },
        updatedAt: '2026-05-31T02:00:00.000Z',
      }))
      return
    }

    if (pathname === '/api/aurora/vibe-build') {
      await route.fulfill(jsonResponse(sampleVibeBuildResponse))
      return
    }

    if (pathname === '/api/aurora/vibe-apply') {
      await route.fulfill(jsonResponse({
        ok: true,
        path: sampleVibeBuildResponse.componentPath,
        manifestPath: 'packages/client/src/components/generated/PomodoroGlassWidget.manifest.json',
        audit: {
          buildId: sampleVibeBuildResponse.buildId,
          widgetName: sampleVibeBuildResponse.widgetName,
          path: `/tmp/hermes-web-ui/${sampleVibeBuildResponse.componentPath}`,
          manifestPath: '/tmp/hermes-web-ui/packages/client/src/components/generated/PomodoroGlassWidget.manifest.json',
          appliedAt: '2026-05-28T12:00:00.000Z',
          securityReport: [],
        },
      }))
      return
    }

    if (pathname === '/api/aurora/generated-widgets') {
      await route.fulfill(jsonResponse(sampleGeneratedWidgetManifest))
      return
    }

    if (pathname === '/api/hermes/quant-lab/snapshot') {
      await route.fulfill(jsonResponse(sampleQuantSnapshot))
      return
    }

    if (pathname === '/api/hermes/quant-lab/phase-validation') {
      await route.fulfill(jsonResponse({
        ok: true,
        source: 'fixture',
        updatedAt: '2026-05-28T12:00:00.000Z',
        phases: [],
      }))
      return
    }

    if (pathname === '/api/hermes/quant-lab/run-mirofish') {
      let body: { targetTicker?: unknown } = {}
      try {
        body = JSON.parse(request.postData() || '{}')
      } catch {
        body = {}
      }
      await route.fulfill(jsonResponse(sampleMiroFishRunResponseForTarget(body.targetTicker)))
      return
    }

    if (pathname === '/api/hermes/quant-lab/audit-snapshots') {
      await route.fulfill(jsonResponse(sampleMiroFishAuditSnapshots))
      return
    }

    if (pathname === '/api/hermes/quant-lab/mirofish-memory-records') {
      await route.fulfill(jsonResponse({
        ...sampleMiroFishMemoryRecords,
        records: sampleMiroFishMemoryRecords.records.slice(
          0,
          Number(url.searchParams.get('limit') || sampleMiroFishMemoryRecords.records.length),
        ),
      }))
      return
    }

    if (pathname === '/api/hermes/quant-lab/save-report') {
      let body: { fileName?: unknown; content?: unknown } = {}
      try {
        body = JSON.parse(request.postData() || '{}')
      } catch {
        body = {}
      }
      const fileName = typeof body.fileName === 'string' && body.fileName.trim()
        ? body.fileName
        : 'mirofish-audit-fixture.md'
      await route.fulfill(jsonResponse({
        ok: true,
        path: `/tmp/hermes-fixture-journal/${fileName}`,
        relativePath: `trading-journal/${fileName}`,
      }))
      return
    }

    if (pathname === '/api/hermes/quant-lab/provider-settings') {
      await route.fulfill(jsonResponse({
        ok: true,
        envPath: '/tmp/hermes-fixture.env',
        updatedAt: '2026-05-28T12:00:00.000Z',
        providers: [],
      }))
      return
    }

    if (pathname === '/api/hermes/quant-lab/paper-account') {
      await route.fulfill(jsonResponse(sampleQuantPaperAccount))
      return
    }

    if (pathname === '/api/hermes/quant-lab/candles') {
      await route.fulfill(jsonResponse({
        ok: true,
        symbol: url.searchParams.get('symbol') || 'NVDA',
        timeframe: url.searchParams.get('timeframe') || '15m',
        source: 'fixture',
        status: 'OK',
        mode: 'mock',
        updatedAt: '2026-05-28T12:00:00.000Z',
        providerStatus: [],
        providerErrors: [],
        message: 'fixture candles',
        dataTruth: { area: 'Candles', mode: 'mock', source: 'fixture', detail: 'Playwright fixture candles.' },
        bars: [
          { time: 1779960000, open: 120, high: 127, low: 119, close: 126.42, volume: 1200000 },
          { time: 1779960900, open: 126.42, high: 128, low: 125, close: 127.2, volume: 980000 },
        ],
      }))
      return
    }

    if (pathname === '/api/hermes/quant-lab/mirofish-evidence-archives') {
      await route.fulfill(jsonResponse({
        ok: true,
        entries: [
          {
            fileName: '2026-05-28-nvda-risk-on.md',
            path: '/tmp/hermes-fixture-evidence/2026-05-28-nvda-risk-on.md',
            relativePath: 'fixture-evidence/2026-05-28-nvda-risk-on.md',
            title: 'Fixture Past Debate: NVDA risk-on',
            createdAt: '2026-05-28T11:30:00.000Z',
            updatedAt: '2026-05-28T11:45:00.000Z',
            phase: 'premarket',
            status: 'report_ready',
            confidence: 'high',
            source: 'fixture',
            graphOk: true,
            graphId: 'fixture-graph-nvda',
            graphSource: 'local-file',
            nodeCount: 8,
            edgeCount: 12,
            evidenceCount: 9,
            topDegrees: [{ ticker: 'NVDA', degree: 4 }, { ticker: 'MSFT', degree: 2 }],
            support: 'Momentum and AI demand remained aligned.',
            oppose: 'Valuation left limited room for execution error.',
            summary: 'Past fixture debate favored a reduced-size BUY while preserving strict invalidation.',
            size: 2048,
          },
          {
            fileName: '2026-05-27-msft-chop.md',
            path: '/tmp/hermes-fixture-evidence/2026-05-27-msft-chop.md',
            relativePath: 'fixture-evidence/2026-05-27-msft-chop.md',
            title: 'Fixture Past Debate: MSFT chop',
            createdAt: '2026-05-27T11:30:00.000Z',
            updatedAt: '2026-05-27T11:45:00.000Z',
            phase: 'premarket',
            status: 'archived',
            confidence: 'medium',
            source: 'fixture',
            graphOk: false,
            graphSource: 'none',
            nodeCount: 4,
            edgeCount: 3,
            evidenceCount: 5,
            topDegrees: [{ ticker: 'MSFT', degree: 3 }],
            support: 'Durable enterprise demand supported the base case.',
            oppose: 'Neutral market breadth argued against aggressive sizing.',
            summary: 'Past fixture debate held MSFT in watch mode until trend expansion returned.',
            size: 1536,
          },
        ],
        path: '/tmp/hermes-fixture-evidence',
        relativePath: 'fixture-evidence',
        updatedAt: '2026-05-28T12:00:00.000Z',
      }))
      return
    }

    if (pathname === '/api/hermes/life-os/state') {
      await route.fulfill(jsonResponse(sampleLifeOsState))
      return
    }

    if (pathname === '/api/hermes/life-os/monthly-settlements') {
      await route.fulfill(jsonResponse({
        currentMonth: '2026-05',
        currentMonthClosed: false,
        latest: null,
        items: [],
      }))
      return
    }

    if (pathname === '/api/nexus/evaluate' || pathname === '/api/hermes/nexus/evaluate') {
      await route.fulfill(jsonResponse({
        ok: true,
        advice: 'Fixture NEXUS advice keeps budget pressure calm.',
        source: 'fixture',
        breachedBudgets: [],
        generatedAt: '2026-05-28T12:00:00.000Z',
      }))
      return
    }

    if (pathname === '/api/cron-history') {
      await route.fulfill(jsonResponse({ runs: [] }))
      return
    }

    unexpectedRequests.push(recordRequest(request))
    await route.fulfill(jsonResponse({ error: `Unexpected mocked route: ${request.method()} ${pathname}` }, 404))
  })

  return { requests, unexpectedRequests }
}

export async function authenticate(page: Page, accessKey = TEST_ACCESS_KEY, profileName?: string) {
  await page.addInitScript((state: { storedToken: string; storedProfileName?: string }) => {
    const { storedToken, storedProfileName } = state
    window.localStorage.setItem('hermes_api_key', storedToken)
    window.localStorage.setItem('hermes_locale', 'en-US')
    if (storedProfileName && !window.localStorage.getItem('hermes_active_profile_name')) {
      window.localStorage.setItem('hermes_active_profile_name', storedProfileName)
    }
  }, { storedToken: accessKey, storedProfileName: profileName })
}

export async function mockChatSocket(page: Page) {
  await page.route('**/node_modules/.vite/deps/socket__io-client.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
const state = window.__PW_CHAT_SOCKET__ || (window.__PW_CHAT_SOCKET__ = { sockets: [], emitted: [] })
function makeSocket(url, options) {
  const listeners = new Map()
  const onceListeners = new Map()
  const socket = {
    connected: true,
    url,
    options,
    on(event, handler) {
      const handlers = listeners.get(event) || []
      handlers.push(handler)
      listeners.set(event, handlers)
      return this
    },
    once(event, handler) {
      const handlers = onceListeners.get(event) || []
      handlers.push(handler)
      onceListeners.set(event, handlers)
      return this
    },
    emit(event, payload) {
      state.emitted.push({ event, payload })
      if (event === 'resume') {
        const sessionId = payload && payload.session_id
        const resumes = window.__PW_CHAT_SOCKET_RESUMES__ || {}
        const response = sessionId ? resumes[sessionId] : null
        if (response) {
          setTimeout(() => this.__trigger('resumed', response), 0)
        }
      }
      return this
    },
    removeAllListeners() {
      listeners.clear()
      onceListeners.clear()
      return this
    },
    disconnect() {
      this.connected = false
      return this
    },
    __trigger(event, payload) {
      for (const handler of listeners.get(event) || []) handler(payload)
      const handlers = onceListeners.get(event) || []
      onceListeners.delete(event)
      for (const handler of handlers) handler(payload)
    },
  }
  state.sockets.push(socket)
  state.latest = socket
  return socket
}
export function io(url, options) {
  return makeSocket(url, options)
}
export default { io }
`,
    })
  })
}

export async function mockTerminalWebSocket(page: Page) {
  await page.addInitScript(() => {
    const state = (window as any).__PW_TERMINAL_WS__ = {
      sockets: [] as any[],
      sent: [] as any[],
      createdCount: 0,
      latest: null as any,
    }
    const RealEvent = window.Event
    const RealMessageEvent = window.MessageEvent

    class MockTerminalWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3
      binaryType: BinaryType = 'blob'
      bufferedAmount = 0
      extensions = ''
      protocol = ''
      readyState = MockTerminalWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null

      constructor(readonly url: string | URL) {
        super()
        state.sockets.push(this)
        state.latest = this
        setTimeout(() => {
          this.readyState = MockTerminalWebSocket.OPEN
          const openEvent = new RealEvent('open')
          this.onopen?.(openEvent)
          this.dispatchEvent(openEvent)
          this.__createSession('term-1', 'zsh', 101)
        }, 0)
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        const normalized = typeof data === 'string' ? data : String(data)
        state.sent.push({ socket: this.url.toString(), data: normalized })
        if (normalized.charCodeAt(0) !== 0x7B) return
        try {
          const message = JSON.parse(normalized)
          if (message.type === 'create') {
            this.__createSession(`term-${state.createdCount + 1}`, 'bash', 200 + state.createdCount)
          }
          if (message.type === 'switch') {
            this.__emitMessage(JSON.stringify({ type: 'switched', id: message.sessionId }))
          }
        } catch {}
      }

      close() {
        this.readyState = MockTerminalWebSocket.CLOSED
      }

      __createSession(id: string, shell: string, pid: number) {
        state.createdCount += 1
        this.__emitMessage(JSON.stringify({ type: 'created', id, shell, pid }))
      }

      __emitMessage(data: string) {
        const event = new RealMessageEvent('message', { data })
        this.onmessage?.(event)
        this.dispatchEvent(event)
      }
    }

    ;(window as any).WebSocket = MockTerminalWebSocket
  })
}

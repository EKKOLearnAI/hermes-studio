import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InternetExecutionStore,
  withInternetExecutionDb,
} from '../../packages/server/src/services/hermes/internet-execution'

const fabric = vi.hoisted(() => ({
  createFabricIntent: vi.fn(),
  getFabricWorkflow: vi.fn(),
  listFabricExecutors: vi.fn(),
  listFabricWorkflows: vi.fn(),
}))
const production = vi.hoisted(() => ({
  BILIBILI_MCP_EXECUTOR_ID: 'bilibili-mcp',
  BILIBILI_BROWSER_EXECUTOR_ID: 'bilibili-browser',
  getInternetProductionRuntimeStatus: vi.fn(),
  reconcileInternetProductionRuntime: vi.fn(async () => {}),
}))

vi.mock('../../packages/server/src/services/hermes/action-fabric', () => fabric)
vi.mock('../../packages/server/src/services/hermes/internet-execution/production-runtime', () => production)

describe('internet execution controller', () => {
  const originalHome = process.env.HERMES_HOME
  let directory = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hermes-internet-controller-'))
    process.env.HERMES_HOME = directory
    vi.clearAllMocks()
    production.getInternetProductionRuntimeStatus.mockReturnValue(runtimeStatus())
    fabric.createFabricIntent.mockReturnValue(actionResult())
    fabric.getFabricWorkflow.mockReturnValue(workflowDetail())
    fabric.listFabricExecutors.mockReturnValue([
      { id: 'bilibili-mcp', type: 'mcp', environment: 'production', enabled: true, health: 'healthy' },
      { id: 'bilibili-browser', type: 'browser', environment: 'production', enabled: false, health: 'degraded' },
    ])
    fabric.listFabricWorkflows.mockReturnValue([workflowDetail()])
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(directory, { recursive: true, force: true })
  })

  it('serves a bounded overview without executor configuration details', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/internet-execution')
    const ctx = context()
    await ctrl.overview(ctx)
    expect(ctx.body).toMatchObject({
      provider: { provider: 'bilibili', profile: 'default', selectedExecutorType: 'mcp' },
      executors: [
        { type: 'mcp', enabled: true, health: 'healthy', selected: true },
        { type: 'browser', enabled: false, health: 'degraded', selected: false },
      ],
      summary: { activeWorkflowCount: 1, receiptCount: 0 },
    })
    expect(JSON.stringify(ctx.body)).not.toMatch(/server|tool|bridgeContract|primitive|healthDetails|executorId/i)
  })

  it('creates only server-bound semantic search and inspect intents', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/internet-execution')
    const search = context({ query: 'Hermes Agent', idempotencyKey: 'search-1' })
    await ctrl.searchBilibili(search)
    expect(search.status).toBe(202)
    expect(fabric.createFabricIntent).toHaveBeenCalledWith({
      capabilityId: 'bilibili.video.search',
      requestedByRoleId: 'entertainment-assistant',
      requestedByUserId: '42',
      idempotencyKey: 'search-1',
      goal: 'Search public Bilibili videos',
      target: { kind: 'internet_provider', provider: 'bilibili', origin: 'www.bilibili.com', profile: 'default' },
      input: { schemaVersion: 1, provider: 'bilibili', profile: 'default', query: 'Hermes Agent',
        limit: 10, page: 1, order: 'relevance' },
      constraints: {},
      rationale: 'Explicit authenticated semantic internet read',
      environments: ['production'],
    })

    const inspect = context({ bvid: 'BV1xx411c7mD', idempotencyKey: 'inspect-1' })
    await ctrl.inspectBilibili(inspect)
    expect(inspect.status).toBe(202)
    expect(fabric.createFabricIntent).toHaveBeenLastCalledWith(expect.objectContaining({
      capabilityId: 'bilibili.video.inspect',
      input: { schemaVersion: 1, provider: 'bilibili', profile: 'default', bvid: 'BV1xx411c7mD' },
    }))
    expect(production.reconcileInternetProductionRuntime).toHaveBeenCalledTimes(2)
  })

  it('rejects raw tools, browser controls, URLs, and caller-selected bindings', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/internet-execution')
    for (const body of [
      { query: 'safe', idempotencyKey: 'search-2', tool: 'publish_video' },
      { query: 'safe', idempotencyKey: 'search-3', profile: 'other' },
      { query: 'safe', idempotencyKey: 'search-4', target: { origin: '127.0.0.1' } },
      { bvid: 'BV1xx411c7mD', idempotencyKey: 'inspect-2', url: 'file:///etc/passwd' },
      { bvid: 'not-a-bvid', idempotencyKey: 'inspect-3' },
    ]) {
      const ctx = context(body)
      if ('query' in body) await ctrl.searchBilibili(ctx)
      else await ctrl.inspectBilibili(ctx)
      expect(ctx).toMatchObject({ status: 400, body: { code: 'INTERNET_REQUEST_INVALID' } })
    }
    expect(fabric.createFabricIntent).not.toHaveBeenCalled()
  })

  it('returns normalized receipts and proof stages without raw provider identities', async () => {
    seedVerifiedReceipt()
    const ctrl = await import('../../packages/server/src/controllers/hermes/internet-execution')
    const list = context(undefined, { query: { status: 'verified', limit: '20' } })
    await ctrl.receipts(list)
    expect(list.body.receipts).toHaveLength(1)
    expect(list.body.receipts[0]).toMatchObject({
      capabilityId: 'bilibili.video.search',
      executorType: 'mcp',
      input: { query: 'Hermes', limit: 10, page: 1, order: 'relevance' },
      status: 'verified',
      result: { operation: 'search', videos: [{ bvid: 'BV1xx411c7mD' }] },
    })
    expect(list.body.receipts[0].resultDigest).toMatch(/^[a-f0-9]{64}$/)

    const detail = context(undefined, { workflowId: 'workflow-internet-1' })
    await ctrl.receipt(detail)
    expect(detail.body.evidence).toEqual([{ ordinal: 0, stage: 'provider_read',
      evidenceDigest: 'b'.repeat(64), observedAt: '2026-07-15T02:00:01.000Z' }])
    expect(JSON.stringify([list.body, detail.body])).not.toMatch(/secret-request|executorId|providerRequestId|materialDigest|mcp_call/i)
  })

  it('isolates workflow and receipt reads by authenticated user and hides step internals', async () => {
    seedVerifiedReceipt()
    const ctrl = await import('../../packages/server/src/controllers/hermes/internet-execution')
    const own = context(undefined, { workflowId: 'workflow-internet-1', role: 'user' })
    await ctrl.workflow(own)
    expect(own.body.workflow).toMatchObject({ capabilityId: 'bilibili.video.search', steps: [
      { kind: 'prepare', state: 'succeeded' },
    ] })
    expect(JSON.stringify(own.body)).not.toMatch(/secret-server|secret-tool|output|evidence|executionToken/i)

    fabric.getFabricWorkflow.mockReturnValue(workflowDetail({ requestedByUserId: '99' }))
    const foreign = context(undefined, { workflowId: 'workflow-internet-1', role: 'user' })
    await ctrl.receipt(foreign)
    expect(foreign).toMatchObject({ status: 404, body: { code: 'INTERNET_WORKFLOW_NOT_FOUND' } })
  })

  it('sanitizes unexpected runtime failures', async () => {
    production.reconcileInternetProductionRuntime.mockRejectedValueOnce(new Error('server=private token=secret'))
    const ctrl = await import('../../packages/server/src/controllers/hermes/internet-execution')
    const ctx = context({ query: 'Hermes', idempotencyKey: 'search-failure' })
    await ctrl.searchBilibili(ctx)
    expect(ctx).toMatchObject({ status: 503, body: { code: 'INTERNET_API_OPERATION_FAILED' } })
    expect(JSON.stringify(ctx.body)).not.toMatch(/private|token|secret/i)
  })
})

function seedVerifiedReceipt(): void {
  withInternetExecutionDb(db => {
    const store = new InternetExecutionStore(db)
    const prepared = store.prepareReceipt({
      workflowId: 'workflow-internet-1', intentId: 'intent-internet-1', materialDigest: 'a'.repeat(64),
      capabilityId: 'bilibili.video.search', provider: 'bilibili', profile: 'default',
      executorId: 'bilibili-mcp', executorType: 'mcp', environment: 'production', operation: 'search',
      request: { schemaVersion: 1, provider: 'bilibili', profile: 'default', query: 'Hermes',
        limit: 10, page: 1, order: 'relevance' }, safeToReplay: true,
    }).receipt
    store.recordCheckpoint({ workflowId: prepared.workflowId, materialDigest: prepared.materialDigest, ordinal: 0,
      kind: 'mcp_call', evidenceDigest: 'b'.repeat(64), details: { capabilityId: prepared.capabilityId },
      observedAt: '2026-07-15T02:00:01.000Z' })
    const executing = store.transitionReceipt({ workflowId: prepared.workflowId,
      materialDigest: prepared.materialDigest, expectedVersion: prepared.version, status: 'executing',
      providerRequestId: 'secret-request' })
    const result = { schemaVersion: 1, provider: 'bilibili', profile: 'default', operation: 'search', query: 'Hermes',
      status: 'succeeded', videos: [{ bvid: 'BV1xx411c7mD', title: 'Hermes', author: 'Nous', publishedAt: null,
        durationSeconds: 120, viewCount: 42, canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' }],
      totalCount: 1, omittedCount: 0 }
    const executed = store.transitionReceipt({ workflowId: prepared.workflowId,
      materialDigest: prepared.materialDigest, expectedVersion: executing.version, status: 'executed', result })
    const verifying = store.transitionReceipt({ workflowId: prepared.workflowId,
      materialDigest: prepared.materialDigest, expectedVersion: executed.version, status: 'verifying' })
    store.transitionReceipt({ workflowId: prepared.workflowId, materialDigest: prepared.materialDigest,
      expectedVersion: verifying.version, status: 'verified', result })
  })
}

function context(body?: unknown, options: {
  workflowId?: string; role?: string; query?: Record<string, string>
} = {}): any {
  return {
    params: { workflowId: options.workflowId ?? '' },
    query: options.query ?? {},
    request: { body, type: 'application/json' },
    state: { user: { id: 42, username: 'root', role: options.role ?? 'super_admin' } },
    body: null,
    status: 200,
  }
}

function runtimeStatus() {
  return { active: true, profile: 'default', configured: true, discoveryStatus: 'healthy',
    executorEnabled: true, mcpExecutorEnabled: true, browserExecutorEnabled: false,
    selectedExecutorId: 'bilibili-mcp', authorizedTargetCount: 3, lastErrorCode: null }
}

function actionResult() {
  return {
    intent: { id: 'intent-internet-1', capabilityId: 'bilibili.video.search' },
    policyDecision: { id: 'decision-internet-1', outcome: 'allow', reasonCodes: [] },
    workflow: workflowBase(),
  }
}

function workflowBase(overrides: Record<string, unknown> = {}) {
  return { id: 'workflow-internet-1', state: 'executing', version: 1, attempt: 0, lastErrorCode: null,
    availableActions: { approve: false, reject: false, cancel: true, retry: false, compensate: false },
    createdAt: '2026-07-15T02:00:00.000Z', updatedAt: '2026-07-15T02:00:00.000Z', completedAt: null,
    ...overrides }
}

function workflowDetail(overrides: Record<string, unknown> = {}) {
  return { ...workflowBase(), capabilityId: 'bilibili.video.search', requestedByRoleId: 'entertainment-assistant',
    requestedByUserId: '42', policyDecision: { id: 'decision-internet-1', outcome: 'allow', reasonCodes: [] },
    steps: [{ kind: 'prepare', state: 'succeeded', attempt: 0, lastErrorCode: null,
      output: { server: 'secret-server', tool: 'secret-tool' }, executionToken: 'secret-token',
      updatedAt: '2026-07-15T02:00:00.000Z' }], ...overrides }
}

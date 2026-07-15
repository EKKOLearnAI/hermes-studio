// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  fetchInternetOverview: vi.fn(), fetchInternetReceipts: vi.fn(), fetchInternetReceipt: vi.fn(),
  fetchInternetWorkflow: vi.fn(), searchBilibiliVideos: vi.fn(), inspectBilibiliVideo: vi.fn(),
}))
vi.mock('@/api/hermes/internet-execution', () => api)

import { useInternetExecutionStore } from '@/stores/hermes/internet-execution'

const overview = { provider: { provider: 'bilibili', profile: 'default', active: true, configured: true,
  discoveryStatus: 'healthy', executorEnabled: true, selectedExecutorType: 'mcp', authorizedTargetCount: 1,
  lastErrorCode: null }, executors: [], capabilities: [], summary: { receiptCount: 1, verifiedReceiptCount: 1,
  waitingUserReceiptCount: 0, activeWorkflowCount: 0 } }
const workflow = { id: 'workflow:one', state: 'waiting_user', version: 1, attempt: 0, lastErrorCode: null,
  availableActions: { approve: false, reject: false, cancel: false, retry: false, compensate: false },
  createdAt: 'now', updatedAt: 'now', completedAt: null }
const receipt = { workflowId: 'workflow:one', intentId: 'intent:one', capabilityId: 'bilibili.video.inspect',
  provider: 'bilibili', profile: 'default', executorType: 'browser', environment: 'production', operation: 'inspect',
  input: { bvid: 'BV1ab2cd3EF4' }, safeToReplay: true, status: 'waiting_user', result: null, resultDigest: null,
  errorCode: 'INTERNET_BROWSER_TAKEOVER_REQUIRED', version: 2, createdAt: 'now', updatedAt: 'now', completedAt: 'now' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('internet execution store', () => {
  beforeEach(() => {
    setActivePinia(createPinia()); vi.clearAllMocks()
    api.fetchInternetOverview.mockResolvedValue(overview); api.fetchInternetReceipts.mockResolvedValue([receipt])
    api.fetchInternetReceipt.mockResolvedValue({ receipt, evidence: [{ ordinal: 0, stage: 'navigation', evidenceDigest: null, observedAt: 'now' }] })
    api.fetchInternetWorkflow.mockResolvedValue({ ...workflow, capabilityId: 'bilibili.video.inspect', policyDecision: null, steps: [] })
  })

  it('loads overview and receipts, then derives human takeover from authoritative detail', async () => {
    const store = useInternetExecutionStore()
    await store.loadDashboard()
    store.selectReceipt(receipt as any)
    await Promise.all([store.loadReceipt(receipt.workflowId), store.loadWorkflow(receipt.workflowId)])
    expect(store.overview).toEqual(overview)
    expect(store.receipts).toEqual([receipt])
    expect(store.evidence).toHaveLength(1)
    expect(store.takeoverRequired).toBe(true)
  })

  it('keeps only the newest receipt response and failure', async () => {
    const stale = deferred<any>()
    api.fetchInternetReceipt.mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ receipt: { ...receipt, status: 'verified' }, evidence: [] })
    const store = useInternetExecutionStore()
    const first = store.loadReceipt('workflow:old')
    await store.loadReceipt('workflow:new')
    stale.reject(new Error('stale receipt failure'))
    await expect(first).rejects.toThrow('stale receipt failure')
    expect(store.selectedReceipt?.status).toBe('verified')
    expect(store.resourceErrors.receipt).toBeNull()
  })

  it('serializes Bilibili intents and remembers the latest accepted workflow', async () => {
    const pending = deferred<any>()
    api.searchBilibiliVideos.mockImplementationOnce(() => pending.promise)
    api.inspectBilibiliVideo.mockResolvedValue({ intent: {}, policyDecision: {}, workflow: { ...workflow, id: 'workflow:two' } })
    const store = useInternetExecutionStore()
    const first = store.search({ query: 'Hermes', idempotencyKey: 'search-1' })
    const second = store.inspect({ bvid: 'BV1ab2cd3EF4', idempotencyKey: 'inspect-1' })
    await Promise.resolve()
    expect(api.inspectBilibiliVideo).not.toHaveBeenCalled()
    pending.resolve({ intent: {}, policyDecision: {}, workflow })
    await Promise.all([first, second])
    expect(store.selectedWorkflowId).toBe('workflow:two')
  })

  it('stores no credential, MCP binding, browser session, or provider request material', async () => {
    const store = useInternetExecutionStore()
    await store.loadDashboard()
    expect(JSON.stringify(store.$state)).not.toMatch(/access_token|refresh_token|credential|serverId|toolName|browserSession|providerRequestId/i)
  })
})

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  fetchCommerceOverview: vi.fn(), fetchCommerceOffers: vi.fn(), fetchCommerceComparisons: vi.fn(),
  fetchCommerceCarts: vi.fn(), fetchCommerceQuotes: vi.fn(), fetchCommerceWorkflows: vi.fn(),
  fetchCommerceWorkflow: vi.fn(), fetchCommerceTransactions: vi.fn(), fetchCommerceTransaction: vi.fn(),
  fetchCommerceTakeovers: vi.fn(), fetchCommerceActivationReviews: vi.fn(), searchCommerceOffers: vi.fn(),
  compareCommerceOffers: vi.fn(), createCommerceCart: vi.fn(), createCommerceQuote: vi.fn(),
  placeCommerceOrder: vi.fn(), confirmCommercePayment: vi.fn(), trackCommerceDelivery: vi.fn(),
  cancelCommerceOrder: vi.fn(), requestCommerceRefund: vi.fn(), reviewCommerceWorkflow: vi.fn(),
  updateCommerceAccountHealth: vi.fn(), activateCommerceAccount: vi.fn(), revokeCommerceAccount: vi.fn(),
}))
vi.mock('@/api/hermes/commerce', () => api)
import { useCommerceStore } from '@/stores/hermes/commerce'

const account = { id: 'account-1', provider: 'food_delivery', mode: 'shadow', currency: 'CNY',
  executorId: 'commerce-shadow', displayName: 'Food', health: 'healthy', enabled: true, policyEpoch: 1,
  version: 1, createdAt: 'now', updatedAt: 'now', revokedAt: null }
const workflow = { id: 'workflow-1', capabilityId: 'commerce.product.search', state: 'preparing', version: 1,
  attempt: 0, lastErrorCode: null, createdAt: 'now', updatedAt: 'now', completedAt: null,
  availableActions: { approve: false, reject: false, cancel: true, retry: false, compensate: false } }
const transaction = { id: 'transaction-1', workflowId: 'workflow-order', accountId: account.id,
  provider: 'food_delivery', mode: 'shadow', policyEpoch: 1, quoteId: 'quote-1', quoteDigest: 'a'.repeat(64),
  providerOrderId: null, currency: 'CNY', expectedAmountMinor: 1000, actualAmountMinor: null,
  state: 'waiting_payment', version: 1, createdAt: 'now', updatedAt: 'now', completedAt: null }
const overview = { runtime: { configuredAccountCount: 1, shadowExecutorEnabled: true, liveExecutorEnabled: false,
  authorizedTargetCount: 3, emergencyStopped: false }, accounts: [account], offers: [], workflows: [workflow],
  transactions: [transaction], takeovers: [], summary: { accountCount: 1, liveAccountCount: 0,
    activeOfferCount: 0, activeWorkflowCount: 1, activeTransactionCount: 1, pendingTakeoverCount: 0 } }

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

describe('commerce store', () => {
  beforeEach(() => {
    setActivePinia(createPinia()); vi.clearAllMocks()
    api.fetchCommerceOverview.mockResolvedValue(overview); api.fetchCommerceOffers.mockResolvedValue([])
    api.fetchCommerceComparisons.mockResolvedValue([]); api.fetchCommerceCarts.mockResolvedValue([])
    api.fetchCommerceQuotes.mockResolvedValue([]); api.fetchCommerceWorkflows.mockResolvedValue([workflow])
    api.fetchCommerceTransactions.mockResolvedValue([transaction]); api.fetchCommerceTakeovers.mockResolvedValue([])
    api.fetchCommerceActivationReviews.mockResolvedValue([])
  })

  it('loads the overview first and scopes catalog resources to the selected account', async () => {
    const store = useCommerceStore(); await store.loadDashboard()
    expect(store.selectedAccountId).toBe(account.id)
    expect(api.fetchCommerceOffers).toHaveBeenCalledWith(account.id)
    expect(api.fetchCommerceTransactions).toHaveBeenCalledWith(account.id)
    expect(store.transactions).toEqual([transaction])
  })

  it('serializes actions for the same transaction and remembers the last workflow', async () => {
    const pending = deferred<any>()
    api.confirmCommercePayment.mockImplementationOnce(() => pending.promise)
    api.trackCommerceDelivery.mockResolvedValue({ workflow: { ...workflow, id: 'workflow-2' } })
    const store = useCommerceStore()
    const first = store.confirmPayment({ transactionId: transaction.id, approvalId: 'approval-1',
      idempotencyKey: 'intent-1', rationale: 'pay' })
    const second = store.trackDelivery({ transactionId: transaction.id, idempotencyKey: 'intent-2', rationale: 'track' })
    await Promise.resolve(); expect(api.trackCommerceDelivery).not.toHaveBeenCalled()
    pending.resolve({ workflow }); await Promise.all([first, second])
    expect(store.selectedWorkflowId).toBe('workflow-2')
  })

  it('keeps a newer transaction selection when an older detail arrives last', async () => {
    const stale = deferred<any>()
    api.fetchCommerceTransaction.mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ transaction: { ...transaction, id: 'transaction-2' }, payment: null,
        delivery: [], cancellations: [], refunds: [], checkpoints: [] })
    const store = useCommerceStore(); const first = store.loadTransaction('transaction-1')
    await store.loadTransaction('transaction-2')
    stale.resolve({ transaction, payment: null, delivery: [], cancellations: [], refunds: [], checkpoints: [] })
    await first
    expect(store.selectedTransactionId).toBe('transaction-2')
    expect(store.transactionDetail?.transaction.id).toBe('transaction-2')
  })

  it('stores no address, recipient token, provider request, payment credential, or raw adapter material', async () => {
    const store = useCommerceStore(); await store.loadDashboard()
    expect(JSON.stringify(store.$state)).not.toMatch(/destinationToken|recipientToken|providerRequestId|paymentCredential|cookie|selector|coordinate|rawPayload/i)
  })
})

import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import * as api from '@/api/hermes/commerce'
import type {
  CancelCommerceOrderInput, CommerceAccountHealth, CommerceActionResponseDto,
  CommerceActivationLimitsInput, CommerceActivationReviewDto, CommerceCartDto, CommerceComparisonDto,
  CommerceOfferDto, CommerceOverviewDto, CommerceQuoteDto, CommerceTakeoverDto,
  CommerceTransactionDetailDto, CommerceTransactionDto, CommerceWorkflowDetailDto, CommerceWorkflowDto,
  CompareCommerceInput, ConfirmCommercePaymentInput, CreateCommerceCartInput, CreateCommerceQuoteInput,
  PlaceCommerceOrderInput, RequestCommerceRefundInput, SearchCommerceInput, TrackCommerceDeliveryInput,
} from '@/api/hermes/commerce'

type Resource = 'dashboard' | 'workflow' | 'transaction' | 'reviews'
type VisibleWorkflow = CommerceWorkflowDto | CommerceWorkflowDetailDto
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export const useCommerceStore = defineStore('commerce', () => {
  const overview = ref<CommerceOverviewDto | null>(null)
  const offers = ref<CommerceOfferDto[]>([])
  const comparisons = ref<CommerceComparisonDto[]>([])
  const carts = ref<CommerceCartDto[]>([])
  const quotes = ref<CommerceQuoteDto[]>([])
  const workflows = ref<VisibleWorkflow[]>([])
  const transactions = ref<CommerceTransactionDto[]>([])
  const takeovers = ref<CommerceTakeoverDto[]>([])
  const activationReviews = ref<CommerceActivationReviewDto[]>([])
  const selectedAccountId = ref<string | null>(null)
  const selectedWorkflowId = ref<string | null>(null)
  const selectedTransactionId = ref<string | null>(null)
  const transactionDetail = ref<CommerceTransactionDetailDto | null>(null)
  const selectedAccount = computed(() => overview.value?.accounts.find(item => item.id === selectedAccountId.value) ?? null)
  const selectedWorkflow = computed(() => workflows.value.find(item => item.id === selectedWorkflowId.value) ?? null)
  const selectedTransaction = computed(() => transactionDetail.value?.transaction
    ?? transactions.value.find(item => item.id === selectedTransactionId.value) ?? null)
  const latestComparison = computed(() => comparisons.value[0] ?? null)
  const latestCart = computed(() => carts.value[0] ?? null)
  const activeQuote = computed(() => quotes.value.find(item => item.status === 'active') ?? null)
  const activeLoads = ref(0)
  const activeSaves = ref(0)
  const resourceErrors = ref<Record<Resource, string | null>>({ dashboard: null, workflow: null,
    transaction: null, reviews: null })
  const mutationError = ref<string | null>(null)
  const loading = computed(() => activeLoads.value > 0)
  const saving = computed(() => activeSaves.value > 0)
  const error = computed(() => Object.values(resourceErrors.value).find(Boolean) ?? mutationError.value)

  let generation = 0
  let mutationSequence = 0
  const sequences: Record<Resource, number> = { dashboard: 0, workflow: 0, transaction: 0, reviews: 0 }
  const queues = new Map<string, Promise<unknown>>()

  function begin(resource: Resource) {
    activeLoads.value += 1; resourceErrors.value[resource] = null
    return { resource, generation, sequence: ++sequences[resource] }
  }
  function current(op: ReturnType<typeof begin>) { return op.generation === generation && op.sequence === sequences[op.resource] }
  function finish(op: ReturnType<typeof begin>) { if (op.generation === generation) activeLoads.value = Math.max(0, activeLoads.value - 1) }
  function fail(op: ReturnType<typeof begin>, cause: unknown) { if (current(op)) resourceErrors.value[op.resource] = errorText(cause) }

  async function loadDashboard(accountId = selectedAccountId.value) {
    const op = begin('dashboard')
    try {
      const summary = await api.fetchCommerceOverview()
      const nextAccountId = accountId && summary.accounts.some(item => item.id === accountId)
        ? accountId : summary.accounts[0]?.id ?? null
      const [nextOffers, nextComparisons, nextCarts, nextQuotes, nextWorkflows, nextTransactions, nextTakeovers]
        = await Promise.all([
          nextAccountId ? api.fetchCommerceOffers(nextAccountId) : Promise.resolve([]),
          api.fetchCommerceComparisons(nextAccountId ?? undefined), api.fetchCommerceCarts(nextAccountId ?? undefined),
          api.fetchCommerceQuotes(nextAccountId ?? undefined), api.fetchCommerceWorkflows(),
          api.fetchCommerceTransactions(nextAccountId ?? undefined), api.fetchCommerceTakeovers(),
        ])
      if (current(op)) {
        overview.value = summary; selectedAccountId.value = nextAccountId; offers.value = nextOffers
        comparisons.value = nextComparisons; carts.value = nextCarts; quotes.value = nextQuotes
        workflows.value = nextWorkflows; transactions.value = nextTransactions; takeovers.value = nextTakeovers
      }
      return summary
    } catch (cause) { fail(op, cause); throw cause } finally { finish(op) }
  }

  async function loadWorkflow(id: string) {
    const op = begin('workflow')
    try {
      const value = await api.fetchCommerceWorkflow(id)
      if (current(op)) { workflows.value = replace(workflows.value, value); selectedWorkflowId.value = id }
      return value
    } catch (cause) { fail(op, cause); throw cause } finally { finish(op) }
  }

  async function loadTransaction(id: string) {
    const op = begin('transaction')
    try {
      const value = await api.fetchCommerceTransaction(id)
      if (current(op)) { transactionDetail.value = value; selectedTransactionId.value = id
        transactions.value = replace(transactions.value, value.transaction) }
      return value
    } catch (cause) { fail(op, cause); throw cause } finally { finish(op) }
  }

  async function loadActivationReviews(accountId = selectedAccountId.value) {
    if (!accountId) return []
    const op = begin('reviews')
    try {
      const value = await api.fetchCommerceActivationReviews(accountId)
      if (current(op)) activationReviews.value = value
      return value
    } catch (cause) { fail(op, cause); throw cause } finally { finish(op) }
  }

  function mutate<T>(key: string, action: () => Promise<T>, accept?: (value: T) => void): Promise<T> {
    const callGeneration = generation; const sequence = ++mutationSequence
    activeSaves.value += 1; mutationError.value = null
    const run = async () => {
      try { const value = await action(); if (generation === callGeneration) accept?.(value); return value }
      catch (cause) { if (generation === callGeneration && sequence === mutationSequence) mutationError.value = errorText(cause); throw cause }
      finally { if (generation === callGeneration) activeSaves.value = Math.max(0, activeSaves.value - 1) }
    }
    const prior = queues.get(key)
    const task = prior ? prior.catch(() => undefined).then(run) : run()
    queues.set(key, task)
    void task.finally(() => { if (queues.get(key) === task) queues.delete(key) }).catch(() => undefined)
    return task
  }
  function remember(action: CommerceActionResponseDto) {
    workflows.value = replace(workflows.value, action.workflow); selectedWorkflowId.value = action.workflow.id
  }
  function governed(key: string, action: () => Promise<CommerceActionResponseDto>) { return mutate(key, action, remember) }

  function search(input: SearchCommerceInput) { return governed(`account:${input.accountId}`, () => api.searchCommerceOffers(input)) }
  function compare(input: CompareCommerceInput) { return governed(`account:${input.accountId}`, () => api.compareCommerceOffers(input)) }
  function createCart(input: CreateCommerceCartInput) { return governed(`comparison:${input.comparisonId}`, () => api.createCommerceCart(input)) }
  function createQuote(input: CreateCommerceQuoteInput) { return governed(`cart:${input.cartRevisionId}`, () => api.createCommerceQuote(input)) }
  function placeOrder(input: PlaceCommerceOrderInput) { return governed(`quote:${input.quoteId}`, () => api.placeCommerceOrder(input)) }
  function confirmPayment(input: ConfirmCommercePaymentInput) { return governed(`transaction:${input.transactionId}`, () => api.confirmCommercePayment(input)) }
  function trackDelivery(input: TrackCommerceDeliveryInput) { return governed(`transaction:${input.transactionId}`, () => api.trackCommerceDelivery(input)) }
  function cancelOrder(input: CancelCommerceOrderInput) { return governed(`transaction:${input.transactionId}`, () => api.cancelCommerceOrder(input)) }
  function requestRefund(input: RequestCommerceRefundInput) { return governed(`transaction:${input.transactionId}`, () => api.requestCommerceRefund(input)) }

  function reviewWorkflow(id: string, action: 'approve' | 'reject', reason = '') {
    return mutate(`workflow:${id}`, () => api.reviewCommerceWorkflow(id, action, reason), value => {
      workflows.value = replace(workflows.value, value); selectedWorkflowId.value = value.id
    })
  }
  function updateHealth(accountId: string, health: Exclude<CommerceAccountHealth, 'revoked'>, expectedVersion: number) {
    return mutate(`account:${accountId}`, () => api.updateCommerceAccountHealth(accountId, health, expectedVersion), updateAccount)
  }
  function activate(accountId: string, toMode: 'observe' | 'shadow' | 'live', limits: CommerceActivationLimitsInput) {
    return mutate(`account:${accountId}`, () => api.activateCommerceAccount(accountId, toMode, limits), value => {
      updateAccount(value.account); activationReviews.value = [value.review, ...activationReviews.value]
    })
  }
  function revoke(accountId: string, expectedVersion: number) {
    return mutate(`account:${accountId}`, () => api.revokeCommerceAccount(accountId, expectedVersion), updateAccount)
  }
  function updateAccount(value: CommerceOverviewDto['accounts'][number]) {
    if (overview.value) overview.value = { ...overview.value, accounts: replace(overview.value.accounts, value) }
  }
  function selectAccount(id: string) { selectedAccountId.value = id; return loadDashboard(id) }
  function selectWorkflow(id: string | null) { selectedWorkflowId.value = id }
  function selectTransaction(id: string | null) {
    selectedTransactionId.value = id; transactionDetail.value = null
    return id ? loadTransaction(id) : Promise.resolve(null)
  }
  function clearError(resource: Resource) { resourceErrors.value[resource] = null }
  function reset() {
    generation += 1; mutationSequence += 1
    for (const key of Object.keys(sequences) as Resource[]) sequences[key] += 1
    overview.value = null; offers.value = []; comparisons.value = []; carts.value = []; quotes.value = []
    workflows.value = []; transactions.value = []; takeovers.value = []; activationReviews.value = []
    selectedAccountId.value = null; selectedWorkflowId.value = null; selectedTransactionId.value = null
    transactionDetail.value = null; activeLoads.value = 0; activeSaves.value = 0
    resourceErrors.value = { dashboard: null, workflow: null, transaction: null, reviews: null }
    mutationError.value = null; queues.clear()
  }
  onScopeDispose(() => { generation += 1; queues.clear() })

  return { overview, offers, comparisons, carts, quotes, workflows, transactions, takeovers,
    activationReviews, selectedAccountId, selectedAccount, selectedWorkflowId, selectedWorkflow,
    selectedTransactionId, selectedTransaction, transactionDetail, latestComparison, latestCart, activeQuote,
    loading, saving, error, resourceErrors, loadDashboard, loadWorkflow, loadTransaction, loadActivationReviews,
    search, compare, createCart, createQuote, placeOrder, confirmPayment, trackDelivery, cancelOrder,
    requestRefund, reviewWorkflow, updateHealth, activate, revoke, selectAccount, selectWorkflow,
    selectTransaction, clearError, $reset: reset }
})

function replace<T extends { id: string }>(values: T[], value: T): T[] {
  return values.some(item => item.id === value.id)
    ? values.map(item => item.id === value.id ? value : item) : [value, ...values]
}

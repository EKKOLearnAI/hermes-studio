import { createHash } from 'crypto'
import type { Context } from 'koa'
import { createFabricIntent, getFabricWorkflow, listFabricWorkflows } from '../../services/hermes/action-fabric'
import type { FabricActionIntentInput, FabricIntentResult, FabricWorkflowDetail,
  FabricWorkflowSummary } from '../../services/hermes/action-fabric'
import {
  COMMERCE_ASSISTANT_ROLE_ID,
  COMMERCE_CANCEL_CAPABILITY,
  COMMERCE_CART_CAPABILITY,
  COMMERCE_COMPARE_CAPABILITY,
  COMMERCE_DELIVERY_CAPABILITY,
  COMMERCE_ORDER_CAPABILITY,
  COMMERCE_PAYMENT_CAPABILITY,
  COMMERCE_QUOTE_CAPABILITY,
  COMMERCE_REFUND_CAPABILITY,
  COMMERCE_SEARCH_CAPABILITY,
  COMMERCE_SHADOW_EXECUTOR_ID,
  CommerceContractError,
  compareObservedCommerceOffers,
  createCommerceAccount,
  getCommerceAccount,
  getCommerceCartRevision,
  getCommerceComparison,
  getCommerceQuote,
  getCommerceRuntimeStatus,
  getCommercePaymentAttemptByTransaction,
  getCommerceTransaction,
  getConfiguredCommerceProvider,
  listCommerceAccounts,
  listCommerceActivationReviews,
  listCommerceCancellationRequests,
  listCommerceCartRevisions,
  listCommerceCheckpoints,
  listCommerceComparisons,
  listCommerceDeliveryObservations,
  listCommerceOfferSnapshots,
  listCommerceQuotes,
  listCommerceRefundRequests,
  listCommerceTransactions,
  prepareCommerceCartFromComparison,
  reconcileCommerceRuntime,
  refreshCommerceQuote,
  revokeCommerceAccount,
  transitionCommerceAccountMode,
  updateCommerceAccountHealth,
} from '../../services/hermes/commerce-autonomy'
import type {
  CommerceActivationLimits,
  CommerceCartRevision,
  CommerceComparisonRequirement,
  CommerceProviderAccount,
  CommerceTransaction,
} from '../../services/hermes/commerce-autonomy'

class CommerceRequestError extends Error {}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
const DIGEST = /^[a-f0-9]{64}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,127}$/
const CURRENCY = /^[A-Z]{3}$/
const MAX_LIST = 200
const MAX_BODY_BYTES = 32_768
const COMMERCE_CAPABILITIES = new Set([
  COMMERCE_SEARCH_CAPABILITY, COMMERCE_COMPARE_CAPABILITY, COMMERCE_CART_CAPABILITY,
  COMMERCE_QUOTE_CAPABILITY, COMMERCE_ORDER_CAPABILITY, COMMERCE_PAYMENT_CAPABILITY,
  COMMERCE_DELIVERY_CAPABILITY, COMMERCE_CANCEL_CAPABILITY, COMMERCE_REFUND_CAPABILITY,
])

/** @openapi-default-errors 400:CommerceApiError,401:AuthError,403:AuthError,404:CommerceApiError,409:CommerceApiError,422:CommerceApiError,500:CommerceApiError,503:CommerceApiError */

/** @openapi-response CommerceOverviewResponse */
export async function overview(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const accounts = listCommerceAccounts(MAX_LIST)
    const workflows = commerceWorkflows(MAX_LIST)
    const transactions = listCommerceTransactions({ limit: MAX_LIST })
    const offers = accounts.flatMap(account => listCommerceOfferSnapshots({ accountId: account.id,
      activeAt: new Date().toISOString(), limit: 20 })).slice(0, MAX_LIST)
    return {
      runtime: getCommerceRuntimeStatus(),
      accounts: accounts.map(publicAccount),
      offers: offers.map(publicOffer),
      workflows: workflows.slice(0, 20).map(publicWorkflow),
      transactions: transactions.slice(0, 20).map(publicTransaction),
      takeovers: workflows.filter(item => item.state === 'waiting_user').map(publicTakeover),
      summary: {
        accountCount: accounts.length,
        liveAccountCount: accounts.filter(item => item.mode === 'live').length,
        activeOfferCount: offers.length,
        activeWorkflowCount: workflows.filter(item => !terminalWorkflow(item.state)).length,
        activeTransactionCount: transactions.filter(item => item.completedAt === null).length,
        pendingTakeoverCount: workflows.filter(item => item.state === 'waiting_user').length,
      },
    }
  })
}

/** @openapi-response CommerceAccountListResponse */
export async function accounts(ctx: Context): Promise<void> {
  respond(ctx, () => {
    queryKeys(ctx, new Set(['limit']))
    return { accounts: listCommerceAccounts(queryLimit(ctx)).map(publicAccount) }
  })
}

/** @openapi-response CommerceAccountResponse */
export async function createAccount(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = exactBody(ctx, new Set(['id', 'provider', 'mode', 'currency', 'displayName', 'enabled']))
    const mode = requiredEnum(body.mode, ['observe', 'shadow'] as const)
    const account = createCommerceAccount({
      id: requiredId(body.id),
      provider: requiredEnum(body.provider, ['food_delivery', 'taobao'] as const),
      mode,
      currency: requiredCurrency(body.currency),
      displayName: requiredText(body.displayName, 160),
      enabled: optionalBoolean(body.enabled) ?? true,
      executorId: mode === 'shadow' ? COMMERCE_SHADOW_EXECUTOR_ID : null,
    })
    ctx.status = 201
    return { account: publicAccount(account) }
  })
}

/** @openapi-response CommerceAccountResponse */
export async function updateAccountHealth(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = exactBody(ctx, new Set(['health', 'expectedVersion']))
    const account = updateCommerceAccountHealth({ accountId: pathId(ctx),
      health: requiredEnum(body.health, ['unknown', 'healthy', 'degraded', 'unhealthy'] as const),
      expectedVersion: requiredInteger(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER) })
    reconcileCommerceRuntime()
    return { account: publicAccount(account) }
  })
}

/** @openapi-response CommerceActivationReviewListResponse */
export async function activationReviews(ctx: Context): Promise<void> {
  respond(ctx, () => {
    queryKeys(ctx, new Set(['limit']))
    return { reviews: listCommerceActivationReviews(pathId(ctx), queryLimit(ctx)).map(publicActivationReview) }
  })
}

/** @openapi-response CommerceActivationResponse */
export async function activateAccount(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = exactBody(ctx, new Set(['toMode', 'limits']))
    const result = transitionCommerceAccountMode({ accountId: pathId(ctx),
      toMode: requiredEnum(body.toMode, ['observe', 'shadow', 'live'] as const),
      actorUserId: actorUserId(ctx), actorIsSuperAdmin: true, limits: activationLimits(body.limits) })
    reconcileCommerceRuntime()
    return { account: publicAccount(result.account), review: publicActivationReview(result.review) }
  })
}

/** @openapi-response CommerceAccountResponse */
export async function revokeAccount(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = exactBody(ctx, new Set(['expectedVersion']))
    const account = revokeCommerceAccount({ accountId: pathId(ctx), actorUserId: actorUserId(ctx),
      actorIsSuperAdmin: true, expectedVersion: requiredInteger(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER) })
    reconcileCommerceRuntime()
    return { account: publicAccount(account) }
  })
}

/** @openapi-response CommerceOfferListResponse */
export async function offers(ctx: Context): Promise<void> {
  respond(ctx, () => {
    queryKeys(ctx, new Set(['accountId', 'activeAt', 'limit']))
    const accountId = requiredQueryId(ctx, 'accountId')
    const activeAt = queryTimestamp(ctx, 'activeAt')
    return { offers: listCommerceOfferSnapshots({ accountId, ...(activeAt ? { activeAt } : {}),
      limit: queryLimit(ctx) }).map(publicOffer) }
  })
}

/** @openapi-response CommerceActionResponse */
export async function searchOffers(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = actionBody(ctx, new Set(['accountId', 'query', 'limit']))
    const account = requiredAccount(requiredId(body.accountId))
    return accepted(ctx, commerceIntent(ctx, account, COMMERCE_SEARCH_CAPABILITY, {
      schemaVersion: 1, accountId: account.id, provider: account.provider, currency: account.currency,
      query: requiredText(body.query, 200), limit: requiredInteger(body.limit, 1, 20),
    }, baseTarget(account), body, 'Search normalized offers for one commerce account'))
  })
}

/** @openapi-response CommerceComparisonListResponse */
export async function comparisons(ctx: Context): Promise<void> {
  respond(ctx, () => {
    queryKeys(ctx, new Set(['accountId', 'limit']))
    const accountId = queryId(ctx, 'accountId')
    return { comparisons: listCommerceComparisons({ ...(accountId ? { accountId } : {}),
      limit: queryLimit(ctx) }).map(publicComparison) }
  })
}

/** @openapi-response CommerceActionResponse */
export async function createComparison(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = actionBody(ctx, new Set(['accountId', 'requirement', 'activeAt']))
    const account = requiredAccount(requiredId(body.accountId))
    const projection = compareObservedCommerceOffers({ accountId: account.id,
      requirement: comparisonRequirement(body.requirement), activeAt: requiredTimestamp(body.activeAt) })
    return accepted(ctx, commerceIntent(ctx, account, COMMERCE_COMPARE_CAPABILITY, {
      schemaVersion: 1, accountId: account.id, provider: account.provider, currency: account.currency,
      comparisonId: projection.comparison.id, inputDigest: projection.comparison.inputDigest,
    }, baseTarget(account), body, 'Verify one deterministic commerce comparison'))
  })
}

/** @openapi-response CommerceCartListResponse */
export async function carts(ctx: Context): Promise<void> {
  respond(ctx, () => {
    queryKeys(ctx, new Set(['accountId', 'limit']))
    const accountId = queryId(ctx, 'accountId')
    return { carts: listCommerceCartRevisions({ ...(accountId ? { accountId } : {}),
      limit: queryLimit(ctx) }).map(publicCart) }
  })
}

/** @openapi-response CommerceActionResponse */
export async function createCart(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = actionBody(ctx, new Set(['comparisonId', 'destinationToken', 'recipientToken', 'substitution']))
    const comparison = requiredComparison(requiredId(body.comparisonId))
    const account = requiredAccount(comparison.accountId)
    const projection = prepareCommerceCartFromComparison({ comparisonId: comparison.id,
      destinationToken: requiredToken(body.destinationToken), recipientToken: requiredToken(body.recipientToken),
      substitution: requiredEnum(body.substitution, ['deny', 'same_sku_only'] as const) })
    const destinationDigest = digest(projection.cart.destinationToken)
    return accepted(ctx, commerceIntent(ctx, account, COMMERCE_CART_CAPABILITY, {
      schemaVersion: 1, accountId: account.id, provider: account.provider, currency: account.currency,
      comparisonId: comparison.id, cartRevisionId: projection.cart.id,
      cartDigest: projection.cart.contentDigest, destinationDigest,
    }, baseTarget(account), body, 'Verify one immutable proposed commerce cart'))
  })
}

/** @openapi-response CommerceQuoteListResponse */
export async function quotes(ctx: Context): Promise<void> {
  respond(ctx, () => {
    queryKeys(ctx, new Set(['accountId', 'status', 'limit']))
    const accountId = queryId(ctx, 'accountId')
    const status = queryEnum(ctx, 'status', ['active', 'expired', 'superseded', 'consumed'] as const)
    return { quotes: listCommerceQuotes({ ...(accountId ? { accountId } : {}), ...(status ? { status } : {}),
      limit: queryLimit(ctx) }).map(publicQuote) }
  })
}

/** @openapi-response CommerceActionResponse */
export async function createQuote(ctx: Context): Promise<void> {
  await respondAsync(ctx, async () => {
    noQuery(ctx)
    const body = actionBody(ctx, new Set(['cartRevisionId', 'providerRequestId']))
    const cart = requiredCart(requiredId(body.cartRevisionId))
    const account = requiredAccount(cart.accountId)
    const provider = getConfiguredCommerceProvider(account.id)
    if (!provider) throw coded('COMMERCE_PROVIDER_UNAVAILABLE')
    const projection = await refreshCommerceQuote({ cartRevisionId: cart.id,
      providerRequestId: requiredToken(body.providerRequestId), adapter: provider })
    return accepted(ctx, commerceIntent(ctx, account, COMMERCE_QUOTE_CAPABILITY, {
      schemaVersion: 1, accountId: account.id, provider: account.provider, currency: account.currency,
      cartRevisionId: cart.id, cartDigest: cart.contentDigest, quoteId: projection.quote.id,
      quoteDigest: projection.quote.quoteDigest, amountMinor: projection.quote.breakdown.totalMinor,
    }, baseTarget(account), body, 'Verify one fresh quote for an immutable commerce cart'))
  })
}

/** @openapi-response CommerceActionResponse */
export async function placeOrder(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = actionBody(ctx, new Set(['quoteId', 'providerRequestId']))
    const quote = requiredQuote(requiredId(body.quoteId))
    const material = materialFromQuote(quote)
    return accepted(ctx, commerceIntent(ctx, material.account, COMMERCE_ORDER_CAPABILITY, {
      ...transactionInput(material), quoteId: quote.id, quoteDigest: quote.quoteDigest,
      providerRequestId: requiredToken(body.providerRequestId), amountMinor: quote.breakdown.totalMinor,
    }, transactionTarget(material), body, 'Place one exact approved commerce order', quote.breakdown.totalMinor))
  })
}

/** @openapi-response CommerceActionResponse */
export async function confirmPayment(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = actionBody(ctx, new Set(['transactionId', 'approvalId']))
    const transaction = requiredTransaction(requiredId(body.transactionId))
    const material = materialFromTransaction(transaction)
    return accepted(ctx, commerceIntent(ctx, material.account, COMMERCE_PAYMENT_CAPABILITY, {
      ...transactionInput(material), transactionId: transaction.id, quoteDigest: transaction.quoteDigest,
      approvalId: requiredToken(body.approvalId), amountMinor: transaction.expectedAmountMinor,
    }, transactionTarget(material), body, 'Confirm one fresh exact commerce payment'))
  })
}

/** @openapi-response CommerceActionResponse */
export async function trackDelivery(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = actionBody(ctx, new Set(['transactionId']))
    const transaction = requiredTransaction(requiredId(body.transactionId))
    const account = requiredAccount(transaction.accountId)
    return accepted(ctx, commerceIntent(ctx, account, COMMERCE_DELIVERY_CAPABILITY, {
      schemaVersion: 1, accountId: account.id, provider: account.provider, currency: account.currency,
      transactionId: transaction.id,
    }, baseTarget(account), body, 'Track one exact commerce delivery'))
  })
}

/** @openapi-response CommerceActionResponse */
export async function cancelOrder(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = actionBody(ctx, new Set(['transactionId', 'providerRequestId', 'reasonCode']))
    const transaction = requiredTransaction(requiredId(body.transactionId))
    const material = materialFromTransaction(transaction)
    return accepted(ctx, commerceIntent(ctx, material.account, COMMERCE_CANCEL_CAPABILITY, {
      ...transactionInput(material), transactionId: transaction.id,
      providerRequestId: requiredToken(body.providerRequestId), reasonCode: requiredErrorCode(body.reasonCode),
    }, transactionTarget(material), body, 'Cancel one eligible exact commerce order'))
  })
}

/** @openapi-response CommerceActionResponse */
export async function requestRefund(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const body = actionBody(ctx, new Set(['transactionId', 'providerRequestId', 'reasonCode', 'amountMinor']))
    const transaction = requiredTransaction(requiredId(body.transactionId))
    const material = materialFromTransaction(transaction)
    const amountMinor = requiredInteger(body.amountMinor, 0,
      transaction.actualAmountMinor ?? transaction.expectedAmountMinor)
    return accepted(ctx, commerceIntent(ctx, material.account, COMMERCE_REFUND_CAPABILITY, {
      ...transactionInput(material), transactionId: transaction.id,
      providerRequestId: requiredToken(body.providerRequestId), reasonCode: requiredErrorCode(body.reasonCode),
      amountMinor,
    }, transactionTarget(material), body, 'Request one bounded commerce refund'))
  })
}

/** @openapi-response CommerceWorkflowListResponse */
export async function workflows(ctx: Context): Promise<void> {
  respond(ctx, () => {
    queryKeys(ctx, new Set(['state', 'limit']))
    const state = queryEnum(ctx, 'state', ['draft', 'policy_check', 'preparing', 'executing', 'verifying',
      'waiting_user', 'retrying', 'compensating', 'succeeded', 'denied', 'cancelled', 'failed',
      'dead_letter', 'compensated'] as const)
    return { workflows: commerceWorkflows(queryLimit(ctx), state).map(publicWorkflow) }
  })
}

/** @openapi-response CommerceWorkflowResponse */
export async function workflow(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const result = getFabricWorkflow(pathId(ctx))
    if (!result || !COMMERCE_CAPABILITIES.has(result.capabilityId)
      || result.requestedByRoleId !== COMMERCE_ASSISTANT_ROLE_ID) throw coded('COMMERCE_WORKFLOW_NOT_FOUND')
    return { workflow: publicWorkflowDetail(result) }
  })
}

/** @openapi-response CommerceTransactionListResponse */
export async function transactions(ctx: Context): Promise<void> {
  respond(ctx, () => {
    queryKeys(ctx, new Set(['accountId', 'state', 'limit']))
    const accountId = queryId(ctx, 'accountId')
    const state = queryEnum(ctx, 'state', ['proposed', 'quoted', 'waiting_approval', 'submitting_order',
      'lookup_required', 'order_pending', 'waiting_payment', 'submitting_payment', 'paid', 'fulfilling',
      'delivered', 'cancelling', 'cancelled', 'refunding', 'refunded', 'waiting_user', 'failed'] as const)
    return { transactions: listCommerceTransactions({ ...(accountId ? { accountId } : {}),
      ...(state ? { state } : {}), limit: queryLimit(ctx) }).map(publicTransaction) }
  })
}

/** @openapi-response CommerceTransactionResponse */
export async function transaction(ctx: Context): Promise<void> {
  respond(ctx, () => {
    noQuery(ctx)
    const item = requiredTransaction(pathId(ctx))
    return { transaction: publicTransaction(item), payment: publicPaymentOrNull(item.id),
      delivery: listCommerceDeliveryObservations(item.id, MAX_LIST).map(publicDelivery),
      cancellations: listCommerceCancellationRequests(item.id, MAX_LIST).map(publicCancellation),
      refunds: listCommerceRefundRequests(item.id, MAX_LIST).map(publicRefund),
      checkpoints: listCommerceCheckpoints(item.id, MAX_LIST).map(publicCheckpoint) }
  })
}

/** @openapi-response CommerceTakeoverListResponse */
export async function takeovers(ctx: Context): Promise<void> {
  respond(ctx, () => {
    queryKeys(ctx, new Set(['limit']))
    return { takeovers: commerceWorkflows(queryLimit(ctx), 'waiting_user').map(publicTakeover) }
  })
}

function commerceIntent(
  ctx: Context,
  account: CommerceProviderAccount,
  capabilityId: string,
  input: Record<string, unknown>,
  target: Record<string, unknown>,
  body: Record<string, unknown>,
  goal: string,
  expectedCostMinor?: number,
): FabricIntentResult {
  reconcileCommerceRuntime()
  const intent: FabricActionIntentInput = {
    capabilityId, requestedByRoleId: COMMERCE_ASSISTANT_ROLE_ID, requestedByUserId: actorUserId(ctx),
    idempotencyKey: requiredToken(body.idempotencyKey), goal, target, input, constraints: {},
    rationale: requiredText(body.rationale, 500),
    environments: account.mode === 'live' ? ['production'] : ['sandbox'],
    ...(expectedCostMinor === undefined ? {} : {
      expectedCost: { currency: account.currency, amountMinor: expectedCostMinor },
    }),
  }
  return createFabricIntent(intent)
}

function accepted(ctx: Context, result: FabricIntentResult): Record<string, unknown> {
  ctx.status = 202
  return publicAction(result)
}

function commerceWorkflows(limit: number, state?: FabricWorkflowSummary['state']): FabricWorkflowSummary[] {
  return listFabricWorkflows({ requestedByRoleId: COMMERCE_ASSISTANT_ROLE_ID,
    ...(state ? { state } : {}), limit: MAX_LIST }).filter(item => COMMERCE_CAPABILITIES.has(item.capabilityId)).slice(0, limit)
}

function materialFromTransaction(transaction: CommerceTransaction) {
  return materialFromQuote(requiredQuote(transaction.quoteId))
}

function materialFromQuote(quote: ReturnType<typeof requiredQuote>) {
  const account = requiredAccount(quote.accountId)
  const cart = requiredCart(quote.cartRevisionId)
  const offers = cart.items.map(item => {
    const offer = listCommerceOfferSnapshots({ accountId: account.id, limit: MAX_LIST })
      .find(candidate => candidate.id === item.offerSnapshotId)
    if (!offer) throw coded('COMMERCE_OFFER_NOT_FOUND')
    return offer
  })
  const merchantId = offers[0]?.merchantId
  if (!merchantId || offers.some(item => item.merchantId !== merchantId)) throw coded('COMMERCE_CART_MERCHANT_MISMATCH')
  return { account, cart, merchantId, destinationDigest: digest(cart.destinationToken) }
}

function transactionInput(material: ReturnType<typeof materialFromQuote>): Record<string, unknown> {
  return { schemaVersion: 1, accountId: material.account.id, provider: material.account.provider,
    currency: material.account.currency, merchantId: material.merchantId,
    destinationDigest: material.destinationDigest }
}

function transactionTarget(material: ReturnType<typeof materialFromQuote>): Record<string, unknown> {
  return { ...baseTarget(material.account), merchantId: material.merchantId,
    destinationDigest: material.destinationDigest }
}

function baseTarget(account: CommerceProviderAccount): Record<string, unknown> {
  return { kind: 'commerce_account', accountId: account.id, provider: account.provider, currency: account.currency }
}

function publicAction(result: FabricIntentResult): Record<string, unknown> {
  return { intent: { id: result.intent.id, capabilityId: result.intent.capabilityId },
    policyDecision: { id: result.policyDecision.id, outcome: result.policyDecision.outcome,
      reasonCodes: [...result.policyDecision.reasonCodes] }, workflow: publicWorkflow(result.workflow) }
}

function publicWorkflow(item: FabricWorkflowSummary): Record<string, unknown> {
  return { id: item.id, capabilityId: item.capabilityId, state: item.state, version: item.version,
    attempt: item.attempt, lastErrorCode: item.lastErrorCode, createdAt: item.createdAt,
    updatedAt: item.updatedAt, completedAt: item.completedAt, availableActions: { ...item.availableActions } }
}

function publicWorkflowDetail(item: FabricWorkflowDetail): Record<string, unknown> {
  return { ...publicWorkflow(item), policyDecision: item.policyDecision === null ? null : {
    id: item.policyDecision.id, outcome: item.policyDecision.outcome,
    reasonCodes: [...item.policyDecision.reasonCodes], budget: item.policyDecision.budget },
  steps: item.steps.slice(0, 32).map(step => ({ kind: step.kind, state: step.state, attempt: step.attempt,
    lastErrorCode: step.lastErrorCode, updatedAt: step.updatedAt })) }
}

function publicAccount(item: CommerceProviderAccount) { return { ...item } }
function publicOffer(item: ReturnType<typeof listCommerceOfferSnapshots>[number]) {
  return { id: item.id, accountId: item.accountId, provider: item.provider, productId: item.productId,
    skuId: item.skuId, merchantId: item.merchantId, merchantName: item.merchantName, title: item.title,
    unitLabel: item.unitLabel, money: { ...item.money }, available: item.available,
    maxQuantity: item.maxQuantity, fulfillment: item.fulfillment, fulfillmentMinutes: item.fulfillmentMinutes,
    observedAt: item.observedAt, expiresAt: item.expiresAt }
}
function publicComparison(item: ReturnType<typeof listCommerceComparisons>[number]) { return { ...item,
  requirement: { ...item.requirement, excludedMerchantIds: [...item.requirement.excludedMerchantIds],
    preferenceCodes: [...item.requirement.preferenceCodes] }, candidates: item.candidates.map(value => ({ ...value,
    exclusionCodes: [...value.exclusionCodes], rationaleCodes: [...value.rationaleCodes] })) } }
function publicCart(item: CommerceCartRevision) { return { id: item.id, accountId: item.accountId,
  revision: item.revision, items: item.items.map(value => ({ ...value })), destinationDigest: digest(item.destinationToken),
  recipientDigest: digest(item.recipientToken), substitution: item.substitution,
  contentDigest: item.contentDigest, createdAt: item.createdAt } }
function publicQuote(item: ReturnType<typeof listCommerceQuotes>[number]) { return { id: item.id,
  accountId: item.accountId, cartRevisionId: item.cartRevisionId, cartDigest: item.cartDigest,
  currency: item.currency, breakdown: { ...item.breakdown }, quoteDigest: item.quoteDigest,
  observedAt: item.observedAt, expiresAt: item.expiresAt, status: item.status } }
function publicTransaction(item: CommerceTransaction) { return { id: item.id, workflowId: item.workflowId,
  accountId: item.accountId, provider: item.provider, mode: item.mode, policyEpoch: item.policyEpoch,
  quoteId: item.quoteId, quoteDigest: item.quoteDigest, providerOrderId: item.providerOrderId,
  currency: item.currency, expectedAmountMinor: item.expectedAmountMinor, actualAmountMinor: item.actualAmountMinor,
  state: item.state, version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt,
  completedAt: item.completedAt } }
function publicPaymentOrNull(transactionId: string) {
  const item = getCommercePaymentAttemptByTransaction(transactionId)
  return item ? { id: item.id, transactionId: item.transactionId, currency: item.currency,
    amountMinor: item.amountMinor, state: item.state, providerReceiptId: item.providerReceiptId,
    evidenceDigest: item.evidenceDigest, version: item.version, createdAt: item.createdAt,
    updatedAt: item.updatedAt, completedAt: item.completedAt } : null
}
function publicDelivery(item: ReturnType<typeof listCommerceDeliveryObservations>[number]) { return { ...item } }
function publicCancellation(item: ReturnType<typeof listCommerceCancellationRequests>[number]) { return {
  id: item.id, transactionId: item.transactionId, reasonCode: item.reasonCode,
  eligibilityDigest: item.eligibilityDigest, state: item.state, providerReceiptId: item.providerReceiptId,
  version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt, completedAt: item.completedAt } }
function publicRefund(item: ReturnType<typeof listCommerceRefundRequests>[number]) { return {
  id: item.id, transactionId: item.transactionId, reasonCode: item.reasonCode, currency: item.currency,
  expectedAmountMinor: item.expectedAmountMinor, actualAmountMinor: item.actualAmountMinor,
  eligibilityDigest: item.eligibilityDigest, state: item.state, providerReceiptId: item.providerReceiptId,
  version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt, completedAt: item.completedAt } }
function publicCheckpoint(item: ReturnType<typeof listCommerceCheckpoints>[number]) { return {
  ordinal: item.ordinal, stage: item.stage, evidenceDigest: item.evidenceDigest, errorCode: item.errorCode,
  observedAt: item.observedAt, createdAt: item.createdAt } }
function publicActivationReview(item: ReturnType<typeof listCommerceActivationReviews>[number]) { return { ...item } }
function publicTakeover(item: FabricWorkflowSummary) { return { workflowId: item.id,
  capabilityId: item.capabilityId, reasonCode: item.lastErrorCode ?? 'USER_APPROVAL_REQUIRED',
  state: item.state, requestedAt: item.updatedAt } }

function actionBody(ctx: Context, fields: ReadonlySet<string>): Record<string, unknown> {
  return exactBody(ctx, new Set([...fields, 'idempotencyKey', 'rationale']))
}

function exactBody(ctx: Context, allowed: ReadonlySet<string>): Record<string, unknown> {
  const request = ctx.request as { body?: unknown; type?: string }
  if (request.type !== undefined && request.type !== 'application/json') throw new CommerceRequestError('JSON required')
  assertJson(request.body, 0, new WeakSet())
  if (!plainRecord(request.body)) throw new CommerceRequestError('Body must be an object')
  if (Buffer.byteLength(JSON.stringify(request.body), 'utf8') > MAX_BODY_BYTES) throw new CommerceRequestError('Body too large')
  for (const key of Object.keys(request.body)) if (!allowed.has(key)) throw new CommerceRequestError(`Unexpected field: ${key}`)
  return request.body
}

function assertJson(value: unknown, depth: number, ancestors: WeakSet<object>): void {
  if (depth > 8) throw new CommerceRequestError('JSON too deep')
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || ancestors.has(value)) throw new CommerceRequestError('Invalid JSON')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) throw new CommerceRequestError('Invalid array')
      value.forEach(item => assertJson(item, depth + 1, ancestors)); return
    }
    if (!plainRecord(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string')
      || Object.keys(value).length > 64) throw new CommerceRequestError('Invalid object')
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new CommerceRequestError('Unsafe key')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new CommerceRequestError('Accessors forbidden')
      assertJson(descriptor.value, depth + 1, ancestors)
    }
  } finally { ancestors.delete(value) }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function comparisonRequirement(value: unknown): CommerceComparisonRequirement {
  if (!plainRecord(value) || !exactKeys(value, ['query', 'quantity', 'maxTotalMinor', 'deliveryBefore',
    'excludedMerchantIds', 'preferenceCodes'])) throw new CommerceRequestError('Invalid requirement')
  return { query: requiredText(value.query, 200), quantity: requiredInteger(value.quantity, 1, 9_999),
    maxTotalMinor: nullableInteger(value.maxTotalMinor), deliveryBefore: nullableTimestamp(value.deliveryBefore),
    excludedMerchantIds: idArray(value.excludedMerchantIds, 30), preferenceCodes: idArray(value.preferenceCodes, 30) }
}

function activationLimits(value: unknown): CommerceActivationLimits {
  if (!plainRecord(value) || !exactKeys(value, ['currency', 'perActionMinor', 'dailyMinor', 'merchantIds',
    'destinationDigests'])) throw new CommerceRequestError('Invalid limits')
  return { currency: requiredCurrency(value.currency), perActionMinor: requiredInteger(value.perActionMinor, 0, Number.MAX_SAFE_INTEGER),
    dailyMinor: requiredInteger(value.dailyMinor, 0, Number.MAX_SAFE_INTEGER),
    merchantIds: idArray(value.merchantIds, 30), destinationDigests: digestArray(value.destinationDigests, 30) }
}

function requiredAccount(id: string) { const item = getCommerceAccount(id); if (!item) throw coded('COMMERCE_ACCOUNT_NOT_FOUND'); return item }
function requiredComparison(id: string) { const item = getCommerceComparison(id); if (!item) throw coded('COMMERCE_COMPARISON_NOT_FOUND'); return item }
function requiredCart(id: string) { const item = getCommerceCartRevision(id); if (!item) throw coded('COMMERCE_CART_NOT_FOUND'); return item }
function requiredQuote(id: string) { const item = getCommerceQuote(id); if (!item) throw coded('COMMERCE_QUOTE_NOT_FOUND'); return item }
function requiredTransaction(id: string) { const item = getCommerceTransaction(id); if (!item) throw coded('COMMERCE_TRANSACTION_NOT_FOUND'); return item }
function requiredId(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) throw new CommerceRequestError('Invalid identifier'); return value }
function requiredToken(value: unknown): string { if (typeof value !== 'string' || !TOKEN.test(value)) throw new CommerceRequestError('Invalid opaque token'); return value }
function requiredCurrency(value: unknown): string { if (typeof value !== 'string' || !CURRENCY.test(value)) throw new CommerceRequestError('Invalid currency'); return value }
function requiredErrorCode(value: unknown): string { if (typeof value !== 'string' || !ERROR_CODE.test(value)) throw new CommerceRequestError('Invalid reason code'); return value }
function requiredText(value: unknown, max: number): string { if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > max || /[\u0000-\u001f]/.test(value)) throw new CommerceRequestError('Invalid text'); return value }
function requiredInteger(value: unknown, min: number, max: number): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new CommerceRequestError('Invalid integer'); return Number(value) }
function optionalBoolean(value: unknown): boolean | undefined { if (value === undefined) return undefined; if (typeof value !== 'boolean') throw new CommerceRequestError('Invalid boolean'); return value }
function requiredEnum<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) throw new CommerceRequestError('Invalid enum'); return value as T }
function requiredTimestamp(value: unknown): string { if (typeof value !== 'string' || !validTimestamp(value)) throw new CommerceRequestError('Invalid timestamp'); return value }
function nullableTimestamp(value: unknown): string | null { return value === null ? null : requiredTimestamp(value) }
function nullableInteger(value: unknown): number | null { return value === null ? null : requiredInteger(value, 0, Number.MAX_SAFE_INTEGER) }
function idArray(value: unknown, max: number): string[] { return uniqueArray(value, max, requiredId) }
function digestArray(value: unknown, max: number): string[] { return uniqueArray(value, max, item => { if (typeof item !== 'string' || !DIGEST.test(item)) throw new CommerceRequestError('Invalid digest'); return item }) }
function uniqueArray(value: unknown, max: number, parse: (item: unknown) => string): string[] { if (!Array.isArray(value) || value.length > max) throw new CommerceRequestError('Invalid array'); const result = value.map(parse); if (new Set(result).size !== result.length) throw new CommerceRequestError('Duplicate array item'); return result }
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean { const keys = Object.keys(value).sort(); const wanted = [...expected].sort(); return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]) }
function validTimestamp(value: string): boolean { const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function noQuery(ctx: Context): void { queryKeys(ctx, new Set()) }
function queryKeys(ctx: Context, allowed: ReadonlySet<string>): void {
  if (!plainRecord(ctx.query)) throw new CommerceRequestError('Invalid query')
  for (const key of Reflect.ownKeys(ctx.query)) if (typeof key !== 'string' || !allowed.has(key)
    || typeof Object.getOwnPropertyDescriptor(ctx.query, key)?.value !== 'string') throw new CommerceRequestError('Invalid query')
}
function queryRaw(ctx: Context, key: string): string | undefined { const value = ctx.query[key]; if (value === undefined) return undefined; if (typeof value !== 'string' || value.length < 1) throw new CommerceRequestError('Invalid query'); return value }
function queryId(ctx: Context, key: string): string | undefined { const value = queryRaw(ctx, key); return value === undefined ? undefined : requiredId(value) }
function requiredQueryId(ctx: Context, key: string): string { const value = queryId(ctx, key); if (!value) throw new CommerceRequestError(`Missing ${key}`); return value }
function queryTimestamp(ctx: Context, key: string): string | undefined { const value = queryRaw(ctx, key); return value === undefined ? undefined : requiredTimestamp(value) }
function queryEnum<T extends string>(ctx: Context, key: string, allowed: readonly T[]): T | undefined { const value = queryRaw(ctx, key); return value === undefined ? undefined : requiredEnum(value, allowed) }
function queryLimit(ctx: Context): number { const value = queryRaw(ctx, 'limit'); if (value === undefined) return 100; if (!/^[1-9]\d*$/.test(value)) throw new CommerceRequestError('Invalid limit'); return requiredInteger(Number(value), 1, MAX_LIST) }
function pathId(ctx: Context): string { const raw = typeof ctx.params.id === 'string' ? ctx.params.id : ''; try { return requiredId(decodeURIComponent(raw)) } catch (error) { if (error instanceof CommerceRequestError) throw error; throw new CommerceRequestError('Invalid path') } }
function actorUserId(ctx: Context): string { const value = ctx.state.user?.id; const id = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value; if (typeof id !== 'string' || !ID.test(id)) throw coded('COMMERCE_ACTOR_UNAVAILABLE'); return id }
function terminalWorkflow(state: string): boolean { return ['succeeded', 'denied', 'cancelled', 'failed', 'dead_letter', 'compensated'].includes(state) }
function coded(code: string): Error { return new Error(code) }

function respond(ctx: Context, operation: () => unknown): void { try { ctx.body = operation() } catch (error) { mapError(ctx, error) } }
async function respondAsync(ctx: Context, operation: () => Promise<unknown>): Promise<void> { try { ctx.body = await operation() } catch (error) { mapError(ctx, error) } }
function mapError(ctx: Context, error: unknown): void {
  const code = error instanceof CommerceContractError || error instanceof Error && /^COMMERCE_[A-Z0-9_]+$/.test(error.message)
    ? error.message : error instanceof CommerceRequestError ? 'COMMERCE_REQUEST_INVALID' : 'COMMERCE_INTERNAL_ERROR'
  const status = code === 'COMMERCE_ACTOR_UNAVAILABLE' ? 403
    : code.endsWith('_NOT_FOUND') ? 404
      : code.includes('VERSION_CONFLICT') || code.includes('REPLAY_MISMATCH') || code.includes('SUBSTITUTION') ? 409
        : code.includes('UNAVAILABLE') || code === 'COMMERCE_INTERNAL_ERROR' ? 503
          : code.includes('REQUIRED') || code.includes('FORBIDDEN') || code.includes('GATE_FAILED') ? 422 : 400
  ctx.status = status
  ctx.body = { error: status === 404 ? 'Commerce resource not found'
    : status === 409 ? 'Commerce state changed'
      : status === 503 ? 'Commerce service unavailable'
        : status === 403 ? 'Authenticated actor is unavailable' : 'Invalid commerce request', code }
}

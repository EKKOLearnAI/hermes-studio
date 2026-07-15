import { request } from '@/api/client'

export type CommerceProvider = 'food_delivery' | 'taobao'
export type CommerceMode = 'observe' | 'shadow' | 'live'
export type CommerceAccountHealth = 'unknown' | 'healthy' | 'degraded' | 'unhealthy' | 'revoked'
export type CommerceWorkflowState = 'draft' | 'policy_check' | 'preparing' | 'executing' | 'verifying'
  | 'waiting_user' | 'retrying' | 'compensating' | 'succeeded' | 'denied' | 'cancelled'
  | 'failed' | 'dead_letter' | 'compensated'
export type CommerceTransactionState = 'proposed' | 'quoted' | 'waiting_approval' | 'submitting_order'
  | 'lookup_required' | 'order_pending' | 'waiting_payment' | 'submitting_payment' | 'paid'
  | 'fulfilling' | 'delivered' | 'cancelling' | 'cancelled' | 'refunding' | 'refunded'
  | 'waiting_user' | 'failed'

export interface CommerceAccountDto {
  id: string; provider: CommerceProvider; mode: CommerceMode; currency: string; executorId: string | null
  displayName: string; health: CommerceAccountHealth; enabled: boolean; policyEpoch: number; version: number
  createdAt: string; updatedAt: string; revokedAt: string | null
}
export interface CommerceOfferDto {
  id: string; accountId: string; provider: CommerceProvider; productId: string; skuId: string
  merchantId: string; merchantName: string; title: string; unitLabel: string
  money: { currency: string; amountMinor: number }; available: boolean; maxQuantity: number
  fulfillment: 'delivery' | 'shipping' | 'pickup'; fulfillmentMinutes: number | null
  observedAt: string; expiresAt: string
}
export interface CommerceComparisonRequirementDto {
  query: string; quantity: number; maxTotalMinor: number | null; deliveryBefore: string | null
  excludedMerchantIds: string[]; preferenceCodes: string[]
}
export interface CommerceComparisonCandidateDto {
  offerSnapshotId: string; eligible: boolean; score: number | null; priceMinor: number
  fulfillmentMinutes: number | null; exclusionCodes: string[]; rationaleCodes: string[]
}
export interface CommerceComparisonDto {
  id: string; accountId: string; requirement: CommerceComparisonRequirementDto
  candidates: CommerceComparisonCandidateDto[]; selectedOfferSnapshotId: string | null
  inputDigest: string; createdAt: string
}
export interface CommerceCartDto {
  id: string; accountId: string; revision: number; items: Array<{ offerSnapshotId: string; quantity: number }>
  destinationDigest: string; recipientDigest: string; substitution: 'deny' | 'same_sku_only'
  contentDigest: string; createdAt: string
}
export interface CommerceQuoteDto {
  id: string; accountId: string; cartRevisionId: string; cartDigest: string; currency: string
  breakdown: { itemsMinor: number; deliveryMinor: number; serviceMinor: number; taxMinor: number
    discountMinor: number; totalMinor: number }
  quoteDigest: string; observedAt: string; expiresAt: string
  status: 'active' | 'expired' | 'superseded' | 'consumed'
}
export interface CommerceAvailableActionsDto {
  approve: boolean; reject: boolean; cancel: boolean; retry: boolean; compensate: boolean
}
export interface CommerceWorkflowDto {
  id: string; capabilityId: string; state: CommerceWorkflowState; version: number; attempt: number
  lastErrorCode: string | null; createdAt: string; updatedAt: string; completedAt: string | null
  availableActions: CommerceAvailableActionsDto
}
export interface CommerceWorkflowDetailDto extends CommerceWorkflowDto {
  policyDecision: { id: string; outcome: 'allow' | 'deny' | 'waiting_user'; reasonCodes: string[]
    budget: { currency: string; amountMinor: number } | null } | null
  steps: Array<{ kind: string; state: string; attempt: number; lastErrorCode: string | null; updatedAt: string }>
}
export interface CommerceTransactionDto {
  id: string; workflowId: string; accountId: string; provider: CommerceProvider; mode: CommerceMode
  policyEpoch: number; quoteId: string; quoteDigest: string; providerOrderId: string | null
  currency: string; expectedAmountMinor: number; actualAmountMinor: number | null
  state: CommerceTransactionState; version: number; createdAt: string; updatedAt: string; completedAt: string | null
}
export interface CommercePaymentDto {
  id: string; transactionId: string; currency: string; amountMinor: number; state: string
  providerReceiptId: string | null; evidenceDigest: string | null; version: number
  createdAt: string; updatedAt: string; completedAt: string | null
}
export interface CommerceDeliveryDto {
  id: string; transactionId: string; providerEventId: string; state: string; etaAt: string | null
  evidenceDigest: string; observedAt: string; createdAt: string
}
export interface CommerceAdjustmentDto {
  id: string; transactionId: string; reasonCode: string; state: string; providerReceiptId: string | null
  version: number; createdAt: string; updatedAt: string; completedAt: string | null
  currency?: string; expectedAmountMinor?: number; actualAmountMinor?: number | null; eligibilityDigest: string
}
export interface CommerceCheckpointDto {
  ordinal: number; stage: string; evidenceDigest: string | null; errorCode: string | null
  observedAt: string; createdAt: string
}
export interface CommerceTransactionDetailDto {
  transaction: CommerceTransactionDto; payment: CommercePaymentDto | null; delivery: CommerceDeliveryDto[]
  cancellations: CommerceAdjustmentDto[]; refunds: CommerceAdjustmentDto[]; checkpoints: CommerceCheckpointDto[]
}
export interface CommerceTakeoverDto {
  workflowId: string; capabilityId: string; reasonCode: string; state: 'waiting_user'; requestedAt: string
}
export interface CommerceActivationReviewDto {
  id: string; accountId: string; fromMode: CommerceMode; toMode: CommerceMode; actorUserId: string
  shadowEvidenceDigest: string | null; limitsDigest: string; approved: boolean; createdAt: string
}
export interface CommerceRuntimeDto {
  configuredAccountCount: number; shadowExecutorEnabled: boolean; liveExecutorEnabled: boolean
  authorizedTargetCount: number; emergencyStopped: boolean
}
export interface CommerceOverviewDto {
  runtime: CommerceRuntimeDto; accounts: CommerceAccountDto[]; offers: CommerceOfferDto[]
  workflows: CommerceWorkflowDto[]; transactions: CommerceTransactionDto[]; takeovers: CommerceTakeoverDto[]
  summary: { accountCount: number; liveAccountCount: number; activeOfferCount: number
    activeWorkflowCount: number; activeTransactionCount: number; pendingTakeoverCount: number }
}
export interface CommerceActionResponseDto {
  intent: { id: string; capabilityId: string }
  policyDecision: { id: string; outcome: 'allow' | 'deny' | 'waiting_user'; reasonCodes: string[] }
  workflow: CommerceWorkflowDto
}

export interface CommerceActionInput { idempotencyKey: string; rationale: string }
export interface SearchCommerceInput extends CommerceActionInput { accountId: string; query: string; limit: number }
export interface CompareCommerceInput extends CommerceActionInput {
  accountId: string; requirement: CommerceComparisonRequirementDto; activeAt: string
}
export interface CreateCommerceCartInput extends CommerceActionInput {
  comparisonId: string; destinationToken: string; recipientToken: string; substitution: 'deny' | 'same_sku_only'
}
export interface CreateCommerceQuoteInput extends CommerceActionInput { cartRevisionId: string; providerRequestId: string }
export interface PlaceCommerceOrderInput extends CommerceActionInput { quoteId: string; providerRequestId: string }
export interface ConfirmCommercePaymentInput extends CommerceActionInput { transactionId: string; approvalId: string }
export interface TrackCommerceDeliveryInput extends CommerceActionInput { transactionId: string }
export interface CancelCommerceOrderInput extends CommerceActionInput {
  transactionId: string; providerRequestId: string; reasonCode: string
}
export interface RequestCommerceRefundInput extends CancelCommerceOrderInput { amountMinor: number }
export interface CommerceActivationLimitsInput {
  currency: string; perActionMinor: number; dailyMinor: number; merchantIds: string[]; destinationDigests: string[]
}

const BASE = '/api/hermes/commerce'
const id = (value: string) => encodeURIComponent(value)
const write = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body) })
function withQuery(path: string, entries: Array<[string, unknown]>): string {
  const query = new URLSearchParams()
  for (const [key, value] of entries) if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  return query.size ? `${path}?${query}` : path
}
async function list<T>(path: string, field: string): Promise<T[]> {
  return (await request<Record<string, T[]>>(path))[field] ?? []
}

export function fetchCommerceOverview(): Promise<CommerceOverviewDto> { return request(`${BASE}/overview`) }
export function fetchCommerceOffers(accountId: string, limit = 100): Promise<CommerceOfferDto[]> {
  return list(withQuery(`${BASE}/offers`, [['accountId', accountId], ['limit', limit]]), 'offers')
}
export function fetchCommerceComparisons(accountId?: string): Promise<CommerceComparisonDto[]> {
  return list(withQuery(`${BASE}/comparisons`, [['accountId', accountId], ['limit', 100]]), 'comparisons')
}
export function fetchCommerceCarts(accountId?: string): Promise<CommerceCartDto[]> {
  return list(withQuery(`${BASE}/carts`, [['accountId', accountId], ['limit', 100]]), 'carts')
}
export function fetchCommerceQuotes(accountId?: string): Promise<CommerceQuoteDto[]> {
  return list(withQuery(`${BASE}/quotes`, [['accountId', accountId], ['limit', 100]]), 'quotes')
}
export function fetchCommerceWorkflows(): Promise<CommerceWorkflowDto[]> {
  return list(withQuery(`${BASE}/workflows`, [['limit', 100]]), 'workflows')
}
export async function fetchCommerceWorkflow(workflowId: string): Promise<CommerceWorkflowDetailDto> {
  return (await request<{ workflow: CommerceWorkflowDetailDto }>(`${BASE}/workflows/${id(workflowId)}`)).workflow
}
export function fetchCommerceTransactions(accountId?: string): Promise<CommerceTransactionDto[]> {
  return list(withQuery(`${BASE}/transactions`, [['accountId', accountId], ['limit', 100]]), 'transactions')
}
export function fetchCommerceTransaction(transactionId: string): Promise<CommerceTransactionDetailDto> {
  return request(`${BASE}/transactions/${id(transactionId)}`)
}
export function fetchCommerceTakeovers(): Promise<CommerceTakeoverDto[]> {
  return list(withQuery(`${BASE}/takeovers`, [['limit', 100]]), 'takeovers')
}
export function fetchCommerceActivationReviews(accountId: string): Promise<CommerceActivationReviewDto[]> {
  return list(withQuery(`${BASE}/accounts/${id(accountId)}/activation-reviews`, [['limit', 100]]), 'reviews')
}

export function searchCommerceOffers(input: SearchCommerceInput): Promise<CommerceActionResponseDto> {
  return request(`${BASE}/offers/search`, write(input))
}
export function compareCommerceOffers(input: CompareCommerceInput): Promise<CommerceActionResponseDto> {
  return request(`${BASE}/comparisons`, write(input))
}
export function createCommerceCart(input: CreateCommerceCartInput): Promise<CommerceActionResponseDto> {
  return request(`${BASE}/carts`, write(input))
}
export function createCommerceQuote(input: CreateCommerceQuoteInput): Promise<CommerceActionResponseDto> {
  return request(`${BASE}/quotes`, write(input))
}
export function placeCommerceOrder(input: PlaceCommerceOrderInput): Promise<CommerceActionResponseDto> {
  return request(`${BASE}/orders`, write(input))
}
export function confirmCommercePayment(input: ConfirmCommercePaymentInput): Promise<CommerceActionResponseDto> {
  return request(`${BASE}/payments`, write(input))
}
export function trackCommerceDelivery(input: TrackCommerceDeliveryInput): Promise<CommerceActionResponseDto> {
  return request(`${BASE}/delivery`, write(input))
}
export function cancelCommerceOrder(input: CancelCommerceOrderInput): Promise<CommerceActionResponseDto> {
  return request(`${BASE}/cancellations`, write(input))
}
export function requestCommerceRefund(input: RequestCommerceRefundInput): Promise<CommerceActionResponseDto> {
  return request(`${BASE}/refunds`, write(input))
}
export async function updateCommerceAccountHealth(accountId: string, health: Exclude<CommerceAccountHealth, 'revoked'>,
  expectedVersion: number): Promise<CommerceAccountDto> {
  return (await request<{ account: CommerceAccountDto }>(`${BASE}/accounts/${id(accountId)}/health`,
    write({ health, expectedVersion }, 'PUT'))).account
}
export function activateCommerceAccount(accountId: string, toMode: CommerceMode, limits: CommerceActivationLimitsInput):
Promise<{ account: CommerceAccountDto; review: CommerceActivationReviewDto }> {
  return request(`${BASE}/accounts/${id(accountId)}/activate`, write({ toMode, limits }))
}
export async function revokeCommerceAccount(accountId: string, expectedVersion: number): Promise<CommerceAccountDto> {
  return (await request<{ account: CommerceAccountDto }>(`${BASE}/accounts/${id(accountId)}/revoke`,
    write({ expectedVersion }))).account
}
export async function reviewCommerceWorkflow(workflowId: string, action: 'approve' | 'reject', reason = ''):
Promise<CommerceWorkflowDetailDto> {
  const body = action === 'approve' ? {} : { reason }
  return (await request<{ workflow: CommerceWorkflowDetailDto }>(
    `/api/hermes/action-fabric/workflows/${id(workflowId)}/${action}`, write(body),
  )).workflow
}

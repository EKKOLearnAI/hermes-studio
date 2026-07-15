import type { FabricJsonObject } from '../action-fabric/types'

export const COMMERCE_PROVIDER_KINDS = ['virtual', 'food_delivery', 'taobao'] as const
export type CommerceProviderKind = typeof COMMERCE_PROVIDER_KINDS[number]

export const COMMERCE_EXECUTION_MODES = ['observe', 'shadow', 'live'] as const
export type CommerceExecutionMode = typeof COMMERCE_EXECUTION_MODES[number]

export const COMMERCE_ACCOUNT_HEALTH = ['unknown', 'healthy', 'degraded', 'unhealthy', 'revoked'] as const
export type CommerceAccountHealth = typeof COMMERCE_ACCOUNT_HEALTH[number]

export const COMMERCE_FULFILLMENT_KINDS = ['delivery', 'shipping', 'pickup'] as const
export type CommerceFulfillmentKind = typeof COMMERCE_FULFILLMENT_KINDS[number]

export const COMMERCE_TRANSACTION_STATES = [
  'proposed',
  'quoted',
  'waiting_approval',
  'submitting_order',
  'lookup_required',
  'order_pending',
  'waiting_payment',
  'submitting_payment',
  'paid',
  'fulfilling',
  'delivered',
  'cancelling',
  'cancelled',
  'refunding',
  'refunded',
  'waiting_user',
  'failed',
] as const
export type CommerceTransactionState = typeof COMMERCE_TRANSACTION_STATES[number]

export const COMMERCE_PAYMENT_STATES = [
  'not_started', 'approval_required', 'submitting', 'lookup_required', 'paid', 'declined', 'unknown', 'cancelled',
] as const
export type CommercePaymentState = typeof COMMERCE_PAYMENT_STATES[number]

export const COMMERCE_DELIVERY_STATES = [
  'not_started', 'preparing', 'ready', 'in_transit', 'delivered', 'failed', 'cancelled', 'unknown',
] as const
export type CommerceDeliveryState = typeof COMMERCE_DELIVERY_STATES[number]

export const COMMERCE_CANCELLATION_STATES = [
  'not_requested', 'requested', 'lookup_required', 'cancelled', 'rejected', 'unknown',
] as const
export type CommerceCancellationState = typeof COMMERCE_CANCELLATION_STATES[number]

export const COMMERCE_REFUND_STATES = [
  'not_requested', 'requested', 'lookup_required', 'processing', 'refunded', 'rejected', 'unknown',
] as const
export type CommerceRefundState = typeof COMMERCE_REFUND_STATES[number]

export interface CommerceMoney {
  currency: string
  amountMinor: number
}

export interface CommerceProviderAccount {
  id: string
  provider: CommerceProviderKind
  mode: CommerceExecutionMode
  currency: string
  executorId: string | null
  displayName: string
  health: CommerceAccountHealth
  enabled: boolean
  policyEpoch: number
  createdAt: string
  updatedAt: string
  revokedAt: string | null
}

export interface CommerceOfferSnapshot {
  id: string
  accountId: string
  provider: CommerceProviderKind
  providerOfferId: string
  productId: string
  skuId: string
  merchantId: string
  merchantName: string
  title: string
  unitLabel: string
  money: CommerceMoney
  available: boolean
  maxQuantity: number
  fulfillment: CommerceFulfillmentKind
  fulfillmentMinutes: number | null
  observedAt: string
  expiresAt: string
  sourceDigest: string
}

export interface CommerceComparisonRequirement {
  query: string
  quantity: number
  maxTotalMinor: number | null
  deliveryBefore: string | null
  excludedMerchantIds: string[]
  preferenceCodes: string[]
}

export interface CommerceComparisonCandidate {
  offerSnapshotId: string
  eligible: boolean
  score: number | null
  priceMinor: number
  fulfillmentMinutes: number | null
  exclusionCodes: string[]
  rationaleCodes: string[]
}

export interface CommerceComparison {
  id: string
  accountId: string
  requirement: CommerceComparisonRequirement
  candidates: CommerceComparisonCandidate[]
  selectedOfferSnapshotId: string | null
  inputDigest: string
  createdAt: string
}

export interface CommerceCartItem {
  offerSnapshotId: string
  quantity: number
}

export interface CommerceCartRevision {
  id: string
  accountId: string
  revision: number
  items: CommerceCartItem[]
  destinationToken: string
  recipientToken: string
  substitution: 'deny' | 'same_sku_only'
  contentDigest: string
  createdAt: string
}

export interface CommerceQuoteBreakdown {
  itemsMinor: number
  deliveryMinor: number
  serviceMinor: number
  taxMinor: number
  discountMinor: number
  totalMinor: number
}

export interface CommerceQuote {
  id: string
  accountId: string
  cartRevisionId: string
  cartDigest: string
  providerQuoteId: string
  currency: string
  breakdown: CommerceQuoteBreakdown
  quoteDigest: string
  observedAt: string
  expiresAt: string
  status: 'active' | 'expired' | 'superseded' | 'consumed'
}

export interface CommerceTransaction {
  id: string
  workflowId: string
  intentId: string
  accountId: string
  provider: CommerceProviderKind
  mode: CommerceExecutionMode
  policyEpoch: number
  quoteId: string
  quoteDigest: string
  providerRequestId: string
  providerOrderId: string | null
  currency: string
  expectedAmountMinor: number
  actualAmountMinor: number | null
  state: CommerceTransactionState
  version: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface CommerceCheckpoint {
  transactionId: string
  ordinal: number
  stage: string
  evidenceDigest: string | null
  errorCode: string | null
  details: FabricJsonObject
  observedAt: string
  createdAt: string
}


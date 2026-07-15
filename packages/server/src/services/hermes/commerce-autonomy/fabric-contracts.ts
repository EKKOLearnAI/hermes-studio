import { isProxy } from 'node:util/types'
import type { FabricCapabilityInput } from '../action-fabric/registry'
import type { FabricJsonObject } from '../action-fabric/types'
import { CommerceContractError, isCommerceCurrency, isCommerceDigest, isCommerceProviderKind, isCommerceSemanticId } from './contracts'

export const COMMERCE_SEARCH_CAPABILITY = 'commerce.product.search'
export const COMMERCE_COMPARE_CAPABILITY = 'commerce.offer.compare'
export const COMMERCE_CART_CAPABILITY = 'commerce.cart.prepare'
export const COMMERCE_QUOTE_CAPABILITY = 'commerce.quote.refresh'
export const COMMERCE_ORDER_CAPABILITY = 'commerce.order.place'
export const COMMERCE_PAYMENT_CAPABILITY = 'commerce.payment.confirm'
export const COMMERCE_DELIVERY_CAPABILITY = 'commerce.delivery.track'
export const COMMERCE_CANCEL_CAPABILITY = 'commerce.order.cancel'
export const COMMERCE_REFUND_CAPABILITY = 'commerce.refund.request'

export const COMMERCE_CAPABILITY_IDS = [
  COMMERCE_SEARCH_CAPABILITY,
  COMMERCE_COMPARE_CAPABILITY,
  COMMERCE_CART_CAPABILITY,
  COMMERCE_QUOTE_CAPABILITY,
  COMMERCE_ORDER_CAPABILITY,
  COMMERCE_PAYMENT_CAPABILITY,
  COMMERCE_DELIVERY_CAPABILITY,
  COMMERCE_CANCEL_CAPABILITY,
  COMMERCE_REFUND_CAPABILITY,
] as const

const CAPABILITIES = new Set<string>(COMMERCE_CAPABILITY_IDS)
const TRANSACTION_TARGET_CAPABILITIES = new Set<string>([
  COMMERCE_ORDER_CAPABILITY, COMMERCE_PAYMENT_CAPABILITY, COMMERCE_CANCEL_CAPABILITY, COMMERCE_REFUND_CAPABILITY,
])
const PROVIDERS = ['food_delivery', 'taobao'] as const
const idSchema = { type: 'string', minLength: 1, maxLength: 160, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' }
const digestSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const currencySchema = { type: 'string', pattern: '^[A-Z]{3}$' }
const moneySchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const timestampSchema = { type: 'string', format: 'date-time', maxLength: 64 }

function objectSchema(properties: Record<string, unknown>, required: string[]): FabricJsonObject {
  return { type: 'object', additionalProperties: false, properties, required }
}

function inputSchema(extra: Record<string, unknown>, required: string[]): FabricJsonObject {
  return objectSchema({ schemaVersion: { const: 1 }, accountId: idSchema,
    provider: { enum: PROVIDERS }, currency: currencySchema, ...extra },
  ['schemaVersion', 'accountId', 'provider', 'currency', ...required])
}

function outputSchema(operation: string, extra: Record<string, unknown>, required: string[]): FabricJsonObject {
  return objectSchema({ schemaVersion: { const: 1 }, operation: { const: operation }, accountId: idSchema,
    provider: { enum: PROVIDERS }, currency: currencySchema, ...extra },
  ['schemaVersion', 'operation', 'accountId', 'provider', 'currency', ...required])
}

const base = {
  version: 1,
  idempotency: 'required' as const,
  authentication: ['commerce_account:configured'],
  targetRestrictions: ['commerce:account', 'commerce:provider', 'commerce:currency'],
  cost: { currency: null, estimatedMinor: 0 },
  enabled: true,
}

export const COMMERCE_FABRIC_CAPABILITIES: FabricCapabilityInput[] = [
  {
    ...base, id: COMMERCE_SEARCH_CAPABILITY,
    description: 'Search bounded normalized offers for one exact commerce account',
    inputSchema: inputSchema({ query: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query', 'limit']),
    outputSchema: outputSchema('search', { offerSnapshotIds: { type: 'array', maxItems: 20, items: idSchema },
      totalCount: { type: 'integer', minimum: 0, maximum: 20 } }, ['offerSnapshotIds', 'totalCount']),
    risk: 'low', sideEffect: false, reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'normalized_offer_snapshot_read',
  },
  {
    ...base, id: COMMERCE_COMPARE_CAPABILITY,
    description: 'Compare one exact immutable set of commerce offer snapshots',
    inputSchema: inputSchema({ comparisonId: idSchema, inputDigest: digestSchema }, ['comparisonId', 'inputDigest']),
    outputSchema: outputSchema('compare', { comparisonId: idSchema, inputDigest: digestSchema,
      selectedOfferSnapshotId: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
      candidateCount: { type: 'integer', minimum: 1, maximum: 64 } },
    ['comparisonId', 'inputDigest', 'selectedOfferSnapshotId', 'candidateCount']),
    risk: 'none', sideEffect: false, reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'deterministic_comparison_digest',
  },
  {
    ...base, id: COMMERCE_CART_CAPABILITY,
    description: 'Bind one immutable proposed cart to a verified comparison and destination digest',
    inputSchema: inputSchema({ comparisonId: idSchema, cartRevisionId: idSchema, cartDigest: digestSchema,
      destinationDigest: digestSchema }, ['comparisonId', 'cartRevisionId', 'cartDigest', 'destinationDigest']),
    outputSchema: outputSchema('cart_prepare', { cartRevisionId: idSchema, cartDigest: digestSchema,
      itemCount: { type: 'integer', minimum: 1, maximum: 64 } }, ['cartRevisionId', 'cartDigest', 'itemCount']),
    risk: 'low', sideEffect: false, reversible: true, compensationCapabilityId: COMMERCE_CART_CAPABILITY,
    verificationStrategy: 'immutable_cart_digest_lookup',
  },
  {
    ...base, id: COMMERCE_QUOTE_CAPABILITY,
    description: 'Verify one fresh quote bound to an immutable commerce cart',
    inputSchema: inputSchema({ cartRevisionId: idSchema, cartDigest: digestSchema, quoteId: idSchema,
      quoteDigest: digestSchema, amountMinor: moneySchema },
    ['cartRevisionId', 'cartDigest', 'quoteId', 'quoteDigest', 'amountMinor']),
    outputSchema: outputSchema('quote_refresh', { quoteId: idSchema, quoteDigest: digestSchema,
      amountMinor: moneySchema, expiresAt: timestampSchema }, ['quoteId', 'quoteDigest', 'amountMinor', 'expiresAt']),
    risk: 'low', sideEffect: false, reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'fresh_quote_digest_lookup',
  },
  {
    ...base, id: COMMERCE_ORDER_CAPABILITY,
    description: 'Place one exact order against an unexpired quote and durable provider request identity',
    inputSchema: transactionInput({ quoteId: idSchema, quoteDigest: digestSchema, providerRequestId: idSchema,
      amountMinor: moneySchema }, ['quoteId', 'quoteDigest', 'providerRequestId', 'amountMinor']),
    outputSchema: transactionOutput('order_place', { transactionId: idSchema,
      providerOrderId: { type: ['string', 'null'], minLength: 1, maxLength: 200 }, amountMinor: moneySchema,
      status: { enum: ['shadowed', 'pending_payment', 'paid', 'unknown'] } },
    ['transactionId', 'providerOrderId', 'amountMinor', 'status']),
    risk: 'high', sideEffect: true, reversible: true, compensationCapabilityId: COMMERCE_CANCEL_CAPABILITY,
    verificationStrategy: 'provider_order_lookup_before_retry',
    targetRestrictions: [...base.targetRestrictions, 'commerce:merchant', 'commerce:destination'],
  },
  {
    ...base, id: COMMERCE_PAYMENT_CAPABILITY,
    description: 'Confirm one exact payment after fresh approval and verify the provider receipt',
    inputSchema: transactionInput({ transactionId: idSchema, quoteDigest: digestSchema, approvalId: idSchema,
      amountMinor: moneySchema }, ['transactionId', 'quoteDigest', 'approvalId', 'amountMinor']),
    outputSchema: transactionOutput('payment_confirm', { transactionId: idSchema,
      providerReceiptId: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
      receiptDigest: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' }, amountMinor: moneySchema,
      status: { enum: ['shadowed', 'paid', 'declined', 'unknown'] } },
    ['transactionId', 'providerReceiptId', 'receiptDigest', 'amountMinor', 'status']),
    risk: 'critical', sideEffect: true, reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'fresh_approval_and_payment_lookup',
    authentication: [...base.authentication, 'commerce_payment:fresh_exact_approval'],
    targetRestrictions: [...base.targetRestrictions, 'commerce:merchant', 'commerce:destination'],
  },
  {
    ...base, id: COMMERCE_DELIVERY_CAPABILITY,
    description: 'Track bounded current delivery state for one exact commerce transaction',
    inputSchema: inputSchema({ transactionId: idSchema }, ['transactionId']),
    outputSchema: outputSchema('delivery_track', { transactionId: idSchema, providerEventId: idSchema,
      state: { enum: ['not_started', 'preparing', 'ready', 'in_transit', 'delivered', 'failed', 'cancelled', 'unknown'] },
      observedAt: timestampSchema }, ['transactionId', 'providerEventId', 'state', 'observedAt']),
    risk: 'low', sideEffect: false, reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'provider_delivery_state_read',
  },
  {
    ...base, id: COMMERCE_CANCEL_CAPABILITY,
    description: 'Cancel one eligible exact order and verify provider cancellation state',
    inputSchema: transactionInput({ transactionId: idSchema, providerRequestId: idSchema,
      reasonCode: idSchema }, ['transactionId', 'providerRequestId', 'reasonCode']),
    outputSchema: transactionOutput('order_cancel', { transactionId: idSchema,
      providerReceiptId: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
      status: { enum: ['shadowed', 'cancelled', 'rejected', 'unknown'] } },
    ['transactionId', 'providerReceiptId', 'status']),
    risk: 'high', sideEffect: true, reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'provider_cancellation_lookup_before_retry',
    targetRestrictions: [...base.targetRestrictions, 'commerce:merchant', 'commerce:destination'],
  },
  {
    ...base, id: COMMERCE_REFUND_CAPABILITY,
    description: 'Request one bounded refund against an eligible exact order and verify the receipt',
    inputSchema: transactionInput({ transactionId: idSchema, providerRequestId: idSchema,
      reasonCode: idSchema, amountMinor: moneySchema },
    ['transactionId', 'providerRequestId', 'reasonCode', 'amountMinor']),
    outputSchema: transactionOutput('refund_request', { transactionId: idSchema,
      providerReceiptId: { type: ['string', 'null'], minLength: 1, maxLength: 200 }, amountMinor: moneySchema,
      status: { enum: ['shadowed', 'processing', 'refunded', 'rejected', 'unknown'] } },
    ['transactionId', 'providerReceiptId', 'amountMinor', 'status']),
    risk: 'high', sideEffect: true, reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'provider_refund_lookup_before_retry',
    targetRestrictions: [...base.targetRestrictions, 'commerce:merchant', 'commerce:destination'],
  },
]

export function isCommerceFabricCapability(capabilityId: string): boolean {
  return CAPABILITIES.has(capabilityId)
}

export function validateCommerceFabricSemantics(capabilityId: string, input: FabricJsonObject): boolean {
  if (!isCommerceFabricCapability(capabilityId) || !plainRecord(input)) return false
  const expected = expectedInputKeys(capabilityId)
  if (!expected || !exactKeys(input, expected) || value(input, 'schemaVersion') !== 1
    || !isCommerceSemanticId(value(input, 'accountId')) || !isCommerceProviderKind(value(input, 'provider'))
    || value(input, 'provider') === 'virtual' || !isCommerceCurrency(value(input, 'currency'))) return false
  for (const key of expected.filter(key => key.endsWith('Id') && key !== 'accountId')) {
    if (!isCommerceSemanticId(value(input, key))) return false
  }
  for (const key of expected.filter(key => key.endsWith('Digest'))) {
    if (!isCommerceDigest(value(input, key))) return false
  }
  if (expected.includes('amountMinor') && !safeMoney(value(input, 'amountMinor'))) return false
  if (capabilityId === COMMERCE_SEARCH_CAPABILITY) {
    const query = value(input, 'query'); const limit = value(input, 'limit')
    return typeof query === 'string' && query.trim() === query && query.length >= 1 && query.length <= 200
      && Number.isSafeInteger(limit) && Number(limit) >= 1 && Number(limit) <= 20
  }
  return true
}

export function commerceTargetAtoms(
  capabilityId: string,
  target: FabricJsonObject,
  input: FabricJsonObject,
): string[] | null {
  if (!validateCommerceFabricSemantics(capabilityId, input) || !plainRecord(target)) return null
  const transactionTarget = TRANSACTION_TARGET_CAPABILITIES.has(capabilityId)
  const expected = transactionTarget
    ? ['accountId', 'currency', 'destinationDigest', 'kind', 'merchantId', 'provider']
    : ['accountId', 'currency', 'kind', 'provider']
  if (!exactKeys(target, expected) || value(target, 'kind') !== 'commerce_account'
    || value(target, 'accountId') !== value(input, 'accountId') || value(target, 'provider') !== value(input, 'provider')
    || value(target, 'currency') !== value(input, 'currency')) return null
  const atoms = [`commerce:account:${String(value(input, 'accountId'))}`,
    `commerce:provider:${String(value(input, 'provider'))}`, `commerce:currency:${String(value(input, 'currency'))}`]
  if (transactionTarget) {
    if (value(target, 'merchantId') !== value(input, 'merchantId')
      || value(target, 'destinationDigest') !== value(input, 'destinationDigest')
      || !isCommerceSemanticId(value(target, 'merchantId')) || !isCommerceDigest(value(target, 'destinationDigest'))) return null
    atoms.push(`commerce:merchant:${String(value(target, 'merchantId'))}`,
      `commerce:destination:${String(value(target, 'destinationDigest'))}`)
  }
  return atoms
}

export function validateCommerceFabricOutput(
  capabilityId: string,
  input: FabricJsonObject,
  output: FabricJsonObject,
): boolean {
  if (!isCommerceFabricCapability(capabilityId)) return true
  if (!validateCommerceFabricSemantics(capabilityId, input) || !plainRecord(output)
    || value(output, 'schemaVersion') !== 1 || value(output, 'accountId') !== value(input, 'accountId')
    || value(output, 'provider') !== value(input, 'provider') || value(output, 'currency') !== value(input, 'currency')) return false
  const amount = value(output, 'amountMinor')
  if (amount !== undefined && (!safeMoney(amount) || (value(input, 'amountMinor') !== undefined
    && Number(amount) > Number(value(input, 'amountMinor'))))) return false
  for (const key of ['comparisonId', 'inputDigest', 'cartRevisionId', 'cartDigest', 'quoteId', 'quoteDigest', 'transactionId']) {
    if (value(input, key) !== undefined && value(output, key) !== undefined && value(input, key) !== value(output, key)) return false
  }
  return true
}

function transactionInput(extra: Record<string, unknown>, required: string[]): FabricJsonObject {
  return inputSchema({ merchantId: idSchema, destinationDigest: digestSchema, ...extra },
    ['merchantId', 'destinationDigest', ...required])
}

function transactionOutput(operation: string, extra: Record<string, unknown>, required: string[]): FabricJsonObject {
  return outputSchema(operation, { merchantId: idSchema, destinationDigest: digestSchema, ...extra },
    ['merchantId', 'destinationDigest', ...required])
}

function expectedInputKeys(capabilityId: string): string[] | null {
  const baseKeys = ['accountId', 'currency', 'provider', 'schemaVersion']
  const extra: Record<string, string[]> = {
    [COMMERCE_SEARCH_CAPABILITY]: ['limit', 'query'],
    [COMMERCE_COMPARE_CAPABILITY]: ['comparisonId', 'inputDigest'],
    [COMMERCE_CART_CAPABILITY]: ['cartDigest', 'cartRevisionId', 'comparisonId', 'destinationDigest'],
    [COMMERCE_QUOTE_CAPABILITY]: ['amountMinor', 'cartDigest', 'cartRevisionId', 'quoteDigest', 'quoteId'],
    [COMMERCE_ORDER_CAPABILITY]: ['amountMinor', 'destinationDigest', 'merchantId', 'providerRequestId', 'quoteDigest', 'quoteId'],
    [COMMERCE_PAYMENT_CAPABILITY]: ['amountMinor', 'approvalId', 'destinationDigest', 'merchantId', 'quoteDigest', 'transactionId'],
    [COMMERCE_DELIVERY_CAPABILITY]: ['transactionId'],
    [COMMERCE_CANCEL_CAPABILITY]: ['destinationDigest', 'merchantId', 'providerRequestId', 'reasonCode', 'transactionId'],
    [COMMERCE_REFUND_CAPABILITY]: ['amountMinor', 'destinationDigest', 'merchantId', 'providerRequestId', 'reasonCode', 'transactionId'],
  }
  return extra[capabilityId] ? [...baseKeys, ...extra[capabilityId]!].sort() : null
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => {
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : undefined
    return !!descriptor?.enumerable && 'value' in descriptor
  })
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function value(record: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value
}

function safeMoney(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }

export function assertCommerceCapability(capabilityId: string): void {
  if (!isCommerceFabricCapability(capabilityId)) throw new CommerceContractError('COMMERCE_CAPABILITY_UNSUPPORTED')
}

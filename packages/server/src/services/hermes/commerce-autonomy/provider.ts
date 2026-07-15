import { createHash } from 'crypto'
import {
  assertCommerceSafeData,
  CommerceContractError,
  isCommerceCurrency,
  isCommerceProviderKind,
  isCommerceSemanticId,
} from './contracts'
import { commerceCanonicalDigest } from './store'
import type { CommerceDeliveryState, CommerceProviderKind, CommerceQuoteBreakdown } from './types'

export type CommerceProviderOperation =
  | 'search_offers'
  | 'refresh_quote'
  | 'place_order'
  | 'lookup_order'
  | 'confirm_payment'
  | 'lookup_payment'
  | 'track_delivery'
  | 'cancel_order'
  | 'lookup_cancellation'
  | 'request_refund'
  | 'lookup_refund'

export type VirtualCommerceFault = 'timeout_before_effect' | 'effect_before_timeout' | 'challenge'

export interface CommerceProviderOffer {
  providerOfferId: string
  productId: string
  skuId: string
  merchantId: string
  merchantName: string
  title: string
  unitLabel: string
  currency: string
  unitPriceMinor: number
  available: boolean
  maxQuantity: number
  fulfillment: 'delivery' | 'shipping' | 'pickup'
  fulfillmentMinutes: number | null
  observedAt: string
  expiresAt: string
  sourceDigest: string
}

export interface CommerceProviderQuoteResult {
  schemaVersion: 1
  operation: 'refresh_quote'
  providerQuoteId: string
  cartDigest: string
  currency: string
  breakdown: CommerceQuoteBreakdown
  observedAt: string
  expiresAt: string
  quoteDigest: string
}

export interface CommerceProviderOrderResult {
  schemaVersion: 1
  operation: 'place_order' | 'lookup_order'
  providerRequestId: string
  providerOrderId: string | null
  status: 'not_found' | 'pending_payment' | 'paid' | 'fulfilling' | 'delivered' | 'cancelled' | 'refunding' | 'refunded'
  currency: string | null
  amountMinor: number | null
  receiptDigest: string | null
}

export interface CommerceProviderPaymentResult {
  schemaVersion: 1
  operation: 'confirm_payment' | 'lookup_payment'
  providerRequestId: string
  providerOrderId: string
  status: 'not_found' | 'paid' | 'declined'
  currency: string
  amountMinor: number
  providerReceiptId: string | null
  receiptDigest: string | null
}

export interface CommerceProviderDeliveryResult {
  schemaVersion: 1
  operation: 'track_delivery'
  providerOrderId: string
  providerEventId: string
  state: CommerceDeliveryState
  etaAt: string | null
  observedAt: string
  evidenceDigest: string
}

export interface CommerceProviderAdjustmentResult {
  schemaVersion: 1
  operation: 'cancel_order' | 'lookup_cancellation' | 'request_refund' | 'lookup_refund'
  providerRequestId: string
  providerOrderId: string
  status: 'not_found' | 'cancelled' | 'rejected' | 'processing' | 'refunded'
  currency: string | null
  amountMinor: number | null
  providerReceiptId: string | null
  receiptDigest: string | null
}

export class CommerceProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly uncertain: boolean,
    readonly waitingUser: boolean,
  ) {
    super(code)
    this.name = 'CommerceProviderError'
  }
}

export interface CommerceProviderAdapter {
  readonly provider: CommerceProviderKind
  readonly transport: 'virtual' | 'external'
  searchOffers(input: { query: string; limit: number }): Promise<CommerceProviderOffer[]>
  refreshQuote(input: {
    providerRequestId: string
    cartDigest: string
    currency: string
    items: Array<{ providerOfferId: string; quantity: number }>
    destinationToken: string
    substitution: 'deny' | 'same_sku_only'
  }): Promise<CommerceProviderQuoteResult>
  placeOrder(input: {
    providerRequestId: string
    providerQuoteId: string
    quoteDigest: string
    currency: string
    amountMinor: number
  }): Promise<CommerceProviderOrderResult>
  lookupOrder(input: { providerRequestId: string }): Promise<CommerceProviderOrderResult>
  confirmPayment(input: {
    providerRequestId: string
    providerOrderId: string
    approvalId: string
    currency: string
    amountMinor: number
  }): Promise<CommerceProviderPaymentResult>
  lookupPayment(input: { providerRequestId: string; providerOrderId: string }): Promise<CommerceProviderPaymentResult>
  trackDelivery(input: { providerOrderId: string }): Promise<CommerceProviderDeliveryResult>
  cancelOrder(input: {
    providerRequestId: string; providerOrderId: string; reasonCode: string
  }): Promise<CommerceProviderAdjustmentResult>
  lookupCancellation(input: {
    providerRequestId: string; providerOrderId: string
  }): Promise<CommerceProviderAdjustmentResult>
  requestRefund(input: {
    providerRequestId: string; providerOrderId: string; reasonCode: string; currency: string; amountMinor: number
  }): Promise<CommerceProviderAdjustmentResult>
  lookupRefund(input: {
    providerRequestId: string; providerOrderId: string
  }): Promise<CommerceProviderAdjustmentResult>
}

interface VirtualCatalogOffer extends Omit<CommerceProviderOffer, 'observedAt' | 'expiresAt' | 'sourceDigest'> {}
interface VirtualQuoteRecord { requestDigest: string; result: CommerceProviderQuoteResult }
interface VirtualOrderRecord { requestDigest: string; result: CommerceProviderOrderResult; deliveryState: CommerceDeliveryState; event: number }
interface VirtualPaymentRecord { requestDigest: string; result: CommerceProviderPaymentResult }
interface VirtualAdjustmentRecord { requestDigest: string; result: CommerceProviderAdjustmentResult }

export class VirtualCommerceProvider implements CommerceProviderAdapter {
  readonly provider: CommerceProviderKind
  readonly transport = 'virtual' as const
  private readonly catalog: VirtualCatalogOffer[]
  private readonly now: () => Date
  private readonly faults = new Map<CommerceProviderOperation, VirtualCommerceFault>()
  private readonly quotes = new Map<string, VirtualQuoteRecord>()
  private readonly ordersByRequest = new Map<string, VirtualOrderRecord>()
  private readonly ordersById = new Map<string, VirtualOrderRecord>()
  private readonly payments = new Map<string, VirtualPaymentRecord>()
  private readonly cancellations = new Map<string, VirtualAdjustmentRecord>()
  private readonly refunds = new Map<string, VirtualAdjustmentRecord>()

  constructor(options: {
    provider: CommerceProviderKind
    catalog: VirtualCatalogOffer[]
    clock?: () => Date
  }) {
    if (!isCommerceProviderKind(options.provider) || options.provider === 'virtual'
      || !Array.isArray(options.catalog) || options.catalog.length < 1 || options.catalog.length > 100) {
      throw new CommerceProviderError('COMMERCE_PROVIDER_CONFIGURATION_INVALID', false, false, false)
    }
    this.provider = options.provider
    this.catalog = options.catalog.map(validateCatalogOffer)
    this.now = options.clock ?? (() => new Date())
  }

  injectFault(operation: CommerceProviderOperation, fault: VirtualCommerceFault): void {
    this.faults.set(operation, fault)
  }

  async searchOffers(input: { query: string; limit: number }): Promise<CommerceProviderOffer[]> {
    this.before('search_offers')
    if (typeof input.query !== 'string' || input.query.trim() !== input.query || !input.query || input.query.length > 200
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) {
      throw providerInputError()
    }
    const observedAt = this.timestamp()
    const expiresAt = new Date(Date.parse(observedAt) + 15 * 60_000).toISOString()
    const query = input.query.toLocaleLowerCase('en-US')
    const matches = this.catalog.filter(item => `${item.title} ${item.merchantName}`.toLocaleLowerCase('en-US').includes(query))
      .slice(0, input.limit).map(item => ({ ...item, observedAt, expiresAt,
        sourceDigest: commerceCanonicalDigest({ ...item, observedAt, expiresAt, provider: this.provider }) }))
    this.after('search_offers')
    return matches
  }

  async refreshQuote(input: {
    providerRequestId: string; cartDigest: string; currency: string
    items: Array<{ providerOfferId: string; quantity: number }>
    destinationToken: string; substitution: 'deny' | 'same_sku_only'
  }): Promise<CommerceProviderQuoteResult> {
    validateRequestId(input.providerRequestId)
    if (!/^[a-f0-9]{64}$/.test(input.cartDigest) || !isCommerceCurrency(input.currency)
      || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(input.destinationToken)
      || !['deny', 'same_sku_only'].includes(input.substitution)) throw providerInputError()
    const items = normalizeQuoteItems(input.items, this.catalog, input.currency)
    const requestDigest = providerRequestDigest({ cartDigest: input.cartDigest, currency: input.currency,
      destinationDigest: hash(input.destinationToken), items, substitution: input.substitution })
    const replay = replayRecord(this.quotes, input.providerRequestId, requestDigest)
    if (replay) return replay.result
    this.before('refresh_quote')
    const itemsMinor = items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0)
    const deliveryMinor = this.provider === 'food_delivery' ? 500 : 0
    const serviceMinor = this.provider === 'food_delivery' ? 100 : 0
    const breakdown = { itemsMinor, deliveryMinor, serviceMinor, taxMinor: 0, discountMinor: 0,
      totalMinor: itemsMinor + deliveryMinor + serviceMinor }
    const observedAt = this.timestamp()
    const expiresAt = new Date(Date.parse(observedAt) + 10 * 60_000).toISOString()
    const providerQuoteId = `vq-${hash(`${this.provider}:${input.providerRequestId}`).slice(0, 24)}`
    const material = { breakdown, cartDigest: input.cartDigest, currency: input.currency, expiresAt,
      observedAt, providerQuoteId }
    const result: CommerceProviderQuoteResult = { schemaVersion: 1, operation: 'refresh_quote', ...material,
      quoteDigest: commerceCanonicalDigest(material) }
    this.quotes.set(input.providerRequestId, { requestDigest, result })
    this.after('refresh_quote')
    return result
  }

  async placeOrder(input: {
    providerRequestId: string; providerQuoteId: string; quoteDigest: string; currency: string; amountMinor: number
  }): Promise<CommerceProviderOrderResult> {
    validateRequestId(input.providerRequestId)
    if (!isCommerceSemanticId(input.providerQuoteId) || !/^[a-f0-9]{64}$/.test(input.quoteDigest)
      || !isCommerceCurrency(input.currency) || !safeMoney(input.amountMinor)) throw providerInputError()
    const quote = [...this.quotes.values()].find(item => item.result.providerQuoteId === input.providerQuoteId)
    if (!quote || quote.result.quoteDigest !== input.quoteDigest || quote.result.currency !== input.currency
      || quote.result.breakdown.totalMinor !== input.amountMinor || Date.parse(quote.result.expiresAt) <= this.now().getTime()) {
      throw new CommerceProviderError('COMMERCE_PROVIDER_QUOTE_INVALID', false, false, false)
    }
    const requestDigest = providerRequestDigest(input)
    const replay = replayRecord(this.ordersByRequest, input.providerRequestId, requestDigest)
    if (replay) return replay.result
    this.before('place_order')
    const providerOrderId = `vo-${hash(`${this.provider}:${input.providerRequestId}`).slice(0, 24)}`
    const material = { providerOrderId, providerRequestId: input.providerRequestId, status: 'pending_payment' as const,
      currency: input.currency, amountMinor: input.amountMinor }
    const result: CommerceProviderOrderResult = { schemaVersion: 1, operation: 'place_order', ...material,
      receiptDigest: commerceCanonicalDigest(material) }
    const record = { requestDigest, result, deliveryState: 'not_started' as const, event: 0 }
    this.ordersByRequest.set(input.providerRequestId, record)
    this.ordersById.set(providerOrderId, record)
    this.after('place_order')
    return result
  }

  async lookupOrder(input: { providerRequestId: string }): Promise<CommerceProviderOrderResult> {
    validateRequestId(input.providerRequestId)
    this.before('lookup_order')
    const record = this.ordersByRequest.get(input.providerRequestId)
    const result: CommerceProviderOrderResult = record ? { ...record.result, operation: 'lookup_order' } : {
      schemaVersion: 1, operation: 'lookup_order', providerRequestId: input.providerRequestId,
      providerOrderId: null, status: 'not_found', currency: null, amountMinor: null, receiptDigest: null,
    }
    this.after('lookup_order')
    return result
  }

  async confirmPayment(input: {
    providerRequestId: string; providerOrderId: string; approvalId: string; currency: string; amountMinor: number
  }): Promise<CommerceProviderPaymentResult> {
    validateRequestId(input.providerRequestId)
    validateRequestId(input.approvalId)
    const order = this.ordersById.get(input.providerOrderId)
    if (!order || order.result.currency !== input.currency || order.result.amountMinor !== input.amountMinor
      || !isCommerceCurrency(input.currency) || !safeMoney(input.amountMinor)) throw providerInputError()
    const requestDigest = providerRequestDigest(input)
    const replay = replayRecord(this.payments, input.providerRequestId, requestDigest)
    if (replay) return replay.result
    this.before('confirm_payment')
    const providerReceiptId = `vp-${hash(`${this.provider}:${input.providerRequestId}`).slice(0, 24)}`
    const material = { providerOrderId: input.providerOrderId, providerRequestId: input.providerRequestId,
      status: 'paid' as const, currency: input.currency, amountMinor: input.amountMinor, providerReceiptId }
    const result: CommerceProviderPaymentResult = { schemaVersion: 1, operation: 'confirm_payment', ...material,
      receiptDigest: commerceCanonicalDigest(material) }
    this.payments.set(input.providerRequestId, { requestDigest, result })
    order.result = { ...order.result, status: 'paid', receiptDigest: result.receiptDigest }
    order.deliveryState = 'preparing'
    this.after('confirm_payment')
    return result
  }

  async lookupPayment(input: { providerRequestId: string; providerOrderId: string }): Promise<CommerceProviderPaymentResult> {
    validateRequestId(input.providerRequestId)
    this.before('lookup_payment')
    const record = this.payments.get(input.providerRequestId)
    if (record && record.result.providerOrderId !== input.providerOrderId) throw replayMismatch()
    const order = this.ordersById.get(input.providerOrderId)
    const result: CommerceProviderPaymentResult = record ? { ...record.result, operation: 'lookup_payment' } : {
      schemaVersion: 1, operation: 'lookup_payment', providerRequestId: input.providerRequestId,
      providerOrderId: input.providerOrderId, status: 'not_found', currency: order?.result.currency ?? 'CNY',
      amountMinor: order?.result.amountMinor ?? 0, providerReceiptId: null, receiptDigest: null,
    }
    this.after('lookup_payment')
    return result
  }

  async trackDelivery(input: { providerOrderId: string }): Promise<CommerceProviderDeliveryResult> {
    const order = this.ordersById.get(input.providerOrderId)
    if (!order) throw new CommerceProviderError('COMMERCE_PROVIDER_ORDER_NOT_FOUND', false, false, false)
    this.before('track_delivery')
    const observedAt = this.timestamp()
    const material = { providerOrderId: input.providerOrderId, providerEventId: `event-${order.event}`,
      state: order.deliveryState, etaAt: order.deliveryState === 'delivered' || order.deliveryState === 'cancelled'
        ? null : new Date(Date.parse(observedAt) + 30 * 60_000).toISOString(), observedAt }
    const result: CommerceProviderDeliveryResult = { schemaVersion: 1, operation: 'track_delivery', ...material,
      evidenceDigest: commerceCanonicalDigest(material) }
    this.after('track_delivery')
    return result
  }

  advanceDelivery(providerOrderId: string, state: Extract<CommerceDeliveryState,
    'preparing' | 'ready' | 'in_transit' | 'delivered'>): void {
    const order = this.ordersById.get(providerOrderId)
    if (!order || !['paid', 'fulfilling', 'delivered'].includes(order.result.status)) {
      throw new CommerceProviderError('COMMERCE_PROVIDER_DELIVERY_INVALID', false, false, false)
    }
    const rank = ['preparing', 'ready', 'in_transit', 'delivered']
    if (rank.indexOf(state) <= rank.indexOf(order.deliveryState)) {
      throw new CommerceProviderError('COMMERCE_PROVIDER_DELIVERY_STALE', false, false, false)
    }
    order.deliveryState = state
    order.event += 1
    order.result = { ...order.result, status: state === 'delivered' ? 'delivered' : 'fulfilling' }
  }

  async cancelOrder(input: {
    providerRequestId: string; providerOrderId: string; reasonCode: string
  }): Promise<CommerceProviderAdjustmentResult> {
    validateRequestId(input.providerRequestId)
    validateReason(input.reasonCode)
    const order = this.ordersById.get(input.providerOrderId)
    if (!order) throw new CommerceProviderError('COMMERCE_PROVIDER_ORDER_NOT_FOUND', false, false, false)
    const requestDigest = providerRequestDigest(input)
    const replay = replayRecord(this.cancellations, input.providerRequestId, requestDigest)
    if (replay) return replay.result
    this.before('cancel_order')
    const accepted = !['delivered', 'refunded'].includes(order.result.status)
    const result = adjustment('cancel_order', input, accepted ? 'cancelled' : 'rejected',
      accepted ? `vc-${hash(input.providerRequestId).slice(0, 24)}` : null, null)
    this.cancellations.set(input.providerRequestId, { requestDigest, result })
    if (accepted) { order.result = { ...order.result, status: 'cancelled' }; order.deliveryState = 'cancelled' }
    this.after('cancel_order')
    return result
  }

  async lookupCancellation(input: {
    providerRequestId: string; providerOrderId: string
  }): Promise<CommerceProviderAdjustmentResult> {
    return this.lookupAdjustment('lookup_cancellation', this.cancellations, input)
  }

  async requestRefund(input: {
    providerRequestId: string; providerOrderId: string; reasonCode: string; currency: string; amountMinor: number
  }): Promise<CommerceProviderAdjustmentResult> {
    validateRequestId(input.providerRequestId)
    validateReason(input.reasonCode)
    const order = this.ordersById.get(input.providerOrderId)
    if (!order || !isCommerceCurrency(input.currency) || !safeMoney(input.amountMinor)
      || order.result.currency !== input.currency || order.result.amountMinor === null
      || input.amountMinor > order.result.amountMinor) throw providerInputError()
    const requestDigest = providerRequestDigest(input)
    const replay = replayRecord(this.refunds, input.providerRequestId, requestDigest)
    if (replay) return replay.result
    this.before('request_refund')
    const eligible = ['paid', 'fulfilling', 'delivered', 'cancelled'].includes(order.result.status)
    const result = adjustment('request_refund', input, eligible ? 'refunded' : 'rejected',
      eligible ? `vr-${hash(input.providerRequestId).slice(0, 24)}` : null, eligible ? input.amountMinor : null)
    this.refunds.set(input.providerRequestId, { requestDigest, result })
    if (eligible) order.result = { ...order.result, status: 'refunded' }
    this.after('request_refund')
    return result
  }

  async lookupRefund(input: {
    providerRequestId: string; providerOrderId: string
  }): Promise<CommerceProviderAdjustmentResult> {
    return this.lookupAdjustment('lookup_refund', this.refunds, input)
  }

  private async lookupAdjustment(
    operation: 'lookup_cancellation' | 'lookup_refund',
    records: Map<string, VirtualAdjustmentRecord>,
    input: { providerRequestId: string; providerOrderId: string },
  ): Promise<CommerceProviderAdjustmentResult> {
    validateRequestId(input.providerRequestId)
    this.before(operation)
    const record = records.get(input.providerRequestId)
    if (record && record.result.providerOrderId !== input.providerOrderId) throw replayMismatch()
    const result = record ? { ...record.result, operation } : adjustment(operation, input, 'not_found', null, null)
    this.after(operation)
    return result
  }

  private before(operation: CommerceProviderOperation): void {
    const fault = this.faults.get(operation)
    if (!fault) return
    this.faults.delete(operation)
    if (fault === 'timeout_before_effect') {
      throw new CommerceProviderError('COMMERCE_PROVIDER_TIMEOUT', true, false, false)
    }
    if (fault === 'challenge') {
      throw new CommerceProviderError('COMMERCE_PROVIDER_CHALLENGE', false, false, true)
    }
    this.faults.set(operation, fault)
  }

  private after(operation: CommerceProviderOperation): void {
    if (this.faults.get(operation) !== 'effect_before_timeout') return
    this.faults.delete(operation)
    throw new CommerceProviderError('COMMERCE_PROVIDER_RESULT_UNKNOWN', true, true, false)
  }

  private timestamp(): string {
    const value = this.now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new CommerceProviderError('COMMERCE_PROVIDER_CLOCK_INVALID', false, false, false)
    }
    return value.toISOString()
  }
}

export function assertCommerceProviderResult(operation: CommerceProviderOperation, value: unknown): void {
  try { assertCommerceSafeData(value) } catch (error) {
    if (error instanceof CommerceContractError) throw new CommerceProviderError(error.code, false, false, false)
    throw error
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw providerResponseError()
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || record.operation !== operation) throw providerResponseError()
}

function validateCatalogOffer(input: VirtualCatalogOffer): VirtualCatalogOffer {
  if (!isCommerceSemanticId(input.providerOfferId) || !isCommerceSemanticId(input.productId)
    || !isCommerceSemanticId(input.skuId) || !isCommerceSemanticId(input.merchantId)
    || !cleanText(input.merchantName, 200) || !cleanText(input.title, 500) || !cleanText(input.unitLabel, 80)
    || !isCommerceCurrency(input.currency) || !safeMoney(input.unitPriceMinor) || typeof input.available !== 'boolean'
    || !Number.isSafeInteger(input.maxQuantity) || input.maxQuantity < 0 || input.maxQuantity > 9_999
    || !['delivery', 'shipping', 'pickup'].includes(input.fulfillment)
    || (input.fulfillmentMinutes !== null && (!Number.isSafeInteger(input.fulfillmentMinutes)
      || input.fulfillmentMinutes < 0 || input.fulfillmentMinutes > 525_600))) throw providerInputError()
  return { ...input }
}

function normalizeQuoteItems(
  input: Array<{ providerOfferId: string; quantity: number }>,
  catalog: VirtualCatalogOffer[],
  currency: string,
): Array<{ providerOfferId: string; quantity: number; unitPriceMinor: number }> {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) throw providerInputError()
  const ids = new Set<string>()
  return input.map(item => {
    const offer = catalog.find(candidate => candidate.providerOfferId === item.providerOfferId)
    if (!offer || ids.has(item.providerOfferId) || offer.currency !== currency || !offer.available
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > offer.maxQuantity) throw providerInputError()
    ids.add(item.providerOfferId)
    return { providerOfferId: item.providerOfferId, quantity: item.quantity, unitPriceMinor: offer.unitPriceMinor }
  }).sort((left, right) => left.providerOfferId < right.providerOfferId ? -1 : left.providerOfferId > right.providerOfferId ? 1 : 0)
}

function adjustment(
  operation: CommerceProviderAdjustmentResult['operation'],
  input: { providerRequestId: string; providerOrderId: string; currency?: string },
  status: CommerceProviderAdjustmentResult['status'],
  providerReceiptId: string | null,
  amountMinor: number | null,
): CommerceProviderAdjustmentResult {
  const material = { providerOrderId: input.providerOrderId, providerRequestId: input.providerRequestId,
    status, currency: input.currency ?? null, amountMinor, providerReceiptId }
  return { schemaVersion: 1, operation, ...material,
    receiptDigest: providerReceiptId ? commerceCanonicalDigest(material) : null }
}

function replayRecord<T extends { requestDigest: string }>(
  records: Map<string, T>,
  requestId: string,
  requestDigest: string,
): T | null {
  const record = records.get(requestId)
  if (!record) return null
  if (record.requestDigest !== requestDigest) throw replayMismatch()
  return record
}

function providerRequestDigest(value: unknown): string {
  return commerceCanonicalDigest(value)
}

function validateRequestId(value: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(value)) throw providerInputError()
}

function validateReason(value: string): void {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(value)) throw providerInputError()
}

function safeMoney(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function cleanText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value)
}
function providerInputError(): CommerceProviderError {
  return new CommerceProviderError('COMMERCE_PROVIDER_INPUT_INVALID', false, false, false)
}
function providerResponseError(): CommerceProviderError {
  return new CommerceProviderError('COMMERCE_PROVIDER_RESPONSE_INVALID', false, false, false)
}
function replayMismatch(): CommerceProviderError {
  return new CommerceProviderError('COMMERCE_PROVIDER_REQUEST_REPLAY_MISMATCH', false, false, false)
}

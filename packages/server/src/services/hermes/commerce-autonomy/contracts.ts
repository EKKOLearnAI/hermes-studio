import { isProxy } from 'node:util/types'
import {
  COMMERCE_ACCOUNT_HEALTH,
  COMMERCE_DELIVERY_STATES,
  COMMERCE_CANCELLATION_STATES,
  COMMERCE_REFUND_STATES,
  COMMERCE_EXECUTION_MODES,
  COMMERCE_FULFILLMENT_KINDS,
  COMMERCE_PAYMENT_STATES,
  COMMERCE_PROVIDER_KINDS,
  COMMERCE_TRANSACTION_STATES,
  type CommerceExecutionMode,
  type CommerceMoney,
  type CommerceProviderKind,
  type CommerceTransactionState,
} from './types'

const SEMANTIC_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/
const CURRENCY = /^[A-Z]{3}$/
const DIGEST = /^[a-f0-9]{64}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,127}$/
const SECRET_KEY = /(?:password|passwd|secret|token|cookie|authorization|api.?key|access.?key|cvv|cvc|(?:^|[_-])pan(?:$|[_-])|card.?number|session)/i
const MAX_JSON_BYTES = 32_768
const MAX_JSON_DEPTH = 8
const MAX_JSON_NODES = 512
const MAX_ARRAY_ITEMS = 64
const MAX_TEXT = 2_000

const PROVIDER_KINDS = new Set<string>(COMMERCE_PROVIDER_KINDS)
const MODES = new Set<string>(COMMERCE_EXECUTION_MODES)
const ACCOUNT_HEALTH = new Set<string>(COMMERCE_ACCOUNT_HEALTH)
const FULFILLMENT_KINDS = new Set<string>(COMMERCE_FULFILLMENT_KINDS)
const TRANSACTION_STATES = new Set<string>(COMMERCE_TRANSACTION_STATES)
const PAYMENT_STATES = new Set<string>(COMMERCE_PAYMENT_STATES)
const DELIVERY_STATES = new Set<string>(COMMERCE_DELIVERY_STATES)
const CANCELLATION_STATES = new Set<string>(COMMERCE_CANCELLATION_STATES)
const REFUND_STATES = new Set<string>(COMMERCE_REFUND_STATES)

const TRANSACTION_TRANSITIONS: Readonly<Record<CommerceTransactionState, readonly CommerceTransactionState[]>> = {
  proposed: ['quoted', 'failed'],
  quoted: ['waiting_approval', 'submitting_order', 'failed'],
  waiting_approval: ['submitting_order', 'waiting_user', 'failed'],
  submitting_order: ['order_pending', 'lookup_required', 'waiting_user', 'failed'],
  lookup_required: ['order_pending', 'waiting_payment', 'paid', 'cancelling', 'cancelled', 'refunding', 'refunded',
    'waiting_user', 'failed'],
  order_pending: ['waiting_payment', 'paid', 'fulfilling', 'cancelling', 'cancelled', 'failed'],
  waiting_payment: ['submitting_payment', 'cancelling', 'cancelled', 'waiting_user', 'failed'],
  submitting_payment: ['paid', 'lookup_required', 'waiting_user', 'failed'],
  paid: ['fulfilling', 'cancelling', 'refunding', 'failed'],
  fulfilling: ['delivered', 'cancelling', 'refunding', 'failed'],
  delivered: ['refunding'],
  cancelling: ['cancelled', 'lookup_required', 'waiting_user', 'failed'],
  cancelled: ['refunding'],
  refunding: ['refunded', 'lookup_required', 'waiting_user', 'failed'],
  refunded: [],
  waiting_user: ['lookup_required', 'waiting_approval', 'submitting_order', 'submitting_payment', 'cancelling', 'refunding', 'failed'],
  failed: [],
}

export class CommerceContractError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CommerceContractError'
  }
}

export function isCommerceProviderKind(value: unknown): value is CommerceProviderKind {
  return typeof value === 'string' && PROVIDER_KINDS.has(value)
}

export function isCommerceExecutionMode(value: unknown): value is CommerceExecutionMode {
  return typeof value === 'string' && MODES.has(value)
}

export function isCommerceTransactionState(value: unknown): value is CommerceTransactionState {
  return typeof value === 'string' && TRANSACTION_STATES.has(value)
}

export function isCommerceAccountHealth(value: unknown): boolean {
  return typeof value === 'string' && ACCOUNT_HEALTH.has(value)
}

export function isCommerceFulfillmentKind(value: unknown): boolean {
  return typeof value === 'string' && FULFILLMENT_KINDS.has(value)
}

export function isCommercePaymentState(value: unknown): boolean {
  return typeof value === 'string' && PAYMENT_STATES.has(value)
}

export function isCommerceDeliveryState(value: unknown): boolean {
  return typeof value === 'string' && DELIVERY_STATES.has(value)
}

export function isCommerceCancellationState(value: unknown): boolean {
  return typeof value === 'string' && CANCELLATION_STATES.has(value)
}

export function isCommerceRefundState(value: unknown): boolean {
  return typeof value === 'string' && REFUND_STATES.has(value)
}

export function isCommerceSemanticId(value: unknown): value is string {
  return typeof value === 'string' && SEMANTIC_ID.test(value)
}

export function isCommerceCurrency(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY.test(value)
}

export function isCommerceDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value)
}

export function isCommerceErrorCode(value: unknown): value is string {
  return typeof value === 'string' && ERROR_CODE.test(value)
}

export function parseCommerceMoney(value: unknown): CommerceMoney {
  if (!plainRecord(value) || !exactKeys(value, ['amountMinor', 'currency'])
    || !isCommerceCurrency(read(value, 'currency'))
    || !Number.isSafeInteger(read(value, 'amountMinor'))
    || Number(read(value, 'amountMinor')) < 0) {
    throw new CommerceContractError('COMMERCE_MONEY_INVALID')
  }
  return { currency: String(read(value, 'currency')), amountMinor: Number(read(value, 'amountMinor')) }
}

export function assertCommerceSafeData(value: unknown): void {
  let nodes = 0
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new CommerceContractError('COMMERCE_DATA_BOUNDS_EXCEEDED')
    }
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'string') {
      if (typeof candidate === 'string' && candidate.length > MAX_TEXT) {
        throw new CommerceContractError('COMMERCE_DATA_BOUNDS_EXCEEDED')
      }
      return
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new CommerceContractError('COMMERCE_DATA_INVALID')
      return
    }
    if (Array.isArray(candidate) && !isProxy(candidate)) {
      if (candidate.length > MAX_ARRAY_ITEMS || !denseArray(candidate)) {
        throw new CommerceContractError('COMMERCE_DATA_BOUNDS_EXCEEDED')
      }
      for (const item of candidate) visit(item, depth + 1)
      return
    }
    if (!plainRecord(candidate)) throw new CommerceContractError('COMMERCE_DATA_INVALID')
    const keys = Object.keys(candidate)
    if (keys.length > MAX_ARRAY_ITEMS) throw new CommerceContractError('COMMERCE_DATA_BOUNDS_EXCEEDED')
    for (const key of keys) {
      if (!SEMANTIC_ID.test(key) || SECRET_KEY.test(key)) {
        throw new CommerceContractError(SECRET_KEY.test(key) ? 'COMMERCE_SECRET_FIELD_FORBIDDEN' : 'COMMERCE_DATA_INVALID')
      }
      visit(read(candidate, key), depth + 1)
    }
  }
  visit(value, 0)
  let encoded: string
  try { encoded = JSON.stringify(value) } catch { throw new CommerceContractError('COMMERCE_DATA_INVALID') }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) {
    throw new CommerceContractError('COMMERCE_DATA_BOUNDS_EXCEEDED')
  }
}

export function commerceModeAllowsExternalWrite(mode: CommerceExecutionMode): boolean {
  if (!isCommerceExecutionMode(mode)) throw new CommerceContractError('COMMERCE_MODE_INVALID')
  return mode === 'live'
}

export function commercePaymentRequiresFreshApproval(mode: CommerceExecutionMode): boolean {
  if (!isCommerceExecutionMode(mode)) throw new CommerceContractError('COMMERCE_MODE_INVALID')
  return mode === 'live'
}

export function isLegalCommerceTransactionTransition(
  from: CommerceTransactionState,
  to: CommerceTransactionState,
): boolean {
  if (!isCommerceTransactionState(from) || !isCommerceTransactionState(to)) return false
  return TRANSACTION_TRANSITIONS[from].includes(to)
}

export function isTerminalCommerceTransactionState(state: CommerceTransactionState): boolean {
  if (!isCommerceTransactionState(state)) throw new CommerceContractError('COMMERCE_TRANSACTION_STATE_INVALID')
  return state === 'cancelled' || state === 'refunded' || state === 'failed'
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return !!descriptor?.enumerable && 'value' in descriptor
  })
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function read(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function denseArray(value: unknown[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string'
    && (key === 'length' || /^(?:0|[1-9][0-9]*)$/.test(key)))
    && Object.keys(value).length === value.length
}

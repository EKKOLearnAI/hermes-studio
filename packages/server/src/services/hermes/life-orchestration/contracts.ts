import { isProxy } from 'node:util/types'
import { isFabricSensitiveString } from '../action-fabric/audit'
import {
  LIFE_ACCOUNT_HEALTH,
  LIFE_CANCELLATION_STATES,
  LIFE_EXECUTION_MODES,
  LIFE_HANDOFF_KINDS,
  LIFE_HANDOFF_STATES,
  LIFE_HOLD_STATES,
  LIFE_OPTION_KINDS,
  LIFE_PLAN_STATES,
  LIFE_SOURCE_KINDS,
  LIFE_SUBSCRIPTION_STATES,
  type LifeCalendarHoldState,
  type LifeAccountHealth,
  type LifeExecutionMode,
  type LifeHandoffKind,
  type LifeHandoffState,
  type LifeMoney,
  type LifeOptionKind,
  type LifePlanState,
  type LifeSourceKind,
  type LifeSubscriptionState,
  type LifeSubscriptionCancellationState,
  type LifeTimeWindow,
} from './types'

const SEMANTIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const CURRENCY = /^[A-Z]{3}$/
const DIGEST = /^[a-f0-9]{64}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,127}$/
const SECRET_KEY = /(?:password|passwd|secret|token|cookie|authorization|api.?key|access.?key|session(?:[_-]?(?:id|token|key|cookie|secret))?$|email|phone|mobile|address|passport|identity|card|cvv|cvc)/i
const MAX_JSON_BYTES = 32_768
const MAX_JSON_DEPTH = 8
const MAX_JSON_NODES = 512
const MAX_ARRAY_ITEMS = 64
const MAX_TEXT = 2_000
const MAX_WINDOW_MS = 366 * 24 * 60 * 60_000

const SETS = {
  source: new Set<string>(LIFE_SOURCE_KINDS), mode: new Set<string>(LIFE_EXECUTION_MODES),
  health: new Set<string>(LIFE_ACCOUNT_HEALTH), option: new Set<string>(LIFE_OPTION_KINDS),
  subscription: new Set<string>(LIFE_SUBSCRIPTION_STATES), plan: new Set<string>(LIFE_PLAN_STATES),
  hold: new Set<string>(LIFE_HOLD_STATES), cancellation: new Set<string>(LIFE_CANCELLATION_STATES),
  handoffKind: new Set<string>(LIFE_HANDOFF_KINDS), handoffState: new Set<string>(LIFE_HANDOFF_STATES),
}

const PLAN_TRANSITIONS: Readonly<Record<LifePlanState, readonly LifePlanState[]>> = {
  proposed: ['reserved', 'superseded', 'expired'], reserved: ['completed', 'superseded', 'expired'],
  superseded: [], completed: [], expired: [],
}
const HOLD_TRANSITIONS: Readonly<Record<LifeCalendarHoldState, readonly LifeCalendarHoldState[]>> = {
  requested: ['submitting', 'failed'], submitting: ['confirmed', 'lookup_required', 'waiting_user', 'failed'],
  confirmed: ['cancel_requested'], cancel_requested: ['cancelling', 'failed'],
  cancelling: ['cancelled', 'lookup_required', 'waiting_user', 'failed'], cancelled: [],
  lookup_required: ['submitting', 'cancelling', 'confirmed', 'cancelled', 'waiting_user', 'failed'],
  waiting_user: ['submitting', 'cancelling', 'lookup_required', 'failed'], failed: [],
}
const CANCELLATION_TRANSITIONS: Readonly<Record<LifeSubscriptionCancellationState,
  readonly LifeSubscriptionCancellationState[]>> = {
  requested: ['submitting', 'failed'], submitting: ['processing', 'cancelled', 'rejected', 'lookup_required', 'waiting_user', 'failed'],
  processing: ['cancelled', 'rejected', 'lookup_required', 'waiting_user', 'failed'], cancelled: [], rejected: [],
  lookup_required: ['submitting', 'processing', 'cancelled', 'rejected', 'waiting_user', 'failed'],
  waiting_user: ['submitting', 'lookup_required', 'failed'], failed: [],
}
const HANDOFF_TRANSITIONS: Readonly<Record<LifeHandoffState, readonly LifeHandoffState[]>> = {
  proposed: ['accepted', 'expired', 'cancelled'], accepted: [], expired: [], cancelled: [],
}

export class LifeContractError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LifeContractError' }
}

export function isLifeSemanticId(value: unknown): value is string {
  return typeof value === 'string' && SEMANTIC_ID.test(value)
}
export function isLifeCurrency(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY.test(value)
}
export function isLifeDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value)
}
export function isLifeErrorCode(value: unknown): value is string {
  return typeof value === 'string' && ERROR_CODE.test(value)
}
export function isLifeSourceKind(value: unknown): value is LifeSourceKind {
  return typeof value === 'string' && SETS.source.has(value)
}
export function isLifeExecutionMode(value: unknown): value is LifeExecutionMode {
  return typeof value === 'string' && SETS.mode.has(value)
}
export function isLifeAccountHealth(value: unknown): value is LifeAccountHealth {
  return typeof value === 'string' && SETS.health.has(value)
}
export function isLifeOptionKind(value: unknown): value is LifeOptionKind {
  return typeof value === 'string' && SETS.option.has(value)
}
export function isLifeSubscriptionState(value: unknown): value is LifeSubscriptionState {
  return typeof value === 'string' && SETS.subscription.has(value)
}
export function isLifePlanState(value: unknown): value is LifePlanState { return typeof value === 'string' && SETS.plan.has(value) }
export function isLifeCalendarHoldState(value: unknown): value is LifeCalendarHoldState {
  return typeof value === 'string' && SETS.hold.has(value)
}
export function isLifeSubscriptionCancellationState(value: unknown): value is LifeSubscriptionCancellationState {
  return typeof value === 'string' && SETS.cancellation.has(value)
}
export function isLifeHandoffKind(value: unknown): value is LifeHandoffKind {
  return typeof value === 'string' && SETS.handoffKind.has(value)
}
export function isLifeHandoffState(value: unknown): value is LifeHandoffState {
  return typeof value === 'string' && SETS.handoffState.has(value)
}

export function parseLifeMoney(value: unknown): LifeMoney {
  if (!plainRecord(value) || !exactKeys(value, ['amountMinor', 'currency'])
    || !isLifeCurrency(read(value, 'currency')) || !Number.isSafeInteger(read(value, 'amountMinor'))
    || Number(read(value, 'amountMinor')) < 0) throw new LifeContractError('LIFE_MONEY_INVALID')
  return { currency: String(read(value, 'currency')), amountMinor: Number(read(value, 'amountMinor')) }
}

export function parseLifeTimeWindow(value: unknown): LifeTimeWindow {
  if (!plainRecord(value) || !exactKeys(value, ['endsAt', 'startsAt'])) {
    throw new LifeContractError('LIFE_TIME_WINDOW_INVALID')
  }
  const startsAt = canonicalTimestamp(read(value, 'startsAt'))
  const endsAt = canonicalTimestamp(read(value, 'endsAt'))
  const duration = Date.parse(endsAt) - Date.parse(startsAt)
  if (duration <= 0 || duration > MAX_WINDOW_MS) throw new LifeContractError('LIFE_TIME_WINDOW_INVALID')
  return { startsAt, endsAt }
}

export function isLifeTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true } catch { return false }
}

export function lifeModeAllowsExternalWrite(mode: LifeExecutionMode): boolean {
  if (!isLifeExecutionMode(mode)) throw new LifeContractError('LIFE_MODE_INVALID')
  return mode === 'live'
}

export function isLegalLifePlanTransition(from: LifePlanState, to: LifePlanState): boolean {
  return isLifePlanState(from) && isLifePlanState(to) && PLAN_TRANSITIONS[from].includes(to)
}
export function isLegalLifeHoldTransition(from: LifeCalendarHoldState, to: LifeCalendarHoldState): boolean {
  return isLifeCalendarHoldState(from) && isLifeCalendarHoldState(to) && HOLD_TRANSITIONS[from].includes(to)
}
export function isLegalLifeCancellationTransition(
  from: LifeSubscriptionCancellationState,
  to: LifeSubscriptionCancellationState,
): boolean {
  return isLifeSubscriptionCancellationState(from) && isLifeSubscriptionCancellationState(to)
    && CANCELLATION_TRANSITIONS[from].includes(to)
}
export function isLegalLifeHandoffTransition(from: LifeHandoffState, to: LifeHandoffState): boolean {
  return isLifeHandoffState(from) && isLifeHandoffState(to) && HANDOFF_TRANSITIONS[from].includes(to)
}

export function assertLifeSafeData(value: unknown): void {
  let nodes = 0
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new LifeContractError('LIFE_DATA_BOUNDS_EXCEEDED')
    if (candidate === null || typeof candidate === 'boolean') return
    if (typeof candidate === 'string') {
      if (candidate.length > MAX_TEXT) throw new LifeContractError('LIFE_DATA_BOUNDS_EXCEEDED')
      if (isFabricSensitiveString(candidate)) throw new LifeContractError('LIFE_SENSITIVE_VALUE_FORBIDDEN')
      return
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new LifeContractError('LIFE_DATA_INVALID')
      return
    }
    if (Array.isArray(candidate) && !isProxy(candidate)) {
      if (candidate.length > MAX_ARRAY_ITEMS || !denseArray(candidate)) {
        throw new LifeContractError('LIFE_DATA_BOUNDS_EXCEEDED')
      }
      for (let index = 0; index < candidate.length; index += 1) {
        visit(Object.getOwnPropertyDescriptor(candidate, String(index))?.value, depth + 1)
      }
      return
    }
    if (!plainRecord(candidate)) throw new LifeContractError('LIFE_DATA_INVALID')
    const keys = Object.keys(candidate)
    if (keys.length > MAX_ARRAY_ITEMS) throw new LifeContractError('LIFE_DATA_BOUNDS_EXCEEDED')
    for (const key of keys) {
      if (!SEMANTIC_ID.test(key)) throw new LifeContractError('LIFE_DATA_INVALID')
      if (SECRET_KEY.test(key)) throw new LifeContractError('LIFE_SECRET_FIELD_FORBIDDEN')
      visit(read(candidate, key), depth + 1)
    }
  }
  visit(value, 0)
  let encoded: string
  try { encoded = JSON.stringify(value) } catch { throw new LifeContractError('LIFE_DATA_INVALID') }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) {
    throw new LifeContractError('LIFE_DATA_BOUNDS_EXCEEDED')
  }
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new LifeContractError('LIFE_TIME_WINDOW_INVALID')
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new LifeContractError('LIFE_TIME_WINDOW_INVALID')
  }
  return value
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
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}
function read(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}
function denseArray(value: unknown[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string'
    && (key === 'length' || /^(?:0|[1-9][0-9]*)$/.test(key)))
    && Object.keys(value).length === value.length
    && Object.keys(value).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !!descriptor?.enumerable && 'value' in descriptor
    })
}

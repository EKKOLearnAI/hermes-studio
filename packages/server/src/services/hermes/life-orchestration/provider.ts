import { createHash } from 'crypto'
import {
  assertLifeSafeData,
  isLifeCurrency,
  isLifeDigest,
  isLifeErrorCode,
  isLifeOptionKind,
  isLifeSemanticId,
  isLifeSourceKind,
  LifeContractError,
  parseLifeTimeWindow,
} from './contracts'
import { lifeCanonicalDigest } from './store'
import type {
  LifeCommitmentCategory,
  LifeLocationClass,
  LifeMoney,
  LifeOptionKind,
  LifeSourceKind,
  LifeSubscriptionState,
  LifeTimeWindow,
} from './types'

export type LifeProviderOperation =
  | 'list_commitments'
  | 'list_contacts'
  | 'list_options'
  | 'list_subscriptions'
  | 'create_calendar_hold'
  | 'lookup_calendar_hold'
  | 'cancel_calendar_hold'
  | 'lookup_calendar_cancellation'
  | 'cancel_subscription'
  | 'lookup_subscription_cancellation'

export type VirtualLifeProviderFault =
  | 'timeout_before_effect'
  | 'effect_before_timeout'
  | 'malformed_result'

export interface LifeProviderCommitment {
  recordKind: 'commitment'
  providerItemId: string
  label: string
  category: LifeCommitmentCategory
  startsAt: string
  endsAt: string
  allDay: boolean
  busy: boolean
  locationClass: LifeLocationClass
  participantProviderContactIds: string[]
  observedAt: string
  expiresAt: string
  sourceDigest: string
}

export interface LifeProviderContact {
  recordKind: 'contact'
  providerContactId: string
  alias: string
  relationshipTags: string[]
  availabilityTags: string[]
  observedAt: string
  sourceDigest: string
}

export interface LifeProviderOption {
  recordKind: 'option'
  providerItemId: string
  kind: LifeOptionKind
  source: string
  title: string
  categoryTags: string[]
  durationMinutes: number
  exertion: 'low' | 'medium' | 'high'
  screenBased: boolean
  locationClass: LifeLocationClass
  cost: LifeMoney | null
  available: boolean
  observedAt: string
  expiresAt: string
  sourceDigest: string
}

export interface LifeProviderSubscription {
  recordKind: 'subscription'
  providerSubscriptionId: string
  serviceLabel: string
  planLabel: string
  recurringCost: LifeMoney
  renewalAt: string
  cancellationDeadline: string | null
  state: LifeSubscriptionState
  observedAt: string
  sourceDigest: string
}

export type LifeProviderRecord =
  | LifeProviderCommitment
  | LifeProviderContact
  | LifeProviderOption
  | LifeProviderSubscription

export interface LifeProviderPage {
  schemaVersion: 1
  operation: 'list_commitments' | 'list_contacts' | 'list_options' | 'list_subscriptions'
  sourceKind: LifeSourceKind
  records: LifeProviderRecord[]
  nextCursor: string | null
  observedAt: string
}

export interface LifeProviderCalendarResult {
  schemaVersion: 1
  operation: 'create_calendar_hold' | 'lookup_calendar_hold' | 'cancel_calendar_hold'
    | 'lookup_calendar_cancellation'
  providerRequestId: string
  providerHoldId: string | null
  status: 'not_found' | 'confirmed' | 'cancelled'
  receiptDigest: string | null
}

export interface LifeProviderSubscriptionCancellationResult {
  schemaVersion: 1
  operation: 'cancel_subscription' | 'lookup_subscription_cancellation'
  providerRequestId: string
  providerSubscriptionId: string
  status: 'not_found' | 'cancelled' | 'rejected'
  providerReceiptId: string | null
  receiptDigest: string | null
}

export class LifeProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly uncertain: boolean,
    readonly waitingUser: boolean,
  ) {
    super(code)
    this.name = 'LifeProviderError'
  }
}

export interface LifeSourceAdapter {
  readonly sourceKind: LifeSourceKind
  readonly transport: 'virtual' | 'external'
  listPage(input: { cursor: string | null; limit: number }): Promise<LifeProviderPage>
}

export interface LifeCalendarAdapter extends LifeSourceAdapter {
  readonly sourceKind: 'calendar'
  createCalendarHold(input: {
    providerRequestId: string
    planDigest: string
    optionId: string
    window: LifeTimeWindow
  }): Promise<LifeProviderCalendarResult>
  lookupCalendarHold(input: { providerRequestId: string }): Promise<LifeProviderCalendarResult>
  cancelCalendarHold(input: {
    providerRequestId: string
    providerHoldId: string
    reasonCode: string
  }): Promise<LifeProviderCalendarResult>
  lookupCalendarCancellation(input: {
    providerRequestId: string
    providerHoldId: string
  }): Promise<LifeProviderCalendarResult>
}

export interface LifeSubscriptionAdapter extends LifeSourceAdapter {
  readonly sourceKind: 'subscriptions'
  cancelSubscription(input: {
    providerRequestId: string
    providerSubscriptionId: string
    reasonCode: string
  }): Promise<LifeProviderSubscriptionCancellationResult>
  lookupSubscriptionCancellation(input: {
    providerRequestId: string
    providerSubscriptionId: string
  }): Promise<LifeProviderSubscriptionCancellationResult>
}

export type VirtualLifeCatalogRecord =
  | (Omit<LifeProviderCommitment, 'observedAt' | 'expiresAt' | 'sourceDigest'> & { validForMinutes: number })
  | Omit<LifeProviderContact, 'observedAt' | 'sourceDigest'>
  | (Omit<LifeProviderOption, 'observedAt' | 'expiresAt' | 'sourceDigest'> & { validForMinutes: number })
  | Omit<LifeProviderSubscription, 'observedAt' | 'sourceDigest'>

interface VirtualWriteRecord<T> { requestDigest: string; result: T }

const PAGE_OPERATIONS: Record<LifeSourceKind, LifeProviderPage['operation']> = {
  calendar: 'list_commitments',
  contacts: 'list_contacts',
  travel: 'list_options',
  music: 'list_options',
  games: 'list_options',
  subscriptions: 'list_subscriptions',
}

export class VirtualLifeSourceProvider implements LifeSourceAdapter {
  readonly sourceKind: LifeSourceKind
  readonly transport = 'virtual' as const
  private records: VirtualLifeCatalogRecord[]
  private readonly now: () => Date
  private readonly faults = new Map<LifeProviderOperation, VirtualLifeProviderFault>()
  private readonly calendarHolds = new Map<string, VirtualWriteRecord<LifeProviderCalendarResult>>()
  private readonly calendarHoldsById = new Map<string, LifeProviderCalendarResult>()
  private readonly calendarCancellations = new Map<string, VirtualWriteRecord<LifeProviderCalendarResult>>()
  private readonly subscriptionCancellations = new Map<
  string, VirtualWriteRecord<LifeProviderSubscriptionCancellationResult>>()

  constructor(options: { sourceKind: LifeSourceKind; records: VirtualLifeCatalogRecord[]; clock?: () => Date }) {
    if (!isLifeSourceKind(options.sourceKind) || !Array.isArray(options.records) || options.records.length > 100) {
      throw providerConfigurationError()
    }
    this.sourceKind = options.sourceKind
    this.records = normalizeCatalog(options.sourceKind, options.records)
    this.now = options.clock ?? (() => new Date())
  }

  replaceRecords(records: VirtualLifeCatalogRecord[]): void {
    if (!Array.isArray(records) || records.length > 100) throw providerInputError()
    this.records = normalizeCatalog(this.sourceKind, records)
  }

  injectFault(operation: LifeProviderOperation, fault: VirtualLifeProviderFault): void {
    if (!isOperationForSource(this.sourceKind, operation)) throw providerInputError()
    this.faults.set(operation, fault)
  }

  async listPage(input: { cursor: string | null; limit: number }): Promise<LifeProviderPage> {
    const operation = PAGE_OPERATIONS[this.sourceKind]
    this.before(operation)
    const offset = parseCursor(input.cursor)
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20 || offset > this.records.length) {
      throw providerInputError()
    }
    const observedAt = this.timestamp()
    const records = this.records.slice(offset, offset + input.limit).map(record => materialize(record, observedAt))
    const nextOffset = offset + records.length
    const result: LifeProviderPage = { schemaVersion: 1, operation, sourceKind: this.sourceKind,
      records, nextCursor: nextOffset < this.records.length ? `offset-${nextOffset}` : null, observedAt }
    return this.finish(operation, result)
  }

  async createCalendarHold(input: {
    providerRequestId: string; planDigest: string; optionId: string; window: LifeTimeWindow
  }): Promise<LifeProviderCalendarResult> {
    this.requireSource('calendar')
    validateRequestId(input.providerRequestId)
    if (!isLifeDigest(input.planDigest) || !isLifeSemanticId(input.optionId)) throw providerInputError()
    const window = parseProviderWindow(input.window)
    const requestDigest = lifeCanonicalDigest({ optionId: input.optionId, planDigest: input.planDigest, window })
    const replay = replayRecord(this.calendarHolds, input.providerRequestId, requestDigest)
    if (replay) return replay.result
    this.before('create_calendar_hold')
    const providerHoldId = `vh-${hash(`${this.sourceKind}:${input.providerRequestId}`).slice(0, 24)}`
    const material = { providerRequestId: input.providerRequestId, providerHoldId, status: 'confirmed' as const }
    const result: LifeProviderCalendarResult = { schemaVersion: 1, operation: 'create_calendar_hold', ...material,
      receiptDigest: lifeCanonicalDigest(material) }
    this.calendarHolds.set(input.providerRequestId, { requestDigest, result })
    this.calendarHoldsById.set(providerHoldId, result)
    return this.finish('create_calendar_hold', result)
  }

  async lookupCalendarHold(input: { providerRequestId: string }): Promise<LifeProviderCalendarResult> {
    this.requireSource('calendar'); validateRequestId(input.providerRequestId)
    this.before('lookup_calendar_hold')
    const found = this.calendarHolds.get(input.providerRequestId)?.result
    const result: LifeProviderCalendarResult = found
      ? { ...found, operation: 'lookup_calendar_hold' }
      : calendarNotFound('lookup_calendar_hold', input.providerRequestId)
    return this.finish('lookup_calendar_hold', result)
  }

  async cancelCalendarHold(input: {
    providerRequestId: string; providerHoldId: string; reasonCode: string
  }): Promise<LifeProviderCalendarResult> {
    this.requireSource('calendar'); validateRequestId(input.providerRequestId)
    if (!isLifeSemanticId(input.providerHoldId) || !isLifeErrorCode(input.reasonCode)) throw providerInputError()
    const requestDigest = lifeCanonicalDigest(input)
    const replay = replayRecord(this.calendarCancellations, input.providerRequestId, requestDigest)
    if (replay) return replay.result
    this.before('cancel_calendar_hold')
    const existing = this.calendarHoldsById.get(input.providerHoldId)
    const status = existing ? 'cancelled' as const : 'not_found' as const
    const material = { providerRequestId: input.providerRequestId,
      providerHoldId: existing ? input.providerHoldId : null, status }
    const result: LifeProviderCalendarResult = { schemaVersion: 1, operation: 'cancel_calendar_hold', ...material,
      receiptDigest: existing ? lifeCanonicalDigest(material) : null }
    this.calendarCancellations.set(input.providerRequestId, { requestDigest, result })
    return this.finish('cancel_calendar_hold', result)
  }

  async lookupCalendarCancellation(input: {
    providerRequestId: string; providerHoldId: string
  }): Promise<LifeProviderCalendarResult> {
    this.requireSource('calendar'); validateRequestId(input.providerRequestId)
    if (!isLifeSemanticId(input.providerHoldId)) throw providerInputError()
    this.before('lookup_calendar_cancellation')
    const found = this.calendarCancellations.get(input.providerRequestId)?.result
    if (found?.providerHoldId && found.providerHoldId !== input.providerHoldId) throw replayMismatch()
    const result: LifeProviderCalendarResult = found
      ? { ...found, operation: 'lookup_calendar_cancellation' }
      : calendarNotFound('lookup_calendar_cancellation', input.providerRequestId)
    return this.finish('lookup_calendar_cancellation', result)
  }

  async cancelSubscription(input: {
    providerRequestId: string; providerSubscriptionId: string; reasonCode: string
  }): Promise<LifeProviderSubscriptionCancellationResult> {
    this.requireSource('subscriptions'); validateRequestId(input.providerRequestId)
    if (!isLifeSemanticId(input.providerSubscriptionId) || !isLifeErrorCode(input.reasonCode)) throw providerInputError()
    const requestDigest = lifeCanonicalDigest(input)
    const replay = replayRecord(this.subscriptionCancellations, input.providerRequestId, requestDigest)
    if (replay) return replay.result
    this.before('cancel_subscription')
    const eligible = this.records.some(record => record.recordKind === 'subscription'
      && record.providerSubscriptionId === input.providerSubscriptionId
      && ['active', 'trial', 'paused', 'cancel_pending'].includes(record.state))
    const providerReceiptId = eligible ? `vs-${hash(input.providerRequestId).slice(0, 24)}` : null
    const material = { providerRequestId: input.providerRequestId,
      providerSubscriptionId: input.providerSubscriptionId, status: eligible ? 'cancelled' as const : 'rejected' as const,
      providerReceiptId }
    const result: LifeProviderSubscriptionCancellationResult = { schemaVersion: 1,
      operation: 'cancel_subscription', ...material, receiptDigest: eligible ? lifeCanonicalDigest(material) : null }
    this.subscriptionCancellations.set(input.providerRequestId, { requestDigest, result })
    return this.finish('cancel_subscription', result)
  }

  async lookupSubscriptionCancellation(input: {
    providerRequestId: string; providerSubscriptionId: string
  }): Promise<LifeProviderSubscriptionCancellationResult> {
    this.requireSource('subscriptions'); validateRequestId(input.providerRequestId)
    if (!isLifeSemanticId(input.providerSubscriptionId)) throw providerInputError()
    this.before('lookup_subscription_cancellation')
    const found = this.subscriptionCancellations.get(input.providerRequestId)?.result
    if (found && found.providerSubscriptionId !== input.providerSubscriptionId) throw replayMismatch()
    const result: LifeProviderSubscriptionCancellationResult = found
      ? { ...found, operation: 'lookup_subscription_cancellation' }
      : { schemaVersion: 1, operation: 'lookup_subscription_cancellation',
        providerRequestId: input.providerRequestId, providerSubscriptionId: input.providerSubscriptionId,
        status: 'not_found', providerReceiptId: null, receiptDigest: null }
    return this.finish('lookup_subscription_cancellation', result)
  }

  private requireSource(sourceKind: 'calendar' | 'subscriptions'): void {
    if (this.sourceKind !== sourceKind) throw new LifeProviderError('LIFE_PROVIDER_SOURCE_MISMATCH', false, false, false)
  }

  private before(operation: LifeProviderOperation): void {
    const fault = this.faults.get(operation)
    if (fault !== 'timeout_before_effect') return
    this.faults.delete(operation)
    throw new LifeProviderError('LIFE_PROVIDER_TIMEOUT', true, false, false)
  }

  private finish<T>(operation: LifeProviderOperation, result: T): T {
    const fault = this.faults.get(operation)
    if (fault === 'malformed_result') {
      this.faults.delete(operation)
      assertLifeProviderResult(operation, { schemaVersion: 1, operation, result, accessToken: 'forbidden' })
    }
    assertLifeProviderResult(operation, result)
    if (fault === 'effect_before_timeout') {
      this.faults.delete(operation)
      throw new LifeProviderError('LIFE_PROVIDER_RESULT_UNKNOWN', true, true, false)
    }
    return result
  }

  private timestamp(): string {
    const value = this.now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new LifeProviderError('LIFE_PROVIDER_CLOCK_INVALID', false, false, false)
    }
    return value.toISOString()
  }
}

export function assertLifeProviderResult(operation: LifeProviderOperation, value: unknown): void {
  try { assertLifeSafeData(value) } catch (error) {
    if (error instanceof LifeContractError) throw new LifeProviderError(error.code, false, false, false)
    throw error
  }
  if (!plainRecord(value) || value.schemaVersion !== 1 || value.operation !== operation) throw providerResponseError()
  if (operation.startsWith('list_')) validatePageResult(operation, value)
  else if (operation.includes('subscription')) validateSubscriptionCancellationResult(operation, value)
  else validateCalendarResult(operation, value)
}

function normalizeCatalog(sourceKind: LifeSourceKind, records: VirtualLifeCatalogRecord[]): VirtualLifeCatalogRecord[] {
  const identities = new Set<string>()
  return records.map(record => {
    validateCatalogRecord(sourceKind, record)
    const id = recordIdentity(record)
    if (identities.has(id)) throw providerConfigurationError()
    identities.add(id)
    return structuredClone(record)
  }).sort((left, right) => compare(recordIdentity(left), recordIdentity(right)))
}

function validateCatalogRecord(sourceKind: LifeSourceKind, record: VirtualLifeCatalogRecord): void {
  if (!plainRecord(record) || !recordMatchesSource(sourceKind, record)) throw providerConfigurationError()
  switch (record.recordKind) {
    case 'commitment':
      if (!isLifeSemanticId(record.providerItemId) || !cleanText(record.label, 300)
        || !['work', 'personal', 'health', 'travel', 'leisure', 'other'].includes(record.category)
        || typeof record.allDay !== 'boolean' || typeof record.busy !== 'boolean'
        || !validLocation(record.locationClass) || !validIds(record.participantProviderContactIds)
        || !validTtl(record.validForMinutes)) throw providerConfigurationError()
      parseProviderWindow({ startsAt: record.startsAt, endsAt: record.endsAt })
      break
    case 'contact':
      if (!isLifeSemanticId(record.providerContactId) || !cleanText(record.alias, 160)
        || !validTags(record.relationshipTags) || !validTags(record.availabilityTags)) throw providerConfigurationError()
      break
    case 'option':
      if (!isLifeSemanticId(record.providerItemId) || !isLifeOptionKind(record.kind)
        || !cleanText(record.source, 80) || !cleanText(record.title, 500) || !validTags(record.categoryTags)
        || !Number.isSafeInteger(record.durationMinutes) || record.durationMinutes < 1 || record.durationMinutes > 10_080
        || !['low', 'medium', 'high'].includes(record.exertion) || typeof record.screenBased !== 'boolean'
        || !validLocation(record.locationClass) || record.cost !== null && !validMoney(record.cost)
        || typeof record.available !== 'boolean' || !validTtl(record.validForMinutes)) throw providerConfigurationError()
      break
    case 'subscription':
      if (!isLifeSemanticId(record.providerSubscriptionId) || !cleanText(record.serviceLabel, 200)
        || !cleanText(record.planLabel, 200) || !validMoney(record.recurringCost)
        || !validTimestamp(record.renewalAt) || record.cancellationDeadline !== null
          && !validTimestamp(record.cancellationDeadline)
        || !['active', 'trial', 'paused', 'cancel_pending', 'cancelled', 'expired'].includes(record.state)) {
        throw providerConfigurationError()
      }
  }
  try { assertLifeSafeData(record) } catch { throw providerConfigurationError() }
}

function materialize(record: VirtualLifeCatalogRecord, observedAt: string): LifeProviderRecord {
  if (record.recordKind === 'commitment') {
    const { validForMinutes, ...material } = record
    const expiresAt = addMinutes(observedAt, validForMinutes)
    return { ...material, observedAt, expiresAt,
      sourceDigest: lifeCanonicalDigest({ ...material, observedAt, expiresAt }) }
  }
  if (record.recordKind === 'option') {
    const { validForMinutes, ...material } = record
    const expiresAt = addMinutes(observedAt, validForMinutes)
    return { ...material, observedAt, expiresAt,
      sourceDigest: lifeCanonicalDigest({ ...material, observedAt, expiresAt }) }
  }
  return { ...record, observedAt, sourceDigest: lifeCanonicalDigest({ ...record, observedAt }) }
}

function validatePageResult(operation: LifeProviderOperation, value: Record<string, unknown>): void {
  if (!isLifeSourceKind(value.sourceKind)) throw providerResponseError()
  const sourceKind = value.sourceKind
  if (!exactKeys(value, ['schemaVersion', 'operation', 'sourceKind', 'records', 'nextCursor', 'observedAt'])
    || PAGE_OPERATIONS[sourceKind] !== operation
    || !Array.isArray(value.records) || value.records.length > 20 || !validTimestamp(value.observedAt)
    || value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !/^offset-[1-9][0-9]*$/.test(value.nextCursor))) {
    throw providerResponseError()
  }
  for (const record of value.records) validateProviderRecord(sourceKind, record)
}

function validateProviderRecord(sourceKind: LifeSourceKind, value: unknown): void {
  if (!plainRecord(value) || !recordMatchesSource(sourceKind, value as unknown as VirtualLifeCatalogRecord)
    || !isLifeDigest(value.sourceDigest) || !validTimestamp(value.observedAt)) throw providerResponseError()
  switch (value.recordKind) {
    case 'commitment':
      if (!exactKeys(value, ['recordKind', 'providerItemId', 'label', 'category', 'startsAt', 'endsAt',
        'allDay', 'busy', 'locationClass', 'participantProviderContactIds', 'observedAt', 'expiresAt', 'sourceDigest'])
        || !isLifeSemanticId(value.providerItemId) || !cleanText(value.label, 300)
        || !['work', 'personal', 'health', 'travel', 'leisure', 'other'].includes(value.category as string)
        || !validWindowFields(value.startsAt, value.endsAt) || typeof value.allDay !== 'boolean'
        || typeof value.busy !== 'boolean' || !validLocation(value.locationClass)
        || !validIds(value.participantProviderContactIds) || !validExpiry(value.observedAt, value.expiresAt)) {
        throw providerResponseError()
      }
      break
    case 'contact':
      if (!exactKeys(value, ['recordKind', 'providerContactId', 'alias', 'relationshipTags',
        'availabilityTags', 'observedAt', 'sourceDigest']) || !isLifeSemanticId(value.providerContactId)
        || !cleanText(value.alias, 160) || !validTags(value.relationshipTags)
        || !validTags(value.availabilityTags)) throw providerResponseError()
      break
    case 'option':
      if (!exactKeys(value, ['recordKind', 'providerItemId', 'kind', 'source', 'title', 'categoryTags',
        'durationMinutes', 'exertion', 'screenBased', 'locationClass', 'cost', 'available', 'observedAt',
        'expiresAt', 'sourceDigest']) || !isLifeSemanticId(value.providerItemId) || !isLifeOptionKind(value.kind)
        || !cleanText(value.source, 80) || !cleanText(value.title, 500) || !validTags(value.categoryTags)
        || !Number.isSafeInteger(value.durationMinutes) || Number(value.durationMinutes) < 1
        || Number(value.durationMinutes) > 10_080 || !['low', 'medium', 'high'].includes(value.exertion as string)
        || typeof value.screenBased !== 'boolean' || !validLocation(value.locationClass)
        || value.cost !== null && !validMoney(value.cost) || typeof value.available !== 'boolean'
        || !validExpiry(value.observedAt, value.expiresAt)) throw providerResponseError()
      break
    case 'subscription':
      if (!exactKeys(value, ['recordKind', 'providerSubscriptionId', 'serviceLabel', 'planLabel',
        'recurringCost', 'renewalAt', 'cancellationDeadline', 'state', 'observedAt', 'sourceDigest'])
        || !isLifeSemanticId(value.providerSubscriptionId) || !cleanText(value.serviceLabel, 200)
        || !cleanText(value.planLabel, 200) || !validMoney(value.recurringCost) || !validTimestamp(value.renewalAt)
        || value.cancellationDeadline !== null && !validTimestamp(value.cancellationDeadline)
        || !['active', 'trial', 'paused', 'cancel_pending', 'cancelled', 'expired'].includes(value.state as string)) {
        throw providerResponseError()
      }
  }
}

function validateCalendarResult(operation: LifeProviderOperation, value: Record<string, unknown>): void {
  if (!exactKeys(value, ['schemaVersion', 'operation', 'providerRequestId', 'providerHoldId', 'status', 'receiptDigest'])
    || !validRequestId(value.providerRequestId) || value.providerHoldId !== null && !isLifeSemanticId(value.providerHoldId)
    || !['not_found', 'confirmed', 'cancelled'].includes(value.status as string)
    || value.receiptDigest !== null && !isLifeDigest(value.receiptDigest)
    || value.status === 'not_found' && (value.providerHoldId !== null || value.receiptDigest !== null)
    || value.status !== 'not_found' && (value.providerHoldId === null || value.receiptDigest === null)) {
    throw providerResponseError()
  }
}

function validateSubscriptionCancellationResult(operation: LifeProviderOperation, value: Record<string, unknown>): void {
  if (!exactKeys(value, ['schemaVersion', 'operation', 'providerRequestId', 'providerSubscriptionId', 'status',
    'providerReceiptId', 'receiptDigest']) || !validRequestId(value.providerRequestId)
    || !isLifeSemanticId(value.providerSubscriptionId) || !['not_found', 'cancelled', 'rejected'].includes(value.status as string)
    || value.providerReceiptId !== null && !isLifeSemanticId(value.providerReceiptId)
    || value.receiptDigest !== null && !isLifeDigest(value.receiptDigest)
    || value.status === 'cancelled' && (value.providerReceiptId === null || value.receiptDigest === null)
    || value.status !== 'cancelled' && (value.providerReceiptId !== null || value.receiptDigest !== null)) {
    throw providerResponseError()
  }
}

function recordMatchesSource(sourceKind: LifeSourceKind, record: VirtualLifeCatalogRecord): boolean {
  return sourceKind === 'calendar' ? record.recordKind === 'commitment'
    : sourceKind === 'contacts' ? record.recordKind === 'contact'
      : sourceKind === 'subscriptions' ? record.recordKind === 'subscription'
        : record.recordKind === 'option' && record.kind === (
          sourceKind === 'travel' ? 'travel' : sourceKind === 'music' ? 'music' : 'game')
}

function recordIdentity(record: VirtualLifeCatalogRecord): string {
  return record.recordKind === 'contact' ? record.providerContactId
    : record.recordKind === 'subscription' ? record.providerSubscriptionId : record.providerItemId
}

function replayRecord<T>(records: Map<string, VirtualWriteRecord<T>>, requestId: string,
  requestDigest: string): VirtualWriteRecord<T> | null {
  const record = records.get(requestId)
  if (!record) return null
  if (record.requestDigest !== requestDigest) throw replayMismatch()
  return record
}

function calendarNotFound(operation: 'lookup_calendar_hold' | 'lookup_calendar_cancellation',
  providerRequestId: string): LifeProviderCalendarResult {
  return { schemaVersion: 1, operation, providerRequestId, providerHoldId: null,
    status: 'not_found', receiptDigest: null }
}

function isOperationForSource(sourceKind: LifeSourceKind, operation: LifeProviderOperation): boolean {
  return operation === PAGE_OPERATIONS[sourceKind]
    || sourceKind === 'calendar' && ['create_calendar_hold', 'lookup_calendar_hold',
      'cancel_calendar_hold', 'lookup_calendar_cancellation'].includes(operation)
    || sourceKind === 'subscriptions' && ['cancel_subscription', 'lookup_subscription_cancellation'].includes(operation)
}

function parseCursor(value: string | null): number {
  if (value === null) return 0
  if (typeof value !== 'string' || !/^offset-(0|[1-9][0-9]*)$/.test(value)) throw providerInputError()
  const offset = Number(value.slice(7))
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100) throw providerInputError()
  return offset
}

function parseProviderWindow(value: LifeTimeWindow): LifeTimeWindow {
  try { return parseLifeTimeWindow(value) } catch { throw providerInputError() }
}

function validateRequestId(value: unknown): asserts value is string {
  if (!validRequestId(value)) throw providerInputError()
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(value)
}

function validIds(values: unknown): values is string[] {
  return Array.isArray(values) && values.length <= 64 && values.every(isLifeSemanticId)
    && new Set(values).size === values.length
}

function validTags(values: unknown): values is string[] {
  return Array.isArray(values) && values.length <= 64 && values.every(value => typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value)) && new Set(values).size === values.length
}

function validLocation(value: unknown): value is LifeLocationClass {
  return typeof value === 'string' && ['remote', 'home', 'local', 'out_of_area', 'unknown'].includes(value)
}

function validMoney(value: unknown): value is LifeMoney {
  return plainRecord(value) && exactKeys(value, ['currency', 'amountMinor']) && isLifeCurrency(value.currency)
    && Number.isSafeInteger(value.amountMinor) && Number(value.amountMinor) >= 0
}

function validTtl(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 525_600
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function validWindowFields(startsAt: unknown, endsAt: unknown): boolean {
  return validTimestamp(startsAt) && validTimestamp(endsAt) && Date.parse(endsAt) > Date.parse(startsAt)
    && Date.parse(endsAt) - Date.parse(startsAt) <= 366 * 24 * 60 * 60_000
}

function validExpiry(observedAt: unknown, expiresAt: unknown): boolean {
  return validTimestamp(observedAt) && validTimestamp(expiresAt) && Date.parse(expiresAt) > Date.parse(observedAt)
}

function addMinutes(timestamp: string, minutes: number): string {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString()
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort(compare); const wanted = [...expected].sort(compare)
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function cleanText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function providerInputError(): LifeProviderError {
  return new LifeProviderError('LIFE_PROVIDER_INPUT_INVALID', false, false, false)
}
function providerConfigurationError(): LifeProviderError {
  return new LifeProviderError('LIFE_PROVIDER_CONFIGURATION_INVALID', false, false, false)
}
function providerResponseError(): LifeProviderError {
  return new LifeProviderError('LIFE_PROVIDER_RESPONSE_INVALID', false, false, false)
}
function replayMismatch(): LifeProviderError {
  return new LifeProviderError('LIFE_PROVIDER_REQUEST_REPLAY_MISMATCH', false, false, false)
}

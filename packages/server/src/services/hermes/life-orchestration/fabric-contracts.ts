import { isProxy } from 'node:util/types'
import type { FabricCapabilityInput } from '../action-fabric/registry'
import type { FabricJsonObject } from '../action-fabric/types'
import {
  isLifeCurrency,
  isLifeDigest,
  isLifeErrorCode,
  isLifeSemanticId,
  isLifeSourceKind,
} from './contracts'

export const LIFE_SOURCE_SYNC_CAPABILITY = 'life.source.sync'
export const LIFE_PLAN_VERIFY_CAPABILITY = 'life.plan.verify'
export const LIFE_CALENDAR_HOLD_CREATE_CAPABILITY = 'life.calendar.hold.create'
export const LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY = 'life.calendar.hold.cancel'
export const LIFE_SUBSCRIPTION_CANCEL_CAPABILITY = 'life.subscription.cancel'

export const LIFE_CAPABILITY_IDS = [
  LIFE_SOURCE_SYNC_CAPABILITY,
  LIFE_PLAN_VERIFY_CAPABILITY,
  LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
  LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY,
  LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
] as const

const CAPABILITIES = new Set<string>(LIFE_CAPABILITY_IDS)
const idSchema = { type: 'string', minLength: 1, maxLength: 200,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' }
const requestIdSchema = { type: 'string', minLength: 8, maxLength: 200,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' }
const digestSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const currencySchema = { type: 'string', pattern: '^[A-Z]{3}$' }
const timestampSchema = { type: 'string', format: 'date-time', maxLength: 64 }
const positiveVersionSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const sourceKindSchema = { enum: ['calendar', 'contacts', 'travel', 'music', 'games', 'subscriptions'] }

function objectSchema(properties: Record<string, unknown>, required: string[]): FabricJsonObject {
  return { type: 'object', additionalProperties: false, properties, required }
}

const base = {
  version: 1,
  idempotency: 'required' as const,
  authentication: ['life_account:configured'],
  cost: { currency: null, estimatedMinor: 0 },
  enabled: true,
}

export const LIFE_FABRIC_CAPABILITIES: FabricCapabilityInput[] = [
  {
    ...base,
    id: LIFE_SOURCE_SYNC_CAPABILITY,
    description: 'Synchronize one bounded configured life source into normalized records and Personal Twin facts',
    inputSchema: objectSchema({ schemaVersion: { const: 1 }, accountId: idSchema, sourceKind: sourceKindSchema,
      cursor: { type: ['string', 'null'], maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 20 } },
    ['schemaVersion', 'accountId', 'sourceKind', 'cursor', 'limit']),
    outputSchema: objectSchema({ schemaVersion: { const: 1 }, operation: { const: 'source_sync' },
      accountId: idSchema, sourceKind: sourceKindSchema, status: { enum: ['succeeded', 'partial'] },
      recordIds: { type: 'array', maxItems: 100, items: idSchema },
      totalCount: { type: 'integer', minimum: 0, maximum: 100 },
      nextCursor: { type: ['string', 'null'], maxLength: 200 } },
    ['schemaVersion', 'operation', 'accountId', 'sourceKind', 'status', 'recordIds', 'totalCount', 'nextCursor']),
    risk: 'low', sideEffect: true, reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'normalized_record_and_twin_fact_replay',
    targetRestrictions: ['life:account', 'life:source'],
  },
  {
    ...base,
    id: LIFE_PLAN_VERIFY_CAPABILITY,
    description: 'Verify one immutable life plan against its frozen constraint and current source material',
    inputSchema: objectSchema({ schemaVersion: { const: 1 }, planRevisionId: idSchema,
      planDigest: digestSchema, constraintSnapshotId: idSchema, constraintDigest: digestSchema,
      currency: currencySchema, activeAt: timestampSchema },
    ['schemaVersion', 'planRevisionId', 'planDigest', 'constraintSnapshotId', 'constraintDigest', 'currency', 'activeAt']),
    outputSchema: objectSchema({ schemaVersion: { const: 1 }, operation: { const: 'plan_verify' },
      planRevisionId: idSchema, planDigest: digestSchema, constraintSnapshotId: idSchema,
      constraintDigest: digestSchema, currency: currencySchema, valid: { type: 'boolean' },
      reasonCodes: { type: 'array', maxItems: 32, items: idSchema }, checkedAt: timestampSchema },
    ['schemaVersion', 'operation', 'planRevisionId', 'planDigest', 'constraintSnapshotId', 'constraintDigest',
      'currency', 'valid', 'reasonCodes', 'checkedAt']),
    risk: 'none', sideEffect: false, reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'immutable_plan_and_current_material_digest',
    targetRestrictions: ['life:plan', 'life:currency'],
  },
  {
    ...base,
    id: LIFE_CALENDAR_HOLD_CREATE_CAPABILITY,
    description: 'Create one exact reversible calendar hold bound to a current immutable plan session',
    inputSchema: calendarInputSchema({ optionId: idSchema, startsAt: timestampSchema, endsAt: timestampSchema },
      ['optionId', 'startsAt', 'endsAt']),
    outputSchema: calendarOutputSchema('calendar_hold_create'),
    risk: 'medium', sideEffect: true, reversible: true,
    compensationCapabilityId: LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY,
    verificationStrategy: 'provider_hold_lookup_before_retry_and_read_after_write',
    authentication: [...base.authentication, 'life_calendar:write'],
    targetRestrictions: ['life:account', 'life:calendar', 'life:plan', 'life:currency'],
  },
  {
    ...base,
    id: LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY,
    description: 'Cancel one exact calendar hold and verify the provider cancellation receipt',
    inputSchema: calendarInputSchema({ holdId: idSchema, expectedVersion: positiveVersionSchema,
      providerHoldId: idSchema, reasonCode: idSchema }, ['holdId', 'expectedVersion', 'providerHoldId', 'reasonCode']),
    outputSchema: calendarOutputSchema('calendar_hold_cancel'),
    risk: 'medium', sideEffect: true, reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'provider_cancellation_lookup_before_retry_and_read_after_write',
    authentication: [...base.authentication, 'life_calendar:write'],
    targetRestrictions: ['life:account', 'life:calendar', 'life:plan', 'life:currency'],
  },
  {
    ...base,
    id: LIFE_SUBSCRIPTION_CANCEL_CAPABILITY,
    description: 'Cancel one exact eligible subscription after per-action approval and verify its receipt',
    inputSchema: objectSchema({ schemaVersion: { const: 1 }, accountId: idSchema, subscriptionId: idSchema,
      subscriptionDigest: digestSchema, providerRequestId: requestIdSchema, reasonCode: idSchema,
      currency: currencySchema },
    ['schemaVersion', 'accountId', 'subscriptionId', 'subscriptionDigest', 'providerRequestId', 'reasonCode', 'currency']),
    outputSchema: objectSchema({ schemaVersion: { const: 1 }, operation: { const: 'subscription_cancel' },
      accountId: idSchema, subscriptionId: idSchema, subscriptionDigest: digestSchema,
      cancellationId: idSchema, providerRequestId: requestIdSchema,
      providerReceiptId: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
      receiptDigest: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' },
      currency: currencySchema,
      state: { enum: ['requested', 'submitting', 'processing', 'cancelled', 'rejected',
        'lookup_required', 'waiting_user', 'failed'] } },
    ['schemaVersion', 'operation', 'accountId', 'subscriptionId', 'subscriptionDigest', 'cancellationId',
      'providerRequestId', 'providerReceiptId', 'receiptDigest', 'currency', 'state']),
    risk: 'high', sideEffect: true, reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'provider_subscription_lookup_before_retry_and_receipt_verification',
    authentication: [...base.authentication, 'life_subscription:fresh_exact_approval'],
    targetRestrictions: ['life:account', 'life:subscription', 'life:currency'],
  },
]

export function isLifeFabricCapability(capabilityId: string): boolean {
  return CAPABILITIES.has(capabilityId)
}

export function validateLifeFabricSemantics(capabilityId: string, input: FabricJsonObject): boolean {
  if (!isLifeFabricCapability(capabilityId) || !plainRecord(input)) return false
  const expected = expectedInputKeys(capabilityId)
  if (!expected || !exactKeys(input, expected) || value(input, 'schemaVersion') !== 1) return false
  for (const key of expected.filter(key => key.endsWith('Id') && key !== 'providerRequestId')) {
    if (!isLifeSemanticId(value(input, key))) return false
  }
  for (const key of expected.filter(key => key.endsWith('Digest'))) {
    if (!isLifeDigest(value(input, key))) return false
  }
  if (expected.includes('currency') && !isLifeCurrency(value(input, 'currency'))) return false
  if (expected.includes('providerRequestId') && !validRequestId(value(input, 'providerRequestId'))) return false
  if (expected.includes('reasonCode') && !isLifeErrorCode(value(input, 'reasonCode'))) return false
  if (capabilityId === LIFE_SOURCE_SYNC_CAPABILITY) {
    const cursor = value(input, 'cursor'); const limit = value(input, 'limit')
    return isLifeSourceKind(value(input, 'sourceKind'))
      && (cursor === null || typeof cursor === 'string' && /^offset-(0|[1-9][0-9]*)$/.test(cursor))
      && Number.isSafeInteger(limit) && Number(limit) >= 1 && Number(limit) <= 20
  }
  if (capabilityId === LIFE_PLAN_VERIFY_CAPABILITY) return validTimestamp(value(input, 'activeAt'))
  if (capabilityId === LIFE_CALENDAR_HOLD_CREATE_CAPABILITY) {
    return validWindow(value(input, 'startsAt'), value(input, 'endsAt'))
  }
  if (capabilityId === LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY) {
    return Number.isSafeInteger(value(input, 'expectedVersion')) && Number(value(input, 'expectedVersion')) >= 1
  }
  return true
}

export function lifeTargetAtoms(capabilityId: string, target: FabricJsonObject,
  input: FabricJsonObject): string[] | null {
  if (!validateLifeFabricSemantics(capabilityId, input) || !plainRecord(target)) return null
  if (capabilityId === LIFE_SOURCE_SYNC_CAPABILITY) {
    if (!exactKeys(target, ['accountId', 'kind', 'sourceKind']) || value(target, 'kind') !== 'life_source'
      || value(target, 'accountId') !== value(input, 'accountId')
      || value(target, 'sourceKind') !== value(input, 'sourceKind')) return null
    return [`life:account:${String(value(input, 'accountId'))}`, `life:source:${String(value(input, 'sourceKind'))}`]
  }
  if (capabilityId === LIFE_PLAN_VERIFY_CAPABILITY) {
    if (!exactKeys(target, ['currency', 'kind', 'planDigest']) || value(target, 'kind') !== 'life_plan'
      || value(target, 'planDigest') !== value(input, 'planDigest')
      || value(target, 'currency') !== value(input, 'currency')) return null
    return [`life:plan:${String(value(input, 'planDigest'))}`, `life:currency:${String(value(input, 'currency'))}`]
  }
  if (capabilityId === LIFE_CALENDAR_HOLD_CREATE_CAPABILITY
    || capabilityId === LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY) {
    if (!exactKeys(target, ['accountId', 'calendarId', 'currency', 'kind', 'planDigest'])
      || value(target, 'kind') !== 'life_calendar' || value(target, 'accountId') !== value(input, 'accountId')
      || value(target, 'calendarId') !== value(input, 'accountId')
      || value(target, 'planDigest') !== value(input, 'planDigest')
      || value(target, 'currency') !== value(input, 'currency')) return null
    return [`life:account:${String(value(input, 'accountId'))}`,
      `life:calendar:${String(value(target, 'calendarId'))}`,
      `life:plan:${String(value(input, 'planDigest'))}`,
      `life:currency:${String(value(input, 'currency'))}`]
  }
  if (!exactKeys(target, ['accountId', 'currency', 'kind', 'subscriptionId'])
    || value(target, 'kind') !== 'life_subscription' || value(target, 'accountId') !== value(input, 'accountId')
    || value(target, 'subscriptionId') !== value(input, 'subscriptionId')
    || value(target, 'currency') !== value(input, 'currency')) return null
  return [`life:account:${String(value(input, 'accountId'))}`,
    `life:subscription:${String(value(input, 'subscriptionId'))}`,
    `life:currency:${String(value(input, 'currency'))}`]
}

export function validateLifeFabricOutput(capabilityId: string, input: FabricJsonObject,
  output: FabricJsonObject): boolean {
  if (!isLifeFabricCapability(capabilityId)) return true
  if (!validateLifeFabricSemantics(capabilityId, input) || !plainRecord(output)
    || value(output, 'schemaVersion') !== 1) return false
  const expectedOperation: Record<string, string> = {
    [LIFE_SOURCE_SYNC_CAPABILITY]: 'source_sync',
    [LIFE_PLAN_VERIFY_CAPABILITY]: 'plan_verify',
    [LIFE_CALENDAR_HOLD_CREATE_CAPABILITY]: 'calendar_hold_create',
    [LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY]: 'calendar_hold_cancel',
    [LIFE_SUBSCRIPTION_CANCEL_CAPABILITY]: 'subscription_cancel',
  }
  if (value(output, 'operation') !== expectedOperation[capabilityId]) return false
  for (const key of ['accountId', 'sourceKind', 'planRevisionId', 'planDigest', 'constraintSnapshotId',
    'constraintDigest', 'optionId', 'providerRequestId', 'subscriptionId', 'subscriptionDigest', 'currency']) {
    if (value(input, key) !== undefined && value(output, key) !== value(input, key)) return false
  }
  const receipt = value(output, 'receiptDigest')
  const providerReceipt = value(output, 'providerReceiptId')
  if (receipt !== undefined && receipt !== null && !isLifeDigest(receipt)) return false
  if (providerReceipt !== undefined && providerReceipt !== null && !isLifeSemanticId(providerReceipt)) return false
  if (capabilityId === LIFE_PLAN_VERIFY_CAPABILITY) {
    const reasons = value(output, 'reasonCodes')
    return typeof value(output, 'valid') === 'boolean' && Array.isArray(reasons) && reasons.length <= 32
      && reasons.every(isLifeErrorCode) && Boolean(value(output, 'valid')) === (reasons.length === 0)
      && value(output, 'checkedAt') === value(input, 'activeAt')
  }
  if (capabilityId === LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY) {
    return value(output, 'holdId') === value(input, 'holdId')
      && value(output, 'providerHoldId') === value(input, 'providerHoldId')
  }
  return true
}

function calendarInputSchema(extra: Record<string, unknown>, required: string[]): FabricJsonObject {
  return objectSchema({ schemaVersion: { const: 1 }, accountId: idSchema, planRevisionId: idSchema,
    planDigest: digestSchema, providerRequestId: requestIdSchema, currency: currencySchema, ...extra },
  ['schemaVersion', 'accountId', 'planRevisionId', 'planDigest', 'providerRequestId', 'currency', ...required])
}

function calendarOutputSchema(operation: string): FabricJsonObject {
  return objectSchema({ schemaVersion: { const: 1 }, operation: { const: operation }, accountId: idSchema,
    planRevisionId: idSchema, planDigest: digestSchema, providerRequestId: requestIdSchema,
    holdId: idSchema, optionId: idSchema, providerHoldId: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
    receiptDigest: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' }, currency: currencySchema,
    state: { enum: ['requested', 'submitting', 'confirmed', 'cancel_requested', 'cancelling', 'cancelled',
      'lookup_required', 'waiting_user', 'failed'] } },
  ['schemaVersion', 'operation', 'accountId', 'planRevisionId', 'planDigest', 'providerRequestId', 'holdId',
    'optionId', 'providerHoldId', 'receiptDigest', 'currency', 'state'])
}

function expectedInputKeys(capabilityId: string): string[] | null {
  const values: Record<string, string[]> = {
    [LIFE_SOURCE_SYNC_CAPABILITY]: ['accountId', 'cursor', 'limit', 'schemaVersion', 'sourceKind'],
    [LIFE_PLAN_VERIFY_CAPABILITY]: ['activeAt', 'constraintDigest', 'constraintSnapshotId', 'currency',
      'planDigest', 'planRevisionId', 'schemaVersion'],
    [LIFE_CALENDAR_HOLD_CREATE_CAPABILITY]: ['accountId', 'currency', 'endsAt', 'optionId', 'planDigest',
      'planRevisionId', 'providerRequestId', 'schemaVersion', 'startsAt'],
    [LIFE_CALENDAR_HOLD_CANCEL_CAPABILITY]: ['accountId', 'currency', 'expectedVersion', 'holdId', 'planDigest',
      'planRevisionId', 'providerHoldId', 'providerRequestId', 'reasonCode', 'schemaVersion'],
    [LIFE_SUBSCRIPTION_CANCEL_CAPABILITY]: ['accountId', 'currency', 'providerRequestId', 'reasonCode',
      'schemaVersion', 'subscriptionDigest', 'subscriptionId'],
  }
  return values[capabilityId] ?? null
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

function value(record: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(value)
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function validWindow(startsAt: unknown, endsAt: unknown): boolean {
  return validTimestamp(startsAt) && validTimestamp(endsAt) && Date.parse(endsAt) > Date.parse(startsAt)
    && Date.parse(endsAt) - Date.parse(startsAt) <= 366 * 24 * 60 * 60_000
}

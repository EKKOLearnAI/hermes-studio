import { createHash } from 'crypto'
import {
  ensurePrimarySubject,
  getTwinEntity,
  listTwinEntities,
  listTwinRelations,
  recordTwinFactBatchWithDisposition,
  upsertTwinEntity,
  upsertTwinRelation,
  type TwinEntity,
  type TwinEvent,
  type TwinFactDisposition,
  type TwinObservation,
  type TwinRelation,
} from '../personal-twin'
import { assertLifeSafeData, isLifeDigest, isLifeSemanticId, LifeContractError } from './contracts'
import {
  assertLifeProviderResult,
  type LifeProviderPage,
  type LifeProviderRecord,
  type LifeSourceAdapter,
} from './provider'
import {
  getLifeContactAlias,
  getLifeSourceAccount,
  lifeCanonicalDigest,
  listLifeContactAliases,
  recordLifeCommitment,
  recordLifeContactAlias,
  recordLifeOption,
  recordLifeSubscription,
} from './store'
import type {
  LifeCommitment,
  LifeContactAlias,
  LifeOption,
  LifeSourceKind,
  LifeSubscription,
} from './types'

const ACTOR = 'entertainment-assistant'
const MAX_PAGES = 5
const MAX_RECORDS = 100

export type LifeObservedRecord =
  | { kind: 'commitment'; value: LifeCommitment }
  | { kind: 'contact'; value: LifeContactAlias }
  | { kind: 'option'; value: LifeOption }
  | { kind: 'subscription'; value: LifeSubscription }

export interface LifeObservationProjection {
  record: LifeObservedRecord
  entity: TwinEntity
  observation: TwinObservation
  event: TwinEvent
  disposition: TwinFactDisposition
  relations: TwinRelation[]
}

export interface LifeSourceSyncResult {
  accountId: string
  sourceKind: LifeSourceKind
  pageCount: number
  observedCount: number
  replayedCount: number
  projections: LifeObservationProjection[]
}

export interface LifeSourcePageSyncResult {
  accountId: string
  sourceKind: LifeSourceKind
  observedCount: number
  replayedCount: number
  nextCursor: string | null
  projections: LifeObservationProjection[]
}

export async function syncLifeSourcePage(input: {
  accountId: string
  adapter: LifeSourceAdapter
  cursor: string | null
  limit: number
}): Promise<LifeSourcePageSyncResult> {
  const account = getLifeSourceAccount(input.accountId)
  if (!account || !account.enabled || account.health === 'revoked' || account.sourceKind !== input.adapter.sourceKind) {
    throw new LifeContractError('LIFE_OBSERVATION_ACCOUNT_UNAVAILABLE')
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20
    || input.cursor !== null && !/^offset-(0|[1-9][0-9]*)$/.test(input.cursor)) {
    throw new LifeContractError('LIFE_OBSERVATION_BOUNDS_INVALID')
  }
  const page = await input.adapter.listPage({ cursor: input.cursor, limit: input.limit })
  assertLifeProviderResult(page.operation, page)
  validatePageForAccount(page, account.sourceKind)
  const seenRecords = new Map<string, string>()
  const projections: LifeObservationProjection[] = []
  let replayedCount = 0
  for (const providerRecord of page.records) {
    const identity = providerRecordIdentity(providerRecord)
    const previousDigest = seenRecords.get(identity)
    if (previousDigest !== undefined) {
      if (previousDigest !== providerRecord.sourceDigest) {
        throw new LifeContractError('LIFE_OBSERVATION_PROVIDER_IDENTITY_CONFLICT')
      }
      replayedCount += 1
      continue
    }
    seenRecords.set(identity, providerRecord.sourceDigest)
    projections.push(projectObservedRecord(normalizeProviderRecord(account.id, providerRecord)))
  }
  return { accountId: account.id, sourceKind: account.sourceKind, observedCount: projections.length,
    replayedCount, nextCursor: page.nextCursor, projections }
}

export async function syncLifeSource(input: {
  accountId: string
  adapter: LifeSourceAdapter
  pageSize?: number
  maxPages?: number
}): Promise<LifeSourceSyncResult> {
  const account = getLifeSourceAccount(input.accountId)
  const pageSize = input.pageSize ?? 20
  const maxPages = input.maxPages ?? MAX_PAGES
  if (!account || !account.enabled || account.health === 'revoked' || account.sourceKind !== input.adapter.sourceKind) {
    throw new LifeContractError('LIFE_OBSERVATION_ACCOUNT_UNAVAILABLE')
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 20
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
    throw new LifeContractError('LIFE_OBSERVATION_BOUNDS_INVALID')
  }
  const seenCursors = new Set<string>()
  const seenRecords = new Map<string, string>()
  const projections: LifeObservationProjection[] = []
  let cursor: string | null = null
  let pageCount = 0
  let replayedCount = 0
  do {
    if (pageCount >= maxPages || projections.length >= MAX_RECORDS) {
      throw new LifeContractError('LIFE_OBSERVATION_PAGINATION_EXHAUSTED')
    }
    const page = await input.adapter.listPage({ cursor, limit: pageSize })
    assertLifeProviderResult(page.operation, page)
    validatePageForAccount(page, account.sourceKind)
    pageCount += 1
    for (const providerRecord of page.records) {
      const identity = providerRecordIdentity(providerRecord)
      const previousDigest = seenRecords.get(identity)
      if (previousDigest) {
        if (previousDigest !== providerRecord.sourceDigest) {
          throw new LifeContractError('LIFE_OBSERVATION_PROVIDER_IDENTITY_CONFLICT')
        }
        replayedCount += 1
        continue
      }
      if (seenRecords.size >= MAX_RECORDS) throw new LifeContractError('LIFE_OBSERVATION_BOUNDS_INVALID')
      seenRecords.set(identity, providerRecord.sourceDigest)
      projections.push(projectObservedRecord(normalizeProviderRecord(account.id, providerRecord)))
    }
    cursor = page.nextCursor
    if (cursor !== null && seenCursors.has(cursor)) {
      throw new LifeContractError('LIFE_OBSERVATION_CURSOR_CYCLE')
    }
    if (cursor !== null) seenCursors.add(cursor)
  } while (cursor !== null)
  return { accountId: account.id, sourceKind: account.sourceKind, pageCount,
    observedCount: projections.length, replayedCount, projections }
}

export function importBilibiliLifeOptions(input: { limit?: number } = {}): LifeOption[] {
  const limit = input.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new LifeContractError('LIFE_OBSERVATION_BOUNDS_INVALID')
  }
  const entities = listTwinEntities({ type: 'entertainment', source: 'bilibili', limit })
  const options: LifeOption[] = []
  for (const entity of entities) {
    const attributes = entity.attributes
    if (attributes.kind !== 'video' || attributes.provider !== 'bilibili'
      || !isLifeSemanticId(attributes.bvid) || typeof attributes.title !== 'string') continue
    const observedAt = validTimestamp(attributes.discoveredAt) ? attributes.discoveredAt : entity.updatedAt
    const durationSeconds = Number(attributes.durationSeconds)
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 604_800
      || !validTimestamp(observedAt)) continue
    const title = minimizedTitle(attributes.title, attributes.bvid)
    const sourceDigest = isLifeDigest(attributes.resultDigest) ? attributes.resultDigest
      : lifeCanonicalDigest({ bvid: attributes.bvid, durationSeconds, observedAt, title })
    options.push(recordLifeOption({ accountId: null, kind: 'video', source: 'bilibili',
      providerItemId: attributes.bvid, title, categoryTags: ['video'],
      durationMinutes: Math.max(1, Math.ceil(durationSeconds / 60)), exertion: 'low', screenBased: true,
      locationClass: 'home', cost: null, available: true, observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 30 * 24 * 60 * 60_000).toISOString(), sourceDigest }))
  }
  return options.sort((left, right) => compare(left.providerItemId, right.providerItemId))
}

export function projectObservedRecord(record: LifeObservedRecord): LifeObservationProjection {
  ensurePrimarySubject()
  const material = projectionMaterial(record)
  const source = material.source
  const entity = stableTwinEntity(material.entity)
  const relations = projectRelations(record, entity, source)
  const batch = recordTwinFactBatchWithDisposition({ ensureCanonicalSelf: true, observations: [{
    entityId: entity.id,
    metric: material.metric,
    value: material.metricValue,
    unit: material.metricUnit,
    observedAt: material.observedAt,
    source,
    sourceId: `observation:${material.recordId}`,
    actor: ACTOR,
    confidence: 1,
    confirmationState: 'observed',
    evidence: [{ kind: 'life_source_record', recordId: material.recordId,
      recordKind: record.kind, sourceDigest: material.sourceDigest }],
  }], events: [{
    eventType: material.eventType,
    subjectId: 'person:self',
    payload: material.eventPayload,
    occurredAt: material.observedAt,
    source,
    sourceId: `event:${material.recordId}`,
    actor: ACTOR,
    confidence: 1,
    confirmationState: 'observed',
    evidence: [{ kind: 'life_source_record', recordId: material.recordId,
      recordKind: record.kind, sourceDigest: material.sourceDigest }],
  }] }, [{ observationIndexes: [0], eventIndexes: [0] }])
  const observation = batch.observations[0]
  const event = batch.events[0]
  const disposition = batch.eventDispositions[0]
  if (!observation || !event || !disposition) throw new Error('LIFE_OBSERVATION_PROJECTION_INCOMPLETE')
  return { record, entity, observation, event, disposition, relations }
}

function normalizeProviderRecord(accountId: string, record: LifeProviderRecord): LifeObservedRecord {
  switch (record.recordKind) {
    case 'contact':
      return { kind: 'contact', value: recordLifeContactAlias({ accountId,
        providerContactId: record.providerContactId, alias: record.alias,
        relationshipTags: record.relationshipTags, availabilityTags: record.availabilityTags,
        observedAt: record.observedAt, sourceDigest: record.sourceDigest }) }
    case 'commitment': {
      const aliases = listLifeContactAliases(undefined, 200)
      const participantAliasIds = record.participantProviderContactIds.map(providerContactId => {
        const matches = aliases.filter(alias => alias.providerContactId === providerContactId)
        if (matches.length !== 1) throw new LifeContractError('LIFE_OBSERVATION_CONTACT_UNRESOLVED')
        return matches[0]!.id
      })
      return { kind: 'commitment', value: recordLifeCommitment({ accountId,
        providerItemId: record.providerItemId, label: record.label, category: record.category,
        startsAt: record.startsAt, endsAt: record.endsAt, allDay: record.allDay, busy: record.busy,
        locationClass: record.locationClass, participantAliasIds, observedAt: record.observedAt,
        expiresAt: record.expiresAt, sourceDigest: record.sourceDigest }) }
    }
    case 'option':
      return { kind: 'option', value: recordLifeOption({ accountId, providerItemId: record.providerItemId,
        kind: record.kind, source: record.source, title: record.title, categoryTags: record.categoryTags,
        durationMinutes: record.durationMinutes, exertion: record.exertion, screenBased: record.screenBased,
        locationClass: record.locationClass, cost: record.cost, available: record.available,
        observedAt: record.observedAt, expiresAt: record.expiresAt, sourceDigest: record.sourceDigest }) }
    case 'subscription':
      return { kind: 'subscription', value: recordLifeSubscription({ accountId,
        providerSubscriptionId: record.providerSubscriptionId, serviceLabel: record.serviceLabel,
        planLabel: record.planLabel, recurringCost: record.recurringCost, renewalAt: record.renewalAt,
        cancellationDeadline: record.cancellationDeadline, state: record.state,
        observedAt: record.observedAt, sourceDigest: record.sourceDigest }) }
  }
}

function projectionMaterial(record: LifeObservedRecord): {
  source: string
  recordId: string
  sourceDigest: string
  observedAt: string
  entity: { id: string; type: string; label: string; attributes: Record<string, unknown>; source: string; sourceId: string }
  metric: string
  metricValue: unknown
  metricUnit: string | null
  eventType: string
  eventPayload: Record<string, unknown>
} {
  if (record.kind === 'contact') {
    const value = record.value
    const source = `life:${value.accountId}`
    const entityId = lifeEntityId('contact', value.accountId, value.providerContactId)
    return { source, recordId: value.id, sourceDigest: value.sourceDigest, observedAt: value.observedAt,
      entity: { id: entityId, type: 'life', label: value.alias, source, sourceId: `contact:${value.providerContactId}`,
        attributes: { schemaVersion: 1, kind: 'contact_alias', accountId: value.accountId,
          contactAliasId: value.id, alias: value.alias, relationshipTags: value.relationshipTags,
          availabilityTags: value.availabilityTags, sourceDigest: value.sourceDigest, observedAt: value.observedAt } },
      metric: 'life.contact.availability_tag_count', metricValue: value.availabilityTags.length, metricUnit: 'count',
      eventType: 'life.contact.observed', eventPayload: { schemaVersion: 1, entityId,
        contactAliasId: value.id, sourceDigest: value.sourceDigest } }
  }
  if (record.kind === 'commitment') {
    const value = record.value
    const source = `life:${value.accountId}`
    const entityId = lifeEntityId('commitment', value.accountId, value.providerItemId)
    return { source, recordId: value.id, sourceDigest: value.sourceDigest, observedAt: value.observedAt,
      entity: { id: entityId, type: 'life', label: value.label, source,
        sourceId: `commitment:${value.providerItemId}`, attributes: { schemaVersion: 1, kind: 'commitment',
          accountId: value.accountId, commitmentId: value.id, label: value.label, category: value.category,
          startsAt: value.startsAt, endsAt: value.endsAt, allDay: value.allDay, busy: value.busy,
          locationClass: value.locationClass, participantAliasIds: value.participantAliasIds,
          expiresAt: value.expiresAt, sourceDigest: value.sourceDigest, observedAt: value.observedAt } },
      metric: 'life.commitment.busy', metricValue: value.busy, metricUnit: null,
      eventType: 'life.commitment.observed', eventPayload: { schemaVersion: 1, entityId,
        commitmentId: value.id, startsAt: value.startsAt, endsAt: value.endsAt,
        busy: value.busy, sourceDigest: value.sourceDigest } }
  }
  if (record.kind === 'option') {
    const value = record.value
    const source = `life:${value.accountId ?? 'bilibili'}`
    const entityId = lifeEntityId('option', value.accountId ?? 'bilibili', value.providerItemId)
    return { source, recordId: value.id, sourceDigest: value.sourceDigest, observedAt: value.observedAt,
      entity: { id: entityId, type: 'entertainment', label: value.title, source,
        sourceId: `option:${value.providerItemId}`, attributes: { schemaVersion: 1, kind: 'life_option',
          accountId: value.accountId, optionId: value.id, optionKind: value.kind, source: value.source,
          title: value.title, categoryTags: value.categoryTags, durationMinutes: value.durationMinutes,
          exertion: value.exertion, screenBased: value.screenBased, locationClass: value.locationClass,
          cost: value.cost, available: value.available, expiresAt: value.expiresAt,
          sourceDigest: value.sourceDigest, observedAt: value.observedAt } },
      metric: 'entertainment.option.available', metricValue: value.available, metricUnit: null,
      eventType: 'entertainment.option.observed', eventPayload: { schemaVersion: 1, entityId,
        optionId: value.id, optionKind: value.kind, durationMinutes: value.durationMinutes,
        available: value.available, sourceDigest: value.sourceDigest } }
  }
  const value = record.value
  const source = `life:${value.accountId}`
  const entityId = lifeEntityId('subscription', value.accountId, value.providerSubscriptionId)
  return { source, recordId: value.id, sourceDigest: value.sourceDigest, observedAt: value.observedAt,
    entity: { id: entityId, type: 'life', label: value.serviceLabel, source,
      sourceId: `subscription:${value.providerSubscriptionId}`, attributes: { schemaVersion: 1,
        kind: 'subscription', accountId: value.accountId, subscriptionId: value.id,
        serviceLabel: value.serviceLabel, planLabel: value.planLabel, recurringCost: value.recurringCost,
        renewalAt: value.renewalAt, cancellationDeadline: value.cancellationDeadline, state: value.state,
        sourceDigest: value.sourceDigest, observedAt: value.observedAt } },
    metric: 'life.subscription.recurring_cost_minor', metricValue: value.recurringCost.amountMinor,
    metricUnit: value.recurringCost.currency, eventType: 'life.subscription.observed',
    eventPayload: { schemaVersion: 1, entityId, subscriptionId: value.id, state: value.state,
      currency: value.recurringCost.currency, recurringCostMinor: value.recurringCost.amountMinor,
      sourceDigest: value.sourceDigest } }
}

function projectRelations(record: LifeObservedRecord, entity: TwinEntity, source: string): TwinRelation[] {
  const relations = [stableTwinRelation({ subjectId: 'person:self', predicate: relationPredicate(record.kind),
    objectId: entity.id, attributes: { schemaVersion: 1, recordId: record.value.id,
      sourceDigest: record.value.sourceDigest }, validFrom: null, validTo: null, source,
    sourceId: `self:${entity.sourceId}` })]
  if (record.kind !== 'commitment') return relations
  for (const aliasId of record.value.participantAliasIds) {
    const alias = getLifeContactAlias(aliasId)
    if (!alias) throw new LifeContractError('LIFE_CONTACT_ALIAS_NOT_FOUND')
    const contactEntityId = lifeEntityId('contact', alias.accountId, alias.providerContactId)
    if (!getTwinEntity(contactEntityId)) throw new LifeContractError('LIFE_CONTACT_PROJECTION_NOT_FOUND')
    relations.push(stableTwinRelation({ subjectId: entity.id, predicate: 'life.commitment.participant',
      objectId: contactEntityId, attributes: { schemaVersion: 1, commitmentId: record.value.id,
        contactAliasId: alias.id }, validFrom: record.value.startsAt, validTo: record.value.endsAt, source,
      sourceId: `participant:${record.value.providerItemId}:${alias.providerContactId}` }))
  }
  return relations
}

function stableTwinEntity(input: {
  id: string; type: string; label: string; attributes: Record<string, unknown>; source: string; sourceId: string
}): TwinEntity {
  const current = getTwinEntity(input.id)
  if (current && current.type === input.type && current.label === input.label && current.source === input.source
    && current.sourceId === input.sourceId && stableJson(current.attributes) === stableJson(input.attributes)) return current
  return upsertTwinEntity(input)
}

function stableTwinRelation(input: {
  subjectId: string; predicate: string; objectId: string; attributes: Record<string, unknown>
  validFrom: string | null; validTo: string | null; source: string; sourceId: string
}): TwinRelation {
  const current = listTwinRelations({ subjectId: input.subjectId, predicate: input.predicate, limit: 200 })
    .find(item => item.source === input.source && item.sourceId === input.sourceId)
  if (current && current.objectId === input.objectId && current.validFrom === input.validFrom
    && current.validTo === input.validTo && stableJson(current.attributes) === stableJson(input.attributes)) return current
  return upsertTwinRelation(input)
}

function validatePageForAccount(page: LifeProviderPage, sourceKind: LifeSourceKind): void {
  if (page.sourceKind !== sourceKind) throw new LifeContractError('LIFE_OBSERVATION_SOURCE_MISMATCH')
}

function providerRecordIdentity(record: LifeProviderRecord): string {
  return record.recordKind === 'contact' ? `contact:${record.providerContactId}`
    : record.recordKind === 'subscription' ? `subscription:${record.providerSubscriptionId}`
      : `${record.recordKind}:${record.providerItemId}`
}

function relationPredicate(kind: LifeObservedRecord['kind']): string {
  return kind === 'commitment' ? 'life.has_commitment' : kind === 'contact' ? 'life.has_contact_alias'
    : kind === 'subscription' ? 'life.has_subscription' : 'entertainment.has_option'
}

function lifeEntityId(kind: string, accountId: string, providerId: string): string {
  const digest = createHash('sha256').update(`${kind}\0${accountId}\0${providerId}`).digest('hex').slice(0, 32)
  return `${kind === 'option' ? 'entertainment' : 'life'}:${kind}:${digest}`
}

function minimizedTitle(value: string, bvid: string): string {
  const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!title) return `Bilibili video ${bvid}`
  try { assertLifeSafeData({ title }); return title } catch { return `Bilibili video ${bvid}` }
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort(compare).map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

import { createHash } from 'crypto'
import {
  ensurePrimarySubject,
  getTwinEntity,
  recordTwinFactBatchWithDisposition,
  upsertTwinEntity,
  type TwinEntity,
  type TwinEvent,
  type TwinFactDisposition,
} from '../personal-twin'
import { CommerceContractError } from './contracts'
import type { CommerceProviderAdapter } from './provider'
import {
  createCommerceComparison,
  getCommerceAccount,
  listCommerceOfferSnapshots,
  recordCommerceOfferSnapshot,
} from './store'
import type {
  CommerceComparison,
  CommerceComparisonCandidate,
  CommerceComparisonRequirement,
  CommerceOfferSnapshot,
} from './types'

const ACTOR = 'commerce-assistant'

export interface CommerceObservationProjection {
  offer: CommerceOfferSnapshot
  entity: TwinEntity
  event: TwinEvent
  disposition: TwinFactDisposition
}

export interface CommerceComparisonProjection {
  comparison: CommerceComparison
  event: TwinEvent
  disposition: TwinFactDisposition
}

export async function observeCommerceOffers(input: {
  accountId: string
  query: string
  limit: number
  adapter: CommerceProviderAdapter
}): Promise<CommerceObservationProjection[]> {
  const account = getCommerceAccount(input.accountId)
  if (!account || !account.enabled || account.health === 'revoked' || account.provider !== input.adapter.provider) {
    throw new CommerceContractError('COMMERCE_OBSERVATION_ACCOUNT_UNAVAILABLE')
  }
  const providerOffers = await input.adapter.searchOffers({ query: input.query, limit: input.limit })
  return providerOffers.map(providerOffer => projectCommerceOffer(recordCommerceOfferSnapshot({
    accountId: account.id,
    provider: account.provider,
    ...providerOffer,
  })))
}

export function compareObservedCommerceOffers(input: {
  accountId: string
  requirement: CommerceComparisonRequirement
  activeAt: string
}): CommerceComparisonProjection {
  const account = getCommerceAccount(input.accountId)
  if (!account || !account.enabled || account.health === 'revoked') {
    throw new CommerceContractError('COMMERCE_COMPARISON_ACCOUNT_UNAVAILABLE')
  }
  const offers = listCommerceOfferSnapshots({ accountId: input.accountId, activeAt: input.activeAt, limit: 200 })
  if (offers.length === 0) throw new CommerceContractError('COMMERCE_COMPARISON_OFFERS_EMPTY')
  const candidates = offers.map(offer => scoreOffer(offer, input.requirement, input.activeAt))
  const selected = candidates.filter(candidate => candidate.eligible)
    .sort(compareCandidates)[0]?.offerSnapshotId ?? null
  const comparison = createCommerceComparison({
    accountId: input.accountId,
    requirement: input.requirement,
    candidates,
    selectedOfferSnapshotId: selected,
    createdAt: input.activeAt,
  })
  const projected = projectCommerceComparison(comparison)
  return { comparison, ...projected }
}

export function projectCommerceOffer(offer: CommerceOfferSnapshot): CommerceObservationProjection {
  ensurePrimarySubject()
  const entityId = commerceEntityId(offer)
  const source = `commerce:${offer.accountId}`
  const sourceId = `product:${offer.provider}:${offer.productId}:${offer.skuId}`
  const attributes = {
    schemaVersion: 1,
    kind: 'commerce_offer',
    accountId: offer.accountId,
    provider: offer.provider,
    productId: offer.productId,
    skuId: offer.skuId,
    merchantId: offer.merchantId,
    merchantName: offer.merchantName,
    title: offer.title,
    unitLabel: offer.unitLabel,
    currency: offer.money.currency,
    unitPriceMinor: offer.money.amountMinor,
    available: offer.available,
    maxQuantity: offer.maxQuantity,
    fulfillment: offer.fulfillment,
    fulfillmentMinutes: offer.fulfillmentMinutes,
    sourceOfferSnapshotId: offer.id,
    sourceDigest: offer.sourceDigest,
    observedAt: offer.observedAt,
    expiresAt: offer.expiresAt,
  }
  const current = getTwinEntity(entityId)
  const entity = current && current.type === 'commerce' && current.label === offer.title
    && current.source === source && current.sourceId === sourceId
    && stableJson(current.attributes) === stableJson(attributes)
    ? current : upsertTwinEntity({ id: entityId, type: 'commerce', label: offer.title, attributes, source, sourceId })
  const batch = recordTwinFactBatchWithDisposition({ ensureCanonicalSelf: true, events: [{
    eventType: 'commerce.offer.observed',
    subjectId: 'person:self',
    payload: {
      schemaVersion: 1,
      accountId: offer.accountId,
      provider: offer.provider,
      offerSnapshotId: offer.id,
      entityId,
      productId: offer.productId,
      skuId: offer.skuId,
      merchantId: offer.merchantId,
      currency: offer.money.currency,
      unitPriceMinor: offer.money.amountMinor,
      available: offer.available,
      fulfillment: offer.fulfillment,
      fulfillmentMinutes: offer.fulfillmentMinutes,
      expiresAt: offer.expiresAt,
      sourceDigest: offer.sourceDigest,
    },
    occurredAt: offer.observedAt,
    source,
    sourceId: `offer:${offer.id}`,
    actor: ACTOR,
    confidence: 1,
    confirmationState: 'observed',
    evidence: [{ kind: 'commerce_offer_snapshot', offerSnapshotId: offer.id, sourceDigest: offer.sourceDigest }],
  }] }, [{ observationIndexes: [], eventIndexes: [0] }])
  const event = batch.events[0]
  const disposition = batch.eventDispositions[0]
  if (!event || !disposition) throw new Error('COMMERCE_OFFER_PROJECTION_INCOMPLETE')
  return { offer, entity, event, disposition }
}

function projectCommerceComparison(comparison: CommerceComparison): {
  event: TwinEvent; disposition: TwinFactDisposition
} {
  ensurePrimarySubject()
  const source = `commerce:${comparison.accountId}`
  const selected = comparison.candidates.find(candidate => candidate.offerSnapshotId === comparison.selectedOfferSnapshotId)
  const batch = recordTwinFactBatchWithDisposition({ ensureCanonicalSelf: true, events: [{
    eventType: 'commerce.comparison.completed',
    subjectId: 'person:self',
    payload: {
      schemaVersion: 1,
      accountId: comparison.accountId,
      comparisonId: comparison.id,
      inputDigest: comparison.inputDigest,
      query: comparison.requirement.query,
      quantity: comparison.requirement.quantity,
      candidateCount: comparison.candidates.length,
      eligibleCount: comparison.candidates.filter(candidate => candidate.eligible).length,
      selectedOfferSnapshotId: comparison.selectedOfferSnapshotId,
      selectedPriceMinor: selected?.priceMinor ?? null,
      selectedRationaleCodes: selected?.rationaleCodes ?? [],
    },
    occurredAt: comparison.createdAt,
    source,
    sourceId: `comparison:${comparison.id}`,
    actor: ACTOR,
    confidence: 1,
    confirmationState: 'confirmed',
    evidence: [{ kind: 'commerce_comparison', comparisonId: comparison.id, inputDigest: comparison.inputDigest }],
  }] }, [{ observationIndexes: [], eventIndexes: [0] }])
  const event = batch.events[0]
  const disposition = batch.eventDispositions[0]
  if (!event || !disposition) throw new Error('COMMERCE_COMPARISON_PROJECTION_INCOMPLETE')
  return { event, disposition }
}

function scoreOffer(
  offer: CommerceOfferSnapshot,
  requirement: CommerceComparisonRequirement,
  activeAt: string,
): CommerceComparisonCandidate {
  const exclusionCodes: string[] = []
  const rationaleCodes: string[] = []
  const total = offer.money.amountMinor * requirement.quantity
  if (!Number.isSafeInteger(total)) exclusionCodes.push('amount_overflow')
  if (!offer.available || requirement.quantity > offer.maxQuantity) exclusionCodes.push('quantity_unavailable')
  if (requirement.excludedMerchantIds.includes(offer.merchantId)) exclusionCodes.push('merchant_excluded')
  if (requirement.maxTotalMinor !== null && total > requirement.maxTotalMinor) exclusionCodes.push('budget_exceeded')
  if (requirement.deliveryBefore !== null) {
    if (offer.fulfillmentMinutes === null) exclusionCodes.push('fulfillment_unknown')
    else if (Date.parse(activeAt) + offer.fulfillmentMinutes * 60_000 > Date.parse(requirement.deliveryBefore)) {
      exclusionCodes.push('delivery_window_missed')
    }
  }
  const eligible = exclusionCodes.length === 0
  if (eligible) {
    rationaleCodes.push('available_quantity')
    if (requirement.maxTotalMinor === null || total <= requirement.maxTotalMinor) rationaleCodes.push('within_budget')
    if (offer.fulfillmentMinutes !== null) rationaleCodes.push('fulfillment_known')
    if (requirement.preferenceCodes.includes('lowest_price')) rationaleCodes.push('price_preferred')
    if (requirement.preferenceCodes.includes('fast_delivery') && offer.fulfillmentMinutes !== null) {
      rationaleCodes.push('delivery_speed_preferred')
    }
  }
  const pricePenalty = Math.min(Number.isSafeInteger(total) ? total : 900_000, 900_000)
  const timePenalty = Math.min(offer.fulfillmentMinutes ?? 10_000, 10_000) * 10
  const preferenceBonus = (requirement.preferenceCodes.includes('lowest_price') ? 20_000 : 0)
    + (requirement.preferenceCodes.includes('fast_delivery') && offer.fulfillmentMinutes !== null ? 20_000 : 0)
  return {
    offerSnapshotId: offer.id,
    eligible,
    score: eligible ? Math.min(1_000_000, Math.max(0,
      1_000_000 - pricePenalty - timePenalty + preferenceBonus)) : null,
    priceMinor: total,
    fulfillmentMinutes: offer.fulfillmentMinutes,
    exclusionCodes: exclusionCodes.sort(compareCodeUnits),
    rationaleCodes: rationaleCodes.sort(compareCodeUnits),
  }
}

function compareCandidates(left: CommerceComparisonCandidate, right: CommerceComparisonCandidate): number {
  const score = (right.score ?? -1) - (left.score ?? -1)
  if (score !== 0) return score
  const price = left.priceMinor - right.priceMinor
  if (price !== 0) return price
  const time = (left.fulfillmentMinutes ?? Number.MAX_SAFE_INTEGER) - (right.fulfillmentMinutes ?? Number.MAX_SAFE_INTEGER)
  if (time !== 0) return time
  return compareCodeUnits(left.offerSnapshotId, right.offerSnapshotId)
}

function commerceEntityId(offer: CommerceOfferSnapshot): string {
  const digest = createHash('sha256').update(`${offer.provider}\0${offer.productId}\0${offer.skuId}`).digest('hex').slice(0, 32)
  return `commerce:product:${digest}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort(compareCodeUnits)
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

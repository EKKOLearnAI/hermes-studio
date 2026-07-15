import { createHash } from 'crypto'
import {
  ensurePrimarySubject,
  recordTwinFactBatchWithDisposition,
  type TwinEvent,
  type TwinFactDisposition,
} from '../personal-twin'
import { CommerceContractError } from './contracts'
import { assertCommerceProviderResult, type CommerceProviderAdapter } from './provider'
import {
  createCommerceCartRevision,
  createCommerceQuote,
  getCommerceAccount,
  getCommerceCartRevision,
  getCommerceComparison,
  getCommerceOfferSnapshot,
} from './store'
import type { CommerceCartRevision, CommerceQuote } from './types'

const ACTOR = 'commerce-assistant'

export interface CommerceCartProjection {
  cart: CommerceCartRevision
  event: TwinEvent
  disposition: TwinFactDisposition
}

export interface CommerceQuoteProjection {
  quote: CommerceQuote
  event: TwinEvent
  disposition: TwinFactDisposition
  mode: 'shadow' | 'live'
  externalWriteInvoked: false
}

export function prepareCommerceCartFromComparison(input: {
  comparisonId: string
  destinationToken: string
  recipientToken: string
  substitution: CommerceCartRevision['substitution']
  createdAt?: string
}): CommerceCartProjection {
  const comparison = getCommerceComparison(input.comparisonId)
  if (!comparison || comparison.selectedOfferSnapshotId === null) {
    throw new CommerceContractError('COMMERCE_CART_COMPARISON_NOT_SELECTED')
  }
  const selected = comparison.candidates.find(candidate =>
    candidate.offerSnapshotId === comparison.selectedOfferSnapshotId && candidate.eligible)
  if (!selected) throw new CommerceContractError('COMMERCE_CART_COMPARISON_INVALID')
  const cart = createCommerceCartRevision({
    accountId: comparison.accountId,
    items: [{ offerSnapshotId: selected.offerSnapshotId, quantity: comparison.requirement.quantity }],
    destinationToken: input.destinationToken,
    recipientToken: input.recipientToken,
    substitution: input.substitution,
    createdAt: input.createdAt ?? comparison.createdAt,
  })
  return { cart, ...projectCart(cart) }
}

export async function refreshShadowCommerceQuote(input: {
  cartRevisionId: string
  providerRequestId: string
  adapter: CommerceProviderAdapter
}): Promise<CommerceQuoteProjection> {
  const result = await refreshCommerceQuote(input)
  if (result.mode !== 'shadow') throw new CommerceContractError('COMMERCE_SHADOW_MODE_REQUIRED')
  return result
}

export async function refreshCommerceQuote(input: {
  cartRevisionId: string
  providerRequestId: string
  adapter: CommerceProviderAdapter
}): Promise<CommerceQuoteProjection> {
  const cart = getCommerceCartRevision(input.cartRevisionId)
  if (!cart) throw new CommerceContractError('COMMERCE_CART_NOT_FOUND')
  const account = getCommerceAccount(cart.accountId)
  if (!account || !account.enabled || account.health === 'revoked' || account.provider !== input.adapter.provider) {
    throw new CommerceContractError('COMMERCE_QUOTE_ACCOUNT_UNAVAILABLE')
  }
  if (account.mode === 'observe') throw new CommerceContractError('COMMERCE_QUOTE_MODE_FORBIDDEN')
  if (account.mode === 'shadow' && input.adapter.transport !== 'virtual') {
    throw new CommerceContractError('COMMERCE_SHADOW_EXTERNAL_TRANSPORT_FORBIDDEN')
  }
  if (account.mode === 'live' && input.adapter.transport !== 'external') {
    throw new CommerceContractError('COMMERCE_LIVE_TRANSPORT_REQUIRED')
  }
  const items = cart.items.map(item => {
    const offer = getCommerceOfferSnapshot(item.offerSnapshotId)
    if (!offer || offer.accountId !== account.id || offer.provider !== account.provider
      || offer.money.currency !== account.currency || !offer.available || item.quantity > offer.maxQuantity) {
      throw new CommerceContractError('COMMERCE_CART_OFFER_INVALID')
    }
    return { providerOfferId: offer.providerOfferId, quantity: item.quantity }
  })
  const result = await input.adapter.refreshQuote({
    providerRequestId: input.providerRequestId,
    cartDigest: cart.contentDigest,
    currency: account.currency,
    items,
    destinationToken: cart.destinationToken,
    substitution: cart.substitution,
  })
  assertCommerceProviderResult('refresh_quote', result)
  if (result.cartDigest !== cart.contentDigest || result.currency !== account.currency) {
    throw new CommerceContractError('COMMERCE_PROVIDER_QUOTE_MISMATCH')
  }
  const quote = createCommerceQuote({
    accountId: account.id,
    cartRevisionId: cart.id,
    providerQuoteId: result.providerQuoteId,
    currency: result.currency,
    breakdown: result.breakdown,
    observedAt: result.observedAt,
    expiresAt: result.expiresAt,
  })
  if (quote.quoteDigest !== result.quoteDigest) throw new CommerceContractError('COMMERCE_PROVIDER_QUOTE_MISMATCH')
  return { quote, ...projectQuote(quote, account.mode), mode: account.mode, externalWriteInvoked: false }
}

function projectCart(cart: CommerceCartRevision): { event: TwinEvent; disposition: TwinFactDisposition } {
  ensurePrimarySubject()
  const batch = recordTwinFactBatchWithDisposition({ ensureCanonicalSelf: true, events: [{
    eventType: 'commerce.cart.proposed',
    subjectId: 'person:self',
    payload: {
      schemaVersion: 1,
      accountId: cart.accountId,
      cartRevisionId: cart.id,
      revision: cart.revision,
      contentDigest: cart.contentDigest,
      itemCount: cart.items.length,
      totalQuantity: cart.items.reduce((sum, item) => sum + item.quantity, 0),
      destinationDigest: hash(cart.destinationToken),
      recipientDigest: hash(cart.recipientToken),
      substitution: cart.substitution,
    },
    occurredAt: cart.createdAt,
    source: `commerce:${cart.accountId}`,
    sourceId: `cart:${cart.id}`,
    actor: ACTOR,
    confidence: 1,
    confirmationState: 'confirmed',
    evidence: [{ kind: 'commerce_cart_revision', cartRevisionId: cart.id, contentDigest: cart.contentDigest }],
  }] }, [{ observationIndexes: [], eventIndexes: [0] }])
  const event = batch.events[0]
  const disposition = batch.eventDispositions[0]
  if (!event || !disposition) throw new Error('COMMERCE_CART_PROJECTION_INCOMPLETE')
  return { event, disposition }
}

function projectQuote(
  quote: CommerceQuote,
  mode: CommerceQuoteProjection['mode'],
): { event: TwinEvent; disposition: TwinFactDisposition } {
  ensurePrimarySubject()
  const batch = recordTwinFactBatchWithDisposition({ ensureCanonicalSelf: true, events: [{
    eventType: 'commerce.quote.refreshed',
    subjectId: 'person:self',
    payload: {
      schemaVersion: 1,
      accountId: quote.accountId,
      cartRevisionId: quote.cartRevisionId,
      quoteId: quote.id,
      quoteDigest: quote.quoteDigest,
      currency: quote.currency,
      breakdown: quote.breakdown,
      status: quote.status,
      observedAt: quote.observedAt,
      expiresAt: quote.expiresAt,
      mode,
      externalWriteInvoked: false,
    },
    occurredAt: quote.observedAt,
    source: `commerce:${quote.accountId}`,
    sourceId: `quote:${quote.id}`,
    actor: ACTOR,
    confidence: 1,
    confirmationState: 'confirmed',
    evidence: [{ kind: 'commerce_quote', quoteId: quote.id, quoteDigest: quote.quoteDigest }],
  }] }, [{ observationIndexes: [], eventIndexes: [0] }])
  const event = batch.events[0]
  const disposition = batch.eventDispositions[0]
  if (!event || !disposition) throw new Error('COMMERCE_QUOTE_PROJECTION_INCOMPLETE')
  return { event, disposition }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLifeSourceAccount,
  importBilibiliLifeOptions,
  listLifeCommitments,
  listLifeContactAliases,
  listLifeOptions,
  listLifeSubscriptions,
  syncLifeSource,
  VirtualLifeSourceProvider,
  type LifeProviderPage,
  type LifeSourceAdapter,
  type LifeSourceKind,
  type VirtualLifeCatalogRecord,
} from '../../packages/server/src/services/hermes/life-orchestration'
import {
  listTwinEntities,
  listTwinEvents,
  listTwinRelations,
  upsertTwinEntity,
} from '../../packages/server/src/services/hermes/personal-twin'

describe('life source observation and Twin projection', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hermes-life-observation-'))
    process.env.HERMES_HOME = home
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('normalizes contacts before commitments and projects minimized entities, facts, and relations', async () => {
    createAccount('contacts-main', 'contacts')
    createAccount('calendar-main', 'calendar')
    const contacts = await syncLifeSource({ accountId: 'contacts-main', adapter: provider('contacts') })
    expect(contacts).toMatchObject({ pageCount: 1, observedCount: 1, replayedCount: 0 })
    expect(contacts.projections[0]).toMatchObject({ disposition: 'new', record: { kind: 'contact' },
      event: { eventType: 'life.contact.observed' }, observation: { metric: 'life.contact.availability_tag_count' } })
    const stableUpdatedAt = contacts.projections[0]!.entity.updatedAt

    const calendar = await syncLifeSource({ accountId: 'calendar-main', adapter: provider('calendar') })
    expect(calendar.projections[0]).toMatchObject({ disposition: 'new', record: { kind: 'commitment' },
      event: { eventType: 'life.commitment.observed' }, observation: { metric: 'life.commitment.busy' } })
    expect(listLifeContactAliases()).toHaveLength(1)
    expect(listLifeCommitments()).toMatchObject([{ participantAliasIds: [listLifeContactAliases()[0]!.id] }])
    expect(listTwinEntities({ type: 'life' })).toHaveLength(2)
    expect(listTwinEvents({ eventTypePrefixes: ['life.'] })).toHaveLength(2)
    expect(listTwinRelations({ predicate: 'life.commitment.participant' })).toHaveLength(1)
    expect(listTwinRelations({ subjectId: 'person:self' })).toHaveLength(2)

    const replay = await syncLifeSource({ accountId: 'contacts-main', adapter: provider('contacts') })
    expect(replay.projections[0]).toMatchObject({ disposition: 'replayed' })
    expect(replay.projections[0]!.entity.updatedAt).toBe(stableUpdatedAt)
    expect(listTwinEvents({ eventType: 'life.contact.observed' })).toHaveLength(1)
  })

  it('normalizes travel, music, game, and subscription observations and excludes expired options', async () => {
    for (const kind of ['travel', 'music', 'games', 'subscriptions'] as const) createAccount(`${kind}-main`, kind)
    for (const kind of ['travel', 'music', 'games', 'subscriptions'] as const) {
      const result = await syncLifeSource({ accountId: `${kind}-main`, adapter: provider(kind) })
      expect(result.observedCount).toBe(1)
    }
    expect(listLifeOptions()).toHaveLength(3)
    expect(listLifeOptions({ activeAt: NOW })).toHaveLength(3)
    expect(listLifeOptions({ kind: 'game', activeAt: '2026-07-16T10:01:00.000Z' })).toHaveLength(0)
    expect(listLifeSubscriptions()).toMatchObject([{ serviceLabel: 'Music service', state: 'active', version: 1 }])
    expect(listTwinEntities({ type: 'entertainment' })).toHaveLength(3)
    expect(listTwinEvents({ eventType: 'entertainment.option.observed' })).toHaveLength(3)
    expect(listTwinEvents({ eventType: 'life.subscription.observed' })).toHaveLength(1)
  })

  it('deduplicates exact provider identities and fails closed on changed duplicates and cursor cycles', async () => {
    createAccount('calendar-main', 'calendar')
    const sourcePage = await provider('calendar').listPage({ cursor: null, limit: 20 })
    const page = { ...sourcePage, records: sourcePage.records.map(record => record.recordKind === 'commitment'
      ? { ...record, participantProviderContactIds: [] } : record) } as LifeProviderPage
    const duplicateAdapter = pagedAdapter(page, [
      { ...page, nextCursor: 'offset-1' },
      { ...page, nextCursor: null },
    ])
    expect(await syncLifeSource({ accountId: 'calendar-main', adapter: duplicateAdapter }))
      .toMatchObject({ pageCount: 2, observedCount: 1, replayedCount: 1 })

    const changed = { ...page, records: page.records.map(record => ({ ...record, sourceDigest: 'f'.repeat(64) })),
      nextCursor: null }
    await expect(syncLifeSource({ accountId: 'calendar-main', adapter: pagedAdapter(page, [
      { ...page, nextCursor: 'offset-1' }, changed,
    ]) })).rejects.toThrow('LIFE_OBSERVATION_PROVIDER_IDENTITY_CONFLICT')

    await expect(syncLifeSource({ accountId: 'calendar-main', adapter: pagedAdapter(page, [
      { ...page, nextCursor: 'offset-1' }, { ...page, nextCursor: 'offset-1' },
    ]) })).rejects.toThrow('LIFE_OBSERVATION_CURSOR_CYCLE')
    await expect(syncLifeSource({ accountId: 'calendar-main', adapter: provider('calendar'), maxPages: 6 }))
      .rejects.toThrow('LIFE_OBSERVATION_BOUNDS_INVALID')
  })

  it('requires contact identity resolution and rejects account/source substitution', async () => {
    createAccount('calendar-main', 'calendar')
    await expect(syncLifeSource({ accountId: 'calendar-main', adapter: provider('calendar') }))
      .rejects.toThrow('LIFE_OBSERVATION_CONTACT_UNRESOLVED')
    await expect(syncLifeSource({ accountId: 'calendar-main', adapter: provider('games') }))
      .rejects.toThrow('LIFE_OBSERVATION_ACCOUNT_UNAVAILABLE')
  })

  it('consumes existing Bilibili Twin entities without duplicating Internet ownership or facts', () => {
    upsertTwinEntity({ id: 'entertainment:bilibili:BV1234567890', type: 'entertainment',
      label: 'A documentary', source: 'bilibili', sourceId: 'video:BV1234567890', attributes: {
        schemaVersion: 1, kind: 'video', provider: 'bilibili', bvid: 'BV1234567890', title: 'A documentary',
        durationSeconds: 2_701, discoveredAt: NOW, resultDigest: 'a'.repeat(64),
      } })
    const before = listTwinEntities({ type: 'entertainment' })
    const options = importBilibiliLifeOptions()
    expect(options).toMatchObject([{ accountId: null, kind: 'video', source: 'bilibili',
      providerItemId: 'BV1234567890', title: 'A documentary', durationMinutes: 46,
      categoryTags: ['video'], sourceDigest: 'a'.repeat(64) }])
    expect(importBilibiliLifeOptions()).toEqual(options)
    expect(listTwinEntities({ type: 'entertainment' })).toEqual(before)
    expect(listTwinEvents()).toHaveLength(0)
  })
})

const NOW = '2026-07-15T10:00:00.000Z'

function createAccount(id: string, sourceKind: LifeSourceKind): void {
  createLifeSourceAccount({ id, sourceKind, mode: 'observe', displayName: id })
}

function provider(sourceKind: LifeSourceKind): VirtualLifeSourceProvider {
  return new VirtualLifeSourceProvider({ sourceKind, records: recordsFor(sourceKind), clock: () => new Date(NOW) })
}

function recordsFor(sourceKind: LifeSourceKind): VirtualLifeCatalogRecord[] {
  if (sourceKind === 'calendar') return [{ recordKind: 'commitment', providerItemId: 'event-001',
    label: 'Work block', category: 'work', startsAt: '2026-07-15T11:00:00.000Z',
    endsAt: '2026-07-15T12:00:00.000Z', allDay: false, busy: true, locationClass: 'remote',
    participantProviderContactIds: ['contact-001'], validForMinutes: 1_440 }]
  if (sourceKind === 'contacts') return [{ recordKind: 'contact', providerContactId: 'contact-001',
    alias: 'Friend A', relationshipTags: ['friend'], availabilityTags: ['evening'] }]
  if (sourceKind === 'subscriptions') return [{ recordKind: 'subscription',
    providerSubscriptionId: 'subscription-001', serviceLabel: 'Music service', planLabel: 'Plus',
    recurringCost: { currency: 'CNY', amountMinor: 1_500 }, renewalAt: '2026-08-15T10:00:00.000Z',
    cancellationDeadline: '2026-08-14T10:00:00.000Z', state: 'active' }]
  const optionKind = sourceKind === 'games' ? 'game' : sourceKind
  return [{ recordKind: 'option', providerItemId: `${optionKind}-001`, kind: optionKind,
    source: `virtual-${sourceKind}`, title: `${optionKind} option`, categoryTags: [optionKind],
    durationMinutes: 60, exertion: 'low', screenBased: optionKind !== 'travel',
    locationClass: optionKind === 'travel' ? 'local' : 'home', cost: { currency: 'CNY', amountMinor: 500 },
    available: true, validForMinutes: 1_440 }]
}

function pagedAdapter(seed: LifeProviderPage, pages: LifeProviderPage[]): LifeSourceAdapter {
  let index = 0
  return { sourceKind: seed.sourceKind, transport: 'external', async listPage() {
    const page = pages[index]
    index += 1
    if (!page) throw new Error('unexpected page')
    return page
  } }
}

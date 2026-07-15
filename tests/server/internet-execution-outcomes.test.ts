import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  projectVerifiedInternetReceipt,
} from '../../packages/server/src/services/hermes/internet-execution/outcomes'
import type { InternetExecutionReceipt } from '../../packages/server/src/services/hermes/internet-execution/types'
import {
  listTwinEntities,
  listTwinEvents,
  withPersonalTwinDb,
} from '../../packages/server/src/services/hermes/personal-twin'

const BVID_A = 'BV1xx411c7mD'
const BVID_B = 'BV1Q541167Qg'

describe('verified internet Personal Twin outcomes', () => {
  const originalHome = process.env.HERMES_HOME
  let directory = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hermes-internet-outcomes-'))
    process.env.HERMES_HOME = directory
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(directory, { recursive: true, force: true })
  })

  it('projects bounded provider entities, one immutable discovery event, and one outbox record', () => {
    const receipt = searchReceipt('001')
    const projected = projectVerifiedInternetReceipt(receipt)
    expect(projected).toMatchObject({ disposition: 'new', entities: [
      { id: `entertainment:bilibili:${BVID_A}`, type: 'entertainment', source: 'bilibili', sourceId: `video:${BVID_A}` },
      { id: `entertainment:bilibili:${BVID_B}`, type: 'entertainment', source: 'bilibili', sourceId: `video:${BVID_B}` },
    ] })
    expect(projected.resultDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(projected.entities[0]?.attributes).toMatchObject({
      provider: 'bilibili', bvid: BVID_A, sourceReceiptId: receipt.workflowId,
      sourceWorkflowId: receipt.workflowId, resultDigest: projected.resultDigest,
    })

    const events = listTwinEvents({ eventType: 'entertainment.video.discovered' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      subjectId: 'person:self',
      payload: { provider: 'bilibili', profile: 'default', receiptId: receipt.workflowId,
        workflowId: receipt.workflowId, executorType: 'mcp', videoCount: 2, bvids: [BVID_A, BVID_B] },
      provenance: { source: 'bilibili', sourceId: `receipt:${receipt.workflowId}`,
        actor: 'entertainment-assistant', confirmationState: 'confirmed' },
    })
    expect(events[0]?.provenance.evidence).toEqual([expect.objectContaining({
      kind: 'internet_execution_receipt', receiptId: receipt.workflowId,
      resultDigest: projected.resultDigest,
    })])

    const outbox = withPersonalTwinDb(db => db.prepare(
      "SELECT topic,aggregate_id,payload_json,status FROM twin_outbox WHERE topic='twin.event.recorded'",
    ).get() as { topic: string; aggregate_id: string; payload_json: string; status: string })
    expect(outbox).toMatchObject({ topic: 'twin.event.recorded', aggregate_id: events[0]?.id, status: 'pending' })
    expect(JSON.parse(outbox.payload_json)).toMatchObject({
      recordId: events[0]?.id, eventType: 'entertainment.video.discovered',
      source: 'bilibili', sourceId: `receipt:${receipt.workflowId}`,
    })
    expect(JSON.stringify({ events, outbox })).not.toMatch(/token|cookie|server|tool|browserRef/i)
  })

  it('replays the same workflow without duplicating entities, events, or outbox rows', () => {
    const receipt = searchReceipt('replay')
    const first = projectVerifiedInternetReceipt(receipt)
    expect(first.disposition).toBe('new')
    const replay = projectVerifiedInternetReceipt(receipt)
    expect(replay.disposition).toBe('replayed')
    expect(replay.entities.map(entity => entity.updatedAt)).toEqual(first.entities.map(entity => entity.updatedAt))
    expect(listTwinEntities({ type: 'entertainment' })).toHaveLength(2)
    expect(listTwinEvents({ eventType: 'entertainment.video.discovered' })).toHaveLength(1)
    expect(withPersonalTwinDb(db => db.prepare('SELECT COUNT(*) AS count FROM twin_outbox').get()))
      .toEqual({ count: 1 })
  })

  it('projects inspected metadata and resumes safely after an outbox transaction failure', () => {
    const receipt = inspectReceipt('inspect')
    withPersonalTwinDb(db => db.exec(`CREATE TRIGGER fail_internet_outcome_outbox BEFORE INSERT ON twin_outbox
      WHEN NEW.topic='twin.event.recorded' BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END`))
    expect(() => projectVerifiedInternetReceipt(receipt)).toThrow(/outbox unavailable/)
    expect(listTwinEvents({ eventType: 'entertainment.video.discovered' })).toEqual([])
    expect(listTwinEntities({ type: 'entertainment' })).toHaveLength(1)

    withPersonalTwinDb(db => db.exec('DROP TRIGGER fail_internet_outcome_outbox'))
    const recovered = projectVerifiedInternetReceipt(receipt)
    expect(recovered.disposition).toBe('new')
    expect(recovered.entities[0]).toMatchObject({ attributes: {
      description: 'Public description', tags: ['AI', 'Agents'], sourceReceiptId: receipt.workflowId,
    } })
    expect(listTwinEvents({ eventType: 'entertainment.video.discovered' })).toHaveLength(1)
  })

  it('rejects unverified or semantically invalid receipts without writing Twin records', () => {
    expect(() => projectVerifiedInternetReceipt({ ...searchReceipt('unverified'), status: 'executed' }))
      .toThrow('INTERNET_OUTCOME_RECEIPT_INVALID')
    expect(() => projectVerifiedInternetReceipt({ ...searchReceipt('invalid'),
      result: { ...searchReceipt('invalid').result, provider: 'other' } }))
      .toThrow('INTERNET_OUTCOME_RECEIPT_INVALID')
    expect(listTwinEntities({ type: 'entertainment' })).toEqual([])
    expect(listTwinEvents({ eventType: 'entertainment.video.discovered' })).toEqual([])
  })
})

function searchReceipt(suffix: string): InternetExecutionReceipt {
  return receiptBase(suffix, {
    capabilityId: 'bilibili.video.search',
    operation: 'search',
    request: { schemaVersion: 1, provider: 'bilibili', profile: 'default', query: 'Hermes',
      limit: 5, page: 1, order: 'relevance' },
    result: { schemaVersion: 1, provider: 'bilibili', profile: 'default', operation: 'search', query: 'Hermes',
      status: 'succeeded', videos: [video(BVID_A, 'Video A'), video(BVID_B, 'Video B')],
      totalCount: 2, omittedCount: 0 },
  })
}

function inspectReceipt(suffix: string): InternetExecutionReceipt {
  return receiptBase(suffix, {
    capabilityId: 'bilibili.video.inspect',
    operation: 'inspect',
    executorType: 'browser',
    executorId: 'bilibili-browser',
    request: { schemaVersion: 1, provider: 'bilibili', profile: 'default', bvid: BVID_A },
    result: { schemaVersion: 1, provider: 'bilibili', profile: 'default', operation: 'inspect',
      status: 'succeeded', video: video(BVID_A, 'Video A'), description: 'Public description', tags: ['AI', 'Agents'] },
  })
}

function receiptBase(suffix: string, overrides: Partial<InternetExecutionReceipt>): InternetExecutionReceipt {
  return {
    workflowId: `workflow-internet-${suffix}`,
    intentId: `intent-internet-${suffix}`,
    materialDigest: 'a'.repeat(64),
    capabilityId: 'bilibili.video.search',
    provider: 'bilibili',
    profile: 'default',
    executorId: 'bilibili-mcp',
    executorType: 'mcp',
    environment: 'production',
    operation: 'search',
    request: {},
    safeToReplay: true,
    status: 'verified',
    providerRequestId: null,
    result: null,
    errorCode: null,
    version: 5,
    createdAt: '2026-07-15T03:00:00.000Z',
    updatedAt: '2026-07-15T03:00:02.000Z',
    completedAt: '2026-07-15T03:00:02.000Z',
    ...overrides,
  }
}

function video(bvid: string, title: string) {
  return { bvid, title, author: 'Alice', publishedAt: null, durationSeconds: 120, viewCount: 42,
    canonicalUrl: `https://www.bilibili.com/video/${bvid}` }
}

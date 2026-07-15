import { createHash } from 'node:crypto'
import {
  ensurePrimarySubject,
  getTwinEntity,
  recordTwinFactBatchWithDisposition,
  upsertTwinEntity,
  type TwinEntity,
  type TwinEvent,
  type TwinFactDisposition,
} from '../personal-twin'
import type { FabricJsonObject } from '../action-fabric/types'
import {
  BILIBILI_INSPECT_CAPABILITY,
  BILIBILI_PROVIDER,
  BILIBILI_SEARCH_CAPABILITY,
  validateInternetOutputSemantics,
  validateInternetSemantics,
  type BilibiliVideoSummary,
} from './fabric-contracts'
import type { InternetExecutionReceipt } from './types'

const SOURCE = BILIBILI_PROVIDER
const ACTOR = 'entertainment-assistant'
const EVENT_TYPE = 'entertainment.video.discovered'

export interface InternetOutcomeProjection {
  disposition: TwinFactDisposition
  entities: TwinEntity[]
  event: TwinEvent
  resultDigest: string
}

/**
 * Projects only terminal verified semantic results. Entity provenance is keyed by
 * provider/BVID, while the immutable discovery event and its outbox record are
 * keyed by the durable receipt workflow ID.
 */
export function projectVerifiedInternetReceipt(receipt: InternetExecutionReceipt): InternetOutcomeProjection {
  const result = verifiedResult(receipt)
  const videos = resultVideos(receipt.capabilityId, result)
  const resultDigest = createHash('sha256').update(stableJson(result)).digest('hex')
  const occurredAt = receipt.completedAt ?? receipt.updatedAt
  ensurePrimarySubject()
  const entities = videos.map(video => projectVideoEntity(receipt, result, video, resultDigest, occurredAt))
  const fact = recordTwinFactBatchWithDisposition({
    ensureCanonicalSelf: true,
    events: [{
      eventType: EVENT_TYPE,
      subjectId: 'person:self',
      payload: eventPayload(receipt, videos, resultDigest),
      occurredAt,
      source: SOURCE,
      sourceId: `receipt:${receipt.workflowId}`,
      actor: ACTOR,
      confidence: 1,
      confirmationState: 'confirmed',
      evidence: [{
        kind: 'internet_execution_receipt',
        receiptId: receipt.workflowId,
        workflowId: receipt.workflowId,
        resultDigest,
        executorType: receipt.executorType,
        verifiedAt: occurredAt,
      }],
    }],
  }, [{ observationIndexes: [], eventIndexes: [0] }])
  const event = fact.events[0]
  const disposition = fact.eventDispositions[0]
  if (!event || !disposition) throw new Error('INTERNET_OUTCOME_PROJECTION_INCOMPLETE')
  return { disposition, entities, event, resultDigest }
}

function projectVideoEntity(
  receipt: InternetExecutionReceipt,
  result: FabricJsonObject,
  video: BilibiliVideoSummary,
  resultDigest: string,
  discoveredAt: string,
): TwinEntity {
  const id = `entertainment:bilibili:${video.bvid}`
  const sourceId = `video:${video.bvid}`
  const current = getTwinEntity(id)
  const attributes = {
    ...(current?.source === SOURCE && current.sourceId === sourceId ? current.attributes : {}),
    ...videoAttributes(receipt, result, video, resultDigest, discoveredAt),
  }
  if (current && current.type === 'entertainment' && current.label === video.title
    && current.source === SOURCE && current.sourceId === sourceId
    && stableJson(current.attributes) === stableJson(attributes)) return current
  return upsertTwinEntity({
    id,
    type: 'entertainment',
    label: video.title,
    attributes,
    source: SOURCE,
    sourceId,
  })
}

function verifiedResult(receipt: InternetExecutionReceipt): FabricJsonObject {
  if (receipt.status !== 'verified' || receipt.provider !== BILIBILI_PROVIDER || !receipt.result
    || !validateInternetSemantics(receipt.capabilityId, receipt.request as FabricJsonObject)
    || !validateInternetOutputSemantics(
      receipt.capabilityId,
      receipt.request as FabricJsonObject,
      receipt.result as FabricJsonObject,
    )) {
    throw new Error('INTERNET_OUTCOME_RECEIPT_INVALID')
  }
  return receipt.result as FabricJsonObject
}

function resultVideos(capabilityId: string, result: FabricJsonObject): BilibiliVideoSummary[] {
  const raw = capabilityId === BILIBILI_SEARCH_CAPABILITY ? result.videos
    : capabilityId === BILIBILI_INSPECT_CAPABILITY ? [result.video] : null
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) {
    throw new Error('INTERNET_OUTCOME_RESULT_INVALID')
  }
  return raw as unknown as BilibiliVideoSummary[]
}

function videoAttributes(
  receipt: InternetExecutionReceipt,
  result: FabricJsonObject,
  video: BilibiliVideoSummary,
  resultDigest: string,
  discoveredAt: string,
): Record<string, unknown> {
  const inspected = receipt.capabilityId === BILIBILI_INSPECT_CAPABILITY
  return {
    schemaVersion: 1,
    kind: 'video',
    provider: BILIBILI_PROVIDER,
    bvid: video.bvid,
    title: video.title,
    author: video.author,
    publishedAt: video.publishedAt,
    durationSeconds: video.durationSeconds,
    viewCount: video.viewCount,
    canonicalUrl: video.canonicalUrl,
    ...(inspected ? {
      description: result.description,
      tags: result.tags,
    } : {}),
    profile: receipt.profile,
    sourceReceiptId: receipt.workflowId,
    sourceWorkflowId: receipt.workflowId,
    resultDigest,
    discoveredAt,
  }
}

function eventPayload(
  receipt: InternetExecutionReceipt,
  videos: BilibiliVideoSummary[],
  resultDigest: string,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: BILIBILI_PROVIDER,
    profile: receipt.profile,
    capabilityId: receipt.capabilityId,
    operation: receipt.operation,
    receiptId: receipt.workflowId,
    workflowId: receipt.workflowId,
    executorType: receipt.executorType,
    resultDigest,
    videoCount: videos.length,
    bvids: videos.map(video => video.bvid),
    ...(receipt.capabilityId === BILIBILI_SEARCH_CAPABILITY ? { query: receipt.request.query }
      : { bvid: receipt.request.bvid }),
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('INTERNET_OUTCOME_RESULT_INVALID')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  throw new Error('INTERNET_OUTCOME_RESULT_INVALID')
}

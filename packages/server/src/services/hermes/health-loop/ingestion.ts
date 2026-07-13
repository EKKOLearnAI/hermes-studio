import {
  recordTwinFactBatchWithDisposition, TwinImmutableRecordConflictError, TwinEventInput, TwinObservationInput,
} from '../personal-twin'
import { normalizeHealthIngestionEnvelope } from './normalizers'
import { HealthIngestionEnvelope, HealthIngestionError, HealthIngestionResult } from './types'

const ACTOR = 'health-ingestion'
const EVENT_TYPE = 'health.ingestion.recorded'

export interface HealthIngestionBatchItemResult extends HealthIngestionResult {
  status: 'new' | 'replayed'
}

export function ingestHealthEnvelopesAtomically(envelopes: HealthIngestionEnvelope[]): HealthIngestionBatchItemResult[] {
  if (!Array.isArray(envelopes) || envelopes.length === 0) throw new HealthIngestionError('HEALTH_INGESTION_INVALID_ENVELOPE', 'batch must contain at least one envelope')
  const normalized = envelopes.map(normalizeHealthIngestionEnvelope)
  const identities = new Set<string>()
  for (const item of normalized) {
    const identity = `${item.source}\0${item.sourceId}`
    if (identities.has(identity)) throw new HealthIngestionError('HEALTH_INGESTION_INVALID_ENVELOPE', 'batch contains a duplicate source identity')
    identities.add(identity)
  }

  const observations: TwinObservationInput[] = []
  const events: TwinEventInput[] = []
  const groups: Array<{ observationIndexes: number[]; eventIndexes: number[] }> = []
  for (const item of normalized) {
    const observationIndexes: number[] = []
    for (const observation of item.observations) {
      observationIndexes.push(observations.length)
      observations.push({
        entityId: 'person:self', metric: observation.metric, value: observation.value, unit: observation.unit,
        observedAt: item.observedAt, source: item.source, sourceId: `${item.sourceId}:${observation.metric}`,
        actor: ACTOR, confidence: item.confidence, confirmationState: item.confirmationState, evidence: item.evidence,
      })
    }
    const eventIndex = events.length
    events.push({
      eventType: EVENT_TYPE, subjectId: 'person:self', payload: item.eventPayload, occurredAt: item.observedAt,
      source: item.source, sourceId: `${item.sourceId}:${EVENT_TYPE}`, actor: ACTOR,
      confidence: item.confidence, confirmationState: item.confirmationState, evidence: item.evidence,
    })
    groups.push({ observationIndexes, eventIndexes: [eventIndex] })
  }

  try {
    const result = recordTwinFactBatchWithDisposition({ ensureCanonicalSelf: true, observations, events }, groups)
    return groups.map(group => ({
      observations: group.observationIndexes.map(observationIndex => result.observations[observationIndex]),
      event: result.events[group.eventIndexes[0]],
      status: result.eventDispositions[group.eventIndexes[0]],
    }))
  } catch (error) {
    if (error instanceof TwinImmutableRecordConflictError) {
      throw new HealthIngestionError('HEALTH_INGESTION_IDENTITY_CONFLICT', 'source identity already contains different normalized material')
    }
    throw error
  }
}

export function ingestHealthEnvelope(envelope: HealthIngestionEnvelope): HealthIngestionResult {
  const { status: _status, ...result } = ingestHealthEnvelopesAtomically([envelope])[0]
  return result
}

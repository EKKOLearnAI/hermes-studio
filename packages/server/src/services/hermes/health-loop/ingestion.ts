import {
  recordTwinFactBatch, TwinImmutableRecordConflictError, TwinEventInput, TwinObservationInput,
} from '../personal-twin'
import { normalizeHealthIngestionEnvelope } from './normalizers'
import { HealthIngestionEnvelope, HealthIngestionError, HealthIngestionResult } from './types'

const ACTOR = 'health-ingestion'
const EVENT_TYPE = 'health.ingestion.recorded'

export function ingestHealthEnvelope(envelope: HealthIngestionEnvelope): HealthIngestionResult {
  const normalized = normalizeHealthIngestionEnvelope(envelope)
  const observations: TwinObservationInput[] = normalized.observations.map(item => ({
    entityId: 'person:self', metric: item.metric, value: item.value, unit: item.unit,
    observedAt: normalized.observedAt, source: normalized.source, sourceId: `${normalized.sourceId}:${item.metric}`,
    actor: ACTOR, confidence: normalized.confidence, confirmationState: normalized.confirmationState,
    evidence: normalized.evidence,
  }))
  const event: TwinEventInput = {
    eventType: EVENT_TYPE, subjectId: 'person:self', payload: normalized.eventPayload, occurredAt: normalized.observedAt,
    source: normalized.source, sourceId: `${normalized.sourceId}:${EVENT_TYPE}`, actor: ACTOR,
    confidence: normalized.confidence, confirmationState: normalized.confirmationState, evidence: normalized.evidence,
  }
  try {
    const result = recordTwinFactBatch({ ensureCanonicalSelf: true, observations, events: [event] })
    return { observations: result.observations, event: result.events[0] }
  } catch (error) {
    if (error instanceof TwinImmutableRecordConflictError) {
      throw new HealthIngestionError('HEALTH_INGESTION_IDENTITY_CONFLICT', 'source identity already contains different normalized material')
    }
    throw error
  }
}

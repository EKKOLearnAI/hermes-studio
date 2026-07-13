import type {
  TwinConfirmationState, TwinEvent, TwinObservation,
} from '../personal-twin'

export const HEALTH_DOMAINS = [
  'body_composition', 'measurements', 'posture', 'skin', 'diet', 'fitness', 'sleep', 'internal_health',
] as const

export type HealthDomain = typeof HEALTH_DOMAINS[number]
export type HealthEvidenceClass = 'measured' | 'reported' | 'inferred' | 'derived'

export interface HealthIngestionEnvelope {
  domain: HealthDomain
  source: string
  sourceId: string
  observedAt: string
  evidenceClass: HealthEvidenceClass
  confidence: number
  payload: Record<string, unknown>
  artifactIds?: string[]
  parserVersion?: string
}

export interface NormalizedHealthObservation {
  metric: string
  value: unknown
  unit: string | null
}

export interface NormalizedHealthIngestion {
  domain: HealthDomain
  source: string
  sourceId: string
  observedAt: string
  confidence: number
  confirmationState: TwinConfirmationState
  artifactIds: string[]
  evidence: Array<Record<string, unknown>>
  observations: NormalizedHealthObservation[]
  eventPayload: Record<string, unknown>
  materialDigest: string
}

export interface HealthIngestionResult {
  observations: TwinObservation[]
  event: TwinEvent
}

export type HealthIngestionErrorCode =
  | 'HEALTH_INGESTION_INVALID_ENVELOPE'
  | 'HEALTH_INGESTION_INVALID_TIMESTAMP'
  | 'HEALTH_INGESTION_INVALID_NUMBER'
  | 'HEALTH_INGESTION_INVALID_IDENTITY'
  | 'HEALTH_INGESTION_INVALID_ARTIFACT_ID'
  | 'HEALTH_INGESTION_INVALID_JSON'
  | 'HEALTH_INGESTION_INVALID_PAYLOAD'
  | 'HEALTH_INGESTION_IDENTITY_CONFLICT'

export class HealthIngestionError extends Error {
  constructor(public readonly code: HealthIngestionErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'HealthIngestionError'
  }
}

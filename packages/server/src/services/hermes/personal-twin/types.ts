export type TwinConfirmationState = 'observed' | 'reported' | 'confirmed' | 'inferred'
export type TwinOutboxStatus = 'pending' | 'published' | 'failed'

export interface TwinProvenance {
  source: string
  sourceId: string
  actor: string
  confidence: number
  confirmationState: TwinConfirmationState
  evidence: Array<Record<string, unknown>>
  schemaVersion: number
}

export interface TwinEntity {
  id: string
  type: string
  label: string
  attributes: Record<string, unknown>
  source: string
  sourceId: string
  createdAt: string
  updatedAt: string
}

export interface TwinRelation {
  id: string
  subjectId: string
  predicate: string
  objectId: string
  attributes: Record<string, unknown>
  validFrom: string | null
  validTo: string | null
  source: string
  sourceId: string
  createdAt: string
  updatedAt: string
}

export interface TwinObservation {
  id: string
  entityId: string
  metric: string
  value: unknown
  unit: string | null
  observedAt: string
  ingestedAt: string
  provenance: TwinProvenance
}

export interface TwinEvent {
  id: string
  eventType: string
  subjectId: string | null
  payload: Record<string, unknown>
  occurredAt: string
  ingestedAt: string
  provenance: TwinProvenance
}

export interface TwinProjection {
  key: string
  subjectId: string
  value: Record<string, unknown>
  sourceRecordId: string
  version: number
  updatedAt: string
}

export interface TwinGoal {
  id: string
  subjectId: string
  domain: string
  title: string
  target: Record<string, unknown>
  status: string
  priority: number
  startsAt: string | null
  dueAt: string | null
  source: string
  sourceId: string
  createdAt: string
  updatedAt: string
}

export interface TwinConstraint {
  id: string
  subjectId: string
  domain: string
  key: string
  value: unknown
  enforcement: 'hard' | 'advisory'
  source: string
  sourceId: string
  createdAt: string
  updatedAt: string
}

export interface TwinOverview {
  generatedAt: string
  subject: TwinEntity
  counts: {
    entities: number
    relations: number
    observations: number
    events: number
    goals: number
    constraints: number
    pendingOutbox: number
  }
  latestObservations: TwinObservation[]
  recentEvents: TwinEvent[]
  imports: Array<Record<string, unknown>>
}

export interface TwinEntityInput {
  id?: string
  type: string
  label: string
  attributes?: Record<string, unknown>
  source: string
  sourceId: string
}

export interface TwinRelationInput {
  id?: string
  subjectId: string
  predicate: string
  objectId: string
  attributes?: Record<string, unknown>
  validFrom?: string | null
  validTo?: string | null
  source: string
  sourceId: string
}

export interface TwinGoalInput {
  id?: string
  subjectId: string
  domain: string
  title: string
  target: Record<string, unknown>
  status: string
  priority: number
  startsAt?: string | null
  dueAt?: string | null
  source: string
  sourceId: string
}

export interface TwinConstraintInput {
  id?: string
  subjectId: string
  domain: string
  key: string
  value: unknown
  enforcement: 'hard' | 'advisory'
  source: string
  sourceId: string
}

export interface TwinEntityListOptions { type?: string; source?: string; limit?: number }
export interface TwinRelationListOptions { subjectId?: string; predicate?: string; objectId?: string; limit?: number }
export interface TwinGoalListOptions { subjectId?: string; domain?: string; status?: string; limit?: number }
export interface TwinConstraintListOptions {
  subjectId?: string
  domain?: string
  key?: string
  enforcement?: 'hard' | 'advisory'
  limit?: number
}

export class TwinRecordNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TwinRecordNotFoundError'
  }
}

export class TwinIdentityConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TwinIdentityConflictError'
  }
}

export class TwinImmutableRecordConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TwinImmutableRecordConflictError'
  }
}

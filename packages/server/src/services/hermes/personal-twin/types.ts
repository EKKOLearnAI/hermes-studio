export type TwinConfirmationState = 'observed' | 'reported' | 'confirmed' | 'inferred'
export type TwinOutboxStatus = 'pending' | 'published' | 'failed'

export const TWIN_DOMAINS = [
  'body',
  'health',
  'fitness',
  'nutrition',
  'home',
  'life',
  'work',
  'entertainment',
  'commerce',
  'digital',
] as const
export type TwinDomain = typeof TWIN_DOMAINS[number]

export const TWIN_CONTEXT_SECTIONS = [
  'subject',
  'observations',
  'events',
  'goals',
  'constraints',
  'entities',
  'relations',
] as const
export type TwinContextSection = typeof TWIN_CONTEXT_SECTIONS[number]

export interface AssistantRoleDataScope {
  domains: TwinDomain[]
  sections: TwinContextSection[]
  includeProvenance: boolean
}

export interface AssistantRoleCapabilityScope {
  allow: string[]
  deny: string[]
  enforcement: 'declarative_phase_2' | 'action_fabric_v1'
}

export type AssistantRoleRisk = 'none' | 'low' | 'medium' | 'high' | 'critical'

export interface AssistantRoleDecisionAuthority {
  [key: string]: unknown
  maxRisk: AssistantRoleRisk
  requireApprovalAbove?: AssistantRoleRisk
  allowedTargets?: string[]
}

export interface AssistantRoleSpendingLimits {
  [key: string]: unknown
  currency: string | null
  perAction: number
  daily: number
}

export interface AssistantRole {
  id: string
  name: string
  description: string
  persona: string
  builtIn: boolean
  enabled: boolean
  dataScope: AssistantRoleDataScope
  capabilityScope: AssistantRoleCapabilityScope
  decisionAuthority: AssistantRoleDecisionAuthority
  spendingLimits: AssistantRoleSpendingLimits
  memoryNamespace: string
  escalationRules: Array<Record<string, unknown>>
  createdAt: string
  updatedAt: string
}

export interface AssistantRoleInput {
  id?: string
  name: string
  description?: string
  persona: string
  enabled?: boolean
  dataScope: AssistantRoleDataScope
  capabilityScope: AssistantRoleCapabilityScope
  decisionAuthority?: AssistantRoleDecisionAuthority
  spendingLimits?: AssistantRoleSpendingLimits
  memoryNamespace: string
  escalationRules?: Array<Record<string, unknown>>
}

export type AssistantRolePatch = Partial<Omit<AssistantRoleInput, 'id'>>

export interface AssistantRoleProfileMapping {
  roleId: string
  profileName: string
  isPrimary: boolean
  createdAt: string
  updatedAt: string
}

export interface ContextRecipeLimits {
  perSection: number
  totalCharacters: number
}

export interface ContextRecipe {
  id: string
  roleId: string
  name: string
  description: string
  builtIn: boolean
  enabled: boolean
  domains: TwinDomain[]
  sections: TwinContextSection[]
  queryTemplate: string
  limits: ContextRecipeLimits
  createdAt: string
  updatedAt: string
}

export interface ContextRecipeInput {
  id?: string
  name: string
  description?: string
  enabled?: boolean
  domains: TwinDomain[]
  sections: TwinContextSection[]
  queryTemplate?: string
  limits: ContextRecipeLimits
}

export type ContextRecipePatch = Partial<Omit<ContextRecipeInput, 'id'>>

export interface AssistantRoleSummary extends AssistantRole {
  profileMappings: AssistantRoleProfileMapping[]
  primaryProfileName: string | null
  mappingStale: boolean
  recipeCount: number
}

export interface RoleContextOptions {
  query?: string
  recipeId?: string
}

export interface RoleContextProvenance {
  recordId: string
  source: string
  sourceId: string
  actor?: string
  confirmationState?: TwinConfirmationState
  confidence?: number
}

export type RoleContextSections = Record<TwinContextSection, Array<Record<string, unknown>>>

export interface RoleContextBundle {
  role: AssistantRole
  profileMapping: {
    profileName: string | null
    stale: boolean
  }
  recipe: Pick<ContextRecipe, 'id' | 'name'> | null
  generatedAt: string
  query: string
  appliedScope: AssistantRoleDataScope
  appliedLimits: ContextRecipeLimits
  sections: RoleContextSections
  sourceRecordIds: Partial<Record<TwinContextSection, string[]>>
  provenance: Partial<Record<TwinContextSection, RoleContextProvenance[]>>
  truncated: {
    total: boolean
    sections: Partial<Record<TwinContextSection, boolean>>
  }
  renderedInstructions: string
}

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

export interface TwinProjectionWrite {
  key: string
  subjectId: string
  value: Record<string, unknown>
  sourceRecordId: string
  expectedVersion?: number
  updatedAt: string
}

export interface TwinArtifactInput {
  mediaType: string
  contentHash: string
  relativePath: string
  sizeBytes: number
  sensitivity: 'health' | 'general'
  metadata: Record<string, unknown>
  source: string
  sourceId: string
}

export interface TwinArtifact extends TwinArtifactInput {
  id: string
  createdAt: string
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

export interface TwinPreference {
  id: string
  subjectId: string
  domain: TwinDomain
  key: string
  value: unknown
  provenance: {
    source: string
    sourceId: string
    actor: string
    confidence: number
  }
  version: number
  createdAt: string
  updatedAt: string
}

export type TwinPreferenceExpectation = { state: 'absent' } | {
  state: 'present'
  version: number
  digest: string
}

export interface TwinPreferenceInput {
  subjectId: string
  domain: TwinDomain
  key: string
  value: unknown
  source: string
  sourceId: string
  actor: string
  operationId?: string
  expectedCurrent?: TwinPreferenceExpectation
  confidence?: number
}

export interface TwinPreferenceDeleteOperation {
  source: string
  sourceId: string
  actor: string
  expectedCurrent?: TwinPreferenceExpectation
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

export interface TwinObservationInput {
  entityId: string
  metric: string
  value: unknown
  unit?: string | null
  observedAt: string
  source: string
  sourceId: string
  actor: string
  confidence: number
  confirmationState: TwinConfirmationState
  evidence?: Array<Record<string, unknown>>
  schemaVersion?: number
}

export interface TwinEventInput {
  eventType: string
  subjectId?: string | null
  payload?: Record<string, unknown>
  occurredAt: string
  source: string
  sourceId: string
  actor: string
  confidence: number
  confirmationState: TwinConfirmationState
  evidence?: Array<Record<string, unknown>>
  schemaVersion?: number
}

export interface TwinLegacyImportResult {
  runId: string
  profiles: string[]
  status: 'completed' | 'failed'
  counts: { entities: number; observations: number; events: number; goals: number; constraints: number }
  startedAt: string
  completedAt: string
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

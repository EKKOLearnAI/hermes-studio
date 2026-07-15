import { createHash } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { HOME_FABRIC_CAPABILITIES } from '../home/fabric-contracts'
import { INTERNET_FABRIC_CAPABILITIES } from '../internet-execution/fabric-contracts'
import { withActionFabricDb } from './database'
import type {
  FabricCapability,
  FabricEnvironment,
  FabricExecutor,
  FabricExecutorCapability,
  FabricExecutorHealth,
  FabricExecutorType,
  FabricIdempotency,
  FabricJsonObject,
  FabricRisk,
  ResolvedFabricExecutor,
} from './types'

const SEMANTIC_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9][a-z0-9-]*)+$/
const EXECUTOR_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)*$/
const RISKS = new Set<FabricRisk>(['none', 'low', 'medium', 'high', 'critical'])
const IDEMPOTENCY = new Set<FabricIdempotency>(['required', 'supported', 'none'])
const EXECUTOR_TYPES = new Set<FabricExecutorType>(['simulator', 'internal', 'connector', 'mcp', 'browser'])
const ENVIRONMENTS = new Set<FabricEnvironment>(['simulator', 'internal', 'sandbox', 'production'])
const HEALTH = new Set<FabricExecutorHealth>(['unknown', 'healthy', 'degraded', 'unhealthy'])
const MAX_DESCRIPTION = 2_000
const MAX_JSON = 32_768
const MAX_ARRAY = 64
const MAX_ARRAY_ITEM = 256

export interface FabricCapabilityInput {
  id: string
  version: number
  description: string
  inputSchema: FabricJsonObject
  outputSchema: FabricJsonObject
  risk: FabricRisk
  sideEffect: boolean
  idempotency: FabricIdempotency
  reversible: boolean
  compensationCapabilityId: string | null
  verificationStrategy: string
  authentication: string[]
  targetRestrictions: string[]
  cost: { currency: string | null; estimatedMinor: number }
  enabled: boolean
}

export interface FabricExecutorInput {
  id: string
  type: FabricExecutorType
  name: string
  environment: FabricEnvironment
  configuration: FabricJsonObject
  enabled: boolean
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
  minProperties?: number,
): FabricJsonObject {
  return {
    type: 'object', additionalProperties: false, properties, required,
    ...(minProperties === undefined ? {} : { minProperties }),
  }
}

function boundedIdSchema(): FabricJsonObject {
  return { type: 'string', minLength: 1, maxLength: 160, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' }
}

function positiveIntegerSchema(): FabricJsonObject {
  return { type: 'integer', minimum: 1 }
}

function digestSchema(): FabricJsonObject {
  return { type: 'string', pattern: '^[a-f0-9]{64}$' }
}

function timestampSchema(): FabricJsonObject {
  return { type: 'string', format: 'date-time', maxLength: 64 }
}

function idArraySchema(): FabricJsonObject {
  return { type: 'array', maxItems: 64, items: boundedIdSchema() }
}

function pagedCountProperties(): Record<string, unknown> {
  return {
    totalCount: { type: 'integer', minimum: 0 }, omittedCount: { type: 'integer', minimum: 0 },
    continuationCursor: { type: ['string', 'null'], minLength: 1, maxLength: 2048 },
  }
}

function artifactAnalysisInputSchema(remote: boolean): FabricJsonObject {
  const properties: Record<string, unknown> = {
    schemaVersion: { const: 1 }, artifactId: boundedIdSchema(), manifestDigest: digestSchema(),
    requestedAt: timestampSchema(),
  }
  const required = ['schemaVersion', 'artifactId', 'manifestDigest', 'requestedAt']
  if (remote) {
    properties.processorId = boundedIdSchema()
    properties.consentId = boundedIdSchema()
    required.push('processorId', 'consentId')
  }
  return objectSchema(properties, required)
}

function artifactAnalysisOutputSchema(remote: boolean, explicitVerification = false): FabricJsonObject {
  const properties: Record<string, unknown> = {
    schemaVersion: { const: 1 }, artifactId: boundedIdSchema(), analysisId: boundedIdSchema(),
    status: { enum: ['succeeded', 'needs_review', 'failed'] }, observationIds: idArraySchema(),
    ...pagedCountProperties(),
  }
  const required = ['schemaVersion', 'artifactId', 'analysisId', 'status', 'observationIds',
    'totalCount', 'omittedCount', 'continuationCursor']
  if (remote) {
    properties.processorReceiptId = explicitVerification
      ? { type: ['string', 'null'], minLength: 1, maxLength: 160, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' }
      : boundedIdSchema()
    properties.consentId = boundedIdSchema()
    required.push('processorReceiptId', 'consentId')
    if (explicitVerification) {
      properties.verificationStatus = { enum: ['verified', 'unverifiable'] }
      required.push('verificationStatus')
    }
  }
  return objectSchema(properties, required)
}

function messageOutputSchema(): FabricJsonObject {
  return objectSchema({
    schemaVersion: { const: 1 }, deliveryId: boundedIdSchema(),
    providerMessageId: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
    status: { enum: ['delivered', 'accepted', 'unknown', 'shadowed'] },
  }, ['schemaVersion', 'deliveryId', 'providerMessageId', 'status'])
}

type CapabilityRow = {
  id: string; version: number; domain: string; verb: string; description: string
  input_schema_json: string; output_schema_json: string; risk: FabricRisk; side_effect: number
  idempotency: FabricIdempotency; reversible: number; compensation_capability_id: string | null
  verification_strategy: string; authentication_json: string; target_restrictions_json: string
  cost_currency: string | null; cost_estimated_minor: number; contract_digest: string; enabled: number
  created_at: string; updated_at: string
}

type ExecutorRow = {
  id: string; type: FabricExecutorType; name: string; environment: FabricEnvironment
  health: FabricExecutorHealth; health_details_json: string; configuration_json: string
  enabled: number; policy_version: number; created_at: string; updated_at: string
}

type BindingRow = {
  executor_id: string; capability_id: string; capability_version: number
  contract_digest: string; created_at: string
}

type ResolutionRow = {
  capability_id: string; capability_version: number; capability_domain: string; capability_verb: string
  capability_description: string; capability_input_schema_json: string; capability_output_schema_json: string
  capability_risk: FabricRisk; capability_side_effect: number; capability_idempotency: FabricIdempotency
  capability_reversible: number; capability_compensation_capability_id: string | null
  capability_verification_strategy: string; capability_authentication_json: string
  capability_target_restrictions_json: string; capability_cost_currency: string | null
  capability_cost_estimated_minor: number; capability_contract_digest: string; capability_enabled: number
  capability_created_at: string; capability_updated_at: string
  executor_id: string; executor_type: FabricExecutorType; executor_name: string
  executor_environment: FabricEnvironment; executor_health: FabricExecutorHealth
  executor_health_details_json: string; executor_configuration_json: string; executor_enabled: number
  executor_policy_version: number; executor_created_at: string; executor_updated_at: string
  binding_executor_id: string; binding_capability_id: string; binding_capability_version: number
  binding_contract_digest: string; binding_created_at: string
  policy_revision_value: string
}

const HEALTH_REMINDER_BASE = {
  id: 'health.reminder.send', description: 'Send one minimized health reminder to the configured self-recipient',
  outputSchema: messageOutputSchema(), risk: 'low' as const, sideEffect: true, idempotency: 'required' as const,
  reversible: false, compensationCapabilityId: null, verificationStrategy: 'provider_receipt_or_identity_lookup',
  authentication: ['live_mode:enabled', 'recipient:configured_self'], targetRestrictions: ['health:recipient'],
  cost: { currency: null, estimatedMinor: 0 }, enabled: true,
}
const HEALTH_REMINDER_V1: FabricCapabilityInput = {
  ...HEALTH_REMINDER_BASE, version: 1,
  inputSchema: objectSchema({
    schemaVersion: { const: 1 }, actionId: boundedIdSchema(), recipient: { const: 'configured-self' },
    messageCode: boundedIdSchema(), messageText: { type: 'string', minLength: 1, maxLength: 1000 },
  }, ['schemaVersion', 'actionId', 'recipient', 'messageCode', 'messageText']),
}
const HEALTH_REMINDER_TRANSITIONAL_V1: FabricCapabilityInput = {
  ...HEALTH_REMINDER_BASE, version: 1,
  inputSchema: objectSchema({
    schemaVersion: { const: 1 }, actionId: boundedIdSchema(), recipient: { const: 'configured-self' },
    messageCode: boundedIdSchema(),
  }, ['schemaVersion', 'actionId', 'recipient', 'messageCode']),
}
const HEALTH_REMINDER_V2: FabricCapabilityInput = {
  ...HEALTH_REMINDER_BASE, version: 2,
  inputSchema: objectSchema({
    schemaVersion: { const: 2 }, actionId: boundedIdSchema(), recipient: { const: 'configured-self' },
    messageCode: boundedIdSchema(),
  }, ['schemaVersion', 'actionId', 'recipient', 'messageCode']),
}

const REMOTE_ANALYSIS_V1: FabricCapabilityInput = {
  id: 'health.artifact.analyze.remote', version: 1,
  description: 'Analyze an exact health artifact with an authorized remote processor',
  inputSchema: artifactAnalysisInputSchema(true), outputSchema: artifactAnalysisOutputSchema(true),
  risk: 'medium', sideEffect: true, idempotency: 'required', reversible: false, compensationCapabilityId: null,
  verificationStrategy: 'processor_receipt_and_consumed_consent',
  authentication: ['one_time_consent:exact_artifact_manifest', 'processor:exact_id'],
  targetRestrictions: ['health:artifact', 'health:processor'], cost: { currency: null, estimatedMinor: 0 }, enabled: true,
}

const REMOTE_ANALYSIS_V2: FabricCapabilityInput = {
  ...REMOTE_ANALYSIS_V1, version: 2,
  description: 'Analyze an exact health artifact remotely with explicit provider receipt verification',
  outputSchema: artifactAnalysisOutputSchema(true, true),
  verificationStrategy: 'durable_analysis_and_explicit_provider_receipt',
}

const BUILT_IN_CAPABILITIES: FabricCapabilityInput[] = [
  {
    id: 'simulator.echo', version: 1, description: 'Echo structured input without external side effects',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, risk: 'none', sideEffect: false,
    idempotency: 'supported', reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'output_equals_input', authentication: [], targetRestrictions: ['simulator'],
    cost: { currency: null, estimatedMinor: 0 }, enabled: true,
  },
  {
    id: 'simulator.counter.increment', version: 1, description: 'Increment an isolated simulator counter',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, risk: 'low', sideEffect: true,
    idempotency: 'required', reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'counter_value_match', authentication: [], targetRestrictions: ['simulator'],
    cost: { currency: null, estimatedMinor: 0 }, enabled: true,
  },
  {
    id: 'internal.twin.preference.set', version: 1, description: 'Set a Personal Twin preference with a restorable prior value',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, risk: 'low', sideEffect: true,
    idempotency: 'required', reversible: true, compensationCapabilityId: 'internal.twin.preference.set',
    verificationStrategy: 'read_after_write', authentication: [], targetRestrictions: ['personal-twin'],
    cost: { currency: null, estimatedMinor: 0 }, enabled: true,
  },
  {
    id: 'health.plan.restore', version: 1, description: 'Restore an earlier health plan version with compare-and-set protection',
    inputSchema: objectSchema({
      schemaVersion: { const: 1 }, planId: boundedIdSchema(), expectedCurrentVersion: positiveIntegerSchema(),
      restoreVersion: positiveIntegerSchema(), restoreDigest: digestSchema(),
    }, ['schemaVersion', 'planId', 'expectedCurrentVersion', 'restoreVersion', 'restoreDigest']),
    outputSchema: objectSchema({
      schemaVersion: { const: 1 }, planId: boundedIdSchema(), restoredVersion: positiveIntegerSchema(),
      planDigest: digestSchema(), status: { enum: ['restored', 'cas_conflict'] },
    }, ['schemaVersion', 'planId', 'restoredVersion', 'planDigest', 'status']),
    risk: 'low', sideEffect: true, idempotency: 'required', reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'plan_version_compare_and_set', authentication: ['health_plan:write'],
    targetRestrictions: ['health:plan'], cost: { currency: null, estimatedMinor: 0 }, enabled: true,
  },
  {
    id: 'health.plan.adjust', version: 1, description: 'Apply a bounded reversible adjustment to an exact health plan version',
    inputSchema: objectSchema({
      schemaVersion: { const: 1 }, planId: boundedIdSchema(), expectedVersion: positiveIntegerSchema(),
      operation: { enum: ['reduce_training_intensity', 'review_energy_deficit', 'prioritize_food_protein',
        'reduce_constrained_chain_load'] },
      maximumIntensity: { enum: ['rest', 'low', 'moderate'] },
      targetG: { type: 'integer', minimum: 1, maximum: 500 },
      chains: { type: 'array', minItems: 1, maxItems: 32, items: boundedIdSchema() },
      reasonCode: boundedIdSchema(),
    }, ['schemaVersion', 'planId', 'expectedVersion', 'operation', 'reasonCode']),
    outputSchema: objectSchema({
      schemaVersion: { const: 1 }, planId: boundedIdSchema(), previousVersion: positiveIntegerSchema(),
      newVersion: positiveIntegerSchema(), previousDigest: digestSchema(), planDigest: digestSchema(),
    }, ['schemaVersion', 'planId', 'previousVersion', 'newVersion', 'previousDigest', 'planDigest']),
    risk: 'low', sideEffect: true, idempotency: 'required', reversible: true,
    compensationCapabilityId: 'health.plan.restore', verificationStrategy: 'plan_version_read_after_write',
    authentication: ['health_plan:write'], targetRestrictions: ['health:plan'],
    cost: { currency: null, estimatedMinor: 0 }, enabled: true,
  },
  {
    id: 'health.source.sync', version: 1, description: 'Synchronize an exact configured health source into canonical observations',
    inputSchema: objectSchema({
      schemaVersion: { const: 1 }, connectorId: boundedIdSchema(), requestedAt: timestampSchema(),
      cursor: { type: ['string', 'null'], maxLength: 2048 },
    }, ['schemaVersion', 'connectorId', 'requestedAt']),
    outputSchema: objectSchema({
      schemaVersion: { const: 1 }, connectorId: boundedIdSchema(), syncId: boundedIdSchema(),
      status: { enum: ['succeeded', 'partial', 'failed'] }, recordIds: idArraySchema(),
      ...pagedCountProperties(),
    }, ['schemaVersion', 'connectorId', 'syncId', 'status', 'recordIds',
      'totalCount', 'omittedCount', 'continuationCursor']),
    risk: 'low', sideEffect: true, idempotency: 'required', reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'connector_cursor_and_record_ids', authentication: ['connector_credential:configured'],
    targetRestrictions: ['health:connector'], cost: { currency: null, estimatedMinor: 0 }, enabled: true,
  },
  {
    id: 'health.artifact.analyze.local', version: 1, description: 'Analyze an exact health artifact locally without outbound disclosure',
    inputSchema: artifactAnalysisInputSchema(false),
    outputSchema: artifactAnalysisOutputSchema(false),
    risk: 'low', sideEffect: true, idempotency: 'required', reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'artifact_analysis_receipt', authentication: ['artifact:local_read'],
    targetRestrictions: ['health:artifact'], cost: { currency: null, estimatedMinor: 0 }, enabled: true,
  },
  REMOTE_ANALYSIS_V2,
  HEALTH_REMINDER_V2,
  {
    id: 'health.checkin.request', version: 1, description: 'Request one structured health check-in from the configured self-recipient',
    inputSchema: objectSchema({
      schemaVersion: { const: 1 }, checkinId: boundedIdSchema(), recipient: { const: 'configured-self' },
      operation: { enum: ['request_skin_recapture', 'request_marker_metadata'] },
      reasonCode: boundedIdSchema(), requiredFields: { type: 'array', minItems: 1, maxItems: 16, items: boundedIdSchema() },
      expiresAt: timestampSchema(),
    }, ['schemaVersion', 'checkinId', 'recipient', 'operation', 'expiresAt']),
    outputSchema: messageOutputSchema(), risk: 'low', sideEffect: true, idempotency: 'required', reversible: false,
    compensationCapabilityId: null, verificationStrategy: 'provider_receipt_or_identity_lookup',
    authentication: ['live_mode:enabled', 'recipient:configured_self'], targetRestrictions: ['health:recipient'],
    cost: { currency: null, estimatedMinor: 0 }, enabled: true,
  },
  {
    id: 'health.followup.schedule', version: 1, description: 'Schedule an exact bounded health follow-up for the requesting user',
    inputSchema: objectSchema({
      schemaVersion: { const: 1 }, followupId: boundedIdSchema(), ownerUserId: boundedIdSchema(),
      category: { enum: ['measurement', 'capture', 'recovery', 'nutrition', 'training', 'medical_review'] },
      operation: { enum: ['schedule_pain_followup', 'schedule_provider_flag_review'] },
      reasonCode: boundedIdSchema(), dueAt: timestampSchema(),
    }, ['schemaVersion', 'followupId', 'ownerUserId', 'category', 'operation', 'reasonCode', 'dueAt']),
    outputSchema: objectSchema({
      schemaVersion: { const: 1 }, followupId: boundedIdSchema(), scheduledAt: timestampSchema(),
      status: { enum: ['scheduled', 'superseded'] },
    }, ['schemaVersion', 'followupId', 'scheduledAt', 'status']),
    risk: 'medium', sideEffect: true, idempotency: 'required', reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'schedule_read_after_write', authentication: ['health_schedule:write'],
    targetRestrictions: ['health:owner'], cost: { currency: null, estimatedMinor: 0 }, enabled: true,
  },
  ...HOME_FABRIC_CAPABILITIES,
  ...INTERNET_FABRIC_CAPABILITIES,
]

const BUILT_IN_EXECUTORS: FabricExecutorInput[] = [
  { id: 'simulator-main', type: 'simulator', name: 'Phase 3 Simulator', environment: 'simulator', configuration: { externalWrite: false }, enabled: true },
  { id: 'internal-twin', type: 'internal', name: 'Personal Twin Internal Executor', environment: 'internal', configuration: { externalWrite: false }, enabled: true },
  { id: 'health-local-analysis', type: 'internal', name: 'Local Health Artifact Analyzer', environment: 'internal', configuration: { externalWrite: false, interruptible: false }, enabled: true },
  { id: 'health-plan', type: 'internal', name: 'Health Plan Executor', environment: 'internal', configuration: { externalWrite: false, interruptible: false }, enabled: true },
  { id: 'health-remote-analysis', type: 'connector', name: 'Authorized Remote Health Analyzer', environment: 'production', configuration: { externalWrite: true, interruptible: false }, enabled: true },
  { id: 'health-shadow', type: 'connector', name: 'Health Shadow Executor', environment: 'sandbox', configuration: { externalWrite: false, interruptible: true, shadow: true }, enabled: true },
  { id: 'health-source', type: 'connector', name: 'Health Source Connector', environment: 'production', configuration: { externalWrite: false, interruptible: false }, enabled: true },
  { id: 'health-weixin', type: 'connector', name: 'Weixin Self Reminder Executor', environment: 'production', configuration: { externalWrite: true, interruptible: false, recipientRestriction: 'configured-self' }, enabled: true },
  { id: 'home-assistant', type: 'connector', name: 'Home Assistant Executor', environment: 'production', configuration: { externalWrite: true, interruptible: false, managedAvailability: 'home-assistant' }, enabled: false },
  { id: 'bilibili-mcp', type: 'mcp', name: 'Bilibili Read-Only MCP Executor', environment: 'production', configuration: { externalWrite: false, interruptible: false, managedAvailability: 'bilibili-mcp', credentialScope: 'profile-runtime' }, enabled: false },
]

const BUILT_IN_BINDINGS = [
  ['simulator-main', 'simulator.echo'],
  ['simulator-main', 'simulator.counter.increment'],
  ['internal-twin', 'internal.twin.preference.set'],
  ['health-shadow', 'health.source.sync'],
  ['health-shadow', 'health.artifact.analyze.local'],
  ['health-shadow', 'health.artifact.analyze.remote'],
  ['health-shadow', 'health.plan.adjust'],
  ['health-shadow', 'health.plan.restore'],
  ['health-shadow', 'health.reminder.send'],
  ['health-shadow', 'health.checkin.request'],
  ['health-shadow', 'health.followup.schedule'],
  ['health-source', 'health.source.sync'],
  ['health-local-analysis', 'health.artifact.analyze.local'],
  ['health-remote-analysis', 'health.artifact.analyze.remote'],
  ['health-plan', 'health.plan.adjust'],
  ['health-plan', 'health.plan.restore'],
  ['health-plan', 'health.followup.schedule'],
  ['health-weixin', 'health.reminder.send'],
  ['health-weixin', 'health.checkin.request'],
  ['home-assistant', 'home.device.refresh'],
  ['home-assistant', 'home.device.set_level'],
  ['home-assistant', 'home.device.set_power'],
  ['home-assistant', 'home.device.set_temperature'],
  ['home-assistant', 'home.scene.activate.safe'],
  ['bilibili-mcp', 'bilibili.video.search'],
  ['bilibili-mcp', 'bilibili.video.inspect'],
] as const

export function ensureBuiltInFabricRegistry(): void {
  withActionFabricDb(db => {
    if (hasCompleteBuiltInRegistry(db) && hasValidExternalWriteClassification(db)) return
    transaction(db, () => {
      const wasComplete = hasCompleteBuiltInRegistry(db)
      for (const input of BUILT_IN_CAPABILITIES) {
        if (input.id === HEALTH_REMINDER_V2.id) ensureReminderCapability(db)
        else if (input.id === REMOTE_ANALYSIS_V2.id) ensureRemoteAnalysisCapability(db)
        else insertCapabilityIfMissing(db, input)
      }
      for (const input of BUILT_IN_EXECUTORS) {
        insertExecutorIfMissing(db, input)
        if (['health-local-analysis', 'health-remote-analysis', 'health-plan', 'health-source', 'home-assistant', 'bilibili-mcp'].includes(input.id)) {
          ensureKnownExecutorConfiguration(db, input)
        }
      }
      for (const [executorId, capabilityId] of BUILT_IN_BINDINGS) {
        const capability = selectCapability(db, capabilityId)
        if (!capability) throw new Error(`Built-in capability is missing: ${capabilityId}`)
        if (capabilityId === HEALTH_REMINDER_V2.id || capabilityId === REMOTE_ANALYSIS_V2.id) upsertBinding(db, executorId, capability)
        else insertBindingIfMissing(db, executorId, capability)
      }
      const backfilled = backfillExternalWriteClassification(db)
      if (!wasComplete || backfilled) bumpRegistryPolicyRevision(db)
    })
  })
}

export function listFabricCapabilities(): FabricCapability[] {
  return withActionFabricDb(db => (db.prepare('SELECT * FROM fabric_capabilities ORDER BY id').all() as CapabilityRow[]).map(parseCapability))
}

export function getFabricCapability(id: string): FabricCapability | null {
  return withActionFabricDb(db => selectCapability(db, id))
}

export function listFabricExecutors(): FabricExecutor[] {
  return withActionFabricDb(db => (db.prepare('SELECT * FROM fabric_executors ORDER BY id').all() as ExecutorRow[]).map(parseExecutor))
}

export function createFabricCapability(input: FabricCapabilityInput): FabricCapability {
  const normalized = validateCapability(input)
  return withActionFabricDb(db => transaction(db, () => {
    const existing = selectCapability(db, normalized.id)
    const digest = capabilityDigest(normalized)
    if (existing) {
      if (existing.version === normalized.version && existing.contractDigest !== digest) {
        throw new Error(`Capability contract cannot change silently at version ${normalized.version}`)
      }
      throw new Error(`Capability already exists: ${normalized.id}`)
    }
    insertCapability(db, normalized, digest)
    bumpRegistryPolicyRevision(db)
    return selectCapability(db, normalized.id)!
  }))
}

export function updateFabricCapability(
  id: string,
  updates: Partial<Omit<FabricCapabilityInput, 'id'>>,
): FabricCapability {
  return withActionFabricDb(db => transaction(db, () => {
    const existing = selectCapability(db, id)
    if (!existing) throw new Error(`Capability not found: ${id}`)
    const input = validateCapability({
      id: existing.id, version: existing.version, description: existing.description,
      inputSchema: existing.inputSchema, outputSchema: existing.outputSchema, risk: existing.risk,
      sideEffect: existing.sideEffect, idempotency: existing.idempotency, reversible: existing.reversible,
      compensationCapabilityId: existing.compensationCapabilityId,
      verificationStrategy: existing.verificationStrategy, authentication: existing.authentication,
      targetRestrictions: existing.targetRestrictions, cost: existing.cost, enabled: existing.enabled,
      ...updates,
    })
    const semanticsChanged = semanticDigest(input) !== semanticDigest({
      id: existing.id, version: existing.version, description: existing.description,
      inputSchema: existing.inputSchema, outputSchema: existing.outputSchema, risk: existing.risk,
      sideEffect: existing.sideEffect, idempotency: existing.idempotency, reversible: existing.reversible,
      compensationCapabilityId: existing.compensationCapabilityId,
      verificationStrategy: existing.verificationStrategy, authentication: existing.authentication,
      targetRestrictions: existing.targetRestrictions, cost: existing.cost, enabled: existing.enabled,
    })
    if (semanticsChanged && input.version <= existing.version) {
      throw new Error('Capability contract version must increase for semantic changes')
    }
    if (input.version < existing.version) throw new Error('Capability contract version must not decrease')
    const digest = capabilityDigest(input)
    const now = new Date().toISOString()
    db.prepare(`UPDATE fabric_capabilities SET version=?, description=?, input_schema_json=?, output_schema_json=?, risk=?,
      side_effect=?, idempotency=?, reversible=?, compensation_capability_id=?, verification_strategy=?,
      authentication_json=?, target_restrictions_json=?, cost_currency=?, cost_estimated_minor=?,
      contract_digest=?, enabled=?, updated_at=? WHERE id=?`).run(
      input.version, input.description, json(input.inputSchema), json(input.outputSchema), input.risk, Number(input.sideEffect),
      input.idempotency, Number(input.reversible), input.compensationCapabilityId, input.verificationStrategy,
      json(input.authentication), json(input.targetRestrictions), input.cost.currency, input.cost.estimatedMinor,
      digest, Number(input.enabled), now, id,
    )
    insertCapabilityHistory(db, input, digest, now)
    bumpRegistryPolicyRevision(db)
    return selectCapability(db, id)!
  }))
}

export function createFabricExecutor(input: FabricExecutorInput): FabricExecutor {
  const normalized = validateExecutor(input)
  return withActionFabricDb(db => transaction(db, () => {
    if (selectExecutor(db, normalized.id)) throw new Error(`Executor already exists: ${normalized.id}`)
    insertExecutor(db, normalized)
    bumpRegistryPolicyRevision(db)
    return selectExecutor(db, normalized.id)!
  }))
}

export function updateFabricExecutor(
  id: string,
  updates: Partial<Omit<FabricExecutorInput, 'id'>>,
): FabricExecutor {
  return withActionFabricDb(db => transaction(db, () => {
    const existing = selectExecutor(db, id)
    if (!existing) throw new Error(`Executor not found: ${id}`)
    const input = validateExecutor({
      id, type: existing.type, name: existing.name, environment: existing.environment,
      configuration: existing.configuration,
      enabled: existing.enabled, ...updates,
    })
    db.prepare(`UPDATE fabric_executors SET type=?, name=?, environment=?, configuration_json=?, enabled=?,
      policy_version=policy_version+1, updated_at=? WHERE id=?`).run(
      input.type, input.name, input.environment, json(input.configuration), Number(input.enabled), new Date().toISOString(), id,
    )
    bumpRegistryPolicyRevision(db)
    return selectExecutor(db, id)!
  }))
}

export function setFabricExecutorEnabled(id: string, enabled: boolean): FabricExecutor {
  if (typeof enabled !== 'boolean') throw new Error('Executor enabled must be boolean')
  return updateFabricExecutor(id, { enabled })
}

export function updateFabricExecutorHealth(
  id: string,
  health: FabricExecutorHealth,
  details: FabricJsonObject,
): FabricExecutor {
  if (!HEALTH.has(health)) throw new Error(`Invalid executor health: ${String(health)}`)
  assertJsonObject(details, 'health details')
  assertJsonBound(details, 'health details')
  return withActionFabricDb(db => transaction(db, () => {
    if (!selectExecutor(db, id)) throw new Error(`Executor not found: ${id}`)
    db.prepare(`UPDATE fabric_executors SET health=?, health_details_json=?, policy_version=policy_version+1,
      updated_at=? WHERE id=?`).run(health, json(details), new Date().toISOString(), id)
    bumpRegistryPolicyRevision(db)
    return selectExecutor(db, id)!
  }))
}

export function bindFabricExecutorCapability(
  executorId: string,
  capabilityId: string,
  capabilityVersion: number,
  contractDigest: string,
): FabricExecutorCapability {
  return withActionFabricDb(db => transaction(db, () => {
    if (!selectExecutor(db, executorId)) throw new Error(`Executor not found: ${executorId}`)
    const capability = selectCapability(db, capabilityId)
    if (!capability) throw new Error(`Capability not found: ${capabilityId}`)
    if (capability.version !== capabilityVersion) throw new Error('Binding version must match capability version')
    if (capability.contractDigest !== contractDigest) throw new Error('Binding digest must match capability contract digest')
    upsertBinding(db, executorId, capability)
    bumpRegistryPolicyRevision(db)
    return parseBinding(db.prepare(`SELECT * FROM fabric_executor_capabilities
      WHERE executor_id=? AND capability_id=?`).get(executorId, capabilityId) as BindingRow)
  }))
}

export function resolveFabricExecutor(
  capabilityId: string,
  options: { environments: FabricEnvironment[]; executorId?: string },
): ResolvedFabricExecutor | null {
  const environments = normalizeEnvironments(options.environments)
  return withActionFabricDb(db => resolveFabricExecutorInDb(db, capabilityId, { environments, executorId: options.executorId }))
}

export function resolveFabricExecutorInDb(
  db: DatabaseSync,
  capabilityId: string,
  options: { environments: FabricEnvironment[]; executorId?: string },
): ResolvedFabricExecutor | null {
  const environments = normalizeEnvironments(options.environments)
  const placeholders = environments.map(() => '?').join(',')
  const priority = environments.map((_, index) => `WHEN ? THEN ${index}`).join(' ')
  const row = db.prepare(`WITH registry_revision AS (
      SELECT value FROM fabric_meta WHERE key='registry_policy_revision'
    )
      SELECT
      c.id AS capability_id, c.version AS capability_version, c.domain AS capability_domain,
      c.verb AS capability_verb, c.description AS capability_description,
      c.input_schema_json AS capability_input_schema_json, c.output_schema_json AS capability_output_schema_json,
      c.risk AS capability_risk, c.side_effect AS capability_side_effect,
      c.idempotency AS capability_idempotency, c.reversible AS capability_reversible,
      c.compensation_capability_id AS capability_compensation_capability_id,
      c.verification_strategy AS capability_verification_strategy,
      c.authentication_json AS capability_authentication_json,
      c.target_restrictions_json AS capability_target_restrictions_json,
      c.cost_currency AS capability_cost_currency, c.cost_estimated_minor AS capability_cost_estimated_minor,
      c.contract_digest AS capability_contract_digest, c.enabled AS capability_enabled,
      c.created_at AS capability_created_at, c.updated_at AS capability_updated_at,
      e.id AS executor_id, e.type AS executor_type, e.name AS executor_name,
      e.environment AS executor_environment, e.health AS executor_health,
      e.health_details_json AS executor_health_details_json,
      e.configuration_json AS executor_configuration_json, e.enabled AS executor_enabled,
      e.policy_version AS executor_policy_version, e.created_at AS executor_created_at,
      e.updated_at AS executor_updated_at,
      b.executor_id AS binding_executor_id,
      b.capability_id AS binding_capability_id, b.capability_version AS binding_capability_version,
      b.contract_digest AS binding_contract_digest, b.created_at AS binding_created_at,
      r.value AS policy_revision_value
      FROM fabric_capabilities c
      JOIN fabric_executor_capabilities b ON b.capability_id=c.id
        AND b.capability_version=c.version AND b.contract_digest=c.contract_digest
      JOIN fabric_executors e ON e.id=b.executor_id
      CROSS JOIN registry_revision r
      WHERE c.id=? AND c.enabled=1
        AND e.enabled=1 AND e.health='healthy' AND e.environment IN (${placeholders})
        AND (? IS NULL OR e.id=?)
      ORDER BY CASE e.environment ${priority} ELSE ${environments.length} END, e.id LIMIT 1`).get(
    capabilityId, ...environments, options.executorId ?? null, options.executorId ?? null, ...environments,
  ) as ResolutionRow | undefined
  if (!row) return null
  const capability = parseCapability({
      id: row.capability_id, version: row.capability_version, domain: row.capability_domain,
      verb: row.capability_verb, description: row.capability_description,
      input_schema_json: row.capability_input_schema_json, output_schema_json: row.capability_output_schema_json,
      risk: row.capability_risk, side_effect: row.capability_side_effect,
      idempotency: row.capability_idempotency, reversible: row.capability_reversible,
      compensation_capability_id: row.capability_compensation_capability_id,
      verification_strategy: row.capability_verification_strategy,
      authentication_json: row.capability_authentication_json,
      target_restrictions_json: row.capability_target_restrictions_json,
      cost_currency: row.capability_cost_currency, cost_estimated_minor: row.capability_cost_estimated_minor,
      contract_digest: row.capability_contract_digest, enabled: row.capability_enabled,
      created_at: row.capability_created_at, updated_at: row.capability_updated_at,
    })
  const executor = parseExecutor({
      id: row.executor_id, type: row.executor_type, name: row.executor_name,
      environment: row.executor_environment, health: row.executor_health,
      health_details_json: row.executor_health_details_json,
      configuration_json: row.executor_configuration_json, enabled: row.executor_enabled,
      policy_version: row.executor_policy_version, created_at: row.executor_created_at,
      updated_at: row.executor_updated_at,
    })
  const binding: FabricExecutorCapability = {
      executorId: row.binding_executor_id, capabilityId: row.binding_capability_id,
      capabilityVersion: row.binding_capability_version, contractDigest: row.binding_contract_digest,
      createdAt: row.binding_created_at,
    }
  const policyRevision = parseRegistryPolicyRevision(row.policy_revision_value)
  return {
      executor, capability, binding, policyRevision,
      policyEvaluationToken: digest({
        policyRevision,
        capabilityId: capability.id, capabilityVersion: capability.version,
        capabilityDigest: capability.contractDigest, risk: capability.risk,
        executorId: executor.id, executorType: executor.type, environment: executor.environment,
        health: executor.health, enabled: executor.enabled, policyVersion: executor.policyVersion,
      }),
  }
}

function hasCompleteBuiltInRegistry(db: DatabaseSync): boolean {
  const capabilities = BUILT_IN_CAPABILITIES.every(input => {
    const current = selectCapability(db, input.id)
    return current?.version === input.version && current.contractDigest === capabilityDigest(input)
      && hasCapabilityHistory(db, input)
  }) && hasCapabilityHistory(db, HEALTH_REMINDER_V1) && hasCapabilityHistory(db, REMOTE_ANALYSIS_V1)
  const executors = BUILT_IN_EXECUTORS.every(input => {
    const current = selectExecutor(db, input.id)
    const normalized = validateExecutor(input)
    return current?.type === normalized.type && current.name === normalized.name && current.environment === normalized.environment
      && stableStringify(current.configuration) === stableStringify(normalized.configuration)
  })
  const bindings = BUILT_IN_BINDINGS.every(([executorId, capabilityId]) => {
    const expected = BUILT_IN_CAPABILITIES.find(item => item.id === capabilityId)
    const row = db.prepare(`SELECT capability_version,contract_digest FROM fabric_executor_capabilities
      WHERE executor_id=? AND capability_id=?`).get(executorId, capabilityId) as
      { capability_version: number; contract_digest: string } | undefined
    return !!expected && row?.capability_version === expected.version && row.contract_digest === capabilityDigest(expected)
  })
  const hasPolicyRevision = db.prepare("SELECT 1 AS present FROM fabric_meta WHERE key='registry_policy_revision'").get() !== undefined
  return capabilities && executors && bindings && hasPolicyRevision
}

function hasValidExternalWriteClassification(db: DatabaseSync): boolean {
  const rows = db.prepare(`SELECT configuration_json FROM fabric_executors
    ORDER BY id`).all() as Array<{ configuration_json: string }>
  return rows.every(row => {
    try {
      const value = JSON.parse(row.configuration_json) as Record<string, unknown>
      return typeof value.externalWrite === 'boolean'
    } catch { return false }
  })
}

function backfillExternalWriteClassification(db: DatabaseSync): boolean {
  const rows = db.prepare(`SELECT id,type,configuration_json FROM fabric_executors ORDER BY id`).all() as
    Array<{ id: string; type: string; configuration_json: string }>
  let changed = false
  for (const row of rows) {
    let configuration: FabricJsonObject = {}
    try {
      const parsed = JSON.parse(row.configuration_json) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) configuration = parsed as FabricJsonObject
    } catch { /* known built-ins are safe to reconstruct */ }
    if (typeof configuration.externalWrite === 'boolean') continue
    const externalWrite = normalizeExternalWrite(row.type, row.id, configuration.externalWrite)
    db.prepare(`UPDATE fabric_executors SET configuration_json=?,policy_version=policy_version+1,updated_at=?
      WHERE id=?`).run(json({ ...configuration, externalWrite }), new Date().toISOString(), row.id)
    changed = true
  }
  return changed
}

function validateCapability(input: FabricCapabilityInput): FabricCapabilityInput {
  if (!SEMANTIC_ID.test(input.id) || input.id.length > 160) throw new Error('Invalid capability semantic ID')
  if (!Number.isSafeInteger(input.version) || input.version <= 0) throw new Error('Capability version must be positive')
  if (typeof input.description !== 'string' || !input.description.trim()) throw new Error('Capability description must not be empty')
  if (input.description.length > MAX_DESCRIPTION) throw new Error('Capability description is too large')
  assertJsonObject(input.inputSchema, 'input schema'); assertJsonBound(input.inputSchema, 'input schema')
  assertJsonObject(input.outputSchema, 'output schema'); assertJsonBound(input.outputSchema, 'output schema')
  if (!RISKS.has(input.risk)) throw new Error(`Invalid capability risk: ${String(input.risk)}`)
  if (typeof input.sideEffect !== 'boolean' || typeof input.reversible !== 'boolean' || typeof input.enabled !== 'boolean') {
    throw new Error('Capability boolean fields must be boolean')
  }
  if (!IDEMPOTENCY.has(input.idempotency)) throw new Error('Invalid capability idempotency')
  if (typeof input.verificationStrategy !== 'string' || !input.verificationStrategy.trim()) {
    throw new Error('Capability verification strategy must not be empty')
  }
  if (input.verificationStrategy.length > MAX_ARRAY_ITEM) throw new Error('Capability verification strategy is too large')
  if (input.reversible && !input.compensationCapabilityId) throw new Error('Reversible capability must declare compensation')
  if (!input.reversible && input.compensationCapabilityId) throw new Error('Irreversible capability must not declare compensation')
  if (input.compensationCapabilityId && !SEMANTIC_ID.test(input.compensationCapabilityId)) throw new Error('Invalid compensation capability ID')
  assertStringArray(input.authentication, 'authentication')
  assertStringArray(input.targetRestrictions, 'target restrictions')
  if (!input.cost || !Number.isSafeInteger(input.cost.estimatedMinor) || input.cost.estimatedMinor < 0) {
    throw new Error('Capability cost must be a non-negative integer')
  }
  if (input.cost.currency === null && input.cost.estimatedMinor !== 0) throw new Error('Capability cost currency and amount must be paired')
  if (input.cost.currency !== null && !/^[A-Z]{3}$/.test(input.cost.currency)) throw new Error('Invalid capability cost currency')
  return input
}

function validateExecutor(input: FabricExecutorInput): FabricExecutorInput {
  if (!EXECUTOR_TYPES.has(input.type)) throw new Error(`Unsupported executor type: ${String(input.type)}`)
  if (!EXECUTOR_ID.test(input.id) || input.id.length > 160) throw new Error('Invalid executor ID')
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 256) throw new Error('Invalid executor name')
  if (!ENVIRONMENTS.has(input.environment)) throw new Error(`Invalid executor environment: ${String(input.environment)}`)
  assertJsonObject(input.configuration, 'executor configuration'); assertJsonBound(input.configuration, 'executor configuration')
  if (['connector', 'mcp', 'browser'].includes(input.type)
    && typeof input.configuration.externalWrite !== 'boolean') {
    throw new Error('External executor must explicitly classify externalWrite')
  }
  if (typeof input.enabled !== 'boolean') throw new Error('Executor enabled must be boolean')
  return { ...input, configuration: { ...input.configuration,
    externalWrite: normalizeExternalWrite(input.type, input.id, input.configuration.externalWrite) } }
}

function normalizeExternalWrite(type: string, id: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (type === 'simulator' || id === 'internal-twin') return false
  return true
}

function insertCapabilityIfMissing(db: DatabaseSync, input: FabricCapabilityInput): void {
  if (selectCapability(db, input.id)) return
  const normalized = validateCapability(input)
  insertCapability(db, normalized, capabilityDigest(normalized))
}

function ensureReminderCapability(db: DatabaseSync): void {
  const current = selectCapability(db, HEALTH_REMINDER_V2.id)
  if (!current) {
    insertCapability(db, validateCapability(HEALTH_REMINDER_V2), capabilityDigest(HEALTH_REMINDER_V2))
    insertCapabilityHistory(db, HEALTH_REMINDER_V1, capabilityDigest(HEALTH_REMINDER_V1), new Date().toISOString())
    return
  }
  insertCapabilityHistory(db, HEALTH_REMINDER_V1, capabilityDigest(HEALTH_REMINDER_V1), new Date().toISOString())
  const actualDigest = capabilityDigest(capabilityInput(current))
  if (actualDigest !== current.contractDigest) throw new Error('Health reminder contract digest is unknown')
  if (current.version === 1) {
    const permitted = new Set([capabilityDigest(HEALTH_REMINDER_V1), capabilityDigest(HEALTH_REMINDER_TRANSITIONAL_V1)])
    if (!permitted.has(current.contractDigest)) throw new Error('Health reminder contract digest is unknown')
    replaceCapabilityContract(db, HEALTH_REMINDER_V2)
    return
  }
  if (current.version !== HEALTH_REMINDER_V2.version
    || current.contractDigest !== capabilityDigest(HEALTH_REMINDER_V2)) {
    throw new Error('Health reminder contract digest is unknown')
  }
  insertCapabilityHistory(db, HEALTH_REMINDER_V2, current.contractDigest, current.createdAt)
}

function ensureRemoteAnalysisCapability(db: DatabaseSync): void {
  const current = selectCapability(db, REMOTE_ANALYSIS_V2.id)
  const now = new Date().toISOString()
  if (!current) {
    insertCapability(db, validateCapability(REMOTE_ANALYSIS_V2), capabilityDigest(REMOTE_ANALYSIS_V2))
    insertCapabilityHistory(db, REMOTE_ANALYSIS_V1, capabilityDigest(REMOTE_ANALYSIS_V1), now)
    return
  }
  insertCapabilityHistory(db, REMOTE_ANALYSIS_V1, capabilityDigest(REMOTE_ANALYSIS_V1), now)
  const actualDigest = capabilityDigest(capabilityInput(current))
  if (actualDigest !== current.contractDigest) throw new Error('Remote analysis contract digest is unknown')
  if (current.version === 1) {
    if (current.contractDigest !== capabilityDigest(REMOTE_ANALYSIS_V1)) throw new Error('Remote analysis contract digest is unknown')
    replaceCapabilityContract(db, REMOTE_ANALYSIS_V2)
    return
  }
  if (current.version !== 2 || current.contractDigest !== capabilityDigest(REMOTE_ANALYSIS_V2)) {
    throw new Error('Remote analysis contract digest is unknown')
  }
  insertCapabilityHistory(db, REMOTE_ANALYSIS_V2, current.contractDigest, current.createdAt)
}

function replaceCapabilityContract(db: DatabaseSync, input: FabricCapabilityInput): void {
  const normalized = validateCapability(input)
  const contractDigest = capabilityDigest(normalized)
  const [domain, ...verbParts] = normalized.id.split(/[._:-]/)
  const now = new Date().toISOString()
  const changed = db.prepare(`UPDATE fabric_capabilities SET version=?,domain=?,verb=?,description=?,input_schema_json=?,
    output_schema_json=?,risk=?,side_effect=?,idempotency=?,reversible=?,compensation_capability_id=?,
    verification_strategy=?,authentication_json=?,target_restrictions_json=?,cost_currency=?,cost_estimated_minor=?,
    contract_digest=?,updated_at=? WHERE id=?`).run(
    normalized.version, domain, verbParts.join('.'), normalized.description, json(normalized.inputSchema),
    json(normalized.outputSchema), normalized.risk, Number(normalized.sideEffect), normalized.idempotency,
    Number(normalized.reversible), normalized.compensationCapabilityId, normalized.verificationStrategy,
    json(normalized.authentication), json(normalized.targetRestrictions), normalized.cost.currency,
    normalized.cost.estimatedMinor, contractDigest, now, normalized.id,
  )
  if (changed.changes !== 1) throw new Error(`Built-in capability contract migration failed: ${normalized.id}`)
  insertCapabilityHistory(db, normalized, contractDigest, now)
}

function ensureKnownExecutorConfiguration(db: DatabaseSync, input: FabricExecutorInput): void {
  const current = selectExecutor(db, input.id)
  const expected = validateExecutor(input)
  if (!current || current.type !== expected.type || current.name !== expected.name || current.environment !== expected.environment) {
    throw new Error(`Built-in executor metadata mismatch: ${input.id}`)
  }
  if (stableStringify(current.configuration) === stableStringify(expected.configuration)) return
  const legacy = { ...expected.configuration, interruptible: true }
  if (stableStringify(current.configuration) !== stableStringify(legacy)) {
    throw new Error(`Built-in executor configuration mismatch: ${input.id}`)
  }
  db.prepare(`UPDATE fabric_executors SET configuration_json=?,policy_version=policy_version+1,updated_at=? WHERE id=?`)
    .run(json(expected.configuration), new Date().toISOString(), input.id)
}

function insertCapabilityHistory(db: DatabaseSync, input: FabricCapabilityInput, contractDigest: string, createdAt: string): void {
  const contract = capabilityContract(input)
  const existing = db.prepare(`SELECT contract_json,contract_digest FROM fabric_capability_contract_history
    WHERE capability_id=? AND version=?`).get(input.id, input.version) as
    { contract_json: string; contract_digest: string } | undefined
  if (existing) {
    let stored: unknown
    try { stored = JSON.parse(existing.contract_json) } catch { throw new Error('Capability contract history is corrupt') }
    if (existing.contract_digest !== contractDigest || stableStringify(stored) !== stableStringify(contract)) {
      throw new Error(`Capability contract history conflict: ${input.id}@${input.version}`)
    }
    return
  }
  db.prepare(`INSERT INTO fabric_capability_contract_history
    (capability_id,version,contract_json,contract_digest,created_at) VALUES(?,?,?,?,?)`)
    .run(input.id, input.version, json(contract), contractDigest, createdAt)
}

function hasCapabilityHistory(db: DatabaseSync, input: FabricCapabilityInput): boolean {
  const row = db.prepare(`SELECT contract_json,contract_digest FROM fabric_capability_contract_history
    WHERE capability_id=? AND version=?`).get(input.id, input.version) as
    { contract_json: string; contract_digest: string } | undefined
  if (!row || row.contract_digest !== capabilityDigest(input)) return false
  try { return stableStringify(JSON.parse(row.contract_json)) === stableStringify(capabilityContract(input)) }
  catch { return false }
}

function capabilityContract(input: FabricCapabilityInput): Omit<FabricCapabilityInput, 'enabled'> {
  const { enabled: _enabled, ...contract } = input
  return contract
}

function capabilityInput(value: FabricCapability): FabricCapabilityInput {
  return { id: value.id, version: value.version, description: value.description, inputSchema: value.inputSchema,
    outputSchema: value.outputSchema, risk: value.risk, sideEffect: value.sideEffect, idempotency: value.idempotency,
    reversible: value.reversible, compensationCapabilityId: value.compensationCapabilityId,
    verificationStrategy: value.verificationStrategy, authentication: value.authentication,
    targetRestrictions: value.targetRestrictions, cost: value.cost, enabled: value.enabled }
}

function insertCapability(db: DatabaseSync, input: FabricCapabilityInput, contractDigest: string): void {
  const [domain, ...verbParts] = input.id.split(/[._:-]/)
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO fabric_capabilities(id, version, domain, verb, description, input_schema_json,
    output_schema_json, risk, side_effect, idempotency, reversible, compensation_capability_id,
    verification_strategy, authentication_json, target_restrictions_json, cost_currency,
    cost_estimated_minor, contract_digest, enabled, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.id, input.version, domain, verbParts.join('.'), input.description, json(input.inputSchema),
    json(input.outputSchema), input.risk, Number(input.sideEffect), input.idempotency, Number(input.reversible),
    input.compensationCapabilityId, input.verificationStrategy, json(input.authentication),
    json(input.targetRestrictions), input.cost.currency, input.cost.estimatedMinor, contractDigest,
    Number(input.enabled), now, now,
  )
  insertCapabilityHistory(db, input, contractDigest, now)
}

function insertExecutorIfMissing(db: DatabaseSync, input: FabricExecutorInput): void {
  if (selectExecutor(db, input.id)) return
  insertExecutor(db, validateExecutor(input))
}

function insertExecutor(db: DatabaseSync, input: FabricExecutorInput): void {
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO fabric_executors(id,type,name,environment,health,health_details_json,
    configuration_json,enabled,policy_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)`).run(
    input.id, input.type, input.name, input.environment, 'healthy', '{}', json(input.configuration),
    Number(input.enabled), now, now,
  )
}

function insertBindingIfMissing(db: DatabaseSync, executorId: string, capability: FabricCapability): void {
  const existing = db.prepare(`SELECT capability_version, contract_digest FROM fabric_executor_capabilities
    WHERE executor_id=? AND capability_id=?`).get(executorId, capability.id) as { capability_version: number; contract_digest: string } | undefined
  if (existing) return
  db.prepare(`INSERT INTO fabric_executor_capabilities(executor_id,capability_id,capability_version,
    contract_digest,created_at) VALUES(?,?,?,?,?)`).run(
    executorId, capability.id, capability.version, capability.contractDigest, new Date().toISOString(),
  )
}

function upsertBinding(db: DatabaseSync, executorId: string, capability: FabricCapability): void {
  db.prepare(`INSERT INTO fabric_executor_capabilities(executor_id,capability_id,capability_version,
    contract_digest,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(executor_id, capability_id) DO UPDATE SET
      capability_version=excluded.capability_version,
      contract_digest=excluded.contract_digest,
      created_at=excluded.created_at`).run(
    executorId, capability.id, capability.version, capability.contractDigest, new Date().toISOString(),
  )
}

function selectCapability(db: DatabaseSync, id: string): FabricCapability | null {
  const row = db.prepare('SELECT * FROM fabric_capabilities WHERE id=?').get(id) as CapabilityRow | undefined
  return row ? parseCapability(row) : null
}

function selectExecutor(db: DatabaseSync, id: string): FabricExecutor | null {
  const row = db.prepare('SELECT * FROM fabric_executors WHERE id=?').get(id) as ExecutorRow | undefined
  return row ? parseExecutor(row) : null
}

function parseCapability(row: CapabilityRow): FabricCapability {
  return {
    id: row.id, version: row.version, domain: row.domain, verb: row.verb, description: row.description,
    inputSchema: parseObject(row.input_schema_json, 'capability input schema'),
    outputSchema: parseObject(row.output_schema_json, 'capability output schema'), risk: row.risk,
    sideEffect: row.side_effect === 1, idempotency: row.idempotency, reversible: row.reversible === 1,
    compensationCapabilityId: row.compensation_capability_id, verificationStrategy: row.verification_strategy,
    authentication: parseStringArray(row.authentication_json, 'capability authentication'),
    targetRestrictions: parseStringArray(row.target_restrictions_json, 'capability target restrictions'),
    cost: { currency: row.cost_currency, estimatedMinor: row.cost_estimated_minor },
    contractDigest: row.contract_digest, enabled: row.enabled === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function parseExecutor(row: ExecutorRow): FabricExecutor {
  return {
    id: row.id, type: row.type, name: row.name, environment: row.environment, health: row.health,
    healthDetails: parseObject(row.health_details_json, 'executor health details'),
    configuration: parseObject(row.configuration_json, 'executor configuration'), enabled: row.enabled === 1,
    policyVersion: row.policy_version, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function parseBinding(row: BindingRow): FabricExecutorCapability {
  return { executorId: row.executor_id, capabilityId: row.capability_id, capabilityVersion: row.capability_version,
    contractDigest: row.contract_digest, createdAt: row.created_at }
}

function capabilityDigest(input: FabricCapabilityInput): string {
  const { enabled: _enabled, ...contract } = input
  return digest(contract)
}

function semanticDigest(input: FabricCapabilityInput): string {
  const { enabled: _enabled, version: _version, ...semantics } = input
  return digest(semantics)
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function json(value: unknown): string { return JSON.stringify(value) }

function parseObject(value: string, label: string): FabricJsonObject {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error(`Invalid ${label} JSON`) }
  assertJsonObject(parsed, label)
  return parsed
}

function parseStringArray(value: string, label: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error(`Invalid ${label} JSON`) }
  assertStringArray(parsed, label)
  return parsed
}

function assertJsonObject(value: unknown, label: string): asserts value is FabricJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`)
}

function assertJsonBound(value: unknown, label: string): void {
  assertStrictJson(value, label, new WeakSet())
  const serialized = JSON.stringify(value)
  if (serialized.length > MAX_JSON) throw new Error(`${label} JSON is too large`)
}

function assertStrictJson(value: unknown, label: string, ancestors: WeakSet<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} JSON numbers must be finite`)
    return
  }
  if (typeof value !== 'object') throw new Error(`${label} contains an unsafe non-JSON value`)
  if (ancestors.has(value)) throw new Error(`${label} JSON contains a cycle`)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY) throw new Error(`${label} JSON array is too large`)
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${label} JSON arrays must not contain holes`)
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error(`${label} JSON array entries must be own enumerable data properties`)
        }
        assertStrictJson(descriptor.value, label, ancestors)
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue
        if (typeof key !== 'string') throw new Error(`${label} JSON array contains an unsafe symbol key`)
        const index = Number(key)
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          throw new Error(`${label} JSON array contains a non-canonical own key`)
        }
      }
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} JSON must use plain objects`)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error(`${label} JSON contains unsafe symbol keys`)
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${label} JSON contains an unsafe key`)
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error(`${label} JSON keys must be own enumerable data properties`)
      assertStrictJson(descriptor.value, label, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > MAX_ARRAY) throw new Error(`${label} array is too large`)
  if (value.some(item => typeof item !== 'string' || !item.trim() || item.length > MAX_ARRAY_ITEM)) {
    throw new Error(`${label} must contain bounded non-empty strings`)
  }
  assertJsonBound(value, label)
}

function normalizeEnvironments(value: unknown): FabricEnvironment[] {
  if (!Array.isArray(value)) throw new Error('Resolve environments must be an array')
  if (value.length === 0) throw new Error('Resolve environments must contain at least one environment')
  if (value.length > 4) throw new Error('Resolve environments must contain no more than four entries')
  const environments = new Set<FabricEnvironment>()
  for (const environment of value) {
    if (!ENVIRONMENTS.has(environment as FabricEnvironment)) {
      throw new Error(`Invalid executor environment: ${String(environment)}`)
    }
    environments.add(environment as FabricEnvironment)
  }
  return [...environments]
}

function readRegistryPolicyRevision(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM fabric_meta WHERE key='registry_policy_revision'").get() as { value: string } | undefined
  if (!row) return 0
  return parseRegistryPolicyRevision(row.value)
}

function parseRegistryPolicyRevision(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('Registry policy revision is invalid')
  const revision = Number(value)
  if (!Number.isSafeInteger(revision)) throw new Error('Registry policy revision is invalid')
  return revision
}

function bumpRegistryPolicyRevision(db: DatabaseSync): number {
  const current = readRegistryPolicyRevision(db)
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error('Registry policy revision is exhausted')
  const next = current + 1
  db.prepare(`INSERT INTO fabric_meta(key, value) VALUES('registry_policy_revision', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(next))
  return next
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

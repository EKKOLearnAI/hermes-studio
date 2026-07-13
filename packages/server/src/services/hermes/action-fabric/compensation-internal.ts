import { createHash } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { assertFabricAuditedTransaction } from './audit'
import { validateFabricSchema, validateHealthOutputSemantics } from './contracts'
import type { FabricActionIntentInput, FabricJsonObject } from './types'

interface TrustedRestoreProof {
  parentWorkflowId: string
  parentDigest: string
  requestDigest: string
}

interface ParentRestoreMaterial {
  workflowId: string
  workflowState: string
  executorId: string
  policyDecisionId: string
  policySnapshot: FabricJsonObject
  requestedByRoleId: string
  requestedByUserId: string
  capabilityVersion: number
  capabilityDigest: string
  bindingVersion: number
  bindingDigest: string
  prepareInput: FabricJsonObject
  executeState: string
  executeToken: string
  executeOutput: FabricJsonObject
}

const trustedRestores = new WeakMap<object, TrustedRestoreProof>()

export interface InternalPreparedPlanRestore {
  input: FabricActionIntentInput
  payload: { actionInput: FabricJsonObject; target: FabricJsonObject; constraints: FabricJsonObject }
}

export function prepareTrustedPlanRestoreInDb(
  db: DatabaseSync,
  parentWorkflowId: string,
  rationale: string,
): InternalPreparedPlanRestore | null {
  const input = buildTrustedPlanRestoreInDb(db, parentWorkflowId, rationale)
  if (!input) return null
  return deepFreeze({
    input,
    payload: {
      actionInput: clone(input.input),
      target: clone(input.target),
      constraints: clone(input.constraints),
    },
  })
}

export function buildGenericCompensationInput(input: {
  originalCapabilityId: string
  compensationCapabilityId: string
  requestedByRoleId: string
  requestedByUserId: string
  workflowId: string
  executeToken: string
  target: FabricJsonObject
  executorEnvironment: string
  shadow: boolean
  rationale: string
}): FabricActionIntentInput | null {
  if (input.shadow || input.executorEnvironment === 'sandbox'
    || (input.originalCapabilityId === 'health.plan.adjust'
      && input.compensationCapabilityId === 'health.plan.restore')) return null
  return {
    capabilityId: input.compensationCapabilityId,
    requestedByRoleId: input.requestedByRoleId,
    requestedByUserId: input.requestedByUserId,
    idempotencyKey: `compensation:${input.workflowId}`,
    goal: 'Compensate a completed Action Fabric workflow',
    target: input.target,
    input: { originalWorkflowId: input.workflowId, originalExecutionReference: input.executeToken },
    constraints: { compensationForWorkflowId: input.workflowId },
    rationale: input.rationale,
  }
}

/** Builds a restore only from an authoritative, completed health.plan.adjust parent. */
export function buildTrustedPlanRestoreInDb(
  db: DatabaseSync,
  parentWorkflowId: string,
  rationale: string,
): FabricActionIntentInput | null {
  assertFabricAuditedTransaction(db)
  const material = readParentRestoreMaterial(db, parentWorkflowId)
  if (!material) return null
  const actionInput = objectProperty(material.prepareInput, 'actionInput')
  const planId = actionInput.planId
  const output = material.executeOutput
  if (typeof planId !== 'string' || output.planId !== planId
    || !Number.isSafeInteger(output.newVersion) || !Number.isSafeInteger(output.previousVersion)
    || typeof output.previousDigest !== 'string') return null
  const input = deepFreeze({
    capabilityId: 'health.plan.restore',
    requestedByRoleId: material.requestedByRoleId,
    requestedByUserId: material.requestedByUserId,
    idempotencyKey: `compensation:${parentWorkflowId}`,
    goal: 'Compensate a completed Action Fabric workflow',
    target: { kind: 'health_plan', planId },
    input: {
      schemaVersion: 1,
      planId,
      expectedCurrentVersion: output.newVersion,
      restoreVersion: output.previousVersion,
      restoreDigest: output.previousDigest,
    },
    constraints: { compensationForWorkflowId: parentWorkflowId },
    rationale,
    environments: ['internal'] as const,
  }) as FabricActionIntentInput
  trustedRestores.set(input, {
    parentWorkflowId,
    parentDigest: digest(material),
    requestDigest: digest(input),
  })
  return input
}

/** Verifies both object identity and the still-current durable parent evidence. */
export function verifyTrustedPlanRestoreInDb(db: DatabaseSync, input: FabricActionIntentInput): boolean {
  const proof = trustedRestores.get(input)
  if (!proof || !isDeepFrozen(input) || digest(input) !== proof.requestDigest) return false
  const material = readParentRestoreMaterial(db, proof.parentWorkflowId)
  return material !== null && digest(material) === proof.parentDigest
}

function readParentRestoreMaterial(db: DatabaseSync, workflowId: string): ParentRestoreMaterial | null {
  const row = db.prepare(`SELECT
      w.id workflow_id,w.state workflow_state,w.executor_id,w.policy_decision_id,
      i.requested_by_role_id,i.requested_by_user_id,i.capability_id,i.capability_version,
      p.policy_snapshot_json,e.environment,e.configuration_json,
      c.version capability_version_current,c.contract_digest capability_digest,c.reversible,
      c.compensation_capability_id,b.capability_version binding_version,b.contract_digest binding_digest,
      prep.input_json prepare_input_json,exec.state execute_state,exec.execution_token,exec.output_json,
      c.output_schema_json
    FROM fabric_workflows w
    JOIN fabric_action_intents i ON i.id=w.intent_id
    JOIN fabric_policy_decisions p ON p.id=w.policy_decision_id
    JOIN fabric_executors e ON e.id=w.executor_id
    JOIN fabric_capabilities c ON c.id=i.capability_id
    JOIN fabric_executor_capabilities b ON b.executor_id=w.executor_id AND b.capability_id=i.capability_id
    JOIN fabric_steps prep ON prep.workflow_id=w.id AND prep.ordinal=0 AND prep.kind='prepare'
    JOIN fabric_steps exec ON exec.workflow_id=w.id AND exec.ordinal=1 AND exec.kind='execute'
    WHERE w.id=?`).get(workflowId) as {
      workflow_id: string; workflow_state: string; executor_id: string; policy_decision_id: string
      requested_by_role_id: string; requested_by_user_id: string; capability_id: string
      capability_version: number; policy_snapshot_json: string; environment: string; configuration_json: string
      capability_version_current: number; capability_digest: string; reversible: number
      compensation_capability_id: string | null; binding_version: number; binding_digest: string
      prepare_input_json: string; execute_state: string; execution_token: string; output_json: string | null
      output_schema_json: string
    } | undefined
  if (!row || row.capability_id !== 'health.plan.adjust'
    || !['verifying', 'succeeded'].includes(row.workflow_state)
    || row.executor_id !== 'health-plan' || row.environment !== 'internal'
    || row.reversible !== 1 || row.compensation_capability_id !== 'health.plan.restore'
    || row.capability_version !== row.capability_version_current
    || row.binding_version !== row.capability_version_current
    || row.binding_digest !== row.capability_digest
    || row.execute_state !== 'succeeded' || row.output_json === null) return null
  try {
    const configuration = parseObject(row.configuration_json)
    const snapshot = parseObject(row.policy_snapshot_json)
    const prepareInput = parseObject(row.prepare_input_json)
    const actionInput = objectProperty(prepareInput, 'actionInput')
    const target = objectProperty(prepareInput, 'target')
    const contract = objectProperty(prepareInput, 'contract')
    const executeOutput = parseObject(row.output_json)
    const outputSchema = parseObject(row.output_schema_json)
    if (configuration.externalWrite !== false || configuration.shadow === true
      || snapshot.resolvedEnvironment !== 'internal'
      || contract.capabilityVersion !== row.capability_version
      || contract.contractDigest !== row.capability_digest
      || contract.reversible !== true
      || contract.compensationCapabilityId !== 'health.plan.restore'
      || actionInput.planId !== target.planId || target.kind !== 'health_plan'
      || !validateFabricSchema(executeOutput, outputSchema)
      || !validateHealthOutputSemantics('health.plan.adjust', actionInput, executeOutput)) return null
    return {
      workflowId: row.workflow_id,
      workflowState: row.workflow_state,
      executorId: row.executor_id,
      policyDecisionId: row.policy_decision_id,
      policySnapshot: snapshot,
      requestedByRoleId: row.requested_by_role_id,
      requestedByUserId: row.requested_by_user_id,
      capabilityVersion: row.capability_version,
      capabilityDigest: row.capability_digest,
      bindingVersion: row.binding_version,
      bindingDigest: row.binding_digest,
      prepareInput,
      executeState: row.execute_state,
      executeToken: row.execution_token,
      executeOutput,
    }
  } catch {
    return null
  }
}

function parseObject(value: string): FabricJsonObject {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('FABRIC_COMPENSATION_INVALID')
  return parsed as FabricJsonObject
}

function objectProperty(value: FabricJsonObject, key: string): FabricJsonObject {
  const child = value[key]
  if (!child || typeof child !== 'object' || Array.isArray(child)) throw new Error('FABRIC_COMPENSATION_INVALID')
  return child as FabricJsonObject
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isDeepFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false
  return Object.values(value as Record<string, unknown>).every(child =>
    !child || typeof child !== 'object' || isDeepFrozen(child))
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  return JSON.stringify(value)
}

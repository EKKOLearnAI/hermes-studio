import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getAssistantRole } from '../personal-twin'
import { appendFabricAuditEvent, appendFabricOutbox, withFabricAuditedTransaction } from './audit'
import { withActionFabricDb } from './database'
import { getFabricControlStateInDb } from './control'
import {
  authorizeTrustedPlanRestoreCompensation,
  evaluateFabricPolicyInDb,
  prepareFabricPolicyEvaluation,
  revalidateFabricDecisionInDb,
} from './policy'
import type {
  FabricActionIntent,
  FabricActionIntentInput,
  FabricEvidence,
  FabricJsonObject,
  FabricPolicyDecision,
  FabricStep,
  FabricStepState,
  FabricWorkflowDetail,
  FabricWorkflowAvailableActions,
  FabricWorkflowListOptions,
  FabricWorkflowState,
  FabricWorkflowSummary,
} from './types'

const MAX_LIST_LIMIT = 200
const SUPPORTED_POLICY_VERSION = 1
const MAX_PAYLOAD_BYTES = 32_768
const MAX_PAYLOAD_DEPTH = 8
const MAX_PAYLOAD_ITEMS = 64
const MAX_PAYLOAD_NODES = 4_096
const MAX_PAYLOAD_STRING_BYTES = 8_192
const SENSITIVE_STRING = /(?:\bBearer\s+\S+|\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|\b(?:api[_ -]?key|access[_ -]?token|password|secret|credential)\s*[:=]\s*\S+|-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----|\b(?:postgres(?:ql)?|mysql|mongodb|redis|amqps?):\/\/|(?:^|[\s("'=])(?:[a-z]:[\\/]|\\\\|\/(?:etc|home|Users|usr|app|workspace|data|var|tmp|opt|root|mnt)\/))/i
const CREDENTIAL_ROOTS = new Set([
  'auth', 'authentication', 'authorization', 'access', 'refresh', 'bearer', 'secret', 'credential',
  'credentials', 'password', 'passphrase', 'private', 'api', 'client', 'cookie', 'session',
  'encryption', 'signing', 'service', 'account', 'oauth',
])
const CREDENTIAL_SUFFIXES = new Set([
  'token', 'value', 'data', 'key', 'secret', 'credential', 'credentials', 'password', 'passphrase', 'code',
])
const ALWAYS_SENSITIVE_TOKENS = new Set([
  'token', 'secret', 'password', 'passphrase', 'bearer', 'authorization', 'credential', 'credentials',
  'cookie', 'session',
])
const DIRECT_CREDENTIAL_KEYS = new Set([
  'auth', 'authentication', 'authorization', 'bearer', 'secret', 'credential', 'credentials',
  'password', 'passphrase', 'cookie', 'session', 'token',
])
const UNICODE_CREDENTIAL_KEYS = new Set(['私钥', '密码', '令牌', '凭据', '密钥', '访问令牌'])

export interface FabricIntentResult {
  intent: FabricActionIntent
  policyDecision: FabricPolicyDecision
  workflow: FabricWorkflowDetail
}

export interface PreparedFabricCompensation {
  input: FabricActionIntentInput
  payload: ActionPayload
}

type WorkflowAction = 'approve' | 'reject' | 'cancel' | 'retry' | 'compensate'

/** Runtime-owned states eligible for a durable worker checkpoint. */
export function isFabricWorkflowWorkerState(state: FabricWorkflowState): boolean {
  return state === 'preparing' || state === 'executing' || state === 'verifying' || state === 'retrying'
}

// This is the sole map from public actions to destination states. Callers never select a state.
const TRANSITIONS: Record<WorkflowAction, Partial<Record<FabricWorkflowState, FabricWorkflowState>>> = {
  approve: { waiting_user: 'preparing' },
  reject: { waiting_user: 'cancelled' },
  cancel: {
    draft: 'cancelled', policy_check: 'cancelled', preparing: 'cancelled',
    waiting_user: 'cancelled', retrying: 'cancelled', failed: 'cancelled',
  },
  retry: { failed: 'retrying', dead_letter: 'retrying' },
  compensate: { succeeded: 'compensating' },
}

interface IntentRow {
  id: string; capability_id: string; capability_version: number; requested_by_role_id: string
  requested_by_user_id: string; idempotency_key: string; goal: string; target_json: string
  input_json: string; constraints_json: string; rationale: string; expected_cost_currency: string | null
  expected_cost_minor: number | null; material_input_digest: string; sanitized_summary_json: string
  created_at: string; updated_at: string
}

interface DecisionRow {
  id: string; intent_id: string; executor_id: string | null; outcome: FabricPolicyDecision['outcome']
  reason_codes_json: string; policy_version: number; material_input_digest: string
  policy_snapshot_json: string; sanitized_summary_json: string; budget_currency: string | null
  budget_amount_minor: number | null; created_at: string
}

interface WorkflowRow {
  id: string; intent_id: string; executor_id: string | null; policy_decision_id: string | null
  compensation_intent_id: string | null; state: FabricWorkflowState; version: number; attempt: number
  max_attempts: number; lease_owner: string | null; lease_expires_at: string | null; retry_at: string | null
  last_error_code: string | null; created_at: string; updated_at: string; completed_at: string | null
}

interface StepRow {
  id: string; workflow_id: string; ordinal: number; kind: string; state: FabricStepState
  execution_token: string; executor_id: string | null; input_json: string; output_json: string | null
  evidence_json: string; attempt: number; last_error_code: string | null; created_at: string
  updated_at: string; started_at: string | null; completed_at: string | null
}

export function createFabricIntent(input: FabricActionIntentInput): FabricIntentResult {
  validatePersistedMetadata(input)
  const payload = actionPayload(input)
  prepareFabricPolicyEvaluation(input)
  return withFabricAuditedTransaction(db => {
    const decision = evaluateFabricPolicyInDb(db, input)
    const existing = selectWorkflowByIntent(db, decision.intentId)
    if (existing) {
      if (existing.policy_decision_id !== decision.id) throw new Error('FABRIC_WORKFLOW_POLICY_CONFLICT')
      return resultForWorkflow(db, existing)
    }
    return createWorkflowInDb(db, decision, payload)
  })
}

export function getFabricIntent(id: string): FabricActionIntent | null {
  validateText(id, 200, 'FABRIC_INTENT_INVALID_ID')
  return withActionFabricDb(db => {
    const row = db.prepare('SELECT * FROM fabric_action_intents WHERE id=?').get(id) as IntentRow | undefined
    return row ? parseIntent(row) : null
  })
}

export function getFabricWorkflow(id: string): FabricWorkflowDetail | null {
  validateText(id, 200, 'FABRIC_WORKFLOW_INVALID_ID')
  return withActionFabricDb(db => {
    const row = db.prepare('SELECT * FROM fabric_workflows WHERE id=?').get(id) as WorkflowRow | undefined
    return row ? detailForWorkflow(db, row) : null
  })
}

export function listFabricWorkflows(options: FabricWorkflowListOptions = {}): FabricWorkflowSummary[] {
  const limit = boundedLimit(options.limit)
  const clauses: string[] = []
  const parameters: Array<string | number> = []
  if (options.state !== undefined) {
    clauses.push('w.state=?')
    parameters.push(options.state)
  }
  if (options.capabilityId !== undefined) {
    validateText(options.capabilityId, 200, 'FABRIC_WORKFLOW_INVALID_FILTER')
    clauses.push('i.capability_id=?')
    parameters.push(options.capabilityId)
  }
  if (options.requestedByRoleId !== undefined) {
    validateText(options.requestedByRoleId, 200, 'FABRIC_WORKFLOW_INVALID_FILTER')
    clauses.push('i.requested_by_role_id=?')
    parameters.push(options.requestedByRoleId)
  }
  if (options.requestedByUserId !== undefined) {
    validateText(options.requestedByUserId, 200, 'FABRIC_WORKFLOW_INVALID_FILTER')
    clauses.push('i.requested_by_user_id=?')
    parameters.push(options.requestedByUserId)
  }
  return withActionFabricDb(db => {
    if (options.cursor !== undefined) {
      validateText(options.cursor, 200, 'FABRIC_WORKFLOW_INVALID_CURSOR')
      const cursor = db.prepare('SELECT created_at, rowid FROM fabric_workflows WHERE id=?').get(options.cursor) as
        { created_at: string; rowid: number } | undefined
      if (!cursor) throw new Error('FABRIC_WORKFLOW_INVALID_CURSOR')
      clauses.push('(w.created_at < ? OR (w.created_at = ? AND w.rowid < ?))')
      parameters.push(cursor.created_at, cursor.created_at, cursor.rowid)
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    parameters.push(limit)
    const rows = db.prepare(`SELECT w.* FROM fabric_workflows w
      JOIN fabric_action_intents i ON i.id=w.intent_id ${where}
      ORDER BY w.created_at DESC, w.rowid DESC LIMIT ?`).all(...parameters) as unknown as WorkflowRow[]
    return rows.map(row => summaryForWorkflow(db, row))
  })
}

export function approveFabricWorkflow(id: string, actorUserId: string): FabricWorkflowDetail {
  validateText(id, 200, 'FABRIC_WORKFLOW_INVALID_ID')
  validateText(actorUserId, 200, 'FABRIC_WORKFLOW_INVALID_ACTOR')
  const context = withActionFabricDb(db => approvalContext(db, id))
  if (context.workflow.state !== 'waiting_user') throw new Error('FABRIC_WORKFLOW_INVALID_TRANSITION')
  const request: FabricActionIntentInput = {
    capabilityId: context.intent.capabilityId,
    requestedByRoleId: context.intent.requestedByRoleId,
    requestedByUserId: context.intent.requestedByUserId,
    idempotencyKey: context.intent.idempotencyKey,
    goal: 'Approve an Action Fabric workflow',
    target: context.payload.target,
    input: context.payload.actionInput,
    constraints: context.payload.constraints,
    rationale: 'User approval',
    ...(context.intent.expectedCost === undefined ? {} : { expectedCost: context.intent.expectedCost }),
  }
  prepareFabricPolicyEvaluation(request)
  return withFabricAuditedTransaction(db => {
    const fresh = evaluateFabricPolicyInDb(db, request)
    return approveWorkflowInDb(db, id, actorUserId, context.decision, fresh)
  })
}

export function rejectFabricWorkflow(id: string, actorUserId: string, reason: string): FabricWorkflowDetail {
  return transitionWorkflow(id, actorUserId, 'reject', reason)
}

export function cancelFabricWorkflow(id: string, actorUserId: string, reason: string): FabricWorkflowDetail {
  return transitionWorkflow(id, actorUserId, 'cancel', reason)
}

export function retryFabricWorkflow(id: string, actorUserId: string): FabricWorkflowDetail {
  validateText(id, 200, 'FABRIC_WORKFLOW_INVALID_ID')
  validateText(actorUserId, 200, 'FABRIC_WORKFLOW_INVALID_ACTOR')
  const recovery = withActionFabricDb(db => {
    const workflow = requireWorkflow(db, id)
    if (workflow.state !== 'waiting_user'
      || workflow.last_error_code !== 'FABRIC_CONTROL_CHANGED_REVIEW_REQUIRED') return null
    const context = approvalContext(db, id)
    return {
      request: {
        ...context.intent,
        target: context.payload.target,
        input: context.payload.actionInput,
        constraints: context.payload.constraints,
        phase: 'execution' as const,
      },
    }
  })
  if (recovery) {
    prepareFabricPolicyEvaluation(recovery.request)
    return withFabricAuditedTransaction(db => recoverControlCheckpointInDb(db, id, actorUserId, recovery.request))
  }
  return transitionWorkflow(id, actorUserId, 'retry', null)
}

function recoverControlCheckpointInDb(
  db: DatabaseSync,
  id: string,
  actorUserId: string,
  request: FabricActionIntentInput & { phase: 'execution' },
): FabricWorkflowDetail {
  const current = requireWorkflow(db, id)
  if (current.state !== 'waiting_user'
    || current.last_error_code !== 'FABRIC_CONTROL_CHANGED_REVIEW_REQUIRED') {
    throw new Error('FABRIC_WORKFLOW_CONFLICT')
  }
  if (getFabricControlStateInDb(db).level !== 0) throw new Error('FABRIC_WORKFLOW_NOT_RETRYABLE')
  const intent = requireIntent(db, current.intent_id)
  const captured = compensationContext(db, id).contract
  const currentContract = captureIntentContract(db, intent)
  if (captured.capabilityVersion !== currentContract.capabilityVersion
    || captured.contractDigest !== currentContract.contractDigest) {
    throw new Error('FABRIC_WORKFLOW_CONTRACT_STALE')
  }
  const fresh = evaluateFabricPolicyInDb(db, request)
  if (fresh.intentId !== intent.id || fresh.outcome !== 'allow' || fresh.executorId === null
    || fresh.materialInputDigest !== intent.materialInputDigest) {
    throw new Error(fresh.outcome === 'deny' ? 'FABRIC_POLICY_DENIED' : 'FABRIC_WORKFLOW_APPROVAL_REQUIRED')
  }
  revalidateFabricDecisionInDb(db, fresh.id)
  bindBudgetReservation(db, fresh, id)
  const destination = controlRecoveryDestinationInDb(db, current, captured)
  if (destination === null) throw new Error('FABRIC_WORKFLOW_NOT_RETRYABLE')
  const now = new Date().toISOString()
  const changed = db.prepare(`UPDATE fabric_workflows SET state=?,version=version+1,executor_id=?,
    policy_decision_id=?,lease_owner=NULL,lease_expires_at=NULL,retry_at=NULL,last_error_code=NULL,
    updated_at=?,completed_at=NULL WHERE id=? AND version=? AND state='waiting_user'
    AND last_error_code='FABRIC_CONTROL_CHANGED_REVIEW_REQUIRED'`).run(
    destination, fresh.executorId, fresh.id, now, id, current.version,
  )
  if (changed.changes !== 1) throw new Error('FABRIC_WORKFLOW_CONFLICT')
  const resetKinds = destination === 'preparing' ? ['prepare', 'execute', 'verify']
    : destination === 'executing' ? ['execute', 'verify'] : ['verify']
  for (const kind of resetKinds) {
    db.prepare(`UPDATE fabric_steps SET state='pending',executor_id=?,last_error_code=NULL,output_json=NULL,
      evidence_json='[]',started_at=NULL,completed_at=NULL,updated_at=?
      WHERE workflow_id=? AND kind=? AND state<>'succeeded'`).run(fresh.executorId, now, id, kind)
  }
  appendFabricAuditEvent(db, { eventType: 'workflow.control_reauthorized', actorUserId,
    aggregateType: 'workflow', aggregateId: id,
    payload: { from: 'waiting_user', to: destination, policyDecisionId: fresh.id }, occurredAt: now })
  appendFabricOutbox(db, 'fabric.workflow.control_reauthorized', id,
    { from: 'waiting_user', to: destination, policyDecisionId: fresh.id })
  return detailForWorkflow(db, requireWorkflow(db, id))
}

export function requestFabricCompensation(id: string, actorUserId: string, reason: string): FabricWorkflowDetail {
  validateText(id, 200, 'FABRIC_WORKFLOW_INVALID_ID')
  validateText(actorUserId, 200, 'FABRIC_WORKFLOW_INVALID_ACTOR')
  validateText(reason, 2_000, 'FABRIC_WORKFLOW_INVALID_REASON')
  const context = withActionFabricDb(db => compensationContext(db, id))
  if (context.workflow.compensation_intent_id !== null) return getFabricWorkflow(id)!
  if (TRANSITIONS.compensate[context.workflow.state] === undefined) {
    throw new Error('FABRIC_WORKFLOW_NOT_COMPENSATABLE')
  }
  if (!context.contract.reversible || context.contract.compensationCapabilityId === null) {
    throw new Error('FABRIC_WORKFLOW_NOT_COMPENSATABLE')
  }
  const compensationInput = buildFabricCompensationInput({
    originalCapabilityId: context.intent.capabilityId,
    compensationCapabilityId: context.contract.compensationCapabilityId,
    requestedByRoleId: context.intent.requestedByRoleId,
    requestedByUserId: context.intent.requestedByUserId,
    workflowId: id, executeToken: context.executeToken,
    target: context.payload.target, input: context.payload.actionInput,
    executionOutput: context.executeOutput, executorEnvironment: context.executorEnvironment,
    shadow: context.shadow, rationale: reason,
  })
  if (!compensationInput) throw new Error('FABRIC_WORKFLOW_NOT_COMPENSATABLE')
  const prepared = prepareFabricCompensation(compensationInput)
  return withFabricAuditedTransaction(db => {
    const compensation = createFabricCompensationChildInDb(db, prepared)
    const compensationDecision = compensation.policyDecision
    const current = requireWorkflow(db, id)
    if (current.compensation_intent_id !== null) return detailForWorkflow(db, current)
    if (current.state !== 'succeeded') throw new Error('FABRIC_WORKFLOW_NOT_COMPENSATABLE')
    const verified = compensationContext(db, id)
    if (verified.contract.capabilityVersion !== context.contract.capabilityVersion
      || verified.contract.contractDigest !== context.contract.contractDigest
      || verified.contract.compensationCapabilityId !== context.contract.compensationCapabilityId) {
      throw new Error('FABRIC_WORKFLOW_CONTRACT_STALE')
    }
    const destination = compensationDecision.outcome === 'deny' ? current.state : 'compensating'
    const now = new Date().toISOString()
    const result = db.prepare(`UPDATE fabric_workflows SET compensation_intent_id=?,state=?,version=version+1,
      updated_at=?,completed_at=? WHERE id=? AND version=? AND state='succeeded' AND compensation_intent_id IS NULL`).run(
      compensationDecision.intentId, destination, now, destination === 'succeeded' ? current.completed_at : null,
      id, current.version,
    )
    if (result.changes !== 1) throw new Error('FABRIC_WORKFLOW_CONFLICT')
    appendFabricAuditEvent(db, {
      eventType: 'workflow.compensation_requested', actorUserId, aggregateType: 'workflow', aggregateId: id,
      payload: { compensationIntentId: compensationDecision.intentId, compensationWorkflowId: compensation.workflow.id,
        policyOutcome: compensationDecision.outcome, from: current.state, to: destination, reason },
      occurredAt: now,
    })
    appendFabricOutbox(db, 'fabric.workflow.compensation_requested', id, {
      compensationIntentId: compensationDecision.intentId, compensationWorkflowId: compensation.workflow.id,
      policyOutcome: compensationDecision.outcome, from: current.state, to: destination,
    })
    return detailForWorkflow(db, requireWorkflow(db, id))
  })
}

export function prepareFabricCompensation(input: FabricActionIntentInput): PreparedFabricCompensation {
  validatePersistedMetadata(input)
  const payload = actionPayload(input)
  prepareFabricPolicyEvaluation(input)
  if (input.capabilityId === 'health.plan.restore') authorizeTrustedPlanRestoreCompensation(input)
  return { input, payload }
}

export function buildFabricCompensationInput(input: {
  originalCapabilityId: string
  compensationCapabilityId: string
  requestedByRoleId: string
  requestedByUserId: string
  workflowId: string
  executeToken: string
  target: FabricJsonObject
  input: FabricJsonObject
  executionOutput?: FabricJsonObject
  executorEnvironment: string
  shadow: boolean
  rationale: string
}): FabricActionIntentInput | null {
  if (input.shadow || input.executorEnvironment === 'sandbox') return null
  const common = {
    capabilityId: input.compensationCapabilityId,
    requestedByRoleId: input.requestedByRoleId,
    requestedByUserId: input.requestedByUserId,
    idempotencyKey: `compensation:${input.workflowId}`,
    goal: 'Compensate a completed Action Fabric workflow',
    constraints: { compensationForWorkflowId: input.workflowId },
    rationale: input.rationale,
  }
  if (input.originalCapabilityId === 'health.plan.adjust'
    && input.compensationCapabilityId === 'health.plan.restore') {
    const output = input.executionOutput
    if (!output || typeof input.input.planId !== 'string' || output.planId !== input.input.planId
      || !Number.isSafeInteger(output.newVersion) || !Number.isSafeInteger(output.previousVersion)
      || typeof output.previousDigest !== 'string' || !/^[a-f0-9]{64}$/.test(output.previousDigest)) return null
    return {
      ...common,
      target: { kind: 'health_plan', planId: input.input.planId },
      input: { schemaVersion: 1, planId: input.input.planId,
        expectedCurrentVersion: output.newVersion, restoreVersion: output.previousVersion,
        restoreDigest: output.previousDigest },
      environments: ['internal'],
    }
  }
  return {
    ...common,
    target: input.target,
    input: { originalWorkflowId: input.workflowId, originalExecutionReference: input.executeToken },
  }
}

/** Must be called from the transaction used to link the parent workflow. */
export function createFabricCompensationChildInDb(
  db: DatabaseSync,
  prepared: PreparedFabricCompensation,
): FabricIntentResult {
  const decision = evaluateFabricPolicyInDb(db, prepared.input)
  const existing = selectWorkflowByIntent(db, decision.intentId)
  if (existing) {
    if (existing.policy_decision_id !== decision.id) throw new Error('FABRIC_COMPENSATION_WORKFLOW_CONFLICT')
    return resultForWorkflow(db, existing)
  }
  return createWorkflowInDb(db, decision, prepared.payload)
}

function transitionWorkflow(
  id: string,
  actorUserId: string,
  action: WorkflowAction,
  reason: string | null,
): FabricWorkflowDetail {
  validateText(id, 200, 'FABRIC_WORKFLOW_INVALID_ID')
  validateText(actorUserId, 200, 'FABRIC_WORKFLOW_INVALID_ACTOR')
  if (reason !== null) validateText(reason, 2_000, 'FABRIC_WORKFLOW_INVALID_REASON')
  return withFabricAuditedTransaction(db => {
    const current = requireWorkflow(db, id)
    if (action === 'retry' && current.state === 'waiting_user') {
      return retryWorkerWaitingWorkflowInDb(db, current, actorUserId)
    }
    if (action === 'retry' && (current.state === 'failed' || current.state === 'dead_letter')) {
      assertPhaseAwareRetryAllowed(db, current)
    }
    if (action === 'cancel' && current.state === 'cancelled') return detailForWorkflow(db, current)
    if (action === 'cancel' && (current.lease_owner !== null || hasActiveOrEffectfulStep(db, id))) {
      throw new Error('FABRIC_WORKFLOW_INVALID_TRANSITION')
    }
    const destination = TRANSITIONS[action][current.state]
    if (destination === undefined) {
      throw new Error(action === 'retry'
        ? 'FABRIC_WORKFLOW_NOT_RETRYABLE'
        : action === 'compensate' ? 'FABRIC_WORKFLOW_NOT_COMPENSATABLE' : 'FABRIC_WORKFLOW_INVALID_TRANSITION')
    }
    const now = new Date().toISOString()
    const completedAt = isTerminal(destination) ? now : null
    const attempt = action === 'retry' ? current.attempt + 1 : current.attempt
    const result = db.prepare(`UPDATE fabric_workflows SET state=?,version=version+1,attempt=?,
      lease_owner=NULL,lease_expires_at=NULL,retry_at=NULL,last_error_code=NULL,updated_at=?,completed_at=?
      WHERE id=? AND version=? AND state=?`).run(
      destination, attempt, now, completedAt, id, current.version, current.state,
    )
    if (result.changes !== 1) throw new Error('FABRIC_WORKFLOW_CONFLICT')
    updateStepsForAction(db, id, action, now)
    if (action === 'reject' || action === 'cancel') releaseWorkflowBudgetInDb(db, current, now)
    appendFabricAuditEvent(db, {
      eventType: 'workflow.transitioned', actorUserId, aggregateType: 'workflow', aggregateId: id,
      payload: { action, from: current.state, to: destination, ...(reason === null ? {} : { reason }) },
      occurredAt: now,
    })
    appendFabricOutbox(db, 'fabric.workflow.transitioned', id, {
      action, from: current.state, to: destination,
    })
    return detailForWorkflow(db, requireWorkflow(db, id))
  })
}

function retryWorkerWaitingWorkflowInDb(
  db: DatabaseSync,
  current: WorkflowRow,
  actorUserId: string,
): FabricWorkflowDetail {
  const errorCode = current.last_error_code
  const executionUnknown = errorCode === 'FABRIC_EXECUTION_OUTCOME_UNKNOWN'
  const contractRetry = errorCode === 'FABRIC_WORKER_CONTRACT_MISSING'
  retryWorkerWaitingEligibilityInDb(db, current)
  const context = compensationContext(db, current.id)
  let destination: FabricWorkflowState = 'verifying'
  if (contractRetry) {
    const steps = db.prepare('SELECT kind,state FROM fabric_steps WHERE workflow_id=? ORDER BY ordinal')
      .all(current.id) as unknown as Array<{ kind: string; state: FabricStepState }>
    const prepare = steps.find(step => step.kind === 'prepare')
    const execute = steps.find(step => step.kind === 'execute')
    if (prepare?.state !== 'succeeded') destination = 'preparing'
    else if (execute?.state !== 'succeeded') {
      if (context.contract.idempotency === 'none') {
        if (context.contract.verificationStrategy === 'none') throw new Error('FABRIC_WORKFLOW_NOT_RETRYABLE')
        destination = 'verifying'
      } else destination = 'executing'
    }
  }
  const now = new Date().toISOString()
  const changed = db.prepare(`UPDATE fabric_workflows SET state=?,version=version+1,
    lease_owner=NULL,lease_expires_at=NULL,retry_at=NULL,last_error_code=NULL,updated_at=?,completed_at=NULL
    WHERE id=? AND version=? AND state='waiting_user' AND last_error_code=?`).run(
    destination, now, current.id, current.version, errorCode,
  )
  if (changed.changes !== 1) throw new Error('FABRIC_WORKFLOW_CONFLICT')
  if (executionUnknown) {
    db.prepare(`UPDATE fabric_steps SET state='failed',last_error_code=?,updated_at=?,completed_at=?
      WHERE workflow_id=? AND kind='execute' AND state='waiting_user'`).run(errorCode, now, now, current.id)
  }
  if (contractRetry && destination === 'preparing') {
    db.prepare(`UPDATE fabric_steps SET state='pending',last_error_code=NULL,output_json=NULL,evidence_json='[]',
      started_at=NULL,completed_at=NULL,updated_at=? WHERE workflow_id=? AND state<>'succeeded'`).run(now, current.id)
  } else if (contractRetry && destination === 'executing') {
    db.prepare(`UPDATE fabric_steps SET state='pending',last_error_code=NULL,output_json=NULL,evidence_json='[]',
      started_at=NULL,completed_at=NULL,updated_at=? WHERE workflow_id=? AND kind IN ('execute','verify')
      AND state<>'succeeded'`).run(now, current.id)
  } else {
    db.prepare(`UPDATE fabric_steps SET state='pending',last_error_code=NULL,output_json=NULL,evidence_json='[]',
      started_at=NULL,completed_at=NULL,updated_at=? WHERE workflow_id=? AND kind='verify'
      AND state IN ('waiting_user','failed','pending')`).run(now, current.id)
  }
  appendFabricAuditEvent(db, { eventType: 'workflow.transitioned', actorUserId,
    aggregateType: 'workflow', aggregateId: current.id,
    payload: { action: 'retry', from: 'waiting_user', to: destination, reason: errorCode }, occurredAt: now })
  appendFabricOutbox(db, 'fabric.workflow.transitioned', current.id,
    { action: 'retry', from: 'waiting_user', to: destination, reason: errorCode })
  return detailForWorkflow(db, requireWorkflow(db, current.id))
}

function assertPhaseAwareRetryAllowed(db: DatabaseSync, workflow: WorkflowRow): void {
  if (workflow.compensation_intent_id !== null) throw new Error('FABRIC_WORKFLOW_NOT_RETRYABLE')
  const failed = db.prepare(`SELECT kind FROM fabric_steps WHERE workflow_id=? AND state='failed'
    ORDER BY ordinal LIMIT 1`).get(workflow.id) as { kind: string } | undefined
  if (!failed || !['prepare', 'execute', 'verify'].includes(failed.kind)) {
    throw new Error('FABRIC_WORKFLOW_NOT_RETRYABLE')
  }
  if (failed.kind === 'execute') {
    const contract = compensationContext(db, workflow.id).contract
    if (contract.idempotency === 'none' && contract.verificationStrategy === 'none') {
      throw new Error('FABRIC_WORKFLOW_NOT_RETRYABLE')
    }
  }
}

function hasActiveOrEffectfulStep(db: DatabaseSync, workflowId: string): boolean {
  return db.prepare(`SELECT 1 FROM fabric_steps WHERE workflow_id=?
    AND (state='running' OR (ordinal>=1 AND started_at IS NOT NULL)) LIMIT 1`).get(workflowId) !== undefined
}

function releaseWorkflowBudgetInDb(db: DatabaseSync, workflow: WorkflowRow, now: string): void {
  if (!workflow.policy_decision_id) return
  const ledger = db.prepare(`SELECT id,status FROM fabric_budget_ledger
    WHERE decision_id=? AND workflow_id=? ORDER BY created_at LIMIT 1`).get(
    workflow.policy_decision_id, workflow.id,
  ) as { id: string; status: string } | undefined
  if (!ledger || ledger.status !== 'reserved') return
  db.prepare(`UPDATE fabric_budget_ledger SET status='released',updated_at=?
    WHERE id=? AND status='reserved'`).run(now, ledger.id)
  const intent = requireIntent(db, workflow.intent_id)
  appendFabricAuditEvent(db, { eventType: 'budget.released', actorUserId: intent.requestedByUserId,
    aggregateType: 'workflow', aggregateId: workflow.id, payload: {}, occurredAt: now })
  appendFabricOutbox(db, 'fabric.budget.released', workflow.id, {})
}

function approvalContext(db: DatabaseSync, id: string): {
  workflow: WorkflowRow
  intent: FabricActionIntent
  decision: FabricPolicyDecision
  payload: ActionPayload
} {
  const workflow = requireWorkflow(db, id)
  const intent = requireIntent(db, workflow.intent_id)
  if (!workflow.policy_decision_id) throw new Error('FABRIC_WORKFLOW_APPROVAL_STALE')
  const decision = parseDecision(requireDecision(db, workflow.policy_decision_id))
  const prepare = db.prepare(`SELECT input_json FROM fabric_steps
    WHERE workflow_id=? AND ordinal=0 AND kind='prepare'`).get(id) as { input_json: string } | undefined
  if (!prepare) throw new Error('FABRIC_WORKFLOW_APPROVAL_STALE')
  const stored = parseObject(prepare.input_json) as Record<string, unknown>
  if (!isJsonObject(stored.actionInput) || !isJsonObject(stored.target) || !isJsonObject(stored.constraints)) {
    throw new Error('FABRIC_WORKFLOW_APPROVAL_STALE')
  }
  return { workflow, intent, decision,
    payload: { actionInput: stored.actionInput, target: stored.target, constraints: stored.constraints } }
}

function approveWorkflowInDb(
  db: DatabaseSync,
  id: string,
  actorUserId: string,
  original: FabricPolicyDecision,
  fresh: FabricPolicyDecision,
): FabricWorkflowDetail {
  const current = requireWorkflow(db, id)
  const intent = requireIntent(db, current.intent_id)
  if (current.state !== 'waiting_user' || current.policy_decision_id !== original.id
    || original.outcome !== 'waiting_user' || original.policyVersion !== SUPPORTED_POLICY_VERSION
    || original.materialInputDigest !== intent.materialInputDigest
    || fresh.intentId !== intent.id || fresh.materialInputDigest !== intent.materialInputDigest
    || fresh.policyVersion !== SUPPORTED_POLICY_VERSION || fresh.executorId !== original.executorId
    || fresh.outcome === 'deny' || !sameProtectedAuthorization(original, fresh)) {
    throw new Error('FABRIC_WORKFLOW_APPROVAL_STALE')
  }
  try {
    revalidateFabricDecisionInDb(db, fresh.id)
  } catch (error) {
    if (error instanceof Error && /^FABRIC_POLICY_STALE_/.test(error.message)) {
      throw new Error('FABRIC_WORKFLOW_APPROVAL_STALE')
    }
    throw error
  }
  const now = new Date().toISOString()
  reserveApprovalBudgetInDb(db, fresh, current.id, intent, now)
  const result = db.prepare(`UPDATE fabric_workflows SET state='preparing',version=version+1,
    executor_id=?,policy_decision_id=?,lease_owner=NULL,lease_expires_at=NULL,retry_at=NULL,
    last_error_code=NULL,updated_at=?,completed_at=NULL WHERE id=? AND version=? AND state='waiting_user'`).run(
    fresh.executorId, fresh.id, now, id, current.version,
  )
  if (result.changes !== 1) throw new Error('FABRIC_WORKFLOW_CONFLICT')
  updateStepsForAction(db, id, 'approve', now)
  appendFabricAuditEvent(db, { eventType: 'workflow.transitioned', actorUserId,
    aggregateType: 'workflow', aggregateId: id,
    payload: { action: 'approve', from: 'waiting_user', to: 'preparing', policyDecisionId: fresh.id }, occurredAt: now })
  appendFabricOutbox(db, 'fabric.workflow.transitioned', id,
    { action: 'approve', from: 'waiting_user', to: 'preparing', policyDecisionId: fresh.id })
  return detailForWorkflow(db, requireWorkflow(db, id))
}

function sameProtectedAuthorization(original: FabricPolicyDecision, fresh: FabricPolicyDecision): boolean {
  const keys = ['roleDigest', 'registryPolicyEvaluationToken', 'controlVersion'] as const
  return keys.every(key => original.policySnapshot[key] === fresh.policySnapshot[key])
}

function reserveApprovalBudgetInDb(
  db: DatabaseSync,
  decision: FabricPolicyDecision,
  workflowId: string,
  intent: FabricActionIntent,
  now: string,
): void {
  if (!decision.budget || decision.budget.amountMinor <= 0) return
  const role = getAssistantRole(intent.requestedByRoleId)
  if (!role || role.spendingLimits.currency !== decision.budget.currency
    || decision.budget.amountMinor > role.spendingLimits.perAction) throw new Error('FABRIC_WORKFLOW_APPROVAL_STALE')
  const ledgerDate = now.slice(0, 10)
  const existing = db.prepare(`SELECT id,workflow_id,status,ledger_date FROM fabric_budget_ledger
    WHERE decision_id=? ORDER BY created_at LIMIT 1`).get(decision.id) as
    { id: string; workflow_id: string | null; status: string; ledger_date: string } | undefined
  if (existing && (existing.status !== 'reserved'
    || (existing.workflow_id !== null && existing.workflow_id !== workflowId)
    || existing.ledger_date !== ledgerDate)) throw new Error('FABRIC_WORKFLOW_APPROVAL_STALE')
  const total = db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS total FROM fabric_budget_ledger
    WHERE requested_by_user_id=? AND requested_by_role_id=? AND ledger_date=? AND currency=?
      AND status IN ('reserved','committed') AND decision_id<>?`).get(
    intent.requestedByUserId, intent.requestedByRoleId, ledgerDate, decision.budget.currency, decision.id,
  ) as { total: number }
  if (total.total + decision.budget.amountMinor > role.spendingLimits.daily) {
    throw new Error('FABRIC_WORKFLOW_APPROVAL_STALE')
  }
  if (existing) {
    db.prepare('UPDATE fabric_budget_ledger SET workflow_id=?,updated_at=? WHERE id=?')
      .run(workflowId, now, existing.id)
  } else {
    db.prepare(`INSERT INTO fabric_budget_ledger(id,decision_id,workflow_id,requested_by_user_id,
      requested_by_role_id,ledger_date,currency,amount_minor,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?, 'reserved',?,?)`).run(
      `budget-${randomUUID()}`, decision.id, workflowId, intent.requestedByUserId, intent.requestedByRoleId,
      ledgerDate, decision.budget.currency, decision.budget.amountMinor, now, now,
    )
  }
  appendFabricAuditEvent(db, { eventType: 'budget.reserved', actorUserId: intent.requestedByUserId,
    aggregateType: 'workflow', aggregateId: workflowId,
    payload: { currency: decision.budget.currency, amountMinor: decision.budget.amountMinor, ledgerDate }, occurredAt: now })
  appendFabricOutbox(db, 'fabric.budget.reserved', workflowId,
    { currency: decision.budget.currency, amountMinor: decision.budget.amountMinor, ledgerDate })
}

function updateStepsForAction(db: DatabaseSync, workflowId: string, action: WorkflowAction, now: string): void {
  if (action === 'approve') {
    db.prepare(`UPDATE fabric_steps SET state='pending',updated_at=?
      WHERE workflow_id=? AND state='waiting_user'`).run(now, workflowId)
  } else if (action === 'reject' || action === 'cancel') {
    db.prepare(`UPDATE fabric_steps SET state='cancelled',updated_at=?,completed_at=?
      WHERE workflow_id=? AND state IN ('pending','running','waiting_user','failed')`).run(now, now, workflowId)
  }
}

interface CapturedContract {
  capabilityVersion: number
  contractDigest: string
  reversible: boolean
  compensationCapabilityId: string | null
  idempotency: 'required' | 'supported' | 'none'
  verificationStrategy: string
}

interface ActionPayload {
  actionInput: FabricJsonObject
  target: FabricJsonObject
  constraints: FabricJsonObject
}

function captureIntentContract(db: DatabaseSync, intent: FabricActionIntent): CapturedContract {
  const row = db.prepare(`SELECT version,contract_digest,reversible,compensation_capability_id,idempotency,verification_strategy
    FROM fabric_capabilities WHERE id=?`).get(intent.capabilityId) as {
      version: number; contract_digest: string; reversible: number; compensation_capability_id: string | null
      idempotency: 'required' | 'supported' | 'none'; verification_strategy: string
    } | undefined
  if (!row || row.version !== intent.capabilityVersion) throw new Error('FABRIC_WORKFLOW_CONTRACT_STALE')
  return { capabilityVersion: row.version, contractDigest: row.contract_digest, reversible: row.reversible === 1,
    compensationCapabilityId: row.compensation_capability_id, idempotency: row.idempotency,
    verificationStrategy: row.verification_strategy }
}

function compensationContext(db: DatabaseSync, id: string): {
  workflow: WorkflowRow
  intent: FabricActionIntent
  payload: ActionPayload
  contract: CapturedContract
  executeToken: string
  executeOutput?: FabricJsonObject
  executorEnvironment: string
  shadow: boolean
} {
  const workflow = requireWorkflow(db, id)
  const intent = requireIntent(db, workflow.intent_id)
  const prepare = db.prepare(`SELECT input_json FROM fabric_steps
    WHERE workflow_id=? AND ordinal=0 AND kind='prepare'`).get(id) as { input_json: string } | undefined
  const execute = db.prepare(`SELECT execution_token,output_json FROM fabric_steps
    WHERE workflow_id=? AND ordinal=1 AND kind='execute'`).get(id) as
    { execution_token: string; output_json: string | null } | undefined
  if (!prepare || !execute) throw new Error('FABRIC_WORKFLOW_CONTRACT_UNAVAILABLE')
  const stored = parseObject(prepare.input_json) as Record<string, unknown>
  const contract = stored.contract as Partial<CapturedContract> | undefined
  const payload = { actionInput: stored.actionInput, target: stored.target, constraints: stored.constraints }
  if (!contract || contract.capabilityVersion !== intent.capabilityVersion
    || typeof contract.contractDigest !== 'string' || typeof contract.reversible !== 'boolean'
    || !(typeof contract.compensationCapabilityId === 'string' || contract.compensationCapabilityId === null)
    || !['required', 'supported', 'none'].includes(contract.idempotency ?? '')
    || typeof contract.verificationStrategy !== 'string' || contract.verificationStrategy.length === 0
    || !isJsonObject(payload.actionInput) || !isJsonObject(payload.target) || !isJsonObject(payload.constraints)) {
    throw new Error('FABRIC_WORKFLOW_CONTRACT_UNAVAILABLE')
  }
  const executor = workflow.executor_id === null ? undefined : db.prepare(`SELECT environment,configuration_json
    FROM fabric_executors WHERE id=?`).get(workflow.executor_id) as
    { environment: string; configuration_json: string } | undefined
  if (!executor) throw new Error('FABRIC_WORKFLOW_CONTRACT_UNAVAILABLE')
  const configuration = parseObject(executor.configuration_json)
  const decision = workflow.policy_decision_id === null ? undefined : db.prepare(`SELECT policy_snapshot_json
    FROM fabric_policy_decisions WHERE id=?`).get(workflow.policy_decision_id) as
    { policy_snapshot_json: string } | undefined
  const snapshot = decision ? parseObject(decision.policy_snapshot_json) : {}
  const capturedEnvironments = Array.isArray(snapshot.environments) ? snapshot.environments : []
  const capturedEnvironment = typeof snapshot.resolvedEnvironment === 'string' ? snapshot.resolvedEnvironment
    : capturedEnvironments.length === 1 && typeof capturedEnvironments[0] === 'string'
      ? capturedEnvironments[0] : executor.environment
  const executeOutput = execute.output_json === null ? undefined : parseObject(execute.output_json)
  return { workflow, intent, payload: payload as ActionPayload, contract: contract as CapturedContract,
    executeToken: execute.execution_token, ...(executeOutput ? { executeOutput } : {}),
    executorEnvironment: capturedEnvironment,
    shadow: capturedEnvironment === 'sandbox' || workflow.executor_id === 'health-shadow' || configuration.shadow === true }
}

function createWorkflowInDb(
  db: DatabaseSync,
  decision: FabricPolicyDecision,
  payload: ActionPayload,
): FabricIntentResult {
  const intent = requireIntent(db, decision.intentId)
  const now = new Date().toISOString()
  const workflowId = `workflow-${randomUUID()}`
  const state: FabricWorkflowState = decision.outcome === 'deny'
    ? 'denied'
    : decision.outcome === 'waiting_user' ? 'waiting_user' : 'preparing'
  const executorId = decision.outcome === 'deny' ? null : decision.executorId
  db.prepare(`INSERT INTO fabric_workflows(
    id,intent_id,executor_id,policy_decision_id,state,version,attempt,max_attempts,
    lease_owner,lease_expires_at,retry_at,last_error_code,created_at,updated_at,completed_at
  ) VALUES(?,?,?,?,?,0,0,3,NULL,NULL,NULL,NULL,?,?,?)`).run(
    workflowId, intent.id, executorId, decision.id, state, now, now, state === 'denied' ? now : null,
  )
  if (decision.outcome !== 'deny') {
    const stepState: FabricStepState = decision.outcome === 'waiting_user' ? 'waiting_user' : 'pending'
    const contract = captureIntentContract(db, intent)
    const stepInput = canonicalStringify({ ...payload, contract })
    for (const [ordinal, kind] of ['prepare', 'execute', 'verify'].entries()) {
      db.prepare(`INSERT INTO fabric_steps(
        id,workflow_id,ordinal,kind,state,execution_token,executor_id,input_json,evidence_json,
        attempt,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,'[]',0,?,?)`).run(
        `step-${randomUUID()}`, workflowId, ordinal, kind, stepState, `execution-${randomUUID()}`,
        executorId, stepInput, now, now,
      )
    }
  }
  bindBudgetReservation(db, decision, workflowId)
  appendFabricAuditEvent(db, {
    eventType: 'workflow.created', actorUserId: intent.requestedByUserId,
    aggregateType: 'workflow', aggregateId: workflowId,
    payload: { intentId: intent.id, decisionId: decision.id, state }, occurredAt: now,
  })
  appendFabricOutbox(db, 'fabric.workflow.created', workflowId, {
    intentId: intent.id, decisionId: decision.id, state,
  })
  return resultForWorkflow(db, requireWorkflow(db, workflowId))
}

function bindBudgetReservation(db: DatabaseSync, decision: FabricPolicyDecision, workflowId: string): void {
  const ledger = db.prepare('SELECT workflow_id,status FROM fabric_budget_ledger WHERE decision_id=?').get(decision.id) as
    { workflow_id: string | null; status: string } | undefined
  if (!ledger) {
    if (decision.outcome === 'allow' && decision.budget && decision.budget.amountMinor > 0) {
      throw new Error('FABRIC_BUDGET_RESERVATION_MISSING')
    }
    return
  }
  if (ledger.status !== 'reserved') throw new Error('FABRIC_BUDGET_NOT_RESERVABLE')
  if (ledger.workflow_id !== null && ledger.workflow_id !== workflowId) throw new Error('FABRIC_BUDGET_OWNERSHIP_CONFLICT')
  db.prepare(`UPDATE fabric_budget_ledger SET workflow_id=?,updated_at=?
    WHERE decision_id=? AND workflow_id IS NULL`).run(workflowId, new Date().toISOString(), decision.id)
}

function resultForWorkflow(db: DatabaseSync, workflow: WorkflowRow): FabricIntentResult {
  const detail = detailForWorkflow(db, workflow)
  if (!detail.policyDecision) throw new Error('FABRIC_WORKFLOW_POLICY_NOT_FOUND')
  return { intent: detail.intent, policyDecision: detail.policyDecision, workflow: detail }
}

function detailForWorkflow(db: DatabaseSync, row: WorkflowRow): FabricWorkflowDetail {
  const summary = summaryForWorkflow(db, row)
  const intent = requireIntent(db, row.intent_id)
  const decision = row.policy_decision_id ? requireDecision(db, row.policy_decision_id) : null
  const steps = db.prepare('SELECT * FROM fabric_steps WHERE workflow_id=? ORDER BY ordinal ASC').all(row.id) as unknown as StepRow[]
  return { ...summary, intent, steps: steps.map(parseStep), policyDecision: decision ? parseDecision(decision) : null }
}

function summaryForWorkflow(db: DatabaseSync, row: WorkflowRow): FabricWorkflowSummary {
  const intent = requireIntent(db, row.intent_id)
  return {
    id: row.id, intentId: row.intent_id, executorId: row.executor_id,
    policyDecisionId: row.policy_decision_id, compensationIntentId: row.compensation_intent_id,
    state: row.state, version: row.version, attempt: row.attempt, maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at, retryAt: row.retry_at,
    lastErrorCode: row.last_error_code, createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at, capabilityId: intent.capabilityId, goal: intent.goal,
    requestedByRoleId: intent.requestedByRoleId, requestedByUserId: intent.requestedByUserId,
    availableActions: availableWorkflowActionsInDb(db, row),
  }
}

function availableWorkflowActionsInDb(db: DatabaseSync, workflow: WorkflowRow): FabricWorkflowAvailableActions {
  const decision = workflow.policy_decision_id ? parseDecision(requireDecision(db, workflow.policy_decision_id)) : null
  const waitingApproval = workflow.state === 'waiting_user' && decision?.outcome === 'waiting_user'
    && workflow.last_error_code === null
  const cancel = workflow.state === 'cancelled' || (TRANSITIONS.cancel[workflow.state] !== undefined
    && workflow.lease_owner === null && !hasActiveOrEffectfulStep(db, workflow.id))
  let retry = false
  if (workflow.state === 'failed' || workflow.state === 'dead_letter') {
    try { assertPhaseAwareRetryAllowed(db, workflow); retry = true } catch { retry = false }
  } else if (workflow.state === 'waiting_user') {
    if (workflow.last_error_code === 'FABRIC_CONTROL_CHANGED_REVIEW_REQUIRED') {
      retry = getFabricControlStateInDb(db).level === 0 && hasCurrentCapturedContract(db, workflow)
        && controlRecoveryDestinationInDb(db, workflow) !== null
    } else {
      try {
        retryWorkerWaitingEligibilityInDb(db, workflow)
        retry = true
      } catch { retry = false }
    }
  }
  let compensate = false
  if (workflow.state === 'succeeded' && workflow.compensation_intent_id === null) {
    try {
      const context = compensationContext(db, workflow.id)
      compensate = context.contract.reversible && context.contract.compensationCapabilityId !== null
        && !context.shadow && context.executorEnvironment !== 'sandbox'
        && hasCurrentCapturedContract(db, workflow)
    } catch { compensate = false }
  }
  return { approve: waitingApproval, reject: waitingApproval, cancel, retry, compensate }
}

function controlRecoveryDestinationInDb(
  db: DatabaseSync,
  workflow: WorkflowRow,
  knownContract?: CapturedContract,
): FabricWorkflowState | null {
  const contract = knownContract ?? compensationContext(db, workflow.id).contract
  const steps = db.prepare(`SELECT kind,state,started_at,output_json FROM fabric_steps
    WHERE workflow_id=? ORDER BY ordinal`).all(workflow.id) as unknown as Array<{
      kind: string; state: FabricStepState; started_at: string | null; output_json: string | null
    }>
  const prepare = steps.find(step => step.kind === 'prepare')
  const execute = steps.find(step => step.kind === 'execute')
  if (prepare?.state !== 'succeeded') return 'preparing'
  if (!execute) return null
  if (execute.state === 'succeeded' || execute.output_json !== null) return 'verifying'
  if (execute.started_at === null && (execute.state === 'pending' || execute.state === 'waiting_user')) {
    return 'executing'
  }
  return contract.verificationStrategy === 'none' ? null : 'verifying'
}

function hasCurrentCapturedContract(db: DatabaseSync, workflow: WorkflowRow): boolean {
  try {
    const intent = requireIntent(db, workflow.intent_id)
    const captured = compensationContext(db, workflow.id).contract
    const current = captureIntentContract(db, intent)
    return captured.capabilityVersion === current.capabilityVersion
      && captured.contractDigest === current.contractDigest
  } catch {
    return false
  }
}

function retryWorkerWaitingEligibilityInDb(db: DatabaseSync, current: WorkflowRow): void {
  const errorCode = current.last_error_code
  const supported = errorCode === 'FABRIC_EXECUTION_OUTCOME_UNKNOWN'
    || errorCode === 'FABRIC_VERIFICATION_OUTCOME_UNKNOWN'
    || errorCode === 'FABRIC_COMPENSATION_POLICY_UNAVAILABLE'
    || errorCode === 'FABRIC_WORKER_CONTRACT_MISSING'
  if (!supported) throw new Error('FABRIC_WORKFLOW_NOT_RETRYABLE')
  const context = compensationContext(db, current.id)
  if (errorCode !== 'FABRIC_WORKER_CONTRACT_MISSING' && context.contract.verificationStrategy === 'none') {
    throw new Error('FABRIC_WORKFLOW_NOT_RETRYABLE')
  }
}

function requireIntent(db: DatabaseSync, id: string): FabricActionIntent {
  const row = db.prepare('SELECT * FROM fabric_action_intents WHERE id=?').get(id) as IntentRow | undefined
  if (!row) throw new Error('FABRIC_INTENT_NOT_FOUND')
  return parseIntent(row)
}

function requireDecision(db: DatabaseSync, id: string): DecisionRow {
  const row = db.prepare('SELECT * FROM fabric_policy_decisions WHERE id=?').get(id) as DecisionRow | undefined
  if (!row) throw new Error('FABRIC_POLICY_DECISION_NOT_FOUND')
  return row
}

function requireWorkflow(db: DatabaseSync, id: string): WorkflowRow {
  const row = db.prepare('SELECT * FROM fabric_workflows WHERE id=?').get(id) as WorkflowRow | undefined
  if (!row) throw new Error('FABRIC_WORKFLOW_NOT_FOUND')
  return row
}

function selectWorkflowByIntent(db: DatabaseSync, intentId: string): WorkflowRow | undefined {
  return db.prepare('SELECT * FROM fabric_workflows WHERE intent_id=?').get(intentId) as WorkflowRow | undefined
}

function parseIntent(row: IntentRow): FabricActionIntent {
  return {
    id: row.id, capabilityId: row.capability_id, capabilityVersion: row.capability_version,
    requestedByRoleId: row.requested_by_role_id, requestedByUserId: row.requested_by_user_id,
    idempotencyKey: row.idempotency_key, goal: row.goal, target: parseObject(row.target_json),
    input: parseObject(row.input_json), constraints: parseObject(row.constraints_json), rationale: row.rationale,
    ...(row.expected_cost_currency === null ? {} : {
      expectedCost: { currency: row.expected_cost_currency, amountMinor: row.expected_cost_minor! },
    }),
    materialInputDigest: row.material_input_digest, sanitizedSummary: parseObject(row.sanitized_summary_json),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function parseDecision(row: DecisionRow): FabricPolicyDecision {
  return {
    id: row.id, intentId: row.intent_id, executorId: row.executor_id, outcome: row.outcome,
    reasonCodes: JSON.parse(row.reason_codes_json) as string[], policyVersion: row.policy_version,
    materialInputDigest: row.material_input_digest, policySnapshot: parseObject(row.policy_snapshot_json),
    sanitizedSummary: parseObject(row.sanitized_summary_json),
    budget: row.budget_currency === null ? null : { currency: row.budget_currency, amountMinor: row.budget_amount_minor! },
    createdAt: row.created_at,
  }
}

function parseStep(row: StepRow): FabricStep {
  return {
    id: row.id, workflowId: row.workflow_id, ordinal: row.ordinal, kind: row.kind, state: row.state,
    executionToken: row.execution_token, executorId: row.executor_id, input: parseObject(row.input_json),
    output: row.output_json === null ? null : parseObject(row.output_json),
    evidence: JSON.parse(row.evidence_json) as FabricEvidence[], attempt: row.attempt,
    lastErrorCode: row.last_error_code, createdAt: row.created_at, updatedAt: row.updated_at,
    startedAt: row.started_at, completedAt: row.completed_at,
  }
}

function parseObject(value: string): FabricJsonObject {
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('FABRIC_WORKFLOW_CORRUPT_JSON')
  return parsed as FabricJsonObject
}

function actionPayload(input: FabricActionIntentInput): ActionPayload {
  const budget = { nodes: 0 }
  const payload = strictJson({ actionInput: input.input, target: input.target, constraints: input.constraints }, 0, budget)
  if (!isJsonObject(payload)) throw new Error('FABRIC_WORKFLOW_INVALID_PAYLOAD')
  const canonical = canonicalStringify(payload)
  if (Buffer.byteLength(canonical, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('FABRIC_WORKFLOW_PAYLOAD_LIMIT')
  return payload as unknown as ActionPayload
}

function validatePersistedMetadata(input: FabricActionIntentInput): void {
  for (const value of [input.capabilityId, input.requestedByRoleId, input.requestedByUserId, input.idempotencyKey]) {
    if (typeof value === 'string' && SENSITIVE_STRING.test(value)) {
      throw new Error('FABRIC_WORKFLOW_SENSITIVE_PAYLOAD')
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 256
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
      throw new Error('FABRIC_WORKFLOW_INVALID_IDENTIFIER')
    }
  }
}

function strictJson(value: unknown, depth: number, budget: { nodes: number }): unknown {
  budget.nodes += 1
  if (budget.nodes > MAX_PAYLOAD_NODES || depth > MAX_PAYLOAD_DEPTH) throw new Error('FABRIC_WORKFLOW_PAYLOAD_LIMIT')
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_PAYLOAD_STRING_BYTES) throw new Error('FABRIC_WORKFLOW_PAYLOAD_LIMIT')
    if (SENSITIVE_STRING.test(value)) throw new Error('FABRIC_WORKFLOW_SENSITIVE_PAYLOAD')
    return value
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('FABRIC_WORKFLOW_INVALID_PAYLOAD')
    return value
  }
  if (typeof value !== 'object') throw new Error('FABRIC_WORKFLOW_INVALID_PAYLOAD')
  if (Array.isArray(value)) {
    if (value.length > MAX_PAYLOAD_ITEMS) throw new Error('FABRIC_WORKFLOW_PAYLOAD_LIMIT')
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) {
      throw new Error('FABRIC_WORKFLOW_INVALID_PAYLOAD')
    }
    const output: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('FABRIC_WORKFLOW_INVALID_PAYLOAD')
      output.push(strictJson(descriptor.value, depth + 1, budget))
    }
    return output
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error('FABRIC_WORKFLOW_INVALID_PAYLOAD')
  const source = value as Record<string, unknown>
  const keys = Reflect.ownKeys(source)
  if (keys.length > MAX_PAYLOAD_ITEMS || keys.some(key => typeof key !== 'string')) {
    throw new Error(keys.length > MAX_PAYLOAD_ITEMS ? 'FABRIC_WORKFLOW_PAYLOAD_LIMIT' : 'FABRIC_WORKFLOW_INVALID_PAYLOAD')
  }
  const semanticName = ['key', 'name', 'type', 'kind'].map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor === undefined) return undefined
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('FABRIC_WORKFLOW_INVALID_PAYLOAD')
    return descriptor.value
  }).find(item => typeof item === 'string' && isSensitivePayloadKey(item))
  const output: FabricJsonObject = {}
  for (const key of (keys as string[]).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('FABRIC_WORKFLOW_INVALID_PAYLOAD')
    if (key === '__proto__' || key === 'prototype' || key === 'constructor'
      || isSensitivePayloadKey(key)
      || (semanticName !== undefined && /^(value|content|data)$/i.test(key))) {
      throw new Error('FABRIC_WORKFLOW_SENSITIVE_PAYLOAD')
    }
    output[key] = strictJson(descriptor.value, depth + 1, budget)
  }
  return output
}

function isSensitivePayloadKey(key: string): boolean {
  const normalized = key.normalize('NFKC')
  if (UNICODE_CREDENTIAL_KEYS.has(normalized)) return true
  const tokens = normalized
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0) return false
  if (tokens.some(token => ALWAYS_SENSITIVE_TOKENS.has(token))) return true
  if (tokens.length === 1 && DIRECT_CREDENTIAL_KEYS.has(tokens[0])) return true
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (CREDENTIAL_ROOTS.has(tokens[index]) && CREDENTIAL_SUFFIXES.has(tokens[index + 1])) return true
  }
  const compact = tokens.join('')
  for (const root of CREDENTIAL_ROOTS) {
    if (!compact.startsWith(root)) continue
    const suffix = compact.slice(root.length)
    if (suffix && CREDENTIAL_SUFFIXES.has(suffix)) return true
  }
  return false
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalStringify(item)}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('FABRIC_WORKFLOW_INVALID_PAYLOAD')
  return encoded
}

function isJsonObject(value: unknown): value is FabricJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('FABRIC_WORKFLOW_INVALID_LIMIT')
  return Math.min(value, MAX_LIST_LIMIT)
}

function isTerminal(state: FabricWorkflowState): boolean {
  return ['succeeded', 'denied', 'cancelled', 'dead_letter', 'compensated'].includes(state)
}

function validateText(value: string, max: number, code: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(code)
  }
}

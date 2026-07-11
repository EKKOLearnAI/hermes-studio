import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { appendFabricAuditEvent, appendFabricOutbox, withFabricAuditedTransaction } from './audit'
import { withActionFabricDb } from './database'
import { evaluateFabricPolicy } from './policy'
import type {
  FabricActionIntent,
  FabricActionIntentInput,
  FabricEvidence,
  FabricJsonObject,
  FabricPolicyDecision,
  FabricStep,
  FabricStepState,
  FabricWorkflowDetail,
  FabricWorkflowListOptions,
  FabricWorkflowState,
  FabricWorkflowSummary,
} from './types'

const MAX_LIST_LIMIT = 200
const SUPPORTED_POLICY_VERSION = 1

export interface FabricIntentResult {
  intent: FabricActionIntent
  policyDecision: FabricPolicyDecision
  workflow: FabricWorkflowDetail
}

type WorkflowAction = 'approve' | 'reject' | 'cancel' | 'retry' | 'compensate'

// This is the sole map from public actions to destination states. Callers never select a state.
const TRANSITIONS: Record<WorkflowAction, Partial<Record<FabricWorkflowState, FabricWorkflowState>>> = {
  approve: { waiting_user: 'preparing' },
  reject: { waiting_user: 'cancelled' },
  cancel: {
    draft: 'cancelled', policy_check: 'cancelled', preparing: 'cancelled', executing: 'cancelled',
    verifying: 'cancelled', waiting_user: 'cancelled', retrying: 'cancelled', failed: 'cancelled',
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
  const decision = evaluateFabricPolicy(input)
  return withFabricAuditedTransaction(db => {
    const existing = selectWorkflowByIntent(db, decision.intentId)
    if (existing) {
      if (existing.policy_decision_id !== decision.id) throw new Error('FABRIC_WORKFLOW_POLICY_CONFLICT')
      return resultForWorkflow(db, existing)
    }

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
      db.prepare(`INSERT INTO fabric_steps(
        id,workflow_id,ordinal,kind,state,execution_token,executor_id,input_json,evidence_json,
        attempt,created_at,updated_at
      ) VALUES(?,?,0,'execute',?,?,?,?, '[]',0,?,?)`).run(
        `step-${randomUUID()}`, workflowId, stepState, `execution-${randomUUID()}`,
        executorId, JSON.stringify(intent.input), now, now,
      )
    }
    bindBudgetReservation(db, decision.id, workflowId)
    appendFabricAuditEvent(db, {
      eventType: 'workflow.created', actorUserId: intent.requestedByUserId,
      aggregateType: 'workflow', aggregateId: workflowId,
      payload: { intentId: intent.id, decisionId: decision.id, state }, occurredAt: now,
    })
    appendFabricOutbox(db, 'fabric.workflow.created', workflowId, {
      intentId: intent.id, decisionId: decision.id, state,
    })
    return resultForWorkflow(db, requireWorkflow(db, workflowId))
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
  return transitionWorkflow(id, actorUserId, 'approve', null)
}

export function rejectFabricWorkflow(id: string, actorUserId: string, reason: string): FabricWorkflowDetail {
  return transitionWorkflow(id, actorUserId, 'reject', reason)
}

export function cancelFabricWorkflow(id: string, actorUserId: string, reason: string): FabricWorkflowDetail {
  return transitionWorkflow(id, actorUserId, 'cancel', reason)
}

export function retryFabricWorkflow(id: string, actorUserId: string): FabricWorkflowDetail {
  return transitionWorkflow(id, actorUserId, 'retry', null)
}

export function requestFabricCompensation(id: string, actorUserId: string, reason: string): FabricWorkflowDetail {
  return transitionWorkflow(id, actorUserId, 'compensate', reason)
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
    const destination = TRANSITIONS[action][current.state]
    if (destination === undefined) {
      throw new Error(action === 'retry'
        ? 'FABRIC_WORKFLOW_NOT_RETRYABLE'
        : action === 'compensate' ? 'FABRIC_WORKFLOW_NOT_COMPENSATABLE' : 'FABRIC_WORKFLOW_INVALID_TRANSITION')
    }
    const intent = requireIntent(db, current.intent_id)
    const decision = current.policy_decision_id ? requireDecision(db, current.policy_decision_id) : null
    if (action === 'approve') assertApprovalCurrent(db, intent, decision)
    if (action === 'compensate') assertCompensatable(db, intent.capabilityId)

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

function assertApprovalCurrent(
  db: DatabaseSync,
  intent: FabricActionIntent,
  decision: DecisionRow | null,
): void {
  if (!decision || decision.outcome !== 'waiting_user'
    || decision.policy_version !== SUPPORTED_POLICY_VERSION
    || decision.material_input_digest !== intent.materialInputDigest) {
    throw new Error('FABRIC_WORKFLOW_APPROVAL_STALE')
  }
  const latest = db.prepare(`SELECT id, policy_version, material_input_digest FROM fabric_policy_decisions
    WHERE intent_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(intent.id) as
    { id: string; policy_version: number; material_input_digest: string } | undefined
  if (!latest || latest.id !== decision.id || latest.policy_version !== decision.policy_version
    || latest.material_input_digest !== intent.materialInputDigest) {
    throw new Error('FABRIC_WORKFLOW_APPROVAL_STALE')
  }
}

function assertCompensatable(db: DatabaseSync, capabilityId: string): void {
  const row = db.prepare(`SELECT reversible, compensation_capability_id FROM fabric_capabilities WHERE id=?`).get(capabilityId) as
    { reversible: number; compensation_capability_id: string | null } | undefined
  if (!row || row.reversible !== 1 || row.compensation_capability_id === null) {
    throw new Error('FABRIC_WORKFLOW_NOT_COMPENSATABLE')
  }
}

function updateStepsForAction(db: DatabaseSync, workflowId: string, action: WorkflowAction, now: string): void {
  if (action === 'approve') {
    db.prepare(`UPDATE fabric_steps SET state='pending',updated_at=?
      WHERE workflow_id=? AND state='waiting_user'`).run(now, workflowId)
  } else if (action === 'reject' || action === 'cancel') {
    db.prepare(`UPDATE fabric_steps SET state='cancelled',updated_at=?,completed_at=?
      WHERE workflow_id=? AND state IN ('pending','running','waiting_user','failed')`).run(now, now, workflowId)
  } else if (action === 'retry') {
    db.prepare(`UPDATE fabric_steps SET state='pending',attempt=attempt+1,last_error_code=NULL,
      output_json=NULL,evidence_json='[]',started_at=NULL,completed_at=NULL,updated_at=?
      WHERE workflow_id=? AND state='failed'`).run(now, workflowId)
  }
}

function bindBudgetReservation(db: DatabaseSync, decisionId: string, workflowId: string): void {
  const ledger = db.prepare('SELECT workflow_id FROM fabric_budget_ledger WHERE decision_id=?').get(decisionId) as
    { workflow_id: string | null } | undefined
  if (!ledger) return
  if (ledger.workflow_id !== null && ledger.workflow_id !== workflowId) throw new Error('FABRIC_BUDGET_OWNERSHIP_CONFLICT')
  db.prepare(`UPDATE fabric_budget_ledger SET workflow_id=?,updated_at=?
    WHERE decision_id=? AND workflow_id IS NULL`).run(workflowId, new Date().toISOString(), decisionId)
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

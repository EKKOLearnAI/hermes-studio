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
const MAX_PAYLOAD_BYTES = 32_768
const MAX_PAYLOAD_DEPTH = 8
const MAX_PAYLOAD_ITEMS = 64
const MAX_PAYLOAD_NODES = 4_096
const MAX_PAYLOAD_STRING_BYTES = 8_192
const SENSITIVE_STRING = /(?:\bBearer\s+\S+|\b(?:api[_ -]?key|access[_ -]?token|password|secret|credential)\s*[:=]\s*\S+|-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----|\b(?:postgres(?:ql)?|mysql|mongodb|redis|amqps?):\/\/|(?:^|[\s("'=])(?:[a-z]:[\\/]|\\\\|\/(?:etc|home|Users|usr|app|workspace|data|var|tmp|opt|root|mnt)\/))/i
const SENSITIVE_KEY_TOKENS = new Set([
  'token', 'secret', 'password', 'passphrase', 'bearer', 'auth', 'authorization', 'authentication',
  'cookie', 'session', 'credential', 'credentials', 'path', 'file', 'directory', 'dir', 'url', 'uri', 'dsn',
])
const SENSITIVE_KEY_PREFIXES = new Set([
  'api', 'private', 'access', 'refresh', 'client', 'encryption', 'signing', 'service', 'account',
])
const SENSITIVE_COMPACT_KEYS = new Set([
  'apikey', 'privatekey', 'accesskey', 'clientkey', 'servicekey', 'accountkey',
  'accesstoken', 'refreshtoken', 'clientsecret', 'passwordvalue',
])

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
  const payload = actionPayload(input)
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
  const compensation = createFabricIntent({
    capabilityId: context.contract.compensationCapabilityId,
    requestedByRoleId: context.intent.requestedByRoleId,
    requestedByUserId: context.intent.requestedByUserId,
    idempotencyKey: `compensation:${id}`,
    goal: 'Compensate a completed Action Fabric workflow',
    target: context.payload.target,
    input: { originalWorkflowId: id, originalExecutionReference: context.executeToken },
    constraints: { compensationForWorkflowId: id },
    rationale: reason,
  })
  return withFabricAuditedTransaction(db => {
    const current = requireWorkflow(db, id)
    if (current.compensation_intent_id !== null) return detailForWorkflow(db, current)
    if (current.state !== 'succeeded') throw new Error('FABRIC_WORKFLOW_NOT_COMPENSATABLE')
    const verified = compensationContext(db, id)
    if (verified.contract.capabilityVersion !== context.contract.capabilityVersion
      || verified.contract.contractDigest !== context.contract.contractDigest
      || verified.contract.compensationCapabilityId !== context.contract.compensationCapabilityId) {
      throw new Error('FABRIC_WORKFLOW_CONTRACT_STALE')
    }
    const destination = compensation.policyDecision.outcome === 'deny' ? current.state : 'compensating'
    const now = new Date().toISOString()
    const result = db.prepare(`UPDATE fabric_workflows SET compensation_intent_id=?,state=?,version=version+1,
      updated_at=?,completed_at=? WHERE id=? AND version=? AND state='succeeded' AND compensation_intent_id IS NULL`).run(
      compensation.intent.id, destination, now, destination === 'succeeded' ? current.completed_at : null,
      id, current.version,
    )
    if (result.changes !== 1) throw new Error('FABRIC_WORKFLOW_CONFLICT')
    appendFabricAuditEvent(db, {
      eventType: 'workflow.compensation_requested', actorUserId, aggregateType: 'workflow', aggregateId: id,
      payload: { compensationIntentId: compensation.intent.id, compensationWorkflowId: compensation.workflow.id,
        policyOutcome: compensation.policyDecision.outcome, from: current.state, to: destination, reason },
      occurredAt: now,
    })
    appendFabricOutbox(db, 'fabric.workflow.compensation_requested', id, {
      compensationIntentId: compensation.intent.id, compensationWorkflowId: compensation.workflow.id,
      policyOutcome: compensation.policyDecision.outcome, from: current.state, to: destination,
    })
    return detailForWorkflow(db, requireWorkflow(db, id))
  })
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

interface CapturedContract {
  capabilityVersion: number
  contractDigest: string
  reversible: boolean
  compensationCapabilityId: string | null
}

interface ActionPayload {
  actionInput: FabricJsonObject
  target: FabricJsonObject
  constraints: FabricJsonObject
}

function captureIntentContract(db: DatabaseSync, intent: FabricActionIntent): CapturedContract {
  const row = db.prepare(`SELECT version,contract_digest,reversible,compensation_capability_id
    FROM fabric_capabilities WHERE id=?`).get(intent.capabilityId) as {
      version: number; contract_digest: string; reversible: number; compensation_capability_id: string | null
    } | undefined
  if (!row || row.version !== intent.capabilityVersion) throw new Error('FABRIC_WORKFLOW_CONTRACT_STALE')
  return { capabilityVersion: row.version, contractDigest: row.contract_digest, reversible: row.reversible === 1,
    compensationCapabilityId: row.compensation_capability_id }
}

function compensationContext(db: DatabaseSync, id: string): {
  workflow: WorkflowRow
  intent: FabricActionIntent
  payload: ActionPayload
  contract: CapturedContract
  executeToken: string
} {
  const workflow = requireWorkflow(db, id)
  const intent = requireIntent(db, workflow.intent_id)
  const prepare = db.prepare(`SELECT input_json FROM fabric_steps
    WHERE workflow_id=? AND ordinal=0 AND kind='prepare'`).get(id) as { input_json: string } | undefined
  const execute = db.prepare(`SELECT execution_token FROM fabric_steps
    WHERE workflow_id=? AND ordinal=1 AND kind='execute'`).get(id) as { execution_token: string } | undefined
  if (!prepare || !execute) throw new Error('FABRIC_WORKFLOW_CONTRACT_UNAVAILABLE')
  const stored = parseObject(prepare.input_json) as Record<string, unknown>
  const contract = stored.contract as Partial<CapturedContract> | undefined
  const payload = { actionInput: stored.actionInput, target: stored.target, constraints: stored.constraints }
  if (!contract || contract.capabilityVersion !== intent.capabilityVersion
    || typeof contract.contractDigest !== 'string' || typeof contract.reversible !== 'boolean'
    || !(typeof contract.compensationCapabilityId === 'string' || contract.compensationCapabilityId === null)
    || !isJsonObject(payload.actionInput) || !isJsonObject(payload.target) || !isJsonObject(payload.constraints)) {
    throw new Error('FABRIC_WORKFLOW_CONTRACT_UNAVAILABLE')
  }
  return { workflow, intent, payload: payload as ActionPayload, contract: contract as CapturedContract,
    executeToken: execute.execution_token }
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

function actionPayload(input: FabricActionIntentInput): ActionPayload {
  const budget = { nodes: 0 }
  const payload = strictJson({ actionInput: input.input, target: input.target, constraints: input.constraints }, 0, budget)
  if (!isJsonObject(payload)) throw new Error('FABRIC_WORKFLOW_INVALID_PAYLOAD')
  const canonical = canonicalStringify(payload)
  if (Buffer.byteLength(canonical, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('FABRIC_WORKFLOW_PAYLOAD_LIMIT')
  return payload as unknown as ActionPayload
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
  if (!/^[\x20-\x7e]+$/.test(key)) return true
  const tokens = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.some(token => SENSITIVE_KEY_TOKENS.has(token))) return true
  if (SENSITIVE_COMPACT_KEYS.has(tokens.join(''))) return true
  const keyIndex = tokens.indexOf('key')
  return keyIndex > 0 && tokens.slice(0, keyIndex).some(token => SENSITIVE_KEY_PREFIXES.has(token))
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

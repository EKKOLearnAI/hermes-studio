import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { logger } from '../../logger'
import { appendFabricAuditEvent, appendFabricOutbox, withFabricAuditedTransaction } from './audit'
import { getFabricControlStateInDb } from './control'
import {
  invokeFabricExecutor,
  type FabricExecutionContext,
  type FabricExecutorPhase,
  type FabricExecutorResult,
} from './executors'
import type { FabricEvidence, FabricExecutorType, FabricJsonObject, FabricWorkflowState } from './types'
import { isFabricWorkflowWorkerState } from './workflows'

const LEASE_MS = 30_000
const DEFAULT_INTERVAL_MS = 1_000
const MAX_INTERVAL_MS = 60_000
const CIRCUIT_BREAKER_THRESHOLD = 3

export interface FabricWorkerCycleResult {
  processed: boolean
  workerId: string
  workflowId: string | null
  stepId: string | null
  phase: FabricExecutorPhase | null
  outcome: string | null
  stale?: boolean
}

export interface FabricWorkerOptions {
  workerId?: string
  intervalMs?: number
  clock?: () => Date
}

export interface FabricWorkerHandle {
  readonly workerId: string
  stop(): Promise<void>
}

interface WorkflowClaim {
  workerId: string
  workflowId: string
  workflowVersion: number
  intentId: string
  stepId: string
  stepOrdinal: number
  stepAttempt: number
  executionToken: string
  phase: FabricExecutorPhase
  executorId: string
  executorType: FabricExecutorType
  capabilityId: string
  capabilityVersion: number
  contractDigest: string
  policyEvaluationToken: string
  input: FabricJsonObject
  target: FabricJsonObject
  preparedOutput?: FabricJsonObject
  executionOutput?: FabricJsonObject
  leaseExpiresAt: string
  actorUserId: string
  reversible: boolean
}

interface CandidateRow {
  workflow_id: string
  workflow_version: number
  workflow_state: FabricWorkflowState
  lease_owner: string | null
  lease_expires_at: string | null
  intent_id: string
  requested_by_user_id: string
  capability_id: string
  capability_version: number
  executor_id: string
  executor_type: FabricExecutorType
  executor_configuration_json: string
  policy_snapshot_json: string
  step_id: string
  step_ordinal: number
  step_kind: string
  step_state: string
  step_attempt: number
  execution_token: string
  input_json: string
}

let running: { handle: FabricWorkerHandle; timer: ReturnType<typeof setInterval>; inFlight: Promise<void> | null } | null = null

export async function processActionFabricOnce(
  options: { workerId?: string; now?: Date } = {},
): Promise<FabricWorkerCycleResult> {
  const workerId = validWorkerId(options.workerId ?? `worker-${randomUUID()}`)
  const now = validDate(options.now ?? new Date())
  const claim = claimNextWorkflow(workerId, now)
  if (!claim) return emptyResult(workerId)
  const context: FabricExecutionContext = {
    intentId: claim.intentId,
    workflowId: claim.workflowId,
    stepId: claim.stepId,
    executorId: claim.executorId,
    executorType: claim.executorType,
    capabilityId: claim.capabilityId,
    capabilityVersion: claim.capabilityVersion,
    contractDigest: claim.contractDigest,
    policyEvaluationToken: claim.policyEvaluationToken,
    executionToken: claim.executionToken,
    input: claim.input,
    target: claim.target,
    ...(claim.preparedOutput ? { preparedOutput: claim.preparedOutput } : {}),
    ...(claim.executionOutput ? { executionOutput: claim.executionOutput } : {}),
    now: now.toISOString(),
  }
  let result: FabricExecutorResult
  try {
    // invokeFabricExecutor re-resolves the durable binding immediately before every adapter call.
    result = await invokeFabricExecutor(claim.phase as never, context) as FabricExecutorResult
  } catch (error) {
    result = invocationFailure(claim.phase, error)
  }
  const committed = commitClaim(claim, result, now)
  const errorClass = result.errorCode ?? result.outcome
  if (committed) logger.info({ workerId, workflowId: claim.workflowId, stepId: claim.stepId,
    phase: claim.phase, outcome: result.outcome, errorClass }, '[action-fabric] worker cycle')
  else logger.warn({ workerId, workflowId: claim.workflowId, stepId: claim.stepId,
    phase: claim.phase, errorClass: 'STALE_CLAIM' }, '[action-fabric] stale worker result ignored')
  return { processed: true, workerId, workflowId: claim.workflowId, stepId: claim.stepId,
    phase: claim.phase, outcome: result.outcome, ...(committed ? {} : { stale: true }) }
}

export function startActionFabricWorker(options: FabricWorkerOptions = {}): FabricWorkerHandle {
  if (running) return running.handle
  const workerId = validWorkerId(options.workerId ?? `worker-${randomUUID()}`)
  const intervalMs = validInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS)
  const clock = options.clock ?? (() => new Date())
  const handle: FabricWorkerHandle = { workerId, stop: stopActionFabricWorker }
  const state = { handle, timer: undefined as unknown as ReturnType<typeof setInterval>, inFlight: null as Promise<void> | null }
  state.timer = setInterval(() => {
    if (state.inFlight) return
    state.inFlight = processActionFabricOnce({ workerId, now: clock() })
      .then(() => undefined)
      .catch(error => logger.error({ workerId, errorClass: stableErrorClass(error) }, '[action-fabric] worker cycle failed'))
      .finally(() => { state.inFlight = null })
  }, intervalMs)
  state.timer.unref?.()
  running = state
  return handle
}

export async function stopActionFabricWorker(): Promise<void> {
  const state = running
  if (!state) return
  running = null
  clearInterval(state.timer)
  if (state.inFlight) await state.inFlight
}

function claimNextWorkflow(workerId: string, now: Date): WorkflowClaim | null {
  return withFabricAuditedTransaction(db => {
    const nowIso = now.toISOString()
    const control = getFabricControlStateInDb(db)
    const retry = control.level < 2 ? selectRetryCandidate(db, nowIso) : undefined
    if (retry) {
      const changed = db.prepare(`UPDATE fabric_workflows SET state='executing',version=version+1,
        retry_at=NULL,updated_at=? WHERE id=? AND version=? AND state='retrying' AND retry_at<=?
        AND (lease_expires_at IS NULL OR lease_expires_at<=?)`).run(
        nowIso, retry.workflow_id, retry.workflow_version, nowIso, nowIso,
      )
      if (changed.changes !== 1) return null
      db.prepare(`UPDATE fabric_steps SET state='pending',output_json=NULL,evidence_json='[]',
        last_error_code=NULL,started_at=NULL,completed_at=NULL,updated_at=?
        WHERE workflow_id=? AND kind IN ('execute','verify')`).run(nowIso, retry.workflow_id)
      auditTransition(db, retry, 'retrying', 'executing', 'retry_due', nowIso)
      return null
    }
    const row = selectCandidate(db, nowIso, control.level)
    if (!row || !isFabricWorkflowWorkerState(row.workflow_state)) return null
    const interrupt = control.level >= 2 && isInterruptible(row)
    const phase = interrupt ? 'interrupt' : phaseFor(row)
    if (control.level >= 2 && !interrupt) return moveNonInterruptibleToWaitingUser(db, row, nowIso)
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString()
    const recovered = row.lease_owner !== null && row.lease_expires_at !== null && row.lease_expires_at <= nowIso
    const leaseGuard = interrupt ? '' : ' AND (lease_expires_at IS NULL OR lease_expires_at<=?)'
    const parameters: Array<string | number> = [
      workerId, leaseExpiresAt, nowIso, row.workflow_id, row.workflow_version, row.workflow_state,
    ]
    if (!interrupt) parameters.push(nowIso)
    const updated = db.prepare(`UPDATE fabric_workflows SET lease_owner=?,lease_expires_at=?,version=version+1,updated_at=?
      WHERE id=? AND version=? AND state=?${leaseGuard}`).run(...parameters)
    if (updated.changes !== 1) return null
    if (!interrupt) {
      const step = db.prepare(`UPDATE fabric_steps SET state='running',attempt=attempt+1,started_at=COALESCE(started_at,?),
        updated_at=? WHERE id=? AND state IN ('pending','running')`).run(nowIso, nowIso, row.step_id)
      if (step.changes !== 1) throw new Error('FABRIC_WORKER_STEP_CONFLICT')
    }
    const eventType = interrupt && row.lease_owner !== null
      ? 'workflow.emergency_interrupt_claimed'
      : recovered ? 'workflow.lease_recovered' : 'workflow.lease_acquired'
    appendFabricAuditEvent(db, { eventType, actorUserId: workerId, aggregateType: 'workflow',
      aggregateId: row.workflow_id, payload: { stepId: row.step_id, phase }, occurredAt: nowIso })
    appendFabricOutbox(db, `fabric.${eventType}`, row.workflow_id, { stepId: row.step_id, phase })
    return buildClaim(db, row, workerId, row.workflow_version + 1, leaseExpiresAt, phase)
  })
}

function selectRetryCandidate(db: DatabaseSync, now: string): CandidateRow | undefined {
  return db.prepare(`${candidateSelect()} WHERE w.state='retrying' AND w.retry_at<=?
    AND (w.lease_expires_at IS NULL OR w.lease_expires_at<=?) ORDER BY w.retry_at,w.created_at LIMIT 1`)
    .get(now, now) as CandidateRow | undefined
}

function selectCandidate(db: DatabaseSync, now: string, controlLevel: number): CandidateRow | undefined {
  const states = controlLevel >= 2 ? "'preparing','executing','verifying'" : "'preparing','executing','verifying'"
  const availability = controlLevel >= 2
    ? "AND s.state IN ('pending','running')"
    : "AND (s.state='pending' OR (s.state='running' AND w.lease_owner IS NOT NULL)) AND (w.lease_expires_at IS NULL OR w.lease_expires_at<=?)"
  const parameters = controlLevel >= 2 ? [] : [now]
  return db.prepare(`${candidateSelect()} WHERE w.state IN (${states})
    AND s.ordinal=CASE w.state WHEN 'preparing' THEN 0 WHEN 'executing' THEN 1 ELSE 2 END
    ${availability} ORDER BY w.created_at,w.id LIMIT 1`).get(...parameters) as CandidateRow | undefined
}

function candidateSelect(): string {
  return `SELECT w.id workflow_id,w.version workflow_version,w.state workflow_state,w.lease_owner,w.lease_expires_at,
    i.id intent_id,i.requested_by_user_id,i.capability_id,i.capability_version,
    e.id executor_id,e.type executor_type,e.configuration_json executor_configuration_json,
    p.policy_snapshot_json,s.id step_id,s.ordinal step_ordinal,s.kind step_kind,s.state step_state,
    s.attempt step_attempt,s.execution_token,s.input_json
    FROM fabric_workflows w JOIN fabric_action_intents i ON i.id=w.intent_id
    JOIN fabric_policy_decisions p ON p.id=w.policy_decision_id
    JOIN fabric_executors e ON e.id=w.executor_id
    JOIN fabric_steps s ON s.workflow_id=w.id`
}

function buildClaim(
  db: DatabaseSync,
  row: CandidateRow,
  workerId: string,
  workflowVersion: number,
  leaseExpiresAt: string,
  phase: FabricExecutorPhase,
): WorkflowClaim {
  const stepInput = parseObject(row.input_json)
  const contract = parseObjectProperty(stepInput, 'contract')
  const input = parseObjectProperty(stepInput, 'actionInput')
  const target = parseObjectProperty(stepInput, 'target')
  const prepared = selectStepOutput(db, row.workflow_id, 0)
  const executed = selectStepOutput(db, row.workflow_id, 1)
  const snapshot = parseObject(row.policy_snapshot_json)
  const token = snapshot.registryPolicyEvaluationToken
  if (typeof token !== 'string') throw new Error('FABRIC_WORKER_POLICY_TOKEN_MISSING')
  if (typeof contract.contractDigest !== 'string' || typeof contract.reversible !== 'boolean') {
    throw new Error('FABRIC_WORKER_CONTRACT_MISSING')
  }
  return {
    workerId, workflowId: row.workflow_id, workflowVersion, intentId: row.intent_id,
    stepId: row.step_id, stepOrdinal: row.step_ordinal, stepAttempt: row.step_attempt + 1,
    executionToken: row.execution_token, phase, executorId: row.executor_id, executorType: row.executor_type,
    capabilityId: row.capability_id, capabilityVersion: row.capability_version,
    contractDigest: contract.contractDigest, policyEvaluationToken: token,
    input, target, ...(prepared ? { preparedOutput: prepared } : {}),
    ...(executed ? { executionOutput: executed } : {}), leaseExpiresAt,
    actorUserId: row.requested_by_user_id, reversible: contract.reversible,
  }
}

function commitClaim(claim: WorkflowClaim, result: FabricExecutorResult, now: Date): boolean {
  return withFabricAuditedTransaction(db => {
    const current = db.prepare('SELECT state,version,lease_owner,lease_expires_at,max_attempts,attempt FROM fabric_workflows WHERE id=?')
      .get(claim.workflowId) as { state: FabricWorkflowState; version: number; lease_owner: string | null;
        lease_expires_at: string | null; max_attempts: number; attempt: number } | undefined
    const step = db.prepare('SELECT state,execution_token,attempt FROM fabric_steps WHERE id=?').get(claim.stepId) as
      { state: string; execution_token: string; attempt: number } | undefined
    if (!current || !step || current.version !== claim.workflowVersion || current.lease_owner !== claim.workerId
      || current.lease_expires_at !== claim.leaseExpiresAt || step.execution_token !== claim.executionToken
      || (!isStateForPhase(current.state, claim.phase)) || (claim.phase !== 'interrupt' && step.state !== 'running')) return false
    const nowIso = now.toISOString()
    const transition = outcomeTransition(claim, result, current, now)
    if (claim.phase !== 'interrupt') {
      db.prepare(`UPDATE fabric_steps SET state=?,output_json=?,evidence_json=?,last_error_code=?,
        updated_at=?,completed_at=? WHERE id=? AND state='running' AND execution_token=? AND attempt=?`).run(
        transition.stepState, JSON.stringify(result.output), JSON.stringify(result.evidence), result.errorCode,
        nowIso, transition.stepState === 'waiting_user' ? null : nowIso, claim.stepId, claim.executionToken, step.attempt,
      )
    } else if (transition.state === 'cancelled') {
      db.prepare(`UPDATE fabric_steps SET state='cancelled',updated_at=?,completed_at=?
        WHERE workflow_id=? AND state IN ('pending','running','waiting_user')`).run(nowIso, nowIso, claim.workflowId)
    } else {
      db.prepare(`UPDATE fabric_steps SET state='waiting_user',updated_at=?
        WHERE workflow_id=? AND state IN ('pending','running')`).run(nowIso, claim.workflowId)
    }
    const changed = db.prepare(`UPDATE fabric_workflows SET state=?,version=version+1,attempt=?,retry_at=?,
      last_error_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?,completed_at=?
      WHERE id=? AND version=? AND lease_owner=? AND lease_expires_at=?`).run(
      transition.state, transition.attempt, transition.retryAt, transition.errorCode, nowIso,
      transition.completedAt, claim.workflowId, current.version, claim.workerId, claim.leaseExpiresAt,
    )
    if (changed.changes !== 1) throw new Error('FABRIC_WORKER_COMMIT_CONFLICT')
    updateCircuitBreaker(db, claim, result, nowIso)
    settleBudget(db, claim, transition.state, nowIso)
    appendFabricAuditEvent(db, { eventType: 'workflow.step_checkpointed', actorUserId: claim.workerId,
      aggregateType: 'workflow', aggregateId: claim.workflowId,
      payload: { stepId: claim.stepId, phase: claim.phase, outcome: result.outcome,
        from: current.state, to: transition.state, errorClass: result.errorCode }, occurredAt: nowIso })
    appendFabricOutbox(db, 'fabric.workflow.step_checkpointed', claim.workflowId,
      { stepId: claim.stepId, phase: claim.phase, outcome: result.outcome,
        from: current.state, to: transition.state, errorClass: result.errorCode })
    return true
  })
}

function outcomeTransition(
  claim: WorkflowClaim,
  result: FabricExecutorResult,
  current: { max_attempts: number; attempt: number },
  now: Date,
): { state: FabricWorkflowState; stepState: string; attempt: number; retryAt: string | null;
  errorCode: string | null; completedAt: string | null } {
  if (claim.phase === 'interrupt') {
    if (result.outcome === 'interrupted') return terminal('cancelled', current.attempt, result.errorCode, now)
    return { state: 'waiting_user', stepState: 'waiting_user', attempt: current.attempt,
      retryAt: null, errorCode: result.errorCode ?? 'FABRIC_INTERRUPT_UNRESOLVED', completedAt: null }
  }
  if (claim.phase === 'prepare') {
    if (result.outcome === 'prepared') return active('executing', current.attempt)
    return terminal('dead_letter', current.max_attempts, result.errorCode ?? 'FABRIC_PREPARE_FAILED', now)
  }
  if (claim.phase === 'execute') {
    if (result.outcome === 'succeeded') return active('verifying', current.attempt)
    if (result.outcome === 'unknown') return waiting(result.errorCode ?? 'FABRIC_EXECUTION_UNKNOWN', current.attempt)
    if (result.outcome === 'temporary_failure' && result.safeToRetry) {
      return retryOrDeadLetter(current, result.errorCode ?? 'FABRIC_EXECUTION_TEMPORARY', now)
    }
    return terminal('dead_letter', current.max_attempts, result.errorCode ?? 'FABRIC_EXECUTION_FAILED', now)
  }
  if (claim.phase === 'verify') {
    if (result.outcome === 'verified') return terminal('succeeded', current.attempt, null, now, 'succeeded')
    if (result.outcome === 'unknown') return waiting(result.errorCode ?? 'FABRIC_VERIFICATION_UNKNOWN', current.attempt)
    if (result.outcome === 'mismatch') {
      if (claim.reversible) return { state: 'compensating', stepState: 'failed', attempt: current.attempt,
        retryAt: null, errorCode: result.errorCode ?? 'FABRIC_VERIFICATION_MISMATCH', completedAt: null }
      return retryOrDeadLetter(current, result.errorCode ?? 'FABRIC_VERIFICATION_MISMATCH', now)
    }
    return terminal('dead_letter', current.max_attempts, result.errorCode ?? 'FABRIC_VERIFICATION_FAILED', now)
  }
  return waiting(result.errorCode ?? 'FABRIC_COMPENSATION_UNRESOLVED', current.attempt)
}

function retryOrDeadLetter(current: { attempt: number; max_attempts: number }, errorCode: string, now: Date) {
  const attempt = current.attempt + 1
  if (attempt >= current.max_attempts) return terminal('dead_letter', attempt, errorCode, now)
  const delayMs = Math.min(60_000, 1_000 * (2 ** (attempt - 1)))
  return { state: 'retrying' as const, stepState: 'failed', attempt,
    retryAt: new Date(now.getTime() + delayMs).toISOString(), errorCode, completedAt: null }
}

function active(state: FabricWorkflowState, attempt: number, errorCode: string | null = null) {
  return { state, stepState: 'succeeded', attempt, retryAt: null, errorCode, completedAt: null }
}

function waiting(errorCode: string, attempt: number) {
  return { state: 'waiting_user' as const, stepState: 'waiting_user', attempt,
    retryAt: null, errorCode, completedAt: null }
}

function terminal(
  state: FabricWorkflowState,
  attempt: number,
  errorCode: string | null,
  now: Date,
  stepState = 'failed',
) {
  return { state, stepState, attempt, retryAt: null, errorCode, completedAt: now.toISOString() }
}

function updateCircuitBreaker(db: DatabaseSync, claim: WorkflowClaim, result: FabricExecutorResult, now: string): void {
  const row = db.prepare('SELECT health_details_json FROM fabric_executors WHERE id=?').get(claim.executorId) as
    { health_details_json: string } | undefined
  if (!row) return
  const details = parseObject(row.health_details_json)
  const adapterFailure = result.errorCode === 'FABRIC_EXECUTOR_EXCEPTION'
    || result.errorCode === 'FABRIC_EXECUTOR_CONTRACT_VIOLATION'
    || result.errorCode === 'FABRIC_EXECUTOR_ADAPTER_UNAVAILABLE'
  const previous = Number.isSafeInteger(details.consecutiveAdapterFailures) ? details.consecutiveAdapterFailures as number : 0
  const failures = adapterFailure ? previous + 1 : 0
  if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
    const persisted = { ...details, circuitBreaker: 'open', consecutiveAdapterFailures: failures,
      openedAt: now, errorClass: result.errorCode, recoveryMode: 'manual_admin_reset' }
    db.prepare(`UPDATE fabric_executors SET enabled=0,health='unhealthy',health_details_json=?,
      policy_version=policy_version+1,updated_at=? WHERE id=?`).run(JSON.stringify(persisted), now, claim.executorId)
    db.prepare(`UPDATE fabric_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)
      WHERE key='registry_policy_revision'`).run()
    appendFabricAuditEvent(db, { eventType: 'executor.circuit_breaker.opened', actorUserId: claim.workerId,
      aggregateType: 'executor', aggregateId: claim.executorId,
      payload: { consecutiveFailures: failures, errorClass: result.errorCode }, occurredAt: now })
    appendFabricOutbox(db, 'fabric.executor.circuit_breaker.opened', claim.executorId,
      { consecutiveFailures: failures, errorClass: result.errorCode })
  } else {
    db.prepare('UPDATE fabric_executors SET health_details_json=?,updated_at=? WHERE id=?').run(
      JSON.stringify({ ...details, circuitBreaker: 'closed', consecutiveAdapterFailures: failures }), now, claim.executorId,
    )
  }
}

function settleBudget(db: DatabaseSync, claim: WorkflowClaim, state: FabricWorkflowState, now: string): void {
  if (state !== 'succeeded' && state !== 'cancelled' && state !== 'dead_letter') return
  const ledger = db.prepare(`SELECT id,status FROM fabric_budget_ledger WHERE workflow_id=? ORDER BY created_at LIMIT 1`)
    .get(claim.workflowId) as { id: string; status: string } | undefined
  if (!ledger || ledger.status !== 'reserved') return
  const status = state === 'succeeded' ? 'committed' : 'released'
  db.prepare('UPDATE fabric_budget_ledger SET status=?,updated_at=? WHERE id=? AND status=\'reserved\'')
    .run(status, now, ledger.id)
  appendFabricAuditEvent(db, { eventType: `budget.${status}`, actorUserId: claim.actorUserId,
    aggregateType: 'workflow', aggregateId: claim.workflowId, payload: {}, occurredAt: now })
  appendFabricOutbox(db, `fabric.budget.${status}`, claim.workflowId, {})
}

function moveNonInterruptibleToWaitingUser(db: DatabaseSync, row: CandidateRow, now: string): null {
  const changed = db.prepare(`UPDATE fabric_workflows SET state='waiting_user',version=version+1,
    lease_owner=NULL,lease_expires_at=NULL,last_error_code='FABRIC_EMERGENCY_STOP_REVIEW_REQUIRED',updated_at=?
    WHERE id=? AND version=?`).run(now, row.workflow_id, row.workflow_version)
  if (changed.changes === 1) auditTransition(db, row, row.workflow_state, 'waiting_user', 'emergency_stop', now)
  return null
}

function auditTransition(
  db: DatabaseSync,
  row: Pick<CandidateRow, 'workflow_id' | 'requested_by_user_id'>,
  from: FabricWorkflowState,
  to: FabricWorkflowState,
  reason: string,
  now: string,
): void {
  appendFabricAuditEvent(db, { eventType: 'workflow.transitioned', actorUserId: row.requested_by_user_id,
    aggregateType: 'workflow', aggregateId: row.workflow_id, payload: { from, to, reason }, occurredAt: now })
  appendFabricOutbox(db, 'fabric.workflow.transitioned', row.workflow_id, { from, to, reason })
}

function isInterruptible(row: CandidateRow): boolean {
  if (row.executor_type === 'simulator') return true
  const configuration = parseObject(row.executor_configuration_json)
  return configuration.interruptible === true
}

function phaseFor(row: CandidateRow): FabricExecutorPhase {
  if (row.workflow_state === 'preparing') return 'prepare'
  if (row.workflow_state === 'executing') return 'execute'
  if (row.workflow_state === 'verifying') return 'verify'
  throw new Error('FABRIC_WORKER_STATE_INVALID')
}

function isStateForPhase(state: FabricWorkflowState, phase: FabricExecutorPhase): boolean {
  return phase === 'interrupt'
    ? ['preparing', 'executing', 'verifying'].includes(state)
    : (phase === 'prepare' && state === 'preparing')
      || (phase === 'execute' && state === 'executing')
      || (phase === 'verify' && state === 'verifying')
}

function selectStepOutput(db: DatabaseSync, workflowId: string, ordinal: number): FabricJsonObject | undefined {
  const row = db.prepare('SELECT output_json FROM fabric_steps WHERE workflow_id=? AND ordinal=? AND state=\'succeeded\'')
    .get(workflowId, ordinal) as { output_json: string | null } | undefined
  return row?.output_json ? parseObject(row.output_json) : undefined
}

function parseObjectProperty(value: FabricJsonObject, key: string): FabricJsonObject {
  const item = value[key]
  if (item === null || Array.isArray(item) || typeof item !== 'object') throw new Error('FABRIC_WORKER_INPUT_CORRUPT')
  return item as FabricJsonObject
}

function parseObject(value: string): FabricJsonObject {
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('FABRIC_WORKER_JSON_CORRUPT')
  return parsed as FabricJsonObject
}

function invocationFailure(phase: FabricExecutorPhase, error: unknown): FabricExecutorResult {
  const outcome = phase === 'prepare' ? 'failed' : phase === 'execute' ? 'unknown'
    : phase === 'verify' ? 'unknown' : phase === 'interrupt' ? 'unknown' : 'unknown'
  return { outcome, output: {}, evidence: [] as FabricEvidence[], errorCode: stableErrorClass(error), safeToRetry: false } as FabricExecutorResult
}

function stableErrorClass(error: unknown): string {
  if (error instanceof Error && /^FABRIC_[A-Z0-9_]+$/.test(error.message)) return error.message
  return 'FABRIC_WORKER_EXCEPTION'
}

function validWorkerId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error('FABRIC_WORKER_ID_INVALID')
  return value
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('FABRIC_WORKER_CLOCK_INVALID')
  return value
}

function validInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INTERVAL_MS) throw new Error('FABRIC_WORKER_INTERVAL_INVALID')
  return value
}

function emptyResult(workerId: string): FabricWorkerCycleResult {
  return { processed: false, workerId, workflowId: null, stepId: null, phase: null, outcome: null }
}

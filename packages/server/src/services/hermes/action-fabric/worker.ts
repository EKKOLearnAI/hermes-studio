import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { logger } from '../../logger'
import { appendFabricAuditEvent, appendFabricOutbox, withFabricAuditedTransaction } from './audit'
import { getFabricControlState, getFabricControlStateInDb } from './control'
import {
  invokeFabricExecutor,
  type FabricExecutionContext,
  type FabricExecutorPhase,
  type FabricExecutorResult,
} from './executors'
import type { FabricEvidence, FabricExecutorType, FabricJsonObject, FabricWorkflowState } from './types'
import {
  buildFabricCompensationInput,
  createFabricCompensationChildInDb,
  isFabricWorkflowWorkerState,
  prepareFabricCompensation,
  type PreparedFabricCompensation,
} from './workflows'

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
  controlPollMs?: number
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
  executeToken: string
  phase: FabricExecutorPhase
  executorId: string
  executorType: FabricExecutorType
  capabilityId: string
  capabilityVersion: number
  contractDigest: string
  policyEvaluationToken: string
  controlVersion: number
  input: FabricJsonObject
  target: FabricJsonObject
  preparedOutput?: FabricJsonObject
  executionOutput?: FabricJsonObject
  leaseExpiresAt: string
  actorUserId: string
  requestedByRoleId: string
  reversible: boolean
  compensationCapabilityId: string | null
  idempotency: 'required' | 'supported' | 'none'
  verificationStrategy: string
  interruptible: boolean
  executorEnvironment: string
  shadow: boolean
}

interface CandidateRow {
  workflow_id: string
  workflow_version: number
  workflow_state: FabricWorkflowState
  lease_owner: string | null
  lease_expires_at: string | null
  intent_id: string
  requested_by_user_id: string
  requested_by_role_id: string
  capability_id: string
  capability_version: number
  executor_id: string
  executor_type: FabricExecutorType
  executor_environment: string
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

interface ManagedWorkerState {
  generation: number
  handle: FabricWorkerHandle
  timer: ReturnType<typeof setInterval>
  controlTimer: ReturnType<typeof setInterval>
  inFlight: Promise<void> | null
  interruptInFlight: Promise<void> | null
  stopping: Promise<void> | null
}

let running: ManagedWorkerState | null = null
let workerGeneration = 0

export async function processActionFabricOnce(
  options: { workerId?: string; now?: Date; clock?: () => Date } = {},
): Promise<FabricWorkerCycleResult> {
  return processActionFabricCycle(options, false)
}

async function processActionFabricCycle(
  options: { workerId?: string; now?: Date; clock?: () => Date },
  emergencyOnly: boolean,
): Promise<FabricWorkerCycleResult> {
  const workerId = validWorkerId(options.workerId ?? `worker-${randomUUID()}`)
  const now = validDate(options.now ?? options.clock?.() ?? new Date())
  const claim = claimNextWorkflow(workerId, now, emergencyOnly)
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
  let compensation: PreparedFabricCompensation | null | undefined
  if (claim.phase === 'verify' && result.outcome === 'mismatch' && claim.reversible
    && claim.verificationStrategy !== 'none') {
    try {
      if (claim.compensationCapabilityId === null) compensation = null
      else {
        const request = buildFabricCompensationInput({
          originalCapabilityId: claim.capabilityId,
          compensationCapabilityId: claim.compensationCapabilityId,
          requestedByRoleId: claim.requestedByRoleId,
          requestedByUserId: claim.actorUserId,
          workflowId: claim.workflowId,
          executeToken: claim.executeToken,
          target: claim.target,
          input: claim.input,
          executionOutput: claim.executionOutput,
          executorEnvironment: claim.executorEnvironment,
          shadow: claim.shadow,
          rationale: 'Verification mismatch recovery',
        })
        compensation = request ? prepareFabricCompensation(request) : null
      }
    } catch {
      compensation = null
    }
  }
  const finishClock = options.clock ?? (options.now === undefined ? () => new Date() : () => now)
  const committed = commitClaim(claim, result, finishClock, compensation)
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
  const controlPollMs = validInterval(options.controlPollMs ?? Math.min(intervalMs, 250))
  const clock = options.clock ?? (() => new Date())
  const state = {
    generation: ++workerGeneration,
    handle: undefined as unknown as FabricWorkerHandle,
    timer: undefined as unknown as ReturnType<typeof setInterval>,
    controlTimer: undefined as unknown as ReturnType<typeof setInterval>,
    inFlight: null as Promise<void> | null,
    interruptInFlight: null as Promise<void> | null,
    stopping: null as Promise<void> | null,
  }
  const handle: FabricWorkerHandle = { workerId, stop: () => stopManagedWorker(state) }
  state.handle = handle
  state.timer = setInterval(() => {
    if (running !== state || state.stopping || state.inFlight) return
    const cycle = processActionFabricOnce({ workerId, clock })
      .then(() => undefined)
      .catch(error => logger.error({ workerId, errorClass: stableErrorClass(error) }, '[action-fabric] worker cycle failed'))
      .finally(() => { if (state.inFlight === cycle) state.inFlight = null })
    state.inFlight = cycle
  }, intervalMs)
  state.timer.unref?.()
  state.controlTimer = setInterval(() => {
    if (running !== state || state.stopping || !state.inFlight || state.interruptInFlight) return
    if (getFabricControlState().level < 2) return
    const interrupt = processActionFabricCycle({ workerId: `${workerId}:interrupt`, clock }, true)
      .then(() => undefined)
      .catch(error => logger.error({ workerId, errorClass: stableErrorClass(error) },
        '[action-fabric] emergency interrupt cycle failed'))
      .finally(() => { if (state.interruptInFlight === interrupt) state.interruptInFlight = null })
    state.interruptInFlight = interrupt
  }, controlPollMs)
  state.controlTimer.unref?.()
  running = state
  return handle
}

export async function stopActionFabricWorker(): Promise<void> {
  const state = running
  if (!state) return
  await stopManagedWorker(state)
}

function stopManagedWorker(state: ManagedWorkerState): Promise<void> {
  if (running !== state) return state.stopping ?? Promise.resolve()
  if (state.stopping) return state.stopping
  clearInterval(state.timer)
  clearInterval(state.controlTimer)
  const inFlight = state.inFlight
  const interruptInFlight = state.interruptInFlight
  state.stopping = (async () => {
    if (inFlight) await inFlight
    if (interruptInFlight) await interruptInFlight
    if (running === state) running = null
  })()
  return state.stopping
}

function claimNextWorkflow(workerId: string, now: Date, emergencyOnly = false): WorkflowClaim | null {
  return withFabricAuditedTransaction(db => {
    const nowIso = now.toISOString()
    const control = getFabricControlStateInDb(db)
    if (emergencyOnly && control.level < 2) return null
    if (!emergencyOnly) reconcileCompensationParent(db, nowIso)
    let transitionedRetryId: string | undefined
    const retry = !emergencyOnly && control.level < 2 ? selectRetryCandidate(db, nowIso) : undefined
    if (retry) {
      let contract: FabricJsonObject
      try {
        contract = parseObjectProperty(parseObject(retry.input_json), 'contract')
      } catch (error) {
        return moveInvalidContractToWaitingUser(db, retry, nowIso, stableErrorClass(error))
      }
      if (!['required', 'supported', 'none'].includes(String(contract.idempotency))
        || typeof contract.verificationStrategy !== 'string' || !contract.verificationStrategy
        || contract.capabilityVersion !== retry.capability_version) {
        return moveInvalidContractToWaitingUser(db, retry, nowIso, 'FABRIC_WORKER_CONTRACT_MISSING')
      }
      const failed = db.prepare(`SELECT ordinal,kind FROM fabric_steps WHERE workflow_id=? AND state='failed'
        ORDER BY ordinal LIMIT 1`).get(retry.workflow_id) as { ordinal: number; kind: string } | undefined
      if (!failed || !['prepare', 'execute', 'verify'].includes(failed.kind)) {
        return moveInvalidContractToWaitingUser(db, retry, nowIso, 'FABRIC_RETRY_PHASE_UNAVAILABLE')
      }
      const verifyOnly = failed.kind === 'verify'
        || (failed.kind === 'execute' && contract.idempotency === 'none' && contract.verificationStrategy !== 'none')
      if (failed.kind === 'execute' && contract.idempotency === 'none' && contract.verificationStrategy === 'none') {
        return moveInvalidContractToWaitingUser(db, retry, nowIso, 'FABRIC_EXECUTION_RETRY_UNSAFE')
      }
      const destination = failed.kind === 'prepare' ? 'preparing' : verifyOnly ? 'verifying' : 'executing'
      const changed = db.prepare(`UPDATE fabric_workflows SET state=?,version=version+1,
        retry_at=NULL,updated_at=? WHERE id=? AND version=? AND state='retrying'
        AND (retry_at IS NULL OR retry_at<=?)
        AND (lease_expires_at IS NULL OR lease_expires_at<=?)`).run(
        destination, nowIso, retry.workflow_id, retry.workflow_version, nowIso, nowIso,
      )
      if (changed.changes !== 1) return null
      db.prepare(`UPDATE fabric_steps SET state='pending',output_json=NULL,evidence_json='[]',
        last_error_code=NULL,started_at=NULL,completed_at=NULL,updated_at=?
        WHERE workflow_id=? AND ordinal>=? AND state<>'cancelled'`).run(
        nowIso, retry.workflow_id, verifyOnly ? 2 : failed.ordinal,
      )
      auditTransition(db, retry, 'retrying', destination, 'retry_due', nowIso)
      transitionedRetryId = retry.workflow_id
    }
    const row = selectCandidate(db, nowIso, control.level, transitionedRetryId)
    if (!row || !isFabricWorkflowWorkerState(row.workflow_state)) return null
    const interrupt = control.level >= 2 && isInterruptible(row)
    const phase = interrupt ? 'interrupt' : phaseFor(row)
    if (control.level >= 2 && !interrupt) return null
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString()
    let claim: WorkflowClaim
    try {
      claim = buildClaim(db, row, workerId, row.workflow_version + 1, leaseExpiresAt, phase)
    } catch (error) {
      return moveInvalidContractToWaitingUser(db, row, nowIso, stableErrorClass(error))
    }
    // Emergency interruption is authorized by the current control state, not by
    // the now-stale policy snapshot that originally authorized the side effect.
    if (phase === 'interrupt') claim.controlVersion = control.version
    if (claim.controlVersion !== control.version) {
      return moveControlChangedToWaitingUser(db, row, nowIso, control.version)
    }
    const recovered = row.lease_owner !== null && row.lease_expires_at !== null && row.lease_expires_at <= nowIso
    if (recovered && phase === 'execute' && row.step_state === 'running' && claim.idempotency === 'none') {
      return recoverNonIdempotentExecution(db, row, claim, nowIso)
    }
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
    return claim
  })
}

function selectRetryCandidate(db: DatabaseSync, now: string): CandidateRow | undefined {
  return db.prepare(`${candidateSelect()} WHERE w.state='retrying' AND (w.retry_at IS NULL OR w.retry_at<=?)
    AND (w.lease_expires_at IS NULL OR w.lease_expires_at<=?) ORDER BY w.retry_at,w.created_at LIMIT 1`)
    .get(now, now) as CandidateRow | undefined
}

function selectCandidate(
  db: DatabaseSync,
  now: string,
  controlLevel: number,
  excludeWorkflowId?: string,
): CandidateRow | undefined {
  const states = controlLevel >= 2 ? "'preparing','executing','verifying'" : "'preparing','executing','verifying'"
  const availability = controlLevel >= 2
    ? "AND s.state IN ('pending','running') AND (e.type='simulator' OR json_extract(e.configuration_json,'$.interruptible')=1)"
    : "AND (s.state='pending' OR (s.state='running' AND w.lease_owner IS NOT NULL)) AND (w.lease_expires_at IS NULL OR w.lease_expires_at<=?)"
  const parameters = controlLevel >= 2 ? [] : [now]
  const exclusion = excludeWorkflowId === undefined ? '' : 'AND w.id<>?'
  if (excludeWorkflowId !== undefined) parameters.push(excludeWorkflowId)
  return db.prepare(`${candidateSelect()} WHERE w.state IN (${states})
    AND s.ordinal=CASE w.state WHEN 'preparing' THEN 0 WHEN 'executing' THEN 1 ELSE 2 END
    ${availability} ${exclusion} ORDER BY w.created_at,w.id LIMIT 1`).get(...parameters) as CandidateRow | undefined
}

function recoverNonIdempotentExecution(
  db: DatabaseSync,
  row: CandidateRow,
  claim: WorkflowClaim,
  now: string,
): null {
  const canVerify = claim.verificationStrategy !== 'none'
  const destination: FabricWorkflowState = canVerify ? 'verifying' : 'waiting_user'
  const errorCode = canVerify ? 'FABRIC_EXECUTION_RECOVERY_VERIFY_ONLY' : 'FABRIC_EXECUTION_RECOVERY_MANUAL_REQUIRED'
  const changed = db.prepare(`UPDATE fabric_workflows SET state=?,version=version+1,lease_owner=NULL,
    lease_expires_at=NULL,last_error_code=?,updated_at=? WHERE id=? AND version=? AND state='executing'
    AND lease_expires_at<=?`).run(destination, errorCode, now, row.workflow_id, row.workflow_version, now)
  if (changed.changes !== 1) return null
  db.prepare(`UPDATE fabric_steps SET state='failed',last_error_code=?,updated_at=?,completed_at=?
    WHERE workflow_id=? AND kind='execute' AND state='running'`).run(errorCode, now, now, row.workflow_id)
  db.prepare(`UPDATE fabric_steps SET state=?,last_error_code=NULL,updated_at=?
    WHERE workflow_id=? AND kind='verify' AND state IN ('pending','waiting_user')`).run(
    canVerify ? 'pending' : 'waiting_user', now, row.workflow_id,
  )
  auditTransition(db, row, 'executing', destination, 'non_idempotent_recovery', now)
  return null
}

function candidateSelect(): string {
  return `SELECT w.id workflow_id,w.version workflow_version,w.state workflow_state,w.lease_owner,w.lease_expires_at,
    i.id intent_id,i.requested_by_user_id,i.requested_by_role_id,i.capability_id,i.capability_version,
    e.id executor_id,e.type executor_type,e.environment executor_environment,e.configuration_json executor_configuration_json,
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
  const executeToken = selectStepToken(db, row.workflow_id, 1)
  const snapshot = parseObject(row.policy_snapshot_json)
  const token = snapshot.registryPolicyEvaluationToken
  if (typeof token !== 'string') throw new Error('FABRIC_WORKER_POLICY_TOKEN_MISSING')
  const controlVersion = snapshot.controlVersion
  const capturedEnvironments = Array.isArray(snapshot.environments) ? snapshot.environments : []
  const capturedEnvironment = typeof snapshot.resolvedEnvironment === 'string' ? snapshot.resolvedEnvironment
    : capturedEnvironments.length === 1 && typeof capturedEnvironments[0] === 'string'
      ? capturedEnvironments[0] : row.executor_environment
  if (!Number.isSafeInteger(controlVersion) || (controlVersion as number) < 0) {
    throw new Error('FABRIC_WORKER_CONTROL_VERSION_MISSING')
  }
  if (contract.capabilityVersion !== row.capability_version
    || typeof contract.contractDigest !== 'string' || typeof contract.reversible !== 'boolean'
    || !(typeof contract.compensationCapabilityId === 'string' || contract.compensationCapabilityId === null)
    || !['required', 'supported', 'none'].includes(String(contract.idempotency))
    || typeof contract.verificationStrategy !== 'string' || !contract.verificationStrategy) {
    throw new Error('FABRIC_WORKER_CONTRACT_MISSING')
  }
  return {
    workerId, workflowId: row.workflow_id, workflowVersion, intentId: row.intent_id,
    stepId: row.step_id, stepOrdinal: row.step_ordinal, stepAttempt: row.step_attempt + 1,
    executionToken: row.execution_token, executeToken, phase, executorId: row.executor_id, executorType: row.executor_type,
    capabilityId: row.capability_id, capabilityVersion: row.capability_version,
    contractDigest: contract.contractDigest, policyEvaluationToken: token, controlVersion: controlVersion as number,
    input, target, ...(prepared ? { preparedOutput: prepared } : {}),
    ...(executed ? { executionOutput: executed } : {}), leaseExpiresAt,
    actorUserId: row.requested_by_user_id, requestedByRoleId: row.requested_by_role_id,
    reversible: contract.reversible, compensationCapabilityId: contract.compensationCapabilityId,
    idempotency: contract.idempotency as WorkflowClaim['idempotency'],
    verificationStrategy: contract.verificationStrategy, interruptible: isInterruptible(row),
    executorEnvironment: capturedEnvironment,
    shadow: capturedEnvironment === 'sandbox' || row.executor_id === 'health-shadow'
      || executorConfiguration(row).shadow === true,
  }
}

function executorConfiguration(row: CandidateRow): FabricJsonObject {
  return parseObject(row.executor_configuration_json)
}

function commitClaim(
  claim: WorkflowClaim,
  result: FabricExecutorResult,
  finishClock: () => Date,
  preparedCompensation?: PreparedFabricCompensation | null,
): boolean {
  return withFabricAuditedTransaction(db => {
    const now = validDate(finishClock())
    const nowIso = now.toISOString()
    const current = db.prepare('SELECT state,version,lease_owner,lease_expires_at,max_attempts,attempt FROM fabric_workflows WHERE id=?')
      .get(claim.workflowId) as { state: FabricWorkflowState; version: number; lease_owner: string | null;
        lease_expires_at: string | null; max_attempts: number; attempt: number } | undefined
    const step = db.prepare('SELECT state,execution_token,attempt FROM fabric_steps WHERE id=?').get(claim.stepId) as
      { state: string; execution_token: string; attempt: number } | undefined
    if (!current || !step || current.version !== claim.workflowVersion || current.lease_owner !== claim.workerId
      || current.lease_expires_at !== claim.leaseExpiresAt || step.execution_token !== claim.executionToken
      || current.lease_expires_at <= nowIso
      || (!isStateForPhase(current.state, claim.phase)) || (claim.phase !== 'interrupt' && step.state !== 'running')) return false
    const control = getFabricControlStateInDb(db)
    if (control.version !== claim.controlVersion && !(claim.phase !== 'interrupt'
      && claim.interruptible && control.level >= 2)) {
      return checkpointControlChangedResult(db, claim, result, current, step, control.version, nowIso)
    }
    const emergencyUncertain = claim.phase !== 'interrupt' && claim.interruptible && control.level >= 2
    let transition = emergencyUncertain
      ? compensationWaiting('FABRIC_EMERGENCY_STOP_RESULT_UNCERTAIN', current.attempt)
      : outcomeTransition(claim, result, current, now)
    let compensationIntentId: string | null = null
    let compensationWorkflowId: string | null = null
    let compensationOutcome: string | null = null
    if (!emergencyUncertain && claim.phase === 'verify' && result.outcome === 'mismatch' && claim.reversible
      && claim.verificationStrategy !== 'none') {
      if (!preparedCompensation) {
        transition = compensationWaiting('FABRIC_COMPENSATION_POLICY_UNAVAILABLE', current.attempt)
      } else {
        const child = createFabricCompensationChildInDb(db, preparedCompensation)
        compensationIntentId = child.intent.id
        compensationWorkflowId = child.workflow.id
        compensationOutcome = child.policyDecision.outcome
        transition = child.policyDecision.outcome === 'allow'
          ? { state: 'compensating', stepState: 'failed', attempt: current.attempt, retryAt: null,
            errorCode: result.errorCode ?? 'FABRIC_VERIFICATION_MISMATCH', completedAt: null }
          : child.policyDecision.outcome === 'waiting_user'
            ? compensationWaiting('FABRIC_COMPENSATION_APPROVAL_REQUIRED', current.attempt)
            : { state: 'failed', stepState: 'failed', attempt: current.attempt, retryAt: null,
              errorCode: 'FABRIC_COMPENSATION_DENIED', completedAt: null }
      }
    }
    if (claim.phase !== 'interrupt') {
      db.prepare(`UPDATE fabric_steps SET state=?,output_json=?,evidence_json=?,last_error_code=?,
        updated_at=?,completed_at=? WHERE id=? AND state='running' AND execution_token=? AND attempt=?`).run(
        transition.stepState, emergencyUncertain ? null : JSON.stringify(result.output), JSON.stringify(result.evidence),
        emergencyUncertain ? transition.errorCode : result.errorCode,
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
      last_error_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?,completed_at=?,
      compensation_intent_id=COALESCE(compensation_intent_id,?)
      WHERE id=? AND version=? AND lease_owner=? AND lease_expires_at=?`).run(
      transition.state, transition.attempt, transition.retryAt, transition.errorCode, nowIso,
      transition.completedAt, compensationIntentId, claim.workflowId, current.version, claim.workerId, claim.leaseExpiresAt,
    )
    if (changed.changes !== 1) throw new Error('FABRIC_WORKER_COMMIT_CONFLICT')
    updateCircuitBreaker(db, claim, result, nowIso)
    settleBudget(db, claim, transition.state, nowIso)
    appendFabricAuditEvent(db, { eventType: 'workflow.step_checkpointed', actorUserId: claim.workerId,
      aggregateType: 'workflow', aggregateId: claim.workflowId,
      payload: { stepId: claim.stepId, phase: claim.phase, outcome: result.outcome,
        from: current.state, to: transition.state, errorClass: transition.errorCode ?? result.errorCode,
        ...(compensationIntentId ? { compensationIntentId, compensationWorkflowId, compensationOutcome } : {}) },
      occurredAt: nowIso })
    appendFabricOutbox(db, 'fabric.workflow.step_checkpointed', claim.workflowId,
      { stepId: claim.stepId, phase: claim.phase, outcome: result.outcome,
        from: current.state, to: transition.state, errorClass: transition.errorCode ?? result.errorCode,
        ...(compensationIntentId ? { compensationIntentId, compensationWorkflowId, compensationOutcome } : {}) })
    return true
  })
}

function checkpointControlChangedResult(
  db: DatabaseSync,
  claim: WorkflowClaim,
  result: FabricExecutorResult,
  current: { state: FabricWorkflowState; version: number; lease_owner: string | null;
    lease_expires_at: string | null; max_attempts: number; attempt: number },
  step: { state: string; execution_token: string; attempt: number },
  controlVersion: number,
  now: string,
): boolean {
  const errorCode = 'FABRIC_CONTROL_CHANGED_REVIEW_REQUIRED'
  if (claim.phase !== 'interrupt') {
    const changedStep = db.prepare(`UPDATE fabric_steps SET state='waiting_user',output_json=?,evidence_json=?,
      last_error_code=?,updated_at=?,completed_at=NULL WHERE id=? AND state='running'
      AND execution_token=? AND attempt=?`).run(
      JSON.stringify(result.output), JSON.stringify(result.evidence), errorCode, now,
      claim.stepId, claim.executionToken, step.attempt,
    )
    if (changedStep.changes !== 1) return false
  } else {
    db.prepare(`UPDATE fabric_steps SET state='waiting_user',last_error_code=?,updated_at=?
      WHERE workflow_id=? AND state IN ('pending','running')`).run(errorCode, now, claim.workflowId)
  }
  const changed = db.prepare(`UPDATE fabric_workflows SET state='waiting_user',version=version+1,
    retry_at=NULL,last_error_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
    WHERE id=? AND version=? AND lease_owner=? AND lease_expires_at=?`).run(
    errorCode, now, claim.workflowId, current.version, claim.workerId, claim.leaseExpiresAt,
  )
  if (changed.changes !== 1) throw new Error('FABRIC_WORKER_COMMIT_CONFLICT')
  appendFabricAuditEvent(db, { eventType: 'workflow.control_checkpoint_required', actorUserId: claim.workerId,
    aggregateType: 'workflow', aggregateId: claim.workflowId,
    payload: { stepId: claim.stepId, phase: claim.phase, outcome: result.outcome,
      from: current.state, to: 'waiting_user', policyControlVersion: claim.controlVersion, controlVersion },
    occurredAt: now })
  appendFabricOutbox(db, 'fabric.workflow.control_checkpoint_required', claim.workflowId,
    { stepId: claim.stepId, phase: claim.phase, outcome: result.outcome,
      from: current.state, to: 'waiting_user', policyControlVersion: claim.controlVersion, controlVersion })
  return true
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
    if (result.outcome === 'unknown') return waiting('FABRIC_EXECUTION_OUTCOME_UNKNOWN', current.attempt)
    if (result.outcome === 'temporary_failure' && result.safeToRetry) {
      if (claim.idempotency === 'none') return waiting('FABRIC_EXECUTION_RETRY_UNSAFE', current.attempt)
      return retryOrDeadLetter(current, result.errorCode ?? 'FABRIC_EXECUTION_TEMPORARY', now)
    }
    return terminal('dead_letter', current.max_attempts, result.errorCode ?? 'FABRIC_EXECUTION_FAILED', now)
  }
  if (claim.phase === 'verify') {
    if (result.outcome === 'verified') return terminal('succeeded', current.attempt, null, now, 'succeeded')
    if (result.outcome === 'unknown') return waiting('FABRIC_VERIFICATION_OUTCOME_UNKNOWN', current.attempt)
    if (result.outcome === 'mismatch') {
      if (claim.verificationStrategy === 'none') {
        return waiting('FABRIC_VERIFICATION_CONTRACT_MISMATCH', current.attempt)
      }
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

function compensationWaiting(errorCode: string, attempt: number) {
  return { state: 'waiting_user' as const, stepState: 'failed', attempt,
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
  const status = state === 'succeeded' ? 'committed' : 'released'
  settleWorkflowBudgetInDb(db, claim.workflowId, claim.actorUserId, status, now)
}

function settleWorkflowBudgetInDb(
  db: DatabaseSync,
  workflowId: string,
  actorUserId: string,
  status: 'committed' | 'released',
  now: string,
): boolean {
  const ledger = db.prepare(`SELECT id,currency,amount_minor FROM fabric_budget_ledger
    WHERE workflow_id=? AND status='reserved' ORDER BY created_at LIMIT 1`).get(workflowId) as
    { id: string; currency: string; amount_minor: number } | undefined
  if (!ledger) return false
  const changed = db.prepare(`UPDATE fabric_budget_ledger SET status=?,updated_at=?
    WHERE id=? AND workflow_id=? AND status='reserved'`).run(status, now, ledger.id, workflowId)
  if (changed.changes !== 1) return false
  const payload = { currency: ledger.currency, amountMinor: ledger.amount_minor }
  appendFabricAuditEvent(db, { eventType: `budget.${status}`, actorUserId,
    aggregateType: 'workflow', aggregateId: workflowId, payload, occurredAt: now })
  appendFabricOutbox(db, `fabric.budget.${status}`, workflowId, payload)
  return true
}

function moveNonInterruptibleToWaitingUser(db: DatabaseSync, row: CandidateRow, now: string): null {
  const changed = db.prepare(`UPDATE fabric_workflows SET state='waiting_user',version=version+1,
    lease_owner=NULL,lease_expires_at=NULL,last_error_code='FABRIC_EMERGENCY_STOP_REVIEW_REQUIRED',updated_at=?
    WHERE id=? AND version=?`).run(now, row.workflow_id, row.workflow_version)
  if (changed.changes === 1) auditTransition(db, row, row.workflow_state, 'waiting_user', 'emergency_stop', now)
  return null
}

function moveInvalidContractToWaitingUser(db: DatabaseSync, row: CandidateRow, now: string, errorCode: string): null {
  const changed = db.prepare(`UPDATE fabric_workflows SET state='waiting_user',version=version+1,
    lease_owner=NULL,lease_expires_at=NULL,last_error_code=?,updated_at=? WHERE id=? AND version=?`).run(
    errorCode, now, row.workflow_id, row.workflow_version,
  )
  if (changed.changes === 1) {
    db.prepare(`UPDATE fabric_steps SET state='waiting_user',last_error_code=?,updated_at=?
      WHERE workflow_id=? AND state IN ('pending','running')`).run(errorCode, now, row.workflow_id)
    auditTransition(db, row, row.workflow_state, 'waiting_user', 'captured_contract_invalid', now)
  }
  return null
}

function moveControlChangedToWaitingUser(
  db: DatabaseSync,
  row: CandidateRow,
  now: string,
  controlVersion: number,
): null {
  const errorCode = 'FABRIC_CONTROL_CHANGED_REVIEW_REQUIRED'
  const changed = db.prepare(`UPDATE fabric_workflows SET state='waiting_user',version=version+1,
    lease_owner=NULL,lease_expires_at=NULL,retry_at=NULL,last_error_code=?,updated_at=?
    WHERE id=? AND version=?`).run(errorCode, now, row.workflow_id, row.workflow_version)
  if (changed.changes === 1) {
    db.prepare(`UPDATE fabric_steps SET state='waiting_user',last_error_code=?,updated_at=?
      WHERE workflow_id=? AND state IN ('pending','running')`).run(errorCode, now, row.workflow_id)
    appendFabricAuditEvent(db, { eventType: 'workflow.control_checkpoint_required',
      actorUserId: row.requested_by_user_id, aggregateType: 'workflow', aggregateId: row.workflow_id,
      payload: { from: row.workflow_state, to: 'waiting_user', controlVersion }, occurredAt: now })
    appendFabricOutbox(db, 'fabric.workflow.control_checkpoint_required', row.workflow_id,
      { from: row.workflow_state, to: 'waiting_user', controlVersion })
  }
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

function reconcileCompensationParent(db: DatabaseSync, now: string): boolean {
  const rows = db.prepare(`SELECT p.id parent_id,p.state parent_state,p.version parent_version,
      c.id child_id,c.state child_state,i.requested_by_user_id actor_user_id,b.id budget_id
    FROM fabric_workflows p
    JOIN fabric_action_intents ci ON ci.id=p.compensation_intent_id
    JOIN fabric_workflows c ON c.intent_id=ci.id
    JOIN fabric_action_intents i ON i.id=p.intent_id
    LEFT JOIN fabric_budget_ledger b ON b.workflow_id=p.id AND b.status='reserved'
    WHERE p.state IN ('compensating','waiting_user','failed','compensated')
      AND (NOT ((c.state IN ('succeeded','compensated') AND p.state='compensated')
        OR (c.state IN ('denied','cancelled','dead_letter','failed') AND p.state='failed')
        OR (c.state='waiting_user' AND p.state='waiting_user')
        OR (c.state NOT IN ('succeeded','compensated','denied','cancelled','dead_letter','failed','waiting_user')
          AND p.state='compensating'))
        OR (b.id IS NOT NULL AND c.state IN ('succeeded','compensated','denied','cancelled','dead_letter','failed')))
    ORDER BY p.updated_at,p.id LIMIT 1`).all() as unknown as Array<{
      parent_id: string; parent_state: FabricWorkflowState; parent_version: number
      child_id: string; child_state: FabricWorkflowState; actor_user_id: string; budget_id: string | null
    }>
  const selected = rows.map(row => ({ row, destination: compensationParentDestination(row.child_state) }))
    .find(item => item.destination !== item.row.parent_state || item.row.budget_id !== null)
  if (!selected) return false
  const { row, destination } = selected
  let stateChanged = false
  if (destination !== row.parent_state) {
    const changed = db.prepare(`UPDATE fabric_workflows SET state=?,version=version+1,updated_at=?,completed_at=?
      WHERE id=? AND version=? AND state=?`).run(
      destination, now, destination === 'compensated' ? now : null,
      row.parent_id, row.parent_version, row.parent_state,
    )
    if (changed.changes !== 1) return false
    stateChanged = true
    appendFabricAuditEvent(db, { eventType: 'workflow.compensation_reconciled', actorUserId: row.actor_user_id,
      aggregateType: 'workflow', aggregateId: row.parent_id,
      payload: { childWorkflowId: row.child_id, childState: row.child_state,
        from: row.parent_state, to: destination }, occurredAt: now })
    appendFabricOutbox(db, 'fabric.workflow.compensation_reconciled', row.parent_id,
      { childWorkflowId: row.child_id, childState: row.child_state, from: row.parent_state, to: destination })
  }
  const budgetSettled = destination === 'compensated'
    ? settleWorkflowBudgetInDb(db, row.parent_id, row.actor_user_id, 'released', now)
    : destination === 'failed'
      ? settleWorkflowBudgetInDb(db, row.parent_id, row.actor_user_id, 'committed', now)
      : false
  return stateChanged || budgetSettled
}

function compensationParentDestination(childState: FabricWorkflowState): FabricWorkflowState {
  if (childState === 'succeeded' || childState === 'compensated') return 'compensated'
  if (['denied', 'cancelled', 'dead_letter', 'failed'].includes(childState)) return 'failed'
  return childState === 'waiting_user' ? 'waiting_user' : 'compensating'
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

function selectStepToken(db: DatabaseSync, workflowId: string, ordinal: number): string {
  const row = db.prepare('SELECT execution_token FROM fabric_steps WHERE workflow_id=? AND ordinal=?')
    .get(workflowId, ordinal) as { execution_token: string } | undefined
  if (!row) throw new Error('FABRIC_WORKER_STEP_TOKEN_MISSING')
  return row.execution_token
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

import { createHash, randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  getAssistantRole,
  migrateAssistantRoleCapabilityEnforcement,
} from '../personal-twin'
import type { AssistantRole, AssistantRoleRisk } from '../personal-twin'
import {
  appendFabricAuditEvent,
  appendFabricOutbox,
  assertFabricAuditedTransaction,
  withFabricAuditedTransaction,
} from './audit'
import { getFabricControlStateInDb } from './control'
import { resolveFabricAuthorization, type FabricAuthorizationEvidence } from './authorization'
import { verifyTrustedPlanRestoreInDb } from './compensation-internal'
import {
  effectiveCapabilityRisk,
  healthStandingAuthorizationRequirements,
  healthTargetAtoms,
  isHealthCapability,
  validateFabricSchema,
  validateHealthSemantics,
} from './contracts'
import { ensureBuiltInFabricRegistry, resolveFabricExecutorInDb } from './registry'
import type {
  FabricBudgetReservation,
  FabricEnvironment,
  FabricMoney,
  FabricPolicyDecision,
  FabricPolicyInput,
  FabricPolicyEvaluationOptions,
  ResolvedFabricExecutor,
} from './types'

const POLICY_VERSION = 1
const RISK_ORDER: Record<AssistantRoleRisk, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }
type ReasonCode =
  | 'role_missing' | 'role_disabled' | 'capability_not_allowed' | 'capability_denied'
  | 'executor_unavailable' | 'target_not_allowed' | 'risk_requires_approval'
  | 'per_action_limit_exceeded' | 'daily_limit_exceeded' | 'currency_mismatch'
  | 'emergency_stop' | 'material_input_changed'
  | 'role_policy_invalid' | 'irreversible_requires_approval'
  | 'authorization_expired' | 'standing_authorization_required'

interface DecisionRow {
  id: string; intent_id: string; executor_id: string | null; outcome: 'allow' | 'deny' | 'waiting_user'
  reason_codes_json: string; policy_version: number; material_input_digest: string
  policy_snapshot_json: string; sanitized_summary_json: string; budget_currency: string | null
  budget_amount_minor: number | null; created_at: string
}

interface LedgerRow {
  id: string; decision_id: string; workflow_id: string | null; requested_by_user_id: string
  requested_by_role_id: string; ledger_date: string; currency: string; amount_minor: number
  status: 'reserved' | 'committed' | 'released'; created_at: string; updated_at: string
}

export function evaluateFabricPolicy(input: FabricPolicyInput, options: FabricPolicyEvaluationOptions = {}): FabricPolicyDecision {
  prepareFabricPolicyEvaluation(input)
  return withFabricAuditedTransaction(db => evaluateFabricPolicyInDb(db, input, options))
}

export function prepareFabricPolicyEvaluation(input: FabricPolicyInput): void {
  validateInput(input)
  ensureBuiltInFabricRegistry()
  migrateAssistantRoleCapabilityEnforcement()
}

/** Must only be called from an existing `withFabricAuditedTransaction` callback. */
export function evaluateFabricPolicyInDb(
  db: DatabaseSync,
  input: FabricPolicyInput,
  options: FabricPolicyEvaluationOptions = {},
): FabricPolicyDecision {
  assertFabricAuditedTransaction(db)
  validateInput(input)
  const instant = evaluationInstant(options)
  const now = instant.toISOString()
  const ledgerDate = utcDate(instant)
  const environments = input.environments ?? (isHealthCapability(input.capabilityId) ? ['sandbox'] : ['simulator', 'internal'])
  const resolution = resolveFabricExecutorInDb(db, input.capabilityId, { environments })
  if (resolution && (!validateFabricSchema(input.input, resolution.capability.inputSchema)
    || !validateHealthSemantics(input.capabilityId, input.input))) {
    throw new Error('FABRIC_CAPABILITY_INPUT_INVALID')
  }
  const effectiveRisk = resolution ? effectiveCapabilityRisk(resolution.capability, input.input) : null
  const targetAtoms = resolution && isHealthCapability(input.capabilityId)
    ? healthTargetAtoms(input.capabilityId, input.target, input.input) : null
  const authorizationRequirements = resolution && isHealthCapability(input.capabilityId)
    ? healthStandingAuthorizationRequirements(resolution.capability) : null
  const standingAuthorizationRequired = !!resolution && isHealthCapability(input.capabilityId)
    && resolution.executor.environment === 'production' && resolution.capability.authentication.length > 0
  const sandboxStanding = !!resolution && !!authorizationRequirements && resolution.executor.id === 'health-shadow'
    && resolution.executor.environment === 'sandbox' && resolution.executor.configuration.shadow === true
    && resolution.executor.configuration.externalWrite === false
  const authorizationEvidence = resolution && standingAuthorizationRequired && authorizationRequirements && targetAtoms
    ? resolveFabricAuthorization({
      capabilityId: input.capabilityId, requestedByUserId: input.requestedByUserId, targetAtoms,
      executorId: resolution.executor.id, environment: resolution.executor.environment,
      input: input.input, requirements: authorizationRequirements,
    }, now) : null
  const standingAuthorization = sandboxStanding || authorizationEvidence !== null
  const trustedPlanRestore = input.capabilityId === 'health.plan.restore'
    && verifyTrustedPlanRestoreInDb(db, input)
  const role = getAssistantRole(input.requestedByRoleId)
  const risk = resolution ? RISK_ORDER[effectiveRisk ?? resolution.capability.risk] : null
  const authorizationMode = trustedPlanRestore ? 'trusted_compensation'
    : sandboxStanding ? 'standing_sandbox' : authorizationEvidence ? 'standing_provider'
      : standingAuthorizationRequired ? 'standing_required' : 'per_action'
  const standingAuthorizationMode = authorizationMode === 'per_action' ? 'not_required' : authorizationMode
  const approvalMode = !trustedPlanRestore && resolution && risk !== null
    && ((isHealthCapability(resolution.capability.id) && risk >= RISK_ORDER.medium)
      || (role?.decisionAuthority.requireApprovalAbove !== undefined
        && risk > RISK_ORDER[role.decisionAuthority.requireApprovalAbove])) ? 'per_action' : 'none'
  const materialInputDigest = digest({
    capabilityId: input.capabilityId, target: input.target, input: input.input,
    constraints: input.constraints, expectedCost: input.expectedCost ?? null,
    environments, capabilityRisk: resolution?.capability.risk ?? null, effectiveRisk, authorizationMode,
    authorizationEvidence,
  })
  const sanitizedSummary = summarize(input)

    const control = getFabricControlStateInDb(db)
    const effective = effectiveCost(resolution, input.expectedCost)
    const snapshot = {
      ...(role === null ? {} : { roleUpdatedAt: role.updatedAt, roleDigest: digest(rolePolicyMaterial(role)) }),
      ...(resolution === null ? {} : { registryPolicyRevision: resolution.policyRevision,
        registryPolicyEvaluationToken: resolution.policyEvaluationToken }),
      controlVersion: control.version, controlLevel: control.level, phase: input.phase ?? 'intent',
      environments: [...environments], ledgerDate, effectiveCost: effective.money,
      resolvedEnvironment: resolution?.executor.environment ?? null,
      capabilityRisk: resolution?.capability.risk ?? null, effectiveRisk, targetAtoms, authorizationMode,
      standingAuthorizationMode, authorizationEvidence, standingAuthorizationRequired, approvalMode,
    }
    const existing = db.prepare(`SELECT id, material_input_digest FROM fabric_action_intents
      WHERE requested_by_user_id=? AND requested_by_role_id=? AND idempotency_key=?`).get(
      input.requestedByUserId, input.requestedByRoleId, input.idempotencyKey,
    ) as { id: string; material_input_digest: string } | undefined
    const intentId = existing?.id ?? `intent-${randomUUID()}`
    const previous = existing ? latestDecisionForIntent(db, intentId) : undefined
    const poison = existing ? materialConflictForIntent(db, intentId) : undefined
    if (poison) return parseDecision(poison)
    if (existing?.material_input_digest !== undefined && existing.material_input_digest !== materialInputDigest) {
      const invalidated = db.prepare(`UPDATE fabric_budget_ledger SET status='released',updated_at=?
        WHERE status='reserved' AND workflow_id IS NULL AND decision_id IN (
          SELECT id FROM fabric_policy_decisions WHERE intent_id=? AND outcome='allow'
        )`).run(now, intentId).changes
      if (invalidated > 0) {
        appendFabricAuditEvent(db, { eventType: 'budget.authorization.invalidated',
          actorUserId: input.requestedByUserId, aggregateType: 'intent', aggregateId: intentId,
          payload: { releasedReservations: invalidated, reason: 'material_input_changed' }, occurredAt: now })
        appendFabricOutbox(db, 'fabric.budget.authorization.invalidated', intentId,
          { releasedReservations: invalidated, reason: 'material_input_changed' })
      }
      return persistDenyDecision(db, { intentId, executorId: resolution?.executor.id ?? null,
        reason: 'material_input_changed', materialInputDigest, snapshot, sanitizedSummary,
        actorUserId: input.requestedByUserId, now })
    }
    if (previous && sameSnapshot(previous, snapshot)) {
      if (previous.outcome === 'allow' && (previous.budget_amount_minor ?? 0) > 0) {
        const ledger = selectLedgerByDecision(db, previous.id)
        if (!ledger || ledger.status === 'released') {
          return persistDenyDecision(db, { intentId, executorId: previous.executor_id,
            reason: 'authorization_expired', materialInputDigest, snapshot, sanitizedSummary,
            actorUserId: input.requestedByUserId, now })
        }
      }
      return parseDecision(previous)
    }
    if (previous) {
      db.prepare(`UPDATE fabric_budget_ledger SET status='released', updated_at=? WHERE status='reserved'
        AND decision_id IN (SELECT id FROM fabric_policy_decisions WHERE intent_id=?)`).run(now, intentId)
    }

    const reasons: ReasonCode[] = []
    let outcome: FabricPolicyDecision['outcome'] = 'allow'
    let budget: FabricMoney | null = null
    if (!role) reasons.push('role_missing')
    else if (!validRuntimeRolePolicy(role)) reasons.push('role_policy_invalid')
    else if (!role.enabled) reasons.push('role_disabled')
    else if (role.capabilityScope.deny.includes(input.capabilityId)) reasons.push('capability_denied')
    else if (!role.capabilityScope.allow.includes(input.capabilityId)) reasons.push('capability_not_allowed')
    else if (!resolution) reasons.push('executor_unavailable')
    else if (emergencyBlocks(control.level, input.phase ?? 'intent')) reasons.push('emergency_stop')
    else if (input.expectedMaterialInputDigest !== undefined && input.expectedMaterialInputDigest !== materialInputDigest) {
      reasons.push('material_input_changed')
    } else if (!targetAllowed(role, resolution, input.target, input.input, input.requestedByUserId)) reasons.push('target_not_allowed')
    else if (standingAuthorizationRequired && authorizationEvidence === null) {
      reasons.push('standing_authorization_required')
      outcome = 'deny'
    }
    else if (effective.currencyMismatch) reasons.push('currency_mismatch')
    else {
      const resolvedRisk = RISK_ORDER[effectiveRisk ?? resolution.capability.risk]
      if (resolvedRisk > RISK_ORDER[role.decisionAuthority.maxRisk]) {
        reasons.push('risk_requires_approval')
        outcome = 'deny'
      } else {
        if (!trustedPlanRestore && isHealthCapability(resolution.capability.id)
          && resolvedRisk >= RISK_ORDER.medium) {
          reasons.push('risk_requires_approval')
          outcome = 'waiting_user'
        } else if (!trustedPlanRestore
          && role.decisionAuthority.requireApprovalAbove !== undefined
          && resolvedRisk > RISK_ORDER[role.decisionAuthority.requireApprovalAbove]) {
          reasons.push('risk_requires_approval')
          outcome = 'waiting_user'
        }
        if (resolution.capability.sideEffect && !resolution.capability.reversible
          && !standingAuthorization
          && !trustedPlanRestore) {
          reasons.push('irreversible_requires_approval')
          outcome = 'waiting_user'
        }
      }
      if (outcome !== 'deny' && effective.money) {
        if (role.spendingLimits.currency !== effective.money.currency) reasons.push('currency_mismatch')
        else if (effective.money.amountMinor > role.spendingLimits.perAction) reasons.push('per_action_limit_exceeded')
        if (reasons.includes('currency_mismatch') || reasons.includes('per_action_limit_exceeded')) outcome = 'deny'
        else if (effective.money.amountMinor > 0) budget = effective.money
      }
    }
    if (reasons.length > 0 && outcome === 'allow') outcome = 'deny'

    if (!existing) {
      db.prepare(`INSERT INTO fabric_action_intents(
        id,capability_id,capability_version,requested_by_role_id,requested_by_user_id,idempotency_key,
        goal,target_json,input_json,constraints_json,rationale,expected_cost_currency,expected_cost_minor,
        material_input_digest,sanitized_summary_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        intentId, input.capabilityId, resolution?.capability.version ?? 1, input.requestedByRoleId,
        input.requestedByUserId, input.idempotencyKey, '[redacted]', redactedObject(input.target),
        redactedObject(input.input), redactedObject(input.constraints), '[redacted]', effective.money?.currency ?? null,
        effective.money?.amountMinor ?? null, materialInputDigest, JSON.stringify(sanitizedSummary), now, now,
      )
    }
    const decisionId = `decision-${randomUUID()}`
    if (outcome === 'allow' && budget && wouldExceedDaily(db, role!, input, budget, ledgerDate)) {
      reasons.splice(0, reasons.length, 'daily_limit_exceeded')
      outcome = 'deny'
      budget = null
    }
    db.prepare(`INSERT INTO fabric_policy_decisions(
      id,intent_id,executor_id,outcome,reason_codes_json,policy_version,material_input_digest,
      policy_snapshot_json,sanitized_summary_json,budget_currency,budget_amount_minor,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      decisionId, intentId, resolution?.executor.id ?? null, outcome, JSON.stringify(reasons), POLICY_VERSION,
      materialInputDigest, JSON.stringify(snapshot), JSON.stringify(sanitizedSummary),
      budget?.currency ?? null, budget?.amountMinor ?? null, now,
    )
    if (outcome === 'allow' && budget) insertReservation(db, decisionId, input, budget, ledgerDate, now)
    appendFabricAuditEvent(db, {
      eventType: 'policy.evaluated', actorUserId: input.requestedByUserId, aggregateType: 'intent',
      aggregateId: intentId, payload: { decisionId, outcome, reasonCodes: reasons, sanitizedSummary }, occurredAt: now,
    })
    appendFabricOutbox(db, 'fabric.policy.evaluated', intentId, { decisionId, outcome, reasonCodes: reasons })
  return {
      id: decisionId, intentId, executorId: resolution?.executor.id ?? null, outcome, reasonCodes: [...reasons],
      policyVersion: POLICY_VERSION, materialInputDigest, policySnapshot: snapshot, sanitizedSummary,
      budget, createdAt: now,
  }
}

export function reserveFabricBudget(decisionId: string): FabricBudgetReservation {
  return withFabricAuditedTransaction(db => {
    const decision = requireDecision(db, decisionId)
    if (decision.outcome !== 'allow' || decision.budget_currency === null || decision.budget_amount_minor === null) {
      throw new Error('FABRIC_BUDGET_NOT_RESERVABLE')
    }
    const intent = requireIntentIdentity(db, decision.intent_id)
    revalidateSnapshot(db, decision, intent.requested_by_role_id)
    const existing = selectLedgerByDecision(db, decisionId)
    if (existing) {
      if (existing.status === 'released') throw new Error('FABRIC_BUDGET_ALREADY_RELEASED')
      if (existing.status === 'committed') throw new Error('FABRIC_BUDGET_ALREADY_COMMITTED')
      if (existing.workflow_id !== null) throw new Error('FABRIC_BUDGET_OWNERSHIP_CONFLICT')
      return parseLedger(existing)
    }
    throw new Error('FABRIC_BUDGET_RESERVATION_MISSING')
  })
}

/** Revalidates a persisted decision while the caller holds the shared audited writer transaction. */
export function revalidateFabricDecisionInDb(db: DatabaseSync, decisionId: string): FabricPolicyDecision {
  assertFabricAuditedTransaction(db)
  const decision = requireDecision(db, decisionId)
  const intent = requireIntentIdentity(db, decision.intent_id)
  revalidateSnapshot(db, decision, intent.requested_by_role_id)
  return parseDecision(decision)
}

/** Rechecks only standing authorization immediately before adapter execution. */
export function revalidateFabricAuthorizationInDb(db: DatabaseSync, decisionId: string): void {
  const decision = db.prepare('SELECT * FROM fabric_policy_decisions WHERE id=?').get(decisionId) as DecisionRow | undefined
  if (!decision) throw new Error('FABRIC_POLICY_DECISION_NOT_FOUND')
  const snapshot = JSON.parse(decision.policy_snapshot_json) as Record<string, unknown>
  const standingMode = snapshot.standingAuthorizationMode ?? snapshot.authorizationMode
  const environments = snapshot.environments as FabricEnvironment[]
  const capabilityId = (JSON.parse(decision.sanitized_summary_json) as { capabilityId?: unknown }).capabilityId
  if (typeof capabilityId !== 'string' || !Array.isArray(environments)) {
    throw new Error('FABRIC_POLICY_STALE_AUTHORIZATION')
  }
  const snapshotRequiresStanding = snapshot.standingAuthorizationRequired === true
    || snapshot.authorizationEvidence !== null && snapshot.authorizationEvidence !== undefined
    || standingMode === 'standing_provider' || standingMode === 'standing_sandbox'
  if (!isHealthCapability(capabilityId) && !snapshotRequiresStanding) return
  const resolution = resolveFabricExecutorInDb(db, capabilityId, { environments })
  if (!resolution) throw new Error('FABRIC_POLICY_STALE_AUTHORIZATION')
  const currentlyRequired = isHealthCapability(capabilityId) && resolution.executor.environment === 'production'
    && resolution.capability.authentication.length > 0
  const mustRevalidate = currentlyRequired || snapshotRequiresStanding
  if (!mustRevalidate) return
  if (!['standing_provider', 'standing_sandbox'].includes(String(standingMode))) {
    throw new Error('FABRIC_POLICY_STALE_AUTHORIZATION')
  }
  revalidateAuthorization(db, decision, snapshot, resolution)
}

export function commitFabricBudget(workflowId: string, actual?: FabricMoney): void {
  withFabricAuditedTransaction(db => {
    const context = requireWorkflowLedger(db, workflowId)
    if (context.ledger.status === 'committed') {
      if (actual && (actual.currency !== context.ledger.currency || actual.amountMinor !== context.ledger.amount_minor)) {
        throw new Error('FABRIC_BUDGET_COMMIT_CONFLICT')
      }
      return
    }
    if (context.ledger.status === 'released') throw new Error('FABRIC_BUDGET_ALREADY_RELEASED')
    if (context.ledger.workflow_id !== null && context.ledger.workflow_id !== workflowId) throw new Error('FABRIC_BUDGET_OWNERSHIP_CONFLICT')
    revalidateSnapshot(db, context.decision, context.intent.requested_by_role_id)
    const money = actual ?? { currency: context.ledger.currency, amountMinor: context.ledger.amount_minor }
    validateMoney(money)
    if (money.currency !== context.ledger.currency) throw new Error('FABRIC_BUDGET_CURRENCY_MISMATCH')
    const role = getAssistantRole(context.intent.requested_by_role_id)
    if (!role || money.amountMinor > role.spendingLimits.perAction) throw new Error('FABRIC_BUDGET_LIMIT_EXCEEDED')
    const other = dailyTotal(db, context.ledger.requested_by_user_id, context.ledger.requested_by_role_id,
      context.ledger.ledger_date, money.currency, context.ledger.id)
    if (other + money.amountMinor > role.spendingLimits.daily) throw new Error('FABRIC_BUDGET_LIMIT_EXCEEDED')
    const now = new Date().toISOString()
    db.prepare(`UPDATE fabric_budget_ledger SET workflow_id=?,amount_minor=?,status='committed',updated_at=?
      WHERE id=? AND status='reserved'`).run(workflowId, money.amountMinor, now, context.ledger.id)
    appendFabricAuditEvent(db, { eventType: 'budget.committed', actorUserId: context.intent.requested_by_user_id,
      aggregateType: 'workflow', aggregateId: workflowId, payload: { currency: money.currency, amountMinor: money.amountMinor }, occurredAt: now })
    appendFabricOutbox(db, 'fabric.budget.committed', workflowId, { currency: money.currency, amountMinor: money.amountMinor })
  })
}

export function releaseFabricBudget(workflowId: string): void {
  withFabricAuditedTransaction(db => {
    const context = requireWorkflowLedger(db, workflowId)
    if (context.ledger.status !== 'reserved') return
    if (context.ledger.workflow_id !== null && context.ledger.workflow_id !== workflowId) throw new Error('FABRIC_BUDGET_OWNERSHIP_CONFLICT')
    const now = new Date().toISOString()
    db.prepare(`UPDATE fabric_budget_ledger SET workflow_id=?,status='released',updated_at=?
      WHERE id=? AND status='reserved'`).run(workflowId, now, context.ledger.id)
    appendFabricAuditEvent(db, { eventType: 'budget.released', actorUserId: context.intent.requested_by_user_id,
      aggregateType: 'workflow', aggregateId: workflowId, payload: {}, occurredAt: now })
    appendFabricOutbox(db, 'fabric.budget.released', workflowId, {})
  })
}

function emergencyBlocks(level: number, phase: 'intent' | 'execution'): boolean {
  return phase === 'intent' ? level >= 1 : level >= 2
}

function evaluationInstant(options: FabricPolicyEvaluationOptions): Date {
  const instant = options.clock?.() ?? new Date()
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new Error('FABRIC_POLICY_INVALID_CLOCK')
  return new Date(instant.getTime())
}

function effectiveCost(resolution: ResolvedFabricExecutor | null, expected: FabricMoney | undefined): {
  money: FabricMoney | null
  currencyMismatch: boolean
} {
  if (!resolution) return { money: expected ?? null, currencyMismatch: false }
  const contract = resolution.capability.cost
  if (contract.currency !== null) {
    if (expected && expected.currency !== contract.currency) {
      return { money: { currency: contract.currency, amountMinor: contract.estimatedMinor }, currencyMismatch: true }
    }
    return { money: { currency: contract.currency,
      amountMinor: Math.max(contract.estimatedMinor, expected?.amountMinor ?? 0) }, currencyMismatch: false }
  }
  return { money: expected ?? null, currencyMismatch: false }
}

function validRuntimeRolePolicy(role: AssistantRole): boolean {
  const scope = role.capabilityScope
  if (!scope || scope.enforcement !== 'action_fabric_v1' || !validSemanticList(scope.allow) || !validSemanticList(scope.deny)) return false
  const authority = role.decisionAuthority
  if (!authority || Object.keys(authority).some(key => !['maxRisk', 'requireApprovalAbove', 'allowedTargets'].includes(key))
    || !Object.prototype.hasOwnProperty.call(RISK_ORDER, authority.maxRisk)) return false
  if (authority.requireApprovalAbove !== undefined
    && !Object.prototype.hasOwnProperty.call(RISK_ORDER, authority.requireApprovalAbove)) return false
  if (authority.allowedTargets !== undefined && (!Array.isArray(authority.allowedTargets)
    || authority.allowedTargets.length > 64 || new Set(authority.allowedTargets).size !== authority.allowedTargets.length
    || authority.allowedTargets.some(item => typeof item !== 'string' || !item.trim() || item !== item.trim() || item === '*'))) return false
  const spending = role.spendingLimits
  return !!spending && !Object.keys(spending).some(key => !['currency', 'perAction', 'daily'].includes(key))
    && (spending.currency === null || (typeof spending.currency === 'string' && /^[A-Z]{3}$/.test(spending.currency)))
    && Number.isSafeInteger(spending.perAction) && spending.perAction >= 0
    && Number.isSafeInteger(spending.daily) && spending.daily >= 0
    && (spending.currency !== null || (spending.perAction === 0 && spending.daily === 0))
}

function validSemanticList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && /^[a-z][a-z0-9]*(?:[._:-][a-z0-9][a-z0-9-]*)*$/.test(item))
}

function targetAllowed(
  role: AssistantRole,
  resolution: ResolvedFabricExecutor,
  target: Record<string, unknown>,
  input: Record<string, unknown>,
  requestedByUserId: string,
): boolean {
  if (isHealthCapability(resolution.capability.id)) {
    if (resolution.capability.id === 'health.followup.schedule'
      && (input.ownerUserId !== requestedByUserId || target.ownerUserId !== requestedByUserId)) return false
    const atoms = healthTargetAtoms(resolution.capability.id, target, input)
    if (!atoms || atoms.length === 0) return false
    const roleTargets = role.decisionAuthority.allowedTargets
    return !!roleTargets && atoms.every(atom => roleTargets.includes(atom))
  }
  const id = normalizedLiteralTarget(target)
  if (id === false) return false
  const roleTargets = role.decisionAuthority.allowedTargets
  if (roleTargets && roleTargets.length > 0 && (id === null || !roleTargets.includes(id))) return false
  if (id !== null && (!roleTargets || roleTargets.length === 0)) return false
  if (resolution.capability.targetRestrictions.length > 0
    && (id === null || !resolution.capability.targetRestrictions.includes(id))) return false
  return true
}

/** `id` and `target` are aliases; providing both is rejected instead of applying hidden precedence. */
function normalizedLiteralTarget(target: Record<string, unknown>): string | null | false {
  const prototype = Object.getPrototypeOf(target)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(target)
  if (keys.some(key => typeof key !== 'string' || (key !== 'id' && key !== 'target'))) return false
  const hasId = keys.includes('id')
  const hasTarget = keys.includes('target')
  if (hasId && hasTarget) return false
  if (!hasId && !hasTarget) return null
  const descriptor = Object.getOwnPropertyDescriptor(target, hasId ? 'id' : 'target')
  if (!descriptor?.enumerable || !('value' in descriptor)) return false
  const raw = descriptor.value
  if (typeof raw !== 'string') return false
  const normalized = raw.trim()
  if (!normalized || normalized === '*') return false
  return normalized
}

function rolePolicyMaterial(role: AssistantRole): unknown {
  return { id: role.id, enabled: role.enabled, capabilityScope: role.capabilityScope,
    decisionAuthority: role.decisionAuthority, spendingLimits: role.spendingLimits }
}

function summarize(input: FabricPolicyInput): Record<string, unknown> {
  return {
    capabilityId: input.capabilityId,
    targetFields: Object.keys(input.target).sort(), inputFields: Object.keys(input.input).sort(),
    constraintFields: Object.keys(input.constraints).sort(), hasExpectedCost: input.expectedCost !== undefined,
  }
}

function redactedObject(value: Record<string, unknown>): string {
  return JSON.stringify({ redacted: true, fields: Object.keys(value).sort() })
}

function validateInput(input: FabricPolicyInput): void {
  if (!input || typeof input !== 'object') throw new Error('FABRIC_POLICY_INVALID_INPUT')
  for (const [name, value] of [['capabilityId', input.capabilityId], ['requestedByRoleId', input.requestedByRoleId],
    ['requestedByUserId', input.requestedByUserId], ['idempotencyKey', input.idempotencyKey]] as const) {
    if (typeof value !== 'string' || !value || value.length > 256) throw new Error(`FABRIC_POLICY_INVALID_${name.toUpperCase()}`)
  }
  for (const value of [input.target, input.input, input.constraints]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('FABRIC_POLICY_INVALID_JSON')
  }
  const targetPrototype = Object.getPrototypeOf(input.target)
  if (targetPrototype !== Object.prototype && targetPrototype !== null) throw new Error('FABRIC_POLICY_INVALID_JSON')
  for (const key of Reflect.ownKeys(input.target)) {
    if (typeof key !== 'string') throw new Error('FABRIC_POLICY_INVALID_JSON')
    const descriptor = Object.getOwnPropertyDescriptor(input.target, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('FABRIC_POLICY_INVALID_JSON')
  }
  if (Object.prototype.hasOwnProperty.call(input, 'expectedCost')) {
    if (!input.expectedCost || typeof input.expectedCost !== 'object') throw new Error('FABRIC_BUDGET_INVALID_MONEY')
    validateMoney(input.expectedCost)
  }
}

function validateMoney(money: FabricMoney): void {
  if (!/^[A-Z]{3}$/.test(money.currency) || !Number.isSafeInteger(money.amountMinor) || money.amountMinor < 0) {
    throw new Error('FABRIC_BUDGET_INVALID_MONEY')
  }
}

function wouldExceedDaily(db: DatabaseSync, role: AssistantRole, input: Pick<FabricPolicyInput, 'requestedByUserId' | 'requestedByRoleId'>,
  money: FabricMoney, date: string): boolean {
  return dailyTotal(db, input.requestedByUserId, input.requestedByRoleId, date, money.currency) + money.amountMinor
    > role.spendingLimits.daily
}

function dailyTotal(db: DatabaseSync, userId: string, roleId: string, date: string, currency: string, exceptId?: string): number {
  const row = db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS total FROM fabric_budget_ledger
    WHERE requested_by_user_id=? AND requested_by_role_id=? AND ledger_date=? AND currency=?
      AND status IN ('reserved','committed') AND (? IS NULL OR id<>?)`).get(
    userId, roleId, date, currency, exceptId ?? null, exceptId ?? null,
  ) as { total: number }
  return row.total
}

function insertReservation(db: DatabaseSync, decisionId: string,
  input: Pick<FabricPolicyInput, 'requestedByUserId' | 'requestedByRoleId'>,
  money: FabricMoney, date: string, now: string): LedgerRow {
  const existing = selectLedgerByDecision(db, decisionId)
  if (existing) return existing
  const id = `budget-${randomUUID()}`
  db.prepare(`INSERT INTO fabric_budget_ledger(id,decision_id,workflow_id,requested_by_user_id,
    requested_by_role_id,ledger_date,currency,amount_minor,status,created_at,updated_at)
    VALUES(?,?,NULL,?,?,?,?,?,'reserved',?,?)`).run(
    id, decisionId, input.requestedByUserId, input.requestedByRoleId, date, money.currency, money.amountMinor, now, now,
  )
  return db.prepare('SELECT * FROM fabric_budget_ledger WHERE id=?').get(id) as unknown as LedgerRow
}

function selectLedgerByDecision(db: DatabaseSync, decisionId: string): LedgerRow | undefined {
  return db.prepare('SELECT * FROM fabric_budget_ledger WHERE decision_id=? ORDER BY created_at LIMIT 1').get(decisionId) as LedgerRow | undefined
}

function requireDecision(db: DatabaseSync, id: string): DecisionRow {
  const row = db.prepare('SELECT * FROM fabric_policy_decisions WHERE id=?').get(id) as DecisionRow | undefined
  if (!row) throw new Error('FABRIC_POLICY_DECISION_NOT_FOUND')
  return row
}

function latestDecisionForIntent(db: DatabaseSync, intentId: string): DecisionRow | undefined {
  return db.prepare(`SELECT * FROM fabric_policy_decisions WHERE intent_id=?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(intentId) as unknown as DecisionRow | undefined
}

function materialConflictForIntent(db: DatabaseSync, intentId: string): DecisionRow | undefined {
  return db.prepare(`SELECT * FROM fabric_policy_decisions WHERE intent_id=? AND outcome='deny'
    AND reason_codes_json='["material_input_changed"]' ORDER BY created_at ASC, rowid ASC LIMIT 1`).get(intentId) as unknown as DecisionRow | undefined
}

function sameSnapshot(decision: DecisionRow, snapshot: Record<string, unknown>): boolean {
  try { return stableStringify(JSON.parse(decision.policy_snapshot_json)) === stableStringify(snapshot) } catch { return false }
}

function persistDenyDecision(db: DatabaseSync, input: {
  intentId: string
  executorId: string | null
  reason: 'material_input_changed' | 'authorization_expired'
  materialInputDigest: string
  snapshot: Record<string, unknown>
  sanitizedSummary: Record<string, unknown>
  actorUserId: string
  now: string
}): FabricPolicyDecision {
  const id = `decision-${randomUUID()}`
  db.prepare(`INSERT INTO fabric_policy_decisions(id,intent_id,executor_id,outcome,reason_codes_json,
    policy_version,material_input_digest,policy_snapshot_json,sanitized_summary_json,
    budget_currency,budget_amount_minor,created_at) VALUES(?,?,?,'deny',?,?,?,?,?,NULL,NULL,?)`).run(
    id, input.intentId, input.executorId, JSON.stringify([input.reason]), POLICY_VERSION,
    input.materialInputDigest, JSON.stringify(input.snapshot), JSON.stringify(input.sanitizedSummary), input.now,
  )
  appendFabricAuditEvent(db, { eventType: 'policy.evaluated', actorUserId: input.actorUserId,
    aggregateType: 'intent', aggregateId: input.intentId,
    payload: { decisionId: id, outcome: 'deny', reasonCodes: [input.reason], sanitizedSummary: input.sanitizedSummary },
    occurredAt: input.now })
  appendFabricOutbox(db, 'fabric.policy.evaluated', input.intentId,
    { decisionId: id, outcome: 'deny', reasonCodes: [input.reason] })
  return { id, intentId: input.intentId, executorId: input.executorId, outcome: 'deny',
    reasonCodes: [input.reason], policyVersion: POLICY_VERSION, materialInputDigest: input.materialInputDigest,
    policySnapshot: input.snapshot, sanitizedSummary: input.sanitizedSummary, budget: null, createdAt: input.now }
}

function requireIntentIdentity(db: DatabaseSync, id: string): { requested_by_user_id: string; requested_by_role_id: string } {
  const row = db.prepare('SELECT requested_by_user_id,requested_by_role_id FROM fabric_action_intents WHERE id=?').get(id) as
    { requested_by_user_id: string; requested_by_role_id: string } | undefined
  if (!row) throw new Error('FABRIC_INTENT_NOT_FOUND')
  return row
}

function requireWorkflowLedger(db: DatabaseSync, workflowId: string) {
  const workflow = db.prepare('SELECT policy_decision_id FROM fabric_workflows WHERE id=?').get(workflowId) as
    { policy_decision_id: string | null } | undefined
  if (!workflow?.policy_decision_id) throw new Error('FABRIC_WORKFLOW_BUDGET_NOT_FOUND')
  const decision = requireDecision(db, workflow.policy_decision_id)
  const ledger = selectLedgerByDecision(db, decision.id)
  if (!ledger) throw new Error('FABRIC_WORKFLOW_BUDGET_NOT_FOUND')
  return { decision, ledger, intent: requireIntentIdentity(db, decision.intent_id) }
}

function revalidateSnapshot(db: DatabaseSync, decision: DecisionRow, roleId: string): void {
  const snapshot = JSON.parse(decision.policy_snapshot_json) as Record<string, unknown>
  const role = getAssistantRole(roleId)
  if (!role || snapshot.roleUpdatedAt !== role.updatedAt || snapshot.roleDigest !== digest(rolePolicyMaterial(role))) {
    throw new Error('FABRIC_POLICY_STALE_ROLE')
  }
  const environments = snapshot.environments as FabricEnvironment[]
  const resolution = resolveFabricExecutorInDb(db, (JSON.parse(decision.sanitized_summary_json) as { capabilityId: string }).capabilityId,
    { environments })
  if (!resolution || resolution.policyRevision !== snapshot.registryPolicyRevision
    || resolution.policyEvaluationToken !== snapshot.registryPolicyEvaluationToken) throw new Error('FABRIC_POLICY_STALE_REGISTRY')
  revalidateAuthorization(db, decision, snapshot, resolution)
  const control = getFabricControlStateInDb(db)
  if (control.version !== snapshot.controlVersion || emergencyBlocks(control.level, snapshot.phase as 'intent' | 'execution')) {
    throw new Error('FABRIC_POLICY_STALE_CONTROL')
  }
}

function revalidateAuthorization(
  db: DatabaseSync,
  decision: DecisionRow,
  snapshot: Record<string, unknown>,
  resolution: ResolvedFabricExecutor,
): void {
  const standingMode = snapshot.standingAuthorizationMode ?? snapshot.authorizationMode
  if (standingMode === 'standing_sandbox') {
    if (resolution.executor.id !== 'health-shadow' || resolution.executor.environment !== 'sandbox'
      || resolution.executor.configuration.shadow !== true || resolution.executor.configuration.externalWrite !== false) {
      throw new Error('FABRIC_POLICY_STALE_AUTHORIZATION')
    }
    return
  }
  if (standingMode !== 'standing_provider') {
    if (snapshot.standingAuthorizationRequired === true
      || isHealthCapability(resolution.capability.id) && resolution.executor.environment === 'production'
        && resolution.capability.authentication.length > 0) {
      throw new Error('FABRIC_POLICY_STALE_AUTHORIZATION')
    }
    return
  }
  const intent = db.prepare(`SELECT i.requested_by_user_id,s.input_json
    FROM fabric_action_intents i
    JOIN fabric_workflows w ON w.intent_id=i.id
    JOIN fabric_steps s ON s.workflow_id=w.id AND s.ordinal=0 AND s.kind='prepare'
    WHERE i.id=?`).get(decision.intent_id) as { requested_by_user_id: string; input_json: string } | undefined
  if (!intent) throw new Error('FABRIC_POLICY_STALE_AUTHORIZATION')
  const summary = JSON.parse(decision.sanitized_summary_json) as { capabilityId?: unknown }
  const stepInput = JSON.parse(intent.input_json) as Record<string, unknown>
  const target = stepInput.target as FabricPolicyInput['target']
  const actionInput = stepInput.actionInput as FabricPolicyInput['input']
  if (typeof summary.capabilityId !== 'string' || !target || Array.isArray(target) || typeof target !== 'object'
    || !actionInput || Array.isArray(actionInput) || typeof actionInput !== 'object') {
    throw new Error('FABRIC_POLICY_STALE_AUTHORIZATION')
  }
  const atoms = healthTargetAtoms(summary.capabilityId, target, actionInput)
  const requirements = healthStandingAuthorizationRequirements(resolution.capability)
  const evidence = snapshot.authorizationEvidence as FabricAuthorizationEvidence | null
  const current = atoms && requirements ? resolveFabricAuthorization({
    capabilityId: summary.capabilityId, requestedByUserId: intent.requested_by_user_id, targetAtoms: atoms,
    executorId: resolution.executor.id, environment: resolution.executor.environment,
    input: actionInput, requirements,
  }, new Date().toISOString()) : null
  if (!evidence || !current || stableStringify(evidence) !== stableStringify(current)) {
    throw new Error('FABRIC_POLICY_STALE_AUTHORIZATION')
  }
}

function parseLedger(row: LedgerRow): FabricBudgetReservation {
  return { id: row.id, decisionId: row.decision_id, workflowId: row.workflow_id,
    requestedByUserId: row.requested_by_user_id, requestedByRoleId: row.requested_by_role_id,
    ledgerDate: row.ledger_date, money: { currency: row.currency, amountMinor: row.amount_minor },
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }
}

function parseDecision(row: DecisionRow): FabricPolicyDecision {
  return { id: row.id, intentId: row.intent_id, executorId: row.executor_id, outcome: row.outcome,
    reasonCodes: JSON.parse(row.reason_codes_json), policyVersion: row.policy_version,
    materialInputDigest: row.material_input_digest, policySnapshot: JSON.parse(row.policy_snapshot_json),
    sanitizedSummary: JSON.parse(row.sanitized_summary_json), budget: row.budget_currency === null ? null
      : { currency: row.budget_currency, amountMinor: row.budget_amount_minor! }, createdAt: row.created_at }
}

function utcDate(date: Date): string { return date.toISOString().slice(0, 10) }

function digest(value: unknown): string { return createHash('sha256').update(stableStringify(value)).digest('hex') }
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  return JSON.stringify(value)
}

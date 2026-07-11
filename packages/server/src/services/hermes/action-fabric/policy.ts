import { createHash, randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  getAssistantRole,
  migrateAssistantRoleCapabilityEnforcement,
} from '../personal-twin'
import type { AssistantRole, AssistantRoleRisk } from '../personal-twin'
import { appendFabricAuditEvent, appendFabricOutbox, withFabricAuditedTransaction } from './audit'
import { getFabricControlState } from './control'
import { ensureBuiltInFabricRegistry, resolveFabricExecutor } from './registry'
import type {
  FabricBudgetReservation,
  FabricEnvironment,
  FabricMoney,
  FabricPolicyDecision,
  FabricPolicyInput,
  ResolvedFabricExecutor,
} from './types'

const POLICY_VERSION = 1
const RISK_ORDER: Record<AssistantRoleRisk, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }
type ReasonCode =
  | 'role_missing' | 'role_disabled' | 'capability_not_allowed' | 'capability_denied'
  | 'executor_unavailable' | 'target_not_allowed' | 'risk_requires_approval'
  | 'per_action_limit_exceeded' | 'daily_limit_exceeded' | 'currency_mismatch'
  | 'emergency_stop' | 'material_input_changed'

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

export function evaluateFabricPolicy(input: FabricPolicyInput): FabricPolicyDecision {
  validateInput(input)
  ensureBuiltInFabricRegistry()
  migrateAssistantRoleCapabilityEnforcement()
  const role = getAssistantRole(input.requestedByRoleId)
  const environments = input.environments ?? ['simulator', 'internal']
  const resolution = resolveFabricExecutor(input.capabilityId, { environments })
  const materialInputDigest = digest({
    capabilityId: input.capabilityId, target: input.target, input: input.input,
    constraints: input.constraints, expectedCost: input.expectedCost ?? null,
  })
  const sanitizedSummary = summarize(input)
  const control = readControlState()
  const reasons: ReasonCode[] = []
  let outcome: FabricPolicyDecision['outcome'] = 'allow'
  let budget: FabricMoney | null = null

  if (!role) reasons.push('role_missing')
  else if (!role.enabled) reasons.push('role_disabled')
  else if (role.capabilityScope.deny.includes(input.capabilityId)) reasons.push('capability_denied')
  else if (!role.capabilityScope.allow.includes(input.capabilityId)) reasons.push('capability_not_allowed')
  else if (!resolution) reasons.push('executor_unavailable')
  else if (emergencyBlocks(control.level, input.phase ?? 'intent')) reasons.push('emergency_stop')
  else if (input.expectedMaterialInputDigest !== undefined && input.expectedMaterialInputDigest !== materialInputDigest) {
    reasons.push('material_input_changed')
  } else if (!targetAllowed(role, resolution, input.target)) reasons.push('target_not_allowed')
  else {
    const risk = RISK_ORDER[resolution.capability.risk]
    if (risk > RISK_ORDER[role.decisionAuthority.maxRisk]) {
      reasons.push('risk_requires_approval')
      outcome = 'deny'
    } else if (role.decisionAuthority.requireApprovalAbove !== undefined
      && risk >= RISK_ORDER[role.decisionAuthority.requireApprovalAbove]) {
      reasons.push('risk_requires_approval')
      outcome = 'waiting_user'
    }
    const cost = input.expectedCost ?? (resolution.capability.cost.currency === null
      ? null
      : { currency: resolution.capability.cost.currency, amountMinor: resolution.capability.cost.estimatedMinor })
    if (outcome === 'allow' && cost && cost.amountMinor > 0) {
      budget = cost
      if (role.spendingLimits.currency !== cost.currency) reasons.push('currency_mismatch')
      else if (cost.amountMinor > role.spendingLimits.perAction) reasons.push('per_action_limit_exceeded')
      if (reasons.length > 0) outcome = 'deny'
    }
  }
  if (reasons.length > 0 && outcome === 'allow') outcome = 'deny'

  const roleSnapshot = role === null ? null : {
    roleUpdatedAt: role.updatedAt,
    roleDigest: digest(rolePolicyMaterial(role)),
  }
  const registrySnapshot = resolution === null ? null : {
    registryPolicyRevision: resolution.policyRevision,
    registryPolicyEvaluationToken: resolution.policyEvaluationToken,
  }
  const snapshot = {
    ...roleSnapshot, ...registrySnapshot, controlVersion: control.version, controlLevel: control.level,
    phase: input.phase ?? 'intent', environments: [...environments].sort(), ledgerDate: utcDate(new Date()),
  }

  return withFabricAuditedTransaction(db => {
    const existing = db.prepare(`SELECT id, material_input_digest FROM fabric_action_intents
      WHERE requested_by_user_id=? AND requested_by_role_id=? AND idempotency_key=?`).get(
      input.requestedByUserId, input.requestedByRoleId, input.idempotencyKey,
    ) as { id: string; material_input_digest: string } | undefined
    const intentId = existing?.id ?? `intent-${randomUUID()}`
    if (existing && existing.material_input_digest !== materialInputDigest && !reasons.includes('material_input_changed')) {
      reasons.splice(0, reasons.length, 'material_input_changed')
      outcome = 'deny'
      budget = null
    }
    const now = new Date().toISOString()
    if (!existing) {
      db.prepare(`INSERT INTO fabric_action_intents(
        id,capability_id,capability_version,requested_by_role_id,requested_by_user_id,idempotency_key,
        goal,target_json,input_json,constraints_json,rationale,expected_cost_currency,expected_cost_minor,
        material_input_digest,sanitized_summary_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        intentId, input.capabilityId, resolution?.capability.version ?? 1, input.requestedByRoleId,
        input.requestedByUserId, input.idempotencyKey, '[redacted]', redactedObject(input.target),
        redactedObject(input.input), redactedObject(input.constraints), '[redacted]', input.expectedCost?.currency ?? null,
        input.expectedCost?.amountMinor ?? null, materialInputDigest, JSON.stringify(sanitizedSummary), now, now,
      )
    }
    const decisionId = `decision-${randomUUID()}`
    if (outcome === 'allow' && budget && wouldExceedDaily(db, role!, input, budget, utcDate(new Date()))) {
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
    if (outcome === 'allow' && budget) insertReservation(db, decisionId, input, budget, utcDate(new Date()), now)
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
  })
}

export function reserveFabricBudget(decisionId: string): FabricBudgetReservation {
  return withFabricAuditedTransaction(db => {
    const existing = selectLedgerByDecision(db, decisionId)
    if (existing) return parseLedger(existing)
    const decision = requireDecision(db, decisionId)
    if (decision.outcome !== 'allow' || decision.budget_currency === null || decision.budget_amount_minor === null) {
      throw new Error('FABRIC_BUDGET_NOT_RESERVABLE')
    }
    const intent = requireIntentIdentity(db, decision.intent_id)
    revalidateSnapshot(decision, intent.requested_by_role_id)
    const now = new Date().toISOString()
    return parseLedger(insertReservation(db, decisionId, {
      requestedByUserId: intent.requested_by_user_id, requestedByRoleId: intent.requested_by_role_id,
    }, { currency: decision.budget_currency, amountMinor: decision.budget_amount_minor }, utcDate(new Date()), now))
  })
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
    revalidateSnapshot(context.decision, context.intent.requested_by_role_id)
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

function readControlState(): { level: 0 | 1 | 2 | 3; version: number } {
  return getFabricControlState()
}

function emergencyBlocks(level: number, phase: 'intent' | 'execution'): boolean {
  return phase === 'intent' ? level >= 1 : level >= 2
}

function targetAllowed(role: AssistantRole, resolution: ResolvedFabricExecutor, target: Record<string, unknown>): boolean {
  const id = typeof target.id === 'string' ? target.id : typeof target.target === 'string' ? target.target : null
  if (id === '*') return false
  const roleTargets = role.decisionAuthority.allowedTargets
  if (id !== null && (!roleTargets || !roleTargets.includes(id))) return false
  if (resolution.capability.targetRestrictions.length > 0
    && (id === null || !resolution.capability.targetRestrictions.includes(id))) return false
  return true
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
  if (input.expectedCost) validateMoney(input.expectedCost)
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

function revalidateSnapshot(decision: DecisionRow, roleId: string): void {
  const snapshot = JSON.parse(decision.policy_snapshot_json) as Record<string, unknown>
  const role = getAssistantRole(roleId)
  if (!role || snapshot.roleUpdatedAt !== role.updatedAt || snapshot.roleDigest !== digest(rolePolicyMaterial(role))) {
    throw new Error('FABRIC_POLICY_STALE_ROLE')
  }
  const environments = snapshot.environments as FabricEnvironment[]
  const resolution = resolveFabricExecutor((JSON.parse(decision.sanitized_summary_json) as { capabilityId: string }).capabilityId,
    { environments })
  if (!resolution || resolution.policyRevision !== snapshot.registryPolicyRevision
    || resolution.policyEvaluationToken !== snapshot.registryPolicyEvaluationToken) throw new Error('FABRIC_POLICY_STALE_REGISTRY')
  const control = readControlState()
  if (control.version !== snapshot.controlVersion || emergencyBlocks(control.level, snapshot.phase as 'intent' | 'execution')) {
    throw new Error('FABRIC_POLICY_STALE_CONTROL')
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

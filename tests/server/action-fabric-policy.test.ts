import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  commitFabricBudget,
  bindFabricExecutorCapability,
  createFabricCapability,
  ensureBuiltInFabricRegistry,
  evaluateFabricPolicy,
  releaseFabricBudget,
  getFabricCapability,
  reserveFabricBudget,
  setFabricEmergencyStop,
  setFabricExecutorEnabled,
  withActionFabricDb,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  ensureBuiltInAssistantRoles,
  updateAssistantRole,
} from '../../packages/server/src/services/hermes/personal-twin'

describe('Action Fabric role policy', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hwui-fabric-policy-'))
    process.env.HERMES_HOME = home
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-12T01:00:00.000Z'))
    ensureBuiltInAssistantRoles()
    ensureBuiltInFabricRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it('defaults to deny for missing, disabled, and unlisted roles and deny wins', () => {
    expect(evaluateFabricPolicy(intent('missing'))).toMatchObject({ outcome: 'deny', reasonCodes: ['role_missing'] })
    configureRole({ enabled: false, allow: ['simulator.echo'] })
    expect(evaluateFabricPolicy(intent())).toMatchObject({ outcome: 'deny', reasonCodes: ['role_disabled'] })
    configureRole({ allow: [] })
    expect(evaluateFabricPolicy(intent())).toMatchObject({ outcome: 'deny', reasonCodes: ['capability_not_allowed'] })
    configureRole({ allow: ['simulator.echo'], deny: ['simulator.echo'] })
    expect(evaluateFabricPolicy(intent())).toMatchObject({ outcome: 'deny', reasonCodes: ['capability_denied'] })
  }, 15_000)

  it('captures role, registry, executor, control and material revisions without persisting secrets', () => {
    configureRole({ allow: ['simulator.echo'] })
    const decision = evaluateFabricPolicy(intent('health-manager', {
      input: { password: 'super-secret', path: 'C:\\Users\\alice\\private.txt' },
    }))

    expect(decision).toMatchObject({ outcome: 'allow', executorId: 'simulator-main' })
    expect(decision.policySnapshot).toMatchObject({
      registryPolicyRevision: expect.any(Number), registryPolicyEvaluationToken: expect.any(String),
      roleUpdatedAt: expect.any(String), roleDigest: expect.any(String), controlVersion: 0,
    })
    const stored = withActionFabricDb(db => db.prepare(
      'SELECT input_json, goal, rationale, sanitized_summary_json FROM fabric_action_intents WHERE id=?',
    ).get(decision.intentId))
    expect(JSON.stringify(stored)).not.toContain('super-secret')
    expect(JSON.stringify(stored)).not.toContain('private.txt')
    expect(decision.materialInputDigest).toMatch(/^[a-f0-9]{64}$/)
  }, 15_000)

  it('requires one normalized literal target that satisfies both allowlists', () => {
    configureRole({
      allow: ['simulator.echo'],
      decisionAuthority: { maxRisk: 'high', requireApprovalAbove: 'low', allowedTargets: ['simulator'] },
    })
    expect(evaluateFabricPolicy(intent())).toMatchObject({ outcome: 'allow' })
    const deniedTargets = [
      {}, { id: '' }, { id: '   ' }, { id: '*' }, { id: 42 }, { target: false },
      { id: 'simulator', target: 'other' }, { id: 'simulator', target: 'simulator' },
      { id: 'other' }, { target: 'other' },
    ]
    deniedTargets.forEach((target, index) => {
      expect(evaluateFabricPolicy(intent('health-manager', { idempotencyKey: `target-${index}`, target })))
        .toMatchObject({ outcome: 'deny', reasonCodes: ['target_not_allowed'] })
    })
    expect(evaluateFabricPolicy(intent('health-manager', {
      idempotencyKey: 'target-normalized', target: { target: ' simulator ' },
    }))).toMatchObject({ outcome: 'allow' })
  }, 25_000)

  it('requires approval only when risk is strictly above the threshold', () => {
    configureRole({
      allow: ['simulator.echo'],
      decisionAuthority: { maxRisk: 'high', requireApprovalAbove: 'none' },
    })
    expect(evaluateFabricPolicy(intent('health-manager', { idempotencyKey: 'approval' })))
      .toMatchObject({ outcome: 'allow', reasonCodes: [] })

    registerCapability('simulator.low-risk', 'low', null, 0)
    configureRole({
      allow: ['simulator.low-risk'],
      decisionAuthority: { maxRisk: 'high', requireApprovalAbove: 'none' },
    })
    expect(evaluateFabricPolicy(intent('health-manager', { capabilityId: 'simulator.low-risk', idempotencyKey: 'above-none' })))
      .toMatchObject({ outcome: 'waiting_user', reasonCodes: ['risk_requires_approval'] })
    configureRole({
      allow: ['simulator.low-risk'],
      decisionAuthority: { maxRisk: 'high', requireApprovalAbove: 'low' },
    })
    expect(evaluateFabricPolicy(intent('health-manager', { capabilityId: 'simulator.low-risk', idempotencyKey: 'equal-low' })))
      .toMatchObject({ outcome: 'allow', reasonCodes: [] })
    configureRole({
      allow: ['simulator.low-risk'],
      decisionAuthority: { maxRisk: 'none', requireApprovalAbove: 'none' },
    })
    expect(evaluateFabricPolicy(intent('health-manager', { capabilityId: 'simulator.low-risk', idempotencyKey: 'above-max' })))
      .toMatchObject({ outcome: 'deny', reasonCodes: ['risk_requires_approval'] })
  }, 15_000)

  it('enforces emergency intent creation and captures execution behavior', () => {
    configureRole({ allow: ['simulator.echo'] })
    setFabricEmergencyStop(1, 'admin', 'maintenance')
    expect(evaluateFabricPolicy(intent())).toMatchObject({ outcome: 'deny', reasonCodes: ['emergency_stop'] })
    setFabricEmergencyStop(2, 'admin', 'halt execution')
    expect(evaluateFabricPolicy(intent('health-manager', { idempotencyKey: 'execution', phase: 'execution' })))
      .toMatchObject({ outcome: 'deny', reasonCodes: ['emergency_stop'] })
  }, 15_000)

  it('reserves integer minor units transactionally and commits/releases idempotently', () => {
    createFabricCapability({
      id: 'simulator.paid', version: 1, description: 'Paid simulation', inputSchema: {}, outputSchema: {},
      risk: 'low', sideEffect: false, idempotency: 'required', reversible: false,
      compensationCapabilityId: null, verificationStrategy: 'result', authentication: [],
      targetRestrictions: [], cost: { currency: 'USD', estimatedMinor: 60 }, enabled: true,
    })
    // Bind using the built-in simulator contract through the public registry API.
    bindFabricExecutorCapability('simulator-main', 'simulator.paid', 1, getFabricCapability('simulator.paid')!.contractDigest)
    configureRole({
      allow: ['simulator.paid'],
      decisionAuthority: { maxRisk: 'low' },
      spendingLimits: { currency: 'USD', perAction: 70, daily: 100 },
    })

    const first = evaluateFabricPolicy(intent('health-manager', { capabilityId: 'simulator.paid', expectedCost: { currency: 'USD', amountMinor: 60 } }))
    expect(first.outcome).toBe('allow')
    expect(reserveFabricBudget(first.id)).toMatchObject({ money: { currency: 'USD', amountMinor: 60 }, status: 'reserved' })
    const second = evaluateFabricPolicy(intent('health-manager', { capabilityId: 'simulator.paid', idempotencyKey: 'second', expectedCost: { currency: 'USD', amountMinor: 60 } }))
    expect(second).toMatchObject({ outcome: 'deny', reasonCodes: ['daily_limit_exceeded'] })

    withActionFabricDb(db => db.prepare(`INSERT INTO fabric_workflows
      (id,intent_id,executor_id,policy_decision_id,state,created_at,updated_at)
      VALUES('wf-1',?,?,?,'draft',?,?)`).run(first.intentId, first.executorId, first.id, new Date().toISOString(), new Date().toISOString()))
    commitFabricBudget('wf-1', { currency: 'USD', amountMinor: 50 })
    commitFabricBudget('wf-1', { currency: 'USD', amountMinor: 50 })
    releaseFabricBudget('wf-1')
    expect(withActionFabricDb(db => db.prepare('SELECT status,amount_minor FROM fabric_budget_ledger').get()))
      .toEqual({ status: 'committed', amount_minor: 50 })
  }, 15_000)

  it('rejects currency mismatch, per-action excess, and changed material input', () => {
    configureRole({ allow: ['simulator.echo'], spendingLimits: { currency: 'USD', perAction: 10, daily: 20 } })
    expect(evaluateFabricPolicy(intent('health-manager', { expectedCost: { currency: 'EUR', amountMinor: 1 } })))
      .toMatchObject({ outcome: 'deny', reasonCodes: ['currency_mismatch'] })
    expect(evaluateFabricPolicy(intent('health-manager', { idempotencyKey: 'large', expectedCost: { currency: 'USD', amountMinor: 11 } })))
      .toMatchObject({ outcome: 'deny', reasonCodes: ['per_action_limit_exceeded'] })
    expect(evaluateFabricPolicy(intent('health-manager', { idempotencyKey: 'changed', expectedMaterialInputDigest: '0'.repeat(64) })))
      .toMatchObject({ outcome: 'deny', reasonCodes: ['material_input_changed'] })
  }, 15_000)

  it('validates explicit zero-cost currency but only positive costs consume the ledger', () => {
    registerCapability('simulator.zero-cost', 'none', 'USD', 0)
    configureRole({
      allow: ['simulator.zero-cost'],
      spendingLimits: { currency: 'EUR', perAction: 10, daily: 20 },
    })
    expect(evaluateFabricPolicy(intent('health-manager', {
      capabilityId: 'simulator.zero-cost', idempotencyKey: 'cap-zero-mismatch',
    }))).toMatchObject({ outcome: 'deny', reasonCodes: ['currency_mismatch'] })
    expect(evaluateFabricPolicy(intent('health-manager', {
      capabilityId: 'simulator.zero-cost', idempotencyKey: 'expected-zero-mismatch',
      expectedCost: { currency: 'USD', amountMinor: 0 },
    }))).toMatchObject({ outcome: 'deny', reasonCodes: ['currency_mismatch'] })

    configureRole({
      allow: ['simulator.zero-cost'],
      spendingLimits: { currency: 'USD', perAction: 10, daily: 20 },
    })
    const allowed = evaluateFabricPolicy(intent('health-manager', {
      capabilityId: 'simulator.zero-cost', idempotencyKey: 'zero-allowed',
      expectedCost: { currency: 'USD', amountMinor: 0 },
    }))
    expect(allowed).toMatchObject({ outcome: 'allow', budget: null })
    expect(withActionFabricDb(db => db.prepare('SELECT COUNT(*) AS count FROM fabric_budget_ledger').get()))
      .toEqual({ count: 0 })

    for (const [idempotencyKey, expectedCost] of [
      ['negative', { currency: 'USD', amountMinor: -1 }],
      ['fraction', { currency: 'USD', amountMinor: 0.5 }],
      ['blank-currency', { currency: '', amountMinor: 0 }],
    ] as const) {
      expect(() => evaluateFabricPolicy(intent('health-manager', { idempotencyKey, expectedCost } as any)))
        .toThrow('FABRIC_BUDGET_INVALID_MONEY')
    }
  }, 15_000)

  it('uses the conservative contract cost and never trusts a lower caller estimate', () => {
    registerCapability('simulator.contract-cost', 'low', 'USD', 60)
    configureRole({ allow: ['simulator.contract-cost'], spendingLimits: { currency: 'USD', perAction: 100, daily: 500 } })
    const lower = evaluateFabricPolicy(intent('health-manager', {
      capabilityId: 'simulator.contract-cost', idempotencyKey: 'cost-lower',
      expectedCost: { currency: 'USD', amountMinor: 0 },
    }))
    expect(lower).toMatchObject({ outcome: 'allow', budget: { currency: 'USD', amountMinor: 60 } })
    expect(reserveFabricBudget(lower.id).money.amountMinor).toBe(60)
    const higher = evaluateFabricPolicy(intent('health-manager', {
      capabilityId: 'simulator.contract-cost', idempotencyKey: 'cost-higher',
      expectedCost: { currency: 'USD', amountMinor: 80 },
    }))
    expect(higher).toMatchObject({ outcome: 'allow', budget: { currency: 'USD', amountMinor: 80 } })
    expect(evaluateFabricPolicy(intent('health-manager', {
      capabilityId: 'simulator.contract-cost', idempotencyKey: 'cost-mismatch',
      expectedCost: { currency: 'EUR', amountMinor: 100 },
    }))).toMatchObject({ outcome: 'deny', reasonCodes: ['currency_mismatch'] })
  }, 15_000)

  it('reuses current idempotent decisions and reconciles stale reservations before reevaluation', () => {
    registerCapability('simulator.idempotent-cost', 'low', 'USD', 10)
    configureRole({ allow: ['simulator.idempotent-cost'], spendingLimits: { currency: 'USD', perAction: 20, daily: 20 } })
    const request = intent('health-manager', { capabilityId: 'simulator.idempotent-cost', idempotencyKey: 'same' })
    const first = evaluateFabricPolicy(request)
    const counts = () => withActionFabricDb(db => ({
      decisions: (db.prepare('SELECT COUNT(*) AS count FROM fabric_policy_decisions').get() as { count: number }).count,
      ledger: (db.prepare('SELECT COUNT(*) AS count FROM fabric_budget_ledger').get() as { count: number }).count,
      audit: (db.prepare('SELECT COUNT(*) AS count FROM fabric_audit_events').get() as { count: number }).count,
      outbox: (db.prepare('SELECT COUNT(*) AS count FROM fabric_outbox').get() as { count: number }).count,
    }))
    const before = counts()
    const replay = evaluateFabricPolicy(request)
    expect(replay.id).toBe(first.id)
    expect(counts()).toEqual(before)

    updateAssistantRole('health-manager', { decisionAuthority: { maxRisk: 'medium', allowedTargets: ['simulator'] } })
    expect(() => reserveFabricBudget(first.id)).toThrow(/stale.role/i)
    const reevaluated = evaluateFabricPolicy(request)
    expect(reevaluated.id).not.toBe(first.id)
    expect(withActionFabricDb(db => db.prepare(`SELECT status,COUNT(*) AS count FROM fabric_budget_ledger
      GROUP BY status ORDER BY status`).all())).toEqual([
      { status: 'released', count: 1 }, { status: 'reserved', count: 1 },
    ])

    setFabricExecutorEnabled('simulator-main', false)
    expect(() => reserveFabricBudget(reevaluated.id)).toThrow(/stale.registry/i)
  }, 20_000)

  it('requires user approval for irreversible side effects but keeps maxRisk as a deny ceiling', () => {
    createFabricCapability({
      id: 'simulator.irreversible', version: 1, description: 'Irreversible simulation', inputSchema: {}, outputSchema: {},
      risk: 'low', sideEffect: true, idempotency: 'required', reversible: false, compensationCapabilityId: null,
      verificationStrategy: 'result', authentication: [], targetRestrictions: ['simulator'],
      cost: { currency: null, estimatedMinor: 0 }, enabled: true,
    })
    bindFabricExecutorCapability('simulator-main', 'simulator.irreversible', 1, getFabricCapability('simulator.irreversible')!.contractDigest)
    configureRole({ allow: ['simulator.irreversible'], decisionAuthority: { maxRisk: 'low' } })
    expect(evaluateFabricPolicy(intent('health-manager', {
      capabilityId: 'simulator.irreversible', idempotencyKey: 'irreversible-wait',
    }))).toMatchObject({ outcome: 'waiting_user', reasonCodes: ['irreversible_requires_approval'] })
    configureRole({ allow: ['simulator.irreversible'], decisionAuthority: { maxRisk: 'none' } })
    expect(evaluateFabricPolicy(intent('health-manager', {
      capabilityId: 'simulator.irreversible', idempotencyKey: 'irreversible-deny',
    }))).toMatchObject({ outcome: 'deny', reasonCodes: ['risk_requires_approval'] })
  }, 15_000)

  it('uses one injected instant for timestamps and the UTC ledger date at midnight', () => {
    registerCapability('simulator.midnight', 'low', 'USD', 1)
    configureRole({ allow: ['simulator.midnight'], spendingLimits: { currency: 'USD', perAction: 1, daily: 1 } })
    let clockCalls = 0
    const decision = evaluateFabricPolicy(intent('health-manager', {
      capabilityId: 'simulator.midnight', idempotencyKey: 'midnight',
    }), { clock: () => { clockCalls += 1; return new Date('2026-07-12T23:59:59.999Z') } })
    expect(clockCalls).toBe(1)
    expect(decision.createdAt).toBe('2026-07-12T23:59:59.999Z')
    expect(decision.policySnapshot.ledgerDate).toBe('2026-07-12')
    expect(reserveFabricBudget(decision.id).ledgerDate).toBe('2026-07-12')
  }, 15_000)

  it('rejects target pass-through fields and accessors', () => {
    configureRole({ allow: ['simulator.echo'] })
    expect(evaluateFabricPolicy(intent('health-manager', {
      idempotencyKey: 'extra-target', target: { id: 'simulator', url: 'https://example.test' },
    }))).toMatchObject({ outcome: 'deny', reasonCodes: ['target_not_allowed'] })
    const target = Object.defineProperty({}, 'id', { enumerable: true, get: () => { throw new Error('getter ran') } })
    expect(() => evaluateFabricPolicy(intent('health-manager', { idempotencyKey: 'getter-target', target })))
      .toThrow('FABRIC_POLICY_INVALID_JSON')
  }, 15_000)

  it('binds replay and reserve behavior to the budget and workflow lifecycle', () => {
    registerCapability('simulator.lifecycle', 'low', 'USD', 5)
    configureRole({ allow: ['simulator.lifecycle'], spendingLimits: { currency: 'USD', perAction: 10, daily: 30 } })
    const request = intent('health-manager', { capabilityId: 'simulator.lifecycle', idempotencyKey: 'released-flow' })
    const released = evaluateFabricPolicy(request)
    attachWorkflow(released, 'wf-released')
    releaseFabricBudget('wf-released')
    const expired = evaluateFabricPolicy(request)
    expect(expired).toMatchObject({ outcome: 'deny', reasonCodes: ['authorization_expired'] })
    expect(expired.id).not.toBe(released.id)
    expect(() => reserveFabricBudget(expired.id)).toThrow('FABRIC_BUDGET_NOT_RESERVABLE')
    expect(evaluateFabricPolicy(request).id).toBe(expired.id)

    const committedRequest = intent('health-manager', { capabilityId: 'simulator.lifecycle', idempotencyKey: 'committed-flow' })
    const committed = evaluateFabricPolicy(committedRequest)
    attachWorkflow(committed, 'wf-committed')
    commitFabricBudget('wf-committed')
    expect(evaluateFabricPolicy(committedRequest).id).toBe(committed.id)
    expect(() => reserveFabricBudget(committed.id)).toThrow('FABRIC_BUDGET_ALREADY_COMMITTED')

    const ownedRequest = intent('health-manager', { capabilityId: 'simulator.lifecycle', idempotencyKey: 'owned-flow' })
    const owned = evaluateFabricPolicy(ownedRequest)
    attachWorkflow(owned, 'wf-owned')
    expect(evaluateFabricPolicy(ownedRequest).id).toBe(owned.id)
    expect(() => reserveFabricBudget(owned.id)).toThrow('FABRIC_BUDGET_OWNERSHIP_CONFLICT')
  }, 20_000)

  it('persists and audits one immutable material conflict decision that cannot reserve', () => {
    registerCapability('simulator.conflict', 'low', 'USD', 5)
    configureRole({ allow: ['simulator.conflict'], spendingLimits: { currency: 'USD', perAction: 10, daily: 20 } })
    const original = evaluateFabricPolicy(intent('health-manager', {
      capabilityId: 'simulator.conflict', idempotencyKey: 'conflict-key', input: { value: 1 },
    }))
    const auditBefore = withActionFabricDb(db => (db.prepare('SELECT COUNT(*) AS count FROM fabric_audit_events').get() as { count: number }).count)
    const conflictRequest = intent('health-manager', {
      capabilityId: 'simulator.conflict', idempotencyKey: 'conflict-key', input: { value: 2 },
    })
    const conflict = evaluateFabricPolicy(conflictRequest)
    expect(conflict).toMatchObject({ outcome: 'deny', reasonCodes: ['material_input_changed'] })
    expect(conflict.id).not.toBe(original.id)
    expect(withActionFabricDb(db => db.prepare('SELECT outcome,reason_codes_json FROM fabric_policy_decisions WHERE id=?').get(conflict.id)))
      .toEqual({ outcome: 'deny', reason_codes_json: '["material_input_changed"]' })
    expect(withActionFabricDb(db => (db.prepare('SELECT COUNT(*) AS count FROM fabric_audit_events').get() as { count: number }).count))
      .toBe(auditBefore + 1)
    expect(() => reserveFabricBudget(conflict.id)).toThrow('FABRIC_BUDGET_NOT_RESERVABLE')
    expect(evaluateFabricPolicy(conflictRequest).id).toBe(conflict.id)
  }, 15_000)
})

function configureRole(options: {
  enabled?: boolean
  allow: string[]
  deny?: string[]
  decisionAuthority?: Record<string, unknown>
  spendingLimits?: Record<string, unknown>
}): void {
  updateAssistantRole('health-manager', {
    enabled: options.enabled ?? true,
    capabilityScope: { allow: options.allow, deny: options.deny ?? [], enforcement: 'action_fabric_v1' },
    decisionAuthority: { maxRisk: 'critical', allowedTargets: ['simulator'], ...(options.decisionAuthority ?? {}) } as any,
    spendingLimits: options.spendingLimits ?? { currency: null, perAction: 0, daily: 0 },
  })
}

function intent(role = 'health-manager', overrides: Record<string, unknown> = {}) {
  return {
    capabilityId: 'simulator.echo', requestedByRoleId: role, requestedByUserId: 'user-1',
    idempotencyKey: 'intent-1', goal: 'echo safely', target: { id: 'simulator' }, input: { message: 'hello' },
    constraints: {}, rationale: 'requested by user', ...overrides,
  } as Parameters<typeof evaluateFabricPolicy>[0]
}

function registerCapability(id: string, risk: 'none' | 'low', currency: string | null, estimatedMinor: number): void {
  createFabricCapability({
    id, version: 1, description: id, inputSchema: {}, outputSchema: {}, risk,
    sideEffect: false, idempotency: 'required', reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'result', authentication: [], targetRestrictions: ['simulator'],
    cost: { currency, estimatedMinor }, enabled: true,
  })
  bindFabricExecutorCapability('simulator-main', id, 1, getFabricCapability(id)!.contractDigest)
}

function attachWorkflow(decision: ReturnType<typeof evaluateFabricPolicy>, workflowId: string): void {
  withActionFabricDb(db => {
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO fabric_workflows(id,intent_id,executor_id,policy_decision_id,state,created_at,updated_at)
      VALUES(?,?,?,?, 'draft',?,?)`).run(workflowId, decision.intentId, decision.executorId, decision.id, now, now)
    db.prepare('UPDATE fabric_budget_ledger SET workflow_id=? WHERE decision_id=?').run(workflowId, decision.id)
  })
}

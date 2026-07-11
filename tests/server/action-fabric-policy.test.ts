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
      risk: 'low', sideEffect: true, idempotency: 'required', reversible: false,
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
    sideEffect: true, idempotency: 'required', reversible: false, compensationCapabilityId: null,
    verificationStrategy: 'result', authentication: [], targetRestrictions: ['simulator'],
    cost: { currency, estimatedMinor }, enabled: true,
  })
  bindFabricExecutorCapability('simulator-main', id, 1, getFabricCapability(id)!.contractDigest)
}

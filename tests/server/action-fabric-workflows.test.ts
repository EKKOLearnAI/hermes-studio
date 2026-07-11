import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFabricWorkflow,
  bindFabricExecutorCapability,
  cancelFabricWorkflow,
  createFabricIntent,
  getFabricCapability,
  ensureBuiltInFabricRegistry,
  evaluateFabricPolicy,
  getFabricIntent,
  getFabricWorkflow,
  listFabricAuditEvents,
  listFabricWorkflows,
  rejectFabricWorkflow,
  requestFabricCompensation,
  retryFabricWorkflow,
  updateFabricCapability,
  withActionFabricDb,
} from '../../packages/server/src/services/hermes/action-fabric'
import { ensureBuiltInAssistantRoles, updateAssistantRole } from '../../packages/server/src/services/hermes/personal-twin'

describe('Action Fabric durable workflows', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hwui-fabric-workflows-'))
    process.env.HERMES_HOME = home
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-12T01:00:00.000Z'))
    ensureBuiltInAssistantRoles()
    ensureBuiltInFabricRegistry()
    configureRole(['simulator.echo'])
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it('persists the resolved policy before creating an executable workflow', () => {
    const result = createFabricIntent(intent())

    expect(result.policyDecision).toMatchObject({ outcome: 'allow', executorId: 'simulator-main' })
    expect(result.workflow).toMatchObject({ intentId: result.intent.id, executorId: 'simulator-main', state: 'preparing' })
    expect(result.workflow.steps.map(step => ({ ordinal: step.ordinal, kind: step.kind, state: step.state }))).toEqual([
      { ordinal: 0, kind: 'prepare', state: 'pending' },
      { ordinal: 1, kind: 'execute', state: 'pending' },
      { ordinal: 2, kind: 'verify', state: 'pending' },
    ])
    expect(result.workflow.steps[1].input).toMatchObject({ actionInput: { message: 'hello' } })
    expect(getFabricIntent(result.intent.id)).toEqual(result.intent)
    expect(getFabricWorkflow(result.workflow.id)).toEqual(result.workflow)
    const order = withActionFabricDb(db => ({
      decision: (db.prepare('SELECT rowid FROM fabric_policy_decisions WHERE id=?').get(result.policyDecision.id) as { rowid: number }).rowid,
      workflow: (db.prepare('SELECT rowid FROM fabric_workflows WHERE id=?').get(result.workflow.id) as { rowid: number }).rowid,
    }))
    expect(order.decision).toBeGreaterThan(0)
    expect(order.workflow).toBeGreaterThan(0)
  })

  it('returns the original intent and workflow for an idempotent replay without adding audit events', () => {
    const first = createFabricIntent(intent())
    expect(createFabricIntent(intent({
      idempotencyKey: 'array-payload', input: { messages: ['one', { text: 'two' }] },
    })).workflow.steps[1].input).toMatchObject({ actionInput: { messages: ['one', { text: 'two' }] } })
    const auditCount = listFabricAuditEvents().length
    const replay = createFabricIntent(intent())

    expect(replay).toEqual(first)
    expect(replay.workflow.steps.map(step => step.executionToken))
      .toEqual(first.workflow.steps.map(step => step.executionToken))
    expect(listFabricAuditEvents()).toHaveLength(auditCount)
  })

  it('persists bounded non-sensitive execution payloads but rejects sensitive material', () => {
    configureRole(['internal.twin.preference.set', 'simulator.echo'], 'critical', ['personal-twin', 'simulator'])
    const preference = createFabricIntent(intent({
      capabilityId: 'internal.twin.preference.set', idempotencyKey: 'preference-payload',
      target: { id: 'personal-twin' }, input: { key: 'theme', value: 'dark' },
    }))
    expect(preference.workflow.steps[1].input).toMatchObject({
      actionInput: { key: 'theme', value: 'dark' }, target: { id: 'personal-twin' },
    })

    const auditCount = listFabricAuditEvents().length
    expect(() => createFabricIntent(intent({
      idempotencyKey: 'secret-payload', input: { password: 'do-not-store' },
    }))).toThrow('FABRIC_WORKFLOW_SENSITIVE_PAYLOAD')
    expect(() => createFabricIntent(intent({
      idempotencyKey: 'path-payload', input: { message: 'C:\\Users\\alice\\secret.txt' },
    }))).toThrow('FABRIC_WORKFLOW_SENSITIVE_PAYLOAD')
    expect(() => createFabricIntent(intent({
      idempotencyKey: 'large-payload', input: { message: 'x'.repeat(40_000) },
    }))).toThrow('FABRIC_WORKFLOW_PAYLOAD_LIMIT')
    expect(() => createFabricIntent(intent({
      idempotencyKey: 'nested-secret', input: { profile: { apiKey: 'not-safe' } },
    }))).toThrow('FABRIC_WORKFLOW_SENSITIVE_PAYLOAD')
    let deep: Record<string, unknown> = { value: 'leaf' }
    for (let index = 0; index < 10; index += 1) deep = { child: deep }
    expect(() => createFabricIntent(intent({
      idempotencyKey: 'deep-payload', input: deep,
    }))).toThrow('FABRIC_WORKFLOW_PAYLOAD_LIMIT')
    const getter = vi.fn(() => 'must-not-run')
    const accessor: unknown[] = []
    Object.defineProperty(accessor, '0', { enumerable: true, get: getter })
    accessor.length = 1
    expect(() => createFabricIntent(intent({
      idempotencyKey: 'accessor-payload', input: { items: accessor },
    }))).toThrow('FABRIC_WORKFLOW_INVALID_PAYLOAD')
    expect(getter).not.toHaveBeenCalled()
    const objectGetter = vi.fn(() => 'password')
    const accessorObject: Record<string, unknown> = {}
    Object.defineProperty(accessorObject, 'key', { enumerable: true, get: objectGetter })
    expect(() => createFabricIntent(intent({
      idempotencyKey: 'object-accessor-payload', input: { nested: accessorObject },
    }))).toThrow('FABRIC_WORKFLOW_INVALID_PAYLOAD')
    expect(objectGetter).not.toHaveBeenCalled()
    expect(listFabricAuditEvents()).toHaveLength(auditCount)
  })

  it('rejects normalized credential field variants before creating any durable records', () => {
    const fields = [
      'accessToken', 'refreshToken', 'clientSecret', 'passwordValue', 'bearer', 'token', 'secret',
      'password', 'passphrase', 'privateKey', 'apiKey', 'auth', 'authorization', 'cookie', 'session',
      'credential', 'ACCESS-TOKEN', 'client-secret', 'refresh.token', '访问令牌',
      'APIKEY', 'apikey', 'ACCESSTOKEN', 'clientsecret', 'passwordvalue', 'privatekey',
      'authtoken', 'bearertoken', 'secretvalue', 'credentialdata', 'authenticationtoken',
      'ａｃｃｅｓｓＴｏｋｅｎ',
    ]
    const before = durableCounts()
    for (const [index, field] of fields.entries()) {
      expect(() => createFabricIntent(intent({
        idempotencyKey: `credential-field-${index}`,
        input: { nested: [{ [field]: 'must-not-persist' }] },
      }))).toThrow('FABRIC_WORKFLOW_SENSITIVE_PAYLOAD')
    }
    for (const [index, key] of [
      'refreshToken', 'client-secret', 'auth.token', '私钥', 'authtoken', 'bearertoken',
      'secretvalue', 'credentialdata', 'authenticationtoken', 'ａｃｃｅｓｓＴｏｋｅｎ',
    ].entries()) {
      expect(() => createFabricIntent(intent({
        idempotencyKey: `credential-semantic-${index}`, input: { key, value: 'must-not-persist' },
      }))).toThrow('FABRIC_WORKFLOW_SENSITIVE_PAYLOAD')
    }
    expect(durableCounts()).toEqual(before)
  })

  it('allows localized and unrelated business keys in canonical action payloads', () => {
    const localized = createFabricIntent(intent({
      idempotencyKey: 'localized-safe-payload',
      input: {
        消息: '你好',
        本地化: { 标签: ['健康', { 单位: '公斤' }] },
        authStatus: 'disabled',
        secretary: 'available',
      },
    }))

    expect(localized.workflow.steps[1].input).toMatchObject({
      actionInput: {
        消息: '你好',
        本地化: { 标签: ['健康', { 单位: '公斤' }] },
        authStatus: 'disabled',
        secretary: 'available',
      },
    })
  })

  it('repairs an interrupted creation after policy persistence without duplicating policy audit', () => {
    const request = intent({ idempotencyKey: 'interrupted' })
    const decision = evaluateFabricPolicy(request)
    const policyAuditCount = listFabricAuditEvents({ eventType: 'policy.evaluated' }).length

    const repaired = createFabricIntent(request)
    const replay = createFabricIntent(request)
    expect(repaired.policyDecision.id).toBe(decision.id)
    expect(replay.workflow.id).toBe(repaired.workflow.id)
    expect(listFabricAuditEvents({ eventType: 'policy.evaluated' })).toHaveLength(policyAuditCount)
    expect(withActionFabricDb(db => (db.prepare(
      'SELECT COUNT(*) AS count FROM fabric_workflows WHERE intent_id=?',
    ).get(decision.intentId) as { count: number }).count)).toBe(1)
  })

  it('fails closed when an idempotency replay resolves to a different policy decision', () => {
    const first = createFabricIntent(intent({ idempotencyKey: 'conflicting-replay' }))

    expect(() => createFabricIntent(intent({
      idempotencyKey: 'conflicting-replay', input: { message: 'changed' },
    }))).toThrow('FABRIC_WORKFLOW_POLICY_CONFLICT')
    expect(getFabricWorkflow(first.workflow.id)?.policyDecisionId).toBe(first.policyDecision.id)
  })

  it('creates no executable steps for a denied intent', () => {
    configureRole([])
    const result = createFabricIntent(intent())

    expect(result.policyDecision.outcome).toBe('deny')
    expect(result.workflow).toMatchObject({ state: 'denied', executorId: null, leaseOwner: null, leaseExpiresAt: null })
    expect(result.workflow.steps).toEqual([])
  })

  it('keeps approval-gated work waiting and unleased', () => {
    configureRole(['simulator.counter.increment'], 'none')
    const result = createFabricIntent(intent({
      capabilityId: 'simulator.counter.increment', idempotencyKey: 'waiting',
    }))

    expect(result.policyDecision.outcome).toBe('waiting_user')
    expect(result.workflow).toMatchObject({ state: 'waiting_user', leaseOwner: null, leaseExpiresAt: null })
    expect(result.workflow.steps).toHaveLength(3)
    expect(result.workflow.steps.every(step => step.state === 'waiting_user')).toBe(true)
  })

  it('approves only an unchanged material digest and policy version', () => {
    configureRole(['simulator.counter.increment'], 'none')
    const created = createFabricIntent(intent({
      capabilityId: 'simulator.counter.increment', idempotencyKey: 'approval',
    }))
    const approved = approveFabricWorkflow(created.workflow.id, 'admin-1')
    expect(approved).toMatchObject({ state: 'preparing', version: 1 })
    expect(approved.steps.map(step => step.state)).toEqual(['pending', 'pending', 'pending'])
    expect(approved.steps.map(step => step.executionToken)).toEqual(created.workflow.steps.map(step => step.executionToken))

    const stale = createFabricIntent(intent({
      capabilityId: 'simulator.counter.increment', idempotencyKey: 'stale-approval',
    }))
    withActionFabricDb(db => db.prepare(
      'UPDATE fabric_action_intents SET material_input_digest=? WHERE id=?',
    ).run('0'.repeat(64), stale.intent.id))
    expect(() => approveFabricWorkflow(stale.workflow.id, 'admin-1')).toThrow('FABRIC_WORKFLOW_APPROVAL_STALE')
    expect(getFabricWorkflow(stale.workflow.id)?.state).toBe('waiting_user')

    const staleVersion = createFabricIntent(intent({
      capabilityId: 'simulator.counter.increment', idempotencyKey: 'stale-version',
    }))
    withActionFabricDb(db => db.prepare(
      'UPDATE fabric_policy_decisions SET policy_version=policy_version+1 WHERE id=?',
    ).run(staleVersion.policyDecision.id))
    expect(() => approveFabricWorkflow(staleVersion.workflow.id, 'admin-1'))
      .toThrow('FABRIC_WORKFLOW_APPROVAL_STALE')
  })

  it('uses explicit legal transitions for rejection, cancellation, retry, and compensation', () => {
    configureRole(['simulator.counter.increment'], 'none')
    const waiting = createFabricIntent(intent({
      capabilityId: 'simulator.counter.increment', idempotencyKey: 'reject',
    }))
    expect(rejectFabricWorkflow(waiting.workflow.id, 'admin-1', 'not wanted').state).toBe('cancelled')
    expect(() => approveFabricWorkflow(waiting.workflow.id, 'admin-1')).toThrow('FABRIC_WORKFLOW_INVALID_TRANSITION')

    configureRole(['simulator.echo'])
    const active = createFabricIntent(intent({ idempotencyKey: 'cancel' }))
    expect(cancelFabricWorkflow(active.workflow.id, 'admin-1', 'stop').state).toBe('cancelled')
    expect(() => retryFabricWorkflow(active.workflow.id, 'admin-1')).toThrow('FABRIC_WORKFLOW_NOT_RETRYABLE')

    const failed = createFabricIntent(intent({ idempotencyKey: 'retry' }))
    forceWorkflowState(failed.workflow.id, 'failed')
    const retried = retryFabricWorkflow(failed.workflow.id, 'admin-1')
    expect(retried).toMatchObject({ state: 'retrying', version: 1 })
    expect(retried.steps[0]).toMatchObject({ state: 'pending', executionToken: failed.workflow.steps[0].executionToken })

    const irreversible = createFabricIntent(intent({ idempotencyKey: 'not-reversible' }))
    forceWorkflowState(irreversible.workflow.id, 'succeeded')
    expect(() => requestFabricCompensation(irreversible.workflow.id, 'admin-1', 'undo'))
      .toThrow('FABRIC_WORKFLOW_NOT_COMPENSATABLE')

  })

  it.each([
    ['allow', 'critical', ['internal.twin.preference.set'], 'preparing', 'compensating'],
    ['waiting_user', 'none', ['internal.twin.preference.set'], 'waiting_user', 'compensating'],
    ['deny', 'critical', [], 'denied', 'succeeded'],
  ] as const)('creates one independently policy-checked compensation workflow for %s', (
    _outcome, approval, allow, compensationState, originalState,
  ) => {
    configureRole(['internal.twin.preference.set'], 'critical', ['personal-twin'])
    const original = createFabricIntent(intent({
      capabilityId: 'internal.twin.preference.set', idempotencyKey: `original-${_outcome}`,
      target: { id: 'personal-twin' }, input: { key: 'theme', value: 'dark' },
    }))
    forceWorkflowState(original.workflow.id, 'succeeded')

    // Upgrade the current registry contract after the original workflow captured version 1.
    const current = getFabricCapability('internal.twin.preference.set')!
    updateFabricCapability(current.id, { version: 2, description: `${current.description} v2` })
    bindFabricExecutorCapability('internal-twin', current.id, 2, getFabricCapability(current.id)!.contractDigest)
    configureRole([...allow], approval, ['personal-twin'])

    const requested = requestFabricCompensation(original.workflow.id, 'admin-1', 'restore prior value')
    expect(requested.state).toBe(originalState)
    expect(requested.compensationIntentId).toMatch(/^intent-/)
    expect(requested.compensationIntentId).not.toBe(original.intent.id)
    const compensation = withActionFabricDb(db => db.prepare(
      'SELECT id FROM fabric_workflows WHERE intent_id=?',
    ).get(requested.compensationIntentId!) as { id: string })
    expect(getFabricWorkflow(compensation.id)).toMatchObject({
      state: compensationState,
      intent: { capabilityId: 'internal.twin.preference.set' },
    })
    const replay = requestFabricCompensation(original.workflow.id, 'admin-1', 'restore prior value')
    expect(replay.compensationIntentId).toBe(requested.compensationIntentId)
    expect(withActionFabricDb(db => (db.prepare(
      'SELECT COUNT(*) AS count FROM fabric_action_intents WHERE id=?',
    ).get(requested.compensationIntentId!) as { count: number }).count)).toBe(1)
  })

  it('recovers an orphaned compensation workflow without duplicating it', () => {
    configureRole(['internal.twin.preference.set'], 'critical', ['personal-twin'])
    const original = createFabricIntent(intent({
      capabilityId: 'internal.twin.preference.set', idempotencyKey: 'orphan-compensation',
      target: { id: 'personal-twin' }, input: { key: 'theme', value: 'dark' },
    }))
    forceWorkflowState(original.workflow.id, 'succeeded')
    withActionFabricDb(db => db.exec(`CREATE TRIGGER fail_compensation_link BEFORE INSERT ON fabric_outbox
      WHEN NEW.topic='fabric.workflow.compensation_requested'
      BEGIN SELECT RAISE(ABORT, 'compensation link unavailable'); END`))

    expect(() => requestFabricCompensation(original.workflow.id, 'admin-1', 'undo'))
      .toThrow(/compensation link unavailable/)
    expect(getFabricWorkflow(original.workflow.id)).toMatchObject({ state: 'succeeded', compensationIntentId: null })
    const orphan = withActionFabricDb(db => db.prepare(
      'SELECT id FROM fabric_action_intents WHERE idempotency_key=?',
    ).get(`compensation:${original.workflow.id}`) as { id: string })
    withActionFabricDb(db => db.exec('DROP TRIGGER fail_compensation_link'))

    const recovered = requestFabricCompensation(original.workflow.id, 'admin-1', 'undo')
    expect(recovered.compensationIntentId).toBe(orphan.id)
    expect(withActionFabricDb(db => (db.prepare(
      'SELECT COUNT(*) AS count FROM fabric_action_intents WHERE idempotency_key=?',
    ).get(`compensation:${original.workflow.id}`) as { count: number }).count)).toBe(1)
  })

  it('writes each transition audit and outbox atomically', () => {
    const created = createFabricIntent(intent())
    const beforeAudit = listFabricAuditEvents().length
    withActionFabricDb(db => db.exec(`CREATE TRIGGER fail_workflow_outbox BEFORE INSERT ON fabric_outbox
      WHEN NEW.topic='fabric.workflow.transitioned' BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END`))

    expect(() => cancelFabricWorkflow(created.workflow.id, 'admin-1', 'stop')).toThrow(/outbox unavailable/)
    expect(getFabricWorkflow(created.workflow.id)?.state).toBe('preparing')
    expect(listFabricAuditEvents()).toHaveLength(beforeAudit)
  })

  it('returns bounded deterministic workflow pages', () => {
    const ids = Array.from({ length: 4 }, (_, index) =>
      createFabricIntent(intent({ idempotencyKey: `list-${index}` })).workflow.id)

    const first = listFabricWorkflows({ limit: 2 })
    const second = listFabricWorkflows({ limit: 2, cursor: first[1].id })
    expect(first.map(item => item.id)).toEqual(ids.slice().reverse().slice(0, 2))
    expect(second.map(item => item.id)).toEqual(ids.slice().reverse().slice(2))
    expect(() => listFabricWorkflows({ limit: 0 })).toThrow('FABRIC_WORKFLOW_INVALID_LIMIT')
    expect(listFabricWorkflows({ limit: 1000 })).toHaveLength(4)
  })
})

function configureRole(
  allow: string[],
  requireApprovalAbove: 'none' | 'critical' = 'critical',
  allowedTargets = ['simulator'],
): void {
  updateAssistantRole('health-manager', {
    enabled: true,
    capabilityScope: { allow, deny: [], enforcement: 'action_fabric_v1' },
    decisionAuthority: { maxRisk: 'critical', requireApprovalAbove, allowedTargets },
    spendingLimits: { currency: null, perAction: 0, daily: 0 },
  })
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    capabilityId: 'simulator.echo', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
    idempotencyKey: 'intent-1', goal: 'echo safely', target: { id: 'simulator' }, input: { message: 'hello' },
    constraints: {}, rationale: 'requested by user', ...overrides,
  }
}

function forceWorkflowState(id: string, state: string): void {
  withActionFabricDb(db => db.prepare(
    'UPDATE fabric_workflows SET state=?, completed_at=? WHERE id=?',
  ).run(state, new Date().toISOString(), id))
}

function durableCounts(): Record<string, number> {
  return withActionFabricDb(db => Object.fromEntries([
    'fabric_action_intents', 'fabric_policy_decisions', 'fabric_workflows', 'fabric_steps',
    'fabric_audit_events', 'fabric_outbox',
  ].map(table => [table, (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count])))
}

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFabricWorkflow,
  cancelFabricWorkflow,
  createFabricIntent,
  ensureBuiltInFabricRegistry,
  evaluateFabricPolicy,
  getFabricIntent,
  getFabricWorkflow,
  listFabricAuditEvents,
  listFabricWorkflows,
  rejectFabricWorkflow,
  requestFabricCompensation,
  retryFabricWorkflow,
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
    expect(result.workflow.steps).toEqual([
      expect.objectContaining({ ordinal: 0, kind: 'execute', state: 'pending', executorId: 'simulator-main' }),
    ])
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
    const auditCount = listFabricAuditEvents().length
    const replay = createFabricIntent(intent())

    expect(replay).toEqual(first)
    expect(listFabricAuditEvents()).toHaveLength(auditCount)
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
    expect(result.workflow.steps).toEqual([
      expect.objectContaining({ ordinal: 0, state: 'waiting_user' }),
    ])
  })

  it('approves only an unchanged material digest and policy version', () => {
    configureRole(['simulator.counter.increment'], 'none')
    const created = createFabricIntent(intent({
      capabilityId: 'simulator.counter.increment', idempotencyKey: 'approval',
    }))
    const approved = approveFabricWorkflow(created.workflow.id, 'admin-1')
    expect(approved).toMatchObject({ state: 'preparing', version: 1 })
    expect(approved.steps[0]).toMatchObject({ state: 'pending', executionToken: created.workflow.steps[0].executionToken })

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

    configureRole(['internal.twin.preference.set'], 'critical', ['personal-twin'])
    const reversible = createFabricIntent(intent({
      capabilityId: 'internal.twin.preference.set', idempotencyKey: 'compensate', target: { id: 'personal-twin' },
    }))
    forceWorkflowState(reversible.workflow.id, 'succeeded')
    expect(requestFabricCompensation(reversible.workflow.id, 'admin-1', 'undo').state).toBe('compensating')
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

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFabricWorkflow,
  bindFabricExecutorCapability,
  createFabricIntent,
  createSimulatorExecutorAdapter,
  ensureBuiltInFabricRegistry,
  getFabricWorkflow,
  listFabricAuditEvents,
  processActionFabricOnce,
  retryFabricWorkflow,
  registerFabricExecutorAdapter,
  requestFabricCompensation,
  resolveFabricExecutor,
  setFabricEmergencyStop,
  startActionFabricWorker,
  stopActionFabricWorker,
  unregisterFabricExecutorAdapter,
  updateFabricCapability,
  updateFabricExecutorHealth,
  withActionFabricDb,
  type FabricExecutionContext,
  type FabricExecutorAdapter,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  clearFabricAuthorizationProvider,
  registerFabricAuthorizationProvider,
} from '../../packages/server/src/services/hermes/action-fabric/authorization'
import { ensureBuiltInAssistantRoles, updateAssistantRole } from '../../packages/server/src/services/hermes/personal-twin'
import { logger } from '../../packages/server/src/services/logger'

describe('Action Fabric durable worker', () => {
  const originalHome = process.env.HERMES_HOME
  const originalAuditKey = process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
  let home = ''
  const base = new Date('2026-07-12T01:00:00.000Z')

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hwui-fabric-worker-'))
    process.env.HERMES_HOME = home
    process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = 'worker-test-managed-audit-key-at-least-32-bytes'
    vi.useFakeTimers()
    vi.setSystemTime(base)
    ensureBuiltInAssistantRoles()
    ensureBuiltInFabricRegistry()
    updateFabricExecutorHealth('simulator-main', 'healthy', {})
    updateFabricExecutorHealth('internal-twin', 'healthy', {})
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: { allow: ['simulator.echo', 'simulator.counter.increment', 'internal.twin.preference.set'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'critical', allowedTargets: ['simulator', 'personal-twin'] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
    unregisterFabricExecutorAdapter('simulator-main')
    unregisterFabricExecutorAdapter('internal-twin')
    unregisterFabricExecutorAdapter('health-source')
    unregisterFabricExecutorAdapter('health-shadow')
    clearFabricAuthorizationProvider()
  })

  afterEach(async () => {
    await stopActionFabricWorker()
    unregisterFabricExecutorAdapter('simulator-main')
    unregisterFabricExecutorAdapter('internal-twin')
    unregisterFabricExecutorAdapter('health-source')
    unregisterFabricExecutorAdapter('health-shadow')
    clearFabricAuthorizationProvider()
    vi.useRealTimers()
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (originalAuditKey === undefined) delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    else process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = originalAuditKey
    rmSync(home, { recursive: true, force: true })
  })

  it('persists prepare, execute and verify checkpoints before advancing', async () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    const workflow = create().workflow

    await expect(processActionFabricOnce({ workerId: 'worker-a', now: base })).resolves.toMatchObject({ processed: true, phase: 'prepare' })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('executing')
    expect(getFabricWorkflow(workflow.id)?.steps[0].state).toBe('succeeded')
    await expect(processActionFabricOnce({ workerId: 'worker-a', now: plus(1) })).resolves.toMatchObject({ phase: 'execute' })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('verifying')
    expect(getFabricWorkflow(workflow.id)?.steps.slice(0, 2).map(step => step.state)).toEqual(['succeeded', 'succeeded'])
    await expect(processActionFabricOnce({ workerId: 'worker-a', now: plus(2) })).resolves.toMatchObject({ phase: 'verify' })
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'succeeded', completedAt: plus(2).toISOString() })
    expect(getFabricWorkflow(workflow.id)!.steps.map(step => step.state)).toEqual(['succeeded', 'succeeded', 'succeeded'])
  })

  it('revalidates live standing authorization before leasing execution', async () => {
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: { allow: ['health.source.sync'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'critical',
        allowedTargets: ['health:connector:s400'] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
    registerFabricAuthorizationProvider({
      id: 'worker-live-authorization', version: 1,
      authorize: request => ({ authorizationVersion: 2, expiresAt: '2099-01-01T00:00:00.000Z',
        grantedRequirements: [...request.requirements] }),
    })
    let prepared = 0
    registerFabricExecutorAdapter(adapter({
      id: 'health-source', type: 'connector',
      prepare: async context => { prepared += 1; return success('prepared', context) },
    }))
    const workflow = createFabricIntent({
      capabilityId: 'health.source.sync', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'live-auth-revalidation', goal: 'sync source', environments: ['production'],
      target: { kind: 'health_connector', connectorId: 's400' }, constraints: {}, rationale: 'test',
      input: { schemaVersion: 1, connectorId: 's400', requestedAt: '2026-07-12T01:00:00.000Z' },
    }).workflow
    clearFabricAuthorizationProvider()

    await processActionFabricOnce({ now: base })
    expect(prepared).toBe(0)
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'waiting_user',
      lastErrorCode: expect.stringMatching(/AUTHORIZATION/) })
  })

  it('does not execute an approved production action after its standing evidence is revoked', async () => {
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: { allow: ['health.source.sync'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'none',
        allowedTargets: ['health:connector:s400'] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
    let authorized = true
    registerFabricAuthorizationProvider({
      id: 'worker-revocable-authorization', version: 1,
      authorize: request => authorized
        ? { authorizationVersion: 4, expiresAt: '2099-01-01T00:00:00.000Z',
            grantedRequirements: [...request.requirements] }
        : null,
    })
    let prepared = 0
    registerFabricExecutorAdapter(adapter({
      id: 'health-source', type: 'connector',
      prepare: async context => { prepared += 1; return success('prepared', context) },
    }))
    const created = createFabricIntent({
      capabilityId: 'health.source.sync', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'approved-auth-revocation', goal: 'sync source', environments: ['production'],
      target: { kind: 'health_connector', connectorId: 's400' }, constraints: {}, rationale: 'test',
      input: { schemaVersion: 1, connectorId: 's400', requestedAt: '2026-07-12T01:00:00.000Z' },
    })
    expect(created.policyDecision).toMatchObject({ outcome: 'waiting_user',
      policySnapshot: { authorizationMode: 'standing_provider', standingAuthorizationMode: 'standing_provider',
        approvalMode: 'per_action', authorizationEvidence: { authorizationVersion: 4 } } })
    expect(approveFabricWorkflow(created.workflow.id, 'user-1').state).toBe('preparing')
    authorized = false

    await processActionFabricOnce({ now: base })
    expect(prepared).toBe(0)
    expect(getFabricWorkflow(created.workflow.id)).toMatchObject({ state: 'waiting_user',
      lastErrorCode: 'FABRIC_POLICY_STALE_AUTHORIZATION' })
  })

  it('fails legacy production snapshots closed when they lack captured standing evidence', async () => {
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: { allow: ['health.source.sync'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'critical',
        allowedTargets: ['health:connector:s400'] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
    registerFabricAuthorizationProvider({
      id: 'worker-legacy-authorization', version: 1,
      authorize: request => ({ authorizationVersion: 1, expiresAt: '2099-01-01T00:00:00.000Z',
        grantedRequirements: [...request.requirements] }),
    })
    let prepared = 0
    registerFabricExecutorAdapter(adapter({
      id: 'health-source', type: 'connector',
      prepare: async context => { prepared += 1; return success('prepared', context) },
    }))
    const request = {
      capabilityId: 'health.source.sync', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'legacy-production-auth', goal: 'sync source', environments: ['production'] as Array<'production'>,
      target: { kind: 'health_connector', connectorId: 's400' }, constraints: {}, rationale: 'test',
      input: { schemaVersion: 1, connectorId: 's400', requestedAt: '2026-07-12T01:00:00.000Z' },
    }
    const workflow = createFabricIntent(request).workflow
    withActionFabricDb(db => {
      const row = db.prepare('SELECT policy_snapshot_json FROM fabric_policy_decisions WHERE id=?')
        .get(workflow.policyDecisionId!) as { policy_snapshot_json: string }
      const snapshot = JSON.parse(row.policy_snapshot_json) as Record<string, unknown>
      delete snapshot.standingAuthorizationRequired
      delete snapshot.standingAuthorizationMode
      delete snapshot.approvalMode
      db.prepare('UPDATE fabric_policy_decisions SET policy_snapshot_json=? WHERE id=?')
        .run(JSON.stringify(snapshot), workflow.policyDecisionId!)
    })
    const replay = createFabricIntent(request)
    expect(replay.workflow.id).toBe(workflow.id)
    expect(replay.policyDecision.id).toBe(workflow.policyDecisionId)
    withActionFabricDb(db => {
      const row = db.prepare('SELECT policy_snapshot_json FROM fabric_policy_decisions WHERE id=?')
        .get(workflow.policyDecisionId!) as { policy_snapshot_json: string }
      const snapshot = JSON.parse(row.policy_snapshot_json) as Record<string, unknown>
      snapshot.authorizationMode = 'per_action'
      snapshot.authorizationEvidence = null
      db.prepare('UPDATE fabric_policy_decisions SET policy_snapshot_json=? WHERE id=?')
        .run(JSON.stringify(snapshot), workflow.policyDecisionId!)
    })

    await processActionFabricOnce({ now: base })
    expect(prepared).toBe(0)
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'waiting_user',
      lastErrorCode: 'FABRIC_POLICY_STALE_AUTHORIZATION' })
  })

  it('uses an exclusive live lease and recovers only after expiry', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    registerFabricExecutorAdapter(adapter({ prepare: async context => {
      calls += 1
      if (calls === 1) await gate
      return success('prepared', context)
    } }))
    const workflow = create().workflow
    const first = processActionFabricOnce({ workerId: 'worker-a', now: base })
    await vi.waitFor(() => expect(getFabricWorkflow(workflow.id)?.leaseOwner).toBe('worker-a'))

    await expect(processActionFabricOnce({ workerId: 'worker-b', now: plus(1) })).resolves.toMatchObject({ processed: false })
    await expect(processActionFabricOnce({ workerId: 'worker-b', now: plus(31) })).resolves.toMatchObject({ processed: true })
    release()
    await first
    expect(getFabricWorkflow(workflow.id)?.state).toBe('executing')
    expect(listFabricAuditEvents({ aggregateId: workflow.id }).some(event => event.eventType === 'workflow.lease_recovered')).toBe(true)
  })

  it('rejects a result that finishes after its lease without a takeover', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let finish = base
    registerFabricExecutorAdapter(adapter({ prepare: async context => { await gate; return success('prepared', context) } }))
    const workflow = create('expired-finish').workflow
    const cycle = processActionFabricOnce({ workerId: 'worker-a', now: base, clock: () => finish })
    await vi.waitFor(() => expect(getFabricWorkflow(workflow.id)?.leaseOwner).toBe('worker-a'))
    finish = plus(31)
    release()

    await expect(cycle).resolves.toMatchObject({ stale: true })
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'preparing', leaseOwner: 'worker-a' })
    expect(getFabricWorkflow(workflow.id)?.steps[0].state).toBe('running')
  })

  it('samples the single finish clock from the audited commit and validates both lease outcomes', async () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    const expired = create('lock-expired').workflow
    let sampledInsideCommit = false
    const expiredResult = await processActionFabricOnce({
      workerId: 'worker-a', now: base,
      clock: () => {
        sampledInsideCommit = new Error().stack?.includes('commitClaim') === true
        return plus(31)
      },
    })
    expect(sampledInsideCommit).toBe(true)
    expect(expiredResult).toMatchObject({ stale: true })
    expect(getFabricWorkflow(expired.id)?.steps[0].state).toBe('running')
    withActionFabricDb(db => {
      db.prepare("UPDATE fabric_workflows SET state='waiting_user',lease_owner=NULL,lease_expires_at=NULL WHERE id=?")
        .run(expired.id)
      db.prepare("UPDATE fabric_steps SET state='waiting_user' WHERE workflow_id=? AND state='running'").run(expired.id)
    })

    const healthy = create('lock-healthy').workflow
    let samples = 0
    const healthyResult = await processActionFabricOnce({
      workerId: 'worker-b', now: plus(32), clock: () => { samples += 1; return plus(33) },
    })
    expect(samples).toBe(1)
    expect(healthyResult.stale).toBeUndefined()
    expect(getFabricWorkflow(healthy.id)?.steps[0].state).toBe('succeeded')
  })

  it('recovers an expired non-idempotent execute by verification without reinvoking the side effect', async () => {
    let executes = 0
    let verifies = 0
    registerFabricExecutorAdapter(adapter({
      execute: async context => { executes += 1; return success('succeeded', context) },
      verify: async context => { verifies += 1; return success('verified', context) },
    }))
    const workflow = create('non-idempotent-recovery').workflow
    await processActionFabricOnce({ now: base })
    mutateCapturedContract(workflow.id, contract => { contract.idempotency = 'none' })
    withActionFabricDb(db => {
      db.prepare(`UPDATE fabric_workflows SET state='executing',lease_owner='crashed',lease_expires_at=? WHERE id=?`)
        .run(plus(-1).toISOString(), workflow.id)
      db.prepare(`UPDATE fabric_steps SET state='running',attempt=1,started_at=?
        WHERE workflow_id=? AND kind='execute'`).run(base.toISOString(), workflow.id)
    })

    await processActionFabricOnce({ workerId: 'recovery', now: base })
    await processActionFabricOnce({ workerId: 'recovery', now: plus(1) })
    expect({ executes, verifies }).toEqual({ executes: 0, verifies: 1 })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('succeeded')
  })

  it('never invokes an already verified step again after restart', async () => {
    let verifies = 0
    registerFabricExecutorAdapter(adapter({ verify: async context => { verifies += 1; return success('verified', context) } }))
    const workflow = create().workflow
    await runCycles(3)
    expect(getFabricWorkflow(workflow.id)?.state).toBe('succeeded')
    await processActionFabricOnce({ workerId: 'restarted', now: plus(60) })
    expect(verifies).toBe(1)
  })

  it('schedules bounded exponential retries and dead-letters on exhaustion', async () => {
    registerFabricExecutorAdapter(adapter({ execute: async () => failure('temporary_failure', 'TEMPORARY', true) }))
    const workflow = create('retry').workflow
    await processActionFabricOnce({ now: base })
    await processActionFabricOnce({ now: plus(1) })
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'retrying', attempt: 1, retryAt: plus(2).toISOString() })
    await expect(processActionFabricOnce({ now: plus(1) })).resolves.toMatchObject({ processed: false })
    await processActionFabricOnce({ now: plus(2) })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('executing')
    await processActionFabricOnce({ now: plus(3) })
    await processActionFabricOnce({ now: plus(7) })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('executing')
    await processActionFabricOnce({ now: plus(8) })
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'dead_letter', attempt: 3, lastErrorCode: 'TEMPORARY' })
  })

  it('reactivates a user retry at the failed prepare phase before downstream steps', async () => {
    let prepares = 0
    registerFabricExecutorAdapter(adapter({ prepare: async context => {
      prepares += 1
      return prepares === 1 ? failure('failed', 'PREPARE_FAILED') : success('prepared', context)
    } }))
    const workflow = create('prepare-retry').workflow
    await processActionFabricOnce({ now: base })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('dead_letter')
    expect(retryFabricWorkflow(workflow.id, 'admin-1').state).toBe('retrying')

    await processActionFabricOnce({ now: plus(1) })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('preparing')
    await processActionFabricOnce({ now: plus(2) })
    expect(prepares).toBe(2)
    expect(getFabricWorkflow(workflow.id)?.state).toBe('executing')
  })

  it('rejects manual execute retry when the captured contract is non-idempotent and unverifiable', () => {
    const workflow = create('unsafe-manual-retry').workflow
    mutateCapturedContract(workflow.id, contract => {
      contract.idempotency = 'none'
      contract.verificationStrategy = 'none'
    })
    withActionFabricDb(db => {
      db.prepare("UPDATE fabric_workflows SET state='dead_letter' WHERE id=?").run(workflow.id)
      db.prepare("UPDATE fabric_steps SET state='failed' WHERE workflow_id=? AND kind='execute'").run(workflow.id)
    })
    expect(() => retryFabricWorkflow(workflow.id, 'admin-1')).toThrow('FABRIC_WORKFLOW_NOT_RETRYABLE')
  })

  it('advances due retry bookkeeping without starving normal executable work', async () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    const retrying = create('fair-retry').workflow
    withActionFabricDb(db => {
      db.prepare("UPDATE fabric_workflows SET state='retrying',retry_at=?,attempt=1 WHERE id=?")
        .run(base.toISOString(), retrying.id)
      db.prepare("UPDATE fabric_steps SET state='failed' WHERE workflow_id=? AND kind='execute'").run(retrying.id)
    })
    const normal = create('fair-normal').workflow

    await processActionFabricOnce({ now: base })
    expect(getFabricWorkflow(retrying.id)?.state).toBe('executing')
    expect(getFabricWorkflow(normal.id)?.steps[0].state).toBe('succeeded')
  })

  it('moves unknown outcomes to waiting-user without retry', async () => {
    let unknown = true
    registerFabricExecutorAdapter(adapter({ execute: async context => {
      if (unknown) { unknown = false; return failure('unknown', 'OUTCOME_UNKNOWN') }
      return success('succeeded', context)
    } }))
    const workflow = create('unknown').workflow
    await runCycles(2)
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'waiting_user', attempt: 0, retryAt: null })
    expect(retryFabricWorkflow(workflow.id, 'admin-1').state).toBe('verifying')
    await processActionFabricOnce({ now: plus(2) })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('succeeded')
  })

  it('allows manual verification retry for verify-unknown but not policy waiting', async () => {
    let unknown = true
    registerFabricExecutorAdapter(adapter({ verify: async context => {
      if (unknown) { unknown = false; return failure('unknown', 'VERIFY_UNKNOWN') }
      return success('verified', context)
    } }))
    const workflow = create('verify-unknown').workflow
    await runCycles(3)
    expect(getFabricWorkflow(workflow.id)?.state).toBe('waiting_user')
    expect(retryFabricWorkflow(workflow.id, 'admin-1').state).toBe('verifying')
    await processActionFabricOnce({ now: plus(3) })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('succeeded')

    const policyWaiting = create('policy-waiting').workflow
    withActionFabricDb(db => {
      db.prepare("UPDATE fabric_workflows SET state='waiting_user',last_error_code=NULL WHERE id=?")
        .run(policyWaiting.id)
      db.prepare("UPDATE fabric_steps SET state='waiting_user' WHERE workflow_id=?").run(policyWaiting.id)
    })
    expect(getFabricWorkflow(policyWaiting.id)?.state).toBe('waiting_user')
    expect(() => retryFabricWorkflow(policyWaiting.id, 'admin-1')).toThrow('FABRIC_WORKFLOW_NOT_RETRYABLE')

    const compensationRecovery = createInternal('compensation-policy-repaired').workflow
    withActionFabricDb(db => {
      db.prepare(`UPDATE fabric_workflows SET state='waiting_user',last_error_code='FABRIC_COMPENSATION_POLICY_UNAVAILABLE'
        WHERE id=?`).run(compensationRecovery.id)
      db.prepare("UPDATE fabric_steps SET state='failed' WHERE workflow_id=? AND kind='verify'")
        .run(compensationRecovery.id)
    })
    expect(retryFabricWorkflow(compensationRecovery.id, 'admin-1').state).toBe('verifying')

  })

  it('allows a worker contract failure to resume only after its captured snapshot is repaired', async () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    const workflow = create('contract-repaired').workflow
    mutateCapturedContract(workflow.id, contract => {
      delete contract.idempotency
      delete contract.verificationStrategy
    })
    await processActionFabricOnce({ now: base })
    expect(getFabricWorkflow(workflow.id)).toMatchObject({
      state: 'waiting_user', lastErrorCode: 'FABRIC_WORKER_CONTRACT_MISSING',
    })
    mutateCapturedContract(workflow.id, contract => {
      contract.idempotency = 'supported'
      contract.verificationStrategy = 'output_equals_input'
    })
    expect(retryFabricWorkflow(workflow.id, 'admin-1').state).toBe('preparing')
  })

  it('treats verification mismatch according to the non-reversible contract', async () => {
    registerFabricExecutorAdapter(adapter({ verify: async () => failure('mismatch', 'VERIFY_MISMATCH') }))
    const workflow = create('mismatch').workflow
    await runCycles(3)
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'retrying', attempt: 1, lastErrorCode: 'VERIFY_MISMATCH' })
    await processActionFabricOnce({ now: plus(3) })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('verifying')
    await processActionFabricOnce({ now: plus(4) })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('retrying')
  })

  it('checkpoints a reversible verification mismatch before compensation', async () => {
    let originalWorkflowId = ''
    registerFabricExecutorAdapter(adapter({
      id: 'internal-twin', type: 'internal',
      verify: async context => context.workflowId === originalWorkflowId
        ? failure('mismatch', 'VERIFY_MISMATCH') : success('verified', context),
    }))
    const workflow = createFabricIntent({
      capabilityId: 'internal.twin.preference.set', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'reversible-mismatch', goal: 'set safely', target: { id: 'personal-twin' },
      input: { domain: 'preferences', key: 'theme', value: 'dark' }, constraints: {}, rationale: 'test',
    }).workflow
    originalWorkflowId = workflow.id
    seedReservedBudget(workflow.id)

    await runCycles(3)
    const parent = getFabricWorkflow(workflow.id)!
    expect(parent.state).toBe('compensating')
    expect(parent.steps[2]).toMatchObject({ state: 'failed', lastErrorCode: 'VERIFY_MISMATCH' })
    expect(parent.compensationIntentId).toMatch(/^intent-/)
    const child = withActionFabricDb(db => db.prepare('SELECT id,state FROM fabric_workflows WHERE intent_id=?')
      .get(parent.compensationIntentId!) as { id: string; state: string })
    expect(child).toMatchObject({ state: 'preparing' })
    expect(getFabricWorkflow(child.id)?.steps[0].input.actionInput).toMatchObject({ originalWorkflowId: workflow.id })
    await processActionFabricOnce({ now: plus(3) })
    await processActionFabricOnce({ now: plus(4) })
    await processActionFabricOnce({ now: plus(5) })
    await processActionFabricOnce({ now: plus(6) })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('compensated')
    expect(budgetStatus(workflow.id)).toBe('released')
    const released = listFabricAuditEvents({ aggregateId: workflow.id })
      .filter(event => event.eventType === 'budget.released').length
    await processActionFabricOnce({ now: plus(7) })
    expect(listFabricAuditEvents({ aggregateId: workflow.id })
      .filter(event => event.eventType === 'budget.released')).toHaveLength(released)
  })

  it('never creates a restore compensation for a sandbox shadow mismatch', async () => {
    configureHealthPlanRole()
    registerFabricExecutorAdapter(adapter({
      id: 'health-shadow', type: 'connector',
      execute: async () => success('succeeded', { executionOutput: {
        schemaVersion: 1, planId: 'daily-plan', previousVersion: 3, newVersion: 4,
        previousDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64),
      } } as never),
      verify: async () => failure('mismatch', 'VERIFY_MISMATCH'),
    }))
    const workflow = createHealthPlan('shadow-mismatch', ['sandbox']).workflow
    await runCycles(3)

    expect(getFabricWorkflow(workflow.id)).toMatchObject({ compensationIntentId: null })
    expect(getFabricWorkflow(workflow.id)?.state).not.toBe('compensating')
    expect(withActionFabricDb(db => (db.prepare(`SELECT COUNT(*) count FROM fabric_action_intents
      WHERE idempotency_key=?`).get(`compensation:${workflow.id}`) as { count: number }).count)).toBe(0)
  })

  it('does not advertise or accept manual compensation after a successful sandbox shadow run', async () => {
    configureHealthPlanRole()
    registerFabricExecutorAdapter(adapter({
      id: 'health-shadow', type: 'connector',
      execute: async () => success('succeeded', { executionOutput: {
        schemaVersion: 1, planId: 'daily-plan', previousVersion: 3, newVersion: 4,
        previousDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64),
      } } as never),
    }))
    const workflow = createHealthPlan('shadow-success', ['sandbox']).workflow
    await runCycles(3)
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'succeeded',
      availableActions: { compensate: false } })
    expect(() => requestFabricCompensation(workflow.id, 'user-1', 'manual restore'))
      .toThrow('FABRIC_WORKFLOW_NOT_COMPENSATABLE')
  })

  it('builds a live plan mismatch restore exclusively from original input and successful output', async () => {
    configureHealthPlanRole()
    let originalWorkflowId = ''
    registerFabricExecutorAdapter(adapter({
      id: 'health-plan', type: 'internal',
      execute: async context => context.capabilityId === 'health.plan.adjust'
        ? success('succeeded', { executionOutput: {
          schemaVersion: 1, planId: 'daily-plan', previousVersion: 3, newVersion: 4,
          previousDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64),
        } } as never) : success('succeeded', context),
      verify: async context => context.workflowId === originalWorkflowId
        ? failure('mismatch', 'VERIFY_MISMATCH') : success('verified', context),
    }))
    const workflow = createHealthPlan('live-mismatch', ['internal']).workflow
    originalWorkflowId = workflow.id
    await runCycles(3)

    const parent = getFabricWorkflow(workflow.id)!
    expect(parent).toMatchObject({ state: 'compensating', compensationIntentId: expect.stringMatching(/^intent-/) })
    const child = withActionFabricDb(db => db.prepare('SELECT id FROM fabric_workflows WHERE intent_id=?')
      .get(parent.compensationIntentId!) as { id: string })
    expect(getFabricWorkflow(child.id)?.steps[0].input).toMatchObject({
      target: { kind: 'health_plan', planId: 'daily-plan' },
      actionInput: {
        schemaVersion: 1, planId: 'daily-plan', expectedCurrentVersion: 4,
        restoreVersion: 3, restoreDigest: 'a'.repeat(64),
      },
    })
  })

  it.each([
    ['deny', 'failed', 'denied'],
    ['waiting', 'waiting_user', 'waiting_user'],
  ] as const)('applies an independent %s policy decision to mismatch compensation', async (mode, parentState, childState) => {
    registerFabricExecutorAdapter(adapter({
      id: 'internal-twin', type: 'internal', verify: async () => failure('mismatch', 'VERIFY_MISMATCH'),
    }))
    const workflow = createInternal(`compensation-${mode}`).workflow
    seedReservedBudget(workflow.id)
    await runCycles(2)
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: mode === 'deny'
        ? { allow: [], deny: ['internal.twin.preference.set'], enforcement: 'action_fabric_v1' }
        : { allow: ['internal.twin.preference.set'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: mode === 'waiting' ? 'none' : 'critical',
        allowedTargets: ['personal-twin'] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
    await processActionFabricOnce({ now: plus(2) })

    const parent = getFabricWorkflow(workflow.id)!
    expect(parent.state).toBe(parentState)
    const child = withActionFabricDb(db => db.prepare('SELECT state FROM fabric_workflows WHERE intent_id=?')
      .get(parent.compensationIntentId!) as { state: string })
    expect(child.state).toBe(childState)
    await processActionFabricOnce({ now: plus(3) })
    expect(budgetStatus(workflow.id)).toBe(mode === 'deny' ? 'committed' : 'reserved')
  })

  it('rolls back child creation and creates exactly one child after lease recovery', async () => {
    registerFabricExecutorAdapter(adapter({
      id: 'internal-twin', type: 'internal', verify: async () => failure('mismatch', 'VERIFY_MISMATCH'),
    }))
    const workflow = createInternal('compensation-rollback').workflow
    await runCycles(2)
    withActionFabricDb(db => db.exec(`CREATE TRIGGER fail_worker_compensation BEFORE INSERT ON fabric_outbox
      WHEN NEW.topic='fabric.workflow.created' BEGIN SELECT RAISE(ABORT, 'child outbox failed'); END`))
    await expect(processActionFabricOnce({ workerId: 'worker-a', now: plus(2) })).rejects.toThrow(/child outbox failed/)
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'verifying', compensationIntentId: null })
    withActionFabricDb(db => db.exec('DROP TRIGGER fail_worker_compensation'))

    await processActionFabricOnce({ workerId: 'worker-b', now: plus(33) })
    const parent = getFabricWorkflow(workflow.id)!
    expect(parent.compensationIntentId).toMatch(/^intent-/)
    expect(withActionFabricDb(db => (db.prepare(`SELECT COUNT(*) count FROM fabric_action_intents
      WHERE idempotency_key=?`).get(`compensation:${workflow.id}`) as { count: number }).count)).toBe(1)
  })

  it('commits the parent reservation when compensation terminates unsuccessfully', async () => {
    registerFabricExecutorAdapter(adapter({
      id: 'internal-twin', type: 'internal', verify: async () => failure('mismatch', 'VERIFY_MISMATCH'),
    }))
    const workflow = createInternal('compensation-child-failed').workflow
    seedReservedBudget(workflow.id)
    await runCycles(3)
    const parent = getFabricWorkflow(workflow.id)!
    withActionFabricDb(db => {
      const child = db.prepare('SELECT id FROM fabric_workflows WHERE intent_id=?').get(parent.compensationIntentId!) as { id: string }
      db.prepare("UPDATE fabric_workflows SET state='dead_letter' WHERE id=?").run(child.id)
      db.prepare("UPDATE fabric_steps SET state='failed' WHERE workflow_id=? AND kind='prepare'").run(child.id)
    })

    await processActionFabricOnce({ now: plus(3) })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('failed')
    expect(budgetStatus(workflow.id)).toBe('committed')
    const committed = listFabricAuditEvents({ aggregateId: workflow.id })
      .filter(event => event.eventType === 'budget.committed').length
    await processActionFabricOnce({ now: plus(4) })
    expect(listFabricAuditEvents({ aggregateId: workflow.id })
      .filter(event => event.eventType === 'budget.committed')).toHaveLength(committed)
    expect(() => retryFabricWorkflow(workflow.id, 'admin-1')).toThrow('FABRIC_WORKFLOW_NOT_RETRYABLE')
    const childId = withActionFabricDb(db => (db.prepare('SELECT id FROM fabric_workflows WHERE intent_id=?')
      .get(parent.compensationIntentId!) as { id: string }).id)
    expect(retryFabricWorkflow(childId, 'admin-1').state).toBe('retrying')
  })

  it('fails old incomplete contract snapshots closed without invoking an adapter', async () => {
    let calls = 0
    registerFabricExecutorAdapter(adapter({ prepare: async context => { calls += 1; return success('prepared', context) } }))
    const workflow = create('legacy-contract').workflow
    mutateCapturedContract(workflow.id, contract => { delete contract.idempotency; delete contract.verificationStrategy })

    await expect(processActionFabricOnce({ now: base })).resolves.toMatchObject({ processed: false })
    expect(calls).toBe(0)
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'waiting_user', lastErrorCode: 'FABRIC_WORKER_CONTRACT_MISSING' })
  })

  it('routes a captured reminder v1 to deliberate review before adapter I/O after v2 promotion', async () => {
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: { allow: ['health.reminder.send'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'critical',
        allowedTargets: ['health:recipient:configured-self'] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
    let calls = 0
    registerFabricExecutorAdapter(adapter({ id: 'health-shadow', type: 'connector',
      prepare: async context => { calls += 1; return success('prepared', context) } }))
    const workflow = createFabricIntent({
      capabilityId: 'health.reminder.send', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'captured-reminder-v1', goal: 'send a reminder safely', environments: ['sandbox'],
      target: { kind: 'health_recipient', recipient: 'configured-self' }, constraints: {}, rationale: 'test',
      input: { schemaVersion: 2, actionId: 'reminder-action', recipient: 'configured-self', messageCode: 'recovery' },
    }).workflow
    withActionFabricDb(db => {
      const history = db.prepare(`SELECT contract_digest FROM fabric_capability_contract_history
        WHERE capability_id='health.reminder.send' AND version=1`).get() as { contract_digest: string }
      db.prepare('UPDATE fabric_action_intents SET capability_version=1 WHERE id=?').run(workflow.intentId)
      const steps = db.prepare('SELECT id,input_json FROM fabric_steps WHERE workflow_id=?').all(workflow.id) as
        Array<{ id: string; input_json: string }>
      for (const step of steps) {
        const captured = JSON.parse(step.input_json) as {
          contract: Record<string, unknown>
          actionInput: Record<string, unknown>
        }
        captured.contract.capabilityVersion = 1
        captured.contract.contractDigest = history.contract_digest
        captured.actionInput.schemaVersion = 1
        captured.actionInput.messageText = 'legacy free-form reminder text'
        db.prepare('UPDATE fabric_steps SET input_json=? WHERE id=?').run(JSON.stringify(captured), step.id)
      }
    })

    await expect(processActionFabricOnce({ workerId: 'worker-v1-review', now: base }))
      .resolves.toMatchObject({ processed: false })
    expect(calls).toBe(0)
    expect(getFabricWorkflow(workflow.id)).toMatchObject({
      state: 'waiting_user', leaseOwner: null, leaseExpiresAt: null,
      lastErrorCode: 'FABRIC_CAPABILITY_VERSION_STALE',
    })
    expect(getFabricWorkflow(workflow.id)!.steps.every(step => step.state === 'waiting_user')).toBe(true)
    expect(listFabricAuditEvents({ aggregateId: workflow.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'workflow.contract_review_required',
        payload: expect.objectContaining({ reason: 'capability_version_stale' }) }),
    ]))
    expect(withActionFabricDb(db => db.prepare(`SELECT topic,payload_json FROM fabric_outbox
      WHERE aggregate_id=? AND topic='fabric.workflow.contract_review_required'`).get(workflow.id)))
      .toEqual({ topic: 'fabric.workflow.contract_review_required',
        payload_json: JSON.stringify({ from: 'preparing', reason: 'capability_version_stale',
          to: 'waiting_user' }) })
  })

  it('retries only verification when the captured contract forbids execution replay', async () => {
    let executes = 0
    registerFabricExecutorAdapter(adapter({
      execute: async context => { executes += 1; return success('succeeded', context) },
      verify: async () => failure('mismatch', 'VERIFY_MISMATCH'),
    }))
    const workflow = create('verify-only').workflow
    mutateCapturedContract(workflow.id, contract => { contract.idempotency = 'none' })
    await runCycles(3)
    await processActionFabricOnce({ now: plus(3) })
    await processActionFabricOnce({ now: plus(4) })
    expect(executes).toBe(1)
    expect(getFabricWorkflow(workflow.id)?.state).toBe('retrying')
  })

  it('fails a mismatch closed when captured verification strategy is none', async () => {
    registerFabricExecutorAdapter(adapter({ verify: async () => failure('mismatch', 'VERIFY_MISMATCH') }))
    const workflow = create('no-verification').workflow
    mutateCapturedContract(workflow.id, contract => { contract.verificationStrategy = 'none' })
    await runCycles(3)
    expect(getFabricWorkflow(workflow.id)).toMatchObject({
      state: 'waiting_user', lastErrorCode: 'FABRIC_VERIFICATION_CONTRACT_MISMATCH', retryAt: null,
    })
  })

  it('opens a persistent circuit breaker after repeated adapter failures', async () => {
    registerFabricExecutorAdapter(adapter({ prepare: async () => { throw new Error('raw secret payload') } }))
    for (let index = 0; index < 3; index += 1) {
      create(`breaker-${index}`)
      await processActionFabricOnce({ now: plus(index) })
    }
    expect(resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })).toBeNull()
    const executor = withActionFabricDb(db => db.prepare('SELECT enabled,health,health_details_json FROM fabric_executors WHERE id=?')
      .get('simulator-main') as { enabled: number; health: string; health_details_json: string })
    expect(executor).toMatchObject({ enabled: 0, health: 'unhealthy' })
    expect(JSON.parse(executor.health_details_json)).toMatchObject({ circuitBreaker: 'open' })
  })

  it('logs only durable identifiers and stable error classes', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    registerFabricExecutorAdapter(adapter({ prepare: async () => { throw new Error('password=raw-provider-secret') } }))
    const workflow = create('safe-log').workflow
    await processActionFabricOnce({ workerId: 'safe-worker', now: base })

    const logged = JSON.stringify(info.mock.calls)
    expect(logged).toContain(workflow.id)
    expect(logged).toContain('FABRIC_EXECUTOR_EXCEPTION')
    expect(logged).not.toContain('raw-provider-secret')
    info.mockRestore()
  })

  it('level 2 stop interrupts interruptible active work but does not call execute', async () => {
    let interrupted = 0
    let executed = 0
    registerFabricExecutorAdapter(adapter({
      execute: async context => { executed += 1; return success('succeeded', context) },
      interrupt: async context => { interrupted += 1; return success('interrupted', context) },
    }))
    const workflow = create('interrupt').workflow
    await processActionFabricOnce({ now: base })
    setFabricEmergencyStop(2, 'admin-1', 'stop')
    await processActionFabricOnce({ now: plus(1) })
    expect({ interrupted, executed }).toEqual({ interrupted: 1, executed: 0 })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('cancelled')
    expect(getFabricWorkflow(workflow.id)?.steps.every(step => step.state === 'cancelled' || step.state === 'succeeded')).toBe(true)
  })

  it('applies the same level 2 interrupt checkpoint to an interruptible connector executor', async () => {
    let interrupted = 0
    let executed = 0
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: { allow: ['health.plan.adjust'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: {
        maxRisk: 'critical', requireApprovalAbove: 'critical', allowedTargets: ['health:plan:daily-plan'],
      },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
    registerFabricExecutorAdapter(adapter({
      id: 'health-shadow', type: 'connector',
      execute: async context => { executed += 1; return success('succeeded', context) },
      interrupt: async context => { interrupted += 1; return success('interrupted', context) },
    }))
    const request = {
      capabilityId: 'health.plan.adjust', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'connector-interrupt', goal: 'shadow a health plan adjustment safely',
      target: { kind: 'health_plan', planId: 'daily-plan' },
      input: { schemaVersion: 1, planId: 'daily-plan', expectedVersion: 1,
        operation: 'reduce_training_intensity', maximumIntensity: 'low', reasonCode: 'low_recovery_score' },
      constraints: {}, rationale: 'test', environments: ['sandbox'],
    }
    const workflow = createFabricIntent(request).workflow
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'preparing', executorId: 'health-shadow' })
    await processActionFabricOnce({ now: base })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('executing')
    setFabricEmergencyStop(2, 'admin-1', 'stop connector')
    await processActionFabricOnce({ now: plus(1) })

    expect({ interrupted, executed }).toEqual({ interrupted: 1, executed: 0 })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('cancelled')
  })

  it('level 2 stop supersedes a live lease and rejects the stale execute commit', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let interrupted = 0
    registerFabricExecutorAdapter(adapter({
      execute: async context => { await gate; return success('succeeded', context) },
      interrupt: async context => { interrupted += 1; return success('interrupted', context) },
    }))
    const workflow = create('active-interrupt').workflow
    await processActionFabricOnce({ workerId: 'worker-a', now: base })
    const executing = processActionFabricOnce({ workerId: 'worker-a', now: plus(1) })
    await vi.waitFor(() => expect(getFabricWorkflow(workflow.id)?.steps[1].state).toBe('running'))
    setFabricEmergencyStop(2, 'admin-1', 'stop active')

    await expect(processActionFabricOnce({ workerId: 'worker-b', now: plus(2) }))
      .resolves.toMatchObject({ processed: true, phase: 'interrupt' })
    release()
    await expect(executing).resolves.toMatchObject({ stale: true })
    expect(interrupted).toBe(1)
    expect(getFabricWorkflow(workflow.id)?.state).toBe('cancelled')
  })

  it('interrupts a live leased adapter after a registry upgrade without routing it to stale review', async () => {
    let releaseExecute!: () => void
    let releaseInterrupt!: () => void
    const executeGate = new Promise<void>(resolve => { releaseExecute = resolve })
    const interruptGate = new Promise<void>(resolve => { releaseInterrupt = resolve })
    let interrupted = 0
    registerFabricExecutorAdapter(adapter({
      execute: async context => { await executeGate; return success('succeeded', context) },
      interrupt: async context => { interrupted += 1; await interruptGate; return success('interrupted', context) },
    }))
    const workflow = create('active-upgraded-interrupt').workflow
    await processActionFabricOnce({ workerId: 'worker-a', now: base })
    const executing = processActionFabricOnce({ workerId: 'worker-a', now: plus(1) })
    await vi.waitFor(() => expect(getFabricWorkflow(workflow.id)?.steps[1].state).toBe('running'))
    const current = resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })!.capability
    const upgraded = updateFabricCapability('simulator.echo', {
      version: current.version + 1, description: `${current.description} upgraded`,
    })
    bindFabricExecutorCapability('simulator-main', upgraded.id, upgraded.version, upgraded.contractDigest)
    setFabricEmergencyStop(2, 'admin-1', 'stop upgraded active work')

    const interrupting = processActionFabricOnce({ workerId: 'worker-b', now: plus(2) })
    await vi.waitFor(() => expect(interrupted).toBe(1))
    expect(getFabricWorkflow(workflow.id)).toMatchObject({ state: 'executing', leaseOwner: 'worker-b' })
    expect(listFabricAuditEvents({ aggregateId: workflow.id })
      .some(event => event.eventType === 'workflow.contract_review_required')).toBe(false)
    releaseInterrupt()
    await expect(interrupting).resolves.toMatchObject({ processed: true, phase: 'interrupt', outcome: 'interrupted' })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('cancelled')
    releaseExecute()
    await expect(executing).resolves.toMatchObject({ stale: true })
    expect(getFabricWorkflow(workflow.id)?.state).toBe('cancelled')
  })

  it('level 2 preserves live non-interruptible work until a safe waiting-user checkpoint', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    registerFabricExecutorAdapter(adapter({
      id: 'internal-twin', type: 'internal', execute: async context => { await gate; return success('succeeded', context) },
    }))
    const workflow = createInternal('non-interruptible-live').workflow
    await processActionFabricOnce({ workerId: 'worker-a', now: base })
    const executing = processActionFabricOnce({ workerId: 'worker-a', now: plus(1) })
    await vi.waitFor(() => expect(getFabricWorkflow(workflow.id)?.steps[1].state).toBe('running'))
    const before = getFabricWorkflow(workflow.id)!
    setFabricEmergencyStop(2, 'admin-1', 'do not interrupt internal')

    await expect(processActionFabricOnce({ workerId: 'worker-b', now: plus(2) })).resolves.toMatchObject({ processed: false })
    expect(getFabricWorkflow(workflow.id)).toMatchObject({
      state: before.state, version: before.version, leaseOwner: before.leaseOwner, leaseExpiresAt: before.leaseExpiresAt,
    })
    release()
    await expect(executing).resolves.not.toMatchObject({ stale: true })
    expect(getFabricWorkflow(workflow.id)).toMatchObject({
      state: 'waiting_user', leaseOwner: null, lastErrorCode: 'FABRIC_CONTROL_CHANGED_REVIEW_REQUIRED',
    })
    expect(getFabricWorkflow(workflow.id)?.steps[1]).toMatchObject({
      state: 'waiting_user', output: expect.any(Object),
    })
  })

  it('managed worker interrupts its own long-running interruptible adapter at level 2', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let interrupted = 0
    registerFabricExecutorAdapter(adapter({
      execute: async context => { await gate; return success('succeeded', context) },
      interrupt: async context => { interrupted += 1; return success('interrupted', context) },
    }))
    const workflow = create('managed-emergency').workflow
    const handle = startActionFabricWorker({ workerId: 'managed-emergency', intervalMs: 10,
      controlPollMs: 5, clock: () => plus(1) })
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => expect(getFabricWorkflow(workflow.id)?.steps[1].state).toBe('running'))
    setFabricEmergencyStop(2, 'admin-1', 'interrupt now')

    await vi.advanceTimersByTimeAsync(5)
    await vi.waitFor(() => expect(interrupted).toBe(1))
    expect(getFabricWorkflow(workflow.id)?.state).toBe('cancelled')
    release()
    await handle.stop()
    expect(getFabricWorkflow(workflow.id)?.state).toBe('cancelled')
  })

  it('rechecks level 2 under the commit lock before accepting a completed interruptible result', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    registerFabricExecutorAdapter(adapter({ execute: async context => { await gate; return success('succeeded', context) } }))
    const workflow = create('commit-control-race').workflow
    await processActionFabricOnce({ now: base })
    const executing = processActionFabricOnce({ workerId: 'worker-a', now: plus(1) })
    await vi.waitFor(() => expect(getFabricWorkflow(workflow.id)?.steps[1].state).toBe('running'))
    setFabricEmergencyStop(2, 'admin-1', 'race close')
    release()

    await executing
    expect(getFabricWorkflow(workflow.id)).toMatchObject({
      state: 'waiting_user', lastErrorCode: 'FABRIC_EMERGENCY_STOP_RESULT_UNCERTAIN',
    })
  })

  it('never claims waiting-user, denied, or cancelled workflows', async () => {
    const waiting = create('ineligible')
    withActionFabricDb(db => {
      db.prepare("UPDATE fabric_workflows SET state='waiting_user' WHERE id=?").run(waiting.workflow.id)
      db.prepare("UPDATE fabric_steps SET state='waiting_user' WHERE workflow_id=?").run(waiting.workflow.id)
    })
    await expect(processActionFabricOnce({ now: base })).resolves.toMatchObject({ processed: false })
    withActionFabricDb(db => db.prepare("UPDATE fabric_workflows SET state='denied' WHERE id=?").run(waiting.workflow.id))
    await expect(processActionFabricOnce({ now: base })).resolves.toMatchObject({ processed: false })
    withActionFabricDb(db => db.prepare("UPDATE fabric_workflows SET state='cancelled' WHERE id=?").run(waiting.workflow.id))
    await expect(processActionFabricOnce({ now: base })).resolves.toMatchObject({ processed: false })
  })

  it('managed worker prevents overlapping timers and can be stopped idempotently', async () => {
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    create('timer')
    const handle = startActionFabricWorker({ workerId: 'timer-worker', intervalMs: 10, clock: () => base })
    expect(startActionFabricWorker()).toBe(handle)
    await vi.advanceTimersByTimeAsync(40)
    await stopActionFabricWorker()
    await stopActionFabricWorker()
    expect(getFabricWorkflow(handle.workerId === 'timer-worker' ? listWorkflowId() : '')?.steps[0].state).toBe('succeeded')
  })

  it('serializes stop and restart generations and makes old handles harmless', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    registerFabricExecutorAdapter(adapter({ prepare: async context => { await gate; return success('prepared', context) } }))
    create('generation-one')
    const first = startActionFabricWorker({ workerId: 'generation-one', intervalMs: 10, clock: () => base })
    await vi.advanceTimersByTimeAsync(10)
    const stopping = first.stop()
    expect(startActionFabricWorker({ workerId: 'too-early' })).toBe(first)
    release()
    await stopping

    unregisterFabricExecutorAdapter('simulator-main')
    registerFabricExecutorAdapter(createSimulatorExecutorAdapter())
    const secondWorkflow = create('generation-two').workflow
    const second = startActionFabricWorker({ workerId: 'generation-two', intervalMs: 10, clock: () => plus(1) })
    expect(second).not.toBe(first)
    await first.stop()
    await vi.advanceTimersByTimeAsync(40)
    await second.stop()
    expect(getFabricWorkflow(secondWorkflow.id)?.steps[0].state).toBe('succeeded')
  })
})

function create(idempotencyKey = 'worker-intent') {
  return createFabricIntent({
    capabilityId: 'simulator.echo', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
    idempotencyKey, goal: 'execute safely', target: { id: 'simulator' }, input: { message: 'hello' },
    constraints: {}, rationale: 'test',
  })
}

function createInternal(idempotencyKey: string) {
  return createFabricIntent({
    capabilityId: 'internal.twin.preference.set', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
    idempotencyKey, goal: 'set safely', target: { id: 'personal-twin' },
    input: { domain: 'preferences', key: 'theme', value: 'dark' }, constraints: {}, rationale: 'test',
  })
}

function createHealthPlan(idempotencyKey: string, environments: Array<'sandbox' | 'internal'>) {
  return createFabricIntent({
    capabilityId: 'health.plan.adjust', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
    idempotencyKey, goal: 'adjust plan safely', target: { kind: 'health_plan', planId: 'daily-plan' },
    input: { schemaVersion: 1, planId: 'daily-plan', expectedVersion: 3,
      operation: 'reduce_training_intensity', maximumIntensity: 'low', reasonCode: 'low_recovery_score' },
    constraints: {}, rationale: 'test', environments,
  })
}

function configureHealthPlanRole(): void {
  updateAssistantRole('health-manager', {
    enabled: true,
    capabilityScope: { allow: ['health.plan.adjust', 'health.plan.restore'], deny: [], enforcement: 'action_fabric_v1' },
    decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'critical',
      allowedTargets: ['health:plan:daily-plan'] },
    spendingLimits: { currency: null, perAction: 0, daily: 0 },
  })
}

function mutateCapturedContract(workflowId: string, mutate: (contract: Record<string, unknown>) => void): void {
  withActionFabricDb(db => {
    const rows = db.prepare('SELECT id,input_json FROM fabric_steps WHERE workflow_id=?').all(workflowId) as
      Array<{ id: string; input_json: string }>
    for (const row of rows) {
      const input = JSON.parse(row.input_json) as { contract: Record<string, unknown> }
      mutate(input.contract)
      db.prepare('UPDATE fabric_steps SET input_json=? WHERE id=?').run(JSON.stringify(input), row.id)
    }
  })
}

function seedReservedBudget(workflowId: string): void {
  withActionFabricDb(db => {
    const row = db.prepare(`SELECT w.policy_decision_id decision_id,i.requested_by_user_id user_id,
      i.requested_by_role_id role_id FROM fabric_workflows w JOIN fabric_action_intents i ON i.id=w.intent_id
      WHERE w.id=?`).get(workflowId) as { decision_id: string; user_id: string; role_id: string }
    db.prepare(`INSERT INTO fabric_budget_ledger(id,decision_id,workflow_id,requested_by_user_id,
      requested_by_role_id,ledger_date,currency,amount_minor,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'2026-07-12','USD',50,'reserved',?,?)`).run(
      `budget-test-${workflowId}`, row.decision_id, workflowId, row.user_id, row.role_id,
      plus(0).toISOString(), plus(0).toISOString(),
    )
  })
}

function budgetStatus(workflowId: string): string {
  return withActionFabricDb(db => (db.prepare('SELECT status FROM fabric_budget_ledger WHERE workflow_id=?')
    .get(workflowId) as { status: string }).status)
}

function plus(seconds: number): Date { return new Date(baseTime() + seconds * 1_000) }
function baseTime(): number { return new Date('2026-07-12T01:00:00.000Z').getTime() }

async function runCycles(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await processActionFabricOnce({ workerId: 'worker-a', now: plus(index) })
}

function success(outcome: string, context: FabricExecutionContext) {
  return { outcome, output: context.executionOutput ?? context.input, evidence: [], errorCode: null, safeToRetry: false } as never
}

function failure(outcome: string, errorCode: string, safeToRetry = false) {
  return { outcome, output: {}, evidence: [], errorCode, safeToRetry } as never
}

function adapter(overrides: Partial<FabricExecutorAdapter> = {}): FabricExecutorAdapter {
  return {
    id: 'simulator-main', type: 'simulator',
    async prepare(context) { return success('prepared', context) },
    async execute(context) { return success('succeeded', context) },
    async verify(context) { return success('verified', context) },
    async interrupt(context) { return success('interrupted', context) },
    async compensate(context) { return success('unsupported', context) },
    ...overrides,
  }
}

function listWorkflowId(): string {
  return withActionFabricDb(db => (db.prepare('SELECT id FROM fabric_workflows ORDER BY created_at LIMIT 1').get() as { id: string }).id)
}

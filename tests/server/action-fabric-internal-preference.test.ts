import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createInternalPreferenceExecutorAdapter,
  createFabricIntent,
  ensureBuiltInFabricRegistry,
  getFabricWorkflow,
  invokeFabricExecutor,
  listFabricAuditEvents,
  processActionFabricOnce,
  registerFabricExecutorAdapter,
  requestFabricCompensation,
  resolveFabricExecutor,
  unregisterFabricExecutorAdapter,
  updateFabricExecutorHealth,
  type FabricExecutionContext,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  ensureBuiltInAssistantRoles, getTwinPreference, setTwinPreference, updateAssistantRole,
  upsertTwinEntity, withPersonalTwinDb,
} from '../../packages/server/src/services/hermes/personal-twin'

describe('Action Fabric internal preference executor', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hwui-fabric-preference-'))
    process.env.HERMES_HOME = home
    ensureBuiltInFabricRegistry()
    ensureBuiltInAssistantRoles()
    updateFabricExecutorHealth('internal-twin', 'healthy', {})
    updateAssistantRole('health-manager', {
      enabled: true,
      capabilityScope: { allow: ['internal.twin.preference.set'], deny: [], enforcement: 'action_fabric_v1' },
      decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'critical', allowedTargets: ['personal-twin'] },
      spendingLimits: { currency: null, perAction: 0, daily: 0 },
    })
    unregisterFabricExecutorAdapter('internal-twin')
    registerFabricExecutorAdapter(createInternalPreferenceExecutorAdapter())
    upsertTwinEntity({ id: 'person:self', type: 'person', label: 'Self', source: 'system', sourceId: 'self' })
  })

  afterEach(() => {
    unregisterFabricExecutorAdapter('internal-twin')
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it('prepares exact prior state and executes, verifies, and deduplicates a canonical write', async () => {
    setTwinPreference({ subjectId: 'person:self', domain: 'digital', key: 'appearance.theme', value: { mode: 'light' },
      source: 'action-fabric', sourceId: 'seed-operation', actor: 'action-fabric', confidence: 0.9 })
    const context = executionContext('execution-original', { subjectId: 'person:self', domain: 'digital',
      key: 'appearance.theme', value: { mode: 'dark' } })
    const prepared = await invokeFabricExecutor('prepare', context)
    expect(prepared).toMatchObject({ outcome: 'prepared', output: { existed: true, prior: {
      value: { mode: 'light' }, provenance: { source: 'action-fabric', sourceId: 'seed-operation', confidence: 0.9 },
    } } })

    const executing = { ...context, preparedOutput: prepared.output }
    const first = await invokeFabricExecutor('execute', executing)
    const replay = await invokeFabricExecutor('execute', executing)
    expect(first).toMatchObject({ outcome: 'succeeded', output: { sourceId: expect.stringMatching(/^fabric:execute:[a-f0-9]{64}$/) } })
    expect(replay).toEqual(first)
    await expect(invokeFabricExecutor('verify', { ...executing, executionOutput: first.output }))
      .resolves.toMatchObject({ outcome: 'verified' })
    expect(getTwinPreference('person:self', 'digital', 'appearance.theme')?.value).toEqual({ mode: 'dark' })
    expect(withPersonalTwinDb(db => db.prepare("SELECT COUNT(*) count FROM twin_outbox WHERE topic='twin.preference.set'").get()))
      .toEqual({ count: 2 })
  })

  it('compensates by restoring prior state or deleting a newly-created preference with distinct tokens', async () => {
    setTwinPreference({ subjectId: 'person:self', domain: 'life', key: 'calendar.view', value: 'agenda',
      source: 'action-fabric', sourceId: 'seed', actor: 'action-fabric', confidence: 1 })
    const existing = executionContext('execute-existing', { subjectId: 'person:self', domain: 'life', key: 'calendar.view', value: 'week' })
    const prior = await invokeFabricExecutor('prepare', existing)
    const existingExecuted = await invokeFabricExecutor('execute', { ...existing, preparedOutput: prior.output })
    await expect(invokeFabricExecutor('compensate', { ...existing, preparedOutput: prior.output,
      executionOutput: existingExecuted.output }))
      .resolves.toMatchObject({ outcome: 'compensated' })
    expect(getTwinPreference('person:self', 'life', 'calendar.view')).toMatchObject({ value: 'agenda',
      provenance: { sourceId: 'seed' } })

    const created = executionContext('execute-new', { subjectId: 'person:self', domain: 'home', key: 'lighting.scene', value: 'calm' })
    const absent = await invokeFabricExecutor('prepare', created)
    const createdExecuted = await invokeFabricExecutor('execute', { ...created, preparedOutput: absent.output })
    const compensated = await invokeFabricExecutor('compensate', { ...created, preparedOutput: absent.output,
      executionOutput: createdExecuted.output })
    expect(compensated.outcome).toBe('compensated')
    expect(getTwinPreference('person:self', 'home', 'lighting.scene')).toBeNull()
  })

  it('rejects sensitive material and reports Twin failures without false success', async () => {
    const sensitive = executionContext('sensitive', { subjectId: 'person:self', domain: 'digital', key: 'api_token', value: 'secret-value' })
    await expect(invokeFabricExecutor('prepare', sensitive)).resolves.toMatchObject({ outcome: 'failed', errorCode: 'TWIN_PREFERENCE_SENSITIVE' })
    const forged = executionContext('forged-compensation', { originalWorkflowId: 'workflow-not-authorized' })
    await expect(invokeFabricExecutor('prepare', forged)).resolves.toMatchObject({
      outcome: 'failed', errorCode: 'TWIN_PREFERENCE_PREPARE_FAILED',
    })

    const context = executionContext('outbox-failure', { subjectId: 'person:self', domain: 'digital', key: 'appearance.theme', value: 'dark' })
    const prepared = await invokeFabricExecutor('prepare', context)
    withPersonalTwinDb(db => db.exec(`CREATE TRIGGER fail_executor_preference BEFORE INSERT ON twin_outbox
      WHEN NEW.topic='twin.preference.set' BEGIN SELECT RAISE(ABORT, 'twin unavailable'); END`))
    await expect(invokeFabricExecutor('execute', { ...context, preparedOutput: prepared.output }))
      .resolves.toMatchObject({ outcome: 'temporary_failure', errorCode: 'TWIN_PREFERENCE_WRITE_FAILED', safeToRetry: true })
    expect(getTwinPreference('person:self', 'digital', 'appearance.theme')).toBeNull()
  })

  it('requires the durable internal-twin versioned binding before invocation', async () => {
    const context = executionContext('binding', { subjectId: 'person:self', domain: 'life', key: 'calendar.view', value: 'month' })
    const resolved = resolveFabricExecutor('internal.twin.preference.set', { environments: ['internal'] })!
    expect(resolved.executor).toMatchObject({ id: 'internal-twin', type: 'internal' })
    await expect(invokeFabricExecutor('prepare', { ...context, contractDigest: `${context.contractDigest}-stale` }))
      .rejects.toThrow('FABRIC_EXECUTOR_BINDING_INVALID')
  })

  it('runs compensation as an audited durable child workflow and restores exact provenance', async () => {
    setTwinPreference({ subjectId: 'person:self', domain: 'life', key: 'calendar.view', value: { layout: 'agenda' },
      source: 'fixture', sourceId: 'prior-source', actor: 'seed-actor', confidence: 0.75 })
    const original = createFabricIntent({ capabilityId: 'internal.twin.preference.set',
      requestedByRoleId: 'health-manager', requestedByUserId: 'user-1', idempotencyKey: 'preference-durable',
      goal: 'change calendar view', target: { id: 'personal-twin' },
      input: { subjectId: 'person:self', domain: 'life', key: 'calendar.view', value: { layout: 'week' } },
      constraints: {}, rationale: 'test reversible internal action' })
    for (let index = 0; index < 3; index += 1) {
      await processActionFabricOnce({ workerId: 'worker-preference', now: new Date(Date.UTC(2026, 6, 12, 2, 0, index)) })
    }
    expect(getFabricWorkflow(original.workflow.id)?.state).toBe('succeeded')
    expect(getTwinPreference('person:self', 'life', 'calendar.view')?.value).toEqual({ layout: 'week' })

    const parent = requestFabricCompensation(original.workflow.id, 'user-1', 'restore the previous view')
    expect(parent.state).toBe('compensating')
    for (let index = 3; index < 7; index += 1) {
      await processActionFabricOnce({ workerId: 'worker-preference', now: new Date(Date.UTC(2026, 6, 12, 2, 0, index)) })
    }
    expect(getFabricWorkflow(original.workflow.id)?.state).toBe('compensated')
    expect(getTwinPreference('person:self', 'life', 'calendar.view')).toMatchObject({
      value: { layout: 'agenda' }, provenance: { source: 'fixture', sourceId: 'prior-source', actor: 'seed-actor', confidence: 0.75 },
    })
    expect(listFabricAuditEvents({ aggregateId: original.workflow.id }).map(event => event.eventType))
      .toEqual(expect.arrayContaining(['workflow.compensation_requested', 'workflow.compensation_reconciled']))
  })

  it('refuses execution when state changed after prepare instead of overwriting the newer value', async () => {
    const context = executionContext('cas-execute', { subjectId: 'person:self', domain: 'digital',
      key: 'appearance.theme', value: 'action-value' })
    const prepared = await invokeFabricExecutor('prepare', context)
    setTwinPreference({ subjectId: 'person:self', domain: 'digital', key: 'appearance.theme', value: 'user-value',
      source: 'user', sourceId: 'user-after-prepare', actor: 'user', operationId: 'user-after-prepare' })
    await expect(invokeFabricExecutor('execute', { ...context, preparedOutput: prepared.output })).resolves.toMatchObject({
      outcome: 'permanent_failure', errorCode: 'TWIN_PREFERENCE_CONFLICT', safeToRetry: false,
    })
    expect(getTwinPreference('person:self', 'digital', 'appearance.theme')?.value).toBe('user-value')
  })

  it('refuses restore or delete compensation after a newer writer changed the action result', async () => {
    setTwinPreference({ subjectId: 'person:self', domain: 'life', key: 'calendar.view', value: 'agenda',
      source: 'user', sourceId: 'prior', actor: 'user', operationId: 'prior-op' })
    const restore = executionContext('cas-restore', { subjectId: 'person:self', domain: 'life', key: 'calendar.view', value: 'week' })
    const restorePrepared = await invokeFabricExecutor('prepare', restore)
    const restoreExecuted = await invokeFabricExecutor('execute', { ...restore, preparedOutput: restorePrepared.output })
    setTwinPreference({ subjectId: 'person:self', domain: 'life', key: 'calendar.view', value: 'month',
      source: 'user', sourceId: 'newer', actor: 'user', operationId: 'newer-op' })
    await expect(invokeFabricExecutor('compensate', { ...restore, preparedOutput: restorePrepared.output,
      executionOutput: restoreExecuted.output })).resolves.toMatchObject({
      outcome: 'unknown', errorCode: 'TWIN_PREFERENCE_CONFLICT', safeToRetry: false,
    })
    expect(getTwinPreference('person:self', 'life', 'calendar.view')?.value).toBe('month')

    const remove = executionContext('cas-delete', { subjectId: 'person:self', domain: 'home', key: 'lighting.scene', value: 'calm' })
    const removePrepared = await invokeFabricExecutor('prepare', remove)
    const removeExecuted = await invokeFabricExecutor('execute', { ...remove, preparedOutput: removePrepared.output })
    setTwinPreference({ subjectId: 'person:self', domain: 'home', key: 'lighting.scene', value: 'focus',
      source: 'user', sourceId: 'newer-home', actor: 'user', operationId: 'newer-home-op' })
    await expect(invokeFabricExecutor('compensate', { ...remove, preparedOutput: removePrepared.output,
      executionOutput: removeExecuted.output })).resolves.toMatchObject({ outcome: 'unknown', errorCode: 'TWIN_PREFERENCE_CONFLICT' })
    expect(getTwinPreference('person:self', 'home', 'lighting.scene')?.value).toBe('focus')
  })

  function executionContext(executionToken: string, input: Record<string, unknown>): FabricExecutionContext {
    const resolved = resolveFabricExecutor('internal.twin.preference.set', { environments: ['internal'] })!
    return {
      intentId: `intent-${executionToken}`, workflowId: `workflow-${executionToken}`, stepId: `step-${executionToken}`,
      executorId: resolved.executor.id, executorType: resolved.executor.type, capabilityId: resolved.capability.id,
      capabilityVersion: resolved.capability.version, contractDigest: resolved.capability.contractDigest,
      policyEvaluationToken: resolved.policyEvaluationToken, executionToken, input, target: {}, now: '2026-07-12T00:00:00.000Z',
    }
  }
})

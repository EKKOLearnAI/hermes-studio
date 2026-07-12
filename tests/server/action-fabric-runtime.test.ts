import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createFabricIntent,
  createSimulatorExecutorAdapter,
  ensureBuiltInFabricRegistry,
  getActionFabricDbPath,
  getFabricWorkflow,
  listFabricAuditEvents,
  listFabricExecutors,
  registerFabricExecutorAdapter,
  setFabricEmergencyStop,
  startActionFabricRuntime,
  stopActionFabricRuntime,
  isActionFabricRuntimeEnabled,
  updateFabricExecutorHealth,
  unregisterFabricExecutorAdapter,
  withActionFabricDb,
} from '../../packages/server/src/services/hermes/action-fabric'
import { ensureBuiltInAssistantRoles, updateAssistantRole } from '../../packages/server/src/services/hermes/personal-twin'
import { runServerMain } from '../../packages/server/src/services/server-main'

describe('Action Fabric runtime lifecycle', () => {
  const originalHome = process.env.HERMES_HOME
  const originalDisabled = process.env.HERMES_ACTION_FABRIC_DISABLED
  const originalNodeEnv = process.env.NODE_ENV
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hwui-fabric-runtime-'))
    process.env.HERMES_HOME = home
    process.env.NODE_ENV = 'test'
    process.env.HERMES_ACTION_FABRIC_DISABLED = '0'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-12T01:00:00.000Z'))
  })

  afterEach(async () => {
    await stopActionFabricRuntime()
    vi.useRealTimers()
    restore('HERMES_HOME', originalHome)
    restore('HERMES_ACTION_FABRIC_DISABLED', originalDisabled)
    restore('NODE_ENV', originalNodeEnv)
    rmSync(home, { recursive: true, force: true })
  })

  it('is disabled by default in tests and honors the explicit operational kill switch', () => {
    expect(isActionFabricRuntimeEnabled({ NODE_ENV: 'test' })).toBe(false)
    expect(isActionFabricRuntimeEnabled({ NODE_ENV: 'test', HERMES_ACTION_FABRIC_DISABLED: '0' })).toBe(true)
    expect(isActionFabricRuntimeEnabled({ NODE_ENV: 'production', HERMES_ACTION_FABRIC_DISABLED: '1' })).toBe(false)
    expect(isActionFabricRuntimeEnabled({ NODE_ENV: 'production' })).toBe(true)
  })

  it('has no import-time polling and disabled start creates no database or timer', async () => {
    expect(vi.getTimerCount()).toBe(0)
    process.env.HERMES_ACTION_FABRIC_DISABLED = '1'
    await startActionFabricRuntime()
    expect(vi.getTimerCount()).toBe(0)
    expect(existsSync(getActionFabricDbPath())).toBe(false)
  })

  it('rolls back a failed start so a later corrected start succeeds', async () => {
    const blocked = join(home, 'not-a-directory')
    writeFileSync(blocked, 'blocked')
    process.env.HERMES_HOME = blocked
    await expect(startActionFabricRuntime()).rejects.toBeTruthy()
    process.env.HERMES_HOME = home

    await startActionFabricRuntime()
    expect(listFabricExecutors()).toHaveLength(2)
    await Promise.all([stopActionFabricRuntime(), stopActionFabricRuntime()])
  })

  it('bootstraps registry and role policy before polling and repeated starts are idempotent', async () => {
    await Promise.all([startActionFabricRuntime(), startActionFabricRuntime(), startActionFabricRuntime()])

    expect(listFabricExecutors().map(executor => executor.id)).toEqual(['internal-twin', 'simulator-main'])
    expect(withActionFabricDb(db => db.prepare("SELECT value FROM fabric_meta WHERE key='registry_policy_revision'").get()))
      .toBeTruthy()
    expect(updateAssistantRole('health-manager', {}).capabilityScope.enforcement).toBe('action_fabric_v1')
  })

  it('moves unleased non-interruptible work to waiting-user at level 2', async () => {
    configureRole()
    ensureBuiltInFabricRegistry()
    updateFabricExecutorHealth('internal-twin', 'healthy', {})
    const workflow = createFabricIntent({
      capabilityId: 'internal.twin.preference.set', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'runtime-l2-noninterrupt', goal: 'set preference', target: { id: 'personal-twin' },
      input: { subjectId: 'user-1', domain: 'general', key: 'theme', value: 'dark' }, constraints: {}, rationale: 'test',
    }).workflow
    await startActionFabricRuntime()

    setFabricEmergencyStop(2, 'admin', 'pause active work')
    await vi.advanceTimersByTimeAsync(300)

    expect(getFabricWorkflow(workflow.id)).toMatchObject({
      state: 'waiting_user', leaseOwner: null, lastErrorCode: 'FABRIC_CONTROL_CHANGED_REVIEW_REQUIRED',
    })
    expect(listFabricAuditEvents({ aggregateId: workflow.id }).some(event =>
      event.eventType === 'workflow.control_checkpoint_required')).toBe(true)
  })

  it('level 1 rejects new intents before any executable workflow is created', async () => {
    configureSimulatorRole()
    ensureBuiltInFabricRegistry()
    updateFabricExecutorHealth('simulator-main', 'healthy', {})
    await startActionFabricRuntime()
    setFabricEmergencyStop(1, 'admin', 'pause new intents')

    const result = createFabricIntent({
      capabilityId: 'simulator.echo', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'runtime-l1', goal: 'echo', target: { id: 'simulator' }, input: { value: 1 },
      constraints: {}, rationale: 'test',
    })

    expect(result.policyDecision).toMatchObject({ outcome: 'deny', reasonCodes: ['emergency_stop'] })
    expect(result.workflow).toMatchObject({ state: 'denied', steps: [] })
  })

  it('level 2 interrupts eligible simulator work', async () => {
    configureSimulatorRole()
    ensureBuiltInFabricRegistry()
    updateFabricExecutorHealth('simulator-main', 'healthy', {})
    const workflow = createFabricIntent({
      capabilityId: 'simulator.echo', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'runtime-l2-interrupt', goal: 'echo', target: { id: 'simulator' }, input: { value: 1 },
      constraints: {}, rationale: 'test',
    }).workflow
    await startActionFabricRuntime()
    setFabricEmergencyStop(2, 'admin', 'stop interruptible work')

    await vi.advanceTimersByTimeAsync(1_100)
    await vi.waitFor(() => expect(getFabricWorkflow(workflow.id)?.state).toBe('cancelled'))
  })

  it('checkpoints an in-flight result when a control version change invalidates its lease', async () => {
    configureSimulatorRole()
    ensureBuiltInFabricRegistry()
    updateFabricExecutorHealth('simulator-main', 'healthy', {})
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const adapter = createSimulatorExecutorAdapter()
    unregisterFabricExecutorAdapter('simulator-main')
    registerFabricExecutorAdapter({
      ...adapter,
      async prepare(context) { await gate; return adapter.prepare(context) },
    })
    const workflow = createFabricIntent({
      capabilityId: 'simulator.echo', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1',
      idempotencyKey: 'runtime-control-version', goal: 'echo', target: { id: 'simulator' }, input: { value: 1 },
      constraints: {}, rationale: 'test',
    }).workflow
    await startActionFabricRuntime()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(getFabricWorkflow(workflow.id)?.leaseOwner).not.toBeNull())

    setFabricEmergencyStop(1, 'admin', 'invalidate active authorization')
    release()
    await vi.waitFor(() => expect(getFabricWorkflow(workflow.id)?.state).toBe('waiting_user'))

    expect(getFabricWorkflow(workflow.id)).toMatchObject({
      leaseOwner: null, lastErrorCode: 'FABRIC_CONTROL_CHANGED_REVIEW_REQUIRED',
    })
    expect(getFabricWorkflow(workflow.id)?.steps[0]).toMatchObject({
      state: 'waiting_user', output: { capabilityId: 'simulator.echo' },
    })
    unregisterFabricExecutorAdapter('simulator-main')
  })

  it('level 3 disables fail-closed future external-write executors without disabling Phase 3 adapters', async () => {
    ensureBuiltInFabricRegistry()
    await startActionFabricRuntime()
    setFabricEmergencyStop(3, 'admin', 'disable writes')
    await vi.advanceTimersByTimeAsync(300)

    // A later process may register a new executor without changing control version.
    // Level 3 remains continuously enforced and must fail that executor closed.
    withActionFabricDb(db => {
      db.exec('PRAGMA ignore_check_constraints = ON')
      db.prepare(`INSERT INTO fabric_executors(id,type,name,environment,health,health_details_json,configuration_json,
        enabled,policy_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        'future-browser', 'browser', 'Future browser', 'production', 'healthy', '{}',
        JSON.stringify({ externalWrite: true }), 1, 1, new Date().toISOString(), new Date().toISOString(),
      )
      db.exec('PRAGMA ignore_check_constraints = OFF')
    })
    await vi.advanceTimersByTimeAsync(300)

    const enabled = withActionFabricDb(db => db.prepare('SELECT id,enabled FROM fabric_executors ORDER BY id').all())
    expect(enabled).toEqual([
      expect.objectContaining({ id: 'future-browser', enabled: 0 }),
      expect.objectContaining({ id: 'internal-twin', enabled: 1 }),
      expect.objectContaining({ id: 'simulator-main', enabled: 1 }),
    ])
    expect(listFabricAuditEvents({ aggregateId: 'future-browser' }).some(event =>
      event.eventType === 'executor.external_write.disabled')).toBe(true)
  })
})

describe('server main Action Fabric rollback', () => {
  it('awaits runtime rollback after a later bootstrap failure before exiting', async () => {
    const events: string[] = []
    const original = new Error('listen failed')
    let release!: () => void
    const stopped = new Promise<void>(resolve => { release = resolve })
    const pending = runServerMain({
      bootstrap: async () => { events.push('bootstrap'); throw original },
      stopActionFabricRuntime: async () => { events.push('stop-start'); await stopped; events.push('stop-end') },
      reportFatal: error => events.push(error === original ? 'fatal-original' : 'fatal-wrong'),
      reportRollbackFailure: () => events.push('rollback-failed'),
      exit: code => { events.push(`exit-${code}`) },
    })

    await vi.waitFor(() => expect(events).toEqual(['bootstrap', 'fatal-original', 'stop-start']))
    release()
    await pending
    expect(events).toEqual(['bootstrap', 'fatal-original', 'stop-start', 'stop-end', 'exit-1'])
  })

  it('reports rollback failure without masking the original bootstrap error', async () => {
    const original = new Error('route setup failed')
    const rollback = new Error('worker stop failed')
    const reported: unknown[] = []
    let exitCode: number | null = null
    await runServerMain({
      bootstrap: async () => { throw original },
      stopActionFabricRuntime: async () => { throw rollback },
      reportFatal: error => reported.push(error),
      reportRollbackFailure: error => reported.push(error),
      exit: code => { exitCode = code },
    })
    expect(reported).toEqual([original, rollback])
    expect(exitCode).toBe(1)
  })

  it('does not stop the runtime after successful bootstrap', async () => {
    const stop = vi.fn(async () => {})
    const exit = vi.fn()
    await runServerMain({
      bootstrap: async () => {}, stopActionFabricRuntime: stop,
      reportFatal: vi.fn(), reportRollbackFailure: vi.fn(), exit,
    })
    expect(stop).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })
})

function configureRole(): void {
  ensureBuiltInAssistantRoles()
  updateAssistantRole('health-manager', {
    enabled: true,
    capabilityScope: { allow: ['internal.twin.preference.set'], deny: [], enforcement: 'action_fabric_v1' },
    decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'critical', allowedTargets: ['personal-twin'] },
    spendingLimits: { currency: null, perAction: 0, daily: 0 },
  })
}

function configureSimulatorRole(): void {
  ensureBuiltInAssistantRoles()
  updateAssistantRole('health-manager', {
    enabled: true,
    capabilityScope: { allow: ['simulator.echo'], deny: [], enforcement: 'action_fabric_v1' },
    decisionAuthority: { maxRisk: 'critical', requireApprovalAbove: 'critical', allowedTargets: ['simulator'] },
    spendingLimits: { currency: null, perAction: 0, daily: 0 },
  })
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

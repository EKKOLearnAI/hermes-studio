import type { DatabaseSync } from 'node:sqlite'
import { migrateAssistantRoleCapabilityEnforcement } from '../personal-twin'
import { logger } from '../../logger'
import { appendFabricAuditEvent, appendFabricOutbox, withFabricAuditedTransaction } from './audit'
import { getFabricControlState } from './control'
import { getFabricControlStateInDb } from './control'
import { createInternalPreferenceExecutorAdapter } from './internal-preference'
import { ensureBuiltInFabricRegistry } from './registry'
import { createSimulatorExecutorAdapter } from './simulator'
import {
  registerFabricExecutorAdapter,
  unregisterFabricExecutorAdapter,
} from './executors'
import { startActionFabricWorker, stopActionFabricWorker } from './worker'
import type { FabricControlState } from './types'
import { createSerializedFabricLifecycle } from './runtime-lifecycle'
import type { FabricExecutorAdapter } from './executors'
import { createConfiguredHealthFabricExecutorAdapters } from '../health-loop/executors/configuration'
import {
  createConfiguredCommerceExecutorAdapters,
  reconcileCommerceRuntime,
  stopCommerceRuntime,
} from '../commerce-autonomy/runtime'
import {
  createConfiguredLifeExecutorAdapters,
  reconcileLifeRuntime,
  stopLifeRuntime,
} from '../life-orchestration/runtime'
import { startHomeProductionRuntime, stopHomeProductionRuntime } from '../home/production-runtime'
import {
  reconcileInternetProductionRuntime,
  startInternetProductionRuntime,
  stopInternetProductionRuntime,
} from '../internet-execution/production-runtime'

const CONTROL_POLL_MS = 100
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

interface RunningRuntime {
  controlTimer: ReturnType<typeof setInterval>
  ownedAdapters: string[]
  appliedControlVersion: number
  controlPoll: Promise<void> | null
  homeStarted: boolean
  internetStarted: boolean
  commerceStarted: boolean
  lifeStarted: boolean
}

let running: RunningRuntime | null = null

const runtimeLifecycle = createSerializedFabricLifecycle({ start: bootstrapRuntime, stop: teardownRuntime })

export function isActionFabricRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const disabled = String(env.HERMES_ACTION_FABRIC_DISABLED ?? '').trim().toLowerCase()
  if (TRUE_VALUES.has(disabled)) return false
  if (FALSE_VALUES.has(disabled)) return true
  return String(env.NODE_ENV ?? '').trim().toLowerCase() !== 'test'
}

export function startActionFabricRuntime(): Promise<void> {
  if (!isActionFabricRuntimeEnabled()) return Promise.resolve()
  return runtimeLifecycle.start()
}

export function stopActionFabricRuntime(): Promise<void> {
  return runtimeLifecycle.stop()
}

/** Applies at least the requested durable control version before returning. */
export async function enforceControlStateOnce(version: number): Promise<{ applied: boolean; version: number }> {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('FABRIC_RUNTIME_CONTROL_VERSION_INVALID')
  const result = await enforceControlState(version)
  const state = running
  if (state && result.applied) {
    state.appliedControlVersion = Math.max(state.appliedControlVersion, result.version)
    if (state.internetStarted) await reconcileInternetProductionRuntime()
    if (state.commerceStarted) reconcileCommerceRuntime()
    if (state.lifeStarted) reconcileLifeRuntime()
  }
  return result
}

async function teardownRuntime(): Promise<void> {
  const state = running
  if (!state) return
  clearInterval(state.controlTimer)
  let failure: unknown = null
  if (state.controlPoll) {
    try { await state.controlPoll } catch (error) { failure = error }
  }
  try { await stopActionFabricWorker() } catch (error) { if (failure === null) failure = error }
  if (state.commerceStarted) {
    try { stopCommerceRuntime() } catch (error) { if (failure === null) failure = error }
  }
  if (state.lifeStarted) {
    try { stopLifeRuntime() } catch (error) { if (failure === null) failure = error }
  }
  if (state.internetStarted) {
    try { await stopInternetProductionRuntime() } catch (error) { if (failure === null) failure = error }
  }
  if (state.homeStarted) {
    try { await stopHomeProductionRuntime() } catch (error) { if (failure === null) failure = error }
  }
  for (const id of [...state.ownedAdapters].reverse()) unregisterFabricExecutorAdapter(id)
  if (running === state) running = null
  if (failure !== null) throw failure
}

async function bootstrapRuntime(): Promise<void> {
  const ownedAdapters: string[] = []
  let workerStarted = false
  let homeStarted = false
  let internetStarted = false
  let commerceStarted = false
  let lifeStarted = false
  try {
    // These migrations are deliberately complete before a worker can claim a lease.
    ensureBuiltInFabricRegistry()
    migrateAssistantRoleCapabilityEnforcement()
    registerOwnedAdapter(createSimulatorExecutorAdapter(), ownedAdapters)
    registerOwnedAdapter(createInternalPreferenceExecutorAdapter(), ownedAdapters)
    for (const adapter of createConfiguredHealthFabricExecutorAdapters()) registerOwnedAdapter(adapter, ownedAdapters)
    for (const adapter of createConfiguredCommerceExecutorAdapters()) registerOwnedAdapter(adapter, ownedAdapters)
    reconcileCommerceRuntime()
    commerceStarted = true
    for (const adapter of createConfiguredLifeExecutorAdapters()) registerOwnedAdapter(adapter, ownedAdapters)
    reconcileLifeRuntime()
    lifeStarted = true
    const homeAdapter = await startHomeProductionRuntime()
    homeStarted = true
    registerOwnedAdapter(homeAdapter, ownedAdapters)
    const internetAdapters = await startInternetProductionRuntime()
    internetStarted = true
    for (const adapter of internetAdapters) registerOwnedAdapter(adapter, ownedAdapters)
    const initialControl = getFabricControlState()
    const initialEnforcement = await enforceControlState(initialControl.version)
    startActionFabricWorker()
    workerStarted = true
    const state: RunningRuntime = {
      controlTimer: undefined as unknown as ReturnType<typeof setInterval>,
      ownedAdapters,
      appliedControlVersion: Math.max(initialControl.version, initialEnforcement.version),
      controlPoll: null,
      homeStarted,
      internetStarted,
      commerceStarted,
      lifeStarted,
    }
    state.controlTimer = setInterval(() => pollControl(state), CONTROL_POLL_MS)
    state.controlTimer.unref?.()
    running = state
  } catch (error) {
    if (workerStarted) { try { await stopActionFabricWorker() } catch { /* preserve the startup failure */ } }
    if (internetStarted) { try { await stopInternetProductionRuntime() } catch { /* preserve the startup failure */ } }
    if (commerceStarted) { try { stopCommerceRuntime() } catch { /* preserve the startup failure */ } }
    if (lifeStarted) { try { stopLifeRuntime() } catch { /* preserve the startup failure */ } }
    if (homeStarted) { try { await stopHomeProductionRuntime() } catch { /* preserve the startup failure */ } }
    for (const id of ownedAdapters.reverse()) unregisterFabricExecutorAdapter(id)
    throw error
  }
}

function registerOwnedAdapter(
  adapter: FabricExecutorAdapter,
  owned: string[],
): void {
  try {
    registerFabricExecutorAdapter(adapter)
    owned.push(adapter.id)
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'FABRIC_EXECUTOR_ADAPTER_EXISTS') throw error
  }
}

function pollControl(state: RunningRuntime): void {
  if (running !== state || state.controlPoll) return
  const poll = (async () => {
    const control = getFabricControlState()
    if (control.version === state.appliedControlVersion && control.level < 2) return
    const controlChanged = control.version !== state.appliedControlVersion
    const result = await enforceControlState(control.version)
    if (result.applied) {
      state.appliedControlVersion = Math.max(state.appliedControlVersion, result.version)
      if (controlChanged && state.internetStarted) await reconcileInternetProductionRuntime()
      if (controlChanged && state.commerceStarted) reconcileCommerceRuntime()
      if (controlChanged && state.lifeStarted) reconcileLifeRuntime()
    }
  })().catch(error => {
    logger.error({ errorClass: stableErrorClass(error) }, '[action-fabric] control enforcement failed')
  }).finally(() => {
    if (state.controlPoll === poll) state.controlPoll = null
  })
  state.controlPoll = poll
}

async function enforceControlState(targetVersion: number): Promise<{ applied: boolean; version: number }> {
  const result = withFabricAuditedTransaction(db => {
    const control = getFabricControlStateInDb(db)
    if (control.version < targetVersion) return { applied: false, version: control.version, revoke: false }
    if (control.level >= 2) moveIdleNonInterruptibleWorkToWaitingUser(db, control)
    if (control.level >= 3) disableExternalWriteExecutors(db, control)
    return { applied: true, version: control.version, revoke: control.level >= 3 }
  })
  if (result.revoke) {
    await revokeExternalCredentialsSafely()
    const latest = getFabricControlState()
    if (latest.version !== result.version || latest.level < 3) {
      return { applied: true, version: latest.version }
    }
  }
  return { applied: result.applied, version: result.version }
}

function moveIdleNonInterruptibleWorkToWaitingUser(db: DatabaseSync, control: FabricControlState): void {
  const rows = db.prepare(`SELECT w.id,e.type,e.configuration_json FROM fabric_workflows w
    JOIN fabric_executors e ON e.id=w.executor_id
    WHERE w.state IN ('preparing','executing','verifying','retrying')
    AND w.lease_owner IS NULL ORDER BY w.id`).all() as Array<{
      id: string; type: string; configuration_json: string
    }>
  const now = new Date().toISOString()
  for (const row of rows) {
    if (isInterruptible(row.type, row.configuration_json)) continue
    const changed = db.prepare(`UPDATE fabric_workflows SET state='waiting_user',version=version+1,
      retry_at=NULL,last_error_code='FABRIC_CONTROL_CHANGED_REVIEW_REQUIRED',updated_at=?
      WHERE id=? AND state IN ('preparing','executing','verifying','retrying') AND lease_owner IS NULL`).run(now, row.id)
    if (changed.changes !== 1) continue
    db.prepare(`UPDATE fabric_steps SET state='waiting_user',last_error_code='FABRIC_CONTROL_CHANGED_REVIEW_REQUIRED',
      updated_at=? WHERE workflow_id=? AND state IN ('pending','running')`).run(now, row.id)
    appendFabricAuditEvent(db, { eventType: 'workflow.control_checkpoint_required',
      actorUserId: control.actorUserId ?? 'action-fabric-runtime', aggregateType: 'workflow', aggregateId: row.id,
      payload: { controlLevel: control.level, controlVersion: control.version }, occurredAt: now })
    appendFabricOutbox(db, 'fabric.workflow.control_checkpoint_required', row.id,
      { controlLevel: control.level, controlVersion: control.version })
  }
}

function disableExternalWriteExecutors(db: DatabaseSync, control: FabricControlState): void {
  const rows = db.prepare('SELECT id,type,configuration_json FROM fabric_executors WHERE enabled=1 ORDER BY id').all() as
    Array<{ id: string; type: string; configuration_json: string }>
  const now = new Date().toISOString()
  for (const row of rows) {
    if (!isExternalWriteExecutor(row.type, row.configuration_json)) continue
    const changed = db.prepare(`UPDATE fabric_executors SET enabled=0,policy_version=policy_version+1,updated_at=?
      WHERE id=? AND enabled=1`).run(now, row.id)
    if (changed.changes !== 1) continue
    bumpRegistryPolicyRevision(db)
    appendFabricAuditEvent(db, { eventType: 'executor.external_write.disabled',
      actorUserId: control.actorUserId ?? 'action-fabric-runtime', aggregateType: 'executor', aggregateId: row.id,
      payload: { controlLevel: control.level, controlVersion: control.version }, occurredAt: now })
    appendFabricOutbox(db, 'fabric.executor.external_write.disabled', row.id,
      { controlLevel: control.level, controlVersion: control.version })
  }
}

function isInterruptible(type: string, configurationJson: string): boolean {
  if (type === 'simulator') return true
  if (!['internal', 'connector', 'mcp', 'browser', 'android'].includes(type)) return false
  return readBooleanMetadata(configurationJson, 'interruptible') === true
}

function isExternalWriteExecutor(type: string, configurationJson: string): boolean {
  if (!['simulator', 'internal', 'connector', 'mcp', 'browser', 'android'].includes(type)) return true
  // Known executor classes may remain active only with an explicit validated local-only declaration.
  return readBooleanMetadata(configurationJson, 'externalWrite') !== false
}

function readBooleanMetadata(value: string, key: string): boolean | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const metadata = (parsed as Record<string, unknown>)[key]
    return typeof metadata === 'boolean' ? metadata : null
  } catch {
    return null
  }
}

function bumpRegistryPolicyRevision(db: DatabaseSync): void {
  const row = db.prepare("SELECT value FROM fabric_meta WHERE key='registry_policy_revision'").get() as
    { value: string } | undefined
  const current = Number(row?.value ?? 0)
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error('FABRIC_REGISTRY_POLICY_REVISION_INVALID')
  }
  db.prepare(`INSERT INTO fabric_meta(key,value) VALUES('registry_policy_revision',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(current + 1))
}

async function revokeExternalCredentialsSafely(): Promise<void> {
  // Phase 3 has no external credential providers. This stable hook is intentionally a safe no-op.
}

function stableErrorClass(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{1,127}$/.test(error.message)
    ? error.message : 'FABRIC_RUNTIME_CONTROL_FAILED'
}

import { isDeepStrictEqual } from 'node:util'
import { getFabricControlState } from '../action-fabric/control'
import type { FabricExecutorAdapter } from '../action-fabric/executors'
import { listFabricExecutors, setFabricExecutorEnabled, updateFabricExecutorHealth } from '../action-fabric/registry'
import {
  LIFE_LIVE_EXECUTOR_ID,
  LIFE_SHADOW_EXECUTOR_ID,
  LIFE_SOURCE_EXECUTOR_ID,
} from './activation-service'
import { clearLifeAssistantAuthorization, refreshLifeAssistantAuthorizations } from './authorization'
import { isLifeCurrency, isLifeSemanticId, LifeContractError } from './contracts'
import { createLifeExecutorAdapter } from './executor'
import type { LifeSourceAdapter } from './provider'
import { getLifeSubscription, listLifePlanRevisions, listLifeSourceAccounts } from './store'

export interface LifeRuntimeBinding {
  accountId: string
  provider: LifeSourceAdapter
  currency: string
  subscriptionIds: string[]
}

export interface LifeRuntimeStatus {
  configuredAccountCount: number
  sourceExecutorEnabled: boolean
  shadowExecutorEnabled: boolean
  liveExecutorEnabled: boolean
  authorizedTargetCount: number
  emergencyStopped: boolean
}

let bindings = new Map<string, LifeRuntimeBinding>()
let status: LifeRuntimeStatus = { configuredAccountCount: 0, sourceExecutorEnabled: false,
  shadowExecutorEnabled: false, liveExecutorEnabled: false, authorizedTargetCount: 0, emergencyStopped: false }

/** Server-only configuration entrypoint. Adapter credential closures never leave this module. */
export function configureLifeRuntimeBindings(value: readonly LifeRuntimeBinding[] | null): void {
  const next = new Map<string, LifeRuntimeBinding>()
  for (const binding of value ?? []) {
    if (!isLifeSemanticId(binding.accountId) || next.has(binding.accountId)
      || !binding.provider || typeof binding.provider !== 'object' || !isLifeCurrency(binding.currency)
      || !Array.isArray(binding.subscriptionIds) || binding.subscriptionIds.length > 64
      || binding.subscriptionIds.some(id => !isLifeSemanticId(id))) {
      throw new LifeContractError('LIFE_RUNTIME_BINDING_INVALID')
    }
    const subscriptionIds = [...binding.subscriptionIds].sort(compare)
    if (subscriptionIds.some((id, index) => index > 0 && id === subscriptionIds[index - 1])) {
      throw new LifeContractError('LIFE_RUNTIME_BINDING_INVALID')
    }
    next.set(binding.accountId, { ...binding, subscriptionIds })
  }
  bindings = next
}

export function createConfiguredLifeExecutorAdapters(): readonly FabricExecutorAdapter[] {
  const providerForAccount = (accountId: string) => bindings.get(accountId)?.provider ?? null
  return [
    createLifeExecutorAdapter({ id: LIFE_SOURCE_EXECUTOR_ID, providerForAccount }),
    createLifeExecutorAdapter({ id: LIFE_SHADOW_EXECUTOR_ID, providerForAccount }),
    createLifeExecutorAdapter({ id: LIFE_LIVE_EXECUTOR_ID, providerForAccount }),
  ]
}

export function reconcileLifeRuntime(): LifeRuntimeStatus {
  const controlStopped = getFabricControlState().level >= 3
  if (bindings.size === 0 && pristineLifeExecutors()) {
    clearLifeAssistantAuthorization()
    status = { configuredAccountCount: 0, sourceExecutorEnabled: false, shadowExecutorEnabled: false,
      liveExecutorEnabled: false, authorizedTargetCount: 0, emergencyStopped: controlStopped }
    return { ...status }
  }
  const plans = listLifePlanRevisions({ limit: 200 }).filter(plan => ['proposed', 'reserved'].includes(plan.state))
  const authorized: Parameters<typeof refreshLifeAssistantAuthorizations>[0] = []
  let sourceReady = false
  let shadowReady = false
  let liveReady = false
  for (const account of listLifeSourceAccounts(200)) {
    const binding = bindings.get(account.id)
    if (!binding || !account.enabled || account.health === 'revoked' || account.health === 'unhealthy'
      || binding.provider.sourceKind !== account.sourceKind) continue
    const expectedExecutor = account.mode === 'live' ? LIFE_LIVE_EXECUTOR_ID
      : account.mode === 'shadow' ? LIFE_SHADOW_EXECUTOR_ID : LIFE_SOURCE_EXECUTOR_ID
    const transportReady = account.mode === 'live' ? binding.provider.transport === 'external'
      : account.mode === 'shadow' ? binding.provider.transport === 'virtual' : true
    const subscriptionsReady = binding.subscriptionIds.every(id => getLifeSubscription(id)?.accountId === account.id)
    if (account.executorId !== expectedExecutor || !transportReady || !subscriptionsReady) continue
    if (account.mode === 'live') {
      if (account.health !== 'healthy' || controlStopped) continue
      liveReady = true
    } else if (account.mode === 'shadow') shadowReady = true
    else sourceReady = true
    authorized.push({ accountId: account.id, sourceKind: account.sourceKind, mode: account.mode,
      currency: binding.currency, calendarIds: account.sourceKind === 'calendar' ? [account.id] : [],
      subscriptionIds: account.sourceKind === 'subscriptions' ? binding.subscriptionIds : [],
      planDigests: plans.filter(plan => plan.totalCost.currency === binding.currency).map(plan => plan.planDigest) })
  }
  setAvailability(LIFE_SOURCE_EXECUTOR_ID, sourceReady, sourceReady ? 'healthy' : 'degraded', {
    lifecycle: sourceReady ? 'ready' : 'not_ready', configuredAccounts: authorized.filter(a => a.mode === 'observe').length,
  })
  setAvailability(LIFE_SHADOW_EXECUTOR_ID, shadowReady, shadowReady ? 'healthy' : 'degraded', {
    lifecycle: shadowReady ? 'ready' : 'not_ready', configuredAccounts: authorized.filter(a => a.mode === 'shadow').length,
  })
  setAvailability(LIFE_LIVE_EXECUTOR_ID, liveReady && !controlStopped,
    liveReady && !controlStopped ? 'healthy' : 'degraded', {
      lifecycle: controlStopped ? 'emergency_stopped' : liveReady ? 'ready' : 'not_ready',
      configuredAccounts: authorized.filter(a => a.mode === 'live').length,
    })
  const targets = authorized.length > 0 ? refreshLifeAssistantAuthorizations(authorized) : (() => {
    clearLifeAssistantAuthorization(); return []
  })()
  status = { configuredAccountCount: authorized.length, sourceExecutorEnabled: sourceReady,
    shadowExecutorEnabled: shadowReady, liveExecutorEnabled: liveReady && !controlStopped,
    authorizedTargetCount: targets.length, emergencyStopped: controlStopped }
  return { ...status }
}

export function stopLifeRuntime(): void {
  clearLifeAssistantAuthorization()
  if (!pristineLifeExecutors()) {
    setAvailability(LIFE_SOURCE_EXECUTOR_ID, false, 'degraded', { lifecycle: 'stopped' })
    setAvailability(LIFE_SHADOW_EXECUTOR_ID, false, 'degraded', { lifecycle: 'stopped' })
    setAvailability(LIFE_LIVE_EXECUTOR_ID, false, 'degraded', { lifecycle: 'stopped' })
  }
  status = { configuredAccountCount: 0, sourceExecutorEnabled: false, shadowExecutorEnabled: false,
    liveExecutorEnabled: false, authorizedTargetCount: 0, emergencyStopped: false }
}

export function getLifeRuntimeStatus(): LifeRuntimeStatus { return { ...status } }
export function getConfiguredLifeProvider(accountId: string): LifeSourceAdapter | null {
  return bindings.get(accountId)?.provider ?? null
}

function setAvailability(executorId: string, enabled: boolean, health: 'healthy' | 'degraded',
  details: Record<string, unknown>): void {
  const current = listFabricExecutors().find(item => item.id === executorId)
  if (!current) throw new LifeContractError('LIFE_RUNTIME_EXECUTOR_MISSING')
  if (current.enabled !== enabled) setFabricExecutorEnabled(executorId, enabled)
  const latest = listFabricExecutors().find(item => item.id === executorId)
  if (!latest) throw new LifeContractError('LIFE_RUNTIME_EXECUTOR_MISSING')
  if (latest.health !== health || !isDeepStrictEqual(latest.healthDetails, details)) {
    updateFabricExecutorHealth(executorId, health, details)
  }
}

function pristineLifeExecutors(): boolean {
  const ids = new Set([LIFE_SOURCE_EXECUTOR_ID, LIFE_SHADOW_EXECUTOR_ID, LIFE_LIVE_EXECUTOR_ID])
  const executors = listFabricExecutors().filter(item => ids.has(item.id))
  return executors.length === ids.size && executors.every(item => !item.enabled)
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

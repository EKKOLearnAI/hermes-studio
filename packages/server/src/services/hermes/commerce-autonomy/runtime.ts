import { isDeepStrictEqual } from 'node:util'
import { getFabricControlState } from '../action-fabric/control'
import type { FabricExecutorAdapter } from '../action-fabric/executors'
import { listFabricExecutors, setFabricExecutorEnabled, updateFabricExecutorHealth } from '../action-fabric/registry'
import { clearCommerceAssistantAuthorization, refreshCommerceAssistantAuthorizations } from './authorization'
import { COMMERCE_LIVE_EXECUTOR_ID, COMMERCE_SHADOW_EXECUTOR_ID } from './activation-service'
import { createCommerceExecutorAdapter } from './executor'
import type { CommerceProviderAdapter } from './provider'
import { listCommerceAccounts } from './store'

export interface CommerceRuntimeBinding {
  accountId: string
  provider: CommerceProviderAdapter
  merchantIds: string[]
  destinationDigests: string[]
}

export interface CommerceRuntimeStatus {
  configuredAccountCount: number
  shadowExecutorEnabled: boolean
  liveExecutorEnabled: boolean
  authorizedTargetCount: number
  emergencyStopped: boolean
}

let bindings = new Map<string, CommerceRuntimeBinding>()
let status: CommerceRuntimeStatus = { configuredAccountCount: 0, shadowExecutorEnabled: false,
  liveExecutorEnabled: false, authorizedTargetCount: 0, emergencyStopped: false }

/** Server-only configuration entrypoint. Provider credentials remain inside each adapter. */
export function configureCommerceRuntimeBindings(value: readonly CommerceRuntimeBinding[] | null): void {
  const next = new Map<string, CommerceRuntimeBinding>()
  for (const binding of value ?? []) {
    if (next.has(binding.accountId) || binding.provider === null || typeof binding.provider !== 'object') {
      throw new Error('COMMERCE_RUNTIME_BINDING_INVALID')
    }
    next.set(binding.accountId, { ...binding, merchantIds: [...binding.merchantIds],
      destinationDigests: [...binding.destinationDigests] })
  }
  bindings = next
}

export function createConfiguredCommerceExecutorAdapters(): readonly FabricExecutorAdapter[] {
  const providerForAccount = (accountId: string) => bindings.get(accountId)?.provider ?? null
  return [
    createCommerceExecutorAdapter({ id: COMMERCE_SHADOW_EXECUTOR_ID, providerForAccount }),
    createCommerceExecutorAdapter({ id: COMMERCE_LIVE_EXECUTOR_ID, providerForAccount }),
  ]
}

export function reconcileCommerceRuntime(): CommerceRuntimeStatus {
  const controlStopped = getFabricControlState().level >= 3
  if (bindings.size === 0 && pristineCommerceExecutors()) {
    clearCommerceAssistantAuthorization()
    status = { configuredAccountCount: 0, shadowExecutorEnabled: false,
      liveExecutorEnabled: false, authorizedTargetCount: 0, emergencyStopped: controlStopped }
    return { ...status }
  }
  const accounts = listCommerceAccounts(200)
  const authorized: Parameters<typeof refreshCommerceAssistantAuthorizations>[0] = []
  let shadowReady = false
  let liveReady = false
  for (const account of accounts) {
    const binding = bindings.get(account.id)
    if (!binding || !account.enabled || account.health === 'revoked' || binding.provider.provider !== account.provider) continue
    const expectedExecutor = account.mode === 'live' ? COMMERCE_LIVE_EXECUTOR_ID : COMMERCE_SHADOW_EXECUTOR_ID
    const executorBound = account.mode === 'observe' ? account.executorId === null : account.executorId === expectedExecutor
    const transportReady = account.mode === 'live' ? binding.provider.transport === 'external'
      : binding.provider.transport === 'virtual' || account.mode === 'observe'
    if (!executorBound || !transportReady) continue
    if (account.mode === 'live') {
      if (account.health !== 'healthy' || controlStopped) continue
      liveReady = true
    } else shadowReady = true
    authorized.push({ accountId: account.id, provider: account.provider, currency: account.currency,
      mode: account.mode, merchantIds: binding.merchantIds, destinationDigests: binding.destinationDigests })
  }
  setAvailability(COMMERCE_SHADOW_EXECUTOR_ID, shadowReady, shadowReady ? 'healthy' : 'degraded', {
    lifecycle: shadowReady ? 'ready' : 'not_ready', configuredAccounts: authorized.length,
  })
  setAvailability(COMMERCE_LIVE_EXECUTOR_ID, liveReady && !controlStopped,
    liveReady && !controlStopped ? 'healthy' : 'degraded', {
      lifecycle: controlStopped ? 'emergency_stopped' : liveReady ? 'ready' : 'not_ready',
      configuredAccounts: authorized.filter(item => item.mode === 'live').length,
    })
  let targets: string[] = []
  if (authorized.length > 0) targets = refreshCommerceAssistantAuthorizations(authorized)
  else clearCommerceAssistantAuthorization()
  status = { configuredAccountCount: authorized.length, shadowExecutorEnabled: shadowReady,
    liveExecutorEnabled: liveReady && !controlStopped, authorizedTargetCount: targets.length,
    emergencyStopped: controlStopped }
  return { ...status }
}

export function stopCommerceRuntime(): void {
  clearCommerceAssistantAuthorization()
  if (!pristineCommerceExecutors()) {
    setAvailability(COMMERCE_SHADOW_EXECUTOR_ID, false, 'degraded', { lifecycle: 'stopped' })
    setAvailability(COMMERCE_LIVE_EXECUTOR_ID, false, 'degraded', { lifecycle: 'stopped' })
  }
  status = { configuredAccountCount: 0, shadowExecutorEnabled: false,
    liveExecutorEnabled: false, authorizedTargetCount: 0, emergencyStopped: false }
}

export function getCommerceRuntimeStatus(): CommerceRuntimeStatus { return { ...status } }

/** Server-only lookup for semantic read operations. The adapter, including any credential closure,
 * must never be serialized or returned by an HTTP controller. */
export function getConfiguredCommerceProvider(accountId: string): CommerceProviderAdapter | null {
  return bindings.get(accountId)?.provider ?? null
}

function setAvailability(
  executorId: string,
  enabled: boolean,
  health: 'healthy' | 'degraded',
  details: Record<string, unknown>,
): void {
  const current = listFabricExecutors().find(item => item.id === executorId)
  if (!current) throw new Error('COMMERCE_RUNTIME_EXECUTOR_MISSING')
  if (current.enabled !== enabled) setFabricExecutorEnabled(executorId, enabled)
  const latest = listFabricExecutors().find(item => item.id === executorId)
  if (!latest) throw new Error('COMMERCE_RUNTIME_EXECUTOR_MISSING')
  if (latest.health !== health || !isDeepStrictEqual(latest.healthDetails, details)) {
    updateFabricExecutorHealth(executorId, health, details)
  }
}

function pristineCommerceExecutors(): boolean {
  const executors = listFabricExecutors().filter(item =>
    item.id === COMMERCE_SHADOW_EXECUTOR_ID || item.id === COMMERCE_LIVE_EXECUTOR_ID)
  return executors.length === 2 && executors.every(item => !item.enabled)
}

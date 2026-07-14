import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { getFabricControlState } from '../action-fabric/control'
import type { FabricExecutorAdapter } from '../action-fabric/executors'
import {
  listFabricExecutors,
  setFabricExecutorEnabled,
  updateFabricExecutorHealth,
} from '../action-fabric/registry'
import { getActiveProfileName } from '../hermes-profile'
import { getPersonalTwinDbPath, initPersonalTwinSchema } from '../personal-twin/database'
import { clearHomeManagerAuthorization, refreshHomeManagerAuthorization } from './authorization'
import { createHomeAssistantCommandExecutorAdapter, type HomeAssistantCommandTransport } from './command-executor'
import { HomeAssistantClient } from './home-assistant-client'
import {
  resolveHomeAssistantConfig,
  type ResolvedHomeAssistantConfig,
} from './home-assistant-config'
import {
  HomeAssistantRuntime,
  type HomeAssistantRuntimeClient,
  type HomeAssistantRuntimeStatus,
} from './home-assistant-runtime'
import { HomeTwinStore } from './store'

const EXECUTOR_ID = 'home-assistant'
const DEFAULT_POLL_MS = 1_000

export interface HomeProductionClient extends HomeAssistantRuntimeClient, HomeAssistantCommandTransport {}

export interface HomeProductionObservation {
  getStatus(): HomeAssistantRuntimeStatus
  run(signal: AbortSignal): Promise<void>
}

export interface HomeProductionRuntimeStatus {
  active: boolean
  profile: string
  configured: boolean
  credentialFingerprint: string | null
  connectionStatus: HomeAssistantRuntimeStatus['connectionStatus'] | 'stopped' | 'unconfigured'
  executorEnabled: boolean
  authorizedTargetCount: number
  lastErrorCode: string | null
}

export interface HomeProductionRuntimeDependencies {
  activeProfile?: () => string
  resolveConfig?: (profile: string) => Promise<ResolvedHomeAssistantConfig | null>
  openStore?: () => { store: HomeTwinStore; close(): void }
  createClient?: (config: ResolvedHomeAssistantConfig) => HomeProductionClient
  createObservation?: (
    config: ResolvedHomeAssistantConfig,
    store: HomeTwinStore,
    client: HomeProductionClient,
  ) => HomeProductionObservation
  pollIntervalMs?: number
}

class RotatingCommandTransport implements HomeAssistantCommandTransport {
  private client: HomeProductionClient | null = null
  private readonly active = new Set<AbortController>()

  replace(client: HomeProductionClient | null): void {
    this.client = client
    for (const controller of this.active) controller.abort()
    this.active.clear()
  }

  callService(domain: string, service: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown[]> {
    if (!this.client) return Promise.reject(new Error('HOME_ASSISTANT_CREDENTIAL_UNAVAILABLE'))
    const client = this.client
    return this.invoke(abort => client.callService(domain, service, data, abort), signal)
  }

  fetchState(entityId: string, signal?: AbortSignal): Promise<unknown> {
    if (!this.client) return Promise.reject(new Error('HOME_ASSISTANT_CREDENTIAL_UNAVAILABLE'))
    const client = this.client
    return this.invoke(abort => client.fetchState(entityId, abort), signal)
  }

  private invoke<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    this.active.add(controller)
    return operation(controller.signal).finally(() => {
      this.active.delete(controller)
      signal?.removeEventListener('abort', abort)
    })
  }
}

export class HomeProductionRuntime {
  private readonly dependencies: Required<Pick<HomeProductionRuntimeDependencies,
    'activeProfile' | 'resolveConfig' | 'openStore' | 'createClient' | 'createObservation'>>
    & Pick<HomeProductionRuntimeDependencies, 'pollIntervalMs'>
  private readonly transport = new RotatingCommandTransport()
  private resource: { store: HomeTwinStore; close(): void } | null = null
  private adapter: FabricExecutorAdapter | null = null
  private config: ResolvedHomeAssistantConfig | null = null
  private observation: HomeProductionObservation | null = null
  private observationAbort: AbortController | null = null
  private observationRun: Promise<void> | null = null
  private observationFailure: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private poll: Promise<void> | null = null
  private tail = Promise.resolve()
  private current: HomeProductionRuntimeStatus = {
    active: false,
    profile: 'default',
    configured: false,
    credentialFingerprint: null,
    connectionStatus: 'stopped',
    executorEnabled: false,
    authorizedTargetCount: 0,
    lastErrorCode: null,
  }

  constructor(dependencies: HomeProductionRuntimeDependencies = {}) {
    this.dependencies = {
      activeProfile: dependencies.activeProfile ?? getActiveProfileName,
      resolveConfig: dependencies.resolveConfig ?? resolveHomeAssistantConfig,
      openStore: dependencies.openStore ?? openHomeStore,
      createClient: dependencies.createClient ?? (config => new HomeAssistantClient(config)),
      createObservation: dependencies.createObservation
        ?? ((config, store, client) => new HomeAssistantRuntime(config, store, { client })),
      pollIntervalMs: dependencies.pollIntervalMs,
    }
  }

  start(): Promise<FabricExecutorAdapter> {
    return this.queue(async () => {
      if (this.current.active && this.adapter) return this.adapter
      this.resource = this.dependencies.openStore()
      this.adapter = createHomeAssistantCommandExecutorAdapter({
        store: this.resource.store,
        transport: this.transport,
      })
      this.current = { ...this.current, active: true, profile: this.dependencies.activeProfile(),
        connectionStatus: 'unconfigured', lastErrorCode: null }
      try {
        await this.reconcileNow()
        this.timer = setInterval(() => this.scheduleReconcile(), this.pollInterval())
        this.timer.unref?.()
        return this.adapter
      } catch (error) {
        await this.stopInternal(stableErrorCode(error, 'HOME_PRODUCTION_RUNTIME_START_FAILED'))
        throw error
      }
    })
  }

  stop(): Promise<void> {
    return this.queue(() => this.stopInternal(null))
  }

  reconcile(): Promise<void> {
    return this.queue(async () => {
      if (!this.current.active) return
      await this.reconcileNow()
    })
  }

  getStatus(): HomeProductionRuntimeStatus { return { ...this.current } }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private scheduleReconcile(): void {
    if (!this.current.active || this.poll) return
    const poll = this.reconcile().catch(() => undefined).finally(() => {
      if (this.poll === poll) this.poll = null
    })
    this.poll = poll
  }

  private async reconcileNow(): Promise<void> {
    const profile = this.dependencies.activeProfile()
    let resolved: ResolvedHomeAssistantConfig | null
    try {
      resolved = await this.dependencies.resolveConfig(profile)
    } catch (error) {
      await this.makeUnavailable(profile, stableErrorCode(error, 'HOME_ASSISTANT_CONFIG_INVALID'))
      return
    }
    if (!resolved) {
      await this.makeUnavailable(profile, 'HOME_ASSISTANT_NOT_CONFIGURED')
      return
    }
    const changed = !this.config || this.config.profile !== resolved.profile
      || this.config.baseUrl !== resolved.baseUrl
      || this.config.credentialFingerprint !== resolved.credentialFingerprint
    if (changed) {
      await this.stopObservation()
      await this.setExecutorAvailability(false, 'degraded', {
        lifecycle: 'credential_transition', profile: resolved.profile,
      })
      const client = this.dependencies.createClient(resolved)
      this.transport.replace(client)
      this.config = resolved
      this.observation = this.dependencies.createObservation(resolved, this.requireStore(), client)
      this.observationAbort = new AbortController()
      this.observationFailure = null
      this.observationRun = this.observation.run(this.observationAbort.signal).catch(error => {
        this.observationFailure = stableErrorCode(error, 'HOME_ASSISTANT_RUNTIME_FAILED')
      })
    }
    const observation = this.observation?.getStatus()
    let targets: string[] = []
    try {
      targets = refreshHomeManagerAuthorization(this.requireStore())
    } catch (error) {
      await this.setExecutorAvailability(false, 'unhealthy', {
        lifecycle: 'authorization_failed', profile: resolved.profile,
        errorCode: stableErrorCode(error, 'HOME_RUNTIME_AUTHORIZATION_FAILED'),
      })
      this.current = {
        active: true, profile: resolved.profile, configured: true,
        credentialFingerprint: resolved.credentialFingerprint,
        connectionStatus: observation?.connectionStatus ?? 'unconfigured', executorEnabled: false,
        authorizedTargetCount: 0,
        lastErrorCode: stableErrorCode(error, 'HOME_RUNTIME_AUTHORIZATION_FAILED'),
      }
      return
    }
    const connectionStatus = observation?.connectionStatus ?? 'unconfigured'
    const ready = connectionStatus === 'connected' && targets.length > 0
      && this.observationFailure === null && getFabricControlState().level < 3
    const lastErrorCode = this.observationFailure ?? observation?.lastErrorCode
      ?? (targets.length === 0 ? 'HOME_ASSISTANT_BINDING_UNAVAILABLE' : null)
    await this.setExecutorAvailability(ready, ready ? 'healthy' : 'degraded', {
      lifecycle: ready ? 'ready' : 'not_ready', profile: resolved.profile,
      connectionStatus, ...(lastErrorCode ? { errorCode: lastErrorCode } : {}),
    })
    this.current = {
      active: true, profile: resolved.profile, configured: true,
      credentialFingerprint: resolved.credentialFingerprint,
      connectionStatus, executorEnabled: ready, authorizedTargetCount: targets.length, lastErrorCode,
    }
  }

  private async makeUnavailable(profile: string, errorCode: string): Promise<void> {
    const wasConfigured = this.config !== null || this.current.configured
      || listFabricExecutors().find(executor => executor.id === EXECUTOR_ID)?.enabled === true
    await this.stopObservation()
    let failure: unknown = null
    try { clearHomeManagerAuthorization() } catch (error) { failure = error }
    if (wasConfigured) {
      try {
        await this.setExecutorAvailability(false, 'unhealthy', {
          lifecycle: 'unavailable', profile, errorCode,
        })
      } catch (error) { if (failure === null) failure = error }
    }
    this.current = {
      active: true, profile, configured: false, credentialFingerprint: null,
      connectionStatus: 'unconfigured', executorEnabled: false, authorizedTargetCount: 0, lastErrorCode: errorCode,
    }
    if (failure !== null) throw failure
  }

  private async stopInternal(errorCode: string | null): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.poll) { await this.poll; this.poll = null }
    let failure: unknown = null
    if (this.resource) {
      const wasConfigured = this.config !== null || this.current.configured
        || listFabricExecutors().find(executor => executor.id === EXECUTOR_ID)?.enabled === true
      try { await this.stopObservation() } catch (error) { failure = error }
      try { clearHomeManagerAuthorization() } catch (error) { if (failure === null) failure = error }
      if (wasConfigured) {
        try {
          await this.setExecutorAvailability(false, 'unhealthy', {
            lifecycle: 'stopped', profile: this.current.profile,
          })
        } catch (error) { if (failure === null) failure = error }
      }
      try { this.resource.close() } catch (error) { if (failure === null) failure = error }
    }
    this.resource = null
    this.adapter = null
    this.current = {
      active: false, profile: this.current.profile, configured: false, credentialFingerprint: null,
      connectionStatus: 'stopped', executorEnabled: false, authorizedTargetCount: 0, lastErrorCode: errorCode,
    }
    if (failure !== null) throw failure
  }

  private async stopObservation(): Promise<void> {
    this.transport.replace(null)
    this.observationAbort?.abort()
    if (this.observationRun) await this.observationRun
    this.observationAbort = null
    this.observationRun = null
    this.observation = null
    this.observationFailure = null
    this.config = null
  }

  private async setExecutorAvailability(
    enabled: boolean,
    health: 'healthy' | 'degraded' | 'unhealthy',
    details: Record<string, unknown>,
  ): Promise<void> {
    const current = listFabricExecutors().find(executor => executor.id === EXECUTOR_ID)
    if (!current) throw new Error('HOME_ASSISTANT_EXECUTOR_MISSING')
    if (enabled && !current.enabled) setFabricExecutorEnabled(EXECUTOR_ID, true)
    if (!enabled && current.enabled) setFabricExecutorEnabled(EXECUTOR_ID, false)
    const latest = listFabricExecutors().find(executor => executor.id === EXECUTOR_ID)
    if (!latest) throw new Error('HOME_ASSISTANT_EXECUTOR_MISSING')
    if (latest.health !== health || !isDeepStrictEqual(latest.healthDetails, details)) {
      updateFabricExecutorHealth(EXECUTOR_ID, health, details)
    }
  }

  private requireStore(): HomeTwinStore {
    if (!this.resource) throw new Error('HOME_PRODUCTION_RUNTIME_NOT_STARTED')
    return this.resource.store
  }

  private pollInterval(): number {
    const value = this.dependencies.pollIntervalMs ?? DEFAULT_POLL_MS
    return Number.isSafeInteger(value) && value >= 100 && value <= 60_000 ? value : DEFAULT_POLL_MS
  }
}

const productionRuntime = new HomeProductionRuntime()

export function startHomeProductionRuntime(): Promise<FabricExecutorAdapter> { return productionRuntime.start() }
export function stopHomeProductionRuntime(): Promise<void> { return productionRuntime.stop() }
export function reconcileHomeProductionRuntime(): Promise<void> { return productionRuntime.reconcile() }
export function getHomeProductionRuntimeStatus(): HomeProductionRuntimeStatus { return productionRuntime.getStatus() }

function openHomeStore(): { store: HomeTwinStore; close(): void } {
  const path = getPersonalTwinDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA journal_mode = WAL')
    initPersonalTwinSchema(database)
  } catch (error) {
    database.close()
    throw error
  }
  return { store: new HomeTwinStore(database), close: () => database.close() }
}

function stableErrorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,127}$/.test(error.message)) return error.message
  return fallback
}

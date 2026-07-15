import { isDeepStrictEqual } from 'node:util'
import { getFabricControlState } from '../action-fabric/control'
import type { FabricExecutorAdapter } from '../action-fabric/executors'
import {
  listFabricExecutors,
  setFabricExecutorEnabled,
  updateFabricExecutorHealth,
} from '../action-fabric/registry'
import { getActiveProfileName } from '../hermes-profile'
import { clearEntertainmentInternetAuthorization, refreshEntertainmentInternetAuthorization } from './authorization'
import { createInternetMcpExecutorAdapter } from './mcp-executor'
import { discoverBilibiliMcpBinding, type BilibiliMcpDiscovery } from './mcp-discovery'

export const BILIBILI_MCP_EXECUTOR_ID = 'bilibili-mcp'
const DEFAULT_POLL_MS = 1_000

export interface InternetProductionRuntimeStatus {
  active: boolean
  profile: string
  configured: boolean
  discoveryStatus: BilibiliMcpDiscovery['status'] | 'stopped'
  executorEnabled: boolean
  authorizedTargetCount: number
  lastErrorCode: string | null
}

export interface InternetProductionRuntimeDependencies {
  activeProfile?: () => string
  discover?: (profile: string) => Promise<BilibiliMcpDiscovery>
  controlLevel?: () => number
  createAdapter?: () => FabricExecutorAdapter
  pollIntervalMs?: number
}

export class InternetProductionRuntime {
  private readonly dependencies: Required<Pick<InternetProductionRuntimeDependencies,
    'activeProfile' | 'discover' | 'controlLevel' | 'createAdapter'>>
    & Pick<InternetProductionRuntimeDependencies, 'pollIntervalMs'>
  private adapter: FabricExecutorAdapter | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private poll: Promise<void> | null = null
  private tail = Promise.resolve()
  private current: InternetProductionRuntimeStatus = {
    active: false,
    profile: 'default',
    configured: false,
    discoveryStatus: 'stopped',
    executorEnabled: false,
    authorizedTargetCount: 0,
    lastErrorCode: null,
  }

  constructor(dependencies: InternetProductionRuntimeDependencies = {}) {
    this.dependencies = {
      activeProfile: dependencies.activeProfile ?? getActiveProfileName,
      discover: dependencies.discover ?? discoverBilibiliMcpBinding,
      controlLevel: dependencies.controlLevel ?? (() => getFabricControlState().level),
      createAdapter: dependencies.createAdapter ?? (() => createInternetMcpExecutorAdapter({
        id: BILIBILI_MCP_EXECUTOR_ID,
        environment: 'production',
      })),
      pollIntervalMs: dependencies.pollIntervalMs,
    }
  }

  start(): Promise<FabricExecutorAdapter> {
    return this.queue(async () => {
      if (this.current.active && this.adapter) return this.adapter
      const adapter = this.dependencies.createAdapter()
      if (adapter.id !== BILIBILI_MCP_EXECUTOR_ID || adapter.type !== 'mcp') {
        throw new Error('INTERNET_PRODUCTION_ADAPTER_INVALID')
      }
      this.adapter = adapter
      this.current = { ...this.current, active: true, profile: this.dependencies.activeProfile(),
        discoveryStatus: 'unavailable', lastErrorCode: null }
      try {
        await this.reconcileNow()
        this.timer = setInterval(() => this.scheduleReconcile(), this.pollInterval())
        this.timer.unref?.()
        return adapter
      } catch (error) {
        await this.stopInternal(stableErrorCode(error, 'INTERNET_PRODUCTION_RUNTIME_START_FAILED'))
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

  getStatus(): InternetProductionRuntimeStatus { return { ...this.current } }

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
    let discovery: BilibiliMcpDiscovery
    try {
      discovery = await this.dependencies.discover(profile)
    } catch (error) {
      await this.makeUnavailable(profile, stableErrorCode(error, 'MCP_DISCOVERY_UNAVAILABLE'))
      return
    }
    const controlStopped = this.dependencies.controlLevel() >= 3
    const ready = discovery.status === 'healthy' && !controlStopped
    let targets: string[] = []
    try {
      if (ready) targets = refreshEntertainmentInternetAuthorization(profile)
      else clearEntertainmentInternetAuthorization()
    } catch (error) {
      await this.makeUnavailable(profile, stableErrorCode(error, 'INTERNET_AUTHORIZATION_FAILED'))
      return
    }
    const errorCode = controlStopped ? 'FABRIC_EMERGENCY_STOP_ACTIVE' : discovery.errorCode
    const health = ready ? 'healthy' : discovery.status === 'degraded' || controlStopped ? 'degraded' : 'unhealthy'
    const executor = listFabricExecutors().find(item => item.id === BILIBILI_MCP_EXECUTOR_ID)
    const freshUnavailable = !ready && discovery.status === 'unavailable'
      && executor?.enabled === false && isDeepStrictEqual(executor.healthDetails, {})
    if (!freshUnavailable) {
      await this.setExecutorAvailability(ready, health,
        discoveryDetails(discovery, ready ? 'ready' : 'not_ready', errorCode))
    }
    this.current = {
      active: true,
      profile,
      configured: true,
      discoveryStatus: discovery.status,
      executorEnabled: ready,
      authorizedTargetCount: targets.length,
      lastErrorCode: errorCode,
    }
  }

  private async makeUnavailable(profile: string, errorCode: string): Promise<void> {
    const executor = listFabricExecutors().find(item => item.id === BILIBILI_MCP_EXECUTOR_ID)
    const hadRuntimeAvailability = !!executor
      && (executor.enabled || !isDeepStrictEqual(executor.healthDetails, {}))
    let failure: unknown = null
    try { clearEntertainmentInternetAuthorization() } catch (error) { failure = error }
    if (hadRuntimeAvailability) {
      try {
        await this.setExecutorAvailability(false, 'unhealthy', {
          lifecycle: 'unavailable',
          profile,
          provider: 'bilibili',
          errorCode,
        })
      } catch (error) { if (failure === null) failure = error }
    }
    this.current = {
      active: true,
      profile,
      configured: false,
      discoveryStatus: 'unavailable',
      executorEnabled: false,
      authorizedTargetCount: 0,
      lastErrorCode: errorCode,
    }
    if (failure !== null) throw failure
  }

  private async stopInternal(errorCode: string | null): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.poll) { await this.poll; this.poll = null }
    let failure: unknown = null
    const executor = listFabricExecutors().find(item => item.id === BILIBILI_MCP_EXECUTOR_ID)
    const hadRuntimeAvailability = !!executor
      && (executor.enabled || !isDeepStrictEqual(executor.healthDetails, {}))
    try { clearEntertainmentInternetAuthorization() } catch (error) { failure = error }
    if (hadRuntimeAvailability) {
      try {
        await this.setExecutorAvailability(false, 'unhealthy', {
          lifecycle: 'stopped',
          profile: this.current.profile,
          provider: 'bilibili',
        })
      } catch (error) { if (failure === null) failure = error }
    }
    this.adapter = null
    this.current = {
      active: false,
      profile: this.current.profile,
      configured: false,
      discoveryStatus: 'stopped',
      executorEnabled: false,
      authorizedTargetCount: 0,
      lastErrorCode: errorCode,
    }
    if (failure !== null) throw failure
  }

  private async setExecutorAvailability(
    enabled: boolean,
    health: 'healthy' | 'degraded' | 'unhealthy',
    details: Record<string, unknown>,
  ): Promise<void> {
    const current = listFabricExecutors().find(executor => executor.id === BILIBILI_MCP_EXECUTOR_ID)
    if (!current) throw new Error('INTERNET_MCP_EXECUTOR_MISSING')
    if (enabled !== current.enabled) setFabricExecutorEnabled(BILIBILI_MCP_EXECUTOR_ID, enabled)
    const latest = listFabricExecutors().find(executor => executor.id === BILIBILI_MCP_EXECUTOR_ID)
    if (!latest) throw new Error('INTERNET_MCP_EXECUTOR_MISSING')
    if (latest.health !== health || !isDeepStrictEqual(latest.healthDetails, details)) {
      updateFabricExecutorHealth(BILIBILI_MCP_EXECUTOR_ID, health, details)
    }
  }

  private pollInterval(): number {
    const value = this.dependencies.pollIntervalMs ?? DEFAULT_POLL_MS
    return Number.isSafeInteger(value) && value >= 100 && value <= 60_000 ? value : DEFAULT_POLL_MS
  }
}

const productionRuntime = new InternetProductionRuntime()

export function startInternetProductionRuntime(): Promise<FabricExecutorAdapter> { return productionRuntime.start() }
export function stopInternetProductionRuntime(): Promise<void> { return productionRuntime.stop() }
export function reconcileInternetProductionRuntime(): Promise<void> { return productionRuntime.reconcile() }
export function getInternetProductionRuntimeStatus(): InternetProductionRuntimeStatus { return productionRuntime.getStatus() }

function discoveryDetails(
  discovery: BilibiliMcpDiscovery,
  lifecycle: 'ready' | 'not_ready',
  errorCode: string | null,
): Record<string, unknown> {
  return {
    lifecycle,
    profile: discovery.profile,
    provider: discovery.provider,
    server: discovery.server,
    discoveryStatus: discovery.status,
    ...(errorCode ? { errorCode } : {}),
    capabilities: Object.fromEntries(Object.entries(discovery.capabilities).map(([id, capability]) => [id, {
      tool: capability.tool,
      available: capability.available,
      ...(capability.errorCode ? { errorCode: capability.errorCode } : {}),
    }])),
  }
}

function stableErrorCode(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const candidate = 'code' in error ? (error as { code?: unknown }).code : error.message
    if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(candidate)) return candidate
  }
  return fallback
}

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
import { createInternetBrowserExecutorAdapter } from './browser-executor'
import { createInternetMcpExecutorAdapter } from './mcp-executor'
import { discoverBilibiliMcpBinding, type BilibiliMcpDiscovery } from './mcp-discovery'

export const BILIBILI_MCP_EXECUTOR_ID = 'bilibili-mcp'
export const BILIBILI_BROWSER_EXECUTOR_ID = 'bilibili-browser'
const DEFAULT_POLL_MS = 1_000

export interface InternetProductionRuntimeStatus {
  active: boolean
  profile: string
  configured: boolean
  discoveryStatus: BilibiliMcpDiscovery['status'] | 'stopped'
  executorEnabled: boolean
  mcpExecutorEnabled: boolean
  browserExecutorEnabled: boolean
  selectedExecutorId: string | null
  authorizedTargetCount: number
  lastErrorCode: string | null
}

export interface InternetProductionRuntimeDependencies {
  activeProfile?: () => string
  discover?: (profile: string) => Promise<BilibiliMcpDiscovery>
  controlLevel?: () => number
  createAdapter?: () => FabricExecutorAdapter
  createBrowserAdapter?: () => FabricExecutorAdapter
  pollIntervalMs?: number
}

export class InternetProductionRuntime {
  private readonly dependencies: Required<Pick<InternetProductionRuntimeDependencies,
    'activeProfile' | 'discover' | 'controlLevel' | 'createAdapter' | 'createBrowserAdapter'>>
    & Pick<InternetProductionRuntimeDependencies, 'pollIntervalMs'>
  private adapters: FabricExecutorAdapter[] = []
  private fallbackArmed = false
  private timer: ReturnType<typeof setInterval> | null = null
  private poll: Promise<void> | null = null
  private tail = Promise.resolve()
  private current: InternetProductionRuntimeStatus = {
    active: false,
    profile: 'default',
    configured: false,
    discoveryStatus: 'stopped',
    executorEnabled: false,
    mcpExecutorEnabled: false,
    browserExecutorEnabled: false,
    selectedExecutorId: null,
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
      createBrowserAdapter: dependencies.createBrowserAdapter ?? (() => createInternetBrowserExecutorAdapter({
        id: BILIBILI_BROWSER_EXECUTOR_ID,
        environment: 'production',
      })),
      pollIntervalMs: dependencies.pollIntervalMs,
    }
  }

  start(): Promise<FabricExecutorAdapter[]> {
    return this.queue(async () => {
      if (this.current.active && this.adapters.length === 2) return [...this.adapters]
      const adapters = [this.dependencies.createAdapter(), this.dependencies.createBrowserAdapter()]
      if (adapters[0]?.id !== BILIBILI_MCP_EXECUTOR_ID || adapters[0].type !== 'mcp'
        || adapters[1]?.id !== BILIBILI_BROWSER_EXECUTOR_ID || adapters[1].type !== 'browser') {
        throw new Error('INTERNET_PRODUCTION_ADAPTER_INVALID')
      }
      this.adapters = adapters
      this.fallbackArmed = persistedFallbackEligibility()
      this.current = { ...this.current, active: true, profile: this.dependencies.activeProfile(),
        discoveryStatus: 'unavailable', lastErrorCode: null }
      try {
        await this.reconcileNow()
        this.timer = setInterval(() => this.scheduleReconcile(), this.pollInterval())
        this.timer.unref?.()
        return [...adapters]
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
    let configured = true
    try {
      discovery = await this.dependencies.discover(profile)
    } catch {
      configured = false
      discovery = unavailableDiscovery(profile, 'MCP_DISCOVERY_UNAVAILABLE')
    }
    const controlStopped = this.dependencies.controlLevel() >= 3
    if (discovery.status === 'healthy' || discovery.status === 'degraded') this.fallbackArmed = true
    const mcpReady = discovery.status === 'healthy' && !controlStopped
    const browserReady = !mcpReady && !controlStopped && this.fallbackArmed
    let targets: string[] = []
    try {
      if (mcpReady || browserReady) targets = refreshEntertainmentInternetAuthorization(profile)
      else clearEntertainmentInternetAuthorization()
    } catch (error) {
      await this.makeUnavailable(profile, stableErrorCode(error, 'INTERNET_AUTHORIZATION_FAILED'))
      return
    }
    const errorCode = controlStopped ? 'FABRIC_EMERGENCY_STOP_ACTIVE' : discovery.errorCode
    const pristineUnavailable = !mcpReady && !browserReady && discovery.status === 'unavailable'
      && pristineInternetExecutors()
    try {
      if (pristineUnavailable) {
        // A profile that never configured internet execution must not mutate
        // the global registry revision and stale unrelated durable workflows.
      } else if (browserReady) {
        await this.setExecutorAvailability(BILIBILI_BROWSER_EXECUTOR_ID, true, 'healthy',
          browserDetails(profile, 'fallback', errorCode))
        await this.setExecutorAvailability(BILIBILI_MCP_EXECUTOR_ID, false,
          discovery.status === 'degraded' ? 'degraded' : 'unhealthy',
          discoveryDetails(discovery, 'not_ready', errorCode))
      } else if (mcpReady) {
        await this.setExecutorAvailability(BILIBILI_MCP_EXECUTOR_ID, true, 'healthy',
          discoveryDetails(discovery, 'ready', null))
        await this.setExecutorAvailability(BILIBILI_BROWSER_EXECUTOR_ID, false, 'degraded',
          browserDetails(profile, 'standby', null))
      } else {
        await this.setExecutorAvailability(BILIBILI_MCP_EXECUTOR_ID, false, 'degraded',
          discoveryDetails(discovery, 'not_ready', errorCode))
        await this.setExecutorAvailability(BILIBILI_BROWSER_EXECUTOR_ID, false, 'degraded',
          browserDetails(profile, 'stopped', errorCode))
      }
    } catch (error) {
      await this.makeUnavailable(profile, stableErrorCode(error, 'INTERNET_EXECUTOR_AVAILABILITY_FAILED'))
      return
    }
    const selectedExecutorId = mcpReady ? BILIBILI_MCP_EXECUTOR_ID
      : browserReady ? BILIBILI_BROWSER_EXECUTOR_ID : null
    this.current = {
      active: true,
      profile,
      configured,
      discoveryStatus: discovery.status,
      executorEnabled: selectedExecutorId !== null,
      mcpExecutorEnabled: mcpReady,
      browserExecutorEnabled: browserReady,
      selectedExecutorId,
      authorizedTargetCount: targets.length,
      lastErrorCode: errorCode,
    }
  }

  private async makeUnavailable(profile: string, errorCode: string): Promise<void> {
    let failure: unknown = null
    try { clearEntertainmentInternetAuthorization() } catch (error) { failure = error }
    for (const executorId of [BILIBILI_MCP_EXECUTOR_ID, BILIBILI_BROWSER_EXECUTOR_ID]) {
      const executor = listFabricExecutors().find(item => item.id === executorId)
      const hadRuntimeAvailability = !!executor
        && (executor.enabled || !isDeepStrictEqual(executor.healthDetails, {}))
      if (!hadRuntimeAvailability) continue
      try {
        await this.setExecutorAvailability(executorId, false, 'unhealthy', {
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
      mcpExecutorEnabled: false,
      browserExecutorEnabled: false,
      selectedExecutorId: null,
      authorizedTargetCount: 0,
      lastErrorCode: errorCode,
    }
    if (failure !== null) throw failure
  }

  private async stopInternal(errorCode: string | null): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.poll) { await this.poll; this.poll = null }
    let failure: unknown = null
    try { clearEntertainmentInternetAuthorization() } catch (error) { failure = error }
    for (const executorId of [BILIBILI_MCP_EXECUTOR_ID, BILIBILI_BROWSER_EXECUTOR_ID]) {
      const executor = listFabricExecutors().find(item => item.id === executorId)
      const hadRuntimeAvailability = !!executor
        && (executor.enabled || !isDeepStrictEqual(executor.healthDetails, {}))
      if (!hadRuntimeAvailability) continue
      try {
        await this.setExecutorAvailability(executorId, false, 'unhealthy', {
          lifecycle: 'stopped',
          profile: this.current.profile,
          provider: 'bilibili',
        })
      } catch (error) { if (failure === null) failure = error }
    }
    this.adapters = []
    this.fallbackArmed = false
    this.current = {
      active: false,
      profile: this.current.profile,
      configured: false,
      discoveryStatus: 'stopped',
      executorEnabled: false,
      mcpExecutorEnabled: false,
      browserExecutorEnabled: false,
      selectedExecutorId: null,
      authorizedTargetCount: 0,
      lastErrorCode: errorCode,
    }
    if (failure !== null) throw failure
  }

  private async setExecutorAvailability(
    executorId: string,
    enabled: boolean,
    health: 'healthy' | 'degraded' | 'unhealthy',
    details: Record<string, unknown>,
  ): Promise<void> {
    const current = listFabricExecutors().find(executor => executor.id === executorId)
    if (!current) throw new Error('INTERNET_EXECUTOR_MISSING')
    if (enabled !== current.enabled) setFabricExecutorEnabled(executorId, enabled)
    const latest = listFabricExecutors().find(executor => executor.id === executorId)
    if (!latest) throw new Error('INTERNET_EXECUTOR_MISSING')
    if (latest.health !== health || !isDeepStrictEqual(latest.healthDetails, details)) {
      updateFabricExecutorHealth(executorId, health, details)
    }
  }

  private pollInterval(): number {
    const value = this.dependencies.pollIntervalMs ?? DEFAULT_POLL_MS
    return Number.isSafeInteger(value) && value >= 100 && value <= 60_000 ? value : DEFAULT_POLL_MS
  }
}

const productionRuntime = new InternetProductionRuntime()

export function startInternetProductionRuntime(): Promise<FabricExecutorAdapter[]> { return productionRuntime.start() }
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

function browserDetails(
  profile: string,
  lifecycle: 'fallback' | 'standby' | 'stopped',
  reasonCode: string | null,
): Record<string, unknown> {
  return {
    lifecycle,
    profile,
    provider: 'bilibili',
    bridgeContract: 'bilibili-accessibility-v1',
    primitives: ['navigate', 'snapshot'],
    ...(reasonCode ? { reasonCode } : {}),
  }
}

function unavailableDiscovery(
  profile: string,
  errorCode: Exclude<BilibiliMcpDiscovery['errorCode'], null>,
): BilibiliMcpDiscovery {
  return {
    profile,
    provider: 'bilibili',
    server: 'bilibili',
    status: 'unavailable',
    errorCode,
    capabilities: {
      'bilibili.video.search': {
        capabilityId: 'bilibili.video.search', tool: 'search_videos', available: false, errorCode: 'MCP_TOOL_MISSING',
      },
      'bilibili.video.inspect': {
        capabilityId: 'bilibili.video.inspect', tool: 'get_video_info', available: false, errorCode: 'MCP_TOOL_MISSING',
      },
    },
  }
}

function persistedFallbackEligibility(): boolean {
  return listFabricExecutors().some(executor => {
    if (![BILIBILI_MCP_EXECUTOR_ID, BILIBILI_BROWSER_EXECUTOR_ID].includes(executor.id)) return false
    if (executor.enabled) return true
    const lifecycle = executor.healthDetails.lifecycle
    return lifecycle === 'ready' || lifecycle === 'fallback'
  })
}

function pristineInternetExecutors(): boolean {
  const executors = listFabricExecutors()
    .filter(executor => [BILIBILI_MCP_EXECUTOR_ID, BILIBILI_BROWSER_EXECUTOR_ID].includes(executor.id))
  return executors.length === 2 && executors.every(executor => !executor.enabled
    && isDeepStrictEqual(executor.healthDetails, {}))
}

function stableErrorCode(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const candidate = 'code' in error ? (error as { code?: unknown }).code : error.message
    if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(candidate)) return candidate
  }
  return fallback
}

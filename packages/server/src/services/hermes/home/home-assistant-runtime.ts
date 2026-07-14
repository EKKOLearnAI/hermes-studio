import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  HomeAssistantClient,
  HomeAssistantClientError,
  type HomeAssistantClientErrorCode,
  type HomeAssistantStateSubscription,
} from './home-assistant-client'
import type { ResolvedHomeAssistantConfig } from './home-assistant-config'
import {
  HomeAssistantNormalizationError,
  normalizeHomeAssistantBootstrapState,
  normalizeHomeAssistantStateChanged,
  type NormalizedHomeAssistantEntity,
  type NormalizedHomeAssistantEvent,
} from './home-assistant-normalizer'
import { HomeTwinStore } from './store'
import type { HomeProviderConnectionStatus } from './types'

export type HomeAssistantRuntimeErrorCode =
  | HomeAssistantClientErrorCode
  | 'HOME_ASSISTANT_RUNTIME_ALREADY_RUNNING'
  | 'HOME_ASSISTANT_RUNTIME_STORE_FAILED'

export class HomeAssistantRuntimeError extends Error {
  constructor(readonly code: HomeAssistantRuntimeErrorCode) {
    super(code)
    this.name = 'HomeAssistantRuntimeError'
  }
}

export interface HomeAssistantRuntimeClient {
  fetchStates(signal?: AbortSignal): Promise<unknown[]>
  subscribeStateChanged(
    onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<HomeAssistantStateSubscription>
}

export interface HomeAssistantRuntimeStatus {
  provider: 'home-assistant'
  profile: string
  connectionStatus: HomeProviderConnectionStatus
  haVersion: string | null
  reconnectAttempt: number
  rejectedEvents: number
  lastEventId: string | null
  lastEventAt: string | null
  lastErrorCode: HomeAssistantRuntimeErrorCode | null
}

export interface HomeAssistantRuntimeDependencies {
  client?: HomeAssistantRuntimeClient
  now?: () => string
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

type ObservationTerminal =
  | { kind: 'closed'; close: Awaited<HomeAssistantStateSubscription['closed']> }
  | { kind: 'heartbeat-error'; error: unknown }

export class HomeAssistantRuntime {
  private readonly client: HomeAssistantRuntimeClient
  private readonly now: () => string
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private current: HomeAssistantRuntimeStatus
  private running = false

  constructor(
    private readonly config: ResolvedHomeAssistantConfig,
    private readonly store: HomeTwinStore,
    dependencies: HomeAssistantRuntimeDependencies = {},
  ) {
    this.client = dependencies.client ?? new HomeAssistantClient(config)
    this.now = dependencies.now ?? (() => new Date().toISOString())
    this.wait = dependencies.wait ?? abortableWait
    const saved = store.getProviderCursor('home-assistant')
    const cursor = saved?.cursor ?? {}
    this.current = {
      provider: 'home-assistant',
      profile: config.profile,
      connectionStatus: saved?.connectionStatus ?? 'disconnected',
      haVersion: safeString(cursor.haVersion, 80),
      reconnectAttempt: safeInteger(cursor.reconnectAttempt),
      rejectedEvents: safeInteger(cursor.rejectedEvents),
      lastEventId: safeString(cursor.lastEventId, 255),
      lastEventAt: saved?.lastEventAt ?? null,
      lastErrorCode: runtimeErrorCode(cursor.lastErrorCode),
    }
  }

  getStatus(): HomeAssistantRuntimeStatus {
    return { ...this.current }
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new HomeAssistantRuntimeError('HOME_ASSISTANT_RUNTIME_ALREADY_RUNNING')
    this.running = true
    let reconnectAttempt = 0
    try {
      while (!signal.aborted) {
        this.persistStatus({ connectionStatus: 'connecting', reconnectAttempt, lastErrorCode: null })
        try {
          await this.observeOnce(signal, () => { reconnectAttempt = 0 })
          if (!signal.aborted) throw new HomeAssistantRuntimeError('HOME_ASSISTANT_WS_CLOSED')
        } catch (error) {
          if (signal.aborted) break
          const code = safeRuntimeError(error).code
          reconnectAttempt = Math.min(reconnectAttempt + 1, 31)
          this.persistStatus({ connectionStatus: 'degraded', reconnectAttempt, lastErrorCode: code })
          const delay = reconnectDelay(this.config.reconnectInitialMs, this.config.reconnectMaxMs, reconnectAttempt)
          try { await this.wait(delay, signal) } catch (waitError) {
            if (!signal.aborted) throw safeRuntimeError(waitError)
          }
        }
      }
    } finally {
      this.running = false
      this.persistStatus({ connectionStatus: 'disconnected', reconnectAttempt: 0, lastErrorCode: null })
    }
  }

  private async observeOnce(signal: AbortSignal, onConnected: () => void): Promise<void> {
    const bootstrap = await this.client.fetchStates(signal)
    for (const raw of bootstrap) {
      if (signal.aborted) return
      try {
        this.ingest(normalizeHomeAssistantBootstrapState(raw, this.now()))
      } catch (error) {
        if (error instanceof HomeAssistantNormalizationError) this.rejectProviderMaterial()
        else throw error
      }
    }

    let subscription: HomeAssistantStateSubscription | null = null
    let processing = Promise.resolve()
    let processingError: HomeAssistantRuntimeError | null = null
    const onEvent = (raw: Record<string, unknown>): void => {
      if (processingError) return
      processing = processing.then(() => {
        try {
          const normalized = normalizeHomeAssistantStateChanged(raw, this.now())
          this.ingest(normalized)
        } catch (error) {
          if (error instanceof HomeAssistantNormalizationError) {
            this.rejectProviderMaterial()
            return
          }
          throw error
        }
      }).catch(error => {
        processingError = safeRuntimeError(error)
        void subscription?.close()
      })
    }

    subscription = await this.client.subscribeStateChanged(onEvent, signal)
    onConnected()
    this.persistStatus({
      connectionStatus: 'connected', haVersion: subscription.haVersion,
      reconnectAttempt: 0, lastErrorCode: null,
    })
    const cycle = new AbortController()
    const abortCycle = () => cycle.abort()
    signal.addEventListener('abort', abortCycle, { once: true })
    if (signal.aborted) abortCycle()
    try {
      const terminal = await Promise.race<ObservationTerminal>([
        subscription.closed.then(close => ({ kind: 'closed', close })),
        this.heartbeat(subscription, cycle.signal)
          .then<ObservationTerminal>(() => ({
            kind: 'heartbeat-error', error: new HomeAssistantRuntimeError('HOME_ASSISTANT_WS_CLOSED'),
          }))
          .catch(error => ({ kind: 'heartbeat-error', error })),
      ])
      cycle.abort()
      await processing
      if (processingError) throw processingError
      if (signal.aborted) return
      if (terminal.kind === 'heartbeat-error') throw safeRuntimeError(terminal.error)
      throw new HomeAssistantRuntimeError(terminal.close.code ?? 'HOME_ASSISTANT_WS_CLOSED')
    } finally {
      cycle.abort()
      signal.removeEventListener('abort', abortCycle)
      try { await subscription.close() } catch { /* stable runtime status is written by the supervisor */ }
    }
  }

  private async heartbeat(subscription: HomeAssistantStateSubscription, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.wait(this.config.heartbeatIntervalMs, signal)
      if (signal.aborted) return
      await subscription.ping(signal)
    }
  }

  private ingest(normalized: NormalizedHomeAssistantEvent): void {
    const entity = normalized.entity
    const existingDevice = this.store.getDevice(entity.deviceId)
    if (!existingDevice) this.writeEntityMaterial(entity, null)
    else if (!this.store.getBinding(entity.bindingId)) this.writeBindingMaterial(entity, 0)

    const existingEvent = this.store.getProviderEvent(normalized.event.provider, normalized.event.eventId)
    if (!existingEvent && existingDevice && this.wouldAdvanceState(normalized)) {
      this.writeEntityMaterial(entity, existingDevice.version)
    }

    const result = this.store.applyDeviceStateEvent({
      event: normalized.event,
      states: entity.states.map(state => ({ deviceId: entity.deviceId, ...state })),
    })
    this.recordEvent(result.event.eventId, result.event.occurredAt)
  }

  private wouldAdvanceState(normalized: NormalizedHomeAssistantEvent): boolean {
    const current = new Map(this.store.listDeviceStates({ deviceId: normalized.entity.deviceId, limit: 200 })
      .map(state => [state.key, state]))
    return normalized.entity.states.some(state => {
      const saved = current.get(state.key)
      return !saved || state.observedAt > saved.observedAt
        || (state.observedAt === saved.observedAt && normalized.event.id > saved.sourceEventId)
    })
  }

  private writeEntityMaterial(entity: NormalizedHomeAssistantEntity, expectedDeviceVersion: number | null): void {
    const spaceId = entity.spaceExternalId === null ? null : homeAssistantSpaceId(entity.spaceExternalId)
    if (entity.spaceExternalId !== null && !this.store.getSpace(spaceId as string)) {
      this.store.upsertSpace({
        id: spaceId as string,
        kind: 'room',
        name: titleFromAreaId(entity.spaceExternalId),
        attributes: { externalId: entity.spaceExternalId, provider: entity.provider },
        expectedVersion: 0,
      })
    }
    const currentDevice = expectedDeviceVersion === null ? null : this.store.getDevice(entity.deviceId)
    const desiredDevice = {
      name: entity.name,
      deviceClass: entity.deviceClass,
      spaceId,
      availability: entity.availability,
      attributes: entity.attributes,
    }
    if (!currentDevice || !isDeepStrictEqual({
      name: currentDevice.name,
      deviceClass: currentDevice.deviceClass,
      spaceId: currentDevice.spaceId,
      availability: currentDevice.availability,
      attributes: currentDevice.attributes,
    }, desiredDevice)) {
      this.store.upsertDevice({
        id: entity.deviceId,
        ...desiredDevice,
        expectedVersion: currentDevice?.version ?? 0,
      })
    }
    const binding = this.store.getBinding(entity.bindingId)
    if (!binding) this.writeBindingMaterial(entity, 0)
    else if (!isDeepStrictEqual(binding.capabilities, entity.capabilities)
      || !isDeepStrictEqual(binding.metadata, entity.metadata)) {
      this.writeBindingMaterial(entity, binding.version)
    }
  }

  private writeBindingMaterial(entity: NormalizedHomeAssistantEntity, expectedVersion: number): void {
    this.store.upsertBinding({
      id: entity.bindingId,
      deviceId: entity.deviceId,
      provider: entity.provider,
      externalId: entity.externalId,
      capabilities: entity.capabilities,
      metadata: entity.metadata,
      expectedVersion,
    })
  }

  private rejectProviderMaterial(): void {
    this.persistStatus({ rejectedEvents: this.current.rejectedEvents + 1 })
  }

  private recordEvent(eventId: string, occurredAt: string): void {
    const isLatest = this.current.lastEventAt === null || occurredAt >= this.current.lastEventAt
    this.persistStatus(isLatest
      ? { lastEventId: eventId, lastEventAt: occurredAt }
      : {})
  }

  private persistStatus(patch: Partial<HomeAssistantRuntimeStatus>): void {
    this.current = { ...this.current, ...patch, provider: 'home-assistant', profile: this.config.profile }
    const cursor: Record<string, unknown> = {
      profile: this.current.profile,
      reconnectAttempt: this.current.reconnectAttempt,
      rejectedEvents: this.current.rejectedEvents,
    }
    if (this.current.haVersion !== null) cursor.haVersion = this.current.haVersion
    if (this.current.lastEventId !== null) cursor.lastEventId = this.current.lastEventId
    if (this.current.lastErrorCode !== null) cursor.lastErrorCode = this.current.lastErrorCode
    const saved = this.store.getProviderCursor('home-assistant')
    this.store.upsertProviderCursor({
      provider: 'home-assistant',
      cursor,
      connectionStatus: this.current.connectionStatus,
      lastEventAt: this.current.lastEventAt,
      expectedVersion: saved?.version ?? 0,
    })
  }
}

function homeAssistantSpaceId(externalId: string): string {
  return `space:ha:${createHash('sha256').update(externalId).digest('hex').slice(0, 24)}`
}

function titleFromAreaId(value: string): string {
  return value.split(/[._-]+/).filter(Boolean)
    .map(part => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ').slice(0, 200)
}

function reconnectDelay(initial: number, maximum: number, attempt: number): number {
  return Math.min(maximum, initial * (2 ** Math.min(Math.max(attempt - 1, 0), 20)))
}

function safeRuntimeError(error: unknown): HomeAssistantRuntimeError {
  if (error instanceof HomeAssistantRuntimeError) return error
  if (error instanceof HomeAssistantClientError) return new HomeAssistantRuntimeError(error.code)
  return new HomeAssistantRuntimeError('HOME_ASSISTANT_RUNTIME_STORE_FAILED')
}

function runtimeErrorCode(value: unknown): HomeAssistantRuntimeErrorCode | null {
  if (typeof value !== 'string') return null
  if (value === 'HOME_ASSISTANT_RUNTIME_ALREADY_RUNNING' || value === 'HOME_ASSISTANT_RUNTIME_STORE_FAILED'
    || value === 'HOME_ASSISTANT_ABORTED' || value === 'HOME_ASSISTANT_TIMEOUT'
    || value === 'HOME_ASSISTANT_REST_FAILED' || value === 'HOME_ASSISTANT_REST_AUTH_FAILED'
    || value === 'HOME_ASSISTANT_RESPONSE_TOO_LARGE' || value === 'HOME_ASSISTANT_RESPONSE_INVALID'
    || value === 'HOME_ASSISTANT_WS_CONNECT_FAILED' || value === 'HOME_ASSISTANT_WS_AUTH_FAILED'
    || value === 'HOME_ASSISTANT_WS_SUBSCRIBE_FAILED' || value === 'HOME_ASSISTANT_WS_PROTOCOL_INVALID'
    || value === 'HOME_ASSISTANT_WS_CLOSED') return value
  return null
}

function safeString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}

function safeInteger(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000 ? value as number : 0
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new HomeAssistantClientError('HOME_ASSISTANT_ABORTED'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(new HomeAssistantClientError('HOME_ASSISTANT_ABORTED'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

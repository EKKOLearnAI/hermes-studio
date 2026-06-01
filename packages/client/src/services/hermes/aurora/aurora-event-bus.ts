import { computed, ref } from 'vue'
import type { AuroraAppKind } from './capability-manifest'

export type AuroraEventType =
  | 'APP_OPENED'
  | 'APP_CLOSED'
  | 'PAGE_ANALYZED'
  | 'TICKER_FOCUSED'
  | 'MACRO_SHOCK_DETECTED'
  | 'MEMORY_WRITTEN'
  | 'MIROFISH_BACKGROUND_SIMULATION_QUEUED'
  | 'GENERATED_WIDGET_RUNTIME_ERROR'

export interface AuroraAppEventPayload {
  kind: AuroraAppKind
  title?: string
  source?: string
  payload?: Record<string, unknown> | null
}

export interface AuroraPageAnalyzedPayload {
  url: string
  iframeUrl?: string
  title?: string
  excerpt?: string
  source: string
  topic?: string
  analyzedAt: string
}

export interface AuroraTickerFocusedPayload {
  symbol: string
  rawSymbol?: string
  source: string
  input?: string
  focusedAt: string
}

export interface AuroraMacroShockPayload {
  topic: string
  severity: 'low' | 'medium' | 'high'
  source: string
  summary: string
}

export interface AuroraMemoryWrittenPayload {
  id: string
  topic: string
  verdict?: string
  path?: string
  writtenAt: string
}

export interface AuroraMiroFishQueuedPayload {
  topic: string
  source: string
  url?: string
  queuedAt: string
}

export interface AuroraGeneratedWidgetRuntimeErrorPayload {
  widgetName: string
  componentPath?: string
  message: string
  stack?: string
  occurredAt: string
}

export interface AuroraEventPayloadMap {
  APP_OPENED: AuroraAppEventPayload
  APP_CLOSED: AuroraAppEventPayload
  PAGE_ANALYZED: AuroraPageAnalyzedPayload
  TICKER_FOCUSED: AuroraTickerFocusedPayload
  MACRO_SHOCK_DETECTED: AuroraMacroShockPayload
  MEMORY_WRITTEN: AuroraMemoryWrittenPayload
  MIROFISH_BACKGROUND_SIMULATION_QUEUED: AuroraMiroFishQueuedPayload
  GENERATED_WIDGET_RUNTIME_ERROR: AuroraGeneratedWidgetRuntimeErrorPayload
}

export interface AuroraEventEnvelope<TType extends AuroraEventType = AuroraEventType> {
  id: string
  type: TType
  timestamp: string
  payload: AuroraEventPayloadMap[TType]
}

type AuroraEventHandler<TType extends AuroraEventType> = (event: AuroraEventEnvelope<TType>) => void
type AuroraPayloadHandler<TType extends AuroraEventType> = (
  payload: AuroraEventPayloadMap[TType],
  event: AuroraEventEnvelope<TType>,
) => void
type AnyAuroraEventHandler = (event: AuroraEventEnvelope) => void

const MAX_TIMELINE_EVENTS = 120

function makeEventId(type: AuroraEventType): string {
  return `${type.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

class AuroraEventBus {
  private listeners = new Map<AuroraEventType, Set<AnyAuroraEventHandler>>()
  private wildcardListeners = new Set<AnyAuroraEventHandler>()
  private timelineRef = ref<AuroraEventEnvelope[]>([])

  readonly timeline = computed(() => this.timelineRef.value)

  publish<TType extends AuroraEventType>(
    type: TType,
    payload: AuroraEventPayloadMap[TType],
  ): AuroraEventEnvelope<TType> {
    const event: AuroraEventEnvelope<TType> = {
      id: makeEventId(type),
      type,
      timestamp: new Date().toISOString(),
      payload,
    }
    this.timelineRef.value = [event as AuroraEventEnvelope, ...this.timelineRef.value].slice(0, MAX_TIMELINE_EVENTS)

    const scopedListeners = this.listeners.get(type)
    if (scopedListeners) {
      for (const listener of [...scopedListeners]) listener(event as AuroraEventEnvelope)
    }
    for (const listener of [...this.wildcardListeners]) listener(event as AuroraEventEnvelope)
    return event
  }

  emit<TType extends AuroraEventType>(
    type: TType,
    payload: AuroraEventPayloadMap[TType],
  ): AuroraEventEnvelope<TType> {
    return this.publish(type, payload)
  }

  subscribe<TType extends AuroraEventType>(
    type: TType,
    handler: AuroraEventHandler<TType>,
  ): () => void {
    const listeners = this.listeners.get(type) || new Set<AnyAuroraEventHandler>()
    const wrapped = handler as AnyAuroraEventHandler
    listeners.add(wrapped)
    this.listeners.set(type, listeners)
    return () => {
      listeners.delete(wrapped)
      if (listeners.size === 0) this.listeners.delete(type)
    }
  }

  on<TType extends AuroraEventType>(
    type: TType,
    handler: AuroraPayloadHandler<TType>,
  ): () => void {
    return this.subscribe(type, (event) => handler(event.payload, event))
  }

  subscribeAll(handler: AnyAuroraEventHandler): () => void {
    this.wildcardListeners.add(handler)
    return () => this.wildcardListeners.delete(handler)
  }

  clearTimeline() {
    this.timelineRef.value = []
  }
}

export const auroraEventBus = new AuroraEventBus()

declare global {
  interface Window {
    __AURORA_EVENT_BUS__?: AuroraEventBus
  }
}

if (typeof window !== 'undefined') {
  window.__AURORA_EVENT_BUS__ = auroraEventBus
}

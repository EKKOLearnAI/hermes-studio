import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { getApiKey, getBaseUrlValue } from '@/api/client'

export interface QuantSocketTick {
  ticker: string
  price?: number
  previousPrice?: number
  change?: number
  changePercent?: number
  volume?: number
  bid?: number
  ask?: number
  updatedAt?: string
  source?: string
  [key: string]: unknown
}

interface QuantSocketPayload {
  type?: string
  tick?: QuantSocketTick
  ticks?: QuantSocketTick[]
  data?: QuantSocketTick | QuantSocketTick[]
  topPicks?: QuantSocketTick[]
}

export interface QuantSocketOptions {
  fps?: number
  reconnectMs?: number
  immediate?: boolean
}

export type QuantSocketStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

function formatHostForPort(hostname: string, port: number): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return `${hostname}:${port}`
  return hostname.includes(':') ? `[${hostname}]:${port}` : `${hostname}:${port}`
}

export function buildQuantSocketUrl(path = '/api/hermes/quant-lab/stream'): string {
  const token = getApiKey()
  const base = getBaseUrlValue()
  const wsProtocol = base
    ? base.startsWith('https')
      ? 'wss:'
      : 'ws:'
    : location.protocol === 'https:'
      ? 'wss:'
      : 'ws:'

  if (base) {
    return `${wsProtocol}//${new URL(base).host}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`
  }

  const host = import.meta.env.DEV
    ? formatHostForPort(location.hostname, 8648)
    : location.host
  return `${wsProtocol}//${host}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`
}

function isTick(value: unknown): value is QuantSocketTick {
  return typeof value === 'object' && value !== null && typeof (value as QuantSocketTick).ticker === 'string'
}

function normalizePayload(raw: unknown): QuantSocketTick[] {
  if (isTick(raw)) return [raw]
  if (!raw || typeof raw !== 'object') return []

  const payload = raw as QuantSocketPayload
  const candidates = [
    payload.tick,
    payload.data,
    payload.ticks,
    payload.topPicks,
  ]

  const ticks: QuantSocketTick[] = []
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      ticks.push(...candidate.filter(isTick))
    } else if (isTick(candidate)) {
      ticks.push(candidate)
    }
  }

  return ticks
}

export function useQuantSocket(url: string, options: QuantSocketOptions = {}) {
  const marketData = shallowRef<Record<string, QuantSocketTick>>({})
  const status = ref<QuantSocketStatus>('idle')
  const messageCount = ref(0)
  const flushCount = ref(0)
  const lastMessageAt = ref('')
  const lastFlushAt = ref('')

  const fps = Math.max(1, options.fps ?? 12)
  const reconnectMs = Math.max(500, options.reconnectMs ?? 3000)
  const immediate = options.immediate ?? true
  const minFrameMs = 1000 / fps

  let dataBuffer: Record<string, QuantSocketTick> = {}
  let ws: WebSocket | null = null
  let animationFrameId = 0
  let reconnectTimer: number | null = null
  let closedByUser = false
  let lastFlushMs = 0

  const connected = computed(() => status.value === 'open')
  const bufferedSymbols = computed(() => Object.keys(marketData.value).length)

  function clearReconnectTimer() {
    if (!reconnectTimer) return
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  function writeTicks(ticks: QuantSocketTick[]) {
    if (!ticks.length) return

    const now = new Date().toISOString()
    for (const tick of ticks) {
      dataBuffer[tick.ticker] = {
        ...tick,
        updatedAt: tick.updatedAt || now,
      }
    }
    messageCount.value += ticks.length
    lastMessageAt.value = now
  }

  function connect() {
    if (typeof window === 'undefined') return
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

    closedByUser = false
    clearReconnectTimer()
    status.value = 'connecting'
    ws = new WebSocket(url)

    ws.onopen = () => {
      status.value = 'open'
    }

    ws.onmessage = (event) => {
      try {
        const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        writeTicks(normalizePayload(payload))
      } catch {
        // Ignore malformed tick frames. The next valid frame will update the buffer.
      }
    }

    ws.onerror = () => {
      status.value = 'error'
    }

    ws.onclose = () => {
      ws = null
      status.value = closedByUser ? 'closed' : 'closed'
      if (!closedByUser) {
        reconnectTimer = window.setTimeout(connect, reconnectMs)
      }
    }
  }

  function disconnect() {
    closedByUser = true
    clearReconnectTimer()
    ws?.close()
    ws = null
    status.value = 'closed'
  }

  function flushBuffer(now = performance.now()) {
    if (now - lastFlushMs >= minFrameMs && Object.keys(dataBuffer).length > 0) {
      marketData.value = { ...marketData.value, ...dataBuffer }
      dataBuffer = {}
      flushCount.value += 1
      lastFlushMs = now
      lastFlushAt.value = new Date().toISOString()
    }

    animationFrameId = window.requestAnimationFrame(flushBuffer)
  }

  onMounted(() => {
    if (immediate) connect()
    animationFrameId = window.requestAnimationFrame(flushBuffer)
  })

  onUnmounted(() => {
    disconnect()
    if (animationFrameId) window.cancelAnimationFrame(animationFrameId)
  })

  return {
    marketData,
    status,
    connected,
    bufferedSymbols,
    messageCount,
    flushCount,
    lastMessageAt,
    lastFlushAt,
    connect,
    disconnect,
    writeTicks,
  }
}

import { randomUUID } from 'crypto'
import { io, type Socket } from 'socket.io-client'
import { config } from '../../config'
import { logger } from '../logger'
import { createDeviceSignature } from '../system-info'

const APP_RELAY_NAMESPACE = '/app-relay'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024
const MAX_RESPONSE_BODY_BYTES = 20 * 1024 * 1024

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'if-none-match',
  'range',
  'x-hermes-profile',
  'x-request-id',
])
const ALLOWED_SOCKET_NAMESPACES = new Set(['/chat-run'])
const ALLOWED_CHAT_RUN_CLIENT_EVENTS = new Set([
  'run',
  'resume',
  'abort',
  'cancel_queued_run',
  'approval.respond',
  'clarify.respond',
])
const TEXTUAL_RESPONSE_TYPES = [
  'application/json',
  'application/problem+json',
  'application/x-ndjson',
  'application/javascript',
  'application/xml',
  'application/x-www-form-urlencoded',
  'text/',
]
const NON_STREAMING_SUPPRESSED_EVENTS = new Set([
  'message.delta',
  'message.interim',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
])

export interface AppRelayHttpRequest {
  id?: string
  method?: string
  path?: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
  bodyBase64?: string
  timeoutMs?: number
}

export interface AppRelayHttpResponse {
  id?: string
  status?: number
  headers?: Record<string, string>
  body?: string
  bodyBase64?: string
  truncated?: boolean
  error?: { code: string; message: string }
}

export interface AppRelaySocketOpenRequest {
  id?: string
  namespace?: string
  auth?: Record<string, unknown>
  query?: Record<string, string | number | boolean | undefined>
  stream?: boolean
}

export interface AppRelaySocketEventRequest {
  id?: string
  event?: string
  payload?: unknown
  stream?: boolean
}

export interface AppRelaySocketCloseRequest {
  id?: string
}

export interface AppRelaySocketResponse {
  id?: string
  ok?: boolean
  namespace?: string
  event?: string
  stream?: boolean
  payload?: unknown
  error?: { code: string; message: string }
}

export interface StartAppRelayClientOptions {
  connectionId?: string
  relayUrl?: string
  machineId: string
  publicKey: string
  machineInfo?: Record<string, unknown>
  localBaseUrl?: string
  fetchImpl?: typeof fetch
}

interface LocalSocketBridge {
  id: string
  namespace: string
  socket: Socket
  stream: boolean
  output: string
  reasoning: string
}

interface NormalizedBody {
  body?: BodyInit
  contentType?: string
}

export class AppRelayClient {
  private socket: Socket | null = null
  private readonly bridges = new Map<string, LocalSocketBridge>()
  private readonly relayUrl: string
  private readonly localBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private pairingCode = ''
  private pairingExpiresAt = 0

  constructor(private readonly options: Required<Omit<StartAppRelayClientOptions, 'connectionId' | 'machineInfo'>> & {
    machineInfo?: Record<string, unknown>
  }) {
    this.relayUrl = resolveAppRelayUrl(options.relayUrl)
    this.localBaseUrl = options.localBaseUrl.replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl
  }

  start(): void {
    if (this.socket) return
    this.socket = io(this.relayUrl, {
      auth: async (callback) => {
        const nonce = randomUUID()
        const timestamp = Date.now()
        const signature = await createDeviceSignature(nonce, timestamp)
        callback({
          role: 'host',
          machineId: this.options.machineId,
          instanceId: this.options.machineId,
          publicKey: this.options.publicKey,
          nonce,
          timestamp,
          signature,
          machine: this.options.machineInfo,
        })
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 30_000,
    })

    this.socket.on('connect', () => {
      logger.info({ relayUrl: this.redactedRelayUrl(), machineId: this.options.machineId }, '[app-relay] connected')
    })
    this.socket.on('connect_error', (err: Error) => {
      logger.warn({ err, relayUrl: this.redactedRelayUrl() }, '[app-relay] connection failed')
    })
    this.socket.on('disconnect', (reason: string) => {
      this.closeLocalBridges()
      logger.info({ reason, relayUrl: this.redactedRelayUrl() }, '[app-relay] disconnected')
    })
    this.socket.on('relay.replaced', () => this.stop())
    this.socket.on('relay.ready', (payload: Record<string, unknown> = {}) => {
      this.rememberPairing(payload)
    })
    this.socket.on('app.http.request', (request: AppRelayHttpRequest, ack?: (response: AppRelayHttpResponse) => void) => {
      void this.handleHttpRequest(request)
        .then(response => ack?.(response))
        .catch(err => ack?.(httpError(request?.id, 'relay_internal_error', err instanceof Error ? err.message : String(err), 500)))
    })
    this.socket.on('app.socket.open', (request: AppRelaySocketOpenRequest, ack?: (response: AppRelaySocketResponse) => void) => {
      ack?.(this.openLocalSocket(request))
    })
    this.socket.on('app.socket.event', (request: AppRelaySocketEventRequest, ack?: (response: AppRelaySocketResponse) => void) => {
      ack?.(this.emitLocalSocketEvent(request))
    })
    this.socket.on('app.socket.close', (request: AppRelaySocketCloseRequest, ack?: (response: AppRelaySocketResponse) => void) => {
      ack?.(this.closeLocalSocket(request))
    })
  }

  stop(): void {
    this.closeLocalBridges()
    this.socket?.disconnect()
    this.socket = null
  }

  isConnected(): boolean {
    return Boolean(this.socket?.connected)
  }

  status(): { connected: boolean; machineId: string; pairingCode: string; pairingExpiresAt: number } {
    return {
      connected: this.isConnected(),
      machineId: this.options.machineId,
      pairingCode: this.pairingExpiresAt > Math.floor(Date.now() / 1000) ? this.pairingCode : '',
      pairingExpiresAt: this.pairingExpiresAt,
    }
  }

  requestPairingCode(timeoutMs = 5000): Promise<{ pairingCode: string; expiresAt: number }> {
    const socket = this.socket
    if (!socket?.connected) return Promise.reject(new Error('app_relay_not_connected'))
    return new Promise((resolve, reject) => {
      socket.timeout(timeoutMs).emit('pairing.request', {}, (error: Error | null, response: Record<string, unknown> = {}) => {
        if (error || response.ok === false) {
          reject(error || new Error(String(response.error || 'pairing_request_failed')))
          return
        }
        this.rememberPairing(response)
        if (!this.pairingCode) {
          reject(new Error('pairing_request_failed'))
          return
        }
        resolve({ pairingCode: this.pairingCode, expiresAt: this.pairingExpiresAt })
      })
    })
  }

  waitForConnected(timeoutMs = 5000): Promise<boolean> {
    const socket = this.socket
    if (!socket) return Promise.resolve(false)
    if (socket.connected) return Promise.resolve(true)
    return new Promise(resolve => {
      const cleanup = () => {
        clearTimeout(timer)
        socket.off('connect', onConnect)
        socket.off('connect_error', onFailure)
      }
      const onConnect = () => {
        cleanup()
        resolve(true)
      }
      const onFailure = () => {
        cleanup()
        resolve(false)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(false)
      }, timeoutMs)
      socket.once('connect', onConnect)
      socket.once('connect_error', onFailure)
    })
  }

  async handleHttpRequest(request: AppRelayHttpRequest): Promise<AppRelayHttpResponse> {
    const method = normalizeMethod(request.method)
    if (!method) return httpError(request.id, 'method_not_allowed', 'Relay request method is not allowed', 405)
    const path = normalizeRelayPath(request.path)
    if (!path) return httpError(request.id, 'path_not_allowed', 'Relay request path is not allowed', 403)

    const headers = normalizeHeaders(request.headers)
    const normalizedBody = normalizeRequestBody(request, method, headers)
    if (isHttpErrorResponse(normalizedBody)) return normalizedBody
    if (normalizedBody.contentType) headers.set('content-type', normalizedBody.contentType)

    const timeoutMs = normalizeTimeout(request.timeoutMs)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.localBaseUrl}${path}`, {
        method,
        headers,
        body: normalizedBody.body,
        signal: controller.signal,
      })
      return {
        id: request.id,
        status: response.status,
        headers: responseHeaders(response),
        ...(await readResponseBody(response)),
      }
    } catch (err) {
      const aborted = controller.signal.aborted
      return httpError(
        request.id,
        aborted ? 'request_timeout' : 'local_request_failed',
        aborted ? `Local request timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
        aborted ? 504 : 502,
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  private openLocalSocket(request: AppRelaySocketOpenRequest): AppRelaySocketResponse {
    const id = normalizeBridgeId(request.id)
    if (!id) return socketError(request.id, 'invalid_socket_id', 'Relay socket id is required')
    const namespace = String(request.namespace || '').trim()
    if (!ALLOWED_SOCKET_NAMESPACES.has(namespace)) return socketError(id, 'namespace_not_allowed', 'Relay socket namespace is not allowed')

    this.closeLocalSocket({ id })
    const localSocket = io(`${this.localBaseUrl}${namespace}`, {
      auth: normalizeSocketAuth(request.auth),
      query: normalizeSocketQuery(request.query),
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 30_000,
    })
    const bridge: LocalSocketBridge = {
      id,
      namespace,
      socket: localSocket,
      stream: typeof request.stream === 'boolean' ? request.stream : true,
      output: '',
      reasoning: '',
    }
    this.bridges.set(id, bridge)
    localSocket.on('connect', () => this.emitSocketEvent(bridge, 'connect', { socketId: localSocket.id }))
    localSocket.on('connect_error', (err: Error) => this.emitSocketEvent(bridge, 'connect_error', { message: err.message }))
    localSocket.on('disconnect', (reason: string) => this.emitSocketEvent(bridge, 'disconnect', { reason }))
    localSocket.onAny((event: string, ...args: unknown[]) => {
      this.handleLocalSocketEvent(bridge, event, args.length <= 1 ? args[0] : args)
    })
    return { id, ok: true, namespace, stream: bridge.stream }
  }

  private emitLocalSocketEvent(request: AppRelaySocketEventRequest): AppRelaySocketResponse {
    const id = normalizeBridgeId(request.id)
    if (!id) return socketError(request.id, 'invalid_socket_id', 'Relay socket id is required')
    const event = String(request.event || '').trim()
    if (!ALLOWED_CHAT_RUN_CLIENT_EVENTS.has(event)) return socketError(id, 'event_not_allowed', 'Relay socket event is not allowed')
    const bridge = this.bridges.get(id)
    if (!bridge) return socketError(id, 'socket_not_open', 'Relay socket is not open')
    if (typeof request.stream === 'boolean') bridge.stream = request.stream
    if (event === 'run') {
      bridge.output = ''
      bridge.reasoning = ''
    }
    bridge.socket.emit(event, request.payload)
    return { id, ok: true, namespace: bridge.namespace, event, stream: bridge.stream }
  }

  private closeLocalSocket(request: AppRelaySocketCloseRequest): AppRelaySocketResponse {
    const id = normalizeBridgeId(request.id)
    if (!id) return socketError(request.id, 'invalid_socket_id', 'Relay socket id is required')
    const bridge = this.bridges.get(id)
    if (!bridge) return { id, ok: true }
    bridge.socket.disconnect()
    this.bridges.delete(id)
    return { id, ok: true, namespace: bridge.namespace }
  }

  private handleLocalSocketEvent(bridge: LocalSocketBridge, event: string, payload: unknown): void {
    if (!bridge.stream) {
      if (event === 'message.delta' && isRecord(payload) && typeof payload.delta === 'string') {
        bridge.output += payload.delta
        return
      }
      if ((event === 'reasoning.delta' || event === 'thinking.delta') && isRecord(payload)) {
        bridge.reasoning += typeof payload.delta === 'string' ? payload.delta : typeof payload.text === 'string' ? payload.text : ''
        return
      }
      if (NON_STREAMING_SUPPRESSED_EVENTS.has(event)) return
      if (event === 'run.completed') {
        const completion = isRecord(payload) ? payload : {}
        this.emitSocketEvent(bridge, event, {
          ...completion,
          output: typeof completion.output === 'string' && completion.output ? completion.output : bridge.output,
          ...(bridge.reasoning && typeof completion.reasoning !== 'string' ? { reasoning: bridge.reasoning } : {}),
        })
        return
      }
    }
    this.emitSocketEvent(bridge, event, payload)
  }

  private emitSocketEvent(bridge: LocalSocketBridge, event: string, payload: unknown): void {
    this.socket?.emit('app.socket.event', {
      id: bridge.id,
      namespace: bridge.namespace,
      event,
      payload,
    })
  }

  private redactedRelayUrl(): string {
    try {
      const url = new URL(this.relayUrl)
      url.username = ''
      url.password = ''
      return url.toString()
    } catch {
      return '<invalid-url>'
    }
  }

  private rememberPairing(payload: Record<string, unknown>): void {
    const pairingCode = typeof payload.pairingCode === 'string' ? payload.pairingCode.trim() : ''
    const expiresAt = Number(payload.expiresAt)
    if (!pairingCode || !Number.isFinite(expiresAt)) return
    this.pairingCode = pairingCode
    this.pairingExpiresAt = Math.floor(expiresAt)
  }

  private closeLocalBridges(): void {
    for (const bridge of this.bridges.values()) bridge.socket.disconnect()
    this.bridges.clear()
  }
}

const activeAppRelayClients = new Map<string, AppRelayClient>()

export function startAppRelayClient(options: StartAppRelayClientOptions): AppRelayClient | null {
  const relayUrl = String(options.relayUrl || '').trim()
  const machineId = String(options.machineId || '').trim()
  // The stable machine id is derived from the exact PEM bytes. Preserve the
  // trailing newline instead of normalizing the key before remote auth.
  const publicKey = String(options.publicKey || '')
  if (!relayUrl || !machineId || !publicKey.trim()) return null
  const connectionId = String(options.connectionId || machineId).trim()
  const existing = activeAppRelayClients.get(connectionId)
  if (existing) return existing
  const client = new AppRelayClient({
    relayUrl,
    machineId,
    publicKey,
    machineInfo: options.machineInfo,
    localBaseUrl: options.localBaseUrl || `http://127.0.0.1:${config.port}`,
    fetchImpl: options.fetchImpl || fetch,
  })
  client.start()
  activeAppRelayClients.set(connectionId, client)
  return client
}

export function getAppRelayClient(connectionId: string): AppRelayClient | null {
  return activeAppRelayClients.get(connectionId) || null
}

export function stopAppRelayClient(connectionId?: string): void {
  if (connectionId) {
    activeAppRelayClients.get(connectionId)?.stop()
    activeAppRelayClients.delete(connectionId)
    return
  }
  for (const client of activeAppRelayClients.values()) client.stop()
  activeAppRelayClients.clear()
}

function resolveAppRelayUrl(input: string): string {
  const url = new URL(input)
  const path = url.pathname.replace(/\/+$/, '')
  if (!path) url.pathname = APP_RELAY_NAMESPACE
  else if (path !== APP_RELAY_NAMESPACE && !path.endsWith(APP_RELAY_NAMESPACE)) url.pathname = `${path}${APP_RELAY_NAMESPACE}`
  return url.toString()
}

function normalizeMethod(value: unknown): string | null {
  const method = String(value || 'GET').trim().toUpperCase()
  return ALLOWED_METHODS.has(method) ? method : null
}

function normalizeRelayPath(value: unknown): string | null {
  const raw = String(value || '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null
  const parsed = new URL(raw, 'http://app-relay.local')
  if (parsed.pathname === '/api' || parsed.pathname.startsWith('/api/') || parsed.pathname === '/upload' || parsed.pathname === '/health') {
    return `${parsed.pathname}${parsed.search}`
  }
  return null
}

function normalizeHeaders(input: AppRelayHttpRequest['headers']): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(input || {})) {
    const lower = name.toLowerCase()
    if (!ALLOWED_REQUEST_HEADERS.has(lower) || value == null) continue
    const selected = Array.isArray(value) ? value.find(Boolean) : value
    if (selected) headers.set(lower, String(selected))
  }
  return headers
}

function normalizeRequestBody(request: AppRelayHttpRequest, method: string, headers: Headers): NormalizedBody | AppRelayHttpResponse {
  if (method === 'GET' || method === 'HEAD') return {}
  let body: BodyInit | undefined
  if (typeof request.bodyBase64 === 'string') body = Buffer.from(request.bodyBase64, 'base64')
  else if (typeof request.body === 'string') body = request.body
  else if (request.body != null) {
    body = JSON.stringify(request.body)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  }
  if (body != null && Buffer.byteLength(typeof body === 'string' ? body : Buffer.from(body as any)) > MAX_REQUEST_BODY_BYTES) {
    return httpError(request.id, 'request_body_too_large', 'Relay request body exceeds the local size limit', 413)
  }
  return { body }
}

function isHttpErrorResponse(value: NormalizedBody | AppRelayHttpResponse): value is AppRelayHttpResponse {
  return 'error' in value && Boolean(value.error)
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'connection' || key.toLowerCase() === 'transfer-encoding') return
    headers[key.toLowerCase()] = value
  })
  return headers
}

async function readResponseBody(response: Response): Promise<Pick<AppRelayHttpResponse, 'body' | 'bodyBase64' | 'truncated'>> {
  if (!response.body) return {}
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    const remaining = MAX_RESPONSE_BODY_BYTES - total
    if (chunk.byteLength > remaining) {
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const buffer = Buffer.concat(chunks)
  const contentType = response.headers.get('content-type') || ''
  const textual = TEXTUAL_RESPONSE_TYPES.some(prefix => contentType.toLowerCase().startsWith(prefix) || contentType.toLowerCase().includes(prefix))
  return textual ? { body: buffer.toString('utf8'), truncated } : { bodyBase64: buffer.toString('base64'), truncated }
}

function normalizeBridgeId(value: unknown): string {
  const id = String(value || '').trim()
  return id && id.length <= 128 ? id : ''
}

function normalizeSocketAuth(value: AppRelaySocketOpenRequest['auth']): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item != null))
}

function normalizeSocketQuery(value: AppRelaySocketOpenRequest['query']): Record<string, string> {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item != null).map(([key, item]) => [key, String(item)]))
}

function normalizeTimeout(value: unknown): number {
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_REQUEST_TIMEOUT_MS
  return Math.min(Math.floor(timeout), MAX_REQUEST_TIMEOUT_MS)
}

function httpError(id: string | undefined, code: string, message: string, status?: number): AppRelayHttpResponse {
  return { id, ...(status ? { status } : {}), error: { code, message } }
}

function socketError(id: string | undefined, code: string, message: string): AppRelaySocketResponse {
  return { id, ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

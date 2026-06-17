import { io, type Socket } from 'socket.io-client'
import { config } from '../../config'
import { logger } from '../logger'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'x-hermes-profile',
  'x-request-id',
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
const ALLOWED_SOCKET_NAMESPACES = new Set(['/chat-run'])
const ALLOWED_CHAT_RUN_CLIENT_EVENTS = new Set([
  'run',
  'resume',
  'abort',
  'cancel_queued_run',
  'approval.respond',
  'clarify.respond',
])
const CHAT_RUN_SERVER_EVENTS = [
  'run.started',
  'message.delta',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
  'tool.started',
  'tool.completed',
  'run.completed',
  'run.failed',
  'compression.started',
  'compression.completed',
  'abort.started',
  'abort.timeout',
  'abort.completed',
  'usage.updated',
  'agent.event',
  'subagent.event',
  'session.command',
  'session.title.updated',
  'run.queued',
  'approval.requested',
  'approval.resolved',
  'clarify.requested',
  'clarify.resolved',
  'peer.user.message',
  'resumed',
]
const NON_STREAMING_SUPPRESSED_EVENTS = new Set([
  'message.delta',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
])

export interface RelayHttpRequest {
  id?: string
  method?: string
  path?: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
  bodyBase64?: string
  timeoutMs?: number
}

export interface RelayHttpResponse {
  id?: string
  status?: number
  headers?: Record<string, string>
  body?: string
  bodyBase64?: string
  truncated?: boolean
  error?: {
    code: string
    message: string
  }
}

export interface RelaySocketOpenRequest {
  id?: string
  namespace?: string
  auth?: Record<string, unknown>
  query?: Record<string, string | number | boolean | undefined>
  stream?: boolean
}

export interface RelaySocketEventRequest {
  id?: string
  event?: string
  payload?: unknown
  stream?: boolean
}

export interface RelaySocketCloseRequest {
  id?: string
}

export interface RelaySocketResponse {
  id?: string
  ok?: boolean
  namespace?: string
  event?: string
  stream?: boolean
  payload?: unknown
  error?: {
    code: string
    message: string
  }
}

interface StartOutboundRelayClientOptions {
  connectionId?: string
  relayUrl?: string
  relayToken?: string
  instanceId?: string
  localBaseUrl?: string
  fetchImpl?: typeof fetch
}

type OutboundRelayClientOptions = Required<Omit<StartOutboundRelayClientOptions, 'connectionId'>>

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
  byteLength: number
}

function relayError(id: string | undefined, code: string, message: string, status?: number): RelayHttpResponse {
  return {
    id,
    ...(status ? { status } : {}),
    error: { code, message },
  }
}

function socketRelayError(id: string | undefined, code: string, message: string): RelaySocketResponse {
  return {
    id,
    ok: false,
    error: { code, message },
  }
}

function isRelayHttpResponse(value: NormalizedBody | RelayHttpResponse): value is RelayHttpResponse {
  return 'error' in value
}

function normalizeMethod(method?: string): string | null {
  const normalized = String(method || 'GET').trim().toUpperCase()
  return ALLOWED_METHODS.has(normalized) ? normalized : null
}

function normalizeRelayPath(path?: string): string | null {
  const raw = String(path || '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null

  const parsed = new URL(raw, 'http://hermes-relay.local')
  const normalized = `${parsed.pathname}${parsed.search}`
  if (parsed.pathname === '/v1' || parsed.pathname.startsWith('/v1/')) return null
  return normalized
}

function normalizeSocketBridgeId(id?: string): string | null {
  const normalized = String(id || '').trim()
  if (!normalized || normalized.length > 128) return null
  return normalized
}

function normalizeSocketNamespace(namespace?: string): string | null {
  const normalized = String(namespace || '').trim()
  return ALLOWED_SOCKET_NAMESPACES.has(normalized) ? normalized : null
}

function normalizeSocketQuery(query?: RelaySocketOpenRequest['query']): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null) continue
    normalized[key] = String(value)
  }
  return normalized
}

function normalizeSocketAuth(auth?: RelaySocketOpenRequest['auth']): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(auth || {})) {
    if (value == null) continue
    normalized[key] = value
  }
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function streamMode(value: unknown, fallback = true): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeTimeout(timeoutMs?: number): number {
  const value = Number(timeoutMs)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_REQUEST_TIMEOUT_MS
  return Math.min(Math.floor(value), MAX_REQUEST_TIMEOUT_MS)
}

function normalizeHeaders(headers?: RelayHttpRequest['headers']): Headers {
  const normalized = new Headers()
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase()
    if (!ALLOWED_REQUEST_HEADERS.has(lower) || value == null) continue
    const headerValue = Array.isArray(value) ? value.find(Boolean) : value
    if (headerValue) normalized.set(lower, String(headerValue))
  }
  return normalized
}

function normalizeRequestBody(request: RelayHttpRequest, method: string, headers: Headers): NormalizedBody | RelayHttpResponse {
  if (method === 'GET' || method === 'HEAD') {
    return { byteLength: 0 }
  }

  if (typeof request.bodyBase64 === 'string') {
    const buffer = Buffer.from(request.bodyBase64, 'base64')
    if (buffer.byteLength > MAX_REQUEST_BODY_BYTES) {
      return relayError(request.id, 'request_body_too_large', 'Relay request body exceeds the local size limit', 413)
    }
    return { body: buffer, byteLength: buffer.byteLength }
  }

  if (request.body == null) {
    return { byteLength: 0 }
  }

  if (typeof request.body === 'string') {
    const byteLength = Buffer.byteLength(request.body)
    if (byteLength > MAX_REQUEST_BODY_BYTES) {
      return relayError(request.id, 'request_body_too_large', 'Relay request body exceeds the local size limit', 413)
    }
    return { body: request.body, byteLength }
  }

  const serialized = JSON.stringify(request.body)
  const byteLength = Buffer.byteLength(serialized)
  if (byteLength > MAX_REQUEST_BODY_BYTES) {
    return relayError(request.id, 'request_body_too_large', 'Relay request body exceeds the local size limit', 413)
  }
  if (!headers.has('content-type')) {
    return { body: serialized, contentType: 'application/json', byteLength }
  }
  return { body: serialized, byteLength }
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower === 'connection' || lower === 'transfer-encoding') return
    headers[lower] = value
  })
  return headers
}

function isTextualResponse(contentType: string): boolean {
  const lower = contentType.toLowerCase()
  return TEXTUAL_RESPONSE_TYPES.some(prefix => lower.startsWith(prefix) || lower.includes(prefix))
}

async function readResponseBody(response: Response): Promise<{ body?: string; bodyBase64?: string; truncated?: boolean }> {
  const contentType = response.headers.get('content-type') || ''
  if (!response.body) return {}

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.byteLength
    if (total > MAX_RESPONSE_BODY_BYTES) {
      const remaining = Math.max(0, MAX_RESPONSE_BODY_BYTES - (total - chunk.byteLength))
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(chunk)
  }

  const buffer = Buffer.concat(chunks)
  if (isTextualResponse(contentType)) {
    return { body: buffer.toString('utf-8'), truncated }
  }
  return { bodyBase64: buffer.toString('base64'), truncated }
}

export class OutboundRelayClient {
  private socket: Socket | null = null
  private readonly socketBridges = new Map<string, LocalSocketBridge>()
  private readonly relayUrl: string
  private readonly relayToken: string
  private readonly instanceId: string
  private readonly localBaseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: OutboundRelayClientOptions) {
    this.relayUrl = options.relayUrl
    this.relayToken = options.relayToken
    this.instanceId = options.instanceId
    this.localBaseUrl = options.localBaseUrl.replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl
  }

  start(): void {
    if (this.socket) return
    this.socket = io(this.relayUrl, {
      auth: {
        token: this.relayToken || undefined,
        instanceId: this.instanceId || undefined,
        role: 'hermes-studio',
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 30_000,
    })

    this.socket.on('connect', () => {
      logger.info({ relayUrl: this.redactedRelayUrl() }, '[outbound-relay] connected')
      this.socket?.emit('relay.ready', {
        capabilities: ['http.request', 'socket.chat-run'],
        instanceId: this.instanceId || undefined,
      })
    })
    this.socket.on('connect_error', (err: Error) => {
      logger.warn({ err, relayUrl: this.redactedRelayUrl() }, '[outbound-relay] connection failed')
    })
    this.socket.on('disconnect', (reason: string) => {
      logger.info({ reason, relayUrl: this.redactedRelayUrl() }, '[outbound-relay] disconnected')
    })
    this.socket.on('http.request', (request: RelayHttpRequest, ack?: (response: RelayHttpResponse) => void) => {
      void this.handleHttpRequest(request)
        .then((response) => this.respond(response, ack))
        .catch((err) => this.respond(relayError(request?.id, 'relay_internal_error', err instanceof Error ? err.message : String(err), 500), ack))
    })
    this.socket.on('socket.open', (request: RelaySocketOpenRequest, ack?: (response: RelaySocketResponse) => void) => {
      this.respondSocket(this.openLocalSocket(request), ack)
    })
    this.socket.on('socket.event', (request: RelaySocketEventRequest, ack?: (response: RelaySocketResponse) => void) => {
      this.respondSocket(this.emitLocalSocketEvent(request), ack)
    })
    this.socket.on('socket.close', (request: RelaySocketCloseRequest, ack?: (response: RelaySocketResponse) => void) => {
      this.respondSocket(this.closeLocalSocket(request), ack)
    })
  }

  stop(): void {
    for (const bridge of this.socketBridges.values()) {
      bridge.socket.disconnect()
    }
    this.socketBridges.clear()
    this.socket?.disconnect()
    this.socket = null
  }

  async handleHttpRequest(request: RelayHttpRequest): Promise<RelayHttpResponse> {
    const method = normalizeMethod(request.method)
    if (!method) {
      return relayError(request.id, 'method_not_allowed', 'Relay request method is not allowed', 405)
    }

    const path = normalizeRelayPath(request.path)
    if (!path) {
      return relayError(request.id, 'path_not_allowed', 'Relay request path is not allowed', 403)
    }

    const headers = normalizeHeaders(request.headers)
    const normalizedBody = normalizeRequestBody(request, method, headers)
    if (isRelayHttpResponse(normalizedBody)) return normalizedBody
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
      const body = await readResponseBody(response)
      return {
        id: request.id,
        status: response.status,
        headers: responseHeaders(response),
        ...body,
      }
    } catch (err) {
      const aborted = controller.signal.aborted
      return relayError(
        request.id,
        aborted ? 'request_timeout' : 'local_request_failed',
        aborted ? `Local relay request timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
        aborted ? 504 : 502,
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  private respond(response: RelayHttpResponse, ack?: (response: RelayHttpResponse) => void): void {
    if (ack) {
      ack(response)
      return
    }
    this.socket?.emit('http.response', response)
  }

  private openLocalSocket(request: RelaySocketOpenRequest): RelaySocketResponse {
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')

    const namespace = normalizeSocketNamespace(request.namespace)
    if (!namespace) return socketRelayError(id, 'namespace_not_allowed', 'Relay socket namespace is not allowed')

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
      stream: streamMode(request.stream),
      output: '',
      reasoning: '',
    }
    this.socketBridges.set(id, bridge)

    localSocket.on('connect', () => {
      this.emitSocketEvent({ id, namespace, event: 'connect', payload: { socketId: localSocket.id } })
    })
    localSocket.on('connect_error', (err: Error) => {
      this.emitSocketEvent({ id, namespace, event: 'connect_error', payload: { message: err.message } })
    })
    localSocket.on('disconnect', (reason: string) => {
      this.emitSocketEvent({ id, namespace, event: 'disconnect', payload: { reason } })
    })
    for (const event of CHAT_RUN_SERVER_EVENTS) {
      localSocket.on(event, (payload: unknown) => {
        this.handleLocalSocketEvent(bridge, event, payload)
      })
    }

    return { id, ok: true, namespace, stream: bridge.stream }
  }

  private emitLocalSocketEvent(request: RelaySocketEventRequest): RelaySocketResponse {
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')

    const event = String(request.event || '').trim()
    if (!ALLOWED_CHAT_RUN_CLIENT_EVENTS.has(event)) {
      return socketRelayError(id, 'event_not_allowed', 'Relay socket event is not allowed')
    }

    const bridge = this.socketBridges.get(id)
    if (!bridge) return socketRelayError(id, 'socket_not_open', 'Relay socket is not open')
    if (typeof request.stream === 'boolean') {
      bridge.stream = request.stream
    }
    if (event === 'run') {
      bridge.output = ''
      bridge.reasoning = ''
    }

    bridge.socket.emit(event, request.payload)
    return { id, ok: true, namespace: bridge.namespace, event, stream: bridge.stream }
  }

  private closeLocalSocket(request: RelaySocketCloseRequest): RelaySocketResponse {
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')

    const bridge = this.socketBridges.get(id)
    if (!bridge) return { id, ok: true }
    bridge.socket.disconnect()
    this.socketBridges.delete(id)
    return { id, ok: true, namespace: bridge.namespace }
  }

  private emitSocketEvent(event: Required<Pick<RelaySocketResponse, 'id' | 'namespace' | 'event'>> & { payload?: unknown }): void {
    this.socket?.emit('socket.event', {
      id: event.id,
      namespace: event.namespace,
      event: event.event,
      payload: event.payload,
    })
  }

  private handleLocalSocketEvent(bridge: LocalSocketBridge, event: string, payload: unknown): void {
    if (!bridge.stream) {
      if (event === 'message.delta' && isRecord(payload) && typeof payload.delta === 'string') {
        bridge.output += payload.delta
        return
      }
      if ((event === 'reasoning.delta' || event === 'thinking.delta') && isRecord(payload)) {
        const delta = typeof payload.delta === 'string' ? payload.delta : typeof payload.text === 'string' ? payload.text : ''
        bridge.reasoning += delta
        return
      }
      if (NON_STREAMING_SUPPRESSED_EVENTS.has(event)) {
        return
      }
      if (event === 'run.completed') {
        this.emitSocketEvent({
          id: bridge.id,
          namespace: bridge.namespace,
          event,
          payload: this.withNonStreamingOutput(payload, bridge),
        })
        return
      }
    }

    this.emitSocketEvent({ id: bridge.id, namespace: bridge.namespace, event, payload })
  }

  private withNonStreamingOutput(payload: unknown, bridge: LocalSocketBridge): unknown {
    if (!isRecord(payload)) {
      return {
        output: bridge.output,
        ...(bridge.reasoning ? { reasoning: bridge.reasoning } : {}),
      }
    }
    return {
      ...payload,
      output: typeof payload.output === 'string' && payload.output ? payload.output : bridge.output,
      ...(bridge.reasoning && typeof payload.reasoning !== 'string' ? { reasoning: bridge.reasoning } : {}),
    }
  }

  private respondSocket(response: RelaySocketResponse, ack?: (response: RelaySocketResponse) => void): void {
    if (ack) {
      ack(response)
      return
    }
    this.socket?.emit('socket.response', response)
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
}

const activeClients = new Map<string, OutboundRelayClient>()

function normalizeOutboundRelayConnectionId(options: StartOutboundRelayClientOptions, relayUrl: string): string {
  return (options.connectionId || options.instanceId || relayUrl).trim()
}

export function startOutboundRelayClient(options: StartOutboundRelayClientOptions = {}): OutboundRelayClient | null {
  const relayUrl = (options.relayUrl ?? '').trim()
  if (!relayUrl) return null
  const connectionId = normalizeOutboundRelayConnectionId(options, relayUrl)
  const activeClient = activeClients.get(connectionId)
  if (activeClient) return activeClient

  const client = new OutboundRelayClient({
    relayUrl,
    relayToken: options.relayToken ?? '',
    instanceId: options.instanceId ?? '',
    localBaseUrl: options.localBaseUrl ?? `http://127.0.0.1:${config.port}`,
    fetchImpl: options.fetchImpl ?? fetch,
  })
  client.start()
  activeClients.set(connectionId, client)
  return client
}

export function getOutboundRelayClient(connectionId?: string): OutboundRelayClient | null {
  if (connectionId) return activeClients.get(connectionId) || null
  return activeClients.values().next().value || null
}

export function getOutboundRelayClients(): Map<string, OutboundRelayClient> {
  return new Map(activeClients)
}

export function stopOutboundRelayClient(connectionId?: string): void {
  if (connectionId) {
    activeClients.get(connectionId)?.stop()
    activeClients.delete(connectionId)
    return
  }
  for (const client of activeClients.values()) {
    client.stop()
  }
  activeClients.clear()
}

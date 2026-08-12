import type { Server as SocketIoServer, Socket } from 'socket.io'
import { io as createClientSocket, type Socket as ClientSocket } from 'socket.io-client'
import { config } from '../../config'
import { authenticateUserToken } from '../../middleware/user-auth'
import { getDeviceId } from '../system-info'
import { logger } from '../logger'
import type {
  AppRelayHttpRequest,
  AppRelayHttpResponse,
  AppRelaySocketCloseRequest,
  AppRelaySocketEventRequest,
  AppRelaySocketOpenRequest,
  AppRelaySocketResponse,
} from './client'

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
const ALLOWED_CHAT_RUN_CLIENT_EVENTS = new Set([
  'run',
  'resume',
  'abort',
  'insert_queued_run',
  'cancel_queued_run',
  'approval.respond',
  'clarify.respond',
])
const NON_STREAMING_SUPPRESSED_EVENTS = new Set([
  'message.delta',
  'message.interim',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
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

interface LocalAppRelayServerOptions {
  localBaseUrl?: string
  machineId?: string
  fetchImpl?: typeof fetch
}

interface LocalSocketBridge {
  key: string
  id: string
  namespace: '/chat-run'
  ownerSocketId: string
  socket: ClientSocket
  stream: boolean
  output: string
  reasoning: string
}

type NormalizedBody = {
  body?: BodyInit
  contentType?: string
}

/**
 * Serves the App-facing relay protocol directly from Hermes Studio.
 *
 * The cloud relay uses the same App events but forwards them through the
 * outbound AppRelayClient. On a LAN connection this server terminates those
 * events locally and talks to the loopback HTTP and /chat-run services without
 * an extra host-client hop.
 */
export class LocalAppRelayServer {
  private readonly namespace: ReturnType<SocketIoServer['of']>
  private readonly bridges = new Map<string, LocalSocketBridge>()
  private readonly localBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly configuredMachineId: string
  private initialized = false

  constructor(io: SocketIoServer, options: LocalAppRelayServerOptions = {}) {
    this.namespace = io.of(APP_RELAY_NAMESPACE)
    this.localBaseUrl = (options.localBaseUrl || `http://127.0.0.1:${config.port}`).replace(/\/$/, '')
    this.configuredMachineId = String(options.machineId || '').trim()
    this.fetchImpl = options.fetchImpl || fetch
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.namespace.use(async (socket, next) => {
      try {
        const auth = socket.handshake.auth || {}
        const role = String(auth.role || '').trim().toLowerCase()
        const machineId = normalizeIdentifier(auth.machineId || auth.machine_id || auth.instanceId)
        const localMachineId = this.configuredMachineId || await getDeviceId()
        const token = String(auth.token || '').trim()
        const user = token ? await authenticateUserToken(token) : null
        if (role !== 'app' || !machineId || machineId !== localMachineId || (token && !user)) {
          next(new Error('app_relay_unauthorized'))
          return
        }
        socket.data.appRelayRole = 'app'
        socket.data.machineId = localMachineId
        socket.data.localUser = user
        socket.data.localUserToken = token
        next()
      } catch (err) {
        logger.warn({ err }, '[app-relay:lan] socket authentication failed')
        next(new Error('app_relay_auth_failed'))
      }
    })
    this.namespace.on('connection', socket => this.onConnection(socket))
    logger.info('[app-relay:lan] Socket.IO ready at %s', APP_RELAY_NAMESPACE)
  }

  getNamespace(): string {
    return APP_RELAY_NAMESPACE
  }

  private onConnection(socket: Socket): void {
    const machineId = String(socket.data.machineId)
    socket.emit('relay.ready', {
      role: 'app',
      machineId,
      hostConnected: true,
      capabilities: ['http.request', 'socket.chat-run'],
    })
    if (socket.data.localUserToken) this.scheduleTokenExpiry(socket)

    socket.on('http.request', (request: AppRelayHttpRequest = {}, ack?: (response: AppRelayHttpResponse) => void) => {
      void this.handleHttpRequest(socket, request).then(response => ack?.(response))
    })
    socket.on('socket.open', (request: AppRelaySocketOpenRequest = {}, ack?: (response: AppRelaySocketResponse) => void) => {
      void this.openSocket(socket, request).then(response => ack?.(response))
    })
    socket.on('socket.event', (request: AppRelaySocketEventRequest = {}, ack?: (response: AppRelaySocketResponse) => void) => {
      void this.emitSocketEvent(socket, request).then(response => ack?.(response))
    })
    socket.on('socket.close', (request: AppRelaySocketCloseRequest = {}, ack?: (response: AppRelaySocketResponse) => void) => {
      ack?.(this.closeSocket(socket, request))
    })
    socket.on('disconnect', () => this.closeOwnerBridges(socket.id))
  }

  private async handleHttpRequest(socket: Socket, request: AppRelayHttpRequest): Promise<AppRelayHttpResponse> {
    const method = normalizeMethod(request.method)
    if (!method) return httpError(request.id, 'method_not_allowed', 'Relay request method is not allowed', 405)
    const path = normalizeRelayPath(request.path)
    if (!path) return httpError(request.id, 'path_not_allowed', 'Relay request path is not allowed', 403)

    const loginRequest = method === 'POST' && path === '/api/auth/login'
    const authenticated = Boolean(socket.data.localUserToken) && await this.authorized(socket)
    if (!authenticated && !loginRequest) {
      return httpError(request.id, 'app_relay_unauthorized', 'Log in to Hermes Studio before using the App relay', 401)
    }

    const headers = normalizeHeaders(request.headers)
    headers.delete('authorization')
    if (authenticated) headers.set('authorization', `Bearer ${socket.data.localUserToken}`)
    const normalizedBody = normalizeRequestBody(request, method, headers)
    if (isHttpErrorResponse(normalizedBody)) return normalizedBody
    if (normalizedBody.contentType) headers.set('content-type', normalizedBody.contentType)

    const timeoutMs = normalizeTimeout(request.timeoutMs)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.localBaseUrl}${path}`, {
        method,
        headers,
        body: normalizedBody.body,
        signal: controller.signal,
      })
      const responseBody = await readResponseBody(response)
      if (loginRequest && response.ok && typeof responseBody.body === 'string') {
        await this.promoteLogin(socket, responseBody.body)
      }
      return {
        id: request.id,
        status: response.status,
        headers: responseHeaders(response),
        ...responseBody,
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
      clearTimeout(timer)
    }
  }

  private async openSocket(socket: Socket, request: AppRelaySocketOpenRequest): Promise<AppRelaySocketResponse> {
    if (!await this.authorized(socket)) {
      return socketError(request.id, 'app_relay_unauthorized', 'The App relay session is no longer authorized')
    }
    const id = normalizeBridgeId(request.id)
    if (!id) return socketError(request.id, 'invalid_socket_id', 'A socket bridge id is required')
    if (request.namespace !== '/chat-run') {
      return socketError(id, 'namespace_not_allowed', 'Only /chat-run can be relayed')
    }

    this.closeSocket(socket, { id })
    const localSocket = createClientSocket(`${this.localBaseUrl}/chat-run`, {
      auth: {
        ...normalizeSocketAuth(request.auth),
        token: socket.data.localUserToken,
      },
      query: normalizeSocketQuery(request.query),
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 30_000,
    })
    const bridge: LocalSocketBridge = {
      key: bridgeKey(socket.id, id),
      id,
      namespace: '/chat-run',
      ownerSocketId: socket.id,
      socket: localSocket,
      stream: typeof request.stream === 'boolean' ? request.stream : true,
      output: '',
      reasoning: '',
    }
    this.bridges.set(bridge.key, bridge)
    localSocket.on('connect', () => this.forwardLocalSocketEvent(socket, bridge, 'connect', { socketId: localSocket.id }))
    localSocket.on('connect_error', (err: Error) => this.forwardLocalSocketEvent(socket, bridge, 'connect_error', { message: err.message }))
    localSocket.on('disconnect', (reason: string) => this.forwardLocalSocketEvent(socket, bridge, 'disconnect', { reason }))
    localSocket.onAny((event: string, ...args: unknown[]) => {
      this.handleLocalSocketEvent(socket, bridge, event, args.length <= 1 ? args[0] : args)
    })
    return { id, ok: true, namespace: bridge.namespace, stream: bridge.stream }
  }

  private async emitSocketEvent(socket: Socket, request: AppRelaySocketEventRequest): Promise<AppRelaySocketResponse> {
    if (!await this.authorized(socket)) {
      return socketError(request.id, 'app_relay_unauthorized', 'The App relay session is no longer authorized')
    }
    const id = normalizeBridgeId(request.id)
    if (!id) return socketError(request.id, 'invalid_socket_id', 'A socket bridge id is required')
    const event = String(request.event || '').trim()
    if (!ALLOWED_CHAT_RUN_CLIENT_EVENTS.has(event)) {
      return socketError(id, 'event_not_allowed', 'Relay socket event is not allowed')
    }
    const bridge = this.bridges.get(bridgeKey(socket.id, id))
    if (!bridge) return socketError(id, 'socket_not_open', 'The chat socket bridge is not open')
    if (typeof request.stream === 'boolean') bridge.stream = request.stream
    if (event === 'run') {
      bridge.output = ''
      bridge.reasoning = ''
    }
    bridge.socket.emit(event, request.payload)
    return { id, ok: true, namespace: bridge.namespace, event, stream: bridge.stream }
  }

  private closeSocket(socket: Socket, request: AppRelaySocketCloseRequest): AppRelaySocketResponse {
    const id = normalizeBridgeId(request.id)
    if (!id) return socketError(request.id, 'invalid_socket_id', 'A socket bridge id is required')
    const key = bridgeKey(socket.id, id)
    const bridge = this.bridges.get(key)
    if (!bridge) return { id, ok: true }
    bridge.socket.disconnect()
    this.bridges.delete(key)
    return { id, ok: true, namespace: bridge.namespace }
  }

  private handleLocalSocketEvent(socket: Socket, bridge: LocalSocketBridge, event: string, payload: unknown): void {
    if (!bridge.stream) {
      if (event === 'message.delta' && isRecord(payload) && typeof payload.delta === 'string') {
        bridge.output += payload.delta
        return
      }
      if ((event === 'reasoning.delta' || event === 'thinking.delta') && isRecord(payload)) {
        bridge.reasoning += typeof payload.delta === 'string'
          ? payload.delta
          : typeof payload.text === 'string'
            ? payload.text
            : ''
        return
      }
      if (NON_STREAMING_SUPPRESSED_EVENTS.has(event)) return
      if (event === 'run.completed') {
        const completion = isRecord(payload) ? payload : {}
        this.forwardLocalSocketEvent(socket, bridge, event, {
          ...completion,
          output: typeof completion.output === 'string' && completion.output ? completion.output : bridge.output,
          ...(bridge.reasoning && typeof completion.reasoning !== 'string' ? { reasoning: bridge.reasoning } : {}),
        })
        return
      }
    }
    this.forwardLocalSocketEvent(socket, bridge, event, payload)
  }

  private forwardLocalSocketEvent(socket: Socket, bridge: LocalSocketBridge, event: string, payload: unknown): void {
    if (this.bridges.get(bridge.key) !== bridge || !socket.connected) return
    socket.emit('socket.event', {
      id: bridge.id,
      namespace: bridge.namespace,
      event,
      payload,
    })
  }

  private closeOwnerBridges(ownerSocketId: string): void {
    for (const bridge of Array.from(this.bridges.values())) {
      if (bridge.ownerSocketId !== ownerSocketId) continue
      bridge.socket.disconnect()
      this.bridges.delete(bridge.key)
    }
  }

  private async authorized(socket: Socket): Promise<boolean> {
    const user = await authenticateUserToken(String(socket.data.localUserToken || ''))
    if (user) return true
    socket.emit('relay.access.revoked', {
      machineId: socket.data.machineId,
      reason: 'token_expired',
    })
    setImmediate(() => socket.disconnect(true))
    return false
  }

  private async promoteLogin(socket: Socket, responseBody: string): Promise<void> {
    try {
      const body = JSON.parse(responseBody) as Record<string, unknown>
      const token = String(body.token || '').trim()
      const user = token ? await authenticateUserToken(token) : null
      if (!token || !user) return
      socket.data.localUserToken = token
      socket.data.localUser = user
      this.scheduleTokenExpiry(socket)
    } catch {
      // A malformed success response is returned unchanged and does not
      // authenticate the relay session.
    }
  }

  private scheduleTokenExpiry(socket: Socket): void {
    const expiresAt = jwtExpiryMs(String(socket.data.localUserToken || ''))
    if (!expiresAt) return
    const existingTimer = socket.data.appRelayTokenExpiryTimer as NodeJS.Timeout | undefined
    if (existingTimer) clearTimeout(existingTimer)

    const schedule = () => {
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) {
        socket.emit('relay.access.revoked', {
          machineId: socket.data.machineId,
          reason: 'token_expired',
        })
        socket.disconnect(true)
        return
      }
      const timer = setTimeout(schedule, Math.min(remaining, 2_147_000_000))
      timer.unref()
      socket.data.appRelayTokenExpiryTimer = timer
    }
    schedule()
    socket.once('disconnect', () => {
      const timer = socket.data.appRelayTokenExpiryTimer as NodeJS.Timeout | undefined
      if (timer) clearTimeout(timer)
      socket.data.appRelayTokenExpiryTimer = undefined
    })
  }
}

let activeLocalAppRelayServer: LocalAppRelayServer | null = null

export function startLocalAppRelayServer(
  io: SocketIoServer,
  options: LocalAppRelayServerOptions = {},
): LocalAppRelayServer {
  if (activeLocalAppRelayServer) return activeLocalAppRelayServer
  activeLocalAppRelayServer = new LocalAppRelayServer(io, options)
  activeLocalAppRelayServer.init()
  return activeLocalAppRelayServer
}

function normalizeIdentifier(value: unknown): string {
  const normalized = String(value || '').trim()
  return normalized && normalized.length <= 255 ? normalized : ''
}

function normalizeMethod(value: unknown): string | null {
  const method = String(value || 'GET').trim().toUpperCase()
  return ALLOWED_METHODS.has(method) ? method : null
}

function normalizeRelayPath(value: unknown): string | null {
  const raw = String(value || '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null
  const parsed = new URL(raw, 'http://app-relay.local')
  if (
    parsed.pathname === '/api'
    || parsed.pathname.startsWith('/api/')
    || parsed.pathname === '/upload'
    || parsed.pathname === '/health'
  ) {
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

function normalizeRequestBody(
  request: AppRelayHttpRequest,
  method: string,
  headers: Headers,
): NormalizedBody | AppRelayHttpResponse {
  if (method === 'GET' || method === 'HEAD') return {}
  let body: BodyInit | undefined
  const byteBody = relayByteBuffer(request.bodyBytes)
  if (byteBody) body = Uint8Array.from(byteBody)
  else if (request.bodyBytes != null) return httpError(request.id, 'invalid_binary_body', 'Relay binary request body is invalid', 400)
  else if (typeof request.bodyBase64 === 'string') body = Buffer.from(request.bodyBase64, 'base64')
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

async function readResponseBody(
  response: Response,
): Promise<Pick<AppRelayHttpResponse, 'body' | 'bodyBytes' | 'truncated'>> {
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
  const textual = TEXTUAL_RESPONSE_TYPES.some(prefix => (
    contentType.toLowerCase().startsWith(prefix) || contentType.toLowerCase().includes(prefix)
  ))
  return textual
    ? { body: buffer.toString('utf8'), truncated }
    : { bodyBytes: buffer, truncated }
}

function relayByteBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return null
}

function normalizeBridgeId(value: unknown): string {
  const id = String(value || '').trim()
  return id && id.length <= 128 ? id : ''
}

function normalizeSocketAuth(value: AppRelaySocketOpenRequest['auth']): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item != null))
}

function normalizeSocketQuery(value: AppRelaySocketOpenRequest['query']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value || {})
      .filter(([, item]) => item != null)
      .map(([key, item]) => [key, String(item)]),
  )
}

function normalizeTimeout(value: unknown): number {
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_REQUEST_TIMEOUT_MS
  return Math.min(Math.floor(timeout), MAX_REQUEST_TIMEOUT_MS)
}

function bridgeKey(ownerSocketId: string, id: string): string {
  return `${ownerSocketId}:${id}`
}

function httpError(
  id: string | undefined,
  code: string,
  message: string,
  status?: number,
): AppRelayHttpResponse {
  return { id, ...(status ? { status } : {}), error: { code, message } }
}

function socketError(id: string | undefined, code: string, message: string): AppRelaySocketResponse {
  return { id, ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jwtExpiryMs(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')) as Record<string, unknown>
    const expiresAt = Number(payload.exp) * 1000
    return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0
  } catch {
    return 0
  }
}

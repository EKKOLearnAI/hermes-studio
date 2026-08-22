import { randomUUID } from 'crypto'
import { io, type Socket } from 'socket.io-client'
import { config } from '../../config'
import {
  assignLegacyCloudAppConnectionUser,
  listAppConnections,
  listPendingCloudAppConnectionRevocations,
  markCloudAppConnectionRevocationSynced,
} from '../../db/hermes/app-connections-store'
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
const ALLOWED_SOCKET_NAMESPACES = new Set(['/chat-run', '/group-chat', '/workflow'])
const ALLOWED_CHAT_RUN_CLIENT_EVENTS = new Set([
  'run',
  'resume',
  'abort',
  'insert_queued_run',
  'cancel_queued_run',
  'approval.respond',
  'clarify.respond',
])
const ALLOWED_GROUP_CHAT_CLIENT_EVENTS = new Set([
  'join',
  'load_pending_approvals',
  'load_messages',
  'update_member_profile',
  'message',
  'typing',
  'stop_typing',
  'interrupt_agent',
  'remove_agent',
  'approval.respond',
  'clarify.respond',
])
const ALLOWED_WORKFLOW_CLIENT_EVENTS = new Set([
  'workflows.list',
  'workflow.status.subscribe',
  'workflow.status.unsubscribe',
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

function normalizeCloudUserId(value: unknown): number {
  const userId = Number(value)
  return Number.isSafeInteger(userId) && userId > 0 ? userId : 0
}

function cloudConnectionKey(deviceCode: string, cloudUserId: number): string {
  return `${deviceCode}\u0000${cloudUserId}`
}

export interface AppRelayHttpRequest {
  id?: string
  method?: string
  path?: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
  bodyBytes?: ArrayBuffer | ArrayBufferView
  bodyBase64?: string
  timeoutMs?: number
}

export interface AppRelayHttpResponse {
  id?: string
  status?: number
  headers?: Record<string, string>
  body?: string
  bodyBytes?: Uint8Array
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
  ack?: boolean
  timeoutMs?: number
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

export interface CloudAppPreconnection {
  type: 'hermes-studio.app-connection'
  version: 1
  connectionType: 'cloud'
  machineId: string
  preconnectId: string
  matchingCode: string
  expiresAt: number
  hardExpiresAt: number
  refreshRemaining: number
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
  private readonly pendingPreconnections = new Map<string, {
    authorizationCode: string
    createdByUserId: number
    preconnection: CloudAppPreconnection
  }>()
  private readonly cloudConnectionOnline = new Map<string, boolean>()
  private preconnectionExpired = false

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
      // Every Socket.IO connection represents a new relay-side host session.
      // Preconnections are held in relay process memory, so anything cached by
      // Studio before a disconnect cannot be reused safely after reconnecting.
      this.clearRelaySessionState()
      this.preconnectionExpired = false
      logger.info({ relayUrl: this.redactedRelayUrl(), machineId: this.options.machineId }, '[app-relay] connected')
    })
    this.socket.on('connect_error', (err: Error) => {
      logger.warn({ err, relayUrl: this.redactedRelayUrl() }, '[app-relay] connection failed')
    })
    this.socket.on('disconnect', (reason: string) => {
      this.closeLocalBridges()
      this.clearRelaySessionState()
      logger.info({ reason, relayUrl: this.redactedRelayUrl() }, '[app-relay] disconnected')
    })
    this.socket.on('relay.replaced', () => this.stop())
    this.socket.on('relay.ready', (payload: Record<string, unknown> = {}) => {
      this.rememberPairing(payload)
    })
    this.socket.on('connection.authorize', (
      request: Record<string, unknown> = {},
      ack?: (response: Record<string, unknown>) => void,
    ) => {
      void this.authorizeCloudConnection(request).then(response => ack?.(response))
    })
    this.socket.on('connection.activated', (payload: Record<string, unknown> = {}) => {
      const preconnectId = String(payload.preconnectId || payload.preconnect_id || '').trim()
      if (preconnectId) this.pendingPreconnections.delete(preconnectId)
    })
    this.socket.on('connection.snapshot', (payload: Record<string, unknown> = {}) => {
      this.rememberConnectionSnapshot(payload)
      void this.reconcileConnectionSnapshot(payload)
    })
    this.socket.on('connection.status', (payload: Record<string, unknown> = {}) => {
      const deviceCode = String(payload.deviceCode || payload.device_code || '').trim()
      const cloudUserId = normalizeCloudUserId(
        payload.appUserId || payload.app_user_id || payload.userId || payload.user_id,
      )
      if (deviceCode && cloudUserId) {
        this.cloudConnectionOnline.set(cloudConnectionKey(deviceCode, cloudUserId), Boolean(payload.online))
      }
    })
    this.socket.on('relay.preconnect.expired', () => {
      this.pendingPreconnections.clear()
      this.preconnectionExpired = true
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
      void this.emitLocalSocketEvent(request).then(response => ack?.(response))
    })
    this.socket.on('app.socket.close', (request: AppRelaySocketCloseRequest, ack?: (response: AppRelaySocketResponse) => void) => {
      ack?.(this.closeLocalSocket(request))
    })
  }

  stop(): void {
    this.closeLocalBridges()
    this.clearRelaySessionState()
    this.socket?.disconnect()
    this.socket = null
  }

  isConnected(): boolean {
    return Boolean(this.socket?.connected)
  }

  isPreconnectionExpired(): boolean {
    return this.preconnectionExpired
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

  requestPreconnection(
    authorizationCode: string,
    refresh = false,
    timeoutMs = 8000,
    createdByUserId = 0,
  ): Promise<CloudAppPreconnection> {
    const socket = this.socket
    if (!socket?.connected) return Promise.reject(new Error('app_relay_not_connected'))
    return new Promise((resolve, reject) => {
      socket.timeout(timeoutMs).emit(
        'preconnect.request',
        { refresh },
        (error: Error | null, response: Record<string, unknown> = {}) => {
          if (error || response.ok === false) {
            const failure = new Error(String(response.error || error?.message || 'preconnection_request_failed')) as Error & {
              retryAfter?: number
              refreshRemaining?: number
            }
            failure.retryAfter = Number(response.retryAfter) || undefined
            failure.refreshRemaining = Number(response.refreshRemaining)
            reject(failure)
            return
          }
          const preconnection = normalizeCloudPreconnection(response)
          if (!preconnection) {
            reject(new Error('preconnection_request_failed'))
            return
          }
          this.pendingPreconnections.set(preconnection.preconnectId, {
            authorizationCode,
            createdByUserId,
            preconnection,
          })
          resolve(preconnection)
        },
      )
    })
  }

  getCachedPreconnection(
    createdByUserId: number,
    now = Math.floor(Date.now() / 1000),
  ): CloudAppPreconnection | null {
    for (const [preconnectId, pending] of this.pendingPreconnections.entries()) {
      if (
        pending.preconnection.expiresAt <= now
        || pending.preconnection.hardExpiresAt <= now
      ) {
        this.pendingPreconnections.delete(preconnectId)
        continue
      }
      if (pending.createdByUserId !== createdByUserId) continue
      return { ...pending.preconnection }
    }
    return null
  }

  revokeCloudConnection(deviceCode: string, appUserId: number, timeoutMs = 8000): Promise<boolean> {
    const socket = this.socket
    const cloudUserId = normalizeCloudUserId(appUserId)
    if (!socket?.connected || !cloudUserId) return Promise.resolve(false)
    return new Promise(resolve => {
      socket.timeout(timeoutMs).emit(
        'connection.revoke',
        { deviceCode, appUserId: cloudUserId },
        (error: Error | null, response: Record<string, unknown> = {}) => {
          resolve(!error && response.ok === true)
        },
      )
    })
  }

  isCloudDeviceOnline(deviceCode: string, appUserId: number): boolean {
    const cloudUserId = normalizeCloudUserId(appUserId)
    if (cloudUserId) return this.cloudConnectionOnline.get(cloudConnectionKey(deviceCode, cloudUserId)) || false
    const prefix = `${deviceCode}\u0000`
    return [...this.cloudConnectionOnline.entries()]
      .some(([key, online]) => key.startsWith(prefix) && online)
  }

  waitForConnected(timeoutMs = 5000): Promise<boolean> {
    const socket = this.socket
    if (!socket) return Promise.resolve(false)
    if (socket.connected) return Promise.resolve(true)
    return new Promise(resolve => {
      const cleanup = () => {
        clearTimeout(timer)
        socket.off('connect', onConnect)
      }
      const onConnect = () => {
        cleanup()
        resolve(true)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(false)
      }, timeoutMs)
      socket.once('connect', onConnect)
    })
  }

  async handleHttpRequest(request: AppRelayHttpRequest): Promise<AppRelayHttpResponse> {
    const method = normalizeMethod(request.method)
    if (!method) return httpError(request.id, 'method_not_allowed', 'Relay request method is not allowed', 405)
    const path = normalizeRelayPath(request.path)
    if (!path) return httpError(request.id, 'path_not_allowed', 'Relay request path is not allowed', 403)

    const headers = normalizeHeaders(request.headers)
    if (method === 'POST' && path === '/api/auth/app-login') {
      headers.delete('authorization')
      headers.set('x-hermes-app-connection', 'cloud')
    }
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

  private async emitLocalSocketEvent(request: AppRelaySocketEventRequest): Promise<AppRelaySocketResponse> {
    const id = normalizeBridgeId(request.id)
    if (!id) return socketError(request.id, 'invalid_socket_id', 'Relay socket id is required')
    const event = String(request.event || '').trim()
    const bridge = this.bridges.get(id)
    if (!bridge) return socketError(id, 'socket_not_open', 'Relay socket is not open')
    if (!isAllowedSocketEvent(bridge.namespace, event)) return socketError(id, 'event_not_allowed', 'Relay socket event is not allowed')
    if (typeof request.stream === 'boolean') bridge.stream = request.stream
    if (event === 'run') {
      bridge.output = ''
      bridge.reasoning = ''
    }
    if (!request.ack) {
      bridge.socket.emit(event, request.payload)
      return { id, ok: true, namespace: bridge.namespace, event, stream: bridge.stream }
    }
    try {
      const payload = await emitLocalSocketWithAck(bridge.socket, event, request.payload, normalizeTimeout(request.timeoutMs))
      return { id, ok: true, namespace: bridge.namespace, event, stream: bridge.stream, payload }
    } catch (error) {
      return socketError(id, 'socket_ack_timeout', error instanceof Error ? error.message : 'Socket acknowledgement timed out')
    }
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

  private clearRelaySessionState(): void {
    this.pendingPreconnections.clear()
    this.cloudConnectionOnline.clear()
    this.pairingCode = ''
    this.pairingExpiresAt = 0
  }

  private async authorizeCloudConnection(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const preconnectId = String(request.preconnectId || request.preconnect_id || '').trim()
    const matchingCode = String(request.matchingCode || request.matching_code || '').trim()
    const pending = this.pendingPreconnections.get(preconnectId)
    const cloudUserId = normalizeCloudUserId(
      request.appUserId || request.app_user_id || request.userId || request.user_id,
    )
    if (
      !pending
      || pending.preconnection.expiresAt <= Math.floor(Date.now() / 1000)
      || pending.preconnection.matchingCode !== matchingCode
    ) return { ok: false, error: 'studio_preconnection_not_found' }
    if (!cloudUserId) return { ok: false, error: 'app_user_id_required' }

    const response = await this.handleHttpRequest({
      id: `cloud-login-${preconnectId}`,
      method: 'POST',
      path: '/api/auth/app-login',
      headers: { 'content-type': 'application/json' },
      body: {
        authorization_code: pending.authorizationCode,
        device_code: request.deviceCode || request.device_code,
        device_name: request.deviceName || request.device_name,
        device_brand: request.deviceBrand || request.device_brand,
        device_model: request.deviceModel || request.device_model,
        cloud_user_id: cloudUserId,
      },
    })
    if (Number(response.status) < 200 || Number(response.status) >= 300 || typeof response.body !== 'string') {
      return { ok: false, error: response.error?.code || `studio_login_http_${Number(response.status || 0)}` }
    }
    try {
      const body = JSON.parse(response.body) as Record<string, any>
      const appConnection = body.appConnection && typeof body.appConnection === 'object'
        ? body.appConnection as Record<string, unknown>
        : {}
      const token = String(body.token || '').trim()
      const studioUserId = Number(body.userId)
      if (!token || !Number.isSafeInteger(studioUserId) || studioUserId <= 0) {
        return { ok: false, error: 'studio_authorization_invalid' }
      }
      return {
        ok: true,
        studioUserId,
        studioToken: token,
        studioTokenExpiresAt: Number(appConnection.token_expires_at) || 0,
        profiles: Array.isArray(body.profiles) ? body.profiles : [],
        machineName: String(this.options.machineInfo?.computer_name || this.options.machineId),
        machine: this.options.machineInfo || { device_id: this.options.machineId },
      }
    } catch {
      return { ok: false, error: 'studio_authorization_invalid' }
    }
  }

  private rememberConnectionSnapshot(payload: Record<string, unknown>): void {
    this.cloudConnectionOnline.clear()
    const connections = Array.isArray(payload.connections) ? payload.connections : []
    for (const item of connections) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const connection = item as Record<string, unknown>
      const deviceCode = String(connection.deviceCode || connection.device_code || '').trim()
      const cloudUserId = normalizeCloudUserId(
        connection.appUserId || connection.app_user_id || connection.userId || connection.user_id,
      )
      if (deviceCode && cloudUserId) {
        this.cloudConnectionOnline.set(cloudConnectionKey(deviceCode, cloudUserId), Boolean(connection.online))
      }
    }
  }

  private async reconcileConnectionSnapshot(payload: Record<string, unknown>): Promise<void> {
    const connections = Array.isArray(payload.connections) ? payload.connections : []
    const remoteAccountsByDevice = new Map<string, Set<number>>()
    for (const item of connections) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const connection = item as Record<string, unknown>
      const deviceCode = String(connection.deviceCode || connection.device_code || '').trim()
      const cloudUserId = normalizeCloudUserId(
        connection.appUserId || connection.app_user_id || connection.userId || connection.user_id,
      )
      if (!deviceCode || !cloudUserId) continue
      const accounts = remoteAccountsByDevice.get(deviceCode) || new Set<number>()
      accounts.add(cloudUserId)
      remoteAccountsByDevice.set(deviceCode, accounts)
    }
    for (const [deviceCode, accountIds] of remoteAccountsByDevice) {
      if (accountIds.size === 1) {
        assignLegacyCloudAppConnectionUser(deviceCode, [...accountIds][0])
      }
    }

    const localConnections = listAppConnections()
      .filter(connection => connection.connection_type === 'cloud')
    const localConnectionKeys = new Set(
      localConnections
        .filter(connection => connection.cloud_user_id > 0)
        .map(connection => cloudConnectionKey(connection.device_code, connection.cloud_user_id)),
    )
    const legacyDeviceCodes = new Set(
      localConnections
        .filter(connection => connection.cloud_user_id === 0)
        .map(connection => connection.device_code),
    )
    const pendingRevocationKeys = new Set(
      listPendingCloudAppConnectionRevocations()
        .map(connection => cloudConnectionKey(connection.device_code, connection.cloud_user_id)),
    )
    for (const item of connections) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const connection = item as Record<string, unknown>
      const deviceCode = String(connection.deviceCode || connection.device_code || '').trim()
      const cloudUserId = normalizeCloudUserId(
        connection.appUserId || connection.app_user_id || connection.userId || connection.user_id,
      )
      if (
        !deviceCode
        || !cloudUserId
        || localConnectionKeys.has(cloudConnectionKey(deviceCode, cloudUserId))
        || legacyDeviceCodes.has(deviceCode)
        || !pendingRevocationKeys.has(cloudConnectionKey(deviceCode, cloudUserId))
      ) continue
      if (await this.revokeCloudConnection(deviceCode, cloudUserId)) {
        markCloudAppConnectionRevocationSynced(deviceCode, cloudUserId)
        this.cloudConnectionOnline.delete(cloudConnectionKey(deviceCode, cloudUserId))
      }
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

function normalizeCloudPreconnection(value: Record<string, unknown>): CloudAppPreconnection | null {
  const type = String(value.type || '')
  const version = Number(value.version)
  const connectionType = String(value.connectionType || value.connection_type || '')
  const machineId = String(value.machineId || value.machine_id || '').trim()
  const preconnectId = String(value.preconnectId || value.preconnect_id || '').trim()
  const matchingCode = String(value.matchingCode || value.matching_code || '').trim()
  const expiresAt = Number(value.expiresAt || value.expires_at)
  const hardExpiresAt = Number(value.hardExpiresAt || value.hard_expires_at)
  const refreshRemaining = Number(value.refreshRemaining ?? value.refresh_remaining)
  if (
    type !== 'hermes-studio.app-connection'
    || version !== 1
    || connectionType !== 'cloud'
    || !machineId
    || !preconnectId
    || !matchingCode
    || !Number.isSafeInteger(expiresAt)
    || !Number.isSafeInteger(hardExpiresAt)
  ) return null
  return {
    type: 'hermes-studio.app-connection',
    version: 1,
    connectionType: 'cloud',
    machineId,
    preconnectId,
    matchingCode,
    expiresAt,
    hardExpiresAt,
    refreshRemaining: Number.isSafeInteger(refreshRemaining) ? refreshRemaining : 0,
  }
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

async function readResponseBody(response: Response): Promise<Pick<AppRelayHttpResponse, 'body' | 'bodyBytes' | 'truncated'>> {
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
  return textual ? { body: buffer.toString('utf8'), truncated } : { bodyBytes: buffer, truncated }
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
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item != null).map(([key, item]) => [key, String(item)]))
}

function normalizeTimeout(value: unknown): number {
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_REQUEST_TIMEOUT_MS
  return Math.min(Math.floor(timeout), MAX_REQUEST_TIMEOUT_MS)
}

function isAllowedSocketEvent(namespace: string, event: string): boolean {
  if (namespace === '/chat-run') return ALLOWED_CHAT_RUN_CLIENT_EVENTS.has(event)
  if (namespace === '/group-chat') return ALLOWED_GROUP_CHAT_CLIENT_EVENTS.has(event)
  if (namespace === '/workflow') return ALLOWED_WORKFLOW_CLIENT_EVENTS.has(event)
  return false
}

function emitLocalSocketWithAck(socket: Socket, event: string, payload: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`Socket acknowledgement timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    socket.emit(event, payload, (...args: unknown[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(args.length <= 1 ? args[0] : args)
    })
  })
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

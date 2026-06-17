import { randomBytes } from 'crypto'
import type { Server, Socket } from 'socket.io'
import { logger } from '../logger'
import { authenticateUserToken, type AuthenticatedUser } from '../../middleware/user-auth'
import { userCanAccessProfile } from '../../db/hermes/users-store'
import type {
  RelayHttpRequest,
  RelayHttpResponse,
  RelaySocketCloseRequest,
  RelaySocketEventRequest,
  RelaySocketOpenRequest,
  RelaySocketResponse,
} from './outbound-relay-client'

const GLOBAL_AGENT_NAMESPACE = '/global-agent'
const DEFAULT_GLOBAL_AGENT_TIMEOUT_MS = 30_000
const SOCKET_IO_RESERVED_EVENTS = new Set([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
])

interface GlobalAgentRequestOptions {
  clientId?: string
  timeoutMs?: number
}

function timeoutMs(value?: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : DEFAULT_GLOBAL_AGENT_TIMEOUT_MS
}

function responseError<T extends { id?: string; ok?: boolean; error?: { code: string; message: string } }>(
  id: string | undefined,
  code: string,
  message: string,
): T {
  return {
    id,
    ok: false,
    error: { code, message },
  } as T
}

export class GlobalAgentServer {
  private readonly nsp: ReturnType<Server['of']>
  private readonly clients = new Map<string, Socket>()
  private readonly frontendClients = new Map<string, Socket>()
  private readonly bridgeOwners = new Map<string, string>()
  private readonly authToken = randomBytes(32).toString('hex')
  private initialized = false

  constructor(io: Server) {
    this.nsp = io.of(GLOBAL_AGENT_NAMESPACE)
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.nsp.use(async (socket, next) => {
      const auth = socket.handshake.auth || {}
      const token = String(auth.token || '')
      if (token !== this.authToken) {
        const user = await authenticateUserToken(token)
        if (!user) {
          next(new Error('Unauthorized'))
          return
        }
        const profile = String(auth.profile || socket.handshake.query?.profile || '').trim()
        if (profile && !this.canAccessProfile(user, profile)) {
          next(new Error('Profile access denied'))
          return
        }
        socket.data.globalAgentRole = 'frontend'
        socket.data.user = user
        socket.data.userToken = token
        socket.data.profile = profile
        next()
        return
      }
      socket.data.globalAgentRole = 'agent'
      next()
    })
    this.nsp.on('connection', this.onConnection.bind(this))
    logger.info('[global-agent] Socket.IO ready at %s', GLOBAL_AGENT_NAMESPACE)
  }

  getNamespace(): string {
    return GLOBAL_AGENT_NAMESPACE
  }

  getAuthToken(): string {
    return this.authToken
  }

  getClientIds(): string[] {
    return Array.from(this.clients.keys())
  }

  async httpRequest(request: RelayHttpRequest, options: GlobalAgentRequestOptions = {}): Promise<RelayHttpResponse> {
    const socket = this.resolveClient(options.clientId)
    if (!socket) {
      return responseError<RelayHttpResponse>(request.id, 'global_agent_unavailable', 'No global agent client is connected')
    }
    return this.emitWithAck<RelayHttpResponse>(socket, 'http.request', request, options.timeoutMs, request.id)
  }

  async openSocket(request: RelaySocketOpenRequest, options: GlobalAgentRequestOptions = {}): Promise<RelaySocketResponse> {
    const socket = this.resolveClient(options.clientId)
    if (!socket) return responseError<RelaySocketResponse>(request.id, 'global_agent_unavailable', 'No global agent client is connected')
    return this.emitWithAck<RelaySocketResponse>(socket, 'socket.open', request, options.timeoutMs, request.id)
  }

  async emitSocketEvent(request: RelaySocketEventRequest, options: GlobalAgentRequestOptions = {}): Promise<RelaySocketResponse> {
    const socket = this.resolveClient(options.clientId)
    if (!socket) return responseError<RelaySocketResponse>(request.id, 'global_agent_unavailable', 'No global agent client is connected')
    return this.emitWithAck<RelaySocketResponse>(socket, 'socket.event', request, options.timeoutMs, request.id)
  }

  async closeSocket(request: RelaySocketCloseRequest, options: GlobalAgentRequestOptions = {}): Promise<RelaySocketResponse> {
    const socket = this.resolveClient(options.clientId)
    if (!socket) return responseError<RelaySocketResponse>(request.id, 'global_agent_unavailable', 'No global agent client is connected')
    return this.emitWithAck<RelaySocketResponse>(socket, 'socket.close', request, options.timeoutMs, request.id)
  }

  private onConnection(socket: Socket): void {
    if (socket.data.globalAgentRole === 'frontend') {
      this.onFrontendConnection(socket)
      return
    }
    this.onAgentConnection(socket)
  }

  private onAgentConnection(socket: Socket): void {
    const clientId = String(socket.handshake.auth?.instanceId || socket.id)
    this.clients.set(clientId, socket)
    logger.info('[global-agent] client connected id=%s socket=%s', clientId, socket.id)

    socket.on('disconnect', () => {
      if (this.clients.get(clientId)?.id === socket.id) {
        this.clients.delete(clientId)
      }
      logger.info('[global-agent] client disconnected id=%s socket=%s', clientId, socket.id)
    })
    socket.on('relay.ready', (payload: unknown) => {
      logger.info({ clientId, payload }, '[global-agent] client ready')
    })
    socket.on('socket.event', (payload: unknown) => {
      this.emitFrontendBridgeEvent(clientId, payload)
      this.nsp.emit('relay.socket.event', { clientId, payload })
    })
    socket.on('http.response', (payload: unknown) => {
      this.nsp.emit('relay.http.response', { clientId, payload })
    })
  }

  private onFrontendConnection(socket: Socket): void {
    this.frontendClients.set(socket.id, socket)
    logger.info('[global-agent] frontend connected socket=%s user=%s', socket.id, socket.data.user?.id)

    socket.on('http.request', (request: RelayHttpRequest & { clientId?: string }, ack?: (response: RelayHttpResponse) => void) => {
      void this.httpRequest(
        this.withFrontendHttpAuth(socket, request),
        { clientId: request.clientId, timeoutMs: request.timeoutMs },
      ).then(response => ack?.(response))
    })
    socket.on('socket.open', (request: RelaySocketOpenRequest & { clientId?: string; timeoutMs?: number }, ack?: (response: RelaySocketResponse) => void) => {
      void this.openSocket(
        this.withFrontendSocketAuth(socket, request),
        { clientId: request.clientId, timeoutMs: request.timeoutMs },
      ).then((response) => {
        const bridgeId = String(request.id || '').trim()
        if (!response.error && bridgeId) this.bridgeOwners.set(bridgeId, socket.id)
        ack?.(response)
      })
    })
    socket.on('socket.event', (request: RelaySocketEventRequest & { clientId?: string; timeoutMs?: number }, ack?: (response: RelaySocketResponse) => void) => {
      if (!this.frontendOwnsBridge(socket, request.id)) {
        ack?.(responseError<RelaySocketResponse>(request.id, 'socket_not_open', 'Relay socket is not open for this frontend client'))
        return
      }
      void this.emitSocketEvent(
        this.withFrontendSocketPayload(socket, request),
        { clientId: request.clientId, timeoutMs: request.timeoutMs },
      ).then(response => ack?.(response))
    })
    socket.on('socket.close', (request: RelaySocketCloseRequest & { clientId?: string; timeoutMs?: number }, ack?: (response: RelaySocketResponse) => void) => {
      if (!this.frontendOwnsBridge(socket, request.id)) {
        ack?.(responseError<RelaySocketResponse>(request.id, 'socket_not_open', 'Relay socket is not open for this frontend client'))
        return
      }
      void this.closeSocket(request, { clientId: request.clientId, timeoutMs: request.timeoutMs }).then((response) => {
        const bridgeId = String(request.id || '').trim()
        if (bridgeId) this.bridgeOwners.delete(bridgeId)
        ack?.(response)
      })
    })
    socket.on('run', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'run', payload)
    })
    socket.on('resume', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'resume', payload)
    })
    socket.on('abort', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'abort', payload)
    })
    socket.on('cancel_queued_run', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'cancel_queued_run', payload)
    })
    socket.on('approval.respond', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'approval.respond', payload)
    })
    socket.on('clarify.respond', (payload: unknown) => {
      void this.emitFrontendChatEvent(socket, 'clarify.respond', payload)
    })
    socket.on('disconnect', () => {
      this.frontendClients.delete(socket.id)
      for (const [bridgeId, ownerSocketId] of this.bridgeOwners.entries()) {
        if (ownerSocketId !== socket.id) continue
        this.bridgeOwners.delete(bridgeId)
        void this.closeSocket({ id: bridgeId })
      }
      logger.info('[global-agent] frontend disconnected socket=%s user=%s', socket.id, socket.data.user?.id)
    })
  }

  private resolveClient(clientId?: string): Socket | null {
    if (clientId) return this.clients.get(clientId) || null
    return this.clients.values().next().value || null
  }

  private canAccessProfile(user: AuthenticatedUser, profile: string): boolean {
    return user.role === 'super_admin' || userCanAccessProfile(user.id, profile)
  }

  private frontendProfile(socket: Socket): string {
    return String(socket.data.profile || '').trim()
  }

  private withFrontendHttpAuth(socket: Socket, request: RelayHttpRequest): RelayHttpRequest {
    const headers = { ...(request.headers || {}) }
    headers.authorization = `Bearer ${socket.data.userToken}`
    const profile = this.frontendProfile(socket)
    if (profile) headers['x-hermes-profile'] = profile
    return { ...request, headers }
  }

  private withFrontendSocketAuth(socket: Socket, request: RelaySocketOpenRequest): RelaySocketOpenRequest {
    const profile = this.frontendProfile(socket)
    return {
      ...request,
      auth: {
        ...(request.auth || {}),
        token: socket.data.userToken,
      },
      query: {
        ...(request.query || {}),
        ...(profile ? { profile } : {}),
      },
    }
  }

  private withFrontendSocketPayload(socket: Socket, request: RelaySocketEventRequest): RelaySocketEventRequest {
    const profile = this.frontendProfile(socket)
    if (!profile || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) {
      return request
    }
    const payload = request.payload as Record<string, unknown>
    return {
      ...request,
      payload: {
        ...payload,
        profile: typeof payload.profile === 'string' && payload.profile ? payload.profile : profile,
      },
    }
  }

  private frontendOwnsBridge(socket: Socket, id?: string): boolean {
    const bridgeId = String(id || '').trim()
    return Boolean(bridgeId) && this.bridgeOwners.get(bridgeId) === socket.id
  }

  private frontendBridgeId(socket: Socket): string {
    return `frontend:${socket.id}:chat-run`
  }

  private async ensureFrontendChatBridge(socket: Socket): Promise<string | null> {
    const id = this.frontendBridgeId(socket)
    if (this.bridgeOwners.get(id) === socket.id) return id

    const response = await this.openSocket(this.withFrontendSocketAuth(socket, {
      id,
      namespace: '/chat-run',
      stream: true,
    }))
    if (response.error) {
      socket.emit('connect_error', new Error(response.error.message))
      return null
    }
    this.bridgeOwners.set(id, socket.id)
    return id
  }

  private async emitFrontendChatEvent(socket: Socket, event: string, payload: unknown): Promise<void> {
    const id = await this.ensureFrontendChatBridge(socket)
    if (!id) return
    const response = await this.emitSocketEvent(this.withFrontendSocketPayload(socket, {
      id,
      event,
      payload,
    }))
    if (response.error) {
      const sessionId = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? String((payload as Record<string, unknown>).session_id || '')
        : ''
      socket.emit('run.failed', {
        event: 'run.failed',
        ...(sessionId ? { session_id: sessionId } : {}),
        error: response.error.message,
      })
    }
  }

  private emitFrontendBridgeEvent(_clientId: string, event: unknown): void {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return
    const record = event as {
      id?: unknown
      event?: unknown
      payload?: unknown
    }
    const bridgeId = typeof record.id === 'string' ? record.id : ''
    const eventName = typeof record.event === 'string' ? record.event : ''
    if (!bridgeId || !eventName) return
    if (SOCKET_IO_RESERVED_EVENTS.has(eventName)) return
    const ownerSocketId = this.bridgeOwners.get(bridgeId)
    if (!ownerSocketId) return
    this.frontendClients.get(ownerSocketId)?.emit(eventName, record.payload)
  }

  private emitWithAck<T extends { id?: string; ok?: boolean; error?: { code: string; message: string } }>(
    socket: Socket,
    event: string,
    payload: unknown,
    requestedTimeoutMs: number | undefined,
    id: string | undefined,
  ): Promise<T> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(responseError<T>(id, 'global_agent_timeout', `Global agent request timed out after ${timeoutMs(requestedTimeoutMs)}ms`))
      }, timeoutMs(requestedTimeoutMs))
      socket.emit(event, payload, (response: T) => {
        clearTimeout(timer)
        resolve(response)
      })
    })
  }
}

let activeGlobalAgentServer: GlobalAgentServer | null = null

export function startGlobalAgentServer(io: Server): GlobalAgentServer {
  if (activeGlobalAgentServer) return activeGlobalAgentServer
  activeGlobalAgentServer = new GlobalAgentServer(io)
  activeGlobalAgentServer.init()
  return activeGlobalAgentServer
}

export function getGlobalAgentServer(): GlobalAgentServer | null {
  return activeGlobalAgentServer
}

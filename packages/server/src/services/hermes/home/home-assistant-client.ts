import WebSocket, { type RawData } from 'ws'
import type { ResolvedHomeAssistantConfig } from './home-assistant-config'

export type HomeAssistantClientErrorCode =
  | 'HOME_ASSISTANT_ABORTED'
  | 'HOME_ASSISTANT_TIMEOUT'
  | 'HOME_ASSISTANT_REST_FAILED'
  | 'HOME_ASSISTANT_REST_AUTH_FAILED'
  | 'HOME_ASSISTANT_STATE_NOT_FOUND'
  | 'HOME_ASSISTANT_SERVICE_DENIED'
  | 'HOME_ASSISTANT_SERVICE_FAILED'
  | 'HOME_ASSISTANT_RESPONSE_TOO_LARGE'
  | 'HOME_ASSISTANT_RESPONSE_INVALID'
  | 'HOME_ASSISTANT_WS_CONNECT_FAILED'
  | 'HOME_ASSISTANT_WS_AUTH_FAILED'
  | 'HOME_ASSISTANT_WS_SUBSCRIBE_FAILED'
  | 'HOME_ASSISTANT_WS_PROTOCOL_INVALID'
  | 'HOME_ASSISTANT_WS_CLOSED'

export class HomeAssistantClientError extends Error {
  constructor(readonly code: HomeAssistantClientErrorCode) {
    super(code)
    this.name = 'HomeAssistantClientError'
  }
}

export interface HomeAssistantSubscriptionClose {
  clean: boolean
  code: HomeAssistantClientErrorCode | null
}

export interface HomeAssistantStateSubscription {
  haVersion: string
  closed: Promise<HomeAssistantSubscriptionClose>
  ping(signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}

type ProtocolMessage = Record<string, unknown> & { type: string }
type MessageObserver = (message: ProtocolMessage) => boolean

interface MessageWaiter {
  predicate: (message: ProtocolMessage) => boolean
  resolve: (message: ProtocolMessage) => void
  reject: (error: HomeAssistantClientError) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  abort?: () => void
}

export class HomeAssistantClient {
  constructor(private readonly config: ResolvedHomeAssistantConfig) {}

  async fetchStates(signal?: AbortSignal): Promise<unknown[]> {
    const value = await this.requestJson(this.config.restStatesUrl, { method: 'GET' }, signal, 'HOME_ASSISTANT_REST_FAILED')
    if (!Array.isArray(value)) throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_INVALID')
    return value
  }

  async fetchState(entityId: string, signal?: AbortSignal): Promise<unknown> {
    if (!/^[a-z0-9_]{1,64}\.[a-z0-9_]{1,190}$/.test(entityId)) {
      throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_INVALID')
    }
    return this.requestJson(`${this.config.baseUrl}/api/states/${encodeURIComponent(entityId)}`, { method: 'GET' }, signal,
      'HOME_ASSISTANT_REST_FAILED', 'HOME_ASSISTANT_STATE_NOT_FOUND')
  }

  async callService(
    domain: string,
    service: string,
    data: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const allowed: Record<string, readonly string[]> = {
      climate: ['set_temperature'], fan: ['set_percentage', 'turn_off', 'turn_on'],
      humidifier: ['set_humidity', 'turn_off', 'turn_on'], light: ['turn_off', 'turn_on'],
      scene: ['turn_on'], switch: ['turn_off', 'turn_on'],
    }
    if (!allowed[domain]?.includes(service) || !plain(data)) {
      throw new HomeAssistantClientError('HOME_ASSISTANT_SERVICE_DENIED')
    }
    validateJsonValue(data, 6, 64)
    const body = JSON.stringify(data)
    if (Buffer.byteLength(body, 'utf8') > 16_384) throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_TOO_LARGE')
    const value = await this.requestJson(`${this.config.baseUrl}/api/services/${domain}/${service}`, {
      method: 'POST', body,
    }, signal, 'HOME_ASSISTANT_SERVICE_FAILED')
    if (!Array.isArray(value)) throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_INVALID')
    return value
  }

  private async requestJson(
    url: string,
    init: { method: 'GET' | 'POST'; body?: string },
    signal: AbortSignal | undefined,
    failureCode: 'HOME_ASSISTANT_REST_FAILED' | 'HOME_ASSISTANT_SERVICE_FAILED',
    notFoundCode?: 'HOME_ASSISTANT_STATE_NOT_FOUND',
  ): Promise<unknown> {
    const operation = operationSignal(signal, this.config.requestTimeoutMs)
    try {
      let response: Response
      try {
        response = await fetch(url, {
          method: init.method,
          headers: {
            authorization: `Bearer ${this.config.token}`, accept: 'application/json',
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(init.body === undefined ? {} : { body: init.body }),
          signal: operation.signal,
        })
      } catch {
        throw operation.error() ?? new HomeAssistantClientError(failureCode)
      }
      if (response.status === 401 || response.status === 403) {
        throw new HomeAssistantClientError('HOME_ASSISTANT_REST_AUTH_FAILED')
      }
      if (response.status === 404 && notFoundCode) throw new HomeAssistantClientError(notFoundCode)
      if (!response.ok) throw new HomeAssistantClientError(failureCode)
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!contentType.includes('application/json')) {
        throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_INVALID')
      }
      let body: string
      try { body = await boundedResponseText(response, this.config.maxRestResponseBytes) } catch (error) {
        if (error instanceof HomeAssistantClientError) throw error
        throw operation.error() ?? new HomeAssistantClientError(failureCode)
      }
      let value: unknown
      try { value = JSON.parse(body) } catch { throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_INVALID') }
      validateJsonValue(value, 16, 16_384)
      return value
    } finally {
      operation.dispose()
    }
  }

  async subscribeStateChanged(
    onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<HomeAssistantStateSubscription> {
    if (typeof onEvent !== 'function') throw new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID')
    const channel = await ProtocolChannel.connect(this.config, signal)
    try {
      const authRequired = await channel.next(
        message => message.type === 'auth_required' || message.type === 'auth_invalid',
        this.config.requestTimeoutMs,
        signal,
      )
      if (authRequired.type !== 'auth_required') throw new HomeAssistantClientError('HOME_ASSISTANT_WS_AUTH_FAILED')
      channel.send({ type: 'auth', access_token: this.config.token })
      const authResult = await channel.next(
        message => message.type === 'auth_ok' || message.type === 'auth_invalid',
        this.config.requestTimeoutMs,
        signal,
      )
      if (authResult.type !== 'auth_ok') throw new HomeAssistantClientError('HOME_ASSISTANT_WS_AUTH_FAILED')
      const haVersion = boundedString(authResult.ha_version, 1, 80)
      if (!haVersion) throw new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID')

      let nextCommandId = 1
      const subscriptionId = nextCommandId
      nextCommandId += 1
      channel.send({ id: subscriptionId, type: 'subscribe_events', event_type: 'state_changed' })
      const subscribed = await channel.next(
        message => message.type === 'result' && message.id === subscriptionId,
        this.config.requestTimeoutMs,
        signal,
      )
      if (subscribed.success !== true) throw new HomeAssistantClientError('HOME_ASSISTANT_WS_SUBSCRIBE_FAILED')

      const removeObserver = channel.observe(message => {
        if (message.type !== 'event') return false
        if (message.id !== subscriptionId || !plain(message.event)) {
          channel.fail(new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID'))
          return true
        }
        try { onEvent(message.event) } catch {
          channel.fail(new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID'))
        }
        return true
      })
      const abortSubscription = () => channel.fail(new HomeAssistantClientError('HOME_ASSISTANT_ABORTED'))
      if (signal) signal.addEventListener('abort', abortSubscription, { once: true })
      if (signal?.aborted) abortSubscription()
      void channel.closed.then(() => signal?.removeEventListener('abort', abortSubscription))
      let closed = false
      return {
        haVersion,
        closed: channel.closed,
        ping: async (pingSignal?: AbortSignal) => {
          if (closed) throw new HomeAssistantClientError('HOME_ASSISTANT_WS_CLOSED')
          const id = nextCommandId
          nextCommandId += 1
          channel.send({ id, type: 'ping' })
          await channel.next(
            message => message.type === 'pong' && message.id === id,
            this.config.requestTimeoutMs,
            pingSignal,
          )
        },
        close: async () => {
          if (closed) return
          closed = true
          if (signal) signal.removeEventListener('abort', abortSubscription)
          removeObserver()
          await channel.close()
        },
      }
    } catch (error) {
      const safe = error instanceof HomeAssistantClientError
        ? error
        : new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID')
      channel.fail(safe)
      throw safe
    }
  }
}

class ProtocolChannel {
  readonly closed: Promise<HomeAssistantSubscriptionClose>
  private resolveClosed!: (value: HomeAssistantSubscriptionClose) => void
  private readonly queue: ProtocolMessage[] = []
  private readonly waiters: MessageWaiter[] = []
  private readonly observers = new Set<MessageObserver>()
  private terminalError: HomeAssistantClientError | null = null
  private settled = false

  private constructor(
    private readonly socket: WebSocket,
    private readonly maxMessageBytes: number,
  ) {
    this.closed = new Promise(resolve => { this.resolveClosed = resolve })
    socket.on('message', (data, isBinary) => this.receive(data, isBinary))
    socket.on('error', () => this.fail(new HomeAssistantClientError('HOME_ASSISTANT_WS_CLOSED')))
    socket.on('close', code => this.settleClose(code === 1000 && !this.terminalError))
  }

  static async connect(config: ResolvedHomeAssistantConfig, signal?: AbortSignal): Promise<ProtocolChannel> {
    if (signal?.aborted) throw new HomeAssistantClientError('HOME_ASSISTANT_ABORTED')
    let socket: WebSocket
    try {
      socket = new WebSocket(config.websocketUrl, {
        handshakeTimeout: config.connectTimeoutMs,
        maxPayload: config.maxWebSocketMessageBytes,
        perMessageDeflate: false,
        rejectUnauthorized: true,
      })
    } catch {
      throw new HomeAssistantClientError('HOME_ASSISTANT_WS_CONNECT_FAILED')
    }
    const channel = new ProtocolChannel(socket, config.maxWebSocketMessageBytes)
    try {
      await waitForOpen(socket, config.connectTimeoutMs, signal)
      return channel
    } catch (error) {
      const safe = error instanceof HomeAssistantClientError
        ? error
        : new HomeAssistantClientError('HOME_ASSISTANT_WS_CONNECT_FAILED')
      channel.fail(safe)
      throw safe
    }
  }

  send(message: Record<string, unknown>): void {
    if (this.terminalError || this.socket.readyState !== WebSocket.OPEN) {
      throw this.terminalError ?? new HomeAssistantClientError('HOME_ASSISTANT_WS_CLOSED')
    }
    let encoded: string
    try { encoded = JSON.stringify(message) } catch { throw new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID') }
    if (Buffer.byteLength(encoded, 'utf8') > this.maxMessageBytes) {
      throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_TOO_LARGE')
    }
    this.socket.send(encoded)
  }

  next(
    predicate: (message: ProtocolMessage) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProtocolMessage> {
    if (signal?.aborted) return Promise.reject(new HomeAssistantClientError('HOME_ASSISTANT_ABORTED'))
    if (this.terminalError) return Promise.reject(this.terminalError)
    const queuedIndex = this.queue.findIndex(predicate)
    if (queuedIndex >= 0) return Promise.resolve(this.queue.splice(queuedIndex, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter: MessageWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter)
          reject(new HomeAssistantClientError('HOME_ASSISTANT_TIMEOUT'))
        }, timeoutMs),
        signal,
      }
      if (signal) {
        waiter.abort = () => {
          this.removeWaiter(waiter)
          reject(new HomeAssistantClientError('HOME_ASSISTANT_ABORTED'))
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  observe(observer: MessageObserver): () => void {
    this.observers.add(observer)
    return () => this.observers.delete(observer)
  }

  fail(error: HomeAssistantClientError): void {
    if (!this.terminalError) this.terminalError = error
    for (const waiter of this.waiters.splice(0)) {
      this.disposeWaiter(waiter)
      waiter.reject(this.terminalError)
    }
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate()
    }
    this.settleClose(false)
  }

  async close(): Promise<void> {
    if (this.settled || this.socket.readyState === WebSocket.CLOSED) {
      this.settleClose(!this.terminalError)
      return
    }
    if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate()
    else this.socket.close(1000)
    const timer = setTimeout(() => this.socket.terminate(), 1_000)
    try { await this.closed } finally { clearTimeout(timer) }
  }

  private receive(data: RawData, isBinary: boolean): void {
    if (this.terminalError) return
    if (isBinary) {
      this.fail(new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID'))
      return
    }
    let bytes: Buffer
    try { bytes = rawDataBuffer(data) } catch {
      this.fail(new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID'))
      return
    }
    if (bytes.byteLength > this.maxMessageBytes) {
      this.fail(new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_TOO_LARGE'))
      return
    }
    let decoded: string
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
      this.fail(new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID'))
      return
    }
    let value: unknown
    try { value = JSON.parse(decoded) } catch {
      this.fail(new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID'))
      return
    }
    try { validateJsonValue(value, 16, 4_096) } catch {
      this.fail(new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID'))
      return
    }
    if (!plain(value) || !boundedString(value.type, 1, 100)) {
      this.fail(new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID'))
      return
    }
    const message = value as ProtocolMessage
    const waiterIndex = this.waiters.findIndex(waiter => waiter.predicate(message))
    if (waiterIndex >= 0) {
      const waiter = this.waiters.splice(waiterIndex, 1)[0]
      this.disposeWaiter(waiter)
      waiter.resolve(message)
      return
    }
    for (const observer of this.observers) if (observer(message)) return
    if (this.queue.length >= 64) {
      this.fail(new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID'))
      return
    }
    this.queue.push(message)
  }

  private removeWaiter(waiter: MessageWaiter): void {
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) this.waiters.splice(index, 1)
    this.disposeWaiter(waiter)
  }

  private disposeWaiter(waiter: MessageWaiter): void {
    clearTimeout(waiter.timer)
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
  }

  private settleClose(clean: boolean): void {
    if (this.settled) return
    this.settled = true
    const error = this.terminalError ?? (clean ? null : new HomeAssistantClientError('HOME_ASSISTANT_WS_CLOSED'))
    if (error && !this.terminalError) this.terminalError = error
    for (const waiter of this.waiters.splice(0)) {
      this.disposeWaiter(waiter)
      waiter.reject(error ?? new HomeAssistantClientError('HOME_ASSISTANT_WS_CLOSED'))
    }
    this.resolveClosed({ clean: error === null, code: error?.code ?? null })
  }
}

async function boundedResponseText(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => undefined)
        throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size))
  } catch (error) {
    if (error instanceof HomeAssistantClientError) throw error
    throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_INVALID')
  }
}

function validateJsonValue(root: unknown, maximumDepth: number, maximumNodes: number): void {
  let nodes = 0
  const visit = (value: unknown, depth: number): void => {
    nodes += 1
    if (nodes > maximumNodes || depth > maximumDepth) {
      throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_INVALID')
    }
    if (Array.isArray(value)) {
      if (value.length > maximumNodes) throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_INVALID')
      for (const child of value) visit(child, depth + 1)
      return
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_INVALID')
      return
    }
    if (!plain(value)) throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_INVALID')
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor' || key.length > 160) {
        throw new HomeAssistantClientError('HOME_ASSISTANT_RESPONSE_INVALID')
      }
      visit(child, depth + 1)
    }
  }
  visit(root, 0)
}

function operationSignal(external: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  error(): HomeAssistantClientError | null
  dispose(): void
} {
  const controller = new AbortController()
  let reason: 'external' | 'timeout' | null = null
  const abort = () => { reason = 'external'; controller.abort() }
  if (external) external.addEventListener('abort', abort, { once: true })
  if (external?.aborted) abort()
  const timer = setTimeout(() => { reason = 'timeout'; controller.abort() }, timeoutMs)
  return {
    signal: controller.signal,
    error: () => reason === 'external'
      ? new HomeAssistantClientError('HOME_ASSISTANT_ABORTED')
      : reason === 'timeout' ? new HomeAssistantClientError('HOME_ASSISTANT_TIMEOUT') : null,
    dispose: () => {
      clearTimeout(timer)
      if (external) external.removeEventListener('abort', abort)
    },
  }
}

function waitForOpen(socket: WebSocket, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: HomeAssistantClientError) => {
      clearTimeout(timer)
      socket.off('open', opened)
      socket.off('error', failed)
      socket.off('close', failed)
      if (signal) signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve()
    }
    const opened = () => finish()
    const failed = () => finish(new HomeAssistantClientError('HOME_ASSISTANT_WS_CONNECT_FAILED'))
    const aborted = () => finish(new HomeAssistantClientError('HOME_ASSISTANT_ABORTED'))
    const timer = setTimeout(() => finish(new HomeAssistantClientError('HOME_ASSISTANT_TIMEOUT')), timeoutMs)
    socket.once('open', opened)
    socket.once('error', failed)
    socket.once('close', failed)
    if (signal) signal.addEventListener('abort', aborted, { once: true })
  })
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  throw new HomeAssistantClientError('HOME_ASSISTANT_WS_PROTOCOL_INVALID')
}

function boundedString(value: unknown, minimum: number, maximum: number): string | null {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum ? value : null
}

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

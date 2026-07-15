import type { IncomingMessage, Server as HttpServer } from 'http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { config } from '../../../config'
import { shouldRejectUpgradeOrigin, writeForbiddenOrigin } from '../../../security'
import { logger } from '../../logger'
import { getDeviceIdentity, type DeviceIdentity } from '../../system-info'
import { openAndroidCompanionDatabase } from './database'
import {
  acceptAndroidCompanionSession,
  type AndroidCompanionPrivateIdentity,
  type AndroidCompanionPublicIdentity,
  type AndroidCompanionSecureSession,
  type AndroidEncryptedEnvelope,
  type AndroidSessionHello,
} from './crypto'
import { AndroidCompanionStore } from './store'
import { AndroidCompanionPairingService } from './pairing-service'
import {
  AndroidCompanionCapabilityService,
  type AndroidCapabilityReportPayload,
} from './capability-service'
import { AndroidCompanionCommandBridge } from './command-bridge'
import { createAndroidCompanionExecutorAdapter } from './executor'
import { isAndroidFabricCapability } from './fabric-contracts'
import {
  registerFabricExecutorAdapter,
  unregisterFabricExecutorAdapter,
} from '../action-fabric/executors'
import {
  AndroidCompanionAuthenticationError,
  AndroidCompanionValidationError,
  type AndroidCompanionMessageType,
} from './types'

export const ANDROID_COMPANION_SOCKET_PATH = '/api/hermes/android-companion/session'
const MAX_SOCKET_PAYLOAD_BYTES = 128 * 1024
const HANDSHAKE_TIMEOUT_MS = 5_000
const DEFAULT_HEARTBEAT_MS = 20_000
const REPLY_TTL_MS = 60_000

export interface AndroidCompanionGatewayMessage {
  deviceId: string
  sessionId: string
  messageType: AndroidCompanionMessageType
  bindingId: string
  sequence: number
  payload: unknown
  receivedAt: string
}

export interface AndroidCompanionGatewayReply {
  messageType: AndroidCompanionMessageType
  bindingId: string
  payload: unknown
  expiresAt?: string
}

export interface AndroidCompanionGatewayConnection {
  deviceId: string
  sessionId: string
  connectedAt: string
  lastSeenAt: string
  receivedSequence: number
  sentSequence: number
}

export interface AndroidCompanionGatewayDependencies {
  store: AndroidCompanionStore
  studioIdentity: () => Promise<AndroidCompanionPrivateIdentity>
  onMessage?: (
    message: AndroidCompanionGatewayMessage,
  ) => void | AndroidCompanionGatewayReply | Promise<void | AndroidCompanionGatewayReply>
  now?: () => Date
  corsOrigins?: string
  handshakeTimeoutMs?: number
  heartbeatMs?: number
}

type LiveConnection = {
  ws: WebSocket
  deviceId: string
  secureSession: AndroidCompanionSecureSession
  connectedAt: string
  lastSeenAt: string
  heartbeat: ReturnType<typeof setInterval> | null
  tail: Promise<void>
}

export class AndroidCompanionGateway {
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SOCKET_PAYLOAD_BYTES })
  readonly #dependencies: AndroidCompanionGatewayDependencies
  readonly #connections = new Map<string, LiveConnection>()
  readonly #sockets = new Set<WebSocket>()
  #setup = false
  #closed = false

  constructor(dependencies: AndroidCompanionGatewayDependencies) {
    this.#dependencies = dependencies
  }

  setupServer(httpServers: HttpServer | HttpServer[]): void {
    if (this.#setup) return
    if (this.#closed) throw new Error('Android companion gateway is closed')
    this.#setup = true
    for (const httpServer of Array.isArray(httpServers) ? httpServers : [httpServers]) {
      httpServer.on('upgrade', (request, socket, head) => {
        let url: URL
        try {
          url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`)
        } catch {
          return
        }
        if (url.pathname !== ANDROID_COMPANION_SOCKET_PATH) return
        if (shouldRejectUpgradeOrigin(request, this.#dependencies.corsOrigins ?? config.corsOrigins)) {
          writeForbiddenOrigin(socket)
          return
        }
        if (request.method !== 'GET' || url.search.length > 0) {
          rejectUpgrade(socket, 400, 'Bad Request')
          return
        }
        this.#wss.handleUpgrade(request, socket, head, ws => this.acceptSocket(ws, request))
      })
    }
  }

  listConnections(): AndroidCompanionGatewayConnection[] {
    return [...this.#connections.values()].map(connection => connectionInfo(connection))
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
  }

  isConnected(deviceId: string): boolean {
    return this.#connections.get(deviceId)?.ws.readyState === WebSocket.OPEN
  }

  async send(deviceId: string, reply: AndroidCompanionGatewayReply): Promise<AndroidEncryptedEnvelope> {
    const connection = this.#connections.get(deviceId)
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      throw new AndroidCompanionAuthenticationError('Android companion is offline')
    }
    return this.sendOnConnection(connection, reply)
  }

  disconnectDevice(deviceId: string, reason = 'DEVICE_REVOKED'): boolean {
    const connection = this.#connections.get(deviceId)
    if (!connection) return false
    closeSocket(connection.ws, 4003, reason)
    return true
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const socket of this.#sockets) closeSocket(socket, 1001, 'SERVER_SHUTDOWN')
    this.#connections.clear()
    await new Promise<void>(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(force)
        resolve()
      }
      const force = setTimeout(() => {
        for (const socket of this.#sockets) socket.terminate()
        finish()
      }, 500)
      force.unref?.()
      this.#wss.close(finish)
    })
  }

  private acceptSocket(ws: WebSocket, _request: IncomingMessage): void {
    if (this.#closed) {
      closeSocket(ws, 1012, 'GATEWAY_CLOSED')
      return
    }
    this.#sockets.add(ws)
    let live: LiveConnection | null = null
    let handshakeComplete = false
    let tail = Promise.resolve()
    const timeout = setTimeout(() => closeSocket(ws, 4008, 'HANDSHAKE_TIMEOUT'),
      this.#dependencies.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)
    timeout.unref?.()

    ws.on('message', (data, isBinary) => {
      tail = tail.then(async () => {
        if (isBinary) throw new AndroidCompanionValidationError('binary companion messages are forbidden')
        if (!handshakeComplete) {
          live = await this.completeHandshake(ws, data)
          handshakeComplete = true
          clearTimeout(timeout)
          return
        }
        if (!live) throw new AndroidCompanionAuthenticationError('secure companion session is unavailable')
        await this.receiveEncrypted(live, data)
      }).catch(error => {
        logger.warn({ err: stableGatewayError(error) }, '[android-companion] closing invalid session')
        closeSocket(ws, gatewayCloseCode(error), stableGatewayError(error))
      })
    })
    ws.on('close', () => {
      clearTimeout(timeout)
      this.#sockets.delete(ws)
      if (live) this.removeConnection(live)
    })
    ws.on('error', () => undefined)
  }

  private async completeHandshake(ws: WebSocket, raw: RawData): Promise<LiveConnection> {
    const hello = parseSocketJson(raw) as AndroidSessionHello
    if (!hello || hello.type !== 'session.hello') {
      throw new AndroidCompanionAuthenticationError('signed session hello is required')
    }
    const device = this.#dependencies.store.getDevice(String(hello.companionDeviceId || ''))
    if (!device || device.state !== 'paired') {
      throw new AndroidCompanionAuthenticationError('Android companion is not paired')
    }
    const studio = await this.#dependencies.studioIdentity()
    const { response, session } = acceptAndroidCompanionSession({
      hello,
      companion: {
        deviceId: device.id,
        signingPublicKey: device.signingPublicKey,
        exchangePublicKey: device.exchangePublicKey,
      },
      studio,
      now: this.now(),
    })
    const existing = this.#connections.get(device.id)
    if (existing) closeSocket(existing.ws, 4000, 'SESSION_REPLACED')
    const timestamp = this.now().toISOString()
    const connection: LiveConnection = {
      ws,
      deviceId: device.id,
      secureSession: session,
      connectedAt: timestamp,
      lastSeenAt: timestamp,
      heartbeat: null,
      tail: Promise.resolve(),
    }
    this.#connections.set(device.id, connection)
    ws.send(JSON.stringify(response))
    this.startHeartbeat(connection)
    return connection
  }

  private async receiveEncrypted(connection: LiveConnection, raw: RawData): Promise<void> {
    const envelope = parseSocketJson(raw) as AndroidEncryptedEnvelope
    const payload = connection.secureSession.decrypt(envelope, this.now())
    connection.lastSeenAt = this.now().toISOString()
    const message: AndroidCompanionGatewayMessage = {
      deviceId: connection.deviceId,
      sessionId: connection.secureSession.sessionId,
      messageType: envelope.messageType,
      bindingId: envelope.bindingId,
      sequence: envelope.sequence,
      payload,
      receivedAt: connection.lastSeenAt,
    }
    const reply = await this.#dependencies.onMessage?.(message)
    if (reply) await this.sendOnConnection(connection, reply)
  }

  private async sendOnConnection(
    connection: LiveConnection,
    reply: AndroidCompanionGatewayReply,
  ): Promise<AndroidEncryptedEnvelope> {
    const operation = connection.tail.then(() => {
      if (connection.ws.readyState !== WebSocket.OPEN) {
        throw new AndroidCompanionAuthenticationError('Android companion is offline')
      }
      const now = this.now()
      const defaultExpiry = Math.min(
        now.getTime() + REPLY_TTL_MS,
        Date.parse(connection.secureSession.expiresAt) - 1,
      )
      const envelope = connection.secureSession.encrypt({
        messageType: reply.messageType,
        bindingId: reply.bindingId,
        payload: reply.payload,
        expiresAt: reply.expiresAt ?? new Date(defaultExpiry).toISOString(),
        now,
      })
      connection.ws.send(JSON.stringify(envelope))
      return envelope
    })
    connection.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private startHeartbeat(connection: LiveConnection): void {
    const heartbeatMs = this.#dependencies.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    if (heartbeatMs <= 0) return
    connection.heartbeat = setInterval(() => {
      void this.sendOnConnection(connection, {
        messageType: 'heartbeat',
        bindingId: connection.secureSession.sessionId,
        payload: { sentAt: this.now().toISOString() },
      }).catch(() => closeSocket(connection.ws, 4008, 'HEARTBEAT_FAILED'))
    }, heartbeatMs)
    connection.heartbeat.unref?.()
  }

  private removeConnection(connection: LiveConnection): void {
    if (connection.heartbeat) clearInterval(connection.heartbeat)
    connection.secureSession.close()
    if (this.#connections.get(connection.deviceId) === connection) {
      this.#connections.delete(connection.deviceId)
    }
  }

  private now(): Date { return this.#dependencies.now?.() ?? new Date() }
}

type RuntimeSingleton = {
  database: ReturnType<typeof openAndroidCompanionDatabase>
  store: AndroidCompanionStore
  gateway: AndroidCompanionGateway
  pairing: AndroidCompanionPairingService
  capabilities: AndroidCompanionCapabilityService
  commands: AndroidCompanionCommandBridge
  adapterIds: Set<string>
}

let singleton: RuntimeSingleton | null = null

export function getAndroidCompanionRuntime(): RuntimeSingleton {
  if (singleton) return singleton
  const database = openAndroidCompanionDatabase()
  const store = new AndroidCompanionStore(database.database)
  const studioIdentity = async () => normalizeStudioIdentity(await getDeviceIdentity())
  const capabilities = new AndroidCompanionCapabilityService({ store })
  const adapterIds = new Set<string>()
  let gateway!: AndroidCompanionGateway
  const commands = new AndroidCompanionCommandBridge({
    store,
    transport: {
      send: (deviceId, reply) => gateway.send(deviceId, reply),
      isConnected: deviceId => gateway.isConnected(deviceId),
    },
  })
  gateway = new AndroidCompanionGateway({
    store,
    studioIdentity,
    onMessage(message) {
      if (message.messageType === 'capabilities.report' || message.messageType === 'permissions.report') {
        const result = capabilities.applyReport(
          message.deviceId, message.messageType, message.payload as AndroidCapabilityReportPayload,
        )
        for (const executor of result.executors) {
          if (!isAndroidFabricCapability(executor.capabilityId)) {
            throw new AndroidCompanionValidationError('Android executor capability is invalid')
          }
          if (adapterIds.has(executor.executorId)) continue
          try {
            registerFabricExecutorAdapter(createAndroidCompanionExecutorAdapter({
              id: executor.executorId,
              deviceId: message.deviceId,
              capabilityId: executor.capabilityId,
              store,
              bridge: commands,
            }))
            adapterIds.add(executor.executorId)
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'FABRIC_EXECUTOR_ADAPTER_EXISTS') throw error
          }
        }
        return {
          messageType: 'ack',
          bindingId: message.bindingId,
          payload: {
            acknowledgedSequence: message.sequence,
            capabilitiesRevision: result.device.capabilitiesRevision,
            capabilitiesDigest: result.device.capabilitiesDigest,
          },
        }
      }
      if (message.messageType === 'heartbeat') {
        return {
          messageType: 'ack', bindingId: message.bindingId,
          payload: { acknowledgedSequence: message.sequence },
        }
      }
      return commands.handleMessage(message)
    },
  })
  singleton = {
    database,
    store,
    gateway,
    pairing: new AndroidCompanionPairingService({ store, studioIdentity }),
    capabilities,
    commands,
    adapterIds,
  }
  return singleton
}

export async function shutdownAndroidCompanionRuntime(): Promise<void> {
  const active = singleton
  singleton = null
  if (!active) return
  for (const id of active.adapterIds) unregisterFabricExecutorAdapter(id)
  active.adapterIds.clear()
  active.commands.shutdown()
  await active.gateway.shutdown()
  active.database.close()
}

function normalizeStudioIdentity(identity: DeviceIdentity): AndroidCompanionPrivateIdentity {
  return {
    deviceId: identity.device_id,
    signingPublicKey: identity.device_public_key,
    signingPrivateKey: identity.device_private_key,
    exchangePublicKey: identity.device_exchange_public_key,
    exchangePrivateKey: identity.device_exchange_private_key,
  }
}

function parseSocketJson(raw: RawData): unknown {
  const buffer = rawDataBuffer(raw)
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_SOCKET_PAYLOAD_BYTES) {
    throw new AndroidCompanionValidationError('Android companion socket message size is invalid')
  }
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new AndroidCompanionValidationError('Android companion socket message must be JSON')
  }
}

function rawDataBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  if (Array.isArray(raw)) return Buffer.concat(raw)
  throw new AndroidCompanionValidationError('unsupported Android companion socket frame')
}

function connectionInfo(connection: LiveConnection): AndroidCompanionGatewayConnection {
  return {
    deviceId: connection.deviceId,
    sessionId: connection.secureSession.sessionId,
    connectedAt: connection.connectedAt,
    lastSeenAt: connection.lastSeenAt,
    receivedSequence: connection.secureSession.receivedSequence,
    sentSequence: connection.secureSession.sentSequence,
  }
}

function stableGatewayError(error: unknown): string {
  if (error instanceof AndroidCompanionValidationError) return 'PROTOCOL_INVALID'
  if (error instanceof AndroidCompanionAuthenticationError) return 'AUTHENTICATION_FAILED'
  return 'SESSION_FAILED'
}

function gatewayCloseCode(error: unknown): number {
  return error instanceof AndroidCompanionValidationError ? 4002 : 4003
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN) socket.close(code, reason.slice(0, 120))
  else if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
}

function rejectUpgrade(
  socket: { write(chunk: string): void; destroy(): void },
  status: number,
  message: string,
): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

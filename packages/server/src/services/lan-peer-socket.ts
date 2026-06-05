import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'http'
import { randomUUID } from 'crypto'
import { createReadStream, createWriteStream, type WriteStream } from 'fs'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, resolve as resolvePath } from 'path'
import { getDeviceRelation } from '../db/hermes/devices-store'
import type { LanDeviceInfo } from './lan-discovery'
import { createDeviceSignature, getPublicSystemInfo, verifyDeviceSignature } from './system-info'
import { getTerminalConfig, validatePath } from './hermes/file-provider'
import { getActiveProfileDir } from './hermes/hermes-profile'
import { logger } from './logger'
import { config } from '../config'
import { shouldRejectUpgradeOrigin, writeForbiddenOrigin } from '../security'

const PEER_SOCKET_PATH = '/api/devices/peer-socket'
const REQUEST_TTL_MS = 5 * 60 * 1000
const FILE_CHUNK_SIZE = 64 * 1024

let pty: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty')
} catch (err) {
  logger.warn(err, '[lan-peer] node-pty failed to load; peer terminal disabled')
}

type PeerRole = 'server' | 'client'

type PeerJsonMessage = {
  type?: string
  request_id?: string
  terminal_id?: string
  transfer_id?: string
  path?: string
  data?: string
  cols?: number
  rows?: number
  shell?: string
  size?: number
}

type TerminalSession = {
  id: string
  pty: {
    pid: number
    onData: (cb: (data: string) => void) => void
    onExit: (cb: (e: { exitCode: number }) => void) => void
    write: (data: string) => void
    kill: (signal?: string) => void
    resize: (cols: number, rows: number) => void
  }
  shell: string
  pid: number
}

type UploadTransfer = {
  id: string
  path: string
  stream: WriteStream
}

export type LanPeerConnectionInfo = {
  id: string
  role: PeerRole
  device_id: string
  computer_name: string
  url: string
  connected_at: number
}

function now() {
  return Date.now()
}

function rememberNonce(seenNonces: Map<string, number>, deviceId: string, nonce: string, timestamp: number): boolean {
  const current = now()
  for (const [key, expiresAt] of seenNonces) {
    if (expiresAt <= current) seenNonces.delete(key)
  }

  const key = `${deviceId}:${nonce}`
  if (seenNonces.has(key)) return false
  seenNonces.set(key, timestamp + REQUEST_TTL_MS)
  return true
}

function shellName(shell: string): string {
  return shell.split('/').pop() || shell
}

function findShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash'].filter(Boolean) as string[]
  return candidates.find(shell => existsSync(shell)) || '/bin/bash'
}

function resolveTerminalCwd(): string {
  const fallback = existsSync(getActiveProfileDir()) ? getActiveProfileDir() : homedir()
  const configured = getTerminalConfig().cwd?.trim()
  if (!configured) return fallback
  const cwd = isAbsolute(configured) ? configured : resolvePath(fallback, configured)
  return existsSync(cwd) ? cwd : fallback
}

function targetWsUrl(device: LanDeviceInfo): string {
  const base = device.url.replace(/\/$/, '')
  const url = new URL(base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = PEER_SOCKET_PATH
  url.search = ''
  return url.toString()
}

function parseJsonMessage(raw: RawData): PeerJsonMessage | null {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
  if (!text || text.charCodeAt(0) !== 0x7B) return null
  try {
    return JSON.parse(text) as PeerJsonMessage
  } catch {
    return null
  }
}

class LanPeerConnection {
  readonly id = randomUUID()
  readonly connectedAt = now()
  private terminalSessions = new Map<string, TerminalSession>()
  private uploads = new Map<string, UploadTransfer>()

  constructor(
    private readonly manager: LanPeerSocketManager,
    private readonly ws: WebSocket,
    readonly role: PeerRole,
    readonly deviceId: string,
    private readonly computerName: string,
    private readonly url: string,
  ) {
    this.ws.on('message', raw => this.handleMessage(raw))
    this.ws.on('close', () => this.close())
    this.ws.on('error', err => {
      logger.warn(err, '[lan-peer] websocket error')
      this.close()
    })
    this.sendJson({
      type: 'peer.ready',
      connection_id: this.id,
      device_id: this.deviceId,
      role: this.role,
    })
  }

  info(): LanPeerConnectionInfo {
    return {
      id: this.id,
      role: this.role,
      device_id: this.deviceId,
      computer_name: this.computerName,
      url: this.url,
      connected_at: this.connectedAt,
    }
  }

  close() {
    for (const session of this.terminalSessions.values()) {
      try { session.pty.kill() } catch { }
    }
    this.terminalSessions.clear()

    for (const upload of this.uploads.values()) {
      try { upload.stream.destroy() } catch { }
    }
    this.uploads.clear()

    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try { this.ws.close() } catch { }
    }
    this.manager.removeConnection(this.id)
  }

  private sendJson(payload: Record<string, unknown>) {
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(payload))
  }

  private handleMessage(raw: RawData) {
    const msg = parseJsonMessage(raw)
    if (!msg?.type) {
      this.sendJson({ type: 'error', message: 'Invalid peer message' })
      return
    }

    switch (msg.type) {
      case 'terminal.create':
        this.createTerminal(msg)
        break
      case 'terminal.input':
        this.writeTerminal(msg)
        break
      case 'terminal.resize':
        this.resizeTerminal(msg)
        break
      case 'terminal.close':
        this.closeTerminal(msg)
        break
      case 'file.download':
        this.downloadFile(msg)
        break
      case 'file.upload.start':
        this.startUpload(msg)
        break
      case 'file.upload.chunk':
        this.writeUploadChunk(msg)
        break
      case 'file.upload.complete':
        this.completeUpload(msg)
        break
      default:
        this.sendJson({ type: 'error', request_id: msg.request_id, message: `Unsupported peer message: ${msg.type}` })
    }
  }

  private createTerminal(msg: PeerJsonMessage) {
    if (!pty) {
      this.sendJson({ type: 'terminal.error', request_id: msg.request_id, message: 'Terminal is not available' })
      return
    }

    const shell = msg.shell || findShell()
    let ptyProcess: TerminalSession['pty']
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: Math.max(1, msg.cols || 80),
        rows: Math.max(1, msg.rows || 24),
        cwd: resolveTerminalCwd(),
      })
    } catch (err: any) {
      this.sendJson({ type: 'terminal.error', request_id: msg.request_id, message: err?.message || 'Failed to create terminal' })
      return
    }

    const id = randomUUID()
    const session: TerminalSession = { id, pty: ptyProcess, shell, pid: ptyProcess.pid }
    this.terminalSessions.set(id, session)

    session.pty.onData((data: string) => {
      this.sendJson({ type: 'terminal.data', terminal_id: id, data })
    })
    session.pty.onExit(({ exitCode }) => {
      this.terminalSessions.delete(id)
      this.sendJson({ type: 'terminal.exit', terminal_id: id, exit_code: exitCode })
    })

    this.sendJson({
      type: 'terminal.created',
      request_id: msg.request_id,
      terminal_id: id,
      pid: session.pid,
      shell: shellName(shell),
    })
  }

  private writeTerminal(msg: PeerJsonMessage) {
    const session = msg.terminal_id ? this.terminalSessions.get(msg.terminal_id) : null
    if (!session || typeof msg.data !== 'string') return
    session.pty.write(msg.data)
  }

  private resizeTerminal(msg: PeerJsonMessage) {
    const session = msg.terminal_id ? this.terminalSessions.get(msg.terminal_id) : null
    if (!session) return
    try {
      session.pty.resize(Math.max(1, msg.cols || 80), Math.max(1, msg.rows || 24))
    } catch { }
  }

  private closeTerminal(msg: PeerJsonMessage) {
    const session = msg.terminal_id ? this.terminalSessions.get(msg.terminal_id) : null
    if (!session) return
    try { session.pty.kill() } catch { }
    this.terminalSessions.delete(session.id)
  }

  private downloadFile(msg: PeerJsonMessage) {
    if (!msg.transfer_id || !msg.path) {
      this.sendJson({ type: 'file.error', request_id: msg.request_id, transfer_id: msg.transfer_id, message: 'Missing file path' })
      return
    }

    let filePath: string
    try {
      filePath = validatePath(msg.path)
    } catch (err: any) {
      this.sendJson({ type: 'file.error', request_id: msg.request_id, transfer_id: msg.transfer_id, message: err?.message || 'Invalid file path' })
      return
    }

    const stream = createReadStream(filePath, { highWaterMark: FILE_CHUNK_SIZE })
    this.sendJson({ type: 'file.download.started', request_id: msg.request_id, transfer_id: msg.transfer_id })
    stream.on('data', chunk => {
      this.sendJson({
        type: 'file.download.chunk',
        transfer_id: msg.transfer_id,
        data: Buffer.from(chunk).toString('base64'),
      })
    })
    stream.on('error', err => {
      this.sendJson({ type: 'file.error', transfer_id: msg.transfer_id, message: err.message })
    })
    stream.on('end', () => {
      this.sendJson({ type: 'file.download.complete', transfer_id: msg.transfer_id })
    })
  }

  private startUpload(msg: PeerJsonMessage) {
    if (!msg.transfer_id || !msg.path) {
      this.sendJson({ type: 'file.error', request_id: msg.request_id, transfer_id: msg.transfer_id, message: 'Missing upload path' })
      return
    }

    let filePath: string
    try {
      filePath = validatePath(msg.path)
    } catch (err: any) {
      this.sendJson({ type: 'file.error', request_id: msg.request_id, transfer_id: msg.transfer_id, message: err?.message || 'Invalid upload path' })
      return
    }

    const stream = createWriteStream(filePath)
    stream.on('error', err => {
      this.uploads.delete(msg.transfer_id!)
      this.sendJson({ type: 'file.error', transfer_id: msg.transfer_id, message: err.message })
    })
    this.uploads.set(msg.transfer_id, { id: msg.transfer_id, path: filePath, stream })
    this.sendJson({ type: 'file.upload.ready', request_id: msg.request_id, transfer_id: msg.transfer_id })
  }

  private writeUploadChunk(msg: PeerJsonMessage) {
    const upload = msg.transfer_id ? this.uploads.get(msg.transfer_id) : null
    if (!upload || typeof msg.data !== 'string') return
    upload.stream.write(Buffer.from(msg.data, 'base64'))
  }

  private completeUpload(msg: PeerJsonMessage) {
    const upload = msg.transfer_id ? this.uploads.get(msg.transfer_id) : null
    if (!upload) return
    upload.stream.end(() => {
      this.uploads.delete(upload.id)
      this.sendJson({ type: 'file.upload.complete', transfer_id: upload.id, path: upload.path })
    })
  }
}

export class LanPeerSocketManager {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly connections = new Map<string, LanPeerConnection>()
  private readonly seenNonces = new Map<string, number>()
  private setupDone = false

  setupServer(httpServers: HttpServer | HttpServer[]) {
    if (this.setupDone) return
    this.setupDone = true
    const servers = Array.isArray(httpServers) ? httpServers : [httpServers]

    servers.forEach(httpServer => {
      httpServer.on('upgrade', async (req, socket, head) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`)
        if (url.pathname !== PEER_SOCKET_PATH) return

        if (shouldRejectUpgradeOrigin(req, config.corsOrigins)) {
          writeForbiddenOrigin(socket)
          return
        }

        const auth = await this.authenticateUpgrade(url, req)
        if (!auth.ok) {
          socket.write(`HTTP/1.1 ${auth.status} ${auth.message}\r\n\r\n`)
          socket.destroy()
          return
        }

        this.wss.handleUpgrade(req, socket, head, ws => {
          const connection = new LanPeerConnection(
            this,
            ws,
            'server',
            auth.device.id,
            auth.device.computerName,
            auth.device.url,
          )
          this.connections.set(connection.id, connection)
          this.wss.emit('connection', ws, req)
        })
      })
    })
  }

  async connectToDevice(device: LanDeviceInfo): Promise<LanPeerConnectionInfo> {
    const existing = this.findConnectionByDevice(device.id, 'client')
    if (existing) return existing.info()

    const localInfo = await getPublicSystemInfo()
    const timestamp = now()
    const nonce = randomUUID()
    const signature = await createDeviceSignature(nonce, timestamp)
    const url = new URL(targetWsUrl(device))
    url.searchParams.set('device_id', localInfo.device_id)
    url.searchParams.set('device_public_key', localInfo.device_public_key)
    url.searchParams.set('computer_name', localInfo.computer_name)
    url.searchParams.set('timestamp', String(timestamp))
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('signature', signature)

    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Peer socket connection timeout'))
      }, 5000)
      ws.once('open', () => {
        clearTimeout(timeout)
        resolve()
      })
      ws.once('error', err => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    const connection = new LanPeerConnection(this, ws, 'client', device.id, device.computer_name, device.url)
    this.connections.set(connection.id, connection)
    return connection.info()
  }

  listConnections(): LanPeerConnectionInfo[] {
    return [...this.connections.values()]
      .map(connection => connection.info())
      .sort((a, b) => b.connected_at - a.connected_at)
  }

  disconnect(connectionId: string): boolean {
    const connection = this.connections.get(connectionId)
    if (!connection) return false
    connection.close()
    return true
  }

  removeConnection(connectionId: string) {
    this.connections.delete(connectionId)
  }

  private findConnectionByDevice(deviceId: string, role?: PeerRole): LanPeerConnection | null {
    return [...this.connections.values()].find(connection => (
      connection.deviceId === deviceId && (!role || connection.role === role)
    )) || null
  }

  private async authenticateUpgrade(url: URL, req: IncomingMessage): Promise<
    | { ok: true; device: { id: string; computerName: string; url: string } }
    | { ok: false; status: number; message: string }
  > {
    const deviceId = url.searchParams.get('device_id')?.trim() || ''
    const publicKey = url.searchParams.get('device_public_key') || ''
    const timestamp = Number(url.searchParams.get('timestamp') || '')
    const nonce = url.searchParams.get('nonce') || ''
    const signature = url.searchParams.get('signature') || ''
    const computerName = url.searchParams.get('computer_name') || ''

    if (!deviceId || !publicKey || !Number.isFinite(timestamp) || !nonce || !signature) {
      return { ok: false, status: 400, message: 'Bad Request' }
    }
    if (Math.abs(now() - timestamp) > REQUEST_TTL_MS) {
      return { ok: false, status: 400, message: 'Expired Request' }
    }
    if (!verifyDeviceSignature({ device_id: deviceId, device_public_key: publicKey, nonce, timestamp, signature })) {
      return { ok: false, status: 401, message: 'Unauthorized' }
    }
    if (!rememberNonce(this.seenNonces, deviceId, nonce, timestamp)) {
      return { ok: false, status: 409, message: 'Replay Request' }
    }

    const relation = getDeviceRelation(deviceId)
    if (relation?.inbound_status !== 'approved') {
      return { ok: false, status: 403, message: 'Forbidden' }
    }

    const host = req.socket.remoteAddress?.startsWith('::ffff:')
      ? req.socket.remoteAddress.slice(7)
      : req.socket.remoteAddress || ''
    return {
      ok: true,
      device: {
        id: deviceId,
        computerName,
        url: host ? `ws://${host}` : '',
      },
    }
  }
}

let singleton: LanPeerSocketManager | null = null

export function getLanPeerSocketManager(): LanPeerSocketManager {
  if (!singleton) singleton = new LanPeerSocketManager()
  return singleton
}

export function getLanPeerSocketPath(): string {
  return PEER_SOCKET_PATH
}

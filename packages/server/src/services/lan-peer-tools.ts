import { getLanPeerSocketManager, type LanPeerExecResult, type LanPeerTerminalInfo, type LanPeerTerminalReadResult } from './lan-peer-socket'

export type PeerToolUploadInput = {
  connectionId: string
  path: string
  dataBase64: string
  timeoutMs?: number
}

export type PeerToolDownloadInput = {
  connectionId: string
  path: string
  timeoutMs?: number
}

export type PeerToolExecInput = {
  connectionId: string
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
}

export type PeerToolTerminalInput = {
  connectionId: string
  terminalId: string
}

export class LanPeerToolsService {
  listConnections() {
    return getLanPeerSocketManager().listConnections()
  }

  disconnect(connectionId: string): boolean {
    return getLanPeerSocketManager().disconnect(connectionId)
  }

  async createTerminal(connectionId: string, options: { shell?: string; cols?: number; rows?: number } = {}): Promise<LanPeerTerminalInfo> {
    return this.requireConnection(connectionId).createRemoteTerminal(options)
  }

  writeTerminal(input: PeerToolTerminalInput & { data: string }) {
    this.requireConnection(input.connectionId).writeRemoteTerminal(input.terminalId, input.data)
    return { ok: true }
  }

  resizeTerminal(input: PeerToolTerminalInput & { cols: number; rows: number }) {
    this.requireConnection(input.connectionId).resizeRemoteTerminal(input.terminalId, input.cols, input.rows)
    return { ok: true }
  }

  closeTerminal(input: PeerToolTerminalInput) {
    this.requireConnection(input.connectionId).closeRemoteTerminal(input.terminalId)
    return { ok: true }
  }

  readTerminal(input: PeerToolTerminalInput): LanPeerTerminalReadResult {
    return this.requireConnection(input.connectionId).readRemoteTerminal(input.terminalId)
  }

  exec(input: PeerToolExecInput): Promise<LanPeerExecResult> {
    return this.requireConnection(input.connectionId).execRemoteCommand({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    })
  }

  async downloadFile(input: PeerToolDownloadInput) {
    const data = await this.requireConnection(input.connectionId).downloadFileToBuffer(input.path, input.timeoutMs)
    return {
      path: input.path,
      size: data.length,
      data_base64: data.toString('base64'),
    }
  }

  async uploadFile(input: PeerToolUploadInput) {
    return this.requireConnection(input.connectionId).uploadFileFromBuffer(
      input.path,
      Buffer.from(input.dataBase64, 'base64'),
      input.timeoutMs,
    )
  }

  private requireConnection(connectionId: string) {
    const connection = getLanPeerSocketManager().getConnection(connectionId)
    if (!connection) throw Object.assign(new Error('Peer connection not found'), { status: 404 })
    return connection
  }
}

let singleton: LanPeerToolsService | null = null

export function getLanPeerToolsService(): LanPeerToolsService {
  if (!singleton) singleton = new LanPeerToolsService()
  return singleton
}

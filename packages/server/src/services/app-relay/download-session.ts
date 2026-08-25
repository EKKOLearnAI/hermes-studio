import { randomUUID } from 'crypto'

export const RELAY_DOWNLOAD_CHUNK_BYTES = 256 * 1024
const RELAY_DOWNLOAD_SESSION_TTL_MS = 2 * 60 * 1000

export interface RelayDownloadDescriptor {
  id: string
  totalBytes: number
}

export interface RelayDownloadChunk {
  id: string
  bodyBytes: Uint8Array
  receivedBytes: number
  totalBytes: number
  done: boolean
}

interface RelayDownloadSession {
  id: string
  ownerId: string
  reader: ReadableStreamDefaultReader<Uint8Array>
  buffered: Uint8Array | null
  bufferedOffset: number
  sourceDone: boolean
  sourceBytes: number
  receivedBytes: number
  totalBytes: number
  busy: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export class RelayDownloadSessionError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'RelayDownloadSessionError'
  }
}

export class RelayDownloadSessions {
  private readonly sessions = new Map<string, RelayDownloadSession>()

  create(ownerId: string, response: Response): RelayDownloadDescriptor {
    if (!response.body) throw new RelayDownloadSessionError('download_body_missing')
    const id = randomUUID()
    const session: RelayDownloadSession = {
      id,
      ownerId,
      reader: response.body.getReader(),
      buffered: null,
      bufferedOffset: 0,
      sourceDone: false,
      sourceBytes: 0,
      receivedBytes: 0,
      totalBytes: declaredResponseBodyBytes(response),
      busy: false,
      timer: null,
    }
    session.timer = this.expiryTimer(id)
    this.sessions.set(id, session)
    return { id, totalBytes: session.totalBytes }
  }

  async read(
    ownerId: string,
    id: string,
    maxChunkBytes = RELAY_DOWNLOAD_CHUNK_BYTES,
    maxTotalBytes = Number.MAX_SAFE_INTEGER,
  ): Promise<RelayDownloadChunk> {
    const session = this.sessions.get(id)
    if (!session || session.ownerId !== ownerId) throw new RelayDownloadSessionError('download_not_found')
    if (session.busy) throw new RelayDownloadSessionError('download_busy')
    if (session.totalBytes > maxTotalBytes || session.receivedBytes > maxTotalBytes) {
      this.cancel(ownerId, id)
      throw new RelayDownloadSessionError('download_too_large')
    }

    session.busy = true
    this.refreshExpiry(session)
    try {
      const chunkLimit = Math.max(1, Math.min(RELAY_DOWNLOAD_CHUNK_BYTES, Math.floor(maxChunkBytes)))
      const output: Buffer[] = []
      let outputBytes = 0
      while (outputBytes < chunkLimit) {
        if (session.buffered && session.bufferedOffset < session.buffered.byteLength) {
          const remaining = chunkLimit - outputBytes
          const take = Math.min(remaining, session.buffered.byteLength - session.bufferedOffset)
          output.push(Buffer.from(
            session.buffered.buffer,
            session.buffered.byteOffset + session.bufferedOffset,
            take,
          ))
          session.bufferedOffset += take
          outputBytes += take
          if (session.bufferedOffset >= session.buffered.byteLength) {
            session.buffered = null
            session.bufferedOffset = 0
          }
          continue
        }
        if (session.sourceDone) break
        const next = await session.reader.read()
        if (next.done) {
          session.sourceDone = true
          break
        }
        if (!next.value?.byteLength) continue
        session.sourceBytes += next.value.byteLength
        if (session.sourceBytes > maxTotalBytes) {
          this.cancel(ownerId, id)
          throw new RelayDownloadSessionError('download_too_large')
        }
        session.buffered = next.value
        session.bufferedOffset = 0
      }

      session.receivedBytes += outputBytes
      const declaredComplete = session.totalBytes > 0 && session.receivedBytes >= session.totalBytes
      if (session.totalBytes > 0 && session.receivedBytes > session.totalBytes) {
        this.cancel(ownerId, id)
        throw new RelayDownloadSessionError('download_size_mismatch')
      }
      const done = declaredComplete || (session.sourceDone && !session.buffered)
      const bodyBytes = Uint8Array.from(Buffer.concat(output, outputBytes))
      if (done) this.finish(session)
      return {
        id,
        bodyBytes,
        receivedBytes: session.receivedBytes,
        totalBytes: session.totalBytes,
        done,
      }
    } finally {
      const current = this.sessions.get(id)
      if (current) current.busy = false
    }
  }

  cancel(ownerId: string, id: string): boolean {
    const session = this.sessions.get(id)
    if (!session || session.ownerId !== ownerId) return false
    this.finish(session)
    return true
  }

  cancelOwner(ownerId: string): void {
    for (const session of Array.from(this.sessions.values())) {
      if (session.ownerId === ownerId) this.finish(session)
    }
  }

  cancelAll(): void {
    for (const session of Array.from(this.sessions.values())) this.finish(session)
  }

  private refreshExpiry(session: RelayDownloadSession): void {
    if (session.timer) clearTimeout(session.timer)
    session.timer = this.expiryTimer(session.id)
  }

  private expiryTimer(id: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const session = this.sessions.get(id)
      if (session) this.finish(session)
    }, RELAY_DOWNLOAD_SESSION_TTL_MS)
    timer.unref?.()
    return timer
  }

  private finish(session: RelayDownloadSession): void {
    if (session.timer) clearTimeout(session.timer)
    this.sessions.delete(session.id)
    void session.reader.cancel().catch(() => undefined)
  }
}

function declaredResponseBodyBytes(response: Response): number {
  const value = Number(response.headers.get('content-length'))
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

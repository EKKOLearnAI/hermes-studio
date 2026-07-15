import { createServer, type Server as HttpServer } from 'http'
import { DatabaseSync } from 'node:sqlite'
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client'
import { vi } from 'vitest'

const groupChatDbMock = vi.hoisted(() => ({ current: null as DatabaseSync | null }))

vi.mock('../../packages/server/src/db/index', () => ({ getDb: () => groupChatDbMock.current }))
vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  isAuthEnabled: vi.fn(async () => false),
  authenticateUserToken: vi.fn(),
}))

import { initAllHermesTables } from '../../packages/server/src/db/hermes/schemas'
import { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

export function once<T = any>(socket: ClientSocket, event: string, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs)
    socket.once(event, (payload: T) => { clearTimeout(timer); resolve(payload) })
  })
}

export function emitAck<T = any>(socket: ClientSocket, event: string, payload: unknown, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event} ack`)), timeoutMs)
    socket.emit(event, payload, (response: T) => { clearTimeout(timer); resolve(response) })
  })
}

async function listen(server: HttpServer): Promise<number> {
  return await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing port')
      resolve(address.port)
    })
  })
}

export async function connectGroupChatClient(
  port: number,
  userId: string,
  name: string,
  auth: Record<string, unknown> = {},
): Promise<ClientSocket> {
  const socket = clientIo(`http://127.0.0.1:${port}/group-chat`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { userId, name, ...auth },
  })
  return await once<ClientSocket>(socket as any, 'connect').then(() => socket)
}

export async function createTestGroupChatServer(): Promise<{
  db: DatabaseSync
  httpServer: HttpServer
  groupServer: GroupChatServer
  port: number
  sockets: ClientSocket[]
  cleanup: () => void
}> {
  const db = new DatabaseSync(':memory:')
  groupChatDbMock.current = db
  initAllHermesTables()
  const httpServer = createServer()
  const groupServer = new GroupChatServer(httpServer)
  const port = await listen(httpServer)
  const sockets: ClientSocket[] = []
  return {
    db,
    httpServer,
    groupServer,
    port,
    sockets,
    cleanup: () => {
      for (const socket of sockets) socket.disconnect()
      groupServer.getIO().close()
      httpServer.close()
      db.close()
      groupChatDbMock.current = null
      sockets.length = 0
    },
  }
}

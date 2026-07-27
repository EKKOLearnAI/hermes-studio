import { createServer, type Server as HttpServer } from 'http'
import { DatabaseSync } from 'node:sqlite'
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client'
import { vi } from 'vitest'

const groupChatDbMock = vi.hoisted(() => ({ current: null as DatabaseSync | null }))

type BufferedClientSocket = ClientSocket & {
  __bufferedEvents__?: Map<string, unknown[]>
}

vi.mock('../../packages/server/src/db/index', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/server/src/db/index')>()
  return { ...actual, getDb: () => groupChatDbMock.current }
})
vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  isAuthEnabled: vi.fn(async () => false),
  authenticateUserToken: vi.fn(),
  loadActiveAuthenticatedUser: vi.fn((id: number | string) => {
    const db = groupChatDbMock.current
    if (!db) return null
    try {
      const user = db.prepare(
        'SELECT id, username, role, status FROM users WHERE id = ?',
      ).get(Number(id)) as { id: number; username: string; role: string; status: string } | undefined
      if (!user || user.status !== 'active') return null
      const profiles = db.prepare(
        'SELECT profile_name FROM user_profiles WHERE user_id = ? ORDER BY created_at, profile_name',
      ).all(user.id) as Array<{ profile_name: string }>
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        profiles: profiles.map(profile => profile.profile_name),
      }
    } catch {
      return null
    }
  }),
}))
vi.mock('../../packages/server/src/services/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/server/src/services/auth')>()
  return {
    ...actual,
    getGroupChatLocalIdentitySecret: vi.fn(async () => 'a'.repeat(64)),
  }
})

import { initAllHermesTables } from '../../packages/server/src/db/hermes/schemas'
import { claimHermesDatabaseOwnershipForTesting } from '../../packages/server/src/db/ownership'
import { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'
import { groupBridgeSessionId } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

export function once<T = any>(socket: ClientSocket, event: string, timeoutMs = 2_000): Promise<T> {
  const bufferedArgs = (socket as BufferedClientSocket).__bufferedEvents__?.get(event)
  if (bufferedArgs) {
    return Promise.resolve(bufferedArgs[0] as T)
  }
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
    autoConnect: false,
  })
  const bufferedSocket = socket as BufferedClientSocket
  bufferedSocket.__bufferedEvents__ = new Map<string, unknown[]>()
  socket.onAny((event, ...args) => {
    bufferedSocket.__bufferedEvents__?.set(event, args)
  })
  socket.connect()
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
  claimHermesDatabaseOwnershipForTesting(db)
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

export function seedAuthenticatedUser(
  db: DatabaseSync,
  input: { id: number; username: string; role?: 'super_admin' | 'admin'; status?: 'active' | 'disabled'; profiles?: string[] },
): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at, last_login_at, avatar)
    VALUES (?, ?, 'test-only', ?, ?, ?, ?, NULL, '')
  `).run(input.id, input.username, input.role || 'admin', input.status || 'active', now, now)
  const insertProfile = db.prepare(`
    INSERT INTO user_profiles (user_id, profile_name, is_default, created_at)
    VALUES (?, ?, ?, ?)
  `)
  ;(input.profiles || []).forEach((profile, index) => {
    insertProfile.run(input.id, profile, index === 0 ? 1 : 0, now)
  })
}

export function currentRoomAgentSessionId(
  groupServer: GroupChatServer,
  roomId: string,
  agentId: string,
  profile: string,
  name: string,
): string {
  const storage = groupServer.getStorage()
  const room = storage.getRoom(roomId)
  if (!room || !/^[0-9a-f]{32}$/i.test(String(room.sessionSeed || ''))) {
    throw new Error(`room ${roomId} does not have a cryptographic session seed`)
  }
  const actor = storage.findActiveActorByAgentIdentity?.(roomId, agentId) ?? null
  return groupBridgeSessionId(
    roomId,
    profile,
    name,
    room.sessionSeed,
    {
      actorId: actor?.id || null,
      roomAuthorizationRevision: room?.authorizationRevision,
      actorAuthorizationRevision: actor?.authorizationRevision,
      actorContextRevision: actor?.contextRevision,
    },
  )
}

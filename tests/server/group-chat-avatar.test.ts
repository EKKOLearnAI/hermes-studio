import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server as HttpServer } from 'http'

describe('group chat member avatars', () => {
  let db: any = null
  let httpServer: HttpServer | null = null
  let chatServer: any = null

  beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('AUTH_JWT_SECRET', 'test-secret')
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(() => {
    chatServer?.getIO?.().close()
    httpServer?.close()
    db?.close()
    chatServer = null
    httpServer = null
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function initStorage() {
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
    const users = await import('../../packages/server/src/db/hermes/users-store')
    const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
    httpServer = createServer()
    chatServer = new GroupChatServer(httpServer)
    return {
      users,
      storage: chatServer.getStorage() as any,
    }
  }

  it('resolves member avatars by authUserId when display name differs from login username', async () => {
    const { users, storage } = await initStorage()
    const alice = users.createUser({ username: 'alice-login', password: 'pw' })!
    const bob = users.createUser({ username: 'bob-login', password: 'pw' })!
    const aliceAvatar = JSON.stringify({ type: 'image', dataUrl: 'data:image/png;base64,ALICE' })
    const bobAvatar = JSON.stringify({ type: 'image', dataUrl: 'data:image/png;base64,BOB' })
    const aliceAvatarUpdated = JSON.stringify({ type: 'image', dataUrl: 'data:image/png;base64,ALICE2' })

    users.setUserAvatar(alice.id, aliceAvatar)
    users.setUserAvatar(bob.id, bobAvatar)

    storage.addRoomMember('room-1', 'participant-alice', 'Alice Display', '', '', alice.id)
    storage.addRoomMember('room-1', 'participant-bob', 'Bob Display', '', '', bob.id)

    expect(storage.getRoomMembers('room-1')).toMatchObject([
      { userId: 'participant-alice', name: 'Alice Display', avatar: aliceAvatar },
      { userId: 'participant-bob', name: 'Bob Display', avatar: bobAvatar },
    ])

    users.setUserAvatar(alice.id, aliceAvatarUpdated)
    storage.addRoomMember('room-1', 'participant-alice', 'Alice Display', '')

    expect(storage.getRoomMembers('room-1')).toMatchObject([
      { userId: 'participant-alice', name: 'Alice Display', avatar: aliceAvatarUpdated },
      { userId: 'participant-bob', name: 'Bob Display', avatar: bobAvatar },
    ])
  })

  it('does not assign another user avatar when a member has no exact identity match', async () => {
    const { users, storage } = await initStorage()
    const alice = users.createUser({ username: 'alice-login', password: 'pw' })!
    const aliceAvatar = JSON.stringify({ type: 'image', dataUrl: 'data:image/png;base64,ALICE' })
    users.setUserAvatar(alice.id, aliceAvatar)

    storage.addRoomMember('room-1', 'anonymous-participant', 'Unmatched Display', '')

    expect(storage.getRoomMembers('room-1')).toMatchObject([
      { userId: 'anonymous-participant', name: 'Unmatched Display', avatar: '' },
    ])
  })
})

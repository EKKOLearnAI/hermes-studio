import Koa from 'koa'
import { createServer } from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
  once,
  seedAuthenticatedUser,
} from './group-chat-test-helpers'
import { authenticateUserToken, isAuthEnabled } from '../../packages/server/src/middleware/user-auth'
import { setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'
import type { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

async function routeHandler(path: string, method: string) {
  const { groupChatRoutes } = await import('../../packages/server/src/routes/hermes/group-chat')
  const layer = (groupChatRoutes as any).stack.find((item: any) => item.path === path && item.methods.includes(method))
  if (!layer) throw new Error(`Route not found: ${method} ${path}`)
  return layer.stack[0]
}

async function listenHttp(server: ReturnType<typeof createServer>): Promise<string> {
  return await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing HTTP address')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

describe('group chat invite admission', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let port: number

  beforeEach(async () => {
    vi.clearAllMocks()
    harness = await createTestGroupChatServer()
    groupServer = harness.groupServer
    port = harness.port
    setGroupChatServer(groupServer)
  })

  afterEach(() => {
    groupServer?.setJoinAdmissionCheckpointForTests(null)
    setGroupChatServer(null)
    vi.mocked(isAuthEnabled).mockResolvedValue(false)
    vi.mocked(authenticateUserToken).mockResolvedValue(null as any)
    harness?.cleanup()
  })

  it('denies a join when the invite rotates before transactional reload and writes no identity rows', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'readonly-token') {
        return { id: 42, username: 'readonly', role: 'admin', profiles: [] } as any
      }
      return null
    })

    seedAuthenticatedUser(harness.db, { id: 42, username: 'readonly' })
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    groupServer.setJoinAdmissionCheckpointForTests(() => {
      storage.updateRoomInviteCode('room-1', 'ROOM2')
    })

    const readonly = await connectGroupChatClient(port, 'ignored-readonly', 'ReadOnly', { token: 'readonly-token' })
    harness.sockets.push(readonly)

    const joined = await emitAck<any>(readonly, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    expect(joined).toEqual({ error: 'Room not found' })
    expect(storage.getRoom('room-1')).toMatchObject({ inviteCode: 'ROOM2', inviteGeneration: 1, authorizationRevision: 1 })
    expect((harness.db.prepare('SELECT COUNT(*) AS count FROM gc_room_members WHERE roomId = ?').get('room-1') as { count: number }).count).toBe(0)
    expect((harness.db.prepare('SELECT COUNT(*) AS count FROM gc_room_actors WHERE roomId = ?').get('room-1') as { count: number }).count).toBe(0)
    expect((harness.db.prepare('SELECT COUNT(*) AS count FROM gc_room_actor_capabilities WHERE roomId = ?').get('room-1') as { count: number }).count).toBe(0)
  })

  it('allows a returning invite member to rejoin after rotation without resubmitting the old code', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'readonly-token') {
        return { id: 42, username: 'readonly', role: 'admin', profiles: [] } as any
      }
      return null
    })

    seedAuthenticatedUser(harness.db, { id: 42, username: 'readonly' })
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')

    const first = await connectGroupChatClient(port, 'ignored-readonly-a', 'ReadOnly', { token: 'readonly-token' })
    harness.sockets.push(first)
    await expect(emitAck<any>(first, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })).resolves.toEqual(
      expect.objectContaining({ roomId: 'room-1' }),
    )
    first.disconnect()

    storage.updateRoomInviteCode('room-1', 'ROOM2')

    const second = await connectGroupChatClient(port, 'ignored-readonly-b', 'ReadOnly', { token: 'readonly-token' })
    harness.sockets.push(second)
    const rejoined = await emitAck<any>(second, 'join', { roomId: 'room-1' })
    const messageAck = await emitAck<any>(second, 'message', {
      roomId: 'room-1',
      id: 'readonly-msg-after-rotation',
      content: 'still readonly',
    })

    expect(rejoined).toEqual(expect.objectContaining({ roomId: 'room-1' }))
    expect(messageAck).toEqual({ error: 'Access denied' })
    const actor = storage.findActiveActorByAuthUserId('room-1', 42)
    expect(actor).not.toBeNull()
    expect(actor ? storage.getActorCapabilities(actor.id) : []).toEqual(['room.read'])
    expect((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM gc_room_members WHERE roomId = ? AND authUserId = ?',
    ).get('room-1', 42) as { count: number }).count).toBe(1)
  })

  it('lets an authenticated member leave an invite room without deleting it or retaining invite-less access', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'member-token') {
        return { id: 42, username: 'member', role: 'admin', profiles: [] } as any
      }
      return null
    })

    seedAuthenticatedUser(harness.db, { id: 42, username: 'member' })
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')

    const member = await connectGroupChatClient(port, 'ignored-member', 'Member', { token: 'member-token' })
    harness.sockets.push(member)
    await expect(emitAck<any>(member, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })).resolves.toEqual(
      expect.objectContaining({ roomId: 'room-1' }),
    )
    expect(storage.findActiveActorByAuthUserId('room-1', 42)).not.toBeNull()
    expect((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM gc_room_members WHERE roomId = ? AND authUserId = ?',
    ).get('room-1', 42) as { count: number }).count).toBe(1)

    const leave = await routeHandler('/api/hermes/group-chat/rooms/:roomId/members/me', 'DELETE')
    const ctx: any = {
      params: { roomId: 'room-1' },
      state: { user: { id: 42, username: 'member', role: 'admin', profiles: [] } },
      status: 200,
      body: undefined,
    }
    await leave(ctx, async () => {})

    expect(ctx.body).toEqual({ success: true, left: true })
    expect(storage.getRoom('room-1')).toEqual(expect.objectContaining({ id: 'room-1', inviteCode: 'ROOM1' }))
    expect(storage.findActiveActorByAuthUserId('room-1', 42)).toBeNull()
    expect((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM gc_room_members WHERE roomId = ? AND authUserId = ?',
    ).get('room-1', 42) as { count: number }).count).toBe(0)
    await expect(emitAck(member, 'message', {
      roomId: 'room-1',
      id: 'after-leave',
      content: 'must fail',
    })).resolves.toEqual({ error: 'Not in room' })
    await expect(emitAck<any>(member, 'join', { roomId: 'room-1' })).resolves.toEqual({ error: 'Room not found' })
  })

  it('lets an authenticated room owner leave and clears owner-only access', async () => {
    seedAuthenticatedUser(harness.db, { id: 42, username: 'owner' })
    const storage = groupServer.getStorage()
    storage.createRoomWithOwner({
      id: 'owner-room',
      name: 'Owner Room',
      inviteCode: 'OWNER1',
      owner: {
        kind: 'authenticated',
        authUserId: 42,
        username: 'owner',
        description: '',
        avatar: '',
      },
    })

    const detail = await routeHandler('/api/hermes/group-chat/rooms/:roomId', 'GET')
    const beforeCtx: any = {
      params: { roomId: 'owner-room' },
      query: {},
      state: { user: { id: 42, username: 'owner', role: 'admin', profiles: [] } },
      status: 200,
      body: undefined,
    }
    await detail(beforeCtx, async () => {})
    expect(beforeCtx.body.room).toEqual(expect.objectContaining({ id: 'owner-room', canLeave: true, canManage: true }))

    const leave = await routeHandler('/api/hermes/group-chat/rooms/:roomId/members/me', 'DELETE')
    const leaveCtx: any = {
      params: { roomId: 'owner-room' },
      state: { user: { id: 42, username: 'owner', role: 'admin', profiles: [] } },
      status: 200,
      body: undefined,
    }
    await leave(leaveCtx, async () => {})

    expect(leaveCtx.body).toEqual({ success: true, left: true })
    expect(storage.getRoom('owner-room')).toEqual(expect.objectContaining({ id: 'owner-room', ownerAuthUserId: null }))
    expect(storage.getMemberByAuthUserId('owner-room', 42)).toBeNull()

    const afterCtx: any = {
      params: { roomId: 'owner-room' },
      query: {},
      state: { user: { id: 42, username: 'owner', role: 'admin', profiles: [] } },
      status: 200,
      body: undefined,
    }
    await detail(afterCtx, async () => {})
    expect(afterCtx.status).toBe(404)
    expect(afterCtx.body).toEqual({ error: 'Room not found' })
  })

  it('keeps repeated authenticated rejoins idempotent for member and actor persistence', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'readonly-token') {
        return { id: 42, username: 'readonly', role: 'admin', profiles: [] } as any
      }
      return null
    })

    seedAuthenticatedUser(harness.db, { id: 42, username: 'readonly' })
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')

    const first = await connectGroupChatClient(port, 'ignored-readonly-a', 'ReadOnly A', { token: 'readonly-token' })
    const second = await connectGroupChatClient(port, 'ignored-readonly-b', 'ReadOnly B', { token: 'readonly-token' })
    harness.sockets.push(first, second)

    await expect(emitAck<any>(first, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })).resolves.toEqual(
      expect.objectContaining({ roomId: 'room-1' }),
    )
    await expect(emitAck<any>(second, 'join', { roomId: 'room-1' })).resolves.toEqual(
      expect.objectContaining({ roomId: 'room-1' }),
    )

    expect((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM gc_room_members WHERE roomId = ? AND authUserId = ?',
    ).get('room-1', 42) as { count: number }).count).toBe(1)
    expect((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM gc_room_actors WHERE roomId = ? AND authUserId = ? AND active = 1',
    ).get('room-1', 42) as { count: number }).count).toBe(1)
  })

  it('uses the same missing-room shape for direct detail on strangers and absent rooms', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-private', 'Private Room', 'ROOM1')
    storage.addRoomAgent('room-private', 'agent-1', 'research', 'Researcher', '', 0)

    const detail = await routeHandler('/api/hermes/group-chat/rooms/:roomId', 'GET')

    const strangerCtx: any = {
      params: { roomId: 'room-private' },
      query: {},
      state: { user: { id: 9, username: 'stranger', role: 'admin', profiles: ['default'] } },
      status: 200,
      body: undefined,
    }
    const missingCtx: any = {
      params: { roomId: 'room-missing' },
      query: {},
      state: { user: { id: 9, username: 'stranger', role: 'admin', profiles: ['default'] } },
      status: 200,
      body: undefined,
    }

    await detail(strangerCtx, async () => {})
    await detail(missingCtx, async () => {})

    expect(strangerCtx.status).toBe(404)
    expect(strangerCtx.body).toEqual({ error: 'Room not found' })
    expect(missingCtx.status).toBe(404)
    expect(missingCtx.body).toEqual({ error: 'Room not found' })
  })

  it('uses the same missing-room shape for stranger and missing Socket.IO joins', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'stranger-token') {
        return { id: 84, username: 'stranger', role: 'admin', profiles: ['default'] } as any
      }
      return null
    })

    seedAuthenticatedUser(harness.db, { id: 84, username: 'stranger', profiles: ['default'] })
    const storage = groupServer.getStorage()
    storage.saveRoom('room-private', 'Private Room', 'ROOM1')
    storage.addRoomAgent('room-private', 'agent-1', 'research', 'Researcher', '', 0)

    const stranger = await connectGroupChatClient(port, 'ignored-stranger', 'Stranger', { token: 'stranger-token' })
    harness.sockets.push(stranger)

    const existing = await emitAck<any>(stranger, 'join', { roomId: 'room-private' })
    const missing = await emitAck<any>(stranger, 'join', { roomId: 'room-missing' })

    expect(existing).toEqual({ error: 'Room not found' })
    expect(missing).toEqual({ error: 'Room not found' })
  })

  it('filters successful join room ids through the joining subject discover policy', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-visible', 'Visible Room', 'VISIBLE')
    storage.saveRoom('room-hidden', 'Hidden Room', 'HIDDEN')

    const hiddenMember = await connectGroupChatClient(port, 'hidden-routing', 'Hidden Member')
    const visibleMember = await connectGroupChatClient(port, 'visible-routing', 'Visible Member')
    harness.sockets.push(hiddenMember, visibleMember)
    await expect(emitAck<any>(hiddenMember, 'join', {
      roomId: 'room-hidden',
      inviteCode: 'HIDDEN',
    })).resolves.toEqual(expect.objectContaining({ roomId: 'room-hidden' }))

    const joined = await emitAck<any>(visibleMember, 'join', {
      roomId: 'room-visible',
      inviteCode: 'VISIBLE',
    })
    expect(joined.rooms).toEqual(['room-visible'])
  })

  it('hides mutator room existence from strangers but returns 403 to known read-only members', async () => {
    seedAuthenticatedUser(harness.db, { id: 42, username: 'readonly', role: 'admin' })
    const storage = groupServer.getStorage()
    storage.saveRoom('room-private', 'Private Room', 'ROOM1')
    storage.ensureAuthenticatedHumanActor({
      roomId: 'room-private',
      authUserId: 42,
      userId: 'auth:42',
      userName: 'Read Only',
      description: '',
      avatar: '',
      capabilities: ['room.read'],
    })

    const handler = await routeHandler('/api/hermes/group-chat/rooms/:roomId/config', 'PUT')
    const request = { body: { triggerTokens: 42 } }
    const strangerCtx: any = {
      params: { roomId: 'room-private' },
      request,
      state: { user: { id: 9, username: 'stranger', role: 'admin', profiles: [] } },
      status: 200,
      body: undefined,
    }
    const readOnlyCtx: any = {
      params: { roomId: 'room-private' },
      request,
      state: { user: { id: 42, username: 'readonly', role: 'admin', profiles: [] } },
      status: 200,
      body: undefined,
    }
    const missingCtx: any = {
      params: { roomId: 'room-missing' },
      request,
      state: { user: { id: 9, username: 'stranger', role: 'admin', profiles: [] } },
      status: 200,
      body: undefined,
    }

    await handler(strangerCtx, async () => {})
    await handler(readOnlyCtx, async () => {})
    await handler(missingCtx, async () => {})

    expect(strangerCtx.status).toBe(404)
    expect(strangerCtx.body).toEqual({ error: 'Room not found' })
    expect(missingCtx.status).toBe(404)
    expect(missingCtx.body).toEqual({ error: 'Room not found' })
    expect(readOnlyCtx.status).toBe(403)
    expect(readOnlyCtx.body).toEqual({ error: 'Access denied' })
  })

  it('rate-limits failed REST invite lookups per subject without exposing valid codes', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const handler = await routeHandler('/api/hermes/group-chat/rooms/join/:code', 'GET')

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ctx: any = {
        params: { code: `INVALID-${attempt}` },
        state: { user: { id: 77 } },
        ip: '127.0.0.1',
        status: 200,
        body: undefined,
      }
      await handler(ctx, async () => {})
      expect(ctx.status).toBe(404)
      expect(ctx.body).toEqual({ error: 'Room not found' })
    }

    const blockedValidCtx: any = {
      params: { code: 'ROOM1' },
      state: { user: { id: 77 } },
      ip: '127.0.0.1',
      status: 200,
      body: undefined,
    }
    await handler(blockedValidCtx, async () => {})
    expect(blockedValidCtx.status).toBe(404)
    expect(blockedValidCtx.body).toEqual({ error: 'Room not found' })

    const otherSubjectCtx: any = {
      params: { code: 'ROOM1' },
      state: { user: { id: 78 } },
      ip: '127.0.0.1',
      status: 200,
      body: undefined,
    }
    await handler(otherSubjectCtx, async () => {})
    expect(otherSubjectCtx.body).toEqual({ room: expect.objectContaining({ id: 'room-1' }) })
  })

  it('does not reset the REST invite failure budget after a successful lookup in another room', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-target', 'Target Room', 'TARGET1')
    storage.saveRoom('room-known', 'Known Room', 'KNOWN99')
    const handler = await routeHandler('/api/hermes/group-chat/rooms/join/:code', 'GET')

    for (let attempt = 0; attempt < 7; attempt += 1) {
      const ctx: any = {
        params: { code: `MISS-${attempt}` },
        state: { user: { id: 77 } },
        ip: '127.0.0.1',
        status: 200,
        body: undefined,
      }
      await handler(ctx, async () => {})
      expect(ctx.status).toBe(404)
      expect(ctx.body).toEqual({ error: 'Room not found' })
    }

    const knownCtx: any = {
      params: { code: 'KNOWN99' },
      state: { user: { id: 77 } },
      ip: '127.0.0.1',
      status: 200,
      body: undefined,
    }
    await handler(knownCtx, async () => {})
    expect(knownCtx.body).toEqual({ room: expect.objectContaining({ id: 'room-known' }) })

    const exhaustingCtx: any = {
      params: { code: 'MISS-final' },
      state: { user: { id: 77 } },
      ip: '127.0.0.1',
      status: 200,
      body: undefined,
    }
    await handler(exhaustingCtx, async () => {})
    expect(exhaustingCtx.status).toBe(404)
    expect(exhaustingCtx.body).toEqual({ error: 'Room not found' })

    for (const code of ['TARGET1', 'MISS-after-lock']) {
      const blockedCtx: any = {
        params: { code },
        state: { user: { id: 77 } },
        ip: '127.0.0.1',
        status: 200,
        body: undefined,
      }
      await handler(blockedCtx, async () => {})
      expect(blockedCtx.status).toBe(404)
      expect(blockedCtx.body).toEqual({ error: 'Room not found' })
    }
  })

  it('isolates local invite budgets by signed subject and preserves them across reconnects', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-local-limit', 'Local Limit', 'LOCAL-SECRET')

    const first = await connectGroupChatClient(port, 'routing-a', 'Local A')
    harness.sockets.push(first)
    const identity = await once<{ localCredential: string }>(first, 'local_identity')
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(emitAck<any>(first, 'join', {
        roomId: 'room-local-limit',
        inviteCode: `MISS-${attempt}`,
      })).resolves.toEqual({ error: 'Room not found' })
    }

    const second = await connectGroupChatClient(port, 'routing-b', 'Local B')
    harness.sockets.push(second)
    await expect(emitAck<any>(second, 'join', {
      roomId: 'room-local-limit',
      inviteCode: 'LOCAL-SECRET',
    })).resolves.toEqual(expect.objectContaining({ roomId: 'room-local-limit' }))

    first.disconnect()
    const reconnectedFirst = await connectGroupChatClient(port, 'routing-a-changed', 'Local A', {
      localCredential: identity.localCredential,
    })
    harness.sockets.push(reconnectedFirst)
    await expect(emitAck<any>(reconnectedFirst, 'join', {
      roomId: 'room-local-limit',
      inviteCode: 'LOCAL-SECRET',
    })).resolves.toEqual({ error: 'Room not found' })
  })

  it('rate-limits failed Socket.IO invite admissions per authenticated subject', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'blocked-token') return { id: 77, username: 'blocked', role: 'admin', profiles: [] } as any
      if (token === 'other-token') return { id: 78, username: 'other', role: 'admin', profiles: [] } as any
      return null
    })

    seedAuthenticatedUser(harness.db, { id: 77, username: 'blocked' })
    seedAuthenticatedUser(harness.db, { id: 78, username: 'other' })
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    const blocked = await connectGroupChatClient(port, 'ignored-blocked', 'Blocked', { token: 'blocked-token' })
    harness.sockets.push(blocked)

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(emitAck<any>(blocked, 'join', {
        roomId: 'room-1',
        inviteCode: `INVALID-${attempt}`,
      })).resolves.toEqual({ error: 'Room not found' })
    }
    await expect(emitAck<any>(blocked, 'join', {
      roomId: 'room-1',
      inviteCode: 'ROOM1',
    })).resolves.toEqual({ error: 'Room not found' })

    const other = await connectGroupChatClient(port, 'ignored-other', 'Other', { token: 'other-token' })
    harness.sockets.push(other)
    await expect(emitAck<any>(other, 'join', {
      roomId: 'room-1',
      inviteCode: 'ROOM1',
    })).resolves.toEqual(expect.objectContaining({ roomId: 'room-1' }))
  })

  it('does not reset the Socket.IO invite failure budget after a successful join in another room', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'blocked-token') return { id: 77, username: 'blocked', role: 'admin', profiles: [] } as any
      return null
    })

    seedAuthenticatedUser(harness.db, { id: 77, username: 'blocked' })
    const storage = groupServer.getStorage()
    storage.saveRoom('room-target', 'Target Room', 'TARGET1')
    storage.saveRoom('room-known', 'Known Room', 'KNOWN99')
    const blocked = await connectGroupChatClient(port, 'ignored-blocked', 'Blocked', { token: 'blocked-token' })
    harness.sockets.push(blocked)

    for (let attempt = 0; attempt < 7; attempt += 1) {
      await expect(emitAck<any>(blocked, 'join', {
        roomId: 'room-target',
        inviteCode: `MISS-${attempt}`,
      })).resolves.toEqual({ error: 'Room not found' })
    }

    await expect(emitAck<any>(blocked, 'join', {
      roomId: 'room-known',
      inviteCode: 'KNOWN99',
    })).resolves.toEqual(expect.objectContaining({ roomId: 'room-known' }))

    await expect(emitAck<any>(blocked, 'join', {
      roomId: 'room-target',
      inviteCode: 'MISS-final',
    })).resolves.toEqual({ error: 'Room not found' })

    await expect(emitAck<any>(blocked, 'join', {
      roomId: 'room-known',
    })).resolves.toEqual(expect.objectContaining({ roomId: 'room-known' }))

    await expect(emitAck<any>(blocked, 'join', {
      roomId: 'room-target',
      inviteCode: 'TARGET1',
    })).resolves.toEqual({ error: 'Room not found' })
    await expect(emitAck<any>(blocked, 'join', {
      roomId: 'room-target',
      inviteCode: 'MISS-after-lock',
    })).resolves.toEqual({ error: 'Room not found' })
  })

  it('shares a signed local subject invite budget across Socket.IO and REST', async () => {
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    const local = await connectGroupChatClient(port, 'display-only', 'Local')
    harness.sockets.push(local)
    const identity = await once<{ localCredential: string }>(local, 'local_identity')

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(emitAck<any>(local, 'join', {
        roomId: 'room-1',
        inviteCode: `INVALID-${attempt}`,
      })).resolves.toEqual({ error: 'Room not found' })
    }

    const handler = await routeHandler('/api/hermes/group-chat/rooms/join/:code', 'GET')
    const ctx: any = {
      params: { code: 'ROOM1' },
      state: {},
      ip: '127.0.0.1',
      status: 200,
      body: undefined,
      get: (name: string) => name.toLowerCase() === 'x-group-chat-local-credential'
        ? identity.localCredential
        : '',
    }

    await handler(ctx, async () => {})

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Room not found' })
  })

  it('preserves explicit invite bytes on create, clone, and update room routes', async () => {
    seedAuthenticatedUser(harness.db, { id: 1, username: 'root', role: 'super_admin' })
    const admin = { id: 1, username: 'root', role: 'super_admin', profiles: [] }
    const create = await routeHandler('/api/hermes/group-chat/rooms', 'POST')
    const clone = await routeHandler('/api/hermes/group-chat/rooms/:roomId/clone', 'POST')
    const update = await routeHandler('/api/hermes/group-chat/rooms/:roomId/invite-code', 'PUT')

    const createdInviteCode = '  MiXeD Create  '
    const createCtx: any = {
      request: { body: { name: 'Created Room', inviteCode: createdInviteCode, agents: [] } },
      state: { user: admin },
      status: 200,
      body: undefined,
    }
    await create(createCtx, async () => {})
    expect(groupServer.getStorage().getRoom(createCtx.body.room.id)).toEqual(
      expect.objectContaining({ inviteCode: createdInviteCode, ownerAuthUserId: 1 }),
    )
    expect(groupServer.getStorage().findActiveActorByAuthUserId(createCtx.body.room.id, 1)).toEqual(
      expect.objectContaining({ roomId: createCtx.body.room.id, authUserId: 1, active: 1 }),
    )
    expect((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM gc_room_members WHERE roomId = ? AND authUserId = ?'
    ).get(createCtx.body.room.id, 1) as { count: number }).count).toBe(1)
    expect(createCtx.body.room).toEqual(expect.objectContaining({ inviteCode: createdInviteCode }))

    groupServer.getStorage().saveRoom('room-source', 'Source Room', 'SOURCE1', { ownerAuthUserId: 1 })
    const clonedInviteCode = '  cLoNe Invite  '
    const cloneCtx: any = {
      params: { roomId: 'room-source' },
      request: { body: { name: 'Clone Room', inviteCode: clonedInviteCode } },
      state: { user: admin },
      status: 200,
      body: undefined,
    }
    await clone(cloneCtx, async () => {})
    expect(groupServer.getStorage().getRoom(cloneCtx.body.room.id)).toEqual(
      expect.objectContaining({ inviteCode: clonedInviteCode, ownerAuthUserId: 1 }),
    )
    expect(groupServer.getStorage().findActiveActorByAuthUserId(cloneCtx.body.room.id, 1)).toEqual(
      expect.objectContaining({ roomId: cloneCtx.body.room.id, authUserId: 1, active: 1 }),
    )
    expect((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM gc_room_members WHERE roomId = ? AND authUserId = ?'
    ).get(cloneCtx.body.room.id, 1) as { count: number }).count).toBe(1)
    expect(cloneCtx.body.room).toEqual(expect.objectContaining({ inviteCode: clonedInviteCode }))

    const updatedInviteCode = '  UpDaTe Invite  '
    const updateCtx: any = {
      params: { roomId: cloneCtx.body.room.id },
      request: { body: { inviteCode: updatedInviteCode } },
      state: { user: admin },
      status: 200,
      body: undefined,
    }
    await update(updateCtx, async () => {})
    expect(groupServer.getStorage().getRoom(cloneCtx.body.room.id)).toEqual(
      expect.objectContaining({ inviteCode: updatedInviteCode }),
    )
  })

  it('round-trips URL-significant invite bytes through the real HTTP router', async () => {
    const inviteCode = ' A/B?#MiXeD '
    groupServer.getStorage().saveRoom('room-special', 'Special Room', inviteCode)
    const app = new Koa()
    app.use((await import('../../packages/server/src/routes/hermes/group-chat')).groupChatRoutes.routes())
    const server = createServer(app.callback())
    const baseUrl = await listenHttp(server)

    try {
      const response = await fetch(
        `${baseUrl}/api/hermes/group-chat/rooms/join/${encodeURIComponent(inviteCode)}`,
      )
      const body = await response.json() as { room?: { id?: string; inviteCode?: string } }

      expect(response.status).toBe(200)
      expect(body.room).toEqual(expect.objectContaining({
        id: 'room-special',
        inviteCode: null,
      }))
      expect(groupServer.getStorage().getRoom('room-special')).toEqual(
        expect.objectContaining({ inviteCode }),
      )
    } finally {
      server.close()
    }
  })

  it('generates cryptographic invite defaults server-side for create and clone', async () => {
    seedAuthenticatedUser(harness.db, { id: 1, username: 'root', role: 'super_admin' })
    const admin = { id: 1, username: 'root', role: 'super_admin', profiles: [] }
    const create = await routeHandler('/api/hermes/group-chat/rooms', 'POST')
    const createCtx: any = {
      request: { body: { name: 'Generated Room', agents: [] } },
      state: { user: admin },
      status: 200,
      body: undefined,
    }
    await create(createCtx, async () => {})
    expect(createCtx.body.room.inviteCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/)

    const clone = await routeHandler('/api/hermes/group-chat/rooms/:roomId/clone', 'POST')
    const cloneCtx: any = {
      params: { roomId: createCtx.body.room.id },
      request: { body: { name: 'Generated Clone', inviteCode: '' } },
      state: { user: admin },
      status: 200,
      body: undefined,
    }
    await clone(cloneCtx, async () => {})
    expect(cloneCtx.body.room.inviteCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/)
    expect(cloneCtx.body.room.inviteCode).not.toBe(createCtx.body.room.inviteCode)
  })

  it('treats whitespace-only invite code input as blank without trimming nonblank codes', async () => {
    seedAuthenticatedUser(harness.db, { id: 1, username: 'root', role: 'super_admin' })
    const admin = { id: 1, username: 'root', role: 'super_admin', profiles: [] }
    const create = await routeHandler('/api/hermes/group-chat/rooms', 'POST')
    const clone = await routeHandler('/api/hermes/group-chat/rooms/:roomId/clone', 'POST')
    const update = await routeHandler('/api/hermes/group-chat/rooms/:roomId/invite-code', 'PUT')

    const createCtx: any = {
      request: { body: { name: 'Whitespace Create', inviteCode: '   ', agents: [] } },
      state: { user: admin },
      status: 200,
      body: undefined,
    }
    await create(createCtx, async () => {})
    expect(createCtx.body.room.inviteCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/)

    const cloneCtx: any = {
      params: { roomId: createCtx.body.room.id },
      request: { body: { name: 'Whitespace Clone', inviteCode: '\t  ' } },
      state: { user: admin },
      status: 200,
      body: undefined,
    }
    await clone(cloneCtx, async () => {})
    expect(cloneCtx.body.room.inviteCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/)
    expect(cloneCtx.body.room.inviteCode).not.toBe(createCtx.body.room.inviteCode)

    const updateCtx: any = {
      params: { roomId: cloneCtx.body.room.id },
      request: { body: { inviteCode: '  ' } },
      state: { user: admin },
      status: 200,
      body: undefined,
    }
    await update(updateCtx, async () => {})
    expect(updateCtx.status).toBe(400)
    expect(updateCtx.body).toEqual({ error: 'inviteCode is required' })
    expect(groupServer.getStorage().getRoom(cloneCtx.body.room.id)).toEqual(
      expect.objectContaining({ inviteCode: cloneCtx.body.room.inviteCode }),
    )
  })

  it('returns the same invite lookup miss for stale and unknown codes without echoing raw codes', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    storage.updateRoomInviteCode('room-1', 'ROOM2')

    const handler = await routeHandler('/api/hermes/group-chat/rooms/join/:code', 'GET')
    const staleCtx: any = { params: { code: 'ROOM1' }, status: 200, body: undefined }
    const missingCtx: any = { params: { code: 'NOPE99' }, status: 200, body: undefined }

    await handler(staleCtx, async () => {})
    await handler(missingCtx, async () => {})

    expect(staleCtx.status).toBe(404)
    expect(staleCtx.body).toEqual({ error: 'Room not found' })
    expect(missingCtx.status).toBe(404)
    expect(missingCtx.body).toEqual({ error: 'Room not found' })
    expect(JSON.stringify(staleCtx.body)).not.toContain('ROOM1')
    expect(JSON.stringify(missingCtx.body)).not.toContain('NOPE99')
  })
})

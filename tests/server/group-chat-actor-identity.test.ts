import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
  once,
  seedAuthenticatedUser,
} from './group-chat-test-helpers'
import { authenticateUserToken, isAuthEnabled } from '../../packages/server/src/middleware/user-auth'
import { groupBridgeSessionId } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import type { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

describe('group chat actor identity', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let port: number

  beforeEach(async () => {
    vi.clearAllMocks()
    harness = await createTestGroupChatServer()
    groupServer = harness.groupServer
    port = harness.port
  })

  afterEach(() => {
    vi.mocked(isAuthEnabled).mockResolvedValue(false)
    vi.mocked(authenticateUserToken).mockResolvedValue(null as any)
    harness?.cleanup()
  })

  it('creates actor tables with revision and active-state columns', () => {
    const tables = harness.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>

    expect(tables.map(table => table.name)).toContain('gc_room_actors')
    expect(tables.map(table => table.name)).toContain('gc_room_actor_capabilities')

    const actorColumns = harness.db.prepare(`PRAGMA table_info("gc_room_actors")`).all() as Array<{ name: string }>
    const capabilityColumns = harness.db.prepare(`PRAGMA table_info("gc_room_actor_capabilities")`).all() as Array<{ name: string }>

    expect(actorColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'id',
      'roomId',
      'actorType',
      'active',
      'authorizationRevision',
      'contextRevision',
    ]))
    expect(capabilityColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'actorId',
      'capability',
      'active',
    ]))
  })

  it('keeps authenticated invite joins read-only for public messaging and typing', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'readonly-token') {
        return { id: 42, username: 'readonly', role: 'admin', profiles: [] } as any
      }
      if (token === 'manager-token') {
        return { id: 7, username: 'owner', role: 'super_admin', profiles: [] } as any
      }
      return null
    })

    seedAuthenticatedUser(harness.db, { id: 42, username: 'readonly' })
    seedAuthenticatedUser(harness.db, { id: 7, username: 'owner', role: 'super_admin' })
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1', { ownerAuthUserId: 7 })
    groupServer.getStorage().addRoomAgent('room-1', 'agent-1', 'default', 'Worker', '', 0)

    const readonly = await connectGroupChatClient(port, 'ignored-readonly', 'ReadOnly', { token: 'readonly-token' })
    const manager = await connectGroupChatClient(port, 'ignored-manager', 'Owner', { token: 'manager-token' })
    harness.sockets.push(readonly, manager)

    await emitAck(manager, 'join', { roomId: 'room-1' })
    await emitAck(readonly, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)

    const messageAck = await emitAck<any>(readonly, 'message', {
      roomId: 'room-1',
      id: 'readonly-msg-1',
      content: '@Worker hello',
    })

    let typingPayload: unknown = null
    let stopTypingPayload: unknown = null
    manager.on('typing', payload => { typingPayload = payload })
    manager.on('stop_typing', payload => { stopTypingPayload = payload })
    readonly.emit('typing', { roomId: 'room-1' })
    readonly.emit('stop_typing', { roomId: 'room-1' })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(messageAck).toEqual({ error: 'Access denied' })
    expect(processMentions).not.toHaveBeenCalled()
    expect(typingPayload).toBeNull()
    expect(stopTypingPayload).toBeNull()
  })

  it('requires an invite for a non-member even when their allowed profile matches a room agent', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'profile-token') {
        return { id: 42, username: 'profile-user', role: 'admin', profiles: ['default'] } as any
      }
      return null
    })

    seedAuthenticatedUser(harness.db, { id: 42, username: 'profile-user', profiles: ['default'] })
    const storage = groupServer.getStorage()
    storage.saveRoom('room-profile', 'Profile Room', 'ROOM1', { ownerAuthUserId: 7 })
    storage.addRoomAgent('room-profile', 'agent-1', 'default', 'Worker', '', 0)

    const client = await connectGroupChatClient(port, 'ignored-profile-user', 'Profile User', { token: 'profile-token' })
    harness.sockets.push(client)

    await expect(emitAck<any>(client, 'join', { roomId: 'room-profile' })).resolves.toEqual({ error: 'Room not found' })
    expect(storage.getMemberByAuthUserId('room-profile', 42)).toBeNull()
    expect(storage.findActiveActorByAuthUserId('room-profile', 42)).toBeNull()

    await expect(emitAck<any>(client, 'join', {
      roomId: 'room-profile',
      inviteCode: 'ROOM1',
    })).resolves.toEqual(expect.objectContaining({ roomId: 'room-profile' }))
    expect(storage.getMemberByAuthUserId('room-profile', 42)).not.toBeNull()
  })

  it('preserves authoritative authenticated grants during an ordinary authorized reconnect', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const actor = storage.ensureAuthenticatedHumanActor({
      roomId: 'room-1',
      authUserId: 42,
      userId: 'auth:42',
      userName: 'Manager',
      description: '',
      avatar: '',
      capabilities: ['room.read', 'room.write', 'room.manage'],
    })
    const authorizationRevision = actor.authorizationRevision

    const admission = storage.admitHumanMember({
      roomId: 'room-1',
      userId: 'new-routing-id',
      requestedName: 'Manager',
      requestedDescription: '',
      avatar: '',
      authUser: { id: 42, username: 'manager', role: 'admin', profiles: [] },
    })

    expect(admission.status).toBe('admitted')
    expect(storage.getActorCapabilities(actor.id)).toEqual([
      'room.read',
      'room.write',
      'room.manage',
    ])
    expect(storage.findActiveActorByAuthUserId('room-1', 42)?.authorizationRevision).toBe(authorizationRevision)
    expect((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM gc_room_members WHERE roomId = ? AND authUserId = ?',
    ).get('room-1', 42) as { count: number }).count).toBe(1)
    expect(storage.getMemberByAuthUserId('room-1', 42)?.userId).toBe('new-routing-id')
  })

  it('repairs a legacy authenticated member row on invite-less rejoin without creating a duplicate', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-legacy', 'Legacy Room', 'LEGACY')
    const now = Date.now()
    harness.db.prepare(
      `INSERT INTO gc_room_members (id, roomId, userId, userName, description, joinedAt, updatedAt, avatar, authUserId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('member-legacy-42', 'room-legacy', 'auth:42', 'Legacy Name', '', now, now, '', null)

    const admission = storage.admitHumanMember({
      roomId: 'room-legacy',
      userId: 'auth:42',
      requestedName: 'Updated Name',
      requestedDescription: '',
      avatar: '',
      authUser: { id: 42, username: 'legacy', role: 'admin', profiles: [] },
    })

    expect(admission.status).toBe('admitted')
    expect(harness.db.prepare(
      'SELECT userId, userName, authUserId FROM gc_room_members WHERE roomId = ?',
    ).all('room-legacy')).toEqual([
      { userId: 'auth:42', userName: 'Updated Name', authUserId: 42 },
    ])
    expect(storage.findActiveActorByAuthUserId('room-legacy', 42)).not.toBeNull()
    expect(storage.getActorCapabilities(storage.findActiveActorByAuthUserId('room-legacy', 42)!.id)).toContain('room.read')
  })

  it('adds invite read authority without deleting an authenticated actor\'s other grants', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const actor = storage.ensureAuthenticatedHumanActor({
      roomId: 'room-1',
      authUserId: 42,
      userId: 'auth:42',
      userName: 'Writer',
      description: '',
      avatar: '',
      capabilities: ['room.write'],
    })
    harness.db.prepare('DELETE FROM gc_room_members WHERE roomId = ?').run('room-1')

    const admission = storage.admitHumanMember({
      roomId: 'room-1',
      userId: 'routing-id',
      inviteCode: 'ROOM1',
      requestedName: 'Writer',
      requestedDescription: '',
      avatar: '',
      authUser: { id: 42, username: 'writer', role: 'admin', profiles: [] },
    })

    expect(admission.status).toBe('admitted')
    expect(storage.getActorCapabilities(actor.id)).toEqual(['room.read', 'room.write'])
  })

  it('keeps one active actor while authorizing every concurrent socket for that user', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'shared-token') {
        return { id: 11, username: 'alice', role: 'admin', profiles: [] } as any
      }
      return null
    })

    seedAuthenticatedUser(harness.db, { id: 11, username: 'alice' })
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1', { ownerAuthUserId: 11 })

    const first = await connectGroupChatClient(port, 'local-a', 'Alice A', { token: 'shared-token' })
    const second = await connectGroupChatClient(port, 'local-b', 'Alice B', { token: 'shared-token' })
    harness.sockets.push(first, second)

    await Promise.all([
      emitAck(first, 'join', { roomId: 'room-1' }),
      emitAck(second, 'join', { roomId: 'room-1' }),
    ])

    await expect(emitAck(first, 'message', {
      roomId: 'room-1',
      id: 'multi-socket-first',
      content: 'from first socket',
    })).resolves.toEqual({ id: 'multi-socket-first' })
    await expect(emitAck(second, 'message', {
      roomId: 'room-1',
      id: 'multi-socket-second',
      content: 'from second socket',
    })).resolves.toEqual({ id: 'multi-socket-second' })

    let memberLeftEvents = 0
    second.on('member_left', () => { memberLeftEvents += 1 })
    first.disconnect()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(memberLeftEvents).toBe(0)
    await expect(emitAck(second, 'message', {
      roomId: 'room-1',
      id: 'multi-socket-survivor',
      content: 'still joined',
    })).resolves.toEqual({ id: 'multi-socket-survivor' })

    const rows = harness.db.prepare(
      `SELECT id FROM gc_room_actors WHERE roomId = ? AND authUserId = ? AND active = 1`
    ).all('room-1', 11) as Array<{ id: string }>

    expect(rows).toHaveLength(1)
  })

  it('revalidates account status for every realtime ingress and recipient decision', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'revoked-token') {
        return { id: 21, username: 'revoked', role: 'super_admin', profiles: [] } as any
      }
      if (token === 'observer-token') {
        return { id: 23, username: 'observer', role: 'super_admin', profiles: [] } as any
      }
      return null
    })
    seedAuthenticatedUser(harness.db, { id: 21, username: 'revoked', role: 'super_admin' })
    seedAuthenticatedUser(harness.db, { id: 23, username: 'observer', role: 'super_admin' })
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')

    const authenticated = await connectGroupChatClient(port, 'ignored-auth', 'Revoked', { token: 'revoked-token' })
    const observer = await connectGroupChatClient(port, 'ignored-observer', 'Observer', { token: 'observer-token' })
    harness.sockets.push(authenticated, observer)
    await emitAck(authenticated, 'join', { roomId: 'room-1' })
    await emitAck(observer, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    let leaked = false
    authenticated.on('message', () => { leaked = true })
    harness.db.prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?").run(Date.now(), 21)
    await emitAck(observer, 'message', { roomId: 'room-1', id: 'post-disable', content: 'secret after disable' })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(leaked).toBe(false)
    await expect(emitAck(authenticated, 'message', {
      roomId: 'room-1',
      id: 'revoked-write',
      content: 'must fail',
    })).resolves.toEqual({ error: 'Not in room' })
  })

  it('tombstones account authority and disconnects every socket on explicit revocation', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'delete-token') {
        return { id: 22, username: 'deleted', role: 'super_admin', profiles: [] } as any
      }
      return null
    })
    seedAuthenticatedUser(harness.db, { id: 22, username: 'deleted', role: 'super_admin' })
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1', { ownerAuthUserId: 22 })
    const authenticated = await connectGroupChatClient(port, 'ignored-delete', 'Deleted', { token: 'delete-token' })
    harness.sockets.push(authenticated)
    await emitAck(authenticated, 'join', { roomId: 'room-1' })
    expect(groupServer.getStorage().findActiveActorByAuthUserId('room-1', 22)).not.toBeNull()

    groupServer.revokeAuthenticatedUser(22)
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(authenticated.connected).toBe(false)
    expect(groupServer.getStorage().findActiveActorByAuthUserId('room-1', 22)).toBeNull()
    expect(groupServer.getStorage().getRoom('room-1')?.ownerAuthUserId).toBeNull()
    expect((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM gc_room_members WHERE roomId = ? AND authUserId = ?',
    ).get('room-1', 22) as { count: number }).count).toBe(0)
  })

  it('rejects invite-less local rejoins when a client forges an existing local user id without a server-issued credential', async () => {
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')

    const original = await connectGroupChatClient(port, 'forged-local', 'Original')
    harness.sockets.push(original)
    await expect(emitAck<any>(original, 'join', {
      roomId: 'room-1',
      inviteCode: 'ROOM1',
    })).resolves.toEqual(expect.objectContaining({ roomId: 'room-1' }))
    original.disconnect()

    const forged = await connectGroupChatClient(port, 'forged-local', 'Forged')
    harness.sockets.push(forged)

    await expect(emitAck<any>(forged, 'join', {
      roomId: 'room-1',
    })).resolves.toEqual({ error: 'Room not found' })
  })

  it('preserves unauthenticated reconnects with a server-issued local credential instead of client userId authority', async () => {
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')

    const first = await connectGroupChatClient(port, 'ignored-local-a', 'Original')
    harness.sockets.push(first)
    const issuedIdentity = await once<{ localCredential: string }>(first, 'local_identity')

    await expect(emitAck<any>(first, 'join', {
      roomId: 'room-1',
      inviteCode: 'ROOM1',
    })).resolves.toEqual(expect.objectContaining({ roomId: 'room-1' }))
    first.disconnect()

    const second = await connectGroupChatClient(port, 'ignored-local-b', 'Reconnect', {
      localCredential: issuedIdentity.localCredential,
    })
    harness.sockets.push(second)

    await expect(emitAck<any>(second, 'join', {
      roomId: 'room-1',
    })).resolves.toEqual(expect.objectContaining({ roomId: 'room-1' }))

    const localActor = harness.db.prepare(
      `SELECT id FROM gc_room_actors WHERE roomId = ? AND actorType = 'local' AND active = 1`,
    ).get('room-1') as { id: string }
    harness.db.prepare('DELETE FROM gc_room_actor_capabilities WHERE actorId = ?').run(localActor.id)

    await expect(emitAck<any>(second, 'message', {
      roomId: 'room-1',
      content: 'must be denied',
    })).resolves.toEqual({ error: 'Access denied' })
    second.disconnect()

    const deniedReconnect = await connectGroupChatClient(port, 'ignored-local-c', 'Denied Reconnect', {
      localCredential: issuedIdentity.localCredential,
    })
    harness.sockets.push(deniedReconnect)
    await expect(emitAck<any>(deniedReconnect, 'join', {
      roomId: 'room-1',
    })).resolves.toEqual({ error: 'Room not found' })
  })

  it('derives local routing identity server-side and cannot collide with an authenticated actor', async () => {
    seedAuthenticatedUser(harness.db, { id: 42, username: 'authenticated', role: 'super_admin' })
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => token === 'auth-token'
      ? { id: 42, username: 'authenticated', role: 'super_admin', profiles: [] } as any
      : null)

    const authenticated = await connectGroupChatClient(port, 'ignored-auth-routing', 'Authenticated', { token: 'auth-token' })
    harness.sockets.push(authenticated)
    await expect(emitAck<any>(authenticated, 'join', { roomId: 'room-1' })).resolves.toEqual(
      expect.objectContaining({ roomId: 'room-1' }),
    )

    vi.mocked(isAuthEnabled).mockResolvedValue(false)
    const local = await connectGroupChatClient(port, 'auth:42', 'Local impostor')
    harness.sockets.push(local)
    const localIdentity = await once<{ localCredential: string; userId: string }>(local, 'local_identity')
    const joined = await emitAck<any>(local, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    expect(localIdentity.userId).toMatch(/^local-user:[0-9a-f]{64}$/)
    expect(localIdentity.userId).not.toBe('auth:42')
    expect(joined.members.map((member: { userId: string }) => member.userId).sort()).toEqual(
      ['auth:42', localIdentity.userId].sort(),
    )
    expect(harness.db.prepare(
      'SELECT userId, userName, authUserId FROM gc_room_members WHERE roomId = ? ORDER BY userId',
    ).all('room-1')).toEqual([
      { userId: 'auth:42', userName: 'Authenticated', authUserId: 42 },
      { userId: localIdentity.userId, userName: 'Local impostor', authUserId: null },
    ].sort((left, right) => left.userId.localeCompare(right.userId)))

    const delivered = once<any>(authenticated, 'message')
    await expect(emitAck<any>(local, 'message', {
      roomId: 'room-1',
      id: 'local-attribution-message',
      content: 'local attribution',
    })).resolves.toEqual({ id: 'local-attribution-message' })
    await expect(delivered).resolves.toEqual(expect.objectContaining({
      senderId: localIdentity.userId,
      senderName: 'Local impostor',
    }))
  })

  it('keeps distinct local subjects separate when they request the same routing id', async () => {
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    const first = await connectGroupChatClient(port, 'shared-client-routing', 'Local A')
    const second = await connectGroupChatClient(port, 'shared-client-routing', 'Local B')
    harness.sockets.push(first, second)
    const firstIdentity = await once<{ localCredential: string; userId: string }>(first, 'local_identity')
    const secondIdentity = await once<{ localCredential: string; userId: string }>(second, 'local_identity')

    await emitAck(first, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    const joined = await emitAck<any>(second, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    expect(firstIdentity.userId).toMatch(/^local-user:[0-9a-f]{64}$/)
    expect(secondIdentity.userId).toMatch(/^local-user:[0-9a-f]{64}$/)
    expect(secondIdentity.userId).not.toBe(firstIdentity.userId)
    expect(joined.members.map((member: { userId: string }) => member.userId).sort()).toEqual(
      [firstIdentity.userId, secondIdentity.userId].sort(),
    )
    expect((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM gc_room_members WHERE roomId = ?',
    ).get('room-1') as { count: number }).count).toBe(2)
  })

  it('deduplicates multiple sockets for the same verified local subject', async () => {
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    const first = await connectGroupChatClient(port, 'first-client-routing', 'Local A')
    harness.sockets.push(first)
    const firstIdentity = await once<{ localCredential: string; userId: string }>(first, 'local_identity')
    await emitAck(first, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const second = await connectGroupChatClient(port, 'second-client-routing', 'Local A second tab', {
      localCredential: firstIdentity.localCredential,
    })
    harness.sockets.push(second)
    const secondIdentity = await once<{ localCredential: string; userId: string }>(second, 'local_identity')
    const joined = await emitAck<any>(second, 'join', { roomId: 'room-1' })

    expect(secondIdentity.userId).toBe(firstIdentity.userId)
    expect(joined.members.filter((member: { userId: string }) => member.userId === firstIdentity.userId)).toHaveLength(1)
    expect((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM gc_room_members WHERE roomId = ? AND userId = ?',
    ).get('room-1', firstIdentity.userId) as { count: number }).count).toBe(1)
    const room = (groupServer as any).rooms.get('room-1')
    expect(room.hasOnlineMember(first.id!)).toBe(true)
    expect(room.hasOnlineMember(second.id!)).toBe(true)
  })

  it('does not restore a local actor\'s removed grants when identity metadata is re-ensured', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const input = {
      roomId: 'room-1',
      localSubjectId: 'local-subject-1',
      userId: 'routing-id',
      userName: 'Local User',
      description: '',
      avatar: '',
    }
    const actor = storage.ensureLocalActor(input)
    harness.db.prepare('DELETE FROM gc_room_actor_capabilities WHERE actorId = ?').run(actor.id)

    storage.ensureLocalActor({ ...input, description: 'updated metadata' })

    expect(storage.getActorCapabilities(actor.id)).toEqual([])
  })

  it('persists local default grants only when a valid invite explicitly re-admits the actor', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const actor = storage.ensureLocalActor({
      roomId: 'room-1',
      localSubjectId: 'local-subject-1',
      userId: 'routing-id',
      userName: 'Local User',
      description: '',
      avatar: '',
    })
    harness.db.prepare('DELETE FROM gc_room_actor_capabilities WHERE actorId = ?').run(actor.id)

    const admission = storage.admitHumanMember({
      roomId: 'room-1',
      localSubjectId: 'local-subject-1',
      userId: 'new-routing-id',
      inviteCode: 'ROOM1',
      requestedName: 'Local User',
      requestedDescription: '',
      avatar: '',
    })

    expect(admission.status).toBe('admitted')
    expect(storage.getActorCapabilities(actor.id)).toEqual([
      'room.read',
      'room.write',
      'room.type',
      'room.manage',
      'agent.invoke',
      'approval.respond',
    ])
  })

  it('bumps actor revisions only when capabilities or projection metadata change', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const baseInput = {
      roomId: 'room-1',
      authUserId: 42,
      userId: 'auth:42',
      userName: 'Read Only',
      description: '',
      avatar: '',
      capabilities: ['room.read'],
    }

    const created = storage.ensureAuthenticatedHumanActor(baseInput)
    const unchanged = storage.ensureAuthenticatedHumanActor(baseInput)
    const metadataChanged = storage.ensureAuthenticatedHumanActor({
      ...baseInput,
      description: 'updated',
    })
    const capabilitiesChanged = storage.ensureAuthenticatedHumanActor({
      ...baseInput,
      description: 'updated',
      capabilities: [],
    })
    const idempotent = storage.ensureAuthenticatedHumanActor({
      ...baseInput,
      description: 'updated',
      capabilities: [],
    })

    expect(created).toMatchObject({ authorizationRevision: 0, contextRevision: 0 })
    expect(unchanged).toMatchObject({ authorizationRevision: 0, contextRevision: 0 })
    expect(metadataChanged).toMatchObject({ authorizationRevision: 0, contextRevision: 1 })
    expect(capabilitiesChanged).toMatchObject({ authorizationRevision: 1, contextRevision: 1 })
    expect(idempotent).toMatchObject({ authorizationRevision: 1, contextRevision: 1 })
  })

  it('does not create actor rows when read lookups miss', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')

    const before = harness.db.prepare(
      `SELECT COUNT(*) AS count FROM gc_room_actors`
    ).get() as { count: number }

    expect(storage.findActiveActorByAuthUserId('room-1', 9)).toBeNull()
    expect(storage.findActiveActorByAgentIdentity('room-1', 'agent-missing')).toBeNull()
    expect(storage.findActiveActorByLocalSubjectId('room-1', 'local-missing')).toBeNull()
    expect(storage.findActiveActorBySystemKey('room-1', 'room-system')).toBeNull()

    const after = harness.db.prepare(
      `SELECT COUNT(*) AS count FROM gc_room_actors`
    ).get() as { count: number }

    expect(after.count).toBe(before.count)
  })

  it('uses cryptographic room seeds and advances room revisions for authorization/config mutations', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const created = storage.getRoom('room-1')

    expect(created?.sessionSeed).toMatch(/^[0-9a-f]{32}$/)
    expect(created?.authorizationRevision).toBe(0)

    storage.setRoomOwnerAuthUserId('room-1', 7)
    expect(storage.getRoom('room-1')?.authorizationRevision).toBe(1)
    storage.setRoomOwnerAuthUserId('room-1', 7)
    expect(storage.getRoom('room-1')?.authorizationRevision).toBe(1)

    storage.updateRoomConfig('room-1', { triggerTokens: 2048 })
    expect(storage.getRoom('room-1')?.authorizationRevision).toBe(2)

    storage.addRoomAgent('room-1', 'agent-1', 'default', 'Worker', '', 0)
    expect(storage.getRoom('room-1')?.authorizationRevision).toBe(3)

    const beforeWorkspace = storage.getRoom('room-1')?.sessionSeed
    storage.updateRoomWorkspace('room-1', '/tmp/workspace')
    const afterWorkspace = storage.getRoom('room-1')?.sessionSeed
    expect(afterWorkspace).toMatch(/^[0-9a-f]{32}$/)
    expect(afterWorkspace).not.toBe(beforeWorkspace)

    storage.clearRoomContext('room-1')
    expect(storage.getRoom('room-1')?.sessionSeed).toMatch(/^[0-9a-f]{32}$/)
    expect(storage.getRoom('room-1')?.sessionSeed).not.toBe(afterWorkspace)
  })

  it('changes public bridge session fingerprints when actor or room revisions change', () => {
    const base = (groupBridgeSessionId as any)(
      'room-1',
      'default',
      'Worker',
      '11111111111111111111111111111111',
      {
        actorId: 'actor-1',
        actorAuthorizationRevision: 0,
        actorContextRevision: 0,
        roomAuthorizationRevision: 0,
      },
    )
    const authRevision = (groupBridgeSessionId as any)(
      'room-1',
      'default',
      'Worker',
      '11111111111111111111111111111111',
      {
        actorId: 'actor-1',
        actorAuthorizationRevision: 1,
        actorContextRevision: 0,
        roomAuthorizationRevision: 0,
      },
    )
    const roomRevision = (groupBridgeSessionId as any)(
      'room-1',
      'default',
      'Worker',
      '11111111111111111111111111111111',
      {
        actorId: 'actor-1',
        actorAuthorizationRevision: 0,
        actorContextRevision: 0,
        roomAuthorizationRevision: 1,
      },
    )

    expect(base).toMatch(/^gc_h_[0-9a-f]{32}$/)
    expect(base).not.toContain('room-1')
    expect(base).not.toContain('default')
    expect(base).not.toContain('Worker')
    expect(base).not.toContain('11111111111111111111111111111111')
    expect(base).not.toContain('actor-1')
    expect(base).not.toBe(authRevision)
    expect(base).not.toBe(roomRevision)
  })

  it('keeps the complete session id opaque and rotates it when the actor incarnation changes', () => {
    const first = (groupBridgeSessionId as any)(
      'room-1',
      'default',
      'Worker',
      '11111111111111111111111111111111',
      {
        actorId: 'actor-secret-1',
        actorAuthorizationRevision: 0,
        actorContextRevision: 0,
        roomAuthorizationRevision: 0,
      },
    )
    const second = (groupBridgeSessionId as any)(
      'room-1',
      'default',
      'Worker',
      '11111111111111111111111111111111',
      {
        actorId: 'actor-secret-2',
        actorAuthorizationRevision: 0,
        actorContextRevision: 0,
        roomAuthorizationRevision: 0,
      },
    )

    const firstSuffix = first.match(/_h_([0-9a-f]+)$/)?.[1] ?? ''
    const secondSuffix = second.match(/_h_([0-9a-f]+)$/)?.[1] ?? ''

    expect(first).not.toContain('actor-secret-1')
    expect(second).not.toContain('actor-secret-2')
    expect(first).not.toBe(second)
    expect(firstSuffix).toHaveLength(32)
    expect(secondSuffix).toHaveLength(32)
  })
})

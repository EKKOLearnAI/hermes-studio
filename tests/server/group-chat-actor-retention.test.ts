import Koa from 'koa'
import bodyParser from '@koa/bodyparser'
import { createServer, type Server as HttpServer } from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const interruptMock = vi.fn(async () => ({ ok: true, synced: true }))
const destroyMock = vi.fn(async () => ({ ok: true }))

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn().mockImplementation(() => ({
    interrupt: interruptMock,
    destroy: destroyMock,
  })),
}))

import {
  createTestGroupChatServer,
  currentRoomAgentSessionId,
  seedAuthenticatedUser,
} from './group-chat-test-helpers'
import { groupChatRoutes, setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'
import type { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'
import { groupBridgeSummarySessionId } from '../../packages/server/src/services/hermes/group-chat/agent-clients'

function listen(server: HttpServer): Promise<string> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('missing address')
    resolve(`http://127.0.0.1:${addr.port}`)
  }))
}

describe('group chat actor retention', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let httpServer: HttpServer
  let baseUrl: string

  beforeEach(async () => {
    interruptMock.mockReset()
    interruptMock.mockResolvedValue({ ok: true, synced: true })
    destroyMock.mockReset()
    destroyMock.mockResolvedValue({ ok: true })
    harness = await createTestGroupChatServer()
    seedAuthenticatedUser(harness.db, { id: 1, username: 'root', role: 'super_admin' })
    groupServer = harness.groupServer
    setGroupChatServer(groupServer)

    const app = new Koa()
    app.use(async (ctx, next) => {
      ctx.state.user = { id: 1, username: 'root', role: 'super_admin', profiles: [] }
      await next()
    })
    app.use(bodyParser())
    app.use(groupChatRoutes.routes())
    httpServer = createServer(app.callback())
    baseUrl = await listen(httpServer)
  })

  afterEach(() => {
    httpServer?.close()
    harness?.cleanup()
    setGroupChatServer(null as any)
  })

  it('atomically grants a signed local creator without persisting the authority id as a member routing id', () => {
    const storage = groupServer.getStorage()
    storage.createRoomWithOwner({
      id: 'room-local-owner',
      name: 'Local room',
      inviteCode: 'LOCAL1',
      owner: {
        kind: 'local',
        localSubjectId: 'local:11111111111111111111111111111111',
        username: 'Local user',
      },
    })

    const room = storage.getRoom('room-local-owner')
    const actor = storage.findActiveActorByLocalSubjectId(
      'room-local-owner',
      'local:11111111111111111111111111111111',
    )
    expect(room).toMatchObject({ id: 'room-local-owner', ownerAuthUserId: null })
    expect(actor).toMatchObject({ actorType: 'local', active: 1 })
    expect(actor && storage.getActorCapabilities(actor.id)).toEqual([
      'room.read',
      'room.write',
      'room.type',
      'room.manage',
      'agent.invoke',
      'approval.respond',
    ])
    expect(storage.getRoomMembers('room-local-owner')).toEqual([])
  })

  it('atomically registers active Bridge sessions and rejects post-revocation registration', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const agent = storage.addRoomAgent('room-1', 'agent-1', 'reviewer', 'Worker', '', 0)
    const actor = storage.findActiveActorByAgentIdentity('room-1', 'agent-1')
    const room = storage.getRoom('room-1')
    expect(actor).not.toBeNull()
    expect(room).not.toBeNull()
    if (!actor || !room || typeof room.sessionSeed !== 'string') {
      throw new Error('missing active room agent identity')
    }
    const sessionId = currentRoomAgentSessionId(
      groupServer,
      'room-1',
      'agent-1',
      'reviewer',
      'Worker',
    )
    const registration = {
      sessionId,
      roomId: 'room-1',
      agentId: 'agent-1',
      profileName: 'reviewer',
      agentName: 'Worker',
      sessionSeed: room.sessionSeed,
      roomAuthorizationRevision: room.authorizationRevision,
      actorId: actor.id,
      actorAuthorizationRevision: actor.authorizationRevision,
      actorContextRevision: actor.contextRevision,
    }

    expect(storage.registerSessionProfileForActiveAgent(registration)).toBe(true)
    expect(storage.getSessionProfile(sessionId)).toEqual(expect.objectContaining({
      session_id: sessionId,
      room_id: 'room-1',
      agent_id: 'agent-1',
      profile_name: 'reviewer',
    }))

    harness.db.prepare('DELETE FROM gc_room_actor_capabilities WHERE actorId = ?').run(actor.id)
    const missingGrantSessionId = `${sessionId.slice(0, -1)}${sessionId.endsWith('a') ? 'b' : 'a'}`
    expect(storage.registerSessionProfileForActiveAgent({
      ...registration,
      sessionId: missingGrantSessionId,
    })).toBe(false)
    expect(storage.getSessionProfile(missingGrantSessionId)).toBeNull()
    expect(storage.registerSessionProfileForActiveAgent({
      ...registration,
      sessionId: missingGrantSessionId,
      requireRunCapabilities: false,
    })).toBe(true)
    expect(storage.getSessionProfile(missingGrantSessionId)).not.toBeNull()
    storage.deleteSessionProfile(missingGrantSessionId)

    const removed = storage.removeAgentActorWithRetention('room-1', agent.id)
    expect(removed?.sessionProfiles).toEqual([
      expect.objectContaining({ session_id: sessionId, profile_name: 'reviewer' }),
    ])
    expect(harness.db.prepare(
      'SELECT session_id, profile_name, status FROM gc_pending_session_deletes WHERE session_id = ?',
    ).get(sessionId)).toEqual({ session_id: sessionId, profile_name: 'reviewer', status: 'pending' })

    const lateSessionId = `${sessionId.slice(0, -1)}${sessionId.endsWith('a') ? 'b' : 'a'}`
    expect(storage.registerSessionProfileForActiveAgent({
      ...registration,
      sessionId: lateSessionId,
    })).toBe(false)
    expect(storage.getSessionProfile(lateSessionId)).toBeNull()
  })

  it('atomically registers summary sessions with a crash cleanup intent', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    storage.addRoomAgent('room-1', 'agent-1', 'reviewer', 'Worker', '', 0)
    const actor = storage.findActiveActorByAgentIdentity('room-1', 'agent-1')
    const room = storage.getRoom('room-1')
    if (!actor || !room) throw new Error('missing active room agent identity')
    const revisions = {
      actorId: actor.id,
      roomAuthorizationRevision: room.authorizationRevision,
      actorAuthorizationRevision: actor.authorizationRevision,
      actorContextRevision: actor.contextRevision,
    }
    const sessionId = groupBridgeSummarySessionId('room-1', 'reviewer', 'Worker', room.sessionSeed, revisions)
    const registeredAt = Date.now()
    const registration = {
      sessionId,
      roomId: 'room-1',
      agentId: 'agent-1',
      profileName: 'reviewer',
      agentName: 'Worker',
      sessionSeed: room.sessionSeed,
      ...revisions,
      cleanupAfterMs: 600_000,
    }

    expect(storage.registerSessionProfileForActiveAgent(registration)).toBe(true)
    expect(storage.getSessionProfile(sessionId)).toEqual(expect.objectContaining({
      session_id: sessionId,
      room_id: 'room-1',
      agent_id: 'agent-1',
      profile_name: 'reviewer',
    }))
    const cleanup = harness.db.prepare(
      'SELECT session_id, profile_name, status, next_attempt_at FROM gc_pending_session_deletes WHERE session_id = ?',
    ).get(sessionId) as { session_id: string; profile_name: string; status: string; next_attempt_at: number }
    expect(cleanup).toEqual(expect.objectContaining({
      session_id: sessionId,
      profile_name: 'reviewer',
      status: 'pending',
    }))
    expect(cleanup.next_attempt_at).toBeGreaterThanOrEqual(registeredAt + 600_000)

    harness.db.prepare('DELETE FROM gc_room_actor_capabilities WHERE actorId = ?').run(actor.id)
    const deniedSessionId = groupBridgeSummarySessionId('room-1', 'reviewer', 'Worker', room.sessionSeed, revisions)
    expect(storage.registerSessionProfileForActiveAgent({ ...registration, sessionId: deniedSessionId })).toBe(false)
    expect(storage.getSessionProfile(deniedSessionId)).toBeNull()
    expect(harness.db.prepare(
      'SELECT 1 AS present FROM gc_pending_session_deletes WHERE session_id = ?',
    ).get(deniedSessionId)).toBeUndefined()
  })

  it('keeps an inactive tombstone and removes grants/session mappings when an agent is deleted', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const agent = storage.addRoomAgent('room-1', 'agent-1', 'default', 'Worker', '', 0)
    const actor = storage.findActiveActorByAgentIdentity('room-1', 'agent-1')
    expect(actor).not.toBeNull()
    if (!actor) throw new Error('missing active agent actor')
    storage.saveSessionProfile('session-1', 'room-1', 'agent-1', 'default')

    const response = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/${agent.id}`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)

    const actorRow = harness.db.prepare(
      `SELECT id, active, authUserId, agentId, localSubjectId, systemKey, name, description, avatar, tombstonedAt
       FROM gc_room_actors
       WHERE id = ?`
    ).get(actor.id) as {
      id: string
      active: number
      authUserId: number | null
      agentId: string | null
      localSubjectId: string | null
      systemKey: string | null
      name: string
      description: string
      avatar: string
      tombstonedAt: number | null
    } | undefined
    const capabilityRows = harness.db.prepare(
      `SELECT capability FROM gc_room_actor_capabilities WHERE roomId = ? AND actorId = ?`
    ).all('room-1', actor.id) as Array<{ capability: string }>
    const sessionRows = harness.db.prepare(
      `SELECT session_id FROM gc_session_profiles WHERE room_id = ? AND agent_id = ?`
    ).all('room-1', 'agent-1') as Array<{ session_id: string }>
    const pendingRows = harness.db.prepare(
      `SELECT session_id, profile_name, status FROM gc_pending_session_deletes WHERE session_id = ?`
    ).all('session-1') as Array<{ session_id: string; profile_name: string; status: string }>

    expect(actorRow).toEqual(expect.objectContaining({
      id: actor.id,
      active: 0,
      authUserId: null,
      agentId: null,
      localSubjectId: null,
      systemKey: null,
      name: 'Deleted agent',
      description: '',
      avatar: '',
      tombstonedAt: expect.any(Number),
    }))
    expect(capabilityRows).toEqual([])
    expect(sessionRows).toEqual([])
    expect(pendingRows).toEqual([{ session_id: 'session-1', profile_name: 'default', status: 'pending' }])
    expect(interruptMock).toHaveBeenCalledWith('session-1', 'Interrupted by group chat user', 'default')
    expect(destroyMock).toHaveBeenCalledWith('session-1', 'default')
  })

  it('deletes room actors, grants, and session mappings while retaining session cleanup outbox rows', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    storage.addRoomAgent('room-1', 'agent-1', 'default', 'Worker', '', 0)
    storage.ensureAuthenticatedHumanActor({
      roomId: 'room-1',
      authUserId: 42,
      userId: 'auth:42',
      userName: 'Read Only',
      description: '',
      avatar: '',
      capabilities: ['room.read'],
    })
    storage.saveSessionProfile('session-1', 'room-1', 'agent-1', 'default')

    storage.deleteRoom('room-1')

    for (const [table, column] of [
      ['gc_room_actor_capabilities', 'roomId'],
      ['gc_room_actors', 'roomId'],
      ['gc_session_profiles', 'room_id'],
      ['gc_room_agents', 'roomId'],
      ['gc_room_members', 'roomId'],
      ['gc_rooms', 'id'],
    ] as const) {
      const row = harness.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get('room-1') as { count: number }
      expect(row.count, table).toBe(0)
    }
    expect(harness.db.prepare(
      'SELECT session_id, profile_name, status FROM gc_pending_session_deletes WHERE session_id = ?',
    ).get('session-1')).toEqual({ session_id: 'session-1', profile_name: 'default', status: 'pending' })

    storage.saveRoom('room-1', 'Replacement', 'ROOM2')
    expect(storage.findActiveActorByAuthUserId('room-1', 42)).toBeNull()
    expect(storage.findActiveActorByAgentIdentity('room-1', 'agent-1')).toBeNull()
  })

  it('treats repeated agent deletion as idempotent', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const agent = storage.addRoomAgent('room-1', 'agent-1', 'default', 'Worker', '', 0)

    const first = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/${agent.id}`, {
      method: 'DELETE',
    })
    const second = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/${agent.id}`, {
      method: 'DELETE',
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toEqual({
      success: true,
      agents: [],
      members: [],
    })
  })

  it('preserves participant authority and identity when runtime cleanup fails', async () => {
    interruptMock.mockRejectedValueOnce(new Error('bridge unavailable'))
    destroyMock.mockRejectedValueOnce(new Error('bridge destroy unavailable'))

    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const agent = storage.addRoomAgent('room-1', 'agent-1', 'default', 'Worker', '', 0)
    const actor = storage.findActiveActorByAgentIdentity('room-1', 'agent-1')
    expect(actor).not.toBeNull()
    if (!actor) throw new Error('missing active agent actor')
    storage.saveSessionProfile('session-1', 'room-1', 'agent-1', 'default')

    const response = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/${agent.id}`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(409)
    expect(harness.db.prepare(
      `SELECT active, agentId, tombstonedAt FROM gc_room_actors WHERE id = ?`
    ).get(actor.id)).toEqual({
      active: 1,
      agentId: 'agent-1',
      tombstonedAt: null,
    })
    expect(storage.getActorCapabilities(actor.id)).toEqual(expect.arrayContaining([
      'room.read', 'room.write', 'room.type', 'agent.invoke',
    ]))
    expect(storage.getRoomAgent('room-1', agent.id)).toMatchObject({ agentId: 'agent-1' })
    expect(harness.db.prepare(
      `SELECT session_id, profile_name, status FROM gc_pending_session_deletes WHERE session_id = ?`
    ).get('session-1')).toBeUndefined()
    expect(interruptMock).toHaveBeenCalledWith(agent.sessionId, 'Interrupted by group chat user', 'default')
    expect(destroyMock).not.toHaveBeenCalled()
  })

  it('creates a new actor incarnation when the same agent identity is re-added after deletion', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const agent = storage.addRoomAgent('room-1', 'agent-1', 'default', 'Worker', '', 0)
    storage.ensureAgentActor('room-1', 'agent-1', 'Worker', '')

    const removed = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/${agent.id}`, {
      method: 'DELETE',
    })

    expect(removed.status).toBe(200)

    storage.addRoomAgent('room-1', 'agent-1', 'default', 'Worker', '', 0)
    storage.ensureAgentActor('room-1', 'agent-1', 'Worker', '')

    const actorRows = harness.db.prepare(
      `SELECT id, active, agentId, tombstonedAt, name FROM gc_room_actors WHERE roomId = ? ORDER BY createdAt`
    ).all('room-1') as Array<{ id: string; active: number; agentId: string | null; tombstonedAt: number | null; name: string }>

    expect(actorRows).toHaveLength(2)
    expect(actorRows.map(row => row.active)).toEqual([0, 1])
    expect(actorRows[0]?.id).not.toBe(actorRows[1]?.id)
    expect(actorRows[0]?.tombstonedAt).toEqual(expect.any(Number))
    expect(actorRows[0]?.agentId).toBeNull()
    expect(actorRows[0]?.name).toBe('Deleted agent')
    expect(actorRows[1]?.tombstonedAt).toBeNull()
    expect(actorRows[1]?.agentId).toBe('agent-1')
    expect(actorRows[1]?.name).toBe('Worker')
  })
})

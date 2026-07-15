import Koa from 'koa'
import bodyParser from '@koa/bodyparser'
import { createServer, type Server as HttpServer } from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { groupChatRoutes, setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'

function listen(server: HttpServer): Promise<string> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('missing address')
    resolve(`http://127.0.0.1:${addr.port}`)
  }))
}

describe('group chat REST route baseline', () => {
  let httpServer: HttpServer
  let baseUrl: string
  let storage: any
  let agentClients: any
  let clearRoomRuntimeState: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    storage = {
      rooms: new Map<string, any>(),
      agents: new Map<string, any[]>(),
      messages: new Map<string, any[]>(),
      members: new Map<string, any[]>(),
      saveRoom: vi.fn((id, name, inviteCode, config) => storage.rooms.set(id, { id, name, inviteCode, totalTokens: 0, sessionSeed: '0', ...config })),
      getRoom: vi.fn((id) => storage.rooms.get(id)),
      getAllRooms: vi.fn(() => [...storage.rooms.values()]),
      getRoomsForProfiles: vi.fn(() => [...storage.rooms.values()]),
      getRecentMessagesForUI: vi.fn((roomId, limit = 150, offset = 0) => (storage.messages.get(roomId) || []).slice(offset, offset + limit)),
      getMessageCount: vi.fn((roomId) => (storage.messages.get(roomId) || []).length),
      getRoomAgents: vi.fn((roomId) => storage.agents.get(roomId) || []),
      getRoomMembers: vi.fn((roomId) => storage.members.get(roomId) || []),
      getRoomByInviteCode: vi.fn((code) => [...storage.rooms.values()].find((r: any) => r.inviteCode === code)),
      addRoomAgent: vi.fn((roomId, agentId, profile, name, description, invited) => {
        const row = { id: `row-${agentId}`, roomId, agentId, profile, name, description, invited }
        storage.agents.set(roomId, [...(storage.agents.get(roomId) || []), row])
        return row
      }),
      getRoomAgent: vi.fn((roomId, ref) => (storage.agents.get(roomId) || []).find((a: any) => a.id === ref || a.agentId === ref) || null),
      removeRoomMembersForAgent: vi.fn(),
      removeRoomAgent: vi.fn((roomId, ref) => storage.agents.set(roomId, (storage.agents.get(roomId) || []).filter((a: any) => a.id !== ref && a.agentId !== ref))),
      clearRoomContext: vi.fn((roomId) => { const room = storage.rooms.get(roomId); if (room) Object.assign(room, { totalTokens: 0, sessionSeed: 'rotated' }) }),
      deleteRoom: vi.fn((roomId) => storage.rooms.delete(roomId)),
    }
    agentClients = {
      createAgent: vi.fn(async (cfg: any) => {
        if (cfg.profile === 'bad-profile') throw new Error('agent runtime unavailable')
        return { ...cfg, joinRoom: vi.fn(async () => ({})), disconnect: vi.fn() }
      }),
      addAgentToRoom: vi.fn(async () => ({})),
      removeAgentFromRoom: vi.fn(),
      disconnectRoom: vi.fn(),
    }
    clearRoomRuntimeState = vi.fn()
    setGroupChatServer({ getStorage: () => storage, agentClients, clearRoomRuntimeState } as any)
    const app = new Koa()
    app.use(bodyParser())
    app.use(groupChatRoutes.routes())
    httpServer = createServer(app.callback())
    baseUrl = await listen(httpServer)
  })

  afterEach(() => {
    httpServer.close()
    setGroupChatServer(null as any)
  })

  it('requires name and inviteCode when creating a room', async () => {
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Room' }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'name and inviteCode are required' })
  })

  it('rejects reserved @all agent names when creating a room', async () => {
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Room', inviteCode: 'ROOM1', agents: [{ profile: 'default', name: 'all' }] }),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: '`all` is reserved for @all mentions' })
  })

  it('creates a room, persists successful agents, and reports agent connection failures', async () => {
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Room',
        inviteCode: 'ROOM1',
        agents: [
          { profile: 'default', name: 'Worker' },
          { profile: 'bad-profile', name: 'Broken' },
        ],
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.room).toMatchObject({ name: 'Room', inviteCode: 'ROOM1' })
    expect(body.agents).toHaveLength(1)
    expect(body.agentResults).toEqual([
      expect.objectContaining({ profile: 'default', ok: true }),
      expect.objectContaining({ profile: 'bad-profile', ok: false, code: 'PROFILE_AGENT_CONNECT_FAILED' }),
    ])
    expect(storage.saveRoom).toHaveBeenCalled()
  })

  it('returns room detail with paging metadata, agents, and members', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.messages.set('room-1', [{ id: 'msg-1' }, { id: 'msg-2' }])
    storage.agents.set('room-1', [{ id: 'row-agent', agentId: 'agent-1', profile: 'default', name: 'Agent' }])
    storage.members.set('room-1', [{ userId: 'user-1', name: 'Alice' }])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1?limit=1&offset=1`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      room: { id: 'room-1', name: 'Room' },
      messages: [{ id: 'msg-2' }],
      agents: [{ agentId: 'agent-1' }],
      members: [{ userId: 'user-1' }],
      total: 2,
      offset: 1,
      limit: 1,
      hasMore: false,
    })
  })

  it('rejects duplicate room agent profiles', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [{ id: 'row-agent', agentId: 'agent-1', profile: 'default', name: 'Agent' }])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'default', name: 'Agent' }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'Agent already in room' })
  })

  it('removes an agent by row id and disconnects runtime by persisted agent id', async () => {
    const agent = { id: 'row-agent', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: 'Agent' }
    storage.agents.set('room-1', [agent])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/row-agent`, { method: 'DELETE' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(storage.removeRoomMembersForAgent).toHaveBeenCalledWith('room-1', agent)
    expect(storage.removeRoomAgent).toHaveBeenCalledWith('room-1', 'row-agent')
    expect(agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-1')
    expect(body).toMatchObject({ success: true, agents: [], members: [] })
  })

  it('clears room context and runtime state while returning the updated room', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', totalTokens: 99, sessionSeed: 'old' })

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/clear-context`, { method: 'POST' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(storage.clearRoomContext).toHaveBeenCalledWith('room-1')
    expect(clearRoomRuntimeState).toHaveBeenCalledWith('room-1')
    expect(body).toMatchObject({ success: true, room: { id: 'room-1', totalTokens: 0, sessionSeed: 'rotated' } })
  })
})

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
      listHandoffJobs: vi.fn(() => []),
      getRoomByInviteCode: vi.fn((code) => [...storage.rooms.values()].find((r: any) => r.inviteCode === code)),
      addRoomAgent: vi.fn((roomId, agentId, profile, name, description, invited, binding = {}) => {
        const row = { id: `row-${agentId}`, roomId, agentId, profile, name, description, invited, ...binding }
        storage.agents.set(roomId, [...(storage.agents.get(roomId) || []), row])
        return row
      }),
      getRoomAgent: vi.fn((roomId, ref) => (storage.agents.get(roomId) || []).find((a: any) => a.id === ref || a.agentId === ref) || null),
      updateRoomAgent: vi.fn((roomId, ref, patch) => {
        const agents = storage.agents.get(roomId) || []
        const index = agents.findIndex((agent: any) => agent.id === ref || agent.agentId === ref)
        if (index < 0) return null
        agents[index] = { ...agents[index], ...patch }
        storage.agents.set(roomId, agents)
        return agents[index]
      }),
      removeRoomMembersForAgent: vi.fn(),
      removeRoomAgent: vi.fn((roomId, ref) => storage.agents.set(roomId, (storage.agents.get(roomId) || []).filter((a: any) => a.id !== ref && a.agentId !== ref))),
      clearRoomContext: vi.fn((roomId) => { const room = storage.rooms.get(roomId); if (room) Object.assign(room, { totalTokens: 0, sessionSeed: 'rotated' }) }),
      updateRoomConfig: vi.fn((roomId, config) => { const room = storage.rooms.get(roomId); if (room) Object.assign(room, config) }),
      deleteRoom: vi.fn((roomId) => storage.rooms.delete(roomId)),
    }
    agentClients = {
      createAgent: vi.fn(async (cfg: any) => {
        if (cfg.profile === 'bad-profile') throw new Error('agent runtime unavailable')
        return { ...cfg, joinRoom: vi.fn(async () => ({})), disconnect: vi.fn() }
      }),
      addAgentToRoom: vi.fn(async () => ({})),
      removeAgentFromRoom: vi.fn(),
      interruptAgent: vi.fn(async () => {}),
      updateAgentIdentity: vi.fn(() => true),
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

  it('accepts a positive integer or null for the room automatic handoff limit', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', maxAgentMentionDepth: 4 })

    const finite = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgentMentionDepth: 12 }),
    })
    expect(finite.status).toBe(200)
    await expect(finite.json()).resolves.toMatchObject({ room: { maxAgentMentionDepth: 12 } })

    const unlimited = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgentMentionDepth: null }),
    })
    expect(unlimited.status).toBe(200)
    await expect(unlimited.json()).resolves.toMatchObject({ room: { maxAgentMentionDepth: null } })
  })

  it('accepts fixed handoff mode only with a unique order of current participant agent ids', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', handoffMode: 'mentions', handoffOrderJson: '[]' })
    storage.agents.set('room-1', [
      { id: 'row-a', agentId: 'agent-a', name: 'A' },
      { id: 'row-b', agentId: 'agent-b', name: 'B' },
    ])
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handoffMode: 'fixed', handoffOrder: ['agent-a', 'agent-b'] }),
    })
    expect(res.status).toBe(200)
    expect(storage.updateRoomConfig).toHaveBeenCalledWith('room-1', expect.objectContaining({
      handoffMode: 'fixed', handoffOrderJson: '["agent-a","agent-b"]',
    }))
  })

  it.each([
    ['unknown mode', { handoffMode: 'workflow' }],
    ['one participant', { handoffMode: 'fixed', handoffOrder: ['agent-a'] }],
    ['duplicate participant', { handoffMode: 'fixed', handoffOrder: ['agent-a', 'agent-a'] }],
    ['unknown participant', { handoffMode: 'fixed', handoffOrder: ['agent-a', 'missing'] }],
  ])('rejects invalid fixed handoff configuration: %s', async (_label, payload) => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', handoffMode: 'mentions', handoffOrderJson: '[]' })
    storage.agents.set('room-1', [
      { id: 'row-a', agentId: 'agent-a', name: 'A' },
      { id: 'row-b', agentId: 'agent-b', name: 'B' },
    ])
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    expect(res.status).toBe(400)
  })

  it('returns durable handoff status only to room readers', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.listHandoffJobs.mockReturnValue([{ id: 'job-1', status: 'failed', lastError: 'runner unavailable' }])
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/handoffs`)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ jobs: [{ id: 'job-1', status: 'failed', lastError: 'runner unavailable' }] })
  })

  it.each([0, -1, 1.5, '8'])('rejects invalid room automatic handoff limit %j', async (maxAgentMentionDepth) => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1', maxAgentMentionDepth: 4 })

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgentMentionDepth }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'maxAgentMentionDepth must be a positive integer or null' })
    expect(storage.updateRoomConfig).not.toHaveBeenCalled()
  })

  it('keeps legacy rooms at the default four automatic handoffs when cloned', async () => {
    storage.rooms.set('room-legacy', { id: 'room-legacy', name: 'Legacy', inviteCode: 'LEGACY', sessionSeed: '0' })
    storage.agents.set('room-legacy', [])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-legacy/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Legacy Copy', inviteCode: 'LEGACYCOPY' }),
    })

    expect(res.status).toBe(200)
    expect(storage.saveRoom).toHaveBeenCalledWith(expect.any(String), 'Legacy Copy', 'LEGACYCOPY', expect.objectContaining({
      maxAgentMentionDepth: 4,
    }))
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

  it('rejects incomplete scoped coding-agent launch tuples before creating a room', async () => {
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Incomplete Room',
        inviteCode: 'INCOMPLETE1',
        agents: [{ profile: 'default', name: 'Incomplete Codex', runtime: 'coding_agent', codingAgentId: 'codex' }],
      }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'provider, model, and apiMode are required for coding_agent participants' })
    expect(storage.saveRoom).not.toHaveBeenCalled()
    expect(agentClients.createAgent).not.toHaveBeenCalled()
  })

  it('rejects OAuth/subscription providers for scoped coding-agent participants before persistence', async () => {
    const forbiddenParticipant = {
      profile: 'default',
      name: 'OAuth Codex',
      runtime: 'coding_agent',
      codingAgentId: 'codex',
      mode: 'scoped',
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      apiMode: 'codex_responses',
    }

    const createRes = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Forbidden Room', inviteCode: 'FORBIDDEN1', agents: [forbiddenParticipant] }),
    })
    expect(createRes.status).toBe(400)
    await expect(createRes.json()).resolves.toMatchObject({ error: expect.stringContaining('does not support OAuth/subscription providers') })
    expect(storage.saveRoom).not.toHaveBeenCalled()
    expect(storage.addRoomAgent).not.toHaveBeenCalled()
    expect(agentClients.createAgent).not.toHaveBeenCalled()

    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    const addRes = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forbiddenParticipant),
    })
    expect(addRes.status).toBe(400)
    await expect(addRes.json()).resolves.toMatchObject({ error: expect.stringContaining('does not support OAuth/subscription providers') })
    expect(storage.addRoomAgent).not.toHaveBeenCalled()
    expect(agentClients.createAgent).not.toHaveBeenCalled()
  })

  it('rejects cloning legacy scoped participants with forbidden providers before persisting a new room', async () => {
    storage.rooms.set('room-source', { id: 'room-source', name: 'Source', inviteCode: 'SOURCE', sessionSeed: '0' })
    storage.agents.set('room-source', [{
      id: 'row-agent',
      agentId: 'agent-1',
      profile: 'default',
      name: 'OAuth Codex',
      runtime: 'coding_agent',
      codingAgentId: 'codex',
      mode: 'scoped',
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      apiMode: 'codex_responses',
      sessionId: 'legacy-session',
    }])
    storage.saveRoom.mockClear()

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-source/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Rejected Clone', inviteCode: 'CLONE-BAD' }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('does not support OAuth/subscription providers') })
    expect(storage.saveRoom).not.toHaveBeenCalled()
    expect(storage.addRoomAgent).not.toHaveBeenCalled()
    expect(agentClients.createAgent).not.toHaveBeenCalled()
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

  it('preserves mixed-runtime bindings for initial room participants', async () => {
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Mixed Room',
        inviteCode: 'MIXED1',
        agents: [
          { profile: 'default', name: 'Codex A', runtime: 'coding_agent', codingAgentId: 'codex', provider: 'openai', model: 'gpt-5-codex', apiMode: 'codex_responses', reasoningEffort: 'high' },
          { profile: 'default', name: 'Codex B', runtime: 'coding_agent', codingAgentId: 'codex', provider: 'openai', model: 'gpt-5-codex', apiMode: 'codex_responses', reasoningEffort: 'medium' },
          { profile: 'default', name: 'Claude A', runtime: 'coding_agent', codingAgentId: 'claude-code', provider: 'anthropic', model: 'claude-sonnet', apiMode: 'anthropic_messages', reasoningEffort: 'high' },
          { profile: 'default', name: 'Claude B', runtime: 'coding_agent', codingAgentId: 'claude-code', provider: 'anthropic', model: 'claude-sonnet', apiMode: 'anthropic_messages', reasoningEffort: 'medium' },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agents).toHaveLength(4)
    expect(body.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Codex A', runtime: 'coding_agent', codingAgentId: 'codex', apiMode: 'codex_responses', reasoningEffort: 'high' }),
      expect.objectContaining({ name: 'Claude A', runtime: 'coding_agent', codingAgentId: 'claude-code', apiMode: 'anthropic_messages', reasoningEffort: 'high' }),
    ]))
    expect(new Set(body.agents.map((agent: any) => agent.agentId)).size).toBe(4)
    expect(new Set(body.agents.map((agent: any) => agent.sessionId)).size).toBe(4)
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

  it('allows independent participants from the same profile with distinct stable sessions', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [{
      id: 'row-agent',
      agentId: 'agent-1',
      profile: 'default',
      name: 'Agent A',
      runtime: 'hermes',
      sessionId: 'session-a',
    }])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: 'default',
        name: 'Agent B',
        runtime: 'hermes',
        provider: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'high',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agent).toMatchObject({
      profile: 'default',
      name: 'Agent B',
      runtime: 'hermes',
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high',
      sessionGeneration: 0,
    })
    expect(body.agent.agentId).not.toBe('agent-1')
    expect(body.agent.sessionId).toEqual(expect.any(String))
    expect(body.agent.sessionId).not.toBe('session-a')
  })

  it('rejects duplicate participant display names because textual mentions must stay unambiguous', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [{
      id: 'row-agent',
      agentId: 'agent-1',
      profile: 'default',
      name: 'Reviewer',
      runtime: 'hermes',
      sessionId: 'session-a',
    }])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: 'default',
        name: ' reviewer ',
        runtime: 'coding_agent',
        codingAgentId: 'codex',
        provider: 'openai',
        model: 'gpt-5-codex',
        apiMode: 'codex_responses',
      }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'Participant name already exists in this room' })
    expect(agentClients.createAgent).not.toHaveBeenCalled()
  })

  it('validates coding-agent participant bindings before connecting a runtime', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })

    const missingAgent = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'default', name: 'Codex', runtime: 'coding_agent' }),
    })
    expect(missingAgent.status).toBe(400)
    await expect(missingAgent.json()).resolves.toEqual({ error: 'codingAgentId is required for coding_agent participants' })

    const unsupportedAgent = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'default', name: 'Other', runtime: 'coding_agent', codingAgentId: 'other' }),
    })
    expect(unsupportedAgent.status).toBe(400)
    await expect(unsupportedAgent.json()).resolves.toEqual({ error: 'codingAgentId must be claude-code or codex' })

    const incompleteAgent = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'default', name: 'Incomplete Codex', runtime: 'coding_agent', codingAgentId: 'codex' }),
    })
    expect(incompleteAgent.status).toBe(400)
    await expect(incompleteAgent.json()).resolves.toEqual({ error: 'provider, model, and apiMode are required for coding_agent participants' })

    const globalAgent = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'default', name: 'Global Codex', runtime: 'coding_agent', codingAgentId: 'codex', mode: 'global' }),
    })
    expect(globalAgent.status).toBe(400)
    await expect(globalAgent.json()).resolves.toEqual({ error: 'Group Chat coding-agent participants require scoped mode' })
    expect(agentClients.createAgent).not.toHaveBeenCalled()
  })

  it('updates next-run participant settings without changing the stable session binding', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [{
      id: 'row-agent',
      roomId: 'room-1',
      agentId: 'agent-1',
      profile: 'default',
      name: 'Codex',
      description: '',
      invited: 0,
      runtime: 'coding_agent',
      codingAgentId: 'codex',
      sessionId: 'session-stable',
      sessionGeneration: 0,
      mode: 'scoped',
      provider: 'openai',
      model: 'gpt-5',
      apiMode: 'codex_responses',
      reasoningEffort: 'medium',
    }])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/row-agent`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Codex Reviewer', reasoningEffort: 'high' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agent).toMatchObject({
      id: 'row-agent',
      name: 'Codex Reviewer',
      reasoningEffort: 'high',
      sessionId: 'session-stable',
      sessionGeneration: 0,
    })
    expect(storage.updateRoomAgent).toHaveBeenCalledWith('room-1', 'row-agent', {
      name: 'Codex Reviewer',
      description: '',
      mode: 'scoped',
      provider: 'openai',
      model: 'gpt-5',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      avatar: JSON.stringify({ type: 'asset', assetUrl: '/coding-agents/codex-openai.png' }),
    })
    expect(agentClients.updateAgentIdentity).toHaveBeenCalledWith(
      'room-1',
      'agent-1',
      'Codex Reviewer',
      '',
    )
  })

  it('rejects a participant rename that would make textual mentions ambiguous', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [
      { id: 'row-a', roomId: 'room-1', agentId: 'agent-a', profile: 'default', name: 'Reviewer', description: '', runtime: 'hermes', codingAgentId: '', sessionId: 'session-a', sessionGeneration: 0, mode: 'scoped', provider: '', model: '', apiMode: '', reasoningEffort: '' },
      { id: 'row-b', roomId: 'room-1', agentId: 'agent-b', profile: 'default', name: 'Builder', description: '', runtime: 'hermes', codingAgentId: '', sessionId: 'session-b', sessionGeneration: 0, mode: 'scoped', provider: '', model: '', apiMode: '', reasoningEffort: '' },
    ])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/agent-b`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' reviewer ' }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'Participant name already exists in this room' })
    expect(storage.updateRoomAgent).not.toHaveBeenCalled()
  })

  it('clones participant runtime settings but allocates a new stable session', async () => {
    storage.rooms.set('room-source', { id: 'room-source', name: 'Source', inviteCode: 'SOURCE', sessionSeed: '0' })
    storage.agents.set('room-source', [{
      id: 'row-agent',
      roomId: 'room-source',
      agentId: 'agent-1',
      profile: 'default',
      name: 'Claude Review',
      description: 'read-only reviewer',
      invited: 1,
      runtime: 'coding_agent',
      codingAgentId: 'claude-code',
      sessionId: 'source-session',
      sessionGeneration: 3,
      mode: 'scoped',
      provider: 'anthropic',
      model: 'claude-sonnet',
      apiMode: 'anthropic_messages',
      reasoningEffort: 'high',
    }])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-source/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Clone', inviteCode: 'CLONE1' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agents[0]).toMatchObject({
      runtime: 'coding_agent',
      codingAgentId: 'claude-code',
      mode: 'scoped',
      provider: 'anthropic',
      model: 'claude-sonnet',
      apiMode: 'anthropic_messages',
      reasoningEffort: 'high',
      sessionGeneration: 0,
    })
    expect(body.agents[0].sessionId).not.toBe('source-session')
  })

  it('remaps fixed handoff order to cloned participant ids', async () => {
    storage.rooms.set('room-source', {
      id: 'room-source', name: 'Source', inviteCode: 'SOURCE', sessionSeed: '0',
      handoffMode: 'fixed', handoffOrderJson: '["agent-2","agent-1"]',
    })
    storage.agents.set('room-source', [
      { id: 'row-1', roomId: 'room-source', agentId: 'agent-1', profile: 'default', name: 'First', description: '', invited: 1, runtime: 'hermes', codingAgentId: '', mode: 'scoped', provider: 'test-provider', model: 'test-model', apiMode: '', reasoningEffort: '' },
      { id: 'row-2', roomId: 'room-source', agentId: 'agent-2', profile: 'default', name: 'Second', description: '', invited: 1, runtime: 'hermes', codingAgentId: '', mode: 'scoped', provider: 'test-provider', model: 'test-model', apiMode: '', reasoningEffort: '' },
    ])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-source/clone`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Clone', inviteCode: 'CLONE2' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    const byName = new Map(body.agents.map((agent: any) => [agent.name, agent.agentId]))
    expect(body.room.handoffMode).toBe('fixed')
    expect(body.room.handoffOrder).toEqual([byName.get('Second'), byName.get('First')])
    expect(body.room.handoffOrder).not.toContain('agent-1')
    expect(body.room.handoffOrder).not.toContain('agent-2')
  })

  it('removes an agent by row id and disconnects runtime by persisted agent id', async () => {
    const agent = { id: 'row-agent', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: 'Agent' }
    storage.agents.set('room-1', [agent])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/row-agent`, { method: 'DELETE' })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(agentClients.interruptAgent).toHaveBeenCalledWith('room-1', 'agent-1')
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

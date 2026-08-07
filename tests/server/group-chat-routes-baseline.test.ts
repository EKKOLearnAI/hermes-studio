import Koa from 'koa'
import bodyParser from '@koa/bodyparser'
import { createServer, type Server as HttpServer } from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { groupChatPublicRoutes, groupChatRoutes, setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'

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
  let updateRoomName: ReturnType<typeof vi.fn>
  let broadcastRoomAgents: ReturnType<typeof vi.fn>
  let roomSummaryService: any

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
      getMessage: vi.fn((messageId) => [...storage.messages.values()].flat().find((message: any) => message.id === messageId) || null),
      getRoomAgents: vi.fn((roomId) => storage.agents.get(roomId) || []),
      getRoomMembers: vi.fn((roomId) => storage.members.get(roomId) || []),
      getRoomByInviteCode: vi.fn((code) => [...storage.rooms.values()].find((r: any) => r.inviteCode === code)),
      addRoomAgent: vi.fn((roomId, agentId, profile, name, description, invited, metadata = {}) => {
        const row = { id: `row-${agentId}`, roomId, agentId, profile, name, description, invited, ...metadata }
        storage.agents.set(roomId, [...(storage.agents.get(roomId) || []), row])
        return row
      }),
      getRoomAgent: vi.fn((roomId, ref) => (storage.agents.get(roomId) || []).find((a: any) => a.id === ref || a.agentId === ref) || null),
      updateRoomAgent: vi.fn((roomId, ref, profile, name, description, metadata = {}) => {
        const rows = storage.agents.get(roomId) || []
        const row = rows.find((agent: any) => agent.id === ref || agent.agentId === ref)
        if (!row) return null
        Object.assign(row, { profile, name, description, ...metadata })
        return row
      }),
      removeRoomMembersForAgent: vi.fn(),
      removeRoomAgent: vi.fn((roomId, ref) => storage.agents.set(roomId, (storage.agents.get(roomId) || []).filter((a: any) => a.id !== ref && a.agentId !== ref))),
      clearRoomContext: vi.fn((roomId) => { const room = storage.rooms.get(roomId); if (room) Object.assign(room, { totalTokens: 0, sessionSeed: 'rotated' }) }),
      updateRoomConfig: vi.fn((roomId, config) => {
        const room = storage.rooms.get(roomId)
        if (room) Object.assign(room, config)
        return room
      }),
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
    updateRoomName = vi.fn((roomId: string, name: string) => {
      const room = storage.rooms.get(roomId)
      if (room) room.name = name
      return room || null
    })
    broadcastRoomAgents = vi.fn((roomId: string) => storage.getRoomAgents(roomId))
    roomSummaryService = {
      runExclusive: vi.fn(async (_roomId: string, task: () => unknown) => task()),
      getState: vi.fn((roomId: string) => ({
        roomId,
        summary: '',
        summaryThroughMessageId: '',
        summaryThroughMessageTimestamp: 0,
        summarizedTurnCount: 0,
        status: 'idle',
        version: 0,
        updatedAt: 0,
        lastError: null,
      })),
      updateSummaryText: vi.fn(async (roomId: string, summary: string) => ({
        roomId,
        summary,
        summaryThroughMessageId: '',
        summaryThroughMessageTimestamp: 0,
        summarizedTurnCount: 0,
        status: 'success',
        version: 1,
        updatedAt: 10,
        lastError: null,
      })),
    }
    setGroupChatServer({
      getStorage: () => storage,
      getRoomSummaryService: () => roomSummaryService,
      agentClients,
      clearRoomRuntimeState,
      updateRoomName,
      broadcastRoomAgents,
      ensureDefaultRoomWorkspace: (roomId: string, profile: string) => `/managed/group-chat/${profile}/${roomId}`,
    } as any)
    const app = new Koa()
    app.use(bodyParser())
    app.use(groupChatPublicRoutes.routes())
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

  it('resolves invite-only room metadata without exposing management fields', async () => {
    storage.rooms.set('room-1', {
      id: 'room-1',
      name: 'Shared Room',
      inviteCode: 'ROOM1',
      workspace: '/private/workspace',
      summaryProfile: 'default',
    })

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/join/ROOM1`)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      room: {
        id: 'room-1',
        name: 'Shared Room',
        inviteCode: null,
        canManage: false,
        summaryProfile: '',
        summaryProvider: '',
        summaryModel: '',
        summaryApiMode: '',
        summaryEveryTurns: 0,
        totalTokens: 0,
        workspace: '',
      },
    })
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

  it('persists the selected rolling-summary runtime when creating a room', async () => {
    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Summary Room',
        inviteCode: 'SUM123',
        summary: {
          profile: 'research',
          provider: 'openai',
          model: 'gpt-summary',
          apiMode: 'codex_responses',
          everyTurns: 12,
        },
        agents: [],
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(storage.saveRoom).toHaveBeenCalledWith(
      expect.any(String),
      'Summary Room',
      'SUM123',
      expect.objectContaining({
        summaryProfile: 'research',
        summaryProvider: 'openai',
        summaryModel: 'gpt-summary',
        summaryApiMode: 'codex_responses',
        summaryEveryTurns: 12,
      }),
    )
    expect(body.room).toMatchObject({
      summaryProfile: 'research',
      summaryProvider: 'openai',
      summaryModel: 'gpt-summary',
      summaryApiMode: 'codex_responses',
      summaryEveryTurns: 12,
    })
  })

  it('updates summary config, reads its anchor, and manually edits its text', async () => {
    storage.rooms.set('room-1', {
      id: 'room-1',
      name: 'Room',
      inviteCode: 'ROOM1',
      summaryProfile: 'default',
      summaryProvider: 'openai',
      summaryModel: 'old-model',
      summaryApiMode: 'chat_completions',
      summaryEveryTurns: 20,
    })
    storage.messages.set('room-1', [{
      id: 'anchor-1',
      timestamp: 5,
      senderName: 'Agent',
      role: 'assistant',
      content: 'Anchor content',
    }])
    roomSummaryService.getState.mockReturnValue({
      roomId: 'room-1',
      summary: 'Current summary',
      summaryThroughMessageId: 'anchor-1',
      summaryThroughMessageTimestamp: 5,
      summarizedTurnCount: 10,
      status: 'success',
      version: 2,
      updatedAt: 6,
      lastError: null,
    })

    const configRes = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Renamed Room',
        summaryProfile: 'research',
        summaryProvider: 'anthropic',
        summaryModel: 'claude-test',
        summaryApiMode: 'anthropic_messages',
        summaryEveryTurns: 8,
      }),
    })
    expect(configRes.status).toBe(200)
    expect(updateRoomName).toHaveBeenCalledWith('room-1', 'Renamed Room')
    expect(storage.updateRoomConfig).toHaveBeenCalledWith('room-1', {
      summaryProfile: 'research',
      summaryProvider: 'anthropic',
      summaryModel: 'claude-test',
      summaryApiMode: 'anthropic_messages',
      summaryEveryTurns: 8,
    })
    await expect(configRes.json()).resolves.toMatchObject({
      room: { id: 'room-1', name: 'Renamed Room' },
    })

    const getRes = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/summary`)
    await expect(getRes.json()).resolves.toMatchObject({
      summary: {
        summary: 'Current summary',
        summaryThroughMessageId: 'anchor-1',
      },
      anchor: {
        id: 'anchor-1',
        content: 'Anchor content',
      },
    })

    const editRes = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/summary`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'Manually corrected summary' }),
    })
    expect(editRes.status).toBe(200)
    expect(roomSummaryService.updateSummaryText).toHaveBeenCalledWith('room-1', 'Manually corrected summary')
  })

  it('renames a legacy room without requiring summary runtime fields', async () => {
    storage.rooms.set('room-legacy', {
      id: 'room-legacy',
      name: 'Legacy Room',
      inviteCode: 'LEGACY',
      summaryProvider: '',
      summaryModel: '',
    })

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-legacy/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Legacy Room' }),
    })

    expect(res.status).toBe(200)
    expect(updateRoomName).toHaveBeenCalledWith('room-legacy', 'Renamed Legacy Room')
    expect(storage.updateRoomConfig).not.toHaveBeenCalled()
    await expect(res.json()).resolves.toMatchObject({
      room: { id: 'room-legacy', name: 'Renamed Legacy Room' },
    })
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

  it('allows multiple room agents backed by the same profile', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [{ id: 'row-agent', agentId: 'agent-1', profile: 'default', name: 'Agent' }])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'default', name: 'Second Agent' }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      agent: {
        profile: 'default',
        name: 'Second Agent',
      },
    })
    expect(storage.getRoomAgents('room-1')).toHaveLength(2)
  })

  it('persists the selected provider, model, api mode, and reasoning effort for a room agent', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'codex',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'codex_responses',
        reasoningEffort: 'high',
        name: 'Researcher',
        description: 'Finds evidence',
        avatar: JSON.stringify({ type: 'generated', seed: 'researcher-avatar' }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(agentClients.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Researcher',
      description: 'Finds evidence',
    }))
    expect(storage.addRoomAgent).toHaveBeenCalledWith(
      'room-1',
      expect.any(String),
      'research',
      'Researcher',
      'Finds evidence',
      0,
      {
        agent: 'codex',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'codex_responses',
        reasoningEffort: 'high',
        avatar: JSON.stringify({ type: 'generated', seed: 'researcher-avatar' }),
      },
    )
    expect(body.agent).toMatchObject({
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      avatar: JSON.stringify({ type: 'generated', seed: 'researcher-avatar' }),
    })
    expect(broadcastRoomAgents).toHaveBeenCalledWith('room-1')
  })

  it('rejects incomplete or invalid room agent runtime configuration', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })

    const missingModel = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'research', provider: 'openai' }),
    })
    expect(missingModel.status).toBe(400)

    const invalidReasoning = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        reasoningEffort: 'extreme',
      }),
    })
    expect(invalidReasoning.status).toBe(400)

    const missingApiMode = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'codex',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
      }),
    })
    expect(missingApiMode.status).toBe(400)

    const invalidApiMode = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'ekko',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'unsupported',
      }),
    })
    expect(invalidApiMode.status).toBe(400)

    const invalidAgent = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'unknown',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
      }),
    })
    expect(invalidAgent.status).toBe(400)

    const invalidAvatar = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        avatar: JSON.stringify({ type: 'image', dataUrl: 'javascript:alert(1)' }),
      }),
    })
    expect(invalidAvatar.status).toBe(400)
    expect(agentClients.createAgent).not.toHaveBeenCalled()
  })

  it('ignores apiMode for Hermes room agents', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'hermes',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'anthropic_messages',
      }),
    })

    expect(res.status).toBe(200)
    expect(agentClients.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'hermes',
      apiMode: '',
    }))
    expect(storage.addRoomAgent.mock.calls.at(-1)?.[6]).toMatchObject({
      agent: 'hermes',
      apiMode: '',
    })
  })

  it('updates a room agent while preserving its identity and replacing its group runtime', async () => {
    storage.rooms.set('room-1', { id: 'room-1', name: 'Room', inviteCode: 'ROOM1' })
    storage.agents.set('room-1', [{
      id: 'row-agent',
      roomId: 'room-1',
      agentId: 'agent-1',
      agent: 'hermes',
      profile: 'default',
      provider: 'openai',
      model: 'old-model',
      apiMode: '',
      reasoningEffort: '',
      name: 'Worker',
      description: '',
      invited: 0,
    }])

    const res = await fetch(`${baseUrl}/api/hermes/group-chat/rooms/room-1/agents/row-agent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'codex',
        profile: 'research',
        provider: 'openai',
        model: 'new-model',
        apiMode: 'codex_responses',
        reasoningEffort: 'high',
        name: 'Reviewer',
        description: 'Reviews changes',
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(agentClients.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      agent: 'codex',
      profile: 'research',
      model: 'new-model',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Reviewer',
    }))
    expect(agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-1')
    expect(agentClients.addAgentToRoom).toHaveBeenCalled()
    expect(storage.updateRoomAgent).toHaveBeenCalledWith(
      'room-1',
      'row-agent',
      'research',
      'Reviewer',
      'Reviews changes',
      {
        agent: 'codex',
        provider: 'openai',
        model: 'new-model',
        apiMode: 'codex_responses',
        reasoningEffort: 'high',
      },
    )
    expect(body.agent).toMatchObject({
      id: 'row-agent',
      agentId: 'agent-1',
      profile: 'research',
      name: 'Reviewer',
    })
    expect(broadcastRoomAgents).toHaveBeenCalledWith('room-1')
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
    expect(broadcastRoomAgents).toHaveBeenCalledWith('room-1')
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

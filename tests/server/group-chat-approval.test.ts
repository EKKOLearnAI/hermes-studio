import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  currentRoomAgentSessionId,
  createTestGroupChatServer,
  emitAck,
  once,
} from './group-chat-test-helpers'
import { AgentBridgeClient } from '../../packages/server/src/services/hermes/agent-bridge'
import { GROUP_CHAT_AGENT_SOCKET_SECRET } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import type { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

describe('group chat approval and context baseline', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let port: number

  beforeEach(async () => {
    vi.clearAllMocks()
    harness = await createTestGroupChatServer()
    groupServer = harness.groupServer
    port = harness.port
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    groupServer.getStorage().addRoomAgent('room-1', 'agent-1', 'default', 'Agent', '', 0)
  })

  afterEach(() => {
    harness?.cleanup()
  })

  async function joinPair() {
    const agent = await connectGroupChatClient(port, 'agent-1', 'Agent', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    const human = await connectGroupChatClient(port, 'human-1', 'Human')
    harness.sockets.push(agent, human)
    await emitAck(agent, 'join', { roomId: 'room-1' })
    await emitAck(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    const agentSessionId = currentRoomAgentSessionId(groupServer, 'room-1', 'agent-1', 'default', 'Agent')
    return { agent, human, agentSessionId }
  }

  function wait(ms = 30) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function replaceLocalCapabilities(socketId: string, capabilities: string[]): void {
    const localSubjectId = (groupServer as any).socketLocalSubjectIdMap.get(socketId)
    const actor = groupServer.getStorage().findActiveActorByLocalSubjectId('room-1', localSubjectId)
    if (!actor) throw new Error('missing local actor')
    harness.db.prepare('DELETE FROM gc_room_actor_capabilities WHERE actorId = ?').run(actor.id)
    const insert = harness.db.prepare(`
      INSERT INTO gc_room_actor_capabilities (id, roomId, actorId, capability, active, createdAt, updatedAt)
      VALUES (?, 'room-1', ?, ?, 1, ?, ?)
    `)
    capabilities.forEach((capability, index) => {
      const now = Date.now()
      insert.run(`test-cap-${actor.id}-${index}`, actor.id, capability, now, now)
    })
    harness.db.prepare(`
      UPDATE gc_room_actors
      SET authorizationRevision = authorizationRevision + 1
      WHERE id = ?
    `).run(actor.id)
  }

  it('relays context status and updates room token count', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const statusEvent = once<any>(human, 'context_status')
    const roomUpdated = once<any>(human, 'room_updated')

    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', totalTokens: 123, agentSessionId })

    expect(await statusEvent).toEqual({ roomId: 'room-1', agentId: 'agent-1', agentName: 'Agent', status: 'replying' })
    expect(await roomUpdated).toEqual({ roomId: 'room-1', totalTokens: 123 })
    expect(groupServer.getStorage().getRoom('room-1')).toMatchObject({ totalTokens: 123 })
  })

  it('ignores context status emitted by human sockets', async () => {
    const { human } = await joinPair()

    human.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', totalTokens: 999 })
    await wait()

    expect(groupServer.getStorage().getRoom('room-1')).toMatchObject({ totalTokens: 0 })
    const lateJoiner = await connectGroupChatClient(port, 'human-2', 'Late')
    harness.sockets.push(lateJoiner)
    const joined = await emitAck<any>(lateJoiner, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    expect(joined.contextStatuses).toEqual([])
  })

  it('clears ready context status from join recovery', async () => {
    const { agent, agentSessionId } = await joinPair()
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', agentSessionId })
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'ready', agentSessionId })

    const lateJoiner = await connectGroupChatClient(port, 'human-2', 'Late')
    harness.sockets.push(lateJoiner)
    const joined = await emitAck<any>(lateJoiner, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    expect(joined.contextStatuses).toEqual([])
  })

  it('relays approval requested with default choices', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const requested = once<any>(human, 'approval.requested')

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-1',
      command: 'touch file',
      description: 'needs approval',
    })

    expect(await requested).toMatchObject({
      event: 'approval.requested',
      roomId: 'room-1',
      agentName: 'Agent',
      approval_id: 'approval-1',
      choices: ['once', 'session', 'deny'],
    })
  })

  it('rejects an approval event whose durable handoff lease is not current', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    let requested = 0
    human.on('approval.requested', () => { requested += 1 })

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      sourceHandoffJobId: 'missing-job',
      sourceHandoffLeaseToken: 'stale-lease',
      approval_id: 'approval-stale-job',
      command: 'touch file',
    })
    await wait()

    expect(requested).toBe(0)
  })

  it('rejects an approval event that omits provenance while its durable handoff is running', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    await emitAck(human, 'message', { roomId: 'room-1', id: 'approval-durable-trigger', content: '@Agent run' })
    const running = groupServer.getStorage().claimHandoffJobs('test-dispatcher', Date.now(), 1, 60_000)[0]
    expect(running).toMatchObject({ targetAgentId: 'agent-1', status: 'running' })

    let requested = 0
    human.on('approval.requested', () => { requested += 1 })
    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-missing-provenance',
      command: 'touch file',
    })
    await wait()

    expect(requested).toBe(0)
  })

  it('delivers approval requested and resolved once to every authorized socket for one persisted subject', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const identity = await once<{ localCredential: string }>(human, 'local_identity')
    const second = await connectGroupChatClient(port, 'human-second-tab', 'Human second tab', {
      localCredential: identity.localCredential,
    })
    harness.sockets.push(second)
    await emitAck(second, 'join', { roomId: 'room-1' })

    let firstRequestedCount = 0
    let secondRequestedCount = 0
    let firstResolvedCount = 0
    let secondResolvedCount = 0
    human.on('approval.requested', () => { firstRequestedCount += 1 })
    second.on('approval.requested', () => { secondRequestedCount += 1 })
    human.on('approval.resolved', () => { firstResolvedCount += 1 })
    second.on('approval.resolved', () => { secondResolvedCount += 1 })
    const firstRequested = once<any>(human, 'approval.requested')
    const secondRequested = once<any>(second, 'approval.requested')

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-multi-socket',
      command: 'touch file',
    })
    expect((await firstRequested).approval_id).toBe('approval-multi-socket')
    expect((await secondRequested).approval_id).toBe('approval-multi-socket')

    const firstResolved = once<any>(human, 'approval.resolved')
    const secondResolved = once<any>(second, 'approval.resolved')
    agent.emit('approval.resolved', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-multi-socket',
      choice: 'deny',
    })
    expect((await firstResolved).approval_id).toBe('approval-multi-socket')
    expect((await secondResolved).approval_id).toBe('approval-multi-socket')
    await wait()
    expect([firstRequestedCount, secondRequestedCount, firstResolvedCount, secondResolvedCount]).toEqual([1, 1, 1, 1])

    replaceLocalCapabilities(human.id!, ['room.read'])
    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-after-revocation',
      command: 'cat secret',
    })
    await wait()
    expect([firstRequestedCount, secondRequestedCount]).toEqual([1, 1])
  })

  it('routes approval payloads by approval.respond rather than room.manage', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const managerOnly = await connectGroupChatClient(port, 'manager-only', 'ManagerOnly')
    harness.sockets.push(managerOnly)
    await emitAck(managerOnly, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    replaceLocalCapabilities(human.id!, ['room.read', 'approval.respond'])
    replaceLocalCapabilities(managerOnly.id!, ['room.read', 'room.manage'])
    const requested = once<any>(human, 'approval.requested')
    let managerLeak: unknown = null
    managerOnly.on('approval.requested', payload => { managerLeak = payload })

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-capability-split',
      command: 'touch file',
    })

    expect(await requested).toMatchObject({ approval_id: 'approval-capability-split' })
    await wait()
    expect(managerLeak).toBeNull()
  })

  it('does not relay approval payloads to read-only invite members', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const readonly = await connectGroupChatClient(port, 'human-readonly', 'ReadOnly')
    harness.sockets.push(readonly)
    await emitAck(readonly, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    replaceLocalCapabilities(readonly.id!, ['room.read'])

    let leaked: unknown = null
    readonly.on('approval.requested', payload => { leaked = payload })
    const managerRequest = once<any>(human, 'approval.requested')

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-private',
      command: 'cat /private/workspace/secret',
      description: 'needs approval',
    })

    expect(await managerRequest).toMatchObject({ approval_id: 'approval-private' })
    await wait()
    expect(leaked).toBeNull()
  })

  it('ignores approval events emitted by human sockets', async () => {
    const { human } = await joinPair()
    let requested = false
    let resolved = false
    human.on('approval.requested', () => { requested = true })
    human.on('approval.resolved', () => { resolved = true })

    human.emit('approval.requested', { roomId: 'room-1', agentName: 'Agent', approval_id: 'approval-human' })
    human.emit('approval.resolved', { roomId: 'room-1', agentName: 'Agent', approval_id: 'approval-human', choice: 'deny' })
    await wait()

    expect(requested).toBe(false)
    expect(resolved).toBe(false)
  })

  it('relays approval resolved with normalized choice', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const requested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-1',
      command: 'touch file',
    })
    await requested
    const resolved = once<any>(human, 'approval.resolved')

    agent.emit('approval.resolved', { roomId: 'room-1', agentName: 'Agent', agentSessionId, approval_id: 'approval-1', choice: 'deny' })

    expect(await resolved).toEqual({
      event: 'approval.resolved',
      roomId: 'room-1',
      agentName: 'Agent',
      approval_id: 'approval-1',
      choice: 'deny',
    })
  })

  it('forwards a response only for the room-bound authorized approval id', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const requested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-bound',
      command: 'touch file',
    })
    await requested
    const approvalRespond = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond').mockResolvedValue({ resolved: true } as any)

    try {
      await expect(emitAck(human, 'approval.respond', {
        roomId: 'room-1',
        approval_id: 'approval-bound',
        choice: 'once',
      })).resolves.toEqual({ ok: true, resolved: true })
      expect(approvalRespond).toHaveBeenCalledWith('approval-bound', 'once')
    } finally {
      approvalRespond.mockRestore()
    }
  })

  it('keeps an unresolved Bridge approval pending and allows a later retry', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const requested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-retryable',
      command: 'touch file',
    })
    await requested
    const approvalRespond = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond')
      .mockResolvedValueOnce({ resolved: false } as any)
      .mockResolvedValueOnce({ resolved: true } as any)

    try {
      await expect(emitAck(human, 'approval.respond', {
        roomId: 'room-1',
        approval_id: 'approval-retryable',
        choice: 'once',
      })).resolves.toEqual({ error: 'Approval response was not resolved', resolved: false })
      expect((groupServer as any).pendingApprovals.get('approval-retryable')).toMatchObject({
        responding: false,
        responded: false,
      })

      await expect(emitAck(human, 'approval.respond', {
        roomId: 'room-1',
        approval_id: 'approval-retryable',
        choice: 'once',
      })).resolves.toEqual({ ok: true, resolved: true })
      expect(approvalRespond).toHaveBeenCalledTimes(2)
    } finally {
      approvalRespond.mockRestore()
    }
  })

  it('rejects a raw permanent response when the bound request disallows permanent approval', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const requested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-no-permanent',
      command: 'touch file',
      choices: ['once', 'session', 'always', 'deny'],
      allow_permanent: false,
    })
    expect(await requested).toMatchObject({
      approval_id: 'approval-no-permanent',
      choices: ['once', 'session', 'deny'],
      allow_permanent: false,
    })
    const approvalRespond = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond').mockResolvedValue({ resolved: true } as any)

    try {
      await expect(emitAck(human, 'approval.respond', {
        roomId: 'room-1',
        approval_id: 'approval-no-permanent',
        choice: 'always',
      })).resolves.toEqual({ error: 'Access denied' })
      expect(approvalRespond).not.toHaveBeenCalled()

      await expect(emitAck(human, 'approval.respond', {
        roomId: 'room-1',
        approval_id: 'approval-no-permanent',
        choice: 'once',
      })).resolves.toEqual({ ok: true, resolved: true })
      expect(approvalRespond).toHaveBeenCalledOnce()
      expect(approvalRespond).toHaveBeenCalledWith('approval-no-permanent', 'once')
    } finally {
      approvalRespond.mockRestore()
    }
  })

  it('evicts and rejects a responder that retains approval.respond after losing room.read', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const requested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-after-read-revocation',
      command: 'cat private-file',
    })
    await requested
    replaceLocalCapabilities(human.id!, ['approval.respond'])
    const approvalRespond = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond').mockResolvedValue({ resolved: true } as any)

    try {
      await expect(emitAck(human, 'approval.respond', {
        roomId: 'room-1',
        approval_id: 'approval-after-read-revocation',
        choice: 'once',
      })).resolves.toEqual({ error: 'Access denied' })
      expect(approvalRespond).not.toHaveBeenCalled()
      const room = (groupServer as any).rooms.get('room-1')
      expect(room.hasOnlineMember(human.id!)).toBe(false)
      expect((groupServer as any).nsp.adapter.rooms.get('room-1')?.has(human.id!)).not.toBe(true)
    } finally {
      approvalRespond.mockRestore()
    }
  })

  it('rejects approval responses whose id was not bound by an authorized agent event', async () => {
    const { human } = await joinPair()
    const approvalRespond = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond').mockResolvedValue({ resolved: true } as any)

    try {
      await expect(emitAck(human, 'approval.respond', {
        roomId: 'room-1',
        approval_id: 'approval-from-another-room',
        choice: 'allow',
      })).resolves.toEqual({ error: 'Access denied' })
      expect(approvalRespond).not.toHaveBeenCalled()
    } finally {
      approvalRespond.mockRestore()
    }
  })

  it('rejects a valid approval id when the responder supplies a different authorized room', async () => {
    const { human } = await joinPair()
    groupServer.getStorage().saveRoom('room-2', 'Room 2', 'ROOM2')
    groupServer.getStorage().addRoomAgent('room-2', 'agent-2', 'default', 'AgentTwo', '', 0)
    const agentTwo = await connectGroupChatClient(port, 'agent-2', 'AgentTwo', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(agentTwo)
    await emitAck(agentTwo, 'join', { roomId: 'room-2' })
    const agentTwoSessionId = currentRoomAgentSessionId(groupServer, 'room-2', 'agent-2', 'default', 'AgentTwo')
    agentTwo.emit('approval.requested', {
      roomId: 'room-2',
      agentName: 'AgentTwo',
      agentSessionId: agentTwoSessionId,
      approval_id: 'approval-room-2',
      command: 'cat secret',
    })
    await wait()
    const approvalRespond = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond').mockResolvedValue({ resolved: true } as any)

    try {
      await expect(emitAck(human, 'approval.respond', {
        roomId: 'room-1',
        approval_id: 'approval-room-2',
        choice: 'once',
      })).resolves.toEqual({ error: 'Access denied' })
      expect(approvalRespond).not.toHaveBeenCalled()
    } finally {
      approvalRespond.mockRestore()
    }
  })

  it('poisons a globally colliding approval id across rooms and never calls Bridge', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const requested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-collision',
      command: 'touch room-a',
    })
    await requested

    groupServer.getStorage().saveRoom('room-2', 'Room 2', 'ROOM2')
    groupServer.getStorage().addRoomAgent('room-2', 'agent-2', 'default', 'AgentTwo', '', 0)
    const agentTwo = await connectGroupChatClient(port, 'agent-2', 'AgentTwo', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(agentTwo)
    await emitAck(agentTwo, 'join', { roomId: 'room-2' })
    const agentTwoSessionId = currentRoomAgentSessionId(groupServer, 'room-2', 'agent-2', 'default', 'AgentTwo')
    agentTwo.emit('approval.requested', {
      roomId: 'room-2',
      agentName: 'AgentTwo',
      agentSessionId: agentTwoSessionId,
      approval_id: 'approval-collision',
      command: 'cat room-b',
    })
    await wait()

    // Neither a matching resolved event nor room-local cleanup may make a globally
    // conflicted Bridge id usable again.
    agent.emit('approval.resolved', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-collision',
      choice: 'deny',
    })
    await wait()
    const approvalRespond = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond').mockResolvedValue({ resolved: true } as any)

    try {
      await expect(emitAck(human, 'approval.respond', {
        roomId: 'room-1',
        approval_id: 'approval-collision',
        choice: 'once',
      })).resolves.toEqual({ error: 'Access denied' })
      expect(approvalRespond).not.toHaveBeenCalled()
    } finally {
      approvalRespond.mockRestore()
    }
  })

  it('suppresses a same-origin duplicate without poisoning the approval id', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const request = {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-duplicate',
      command: 'touch once',
    }
    const requested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', request)
    await requested
    agent.emit('approval.requested', request)
    await wait()
    const approvalRespond = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond').mockResolvedValue({ resolved: true } as any)

    try {
      await expect(emitAck(human, 'approval.respond', {
        roomId: 'room-1',
        approval_id: 'approval-duplicate',
        choice: 'once',
      })).resolves.toEqual({ ok: true, resolved: true })
      expect(approvalRespond).toHaveBeenCalledOnce()
    } finally {
      approvalRespond.mockRestore()
    }
  })

  it('rejects approval responses from sockets that have not joined the room', async () => {
    const outsider = await connectGroupChatClient(port, 'outsider', 'Outsider')
    harness.sockets.push(outsider)

    await expect(emitAck(outsider, 'approval.respond', { roomId: 'room-1', approval_id: 'approval-1', choice: 'deny' })).resolves.toEqual({ error: 'Not in room' })
  })

  it('rejects approval responses from read-only invite members', async () => {
    const { human } = await joinPair()
    const readonly = await connectGroupChatClient(port, 'human-readonly', 'ReadOnly')
    harness.sockets.push(readonly)
    await emitAck(readonly, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    replaceLocalCapabilities(readonly.id!, ['room.read'])

    await expect(emitAck(readonly, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-1',
      choice: 'deny',
    })).resolves.toEqual({ error: 'Access denied' })

    human.disconnect()
  })

  it('rechecks authorization before finalizing runtime clear after interruption', async () => {
    const { human } = await joinPair()
    let resolveInterrupt!: () => void
    const interruptGate = new Promise<void>((resolve) => { resolveInterrupt = resolve })
    const agentClients = (groupServer as any).agentClients
    const interruptPersistedRoom = vi.spyOn(agentClients, 'interruptPersistedRoom').mockReturnValue(interruptGate)
    const resetRoomContext = vi.spyOn(agentClients, 'resetRoomContext')
    const typingTimer = setTimeout(() => {}, 60_000)
    ;(groupServer as any).typingState.set('room-1', new Map([['human-1', { userName: 'Human', timer: typingTimer }]]))
    ;(groupServer as any).contextStatusState.set('room-1', new Map([['Agent', { agentName: 'Agent', status: 'replying' }]]))
    ;(groupServer as any).pendingApprovals.set('approval-preserved', {
      roomId: 'room-1',
      agentId: 'agent-1',
      agentSessionId: 'session-1',
      allowedChoices: ['deny'],
      allowPermanent: false,
      responding: false,
      responded: false,
      conflicted: false,
    })
    let cleared = false
    human.on('room_cleared', () => { cleared = true })
    let authorized = true

    try {
      const clearing = groupServer.clearRoomRuntimeState('room-1', () => {
        if (!authorized) throw new Error('authorization revoked')
      })
      await vi.waitFor(() => expect(interruptPersistedRoom).toHaveBeenCalledWith('room-1'))
      authorized = false
      resolveInterrupt()

      await expect(clearing).rejects.toThrow('authorization revoked')
      expect(resetRoomContext).not.toHaveBeenCalled()
      expect(cleared).toBe(false)
      expect((groupServer as any).typingState.has('room-1')).toBe(true)
      expect((groupServer as any).contextStatusState.has('room-1')).toBe(true)
      expect((groupServer as any).pendingApprovals.has('approval-preserved')).toBe(true)
      expect((groupServer as any).fencedRoomAgentSessions?.has('room-1')).not.toBe(true)
    } finally {
      clearTimeout(typingTimer)
      ;(groupServer as any).typingState.delete('room-1')
      ;(groupServer as any).contextStatusState.delete('room-1')
      ;(groupServer as any).pendingApprovals.delete('approval-preserved')
      interruptPersistedRoom.mockRestore()
      resetRoomContext.mockRestore()
    }
  })

  it('stops persisted unconnected Coding Agent runtimes before disconnecting room state', async () => {
    groupServer.getStorage().addRoomAgent('room-1', 'participant-codex', 'default', 'Codex', '', 0, {
      runtime: 'coding_agent',
      codingAgentId: 'codex',
      sessionId: 'session-stale',
      mode: 'scoped',
    })
    const agentClients = (groupServer as any).agentClients
    const interruptHandoffTarget = vi.spyOn(agentClients, 'interruptHandoffTarget').mockResolvedValue(undefined)
    const disconnectRoom = vi.spyOn(agentClients, 'disconnectRoom')

    try {
      const finalize = await groupServer.deleteRoomRuntimeState('room-1', () => {})
      finalize(true)

      expect(interruptHandoffTarget).toHaveBeenCalledWith('room-1', 'participant-codex', 'session-stale')
      expect(disconnectRoom).toHaveBeenCalledWith('room-1')
    } finally {
      interruptHandoffTarget.mockRestore()
      disconnectRoom.mockRestore()
    }
  })

  it('rejects participant binding drift between runtime synchronization and the deletion transaction', async () => {
    const storage = groupServer.getStorage()
    storage.addRoomAgent('room-1', 'participant-codex', 'default', 'Codex', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'session-before-stop', mode: 'scoped',
    })
    const deletionGuard = storage.captureRoomDeletionGuard('room-1')
    let resolveInterrupt!: () => void
    const interruptGate = new Promise<void>((resolve) => { resolveInterrupt = resolve })
    const agentClients = (groupServer as any).agentClients
    const interruptHandoffTarget = vi.spyOn(agentClients, 'interruptHandoffTarget').mockReturnValue(interruptGate)
    let finalize: ((committed: boolean) => void) | undefined

    try {
      const deleting = groupServer.deleteRoomRuntimeState('room-1', () => {})
      await vi.waitFor(() => expect(interruptHandoffTarget).toHaveBeenCalledWith(
        'room-1', 'participant-codex', 'session-before-stop',
      ))
      storage.addRoomAgent('room-1', 'participant-claude', 'default', 'Claude', '', 0, {
        runtime: 'coding_agent', codingAgentId: 'claude-code', sessionId: 'session-added-during-stop', mode: 'scoped',
      })
      resolveInterrupt()
      finalize = await deleting

      expect((agentClients as any)._pausedRooms.has('room-1')).toBe(true)
      expect(() => storage.deleteRoom('room-1', deletionGuard)).toThrow(/runtime identity changed/i)
      expect(storage.getRoom('room-1')).toMatchObject({ id: 'room-1' })
      expect(storage.getRoomAgentByAgentId('room-1', 'participant-claude')).toMatchObject({
        sessionId: 'session-added-during-stop',
      })
    } finally {
      finalize?.(false)
      expect((agentClients as any)._pausedRooms.has('room-1')).toBe(false)
      interruptHandoffTarget.mockRestore()
    }
  })

  it('fails closed before disconnecting room state when a persisted Runtime cannot synchronize', async () => {
    groupServer.getStorage().addRoomAgent('room-1', 'participant-claude', 'default', 'Claude', '', 0, {
      runtime: 'coding_agent',
      codingAgentId: 'claude-code',
      sessionId: 'session-live',
      mode: 'scoped',
    })
    const agentClients = (groupServer as any).agentClients
    const interruptHandoffTarget = vi.spyOn(agentClients, 'interruptHandoffTarget')
      .mockRejectedValue(new Error('runtime interrupt did not synchronize'))
    const disconnectRoom = vi.spyOn(agentClients, 'disconnectRoom')

    try {
      await expect(groupServer.deleteRoomRuntimeState('room-1', () => {}))
        .rejects.toThrow(/synchronized|interrupt/i)
      expect(interruptHandoffTarget).toHaveBeenCalledWith('room-1', 'participant-claude', 'session-live')
      expect(disconnectRoom).not.toHaveBeenCalled()
      expect(groupServer.getStorage().getRoom('room-1')).toMatchObject({ id: 'room-1' })
      expect((groupServer as any).fencedRoomAgentSessions?.has('room-1')).not.toBe(true)
    } finally {
      interruptHandoffTarget.mockRestore()
      disconnectRoom.mockRestore()
    }
  })

  it('rechecks authorization before disconnecting runtime room state after interruption', async () => {
    await joinPair()
    let resolveInterrupt!: () => void
    const interruptGate = new Promise<void>((resolve) => { resolveInterrupt = resolve })
    const agentClients = (groupServer as any).agentClients
    const interruptPersistedRoom = vi.spyOn(agentClients, 'interruptPersistedRoom').mockReturnValue(interruptGate)
    const disconnectRoom = vi.spyOn(agentClients, 'disconnectRoom')
    ;(groupServer as any).contextStatusState.set('room-1', new Map([['Agent', { agentName: 'Agent', status: 'replying' }]]))
    let authorized = true

    try {
      const deleting = groupServer.deleteRoomRuntimeState('room-1', () => {
        if (!authorized) throw new Error('authorization revoked')
      })
      await vi.waitFor(() => expect(interruptPersistedRoom).toHaveBeenCalledWith('room-1'))
      authorized = false
      resolveInterrupt()

      await expect(deleting).rejects.toThrow('authorization revoked')
      expect(disconnectRoom).not.toHaveBeenCalled()
      expect((groupServer as any).rooms.has('room-1')).toBe(true)
      expect((groupServer as any).contextStatusState.has('room-1')).toBe(true)
      expect((groupServer as any).fencedRoomAgentSessions?.has('room-1')).not.toBe(true)
    } finally {
      ;(groupServer as any).contextStatusState.delete('room-1')
      interruptPersistedRoom.mockRestore()
      disconnectRoom.mockRestore()
    }
  })

  it('emits room_cleared and room_updated when runtime state is cleared', async () => {
    const { human } = await joinPair()
    const interrupt = vi.spyOn(AgentBridgeClient.prototype, 'interrupt').mockResolvedValue({ synced: true } as any)
    const cleared = once<any>(human, 'room_cleared')
    const updated = once<any>(human, 'room_updated')

    try {
      void groupServer.clearRoomRuntimeState('room-1', () => {}).then(finalize => finalize(true))

      expect(await cleared).toEqual({ roomId: 'room-1', totalTokens: 0 })
      expect(await updated).toEqual({ roomId: 'room-1', totalTokens: 0 })
    } finally {
      interrupt.mockRestore()
    }
  })
})

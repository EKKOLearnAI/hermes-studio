import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
  once,
} from './group-chat-test-helpers'
import { GROUP_CHAT_AGENT_SOCKET_SECRET, groupRuntimeSessionId } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import { AgentBridgeClient } from '../../packages/server/src/services/hermes/agent-bridge'
import {
  denyPendingEkkoToolApprovals,
  waitForEkkoToolApproval,
} from '../../packages/server/src/services/ekko-agent/approvals'
import {
  cancelPendingEkkoClarifications,
  waitForEkkoClarification,
} from '../../packages/server/src/services/ekko-agent/clarifications'
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
    vi.spyOn(groupServer.agentClients, 'agentSessionIsCurrent').mockReturnValue(true)
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    groupServer.getStorage().addRoomAgent('room-1', 'agent-1', 'default', 'Agent', '', 0)
  })

  afterEach(() => {
    denyPendingEkkoToolApprovals()
    cancelPendingEkkoClarifications()
    harness?.cleanup()
    vi.restoreAllMocks()
  })

  async function joinPair() {
    const agentSessionId = groupRuntimeSessionId('room-1', 'default', 'Agent')
    const agent = await connectGroupChatClient(port, 'agent-1', 'Agent', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    const human = await connectGroupChatClient(port, 'human-1', 'Human')
    harness.sockets.push(agent, human)
    await emitAck(agent, 'join', { roomId: 'room-1' })
    await emitAck(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    return { agent, human, agentSessionId }
  }

  function wait(ms = 30) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  it('relays context status and updates room token count', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const statusEvent = once<any>(human, 'context_status')
    const roomUpdated = once<any>(human, 'room_updated')

    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', totalTokens: 123, agentSessionId })

    expect(await statusEvent).toEqual({ roomId: 'room-1', agentName: 'Agent', status: 'replying' })
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

  it('accepts the matching ready event after a fresh runtime session is disposed', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const replying = once<any>(human, 'context_status')
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', agentSessionId })
    await expect(replying).resolves.toMatchObject({ agentName: 'Agent', status: 'replying' })

    // Fresh group runs are removed from AgentClients immediately after they
    // emit ready. The terminal status must still be matched against the
    // session that created the stored replying state.
    vi.mocked(groupServer.agentClients.agentSessionIsCurrent).mockReturnValue(false)
    const ready = once<any>(human, 'context_status')
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'ready', agentSessionId })
    await expect(ready).resolves.toMatchObject({ agentName: 'Agent', status: 'ready' })

    const lateJoiner = await connectGroupChatClient(port, 'human-2', 'Late')
    harness.sockets.push(lateJoiner)
    const joined = await emitAck<any>(lateJoiner, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    expect(joined.contextStatuses).toEqual([])
  })

  it('does not let a late ready event clear a newer fresh run', async () => {
    const { agent, agentSessionId: firstSessionId } = await joinPair()
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', agentSessionId: firstSessionId })
    await wait()

    const secondSessionId = groupRuntimeSessionId('room-1', 'default', 'Agent')
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', agentSessionId: secondSessionId })
    await wait()

    vi.mocked(groupServer.agentClients.agentSessionIsCurrent).mockReturnValue(false)
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'ready', agentSessionId: firstSessionId })
    await wait()

    const lateJoiner = await connectGroupChatClient(port, 'human-2', 'Late')
    harness.sockets.push(lateJoiner)
    const joined = await emitAck<any>(lateJoiner, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    expect(joined.contextStatuses).toEqual([
      expect.objectContaining({ agentName: 'Agent', status: 'replying' }),
    ])
  })

  it('delivers and handles approval globally for a manager who has not joined the source room', async () => {
    const agentSessionId = groupRuntimeSessionId('room-1', 'default', 'Agent')
    const agent = await connectGroupChatClient(port, 'agent-1', 'Agent', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    const manager = await connectGroupChatClient(port, 'manager-1', 'Manager')
    harness.sockets.push(agent, manager)
    await emitAck(agent, 'join', { roomId: 'room-1' })
    groupServer.getStorage().addRoomMember('room-1', 'manager-1', 'Manager', '')
    groupServer.getIO().of('/group-chat').sockets.get(manager.id!)!.data.authUser = {
      id: 1, role: 'super_admin', profiles: ['default'],
    }

    const approval = waitForEkkoToolApproval({
      approvalId: 'approval-global',
      toolName: 'terminal_exec',
      key: 'terminal:write',
      command: 'touch global.txt',
      description: 'writes a file',
      choices: ['once', 'deny'],
      allowPermanent: false,
      timeoutMs: 300_000,
    }, {
      sessionId: agentSessionId,
      onRequested: pending => agent.emit('approval.requested', {
        roomId: 'room-1',
        agentName: 'Agent',
        agentSessionId,
        approval_id: pending.approvalId,
        command: pending.command,
        description: pending.description,
        choices: pending.choices,
      }),
    })

    await expect(once<any>(manager, 'approval.requested')).resolves.toMatchObject({
      roomId: 'room-1',
      approval_id: 'approval-global',
    })
    await expect(emitAck(manager, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-global',
      choice: 'once',
    })).resolves.toEqual({ ok: true, resolved: true })
    await expect(approval).resolves.toBe('once')
  })

  it('does not expose or resolve approvals for a non-member socket when authentication is disabled', async () => {
    const agentSessionId = groupRuntimeSessionId('room-1', 'default', 'Agent')
    const agent = await connectGroupChatClient(port, 'agent-1', 'Agent', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    const manager = await connectGroupChatClient(port, 'manager-1', 'Manager')
    const stranger = await connectGroupChatClient(port, 'stranger-1', 'Stranger')
    harness.sockets.push(agent, manager, stranger)
    await emitAck(agent, 'join', { roomId: 'room-1' })
    groupServer.getStorage().addRoomMember('room-1', 'manager-1', 'Manager', '')
    await emitAck(manager, 'join', { roomId: 'room-1' })

    let leaked: unknown = null
    stranger.on('approval.requested', payload => { leaked = payload })
    const managerRequest = once<any>(manager, 'approval.requested')
    const approval = waitForEkkoToolApproval({
      approvalId: 'approval-private-global',
      toolName: 'terminal_exec',
      key: 'terminal:write',
      command: 'cat /private/workspace/secret',
      description: 'reads a private file',
      choices: ['once', 'deny'],
      allowPermanent: false,
      timeoutMs: 300_000,
    }, {
      sessionId: agentSessionId,
      onRequested: pending => agent.emit('approval.requested', {
        roomId: 'room-1',
        agentName: 'Agent',
        agentSessionId,
        approval_id: pending.approvalId,
        command: pending.command,
        description: pending.description,
        choices: pending.choices,
      }),
    })

    await expect(managerRequest).resolves.toMatchObject({ approval_id: 'approval-private-global' })
    await wait()
    expect(leaked).toBeNull()
    await expect(emitAck(stranger, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-private-global',
      choice: 'once',
    })).resolves.toEqual({ error: 'Access denied' })
    await expect(emitAck(manager, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-private-global',
      choice: 'deny',
    })).resolves.toEqual({ ok: true, resolved: true })
    await expect(approval).resolves.toBe('deny')
  })

  it('does not trust a claimed persisted member identity for off-room approvals when authentication is disabled', async () => {
    const agentSessionId = groupRuntimeSessionId('room-1', 'default', 'Agent')
    const agent = await connectGroupChatClient(port, 'agent-1', 'Agent', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    const impostor = await connectGroupChatClient(port, 'manager-1', 'Impostor')
    harness.sockets.push(agent, impostor)
    await emitAck(agent, 'join', { roomId: 'room-1' })
    groupServer.getStorage().addRoomMember('room-1', 'manager-1', 'Manager', '')

    let leaked: unknown = null
    impostor.on('approval.requested', payload => { leaked = payload })
    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-impersonation',
      command: 'cat /private/workspace/secret',
      description: 'reads a private file',
    })
    await wait()

    expect(leaked).toBeNull()
    await expect(emitAck(impostor, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-impersonation',
      choice: 'once',
    })).resolves.toEqual({ error: 'Access denied' })
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

  it('does not relay approval payloads to read-only invite members', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const readonly = await connectGroupChatClient(port, 'human-readonly', 'ReadOnly')
    harness.sockets.push(readonly)
    groupServer.getIO().of('/group-chat').sockets.get(readonly.id!)!.data.authUser = { id: 7, role: 'user', profiles: [] }
    await emitAck(readonly, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

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

  it('relays and routes a clarification response to the pending Ekko Agent session', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const requested = once<any>(human, 'clarify.requested')
    const clarification = waitForEkkoClarification({
      clarifyId: 'clarify-ekko',
      question: 'Which environment?',
      choices: ['staging', 'production'],
      timeoutMs: 300_000,
    }, {
      sessionId: agentSessionId,
      onRequested: pending => agent.emit('clarify.requested', {
        roomId: 'room-1',
        agentName: 'Agent',
        agentSessionId,
        clarify_id: pending.clarifyId,
        question: pending.question,
        choices: pending.choices,
        timeout_ms: pending.timeoutMs,
      }),
    })

    await expect(requested).resolves.toMatchObject({
      event: 'clarify.requested', roomId: 'room-1', agentName: 'Agent',
      clarify_id: 'clarify-ekko', question: 'Which environment?',
    })
    await expect(emitAck(human, 'clarify.respond', {
      roomId: 'room-1', clarify_id: 'clarify-ekko', response: 'staging',
    })).resolves.toEqual({ ok: true, resolved: true })
    await expect(clarification).resolves.toBe('staging')
  })

  it('routes a clarification response to the Hermes bridge', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const bridgeClarify = vi.spyOn(AgentBridgeClient.prototype, 'clarifyRespond')
      .mockResolvedValue({ resolved: true } as any)
    const requested = once<any>(human, 'clarify.requested')
    agent.emit('clarify.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId,
      clarify_id: 'clarify-hermes', question: 'Continue?', choices: null, timeout_ms: 300_000,
    })

    await expect(requested).resolves.toMatchObject({ clarify_id: 'clarify-hermes', question: 'Continue?' })
    await expect(emitAck(human, 'clarify.respond', {
      roomId: 'room-1', clarify_id: 'clarify-hermes', response: 'yes',
    })).resolves.toEqual({ ok: true, resolved: true })
    expect(bridgeClarify).toHaveBeenCalledWith('clarify-hermes', 'yes')
  })

  it('restores pending approvals and clarifications to a room manager on rejoin', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    agent.emit('approval.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId,
      approval_id: 'approval-restored', command: 'touch file', description: 'needs approval',
    })
    agent.emit('clarify.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId,
      clarify_id: 'clarify-restored', question: 'Which environment?', choices: null,
    })
    await wait()

    const joined = await emitAck<any>(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    expect(joined.pendingApprovals).toEqual([
      expect.objectContaining({ approval_id: 'approval-restored', command: 'touch file' }),
    ])
    expect(joined.pendingClarifies).toEqual([
      expect.objectContaining({ clarify_id: 'clarify-restored', question: 'Which environment?' }),
    ])
  })

  it('routes approval responses back to the pending Ekko Agent session', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const bridgeApproval = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond')
      .mockResolvedValue({ resolved: false } as any)
    const requested = once<any>(human, 'approval.requested')
    const approval = waitForEkkoToolApproval({
      approvalId: 'approval-ekko',
      toolName: 'terminal_exec',
      key: 'terminal:delete',
      command: 'rm -rf build',
      description: 'deletes files or directories',
      choices: ['once', 'session', 'always', 'deny'],
      allowPermanent: true,
      timeoutMs: 300_000,
    }, {
      sessionId: agentSessionId,
      onRequested: pending => {
        agent.emit('approval.requested', {
          roomId: 'room-1',
          agentName: 'Agent',
          agentSessionId,
          approval_id: pending.approvalId,
          command: pending.command,
          description: pending.description,
          choices: pending.choices,
          allow_permanent: pending.allowPermanent,
        })
      },
    })

    await expect(requested).resolves.toMatchObject({
      roomId: 'room-1',
      agentName: 'Agent',
      approval_id: 'approval-ekko',
    })
    await expect(emitAck(human, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-ekko',
      choice: 'once',
    })).resolves.toEqual({ ok: true, resolved: true })
    await expect(approval).resolves.toBe('once')
    expect(bridgeApproval).not.toHaveBeenCalled()
  })

  it('removes a resolved remote approval locator so it cannot be submitted twice', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const respondApproval = vi.fn(async () => true)
    vi.spyOn(groupServer.agentClients, 'getAgents').mockReturnValue([{
      name: 'Agent',
      respondApproval,
    } as any])
    const requested = once<any>(human, 'approval.requested')

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-remote-once',
      command: 'touch file',
      description: 'needs approval',
    })
    await expect(requested).resolves.toMatchObject({ approval_id: 'approval-remote-once' })

    await expect(emitAck(human, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-remote-once',
      choice: 'once',
    })).resolves.toEqual({ ok: true, resolved: true })
    await expect(emitAck(human, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-remote-once',
      choice: 'once',
    })).resolves.toEqual({ error: 'Approval is not pending in this room' })
    expect(respondApproval).toHaveBeenCalledOnce()
  })

  it('keeps Hermes approval responses routed through the Agent Bridge', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const bridgeApproval = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond')
      .mockResolvedValue({ resolved: true } as any)
    const requested = once<any>(human, 'approval.requested')

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-hermes',
      command: 'touch file',
      description: 'needs approval',
    })
    await expect(requested).resolves.toMatchObject({ approval_id: 'approval-hermes' })

    await expect(emitAck(human, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-hermes',
      choice: 'session',
    })).resolves.toEqual({ ok: true, resolved: true })
    expect(bridgeApproval).toHaveBeenCalledWith('approval-hermes', 'session')
  })

  it('does not route a pending approval through a different room', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const bridgeApproval = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond')
      .mockResolvedValue({ resolved: true } as any)
    const requested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-private-room',
      command: 'cat secret',
      description: 'needs approval',
    })
    await requested

    groupServer.getStorage().saveRoom('room-2', 'Room 2', 'ROOM2')
    const otherManager = await connectGroupChatClient(port, 'human-2', 'Other')
    harness.sockets.push(otherManager)
    await emitAck(otherManager, 'join', { roomId: 'room-2', inviteCode: 'ROOM2' })

    await expect(emitAck(otherManager, 'approval.respond', {
      roomId: 'room-2',
      approval_id: 'approval-private-room',
      choice: 'once',
    })).resolves.toEqual({ error: 'Approval is not pending in this room' })
    expect(bridgeApproval).not.toHaveBeenCalled()
  })

  it('rejects approval responses from sockets that have not joined the room', async () => {
    const outsider = await connectGroupChatClient(port, 'outsider', 'Outsider')
    harness.sockets.push(outsider)

    await expect(emitAck(outsider, 'approval.respond', { roomId: 'room-1', approval_id: 'approval-1', choice: 'deny' })).resolves.toEqual({ error: 'Not in room' })
  })

  it('emits room_cleared and room_updated when runtime state is cleared', async () => {
    const { human } = await joinPair()
    const cleared = once<any>(human, 'room_cleared')
    const updated = once<any>(human, 'room_updated')

    groupServer.clearRoomRuntimeState('room-1')

    expect(await cleared).toEqual({ roomId: 'room-1', totalTokens: 0 })
    expect(await updated).toEqual({ roomId: 'room-1', totalTokens: 0 })
  })
})

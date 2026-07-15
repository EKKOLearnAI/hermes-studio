import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
  once,
} from './group-chat-test-helpers'
import { GROUP_CHAT_AGENT_SOCKET_SECRET, groupBridgeSessionId } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
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
    const agentSessionId = groupBridgeSessionId(
      'room-1',
      'default',
      'Agent',
      String(groupServer.getStorage().getRoom('room-1')?.sessionSeed || '0'),
    )
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

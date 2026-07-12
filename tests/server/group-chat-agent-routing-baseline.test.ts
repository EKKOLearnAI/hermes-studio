import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
} from './group-chat-test-helpers'
import { GROUP_CHAT_AGENT_SOCKET_SECRET, groupBridgeSessionId } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import { authenticateUserToken, isAuthEnabled } from '../../packages/server/src/middleware/user-auth'
import type { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

describe('group chat agent routing baseline', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let port: number

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(isAuthEnabled).mockResolvedValue(false)
    vi.mocked(authenticateUserToken).mockResolvedValue(null as any)
    harness = await createTestGroupChatServer()
    groupServer = harness.groupServer
    port = harness.port
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    groupServer.getStorage().addRoomAgent('room-1', 'agent-worker', 'default', 'Worker', '', 0)
  })

  afterEach(() => {
    harness?.cleanup()
  })

  async function joinHumanAndAgent() {
    const human = await connectGroupChatClient(port, 'human-1', 'Human')
    const agent = await connectGroupChatClient(port, 'agent-worker', 'Worker', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(human, agent)
    await emitAck(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(agent, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    return { human, agent }
  }

  function currentAgentSessionId() {
    const room = groupServer.getStorage().getRoom('room-1')
    return groupBridgeSessionId('room-1', 'default', 'Worker', String(room?.sessionSeed || '0'))
  }

  it('routes human messages through mention processing', async () => {
    const { human } = await joinHumanAndAgent()
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)

    await emitAck(human, 'message', { roomId: 'room-1', id: 'human-msg-1', content: '@Worker hello' })

    expect(processMentions).toHaveBeenCalledWith('room-1', expect.objectContaining({
      messageId: 'human-msg-1',
      role: 'user',
      mentionDepth: 0,
    }))
  })

  it('does not route read-only invite member messages through agents', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    vi.mocked(authenticateUserToken).mockImplementation(async (token: string) => {
      if (token === 'read-only-token') return { id: 2, username: 'bob', role: 'admin', profiles: [] } as any
      return null
    })
    const human = await connectGroupChatClient(port, 'ignored-user', 'Bob', { token: 'read-only-token' })
    const agent = await connectGroupChatClient(port, 'agent-worker', 'Worker', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(human, agent)
    await emitAck(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(agent, 'join', { roomId: 'room-1' })
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)

    await emitAck(human, 'message', { roomId: 'room-1', id: 'readonly-msg-1', content: '@Worker hello' })

    expect(processMentions).not.toHaveBeenCalled()
  })

  it('routes agent replies below the default mention-depth guard', async () => {
    const { agent } = await joinHumanAndAgent()
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)

    await emitAck(agent, 'message', {
      roomId: 'room-1',
      id: 'agent-msg-1',
      content: '@Worker chain handoff',
      role: 'assistant',
      mentionDepth: 3,
      agentSessionId: currentAgentSessionId(),
    })

    expect(processMentions).toHaveBeenCalledWith('room-1', expect.objectContaining({
      messageId: 'agent-msg-1',
      role: 'assistant',
      mentionDepth: 3,
    }))
  })

  it('does not route agent replies at the default mention-depth guard', async () => {
    const { agent } = await joinHumanAndAgent()
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)

    await emitAck(agent, 'message', {
      roomId: 'room-1',
      id: 'agent-msg-2',
      content: '@Worker stop looping',
      role: 'assistant',
      mentionDepth: 4,
      agentSessionId: currentAgentSessionId(),
    })

    expect(processMentions).not.toHaveBeenCalled()
  })
})

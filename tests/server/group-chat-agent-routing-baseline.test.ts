import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
} from './group-chat-test-helpers'
import { GROUP_CHAT_AGENT_SOCKET_SECRET } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import type { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

describe('group chat agent routing baseline', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let port: number

  beforeEach(async () => {
    vi.clearAllMocks()
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
    await emitAck(human, 'join', { roomId: 'room-1' })
    await emitAck(agent, 'join', { roomId: 'room-1' })
    return { human, agent }
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

  it('routes agent replies below the default mention-depth guard', async () => {
    const { agent } = await joinHumanAndAgent()
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)

    await emitAck(agent, 'message', {
      roomId: 'room-1',
      id: 'agent-msg-1',
      content: '@Worker chain handoff',
      role: 'assistant',
      mentionDepth: 3,
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
    })

    expect(processMentions).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
} from './group-chat-test-helpers'
import { GROUP_CHAT_AGENT_SOCKET_SECRET, groupRuntimeSessionId } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
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
    vi.spyOn(groupServer.agentClients, 'agentSessionIsCurrent').mockReturnValue(true)
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    groupServer.getStorage().addRoomAgent('room-1', 'agent-worker', 'default', 'Worker', '', 0)
    groupServer.getStorage().addRoomAgent('room-1', 'agent-reviewer', 'default', 'Reviewer', '', 0)
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
    await emitAck(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1', name: 'Human' })
    await emitAck(agent, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    return { human, agent }
  }

  function currentAgentSessionId() {
    return groupRuntimeSessionId('room-1', 'default', 'Worker')
  }

  it('forwards only server-validated structured mentions to mention processing', async () => {
    const { human } = await joinHumanAndAgent()
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)

    await emitAck(human, 'message', { roomId: 'room-1', id: 'human-msg-1', content: '@Worker hello' })

    expect(processMentions).toHaveBeenCalledWith('room-1', expect.objectContaining({
      messageId: 'human-msg-1',
      role: 'user',
      mentionDepth: 0,
      mentions: undefined,
    }))

    await emitAck(human, 'message', {
      roomId: 'room-1',
      id: 'human-msg-2',
      content: '@Worker hello',
      mentions: [{ type: 'agent', participantId: 'agent-worker', displayName: 'Worker' }],
    })

    expect(processMentions).toHaveBeenLastCalledWith('room-1', expect.objectContaining({
      messageId: 'human-msg-2',
      mentions: [{ type: 'agent', participantId: 'agent-worker' }],
    }))
  })

  it('lets an invite guest interact with agents', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    const human = await connectGroupChatClient(port, 'guest-user', 'Guest', { inviteCode: 'ROOM1' })
    const agent = await connectGroupChatClient(port, 'agent-worker', 'Worker', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(human, agent)
    await emitAck(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1', name: 'Guest' })
    await emitAck(agent, 'join', { roomId: 'room-1' })
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)

    await emitAck(human, 'message', { roomId: 'room-1', id: 'guest-msg-1', content: '@Worker hello' })

    expect(processMentions).toHaveBeenCalledWith('room-1', expect.objectContaining({
      messageId: 'guest-msg-1',
      senderId: 'guest-user',
      content: '@Worker hello',
      role: 'user',
    }))
  })

  it('rejects forged guest attachment paths before they reach an Agent', async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(true)
    const human = await connectGroupChatClient(port, 'guest-user', 'Guest', { inviteCode: 'ROOM1' })
    harness.sockets.push(human)
    await emitAck(human, 'join', { roomId: 'room-1', name: 'Guest' })
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)

    const response = await emitAck<any>(human, 'message', {
      roomId: 'room-1',
      id: 'forged-attachment',
      content: [{
        type: 'image',
        name: 'secret.png',
        path: '/etc/passwd',
        media_type: 'image/png',
      }],
      role: 'assistant',
    })

    expect(response).toMatchObject({ code: 'GROUP_CHAT_ATTACHMENT_INVALID' })
    expect(processMentions).not.toHaveBeenCalled()
    expect(groupServer.getStorage().getMessage('forged-attachment')).toBeNull()

    const encodedResponse = await emitAck<any>(human, 'message', {
      roomId: 'room-1',
      id: 'forged-encoded-attachment',
      content: JSON.stringify([{
        type: 'image',
        name: 'secret.png',
        path: '/etc/passwd',
        media_type: 'image/png',
      }]),
    })
    expect(encodedResponse).toMatchObject({ code: 'GROUP_CHAT_ATTACHMENT_INVALID' })
    expect(processMentions).not.toHaveBeenCalled()
    expect(groupServer.getStorage().getMessage('forged-encoded-attachment')).toBeNull()
  })

  it('routes agent replies below the default mention-depth guard', async () => {
    const { agent } = await joinHumanAndAgent()
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)
    groupServer.getStorage().registerTrustedAgentMessageMetadata('room-1', 'agent-msg-1', 3, 'handoff:agent-msg-1')

    await emitAck(agent, 'message', {
      roomId: 'room-1',
      id: 'agent-msg-1',
      content: '@Reviewer chain handoff',
      role: 'assistant',
      mentionDepth: 3,
      agentSessionId: currentAgentSessionId(),
      mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }],
    })

    expect(processMentions).toHaveBeenCalledWith('room-1', expect.objectContaining({
      messageId: 'agent-msg-1',
      role: 'assistant',
      mentionDepth: 3,
    }))
  })

  it('creates a max-depth stop at the exact finite boundary for a trusted concrete Agent target', async () => {
    const { agent } = await joinHumanAndAgent()
    const storage = groupServer.getStorage()
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)
    storage.updateRoomConfig('room-1', {
      agentHandoffEnabled: true,
      agentHandoffMaxDepth: 4,
      agentHandoffUnlimited: false,
    })
    storage.registerTrustedAgentMessageMetadata('room-1', 'agent-msg-boundary', 4, 'handoff:agent-msg-boundary')

    await emitAck(agent, 'message', {
      roomId: 'room-1', id: 'agent-msg-boundary', content: '@Reviewer stop at boundary', role: 'assistant',
      agentSessionId: currentAgentSessionId(),
      mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }],
    })

    expect(processMentions).not.toHaveBeenCalled()
    expect(storage.getHandoffChain('room-1', 'handoff:agent-msg-boundary')).toMatchObject({
      status: 'stopped',
      stopReason: 'max_depth',
      sourceMessageId: 'agent-msg-boundary',
      targetAgentId: 'agent-reviewer',
      currentDepth: 4,
      maxDepth: 4,
      unlimited: 0,
    })
  })

  it('does not create a depth-stop record when Agent handoffs are disabled', async () => {
    const { agent } = await joinHumanAndAgent()
    const storage = groupServer.getStorage()
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue({
      targetCount: 0,
      deliveredCount: 0,
      errors: [],
    })
    storage.updateRoomConfig('room-1', {
      agentHandoffEnabled: false,
      agentHandoffMaxDepth: 4,
      agentHandoffUnlimited: false,
    })
    storage.registerTrustedAgentMessageMetadata('room-1', 'agent-msg-disabled', 1, 'handoff:agent-msg-disabled')

    await emitAck(agent, 'message', {
      roomId: 'room-1',
      id: 'agent-msg-disabled',
      content: '@Reviewer do not route',
      role: 'assistant',
      agentSessionId: currentAgentSessionId(),
      mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }],
    })

    expect(processMentions).not.toHaveBeenCalled()
    expect(storage.getHandoffChain('room-1', 'handoff:agent-msg-disabled')).toBeNull()
  })

  it('does not create a depth-stop record for a trusted @all handoff without a concrete Agent target', async () => {
    const { agent } = await joinHumanAndAgent()
    const storage = groupServer.getStorage()
    storage.registerTrustedAgentMessageMetadata('room-1', 'agent-msg-all', 4, 'handoff:agent-msg-all')

    await emitAck(agent, 'message', {
      roomId: 'room-1',
      id: 'agent-msg-all',
      content: '@all stop here',
      role: 'assistant',
      agentSessionId: currentAgentSessionId(),
      mentions: [{ type: 'all', displayName: 'all' }],
    })

    expect(storage.getHandoffChain('room-1', 'handoff:agent-msg-all')).toBeNull()
  })

  it('does not trust forged agent depth or chain identity', async () => {
    const { agent } = await joinHumanAndAgent()
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)

    await emitAck(agent, 'message', {
      roomId: 'room-1',
      id: 'agent-msg-2',
      content: '@Reviewer stop looping',
      role: 'assistant',
      mentionDepth: 0,
      handoffChainId: 'forged-chain',
      agentSessionId: currentAgentSessionId(),
      mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }],
    })

    expect(processMentions).not.toHaveBeenCalled()
    expect(groupServer.getStorage().getHandoffChain('room-1', 'handoff:agent-msg-2')).toBeNull()
  })

  it('routes a trusted structured handoff in unlimited mode without creating a stop', async () => {
    const { agent } = await joinHumanAndAgent()
    const storage = groupServer.getStorage()
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue({
      targetCount: 1, deliveredCount: 1, errors: [],
    })
    storage.updateRoomConfig('room-1', {
      agentHandoffEnabled: true,
      agentHandoffMaxDepth: null,
      agentHandoffUnlimited: true,
    })
    storage.registerTrustedAgentMessageMetadata('room-1', 'agent-msg-unlimited', 400, 'handoff:agent-msg-unlimited')

    await emitAck(agent, 'message', {
      roomId: 'room-1', id: 'agent-msg-unlimited', content: '@Reviewer continue', role: 'assistant',
      agentSessionId: currentAgentSessionId(),
      mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }],
    })

    expect(processMentions).toHaveBeenCalled()
    expect(storage.getHandoffChain('room-1', 'handoff:agent-msg-unlimited')).toBeNull()
  })
})

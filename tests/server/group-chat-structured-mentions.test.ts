import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
} from './group-chat-test-helpers'
import { GROUP_CHAT_AGENT_SOCKET_SECRET, groupRuntimeSessionId } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import { authenticateUserToken, isAuthEnabled } from '../../packages/server/src/middleware/user-auth'
import type { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

describe('group chat structured agent mentions', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let port: number

  beforeEach(async () => {
    vi.mocked(isAuthEnabled).mockResolvedValue(false)
    vi.mocked(authenticateUserToken).mockResolvedValue(null as any)
    harness = await createTestGroupChatServer()
    groupServer = harness.groupServer
    port = harness.port
    vi.spyOn(groupServer.agentClients, 'agentSessionIsCurrent').mockReturnValue(true)
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    groupServer.getStorage().addRoomAgent('room-1', 'agent-author', 'default', 'Author', '', 0)
    groupServer.getStorage().addRoomAgent('room-1', 'agent-reviewer', 'default', 'Reviewer', '', 0)
  })

  afterEach(() => {
    harness?.cleanup()
  })

  it('normalizes an agent-generated entry mention, persists only its routing DTO, and routes it again', async () => {
    const author = await connectGroupChatClient(port, 'agent-author', 'Author', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    const reviewer = await connectGroupChatClient(port, 'agent-reviewer', 'Reviewer', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(author, reviewer)
    await emitAck(author, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(reviewer, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)
    const agentSessionId = groupRuntimeSessionId('room-1', 'default', 'Author')
    const forgedFutureTimestamp = Date.now() + 86_400_000
    await emitAck(author, 'message', {
      roomId: 'room-1',
      id: 'agent-handoff-1',
      content: '@Reviewer please independently verify this.',
      role: 'assistant',
      mentionDepth: 1,
      agentSessionId,
      timestamp: forgedFutureTimestamp,
      mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }],
    })

    expect(processMentions).toHaveBeenCalledWith('room-1', expect.objectContaining({
      messageId: 'agent-handoff-1',
      mentions: [{ type: 'agent', participantId: 'agent-reviewer' }],
    }))
    expect(harness.db.prepare('SELECT mentions FROM gc_messages WHERE id = ?').get('agent-handoff-1')).toEqual({
      mentions: JSON.stringify([{ type: 'agent', participantId: 'agent-reviewer' }]),
    })
    expect((harness.db.prepare('SELECT persistedAt FROM gc_messages WHERE id = ?').get('agent-handoff-1') as { persistedAt: number }).persistedAt)
      .toBeLessThan(forgedFutureTimestamp)
  })

  it('atomically rejects a forged display name instead of persisting or partially routing it', async () => {
    const author = await connectGroupChatClient(port, 'agent-author', 'Author', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    const reviewer = await connectGroupChatClient(port, 'agent-reviewer', 'Reviewer', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(author, reviewer)
    await emitAck(author, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(reviewer, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)
    const response = await emitAck<{ error?: string }>(author, 'message', {
      roomId: 'room-1',
      id: 'forged-handoff',
      content: '@Reviewer please verify this.',
      role: 'assistant',
      agentSessionId: groupRuntimeSessionId('room-1', 'default', 'Author'),
      mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Author' }],
    })

    expect(response.error).toBe('Invalid structured mentions')
    expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_messages WHERE id = ?').get('forged-handoff')).toEqual({ count: 0 })
    expect(processMentions).not.toHaveBeenCalled()
  })
})

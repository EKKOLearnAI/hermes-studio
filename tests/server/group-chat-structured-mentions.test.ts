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
    harness.sockets.push(author)
    await emitAck(author, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const replyToMention = vi.fn(async () => {})
    ;(groupServer.agentClients as any).rooms.set('room-1', new Map([[
      'agent-reviewer',
      { id: 'agent-reviewer', agentId: 'agent-reviewer', name: 'Reviewer', replyToMention },
    ]]))
    const agentSessionId = groupRuntimeSessionId('room-1', 'default', 'Author')
    const forgedFutureTimestamp = Date.now() + 86_400_000
    groupServer.getStorage().registerTrustedAgentMessageMetadata('room-1', 'agent-handoff-1', 1, 'trusted-chain')
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

    await vi.waitFor(() => expect(replyToMention).toHaveBeenCalledWith('room-1', expect.objectContaining({
      messageId: 'agent-handoff-1',
      mentions: [{ type: 'agent', participantId: 'agent-reviewer' }],
    }), expect.anything(), expect.any(Function)))
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

  it('persists an agent reply that only names itself without dispatching itself', async () => {
    const author = await connectGroupChatClient(port, 'agent-author', 'Author', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(author)
    await emitAck(author, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    const replyToMention = vi.fn(async () => {})
    ;(groupServer.agentClients as any).rooms.set('room-1', new Map([[
      'agent-reviewer',
      { id: 'agent-reviewer', agentId: 'agent-reviewer', name: 'Reviewer', replyToMention },
    ]]))

    const response = await emitAck<{ id?: string; error?: string }>(author, 'message', {
      roomId: 'room-1',
      id: 'self-named-reply',
      content: '@Author status: waiting for the next task.',
      role: 'assistant',
      agentSessionId: groupRuntimeSessionId('room-1', 'default', 'Author'),
    })

    expect(response).toEqual({ id: 'self-named-reply' })
    expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_messages WHERE id = ?').get('self-named-reply')).toEqual({ count: 1 })
    expect(replyToMention).not.toHaveBeenCalled()
  })

  it('persists tool output containing mention-like text without authorizing or routing mentions', async () => {
    const author = await connectGroupChatClient(port, 'agent-author', 'Author', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(author)
    await emitAck(author, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)
    const response = await emitAck<{ id?: string; error?: string }>(author, 'message', {
      roomId: 'room-1',
      id: 'tool-result-with-mentions',
      content: 'source fixture: @all and @Reviewer are plain tool output',
      role: 'tool',
      run_id: 'run-1',
      tool_call_id: 'call-1',
      tool_name: 'read_file',
      agentSessionId: groupRuntimeSessionId('room-1', 'default', 'Author'),
      mentions: [{ type: 'all', displayName: 'ALL' }],
    })

    expect(response).toEqual({ id: 'tool-result-with-mentions' })
    expect(harness.db.prepare(`
      SELECT role, content, mentions, tool_call_id, tool_name
      FROM gc_messages
      WHERE id = ?
    `).get('tool-result-with-mentions')).toEqual({
      role: 'tool',
      content: 'source fixture: @all and @Reviewer are plain tool output',
      mentions: '[]',
      tool_call_id: 'call-1',
      tool_name: 'read_file',
    })
    expect(processMentions).not.toHaveBeenCalled()
  })

  it('persists an agent explanation containing @all when explicit metadata says it has no routing targets', async () => {
    const author = await connectGroupChatClient(port, 'agent-author', 'Author', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(author)
    await emitAck(author, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)
    const response = await emitAck<{ id?: string; error?: string }>(author, 'message', {
      roomId: 'room-1',
      id: 'assistant-explanation-with-all',
      content: 'The previous @all broadcast was a mistake. This sentence is explanatory text.',
      role: 'assistant',
      agentSessionId: groupRuntimeSessionId('room-1', 'default', 'Author'),
      mentions: [],
    })

    expect(response).toEqual({ id: 'assistant-explanation-with-all' })
    expect(harness.db.prepare('SELECT content, mentions FROM gc_messages WHERE id = ?').get('assistant-explanation-with-all')).toEqual({
      content: 'The previous @all broadcast was a mistake. This sentence is explanatory text.',
      mentions: '[]',
    })
    expect(processMentions).not.toHaveBeenCalled()
  })

  it('keeps the latest main policy that only a room owner may broadcast with @all', async () => {
    const author = await connectGroupChatClient(port, 'agent-author', 'Author', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(author)
    await emitAck(author, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const replyToMention = vi.fn(async () => {})
    ;(groupServer.agentClients as any).rooms.set('room-1', new Map([[
      'agent-reviewer',
      { id: 'agent-reviewer', agentId: 'agent-reviewer', name: 'Reviewer', replyToMention },
    ]]))

    const response = await emitAck<{ error?: string }>(author, 'message', {
      roomId: 'room-1',
      id: 'agent-all-handoff',
      content: '@all please independently verify this.',
      role: 'assistant',
      mentionDepth: 1,
      agentSessionId: groupRuntimeSessionId('room-1', 'default', 'Author'),
      mentions: [{ type: 'all', displayName: 'all' }],
    })

    expect(response.error).toBe('Only the room owner can mention @all')
    expect(replyToMention).not.toHaveBeenCalled()
    expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_messages WHERE id = ?').get('agent-all-handoff')).toEqual({ count: 0 })
  })

  it('atomically rejects an agent visible mention paired with an empty structured mention list', async () => {
    const author = await connectGroupChatClient(port, 'agent-author', 'Author', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(author)
    await emitAck(author, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)
    const response = await emitAck<{ error?: string }>(author, 'message', {
      roomId: 'room-1',
      id: 'empty-agent-handoff',
      content: '@Reviewer please independently verify this.',
      role: 'assistant',
      agentSessionId: groupRuntimeSessionId('room-1', 'default', 'Author'),
      mentions: [],
    })

    expect(response).toEqual({ id: 'empty-agent-handoff' })
    expect(harness.db.prepare('SELECT content, mentions FROM gc_messages WHERE id = ?').get('empty-agent-handoff')).toEqual({
      content: '@Reviewer please independently verify this.',
      mentions: '[]',
    })
    expect(processMentions).not.toHaveBeenCalled()
  })

  it('atomically rejects cross-room, stale, self, duplicate, and malformed broadcast metadata', async () => {
    const author = await connectGroupChatClient(port, 'agent-author', 'Author', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(author)
    await emitAck(author, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    groupServer.getStorage().saveRoom('room-2', 'Room 2', 'ROOM2')
    groupServer.getStorage().addRoomAgent('room-2', 'agent-other-room', 'default', 'Reviewer', '', 0)
    const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockResolvedValue(undefined)
    const base = {
      roomId: 'room-1',
      role: 'assistant',
      agentSessionId: groupRuntimeSessionId('room-1', 'default', 'Author'),
    }

    const cases = [
      { id: 'cross-room', content: '@Reviewer verify', mentions: [{ type: 'agent', participantId: 'agent-other-room', displayName: 'Reviewer' }] },
      { id: 'stale', content: '@Reviewer verify', mentions: [{ type: 'agent', participantId: 'removed-agent', displayName: 'Reviewer' }] },
      { id: 'self', content: '@Author verify', mentions: [{ type: 'agent', participantId: 'agent-author', displayName: 'Author' }] },
      { id: 'duplicate', content: '@Reviewer verify', mentions: [
        { type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' },
        { type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' },
      ] },
      { id: 'invalid-all', content: '@all verify', mentions: [{ type: 'all', displayName: 'ALL' }], expectedError: 'Only the room owner can mention @all' },
      { id: 'incomplete-agent', content: '@Reviewer verify', mentions: [{ type: 'agent', participantId: 'agent-reviewer' }] },
      { id: 'invalid-type', content: '@Reviewer verify', mentions: [{ type: 'human', participantId: 'agent-reviewer', displayName: 'Reviewer' }] },
      { id: 'inconsistent-content', content: 'please verify', mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }] },
      { id: 'all-with-explicit-agent', content: '@all @Reviewer verify', mentions: [{ type: 'all', displayName: 'all' }], expectedError: 'Only the room owner can mention @all' },
    ]

    for (const testCase of cases) {
      const response = await emitAck<{ error?: string }>(author, 'message', { ...base, ...testCase })
      const expectedError = 'expectedError' in testCase
        ? testCase.expectedError
        : 'Invalid structured mentions'
      expect(response.error).toBe(expectedError)
      expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_messages WHERE id = ?').get(testCase.id)).toEqual({ count: 0 })
    }
    expect(processMentions).not.toHaveBeenCalled()
  })
})

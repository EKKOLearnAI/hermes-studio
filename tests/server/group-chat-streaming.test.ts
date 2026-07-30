import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  currentRoomAgentSessionId,
  createTestGroupChatServer,
  emitAck,
  once,
} from './group-chat-test-helpers'
import { GROUP_CHAT_AGENT_SOCKET_SECRET } from '../../packages/server/src/services/hermes/group-chat/agent-clients'
import type { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

describe('group chat streaming baseline', () => {
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

  async function joinPair() {
    const alice = await connectGroupChatClient(port, 'user-a', 'Alice')
    const bob = await connectGroupChatClient(port, 'user-b', 'Bob')
    const worker = await connectGroupChatClient(port, 'agent-worker', 'Worker', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(alice, bob, worker)
    await emitAck(alice, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(bob, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(worker, 'join', { roomId: 'room-1' })
    const agentSessionId = currentRoomAgentSessionId(groupServer, 'room-1', 'agent-worker', 'default', 'Worker')
    return { alice, bob, worker, agentSessionId }
  }

  it('relays stream start, content delta, reasoning delta, and stream end to room members', async () => {
    const { worker, bob, agentSessionId } = await joinPair()

    const streamStart = once<any>(bob, 'message_stream_start')
    worker.emit('message_stream_start', { roomId: 'room-1', id: 'stream-1', senderName: 'Spoofed', timestamp: 10, agentSessionId })
    expect(await streamStart).toMatchObject({
      id: 'stream-1',
      roomId: 'room-1',
      senderName: 'Worker',
      role: 'assistant',
      finish_reason: 'streaming',
    })

    const contentDelta = once<any>(bob, 'message_stream_delta')
    worker.emit('message_stream_delta', { roomId: 'room-1', id: 'stream-1', delta: 'hello', agentSessionId })
    expect(await contentDelta).toEqual({ roomId: 'room-1', id: 'stream-1', delta: 'hello' })

    const reasoningDelta = once<any>(bob, 'message_reasoning_delta')
    worker.emit('message_reasoning_delta', { roomId: 'room-1', id: 'stream-1', delta: 'thinking', agentSessionId })
    expect(await reasoningDelta).toEqual({ roomId: 'room-1', id: 'stream-1', delta: 'thinking' })

    const streamEnd = once<any>(bob, 'message_stream_end')
    worker.emit('message_stream_end', { roomId: 'room-1', id: 'stream-1', agentSessionId })
    expect(await streamEnd).toEqual({ roomId: 'room-1', id: 'stream-1' })
  })

  it('publishes terminal UI state from the same fenced commit that completes a handoff', async () => {
    const { alice, bob, worker, agentSessionId } = await joinPair()
    harness.db.prepare(
      'UPDATE gc_room_agents SET sessionId = ? WHERE roomId = ? AND agentId = ?',
    ).run(agentSessionId, 'room-1', 'agent-worker')

    const sourceAck = await emitAck<any>(alice, 'message', {
      roomId: 'room-1',
      id: 'terminal-source-1',
      content: '@Worker finish this',
      mentions: [{ type: 'participant', participantId: 'agent-worker', displayName: 'Worker', start: 0, length: 7 }],
    })
    expect(sourceAck).toEqual({ id: 'terminal-source-1' })

    const [job] = groupServer.getStorage().claimHandoffJobs('test-dispatcher', Date.now(), 1, 60_000)
    expect(job).toMatchObject({
      sourceMessageId: 'terminal-source-1',
      targetAgentId: 'agent-worker',
      targetSessionId: agentSessionId,
      status: 'running',
    })

    worker.emit('context_status', {
      roomId: 'room-1',
      agentName: 'Worker',
      status: 'replying',
      agentSessionId,
      sourceHandoffJobId: job.id,
      sourceHandoffLeaseToken: job.leaseToken,
    })
    await expect(once<any>(bob, 'context_status')).resolves.toMatchObject({
      agentId: 'agent-worker',
      status: 'replying',
    })

    const finalMessage = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for terminal message')), 2_000)
      const onMessage = (payload: any) => {
        if (payload?.id !== 'terminal-stream-1') return
        clearTimeout(timer)
        bob.off('message', onMessage)
        resolve(payload)
      }
      bob.on('message', onMessage)
    })
    const streamEnd = once<any>(bob, 'message_stream_end')
    const ready = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ready context_status')), 2_000)
      const onStatus = (payload: any) => {
        if (payload?.agentId !== 'agent-worker' || payload?.status !== 'ready') return
        clearTimeout(timer)
        bob.off('context_status', onStatus)
        resolve(payload)
      }
      bob.on('context_status', onStatus)
    })
    const finalAck = emitAck<any>(worker, 'message', {
      roomId: 'room-1',
      id: 'terminal-stream-1',
      content: 'finished',
      role: 'assistant',
      finish_reason: 'stop',
      handoffChainId: job.chainId,
      handoffDepth: 1,
      sourceHandoffJobId: job.id,
      sourceHandoffLeaseToken: job.leaseToken,
      handoffFinal: true,
      agentSessionId,
    })

    await expect(finalAck).resolves.toEqual({ id: 'terminal-stream-1' })
    await expect(finalMessage).resolves.toMatchObject({ id: 'terminal-stream-1', content: 'finished' })
    await expect(streamEnd).resolves.toEqual({ roomId: 'room-1', id: 'terminal-stream-1' })
    await expect(ready).resolves.toMatchObject({
      roomId: 'room-1',
      agentId: 'agent-worker',
      agentName: 'Worker',
      status: 'ready',
    })
    expect(groupServer.getStorage().getHandoffJob(job.id)).toMatchObject({ status: 'completed', leaseToken: '' })
    expect((groupServer as any).contextStatusState.has('room-1')).toBe(false)
  })

  it('routes and persists a human structured mention by stable participant identity', async () => {
    const { alice } = await joinPair()

    const ack = await emitAck<any>(alice, 'message', {
      roomId: 'room-1',
      id: 'structured-message-1',
      content: '@Former Name continue',
      mentions: [{
        type: 'participant', participantId: 'agent-worker', displayName: 'Former Name', start: 0, length: 12,
      }],
    })

    expect(ack).toEqual({ id: 'structured-message-1' })
    expect(groupServer.getStorage().getMessage('structured-message-1')).toMatchObject({
      mentions: [{ type: 'participant', participantId: 'agent-worker' }],
    })
    expect(groupServer.getStorage().listHandoffJobs('room-1')).toEqual([
      expect.objectContaining({ sourceMessageId: 'structured-message-1', targetAgentId: 'agent-worker', kind: 'mention' }),
    ])
  })

  it('routes typed or pasted mention text when structured metadata is omitted', async () => {
    const { alice } = await joinPair()

    const ack = await emitAck<any>(alice, 'message', {
      roomId: 'room-1',
      id: 'legacy-text-message-1',
      content: '@Worker continue',
    })

    expect(ack).toEqual({ id: 'legacy-text-message-1' })
    expect(groupServer.getStorage().getMessage('legacy-text-message-1')).not.toHaveProperty('mentions')
    expect(groupServer.getStorage().listHandoffJobs('room-1')).toEqual([
      expect.objectContaining({ sourceMessageId: 'legacy-text-message-1', targetAgentId: 'agent-worker', kind: 'mention' }),
    ])
  })

  it('does not treat attachment metadata as a legacy mention command', async () => {
    const { alice } = await joinPair()

    const attachmentOnlyAck = await emitAck<any>(alice, 'message', {
      roomId: 'room-1',
      id: 'attachment-name-all-message',
      content: [
        { type: 'file', name: '@all', path: '/tmp/@all' },
      ],
    })
    const textAndAttachmentAck = await emitAck<any>(alice, 'message', {
      roomId: 'room-1',
      id: 'attachment-name-participant-message',
      content: [
        { type: 'text', text: 'Please inspect the attached file.' },
        { type: 'image', name: 'brief @Worker.png', path: '/tmp/brief @Worker.png' },
      ],
    })

    expect(attachmentOnlyAck).toEqual({ id: 'attachment-name-all-message' })
    expect(textAndAttachmentAck).toEqual({ id: 'attachment-name-participant-message' })
    expect(groupServer.getStorage().listHandoffJobs('room-1')).toEqual([])
  })

  it('routes legacy mentions only from text blocks when attachments are present', async () => {
    const { alice } = await joinPair()

    const ack = await emitAck<any>(alice, 'message', {
      roomId: 'room-1',
      id: 'text-block-mention-message',
      content: [
        { type: 'text', text: '@Worker inspect the attached file.' },
        { type: 'file', name: '@all', path: '/tmp/@all' },
      ],
    })

    expect(ack).toEqual({ id: 'text-block-mention-message' })
    expect(groupServer.getStorage().listHandoffJobs('room-1')).toEqual([
      expect.objectContaining({ sourceMessageId: 'text-block-mention-message', targetAgentId: 'agent-worker', kind: 'mention' }),
    ])
  })

  it('returns participant avatars as public objects in realtime join state', async () => {
    const avatar = { type: 'asset', assetUrl: '/coding-agents/hermes.png' }
    harness.db.prepare(
      'UPDATE gc_room_agents SET avatar = ? WHERE roomId = ? AND agentId = ?',
    ).run(JSON.stringify(avatar), 'room-1', 'agent-worker')
    const alice = await connectGroupChatClient(port, 'avatar-user', 'Avatar User')
    harness.sockets.push(alice)

    const joined = await emitAck<any>(alice, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    expect(joined.agents).toEqual([
      {
        roomId: 'room-1',
        agentId: 'agent-worker',
        profile: 'default',
        name: 'Worker',
        description: '',
        invited: 0,
        runtime: 'hermes',
        codingAgentId: '',
        mode: 'scoped',
        provider: '',
        model: '',
        apiMode: '',
        reasoningEffort: '',
        avatar,
      },
    ])
    expect(joined.agents[0]).not.toHaveProperty('sessionId')
    expect(joined.agents[0]).not.toHaveProperty('checkpoint')
  })

  it('rejects an unknown structured mention atomically before persistence', async () => {
    const { alice } = await joinPair()

    const ack = await emitAck<any>(alice, 'message', {
      roomId: 'room-1',
      id: 'structured-message-forged',
      content: '@Worker forged',
      mentions: [{ type: 'participant', participantId: 'other-room-agent', displayName: 'Worker', start: 0, length: 7 }],
    })

    expect(ack).toEqual({ error: expect.stringMatching(/structured mention participant/i) })
    expect(groupServer.getStorage().getMessage('structured-message-forged')).toBeNull()
    expect(groupServer.getStorage().listHandoffJobs('room-1')).toEqual([])
  })

  it('rejects forged structured mention display ranges before persistence', async () => {
    const { alice } = await joinPair()

    const ack = await emitAck<any>(alice, 'message', {
      roomId: 'room-1',
      id: 'structured-message-forged-range',
      content: 'ordinary text',
      mentions: [{ type: 'participant', participantId: 'agent-worker', displayName: 'Worker', start: 0, length: 7 }],
    })

    expect(ack).toEqual({ error: expect.stringMatching(/structured mention range/i) })
    expect(groupServer.getStorage().getMessage('structured-message-forged-range')).toBeNull()
  })

  it('evicts actors whose read grant is revoked before emitting confidential room output', async () => {
    const { alice, bob, worker, agentSessionId } = await joinPair()
    const localSubjectId = (groupServer as any).socketLocalSubjectIdMap.get(bob.id) as string
    const actor = groupServer.getStorage().findActiveActorByLocalSubjectId('room-1', localSubjectId)
    expect(actor).not.toBeNull()
    if (!actor) throw new Error('missing local actor')
    harness.db.prepare('DELETE FROM gc_room_actor_capabilities WHERE actorId = ?').run(actor.id)

    const authorizedDelta = once<any>(alice, 'message_stream_delta')
    const revokedDelta = once<any>(bob, 'message_stream_delta', 150)
    worker.emit('message_stream_delta', {
      roomId: 'room-1',
      id: 'stream-after-revocation',
      delta: 'private output',
      agentSessionId,
    })

    await expect(authorizedDelta).resolves.toEqual({
      roomId: 'room-1',
      id: 'stream-after-revocation',
      delta: 'private output',
    })
    await expect(revokedDelta).rejects.toThrow('timeout waiting for message_stream_delta')
    await expect(emitAck<any>(bob, 'message', {
      roomId: 'room-1',
      content: 'still here?',
    })).resolves.toEqual({ error: 'Not in room' })
  })

  it('drops durable stream callbacks after source authority is revoked without a revision bump', async () => {
    const { alice, bob, worker, agentSessionId } = await joinPair()
    await emitAck(alice, 'message', { roomId: 'room-1', id: 'durable-trigger-1', content: '@Worker run' })
    const pending = groupServer.getStorage().listHandoffJobs('room-1')[0]
    expect(pending).toMatchObject({ targetAgentId: 'agent-worker', status: 'pending' })
    const running = groupServer.getStorage().claimHandoffJobs('test-dispatcher', Date.now(), 1, 60_000)[0]

    const authorizedDelta = once<any>(bob, 'message_stream_delta')
    worker.emit('message_stream_delta', {
      roomId: 'room-1', id: 'durable-stream-1', delta: 'authorized', agentSessionId,
      sourceHandoffJobId: running.id, sourceHandoffLeaseToken: running.leaseToken,
    })
    await expect(authorizedDelta).resolves.toEqual({ roomId: 'room-1', id: 'durable-stream-1', delta: 'authorized' })

    harness.db.prepare(
      "UPDATE gc_room_actor_capabilities SET active = 0 WHERE actorId = ? AND capability = 'agent.invoke'",
    ).run(running.sourceActorId)
    ;(bob as any).__bufferedEvents__?.delete('message_stream_delta')
    const lateDelta = once<any>(bob, 'message_stream_delta', 150)
    worker.emit('message_stream_delta', {
      roomId: 'room-1', id: 'durable-stream-1', delta: 'must-not-publish', agentSessionId,
      sourceHandoffJobId: running.id, sourceHandoffLeaseToken: running.leaseToken,
    })

    await expect(lateDelta).rejects.toThrow('timeout waiting for message_stream_delta')
    expect(groupServer.getStorage().getHandoffJob(running.id)).toMatchObject({
      status: 'authorization_revoked', leaseOwner: '', leaseToken: '',
    })
  })

  it('rejects a durable stream callback that omits its job lease provenance', async () => {
    const { alice, bob, worker, agentSessionId } = await joinPair()
    await emitAck(alice, 'message', { roomId: 'room-1', id: 'durable-trigger-omission', content: '@Worker run' })
    const running = groupServer.getStorage().claimHandoffJobs('test-dispatcher', Date.now(), 1, 60_000)[0]
    expect(running).toMatchObject({ targetAgentId: 'agent-worker', status: 'running' })

    const omittedDelta = once<any>(bob, 'message_stream_delta', 150)
    worker.emit('message_stream_delta', {
      roomId: 'room-1', id: 'durable-stream-omission', delta: 'must-not-publish', agentSessionId,
    })

    await expect(omittedDelta).rejects.toThrow('timeout waiting for message_stream_delta')
    expect(groupServer.getStorage().getHandoffJob(running.id)).toMatchObject({ status: 'running' })
  })

  it('ignores stream events emitted by human sockets', async () => {
    const { alice, bob } = await joinPair()
    const unexpectedStart = once<any>(bob, 'message_stream_start', 100)
    const unexpectedDelta = once<any>(bob, 'message_stream_delta', 100)
    const unexpectedReasoning = once<any>(bob, 'message_reasoning_delta', 100)
    const unexpectedEnd = once<any>(bob, 'message_stream_end', 100)

    alice.emit('message_stream_start', { roomId: 'room-1', id: 'stream-human', senderName: 'Worker' })
    alice.emit('message_stream_delta', { roomId: 'room-1', id: 'stream-human', delta: 'hello' })
    alice.emit('message_reasoning_delta', { roomId: 'room-1', id: 'stream-human', delta: 'thinking' })
    alice.emit('message_stream_end', { roomId: 'room-1', id: 'stream-human' })

    await expect(unexpectedStart).rejects.toThrow('timeout waiting for message_stream_start')
    await expect(unexpectedDelta).rejects.toThrow('timeout waiting for message_stream_delta')
    await expect(unexpectedReasoning).rejects.toThrow('timeout waiting for message_reasoning_delta')
    await expect(unexpectedEnd).rejects.toThrow('timeout waiting for message_stream_end')
  })

  it('ignores a representative invalid stream id', async () => {
    const { alice, bob } = await joinPair()
    const unexpected = once<any>(bob, 'message_stream_start', 100)

    alice.emit('message_stream_start', { roomId: 'room-1', id: 'bad id with spaces' })

    await expect(unexpected).rejects.toThrow('timeout waiting for message_stream_start')
  })
})

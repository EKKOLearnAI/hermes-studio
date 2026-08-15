import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
  once,
} from './group-chat-test-helpers'

describe('group chat authoritative execution queue', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  const ownerCapability = 'a'.repeat(64)
  const attackerCapability = 'b'.repeat(64)

  beforeEach(async () => {
    vi.clearAllMocks()
    harness = await createTestGroupChatServer()
    harness.groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    harness.groupServer.getStorage().addRoomAgent('room-1', 'agent-worker', 'default', 'Worker', '', 0)
  })

  afterEach(() => {
    harness?.cleanup()
  })

  it('publishes queued work with stable ordering, restores it on reconnect, and requires its private capability to cancel', async () => {
    let finishFirst!: () => void
    let started = 0
    const executor = {
      agentId: 'agent-worker',
      name: 'Worker',
      connected: true,
      replyToMention: vi.fn(async () => {
        started += 1
        if (started === 1) await new Promise<void>(resolve => { finishFirst = resolve })
      }),
    }
    harness.groupServer.agentClients.registerAgentForRoom('room-1', executor as any)

    const owner = await connectGroupChatClient(harness.port, 'human-1', 'Owner')
    const observer = await connectGroupChatClient(harness.port, 'human-2', 'Observer')
    harness.sockets.push(owner, observer)
    await emitAck(owner, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(observer, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    await emitAck(owner, 'message', {
      roomId: 'room-1',
      id: 'message-running',
      content: '@Worker first',
      mentions: [{ type: 'agent', participantId: 'agent-worker', displayName: 'Worker' }],
      executionQueueCapability: ownerCapability,
    })
    await vi.waitFor(() => expect(executor.replyToMention).toHaveBeenCalledTimes(1))

    const queueUpdate = once<any>(owner, 'execution_queue_updated')
    await emitAck(owner, 'message', {
      roomId: 'room-1',
      id: 'message-queued',
      content: '@Worker second task with a longer body',
      mentions: [{ type: 'agent', participantId: 'agent-worker', displayName: 'Worker' }],
      executionQueueCapability: ownerCapability,
    })
    const queued = await queueUpdate
    expect(queued.items).toEqual([
      expect.objectContaining({
        roomId: 'room-1',
        messageId: 'message-queued',
        targetAgentId: 'agent-worker',
        targetAgentName: 'Worker',
        requesterMemberId: 'human-1',
        textSummary: '@Worker second task with a longer body',
        position: 1,
        status: 'queued',
      }),
    ])

    const restored = await emitAck<any>(observer, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    expect(restored.executionQueue).toEqual(queued.items)
    expect(JSON.stringify(restored.executionQueue)).not.toContain(ownerCapability)
    expect(JSON.stringify(restored.executionQueue)).not.toContain('cancelCapability')

    observer.disconnect()
    owner.disconnect()
    const impersonator = await connectGroupChatClient(harness.port, 'human-1', 'Owner', {
      inviteCode: 'ROOM1',
    })
    harness.sockets.push(impersonator)
    const impersonated = await emitAck<any>(impersonator, 'join', {
      roomId: 'room-1',
      inviteCode: 'ROOM1',
      name: 'Owner',
    })
    expect(impersonated.executionQueue).toEqual(queued.items)
    const forged = await emitAck<any>(impersonator, 'cancel_execution_queue_item', {
      roomId: 'room-1',
      queueId: queued.items[0].id,
      executionQueueCapability: attackerCapability,
    })
    expect(forged).toMatchObject({ error: 'Access denied' })

    impersonator.disconnect()
    const reconnectedOwner = await connectGroupChatClient(harness.port, 'human-1', 'Owner', {
      inviteCode: 'ROOM1',
    })
    harness.sockets.push(reconnectedOwner)
    const reconnected = await emitAck<any>(reconnectedOwner, 'join', {
      roomId: 'room-1',
      inviteCode: 'ROOM1',
      name: 'Owner',
    })
    expect(reconnected.executionQueue).toEqual(queued.items)

    const cancelled = await emitAck<any>(reconnectedOwner, 'cancel_execution_queue_item', {
      roomId: 'room-1',
      queueId: queued.items[0].id,
      executionQueueCapability: ownerCapability,
    })
    expect(cancelled).toMatchObject({ ok: true, status: 'cancelled' })
    expect(harness.groupServer.getStorage().getMessage('message-queued')).not.toBeNull()

    finishFirst()
    await vi.waitFor(() => expect(executor.replyToMention).toHaveBeenCalledTimes(1))
  })

  it('settles a cancel-versus-start race to exactly one authoritative state', () => {
    const storage = harness.groupServer.getStorage() as any
    const item = storage.enqueueExecutionQueueItem({
      roomId: 'room-1',
      messageId: 'race-message',
      targetAgentId: 'agent-worker',
      targetAgentName: 'Worker',
      requesterMemberId: 'human-1',
      cancelCapabilityHash: 'owner-capability-hash',
      textSummary: 'race',
    })

    const started = storage.startExecutionQueueItem(item.id)
    const cancelled = storage.cancelExecutionQueueItem('room-1', item.id, 'owner-capability-hash')

    expect([started, cancelled].filter(Boolean)).toHaveLength(1)
    expect(storage.getExecutionQueueItem(item.id).status).toBe(started ? 'running' : 'cancelled')

    const reverse = storage.enqueueExecutionQueueItem({
      roomId: 'room-1',
      messageId: 'reverse-race-message',
      targetAgentId: 'agent-worker',
      targetAgentName: 'Worker',
      requesterMemberId: 'human-1',
      cancelCapabilityHash: 'owner-capability-hash',
      textSummary: 'reverse race',
    })
    const reverseCancelled = storage.cancelExecutionQueueItem('room-1', reverse.id, 'owner-capability-hash')
    const reverseStarted = storage.startExecutionQueueItem(reverse.id)

    expect([reverseStarted, reverseCancelled].filter(Boolean)).toHaveLength(1)
    expect(storage.getExecutionQueueItem(reverse.id).status).toBe('cancelled')
  })
})

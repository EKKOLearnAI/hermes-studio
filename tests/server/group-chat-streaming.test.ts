import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
  once,
} from './group-chat-test-helpers'
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
  })

  afterEach(() => {
    harness?.cleanup()
  })

  async function joinPair() {
    const alice = await connectGroupChatClient(port, 'user-a', 'Alice')
    const bob = await connectGroupChatClient(port, 'user-b', 'Bob')
    harness.sockets.push(alice, bob)
    await emitAck(alice, 'join', { roomId: 'room-1' })
    await emitAck(bob, 'join', { roomId: 'room-1' })
    return { alice, bob }
  }

  it('relays stream start, content delta, reasoning delta, and stream end to room members', async () => {
    const { alice, bob } = await joinPair()

    const streamStart = once<any>(bob, 'message_stream_start')
    alice.emit('message_stream_start', { roomId: 'room-1', id: 'stream-1', senderName: 'Worker', timestamp: 10 })
    expect(await streamStart).toMatchObject({
      id: 'stream-1',
      roomId: 'room-1',
      senderName: 'Worker',
      role: 'assistant',
      finish_reason: 'streaming',
    })

    const contentDelta = once<any>(bob, 'message_stream_delta')
    alice.emit('message_stream_delta', { roomId: 'room-1', id: 'stream-1', delta: 'hello' })
    expect(await contentDelta).toEqual({ roomId: 'room-1', id: 'stream-1', delta: 'hello' })

    const reasoningDelta = once<any>(bob, 'message_reasoning_delta')
    alice.emit('message_reasoning_delta', { roomId: 'room-1', id: 'stream-1', delta: 'thinking' })
    expect(await reasoningDelta).toEqual({ roomId: 'room-1', id: 'stream-1', delta: 'thinking' })

    const streamEnd = once<any>(bob, 'message_stream_end')
    alice.emit('message_stream_end', { roomId: 'room-1', id: 'stream-1' })
    expect(await streamEnd).toEqual({ roomId: 'room-1', id: 'stream-1' })
  })

  it('ignores a representative invalid stream id', async () => {
    const { alice, bob } = await joinPair()
    const unexpected = once<any>(bob, 'message_stream_start', 100)

    alice.emit('message_stream_start', { roomId: 'room-1', id: 'bad id with spaces' })

    await expect(unexpected).rejects.toThrow('timeout waiting for message_stream_start')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
  once,
} from './group-chat-test-helpers'
import type { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

describe('group chat baseline behavior', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let port: number

  beforeEach(async () => {
    vi.clearAllMocks()
    harness = await createTestGroupChatServer()
    groupServer = harness.groupServer
    port = harness.port
  })

  afterEach(() => {
    harness?.cleanup()
  })

  it('joins an existing room and returns room-level history and membership', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    storage.saveMessageAndRefreshRoom({
      id: 'msg-1',
      roomId: 'room-1',
      senderId: 'user-a',
      senderName: 'Alice',
      content: 'existing',
      timestamp: 1,
      role: 'user',
    } as any)

    const alice = await connectGroupChatClient(port, 'user-a', 'Alice')
    harness.sockets.push(alice)
    const joined = await emitAck<any>(alice, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    expect(joined).toMatchObject({ roomId: 'room-1', mentionProtocolVersion: 2 })
    expect(joined.messages.map((m: any) => m.id)).toEqual(['msg-1'])
    expect(joined.members.map((m: any) => m.name)).toContain('Alice')
  })

  it('rejects stale clients that send structured mention metadata after a server upgrade', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const staleClient = await connectGroupChatClient(port, 'user-stale', 'Stale Client', {
      mentionProtocolVersion: undefined,
    })
    harness.sockets.push(staleClient)
    await emitAck(staleClient, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const ack = await emitAck<any>(staleClient, 'message', {
      roomId: 'room-1',
      id: 'stale-structured-message',
      content: '@Worker continue',
      mentions: [],
    })

    expect(ack).toEqual({
      error: expect.stringMatching(/refresh/i),
      code: 'GROUP_CHAT_CLIENT_REFRESH_REQUIRED',
    })
    expect(storage.getMessage('stale-structured-message')).toBeNull()

    const legacyTextAck = await emitAck<any>(staleClient, 'message', {
      roomId: 'room-1',
      id: 'legacy-text-message',
      content: 'plain legacy text',
    })
    expect(legacyTextAck).toEqual({ id: 'legacy-text-message' })
    expect(storage.getMessage('legacy-text-message')).toMatchObject({
      content: 'plain legacy text',
    })
  })

  it('preserves explicit-empty fail-closed semantics for a current structured client', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const currentClient = await connectGroupChatClient(port, 'user-current', 'Current Client')
    harness.sockets.push(currentClient)
    await emitAck(currentClient, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const ack = await emitAck<any>(currentClient, 'message', {
      roomId: 'room-1',
      id: 'current-empty-structured-message',
      content: '@Worker do not route this text fallback',
      mentions: [],
    })

    expect(ack).toEqual({ id: 'current-empty-structured-message' })
    expect(storage.getMessage('current-empty-structured-message')).toMatchObject({ mentions: [] })
    expect(storage.listHandoffJobs('room-1')).toEqual([])
  })

  it('persists a sent message and broadcasts it to other room members', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const alice = await connectGroupChatClient(port, 'user-a', 'Alice')
    const bob = await connectGroupChatClient(port, 'user-b', 'Bob')
    harness.sockets.push(alice, bob)
    await emitAck(alice, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(bob, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const seenByBob = once<any>(bob, 'message')
    const ack = await emitAck<any>(alice, 'message', { roomId: 'room-1', id: 'client-msg-1', content: 'hello room' })
    const broadcast = await seenByBob

    expect(ack).toEqual({ id: 'client-msg-1' })
    expect(broadcast).toMatchObject({ id: 'client-msg-1', roomId: 'room-1', senderName: 'Alice', content: 'hello room', role: 'user' })
    expect(storage.getMessage('client-msg-1')).toMatchObject({ content: 'hello room', senderName: 'Alice' })
  })
})

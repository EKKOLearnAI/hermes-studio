import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
  once,
  rejectGroupChatClient,
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

    expect(joined).toMatchObject({ roomId: 'room-1' })
    expect(joined.messages.map((m: any) => m.id)).toEqual(['msg-1'])
    expect(joined.members.map((m: any) => m.name)).toContain('Alice')
  })

  it('authenticates an invite-only socket and scopes it to the invited room', async () => {
    harness.cleanup()
    harness = await createTestGroupChatServer({ authEnabled: true })
    groupServer = harness.groupServer
    port = harness.port

    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    storage.saveRoom('room-2', 'Other Room', 'ROOM2')

    const guest = await connectGroupChatClient(port, 'guest-1', 'Guest', { inviteCode: 'ROOM1' })
    harness.sockets.push(guest)

    const joined = await emitAck<any>(guest, 'join', { roomId: 'room-1', name: 'Guest' })
    const denied = await emitAck<any>(guest, 'join', { roomId: 'room-2', inviteCode: 'ROOM2' })

    expect(joined).toMatchObject({ roomId: 'room-1', rooms: ['room-1'] })
    expect(denied).toEqual({ error: 'Access denied' })
  })

  it('keeps invite-only sockets scoped when account authentication is disabled', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    storage.saveRoom('room-2', 'Other Room', 'ROOM2')

    const guest = await connectGroupChatClient(port, 'guest-1', 'Guest', { inviteCode: 'ROOM1' })
    harness.sockets.push(guest)

    const joined = await emitAck<any>(guest, 'join', { roomId: 'room-1', name: 'Guest' })
    const denied = await emitAck<any>(guest, 'join', { roomId: 'room-2', inviteCode: 'ROOM2' })
    const managementDenied = await emitAck<any>(guest, 'interrupt_agent', {
      roomId: 'room-1',
      agentName: 'Agent',
    })

    expect(joined).toMatchObject({ roomId: 'room-1', rooms: ['room-1'] })
    expect(denied).toEqual({ error: 'Access denied' })
    expect(managementDenied).toEqual({ error: 'Access denied' })
    await expect(rejectGroupChatClient(port, {
      userId: 'invalid-guest',
      name: 'Invalid Guest',
      inviteCode: 'INVALID',
    })).resolves.toBe('Unauthorized')
  })

  it('requires invite guests to choose a unique room participant name', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    storage.addRoomAgent('room-1', 'agent-worker', 'default', 'Worker', '', 0)

    const unnamed = await connectGroupChatClient(port, 'guest-unnamed', 'Ignored', { inviteCode: 'ROOM1' })
    const alice = await connectGroupChatClient(port, 'guest-alice', 'Alice', { inviteCode: 'ROOM1' })
    const duplicateUser = await connectGroupChatClient(port, 'guest-alice-2', 'Alice 2', { inviteCode: 'ROOM1' })
    const duplicateAgent = await connectGroupChatClient(port, 'guest-worker', 'Worker Guest', { inviteCode: 'ROOM1' })
    harness.sockets.push(unnamed, alice, duplicateUser, duplicateAgent)

    await expect(emitAck<any>(unnamed, 'join', { roomId: 'room-1' })).resolves.toEqual({
      code: 'ROOM_PARTICIPANT_NAME_REQUIRED',
      error: 'Name is required',
    })
    await expect(emitAck<any>(alice, 'join', { roomId: 'room-1', name: 'Alice' })).resolves.toMatchObject({
      roomId: 'room-1',
    })
    await expect(emitAck<any>(duplicateUser, 'join', { roomId: 'room-1', name: '  alice  ' })).resolves.toEqual({
      code: 'ROOM_PARTICIPANT_NAME_CONFLICT',
      error: 'Name is already in use in this room',
    })
    await expect(emitAck<any>(duplicateAgent, 'join', { roomId: 'room-1', name: 'worker' })).resolves.toEqual({
      code: 'ROOM_PARTICIPANT_NAME_CONFLICT',
      error: 'Name is already in use in this room',
    })
  })

  it('stores only validated room-scoped avatars for invite guests', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    const validAvatar = JSON.stringify({
      type: 'image',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    })

    const guest = await connectGroupChatClient(port, 'guest-avatar', 'Guest', { inviteCode: 'ROOM1' })
    const invalidGuest = await connectGroupChatClient(port, 'guest-avatar-invalid', 'Guest 2', { inviteCode: 'ROOM1' })
    harness.sockets.push(guest, invalidGuest)

    const joined = await emitAck<any>(guest, 'join', {
      roomId: 'room-1',
      name: 'Avatar Guest',
      avatar: validAvatar,
    })
    expect(joined.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'guest-avatar', avatar: validAvatar }),
    ]))
    expect(storage.getMemberByUserId('room-1', 'guest-avatar')).toMatchObject({
      avatar: validAvatar,
    })

    await expect(emitAck<any>(invalidGuest, 'join', {
      roomId: 'room-1',
      name: 'Invalid Avatar Guest',
      avatar: JSON.stringify({
        type: 'image',
        dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      }),
    })).resolves.toEqual({
      code: 'ROOM_PARTICIPANT_AVATAR_INVALID',
      error: 'Invalid member avatar',
    })
  })

  it('rejects duplicate names across member and Agent persistence paths', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    storage.addRoomMember('room-1', 'user-alice', 'Alice', '')
    const worker = storage.addRoomAgent('room-1', 'agent-worker', 'default', 'Worker', '', 0)

    expect(() => storage.addRoomAgent('room-1', 'agent-alice', 'default', 'alice', '', 0))
      .toThrowError(expect.objectContaining({ code: 'ROOM_PARTICIPANT_NAME_CONFLICT' }))
    expect(() => storage.addRoomMember('room-1', 'user-worker', 'WORKER', ''))
      .toThrowError(expect.objectContaining({ code: 'ROOM_PARTICIPANT_NAME_CONFLICT' }))
    expect(() => storage.updateRoomAgent('room-1', worker.id, 'default', 'ALICE', ''))
      .toThrowError(expect.objectContaining({ code: 'ROOM_PARTICIPANT_NAME_CONFLICT' }))
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

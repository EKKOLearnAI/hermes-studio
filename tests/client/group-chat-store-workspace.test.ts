// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const groupChatApiMock = vi.hoisted(() => ({
  connectGroupChat: vi.fn(),
  disconnectGroupChat: vi.fn(),
  getSocket: vi.fn(() => null),
  getStoredUserId: vi.fn(() => 'user-1'),
  getStoredUserName: vi.fn(() => 'tester'),
  createRoom: vi.fn(),
  listRooms: vi.fn(),
  getRoomDetail: vi.fn(),
  joinRoomByCode: vi.fn(),
  addAgent: vi.fn(),
  listAgents: vi.fn(),
  removeAgent: vi.fn(),
  cloneRoom: vi.fn(),
  deleteRoom: vi.fn(),
  clearRoomContext: vi.fn(),
  updateRoomWorkspace: vi.fn(),
}))

vi.mock('@/api/hermes/group-chat', () => groupChatApiMock)
vi.mock('@/api/client', () => ({
  getApiKey: vi.fn(() => 'token'),
  getActiveProfileName: vi.fn(() => 'default'),
  getStoredUsername: vi.fn(() => null),
}))
vi.mock('@/api/auth', () => ({ fetchCurrentUser: vi.fn(async () => { throw new Error('no user') }) }))
vi.mock('@/api/hermes/download', () => ({ getDownloadUrl: vi.fn((path: string) => `/download?path=${path}`) }))

describe('group chat store workspace', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('passes selected workspace when creating a room', async () => {
    const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
    const store = useGroupChatStore()
    groupChatApiMock.createRoom.mockResolvedValue({
      room: { id: 'room-1', name: 'Room 1', inviteCode: null, workspace: '/tmp/repo' },
      agents: [],
    })

    await store.createNewRoom('Room 1', 'invite-1', [], { triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10 }, '/tmp/repo')

    expect(groupChatApiMock.createRoom).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Room 1',
      inviteCode: 'invite-1',
      workspace: '/tmp/repo',
    }))
    expect(store.rooms[0].workspace).toBe('/tmp/repo')
  })

  it('updates the rooms list after the workspace API succeeds', async () => {
    const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
    const store = useGroupChatStore()
    store.rooms = [{ id: 'room-1', name: 'Room 1', inviteCode: null, workspace: '' }]
    groupChatApiMock.updateRoomWorkspace.mockResolvedValue({
      room: { id: 'room-1', name: 'Room 1', inviteCode: null, workspace: '/tmp/repo' },
    })

    await store.setRoomWorkspace('room-1', '/tmp/repo')

    expect(groupChatApiMock.updateRoomWorkspace).toHaveBeenCalledWith('room-1', '/tmp/repo')
    expect(store.rooms[0].workspace).toBe('/tmp/repo')
  })

  it('clears workspace through the same API path', async () => {
    const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
    const store = useGroupChatStore()
    store.rooms = [{ id: 'room-1', name: 'Room 1', inviteCode: null, workspace: '/tmp/repo' }]
    groupChatApiMock.updateRoomWorkspace.mockResolvedValue({
      room: { id: 'room-1', name: 'Room 1', inviteCode: null, workspace: '' },
    })

    await store.setRoomWorkspace('room-1', '')

    expect(store.rooms[0].workspace).toBe('')
  })

  it('does not mutate local workspace when the API rejects', async () => {
    const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
    const store = useGroupChatStore()
    store.rooms = [{ id: 'room-1', name: 'Room 1', inviteCode: null, workspace: '/tmp/repo' }]
    groupChatApiMock.updateRoomWorkspace.mockRejectedValue(new Error('invalid workspace'))

    await expect(store.setRoomWorkspace('room-1', '/outside')).rejects.toThrow('invalid workspace')

    expect(store.rooms[0].workspace).toBe('/tmp/repo')
  })
})

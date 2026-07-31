// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const socketIoMock = vi.hoisted(() => {
  const socket = {
    connected: false,
    disconnect: vi.fn(),
  }
  return {
    socket,
    io: vi.fn(() => socket),
  }
})

vi.mock('socket.io-client', () => ({ io: socketIoMock.io }))
vi.mock('@/api/client', () => ({
  getApiKey: () => 'test-token',
  request: vi.fn(),
}))

import { connectGroupChat, disconnectGroupChat } from '@/api/hermes/group-chat'

describe('group chat client protocol handshake', () => {
  beforeEach(() => {
    localStorage.clear()
    socketIoMock.io.mockClear()
    socketIoMock.socket.disconnect.mockClear()
  })

  afterEach(() => {
    disconnectGroupChat()
  })

  it('declares the structured mention protocol version when opening the realtime socket', () => {
    connectGroupChat({ userId: 'user-1', userName: 'Alice' })

    expect(socketIoMock.io).toHaveBeenCalledWith('/group-chat', expect.objectContaining({
      auth: expect.objectContaining({
        userId: 'user-1',
        name: 'Alice',
        mentionProtocolVersion: 1,
      }),
    }))
  })
})

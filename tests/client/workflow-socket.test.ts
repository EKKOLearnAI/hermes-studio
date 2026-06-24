import { beforeEach, describe, expect, it, vi } from 'vitest'

const ioMock = vi.hoisted(() => vi.fn())
const sockets = vi.hoisted(() => [] as Array<{ connected: boolean; disconnect: ReturnType<typeof vi.fn> }>)

vi.mock('socket.io-client', () => ({
  io: ioMock,
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
  getApiKey: vi.fn(() => 'test-key'),
  getBaseUrlValue: vi.fn(() => 'http://localhost:3000'),
}))

describe('workflow socket client', () => {
  beforeEach(() => {
    vi.resetModules()
    ioMock.mockReset()
    sockets.splice(0)
    ioMock.mockImplementation(() => {
      const socket = {
        connected: false,
        disconnect: vi.fn(),
      }
      sockets.push(socket)
      return socket
    })
  })

  it('reuses the pending socket for the same profile', async () => {
    const { connectWorkflowSocket } = await import('@/api/hermes/workflow-socket')

    const first = connectWorkflowSocket('default')
    const second = connectWorkflowSocket('default')

    expect(second).toBe(first)
    expect(ioMock).toHaveBeenCalledTimes(1)
    expect(sockets[0].disconnect).not.toHaveBeenCalled()
  })

  it('recreates the socket when the profile changes', async () => {
    const { connectWorkflowSocket } = await import('@/api/hermes/workflow-socket')

    connectWorkflowSocket('default')
    connectWorkflowSocket('travel')

    expect(ioMock).toHaveBeenCalledTimes(2)
    expect(sockets[0].disconnect).toHaveBeenCalledTimes(1)
  })
})

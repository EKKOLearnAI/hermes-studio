import { beforeEach, describe, expect, it, vi } from 'vitest'

const ioMock = vi.hoisted(() => vi.fn())
const sockets = vi.hoisted(() => [] as Array<any>)

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
      const listeners = new Map<string, Set<(payload: any) => void>>()
      const socket = {
        connected: false,
        disconnect: vi.fn(),
        on: vi.fn((event: string, handler: (payload: any) => void) => {
          const handlers = listeners.get(event) || new Set()
          handlers.add(handler)
          listeners.set(event, handlers)
          return socket
        }),
        off: vi.fn((event: string, handler: (payload: any) => void) => {
          listeners.get(event)?.delete(handler)
          return socket
        }),
        trigger: (event: string, payload: any) => {
          for (const handler of listeners.get(event) || []) handler(payload)
        },
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

  it('exposes the fail-closed persisted-evidence error event and removes its listener', async () => {
    const { onWorkflowStatusError } = await import('@/api/hermes/workflow-socket')
    const handler = vi.fn()
    const dispose = onWorkflowStatusError(handler, 'default')
    const error = { workflowId: 'wf-1', runId: 'run-1', error: 'edge evidence read failed' }
    sockets[0].trigger('workflow.status.error', error)
    expect(handler).toHaveBeenCalledWith(error)
    dispose()
    sockets[0].trigger('workflow.status.error', error)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(sockets[0].off).toHaveBeenCalledWith('workflow.status.error', handler)
  })

})

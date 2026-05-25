import { beforeEach, describe, expect, it, vi } from 'vitest'

const socketState = vi.hoisted(() => ({
  sockets: [] as any[],
}))

vi.mock('socket.io-client', () => {
  function createSocket() {
    const listeners = new Map<string, Set<(...args: any[]) => void>>()

    const addListener = (event: string, handler: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    }

    const removeListener = (event: string, handler: (...args: any[]) => void) => {
      const eventListeners = listeners.get(event)
      if (!eventListeners) return
      for (const candidate of [...eventListeners]) {
        if (candidate === handler || (candidate as any).__original === handler) {
          eventListeners.delete(candidate)
        }
      }
    }

    const socket: any = {
      connected: true,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        addListener(event, handler)
        return socket
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        const wrapped = (...args: any[]) => {
          removeListener(event, wrapped)
          handler(...args)
        }
        ;(wrapped as any).__original = handler
        addListener(event, wrapped)
        return socket
      }),
      off: vi.fn((event: string, handler: (...args: any[]) => void) => {
        removeListener(event, handler)
        return socket
      }),
      removeListener: vi.fn((event: string, handler: (...args: any[]) => void) => {
        removeListener(event, handler)
        return socket
      }),
      removeAllListeners: vi.fn(() => {
        listeners.clear()
        return socket
      }),
      emit: vi.fn(),
      disconnect: vi.fn(() => {
        socket.connected = false
      }),
      __listenerCount: (event: string) => listeners.get(event)?.size || 0,
      __trigger: (event: string, ...args: any[]) => {
        if (event === 'connect') socket.connected = true
        if (event === 'disconnect') socket.connected = false
        for (const handler of [...(listeners.get(event) || [])]) handler(...args)
      },
    }

    return socket
  }

  return {
    io: vi.fn(() => {
      const socket = createSocket()
      socketState.sockets.push(socket)
      return socket
    }),
  }
})

vi.mock('../../packages/client/src/api/client', () => ({
  getApiKey: () => 'test-token',
  getBaseUrlValue: () => '',
}))

describe('chat-run socket reconnect handling', () => {
  beforeEach(() => {
    vi.resetModules()
    socketState.sockets = []
  })

  it('keeps transient mobile disconnects alive and resumes after reconnect', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onEvent = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    const onReconnectResume = vi.fn()

    startRunViaSocket(
      { session_id: 'session-1', input: 'hello', profile: 'default', source: 'cli' },
      onEvent,
      onDone,
      onError,
      undefined,
      { onReconnectResume },
    )

    const socket = socketState.sockets[0]
    expect(socket.emit).toHaveBeenCalledWith('run', expect.objectContaining({ session_id: 'session-1' }))

    socket.__trigger('disconnect', 'ping timeout')
    expect(onError).not.toHaveBeenCalled()

    socket.__trigger('connect_error', new Error('temporary reconnect failure'))
    expect(onError).not.toHaveBeenCalled()

    socket.__trigger('connect')
    expect(socket.emit).toHaveBeenCalledWith('resume', { session_id: 'session-1', profile: 'default' })

    const resumed = { session_id: 'session-1', messages: [], isWorking: true, events: [] }
    socket.__trigger('resumed', resumed)
    expect(onReconnectResume).toHaveBeenCalledWith(resumed)

    socket.__trigger('message.delta', { event: 'message.delta', session_id: 'session-1', delta: 'after reconnect' })
    expect(onEvent).toHaveBeenCalledWith({ event: 'message.delta', session_id: 'session-1', delta: 'after reconnect' })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('keeps fatal disconnects fatal and removes per-run listeners', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const onError = vi.fn()

    startRunViaSocket(
      { session_id: 'session-1', input: 'hello', profile: 'default', source: 'cli' },
      vi.fn(),
      vi.fn(),
      onError,
    )

    const socket = socketState.sockets[0]
    socket.__trigger('disconnect', 'io server disconnect')

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].message).toBe('Socket disconnected: io server disconnect')
    expect(socket.__listenerCount('connect')).toBe(0)
    expect(socket.__listenerCount('disconnect')).toBe(0)
    expect(socket.__listenerCount('connect_error')).toBe(0)
  })

  it('does not attach extra reconnect listeners when the session already has handlers', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/hermes/chat')
    const body = { session_id: 'session-1', input: 'hello', profile: 'default', source: 'cli' as const }

    startRunViaSocket(body, vi.fn(), vi.fn(), vi.fn())
    const socket = socketState.sockets[0]
    expect(socket.__listenerCount('connect')).toBe(1)
    expect(socket.__listenerCount('disconnect')).toBe(1)

    startRunViaSocket(body, vi.fn(), vi.fn(), vi.fn())
    expect(socket.__listenerCount('connect')).toBe(1)
    expect(socket.__listenerCount('disconnect')).toBe(1)
    expect(socket.emit).toHaveBeenCalledWith('run', body)
  })
})

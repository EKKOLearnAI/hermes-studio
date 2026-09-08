import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const closeDbMock = vi.hoisted(() => vi.fn())
const stopPreviewRuntimeMock = vi.hoisted(() => vi.fn(async () => {}))
const shutdownManagedGatewaysMock = vi.hoisted(() => vi.fn(async () => ({ stopped: 0 })))
const forceStopManagedGatewaysMock = vi.hoisted(() => vi.fn())
const stopOutboundRelayClientMock = vi.hoisted(() => vi.fn())
const codingAgentShutdownMock = vi.hoisted(() => vi.fn())
const shutdownLocalSttRuntimeMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ closeDb: closeDbMock }))
vi.mock('../../packages/server/src/bootstrap/update', () => ({ stopPreviewRuntime: stopPreviewRuntimeMock }))
vi.mock('../../packages/server/src/modules/hermes/services/gateway/runner', () => ({
  forceStopManagedGateways: forceStopManagedGatewaysMock,
  shutdownManagedGateways: shutdownManagedGatewaysMock,
}))
vi.mock('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager', () => ({
  shutdownLocalSttRuntime: shutdownLocalSttRuntimeMock,
}))
vi.mock('../../packages/server/src/modules/studio/public/global-agent', () => ({
  stopOutboundRelayClient: stopOutboundRelayClientMock,
}))
vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: { shutdown: codingAgentShutdownMock },
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ closeDb: closeDbMock }))
vi.mock('../../packages/server/src/bootstrap/update', () => ({ stopPreviewRuntime: stopPreviewRuntimeMock }))
vi.mock('../../packages/server/src/modules/hermes/services/gateway/runner', () => ({
  forceStopManagedGateways: forceStopManagedGatewaysMock,
  shutdownManagedGateways: shutdownManagedGatewaysMock,
}))
vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: { shutdown: codingAgentShutdownMock },
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/studio/services/app-relay/client', () => ({
  stopAppRelayClient: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/ekko/services/manager', () => ({
  closeGlobalEkkoAgent: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/services/webhooks', () => ({
  stopChatWebhookDispatcher: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/services/social-messages', () => ({
  shutdownSocialMessageRuntimes: vi.fn(async () => {}),
}))

describe('graceful shutdown background delivery ordering', () => {
  const originalStopBridge = process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN = '1'
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalStopBridge === undefined) delete process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN
    else process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN = originalStopBridge
  })

  it('awaits ChatRunSocket claim release before stopping the Hermes bridge', async () => {
    const order: string[] = []
    const chatRunServer = {
      close: vi.fn(async () => {
        order.push('chat-run-close')
      }),
    }
    const agentBridgeManager = {
      stop: vi.fn(async () => {
        order.push('bridge-stop')
      }),
    }
    const groupChatServer = {
      agentClients: { disconnectAll: vi.fn(() => order.push('agent-clients-close')) },
      getIO: vi.fn(() => ({ close: vi.fn(() => order.push('socket-io-close')) })),
    }
    const httpServer = {
      close: vi.fn((callback: () => void) => {
        order.push('http-close')
        callback()
      }),
    }
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const { createShutdownHandler } = await import('../../packages/server/src/bootstrap/lifecycle')

    await createShutdownHandler(httpServer, groupChatServer, chatRunServer, agentBridgeManager)('desktop-request')

    expect(order).toEqual([
      'chat-run-close',
      'bridge-stop',
      'agent-clients-close',
      'socket-io-close',
      'http-close',
    ])
    expect(closeDbMock).toHaveBeenCalledOnce()
    expect(shutdownLocalSttRuntimeMock).toHaveBeenCalledOnce()
    expect(process.exit).toHaveBeenCalledWith(0)
  })

  it('force-stops the bridge process tree immediately on Windows', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const agentBridgeManager = {
        stop: vi.fn(async () => {}),
        forceStop: vi.fn(),
      }
      const httpServer = {
        close: vi.fn((callback: () => void) => callback()),
      }
      vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      const { createShutdownHandler } = await import('../../packages/server/src/bootstrap/lifecycle')

      await createShutdownHandler(httpServer, undefined, undefined, agentBridgeManager)('desktop-request')

      expect(agentBridgeManager.forceStop).toHaveBeenCalledOnce()
      expect(agentBridgeManager.stop).not.toHaveBeenCalled()
      expect(process.exit).toHaveBeenCalledWith(0)
    } finally {
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('force-kills the bridge before the shutdown deadline exits the server', async () => {
    stopPreviewRuntimeMock.mockImplementationOnce(() => new Promise<void>(() => {}))
    const agentBridgeManager = {
      stop: vi.fn(async () => {}),
      forceStop: vi.fn(),
    }
    const httpServer = { close: vi.fn() }
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const { createShutdownHandler, getShutdownForceExitMs } = await import('../../packages/server/src/bootstrap/lifecycle')

    void createShutdownHandler(httpServer, undefined, undefined, agentBridgeManager)('desktop-request')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(getShutdownForceExitMs())

    expect(forceStopManagedGatewaysMock).toHaveBeenCalledOnce()
    expect(agentBridgeManager.forceStop).toHaveBeenCalledOnce()
    expect(codingAgentShutdownMock).toHaveBeenCalledOnce()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('preserves the configured bridge across the forced shutdown deadline', async () => {
    process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN = '0'
    stopPreviewRuntimeMock.mockImplementationOnce(() => new Promise<void>(() => {}))
    const agentBridgeManager = {
      stop: vi.fn(async () => {}),
      forceStop: vi.fn(),
    }
    const httpServer = { close: vi.fn() }
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const { createShutdownHandler, getShutdownForceExitMs } = await import('../../packages/server/src/bootstrap/lifecycle')

    void createShutdownHandler(httpServer, undefined, undefined, agentBridgeManager)('desktop-request')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(getShutdownForceExitMs())

    expect(forceStopManagedGatewaysMock).toHaveBeenCalledOnce()
    expect(agentBridgeManager.stop).not.toHaveBeenCalled()
    expect(agentBridgeManager.forceStop).not.toHaveBeenCalled()
    expect(codingAgentShutdownMock).toHaveBeenCalledOnce()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('continues cleanup after one runtime fails and preserves a fatal exit code', async () => {
    const order: string[] = []
    const httpServer = {
      close: vi.fn((callback: () => void) => {
        order.push('http-close')
        callback()
      }),
    }
    const firstClose = vi.fn(async () => {
      order.push('first-close')
      throw new Error('close failed')
    })
    const secondClose = vi.fn(() => {
      order.push('second-close')
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const { createShutdownHandler } = await import('../../packages/server/src/bootstrap/lifecycle')

    await createShutdownHandler(httpServer, undefined, undefined, undefined, [
      { name: 'first runtime', close: firstClose },
      { name: 'second runtime', close: secondClose },
    ])('bootstrap-error', 1)

    expect(order).toEqual(['first-close', 'second-close', 'http-close'])
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(closeDbMock).toHaveBeenCalledOnce()
  })
})

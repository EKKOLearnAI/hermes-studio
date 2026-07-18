import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const closeDbMock = vi.hoisted(() => vi.fn())
const stopPreviewRuntimeMock = vi.hoisted(() => vi.fn(async () => {}))
const shutdownManagedGatewaysMock = vi.hoisted(() => vi.fn(async () => ({ stopped: 0 })))
const stopOutboundRelayClientMock = vi.hoisted(() => vi.fn())
const codingAgentShutdownMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db', () => ({ closeDb: closeDbMock }))
vi.mock('../../packages/server/src/controllers/update', () => ({ stopPreviewRuntime: stopPreviewRuntimeMock }))
vi.mock('../../packages/server/src/services/hermes/gateway-runner', () => ({
  shutdownManagedGateways: shutdownManagedGatewaysMock,
}))
vi.mock('../../packages/server/src/services/global-agent/outbound-relay-client', () => ({
  stopOutboundRelayClient: stopOutboundRelayClientMock,
}))
vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({
  codingAgentRunManager: { shutdown: codingAgentShutdownMock },
}))
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    const { createShutdownHandler } = await import('../../packages/server/src/services/shutdown')

    await createShutdownHandler(httpServer, groupChatServer, chatRunServer, agentBridgeManager)('desktop-request')

    expect(order).toEqual([
      'chat-run-close',
      'bridge-stop',
      'agent-clients-close',
      'socket-io-close',
      'http-close',
    ])
    expect(closeDbMock).toHaveBeenCalledOnce()
    expect(process.exit).toHaveBeenCalledWith(0)
  })
})

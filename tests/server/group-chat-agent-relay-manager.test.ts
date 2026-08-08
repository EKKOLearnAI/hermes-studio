import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ioMock, relayConnectError } = vi.hoisted(() => ({
  ioMock: vi.fn(),
  relayConnectError: { message: '' },
}))

vi.mock('socket.io-client', () => ({ io: ioMock }))

function createRejectedRelaySocket(message: string) {
  const onceHandlers = new Map<string, (value: unknown) => void>()
  const socket = {
    active: false,
    connected: false,
    auth: {},
    on: vi.fn(() => socket),
    once: vi.fn((event: string, handler: (value: unknown) => void) => {
      onceHandlers.set(event, handler)
      return socket
    }),
    emit: vi.fn(() => socket),
    disconnect: vi.fn(() => socket),
  }
  queueMicrotask(() => onceHandlers.get('connect_error')?.(new Error(message)))
  return socket
}

function createReadyRelaySocket(connectorId: string) {
  const onHandlers = new Map<string, Array<(value: unknown) => void>>()
  const onceHandlers = new Map<string, (value: unknown) => void>()
  const socket = {
    active: true,
    connected: true,
    auth: {},
    on: vi.fn((event: string, handler: (value: unknown) => void) => {
      const handlers = onHandlers.get(event) || []
      handlers.push(handler)
      onHandlers.set(event, handlers)
      return socket
    }),
    once: vi.fn((event: string, handler: (value: unknown) => void) => {
      onceHandlers.set(event, handler)
      return socket
    }),
    emit: vi.fn(() => socket),
    disconnect: vi.fn(() => {
      socket.connected = false
      socket.active = false
      return socket
    }),
    trigger(event: string, value: unknown) {
      for (const handler of onHandlers.get(event) || []) handler(value)
    },
  }
  queueMicrotask(() => onceHandlers.get('relay.ready')?.({
    connectorId,
    agent: {
      agent: 'hermes',
      profile: 'default',
      name: 'Remote Agent',
    },
  }))
  return socket
}

describe('group Agent outbound Relay persistence', () => {
  let stateDir = ''
  let originalWebUiHome: string | undefined
  let originalStateDir: string | undefined

  beforeEach(() => {
    originalWebUiHome = process.env.HERMES_WEB_UI_HOME
    originalStateDir = process.env.HERMES_WEBUI_STATE_DIR
    stateDir = mkdtempSync(join(tmpdir(), 'group-agent-relay-manager-'))
    process.env.HERMES_WEB_UI_HOME = stateDir
    process.env.HERMES_WEBUI_STATE_DIR = stateDir
    relayConnectError.message = ''
    ioMock.mockReset()
    ioMock.mockImplementation(() => createRejectedRelaySocket(relayConnectError.message))
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    rmSync(stateDir, { recursive: true, force: true })
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
    if (originalStateDir === undefined) delete process.env.HERMES_WEBUI_STATE_DIR
    else process.env.HERMES_WEBUI_STATE_DIR = originalStateDir
  })

  async function restorePersistedConnection(errorMessage: string) {
    const connectorId = '11111111-2222-4333-8444-555555555555'
    const linksFile = join(stateDir, 'group-chat-agent-links.json')
    writeFileSync(linksFile, `${JSON.stringify([{
      cloudOrigin: 'https://cloud.example',
      targetOrigin: 'http://127.0.0.1:8648',
      connectorId,
      credential: 'c'.repeat(48),
      agent: {
        agent: 'hermes',
        profile: 'default',
        name: 'Remote Agent',
      },
    }], null, 2)}\n`)
    relayConnectError.message = errorMessage
    const { GroupAgentOutboundRelayManager } = await import(
      '../../packages/server/src/services/hermes/group-chat/agent-relay'
    )
    const manager = new GroupAgentOutboundRelayManager(() => null)
    await manager.restore()
    return { connectorId, linksFile, manager }
  }

  it('forgets a persisted connector after the cloud rejects its revoked credential', async () => {
    const { linksFile, manager } = await restorePersistedConnection(
      'Invalid or revoked reconnect credential',
    )

    await vi.waitFor(async () => {
      await expect(manager.listConnections()).resolves.toEqual([])
    })
    expect(JSON.parse(readFileSync(linksFile, 'utf8'))).toEqual([])
    manager.shutdown()
  })

  it('keeps a persisted connector when the Relay is only temporarily offline', async () => {
    const { connectorId, linksFile, manager } = await restorePersistedConnection(
      'websocket connection unavailable',
    )

    await vi.waitFor(async () => {
      await expect(manager.listConnections()).resolves.toEqual([
        expect.objectContaining({ connectorId, connected: false }),
      ])
    })
    expect(JSON.parse(readFileSync(linksFile, 'utf8'))).toHaveLength(1)
    manager.shutdown()
  })

  it('stops reconnecting and forgets the link when the cloud pushes a revocation', async () => {
    const connectorId = '11111111-2222-4333-8444-555555555555'
    let relaySocket: ReturnType<typeof createReadyRelaySocket> | undefined
    ioMock.mockImplementation(() => {
      relaySocket = createReadyRelaySocket(connectorId)
      return relaySocket
    })
    const { linksFile, manager } = await restorePersistedConnection('')
    await vi.waitFor(async () => {
      await expect(manager.listConnections()).resolves.toEqual([
        expect.objectContaining({ connectorId, connected: true }),
      ])
    })

    relaySocket!.trigger('connector.revoked', { connectorId })

    await vi.waitFor(async () => {
      await expect(manager.listConnections()).resolves.toEqual([])
    })
    expect(relaySocket!.disconnect).toHaveBeenCalled()
    expect(JSON.parse(readFileSync(linksFile, 'utf8'))).toEqual([])
    manager.shutdown()
  })
})

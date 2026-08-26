import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    emit: vi.fn((event: string, _payload?: unknown, ack?: (value: unknown) => void) => {
      if (event === 'connector.revoke') ack?.({ ok: true })
      return socket
    }),
    disconnect: vi.fn(() => socket),
  }
  queueMicrotask(() => onceHandlers.get('connect_error')?.(new Error(message)))
  return socket
}

function createReadyRelaySocket(
  connectorId: string,
  options: { credential?: string; roomId?: string; roomName?: string; inviteCode?: string } = {},
) {
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
    emit: vi.fn((event: string, _payload?: unknown, ack?: (value: unknown) => void) => {
      if (event === 'connector.revoke') ack?.({ ok: true })
      return socket
    }),
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
    roomId: options.roomId || 'room-relay',
    roomName: options.roomName || 'Relay Room',
    inviteCode: options.inviteCode || 'RELAY1',
    ...(options.credential ? { credential: options.credential } : {}),
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

  async function restorePersistedConnection(errorMessage: string, legacy = false) {
    const connectorId = '11111111-2222-4333-8444-555555555555'
    const linksFile = join(stateDir, 'group-chat', 'group-chat-agent-links.json')
    const legacyLinksFile = join(stateDir, 'group-chat-agent-links.json')
    const sourceFile = legacy ? legacyLinksFile : linksFile
    mkdirSync(join(stateDir, 'group-chat'), { recursive: true })
    writeFileSync(sourceFile, `${JSON.stringify([{
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
      '../../packages/server/src/modules/studio/services/group-chat/agent-relay'
    )
    const manager = new GroupAgentOutboundRelayManager(() => null)
    await manager.restore()
    return { connectorId, legacyLinksFile, linksFile, manager }
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

  it('persists room metadata returned by the cloud Relay', async () => {
    const connectorId = '11111111-2222-4333-8444-555555555555'
    let relaySocket: ReturnType<typeof createReadyRelaySocket> | undefined
    ioMock.mockImplementation(() => {
      relaySocket = createReadyRelaySocket(connectorId, {
        credential: 'r'.repeat(48),
        roomId: 'room-1',
        roomName: 'Product Room',
        inviteCode: 'PRODUCT1',
      })
      return relaySocket
    })
    const { GroupAgentOutboundRelayManager } = await import(
      '../../packages/server/src/modules/studio/services/group-chat/agent-relay'
    )
    const manager = new GroupAgentOutboundRelayManager(() => null)

    await expect(manager.connect({
      cloudOrigin: 'https://cloud.example',
      targetOrigin: 'http://127.0.0.1:8648',
      pairingTicket: 'pairing-ticket',
      agent: {
        agent: 'hermes',
        profile: 'default',
        provider: '',
        model: '',
        apiMode: '',
        reasoningEffort: '',
        name: 'Remote Agent',
        description: '',
        avatar: '',
      },
    })).resolves.toEqual({
      connectorId,
      roomId: 'room-1',
      roomName: 'Product Room',
      inviteCode: 'PRODUCT1',
    })

    const linksFile = join(stateDir, 'group-chat', 'group-chat-agent-links.json')
    expect(JSON.parse(readFileSync(linksFile, 'utf8'))).toEqual([
      expect.objectContaining({
        cloudOrigin: 'https://cloud.example',
        roomId: 'room-1',
        roomName: 'Product Room',
        inviteCode: 'PRODUCT1',
      }),
    ])
    await expect(manager.listConnections()).resolves.toEqual([
      expect.objectContaining({
        connectorId,
        cloudOrigin: 'https://cloud.example',
        roomId: 'room-1',
        roomName: 'Product Room',
        inviteCode: 'PRODUCT1',
        connected: true,
      }),
    ])

    relaySocket!.trigger('room.metadata', {
      roomId: 'room-1',
      roomName: 'Renamed Product Room',
      inviteCode: 'PRODUCT2',
    })
    await vi.waitFor(async () => {
      await expect(manager.listConnections()).resolves.toEqual([
        expect.objectContaining({
          roomId: 'room-1',
          roomName: 'Renamed Product Room',
          inviteCode: 'PRODUCT2',
        }),
      ])
    })
    expect(JSON.parse(readFileSync(linksFile, 'utf8'))).toEqual([
      expect.objectContaining({
        roomId: 'room-1',
        roomName: 'Renamed Product Room',
        inviteCode: 'PRODUCT2',
      }),
    ])
    manager.shutdown()
  })

  it('renames and leaves a remote room across all of its Agent connectors', async () => {
    const connectorIds = [
      '11111111-2222-4333-8444-555555555555',
      '66666666-7777-4888-8999-000000000000',
    ]
    const relaySockets: ReturnType<typeof createReadyRelaySocket>[] = []
    ioMock.mockImplementation(() => {
      const connectorId = connectorIds[relaySockets.length]
      const socket = createReadyRelaySocket(connectorId, {
        credential: 'r'.repeat(48),
        roomId: 'room-1',
        roomName: 'Product Room',
        inviteCode: 'PRODUCT1',
      })
      relaySockets.push(socket)
      return socket
    })
    const { GroupAgentOutboundRelayManager } = await import(
      '../../packages/server/src/modules/studio/services/group-chat/agent-relay'
    )
    const manager = new GroupAgentOutboundRelayManager(() => null)
    const agent = {
      agent: 'hermes' as const,
      profile: 'default',
      provider: '',
      model: '',
      apiMode: '',
      reasoningEffort: '',
      name: 'Remote Agent',
      description: '',
      avatar: '',
    }

    await manager.connect({
      cloudOrigin: 'https://cloud.example',
      targetOrigin: 'http://127.0.0.1:8648',
      pairingTicket: 'pairing-ticket-one',
      agent,
    })
    await manager.connect({
      cloudOrigin: 'https://cloud.example',
      targetOrigin: 'http://127.0.0.1:8648',
      pairingTicket: 'pairing-ticket-two',
      agent,
    })

    await expect(manager.renameRoom(connectorIds[0], 'My Product Room')).resolves.toBe(2)
    await expect(manager.listConnections()).resolves.toEqual([
      expect.objectContaining({ connectorId: connectorIds[0], roomAlias: 'My Product Room' }),
      expect.objectContaining({ connectorId: connectorIds[1], roomAlias: 'My Product Room' }),
    ])

    await expect(manager.leaveRoom(connectorIds[0])).resolves.toEqual({ removed: 2, notified: 2 })
    await expect(manager.listConnections()).resolves.toEqual([])
    expect(relaySockets[0].emit).toHaveBeenCalledWith('connector.revoke', {}, expect.any(Function))
    expect(relaySockets[1].emit).toHaveBeenCalledWith('connector.revoke', {}, expect.any(Function))
    expect(JSON.parse(readFileSync(join(stateDir, 'group-chat', 'group-chat-agent-links.json'), 'utf8'))).toEqual([])
    manager.shutdown()
  })

  it('ignores the legacy root-level connection file without migrating it', async () => {
    const { legacyLinksFile, linksFile, manager } = await restorePersistedConnection(
      'websocket connection unavailable',
      true,
    )

    await expect(manager.listConnections()).resolves.toEqual([])
    expect(existsSync(legacyLinksFile)).toBe(true)
    expect(existsSync(linksFile)).toBe(false)
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

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getAppRelayClient,
  startAppRelayClient,
  stopAppRelayClient,
  getDeviceIdentity,
  createAppRelayDeviceSignature,
  getPublicSystemInfo,
} = vi.hoisted(() => ({
  getAppRelayClient: vi.fn(),
  startAppRelayClient: vi.fn(),
  stopAppRelayClient: vi.fn(),
  getDeviceIdentity: vi.fn(async () => ({
    device_id: 'hwui_machine_1234567890',
    device_public_key: 'public-key',
    device_private_key: 'private-key',
  })),
  createAppRelayDeviceSignature: vi.fn(async () => 'app-relay-signature'),
  getPublicSystemInfo: vi.fn(async () => ({
    device_id: 'hwui_machine_1234567890',
    device_public_key: 'public-key',
    computer_name: 'Studio Mac',
    os: { platform: 'darwin' },
    hermes_agent_version: '1.0.0',
    hermes_web_ui_version: '0.6.32',
  })),
}))

vi.mock('../../packages/server/src/modules/studio/services/app-relay/client', () => ({
  getAppRelayClient,
  startAppRelayClient,
  stopAppRelayClient,
}))
vi.mock('../../packages/server/src/modules/studio/public/system-info', () => ({
  getDeviceIdentity,
  getAppRelayDeviceIdentity: getDeviceIdentity,
  createAppRelayDeviceSignature,
  getPublicSystemInfo,
}))

describe('app relay controller', () => {
  beforeEach(() => vi.clearAllMocks())

  it('starts only the independent App relay and returns a pairing code', async () => {
    const client = {
      waitForConnected: vi.fn(async () => true),
      requestPairingCode: vi.fn(async () => ({ pairingCode: 'ABCD2345', expiresAt: 12345 })),
      status: vi.fn(() => ({
        connected: true,
        machineId: 'hwui_machine_1234567890',
        pairingCode: 'ABCD2345',
        pairingExpiresAt: 12345,
      })),
    }
    getAppRelayClient.mockReturnValue(null)
    startAppRelayClient.mockReturnValue(client)
    const { connectAppRelayController } = await import('../../packages/server/src/modules/studio/controllers/app-relay')
    const ctx: any = { status: 200 }

    await connectAppRelayController(ctx)

    expect(startAppRelayClient).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'app-relay',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'public-key',
    }))
    expect(ctx.body).toEqual({
      relay: {
        connected: true,
        machineId: 'hwui_machine_1234567890',
        pairingCode: 'ABCD2345',
        pairingExpiresAt: 12345,
        expiresAt: 12345,
        route: 'official',
        relayUrl: 'https://api.hermes-studio.ai',
      },
    })
  })

  it('disconnects App relay without touching the MCU relay registry', async () => {
    const { disconnectAppRelayController } = await import('../../packages/server/src/modules/studio/controllers/app-relay')
    const ctx: any = {}

    await disconnectAppRelayController(ctx)

    expect(stopAppRelayClient).toHaveBeenCalledWith('app-relay')
    expect(ctx.body.relay).toMatchObject({ connected: false, machineId: 'hwui_machine_1234567890' })
  })

  it('leaves the App relay retry loop running after the initial wait times out', async () => {
    const client = {
      waitForConnected: vi.fn(async () => false),
      isPreconnectionExpired: vi.fn(() => false),
      usesRelayUrl: vi.fn(() => true),
    }
    getAppRelayClient.mockReturnValue(client)
    const { connectAppRelayController } = await import('../../packages/server/src/modules/studio/controllers/app-relay')
    const ctx: any = { status: 200 }

    await connectAppRelayController(ctx)

    expect(ctx.status).toBe(502)
    expect(stopAppRelayClient).not.toHaveBeenCalled()
  })
})

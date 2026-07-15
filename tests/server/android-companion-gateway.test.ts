import { once } from 'events'
import { createServer, type Server } from 'http'
import { generateKeyPairSync } from 'crypto'
import WebSocket from 'ws'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ANDROID_COMPANION_PROTOCOL_VERSION,
  AndroidCompanionGateway,
  AndroidCompanionHandshakeInitiator,
  AndroidCompanionPairingService,
  AndroidCompanionStore,
  initAndroidCompanionSchema,
  signAndroidPairingTranscript,
  type AndroidCompanionPrivateIdentity,
  type AndroidPairingTranscript,
  type AndroidSessionAccept,
} from '../../packages/server/src/services/hermes/android-companion'
import { deviceIdFromPublicKey } from '../../packages/server/src/services/system-info'

const now = new Date('2026-07-15T00:00:00.000Z')

describe('Android companion pairing service and gateway', () => {
  const cleanup: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const operation of cleanup.splice(0).reverse()) await operation()
  })

  it('requires explicit local approval and consumes a signed pairing offer once', async () => {
    const { database, store } = memoryStore()
    cleanup.push(() => database.close())
    const studio = identity()
    const companion = identity()
    const pairing = new AndroidCompanionPairingService({ store, studioIdentity: async () => studio })
    const offer = await pairing.issue(now, 10_000)
    const signedTranscript = signAndroidPairingTranscript(
      pairingTranscript(offer.challenge, offer.studio, companion), companion.signingPrivateKey,
    )

    await expect(pairing.complete({
      challengeId: offer.challenge.challengeId,
      code: offer.challenge.code,
      signedTranscript,
      approvedByUser: false,
      now,
    })).rejects.toThrow(/explicit local approval/i)
    expect(pairing.activeOfferCount).toBe(1)
    await expect(pairing.complete({
      challengeId: offer.challenge.challengeId,
      code: offer.challenge.code,
      signedTranscript,
      approvedByUser: true,
      now,
    })).resolves.toMatchObject({ disposition: 'created', device: {
      id: companion.deviceId, state: 'paired', installationId: 'android-installation-gateway',
    } })
    expect(pairing.activeOfferCount).toBe(0)
    await expect(pairing.complete({
      challengeId: offer.challenge.challengeId,
      code: offer.challenge.code,
      signedTranscript,
      approvedByUser: true,
      now,
    })).rejects.toThrow(/unknown or consumed/i)
  })

  it('upgrades only the dedicated path, completes the signed handshake, and exchanges encrypted messages', async () => {
    const { database, store } = memoryStore()
    cleanup.push(() => database.close())
    const studio = identity()
    const companion = identity()
    pair(store, companion)
    const received: unknown[] = []
    const gateway = new AndroidCompanionGateway({
      store,
      studioIdentity: async () => studio,
      now: () => now,
      heartbeatMs: 0,
      onMessage(message) {
        received.push(message)
        return {
          messageType: 'ack',
          bindingId: message.bindingId,
          payload: { acknowledgedSequence: message.sequence },
        }
      },
    })
    const server = createServer()
    gateway.setupServer(server)
    const port = await listen(server)
    cleanup.push(async () => {
      await gateway.shutdown()
      await closeServer(server)
    })

    const client = new WebSocket(`ws://127.0.0.1:${port}/api/hermes/android-companion/session`)
    await once(client, 'open')
    const initiator = new AndroidCompanionHandshakeInitiator({ companion, studio, now })
    client.send(JSON.stringify(initiator.hello))
    const response = JSON.parse((await socketMessage(client)).toString()) as AndroidSessionAccept
    expect(response).toMatchObject({ type: 'session.accept', companionDeviceId: companion.deviceId })
    const companionSession = initiator.complete(response, now)
    expect(gateway.listConnections()).toMatchObject([{
      deviceId: companion.deviceId, receivedSequence: 0, sentSequence: 0,
    }])

    const report = companionSession.encrypt({
      messageType: 'capabilities.report',
      bindingId: 'capabilities:revision-1',
      payload: { revision: 1 },
      expiresAt: plus(30_000),
      now,
    })
    client.send(JSON.stringify(report))
    const ack = JSON.parse((await socketMessage(client)).toString())
    expect(companionSession.decrypt(ack, now)).toEqual({ acknowledgedSequence: 1 })
    expect(received).toMatchObject([{
      deviceId: companion.deviceId,
      messageType: 'capabilities.report',
      bindingId: 'capabilities:revision-1',
      sequence: 1,
      payload: { revision: 1 },
    }])

    const outbound = await gateway.send(companion.deviceId, {
      messageType: 'command.execute',
      bindingId: 'workflow:gateway-launch',
      payload: { capabilityId: 'android.app.launch' },
    })
    expect(outbound.sequence).toBe(2)
    const command = JSON.parse((await socketMessage(client)).toString())
    expect(companionSession.decrypt(command, now)).toEqual({ capabilityId: 'android.app.launch' })
    expect(gateway.listConnections()[0]).toMatchObject({ receivedSequence: 1, sentSequence: 2 })
  })

  it('closes fail-closed on replay and supports immediate revocation disconnect', async () => {
    const { database, store } = memoryStore()
    cleanup.push(() => database.close())
    const studio = identity()
    const companion = identity()
    pair(store, companion)
    const gateway = new AndroidCompanionGateway({
      store, studioIdentity: async () => studio, now: () => now, heartbeatMs: 0,
    })
    const server = createServer()
    gateway.setupServer(server)
    const port = await listen(server)
    cleanup.push(async () => {
      await gateway.shutdown()
      await closeServer(server)
    })

    const first = await connect(port, companion, studio)
    const envelope = first.session.encrypt({
      messageType: 'heartbeat', bindingId: first.session.sessionId, payload: { at: plus(1) },
      expiresAt: plus(30_000), now,
    })
    first.socket.send(JSON.stringify(envelope))
    await eventually(() => gateway.listConnections()[0]?.receivedSequence === 1)
    first.socket.send(JSON.stringify(envelope))
    const [replayCode] = await once(first.socket, 'close')
    expect(replayCode).toBe(4003)
    expect(gateway.isConnected(companion.deviceId)).toBe(false)

    const second = await connect(port, companion, studio)
    expect(gateway.disconnectDevice(companion.deviceId)).toBe(true)
    const [revokedCode, reason] = await once(second.socket, 'close')
    expect(revokedCode).toBe(4003)
    expect(reason.toString()).toBe('DEVICE_REVOKED')
    expect(gateway.isConnected(companion.deviceId)).toBe(false)
  })

  it('rejects revoked devices before creating a secure session', async () => {
    const { database, store } = memoryStore()
    cleanup.push(() => database.close())
    const studio = identity()
    const companion = identity()
    const paired = pair(store, companion)
    store.revokeDevice(companion.deviceId, paired.version, 'USER_REVOKED')
    const gateway = new AndroidCompanionGateway({
      store, studioIdentity: async () => studio, now: () => now, heartbeatMs: 0,
    })
    const server = createServer()
    gateway.setupServer(server)
    const port = await listen(server)
    cleanup.push(async () => {
      await gateway.shutdown()
      await closeServer(server)
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/hermes/android-companion/session`)
    await once(socket, 'open')
    const initiator = new AndroidCompanionHandshakeInitiator({ companion, studio, now })
    socket.send(JSON.stringify(initiator.hello))
    const [code] = await once(socket, 'close')
    expect(code).toBe(4003)
    expect(gateway.listConnections()).toEqual([])
  })
})

async function connect(port: number, companion: AndroidCompanionPrivateIdentity, studio: AndroidCompanionPrivateIdentity) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/hermes/android-companion/session`)
  await once(socket, 'open')
  const initiator = new AndroidCompanionHandshakeInitiator({ companion, studio, now })
  socket.send(JSON.stringify(initiator.hello))
  const response = JSON.parse((await socketMessage(socket)).toString()) as AndroidSessionAccept
  return { socket, session: initiator.complete(response, now) }
}

function memoryStore() {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  initAndroidCompanionSchema(database)
  return { database, store: new AndroidCompanionStore(database) }
}

function pair(store: AndroidCompanionStore, companion: AndroidCompanionPrivateIdentity) {
  return store.pairDevice({
    deviceId: companion.deviceId,
    installationId: 'android-installation-gateway',
    signingPublicKey: companion.signingPublicKey,
    exchangePublicKey: companion.exchangePublicKey,
    label: 'Gateway Pixel',
    androidVersion: '16',
    appVersion: '0.1.0',
    initialCapabilitiesDigest: 'b'.repeat(64),
    pairedAt: now.toISOString(),
  }).device
}

function identity(): AndroidCompanionPrivateIdentity {
  const signing = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const exchange = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return {
    deviceId: deviceIdFromPublicKey(signing.publicKey),
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    exchangePublicKey: exchange.publicKey,
    exchangePrivateKey: exchange.privateKey,
  }
}

function pairingTranscript(
  challenge: { challengeId: string; nonce: string; expiresAt: string },
  studio: AndroidCompanionPrivateIdentity | { deviceId: string; signingPublicKey: string; exchangePublicKey: string },
  companion: AndroidCompanionPrivateIdentity,
): AndroidPairingTranscript {
  return {
    protocolVersion: ANDROID_COMPANION_PROTOCOL_VERSION,
    challengeId: challenge.challengeId,
    challengeNonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    studio: {
      deviceId: studio.deviceId,
      signingPublicKey: studio.signingPublicKey,
      exchangePublicKey: studio.exchangePublicKey,
    },
    companion: {
      deviceId: companion.deviceId,
      signingPublicKey: companion.signingPublicKey,
      exchangePublicKey: companion.exchangePublicKey,
      installationId: 'android-installation-gateway',
      label: 'Gateway Pixel',
      androidVersion: '16',
      appVersion: '0.1.0',
    },
    initialCapabilitiesDigest: 'b'.repeat(64),
  }
}

function plus(milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString()
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function socketMessage(socket: WebSocket): Promise<Buffer> {
  const [data] = await once(socket, 'message')
  return Buffer.isBuffer(data) ? data : Buffer.from(data)
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition was not reached')
}

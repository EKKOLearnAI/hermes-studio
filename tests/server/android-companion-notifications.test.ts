import { generateKeyPairSync } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AndroidCompanionNotificationService,
  AndroidCompanionStore,
  initAndroidCompanionSchema,
  type AndroidCompanionGatewayMessage,
  type AndroidNotificationTwinProjector,
} from '../../packages/server/src/services/hermes/android-companion'
import { deviceIdFromPublicKey } from '../../packages/server/src/services/system-info'
import type { TwinEventInput } from '../../packages/server/src/services/hermes/personal-twin'

const now = new Date('2026-07-15T08:00:00.000Z')
const postedAt = '2026-07-15T07:59:00.000Z'

describe('Android notification observation boundary', () => {
  let database: DatabaseSync
  let store: AndroidCompanionStore
  let projector: FakeProjector
  let service: AndroidCompanionNotificationService

  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys=ON')
    initAndroidCompanionSchema(database)
    store = new AndroidCompanionStore(database)
    pair(store)
    projector = new FakeProjector()
    service = new AndroidCompanionNotificationService({
      store,
      projector,
      now: () => now,
      packagePolicies: [
        { packageBinding: 'ai.hermes.companion', sensitivity: 'standard' },
        { packageBinding: 'com.example.bank', sensitivity: 'standard' },
      ],
    })
  })

  afterEach(() => database.close())

  it('persists one minimized projection and replays it with a newer durable source sequence', () => {
    const first = service.handleMessage(observed(1, {
      title: 'Workflow ready', text: 'Your approved task is ready to continue.',
    }))!
    expect(first.payload).toMatchObject({ disposition: 'created', sensitivity: 'standard' })
    const id = String((first.payload as Record<string, unknown>).observationId)
    expect(store.getNotification(id)).toMatchObject({
      packageBinding: 'ai.hermes.companion', titleSummary: 'Workflow ready',
      textSummary: 'Your approved task is ready to continue.', sourceSequence: 1, version: 1,
    })

    const replay = service.handleMessage(observed(2, {
      title: 'Workflow ready', text: 'Your approved task is ready to continue.',
    }))!
    expect(replay.payload).toMatchObject({ disposition: 'replayed', observationId: id })
    expect(store.getNotification(id)).toMatchObject({ sourceSequence: 2, version: 2 })
    expect(projector.events).toHaveLength(1)
    expect(JSON.stringify(projector.events)).not.toMatch(/sourceSequence|notificationKeyHash/)
  })

  it('reduces OTP, finance, health, hidden, and secret-shaped content to metadata', () => {
    const reply = service.handleMessage(observed(1, {
      packageBinding: 'com.example.bank', category: 'finance.payment', visibility: 'private',
      title: '验证码 381921', text: 'Transfer token is at C:\\Users\\Alice\\secret.txt',
    }))!
    const observation = store.getNotification(String((reply.payload as Record<string, unknown>).observationId))!
    expect(observation).toMatchObject({ sensitivity: 'metadata', titleSummary: '', textSummary: '' })
    expect(JSON.stringify(projector.events)).not.toMatch(/381921|Users|secret\.txt|notificationKeyHash/)
  })

  it('rejects unlisted packages, malformed envelopes, and out-of-order new observations', () => {
    expect(() => service.handleMessage(observed(1, { packageBinding: 'com.unlisted.chat' })))
      .toThrow(/not allowlisted/i)
    const accessor = Object.defineProperty({}, 'packageBinding', {
      enumerable: true, get: () => 'ai.hermes.companion',
    })
    expect(() => service.handleMessage({ ...observed(1), payload: accessor })).toThrow(/envelope|accessor/i)
    service.handleMessage(observed(5))
    expect(() => service.handleMessage(observed(4, {
      notificationKeyHash: 'd'.repeat(64), postedAt: '2026-07-15T07:58:00.000Z',
    }))).toThrow(/not fresh/i)
  })

  it('removes idempotently and emits one separate Twin removal event', () => {
    service.handleMessage(observed(1))
    const removed = service.handleMessage(message('notification.removed', 2, {
      notificationKeyHash: 'a'.repeat(64), postedAt, removedAt: '2026-07-15T08:00:00.000Z', sourceSequence: 2,
    }))!
    expect(removed.payload).toMatchObject({ disposition: 'updated' })
    const replay = service.handleMessage(message('notification.removed', 3, {
      notificationKeyHash: 'a'.repeat(64), postedAt, removedAt: '2026-07-15T08:00:00.000Z', sourceSequence: 3,
    }))!
    expect(replay.payload).toMatchObject({ disposition: 'replayed' })
    expect(projector.events.map(event => event.eventType)).toEqual([
      'digital_life.android.notification.observed', 'digital_life.android.notification.removed',
    ])
    expect(store.listNotifications()).toEqual([expect.objectContaining({ removedAt: '2026-07-15T08:00:00.000Z' })])
  })
})

describe('Android notification Personal Twin projection', () => {
  const originalHome = process.env.HERMES_HOME
  let home: string
  let database: DatabaseSync

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'android-notification-twin-'))
    process.env.HERMES_HOME = home
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys=ON')
    initAndroidCompanionSchema(database)
  })

  afterEach(() => {
    database.close()
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it('deduplicates the Twin event and outbox across companion replay', async () => {
    const durableStore = new AndroidCompanionStore(database)
    pair(durableStore)
    const live = new AndroidCompanionNotificationService({ store: durableStore, now: () => now })
    live.handleMessage(observed(1))
    live.handleMessage(observed(2))

    const twin = await import('../../packages/server/src/services/hermes/personal-twin')
    expect(twin.listTwinEvents({ eventType: 'digital_life.android.notification.observed' })).toHaveLength(1)
    expect(twin.withPersonalTwinDb(db => db.prepare(`SELECT COUNT(*) AS count FROM twin_outbox
      WHERE topic='twin.event.recorded'`).get())).toEqual({ count: 1 })
  })
})

class FakeProjector implements AndroidNotificationTwinProjector {
  events: TwinEventInput[] = []
  #keys = new Set<string>()

  project(event: TwinEventInput): 'created' | 'replayed' {
    const key = `${event.source}:${event.sourceId}:${event.eventType}`
    if (this.#keys.has(key)) return 'replayed'
    this.#keys.add(key)
    this.events.push(event)
    return 'created'
  }
}

function observed(sourceSequence: number, overrides: Record<string, unknown> = {}): AndroidCompanionGatewayMessage {
  return message('notification.observed', sourceSequence, {
    packageBinding: 'ai.hermes.companion',
    notificationKeyHash: 'a'.repeat(64),
    category: 'workflow.status',
    channelHash: 'b'.repeat(64),
    title: 'Task ready',
    text: 'Open Hermes to continue.',
    visibility: 'public',
    postedAt,
    sourceSequence,
    ...overrides,
  })
}

function message(
  messageType: AndroidCompanionGatewayMessage['messageType'],
  sequence: number,
  payload: unknown,
): AndroidCompanionGatewayMessage {
  return {
    deviceId,
    sessionId: 'session-notification-test',
    messageType,
    bindingId: `observation-${sequence}`,
    sequence,
    payload,
    receivedAt: now.toISOString(),
  }
}

const keyOptions = {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
} as const
const signing = generateKeyPairSync('ed25519', keyOptions)
const exchange = generateKeyPairSync('x25519', keyOptions)
const deviceId = deviceIdFromPublicKey(signing.publicKey)

function pair(store: AndroidCompanionStore): void {
  store.pairDevice({
    deviceId,
    installationId: 'android-notification-installation',
    signingPublicKey: signing.publicKey,
    exchangePublicKey: exchange.publicKey,
    label: 'Notification Companion',
    androidVersion: '15',
    appVersion: '1.0.0',
    initialCapabilitiesDigest: 'c'.repeat(64),
    pairedAt: '2026-07-15T07:00:00.000Z',
  })
}

import { generateKeyPairSync } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  ANDROID_COMPANION_PROTOCOL_VERSION,
  AndroidCompanionAuthenticationError,
  AndroidCompanionHandshakeInitiator,
  AndroidCompanionReplayError,
  AndroidCompanionValidationError,
  AndroidPairingChallengeRegistry,
  acceptAndroidCompanionSession,
  signAndroidPairingTranscript,
  verifyAndroidPairingTranscript,
  type AndroidCompanionPrivateIdentity,
  type AndroidEncryptedEnvelope,
  type AndroidPairingTranscript,
} from '../../packages/server/src/services/hermes/android-companion'
import { deviceIdFromPublicKey } from '../../packages/server/src/services/system-info'

const now = new Date('2026-07-15T00:00:00.000Z')
const studio = identity()
const companion = identity()

describe('Android companion pairing and encrypted sessions', () => {
  it('issues bounded memory-only pairing challenges and consumes a code once', () => {
    const registry = new AndroidPairingChallengeRegistry()
    const challenge = registry.issue(studio.deviceId, now, 10_000)
    expect(challenge).toMatchObject({
      challengeId: expect.stringMatching(/^android-pair-/),
      nonce: expect.any(String),
      code: expect.any(String),
      studioDeviceId: studio.deviceId,
      expiresAt: '2026-07-15T00:00:10.000Z',
    })
    expect(registry.size).toBe(1)
    expect(() => registry.consume(challenge.challengeId, 'wrong-code', now))
      .toThrow(AndroidCompanionAuthenticationError)
    const approved = registry.consume(challenge.challengeId, challenge.code, now)
    expect(approved).not.toHaveProperty('code')
    expect(approved).toMatchObject({ challengeId: challenge.challengeId, nonce: challenge.nonce })
    expect(registry.size).toBe(0)
    expect(() => registry.consume(challenge.challengeId, challenge.code, now))
      .toThrow(/unknown or consumed/i)

    const expired = registry.issue(studio.deviceId, now, 10_000)
    expect(() => registry.consume(expired.challengeId, expired.code, new Date(now.getTime() + 10_000)))
      .toThrow(/expired/i)
  })

  it('binds an approved challenge and both long-term identities in the signed enrollment transcript', () => {
    const registry = new AndroidPairingChallengeRegistry()
    const issued = registry.issue(studio.deviceId, now, 10_000)
    const challenge = registry.consume(issued.challengeId, issued.code, now)
    const transcript = pairingTranscript(challenge)
    const signed = signAndroidPairingTranscript(transcript, companion.signingPrivateKey)
    expect(verifyAndroidPairingTranscript({ signed, challenge, expectedStudio: studio, now })).toEqual(transcript)

    const substitutedStudio = identity()
    expect(() => verifyAndroidPairingTranscript({
      signed: { ...signed, transcript: { ...transcript, studio: substitutedStudio } },
      challenge,
      expectedStudio: studio,
      now,
    })).toThrow(/substituted the Studio identity/i)
    expect(() => verifyAndroidPairingTranscript({
      signed, challenge, expectedStudio: studio, now: new Date(now.getTime() + 10_000),
    })).toThrow(/expired/i)
  })

  it('derives matching directional keys and exchanges only authenticated semantic envelopes', () => {
    const { companionSession, studioSession } = sessions()
    const command = studioSession.encrypt({
      messageType: 'command.execute',
      bindingId: 'workflow:android-launch-1',
      payload: { capabilityId: 'android.app.launch', packageBinding: 'tv.danmaku.bili' },
      expiresAt: plus(30_000),
      now,
    })
    expect(command).toMatchObject({
      direction: 'studio_to_companion', sequence: 1, messageType: 'command.execute',
      senderDeviceId: studio.deviceId, recipientDeviceId: companion.deviceId,
    })
    expect(JSON.stringify(command)).not.toContain('android.app.launch')
    expect(companionSession.decrypt(command, now)).toEqual({
      capabilityId: 'android.app.launch', packageBinding: 'tv.danmaku.bili',
    })

    const result = companionSession.encrypt({
      messageType: 'command.result',
      bindingId: 'workflow:android-launch-1',
      payload: { foregroundPackage: 'tv.danmaku.bili', status: 'succeeded' },
      expiresAt: plus(30_000),
      now,
    })
    expect(result.direction).toBe('companion_to_studio')
    expect(studioSession.decrypt(result, now)).toEqual({
      foregroundPackage: 'tv.danmaku.bili', status: 'succeeded',
    })
    expect({
      studio: { sent: studioSession.sentSequence, received: studioSession.receivedSequence },
      companion: { sent: companionSession.sentSequence, received: companionSession.receivedSequence },
    }).toEqual({ studio: { sent: 1, received: 1 }, companion: { sent: 1, received: 1 } })
    expect(JSON.stringify({ studioSession, companionSession })).not.toMatch(/PRIVATE KEY|sendKey|receiveKey/i)
  })

  it('fails closed on ciphertext tampering, replay, reordering, and wrong-device routing', () => {
    const tamper = sessions()
    const envelope = companionEnvelope(tamper.studioSession)
    const first = envelope.ciphertext[0] === 'A' ? 'B' : 'A'
    const changed = { ...envelope, ciphertext: `${first}${envelope.ciphertext.slice(1)}` }
    expect(() => tamper.companionSession.decrypt(changed, now)).toThrow(/authentication failed/i)
    expect(tamper.companionSession.closed).toBe(true)
    expect(() => tamper.companionSession.decrypt(envelope, now)).toThrow(/session is closed/i)

    const replay = sessions()
    const replayed = companionEnvelope(replay.studioSession)
    expect(replay.companionSession.decrypt(replayed, now)).toEqual({ request: 'launch' })
    expect(() => replay.companionSession.decrypt(replayed, now)).toThrow(AndroidCompanionReplayError)

    const reorder = sessions()
    companionEnvelope(reorder.studioSession)
    const second = companionEnvelope(reorder.studioSession)
    expect(() => reorder.companionSession.decrypt(second, now)).toThrow(/does not match expected 1/i)

    const wrongRoute = sessions()
    const routed = companionEnvelope(wrongRoute.studioSession)
    expect(() => wrongRoute.companionSession.decrypt({
      ...routed, recipientDeviceId: identity().deviceId,
    }, now)).toThrow(/wrong session or device/i)
  })

  it('rejects stale or substituted handshakes and permits completion only once', () => {
    const initiator = new AndroidCompanionHandshakeInitiator({ companion, studio, now })
    const accepted = acceptAndroidCompanionSession({ hello: initiator.hello, companion, studio, now })
    initiator.complete(accepted.response, now)
    expect(() => initiator.complete(accepted.response, now)).toThrow(AndroidCompanionReplayError)

    expect(() => acceptAndroidCompanionSession({
      hello: initiator.hello,
      companion: identity(),
      studio,
      now,
    })).toThrow(/does not match paired device identities/i)
    const replacementExchange = generateKeyPairSync('x25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const substitutedExchange = {
      ...companion,
      exchangePublicKey: replacementExchange.publicKey,
      exchangePrivateKey: replacementExchange.privateKey,
    }
    const substitutedHello = new AndroidCompanionHandshakeInitiator({
      companion: substitutedExchange, studio, now,
    }).hello
    expect(() => acceptAndroidCompanionSession({
      hello: substitutedHello, companion, studio, now,
    })).toThrow(/does not match paired device identities/i)
    expect(() => acceptAndroidCompanionSession({
      hello: new AndroidCompanionHandshakeInitiator({ companion, studio, now }).hello,
      companion,
      studio,
      now: new Date(now.getTime() + 61_000),
    })).toThrow(/stale|validity window/i)
  })

  it('rejects unsafe payloads, unknown message types, invalid expiry, and oversized plaintext', () => {
    const { studioSession } = sessions()
    const unsafe = Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'not-called' })
    expect(() => studioSession.encrypt({
      messageType: 'command.execute', bindingId: 'workflow:unsafe-payload', payload: unsafe,
      expiresAt: plus(30_000), now,
    })).toThrow(/unsafe properties/i)
    expect(() => studioSession.encrypt({
      messageType: 'raw.tap' as never, bindingId: 'workflow:raw-command', payload: {},
      expiresAt: plus(30_000), now,
    })).toThrow(/unknown Android companion message type/i)
    expect(() => studioSession.encrypt({
      messageType: 'command.execute', bindingId: 'workflow:expired-command', payload: {},
      expiresAt: plus(-1), now,
    })).toThrow(/expiry is outside/i)
    expect(() => studioSession.encrypt({
      messageType: 'command.execute', bindingId: 'workflow:oversized-command',
      payload: { value: 'x'.repeat(49 * 1024) }, expiresAt: plus(30_000), now,
    })).toThrow(/string is too large|plaintext exceeds/i)
  })
})

function sessions() {
  const initiator = new AndroidCompanionHandshakeInitiator({ companion, studio, now })
  const accepted = acceptAndroidCompanionSession({ hello: initiator.hello, companion, studio, now })
  return {
    companionSession: initiator.complete(accepted.response, now),
    studioSession: accepted.session,
  }
}

function companionEnvelope(studioSession: ReturnType<typeof sessions>['studioSession']): AndroidEncryptedEnvelope {
  return studioSession.encrypt({
    messageType: 'command.execute', bindingId: 'workflow:replay-proof', payload: { request: 'launch' },
    expiresAt: plus(30_000), now,
  })
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
): AndroidPairingTranscript {
  return {
    protocolVersion: ANDROID_COMPANION_PROTOCOL_VERSION,
    challengeId: challenge.challengeId,
    challengeNonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    studio,
    companion: {
      deviceId: companion.deviceId,
      signingPublicKey: companion.signingPublicKey,
      exchangePublicKey: companion.exchangePublicKey,
      installationId: 'android-installation-1',
      label: 'Pixel 9',
      androidVersion: '16',
      appVersion: '0.1.0',
    },
    initialCapabilitiesDigest: 'a'.repeat(64),
  }
}

function plus(milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString()
}

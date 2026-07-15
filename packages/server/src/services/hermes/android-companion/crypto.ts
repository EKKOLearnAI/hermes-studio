import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'crypto'
import { isProxy } from 'node:util/types'
import { deviceIdFromPublicKey } from '../../system-info'
import {
  ANDROID_COMPANION_MESSAGE_TYPES,
  ANDROID_COMPANION_PROTOCOL_VERSION,
  AndroidCompanionAuthenticationError,
  AndroidCompanionReplayError,
  AndroidCompanionValidationError,
  type AndroidCompanionMessageType,
} from './types'

const HANDSHAKE_TTL_MS = 60_000
const MAX_CLOCK_SKEW_MS = 30_000
const SESSION_TTL_MS = 30 * 60_000
const MAX_SESSION_TTL_MS = 24 * 60 * 60_000
const MAX_ENVELOPE_TTL_MS = 15 * 60_000
const MAX_PLAINTEXT_BYTES = 48 * 1024
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + 16
const MAX_PAIRING_CHALLENGES = 32
const MAX_PAIRING_ATTEMPTS = 5
const MAX_PAIRING_ISSUES_PER_WINDOW = 8
const PAIRING_ISSUE_WINDOW_MS = 60_000
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
const DIGEST = /^[a-f0-9]{64}$/
const MESSAGE_TYPES = new Set<string>(ANDROID_COMPANION_MESSAGE_TYPES)
const SESSION_CONSTRUCTOR_TOKEN = Symbol('AndroidCompanionSecureSession')

export interface AndroidCompanionPublicIdentity {
  deviceId: string
  signingPublicKey: string
  exchangePublicKey: string
}

export interface AndroidCompanionPrivateIdentity extends AndroidCompanionPublicIdentity {
  signingPrivateKey: string
  exchangePrivateKey: string
}

export interface AndroidPairingChallenge {
  challengeId: string
  nonce: string
  code: string
  studioDeviceId: string
  expiresAt: string
}

type StoredPairingChallenge = Omit<AndroidPairingChallenge, 'code'> & {
  codeDigest: Buffer
  attemptsRemaining: number
}

export interface AndroidPairingTranscript {
  protocolVersion: typeof ANDROID_COMPANION_PROTOCOL_VERSION
  challengeId: string
  challengeNonce: string
  expiresAt: string
  studio: AndroidCompanionPublicIdentity
  companion: AndroidCompanionPublicIdentity & {
    installationId: string
    label: string
    androidVersion: string
    appVersion: string
  }
  initialCapabilitiesDigest: string
}

export interface SignedAndroidPairingTranscript {
  transcript: AndroidPairingTranscript
  companionSignature: string
}

export interface AndroidSessionHello {
  protocolVersion: typeof ANDROID_COMPANION_PROTOCOL_VERSION
  type: 'session.hello'
  companionDeviceId: string
  studioDeviceId: string
  companionExchangeFingerprint: string
  studioExchangeFingerprint: string
  ephemeralPublicKey: string
  nonce: string
  issuedAt: string
  expiresAt: string
  lastAcknowledgedSequence: number
  signature: string
}

export interface AndroidSessionAccept {
  protocolVersion: typeof ANDROID_COMPANION_PROTOCOL_VERSION
  type: 'session.accept'
  sessionId: string
  companionDeviceId: string
  studioDeviceId: string
  helloDigest: string
  companionEphemeralPublicKey: string
  studioEphemeralPublicKey: string
  nonce: string
  issuedAt: string
  expiresAt: string
  sessionExpiresAt: string
  signature: string
}

export interface AndroidEncryptedEnvelope {
  protocolVersion: typeof ANDROID_COMPANION_PROTOCOL_VERSION
  sessionId: string
  senderDeviceId: string
  recipientDeviceId: string
  direction: 'companion_to_studio' | 'studio_to_companion'
  sequence: number
  messageType: AndroidCompanionMessageType
  bindingId: string
  expiresAt: string
  ciphertextLength: number
  ciphertext: string
  authTag: string
}

type SessionRole = 'companion' | 'studio'

type SessionSecrets = {
  companionToStudioKey: Buffer
  studioToCompanionKey: Buffer
  companionNoncePrefix: Buffer
  studioNoncePrefix: Buffer
}

export class AndroidPairingChallengeRegistry {
  readonly #challenges = new Map<string, StoredPairingChallenge>()
  readonly #issueHistory = new Map<string, number[]>()

  issue(studioDeviceId: string, now = new Date(), ttlMs = 5 * 60_000): AndroidPairingChallenge {
    assertIdentifier(studioDeviceId, 'studio device ID')
    assertTtl(ttlMs, 10_000, 10 * 60_000, 'pairing challenge')
    this.prune(now)
    const issued = this.#issueHistory.get(studioDeviceId) ?? []
    if (issued.length >= MAX_PAIRING_ISSUES_PER_WINDOW) {
      throw new AndroidCompanionValidationError('Android pairing issue rate exceeded')
    }
    if (this.#challenges.size >= MAX_PAIRING_CHALLENGES) {
      throw new AndroidCompanionValidationError('too many active Android pairing challenges')
    }
    const code = randomBytes(6).toString('base64url')
    const challenge: AndroidPairingChallenge = {
      challengeId: `android-pair-${randomUUID()}`,
      nonce: randomBytes(24).toString('base64url'),
      code,
      studioDeviceId,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    }
    const { code: _code, ...stored } = challenge
    this.#challenges.set(challenge.challengeId, {
      ...stored,
      codeDigest: pairingCodeDigest(challenge.challengeId, code),
      attemptsRemaining: MAX_PAIRING_ATTEMPTS,
    })
    issued.push(now.getTime())
    this.#issueHistory.set(studioDeviceId, issued)
    return challenge
  }

  consume(challengeId: string, code: string, now = new Date()): Omit<AndroidPairingChallenge, 'code'> {
    assertIdentifier(challengeId, 'pairing challenge ID')
    if (typeof code !== 'string' || code.length < 8 || code.length > 32) {
      throw new AndroidCompanionAuthenticationError('invalid Android pairing code')
    }
    const challenge = this.#challenges.get(challengeId)
    if (!challenge) throw new AndroidCompanionAuthenticationError('unknown or consumed Android pairing challenge')
    if (Date.parse(challenge.expiresAt) <= now.getTime()) {
      this.#challenges.delete(challengeId)
      throw new AndroidCompanionAuthenticationError('Android pairing challenge expired')
    }
    const actual = pairingCodeDigest(challengeId, code)
    if (!timingSafeEqual(actual, challenge.codeDigest)) {
      challenge.attemptsRemaining -= 1
      if (challenge.attemptsRemaining <= 0) this.#challenges.delete(challengeId)
      throw new AndroidCompanionAuthenticationError('invalid Android pairing code')
    }
    this.#challenges.delete(challengeId)
    return {
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      studioDeviceId: challenge.studioDeviceId,
      expiresAt: challenge.expiresAt,
    }
  }

  revoke(challengeId: string): boolean {
    return this.#challenges.delete(challengeId)
  }

  get size(): number { return this.#challenges.size }

  private prune(now: Date): void {
    for (const [id, challenge] of this.#challenges) {
      if (Date.parse(challenge.expiresAt) <= now.getTime()) this.#challenges.delete(id)
    }
    const threshold = now.getTime() - PAIRING_ISSUE_WINDOW_MS
    for (const [deviceId, timestamps] of this.#issueHistory) {
      const fresh = timestamps.filter(timestamp => timestamp > threshold && timestamp <= now.getTime())
      if (fresh.length) this.#issueHistory.set(deviceId, fresh)
      else this.#issueHistory.delete(deviceId)
    }
  }
}

export function signAndroidPairingTranscript(
  transcript: AndroidPairingTranscript,
  companionSigningPrivateKey: string,
): SignedAndroidPairingTranscript {
  validatePairingTranscript(transcript)
  assertPrivateKey(companionSigningPrivateKey, 'ed25519', 'companion signing private key')
  return {
    transcript,
    companionSignature: signCanonical(transcript, companionSigningPrivateKey),
  }
}

export function verifyAndroidPairingTranscript(input: {
  signed: SignedAndroidPairingTranscript
  challenge: Omit<AndroidPairingChallenge, 'code'>
  expectedStudio: AndroidCompanionPublicIdentity
  now?: Date
}): AndroidPairingTranscript {
  const now = input.now ?? new Date()
  const { transcript, companionSignature } = input.signed
  validatePairingTranscript(transcript)
  validatePublicIdentity(input.expectedStudio, 'expected Studio identity')
  if (transcript.challengeId !== input.challenge.challengeId
    || transcript.challengeNonce !== input.challenge.nonce
    || transcript.expiresAt !== input.challenge.expiresAt
    || input.challenge.studioDeviceId !== input.expectedStudio.deviceId) {
    throw new AndroidCompanionAuthenticationError('pairing transcript does not match the approved challenge')
  }
  if (canonicalJson(transcript.studio) !== canonicalJson(input.expectedStudio)) {
    throw new AndroidCompanionAuthenticationError('pairing transcript substituted the Studio identity')
  }
  assertNotExpired(transcript.expiresAt, now, 'pairing transcript')
  if (!verifyCanonical(transcript, companionSignature, transcript.companion.signingPublicKey)) {
    throw new AndroidCompanionAuthenticationError('invalid companion pairing signature')
  }
  return transcript
}

export class AndroidCompanionHandshakeInitiator {
  readonly hello: AndroidSessionHello
  readonly #ephemeralPrivateKey: KeyObject
  readonly #companion: AndroidCompanionPrivateIdentity
  readonly #studio: AndroidCompanionPublicIdentity
  #completed = false

  constructor(input: {
    companion: AndroidCompanionPrivateIdentity
    studio: AndroidCompanionPublicIdentity
    lastAcknowledgedSequence?: number
    now?: Date
    ttlMs?: number
  }) {
    validatePrivateIdentity(input.companion, 'companion identity')
    validatePublicIdentity(input.studio, 'Studio identity')
    const now = input.now ?? new Date()
    const ttlMs = input.ttlMs ?? HANDSHAKE_TTL_MS
    assertTtl(ttlMs, 5_000, HANDSHAKE_TTL_MS, 'session hello')
    const ephemeral = generateKeyPairSync('x25519')
    this.#ephemeralPrivateKey = ephemeral.privateKey
    this.#companion = input.companion
    this.#studio = input.studio
    const unsigned = {
      protocolVersion: ANDROID_COMPANION_PROTOCOL_VERSION,
      type: 'session.hello' as const,
      companionDeviceId: input.companion.deviceId,
      studioDeviceId: input.studio.deviceId,
      companionExchangeFingerprint: fingerprintKey(input.companion.exchangePublicKey, 'x25519'),
      studioExchangeFingerprint: fingerprintKey(input.studio.exchangePublicKey, 'x25519'),
      ephemeralPublicKey: exportPublicKey(ephemeral.publicKey),
      nonce: randomBytes(24).toString('base64url'),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      lastAcknowledgedSequence: assertSequence(input.lastAcknowledgedSequence ?? 0, true),
    }
    this.hello = { ...unsigned, signature: signCanonical(unsigned, input.companion.signingPrivateKey) }
  }

  complete(response: AndroidSessionAccept, now = new Date()): AndroidCompanionSecureSession {
    if (this.#completed) throw new AndroidCompanionReplayError('session handshake was already completed')
    validateSessionAccept(response)
    const helloDigest = digestCanonical(unsignedHello(this.hello))
    if (response.companionDeviceId !== this.#companion.deviceId
      || response.studioDeviceId !== this.#studio.deviceId
      || response.helloDigest !== helloDigest
      || response.companionEphemeralPublicKey !== this.hello.ephemeralPublicKey) {
      throw new AndroidCompanionAuthenticationError('session response does not match the companion hello')
    }
    assertFreshWindow(response.issuedAt, response.expiresAt, now, 'session response')
    assertSessionExpiry(response.sessionExpiresAt, now)
    if (!verifyCanonical(unsignedAccept(response), response.signature, this.#studio.signingPublicKey)) {
      throw new AndroidCompanionAuthenticationError('invalid Studio session signature')
    }
    const studioEphemeralPublicKey = parsePublicKey(
      response.studioEphemeralPublicKey, 'x25519', 'Studio ephemeral key',
    )
    const companionStaticPrivateKey = createPrivateKey(this.#companion.exchangePrivateKey)
    const studioStaticPublicKey = parsePublicKey(
      this.#studio.exchangePublicKey, 'x25519', 'Studio exchange key',
    )
    const secrets = deriveSessionSecrets(combineSharedSecrets([
      diffieHellman({ privateKey: this.#ephemeralPrivateKey, publicKey: studioEphemeralPublicKey }),
      diffieHellman({ privateKey: this.#ephemeralPrivateKey, publicKey: studioStaticPublicKey }),
      diffieHellman({ privateKey: companionStaticPrivateKey, publicKey: studioEphemeralPublicKey }),
      diffieHellman({ privateKey: companionStaticPrivateKey, publicKey: studioStaticPublicKey }),
    ]), this.hello, response, this.#companion, this.#studio)
    this.#completed = true
    return new AndroidCompanionSecureSession(SESSION_CONSTRUCTOR_TOKEN, 'companion', response, secrets)
  }
}

export function acceptAndroidCompanionSession(input: {
  hello: AndroidSessionHello
  companion: AndroidCompanionPublicIdentity
  studio: AndroidCompanionPrivateIdentity
  now?: Date
  ttlMs?: number
  sessionTtlMs?: number
}): { response: AndroidSessionAccept; session: AndroidCompanionSecureSession } {
  validateSessionHello(input.hello)
  validatePublicIdentity(input.companion, 'paired companion identity')
  validatePrivateIdentity(input.studio, 'Studio identity')
  const now = input.now ?? new Date()
  const ttlMs = input.ttlMs ?? HANDSHAKE_TTL_MS
  const sessionTtlMs = input.sessionTtlMs ?? SESSION_TTL_MS
  assertTtl(ttlMs, 5_000, HANDSHAKE_TTL_MS, 'session response')
  assertTtl(sessionTtlMs, HANDSHAKE_TTL_MS, MAX_SESSION_TTL_MS, 'secure session')
  if (input.hello.companionDeviceId !== input.companion.deviceId
    || input.hello.studioDeviceId !== input.studio.deviceId
    || input.hello.companionExchangeFingerprint !== fingerprintKey(input.companion.exchangePublicKey, 'x25519')
    || input.hello.studioExchangeFingerprint !== fingerprintKey(input.studio.exchangePublicKey, 'x25519')) {
    throw new AndroidCompanionAuthenticationError('session hello does not match paired device identities')
  }
  assertFreshWindow(input.hello.issuedAt, input.hello.expiresAt, now, 'session hello')
  if (!verifyCanonical(unsignedHello(input.hello), input.hello.signature, input.companion.signingPublicKey)) {
    throw new AndroidCompanionAuthenticationError('invalid companion session signature')
  }
  const ephemeral = generateKeyPairSync('x25519')
  const helloDigest = digestCanonical(unsignedHello(input.hello))
  const unsigned = {
    protocolVersion: ANDROID_COMPANION_PROTOCOL_VERSION,
    type: 'session.accept' as const,
    sessionId: `android-session-${helloDigest.slice(0, 24)}-${randomBytes(8).toString('base64url')}`,
    companionDeviceId: input.companion.deviceId,
    studioDeviceId: input.studio.deviceId,
    helloDigest,
    companionEphemeralPublicKey: input.hello.ephemeralPublicKey,
    studioEphemeralPublicKey: exportPublicKey(ephemeral.publicKey),
    nonce: randomBytes(24).toString('base64url'),
    issuedAt: now.toISOString(),
    expiresAt: new Date(Math.min(Date.parse(input.hello.expiresAt), now.getTime() + ttlMs)).toISOString(),
    sessionExpiresAt: new Date(now.getTime() + sessionTtlMs).toISOString(),
  }
  const response: AndroidSessionAccept = {
    ...unsigned,
    signature: signCanonical(unsigned, input.studio.signingPrivateKey),
  }
  const companionEphemeralPublicKey = parsePublicKey(
    input.hello.ephemeralPublicKey, 'x25519', 'companion ephemeral key',
  )
  const studioStaticPrivateKey = createPrivateKey(input.studio.exchangePrivateKey)
  const companionStaticPublicKey = parsePublicKey(
    input.companion.exchangePublicKey, 'x25519', 'companion exchange key',
  )
  const secrets = deriveSessionSecrets(combineSharedSecrets([
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: companionEphemeralPublicKey }),
    diffieHellman({ privateKey: studioStaticPrivateKey, publicKey: companionEphemeralPublicKey }),
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: companionStaticPublicKey }),
    diffieHellman({ privateKey: studioStaticPrivateKey, publicKey: companionStaticPublicKey }),
  ]), input.hello, response, input.companion, input.studio)
  return {
    response,
    session: new AndroidCompanionSecureSession(SESSION_CONSTRUCTOR_TOKEN, 'studio', response, secrets),
  }
}

export class AndroidCompanionSecureSession {
  readonly sessionId: string
  readonly localDeviceId: string
  readonly remoteDeviceId: string
  readonly role: SessionRole
  readonly expiresAt: string
  #sendKey: Buffer
  #receiveKey: Buffer
  #sendNoncePrefix: Buffer
  #receiveNoncePrefix: Buffer
  #sentSequence = 0
  #receivedSequence = 0
  #closed = false

  constructor(
    token: typeof SESSION_CONSTRUCTOR_TOKEN,
    role: SessionRole,
    response: AndroidSessionAccept,
    secrets: SessionSecrets,
  ) {
    if (token !== SESSION_CONSTRUCTOR_TOKEN) {
      throw new AndroidCompanionAuthenticationError('secure sessions require an authenticated handshake')
    }
    this.role = role
    this.sessionId = response.sessionId
    this.localDeviceId = role === 'companion' ? response.companionDeviceId : response.studioDeviceId
    this.remoteDeviceId = role === 'companion' ? response.studioDeviceId : response.companionDeviceId
    this.expiresAt = response.sessionExpiresAt
    this.#sendKey = Buffer.from(role === 'companion' ? secrets.companionToStudioKey : secrets.studioToCompanionKey)
    this.#receiveKey = Buffer.from(role === 'companion' ? secrets.studioToCompanionKey : secrets.companionToStudioKey)
    this.#sendNoncePrefix = Buffer.from(role === 'companion' ? secrets.companionNoncePrefix : secrets.studioNoncePrefix)
    this.#receiveNoncePrefix = Buffer.from(role === 'companion' ? secrets.studioNoncePrefix : secrets.companionNoncePrefix)
  }

  get sentSequence(): number { return this.#sentSequence }
  get receivedSequence(): number { return this.#receivedSequence }
  get closed(): boolean { return this.#closed }

  encrypt(input: {
    messageType: AndroidCompanionMessageType
    bindingId: string
    payload: unknown
    expiresAt: string
    now?: Date
  }): AndroidEncryptedEnvelope {
    const now = input.now ?? new Date()
    this.assertOpen(now)
    assertMessageType(input.messageType)
    assertIdentifier(input.bindingId, 'envelope binding ID')
    assertEnvelopeExpiry(input.expiresAt, now, this.expiresAt)
    const plaintext = Buffer.from(canonicalJson(input.payload), 'utf8')
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new AndroidCompanionValidationError('Android companion plaintext exceeds the protocol limit')
    }
    const sequence = this.#sentSequence + 1
    const direction: AndroidEncryptedEnvelope['direction'] = this.role === 'companion'
      ? 'companion_to_studio'
      : 'studio_to_companion'
    const metadata = {
      protocolVersion: ANDROID_COMPANION_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      senderDeviceId: this.localDeviceId,
      recipientDeviceId: this.remoteDeviceId,
      direction,
      sequence,
      messageType: input.messageType,
      bindingId: input.bindingId,
      expiresAt: input.expiresAt,
      ciphertextLength: plaintext.byteLength,
    }
    const cipher = createCipheriv('aes-256-gcm', this.#sendKey, nonceFor(this.#sendNoncePrefix, sequence))
    cipher.setAAD(Buffer.from(canonicalJson(metadata), 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const authTag = cipher.getAuthTag()
    this.#sentSequence = sequence
    return {
      ...metadata,
      ciphertext: ciphertext.toString('base64url'),
      authTag: authTag.toString('base64url'),
    }
  }

  decrypt(envelope: AndroidEncryptedEnvelope, now = new Date()): unknown {
    this.assertOpen(now)
    try {
      validateEnvelope(envelope)
      const expectedDirection = this.role === 'companion' ? 'studio_to_companion' : 'companion_to_studio'
      if (envelope.sessionId !== this.sessionId
        || envelope.senderDeviceId !== this.remoteDeviceId
        || envelope.recipientDeviceId !== this.localDeviceId
        || envelope.direction !== expectedDirection) {
        throw new AndroidCompanionAuthenticationError('encrypted envelope is routed to the wrong session or device')
      }
      const expectedSequence = this.#receivedSequence + 1
      if (envelope.sequence !== expectedSequence) {
        throw new AndroidCompanionReplayError(
          `encrypted envelope sequence ${envelope.sequence} does not match expected ${expectedSequence}`,
        )
      }
      assertNotExpired(envelope.expiresAt, now, 'encrypted envelope')
      const ciphertext = decodeCanonicalBase64Url(envelope.ciphertext, 'ciphertext')
      const authTag = decodeCanonicalBase64Url(envelope.authTag, 'authentication tag')
      if (ciphertext.byteLength !== envelope.ciphertextLength || ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) {
        throw new AndroidCompanionValidationError('encrypted envelope ciphertext length is invalid')
      }
      if (authTag.byteLength !== 16) {
        throw new AndroidCompanionValidationError('encrypted envelope authentication tag is invalid')
      }
      const decipher = createDecipheriv(
        'aes-256-gcm', this.#receiveKey, nonceFor(this.#receiveNoncePrefix, envelope.sequence),
      )
      decipher.setAAD(Buffer.from(canonicalJson(envelopeMetadata(envelope)), 'utf8'))
      decipher.setAuthTag(authTag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
        throw new AndroidCompanionValidationError('decrypted Android companion payload exceeds the protocol limit')
      }
      const payload = JSON.parse(plaintext.toString('utf8')) as unknown
      if (canonicalJson(payload) !== plaintext.toString('utf8')) {
        throw new AndroidCompanionValidationError('decrypted Android companion payload is not canonical JSON')
      }
      this.#receivedSequence = envelope.sequence
      return payload
    } catch (error) {
      this.close()
      if (error instanceof AndroidCompanionValidationError
        || error instanceof AndroidCompanionAuthenticationError
        || error instanceof AndroidCompanionReplayError) throw error
      throw new AndroidCompanionAuthenticationError('encrypted envelope authentication failed')
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#sendKey.fill(0)
    this.#receiveKey.fill(0)
    this.#sendNoncePrefix.fill(0)
    this.#receiveNoncePrefix.fill(0)
  }

  private assertOpen(now: Date): void {
    if (this.#closed) throw new AndroidCompanionAuthenticationError('Android companion session is closed')
    if (Date.parse(this.expiresAt) <= now.getTime()) {
      this.close()
      throw new AndroidCompanionAuthenticationError('Android companion session expired')
    }
  }
}

function validatePairingTranscript(transcript: AndroidPairingTranscript): void {
  canonicalJson(transcript)
  if (transcript.protocolVersion !== ANDROID_COMPANION_PROTOCOL_VERSION) {
    throw new AndroidCompanionValidationError('unsupported Android companion protocol version')
  }
  assertIdentifier(transcript.challengeId, 'pairing challenge ID')
  assertNonce(transcript.challengeNonce, 'pairing challenge nonce')
  assertIsoDate(transcript.expiresAt, 'pairing transcript expiry')
  validatePublicIdentity(transcript.studio, 'Studio identity')
  validatePublicIdentity(transcript.companion, 'companion identity')
  assertIdentifier(transcript.companion.installationId, 'companion installation ID')
  assertBoundedText(transcript.companion.label, 1, 80, 'companion label')
  assertBoundedText(transcript.companion.androidVersion, 1, 40, 'Android version')
  assertBoundedText(transcript.companion.appVersion, 1, 40, 'companion app version')
  if (!DIGEST.test(transcript.initialCapabilitiesDigest)) {
    throw new AndroidCompanionValidationError('initial Android capabilities digest must be SHA-256 hex')
  }
}

function validateSessionHello(hello: AndroidSessionHello): void {
  canonicalJson(hello)
  if (hello.protocolVersion !== ANDROID_COMPANION_PROTOCOL_VERSION || hello.type !== 'session.hello') {
    throw new AndroidCompanionValidationError('invalid Android companion session hello')
  }
  assertIdentifier(hello.companionDeviceId, 'companion device ID')
  assertIdentifier(hello.studioDeviceId, 'Studio device ID')
  if (!DIGEST.test(hello.companionExchangeFingerprint) || !DIGEST.test(hello.studioExchangeFingerprint)) {
    throw new AndroidCompanionValidationError('session hello exchange fingerprint is invalid')
  }
  parsePublicKey(hello.ephemeralPublicKey, 'x25519', 'companion ephemeral key')
  assertNonce(hello.nonce, 'session hello nonce')
  assertIsoDate(hello.issuedAt, 'session hello issue time')
  assertIsoDate(hello.expiresAt, 'session hello expiry')
  assertSequence(hello.lastAcknowledgedSequence, true)
  decodeCanonicalBase64Url(hello.signature, 'session hello signature')
  canonicalJson(unsignedHello(hello))
}

function validateSessionAccept(response: AndroidSessionAccept): void {
  canonicalJson(response)
  if (response.protocolVersion !== ANDROID_COMPANION_PROTOCOL_VERSION || response.type !== 'session.accept') {
    throw new AndroidCompanionValidationError('invalid Android companion session response')
  }
  assertIdentifier(response.sessionId, 'Android companion session ID')
  assertIdentifier(response.companionDeviceId, 'companion device ID')
  assertIdentifier(response.studioDeviceId, 'Studio device ID')
  if (!DIGEST.test(response.helloDigest)) throw new AndroidCompanionValidationError('invalid session hello digest')
  parsePublicKey(response.companionEphemeralPublicKey, 'x25519', 'companion ephemeral key')
  parsePublicKey(response.studioEphemeralPublicKey, 'x25519', 'Studio ephemeral key')
  assertNonce(response.nonce, 'session response nonce')
  assertIsoDate(response.issuedAt, 'session response issue time')
  assertIsoDate(response.expiresAt, 'session response expiry')
  assertIsoDate(response.sessionExpiresAt, 'secure session expiry')
  decodeCanonicalBase64Url(response.signature, 'session response signature')
  canonicalJson(unsignedAccept(response))
}

function validateEnvelope(envelope: AndroidEncryptedEnvelope): void {
  assertSafeRecord(envelope, 'encrypted envelope')
  if (envelope.protocolVersion !== ANDROID_COMPANION_PROTOCOL_VERSION) {
    throw new AndroidCompanionValidationError('unsupported encrypted envelope protocol version')
  }
  assertIdentifier(envelope.sessionId, 'Android companion session ID')
  assertIdentifier(envelope.senderDeviceId, 'envelope sender device ID')
  assertIdentifier(envelope.recipientDeviceId, 'envelope recipient device ID')
  if (envelope.direction !== 'companion_to_studio' && envelope.direction !== 'studio_to_companion') {
    throw new AndroidCompanionValidationError('invalid encrypted envelope direction')
  }
  assertSequence(envelope.sequence, false)
  assertMessageType(envelope.messageType)
  assertIdentifier(envelope.bindingId, 'envelope binding ID')
  assertIsoDate(envelope.expiresAt, 'encrypted envelope expiry')
  if (!Number.isSafeInteger(envelope.ciphertextLength) || envelope.ciphertextLength < 0
    || envelope.ciphertextLength > MAX_CIPHERTEXT_BYTES) {
    throw new AndroidCompanionValidationError('encrypted envelope ciphertext length is invalid')
  }
}

function validatePublicIdentity(identity: AndroidCompanionPublicIdentity, label: string): void {
  assertSafeRecord(identity, label)
  assertIdentifier(identity.deviceId, `${label} device ID`)
  const signingKey = parsePublicKey(identity.signingPublicKey, 'ed25519', `${label} signing public key`)
  parsePublicKey(identity.exchangePublicKey, 'x25519', `${label} exchange public key`)
  const normalizedSigningKey = exportPublicKey(signingKey)
  if (deviceIdFromPublicKey(normalizedSigningKey) !== identity.deviceId || normalizedSigningKey !== identity.signingPublicKey) {
    throw new AndroidCompanionValidationError(`${label} device ID or signing key is non-canonical`)
  }
}

function validatePrivateIdentity(identity: AndroidCompanionPrivateIdentity, label: string): void {
  validatePublicIdentity(identity, label)
  const signingPrivate = assertPrivateKey(identity.signingPrivateKey, 'ed25519', `${label} signing private key`)
  const exchangePrivate = assertPrivateKey(identity.exchangePrivateKey, 'x25519', `${label} exchange private key`)
  if (exportPublicKey(createPublicKey(signingPrivate)) !== identity.signingPublicKey
    || exportPublicKey(createPublicKey(exchangePrivate)) !== identity.exchangePublicKey) {
    throw new AndroidCompanionValidationError(`${label} public and private keys do not match`)
  }
}

function parsePublicKey(value: string, type: 'ed25519' | 'x25519', label: string): KeyObject {
  try {
    const key = createPublicKey(value)
    if (key.asymmetricKeyType !== type || exportPublicKey(key) !== value) throw new Error('non-canonical key')
    return key
  } catch {
    throw new AndroidCompanionValidationError(`${label} must be a canonical ${type} public key`)
  }
}

function assertPrivateKey(value: string, type: 'ed25519' | 'x25519', label: string): KeyObject {
  try {
    const key = createPrivateKey(value)
    if (key.asymmetricKeyType !== type) throw new Error('wrong key type')
    return key
  } catch {
    throw new AndroidCompanionValidationError(`${label} must be a ${type} private key`)
  }
}

function exportPublicKey(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'pem' }).toString()
}

function fingerprintKey(key: string, type: 'ed25519' | 'x25519'): string {
  return createHash('sha256').update(exportPublicKey(parsePublicKey(key, type, `${type} key`))).digest('hex')
}

function unsignedHello(hello: AndroidSessionHello): Omit<AndroidSessionHello, 'signature'> {
  const { signature: _signature, ...unsigned } = hello
  return unsigned
}

function unsignedAccept(response: AndroidSessionAccept): Omit<AndroidSessionAccept, 'signature'> {
  const { signature: _signature, ...unsigned } = response
  return unsigned
}

function signCanonical(value: unknown, privateKey: string): string {
  return sign(null, Buffer.from(canonicalJson(value), 'utf8'), privateKey).toString('base64url')
}

function verifyCanonical(value: unknown, signature: string, publicKey: string): boolean {
  try {
    const decoded = decodeCanonicalBase64Url(signature, 'signature')
    return verify(null, Buffer.from(canonicalJson(value), 'utf8'), publicKey, decoded)
  } catch {
    return false
  }
}

function deriveSessionSecrets(
  sharedSecret: Buffer,
  hello: AndroidSessionHello,
  response: AndroidSessionAccept,
  companion: AndroidCompanionPublicIdentity,
  studio: AndroidCompanionPublicIdentity,
): SessionSecrets {
  const context = canonicalJson({
    protocolVersion: ANDROID_COMPANION_PROTOCOL_VERSION,
    sessionId: response.sessionId,
    helloDigest: response.helloDigest,
    responseDigest: digestCanonical(unsignedAccept(response)),
    companion: {
      deviceId: companion.deviceId,
      signingFingerprint: fingerprintKey(companion.signingPublicKey, 'ed25519'),
      exchangeFingerprint: fingerprintKey(companion.exchangePublicKey, 'x25519'),
    },
    studio: {
      deviceId: studio.deviceId,
      signingFingerprint: fingerprintKey(studio.signingPublicKey, 'ed25519'),
      exchangeFingerprint: fingerprintKey(studio.exchangePublicKey, 'x25519'),
    },
  })
  const salt = createHash('sha256').update(`${hello.nonce}\0${response.nonce}`).digest()
  const material = Buffer.from(hkdfSync('sha256', sharedSecret, salt, Buffer.from(context, 'utf8'), 72))
  try {
    return {
      companionToStudioKey: Buffer.from(material.subarray(0, 32)),
      studioToCompanionKey: Buffer.from(material.subarray(32, 64)),
      companionNoncePrefix: Buffer.from(material.subarray(64, 68)),
      studioNoncePrefix: Buffer.from(material.subarray(68, 72)),
    }
  } finally {
    sharedSecret.fill(0)
    material.fill(0)
  }
}

function combineSharedSecrets(secrets: Buffer[]): Buffer {
  const combined = Buffer.concat(secrets)
  for (const secret of secrets) secret.fill(0)
  return combined
}

function nonceFor(prefix: Buffer, sequence: number): Buffer {
  const nonce = Buffer.alloc(12)
  prefix.copy(nonce, 0)
  nonce.writeBigUInt64BE(BigInt(sequence), 4)
  return nonce
}

function envelopeMetadata(envelope: AndroidEncryptedEnvelope): Omit<AndroidEncryptedEnvelope, 'ciphertext' | 'authTag'> {
  const { ciphertext: _ciphertext, authTag: _authTag, ...metadata } = envelope
  return metadata
}

function pairingCodeDigest(challengeId: string, code: string): Buffer {
  return createHash('sha256').update(`${challengeId}\0${code}`, 'utf8').digest()
}

function digestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function canonicalJson(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (depth > 12) throw new AndroidCompanionValidationError('Android companion protocol value is too deeply nested')
  if (value === null) return 'null'
  if (typeof value === 'string') {
    if (value.length > 16_384) throw new AndroidCompanionValidationError('Android companion protocol string is too large')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new AndroidCompanionValidationError('Android companion protocol number is invalid')
    }
    return JSON.stringify(value)
  }
  if (typeof value !== 'object' || isProxy(value)) {
    throw new AndroidCompanionValidationError('Android companion protocol value must be plain JSON')
  }
  if (seen.has(value)) throw new AndroidCompanionValidationError('Android companion protocol value is cyclic')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > 256) throw new AndroidCompanionValidationError('Android companion protocol array is too large')
      const descriptors = Object.getOwnPropertyDescriptors(value)
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === 'length') continue
        if (!/^\d+$/.test(key) || String(Number(key)) !== key || descriptor.get || descriptor.set
          || !descriptor.enumerable || !('value' in descriptor)) {
          throw new AndroidCompanionValidationError('Android companion protocol array has unsafe properties')
        }
      }
      if (Object.getOwnPropertySymbols(value).length > 0
        || Object.keys(descriptors).length - 1 !== value.length) {
        throw new AndroidCompanionValidationError('Android companion protocol array must not be sparse')
      }
      return `[${value.map(item => canonicalJson(item, depth + 1, seen)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AndroidCompanionValidationError('Android companion protocol object must be plain')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new AndroidCompanionValidationError('Android companion protocol object has unsafe properties')
    }
    const keys = Object.keys(descriptors).sort()
    if (keys.length > 128) throw new AndroidCompanionValidationError('Android companion protocol object has too many fields')
    const fields = keys.map(key => {
      const descriptor = descriptors[key]!
      if (descriptor.get || descriptor.set || !descriptor.enumerable || !('value' in descriptor)
        || descriptor.value === undefined) {
        throw new AndroidCompanionValidationError('Android companion protocol object has unsafe properties')
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, depth + 1, seen)}`
    })
    return `{${fields.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function assertSafeRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new AndroidCompanionValidationError(`${label} must be a plain object`)
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set || !descriptor.enumerable || !('value' in descriptor)) {
      throw new AndroidCompanionValidationError(`${label} has unsafe properties`)
    }
  }
}

function decodeCanonicalBase64Url(value: string, label: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AndroidCompanionValidationError(`${label} is not canonical base64url`)
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) {
    throw new AndroidCompanionValidationError(`${label} is not canonical base64url`)
  }
  return decoded
}

function assertFreshWindow(issuedAt: string, expiresAt: string, now: Date, label: string): void {
  const issued = assertIsoDate(issuedAt, `${label} issue time`)
  const expires = assertIsoDate(expiresAt, `${label} expiry`)
  if (issued > now.getTime() + MAX_CLOCK_SKEW_MS || issued < now.getTime() - HANDSHAKE_TTL_MS - MAX_CLOCK_SKEW_MS
    || expires <= now.getTime() || expires <= issued || expires - issued > HANDSHAKE_TTL_MS) {
    throw new AndroidCompanionAuthenticationError(`${label} is stale or has an invalid validity window`)
  }
}

function assertEnvelopeExpiry(expiresAt: string, now: Date, sessionExpiresAt: string): void {
  const expires = assertIsoDate(expiresAt, 'encrypted envelope expiry')
  if (expires <= now.getTime() || expires > now.getTime() + MAX_ENVELOPE_TTL_MS
    || expires > Date.parse(sessionExpiresAt)) {
    throw new AndroidCompanionValidationError('encrypted envelope expiry is outside the session validity window')
  }
}

function assertSessionExpiry(expiresAt: string, now: Date): void {
  const expires = assertIsoDate(expiresAt, 'secure session expiry')
  if (expires <= now.getTime() || expires > now.getTime() + MAX_SESSION_TTL_MS) {
    throw new AndroidCompanionAuthenticationError('secure session expiry is outside the allowed window')
  }
}

function assertNotExpired(expiresAt: string, now: Date, label: string): void {
  const expires = assertIsoDate(expiresAt, `${label} expiry`)
  if (expires <= now.getTime()) throw new AndroidCompanionAuthenticationError(`${label} expired`)
}

function assertIsoDate(value: string, label: string): number {
  if (typeof value !== 'string' || value.length !== 24 || new Date(value).toISOString() !== value) {
    throw new AndroidCompanionValidationError(`${label} must be a canonical ISO timestamp`)
  }
  return Date.parse(value)
}

function assertTtl(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AndroidCompanionValidationError(`${label} TTL is outside the allowed range`)
  }
}

function assertSequence(value: number, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new AndroidCompanionValidationError('Android companion sequence is invalid')
  }
  return value
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new AndroidCompanionValidationError(`${label} is invalid`)
  }
}

function assertNonce(value: string, label: string): void {
  const nonce = decodeCanonicalBase64Url(value, label)
  if (nonce.byteLength < 16 || nonce.byteLength > 64) {
    throw new AndroidCompanionValidationError(`${label} has an invalid size`)
  }
}

function assertBoundedText(value: string, min: number, max: number, label: string): void {
  if (typeof value !== 'string' || value.trim() !== value || value.length < min || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AndroidCompanionValidationError(`${label} is invalid`)
  }
}

function assertMessageType(value: string): asserts value is AndroidCompanionMessageType {
  if (!MESSAGE_TYPES.has(value)) throw new AndroidCompanionValidationError('unknown Android companion message type')
}

import type { AndroidCompanionStore } from './store'
import {
  AndroidPairingChallengeRegistry,
  verifyAndroidPairingTranscript,
  type AndroidCompanionPrivateIdentity,
  type AndroidCompanionPublicIdentity,
  type AndroidPairingChallenge,
  type SignedAndroidPairingTranscript,
} from './crypto'
import {
  AndroidCompanionAuthenticationError,
  AndroidCompanionValidationError,
  type AndroidCompanionDevice,
} from './types'

export interface AndroidPairingOffer {
  challenge: AndroidPairingChallenge
  studio: AndroidCompanionPublicIdentity
}

export interface CompleteAndroidPairingInput {
  challengeId: string
  code: string
  signedTranscript: SignedAndroidPairingTranscript
  approvedByUser: boolean
  now?: Date
}

export class AndroidCompanionPairingService {
  readonly #store: AndroidCompanionStore
  readonly #studioIdentity: () => Promise<AndroidCompanionPrivateIdentity>
  readonly #challenges: AndroidPairingChallengeRegistry

  constructor(input: {
    store: AndroidCompanionStore
    studioIdentity: () => Promise<AndroidCompanionPrivateIdentity>
    challenges?: AndroidPairingChallengeRegistry
  }) {
    this.#store = input.store
    this.#studioIdentity = input.studioIdentity
    this.#challenges = input.challenges ?? new AndroidPairingChallengeRegistry()
  }

  async issue(now = new Date(), ttlMs?: number): Promise<AndroidPairingOffer> {
    const studio = await this.#studioIdentity()
    const challenge = this.#challenges.issue(studio.deviceId, now, ttlMs)
    return { challenge, studio: publicIdentity(studio) }
  }

  async complete(input: CompleteAndroidPairingInput): Promise<{
    disposition: 'created' | 'replayed'
    device: AndroidCompanionDevice
  }> {
    if (input.approvedByUser !== true) {
      throw new AndroidCompanionAuthenticationError('explicit local approval is required for Android pairing')
    }
    const now = input.now ?? new Date()
    const studio = await this.#studioIdentity()
    const challenge = this.#challenges.consume(input.challengeId, input.code, now)
    const transcript = verifyAndroidPairingTranscript({
      signed: input.signedTranscript,
      challenge,
      expectedStudio: publicIdentity(studio),
      now,
    })
    if (transcript.challengeId !== input.challengeId) {
      throw new AndroidCompanionValidationError('Android pairing challenge identity changed')
    }
    return this.#store.pairDevice({
      deviceId: transcript.companion.deviceId,
      installationId: transcript.companion.installationId,
      signingPublicKey: transcript.companion.signingPublicKey,
      exchangePublicKey: transcript.companion.exchangePublicKey,
      label: transcript.companion.label,
      androidVersion: transcript.companion.androidVersion,
      appVersion: transcript.companion.appVersion,
      pairedAt: now.toISOString(),
    })
  }

  revokeOffer(challengeId: string): boolean {
    return this.#challenges.revoke(challengeId)
  }

  get activeOfferCount(): number { return this.#challenges.size }
}

export function publicIdentity(identity: AndroidCompanionPrivateIdentity): AndroidCompanionPublicIdentity {
  return {
    deviceId: identity.deviceId,
    signingPublicKey: identity.signingPublicKey,
    exchangePublicKey: identity.exchangePublicKey,
  }
}

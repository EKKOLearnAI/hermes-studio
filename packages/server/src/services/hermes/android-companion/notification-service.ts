import { createHash } from 'crypto'
import { isProxy } from 'node:util/types'
import { isFabricSensitiveString } from '../action-fabric/audit'
import { recordTwinFactBatchWithDisposition } from '../personal-twin'
import type { TwinEventInput } from '../personal-twin/types'
import type { AndroidCompanionGatewayMessage, AndroidCompanionGatewayReply } from './gateway'
import type { AndroidCompanionStore } from './store'
import {
  AndroidCompanionValidationError,
  type AndroidNotificationObservation,
  type AndroidNotificationSensitivity,
} from './types'

const PACKAGE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/
const CATEGORY = /^[a-z][a-z0-9_.-]{0,79}$/
const SECRET_CONTENT = /(?:\b(?:otp|2fa|verification\s*code|one[- ]time\s*(?:code|password)|passcode|password|pin)\b|验证码|动态码|一次性密码|\b\d{4,8}\b)/i
const SENSITIVE_DOMAIN = /(?:auth|login|security|bank|banking|finance|financial|payment|transaction|health|medical|otp|verification|银行|金融|付款|支付|转账|交易|健康|医疗|验证码)/i
const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60_000
const MAX_FUTURE_SKEW_MS = 5 * 60_000

export interface AndroidNotificationPackagePolicy {
  packageBinding: string
  sensitivity: AndroidNotificationSensitivity
}

export const DEFAULT_ANDROID_NOTIFICATION_POLICIES: readonly AndroidNotificationPackagePolicy[] = [
  { packageBinding: 'ai.hermes.companion', sensitivity: 'standard' },
]

export interface AndroidNotificationTwinProjector {
  project(event: TwinEventInput): 'created' | 'replayed'
}

export class AndroidCompanionNotificationService {
  readonly #store: AndroidCompanionStore
  readonly #policies: ReadonlyMap<string, AndroidNotificationPackagePolicy>
  readonly #projector: AndroidNotificationTwinProjector
  readonly #now: () => Date

  constructor(input: {
    store: AndroidCompanionStore
    packagePolicies?: readonly AndroidNotificationPackagePolicy[]
    projector?: AndroidNotificationTwinProjector
    now?: () => Date
  }) {
    this.#store = input.store
    this.#policies = normalizePolicies(input.packagePolicies ?? DEFAULT_ANDROID_NOTIFICATION_POLICIES)
    this.#projector = input.projector ?? defaultProjector()
    this.#now = input.now ?? (() => new Date())
  }

  handleMessage(message: AndroidCompanionGatewayMessage): AndroidCompanionGatewayReply | undefined {
    if (message.messageType === 'notification.observed') return this.observe(message)
    if (message.messageType === 'notification.removed') return this.remove(message)
    return undefined
  }

  private observe(message: AndroidCompanionGatewayMessage): AndroidCompanionGatewayReply {
    const payload = observedPayload(message.payload, this.#policies, this.#now())
    const minimized = minimize(payload)
    const identity = {
      deviceId: message.deviceId,
      packageBinding: payload.packageBinding,
      notificationKeyHash: payload.notificationKeyHash,
      postedAt: payload.postedAt,
    }
    const provenance = {
      ...identity,
      category: payload.category,
      channelHash: payload.channelHash,
      titleSummary: minimized.titleSummary,
      textSummary: minimized.textSummary,
      sensitivity: minimized.sensitivity,
    }
    const id = `notification-${hash(identity).slice(0, 48)}`
    const stored = this.#store.observeNotification({
      id,
      ...provenance,
      sourceSequence: payload.sourceSequence,
      provenanceDigest: hash(provenance),
    })
    this.#projector.project(observedTwinEvent(stored.observation))
    return acknowledgement(message, stored.observation, stored.disposition)
  }

  private remove(message: AndroidCompanionGatewayMessage): AndroidCompanionGatewayReply {
    const payload = removedPayload(message.payload, this.#now())
    const stored = this.#store.removeNotification({ deviceId: message.deviceId, ...payload })
    this.#projector.project(removedTwinEvent(stored.observation))
    return acknowledgement(message, stored.observation, stored.disposition)
  }
}

type ObservedPayload = {
  packageBinding: string
  notificationKeyHash: string
  category: string
  channelHash: string | null
  title: string
  text: string
  visibility: 'public' | 'private' | 'secret'
  postedAt: string
  sourceSequence: number
  policy: AndroidNotificationPackagePolicy
}

function observedPayload(
  value: unknown,
  policies: ReadonlyMap<string, AndroidNotificationPackagePolicy>,
  now: Date,
): ObservedPayload {
  if (!plainRecord(value) || !exactKeys(value, [
    'category', 'channelHash', 'notificationKeyHash', 'packageBinding', 'postedAt', 'sourceSequence',
    'text', 'title', 'visibility',
  ])) throw invalid('Android notification observation envelope is invalid')
  const packageBinding = dataString(value, 'packageBinding', 255)
  const policy = policies.get(packageBinding)
  if (!policy) throw invalid('Android notification package is not allowlisted')
  const category = dataString(value, 'category', 80)
  if (!CATEGORY.test(category)) throw invalid('Android notification category is invalid')
  const visibility = dataString(value, 'visibility', 16)
  if (!['public', 'private', 'secret'].includes(visibility)) throw invalid('Android notification visibility is invalid')
  const channel = data(value, 'channelHash')
  const channelHash = channel === null ? null : sha256String(channel, 'Android notification channel hash')
  const postedAt = boundedTimestamp(data(value, 'postedAt'), 'Android notification posted time', now)
  return {
    packageBinding,
    notificationKeyHash: sha256String(data(value, 'notificationKeyHash'), 'Android notification key hash'),
    category,
    channelHash,
    title: dataString(value, 'title', 2_000, true),
    text: dataString(value, 'text', 4_000, true),
    visibility: visibility as ObservedPayload['visibility'],
    postedAt,
    sourceSequence: positiveSequence(data(value, 'sourceSequence')),
    policy,
  }
}

function removedPayload(value: unknown, now: Date): {
  notificationKeyHash: string; postedAt: string; removedAt: string; sourceSequence: number
} {
  if (!plainRecord(value) || !exactKeys(value, [
    'notificationKeyHash', 'postedAt', 'removedAt', 'sourceSequence',
  ])) throw invalid('Android notification removal envelope is invalid')
  const postedAt = boundedTimestamp(data(value, 'postedAt'), 'Android notification posted time', now)
  const removedAt = boundedTimestamp(data(value, 'removedAt'), 'Android notification removed time', now)
  if (Date.parse(removedAt) < Date.parse(postedAt)) throw invalid('Android notification removal precedes posting')
  return {
    notificationKeyHash: sha256String(data(value, 'notificationKeyHash'), 'Android notification key hash'),
    postedAt,
    removedAt,
    sourceSequence: positiveSequence(data(value, 'sourceSequence')),
  }
}

function minimize(payload: ObservedPayload): {
  titleSummary: string; textSummary: string; sensitivity: AndroidNotificationSensitivity
} {
  const normalizedTitle = normalizeText(payload.title)
  const normalizedText = normalizeText(payload.text)
  const containsSensitiveMaterial = payload.visibility === 'secret' || SENSITIVE_DOMAIN.test(payload.category)
    || SENSITIVE_DOMAIN.test(`${normalizedTitle} ${normalizedText}`)
    || SECRET_CONTENT.test(`${normalizedTitle} ${normalizedText}`)
    || isFabricSensitiveString(normalizedTitle) || isFabricSensitiveString(normalizedText)
  if (containsSensitiveMaterial || payload.policy.sensitivity === 'metadata') {
    return { titleSummary: '', textSummary: '', sensitivity: 'metadata' }
  }
  if (payload.visibility === 'private' || payload.policy.sensitivity === 'minimized') {
    return { titleSummary: truncate(normalizedTitle, 80), textSummary: '', sensitivity: 'minimized' }
  }
  return {
    titleSummary: truncate(normalizedTitle, 160),
    textSummary: truncate(normalizedText, 320),
    sensitivity: 'standard',
  }
}

function observedTwinEvent(observation: AndroidNotificationObservation): TwinEventInput {
  return {
    eventType: 'digital_life.android.notification.observed',
    subjectId: 'person:self',
    payload: publicObservation(observation),
    occurredAt: observation.postedAt,
    source: 'android-companion',
    sourceId: observation.id,
    actor: `android:${observation.deviceId}`,
    confidence: 1,
    confirmationState: 'observed',
    evidence: [{ evidenceClass: 'device_observation', provenanceDigest: observation.provenanceDigest }],
  }
}

function removedTwinEvent(observation: AndroidNotificationObservation): TwinEventInput {
  if (!observation.removedAt) throw invalid('Android notification removal is incomplete')
  return {
    eventType: 'digital_life.android.notification.removed',
    subjectId: 'person:self',
    payload: { observationId: observation.id, packageBinding: observation.packageBinding,
      category: observation.category, sensitivity: observation.sensitivity },
    occurredAt: observation.removedAt,
    source: 'android-companion',
    sourceId: `${observation.id}-removed`,
    actor: `android:${observation.deviceId}`,
    confidence: 1,
    confirmationState: 'observed',
    evidence: [{ evidenceClass: 'device_observation', provenanceDigest: observation.provenanceDigest }],
  }
}

function publicObservation(observation: AndroidNotificationObservation): Record<string, unknown> {
  return {
    observationId: observation.id,
    packageBinding: observation.packageBinding,
    category: observation.category,
    channelHash: observation.channelHash,
    titleSummary: observation.titleSummary,
    textSummary: observation.textSummary,
    sensitivity: observation.sensitivity,
  }
}

function acknowledgement(
  message: AndroidCompanionGatewayMessage,
  observation: AndroidNotificationObservation,
  disposition: string,
): AndroidCompanionGatewayReply {
  return {
    messageType: 'ack',
    bindingId: message.bindingId,
    payload: {
      acknowledgedSequence: message.sequence,
      observationId: observation.id,
      disposition,
      sensitivity: observation.sensitivity,
    },
  }
}

function defaultProjector(): AndroidNotificationTwinProjector {
  return {
    project(event) {
      const result = recordTwinFactBatchWithDisposition({ ensureCanonicalSelf: true, events: [event] })
      return result.eventDispositions[0] === 'new' ? 'created' : 'replayed'
    },
  }
}

function normalizePolicies(policies: readonly AndroidNotificationPackagePolicy[]): ReadonlyMap<string, AndroidNotificationPackagePolicy> {
  if (!Array.isArray(policies) || policies.length === 0 || policies.length > 128) {
    throw invalid('Android notification package policies are invalid')
  }
  const result = new Map<string, AndroidNotificationPackagePolicy>()
  for (const policy of policies) {
    const sensitivity = String((policy as { sensitivity?: unknown }).sensitivity)
    if (!plainRecord(policy) || !exactKeys(policy, ['packageBinding', 'sensitivity'])
      || typeof policy.packageBinding !== 'string' || !PACKAGE.test(policy.packageBinding)
      || !['metadata', 'minimized', 'standard'].includes(sensitivity)
      || result.has(policy.packageBinding)) throw invalid('Android notification package policy is invalid')
    result.set(policy.packageBinding, {
      packageBinding: policy.packageBinding,
      sensitivity: sensitivity as AndroidNotificationSensitivity,
    })
  }
  return result
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function data(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor)) throw invalid('Android notification accessor is forbidden')
  return descriptor.value
}

function dataString(value: Record<string, unknown>, key: string, max: number, empty = false): string {
  const item = data(value, key)
  if (typeof item !== 'string' || item.length > max || (!empty && item.length === 0)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item)) {
    throw invalid(`Android notification ${key} is invalid`)
  }
  return item
}

function sha256String(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw invalid(`${label} is invalid`)
  return value
}

function positiveSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid('Android notification source sequence is invalid')
  return Number(value)
}

function boundedTimestamp(value: unknown, label: string, now: Date): string {
  if (typeof value !== 'string') throw invalid(`${label} is invalid`)
  let parsed: number
  try {
    if (new Date(value).toISOString() !== value) throw new Error('noncanonical')
    parsed = Date.parse(value)
  } catch {
    throw invalid(`${label} is invalid`)
  }
  if (parsed < now.getTime() - MAX_EVENT_AGE_MS || parsed > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw invalid(`${label} is outside the accepted window`)
  }
  return value
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function truncate(value: string, max: number): string {
  return [...value].slice(0, max).join('')
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function invalid(message: string): AndroidCompanionValidationError {
  return new AndroidCompanionValidationError(message)
}

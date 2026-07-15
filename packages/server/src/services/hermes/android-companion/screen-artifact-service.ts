import { createHash } from 'crypto'
import { isProxy } from 'node:util/types'
import type { AndroidCompanionGatewayMessage, AndroidCompanionGatewayReply } from './gateway'
import type { AndroidCompanionStore } from './store'
import { AndroidCompanionValidationError } from './types'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const OPAQUE_ENCRYPTED_REFERENCE = /^[A-Za-z0-9_-]{43,684}$/
const FRESH_CAPTURE_MS = 2 * 60_000

export class AndroidCompanionScreenArtifactService {
  readonly #store: AndroidCompanionStore
  readonly #now: () => Date

  constructor(input: { store: AndroidCompanionStore; now?: () => Date }) {
    this.#store = input.store
    this.#now = input.now ?? (() => new Date())
  }

  handleMessage(message: AndroidCompanionGatewayMessage): AndroidCompanionGatewayReply | undefined {
    if (message.messageType !== 'screen.capture.result') return undefined
    const payload = capturePayload(message.payload, this.#now())
    if (message.bindingId !== payload.workflowId) throw invalid('Android screen artifact route binding is invalid')
    const command = this.#store.getCommand(payload.commandId)
    if (!command || command.deviceId !== message.deviceId || command.workflowId !== payload.workflowId
      || command.executionToken !== payload.executionToken || command.materialDigest !== payload.materialDigest
      || command.kind !== 'screen_capture') throw invalid('Android screen artifact command binding is invalid')
    const identity: AndroidScreenArtifactIdentity = {
      deviceId: message.deviceId,
      workflowId: payload.workflowId,
      commandId: payload.commandId,
      captureId: payload.captureId,
      digest: payload.digest,
      capturedAt: payload.capturedAt,
    }
    const artifact = this.#store.recordScreenArtifact({
      id: androidScreenArtifactId(identity),
      deviceId: message.deviceId,
      workflowId: payload.workflowId,
      commandId: payload.commandId,
      digest: payload.digest,
      mimeType: payload.mimeType,
      width: payload.width,
      height: payload.height,
      byteSize: payload.byteSize,
      encryptionContextDigest: hash({ ...identity, encryptedReference: payload.encryptedArtifactRef }),
      capturedAt: payload.capturedAt,
    })
    return {
      messageType: 'ack',
      bindingId: message.bindingId,
      payload: {
        acknowledgedSequence: message.sequence,
        artifactId: artifact.artifact.id,
        disposition: artifact.disposition,
      },
    }
  }
}

export interface AndroidScreenArtifactIdentity {
  deviceId: string
  workflowId: string
  commandId: string
  captureId: string
  digest: string
  capturedAt: string
}

export function androidScreenArtifactId(identity: AndroidScreenArtifactIdentity): string {
  return `screen-artifact-${hash(identity).slice(0, 48)}`
}

type CapturePayload = {
  commandId: string
  workflowId: string
  executionToken: string
  materialDigest: string
  captureId: string
  digest: string
  mimeType: 'image/png' | 'image/webp'
  width: number
  height: number
  byteSize: number
  permissionGrantActive: true
  capturedAt: string
  encryptedArtifactRef: string
}

function capturePayload(value: unknown, now: Date): CapturePayload {
  if (!plainRecord(value) || !exactKeys(value, [
    'byteSize', 'captureId', 'capturedAt', 'commandId', 'digest', 'encryptedArtifactRef', 'executionToken',
    'height', 'materialDigest', 'mimeType', 'permissionGrantActive', 'width', 'workflowId',
  ])) throw invalid('Android screen artifact envelope is invalid')
  const capturedAt = canonicalTimestamp(data(value, 'capturedAt'), 'Android screen artifact capture time')
  const age = now.getTime() - Date.parse(capturedAt)
  if (age < -30_000 || age > FRESH_CAPTURE_MS) throw invalid('Android screen artifact is not fresh')
  const mimeType = data(value, 'mimeType')
  const permissionGrantActive = data(value, 'permissionGrantActive')
  const encryptedArtifactRef = data(value, 'encryptedArtifactRef')
  if (!['image/png', 'image/webp'].includes(String(mimeType)) || permissionGrantActive !== true
    || typeof encryptedArtifactRef !== 'string' || !OPAQUE_ENCRYPTED_REFERENCE.test(encryptedArtifactRef)) {
    throw invalid('Android screen artifact permission or encrypted reference is invalid')
  }
  return {
    commandId: identifier(data(value, 'commandId'), 'Android screen artifact command id'),
    workflowId: workflowIdentifier(data(value, 'workflowId')),
    executionToken: identifier(data(value, 'executionToken'), 'Android screen artifact execution token'),
    materialDigest: digest(data(value, 'materialDigest'), 'Android screen artifact material digest'),
    captureId: identifier(data(value, 'captureId'), 'Android screen capture id'),
    digest: digest(data(value, 'digest'), 'Android screen artifact digest'),
    mimeType: mimeType as CapturePayload['mimeType'],
    width: boundedInteger(data(value, 'width'), 1, 16_384, 'width'),
    height: boundedInteger(data(value, 'height'), 1, 16_384, 'height'),
    byteSize: boundedInteger(data(value, 'byteSize'), 1, 52_428_800, 'byte size'),
    permissionGrantActive: true,
    capturedAt,
    encryptedArtifactRef,
  }
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
  if (!descriptor || !('value' in descriptor)) throw invalid('Android screen artifact accessor is forbidden')
  return descriptor.value
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw invalid(`${label} is invalid`)
  return value
}

function workflowIdentifier(value: unknown): string {
  const id = identifier(value, 'Android screen artifact workflow id')
  if (!id.startsWith('workflow-') || id.length < 10) throw invalid('Android screen artifact workflow id is invalid')
  return id
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw invalid(`${label} is invalid`)
  return value
}

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw invalid(`Android screen artifact ${label} is invalid`)
  }
  return Number(value)
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw invalid(`${label} is invalid`)
  try {
    if (new Date(value).toISOString() !== value) throw new Error('noncanonical')
    return value
  } catch {
    throw invalid(`${label} is invalid`)
  }
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

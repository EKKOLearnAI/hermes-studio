import { createHash } from 'crypto'
import { isProxy } from 'node:util/types'
import {
  getFabricWorkflow,
  retryFabricWorkflow,
  type FabricWorkflowDetail,
} from '../action-fabric'
import type { AndroidCompanionGatewayMessage, AndroidCompanionGatewayReply } from './gateway'
import type { AndroidCompanionStore } from './store'
import { AndroidCompanionValidationError, type AndroidTakeover } from './types'

const TAKEOVER_REASONS = new Set([
  'CHALLENGE_REQUIRED',
  'LOGIN_REQUIRED',
  'BIOMETRIC_REQUIRED',
  'PERMISSION_REQUIRED',
  'LAYOUT_CHANGED',
  'RESULT_UNCERTAIN',
])
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
const SEMANTIC_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9][a-z0-9-]*)+$/
const OPAQUE_PROOF = /^[A-Za-z0-9_-]{43,256}$/
const REQUEST_FRESHNESS_MS = 5 * 60_000
const MAX_TAKEOVER_LIFETIME_MS = 30 * 60_000

export interface AndroidTakeoverWorkflowGateway {
  get(workflowId: string): FabricWorkflowDetail | null
  resumeVerification(workflowId: string, actor: string): FabricWorkflowDetail
}

export class AndroidCompanionTakeoverService {
  readonly #store: AndroidCompanionStore
  readonly #workflows: AndroidTakeoverWorkflowGateway
  readonly #now: () => Date

  constructor(input: {
    store: AndroidCompanionStore
    workflows?: AndroidTakeoverWorkflowGateway
    now?: () => Date
  }) {
    this.#store = input.store
    this.#workflows = input.workflows ?? defaultWorkflowGateway()
    this.#now = input.now ?? (() => new Date())
  }

  handleMessage(message: AndroidCompanionGatewayMessage): AndroidCompanionGatewayReply | undefined {
    if (message.messageType === 'takeover.requested') return this.request(message)
    if (message.messageType === 'takeover.claimed') return this.claim(message)
    if (message.messageType === 'takeover.completed') return this.complete(message)
    return undefined
  }

  private request(message: AndroidCompanionGatewayMessage): AndroidCompanionGatewayReply {
    const payload = requestPayload(message.payload, this.#now())
    if (message.bindingId !== payload.workflowId) throw invalid('Android takeover route binding is invalid')
    const workflow = requiredWorkflow(this.#workflows, payload.workflowId)
    const policy = policyBinding(workflow)
    const command = this.#store.getCommand(payload.commandId)
    const receipt = this.#store.getReceipt(payload.workflowId)
    if (!command || command.deviceId !== message.deviceId || command.workflowId !== payload.workflowId
      || command.capabilityId !== payload.capabilityId || !receipt || receipt.commandId !== command.id
      || receipt.deviceId !== message.deviceId || workflow.capabilityId !== payload.capabilityId
      || workflow.intentId !== receipt.intentId) throw invalid('Android takeover workflow binding is invalid')
    const identity = {
      workflowId: payload.workflowId,
      commandId: payload.commandId,
      deviceId: message.deviceId,
      capabilityId: payload.capabilityId,
      reasonCode: payload.reasonCode,
      generation: payload.generation,
      policyDecisionId: policy.policyDecisionId,
      policySnapshotDigest: policy.policySnapshotDigest,
    }
    const stored = this.#store.requestTakeover({
      id: `takeover-${hash(identity).slice(0, 48)}`,
      workflowId: payload.workflowId,
      commandId: payload.commandId,
      deviceId: message.deviceId,
      capabilityId: payload.capabilityId,
      reasonCode: payload.reasonCode,
      generation: payload.generation,
      requestedAt: payload.requestedAt,
      expiresAt: payload.expiresAt,
    })
    return acknowledgement(message, stored.takeover, stored.disposition, policy)
  }

  private claim(message: AndroidCompanionGatewayMessage): AndroidCompanionGatewayReply {
    const payload = claimPayload(message.payload, this.#now())
    if (message.bindingId !== payload.workflowId) throw invalid('Android takeover route binding is invalid')
    const takeover = requiredTakeover(this.#store, payload.takeoverId)
    const workflow = requiredWorkflow(this.#workflows, payload.workflowId)
    const policy = policyBinding(workflow)
    assertPolicyPayload(payload, policy)
    assertTakeoverMessageRoute(takeover, message.deviceId, payload)
    const claimDigest = hash({
      takeoverId: takeover.id,
      workflowId: takeover.workflowId,
      commandId: takeover.commandId,
      deviceId: takeover.deviceId,
      generation: takeover.generation,
      policyDecisionId: policy.policyDecisionId,
      policySnapshotDigest: policy.policySnapshotDigest,
      claimProof: payload.claimProof,
    })
    const stored = this.#store.claimTakeover({
      id: takeover.id,
      deviceId: message.deviceId,
      workflowId: payload.workflowId,
      generation: payload.generation,
      claimDigest,
      claimedAt: payload.claimedAt,
    })
    return acknowledgement(message, stored.takeover, stored.disposition, policy)
  }

  private complete(message: AndroidCompanionGatewayMessage): AndroidCompanionGatewayReply {
    const payload = completionPayload(message.payload, this.#now())
    if (message.bindingId !== payload.workflowId) throw invalid('Android takeover route binding is invalid')
    const takeover = requiredTakeover(this.#store, payload.takeoverId)
    let workflow = requiredWorkflow(this.#workflows, payload.workflowId)
    const policy = policyBinding(workflow)
    assertPolicyPayload(payload, policy)
    assertTakeoverMessageRoute(takeover, message.deviceId, payload)
    if (takeover.commandId !== payload.commandId || takeover.claimDigest !== payload.claimDigest) {
      throw invalid('Android takeover completion binding is invalid')
    }
    const command = this.#store.getCommand(payload.commandId)
    if (!command || command.deviceId !== message.deviceId || command.workflowId !== payload.workflowId
      || command.status !== 'succeeded' || command.response === null) {
      throw invalid('Android takeover command result is not ready for verification')
    }
    if (workflow.state !== 'waiting_user' && !(takeover.status === 'completed'
      && ['verifying', 'succeeded'].includes(workflow.state))) {
      throw invalid('Android takeover workflow is not ready to resume')
    }
    const stored = this.#store.completeTakeover({
      id: takeover.id,
      deviceId: message.deviceId,
      workflowId: payload.workflowId,
      commandId: payload.commandId,
      generation: payload.generation,
      claimDigest: payload.claimDigest,
      completedAt: payload.completedAt,
    })
    if (workflow.state === 'waiting_user') {
      workflow = this.#workflows.resumeVerification(workflow.id, `android-takeover:${message.deviceId}`)
    }
    if (!['verifying', 'succeeded'].includes(workflow.state)) {
      throw invalid('Android takeover did not resume verification')
    }
    return acknowledgement(message, stored.takeover, stored.disposition, policy, workflow.state)
  }
}

type PolicyBinding = { policyDecisionId: string; policySnapshotDigest: string }

function requestPayload(value: unknown, now: Date): {
  workflowId: string; commandId: string; capabilityId: string; reasonCode: string
  generation: number; requestedAt: string; expiresAt: string
} {
  if (!plainRecord(value) || !exactKeys(value, [
    'capabilityId', 'commandId', 'expiresAt', 'generation', 'reasonCode', 'requestedAt', 'workflowId',
  ])) throw invalid('Android takeover request envelope is invalid')
  const requestedAt = timestamp(data(value, 'requestedAt'), 'Android takeover request time')
  const expiresAt = timestamp(data(value, 'expiresAt'), 'Android takeover expiry')
  const requestTime = Date.parse(requestedAt)
  if (Math.abs(now.getTime() - requestTime) > REQUEST_FRESHNESS_MS
    || Date.parse(expiresAt) <= now.getTime()
    || Date.parse(expiresAt) - requestTime > MAX_TAKEOVER_LIFETIME_MS) {
    throw invalid('Android takeover request lifetime is invalid')
  }
  const reasonCode = string(data(value, 'reasonCode'), 'Android takeover reason')
  if (!TAKEOVER_REASONS.has(reasonCode)) throw invalid('Android takeover reason is not allowlisted')
  const capabilityId = string(data(value, 'capabilityId'), 'Android takeover capability id')
  if (!SEMANTIC_ID.test(capabilityId)) throw invalid('Android takeover capability id is invalid')
  return {
    workflowId: workflowId(data(value, 'workflowId')),
    commandId: identifier(data(value, 'commandId'), 'Android takeover command id'),
    capabilityId,
    reasonCode,
    generation: positiveInteger(data(value, 'generation'), 'Android takeover generation'),
    requestedAt,
    expiresAt,
  }
}

function claimPayload(value: unknown, now: Date): {
  takeoverId: string; workflowId: string; generation: number; claimProof: string; claimedAt: string
  policyDecisionId: string; policySnapshotDigest: string
} {
  if (!plainRecord(value) || !exactKeys(value, [
    'claimProof', 'claimedAt', 'generation', 'policyDecisionId', 'policySnapshotDigest', 'takeoverId', 'workflowId',
  ])) throw invalid('Android takeover claim envelope is invalid')
  const claimedAt = freshTimestamp(data(value, 'claimedAt'), 'Android takeover claim time', now)
  const claimProof = data(value, 'claimProof')
  if (typeof claimProof !== 'string' || !OPAQUE_PROOF.test(claimProof)) throw invalid('Android takeover claim proof is invalid')
  return {
    takeoverId: identifier(data(value, 'takeoverId'), 'Android takeover id'),
    workflowId: workflowId(data(value, 'workflowId')),
    generation: positiveInteger(data(value, 'generation'), 'Android takeover generation'),
    claimProof,
    claimedAt,
    policyDecisionId: identifier(data(value, 'policyDecisionId'), 'Android takeover policy decision id'),
    policySnapshotDigest: digest(data(value, 'policySnapshotDigest'), 'Android takeover policy snapshot digest'),
  }
}

function completionPayload(value: unknown, now: Date): {
  takeoverId: string; workflowId: string; commandId: string; generation: number; claimDigest: string
  completedAt: string; policyDecisionId: string; policySnapshotDigest: string
} {
  if (!plainRecord(value) || !exactKeys(value, [
    'claimDigest', 'commandId', 'completedAt', 'generation', 'policyDecisionId', 'policySnapshotDigest',
    'takeoverId', 'workflowId',
  ])) throw invalid('Android takeover completion envelope is invalid')
  return {
    takeoverId: identifier(data(value, 'takeoverId'), 'Android takeover id'),
    workflowId: workflowId(data(value, 'workflowId')),
    commandId: identifier(data(value, 'commandId'), 'Android takeover command id'),
    generation: positiveInteger(data(value, 'generation'), 'Android takeover generation'),
    claimDigest: digest(data(value, 'claimDigest'), 'Android takeover claim digest'),
    completedAt: freshTimestamp(data(value, 'completedAt'), 'Android takeover completion time', now),
    policyDecisionId: identifier(data(value, 'policyDecisionId'), 'Android takeover policy decision id'),
    policySnapshotDigest: digest(data(value, 'policySnapshotDigest'), 'Android takeover policy snapshot digest'),
  }
}

function requiredWorkflow(workflows: AndroidTakeoverWorkflowGateway, workflowId: string): FabricWorkflowDetail {
  const workflow = workflows.get(workflowId)
  if (!workflow) throw invalid('Android takeover workflow was not found')
  return workflow
}

function requiredTakeover(store: AndroidCompanionStore, id: string): AndroidTakeover {
  const takeover = store.getTakeover(id)
  if (!takeover) throw invalid('Android takeover was not found')
  return takeover
}

function policyBinding(workflow: FabricWorkflowDetail): PolicyBinding {
  if (!workflow.policyDecision || workflow.policyDecision.id !== workflow.policyDecisionId) {
    throw invalid('Android takeover workflow policy is unavailable')
  }
  return {
    policyDecisionId: workflow.policyDecision.id,
    policySnapshotDigest: hash(workflow.policyDecision.policySnapshot),
  }
}

function assertPolicyPayload(payload: PolicyBinding, policy: PolicyBinding): void {
  if (payload.policyDecisionId !== policy.policyDecisionId
    || payload.policySnapshotDigest !== policy.policySnapshotDigest) {
    throw invalid('Android takeover policy binding changed')
  }
}

function assertTakeoverMessageRoute(
  takeover: AndroidTakeover,
  deviceId: string,
  payload: { workflowId: string; generation: number },
): void {
  if (takeover.deviceId !== deviceId || takeover.workflowId !== payload.workflowId
    || takeover.generation !== payload.generation) throw invalid('Android takeover route binding is invalid')
}

function acknowledgement(
  message: AndroidCompanionGatewayMessage,
  takeover: AndroidTakeover,
  disposition: string,
  policy: PolicyBinding,
  workflowState?: string,
): AndroidCompanionGatewayReply {
  return {
    messageType: 'ack',
    bindingId: message.bindingId,
    payload: {
      acknowledgedSequence: message.sequence,
      takeoverId: takeover.id,
      generation: takeover.generation,
      status: takeover.status,
      disposition,
      policyDecisionId: policy.policyDecisionId,
      policySnapshotDigest: policy.policySnapshotDigest,
      ...(takeover.claimDigest ? { claimDigest: takeover.claimDigest } : {}),
      ...(workflowState ? { workflowState } : {}),
    },
  }
}

function defaultWorkflowGateway(): AndroidTakeoverWorkflowGateway {
  return {
    get: getFabricWorkflow,
    resumeVerification: retryFabricWorkflow,
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
  if (!descriptor || !('value' in descriptor)) throw invalid('Android takeover accessor is forbidden')
  return descriptor.value
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) throw invalid(`${label} is invalid`)
  return value
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw invalid(`${label} is invalid`)
  return value
}

function workflowId(value: unknown): string {
  const id = identifier(value, 'Android takeover workflow id')
  if (!id.startsWith('workflow-')) throw invalid('Android takeover workflow id is invalid')
  return id
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid(`${label} is invalid`)
  return Number(value)
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw invalid(`${label} is invalid`)
  return value
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw invalid(`${label} is invalid`)
  try {
    if (new Date(value).toISOString() !== value) throw new Error('noncanonical')
    return value
  } catch {
    throw invalid(`${label} is invalid`)
  }
}

function freshTimestamp(value: unknown, label: string, now: Date): string {
  const result = timestamp(value, label)
  if (Math.abs(now.getTime() - Date.parse(result)) > REQUEST_FRESHNESS_MS) throw invalid(`${label} is not fresh`)
  return result
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

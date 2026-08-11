import { createHash } from 'node:crypto'

export type TargetKind = 'local' | 'remote'

export type ChainStatus =
  | 'continuing'
  | 'cancel_pending'
  | 'completed'
  | 'cancelled'
  | 'failed_manual'

export type SourceAttemptStatus =
  | 'pending'
  | 'admitted'
  | 'claimed'
  | 'running'
  | 'cancel_pending'
  | 'completed'
  | 'cancelled'
  | 'failed_manual'
  | 'replaced'

export type OutboxStatus =
  | 'pending'
  | 'sent'
  | 'acknowledged'
  | 'cancel_pending'
  | 'completed'
  | 'cancelled'
  | 'failed_manual'

export type TargetInboxStatus =
  | 'admitted'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed_manual'

export type TransportOperation = 'admit' | 'getStatus' | 'cancel'
export type OperatorOperation = 'cancel' | 'replace'

export interface AuthBinding {
  kind: 'transport' | 'operator'
  operation: TransportOperation | OperatorOperation
  principal: string
  sourceInstanceId?: string
  targetId?: string
  authorizationId: string
  capabilityScope: string
  requestDigest: string
  signature: string
}

export interface AdmitRequest {
  chainId: string
  attemptId: string
  sourceInstanceId: string
  targetId: string
  snapshotDigest: string
  payloadDigest: string
  auth: AuthBinding
}

export interface CancelRequest extends AdmitRequest {
  reason: string
}

export interface TerminalMessageInput {
  id: string
  content: string
}

export interface DurableAgentMessage extends TerminalMessageInput {
  attemptId: string
  contentDigest: string
  committedAt: number
}

export interface TerminalPublicationEvidence {
  publicationId: string
  messageId: string
  messageDigest: string
  committedAt: number
  source: 'durable-agent-message'
}

export interface TargetTerminalPublication extends TerminalPublicationEvidence {
  attemptId: string
}

export interface TargetStatusProof {
  targetId: string
  inboxId: string
  version: number
  status: TargetInboxStatus
  responseDigest: string
  lastAuditEventId: string
  auditCount: number
  signature: string
}

export interface TargetStatusResponse {
  chainId: string
  attemptId: string
  sourceInstanceId: string
  targetId: string
  snapshotDigest: string
  payloadDigest: string
  inboxId: string
  status: TargetInboxStatus
  receipt: string
  version: number
  invocationStartedAt: number | null
  executionId: string | null
  terminalEvidence: TerminalPublicationEvidence | null
  failureReason: string | null
  auditEventIds: string[]
  proof: TargetStatusProof
}

export interface SourceAuditEvent {
  id: string
  action:
    | 'attempt_created'
    | 'admission_sent'
    | 'admission_received'
    | 'cancel_requested'
    | 'cancel_sent'
    | 'status_reconciled'
    | 'replacement_created'
  actor: string
  authorizationId: string | null
  attemptId: string
  reason: string | null
  at: number
}

export interface TargetAuditEvent {
  id: string
  action:
    | 'admitted'
    | 'admission_replayed'
    | 'claimed'
    | 'invocation_started'
    | 'terminal_published'
    | 'cancelled'
    | 'cancelled_after_invocation'
    | 'recovered_before_invocation'
    | 'recovered_after_invocation'
  actor: string
  authorizationId: string
  attemptId: string
  reason: string | null
  at: number
}

export interface SourceChain {
  id: string
  status: ChainStatus
  activeAttemptId: string
}

export interface SourceAttempt {
  id: string
  chainId: string
  sourceInstanceId: string
  targetId: string
  snapshotDigest: string
  payloadDigest: string
  status: SourceAttemptStatus
  targetReceipt: string | null
  cancelReason: string | null
  replacesAttemptId: string | null
  replacementAttemptId: string | null
  lastTargetVersion: number
}

export interface SourceOutbox {
  id: string
  attemptId: string
  operation: TransportOperation
  status: OutboxStatus
  requestId: string
}

export interface TargetInbox {
  id: string
  chainId: string
  attemptId: string
  sourceInstanceId: string
  targetId: string
  snapshotDigest: string
  payloadDigest: string
  status: TargetInboxStatus
  receipt: string
  version: number
  leaseId: string | null
  executionId: string | null
  invocationStartedAt: number | null
  invocationCount: number
  terminalEvidence: TerminalPublicationEvidence | null
  failureReason: string | null
  auditEventIds: string[]
}

interface SourcePersistedState {
  sourceInstanceId: string
  targetId: string
  nextSequence: number
  chains: Record<string, SourceChain>
  attempts: Record<string, SourceAttempt>
  outbox: Record<string, SourceOutbox>
  sourceAudit: SourceAuditEvent[]
}

interface TargetPersistedState {
  targetKind: TargetKind
  targetId: string
  nextSequence: number
  inboxes: Record<string, TargetInbox>
  targetAudit: TargetAuditEvent[]
  messages: Record<string, DurableAgentMessage>
  publications: Record<string, TargetTerminalPublication>
}

interface DurableStoreSnapshot<T> {
  loaded: T
  durable: T
}

export interface DurableHandoffState {
  targetKind: TargetKind
  sourceInstanceId: string
  targetId: string
  clock: number
  nextSequence: number
  chains: Record<string, SourceChain>
  attempts: Record<string, SourceAttempt>
  outbox: Record<string, SourceOutbox>
  sourceAudit: SourceAuditEvent[]
  inboxes: Record<string, TargetInbox>
  targetAudit: TargetAuditEvent[]
  messages: Record<string, DurableAgentMessage>
  publications: Record<string, TargetTerminalPublication>
  targetOnline: boolean
}

export type ModelEvent =
  | { type: 'createAttempt'; chainId?: string; attemptId?: string }
  | { type: 'sendAdmission'; attemptId: string }
  | { type: 'admit'; attemptId: string }
  | { type: 'receiveAdmission'; attemptId: string }
  | { type: 'claim'; attemptId: string }
  | { type: 'startInvocation'; attemptId: string; executionId?: string }
  | { type: 'publishTerminal'; attemptId: string; message?: TerminalMessageInput; evidence?: Partial<TerminalPublicationEvidence> }
  | { type: 'targetRestart'; attemptId: string }
  | { type: 'sourceRestart' }
  | { type: 'requestCancel'; attemptId: string; reason?: string; auth?: AuthBinding }
  | { type: 'sendCancel'; attemptId: string }
  | { type: 'reconcile'; attemptId: string }
  | { type: 'replace'; attemptId: string; auth?: AuthBinding }
  | { type: 'setTargetOnline'; online: boolean }

export class ModelViolation extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ModelViolation'
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function keyFor(sourceInstanceId: string, attemptId: string): string {
  return `${sourceInstanceId}:${attemptId}`
}

function isSourceTerminal(status: SourceAttemptStatus): boolean {
  return status === 'completed'
    || status === 'cancelled'
    || status === 'failed_manual'
    || status === 'replaced'
}

type RequestIdentity = Pick<AdmitRequest, 'chainId' | 'attemptId' | 'sourceInstanceId' | 'targetId' | 'snapshotDigest' | 'payloadDigest'>

function requestDigestFor(
  operation: TransportOperation | OperatorOperation,
  request: RequestIdentity,
  reason: string | null = null,
): string {
  return digest({
    operation,
    chainId: request.chainId,
    attemptId: request.attemptId,
    sourceInstanceId: request.sourceInstanceId,
    targetId: request.targetId,
    snapshotDigest: request.snapshotDigest,
    payloadDigest: request.payloadDigest,
    reason,
  })
}

function transportScope(request: RequestIdentity): string {
  return `handoff:${request.sourceInstanceId}:${request.targetId}:${request.chainId}:${request.attemptId}`
}

function operatorScope(operation: OperatorOperation, request: RequestIdentity): string {
  return `operator:${operation}:${request.sourceInstanceId}:${request.targetId}:${request.chainId}:${request.attemptId}`
}

function expectedTransportSignature(auth: AuthBinding): string {
  return digest({
    kind: 'transport',
    operation: auth.operation,
    principal: auth.principal,
    sourceInstanceId: auth.sourceInstanceId,
    targetId: auth.targetId,
    authorizationId: auth.authorizationId,
    capabilityScope: auth.capabilityScope,
    requestDigest: auth.requestDigest,
  })
}

function expectedOperatorSignature(auth: AuthBinding): string {
  return digest({
    kind: 'operator',
    operation: auth.operation,
    principal: auth.principal,
    authorizationId: auth.authorizationId,
    capabilityScope: auth.capabilityScope,
    requestDigest: auth.requestDigest,
  })
}

function statusCore(response: Omit<TargetStatusResponse, 'proof'>): Omit<TargetStatusResponse, 'proof'> {
  return {
    chainId: response.chainId,
    attemptId: response.attemptId,
    sourceInstanceId: response.sourceInstanceId,
    targetId: response.targetId,
    snapshotDigest: response.snapshotDigest,
    payloadDigest: response.payloadDigest,
    inboxId: response.inboxId,
    status: response.status,
    receipt: response.receipt,
    version: response.version,
    invocationStartedAt: response.invocationStartedAt,
    executionId: response.executionId,
    terminalEvidence: clone(response.terminalEvidence),
    failureReason: response.failureReason,
    auditEventIds: [...response.auditEventIds],
  }
}

function expectedStatusSignature(proof: Omit<TargetStatusProof, 'signature'>): string {
  return digest({
    kind: 'target-status',
    targetId: proof.targetId,
    inboxId: proof.inboxId,
    version: proof.version,
    status: proof.status,
    responseDigest: proof.responseDigest,
    lastAuditEventId: proof.lastAuditEventId,
    auditCount: proof.auditCount,
  })
}

export function transportAuth(
  operation: TransportOperation,
  sourceInstanceId = 'source-1',
  targetId = 'target-1',
): AuthBinding {
  const wildcard: RequestIdentity = {
    chainId: '*',
    attemptId: '*',
    sourceInstanceId,
    targetId,
    snapshotDigest: '*',
    payloadDigest: '*',
  }
  const auth: AuthBinding = {
    kind: 'transport',
    operation,
    principal: `source:${sourceInstanceId}`,
    sourceInstanceId,
    targetId,
    authorizationId: `transport-auth-${operation}`,
    capabilityScope: transportScope(wildcard),
    requestDigest: requestDigestFor(operation, wildcard, null),
    signature: '',
  }
  auth.signature = expectedTransportSignature(auth)
  return auth
}

export function transportAuthForRequest(
  operation: TransportOperation,
  request: RequestIdentity,
  reason: string | null = null,
): AuthBinding {
  const auth: AuthBinding = {
    kind: 'transport',
    operation,
    principal: `source:${request.sourceInstanceId}`,
    sourceInstanceId: request.sourceInstanceId,
    targetId: request.targetId,
    authorizationId: `transport-auth-${operation}`,
    capabilityScope: transportScope(request),
    requestDigest: requestDigestFor(operation, request, reason),
    signature: '',
  }
  auth.signature = expectedTransportSignature(auth)
  return auth
}

export function operatorAuth(
  operation: OperatorOperation,
  principal = 'operator-1',
): AuthBinding {
  const wildcard: RequestIdentity = {
    chainId: '*',
    attemptId: '*',
    sourceInstanceId: '*',
    targetId: '*',
    snapshotDigest: '*',
    payloadDigest: '*',
  }
  const auth: AuthBinding = {
    kind: 'operator',
    operation,
    principal,
    authorizationId: `operator-auth-${operation}-${principal}`,
    capabilityScope: operatorScope(operation, wildcard),
    requestDigest: requestDigestFor(operation, wildcard, null),
    signature: '',
  }
  auth.signature = expectedOperatorSignature(auth)
  return auth
}

export function operatorAuthForRequest(
  operation: OperatorOperation,
  request: RequestIdentity,
  reason: string | null = null,
  principal = 'operator-1',
): AuthBinding {
  const auth: AuthBinding = {
    kind: 'operator',
    operation,
    principal,
    authorizationId: `operator-auth-${operation}-${principal}`,
    capabilityScope: operatorScope(operation, request),
    requestDigest: requestDigestFor(operation, request, reason),
    signature: '',
  }
  auth.signature = expectedOperatorSignature(auth)
  return auth
}

class DurableStore<T> {
  private durableValue: T
  private loadedValue: T

  constructor(initial: T) {
    this.durableValue = clone(initial)
    this.loadedValue = clone(initial)
  }

  read(): T {
    return this.loadedValue
  }

  transaction<R>(mutate: (draft: T) => R): R {
    const draft = clone(this.loadedValue)
    const result = mutate(draft)
    this.durableValue = clone(draft)
    this.loadedValue = clone(draft)
    return result
  }

  restart(): void {
    this.loadedValue = clone(this.durableValue)
  }

  snapshots(): DurableStoreSnapshot<T> {
    return {
      loaded: clone(this.loadedValue),
      durable: clone(this.durableValue),
    }
  }
}

export class DurableHandoffModel {
  private readonly sourceStore: DurableStore<SourcePersistedState>
  private readonly targetStore: DurableStore<TargetPersistedState>
  private clock = 0
  private targetOnline = true

  constructor(targetKind: TargetKind) {
    this.sourceStore = new DurableStore({
      sourceInstanceId: 'source-1',
      targetId: 'target-1',
      nextSequence: 1,
      chains: {},
      attempts: {},
      outbox: {},
      sourceAudit: [],
    })
    this.targetStore = new DurableStore({
      targetKind,
      targetId: 'target-1',
      nextSequence: 1,
      inboxes: {},
      targetAudit: [],
      messages: {},
      publications: {},
    })
  }

  snapshot(): DurableHandoffState {
    const source = this.sourceStore.read()
    const target = this.targetStore.read()
    return {
      targetKind: target.targetKind,
      sourceInstanceId: source.sourceInstanceId,
      targetId: target.targetId,
      clock: this.clock,
      nextSequence: Math.max(source.nextSequence, target.nextSequence),
      chains: clone(source.chains),
      attempts: clone(source.attempts),
      outbox: clone(source.outbox),
      sourceAudit: clone(source.sourceAudit),
      inboxes: clone(target.inboxes),
      targetAudit: clone(target.targetAudit),
      messages: clone(target.messages),
      publications: clone(target.publications),
      targetOnline: this.targetOnline,
    }
  }

  durableStores(): {
    source: DurableStoreSnapshot<SourcePersistedState>
    target: DurableStoreSnapshot<TargetPersistedState>
  } {
    return {
      source: this.sourceStore.snapshots(),
      target: this.targetStore.snapshots(),
    }
  }

  apply(event: ModelEvent): unknown {
    switch (event.type) {
      case 'createAttempt':
        return this.createAttempt(event.chainId, event.attemptId)
      case 'sendAdmission':
        return this.sendAdmission(event.attemptId)
      case 'admit':
        return this.admit(event.attemptId)
      case 'receiveAdmission':
        return this.receiveAdmission(event.attemptId)
      case 'claim':
        return this.claim(event.attemptId)
      case 'startInvocation':
        return this.startInvocation(event.attemptId, event.executionId)
      case 'publishTerminal':
        return this.publishTerminal(event.attemptId, event.message, event.evidence)
      case 'targetRestart':
        return this.targetRestart(event.attemptId)
      case 'sourceRestart':
        return this.sourceRestart()
      case 'requestCancel':
        return this.requestCancel(event.attemptId, event.reason, event.auth)
      case 'sendCancel':
        return this.sendCancel(event.attemptId)
      case 'reconcile':
        return this.reconcile(event.attemptId)
      case 'replace':
        return this.replace(event.attemptId, event.auth)
      case 'setTargetOnline':
        return this.setTargetOnline(event.online)
    }
  }

  createAttempt(chainId = 'chain-1', attemptId = 'attempt-1'): SourceAttempt {
    const source = this.sourceStore.read()
    if (source.chains[chainId]) {
      throw new ModelViolation('CHAIN_EXISTS', `chain ${chainId} already exists`)
    }
    if (source.attempts[attemptId]) {
      throw new ModelViolation('ATTEMPT_EXISTS', `attempt ${attemptId} already exists`)
    }
    this.tick()
    const attempt: SourceAttempt = {
      id: attemptId,
      chainId,
      sourceInstanceId: source.sourceInstanceId,
      targetId: source.targetId,
      snapshotDigest: `snapshot-${attemptId}`,
      payloadDigest: `payload-${attemptId}`,
      status: 'pending',
      targetReceipt: null,
      cancelReason: null,
      replacesAttemptId: null,
      replacementAttemptId: null,
      lastTargetVersion: 0,
    }
    this.sourceStore.transaction(draft => {
      draft.chains[chainId] = {
        id: chainId,
        status: 'continuing',
        activeAttemptId: attemptId,
      }
      draft.attempts[attemptId] = attempt
      draft.outbox[attemptId] = {
        id: `outbox-${attemptId}`,
        attemptId,
        operation: 'admit',
        status: 'pending',
        requestId: `admit-request-${attemptId}`,
      }
      this.sourceAuditEvent(draft, 'attempt_created', attemptId, 'system', null, null)
    })
    this.checkInvariants()
    return clone(attempt)
  }

  sendAdmission(attemptId: string): AdmitRequest {
    const attempt = this.attempt(attemptId)
    const outbox = this.outbox(attemptId)
    if (outbox.operation !== 'admit') {
      throw new ModelViolation('OUTBOX_OPERATION', `attempt ${attemptId} is not admitting`)
    }
    if (isSourceTerminal(attempt.status)) {
      throw new ModelViolation('ATTEMPT_TERMINAL', `attempt ${attemptId} is terminal`)
    }
    if (outbox.status !== 'pending' && outbox.status !== 'sent') {
      throw new ModelViolation('ADMISSION_NOT_RETRYABLE', `outbox ${outbox.id} is ${outbox.status}`)
    }
    this.tick()
    this.sourceStore.transaction(draft => {
      draft.outbox[attemptId].status = 'sent'
      this.sourceAuditEvent(
        draft,
        'admission_sent',
        attemptId,
        'source-dispatcher',
        transportAuthForRequest('admit', attempt).authorizationId,
        null,
      )
    })
    this.checkInvariants()
    return this.buildTransportRequest(this.attempt(attemptId), 'admit')
  }

  admit(attemptId: string): TargetStatusResponse {
    const attempt = this.attempt(attemptId)
    return this.admitRequest(this.buildTransportRequest(attempt, 'admit'))
  }

  admitRequest(request: AdmitRequest): TargetStatusResponse {
    this.requireTargetOnline()
    this.verifyTransportAuth(request, 'admit')
    const key = keyFor(request.sourceInstanceId, request.attemptId)
    const existing = this.targetStore.read().inboxes[key]
    if (existing) {
      this.assertSameIdentity(existing, request)
      this.tick()
      this.targetStore.transaction(draft => {
        this.targetAuditEvent(draft, 'admission_replayed', draft.inboxes[key], request.auth, null)
      })
      this.checkInvariants()
      return this.statusResponse(this.requireInbox(attemptIdFromRequest(request)))
    }

    this.tick()
    this.targetStore.transaction(draft => {
      const inbox: TargetInbox = {
        id: `inbox-${request.sourceInstanceId}-${request.attemptId}`,
        chainId: request.chainId,
        attemptId: request.attemptId,
        sourceInstanceId: request.sourceInstanceId,
        targetId: request.targetId,
        snapshotDigest: request.snapshotDigest,
        payloadDigest: request.payloadDigest,
        status: 'admitted',
        receipt: `receipt-${draft.targetKind}-${request.attemptId}`,
        version: 1,
        leaseId: null,
        executionId: null,
        invocationStartedAt: null,
        invocationCount: 0,
        terminalEvidence: null,
        failureReason: null,
        auditEventIds: [],
      }
      draft.inboxes[key] = inbox
      this.targetAuditEvent(draft, 'admitted', inbox, request.auth, null)
    })
    this.checkInvariants()
    return this.statusResponse(this.requireInbox(attemptIdFromRequest(request)))
  }

  receiveAdmission(attemptId: string): void {
    const attempt = this.attempt(attemptId)
    const inbox = this.requireInbox(attemptId)
    const response = this.statusResponse(inbox)
    this.receiveAdmissionResponse(attemptId, response)
  }

  private receiveAdmissionResponse(attemptId: string, response: TargetStatusResponse): void {
    const attempt = this.attempt(attemptId)
    this.verifyStatusProof(response)
    this.assertSourceResponseIdentity(attempt, response)
    if (attempt.status === 'cancel_pending' && response.status === 'admitted') {
      throw new ModelViolation('STALE_ADMISSION', `admission callback cannot clear cancellation for ${attemptId}`)
    }
    if (response.status !== 'admitted') {
      throw new ModelViolation('ADMISSION_STATUS', `cannot receive ${response.status} as admission`)
    }
    if (attempt.status !== 'pending' && attempt.status !== 'admitted') {
      throw new ModelViolation('ADMISSION_STATUS', `cannot receive admission while source is ${attempt.status}`)
    }
    this.sourceStore.transaction(draft => {
      const sourceAttempt = draft.attempts[attemptId]
      sourceAttempt.targetReceipt = response.receipt
      sourceAttempt.status = 'admitted'
      sourceAttempt.lastTargetVersion = response.version
      if (draft.outbox[attemptId].status === 'sent') draft.outbox[attemptId].status = 'acknowledged'
      this.sourceAuditEvent(
        draft,
        'admission_received',
        attemptId,
        'source-reconciler',
        transportAuthForRequest('admit', sourceAttempt).authorizationId,
        null,
      )
    })
    this.checkInvariants()
  }

  claim(attemptId: string): TargetStatusResponse {
    this.requireTargetOnline()
    const key = keyFor(this.sourceInstanceId(), attemptId)
    const inbox = this.requireInbox(attemptId)
    const auth = transportAuthForRequest('getStatus', this.requestIdentityForInbox(inbox))
    if (inbox.status !== 'admitted') {
      throw new ModelViolation('CLAIM_STATUS', `cannot claim target inbox in ${inbox.status}`)
    }
    this.tick()
    this.targetStore.transaction(draft => {
      const targetInbox = draft.inboxes[key]
      targetInbox.status = 'claimed'
      targetInbox.version += 1
      targetInbox.leaseId = `lease-${attemptId}-${targetInbox.version}`
      this.targetAuditEvent(draft, 'claimed', targetInbox, auth, null)
    })
    this.checkInvariants()
    return this.statusResponse(this.requireInbox(attemptId))
  }

  startInvocation(attemptId: string, executionId = `execution-${attemptId}`): TargetStatusResponse {
    this.requireTargetOnline()
    const inbox = this.requireInbox(attemptId)
    const auth = transportAuthForRequest('getStatus', this.requestIdentityForInbox(inbox))
    if (inbox.status === 'running') {
      if (inbox.executionId !== executionId) {
        throw new ModelViolation('EXECUTION_CONFLICT', `attempt ${attemptId} already has execution ${inbox.executionId}`)
      }
      return this.statusResponse(inbox)
    }
    if (inbox.status !== 'claimed') {
      throw new ModelViolation('INVOCATION_STATUS', `cannot invoke target inbox in ${inbox.status}`)
    }
    this.tick()
    this.targetStore.transaction(draft => {
      const targetInbox = draft.inboxes[keyFor(this.sourceInstanceId(), attemptId)]
      targetInbox.status = 'running'
      targetInbox.version += 1
      targetInbox.executionId = executionId
      targetInbox.invocationStartedAt = this.clock
      targetInbox.invocationCount += 1
      this.targetAuditEvent(draft, 'invocation_started', targetInbox, auth, null)
    })
    this.checkInvariants()
    return this.statusResponse(this.requireInbox(attemptId))
  }

  publishTerminal(
    attemptId: string,
    message?: TerminalMessageInput,
    externalEvidence?: Partial<TerminalPublicationEvidence>,
  ): TargetStatusResponse {
    this.requireTargetOnline()
    const inbox = this.requireInbox(attemptId)
    if (inbox.status === 'completed') return this.statusResponse(inbox)
    if (inbox.status !== 'running') {
      throw new ModelViolation('PUBLICATION_STATUS', `cannot publish from target inbox ${attemptId} in ${inbox.status}`)
    }
    if (!message
      || !message.id
      || !message.content
      || message.id.startsWith('synthetic:')
      || externalEvidence) {
      throw new ModelViolation('TERMINAL_EVIDENCE_INVALID', `attempt ${attemptId} lacks a real Target message row`)
    }
    const committedAt = this.clock + 1
    const messageDigest = digest(message.content)
    const key = keyFor(this.sourceInstanceId(), attemptId)
    const auth = transportAuthForRequest('getStatus', this.requestIdentityForInbox(inbox))
    this.tick()
    this.targetStore.transaction(draft => {
      const targetInbox = draft.inboxes[key]
      if (draft.messages[message.id]) {
        throw new ModelViolation('MESSAGE_ID_CONFLICT', `message ${message.id} already exists`)
      }
      const messageRow: DurableAgentMessage = {
        id: message.id,
        attemptId,
        content: message.content,
        contentDigest: messageDigest,
        committedAt,
      }
      const publicationId = `publication-${attemptId}-${draft.nextSequence}`
      const publication: TargetTerminalPublication = {
        publicationId,
        attemptId,
        messageId: message.id,
        messageDigest,
        committedAt,
        source: 'durable-agent-message',
      }
      draft.messages[message.id] = messageRow
      draft.publications[publicationId] = publication
      targetInbox.status = 'completed'
      targetInbox.version += 1
      targetInbox.leaseId = null
      targetInbox.terminalEvidence = {
        publicationId,
        messageId: message.id,
        messageDigest,
        committedAt,
        source: 'durable-agent-message',
      }
      this.targetAuditEvent(draft, 'terminal_published', targetInbox, auth, null)
    })
    this.checkInvariants()
    return this.statusResponse(this.requireInbox(attemptId))
  }

  targetRestart(attemptId: string): TargetStatusResponse {
    this.targetStore.restart()
    const inbox = this.requireInbox(attemptId)
    if (inbox.status === 'claimed') {
      const auth = transportAuthForRequest('getStatus', this.requestIdentityForInbox(inbox))
      this.tick()
      this.targetStore.transaction(draft => {
        const targetInbox = draft.inboxes[keyFor(this.sourceInstanceId(), attemptId)]
        targetInbox.status = 'admitted'
        targetInbox.version += 1
        targetInbox.leaseId = null
        this.targetAuditEvent(draft, 'recovered_before_invocation', targetInbox, auth, 'claim_without_invocation_marker')
      })
    } else if (inbox.status === 'running') {
      const auth = transportAuthForRequest('getStatus', this.requestIdentityForInbox(inbox))
      this.tick()
      this.targetStore.transaction(draft => {
        const targetInbox = draft.inboxes[keyFor(this.sourceInstanceId(), attemptId)]
        targetInbox.status = 'failed_manual'
        targetInbox.version += 1
        targetInbox.leaseId = null
        targetInbox.failureReason = 'target_restart_after_invocation'
        this.targetAuditEvent(draft, 'recovered_after_invocation', targetInbox, auth, targetInbox.failureReason)
      })
    }
    this.checkInvariants()
    return this.statusResponse(this.requireInbox(attemptId))
  }

  sourceRestart(): DurableHandoffState {
    this.sourceStore.restart()
    this.checkInvariants()
    return this.snapshot()
  }

  requestCancel(
    attemptId: string,
    reason = 'operator_requested',
    auth?: AuthBinding,
  ): CancelRequest {
    const attempt = this.attempt(attemptId)
    const effectiveAuth = auth ?? operatorAuthForRequest('cancel', attempt, reason)
    this.verifyOperatorAuth(effectiveAuth, 'cancel', attempt, reason)
    if (attempt.status === 'cancel_pending') return this.cancelRequest(attempt, attempt.cancelReason ?? reason)
    if (isSourceTerminal(attempt.status)) {
      throw new ModelViolation('CANCEL_TERMINAL', `cannot cancel attempt ${attemptId} in ${attempt.status}`)
    }
    this.tick()
    this.sourceStore.transaction(draft => {
      const sourceAttempt = draft.attempts[attemptId]
      sourceAttempt.status = 'cancel_pending'
      sourceAttempt.cancelReason = reason
      draft.chains[sourceAttempt.chainId].status = 'cancel_pending'
      const outbox = draft.outbox[attemptId]
      outbox.operation = 'cancel'
      outbox.status = 'cancel_pending'
      outbox.requestId = `cancel-request-${attemptId}`
      this.sourceAuditEvent(draft, 'cancel_requested', attemptId, effectiveAuth.principal, effectiveAuth.authorizationId, reason)
    })
    this.checkInvariants()
    return this.cancelRequest(this.attempt(attemptId), reason)
  }

  sendCancel(attemptId: string): TargetStatusResponse {
    this.requireTargetOnline()
    const attempt = this.attempt(attemptId)
    const outbox = this.outbox(attemptId)
    if (attempt.status !== 'cancel_pending' || outbox.status !== 'cancel_pending') {
      throw new ModelViolation('CANCEL_NOT_PENDING', `attempt ${attemptId} is not awaiting cancellation`)
    }
    const request = this.cancelRequest(attempt, attempt.cancelReason ?? 'operator_requested')
    const response = this.cancel(request)
    this.tick()
    this.sourceStore.transaction(draft => {
      this.sourceAuditEvent(
        draft,
        'cancel_sent',
        attemptId,
        'source-dispatcher',
        request.auth.authorizationId,
        request.reason,
      )
    })
    this.checkInvariants()
    return response
  }

  cancel(request: CancelRequest): TargetStatusResponse {
    this.requireTargetOnline()
    this.verifyTransportAuth(request, 'cancel')
    return this.cancelTarget(request)
  }

  reconcile(attemptId: string): TargetStatusResponse {
    this.requireTargetOnline()
    const attempt = this.attempt(attemptId)
    const response = this.getStatus(attempt)
    return this.reconcileResponse(attemptId, response)
  }

  reconcileResponse(attemptId: string, response: TargetStatusResponse): TargetStatusResponse {
    const attempt = this.attempt(attemptId)
    this.verifyStatusProof(response)
    this.assertSourceResponseIdentity(attempt, response)
    if (response.version < attempt.lastTargetVersion) {
      throw new ModelViolation('STATUS_STALE', `target status ${response.version} is older than source ${attempt.lastTargetVersion}`)
    }
    if (response.version === attempt.lastTargetVersion && isSourceTerminal(attempt.status)) {
      return response
    }
    if (response.status === 'completed') {
      this.assertResponseTerminalEvidence(response)
    }
    if (attempt.status === 'failed_manual' && response.status !== 'failed_manual') {
      throw new ModelViolation('STATUS_REGRESSION', `failed_manual attempt ${attemptId} cannot regress to ${response.status}`)
    }
    if (attempt.status === 'cancelled' && response.status !== 'cancelled') {
      throw new ModelViolation('STATUS_REGRESSION', `cancelled attempt ${attemptId} cannot regress to ${response.status}`)
    }

    this.tick()
    this.sourceStore.transaction(draft => {
      const sourceAttempt = draft.attempts[attemptId]
      const chain = draft.chains[sourceAttempt.chainId]
      const outbox = draft.outbox[attemptId]
      sourceAttempt.lastTargetVersion = response.version
      if (sourceAttempt.targetReceipt === null) sourceAttempt.targetReceipt = response.receipt
      if (response.status === 'completed') {
        sourceAttempt.status = 'completed'
        outbox.status = 'completed'
        chain.status = 'completed'
      } else if (response.status === 'cancelled') {
        sourceAttempt.status = 'cancelled'
        outbox.status = 'cancelled'
        chain.status = 'cancelled'
      } else if (response.status === 'failed_manual') {
        sourceAttempt.status = 'failed_manual'
        outbox.status = 'failed_manual'
        chain.status = 'failed_manual'
      } else if (sourceAttempt.status !== 'cancel_pending') {
        sourceAttempt.status = response.status === 'running' ? 'running' : response.status
        outbox.status = 'acknowledged'
      }
      this.sourceAuditEvent(
        draft,
        'status_reconciled',
        attemptId,
        'source-reconciler',
        transportAuthForRequest('getStatus', sourceAttempt).authorizationId,
        response.status,
      )
    })
    this.checkInvariants()
    return response
  }

  replace(attemptId: string, auth?: AuthBinding): SourceAttempt {
    const oldAttempt = this.attempt(attemptId)
    const chain = this.chain(oldAttempt.chainId)
    const effectiveAuth = auth ?? operatorAuthForRequest('replace', oldAttempt)
    this.verifyOperatorAuth(effectiveAuth, 'replace', oldAttempt)
    if (oldAttempt.status !== 'failed_manual' || chain.status !== 'failed_manual') {
      throw new ModelViolation('REPLACEMENT_NOT_AUTHORIZED', `attempt ${attemptId} is not failed_manual`)
    }
    const replacementId = `${attemptId}-replacement`
    if (this.sourceStore.read().attempts[replacementId]) {
      return clone(this.sourceStore.read().attempts[replacementId])
    }
    this.tick()
    this.sourceStore.transaction(draft => {
      const sourceOldAttempt = draft.attempts[attemptId]
      sourceOldAttempt.status = 'replaced'
      sourceOldAttempt.replacementAttemptId = replacementId
      const replacement: SourceAttempt = {
        id: replacementId,
        chainId: sourceOldAttempt.chainId,
        sourceInstanceId: sourceOldAttempt.sourceInstanceId,
        targetId: sourceOldAttempt.targetId,
        snapshotDigest: `${sourceOldAttempt.snapshotDigest}:replacement`,
        payloadDigest: `${sourceOldAttempt.payloadDigest}:replacement`,
        status: 'pending',
        targetReceipt: null,
        cancelReason: null,
        replacesAttemptId: sourceOldAttempt.id,
        replacementAttemptId: null,
        lastTargetVersion: 0,
      }
      draft.attempts[replacementId] = replacement
      draft.outbox[replacementId] = {
        id: `outbox-${replacementId}`,
        attemptId: replacementId,
        operation: 'admit',
        status: 'pending',
        requestId: `admit-request-${replacementId}`,
      }
      draft.chains[sourceOldAttempt.chainId].status = 'continuing'
      draft.chains[sourceOldAttempt.chainId].activeAttemptId = replacementId
      this.sourceAuditEvent(
        draft,
        'replacement_created',
        replacementId,
        effectiveAuth.principal,
        effectiveAuth.authorizationId,
        sourceOldAttempt.id,
      )
    })
    this.checkInvariants()
    return clone(this.sourceStore.read().attempts[replacementId])
  }

  setTargetOnline(online: boolean): void {
    this.targetOnline = online
  }

  getStatusRequest(request: AdmitRequest): TargetStatusResponse {
    this.requireTargetOnline()
    this.verifyTransportAuth(request, 'getStatus')
    const inbox = this.targetStore.read().inboxes[keyFor(request.sourceInstanceId, request.attemptId)]
    if (!inbox) throw new ModelViolation('INBOX_NOT_FOUND', `unknown target inbox for ${request.attemptId}`)
    this.assertSameIdentity(inbox, request)
    return this.statusResponse(inbox)
  }

  private cancelTarget(request: CancelRequest): TargetStatusResponse {
    const key = keyFor(request.sourceInstanceId, request.attemptId)
    const existing = this.targetStore.read().inboxes[key]
    if (existing) this.assertSameIdentity(existing, request)
    this.tick()
    this.targetStore.transaction(draft => {
      const targetInbox = draft.inboxes[key]
      if (!targetInbox) {
        const tombstone: TargetInbox = {
          id: `inbox-${request.sourceInstanceId}-${request.attemptId}`,
          chainId: request.chainId,
          attemptId: request.attemptId,
          sourceInstanceId: request.sourceInstanceId,
          targetId: request.targetId,
          snapshotDigest: request.snapshotDigest,
          payloadDigest: request.payloadDigest,
          status: 'cancelled',
          receipt: `receipt-${draft.targetKind}-${request.attemptId}`,
          version: 1,
          leaseId: null,
          executionId: null,
          invocationStartedAt: null,
          invocationCount: 0,
          terminalEvidence: null,
          failureReason: request.reason,
          auditEventIds: [],
        }
        draft.inboxes[key] = tombstone
        this.targetAuditEvent(draft, 'cancelled', tombstone, request.auth, request.reason)
        return
      }
      if (targetInbox.status === 'admitted' || targetInbox.status === 'claimed') {
        targetInbox.status = 'cancelled'
        targetInbox.version += 1
        targetInbox.leaseId = null
        targetInbox.failureReason = request.reason
        this.targetAuditEvent(draft, 'cancelled', targetInbox, request.auth, request.reason)
      } else if (targetInbox.status === 'running') {
        targetInbox.status = 'failed_manual'
        targetInbox.version += 1
        targetInbox.leaseId = null
        targetInbox.failureReason = 'cancel_after_invocation'
        this.targetAuditEvent(draft, 'cancelled_after_invocation', targetInbox, request.auth, targetInbox.failureReason)
      }
    })
    this.checkInvariants()
    return this.statusResponse(this.requireInbox(attemptIdFromRequest(request)))
  }

  private getStatus(attempt: SourceAttempt): TargetStatusResponse {
    return this.getStatusRequest(this.buildTransportRequest(attempt, 'getStatus'))
  }

  private buildTransportRequest(
    attempt: SourceAttempt,
    operation: TransportOperation,
    reason: string | null = null,
  ): AdmitRequest {
    const request: RequestIdentity = {
      chainId: attempt.chainId,
      attemptId: attempt.id,
      sourceInstanceId: attempt.sourceInstanceId,
      targetId: attempt.targetId,
      snapshotDigest: attempt.snapshotDigest,
      payloadDigest: attempt.payloadDigest,
    }
    return {
      ...request,
      auth: transportAuthForRequest(operation, request, reason),
    }
  }

  private cancelRequest(attempt: SourceAttempt, reason: string): CancelRequest {
    const request = this.buildTransportRequest(attempt, 'cancel', reason)
    return { ...request, reason }
  }

  private verifyTransportAuth(
    request: AdmitRequest,
    operation: TransportOperation,
  ): void {
    const auth = request.auth
    const reason = 'reason' in request ? request.reason : null
    if (auth.kind !== 'transport'
      || auth.operation !== operation
      || auth.sourceInstanceId !== request.sourceInstanceId
      || auth.targetId !== request.targetId
      || auth.principal !== `source:${request.sourceInstanceId}`
      || auth.capabilityScope !== transportScope(request)
      || auth.requestDigest !== requestDigestFor(operation, request, reason)
      || auth.signature !== expectedTransportSignature(auth)) {
      throw new ModelViolation('AUTH_REJECTED', `invalid ${operation} transport authorization`)
    }
  }

  private verifyOperatorAuth(
    auth: AuthBinding,
    operation: OperatorOperation,
    request: SourceAttempt,
    reason: string | null = null,
  ): void {
    if (auth.kind !== 'operator'
      || auth.operation !== operation
      || !auth.principal
      || auth.capabilityScope !== operatorScope(operation, request)
      || auth.requestDigest !== requestDigestFor(operation, request, reason)
      || auth.signature !== expectedOperatorSignature(auth)) {
      throw new ModelViolation('AUTH_REJECTED', `invalid ${operation} operator authorization`)
    }
  }

  private assertSameIdentity(inbox: TargetInbox, request: RequestIdentity): void {
    if (inbox.chainId !== request.chainId
      || inbox.attemptId !== request.attemptId
      || inbox.sourceInstanceId !== request.sourceInstanceId
      || inbox.targetId !== request.targetId
      || inbox.snapshotDigest !== request.snapshotDigest
      || inbox.payloadDigest !== request.payloadDigest) {
      throw new ModelViolation('IDENTITY_CONFLICT', `attempt ${request.attemptId} does not match target identity`)
    }
  }

  private assertSourceResponseIdentity(attempt: SourceAttempt, response: TargetStatusResponse): void {
    if (attempt.chainId !== response.chainId
      || attempt.id !== response.attemptId
      || attempt.sourceInstanceId !== response.sourceInstanceId
      || attempt.targetId !== response.targetId
      || attempt.snapshotDigest !== response.snapshotDigest
      || attempt.payloadDigest !== response.payloadDigest) {
      throw new ModelViolation('IDENTITY_CONFLICT', `status response does not match source attempt ${attempt.id}`)
    }
  }

  private assertResponseTerminalEvidence(response: TargetStatusResponse): void {
    const evidence = response.terminalEvidence
    if (!evidence
      || evidence.source !== 'durable-agent-message'
      || evidence.messageId.startsWith('synthetic:')
      || evidence.publicationId.startsWith('synthetic:')) {
      throw new ModelViolation('TERMINAL_EVIDENCE_INVALID', `completed status for ${response.attemptId} lacks valid evidence`)
    }
    const target = this.targetStore.read()
    const publication = target.publications[evidence.publicationId]
    const message = target.messages[evidence.messageId]
    if (!publication
      || !message
      || publication.attemptId !== response.attemptId
      || publication.messageId !== evidence.messageId
      || publication.messageDigest !== evidence.messageDigest
      || message.attemptId !== response.attemptId
      || message.contentDigest !== evidence.messageDigest
      || message.id !== publication.messageId
      || message.committedAt !== evidence.committedAt
      || publication.committedAt !== evidence.committedAt) {
      throw new ModelViolation('TERMINAL_EVIDENCE_INVALID', `completed status for ${response.attemptId} is not backed by Target rows`)
    }
  }

  private assertSourceTargetIdentity(attempt: SourceAttempt, inbox: TargetInbox): void {
    this.assertSameIdentity(inbox, this.buildTransportRequest(attempt, 'admit'))
  }

  private statusResponse(inbox: TargetInbox): TargetStatusResponse {
    const lastAuditEventId = inbox.auditEventIds.at(-1)
    if (!lastAuditEventId) {
      throw new ModelViolation('AUDIT_EVIDENCE_MISSING', `target ${inbox.attemptId} has no audit event`)
    }
    const core: Omit<TargetStatusResponse, 'proof'> = {
      chainId: inbox.chainId,
      attemptId: inbox.attemptId,
      sourceInstanceId: inbox.sourceInstanceId,
      targetId: inbox.targetId,
      snapshotDigest: inbox.snapshotDigest,
      payloadDigest: inbox.payloadDigest,
      inboxId: inbox.id,
      status: inbox.status,
      receipt: inbox.receipt,
      version: inbox.version,
      invocationStartedAt: inbox.invocationStartedAt,
      executionId: inbox.executionId,
      terminalEvidence: clone(inbox.terminalEvidence),
      failureReason: inbox.failureReason,
      auditEventIds: [...inbox.auditEventIds],
    }
    const responseDigest = digest(statusCore(core))
    const proofWithoutSignature = {
      targetId: inbox.targetId,
      inboxId: inbox.id,
      version: inbox.version,
      status: inbox.status,
      responseDigest,
      lastAuditEventId,
      auditCount: inbox.auditEventIds.length,
    }
    return {
      ...core,
      proof: {
        ...proofWithoutSignature,
        signature: expectedStatusSignature(proofWithoutSignature),
      },
    }
  }

  private verifyStatusProof(response: TargetStatusResponse): void {
    const lastAuditEventId = response.auditEventIds.at(-1)
    const { signature, ...proofWithoutSignature } = response.proof
    const expectedResponseDigest = digest(statusCore(response))
    const target = this.targetStore.read()
    const inbox = target.inboxes[keyFor(response.sourceInstanceId, response.attemptId)]
    const currentAuditIds = inbox?.auditEventIds ?? []
    const hasAuditPrefix = response.auditEventIds.every((eventId, index) => currentAuditIds[index] === eventId)
    const auditEvents = response.auditEventIds.map(eventId => target.targetAudit.find(event => event.id === eventId))
    if (!inbox
      || response.version > inbox.version
      || !hasAuditPrefix
      || auditEvents.some(event => !event || event.attemptId !== response.attemptId)
      || response.proof.targetId !== response.targetId
      || response.inboxId !== response.proof.inboxId
      || response.version !== response.proof.version
      || response.status !== response.proof.status
      || response.proof.responseDigest !== expectedResponseDigest
      || response.proof.auditCount !== response.auditEventIds.length
      || response.proof.lastAuditEventId !== lastAuditEventId
      || signature !== expectedStatusSignature(proofWithoutSignature)) {
      throw new ModelViolation('STATUS_PROOF_INVALID', `target status proof for ${response.attemptId} is invalid`)
    }
    if (response.status === 'completed') this.assertResponseTerminalEvidence(response)
  }

  private attempt(attemptId: string): SourceAttempt {
    const attempt = this.sourceStore.read().attempts[attemptId]
    if (!attempt) throw new ModelViolation('ATTEMPT_NOT_FOUND', `unknown attempt ${attemptId}`)
    return attempt
  }

  private chain(chainId: string): SourceChain {
    const chain = this.sourceStore.read().chains[chainId]
    if (!chain) throw new ModelViolation('CHAIN_NOT_FOUND', `unknown chain ${chainId}`)
    return chain
  }

  private outbox(attemptId: string): SourceOutbox {
    const outbox = this.sourceStore.read().outbox[attemptId]
    if (!outbox) throw new ModelViolation('OUTBOX_NOT_FOUND', `unknown outbox for ${attemptId}`)
    return outbox
  }

  private inbox(attemptId: string): TargetInbox | null {
    return this.targetStore.read().inboxes[keyFor(this.sourceInstanceId(), attemptId)] ?? null
  }

  private requireInbox(attemptId: string): TargetInbox {
    const inbox = this.inbox(attemptId)
    if (!inbox) throw new ModelViolation('INBOX_NOT_FOUND', `unknown target inbox for ${attemptId}`)
    return inbox
  }

  private requireTargetOnline(): void {
    if (!this.targetOnline) {
      throw new ModelViolation('TARGET_OFFLINE', 'target transport is offline')
    }
  }

  private sourceInstanceId(): string {
    return this.sourceStore.read().sourceInstanceId
  }

  private requestIdentityForInbox(inbox: TargetInbox): RequestIdentity {
    return {
      chainId: inbox.chainId,
      attemptId: inbox.attemptId,
      sourceInstanceId: inbox.sourceInstanceId,
      targetId: inbox.targetId,
      snapshotDigest: inbox.snapshotDigest,
      payloadDigest: inbox.payloadDigest,
    }
  }

  private tick(): void {
    this.clock += 1
  }

  private sourceAuditEvent(
    draft: SourcePersistedState,
    action: SourceAuditEvent['action'],
    attemptId: string,
    actor: string,
    authorizationId: string | null,
    reason: string | null,
  ): void {
    draft.sourceAudit.push({
      id: `source-audit-${draft.nextSequence++}`,
      action,
      actor,
      authorizationId,
      attemptId,
      reason,
      at: this.clock,
    })
  }

  private targetAuditEvent(
    draft: TargetPersistedState,
    action: TargetAuditEvent['action'],
    inbox: TargetInbox,
    auth: AuthBinding,
    reason: string | null,
  ): void {
    const event: TargetAuditEvent = {
      id: `target-audit-${draft.nextSequence++}`,
      action,
      actor: auth.principal,
      authorizationId: auth.authorizationId,
      attemptId: inbox.attemptId,
      reason,
      at: this.clock,
    }
    draft.targetAudit.push(event)
    inbox.auditEventIds.push(event.id)
  }

  private checkInvariants(): void {
    const source = this.sourceStore.read()
    const target = this.targetStore.read()
    const seenTargetKeys = new Set<string>()
    for (const inbox of Object.values(target.inboxes)) {
      const key = keyFor(inbox.sourceInstanceId, inbox.attemptId)
      if (seenTargetKeys.has(key)) {
        throw new ModelViolation('DUPLICATE_INBOX', `duplicate target inbox ${key}`)
      }
      seenTargetKeys.add(key)
      if (inbox.status === 'running' || inbox.status === 'completed' || inbox.status === 'failed_manual') {
        if (inbox.invocationStartedAt === null) {
          throw new ModelViolation('INVOCATION_EVIDENCE_MISSING', `target ${inbox.attemptId} lacks invocation marker`)
        }
      }
      if (inbox.status === 'completed') {
        this.assertTargetRows(target, inbox)
        if (inbox.invocationStartedAt === null
          || !inbox.terminalEvidence
          || inbox.terminalEvidence.committedAt < inbox.invocationStartedAt) {
          throw new ModelViolation('TERMINAL_ORDER_INVALID', `target ${inbox.attemptId} published before invocation marker`)
        }
      }
      if (inbox.status === 'cancelled' && inbox.invocationStartedAt !== null) {
        throw new ModelViolation('CANCEL_AFTER_INVOCATION', `target ${inbox.attemptId} was cancelled after invocation`)
      }
      if (inbox.invocationCount > 1) {
        throw new ModelViolation('DUPLICATE_INVOCATION', `target ${inbox.attemptId} invoked more than once`)
      }
      if (inbox.invocationCount === 0 && inbox.invocationStartedAt !== null) {
        throw new ModelViolation('INVOCATION_COUNT_MISMATCH', `target ${inbox.attemptId} has a marker without an invocation count`)
      }
      if (inbox.terminalEvidence) {
        this.assertTargetRows(target, inbox)
      }
    }

    for (const attempt of Object.values(source.attempts)) {
      const chain = source.chains[attempt.chainId]
      const outbox = source.outbox[attempt.id]
      if (!chain || !outbox) throw new ModelViolation('SOURCE_RECORD_MISSING', `source records missing for ${attempt.id}`)
      if (attempt.targetReceipt !== null && !this.inbox(attempt.id)) {
        throw new ModelViolation('RECEIPT_WITHOUT_INBOX', `source ${attempt.id} stores receipt without target inbox`)
      }
      if (attempt.status === 'cancel_pending') {
        if (chain.status !== 'cancel_pending' || outbox.status !== 'cancel_pending') {
          throw new ModelViolation('CANCEL_PENDING_NOT_DURABLE', `source ${attempt.id} lost cancel_pending state`)
        }
      }
      if (attempt.status === 'completed') {
        const inbox = this.requireInbox(attempt.id)
        if (inbox.status !== 'completed' || !inbox.terminalEvidence) {
          throw new ModelViolation('SOURCE_COMPLETED_WITHOUT_TARGET', `source ${attempt.id} completed without target evidence`)
        }
      }
      if (attempt.status === 'cancelled') {
        const inbox = this.requireInbox(attempt.id)
        if (inbox.status !== 'cancelled') {
          throw new ModelViolation('SOURCE_CANCELLED_WITHOUT_TARGET', `source ${attempt.id} cancelled without target confirmation`)
        }
      }
      if (attempt.status === 'failed_manual') {
        const inbox = this.requireInbox(attempt.id)
        if (inbox.status !== 'failed_manual') {
          throw new ModelViolation('SOURCE_FAILED_WITHOUT_TARGET', `source ${attempt.id} failed without target confirmation`)
        }
      }
      if (attempt.status === 'replaced') {
        if (!attempt.replacementAttemptId) {
          throw new ModelViolation('REPLACEMENT_LINEAGE_MISSING', `source ${attempt.id} has no replacement lineage`)
        }
        const replacement = source.attempts[attempt.replacementAttemptId]
        if (!replacement || replacement.replacesAttemptId !== attempt.id) {
          throw new ModelViolation('REPLACEMENT_LINEAGE_BROKEN', `replacement for ${attempt.id} is not linked back`)
        }
      }
      if (outbox.attemptId !== attempt.id) {
        throw new ModelViolation('OUTBOX_ATTEMPT_MISMATCH', `outbox ${outbox.id} points at another attempt`)
      }
    }

    for (const chain of Object.values(source.chains)) {
      const active = source.attempts[chain.activeAttemptId]
      if (!active || active.chainId !== chain.id) {
        throw new ModelViolation('CHAIN_ACTIVE_ATTEMPT_MISMATCH', `chain ${chain.id} has foreign active attempt`)
      }
      if (chain.status === 'completed' && active.status !== 'completed') {
        throw new ModelViolation('CHAIN_COMPLETION_MISMATCH', `chain ${chain.id} is completed without active completion`)
      }
      if (chain.status === 'cancelled' && active.status !== 'cancelled') {
        throw new ModelViolation('CHAIN_CANCELLATION_MISMATCH', `chain ${chain.id} is cancelled without target cancellation`)
      }
      if (chain.status === 'failed_manual' && active.status !== 'failed_manual') {
        throw new ModelViolation('CHAIN_FAILURE_MISMATCH', `chain ${chain.id} is failed without active manual failure`)
      }
    }
  }

  private assertTargetRows(target: TargetPersistedState, inbox: TargetInbox): void {
    const evidence = inbox.terminalEvidence
    if (!evidence
      || evidence.source !== 'durable-agent-message'
      || evidence.messageId.startsWith('synthetic:')
      || evidence.publicationId.startsWith('synthetic:')) {
      throw new ModelViolation('TERMINAL_EVIDENCE_MISSING', `target ${inbox.attemptId} lacks durable publication evidence`)
    }
    const publication = target.publications[evidence.publicationId]
    const message = target.messages[evidence.messageId]
    if (!publication
      || !message
      || publication.attemptId !== inbox.attemptId
      || publication.messageId !== evidence.messageId
      || publication.messageDigest !== evidence.messageDigest
      || publication.committedAt !== evidence.committedAt
      || message.attemptId !== inbox.attemptId
      || message.id !== evidence.messageId
      || message.contentDigest !== evidence.messageDigest
      || message.committedAt !== evidence.committedAt) {
      throw new ModelViolation('TERMINAL_EVIDENCE_INVALID', `target ${inbox.attemptId} publication is not atomically backed by a message row`)
    }
  }
}

function attemptIdFromRequest(request: AdmitRequest): string {
  return request.attemptId
}

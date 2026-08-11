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

export interface TerminalPublicationEvidence {
  publicationId: string
  messageId: string
  messageDigest: string
  committedAt: number
  source: 'durable-agent-message'
}

export interface TargetStatusProof {
  targetId: string
  inboxId: string
  version: number
  status: TargetInboxStatus
  lastAuditEventId: string
  auditCount: number
  signature: string
}

export interface TargetStatusResponse {
  chainId: string
  attemptId: string
  sourceInstanceId: string
  targetId: string
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
  targetOnline: boolean
}

export type ModelEvent =
  | { type: 'createAttempt'; chainId?: string; attemptId?: string }
  | { type: 'sendAdmission'; attemptId: string }
  | { type: 'admit'; attemptId: string }
  | { type: 'receiveAdmission'; attemptId: string }
  | { type: 'claim'; attemptId: string }
  | { type: 'startInvocation'; attemptId: string; executionId?: string }
  | { type: 'publishTerminal'; attemptId: string; evidence?: Partial<TerminalPublicationEvidence> }
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

function keyFor(sourceInstanceId: string, attemptId: string): string {
  return `${sourceInstanceId}:${attemptId}`
}

function isSourceTerminal(status: SourceAttemptStatus): boolean {
  return status === 'completed'
    || status === 'cancelled'
    || status === 'failed_manual'
    || status === 'replaced'
}

function expectedTransportSignature(auth: AuthBinding): string {
  return [
    'transport',
    auth.operation,
    auth.principal,
    auth.sourceInstanceId,
    auth.targetId,
    auth.authorizationId,
  ].join('|')
}

function expectedOperatorSignature(auth: AuthBinding): string {
  return [
    'operator',
    auth.operation,
    auth.principal,
    auth.authorizationId,
  ].join('|')
}

function expectedStatusSignature(proof: Omit<TargetStatusProof, 'signature'>): string {
  return [
    'target-status',
    proof.targetId,
    proof.inboxId,
    proof.version,
    proof.status,
    proof.lastAuditEventId,
    proof.auditCount,
  ].join('|')
}

export function transportAuth(
  operation: TransportOperation,
  sourceInstanceId = 'source-1',
  targetId = 'target-1',
): AuthBinding {
  const auth: AuthBinding = {
    kind: 'transport',
    operation,
    principal: `source:${sourceInstanceId}`,
    sourceInstanceId,
    targetId,
    authorizationId: `transport-auth-${operation}`,
    signature: '',
  }
  auth.signature = expectedTransportSignature(auth)
  return auth
}

export function operatorAuth(
  operation: OperatorOperation,
  principal = 'operator-1',
): AuthBinding {
  const auth: AuthBinding = {
    kind: 'operator',
    operation,
    principal,
    authorizationId: `operator-auth-${operation}-${principal}`,
    signature: '',
  }
  auth.signature = expectedOperatorSignature(auth)
  return auth
}

export class DurableHandoffModel {
  private readonly stateValue: DurableHandoffState

  constructor(targetKind: TargetKind) {
    this.stateValue = {
      targetKind,
      sourceInstanceId: 'source-1',
      targetId: 'target-1',
      clock: 0,
      nextSequence: 1,
      chains: {},
      attempts: {},
      outbox: {},
      sourceAudit: [],
      inboxes: {},
      targetAudit: [],
      targetOnline: true,
    }
  }

  snapshot(): DurableHandoffState {
    return clone(this.stateValue)
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
        return this.publishTerminal(event.attemptId, event.evidence)
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
    if (this.stateValue.chains[chainId]) {
      throw new ModelViolation('CHAIN_EXISTS', `chain ${chainId} already exists`)
    }
    if (this.stateValue.attempts[attemptId]) {
      throw new ModelViolation('ATTEMPT_EXISTS', `attempt ${attemptId} already exists`)
    }
    this.tick()
    this.stateValue.chains[chainId] = {
      id: chainId,
      status: 'continuing',
      activeAttemptId: attemptId,
    }
    const attempt: SourceAttempt = {
      id: attemptId,
      chainId,
      sourceInstanceId: this.stateValue.sourceInstanceId,
      targetId: this.stateValue.targetId,
      snapshotDigest: `snapshot-${attemptId}`,
      payloadDigest: `payload-${attemptId}`,
      status: 'pending',
      targetReceipt: null,
      cancelReason: null,
      replacesAttemptId: null,
      replacementAttemptId: null,
      lastTargetVersion: 0,
    }
    this.stateValue.attempts[attemptId] = attempt
    this.stateValue.outbox[attemptId] = {
      id: `outbox-${attemptId}`,
      attemptId,
      operation: 'admit',
      status: 'pending',
      requestId: `admit-request-${attemptId}`,
    }
    this.sourceAuditEvent('attempt_created', attemptId, 'system', null, null)
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
    if (outbox.status === 'pending' || outbox.status === 'sent') {
      outbox.status = 'sent'
      this.tick()
      this.sourceAuditEvent(
        'admission_sent',
        attemptId,
        'source-dispatcher',
        transportAuth('admit', attempt.sourceInstanceId, attempt.targetId).authorizationId,
        null,
      )
      this.checkInvariants()
      return this.buildTransportRequest(attempt, 'admit')
    }
    throw new ModelViolation('ADMISSION_NOT_RETRYABLE', `outbox ${outbox.id} is ${outbox.status}`)
  }

  admit(attemptId: string): TargetStatusResponse {
    const attempt = this.attempt(attemptId)
    return this.admitRequest(this.buildTransportRequest(attempt, 'admit'))
  }

  admitRequest(request: AdmitRequest): TargetStatusResponse {
    this.requireTargetOnline()
    this.verifyTransportAuth(request, 'admit')
    const key = keyFor(request.sourceInstanceId, request.attemptId)
    const existing = this.stateValue.inboxes[key]
    if (existing) {
      this.assertSameIdentity(existing, request)
      this.tick()
      this.targetAuditEvent('admission_replayed', existing, request.auth, null)
      this.checkInvariants()
      return this.statusResponse(existing)
    }

    this.tick()
    const inbox: TargetInbox = {
      id: `inbox-${request.sourceInstanceId}-${request.attemptId}`,
      chainId: request.chainId,
      attemptId: request.attemptId,
      sourceInstanceId: request.sourceInstanceId,
      targetId: request.targetId,
      snapshotDigest: request.snapshotDigest,
      payloadDigest: request.payloadDigest,
      status: 'admitted',
      receipt: `receipt-${this.stateValue.targetKind}-${request.attemptId}`,
      version: 1,
      leaseId: null,
      executionId: null,
      invocationStartedAt: null,
      invocationCount: 0,
      terminalEvidence: null,
      failureReason: null,
      auditEventIds: [],
    }
    this.stateValue.inboxes[key] = inbox
    this.targetAuditEvent('admitted', inbox, request.auth, null)
    this.checkInvariants()
    return this.statusResponse(inbox)
  }

  receiveAdmission(attemptId: string): void {
    const attempt = this.attempt(attemptId)
    const outbox = this.outbox(attemptId)
    const inbox = this.inbox(attemptId)
    if (!inbox) throw new ModelViolation('ADMISSION_MISSING', `target has no inbox for ${attemptId}`)
    this.assertSourceTargetIdentity(attempt, inbox)
    this.verifyStatusProof(this.statusResponse(inbox))
    if (inbox.status !== 'admitted') {
      throw new ModelViolation('ADMISSION_STATUS', `cannot receive ${inbox.status} as admission`)
    }
    attempt.targetReceipt = inbox.receipt
    attempt.status = 'admitted'
    attempt.lastTargetVersion = inbox.version
    if (outbox.status === 'sent') outbox.status = 'acknowledged'
    this.tick()
    this.sourceAuditEvent(
      'admission_received',
      attemptId,
      'source-reconciler',
      transportAuth('admit', attempt.sourceInstanceId, attempt.targetId).authorizationId,
      null,
    )
    this.checkInvariants()
  }

  claim(attemptId: string): TargetStatusResponse {
    this.requireTargetOnline()
    const inbox = this.requireInbox(attemptId)
    const auth = transportAuth('getStatus', this.stateValue.sourceInstanceId, this.stateValue.targetId)
    if (inbox.status !== 'admitted') {
      throw new ModelViolation('CLAIM_STATUS', `cannot claim target inbox in ${inbox.status}`)
    }
    this.tick()
    inbox.status = 'claimed'
    inbox.version += 1
    inbox.leaseId = `lease-${attemptId}-${inbox.version}`
    this.targetAuditEvent('claimed', inbox, auth, null)
    this.checkInvariants()
    return this.statusResponse(inbox)
  }

  startInvocation(attemptId: string, executionId = `execution-${attemptId}`): TargetStatusResponse {
    this.requireTargetOnline()
    const inbox = this.requireInbox(attemptId)
    const auth = transportAuth('getStatus', this.stateValue.sourceInstanceId, this.stateValue.targetId)
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
    inbox.status = 'running'
    inbox.version += 1
    inbox.executionId = executionId
    inbox.invocationStartedAt = this.stateValue.clock
    inbox.invocationCount += 1
    this.targetAuditEvent('invocation_started', inbox, auth, null)
    this.checkInvariants()
    return this.statusResponse(inbox)
  }

  publishTerminal(
    attemptId: string,
    partialEvidence: Partial<TerminalPublicationEvidence> = {},
  ): TargetStatusResponse {
    this.requireTargetOnline()
    const inbox = this.requireInbox(attemptId)
    const auth = transportAuth('getStatus', this.stateValue.sourceInstanceId, this.stateValue.targetId)
    if (inbox.status === 'completed') return this.statusResponse(inbox)
    if (inbox.status !== 'running') {
      throw new ModelViolation('PUBLICATION_STATUS', `cannot publish from target inbox ${inbox.status}`)
    }
    const evidence: TerminalPublicationEvidence = {
      publicationId: partialEvidence.publicationId ?? `publication-${attemptId}`,
      messageId: partialEvidence.messageId ?? `message-${attemptId}`,
      messageDigest: partialEvidence.messageDigest ?? `digest-${attemptId}`,
      committedAt: partialEvidence.committedAt ?? this.stateValue.clock + 1,
      source: partialEvidence.source ?? 'durable-agent-message',
    }
    if (evidence.source !== 'durable-agent-message'
      || !evidence.publicationId
      || !evidence.messageId
      || !evidence.messageDigest
      || evidence.messageId.startsWith('synthetic:')
      || evidence.publicationId.startsWith('synthetic:')) {
      throw new ModelViolation('TERMINAL_EVIDENCE_INVALID', `attempt ${attemptId} lacks real publication evidence`)
    }
    this.tick()
    inbox.status = 'completed'
    inbox.version += 1
    inbox.leaseId = null
    inbox.terminalEvidence = evidence
    this.targetAuditEvent('terminal_published', inbox, auth, null)
    this.checkInvariants()
    return this.statusResponse(inbox)
  }

  targetRestart(attemptId: string): TargetStatusResponse {
    const inbox = this.requireInbox(attemptId)
    const auth = transportAuth('getStatus', this.stateValue.sourceInstanceId, this.stateValue.targetId)
    if (inbox.status === 'claimed') {
      this.tick()
      inbox.status = 'admitted'
      inbox.version += 1
      inbox.leaseId = null
      this.targetAuditEvent('recovered_before_invocation', inbox, auth, 'claim_without_invocation_marker')
    } else if (inbox.status === 'running') {
      this.tick()
      inbox.status = 'failed_manual'
      inbox.version += 1
      inbox.leaseId = null
      inbox.failureReason = 'target_restart_after_invocation'
      this.targetAuditEvent('recovered_after_invocation', inbox, auth, inbox.failureReason)
    }
    this.checkInvariants()
    return this.statusResponse(inbox)
  }

  sourceRestart(): DurableHandoffState {
    this.checkInvariants()
    return this.snapshot()
  }

  requestCancel(
    attemptId: string,
    reason = 'operator_requested',
    auth: AuthBinding = operatorAuth('cancel'),
  ): CancelRequest {
    const attempt = this.attempt(attemptId)
    const chain = this.chain(attempt.chainId)
    this.verifyOperatorAuth(auth, 'cancel')
    if (attempt.status === 'cancel_pending') return this.cancelRequest(attempt, reason)
    if (attempt.status === 'completed' || attempt.status === 'cancelled' || attempt.status === 'replaced') {
      throw new ModelViolation('CANCEL_TERMINAL', `cannot cancel attempt ${attemptId} in ${attempt.status}`)
    }
    attempt.status = 'cancel_pending'
    attempt.cancelReason = reason
    chain.status = 'cancel_pending'
    const outbox = this.outbox(attemptId)
    outbox.operation = 'cancel'
    outbox.status = 'cancel_pending'
    outbox.requestId = `cancel-request-${attemptId}`
    this.tick()
    this.sourceAuditEvent('cancel_requested', attemptId, auth.principal, auth.authorizationId, reason)
    this.checkInvariants()
    return this.cancelRequest(attempt, reason)
  }

  sendCancel(attemptId: string): TargetStatusResponse {
    this.requireTargetOnline()
    const attempt = this.attempt(attemptId)
    const outbox = this.outbox(attemptId)
    if (attempt.status !== 'cancel_pending' || outbox.status !== 'cancel_pending') {
      throw new ModelViolation('CANCEL_NOT_PENDING', `attempt ${attemptId} is not awaiting cancellation`)
    }
    const request = this.cancelRequest(attempt, attempt.cancelReason ?? 'operator_requested')
    this.verifyTransportAuth(request, 'cancel')
    const inbox = this.stateValue.inboxes[keyFor(request.sourceInstanceId, request.attemptId)]
    const response = this.cancel(request)
    if (!inbox) {
      attempt.targetReceipt = response.receipt
    }
    this.tick()
    this.sourceAuditEvent(
      'cancel_sent',
      attemptId,
      'source-dispatcher',
      request.auth.authorizationId,
      request.reason,
    )
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
    const inbox = this.requireInbox(attemptId)
    this.verifyStatusProof(response)
    attempt.lastTargetVersion = response.version
    if (attempt.targetReceipt === null) attempt.targetReceipt = response.receipt

    if (response.status === 'completed') {
      if (!response.terminalEvidence) {
        throw new ModelViolation('MISSING_TERMINAL_EVIDENCE', `completed target ${attemptId} has no evidence`)
      }
      attempt.status = 'completed'
      this.outbox(attemptId).status = 'completed'
      this.chain(attempt.chainId).status = 'completed'
    } else if (response.status === 'cancelled') {
      attempt.status = 'cancelled'
      this.outbox(attemptId).status = 'cancelled'
      this.chain(attempt.chainId).status = 'cancelled'
    } else if (response.status === 'failed_manual') {
      attempt.status = 'failed_manual'
      this.outbox(attemptId).status = 'failed_manual'
      this.chain(attempt.chainId).status = 'failed_manual'
    } else if (attempt.status !== 'cancel_pending') {
      attempt.status = response.status
      this.outbox(attemptId).status = 'acknowledged'
    }
    this.tick()
    this.sourceAuditEvent(
      'status_reconciled',
      attemptId,
      'source-reconciler',
      transportAuth('getStatus', attempt.sourceInstanceId, attempt.targetId).authorizationId,
      response.status,
    )
    this.assertSourceTargetIdentity(attempt, inbox)
    this.checkInvariants()
    return response
  }

  replace(attemptId: string, auth: AuthBinding = operatorAuth('replace')): SourceAttempt {
    const oldAttempt = this.attempt(attemptId)
    const chain = this.chain(oldAttempt.chainId)
    this.verifyOperatorAuth(auth, 'replace')
    if (oldAttempt.status !== 'failed_manual' || chain.status !== 'failed_manual') {
      throw new ModelViolation('REPLACEMENT_NOT_AUTHORIZED', `attempt ${attemptId} is not failed_manual`)
    }
    const replacementId = `${attemptId}-replacement`
    if (this.stateValue.attempts[replacementId]) {
      return clone(this.stateValue.attempts[replacementId])
    }
    oldAttempt.status = 'replaced'
    oldAttempt.replacementAttemptId = replacementId
    const replacement: SourceAttempt = {
      id: replacementId,
      chainId: oldAttempt.chainId,
      sourceInstanceId: oldAttempt.sourceInstanceId,
      targetId: oldAttempt.targetId,
      snapshotDigest: `${oldAttempt.snapshotDigest}:replacement`,
      payloadDigest: `${oldAttempt.payloadDigest}:replacement`,
      status: 'pending',
      targetReceipt: null,
      cancelReason: null,
      replacesAttemptId: oldAttempt.id,
      replacementAttemptId: null,
      lastTargetVersion: 0,
    }
    this.stateValue.attempts[replacementId] = replacement
    this.stateValue.outbox[replacementId] = {
      id: `outbox-${replacementId}`,
      attemptId: replacementId,
      operation: 'admit',
      status: 'pending',
      requestId: `admit-request-${replacementId}`,
    }
    chain.status = 'continuing'
    chain.activeAttemptId = replacementId
    this.tick()
    this.sourceAuditEvent(
      'replacement_created',
      replacementId,
      auth.principal,
      auth.authorizationId,
      oldAttempt.id,
    )
    this.checkInvariants()
    return clone(replacement)
  }

  setTargetOnline(online: boolean): void {
    this.stateValue.targetOnline = online
  }

  private cancelTarget(request: CancelRequest): TargetStatusResponse {
    this.verifyTransportAuth(request, 'cancel')
    const key = keyFor(request.sourceInstanceId, request.attemptId)
    const existing = this.stateValue.inboxes[key]
    if (existing) {
      this.assertSameIdentity(existing, request)
      if (existing.status === 'admitted' || existing.status === 'claimed') {
        this.tick()
        existing.status = 'cancelled'
        existing.version += 1
        existing.leaseId = null
        this.targetAuditEvent('cancelled', existing, request.auth, request.reason)
      } else if (existing.status === 'running') {
        this.tick()
        existing.status = 'failed_manual'
        existing.version += 1
        existing.leaseId = null
        existing.failureReason = 'cancel_after_invocation'
        this.targetAuditEvent('cancelled_after_invocation', existing, request.auth, existing.failureReason)
      }
      this.checkInvariants()
      return this.statusResponse(existing)
    }

    this.tick()
    const tombstone: TargetInbox = {
      id: `inbox-${request.sourceInstanceId}-${request.attemptId}`,
      chainId: request.chainId,
      attemptId: request.attemptId,
      sourceInstanceId: request.sourceInstanceId,
      targetId: request.targetId,
      snapshotDigest: request.snapshotDigest,
      payloadDigest: request.payloadDigest,
      status: 'cancelled',
      receipt: `receipt-${this.stateValue.targetKind}-${request.attemptId}`,
      version: 1,
      leaseId: null,
      executionId: null,
      invocationStartedAt: null,
      invocationCount: 0,
      terminalEvidence: null,
      failureReason: request.reason,
      auditEventIds: [],
    }
    this.stateValue.inboxes[key] = tombstone
    this.targetAuditEvent('cancelled', tombstone, request.auth, request.reason)
    this.checkInvariants()
    return this.statusResponse(tombstone)
  }

  private getStatus(attempt: SourceAttempt): TargetStatusResponse {
    return this.getStatusRequest(this.buildTransportRequest(attempt, 'getStatus'))
  }

  getStatusRequest(request: AdmitRequest): TargetStatusResponse {
    this.requireTargetOnline()
    this.verifyTransportAuth(request, 'getStatus')
    const inbox = this.stateValue.inboxes[keyFor(request.sourceInstanceId, request.attemptId)]
    if (!inbox) throw new ModelViolation('INBOX_NOT_FOUND', `unknown target inbox for ${request.attemptId}`)
    this.assertSameIdentity(inbox, request)
    return this.statusResponse(inbox)
  }

  private buildTransportRequest(
    attempt: SourceAttempt,
    operation: TransportOperation,
  ): AdmitRequest {
    return {
      chainId: attempt.chainId,
      attemptId: attempt.id,
      sourceInstanceId: attempt.sourceInstanceId,
      targetId: attempt.targetId,
      snapshotDigest: attempt.snapshotDigest,
      payloadDigest: attempt.payloadDigest,
      auth: transportAuth(operation, attempt.sourceInstanceId, attempt.targetId),
    }
  }

  private cancelRequest(attempt: SourceAttempt, reason: string): CancelRequest {
    const request = this.buildTransportRequest(attempt, 'cancel')
    return {
      ...request,
      auth: transportAuth('cancel', attempt.sourceInstanceId, attempt.targetId),
      reason,
    }
  }

  private verifyTransportAuth(
    request: AdmitRequest,
    operation: TransportOperation,
  ): void {
    const auth = request.auth
    if (auth.kind !== 'transport'
      || auth.operation !== operation
      || auth.sourceInstanceId !== request.sourceInstanceId
      || auth.targetId !== request.targetId
      || auth.signature !== expectedTransportSignature(auth)) {
      throw new ModelViolation('AUTH_REJECTED', `invalid ${operation} transport authorization`)
    }
  }

  private verifyOperatorAuth(
    auth: AuthBinding,
    operation: OperatorOperation,
  ): void {
    if (auth.kind !== 'operator'
      || auth.operation !== operation
      || auth.signature !== expectedOperatorSignature(auth)) {
      throw new ModelViolation('AUTH_REJECTED', `invalid ${operation} operator authorization`)
    }
  }

  private assertSameIdentity(inbox: TargetInbox, request: AdmitRequest): void {
    if (inbox.chainId !== request.chainId
      || inbox.attemptId !== request.attemptId
      || inbox.sourceInstanceId !== request.sourceInstanceId
      || inbox.targetId !== request.targetId
      || inbox.snapshotDigest !== request.snapshotDigest
      || inbox.payloadDigest !== request.payloadDigest) {
      throw new ModelViolation('IDENTITY_CONFLICT', `attempt ${request.attemptId} does not match target identity`)
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
    return {
      chainId: inbox.chainId,
      attemptId: inbox.attemptId,
      sourceInstanceId: inbox.sourceInstanceId,
      targetId: inbox.targetId,
      inboxId: inbox.id,
      status: inbox.status,
      receipt: inbox.receipt,
      version: inbox.version,
      invocationStartedAt: inbox.invocationStartedAt,
      executionId: inbox.executionId,
      terminalEvidence: clone(inbox.terminalEvidence),
      failureReason: inbox.failureReason,
      auditEventIds: [...inbox.auditEventIds],
      proof: {
        targetId: inbox.targetId,
        inboxId: inbox.id,
        version: inbox.version,
        status: inbox.status,
        lastAuditEventId,
        auditCount: inbox.auditEventIds.length,
        signature: expectedStatusSignature({
          targetId: inbox.targetId,
          inboxId: inbox.id,
          version: inbox.version,
          status: inbox.status,
          lastAuditEventId,
          auditCount: inbox.auditEventIds.length,
        }),
      },
    }
  }

  private verifyStatusProof(response: TargetStatusResponse): void {
    const { signature, ...unsignedProof } = response.proof
    if (response.targetId !== response.proof.targetId
      || response.inboxId !== response.proof.inboxId
      || response.version !== response.proof.version
      || response.status !== response.proof.status
      || response.proof.auditCount !== response.auditEventIds.length
      || response.proof.lastAuditEventId !== response.auditEventIds.at(-1)
      || signature !== expectedStatusSignature(unsignedProof)) {
      throw new ModelViolation('STATUS_PROOF_INVALID', `target status proof for ${response.attemptId} is invalid`)
    }
  }

  private attempt(attemptId: string): SourceAttempt {
    const attempt = this.stateValue.attempts[attemptId]
    if (!attempt) throw new ModelViolation('ATTEMPT_NOT_FOUND', `unknown attempt ${attemptId}`)
    return attempt
  }

  private chain(chainId: string): SourceChain {
    const chain = this.stateValue.chains[chainId]
    if (!chain) throw new ModelViolation('CHAIN_NOT_FOUND', `unknown chain ${chainId}`)
    return chain
  }

  private outbox(attemptId: string): SourceOutbox {
    const outbox = this.stateValue.outbox[attemptId]
    if (!outbox) throw new ModelViolation('OUTBOX_NOT_FOUND', `unknown outbox for ${attemptId}`)
    return outbox
  }

  private inbox(attemptId: string): TargetInbox | null {
    return this.stateValue.inboxes[keyFor(this.stateValue.sourceInstanceId, attemptId)] ?? null
  }

  private requireInbox(attemptId: string): TargetInbox {
    const inbox = this.inbox(attemptId)
    if (!inbox) throw new ModelViolation('INBOX_NOT_FOUND', `unknown target inbox for ${attemptId}`)
    return inbox
  }

  private requireTargetOnline(): void {
    if (!this.stateValue.targetOnline) {
      throw new ModelViolation('TARGET_OFFLINE', 'target transport is offline')
    }
  }

  private tick(): void {
    this.stateValue.clock += 1
  }

  private sequence(prefix: string): string {
    return `${prefix}-${this.stateValue.nextSequence++}`
  }

  private sourceAuditEvent(
    action: SourceAuditEvent['action'],
    attemptId: string,
    actor: string,
    authorizationId: string | null,
    reason: string | null,
  ): void {
    this.stateValue.sourceAudit.push({
      id: this.sequence('source-audit'),
      action,
      actor,
      authorizationId,
      attemptId,
      reason,
      at: this.stateValue.clock,
    })
  }

  private targetAuditEvent(
    action: TargetAuditEvent['action'],
    inbox: TargetInbox,
    auth: AuthBinding,
    reason: string | null,
  ): void {
    const event: TargetAuditEvent = {
      id: this.sequence('target-audit'),
      action,
      actor: auth.principal,
      authorizationId: auth.authorizationId,
      attemptId: inbox.attemptId,
      reason,
      at: this.stateValue.clock,
    }
    this.stateValue.targetAudit.push(event)
    inbox.auditEventIds.push(event.id)
  }

  private checkInvariants(): void {
    const seenTargetKeys = new Set<string>()
    for (const inbox of Object.values(this.stateValue.inboxes)) {
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
        if (!inbox.terminalEvidence
          || inbox.terminalEvidence.source !== 'durable-agent-message'
          || !inbox.terminalEvidence.publicationId
          || !inbox.terminalEvidence.messageId
          || !inbox.terminalEvidence.messageDigest) {
          throw new ModelViolation('TERMINAL_EVIDENCE_MISSING', `target ${inbox.attemptId} lacks durable publication evidence`)
        }
        if (inbox.invocationStartedAt === null
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
    }

    for (const attempt of Object.values(this.stateValue.attempts)) {
      const chain = this.chain(attempt.chainId)
      const outbox = this.outbox(attempt.id)
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
        const replacement = this.attempt(attempt.replacementAttemptId)
        if (replacement.replacesAttemptId !== attempt.id) {
          throw new ModelViolation('REPLACEMENT_LINEAGE_BROKEN', `replacement ${replacement.id} does not point to ${attempt.id}`)
        }
      }
      if (outbox.attemptId !== attempt.id) {
        throw new ModelViolation('OUTBOX_ATTEMPT_MISMATCH', `outbox ${outbox.id} points at another attempt`)
      }
    }

    for (const chain of Object.values(this.stateValue.chains)) {
      const active = this.attempt(chain.activeAttemptId)
      if (active.chainId !== chain.id) {
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
}

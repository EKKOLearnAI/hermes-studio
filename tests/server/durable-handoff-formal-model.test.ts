import { describe, expect, it } from 'vitest'
import {
  DurableHandoffModel,
  ModelViolation,
  operatorAuth,
  transportAuth,
  transportAuthForRequest,
  type AdmitRequest,
  type TargetKind,
} from './models/durable-handoff-model'

function terminalMessage(attemptId = 'attempt-1') {
  return {
    id: `agent-message-${attemptId}`,
    content: `durable terminal content for ${attemptId}`,
  }
}

function admittedModel(kind: TargetKind = 'local'): DurableHandoffModel {
  const model = new DurableHandoffModel(kind)
  model.apply({ type: 'createAttempt' })
  model.apply({ type: 'sendAdmission', attemptId: 'attempt-1' })
  model.apply({ type: 'admit', attemptId: 'attempt-1' })
  model.apply({ type: 'receiveAdmission', attemptId: 'attempt-1' })
  return model
}

function startedModel(kind: TargetKind = 'local'): DurableHandoffModel {
  const model = admittedModel(kind)
  model.apply({ type: 'claim', attemptId: 'attempt-1' })
  model.apply({ type: 'startInvocation', attemptId: 'attempt-1' })
  return model
}

describe('Issue #2488 durable handoff executable reference model', () => {
  it('rejects terminal publication without real durable evidence', () => {
    const model = startedModel()

    expect(() => model.apply({
      type: 'publishTerminal',
      attemptId: 'attempt-1',
    })).toThrow(/TERMINAL_EVIDENCE_INVALID/)

    expect(() => model.apply({
      type: 'publishTerminal',
      attemptId: 'attempt-1',
      evidence: { source: 'synthetic' as never },
    })).toThrow(ModelViolation)
  })

  it('binds admission identity and receipt to one durable Target inbox', () => {
    const model = new DurableHandoffModel('remote')
    model.apply({ type: 'createAttempt' })
    model.apply({ type: 'sendAdmission', attemptId: 'attempt-1' })
    const first = model.apply({ type: 'admit', attemptId: 'attempt-1' }) as {
      receipt: string
      version: number
    }
    const second = model.apply({ type: 'admit', attemptId: 'attempt-1' }) as {
      receipt: string
      version: number
    }

    expect(second).toMatchObject({
      receipt: first.receipt,
      version: first.version,
    })
    expect(Object.keys(model.snapshot().inboxes)).toEqual(['source-1:attempt-1'])
    expect(model.snapshot().targetAudit.map(event => event.action)).toEqual(['admitted', 'admission_replayed'])
  })

  it('rejects duplicate admission with a changed source identity or payload', () => {
    const model = admittedModel()
    const snapshot = model.snapshot()
    const attempt = snapshot.attempts['attempt-1']
    const conflictingRequest: AdmitRequest = {
      chainId: attempt.chainId,
      attemptId: attempt.id,
      sourceInstanceId: attempt.sourceInstanceId,
      targetId: attempt.targetId,
      snapshotDigest: attempt.snapshotDigest,
      payloadDigest: 'different-payload',
      auth: transportAuthForRequest('admit', {
        chainId: attempt.chainId,
        attemptId: attempt.id,
        sourceInstanceId: attempt.sourceInstanceId,
        targetId: attempt.targetId,
        snapshotDigest: attempt.snapshotDigest,
        payloadDigest: 'different-payload',
      }),
    }

    expect(() => model.admitRequest(conflictingRequest)).toThrow(/IDENTITY_CONFLICT/)
  })

  it('requires authenticated transport operations and verifiable Target status proof', () => {
    const model = admittedModel()
    const snapshot = model.snapshot()
    const attempt = snapshot.attempts['attempt-1']
    const admitRequest: AdmitRequest = {
      chainId: attempt.chainId,
      attemptId: attempt.id,
      sourceInstanceId: attempt.sourceInstanceId,
      targetId: attempt.targetId,
      snapshotDigest: attempt.snapshotDigest,
      payloadDigest: attempt.payloadDigest,
      auth: transportAuth('admit', attempt.sourceInstanceId, attempt.targetId),
    }

    expect(() => model.getStatusRequest(admitRequest)).toThrow(/AUTH_REJECTED/)
    expect(() => model.requestCancel('attempt-1', 'bad-auth', operatorAuth('replace'))).toThrow(/AUTH_REJECTED/)

    const response = model.getStatusRequest({
      ...admitRequest,
      auth: transportAuthForRequest('getStatus', admitRequest),
    })
    expect(response.proof).toMatchObject({
      targetId: attempt.targetId,
      inboxId: 'inbox-source-1-attempt-1',
      version: 1,
      status: 'admitted',
      auditCount: 1,
    })
  })

  it('replays admission after a lost response without a second invocation', () => {
    const model = new DurableHandoffModel('remote')
    model.apply({ type: 'createAttempt' })
    model.apply({ type: 'sendAdmission', attemptId: 'attempt-1' })
    model.apply({ type: 'admit', attemptId: 'attempt-1' })
    model.apply({ type: 'sendAdmission', attemptId: 'attempt-1' })
    model.apply({ type: 'admit', attemptId: 'attempt-1' })
    model.apply({ type: 'receiveAdmission', attemptId: 'attempt-1' })
    model.apply({ type: 'claim', attemptId: 'attempt-1' })
    model.apply({ type: 'startInvocation', attemptId: 'attempt-1' })

    const inbox = model.snapshot().inboxes['source-1:attempt-1']
    expect(inbox.invocationCount).toBe(1)
    expect(inbox.status).toBe('running')
  })

  it('recovers a pre-invocation crash by returning the lease to admitted', () => {
    const model = admittedModel()
    model.apply({ type: 'claim', attemptId: 'attempt-1' })
    model.apply({ type: 'targetRestart', attemptId: 'attempt-1' })

    expect(model.snapshot().inboxes['source-1:attempt-1']).toMatchObject({
      status: 'admitted',
      leaseId: null,
      invocationStartedAt: null,
      invocationCount: 0,
    })

    model.apply({ type: 'claim', attemptId: 'attempt-1' })
    model.apply({ type: 'startInvocation', attemptId: 'attempt-1' })
    expect(model.snapshot().inboxes['source-1:attempt-1'].invocationCount).toBe(1)
  })

  it('turns an invocation-after-marker crash into failed_manual and blocks automatic rerun', () => {
    const model = startedModel()
    model.apply({ type: 'targetRestart', attemptId: 'attempt-1' })

    expect(model.snapshot().inboxes['source-1:attempt-1']).toMatchObject({
      status: 'failed_manual',
      failureReason: 'target_restart_after_invocation',
    })
    expect(() => model.apply({ type: 'claim', attemptId: 'attempt-1' })).toThrow(ModelViolation)
  })

  it('converges after a lost completion callback and a Source restart using getStatus proof', () => {
    const model = startedModel()
    model.apply({ type: 'publishTerminal', attemptId: 'attempt-1', message: terminalMessage() })

    expect(model.snapshot().attempts['attempt-1'].status).toBe('admitted')
    expect(model.snapshot().inboxes['source-1:attempt-1'].status).toBe('completed')
    model.apply({ type: 'sourceRestart' })
    model.apply({ type: 'reconcile', attemptId: 'attempt-1' })

    expect(model.snapshot().attempts['attempt-1'].status).toBe('completed')
    expect(model.snapshot().outbox['attempt-1'].status).toBe('completed')
    expect(model.snapshot().chains['chain-1'].status).toBe('completed')
  })

  it('keeps a durably published terminal stable across a Target restart', () => {
    const model = startedModel()
    model.apply({ type: 'publishTerminal', attemptId: 'attempt-1', message: terminalMessage() })
    const beforeRestart = model.snapshot().inboxes['source-1:attempt-1']
    model.apply({ type: 'targetRestart', attemptId: 'attempt-1' })
    const afterRestart = model.snapshot().inboxes['source-1:attempt-1']

    expect(afterRestart).toMatchObject({
      status: 'completed',
      version: beforeRestart.version,
      invocationCount: 1,
      terminalEvidence: beforeRestart.terminalEvidence,
    })
  })

  it('requires a Target message row and derives publication evidence in one commit', () => {
    const model = startedModel()
    model.apply({ type: 'publishTerminal', attemptId: 'attempt-1', message: terminalMessage() })
    const snapshot = model.snapshot()
    const inbox = snapshot.inboxes['source-1:attempt-1']
    const evidence = inbox.terminalEvidence

    expect(evidence).not.toBeNull()
    expect(snapshot.messages[evidence!.messageId]).toMatchObject({
      id: evidence!.messageId,
      attemptId: 'attempt-1',
      contentDigest: evidence!.messageDigest,
      committedAt: evidence!.committedAt,
    })
    expect(snapshot.publications[evidence!.publicationId]).toMatchObject({
      publicationId: evidence!.publicationId,
      messageId: evidence!.messageId,
      messageDigest: evidence!.messageDigest,
      committedAt: evidence!.committedAt,
    })
  })

  it('creates a durable Target cancellation tombstone when cancellation races admission', () => {
    const model = new DurableHandoffModel('remote')
    model.apply({ type: 'createAttempt' })
    model.apply({ type: 'requestCancel', attemptId: 'attempt-1', reason: 'before_admission' })
    model.apply({ type: 'sendCancel', attemptId: 'attempt-1' })

    expect(model.snapshot().inboxes['source-1:attempt-1'].status).toBe('cancelled')
    expect(model.apply({ type: 'admit', attemptId: 'attempt-1' })).toMatchObject({ status: 'cancelled' })
    model.apply({ type: 'reconcile', attemptId: 'attempt-1' })
    expect(model.snapshot().attempts['attempt-1'].status).toBe('cancelled')
  })

  it('uses one status model for Local and Remote targets', () => {
    const run = (kind: TargetKind) => {
      const model = startedModel(kind)
      model.apply({ type: 'publishTerminal', attemptId: 'attempt-1', message: terminalMessage() })
      model.apply({ type: 'reconcile', attemptId: 'attempt-1' })
      const snapshot = model.snapshot()
      return {
        attempt: snapshot.attempts['attempt-1'],
        inbox: snapshot.inboxes['source-1:attempt-1'],
        chain: snapshot.chains['chain-1'],
      }
    }

    const local = run('local')
    const remote = run('remote')
    expect({
      ...local,
      attempt: { ...local.attempt, targetReceipt: 'stable' },
      inbox: { ...local.inbox, receipt: 'stable' },
    }).toEqual({
      ...remote,
      attempt: { ...remote.attempt, targetReceipt: 'stable' },
      inbox: { ...remote.inbox, receipt: 'stable' },
    })
  })

  it('keeps cancellation pending while Target is offline, then converges by authenticated status', () => {
    const model = admittedModel()
    model.apply({ type: 'setTargetOnline', online: false })
    model.apply({ type: 'requestCancel', attemptId: 'attempt-1', reason: 'operator_cleanup' })

    expect(() => model.apply({ type: 'sendCancel', attemptId: 'attempt-1' })).toThrow(/TARGET_OFFLINE/)
    expect(model.snapshot().attempts['attempt-1'].status).toBe('cancel_pending')

    model.apply({ type: 'setTargetOnline', online: true })
    model.apply({ type: 'sendCancel', attemptId: 'attempt-1' })
    model.apply({ type: 'reconcile', attemptId: 'attempt-1' })
    expect(model.snapshot().attempts['attempt-1'].status).toBe('cancelled')
    expect(model.snapshot().chains['chain-1'].status).toBe('cancelled')
  })

  it('maps cancellation after invocation to failed_manual, never cancelled', () => {
    const model = startedModel()
    model.apply({ type: 'requestCancel', attemptId: 'attempt-1', reason: 'operator_cleanup' })
    model.apply({ type: 'sendCancel', attemptId: 'attempt-1' })
    model.apply({ type: 'reconcile', attemptId: 'attempt-1' })

    expect(model.snapshot().inboxes['source-1:attempt-1'].status).toBe('failed_manual')
    expect(model.snapshot().attempts['attempt-1'].status).toBe('failed_manual')
  })

  it('requires explicit authorized replacement and preserves lineage', () => {
    const model = startedModel()
    model.apply({ type: 'targetRestart', attemptId: 'attempt-1' })
    model.apply({ type: 'reconcile', attemptId: 'attempt-1' })

    expect(() => model.apply({ type: 'replace', attemptId: 'attempt-1' })).not.toThrow()
    const snapshot = model.snapshot()
    expect(snapshot.attempts['attempt-1']).toMatchObject({
      status: 'replaced',
      replacementAttemptId: 'attempt-1-replacement',
    })
    expect(snapshot.attempts['attempt-1-replacement']).toMatchObject({
      status: 'pending',
      replacesAttemptId: 'attempt-1',
    })
    expect(snapshot.sourceAudit.at(-1)).toMatchObject({
      action: 'replacement_created',
      authorizationId: operatorAuth('replace').authorizationId,
    })
  })

  it('rejects illegal event sequences instead of repairing them implicitly', () => {
    const cases = [
      () => new DurableHandoffModel('local').apply({ type: 'publishTerminal', attemptId: 'attempt-1' }),
      () => {
        const model = admittedModel()
        model.apply({ type: 'startInvocation', attemptId: 'attempt-1' })
      },
      () => {
        const model = admittedModel()
        model.apply({ type: 'requestCancel', attemptId: 'attempt-1' })
        model.apply({ type: 'sendCancel', attemptId: 'attempt-1' })
        model.apply({ type: 'claim', attemptId: 'attempt-1' })
      },
      () => {
        const model = admittedModel()
        model.apply({ type: 'replace', attemptId: 'attempt-1' })
      },
    ]

    for (const run of cases) expect(run).toThrow(ModelViolation)
  })

  it('keeps Source and Target as independently reloadable durable stores', () => {
    const model = admittedModel()
    model.apply({ type: 'claim', attemptId: 'attempt-1' })
    model.apply({ type: 'sourceRestart' })

    const stores = (model as unknown as {
      durableStores?: () => {
        source: unknown
        target: unknown
      }
    }).durableStores?.()

    expect(stores).toBeDefined()
    expect(stores?.source).not.toBe(stores?.target)
    expect(model.snapshot().attempts['attempt-1'].status).toBe('admitted')
    expect(model.snapshot().inboxes['source-1:attempt-1'].status).toBe('claimed')
  })

  it('rejects a tampered or stale remote status response before Source mutation', () => {
    const model = startedModel()
    const statusRequest = {
      chainId: 'chain-1',
      attemptId: 'attempt-1',
      sourceInstanceId: 'source-1',
      targetId: 'target-1',
      snapshotDigest: 'snapshot-attempt-1',
      payloadDigest: 'payload-attempt-1',
    } as const
    const status = model.getStatusRequest({
      ...statusRequest,
      auth: transportAuthForRequest('getStatus', statusRequest),
    })
    const tampered = structuredClone(status)
    tampered.status = 'completed'

    expect(() => (model as unknown as {
      reconcileResponse: (attemptId: string, response: unknown) => unknown
    }).reconcileResponse('attempt-1', tampered)).toThrow(/STATUS_PROOF_INVALID/)
    expect(model.snapshot().attempts['attempt-1'].status).toBe('admitted')
  })

  it('rejects an authenticated but expired status response after a newer version is observed', () => {
    const model = startedModel()
    const runningRequest = {
      chainId: 'chain-1',
      attemptId: 'attempt-1',
      sourceInstanceId: 'source-1',
      targetId: 'target-1',
      snapshotDigest: 'snapshot-attempt-1',
      payloadDigest: 'payload-attempt-1',
    } as const
    const runningResponse = model.getStatusRequest({
      ...runningRequest,
      auth: transportAuthForRequest('getStatus', runningRequest),
    })
    const completedResponse = model.apply({
      type: 'publishTerminal',
      attemptId: 'attempt-1',
      message: terminalMessage(),
    }) as { version: number }
    expect(completedResponse.version).toBeGreaterThan(runningResponse.version)
    model.apply({ type: 'reconcile', attemptId: 'attempt-1' })

    expect(() => (model as unknown as {
      reconcileResponse: (attemptId: string, response: unknown) => unknown
    }).reconcileResponse('attempt-1', runningResponse)).toThrow(/STATUS_STALE/)
    expect(model.snapshot().attempts['attempt-1'].status).toBe('completed')
  })

  it('binds transport authorization to the complete request identity and digest', () => {
    const model = new DurableHandoffModel('local')
    model.apply({ type: 'createAttempt' })
    const attempt = model.snapshot().attempts['attempt-1']
    const request = {
      chainId: attempt.chainId,
      attemptId: attempt.id,
      sourceInstanceId: attempt.sourceInstanceId,
      targetId: attempt.targetId,
      snapshotDigest: attempt.snapshotDigest,
      payloadDigest: attempt.payloadDigest,
      auth: transportAuth('admit', attempt.sourceInstanceId, attempt.targetId),
    } as AdmitRequest
    const changed = {
      ...request,
      payloadDigest: 'payload-tampered',
    }

    expect(() => model.admitRequest(changed)).toThrow(/AUTH_REJECTED/)
  })

  it('rejects a stale admission callback after cancellation intent is durable', () => {
    const model = admittedModel()
    model.apply({ type: 'requestCancel', attemptId: 'attempt-1', reason: 'stale_admission' })
    model.apply({ type: 'admit', attemptId: 'attempt-1' })

    expect(() => model.apply({ type: 'receiveAdmission', attemptId: 'attempt-1' }))
      .toThrow(/STALE_ADMISSION/)
    expect(model.snapshot().attempts['attempt-1'].status).toBe('cancel_pending')
  })

  it('keeps failed_manual terminal and rejects ordinary cancellation', () => {
    const model = startedModel()
    model.apply({ type: 'targetRestart', attemptId: 'attempt-1' })
    model.apply({ type: 'reconcile', attemptId: 'attempt-1' })

    expect(() => model.apply({
      type: 'requestCancel',
      attemptId: 'attempt-1',
      reason: 'must_not_reopen_terminal',
    })).toThrow(/CANCEL_TERMINAL/)
    expect(model.snapshot().attempts['attempt-1'].status).toBe('failed_manual')
  })
})

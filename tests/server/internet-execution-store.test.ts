import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  initInternetExecutionSchema,
  InternetExecutionIdentityConflictError,
  InternetExecutionStore,
  InternetExecutionValidationError,
  InternetExecutionVersionConflictError,
} from '../../packages/server/src/services/hermes/internet-execution'

describe('internet execution store', () => {
  let db: DatabaseSync
  let store: InternetExecutionStore

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    initInternetExecutionSchema(db)
    store = new InternetExecutionStore(db)
  })
  afterEach(() => db.close())

  it('prepares one workflow-bound canonical receipt and rejects material-changing replay', () => {
    const first = store.prepareReceipt(prepare())
    expect(first).toMatchObject({ disposition: 'created', receipt: {
      workflowId: 'workflow-internet-1', intentId: 'intent-internet-1', status: 'prepared', version: 1,
      executorType: 'mcp', safeToReplay: true, request: { limit: 5, query: 'Hermes AI' },
    } })
    expect(db.prepare("SELECT request_json FROM internet_execution_receipts WHERE workflow_id='workflow-internet-1'").get())
      .toEqual({ request_json: '{"limit":5,"query":"Hermes AI"}' })
    expect(store.prepareReceipt(prepare()).disposition).toBe('replayed')
    expect(() => store.prepareReceipt(prepare({ operation: 'inspect' })))
      .toThrow(InternetExecutionIdentityConflictError)
  })

  it('persists legal execution and verification transitions with stable provider identity', () => {
    let receipt = store.prepareReceipt(prepare()).receipt
    receipt = store.transitionReceipt(transition(receipt.version, 'executing'))
    expect(receipt).toMatchObject({ status: 'executing', version: 2, completedAt: null })
    receipt = store.transitionReceipt(transition(receipt.version, 'executed', {
      providerRequestId: 'provider-call-1', result: { videoIds: ['BV1example'] },
    }))
    receipt = store.transitionReceipt(transition(receipt.version, 'verifying', {
      providerRequestId: 'provider-call-1', result: { videoIds: ['BV1example'] },
    }))
    receipt = store.transitionReceipt(transition(receipt.version, 'verified', {
      providerRequestId: 'provider-call-1', result: { verifiedVideoIds: ['BV1example'] },
    }))
    expect(receipt).toMatchObject({
      status: 'verified', version: 5, providerRequestId: 'provider-call-1',
      result: { verifiedVideoIds: ['BV1example'] }, errorCode: null,
    })
    expect(receipt.completedAt).not.toBeNull()
    expect(() => store.transitionReceipt(transition(receipt.version, 'failed', { errorCode: 'LATE_FAILURE' })))
      .toThrow(InternetExecutionValidationError)
    expect(() => store.transitionReceipt(transition(1, 'failed', { errorCode: 'STALE' })))
      .toThrow(InternetExecutionVersionConflictError)
  })

  it('allows uncertain read replay but blocks replay for receipts without a safe declaration', () => {
    let safe = store.prepareReceipt(prepare()).receipt
    safe = store.transitionReceipt(transition(safe.version, 'executing'))
    safe = store.transitionReceipt(transition(safe.version, 'unknown', { errorCode: 'TRANSPORT_UNCERTAIN' }))
    safe = store.transitionReceipt(transition(safe.version, 'executing'))
    expect(safe.status).toBe('executing')

    let unsafe = store.prepareReceipt(prepare({
      workflowId: 'workflow-internet-unsafe', intentId: 'intent-internet-unsafe', safeToReplay: false,
    })).receipt
    unsafe = store.transitionReceipt({ ...transition(unsafe.version, 'executing'), workflowId: unsafe.workflowId })
    unsafe = store.transitionReceipt({
      ...transition(unsafe.version, 'unknown', { errorCode: 'TRANSPORT_UNCERTAIN' }), workflowId: unsafe.workflowId,
    })
    expect(() => store.transitionReceipt({
      ...transition(unsafe.version, 'executing'), workflowId: unsafe.workflowId,
    })).toThrow(/not safe to replay/i)
  })

  it('records contiguous idempotent browser checkpoints and rejects private or identity-changing state', () => {
    store.prepareReceipt(prepare({ executorType: 'browser', executorId: 'bilibili-browser', environment: 'sandbox' }))
    const first = checkpoint(0, 'browser_navigate', {
      publicUrl: 'https://search.bilibili.com/all?keyword=Hermes%20AI', details: { taskId: 'workflow-internet-1' },
    })
    expect(store.recordCheckpoint(first).disposition).toBe('created')
    expect(store.recordCheckpoint(first).disposition).toBe('replayed')
    expect(store.recordCheckpoint(checkpoint(1, 'browser_snapshot', {
      publicUrl: 'https://search.bilibili.com/all?keyword=Hermes%20AI', evidenceDigest: 'b'.repeat(64),
      details: { videoIds: ['BV1example'] },
    })).checkpoint.ordinal).toBe(1)
    expect(store.listCheckpoints('workflow-internet-1').map(item => item.kind))
      .toEqual(['browser_navigate', 'browser_snapshot'])
    expect(() => store.recordCheckpoint({ ...first, details: { changed: true } }))
      .toThrow(InternetExecutionIdentityConflictError)
    expect(() => store.recordCheckpoint(checkpoint(3, 'browser_snapshot'))).toThrow(/contiguous/i)
    expect(() => store.recordCheckpoint(checkpoint(2, 'browser_navigate', {
      publicUrl: 'https://127.0.0.1/admin',
    }))).toThrow(/private host/i)
  })

  it('rejects credentials, local paths, unsafe objects, oversized values, and sensitive URLs before persistence', () => {
    expect(() => store.prepareReceipt(prepare({ request: { accessToken: 'must-not-persist' } })))
      .toThrow(InternetExecutionValidationError)
    expect(() => store.prepareReceipt(prepare({ request: { note: 'password=must-not-persist' } })))
      .toThrow(InternetExecutionValidationError)
    expect(() => store.prepareReceipt(prepare({ request: { local: 'C:\\Users\\secret\\cookies' } })))
      .toThrow(InternetExecutionValidationError)
    const getter = Object.defineProperty({}, 'query', { enumerable: true, get: () => 'leak' })
    expect(() => store.prepareReceipt(prepare({ request: getter }))).toThrow(InternetExecutionValidationError)
    const arrayGetter: unknown[] = []
    Object.defineProperty(arrayGetter, '0', { enumerable: true, get: () => 'leak' })
    arrayGetter.length = 1
    expect(() => store.prepareReceipt(prepare({ request: { values: arrayGetter } })))
      .toThrow(InternetExecutionValidationError)
    expect(() => store.prepareReceipt(prepare({ request: { query: 'x'.repeat(70_000) } })))
      .toThrow(InternetExecutionValidationError)
    let receipt = store.prepareReceipt(prepare()).receipt
    expect(() => store.transitionReceipt(transition(receipt.version, 'executing', {
      providerRequestId: 'password=must-not-persist',
    }))).toThrow(InternetExecutionValidationError)
    receipt = store.getReceipt(receipt.workflowId)!
    expect(receipt.providerRequestId).toBeNull()
    store.prepareReceipt(prepare({
      workflowId: 'workflow-internet-browser', intentId: 'intent-internet-browser',
      executorType: 'browser', executorId: 'bilibili-browser', environment: 'sandbox',
    }))
    expect(() => store.recordCheckpoint({ ...checkpoint(0, 'browser_navigate', {
      publicUrl: 'https://www.bilibili.com/video/BV1example?access_token=secret',
    }), workflowId: 'workflow-internet-browser' })).toThrow(/sensitive/i)
  })

  it('allows public author fields without weakening exact auth-key rejection', () => {
    let receipt = store.prepareReceipt(prepare()).receipt
    receipt = store.transitionReceipt(transition(receipt.version, 'executing'))
    receipt = store.transitionReceipt(transition(receipt.version, 'executed', {
      result: { video: { author: 'Alice' } },
    }))
    expect(receipt.result).toEqual({ video: { author: 'Alice' } })

    const second = store.prepareReceipt(prepare({
      workflowId: 'workflow-internet-auth', intentId: 'intent-internet-auth',
    })).receipt
    const executing = store.transitionReceipt({
      ...transition(second.version, 'executing'), workflowId: second.workflowId,
    })
    expect(() => store.transitionReceipt({
      ...transition(executing.version, 'executed', { result: { auth: 'must-not-persist' } }),
      workflowId: second.workflowId,
    })).toThrow(InternetExecutionValidationError)
  })

  it('filters bounded receipt history without exposing internal mutable references', () => {
    store.prepareReceipt(prepare())
    store.prepareReceipt(prepare({ workflowId: 'workflow-internet-2', intentId: 'intent-internet-2', profile: 'research' }))
    const listed = store.listReceipts({ provider: 'bilibili', profile: 'research', limit: 500 })
    expect(listed.map(item => item.workflowId)).toEqual(['workflow-internet-2'])
    listed[0]!.request.query = 'mutated'
    expect(store.getReceipt('workflow-internet-2')?.request).toEqual({ limit: 5, query: 'Hermes AI' })
  })
})

const digest = 'a'.repeat(64)

function prepare(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: 'workflow-internet-1', intentId: 'intent-internet-1', materialDigest: digest,
    capabilityId: 'bilibili.video.search', provider: 'bilibili', profile: 'default', executorId: 'bilibili-mcp',
    executorType: 'mcp' as const, environment: 'production' as const, operation: 'search',
    request: { query: 'Hermes AI', limit: 5 }, safeToReplay: true, ...overrides,
  } as never
}

function transition(version: number, status: string, overrides: Record<string, unknown> = {}) {
  return { workflowId: 'workflow-internet-1', materialDigest: digest, expectedVersion: version, status, ...overrides } as never
}

function checkpoint(ordinal: number, kind: string, overrides: Record<string, unknown> = {}) {
  return {
    workflowId: 'workflow-internet-1', materialDigest: digest, ordinal, kind,
    details: {}, observedAt: '2026-07-15T03:00:00.000Z', ...overrides,
  } as never
}

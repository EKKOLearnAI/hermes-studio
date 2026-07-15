import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBridgeBrowserResponse } from '../../packages/server/src/services/hermes/agent-bridge'
import type { FabricExecutionContext } from '../../packages/server/src/services/hermes/action-fabric/executors'
import {
  createInternetBrowserExecutorAdapter,
  normalizeBilibiliBrowserSnapshot,
} from '../../packages/server/src/services/hermes/internet-execution/browser-executor'
import { withInternetExecutionDb } from '../../packages/server/src/services/hermes/internet-execution/database'
import { InternetExecutionStore } from '../../packages/server/src/services/hermes/internet-execution/store'

const EXECUTOR_ID = 'bilibili-browser-production'
const BVID_A = 'BV1xx411c7mD'
const BVID_B = 'BV1Q541167Qg'
const SESSION_ID = 'browser-session-0123456789abcdef01234567'

describe('persistent Bilibili browser Action Fabric executor', () => {
  let home: string
  let previousHome: string | undefined

  beforeEach(() => {
    previousHome = process.env.HERMES_HOME
    home = mkdtempSync(join(tmpdir(), 'internet-browser-executor-'))
    process.env.HERMES_HOME = home
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  it('persists navigation/capture checkpoints, verifies from a fresh snapshot, and replays terminal reads', async () => {
    const navigate = vi.fn(async input => navigateResponse(input.workflowId, input.url))
    const snapshot = vi.fn()
      .mockImplementationOnce(async input => snapshotResponse(input.workflowId, searchSnapshot(BVID_A, 'Video A', 'Alice')))
      .mockImplementationOnce(async input => snapshotResponse(input.workflowId, searchSnapshot(BVID_A, 'Video A', 'Alice')))
    const adapter = adapterWith(navigate, snapshot)
    const context = searchContext('001')

    const prepared = await adapter.prepare(context)
    expect(prepared).toMatchObject({
      outcome: 'prepared',
      output: { provider: 'bilibili', profile: 'default', operation: 'search', bridgeContract: 'bilibili-accessibility-v1' },
    })
    expect(JSON.stringify(prepared.output)).not.toContain('https://')

    const executing = { ...context, preparedOutput: prepared.output }
    const executed = await adapter.execute(executing)
    expect(executed).toMatchObject({
      outcome: 'succeeded',
      output: {
        operation: 'search', query: 'Hermes', status: 'succeeded',
        videos: [{ bvid: BVID_A, title: 'Video A', author: 'Alice', canonicalUrl: `https://www.bilibili.com/video/${BVID_A}` }],
      },
    })
    expect(navigate).toHaveBeenCalledWith({
      workflowId: context.workflowId,
      profile: 'default',
      url: 'https://search.bilibili.com/all?keyword=Hermes&order=totalrank&page=1',
      timeoutMs: 30_000,
    })
    expect(snapshot).toHaveBeenCalledTimes(1)

    const verified = await adapter.verify({ ...executing, executionOutput: executed.output })
    expect(verified).toMatchObject({ outcome: 'verified', output: executed.output })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledTimes(2)

    expect(await adapter.execute(executing)).toMatchObject({ outcome: 'succeeded', output: executed.output })
    expect(await adapter.verify({ ...executing, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'verified', output: executed.output })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledTimes(2)

    const receipt = readStore(store => store.getReceipt(context.workflowId))
    const checkpoints = readStore(store => store.listCheckpoints(context.workflowId))
    expect(receipt).toMatchObject({ status: 'verified', executorType: 'browser', safeToReplay: true, result: executed.output })
    expect(checkpoints.map(checkpoint => checkpoint.kind))
      .toEqual(['browser_navigate', 'browser_snapshot', 'verification_read'])
    expect(checkpoints[0]?.publicUrl).toBe('https://search.bilibili.com/all?keyword=Hermes&order=totalrank&page=1')
    expect(JSON.stringify({ receipt, checkpoints })).not.toMatch(/cookie|authorization|access_token|browser-session/i)
  })

  it('reopens a lost browser session from a durable navigation checkpoint', async () => {
    const navigate = vi.fn(async input => navigateResponse(input.workflowId, input.url))
    const snapshot = vi.fn()
      .mockImplementationOnce(async input => errorResponse(input.workflowId, 'BROWSER_SESSION_REOPEN_REQUIRED'))
      .mockImplementationOnce(async input => snapshotResponse(input.workflowId, searchSnapshot(BVID_A, 'Video A', 'Alice')))
    const adapter = adapterWith(navigate, snapshot)
    const context = searchContext('002')
    const prepared = await adapter.prepare(context)
    const receipt = readStore(store => store.getReceipt(context.workflowId))!
    readStore(store => store.recordCheckpoint({
      workflowId: receipt.workflowId,
      materialDigest: receipt.materialDigest,
      ordinal: 0,
      kind: 'browser_navigate',
      publicUrl: 'https://search.bilibili.com/all?keyword=Hermes&order=totalrank&page=1',
      evidenceDigest: 'b'.repeat(64),
      details: { provider: 'bilibili', profile: 'default', phase: 'execute' },
      observedAt: '2026-07-15T03:00:00.000Z',
    }))

    const executed = await adapter.execute({ ...context, preparedOutput: prepared.output })
    expect(executed).toMatchObject({ outcome: 'succeeded', output: { videos: [{ bvid: BVID_A }] } })
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(readStore(store => store.listCheckpoints(context.workflowId)).map(item => item.kind))
      .toEqual(['browser_navigate', 'browser_navigate', 'browser_snapshot'])
  })

  it('safely repeats a read-only navigation after effect-before-checkpoint uncertainty', async () => {
    const navigate = vi.fn(async input => navigateResponse(input.workflowId, input.url))
    const snapshot = vi.fn(async input => snapshotResponse(input.workflowId, searchSnapshot(BVID_A, 'Video A', 'Alice')))
    let failNavigationCheckpoint = true
    const accessStore = <T>(operation: (store: InternetExecutionStore) => T): T => withInternetExecutionDb<T>(database => {
      const store = new InternetExecutionStore(database)
      const record = store.recordCheckpoint.bind(store)
      store.recordCheckpoint = input => {
        if (failNavigationCheckpoint && input.kind === 'browser_navigate') {
          failNavigationCheckpoint = false
          throw new Error('simulated checkpoint loss')
        }
        return record(input)
      }
      return operation(store) as T & (T extends PromiseLike<unknown> ? never : unknown)
    })
    const adapter = createInternetBrowserExecutorAdapter({
      id: EXECUTOR_ID,
      environment: 'production',
      now: () => '2026-07-15T03:00:00.000Z',
      navigate,
      snapshot,
      accessStore,
    })
    const context = searchContext('effect-before-checkpoint')
    const prepared = await adapter.prepare(context)
    const executing = { ...context, preparedOutput: prepared.output }

    expect(await adapter.execute(executing)).toMatchObject({
      outcome: 'temporary_failure', errorCode: 'INTERNET_BROWSER_NAVIGATION_PERSIST_UNCERTAIN', safeToRetry: true,
    })
    expect(readStore(store => store.getReceipt(context.workflowId))).toMatchObject({
      status: 'unknown', result: null, errorCode: 'INTERNET_BROWSER_NAVIGATION_PERSIST_UNCERTAIN',
    })
    expect(readStore(store => store.listCheckpoints(context.workflowId))).toEqual([])

    expect(await adapter.execute(executing)).toMatchObject({
      outcome: 'succeeded', output: { videos: [{ bvid: BVID_A }] },
    })
    expect(navigate).toHaveBeenCalledTimes(2)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(readStore(store => store.listCheckpoints(context.workflowId)).map(item => item.kind))
      .toEqual(['browser_navigate', 'browser_snapshot'])
  })

  it('persists challenge takeover without page content and resumes only after an explicit retry', async () => {
    const navigate = vi.fn(async input => navigateResponse(input.workflowId, input.url))
    const snapshot = vi.fn()
      .mockImplementationOnce(async input => waitingResponse(input.workflowId, 'BROWSER_HUMAN_VERIFICATION_REQUIRED'))
      .mockImplementationOnce(async input => snapshotResponse(input.workflowId, searchSnapshot(BVID_A, 'Video A', 'Alice')))
    const adapter = adapterWith(navigate, snapshot)
    const context = searchContext('003')
    const prepared = await adapter.prepare(context)
    const executing = { ...context, preparedOutput: prepared.output }

    expect(await adapter.execute(executing)).toMatchObject({
      outcome: 'unknown', errorCode: 'INTERNET_BROWSER_HUMAN_VERIFICATION_REQUIRED', safeToRetry: false,
    })
    expect(readStore(store => store.getReceipt(context.workflowId))).toMatchObject({
      status: 'waiting_user', result: null, errorCode: 'INTERNET_BROWSER_HUMAN_VERIFICATION_REQUIRED',
    })

    expect(await adapter.execute(executing)).toMatchObject({
      outcome: 'succeeded', output: { videos: [{ bvid: BVID_A }] },
    })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(readStore(store => store.getReceipt(context.workflowId))).toMatchObject({ status: 'executed', errorCode: null })
  })

  it('marks non-overlapping fresh search evidence as a durable mismatch', async () => {
    const navigate = vi.fn(async input => navigateResponse(input.workflowId, input.url))
    const snapshot = vi.fn()
      .mockImplementationOnce(async input => snapshotResponse(input.workflowId, searchSnapshot(BVID_A, 'Video A', 'Alice')))
      .mockImplementationOnce(async input => snapshotResponse(input.workflowId, searchSnapshot(BVID_B, 'Video B', 'Bob')))
    const adapter = adapterWith(navigate, snapshot)
    const context = searchContext('004')
    const prepared = await adapter.prepare(context)
    const executing = { ...context, preparedOutput: prepared.output }
    const executed = await adapter.execute(executing)

    expect(await adapter.verify({ ...executing, executionOutput: executed.output })).toMatchObject({
      outcome: 'mismatch', errorCode: 'INTERNET_BROWSER_VERIFICATION_MISMATCH',
    })
    expect(readStore(store => store.getReceipt(context.workflowId))).toMatchObject({
      status: 'mismatch', result: executed.output, errorCode: 'INTERNET_BROWSER_VERIFICATION_MISMATCH',
    })
  })

  it('maps inspect to the exact public video URL and verifies the requested BVID', async () => {
    const url = `https://www.bilibili.com/video/${BVID_A}`
    const navigate = vi.fn(async input => navigateResponse(input.workflowId, input.url))
    const snapshot = vi.fn(async input => snapshotResponse(
      input.workflowId, inspectSnapshot(BVID_A, 'Hermes Deep Dive', 'Alice'), url,
    ))
    const adapter = adapterWith(navigate, snapshot)
    const context = inspectContext('005')
    const prepared = await adapter.prepare(context)
    const executing = { ...context, preparedOutput: prepared.output }
    const executed = await adapter.execute(executing)

    expect(navigate).toHaveBeenCalledWith({
      workflowId: context.workflowId, profile: 'default', url, timeoutMs: 30_000,
    })
    expect(executed).toMatchObject({
      outcome: 'succeeded',
      output: {
        operation: 'inspect', video: { bvid: BVID_A, title: 'Hermes Deep Dive', author: 'Alice' },
        description: 'Public description', tags: [],
      },
    })
    expect(await adapter.verify({ ...executing, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'verified', output: executed.output })
    expect(snapshot).toHaveBeenCalledTimes(2)
  })

  it('parses exact inspect identity and rejects challenge, sensitive, or oversized snapshots', () => {
    const context = inspectContext('006')
    const url = `https://www.bilibili.com/video/${BVID_A}`
    expect(normalizeBilibiliBrowserSnapshot(context.capabilityId, context.input, url,
      inspectSnapshot(BVID_A, 'Hermes Deep Dive', 'Alice'))).toMatchObject({
      operation: 'inspect', video: { bvid: BVID_A, title: 'Hermes Deep Dive', author: 'Alice' },
    })
    expect(() => normalizeBilibiliBrowserSnapshot(context.capabilityId, context.input, url,
      'heading "Captcha"\ntext "Please verify you are a robot"')).toThrow('INTERNET_BROWSER_HUMAN_VERIFICATION_REQUIRED')
    expect(() => normalizeBilibiliBrowserSnapshot(context.capabilityId, context.input, url,
      `${inspectSnapshot(BVID_A, 'Hermes', 'Alice')}\naccess_token=must-not-persist`))
      .toThrow('INTERNET_BROWSER_SNAPSHOT_INVALID')
    expect(() => normalizeBilibiliBrowserSnapshot(context.capabilityId, context.input, url, 'x'.repeat(65_537)))
      .toThrow('INTERNET_BROWSER_SNAPSHOT_INVALID')
    expect(() => normalizeBilibiliBrowserSnapshot(context.capabilityId, context.input, url,
      inspectSnapshot(BVID_B, 'Other', 'Bob'))).toThrow('INTERNET_BROWSER_SNAPSHOT_INVALID')
  })

  function adapterWith(navigate: ReturnType<typeof vi.fn>, snapshot: ReturnType<typeof vi.fn>) {
    return createInternetBrowserExecutorAdapter({
      id: EXECUTOR_ID,
      environment: 'production',
      now: () => '2026-07-15T03:00:00.000Z',
      navigate,
      snapshot,
    })
  }
})

function searchContext(suffix: string): FabricExecutionContext {
  return {
    intentId: `intent-browser-${suffix}`,
    workflowId: `workflow-browser-${suffix}`,
    stepId: `step-browser-${suffix}`,
    executorId: EXECUTOR_ID,
    executorType: 'browser',
    capabilityId: 'bilibili.video.search',
    capabilityVersion: 1,
    contractDigest: 'a'.repeat(64),
    policyEvaluationToken: `policy-${suffix}`,
    executionToken: `execute-${suffix}`,
    input: {
      schemaVersion: 1, provider: 'bilibili', profile: 'default', query: 'Hermes', limit: 5, page: 1,
      order: 'relevance',
    },
    target: { kind: 'internet_provider', origin: 'www.bilibili.com', profile: 'default', provider: 'bilibili' },
    now: '2026-07-15T03:00:00.000Z',
  }
}

function inspectContext(suffix: string): FabricExecutionContext {
  return {
    ...searchContext(suffix),
    capabilityId: 'bilibili.video.inspect',
    input: { schemaVersion: 1, provider: 'bilibili', profile: 'default', bvid: BVID_A },
  }
}

function navigateResponse(workflowId: string, url: string): AgentBridgeBrowserResponse {
  return {
    ok: true, action: 'navigate', workflow_id: workflowId, session_id: SESSION_ID,
    status: 'succeeded', error_code: null, url, title: 'Bilibili',
  }
}

function snapshotResponse(
  workflowId: string,
  snapshot: string,
  url = 'https://search.bilibili.com/all?keyword=Hermes&order=totalrank&page=1',
): AgentBridgeBrowserResponse {
  return {
    ok: true, action: 'snapshot', workflow_id: workflowId, session_id: SESSION_ID,
    status: 'succeeded', error_code: null,
    url, snapshot, element_count: 4,
  }
}

function errorResponse(workflowId: string, errorCode: string): AgentBridgeBrowserResponse {
  return {
    ok: true, action: 'snapshot', workflow_id: workflowId, session_id: SESSION_ID,
    status: 'error', error_code: errorCode,
  }
}

function waitingResponse(workflowId: string, errorCode: string): AgentBridgeBrowserResponse {
  return {
    ok: true, action: 'snapshot', workflow_id: workflowId, session_id: SESSION_ID,
    status: 'waiting_user', error_code: errorCode,
  }
}

function searchSnapshot(bvid: string, title: string, author: string): string {
  return [
    `link "${title}"`,
    `  /url: https://www.bilibili.com/video/${bvid}`,
    `link "${author}"`,
    '  /url: https://space.bilibili.com/12345',
  ].join('\n')
}

function inspectSnapshot(bvid: string, title: string, author: string): string {
  return [
    `heading "${title}"`,
    `link "${bvid}"`,
    `  /url: https://www.bilibili.com/video/${bvid}`,
    `link "${author}"`,
    '  /url: https://space.bilibili.com/12345',
    '简介：Public description',
  ].join('\n')
}

function readStore<T>(operation: (store: InternetExecutionStore) => T): T {
  return withInternetExecutionDb<T>(database => operation(new InternetExecutionStore(database)) as
    T & (T extends PromiseLike<unknown> ? never : unknown))
}

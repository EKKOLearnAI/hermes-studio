import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FabricExecutionContext } from '../../packages/server/src/services/hermes/action-fabric/executors'
import {
  createInternetMcpExecutorAdapter,
} from '../../packages/server/src/services/hermes/internet-execution/mcp-executor'
import type {
  BilibiliMcpBinding,
  BilibiliMcpDiscovery,
} from '../../packages/server/src/services/hermes/internet-execution/mcp-discovery'
import { withInternetExecutionDb } from '../../packages/server/src/services/hermes/internet-execution/database'
import { InternetExecutionStore } from '../../packages/server/src/services/hermes/internet-execution/store'

const EXECUTOR_ID = 'bilibili-mcp-production'
const BVID_A = 'BV1xx411c7mD'
const BVID_B = 'BV1Q541167Qg'

describe('generic internet MCP Action Fabric executor', () => {
  let home: string
  let previousHome: string | undefined
  let binding: BilibiliMcpBinding
  let discovery: BilibiliMcpDiscovery

  beforeEach(() => {
    previousHome = process.env.HERMES_HOME
    home = mkdtempSync(join(tmpdir(), 'internet-mcp-executor-'))
    process.env.HERMES_HOME = home
    binding = healthyBinding()
    discovery = healthyDiscovery(binding)
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  it('persists prepare/execute/second-read verification and safely replays terminal reads', async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce(callResponse(searchPayload(BVID_A, 10)))
      .mockResolvedValueOnce(callResponse(searchPayload(BVID_A, 11)))
    const adapter = adapterWith(callTool)
    const context = searchContext('001')

    const prepared = await adapter.prepare(context)
    expect(prepared).toMatchObject({ outcome: 'prepared', errorCode: null })
    const executing = { ...context, preparedOutput: prepared.output }
    const executed = await adapter.execute(executing)
    expect(executed).toMatchObject({
      outcome: 'succeeded',
      output: { operation: 'search', query: 'Hermes', videos: [{ bvid: BVID_A, viewCount: 10 }] },
    })
    expect(callTool).toHaveBeenNthCalledWith(1, {
      profile: 'default', server: 'bilibili', tool: 'search_videos',
      arguments: { query: 'Hermes', limit: 5, page: 1, order: 'relevance' }, timeoutMs: 30_000,
    })

    const verified = await adapter.verify({ ...executing, executionOutput: executed.output })
    expect(verified).toMatchObject({ outcome: 'verified', output: executed.output })
    expect(callTool).toHaveBeenCalledTimes(2)

    expect(await adapter.execute(executing)).toMatchObject({ outcome: 'succeeded', output: executed.output })
    expect(await adapter.verify({ ...executing, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'verified', output: executed.output })
    expect(callTool).toHaveBeenCalledTimes(2)

    const receipt = readStore(store => store.getReceipt(context.workflowId))
    expect(receipt).toMatchObject({
      status: 'verified', safeToReplay: true, executorType: 'mcp', environment: 'production',
      operation: 'search', result: executed.output,
    })
    expect(readStore(store => store.listCheckpoints(context.workflowId)).map(item => item.kind))
      .toEqual(['mcp_call', 'verification_read'])
    expect(JSON.stringify({ receipt, checkpoints: readStore(store => store.listCheckpoints(context.workflowId)) }))
      .not.toMatch(/token|authorization|cookie|secret/i)
  })

  it('replays a transport-uncertain read and records only the successful attempt', async () => {
    const callTool = vi.fn()
      .mockRejectedValueOnce(new Error('Bearer private-token'))
      .mockResolvedValueOnce(callResponse(searchPayload(BVID_A, 10)))
    const adapter = adapterWith(callTool)
    const context = searchContext('002')
    const prepared = await adapter.prepare(context)
    const executing = { ...context, preparedOutput: prepared.output }

    expect(await adapter.execute(executing)).toMatchObject({
      outcome: 'temporary_failure', errorCode: 'INTERNET_MCP_TRANSPORT_UNCERTAIN', safeToRetry: true,
    })
    expect(readStore(store => store.getReceipt(context.workflowId))).toMatchObject({
      status: 'unknown', result: null, errorCode: 'INTERNET_MCP_TRANSPORT_UNCERTAIN',
    })

    const recovered = await adapter.execute(executing)
    expect(recovered).toMatchObject({ outcome: 'succeeded', output: { videos: [{ bvid: BVID_A }] } })
    expect(callTool).toHaveBeenCalledTimes(2)
    expect(readStore(store => store.listCheckpoints(context.workflowId))).toHaveLength(1)
    expect(JSON.stringify(readStore(store => store.getReceipt(context.workflowId)))).not.toContain('private-token')
  })

  it('fails closed for malformed results and for binding changes after prepare', async () => {
    const malformedCall = vi.fn().mockResolvedValue(callResponse({ access_token: 'must-not-persist' }))
    const malformedAdapter = adapterWith(malformedCall)
    const malformedContext = searchContext('003')
    const prepared = await malformedAdapter.prepare(malformedContext)
    expect(await malformedAdapter.execute({ ...malformedContext, preparedOutput: prepared.output })).toMatchObject({
      outcome: 'permanent_failure', errorCode: 'INTERNET_MCP_RESPONSE_INVALID',
    })
    const failed = readStore(store => store.getReceipt(malformedContext.workflowId))
    expect(failed).toMatchObject({ status: 'failed', result: null, errorCode: 'INTERNET_MCP_RESPONSE_INVALID' })
    expect(JSON.stringify(failed)).not.toContain('must-not-persist')

    const callTool = vi.fn().mockResolvedValue(callResponse(searchPayload(BVID_A, 1)))
    const changingAdapter = adapterWith(callTool)
    const changingContext = searchContext('004')
    const first = await changingAdapter.prepare(changingContext)
    binding = {
      ...binding,
      server: 'bilibili_readonly',
      tools: { ...binding.tools, 'bilibili.video.search': 'video_search' },
    }
    discovery = healthyDiscovery(binding)
    expect(await changingAdapter.execute({ ...changingContext, preparedOutput: first.output })).toMatchObject({
      outcome: 'permanent_failure', errorCode: 'INTERNET_MCP_PREPARATION_INVALID',
    })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('marks a non-overlapping second search read as a durable mismatch', async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce(callResponse(searchPayload(BVID_A, 10)))
      .mockResolvedValueOnce(callResponse(searchPayload(BVID_B, 20)))
    const adapter = adapterWith(callTool)
    const context = searchContext('005')
    const prepared = await adapter.prepare(context)
    const executing = { ...context, preparedOutput: prepared.output }
    const executed = await adapter.execute(executing)

    expect(await adapter.verify({ ...executing, executionOutput: executed.output })).toMatchObject({
      outcome: 'mismatch', errorCode: 'INTERNET_MCP_VERIFICATION_MISMATCH',
    })
    expect(readStore(store => store.getReceipt(context.workflowId))).toMatchObject({
      status: 'mismatch', result: executed.output, errorCode: 'INTERNET_MCP_VERIFICATION_MISMATCH',
    })
  })

  it('maps inspect arguments and verifies the exact BVID through a fresh read', async () => {
    const callTool = vi.fn().mockResolvedValue({
      ok: true, server: 'bilibili', tool: 'get_video_info', status: 'succeeded', error_code: null,
      result: { bvid: BVID_A, title: 'Hermes', author: 'Alice', description: 'Public description', tags: ['AI'] },
    })
    const adapter = adapterWith(callTool)
    const context = inspectContext('006')
    const prepared = await adapter.prepare(context)
    const executing = { ...context, preparedOutput: prepared.output }
    const executed = await adapter.execute(executing)
    expect(executed).toMatchObject({
      outcome: 'succeeded',
      output: { operation: 'inspect', video: { bvid: BVID_A }, description: 'Public description', tags: ['AI'] },
    })
    expect(await adapter.verify({ ...executing, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'verified' })
    expect(callTool).toHaveBeenNthCalledWith(1, {
      profile: 'default', server: 'bilibili', tool: 'get_video_info', arguments: { bvid: BVID_A }, timeoutMs: 30_000,
    })
    expect(callTool).toHaveBeenCalledTimes(2)
  })

  it('retries Twin outcome projection from a terminal receipt without another provider call', async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce(callResponse(searchPayload(BVID_A, 10)))
      .mockResolvedValueOnce(callResponse(searchPayload(BVID_A, 11)))
    const projectOutcome = vi.fn()
      .mockImplementationOnce(() => { throw new Error('Twin temporarily unavailable') })
      .mockImplementationOnce(() => undefined)
    const adapter = adapterWith(callTool, projectOutcome)
    const context = searchContext('outcome-retry')
    const prepared = await adapter.prepare(context)
    const executing = { ...context, preparedOutput: prepared.output }
    const executed = await adapter.execute(executing)

    expect(await adapter.verify({ ...executing, executionOutput: executed.output })).toMatchObject({
      outcome: 'unknown', errorCode: 'INTERNET_OUTCOME_PROJECTION_UNAVAILABLE', safeToRetry: true,
    })
    expect(readStore(store => store.getReceipt(context.workflowId))).toMatchObject({ status: 'verified' })
    expect(await adapter.verify({ ...executing, executionOutput: executed.output }))
      .toMatchObject({ outcome: 'verified' })
    expect(callTool).toHaveBeenCalledTimes(2)
    expect(projectOutcome).toHaveBeenCalledTimes(2)
  })

  function adapterWith(callTool: ReturnType<typeof vi.fn>, projectOutcome = vi.fn()) {
    return createInternetMcpExecutorAdapter({
      id: EXECUTOR_ID,
      environment: 'production',
      now: () => '2026-07-15T03:00:00.000Z',
      resolveBinding: () => binding,
      discoverBinding: async () => discovery,
      callTool,
      projectOutcome,
    })
  }
})

function searchContext(suffix: string): FabricExecutionContext {
  return {
    intentId: `intent-internet-${suffix}`,
    workflowId: `workflow-internet-${suffix}`,
    stepId: `step-internet-${suffix}`,
    executorId: EXECUTOR_ID,
    executorType: 'mcp',
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

function healthyBinding(): BilibiliMcpBinding {
  return {
    profile: 'default', provider: 'bilibili', server: 'bilibili',
    tools: {
      'bilibili.video.search': 'search_videos',
      'bilibili.video.inspect': 'get_video_info',
    },
  }
}

function healthyDiscovery(binding: BilibiliMcpBinding): BilibiliMcpDiscovery {
  return {
    profile: binding.profile, provider: 'bilibili', server: binding.server, status: 'healthy', errorCode: null,
    capabilities: {
      'bilibili.video.search': {
        capabilityId: 'bilibili.video.search', tool: binding.tools['bilibili.video.search'], available: true, errorCode: null,
      },
      'bilibili.video.inspect': {
        capabilityId: 'bilibili.video.inspect', tool: binding.tools['bilibili.video.inspect'], available: true, errorCode: null,
      },
    },
  }
}

function searchPayload(bvid: string, viewCount: number) {
  return { items: [{ bvid, title: `Video ${bvid}`, author: 'Alice', viewCount }] }
}

function callResponse(result: unknown) {
  return {
    ok: true as const,
    server: 'bilibili',
    tool: 'search_videos',
    status: 'succeeded' as const,
    error_code: null,
    result,
  }
}

function readStore<T>(operation: (store: InternetExecutionStore) => T): T {
  return withInternetExecutionDb<T>(database => operation(new InternetExecutionStore(database)) as
    T & (T extends PromiseLike<unknown> ? never : unknown))
}

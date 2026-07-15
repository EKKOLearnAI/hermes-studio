import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFabricIntent,
  ensureBuiltInFabricRegistry,
  getFabricWorkflow,
  processActionFabricOnce,
  registerFabricExecutorAdapter,
  setFabricEmergencyStop,
  unregisterFabricExecutorAdapter,
} from '../../packages/server/src/services/hermes/action-fabric'
import type { AgentBridgeBrowserResponse } from '../../packages/server/src/services/hermes/agent-bridge'
import {
  BILIBILI_BROWSER_EXECUTOR_ID,
  BILIBILI_MCP_EXECUTOR_ID,
  InternetProductionRuntime,
} from '../../packages/server/src/services/hermes/internet-execution/production-runtime'
import { createInternetMcpExecutorAdapter } from '../../packages/server/src/services/hermes/internet-execution/mcp-executor'
import { createInternetBrowserExecutorAdapter } from '../../packages/server/src/services/hermes/internet-execution/browser-executor'
import type { BilibiliMcpDiscovery } from '../../packages/server/src/services/hermes/internet-execution/mcp-discovery'
import { InternetExecutionStore } from '../../packages/server/src/services/hermes/internet-execution/store'
import { withInternetExecutionDb } from '../../packages/server/src/services/hermes/internet-execution/database'
import { getPersonalTwinDbPath, initPersonalTwinSchema } from '../../packages/server/src/services/hermes/personal-twin/database'

const BVID = 'BV1xx411c7mD'
const SESSION_ID = 'browser-session-0123456789abcdef01234567'

describe('Phase 6 governed internet execution proof', () => {
  const originalHome = process.env.HERMES_HOME
  const originalAuditKey = process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
  let home = ''
  let twin: DatabaseSync | null = null
  let runtime: InternetProductionRuntime | null = null
  let discovery: BilibiliMcpDiscovery
  let challengeNext = false
  const browserUrls = new Map<string, string>()
  const callTool = vi.fn()
  const navigate = vi.fn()
  const snapshot = vi.fn()

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'internet-e2e-'))
    process.env.HERMES_HOME = home
    process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = 'internet-e2e-managed-audit-key-at-least-32-bytes'
    const twinPath = getPersonalTwinDbPath()
    mkdirSync(join(twinPath, '..'), { recursive: true })
    twin = new DatabaseSync(twinPath)
    twin.exec('PRAGMA foreign_keys=ON')
    initPersonalTwinSchema(twin)
    ensureBuiltInFabricRegistry()
    unregisterExecutors()
    discovery = healthyDiscovery()
    challengeNext = false
    browserUrls.clear()
    callTool.mockReset().mockImplementation(async input => ({
      ok: true, server: 'bilibili', tool: input.tool, status: 'succeeded', error_code: null,
      result: { items: [{ bvid: BVID, title: 'Hermes Studio', author: 'Nous', play: 42 }] },
    }))
    navigate.mockReset().mockImplementation(async input => {
      browserUrls.set(input.workflowId, input.url)
      return navigateResponse(input.workflowId, input.url)
    })
    snapshot.mockReset().mockImplementation(async input => {
      if (challengeNext) {
        challengeNext = false
        return waitingResponse(input.workflowId)
      }
      return snapshotResponse(input.workflowId, browserUrls.get(input.workflowId) ?? '')
    })
  })

  afterEach(async () => {
    unregisterExecutors()
    await runtime?.stop()
    runtime = null
    twin?.close()
    twin = null
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    if (originalAuditKey === undefined) delete process.env.HERMES_ACTION_FABRIC_AUDIT_KEY
    else process.env.HERMES_ACTION_FABRIC_AUDIT_KEY = originalAuditKey
    rmSync(home, { recursive: true, force: true })
  })

  it('executes, verifies, projects, restarts, falls back, waits for takeover, and stops safely', async () => {
    runtime = createRuntime()
    registerAdapters(await runtime.start())

    const mcp = createFabricIntent(searchIntent('mcp-verified', 'Hermes'))
    expect(mcp.policyDecision).toMatchObject({ outcome: 'allow', executorId: BILIBILI_MCP_EXECUTOR_ID })
    await runWorkflow(mcp.workflow.id)
    expect(getFabricWorkflow(mcp.workflow.id)).toMatchObject({ state: 'succeeded' })
    expect(receipt(mcp.workflow.id)).toMatchObject({ status: 'verified', executorType: 'mcp' })
    expect(callTool).toHaveBeenCalledTimes(2)
    expect(twinCounts()).toMatchObject({ entertainment: 1, events: 1, outbox: 1 })

    unregisterExecutors()
    registerAdapters([createMcpAdapter(), createBrowserAdapter()])
    const replay = createFabricIntent(searchIntent('mcp-verified', 'Hermes'))
    expect(replay.workflow.id).toBe(mcp.workflow.id)
    expect(callTool).toHaveBeenCalledTimes(2)
    expect(twinCounts()).toMatchObject({ entertainment: 1, events: 1, outbox: 1 })

    discovery = unavailableDiscovery()
    await runtime.reconcile()
    expect(runtime.getStatus()).toMatchObject({
      selectedExecutorId: BILIBILI_BROWSER_EXECUTOR_ID, mcpExecutorEnabled: false, browserExecutorEnabled: true,
    })
    const browser = createFabricIntent(searchIntent('browser-verified', 'Hermes browser'))
    expect(browser.policyDecision).toMatchObject({ outcome: 'allow', executorId: BILIBILI_BROWSER_EXECUTOR_ID })
    await runWorkflow(browser.workflow.id)
    expect(getFabricWorkflow(browser.workflow.id)).toMatchObject({ state: 'succeeded' })
    expect(receipt(browser.workflow.id)).toMatchObject({ status: 'verified', executorType: 'browser' })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(twinCounts()).toMatchObject({ entertainment: 1, events: 2, outbox: 2 })

    challengeNext = true
    const takeover = createFabricIntent(searchIntent('browser-takeover', 'Hermes challenge'))
    await processActionFabricOnce({ workerId: 'internet-e2e-worker', now: new Date() })
    await processActionFabricOnce({ workerId: 'internet-e2e-worker', now: new Date(Date.now() + 1_000) })
    expect(getFabricWorkflow(takeover.workflow.id)).toMatchObject({
      state: 'waiting_user', lastErrorCode: 'FABRIC_EXECUTION_OUTCOME_UNKNOWN',
    })
    expect(receipt(takeover.workflow.id)).toMatchObject({
      status: 'waiting_user', errorCode: 'INTERNET_BROWSER_HUMAN_VERIFICATION_REQUIRED', result: null,
    })

    expect(() => createFabricIntent({ ...searchIntent('mutation-rejected', 'Hermes'),
      capabilityId: 'bilibili.video.like' } as any)).toThrow()

    setFabricEmergencyStop(3, 'admin-e2e', 'Phase 6 final emergency stop proof')
    await runtime.reconcile()
    expect(runtime.getStatus()).toMatchObject({ selectedExecutorId: null, authorizedTargetCount: 0,
      lastErrorCode: 'FABRIC_EMERGENCY_STOP_ACTIVE' })
    expect(createFabricIntent(searchIntent('emergency-denied', 'Hermes stopped')).policyDecision)
      .toMatchObject({ outcome: 'deny', reasonCodes: ['executor_unavailable'] })

    const exposed = JSON.stringify({
      status: runtime.getStatus(), mcp: receipt(mcp.workflow.id), browser: receipt(browser.workflow.id),
      takeover: receipt(takeover.workflow.id),
    })
    expect(exposed).not.toMatch(/managed-audit-key|access_token|cookie|authorization|serverId|toolName|session_id/i)
  }, 20_000)

  function createRuntime(): InternetProductionRuntime {
    return new InternetProductionRuntime({
      activeProfile: () => 'default', discover: async () => discovery, pollIntervalMs: 60_000,
      createAdapter: createMcpAdapter,
      createBrowserAdapter,
    })
  }
  function createMcpAdapter() {
    return createInternetMcpExecutorAdapter({
      id: BILIBILI_MCP_EXECUTOR_ID, environment: 'production', callTool,
      resolveBinding: () => healthyBinding(), discoverBinding: async () => discovery,
    })
  }
  function createBrowserAdapter() {
    return createInternetBrowserExecutorAdapter({
      id: BILIBILI_BROWSER_EXECUTOR_ID, environment: 'production', navigate, snapshot,
    })
  }

  function twinCounts() {
    return {
      entertainment: count("SELECT COUNT(*) AS count FROM twin_entities WHERE type = 'entertainment'"),
      events: count("SELECT COUNT(*) AS count FROM twin_events WHERE event_type = 'entertainment.video.discovered'"),
      outbox: count("SELECT COUNT(*) AS count FROM twin_outbox WHERE topic = 'twin.event.recorded'"),
    }
  }
  function count(sql: string): number {
    return Number((twin!.prepare(sql).get() as { count: number }).count)
  }
})

function registerAdapters(adapters: Awaited<ReturnType<InternetProductionRuntime['start']>>): void {
  for (const adapter of adapters) registerFabricExecutorAdapter(adapter)
}
function unregisterExecutors(): void {
  unregisterFabricExecutorAdapter(BILIBILI_MCP_EXECUTOR_ID)
  unregisterFabricExecutorAdapter(BILIBILI_BROWSER_EXECUTOR_ID)
}
async function runWorkflow(id: string): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await processActionFabricOnce({ workerId: 'internet-e2e-worker', now: new Date(Date.now() + index * 1_000) })
  }
  if (getFabricWorkflow(id)?.state !== 'succeeded') throw new Error('INTERNET_E2E_WORKFLOW_NOT_SUCCEEDED')
}
function receipt(workflowId: string) {
  return withInternetExecutionDb(db => new InternetExecutionStore(db).getReceipt(workflowId))
}
function searchIntent(idempotencyKey: string, query: string) {
  return {
    capabilityId: 'bilibili.video.search', requestedByRoleId: 'entertainment-assistant',
    requestedByUserId: 'user-internet-e2e', idempotencyKey, goal: 'Search public Bilibili videos',
    target: { kind: 'internet_provider', origin: 'www.bilibili.com', profile: 'default', provider: 'bilibili' },
    input: { schemaVersion: 1, provider: 'bilibili', profile: 'default', query, limit: 5, page: 1, order: 'relevance' },
    constraints: {}, rationale: 'Phase 6 synthetic closed-loop proof', environments: ['production' as const],
  }
}
function healthyBinding() {
  return { profile: 'default', provider: 'bilibili' as const, server: 'bilibili', tools: {
    'bilibili.video.search': 'search_videos', 'bilibili.video.inspect': 'get_video_info',
  } }
}
function healthyDiscovery(): BilibiliMcpDiscovery {
  return { profile: 'default', provider: 'bilibili', server: 'bilibili', status: 'healthy', errorCode: null,
    capabilities: {
      'bilibili.video.search': { capabilityId: 'bilibili.video.search', tool: 'search_videos', available: true, errorCode: null },
      'bilibili.video.inspect': { capabilityId: 'bilibili.video.inspect', tool: 'get_video_info', available: true, errorCode: null },
    } }
}
function unavailableDiscovery(): BilibiliMcpDiscovery {
  return { profile: 'default', provider: 'bilibili', server: 'bilibili', status: 'unavailable',
    errorCode: 'MCP_DISCOVERY_UNAVAILABLE', capabilities: {
      'bilibili.video.search': { capabilityId: 'bilibili.video.search', tool: 'search_videos', available: false, errorCode: 'MCP_TOOL_MISSING' },
      'bilibili.video.inspect': { capabilityId: 'bilibili.video.inspect', tool: 'get_video_info', available: false, errorCode: 'MCP_TOOL_MISSING' },
    } }
}
function navigateResponse(workflowId: string, url: string): AgentBridgeBrowserResponse {
  return { ok: true, action: 'navigate', workflow_id: workflowId, session_id: SESSION_ID,
    status: 'succeeded', error_code: null, url, title: 'Bilibili' }
}
function snapshotResponse(workflowId: string, url: string): AgentBridgeBrowserResponse {
  return { ok: true, action: 'snapshot', workflow_id: workflowId, session_id: SESSION_ID,
    status: 'succeeded', error_code: null, url,
    snapshot: `link "Hermes Studio"\n  /url: https://www.bilibili.com/video/${BVID}\nlink "Nous"\n  /url: https://space.bilibili.com/12345`,
    element_count: 4 }
}
function waitingResponse(workflowId: string): AgentBridgeBrowserResponse {
  return { ok: true, action: 'snapshot', workflow_id: workflowId, session_id: SESSION_ID,
    status: 'waiting_user', error_code: 'BROWSER_HUMAN_VERIFICATION_REQUIRED' }
}

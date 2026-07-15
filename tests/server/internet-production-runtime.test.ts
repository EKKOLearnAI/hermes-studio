import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureBuiltInFabricRegistry,
  evaluateFabricPolicy,
  listFabricCapabilities,
  listFabricExecutors,
  revalidateFabricDecisionInDb,
  resolveFabricExecutor,
  setFabricExecutorEnabled,
  updateFabricExecutorHealth,
  withFabricAuditedTransaction,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
  BILIBILI_BROWSER_EXECUTOR_ID,
  BILIBILI_MCP_EXECUTOR_ID,
  InternetProductionRuntime,
} from '../../packages/server/src/services/hermes/internet-execution/production-runtime'
import type {
  BilibiliMcpBinding,
  BilibiliMcpDiscovery,
} from '../../packages/server/src/services/hermes/internet-execution/mcp-discovery'
import { getAssistantRole } from '../../packages/server/src/services/hermes/personal-twin/assistant-roles'

describe('Bilibili MCP production lifecycle', () => {
  const originalHome = process.env.HERMES_HOME
  let home = ''
  let discovery: BilibiliMcpDiscovery
  let controlLevel = 0
  let runtime: InternetProductionRuntime | null = null

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'internet-production-runtime-'))
    process.env.HERMES_HOME = home
    discovery = healthyDiscovery(healthyBinding('default'))
    controlLevel = 0
    ensureBuiltInFabricRegistry()
  })

  afterEach(async () => {
    await runtime?.stop()
    runtime = null
    if (originalHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it('registers exact read-only capabilities and authorizes only the active profile/provider/origin atoms', async () => {
    runtime = createRuntime()
    const adapters = await runtime.start()
    expect(adapters.map(adapter => ({ id: adapter.id, type: adapter.type }))).toEqual([
      { id: BILIBILI_MCP_EXECUTOR_ID, type: 'mcp' },
      { id: BILIBILI_BROWSER_EXECUTOR_ID, type: 'browser' },
    ])

    expect(listFabricCapabilities().filter(item => item.id.startsWith('bilibili.')).map(item => ({
      id: item.id,
      risk: item.risk,
      sideEffect: item.sideEffect,
      verificationStrategy: item.verificationStrategy,
    }))).toEqual([
      { id: 'bilibili.video.inspect', risk: 'low', sideEffect: false, verificationStrategy: 'second_read_exact_bvid' },
      { id: 'bilibili.video.search', risk: 'low', sideEffect: false, verificationStrategy: 'second_read_bvid_overlap' },
    ])
    expect(runtime.getStatus()).toEqual({
      active: true,
      profile: 'default',
      configured: true,
      discoveryStatus: 'healthy',
      executorEnabled: true,
      mcpExecutorEnabled: true,
      browserExecutorEnabled: false,
      selectedExecutorId: BILIBILI_MCP_EXECUTOR_ID,
      authorizedTargetCount: 3,
      lastErrorCode: null,
    })
    expect(internetExecutor()).toMatchObject({
      id: BILIBILI_MCP_EXECUTOR_ID,
      type: 'mcp',
      environment: 'production',
      enabled: true,
      health: 'healthy',
      configuration: { externalWrite: false, interruptible: false, credentialScope: 'profile-runtime' },
    })
    expect(resolveFabricExecutor('bilibili.video.search', { environments: ['production'] })?.executor.id)
      .toBe(BILIBILI_MCP_EXECUTOR_ID)
    updateFabricExecutorHealth(BILIBILI_BROWSER_EXECUTOR_ID, 'healthy', { lifecycle: 'test-both-enabled' })
    setFabricExecutorEnabled(BILIBILI_BROWSER_EXECUTOR_ID, true)
    expect(resolveFabricExecutor('bilibili.video.search', { environments: ['production'] })?.executor.id)
      .toBe(BILIBILI_MCP_EXECUTOR_ID)
    setFabricExecutorEnabled(BILIBILI_BROWSER_EXECUTOR_ID, false)
    updateFabricExecutorHealth(BILIBILI_BROWSER_EXECUTOR_ID, 'degraded', { lifecycle: 'standby' })
    expect(browserExecutor()).toMatchObject({
      id: BILIBILI_BROWSER_EXECUTOR_ID,
      type: 'browser',
      environment: 'production',
      enabled: false,
      health: 'degraded',
      configuration: {
        externalWrite: false, interruptible: false, credentialScope: 'profile-runtime',
        primitives: ['navigate', 'snapshot'],
      },
    })
    expect(getAssistantRole('entertainment-assistant')).toMatchObject({
      capabilityScope: {
        allow: ['bilibili.video.inspect', 'bilibili.video.search'], deny: [], enforcement: 'action_fabric_v1',
      },
      decisionAuthority: {
        maxRisk: 'low', requireApprovalAbove: 'low',
        allowedTargets: [
          'internet:origin:www.bilibili.com',
          'internet:profile:default',
          'internet:provider:bilibili',
        ],
      },
    })
    expect(JSON.stringify(internetExecutor().healthDetails)).not.toMatch(/authorization|cookie|credential|secret|token/i)
  })

  it('selects browser fallback on discovery loss and revokes both executors on emergency stop', async () => {
    runtime = createRuntime()
    await runtime.start()

    discovery = {
      ...discovery,
      status: 'degraded',
      errorCode: 'MCP_TOOLS_INCOMPLETE',
      capabilities: {
        ...discovery.capabilities,
        'bilibili.video.inspect': {
          ...discovery.capabilities['bilibili.video.inspect'], available: false, errorCode: 'MCP_TOOL_MISSING',
        },
      },
    }
    await runtime.reconcile()
    expect(runtime.getStatus()).toMatchObject({
      configured: true, discoveryStatus: 'degraded', executorEnabled: true,
      mcpExecutorEnabled: false, browserExecutorEnabled: true,
      selectedExecutorId: BILIBILI_BROWSER_EXECUTOR_ID,
      authorizedTargetCount: 3, lastErrorCode: 'MCP_TOOLS_INCOMPLETE',
    })
    expect(internetExecutor()).toMatchObject({ enabled: false, health: 'degraded' })
    expect(browserExecutor()).toMatchObject({ enabled: true, health: 'healthy' })
    expect(getAssistantRole('entertainment-assistant')?.decisionAuthority.allowedTargets).toHaveLength(3)
    expect(resolveFabricExecutor('bilibili.video.search', { environments: ['production'] })?.executor.id)
      .toBe(BILIBILI_BROWSER_EXECUTOR_ID)

    discovery = healthyDiscovery(healthyBinding('default'))
    await runtime.reconcile()
    expect(internetExecutor()).toMatchObject({ enabled: true, health: 'healthy' })
    expect(browserExecutor()).toMatchObject({ enabled: false, health: 'degraded' })
    controlLevel = 3
    await runtime.reconcile()
    expect(runtime.getStatus()).toMatchObject({
      executorEnabled: false, mcpExecutorEnabled: false, browserExecutorEnabled: false,
      selectedExecutorId: null, authorizedTargetCount: 0, lastErrorCode: 'FABRIC_EMERGENCY_STOP_ACTIVE',
    })
    expect(internetExecutor()).toMatchObject({ enabled: false, health: 'degraded' })
    expect(browserExecutor()).toMatchObject({ enabled: false, health: 'degraded' })
    expect(getAssistantRole('entertainment-assistant')?.decisionAuthority.allowedTargets).toEqual([])
  })

  it('rotates exact profile authorization and stops disabled', async () => {
    let activeProfile = 'default'
    runtime = new InternetProductionRuntime({
      activeProfile: () => activeProfile,
      discover: async () => discovery,
      controlLevel: () => controlLevel,
      pollIntervalMs: 60_000,
    })
    await runtime.start()
    activeProfile = 'media'
    discovery = healthyDiscovery(healthyBinding('media'))
    await runtime.reconcile()
    expect(getAssistantRole('entertainment-assistant')?.decisionAuthority.allowedTargets).toContain('internet:profile:media')
    expect(getAssistantRole('entertainment-assistant')?.decisionAuthority.allowedTargets)
      .not.toContain('internet:profile:default')

    await runtime.stop()
    expect(runtime.getStatus()).toMatchObject({
      active: false, executorEnabled: false, mcpExecutorEnabled: false, browserExecutorEnabled: false,
      selectedExecutorId: null, discoveryStatus: 'stopped',
    })
    expect(internetExecutor()).toMatchObject({ enabled: false, health: 'unhealthy' })
    expect(browserExecutor()).toMatchObject({ enabled: false, health: 'unhealthy' })
    expect(getAssistantRole('entertainment-assistant')?.decisionAuthority.allowedTargets).toEqual([])
  })

  it('requires a fresh policy snapshot before switching an intent from MCP to browser', async () => {
    runtime = createRuntime()
    await runtime.start()
    const input = internetPolicyInput('fallback-policy')
    const mcpDecision = evaluateFabricPolicy(input)
    expect(mcpDecision).toMatchObject({ outcome: 'allow', executorId: BILIBILI_MCP_EXECUTOR_ID })

    discovery = {
      ...discovery,
      status: 'unavailable',
      errorCode: 'MCP_DISCOVERY_UNAVAILABLE',
      capabilities: {
        'bilibili.video.search': {
          ...discovery.capabilities['bilibili.video.search'], available: false, errorCode: 'MCP_TOOL_MISSING',
        },
        'bilibili.video.inspect': {
          ...discovery.capabilities['bilibili.video.inspect'], available: false, errorCode: 'MCP_TOOL_MISSING',
        },
      },
    }
    await runtime.reconcile()

    expect(() => withFabricAuditedTransaction(db => revalidateFabricDecisionInDb(db, mcpDecision.id)))
      .toThrow('FABRIC_POLICY_STALE_REGISTRY')
    const browserDecision = evaluateFabricPolicy(input)
    expect(browserDecision).toMatchObject({ outcome: 'allow', executorId: BILIBILI_BROWSER_EXECUTOR_ID })
    expect(browserDecision.id).not.toBe(mcpDecision.id)
    expect(browserDecision.materialInputDigest).toBe(mcpDecision.materialInputDigest)
    expect(browserDecision.policySnapshot.registryPolicyEvaluationToken)
      .not.toBe(mcpDecision.policySnapshot.registryPolicyEvaluationToken)
  }, 10_000)

  it('does not stale unrelated workflows when internet execution was never configured', async () => {
    discovery = {
      ...discovery,
      status: 'unavailable',
      errorCode: 'MCP_SERVER_MISSING',
      capabilities: {
        'bilibili.video.search': {
          ...discovery.capabilities['bilibili.video.search'], available: false, errorCode: 'MCP_TOOL_MISSING',
        },
        'bilibili.video.inspect': {
          ...discovery.capabilities['bilibili.video.inspect'], available: false, errorCode: 'MCP_TOOL_MISSING',
        },
      },
    }
    const before = resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })!
    runtime = createRuntime()
    await runtime.start()

    expect(runtime.getStatus()).toMatchObject({
      executorEnabled: false, mcpExecutorEnabled: false, browserExecutorEnabled: false,
      selectedExecutorId: null, discoveryStatus: 'unavailable',
    })
    expect(resolveFabricExecutor('simulator.echo', { environments: ['simulator'] })?.policyEvaluationToken)
      .toBe(before.policyEvaluationToken)
  })

  it('restores a previously selected browser fallback after an ungraceful runtime restart', async () => {
    discovery = {
      ...discovery,
      status: 'unavailable',
      errorCode: 'MCP_DISCOVERY_UNAVAILABLE',
      capabilities: {
        'bilibili.video.search': {
          ...discovery.capabilities['bilibili.video.search'], available: false, errorCode: 'MCP_TOOL_MISSING',
        },
        'bilibili.video.inspect': {
          ...discovery.capabilities['bilibili.video.inspect'], available: false, errorCode: 'MCP_TOOL_MISSING',
        },
      },
    }
    updateFabricExecutorHealth(BILIBILI_BROWSER_EXECUTOR_ID, 'healthy', { lifecycle: 'fallback' })
    setFabricExecutorEnabled(BILIBILI_BROWSER_EXECUTOR_ID, true)

    runtime = createRuntime()
    await runtime.start()
    expect(runtime.getStatus()).toMatchObject({
      selectedExecutorId: BILIBILI_BROWSER_EXECUTOR_ID,
      browserExecutorEnabled: true,
      mcpExecutorEnabled: false,
    })
    expect(resolveFabricExecutor('bilibili.video.inspect', { environments: ['production'] })?.executor.id)
      .toBe(BILIBILI_BROWSER_EXECUTOR_ID)
  })

  function createRuntime(): InternetProductionRuntime {
    return new InternetProductionRuntime({
      activeProfile: () => 'default',
      discover: async () => discovery,
      controlLevel: () => controlLevel,
      pollIntervalMs: 60_000,
    })
  }
})

function internetExecutor() {
  return listFabricExecutors().find(executor => executor.id === BILIBILI_MCP_EXECUTOR_ID)!
}

function browserExecutor() {
  return listFabricExecutors().find(executor => executor.id === BILIBILI_BROWSER_EXECUTOR_ID)!
}

function healthyBinding(profile: string): BilibiliMcpBinding {
  return {
    profile, provider: 'bilibili', server: 'bilibili',
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

function internetPolicyInput(idempotencyKey: string) {
  return {
    capabilityId: 'bilibili.video.search',
    requestedByRoleId: 'entertainment-assistant',
    requestedByUserId: 'user-internet-runtime',
    idempotencyKey,
    goal: 'Search public Bilibili videos',
    target: { kind: 'internet_provider', origin: 'www.bilibili.com', profile: 'default', provider: 'bilibili' },
    input: {
      schemaVersion: 1, provider: 'bilibili', profile: 'default', query: 'Hermes', limit: 5, page: 1,
      order: 'relevance',
    },
    constraints: {},
    rationale: 'User requested a public read',
    environments: ['production' as const],
  }
}

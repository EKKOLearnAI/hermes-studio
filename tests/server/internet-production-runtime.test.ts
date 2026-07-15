import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureBuiltInFabricRegistry,
  listFabricCapabilities,
  listFabricExecutors,
  resolveFabricExecutor,
} from '../../packages/server/src/services/hermes/action-fabric'
import {
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
    await runtime.start()

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

  it('revokes role targets and executor availability on discovery loss or emergency stop', async () => {
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
      configured: true, discoveryStatus: 'degraded', executorEnabled: false,
      authorizedTargetCount: 0, lastErrorCode: 'MCP_TOOLS_INCOMPLETE',
    })
    expect(internetExecutor()).toMatchObject({ enabled: false, health: 'degraded' })
    expect(getAssistantRole('entertainment-assistant')?.decisionAuthority.allowedTargets).toEqual([])
    expect(resolveFabricExecutor('bilibili.video.search', { environments: ['production'] })).toBeNull()

    discovery = healthyDiscovery(healthyBinding('default'))
    await runtime.reconcile()
    expect(internetExecutor()).toMatchObject({ enabled: true, health: 'healthy' })
    controlLevel = 3
    await runtime.reconcile()
    expect(runtime.getStatus()).toMatchObject({
      executorEnabled: false, authorizedTargetCount: 0, lastErrorCode: 'FABRIC_EMERGENCY_STOP_ACTIVE',
    })
    expect(internetExecutor()).toMatchObject({ enabled: false, health: 'degraded' })
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
    expect(runtime.getStatus()).toMatchObject({ active: false, executorEnabled: false, discoveryStatus: 'stopped' })
    expect(internetExecutor()).toMatchObject({ enabled: false, health: 'unhealthy' })
    expect(getAssistantRole('entertainment-assistant')?.decisionAuthority.allowedTargets).toEqual([])
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
